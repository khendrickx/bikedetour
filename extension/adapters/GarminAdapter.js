/**
 * GarminAdapter — page-context script, injected before injected-garmin.js.
 *
 * Defines globals used by injected-garmin.js:
 *   - toContent(type, payload)  — send a postMessage to content-garmin.js
 *   - GarminAdapter             — the adapter class (Leaflet-only)
 *
 * Garmin Connect is a SPA: each route change destroys the old Leaflet map and
 * creates a new one via L.Map. onMapReady() is called once per instantiation,
 * so it resets stale _leafletLayers references every time it fires.
 */

// ── Message bridge (page → content) ──────────────────────────────────────────

const FROM_PAGE = 'rw-from-page';

function toContent(type, payload) {
  window.postMessage({ __rw: FROM_PAGE, type, ...payload }, '*');
}

// ── Constants ─────────────────────────────────────────────────────────────────

const EMPTY_FC    = { type: 'FeatureCollection', features: [] };
const SOURCE_KEYS = ['flanders', 'brussels', 'ndw', 'luxembourg', 'osm'];

// ── Popup helpers ─────────────────────────────────────────────────────────────

function buildPopupEl(p) {
  const fmt = (iso) => iso
    ? new Date(iso).toLocaleDateString('nl-BE', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : '—';

  const el = document.createElement('div');

  const title = document.createElement('div');
  title.style.cssText = 'font-weight:600;margin-bottom:4px;padding-right:18px';
  title.textContent = p.description || 'Wegwerken';
  el.appendChild(title);

  const badge = document.createElement('span');
  if (p.severity === 'full_closure') {
    badge.style.cssText = 'color:#E53935;font-weight:bold';
    badge.textContent = '⛔ Geen doorgang voor fietsers';
  } else {
    badge.style.cssText = 'color:#FB8C00;font-weight:bold';
    badge.textContent = '⚠️ Beperkte doorgang voor fietsers';
  }
  el.appendChild(badge);

  if (p.location) {
    const loc = document.createElement('div');
    loc.style.cssText = 'margin-top:4px;color:#555';
    loc.textContent = '📍 ' + p.location;
    el.appendChild(loc);
  }

  const meta = document.createElement('div');
  meta.style.cssText = 'margin-top:6px;color:#555';
  meta.appendChild(document.createTextNode(`📅 ${fmt(p.start)} → ${fmt(p.end)}`));
  meta.appendChild(document.createElement('br'));
  meta.appendChild(document.createTextNode(`🏢 ${p.owner || '—'}`));
  el.appendChild(meta);

  return el;
}

// ── GarminAdapter ─────────────────────────────────────────────────────────────

class GarminAdapter {
  constructor() {
    this._map           = null;
    this._overlayOn     = true;
    this._showLimited   = true;
    this._fetchTimer    = null;
    this._lastData      = null;
    this._leafletLayers = null;
  }

  onMapReady(map) {
    clearTimeout(this._fetchTimer);
    this._map           = map;
    this._leafletLayers = null; // drop stale refs from previous SPA map instance
    console.log('[BikeDetour] Garmin Connect map ready ✓');

    this._initLeafletLayers(map);
    this.setVisible(this._overlayOn);
    if (this._lastData) this.applyData(this._lastData);
    this._requestData();
    map.on('moveend', () => this._requestData());
  }

  applyData(dataBySource) {
    if (!this._map) return;
    this._lastData = dataBySource;
    this._applyDataLeaflet(dataBySource);
  }

  setVisible(visible) {
    this._overlayOn = visible;
    if (!this._map) return;
    this._setVisibleLeaflet(visible);
  }

  setLimitedVisible(showLimited) {
    this._showLimited = showLimited;
    if (this._lastData) this._applyDataLeaflet(this._lastData);
  }

  _initLeafletLayers(map) {
    this._leafletLayers = {};
    SOURCE_KEYS.forEach((key) => {
      this._leafletLayers[key] = window.L.layerGroup().addTo(map);
    });
  }

  _applyDataLeaflet(dataBySource) {
    if (!this._leafletLayers) this._initLeafletLayers(this._map);

    SOURCE_KEYS.forEach((key) => {
      const group = this._leafletLayers[key];
      group.clearLayers();

      const fc = dataBySource[key] || EMPTY_FC;
      const filtered = this._showLimited
        ? fc
        : { ...fc, features: fc.features.filter((f) => f.properties.severity === 'full_closure') };

      if (filtered.features.length === 0) return;

      window.L.geoJSON(filtered, {
        style(feature) {
          const full = feature.properties.severity === 'full_closure';
          return {
            color:       full ? '#B71C1C' : '#E65100',
            fillColor:   full ? '#E53935' : '#FB8C00',
            weight:      2,
            opacity:     0.85,
            fillOpacity: 0.35,
            dashArray:   '5, 4',
          };
        },
        pointToLayer(feature, latlng) {
          const full = feature.properties.severity === 'full_closure';
          return window.L.circleMarker(latlng, {
            radius:      9,
            color:       '#fff',
            weight:      2,
            fillColor:   full ? '#E53935' : '#FB8C00',
            fillOpacity: 0.9,
          });
        },
        onEachFeature(feature, layer) {
          layer.bindPopup(buildPopupEl(feature.properties), { maxWidth: 280, autoPan: false });
          layer.on('mouseover', function (e) { this.openPopup(e.latlng); });
        },
      }).addTo(group);
    });
  }

  _setVisibleLeaflet(visible) {
    if (!this._leafletLayers || !this._map) return;
    SOURCE_KEYS.forEach((key) => {
      if (visible) {
        this._leafletLayers[key].addTo(this._map);
      } else {
        this._leafletLayers[key].remove();
      }
    });
  }

  _requestData() {
    if (!this._map || !this._overlayOn) return;
    if (this._map.getZoom() < 8) return;

    clearTimeout(this._fetchTimer);
    this._fetchTimer = setTimeout(() => {
      const b = this._map.getBounds();
      toContent('RW_FETCH', {
        bbox: {
          west:  b.getWest(),
          south: b.getSouth(),
          east:  b.getEast(),
          north: b.getNorth(),
        },
      });
    }, 300);
  }
}
