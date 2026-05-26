# OSM Work Areas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OSM `highway=construction` and `barrier=construction` as a live global data source shown alongside existing GIPOD/Brussels/NDW overlays on Komoot.

**Architecture:** A new `fetchOsmConstruction(bbox)` function in `background.js` POSTs to the Overpass API, normalises the result, and returns a GeoJSON FeatureCollection stored under `osm` in the existing bbox cache. `content.js` forwards the `osm` field unchanged. `injected.js` renders it on two new layers (`rw-osm-line` for ways, `rw-osm-circle` for nodes) sharing one source, using crimson-shifted tints and a dashed line style to visually distinguish OSM from official sources.

**Tech Stack:** Chrome Extension MV3, MapLibre GL JS (via Komoot's bundle), Overpass API, Playwright (E2E tests)

---

## File Map

| File | Change |
|---|---|
| `extension/background.js` | Add `normaliseOsmElement`, `fetchOsmConstruction`, wire into message handler |
| `extension/content.js` | Forward `osm` field in `RW_DATA` message |
| `extension/injected.js` | Add `SOURCE_OSM`, `LAYER_OSM_LINE`, `LAYER_OSM_CIRCLE`, update `addLayers`, `applyData`, `setVisible`, `setLimitedVisible`, hover handlers |
| `extension/popup.html` | Add OSM row to data sources list |
| `test-extension.js` | Add OSM layer/source checks |
| `test-normalise-osm.js` | New — unit tests for `normaliseOsmElement` (Node.js, no framework) |

---

## Task 1: Unit-test and implement `normaliseOsmElement` in background.js

**Files:**
- Create: `test-normalise-osm.js`
- Modify: `extension/background.js`

- [ ] **Step 1: Write the failing unit test**

Create `test-normalise-osm.js` at the repo root:

```js
// test-normalise-osm.js — run with: node test-normalise-osm.js
const assert = require('assert');

// Paste the function under test here before running
// (will be replaced by require once extracted to a module)
function normaliseOsmElement(el) {
  throw new Error('not implemented');
}

// ── Test 1: highway=construction way, no access tag → full_closure LineString ─
{
  const way = {
    type: 'way', id: 123456,
    geometry: [{ lat: 51.0, lon: 4.0 }, { lat: 51.1, lon: 4.1 }],
    tags: { highway: 'construction', construction: 'cycleway' },
  };
  const f = normaliseOsmElement(way);
  assert.equal(f.properties.source, 'osm');
  assert.equal(f.properties.id, 'way/123456');
  assert.equal(f.properties.severity, 'full_closure');
  assert.equal(f.properties.infoUrl, 'https://www.openstreetmap.org/way/123456');
  assert.equal(f.properties.owner, 'OpenStreetMap');
  assert.equal(f.geometry.type, 'LineString');
  assert.deepEqual(f.geometry.coordinates, [[4.0, 51.0], [4.1, 51.1]]);
  console.log('✓ Test 1: highway=construction way');
}

// ── Test 2: barrier=construction node with access=permissive → partial Point ──
{
  const node = {
    type: 'node', id: 789,
    lat: 51.05, lon: 4.05,
    tags: { barrier: 'construction', access: 'permissive' },
  };
  const f = normaliseOsmElement(node);
  assert.equal(f.geometry.type, 'Point');
  assert.deepEqual(f.geometry.coordinates, [4.05, 51.05]);
  assert.equal(f.properties.severity, 'partial');
  assert.equal(f.properties.id, 'node/789');
  assert.equal(f.properties.infoUrl, 'https://www.openstreetmap.org/node/789');
  console.log('✓ Test 2: barrier=construction node, access=permissive');
}

// ── Test 3: access=yes → partial ─────────────────────────────────────────────
{
  const node = {
    type: 'node', id: 111,
    lat: 51.0, lon: 4.0,
    tags: { barrier: 'construction', access: 'yes' },
  };
  const f = normaliseOsmElement(node);
  assert.equal(f.properties.severity, 'partial');
  console.log('✓ Test 3: access=yes → partial');
}

// ── Test 4: way with no geometry → null (skip) ────────────────────────────────
{
  const bad = { type: 'way', id: 999, tags: { highway: 'construction' } };
  assert.equal(normaliseOsmElement(bad), null);
  console.log('✓ Test 4: way with no geometry → null');
}

// ── Test 5: way with 1 point geometry → null (not a valid LineString) ─────────
{
  const bad = {
    type: 'way', id: 1000,
    geometry: [{ lat: 51.0, lon: 4.0 }],
    tags: { highway: 'construction' },
  };
  assert.equal(normaliseOsmElement(bad), null);
  console.log('✓ Test 5: way with 1 point → null');
}

// ── Test 6: name tag used as description ──────────────────────────────────────
{
  const way = {
    type: 'way', id: 222,
    geometry: [{ lat: 51.0, lon: 4.0 }, { lat: 51.1, lon: 4.1 }],
    tags: { highway: 'construction', name: 'Fietsbrug werken' },
  };
  const f = normaliseOsmElement(way);
  assert.equal(f.properties.description, 'Fietsbrug werken');
  console.log('✓ Test 6: name tag used as description');
}

// ── Test 7: start_date / end_date preserved ───────────────────────────────────
{
  const way = {
    type: 'way', id: 333,
    geometry: [{ lat: 51.0, lon: 4.0 }, { lat: 51.1, lon: 4.1 }],
    tags: { highway: 'construction', start_date: '2026-01-01', end_date: '2026-12-31' },
  };
  const f = normaliseOsmElement(way);
  assert.equal(f.properties.start, '2026-01-01');
  assert.equal(f.properties.end,   '2026-12-31');
  console.log('✓ Test 7: start_date / end_date preserved');
}

console.log('\nAll normalisation tests passed.');
```

- [ ] **Step 2: Run the test — expect failure**

```bash
node test-normalise-osm.js
```

Expected output: `Error: not implemented`

- [ ] **Step 3: Implement `normaliseOsmElement` in background.js**

Open `extension/background.js`. After the closing `}` of `bboxOverlapsNetherlands` (around line 283), add:

```js
// ── OpenStreetMap (Overpass) ────────────────────────────────────────────────

function normaliseOsmElement(el) {
  const tags  = el.tags || {};
  const isWay = el.type === 'way';
  const id    = `${el.type}/${el.id}`;

  let description;
  if (tags.name) {
    description = tags.name;
  } else if (tags.highway === 'construction' && tags.construction) {
    description = `Wegwerkzaamheden (${tags.construction})`;
  } else if (tags.highway === 'construction') {
    description = 'Wegwerkzaamheden';
  } else {
    description = 'Constructiebarrière';
  }

  const access   = tags.access || '';
  const severity = (access === 'permissive' || access === 'yes') ? 'partial' : 'full_closure';

  const properties = {
    source:      'osm',
    id,
    description,
    start:       tags.start_date || null,
    end:         tags.end_date   || null,
    severity,
    owner:       'OpenStreetMap',
    consequence: '',
    infoUrl:     `https://www.openstreetmap.org/${id}`,
  };

  let geometry;
  if (isWay) {
    if (!el.geometry || el.geometry.length < 2) return null;
    geometry = {
      type:        'LineString',
      coordinates: el.geometry.map(p => [p.lon, p.lat]),
    };
  } else {
    geometry = { type: 'Point', coordinates: [el.lon, el.lat] };
  }

  return { type: 'Feature', geometry, properties };
}
```

- [ ] **Step 4: Copy the implementation into `test-normalise-osm.js` and run**

Replace the `throw new Error('not implemented')` stub at the top of `test-normalise-osm.js` with the full `normaliseOsmElement` implementation from Step 3.

```bash
node test-normalise-osm.js
```

Expected:
```
✓ Test 1: highway=construction way
✓ Test 2: barrier=construction node, access=permissive
✓ Test 3: access=yes → partial
✓ Test 4: way with no geometry → null
✓ Test 5: way with 1 point → null
✓ Test 6: name tag used as description
✓ Test 7: start_date / end_date preserved

