"""Does the page still work? Serve the repository, load it in headless Chromium, wait for the mod and the game to come up,
start a run and watch it for a few seconds. Exit 0 when the page loads, the heap scan finishes, frames advance, a run
starts and no page error is thrown; exit 1 with the reason otherwise. Dev mode runs this before publishing an edit;
anyone can run it after a change. usage: smoke_check.py <repo dir> [--port N] [--seconds 8] [--timeout 180]"""
import argparse, json, os, subprocess, sys, time
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('repo'); ap.add_argument('--port', type=int, default=8777); ap.add_argument('--seconds', type=float, default=8); ap.add_argument('--timeout', type=float, default=180)
A = ap.parse_args(); REPO = os.path.abspath(A.repo)
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(A.port), '--bind', '127.0.0.1', '--directory', REPO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
if srv.poll() is not None: print('FAIL could not serve the repository on port %d' % A.port); sys.exit(1)
def fail(msg): print('FAIL ' + msg, flush=True); srv.terminate(); sys.exit(1)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'])
        pg = b.new_page(viewport={'width': 640, 'height': 400}); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)[:300]))
        pg.on('console', lambda m: errs.append('console.error: ' + m.text[:300]) if m.type == 'error' and not any(k in m.text for k in ('IDNET', 'Tracker', 'favicon', 'id.net', 'y8.com')) else None)
        t0 = time.time()
        try: pg.goto('http://127.0.0.1:%d/' % A.port, timeout=60000)
        except Exception as e: fail('page did not load: ' + str(e).split('\n')[0])
        for name, cond, limit in (('mod and game objects', 'window.SlopeMod && window.gameInstance', A.timeout * 1000),
                                  ('heap scan', "typeof SlopeMod.log !== 'function' || SlopeMod.log().some(function(l){return l.indexOf('heap (')>=0})", A.timeout * 1000)):
            try: pg.wait_for_function(cond, timeout=limit)
            except Exception: fail('%s did not come up within %.0f s%s' % (name, limit / 1000, ('; errors: ' + '; '.join(errs[:3])) if errs else ''))
        f0 = pg.evaluate('SlopeMod.frame()')
        try: pg.wait_for_function('SlopeMod.frame() > %d + 30' % f0, timeout=60000)
        except Exception: fail('the game is not rendering frames')
        if errs: fail('page errors while loading: ' + '; '.join(errs[:3]))
        pg.evaluate("""(function(){ function ev(t){ var e = new KeyboardEvent(t, {key:'Enter', code:'Enter', bubbles:true, cancelable:true});
            try{Object.defineProperty(e,'keyCode',{get:function(){return 13}})}catch(x){} document.dispatchEvent(e); var c=document.querySelector('canvas'); if(c) c.dispatchEvent(e); }
            ev('keydown'); setTimeout(function(){ ev('keyup'); }, 120); })()""")
        time.sleep(2.0)
        running = pg.evaluate('!!SlopeMod.stats().running')
        if not running: fail('a run did not start after Enter')
        f1 = pg.evaluate('SlopeMod.frame()'); time.sleep(A.seconds); f2 = pg.evaluate('SlopeMod.frame()')
        if f2 - f1 < 10: fail('the game froze during the run (%d frames in %.0f s)' % (f2 - f1, A.seconds))
        if errs: fail('page errors during the run: ' + '; '.join(errs[:3]))
        st = pg.evaluate('(function(){var s=SlopeMod.stats(); return {deaths:s.deaths, frames:s.frame, fps:s.fps||null}})()')
        print('OK loaded in %.0f s, ran %.0f s: %d frames, deaths %s, fps %s' % (time.time() - t0, A.seconds, f2 - f1, st['deaths'], st['fps']), flush=True)
        b.close()
finally:
    srv.terminate()
