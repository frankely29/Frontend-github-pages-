#!/usr/bin/env node
/**
 * boot.test.js — what a driver sees in the first half second.
 *
 * The bug these protect against was invisible to every other test, because
 * nothing here is wrong when the page is finished loading. It was wrong only
 * while it loaded:
 *
 *   Every stylesheet in this app is injected by a script in <head>, and an
 *   injected stylesheet does not block the first paint. So the browser painted
 *   the raw document first -- the landing markup as bare HTML, wordmark, a
 *   "Sign in" link, then the email and password fields down the page. Measured
 *   in Chromium at 341ms with 1 of 13 stylesheets applied. Drivers reported it
 *   as "the old sign in page" flashing up before the real one; it was never old
 *   code, it was this page with no CSS on it.
 *
 *   And #map is painted by default, so the map arrived before the welcome page.
 *
 * The fix has to live in CSS that exists at the first paint, which means inline
 * in index.html. That is unusual enough that it needs pinning: anyone tidying
 * that <style> block into a .css file would silently bring the flash back, and
 * the app would still look perfect once loaded.
 *
 * Timings above and in the assertions come from Chromium runs against the real
 * built page, not from the test -- node cannot measure a paint.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SHELL_CSS = fs.readFileSync(path.join(ROOT, 'frontend-shell.css'), 'utf8');
const PART10 = fs.readFileSync(path.join(ROOT, 'app.part10.js'), 'utf8');

// The inline critical block, isolated. Everything about the first paint has to
// be inside this, because nothing else has arrived yet.
const CRITICAL = (() => {
  const m = INDEX.match(/<style id="tjBootCritical">([\s\S]*?)<\/style>/);
  return m ? m[1] : '';
})();

// Comments explain the very tokens under test ("tj-boot", "display:none"), so a
// naive search matches the explanation and passes on a file with no rules left.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const CRITICAL_RULES = stripComments(CRITICAL);
const INDEX_NO_HTML_COMMENTS = INDEX.replace(/<!--[\s\S]*?-->/g, '');
const PART10_RULES = stripComments(PART10);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// --------------------------------------------------------- the critical block

test('the boot CSS is inline in the document, not a stylesheet', () => {
  // A linked stylesheet cannot fix a flash caused by linked stylesheets.
  assert.ok(CRITICAL.length > 0,
    'the <style id="tjBootCritical"> block is gone from index.html');
  const head = INDEX.slice(0, INDEX.indexOf('</head>'));
  assert.ok(head.includes('id="tjBootCritical"'), 'the boot CSS is not in <head>');
});

test('the boot CSS comes before the first stylesheet link', () => {
  // Order is the whole point: it has to be parsed before anything can paint.
  const style = INDEX.indexOf('id="tjBootCritical"');
  const firstLink = INDEX.indexOf('rel="stylesheet"');
  assert.ok(style >= 0 && firstLink >= 0);
  assert.ok(style < firstLink,
    'a stylesheet link is parsed before the inline boot CSS');
});

test('the document starts in both boot stages', () => {
  const m = INDEX.match(/<html[^>]*>/);
  assert.ok(m, 'no <html> tag');
  assert.ok(/class="[^"]*\btj-boot\b/.test(m[0]),
    '<html> does not start in the splash stage');
  assert.ok(/class="[^"]*\btj-auth-pending\b/.test(m[0]),
    '<html> does not start in the auth-pending stage');
});

test('nothing in the document paints during the splash stage', () => {
  // This single rule is what stops the unstyled page being shown.
  assert.ok(/html\.tj-boot\s+body\s*>\s*\*\s*\{[^}]*visibility:\s*hidden[^}]*!important/
    .test(CRITICAL_RULES),
    'the splash stage no longer hides the document');
  assert.ok(/html\.tj-boot\s+#bootSplash\s*\{[^}]*visibility:\s*visible/
    .test(CRITICAL_RULES),
    'the splash itself is hidden along with everything else');
});

test('the splash hides the page with visibility, never display', () => {
  // MapLibre measures #map when it initialises and a display:none container
  // measures zero, which is why this is visibility and has to stay visibility.
  const bodyRule = CRITICAL_RULES.match(/html\.tj-boot\s+body\s*>\s*\*\s*\{[^}]*\}/);
  assert.ok(bodyRule, 'the rule that hides the document is gone');
  assert.ok(!/display:\s*none/.test(bodyRule[0]),
    'the boot stage hides the document with display:none, which breaks map sizing');
});

test('the splash element exists and is the first thing in the body', () => {
  const body = INDEX.slice(INDEX.indexOf('<body>'));
  const splash = body.indexOf('id="bootSplash"');
  const map = body.indexOf('id="map"');
  assert.ok(splash >= 0, '#bootSplash is missing from the markup');
  assert.ok(splash < map, '#bootSplash is not ahead of the map');
});

test('the splash disappears the moment the stage ends', () => {
  assert.ok(/html:not\(\.tj-boot\)\s+#bootSplash\s*\{[^}]*display:\s*none[^}]*!important/
    .test(CRITICAL_RULES),
    'nothing removes the splash once the stylesheets have landed');
});

// ---------------------------------------------- the map never comes first

test('the map is held back until the app knows who this is', () => {
  assert.ok(/html\.tj-auth-pending\s+#map[^{]*\{[^}]*visibility:\s*hidden[^}]*!important/
    .test(CRITICAL_RULES),
    'the map can paint before the welcome page again');
});

test('the welcome page is shown for as long as the map is held back', () => {
  // Being merely "not the map" is not enough -- the overlay defaults to
  // display:none in frontend-shell.css, so it has to be turned on here.
  assert.ok(/html\.tj-auth-pending\s+#lockedOverlay\s*\{[^}]*display:\s*flex[^}]*!important/
    .test(CRITICAL_RULES),
    'nothing shows the welcome page during the pending stage');
  assert.ok(/\.lockedOverlay\s*\{[^}]*display:\s*none/.test(stripComments(SHELL_CSS)),
    'the overlay no longer defaults to hidden, so this test proves nothing');
});

test('the app chrome is held back with the map', () => {
  // A menu button and a dock floating over the welcome page is the same bug
  // wearing a different hat.
  ['\\.shellMenuBtn', '#dock', '#mapAction'].forEach((sel) => {
    assert.ok(new RegExp('html\\.tj-auth-pending[^{]*' + sel).test(CRITICAL_RULES),
      `${sel} is not held back during the pending stage`);
  });
});

// -------------------------------------- a signed-in driver is never asked in

test('a stored session is detected before the first paint', () => {
  const script = INDEX_NO_HTML_COMMENTS.slice(0, INDEX_NO_HTML_COMMENTS.indexOf('</head>'));
  assert.ok(script.includes('community_token_v1'),
    'nothing checks for a stored session in <head>');
  assert.ok(/classList\.add\("tj-has-token"\)/.test(script),
    'a stored session does not mark the document');
  // Blocked storage throws on access; a driver must still reach the app.
  const fn = script.slice(script.indexOf('markStoredSession'));
  assert.ok(/try\s*\{/.test(fn) && /catch/.test(fn),
    'reading localStorage in <head> is not guarded, so private mode breaks boot');
});

test('a driver who is already signed in is offered nothing to tap', () => {
  ['\\[data-landing-cta\\]', '\\[data-landing-fine\\]', '\\.landingGhostBtn']
    .forEach((sel) => {
      const re = new RegExp(
        'html\\.tj-auth-pending\\.tj-has-token[\\s\\S]{0,220}?' + sel);
      assert.ok(re.test(CRITICAL_RULES),
        `${sel} is still shown to a driver whose session is being checked`);
    });
});

test('a signed-out visitor still gets the buttons on the first paint', () => {
  // The rule above must be keyed on the token, not on the pending stage alone,
  // or a new visitor lands on a page with nothing to do.
  const hides = CRITICAL_RULES.match(
    /html\.tj-auth-pending[^{]*\[data-landing-cta\][^{]*\{[^}]*\}/g) || [];
  assert.ok(hides.length > 0, 'no rule hides the buttons at all');
  hides.forEach((rule) => {
    assert.ok(rule.includes('tj-has-token'),
      'the call to action is hidden from everyone, signed-out visitors included');
  });
});

// ------------------------------------------------- nobody gets stranded

test('the splash stage ends when the stylesheets actually land', () => {
  const head = INDEX_NO_HTML_COMMENTS.slice(0, INDEX_NO_HTML_COMMENTS.indexOf('</head>'));
  assert.ok(/addEventListener\("load", settled\)/.test(head),
    'the splash is not tied to the stylesheets finishing');
  assert.ok(/addEventListener\("error", settled\)/.test(head),
    'a stylesheet that 404s would strand a driver on the splash');
});

test('both stages have a way out if the app never gets there', () => {
  const head = INDEX_NO_HTML_COMMENTS.slice(0, INDEX_NO_HTML_COMMENTS.indexOf('</head>'));
  assert.ok(/setTimeout\(window\.__tlcEndBootStage,\s*\d+\)/.test(head),
    'nothing releases the splash if a stylesheet never settles');
  assert.ok(/releaseAuthPendingStage/.test(head),
    'nothing releases the welcome page if the app scripts fail');
  // A stuck driver is worse than a slightly early map, so these must be real
  // numbers and not something absurdly long.
  const waits = [...head.matchAll(/}\s*,\s*(\d{3,5})\)/g)].map((m) => +m[1]);
  assert.ok(waits.some((w) => w > 0 && w <= 15000),
    'the escape hatches are longer than any driver would wait');
});

test('the pending stage ends where auth is actually decided', () => {
  // setAuthUI is the first point the app knows the answer, and every boot path
  // in bootstrapCommunityModule() calls it.
  const i = PART10_RULES.indexOf('function setAuthUI');
  assert.ok(i >= 0, 'setAuthUI is gone');
  const fn = PART10_RULES.slice(i, i + 2600);
  assert.ok(/classList\.remove\("tj-auth-pending"\)/.test(fn),
    'setAuthUI no longer releases the boot stage, so the map never appears');
  const boot = PART10_RULES.slice(PART10_RULES.indexOf('async function bootstrapCommunityModule'),
    PART10_RULES.indexOf('async function bootstrapCommunityModule') + 700);
  assert.ok((boot.match(/setAuthUI\(/g) || []).length >= 3,
    'a boot path through bootstrapCommunityModule no longer calls setAuthUI');
});

// --------------------------------------------------- the old card is gone

test('the old white sign-in card is gone for good', () => {
  // It had no markup left anywhere, and leaving dead styles for a screen the
  // design replaced is how it comes back.
  ['lockedCard', 'lockedHead', 'lockedBody', 'lockedActions'].forEach((cls) => {
    assert.ok(!new RegExp('\\.' + cls + '\\b').test(stripComments(SHELL_CSS)),
      `.${cls} is still styled`);
    assert.ok(!new RegExp('class="[^"]*\\b' + cls + '\\b').test(INDEX),
      `.${cls} is back in the markup`);
  });
});

let failed = 0;
tests.forEach(([name, fn]) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
});
console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);
