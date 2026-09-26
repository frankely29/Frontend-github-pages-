#!/usr/bin/env node
/**
 * drawer-map-recenter.test.js — opening a tab must not hide the driver.
 *
 * Reported: "when opening any tab the map should recenter to where user is
 * located, currently user disappears in the map behind the tab."
 *
 * The camera kept the driver's marker in the middle of the WINDOW. In
 * feed-first — which is how the app actually runs — #dockDrawer becomes a
 * full-width sheet whose top edge is at --tj-split, 39% down. So the middle
 * of the window is 26% of the way INTO the sheet, and a driver who opened a
 * panel watched their own dot go under it.
 *
 * MapLibre's camera padding is the right tool: it centres on the middle of
 * the padded box rather than the middle of the canvas. These tests pin the
 * part that is easy to get wrong — WHICH edge gets padded.
 *
 * The first attempt padded "whichever edge the panel is nearest", which is
 * wrong for exactly the panel that was reported: the sheet is flush with
 * left, right AND bottom, so it padded the left by the full width and aimed
 * the camera at a box with no width. The marker moved sideways and stayed
 * hidden. That case is the first test below.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const FEED_CSS = fs.readFileSync(path.join(__dirname, '..', 'feed-first.css'), 'utf8');

function lift(signature) {
  const at = APP.indexOf(signature);
  assert.ok(at > -1, `${signature} is gone from app.js`);
  const params = APP.indexOf(')', at);
  let depth = 0;
  let i = APP.indexOf('{', params);
  for (; i < APP.length; i += 1) {
    if (APP[i] === '{') depth += 1;
    else if (APP[i] === '}' && !(depth -= 1)) break;
  }
  return APP.slice(at, i + 1);
}

function constOf(name) {
  const m = new RegExp(`^const ${name} = (.+);$`, 'm').exec(APP);
  assert.ok(m, `${name} is gone from app.js`);
  return `const ${name} = ${m[1]};`;
}

const VW = 414;
const VH = 852;

/** The real padding function, with a drawer of the given screen rect. */
function padFor(rect, { open = true } = {}) {
  const sandbox = {
    dockDrawer: rect ? {
      classList: { contains: (c) => c === 'open' && open },
      getBoundingClientRect: () => rect,
    } : null,
    window: { innerWidth: VW, innerHeight: VH },
  };
  sandbox.window.visualViewport = null;
  sandbox.document = { documentElement: { clientWidth: VW, clientHeight: VH } };
  vm.createContext(sandbox);
  vm.runInContext(constOf('DRAWER_MAP_MIN_VISIBLE_PX'), sandbox);
  vm.runInContext(lift('function viewportSizeForMap('), sandbox);
  vm.runInContext(lift('function drawerOccludedPadding('), sandbox);
  return sandbox.drawerOccludedPadding();
}

const rect = (left, top, right, bottom) =>
  ({ left, top, right, bottom, width: right - left, height: bottom - top });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the feed-first sheet pads the bottom, never a side', () => {
  /* THE REPORTED CASE. Full width, top edge 39% down, running to the bottom
     of the window. It is flush with three edges at once, and only one of
     them leaves any map to look at. */
  const split = Math.round(VH * 0.39);
  const p = padFor(rect(0, split, VW, VH));
  assert.strictEqual(p.left, 0, 'padding the left leaves the camera no width');
  assert.strictEqual(p.right, 0, 'padding the right leaves the camera no width');
  assert.strictEqual(p.top, 0, 'padding the top aims at the sheet itself');
  assert.strictEqual(p.bottom, VH - split,
    'the bottom is not padded by everything below the sheet\'s top edge');
});

test('the driver ends up in the strip that is still map', () => {
  /* What the padding is FOR. MapLibre centres on the middle of the padded
     box, so the marker lands at (h - padBottom) / 2 -- and that has to be
     above the sheet, or none of this did anything. */
  const split = Math.round(VH * 0.39);
  const p = padFor(rect(0, split, VW, VH));
  const markerY = (VH - p.bottom) / 2;
  assert.ok(markerY < split,
    `the marker lands at ${markerY}, still under a sheet that starts at ${split}`);
  assert.ok(markerY > 0, 'the marker lands off the top of the screen');
});

