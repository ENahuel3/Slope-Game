"""Check the mod's coins (TemplateData/coins.js): serve the repository, start a run in headless Chromium with the
mod's autopilot on a straight track, and verify that track pieces are recognised from their draw calls, coins are
generated for them and drawn without GL errors, a coin planted on the ball's line is collected (counter, badge), and
the game keeps advancing with the coin draws in the frame. Screenshots go to --out; with --watch the run continues
until each named piece kind has been seen close ahead of the ball and photographed (or --seconds runs out).
usage: coin_check.py <repo dir> [--port N] [--out DIR] [--seconds 40] [--watch tunnelArc,jumpGapMid,...] [--light sunny] [--webgl1] [--width 960 --height 600]
(run with the playwright package installed, see bench_load.py)"""
import sys, subprocess, time, os, argparse, tempfile, json
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('repo'); ap.add_argument('--port', type=int, default=8768); ap.add_argument('--out', default=None)
ap.add_argument('--seconds', type=float, default=40); ap.add_argument('--watch', default=''); ap.add_argument('--light', default='normal'); ap.add_argument('--style', default='classic')
ap.add_argument('--width', type=int, default=960); ap.add_argument('--height', type=int, default=600); ap.add_argument('--webgl1', action='store_true'); ap.add_argument('--gpu', action='store_true', help='real GPU through ANGLE instead of SwiftShader')
A = ap.parse_args()
out = A.out or os.path.join(tempfile.gettempdir(), 'coin-check'); os.makedirs(out, exist_ok=True)
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(A.port), '--bind', '127.0.0.1', '--directory', A.repo], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.6)
if srv.poll() is not None: sys.exit('could not start the local server on port %d (in use?)' % A.port)
ok = fail = 0
def check(label, good, detail=''):
    global ok, fail
    ok += bool(good); fail += (not good)
    print('%-5s %-28s %s' % ('ok' if good else 'FAIL', label, detail))
