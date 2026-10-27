"""Game-over screen probe: lists the UI draw calls (index count @ byte offset) on the screen after a death and saves a
screenshot of it with each one skipped in turn, to find which draws make up which piece of the screen.
usage: gameover_probe.py <repo dir> <out dir> [--port N]"""
import argparse, os, subprocess, sys, time
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('repo'); ap.add_argument('out'); ap.add_argument('--port', type=int, default=8778)
A = ap.parse_args(); REPO = os.path.abspath(A.repo); os.makedirs(A.out, exist_ok=True)
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(A.port), '--bind', '127.0.0.1', '--directory', REPO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
INIT = """(function(){ window.__probe = {cur: [], last: [], skip: null};
  function wrap(P){ var o = P.drawElements; P.drawElements = function(m, c, t, off){ var k = c + '@' + off; __probe.cur.push(k);
      if (__probe.skip === k || __probe.skip === __probe.cur.length - 1) return; return o.apply(this, arguments); }; }
  if (window.WebGLRenderingContext) wrap(WebGLRenderingContext.prototype);
  if (window.WebGL2RenderingContext) wrap(WebGL2RenderingContext.prototype);
  function f(){ __probe.last = __probe.cur; __probe.cur = []; requestAnimationFrame(f); } requestAnimationFrame(f); })();"""
try:
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'])
        pg = b.new_page(viewport={'width': 960, 'height': 600}); pg.add_init_script(INIT)
        pg.goto('http://127.0.0.1:%d/' % A.port, timeout=60000)
        pg.wait_for_function("window.SlopeMod && SlopeMod.log().some(function(l){return l.indexOf('heap (')>=0})", timeout=240000)
        time.sleep(2)
        pg.evaluate("""(function(){ function ev(t){ var e = new KeyboardEvent(t, {key:'Enter', code:'Enter', bubbles:true, cancelable:true});
            try{Object.defineProperty(e,'keyCode',{get:function(){return 13}})}catch(x){} document.dispatchEvent(e); var c=document.querySelector('canvas'); if(c) c.dispatchEvent(e); }
            ev('keydown'); setTimeout(function(){ ev('keyup'); }, 120); })()""")
        pg.wait_for_function('SlopeMod.stats().deaths > 0 && !SlopeMod.stats().running', timeout=120000)
        time.sleep(4)
        draws = pg.evaluate('__probe.last.slice()')
        print('draws', draws, flush=True)
        print('lastDraws', pg.evaluate('SlopeMod.drawCounts()'), flush=True)
        for _ in range(6):
            print('state', pg.evaluate("(function(){var b=document.querySelector('.lb-over-btn'); return {btn: b && b.style.display, open: SlopeLeaderboard.stats().open, draws: SlopeMod.drawCounts().length, big: SlopeMod.drawCounts().filter(function(c){return c>300})}})()"), flush=True); time.sleep(0.5)
        pg.screenshot(path=os.path.join(A.out, 'over.png'))
        pg.evaluate("document.querySelector('.lb-root').style.display='none'")
        pg.screenshot(path=os.path.join(A.out, 'over_raw.png'))
        for i, k in enumerate(draws):
            if k.startswith('3744'): break
            pg.evaluate('__probe.skip = %d' % i); time.sleep(0.6)
            pg.screenshot(path=os.path.join(A.out, 'skip_%02d_%s.png' % (i, k.replace('@', '_'))))
        pg.evaluate('__probe.skip = null')
        b.close()
finally:
    srv.terminate()
