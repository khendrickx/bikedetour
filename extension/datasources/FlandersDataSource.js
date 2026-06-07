import { DataSource } from './DataSource.js';

// Cyclist-relevant Level-0 consequence UUID from the GIPOD taxonomy
const CYCLIST_L0_UUID = '82e84ba4-b3e9-4171-9834-ec18dca16485';

export class FlandersDataSource extends DataSource {
  get id() { return 'flanders'; }
  get name() { return 'Flanders (GIPOD)'; }

  get boundingBox() {
    // Flanders, Belgium — with a small buffer
    return { west: 2.50, south: 50.50, east: 5.95, north: 51.60 };
  }

  async fetchForBbox(bbox) {
    const base = 'https://geo.api.vlaanderen.be/GIPOD/ogc/features/v1/collections/HINDERGEVOLG/items';
    const params = new URLSearchParams({
      f: 'application/geo+json',
      bbox: `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`,
      'bbox-crs': 'http://www.opengis.net/def/crs/OGC/1.3/CRS84',
      limit: '500',
    });
    const res = await fetch(`${base}?${params}`);
    if (!res.ok) throw new Error(`GIPOD HTTP ${res.status}`);
    const fc = await res.json();
    return (fc.features || [])
      .filter(f => this._isCyclistFeature(f.properties || {}))
      .map(f => this._normalise(f));
  }

  _isCyclistFeature(props) {
    const l0   = (props.ConsequenceTreeLevel0   || '').toLowerCase();
    const l0id =  props.ConsequenceTreeLevel0Id || '';
    return l0.includes('fiets') || l0id.includes(CYCLIST_L0_UUID);
  }

  _normaliseSeverity(props) {
    const l1 = (props.ConsequenceTreeLevel1 || props.Consequence || '').toLowerCase();
    if (l1.includes('geen doorgang'))     return 'full_closure';
    if (l1.includes('beperkte doorgang')) return 'partial';
    return 'partial';
  }

  _normalise(feature) {
    const p = feature.properties || {};
    return {
      ...feature,
      properties: {
        source:      'flanders',
        id:          p.ZoneId || p.fid || '',
        description: p.HindranceDescription || 'Wegwerken',
        start:       p.HindranceStart || null,
        end:         p.HindranceEnd   || null,
        severity:    this._normaliseSeverity(p),
        owner:       p.HindranceOwner || '',
        consequence: p.ConsequenceTreeLevel1 || p.Consequence || '',
      },
    };
  }
}