test('a floating column does not get padded like a sheet', () => {
  /* The other geometry in the stylesheet: pinned top-left, 330px wide. */
  const p = padFor(rect(12, 72, 342, 544));
  assert.strictEqual(p.bottom, 0, 'a narrow left column is being treated as a bottom sheet');
  const padded = Object.entries(p).filter(([, v]) => v > 0);
  assert.strictEqual(padded.length, 1, `padded ${padded.length} edges; exactly one is the point`);
});

test('the camera is always left something to aim at', () => {
  /* A panel covering all but a sliver. Padding the full intrusion would
     leave a zero-height box and MapLibre nowhere to put the centre. */
  const p = padFor(rect(0, 8, VW, VH));
  const free = VH - p.bottom - p.top;
  assert.ok(free >= 100, `only ${free}px of map left to aim at`);
  assert.ok(p.bottom > 0, 'a panel covering the screen produced no padding at all');
});

/* The padding comes back from a vm realm, so its prototype is not this
   realm's Object -- deepStrictEqual rejects it on identity alone. Only the
   four numbers matter. */
function assertNoPadding(p, why) {
  ['top', 'bottom', 'left', 'right'].forEach((side) => {
    assert.strictEqual(p[side], 0, `${why}: ${side} padded by ${p[side]}`);
  });
}

test('a closed drawer pads nothing', () => {
  /* Or the map keeps the offset after the panel is gone -- the driver would
     be stuck off-centre with nothing on screen explaining why. */
  const split = Math.round(VH * 0.39);
  assertNoPadding(padFor(rect(0, split, VW, VH), { open: false }), 'a closed drawer');
  assertNoPadding(padFor(null), 'no drawer in the document');
});

test('a drawer with no size pads nothing', () => {
  /* Measured before layout, or while display:none. A zero rect is not an
     instruction to move the camera. */
  assertNoPadding(padFor(rect(0, 0, 0, 0)), 'a zero-size drawer');
});

// -------------------------------------------------------------- the wiring

test('the sync runs after the panel has finished sliding', () => {
  /* The sheet transitions for 260ms. Measured mid-slide the rect is wherever
     the animation happens to be, the padding comes out short, and the marker
     still lands under the panel. */
  const transition = /transition: top ([\d.]+)s/.exec(FEED_CSS);
  assert.ok(transition, 'the sheet transition is gone from feed-first.css');
  const slideMs = Number(transition[1]) * 1000;
  const settle = Number(/^const DRAWER_MAP_SETTLE_MS = (\d+);$/m.exec(APP)[1]);
  assert.ok(settle >= slideMs,
    `the camera re-aims after ${settle}ms but the sheet slides for ${slideMs}ms`);
});

test('opening and closing a panel both re-aim the camera', () => {
  assert.ok(/window\.addEventListener\("tlc:drawer-changed", scheduleDrawerMapSync\)/.test(APP),
    'nothing listens for the drawer opening or closing');
  /* announceDrawer fires that event, and both openDrawer and closeDrawer
     call it -- so closing resets the padding as surely as opening sets it. */
  ['function openDrawer(', 'function closeDrawer('].forEach((sig) => {
    assert.ok(/announceDrawer\(\)/.test(lift(sig)), `${sig} no longer announces itself`);
  });
});

test('re-aiming does not read as the driver panning away', () => {
  /* Auto-follow switches itself off when the map moves without the driver
     asking. Our own easeTo would look exactly like that, and the map would
     silently stop following them from the first time they opened a tab. */
  const fn = lift('function syncMapPaddingToDrawer(');
  assert.ok(/suppressAutoDisableFor\(/.test(fn),
    'the camera move can turn auto-follow off');
});

test('turn-by-turn keeps its own camera', () => {
  /* Navigation re-aims on every fix; a centre from here would be overwritten
     a moment later, and fighting it mid-manoeuvre is worse than useless. It
     still gets the padding. */
  const fn = lift('function syncMapPaddingToDrawer(');
  assert.ok(/TlcNavigationTurnModule\?\.isActive\?\.\(\)/.test(fn),
    'the drawer camera no longer stands aside for navigation');
  const guarded = fn.slice(fn.indexOf('isActive'));
  assert.ok(/opts\.center/.test(guarded),
    'the centre is set outside the navigation guard');
  assert.ok(/padding/.test(fn.slice(0, fn.indexOf('isActive'))),
    'the padding is inside the navigation guard, so navigation loses it');
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
