"""Load the Slope page from a local static server in headless Chromium, measure the download and the time to
the menu (the mod's heap discovery note), then start a run and prove the ball moves.
usage: bench_load.py <repo dir> [--path /] [--mbps 30] [--runs 1] [--profile DIR] [--port N] [--url https://site]
(run with the playwright package installed: python3 -m venv v && v/bin/pip install playwright && v/bin/playwright install chromium)"""
import sys, subprocess, time, json, os, argparse
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('repo'); ap.add_argument('--path', default='/'); ap.add_argument('--mbps', type=float, default=30)
ap.add_argument('--runs', type=int, default=1); ap.add_argument('--profile', default=None); ap.add_argument('--port', type=int, default=8765); ap.add_argument('--url', default=None, help='benchmark a live site instead of serving <repo> locally'); A = ap.parse_args()
srv = None
if not A.url:
    srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(A.port), '--bind', '127.0.0.1', '--directory', A.repo], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.6)
    if srv.poll() is not None: sys.exit('could not start the local server on port %d (in use?)' % A.port)
base = A.url.rstrip('/') if A.url else 'http://127.0.0.1:%d' % A.port
try:
    with sync_playwright() as p:
        args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required']
        for run in range(A.runs):
            if A.profile: ctx = p.chromium.launch_persistent_context(A.profile, headless=True, args=args, viewport={'width': 960, 'height': 600}); page = ctx.pages[0] if ctx.pages else ctx.new_page(); browser = None
            else: browser = p.chromium.launch(headless=True, args=args); ctx = browser.new_context(viewport={'width': 960, 'height': 600}); page = ctx.new_page()
            logs = []; errors = []
            page.on('console', lambda m: logs.append(m.type + ': ' + m.text))
            page.on('pageerror', lambda e: errors.append(str(e)))
            cdp = ctx.new_cdp_session(page)
            cdp.send('Network.enable')
            if A.mbps > 0: cdp.send('Network.emulateNetworkConditions', {'offline': False, 'latency': 20, 'downloadThroughput': A.mbps * 1e6 / 8, 'uploadThroughput': A.mbps * 1e6 / 8})
            t0 = time.time()
            page.goto(base + A.path)
            ready = None
            for i in range(1500):
                st = page.evaluate("() => window.SlopeMod ? SlopeMod.log().filter(l => /heap \\(/.test(l)) : []")
                if st: ready = time.time() - t0; break
                if errors and any('UnityLoader' in e or 'Error' in e for e in errors) and i > 200: break
                time.sleep(0.1)
            res = page.evaluate("""() => performance.getEntriesByType('resource').filter(r => /Build\\/|unityloader|mod\\.js|music/.test(r.name)).map(r => ({name: r.name.split('/').slice(-1)[0], bytes: r.encodedBodySize, ms: Math.round(r.duration)}))""")
            stats = page.evaluate("() => SlopeMod.stats()")
            heapnote = page.evaluate("() => SlopeMod.log().filter(l => /heap \\(/.test(l))[0]")
            # start a run: Enter at the menu, then watch s (distance along the course) grow
            page.evaluate("() => SlopeMod.setGravity('curves')"); page.keyboard.press('Enter'); time.sleep(0.8)
            s0 = page.evaluate("() => SlopeMod.track().s"); time.sleep(3.0)
            s1 = page.evaluate("() => SlopeMod.track().s"); fr = page.evaluate("() => SlopeMod.frame()"); time.sleep(1.0); fr2 = page.evaluate("() => SlopeMod.frame()")
            tr = page.evaluate("() => { var t = SlopeMod.track(); return {heap: t.heap, s: t.s, pos: t.pos}; }")
            total = sum(r['bytes'] for r in res)
            out = ({'run': run, 'path': A.path, 'mbps': A.mbps, 'ready_s': ready and round(ready, 2), 'total_bytes': total, 'resources': res, 'heap': heapnote,
                              'stats': stats, 's0': s0, 's1': s1, 'fps': fr2 - fr, 'track': tr, 'errors': errors[:5],
                              'cache_logs': [l for l in logs if 'UnityCache' in l][:6], 'other_logs': [l for l in logs if 'UnityCache' not in l and l.startswith('error')][:8]})
            json.dump(out, open(os.environ.get('BENCH_OUT', '/dev/null'), 'a')); open(os.environ.get('BENCH_OUT', '/dev/null'), 'a').write('\n')
            print('SUMMARY run=%d path=%s ready=%ss bytes=%d data=%s s0=%s s1=%s fps=%d shaders=%s errors=%d cache=%s' % (run, A.path, out['ready_s'], total, [r for r in res if 'data' in r['name']], s0, s1, out['fps'], stats.get('shaders') and '%s/%d passes/%d failed' % (stats['shaders']['style'], stats['shaders']['passes'], stats['shaders']['failed']), len(errors), out['cache_logs']))
            (ctx.close() if browser is None else browser.close())
finally:
    if srv: srv.terminate()
