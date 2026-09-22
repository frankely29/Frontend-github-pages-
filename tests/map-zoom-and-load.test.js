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

test('the basemap host is opened before the map asks for a tile', () => {
  /* Nothing can request a tile until maplibre-gl has downloaded and parsed,
   * so without a hint the DNS lookup and TLS handshake happen after the map
   * exists and is waiting to draw -- which is exactly the window where it
   * shows an upscaled parent tile. The hint has to point at whichever
   * basemap is actually primary, which is the part that just changed. */
  assert.ok(HTML.includes('rel="preconnect" href="https://tiles.openfreemap.org"'),
    'no preconnect for the primary basemap host');
  assert.ok(APP.includes('https://tiles.openfreemap.org/styles/'),
    'the app no longer uses the host it preconnects to');
});

// --------------------------------------------------------- the basemap key

/* Photographed by the user: every tile stamped
 *
 *     API KEY REQUIRED — carto.com/basemaps/apikey
 *
 * CARTO now requires a key for their basemaps and the app requested them
 * without one. That is a licence problem before it is a visual one, and it
 * bites hardest on zoom-out, because a new zoom level discards every tile
 * and asks for a fresh set that comes back watermarked or throttled -- so
 * the map goes blank and the zoom looks like it did nothing.
 */

test('the primary basemap needs no API key', () => {
  const fn = APP.slice(APP.indexOf('function initialBasemapStyle'),
                       APP.indexOf('function initMap'));
  assert.ok(/OPENFREEMAP_STYLE/.test(fn), 'the keyless basemap is not the default');
  assert.ok(!/cartocdn/.test(fn), 'the default went back to the keyed provider');
});

test('an unkeyed CARTO URL is never the primary basemap', () => {
  /* It may still exist as the fallback -- a watermarked map beats no map --
   * but it must be reachable only through that path. */
  const primary = APP.slice(APP.indexOf('const OPENFREEMAP_STYLE'),
                            APP.indexOf('function cartoRasterStyle'));
  assert.ok(!/cartocdn/.test(primary));
  const carto = APP.slice(APP.indexOf('function cartoRasterStyle'),
                          APP.indexOf('function initialBasemapStyle'));
  assert.ok(/cartocdn/.test(carto), 'the fallback basemap is gone entirely');
  assert.ok(!/apikey|api_key/i.test(carto),
    'a key was pasted into the fallback URL; keys do not belong in the repo');
});

test('a basemap that never loads falls back instead of showing nothing', () => {
  /* A basemap is the one asset a driver cannot work without.
   *
   * The first version of this guessed from error events -- any error without
   * a sourceId whose message mentioned "style". Booted against a healthy
   * vector style it fired anyway and dropped straight back to the
   * watermarked raster, which is the exact thing being fixed. So the test
   * pins the question actually being asked: did the style load. */
  const at = APP.indexOf('BASEMAP_STYLE_TIMEOUT_MS);');
  assert.ok(at > -1, 'the basemap fallback timer is gone');
  const block = APP.slice(APP.indexOf('const fallbackTimer'), at + 400);
  assert.ok(/map\.isStyleLoaded\(\)/.test(block),
    'the fallback no longer checks whether the style loaded');
  assert.ok(/setStyle\(cartoRasterStyle\(\)\)/.test(block), 'there is no fallback');
  assert.ok(/map\.once\("style\.load"/.test(block),
    'a slow style is never let off the hook, so it falls back for being slow');
  assert.ok(!/sourceId/.test(block),
    'the fallback is guessing from error events again');
});

test('night mode works on a vector basemap, not just a raster one', () => {
  /* raster-brightness-* exist only on raster layers. On the vector basemap
   * those calls are invalid, and the old code was saved from throwing only
   * by its try/catch -- which would have left night mode silently dead. */
  const fn = APP.slice(APP.indexOf('function applyNightBasemap'),
                       APP.indexOf('function applyNightBasemap') + 2000);
  assert.ok(/map\.getLayer\("carto-base"\)/.test(fn),
    'the raster path no longer checks the layer exists');
  assert.ok(/APP_OWNED_LAYER/.test(fn),
    'the vector path would dim this app\'s own layers as well as the basemap');
  assert.ok(/NIGHT_TINTED_LAYERS/.test(fn),
    'nothing tracks which layers were dimmed, so day mode cannot undo it');
});

test('every label asks for a font the basemap actually serves', () => {
  /* The symbol layers asked for "Open Sans Regular", which the previous
   * glyph endpoint served and OpenFreeMap does not. A font stack is tried in
   * order, so Noto Sans goes first and Open Sans stays behind it for the
   * fallback basemap. A missing font is not a fallback -- the label simply
   * does not draw. */
  const files = ['long-trips-block.feature.js', 'app.part12.js',
                 'strategic-points.feature.js'];
  let found = 0;
  files.forEach((f) => {
    const src = fs.readFileSync(root(f), 'utf8');
    const stacks = src.match(/"text-font":\s*\[[^\]]*\]/g) || [];
    stacks.forEach((s) => {
      found += 1;
      assert.ok(/"Noto Sans Regular"/.test(s),
        `${f} has a font stack without Noto Sans: ${s}`);
      assert.ok(s.indexOf('Noto Sans Regular') < s.indexOf('Open Sans Regular'),
        `${f} lists Open Sans before Noto Sans: ${s}`);
    });
  });
  assert.ok(found >= 7, `only ${found} font stacks found; expected at least 7`);
});

// ------------------------------------------------- the driver's chosen zoom

