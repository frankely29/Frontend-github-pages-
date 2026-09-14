#!/usr/bin/env node
/**
 * viewport.test.js — the app fills the screen it is given.
 *
 * One bug, stated once so it is not reintroduced: `#map` was
 *
 *     position: fixed; inset: 0; height: 100%; width: 100%;
 *
 * Setting top, height and bottom together is over-constrained, and the spec
 * resolves that by throwing `bottom` away. So the height came entirely from the
 * percentage -- and on iOS a standalone web app with
 * apple-mobile-web-app-status-bar-style: black-translucent resolves that
 * percentage against the screen MINUS the status bar, while viewport-fit=cover
 * paints the page over the whole screen. The map came out exactly one status
 * bar short: 894px of map on a 956px screen, with a flat 62px strip of page
 * background under it, edge to edge.
 *
 * These are text assertions about shipped CSS, deliberately, and this file does
 * not pretend otherwise: the wrong percentage base is an iOS behaviour and no
 * test runner here can produce it. What CAN be pinned is that nothing depends
 * on that percentage any more. The behavioural half was verified in a browser:
 * nudging #map's `top` to 40px gives a height of 916 on a 956 viewport, so the
 * two edges are doing the sizing; restoring `height: 100%` pins it back to 956
 * and the element hangs 40px off the bottom, `bottom` ignored.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SHELL_CSS = fs.readFileSync(path.join(ROOT, 'frontend-shell.css'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const CSS = strip(SHELL_CSS);
const APP_RULES = strip(APP).replace(/^\s*\/\/[^\n]*$/gm, '');

/** The declarations of the first rule whose selector list is exactly `sel`. */
function rule(css, sel) {
  const re = new RegExp('(^|[}\\n])\\s*' + sel.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&')
    + '\\s*\\{([^}]*)\\}', 'm');
  const m = css.match(re);
  assert.ok(m, `no rule for "${sel}"`);
  return m[2];
}

const tests = [];
const test = (n, f) => tests.push([n, f]);

test('the map is anchored to all four edges', () => {
  const body = rule(CSS, '#map');
  assert.ok(/position:\s*fixed/.test(body), '#map is no longer fixed');
  ['top', 'right', 'bottom', 'left'].forEach((side) => {
    assert.ok(new RegExp('(^|[;{\\s])' + side + '\\s*:\\s*0').test(body)
      || /inset\s*:\s*0/.test(body), `#map does not anchor ${side}`);
  });
});

test('the map is not sized by a percentage', () => {
  // This is the whole defect. A fixed element with top, height and bottom all
  // set drops `bottom`, so the percentage alone decides -- and iOS resolves it
  // against a box one status bar short of the screen it paints on.
  const body = rule(CSS, '#map');
  assert.ok(!/[^-]height\s*:/.test(';' + body),
    `#map sets a height again: "${body.trim()}"`);
  assert.ok(!/[^-]width\s*:/.test(';' + body),
    `#map sets a width again: "${body.trim()}"`);
});

test('nothing else is a fixed box sized by a viewport percentage', () => {
  // The same shape anywhere else is the same bug waiting to happen.
  const offenders = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(CSS))) {
    const body = m[2];
    if (!/position\s*:\s*fixed/.test(body)) continue;
    if (!/height\s*:\s*(100%|100vh)/.test(body)) continue;
    offenders.push(m[1].trim().replace(/\s+/g, ' ').slice(0, 60));
  }
  assert.deepStrictEqual(offenders, [],
    'fixed elements sized by a percentage height: ' + offenders.join(', '));
});

test('the weather canvas sizes against the viewport, not the page box', () => {
  // It was position: absolute, so it sized against <body> -- whose own
  // height: 100% is the same short measurement.
  const body = rule(CSS, '#wxCanvas');
  assert.ok(/position:\s*fixed/.test(body),
    'the FX canvas is back to sizing against the page box');
});

test('the page box has a real-viewport height where one exists', () => {
  assert.ok(/@supports\s*\(height:\s*100dvh\)/.test(CSS),
    'no dvh height for html/body');
  assert.ok(/html,\s*body\s*\{\s*height:\s*100%/.test(CSS),
    'the 100% fallback for browsers without dvh is gone');
});

test('viewport-fit=cover and the translucent status bar still ship', () => {
  // These two are why the page paints over the whole screen in the first place.
  // Without them the gap cannot happen -- but nor can the full-bleed map.
  assert.ok(/viewport-fit=cover/.test(INDEX), 'viewport-fit=cover is gone');
  assert.ok(/apple-mobile-web-app-status-bar-style"\s+content="black-translucent/
    .test(INDEX), 'the translucent status bar is gone');
});

test('the map is re-measured when the viewport moves under it', () => {
  // MapLibre watches its own container and needs none of this anywhere else.
  // iOS is the exception: a standalone web app launches inset below the status
  // bar and goes full-bleed a moment later, and those transitions do not
  // reliably reach a ResizeObserver.
  assert.ok(/function resizeMapToViewport/.test(APP_RULES),
    'nothing re-measures the map');
  const at = APP_RULES.indexOf('function resizeMapToViewport');
  const near = APP_RULES.slice(at, at + 1800);
  ['"resize"', '"orientationchange"', '"pageshow"', '"visibilitychange"',
    'visualViewport'].forEach((signal) => {
    assert.ok(near.includes(signal), `nothing re-measures on ${signal}`);
  });
});

test('re-measuring waits for a map to exist', () => {
  const at = APP_RULES.indexOf('function resizeMapToViewport');
  const fn = APP_RULES.slice(at, APP_RULES.indexOf('\n}', at));
  assert.ok(/mapReady/.test(fn), 'it would throw before the map is built');
  assert.ok(/typeof map\.resize/.test(fn), 'it assumes resize() exists');
});

test('the launch settle is caught without waiting for a gesture', () => {
  // Some iOS versions fire no event at all for the full-bleed transition, so a
  // driver who opens the app and does not touch it keeps the short map.
  const at = APP_RULES.indexOf('mapReady = true;');
  assert.ok(at > 0, 'mapReady is never set');
  const near = APP_RULES.slice(at, at + 600);
  assert.ok(/setTimeout/.test(near) && /resize/.test(near),
    'nothing re-measures after the first frames');
});

let failed = 0;
tests.forEach(([name, fn]) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err && err.message}`); }
});
console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);
