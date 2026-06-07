/**
 * injected-komoot.js — runs in the PAGE context (not the extension context).
 *
 * Thin orchestrator: wires together the KomootAdapter (loaded just before
 * this script by content.js) with the Komoot-specific map detection logic.
 *
 * Execution order guaranteed by content.js:
 *   1. adapters/KomootAdapter.js  — defines KomootAdapter, toContent, constants
 *   2. injected-komoot.js         — this file
 *
 * Communication with content.js uses window.postMessage with a source tag.
 */
(function () {
  'use strict';

  const FROM_CONTENT = 'rw-from-content';

  // ── Adapter singleton ─────────────────────────────────────────────────────

  const adapter = new KomootAdapter(); // eslint-disable-line no-undef

  // ── Incoming messages (content → page) ───────────────────────────────────

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (!e.data || e.data.__rw !== FROM_CONTENT) return;

    const { type } = e.data;
    if (type === 'RW_DATA')          adapter.applyData(e.data.data || {});
    if (type === 'RW_TOGGLE')        adapter.setVisible(e.data.enabled);
    if (type === 'RW_TOGGLE_LIMITED') adapter.setLimitedVisible(e.data.enabled);
  });

  // ── Map detection (Komoot-specific) ──────────────────────────────────────
  //
  // Komoot bundles MapLibre GL internally, so window.maplibregl is never
  // assigned. Two detection strategies run in parallel:
  //  A) Intercept window.mapboxgl / window.maplibregl assignments.
  //  B) Walk the React fiber tree from the first maplibregl-canvas element.

  function onMapDiscovered(map) {
    const container = map.getContainer && map.getContainer();
    if (container && container.offsetWidth < 200) return; // skip minimaps
    adapter.onMapReady(map);
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
    console.log('[BikeDetour] Patched window lib (mapboxgl/maplibregl)');
  }

  function installInterceptors() {
    ['mapboxgl', 'maplibregl'].forEach((name) => {
      let _val = window[name];
      try {
        Object.defineProperty(window, name, {
          get() { return _val; },
          set(v) { _val = v; if (v && v.Map) patchLib(v); },
          configurable: true,
        });
      } catch (_) { /* non-configurable property — handled by polling */ }
    });
  }

  if (window.mapboxgl)   patchLib(window.mapboxgl);
  if (window.maplibregl) patchLib(window.maplibregl);
  installInterceptors();

  // Polling fallback for edge cases where defineProperty is bypassed
  let pollCount = 0;
  const poll = setInterval(() => {
    if (++pollCount > 150) { clearInterval(poll); return; }
    if (window.mapboxgl   && !window.mapboxgl.Map.__rwPatched)   patchLib(window.mapboxgl);
    if (window.maplibregl && !window.maplibregl.Map.__rwPatched) patchLib(window.maplibregl);
    if (adapter._map) clearInterval(poll);
  }, 200);

  // ── React fiber walk (handles Komoot's bundled MapLibre) ─────────────────

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

  // Signal that the message listener is live; content.js responds with stored preferences.
  toContent('RW_READY', {}); // eslint-disable-line no-undef
})();
