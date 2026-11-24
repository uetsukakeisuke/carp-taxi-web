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
DB='https://taxi-location-sharing-default-rtdb.asia-southeast1.firebasedatabase.app'
now=lambda: int(time.time()*1000)
stamp=time.strftime('%Y%m%d%H')
store={'taxi_locations':{'taxi_01':{'carNumber':'なにわ 530 う 226','isAvailable':True,'latitude':34.7040,'longitude':135.4930,'timestamp':now(),'userType':'driver'},
                         'old_car':{'isAvailable':True,'latitude':34.70,'longitude':135.49,'timestamp':now()-3600_000,'userType':'driver'}},
       'sos_alerts':{'taxi_07':{'carNumber':'なにわ 500 あ 1','latitude':34.7000,'longitude':135.4900,'timestamp':now(),'active':True}}}
grid={'34703_135492':{stamp:9},'34704_135492':{stamp:7},'34709_135501':{stamp:5},'34690_135480':{stamp:2},'37367_-122112':{stamp:50}}
writes=[]
def db(route):
    from urllib.parse import urlparse, unquote
    rq=route.request; path=unquote(urlparse(rq.url).path).strip('/').removesuffix('.json').split('/')
    if rq.method=='GET':
        if path[0]=='explore_nav_data': body=grid
        else:
            body=store
            for k in path: body=(body or {}).get(k) if isinstance(body,dict) else None
        return route.fulfill(status=200, content_type='application/json', body=json.dumps(body))
    writes.append((rq.method,'/'.join(path), json.loads(rq.post_data) if rq.post_data else None))
    if rq.method=='PUT': store.setdefault(path[0],{})[path[1]]=json.loads(rq.post_data)
    if rq.method=='DELETE': store.get(path[0],{}).pop(path[1],None)
    route.fulfill(status=200, content_type='application/json', body=rq.post_data or 'null')
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'])
    ctx=b.new_context(viewport={'width':390,'height':844}, geolocation={'latitude':34.6975,'longitude':135.4868,'accuracy':8}, permissions=['geolocation','camera','microphone'], locale='ja-JP')
    pg=ctx.new_page()
    pg.on('pageerror', lambda e: errors.append('pageerror: '+str(e)))
    pg.on('console', lambda m: errors.append('console: '+m.text) if m.type=='error' and 'navigator.vibrate' not in m.text else None)
    # 1) キー未設定 → 初期設定画面
    pg.goto('http://127.0.0.1:8765/'); pg.wait_for_selector('#sKey'); print('setup dialog OK')
    pg.screenshot(path='/tmp/shot_setup.png')
    # 2) 地図スタブで起動
    pg.add_init_script(path=os.path.join(ROOT,'tests','stub.js'))
    pg.route('https://routes.googleapis.com/**', lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps(routes)))
    ctx.route(DB+'/**', db)
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
    # 6) 車両コード未設定のあいだは位置を送らない → 設定すると旧アプリと同じ形式で送る
    pg.wait_for_timeout(600); assert not [w for w in writes if w[1].startswith('taxi_locations')], writes
    pg.click('#btnMenu'); pg.click('#sheet [data-a=code]'); pg.fill('#tVal','taxi_01'); pg.click('#dialogBox [data-a=ok]'); pg.wait_for_timeout(500)
    assert pg.evaluate('__app.cfg.code')=='', '使用中のコードを上書きしてはいけない'; print('code collision blocked OK')
    pg.fill('#tVal','taxi_99'); pg.click('#dialogBox [data-a=ok]'); pg.wait_for_function("__app.cfg.code==='taxi_99'"); pg.wait_for_timeout(500)
    w=[x for x in writes if x[1]=='taxi_locations/taxi_99'][-1]; print('position write:', w[0], sorted(w[2].keys()))
    assert w[0]=='PUT' and set(w[2])=={'carNumber','heading','isAvailable','latitude','longitude','timestamp','userType'} and w[2]['isAvailable'] is True and w[2]['userType']=='driver', w
    # 7) 近隣車両・SOS 通知・GPS 需要データを使った探索ナビ
    pg.reload(); pg.wait_for_function('window.__map && window.__app.state.me'); pg.wait_for_timeout(800)
    titles=pg.evaluate("__ov.filter(o=>o.map&&o.o.title).map(o=>o.o.title)"); print('markers:', titles)
    assert any('なにわ 530 う 226' in t and '空車' in t for t in titles) and any(t.startswith('SOS') for t in titles) and not any('old_car' in t for t in titles), titles
    pg.click('#btnExplore'); pg.wait_for_selector('#sheet .routebox'); ex=pg.inner_text('#sheet'); print('explore:', ex.replace('\n',' | ')[:230])
    assert '1台' in ex and '📡' in ex and '5箇所' in ex, ex
    pg.screenshot(path='/tmp/shot_explore.png'); pg.click('#sheet [data-a=x]')
    # 8) お客様用 QR と位置の非公開
    pg.click('#btnMenu'); pg.click('#sheet [data-a=qr]'); pg.wait_for_selector('#dialogBox .qr svg'); qr=pg.inner_text('#dialogBox .addr'); print('qr url:', qr)
    assert qr=='http://127.0.0.1:8765/view.html?c=taxi_99', qr
    pg.screenshot(path='/tmp/shot_qr.png'); pg.click('#dialogBox [data-a=close]')
    pg.click('label.private'); pg.wait_for_timeout(400); assert ('DELETE','taxi_locations/taxi_99',None) in writes; n=len(writes)
    pg.evaluate('p=>__app.onPos(p)', {'lat':34.6990,'lng':135.4900,'acc':8,'spd':5,'hdg':0,'t':0}); pg.wait_for_timeout(400)
    assert not [x for x in writes[n:] if x[1].startswith('taxi_locations')], '非公開中は送らない'; print('private OK')
    pg.click('label.private'); pg.wait_for_timeout(400)
    # 9) S 長押し → 録画・周囲へ通知 → 解除 → 一覧
    box=pg.locator('#btnS').bounding_box(); pg.mouse.move(box['x']+40,box['y']+40); pg.mouse.down(); pg.wait_for_function('!!window.__app.state.sos',timeout=4000); pg.mouse.up(); pg.wait_for_timeout(300)
    a=[x for x in writes if x[1]=='sos_alerts/taxi_99']; assert a and a[-1][0]=='PUT' and a[-1][2]['active'] is True, a
    pg.wait_for_timeout(3500); pg.mouse.down(); pg.wait_for_function('!window.__app.state.sos',timeout=4000); pg.mouse.up(); pg.wait_for_timeout(800)
    assert [x for x in writes if x[1]=='sos_alerts/taxi_99'][-1][0]=='DELETE'; print('sos alert OK')
    pg.click('#btnMenu'); pg.screenshot(path='/tmp/shot_menu.png'); pg.click('#sheet [data-a=sos]'); pg.wait_for_selector('#sheet .list'); print('sos list:', pg.inner_text('#sheet .list').split('\n')[1])
    pg.click('#sheet [data-a=x]')
    # 10) メニューの残り
    for a in ('stats','ic','legend','traffic','set'):
        pg.click('#btnMenu'); pg.click(f'#sheet [data-a={a}]'); pg.wait_for_timeout(150)
        if a=='stats': pg.click('#sheet [data-a=x]')
        if a=='set': pg.click('#dialogBox [data-a=close]')
    pg.click('#btnMenu'); pg.click('#sheet [data-a=legend]'); pg.wait_for_timeout(200); pg.screenshot(path='/tmp/shot_main.png')
    # 設定リンク：キー・車両コード・ナンバーが保存され、URL からは消える
    s2=b.new_context(viewport={'width':390,'height':844}, geolocation={'latitude':34.6975,'longitude':135.4868,'accuracy':8}, permissions=['geolocation'], locale='ja-JP')
    s2.route(DB+'/**', db); l=s2.new_page(); l.add_init_script(path=os.path.join(ROOT,'tests','stub.js'))
    l.goto('http://127.0.0.1:8765/?key=TESTKEY&code=taxi_55&plate=%E3%81%AA%E3%81%AB%E3%82%8F%20530'); l.wait_for_function('window.__map && window.__app.state.me')
    got=l.evaluate('[__app.cfg.key, __app.cfg.code, __app.cfg.plate, location.search, document.querySelector("#plateText").textContent]'); print('setup link:', got)
    assert got==['TESTKEY','taxi_55','なにわ 530','','なにわ 530'], got; s2.close()
    # 11) お客様用ページ
    v=ctx.new_page(); v.on('pageerror', lambda e: errors.append('view pageerror: '+str(e)))
    v.route('https://tile.openstreetmap.org/**', lambda r: r.abort())
    v.goto('http://127.0.0.1:8765/view.html?c=taxi_01'); v.wait_for_function("document.querySelector('#badge').textContent.includes('空')")
    print('view:', v.inner_text('#card').replace('\n',' | ')); assert 'なにわ 530 う 226' in v.inner_text('#card'); v.screenshot(path='/tmp/shot_view.png')
    v.goto('http://127.0.0.1:8765/view.html?c=nobody'); v.wait_for_function("document.querySelector('#when').textContent.includes('公開されていません')"); print('view hidden OK')
    b.close()
print('ERRORS:', errors if errors else 'none')
sys.exit(1 if errors else 0)
