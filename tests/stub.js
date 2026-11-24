(() => {
  const LatLng = class { constructor(a, b) { this._a = a; this._b = b; } lat() { return this._a; } lng() { return this._b; } };
  const lit = p => p && typeof p.lat === 'function' ? p : new LatLng(p.lat, p.lng);
  class Ov { constructor(o = {}) { this.o = o; this.h = {}; (window.__ov ||= []).push(this); this.map = o.map; }
    setMap(m) { this.map = m; } setPosition(p) { this.o.position = p; } setIcon() { } setCenter() { } setRadius() { } setPath(p) { this.o.path = p; }
    getPath() { return { push() { } }; } addListener(n, f) { this.h[n] = f; return {}; } setContent() { } open() { } }
  class Map_ { constructor(el, o) { this.o = o; this.h = {}; this.z = o.zoom; this.c = lit(o.center); window.__map = this; }
    setCenter(p) { this.c = lit(p); } panTo(p) { this.c = lit(p); } getCenter() { return this.c; } getZoom() { return this.z; } setZoom(z) { this.z = z; this.h.zoom_changed?.(); }
    getHeading() { return 0; } addListener(n, f) { this.h[n] = f; } fitBounds() { } moveCamera(c) { this.cam = c; } }
  window.google = { maps: {
    Map: Map_, Marker: Ov, Circle: Ov, Polyline: Ov, InfoWindow: Ov, TrafficLayer: Ov, LatLng,
    LatLngBounds: class { extend() { } }, Size: class { }, Point: class { }, SymbolPath: { CIRCLE: 0, FORWARD_CLOSED_ARROW: 1 }, RenderingType: { VECTOR: 'VECTOR' },
    Geocoder: class { async geocode(q) { const p = q.location || { lat: 34.7025, lng: 135.4959 }; return { results: [{ formatted_address: '日本、〒553-0003 大阪府大阪市福島区福島６丁目１７−７', geometry: { location: new LatLng(p.lat, p.lng) } }] }; } },
    importLibrary: async () => ({ Place: { searchByText: async () => ({ places: [{ displayName: '大阪駅', formattedAddress: '日本、大阪府大阪市北区梅田３丁目１−１', location: new LatLng(34.7025, 135.4959) }] }) } }),
    DirectionsService: class { async route() { throw new Error('stub'); } },
  } };
})();
