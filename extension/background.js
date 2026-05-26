/**
 * background.js — MV3 Service Worker
 * Handles data fetching from GIPOD and caching in chrome.storage.local.
 */

const CACHE_PREFIX = 'rw_cache_';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Cyclist-relevant Level-0 consequence UUID from GIPOD taxonomy
const CYCLIST_L0_UUID = '82e84ba4-b3e9-4171-9834-ec18dca16485';

// Snap a bbox value to a grid step for stable cache keys
function snap(v, step) {
  return Math.floor(v / step) * step;
}

function getBboxCacheKey(bbox) {
  // 0.25° grid — each tile covers roughly 20 km at Belgian latitudes
  const w = snap(bbox.west,  0.25);
  const s = snap(bbox.south, 0.25);
  const e = snap(bbox.east  + 0.25, 0.25);
  const n = snap(bbox.north + 0.25, 0.25);
  return `${CACHE_PREFIX}${w},${s},${e},${n}`;
}

// ── GIPOD fetchers ──────────────────────────────────────────────────────────

async function fetchGipodHindrance(bbox) {
  const base = 'https://geo.api.vlaanderen.be/GIPOD/ogc/features/v1/collections/HINDERGEVOLG/items';
  const params = new URLSearchParams({
    f: 'application/geo+json',
    bbox: `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`,
    'bbox-crs': 'http://www.opengis.net/def/crs/OGC/1.3/CRS84',
    limit: '500',
  });

  const res = await fetch(`${base}?${params}`);
  if (!res.ok) throw new Error(`GIPOD HINDERGEVOLG HTTP ${res.status}`);
  return res.json();
}

async function fetchGipodDiversions(bbox) {
  const base = 'https://geo.api.vlaanderen.be/GIPOD/ogc/features/v1/collections/OMLEIDING/items';
  const params = new URLSearchParams({
    f: 'application/geo+json',
    bbox: `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`,
    'bbox-crs': 'http://www.opengis.net/def/crs/OGC/1.3/CRS84',
    limit: '200',
  });

  const res = await fetch(`${base}?${params}`);
  if (!res.ok) throw new Error(`GIPOD OMLEIDING HTTP ${res.status}`);
  return res.json();
}

// ── Normalisation ───────────────────────────────────────────────────────────

function isCyclistFeature(props) {
  const l0     = (props.ConsequenceTreeLevel0   || '').toLowerCase();
  const l0id   = (props.ConsequenceTreeLevel0Id || '');
  return l0.includes('fiets') || l0id.includes(CYCLIST_L0_UUID);
}

function normaliseSeverity(props) {
  const l1 = (props.ConsequenceTreeLevel1 || props.Consequence || '').toLowerCase();
  if (l1.includes('geen doorgang')) return 'full_closure';
  if (l1.includes('beperkte doorgang')) return 'partial';
  return 'partial';
}

function normaliseHindrance(feature) {
  const p = feature.properties || {};
  return {
    ...feature,
    properties: {
      source:      'gipod',
      id:          p.ZoneId || p.fid || '',
      description: p.HindranceDescription || 'Wegwerken',
      start:       p.HindranceStart || null,
      end:         p.HindranceEnd   || null,
      severity:    normaliseSeverity(p),
      owner:       p.HindranceOwner || '',
      consequence: p.ConsequenceTreeLevel1 || p.Consequence || '',
      infoUrl:     p.HindranceUri || p.Uri || null,
    },
  };
}

function normaliseDiversion(feature) {
  const p = feature.properties || {};
  return {
    ...feature,
    properties: {
      source:      'gipod_diversion',
      id:          p.DiversionId || p.fid || '',
      description: p.HindranceDescription || 'Omleiding',
      start:       p.HindranceStart || null,
      end:         p.HindranceEnd   || null,
      owner:       p.HindranceOwner || '',
      infoUrl:     p.HindranceURI || p.HindranceUri || null,
    },
  };
}

// ── Brussels Mobility WFS fetcher ───────────────────────────────────────────
// Public GeoServer WFS (no auth required).
// Wallonia (SPW/SOFICO-TRADEMEX at https://ws.sofico-trademex.be/) requires a
// signed contract + credentials and is therefore not yet included.

