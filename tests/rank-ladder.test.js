#!/usr/bin/env node
/**
 * rank-ladder.test.js — ten prestiges of ten levels.
 *
 * The backend has always sent band_1..band_100. That is not a hundred
 * unrelated ranks, it is ten prestiges of ten levels, and band 34 means
 * prestige 4, level 4. The frontend used to throw that structure away and
 * print the address back out, so drivers saw "Band 034" on their profile,
 * "band 34" on a battles chip, and a leaderboard ladder of a hundred rows
 * built by cycling ten prefixes against ten titles -- which repeated
 * "Bronze Recruit" at band 1 and again at band 11 in a different colour.
 *
 * These tests pin the arithmetic and, more importantly, pin the rule that no
 * surface prints the key at a driver. The key is an address. The label is
 * what a person reads.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = (f) => path.join(__dirname, '..', f);
const PART5 = fs.readFileSync(root('app.part5.js'), 'utf8');
const PART3 = fs.readFileSync(root('app.part3.js'), 'utf8');
const PART4 = fs.readFileSync(root('app.part4.js'), 'utf8');
const BATTLES = fs.readFileSync(root('work-battles.js'), 'utf8');
const PROFILE = fs.readFileSync(root('profile.js'), 'utf8');
const CSS = fs.readFileSync(root('frontend-shell.css'), 'utf8');

/** Lift one function out of the big IIFE by brace matching. */
function lift(source, signature) {
  const at = source.indexOf(signature);
  assert.ok(at > -1, `${signature} is gone`);
  // Skip the parameter list first: a default like (band = {}) carries a brace
  // that would otherwise be mistaken for the body's opening one.
  const params = source.indexOf(')', at);
  let depth = 0;
  let i = source.indexOf('{', params);
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && !(depth -= 1)) break;
  }
  return source.slice(at, i + 1);
}

/** The ladder arithmetic, with just enough of its table to run. */
/* The numerals and the ladder's shape, lifted from the source rather than
 * restated here. A test that hardcodes "five ranks" passes happily while the
 * code says something else; this one cannot. */
function shapeConstants(src) {
  const from = src.indexOf('var RANK_ROMAN = [');
  const to = src.indexOf('function rankFromBand(');
  assert.ok(from > -1 && to > from, 'the ladder constants moved');
  return src.slice(from, to);
}

function loadRank() {
  const from = PART5.indexOf('var RANK_TIERS = [');
  const to = PART5.indexOf('var RANK_PLATES = [');
  assert.ok(from > -1 && to > from, 'the tier table moved');
  const context = vm.createContext({ Math, Number, String });
  vm.runInContext(
    `${PART5.slice(from, to)}
     ${shapeConstants(PART5)}
     function resolveRankIconBand(k){
       var m = String(k||'').match(/^band_(\\d{1,4})$/);
       return m ? Math.max(1, Math.min(RANK_BAND_COUNT, Number(m[1]))) : 1;
     }
     ${lift(PART5, 'function rankFromBand(')}
     ${lift(PART5, 'function rankFromKey(')}
     ${lift(PART5, 'function rankDisplayName(')}
     globalThis.fromBand = rankFromBand;
     globalThis.fromKey = rankFromKey;
     globalThis.displayName = rankDisplayName;
     globalThis.tiers = RANK_TIERS;`,
    context, { filename: 'app.part5.js#rank' });
  return context;
}

const tests = [];
const test = (n, f) => tests.push([n, f]);

// ------------------------------------------------------------ the arithmetic

test('a band is a prestige and a rank', () => {
  /* Ten prestiges of five. Band 5 is the last rank of prestige 1 and band 6
     is the first of prestige 2 -- that roll-over is the shape of the ladder,
     so it is the case worth pinning. */
  const { fromBand } = loadRank();
  const cases = [
    [1, 1, 1, 'I'], [5, 1, 5, 'V'],
    [6, 2, 1, 'I'], [7, 2, 2, 'II'],
    [34, 7, 4, 'IV'], [46, 10, 1, 'I'], [50, 10, 5, 'V'],
  ];
  cases.forEach(([band, prestige, level, roman]) => {
    const r = fromBand(band);
    assert.strictEqual(r.prestige, prestige, `band ${band} prestige`);
    assert.strictEqual(r.level, level, `band ${band} level`);
    assert.strictEqual(r.roman, roman, `band ${band} numeral`);
  });
});

