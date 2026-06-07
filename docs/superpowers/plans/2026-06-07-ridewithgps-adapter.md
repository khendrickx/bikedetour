# RideWithGPS Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a BikeDetour overlay to RideWithGPS route pages (`/routes/new`, `/routes/*`) by creating a `RideWithGPSAdapter` that supports both Leaflet and MapLibre GL map libraries at runtime.

**Architecture:** Three new files slot into the existing pattern — a content script (`content-ridewithgps.js`) injects `RideWithGPSAdapter.js` then `injected-ridewithgps.js` into the page context. The adapter detects the map library via `map.getSource` and branches between MapLibre GL (sources + layers, same as KomootAdapter) and Leaflet (`L.geoJSON` layer groups). The background service worker and data pipeline are untouched.

**Tech Stack:** Vanilla JS (no modules — page-context scripts are plain `<script>` tags), Manifest V3, Leaflet 1.x API (`L.geoJSON`, `L.layerGroup`, `L.circleMarker`), MapLibre GL API (same as Komoot).

**Spec:** `docs/superpowers/specs/2026-06-07-ridewithgps-adapter-design.md`

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `extension/content-ridewithgps.js` | Content script: inject adapter + injected scripts; bridge popup↔page, page→background |
| Create | `extension/adapters/RideWithGPSAdapter.js` | Adapter class + all shared globals; MapLibre path (sources/layers/popup); Leaflet path (layerGroups/geoJSON) |
| Create | `extension/injected-ridewithgps.js` | Instantiate adapter; Leaflet + MapLibre detection (interceptors + DOM polling); signal RW_READY |
| Modify | `extension/manifest.json` | Add content_scripts entry + web_accessible_resources entry for ridewithgps.com |
| Modify | `extension-firefox/manifest.json` | Same as above |
| Modify | `agents.md` | Update architecture diagram, Key Files table, Common Pitfalls |

---

## Task 1: Update Both Manifests

**Files:**
- Modify: `extension/manifest.json`
- Modify: `extension-firefox/manifest.json`

- [ ] **Step 1: Add content_scripts and web_accessible_resources to `extension/manifest.json`**

The file currently has one entry in each array. Add a second entry to each.

`content_scripts` — add after the existing komoot entry:
```json
{
  "matches": [
    "https://ridewithgps.com/routes/new",
    "https://ridewithgps.com/routes/*"
  ],
  "js": ["content-ridewithgps.js"],
  "run_at": "document_start"
}
```

`web_accessible_resources` — add after the existing komoot entry:
```json
{
  "resources": ["adapters/RideWithGPSAdapter.js", "injected-ridewithgps.js"],
  "matches": ["https://ridewithgps.com/*"]
}
```

- [ ] **Step 2: Apply the identical change to `extension-firefox/manifest.json`**

Same two additions as Step 1 — the Firefox manifest mirrors the Chrome manifest for these fields.

- [ ] **Step 3: Verify both manifests parse as valid JSON**

```bash
node -e "require('./extension/manifest.json'); console.log('Chrome OK')"
node -e "require('./extension-firefox/manifest.json'); console.log('Firefox OK')"
```

Expected output:
```
Chrome OK
Firefox OK
```

- [ ] **Step 4: Commit**

```bash
git add extension/manifest.json extension-firefox/manifest.json
git commit -m "feat: add RideWithGPS manifest entries (content script + web_accessible_resources)"
```

---

## Task 2: Create `extension/content-ridewithgps.js`

**Files:**
- Create: `extension/content-ridewithgps.js`

This is a near-copy of `extension/content.js`. The only difference is line 31: it injects `RideWithGPSAdapter.js` then `injected-ridewithgps.js` instead of the Komoot equivalents.

- [ ] **Step 1: Create the file**

