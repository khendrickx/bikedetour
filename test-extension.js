/**
 * Playwright test script for the Komoot Road Works extension.
 * Run with: node test-extension.js
 */
const { chromium } = require('@playwright/test');
const path = require('path');

const EXTENSION_PATH = '/Users/kilian/Documents/projects/cycling-construction-planning/extension';
const PROFILE_DIR = '/tmp/playwright-komoot-rw';

(async () => {
  console.log('Loading extension from:', EXTENSION_PATH);

  // Clean up old profile
  const { execSync } = require('child_process');
  try { execSync(`rm -rf "${PROFILE_DIR}"`); } catch(e) {}

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    // Use Playwright's own Chromium (not system Chrome) — properly supports --load-extension
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
      '--disable-default-apps',
    ],
    timeout: 30000,
  });

  console.log('Browser launched');

  // Check which pages/service workers exist
  const pages = context.pages();
  console.log('Initial pages:', pages.length);

  // Check for our service worker
  const workers = context.serviceWorkers();
  console.log('Service workers:', workers.map(w => w.url()));

  // Wait a bit for extension to register
  await new Promise(r => setTimeout(r, 2000));

  const workers2 = context.serviceWorkers();
  console.log('Service workers after 2s:', workers2.map(w => w.url()));

  // Get the existing page or open a new one
  let page = pages[0] || await context.newPage();

  // Handle any initial dialogs/popups
  page.on('dialog', d => d.dismiss());

  console.log('Navigating to Komoot...');
  
  // Capture page console messages
  const consoleMsgs = [];
  page.on('console', msg => {
    const text = msg.text();
    consoleMsgs.push(`[${msg.type()}] ${text}`);
    if (text.includes('RoadWorks') || text.includes('GIPOD') || text.includes('rw-')) {
      console.log(`  [PAGE] ${text}`);
    }
  });
  page.on('pageerror', err => console.log('  [PAGE ERROR]', err.message));

  await page.goto('https://www.komoot.com/plan', { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Accept cookies if present
  try {
    const cookieBtn = await page.waitForSelector('button:has-text("Accept all cookies")', { timeout: 5000 });
    await cookieBtn.click();
    console.log('Accepted cookies');
  } catch(e) {
    console.log('No cookie dialog');
  }

  // Dismiss route customization dialog
  try {
    const gotItBtn = await page.waitForSelector('text=Got it', { timeout: 3000 });
    await gotItBtn.click();
    console.log('Dismissed customization dialog');
  } catch(e) {}

  // Wait for map
  try {
    await page.waitForSelector('.maplibregl-canvas', { timeout: 10000 });
    console.log('✓ Map canvas found');
  } catch(e) {
    console.log('✗ Map canvas not found');
  }

  // Check if our extension script was injected (note: content.js removes the tag after load)
  const extScript = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script[src]'))
      .map(s => s.src)
      .filter(s => s.includes('chrome-extension') || s.includes('moz-extension'));
    return scripts;
  });
  console.log('Extension scripts still in DOM:', extScript);

  // Check actual page URL
  console.log('Current URL:', page.url());

  // Check window globals
  const globals = await page.evaluate(() => ({
    maplibregl: typeof window.maplibregl,
    mapboxgl: typeof window.mapboxgl,
    rwMaps: typeof window.__rwMaps,
    testLoaded: window.__testExtLoaded,
    canvasParentClass: document.querySelector('.maplibregl-canvas')?.parentElement?.className,
  }));
  console.log('Window globals:', globals);

  // Check React fiber for map instance
  const mapFound = await page.evaluate(() => {
    function isMapInstance(obj) {
      return obj && typeof obj === 'object' &&
        typeof obj.on === 'function' &&
        typeof obj.getZoom === 'function' &&
        typeof obj.addLayer === 'function';
    }

    function searchFiber(fiber, depth = 0) {
      if (!fiber || depth > 50) return null;
      const props = fiber.memoizedProps;
      if (props) {
        for (const v of Object.values(props)) {
          if (isMapInstance(v)) return 'found-in-props';
          if (v && typeof v === 'object' && v.current && isMapInstance(v.current)) return 'found-in-ref';
        }
      }
      let state = fiber.memoizedState;
      let stateDepth = 0;
      while (state && stateDepth++ < 20) {
        if (isMapInstance(state.memoizedState)) return 'found-in-hook-state';
        if (state.memoizedState && typeof state.memoizedState === 'object') {
          for (const v of Object.values(state.memoizedState)) {
            if (isMapInstance(v)) return 'found-in-hook-state-obj';
            if (v && typeof v === 'object' && v.current && isMapInstance(v.current)) return 'found-in-hook-state-ref';
          }
        }
        state = state.next;
      }
      const child = searchFiber(fiber.child, depth + 1);
      if (child) return child;
      const sibling = searchFiber(fiber.sibling, depth + 1);
      if (sibling) return sibling;
      return null;
    }

    const canvas = document.querySelector('.maplibregl-canvas');
    if (!canvas) return 'no-canvas';
    let el = canvas;
    while (el) {
      const fiberKey = Object.keys(el).find(k =>
        k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
      );
      if (fiberKey) {
        const result = searchFiber(el[fiberKey]);
        if (result) return result;
      }
      el = el.parentElement;
      if (!el || el === document.body) break;
    }
    return 'not-found-in-react';
  });
  console.log('Map in React fiber:', mapFound);

  // Wait 3 seconds for initial data
  console.log('Waiting for extension to detect map...');
  await new Promise(r => setTimeout(r, 3000));

  // Dismiss "Customize your route" dialog if present
  try {
    const gotItBtn = await page.waitForSelector('text=Got it', { timeout: 3000 });
    await gotItBtn.click();
    console.log('Dismissed customization dialog');
  } catch(e) {}

  // Navigate to Flanders at zoom 11 to see many hindrances at once
  console.log('Navigating to Flanders zoom 11...');
  await page.goto('https://www.komoot.com/plan/@51.0000000,4.0000000,11.000z', { waitUntil: 'domcontentloaded', timeout: 15000 });

  // Dismiss dialog again on new page
  try {
    const gotItBtn2 = await page.waitForSelector('text=Got it', { timeout: 3000 });
    await gotItBtn2.click();
  } catch(e) {}

  // Wait for map and GIPOD data
  await page.waitForSelector('.maplibregl-canvas', { timeout: 10000 });
  await new Promise(r => setTimeout(r, 6000));

  // Check extension layer data via JS evaluation
  const layerData = await page.evaluate(() => {
    function isMapInstance(obj) {
      return obj != null && typeof obj === 'object' &&
        typeof obj.on === 'function' && typeof obj.getZoom === 'function' &&
        typeof obj.addLayer === 'function';
    }
    function findMap(fiber, d) {
      d = d || 0;
      if (!fiber || d > 60) return null;
      const p = fiber.memoizedProps;
      if (p) for (const v of Object.values(p)) {
        if (isMapInstance(v)) return v;
        if (v && v.current && isMapInstance(v.current)) return v.current;
      }
      return findMap(fiber.child, d+1) || findMap(fiber.sibling, d+1) || findMap(fiber.return, d+1);
    }
    function getMap() {
      const canvas = document.querySelector('.maplibregl-canvas');
      if (!canvas) return null;
      let el = canvas;
      while (el && el !== document.body) {
        const fk = Object.keys(el).find(k => k.startsWith('__reactFiber'));
        if (fk) { const m = findMap(el[fk]); if (m) return m; }
        el = el.parentElement;
      }
      return null;
    }
    const map = getMap();
    if (!map) return { error: 'no map' };
    const hSrc = map.getSource('rw-hindrances');
    const dSrc = map.getSource('rw-diversions');
    const bSrc = map.getSource('rw-brussels');
    const nSrc = map.getSource('rw-ndw');
    const oSrc = map.getSource('rw-osm');
    const srcFeatureCount = (src) => src && src._data && src._data.features ? src._data.features.length : '?';
    return {
      zoom: map.getZoom().toFixed(1),
      hindranceSourceExists: !!hSrc,
      diversionSourceExists: !!dSrc,
      hindranceFillLayer: !!map.getLayer('rw-fill'),
      diversionLayer: !!map.getLayer('rw-diversion'),
      brusselsLayer: !!map.getLayer('rw-brussels-circle'),
      ndwLayer: !!map.getLayer('rw-ndw-line'),
      osmLineLayer: !!map.getLayer('rw-osm-line'),
      osmCircleLayer: !!map.getLayer('rw-osm-circle'),
      osmSourceExists: !!oSrc,
      hindranceFeatures: srcFeatureCount(hSrc),
      diversionFeatures: srcFeatureCount(dSrc),
      brusselsFeatures:  srcFeatureCount(bSrc),
      ndwFeatures:       srcFeatureCount(nSrc),
      osmFeatures:       srcFeatureCount(oSrc),
    };
  });
  console.log('Flanders layer data:', layerData);
  if (!layerData.osmLineLayer)   console.log('  ✗ OSM line layer missing');
  else                           console.log('  ✓ OSM line layer present');
  if (!layerData.osmCircleLayer) console.log('  ✗ OSM circle layer missing');
  else                           console.log('  ✓ OSM circle layer present');
  if (!layerData.osmSourceExists) console.log('  ✗ OSM source missing');
  else                            console.log(`  ✓ OSM source present (${layerData.osmFeatures} features)`);

  // ── Brussels test ────────────────────────────────────────────────────────
  console.log('\nNavigating to Brussels zoom 13...');
  await page.goto('https://www.komoot.com/plan/@50.8508434,4.3388611,13.000z', { waitUntil: 'domcontentloaded', timeout: 15000 });
  try { await (await page.waitForSelector('text=Got it', { timeout: 2000 })).click(); } catch(e) {}
  await page.waitForSelector('.maplibregl-canvas', { timeout: 10000 });
  await new Promise(r => setTimeout(r, 8000));  // wait for fetch + render

  const brusselsData = await page.evaluate(() => {
    function isMapInstance(o) { return o && typeof o.getSource === 'function' && typeof o.getZoom === 'function'; }
    function findMap(f, d) {
      if (!f || (d||0) > 60) return null;
      const p = f.memoizedProps;
      if (p) for (const v of Object.values(p)) {
        if (isMapInstance(v)) return v;
        if (v && v.current && isMapInstance(v.current)) return v.current;
      }
      return findMap(f.child, (d||0)+1) || findMap(f.sibling, (d||0)+1) || findMap(f.return, (d||0)+1);
    }
    const canvas = document.querySelector('.maplibregl-canvas');
    if (!canvas) return { error: 'no canvas' };
    let el = canvas, map = null;
    while (el && el !== document.body) {
      const fk = Object.keys(el).find(k => k.startsWith('__reactFiber'));
      if (fk && (map = findMap(el[fk]))) break;
      el = el.parentElement;
    }
    if (!map) return { error: 'no map' };
    const bSrc = map.getSource('rw-brussels');
    const hSrc = map.getSource('rw-hindrances');
    const srcCount = s => s && s._data && s._data.features ? s._data.features.length : '?';
    return { zoom: map.getZoom().toFixed(1), brussels: srcCount(bSrc), hindrances: srcCount(hSrc) };
  });
  console.log('Brussels layer data:', brusselsData);
  if (brusselsData.brussels === 0 || brusselsData.brussels === '?') {
    console.log('  ⚠ No Brussels features — check Brussels WFS fix');
  } else {
    console.log(`  ✓ Brussels: ${brusselsData.brussels} features`);
  }

  // ── Netherlands test ─────────────────────────────────────────────────────
  console.log('\nNavigating to Netherlands zoom 12...');
  await page.goto('https://www.komoot.com/plan/@52.0206945,4.2926445,12.000z', { waitUntil: 'domcontentloaded', timeout: 15000 });
  try { await (await page.waitForSelector('text=Got it', { timeout: 2000 })).click(); } catch(e) {}
  await page.waitForSelector('.maplibregl-canvas', { timeout: 10000 });
  await new Promise(r => setTimeout(r, 10000));  // NDW download ~2s

  const nlData = await page.evaluate(() => {
    function isMapInstance(o) { return o && typeof o.getSource === 'function' && typeof o.getZoom === 'function'; }
    function findMap(f, d) {
      if (!f || (d||0) > 60) return null;
      const p = f.memoizedProps;
      if (p) for (const v of Object.values(p)) {
        if (isMapInstance(v)) return v;
        if (v && v.current && isMapInstance(v.current)) return v.current;
      }
      return findMap(f.child, (d||0)+1) || findMap(f.sibling, (d||0)+1) || findMap(f.return, (d||0)+1);
    }
    const canvas = document.querySelector('.maplibregl-canvas');
    if (!canvas) return { error: 'no canvas' };
    let el = canvas, map = null;
    while (el && el !== document.body) {
      const fk = Object.keys(el).find(k => k.startsWith('__reactFiber'));
      if (fk && (map = findMap(el[fk]))) break;
      el = el.parentElement;
    }
    if (!map) return { error: 'no map' };
    const nSrc = map.getSource('rw-ndw');
    const srcCount = s => s && s._data && s._data.features ? s._data.features.length : '?';
    return { zoom: map.getZoom().toFixed(1), ndw: srcCount(nSrc) };
  });
  console.log('Netherlands layer data:', nlData);
  if (nlData.ndw === 0 || nlData.ndw === '?') {
    console.log('  ⚠ No NDW features — check NDW fetch/filter');
  } else {
    console.log(`  ✓ NDW: ${nlData.ndw} features`);
  }

  // Take screenshot
  await page.screenshot({ path: '/tmp/komoot-test.png' });
  console.log('\nScreenshot saved to /tmp/komoot-test.png');

  // Wait 5 seconds for user to see the result
  console.log('Waiting 5 seconds before closing...');
  await new Promise(r => setTimeout(r, 5000));

  await context.close();
  console.log('Done');
})().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