/* THE ONE A DRIVER ACTUALLY FELT
 *
 * Reproduced in a browser against origin/main, with a moving GPS fix:
 *
 *     driver zooms out to z9:            z9
 *      15s of driving, phone untouched:  z9
 *      18s of driving, phone untouched:  z11.14   <- the ease starts
 *      20s of driving, phone untouched:  z13      <- overridden
 *
 * Zooming out fires zoomstart and correctly disables auto-follow. But
 * AUTO_FOCUS_INACTIVITY_MS (20s) then fires, and the only thing that ever
 * turns auto-follow back on is that timer -- there is no recentre button,
 * btnCenter is null. It called setAutoCenterEnabled(true, "inactive-timeout"),
 * which forced the zoom, and forcing means Math.max(current, 13): a function
 * that can only raise.
 *
 * A driver watching the road is "inactive" by that definition, so the map
 * overruled them every twenty seconds.
 */

test('the inactivity timer recentres without touching the driver\'s zoom', () => {
  const fn = APP.slice(APP.indexOf('function setAutoCenterEnabled'),
                       APP.indexOf('function handleAutoFocusInactivityTimeout'));
  assert.ok(/\{ forceZoom = false \} = \{\}/.test(fn),
    'forceZoom no longer defaults to off in setAutoCenterEnabled');
  assert.ok(!/shouldForceZoom/.test(fn),
    'the old always-force branch is back');
  // The zoom window makes every later recentre raise the zoom too, so it has
  // to be behind the same gate rather than armed whenever follow resumes.
  assert.ok(/if \(forceZoom\) armAutoFocusZoomWindow\(\);/.test(fn),
    'the zoom window is armed without checking forceZoom');
  // It must still recentre -- the fix is about zoom, not about dropping follow.
  assert.ok(/refreshAutoCenterCamera\(\{ forceZoom \}\)/.test(fn),
    'auto-follow no longer recentres at all');
});

test('the already-following idle path does not re-zoom either', () => {
  const fn = APP.slice(APP.indexOf('function handleAutoFocusInactivityTimeout'),
                       APP.indexOf('syncCenterButton();',
                                   APP.indexOf('function handleAutoFocusInactivityTimeout')));
  assert.ok(/refreshAutoCenterCamera\(\{ forceZoom: false \}\)/.test(fn),
    'the idle refresh forces the zoom again');
});

test('forcing the zoom can still only ever raise it, so nothing may force it by default', () => {
  /* getAutoFollowZoom is deliberately asymmetric -- Math.max(current, 13).
   * That is fine for an explicit "take me back to me" and wrong for anything
   * automatic, which is the whole bug. This pins the asymmetry so the
   * default-off above keeps mattering. */
  const fn = APP.slice(APP.indexOf('function getAutoFollowZoom'),
                       APP.indexOf('function autoCenterAndAutoZoom'));
  assert.ok(/Math\.max\(baseZoom, AUTO_FOCUS_RETURN_ZOOM\)/.test(fn),
    'getAutoFollowZoom changed shape; re-check who can force a zoom');
  assert.ok(/forceZoom \|\| isAutoFocusZoomWindowActive\(\)/.test(fn),
    'the force condition changed shape');
});

// ------------------------------------------- the overlay that never lifted
/* #mapLoading is inset:0 at z-index 999 over the map, with pointer-events on.
 * It is hidden by maybeResolveStartupLoading, which returns early unless
 * mapReady -- and mapReady is set in exactly one place, inside map.on("load").
 * MapLibre fires `load` only once the style AND the first viewport's tiles
 * have arrived, so a tile host that is slow, rate-limited or unreachable meant
 * the overlay stayed up for good.
 *
 * That is not a cosmetic stall. Reproduced in a browser with the tiles stalled:
 * both fingers of a pinch land on div#mapLoading and the map never receives a
 * touchstart, so the map cannot be panned or zoomed at all. The 12s timer that
 * looks like the safety net went through the same early return and did nothing.
 */
test('the startup overlay comes off even when the map never finishes loading', () => {
  const i = APP.indexOf('hard-safety-timeout');
  assert.ok(i > 0, 'the hard safety timeout is gone');
  const block = APP.slice(i - 200, i + 1400);
  assert.ok(/hideStartupLoadingOverlay\(["']hard-safety-timeout/.test(block),
    'the 12s timeout only calls maybeResolveStartupLoading, which returns at ' +
    '`if (!mapReady) return` -- so a map that never loads keeps an ' +
    'untappable overlay over itself forever');
});

test('hiding the startup overlay stays idempotent', () => {
  /* The unconditional call above is safe only because of this guard. */
  const fn = APP.slice(APP.indexOf('function hideStartupLoadingOverlay'),
                       APP.indexOf('function maybeResolveStartupLoading'));
  assert.ok(/if \(startupLoadingForceHidden\) return;/.test(fn),
    'hideStartupLoadingOverlay lost its guard, so the backstop call now ' +
    're-runs its side effects on every healthy boot');
});

test('mapReady is still only set from the map load event', () => {
  /* If this ever stops being true the reasoning above needs redoing. */
  const sets = APP.match(/mapReady = true/g) || [];
  assert.strictEqual(sets.length, 1,
    `mapReady is assigned in ${sets.length} places now`);
});

test('nothing in the app forces the zoom automatically', () => {
  /* The grep that would have caught this the first time. Any caller passing
   * forceZoom: true is claiming a driver asked to be re-focused; today
   * nothing can make that claim, because there is no recentre button. */
  const forced = APP.match(/forceZoom:\s*true/g) || [];
  assert.strictEqual(forced.length, 0,
    `${forced.length} call site(s) still force the zoom automatically`);
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
