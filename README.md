# Cycling Road Works Overlay

A browser extension that overlays active construction zones and road closures on cycling route planners — currently [Komoot](https://www.komoot.com) and [RideWithGPS](https://ridewithgps.com). Plan your route and instantly see which paths are blocked, restricted, or under construction — before you ride.

---

## Highlights

### What problem does it solve?

Komoot and RideWithGPS are excellent at finding scenic cycling routes, but neither has any awareness of temporary road works. You can plan a perfect route only to arrive at a barrier or detour notice on the day of your ride. This extension closes that gap by pulling live data from official road-work registries and painting it directly onto the map — whichever planner you use.

### Data sources

| Source | Region | Data type |
|--------|--------|-----------|
| **GIPOD** | Flanders, Belgium | Official hindrance registry — polygon areas with cyclist-specific consequences |
| **Brussels Mobility** | Brussels, Belgium | Active traffic events — points with importance rating |
| **NDW** | Netherlands | DATEX II road closures — line geometries |
| **OpenStreetMap** | Global | `highway=construction`, `barrier=construction`, `landuse=construction` |

### Severity colour coding

| Colour | Meaning |
|--------|---------|
| Red (`#E53935`) | Full closure — no passage for cyclists |
| Orange (`#FB8C00`) | Partial / limited access |
| Crimson (`#C62828`) | OSM construction area (full closure) |

### Features

- **Zero configuration** — install and visit [komoot.com/plan](https://www.komoot.com/plan) or [ridewithgps.com/routes](https://ridewithgps.com/routes/new).
- **Live data** — fetched fresh from official APIs on every map pan or zoom; cached for 10 minutes per viewport tile.
- **Hover popups** — click any overlay to see description, dates, owning organisation.
- **Toggle switch** — enable/disable the overlay from the extension popup without reloading the page.
- **Severity filter** — choose "full closures only" to reduce visual noise on busy maps.
- **Resilient** — one failing source never blocks the others; `Promise.allSettled` keeps the overlay running even during API outages.
- **Firefox + Chrome** — shared source with separate manifests.

---

## Installation

### Load as unpacked extension (development)

```bash
git clone https://github.com/khendrickx/cycling-routing-construction-areas
cd cycling-routing-construction-areas
bash build.sh
```

- **Chrome**: open `chrome://extensions` → enable Developer mode → *Load unpacked* → select `dist/chrome`
- **Firefox**: open `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → select any file in `dist/firefox`

### Packaged builds

```bash
bash build.sh        # produces dist/komoot-roadworks-chrome.zip and ...-firefox.zip
bash build.sh clean  # remove dist/ first
```

---

## Architecture

The extension is split into three layers:

```
┌─────────────────────────────────────────────────────────────┐
│ Data Input Layer                                            │
│  DataSource (abstract)  ←  GipodDataSource                 │
│                         ←  BrusselsDataSource              │
│                         ←  NdwDataSource                   │
│                         ←  OsmDataSource                   │
└──────────────────────────────┬──────────────────────────────┘
                               │ Feature[]
┌──────────────────────────────▼──────────────────────────────┐
│ Logic Layer                                                 │
│  DataAggregator  (per-bbox cache, fan-out, resilience)      │
└──────────────────────────────┬──────────────────────────────┘
                               │ { sourceId: FeatureCollection }
┌──────────────────────────────▼──────────────────────────────┐
│ Map Layer                                                              │
│  RouteplannerAdapter (interface)  ←  KomootAdapter                    │
│                                   ←  RideWithGPSAdapter               │
└────────────────────────────────────────────────────────────────────────┘
```

### Data Input Layer — `extension/datasources/`

`DataSource.js` defines the abstract base class. Every source must declare:

- **`id`** — stable string key used throughout the app (e.g. `'gipod'`)
- **`name`** — human-readable label for the popup UI
- **`boundingBox`** — `{ west, south, east, north }` in WGS-84 degrees; `null` for global coverage
- **`fetchForBbox(bbox)`** — returns a `Promise<Feature[]>` with the [normalised property schema](#normalised-feature-schema)

`DataSource.overlaps(bbox)` is provided automatically and skips sources whose coverage area has no overlap with the viewport, avoiding unnecessary network requests.

### Logic Layer — `extension/logic/`

`DataAggregator` receives an array of `DataSource` instances and:

1. Filters to sources that overlap the requested bbox.
2. Fetches all of them in parallel with `Promise.allSettled` (one failure never blocks the others).
3. Caches the merged result by snapped 0.25° tile for 10 minutes.
4. Returns `{ data: Record<sourceId, FeatureCollection>, fromCache: boolean }`.

### Map Layer — `extension/adapters/`

`RouteplannerAdapter.js` specifies the interface. Adapters are responsible for:

- Detecting the map instance on the target page
- Adding and styling GeoJSON sources + layers
- Applying incoming `dataBySource` to the map
- Responding to `setVisible` / `setLimitedVisible` commands

`KomootAdapter` (inside `injected-komoot.js`) implements this interface for Komoot's bundled MapLibre GL instance. `RideWithGPSAdapter` (inside `injected-ridewithgps.js`) implements the same interface for RideWithGPS, which can use either Leaflet or MapLibre GL depending on the page.

### Extension plumbing

```
popup.html/popup.js       →  chrome.storage.local + chrome.tabs.sendMessage(TOGGLE)
content.js                →  injects injected-komoot.js; bridges RW_FETCH ↔ FETCH_ROADWORKS
content-ridewithgps.js    →  same bridge role; injects RideWithGPSAdapter.js + injected-ridewithgps.js
background.js             →  service worker; DataAggregator.fetchForBbox()
injected-komoot.js        →  KomootAdapter; patches/detects MapLibre; renders overlay
injected-ridewithgps.js   →  RideWithGPSAdapter; detects Leaflet or MapLibre; renders overlay
```

### Normalised feature schema

All sources produce `Feature` objects with this property set:

| Property | Type | Description |
|----------|------|-------------|
| `source` | string | DataSource id (e.g. `'gipod'`) |
| `id` | string | Unique feature identifier |
| `description` | string | Human-readable label |
| `start` | string \| null | ISO date string |
| `end` | string \| null | ISO date string |
| `severity` | `'full_closure'` \| `'partial'` | Closure type |
| `owner` | string | Organisation / attribution |
| `consequence` | string | Optional detail |

---

## Developer guide

### Adding a new data source

**1. Create the source class**

```js
// extension/datasources/MyServiceDataSource.js
import { DataSource } from './DataSource.js';

export class MyServiceDataSource extends DataSource {
  get id()   { return 'myservice'; }
  get name() { return 'My Service'; }

  get boundingBox() {
    // Return the region where this source has data.
    // Use null for global coverage (source is always queried).
    return { west: 2.5, south: 49.5, east: 6.5, north: 51.5 };
  }

  async fetchForBbox(bbox) {
    const res = await fetch(`https://api.example.com/works?bbox=${bbox.west},${bbox.south},${bbox.east},${bbox.north}`);
    if (!res.ok) throw new Error(`MyService HTTP ${res.status}`);
    const json = await res.json();
    return json.items.map(item => this._normalise(item));
  }

  _normalise(item) {
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [item.lon, item.lat] },
      properties: {
        source:      'myservice',
        id:          String(item.id),
        description: item.title || 'Road works',
        start:       item.startDate || null,
        end:         item.endDate   || null,
        severity:    item.blocked ? 'full_closure' : 'partial',
        owner:       item.organization || '',
        consequence: '',
      },
    };
  }
}
```

**2. Register it in `background.js`**

```js
import { MyServiceDataSource } from './datasources/MyServiceDataSource.js';

