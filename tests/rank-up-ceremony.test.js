#!/usr/bin/env node
/**
 * rank-up-ceremony.test.js — the rare event has to look rare.
 *
 * A driver levels up as many as a thousand times. They cross into a new RANK
 * thirty times, and into a new PRESTIGE nine. Until this shipped, all three
 * wore the same blue "Promotion Unlocked" card: the rarest moment in the game
 * was dressed exactly like the most common one, and the painted crest that
 * had just been unlocked -- one of only thirty -- went past at 74px in the
 * corner of a landscape card.
 *
 * These tests pin the two things that make that true, and that a later edit
 * would flatten without noticing:
 *
 *   1. The two events are TOLD APART, and told apart by asking the payload
 *      which rank a level belongs to rather than by recomputing the ladder's
 *      arithmetic in the client. Every single time something here has
 *      restated a number the ladder owns, it has gone stale.
 *   2. They are SHOWN APART -- a different structure, not a recolour.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'app.part5.js'), 'utf8');

/** Lift one function out of the big IIFE by brace matching. */
function lift(signature) {
  const at = SOURCE.indexOf(signature);
  assert.ok(at > -1, `${signature} is gone`);
  const params = SOURCE.indexOf(')', at);
  let depth = 0;
  let i = SOURCE.indexOf('{', params);
  for (; i < SOURCE.length; i += 1) {
    if (SOURCE[i] === '{') depth += 1;
    else if (SOURCE[i] === '}' && !(depth -= 1)) break;
  }
  return SOURCE.slice(at, i + 1);
}

