# Komoot Road Works — Agent Guide

A Chrome/Firefox extension (Manifest V3) that overlays cycling construction works and road closures on the [Komoot](https://www.komoot.com) route planner map.

## Architecture

Three-layer browser extension with MV3 sandbox isolation:

```
popup.html / popup.js          ← user toggles (chrome.storage.local)
       ↕ chrome.runtime.sendMessage
content.js                     ← content script, injected at document_start
       ↕ window.postMessage
injected.js                    ← runs in page context, patches maplibregl
       ↕ MapLibre map instance (Komoot's bundled copy)
background.js                  ← service worker, fetches & caches geo data
```

**Why the indirection:** MV3 content scripts cannot access objects created by the host page's JS. `injected.js` is inserted into the page's JS context via `content.js` so it can intercept Komoot's MapLibre instance.

## Data Sources

All sources are fetched by `background.js` and normalised to a common GeoJSON property schema before being returned to `injected.js`.

| Source | Coverage | API style | Key file section |
|--------|----------|-----------|-----------------|
| GIPOD | Flanders, BE | OGC Features (GeoJSON) | `fetchGipod()` |
| Brussels Mobility | Brussels, BE | WFS (GeoServer JSON) | `fetchBrussels()` |
| NDW | Netherlands | DATEX II XML, gzipped | `fetchNdw()` |
| OpenStreetMap | Global | Overpass API (JSON) | `fetchOsm()` |

### Normalised feature schema

```js
{
  source:      'gipod' | 'brussels' | 'ndw' | 'osm',
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
| `extension/background.js` | Service worker. Fetches all four sources, normalises, caches by 0.25° bbox tile (10 min TTL). Returns merged GeoJSON FeatureCollection. |
| `extension/content.js` | Bridges popup ↔ injected. Injects `injected.js` at `document_start`. |
| `extension/injected.js` | Patches `window.mapboxgl` / `maplibregl` to capture map instance. Adds GeoJSON sources + 7 layers. Renders hover popups. Re-requests data on pan/zoom/style-reload. |
| `extension/popup.html` / `popup.js` | Toggle UI. Persists `overlayEnabled` and `showLimitedAccess` to `chrome.storage.local`. |
| `extension/manifest.json` | Chrome MV3 manifest. |
| `extension-firefox/manifest.json` | Firefox variant (adds `browser_specific_settings`, adjusts background script declaration). |
| `build.sh` | Packages unpacked dirs and zip archives for Chrome Web Store and Firefox AMO. |

## Caching Strategy

- **Bbox tile cache** (`background.js`): viewport snapped to 0.25° grid; up to 20 tiles kept in memory with a 10-minute TTL.
- **NDW global cache**: separate 15-minute TTL for the large gzipped DATEX II feed.
- **Source resilience**: `Promise.allSettled()` — one source failure never blocks the others.
- **Overpass mirrors**: four fallback endpoints tried in order.

## Map Layer Naming Convention

Layers registered in `injected.js`:

| Layer ID | Source | Shape |
|----------|--------|-------|
| `roadworks-hindrances` | GIPOD | fill polygon |
| `roadworks-hindrances-outline` | GIPOD | line |
| `roadworks-brussels` | Brussels | circle |
| `roadworks-ndw` | NDW | line |
| `roadworks-osm-line` | OSM ways | dashed line |
| `roadworks-osm-circle` | OSM nodes | circle |
| _(hover popup)_ | all | MapLibre Popup |

Severity colours: full closure `#E53935` / `#C62828` (OSM), partial `#FB8C00` / `#E65100` (OSM).

## Running Tests

```bash
# Unit tests (no browser needed)
node test-normalise-osm.js

# E2E test (requires Chrome + a loaded extension)
node test-extension.js
```

No `package.json` — the project is vanilla JS with no npm dependencies. Playwright is expected to be available globally or via `npx`.

## Building

```bash
bash build.sh
```

Outputs to `dist/` (gitignored):

```
dist/chrome/                        # unpacked, load via chrome://extensions
dist/firefox/                       # unpacked, load as temporary add-on
dist/komoot-roadworks-chrome.zip
dist/komoot-roadworks-firefox.zip
```

## Internal Docs for Agents

Design specs and implementation plans live in `docs/superpowers/`:

- `docs/superpowers/specs/` — architecture and API design documents
- `docs/superpowers/plans/` — task-by-task implementation checklists

Read these before making significant changes to understand the intended design.

## Common Pitfalls

- **Do not add `host_permissions` for Overpass endpoints** in the manifest without reading the existing comments — they were intentionally left out to avoid review friction; the extension uses `fetch()` directly from the service worker context where it is already permitted.
- **Style reloads**: Komoot switches map styles (light/dark). `injected.js` re-adds sources and layers on every `style.load` event; any new layers must be registered there.
- **MV3 service worker lifecycle**: the service worker can be terminated between requests. Do not assume in-memory state persists across calls to `background.js`; use the tile cache with TTL checks.
- **Firefox compatibility**: keep `manifest.json` differences limited to `extension-firefox/manifest.json`; the shared `extension/` directory must work for both browsers.
