import * as L from './logic.js';
import { IC_SECTIONS } from './ic.js';
import { DB_URL, makeCloud, validKey } from './cloud.js';

// ============ 共通 ============
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = {
  get(k, d) { try { const v = localStorage.getItem('taxi.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('taxi.' + k, JSON.stringify(v)); } catch (e) { console.warn('保存失敗', e); } },
};
const db = (() => { // 走行ルートと SOS 録画は容量が大きいので IndexedDB に置く
  let p;
  const open = () => p ||= new Promise((res, rej) => {
    const r = indexedDB.open('carp-taxi', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('trips', { keyPath: 'id' }); r.result.createObjectStore('videos', { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const tx = async (s, mode, fn) => { const d = await open(); return new Promise((res, rej) => { const t = d.transaction(s, mode); const q = fn(t.objectStore(s)); t.oncomplete = () => res(q?.result); t.onerror = () => rej(t.error); }); };
  return { put: (s, v) => tx(s, 'readwrite', o => o.put(v)), all: s => tx(s, 'readonly', o => o.getAll()), del: (s, id) => tx(s, 'readwrite', o => o.delete(id)) };
})();

const cfg = Object.assign({ key: '', mapId: '', plate: '', code: '', priv: false, avoidTolls: false, avoidHighways: false, voice: true, legend: true, ic: false, traffic: false, icEdit: false, dbUrl: '', deviceId: '' }, ls.get('cfg', {}));
const saveCfg = () => ls.set('cfg', cfg);
if (!cfg.deviceId) { cfg.deviceId = 'web_' + Math.random().toString(36).slice(2, 10); saveCfg(); }
let records = ls.get('records', []);
const saveRecords = () => ls.set('records', records);

let G, map, me = null, heading = 0, follow = true, pickResolve = null;
const ll = x => typeof x.lat === 'function' ? { lat: x.lat(), lng: x.lng() } : { lat: x.lat, lng: x.lng };
const hm = t => new Date(t).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
const hms = t => new Date(t).toLocaleTimeString('ja-JP');
const md = t => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };

// タブレット横向きでは画面類を左側に出すので、地図の表示範囲もそれを避ける
const wide = () => matchMedia('(orientation:landscape) and (min-width:900px) and (min-height:540px)').matches;
const viewPad = bottom => wide() ? { top: 90, bottom: 40, left: 480, right: 210 } : { top: 150, bottom, left: 40, right: 40 };
let toastTm;
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTm); toastTm = setTimeout(() => t.hidden = true, ms); }
function dialog(html, handlers = {}) {
  const b = $('#dialogBox'); b.innerHTML = html; $('#dialog').hidden = false;
  b.onclick = e => { const t = e.target.closest('[data-a]'); if (t) (handlers[t.dataset.a] || (t.dataset.a === 'close' ? closeDialog : null))?.(t); };
  return b;
}
const closeDialog = () => { $('#dialog').hidden = true; $('#dialogBox').innerHTML = ''; };
let sheetClose = null;
function sheet(title, html, handlers = {}, onClose = null, small = false) {
  const s = $('#sheet'); closeSheet();
  s.className = 'sheet' + (small ? ' small' : '');
  s.innerHTML = `<h2><span>${title}</span><button data-a="x">✕</button></h2>${html}`; s.hidden = false; sheetClose = onClose;
  s.onclick = e => { const t = e.target.closest('[data-a]'); if (!t) return; if (t.dataset.a === 'x') closeSheet(); else handlers[t.dataset.a]?.(t); };
  return s;
}
function closeSheet() { const f = sheetClose; sheetClose = null; $('#sheet').hidden = true; f?.(); }
function download(name, data, type = 'text/plain') {
  const a = document.createElement('a'); a.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type })); a.download = name;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
let wl; async function wake() { try { wl = await navigator.wakeLock?.request('screen'); } catch { } } // 画面を消さない
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
document.addEventListener('click', wake, { once: true });
function speak(text) {
  if (!cfg.voice || !window.speechSynthesis) return;
  try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = 'ja-JP'; u.rate = 1.05; speechSynthesis.speak(u); } catch { }
}

// ============ 初期設定と地図の読み込み ============
function showSetup(msg = '') {
  dialog(`<h2>初期設定</h2>${msg ? `<p style="color:#c62828">${esc(msg)}</p>` : ''}
    <p style="font-size:14px;color:#555">Google Maps の API キーを入力してください。この端末だけに保存され、次回からは不要です。</p>
    <label>Google Maps API キー</label><input id="sKey" type="text" value="${esc(cfg.key)}" autocapitalize="off" autocomplete="off">
    <label>マップ ID（任意・空欄で可）</label><input id="sMap" type="text" value="${esc(cfg.mapId)}" autocapitalize="off">
    <div class="actions"><button class="btn orange" data-a="ok">保存して開始</button></div>`, {
    ok() { cfg.key = $('#sKey').value.trim(); cfg.mapId = $('#sMap').value.trim(); if (!cfg.key) return toast('API キーを入力してください'); saveCfg(); location.reload(); },
  });
}
function loadMaps(key) {
  if (window.google?.maps) return Promise.resolve();
  return new Promise((res, rej) => {
    window.__gmReady = res;
    window.gm_authFailure = () => showSetup('API キーが無効か、このサイトからの利用が許可されていません。');
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&language=ja&region=JP&libraries=geometry,places&loading=async&callback=__gmReady`;
    s.onerror = () => rej(new Error('地図を読み込めませんでした'));
    document.head.append(s);
  });
}
// 設定リンク：URL に ?key=…&code=…&plate=… を付けて開くと、その内容を端末に保存する。
// 利用者が API キーや車両コードを手で入力しなくて済むようにするためのもの。保存後は URL から消す。
function applySetupLink() {
  const q = new URLSearchParams(location.search); let changed = false;
  for (const [param, field] of [['key', 'key'], ['code', 'code'], ['plate', 'plate']]) {
    const v = (q.get(param) || '').trim(); if (!v) continue;
    if (param === 'code' && !validKey(v)) continue;
    cfg[field] = v; changed = true;
  }
  if (changed) { saveCfg(); history.replaceState(null, '', location.pathname); }
}
async function boot() {
  applySetupLink();
  if (!cfg.key && !window.google?.maps) return showSetup();
  try { await loadMaps(cfg.key); } catch (e) { return showSetup(e.message); }
  G = google.maps;
  map = new G.Map($('#map'), {
    center: ls.get('last', { lat: 34.6975, lng: 135.4868 }), zoom: 16, mapId: cfg.mapId || 'DEMO_MAP_ID',
    renderingType: G.RenderingType?.VECTOR, disableDefaultUI: true, gestureHandling: 'greedy', clickableIcons: false,
  });
  initUi(); startGeo(); renderRecords(); if (cfg.ic) drawIc(); if (cfg.traffic) setTraffic(true);
  restoreTrip(); startCloud();
}

// ============ 現在地 ============
let meMarker, accCircle;
const toP = g => ({ lat: g.coords.latitude, lng: g.coords.longitude, acc: g.coords.accuracy, spd: g.coords.speed, hdg: g.coords.heading, t: Date.now() });
function startGeo() {
  if (!navigator.geolocation) return toast('この端末では位置情報が使えません');
  navigator.geolocation.watchPosition(g => onPos(toP(g)), e => { if (e.code === 1) toast('位置情報の利用を許可してください', 5000); }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
}
function onPos(p) {
  if (p.spd > 1.5 && Number.isFinite(p.hdg)) heading = p.hdg;
  else if (me && L.haversine(me, p) > 6) heading = L.bearing(me, p);
  me = p; ls.set('last', { lat: p.lat, lng: p.lng });
  const icon = { path: G.SymbolPath.FORWARD_CLOSED_ARROW, scale: 6, fillColor: '#1e88e5', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2, rotation: heading - (map.getHeading?.() || 0) };
  if (!meMarker) {
    meMarker = new G.Marker({ map, position: p, icon, zIndex: 999, clickable: false });
    accCircle = new G.Circle({ map, center: p, radius: p.acc || 0, strokeWeight: 0, fillColor: '#1e88e5', fillOpacity: .12, clickable: false });
    map.setCenter(p);
  } else { meMarker.setPosition(p); meMarker.setIcon(icon); accCircle.setCenter(p); accCircle.setRadius(Math.min(p.acc || 0, 200)); }
  trackTrip(p); trackSos(p); sendPosition();
  if (nav) navUpdate(p); else if (follow) map.panTo(p);
}
// ボタンを押した瞬間の、できるだけ正確な位置を取る（精度 15m 以内が出るか最長 6 秒待つ）
function preciseFix(ms = 6000, want = 15) {
  return new Promise(res => {
    // 新しい測位が来なければ、直近に取れていた位置を使う（Wi-Fi 測位のパソコンなどは位置が更新されないため）
    let best = me;
    if (best && Date.now() - best.t < 3000 && best.acc <= want || !navigator.geolocation) return res(best);
    let id; const done = () => { navigator.geolocation.clearWatch(id); clearTimeout(tm); res(best); };
    const tm = setTimeout(done, ms);
    id = navigator.geolocation.watchPosition(g => { const p = toP(g); if (!best || p.acc <= best.acc || p.t - best.t > 3000) best = p; if (p.acc <= want) done(); }, () => { }, { enableHighAccuracy: true, maximumAge: 0 });
  });
}
async function revGeo(p) {
  try { const { results } = await new G.Geocoder().geocode({ location: { lat: p.lat, lng: p.lng }, language: 'ja' }); return cleanAddr(results[0]?.formatted_address); } catch { return ''; }
}
const cleanAddr = a => String(a || '').replace(/^日本、\s*/, '').replace(/〒\d{3}-\d{4}\s*/, '');

// ============ 乗車・降車と走行ルートの記録 ============
let trip = null, tripLine = null, tripOverlays = [];
// メーターと同じ並びの 3 ボタン：空車 → 実車（乗車を記録）→ 支払（降車を記録）→ 空車
let meter = 'vacant', meterBusy = false;
function setStatusUi() {
  document.querySelectorAll('#meter [data-m]').forEach(b => b.classList.toggle('on', b.dataset.m === meter));
  $('#tripBar').hidden = !trip;
}
function restoreTrip() { // 途中で画面を閉じても、実車中の記録を引き継ぐ
  trip = ls.get('activeTrip', null); meter = trip ? 'occupied' : ls.get('meter', 'vacant') === 'pay' ? 'pay' : 'vacant'; setStatusUi();
  if (trip) { tripLine = new G.Polyline({ map, path: trip.pts, strokeColor: '#fb8c00', strokeWeight: 5, strokeOpacity: .9 }); updateTripBar(); }
}
async function measure() {
  toast('位置を測定中…', 6500);
  const fix = await preciseFix();
  if (!fix) { toast('現在地が取得できません。位置情報の許可を確認してください', 5000); return null; }
  return { ...fix, t: Date.now() }; // 記録する時刻は、位置が測られた時刻ではなくボタンを押した時刻にする
}
async function board() { // 乗車：押した時点の位置を記録し、走行ルートの記録を始める
  const fix = await measure(); if (!fix) return false;
  trip = { id: 't' + Date.now(), start: { ...fix, address: '' }, pts: [fix], end: null };
  tripLine = new G.Polyline({ map, path: [fix], strokeColor: '#fb8c00', strokeWeight: 5, strokeOpacity: .9 });
  ls.set('activeTrip', trip); updateTripBar();
  toast(`乗車を記録しました（${hm(fix.t)}・精度 約${Math.round(fix.acc)}m）`);
  const t = trip; revGeo(fix).then(a => { t.start.address = a; if (trip === t) ls.set('activeTrip', t); });
  return true;
}
async function alight() { // 降車：押した時点の位置を記録し、走行ルートを保存する
  const fix = await measure(); if (!fix) return false;
  const t = trip; t.pts.push(fix); t.end = { ...fix, address: '' };
  t.events = L.detectTurns(t.pts); t.dist = L.pathDistance(t.pts);
  trip = null; ls.set('activeTrip', null); tripLine?.setMap(null); tripLine = null;
  await db.put('trips', t);
  toast(`降車を記録しました（${hm(fix.t)}・${L.fmtDist(t.dist)}）。メニューの「乗車記録」で確認できます`, 4000);
  revGeo(fix).then(a => { t.end.address = a; db.put('trips', t); });
  return true;
}
async function pressMeter(to) {
  if (meterBusy || to === meter) return;
  if (to === 'pay' && !trip) return toast('「支払」は実車のときに押してください');
  meterBusy = true; $('#meter').classList.add('busy');
  try {
    if (to === 'occupied') { if (!await board()) return; }
    else if (trip && !await alight()) return;      // 実車から「支払」または「空車」を押したら降車を記録
    meter = to; ls.set('meter', meter); setStatusUi(); sendPosition(true);
  } finally { meterBusy = false; $('#meter').classList.remove('busy'); }
}
function trackTrip(p) {
  if (!trip) return;
  if (L.acceptPoint(trip.pts[trip.pts.length - 1], p)) {
    trip.pts.push({ lat: p.lat, lng: p.lng, acc: p.acc, t: p.t }); tripLine?.getPath().push(new G.LatLng(p.lat, p.lng));
    if (trip.pts.length % 10 === 0) ls.set('activeTrip', trip);
  }
  updateTripBar();
}
function updateTripBar() {
  if (!trip) return;
  $('#tripBar').textContent = `実車中 ${hm(trip.start.t)}〜　${L.fmtDur((Date.now() - trip.start.t) / 1000)}　${L.fmtDist(L.pathDistance(trip.pts))}　ルート記録中`;
}
function clearTripOverlays() { tripOverlays.forEach(o => o.setMap(null)); tripOverlays = []; }
function drawLog(t, color = '#fb8c00') { // 走行ルートと通過時刻のマーカーを地図に描く
  clearTripOverlays(); const iw = new G.InfoWindow();
  tripOverlays.push(new G.Polyline({ map, path: t.pts, strokeColor: color, strokeWeight: 5, strokeOpacity: .9 }));
  const mk = (pos, label, text, c) => {
    const m = new G.Marker({ map, position: pos, label: label ? { text: label, color: '#fff', fontWeight: '700' } : undefined, icon: { path: G.SymbolPath.CIRCLE, scale: label ? 11 : 5, fillColor: c, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 }, zIndex: label ? 50 : 40 });
    m.addListener('click', () => { iw.setContent(`<b>${esc(text)}</b>`); iw.open({ map, anchor: m }); }); tripOverlays.push(m);
  };
  mk(t.pts[0], '乗', `${hms(t.pts[0].t)} 開始`, '#43a047');
  (t.events || []).forEach(e => mk(e, '', `${hms(e.t)} ${e.dir}`, '#333'));
  const last = t.pts[t.pts.length - 1]; mk(last, '降', `${hms(last.t)} 終了`, '#e53935');
  const bd = new G.LatLngBounds(); t.pts.forEach(p => bd.extend(p)); follow = false; setFollowUi(); map.fitBounds(bd, viewPad(260));
}
function showTrip(t) {
  drawLog(t);
  const ev = (t.events || []).map(e => `<div><small>${hms(e.t)}</small>　${e.dir}</div>`).join('');
  sheet('乗車記録', `<div class="list"><div><b>乗車 ${hms(t.start.t)}</b><small>${esc(t.start.address)}（精度 約${Math.round(t.start.acc || 0)}m）</small></div>
    <div><b>降車 ${hms(t.end.t)}</b><small>${esc(t.end.address)}（精度 約${Math.round(t.end.acc || 0)}m）</small></div>
    <div><b>${L.fmtDist(t.dist || 0)}・${L.fmtDur((t.end.t - t.start.t) / 1000)}</b><small>曲がり角 ${(t.events || []).length} か所（地図の点をタップすると通過時刻）</small></div>${ev ? `<div>${ev}</div>` : ''}</div>
    <div class="row"><button class="btn" data-a="csv">CSV で保存</button><button class="btn red" data-a="del">削除</button></div>`, {
    csv() { download(`trip_${t.id}.csv`, '時刻,緯度,経度,精度m\n' + t.pts.map(p => `${new Date(p.t).toISOString()},${p.lat},${p.lng},${Math.round(p.acc || 0)}`).join('\n'), 'text/csv'); },
    async del() { await db.del('trips', t.id); closeSheet(); toast('削除しました'); },
  }, clearTripOverlays, true);
}
async function showTripList() {
  const all = (await db.all('trips')).sort((a, b) => b.start.t - a.start.t);
  sheet('乗車記録（走行ルート）', all.length ? `<div class="list">${all.map(t => `<button data-a="open" data-id="${t.id}"><b>${md(t.start.t)} ${hm(t.start.t)} → ${hm(t.end.t)}　${L.fmtDist(t.dist || 0)}</b><small>${esc(t.start.address)} → ${esc(t.end.address)}</small></button>`).join('')}</div>` : '<p>まだ記録がありません。「実車」を押してから「支払」（または「空車」）を押すと保存されます。</p>',
    { open(b) { showTrip(all.find(t => t.id === b.dataset.id)); } });
}

// ============ 配車記録と統計オーバーレイ ============
let recOverlays = [], sliderMin = 0, live = true;
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const svgIcon = (svg, s, lo) => ({ url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg), scaledSize: new G.Size(s, s), anchor: new G.Point(s / 2, s / 2), labelOrigin: new G.Point(s / 2, lo) });
const RAINBOW = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48">${['#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa'].map((c, i) => `<circle cx="24" cy="24" r="${22 - i * 3.2}" fill="none" stroke="${c}" stroke-width="3.4"/>`).join('')}<circle cx="24" cy="24" r="3" fill="#fff"/></svg>`;
const NGICON = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="16" fill="#111" stroke="#fdd835" stroke-width="5"/><text x="20" y="27" text-anchor="middle" font-size="20" font-weight="700" fill="#fdd835">!</text></svg>`;
function renderRecords() {
  recOverlays.forEach(o => o.setMap(null)); recOverlays = [];
  document.body.classList.toggle('nolegend', !cfg.legend);
  if (!cfg.legend || !map) return;
  const dow = $('#dowSel').value;
  for (const r of records) {
    if (dow !== '' && r.dow !== +dow) continue;
    const lv = L.diffLevel(L.timeDiffMin(r.time, sliderMin));
    recOverlays.push(new G.Circle({ map, center: r, radius: 30, strokeColor: lv.color, strokeWeight: 1, fillColor: lv.color, fillOpacity: .22, clickable: false }));
    const special = r.type !== 'normal';
    const m = new G.Marker({
      map, position: r, zIndex: special ? 30 : 10,
      icon: r.type === 'vip' ? svgIcon(RAINBOW, 48, -8) : r.type === 'ng' ? svgIcon(NGICON, 40, -8) : { path: G.SymbolPath.CIRCLE, scale: 6, fillColor: lv.color, fillOpacity: .9, strokeColor: '#fff', strokeWeight: 1.5 },
      label: special ? { text: `${md(r.createdAt)} ${r.time}`, fontSize: '11px', fontWeight: '700', color: '#111' } : undefined, // 上客・危険客だけ日時を出す
    });
    m.addListener('click', () => showRecord(r)); recOverlays.push(m);
  }
}
function setSlider(min, isLive) {
  sliderMin = min; live = isLive; $('#slider').value = min; $('#clock').textContent = L.minToHhmm(min);
  $('#btnLive').classList.toggle('on', live); renderRecords();
}
const VIP_REASONS = ['文句言わない', '優しい', '遠距離', '定期的な利用ありそう', '降車地がわかりやすい', 'その他'];
const NG_REASONS = ['態度が悪い', '泥酔', '料金トラブル', '近距離', '車内を汚す', 'その他'];
const AGES = ['不明', '10代', '20代', '30代', '40代', '50代', '60代', '70代以上'];
function addRecordDialog(pos, address, draft = {}) {
  const d = Object.assign({ time: L.minToHhmm(nowMin()), type: 'normal', reasons: [], age: '不明', memo: '', drop: null }, draft);
  const draw = () => {
    const reasons = d.type === 'vip' ? VIP_REASONS : d.type === 'ng' ? NG_REASONS : [];
    dialog(`<h2>配車記録を追加</h2><div class="addr">📍 ${esc(address) || `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}`}</div>
      <label>時刻（GOが鳴った時間）</label><input id="rTime" type="time" value="${d.time}">
      <label>お客様の種別</label><div class="tags">${[['normal', '通常'], ['vip', '★ 上客'], ['ng', '⚠ 危険客']].map(([k, t]) => `<button data-a="type" data-v="${k}" class="${d.type === k ? 'on' : ''}">${t}</button>`).join('')}</div>
      ${reasons.length ? `<label>理由（押して選択）</label><div class="tags">${reasons.map(t => `<button data-a="reason" data-v="${t}" class="${d.reasons.includes(t) ? 'on' : ''}">${t}</button>`).join('')}</div>
      <label>年代</label><select id="rAge">${AGES.map(a => `<option ${a === d.age ? 'selected' : ''}>${a}</option>`).join('')}</select>
      <label>降車場所</label><div class="addr">${d.drop ? esc(d.drop.address || '地図で選択済み') : '未設定'}　<button class="chip" data-a="drop">地図から選ぶ</button></div>` : ''}
      <label>メモ（任意）</label><input id="rMemo" type="text" value="${esc(d.memo)}">
      <div class="actions"><button class="txt" data-a="close">キャンセル</button><button class="btn orange" style="flex:none" data-a="ok">登録</button></div>`, {
      type(b) { keep(); d.type = b.dataset.v; d.reasons = []; draw(); },
      reason(b) { keep(); const v = b.dataset.v; d.reasons = d.reasons.includes(v) ? d.reasons.filter(x => x !== v) : [...d.reasons, v]; draw(); },
      async drop() { keep(); closeDialog(); toast('降車場所を地図でタップしてください', 4000); const p = await pickOnMap(); d.drop = { ...p, address: await revGeo(p) }; draw(); },
      ok() {
        keep(); const now = new Date();
        records.push({ id: 'r' + now.getTime(), time: d.time, lat: pos.lat, lng: pos.lng, address, memo: d.memo, type: d.type, reasons: d.reasons, age: d.age, drop: d.drop, createdAt: now.toISOString(), dow: now.getDay() });
        saveRecords(); closeDialog(); clearPin(); renderRecords(); toast('配車記録を登録しました');
      },
    });
  };
  const keep = () => { d.time = $('#rTime')?.value || d.time; d.memo = $('#rMemo')?.value ?? d.memo; d.age = $('#rAge')?.value || d.age; };
  draw();
}
const pickOnMap = () => new Promise(res => pickResolve = res);
function showRecord(r) {
  const kind = { normal: '通常', vip: '★ 上客', ng: '⚠ 危険客' }[r.type];
  dialog(`<h2>配車記録</h2><div class="addr">📍 ${esc(r.address)}</div>
    <p><b>${md(r.createdAt)}（${L.DOW[r.dow][0]}） ${r.time}</b>　${kind}${r.age && r.age !== '不明' ? '・' + esc(r.age) : ''}</p>
    ${r.reasons?.length ? `<p>理由：${r.reasons.map(esc).join('、')}</p>` : ''}${r.drop ? `<p>降車場所：${esc(r.drop.address)}</p>` : ''}${r.memo ? `<p>メモ：${esc(r.memo)}</p>` : ''}
    <div class="actions"><button class="txt" data-a="del" style="color:#c62828">削除</button><button class="txt" data-a="close">閉じる</button><button class="btn blue" style="flex:none" data-a="nav">ここへナビ</button></div>`, {
    del() { records = records.filter(x => x.id !== r.id); saveRecords(); closeDialog(); renderRecords(); },
    nav() { closeDialog(); previewRoute(r, r.address); },
  });
}

// ============ 検索とピン ============
let pin = null, pinInfo = null;
function clearPin() { pin?.setMap(null); pin = null; $('#pinBar').hidden = true; }
async function setPin(pos, name = '', address = '') {
  clearPin(); closeSheet();
  pin = new G.Marker({ map, position: pos, draggable: true, zIndex: 500 }); // ずれていたらドラッグで直せる
  pin.addListener('dragend', e => setPin(ll(e.latLng)));
  pinInfo = { pos, name, address: address || await revGeo(pos) };
  const bar = $('#pinBar');
  bar.innerHTML = `<h2><span style="font-size:15px">📍 ${esc(pinInfo.name ? pinInfo.name + '　' : '')}<small style="color:#666;font-weight:400">${esc(pinInfo.address)}</small></span><button data-a="x">✕</button></h2>
    <div class="row"><button class="btn blue" data-a="nav">ここへナビ</button><button class="btn orange" data-a="rec">配車記録を追加</button></div>`;
  bar.hidden = false;
  bar.onclick = e => { const a = e.target.closest('[data-a]')?.dataset.a; if (a === 'x') clearPin(); if (a === 'nav') previewRoute(pinInfo.pos, pinInfo.name || pinInfo.address); if (a === 'rec') addRecordDialog(pinInfo.pos, pinInfo.address); };
}
async function searchPlaces(q) {
  const geo = async () => { try { const { results } = await new G.Geocoder().geocode({ address: q, region: 'jp', language: 'ja' }); return results.slice(0, 4).map(r => ({ name: cleanAddr(r.formatted_address), address: '', pos: ll(r.geometry.location) })); } catch { return []; } };
  const txt = async () => {
    try {
      const { Place } = await G.importLibrary('places');
      const { places } = await Place.searchByText({ textQuery: q, fields: ['displayName', 'formattedAddress', 'location'], language: 'ja', region: 'jp', maxResultCount: 6, locationBias: map.getCenter() });
      return (places || []).map(p => ({ name: p.displayName, address: cleanAddr(p.formattedAddress), pos: ll(p.location) }));
    } catch (e) { console.warn('場所検索', e); return []; }
  };
  // 番地まで入った住所は、住所専用の検索（ジオコーダー）のほうがピンが正確なので先に出す
  const isAddr = /[0-9０-９]|丁目|番地/.test(q) && /[都道府県市区町村]/.test(q);
  const [a, b] = await Promise.all([geo(), txt()]);
  return isAddr ? [...a, ...b] : [...b, ...a];
}
async function doSearch() {
  const q = $('#q').value.trim(); if (!q) return; $('#q').blur();
  const box = $('#results'); box.hidden = false; box.innerHTML = '<button>検索中…</button>';
  const list = await searchPlaces(q);
  box.innerHTML = list.length ? list.map((r, i) => `<button data-i="${i}"><b>${esc(r.name)}</b><small>${esc(r.address)}</small></button>`).join('') : '<button>見つかりませんでした</button>';
  box.onclick = e => { const b = e.target.closest('[data-i]'); box.hidden = true; if (!b) return; const r = list[+b.dataset.i]; follow = false; setFollowUi(); map.setCenter(r.pos); map.setZoom(17); setPin(r.pos, r.name, r.address); };
}
function twoPointDialog() {
  dialog(`<h2>2点間のルート</h2><label>出発地（空欄なら現在地）</label><input id="tA" type="text" placeholder="現在地">
    <label>目的地</label><input id="tB" type="text" value="${esc($('#q').value)}">
    <div class="actions"><button class="txt" data-a="close">キャンセル</button><button class="btn blue" style="flex:none" data-a="ok">ルートを表示</button></div>`, {
    async ok() {
      const a = $('#tA').value.trim(), b = $('#tB').value.trim(); if (!b) return toast('目的地を入力してください');
      const [ra, rb] = await Promise.all([a ? searchPlaces(a) : [], searchPlaces(b)]);
      if (!rb.length || (a && !ra.length)) return toast('場所が見つかりませんでした');
      closeDialog(); previewRoute(rb[0].pos, rb[0].name, a ? ra[0].pos : null);
    },
  });
}

// ============ ルート検索とナビ ============
function mkRoute(path, duration, desc, steps) {
  const cum = L.cumulative(path), total = cum[cum.length - 1] || 0, sum = steps.reduce((s, x) => s + x.dist, 0) || total || 1;
  let acc = 0; steps.forEach(s => { acc += s.dist * total / sum; s.end = acc; });
  return { path, cum, total, duration, desc, steps, turns: steps.filter(s => L.isTurn(s.man)).length };
}
async function routesApi(o, d, via, alt, mod) { // Routes API（渋滞を考慮した経路）
  const wp = p => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
  const r = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': cfg.key, 'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.description,routes.polyline.encodedPolyline,routes.legs.steps.distanceMeters,routes.legs.steps.navigationInstruction' },
    body: JSON.stringify({ origin: wp(o), destination: wp(d), intermediates: via.map(wp), travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE', computeAlternativeRoutes: alt && !via.length, routeModifiers: { avoidTolls: !!mod.avoidTolls, avoidHighways: !!mod.avoidHighways }, languageCode: 'ja', units: 'METRIC' }),
  });
  if (!r.ok) throw new Error('Routes API ' + r.status);
  const j = await r.json(); if (!j.routes?.length) throw new Error('経路なし');
  return j.routes.map(rt => mkRoute(L.decodePolyline(rt.polyline.encodedPolyline), parseInt(rt.duration) || 0, rt.description || '',
    (rt.legs || []).flatMap(l => (l.steps || []).map(s => ({ text: s.navigationInstruction?.instructions || '', man: s.navigationInstruction?.maneuver || '', dist: s.distanceMeters || 0 })))));
}
async function directionsSvc(o, d, via, alt, mod) { // 予備：従来の Directions サービス
  const res = await new G.DirectionsService().route({ origin: o, destination: d, waypoints: via.map(p => ({ location: p, stopover: true })), travelMode: 'DRIVING', provideRouteAlternatives: alt && !via.length, avoidTolls: !!mod.avoidTolls, avoidHighways: !!mod.avoidHighways, drivingOptions: { departureTime: new Date() }, region: 'JP' });
  return res.routes.map(rt => mkRoute(rt.legs.flatMap(l => l.steps.flatMap(s => s.path.map(ll))), rt.legs.reduce((s, l) => s + (l.duration_in_traffic || l.duration).value, 0), rt.summary || '',
    rt.legs.flatMap(l => l.steps.map(s => ({ text: s.instructions.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), man: s.maneuver || '', dist: s.distance.value })))));
}
async function computeRoutes(o, d, via = [], alt = true, mod = cfg) {
  const P = p => ({ lat: p.lat, lng: p.lng });
  try { return await routesApi(P(o), P(d), via.map(P), alt, mod); }
  catch (e) { console.warn('Routes API が使えないため Directions に切り替え', e); return await directionsSvc(P(o), P(d), via.map(P), alt, mod); }
}
let routeLines = [], destMarker = null;
function clearRoute() { routeLines.forEach(l => l.setMap(null)); routeLines = []; destMarker?.setMap(null); destMarker = null; }
function drawRoutes(routes, sel) {
  routeLines.forEach(l => l.setMap(null));
  routeLines = routes.map((r, i) => new G.Polyline({ map, path: r.path, strokeColor: i === sel ? '#1565c0' : '#9e9e9e', strokeWeight: i === sel ? 7 : 5, strokeOpacity: i === sel ? .9 : .6, zIndex: i === sel ? 5 : 1 }));
}
async function previewRoute(dest, name = '', origin = null, via = []) {
  const from = origin || me; if (!from) return toast('現在地を取得してからもう一度お試しください');
  clearPin(); closeSheet(); clearRoute(); toast('ルートを検索中…');
  let routes; try { routes = await computeRoutes(from, dest, via); } catch (e) { console.error(e); return toast('ルートを取得できませんでした（API の設定を確認）', 5000); }
  let sel = 0; follow = false; setFollowUi();
  destMarker = new G.Marker({ map, position: dest, zIndex: 400 });
  const bd = new G.LatLngBounds(); routes[0].path.forEach(p => bd.extend(p)); map.fitBounds(bd, viewPad(320));
  const draw = () => {
    drawRoutes(routes, sel);
    sheet(esc(name || '目的地'), `<div class="list">${routes.map((r, i) => `<button class="alt ${i === sel ? 'on' : ''}" data-a="sel" data-i="${i}"><b>${i === 0 ? '推奨' : '別ルート' + i}　${L.fmtDur(r.duration)}・${L.fmtDist(r.total)}</b><small>到着 ${hm(Date.now() + r.duration * 1000)}　右左折 ${r.turns}回${r.desc ? '　' + esc(r.desc) + ' 経由' : ''}</small></button>`).join('')}</div>
      <div class="tags"><button data-a="toll" class="${cfg.avoidTolls ? 'on' : ''}">有料道路を使わない</button><button data-a="hw" class="${cfg.avoidHighways ? 'on' : ''}">高速を使わない</button></div>
      <div class="row"><button class="btn blue" data-a="go">➤ ナビ開始</button></div>`, {
      sel(b) { sel = +b.dataset.i; keepRoute = true; draw(); },
      toll() { cfg.avoidTolls = !cfg.avoidTolls; saveCfg(); keepRoute = true; previewRoute(dest, name, origin, via); },
      hw() { cfg.avoidHighways = !cfg.avoidHighways; saveCfg(); keepRoute = true; previewRoute(dest, name, origin, via); },
      go() { keepRoute = true; closeSheet(); startNav(routes[sel], dest, via); },
    }, () => { if (!keepRoute) clearRoute(); keepRoute = false; }, true);
  };
  draw();
}
let keepRoute = false, nav = null, trafficLayer = null;
function setTraffic(on) { cfg.traffic = on; saveCfg(); trafficLayer ||= new G.TrafficLayer(); trafficLayer.setMap(on ? map : null); $('#navTraffic').classList.toggle('off', !on); }
function startNav(route, dest, via = []) {
  drawRoutes([route], 0);
  nav = { route, dest, via: [...via], idx: 0, off: 0, spoken: new Set(), follow: true, busy: false };
  document.body.classList.add('navi'); $('#nav').hidden = false; $('#navMute').textContent = cfg.voice ? '🔊' : '🔇';
  speak(`ナビを開始します。目的地まで、およそ${L.fmtDur(route.duration)}です。`); wake();
  if (me) navUpdate(me);
}
function endNav(msg) {
  nav = null; document.body.classList.remove('navi'); $('#nav').hidden = true; clearRoute();
  map.moveCamera?.({ tilt: 0, heading: 0, zoom: 16 }); follow = true; setFollowUi(); if (msg) { toast(msg); speak(msg); }
}
async function reroute() {
  if (nav.busy) return; nav.busy = true; toast('ルートから外れました。再検索します'); speak('ルートを再検索します');
  try { const [r] = await computeRoutes(me, nav.dest, nav.via, false); if (nav) { nav.route = r; nav.idx = 0; nav.off = 0; nav.spoken.clear(); drawRoutes([r], 0); } }
  catch (e) { console.warn(e); } finally { if (nav) nav.busy = false; }
}
function navUpdate(p) {
  const rt = nav.route, n = L.nearestOnPath(rt.path, rt.cum, p, nav.idx);
  if (n.dist > 60 && (p.acc ?? 0) < 40) { if (++nav.off >= 4) reroute(); } else { nav.off = 0; nav.idx = n.index; }
  nav.via = nav.via.filter(v => L.haversine(v, p) > 120); // 通過した経由地は再検索の対象から外す
  const along = n.along, remain = Math.max(0, rt.total - along);
  if (remain < 30 && n.dist < 60) return endNav('目的地に到着しました');
  let i = rt.steps.findIndex(s => s.end > along); if (i < 0) i = rt.steps.length - 1;
  const next = rt.steps[i + 1], after = rt.steps[i + 2], dTo = Math.max(0, (rt.steps[i]?.end ?? rt.total) - along);
  $('#navArrow').textContent = next ? L.maneuverArrow(next.man) : '🏁';
  $('#navDist').textContent = L.fmtDist(next ? dTo : remain);
  $('#navText').textContent = next ? (next.text || '道なりです') : '目的地';
  $('#navNext').hidden = !after; if (after) $('#navNext').textContent = `その先 ${L.maneuverArrow(after.man)} ${L.fmtDist(next.end - rt.steps[i].end)}`;
  const remSec = rt.duration * (rt.total ? remain / rt.total : 0);
  $('#navEta').textContent = hm(Date.now() + remSec * 1000); $('#navRemT').textContent = L.fmtDur(remSec); $('#navRemD').textContent = L.fmtDist(remain);
  $('#navSpeed b').textContent = Math.round(Math.max(0, p.spd || 0) * 3.6);
  if (next && next.text) for (const th of [60, 200, 500]) { // 500m・200m・直前の 3 回案内する
    if (dTo > th) continue;
    if (!nav.spoken.has(`${i}:${th}`)) { [60, 200, 500].filter(x => x >= th).forEach(x => nav.spoken.add(`${i}:${x}`)); speak(th === 60 ? next.text : `およそ${th}メートル先、${next.text}`); }
    break;
  }
  if (nav.follow) map.moveCamera?.({ center: n.dist < 40 ? n.point : p, zoom: 17.5, tilt: 50, heading: n.dist < 40 && n.heading != null ? n.heading : heading });
}

// ============ 探索ナビ ============
let exploreOverlays = [], exploreOffset = 0;
function clearExplore() { exploreOverlays.forEach(o => o.setMap(null)); exploreOverlays = []; }
async function openExplore() {
  if (!me) return toast('現在地を取得してからもう一度お試しください');
  const now = new Date(), band = L.timeBand(now);
  toast('需要データを読み込み中…');
  const rec = L.clusterDemand(records, { dow: now.getDay(), nowMin: nowMin() });
  const gps = L.gridDemand(await loadGrid(), me, { dow: now.getDay(), hour: now.getHours() });
  const cells = L.mergeDemand(rec, gps);
  const stops = L.pickStops(cells, me, { offset: exploreOffset });
  const head = `${L.DOW[now.getDay()]} / ${band.label}（${band.from}〜${band.to}時）`;
  closeSheet(); keepRoute = false; clearExplore(); clearRoute();
  if (!stops.length) return sheet('🧭 探索ナビ', `<p>${head}</p><p>この時間帯で、現在地から6km以内の需要データがまだありません。配車記録や走行データが増えると、需要の高いエリアを回るルートを作れます。</p>`);
  await Promise.all(stops.map(async st => { if (!st.address) st.address = await revGeo(st); }));
  toast('需要予測ルートを作成中…');
  let route; try { [route] = await computeRoutes(me, stops[stops.length - 1], stops.slice(0, -1), false); } catch (e) { console.error(e); return toast('ルートを取得できませんでした', 5000); }
  const demandColor = c => c.vip ? '#8e24aa' : !c.gps ? '#1e88e5' : c.pct >= 50 ? '#e53935' : '#fb8c00';
  cells.filter(c => L.haversine(me, c) < 6000).slice(0, 200).forEach(c => exploreOverlays.push(new G.Circle({ map, center: c, radius: 55, strokeWeight: 0, fillColor: demandColor(c), fillOpacity: .32, clickable: false })));
  stops.forEach((s, i) => exploreOverlays.push(new G.Marker({ map, position: s, label: { text: String(i + 1), color: '#fff', fontWeight: '700' }, zIndex: 300 })));
  drawRoutes([route], 0); follow = false; setFollowUi();
  const bd = new G.LatLngBounds(); route.path.forEach(p => bd.extend(p)); map.fitBounds(bd, viewPad(380));
  sheet('🧭 探索ナビ', `<p style="margin:0 0 6px;color:#555">${head}</p>
    <div class="cards"><div class="card c1"><b>${nearbyCount()}台</b>近隣車両</div><div class="card c2"><b>—</b>交通規制</div><div class="card c3"><b>${cells.length}箇所</b>需要エリア</div></div>
    <div class="routebox">需要予測ルート（${stops.length}箇所の高需要エリア経由）<div class="big">🕒 約${L.fmtDur(route.duration)}　📏 ${L.fmtDist(route.total)}　↱ 右左折 ${route.turns}回</div>
    ${stops.map(s => `<div class="stop"><span>${s.vip ? '★' : s.gps ? '📡' : '🚕'} ${esc(s.address) || '需要エリア'}</span><span>スコア ${s.pct}%</span></div>`).join('')}</div>
    <div class="row"><button class="btn line" data-a="re">↻ 再生成</button><button class="btn blue" style="flex:2" data-a="go">➤ ナビ開始</button></div>
    <small style="color:#666">🟣 配車実績（上客）　🔵 配車実績（通常）　🔴 GPS高需要　🟠 GPS中需要　🟩 空車タクシー　🟧 実車タクシー<br>※近隣車両は3km以内で10分以内に位置を更新した車両の数です。交通規制の情報は未対応です。</small>`, {
    re() { exploreOffset = (exploreOffset + 3) % Math.max(3, Math.min(cells.length, 15)); openExplore(); },
    go() { keepRoute = true; closeSheet(); clearExplore(); startNav(route, stops[stops.length - 1], stops.slice(0, -1)); },
  }, () => { clearExplore(); if (!keepRoute) clearRoute(); keepRoute = false; }, true);
}

// ============ 高速 IC ハイライト ============
let icOverlays = [];
const icPos = ls.get('icPos', {}), icPaths = ls.get('icPaths', {});
const icAt = ic => icPos[ic.name] || { lat: ic.lat, lng: ic.lng };
const boxIcon = (text, strong) => {
  const w = 16 + text.length * 14, h = 26;
  return { url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect x="1" y="1" width="${w - 2}" height="${h - 2}" fill="${strong ? '#fff' : '#f3f3f3'}" stroke="${strong ? '#111' : '#888'}" stroke-width="${strong ? 2 : 1}"/><text x="${w / 2}" y="18" text-anchor="middle" font-size="13" font-weight="700" fill="${strong ? '#111' : '#666'}" font-family="sans-serif">${text}</text></svg>`), scaledSize: new G.Size(w, h), anchor: new G.Point(w / 2, h / 2) };
};
async function drawIc() {
  icOverlays.forEach(o => o.setMap(null)); icOverlays = [];
  if (!cfg.ic) return;
  for (const s of IC_SECTIONS) {
    const a = icAt(s.outer), b = icAt(s.exit);
    const line = new G.Polyline({ map, path: icPaths[s.road] || [a, b], strokeColor: s.color, strokeWeight: 8, strokeOpacity: .28, clickable: false, zIndex: 0 }); // 指定区間を薄く表示
    icOverlays.push(line);
    for (const [ic, strong] of [[s.exit, true], [s.outer, false]]) {
      const m = new G.Marker({ map, position: icAt(ic), icon: boxIcon(ic.name, strong), draggable: !!cfg.icEdit, zIndex: strong ? 60 : 55, title: `${s.road}　${ic.name}${strong ? '（必ずここで降りる）' : ''}` });
      m.addListener('click', () => toast(`${s.road}：${s.outer.name} → ${s.exit.name}（大阪方面の帰路は ${s.exit.name} で降りる）`, 5000));
      m.addListener('dragend', e => { icPos[ic.name] = ll(e.latLng); ls.set('icPos', icPos); delete icPaths[s.road]; ls.set('icPaths', icPaths); drawIc(); });
      icOverlays.push(m);
    }
    if (!icPaths[s.road]) computeRoutes(a, b, [], false, {}).then(([r]) => { // 実際の道路の形は初回だけ取得して保存
      icPaths[s.road] = r.path.filter((_, i) => i % 3 === 0 || i === r.path.length - 1); ls.set('icPaths', icPaths); line.setPath(icPaths[s.road]);
    }).catch(() => { });
  }
}

// ============ S（SOS）：録画とルート追跡 ============
let sos = null;
async function startSos() {
  sos = { id: 's' + Date.now(), start: Date.now(), pts: me ? [{ lat: me.lat, lng: me.lng, acc: me.acc, t: Date.now() }] : [], chunks: [], rec: null, stream: null };
  $('#btnS').classList.add('active'); $('#btnS small').textContent = '長押しで解除'; navigator.vibrate?.(80); wake(); sendSos(true);
  try {
    sos.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true });
    const mime = ['video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm'].find(t => window.MediaRecorder?.isTypeSupported?.(t)) || '';
    sos.rec = new MediaRecorder(sos.stream, mime ? { mimeType: mime } : undefined); sos.mime = sos.rec.mimeType || mime || 'video/webm';
    sos.rec.ondataavailable = e => { if (e.data?.size) sos?.chunks.push(e.data); };
    sos.rec.start(3000);
  } catch (e) { console.warn('録画開始失敗', e); toast('カメラを起動できませんでした（ルートの記録は続けます）', 4000); }
}
async function stopSos() {
  const s = sos; if (!s) return; sos = null; sendSos(false);
  $('#btnS').classList.remove('active'); $('#btnS small').textContent = '長押しで発動'; navigator.vibrate?.([40, 60, 40]);
  if (s.rec && s.rec.state !== 'inactive') await new Promise(res => { s.rec.onstop = res; s.rec.stop(); });
  s.stream?.getTracks().forEach(t => t.stop());
  await db.put('videos', { id: s.id, start: s.start, end: Date.now(), mime: s.mime, blob: s.chunks.length ? new Blob(s.chunks, { type: s.mime }) : null, pts: s.pts, events: L.detectTurns(s.pts) });
  toast('記録を保存しました（メニュー → SOS 録画一覧）');
}
function trackSos(p) { if (sos && L.acceptPoint(sos.pts[sos.pts.length - 1], p)) sos.pts.push({ lat: p.lat, lng: p.lng, acc: p.acc, t: p.t }); }
async function showSosList() {
  const all = (await db.all('videos')).sort((a, b) => b.start - a.start);
  sheet('SOS 録画一覧', (all.length ? `<div class="list">${all.map(v => `<div><b>${md(v.start)} ${hms(v.start)}〜${hms(v.end)}</b><small>${v.blob ? `録画 ${(v.blob.size / 1e6).toFixed(1)}MB` : '録画なし'}・通過点 ${v.pts.length}</small>
      <div class="row">${v.blob ? `<button class="btn" data-a="play" data-id="${v.id}">再生</button><button class="btn" data-a="save" data-id="${v.id}">保存</button>` : ''}<button class="btn" data-a="route" data-id="${v.id}">ルート</button><button class="btn red" data-a="del" data-id="${v.id}">削除</button></div></div>`).join('')}</div>` : '<p>まだ記録がありません。</p>')
    + '<p><a href="tel:110" class="btn red" style="display:block;text-align:center;text-decoration:none">110 番に電話する</a></p>', {
    play(b) { const v = all.find(x => x.id === b.dataset.id); dialog(`<video src="${URL.createObjectURL(v.blob)}" controls playsinline style="width:100%;border-radius:12px"></video><div class="actions"><button class="txt" data-a="close">閉じる</button></div>`); },
    save(b) { const v = all.find(x => x.id === b.dataset.id); download(`sos_${v.id}.${v.mime.includes('mp4') ? 'mp4' : 'webm'}`, v.blob); },
    route(b) { const v = all.find(x => x.id === b.dataset.id); if (v.pts.length < 2) return toast('ルートの記録がありません'); closeSheet(); drawLog(v, '#e53935'); sheet('SOS 中の走行ルート', '<p>地図の点をタップすると通過時刻が出ます。</p>', {}, clearTripOverlays, true); },
    async del(b) { await db.del('videos', b.dataset.id); showSosList(); },
  });
}

