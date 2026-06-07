const CACHE_TTL_MS    = 10 * 60 * 1000; // 10 minutes per tile
const MAX_CACHE_TILES = 20;

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

/**
 * Orchestrates fetching from multiple DataSource instances and caches
 * the merged results per snapped bounding-box tile.
 *
 * Sources whose bounding box does not overlap the requested viewport are
 * skipped automatically. A failed source never blocks the others — the
 * aggregator uses Promise.allSettled() and logs warnings for failures.
 */
export class DataAggregator {
  /**
   * @param {import('../datasources/DataSource.js').DataSource[]} sources
   */
  constructor(sources) {
    this._sources = sources;
    this._cache   = new Map(); // cacheKey → { data, fetchedAt }
  }

  /**
   * Returns merged data keyed by DataSource.id, e.g.:
   *   { flanders: FeatureCollection, brussels: FeatureCollection, ... }
   *
   * @param {{ west: number, south: number, east: number, north: number }} bbox
   * @returns {Promise<{ data: Record<string, import('geojson').FeatureCollection>, fromCache: boolean }>}
   */
  async fetchForBbox(bbox) {
    const key    = getBboxCacheKey(bbox);
    const cached = this._cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return { data: cached.data, fromCache: true };
    }

    const inRange = this._sources.filter(s => s.overlaps(bbox));
    const settled = await Promise.allSettled(
      inRange.map(s => s.fetchForBbox(bbox).then(features => ({ id: s.id, features })))
    );

    const data = {};
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        const { id, features } = result.value;
        data[id] = { type: 'FeatureCollection', features: features || [] };
      } else {
        console.warn('[RoadWorks] Source fetch failed:', result.reason);
      }
    }

    // Ensure all registered sources have an entry (empty collection if out of
    // range or failed) so consumers can always index by source id.
    for (const s of this._sources) {
      if (!data[s.id]) {
        data[s.id] = { type: 'FeatureCollection', features: [] };
      }
    }

    this._cache.set(key, { data, fetchedAt: Date.now() });
    if (this._cache.size > MAX_CACHE_TILES) {
      const oldest = [...this._cache.entries()]
        .sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)[0][0];
      this._cache.delete(oldest);
    }

    return { data, fromCache: false };
  }
}
