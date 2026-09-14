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

// The script loader, sliced out by an anchor that actually occurs in the file.
// The first cut of these tests mixed indices from two different strings and
// looked for a substring that was never there, so the slice came back empty and
// the assertions passed or failed on nothing.
function loaderSource() {
  const at = INDEX.indexOf('const jsAssets =');
  assert.ok(at > 0, 'the script loader is gone from index.html');
  return INDEX.slice(at, INDEX.indexOf('</script>', at));
}

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

test('the escape hatch gives the buttons back, not just the class', () => {
  // Dropping tj-auth-pending is not enough on its own: landing.js also sets the
  // hidden attribute on those blocks while it waits, and an attribute no CSS
  // rule is fighting stays put. A driver on a slow connection was left on a
  // welcome page with nothing to tap at all, permanently.
  const head = INDEX_NO_HTML_COMMENTS.slice(0, INDEX_NO_HTML_COMMENTS.indexOf('</head>'));
  const fn = head.slice(head.indexOf('releaseAuthPendingStage'));
  assert.ok(/classList\.remove\("tj-auth-pending"\)/.test(fn), 'the class is no longer cleared');
  assert.ok(/setLapsed\(false\)|hidden = false/.test(fn),
    'nothing unhides the buttons, so the page stays dead after the timeout');
  assert.ok(/data-landing-cta="new"/.test(fn),
    'the signed-out call to action is not restored');
  assert.ok(/landingGhostBtn/.test(fn), 'the sign-in button is not restored');
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

// ------------------------------- signed in is not the same as allowed in

test('an unpaid driver is let into the app, and loses the map', () => {
  // This is the whole model. It used to be the opposite: setAuthUI treated a
  // lapsed trial exactly like being signed out, so the driver got the landing
  // page with a Subscribe button -- which reads as "your sign-in failed"
  // however carefully it is worded.
  const i = PART10_RULES.indexOf('function setAuthUI');
  const fn = PART10_RULES.slice(i, i + 3000);
  assert.ok(/const showLock = !signedIn;/.test(fn),
    'a lapsed driver is still shown the signed-out page instead of the app');
  assert.ok(/applyMapAccessState\(lapsed\)/.test(fn),
    'nothing takes the map away, so an unpaid driver keeps it outright');
  assert.ok(/subscriptionKnownLapsed\(\)/.test(fn),
    'setAuthUI no longer asks whether access has lapsed');
});

test('the map lock is a class, so it holds before any script loads', () => {
  const i = PART10_RULES.indexOf('function applyMapLockState');
  assert.ok(i >= 0, 'applyMapLockState is gone');
  const fn = PART10_RULES.slice(i, PART10_RULES.indexOf('\n}', i));
  assert.ok(/classList\.toggle\("tj-map-locked"/.test(fn),
    'the lock is not expressed as a class');
  assert.ok(/html\.tj-map-locked\s+#map\b/.test(CRITICAL_RULES),
    'the inline boot CSS does not act on the lock');
});

test('a 402 locks the map and never the whole app', () => {
  // handlePaymentRequired called show() -- a full document lock -- on ANY 402
  // from ANY endpoint. Under this model 402s are routine: the map is paid, the
  // feed is not, and a driver reading the feed must not have the signed-out
  // page slammed over them.
  const paywall = stripComments(
    fs.readFileSync(path.join(ROOT, 'subscription.paywall.js'), 'utf8'))
    .replace(/\/\/[^\n]*/g, '');
  const i = paywall.indexOf('function handlePaymentRequired');
  assert.ok(i >= 0, 'handlePaymentRequired is gone');
  const fn = paywall.slice(i, paywall.indexOf('\n  }', i));
  assert.ok(/applyMapLockState\(true\)/.test(fn), 'a 402 no longer locks the map');
  assert.ok(!/\bshow\(/.test(fn),
    'a 402 still raises the document lock over the whole app');
  assert.ok(!/lockDocument/.test(paywall),
    'the document lock is back; it is what put the signed-out page over the feed');
});

test('only an explicit no from the server counts as lapsed', () => {
  // Getting this wrong the other way puts a subscribe page in front of a
  // paying driver, so absent data must never mean lapsed: /me can be in
  // flight, can fail transiently leaving `me` untouched, or can predate the
  // field entirely.
  const i = PART10_RULES.indexOf('function subscriptionKnownLapsed');
  assert.ok(i >= 0, 'subscriptionKnownLapsed is gone');
  const fn = PART10_RULES.slice(i, PART10_RULES.indexOf('\n}', i));
  assert.ok(/has_access === false/.test(fn),
    'lapsed is inferred rather than read from an explicit has_access === false');
  assert.ok(/is_admin/.test(fn), 'an admin can be walled out of their own app');
  assert.ok(!/!sub\?\.has_access\b/.test(fn) && !/!hasAccess\b/.test(fn),
    'a missing subscription would be treated as lapsed');
});

// ------------------------------- the page has to work, not just look ready

test('the scripts are all requested together, not one after another', () => {
  // This is the bug behind most of the others. The loader waited for each
  // script's onload before the NEXT one was even requested, so 39 files cost 39
  // round trips. The welcome page paints in ~300ms from the inline CSS above,
  // so on a phone a driver saw Sign in and Create account, tapped them, and
  // nothing happened. Measured on a throttled connection: 26 of 39 scripts in,
  // window.TeamJoseoLanding undefined, the email field 0x0.
  const loader = loaderSource();
  const code = stripComments(loader).replace(/\/\/[^\n]*/g, '');
  assert.ok(!/onload\s*=\s*function[^}]*loadScript/i.test(code),
    'a script still waits for the previous one to load before being requested');
  assert.ok(!/loadScriptSequentially/.test(code),
    'the sequential loader is back');
  assert.ok(/jsAssets\.forEach/.test(code),
    'the scripts are not appended in one pass');
});

test('execution order is still pinned, because these files depend on it', () => {
  // Parallel DOWNLOAD is the win; parallel EXECUTION would break app.part* which
  // read globals app.js defines. async=false is the one line keeping insertion
  // order, so losing it would trade one bug for a worse one.
  const loader = stripComments(loaderSource());
  assert.ok(/script\.async\s*=\s*false/.test(loader),
    'scripts would execute in arrival order, which their dependencies forbid');
});

test('a missing critical script still stops the app honestly', () => {
  const loader = loaderSource();
  assert.ok(/CRITICAL_JS_ASSETS\.has\(rawAsset\)/.test(loader),
    'nothing checks whether the failed script was a critical one');
  assert.ok(/showBootFatalOverlay/.test(loader),
    'a missing critical script no longer says so');
});

test('the welcome page\'s own script is loaded early, not last', () => {
  // Even with parallel downloads it still EXECUTES in list order, and this is
  // the only script the first screen needs. It used to sit 35th of 39.
  const list = (INDEX.match(/__TLC_LOCAL_JS_ASSETS__ = \[([\s\S]*?)\];/) || [])[1] || '';
  const items = [...list.matchAll(/"(\.\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(items.length > 10, 'could not read the script manifest');
  const at = items.indexOf('./landing.js');
  assert.ok(at >= 0, 'landing.js is not in the manifest at all');
  assert.ok(at <= 2,
    `landing.js is ${at + 1}th of ${items.length}; the first screen waits on it`);
  assert.strictEqual(items.filter((x) => x === './landing.js').length, 1,
    'landing.js is listed twice, so it would run twice');
});

// ------------------------------------------- the map lock, not an app lock

test('the lock leaves the driver in the app', () => {
  // The whole point. Hiding the dock here would be the old full-page wall
  // wearing a different class name.
  ['#dock', '\\.shellMenuBtn'].forEach((sel) => {
    const re = new RegExp('html\\.tj-map-locked[^{]*' + sel);
    assert.ok(!re.test(CRITICAL_RULES),
      `${sel} is hidden by the map lock, which puts the driver back outside the app`);
  });
});

test('the map is blurred, and the answer in words is hidden outright', () => {
  // Blur alone leaks it: the pill says "Much busier, go to Red Hook, 91" and the
  // tendency meter says the same as a number. Both are relocated into the shell
  // menu, so they would survive a filter on #map.
  assert.ok(/html\.tj-map-locked\s+#map[\s\S]{0,120}?filter:\s*blur/.test(CRITICAL_RULES),
    'the map is not blurred when locked');
  ['#mapAction', '#dayTendencyMeter', '\\.sliderWrap'].forEach((sel) => {
    const re = new RegExp('html\\.tj-map-locked[^{]*' + sel + '[^{]*\\{[^}]*display:\\s*none');
    assert.ok(re.test(CRITICAL_RULES), `${sel} is still readable behind the blur`);
  });
});

test('locking clears what the preview already put on screen', () => {
  const i = PART10_RULES.indexOf('function applyMapLockState');
  const fn = PART10_RULES.slice(i, PART10_RULES.indexOf('\n}', i));
  assert.ok(/TlcAssistantRecommendation = null/.test(fn),
    'the last recommendation stays in the DOM behind the blur');
  assert.ok(/TlcDayTendencyState/.test(fn),
    'the last tendency reading stays in the DOM behind the blur');
});

test('the lock card offers both ways out, and exactly one redeem box', () => {
  const card = INDEX.slice(INDEX.indexOf('id="mapLockCard"'),
                           INDEX.indexOf('</div>', INDEX.indexOf('data-landing-portal')));
  assert.ok(/data-landing-subscribe/.test(card), 'no way to subscribe');
  assert.ok(/data-paywall-redeem-input/.test(card), 'no way to use an access code');
  assert.ok(/data-landing-portal/.test(card), 'no way to manage an existing subscription');
  // redeemCode() finds its input with a document-wide querySelector, so a second
  // copy would silently win or lose on DOM order.
  const inputs = (INDEX_NO_HTML_COMMENTS.match(/data-paywall-redeem-input/g) || []).length;
  assert.strictEqual(inputs, 1, `${inputs} redeem inputs in the document`);
});

test('the card sits under the dock, not over it', () => {
  const rule = CRITICAL_RULES.match(/html\.tj-map-locked\s+#mapLockCard\s*\{[^}]*\}/);
  assert.ok(rule, 'the lock card has no rule');
  const z = /z-index:\s*(\d+)/.exec(rule[0]);
  assert.ok(z, 'the lock card has no z-index, so stacking is luck');
  assert.ok(Number(z[1]) < 3000,
    'the card is above the dock (3000), so it blocks the way out of the map');
});

test('the landing page no longer carries a lapsed state', () => {
  // A driver whose trial ended never sees the landing page now; leaving the
  // block there is how it comes back.
  ['data-landing-cta="lapsed"', 'landingLocked', 'tj-locked'].forEach((token) => {
    assert.ok(!INDEX_NO_HTML_COMMENTS.includes(token),
      `${token} is still in index.html`);
  });
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

test('the feature lock is its own class, not the map lock wearing a hat', () => {
  // The two are about to stop agreeing: the map opens for a timed preview and
  // closes again, while chat, games, the leaderboard and posting are never open
  // to an unpaid driver at all. Folding them into one class means the preview
  // would unlock chat for five minutes.
  assert.ok(/function applyFeatureLockState/.test(PART10_RULES),
    'no feature lock state at all');
  const i = PART10_RULES.indexOf('function applyFeatureLockState');
  const fn = PART10_RULES.slice(i, PART10_RULES.indexOf('\n}', i));
  assert.ok(fn.includes('tj-feature-locked'), 'it does not set its own class');
  assert.ok(!fn.includes('tj-map-locked'), 'the two locks are the same class');
  assert.ok(fn.includes('tlc:feature-lock-changed'),
    'nothing is told when access changes, so the menu never repaints');
});

test('setAuthUI drives both locks from the same verdict', () => {
  const i = PART10_RULES.indexOf('function setAuthUI');
  const fn = PART10_RULES.slice(i, i + 3200);
  assert.ok(/applyMapAccessState\(lapsed\)/.test(fn),
    'the map is not driven by lapsed');
  assert.ok(/applyFeatureLockState\(lapsed\)/.test(fn),
    'the feature lock is not driven by lapsed');
  assert.ok(!/applyMapLockState\(lapsed\)/.test(fn),
    'setAuthUI locks the map directly, which skips the preview entirely');
});

test('the feature lock is readable by the files that need it', () => {
  assert.ok(/window\.isFeatureLocked\s*=/.test(PART10_RULES),
    'feed.js and app-shell.js have no way to ask');
});

test('night does not unlock the map', () => {
  /* The blur and the night theme both claim `filter` on #map with !important,
   * and `body.night #map` is (1,1,1) on specificity -- exactly the same as
   * `html.tj-map-locked #map` in the inline boot CSS. A tie goes to source
   * order, and the boot CSS is in <head> while frontend-shell.css is injected
   * after it, so the night rule won and the blur lost: an unpaid driver at
   * night got the lock card over a perfectly readable map. Half of every day,
   * and invisible to any test run in daylight.
   *
   * Caught in a browser, not here -- computed style is the only place the two
   * rules meet -- so what this pins is the fix: the night rule excludes the
   * locked state rather than outranking it. */
  const night = SHELL_CSS.match(/([^\n{]*body\.night\s+#map\s*)\{([^}]*)\}/);
  assert.ok(night, 'the night rule for #map is gone');
  assert.ok(/:not\(\.tj-map-locked\)/.test(night[1]),
    `night clears the map's filter unconditionally again: "${night[1].trim()}"`);
  assert.ok(/html\.tj-map-locked #map/.test(CRITICAL_RULES), 'the blur itself is gone');
});

let failed = 0;
tests.forEach(([name, fn]) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
});
console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);
