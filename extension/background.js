/**
 * background.js — MV3 Service Worker (ES module, declared in manifest)
 *
 * Thin orchestrator: wires together the registered data sources and the
 * DataAggregator, then handles FETCH_ROADWORKS messages from content.js.
 *
 * To add a new data source:
 *  1. Create datasources/<Name>DataSource.js (extend DataSource).
 *  2. Import and register it below.
 *  3. Add a host_permission entry in manifest.json.
 *  4. Add a corresponding layer in injected.js → KomootAdapter._addLayers().
 */

import { FlandersDataSource }    from './datasources/FlandersDataSource.js';
import { BrusselsDataSource }   from './datasources/BrusselsDataSource.js';
import { NdwDataSource }        from './datasources/NdwDataSource.js';
import { LuxembourgDataSource } from './datasources/LuxembourgDataSource.js';
import { OsmDataSource }        from './datasources/OsmDataSource.js';
import { DataAggregator }       from './logic/DataAggregator.js';

const aggregator = new DataAggregator([
  new FlandersDataSource(),
  new BrusselsDataSource(),
  new NdwDataSource(),
  new LuxembourgDataSource(),
  new OsmDataSource(),
]);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'FETCH_ROADWORKS') return false;

  (async () => {
    try {
      const { data, fromCache } = await aggregator.fetchForBbox(message.bbox);
      sendResponse({ success: true, data, fromCache });
    } catch (err) {
      console.error('[BikeDetour]', err);
      sendResponse({ success: false, error: String(err) });
    }
  })();

  return true; // keep message channel open for async response
});
