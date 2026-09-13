#!/usr/bin/env node
/**
 * map-route.test.js — the dotted line to the recommended zone.
 *
 * Fluidity is the requirement, so most of these are about work NOT done: how
 * often the source is written, whether layers churn, whether GPS jitter costs
 * a redraw. A line that is merely correct but redraws on every fix is the
 * failure this feature was worried about in the first place.
 *
 * The rest are about the line never pointing somewhere the pill is not naming.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const PART17 = fs.readFileSync(path.join(ROOT, 'app.part17.js'), 'utf8');
const JS_SOURCE = path.join(ROOT, 'map-route.js');

function codeOf(file) {
  return fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
}

// --------------------------------------------------------------------------
// a MapLibre stand-in that counts what it is asked to do
// --------------------------------------------------------------------------

function fakeMap(options = {}) {
  const sources = {};
  const layers = {};
  const map = {
    styleLoaded: options.styleLoaded !== false,
    images: {},
    calls: { addSource: 0, addLayer: 0, removeLayer: 0, setData: 0, addImage: 0 },
    handlers: {},
    isStyleLoaded: () => map.styleLoaded,
    addSource: (id, spec) => {
      map.calls.addSource += 1;
      sources[id] = {
        data: spec.data,
        setData: (d) => { map.calls.setData += 1; sources[id].data = d; },
      };
    },
    getSource: (id) => sources[id],
    addLayer: (spec) => { map.calls.addLayer += 1; layers[spec.id] = spec; },
    getLayer: (id) => layers[id],
    removeLayer: (id) => { map.calls.removeLayer += 1; delete layers[id]; },
    hasImage: (id) => !!map.images[id],
    addImage: (id) => { map.calls.addImage += 1; map.images[id] = true; },
    on: (type, fn) => { (map.handlers[type] = map.handlers[type] || []).push(fn); },
    fire: (type) => (map.handlers[type] || []).forEach((fn) => fn()),
    _sources: sources,
    _layers: layers,
  };
  return map;
}

function build(options = {}) {
  const map = options.map === null ? null : (options.map || fakeMap());
  const frames = [];
  const zoneLookups = [];

  const document = {
    readyState: 'complete',
    createElement: () => ({
      getContext: () => ({
        beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {},
        getImageData: () => ({ data: [] }),
      }),
    }),
    addEventListener: (t, fn) => { (document._l = document._l || {})[t] = fn; },
  };
  const window = {
    document, console,
    map,
    addEventListener: (t, fn) => { (window._l[t] = window._l[t] || []).push(fn); },
    _l: {},
    dispatch: (t, e) => (window._l[t] || []).forEach((fn) => fn(e)),
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (fn) => { frames.push(fn); return frames.length; },
    TlcMapUiInternals: {
      getMap: () => map,
      getUserLatLng: () => (options.at === undefined ? { lat: 40.60, lng: -73.92 } : options.at),
      resolveZoneFeatureAtLngLat: () => {
        zoneLookups.push(1);
        if (options.zone === null) return null;
        return options.zone || {
          properties: { zone_name: 'Astoria' },
          geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] },
        };
      },
    },
    TlcAssistantRecommendation: options.initial || null,
  };
  window.window = window;

  const ctx = vm.createContext({
    window, document, console,
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    Object, Number, Math, Array, String, JSON, Error, Boolean,
  });
  vm.runInContext(fs.readFileSync(JS_SOURCE, 'utf8'), ctx, { filename: 'map-route.js' });

  const flush = () => { const pending = frames.splice(0); pending.forEach((fn) => fn()); };
  return { window, document, map, api: window.TeamJoseoMapRoute, frames, flush, zoneLookups };
}

const MOVE = {
  actionCode: 'LEAVE_NOW', verb: 'LEAVE', tone: 'urgent', isMove: true,
  zoneName: 'Astoria', score: 91, distanceMiles: 4.2, etaMinutes: 14,
  bearingDeg: 12, targetLat: 40.77, targetLng: -73.92, targetZoneId: '7',
};
const STAY = {
  actionCode: 'STAY', verb: 'STAY', tone: 'hold', isMove: false,
  zoneName: 'Astoria', score: 86, distanceMiles: null, etaMinutes: null,
  bearingDeg: null, targetLat: null, targetLng: null, targetZoneId: null,
};

const publish = (dom, detail) => dom.window.dispatch('tlc:recommendation',
  { detail: { primary: '', secondary: '', detail } });
const moveTo = (dom, lat, lng) => dom.window.dispatch('tlc-user-location-updated',
  { detail: { lat, lng, ts: Date.now() } });

const line = (dom) => dom.map._sources['tlc-action-route'].data;
const zone = (dom) => dom.map._sources['tlc-action-route-zone'].data;
const endPoint = (dom) => dom.map._sources['tlc-action-route-end'].data;
// Arrays built inside the vm have that realm's prototype, so deepStrictEqual
// reports "same structure but not reference-equal". Compare the values.
const coordsEqual = (actual, expected, message) =>
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);

const tests = [];
const test = (n, f) => tests.push([n, f]);

// --------------------------------------------------------------------------
// drawing at all
// --------------------------------------------------------------------------

test('a move draws a line from the driver to the target', () => {
  const dom = build();
  publish(dom, MOVE);
  const coords = line(dom).features[0].geometry.coordinates;
  coordsEqual(coords[0], [-73.92, 40.60], 'wrong origin');
  coordsEqual(coords[1], [-73.92, 40.77], 'wrong target');
});

test('the arrow sits at the target, not at the driver', () => {
  const dom = build();
  publish(dom, MOVE);
  coordsEqual(endPoint(dom).features[0].geometry.coordinates, [-73.92, 40.77]);
});

test('the arrow points along the line as it is now, not as it was published', () => {
  // bearingDeg on the payload is from the moment the recommendation was made.
  // The driver has moved since; the arrow has to follow the line on screen.
  const dom = build();
  publish(dom, MOVE);
  const drawn = endPoint(dom).features[0].properties.bearing;
  assert.ok(Math.abs(drawn - 0) < 1, `due north expected, got ${drawn}`);
  assert.notStrictEqual(Math.round(drawn), MOVE.bearingDeg);
});

test('a stay draws nothing', () => {
  const dom = build();
  publish(dom, MOVE);
  publish(dom, STAY);
  assert.strictEqual(line(dom).features.length, 0);
  assert.strictEqual(endPoint(dom).features.length, 0);
});

test('a move with no target coordinates draws nothing', () => {
  // A line left over from the last recommendation points somewhere nobody said.
  const dom = build();
  publish(dom, MOVE);
  publish(dom, Object.assign({}, MOVE, { targetLat: null, targetLng: null }));
  assert.strictEqual(line(dom).features.length, 0);
});

test('a new target redraws at once rather than waiting for the driver to move', () => {
  const dom = build();
  publish(dom, MOVE);
  const before = dom.map.calls.setData;
  publish(dom, Object.assign({}, MOVE, { targetLat: 40.80, targetLng: -73.88 }));
  assert.ok(dom.map.calls.setData > before, 'the new target waited for a GPS fix');
  coordsEqual(line(dom).features[0].geometry.coordinates[1], [-73.88, 40.80]);
});

test('no driver position yet means no line, and no crash', () => {
  const dom = build({ at: null });
  publish(dom, MOVE);
  assert.strictEqual(line(dom).features.length, 0);
});

// --------------------------------------------------------------------------
// fluidity: the work that is deliberately not done
// --------------------------------------------------------------------------

test('GPS jitter at a standstill costs no redraw', () => {
  // Standing at a light produces a few metres of noise. Redrawing for that is
  // work with nothing to show for it, and it is most of what makes a following
  // line feel expensive.
  const dom = build();
  publish(dom, MOVE);
  const before = dom.map.calls.setData;
  for (let i = 0; i < 20; i += 1) moveTo(dom, 40.60 + i * 0.000002, -73.92);
  dom.flush();
  assert.strictEqual(dom.map.calls.setData, before, 'jitter redrew the line');
  assert.ok(dom.api._state.skipped >= 20, 'jitter was not recognised as jitter');
});

test('a burst of fixes in one frame writes once, not once each', () => {
  const dom = build();
  publish(dom, MOVE);
  const before = dom.map.calls.setData;
  moveTo(dom, 40.61, -73.92);
  moveTo(dom, 40.62, -73.92);
  moveTo(dom, 40.63, -73.92);
  assert.strictEqual(dom.map.calls.setData, before, 'it wrote before the frame ran');
  dom.flush();
  // Two sources, written once each.
  assert.strictEqual(dom.map.calls.setData, before + 2, 'a burst wrote more than once');
});

test('the last position in a burst is the one drawn', () => {
  const dom = build();
  publish(dom, MOVE);
  moveTo(dom, 40.61, -73.92);
  moveTo(dom, 40.65, -73.92);
  dom.flush();
  coordsEqual(line(dom).features[0].geometry.coordinates[0], [-73.92, 40.65]);
});

test('real movement does redraw', () => {
  // The counterpart to the jitter test: proof the threshold is not just off.
  const dom = build();
  publish(dom, MOVE);
  const before = dom.map.calls.setData;
  moveTo(dom, 40.62, -73.92);
  dom.flush();
  assert.ok(dom.map.calls.setData > before, 'moving 2km did not redraw');
});

test('the threshold is metres, not degrees of nothing', () => {
  const dom = build();
  // ~8m. Small enough not to lag behind a moving car, large enough to swallow
  // a stationary phone's wander.
  assert.ok(dom.api.MIN_MOVE_DEG > 0.00001 && dom.api.MIN_MOVE_DEG < 0.0005,
    `MIN_MOVE_DEG=${dom.api.MIN_MOVE_DEG}`);
});

test('layers are added once and never removed', () => {
  // Adding or removing a layer is a style recalculation. Hiding the line by
  // emptying its source costs nothing.
  const dom = build();
  publish(dom, MOVE);
  const added = dom.map.calls.addLayer;
  publish(dom, STAY);
  publish(dom, MOVE);
  moveTo(dom, 40.63, -73.92);
  dom.flush();
  assert.strictEqual(dom.map.calls.addLayer, added, 'layers were re-added');
  assert.strictEqual(dom.map.calls.removeLayer, 0, 'a layer was removed');
});

test('location updates with nothing to draw do no work at all', () => {
  const dom = build();
  publish(dom, STAY);
  const before = dom.map.calls.setData;
  for (let i = 0; i < 10; i += 1) moveTo(dom, 40.6 + i * 0.01, -73.92);
  dom.flush();
  assert.strictEqual(dom.map.calls.setData, before);
});

test('the arrow image is built once', () => {
  const dom = build();
  publish(dom, MOVE);
  dom.api.install();
  assert.strictEqual(dom.map.calls.addImage, 1);
});


// --------------------------------------------------------------------------
// the destination zone outline
// --------------------------------------------------------------------------

test('the destination zone is outlined', () => {
  const dom = build();
  publish(dom, MOVE);
  assert.strictEqual(zone(dom).features.length, 1, 'no outline drawn');
  assert.strictEqual(zone(dom).features[0].geometry.type, 'Polygon');
});

test('the outline comes from the target coordinates the pill published', () => {
  // Resolved through the map's own lookup from those coordinates, so the
  // outlined polygon is by construction the zone the pill names.
  const src = codeOf(JS_SOURCE);
  assert.ok(src.includes('resolveZoneFeatureAtLngLat'), 'it does not use the map lookup');
  assert.ok(/resolveZoneFeatureAtLngLat\(\{ lat: target\.lat, lng: target\.lng \}\)/.test(src),
    'it resolves from something other than the published target');
});

test('the zone is resolved once per target, never per frame', () => {
  // The polygon only changes when the recommendation does, and it is the one
  // piece of geometry here big enough that redrawing it on movement would cost.
  const dom = build();
  publish(dom, MOVE);
  const after = dom.zoneLookups.length;
  for (let i = 1; i <= 5; i += 1) moveTo(dom, 40.60 + i * 0.01, -73.92);
  dom.flush();
  assert.strictEqual(dom.zoneLookups.length, after, 'the zone was re-resolved while moving');
});

test('the same target published again does not re-resolve', () => {
  const dom = build();
  publish(dom, MOVE);
  const after = dom.zoneLookups.length;
  publish(dom, MOVE);
  assert.strictEqual(dom.zoneLookups.length, after);
});

test('a new target does re-resolve', () => {
  const dom = build();
  publish(dom, MOVE);
  const after = dom.zoneLookups.length;
  publish(dom, Object.assign({}, MOVE, { targetLat: 40.80, targetLng: -73.88 }));
  assert.ok(dom.zoneLookups.length > after, 'a new target kept the old outline');
});

test('a stay clears the outline with everything else', () => {
  const dom = build();
  publish(dom, MOVE);
  publish(dom, STAY);
  assert.strictEqual(zone(dom).features.length, 0);
});

test('a zone that cannot be resolved leaves no outline, and the line still shows', () => {
  // An outline drawn around a guess is worse than none; the line and arrow
  // already say where to go.
  const dom = build({ zone: null });
  publish(dom, MOVE);
  assert.strictEqual(zone(dom).features.length, 0);
  assert.strictEqual(line(dom).features.length, 1, 'the line went with it');
  assert.strictEqual(dom.api._state.outlined, false);
});

test('the outline sits under the line and the arrow', () => {
  // Added before them, so neither is cut by the border.
  const dom = build();
  dom.api.install();
  const order = Object.keys(dom.map._layers);
  assert.ok(order.indexOf('tlc-action-route-zone-outline') < order.indexOf('tlc-action-route-arrow'),
    order.join(' < '));
});

// --------------------------------------------------------------------------
// surviving the map
// --------------------------------------------------------------------------

test('a style change puts the layers back and redraws', () => {
  // Night mode and basemap swaps drop custom layers. Without this the line
  // silently disappears at dusk and never comes back.
  const dom = build();
  publish(dom, MOVE);
  const drawnBefore = dom.map.calls.setData;
  dom.map._layers = {};
  Object.keys(dom.map._layers).forEach((k) => delete dom.map._layers[k]);
  dom.map.removeLayer('tlc-action-route-line');
  dom.map.removeLayer('tlc-action-route-arrow');
  dom.map.fire('styledata');
  assert.ok(dom.map.getLayer('tlc-action-route-line'), 'the line layer was not restored');
  assert.ok(dom.map.calls.setData > drawnBefore, 'the line was not redrawn after the style change');
});

test('a style that has not loaded yet is retried rather than half-installed', () => {
  const dom = build({ map: fakeMap({ styleLoaded: false }) });
  assert.strictEqual(dom.map.calls.addLayer, 0);
  dom.map.styleLoaded = true;
  assert.ok(dom.api.install(), 'it never installed once the style was ready');
  assert.ok(dom.map.getLayer('tlc-action-route-line'));
});

test('no map at all does not throw', () => {
  const dom = build({ map: null });
  publish(dom, MOVE);
  moveTo(dom, 40.61, -73.92);
  dom.flush();
  assert.ok(dom.api, 'the module did not survive a missing map');
});

// --------------------------------------------------------------------------
// the seam
// --------------------------------------------------------------------------

test('the publisher sends the target coordinates', () => {
  ['targetLat', 'targetLng', 'targetZoneId'].forEach((field) => {
    assert.ok(new RegExp(`${field}:`).test(PART17), `buildActionDetail dropped ${field}`);
  });
});

test('the hold branch carries the same keys rather than omitting them', () => {
  // A consumer testing for a missing key on every payload ends up not testing.
  const start = PART17.indexOf('function buildActionDetail()');
  const body = PART17.slice(start, start + 3200);
  assert.strictEqual((body.match(/targetLat:/g) || []).length, 2,
    'the MONITOR fallback and the main return should both set targetLat');
});

test('the route decides nothing about where to go', () => {
  const src = codeOf(JS_SOURCE);
  ['visibleRating', 'assistantMoveTarget', 'haversine', 'scoreColor'].forEach((token) => {
    assert.ok(!src.includes(token),
      `map-route.js references ${token} — it draws the recommendation, it does not make one`);
  });
});

test('it is a straight line, not a routed path', () => {
  // Routing costs a network round trip per recalculation. A driver glancing
  // down wants the direction; the Navigate button is where turns live.
  const src = codeOf(JS_SOURCE);
  assert.ok(!/fetch\(/.test(src), 'map-route.js makes a network request');
  const coords = build();
  publish(coords, MOVE);
  assert.strictEqual(line(coords).features[0].geometry.coordinates.length, 2);
});

test('the layer specs are shaped the way MapLibre requires', () => {
  // The full specs were checked against @maplibre/maplibre-gl-style-spec's own
  // validator, extracted from this very file so the check covered what ships.
  // That validator is not a dependency of this repo -- the suite is plain node
  // on purpose -- so these pin the parts it would reject, cheaply.
  const dom = build();
  dom.api.install();
  const lineLayer = dom.map.getLayer('tlc-action-route-line');
  const arrow = dom.map.getLayer('tlc-action-route-arrow');

  assert.strictEqual(lineLayer.type, 'line');
  Object.keys(lineLayer.paint).forEach((k) => assert.ok(k.startsWith('line-'), k));
  Object.keys(lineLayer.layout).forEach((k) => assert.ok(k.startsWith('line-'), k));

  assert.strictEqual(arrow.type, 'symbol');
  Object.keys(arrow.layout).forEach((k) => assert.ok(k.startsWith('icon-'), k));
});

test('the line is drawn as dots, the way the design shows it', () => {
  const dom = build();
  dom.api.install();
  const paint = dom.map.getLayer('tlc-action-route-line').paint;
  const dash = paint['line-dasharray'];
  assert.ok(Array.isArray(dash) && dash.length === 2, JSON.stringify(dash));
  // A short dash against a long gap, with a round cap, is what makes dots
  // rather than a dashed line.
  assert.ok(dash[0] < dash[1], `${dash[0]} should be shorter than ${dash[1]}`);
  assert.strictEqual(dom.map.getLayer('tlc-action-route-line').layout['line-cap'], 'round');
});

test('the module is registered in the manifest', () => {
  assert.ok(INDEX.includes('"./map-route.js"'), 'not loaded');
});

// --------------------------------------------------------------------------

let failed = 0;
tests.forEach(([name, fn]) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
});
console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);
