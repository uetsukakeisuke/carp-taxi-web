import json, sys, threading, http.server, functools, time
from playwright.sync_api import sync_playwright
import os
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
srv=http.server.ThreadingHTTPServer(('127.0.0.1',8765), functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT))
threading.Thread(target=srv.serve_forever, daemon=True).start()
def enc(pts):
    out=''; pl=pg=0
    for la,ln in pts:
        for v,p in ((round(la*1e5),pl),(round(ln*1e5),pg)):
            d=v-p; d=~(d<<1) if d<0 else d<<1
            while d>=0x20: out+=chr((0x20|(d&0x1f))+63); d>>=5
            out+=chr(d+63)
        pl,pg=round(la*1e5),round(ln*1e5)
    return out
# 東へ約1km → 北へ約1km の経路（左折1回）
path=[(34.6975,135.4868+i*0.0011) for i in range(11)]+[(34.6975+i*0.0009,135.4978) for i in range(1,11)]
routes={"routes":[{"duration":"600s","distanceMeters":2000,"description":"国道2号","polyline":{"encodedPolyline":enc(path)},
 "legs":[{"steps":[{"distanceMeters":1000,"navigationInstruction":{"maneuver":"DEPART","instructions":"東に進む"}},
                   {"distanceMeters":1000,"navigationInstruction":{"maneuver":"TURN_LEFT","instructions":"左折して なにわ筋 に入る"}}]}]}]}
