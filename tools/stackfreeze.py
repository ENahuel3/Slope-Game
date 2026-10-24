"""Soak test for the stacked-course / game-over freezes: serves <site dir> locally, loads it in headless Chromium
(swiftshader), sets Courses=N and the mod's straight-lane autopilot, presses Enter and watches for 'secs' seconds.
It logs the mod's decisions, lap spawn bursts (spawn point jumps), main-thread stalls (frame gaps), game stalls (ball
not moving while the mod thinks the run is live: the Unity runtime aborted, e.g. abort(218)) and every console error.
--audit prints, per FSM variable name, the heap candidates grouped by class pointer (only the variable objects should
remain after discovery). Needs playwright (python3 -m venv v && v/bin/pip install playwright && v/bin/playwright install chromium).
usage: stackfreeze.py <site dir> [--stack 3] [--secs 240] [--mode off] [--vp 480x300] [--stop-on-stall] [--audit]
Before the fix in 0f0eac7: stack 3 aborted at the second lap spawn burst, stack 1 aborted 6 s after game over."""
import sys, subprocess, time, json, os, argparse, socket
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('site'); ap.add_argument('--stack', type=int, default=3); ap.add_argument('--secs', type=int, default=240)
ap.add_argument('--port', type=int, default=8800); ap.add_argument('--mode', default='off'); ap.add_argument('--vp', default='480x300'); ap.add_argument('--stop-on-stall', dest='stop_on_stall', action='store_true'); ap.add_argument('--audit', action='store_true'); A = ap.parse_args()
def free(p):
    with socket.socket() as s: return s.connect_ex(('127.0.0.1', p)) != 0
