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
    globalThis.emblems = EMBLEMS;
    globalThis.BANDS = RANK_BAND_COUNT;
    globalThis.PER = RANKS_PER_PRESTIGE;`, context, { filename: 'app.part5.js#badges' });
  return context;
}

const tests = [];
const test = (n, f) => tests.push([n, f]);

test('every band draws a badge, and no two are the same', () => {
  const ctx = load();
  const seen = new Map();
  for (let band = 1; band <= ctx.BANDS; band += 1) {
    const svg = ctx.svg(band, 68);
    assert.ok(svg.startsWith('<svg'), `band ${band} did not render`);
    // The gradient ids carry the band, so compare the drawing without them.
    const shape = svg.replace(new RegExp(`rb${band}\\b`, 'g'), 'ID');
    assert.ok(!seen.has(shape),
      `band ${band} draws exactly the same badge as band ${seen.get(shape)}`);
    seen.set(shape, band);
  }
  assert.strictEqual(seen.size, ctx.BANDS);
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

test('a prestige is PER bands wide, and the mark cycles inside it', () => {
  const ctx = load();
  const { PER, BANDS } = ctx;
  const markOf = (band) => {
    const svg = ctx.svg(band, 68);
    const m = svg.match(/translate\(-48,-48\)"><path d="([^"]+)"/);
    assert.ok(m, `band ${band} drew no mark`);
    return m[1];
  };
  /* Same rank in two different prestiges: same mark, different metal. Derived
     rather than written out, because the ladder's shape has moved three times
     and a hardcoded pair of band numbers silently stops testing what it says. */
  const firstOfLast = BANDS - PER + 1;            // rank 1 of the top prestige
  assert.strictEqual(markOf(1), markOf(firstOfLast), 'the mark does not cycle');
  assert.notStrictEqual(markOf(1), markOf(2), 'two bands in a prestige share a mark');
  const metal = (band) => ctx.svg(band, 68).match(/stop-color="(#[0-9a-f]{6})"/i)[1];
  assert.notStrictEqual(metal(1), metal(firstOfLast), 'two prestiges share a metal');
  assert.strictEqual(metal(1), metal(PER), 'one prestige uses two metals');
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
  /* Any band in the middle of the ladder; its frame is looked up rather than
     assumed, since which prestige band 23 belongs to depends on the shape. */
  const band = Math.ceil(ctx.BANDS / 2);
  const frameIndex = Math.floor((band - 1) / ctx.PER);
  const svg = ctx.svg(band, 240);
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
  assert.ok(svg.includes(frames[frameIndex].lit), 'the lit face is not drawn');
  assert.ok(svg.includes(frames[frameIndex].inner), 'there is no recessed field');
  assert.ok(svg.includes(`clip-path="url(#rb${band}c)"`),
    'the surface is not painted inside the frame, so it has one plane again');
  // Five stops in the metal: highlight, light, mid, shadow, deep. Fewer and it
  // ramps instead of catching.
  const metal = svg.match(new RegExp(`id="rb${band}m"[^>]*>((?:<stop[^>]*>)+)`));
  assert.ok(metal, 'the metal gradient is gone');
  assert.ok((metal[1].match(/<stop/g) || []).length >= 5,
    'the metal has fewer than five stops, so it ramps instead of catching');
});

// ----------------------------------------------------- the painted frames
//
// Ten painted frames plus ten vector emblems is a hundred badges. A hundred
// painted files would have been a hundred files to make, store and keep
// consistent, and the frames have an empty well in the middle precisely so
// the mark can stay generated.

test('all ten painted frames ship', () => {
  for (let t = 1; t <= 10; t += 1) {
    const file = path.join(__dirname, '..', 'rank-frames', `tier-${t}.webp`);
    assert.ok(fs.existsSync(file), `rank-frames/tier-${t}.webp is missing`);
    const kb = fs.statSync(file).size / 1024;
    assert.ok(kb < 40, `tier-${t}.webp is ${kb.toFixed(0)}KB; it draws at 68px`);
  }
});

test('a band asks for its own band\'s artwork, then its prestige\'s', () => {
  /* The badges live in the database now, one per band. Until a band's own art
   * is uploaded it wears its prestige's painted file, so a driver never sees
   * a gap while a set is landing a piece at a time. */
  const render = SOURCE.slice(SOURCE.indexOf('function renderRankBadgeIcon'));
  assert.ok(/rankBadgeSrc\(rank\.band\)/.test(render),
    'the badge image is no longer addressed by band');
  assert.ok(!/rank-frames\/tier-\$\{t\}/.test(render),
    'the renderer still hardcodes the prestige file');

  const src = SOURCE.slice(SOURCE.indexOf('function paintedBadgeSrc'),
                           SOURCE.indexOf('function applyRankBadgeManifestToDom'));
  assert.ok(/rank-frames\/tier-/.test(src),
    'the painted prestige fallback is gone, so an un-uploaded band has nothing');
  assert.ok(/RANK_BADGE_MANIFEST\[/.test(src),
    'the uploaded badge is never preferred over the painted one');
  assert.ok(/padStart\(3, '0'\)/.test(src),
    'the manifest is keyed on an unpadded band; the backend sends band_007');
});

test('the badge manifest is fetched once and never blocks a render', () => {
  /* A badge renders synchronously inside a feed row, so the manifest cannot
   * be awaited. It upgrades what is already on screen when it lands. */
  const src = SOURCE.slice(SOURCE.indexOf('function loadRankBadgeManifest'));
  assert.ok(/rankBadgeManifestState !== 'idle'/.test(src),
    'the manifest can be fetched more than once');
  assert.ok(/applyRankBadgeManifestToDom\(\)/.test(src),
    'badges already on screen are never upgraded to their uploaded artwork');
  assert.ok(/\.catch\(/.test(src),
    'a manifest that does not arrive is unhandled');
});

test('the vector badge is still in the markup, as the fallback', () => {
  /* Not decoration. A driver on a cached older build, or a tier whose art has
   * not been drawn yet, gets the generated badge instead of an empty box --
   * and the swap is a class on the wrapper, so nothing about the card moves. */
  const render = SOURCE.slice(SOURCE.indexOf('function renderRankBadgeIcon'));
  assert.ok(/rankBadgeVector/.test(render), 'the fallback badge is gone');
  assert.ok(/rankBadgeSvg\(band, size\)/.test(render),
    'the fallback is no longer the real generated badge');
  assert.ok(/onerror=/.test(render), 'a missing frame would leave an empty box');
  assert.ok(/classList\.remove\('rankBadgePainted'\)/.test(render),
    'the error path does not hand back to the vector');
});

test('the emblem wears its own frame\'s metal', () => {
  /* The palette is sampled out of the art. Hand-written, it put a purple skull
   * inside a black and gold medal. Every tier must differ from its neighbour,
   * or the sampling has silently stopped happening. */
  const { tiers } = load();
  const his = tiers.map((t) => t.hi);
  assert.strictEqual(new Set(his).size, 10, 'two tiers share a highlight');
  const los = tiers.map((t) => t.lo);
  assert.strictEqual(new Set(los).size, 10, 'two tiers share a metal');
  assert.ok(/Re-sample if the art is ever regenerated/.test(SOURCE),
    'the note saying not to hand-edit the sampled palette is gone');
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
