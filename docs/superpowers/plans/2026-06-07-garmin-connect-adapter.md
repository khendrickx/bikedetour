# Garmin Connect Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Leaflet overlay adapter for Garmin Connect course pages (`/app/courses` and `/app/course/*`), reusing the existing data pipeline and matching the behaviour of the Komoot and RideWithGPS adapters.

**Architecture:** Three new files follow the established pattern — `content-garmin.js` (bridge), `GarminAdapter.js` (Leaflet-only adapter class), `injected-garmin.js` (orchestrator + `L.Map` detection). Garmin Connect is a React SPA that destroys and recreates the Leaflet map on each route change; the adapter handles this by patching `L.Map` via `L.Map.extend` so every instantiation fires `onMapReady`, which resets stale layer references before building fresh ones.

**Tech Stack:** Vanilla JS (no bundler), Manifest V3, Leaflet (Garmin's map library — confirmed Leaflet-only, no dual-library branching needed).

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `extension/adapters/GarminAdapter.js` | Create | Leaflet-only adapter class + shared globals (`toContent`, `escHtml`, `buildPopupHtml`) |
| `extension/injected-garmin.js` | Create | Thin orchestrator; patches `L.Map`, wires messages, late-injection fallback |
| `extension/content-garmin.js` | Create | Content script bridge (page ↔ background) |
| `extension/manifest.json` | Modify | Add Garmin `host_permissions`, `content_scripts`, `web_accessible_resources` |
| `extension-firefox/manifest.json` | Modify | Mirror the same three changes |
| `agents.md` | Modify | Map Layer diagram, Key Files table, Common Pitfalls |
| `README.md` | Modify | Supported planners list, Map Layer diagram, extension plumbing table, adapter description |

---

## Task 1: Create `GarminAdapter.js`

**Files:**
- Create: `extension/adapters/GarminAdapter.js`

Leaflet-only adapter. Strips all MapLibre code and the `_mapType` flag from `RideWithGPSAdapter`. `onMapReady` resets `_leafletLayers = null` at the top so SPA re-navigation always gets a fresh layer set on the new map.

- [ ] **Step 1: Create the file**

```js
/**
 * GarminAdapter — page-context script, injected before injected-garmin.js.
 *
 * Defines globals used by injected-garmin.js:
 *   - toContent(type, payload)  — send a postMessage to content-garmin.js
 *   - GarminAdapter             — the adapter class (Leaflet-only)
 *
 * Garmin Connect is a SPA: each route change destroys the old Leaflet map and
 * creates a new one via L.Map. onMapReady() is called once per instantiation,
 * so it resets stale _leafletLayers references every time it fires.
 */

// ── Message bridge (page → content) ──────────────────────────────────────────

const FROM_PAGE = 'rw-from-page';

function toContent(type, payload) {
  window.postMessage({ __rw: FROM_PAGE, type, ...payload }, '*');
}

// ── Constants ─────────────────────────────────────────────────────────────────

const EMPTY_FC    = { type: 'FeatureCollection', features: [] };
const SOURCE_KEYS = ['flanders', 'brussels', 'ndw', 'luxembourg', 'osm'];

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

// ── GarminAdapter ─────────────────────────────────────────────────────────────

class GarminAdapter {
  constructor() {
    this._map           = null;
    this._overlayOn     = true;
    this._showLimited   = true;
    this._fetchTimer    = null;
    this._lastData      = null;
    this._leafletLayers = null;
  }

  onMapReady(map) {
    this._map           = map;
    this._leafletLayers = null; // drop stale refs from previous SPA map instance
    console.log('[BikeDetour] Garmin Connect map ready ✓');

    this._initLeafletLayers(map);
    this.setVisible(this._overlayOn);
    if (this._lastData) this.applyData(this._lastData);
    this._requestData();
    map.on('moveend', () => this._requestData());
  }

  applyData(dataBySource) {
    if (!this._map) return;
    this._lastData = dataBySource;
    this._applyDataLeaflet(dataBySource);
  }

  setVisible(visible) {
    this._overlayOn = visible;
    this._setVisibleLeaflet(visible);
  }

  setLimitedVisible(showLimited) {
    this._showLimited = showLimited;
    if (this._lastData) this.applyData(this._lastData);
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
        },
      }).addTo(group);
    });
  }

  _setVisibleLeaflet(visible) {
    if (!this._leafletLayers || !this._map) return;
    SOURCE_KEYS.forEach((key) => {
      if (visible) {
        this._leafletLayers[key].addTo(this._map);
      } else {
        this._leafletLayers[key].remove();
      }
    });
  }

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
git add extension/adapters/GarminAdapter.js
git commit -m "feat: add GarminAdapter (Leaflet-only)"
```

---

## Task 2: Create `injected-garmin.js`

**Files:**
- Create: `extension/injected-garmin.js`

Patches `L.Map` via `L.Map.extend` (Leaflet's own inheritance, same technique as `injected-ridewithgps.js`). Intercepts `window.L` assignment in case Leaflet is assigned after this script runs. Includes a 2-second late-injection fallback poll for the rare case where the page's `L.map()` call happened before injection.

- [ ] **Step 1: Create the file**

```js
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

  function patchLeaflet(L) {
    if (!L.Map || L.Map.__garminPatched) return;
    const OrigMap = L.Map;
    L.Map = OrigMap.extend({
      initialize(id, options) {
        OrigMap.prototype.initialize.call(this, id, options);
        this.whenReady(() => adapter.onMapReady(this));
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

  // Late-injection fallback: if .leaflet-container is already in the DOM we missed
  // the first map creation. Poll for the next L.Map patch opportunity (SPA navigation
  // will create a new map). Max 20 × 100 ms = 2 s.
  let pollCount = 0;
  const poll = setInterval(() => {
    if (adapter._map || ++pollCount > 20) { clearInterval(poll); return; }
    if (window.L && window.L.Map && !window.L.Map.__garminPatched) patchLeaflet(window.L);
  }, 100);

  // Signal that the message listener is live; content script responds with stored preferences
  toContent('RW_READY', {}); // eslint-disable-line no-undef
})();
```

- [ ] **Step 2: Commit**

```bash
git add extension/injected-garmin.js
git commit -m "feat: add injected-garmin.js orchestrator with L.Map patching"
```

---

## Task 3: Create `content-garmin.js`

**Files:**
- Create: `extension/content-garmin.js`

Verbatim copy of `content-ridewithgps.js` with one change: the `injectScript` line loads `GarminAdapter.js` then `injected-garmin.js`.

- [ ] **Step 1: Create the file**

```js
/**
 * content-garmin.js — Content Script for Garmin Connect
 * Injected into connect.garmin.com/app/courses* and /app/course/* at document_start.
 *
 * Responsibilities:
 *  1. Inject GarminAdapter.js + injected-garmin.js into the page context.
 *  2. Bridge data requests from injected-garmin.js → background service worker.
 *  3. Forward toggle commands from the popup → injected-garmin.js.
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

  injectScript('adapters/GarminAdapter.js', () => injectScript('injected-garmin.js'));

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
git add extension/content-garmin.js
git commit -m "feat: add content-garmin.js bridge script"
```

---

## Task 4: Update both manifests

**Files:**
- Modify: `extension/manifest.json`
- Modify: `extension-firefox/manifest.json`

Both files receive the same three additions. The Chrome manifest has JS-style comments (`//`) inside the JSON that the Chrome parser accepts — preserve them as-is.

- [ ] **Step 1: Add `"https://connect.garmin.com/*"` to `host_permissions` in `extension/manifest.json`**

The current array ends with `"https://www.cita.lu/*"`. Insert the new entry directly after `"https://www.komoot.com/*"`:

```json
"host_permissions": [
  "https://www.komoot.com/*",
  "https://connect.garmin.com/*",
  "https://geo.api.vlaanderen.be/*",
  "https://data.mobility.brussels/*",
  "https://opendata.ndw.nu/*",
  "https://www.cita.lu/*"
  // "https://overpass-api.de/*",
  // "https://overpass.kumi.systems/*",
  // "https://overpass.private.coffee/*",
  // "https://overpass.openstreetmap.fr/*"
],
```

- [ ] **Step 2: Add the Garmin content script entry to `content_scripts` in `extension/manifest.json`**

Append after the existing `ridewithgps` entry:

```json
{
  "matches": [
    "https://connect.garmin.com/app/courses",
    "https://connect.garmin.com/app/courses/*",
    "https://connect.garmin.com/app/course/*"
  ],
  "js": ["content-garmin.js"],
  "run_at": "document_start"
}
```

- [ ] **Step 3: Add the Garmin entry to `web_accessible_resources` in `extension/manifest.json`**

Append after the existing `ridewithgps` entry:

```json
{
  "resources": ["adapters/GarminAdapter.js", "injected-garmin.js"],
  "matches": ["https://connect.garmin.com/*"]
}
```

- [ ] **Step 4: Apply the same three changes to `extension-firefox/manifest.json`**

The Firefox manifest has no JS-style comments. The `host_permissions` array ends with `"https://www.cita.lu/*"` — insert `"https://connect.garmin.com/*"` after `"https://www.komoot.com/*"`. Apply `content_scripts` and `web_accessible_resources` additions identically to Step 2 and Step 3.

- [ ] **Step 5: Verify both manifests are in sync**

Run this diff to confirm both manifests have the same `host_permissions`, `content_scripts`, and `web_accessible_resources` arrays (modulo the Firefox-only `browser_specific_settings` and `background` fields):

```bash
diff <(node -e "const m=JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8').replace(/\/\/.*/g,'')); console.log(JSON.stringify({hp:m.host_permissions,cs:m.content_scripts,war:m.web_accessible_resources},null,2))") \
     <(node -e "const m=JSON.parse(require('fs').readFileSync('extension-firefox/manifest.json','utf8')); console.log(JSON.stringify({hp:m.host_permissions,cs:m.content_scripts,war:m.web_accessible_resources},null,2))")
```

Expected output: no diff.

- [ ] **Step 6: Commit**

```bash
git add extension/manifest.json extension-firefox/manifest.json
git commit -m "feat: register Garmin Connect in both manifests"
```

---

## Task 5: Manual E2E verification

Build and load the extension. Verify the overlay works on both Garmin Connect pages before touching docs.

- [ ] **Step 1: Build**

```bash
bash build.sh
```

Expected: `dist/chrome/` and `dist/firefox/` created with no errors.

- [ ] **Step 2: Load in Chrome**

Open `chrome://extensions` → enable Developer mode → *Load unpacked* → select `dist/chrome`.

- [ ] **Step 3: Verify on `/app/courses`**

Navigate to `https://connect.garmin.com/app/courses` while logged in. Open DevTools → Console. Confirm:
- `[BikeDetour] Patched L.Map for Garmin Connect`
- `[BikeDetour] Garmin Connect map ready ✓`
- No JS errors

- [ ] **Step 4: Verify SPA re-detection on `/app/course/*`**

Click through to any course (`/app/course/<id>`). Confirm in the Console:
- `[BikeDetour] Garmin Connect map ready ✓` logged a **second** time (new map instance)
- At zoom ≥ 8 in Belgium/Netherlands, overlay features appear on the map

- [ ] **Step 5: Verify popup and hover**

Hover a coloured overlay feature — confirm popup appears with description, dates, owner. Open the extension popup and toggle the overlay off/on — confirm layers hide and reappear.

- [ ] **Step 6: Verify back-navigation**

Navigate back to `/app/courses`. Confirm the overlay reappears without a page reload.

---

## Task 6: Update `agents.md`

**Files:**
- Modify: `agents.md`

Three sections need updating.

- [ ] **Step 1: Update the Map Layer diagram (lines 28–30)**

Replace:
```
│ Map Layer  (extension/adapters/ + injected-komoot.js / injected-ridewithgps.js) │
│  RouteplannerAdapter (interface)  ←  KomootAdapter                              │
│                                   ←  RideWithGPSAdapter                         │
└─────────────────────────────────────────────────────────────────────────────────┘
```

With:
```
│ Map Layer  (extension/adapters/ + injected-komoot.js / injected-ridewithgps.js / injected-garmin.js) │
│  RouteplannerAdapter (interface)  ←  KomootAdapter                                                    │
│                                   ←  RideWithGPSAdapter                                               │
│                                   ←  GarminAdapter                                                    │
└───────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- [ ] **Step 2: Add three rows to the Key Files table after the `injected-ridewithgps.js` row**

After the line:
```
| `extension/injected-ridewithgps.js` | ...
```

Add:
```
| `extension/content-garmin.js` | Same bridge role as `content.js` but injects `GarminAdapter.js` then `injected-garmin.js`. Matches `connect.garmin.com/app/courses*` and `/app/course/*`. |
| `extension/adapters/GarminAdapter.js` | `GarminAdapter` class. Leaflet-only — no `_mapType` flag. `onMapReady` resets `_leafletLayers = null` on each call so SPA route changes always get a fresh layer set on the new map instance. |
| `extension/injected-garmin.js` | Thin orchestrator for Garmin Connect: patches `L.Map` via `L.Map.extend`, intercepts `window.L` assignment, includes a 2 s late-injection poll. No React fiber walk or MapLibre detection needed. |
```

- [ ] **Step 3: Add a Common Pitfalls entry**

At the end of the Common Pitfalls section, add:
```
- **Garmin Connect SPA map re-creation**: `GarminAdapter.onMapReady` fires on every `L.Map` instantiation. On SPA route changes Garmin destroys the old map and creates a new one, so `onMapReady` fires again with a new instance. The adapter sets `this._leafletLayers = null` at the top of `onMapReady` to discard stale layer group references before `_initLeafletLayers` creates fresh ones on the new map. Do not add a `if (this._map === map) return` guard — it would break SPA re-detection.
```

- [ ] **Step 4: Commit**

```bash
git add agents.md
git commit -m "docs: update agents.md for Garmin Connect adapter"
```

---

## Task 7: Update `README.md`

**Files:**
- Modify: `README.md`

Four locations need updating.

- [ ] **Step 1: Update the opening sentence (line 3)**

Replace:
```
A browser extension that overlays active construction zones and road closures on cycling route planners — currently [Komoot](https://www.komoot.com) and [RideWithGPS](https://ridewithgps.com).
```

With:
```
A browser extension that overlays active construction zones and road closures on cycling route planners — currently [Komoot](https://www.komoot.com), [RideWithGPS](https://ridewithgps.com), and [Garmin Connect](https://connect.garmin.com).
```

- [ ] **Step 2: Update the Zero configuration feature bullet (line 32)**

Replace:
```
- **Zero configuration** — install and visit [komoot.com/plan](https://www.komoot.com/plan) or [ridewithgps.com/routes](https://ridewithgps.com/routes/new).
```

With:
```
- **Zero configuration** — install and visit [komoot.com/plan](https://www.komoot.com/plan), [ridewithgps.com/routes](https://ridewithgps.com/routes/new), or [connect.garmin.com/app/courses](https://connect.garmin.com/app/courses).
```

- [ ] **Step 3: Update the Map Layer diagram (lines 83–86)**

Replace:
```
│ Map Layer                                                              │
│  RouteplannerAdapter (interface)  ←  KomootAdapter                    │
│                                   ←  RideWithGPSAdapter               │
└────────────────────────────────────────────────────────────────────────┘
```

With:
```
│ Map Layer                                                              │
│  RouteplannerAdapter (interface)  ←  KomootAdapter                    │
│                                   ←  RideWithGPSAdapter               │
│                                   ←  GarminAdapter                    │
└────────────────────────────────────────────────────────────────────────┘
```

- [ ] **Step 4: Update the adapter description paragraph (line 118) and extension plumbing table (lines 124–129)**

Replace:
```
`KomootAdapter` (inside `injected-komoot.js`) implements this interface for Komoot's bundled MapLibre GL instance. `RideWithGPSAdapter` (inside `injected-ridewithgps.js`) implements the same interface for RideWithGPS, which can use either Leaflet or MapLibre GL depending on the page.
```

With:
```
`KomootAdapter` (inside `injected-komoot.js`) implements this interface for Komoot's bundled MapLibre GL instance. `RideWithGPSAdapter` (inside `injected-ridewithgps.js`) implements the same interface for RideWithGPS, which can use either Leaflet or MapLibre GL depending on the page. `GarminAdapter` (inside `injected-garmin.js`) implements the interface for Garmin Connect's Leaflet map; it patches `L.Map` via `L.Map.extend` to handle SPA re-creation of the map on each route change.
```

Replace the extension plumbing block:
```
popup.html/popup.js       →  chrome.storage.local + chrome.tabs.sendMessage(TOGGLE)
content.js                →  injects injected-komoot.js; bridges RW_FETCH ↔ FETCH_ROADWORKS
content-ridewithgps.js    →  same bridge role; injects RideWithGPSAdapter.js + injected-ridewithgps.js
background.js             →  service worker; DataAggregator.fetchForBbox()
injected-komoot.js        →  KomootAdapter; patches/detects MapLibre; renders overlay
injected-ridewithgps.js   →  RideWithGPSAdapter; detects Leaflet or MapLibre; renders overlay
```

With:
```
popup.html/popup.js       →  chrome.storage.local + chrome.tabs.sendMessage(TOGGLE)
content.js                →  injects injected-komoot.js; bridges RW_FETCH ↔ FETCH_ROADWORKS
content-ridewithgps.js    →  same bridge role; injects RideWithGPSAdapter.js + injected-ridewithgps.js
content-garmin.js         →  same bridge role; injects GarminAdapter.js + injected-garmin.js
background.js             →  service worker; DataAggregator.fetchForBbox()
injected-komoot.js        →  KomootAdapter; patches/detects MapLibre; renders overlay
injected-ridewithgps.js   →  RideWithGPSAdapter; detects Leaflet or MapLibre; renders overlay
injected-garmin.js        →  GarminAdapter; patches L.Map for SPA re-detection; renders overlay
```

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: add Garmin Connect to README"
```
