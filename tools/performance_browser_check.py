"""Verify adaptive Unity resolution, pointer/keyboard input and state restoration.
Usage: python tools/performance_browser_check.py . [--webgl1]
"""
import argparse,pathlib,subprocess,sys,time
from PIL import Image
from playwright.sync_api import sync_playwright
ap=argparse.ArgumentParser();ap.add_argument('repo',nargs='?',default='.');ap.add_argument('--webgl1',action='store_true');A=ap.parse_args()
root=pathlib.Path(A.repo).resolve();failures=[]
def check(label,condition,detail=''):
 print(('PASS ' if condition else 'FAIL ')+label+' '+str(detail),flush=True)
 if not condition:failures.append(label)
srv=subprocess.Popen([sys.executable,'-m','http.server','8781','--bind','127.0.0.1','--directory',str(root)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
try:
 time.sleep(.4)
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,args=['--use-gl=angle','--use-angle=gl','--autoplay-policy=no-user-gesture-required']+(['--disable-webgl2'] if A.webgl1 else []))
  page=browser.new_page(viewport={'width':1920,'height':1200});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto('http://127.0.0.1:8781/')
  page.wait_for_function("window.SlopeMod && SlopeMod.log().some(l=>/heap \\(/.test(l))",timeout=120000)
  page.evaluate("()=>{SlopeShaders.setStyle('classic');SlopeMod.setStack(2);SlopeMod.setAutopilot(true)}")
  page.wait_for_timeout(500)
  dimensions=page.evaluate("()=>{const c=document.querySelector('canvas'),r=c.getBoundingClientRect();return {w:c.width,h:c.height,css:[r.width,r.height],q:SlopePerformance.stats()}}")
  check('title menu stays at native resolution',dimensions['w']==1920 and dimensions['css']==[1920,1200] and abs(dimensions['w']/dimensions['h']-1.6)<.01,dimensions)
  page.screenshot(path='/tmp/slope-perf-menu.png')
  im=Image.open('/tmp/slope-perf-menu.png').convert('RGB'); edges=[]
  for y in range(80,im.height-100):
   longest=run=0
   for x in range(im.width//4,3*im.width//4):
    r,g,b=im.getpixel((x,y));run=run+1 if g>180 and r<100 and b<100 else 0;longest=max(longest,run)
   if longest>im.width*.1 and (not edges or y-edges[-1]>3):edges.append(y)
  if len(edges)<4:raise RuntimeError('could not identify native menu button borders: '+str(edges))
  play_y=(edges[2]+edges[3])/2
  page.mouse.click(960,play_y,delay=100);page.wait_for_timeout(1500)
  check('native Play button accepts pointer input',page.evaluate('SlopeMod.stats().running'))
  if not page.evaluate('SlopeMod.stats().running'):page.keyboard.press('r');page.wait_for_timeout(2000)
  q=page.evaluate('SlopePerformance.stats()');check('playing activates automatic render budget',900<q['width']<1920,q)
  for mode in ['native','auto']:
   page.evaluate('m=>SlopePerformance.setMode(m)',mode)
   page.wait_for_timeout(800)
   d=page.evaluate("()=>{const c=document.querySelector('canvas');return {w:c.width,h:c.height,q:SlopePerformance.stats(),frames:SlopeMod.frame(),shader:SlopeShaders.stats()}}")
   check(mode+' changes render size',d['w']==1920 if mode=='native' else 900<d['w']<1920,d)
   check(mode+' keeps shader state valid',d['shader']['errors']==0 and d['shader']['failed']==0)
  page.evaluate('SlopeMod.setAutopilot(false)');x0=page.evaluate('SlopeCoins.ballPos()[0]')
  page.keyboard.down('ArrowRight');page.wait_for_timeout(250);page.keyboard.up('ArrowRight')
  x1=page.evaluate('SlopeCoins.ballPos()[0]');check('steering survives resolution switches',x1>x0+.02,(x0,x1))
  page.set_viewport_size({'width':800,'height':500});page.wait_for_timeout(200);page.evaluate("SlopePerformance.setMode('auto')");page.wait_for_timeout(600)
  size=page.evaluate("()=>[document.querySelector('canvas').width,document.querySelector('canvas').height]")
  check('window resize restores small native buffer',size==[800,500],size)
  page.evaluate("()=>{SlopeMod.setAutopilot(true);SlopeShaders.setLight('night');SlopeShaders.setStyle('neon')}");page.wait_for_timeout(700)
  audit=page.evaluate("()=>{const c=document.querySelector('canvas'),g=c.getContext('webgl2')||c.getContext('webgl');return {bad:SlopeGLState.audit(g),error:g.getError()}}")
  check('native state matches mirror after lit overlay passes',not audit['bad'] and not audit['error'],audit)
  page.keyboard.press('r');page.wait_for_timeout(2000)
  check('restart survives render-size changes',page.evaluate('SlopeMod.stats().running') and not errors,errors)
  browser.close()
finally:
 srv.terminate();srv.wait()
sys.exit(bool(failures))
