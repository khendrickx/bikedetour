import { DataSource } from './DataSource.js';

// Public GeoServer WFS (no auth required).
// Wallonia (SPW/SOFICO-TRADEMEX at https://ws.sofico-trademex.be/) requires a
// signed contract + credentials and is therefore not yet included.

export class BrusselsDataSource extends DataSource {
  get id() { return 'brussels'; }
  get name() { return 'Brussels Mobility'; }

  get boundingBox() {
    // Brussels Capital Region — with a small buffer
    return { west: 4.20, south: 50.74, east: 4.50, north: 50.95 };
  }

  async fetchForBbox(bbox) {
    const base = 'https://data.mobility.brussels/geoserver/bm_traffic/wfs';
    // The native geometry column 'geom' is stored in Belgian Lambert (EPSG:31370).
    // GeoServer's CQL BBOX(geom,...) needs Lambert coords, and mixing WFS BBOX
    // with CQL_FILTER is unsupported in GET requests.
    // Solution: fetch all active events and post-filter by bbox in JS.
    const params = new URLSearchParams({
      service:      'wfs',
      version:      '1.1.0',
      request:      'GetFeature',
      typeName:     'bm_traffic:events',
      outputFormat: 'json',
      srsName:      'EPSG:4326',   // GeoServer reprojects to [lon, lat]
      CQL_FILTER:   "is_active=true AND importance<>'0'",
      maxFeatures:  '500',
    });
    const res = await fetch(`${base}?${params}`);
    if (!res.ok) throw new Error(`Brussels WFS HTTP ${res.status}`);
    const fc = await res.json();
    return (fc.features || [])
      .filter(f => {
        const c = f.geometry && f.geometry.coordinates;
        if (!c) return false;
        const [lon, lat] = c;
        return lon >= bbox.west && lon <= bbox.east &&
               lat >= bbox.south && lat <= bbox.north;
      })
      .map(f => this._normalise(f));
  }

  _normalise(feature) {
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
      },
    };
  }
}