/** The injected <style> block, where the ceremony's rules live. */
function injectedCss() {
  const at = SOURCE.indexOf('style.textContent = `');
  assert.ok(at > -1, 'the injected style block is gone');
  const from = at + 'style.textContent = `'.length;
  return SOURCE.slice(from, SOURCE.indexOf('`;', from));
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ------------------------------------------------- telling the two apart

function loadKind() {
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(lift('function progressionRewardKind('), sandbox);
  return sandbox.progressionRewardKind;
}

test('a new rank is not just another level', () => {
  const kind = loadKind();
  assert.strictEqual(
    kind({ level: 429, rank_icon_key: 'band_013' }, { level: 430, rank_icon_key: 'band_014' }),
    'rank',
    'crossing into a new rank still reports an ordinary level-up');
  assert.strictEqual(
    kind({ level: 431, rank_icon_key: 'band_014' }, { level: 432, rank_icon_key: 'band_014' }),
    'level',
    'a level inside the same rank now claims to be a rank-up');
});

test('nothing is celebrated when nothing was gained', () => {
  const kind = loadKind();
  assert.strictEqual(kind({ level: 430, rank_icon_key: 'band_014' },
    { level: 430, rank_icon_key: 'band_014' }), 'none');
  /* A level that went DOWN is not a promotion. It should not happen, but a
     stale cache and a fresh payload can disagree, and the answer to that is
     silence rather than a ceremony for a demotion. */
  assert.strictEqual(kind({ level: 430, rank_icon_key: 'band_014' },
    { level: 420, rank_icon_key: 'band_013' }), 'none');
});

test('a first sync does not invent a rank-up', () => {
  /* Nobody has a stored rank key the first time this runs after the feature
     ships. The level really did go up, so a level-up is honest; claiming the
     driver just crossed into a new rank would be making it up. */
  const kind = loadKind();
  assert.strictEqual(
    kind({ level: 429, rank_icon_key: null }, { level: 430, rank_icon_key: 'band_014' }),
    'level',
    'a missing stored rank is being read as a rank change');
  assert.strictEqual(
    kind({ level: 429, rank_icon_key: 'band_013' }, { level: 430, rank_icon_key: '' }),
    'level',
    'a missing incoming rank is being read as a rank change');
});

test('the rank a driver wore is remembered, not recomputed', () => {
  /* Turning a level into a band means restating the ladder's arithmetic --
     thirty bands over a thousand levels, the last absorbing the remainder --
     in the client. That is the mistake this codebase has now made three
     times. The server already says which rank a level is; the client's only
     job is to remember the last answer. */
  const write = lift('function writeStoredProgressionRankKey(');
  const read = lift('function readStoredProgressionRankKey(');
  assert.ok(/rank_icon_key|rankIconKey/.test(write), 'the stored value is not the rank key');
  assert.ok(/localStorage/.test(write) && /localStorage/.test(read));
  const kindFn = lift('function progressionRewardKind(');
  assert.ok(!/LEVELS_PER|MAX_LEVEL|\/\s*30|Math\.floor\(\s*\(/.test(kindFn),
    'the reward decision is deriving a band from a level again');
});

// ------------------------------------------------- showing the two apart

test('the ceremony is its own overlay, not a recoloured level-up', () => {
  const show = lift('function showRankUpOverlay(');
  assert.ok(/rankUpOverlayRoot/.test(lift('function ensureRankUpOverlay(')),
    'the rank-up has no root of its own');
  assert.ok(!/levelUpOverlayCard/.test(show),
    'the rank-up is rendering into the level-up card');
  const css = injectedCss();
  assert.ok(/#rankUpOverlayRoot/.test(css), 'the ceremony has no styles');
  /* Portrait, not landscape: the crest is the subject here, and that is the
     structural difference a driver reads before any of the words. */
  assert.ok(/\.rankUpOverlayCard\{[^}]*flex-direction:column/.test(css),
    'the ceremony card is laid out like the level-up card again');
  const crest = /\.rankUpOverlayCard \.rankBadgeIconWrap\{[^}]*width:(\d+)px/.exec(css);
  assert.ok(crest, 'the ceremony does not size the crest');
  assert.ok(Number(crest[1]) >= 110,
    `the crest is back down to ${crest[1]}px, where the artwork stops reading`);
});

test('the ceremony holds longer than a level-up', () => {
  /* Thirty crests were painted so a driver would look at them. Four seconds
     is the time a routine notice gets. */
  const rankMs = Number(/rankUpOverlayHideTimer = window\.setTimeout\([\s\S]*?\}, (\d+)\)/
    .exec(lift('function showRankUpOverlay('))[1]);
  const levelMs = Number(/levelUpOverlayHideTimer = window\.setTimeout\([\s\S]*?\}, (\d+)\)/
    .exec(lift('function showLevelUpOverlay('))[1]);
  assert.ok(rankMs > levelMs,
    `the ceremony holds ${rankMs}ms, no longer than the level-up's ${levelMs}ms`);
});

test('a new prestige says so', () => {
  /* Warlord III -> Colossus I brings a creature the driver has never worn.
     Calling that "Rank Up" undersells the rarest thing in the game. */
  const show = lift('function showRankUpOverlay(');
  assert.ok(/fromRank\.prestige !== rank\.prestige/.test(show),
    'a prestige change is no longer detected');
  assert.ok(/New Prestige/.test(show) && /Rank Up/.test(show),
    'the two are no longer named differently');
});

test('nothing is drawn around the crest', () => {
  /* The crests are keyed to clean transparency, and anything painted behind
     one throws that away. A zero-offset drop-shadow is a HALO, not light: at
     any real radius it reads as a panel the shield is sitting on, and the
     moment an ancestor bounds it -- a card with overflow hidden, a capture
     at the wrap's edge -- it cuts into a hard square and the crest looks
     like it shipped with its backdrop attached. That is exactly what was
     reported.
     A shadow is allowed; it must be offset and it must be dark. */
  const css = injectedCss();
  const rule = /\.rankUpOverlayCard \.rankBadgeFrame\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'the ceremony crest rule is gone');
  const filter = rule[1];
  assert.ok(/drop-shadow/.test(filter), 'the crest has no shadow at all');
  assert.ok(!/drop-shadow\(\s*0\s+0\s/.test(filter),
    'a zero-offset halo is back behind the crest');
  assert.ok(!/drop-shadow\([^)]*rgba\(2\s*1\s*4/.test(filter.replace(/,/g, ' ')),
    'the gold halo is back behind the crest');

  /* And it stays a drop-shadow on the artwork rather than a box-shadow on
     its wrap: .rankBadgePainted clears box-shadow with !important so one
     would silently never render, and a box-shadow outlines the bounding
     RECTANGLE -- the square being removed here. */
  assert.ok(!/\.rankUpOverlayCard \.rankBadgeIconWrap\{[^}]*box-shadow/.test(css),
    'the shadow is a box-shadow again, which .rankBadgePainted throws away');
  assert.ok(/\.rankBadgeIconWrap\.rankBadgePainted\{[^}]*box-shadow:none!important/.test(css),
    'the rule this depends on is gone -- recheck the shadow');
  assert.ok(/\.rankBadgeIconWrap\.rankBadgePainted\{[^}]*background:none!important/.test(css),
    'a painted crest can carry its tone plate again, which is a coloured disc '
    + 'behind artwork that already has its own frame');
});

test('a driver who asked for less motion still gets the reward', () => {
  /* Reduced motion means hold it still, not take it away. */
  const css = injectedCss();
  const at = css.indexOf('prefers-reduced-motion');
  assert.ok(at > -1, 'the ceremony ignores prefers-reduced-motion');
  const block = css.slice(at, css.indexOf('}\n', css.indexOf('{', at)) + 400);
  assert.ok(/rankUpRays\{animation:none/.test(block.replace(/\s/g, '')) ||
    /animation:none/.test(block), 'the animations are not stilled');
  assert.ok(!/#rankUpOverlayRoot\.open\{display:none/.test(css),
    'reduced motion hides the ceremony instead of stilling it');
});

// ------------------------------------------------- both call sites choose

test('every path that can promote picks one card, never both', () => {
  /* A driver crossing into Colossus I also gained a level. Firing both means
     the small card lands on top of the big one and covers the milestone. */
  const sync = lift('async function syncMyProgression(');
  assert.ok(/progressionRewardKind\(/.test(sync),
    'the periodic sync no longer asks which kind of promotion this was');
  assert.ok(/kind === 'rank'/.test(sync) && /else if \(kind === 'level'\)/.test(sync),
    'the periodic sync can fire both overlays');

  const pickup = lift('function handlePickupProgressionDelta(');
  assert.ok(/showRankUpOverlay\(/.test(pickup),
    'finishing a trip can no longer produce a rank-up');
  assert.ok(/crossedRank \? *$|if \(crossedRank\)/m.test(pickup) || /crossedRank/.test(pickup),
    'the trip path does not distinguish a rank crossing');
  assert.ok(/} else {[\s\S]*showLevelUpOverlay\(/.test(pickup),
    'the trip path can fire both overlays');
});

test('the trip path reads the old rank before it overwrites it', () => {
  /* The write and the read are three lines apart in the same function. Get
     the order wrong and the "previous" rank is the new one, every crossing
     compares equal, and the ceremony never fires again -- silently. */
  const pickup = lift('function handlePickupProgressionDelta(');
  const read = pickup.indexOf('readStoredProgressionRankKey(');
  const write = pickup.indexOf('writeStoredProgressionRankKey(');
  assert.ok(read > -1 && write > -1, 'the trip path no longer tracks the rank key');
  assert.ok(read < write,
    'the stored rank is overwritten before it is read, so no crossing can ever be seen');
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
