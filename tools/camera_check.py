"""Check the rendered camera follows the lane roll in the real Unity player.
Serve the repository, then run: camera_check.py [--url http://127.0.0.1:8769/]
"""
import argparse
import math
import time
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--url', default='http://127.0.0.1:8769/')
parser.add_argument('--webgl1', action='store_true')
parser.add_argument('--negative', action='store_true')
args = parser.parse_args()
with sync_playwright() as p:
    flags = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required']
    if args.webgl1: flags.append('--disable-webgl2')
    browser = p.chromium.launch(headless=True, args=flags)
    page = browser.new_page(viewport={'width':480, 'height':300})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(args.url)
    page.wait_for_function("window.SlopeMod && SlopeMod.log().some(l=>/heap \\(/.test(l))", timeout=90000)
    turn = -90 if args.negative else 90
    page.evaluate("""turn => {
        SlopeMod.setStack(1); SlopeMod.setGravity('twists');
        SlopeMod.setTwistQueue([turn,turn,turn,turn]); SlopeMod.setTwistParams({at:5});
        SlopeMod.setAutopilot(true); SlopeMod.setMusic('original'); SlopeShaders.setStyle('rainbow');
    }""", turn)
    page.keyboard.press('Enter')
    start = time.time(); maximum = 0; worst = 0; count = 0; restart_at = start
    while time.time()-start < 120:
        v = page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => resolve({roll:SlopeMod.roll(), camera:SlopeShaders.camera(), stats:SlopeMod.stats()})))')
        if v['stats']['running'] and not v['stats']['restarting'] and not v['stats']['building']:
            angle = math.radians(v['roll'] or 0)
            expected = [math.cos(angle), math.sin(angle)*math.sqrt(.5), math.sin(angle)*math.sqrt(.5)]
            right = v['camera']['right']
            dot = sum(x*y for x,y in zip(expected,right))/math.sqrt(sum(x*x for x in right))
            error = math.degrees(math.acos(max(-1,min(1,dot))))
            if abs(v['roll'] or 0) > 5:
                worst = max(worst,error); count += 1
                # Frame-synchronized samples should match within numerical
                # precision; allow a small tolerance for matrix rounding.
                assert error < 2, (v,error)
            old = maximum
            maximum = max(maximum,abs(v['roll'] or 0))
            if int(maximum/30) > int(old/30): print(f'roll {maximum:.1f}°, alignment error {error:.2f}°',flush=True)
            if maximum >= 25 and count >= 20:
                page.screenshot(path='/tmp/slope-camera-checked.png')
                break
        elif time.time()-restart_at > 5 and not v['stats']['building'] and not v['stats']['restarting']:
            page.evaluate('turn=>SlopeMod.setTwistQueue([turn,turn,turn,turn])',turn)
            page.keyboard.press('r'); restart_at=time.time()
        page.wait_for_timeout(100)
    assert maximum >= 20 and count >= 20, (maximum,count)
    # Switching back to straight must also restore the original view orientation.
    page.evaluate("SlopeMod.setGravity('off')")
    page.wait_for_timeout(300)
    right = page.evaluate('SlopeShaders.camera().right')
    assert right[0] > .99 and abs(right[1]) < .01 and abs(right[2]) < .01, right
    # Deterministic native-state sweep covers complete turns without relying on
    # the autopilot surviving randomly placed obstacles to reach every angle.
    page.reload()
    page.wait_for_function("window.SlopeMod && SlopeMod.log().some(l=>/heap \\(/.test(l))", timeout=90000)
    page.evaluate("SlopeShaders.setStyle('rainbow')")
    page.keyboard.press('Enter')
    page.wait_for_function('SlopeMod.stats().running', timeout=15000)
    page.wait_for_timeout(300)
    page.evaluate("window.cameraTestObjects=Object.fromEntries(['ModQCamera','ModCameraOffset'].map(name=>[name,SlopeMod.fsmGet(name)]))")
    for degrees in [0, 20, 90, 180, 270, 360, -90, -180, -270, -360]:
        page.evaluate("""degrees => {
            const angle=degrees*Math.PI/180, C=Math.SQRT1_2;
            const q=[0,-C*Math.sin(angle/2),C*Math.sin(angle/2),Math.cos(angle/2)];
            const base=[.4355890154838562,0,0,.9001456499099731];
            const mul=(a,b)=>[a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1], a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0], a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3], a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2]];
            const offset=mul(mul(q,[0,3.0560860633850098,-1.2071590423583984,0]),[-q[0],-q[1],-q[2],q[3]]).slice(0,3);
            for(const [name,value] of [['ModQCamera',mul(q,base)],['ModCameraOffset',offset]]) {
                const objects=window.cameraTestObjects[name]; if(!objects.length)throw Error(name+' missing');
                for(const [address] of objects) gameInstance.Module.HEAPF32.set(value,(address+24)>>2);
            }
            gameInstance.SendMessage('CameraDummy/Main Camera','SetState','Mod follow roll');
        }""", degrees)
        page.wait_for_timeout(200)
        right=page.evaluate('SlopeShaders.camera().right')
        a=math.radians(degrees); expected=[math.cos(a),math.sin(a)*math.sqrt(.5),math.sin(a)*math.sqrt(.5)]
        assert max(abs(x-y) for x,y in zip(right,expected)) < .005, (degrees,right,expected)
    assert not errors, errors
    print(f'PASS rendered camera: max roll {maximum:.1f}°, max alignment error {worst:.2f}°, {count} rolled samples; straight restored; native full-turn sweep passed; no page errors',flush=True)
    browser.close()
