/**
 * injected-ridewithgps.js — runs in the PAGE context (not the extension context).
 *
 * Thin orchestrator: wires together the RideWithGPSAdapter (loaded just before
 * this script by content-ridewithgps.js) with RideWithGPS-specific map detection.
 *
 * Execution order guaranteed by content-ridewithgps.js:
 *   1. adapters/RideWithGPSAdapter.js — defines RideWithGPSAdapter, toContent, constants
 *   2. injected-ridewithgps.js        — this file
 *
 * Detection supports Leaflet (window.L) and MapLibre GL (window.mapboxgl /
 * window.maplibregl). Three mechanisms run in parallel — first to fire wins.
 */
(function () {
  'use strict';

  const FROM_CONTENT = 'rw-from-content';

  // ── Adapter singleton ─────────────────────────────────────────────────────

  const adapter = new RideWithGPSAdapter(); // eslint-disable-line no-undef

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
    const container = map.getContainer ? map.getContainer() : null;
    if (container && container.offsetWidth < 200) return; // skip minimaps
    adapter.onMapReady(map);
  }

  // ── MapLibre / Mapbox GL patching ─────────────────────────────────────────

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
    console.log('[BikeDetour] Patched MapLibre/Mapbox for RideWithGPS');
  }

  // ── Leaflet patching ──────────────────────────────────────────────────────

  function patchLeaflet(L) {
    if (!L.Map || L.Map.__rwPatched) return;
    const OrigMap = L.Map;
    L.Map = OrigMap.extend({
      initialize(id, options) {
        OrigMap.prototype.initialize.call(this, id, options);
        this.whenReady(() => onMapDiscovered(this));
      },
    });
    L.Map.__rwPatched = true;
    // Preserve static properties (e.g. L.Map.mergeOptions)
    Object.keys(OrigMap).forEach((k) => { if (!(k in L.Map)) L.Map[k] = OrigMap[k]; });
    console.log('[BikeDetour] Patched Leaflet for RideWithGPS');
  }

  // ── Window property interceptors ──────────────────────────────────────────

  function installInterceptors() {
    ['mapboxgl', 'maplibregl'].forEach((name) => {
      let _val = window[name];
      try {
        Object.defineProperty(window, name, {
          get() { return _val; },
          set(v) { _val = v; if (v && v.Map) patchLib(v); },
          configurable: true,
        });
      } catch (_) { /* non-configurable — handled by polling */ }
    });

    let _L = window.L;
    try {
      Object.defineProperty(window, 'L', {
        get() { return _L; },
        set(v) { _L = v; if (v && v.Map) patchLeaflet(v); },
        configurable: true,
      });
    } catch (_) { /* non-configurable — handled by polling */ }
  }

  // Immediate check in case libs are already assigned before our script ran
  if (window.mapboxgl)          patchLib(window.mapboxgl);
  if (window.maplibregl)        patchLib(window.maplibregl);
  if (window.L && window.L.Map) patchLeaflet(window.L);

  installInterceptors();

  // ── DOM polling fallback ──────────────────────────────────────────────────

  let pollCount = 0;
  const poll = setInterval(() => {
    if (adapter._map || ++pollCount > 150) { clearInterval(poll); return; }

    if (window.mapboxgl   && !window.mapboxgl.Map.__rwPatched)   patchLib(window.mapboxgl);
    if (window.maplibregl && !window.maplibregl.Map.__rwPatched) patchLib(window.maplibregl);
    if (window.L && window.L.Map && !window.L.Map.__rwPatched)   patchLeaflet(window.L);

    // Leaflet container direct access (Leaflet 1.x stores map on container element)
    if (!adapter._map) {
      const el = document.querySelector('.leaflet-container');
      if (el && el._leaflet_map) onMapDiscovered(el._leaflet_map);
    }
  }, 200);

  // ── React fiber walk (handles RideWithGPS bundled MapLibre GL) ───────────

  function isMapInstance(obj) {
    return obj != null && typeof obj === 'object' &&
      typeof obj.on === 'function' &&
      typeof obj.getZoom === 'function' &&
      typeof obj.getBounds === 'function' &&
      typeof obj.addLayer === 'function';
  }

  function findMapInFiber(fiber, depth) {
    if (!fiber || depth > 60) return null;
    const props = fiber.memoizedProps;
    if (props && typeof props === 'object') {
      for (const v of Object.values(props)) {
        if (isMapInstance(v)) return v;
        if (v && typeof v === 'object' && isMapInstance(v.current)) return v.current;
      }
    }
    let state = fiber.memoizedState;
    let ss = 0;
    while (state && ss++ < 30) {
      if (isMapInstance(state.memoizedState)) return state.memoizedState;
      if (state.memoizedState && typeof state.memoizedState === 'object') {
        for (const v of Object.values(state.memoizedState)) {
          if (isMapInstance(v)) return v;
          if (v && typeof v === 'object' && isMapInstance(v.current)) return v.current;
        }
      }
      state = state.next;
    }
    return findMapInFiber(fiber.child,   depth + 1)
        || findMapInFiber(fiber.sibling, depth + 1)
        || findMapInFiber(fiber.return,  depth + 1);
  }

  function tryGetMapFromCanvas(canvas) {
    let el = canvas;
    while (el && el !== document.body) {
      const fk = Object.keys(el).find(k =>
        k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
      );
      if (fk) {
        const map = findMapInFiber(el[fk], 0);
        if (map) return map;
      }
      el = el.parentElement;
    }
    return null;
  }

  function waitForMapViaDOM() {
    let attempts = 0;

    function tryCanvas() {
      if (adapter._map) return true;
      const canvas = document.querySelector('.maplibregl-canvas');
      if (!canvas) return false;
      const map = tryGetMapFromCanvas(canvas);
      if (map) { onMapDiscovered(map); return true; }
      return false;
    }

    if (tryCanvas()) return;

    const mo = new MutationObserver(() => {
      if (document.querySelector('.maplibregl-canvas')) {
        mo.disconnect();
        const timer = setInterval(() => {
          if (tryCanvas() || ++attempts > 50) clearInterval(timer);
        }, 200);
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  waitForMapViaDOM();

  // Signal that the message listener is live; content script responds with stored preferences
  toContent('RW_READY', {}); // eslint-disable-line no-undef
})();
