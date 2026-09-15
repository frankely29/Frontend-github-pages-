#!/usr/bin/env node
/**
 * landing.test.js — the signed-out page, on the real shipped files.
 *
 * Two things are being protected here, and only one of them is the new page.
 *
 * The other is that signing in still works. app.part10.js binds #btnLogin and
 * #btnSignup and reads #authEmail, #authPass, #authName and #authGhost, all by
 * id, once, at load. A landing page that renamed one of those ids, or created
 * its buttons on demand, would hand back a control nobody is listening to — and
 * the failure is silent: the button is there, it just does nothing.
 *
 * So the markup in index.html is parsed and asserted directly, and landing.js
 * is driven against a small DOM to check it only ever HIDES those buttons.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'landing.css'), 'utf8');
const SHELL_CSS = fs.readFileSync(path.join(ROOT, 'frontend-shell.css'), 'utf8');
const JS_SOURCE = path.join(ROOT, 'landing.js');

const AUTH_IDS = ['authEmail', 'authPass', 'authName', 'authGhost',
  'authCity', 'authCode', 'btnLogin', 'btnSignup', 'authStatus'];

// --------------------------------------------------------------------------
// a DOM just large enough for landing.js
// --------------------------------------------------------------------------

function makeNode(tag) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [], parentNode: null, hidden: false, id: '',
    _classes: new Set(), _text: '', _html: '', _attrs: {}, _listeners: {},
    scrollTop: 0, focused: 0,
  };
  node.classList = {
    add: (...n) => n.forEach((x) => x && node._classes.add(x)),
    remove: (...n) => n.forEach((x) => node._classes.delete(x)),
    contains: (x) => node._classes.has(x),
  };
  Object.defineProperty(node, 'className', {
    get: () => [...node._classes].join(' '),
    set: (v) => { node._classes.clear(); String(v || '').split(/\s+/).forEach((x) => x && node._classes.add(x)); },
  });
  Object.defineProperty(node, 'textContent', {
    get: () => node._text, set: (v) => { node._text = String(v); },
  });
  Object.defineProperty(node, 'innerHTML', {
    get: () => node._html, set: (v) => { node._html = String(v); },
  });
  node.appendChild = (c) => { c.parentNode = node; node.children.push(c); return c; };
  node.setAttribute = (k, v) => { node._attrs[k] = String(v); };
  node.getAttribute = (k) => (k in node._attrs ? node._attrs[k] : null);
  node.addEventListener = (t, fn) => { (node._listeners[t] = node._listeners[t] || []).push(fn); };
  node.dispatch = (t, e) => (node._listeners[t] || []).forEach((fn) => fn(e || { type: t }));
  // Real clicks bubble; landing.js delegates from #landing, so a fake that
  // fires only on the node under the cursor would report a dead page.
  node.click = () => {
    const event = { type: 'click', target: node };
    let cur = node;
    while (cur) { cur.dispatch('click', event); cur = cur.parentNode; }
  };
  node.focus = () => { node.focused += 1; };
  const walk = (n, out) => { n.children.forEach((c) => { out.push(c); walk(c, out); }); return out; };
  const matches = (n, sel) => {
    // A selector list is one selector to the browser, and the source uses one
    // to gather both call-to-action blocks and both fine-print lines in a
    // single pass. Without this the double silently matched nothing and the
    // test failed where the browser is fine.
    if (sel.indexOf(',') >= 0) {
      return sel.split(',').some((part) => matches(n, part.trim()));
    }
    // A compound selector -- an attribute and a class on the same element,
    // like [data-landing-go='signin'].landingGhostBtn, which is how landing.js
    // singles out the header sign-in button. This fell through to the tag-name
    // compare at the bottom and matched nothing, silently: the test that was
    // meant to catch that button being hidden passed against the broken code
    // because q() handed it null and the source's `if (top)` never ran.
    const parts = sel.match(/\[[^\]]*\]|\.[\w-]+|[\w-]+/g) || [];
    if (parts.length > 1) return parts.every((part) => matches(n, part));
    if (sel.startsWith('.')) return n.classList.contains(sel.slice(1));
    if (sel.startsWith('[') && sel.endsWith(']')) {
      const inner = sel.slice(1, -1);
      const eq = inner.indexOf('=');
      if (eq < 0) return n.getAttribute(inner) !== null;
      const key = inner.slice(0, eq);
      const val = inner.slice(eq + 1).replace(/^["']|["']$/g, '');
      return n.getAttribute(key) === val;
    }
    return n.tagName === sel.toUpperCase();
  };
  node.querySelectorAll = (sel) => walk(node, []).filter((c) => matches(c, sel));
  node.querySelector = (sel) => node.querySelectorAll(sel)[0] || null;
  node.closest = (sel) => {
    let cur = node;
    while (cur) { if (matches(cur, sel)) return cur; cur = cur.parentNode; }
    return null;
  };
  return node;
}

function buildDom(opts = {}) {
  const byId = new Map();
  const make = (tag, id, attrs, cls) => {
    const n = makeNode(tag);
    if (id) { n.id = id; byId.set(id, n); }
    if (cls) n.className = cls;
    Object.keys(attrs || {}).forEach((k) => n.setAttribute(k, attrs[k]));
    return n;
  };

  const landing = make('div', 'landing');
  const pitch = make('div', null, { 'data-landing-pane': 'pitch' });
  const form = make('div', null, { 'data-landing-pane': 'form' });
  form.hidden = true;

  pitch.appendChild(make('button', null, { 'data-landing-go': 'signup' }));
  pitch.appendChild(make('button', null, { 'data-landing-go': 'signin' }));
  // The real page carries two sign-in affordances: this ghost button in the
  // header, which landing.js singles out by class, and the one above inside
  // the call-to-action block. A fixture with only the second cannot see what
  // setLapsed does to the first.
  pitch.appendChild(make('button', null, { 'data-landing-go': 'signin' }, 'landingGhostBtn'));
  pitch.appendChild(make('div', null, { 'data-landing-cta': 'new' }));
  // The locked notice. It rides data-landing-cta="lapsed" like the buttons do,
  // so setLapsed shows and hides it without knowing it exists.
  const locked = make('div', null, { 'data-landing-cta': 'lapsed' }, 'landingLocked');
  locked.appendChild(make('p', null, { 'data-landing-locked-title': '' }, 'landingLockedTitle'));
  pitch.appendChild(locked);
  pitch.appendChild(make('div', null, { 'data-landing-cta': 'lapsed' }));
  pitch.appendChild(make('p', null, { 'data-landing-fine': 'new' }));
  pitch.appendChild(make('p', null, { 'data-landing-fine': 'lapsed' }));

  form.appendChild(make('button', null, { 'data-landing-go': 'pitch' }));
  form.appendChild(make('h2', null, { 'data-landing-title': '' }));
  form.appendChild(make('p', null, { 'data-landing-lede': '' }));
  form.appendChild(make('div', null, { 'data-landing-field': 'name' }));
  form.appendChild(make('div', null, { 'data-landing-field': 'city' }));
  form.appendChild(make('div', null, { 'data-landing-field': 'code' }));
  form.appendChild(make('span', null, { 'data-landing-hint': '' }));
  form.appendChild(make('div', null, { 'data-landing-promise': '' }));
  form.appendChild(make('p', null, { 'data-landing-swap': '' }));
  form.appendChild(make('input', 'authName'));
  form.appendChild(make('input', 'authCity'));
  form.appendChild(make('input', 'authCode'));
  form.appendChild(make('input', 'authEmail'));
  form.appendChild(make('input', 'authPass'));
  form.appendChild(make('input', 'authGhost'));
  form.appendChild(make('button', 'btnSignup', { 'data-landing-submit': 'signup' }));
  form.appendChild(make('button', 'btnLogin', { 'data-landing-submit': 'signin' }));
  form.appendChild(make('div', 'authStatus'));

  landing.appendChild(pitch);
  landing.appendChild(form);
  byId.set('landing', landing);

  // The overlay the landing lives inside. landing.js reads its `show` class to
  // tell "the page is in front of someone" from "the page is off screen", and
  // without it here that branch could not be exercised at all.
  const overlay = makeNode('div');
  overlay.id = 'lockedOverlay';
  // Three different things raise this overlay and only one of them is the
  // `show` class, so the double has to model what it RENDERS as, not just what
  // classes it carries. opts.overlayRaisedBy: 'show' | 'boot' | 'locked' | null.
  const raisedBy = opts.overlayRaisedBy
    || (opts.overlayShown ? 'show' : null);
  if (raisedBy === 'show') overlay.classList.add('show');
  overlay.__display = raisedBy ? 'flex' : 'none';
  byId.set('lockedOverlay', overlay);

  // <html> carries the boot stage. tj-auth-pending means the app has not yet
  // decided who this is; index.html clears it the moment setAuthUI does.
  const documentElement = makeNode('html');
  if (opts.pending !== false) documentElement.classList.add('tj-auth-pending');

  const document = {
    readyState: 'complete',
    body: landing,
    documentElement,
    getElementById: (id) => byId.get(id) || null,
    createElement: (t) => makeNode(t),
    addEventListener: () => {},
  };
  const window = {
    document, console,
    // landing.js asks the rendering whether the page is on screen. The double
    // answers from __display, which buildDom sets per boot state above.
    getComputedStyle: (el) => ({ display: (el && el.__display) || 'none' }),
    addEventListener: (t, fn) => { (window._l[t] = window._l[t] || []).push(fn); },
    _l: {},
    dispatch: (t, e) => (window._l[t] || []).forEach((fn) => fn(e)),
  };
  window.window = window;
  window.localStorage = {
    _v: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._v, k) ? this._v[k] : null; },
    setItem(k, v) { this._v[k] = String(v); },
  };
  // Seeded before the source runs, because mount() reads it.
  if (opts.token) window.localStorage.setItem('community_token_v1', opts.token);
  const ctx = vm.createContext({ window, document, console });
  vm.runInContext(fs.readFileSync(JS_SOURCE, 'utf8'), ctx, { filename: 'landing.js' });
  return { window, document, documentElement, overlay, byId, landing, pitch, form,
    api: window.TeamJoseoLanding };
}

const tests = [];
const test = (n, f) => tests.push([n, f]);

// --------------------------------------------------------------------------
// the ids the existing auth code depends on
// --------------------------------------------------------------------------

test('every id app.part10.js binds to is still in index.html, exactly once', () => {
  AUTH_IDS.forEach((id) => {
    const hits = INDEX.split(`id="${id}"`).length - 1;
    assert.strictEqual(hits, 1, `id="${id}" appears ${hits} times — auth binds it by id`);
  });
});

test('the auth ids are inside the overlay setAuthUI shows and hides', () => {
  // This used to bound the overlay by where #paywallOverlay started. That
  // element is gone, so the bound is now the overlay's own closing tag, found
  // by walking the divs from it.
  const start = INDEX.indexOf('id="lockedOverlay"');
  assert.ok(start > -1, '#lockedOverlay is gone');
  let depth = 0;
  let end = -1;
  const tagRe = /<(\/?)div\b[^>]*>/g;
  tagRe.lastIndex = INDEX.lastIndexOf('<div', start);
  let m;
  while ((m = tagRe.exec(INDEX))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) { end = m.index; break; }
  }
  assert.ok(end > start, 'could not find where #lockedOverlay closes');
  const block = INDEX.slice(start, end);
  AUTH_IDS.forEach((id) => {
    assert.ok(block.includes(`id="${id}"`), `${id} escaped the signed-out overlay`);
  });
});

test('both submit buttons ship in the markup', () => {
  // app.part10.js binds each once at load. A pane that built them on demand
  // would hand back a button with no listener — and it would look fine.
  assert.ok(INDEX.includes('id="btnSignup"'), 'signup button');
  assert.ok(INDEX.includes('id="btnLogin"'), 'login button');
});

test('the slide images the markup asks for exist', () => {
  const wanted = [...INDEX.matchAll(/\.\/landing\/(slide-[\w-]+\.jpg)/g)].map((m) => m[1]);
  assert.ok(wanted.length >= 5, `expected at least 5 slides, found ${wanted.length}`);
  [...new Set(wanted)].forEach((file) => {
    assert.ok(fs.existsSync(path.join(ROOT, 'landing', file)), `missing landing/${file}`);
  });
});

test('landing.css and landing.js are registered for loading', () => {
  assert.ok(INDEX.includes('"./landing.css"'), 'css not in the manifest');
  assert.ok(INDEX.includes('"./landing.js"'), 'js not in the manifest');
});

// --------------------------------------------------------------------------
// the carousel
// --------------------------------------------------------------------------

test('the track carries a sixth frame that repeats the first', () => {
  // Five frames means the loop has to race backwards to the start, and that
  // snap is what makes a carousel look broken.
  const start = INDEX.indexOf('class="landingTrack"');
  const end = INDEX.indexOf('landingDots');
  const track = INDEX.slice(start, end);
  const slides = track.split('class="landingSlide"').length - 1;
  assert.strictEqual(slides, 6, `track has ${slides} frames, expected 5 + the repeat`);
  const first = track.indexOf('slide-Feed.jpg');
  const last = track.lastIndexOf('slide-Feed.jpg');
  assert.ok(last > first, 'the last frame should repeat the first slide');
});

test('one step is exactly one slide', () => {
  // flex:0 0 100% with translateX(-100%) per step. Sizing the track at 600% and
  // slides at 16.6% resolves the percentage against the wrong box and lands
  // every step off by the difference.
  assert.ok(/\.landingSlide\s*\{[^}]*flex:\s*0 0 100%/.test(CSS), 'slides must be 100%');
  ['-100%', '-200%', '-300%', '-400%', '-500%'].forEach((step) => {
    assert.ok(CSS.includes(`translateX(${step})`), `missing step ${step}`);
  });
});

test('there is a dot animation per slide', () => {
  for (let i = 1; i <= 5; i += 1) {
    assert.ok(CSS.includes(`@keyframes landingDot${i}`), `landingDot${i}`);
  }
});

test('reduced motion stops the carousel', () => {
  assert.ok(CSS.includes('prefers-reduced-motion'), 'no reduced-motion block');
  const block = CSS.slice(CSS.indexOf('prefers-reduced-motion'));
  assert.ok(/animation:\s*none/.test(block), 'reduced motion must stop the animation');
});

// --------------------------------------------------------------------------
// the two doors
// --------------------------------------------------------------------------

test('the pitch is what a visitor lands on', () => {
  const env = buildDom();
  assert.strictEqual(env.pitch.hidden, false);
  assert.strictEqual(env.form.hidden, true);
});

test('create account opens the signup door', () => {
  const env = buildDom();
  env.pitch.querySelector('[data-landing-go=signup]').click();
  assert.strictEqual(env.form.hidden, false);
  assert.strictEqual(env.form.querySelector('[data-landing-title]').textContent, 'Create account');
  assert.strictEqual(env.form.querySelector('[data-landing-field=name]').hidden, false,
    'signup asks for a name');
  assert.strictEqual(env.byId.get('btnSignup').hidden, false);
  assert.strictEqual(env.byId.get('btnLogin').hidden, true);
});

test('sign in opens the other door with the name field away', () => {
  const env = buildDom();
  env.pitch.querySelector('[data-landing-go=signin]').click();
  assert.strictEqual(env.form.querySelector('[data-landing-title]').textContent, 'Sign in');
  assert.strictEqual(env.form.querySelector('[data-landing-field=name]').hidden, true);
  assert.strictEqual(env.form.querySelector('[data-landing-promise]').hidden, true,
    'the trial promise belongs to signup');
  assert.strictEqual(env.byId.get('btnLogin').hidden, false);
  assert.strictEqual(env.byId.get('btnSignup').hidden, true);
});

test('neither submit button is ever removed from the document', () => {
  // This is the whole risk. Removing and recreating them detaches the listener
  // app.part10.js attached at load, and the button then silently does nothing.
  const env = buildDom();
  const signup = env.byId.get('btnSignup');
  const login = env.byId.get('btnLogin');
  ['signup', 'signin', 'pitch', 'signin', 'signup'].forEach((door) => {
    env.api.goTo(door);
    assert.strictEqual(env.document.getElementById('btnSignup'), signup, 'signup was replaced');
    assert.strictEqual(env.document.getElementById('btnLogin'), login, 'login was replaced');
    assert.ok(signup.parentNode, 'signup left the tree');
    assert.ok(login.parentNode, 'login left the tree');
  });
});

test('the password field says which password it wants', () => {
  // Password managers offer to save on signup and to fill on sign-in.
  const env = buildDom();
  env.api.goTo('signup');
  assert.strictEqual(env.byId.get('authPass').getAttribute('autocomplete'), 'new-password');
  env.api.goTo('signin');
  assert.strictEqual(env.byId.get('authPass').getAttribute('autocomplete'), 'current-password');
});

test('back returns to the pitch', () => {
  const env = buildDom();
  env.api.goTo('signup');
  env.form.querySelector('[data-landing-go=pitch]').click();
  assert.strictEqual(env.pitch.hidden, false);
  assert.strictEqual(env.form.hidden, true);
});

test('the swap line switches doors', () => {
  const env = buildDom();
  env.api.goTo('signup');
  assert.ok(env.form.querySelector('[data-landing-swap]').innerHTML.includes('signin'));
  env.api.goTo('signin');
  assert.ok(env.form.querySelector('[data-landing-swap]').innerHTML.includes('signup'));
});

test('an expired token returns to the pitch, not a half-filled form', () => {
  const env = buildDom();
  env.api.goTo('signup');
  env.window.dispatch('tlc:auth-expired', {});
  assert.strictEqual(env.pitch.hidden, false);
});

test('an unknown door is ignored rather than blanking the page', () => {
  const env = buildDom();
  env.api.goTo('signup');
  env.api.goTo('nonsense');
  assert.strictEqual(env.form.hidden, false, 'still on a real door');
  assert.strictEqual(env.api.door(), 'signup');
});

test('opening a door focuses the first field a person would type in', () => {
  const env = buildDom();
  env.api.goTo('signup');
  assert.ok(env.byId.get('authName').focused > 0, 'signup starts at the name');
  env.api.goTo('signin');
  assert.ok(env.byId.get('authEmail').focused > 0, 'sign-in starts at the email');
});

// --------------------------------------------------------------------------
// stacking: the signed-out page is the whole app for a logged-out visitor
// --------------------------------------------------------------------------

test('the signed-out page sits above the map chrome', () => {
  // Found in a browser: at the overlay's original z-index of 2000 the shell's
  // menu button (3200) and the dock (3000) floated on top of it and ate the
  // taps meant for the page underneath them.
  const SHELL = fs.readFileSync(path.join(ROOT, 'app-shell.css'), 'utf8');
  const overlay = /#lockedOverlay\.lockedOverlay\s*\{[^}]*z-index:\s*(\d+)/.exec(CSS);
  assert.ok(overlay, 'the overlay must set its own z-index');
  const menuBtn = /\.shellMenuBtn\s*\{[^}]*z-index:\s*(\d+)/.exec(SHELL);
  assert.ok(menuBtn, 'shell menu button z-index');
  assert.ok(Number(overlay[1]) > Number(menuBtn[1]),
    `overlay ${overlay[1]} must outrank the menu button ${menuBtn[1]}`);
});

test('the map chrome is hidden while the signed-out page shows', () => {
  // A menu button that does nothing is worse than no button.
  // .mapControlStack was in this list and is deleted, not hidden -- there is
  // no longer any markup for the signed-out page to cover.
  ['.shellMenuBtn', '#dock', '.sliderWrap'].forEach((sel) => {
    assert.ok(CSS.includes(`#lockedOverlay.show ~ ${sel}`),
      `${sel} is not hidden behind the signed-out page`);
  });
});

test('the overlay still uses the class setAuthUI toggles', () => {
  // setAuthUI adds and removes `show`; styling anything else would leave the
  // page visible to a signed-in driver, or invisible to a signed-out one.
  assert.ok(CSS.includes('#lockedOverlay.show'), 'must key off .show');
  const app = fs.readFileSync(path.join(ROOT, 'app.part10.js'), 'utf8');
  assert.ok(app.includes('lockedOverlay.classList.toggle("show"'),
    'setAuthUI no longer toggles .show — this page would never appear');
});

// --------------------------------------------------------------------------
// city and access code
// --------------------------------------------------------------------------

test('signup asks for city and an optional access code', () => {
  const env = buildDom();
  env.api.goTo('signup');
  assert.strictEqual(env.form.querySelector('[data-landing-field=city]').hidden, false);
  assert.strictEqual(env.form.querySelector('[data-landing-field=code]').hidden, false);
});

test('sign in asks for neither', () => {
  // The account already knows its city, and a code is redeemed from the menu.
  const env = buildDom();
  env.api.goTo('signin');
  assert.strictEqual(env.form.querySelector('[data-landing-field=city]').hidden, true);
  assert.strictEqual(env.form.querySelector('[data-landing-field=code]').hidden, true);
});

test('the access code field is marked optional in the markup', () => {
  // Otherwise it reads as required and stops people who do not have one.
  const block = INDEX.slice(INDEX.indexOf('data-landing-field="code"'),
    INDEX.indexOf('landingCheck'));
  assert.ok(/Optional/i.test(INDEX.slice(INDEX.indexOf('for="authCode"') - 200,
    INDEX.indexOf('id="authCode"'))), 'the label should say Optional');
  assert.ok(block.includes('autocapitalize="characters"'), 'codes are upper case');
});

test('signup sends the city to the server', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app.part10.js'), 'utf8');
  const fn = app.slice(app.indexOf('async function doSignup'),
    app.indexOf('async function changePassword'));
  assert.ok(/body\.city\s*=\s*city/.test(fn), 'city is never sent');
  assert.ok(/if \(city\)/.test(fn), 'an empty city must not be sent as ""');
});

test('the access code is redeemed with the token signup just returned', () => {
  // It cannot be redeemed anonymously — /subscription/redeem is authenticated.
  const app = fs.readFileSync(path.join(ROOT, 'app.part10.js'), 'utf8');
  const fn = app.slice(app.indexOf('async function doSignup'),
    app.indexOf('async function changePassword'));
  assert.ok(fn.includes('/subscription/redeem'), 'the code is never redeemed');
  assert.ok(/postJSON\("\/subscription\/redeem",\s*\{ code: accessCode \},\s*token\)/.test(fn),
    'redeem must be called with the signup token');
});

test('a bad access code does not cost someone their new account', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app.part10.js'), 'utf8');
  const fn = app.slice(app.indexOf('async function doSignup'),
    app.indexOf('async function changePassword'));
  const redeem = fn.slice(fn.indexOf('/subscription/redeem'));
  // Comments stripped first: this is an assertion about code, and the prose
  // above the block says the word "throwing" while doing the opposite.
  const code = redeem.slice(0, redeem.indexOf('await loadMe'))
    .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.ok(redeem.includes('catch'), 'a failed redemption must be caught');
  assert.ok(!/\bthrow\b/.test(code),
    'a failed redemption must not throw — the account already exists');
  assert.ok(fn.includes('codeNotice'), 'the driver should be told the code did not apply');
});

test('the code is redeemed before the profile is loaded', () => {
  // Otherwise loadMe() caches a trial and the access the code granted only
  // appears after a refresh.
  const app = fs.readFileSync(path.join(ROOT, 'app.part10.js'), 'utf8');
  const fn = app.slice(app.indexOf('async function doSignup'),
    app.indexOf('async function changePassword'));
  assert.ok(fn.indexOf('/subscription/redeem') < fn.indexOf('await loadMe()'),
    'redeem must run before loadMe()');
});

test('the hero draws links, not just dots', () => {
  // Without them it is a scatter of circles; with them it is a network, which
  // is the entire claim the page makes.
  assert.ok(CSS.includes('.landingNode::before'), 'no node links');
  assert.ok(/\.landingArt::(before|after)/.test(CSS), 'no long links');
});

// --------------------------------------------------------------------------
// ------------------------------------- the page a lapsed account is sent to

const LANDING_JS = fs.readFileSync(JS_SOURCE, 'utf8');
const PAYWALL_JS = fs.readFileSync(path.join(ROOT, 'subscription.paywall.js'), 'utf8');




// ------------------------------------------- signing in has to be possible

test('a page whose answer already arrived does not hide its own buttons', () => {
  // landing.js is a separate request; setAuthUI can run before it, so the
  // answer often beats this script. When
  // it did, mount() entered the resolving state anyway and hid every button
  // with nothing left to unhide them: a driver with an expired token got a
  // welcome page with no Sign in and no Create account. Caught in a browser by
  // a click that failed because the button carried hidden="".
  const dom = buildDom({ pending: false, token: 'stale-token-not-valid' });
  assert.strictEqual(dom.api.isResolving(), false,
    'the page went on waiting for an answer it already had');
  const ghost = dom.landing.querySelectorAll('[data-landing-go="signin"]')
    .filter((n) => n.classList.contains('landingGhostBtn'))[0];
  const cta = dom.landing.querySelectorAll('[data-landing-cta="new"]')[0];
  assert.strictEqual(ghost.hidden, false, 'no way to sign in');
  assert.strictEqual(cta.hidden, false, 'no way to create an account either');
});

test('a page still waiting for its answer offers nothing to tap', () => {
  // The other half of the same rule: while the question is genuinely open, a
  // driver who may already be signed in must not be shown "Create account".
  const dom = buildDom({ pending: true, token: 'stale-token-not-valid' });
  assert.strictEqual(dom.api.isResolving(), true,
    'the page stopped waiting while the answer was still unknown');
});

test('an expiry does not close the form someone is typing into', () => {
  // A dead token is exactly what a driver has when they go to sign in again,
  // and the app keeps polling with it, so a 401 lands at an arbitrary moment.
  // This listener used to reset the pane unconditionally: measured in a
  // browser as form at 4301ms, 401 on /frame/0, pitch at 5386ms -- two
  // characters into the password. The polls repeat, so the form could never
  // be finished.
  const dom = buildDom({ overlayShown: true });
  dom.api.goTo('signin');
  assert.strictEqual(dom.form.hidden, false, 'the form never opened');
  dom.window.dispatch('tlc:auth-expired', { detail: { status: 401 } });
  assert.strictEqual(dom.form.hidden, false,
    'an expiry threw the driver off the form they were using');
  dom.window.dispatch('tlc:auth-expired', { detail: { status: 401 } });
  assert.strictEqual(dom.form.hidden, false, 'a second poll finished the job');
});


test('an expiry still resets the pane when the page is not on screen', () => {
  // The original point of the listener, which must survive the guard: coming
  // back later should show the pitch, not a form abandoned mid-session.
  const dom = buildDom({ overlayShown: false });
  dom.api.goTo('signin');
  assert.strictEqual(dom.form.hidden, false, 'the form never opened');
  dom.window.dispatch('tlc:auth-expired', { detail: { status: 401 } });
  assert.strictEqual(dom.form.hidden, true,
    'a stale form is still waiting behind the overlay next time it opens');
});

// -------------------------- the locked page has to say why it is showing








test('the attribute that switches the blocks actually hides them', () => {
  // .landingCta is display:flex, which beats the hidden attribute's UA
  // display:none -- both blocks painted at once and the lapsed page showed
  // "Create account" stacked above "Subscribe".
  assert.ok(/\.landingCta\[hidden\][^{]*\{[^}]*display:\s*none/s.test(CSS),
    'a flex container ignores [hidden], so both call-to-action blocks paint');
});

test('there is exactly one access-code input in the document', () => {
  // redeemCode() finds its input with a document-wide querySelector, so a
  // second copy left in the paywall overlay would silently win or lose on DOM
  // order. The row moved to the landing rather than being duplicated.
  // Strip HTML comments first: the markup explains this rule in prose right
  // next to the element, and a bare count matches the explanation too.
  const bare = INDEX.replace(/<!--[\s\S]*?-->/g, '');
  const inputs = bare.split('data-paywall-redeem-input').length - 1;
  assert.strictEqual(inputs, 1, `expected one redeem input, found ${inputs}`);
});

test('the lapsed buttons reuse the paywall module rather than reimplement it', () => {
  // A second implementation of "take their money" is the last thing this file
  // should grow.
  assert.ok(/TlcPaywallModule/.test(LANDING_JS), 'the landing does not defer to the paywall module');
  assert.ok(/triggerCheckout\(\)/.test(LANDING_JS), 'subscribe does not start the real checkout');
  assert.ok(!/\/subscription\/checkout/.test(LANDING_JS),
    'the landing calls the checkout endpoint itself');
});

// --------------------------------------------------- the two boot glitches

test('re-announcing a locked account does not throw the reader back to the top', () => {
  // The paywall says "locked" on more than one event. show() reset scrollTop
  // on every call, so each repeat yanked a driver mid-scroll back to the top
  // of the pitch. Reproduced at 420 -> 0 in a browser before the fix.
  const dom = buildDom();
  dom.api.setLapsed(true);
  dom.pitch.scrollTop = 420;
  dom.api.setLapsed(true);
  dom.api.setLapsed(true);
  assert.strictEqual(dom.pitch.scrollTop, 420,
    'the pitch scrolled back to the top when the lock was re-announced');
});

test('actually opening a pane still starts it at the top', () => {
  // The guard above must not cost the original behaviour: a pane that was
  // scrolled to the bottom last time should not open there.
  const dom = buildDom();
  dom.pitch.scrollTop = 300;
  dom.api.goTo('signup');   // leaves the pitch
  dom.api.goTo('pitch');    // and comes back to it
  assert.strictEqual(dom.pitch.scrollTop, 0, 'a reopened pane kept its old scroll');
});

test('a page that does not know yet shows no call to action', () => {
  // With a token in hand, setAuthUI(false) can run while /me is still in
  // flight, and that used to reveal the signed-out buttons -- the flash of
  // "the old sign in page" before Subscribe replaced it.
  const dom = buildDom();
  dom.api.setResolving();
  const cta = (which) => dom.landing.querySelectorAll('[data-landing-cta]')
    .filter((n) => n.getAttribute('data-landing-cta') === which)[0];
  assert.strictEqual(cta('new').hidden, true, 'signed-out buttons still shown while resolving');
  assert.strictEqual(cta('lapsed').hidden, true, 'subscribe buttons shown before the answer');
  assert.strictEqual(dom.api.isResolving(), true);
});

test('resolving gives way to whichever answer arrives', () => {
  const dom = buildDom();
  const cta = (dm, which) => dm.landing.querySelectorAll('[data-landing-cta]')
    .filter((n) => n.getAttribute('data-landing-cta') === which)[0];

  dom.api.setResolving();
  dom.api.setLapsed(true);
  assert.strictEqual(cta(dom, 'lapsed').hidden, false, 'subscribe never appeared');
  assert.strictEqual(dom.api.isResolving(), false);

  const out = buildDom();
  out.api.setResolving();
  out.api.setLapsed(false);
  assert.strictEqual(cta(out, 'new').hidden, false,
    'a real sign-out left the page with no way to make an account');
});

test('setAuthUI picks the version of the page by whether a token is left', () => {
  // No token means signed out for real. A token still present means the
  // answer is unknown, not that they should be asked to create an account.
  const app = fs.readFileSync(path.join(ROOT, 'app.part10.js'), 'utf8');
  const fn = app.slice(app.indexOf('function setAuthUI'), app.indexOf('function setAuthUI') + 1800);
  assert.ok(/authHeaderOK\(\)/.test(fn), 'setAuthUI does not check for a token before revealing');
  assert.ok(/setResolving/.test(fn), 'a token-present lock still shows the signed-out buttons');
  assert.ok(fn.indexOf('setResolving') < fn.indexOf('classList.toggle("show"'),
    'the mode must be chosen before the overlay is revealed, or it flashes');
});

let failed = 0;
tests.forEach(([name, fn]) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err && err.message}`); }
});
console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);