All normalisation tests passed.
```

- [ ] **Step 5: Commit**

```bash
git add extension/background.js test-normalise-osm.js
git commit -m "feat: add normaliseOsmElement for Overpass construction data"
```

---

## Task 2: Add `fetchOsmConstruction` and wire into the message handler

**Files:**
- Modify: `extension/background.js`

- [ ] **Step 1: Add the fetch function**

Directly after `normaliseOsmElement` (end of Task 1's block), add:

```js
async function fetchOsmConstruction(bbox) {
  const query = `[out:json][timeout:25][bbox:${bbox.south},${bbox.west},${bbox.north},${bbox.east}];
(
  way[highway=construction];
  way[barrier=construction];
  node[barrier=construction];
);
out geom;`;

  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    'data=' + encodeURIComponent(query),
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const json = await res.json();
  const features = (json.elements || [])
    .map(normaliseOsmElement)
    .filter(Boolean);
  return { type: 'FeatureCollection', features };
}
```

- [ ] **Step 2: Add OSM to the `fetchJobs` array in the message handler**

Find this block in the `chrome.runtime.onMessage.addListener` handler (around line 302):

```js
      const fetchJobs = [
        fetchGipodHindrance(bbox),
        fetchGipodDiversions(bbox),
        bboxOverlapsBrussels(bbox)     ? fetchBrusselsEvents(bbox) : Promise.resolve(null),
        bboxOverlapsNetherlands(bbox)  ? fetchNdwClosures()        : Promise.resolve(null),
      ];
      const [hindranceResult, diversionResult, brusselsResult, ndwResult] = await Promise.allSettled(fetchJobs);
