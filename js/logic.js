// 地図やブラウザに依存しない計算ロジック（Node でも単体テストできる）
const R = 6371000, rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;

export function haversine(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
export function bearing(a, b) {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
export const angleDiff = (a, b) => ((b - a + 540) % 360) - 180; // -180..180（+は右）
export function pathDistance(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversine(pts[i - 1], pts[i]);
  return d;
}

// ---- 時刻・需要の色分け ----
export const hhmmToMin = s => { const [h, m] = String(s).split(':').map(Number); return (h * 60 + (m || 0)) % 1440; };
export const minToHhmm = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m) % 60).padStart(2, '0')}`;
export function timeDiffMin(hhmm, nowMin) { // 日付またぎを考慮した差（分）
  const d = Math.abs(hhmmToMin(hhmm) - nowMin);
  return Math.min(d, 1440 - d);
}
export const DIFF_LEVELS = [
  { max: 30, color: '#e53935', label: '30分以内' },
  { max: 60, color: '#fb8c00', label: '〜1時間' },
  { max: 120, color: '#fdd835', label: '〜2時間' },
  { max: 180, color: '#43a047', label: '〜3時間' },
  { max: Infinity, color: '#1e88e5', label: '3時間以上' },
];
export const diffLevel = min => DIFF_LEVELS.find(l => min <= l.max);

export const BANDS = [
  { key: 'late', label: '深夜', from: 0, to: 5 }, { key: 'dawn', label: '早朝', from: 5, to: 7 },
  { key: 'am', label: '朝ピーク', from: 7, to: 11 }, { key: 'noon', label: '昼ピーク', from: 11, to: 14 },
  { key: 'pm', label: '午後', from: 14, to: 17 }, { key: 'eve', label: '夕ピーク', from: 17, to: 20 },
  { key: 'night', label: '夜', from: 20, to: 24 },
];
export const timeBand = d => BANDS.find(b => d.getHours() >= b.from && d.getHours() < b.to);
export const DOW = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'];

// ---- 走行ログ：曲がり角の検出 ----
// GPS のブレを曲がり角と誤認しないよう、25m 以上離れた点どうしで方位を比べ、
// 40°以上変わった地点だけをイベントにする。
export function detectTurns(pts, { minSeg = 25, minAngle = 40 } = {}) {
  const key = [];
  for (const p of pts) if (!key.length || haversine(key[key.length - 1], p) >= minSeg) key.push(p);
  const out = [];
  for (let i = 1; i < key.length - 1; i++) {
    const d = angleDiff(bearing(key[i - 1], key[i]), bearing(key[i], key[i + 1]));
    if (Math.abs(d) >= minAngle) {
      const last = out[out.length - 1];
      if (last && haversine(last, key[i]) < minSeg * 1.5) continue; // 同じ交差点の重複を除く
      out.push({ lat: key[i].lat, lng: key[i].lng, t: key[i].t, dir: d > 0 ? '右折' : '左折', angle: Math.round(d) });
    }
  }
  return out;
}
// 記録する価値のある測位点か（精度が悪い点・ほぼ動いていない点を捨てる）
export function acceptPoint(prev, p, { maxAcc = 50, minMove = 8, maxGap = 15000 } = {}) {
  if (p.acc != null && p.acc > maxAcc) return false;
  if (!prev) return true;
  return haversine(prev, p) >= minMove || p.t - prev.t >= maxGap;
}

// ---- ナビ：経路上の現在位置 ----
export function decodePolyline(str) {
  const out = []; let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let shift = 0, result = 0, b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 31) << shift; shift += 5; } while (b >= 32);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += d; else lng += d;
    }
    out.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return out;
}
export function cumulative(path) {
  const c = [0];
  for (let i = 1; i < path.length; i++) c.push(c[i - 1] + haversine(path[i - 1], path[i]));
  return c;
}
// 経路上で p に最も近い点。from 以降の区間だけを探す（逆戻りを防ぐ）。
export function nearestOnPath(path, cum, p, from = 0, window = 400) {
  let best = { dist: Infinity, index: from, along: cum[from] || 0, point: path[from] };
  const end = Math.min(path.length - 1, from + window);
  const kx = Math.cos(rad(p.lat)) * 111320, ky = 110540;
  for (let i = Math.max(0, from - 2); i < end; i++) {
    const a = path[i], b = path[i + 1];
    const ax = (a.lng - p.lng) * kx, ay = (a.lat - p.lat) * ky, bx = (b.lng - p.lng) * kx, by = (b.lat - p.lat) * ky;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best.dist) best = {
      dist: d, index: i, along: cum[i] + t * (cum[i + 1] - cum[i]),
      point: { lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) },
      heading: bearing(a, b),
    };
  }
  return best;
}
export function normManeuver(m) { return String(m || '').toUpperCase().replace(/-/g, '_'); }
export function maneuverArrow(m) {
  m = normManeuver(m);
  if (m.includes('UTURN')) return '↶';
  if (m.includes('ROUNDABOUT')) return '⟳';
  if (m.includes('SLIGHT_LEFT') || m.includes('FORK_LEFT') || m.includes('RAMP_LEFT') || m.includes('KEEP_LEFT')) return '↖';
  if (m.includes('SLIGHT_RIGHT') || m.includes('FORK_RIGHT') || m.includes('RAMP_RIGHT') || m.includes('KEEP_RIGHT')) return '↗';
  if (m.includes('LEFT')) return '↰';
  if (m.includes('RIGHT')) return '↱';
  if (m.includes('MERGE')) return '⤴';
  return '↑';
}
export const isTurn = m => /(^|_)TURN_(LEFT|RIGHT|SHARP)/.test(normManeuver(m)) || /UTURN/.test(normManeuver(m));
export function fmtDist(m) { return m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)}km` : `${Math.max(10, Math.round(m / 10) * 10)}m`; }
export function fmtDur(sec) { const m = Math.round(sec / 60); return m >= 60 ? `${Math.floor(m / 60)}時間${m % 60}分` : `${Math.max(1, m)}分`; }

