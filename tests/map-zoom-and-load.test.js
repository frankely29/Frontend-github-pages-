#!/usr/bin/env node
/**
 * map-zoom-and-load.test.js — why the map stopped zooming out, and why it
 * takes so long to arrive.
 *
 * THE ZOOM
 *
 * maxBounds clamps the camera so the visible area never leaves the box. That
 * makes the real minimum zoom a function of the CONTAINER SIZE -- a taller
 * map needs a higher zoom for the same box to still cover it. The old box was
 * the tri-state area, and on a phone the vertical term always bit first:
 *
 *     390x506 (map above the feed)   floor z6.35
 *     390x844 (full bleed)           floor z7.08
 *     430x932 (15 Pro Max)           floor z7.23
 *
 * So minZoom: 6 never once applied on a phone, and every change that made the
 * map taller raised the floor. Nobody edited a zoom setting; the map grew.
 *
 * The test below recomputes that floor from the bounds actually in app.js. It
 * fails if any phone-sized container cannot reach minZoom, which is the exact
 * shape of the bug and is invisible to reading the file.
 *
 * THE LOAD
 *
 * maplibre-gl is ~900KB from a third-party CDN and the map cannot start
 * without it. The service worker used to refuse to cache it, so every cold
 * open re-downloaded it. And initMap called `new maplibregl.Map` with no
 * guard, so a slow CDN threw a ReferenceError out of boot and took
 * startLocationWatch and the startup fallbacks down with it.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = (f) => path.join(__dirname, '..', f);
const APP = fs.readFileSync(root('app.js'), 'utf8');
const SW = fs.readFileSync(root('sw.js'), 'utf8');
const HTML = fs.readFileSync(root('index.html'), 'utf8');

const tests = [];
const test = (n, f) => tests.push([n, f]);

/** Web Mercator northing, 0 at the north pole and 1 at the south. */
function mercY(lat) {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

/** The bounds and minZoom exactly as app.js declares them. */
function cameraLimits() {
  const bounds = APP.match(
    /maxBounds:\s*\[\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]\s*,\s*\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]\s*\]/);
  assert.ok(bounds, 'maxBounds is gone from app.js');
  const minZoom = APP.match(/^\s*minZoom:\s*([\d.]+),/m);
  assert.ok(minZoom, 'minZoom is gone from app.js');
  const [w, s, e, n] = bounds.slice(1, 5).map(Number);
  return {
    west: w, south: s, east: e, north: n,
    minZoom: Number(minZoom[1]),
    xSpan: (e - w) / 360,
    ySpan: Math.abs(mercY(n) - mercY(s)),
  };
}

/** The zoom MapLibre will actually refuse to go below, for this container. */
function enforcedFloor(lim, width, height) {
  const world = 256; // tileSize in the style
  return Math.max(
    lim.minZoom,
    Math.log2(width / (world * lim.xSpan)),
    Math.log2(height / (world * lim.ySpan)));
}

const PHONES = [
  ['iPhone SE', 375, 667],
  ['iPhone 13/14', 390, 844],
  ['iPhone 14 Plus', 428, 926],
  ['iPhone 15 Pro Max', 430, 932],
  ['a taller phone than ships today', 500, 1000],
];

// ------------------------------------------------------------------ the zoom

test('every phone can reach minZoom; maxBounds does not set the floor', () => {
  const lim = cameraLimits();
  PHONES.forEach(([name, w, h]) => {
    const floor = enforcedFloor(lim, w, h);
    assert.ok(floor <= lim.minZoom + 0.001,
      `${name} (${w}x${h}) cannot zoom out past z${floor.toFixed(2)}; `
      + `minZoom is ${lim.minZoom}. maxBounds is setting the floor again.`);
  });
});

test('the old tri-state box is what the fix replaced', () => {
  /* Guards against a revert that looks harmless. These are the numbers that
   * produced a z7.08 floor on a 390x844 phone. */
  const lim = cameraLimits();
  const old = { xSpan: 0.0250, ySpan: 0.0243, minZoom: 6 };
  const oldFloor = enforcedFloor(old, 390, 844);
  assert.ok(oldFloor > 7, 'the old bounds should have floored a phone above z7');
  assert.ok(lim.ySpan > old.ySpan * 2,
    'the bounds are back to roughly the old height, so the floor is back too');
});

test('the map still cannot be zoomed out to the whole country', () => {
  /* The bounds got looser on purpose, so the thing that keeps the basemap off
   * the rest of the US is minZoom alone now. It has to still be there. */
  const lim = cameraLimits();
  assert.ok(lim.minZoom >= 6, `minZoom fell to ${lim.minZoom}`);
  assert.ok(lim.xSpan < 0.1 && lim.ySpan < 0.1,
    'maxBounds is now so wide it contains nothing');
});

