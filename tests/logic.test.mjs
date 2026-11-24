import * as L from '../js/logic.js';
import assert from 'node:assert/strict';
// 距離・方位
const a={lat:34.6975,lng:135.4868}, b={lat:34.6975,lng:135.4978};
assert.ok(Math.abs(L.haversine(a,b)-1005)<15, 'haversine '+L.haversine(a,b));
assert.ok(Math.abs(L.bearing(a,b)-90)<1);
assert.equal(L.angleDiff(350,20),30); assert.equal(L.angleDiff(20,350),-30);
// 時刻差（日付またぎ）と色
assert.equal(L.timeDiffMin('23:50', 10), 20);
assert.equal(L.diffLevel(20).label,'30分以内'); assert.equal(L.diffLevel(200).label,'3時間以上');
assert.equal(L.minToHhmm(737),'12:17');
assert.equal(L.timeBand(new Date(2026,10,24,12,0)).label,'昼ピーク');
// 曲がり角：東へ300m→北へ300m（＝左折1回）。GPSのブレ±3mを混ぜても1回だけ
const pts=[]; let t=0;
for(let i=0;i<=30;i++) pts.push({lat:34.70+(i%2?0.00003:-0.00003), lng:135.50+i*0.00011, t:t+=2000});
for(let i=1;i<=30;i++) pts.push({lat:34.70+i*0.00009, lng:135.50+30*0.00011+(i%2?0.00003:-0.00003), t:t+=2000});
const turns=L.detectTurns(pts);
assert.equal(turns.length,1, JSON.stringify(turns)); assert.equal(turns[0].dir,'左折');
// 測位点の採否
assert.equal(L.acceptPoint(null,{lat:1,lng:1,acc:80,t:0}),false);
assert.equal(L.acceptPoint({lat:34.7,lng:135.5,t:0},{lat:34.7,lng:135.50002,acc:10,t:1000}),false);
assert.equal(L.acceptPoint({lat:34.7,lng:135.5,t:0},{lat:34.7,lng:135.5002,acc:10,t:1000}),true);
// ポリライン復号（Google 公式の例）
const dec=L.decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
assert.deepEqual(dec.map(p=>[+p.lat.toFixed(3),+p.lng.toFixed(3)]),[[38.5,-120.2],[40.7,-120.95],[43.252,-126.453]]);
// 経路上の位置
const path=[a,b,{lat:34.7065,lng:135.4978}], cum=L.cumulative(path);
const n=L.nearestOnPath(path,cum,{lat:34.6977,lng:135.4923});
assert.ok(Math.abs(n.along-502)<15 && n.dist<30 && n.index===0, JSON.stringify(n));
const n2=L.nearestOnPath(path,cum,{lat:34.7020,lng:135.4990},0);
assert.ok(n2.index===1 && n2.dist>80 && n2.dist<130, JSON.stringify(n2));
assert.equal(L.maneuverArrow('TURN_LEFT'),'↰'); assert.equal(L.maneuverArrow('turn-slight-right'),'↗');
assert.ok(L.isTurn('turn-left') && L.isTurn('TURN_RIGHT') && !L.isTurn('TURN_SLIGHT_LEFT') && !L.isTurn('STRAIGHT'));
assert.equal(L.fmtDist(10300),'10km'); assert.equal(L.fmtDist(1234),'1.2km'); assert.equal(L.fmtDist(187),'190m');
assert.equal(L.fmtDur(1800),'30分'); assert.equal(L.fmtDur(5400),'1時間30分');
// 需要エリアと経由地
const recs=[
 {time:'12:00',lat:34.700,lng:135.500,type:'normal',dow:2,address:'A'},{time:'12:10',lat:34.7001,lng:135.5001,type:'normal',dow:2,address:'A'},
 {time:'12:30',lat:34.710,lng:135.510,type:'vip',dow:2,address:'B'},{time:'03:00',lat:34.720,lng:135.520,type:'normal',dow:2,address:'C'},
 {time:'12:00',lat:34.705,lng:135.505,type:'ng',dow:2,address:'D'},{time:'11:00',lat:35.0,lng:135.77,type:'normal',dow:2,address:'遠い'}];
const cells=L.clusterDemand(recs,{dow:2,nowMin:12*60+15});
assert.equal(cells.length,3); assert.equal(cells[0].address,'B'); assert.equal(cells[0].pct,100);
const stops=L.pickStops(cells,{lat:34.699,lng:135.499});
assert.deepEqual(stops.map(s=>s.address),['A','B']);
// CSV 往復（スプレッドシートの形式）
const csv='時刻,住所,緯度,経度,メモ,登録日時\n10:00,京都府京都市左京区吉田本町,35.026244,135.780822,,2026/04/09 11:39\n10:30,"滋賀県大津市螢谷５, 1F",34.967521,135.902632,"メモ ""x""",2026/04/09 11:41\n';
const imp=L.csvToRecords(csv);
assert.equal(imp.length,2); assert.equal(imp[1].address,'滋賀県大津市螢谷５, 1F'); assert.equal(imp[1].memo,'メモ "x"'); assert.equal(imp[0].dow,4);
assert.equal(L.csvToRecords(L.recordsToCsv(imp)).length,2);
console.log('logic: all tests passed');
// サーバーの GPS 需要データ → 需要エリア
{
  const grid={'34703_135492':{'2026112412':9,'2026112413':4,'2026112403':99},'34709_135501':{'2026111712':2},'37367_-122112':{'2026112412':50},'bad':{'x':1}};
  const g=L.gridDemand(grid,{lat:34.6975,lng:135.4868},{dow:2,hour:12});
  assert.equal(g.length,2);                                   // 遠方（カリフォルニア）と壊れたキーは除外
  const a=g.find(c=>c.lat===34.703);
  assert.equal(a.score, 9*1.5 + 4*0.5*1.5);                   // 同じ時刻=1、前後1時間=0.5、同じ曜日は1.5倍、3時のデータは対象外
  const m=L.mergeDemand([{lat:34.70,lng:135.50,n:1,score:1.5,vip:0,address:'記録'}],g);
  assert.equal(m[0].address,'記録'); assert.equal(m[0].pct,100); assert.ok(m[1].gps && m[1].pct===67);
  // 隣り合うマス目だけで経由地を埋めない
  const near=[{lat:34.7000,lng:135.5000,score:5},{lat:34.7010,lng:135.5000,score:4},{lat:34.7100,lng:135.5000,score:3},{lat:34.7200,lng:135.5000,score:2}];
  assert.deepEqual(L.pickStops(near,{lat:34.699,lng:135.5}).map(s=>s.score),[5,3,2]);
}
console.log('logic: cloud demand tests passed');