```js
/**
 * content-ridewithgps.js — Content Script for RideWithGPS
 * Injected into ridewithgps.com/routes/* at document_start.
 *
 * Responsibilities:
 *  1. Inject RideWithGPSAdapter.js + injected-ridewithgps.js into the page context.
 *  2. Bridge data requests from injected-ridewithgps.js → background service worker.
 *  3. Forward toggle commands from the popup → injected-ridewithgps.js.
 */

(function () {
  'use strict';

  const FROM_PAGE    = 'rw-from-page';
  const FROM_CONTENT = 'rw-from-content';

  // ── 1. Inject page-context scripts ────────────────────────────────────────
  function injectScript(path, next) {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL(path);
    script.addEventListener('load', () => { script.remove(); if (next) next(); });
    (document.head || document.documentElement).appendChild(script);
  }

  injectScript('adapters/RideWithGPSAdapter.js', () => injectScript('injected-ridewithgps.js'));

  // ── 2. Bridge: page → background ─────────────────────────────────────────
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (!e.data || e.data.__rw !== FROM_PAGE) return;

    if (e.data.type === 'RW_READY') {
      chrome.storage.local.get(['overlayEnabled', 'showLimitedAccess'], ({ overlayEnabled, showLimitedAccess }) => {
        window.postMessage({ __rw: FROM_CONTENT, type: 'RW_TOGGLE',         enabled: overlayEnabled    !== false }, '*');
        window.postMessage({ __rw: FROM_CONTENT, type: 'RW_TOGGLE_LIMITED', enabled: showLimitedAccess !== false }, '*');
      });
    }

    if (e.data.type === 'RW_FETCH') {
      chrome.runtime.sendMessage(
        { type: 'FETCH_ROADWORKS', bbox: e.data.bbox },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[BikeDetour]', chrome.runtime.lastError.message);
            return;
          }
          if (response && response.success) {
            window.postMessage({
              __rw: FROM_CONTENT,
              type: 'RW_DATA',
              data: response.data,
            }, '*');
          }
        }
      );
    }
  });

  // ── 3. Bridge: popup → page ───────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'TOGGLE') {
      window.postMessage({ __rw: FROM_CONTENT, type: 'RW_TOGGLE',         enabled: message.enabled }, '*');
    }
    if (message.type === 'TOGGLE_LIMITED') {
      window.postMessage({ __rw: FROM_CONTENT, type: 'RW_TOGGLE_LIMITED', enabled: message.enabled }, '*');
    }
  });

})();
```

- [ ] **Step 2: Commit**

```bash
git add extension/content-ridewithgps.js
git commit -m "feat: add content-ridewithgps.js content script"
```

---

## Task 3: Create `extension/adapters/RideWithGPSAdapter.js`

**Files:**
- Create: `extension/adapters/RideWithGPSAdapter.js`

This is the largest file. It defines all page-global constants and the `RideWithGPSAdapter` class. The MapLibre path is functionally identical to `KomootAdapter`; the Leaflet path uses `L.geoJSON` layer groups.

**Key points before writing:**
- No IIFE, no ES modules — top-level `const`/`function`/`class` become page globals consumed by `injected-ridewithgps.js`.
- `toContent`, `escHtml`, `buildPopupHtml`, and layer/source constants are copied from `KomootAdapter.js` (they cannot be imported).
- `_mapType` is set in `onMapReady` to `'maplibre'` or `'leaflet'` by checking `typeof map.getSource === 'function'`.
- Leaflet: `_leafletLayers` is a `{ [sourceKey]: L.layerGroup }` map. `_lastData` stores the last `dataBySource` so `setLimitedVisible` can re-render.
- Both `getZoom()`, `getBounds()` (returning an object with `getWest/East/North/South`), and `on('moveend', ...)` work identically in Leaflet and MapLibre GL — `_requestData` is shared.

- [ ] **Step 1: Create `extension/adapters/RideWithGPSAdapter.js`**