test('the bounds still contain the region the app is about', () => {
  const lim = cameraLimits();
  // NYC, and the far corners of the tri-state area drivers actually reach.
  [['NYC', -73.98, 40.73], ['Buffalo', -78.88, 42.89],
   ['Philadelphia', -75.16, 39.95], ['Montauk', -71.94, 41.04]].forEach(
    ([name, lng, lat]) => {
      assert.ok(lng > lim.west && lng < lim.east, `${name} is outside the bounds`);
      assert.ok(lat > lim.south && lat < lim.north, `${name} is outside the bounds`);
    });
});

// ------------------------------------------------------------------ the load

test('a late map library does not take the whole boot down', () => {
  /* initMap is called straight through from boot. An unguarded
   * `new maplibregl.Map` throws a ReferenceError out of it and everything
   * after the call site -- startLocationWatch, the GPS priority timer, the
   * startup fallbacks -- never runs. */
  const at = APP.indexOf('function initMap()');
  assert.ok(at > -1, 'initMap is gone');
  const head = APP.slice(at, at + 400);
  assert.ok(/typeof maplibregl === 'undefined'/.test(head),
    'initMap constructs the map without checking the library arrived');
  assert.ok(/whenMapLibreReady\(initMap\)/.test(head),
    'initMap does not retry once the library lands');
  assert.ok(/function whenMapLibreReady/.test(APP), 'the waiter is gone');
  assert.ok(/MAPLIBRE_WAIT_MS/.test(APP),
    'the wait has no ceiling, so a dead CDN polls forever');
});

test('the pinned map library is cached, not re-downloaded every open', () => {
  assert.ok(/VERSIONED_CDN_PATTERN/.test(SW), 'the CDN cache rule is gone');
  // It must no longer be excluded by the blanket no-cache list.
  const noCache = SW.slice(SW.indexOf('NO_CACHE_PATTERNS'), SW.indexOf('];', SW.indexOf('NO_CACHE_PATTERNS')));
  assert.ok(!/unpkg/.test(noCache),
    'unpkg is back in NO_CACHE_PATTERNS, so the map library is never cached');
  // Cache-first: a network-first rule still pays the round trip every open,
  // which is the entire problem.
  const rule = SW.slice(SW.indexOf('VERSIONED_CDN_PATTERN.test('));
  assert.ok(/caches\.match\(event\.request\)\.then\(\(hit\) => \{[\s\S]{0,80}if \(hit\) return hit;/.test(rule),
    'the map library is no longer served cache-first');
  assert.ok(/response\.type !== 'opaque'/.test(rule),
    'an opaque response would be cached and then served unreadable forever');
});

test('only an exactly-versioned library URL is cached', () => {
  /* Caching an unversioned URL forever would pin a bad build with no way out.
   * The version is in the path, so a bump misses the cache by construction. */
  const m = SW.match(/const VERSIONED_CDN_PATTERN = (\/.*\/);/);
  assert.ok(m, 'the pattern is not a literal regex any more');
  const re = new RegExp(m[1].slice(1, -1));
  assert.ok(re.test('https://unpkg.com/maplibre-gl@5.10.0/dist/maplibre-gl.js'));
  assert.ok(re.test('https://unpkg.com/maplibre-gl@5.10.0/dist/maplibre-gl.css'));
  assert.ok(!re.test('https://unpkg.com/maplibre-gl/dist/maplibre-gl.js'),
    'an unversioned URL would be cached forever');
  assert.ok(!re.test('https://unpkg.com/something-else@1.0.0/x.js'),
    'the rule is not limited to the map library');
  assert.ok(!re.test('https://evil.example/unpkg.com/maplibre-gl@5.10.0/x.js'),
    'the rule matches a host it should not');
});

test('the tile hosts are opened before the map asks for a tile', () => {
  /* Nothing can request a tile until maplibre-gl has downloaded and parsed,
   * so without a hint the DNS lookup and TLS handshake happen after the map
   * exists and is waiting to draw -- which is exactly the window where it
   * shows an upscaled parent tile. */
  ['a', 'b', 'c'].forEach((h) => {
    assert.ok(
      HTML.includes(`rel="preconnect" href="https://${h}.basemaps.cartocdn.com"`),
      `no preconnect for ${h}.basemaps.cartocdn.com`);
  });
  // The style must still use the hosts that were preconnected.
  ['a', 'b', 'c'].forEach((h) => {
    assert.ok(APP.includes(`https://${h}.basemaps.cartocdn.com/rastertiles/voyager/`),
      `the style no longer uses ${h}.basemaps.cartocdn.com`);
  });
});

// --------------------------------------------------------------------------
let failed = 0;
tests.forEach(([name, fn]) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message.split('\n')[0]}`);
  }
});
console.log(failed ? `\n${failed} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);
