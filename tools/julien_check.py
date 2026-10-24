"""Check Julien obstacle textures, immediate music switching and GL-state restoration.
Usage: python tools/julien_check.py [repo] [--webgl1] [--port 8772]
Requires Playwright Chromium. Screenshots go in /tmp/slope-julien-check-{1,2}.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('repo', nargs='?', default=str(Path(__file__).resolve().parents[1]))
ap.add_argument('--webgl1', action='store_true')
ap.add_argument('--port', type=int, default=8772)
a = ap.parse_args()
out = Path(tempfile.gettempdir()) / ('slope-julien-check-1' if a.webgl1 else 'slope-julien-check-2')
out.mkdir(exist_ok=True)
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(a.port), '--bind', '127.0.0.1', '--directory', a.repo], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(.5)
if srv.poll() is not None: sys.exit('Local HTTP server failed to start')
checks = 0
try:
    with sync_playwright() as p:
        args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required']
        if a.webgl1: args.append('--disable-webgl2')
        browser = p.chromium.launch(headless=True, args=args)
        page = browser.new_page(viewport={'width':640, 'height':400})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto('http://127.0.0.1:%d/' % a.port)
        page.wait_for_function("window.SlopeMod && SlopeMod.log().some(l => /heap \\(/.test(l))", timeout=90000)
        def check(name, condition, detail=None):
            global checks
            if not condition: raise AssertionError(name + ': ' + str(detail))
            checks += 1
            print('PASS', name, detail if detail is not None else '', flush=True)
        check('four shipped red textures identified', page.evaluate('SlopeJulien.stats().tagged') == 4, page.evaluate('SlopeJulien.stats()'))
        page.evaluate("SlopeMod.setStack(1); SlopeMod.setGravity('off'); SlopeMod.setMusic('billie'); SlopeMod.setMort(true); SlopeMod.setJulien(true); SlopeMod.setAutopilot(true); SlopeShaders.setStyle('classic'); SlopeShaders.setLight('normal')")
        page.keyboard.press('Enter')
        page.wait_for_function('SlopeJulien.stats().draws > 5', timeout=15000)
        check('King Julien on draws faces', page.evaluate('SlopeJulien.stats().created') > 0)
        page.screenshot(path=str(out / 'billie.png'))
        for music in ['original', 'aria']:
            page.evaluate('m => {SlopeMod.setMusic(m); SlopeMod.setJulien(false)}', music)
            before = page.evaluate('SlopeJulien.stats().draws')
            page.wait_for_timeout(350)
            check(music + ': Julien off restores plain red immediately', page.evaluate('SlopeJulien.stats().draws') == before)
            page.screenshot(path=str(out / (music + '.png')))
        before = page.evaluate('SlopeJulien.stats().draws')
        page.evaluate("SlopeMod.setMusic('original'); SlopeMod.setJulien(true)")
        page.wait_for_function('n => SlopeJulien.stats().draws > n', arg=before, timeout=10000)
        check('Julien on restores faces independently of music', True)
        page.evaluate("SlopeShaders.setLight('night'); SlopeShaders.setStyle('rainbow'); SlopeShaders.setIntensity(.5)")
        page.wait_for_timeout(1500)
        st = page.evaluate('SlopeShaders.stats()')
        check('faces combine with Night and Rainbow', st['passes'] > 0 and st['errors'] == 0 and st['failed'] == 0, st)
        result = page.evaluate('''() => {
            const canvas=document.querySelector('canvas');
            const gl=canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
            const active=gl.getParameter(gl.ACTIVE_TEXTURE), mismatches=[];
            (gl.__julienUnits || []).forEach((tex,i)=>{
                gl.activeTexture(gl.TEXTURE0+i);
                if(gl.getParameter(gl.TEXTURE_BINDING_2D)!==tex)mismatches.push(i);
            });
            gl.activeTexture(active);
            return {error:gl.getError(),mismatches};
        }''')
        check('Unity texture bindings restored after themed draws', not result['mismatches'], result)
        check('no WebGL error', result['error'] == 0, result)
        check('no page errors', not errors, errors)
        page.screenshot(path=str(out / 'night-rainbow.png'))
        browser.close()
finally:
    srv.terminate()
print('SUMMARY checks=%d out=%s' % (checks, out))