```js
/**
 * RideWithGPSAdapter — page-context script, injected before injected-ridewithgps.js.
 *
 * Defines globals used by injected-ridewithgps.js:
 *   - toContent(type, payload)  — send a postMessage to content-ridewithgps.js
 *   - RideWithGPSAdapter        — the adapter class
 *
 * Supports both MapLibre GL (map.getSource exists) and Leaflet (L.geoJSON).
 * Library is detected once in onMapReady() and stored as this._mapType.
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

// Ordered list of source keys matching DataSource.id values
const SOURCE_KEYS = ['flanders', 'brussels', 'ndw', 'luxembourg', 'osm'];

// ── Popup helpers (shared by both map library paths) ─────────────────────────

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

// ── RideWithGPSAdapter ────────────────────────────────────────────────────────

class RideWithGPSAdapter {
  constructor() {
    this._map          = null;
    this._mapType      = null;   // 'maplibre' | 'leaflet'
    this._overlayOn    = true;
    this._showLimited  = true;
    this._fetchTimer   = null;
    this._lastData     = null;

    // MapLibre-specific popup state
    this._popupTimer   = null;
    this._popupDismiss = null;

    // Leaflet-specific: one L.layerGroup per source key
    this._leafletLayers = null;
  }

  // ── Public interface ──────────────────────────────────────────────────────

  onMapReady(map) {
    if (this._map === map) return;
    this._map = map;
    this._mapType = typeof map.getSource === 'function' ? 'maplibre' : 'leaflet';
    console.log(`[BikeDetour] RideWithGPS map detected (${this._mapType}) ✓`);

    if (this._mapType === 'maplibre') {
      this._onMapReadyMapLibre(map);
    } else {
      this._onMapReadyLeaflet(map);
    }
  }

  applyData(dataBySource) {
    if (!this._map) return;
    this._lastData = dataBySource;

    if (this._mapType === 'maplibre') {
      this._applyDataMapLibre(dataBySource);
    } else {
      this._applyDataLeaflet(dataBySource);
    }
  }

  setVisible(visible) {
    this._overlayOn = visible;
    if (!this._map) return;

    if (this._mapType === 'maplibre') {
      const v = visible ? 'visible' : 'none';
      ALL_LAYERS.forEach((id) => {
        if (this._map.getLayer(id)) this._map.setLayoutProperty(id, 'visibility', v);
      });
    } else {
      this._setVisibleLeaflet(visible);
    }
  }

  setLimitedVisible(showLimited) {
    this._showLimited = showLimited;
    if (!this._map) return;

    if (this._mapType === 'maplibre') {
      const severityFilter = ['==', ['get', 'severity'], 'full_closure'];
      ALL_LAYERS.forEach((id) => {
        if (!this._map.getLayer(id)) return;
        const base = LAYER_BASE_FILTER[id] || null;
        const filter = showLimited ? base : (base ? ['all', base, severityFilter] : severityFilter);
        this._map.setFilter(id, filter);
      });
    } else if (this._lastData) {
      this._applyDataLeaflet(this._lastData);
    }
  }

  // ── MapLibre path ─────────────────────────────────────────────────────────

  _onMapReadyMapLibre(map) {
    this._addHoverListenersMapLibre(map);

    const doInit = () => {
      this._addLayersMapLibre(map);
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

  _applyDataMapLibre(dataBySource) {
    const map = this._map;
    if (!map.isStyleLoaded()) return;

    if (!map.getLayer(LAYER_FILL)) {
      this._addLayersMapLibre(map);
      this.setLimitedVisible(this._showLimited);
    }

    const empty = EMPTY_FC;
    const fSrc = map.getSource(SOURCE_FLANDERS);
    const bSrc = map.getSource(SOURCE_BRUSSELS);
    const nSrc = map.getSource(SOURCE_NDW);
    const lSrc = map.getSource(SOURCE_LUXEMBOURG);
    const oSrc = map.getSource(SOURCE_OSM);
    if (fSrc) fSrc.setData(dataBySource.flanders   || empty);
    if (bSrc) bSrc.setData(dataBySource.brussels   || empty);
    if (nSrc) nSrc.setData(dataBySource.ndw        || empty);
    if (lSrc) lSrc.setData(dataBySource.luxembourg || empty);
    if (oSrc) oSrc.setData(dataBySource.osm        || empty);
  }

  _addLayersMapLibre(map) {
    if (!map.getSource(SOURCE_FLANDERS)) map.addSource(SOURCE_FLANDERS, { type: 'geojson', data: EMPTY_FC });
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

    if (!map.getSource(SOURCE_BRUSSELS)) map.addSource(SOURCE_BRUSSELS, { type: 'geojson', data: EMPTY_FC });
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

    if (!map.getSource(SOURCE_NDW)) map.addSource(SOURCE_NDW, { type: 'geojson', data: EMPTY_FC });
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

    if (!map.getSource(SOURCE_LUXEMBOURG)) map.addSource(SOURCE_LUXEMBOURG, { type: 'geojson', data: EMPTY_FC });
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

    if (!map.getSource(SOURCE_OSM)) map.addSource(SOURCE_OSM, { type: 'geojson', data: EMPTY_FC });
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

  _addHoverListenersMapLibre(map) {
    const onHover = (e) => {
      if (!e.features || !e.features.length) return;
      this._cancelHide();
      if (this._popupDismiss) this._popupDismiss();
      this._popupDismiss = this._showPopup(map, e.lngLat, buildPopupHtml(e.features[0].properties));
    };

    const hoverLayers = [
      LAYER_FILL, LAYER_BRUSSELS_CIRCLE, LAYER_NDW_LINE,
      LAYER_LUXEMBOURG_LINE, LAYER_OSM_FILL, LAYER_OSM_LINE, LAYER_OSM_CIRCLE,
    ];
    hoverLayers.forEach((id) => {
      map.on('mouseenter', id, (e) => { map.getCanvas().style.cursor = 'pointer'; onHover(e); });
      map.on('mouseleave', id, ()  => { map.getCanvas().style.cursor = ''; this._scheduleHide(450); });
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

  // ── Leaflet path ──────────────────────────────────────────────────────────

  _onMapReadyLeaflet(map) {
    this._initLeafletLayers(map);
    this.setVisible(this._overlayOn);
    this._requestData();
    map.on('moveend', () => this._requestData());
  }

  _initLeafletLayers(map) {
    this._leafletLayers = {};
    SOURCE_KEYS.forEach((key) => {
      this._leafletLayers[key] = window.L.layerGroup().addTo(map);
    });
  }

  _applyDataLeaflet(dataBySource) {
    if (!this._leafletLayers) this._initLeafletLayers(this._map);

    SOURCE_KEYS.forEach((key) => {
      const group = this._leafletLayers[key];
      group.clearLayers();

      const fc = dataBySource[key] || EMPTY_FC;
      const filtered = this._showLimited
        ? fc
        : { ...fc, features: fc.features.filter((f) => f.properties.severity === 'full_closure') };

      if (filtered.features.length === 0) return;

      window.L.geoJSON(filtered, {
        style(feature) {
          const full = feature.properties.severity === 'full_closure';
          return {
            color:       full ? '#B71C1C' : '#E65100',
            fillColor:   full ? '#E53935' : '#FB8C00',
            weight:      2,
            opacity:     0.85,
            fillOpacity: 0.35,
            dashArray:   '5, 4',
          };
        },
        pointToLayer(feature, latlng) {
          const full = feature.properties.severity === 'full_closure';
          return window.L.circleMarker(latlng, {
            radius:      9,
            color:       '#fff',
            weight:      2,
            fillColor:   full ? '#E53935' : '#FB8C00',
            fillOpacity: 0.9,
          });
        },
        onEachFeature(feature, layer) {
          const html = buildPopupHtml(feature.properties);
          layer.bindPopup(html, { maxWidth: 280 });
          layer.on('mouseover', function () { this.openPopup(); });
          layer.on('mouseout',  function () { this.closePopup(); });
        },
      }).addTo(group);
    });
  }

  _setVisibleLeaflet(visible) {
    if (!this._leafletLayers) return;
    SOURCE_KEYS.forEach((key) => {
      if (visible) {
        this._leafletLayers[key].addTo(this._map);
      } else {
        this._leafletLayers[key].remove();
      }
    });
  }

  // ── Shared helpers ────────────────────────────────────────────────────────

  _requestData() {
    if (!this._map || !this._overlayOn) return;
    if (this._map.getZoom() < 8) return;

    clearTimeout(this._fetchTimer);
    this._fetchTimer = setTimeout(() => {
      const b = this._map.getBounds();
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
}
```

