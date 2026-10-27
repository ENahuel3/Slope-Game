"""Where is the ball, in a super ramp's lane frame, as it passes the ramp? Loads the page headless (like smoke_check.py),
starts a run with ramps on every eligible block and records the ball's lane coordinates (x across, s along, n up)
for every ramp it comes near, plus the launch count. usage: ramp_probe.py <repo dir> [--port N] [--seconds 20]"""
import argparse, json, os, subprocess, sys, time
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('repo'); ap.add_argument('--port', type=int, default=8779); ap.add_argument('--seconds', type=float, default=20)
A = ap.parse_args(); REPO = os.path.abspath(A.repo)
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(A.port), '--bind', '127.0.0.1', '--directory', REPO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
PROBE = """(function(){ var R = window.SlopeRamps; R.setEnabled(true); R.params.every = 1; R.params.minGap = 3; R.params.minS = 60; R.params.minAhead = 15;
  window.__rp = []; function dot(a,b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
  (function tick(){ try { var b = SlopeCoins.ballPos(), fr = SlopeCoins.frames(), rs = R.ramps();
    if (b) rs.forEach(function(r){ var f = fr.filter(function(x){return x.key===r.key;})[0]; if(!f) return; var d=[b[0]-f.org[0],b[1]-f.org[1],b[2]-f.org[2]];
      var c=[dot(d,f.right),dot(d,f.fwd),dot(d,f.up)]; if (c[1] > -10 && c[1] < 25) window.__rp.push({k:r.key, fired:r.fired, c:c.map(function(v){return +v.toFixed(2)}), boosting: SlopeMod.boosting(), t: performance.now()|0}); });
    if (b) fr.forEach(function(f){ if(!f.lane) return; var d=[b[0]-f.org[0],b[1]-f.org[1],b[2]-f.org[2]]; var c=[dot(d,f.right),dot(d,f.fwd),dot(d,f.up)];
      if (c[0]>-1&&c[0]<11&&c[1]>=0&&c[1]<14.2&&c[2]>-3&&c[2]<5) window.__rp.push({k:'FLOOR '+f.kind, c:c.map(function(v){return +v.toFixed(2)}), fired:0, boosting:false}); });
  } catch(e) { window.__rp.push({err:String(e)}); } setTimeout(tick, 16); })(); })()"""
try:
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'])
        pg = b.new_page(viewport={'width': 640, 'height': 400})
        pg.goto('http://127.0.0.1:%d/' % A.port, timeout=60000)
        pg.wait_for_function('window.SlopeMod && window.gameInstance && window.SlopeRamps', timeout=180000)
        pg.wait_for_function("SlopeMod.log().some(function(l){return l.indexOf('heap (')>=0})", timeout=180000)
        time.sleep(2)
        pg.evaluate(PROBE)
        pg.evaluate("""(function(){ function ev(t){ var e = new KeyboardEvent(t, {key:'Enter', code:'Enter', bubbles:true, cancelable:true});
            try{Object.defineProperty(e,'keyCode',{get:function(){return 13}})}catch(x){} document.dispatchEvent(e); var c=document.querySelector('canvas'); if(c) c.dispatchEvent(e); }
            ev('keydown'); setTimeout(function(){ ev('keyup'); }, 120); })()""")
        time.sleep(A.seconds)
        out = pg.evaluate('({rp: window.__rp, stats: SlopeRamps.stats(), mod: {deaths: SlopeMod.stats().deaths, running: SlopeMod.stats().running}})')
        print(json.dumps(out['stats']), json.dumps(out['mod']))
        last = {}
        for e in out['rp']:
            if 'err' in e: print('ERR', e['err']); continue
            k = e['k']
            if k.startswith('FLOOR'): continue
            if last.get(k) != (e['c'][1] // 1): last[k] = e['c'][1] // 1; print(k[:12], e['c'], 'fired' if e['fired'] else '', 'boost' if e['boosting'] else '')
        b.close()
finally:
    srv.terminate()
