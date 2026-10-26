"""Real-player regression for Mod Menu, independent themes and saved settings.
Serve this repo, then run: python tools/menu_check.py [--url http://127.0.0.1:8769/]
"""
import argparse
from playwright.sync_api import sync_playwright

ap=argparse.ArgumentParser(description=__doc__)
ap.add_argument('--url',default='http://127.0.0.1:8769/')
a=ap.parse_args()
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,args=['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--autoplay-policy=no-user-gesture-required'])
    page=browser.new_page(viewport={'width':960,'height':600})
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(a.url)
    page.wait_for_function("window.SlopeMod && SlopeMod.log().some(l=>/heap \\(/.test(l))",timeout=90000)
    page.wait_for_selector('#mod-options #hud-version',state='attached')
    assert not page.locator('#mod-menu').is_visible()
    page.locator('#mod-menu-button').click()
    assert page.locator('#mod-menu').is_visible()
    for ident in ['hud-stack','hud-style','hud-fx','hud-light','hud-music','hud-gravity','hud-mort','hud-julien','hud-version','hud-fs']:
        assert page.locator('#mod-menu #'+ident).is_visible(), ident
    print('PASS every option is visible inside Mod Menu',flush=True)
    page.evaluate("window.menuKeys=0;window.addEventListener('keydown',()=>menuKeys++,true)")
    page.locator('#hud-mort').focus();page.keyboard.press('Space')
    assert page.locator('#hud-mort').is_checked() and page.evaluate('SlopeMod.mort()')
    assert page.evaluate('menuKeys')==0
    page.locator('#hud-julien').check()
    assert page.evaluate('SlopeMod.julien()')
    # Cache actual native pointers and the live variable address once.
    page.evaluate("""() => {
        window.buildingThemes=Object.fromEntries(['Flat','Zombie','Mort'].map(name=>[name,SlopeMod.fsmGetInt('ModBuilding'+name)[0][1]]));
        window.buildingAddress=SlopeMod.fsmGetInt('ModBuilding')[0][0];
    }""")
    def native_theme(name):
        page.wait_for_function("name=>gameInstance.Module.HEAPU32[(buildingAddress+24)>>2]===buildingThemes[name]",arg=name)
    native_theme('Mort')
    for music in ['aria','billie','sax','original']:
        page.locator('#hud-music').select_option(music)
        assert page.evaluate('SlopeMod.mort() && SlopeMod.julien()')
        native_theme('Mort')
    page.locator('#hud-mort').uncheck();native_theme('Flat')
    page.locator('#hud-music').select_option('aria');native_theme('Zombie')
    assert page.evaluate('SlopeMod.julien()')
    print('PASS Mort native prefab and independent theme switches across all music selections',flush=True)
    page.locator('#hud-mort').check()
    page.locator('#hud-julien').focus();page.keyboard.press('Escape')
    assert not page.locator('#mod-menu').is_visible()
    assert page.locator('#mod-menu-button').get_attribute('aria-expanded')=='false'
    assert page.locator('#mod-menu-button').evaluate('e=>document.activeElement===e')
    page.keyboard.press('ArrowLeft')
    assert page.evaluate('menuKeys')==1, 'closed menu button must pass steering to Unity'
    page.reload()
    page.wait_for_function('window.SlopeMod && SlopeMod.mort() && SlopeMod.julien()')
    page.locator('#mod-menu-button').click()
    assert page.locator('#hud-mort').is_checked() and page.locator('#hud-julien').is_checked()
    print('PASS theme preferences survive reload; Escape closes and restores focus',flush=True)
    page.set_viewport_size({'width':375,'height':667})
    box=page.locator('#mod-menu').bounding_box()
    assert box['x']>=0 and box['x']+box['width']<=375 and box['height']<=667
    assert page.locator('#hud-mort').is_visible() and page.locator('#hud-julien').is_visible()
    page.screenshot(path='/tmp/slope-mod-menu-mobile.png')
    page.locator('#mod-menu-close').click()
    page.locator('#mod-menu-button').press('Enter')
    assert page.locator('#mod-menu').is_visible()
    assert page.locator('#mod-menu-button').get_attribute('aria-expanded')=='true'
    print('PASS mobile menu fits, labels/toggles remain visible, keyboard reopening works',flush=True)
    assert not errors, errors
    print('PASS no page errors',flush=True)
    browser.close()