async function fetchBrusselsEvents(bbox) {
  const base = 'https://data.mobility.brussels/geoserver/bm_traffic/wfs';
  // CQL BBOX uses CRS:84 (lon-lat) axis order
  const cql  = `BBOX(geometry,${bbox.west},${bbox.south},${bbox.east},${bbox.north},'CRS:84') AND is_active=true AND importance<>'0'`;
  const params = new URLSearchParams({
    service:      'wfs',
    version:      '1.1.0',
    request:      'GetFeature',
    typeName:     'bm_traffic:events',
    outputFormat: 'json',
    srsName:      'EPSG:4326',
    CQL_FILTER:   cql,
    maxFeatures:  '200',
  });
  const res = await fetch(`${base}?${params}`);
  if (!res.ok) throw new Error(`Brussels WFS HTTP ${res.status}`);
  return res.json();
}

function normaliseBrusselsEvent(feature) {
  const p   = feature.properties || {};
  const imp = parseInt(p.importance, 10) || 0;
  return {
    ...feature,
    properties: {
      source:      'brussels',
      id:          String(p.fid || ''),
      description: [p.type_fr?.trim() || p.type_nl?.trim(), p.location_fr || p.location_nl].filter(Boolean).join(' — ') || 'Travaux',
      location:    p.location_fr || p.location_nl || '',
      start:       p.start_time || null,
      end:         p.end_time   || null,
      severity:    imp >= 3 ? 'full_closure' : 'partial',
      owner:       'Bruxelles Mobilité',
      consequence: p.consequences_fr || p.consequences_nl || '',
      infoUrl:     null,
    },
  };
}

// Rough bounding box for the Brussels Capital Region (with a small buffer)
function bboxOverlapsBrussels(bbox) {
  return bbox.east  > 4.20 && bbox.west  < 4.50 &&
         bbox.north > 50.74 && bbox.south < 50.95;
}

// ── Message handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'FETCH_ROADWORKS') return false;

  (async () => {
    const { bbox } = message;
    const cacheKey = getBboxCacheKey(bbox);

    // Return cached result if still fresh
    const stored = await chrome.storage.local.get(cacheKey);
    const cached = stored[cacheKey];
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      sendResponse({ success: true, data: cached.data, fromCache: true });
      return;
    }

    try {
      const fetchJobs = [
        fetchGipodHindrance(bbox),
        fetchGipodDiversions(bbox),
        bboxOverlapsBrussels(bbox) ? fetchBrusselsEvents(bbox) : Promise.resolve(null),
      ];
      const [hindranceResult, diversionResult, brusselsResult] = await Promise.allSettled(fetchJobs);

      const hindrances = hindranceResult.status === 'fulfilled'
        ? hindranceResult.value.features
            .filter(f => isCyclistFeature(f.properties || {}))
            .map(normaliseHindrance)
        : [];

      const diversions = diversionResult.status === 'fulfilled'
        ? diversionResult.value.features.map(normaliseDiversion)
        : [];

      const brusselsRaw = brusselsResult.status === 'fulfilled' && brusselsResult.value
        ? brusselsResult.value.features || []
        : [];
      const brussels = brusselsRaw.map(normaliseBrusselsEvent);

      const data = {
        hindrances: { type: 'FeatureCollection', features: hindrances },
        brussels:   { type: 'FeatureCollection', features: brussels },
        diversions: { type: 'FeatureCollection', features: diversions },
      };

      // Purge stale entries to keep storage lean (keep last 20 tiles)
      const allStored = await chrome.storage.local.get(null);
      const staleKeys = Object.keys(allStored)
        .filter(k => k.startsWith(CACHE_PREFIX) && k !== cacheKey)
        .sort((a, b) => (allStored[a].fetchedAt || 0) - (allStored[b].fetchedAt || 0))
        .slice(0, -20); // remove oldest beyond 20
      if (staleKeys.length) await chrome.storage.local.remove(staleKeys);

      await chrome.storage.local.set({ [cacheKey]: { data, fetchedAt: Date.now() } });

      sendResponse({ success: true, data });
    } catch (err) {
      console.error('[RoadWorks BG]', err);
      sendResponse({ success: false, error: String(err) });
    }
  })();

  return true; // keep message channel open for async response
});
