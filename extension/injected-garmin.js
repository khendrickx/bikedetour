/**
 * injected-garmin.js — runs in the PAGE context (not the extension context).
 *
 * Thin orchestrator: wires together GarminAdapter (loaded just before this
 * script by content-garmin.js) with Garmin Connect map detection.
 *
 * Detection: patches L.Map via L.Map.extend so every new Leaflet map —
 * including those created after SPA navigation — fires adapter.onMapReady.
 */
(function () {
  'use strict';

  const FROM_CONTENT = 'rw-from-content';

  const adapter = new GarminAdapter(); // eslint-disable-line no-undef

  // ── Incoming messages (content → page) ───────────────────────────────────

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (!e.data || e.data.__rw !== FROM_CONTENT) return;

    const { type } = e.data;
    if (type === 'RW_DATA')           adapter.applyData(e.data.data || {});
    if (type === 'RW_TOGGLE')         adapter.setVisible(e.data.enabled);
    if (type === 'RW_TOGGLE_LIMITED') adapter.setLimitedVisible(e.data.enabled);
  });

  // ── L.Map patching ────────────────────────────────────────────────────────

  function onMapDiscovered(map) {
    const container = map.getContainer ? map.getContainer() : null;
    if (container && container.offsetWidth < 200) return; // skip minimaps
    adapter.onMapReady(map);
  }

  function patchLeaflet(L) {
    if (!L.Map || L.Map.__garminPatched) return;
    const OrigMap = L.Map;
    L.Map = OrigMap.extend({
      initialize(id, options) {
        OrigMap.prototype.initialize.call(this, id, options);
        this.whenReady(() => onMapDiscovered(this));
      },
    });
    L.Map.__garminPatched = true;
    Object.keys(OrigMap).forEach((k) => { if (!(k in L.Map)) L.Map[k] = OrigMap[k]; });
    console.log('[BikeDetour] Patched L.Map for Garmin Connect');
  }

  // Intercept window.L assignment (handles Leaflet loaded after this script)
  let _L = window.L;
  try {
    Object.defineProperty(window, 'L', {
      get() { return _L; },
      set(v) { _L = v; if (v && v.Map) patchLeaflet(v); },
      configurable: true,
    });
  } catch (_) { /* already non-configurable — immediate check below handles it */ }

  // Immediate patch if L is already present
  if (window.L && window.L.Map) patchLeaflet(window.L);

  // Late-injection fallback: poll for Leaflet loading or direct container access.
  // Max 150 × 200 ms = 30 s.
  let pollCount = 0;
  const poll = setInterval(() => {
    if (adapter._map || ++pollCount > 150) { clearInterval(poll); return; }
    if (window.L && window.L.Map && !window.L.Map.__garminPatched) patchLeaflet(window.L);
    if (!adapter._map) {
      const el = document.querySelector('.leaflet-container');
      if (el && el._leaflet_map) onMapDiscovered(el._leaflet_map);
    }
  }, 200);

  // Signal that the message listener is live; content script responds with stored preferences
  toContent('RW_READY', {}); // eslint-disable-line no-undef
})();
