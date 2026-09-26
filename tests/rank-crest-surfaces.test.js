#!/usr/bin/env node
/**
 * rank-crest-surfaces.test.js — the crest goes wherever a driver is named,
 * and the XP engine's level goes nowhere at all.
 *
 * Two things were reported together: crests should appear next to users in
 * more places, and the old level was still showing in several of them. They
 * are the same fix. Every one of these surfaces had a driver's name with
 * either nothing beside it or a number out of a thousand:
 *
 *   the feed card         "Marcus R.  LVL 445"
 *   the feed comment      "Marcus R."
 *   the battle feed       "X beat Y in dominoes (+30 XP) Lvl 445"
 *   the battles list      "Available • Level 445"
 *   the profile card      a box reading 445, labelled "Level · Warlord II"
 *
 * The ladder is thirty levels. The rank key is the one field that gives both
 * the artwork and the position, so it is the only thing any of them read --
 * which is also what makes the picture and the words unable to disagree.
 *
 * These are source-level assertions on purpose. The alternative is five
 * different DOM harnesses for five modules that each bootstrap differently,
 * and what actually regresses here is someone reaching for `.level` again.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = (f) => path.join(__dirname, '..', f);
const read = (f) => fs.readFileSync(root(f), 'utf8');

const FEED = read('feed.js');
const FEED_CSS = read('feed.css');
const PROFILE = read('profile.js');
const PART8 = read('app.part8.js');
const BATTLES = read('work-battles.js');
const BATTLES_CSS = read('work-battles.css');
const SHELL_CSS = read('frontend-shell.css');

/** Source with comments stripped: a comment naming the old bug is not the bug. */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function lift(src, signature) {
  const at = src.indexOf(signature);
  assert.ok(at > -1, `${signature} is gone`);
  const params = src.indexOf(')', at);
  let depth = 0;
  let i = src.indexOf('{', params);
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}' && !(depth -= 1)) break;
  }
  return src.slice(at, i + 1);
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// --------------------------------------------------------- the crest is there

test('the feed draws a crest beside whoever is talking', () => {
  const fn = lift(FEED, 'function appendRankTo(');
  assert.ok(/renderRankBadgeIcon\(key/.test(fn), 'the feed no longer draws the artwork');
  assert.ok(/rank\.label/.test(fn) && /rank\.band/.test(fn),
    'the feed no longer names the rank or places it on the ladder');
  /* Both a post and a comment. A comment is smaller but it is still someone
     talking, and the crest is how a reader knows who to listen to. */
  const card = lift(FEED, 'function buildCard(');
  const comment = lift(FEED, 'function buildComment(');
  assert.ok(/appendRankTo\(/.test(card), 'a post author lost their crest');
  assert.ok(/appendRankTo\(/.test(comment), 'a comment author lost their crest');
});

test('the battle feed shows who won, not just their name', () => {
  const fn = lift(PART8, 'function showBattleFeedEntry(');
  assert.ok(/renderRankBadgeIcon\(winnerKey/.test(fn),
    'the battle feed no longer draws the winner\'s crest');
  assert.ok(/winner_rank_icon_key/.test(fn),
    'the battle feed is not reading the rank key off the payload');
});

test('the challenge list shows what you are up against', () => {
  const fn = lift(BATTLES, 'function rankCrestHtml(');
  assert.ok(/renderRankBadgeIcon\(user\.rankIcon/.test(fn),
    'the battles list no longer draws a crest');
  assert.ok(/rankCrestHtml\(user\)/.test(lift(BATTLES, 'function userRowInnerHtml(')),
    'the crest is defined but never placed in a row');
});

test('every crest is sized, and none of them wears a plate', () => {
  /* The badge renderer writes its own --rank-size inline, so a surface only
     gets the size it asked for if it asserts over it. And the artwork is
     keyed to clean transparency with its own frame -- anything drawn behind
     it is the "background around the icons" that was already reported twice. */
  const rules = [
    ['the feed', FEED_CSS, '.feedRankCrest .rankBadgeIconWrap'],
    ['the battles list', BATTLES_CSS, '.workBattlesRankCrest .rankBadgeIconWrap'],
    ['the battle feed', SHELL_CSS, '.killFeedRankCrest .rankBadgeIconWrap'],
  ];
  rules.forEach(([what, css, selector]) => {
    const m = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}')
      .exec(css);
    assert.ok(m, `${what} has no crest rule`);
    assert.ok(/width:\s*\d+px\s*!important/.test(m[1]), `${what} does not assert its crest size`);
    assert.ok(/background:\s*none\s*!important/.test(m[1]), `${what} draws a plate behind the crest`);
    assert.ok(/box-shadow:\s*none\s*!important/.test(m[1]), `${what} draws a ring around the crest`);
  });
});

// ------------------------------------------------ the engine's level is gone

test('no surface reads the level field off a person', () => {
  /* `author.level`, `user.level`, `rep.level` -- all the XP engine's number,
     out of a thousand, and none of them belongs on screen. The ladder
     position comes from the rank key instead. */
  [
    ['the feed', lift(FEED, 'function appendRankTo(')],
    ['the feed card', lift(FEED, 'function buildCard(')],
    ['the battle feed', lift(PART8, 'function showBattleFeedEntry(')],
    ['the battles list', lift(BATTLES, 'function ladderLevelLabel(')],
  ].forEach(([what, src]) => {
    assert.ok(!/\b(author|user|person|payload|row)\??\.level\b/.test(code(src)),
      `${what} reads the engine's level off the person again`);
  });
});

test('nothing prints LVL any more', () => {
  /* The feed card's own spelling of it. Distinct enough to grep for, and
     distinct enough that its return would be a deliberate act. */
  assert.ok(!/LVL/.test(code(FEED)), 'LVL is back on the feed card');
  assert.ok(!/Lvl \$\{/.test(code(PART8)), 'Lvl is back on the battle feed');
});

test('the profile places a driver on the ladder, not on the XP curve', () => {
  const src = code(PROFILE);
  assert.ok(/repBand/.test(src), 'the profile no longer resolves a ladder position');
  assert.ok(/ladderLevels\(\)/.test(src),
    'the profile no longer says which of how many');
  assert.ok(!/String\(Math\.round\(level\)\)/.test(src),
    'the profile prints the engine level in the reputation box again');
  /* No key means no ladder to place them on, and the row is left out rather
     than filled with a number from the wrong scale. */
  assert.ok(/if \(repBand !== null\)/.test(src),
    'the profile shows a level row with no rank to back it');
});

test('the ladder shape is read, never restated', () => {
  /* Every time something in this codebase has hardcoded a number the ladder
     owns, it has gone stale -- the test suites, the prestige names, the
     upload error range. The profile asks the badge module. */
  const fn = lift(PROFILE, 'function ladderLevels(');
  assert.ok(/prestiges\(\)\.length \* api\.ranksPerPrestige\(\)/.test(fn),
    'the profile computes the ladder size from a literal again');
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
