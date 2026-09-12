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
const JS_SOURCE = path.join(ROOT, 'landing.js');

const AUTH_IDS = ['authEmail', 'authPass', 'authName', 'authGhost',
  'btnLogin', 'btnSignup', 'authStatus'];

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

function buildDom() {
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

  form.appendChild(make('button', null, { 'data-landing-go': 'pitch' }));
  form.appendChild(make('h2', null, { 'data-landing-title': '' }));
  form.appendChild(make('p', null, { 'data-landing-lede': '' }));
  form.appendChild(make('div', null, { 'data-landing-field': 'name' }));
  form.appendChild(make('span', null, { 'data-landing-hint': '' }));
  form.appendChild(make('div', null, { 'data-landing-promise': '' }));
  form.appendChild(make('p', null, { 'data-landing-swap': '' }));
  form.appendChild(make('input', 'authName'));
  form.appendChild(make('input', 'authEmail'));
  form.appendChild(make('input', 'authPass'));
  form.appendChild(make('input', 'authGhost'));
  form.appendChild(make('button', 'btnSignup', { 'data-landing-submit': 'signup' }));
  form.appendChild(make('button', 'btnLogin', { 'data-landing-submit': 'signin' }));
  form.appendChild(make('div', 'authStatus'));

  landing.appendChild(pitch);
  landing.appendChild(form);
  byId.set('landing', landing);

  const document = {
    readyState: 'complete',
    body: landing,
    getElementById: (id) => byId.get(id) || null,
    createElement: (t) => makeNode(t),
    addEventListener: () => {},
  };
  const window = {
    document, console,
    addEventListener: (t, fn) => { (window._l[t] = window._l[t] || []).push(fn); },
    _l: {},
    dispatch: (t, e) => (window._l[t] || []).forEach((fn) => fn(e)),
  };
  window.window = window;
  const ctx = vm.createContext({ window, document, console });
  vm.runInContext(fs.readFileSync(JS_SOURCE, 'utf8'), ctx, { filename: 'landing.js' });
  return { window, document, byId, landing, pitch, form, api: window.TeamJoseoLanding };
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
  const start = INDEX.indexOf('id="lockedOverlay"');
  const end = INDEX.indexOf('id="paywallOverlay"');
  assert.ok(start > -1 && end > start, 'lockedOverlay still precedes paywallOverlay');
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
  ['.shellMenuBtn', '#dock', '.mapControlStack', '.sliderWrap'].forEach((sel) => {
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
let failed = 0;
tests.forEach(([name, fn]) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err && err.message}`); }
});
console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);