- [ ] **Step 2: Commit**

```bash
git add extension/adapters/RideWithGPSAdapter.js
git commit -m "feat: add RideWithGPSAdapter (Leaflet + MapLibre GL dual-library support)"
```

---

## Task 4: Create `extension/injected-ridewithgps.js`

**Files:**
- Create: `extension/injected-ridewithgps.js`

The injected script instantiates the adapter, wires message events, then runs detection. Three mechanisms fire in parallel: window property interceptors (Leaflet and MapLibre), an immediate check, and a DOM polling fallback.

**Leaflet patching note:** `L.Map.extend({initialize...})` creates a subclass. Save the original as `OrigMap` before calling `extend` so `OrigMap.prototype.initialize.call(this, ...)` inside the override doesn't recurse. `L.map(el)` factory internally calls `new L.Map(el)`, so after patching `L.Map`, the factory creates instances of our subclass.

- [ ] **Step 1: Create `extension/injected-ridewithgps.js`**

```js
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

  // Signal that the message listener is live; content script responds with stored preferences
  toContent('RW_READY', {}); // eslint-disable-line no-undef
})();
```

- [ ] **Step 2: Commit**

```bash
git add extension/injected-ridewithgps.js
git commit -m "feat: add injected-ridewithgps.js with Leaflet + MapLibre GL map detection"
```

