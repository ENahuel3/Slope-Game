"""Title-menu draw probe: lists the title menu's drawElements (count@offset) and screenshots the menu with each small draw
skipped, to find which draw renders a given label. usage: title_probe.py <repo dir> <out dir> [--port N]"""
import argparse, os, subprocess, sys, time
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('repo'); ap.add_argument('out'); ap.add_argument('--port', type=int, default=8778)
A = ap.parse_args(); os.makedirs(A.out, exist_ok=True)
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(A.port), '--bind', '127.0.0.1', '--directory', os.path.abspath(A.repo)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'])
        pg = b.new_page(viewport={'width': 640, 'height': 400})
        pg.goto('http://127.0.0.1:%d/' % A.port, timeout=60000)
        pg.wait_for_function("window.SlopeMod && SlopeMod.log().some(function(l){return l.indexOf('heap (')>=0})", timeout=240000)
        time.sleep(3)
        pg.evaluate("""(function(){ window.__skip=null; window.__list=[]; window.__cur=[]; window.__n=0;
          [window.WebGLRenderingContext, window.WebGL2RenderingContext].forEach(function(C){ if(!C) return; var P=C.prototype, o=P.drawElements;
            P.drawElements=function(m,c,t,off){ var k=c+'@'+off; window.__cur.push(k); var n=window.__n++; if(window.__skip===k||window.__skip===n) return; return o.apply(this,arguments); }; });
          (function f(){ if(window.__cur.length) { window.__list=window.__cur; } window.__cur=[]; window.__n=0; requestAnimationFrame(f); })(); })()""")
        time.sleep(2)
        lst = pg.evaluate('window.__list'); print('draws:', lst, flush=True)
        pg.screenshot(path=os.path.join(A.out, 'base.png'))
        for i, k in enumerate(lst):
            if not k.startswith('30@'): continue
            pg.evaluate('window.__skip=%d' % i); time.sleep(1.0)
            pg.screenshot(path=os.path.join(A.out, 'ord_%d.png' % i))
        b.close()
finally:
    srv.terminate()
