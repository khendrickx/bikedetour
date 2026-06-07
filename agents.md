# BikeDetour — Agent Guide

> **Agents:** keep this file current. After any change that affects architecture, data sources, file roles, layer names, caching behaviour, build/test steps, or common pitfalls, update the relevant section(s) in the same commit as the code change.

A Chrome/Firefox extension (Manifest V3) that overlays cycling construction works and road closures on [Komoot](https://www.komoot.com), [RideWithGPS](https://ridewithgps.com), and [Strava Routes](https://www.strava.com/maps/create).

## Architecture

Three-layer design with MV3 sandbox isolation:

```
┌─────────────────────────────────────────────────────────────┐
│ Data Input Layer  (extension/datasources/)                  │
│  DataSource (abstract)  ←  FlandersDataSource               │
│                         ←  BrusselsDataSource              │
│                         ←  NdwDataSource                   │
│                         ←  LuxembourgDataSource            │
│                         ←  OsmDataSource                   │
└──────────────────────────────┬──────────────────────────────┘
                               │ Feature[]
┌──────────────────────────────▼──────────────────────────────┐
│ Logic Layer  (extension/logic/)                             │
│  DataAggregator  (fan-out, per-bbox caching, resilience)    │
└──────────────────────────────┬──────────────────────────────┘
                               │ { sourceId: FeatureCollection }
┌──────────────────────────────▼──────────────────────────────┐
│ Map Layer  (extension/adapters/ + injected scripts)                             │
│  RouteplannerAdapter (interface)  ←  KomootAdapter                              │
│                                   ←  RideWithGPSAdapter                         │
│                                   ←  StravaAdapter                              │
└─────────────────────────────────────────────────────────────────────────────────┘
```

Extension plumbing on top of the three layers:

```
popup.html / popup.js   ← chrome.storage.local + chrome.tabs.sendMessage(TOGGLE)
       ↕ chrome.runtime.sendMessage
content.js              ← bridges RW_FETCH ↔ FETCH_ROADWORKS; injects injected-komoot.js
       ↕ window.postMessage
injected-komoot.js (KomootAdapter) ← page context; patches/detects MapLibre; renders overlay
       ↕
background.js           ← service worker; DataAggregator.fetchForBbox()
```

**Why the indirection:** MV3 content scripts cannot access objects created by the host page's JS. `injected-komoot.js` is inserted into the page's JS context via `content.js` so it can intercept Komoot's MapLibre instance.

## Data Sources

Each source is a class in `extension/datasources/` that extends `DataSource`. The `DataAggregator` in `background.js` instantiates them and calls `fetchForBbox(bbox)` only when the viewport overlaps the source's declared `boundingBox`.

| Source | Class | Coverage | API style |
|--------|-------|----------|-----------|
| Flanders (GIPOD) | `FlandersDataSource` | Flanders, BE | OGC Features (GeoJSON) |
| Brussels Mobility | `BrusselsDataSource` | Brussels, BE | WFS (GeoServer JSON) |
| NDW | `NdwDataSource` | Netherlands | DATEX II XML, gzipped |
| PCH Luxembourg | `LuxembourgDataSource` | Luxembourg | KML feed |
| OpenStreetMap | `OsmDataSource` | Global | Overpass API (JSON) |

### Normalised feature schema

All `fetchForBbox()` implementations must return features with these properties:

```js
{
  source:      'flanders' | 'brussels' | 'ndw' | 'luxembourg' | 'osm',  // matches DataSource.id
  id:          string,
  description: string,
  start:       string | null,   // ISO date
  end:         string | null,   // ISO date
  severity:    'full_closure' | 'partial',
  owner:       string,
  consequence: string,          // optional
  location:    string,          // Brussels only
}
```

## Key Files

| File | Role |
|------|------|
| `extension/datasources/DataSource.js` | Abstract base class. Declares `id`, `name`, `boundingBox`, `fetchForBbox()`, and a free `overlaps(bbox)` helper. |
| `extension/datasources/Flanders\|Brussels\|Ndw\|Luxembourg\|OsmDataSource.js` | One file per source; each owns its fetcher and normaliser. |
| `extension/logic/DataAggregator.js` | Filters sources by bbox overlap, fans out with `Promise.allSettled`, caches by 0.25° tile (10-min TTL), returns `{ data: Record<sourceId, FeatureCollection>, fromCache }`. |
| `extension/adapters/RouteplannerAdapter.js` | Interface spec (JSDoc). Adapters cannot import this at runtime — it is reference documentation only. |
| `extension/adapters/KomootAdapter.js` | `KomootAdapter` class + layer/source constants + popup helpers. Plain script (no IIFE, no ES modules) — top-level declarations become page globals used by `injected-komoot.js`. |
| `extension/background.js` | Thin service worker. Imports sources + aggregator, handles `FETCH_ROADWORKS` messages. |
| `extension/content.js` | Komoot bridge. Injects `adapters/KomootAdapter.js` then `injected-komoot.js` sequentially at `document_start`. Forwards data as `{ __rw, type: 'RW_DATA', data: { flanders, brussels, ndw, luxembourg, osm } }`. |
| `extension/injected-komoot.js` | Thin orchestrator: instantiates `KomootAdapter`, wires incoming messages, runs Komoot-specific map detection (window interceptors + React fiber walk). |
| `extension/content-ridewithgps.js` | Same bridge role as `content.js` but injects `RideWithGPSAdapter.js` then `injected-ridewithgps.js`. |
| `extension/adapters/RideWithGPSAdapter.js` | `RideWithGPSAdapter` class. Detects map library at runtime (`_mapType`): MapLibre GL path uses sources/layers (same as KomootAdapter); Leaflet path uses `L.layerGroup` + `L.geoJSON`. Shared helpers: `toContent`, `escHtml`, `buildPopupHtml`, source/layer constants. |
| `extension/injected-ridewithgps.js` | Thin orchestrator for RideWithGPS: instantiates `RideWithGPSAdapter`, wires messages, runs Leaflet + MapLibre detection (window interceptors + DOM polling). No React fiber walk. |
| `extension/content-strava.js` | Content script for Strava. Injects `StravaAdapter.js` then `injected-strava.js`. Bridge logic identical to `content.js`. |
| `extension/adapters/StravaAdapter.js` | `StravaAdapter` class + shared globals. Plain script (no IIFE). Implements RouteplannerAdapter via Mapbox GL JS API. |
| `extension/injected-strava.js` | Thin orchestrator for Strava: `window.mapboxgl` interceptor + immediate check + DOM polling. No React fiber walk needed — Strava assigns `window.mapboxgl` explicitly. |
| `extension/popup.html` / `popup.js` | Toggle UI. Persists `overlayEnabled` and `showLimitedAccess` to `chrome.storage.local`. |
| `extension/manifest.json` | Chrome MV3 manifest. Background declared as `"type": "module"` so ES imports work. |
| `extension-firefox/manifest.json` | Firefox variant (adds `browser_specific_settings`, adjusts background declaration). |
| `build.sh` | Packages unpacked dirs and zip archives for Chrome Web Store and Firefox AMO. |

## Caching Strategy

- **Bbox tile cache** (`DataAggregator`): viewport snapped to 0.25° grid; up to 20 tiles in memory, 10-min TTL.
- **NDW global cache** (`NdwDataSource`): separate 15-min TTL for the large gzipped DATEX II feed — downloaded once and then filtered per viewport in JS.
- **Luxembourg global cache** (`LuxembourgDataSource`): same pattern as NDW — 15-min TTL for the KML feed (~1.4 MB), filtered per viewport in JS.
- **Source resilience**: `Promise.allSettled()` in `DataAggregator` — one source failure never blocks the others. Failed sources return an empty `FeatureCollection`.
- **Overpass mirrors**: uncomment endpoints in `OsmDataSource.OVERPASS_ENDPOINTS` to enable fallback mirrors.

## Map Layer Naming Convention

Layers registered by `KomootAdapter._addLayers()` in `injected-komoot.js`:

| Layer ID | Source constant | MapLibre source | Shape |
|----------|----------------|-----------------|-------|
| `rw-fill` | `LAYER_FILL` | `rw-flanders` | fill polygon (Flanders areas) |
| `rw-outline` | `LAYER_OUTLINE` | `rw-flanders` | dashed line outline |
| `rw-brussels-circle` | `LAYER_BRUSSELS_CIRCLE` | `rw-brussels` | circle (Brussels points) |
| `rw-ndw-line` | `LAYER_NDW_LINE` | `rw-ndw` | solid line |
| `rw-luxembourg-line` | `LAYER_LUXEMBOURG_LINE` | `rw-luxembourg` | solid line |
| `rw-osm-fill` | `LAYER_OSM_FILL` | `rw-osm` | fill polygon (landuse=construction) |
| `rw-osm-line` | `LAYER_OSM_LINE` | `rw-osm` | dashed line |
| `rw-osm-circle` | `LAYER_OSM_CIRCLE` | `rw-osm` | circle (barrier=construction nodes) |

`ALL_LAYERS` array in `injected-komoot.js` must include every layer so `setVisible()` and `setLimitedVisible()` apply uniformly.

Severity colours: full closure `#E53935` / `#C62828` (OSM tint), partial `#FB8C00` / `#E65100` (OSM tint).

## Running Tests

```bash
# Unit tests — imports OsmDataSource directly via ESM
node test-normalise-osm.js

# E2E test (requires Chrome + a loaded extension)
node test-extension.js
```

No `package.json` — vanilla JS with no npm dependencies. Playwright is expected globally or via `npx`.

## Building

```bash
bash build.sh
bash build.sh clean   # remove dist/ first
```

Outputs to `dist/` (gitignored):

```
dist/chrome/                        # unpacked, load via chrome://extensions
dist/firefox/                       # unpacked, load as temporary add-on
dist/bikedetour-chrome.zip
dist/bikedetour-firefox.zip
```

## Adding a New Data Source

1. Create `extension/datasources/<Name>DataSource.js` extending `DataSource`.
2. Declare `id`, `name`, `boundingBox` (or `null` for global), `fetchForBbox()`.
3. Register in `background.js` → `new DataAggregator([..., new NameDataSource()])`.
4. Add `host_permissions` in both manifests.
5. Add a source + layer block in `KomootAdapter._addLayers()`.
6. Add the new layer to `ALL_LAYERS` in `injected-komoot.js`.
7. Wire source data in `KomootAdapter.applyData()`.

See README.md for the full walkthrough with code examples.

## Adding a New Route Planning Service (Adapter)

1. Read `extension/adapters/RouteplannerAdapter.js` for the four-method interface.
2. Copy `extension/adapters/KomootAdapter.js` → `extension/adapters/<Service>Adapter.js`; replace map detection and layer logic.
3. Create `extension/injected-<service>.js` — wire up the adapter (inject it before `injected-komoot.js` or create a service-specific injected script).
4. Create `extension-<service>/manifest.json` pointing at the new injected script; add both adapter and injected scripts to `web_accessible_resources`.
5. Add the service domain to `host_permissions`.

See README.md for the full walkthrough.

## Internal Docs for Agents

Design specs and implementation plans live in `docs/superpowers/`:

- `docs/superpowers/specs/` — architecture and API design documents
- `docs/superpowers/plans/` — task-by-task implementation checklists

Read these before making significant changes to understand the intended design.

## Common Pitfalls

- **Keep both manifests in sync**: `extension/manifest.json` (Chrome) and `extension-firefox/manifest.json` (Firefox) must always have the same `host_permissions` and `web_accessible_resources` entries. When you add a new data source, add its origin to `host_permissions` in **both** files. When you add a new page-context script (anything injected by `content.js`), add it to `web_accessible_resources` in **both** files.
- **Do not add `host_permissions` for Overpass endpoints** without reading the existing comments — they were intentionally omitted to avoid store review friction; `fetch()` from a service worker context is already permitted regardless.
- **Style reloads**: Komoot switches map themes. `KomootAdapter._addHoverListeners()` re-triggers `_requestData()` on `style.load`, which re-adds all sources and layers. Any new layer must be in `_addLayers()` and `ALL_LAYERS`.
- **MV3 service worker lifecycle**: the service worker can be terminated between requests. `DataAggregator._cache` is in-memory and will be empty after wake-up — this is fine because `fetchForBbox` rebuilds the cache on every miss.
- **NDW and Luxembourg caches live in their `DataSource` instances**: the aggregator holds single instances so the 15-min caches persist across viewport changes within the same service worker lifetime.
- **Firefox compatibility**: keep manifest differences limited to `extension-firefox/manifest.json`; shared `extension/` code must work for both browsers.
- **Page-context scripts are not ES modules**: `adapters/KomootAdapter.js` and `injected-komoot.js` are injected as plain `<script>` tags and cannot use `import`. `KomootAdapter.js` defines globals (no IIFE); `injected-komoot.js` consumes them. Both must be listed in `web_accessible_resources`. `RouteplannerAdapter.js` is documentation only, not a runtime dependency.
- **Injection order matters**: `content.js` injects `KomootAdapter.js` first and waits for its `load` event before injecting `injected-komoot.js`. If you add another adapter script, follow the same sequential pattern.
- **Data key for Flanders**: the data blob sent from `background.js` → `content.js` → `injected-komoot.js` uses `flanders` as the key for Flanders/GIPOD data. The `FlandersDataSource.id` and `SOURCE_FLANDERS` constant in `injected-komoot.js` must stay in sync.
- **RideWithGPS dual-library detection**: `RideWithGPSAdapter._mapType` is set once in `onMapReady` by checking `typeof map.getSource === 'function'`. All four interface methods branch on this flag. If you add a feature that behaves differently per library, add it to **both** branches and update the `_mapType` check if the heuristic ever proves unreliable.
- **Leaflet `_lastData`**: `setLimitedVisible` on the Leaflet path re-calls `_applyDataLeaflet(this._lastData)`. If `_lastData` is `null` (no data fetched yet), the call is skipped. This is intentional — the filter will be applied on the next `applyData` call.
- **Strava URL redirect**: `https://www.strava.com/routes/new` server-redirects to `https://www.strava.com/maps/create`. The content script match must include `https://www.strava.com/maps/*` — matching only `/routes/*` means the script never runs.
- **Strava actually uses MapLibre GL aliased as `window.mapboxgl`**: The canvas DOM class is `maplibregl-canvas`, not `mapboxgl-canvas`. Strava assigns the MapLibre library to `window.mapboxgl`, so the interceptor works, but any DOM selector using `.mapboxgl-canvas` will find nothing. Use `map.getCanvas()` / `map.getCanvasContainer()` via the map API instead. DOM polling must query both classes.
- **On some Strava URLs the map is created before `window.mapboxgl` is assigned**: The constructor patch (`PatchedMap`) only catches maps created after the patch. For maps created before it, `StravaAdapter` patches `Map.prototype.fire` so any already-existing instance is caught the moment it dispatches its first event.
- **Strava route-drawing canvas blocks MapLibre layer events**: Strava renders a second canvas on top of MapLibre's for route drawing. This overlay canvas captures all mouse events before MapLibre sees them, so `map.on('mouseenter', layerId, …)` never fires. `StravaAdapter._addHoverListeners` uses `mousemove` on `map.getCanvasContainer()` + `map.queryRenderedFeatures()` instead — the same technique MapLibre uses internally, applied at the container level.
