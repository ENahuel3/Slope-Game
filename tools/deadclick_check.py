"""Title-menu dead-button check: the hidden download and Feedback buttons must not take clicks. Prints their measured
rects (SlopeMod.deadRects), clicks the centre of each and fails if a canvas mouse listener saw it or a new tab opened.
usage: deadclick_check.py <repo dir> [--shot out.png] [--port N]"""
import argparse, os, subprocess, sys, time
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('repo'); ap.add_argument('--shot'); ap.add_argument('--port', type=int, default=8779)
A = ap.parse_args()
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(A.port), '--bind', '127.0.0.1', '--directory', os.path.abspath(A.repo)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
ok = False
try:
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'])
        ctx = b.new_context(viewport={'width': 960, 'height': 600}); pg = ctx.new_page()
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto('http://127.0.0.1:%d/' % A.port, timeout=60000)
        pg.wait_for_function("window.SlopeMod && SlopeMod.log().some(function(l){return l.indexOf('heap (')>=0})", timeout=240000)
        time.sleep(4)
        rects = pg.evaluate('SlopeMod.deadRects()'); print('rects:', rects, flush=True)
        if A.shot: pg.screenshot(path=A.shot)
        pg.evaluate("window.__seen=0; document.querySelector('#gameContainer canvas').addEventListener('mousedown', function(){ window.__seen++; })")
        box = pg.evaluate("(function(){var r=document.querySelector('#gameContainer canvas').getBoundingClientRect();return [r.left,r.top,r.width,r.height];})()")
        for name in ('download', 'feedback'):
            d = rects.get(name)
            if not d: print('FAIL no rect for', name); continue
            x = box[0] + (d['l'] + d['r']) / 2 * box[2]; y = box[1] + (d['t'] + d['b']) / 2 * box[3]
            if not (0 <= y < 600): print('skip', name, 'off-screen at', round(x), round(y)); continue
            pg.mouse.click(x, y); time.sleep(1.5)
            print(name, 'clicked at', round(x), round(y), 'canvas saw', pg.evaluate('window.__seen'), 'pages', len(ctx.pages), flush=True)
        ok = bool(rects.get('feedback')) and pg.evaluate('window.__seen') == 0 and len(ctx.pages) == 1 and not errs
        if errs: print('errors:', errs[:3])
        b.close()
finally:
    srv.terminate()
print('PASS' if ok else 'FAIL')
sys.exit(0 if ok else 1)
