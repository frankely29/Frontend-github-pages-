#!/usr/bin/env node
/**
 * map-preview.test.js — the few minutes of map an unpaid driver gets.
 *
 * The clock that matters lives in the access gate (core.py) and /me reports
 * what is left of it. This file is about the other half: that the app counts
 * down from the server's number and nobody else's, that it re-arms from that
 * number rather than restarting the preview, and that the map is actually
 * covered when the time is up.
 *
 * The preview block is cut out of the real app.part10.js and run. Anchored on
 * code, not on the comment above it: an earlier test in this repo located its
 * block by matching a comment, so rewording the comment failed the test as
 * "block not found" rather than on behaviour. The slice is asserted to contain
 * every function under test before anything runs, so a miss is loud.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PART10 = fs.readFileSync(path.join(ROOT, 'app.part10.js'), 'utf8');
const PAYWALL = fs.readFileSync(path.join(ROOT, 'subscription.paywall.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const START = 'let mapPreviewDeadline = 0;';
const END = 'if (typeof window !== "undefined") {\n  window.applyMapAccessState = applyMapAccessState;';

function previewSource() {
  const a = PART10.indexOf(START);
  assert.ok(a > 0, 'the preview clock is gone from app.part10.js');
  const b = PART10.indexOf(END, a);
  assert.ok(b > a, 'the preview clock is no longer exported where this expects');
  const block = PART10.slice(a, b);
  ['function mapPreviewGranted', 'function mapPreviewRemaining', 'function stopMapPreview',
    'function paintMapPreviewNote', 'function endMapPreview', 'function applyMapAccessState']
    .forEach((fn) => assert.ok(block.includes(fn), `the slice is missing ${fn}`));
  return block;
}

// --------------------------------------------------------------------------
// a clock we control, and the smallest DOM the block touches
// --------------------------------------------------------------------------

function load({ me = null, now = 1_000_000 } = {}) {
  const classes = new Set();
  const note = { textContent: '' };
  const locks = [];
  let clock = now;
  let nextId = 1;
  const intervals = new Map();

  const documentStub = {
    documentElement: {
      classList: {
        add: (n) => classes.add(n),
        remove: (n) => classes.delete(n),
        contains: (n) => classes.has(n),
        toggle: (n, on) => { if (on) classes.add(n); else classes.delete(n); },
      },
    },
    getElementById: (id) => (id === 'mapPreviewNote' ? note : null),
  };
  const windowStub = {
    setInterval: (fn, ms) => { const id = nextId++; intervals.set(id, { fn, ms }); return id; },
    clearInterval: (id) => { intervals.delete(id); },
  };

  const ctx = vm.createContext({
    me,
    document: documentStub,
    window: windowStub,
    Number, Math, Date: { now: () => clock },
    applyMapLockState: (on) => {
      locks.push(!!on);
      if (on) classes.add('tj-map-locked'); else classes.delete('tj-map-locked');
    },
  });

  vm.runInContext(
    previewSource() + '\nglobalThis.__api = { applyMapAccessState, mapPreviewRemaining, '
      + 'endMapPreview, stopMapPreview, mapPreviewGranted, paintMapPreviewNote };',
    ctx, { filename: 'app.part10.js#preview' });

  return {
    api: ctx.__api,
    classes,
    note,
    locks,
    setMe: (v) => { ctx.me = v; },
    advance: (seconds) => {
      clock += seconds * 1000;
      intervals.forEach((t) => t.fn());
    },
    intervalCount: () => intervals.size,
    intervalMs: () => [...intervals.values()].map((t) => t.ms),
  };
}

const lapsedMe = (seconds) => ({ subscription: { has_access: false,
  map_preview_remaining_seconds: seconds } });

const tests = [];
const test = (n, f) => tests.push([n, f]);

// --------------------------------------------------------------------------

test('a paid driver has no preview and no lock', () => {
  const env = load({ me: { subscription: { has_access: true } } });
  env.api.applyMapAccessState(false);
  assert.ok(!env.classes.has('tj-map-locked'), 'a paying driver had their map blurred');
  assert.ok(!env.classes.has('tj-map-preview'), 'a paying driver was given a countdown');
  assert.strictEqual(env.intervalCount(), 0, 'a ticker is running for someone who does not need one');
});

test('an unpaid driver with time on the clock keeps the map', () => {
  // The whole point of the preview. Locking on has_access === false alone --
  // which is what the app did before this -- meant the feature existed on the
  // server and was invisible in the app.
  const env = load({ me: lapsedMe(300) });
  env.api.applyMapAccessState(true);
  assert.ok(!env.classes.has('tj-map-locked'), 'the preview never opened');
  assert.ok(env.classes.has('tj-map-preview'), 'nothing marks the preview as running');
  assert.strictEqual(env.api.mapPreviewRemaining(), 300);
});

test('an unpaid driver with a spent clock gets the lock immediately', () => {
  const env = load({ me: lapsedMe(0) });
  env.api.applyMapAccessState(true);
  assert.ok(env.classes.has('tj-map-locked'), 'a spent preview still showed the map');
  assert.ok(!env.classes.has('tj-map-preview'), 'a countdown is running on a spent clock');
  assert.strictEqual(env.intervalCount(), 0);
});

test('the map locks when the clock runs out, not before', () => {
  const env = load({ me: lapsedMe(300) });
  env.api.applyMapAccessState(true);
  env.advance(299);
  assert.ok(!env.classes.has('tj-map-locked'), 'it locked a second early');
  assert.strictEqual(env.api.mapPreviewRemaining(), 1);
  env.advance(1);
  assert.ok(env.classes.has('tj-map-locked'), 'the preview never ended');
  assert.ok(!env.classes.has('tj-map-preview'), 'the countdown outlived the preview');
  assert.strictEqual(env.intervalCount(), 0, 'the ticker is still running after the lock');
});

test('a sleeping phone does not buy extra map', () => {
  // A single long setTimeout is throttled in a background tab and does not run
  // at all on a sleeping phone, so it fires late -- always in the driver's
  // favour. The deadline is compared against the wall clock on each tick.
  const env = load({ me: lapsedMe(300) });
  env.api.applyMapAccessState(true);
  env.advance(3600);                       // an hour asleep, one tick on waking
  assert.ok(env.classes.has('tj-map-locked'), 'an hour of sleep left the map open');
  assert.strictEqual(env.api.mapPreviewRemaining(), 0);
});

test('the clock is the server\'s, and a /me refresh re-arms from it', () => {
  // Not restarts: re-arms. The gate counts from the first map request, and this
  // has to land on the same number or the blur and the 402 drift apart.
  const env = load({ me: lapsedMe(300) });
  env.api.applyMapAccessState(true);
  env.advance(120);
  assert.strictEqual(env.api.mapPreviewRemaining(), 180);
  env.setMe(lapsedMe(180));                // what /me would now say
  env.api.applyMapAccessState(true);
  assert.strictEqual(env.api.mapPreviewRemaining(), 180, 'the preview restarted itself');
  assert.strictEqual(env.intervalCount(), 1, 'a second ticker was started');
});

test('a /me that says the preview is spent locks a running preview', () => {
  const env = load({ me: lapsedMe(300) });
  env.api.applyMapAccessState(true);
  env.setMe(lapsedMe(0));
  env.api.applyMapAccessState(true);
  assert.ok(env.classes.has('tj-map-locked'), 'the server said no and the map stayed open');
  assert.strictEqual(env.intervalCount(), 0);
});

test('subscribing mid-preview clears the lock and the countdown', () => {
  const env = load({ me: lapsedMe(300) });
  env.api.applyMapAccessState(true);
  env.api.applyMapAccessState(false);
  assert.ok(!env.classes.has('tj-map-locked'));
  assert.ok(!env.classes.has('tj-map-preview'), 'a paying driver is still being counted down');
  assert.strictEqual(env.intervalCount(), 0, 'the ticker survived the subscription');
});

test('a missing or nonsense number is treated as no preview', () => {
  // /me from an older build, a transient failure, a string where a number was
  // expected. None of those may hand out an unlimited map.
  [undefined, null, 'soon', NaN, -5, Infinity].forEach((value) => {
    const env = load({ me: { subscription: { has_access: false,
      map_preview_remaining_seconds: value } } });
    env.api.applyMapAccessState(true);
    assert.ok(env.classes.has('tj-map-locked'),
      `map_preview_remaining_seconds=${String(value)} opened the map`);
  });
});

test('ending the preview early is what a 402 does', () => {
  const env = load({ me: lapsedMe(300) });
  env.api.applyMapAccessState(true);
  env.api.endMapPreview();
  assert.ok(env.classes.has('tj-map-locked'));
  assert.strictEqual(env.intervalCount(), 0);
  assert.strictEqual(env.api.mapPreviewRemaining(), 0);
});

test('the countdown says how long is left, in minutes and seconds', () => {
  const env = load({ me: lapsedMe(305) });
  env.api.applyMapAccessState(true);
  assert.ok(/5:05/.test(env.note.textContent), env.note.textContent);
  env.advance(60);
  assert.ok(/4:05/.test(env.note.textContent), env.note.textContent);
  env.advance(240);
  assert.ok(/0:05/.test(env.note.textContent),
    `single-digit seconds lose their leading zero: ${env.note.textContent}`);
});

test('the countdown offers the way out it is warning about', () => {
  const env = load({ me: lapsedMe(300) });
  env.api.applyMapAccessState(true);
  assert.ok(/subscribe/i.test(env.note.textContent), env.note.textContent);
});

test('it ticks often enough to be a countdown', () => {
  const env = load({ me: lapsedMe(300) });
  env.api.applyMapAccessState(true);
  assert.deepStrictEqual(env.intervalMs(), [1000]);
});

// --------------------------------------------------------------------------
// the page and the paywall
// --------------------------------------------------------------------------

test('the countdown is in the markup, so no script has to build it', () => {
  const noComments = INDEX.replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(/id="mapPreviewNote"/.test(noComments), 'no countdown element ships');
});

test('the countdown does not steal the lock card\'s Subscribe button', () => {
  // subscription.paywall.js finds its checkout button with document.querySelector
  // on '[data-paywall-checkout-btn], [data-landing-subscribe]' -- ONE element,
  // the first in document order. The countdown sits above the lock card, so
  // giving it that attribute would have moved the wiring onto the countdown and
  // left the card's Subscribe button dead, on the one screen with nothing else
  // to press.
  const noComments = INDEX.replace(/<!--[\s\S]*?-->/g, '');
  const matches = noComments.match(/data-landing-subscribe/g) || [];
  assert.strictEqual(matches.length, 1,
    `${matches.length} elements claim the checkout button; querySelector picks one`);
  const at = noComments.indexOf('id="mapPreviewNote"');
  const el = noComments.slice(at - 120, at + 160);
  assert.ok(!/data-landing-subscribe|data-paywall-checkout-btn/.test(el),
    'the countdown wears the attribute the paywall module selects on');
});

test('the countdown is still a way to pay', () => {
  const rules = PART10.replace(/\/\*[\s\S]*?\*\//g, '');
  const at = rules.indexOf('#mapPreviewNote');
  assert.ok(at > 0, 'nothing in app.part10.js binds the countdown');
  const near = rules.slice(at - 400, at + 400);
  assert.ok(/triggerCheckout/.test(near), 'tapping the countdown does not lead anywhere');
});

test('the countdown is hidden by default and by the lock', () => {
  const critical = (INDEX.match(/<style id="tjBootCritical">([\s\S]*?)<\/style>/) || [])[1] || '';
  const rules = critical.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(/#mapPreviewNote\s*\{\s*display:\s*none/.test(rules),
    'the countdown shows before anyone knows whether there is a preview');
  assert.ok(/html\.tj-map-preview:not\(\.tj-map-locked\)\s+#mapPreviewNote/.test(rules),
    'the countdown and the lock card can be on screen together');
});

test('the countdown sits under the lock card', () => {
  const critical = (INDEX.match(/<style id="tjBootCritical">([\s\S]*?)<\/style>/) || [])[1] || '';
  const zOf = (sel) => {
    const at = critical.indexOf(sel);
    assert.ok(at > 0, `${sel} has no rule`);
    const m = critical.slice(at, at + 700).match(/z-index:\s*(\d+)/);
    assert.ok(m, `${sel} sets no z-index`);
    return Number(m[1]);
  };
  assert.ok(zOf('#mapPreviewNote') < zOf('#mapLockCard'),
    'the countdown can cover the card that replaces it');
});

test('the paywall goes through the preview, not straight to the lock', () => {
  // handleAuthStateChanged locking on has_access === false alone is exactly
  // what made the preview invisible. It has to ask applyMapAccessState.
  const rules = PAYWALL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const at = rules.indexOf('function handleAuthStateChanged');
  assert.ok(at > 0, 'handleAuthStateChanged is gone');
  const fn = rules.slice(at, at + 1400);
  assert.ok(/applyMapAccessState/.test(fn),
    'the paywall locks the map without consulting the preview clock');
});

test('a 402 ends the preview rather than only blurring over it', () => {
  const rules = PAYWALL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const at = rules.indexOf('function handlePaymentRequired');
  assert.ok(at > 0, 'handlePaymentRequired is gone');
  const fn = rules.slice(at, at + 900);
  assert.ok(/endMapPreview/.test(fn),
    'a 402 leaves the countdown running over a map the server will not fill');
  assert.ok(!/lockDocument|document\.body\.classList\.add\('tj-locked'\)/.test(fn),
    'a 402 still locks the whole document');
});

test('the preview never touches the feature lock', () => {
  // Five minutes of map must not be five minutes of chat.
  assert.ok(!previewSource().includes('tj-feature-locked'),
    'the preview would unlock chat for the length of it');
});

let failed = 0;
tests.forEach(([name, fn]) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err && err.message}`); }
});
console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);