```

Replace with:

```js
      const fetchJobs = [
        fetchGipodHindrance(bbox),
        fetchGipodDiversions(bbox),
        bboxOverlapsBrussels(bbox)     ? fetchBrusselsEvents(bbox) : Promise.resolve(null),
        bboxOverlapsNetherlands(bbox)  ? fetchNdwClosures()        : Promise.resolve(null),
        fetchOsmConstruction(bbox),
      ];
      const [hindranceResult, diversionResult, brusselsResult, ndwResult, osmResult] = await Promise.allSettled(fetchJobs);
```

- [ ] **Step 3: Normalise the OSM result**

Find this block (after the ndw normalization, around line 325):

```js
      const ndwAll = ndwResult.status === 'fulfilled' && ndwResult.value
        ? ndwResult.value  // already an array of normalised features
        : [];
      const ndw = filterNdwByBbox(ndwAll, bbox);
```

After it, add:

```js
      const osm = osmResult.status === 'fulfilled' && osmResult.value
        ? osmResult.value
        : { type: 'FeatureCollection', features: [] };
```

- [ ] **Step 4: Add `osm` to the cached data object**

Find:

```js
      const data = {
        hindrances: { type: 'FeatureCollection', features: hindrances },
        brussels:   { type: 'FeatureCollection', features: brussels },
        ndw:        { type: 'FeatureCollection', features: ndw },
        diversions: { type: 'FeatureCollection', features: diversions },
      };
```

Replace with:

```js
      const data = {
        hindrances: { type: 'FeatureCollection', features: hindrances },
        brussels:   { type: 'FeatureCollection', features: brussels },
        ndw:        { type: 'FeatureCollection', features: ndw },
        diversions: { type: 'FeatureCollection', features: diversions },
        osm,
      };
```

- [ ] **Step 5: Commit**

```bash
git add extension/background.js
git commit -m "feat: fetch OSM construction data via Overpass API"
```

---

## Task 3: Forward `osm` through content.js

**Files:**
- Modify: `extension/content.js`

- [ ] **Step 1: Add `osm` to the RW_DATA message**

Find (around line 47):

```js
          window.postMessage({
            __rw:       FROM_CONTENT,
            type:       'RW_DATA',
            hindrances: response.data.hindrances,
            brussels:   response.data.brussels,
            ndw:        response.data.ndw,
            diversions: response.data.diversions,
          }, '*');
```

Replace with:

```js
          window.postMessage({
            __rw:       FROM_CONTENT,
            type:       'RW_DATA',
            hindrances: response.data.hindrances,
            brussels:   response.data.brussels,
            ndw:        response.data.ndw,
            diversions: response.data.diversions,
            osm:        response.data.osm,
          }, '*');
```

- [ ] **Step 2: Commit**

```bash
git add extension/content.js
git commit -m "feat: forward OSM data through content script bridge"
```

---

## Task 4: Add OSM source, layers, and interactions to injected.js

**Files:**
- Modify: `extension/injected.js`

- [ ] **Step 1: Add source and layer constants**

Find the existing constants block (around line 23):

```js
  const SOURCE_HINDRANCE      = 'rw-hindrances';
  const SOURCE_DIVERSION      = 'rw-diversions';
  const SOURCE_BRUSSELS       = 'rw-brussels';
  const SOURCE_NDW             = 'rw-ndw';
  const LAYER_FILL             = 'rw-fill';
  const LAYER_OUTLINE          = 'rw-outline';
  const LAYER_DIVERSION        = 'rw-diversion';
  const LAYER_BRUSSELS_CIRCLE  = 'rw-brussels-circle';
  const LAYER_NDW_LINE         = 'rw-ndw-line';
```

Replace with:

```js
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
  const LAYER_OSM_LINE         = 'rw-osm-line';
  const LAYER_OSM_CIRCLE       = 'rw-osm-circle';