// ---- 探索ナビ：配車記録から需要エリアを作る ----
// 約 250m のマス目にまとめ、曜日と時間帯が近い記録ほど高く点数化する。
export function clusterDemand(records, { dow, nowMin, cell = 0.0025 } = {}) {
  const cells = new Map();
  for (const r of records) {
    if (r.type === 'ng') continue;
    const diff = timeDiffMin(r.time, nowMin);
    if (diff > 180) continue;
    let w = diff <= 30 ? 1 : diff <= 60 ? 0.7 : diff <= 120 ? 0.4 : 0.2;
    if (dow != null && r.dow === dow) w *= 1.5;
    if (r.type === 'vip') w *= 3;
    const k = `${Math.round(r.lat / cell)}:${Math.round(r.lng / cell)}`;
    const c = cells.get(k) || { lat: 0, lng: 0, n: 0, score: 0, vip: 0, address: r.address };
    c.lat += r.lat; c.lng += r.lng; c.n++; c.score += w; if (r.type === 'vip') c.vip++;
    cells.set(k, c);
  }
  const list = [...cells.values()].map(c => ({ ...c, lat: c.lat / c.n, lng: c.lng / c.n })).sort((a, b) => b.score - a.score);
  const top = list[0]?.score || 1;
  return list.map(c => ({ ...c, pct: Math.round(c.score / top * 100) }));
}
// 現在地から maxKm 以内の上位エリアを n 箇所選び、近い順に並べる。offset を変えると別案になる。
// 隣り合うマス目ばかり選ばないよう、選ぶエリアどうしは minSep 以上離す。
export function pickStops(cells, origin, { n = 3, maxKm = 6, offset = 0, minSep = 400 } = {}) {
  const near = cells.filter(c => haversine(origin, c) <= maxKm * 1000);
  const pick = from => {
    const ch = [];
    for (const c of near.slice(from)) { if (ch.every(x => haversine(x, c) >= minSep)) ch.push(c); if (ch.length === n) break; }
    return ch;
  };
  let chosen = pick(offset); if (offset && chosen.length < n) chosen = pick(0);
  const order = []; let cur = origin; const rest = [...chosen];
  while (rest.length) {
    rest.sort((a, b) => haversine(cur, a) - haversine(cur, b));
    cur = rest.shift(); order.push(cur);
  }
  return order;
}
// サーバーに蓄積された GPS の需要データ（約110mのマス目 × 「年月日時」ごとの回数）から、
// いまの時刻（前後1時間）に近い回数を点数にする。曜日が同じなら 1.5 倍。
export function gridDemand(grid, origin, { dow, hour, maxKm = 6 } = {}) {
  const out = [];
  for (const [k, stamps] of Object.entries(grid || {})) {
    const [a, b] = k.split('_').map(Number), c = { lat: a / 1000, lng: b / 1000 };
    if (!isFinite(c.lat) || !isFinite(c.lng) || haversine(origin, c) > maxKm * 1000) continue;
    let score = 0, n = 0;
    for (const [st, cnt] of Object.entries(stamps || {})) {
      if (!/^\d{10}$/.test(st) || typeof cnt !== 'number') continue;
      const h = +st.slice(8), dh = Math.min(Math.abs(h - hour), 24 - Math.abs(h - hour));
      if (dh > 1) continue;
      const day = new Date(+st.slice(0, 4), +st.slice(4, 6) - 1, +st.slice(6, 8)).getDay();
      score += cnt * (dh === 0 ? 1 : 0.5) * (day === dow ? 1.5 : 1); n += cnt;
    }
    if (score > 0) out.push({ ...c, n, score, gps: true, vip: 0, address: '' });
  }
  return out;
}
// 配車記録のエリアと GPS のエリアを 1 つの順位にまとめる。実際の配車記録のほうを重く見る。
export function mergeDemand(recCells, gpsCells) {
  const gmax = gpsCells.reduce((m, c) => Math.max(m, c.score), 1);
  const all = [...recCells, ...gpsCells.map(c => ({ ...c, score: c.score / gmax }))].sort((a, b) => b.score - a.score);
  const top = all[0]?.score || 1;
  return all.map(c => ({ ...c, pct: Math.round(c.score / top * 100) }));
}

