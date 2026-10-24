"""Browser regressions for HUD/editor keyboard handling and music-source lifetimes.

Usage: python tools/runtime_check.py [repo-directory]
Requires Playwright and its Chromium browser. No Unity load or editor service is
needed: editor responses and media playback are stubbed; Web Audio source
start/stop calls and keyboard events use the browser's native implementations.
"""
import pathlib, sys
from playwright.sync_api import sync_playwright
root = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else pathlib.Path(__file__).resolve().parents[1]
failures = []
def check(name, condition, detail=''):
    print(('PASS ' if condition else 'FAIL ') + name + (' ' + str(detail) if detail else ''), flush=True)
    if not condition: failures.append(name)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--autoplay-policy=no-user-gesture-required'])
    def fresh():
        page = browser.new_page()
        page.route('**/*', lambda route: route.fulfill(body='<html><body><div id="hud"><select id="hud-style"><option>Classic</option><option>Rainbow</option></select><select id="hud-light"><option>Normal</option><option>Sunny</option></select><input id="hud-fx" type="range" value="50"><button id="hud-fs" onclick="window.buttonClicks=(window.buttonClicks||0)+1">Fullscreen</button></div></body></html>', content_type='text/html'))
        page.goto('http://slope.test/')
        page.evaluate('''() => {
          window.SLOPE_EDIT_API = 'http://editor.test'; window.calls = [];
          window.fetch = async (url, opts) => {
            calls.push(String(url));
            const value = String(url).endsWith('/api/login') ? {token:'test-session-token-123456'} : String(url).endsWith('/api/status') ? {locked:false,budget:{dayTokens:0,dayTokenCap:100000}} : String(url).includes('/api/job/') ? {state:'failed',log:[],tokens:0} : {id:'abcdef123456',position:1};
            return {ok:true,status:200,json:async()=>value};
          };
          window.requestAnimationFrame = () => 0;
          window.sources = []; window.playCalls = 0; window.pauseCalls = 0;
          const create = AudioContext.prototype.createBufferSource;
          AudioContext.prototype.createBufferSource = function() {const n = create.call(this); sources.push(n); return n;};
          const start = AudioBufferSourceNode.prototype.start, stop = AudioBufferSourceNode.prototype.stop;
          AudioBufferSourceNode.prototype.start = function() {this.startCalls = (this.startCalls||0)+1; return start.apply(this,arguments);};
          AudioBufferSourceNode.prototype.stop = function() {this.stopCalls = (this.stopCalls||0)+1; return stop.apply(this,arguments);};
          HTMLMediaElement.prototype.play = function() {playCalls++; Object.defineProperty(this,'paused',{value:false,configurable:true}); return Promise.resolve();};
          HTMLMediaElement.prototype.pause = function() {pauseCalls++; Object.defineProperty(this,'paused',{value:true,configurable:true});};
        }''')
        page.add_script_tag(path=str(root / 'TemplateData/mod.js'))
        # Model Unity's capture listener, which must never receive HUD/editor keys.
        page.evaluate('''() => {window.unityKeys = 0; window.addEventListener('keydown', e=>{unityKeys++; e.preventDefault();},true);}''')
        return page
    page = fresh()
    page.evaluate('SlopeMod.openEditor()')
    page.locator('.edit-passbox').fill('test-password')
    page.locator('.edit-passbox').press('Enter')
    page.wait_for_timeout(100)
    check('Enter unlocks dev mode', page.evaluate("calls.some(u=>u.endsWith('/api/login'))"))
    if not page.evaluate("calls.some(u=>u.endsWith('/api/login'))"):
        page.locator('.edit-unlock').click()
    page.wait_for_timeout(150)
    page.locator('.edit-box').fill('Make the track brighter')
    page.locator('.edit-box').press('Control+Enter')
    page.wait_for_timeout(100)
    check('Ctrl+Enter submits an edit', page.evaluate("calls.some(u=>u.endsWith('/api/edit'))"))
    page.locator('.edit-box').press('Escape')
    check('Escape closes focused dev panel', not page.locator('#edit-panel').evaluate("p=>p.classList.contains('open')"))
    for selector in ['#hud-style','#hud-light','#hud-fx']:
        page.locator(selector).focus()
        before = page.evaluate('unityKeys')
        page.keyboard.press('ArrowRight')
        check(selector+' keys shielded from Unity', page.evaluate('unityKeys') == before)
    page.locator('#hud-fs').press('Enter')
    check('HUD buttons retain Enter activation', page.evaluate('window.buttonClicks') == 1)
    page.close()
    page = fresh()
    result = page.evaluate('''() => {
        const ctx = new AudioContext(); const node = ctx.createBufferSource(); node.buffer = ctx.createBuffer(1, ctx.sampleRate*12, ctx.sampleRate); node.loop=true; node.connect(ctx.destination); node.start();
        SlopeMod.setMusic('aria'); SlopeMod.setMusic('original');
        const replacement = sources[sources.length-1];
        node.stop();
        return {replacementStarted:replacement.startCalls||0,replacementStopped:replacement.stopCalls||0};
    }''')
    check('switching back to original stops replacement on death', result['replacementStarted'] == 1 and result['replacementStopped'] == 1, result)
    page.close()
    page = fresh()
    result = page.evaluate('''() => {
        const ctx = new AudioContext(); const node = ctx.createBufferSource(); node.buffer = ctx.createBuffer(1,ctx.sampleRate*12,ctx.sampleRate); node.loop=true; node.connect(ctx.destination); node.start();
        for (let i=0;i<3;i++) {SlopeMod.setMusic('aria'); SlopeMod.setMusic('original');}
        node.stop();
        return sources.map(n=>({starts:n.startCalls||0,stops:n.stopCalls||0}));
    }''')
    check('repeated music switches leave no playing replacement', all(n['starts'] == 1 and n['stops'] == 1 for n in result), result)
    page.close()
    page = fresh()
    result = page.evaluate('''() => {
        const ctx = new AudioContext(); const node = ctx.createBufferSource(); node.buffer = ctx.createBuffer(1,ctx.sampleRate*12,ctx.sampleRate); node.connect(ctx.destination); node.start(); node.stop();
        SlopeMod.setMusic('aria'); return playCalls;
    }''')
    check('changing music after death stays paused', result == 0, {'playCalls':result})
    browser.close()
sys.exit(bool(failures))
