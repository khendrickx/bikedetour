/**
 * @typedef {{ west: number, south: number, east: number, north: number }} BBox
 */

/**
 * Abstract base class for construction / road-work data sources.
 *
 * Every source must declare a bounding box that describes the geographic
 * region where it has meaningful data. The DataAggregator will skip sources
 * whose bounding box does not overlap the current viewport, avoiding
 * unnecessary network requests.
 *
 * Implementing a new source:
 *  1. Extend this class in `datasources/<YourSource>DataSource.js`.
 *  2. Override `id`, `name`, `boundingBox`, and `fetchForBbox`.
 *  3. Register an instance in `background.js` → DataAggregator constructor.
 *  4. Add the host to `manifest.json` → `host_permissions` (and the Firefox copy).
 *  5. Add a layer in `injected.js` → `KomootAdapter._addLayers`.
 *
 * See README.md § "Adding a new data source" for the full walkthrough.
 */
export class DataSource {
  /** @returns {string} Stable identifier used as the data key throughout the app */
  get id() { throw new Error(`${this.constructor.name} must implement id`); }

  /** @returns {string} Human-readable label shown in the popup UI */
  get name() { throw new Error(`${this.constructor.name} must implement name`); }

  /**
   * The geographic area where this source provides data.
   * Return `null` for global coverage (the source is always queried).
   * @returns {BBox|null}
   */
  get boundingBox() { return null; }

  /**
   * Fetch and normalise features for the given viewport bounding box.
   * Must return an array of GeoJSON Features with the standard property schema:
   *
   *   source      – string matching this.id
   *   id          – unique feature identifier string
   *   description – human-readable label
   *   start       – ISO date string or null
   *   end         – ISO date string or null
   *   severity    – 'full_closure' | 'partial'
   *   owner       – organisation / attribution string
   *   consequence – optional detail string
   *
   * @param {BBox} bbox
   * @returns {Promise<import('geojson').Feature[]>}
   */
  async fetchForBbox(bbox) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} must implement fetchForBbox`);
  }

  /**
   * Returns true when the given bbox has any overlap with this source's coverage area.
   * Used by DataAggregator to skip sources that are out of range.
   * @param {BBox} bbox
   * @returns {boolean}
   */
  overlaps(bbox) {
    const bb = this.boundingBox;
    if (!bb) return true;
    return bbox.east  > bb.west  &&
           bbox.west  < bb.east  &&
           bbox.north > bb.south &&
           bbox.south < bb.north;
  }
}