// ============ サーバー連携：位置の共有・近隣車両・需要データ・SOS 通知 ============
// 旧 iPhone アプリと同じ taxi_locations/<車両コード> に同じ形式で書くので、
// お客様用ページにも、他の車両の地図にも、新旧どちらのアプリの車両も表示される。
const cloud = makeCloud(() => cfg.dbUrl || DB_URL);
const key = k => encodeURIComponent(k);
let others = {}, otherMarkers = {}, sosMarkers = {}, seenSos = new Set(), lastSent = null, gridCache = null;
async function sendPosition(force = false) {
  if (!cfg.code || cfg.priv || !me) return;
  if (!force && lastSent && Date.now() - lastSent.t < 4000) return;                         // 送りすぎない
  if (!force && lastSent && L.haversine(lastSent, me) < 10 && Date.now() - lastSent.t < 20000) return; // 止まっている間は 20 秒おき
  lastSent = { lat: me.lat, lng: me.lng, t: Date.now() };
  try { await cloud.put(`taxi_locations/${key(cfg.code)}`, { carNumber: cfg.plate || '', heading, isAvailable: meter === 'vacant', latitude: me.lat, longitude: me.lng, timestamp: Date.now(), userType: 'driver' }); }
  catch (e) { console.warn('位置の送信に失敗', e); }
  if (sos) sendSos(true);
}
function hidePosition() { if (cfg.code) cloud.del(`taxi_locations/${key(cfg.code)}`).catch(e => console.warn(e)); lastSent = null; }
function sendSos(active) { // SOS は「位置を非公開」でも周囲に知らせる
  const id = key(cfg.code || cfg.deviceId);
  (active && me ? cloud.put(`sos_alerts/${id}`, { carNumber: cfg.plate || '', latitude: me.lat, longitude: me.lng, timestamp: Date.now(), active: true }) : cloud.del(`sos_alerts/${id}`)).catch(e => console.warn('SOS 通知に失敗', e));
}
const carIcon = free => ({ path: 'M -7,-7 7,-7 7,7 -7,7 z', fillColor: free ? '#43a047' : '#fb8c00', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 });
async function pollCloud() {
  if (document.visibilityState !== 'visible') return;
  let locs, alerts;
  try { [locs, alerts] = await Promise.all([cloud.get('taxi_locations'), cloud.get('sos_alerts')]); } catch (e) { return console.warn('サーバーに接続できません', e); }
  const now = Date.now(), fresh = {};
  for (const [k, v] of Object.entries(locs || {})) if (k !== cfg.code && v && Number.isFinite(v.latitude) && now - v.timestamp < 10 * 60000) fresh[k] = v;
  others = fresh;
  for (const k of Object.keys(otherMarkers)) if (!others[k]) { otherMarkers[k].setMap(null); delete otherMarkers[k]; }
  for (const [k, v] of Object.entries(others)) {
    const pos = { lat: v.latitude, lng: v.longitude }, title = `${v.carNumber || k}（${v.isAvailable ? '空車' : '実車'}）`;
    if (!otherMarkers[k]) { otherMarkers[k] = new G.Marker({ map, position: pos, icon: carIcon(v.isAvailable), title, zIndex: 80 }); otherMarkers[k].addListener('click', () => toast(otherMarkers[k].getTitle?.() || title)); }
    else { otherMarkers[k].setPosition(pos); otherMarkers[k].setIcon(carIcon(v.isAvailable)); otherMarkers[k].setTitle?.(title); }
  }
  const mine = cfg.code || cfg.deviceId, live = {};
  for (const [k, v] of Object.entries(alerts || {})) if (k !== mine && v?.active && Number.isFinite(v.latitude) && now - v.timestamp < 15 * 60000) live[k] = v;
  for (const k of Object.keys(sosMarkers)) if (!live[k]) { sosMarkers[k].setMap(null); delete sosMarkers[k]; seenSos.delete(k); }
  for (const [k, v] of Object.entries(live)) {
    const pos = { lat: v.latitude, lng: v.longitude };
    if (!sosMarkers[k]) sosMarkers[k] = new G.Marker({ map, position: pos, zIndex: 900, label: { text: 'SOS', color: '#fff', fontWeight: '700', fontSize: '11px' }, icon: { path: G.SymbolPath.CIRCLE, scale: 16, fillColor: '#d50000', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 }, title: `SOS ${v.carNumber || k}` });
    else sosMarkers[k].setPosition(pos);
    if (!seenSos.has(k) && (!me || L.haversine(me, pos) < 10000)) { seenSos.add(k); navigator.vibrate?.([200, 100, 200]); toast(`⚠ 近くの車両が SOS を発信しました（${v.carNumber || k}）`, 8000); speak('近くの車両がSOSを発信しました'); }
  }
}
const nearbyCount = () => me ? Object.values(others).filter(v => L.haversine(me, { lat: v.latitude, lng: v.longitude }) < 3000).length : 0;
function startCloud() { pollCloud(); setInterval(pollCloud, 15000); setInterval(() => sendPosition(), 5000); }
async function loadGrid() { // 需要データは大きいので、現在地の緯度 ±0.06°（約 6.6km）の帯だけ取り、30 分は使い回す
  if (gridCache && Date.now() - gridCache.t < 1800000 && L.haversine(gridCache.at, me) < 3000) return gridCache.g;
  const lo = Math.floor((me.lat - 0.06) * 1000), hi = Math.ceil((me.lat + 0.06) * 1000);
  try { gridCache = { g: await cloud.get('explore_nav_data/demand_grid', `?orderBy=%22%24key%22&startAt=%22${lo}%22&endAt=%22${hi}~%22`) || {}, t: Date.now(), at: { lat: me.lat, lng: me.lng } }; return gridCache.g; }
  catch (e) { console.warn('需要データの取得に失敗', e); return {}; }
}
function vehicleCodeDialog() {
  dialog(`<h2>車両コード設定</h2><p style="font-size:14px;color:#555">車両ごとに違うコードを付けてください（例：taxi_02）。このコードで位置が共有され、お客様用QRコードにも使われます。</p>
    <label>車両コード</label><input id="tVal" type="text" value="${esc(cfg.code)}" autocapitalize="off" autocomplete="off">
    <div class="actions"><button class="txt" data-a="close">キャンセル</button><button class="btn blue" style="flex:none" data-a="ok">保存</button></div>`, {
    async ok() {
      const v = $('#tVal').value.trim();
      if (v && !validKey(v)) return toast('コードに空白や . $ # [ ] / は使えません');
      if (v && v !== cfg.code) try { // ほかの端末が使用中のコードを上書きしない
        const cur = await cloud.get(`taxi_locations/${key(v)}`);
        if (cur && Date.now() - cur.timestamp < 5 * 60000 && (!me || L.haversine(me, { lat: cur.latitude, lng: cur.longitude }) > 300)) return toast(`「${v}」は別の端末が使用中です。別のコードにしてください`, 6000);
      } catch (e) { console.warn(e); }
      if (cfg.code && cfg.code !== v) hidePosition();
      cfg.code = v; saveCfg(); closeDialog(); sendPosition(true); toast(v ? '車両コードを保存しました' : '車両コードを消しました（位置は共有されません）');
    },
  });
}
function showQr() {
  if (!cfg.code) return dialog('<h2>🔳 お客様用QRコード</h2><p>先にメニューの「車両コード設定」で車両コードを登録してください。</p><div class="actions"><button class="txt" data-a="close">閉じる</button></div>');
  const u = new URL('view.html', location.href); u.search = ''; u.hash = ''; u.searchParams.set('c', cfg.code); if (cfg.dbUrl) u.searchParams.set('db', cfg.dbUrl);
  const qr = qrcode(0, 'M'); qr.addData(u.href); qr.make();
  dialog(`<h2>🔳 お客様用QRコード</h2><p style="margin-top:-8px;color:#777">読み取るとタクシーの位置が見られます</p><div class="qr">${qr.createSvgTag({ cellSize: 6, margin: 12, scalable: true })}</div>
    <div class="addr" style="word-break:break-all;color:#1565c0;font-size:13px">${esc(u.href)}</div>
    <p style="text-align:center;color:#666;font-size:14px">このQRコードを読み取るか、URLにアクセスすると<br>タクシーの現在地・空車/実車がわかります</p>
    ${cfg.priv ? '<p style="color:#c62828;font-size:14px">「位置を非公開」がオンのため、お客様には位置が表示されません。</p>' : ''}
    <div class="actions"><button class="txt" data-a="copy">URLをコピー</button><button class="txt" data-a="close">閉じる</button></div>`, {
    copy() { navigator.clipboard?.writeText(u.href).then(() => toast('コピーしました'), () => toast('コピーできませんでした')); },
  });
}

