"""Playability check of every frozen version (and the root): load each one headless, start a run with the
autopilot where the version has one, and watch for the ways a build has actually broken in this project:
not loading, freezing (no frames), falling off the course seconds after every start (the gap bugs), or
sticking after a death (no restart). Writes a JSON report; tools/mark_versions.py turns it into the
'status' / 'issues' fields of versions/index.json.

usage: version_check.py <repo dir> [--tags a,b,c] [--seconds 60] [--port 8773] [--out report.json] [--no-both]
"""
import argparse, json, os, subprocess, sys, time
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('repo'); ap.add_argument('--tags', default=None); ap.add_argument('--seconds', type=float, default=60)
ap.add_argument('--port', type=int, default=8773); ap.add_argument('--out', default=None); ap.add_argument('--no-both', action='store_true'); A = ap.parse_args()
REPO = os.path.abspath(A.repo); man = json.load(open(os.path.join(REPO, 'versions', 'index.json')))
tags = A.tags.split(',') if A.tags else ['latest'] + [v['tag'] for v in man['versions']]
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(A.port), '--bind', '127.0.0.1', '--directory', REPO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
if srv.poll() is not None: sys.exit('could not start the local server on port %d' % A.port)
report = {}
def log(*a): print(*a, flush=True)

def watch(pg, secs):
    """Sample the game for secs: runs (seconds between a start and the next death), freezes, stuck deaths."""
    t0 = time.time(); last_frame = pg.evaluate('SlopeMod.frame()'); last_change = t0; max_gap = 0.0
    st0 = pg.evaluate('(function(){var s=SlopeMod.stats(); return {d:s.deaths||0, r:s.restarts||0}})()')
    deaths, restarts = st0['d'], st0['r']; run_start = t0; runs = []; stuck = 0; death_at = None; dist = []; r_at = None
    while time.time() - t0 < secs:
        time.sleep(0.25)
        now = time.time()
        try:
            s = pg.evaluate('(function(){var s=SlopeMod.stats(), f=SlopeMod.frame(), d=null; try{var t=SlopeMod.track(); d=t&&typeof t.s==="number"?t.s:null}catch(e){} return {d:s.deaths||0, r:s.restarts||0, f:f, s:d, running:!!s.running}})()')
        except Exception as e:
            return {'error': 'page died: ' + str(e)[:120], 'runs': runs, 'maxGap': round(max_gap, 1), 'deaths': deaths - st0['d'], 'restarts': restarts - st0['r'], 'stuck': stuck}
        if s['f'] != last_frame: last_frame = s['f']; last_change = now
        gap = now - last_change; max_gap = max(max_gap, gap)
        if s['s'] is not None: dist.append(s['s'])
        if s['d'] > deaths:
            deaths = s['d']; runs.append(round(now - run_start, 1)); death_at = now; r_at = None
        if death_at and r_at is None and now - death_at > 3.5: press_r(pg); r_at = now     # the stock game over: R restarts
        if (s['r'] > restarts) or (r_at and s['running'] and now - r_at > 0.5):
            restarts = max(restarts, s['r']); run_start = now; death_at = None; r_at = None
        if r_at and now - r_at > 10: stuck += 1; death_at = None; r_at = None
    return {'runs': runs, 'maxGap': round(max_gap, 1), 'deaths': deaths - st0['d'], 'restarts': restarts - st0['r'], 'stuck': stuck,
            'dist': round(max(dist) - min(dist), 1) if dist else None, 'frames': last_frame}

def press(pg, key, code):
    pg.evaluate("""(function(k, c, kc){ function ev(t){ var e = new KeyboardEvent(t, {key:k, code:c, bubbles:true, cancelable:true});
        try{Object.defineProperty(e,'keyCode',{get:function(){return kc}});Object.defineProperty(e,'which',{get:function(){return kc}})}catch(x){}
        document.dispatchEvent(e); var cv=document.querySelector('canvas'); if(cv) cv.dispatchEvent(e); }
        ev('keydown'); setTimeout(function(){ ev('keyup'); }, 120); })(%s, %s, %d)""" % (json.dumps(key), json.dumps(code), 13 if key == 'Enter' else 82))
