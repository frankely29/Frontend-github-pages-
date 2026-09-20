#!/usr/bin/env node
/**
 * pickup-reward.test.js — where the Trip Saved card is placed.
 *
 * The card is the only thing that tells a driver a save landed, and it was
 * being positioned off the top of the screen, so a save looked like nothing.
 *
 * updatePickupRewardLayout() measures the cluster of chrome at the bottom of
 * the screen and parks the card above it. The bug was that it measured
 * elements that are not rendered: a display:none node reports a rect of all
 * zeros, zero is a finite top, so the hidden time machine became "the highest
 * thing on screen" and the card was pushed a whole viewport upward.
 *
 * The function is not exported -- app.part5.js is one big IIFE -- so it is
 * lifted out by brace matching and run against a document double. That is
 * worth the trouble here: the bug was in the arithmetic, and only arithmetic
 * proves it fixed.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'app.part5.js'), 'utf8');

/** The text of a top-level `function name() { ... }`, braces balanced. */
function lift(name) {
  const head = SOURCE.indexOf(`function ${name}(`);
  assert.ok(head > -1, `${name} is gone from app.part5.js`);
  let i = SOURCE.indexOf('{', head);
  let depth = 0;
  for (; i < SOURCE.length; i += 1) {
    const ch = SOURCE[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (!depth) return SOURCE.slice(head, i + 1);
    }
  }
  throw new Error(`${name} has unbalanced braces`);
}

const VIEWPORT = 956;

/** A rect as the browser reports it. A hidden element is all zeros. */
function rect(top, { hidden = false } = {}) {
  if (hidden) return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
  return { top, bottom: top + 74, left: 0, right: 440, width: 440, height: 74 };
}

/**
 * Run the real function against a page where each selector maps to a rect.
 * Returns the px the card is told to sit above the bottom edge.
 */
function place(nodes, { drawers = [] } = {}) {
  const make = (r) => ({ getBoundingClientRect: () => r });
  const props = {};
  const documentElement = {
    style: { setProperty: (k, v) => { props[k] = v; } },
  };
  const document = {
    documentElement,
    querySelector: (sel) => (sel in nodes ? make(nodes[sel]) : null),
    querySelectorAll: () => drawers.map(make),
  };
  const window = { visualViewport: { height: VIEWPORT }, innerHeight: VIEWPORT };
  const context = vm.createContext({ document, window, Number, Math });
  vm.runInContext(`${lift('updatePickupRewardLayout')}\nupdatePickupRewardLayout();`,
    context, { filename: 'app.part5.js#updatePickupRewardLayout' });
  return { bottom: Number(String(props['--pickup-reward-bottom']).replace('px', '')) };
}

const tests = [];
const test = (n, f) => tests.push([n, f]);

// The dock as a phone actually reports it: 74px tall, ending at the bottom.
const DOCK_TOP = 862;

test('a hidden element contributes no position', () => {
  /* #sliderWrap is the time machine. shell-no-scrubber hides it from every
   * driver and feed-first hides it again, so on a driver's phone it is
   * display:none -- and display:none reports top 0.
   *
   * Before the fix this returned 984 on a 956 screen: the card was placed 984px
   * above the bottom edge, which is 28px above the top of the phone, and every
   * pixel of it was off screen. */
  const { bottom } = place({
    '#dock': rect(DOCK_TOP),
    '#sliderWrap': rect(0, { hidden: true }),
    '#pickupFab': rect(DOCK_TOP),
  });
  assert.ok(bottom < VIEWPORT,
    `the card is placed ${bottom}px up on a ${VIEWPORT}px screen, which is off it`);
  assert.strictEqual(bottom, 240,
    'with only the dock on screen the card should sit at its floor');
});

test('a visible element still counts', () => {
  // The guard must not throw the measurement away entirely -- an operator does
  // see the scrubber, and the card has to clear it.
  const SCRUBBER_TOP = 700;
  const { bottom } = place({
    '#dock': rect(DOCK_TOP),
    '#sliderWrap': rect(SCRUBBER_TOP),
    '#pickupFab': rect(DOCK_TOP),
  });
  assert.strictEqual(bottom, (VIEWPORT - SCRUBBER_TOP) + 28,
    'the card no longer clears the scrubber it is meant to sit above');
});

test('an open sheet is cleared, and the card stays on screen', () => {
  // The feed sheet at its expanded detent starts at 39% of the screen. The
  // card has to be placed above that and still be somewhere a phone can draw.
  const { bottom } = place({
    '#dock': rect(DOCK_TOP),
    '#pickupFab': rect(DOCK_TOP),
  }, { drawers: [rect(373)] });
  assert.strictEqual(bottom, (VIEWPORT - 373) + 28);
  assert.ok(bottom < VIEWPORT, 'the card is off the top of the screen again');
});

test('nothing measurable falls back to the floor rather than to zero', () => {
  // Every node hidden, which is what a locked driver's screen looks like.
  const { bottom } = place({
    '#dock': rect(0, { hidden: true }),
    '#sliderWrap': rect(0, { hidden: true }),
    '#pickupFab': rect(0, { hidden: true }),
  });
  assert.strictEqual(bottom, 240, 'with nothing on screen the floor is the answer');
});

test('the guard is a size check, not a display lookup', () => {
  /* getComputedStyle is not available on every node this runs against and says
   * nothing about a node inside a collapsed parent. An empty rect is the thing
   * that actually means "not laid out". */
  const body = lift('updatePickupRewardLayout');
  assert.ok(/!rect\.width && !rect\.height/.test(body),
    'the unrendered check is gone or changed shape');
  assert.ok(!/getComputedStyle/.test(body),
    'it asks the style system instead of measuring');
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
