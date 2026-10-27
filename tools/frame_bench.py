"""Measure frame pacing during an autopiloted run; optional Chrome CPU profile.

Usage: python tools/frame_bench.py . --seconds 30 [--gpu] [--baseline HEAD]
Run one browser at a time, e.g. nice -n 19 taskset -c 0-5 python tools/frame_bench.py .
Software rendering is the default: use --gpu on the target device for FPS numbers.
The 1% low is 1000 / mean(slowest ceil(N*.01) frame intervals).
"""
import argparse, collections, json, math, pathlib, subprocess, sys, time
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(description=__doc__)
ap.add_argument('repo', nargs='?', default='.')
ap.add_argument('--seconds', type=float, default=20)
ap.add_argument('--port', type=int, default=8779)
ap.add_argument('--gpu', action='store_true')
ap.add_argument('--browser', choices=['chromium','firefox'], default='chromium')
ap.add_argument('--view-distance', type=int, default=1)
ap.add_argument('--width', type=int, default=800)
ap.add_argument('--height', type=int, default=500)
ap.add_argument('--style', default='rainbow')
ap.add_argument('--light', default='normal')
ap.add_argument('--track', default='off')
ap.add_argument('--restart-every', type=float, default=0)
ap.add_argument('--pace-spawns', action='store_true', help='experimental pacing of straight-track spawn steps')
ap.add_argument('--courses', type=int, default=2, help='two courses enable automatic restarts during sampling')
ap.add_argument('--webgl1', action='store_true')
ap.add_argument('--baseline', help='serve game scripts from this git revision')
ap.add_argument('--screenshot')
ap.add_argument('--profile', help='write Chrome CPU profile to this path')
A = ap.parse_args(); root = pathlib.Path(A.repo).resolve()
if A.seconds <= 0 or A.courses < 1: ap.error('seconds and courses must be positive')
server = subprocess.Popen([sys.executable, '-m', 'http.server', str(A.port), '--bind', '127.0.0.1', '--directory', str(root)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    time.sleep(.5)
    if server.poll() is not None: raise RuntimeError('server failed to start')
    with sync_playwright() as p:
        args = ['--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required']
        args += ['--use-gl=angle', '--use-angle=gl'] if A.gpu else ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
        if A.webgl1: args += ['--disable-webgl2']
        if A.browser == 'firefox':
            if A.profile: ap.error('--profile requires Chromium')
            browser = p.firefox.launch(headless=True, firefox_user_prefs={'webgl.force-enabled': True, 'webgl.enable-webgl2': not A.webgl1})
        else:
            browser = p.chromium.launch(headless=True, args=args)
        page = browser.new_page(viewport={'width': A.width, 'height': A.height})
        errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
        if A.baseline or A.pace_spawns:
            for name in ['coins', 'ramps', 'mod', 'shaders']:
                source = subprocess.check_output(['git', 'show', f'{A.baseline}:TemplateData/{name}.js'], cwd=root).decode() if A.baseline else (root / f'TemplateData/{name}.js').read_text()
                if A.pace_spawns and name == 'mod':
                    source = source.replace('gravityMode !== \"off\" && gameRunning && !build', 'gameRunning && !build')
                page.route(f'**/TemplateData/{name}.js*', lambda route, request, body=source: route.fulfill(body=body, content_type='text/javascript'))
        if A.baseline:
            page.route('**/TemplateData/performance.js*', lambda route: route.fulfill(body='window.SlopePerformance={attach(){}};', content_type='text/javascript'))
        if A.baseline:
            page.route('**/TemplateData/gl-state.js*', lambda route: route.fulfill(body='', content_type='text/javascript'))
        # Count hot-path typed-array allocations independently of Chrome's sampling profiler.
        page.add_init_script('''const nativeRAF=window.requestAnimationFrame;
          window.requestAnimationFrame=fn=>nativeRAF.call(window,t=>{window.benchRAFTime=t;return fn(t);});
          window.stateQueries=0; window.stateQueryParams={};
          for(const GL of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
            if(!GL) continue; const get=GL.prototype.getParameter;
            GL.prototype.getParameter=function() { window.stateQueries++; window.stateQueryParams[arguments[0]]=(window.stateQueryParams[arguments[0]]||0)+1; return get.apply(this,arguments); };
          }
          const NativeF32 = Float32Array;
          window.matrixAllocs = 0;
          window.Float32Array = new Proxy(NativeF32, {construct(target,args) {
            if(args.length===1 && args[0]===16) window.matrixAllocs++;
            return Reflect.construct(target,args);
          }});''')
        page.add_init_script(f"localStorage.setItem('slope-mod.viewDist', '{A.view_distance}')")
        page.goto(f'http://127.0.0.1:{A.port}/')
        page.wait_for_function("window.SlopeMod && SlopeMod.log().some(l => /heap \\(/.test(l))", timeout=120000)
        page.evaluate("a => { SlopeMod.setStack(a.courses); SlopeMod.setGravity(a.track); SlopeMod.setAutopilot(true); SlopeShaders.setStyle(a.style); SlopeShaders.setLight(a.light); }", dict(courses=A.courses, track=A.track, style=A.style, light=A.light))
        page.keyboard.press('Enter'); page.wait_for_timeout(3000)
        cdp = page.context.new_cdp_session(page) if A.profile else None
        if A.profile:
            cdp.send('Profiler.enable'); cdp.send('Profiler.start')
        page.evaluate('''() => {
          window.frameSamples=[]; window.renderSamples=[]; window.renderSlowFrames=[]; window.slowFrames=[]; window.longTasks=[]; window.matrixAllocs=0; window.stateQueries=0; window.stateQueryParams={}; window.sampling=true;
          window.sampleStart=performance.now();
          window.taskObserver=new PerformanceObserver(list=>{ for(const e of list.getEntries()) longTasks.push({start:e.startTime-sampleStart,ms:e.duration}); });
          if(PerformanceObserver.supportedEntryTypes.includes('longtask')) taskObserver.observe({type:'longtask'});
          let lastRender;
          SlopeShaders.onScene(function(info) {
            if(!sampling) return;
            const at=typeof info.timestamp==='number' ? info.timestamp : window.benchRAFTime;
            if(lastRender!==undefined && at>lastRender) { const dt=at-lastRender; renderSamples.push(dt); if(dt>25 && renderSlowFrames.length<500) renderSlowFrames.push({at:at-sampleStart,ms:dt,draws:SlopeMod.drawCounts().length,game:SlopeMod.stats(),track:SlopeMod.track()}); }
            lastRender=at;
          });
          let last;
          function sample(t) { if(!sampling) return; if(last!==undefined) { const dt=t-last; frameSamples.push(dt); if(dt>25 && slowFrames.length<500) slowFrames.push({at:performance.now()-sampleStart, ms:dt, game:SlopeMod.stats(), draws:SlopeMod.drawCounts().length}); } last=t; requestAnimationFrame(sample); }
          requestAnimationFrame(sample);
        }''')
        deadline=time.monotonic()+A.seconds; next_restart=time.monotonic()+A.restart_every
        while time.monotonic()<deadline:
            page.wait_for_timeout(min(1000, max(1,(deadline-time.monotonic())*1000)))
            if A.restart_every and time.monotonic()>=next_restart:
                page.keyboard.press('r'); next_restart=time.monotonic()+A.restart_every
        data = page.evaluate('''() => { sampling=false; taskObserver.disconnect();
          const canvas=document.querySelector('canvas');
          const gl=canvas.getContext('webgl2') || canvas.getContext('webgl');
          const bounds=canvas.getBoundingClientRect();
          const ext=gl && gl.getExtension('WEBGL_debug_renderer_info');
          const gpuRenderer=ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unavailable';
          return {stateAudit:window.SlopeGLState ? SlopeGLState.audit(gl) : [], glCache:window.SlopeGLState ? SlopeGLState.stats() : null, displaySize:[bounds.width,bounds.height], renderSize:[canvas.width,canvas.height], slowFrames, longTasks, renderSlowFrames, renderSamples, intervals:frameSamples, matrixAllocs, stateQueries, stateQueryParams, gpuRenderer,
          quality:window.SlopePerformance.stats ? SlopePerformance.stats() : null, game:SlopeMod.stats(), coins:SlopeCoins.stats(), ramps:SlopeRamps.stats()}; }''')
        if A.profile:
            profile = cdp.send('Profiler.stop')['profile']
            pathlib.Path(A.profile).write_text(json.dumps(profile))
            nodes = {n['id']: n['callFrame'] for n in profile['nodes']}
            counts = collections.Counter(profile.get('samples', []))
            data['cpuTop'] = [dict(function=nodes[n]['functionName'], url=nodes[n]['url'], samples=count) for n,count in counts.most_common(15)]
        raf_values = sorted(data.pop('intervals'))
        values = sorted(data.pop('renderSamples')); n = len(values)
        data['rafFrames'] = len(raf_values)
        if not n: raise RuntimeError('no frame samples')
        data.update(frames=n, renderer='GPU' if A.gpu else 'SwiftShader', averageFps=1000*n/sum(values), low1Fps=1000/(sum(values[-max(1,math.ceil(n*.01)):])/max(1,math.ceil(n*.01))), p99Ms=values[min(n-1,math.ceil(n*.99)-1)], worstMs=values[-1], over50ms=sum(v>50 for v in values), pageErrors=errors)
        if A.screenshot: page.screenshot(path=A.screenshot)
        if min(data['renderSize'][i]/max(1,data['displaySize'][i]) for i in range(2)) < .49: raise RuntimeError('render resolution collapsed')
        print(json.dumps(data, indent=2)); browser.close()
finally:
    server.terminate(); server.wait()
