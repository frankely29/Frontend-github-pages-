#!/usr/bin/env node
/**
 * pickup-guard-notice.test.js — what the Save button says when it says no.
 *
 * Save has two possible answers. "+25 XP" is drawn by app.part5.js as the Trip
 * Saved card; every refusal -- no location, still cooling off, you have not
 * moved, the request failed -- is drawn by pickup-recording.feature.js as the
 * guard notice. Only one of them was ever visible.
 *
 * The notice was positioned `bottom: 110px; z-index: 2500`, numbers written
 * for the old map-first screen. Under the one-surface shell the feed sheet is
 * a frosted panel at z-index 9200 covering the lower part of the screen and
 * the dock sits at 9300 on top of it, so the notice was painted underneath
 * both: in the DOM, on screen, and invisible -- a slightly darker patch of
 * frosted glass and nothing more.
 *
 * That is why Save looked dead. A successful save arms a cooldown, so the
 * first save of a shift showed its card and every tap for the next few
 * minutes produced a message nobody could read.
 *
 * These tests run the real functions -- lifted out of the shipped files, which
 * are one big IIFE each -- against a document double, and check the layering
 * against the z-indexes actually written in feed-first.css rather than against
 * numbers copied into the test.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = (f) => path.join(__dirname, '..', f);
const FEATURE = fs.readFileSync(root('pickup-recording.feature.js'), 'utf8');
const PART5 = fs.readFileSync(root('app.part5.js'), 'utf8');
const FEED_FIRST_CSS = fs.readFileSync(root('feed-first.css'), 'utf8');

/**
 * The text of a top-level `function name(...) { ... }`.
 *
 * The body is brace-matched, but only after the parameter list is past:
 * `function f(payload = {})` and `function f({ title, message })` both open
 * and close a brace before the body starts, and matching from the first `{`
 * returns the signature and nothing else.
 */
function lift(source, name) {
  const head = source.indexOf(`function ${name}(`);
  assert.ok(head > -1, `${name} is gone`);
  let i = source.indexOf('(', head);
  let parens = 0;
  for (; i < source.length; i += 1) {
    if (source[i] === '(') parens += 1;
    else if (source[i] === ')') {
      parens -= 1;
      if (!parens) { i += 1; break; }
    }
  }
  let depth = 0;
  for (i = source.indexOf('{', i); i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (!depth) return source.slice(head, i + 1);
    }
  }
  throw new Error(`${name} has unbalanced braces`);
}

/** The text of a top-level `const NAME = ...;` up to its terminating line. */
function liftConst(source, name) {
  const head = source.indexOf(`const ${name} =`);
  assert.ok(head > -1, `${name} is gone`);
  const end = source.indexOf("].join(';');", head);
  assert.ok(end > -1, `${name} is no longer a joined list`);
  return source.slice(head, end + "].join(';');".length);
}

// ---------------------------------------------------------------- the double

/** A style object that behaves like the browser's: cssText writes through. */
function makeStyle() {
  const style = {};
  Object.defineProperty(style, 'cssText', {
    get() {
      return Object.keys(style)
        .filter((k) => k !== 'cssText')
        .map((k) => `${k}:${style[k]}`)
        .join(';');
    },
    set(text) {
      Object.keys(style).forEach((k) => { if (k !== 'cssText') delete style[k]; });
      String(text).split(';').filter(Boolean).forEach((decl) => {
        // Only split on the FIRST colon: `calc(env(...))` and `min(92vw,460px)`
        // both carry colons-free but the bottom value carries parentheses and
        // commas, and a naive split would shred it.
        const at = decl.indexOf(':');
        if (at < 0) return;
        style[decl.slice(0, at).trim()] = decl.slice(at + 1).trim();
      });
    },
    enumerable: false,
  });
  return style;
}

function makeNode(id) {
  return {
    id,
    style: makeStyle(),
    innerHTML: '',
    _children: [],
    querySelector(sel) {
      const tag = sel.replace(/[^a-z]/gi, '');
      return { textContent: '', tagName: tag.toUpperCase() };
    },
  };
}

