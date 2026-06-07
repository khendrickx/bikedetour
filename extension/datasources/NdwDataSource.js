import { DataSource } from './DataSource.js';

// Public open-data file (no auth required):
// https://opendata.ndw.nu/tijdelijke_verkeersmaatregelen_afsluitingen.xml.gz
// DATEX II v3 XML, ~162 KB gzip. Refreshed every few minutes by NDW.
// The larger planningsfeed_wegwerkzaamheden_en_evenementen.xml.gz (20 MB)
// covers all planned works but is too large to fetch in a browser extension.
// The Melvin OTM REST API (bbox-filtered JSON) requires keycloak login.

const NDW_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes — NDW updates every few min

// DATEX II causeType → Dutch label
const CAUSE_NL = {
  roadMaintenance:          'Wegonderhoud',
  roadworks:                'Wegwerkzaamheden',
  constructionWork:         'Bouwwerkzaamheden',
  surfaceResurfacing:       'Herbestrating',
  repairWork:               'Herstelwerkzaamheden',
  bridgeMaintenanceWork:    'Brugonderhoud',
  laneRestrictions:         'Rijstrookbeperking',
  carriagewayObstructions:  'Rijbaanobstructie',
};

export class NdwDataSource extends DataSource {
  constructor() {
    super();
    this._cache = null;
  }

  get id() { return 'ndw'; }
  get name() { return 'NDW (Netherlands)'; }

  get boundingBox() {
    // The Netherlands — with a small buffer
    return { west: 3.20, south: 50.60, east: 7.30, north: 53.70 };
  }

  async fetchForBbox(bbox) {
    const all = await this._fetchGlobal();
    return this._filterByBbox(all, bbox);
  }

  async _fetchGlobal() {
    if (this._cache && Date.now() - this._cache.fetchedAt < NDW_CACHE_TTL_MS) {
      return this._cache.features;
    }
    const url = 'https://opendata.ndw.nu/tijdelijke_verkeersmaatregelen_afsluitingen.xml.gz';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`NDW HTTP ${res.status}`);
    const ds  = new DecompressionStream('gzip');
    const xml = await new Response(res.body.pipeThrough(ds)).text();
    const features = this._parseXml(xml);
    this._cache = { features, fetchedAt: Date.now() };
    return features;
  }

  _parseXml(xml) {
    const features = [];
    const sitRe = /<sit:situation [^>]*id="([^"]+)">([\s\S]*?)<\/sit:situation>/g;
    let m;

    while ((m = sitRe.exec(xml)) !== null) {
      const [, sitId, body] = m;

      const severity  = (body.match(/<sit:overallSeverity>([^<]+)<\/sit:overallSeverity>/) || [])[1] || 'unknown';
      const start     = (body.match(/<com:overallStartTime>([^<]+)<\/com:overallStartTime>/) || [])[1] || null;
      const end       = (body.match(/<com:overallEndTime>([^<]+)<\/com:overallEndTime>/)     || [])[1] || null;
      const causeType = (body.match(/<sit:causeType>([^<]+)<\/sit:causeType>/)               || [])[1] || '';
      const srcName   = (body.match(/<com:sourceName>[\s\S]*?<com:value[^>]*>([^<]+)<\/com:value>/) || [])[1] || 'NDW';

      const props = {
        source:      'ndw',
        id:          sitId,
        description: CAUSE_NL[causeType] || causeType || 'Wegafsluiting',
        start,
        end,
        severity:    severity === 'highest' ? 'full_closure' : 'partial',
        owner:       srcName,
        consequence: '',
      };

      // Prefer GML linestrings — DATEX II uses lat/lon order in posList
      const posLists = [];
      const posRe = /<loc:gmlLineString[^>]*>[\s\S]*?<loc:posList>([\s\S]*?)<\/loc:posList>/g;
      let pm;
      while ((pm = posRe.exec(body)) !== null) {
        const nums   = pm[1].trim().split(/\s+/).filter(Boolean).map(Number);
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

  _filterByBbox(features, bbox) {
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
}
