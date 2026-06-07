/**
 * StravaAdapter — page-context script, injected before injected-strava.js.
 *
 * Defines globals used by injected-strava.js:
 *   - toContent(type, payload)  — send a postMessage to content.js
 *   - StravaAdapter             — the adapter class
 *
 * This file is NOT an ES module (no import/export). It is injected as a
 * plain <script> tag so its top-level declarations become page globals,
 * accessible to the injected-strava.js script that loads after it.
 */

// ── Message bridge (page → content) ──────────────────────────────────────────

const FROM_PAGE = 'rw-from-page';

function toContent(type, payload) {
  window.postMessage({ __rw: FROM_PAGE, type, ...payload }, '*');
}

// ── Layer / source constants ──────────────────────────────────────────────────

const SOURCE_FLANDERS   = 'rw-flanders';
const SOURCE_BRUSSELS   = 'rw-brussels';
const SOURCE_NDW        = 'rw-ndw';
const SOURCE_LUXEMBOURG = 'rw-luxembourg';
const SOURCE_OSM        = 'rw-osm';

const LAYER_FILL            = 'rw-fill';
const LAYER_OUTLINE         = 'rw-outline';
const LAYER_BRUSSELS_CIRCLE = 'rw-brussels-circle';
const LAYER_NDW_LINE        = 'rw-ndw-line';
const LAYER_LUXEMBOURG_LINE = 'rw-luxembourg-line';
const LAYER_OSM_FILL        = 'rw-osm-fill';
const LAYER_OSM_LINE        = 'rw-osm-line';
const LAYER_OSM_CIRCLE      = 'rw-osm-circle';

const ALL_LAYERS = [
  LAYER_FILL, LAYER_OUTLINE, LAYER_BRUSSELS_CIRCLE,
  LAYER_NDW_LINE, LAYER_LUXEMBOURG_LINE,
  LAYER_OSM_FILL, LAYER_OSM_LINE, LAYER_OSM_CIRCLE,
];

const LAYER_BASE_FILTER = {
  [LAYER_OSM_FILL]:   ['==', '$type', 'Polygon'],
  [LAYER_OSM_LINE]:   ['in', '$type', 'LineString', 'Polygon'],
  [LAYER_OSM_CIRCLE]: ['==', '$type', 'Point'],
};

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

// ── Popup helpers ─────────────────────────────────────────────────────────────

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

// ── StravaAdapter ─────────────────────────────────────────────────────────────

class StravaAdapter {
  constructor() {
    this._map          = null;
    this._overlayOn    = true;
    this._showLimited  = true;
    this._popupTimer   = null;
    this._popupDismiss = null;
    this._fetchTimer   = null;
    this._hoverKey     = null;
  }

  // ── Public interface (mirrors RouteplannerAdapter) ────────────────────────

  onMapReady(map) {
    if (this._map === map) return;
    this._map = map;
    console.log('[RoadWorks] Strava map detected ✓');

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

  applyData(dataBySource) {
    const map = this._map;
    if (!map || !map.isStyleLoaded()) return;

    if (!map.getLayer(LAYER_FILL)) {
      this._addLayers(map);
      this.setLimitedVisible(this._showLimited);
    }

    const empty      = EMPTY_FC;
    const flanders   = dataBySource.flanders   || empty;
    const brussels   = dataBySource.brussels   || empty;
    const ndw        = dataBySource.ndw        || empty;
    const luxembourg = dataBySource.luxembourg || empty;
    const osm        = dataBySource.osm        || empty;

    const fSrc = map.getSource(SOURCE_FLANDERS);
    const bSrc = map.getSource(SOURCE_BRUSSELS);
    const nSrc = map.getSource(SOURCE_NDW);
    const lSrc = map.getSource(SOURCE_LUXEMBOURG);
    const oSrc = map.getSource(SOURCE_OSM);
    if (fSrc) fSrc.setData(flanders);
    if (bSrc) bSrc.setData(brussels);
    if (nSrc) nSrc.setData(ndw);
    if (lSrc) lSrc.setData(luxembourg);
    if (oSrc) oSrc.setData(osm);

    const total = flanders.features.length + brussels.features.length +
                  ndw.features.length      + luxembourg.features.length + osm.features.length;
    if (total > 0) {
      console.log(`[RoadWorks] ${flanders.features.length} Flanders, ${brussels.features.length} Brussels, ${ndw.features.length} NDW, ${luxembourg.features.length} Luxembourg, ${osm.features.length} OSM`);
    }
  }

  setVisible(visible) {
    this._overlayOn = visible;
    const map = this._map;
    if (!map) return;
    const v = visible ? 'visible' : 'none';
    ALL_LAYERS.forEach((id) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
    });
  }

