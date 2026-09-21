#!/usr/bin/env node
/**
 * rank-badges.test.js — the 100-rank ladder.
 *
 * The badge system was always built for a hundred: the backend sends
 * band_1..band_100 and the frontend splits that into ten frames by ten marks.
 * What was wrong was the art. The colour came from
 *
 *     hue = ((band - 1) * 17) % 360
 *
 * a rainbow that cycles five times across the ladder, so band 90 was no more
 * impressive than band 10 -- just a different hue. And every tier carried the
 * same amount of stuff, so there was nothing to climb toward.
 *
 * Now each tier adds a PART and keeps everything below it: a bar, studs, a
 * laurel, wings, a gem, spikes, a crown, rays, a halo. The tests that matter
 * are the ones about that climb, because it is the thing a driver feels and
 * the first thing a later edit would flatten without noticing.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'app.part5.js'), 'utf8');

/** The badge tables and their renderer, lifted out of the one big IIFE. */
function load() {
  const from = SOURCE.indexOf('var RANK_TIERS = [');
  assert.ok(from > -1, 'the tier table is gone from app.part5.js');
  const head = SOURCE.indexOf('function rankBadgeSvg(', from);
  assert.ok(head > -1, 'the badge renderer is gone');
  let depth = 0;
  let i = SOURCE.indexOf('{', SOURCE.indexOf(')', head));
  for (; i < SOURCE.length; i += 1) {
    if (SOURCE[i] === '{') depth += 1;
    else if (SOURCE[i] === '}') {
      depth -= 1;
      if (!depth) break;
    }
  }
  const context = vm.createContext({ Math, Number, String });
  vm.runInContext(`${SOURCE.slice(from, i + 1)}
    globalThis.svg = rankBadgeSvg;
    globalThis.tiers = RANK_TIERS;
    globalThis.parts = PARTS;
    globalThis.frames = FRAMES;
    globalThis.emblems = EMBLEMS;`, context, { filename: 'app.part5.js#badges' });
  return context;
}

const tests = [];
const test = (n, f) => tests.push([n, f]);

test('there are a hundred of them, and no two are the same', () => {
  const ctx = load();
  const seen = new Map();
  for (let band = 1; band <= 100; band += 1) {
    const svg = ctx.svg(band, 68);
    assert.ok(svg.startsWith('<svg'), `band ${band} did not render`);
    // The gradient ids carry the band, so compare the drawing without them.
    const shape = svg.replace(new RegExp(`rb${band}\\b`, 'g'), 'ID');
    assert.ok(!seen.has(shape),
      `band ${band} draws exactly the same badge as band ${seen.get(shape)}`);
    seen.set(shape, band);
  }
  assert.strictEqual(seen.size, 100);
});

test('the ladder gains a part at every tier and never loses one', () => {
  /* The whole ask was "higher levels should look better". Better here is not a
   * hue -- it is more on the badge. Each tier's part list must contain every
   * part of the tier below it, plus at least one more. */
  const { tiers } = load();
  assert.strictEqual(tiers.length, 10, 'there are no longer ten tiers');
  for (let t = 1; t < tiers.length; t += 1) {
    const below = tiers[t - 1].parts;
    const here = tiers[t].parts;
    below.forEach((p) => {
      assert.ok(here.includes(p),
        `${tiers[t].name} dropped "${p}", which ${tiers[t - 1].name} has`);
    });
    assert.ok(here.length > below.length,
      `${tiers[t].name} adds nothing over ${tiers[t - 1].name}`);
  }
});

test('every part a tier asks for is a part that exists', () => {
  // A typo in a tier's list would silently draw nothing at all.
  const { tiers, parts } = load();
  tiers.forEach((tier) => {
    tier.parts.forEach((p) => {
      assert.ok(parts[p], `${tier.name} wants "${p}", which is not drawn`);
    });
  });
});

test('the light climbs too, and only the upper half has any', () => {
  const { tiers } = load();
  const lit = tiers.filter((t) => t.glow);
  assert.ok(lit.length >= 5 && lit.length <= 6,
    `${lit.length} tiers glow; the bottom of the ladder should not`);
  tiers.slice(0, 4).forEach((t) => {
    assert.strictEqual(t.glow, null, `${t.name} glows, and it is a low tier`);
  });
  for (let i = 1; i < lit.length; i += 1) {
    assert.ok(lit[i].glowStop > lit[i - 1].glowStop,
      `${lit[i].name} throws no more light than ${lit[i - 1].name}`);
  }
});