errors=[]
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'])
    ctx=b.new_context(viewport={'width':390,'height':844}, geolocation={'latitude':34.6975,'longitude':135.4868,'accuracy':8}, permissions=['geolocation','camera','microphone'], locale='ja-JP')
    pg=ctx.new_page()
    pg.on('pageerror', lambda e: errors.append('pageerror: '+str(e)))
    pg.on('console', lambda m: errors.append('console: '+m.text) if m.type=='error' else None)
    # 1) キー未設定 → 初期設定画面
    pg.goto('http://127.0.0.1:8765/'); pg.wait_for_selector('#sKey'); print('setup dialog OK')
    pg.screenshot(path='/tmp/shot_setup.png')
    # 2) 地図スタブで起動
    pg.add_init_script(path=os.path.join(ROOT,'tests','stub.js'))
    pg.route('https://routes.googleapis.com/**', lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps(routes)))
    pg.goto('http://127.0.0.1:8765/'); pg.wait_for_function('window.__map && window.__app.state.me')
    print('boot OK, me =', pg.evaluate('JSON.stringify([__app.state.me.lat, __app.state.me.acc])'))
    # 3) 乗車 → 走行 → 降車
    pg.click('#btnStatus'); pg.wait_for_function('!!window.__app.state.trip')
    assert 'occupied' in pg.get_attribute('#btnStatus','class')
    t0=int(time.time()*1000)
    for i,(la,ln) in enumerate(path[1:]):
        pg.evaluate('p=>__app.onPos(p)', {'lat':la,'lng':ln,'acc':8,'spd':10,'hdg':90 if i<10 else 0,'t':t0+i*3000})
    npts=pg.evaluate('__app.state.trip.pts.length'); print('trip points', npts); assert npts>=20
    pg.reload(); pg.wait_for_function('!!window.__app.state.trip'); print('trip survives reload OK')   # 実車中の再読み込み
    ctx.set_geolocation({'latitude':path[-1][0],'longitude':path[-1][1],'accuracy':6})
    pg.wait_for_function('window.__app.state.me && Math.abs(__app.state.me.lat-%f)<1e-6' % path[-1][0])
    pg.click('#btnStatus'); pg.wait_for_function('!window.__app.state.trip'); pg.wait_for_selector('#sheet:not([hidden])')
    txt=pg.inner_text('#sheet'); print('trip sheet:', ' / '.join(txt.split('\n')[:6])); assert '左折' in txt and '乗車' in txt and '降車' in txt
    pg.screenshot(path='/tmp/shot_trip.png'); pg.click('#sheet [data-a=x]')
    # 4) 地図タップ → ピン → 配車記録（上客）
    pg.evaluate('window.__map.h.click({latLng:new google.maps.LatLng(34.7025,135.4959)})'); pg.wait_for_selector('#pinBar:not([hidden])')
    pg.click('#pinBar [data-a=rec]'); pg.click('#dialogBox [data-v=vip]'); pg.click('#dialogBox [data-v="遠距離"]'); pg.screenshot(path='/tmp/shot_record.png'); pg.click('#dialogBox [data-a=ok]')
    r=pg.evaluate('JSON.stringify(__app.state.records)'); rec=json.loads(r); assert len(rec)==1 and rec[0]['type']=='vip' and rec[0]['reasons']==['遠距離'] and '福島' in rec[0]['address'], r
    print('record OK:', rec[0]['address'], rec[0]['time'])
    # 5) 検索 → ルート → ナビ
    ctx.set_geolocation({'latitude':path[0][0],'longitude':path[0][1],'accuracy':8}); pg.wait_for_function('Math.abs(__app.state.me.lng-%f)<1e-6' % path[0][1])
    pg.fill('#q','大阪駅'); pg.press('#q','Enter'); pg.wait_for_selector('#results [data-i]'); pg.click('#results [data-i="0"]')
    pg.wait_for_selector('#pinBar:not([hidden])'); pg.click('#pinBar [data-a=nav]'); pg.wait_for_selector('#sheet [data-a=go]')
    print('route sheet:', pg.inner_text('#sheet .alt').replace('\n',' | ')); pg.screenshot(path='/tmp/shot_route.png')
    pg.click('#sheet [data-a=go]'); pg.wait_for_function('!!window.__app.state.nav')
    pg.evaluate('p=>__app.onPos(p)', {'lat':34.6975,'lng':135.4868+0.0011*8,'acc':8,'spd':11,'hdg':90,'t':t0})   # 曲がり角の約220m手前
    nt=[pg.inner_text(s) for s in ('#navArrow','#navDist','#navText','#navRemD','#navSpeed b')]; print('nav banner:', nt)
    assert nt[0]=='↰' and nt[2].startswith('左折') and nt[4]=='40', nt
    pg.screenshot(path='/tmp/shot_nav.png')
    pg.evaluate('p=>__app.onPos(p)', {'lat':path[-1][0]-0.0001,'lng':path[-1][1],'acc':8,'spd':3,'hdg':0,'t':t0})    # 目的地の約11m手前
    pg.wait_for_function('!window.__app.state.nav'); print('arrival OK')
    # 6) 探索ナビ
    pg.click('#btnExplore'); pg.wait_for_selector('#sheet .routebox'); print('explore:', pg.inner_text('#sheet .routebox').replace('\n',' | ')); pg.screenshot(path='/tmp/shot_explore.png'); pg.click('#sheet [data-a=x]')
    # 7) S 長押し → 録画 → 解除 → 一覧
    box=pg.locator('#btnS').bounding_box(); pg.mouse.move(box['x']+40,box['y']+40); pg.mouse.down(); pg.wait_for_function('!!window.__app.state.sos',timeout=4000); pg.mouse.up()
    pg.wait_for_timeout(3500); pg.mouse.down(); pg.wait_for_function('!window.__app.state.sos',timeout=4000); pg.mouse.up(); pg.wait_for_timeout(800)
    pg.click('#btnMenu'); pg.screenshot(path='/tmp/shot_menu.png'); pg.click('#sheet [data-a=sos]'); pg.wait_for_selector('#sheet .list'); print('sos list:', pg.inner_text('#sheet .list').split('\n')[1])
    pg.click('#sheet [data-a=x]')
    # 8) メニューの残り
    for a in ('stats','ic','legend','traffic','set'):
        pg.click('#btnMenu'); pg.click(f'#sheet [data-a={a}]'); pg.wait_for_timeout(150)
        if a=='stats': pg.click('#sheet [data-a=x]')
        if a=='set': pg.click('#dialogBox [data-a=close]')
    pg.click('#btnMenu'); pg.click('#sheet [data-a=legend]'); pg.wait_for_timeout(200); pg.screenshot(path='/tmp/shot_main.png')
    b.close()
print('ERRORS:', errors if errors else 'none')
sys.exit(1 if errors else 0)