def press_enter(pg): press(pg, 'Enter', 'Enter')
def press_r(pg): press(pg, 'r', 'KeyR')

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
    for tag in tags:
        url = 'http://127.0.0.1:%d/' % A.port + ('' if tag == 'latest' else 'versions/%s/' % tag)
        rec = {'tag': tag, 'url': url, 'passes': {}, 'errors': []}
        ctx = browser.new_context(viewport={'width': 640, 'height': 400}); pg = ctx.new_page()
        pg.on('pageerror', lambda e, rec=rec: rec['errors'].append(str(e)[:160]))
        pg.on('console', lambda m, rec=rec: rec['errors'].append('console.error: ' + m.text[:160]) if m.type == 'error' and 'favicon' not in m.text else None)
        t0 = time.time()
        try:
            pg.goto(url, timeout=60000)
            pg.wait_for_function('window.SlopeMod && window.gameInstance', timeout=120000)
            f0 = pg.evaluate('SlopeMod.frame()')
            pg.wait_for_function('SlopeMod.frame() > %d + 30' % f0, timeout=120000)
            try: pg.wait_for_function("typeof SlopeMod.log !== 'function' || SlopeMod.log().some(function(l){return l.indexOf('heap (')>=0})", timeout=60000)
            except Exception: rec['errors'].append('no heap-ready log line within 60 s')
            time.sleep(1.0)
            rec['loadSeconds'] = round(time.time() - t0, 1)
            has_auto = pg.evaluate('typeof SlopeMod.setAutopilot === "function"'); has_grav = pg.evaluate('typeof SlopeMod.setGravity === "function"')
            rec['autopilot'] = has_auto
            passes = []
            if has_grav and not A.no_both: passes.append(('shaped', 'both'))
            passes.append(('vanilla', 'off' if has_grav else None))
            for name, grav in passes:
                if grav:
                    mode = pg.evaluate("""(function(want){ var tries = want === 'off' ? ['off'] : ['both', 'twists', 'curves', 'ramps', 'on'];
                        for (var i = 0; i < tries.length; i++) { try { SlopeMod.setGravity(tries[i]); } catch (e) {} var m = null; try { m = SlopeMod.track().mode; } catch (e) {}
                        if (m === tries[i]) return m; } return null; })(%s)""" % json.dumps(grav))
                    rec.setdefault('modes', {})[name] = mode
                    if name == 'shaped' and not mode: continue
                    if name == 'vanilla': time.sleep(1.0); press_r(pg)   # new course in the new mode
                if has_auto: pg.evaluate('SlopeMod.setAutopilot(true)')
                time.sleep(1.0); press_enter(pg); time.sleep(1.5)
                r = watch(pg, A.seconds); rec['passes'][name] = r
                log('%-22s %-8s load=%ss auto=%s runs=%s deaths=%s restarts=%s stuck=%s maxGap=%ss dist=%s %s' % (tag, name, rec.get('loadSeconds'), has_auto, r.get('runs'), r.get('deaths'), r.get('restarts'), r.get('stuck'), r.get('maxGap'), r.get('dist'), r.get('error', '')))
                if r.get('error'): break
        except Exception as e:
            rec['loadError'] = str(e).split('\n')[0][:200]; log('%-22s LOAD FAILED %s' % (tag, rec['loadError']))
        rec['errors'] = rec['errors'][:8]
        report[tag] = rec
        ctx.close()
        if A.out: json.dump(report, open(A.out, 'w'), indent=1)
srv.terminate()
if A.out: json.dump(report, open(A.out, 'w'), indent=1); log('report:', A.out)
