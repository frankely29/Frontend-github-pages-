#!/usr/bin/env node
/**
 * css-rule-termination.test.js — the bug where a rule loses its body and
 * silently adopts the next one's.
 *
 * feed-first.css hid four pieces of the map's own chrome with one rule:
 *
 *     body.feed-first .sliderWrap,
 *     body.feed-first #sliderWrap,
 *     body.feed-first #navQuickStack,
 *     body.feed-first #navActiveBanner,
 *     body.feed-first #mapFeedPeek { display: none !important; }
 *
 * PR #1144 deleted #mapFeedPeek and deleted its line with it. That line was
 * the entire declaration block, so what remained ended on a comma. There was a
 * comment underneath and then an unrelated rule, and CSS does not treat a
 * comment as a terminator: the parser read past it and joined those four
 * selectors to the NEXT rule's block.
 *
 * Nothing warned. The file still parsed. The four elements simply stopped
 * being hidden and started inheriting declarations written for something else
 * -- #navQuickStack, a small Navigate button, picked up `bottom` and
 * `z-index: 9400` from the floating chat overlay, and a fixed element with
 * both top and bottom set is stretched between them. Measured in the browser
 * it became a 72x460px column down the right edge of the map, above it, with
 * pointer-events enabled.
 *
 * That was the "I can't zoom out unless I zoom in first" bug. A zoom-out is a
 * spread, so the fingers start wide and the right one landed on that column;
 * MapLibre keeps only the touches inside its canvas, saw one finger, and never
 * started a pinch. A zoom-in starts with the fingers together in the middle,
 * both on the canvas, so it worked -- and left them close enough together that
 * the next zoom-out worked too.
 *
 * The signature is exact and worth linting for: a comment block whose
 * preceding non-whitespace character is a comma. That only happens when
 * someone believes they have finished a rule and has not. It reads the files
 * as text on purpose -- the bug is invisible to a parser, which sees a
 * perfectly valid (if surprising) selector list.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const cssFiles = fs.readdirSync(root).filter((f) => f.endsWith('.css'));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('every CSS file in the repo is found', () => {
  assert.ok(cssFiles.length > 5,
    `expected the repo's stylesheets, found ${cssFiles.length}`);
});

test('no selector list runs into a comment instead of a declaration block', () => {
  const offenders = [];
  cssFiles.forEach((file) => {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    // Every comment start, and what came immediately before it.
    for (let i = text.indexOf('/*'); i !== -1; i = text.indexOf('/*', i + 2)) {
      let j = i - 1;
      while (j >= 0 && /\s/.test(text[j])) j -= 1;
      if (j >= 0 && text[j] === ',') {
        const line = text.slice(0, j).split('\n').length;
        offenders.push(`${file}:${line} selector list ends in a comma`);
      }
    }
  });
  assert.deepStrictEqual(offenders, [],
    `a rule lost its declaration block and will adopt the next rule's:\n` +
    `    ${offenders.join('\n    ')}`);
});

test('no stylesheet ends on an unterminated selector list', () => {
  /* The same mistake made at the very end of a file. There is no next rule to
   * adopt, so the selectors are simply dropped -- quieter still. */
  const offenders = [];
  cssFiles.forEach((file) => {
    const text = fs.readFileSync(path.join(root, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').trimEnd();
    if (text.endsWith(',')) offenders.push(file);
  });
  assert.deepStrictEqual(offenders, [], `unterminated selector list at EOF`);
});

test('braces balance in every stylesheet', () => {
  const offenders = [];
  cssFiles.forEach((file) => {
    const text = fs.readFileSync(path.join(root, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const open = (text.match(/\{/g) || []).length;
    const close = (text.match(/\}/g) || []).length;
    if (open !== close) offenders.push(`${file}: ${open} { vs ${close} }`);
  });
  assert.deepStrictEqual(offenders, [], `unbalanced braces`);
});

// -------------------------------------------------------- the map's chrome
const FEED = fs.readFileSync(path.join(root, 'feed-first.css'), 'utf8');

test('the map chrome rule has its own declaration block', () => {
  const m = FEED.match(
    /body\.feed-first #navActiveBanner\s*(,|\{)/);
  assert.ok(m, '#navActiveBanner is no longer in feed-first.css');
  assert.strictEqual(m[1], '{',
    'body.feed-first #navActiveBanner still ends the list on a comma, so ' +
    'these selectors are adopting whatever rule comes next');
});

test('the map chrome is not stretched across the map', () => {
  /* bottom:auto is the fix. With only `top` set each element is the size its
   * own stylesheet gives it; with both, it is stretched between them and
   * covers the map. */
  const rule = FEED.slice(FEED.indexOf('body.feed-first .sliderWrap'));
  const block = rule.slice(rule.indexOf('{'), rule.indexOf('}') + 1);
  assert.ok(/bottom:\s*auto/.test(block),
    'the map chrome rule no longer neutralises `bottom`; #navQuickStack will ' +
    'stretch down the edge of the map again and eat pinch gestures');
});

test('the chat overlay keeps the declarations that belong to it', () => {
  /* The other half: .killFeed must still get its own bottom and z-index. */
  const i = FEED.indexOf('body.feed-first .killFeed');
  assert.ok(i > 0, '.killFeed rule is gone');
  const block = FEED.slice(i, FEED.indexOf('}', i));
  assert.ok(/bottom:\s*calc\(100% - var\(--tj-split\)/.test(block),
    '.killFeed lost its seam offset');
  assert.ok(/z-index:\s*9400/.test(block), '.killFeed lost its z-index');
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