while not free(A.port): A.port += 1
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(A.port), '--bind', '127.0.0.1', '--directory', A.site], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.6)
W, Hh = [int(x) for x in A.vp.split('x')]
PROBE = """() => { var st = SlopeMod.stats(), tr = SlopeMod.track(); return { frame: SlopeMod.frame(), st: st, pos: tr.pos, s: tr.s, spawn: tr.spawnPos, log: SlopeMod.log(), t: performance.now(), dt: SlopeMod.frameDt(), draws: SlopeMod.courseBatches(), vis: document.visibilityState }; }"""
try:
    with sync_playwright() as p:
        br = p.chromium.launch(headless=True, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'])
        ctx = br.new_context(viewport={'width': W, 'height': Hh}); page = ctx.new_page()
        errors = []; cons = []; page.on('console', lambda m: cons.append('%6.1f %s: %s' % (time.time() - T0[0], m.type, m.text[:1500]))); page.on('pageerror', lambda e: errors.append(str(e)[:3000])); page.on('crash', lambda: errors.append('PAGE CRASHED'))
        T0 = [time.time()]; page.goto('http://127.0.0.1:%d/' % A.port)
        for i in range(900):
            if page.evaluate("() => window.SlopeMod ? SlopeMod.log().some(l => /heap \\(/.test(l)) : false"): break
            time.sleep(0.1)
        if A.audit:
            print(json.dumps(page.evaluate("""() => { var H = SlopeMod.heapVars(), U = gameInstance.Module.HEAPU32, F = gameInstance.Module.HEAPF32, out = {};
                Object.keys(H).forEach(function (k) { var groups = {}; H[k].forEach(function (a) { var kl = U[a >> 2], sz = U[(a + 4) >> 2]; var key = kl.toString(16); (groups[key] = groups[key] || []).push([a, +F[(a + 24) >> 2].toFixed(3), U[(a + 4) >> 2], U[(a + 12) >> 2]]); }); out[k] = Object.keys(groups).map(function (g) { return g + ' x' + groups[g].length + (groups[g].length <= 3 ? ' ' + JSON.stringify(groups[g]) : ' e.g. ' + JSON.stringify(groups[g][0])); }); });
                return out; }"""), indent=0))
        page.evaluate("(n) => { SlopeMod.setStack(n); SlopeMod.setGravity('%s'); SlopeMod.setAutopilot(true); }" % A.mode, A.stack)
        time.sleep(0.5); page.keyboard.press('Enter')
        t0 = time.time(); T0[0] = t0; seenLog = 0; lastPos = None; lastMoveT = time.time(); lastFrame = -1; lastFrameT = time.time(); lastSpawnS = None; events = []; stalls = []; maxLat = 0; frozen = None
        def ev(msg): events.append('%6.1fs %s' % (time.time() - t0, msg)); print(events[-1], flush=True)
        hbT = time.time(); hbF = 0; shot = False
        while time.time() - t0 < A.secs:
            tq = time.time()
            try: pr = page.evaluate(PROBE)
            except Exception as e: ev('PROBE FAILED: ' + str(e)[:200]); break
            lat = time.time() - tq; maxLat = max(maxLat, lat)
            if lat > 1.0: ev('main thread busy %.1fs (frame %d)' % (lat, pr['frame']))
            log = pr['log']
            # new log lines (the log keeps the last 40; find how many are new by frame prefix)
            for l in log:
                fr = int(l.split(':')[0])
                if fr > seenLog: ev('log ' + l)
            if log: seenLog = max(seenLog, max(int(l.split(':')[0]) for l in log))
            sp = pr['spawn']; ss = None
            if sp: ss = (sp[1] * -1 + sp[2] * -1) / 2 ** 0.5 if False else (-sp[1] - sp[2]) / 2 ** 0.5   # FWD0 ~ (0,-1,-1)/sqrt2
            if ss is not None and lastSpawnS is not None and ss - lastSpawnS > 60: ev('spawn burst: s %.0f -> %.0f (+%.0f) frame %d' % (lastSpawnS, ss, ss - lastSpawnS, pr['frame']))
            if ss is not None: lastSpawnS = ss
            st = pr['st']
            if pr['frame'] == lastFrame:
                if time.time() - lastFrameT > 2 and frozen != 'loop': ev('FRAME LOOP STALLED at frame %d' % pr['frame']); frozen = 'loop'
            else: lastFrame = pr['frame']; lastFrameT = time.time(); frozen = None if frozen == 'loop' else frozen
            pos = pr['pos']
            if pos and lastPos and sum((pos[i] - lastPos[i]) ** 2 for i in range(3)) < 1e-4 and st['running'] and not st['building'] and not st['restarting']:
                if time.time() - lastMoveT > 2.5 and frozen != 'game': ev('GAME STALLED: ball still at %s for >2.5 s, running=%s phase=%s frame %d' % ([round(x, 1) for x in pos], st['running'], st['phase'], pr['frame'])); frozen = 'game'; stalls.append(pr['frame']); print('--- console tail:'); [print('   ', c) for c in cons[-12:]]; print('--- page errors:'); [print('   ', e) for e in errors[-3:]]
                if A.stop_on_stall: break
            else: lastMoveT = time.time(); frozen = None if frozen == 'game' else frozen
            lastPos = pos
            if time.time() - hbT >= 5:
                fps = (pr['frame'] - hbF) / (time.time() - hbT); hbT = time.time(); hbF = pr['frame']
                h = (pos[1] + pos[2]) / 2 ** 0.5 if pos else None
                ev('hb frame %d fps %.1f s %s h %s dt %.3f draws %s run %s phase %s vis %s' % (pr['frame'], fps, pr['s'], h and round(h, 1), pr['dt'], pr['draws'], st['running'], st['phase'], pr['vis']))
                if fps < 3 and not shot and pr['frame'] > 300: shot = True; page.screenshot(path='stall_%d.png' % A.stack); ev('screenshot (slow frames)')
            time.sleep(0.25)
        fin = page.evaluate(PROBE)
        open('console_%d.log' % A.stack, 'w').write('\n'.join(cons))
        print('--- console (errors/warnings + abort context):')
        for i, c in enumerate(cons):
            if ': error' in c[:14] or ': warning' in c[:16] or 'abort' in c: print('   ', c[:700])
        print('\nFINAL stats:', json.dumps(fin['st'])); print('ball s:', fin['s'], 'pos:', fin['pos']); print('max probe latency %.2fs' % maxLat); print('page errors:', errors[:5]); print('stalls at frames:', stalls)
        br.close()
finally: srv.terminate()
