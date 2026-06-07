/**
 * injected.js — runs in the PAGE context (not the extension context).
 *
 * Injected by content.js as a <script> tag so it can access window globals
 * like mapboxgl / maplibregl that Komoot's own bundle uses.
 *
 * Communication with content.js uses window.postMessage with a source tag.
 *
 * KomootAdapter implements the RouteplannerAdapter interface defined in
 * extension/adapters/RouteplannerAdapter.js. Because this script runs in page
 * context it cannot import that file; refer to it as the authoritative spec.
 */
(function () {
  'use strict';

  const FROM_PAGE    = 'rw-from-page';
  const FROM_CONTENT = 'rw-from-content';

  // ── Message bridge (page → content) ────────────────────────────────────────

  function toContent(type, payload) {
    window.postMessage({ __rw: FROM_PAGE, type, ...payload }, '*');
  }

  // ── KomootAdapter ───────────────────────────────────────────────────────────
  //
  // Manages map sources, layers, hover popups, and visibility toggling for the
  // Komoot route planner. To add support for another service, create a new
  // adapter following the same pattern (see README § "Adding a new adapter").

  class KomootAdapter {
    constructor() {
      this._map         = null;
      this._overlayOn   = true;
      this._showLimited = true;
      this._popupTimer   = null;
      this._popupDismiss = null;
      this._fetchTimer   = null;
    }

    // ── Public interface (mirrors RouteplannerAdapter) ──────────────────────

    /**
     * Called once when the Komoot map instance is ready.
     * Registers event listeners and initialises overlay layers.
     * @param {object} map MapLibre GL map instance
     */
    onMapReady(map) {
      if (this._map === map) return;
      this._map = map;
      console.log('[RoadWorks] Map detected ✓');

      this._addHoverListeners(map);

      const doInit = () => {
        this._addLayers(map);
        this.setVisible(this._overlayOn);
        this.setLimitedVisible(this._showLimited);
        this._requestData();
      };

      if (map.isStyleLoaded()) {
        doInit();
      } else {
        map.once('load', doInit);
      }

      map.on('moveend', () => this._requestData());
    }

    /**
     * Push fetched data onto the map sources.
     * @param {Record<string, import('geojson').FeatureCollection>} dataBySource
     *   Keys are DataSource ids: 'gipod', 'brussels', 'ndw', 'osm'.
     */
    applyData(dataBySource) {
      const map = this._map;
      if (!map || !map.isStyleLoaded()) return;

      if (!map.getLayer(LAYER_FILL)) {
        this._addLayers(map);
        this.setLimitedVisible(this._showLimited);
      }

      const empty = { type: 'FeatureCollection', features: [] };
      const gipod      = dataBySource.gipod      || empty;
      const brussels   = dataBySource.brussels   || empty;
      const ndw        = dataBySource.ndw        || empty;
      const luxembourg = dataBySource.luxembourg || empty;
      const osm        = dataBySource.osm        || empty;

      const hSrc = map.getSource(SOURCE_GIPOD);
      const bSrc = map.getSource(SOURCE_BRUSSELS);
      const nSrc = map.getSource(SOURCE_NDW);
      const lSrc = map.getSource(SOURCE_LUXEMBOURG);
      const oSrc = map.getSource(SOURCE_OSM);
      if (hSrc) hSrc.setData(gipod);
      if (bSrc) bSrc.setData(brussels);
      if (nSrc) nSrc.setData(ndw);
      if (lSrc) lSrc.setData(luxembourg);
      if (oSrc) oSrc.setData(osm);

      const total = gipod.features.length + brussels.features.length +
                    ndw.features.length   + luxembourg.features.length + osm.features.length;
      if (total > 0) {
        console.log(`[RoadWorks] ${gipod.features.length} GIPOD, ${brussels.features.length} Brussels, ${ndw.features.length} NDW, ${luxembourg.features.length} Luxembourg, ${osm.features.length} OSM`);
      }
    }

    /**
     * Show or hide the entire overlay.
     * @param {boolean} visible
     */
    setVisible(visible) {
      this._overlayOn = visible;
      const map = this._map;
      if (!map) return;
      const v = visible ? 'visible' : 'none';
      ALL_LAYERS.forEach((id) => {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
      });
    }

    /**
     * Show partial closures alongside full closures, or full-closure only.
     * @param {boolean} showLimited
     */
    setLimitedVisible(showLimited) {
      this._showLimited = showLimited;
      const map = this._map;
      if (!map) return;
      const severityFilter = ['==', ['get', 'severity'], 'full_closure'];
      ALL_LAYERS.forEach((id) => {
        if (!map.getLayer(id)) return;
        const base = LAYER_BASE_FILTER[id] || null;
        let filter;
        if (showLimited) {
          filter = base;
        } else {
          filter = base ? ['all', base, severityFilter] : severityFilter;
        }
        map.setFilter(id, filter);
      });
    }

    // ── Private helpers ─────────────────────────────────────────────────────

    _requestData() {
      const map = this._map;
      if (!map || !this._overlayOn) return;
      if (map.getZoom() < 8) return; // too broad for cycling context

      clearTimeout(this._fetchTimer);
      this._fetchTimer = setTimeout(() => {
        const b = map.getBounds();
        toContent('RW_FETCH', {
          bbox: {
            west:  b.getWest(),
            south: b.getSouth(),
            east:  b.getEast(),
            north: b.getNorth(),
          },
        });
      }, 300);
    }

    _addLayers(map) {
      // ── GIPOD (Flanders) ─────────────────────────────────────────────────
      if (!map.getSource(SOURCE_GIPOD)) {
        map.addSource(SOURCE_GIPOD, { type: 'geojson', data: EMPTY_FC });
      }
      if (!map.getLayer(LAYER_FILL)) {
        map.addLayer({
          id: LAYER_FILL, type: 'fill', source: SOURCE_GIPOD,
          paint: {
            'fill-color':   ['match', ['get', 'severity'], 'full_closure', '#E53935', '#FB8C00'],
            'fill-opacity': 0.35,
          },
        });
      }
      if (!map.getLayer(LAYER_OUTLINE)) {
        map.addLayer({
          id: LAYER_OUTLINE, type: 'line', source: SOURCE_GIPOD,
          paint: {
            'line-color':     ['match', ['get', 'severity'], 'full_closure', '#B71C1C', '#E65100'],
            'line-width':     2,
            'line-dasharray': [3, 2],
          },
        });
      }

      // ── Brussels Mobility ────────────────────────────────────────────────
      if (!map.getSource(SOURCE_BRUSSELS)) {
        map.addSource(SOURCE_BRUSSELS, { type: 'geojson', data: EMPTY_FC });
      }
      if (!map.getLayer(LAYER_BRUSSELS_CIRCLE)) {
        map.addLayer({
          id: LAYER_BRUSSELS_CIRCLE, type: 'circle', source: SOURCE_BRUSSELS,
          paint: {
            'circle-radius':       9,
            'circle-color':        ['match', ['get', 'severity'], 'full_closure', '#E53935', '#FB8C00'],
            'circle-stroke-width': 2,
            'circle-stroke-color': '#fff',
            'circle-opacity':      0.9,
          },
        });
      }

      // ── NDW (Netherlands) ────────────────────────────────────────────────
      if (!map.getSource(SOURCE_NDW)) {
        map.addSource(SOURCE_NDW, { type: 'geojson', data: EMPTY_FC });
      }
      if (!map.getLayer(LAYER_NDW_LINE)) {
        map.addLayer({
          id: LAYER_NDW_LINE, type: 'line', source: SOURCE_NDW,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color':   ['match', ['get', 'severity'], 'full_closure', '#E53935', '#FB8C00'],
            'line-width':   5,
            'line-opacity': 0.85,
          },
        });
      }

      // ── Luxembourg PCH ───────────────────────────────────────────────────
      if (!map.getSource(SOURCE_LUXEMBOURG)) {
        map.addSource(SOURCE_LUXEMBOURG, { type: 'geojson', data: EMPTY_FC });
      }
      if (!map.getLayer(LAYER_LUXEMBOURG_LINE)) {
        map.addLayer({
          id: LAYER_LUXEMBOURG_LINE, type: 'line', source: SOURCE_LUXEMBOURG,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color':   ['match', ['get', 'severity'], 'full_closure', '#E53935', '#FB8C00'],
            'line-width':   5,
            'line-opacity': 0.85,
          },
        });
      }

      // ── OpenStreetMap (Overpass) — crimson-shifted to distinguish from GIPOD
      if (!map.getSource(SOURCE_OSM)) {
        map.addSource(SOURCE_OSM, { type: 'geojson', data: EMPTY_FC });
      }
      if (!map.getLayer(LAYER_OSM_FILL)) {
        map.addLayer({
          id: LAYER_OSM_FILL, type: 'fill', source: SOURCE_OSM,
          filter: LAYER_BASE_FILTER[LAYER_OSM_FILL],
          paint: {
            'fill-color':   ['match', ['get', 'severity'], 'full_closure', '#C62828', '#E65100'],
            'fill-opacity': 0.25,
          },
        });
      }
      if (!map.getLayer(LAYER_OSM_LINE)) {
        map.addLayer({
          id: LAYER_OSM_LINE, type: 'line', source: SOURCE_OSM,
          filter: LAYER_BASE_FILTER[LAYER_OSM_LINE],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color':     ['match', ['get', 'severity'], 'full_closure', '#C62828', '#E65100'],
            'line-width':     4,
            'line-dasharray': [4, 3],
            'line-opacity':   0.85,
          },
        });
      }
      if (!map.getLayer(LAYER_OSM_CIRCLE)) {
        map.addLayer({
          id: LAYER_OSM_CIRCLE, type: 'circle', source: SOURCE_OSM,
          filter: LAYER_BASE_FILTER[LAYER_OSM_CIRCLE],
          paint: {
            'circle-radius':       7,
            'circle-color':        ['match', ['get', 'severity'], 'full_closure', '#C62828', '#E65100'],
            'circle-stroke-width': 2,
            'circle-stroke-color': '#fff',
            'circle-opacity':      0.9,
          },
        });
      }
    }

    _addHoverListeners(map) {
      const onHover = (e) => {
        if (!e.features || !e.features.length) return;
        this._cancelHide();
        if (this._popupDismiss) this._popupDismiss();
        this._popupDismiss = this._showPopup(map, e.lngLat, buildPopupHtml(e.features[0].properties));
      };

      const hoverLayers = [LAYER_FILL, LAYER_BRUSSELS_CIRCLE, LAYER_NDW_LINE, LAYER_LUXEMBOURG_LINE, LAYER_OSM_FILL, LAYER_OSM_LINE, LAYER_OSM_CIRCLE];
      hoverLayers.forEach((id) => {
        map.on('mouseenter', id, (e) => { map.getCanvas().style.cursor = 'pointer'; onHover(e); });
        map.on('mouseleave', id, ()  => { map.getCanvas().style.cursor = ''; this._scheduleHide(450); });
      });

      // Re-add layers after Komoot theme switch (style reload clears all layers)
      map.on('style.load', () => this._requestData());
    }

    _showPopup(map, lngLat, html) {
      const canvasContainer = map.getCanvasContainer
        ? map.getCanvasContainer()
        : map.getCanvas().parentElement;
      const mapContainer = canvasContainer.parentElement || canvasContainer;

      const prev = mapContainer.querySelector('.rw-popup-wrap');
      if (prev) prev.remove();

      const wrap = document.createElement('div');
      wrap.className = 'rw-popup-wrap';
      wrap.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:200;';

      const box = document.createElement('div');
      box.style.cssText = [
        'position:absolute',
        'background:#fff',
        'border-radius:6px',
        'padding:10px 14px',
        'box-shadow:0 2px 12px rgba(0,0,0,.22)',
        'pointer-events:auto',
        'max-width:280px',
        'transform:translate(-50%,-100%) translateY(-10px)',
        'font-family:-apple-system,BlinkMacSystemFont,sans-serif',
        'font-size:13px',
        'line-height:1.5',
      ].join(';');
      box.innerHTML = html;

      const closeBtn = document.createElement('button');
      closeBtn.textContent = '×';
      closeBtn.style.cssText = 'position:absolute;top:4px;right:6px;background:none;border:none;font-size:16px;cursor:pointer;color:#999;line-height:1;padding:0 2px;';
      box.appendChild(closeBtn);

      wrap.appendChild(box);
      if (getComputedStyle(mapContainer).position === 'static') {
        mapContainer.style.position = 'relative';
      }
      mapContainer.appendChild(wrap);

      function update() {
        const pt = map.project(lngLat);
        box.style.left = pt.x + 'px';
        box.style.top  = pt.y + 'px';
      }
      update();
      map.on('move', update);

      function dismiss() {
        if (!wrap.isConnected) return;
        wrap.remove();
        map.off('move', update);
      }

      box.addEventListener('mouseenter', () => this._cancelHide());
      box.addEventListener('mouseleave', () => this._scheduleHide(450));
      closeBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        clearTimeout(this._popupTimer);
        dismiss();
        this._popupDismiss = null;
      });

      return dismiss;
    }

    _scheduleHide(ms) {
      clearTimeout(this._popupTimer);
      this._popupTimer = setTimeout(() => {
        clearTimeout(this._popupTimer);
        if (this._popupDismiss) { this._popupDismiss(); this._popupDismiss = null; }
      }, ms || 450);
    }

    _cancelHide() {
      clearTimeout(this._popupTimer);
    }
  }

  // ── Layer / source constants ────────────────────────────────────────────────

  const SOURCE_GIPOD      = 'rw-gipod';
  const SOURCE_BRUSSELS   = 'rw-brussels';
  const SOURCE_NDW        = 'rw-ndw';
  const SOURCE_LUXEMBOURG = 'rw-luxembourg';
  const SOURCE_OSM        = 'rw-osm';

  const LAYER_FILL             = 'rw-fill';
  const LAYER_OUTLINE          = 'rw-outline';
  const LAYER_BRUSSELS_CIRCLE  = 'rw-brussels-circle';
  const LAYER_NDW_LINE         = 'rw-ndw-line';
  const LAYER_LUXEMBOURG_LINE  = 'rw-luxembourg-line';
  const LAYER_OSM_FILL         = 'rw-osm-fill';
  const LAYER_OSM_LINE         = 'rw-osm-line';
  const LAYER_OSM_CIRCLE       = 'rw-osm-circle';

  const ALL_LAYERS = [LAYER_FILL, LAYER_OUTLINE, LAYER_BRUSSELS_CIRCLE, LAYER_NDW_LINE, LAYER_LUXEMBOURG_LINE, LAYER_OSM_FILL, LAYER_OSM_LINE, LAYER_OSM_CIRCLE];

  // Base geometry-type filters — setLimitedVisible must compose with these.
  const LAYER_BASE_FILTER = {
    [LAYER_OSM_FILL]:   ['==', '$type', 'Polygon'],
    [LAYER_OSM_LINE]:   ['in', '$type', 'LineString', 'Polygon'],
    [LAYER_OSM_CIRCLE]: ['==', '$type', 'Point'],
  };

  const EMPTY_FC = { type: 'FeatureCollection', features: [] };

  // ── Adapter singleton ───────────────────────────────────────────────────────

  const adapter = new KomootAdapter();

  // ── Incoming messages ───────────────────────────────────────────────────────

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (!e.data || e.data.__rw !== FROM_CONTENT) return;

    const { type } = e.data;
    if (type === 'RW_DATA') {
      adapter.applyData(e.data.data || {});
    }
    if (type === 'RW_TOGGLE') {
      adapter.setVisible(e.data.enabled);
    }
    if (type === 'RW_TOGGLE_LIMITED') {
      adapter.setLimitedVisible(e.data.enabled);
    }
  });

  // ── Map detection (Komoot-specific) ────────────────────────────────────────
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
    console.log('[RoadWorks] Patched window lib (mapboxgl/maplibregl)');
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

  // ── React fiber walk (handles Komoot's bundled MapLibre) ───────────────────

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

  // ── Popup rendering ─────────────────────────────────────────────────────────

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function buildPopupHtml(p) {
    const fmt = (iso) => iso
      ? new Date(iso).toLocaleDateString('nl-BE', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : '—';
    const severityBadge = p.severity === 'full_closure'
      ? '<span style="color:#E53935;font-weight:bold">⛔ Geen doorgang voor fietsers</span>'
      : '<span style="color:#FB8C00;font-weight:bold">⚠️ Beperkte doorgang voor fietsers</span>';
    const locationLine = p.location
      ? `<div style="margin-top:4px;color:#555">📍 ${escHtml(p.location)}</div>` : '';
    return `<div>
      <div style="font-weight:600;margin-bottom:4px;padding-right:18px">${escHtml(p.description || 'Wegwerken')}</div>
      ${severityBadge}
      ${locationLine}
      <div style="margin-top:6px;color:#555">
        📅 ${fmt(p.start)} → ${fmt(p.end)}<br>
        🏢 ${escHtml(p.owner || '—')}
      </div>
    </div>`;
  }

  // Signal that the message listener is live; content.js responds with stored preferences.
  toContent('RW_READY', {});
})();
