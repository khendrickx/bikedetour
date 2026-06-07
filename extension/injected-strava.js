/**
 * injected-strava.js — runs in the PAGE context (not the extension context).
 *
 * Thin orchestrator: wires StravaAdapter (loaded just before this script by
 * content-strava.js) with Strava-specific map detection logic.
 *
 * Detection strategy (first to fire wins):
 *  A) window.mapboxgl property interceptor — Strava assigns window.mapboxgl
 *     explicitly, so we patch the constructor before any Map is created.
 *  B) Immediate check — in case mapboxgl is already set when this script runs.
 *  C) DOM polling fallback — probes .mapboxgl-canvas every 200ms.
 */
(function () {
  'use strict';

  const FROM_CONTENT = 'rw-from-content';

  // ── Adapter singleton ─────────────────────────────────────────────────────

  const adapter = new StravaAdapter(); // eslint-disable-line no-undef

  // ── Incoming messages (content → page) ───────────────────────────────────

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (!e.data || e.data.__rw !== FROM_CONTENT) return;

    const { type } = e.data;
    if (type === 'RW_DATA')           adapter.applyData(e.data.data || {});
    if (type === 'RW_TOGGLE')         adapter.setVisible(e.data.enabled);
    if (type === 'RW_TOGGLE_LIMITED') adapter.setLimitedVisible(e.data.enabled);
  });

  // ── Map detection ─────────────────────────────────────────────────────────

  function onMapDiscovered(map) {
    const container = map.getContainer && map.getContainer();
    if (container && container.offsetWidth < 200) return; // skip minimaps
    adapter.onMapReady(map);
  }

  function isMapInstance(obj) {
    return obj != null && typeof obj === 'object' &&
      typeof obj.on         === 'function' &&
      typeof obj.getZoom    === 'function' &&
      typeof obj.getBounds  === 'function' &&
      typeof obj.addLayer   === 'function';
  }

  function patchLib(lib) {
    if (!lib || !lib.Map || lib.Map.__rwPatched) return;
    const OrigCtor = lib.Map;

    function PatchedMap(options) {
      const inst = new OrigCtor(options);
      inst.once('load', () => onMapDiscovered(inst));
      return inst;
    }
    PatchedMap.prototype   = OrigCtor.prototype;
    PatchedMap.__rwPatched = true;
    Object.keys(OrigCtor).forEach((k) => { PatchedMap[k] = OrigCtor[k]; });
    lib.Map = PatchedMap;
    console.log('[BikeDetour] Patched window.mapboxgl');
  }

  function installInterceptor() {
    let _val = window.mapboxgl;
    try {
      Object.defineProperty(window, 'mapboxgl', {
        get() { return _val; },
        set(v) { _val = v; if (v && v.Map) patchLib(v); },
        configurable: true,
      });
    } catch (_) { /* non-configurable property — DOM polling will cover this */ }
  }

  // B) immediate check — before interceptor, in case already assigned
  if (window.mapboxgl) patchLib(window.mapboxgl);

  // A) interceptor — catches Strava's explicit window.mapboxgl = bundledLib()
  installInterceptor();

  // C) DOM polling fallback — covers non-configurable window and edge cases
  let pollCount = 0;
  const poll = setInterval(() => {
    if (++pollCount > 150) { clearInterval(poll); return; }

    // Re-patch if mapboxgl appeared but wasn't caught by interceptor
    if (window.mapboxgl && !window.mapboxgl.Map.__rwPatched) patchLib(window.mapboxgl);

    if (adapter._map) { clearInterval(poll); return; }

    const canvas = document.querySelector('.mapboxgl-canvas');
    if (!canvas) return;
    const container = canvas.closest('.mapboxgl-map');
    if (!container) return;

    // Probe all properties on the container for a map instance
    for (const key of Object.keys(container)) {
      const val = container[key];
      if (isMapInstance(val)) { onMapDiscovered(val); return; }
    }
  }, 200);

  // Signal that the message listener is live; content-strava.js responds with stored prefs.
  toContent('RW_READY', {}); // eslint-disable-line no-undef
})();