test('the rainbow is gone', () => {
  /* The old colour was ((band - 1) * 17) % 360 fed to hsl(), which is why a
   * driver's rank colour meant nothing. Nothing should compute a hue from a
   * band again. */
  assert.ok(!/\(band - 1\) \* 17/.test(SOURCE), 'the cycling hue is back');
  const from = SOURCE.indexOf('var RANK_TIERS = [');
  const badges = SOURCE.slice(from, SOURCE.indexOf('function renderRankBadgeIcon'));
  assert.ok(!/hsl\(/.test(badges), 'a badge colour is being computed, not chosen');
});

test('a tier is ten bands wide, and the mark cycles inside it', () => {
  const ctx = load();
  const markOf = (band) => {
    const svg = ctx.svg(band, 68);
    const m = svg.match(/translate\(-48,-48\)"><path d="([^"]+)"/);
    assert.ok(m, `band ${band} drew no mark`);
    return m[1];
  };
  // Same position in two different tiers: same mark, different metal.
  assert.strictEqual(markOf(3), markOf(93), 'the mark does not cycle');
  assert.notStrictEqual(markOf(3), markOf(4), 'two bands in a tier share a mark');
  const metal = (band) => ctx.svg(band, 68).match(/stop-color="(#[0-9a-f]{6})"/i)[1];
  assert.notStrictEqual(metal(3), metal(93), 'two tiers share a metal');
  assert.strictEqual(metal(3), metal(9), 'one tier uses two metals');
});

test('an out of range band still draws something', () => {
  // rank_icon_key comes from the backend. A band of 0, 9999 or nonsense must
  // not produce an empty medal on a driver's reward card.
  const ctx = load();
  [0, -4, 101, 9999, NaN, undefined].forEach((band) => {
    const svg = ctx.svg(band, 68);
    assert.ok(svg.startsWith('<svg') && svg.includes('<path'),
      `band ${band} drew nothing`);
  });
});

test('the wrapper every other screen looks for is unchanged', () => {
  /* The reward card, the profile and the leaderboard all style
   * .rankBadgeIconWrap and some read data-rank-band. The art changed; the
   * handle it hangs on did not. */
  const render = SOURCE.slice(SOURCE.indexOf('function renderRankBadgeIcon'));
  assert.ok(/class="rankBadgeIconWrap \$\{toneClass\}/.test(render),
    'the wrapper class or its tone is gone');
  assert.ok(/data-rank-band="\$\{band\}"/.test(render), 'the band attribute is gone');
  assert.ok(/compact \? 54 : 68/.test(render), 'the compact size is gone');
});

test('ten emblems, and none of them repeat', () => {
  const { emblems } = load();
  assert.strictEqual(emblems.length, 10, 'there are no longer ten emblems');
  assert.strictEqual(new Set(emblems.map((e) => e.d)).size, 10,
    'two emblems are the same path');
  emblems.forEach((e) => {
    assert.ok(e.name && e.d, `an emblem is missing its name or its path`);
  });
});

test('every tier has a frame of its own', () => {
  /* Five tiers wore one body and five wore the other, so the top half of the
   * ladder was a single silhouette in five colours. However much furniture got
   * bolted on, that is what kept it feeling repetitive. */
  const { frames, tiers } = load();
  assert.strictEqual(frames.length, tiers.length,
    'there is no longer one frame per tier');
  assert.strictEqual(new Set(frames.map((f) => f.out)).size, frames.length,
    'two tiers share a silhouette');
});

test('every badge is struck, not drawn', () => {
  /* The first two attempts were flat: one fill, one outline. A medal's effect
   * is material -- a lit face, a shaded face, a rim light, a recessed field
   * with its own gloss, and a shadow under the lot. Each of those is a layer
   * here, and losing any one of them is what "too simple" looked like. */
  const ctx = load();
  const svg = ctx.svg(45, 240);
  const { frames } = ctx;
  frames.forEach((f, i) => {
    ['out', 'lit', 'inner'].forEach((face) => {
      assert.ok(f[face], `frame ${i + 1} has no ${face}`);
    });
  });
  assert.ok(/feDropShadow/.test(svg), 'the badge casts no shadow');
  assert.ok(/feTurbulence/.test(svg), 'the metal has no grain');
  assert.ok(/baseFrequency="[\d.]+ [\d.]+"/.test(svg),
    'the grain is isotropic noise, which is dirt rather than a brushed surface');
  assert.ok(svg.includes(frames[4].lit), 'the lit face is not drawn');
  assert.ok(svg.includes(frames[4].inner), 'there is no recessed field');
  assert.ok(/clip-path="url\(#rb45c\)"/.test(svg),
    'the surface is not painted inside the frame, so it has one plane again');
  // Five stops in the metal: highlight, light, mid, shadow, deep. Fewer and it
  // ramps instead of catching.
  const metal = svg.match(/id="rb45m"[^>]*>((?:<stop[^>]*>)+)/);
  assert.ok(metal, 'the metal gradient is gone');
  assert.ok((metal[1].match(/<stop/g) || []).length >= 5,
    'the metal has fewer than five stops, so it ramps instead of catching');
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