/**
 * The guard notice's own code, running. Returns the node it puts on the page
 * plus the calls it made into the rest of the app.
 */
function runNotice({ existing = null, calls = {} } = {}) {
  const byId = existing ? { pickupGuardNotice: existing } : {};
  const appended = [];
  const document = {
    getElementById: (id) => byId[id] || null,
    createElement: (tag) => makeNode(''),
    body: { appendChild: (n) => { byId[n.id] = n; appended.push(n); } },
  };
  const seen = { layout: 0, hideCard: 0 };
  const window = {
    clearTimeout: () => {},
    setTimeout: () => 1,
    updatePickupRewardLayout: () => { seen.layout += 1; },
    hidePickupProgressReward: () => { seen.hideCard += 1; },
    ...calls,
  };
  const context = vm.createContext({ document, window, String, Number, Object });
  vm.runInContext([
    liftConst(FEATURE, 'GUARD_NOTICE_CSS'),
    lift(FEATURE, 'toSafeString'),
    lift(FEATURE, 'ensurePickupGuardNotice'),
    lift(FEATURE, 'hidePickupGuardNotice'),
    lift(FEATURE, 'showPickupGuardNotice'),
    'globalThis.__show = showPickupGuardNotice;',
    'globalThis.__hide = hidePickupGuardNotice;',
  ].join('\n'), context, { filename: 'pickup-recording.feature.js#guard-notice' });
  return {
    show: (opts) => context.__show(opts),
    hide: () => context.__hide(),
    node: () => byId.pickupGuardNotice || null,
    appended,
    seen,
  };
}

/** The highest z-index feed-first.css puts over the lower half of the screen. */
function shellCeiling() {
  const zs = [...FEED_FIRST_CSS.matchAll(/z-index:\s*(\d+)/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n));
  assert.ok(zs.length, 'feed-first.css declares no z-index at all');
  return Math.max(...zs);
}

const tests = [];
const test = (n, f) => tests.push([n, f]);

// -------------------------------------------------------------------- layer

test('the notice is drawn above everything the shell puts over the map', () => {
  const g = runNotice();
  g.show({ title: 'Save button cooling off', message: 'Wait 4m 12s.' });
  const z = Number(g.node().style['z-index']);
  const ceiling = shellCeiling();
  assert.ok(Number.isFinite(z), 'the notice has no z-index');
  assert.ok(z > ceiling,
    `the notice sits at ${z}, under the shell's ${ceiling} -- it is behind the sheet again`);
});

test('the notice does not fight the Trip Saved card for the top', () => {
  // Same slot, same event. The card is 9802; the notice goes one below so the
  // two never trade places depending on which was appended first.
  const cardZ = Number(/\.pickupProgressReward\{[^}]*z-index:(\d+)/.exec(PART5)?.[1]);
  assert.ok(Number.isFinite(cardZ), 'the Trip Saved card has lost its z-index');
  const g = runNotice();
  g.show({ title: 'Trip not saved', message: 'Drive a bit further.' });
  assert.ok(Number(g.node().style['z-index']) < cardZ,
    'the notice is now above the reward card');
});

