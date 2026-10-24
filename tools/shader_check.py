"""Check the mod's shader system (TemplateData/shaders.js): serve the repository, start a run in headless Chromium,
switch through every style and verify that frames are presented, no GL error or shader failure is counted, the
screenshot differs from Classic and the ball keeps advancing; then back to Classic, where no pass may run and the
game must still advance (the passes restore GL state). Writes one screenshot per style.
usage: shader_check.py <repo dir> [--port N] [--url https://site] [--out DIR] [--styles a,b,c] [--settle 1.5] [--width 960 --height 600]
(run with the playwright package installed, see bench_load.py)"""
import sys, subprocess, time, os, argparse, tempfile
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('repo'); ap.add_argument('--port', type=int, default=8766); ap.add_argument('--url', default=None)
ap.add_argument('--out', default=None); ap.add_argument('--styles', default=None); ap.add_argument('--settle', type=float, default=1.5)
ap.add_argument('--width', type=int, default=960); ap.add_argument('--height', type=int, default=600); ap.add_argument('--webgl1', action='store_true', help='disable WebGL 2 so the game takes its WebGL 1 path'); A = ap.parse_args()
out = A.out or os.path.join(tempfile.gettempdir(), 'shader-check'); os.makedirs(out, exist_ok=True)
srv = None
if not A.url:
    srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(A.port), '--bind', '127.0.0.1', '--directory', A.repo], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.6)
    if srv.poll() is not None: sys.exit('could not start the local server on port %d (in use?)' % A.port)
base = A.url.rstrip('/') if A.url else 'http://127.0.0.1:%d' % A.port

def img_diff(a, b):
    """mean absolute per-channel difference (0..255) between two PNG files, or None without Pillow"""
    try:
        from PIL import Image, ImageChops, ImageStat
    except ImportError:
        return None
    ia, ib = Image.open(a).convert('RGB'), Image.open(b).convert('RGB')
    if ia.size != ib.size: ib = ib.resize(ia.size)
    return round(sum(ImageStat.Stat(ImageChops.difference(ia, ib)).mean) / 3, 2)

