/**
 * background.js — MV3 Service Worker
 * Handles data fetching from GIPOD with in-memory per-bbox caching.
 */

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const _bboxCache = new Map(); // key -> { data, fetchedAt }

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
  return `${w},${s},${e},${n}`;
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
  // The native geometry column is 'geom' stored in Belgian Lambert (EPSG:31370).
  // GeoServer's CQL BBOX(geom,...) would need Lambert coordinates, and mixing
  // the WFS BBOX parameter with CQL_FILTER is unsupported in GET requests.
  // Solution: fetch all active events and post-filter by bbox in JS.
  const params = new URLSearchParams({
    service:      'wfs',
    version:      '1.1.0',
    request:      'GetFeature',
    typeName:     'bm_traffic:events',
    outputFormat: 'json',
    srsName:      'EPSG:4326',   // → GeoServer reprojects to [lon, lat]
    CQL_FILTER:   "is_active=true AND importance<>'0'",
    maxFeatures:  '500',
  });
  const res = await fetch(`${base}?${params}`);
  if (!res.ok) throw new Error(`Brussels WFS HTTP ${res.status}`);
  const fc = await res.json();
  // Post-filter: coordinates are [lon, lat] in EPSG:4326
  const features = (fc.features || []).filter(f => {
    const c = f.geometry && f.geometry.coordinates;
    if (!c) return false;
    const [lon, lat] = c;
    return lon >= bbox.west && lon <= bbox.east &&
           lat >= bbox.south && lat <= bbox.north;
  });
  return { type: 'FeatureCollection', features };
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

// ── Netherlands NDW closures fetcher ───────────────────────────────────────
// Public open-data file (no auth required):
// https://opendata.ndw.nu/tijdelijke_verkeersmaatregelen_afsluitingen.xml.gz
// DATEX II v3 XML, ~162 KB gzip. Refreshed every few minutes by NDW.
// Note: the larger planningsfeed_wegwerkzaamheden_en_evenementen.xml.gz (20 MB)
// covers all planned works, but is too large to download in an extension.
// The Melvin OTM REST API (bbox-filtered JSON) requires a keycloak login and
// cannot be used in a public extension without credentials.

let _ndwCache = null;
const NDW_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

async function fetchNdwClosures() {
  if (_ndwCache && Date.now() - _ndwCache.fetchedAt < NDW_CACHE_TTL_MS) {
    return _ndwCache.features;
  }
  const url = 'https://opendata.ndw.nu/tijdelijke_verkeersmaatregelen_afsluitingen.xml.gz';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`NDW closures HTTP ${res.status}`);
  const ds = new DecompressionStream('gzip');
  const xml = await new Response(res.body.pipeThrough(ds)).text();
  const features = parseNdwXml(xml);
  _ndwCache = { features, fetchedAt: Date.now() };
  return features;
}

// DATEX II causeType → Dutch label
const NDW_CAUSE_NL = {
  roadMaintenance:       'Wegonderhoud',
  roadworks:             'Wegwerkzaamheden',
  constructionWork:      'Bouwwerkzaamheden',
  surfaceResurfacing:    'Herbestrating',
  repairWork:            'Herstelwerkzaamheden',
  bridgeMaintenanceWork: 'Brugonderhoud',
  laneRestrictions:      'Rijstrookbeperking',
  carriagewayObstructions: 'Rijbaanobstructie',
};

function parseNdwXml(xml) {
  const features = [];
  const sitRe = /<sit:situation [^>]*id="([^"]+)">([\s\S]*?)<\/sit:situation>/g;
  let m;

  while ((m = sitRe.exec(xml)) !== null) {
    const [, sitId, body] = m;

    const severity  = (body.match(/<sit:overallSeverity>([^<]+)<\/sit:overallSeverity>/) || [])[1] || 'unknown';
    const start     = (body.match(/<com:overallStartTime>([^<]+)<\/com:overallStartTime>/) || [])[1] || null;
    const end       = (body.match(/<com:overallEndTime>([^<]+)<\/com:overallEndTime>/) || [])[1] || null;
    const causeType = (body.match(/<sit:causeType>([^<]+)<\/sit:causeType>/) || [])[1] || '';
    const srcName   = (body.match(/<com:sourceName>[\s\S]*?<com:value[^>]*>([^<]+)<\/com:value>/) || [])[1] || 'NDW';

    const props = {
      source:      'ndw',
      id:          sitId,
      description: NDW_CAUSE_NL[causeType] || causeType || 'Wegafsluiting',
      start,
      end,
      severity:    severity === 'highest' ? 'full_closure' : 'partial',
      owner:       srcName,
      consequence: '',
      infoUrl:     null,
    };

    // Prefer GML linestrings (posList) — DATEX II uses lat/lon order in posList
    const posLists = [];
    const posRe = /<loc:gmlLineString[^>]*>[\s\S]*?<loc:posList>([\s\S]*?)<\/loc:posList>/g;
    let pm;
    while ((pm = posRe.exec(body)) !== null) {
      const nums = pm[1].trim().split(/\s+/).filter(Boolean).map(Number);
      const coords = [];
      for (let i = 0; i + 1 < nums.length; i += 2) {
        coords.push([nums[i + 1], nums[i]]); // swap lat/lon → [lon, lat] for GeoJSON
      }
      if (coords.length >= 2) posLists.push(coords);
    }

    if (posLists.length) {
      features.push({
        type: 'Feature',
        geometry: posLists.length === 1
          ? { type: 'LineString',      coordinates: posLists[0] }
          : { type: 'MultiLineString', coordinates: posLists },
        properties: props,
      });
      continue;
    }

    // Fall back to explicit lat/lon point
    const lat = parseFloat((body.match(/<loc:latitude>([^<]+)<\/loc:latitude>/)   || [])[1]);
    const lon = parseFloat((body.match(/<loc:longitude>([^<]+)<\/loc:longitude>/) || [])[1]);
    if (!isNaN(lat) && !isNaN(lon)) {
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: props });
    }
  }
  return features;
}