const aggregator = new DataAggregator([
  new GipodDataSource(),
  new BrusselsDataSource(),
  new NdwDataSource(),
  new OsmDataSource(),
  new MyServiceDataSource(),   // ← add here
]);
```

**3. Add host permission in `extension/manifest.json` (and `extension-firefox/manifest.json`)**

```json
"host_permissions": [
  "https://api.example.com/*"
]
```

**4. Add a map layer in `injected-komoot.js` → `KomootAdapter._addLayers()`**

Add a new source and layer block inside `_addLayers`. The source name must match your `DataSource.id`:

```js
const SOURCE_MYSERVICE = 'rw-myservice';
const LAYER_MYSERVICE  = 'rw-myservice-circle';

// inside _addLayers():
if (!map.getSource(SOURCE_MYSERVICE)) {
  map.addSource(SOURCE_MYSERVICE, { type: 'geojson', data: EMPTY_FC });
}
if (!map.getLayer(LAYER_MYSERVICE)) {
  map.addLayer({
    id: LAYER_MYSERVICE, type: 'circle', source: SOURCE_MYSERVICE,
    paint: {
      'circle-radius': 8,
      'circle-color':  ['match', ['get', 'severity'], 'full_closure', '#E53935', '#FB8C00'],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#fff',
    },
  });
}
```

Also add the new layer to `ALL_LAYERS` so `setVisible` and `setLimitedVisible` apply to it.

**5. Wire up the data in `KomootAdapter.applyData()`**

```js
const myservice = dataBySource.myservice || empty;
const mSrc = map.getSource(SOURCE_MYSERVICE);
if (mSrc) mSrc.setData(myservice);
```

**6. Update the popup UI** (`extension/popup.html`)

Add an entry to the data sources list in the popup so users know the source is active.

---

### Adding a new route planning service

A route planning service adapter connects the shared data pipeline to a different map-based website (e.g. Strava Routes, Bikemap, Outdooractive). RideWithGPS is the reference implementation — use `extension/adapters/RideWithGPSAdapter.js` and `extension/injected-ridewithgps.js` as a template.

**1. Read the interface spec**

Open `extension/adapters/RouteplannerAdapter.js` — it documents all four methods you must implement:

| Method | Responsibility |
|--------|---------------|
| `onMapReady(map)` | Called once when the map instance is detected; add layers, register listeners |
| `applyData(dataBySource)` | Push `FeatureCollection` objects onto the map sources |
| `setVisible(visible)` | Show / hide the entire overlay |
| `setLimitedVisible(showLimited)` | Toggle partial-closure visibility |

**2. Create the adapter and injected script**

```
extension/adapters/MyServiceAdapter.js   ← adapter class (for documentation)
extension/injected-myservice.js          ← page-context script; contains the
                                            adapter class + map detection logic