```

- [ ] **Step 2: Add OSM source and layers in `addLayers`**

Find the NDW layer block in `addLayers` (ends around line 163):

```js
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
```

After the closing `}` of that block, add:

```js
    // OSM construction data (Overpass) — crimson-shifted tints, dashed lines
    if (!map.getSource(SOURCE_OSM)) {
      map.addSource(SOURCE_OSM, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }
    if (!map.getLayer(LAYER_OSM_LINE)) {
      map.addLayer({
        id:     LAYER_OSM_LINE,
        type:   'line',
        source: SOURCE_OSM,
        filter: ['==', ['geometry-type'], 'LineString'],
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
```

- [ ] **Step 3: Add hover handlers for the two OSM layers**

Find the hover handler block (around line 175):

```js
    map.on('mouseenter', LAYER_NDW_LINE,        (e) => { map.getCanvas().style.cursor = 'pointer'; onFeatureHover(e); });
    map.on('mouseleave', LAYER_NDW_LINE,        ()  => { map.getCanvas().style.cursor = ''; scheduleHide(450); });
```

After those two lines, add:

```js
    map.on('mouseenter', LAYER_OSM_LINE,        (e) => { map.getCanvas().style.cursor = 'pointer'; onFeatureHover(e); });
    map.on('mouseleave', LAYER_OSM_LINE,        ()  => { map.getCanvas().style.cursor = ''; scheduleHide(450); });
    map.on('mouseenter', LAYER_OSM_CIRCLE,      (e) => { map.getCanvas().style.cursor = 'pointer'; onFeatureHover(e); });
    map.on('mouseleave', LAYER_OSM_CIRCLE,      ()  => { map.getCanvas().style.cursor = ''; scheduleHide(450); });
```

- [ ] **Step 4: Update `applyData` to accept and render OSM data**

Find the function signature (around line 189):

```js
  function applyData(map, hindrances, brussels, ndw, diversions) {
```

Replace with:

```js
  function applyData(map, hindrances, brussels, ndw, diversions, osm) {
```

Find the source update block inside `applyData` (around line 202):

```js
    const hSrc = map.getSource(SOURCE_HINDRANCE);
    const bSrc = map.getSource(SOURCE_BRUSSELS);
    const nSrc = map.getSource(SOURCE_NDW);
    const dSrc = map.getSource(SOURCE_DIVERSION);
    if (hSrc) hSrc.setData(hindrances || { type: 'FeatureCollection', features: [] });
    if (bSrc) bSrc.setData(brussels   || { type: 'FeatureCollection', features: [] });
    if (nSrc) nSrc.setData(ndw        || { type: 'FeatureCollection', features: [] });
    if (dSrc) dSrc.setData(diversions || { type: 'FeatureCollection', features: [] });
    const hCount = (hindrances && hindrances.features) ? hindrances.features.length : 0;
    const bCount = (brussels   && brussels.features)   ? brussels.features.length   : 0;
    const nCount = (ndw        && ndw.features)        ? ndw.features.length        : 0;
    const dCount = (diversions && diversions.features) ? diversions.features.length : 0;
    if (hCount + bCount + nCount + dCount > 0) {
      console.log(`[RoadWorks] ${hCount} GIPOD, ${bCount} Brussels, ${nCount} NDW, ${dCount} diversions`);
    }
```

Replace with:

```js
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
```

- [ ] **Step 5: Pass `osm` in the RW_DATA message handler**

Find (around line 46):

```js
    if (type === 'RW_DATA' && activeMap) {
      applyData(activeMap, e.data.hindrances, e.data.brussels, e.data.ndw, e.data.diversions);
    }
```

Replace with:

```js
    if (type === 'RW_DATA' && activeMap) {
      applyData(activeMap, e.data.hindrances, e.data.brussels, e.data.ndw, e.data.diversions, e.data.osm);
    }
```

- [ ] **Step 6: Add OSM layers to `setVisible`**

Find (around line 218):

```js
    [LAYER_FILL, LAYER_OUTLINE, LAYER_BRUSSELS_CIRCLE, LAYER_NDW_LINE, LAYER_DIVERSION].forEach((id) => {
```

Replace with:

```js
    [LAYER_FILL, LAYER_OUTLINE, LAYER_BRUSSELS_CIRCLE, LAYER_NDW_LINE, LAYER_DIVERSION, LAYER_OSM_LINE, LAYER_OSM_CIRCLE].forEach((id) => {
```

- [ ] **Step 7: Add OSM layers to `setLimitedVisible`**

Find (around line 226):

```js
    [LAYER_FILL, LAYER_OUTLINE, LAYER_BRUSSELS_CIRCLE, LAYER_NDW_LINE].forEach((id) => {
```

Replace with:

```js
    [LAYER_FILL, LAYER_OUTLINE, LAYER_BRUSSELS_CIRCLE, LAYER_NDW_LINE, LAYER_OSM_LINE, LAYER_OSM_CIRCLE].forEach((id) => {
```

- [ ] **Step 8: Commit**

```bash
git add extension/injected.js
git commit -m "feat: add OSM construction layers to map overlay"
```

---

## Task 5: Update popup.html

**Files:**
- Modify: `extension/popup.html`

- [ ] **Step 1: Add OSM to the data sources list**

Find (around line 155):

```html
  <div class="source disabled">
    <span class="dot pending"></span>
    <span>SPW — Wallonia</span>
    <span class="badge soon">Soon</span>
  </div>
```

Add the OSM row directly before the SPW row:

```html
  <div class="source">
    <span class="dot active"></span>
    <span>OpenStreetMap — Global</span>
    <span class="badge live">Live</span>
  </div>
  <div class="source disabled">
    <span class="dot pending"></span>
    <span>SPW — Wallonia</span>
    <span class="badge soon">Soon</span>
  </div>
```

- [ ] **Step 2: Commit**

```bash
git add extension/popup.html
git commit -m "feat: add OSM to data sources list in popup"
```

---

## Task 6: Update E2E test to verify OSM layers

**Files:**
- Modify: `test-extension.js`

- [ ] **Step 1: Add OSM source and layer checks to the Flanders test block**

Find the `layerData` evaluation block (around line 194). Inside the returned object, after `ndwFeatures: srcCount(nSrc)`, add:

```js
      const oSrc = map.getSource('rw-osm');
```

And extend the return object:

```js
      return {
        zoom: map.getZoom().toFixed(1),
        hindranceSourceExists: !!hSrc,
        diversionSourceExists: !!dSrc,
        hindranceFillLayer: !!map.getLayer('rw-fill'),
        diversionLayer: !!map.getLayer('rw-diversion'),
        brusselsLayer: !!map.getLayer('rw-brussels-circle'),
        ndwLayer: !!map.getLayer('rw-ndw-line'),
        osmLineLayer: !!map.getLayer('rw-osm-line'),
        osmCircleLayer: !!map.getLayer('rw-osm-circle'),
        osmSourceExists: !!oSrc,
        hindranceFeatures: srcFeatureCount(hSrc),
        diversionFeatures: srcFeatureCount(dSrc),
        brusselsFeatures:  srcFeatureCount(bSrc),
        ndwFeatures:       srcFeatureCount(nSrc),
        osmFeatures:       srcFeatureCount(oSrc),
      };
```

After the `console.log('Flanders layer data:', layerData);` line, add assertions:

```js
  if (!layerData.osmLineLayer)   console.log('  ✗ OSM line layer missing');
  else                           console.log('  ✓ OSM line layer present');
  if (!layerData.osmCircleLayer) console.log('  ✗ OSM circle layer missing');
  else                           console.log('  ✓ OSM circle layer present');
  if (!layerData.osmSourceExists) console.log('  ✗ OSM source missing');
  else                            console.log(`  ✓ OSM source present (${layerData.osmFeatures} features)`);
```

- [ ] **Step 2: Run the E2E test**

```bash
node test-extension.js
```

Expected to see in output:
```
  ✓ OSM line layer present
  ✓ OSM circle layer present
  ✓ OSM source present (N features)
```

If OSM layers are missing, check that `extension/injected.js` was saved correctly and the extension was reloaded in the browser.

- [ ] **Step 3: Commit**

```bash
git add test-extension.js
git commit -m "test: verify OSM layers in E2E test"
```

---

## Self-review checklist

After completing all tasks, verify:

- [ ] `node test-normalise-osm.js` — all 7 tests pass
- [ ] `node test-extension.js` — OSM line + circle layers confirmed present, source exists
- [ ] Hover a dashed red line on the map → popup shows `OpenStreetMap` as owner + clickable OSM URL link
- [ ] Partial access feature (orange) shows correctly with tinted color `#E65100`
- [ ] `setLimitedVisible(map, false)` hides OSM partial features (toggle "Limited access" off in popup)
- [ ] Toggling "Show overlay" off hides all OSM layers
- [ ] Popup.html shows "OpenStreetMap — Global" with a green Live badge
