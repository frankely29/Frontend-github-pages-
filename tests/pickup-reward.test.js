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

/**
 * The text of a top-level `function name(...) { ... }`.
 *
 * The body is brace-matched, but only once the parameter list is past:
 * `function f(progression = {})` opens and closes a brace before the body
 * starts, and matching from the first `{` returns the signature alone.
 */
function lift(name) {
  const head = SOURCE.indexOf(`function ${name}(`);
  assert.ok(head > -1, `${name} is gone from app.part5.js`);
  let i = SOURCE.indexOf('(', head);
  let parens = 0;
  for (; i < SOURCE.length; i += 1) {
    if (SOURCE[i] === '(') parens += 1;
    else if (SOURCE[i] === ')') {
      parens -= 1;
      if (!parens) { i += 1; break; }
    }
  }
  let depth = 0;
  for (i = SOURCE.indexOf('{', i); i < SOURCE.length; i += 1) {
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

// ------------------------------------------------ what the card is made of
//
// Three things made the reward read as cheap, and all three are measurable.

test('the card is set in the app\'s own typeface', () => {
  /* Nothing in this app sets font-family on body -- every other surface
   * declares its own font shorthand, and this card never did. So the one
   * moment a driver is congratulated rendered in the browser's default serif.
   * Measured in Chromium on the shipped files: every line of it, kicker
   * through footer, came back "Times New Roman" while the feed six pixels
   * below was system-ui. */
  const root = /\.pickupProgressReward\{([^}]*)\}/.exec(SOURCE);
  assert.ok(root, 'the card has no root rule any more');
  assert.ok(/font-family:\s*system-ui/.test(root[1]),
    'the reward is back in the browser default serif');
});

test('the card is an object, not a smear', () => {
  /* The old gradient ended on rgba(30,64,175,.44): the bottom of the card was
   * 56% see-through, so the level, the rank and the footer sat on a wash of
   * whatever was behind -- usually the feed sheet, since the card straddles
   * its top edge. */
  const card = /\.pickupProgressRewardCard\{([^}]*)\}/.exec(SOURCE);
  assert.ok(card, 'the card body has no rule any more');
  const bg = /background:([^;]*)/.exec(card[1]);
  assert.ok(bg, 'the card has no background');
  const alphas = [...bg[1].matchAll(/rgba\([^)]*?,\s*([0-9.]+)\s*\)/g)]
    .map((m) => Number(m[1]));
  assert.ok(alphas.every((a) => a >= 0.99),
    `the card ground is still see-through: ${alphas.join(', ')}`);
});

test('the bar shows what the trip added, not the whole level', () => {
  /* It used to run 0 -> total every time, so a driver who earned 20 XP watched
   * the same sweep as one who earned 200 and the trip's own contribution was
   * shown precisely nowhere. */
  const context = vm.createContext({ Number, Math });
  vm.runInContext([
    lift('computeProgressRatio'),
    lift('computePreviousRatio'),
    'globalThis.prev = computePreviousRatio;',
    'globalThis.now = computeProgressRatio;',
  ].join('\n'), context, { filename: 'app.part5.js#previous-ratio' });

  // The driver from the photo: 9225 of a level that runs 9000 to 9600, +20.
  const p = { level: 37, total_xp: 9225, current_level_xp: 9000,
    next_level_xp: 9600, xp_to_next_level: 375 };
  assert.strictEqual(Math.round(context.now(p) * 100), 38, 'where they are now');
  assert.strictEqual(Math.round(context.prev(p, 20) * 100), 34,
    'where they were before the trip');

  // A trip that crossed a level leaves a negative difference. The honest
  // answer is "you started this level empty", not a bar running backwards.
  const crossed = { level: 38, total_xp: 9610, current_level_xp: 9600,
    next_level_xp: 10300 };
  assert.strictEqual(context.prev(crossed, 400), 0, 'the bar ran off the left');

  // No XP reported, or no level span to measure against: nothing grows.
  assert.strictEqual(context.prev(p, 0), context.now(p));
  assert.strictEqual(context.prev({ level: 9 }, 25), context.now({ level: 9 }));
});

test('the number climbs, and stops climbing for anyone who asked it not to', () => {
  const body = lift('countUpReward');
  assert.ok(/requestAnimationFrame/.test(body), 'the XP is printed, not counted');
  assert.ok(/prefers-reduced-motion/.test(body),
    'it animates for a driver who turned animation off');
  assert.ok(/cancelAnimationFrame/.test(body),
    'two saves in a row leave two counters running at once');
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