---

## Task 5: Update `agents.md`

**Files:**
- Modify: `agents.md`

Three sections need updating: the architecture diagram, the Key Files table, and Common Pitfalls.

- [ ] **Step 1: Update the architecture diagram**

Replace:
```
│ Map Layer  (extension/adapters/ + injected-komoot.js)              │
│  RouteplannerAdapter (interface)  ←  KomootAdapter          │
```
With:
```
│ Map Layer  (extension/adapters/ + injected-komoot.js / injected-ridewithgps.js) │
│  RouteplannerAdapter (interface)  ←  KomootAdapter                              │
│                                   ←  RideWithGPSAdapter                         │
```

- [ ] **Step 2: Add new files to the Key Files table**

Add these rows after the `extension/injected-komoot.js` row:

| File | Role |
|------|------|
| `extension/content-ridewithgps.js` | Same bridge role as `content.js` but injects `RideWithGPSAdapter.js` then `injected-ridewithgps.js`. |
| `extension/adapters/RideWithGPSAdapter.js` | `RideWithGPSAdapter` class. Detects map library at runtime (`_mapType`): MapLibre GL path uses sources/layers (same as KomootAdapter); Leaflet path uses `L.layerGroup` + `L.geoJSON`. Shared helpers: `toContent`, `escHtml`, `buildPopupHtml`, source/layer constants. |
| `extension/injected-ridewithgps.js` | Thin orchestrator for RideWithGPS: instantiates `RideWithGPSAdapter`, wires messages, runs Leaflet + MapLibre detection (window interceptors + DOM polling). No React fiber walk. |

- [ ] **Step 3: Add Common Pitfalls entry**

Add at the end of the Common Pitfalls section:

> - **RideWithGPS dual-library detection**: `RideWithGPSAdapter._mapType` is set once in `onMapReady` by checking `typeof map.getSource === 'function'`. All four interface methods branch on this flag. If you add a feature that behaves differently per library, add it to **both** branches and update the `_mapType` check if the heuristic ever proves unreliable.
> - **Leaflet `_lastData`**: `setLimitedVisible` on the Leaflet path re-calls `_applyDataLeaflet(this._lastData)`. If `_lastData` is `null` (no data fetched yet), the call is skipped. This is intentional — the filter will be applied on the next `applyData` call.

- [ ] **Step 4: Commit**

```bash
git add agents.md
git commit -m "docs: update agents.md for RideWithGPS adapter"
```

---

## Task 6: Manual Verification

No automated tests cover page-context injection. Verify manually with Firefox.

- [ ] **Step 1: Build**

```bash
bash build.sh clean
```

Expected: `dist/firefox/` populated, no errors.

- [ ] **Step 2: Load in Firefox**

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Select `dist/firefox/manifest.json`

- [ ] **Step 3: Navigate to RideWithGPS**

Open `https://ridewithgps.com/routes/new` (or any existing route URL matching `/routes/*`).

- [ ] **Step 4: Check console for detection log**

Open DevTools → Console. You should see one of:
```
[BikeDetour] Patched Leaflet for RideWithGPS
[BikeDetour] RideWithGPS map detected (leaflet) ✓
```
or (if MapLibre GL):
```
[BikeDetour] Patched MapLibre/Mapbox for RideWithGPS
[BikeDetour] RideWithGPS map detected (maplibre) ✓
```

- [ ] **Step 5: Check overlay data appears**

Pan the map to Belgium or the Netherlands. Within a few seconds, coloured overlays (red/orange polygons, lines, or circles) should appear over known construction zones. Hovering a feature should show the popup with description, severity badge, dates, and owner.

- [ ] **Step 6: Verify popup toggles work**

Click the BikeDetour toolbar button. Toggle the overlay off — features should disappear. Toggle back on — features reappear. Toggle "Beperkte doorgang" off — only full-closure (red) features should remain.

- [ ] **Step 7: Verify Komoot still works**

Open `https://www.komoot.com`, create or view a route. Confirm the overlay still loads correctly — the RideWithGPS changes must not regress Komoot.
