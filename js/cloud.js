// Firebase Realtime Database との通信（REST）。
// 旧 iPhone アプリと同じデータベース・同じ形式を使うので、新旧のアプリが同じ地図に並ぶ。
export const DB_URL = 'https://taxi-location-sharing-default-rtdb.firebaseio.com';

export function makeCloud(getUrl) {
  const call = async (path, query = '', opt) => {
    const r = await fetch(`${getUrl().replace(/\/+$/, '')}/${path}.json${query}`, opt);
    if (!r.ok) throw new Error(`DB ${r.status}`);
    return r.json();
  };
  return {
    get: (path, query = '') => call(path, query),
    put: (path, value) => call(path, '', { method: 'PUT', body: JSON.stringify(value) }),
    del: path => call(path, '', { method: 'DELETE' }),
  };
}
// キーに使えない文字（. $ # [ ] /）を含まないか
export const validKey = s => !!s && !/[.$#\[\]\/\s]/.test(s);
