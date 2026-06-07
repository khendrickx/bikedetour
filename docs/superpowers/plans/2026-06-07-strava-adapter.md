# Strava Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a BikeDetour construction-works overlay to Strava's route builder (`/maps/create` and `/maps/*`) by creating a `StravaAdapter` that uses Mapbox GL JS — the library confirmed present in Strava's production bundles.

**Architecture:** Three new files slot into the existing pattern — a content script (`content-strava.js`) injects `StravaAdapter.js` then `injected-strava.js` into the page context. Strava explicitly assigns `window.mapboxgl` at runtime, so detection uses a `window.mapboxgl` property interceptor (primary) plus a DOM polling fallback — no React fiber walk needed. The adapter itself is a near-copy of `KomootAdapter` since both use the MapboxGL/MapLibre GL API. The background service worker and data pipeline are untouched.

**Tech Stack:** Vanilla JS (no modules — page-context scripts are plain `<script>` tags), Manifest V3, Mapbox GL JS API (same as MapLibre GL — `.addSource`, `.addLayer`, `.setData`, `.getBounds`, etc.).

**Spec:** `docs/superpowers/specs/2026-06-07-strava-adapter-design.md`

**URL note:** `https://www.strava.com/routes/new` server-side redirects to `https://www.strava.com/maps/create`. Content scripts run at the *final* URL, so the manifest must match `/maps/*`. The `/routes/*` match is kept as a fallback for saved-route views.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `extension/content-strava.js` | Content script: inject adapter + injected scripts; bridge popup↔page, page→background |
| Create | `extension/adapters/StravaAdapter.js` | Adapter class + all shared globals; Mapbox GL API (sources/layers/popup) |
| Create | `extension/injected-strava.js` | Instantiate adapter; window interceptor + DOM polling for `window.mapboxgl`; signal RW_READY |
| Modify | `extension/manifest.json` | Add host_permissions, content_scripts, web_accessible_resources for strava.com |
| Modify | `extension-firefox/manifest.json` | Same changes as Chrome manifest |
| Modify | `agents.md` | Add Strava to adapter table and Common Pitfalls |

---

## Task 1: Update Both Manifests

**Files:**
- Modify: `extension/manifest.json`
- Modify: `extension-firefox/manifest.json`

- [ ] **Step 1: Add Strava entries to `extension/manifest.json`**

Open `extension/manifest.json`. Make three additions:

**`host_permissions`** — append after the last existing entry:
```json
"https://www.strava.com/*"
```

**`content_scripts`** — append a new object after the ridewithgps entry:
```json
{
  "matches": [
    "https://www.strava.com/maps/*",
    "https://www.strava.com/routes/*"
  ],
  "js": ["content-strava.js"],
  "run_at": "document_start"
}
```

**`web_accessible_resources`** — append a new object after the ridewithgps entry:
```json
{
  "resources": ["adapters/StravaAdapter.js", "injected-strava.js"],
  "matches": ["https://www.strava.com/*"]
}
```

After editing, the full `extension/manifest.json` should look like this:
```json
{
  "manifest_version": 3,
  "name": "BikeDetour",
  "version": "0.1.2",
  "description": "Overlay cycling construction works and road closures on route planner maps so you can detour around them. https://github.com/khendrickx/bikedetour",

  "permissions": ["storage"],
  "host_permissions": [
    "https://www.komoot.com/*",
    "https://geo.api.vlaanderen.be/*",
    "https://data.mobility.brussels/*",
    "https://opendata.ndw.nu/*",
    "https://www.cita.lu/*",
    "https://www.strava.com/*"
  ],

  "background": {
    "service_worker": "background.js",
    "type": "module"
  },

  "content_scripts": [
    {
      "matches": ["https://www.komoot.com/*"],
      "js": ["content.js"],
      "run_at": "document_start"
    },
    {
      "matches": [
        "https://ridewithgps.com/routes/new",
        "https://ridewithgps.com/routes/*"
      ],
      "js": ["content-ridewithgps.js"],
      "run_at": "document_start"
    },
    {
      "matches": [
        "https://www.strava.com/maps/*",
        "https://www.strava.com/routes/*"
      ],
      "js": ["content-strava.js"],
      "run_at": "document_start"
    }
  ],

  "web_accessible_resources": [
    {
      "resources": ["adapters/KomootAdapter.js", "injected-komoot.js"],
      "matches": ["https://www.komoot.com/*"]
    },
    {
      "resources": ["adapters/RideWithGPSAdapter.js", "injected-ridewithgps.js"],
      "matches": ["https://ridewithgps.com/*"]
    },
    {
      "resources": ["adapters/StravaAdapter.js", "injected-strava.js"],
      "matches": ["https://www.strava.com/*"]
    }
  ],

  "icons": {
    "48": "icons/icon.svg",
    "96": "icons/icon.svg"
  },

  "action": {
    "default_popup": "popup.html",
    "default_title": "BikeDetour",
    "default_icon": "icons/icon.svg"
  }
}
```