// ---- 配車記録の CSV（スプレッドシート「taxi乗車記録」と同じ列順）----
const HEAD = ['時刻', '住所', '緯度', '経度', 'メモ', '登録日時', '種別'];
const esc = v => /[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? '');
export function recordsToCsv(recs) {
  return [HEAD.join(','), ...recs.map(r => [r.time, r.address, r.lat, r.lng, r.memo, r.createdAt, r.type].map(esc).join(','))].join('\n');
}
export function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',' || ch === '\t') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
export function csvToRecords(text) {
  const out = [];
  for (const r of parseCsv(text)) {
    const lat = parseFloat(r[2]), lng = parseFloat(r[3]);
    if (!/^\d{1,2}:\d{2}/.test(r[0] || '') || !isFinite(lat) || !isFinite(lng)) continue; // 見出し行や空行を飛ばす
    const created = r[5] ? new Date(String(r[5]).replace(/\//g, '-').replace(' ', 'T')) : new Date();
    const d = isNaN(created) ? new Date() : created;
    out.push({
      id: 'r' + d.getTime() + Math.random().toString(36).slice(2, 6), time: r[0].slice(0, 5).padStart(5, '0'),
      address: r[1] || '', lat, lng, memo: r[4] || '', createdAt: d.toISOString(), dow: d.getDay(),
      type: ['vip', 'ng'].includes(r[6]) ? r[6] : 'normal', reasons: [], age: '', drop: null,
    });
  }
  return out;
}
