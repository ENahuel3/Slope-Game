#!/usr/bin/env python3
"""Ray Tracing (Experimental) check: loads the page headless with ray tracing on, cycles the lighting modes and
both track colours, and reports whether the ray-traced passes compiled and ran.
usage: rt_check.py <repo dir> [--port N]"""
import argparse, os, subprocess, sys, time
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('repo'); ap.add_argument('--port', type=int, default=8779); A = ap.parse_args()
srv = subprocess.Popen([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'serve.py'), str(A.port), '--bind', '127.0.0.1', '--directory', A.repo], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    time.sleep(1)
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'])
        pg = b.new_page(viewport={'width': 640, 'height': 400}); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)[:300]))
        pg.on('console', lambda m: errs.append(m.type + ': ' + m.text[:300]) if m.type in ('error', 'warning') and ('SlopeShaders' in m.text or 'slope-mod' in m.text) else None)
        pg.add_init_script("try{localStorage.setItem('slope.rt','1')}catch(e){}")
        pg.goto('http://127.0.0.1:%d/' % A.port, timeout=60000)
        pg.wait_for_function('window.SlopeMod && window.gameInstance && window.SlopeShaders', timeout=180000)
        f0 = pg.evaluate('SlopeMod.frame()'); pg.wait_for_function('SlopeMod.frame() > %d + 60' % f0, timeout=120000)
        ok = True
        for track in ('black', 'white'):
            for light in ('normal', 'sunny', 'sunset', 'night'):
                pg.evaluate("(function(){var s=document.getElementById('hud-track'); s.value='%s'; s.dispatchEvent(new Event('change')); var l=document.getElementById('hud-light'); l.value='%s'; l.dispatchEvent(new Event('change'));})()" % (track, light))
                time.sleep(1.5)
                st = pg.evaluate('SlopeShaders.stats()')
                good = st['rayTracing'] and not st['rtFailed'] and not st['lightFailed'] and st['passes'] > 0
                ok = ok and good
                print('%-5s %-6s passes %d, %.2f ms, rtFailed %s%s' % (track, light, st['passes'], st['lastPassMs'], st['rtFailed'], '' if good else '  <-- FAIL'), flush=True)
        if errs: print('messages: ' + '; '.join(errs[:5])); ok = False
        print('OK' if ok else 'FAILED'); b.close()
finally:
    srv.terminate()