function filterNdwByBbox(features, bbox) {
  return features.filter((f) => {
    if (!f.geometry) return false;
    const { type, coordinates } = f.geometry;
    const pts =
      type === 'Point'           ? [coordinates] :
      type === 'LineString'      ? coordinates :
      type === 'MultiLineString' ? coordinates.flat() : [];
    return pts.some(([lon, lat]) =>
      lon >= bbox.west && lon <= bbox.east &&
      lat >= bbox.south && lat <= bbox.north
    );
  });
}

// Rough bbox for the Netherlands (with a small buffer)
function bboxOverlapsNetherlands(bbox) {
  return bbox.east > 3.2 && bbox.west < 7.3 &&
         bbox.north > 50.6 && bbox.south < 53.7;
}

// ── OpenStreetMap (Overpass) ────────────────────────────────────────────────

function normaliseOsmElement(el) {
  const tags  = el.tags || {};
  const isWay = el.type === 'way';
  const id    = `${el.type}/${el.id}`;

  let description;
  if (tags.name) {
    description = tags.name;
  } else if (tags.landuse === 'construction') {
    description = 'Bouwplaats';
  } else if (tags.highway === 'construction' && tags.construction) {
    description = `Wegwerkzaamheden (${tags.construction})`;
  } else if (tags.highway === 'construction') {
    description = 'Wegwerkzaamheden';
  } else if (Object.keys(tags).some(k => k.startsWith('construction:'))) {
    const constructionType = Object.keys(tags).find(k => k.startsWith('construction:'));
    description = `In aanleg (${tags[constructionType]})`;
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
    const coords = el.geometry.map(p => [p.lon, p.lat]);
    const first = el.geometry[0], last = el.geometry[el.geometry.length - 1];
    const isClosed = el.geometry.length >= 4 &&
      first.lat === last.lat && first.lon === last.lon;
    geometry = isClosed
      ? { type: 'Polygon',    coordinates: [coords] }
      : { type: 'LineString', coordinates: coords };
  } else {
    geometry = { type: 'Point', coordinates: [el.lon, el.lat] };
  }

  return { type: 'Feature', geometry, properties };
}

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];

const OVERPASS_TIMEOUT_MS = 2000;

async function fetchOsmConstruction(bbox) {
  const query = `[out:json][timeout:25][bbox:${bbox.south},${bbox.west},${bbox.north},${bbox.east}];
(
  way[highway=construction];
  way[barrier=construction];
  way[landuse=construction];
  way[~"^construction:"~"."];
  node[barrier=construction];
);
out geom;`;

  const body = 'data=' + encodeURIComponent(query);

  for (const url of OVERPASS_ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal:  controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const features = (json.elements || [])
        .map(normaliseOsmElement)
        .filter(Boolean);
      return { type: 'FeatureCollection', features };
    } catch (err) {
      clearTimeout(timer);
      console.warn(`[RoadWorks] Overpass ${url} failed:`, err.message);
    }
  }

  throw new Error('All Overpass endpoints failed');
}

// ── Message handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'FETCH_ROADWORKS') return false;

  (async () => {
    const { bbox } = message;
    const cacheKey = getBboxCacheKey(bbox);

    // Return cached result if still fresh
    const cached = _bboxCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      sendResponse({ success: true, data: cached.data, fromCache: true });
      return;
    }

    try {
      const fetchJobs = [
        fetchGipodHindrance(bbox),
        fetchGipodDiversions(bbox),
        bboxOverlapsBrussels(bbox)     ? fetchBrusselsEvents(bbox) : Promise.resolve(null),
        bboxOverlapsNetherlands(bbox)  ? fetchNdwClosures()        : Promise.resolve(null),
        fetchOsmConstruction(bbox),
      ];
      const [hindranceResult, diversionResult, brusselsResult, ndwResult, osmResult] = await Promise.allSettled(fetchJobs);

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

      const ndwAll = ndwResult.status === 'fulfilled' && ndwResult.value
        ? ndwResult.value  // already an array of normalised features
        : [];
      const ndw = filterNdwByBbox(ndwAll, bbox);

      const osm = osmResult.status === 'fulfilled' && osmResult.value
        ? osmResult.value
        : { type: 'FeatureCollection', features: [] };

      const data = {
        hindrances: { type: 'FeatureCollection', features: hindrances },
        brussels:   { type: 'FeatureCollection', features: brussels },
        ndw:        { type: 'FeatureCollection', features: ndw },
        diversions: { type: 'FeatureCollection', features: diversions },
        osm,
      };

      // Store in memory; evict oldest entries beyond 20 tiles
      _bboxCache.set(cacheKey, { data, fetchedAt: Date.now() });
      if (_bboxCache.size > 20) {
        const oldest = [..._bboxCache.entries()]
          .sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)[0][0];
        _bboxCache.delete(oldest);
      }

      sendResponse({ success: true, data });
    } catch (err) {
      console.error('[RoadWorks BG]', err);
      sendResponse({ success: false, error: String(err) });
    }
  })();

  return true; // keep message channel open for async response
});
