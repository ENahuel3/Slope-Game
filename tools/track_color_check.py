#!/usr/bin/env python3
"""Track color check: start a run with the white track under every lighting mode and report shader
failures, page errors and how bright the frame is (white should be clearly brighter than black).
usage: track_color_check.py <repo dir> [--port N] [--out DIR]"""
import argparse, os, subprocess, sys, tempfile, time
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('repo'); ap.add_argument('--port', type=int, default=8767); ap.add_argument('--out', default=None); A = ap.parse_args()
out = A.out or os.path.join(tempfile.gettempdir(), 'track-color-check'); os.makedirs(out, exist_ok=True)
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(A.port), '--bind', '127.0.0.1', '--directory', A.repo], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.6)

def mean_lum(png):
    from PIL import Image, ImageStat
    return round(ImageStat.Stat(Image.open(png).convert('L')).mean[0], 1)

fail = 0
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        page = browser.new_context(viewport={'width': 960, 'height': 600}).new_page()
        errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto('http://127.0.0.1:%d/' % A.port)
        for i in range(900):
            if page.evaluate("() => !!(window.SlopeMod && window.SlopeShaders && SlopeMod.log().some(l => /heap \\(/.test(l)))"): break
            time.sleep(0.1)
        else:
            print('SUMMARY fail (page never became ready; errors=%s)' % errors[:3]); sys.exit(1)
        time.sleep(1.0)
        page.evaluate("() => { SlopeShaders.setStyle('classic'); SlopeMod.setGravity('off'); if (SlopeMod.setAutopilot) SlopeMod.setAutopilot(true); }")
        page.keyboard.press('Enter'); time.sleep(2.0)
        for light in ['normal', 'sunny', 'sunset', 'night']:
            res = {}
            page.evaluate("() => SlopeMod.restart()"); time.sleep(2.0)   # a fresh run, so the frames show the track and not a game-over screen
            for color in ['black', 'white']:
                page.evaluate("a => { SlopeShaders.setLight(a[0]); SlopeShaders.setTrackColor(a[1]); }", [light, color]); time.sleep(1.5)
                png = os.path.join(out, '%s-%s.png' % (light, color)); page.screenshot(path=png); res[color] = mean_lum(png)
            st = page.evaluate("() => SlopeShaders.stats()")
            good = not st.get('lightFailed') and res['white'] > res['black'] + 5
            fail += not good
            print('%-7s black=%s white=%s failed=%s %s' % (light, res['black'], res['white'], st.get('failed'), 'ok' if good else 'FAIL'))
        running = page.evaluate("() => SlopeMod.stats().running")
        print('SUMMARY %s running=%s errors=%s out=%s' % ('ok' if not fail and not errors else 'FAIL', running, errors[:3], out))
        browser.close()
finally:
    srv.terminate()
sys.exit(1 if fail else 0)
