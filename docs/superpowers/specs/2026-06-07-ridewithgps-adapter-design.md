# RideWithGPS Adapter — Design Spec

**Date:** 2026-06-07
**Status:** Approved

## Goal

Overlay cycling construction works and road closures on [RideWithGPS](https://ridewithgps.com) route planning pages (`/routes/new` and `/routes/*`), reusing the existing data pipeline and matching the behaviour already delivered for Komoot.

---

## Architecture

The adapter slots into the existing three-layer architecture without touching the Data Input or Logic layers. Only the Map Layer and extension plumbing change.

```
content-ridewithgps.js   — content script; injects adapter + injected scripts
        ↕ window.postMessage
injected-ridewithgps.js  — page context; detects map; orchestrates adapter
        ↕
RideWithGPSAdapter       — renders overlay using Leaflet or MapLibre GL API
```

The background service worker, data sources, and `DataAggregator` are unchanged. The popup toggle UI and `chrome.storage.local` keys (`overlayEnabled`, `showLimitedAccess`) are shared.

---

## New Files

### `extension/content-ridewithgps.js`

Near-copy of `content.js` with one change: the injection line loads `adapters/RideWithGPSAdapter.js` then `injected-ridewithgps.js` instead of the Komoot equivalents. All bridge logic (popup ↔ page, page → background) is identical.

### `extension/injected-ridewithgps.js`

Thin orchestrator. Instantiates `RideWithGPSAdapter`, wires incoming `window.postMessage` events (`RW_DATA`, `RW_TOGGLE`, `RW_TOGGLE_LIMITED`), then runs map detection.

**Detection strategy — three mechanisms run in parallel, first to fire wins:**

1. **Window property interceptors** — intercept `window.L` (Leaflet), `window.mapboxgl`, and `window.maplibregl` assignments via `Object.defineProperty`. When a lib with a `.Map` constructor is assigned, patch the constructor to call `onMapDiscovered(inst)` after the instance is ready.

2. **Immediate check** — after installing interceptors, check whether `window.L`, `window.mapboxgl`, or `window.maplibregl` already exist (race with page load) and patch them immediately.

3. **DOM polling fallback** — `setInterval` at 200 ms (max 150 iterations). Looks for `.leaflet-container` or `.maplibregl-canvas`. For `.leaflet-container` elements, tries `el._leaflet_map` (set by Leaflet 1.x on the container element). If not present — e.g. a different Leaflet version — the constructor-patch path (mechanism 1) should already have fired, so this is a last-resort guard. Clears once `adapter._map` is set.

No React fiber walk — that was Komoot-specific.

**Leaflet constructor patching:**
```js
function patchLeaflet(L) {
  if (!L.Map || L.Map.__rwPatched) return;
  const Orig = L.Map;
  L.Map = L.Map.extend({
    initialize(id, options) {
      Orig.prototype.initialize.call(this, id, options);
      this.whenReady(() => onMapDiscovered(this));
    }
  });
  L.Map.__rwPatched = true;
}
```
`L.Map.extend` is Leaflet's own inheritance mechanism; it preserves the prototype chain and all static properties without manual copying.

**MapLibre/Mapbox patching:** identical to `injected-komoot.js` (`patchLib` function, `PatchedMap` constructor wrapper).

**`onMapDiscovered` guard:** same minimap skip as Komoot — reject maps whose container `offsetWidth < 200`. For Leaflet maps the container is the element passed to `L.map(el)`.

### `extension/adapters/RideWithGPSAdapter.js`

Plain script (no IIFE, no ES modules). Defines one global: `RideWithGPSAdapter`.

Re-uses the shared globals already defined in this file: `FROM_PAGE`, `toContent`, `escHtml`, `buildPopupHtml`, source/layer constants. These are **copied** from `KomootAdapter.js` (not imported — injected scripts cannot use ES modules).

#### Library detection

```js
function _isMapLibre(map) {
  return typeof map.getSource === 'function';
}
```

All four interface methods (`onMapReady`, `applyData`, `setVisible`, `setLimitedVisible`) branch on `this._mapType` which is set in `onMapReady` to `'maplibre'` or `'leaflet'`.

#### MapLibre path

Identical to `KomootAdapter`: same sources (`rw-flanders`, `rw-brussels`, etc.), same layers (`rw-fill`, `rw-outline`, etc.), same `ALL_LAYERS` array, same hover popups via DOM overlay. The only difference is the absence of a React fiber walk in detection.

#### Leaflet path

**Data model:** one `L.layerGroup()` per source key (`flanders`, `brussels`, `ndw`, `luxembourg`, `osm`), stored as `this._leafletLayers`. Each group contains a single `L.geoJSON` layer regenerated on every `applyData` call.

**`applyData`:** clear each group, then call `group.addLayer(L.geoJSON(fc, options))` for the new data.

**`L.geoJSON` options:**
```js
{
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
    return L.circleMarker(latlng, {
      radius:      9,
      color:       '#fff',
      weight:      2,
      fillColor:   full ? '#E53935' : '#FB8C00',
      fillOpacity: 0.9,
    });
  },
  onEachFeature(feature, layer) {
    layer.on('mouseover', function(e) {
      layer.bindPopup(buildPopupHtml(feature.properties), { maxWidth: 280 }).openPopup();
    });
  },
}
```

**`setVisible`:** iterate `this._leafletLayers`, call `group.addTo(this._map)` or `group.remove()`.

**`setLimitedVisible`:** store `_showLimited` flag; on next `applyData` call, filter the feature collections before passing to `L.geoJSON`:
```js
function applyFilter(fc, showLimited) {
  if (showLimited) return fc;
  return {
    ...fc,
    features: fc.features.filter(f => f.properties.severity === 'full_closure'),
  };
}
```
This means `applyData` must reapply the filter each time. Because `setLimitedVisible` may be called without new data, store `_lastData` and call `applyData(this._lastData)` when the filter changes.

**`_requestData`:** identical to Komoot — debounced 300 ms, skips zoom < 8, sends `RW_FETCH` via `toContent`.

**Map move listener:** `map.on('moveend', ...)` — same event name works for both Leaflet and MapLibre GL.

---

## Manifest Changes (both `extension/manifest.json` and `extension-firefox/manifest.json`)

### Add content script entry

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

### Add web_accessible_resources entry

```json
{
  "resources": ["adapters/RideWithGPSAdapter.js", "injected-ridewithgps.js"],
  "matches": ["https://ridewithgps.com/*"]
}
```

No new `host_permissions` needed — the extension fetches data from the existing source APIs (Flanders, Brussels, NDW, Luxembourg, OSM), not from ridewithgps.com.

---

## `agents.md` Updates

- Add `RideWithGPSAdapter` to the Map Layer diagram
- Add `content-ridewithgps.js`, `injected-ridewithgps.js`, `RideWithGPSAdapter.js` to the Key Files table
- Add note on dual-library detection to Common Pitfalls

---

## Out of Scope

- Style-reload handling (Leaflet has no concept of style reload; MapLibre path inherits Komoot's `style.load` listener)
- RideWithGPS-specific URL change detection (SPA navigation) — deferred; the MutationObserver in the polling fallback handles re-detection if the map element is remounted
- Popup anchor positioning for Leaflet (uses Leaflet's built-in popup positioning rather than the custom DOM overlay used in the Komoot adapter)