test('every one of the fifty lands inside the ladder', () => {
  const { fromBand, tiers } = loadRank();
  const labels = new Set();
  for (let band = 1; band <= 50; band += 1) {
    const r = fromBand(band);
    assert.ok(r.prestige >= 1 && r.prestige <= 10, `band ${band} left the ladder`);
    assert.ok(r.level >= 1 && r.level <= 5, `band ${band} has rank ${r.level}`);
    assert.strictEqual(r.name, tiers[r.prestigeIndex].name);
    labels.add(r.label);
  }
  assert.strictEqual(labels.size, 50, 'two bands share a label');
});

test('the ladder covers every prestige exactly five times', () => {
  const { fromBand } = loadRank();
  const perPrestige = new Map();
  for (let band = 1; band <= 50; band += 1) {
    const p = fromBand(band).prestige;
    perPrestige.set(p, (perPrestige.get(p) || 0) + 1);
  }
  assert.strictEqual(perPrestige.size, 10, 'not ten prestiges');
  perPrestige.forEach((count, prestige) => {
    assert.strictEqual(count, 5, `prestige ${prestige} has ${count} ranks`);
  });
});

test('garbage lands on the ends rather than off them', () => {
  const { fromBand } = loadRank();
  [[0, 1], [-5, 1], [51, 50], [101, 50], [99999, 50], [NaN, 1], ['', 1]].forEach(([input, band]) => {
    assert.strictEqual(fromBand(input).band, band, `${String(input)} clamped wrong`);
  });
});

test('band_250 clamps to the top badge, not past the end of the table', () => {
  /* resolveRankIconBand used to clamp at 1000, which is the old level ceiling
   * rather than the band ceiling. A payload of band_250 then indexed past
   * RANK_TIERS and the badge threw. It is read from RANK_BAND_COUNT now, so
   * reshaping the ladder cannot leave this behind. */
  assert.ok(/Math\.min\(RANK_BAND_COUNT, value\)/.test(PART5),
    'the band clamp is a literal again rather than RANK_BAND_COUNT');
  assert.ok(!/Math\.min\(1000,/.test(
    PART5.slice(PART5.indexOf('function resolveRankIconBand'),
                PART5.indexOf('function resolveRankIconTone'))),
    'the 1000-level clamp is still in resolveRankIconBand');
});

// ------------------------------------------------- never show a driver a key

test('a rank_name that is really the key falls through to the label', () => {
  const { displayName } = loadRank();
  ['Band 034', 'band_34', 'BAND 4', 'band-34', '', '   '].forEach((raw) => {
    const out = displayName({ rank_name: raw, rank_icon_key: 'band_34' });
    assert.strictEqual(out, 'Sapphire IV', `"${raw}" was shown to a driver as-is`);
  });
});

test('a real rank_name from the backend is kept', () => {
  const { displayName } = loadRank();
  assert.strictEqual(
    displayName({ rank_name: 'Road Legend', rank_icon_key: 'band_34' }),
    'Road Legend',
    'the backend can no longer name a rank');
});

test('no surface prints the raw key at a driver', () => {
  /* work-battles rendered the key with underscores swapped for spaces, so a
   * Gold IV driver wore a chip reading "band 34". If that ever comes back it
   * comes back looking exactly like this. */
  assert.ok(!/rankIcon\)\.replace\(\/\[_-\]\+\/g, ' '\)/.test(
    BATTLES.slice(BATTLES.indexOf('function renderAvatar'))),
    'renderAvatar is printing the rank key again');
  assert.ok(/TeamJoseoRank/.test(BATTLES), 'battles no longer resolves a label');
  assert.ok(/TeamJoseoRank/.test(PROFILE), 'profile no longer resolves a label');
  assert.ok(/band\[\\s_-\]\*\\d\+/.test(PROFILE),
    'profile no longer guards against a key-shaped rank_name');
});

// ------------------------------------------------------- the division numeral

test('the numeral is struck on a measured plate, not a guessed one', () => {
  const from = PART5.indexOf('var RANK_PLATES = [');
  const to = PART5.indexOf('];', from);
  assert.ok(from > -1, 'the plate table is gone');
  const rows = PART5.slice(from, to).match(/\[[\d.,\s]+\]/g) || [];
  assert.strictEqual(rows.length, 10, 'there is not one plate per prestige');
  rows.forEach((row, i) => {
    const [x, y, w, h] = row.replace(/[[\]]/g, '').split(',').map(Number);
    assert.ok(x > 0.2 && x < 0.5, `tier ${i + 1} plate x is off the badge`);
    assert.ok(y > 0.6 && y < 0.9, `tier ${i + 1} plate y is not in the lower third`);
    assert.ok(w > 0.15 && w < 0.5, `tier ${i + 1} plate is ${w} wide`);
    assert.ok(h > 0.02 && h < 0.2, `tier ${i + 1} plate is ${h} tall`);
    assert.ok(x + w <= 1 && y + h <= 1, `tier ${i + 1} plate runs off the image`);
  });
});