test('the notice is parked off the same measurement as the card', () => {
  /* A hard-coded bottom is what put it behind the dock. --pickup-reward-bottom
   * is re-measured by app.part5.js on resize, rotation and every keyboard, and
   * points at the top of the bottom chrome. */
  const g = runNotice();
  g.show({ title: 'Location needed', message: 'Enable location first.' });
  const bottom = g.node().style.bottom;
  assert.ok(/var\(--pickup-reward-bottom/.test(bottom),
    `the notice is parked at a fixed "${bottom}" again`);
  assert.ok(/safe-area-inset-bottom/.test(bottom),
    'the notice ignores the home indicator');
});

test('showing the notice re-measures first', () => {
  // The dock and the sheet move on their own -- a detent drag, the drawer
  // opening -- and a notice placed off a stale number is the same bug.
  const g = runNotice();
  g.show({ title: 'Trip not saved', message: 'x' });
  assert.strictEqual(g.seen.layout, 1, 'the notice trusted a stale measurement');
});

// ------------------------------------------------------------- one answer

test('a refusal clears a reward card still on screen', () => {
  const g = runNotice();
  g.show({ title: 'Save button cooling off', message: 'Wait 4m 12s.' });
  assert.strictEqual(g.seen.hideCard, 1,
    'a refusal can land stacked on top of "Trip Saved"');
});

test('app.part5 clears the notice when the card goes up', () => {
  // The other direction, owned by the other file.
  const show = lift(PART5, 'showPickupProgressReward');
  assert.ok(/hidePickupGuardNotice/.test(show),
    'the reward card no longer dismisses a refusal underneath it');
});

test('hiding is available to the other file, and actually hides', () => {
  assert.ok(/FEATURE\.hidePickupGuardNotice\s*=/.test(FEATURE),
    'hidePickupGuardNotice is not exported, so app.part5 cannot call it');
  const g = runNotice();
  g.show({ title: 'x', message: 'y' });
  assert.notStrictEqual(g.node().style.display, 'none');
  g.hide();
  assert.strictEqual(g.node().style.display, 'none');
});

test('a notice left over from the old build is re-seated, not reused as-is', () => {
  /* A driver who has the app open through a deploy keeps the node that was
   * already in the DOM. Reusing it verbatim would leave them with the bug. */
  const stale = makeNode('pickupGuardNotice');
  stale.style.cssText = 'position:fixed;bottom:110px;z-index:2500;display:none';
  const g = runNotice({ existing: stale });
  g.show({ title: 'x', message: 'y' });
  assert.ok(/var\(--pickup-reward-bottom/.test(stale.style.bottom),
    'the stale notice is still parked at 110px behind the sheet');
  assert.ok(Number(stale.style['z-index']) > shellCeiling(),
    'the stale notice is still under the sheet');
});

// -------------------------------------------------- what the card may claim

test('a refused save is not reported as a saved one', () => {
  /* The acceptance check used to run after the reward card was fired, so a 200
   * meaning "not counting this one" still raised Trip Saved -- and since that
   * body carries no progression, the card fell back to its defaults and told a
   * level 37 driver "Level 1 / Rookie / +0 XP". */
  const send = lift(FEATURE, 'sendPickupLog');
  const accepted = send.indexOf('isPickupSaveAccepted');
  const fired = send.indexOf('handlePickupProgressionDelta');
  assert.ok(accepted > -1 && fired > -1, 'the save path has changed shape');
  assert.ok(accepted < fired,
    'the reward card is fired before anyone checks whether the trip was saved');
  assert.ok(/if \(!accepted\)[\s\S]{0,400}showPickupGuardNotice/.test(send),
    'a refused save returns silently instead of saying why');
});

test('the failure path no longer blocks the screen with alert()', () => {
  // A modal dialog waiting for a tap is the wrong thing to put in front of
  // someone driving, and it was the only failure that behaved differently.
  const send = lift(FEATURE, 'sendPickupLog');
  assert.ok(!/alert\(`Trip record failed/.test(send),
    'a failed save still throws up a blocking dialog');
  assert.ok(/showPickupGuardNotice\(\{[\s\S]{0,200}readable/.test(send),
    'a failed save no longer tells the driver anything');
});

test('the card leaves out rows it has no value for', () => {
  /* Rather than printing Level 1 / Rookie for a payload that carries no
   * progression at all. The card is the only report a driver gets; inventing
   * its numbers is worse than leaving the lines out. */
  const render = lift(PART5, 'renderPickupProgressReward');
  assert.ok(/const hasLevel = /.test(render) && /const hasXp = /.test(render),
    'the render no longer distinguishes a real value from a default');
  ['levelEl', 'rankEl', 'xpEl', 'footEl'].forEach((el) => {
    assert.ok(new RegExp(`show\\(${el},`).test(render),
      `${el} is filled unconditionally again`);
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
