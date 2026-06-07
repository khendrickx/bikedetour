/**
 * Interface specification for route planner adapters.
 *
 * An adapter connects the data pipeline to a specific route planning service.
 * It is responsible for:
 *  - detecting the native map instance on the page
 *  - adding and styling overlay layers
 *  - rendering incoming GeoJSON data
 *  - reacting to show/hide and severity-filter commands
 *
 * IMPLEMENTATION NOTE
 * Adapters run inside `injected.js` (page context), which is loaded as a
 * plain <script> tag and cannot use ES module imports. This file therefore
 * serves as a reference specification; your adapter class lives inside its
 * own injected script file and mirrors this interface by convention rather
 * than formal inheritance.
 *
 * HOW TO ADD A NEW ADAPTER
 *  1. Create `extension/adapters/<Service>Adapter.js` — copy the KomootAdapter
 *     from `injected.js` as a starting point.
 *  2. Implement the four methods below (onMapReady, applyData, setVisible,
 *     setLimitedVisible) using the target service's map SDK.
 *  3. Create `extension/injected-<service>.js` — wire up the adapter and the
 *     map detection / patching logic for that service.
 *  4. Create `extension-<service>/manifest.json` (copy from extension-firefox)
 *     and point content_scripts at your new injected script.
 *  5. Add the service's domain to host_permissions in both manifests.
 *
 * See README.md § "Adding a new route planning service" for the full walkthrough.
 */
export class RouteplannerAdapter {
  /**
   * Called once when a compatible map instance is discovered on the page.
   * Register move/style event listeners and add overlay sources + layers here.
   *
   * @param {object} map  Native map instance (MapLibre GL, Mapbox GL, Leaflet, …)
   */
  onMapReady(map) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} must implement onMapReady`);
  }

  /**
   * Push fresh data onto the map.
   * Called whenever the DataAggregator returns a new result for the viewport.
   *
   * @param {Record<string, import('geojson').FeatureCollection>} dataBySource
   *   One FeatureCollection per registered DataSource, keyed by DataSource.id.
   *   Example keys: 'flanders', 'brussels', 'ndw', 'luxembourg', 'osm'.
   *   Sources outside the current viewport deliver an empty FeatureCollection.
   */
  applyData(dataBySource) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} must implement applyData`);
  }

  /**
   * Show or hide the entire overlay without losing layer state.
   * @param {boolean} visible
   */
  setVisible(visible) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} must implement setVisible`);
  }

  /**
   * When `showLimited` is false, restrict the overlay to full-closure features only.
   * When true, also show partial / limited-access closures.
   * @param {boolean} showLimited
   */
  setLimitedVisible(showLimited) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} must implement setLimitedVisible`);
  }
}