- [ ] **Step 2: Apply the identical Strava additions to `extension-firefox/manifest.json`**

Open `extension-firefox/manifest.json`. Apply the same three additions (host_permissions, content_scripts entry, web_accessible_resources entry) as Step 1. The Firefox manifest has extra keys (`browser_specific_settings`, different `background` block) — do not touch those; only add the Strava-specific entries to the same three arrays.

- [ ] **Step 3: Verify both manifests agree on Strava entries**

Run:
```bash
grep -A3 "strava" extension/manifest.json extension-firefox/manifest.json
```
Expected: both files show identical strava.com entries in all three sections.

- [ ] **Step 4: Commit**

```bash
git add extension/manifest.json extension-firefox/manifest.json
git commit -m "feat: add Strava to manifests (host_permissions, content_scripts, web_accessible_resources)"
```

---

## Task 2: Create `content-strava.js`

**Files:**
- Create: `extension/content-strava.js`

This is a copy of `extension/content.js` with one line changed: the injection line loads `StravaAdapter.js` and `injected-strava.js` instead of the Komoot equivalents. All bridge logic is identical.

- [ ] **Step 1: Create the file**

Create `extension/content-strava.js` with this exact content:

```js
/**
 * content-strava.js — Content Script
 * Injected into Strava map pages at document_start.
 *
 * Responsibilities:
 *  1. Inject injected-strava.js into the page context so it can access window.mapboxgl.
 *  2. Bridge data requests from injected-strava.js → background service worker.
 *  3. Forward toggle commands from the popup → injected-strava.js.
 */

(function () {
  'use strict';

  const FROM_PAGE    = 'rw-from-page';
  const FROM_CONTENT = 'rw-from-content';

  // ── 1. Inject page-context scripts ───────────────────────────────────────
  // Adapter must be defined before injected-strava.js runs — wait for each
  // script's load event before appending the next one.

  function injectScript(path, next) {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL(path);
    script.addEventListener('load', () => { script.remove(); if (next) next(); });
    (document.head || document.documentElement).appendChild(script);
  }

  injectScript('adapters/StravaAdapter.js', () => injectScript('injected-strava.js'));

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
      window.postMessage({
        __rw:    FROM_CONTENT,
        type:    'RW_TOGGLE',
        enabled: message.enabled,
      }, '*');
    }
    if (message.type === 'TOGGLE_LIMITED') {
      window.postMessage({
        __rw:    FROM_CONTENT,
        type:    'RW_TOGGLE_LIMITED',
        enabled: message.enabled,
      }, '*');
    }
  });

})();
```

- [ ] **Step 2: Commit**

```bash
git add extension/content-strava.js
git commit -m "feat: add content-strava.js bridge script"
```

---

## Task 3: Create `StravaAdapter.js`

**Files:**
- Create: `extension/adapters/StravaAdapter.js`

Near-copy of `extension/adapters/KomootAdapter.js`. The shared globals (`toContent`, source/layer constants, popup helpers) are copied verbatim — page-context scripts cannot use ES module imports. The class itself is renamed to `StravaAdapter` but the implementation is identical since Mapbox GL JS and MapLibre GL share the same API.

- [ ] **Step 1: Create the file**

Create `extension/adapters/StravaAdapter.js` with this exact content:

```js
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
```

- [ ] **Step 2: Commit**

```bash
git add extension/adapters/StravaAdapter.js
git commit -m "feat: add StravaAdapter (Mapbox GL JS, mirrors KomootAdapter)"
```

---

## Task 4: Create `injected-strava.js`

**Files:**
- Create: `extension/injected-strava.js`

Thin orchestrator: instantiates `StravaAdapter`, wires incoming messages, and runs map detection. Detection uses a `window.mapboxgl` property interceptor as the primary path — Strava explicitly assigns `window.mapboxgl = <bundled_lib>()`, so patching the constructor works without a React fiber walk.