```

Copy `extension/injected-komoot.js` as a starting point. Key areas to change:

- **Map detection**: Replace the `patchLib` / fiber-walk logic with whatever method detects the target site's map instance (constructor intercept, `MutationObserver`, polling for a known SDK global, etc.).
- **Layer implementation**: Implement `_addLayers` for the target SDK (Leaflet, OpenLayers, Google Maps, …). Keep the same source/layer naming conventions.
- **`_requestData`**: The `toContent('RW_FETCH', { bbox })` call and the `RW_DATA` message handler are generic — keep them as-is.

**3. Create a browser manifest for the new service**

```
extension-myservice/
└── manifest.json    ← copy from extension-firefox/manifest.json; update:
                         • content_scripts[0].matches → target service URL
                         • content_scripts[0].js → ['content.js']
                         • web_accessible_resources → ['injected-myservice.js']
                         • host_permissions → add the service domain
```

**4. Add to `build.sh`**

Follow the existing Chrome / Firefox pattern to package a `dist/myservice/` directory and zip file.

**5. Test**

The service worker (`background.js`) and all data sources are shared — no changes needed there. Focus testing on:

- Map detection fires reliably (test with hard navigation and SPA routing)
- All four adapter methods work correctly
- Layer visibility toggles apply immediately
- Style reload (if the target site switches themes) re-adds layers without duplication