watch = [k for k in A.watch.split(',') if k]
try:
    with sync_playwright() as p:
        args = (['--use-gl=angle', '--use-angle=gl'] if A.gpu else ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']) + ['--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] + (['--disable-webgl2'] if A.webgl1 else [])
        browser = p.chromium.launch(headless=True, args=args); ctx = browser.new_context(viewport={'width': A.width, 'height': A.height}); page = ctx.new_page()
        logs = []; errors = []
        page.on('console', lambda m: logs.append(m.type + ': ' + m.text))
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto('http://127.0.0.1:%d/' % A.port)
        ready = False
        for i in range(900):
            if page.evaluate("() => !!(window.SlopeMod && window.SlopeShaders && window.SlopeCoins && SlopeMod.log().some(l => /heap \\(/.test(l)))"): ready = True; break
            time.sleep(0.1)
        check('page ready', ready, 'errors=%s' % errors[:3])
        if not ready: sys.exit(1)
        page.evaluate("(a) => { SlopeMod.setGravity('off'); SlopeMod.setStack(1); SlopeMod.setAutopilot(true); SlopeShaders.setStyle(a[0]); SlopeShaders.setLight(a[1]); SlopeCoins.setEnabled(true); }", [A.style, A.light])
        page.keyboard.press('Enter'); time.sleep(2.5)
        st = page.evaluate("() => SlopeCoins.stats()"); sh = page.evaluate("() => SlopeShaders.stats()")
        print('START', json.dumps(st), 'glVersion=%s redirect=%s' % (sh['glVersion'], sh['redirect']))
        check('pieces recognised', st['pieces'] > 0, 'pieces=%d kinds=%s' % (st['pieces'], st['kinds']))
        check('coins generated', st['coins'] > 0, 'coins=%d' % st['coins'])
        check('ball + camera seen', st['ball'] is not None and st['camera'], 'ball=%s camera=%s' % (st['ball'], st['camera']))
        check('coin assets loaded', st['mesh'] and st['texture'] and st['gl'], 'mesh=%s texture=%s gl=%s' % (st['mesh'], st['texture'], st['gl']))
        check('coins drawn', st['drawn'] > 0, 'drawn=%d' % st['drawn'])
        check('no coin errors', st['errors'] == 0, 'errors=%d' % st['errors'])
        page.screenshot(path=os.path.join(out, 'start.png'))
        # collection: a coin planted 14 units down the ball's own line
        before = page.evaluate("() => SlopeCoins.count()")
        planted = page.evaluate("() => { var b = SlopeCoins.ballPos(); if (!b) return null; var k = 14 * 0.70710678; SlopeCoins.plant(b[0], b[1] - k, b[2] + k); return [b[0], b[1] - k, b[2] + k]; }")
        t0 = time.time(); got = False
        while time.time() - t0 < 4:
            time.sleep(0.1)
            if page.evaluate("() => SlopeCoins.count()") > before: got = True; break
        badge = page.evaluate("() => (document.getElementById('hud-coin-count') || {}).textContent")
        check('planted coin collected', got, 'planted at %s, count %s -> %s in %.1fs, badge=%r' % (planted, before, page.evaluate("() => SlopeCoins.count()"), time.time() - t0, badge))
        # the game keeps running with the coins in the frame
        f0 = page.evaluate("() => SlopeMod.frame()"); s0 = page.evaluate("() => SlopeMod.track().s"); e0 = page.evaluate("() => SlopeShaders.stats().errors"); time.sleep(1.0)
        f1 = page.evaluate("() => SlopeMod.frame()"); s1 = page.evaluate("() => SlopeMod.track().s"); e1 = page.evaluate("() => SlopeShaders.stats().errors"); running = page.evaluate("() => SlopeMod.stats().running")
        check('game loop alive', f1 > f0 and (not running or (s1 or 0) > (s0 or 0)), 'frames %d->%d s %s->%s running=%s' % (f0, f1, s0, s1, running))
        check('no GL errors (shaders)', e1 == e0, 'errors %d->%d' % (e0, e1))
        # toggling off removes every coin; on brings them back as pieces are drawn again
        page.evaluate("() => SlopeCoins.setEnabled(false)"); time.sleep(0.3); off = page.evaluate("() => SlopeCoins.stats()")
        page.evaluate("() => SlopeCoins.setEnabled(true)"); time.sleep(0.6); on = page.evaluate("() => SlopeCoins.stats()")
        check('toggle off/on', off['coins'] == 0 and off['drawn'] == 0 and on['pieces'] > 0, 'off: coins=%d drawn=%d; on: pieces=%d coins=%d' % (off['coins'], off['drawn'], on['pieces'], on['coins']))
        # watch for piece kinds ahead of the ball and photograph them
        seen = {}; deadline = time.time() + A.seconds; shots = 0; last_shot = 0
        while time.time() < deadline and (watch and any(k not in seen for k in watch) or (not watch and time.time() - t0 < 8)):
            time.sleep(0.25)
            if not page.evaluate("() => SlopeMod.stats().running"):
                page.keyboard.press('Enter'); time.sleep(1.5); continue
            info = page.evaluate("() => ({ ball: SlopeCoins.ballPos(), pieces: SlopeCoins.pieces(), s: SlopeMod.track().s })")
            b = info['ball']
            if not b: continue
            sb = -0.70710678 * b[1] + 0.70710678 * b[2]
            for pc in info['pieces']:
                sp = -0.70710678 * pc['pos'][1] + 0.70710678 * pc['pos'][2]
                ahead = sp - sb
                if pc['kind'] in watch and pc['kind'] not in seen and -5 < ahead < 45 and pc['coins'] > 0:
                    seen[pc['kind']] = ahead; png = os.path.join(out, 'watch-%s.png' % pc['kind']); page.screenshot(path=png); shots += 1
                    print('SHOT  %-14s %.0f ahead of the ball (s=%.0f), %d coins -> %s' % (pc['kind'], ahead, sb, pc['coins'], png))
            if time.time() - last_shot > 3 and not watch: last_shot = time.time(); page.screenshot(path=os.path.join(out, 'run-%02d.png' % shots)); shots += 1
        if watch:
            missing = [k for k in watch if k not in seen]
            check('watched pieces seen', not missing, 'seen=%s missing=%s' % (seen, missing))
        fin = page.evaluate("() => SlopeCoins.stats()"); shf = page.evaluate("() => SlopeShaders.stats()")
        check('no errors at the end', fin['errors'] == 0 and shf['errors'] == e0 and not errors, 'coins=%d shaders=%d page=%s' % (fin['errors'], shf['errors'], errors[:2]))
        print('END', json.dumps(fin))
        bad = [l for l in logs if 'slope-coins' in l or ('error' in l.lower() and 'blocked' not in l.lower())][:8]
        if bad: print('LOGS', bad)
        browser.close()
finally:
    srv.terminate()
print('SUMMARY ok=%d fail=%d out=%s' % (ok, fail, out))
sys.exit(1 if fail else 0)
