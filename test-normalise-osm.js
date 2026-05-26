// test-normalise-osm.js — run with: node test-normalise-osm.js
const assert = require('assert');

// Paste the function under test here before running
// (will be replaced by require once extracted to a module)
function normaliseOsmElement(el) {
  const tags  = el.tags || {};
  const isWay = el.type === 'way';
  const id    = `${el.type}/${el.id}`;

  let description;
  if (tags.name) {
    description = tags.name;
  } else if (tags.highway === 'construction' && tags.construction) {
    description = `Wegwerkzaamheden (${tags.construction})`;
  } else if (tags.highway === 'construction') {
    description = 'Wegwerkzaamheden';
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
    infoUrl:     `https://www.openstreetmap.org/${id}`,
  };

  let geometry;
  if (isWay) {
    if (!el.geometry || el.geometry.length < 2) return null;
    geometry = {
      type:        'LineString',
      coordinates: el.geometry.map(p => [p.lon, p.lat]),
    };
  } else {
    geometry = { type: 'Point', coordinates: [el.lon, el.lat] };
  }

  return { type: 'Feature', geometry, properties };
}

// ── Test 1: highway=construction way, no access tag → full_closure LineString ─
{
  const way = {
    type: 'way', id: 123456,
    geometry: [{ lat: 51.0, lon: 4.0 }, { lat: 51.1, lon: 4.1 }],
    tags: { highway: 'construction', construction: 'cycleway' },
  };
  const f = normaliseOsmElement(way);
  assert.equal(f.properties.source, 'osm');
  assert.equal(f.properties.id, 'way/123456');
  assert.equal(f.properties.severity, 'full_closure');
  assert.equal(f.properties.infoUrl, 'https://www.openstreetmap.org/way/123456');
  assert.equal(f.properties.owner, 'OpenStreetMap');
  assert.equal(f.geometry.type, 'LineString');
  assert.deepEqual(f.geometry.coordinates, [[4.0, 51.0], [4.1, 51.1]]);
  console.log('✓ Test 1: highway=construction way');
}

// ── Test 2: barrier=construction node with access=permissive → partial Point ──
{
  const node = {
    type: 'node', id: 789,
    lat: 51.05, lon: 4.05,
    tags: { barrier: 'construction', access: 'permissive' },
  };
  const f = normaliseOsmElement(node);
  assert.equal(f.geometry.type, 'Point');
  assert.deepEqual(f.geometry.coordinates, [4.05, 51.05]);
  assert.equal(f.properties.severity, 'partial');
  assert.equal(f.properties.id, 'node/789');
  assert.equal(f.properties.infoUrl, 'https://www.openstreetmap.org/node/789');
  console.log('✓ Test 2: barrier=construction node, access=permissive');
}

// ── Test 3: access=yes → partial ─────────────────────────────────────────────
{
  const node = {
    type: 'node', id: 111,
    lat: 51.0, lon: 4.0,
    tags: { barrier: 'construction', access: 'yes' },
  };
  const f = normaliseOsmElement(node);
  assert.equal(f.properties.severity, 'partial');
  console.log('✓ Test 3: access=yes → partial');
}

// ── Test 4: way with no geometry → null (skip) ────────────────────────────────
{
  const bad = { type: 'way', id: 999, tags: { highway: 'construction' } };
  assert.equal(normaliseOsmElement(bad), null);
  console.log('✓ Test 4: way with no geometry → null');
}

// ── Test 5: way with 1 point geometry → null (not a valid LineString) ─────────
{
  const bad = {
    type: 'way', id: 1000,
    geometry: [{ lat: 51.0, lon: 4.0 }],
    tags: { highway: 'construction' },
  };
  assert.equal(normaliseOsmElement(bad), null);
  console.log('✓ Test 5: way with 1 point → null');
}

// ── Test 6: name tag used as description ──────────────────────────────────────
{
  const way = {
    type: 'way', id: 222,
    geometry: [{ lat: 51.0, lon: 4.0 }, { lat: 51.1, lon: 4.1 }],
    tags: { highway: 'construction', name: 'Fietsbrug werken' },
  };
  const f = normaliseOsmElement(way);
  assert.equal(f.properties.description, 'Fietsbrug werken');
  console.log('✓ Test 6: name tag used as description');
}

// ── Test 7: start_date / end_date preserved ───────────────────────────────────
{
  const way = {
    type: 'way', id: 333,
    geometry: [{ lat: 51.0, lon: 4.0 }, { lat: 51.1, lon: 4.1 }],
    tags: { highway: 'construction', start_date: '2026-01-01', end_date: '2026-12-31' },
  };
  const f = normaliseOsmElement(way);
  assert.equal(f.properties.start, '2026-01-01');
  assert.equal(f.properties.end,   '2026-12-31');
  console.log('✓ Test 7: start_date / end_date preserved');
}

console.log('\nAll normalisation tests passed.');