- [ ] **Step 1: Create the file**

Create `extension/injected-strava.js` with this exact content:

```js
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
```

- [ ] **Step 2: Commit**

```bash
git add extension/injected-strava.js
git commit -m "feat: add injected-strava.js with mapboxgl interceptor and DOM polling"
```

---

## Task 5: Build and Verify

**Files:** none (verification only)

- [ ] **Step 1: Run the existing unit test to confirm nothing is broken**

```bash
node test-normalise-osm.js
```
Expected: all assertions pass, no errors.

- [ ] **Step 2: Build the extension**

```bash
bash build.sh
```
Expected: `dist/chrome/` and `dist/firefox/` directories updated, `dist/bikedetour-chrome.zip` and `dist/bikedetour-firefox.zip` created. No errors.

- [ ] **Step 3: Load in Chrome and verify**

1. Open `chrome://extensions`, enable Developer mode.
2. Click "Load unpacked" → select `dist/chrome/`.
3. Navigate to `https://www.strava.com/maps/create` (you must be logged in to Strava).
4. Open DevTools console. Expected log: `[BikeDetour] Patched window.mapboxgl` followed by `[RoadWorks] Strava map detected ✓`.
5. Pan the map over Belgium or the Netherlands. Expected log: `[RoadWorks] N Flanders, ...` with construction data counts.
6. Hover over a construction marker. Expected: popup appears with description, dates, severity badge.
7. Open the BikeDetour popup and toggle the overlay off/on. Expected: layers disappear/reappear.
8. Toggle "Show limited access" off. Expected: only full-closure features remain visible.

- [ ] **Step 4: Verify Firefox build loads without errors** *(optional, requires Firefox with web-ext)*

```bash
# If web-ext is installed:
npx web-ext run --source-dir dist/firefox --start-url "https://www.strava.com/maps/create"
```
Expected: same behaviour as Chrome.

- [ ] **Step 5: If console shows no patch log, diagnose**

If `[BikeDetour] Patched window.mapboxgl` does not appear:
- Open DevTools → Sources → Content Scripts → check `injected-strava.js` is listed.
- In console run: `window.mapboxgl` — if it returns the lib, run `patchLib(window.mapboxgl)` manually to confirm the adapter works.
- Check `extension/manifest.json` `web_accessible_resources` includes `injected-strava.js` for `https://www.strava.com/*`.

---

## Task 6: Update `agents.md`

**Files:**
- Modify: `agents.md`

- [ ] **Step 1: Add Strava to the architecture diagram**

In `agents.md`, find the Map Layer line in the architecture diagram:
```
│ Map Layer  (extension/adapters/ + injected-komoot.js)              │
│  RouteplannerAdapter (interface)  ←  KomootAdapter          │
```

Update it to:
```
│ Map Layer  (extension/adapters/ + injected scripts)                │
│  RouteplannerAdapter (interface)  ←  KomootAdapter                 │
│                                  ←  RideWithGPSAdapter             │
│                                  ←  StravaAdapter                  │
```

- [ ] **Step 2: Add Strava to the Key Files table**

After the RideWithGPS entries (or Komoot entries if RideWithGPS isn't there yet), add:

```
| `extension/content-strava.js` | Content script for Strava. Injects `StravaAdapter.js` then `injected-strava.js`. Bridge logic identical to `content.js`. |
| `extension/adapters/StravaAdapter.js` | `StravaAdapter` class + shared globals. Plain script (no IIFE). Implements RouteplannerAdapter via Mapbox GL JS API. |
| `extension/injected-strava.js` | Thin orchestrator for Strava: `window.mapboxgl` interceptor + immediate check + DOM polling. No React fiber walk needed — Strava assigns `window.mapboxgl` explicitly. |
```

- [ ] **Step 3: Add Strava URL redirect note to Common Pitfalls**

After the existing pitfalls, add:

```
- **Strava URL redirect**: `https://www.strava.com/routes/new` server-redirects to `https://www.strava.com/maps/create`. The content script match must include `https://www.strava.com/maps/*` — matching only `/routes/*` means the script never runs.
- **Strava uses Mapbox GL (not MapLibre)**: Strava bundles Mapbox GL internally and assigns it to `window.mapboxgl`. The injected script intercepts that assignment. Do not add `maplibregl` interceptor logic — it is unused and would add dead code.
```

- [ ] **Step 4: Commit**

```bash
git add agents.md
git commit -m "docs: update agents.md for Strava adapter"
```
