import { DataSource } from './DataSource.js';

// Overpass endpoints — add mirrors here if needed. The service worker context
// has access even without a manifest host_permissions entry because fetch() from
// a service worker is not subject to the extension's content-security-policy.
const OVERPASS_ENDPOINTS = [
  // 'https://overpass-api.de/api/interpreter',
  // 'https://overpass.private.coffee/api/interpreter',
  // 'https://overpass.kumi.systems/api/interpreter',
  // 'https://overpass.openstreetmap.fr/api/interpreter',
];

const OVERPASS_TIMEOUT_MS = 2000;

export class OsmDataSource extends DataSource {
  get id() { return 'osm'; }
  get name() { return 'OpenStreetMap'; }
  // Global coverage — boundingBox returns null (inherited default)

  async fetchForBbox(bbox) {
    if (OVERPASS_ENDPOINTS.length === 0) {
      throw new Error('No Overpass endpoints configured');
    }

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
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Komoot RoadWorks Extension (https://www.komoot.com/plan)',
          },
          body,
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        return (json.elements || []).map(el => this._normalise(el)).filter(Boolean);
      } catch (err) {
        clearTimeout(timer);
        console.warn(`[RoadWorks] Overpass ${url} failed:`, err.message);
      }
    }
    throw new Error('All Overpass endpoints failed');
  }

  _normalise(el) {
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
      const k = Object.keys(tags).find(t => t.startsWith('construction:'));
      description = `In aanleg (${tags[k]})`;
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
    };

    let geometry;
    if (isWay) {
      if (!el.geometry || el.geometry.length < 2) return null;
      const coords  = el.geometry.map(p => [p.lon, p.lat]);
      const first   = el.geometry[0];
      const last    = el.geometry[el.geometry.length - 1];
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
}
