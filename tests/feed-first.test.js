#!/usr/bin/env node
/**
 * feed-first.test.js — the feed is the screen, the map is a card, the dock
 * still slides.
 *
 * The valuable assertions here are not "a class gets added". They are the four
 * things that would quietly undo the design:
 *
 *   - the dock losing its sideways scroll, which is the one thing that was
 *     asked to be kept,
 *   - the map card and the full map disagreeing about size, because MapLibre
 *     measures its container and not the window,
 *   - landing on the feed even when someone followed a link to somewhere else,
 *   - and the full lock card, which is taller than the card it explains,
 *     landing in the middle of somebody's post.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'feed-first.js');
const SRC = fs.readFileSync(SOURCE, 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'feed-first.css'), 'utf8');
const SHELL_JS = fs.readFileSync(path.join(ROOT, 'app-shell.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// --------------------------------------------------------------------------

function makeNode(tag) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [], parentNode: null, style: {}, hidden: false, id: '',
    type: '', _classes: new Set(), _text: '', _html: '', _attrs: {}, _listeners: {},
    clicks: 0,
  };
  node.classList = {
    add: (...n) => n.forEach((x) => x && node._classes.add(x)),
    remove: (...n) => n.forEach((x) => node._classes.delete(x)),
    contains: (x) => node._classes.has(x),
    toggle: (x, on) => {
      const want = on === undefined ? !node._classes.has(x) : !!on;
      if (want) node._classes.add(x); else node._classes.delete(x);
      return want;
    },
  };
  Object.defineProperty(node, 'className', {
    get() { return [...node._classes].join(' '); },
    set(v) {
      node._classes.clear();
      String(v || '').split(/\s+/).forEach((x) => x && node._classes.add(x));
    },
  });
  Object.defineProperty(node, 'textContent', {
    get() {
      if (node.children.length) return node.children.map((c) => c.textContent).join('');
      return node._text;
    },
    set(v) { node._text = String(v); node.children = []; },
  });
  Object.defineProperty(node, 'innerHTML', {
    get() { return node._html; },
    set(v) { node._html = String(v); },
  });
  node.appendChild = (c) => { c.parentNode = node; node.children.push(c); return c; };
  node.insertBefore = (c, ref) => {
    c.parentNode = node;
    const at = ref ? node.children.indexOf(ref) : -1;
    if (at < 0) node.children.push(c); else node.children.splice(at, 0, c);
    return c;
  };
  node.setAttribute = (k, v) => { node._attrs[k] = String(v); };
  node.getAttribute = (k) => (k in node._attrs ? node._attrs[k] : null);
  node.addEventListener = (t, fn) => { (node._listeners[t] = node._listeners[t] || []).push(fn); };
  node.dispatch = (t, e) => (node._listeners[t] || []).forEach((fn) => fn(e || { type: t }));
  node.click = () => { node.clicks += 1; node.dispatch('click', { type: 'click', target: node }); };
  return node;
}

function build(options = {}) {
  const byId = new Map();
  const body = makeNode('body');
  const timers = [];
  const resizes = [];

  // The dock exactly as index.html ships it: a track with the Save button in
  // the middle of the panel buttons.
  const track = makeNode('div'); track.id = 'dockTrack';
  ['dockColors', 'dockModes', 'dockChat'].forEach((id) => {
    const b = makeNode('button'); b.id = id; track.appendChild(b); byId.set(id, b);
  });
  const save = makeNode('button'); save.id = 'pickupFab';
  track.appendChild(save); byId.set('pickupFab', save);
  ['dockGames', 'dockLeaderboard', 'dockMusic', 'dockProfile'].forEach((id) => {
    const b = makeNode('button'); b.id = id; track.appendChild(b); byId.set(id, b);
  });
  byId.set('dockTrack', track);

  body.appendChild(track);

  // A real getElementById walks the tree. The first cut of this double looked
  // only in a map of nodes built up front, so it could not find the two
  // buttons the file under test creates -- and every assertion about their
  // state failed against code the browser had already been seen to run
  // correctly. A double that cannot see new elements cannot test a file whose
  // job is to add them.
  const findById = (node, id) => {
    if (node.id === id) return node;
    for (const child of node.children) {
      const hit = findById(child, id);
      if (hit) return hit;
    }
    return null;
  };

  const document = {
    readyState: 'complete',
    body,
    createElement: (t) => makeNode(t),
    getElementById: (id) => findById(body, id) || byId.get(id) || null,
    addEventListener: (t, fn) => { (document._l[t] = document._l[t] || []).push(fn); },
    _l: {},
  };

  let currentKey = options.open === undefined ? null : options.open;
  const opened = [];
  const closed = [];

  const window = {
    document, console,
    location: { hash: options.hash || '' },
    TeamJoseoShell: options.noShell ? undefined : {
      current: () => currentKey,
      open: (k) => { opened.push(k); currentKey = k; window.dispatch('tlc:shell-screen-changed', {}); },
      close: () => { closed.push(1); currentKey = null; window.dispatch('tlc:shell-screen-changed', {}); },
    },
    resizeMapToViewport: () => { resizes.push(1); },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    addEventListener: (t, fn) => { (window._l[t] = window._l[t] || []).push(fn); },
    _l: {},
    dispatch: (t, e) => (window._l[t] || []).forEach((fn) => fn(e)),
  };
  window.window = window;

  const ctx = vm.createContext({
    window, document, console,
    localStorage: { getItem: () => (options.token === undefined ? 'a-token' : options.token) },
    Object, Number, Math, Array, String, Date, JSON, Error, Boolean,
  });
  vm.runInContext(SRC, ctx, { filename: 'feed-first.js' });

  return {
    window, document, body, byId, track, timers, resizes, opened, closed,
    el: (id) => document.getElementById(id),
    api: window.TeamJoseoFeedFirst,
    setOpen: (k) => { currentKey = k; window.dispatch('tlc:shell-screen-changed', {}); },
    ids: () => track.children.map((c) => c.id),
  };
}

const tests = [];
const test = (n, f) => tests.push([n, f]);

// --------------------------------------------------------------------------

test('Feed and Map join the dock without displacing anything', () => {
  const dom = build();
  const ids = dom.ids();
  ['dockColors', 'dockModes', 'dockChat', 'pickupFab', 'dockGames',
    'dockLeaderboard', 'dockMusic', 'dockProfile'].forEach((id) => {
    assert.ok(ids.includes(id), `the dock lost ${id}`);
  });
  assert.ok(ids.includes('dockFeed') && ids.includes('dockMap'), 'no navigation in the dock');
});

test('they sit next to Save, because the dock re-centres on Save', () => {
  // app.part6.js scrolls the dock back to Save after ten seconds of no
  // interaction. Navigation put anywhere else drifts off the edge on its own.
  const ids = build().ids();
  const save = ids.indexOf('pickupFab');
  assert.strictEqual(ids[save - 2], 'dockFeed', ids.join(','));
  assert.strictEqual(ids[save - 1], 'dockMap', ids.join(','));
});

test('the dock keeps its own behaviour', () => {
  // The sideways slide, the scroll hints and the auto-recentre live in
  // app.part6.js. This file appends two buttons and touches none of it.
  assert.ok(!/scrollLeft|scrollTo|scrollBy|centerDock|ScrollHint/.test(SRC),
    'feed-first.js reaches into the dock scroller');
  assert.ok(!/display\s*:\s*none[^}]*#dock\b/.test(CSS), 'the dock gets hidden somewhere');
  assert.ok(!/overflow-x\s*:\s*(hidden|visible)/.test(CSS),
    'the dock viewport overflow is being overridden');
});

test('the feed is home, and only the feed', () => {
  const dom = build({ open: 'feed' });
  assert.ok(dom.body.classList.contains('feed-first'));
  dom.setOpen('chat');
  assert.ok(!dom.body.classList.contains('feed-first'),
    'chat got the map card too');
  dom.setOpen(null);
  assert.ok(!dom.body.classList.contains('feed-first'), 'the full map kept the card layout');
});

test('the dock says which of the two you are on', () => {
  const dom = build({ open: 'feed' });
  assert.ok(dom.el('dockFeed').classList.contains('on'));
  assert.ok(!dom.el('dockMap').classList.contains('on'));
  dom.setOpen(null);
  assert.ok(dom.el('dockMap').classList.contains('on'), 'nothing marks the map');
  assert.ok(!dom.el('dockFeed').classList.contains('on'));
});

test('neither is marked while you are somewhere else entirely', () => {
  const dom = build({ open: 'chat' });
  assert.ok(!dom.el('dockFeed').classList.contains('on'));
  assert.ok(!dom.el('dockMap').classList.contains('on'),
    'the map reads as current while chat is covering it');
});

test('the two buttons go where they say', () => {
  const dom = build({ open: 'feed' });
  dom.el('dockMap').click();
  assert.strictEqual(dom.closed.length, 1, 'Map did not open the map');
  dom.el('dockFeed').click();
  assert.deepStrictEqual(dom.opened.slice(-1), ['feed']);
});

test('the map is re-measured when it changes size', () => {
  // MapLibre measures its container, not the window. Without this the canvas
  // keeps drawing at whichever size it was when the switch happened -- a 30%
  // card rendered at full-screen, or the reverse.
  const dom = build({ open: null });
  const before = dom.resizes.length;
  dom.setOpen('feed');
  assert.ok(dom.resizes.length > before, 'nothing re-measured on the way into the card');
  const mid = dom.resizes.length;
  dom.setOpen(null);
  assert.ok(dom.resizes.length > mid, 'nothing re-measured on the way back out');
});

test('re-measuring only happens when the layout actually changed', () => {
  const dom = build({ open: 'feed' });
  const before = dom.resizes.length;
  dom.setOpen('feed');
  assert.strictEqual(dom.resizes.length, before, 'it re-measures on every event');
});

test('a signed-in driver lands on the feed', () => {
  const dom = build({ open: null });
  assert.deepStrictEqual(dom.opened, ['feed']);
});

test('a deep link wins over the feed', () => {
  // A bookmark to #/chat has to survive, or the hash is decoration.
  const dom = build({ open: null, hash: '#/chat' });
  assert.deepStrictEqual(dom.opened, [], 'it overrode the link someone followed');
});

test('a signed-out visitor is not sent to the feed', () => {
  // They are looking at the welcome page and have no posts of their own.
  const dom = build({ open: null, token: '' });
  assert.deepStrictEqual(dom.opened, []);
});

test('it only lands them there once', () => {
  const dom = build({ open: null });
  dom.window.dispatch('tlc:auth-state-changed', {});
  dom.window.dispatch('tlc:auth-state-changed', {});
  assert.deepStrictEqual(dom.opened, ['feed'],
    'every /me refresh yanked them back to the feed');
});

test('it survives the shell not being there', () => {
  assert.doesNotThrow(() => build({ noShell: true }));
});

test('the card has a way into the full map', () => {
  const dom = build({ open: 'feed' });
  const tap = dom.body.children.filter((c) => c.id === 'mapCardOpen')[0];
  assert.ok(tap, 'the card is not tappable');
  assert.ok(tap.getAttribute('aria-label'), 'it announces nothing');
  tap.click();
  assert.strictEqual(dom.closed.length, 1, 'tapping the card did nothing');
});

// --------------------------------------------------------------------------
// layout
// --------------------------------------------------------------------------

const rule = (sel) => {
  const m = CSS.match(new RegExp('(^|[}\\n])\\s*'
    + sel.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'm'));
  assert.ok(m, `no rule for "${sel}"`);
  return m[2];
};

test('the dock is above the feed, not merely displayed', () => {
  // It sits at 3000 and .shellScreen at 9200, so un-hiding it left it buried
  // under an opaque panel -- present in the layout, invisible on screen.
  assert.ok(/body\.feed-first\.shell-screen-open #dock\s*\{[^}]*display:\s*block/s.test(CSS),
    'the dock is still hidden while the feed is open');
  const z = Number((rule('body.feed-first #dock').match(/z-index:\s*(\d+)/) || [])[1]);
  assert.ok(Number.isFinite(z) && z > 9200, `z-index ${z} leaves the dock under the feed`);
});

test('the buttons are solid over text', () => {
  // rgba(240,240,240,0.95) is invisible as translucency over a map and a smear
  // over someone's post.
  assert.ok(/body\.feed-first \.dockBtn:not\(\.dockBtnSave\)\s*\{[^}]*background:\s*#ffffff/s.test(CSS),
    'the dock buttons are still translucent over the feed');
  assert.ok(/#dock::before/.test(CSS), 'nothing fades the feed out under the dock');
});

test('Save keeps its gradient', () => {
  // This file loads last, so a bare .dockBtn background rule would beat
  // .dockBtnSave and turn the one coloured thing in the app white.
  const m = CSS.match(/\.dockBtn:not\(\.dockBtnSave\)/);
  assert.ok(m, 'the opaque rule no longer excludes Save');
});

test('the card and the screen under it share one measurement', () => {
  const vars = rule('body.feed-first');
  assert.ok(/--tj-card-h/.test(vars), 'the card height is not a variable');
  assert.ok(/var\(--tj-card-h\)/.test(rule('body.feed-first #map')), 'the card ignores it');
  assert.ok(/var\(--tj-card-h\)/.test(rule('body.feed-first #shellScreens')),
    'the feed does not start where the card ends');
});

test('the full lock card never lands on the feed', () => {
  // It is Subscribe plus a redeem row plus Manage subscription -- taller than
  // the card it would be explaining, and centred on the viewport.
  assert.ok(/html\.tj-map-locked body\.feed-first #mapLockCard\s*\{[^}]*display:\s*none/s.test(CSS),
    'the full lock card floats over someone\'s post');
  assert.ok(/#mapCardLocked/.test(CSS) && /mapCardLocked/.test(SRC),
    'a blurred card with nothing to explain it');
});

test('the shell says which destination is open', () => {
  // feed-first.js cannot ask the hash: a lock screen sets none, and neither
  // does a pushHash:false open.
  assert.ok(/tlc:shell-screen-changed/.test(SHELL_JS), 'the shell announces nothing');
  assert.ok(/current: function/.test(SHELL_JS), 'the shell will not say what is open');
  assert.ok(/tlc:shell-screen-changed/.test(SRC), 'feed-first.js is guessing instead');
});

test('both files ship', () => {
  assert.ok(INDEX.includes('"./feed-first.css"'), 'css not loaded');
  assert.ok(INDEX.includes('"./feed-first.js"'), 'script not loaded');
  const css = INDEX.indexOf('"./feed-first.css"');
  const shell = INDEX.indexOf('"./app-shell.css"');
  assert.ok(css > shell, 'feed-first.css loads before app-shell.css and loses the cascade');
});

let failed = 0;
tests.forEach(([name, fn]) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err && err.message}`); }
});
console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);
