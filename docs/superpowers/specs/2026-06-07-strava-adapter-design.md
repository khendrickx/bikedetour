# Strava Adapter — Design Spec

**Date:** 2026-06-07
**Status:** Approved

## Goal

Overlay cycling construction works and road closures on [Strava](https://www.strava.com/maps/create) route planning pages (`/maps/create` and `/maps/*`), reusing the existing data pipeline and matching the behaviour already delivered for Komoot.

---

## URL Notes

`https://www.strava.com/routes/new` issues a **server-side HTTP redirect** to `https://www.strava.com/maps/create`. Content scripts run at the final URL, so the manifest must match `https://www.strava.com/maps/*`. The `/routes/*` pattern is also included as a belt-and-suspenders measure for any saved-route views that may not redirect.

---

## Map Library

**Mapbox GL JS** — confirmed by static analysis of Strava's production JS bundles:

- Strava bundles Mapbox GL internally and **explicitly assigns** `window.mapboxgl = <bundled_lib>()` inside a React `useEffect`.
- Standard Mapbox GL CSS classes are present in the DOM: `.mapboxgl-map`, `.mapboxgl-canvas`, `.mapboxgl-ctrl`.
- No Leaflet or MapLibre GL is used.

---

## Architecture

The adapter slots into the existing three-layer architecture without touching the Data Input or Logic layers. Only the Map Layer and extension plumbing change.

```
content-strava.js        — content script; injects adapter + injected scripts
        ↕ window.postMessage
injected-strava.js       — page context; detects map; orchestrates adapter
        ↕
StravaAdapter            — renders overlay using Mapbox GL JS API
```

Background service worker, data sources, `DataAggregator`, popup UI, and `chrome.storage.local` keys (`overlayEnabled`, `showLimitedAccess`) are **unchanged and shared**.

---

## New Files

| File | Role |
|------|------|
| `extension/content-strava.js` | Near-copy of `content.js`. Injects `adapters/StravaAdapter.js` then `injected-strava.js` sequentially. All popup ↔ page ↔ background bridge logic is identical. |
| `extension/adapters/StravaAdapter.js` | Plain script (no IIFE, no ES modules). Defines `StravaAdapter` class plus copies of shared globals. Implements the four `RouteplannerAdapter` methods using the Mapbox GL JS API. |
| `extension/injected-strava.js` | Thin orchestrator. Instantiates `StravaAdapter`, wires `window.postMessage` events, runs map detection. |

---

## Manifest Changes

Apply to **both** `extension/manifest.json` and `extension-firefox/manifest.json`:

1. **`host_permissions`** — add `https://www.strava.com/*`
2. **`content_scripts`** — add entry:
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
3. **`web_accessible_resources`** — add entry:
   ```json
   {
     "resources": ["adapters/StravaAdapter.js", "injected-strava.js"],
     "matches": ["https://www.strava.com/*"]
   }
   ```

---

## Map Detection (`injected-strava.js`)

Three mechanisms run in parallel; first to fire wins. Once `adapter._map` is set, all polling clears.

### 1. Window interceptor (primary path)

Install `Object.defineProperty(window, 'mapboxgl', { get, set, configurable: true })` at script start (before any page JS). When Strava runs `window.mapboxgl = bundledLib`, the setter fires synchronously, patches `mapboxgl.Map` (wraps the constructor so every new instance calls `onMapDiscovered` after its `load` event), then stores the patched library.

### 2. Immediate check

After installing the interceptor, check whether `window.mapboxgl` already exists. If so, call `patchLib(window.mapboxgl)` immediately. Handles the unlikely race where Strava's bundle executes before `document_start`.

### 3. DOM polling fallback

`setInterval` at 200ms, max 150 iterations (~30s). On each tick:
- If `adapter._map` is set, clear interval.
- Look for `.mapboxgl-canvas`. If found, probe known Mapbox GL internal properties on the container (`.__mbMap`, `._mapboxGL`, or any property whose value passes `isMapInstance()`).
- If a valid map instance is found, call `onMapDiscovered`. This path is best-effort; the primary interceptor should always fire first on Strava.

Covers edge cases where `Object.defineProperty` is non-configurable on `window`.

### `patchLib(lib)` function

```js
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
}
```

### `onMapDiscovered` guard

Reject maps whose container `offsetWidth < 200` to skip minimaps.

**No React fiber walk** — Strava's explicit `window.mapboxgl` assignment makes it unnecessary (unlike Komoot, which bundles MapLibre without ever assigning to a window property).

---

## `StravaAdapter` Class

Implements the `RouteplannerAdapter` interface. Near-identical to `KomootAdapter` — same layer constants, same popup helpers, same four methods.

### Shared globals (copied, not imported)

`FROM_PAGE`, `toContent`, all source/layer constants (`SOURCE_FLANDERS`, `SOURCE_BRUSSELS`, `SOURCE_NDW`, `SOURCE_LUXEMBOURG`, `SOURCE_OSM`), all layer ID constants, `ALL_LAYERS`, `LAYER_BASE_FILTER`, `EMPTY_FC`, `escHtml`, `buildPopupHtml`.

These are copied into `StravaAdapter.js` because page-context scripts cannot use ES module imports.

### `_addLayers(map)`

Identical layer definitions to `KomootAdapter`: Flanders fill+outline, Brussels circle, NDW line, Luxembourg line, OSM fill+line+circle. Same colours (`#E53935` / `#FB8C00` for closures / partial; `#C62828` / `#E65100` for OSM tint). Strava uses the Mapbox GL JS API which is API-compatible with MapLibre GL, so no changes needed.

### `_addHoverListeners(map)`

Same hover/leave pattern and popup wiring as `KomootAdapter`. The `style.load` re-init listener is kept for resilience (may be a no-op on Strava, which does not switch map themes like Komoot).

### `_requestData()`

Identical: debounced 300ms, `map.getBounds()`, posts `RW_FETCH` via `toContent`. Same zoom guard (`< 8`).

### `setVisible(visible)` / `setLimitedVisible(showLimited)`

Identical implementations to `KomootAdapter`.

### `_showPopup(map, lngLat, html)`

Identical implementation to `KomootAdapter`.

---

## Error Handling & Resilience

- Detection polling auto-clears after 30s if no map is found (graceful no-op on non-map Strava pages).
- `patchLib` is idempotent (`__rwPatched` guard).
- Data pipeline uses `Promise.allSettled` — one source failure never blocks others (unchanged from existing architecture).
- `applyData` re-adds layers if they were cleared (same guard as `KomootAdapter`).

---

## agents.md Update

Add Strava to the adapter table and the Common Pitfalls section (both manifests must stay in sync).
