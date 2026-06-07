import { DataSource } from './DataSource.js';

// Public KML feed from Administration des Ponts et Chaussées (PCH), no auth, CORS: *.
// https://www.cita.lu/kml/chantiers_actuel.kml (~1.4 MB, updated continuously)
// Covers construction works on the entire national road network.

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

export class LuxembourgDataSource extends DataSource {
  constructor() {
    super();
    this._cache = null;
  }

  get id() { return 'luxembourg'; }
  get name() { return 'PCH (Luxembourg)'; }

  get boundingBox() {
    return { west: 5.73, south: 49.44, east: 6.53, north: 50.18 };
  }

  async fetchForBbox(bbox) {
    const all = await this._fetchGlobal();
    return this._filterByBbox(all, bbox);
  }

  async _fetchGlobal() {
    if (this._cache && Date.now() - this._cache.fetchedAt < CACHE_TTL_MS) {
      return this._cache.features;
    }
    const res = await fetch('https://www.cita.lu/kml/chantiers_actuel.kml');
    if (!res.ok) throw new Error(`Luxembourg KML HTTP ${res.status}`);
    const xml = await res.text();
    const features = this._parseKml(xml);
    this._cache = { features, fetchedAt: Date.now() };
    return features;
  }

  _parseKml(xml) {
    const features = [];
    const re = /<Placemark[^>]*id\s*=\s*['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/Placemark>/g;
    let m;

    while ((m = re.exec(xml)) !== null) {
      const [, pmId, body] = m;

      // Route: first divTableCell2 div, e.g. "CR106<br />entre Hobscheid<br />et Hobscheid"
      const routeMatch = body.match(/class='divTableCell2'>([\s\S]*?)<\/div>/);
      const route = routeMatch
        ? routeMatch[1].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').trim()
        : '';

      // Dates: "du dd/mm/yyyy ... au dd/mm/yyyy"
      const dateMatch = body.match(/du (\d{2})\/(\d{2})\/(\d{4})[\s\S]*?au (\d{2})\/(\d{2})\/(\d{4})/);
      const start = dateMatch ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}` : null;
      const end   = dateMatch ? `${dateMatch[6]}-${dateMatch[5]}-${dateMatch[4]}` : null;

      // Work type from the "Travaux" row
      const travauxMatch = body.match(/Travaux<\/div><\/div><div class='divTableCell2'>([^<]+)<\/div>/);
      const travaux = travauxMatch ? travauxMatch[1].trim() : '';

      // Severity inferred from circulation sign alt text:
      // traffic-light managed (feux / alterné / sens unique) → partial, otherwise → full_closure
      const altMatch = body.match(/alt='([^']+)'/);
      const altText  = altMatch ? altMatch[1].toLowerCase() : '';
      const severity = (altText.includes('feux') || altText.includes('alterné') || altText.includes('sens unique'))
        ? 'partial' : 'full_closure';

      const description = [route, travaux].filter(Boolean).join(' — ') || 'Chantier';

      // Coordinates: KML "lon,lat,alt lon,lat,alt ..."
      const coordsMatch = body.match(/<coordinates>([\s\S]*?)<\/coordinates>/);
      if (!coordsMatch) continue;
      const coords = coordsMatch[1].trim().split(/\s+/).map(pt => {
        const [lon, lat] = pt.split(',').map(Number);
        return [lon, lat];
      }).filter(([lon, lat]) => !isNaN(lon) && !isNaN(lat));
      if (coords.length < 2) continue;

      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        properties: {
          source:      'luxembourg',
          id:          pmId,
          description,
          start,
          end,
          severity,
          owner:       'Administration des Ponts et Chaussées',
          consequence: '',
        },
      });
    }

    return features;
  }

  _filterByBbox(features, bbox) {
    return features.filter((f) => {
      if (!f.geometry) return false;
      const { type, coordinates } = f.geometry;
      const pts =
        type === 'Point'      ? [coordinates] :
        type === 'LineString' ? coordinates   : [];
      return pts.some(([lon, lat]) =>
        lon >= bbox.west && lon <= bbox.east &&
        lat >= bbox.south && lat <= bbox.north
      );
    });
  }
}