ok = fail = 0
try:
    with sync_playwright() as p:
        args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] + (['--disable-webgl2'] if A.webgl1 else [])
        browser = p.chromium.launch(headless=True, args=args); ctx = browser.new_context(viewport={'width': A.width, 'height': A.height}); page = ctx.new_page()
        logs = []; errors = []
        page.on('console', lambda m: logs.append(m.type + ': ' + m.text))
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(base + '/')
        ready = False
        for i in range(900):
            if page.evaluate("() => !!(window.SlopeMod && window.SlopeShaders && SlopeMod.log().some(l => /heap \\(/.test(l)))"): ready = True; break
            time.sleep(0.1)
        if not ready: print('SUMMARY ok=0 fail=1 out=%s (page never became ready; errors=%s)' % (out, errors[:3])); sys.exit(1)
        # the title menu is 2D UI drawn without depth: under the lit modes it must stay readable over the sky
        def bright_count(png):
            try:
                from PIL import Image
            except ImportError:
                return None
            im = Image.open(png).convert('RGB'); px = im.getdata(); return sum(1 for r, g, b in px if g > 150 and r < 110 and b < 110)   # the menu's green text and frames
        time.sleep(1.0); menu_png = os.path.join(out, 'menu-classic.png'); page.evaluate("() => { SlopeShaders.setStyle('classic'); SlopeShaders.setLight('normal'); }"); time.sleep(0.5); page.screenshot(path=menu_png); menu_ref = bright_count(menu_png)
        for light in [l['id'] for l in page.evaluate("() => SlopeShaders.lights()") if l['id'] != 'normal']:
            page.evaluate("l => SlopeShaders.setLight(l)", light); time.sleep(1.0)
            png = os.path.join(out, 'menu-light-%s.png' % light); page.screenshot(path=png); n = bright_count(png)
            good = (menu_ref is None) or (n is not None and menu_ref > 0 and n >= 0.7 * menu_ref)
            ok += good; fail += (not good)
            print('MENU  %-16s green=%s ref=%s %s' % ('light-' + light, n, menu_ref, 'ok' if good else 'FAIL(menu hidden under the sky)'))
        page.evaluate("() => SlopeShaders.setLight('normal')"); time.sleep(0.3)
        # a straight track with the mod's test autopilot keeps the ball alive while the styles are checked
        page.evaluate("() => { SlopeMod.setGravity('off'); if (SlopeMod.setAutopilot) SlopeMod.setAutopilot(true); }"); page.keyboard.press('Enter'); time.sleep(1.0)
        styles = [s['id'] for s in page.evaluate("() => SlopeShaders.styles()")]
        if A.styles: styles = A.styles.split(',')
        page.evaluate("() => SlopeShaders.setStyle('classic')"); time.sleep(A.settle)
        base_png = os.path.join(out, 'classic-baseline.png'); page.screenshot(path=base_png)
        gl = page.evaluate("() => SlopeShaders.stats()")
        print('READY glVersion=%s vao=%s size=%sx%s styles=%s' % (gl['glVersion'], gl['vao'], page.evaluate("() => document.querySelector('canvas').width"), page.evaluate("() => document.querySelector('canvas').height"), ','.join(styles)))

        def check(style, expect_passes, label=None, light='normal'):
            global ok, fail
            label = label or style
            page.evaluate("s => SlopeShaders.setStyle(s)", style); time.sleep(A.settle)
            st0 = page.evaluate("() => SlopeShaders.stats()"); s0 = page.evaluate("() => SlopeMod.track().s"); fr0 = page.evaluate("() => SlopeMod.frame()"); e0 = len(errors)
            time.sleep(0.7)
            st1 = page.evaluate("() => SlopeShaders.stats()"); s1 = page.evaluate("() => SlopeMod.track().s"); fr1 = page.evaluate("() => SlopeMod.frame()"); running = page.evaluate("() => SlopeMod.stats().running")
            png = os.path.join(out, label + '.png'); page.screenshot(path=png)
            diff = img_diff(base_png, png) if expect_passes else None
            reasons = []
            if st1['style'] != style: reasons.append('style=%s' % st1['style'])
            if st1['presented'] <= st0['presented'] and expect_passes: reasons.append('nothing presented')
            if expect_passes and st1['passes'] < 1: reasons.append('passes=%d' % st1['passes'])
            if not expect_passes and st1['passes'] != 0: reasons.append('passes=%d' % st1['passes'])
            if st1['errors']: reasons.append('glErrors=%d' % st1['errors'])
            if st1['failed'] or st1.get('styleFailed') or st1.get('lightFailed'): reasons.append('shaderFailed=%d' % st1['failed'])
            if st1.get('light') != light: reasons.append('light=%s' % st1.get('light'))
            if light != 'normal' and not st1.get('redirect'): reasons.append('depth capture not active')
            if light != 'normal' and st1.get('glVersion') == 2 and st1.get('depth') != 'texture': reasons.append('no depth texture (%s)' % st1.get('depth'))
            if light == 'normal' and st1.get('redirect'): reasons.append('depth capture still active')
            if fr1 <= fr0: reasons.append('game loop frozen (frame %s -> %s)' % (fr0, fr1))
            elif not (s1 is not None and s0 is not None and s1 > s0) and running: reasons.append('ball not advancing (s %s -> %s)' % (s0, s1))
            died = '' if running else ' (ball died, restarting)'
            if expect_passes and diff is not None and diff < 0.5: reasons.append('screenshot same as classic (diff=%s)' % diff)
            if len(errors) > e0: reasons.append('page errors: %s' % errors[e0:e0 + 2])
            good = not reasons
            ok += good; fail += (not good)
            print('STYLE %-16s presented=+%d passes=%d errors=%d failed=%d ms=%s diff=%s s=+%.1f %s' % (label, st1['presented'] - st0['presented'], st1['passes'], st1['errors'], st1['failed'], st1['lastPassMs'], diff, (s1 or 0) - (s0 or 0), ('ok' if good else 'FAIL(' + '; '.join(reasons) + ')') + died))
            if running is False:   # a death ends the run; start a new one so the next style has a moving ball
                page.evaluate("() => SlopeMod.restart()"); time.sleep(2.0)

        for style in styles: check(style, style != 'classic')
        check('classic', False)
        # lighting: each lit mode with Classic, then Night under a style, then back to Normal (the redirect must come off cleanly)
        cam = page.evaluate("() => SlopeShaders.camera()"); print('CAMERA live=%s near=%s far=%s fovY=%s aspect=%s' % (cam['live'], cam['near'], cam['far'], cam['fovY'], cam['aspect']))
        for light in [l['id'] for l in page.evaluate("() => SlopeShaders.lights()") if l['id'] != 'normal']:
            page.evaluate("l => SlopeShaders.setLight(l)", light); time.sleep(0.3); check('classic', True, 'light-' + light, light)
        page.evaluate("() => SlopeShaders.setLight('night')"); time.sleep(0.3); check(styles[3] if len(styles) > 3 else styles[-1], True, 'light-night-' + (styles[3] if len(styles) > 3 else styles[-1]), 'night')
        page.evaluate("() => SlopeShaders.setLight('normal')"); time.sleep(0.3); check('classic', False, 'light-normal', 'normal')
        page.evaluate("() => SlopeShaders.setIntensity(0.5)"); check(styles[1] if len(styles) > 1 else 'classic', len(styles) > 1)
        browser.close()
finally:
    if srv: srv.terminate()
print('SUMMARY ok=%d fail=%d out=%s' % (ok, fail, out))
sys.exit(1 if fail else 0)