test('the numeral is left off below the size it can be read at', () => {
  /* Measured on the real art: at 52 device pixels a numeral on the plate is a
   * smudge, and a smudge on every badge reads as dirt rather than as
   * information. The feed spells the division out in text instead. */
  const render = lift(PART5, 'function renderRankBadgeIcon(');
  assert.ok(/size >= 60/.test(render), 'the small-size guard is gone');
  assert.ok(/rankBadgeDivision/.test(render), 'the numeral is no longer drawn');
  assert.ok(/plate &&/.test(render),
    'a tier with no measured plate would now get a numeral anyway');
});

test('the numeral is sized from its own plate', () => {
  /* The plates differ by a third in width across the ten, and VIII is four
   * glyphs where I is one. One font size for all of them overflows the
   * narrowest badge. */
  const render = lift(PART5, 'function renderRankBadgeIcon(');
  assert.ok(/plate\[3\] \* size/.test(render),
    'the numeral no longer scales with the plate');
  assert.ok(/plate\[2\] \* 100/.test(render),
    'the numeral box no longer takes the plate width');
});

// ------------------------------------------------------------ the leaderboard

test('the ladder is ten prestiges, not a hundred bands', () => {
  const build = lift(PART3, 'function createRankLadderFallback(');
  assert.ok(/prestiges\(\)/.test(build), 'the ladder no longer asks for prestiges');
  assert.ok(!/RANK_LADDER_BAND_PREFIXES/.test(PART3),
    'the cycling prefix/title table is back');
  assert.ok(!/RANK_LADDER_MAX_LEVEL/.test(PART3),
    'the 1000-level ceiling is back');
  const names = (PART3.match(/'Iron', 'Bronze', 'Steel', 'Gold', 'Crimson'/) || []).length;
  assert.strictEqual(names, 1, 'the offline prestige roster is gone');
});

test('the fallback ladder is built lazily, after the badge module loads', () => {
  /* It used to be a const evaluated at file scope. Now that the roster comes
   * from window.TeamJoseoRank, evaluating it at load time would capture the
   * moment before app.part5 has run and freeze the offline names in. */
  assert.ok(!/const RANK_LADDER_FALLBACK/.test(PART3),
    'the ladder is a load-time const again');
  const calls = (PART3.match(/createRankLadderFallback\(\)/g) || []).length;
  assert.ok(calls >= 4, `only ${calls} call sites rebuild the ladder`);
});

test('the driver\'s own prestige is findable in a list of ten', () => {
  const view = lift(PART3, 'function renderRankLadderView(');
  assert.ok(/isCurrent/.test(view), 'the current row is no longer marked');
  assert.ok(/leaderboardRankPips/.test(view), 'the level pips are gone');
  assert.ok(/length: ranksPerPrestige\(\)/.test(view),
    'the pips are no longer one per rank in the prestige');
  assert.ok(!/RANK_BAND_SIZE\b/.test(view),
    'the pip count is a hardcoded constant again rather than the ladder shape');
  assert.ok(/\.leaderboardRankLadderRow\.current/.test(CSS),
    'the current row has no style, so it is not findable');
});

test('the leaderboard ladder has styles at all', () => {
  /* The markup shipped without a stylesheet: every one of these classes was
   * rendering as an unstyled div. */
  ['.leaderboardRanksWrap', '.leaderboardRankLadderRow', '.leaderboardRankLadderIcon',
   '.leaderboardRankLadderTitle', '.leaderboardRankLadderRange',
   '.leaderboardRankLadderChip', '.leaderboardRankPips', '.leaderboardTierLine',
   '.leaderboardRankName'].forEach((cls) => {
    assert.ok(CSS.includes(cls), `${cls} has no rule`);
  });
});

test('a leaderboard row spells the division out, because its badge is 26px', () => {
  const line = lift(PART3, 'function levelTitleLine(');
  assert.ok(/safeRankName\(title, rankIconKey\)/.test(line),
    'the row title no longer resolves the label from the key');
});

test('the games list names the prestige beside the level', () => {
  const fn = lift(PART4, 'function gamesUserRankLine(');
  assert.ok(/TeamJoseoRank/.test(fn), 'the games list no longer resolves a label');
  assert.ok(/Level \$\{Math\.floor\(level\)\}/.test(fn), 'the level is gone');
  assert.ok(/return hasLevel \? `Level/.test(fn),
    'there is no fallback for a build without the badge module');
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
