// 高速 IC ハイライトの対象区間（資料の図より）。
// 大阪方面への帰路は exit の IC で必ず降りる。座標は目安なので、設定の「IC の位置を調整する」で直せる。
export const IC_SECTIONS = [
  { road: '箕面グリーンロード', color: '#333333', outer: { name: '止々呂美', lat: 34.8920, lng: 135.4550 }, exit: { name: '萱野', lat: 34.8440, lng: 135.4890 } },
  { road: '中国自動車道', color: '#c62828', outer: { name: 'ひょうご東条', lat: 34.9230, lng: 135.0700 }, exit: { name: '中国池田', lat: 34.8085, lng: 135.4420 } },
  { road: '名神高速道路', color: '#4a148c', outer: { name: '京都東', lat: 34.9905, lng: 135.8180 }, exit: { name: '吹田', lat: 34.7990, lng: 135.5330 } },
  { road: '第二京阪道路', color: '#f9a825', outer: { name: '巨椋池', lat: 34.9010, lng: 135.7560 }, exit: { name: '門真', lat: 34.7200, lng: 135.6050 } },
  { road: '阪神3号神戸線', color: '#1a237e', outer: { name: '月見山', lat: 34.6480, lng: 135.1190 }, exit: { name: '大和田', lat: 34.7095, lng: 135.4420 } },
  { road: '阪神5号湾岸線', color: '#2e7d32', outer: { name: '六甲アイランド北', lat: 34.6950, lng: 135.2690 }, exit: { name: '島屋', lat: 34.6740, lng: 135.4180 } },
  { road: '阪神4号湾岸線', color: '#1565c0', outer: { name: '関空', lat: 34.4110, lng: 135.3000 }, exit: { name: '鉄砲', lat: 34.5905, lng: 135.4680 } },
  { road: '阪和自動車道', color: '#212121', outer: { name: '泉南', lat: 34.3660, lng: 135.2860 }, exit: { name: '堺', lat: 34.5270, lng: 135.5300 } },
  { road: '第二阪奈有料道路', color: '#283593', outer: { name: '宝来', lat: 34.6820, lng: 135.7700 }, exit: { name: '西石切', lat: 34.6770, lng: 135.6370 } },
  { road: '西名阪自動車道', color: '#ef6c00', outer: { name: '天理', lat: 34.6130, lng: 135.8170 }, exit: { name: '長原', lat: 34.6020, lng: 135.5800 } },
  { road: '南阪奈道路', color: '#6d1b1b', outer: { name: '新庄', lat: 34.4990, lng: 135.7240 }, exit: { name: '美原JCT', lat: 34.5540, lng: 135.5700 } },
];