// ============ メニューと各画面 ============
function showStats() {
  const byH = Array(24).fill(0), byD = Array(7).fill(0);
  records.forEach(r => { byH[Math.floor(L.hhmmToMin(r.time) / 60)]++; byD[r.dow]++; });
  const mh = Math.max(1, ...byH), mdw = Math.max(1, ...byD);
  sheet('GO 配車統計', `<p>記録 <b>${records.length}</b> 件（上客 ${records.filter(r => r.type === 'vip').length}・危険客 ${records.filter(r => r.type === 'ng').length}）</p>
    <b>時間帯別</b><div class="bars">${byH.map((n, h) => `<div style="height:${n / mh * 100}%"><span>${h % 3 === 0 ? h : ''}</span></div>`).join('')}</div><br>
    <b>曜日別</b><div class="bars" style="height:80px">${byD.map((n, d) => `<div style="height:${n / mdw * 100}%;background:#1565c0"><span>${L.DOW[d][0]}</span></div>`).join('')}</div><br>
    <div class="row"><button class="btn" data-a="exp">CSV で書き出し</button><button class="btn" data-a="imp">CSV を取り込み</button></div>
    <small style="color:#666">列の順番は「時刻, 住所, 緯度, 経度, メモ, 登録日時」です（スプレッドシート「taxi乗車記録」と同じ）。</small>`, {
    exp() { download('haisha_records.csv', '﻿' + L.recordsToCsv(records), 'text/csv'); },
    imp() {
      const f = Object.assign(document.createElement('input'), { type: 'file', accept: '.csv,text/csv,text/plain' });
      f.onchange = async () => { const add = L.csvToRecords(await f.files[0].text()); records.push(...add); saveRecords(); renderRecords(); toast(`${add.length} 件を取り込みました`); showStats(); };
      f.click();
    },
  });
}
function textDialog(title, label, value, onOk) {
  dialog(`<h2>${title}</h2><label>${label}</label><input id="tVal" type="text" value="${esc(value)}"><div class="actions"><button class="txt" data-a="close">キャンセル</button><button class="btn blue" style="flex:none" data-a="ok">保存</button></div>`, { ok() { onOk($('#tVal').value.trim()); saveCfg(); closeDialog(); } });
}
function showSettings() {
  const chk = (k, t) => `<button data-a="t" data-k="${k}" class="${cfg[k] ? 'on' : ''}">${t}</button>`;
  dialog(`<h2>設定</h2><div class="tags">${chk('voice', '音声案内')}${chk('avoidTolls', '有料道路を使わない')}${chk('avoidHighways', '高速を使わない')}${chk('icEdit', 'IC の位置を調整する')}</div>
    <p style="font-size:13px;color:#666">「IC の位置を調整する」をオンにすると、高速 IC のラベルをドラッグして正しい位置に直せます。</p>
    <div class="actions"><button class="txt" data-a="db">サーバーURL</button><button class="txt" data-a="key">API キーを変更</button><button class="txt" data-a="close">閉じる</button></div>`, {
    db() { textDialog('サーバーURL', 'Firebase Realtime Database の URL（空欄で既定）', cfg.dbUrl, v => { cfg.dbUrl = v; gridCache = null; }); },
    t(b) { cfg[b.dataset.k] = !cfg[b.dataset.k]; saveCfg(); if (b.dataset.k === 'icEdit') drawIc(); showSettings(); },
    key() { showSetup(); },
  });
}
function showMenu() {
  const item = (a, ic, t, sub = '') => `<button data-a="${a}"><span>${ic}</span><span>${t}${sub ? `<small>${sub}</small>` : ''}</span></button>`;
  const go = f => () => { closeSheet(); f(); };
  sheet('メニュー', `<div class="menu">${item('explore', '🧭', '探索ナビ', '需要予測ルートを生成')}${item('qr', '🔳', 'お客様用QRコード')}${item('code', '⚙️', '車両コード設定', cfg.code ? esc(cfg.code) : '')}
    ${item('trips', '🧾', '乗車記録（走行ルート）')}${item('sos', '🎥', 'SOS 録画一覧')}${item('stats', '📊', 'GO 配車統計')}
    ${item('legend', '🗂', `統計オーバーレイ ${cfg.legend ? '非表示' : '表示'}`)}${item('ic', '🛣', `高速ICハイライト ${cfg.ic ? '非表示' : '表示'}`)}${item('traffic', '🚦', `渋滞情報 ${cfg.traffic ? '非表示' : '表示'}`)}${item('set', '🔧', '設定')}</div>`, {
    explore: go(openExplore), trips: go(showTripList), sos: go(showSosList), stats: go(showStats), set: go(showSettings),
    code: go(vehicleCodeDialog),
    qr: go(showQr),
    legend: go(() => { cfg.legend = !cfg.legend; saveCfg(); renderRecords(); }),
    ic: go(() => { cfg.ic = !cfg.ic; saveCfg(); drawIc(); if (cfg.ic) toast('IC の位置は目安です。ずれていたら設定から調整できます', 4500); }),
    traffic: go(() => setTraffic(!cfg.traffic)),
  });
}
function setFollowUi() { $('#btnFollow').classList.toggle('on', follow); $('#btnFollow small').textContent = follow ? '追跡中' : '現在地へ'; }
function updateScale() {
  const c = map.getCenter(), z = map.getZoom(); if (!c || !Number.isFinite(z)) return;
  const m = 156543.03392 * Math.cos(c.lat() * Math.PI / 180) / 2 ** z * 60, nice = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000].find(x => x >= m) || 100000;
  $('#scale').textContent = nice >= 1000 ? nice / 1000 + 'km' : nice + 'm';
}
function initUi() {
  $('#plateText').textContent = cfg.plate || 'ナンバー入力';
  $('#btnPlate').onclick = () => textDialog('ナンバー入力', '車両ナンバー', cfg.plate, v => { cfg.plate = v; $('#plateText').textContent = v || 'ナンバー入力'; setTimeout(() => sendPosition(true)); });
  $('#btnExplore').onclick = openExplore; $('#btnMenu').onclick = showMenu; $('#btnTwo').onclick = twoPointDialog;
  $('#q').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  $('#meter').onclick = e => { const b = e.target.closest('[data-m]'); if (b) pressMeter(b.dataset.m); };
  $('#btnFollow').onclick = () => { follow = !follow; setFollowUi(); if (follow && me) { map.panTo(me); map.setZoom(Math.max(map.getZoom() || 16, 16)); } };
  $('#zin').onclick = () => map.setZoom((map.getZoom() || 16) + 1); $('#zout').onclick = () => map.setZoom((map.getZoom() || 16) - 1);
  $('#chkPrivate').checked = cfg.priv; $('#chkPrivate').onchange = e => { cfg.priv = e.target.checked; saveCfg(); if (cfg.priv) hidePosition(); else sendPosition(true); };
  // 統計オーバーレイ
  $('#dowSel').innerHTML = '<option value="">全曜日</option>' + L.DOW.map((d, i) => `<option value="${i}">${d}</option>`).join('');
  $('#dowSel').onchange = renderRecords;
  $('#levels').innerHTML = L.DIFF_LEVELS.map(l => `<div class="lv"><i class="dot" style="background:${l.color}"></i>${l.label}</div>`).join('');
  $('#slider').oninput = e => setSlider(+e.target.value, false);
  $('#btnLive').onclick = () => setSlider(nowMin(), true);
  setSlider(nowMin(), true); setInterval(() => { if (live) setSlider(nowMin(), true); updateTripBar(); }, 30000);
  // 地図
  map.addListener('dragstart', () => { follow = false; setFollowUi(); if (nav) nav.follow = false; $('#results').hidden = true; });
  map.addListener('zoom_changed', updateScale); map.addListener('idle', updateScale);
  map.addListener('click', e => { if (nav) return; const p = ll(e.latLng); if (pickResolve) { const r = pickResolve; pickResolve = null; return r(p); } setPin(p); });
  // S ボタン：1 秒の長押しで発動・解除
  let tm; const bs = $('#btnS');
  const down = e => { e.preventDefault(); bs.classList.add('arming'); tm = setTimeout(() => { bs.classList.remove('arming'); sos ? stopSos() : startSos(); }, 1000); };
  const up = () => { clearTimeout(tm); bs.classList.remove('arming'); };
  bs.addEventListener('pointerdown', down); ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => bs.addEventListener(ev, up));
  bs.addEventListener('contextmenu', e => e.preventDefault());
  // ナビ中のボタン
  $('#navEnd').onclick = () => endNav('ナビを終了しました');
  $('#navMute').onclick = () => { cfg.voice = !cfg.voice; saveCfg(); $('#navMute').textContent = cfg.voice ? '🔊' : '🔇'; if (!cfg.voice) speechSynthesis?.cancel(); };
  $('#navTraffic').onclick = () => setTraffic(!cfg.traffic); $('#navTraffic').classList.toggle('off', !cfg.traffic);
  $('#navOver').onclick = () => {
    if (!nav) return; nav.follow = !nav.follow;
    if (!nav.follow) { map.moveCamera?.({ tilt: 0, heading: 0 }); const bd = new G.LatLngBounds(); nav.route.path.forEach(p => bd.extend(p)); map.fitBounds(bd, viewPad(120)); } else if (me) navUpdate(me);
  };
  window.addEventListener('pagehide', () => { if (trip) ls.set('activeTrip', trip); });
  setFollowUi(); updateScale();
}
window.__app = { get state() { return { trip, nav, sos, records, me, meter }; }, onPos: p => onPos(p), cfg };
boot();