  setLimitedVisible(showLimited) {
    this._showLimited = showLimited;
    const map = this._map;
    if (!map) return;
    const severityFilter = ['==', ['get', 'severity'], 'full_closure'];
    ALL_LAYERS.forEach((id) => {
      if (!map.getLayer(id)) return;
      const base = LAYER_BASE_FILTER[id] || null;
      const filter = showLimited ? base : (base ? ['all', base, severityFilter] : severityFilter);
      map.setFilter(id, filter);
    });
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  _requestData() {
    const map = this._map;
    if (!map || !this._overlayOn) return;
    if (map.getZoom() < 8) return;

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
    // ── Flanders (GIPOD) ───────────────────────────────────────────────────
    if (!map.getSource(SOURCE_FLANDERS)) {
      map.addSource(SOURCE_FLANDERS, { type: 'geojson', data: EMPTY_FC });
    }
    if (!map.getLayer(LAYER_FILL)) {
      map.addLayer({
        id: LAYER_FILL, type: 'fill', source: SOURCE_FLANDERS,
        paint: {
          'fill-color':   ['match', ['get', 'severity'], 'full_closure', '#E53935', '#FB8C00'],
          'fill-opacity': 0.35,
        },
      });
    }
    if (!map.getLayer(LAYER_OUTLINE)) {
      map.addLayer({
        id: LAYER_OUTLINE, type: 'line', source: SOURCE_FLANDERS,
        paint: {
          'line-color':     ['match', ['get', 'severity'], 'full_closure', '#B71C1C', '#E65100'],
          'line-width':     2,
          'line-dasharray': [3, 2],
        },
      });
    }

    // ── Brussels Mobility ─────────────────────────────────────────────────
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

    // ── NDW (Netherlands) ─────────────────────────────────────────────────
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

    // ── Luxembourg PCH ────────────────────────────────────────────────────
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

    // ── OpenStreetMap (Overpass) ──────────────────────────────────────────
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
    const mapCanvas = map.getCanvas();

    // Strava renders its own canvas on top of MapLibre's for route-drawing.
    // Find it from the full document — it may sit outside getCanvasContainer() on some URLs.
    // Listen directly on it so Strava's stopPropagation calls don't block us.
    const overlayCanvas = [...document.querySelectorAll('canvas')]
      .find(c => c !== mapCanvas) || mapCanvas;

    const hoverLayerIds = [
      LAYER_FILL, LAYER_BRUSSELS_CIRCLE, LAYER_NDW_LINE,
      LAYER_LUXEMBOURG_LINE, LAYER_OSM_FILL, LAYER_OSM_LINE, LAYER_OSM_CIRCLE,
    ];

    overlayCanvas.addEventListener('mousemove', (e) => {
      const rect  = mapCanvas.getBoundingClientRect();
      const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const validLayers = hoverLayerIds.filter(id => map.getLayer(id));
      if (!validLayers.length) return;

      const features = map.queryRenderedFeatures(point, { layers: validLayers });
      if (features.length > 0) {
        const f   = features[0];
        const key = f.layer.id + '|' + JSON.stringify(f.properties).slice(0, 60);
        overlayCanvas.style.cursor = 'pointer';
        this._cancelHide();
        if (key !== this._hoverKey || !this._popupDismiss) {
          if (this._popupDismiss) this._popupDismiss();
          this._popupDismiss = this._showPopup(map, map.unproject(point), buildPopupHtml(f.properties));
          this._hoverKey = key;
        }
      } else if (this._hoverKey !== null) {
        // Only trigger on the feature→nothing transition; mousemove fires faster than the timer.
        overlayCanvas.style.cursor = '';
        this._hoverKey = null;
        this._scheduleHide(450);
      }
    });

    overlayCanvas.addEventListener('mouseleave', () => {
      overlayCanvas.style.cursor = '';
      this._hoverKey = null;
      this._scheduleHide(450);
    });

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
