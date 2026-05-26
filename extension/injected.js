/**
 * injected.js — runs in the PAGE context (not the extension context).
 *
 * Injected by content.js as a <script> tag so it can access window globals
 * like mapboxgl / maplibregl that Komoot's own bundle uses.
 *
 * Communication with content.js uses window.postMessage with a source tag.
 */
(function () {
  'use strict';

  const FROM_PAGE    = 'rw-from-page';
  const FROM_CONTENT = 'rw-from-content';

  // ── State ────────────────────────────────────────────────────────────────

  let activeMap   = null;
  let overlayOn   = true;
  let showLimited = true;  // show partial / limited-access features
  let _popupTimer   = null;   // setTimeout handle for sticky hover
  let _popupDismiss = null;   // dismiss fn for the currently open popup

  const SOURCE_HINDRANCE      = 'rw-hindrances';
  const SOURCE_DIVERSION      = 'rw-diversions';
  const SOURCE_BRUSSELS       = 'rw-brussels';
  const SOURCE_NDW             = 'rw-ndw';
  const SOURCE_OSM             = 'rw-osm';
  const LAYER_FILL             = 'rw-fill';
  const LAYER_OUTLINE          = 'rw-outline';
  const LAYER_DIVERSION        = 'rw-diversion';
  const LAYER_BRUSSELS_CIRCLE  = 'rw-brussels-circle';
  const LAYER_NDW_LINE         = 'rw-ndw-line';
  const LAYER_OSM_FILL         = 'rw-osm-fill';
  const LAYER_OSM_LINE         = 'rw-osm-line';
  const LAYER_OSM_CIRCLE       = 'rw-osm-circle';

  // ── Message bridge (page → content) ─────────────────────────────────────

  function toContent(type, payload) {
    window.postMessage({ __rw: FROM_PAGE, type, ...payload }, '*');
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (!e.data || e.data.__rw !== FROM_CONTENT) return;

    const { type } = e.data;

    if (type === 'RW_DATA' && activeMap) {
      applyData(activeMap, e.data.hindrances, e.data.brussels, e.data.ndw, e.data.diversions, e.data.osm);
    }

    if (type === 'RW_TOGGLE') {
      overlayOn = e.data.enabled;
      setVisible(activeMap, overlayOn);
    }

    if (type === 'RW_TOGGLE_LIMITED') {
      showLimited = e.data.enabled;
      setLimitedVisible(activeMap, showLimited);
    }
  });

  // ── Layer management ─────────────────────────────────────────────────────

  function addLayers(map) {
    // Sources
    if (!map.getSource(SOURCE_HINDRANCE)) {
      map.addSource(SOURCE_HINDRANCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }
    if (!map.getSource(SOURCE_DIVERSION)) {
      map.addSource(SOURCE_DIVERSION, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }

    // Hindrance fill
    if (!map.getLayer(LAYER_FILL)) {
      map.addLayer({
        id:     LAYER_FILL,
        type:   'fill',
        source: SOURCE_HINDRANCE,
        paint: {
          'fill-color': [
            'match', ['get', 'severity'],
            'full_closure', '#E53935',
            /* default */   '#FB8C00',
          ],
          'fill-opacity': 0.35,
        },
      });
    }

    // Hindrance outline
    if (!map.getLayer(LAYER_OUTLINE)) {
      map.addLayer({
        id:     LAYER_OUTLINE,
        type:   'line',
        source: SOURCE_HINDRANCE,
        paint: {
          'line-color': [
            'match', ['get', 'severity'],
            'full_closure', '#B71C1C',
            /* default */   '#E65100',
          ],
          'line-width':    2,
          'line-dasharray': [3, 2],
        },
      });
    }

    // Brussels events (Point geometry) — rendered as circles on a separate source
    if (!map.getSource(SOURCE_BRUSSELS)) {
      map.addSource(SOURCE_BRUSSELS, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }
    if (!map.getLayer(LAYER_BRUSSELS_CIRCLE)) {
      map.addLayer({
        id:     LAYER_BRUSSELS_CIRCLE,
        type:   'circle',
        source: SOURCE_BRUSSELS,
        paint: {
          'circle-radius': 9,
          'circle-color': [
            'match', ['get', 'severity'],
            'full_closure', '#E53935',
            /* partial */ '#FB8C00',
          ],
          'circle-stroke-width':  2,
          'circle-stroke-color': '#fff',
          'circle-opacity':       0.9,
        },
      });
    }

    // Diversion line — hidden by default (layer not added)

    // Netherlands NDW closures (LineString geometry)
    if (!map.getSource(SOURCE_NDW)) {
      map.addSource(SOURCE_NDW, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }
    if (!map.getLayer(LAYER_NDW_LINE)) {
      map.addLayer({
        id:     LAYER_NDW_LINE,
        type:   'line',
        source: SOURCE_NDW,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': [
            'match', ['get', 'severity'],
            'full_closure', '#E53935',
            /* partial */ '#FB8C00',
          ],
          'line-width':   5,
          'line-opacity': 0.85,
        },
      });
    }

    // OSM construction data (Overpass) — crimson-shifted tints, dashed lines
    if (!map.getSource(SOURCE_OSM)) {
      map.addSource(SOURCE_OSM, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }
    // Fill for polygon features (landuse=construction areas)
    if (!map.getLayer(LAYER_OSM_FILL)) {
      map.addLayer({
        id:     LAYER_OSM_FILL,
        type:   'fill',
        source: SOURCE_OSM,
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: {
          'fill-color': [
            'match', ['get', 'severity'],
            'full_closure', '#C62828',
            /* partial */ '#E65100',
          ],
          'fill-opacity': 0.25,
        },
      });
    }
    // Outline for both linear and polygon features
    if (!map.getLayer(LAYER_OSM_LINE)) {
      map.addLayer({
        id:     LAYER_OSM_LINE,
        type:   'line',
        source: SOURCE_OSM,
        filter: ['any', ['==', ['geometry-type'], 'LineString'], ['==', ['geometry-type'], 'Polygon']],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': [
            'match', ['get', 'severity'],
            'full_closure', '#C62828',
            /* partial */ '#E65100',
          ],
          'line-width':    4,
          'line-dasharray': [4, 3],
          'line-opacity':  0.85,
        },
      });
    }
    if (!map.getLayer(LAYER_OSM_CIRCLE)) {
      map.addLayer({
        id:     LAYER_OSM_CIRCLE,
        type:   'circle',
        source: SOURCE_OSM,
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 7,
          'circle-color': [
            'match', ['get', 'severity'],
            'full_closure', '#C62828',
            /* partial */ '#E65100',
          ],
          'circle-stroke-width':  2,
          'circle-stroke-color': '#fff',
          'circle-opacity':       0.9,
        },
      });
    }

    // Hover popup with sticky grace period — lets the user move mouse to the popup and click links.
    // mouseleave → 450 ms countdown; mouseenter on popup → cancel; mouseleave popup → restart.
    function onFeatureHover(e) {
      if (!e.features || !e.features.length) return;
      cancelHide();
      const html = buildPopupHtml(e.features[0].properties);
      if (_popupDismiss) { _popupDismiss(); }
      _popupDismiss = showPopup(map, e.lngLat, html);
    }

    map.on('mouseenter', LAYER_FILL,            (e) => { map.getCanvas().style.cursor = 'pointer'; onFeatureHover(e); });
    map.on('mouseleave', LAYER_FILL,            ()  => { map.getCanvas().style.cursor = ''; scheduleHide(450); });
    map.on('mouseenter', LAYER_BRUSSELS_CIRCLE, (e) => { map.getCanvas().style.cursor = 'pointer'; onFeatureHover(e); });
    map.on('mouseleave', LAYER_BRUSSELS_CIRCLE, ()  => { map.getCanvas().style.cursor = ''; scheduleHide(450); });
    map.on('mouseenter', LAYER_NDW_LINE,        (e) => { map.getCanvas().style.cursor = 'pointer'; onFeatureHover(e); });
    map.on('mouseleave', LAYER_NDW_LINE,        ()  => { map.getCanvas().style.cursor = ''; scheduleHide(450); });
    map.on('mouseenter', LAYER_OSM_FILL,        (e) => { map.getCanvas().style.cursor = 'pointer'; onFeatureHover(e); });
    map.on('mouseleave', LAYER_OSM_FILL,        ()  => { map.getCanvas().style.cursor = ''; scheduleHide(450); });
    map.on('mouseenter', LAYER_OSM_LINE,        (e) => { map.getCanvas().style.cursor = 'pointer'; onFeatureHover(e); });
    map.on('mouseleave', LAYER_OSM_LINE,        ()  => { map.getCanvas().style.cursor = ''; scheduleHide(450); });
    map.on('mouseenter', LAYER_OSM_CIRCLE,      (e) => { map.getCanvas().style.cursor = 'pointer'; onFeatureHover(e); });
    map.on('mouseleave', LAYER_OSM_CIRCLE,      ()  => { map.getCanvas().style.cursor = ''; scheduleHide(450); });

    // Re-add layers after a style reload (Komoot may switch themes)
    map.on('style.load', () => {
      // Sources & layers are wiped on style change; re-add them on next data arrival
      requestData(map);
    });
  }

  function applyData(map, hindrances, brussels, ndw, diversions, osm) {
    if (!map || !map.isStyleLoaded()) return;

    // Ensure layers exist (e.g. after style reload)
    if (!map.getLayer(LAYER_FILL)) {
      addLayers(map);
      setLimitedVisible(map, showLimited); // restore filter after re-add
    }

    const hSrc = map.getSource(SOURCE_HINDRANCE);
    const bSrc = map.getSource(SOURCE_BRUSSELS);
    const nSrc = map.getSource(SOURCE_NDW);
    const dSrc = map.getSource(SOURCE_DIVERSION);
    const oSrc = map.getSource(SOURCE_OSM);
    if (hSrc) hSrc.setData(hindrances || { type: 'FeatureCollection', features: [] });
    if (bSrc) bSrc.setData(brussels   || { type: 'FeatureCollection', features: [] });
    if (nSrc) nSrc.setData(ndw        || { type: 'FeatureCollection', features: [] });
    if (dSrc) dSrc.setData(diversions || { type: 'FeatureCollection', features: [] });
    if (oSrc) oSrc.setData(osm        || { type: 'FeatureCollection', features: [] });
    const hCount = (hindrances && hindrances.features) ? hindrances.features.length : 0;
    const bCount = (brussels   && brussels.features)   ? brussels.features.length   : 0;
    const nCount = (ndw        && ndw.features)        ? ndw.features.length        : 0;
    const dCount = (diversions && diversions.features) ? diversions.features.length : 0;
    const oCount = (osm        && osm.features)        ? osm.features.length        : 0;
    if (hCount + bCount + nCount + dCount + oCount > 0) {
      console.log(`[RoadWorks] ${hCount} GIPOD, ${bCount} Brussels, ${nCount} NDW, ${dCount} diversions, ${oCount} OSM`);
    }
  }

  function setVisible(map, visible) {
    if (!map) return;
    const v = visible ? 'visible' : 'none';
    [LAYER_FILL, LAYER_OUTLINE, LAYER_BRUSSELS_CIRCLE, LAYER_NDW_LINE, LAYER_DIVERSION, LAYER_OSM_FILL, LAYER_OSM_LINE, LAYER_OSM_CIRCLE].forEach((id) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
    });
  }

  function setLimitedVisible(map, visible) {
    if (!map) return;
    const filter = visible ? null : ['==', ['get', 'severity'], 'full_closure'];
    [LAYER_FILL, LAYER_OUTLINE, LAYER_BRUSSELS_CIRCLE, LAYER_NDW_LINE, LAYER_OSM_FILL, LAYER_OSM_LINE, LAYER_OSM_CIRCLE].forEach((id) => {
      if (map.getLayer(id)) map.setFilter(id, filter);
    });
  }

  // ── Data request ─────────────────────────────────────────────────────────

  let _fetchTimer = null;

  function requestData(map) {
    if (!map || !overlayOn) return;
    const zoom = map.getZoom();
    if (zoom < 8) return; // Skip at very low zoom — too broad for cycling context

    clearTimeout(_fetchTimer);
    _fetchTimer = setTimeout(() => {
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

  // ── Map initialisation ───────────────────────────────────────────────────

  function onMapReady(map) {
    // Skip very small maps (minimap previews, thumbnails)
    const container = map.getContainer && map.getContainer();
    if (container && container.offsetWidth < 200) return;

    if (activeMap === map) return;
    activeMap = map;
    console.log('[RoadWorks] Map detected ✓');

    // Add overlay layers once the map style is ready
    const doInit = () => {
      addLayers(map);
      requestData(map);
    };

    if (map.isStyleLoaded()) {
      doInit();
    } else {
      map.once('load', doInit);
    }

    // Refresh on every pan/zoom
    map.on('moveend', () => requestData(map));
  }

  // ── DOM popup (no MapLib reference needed) ──────────────────────────────

  function showPopup(map, lngLat, html) {
    const canvasContainer = map.getCanvasContainer
      ? map.getCanvasContainer()
      : map.getCanvas().parentElement;
    const mapContainer = canvasContainer.parentElement || canvasContainer;

    // Remove existing popup
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

    // Close button
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

    // Sticky hover: moving mouse onto the popup cancels the hide timer,
    // moving off restarts it — so the user can click the "Meer info" link.
    box.addEventListener('mouseenter', cancelHide);
    box.addEventListener('mouseleave', () => scheduleHide(450));

    closeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      clearTimeout(_popupTimer);
      dismiss();
      _popupDismiss = null;
    });

    return dismiss;
  }

  // ── Mapbox/MapLibre GL patch ─────────────────────────────────────────────

  function patchLib(lib) {
    if (!lib || !lib.Map || lib.Map.__rwPatched) return;

    const OrigCtor = lib.Map;

    // Wrap the constructor to intercept new map instances
    function PatchedMap(options) {
      const inst = new OrigCtor(options);
      inst.once('load', () => onMapReady(inst));
      return inst;
    }
    PatchedMap.prototype  = OrigCtor.prototype;
    PatchedMap.__rwPatched = true;
    // Copy static members
    Object.keys(OrigCtor).forEach((k) => { PatchedMap[k] = OrigCtor[k]; });

    lib.Map = PatchedMap;
    console.log('[RoadWorks] Patched window lib (mapboxgl/maplibregl)');
  }

  function installInterceptors() {
    // Intercept future assignments of mapboxgl / maplibregl on window
    ['mapboxgl', 'maplibregl'].forEach((name) => {
      let _val = window[name];
      try {
        Object.defineProperty(window, name, {
          get() { return _val; },
          set(v) {
            _val = v;
            if (v && v.Map) patchLib(v);
          },
          configurable: true,
        });
      } catch (_) {
        // defineProperty might fail if the property is already non-configurable
      }
    });
  }

  // Try to patch immediately if mapboxgl/maplibregl are already on window
  if (window.mapboxgl) patchLib(window.mapboxgl);
  if (window.maplibregl) patchLib(window.maplibregl);

  // Install interceptors for deferred library assignments
  installInterceptors();

  // Polling fallback — covers edge cases where defineProperty is bypassed
  let pollCount = 0;
  const poll = setInterval(() => {
    if (++pollCount > 150) { clearInterval(poll); return; }
    if (window.mapboxgl   && !window.mapboxgl.Map.__rwPatched)   patchLib(window.mapboxgl);
    if (window.maplibregl && !window.maplibregl.Map.__rwPatched) patchLib(window.maplibregl);
    if (activeMap) clearInterval(poll);
  }, 200);

  // ── DOM-based detection (bundled MapLibre, e.g. Komoot) ──────────────────

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
    return findMapInFiber(fiber.child, depth + 1)
        || findMapInFiber(fiber.sibling, depth + 1)
        || findMapInFiber(fiber.return, depth + 1);
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
      if (activeMap) return true;
      const canvas = document.querySelector('.maplibregl-canvas');
      if (!canvas) return false;
      const map = tryGetMapFromCanvas(canvas);
      if (map) { onMapReady(map); return true; }
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

  // Start DOM-based detection (handles bundled MapLibre like Komoot)
  waitForMapViaDOM();

  // ── Utilities ────────────────────────────────────────────────────────────

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

  function dismissPopup() {
    clearTimeout(_popupTimer);
    if (_popupDismiss) { _popupDismiss(); _popupDismiss = null; }
  }

  function scheduleHide(ms) {
    clearTimeout(_popupTimer);
    _popupTimer = setTimeout(dismissPopup, ms || 450);
  }

  function cancelHide() {
    clearTimeout(_popupTimer);
  }
})();
