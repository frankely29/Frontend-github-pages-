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
// app.part6.js owns the dock scroller: the hints, and the auto-centre on Save.
const PART6 = fs.readFileSync(path.join(ROOT, 'app.part6.js'), 'utf8');

// --------------------------------------------------------------------------
// The dock's offset and every clearance that has to match it come from two
// custom properties now, so reading a literal px out of the rule finds nothing.
// Resolve them here instead of loosening the assertions: INDICATOR is the
// safe-area inset on a home-indicator phone, which is the case these numbers
// exist for and the one no browser here can reproduce.
const INDICATOR = 34;

function rootToken(name) {
  const block = CSS.match(/body\.feed-first\s*\{([\s\S]*?)\n\}/);
  assert.ok(block, 'no body.feed-first token block');
  const m = block[1].match(new RegExp('--' + name + ':\\s*([^;]+);'));
  assert.ok(m, `--${name} is not declared`);
  return m[1].trim();
}

// max(Npx, calc(env(safe-area-inset-bottom, 0px) - Mpx)) -> { floor, onIndicator }
function dockLift() {
  const raw = rootToken('tj-dock-lift');
  assert.ok(/safe-area-inset-bottom/.test(raw), 'the dock ignores the home indicator');
  const floor = Number((raw.match(/max\(\s*(\d+)px/) || [])[1]);
  const sub = Number((raw.match(/-\s*(\d+)px/) || [])[1]);
  assert.ok(Number.isFinite(floor) && Number.isFinite(sub),
    `--tj-dock-lift is not the shape these tests read: ${raw}`);
  return { raw, floor, onIndicator: Math.max(floor, INDICATOR - sub) };
}

// calc(var(--tj-dock-lift) + Npx) -> px on a home-indicator phone
function dockClear() {
  const raw = rootToken('tj-dock-clear');
  assert.ok(/var\(--tj-dock-lift\)/.test(raw), 'the clearance does not follow the dock');
  const air = Number((raw.match(/\+\s*(\d+)px/) || [])[1]);
  assert.ok(Number.isFinite(air), `--tj-dock-clear is not the shape these tests read: ${raw}`);
  return { raw, air, onIndicator: dockLift().onIndicator + air };
}

// --------------------------------------------------------------------------

function makeNode(tag) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [], parentNode: null, style: {}, hidden: false, id: '',
    type: '', _classes: new Set(), _text: '', _html: '', _attrs: {}, _listeners: {},
    clicks: 0,
  };
  // The file writes the split as a custom property. A plain object for `style`
  // has no setProperty, and without it every split assertion would read
  // undefined and pass on nothing.
  node.style.setProperty = (k, v) => { node.style[k] = String(v); };
  node.style.getPropertyValue = (k) => node.style[k] || '';
  node.setPointerCapture = () => {};
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
  /* appendChild MOVES a node that already has a parent -- it does not copy it.
   *
   * This double pushed without unlinking, so re-appending the dock's own
   * buttons to put them in order duplicated every one of them instead of
   * moving it. The order code is right and the double was lying about the one
   * piece of DOM behaviour it depends on. */
  const unlink = (c) => {
    if (!c || !c.parentNode) return;
    const at = c.parentNode.children.indexOf(c);
    if (at >= 0) c.parentNode.children.splice(at, 1);
    c.parentNode = null;
  };
  node.appendChild = (c) => { unlink(c); c.parentNode = node; node.children.push(c); return c; };
  node.insertBefore = (c, ref) => {
    unlink(c);
    c.parentNode = node;
    const at = ref ? node.children.indexOf(ref) : -1;
    if (at < 0) node.children.push(c); else node.children.splice(at, 0, c);
    return c;
  };
  node.removeChild = (c) => {
    const at = node.children.indexOf(c);
    if (at >= 0) { node.children.splice(at, 1); c.parentNode = null; }
    return c;
  };
  node.setAttribute = (k, v) => { node._attrs[k] = String(v); };
  node.getAttribute = (k) => (k in node._attrs ? node._attrs[k] : null);
  node.addEventListener = (t, fn) => { (node._listeners[t] = node._listeners[t] || []).push(fn); };
  node.dispatch = (t, e) => (node._listeners[t] || []).forEach((fn) => fn(e || { type: t }));
  node.click = () => { node.clicks += 1; node.dispatch('click', { type: 'click', target: node }); };
  // Scrolling the composer up past the dock reads a box and writes scrollTop.
  // A test giving a node no box would make revealComposer() return early and
  // the assertion pass on nothing, which is how this double has lied before.
  node.scrollTop = 0;
  node.getBoundingClientRect = () => Object.assign(
    { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }, node._box || {});
  node.querySelector = (sel) => selectAll(node, sel)[0] || null;
  node.querySelectorAll = (sel) => selectAll(node, sel);
  return node;
}

/* A selector engine small enough to read and big enough to be honest.
 *
 * It handles what feed-first.js actually asks for: comma lists, descendant
 * chains, #id, .class and [attr="value"]. The previous double understood one
 * bare #id or .class, so "#shellScreens .shellScreenBody" matched nothing and
 * returned null -- and a test written against it would have passed whether or
 * not the code worked. */
function matchesStep(node, step) {
  const parts = String(step).match(/#[\w-]+|\.[\w-]+|\[[^\]]+\]/g) || [];
  if (!parts.length) return false;
  return parts.every((part) => {
    if (part[0] === '#') return node.id === part.slice(1);
    if (part[0] === '.') return !!(node.classList && node.classList.contains(part.slice(1)));
    const m = part.match(/^\[([^=\]]+)(?:=["']?([^"'\]]*)["']?)?\]$/);
    if (!m) return false;
    const got = node.getAttribute ? node.getAttribute(m[1]) : null;
    return m[2] === undefined ? got !== null : got === m[2];
  });
}

function selectAll(root, sel) {
  const out = [];
  String(sel).split(',').forEach((one) => {
    const steps = one.trim().split(/\s+/).filter(Boolean);
    if (!steps.length) return;
    let scope = [root];
    steps.forEach((step) => {
      const next = [];
      scope.forEach((node) => {
        const walk = (n) => {
          if (n !== node && matchesStep(n, step) && next.indexOf(n) < 0) next.push(n);
          (n.children || []).forEach(walk);
        };
        walk(node);
      });
      scope = next;
    });
    scope.forEach((n) => { if (out.indexOf(n) < 0) out.push(n); });
  });
  return out;
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

  // The seven panels that share one container. Under Feed First it wears the
  // same geometry as the feed's screen, so the double needs it to test that.
  const drawer = makeNode('div'); drawer.id = 'dockDrawer';
  const drawerClose = makeNode('button'); drawerClose.id = 'dockDrawerClose';
  drawer.appendChild(drawerClose);
  body.appendChild(drawer);

  /* The feed's own screen, with one post card and the boxes a phone would
   * report for them. The numbers are the ones measured off a 956pt screen:
   * the dock's top edge is at 862 and the sheet's scroller runs to the bottom
   * behind it, which is exactly why an opened composer can sit under the
   * icons and still be inside its container. */
  const dock = makeNode('div'); dock.id = 'dock';
  dock._box = { top: 862, bottom: 936, height: 74 };
  body.appendChild(dock); byId.set('dock', dock);

  const screens = makeNode('div'); screens.id = 'shellScreens';
  const screenBody = makeNode('div'); screenBody.className = 'shellScreenBody';
  screenBody._box = { top: 616, bottom: 956, height: 340 };
  const card = makeNode('article'); card.className = 'feedCard';
  card.setAttribute('data-post-id', '1');
  const replyRow = makeNode('div'); replyRow.className = 'feedReplyRow';
  // A box inside a scroller moves when the scroller scrolls. Without that the
  // three passes revealComposer() makes would each subtract the same overlap
  // again and the test would demand a number no browser produces.
  const replyBase = Object.assign({ top: 874, bottom: 930, height: 56 },
    options.replyBox || {});
  replyRow.getBoundingClientRect = () => ({
    top: replyBase.top - screenBody.scrollTop,
    bottom: replyBase.bottom - screenBody.scrollTop,
    height: replyBase.height, left: 0, right: 0, width: 0,
  });
  card.appendChild(replyRow);
  screenBody.appendChild(card);
  screens.appendChild(screenBody);
  body.appendChild(screens);
  byId.set('shellScreens', screens);

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
    // The sheet hosts are addressed by selector now (#dockDrawer,
    // #driverProfileModalRoot, .adminPortal), so the double needs the one
    // lookup it never had. Without it every host reads as absent and the
    // assertions fail against code the browser runs correctly.
    querySelector: (sel) => selectAll(body, sel)[0] || null,
    querySelectorAll: (sel) => selectAll(body, sel),
    hidden: false,
    documentElement: makeNode('html'),
    activeElement: null,
    addEventListener: (t, fn) => { (document._l[t] = document._l[t] || []).push(fn); },
    _l: {},
  };

  let currentKey = options.open === undefined ? null : options.open;
  const opened = [];
  const closed = [];

  drawerClose.addEventListener('click', () => {
    drawer.classList.remove('open');
    window.dispatch('tlc:drawer-changed', { detail: { key: null } });
  });

  const window = {
    document, console,
    location: { hash: options.hash || '' },
    TeamJoseoShell: options.noShell ? undefined : {
      current: () => currentKey,
      open: (k) => { opened.push(k); currentKey = k; window.dispatch('tlc:shell-screen-changed', {}); },
      close: () => { closed.push(1); currentKey = null; window.dispatch('tlc:shell-screen-changed', {}); },
    },
    resizeMapToViewport: () => { resizes.push(1); },
    innerHeight: 956,
    innerWidth: 440,
    scrollY: 0,
    scrollTo: (x, y) => { window.scrollY = y; },
    /* The keyboard, as the browser reports it. height is what is left on
     * screen; offsetTop is how far iOS has slid the window down inside the
     * layout viewport to reveal a field near the bottom. Both are needed --
     * the bug was reading them as one number. */
    visualViewport: Object.assign(
      { height: 956, offsetTop: 0, addEventListener: () => {} },
      options.vv || {}),
    /* The window against the screen it is painted in. Equal here: a short
     * window is the bug, so a test that wants one says so. */
    screen: { height: options.screenHeight === undefined ? 956 : options.screenHeight },
    navigator: { standalone: options.standalone !== false },
    matchMedia: () => ({ matches: options.standalone !== false }),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    addEventListener: (t, fn) => { (window._l[t] = window._l[t] || []).push(fn); },
    _l: {},
    dispatch: (t, e) => (window._l[t] || []).forEach((fn) => fn(e)),
  };
  window.window = window;

  const store = Object.assign({
    community_token_v1: options.token === undefined ? 'a-token' : options.token,
  }, options.storage || {});

  const ctx = vm.createContext({
    window, document, console,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    Object, Number, Math, Array, String, Date, JSON, Error, Boolean,
  });
  vm.runInContext(SRC, ctx, { filename: 'feed-first.js' });

  return {
    window, document, body, byId, track, timers, resizes, opened, closed, store,
    drawer, dock, screenBody, replyRow,
    openThread: (postId) => window.dispatch('tlc:feed-thread-opened',
      { detail: { postId: postId === undefined ? 1 : postId } }),
    runTimers: () => { const due = timers.splice(0); due.forEach((t) => t.fn()); },
    openDrawer: (key) => {
      drawer.classList.add('open');
      window.dispatch('tlc:drawer-changed', { detail: { key } });
    },
    el: (id) => document.getElementById(id),
    split: () => Number(String(body.style['--tj-split'] || '').replace('%', '')),
    handle: () => document.getElementById('tjSheetHandle'),
    drag: (dy) => {
      const h = document.getElementById('tjSheetHandle');
      h.dispatch('pointerdown', { button: 0, clientY: 400 });
      h.dispatch('pointermove', { clientY: 400 + dy, preventDefault() {} });
      h.dispatch('pointerup', { clientY: 400 + dy });
    },
    tap: () => {
      const h = document.getElementById('tjSheetHandle');
      h.dispatch('pointerdown', { button: 0, clientY: 400 });
      h.dispatch('pointerup', { clientY: 400 });
    },
    api: window.TeamJoseoFeedFirst,
    setOpen: (k) => { currentKey = k; window.dispatch('tlc:shell-screen-changed', {}); },
    ids: () => track.children.map((c) => c.id),
  };
}

const tests = [];
const test = (n, f) => tests.push([n, f]);

// The two detents come from the module, so moving one is a one-line change in
// feed-first.js rather than a search-and-replace through forty assertions.
// Their actual values are pinned once each, against the geometry they exist to
// satisfy -- see 'the minimised feed clears the dock'.
let _detents = null;
function detents() {
  if (!_detents) _detents = build({ open: 'feed' }).api.detents;
  return _detents;
}
const MIN = () => Math.round(detents().minimized * 100);
const EXP = () => Math.round(detents().expanded * 100);

// --------------------------------------------------------------------------

test('the dock keeps five and stashes the rest, losing none of them', () => {
  /* The dock and the menu used to list the same eleven things. The dock now
   * holds what you touch while driving; everything else belongs to the menu.
   *
   * Stashed, not deleted, and deliberately so: app-shell.js opens a dock-backed
   * destination by calling .click() on its button, so the button IS the API.
   * Deleting these nodes would make Colours, Modes, Games, Profile and Admin
   * unreachable from the menu that now owns them. */
  const dom = build();
  const ids = dom.ids();
  assert.deepStrictEqual(ids,
    ['dockLeaderboard', 'dockFeed', 'pickupFab', 'dockChat', 'dockMusic'],
    'the dock is not the five it was asked for');

  const holder = dom.document.getElementById('dockStash');
  assert.ok(holder, 'nothing was stashed');
  const stashed = holder.children.map((c) => c.id);
  ['dockColors', 'dockModes', 'dockMap', 'dockGames', 'dockProfile']
    .forEach((id) => {
      assert.ok(stashed.includes(id), `${id} was lost rather than stashed`);
      assert.ok(dom.document.getElementById(id), `${id} is gone from the document`);
    });
  assert.strictEqual(holder.hidden, true, 'the stash is on screen');
});

test('Feed sits next to Save, because the dock re-centres on Save', () => {
  /* app.part6.js scrolls the dock back to Save after ten seconds of no
   * interaction, so whatever is beside Save is what a driver always finds
   * without scrolling.
   *
   * This used to require Map beside Save too. It no longer does: the order was
   * specified as Games left of Feed, which puts Map one further out. Feed is
   * the one that has to stay adjacent -- it is home. */
  const ids = build().ids();
  const save = ids.indexOf('pickupFab');
  assert.strictEqual(ids[save - 1], 'dockFeed', ids.join(','));
  // Map is no longer beside it, or in the dock at all -- dragging the sheet
  // down already goes to the map, so the button was a second way to do one
  // thing. It lives in the menu now, and in the stash in the DOM.
  assert.strictEqual(ids.indexOf('dockMap'), -1, 'Map is still in the dock: ' + ids.join(','));
});

test('the dock keeps its own behaviour', () => {
  // The sideways slide, the scroll hints and the auto-recentre live in
  // app.part6.js. This file appends two buttons and touches none of it.
  // Named precisely. A bare /scrollTo/ also matched window.scrollTo(0, 0),
  // which undoes iOS's own scroll when the keyboard opens and has nothing to
  // do with the dock -- so the test failed on a change it was not about.
  // #dockViewport is the scroller; #dockTrack is only where the two buttons
  // are appended, which is the documented job and is asserted above. Naming
  // the track here made the test fail on the feature it exists to protect.
  //
  // updateDockScrollHints is the one exception, and it is not a reach into the
  // scroller: it measures the track's overflow and toggles two classes. It
  // moves nothing and arms no timer. This file is the only thing that knows
  // when buttons leave the row, so it is the only thing that can say so -- the
  // alternative was a standing ResizeObserver over there, which also armed the
  // auto-centre and had the dock sliding by itself. Everything that actually
  // MOVES the dock is still app.part6.js's alone, and still barred here.
  assert.ok(!/dockViewport|scrollLeft|scrollBy|centerDock/.test(SRC),
    'feed-first.js reaches into the dock scroller');
  assert.ok(!/ScrollHint/.test(SRC.replace(/updateDockScrollHints/g, '')),
    'feed-first.js touches the scroll hints by some other route');
  assert.ok(!/display\s*:\s*none[^}]*#dock\b/.test(CSS), 'the dock gets hidden somewhere');
  assert.ok(!/overflow-x\s*:\s*(hidden|visible)/.test(CSS),
    'the dock viewport overflow is being overridden');
});

test('there is one interface and it never comes off', () => {
  /* This used to come off whenever no destination was open, and the OLD
   * map-first app is still underneath: the hamburger, the locate and report
   * pair, the FROM DRIVERS card, the answer pill at the bottom and the
   * time-machine scrubber. Every one of those is hidden by a body.feed-first
   * rule, so the class coming off put the whole other interface back. Caught
   * on video: tapping Map switched apps.
   *
   * The map with nothing over it is the sheet minimised, not a second app. */
  const dom = build({ open: 'feed' });
  assert.ok(dom.body.classList.contains('feed-first'));
  dom.setOpen('post');
  assert.ok(dom.body.classList.contains('feed-first'), 'posting fell out of the sheet');
  dom.setOpen(null);
  assert.ok(dom.body.classList.contains('feed-first'),
    'the old map-first interface came back');
  dom.openDrawer('chat');
  assert.ok(dom.body.classList.contains('feed-first'), 'chat fell out of the sheet');
});

test('a dock panel is the sheet too', () => {
  // Chat, board, games, music, colours, modes and profile share one container,
  // so this is one rule rather than seven rewrites.
  const dom = build({ open: null });
  dom.openDrawer('chat');
  assert.ok(dom.body.classList.contains('feed-first'),
    'chat opened as a floating card again');
});

test('opening a panel leaves the feed, closing one goes back to it', () => {
  // The feed screen and the drawer are different elements at the same layer,
  // so with both open the feed sat on top of the panel the driver just asked
  // for. "The feed changes to the chat box" has to mean one occupant.
  const dom = build({ open: 'feed' });
  dom.openDrawer('chat');
  assert.strictEqual(dom.closed.length, 1, 'the feed stayed open under the panel');
  dom.el('dockDrawerClose').click();
  assert.deepStrictEqual(dom.opened.slice(-1), ['feed'], 'closing chat left a blank map');
});

test('the dock says which panel you are in, not just that the sheet is up', () => {
  const dom = build({ open: 'feed' });
  dom.tap();   // up off the minimised detent, which is where the feed opens
  assert.ok(dom.el('dockFeed').classList.contains('on'));
  dom.openDrawer('chat');
  assert.ok(!dom.el('dockFeed').classList.contains('on'),
    'Feed reads as current while chat is in the sheet');
  assert.ok(!dom.el('dockMap').classList.contains('on'),
    'the map reads as current while a panel covers it');
});

test('Feed and Map dismiss whatever panel is in the sheet', () => {
  const dom = build({ open: null });
  dom.openDrawer('chat');
  dom.el('dockFeed').click();
  assert.ok(!dom.drawer.classList.contains('open'), 'chat stayed open behind the feed');
  dom.openDrawer('games');
  dom.el('dockMap').click();
  assert.ok(!dom.drawer.classList.contains('open'), 'games stayed open over the map');
});

test('the dock says which of the two you are looking at', () => {
  /* Both used to be destinations, and one of them was "the shell is closed".
   * Now the sheet is always up and the only question is how far: pulled up is
   * the feed, pushed down is the map. */
  const dom = build({ open: 'feed' });
  assert.ok(dom.el('dockMap').classList.contains('on'),
    'the feed opens minimised, so the map is what is on screen');
  assert.ok(!dom.el('dockFeed').classList.contains('on'));
  dom.tap();
  assert.ok(dom.el('dockFeed').classList.contains('on'), 'nothing marks the feed');
  assert.ok(!dom.el('dockMap').classList.contains('on'));
});

test('neither is marked while you are somewhere else entirely', () => {
  const dom = build({ open: 'feed' });
  dom.openDrawer('chat');
  assert.ok(!dom.el('dockFeed').classList.contains('on'));
  assert.ok(!dom.el('dockMap').classList.contains('on'),
    'the map reads as current while chat is covering it');
});

test('Map moves the sheet, it does not leave', () => {
  /* Map called shell.close(), and closing the shell is exactly what brought
   * the old interface back. It pushes the sheet down to the map instead. */
  const dom = build({ open: 'feed' });
  dom.tap();
  assert.strictEqual(dom.split(), EXP(), 'precondition: pulled up');
  const closedBefore = dom.closed.length;
  dom.el('dockMap').click();
  assert.strictEqual(dom.closed.length, closedBefore, 'Map closed the shell');
  assert.strictEqual(dom.split(), MIN(), 'Map did not push the sheet down');
  assert.deepStrictEqual(dom.opened.slice(-1), ['feed'], 'Map left the feed behind');
  dom.el('dockFeed').click();
  assert.deepStrictEqual(dom.opened.slice(-1), ['feed']);
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

// --------------------------------------------------------------------------
// the sheet
// --------------------------------------------------------------------------

test('it opens minimised', () => {
  // The map is what a driver opens the app for; the feed is what they look at
  // while they wait. Starting expanded put two thirds of the first behind two
  // thirds of the second.
  const dom = build({ open: 'feed' });
  assert.strictEqual(dom.split(), MIN(), 'the sheet does not open minimised');
  assert.ok(dom.body.classList.contains('tj-min'));
});

test('the minimised feed clears the dock', () => {
  /* This is the only assertion that pins the number rather than following it,
   * and it pins it against what it exists for.
   *
   * At 66% the sheet's top edge was 631pt down a 956pt screen and the dock's
   * top edge is at 862, leaving 231pt: 42 for the handle, ~44 for the scope
   * chips, and a post card is ~180. So the card's own last row -- like and
   * Reply -- landed at 875, 13pt under the icons. Measured off a screenshot.
   *
   * Whatever the detent is, the first card has to finish above the dock. */
  const SCREEN = 956;
  const dockTop = SCREEN - dockLift().onIndicator - 74;   // the dock box is 74 tall
  const handle = 42;                                      // .shellScreenBody padding-top
  const chips = 44;                                       // the scope row
  const card = 180;                                       // one post, avatar row to actions
  const top = (MIN() / 100) * SCREEN;
  const lastRow = top + handle + chips + card;
  assert.ok(lastRow <= dockTop - 8,
    `the first card's last row lands at ${Math.round(lastRow)}pt, ` +
    `under a dock whose top edge is at ${dockTop}pt`);
  // And not so high that minimised stops being minimised -- the map is what
  // they opened the app for.
  assert.ok(MIN() >= 55, `minimised leaves only ${MIN()}% of the map`);
});

test('expanded is 15% shorter than what was drawn', () => {
  // The approved drawing had the sheet starting at 28%, so 72% of the screen.
  // 15% less than that is 61.2%, which starts at 38.8% -- 39.
  const dom = build({ open: 'feed' });
  dom.tap();
  const tall = 100 - dom.split();
  const asked = (100 - 28) * 0.85;
  assert.ok(Math.abs(tall - asked) < 1.5,
    `expanded is ${tall}% tall, not ${asked.toFixed(1)}%`);
});

test('dragging it down snaps it to minimised', () => {
  const dom = build({ open: 'feed' });
  dom.tap();
  assert.strictEqual(dom.split(), EXP(), 'precondition: expanded');
  dom.drag(260);
  assert.strictEqual(dom.split(), MIN(), 'it did not snap to the minimised detent');
  assert.ok(dom.body.classList.contains('tj-min'), 'nothing marks the minimised state');
});

test('a short drag falls back to where it started', () => {
  // Snapping to the nearest detent, not to wherever the finger stopped.
  const dom = build({ open: 'feed' });
  dom.drag(-40);
  assert.strictEqual(dom.split(), MIN(), 'a nudge moved it to the wrong detent');
});

test('dragging it back up expands it again', () => {
  const dom = build({ open: 'feed' });
  dom.drag(260);
  dom.drag(-260);
  assert.strictEqual(dom.split(), EXP());
  assert.ok(!dom.body.classList.contains('tj-min'));
});

test('a tap toggles, a drag does not', () => {
  // Four pixels of slop, so a tap that wobbles is still a tap.
  const dom = build({ open: 'feed' });
  dom.tap();
  assert.strictEqual(dom.split(), EXP(), 'tapping the handle did nothing');
  dom.tap();
  assert.strictEqual(dom.split(), MIN());
});

test('the arrow points where the sheet will go', () => {
  // Down while the feed is up, up while it is down. The CSS rotates it off
  // body.tj-min, so the class is the whole contract.
  const dom = build({ open: 'feed' });
  assert.ok(dom.body.classList.contains('tj-min'), 'arrow would point down with the feed down');
  dom.tap();
  assert.ok(!dom.body.classList.contains('tj-min'), 'arrow would point up with the feed up');
  assert.ok(/body\.feed-first\.tj-min #tjSheetHandle \.tjArrow[^}]*rotate\(180deg\)/s.test(CSS),
    'nothing flips the arrow');
});

test('the arrow nudges, with a shadow, until it has been used', () => {
  const dom = build({ open: 'feed' });
  assert.ok(dom.handle().classList.contains('tj-hint'), 'the arrow never nudges');
  dom.tap(); dom.tap(); dom.tap();
  assert.ok(!dom.handle().classList.contains('tj-hint'),
    'a hint that never goes away has stopped being a hint');
  assert.ok(/@keyframes tjNudge/.test(CSS), 'no nudge animation');
  assert.ok(/\.tjArrow\s*\{[^}]*drop-shadow/s.test(CSS), 'the arrow has no shadow');
});

test('a driver who has used it before is not nudged again', () => {
  const dom = build({ open: 'feed', storage: { tj_sheet_hints_v1: '3' } });
  assert.ok(!dom.handle().classList.contains('tj-hint'));
});

test('the feed always opens minimised, whatever happened last time', () => {
  // It used to reopen wherever it was last left, so a driver who had pulled it
  // up once got a two-thirds-covered map every time they came back. Entering
  // the map is the moment you want the map.
  const dom = build({ open: 'feed', storage: { tj_sheet_split_v1: '0.39' } });
  assert.strictEqual(dom.split(), MIN(), 'a stale stored split still moves the feed');
});

test('dragging the feed holds while you are on it', () => {
  const dom = build({ open: 'feed' });
  dom.tap();
  assert.strictEqual(dom.split(), EXP(), 'the feed cannot be pulled up');
  dom.window.dispatch('tlc:auth-state-changed', {});
  assert.strictEqual(dom.split(), EXP(), 'a refresh collapsed it again');
});

test('replying pulls the sheet up', () => {
  /* Tapping Reply adds a divider, the replies and a composer to the bottom of
   * a card that was already the last thing above the dock, so the field lands
   * under the icons. Reported as "it expands down behind the icons".
   *
   * Moving the minimised detent far enough to fit a composer would cost half
   * the map for something that lasts as long as one reply -- and would fail
   * again on a thread with three of them. The expanded detent is what this is
   * for. */
  const dom = build({ open: 'feed' });
  assert.strictEqual(dom.split(), MIN(), 'precondition: minimised');
  dom.openThread(1);
  assert.strictEqual(dom.split(), EXP(), 'the sheet stayed down over the composer');
});

test('the composer is scrolled out from under the dock', () => {
  // The dock floats over the sheet, so the feed's own bottom edge is not the
  // line that matters. The reply row's box ends at 930 and the dock's top edge
  // is at 862, so 80px have to come off -- 68 of overlap and 12 of air.
  const dom = build({ open: 'feed' });
  dom.openThread(1);
  dom.runTimers();
  assert.strictEqual(dom.screenBody.scrollTop, 80,
    `scrolled to ${dom.screenBody.scrollTop}, leaving the composer under the dock`);
});

test('a composer already in the clear is not yanked around', () => {
  const dom = build({ open: 'feed', replyBox: { top: 700, bottom: 756, height: 56 } });
  dom.openThread(1);
  dom.runTimers();
  assert.strictEqual(dom.screenBody.scrollTop, 0, 'it scrolled for nothing');
});

test('the thread that opened is the one that gets revealed', () => {
  // With two threads open, the first .feedReplyRow in the document is not
  // necessarily the one a driver just asked for.
  const dom = build({ open: 'feed' });
  const other = dom.document.createElement('article');
  other.className = 'feedCard';
  other.setAttribute('data-post-id', '2');
  const row = dom.document.createElement('div');
  row.className = 'feedReplyRow';
  // Already clear of the dock, and LAST in the document -- so both "the first
  // reply row on screen" and "the last one" pick it over the card the driver
  // actually tapped, and either shortcut leaves the real composer buried.
  row._box = { top: 644, bottom: 700, height: 56 };
  other.appendChild(row);
  dom.screenBody.appendChild(other);
  dom.openThread(1);
  dom.runTimers();
  assert.strictEqual(dom.screenBody.scrollTop, 80,
    'it revealed somebody else\'s thread');
});

test('a panel opens expanded, the feed opens minimised', () => {
  // Nobody taps Chat wanting a third of Chat, and nobody enters the map
  // wanting two thirds of it covered.
  const dom = build({ open: 'feed' });
  assert.strictEqual(dom.split(), MIN(), 'the feed did not open minimised');
  dom.openDrawer('chat');
  assert.strictEqual(dom.split(), EXP(), 'chat opened minimised');
  dom.el('dockDrawerClose').click();
  assert.strictEqual(dom.split(), MIN(), 'the feed did not come back minimised');
});

test('every panel gets the same treatment', () => {
  ['leaderboard', 'games', 'music', 'colors', 'modes', 'profile'].forEach((key) => {
    const dom = build({ open: 'feed' });
    dom.openDrawer(key);
    assert.strictEqual(dom.split(), EXP(), `${key} opened minimised`);
  });
});

test('a shell destination that is not the feed opens expanded too', () => {
  // Post is a render-based screen rather than a drawer panel, and a driver who
  // taps Post is going there to write.
  const dom = build({ open: 'feed' });
  dom.setOpen('post');
  assert.strictEqual(dom.split(), EXP(), 'posting opened minimised');
});

test('a repaint does not yank a dragged sheet back', () => {
  // apply() runs on every /me refresh. Re-seating the split on each of those
  // would undo a drag a driver made a second earlier.
  const dom = build({ open: 'feed' });
  dom.openDrawer('chat');
  dom.drag(260);
  assert.strictEqual(dom.split(), MIN());
  dom.window.dispatch('tlc:auth-state-changed', {});
  assert.strictEqual(dom.split(), MIN(), 'a refresh snapped the sheet back');
});

test('the sheet cannot be dragged off either end', () => {
  const dom = build({ open: 'feed' });
  dom.handle().dispatch('pointerdown', { button: 0, clientY: 400 });
  dom.handle().dispatch('pointermove', { clientY: 4000, preventDefault() {} });
  assert.ok(dom.split() <= 92, `dragged to ${dom.split()}%`);
  dom.handle().dispatch('pointermove', { clientY: -4000, preventDefault() {} });
  assert.ok(dom.split() >= 16, `dragged to ${dom.split()}%`);
  dom.handle().dispatch('pointerup', { clientY: -4000 });
});

test('the map is never resized', () => {
  // It is full bleed in both states and the sheet slides over it. A card that
  // grew and shrank would re-lay out and re-render the whole map on every
  // frame of the drag.
  const dom = build({ open: null });
  dom.setOpen('feed');
  dom.drag(260);
  assert.strictEqual(dom.resizes.length, 0,
    'something is resizing the map during a gesture');
  assert.ok(!/resizeMapToViewport/.test(SRC), 'feed-first.js still resizes the map');
});

test('the keyboard does what the drag does', () => {
  const dom = build({ open: 'feed' });
  dom.handle().dispatch('keydown', { key: 'ArrowDown', preventDefault() {} });
  assert.strictEqual(dom.split(), MIN());
  dom.handle().dispatch('keydown', { key: 'ArrowUp', preventDefault() {} });
  assert.strictEqual(dom.split(), EXP());
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

test('one surface: no card, no gutter, no page background', () => {
  // This is the complaint the whole redesign answers. The map is already fixed
  // to all four edges by frontend-shell.css, so the correct amount of map
  // geometry in this file is none -- anything here would be putting the box
  // back.
  assert.ok(!/body\.feed-first #map\s*\{[^}]*(border-radius|height|top:)/s.test(CSS),
    'the map is being boxed again');
  assert.ok(!/#mapCardOpen/.test(CSS) && !/mapCardOpen/.test(SRC),
    'the card tap target is still here');
});

test('the sheet is frosted and the words are not', () => {
  // Body text over a blurred red zone is not readable and never will be, so
  // the surface is translucent and everything carrying words is opaque.
  assert.ok(/#shellScreens\s*\{[^}]*backdrop-filter:\s*blur/s.test(CSS), 'not frosted');
  assert.ok(/\.feedCard[^{]*\{[^}]*background-color:\s*#ffffff/s.test(CSS),
    'posts sit on the frosting');
});

test('the sheet content clears the handle', () => {
  // The handle is 34px and fixed to the sheet's top edge. 16px of padding put
  // the scope chips under the arrow -- caught in a screenshot.
  const m = CSS.match(/body\.feed-first \.shellScreenBody\s*\{([^}]*)\}/s);
  assert.ok(m, 'no padding rule for the sheet body');
  const top = Number((m[1].match(/padding-top:\s*(\d+)px/) || [])[1]);
  assert.ok(top >= 38, `padding-top ${top}px puts content under the handle`);
});

test('the dock sits at the bottom of the screen', () => {
  // #dock carries 38px of clearance for the time-machine slider, and
  // app-shell.css only takes it back for non-admins. Feed First hides the
  // slider for everyone, so an admin was left holding clearance for something
  // that is not there -- 72pt off the bottom on a phone with a home indicator,
  // with an empty band underneath.
  //
  // safe-area + 10 was still 44pt up, which read as a band of blank frosting
  // under the icons once the sheet ran to the bottom edge -- measured off a
  // screenshot at 55pt under the small buttons.
  const m = CSS.match(/body\.feed-first #dock\s*\{([^}]*bottom[^}]*)\}/s);
  assert.ok(m, 'the dock keeps the scrubber offset under Feed First');
  assert.ok(/var\(--tj-dock-lift\)/.test(m[1]),
    'the dock is not on the token every clearance reads');
  const lift = dockLift();
  assert.ok(lift.onIndicator <= 24,
    `dock sits ${lift.onIndicator}px up on a home-indicator phone`);
  // Never so low that a browser without an inset pushes it off the bottom.
  assert.ok(lift.floor >= 8, `dock floor is ${lift.floor}px where there is no inset`);
});

test('nothing transitions while a finger is on it', () => {
  assert.ok(/body\.feed-first\.tj-dragging[^{]*\{[^}]*transition:\s*none/s.test(CSS),
    'the sheet lags behind the drag on a rubber band');
});

test('every panel wears the sheet, by one rule', () => {
  // #dockDrawer is one container with seven panels' content swapped into it,
  // so re-homing them is a rule on an element rather than seven rewrites. The
  // ID is what beats .dockDrawer.panelChat's own geometry on specificity.
  const m = CSS.match(/body\.feed-first #dockDrawer\s*\{([^}]*)\}/s);
  assert.ok(m, 'the drawer is still a floating card under Feed First');
  assert.ok(/top:\s*var\(--tj-split\)/.test(m[1]), 'it does not sit on the split');
  assert.ok(/backdrop-filter:\s*blur/.test(m[1]), 'it is not frosted like the feed');
  // top + height + bottom is over-constrained and the spec throws bottom away.
  assert.ok(/height:\s*auto/.test(m[1]), 'a fixed height would ignore bottom: 0');
  assert.ok(/max-height:\s*none/.test(m[1]), 'panelChat\'s 82dvh cap survives');
  const z = Number((m[1].match(/z-index:\s*(\d+)/) || [])[1]);
  assert.ok(z < 9250, `z-index ${z} puts the panel over the handle that drags it`);
});

test('the menu button is there whatever is in the sheet', () => {
  /* app-shell.css carries `body.shell-screen-open .shellMenuBtn {display:none}`,
   * written when a destination meant a full-screen takeover of the map. Here
   * the feed is the home screen AND a shell screen, so that rule hid the menu
   * on the screen you spend all your time on and handed it back the moment you
   * opened Chat. It was hidden outright for a while for exactly that reason;
   * the fix is to pin it on, not to take it away. */
  assert.ok(!/body\.feed-first \.shellMenuBtn\s*\{[^}]*display:\s*none/s.test(CSS),
    'the menu button is hidden again');
  const on = CSS.match(/body\.feed-first\.shell-screen-open \.shellMenuBtn[^{]*\{([^}]*)\}/s);
  assert.ok(on, 'nothing beats the shell-screen-open hide');
  assert.ok(/display:\s*grid\s*!important/.test(on[1]),
    'the override does not restore the button');

  // It yields to one thing: expanded, the answer card runs the full width and
  // its first words start where the button sits.
  const answer = CSS.match(/body\.feed-first\.map-answer-open[^{]*\{([^}]*)\}/s);
  assert.ok(answer && /display:\s*none\s*!important/.test(answer[1]),
    'the button sits on top of the opened recommendation');
  assert.ok(/body\.feed-first\.map-answer-open\.shell-screen-open \.shellMenuBtn/.test(CSS),
    'the yield loses to the shell-screen-open override, which is more specific');
});

test('the menu is a card under the button, not a slab on an edge', () => {
  /* Chosen from the drawings as "Segmented". The left drawer was welded to
   * three edges; the top sheet ran the full width and had to be exactly as
   * tall as the seam. This one touches nothing: it hangs under the button that
   * opened it and is as tall as what is in it. */
  const menu = CSS.match(/body\.feed-first \.shellMenu\s*\{([^}]*)\}/s);
  assert.ok(menu, 'no feed-first menu rule');
  const rule = menu[1];
  assert.ok(/height:\s*auto/.test(rule), 'the panel is still a fixed height');
  assert.ok(/bottom:\s*auto/.test(rule), 'app-shell pins the drawer to the bottom edge');
  const side = Number((rule.match(/left:\s*(\d+)px/) || [])[1]);
  assert.ok(side >= 8, `the panel starts ${side}px from the edge, which is a slab`);
  assert.ok(/right:\s*\d+px/.test(rule), 'it still runs to the right edge');
  // Under the button: the button is 48px tall at safe-area + 14, so anything
  // less than 62 overlaps it.
  assert.ok(/top:\s*calc\(env\(safe-area-inset-top[^)]*\)\s*\+\s*(6[2-9]|[7-9]\d|\d{3})px\)/.test(rule),
    'the panel does not clear the button it hangs from');
  assert.ok(/border-radius:\s*22px/.test(rule), 'a card is round on all four corners');

  const open = CSS.match(/body\.feed-first \.shellMenu\.open\s*\{([^}]*)\}/s);
  assert.ok(open && /opacity:\s*1/.test(open[1]) && /scale\(1\)/.test(open[1]),
    'it still slides rather than dropping open from under the button');
});

test('three tabs, and never a scroll under them', () => {
  /* The tabs are what make a content-height card possible: seven settings
   * split three, two and two. Without them the panel is seven rows tall and
   * back to being a slab. */
  assert.ok(/body\.feed-first \.shellTabs\s*\{[^}]*display:\s*flex/s.test(CSS),
    'no segmented control');
  assert.ok(/body\.feed-first \.shellTab\.on\s*\{[^}]*background:\s*#ffffff/s.test(CSS),
    'the selected tab is not marked');
  assert.ok(/body\.night\.feed-first \.shellTab\.on\s*\{[^}]*background:\s*#eef2f8/s.test(CSS),
    'the selected tab is white on white at night');

  const body = CSS.match(/body\.feed-first \.shellMenuBody\s*\{([^}]*)\}/s);
  assert.ok(body, 'no menu body rule');
  assert.ok(/overflow:\s*visible/.test(body[1]),
    'the body still scrolls, which a content-height card should never need');
  assert.ok(/flex:\s*none/.test(body[1]),
    'the body still stretches, which only makes sense in a full-height panel');

  // The readings are the last row, as drawn.
  assert.ok(/body\.feed-first \.shellConditions\s*\{[^}]*order:\s*3/s.test(CSS),
    'the conditions bar is not under the settings');
  // And the title bar is gone, as drawn -- the scrim, the button and Escape
  // are the ways out.
  assert.ok(/body\.feed-first \.shellMenuHeader\s*\{[^}]*display:\s*none/s.test(CSS),
    'the title bar is back');

  /* The button stays visible while the card is open: the card hangs from it,
   * which is only true if it is there to hang from. It used to hide, because
   * the full-width panel it replaced covered it and it ghosted through the
   * frosting -- that rule has to be gone, not just overridden. */
  assert.ok(!/shell-menu-open[^{]*\.shellMenuBtn\s*\{[^}]*display:\s*none/s.test(CSS),
    'the button still hides while the menu is open, so the card hangs from nothing');
});

test('the floating chat messages are above the sheet, not behind it', () => {
  /* .killFeed shows incoming chat as it arrives. It ships at z-index 6500 and
   * 116px off the bottom, which was right while the bottom of the screen was
   * map. Under Feed First the bottom of the screen is the sheet at 9200 and
   * the dock at 9300, so the messages painted underneath both and nobody had
   * seen one since. Nothing was hiding it -- it was behind the feed. */
  const rule = CSS.match(/body\.feed-first \.killFeed\s*\{([^}]*)\}/s);
  assert.ok(rule, 'the kill feed is not re-homed for feed-first');
  const z = Number((rule[1].match(/z-index:\s*(\d+)/) || [])[1]);
  assert.ok(Number.isFinite(z) && z > 9300,
    `the messages sit at ${z}, under the sheet (9200) or the dock (9300)`);
  // And off the bottom edge: it belongs over the map, not over somebody's post.
  assert.ok(/bottom:\s*calc\(100% - var\(--tj-split\)/.test(rule[1]),
    'the messages still hug the bottom, which is where the feed is');

  // With the keyboard up the sheet is the whole screen and the seam means
  // nothing, so it has to be anchored the other way round.
  assert.ok(/body\.feed-first\.tj-kb-up \.killFeed\s*\{[^}]*top:/s.test(CSS),
    'with the keyboard up the messages are positioned against a seam that is gone');
});

test('the dock clearance is where a height:100% panel can see it', () => {
  /* .chatPanelWrap, .gamesPanelWrap and .leaderboardPanelWrap are all
   * height: 100%, so they resolve against the drawer BODY's content box.
   * Padding on the body therefore bought nothing: the panel still ran to the
   * bottom of the sheet with the dock on top of it, and for chat that meant
   * the composer -- the last row of the wrap -- was unreachable. The panel was
   * open, looked right, and could not be typed in.
   *
   * Padding the flex CONTAINER shortens the box those wraps measure against. */
  const drawer = CSS.match(/body\.feed-first #dockDrawer\s*\{([^}]*)\}/s);
  assert.ok(drawer, 'no drawer rule');
  assert.ok(/padding-bottom:\s*var\(--tj-dock-clear\)/.test(drawer[1]),
    'the container does not reserve the dock clearance');
  // The dock box is ~72px tall, so whatever air the token adds on top of the
  // lift has to cover it -- otherwise the last row of a panel lands under the
  // icons, which is how chat lost its composer.
  const clear = dockClear();
  assert.ok(clear.air >= 78, `the clearance reserves ${clear.air}px for a 72px dock`);
  assert.ok(clear.onIndicator >= dockLift().onIndicator + 78,
    `the container reserves ${clear.onIndicator}px on a home-indicator phone`);

  const body = CSS.match(/body\.feed-first \.dockDrawerBody\s*\{([^}]*)\}/s);
  assert.ok(body, 'no drawer body rule');
  const bodyPad = Number((body[1].match(/padding-bottom:\s*(\d+)px/) || [])[1]);
  assert.ok(Number.isFinite(bodyPad) && bodyPad < 40,
    'the clearance is back on the body, where a height:100% child cannot see it');
});

test('the sheet follows the keyboard instead of being covered by it', () => {
  /* A position: fixed sheet is anchored to the LAYOUT viewport, which the
   * keyboard does not change -- so the composer stayed put, the keyboard
   * covered it, and iOS scrolled the whole document to reveal the focused
   * field. That scroll is what tore the layout apart.
   *
   * chatKeyboardMode only covers text entry inside the chat drawer; the
   * visualViewport measurement covers the feed's reply box too, so the class
   * that drives this is the measured one. */
  assert.ok(/body\.feed-first\.tj-kb-up[^{]*#dockDrawer[^{]*\{[^}]*bottom:\s*calc\(var\(--tj-kb\)/s.test(CSS),
    'the sheet does not follow the keyboard');
  assert.ok(/body\.feed-first\.tj-kb-up[^{]*\{[^}]*padding-bottom:\s*8px/s.test(CSS),
    'the composer is still held above a dock that is not there');
  assert.ok(/tj-kb-up #dock[^{]*\{[^}]*display:\s*none/s.test(CSS),
    'the dock sits over the keyboard');
  /* And that rule has to WIN. body.feed-first.shell-screen-open #dock carries
   * display: block !important further down this file and has exactly the same
   * specificity, so the later rule took it and the dock stayed on screen over
   * the keys. One more class settles it, and nothing but a test will notice if
   * it is dropped. */
  assert.ok(/body\.feed-first\.tj-kb-up\.shell-screen-open #dock/.test(CSS),
    'the hide loses to shell-screen-open on source order');
  assert.ok(/visualViewport/.test(SRC), 'nothing measures the keyboard');
  assert.ok(/window\.scrollTo\(0,\s*0\)/.test(SRC),
    "iOS's own scroll is left in place, which is what broke the layout");
});

test('a keyboard at the bottom of the sheet is still a keyboard', () => {
  /* The case from the photo. The reply field is at the bottom of the sheet, so
   * iOS slides the whole window down instead of scrolling the document: the
   * visual viewport is 536 tall and offset 420 inside a 956 layout viewport.
   *
   * The first cut read the keyboard as innerHeight - (height + offsetTop),
   * which is 956 - 956 = 0. Under the 60px floor, so tj-kb-up never turned on,
   * the dock stayed on screen over the keyboard and the sheet's header was
   * left above the top of the window. */
  const dom = build({ open: 'feed', vv: { height: 536, offsetTop: 420 } });
  assert.strictEqual(dom.api.keyboardInset(), 420, 'the slide cancelled the keyboard out');
  assert.strictEqual(dom.api.viewportShift(), 420, 'the slide is not measured');
  dom.api.paintViewport();
  assert.ok(dom.body.classList.contains('tj-kb-up'), 'the keyboard went unnoticed');
  assert.strictEqual(dom.body.style['--tj-kb'], '420px');
  assert.strictEqual(dom.body.style['--tj-vtop'], '420px');
  // top = 420 + 10, bottom = 420 - 420 = 0: the sheet fills what is on screen.
});

test('no keyboard, no slide written', () => {
  const dom = build({ open: 'feed' });
  dom.api.paintViewport();
  assert.ok(!dom.body.classList.contains('tj-kb-up'));
  assert.strictEqual(dom.body.style['--tj-kb'], '0px');
  assert.strictEqual(dom.body.style['--tj-vtop'], '0px');
});

test('a window short of its screen is noticed, and only where it can be', () => {
  /* The photo that started this: the sheet's top edge is 536pt down a 956pt
   * screen and it sits at 60%. 536 / 0.6 is 894. Nothing is mispositioned --
   * the window is 62pt short of the screen it is painted in, and everything in
   * it is exactly where it should be.
   *
   * Guarded three ways, because being wrong about this would move the whole
   * UI: a browser tab is SUPPOSED to be shorter than the screen by the height
   * of its own chrome, screen.height does not rotate on iOS so landscape reads
   * a huge bogus difference, and a number outside a status bar's worth of
   * pixels is a measurement gone wrong rather than this bug. */
  assert.strictEqual(build({ screenHeight: 956 }).api.windowIsShort(), 0,
    'a window the size of its screen reported a gap');
  assert.strictEqual(build({ screenHeight: 956 + 62 }).api.windowIsShort(), 62,
    'the short window went unnoticed');
  assert.strictEqual(build({ screenHeight: 956 + 62, standalone: false }).api.windowIsShort(), 0,
    'it fires in a browser tab, where the chrome accounts for the difference');
  assert.strictEqual(build({ screenHeight: 956 + 400 }).api.windowIsShort(), 0,
    'no sanity band: 400px is not a status bar');
  assert.strictEqual(build({ screenHeight: 956 + 4 }).api.windowIsShort(), 0,
    'a rounding artefact was treated as the bug');
});

test('the keyboard leaving asks for the window back', () => {
  // Only then: asking while somebody is typing would blur the field they are
  // typing in, which is a far worse bug than the one being fixed.
  const up = build({ open: 'feed', vv: { height: 536, offsetTop: 0 } });
  // mount() schedules its own; only the ones this call adds are interesting.
  const before = up.timers.length;
  up.api.paintViewport();
  assert.strictEqual(up.timers.length, before,
    'it asked while the keyboard was still up');

  up.window.visualViewport.height = 956;
  up.api.paintViewport();
  assert.ok(up.timers.length > before, 'the keyboard left and nothing asked');
});

test('asking does nothing where the window is not short', () => {
  /* Which is every browser I can run, so this is the case that has to be
   * harmless -- it must not blur a field or scroll the page on a device that
   * never had the bug. */
  const dom = build({ open: 'feed', screenHeight: 956 });
  const field = dom.document.createElement('input');
  let blurred = false;
  field.blur = () => { blurred = true; };
  dom.document.activeElement = field;
  dom.window.scrollY = 40;

  dom.api.askForTheWindowBack();
  assert.strictEqual(blurred, false, 'it blurred a field on a healthy window');
  assert.strictEqual(dom.window.scrollY, 40, 'it scrolled a page that was fine');
});

test('asking drops the focus iOS is still holding the window for', () => {
  // A field that still has focus after the keyboard is dismissed is what iOS
  // reads as "still editing", and it is why the window stays shrunk.
  const dom = build({ open: 'feed', screenHeight: 956 + 62 });
  const field = dom.document.createElement('input');
  let blurred = false;
  field.blur = () => { blurred = true; };
  dom.document.activeElement = field;
  dom.window.scrollY = 40;

  dom.api.askForTheWindowBack();
  assert.ok(blurred, 'the field kept focus, and iOS keeps the window short for it');
  assert.strictEqual(dom.window.scrollY, 0, 'the document was left scrolled');
});

test('nothing tries to paint outside the viewport', () => {
  /* After the keyboard closes, iOS leaves a standalone web view about 62pt
   * shorter than the window. The first answer gave every bottom-anchored
   * surface a negative offset to reach past the viewport edge. A fixed element
   * cannot be painted outside the viewport -- it is clipped there. Measured off
   * the photo: the Save button is 68pt tall and 28 survived, the round buttons
   * are 53 and 21 survived, both cut at the same line. It did not fill the
   * strip, it sawed the dock in half.
   *
   * The strip is the canvas behind the viewport, and only the root background
   * paints there. */
  assert.ok(!/--tj-vgap/.test(CSS), 'something still reaches past the viewport edge');
  assert.ok(!/viewportGap/.test(SRC), 'the gap is still being measured for nothing');
  assert.ok(/html\s*\{[^}]*background:\s*transparent/s.test(CSS),
    'html keeps a background, so body\'s never reaches the canvas');
  assert.ok(/body\.feed-first\s*\{[^}]*background:\s*var\(--tj-sheet-solid\)/s.test(CSS),
    'the strip is not painted the sheet\'s colour');
});

test('the keyboard is measured without the slide cancelling it out', () => {
  /* iOS has two moves. It scrolls the document, or -- when the field is near
   * the bottom -- it slides the whole window down inside the layout viewport
   * and scrolls nothing. visualViewport.offsetTop is the slide.
   *
   * Subtracting the slide from the keyboard, as the first cut did, cancels the
   * keyboard out exactly when the slide is biggest: the field at the bottom of
   * a sheet read a keyboard of about zero, tj-kb-up never turned on, the dock
   * stayed on screen over the keyboard and the sheet's header was left above
   * the top of the window. That is the photo. */
  const fn = SRC.slice(SRC.indexOf('function keyboardInset'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.ok(!/offsetTop/.test(body), 'the slide is still being subtracted from the keyboard');
  assert.ok(/innerHeight/.test(body) && /vv\.height/.test(body), 'not measured against the visual viewport');
  assert.ok(/function viewportShift/.test(SRC), 'nothing measures the slide');
  assert.ok(/--tj-vtop/.test(SRC) && /--tj-vtop/.test(CSS), 'the slide is measured and then ignored');
  // The sheet has to move both edges: down by the slide, and up by the rest of
  // the keyboard. Only moving the bottom leaves its header off the top.
  const kb = CSS.match(/body\.feed-first\.tj-kb-up #dockDrawer,\s*\n?body\.feed-first\.tj-kb-up #shellScreens\s*\{([^}]*)\}/s);
  assert.ok(kb, 'no keyboard geometry for the sheet');
  assert.ok(/top:\s*calc\(var\(--tj-vtop\)/.test(kb[1]), 'the top edge ignores the slide');
  assert.ok(/bottom:\s*calc\(var\(--tj-kb\)\s*-\s*var\(--tj-vtop\)\)/.test(kb[1]),
    'the bottom edge double-counts the slide');
});

test('Profile and Admin are in the sheet too', () => {
  // These two never used #dockDrawer -- their own container, their own
  // z-index, their own backdrop -- which is why they still looked like the old
  // app after everything else moved.
  assert.ok(/driverProfileModalRoot/.test(SRC) && /adminPortal/.test(SRC),
    'feed-first.js does not know about the two loose hosts');
  const sheet = CSS.match(
    /body\.feed-first \.driverProfileSheet,\s*\n?body\.feed-first \.adminPanel\s*\{([^}]*)\}/s);
  assert.ok(sheet, 'neither gets the sheet geometry');
  assert.ok(/top:\s*var\(--tj-split\)/.test(sheet[1]), 'they do not sit on the split');
  assert.ok(/backdrop-filter:\s*blur/.test(sheet[1]), 'they are not frosted');
  assert.ok(/padding-bottom:\s*var\(--tj-dock-clear\)/.test(sheet[1]),
    'no dock clearance on the container');
  assert.ok(/\.driverProfileBackdrop\s*\{[^}]*display:\s*none/s.test(CSS),
    'profile still dims the map behind it');
});

test('only one host is open at a time', () => {
  // They are all at the same layer now, so two open at once is one sitting on
  // top of the other.
  assert.ok(/closeOtherHosts/.test(SRC), 'nothing closes the host you just left');
});

test('the dock is in the order it was asked for', () => {
  /* Save in the middle, Feed on its left, Chat on its right, Music right of
   * Chat. Written as the relationships rather than as one expected array, so
   * anything not specified can move without this test having an opinion. */
  const ids = build({ open: 'feed' }).ids();
  const at = (id) => {
    const i = ids.indexOf(id);
    assert.ok(i >= 0, `${id} is not in the dock: ${ids.join(', ')}`);
    return i;
  };
  assert.ok(at('dockFeed') < at('pickupFab'), 'Feed is not left of Save');
  assert.ok(at('dockChat') > at('pickupFab'), 'Chat is not right of Save');
  assert.ok(at('dockMusic') > at('dockChat'), 'Music is not right of Chat');
  // Games was specified as left of Feed, back when it was in the dock. It is
  // in the menu now, and Leaderboard takes the outside seat -- which is the
  // only arrangement of the remaining five that satisfies everything above.
  assert.strictEqual(ids.indexOf('dockGames'), -1, 'Games is back in the dock');
  assert.ok(at('dockLeaderboard') < at('dockFeed'), 'Leaderboard is not on the outside');
  // Save centred is the dock's own job -- app.part6.js re-centres on it -- but
  // it cannot centre something that is not in the middle of the row.
  const left = at('pickupFab');
  const right = ids.length - 1 - left;
  assert.ok(Math.abs(left - right) <= 1,
    `Save has ${left} buttons left of it and ${right} right: ${ids.join(', ')}`);
});

test('reordering the dock leaves anything it has not heard of alone', () => {
  // A button added later should move, not disappear.
  const dom = build({ open: 'feed' });
  const stray = dom.document.createElement('button');
  stray.id = 'dockSomethingNew';
  dom.track.appendChild(stray);
  dom.api.orderDock();
  assert.ok(dom.ids().includes('dockSomethingNew'), 'it was dropped from the track');
});

test('reordering a dock already in order touches nothing', () => {
  /* It runs on every settle pass, and moving nodes resets the dock's sideways
   * scroll -- which app.part6.js only puts back after ten idle seconds. */
  const dom = build({ open: 'feed' });
  const before = dom.track.children.slice();
  dom.api.orderDock();
  assert.deepStrictEqual(dom.track.children, before, 'it reshuffled an ordered dock');
});

// ------------------------------------------------- how the dock moves, and why
//
// The two red chevrons at the ends of the dock are computed from the track's
// overflow. Pull six buttons out of an eleven button row and the five that are
// left stop overflowing -- but every signal app.part6.js listens for is a
// gesture, so nothing told it, and the chevrons went on advertising a scroll
// the dock no longer had.
//
// That was caught for a while with a ResizeObserver on #dockTrack. It also
// called scheduleDockAutoCenter(), and that is a ten second timer whose every
// other caller is a gesture: it only ever ran because the driver had just
// moved the dock themselves. Handed to an observer, a layout change nobody
// made could arm it, and ten seconds later the row slid back onto Save on its
// own while a driver was looking at the map.
//
// The row now reports itself, once, at the moment buttons actually move.

/** orderDock with a spy in place of the scroller's two entry points. */
function withScroller(dom) {
  const calls = { hints: 0, centre: 0 };
  dom.window.updateDockScrollHints = () => { calls.hints += 1; };
  // Not a real export -- if orderDock ever reaches for something that moves
  // the dock, this is what it would have to go through.
  dom.window.centerDockOnSave = () => { calls.centre += 1; };
  return calls;
}

test('pulling buttons out of the row re-measures the hints', () => {
  const dom = build({ open: 'feed' });
  const holder = dom.document.getElementById('dockStash');
  // Put them back where index.html had them, then run the pass again.
  holder.children.slice().forEach((node) => dom.track.appendChild(node));
  const calls = withScroller(dom);
  dom.api.orderDock();
  assert.strictEqual(calls.hints, 1,
    'the row lost six buttons and the chevrons were never told');
});

test('a stash-only pass still reports, though the order never changed', () => {
  /* The common case, and the one that was wrong: the five that are left are
   * already in the right order, so the reorder is a no-op while the stash is
   * not. Reporting only the reorder leaves the hints stale in exactly the
   * situation they are stale in. */
  const dom = build({ open: 'feed' });
  const holder = dom.document.getElementById('dockStash');
  const stashed = holder.children.slice();
  assert.ok(stashed.length, 'nothing was stashed, so there is nothing to test');
  // Back into the track, but AFTER the five, so DOCK_ORDER is already satisfied.
  stashed.forEach((node) => dom.track.appendChild(node));
  const calls = withScroller(dom);
  dom.api.orderDock();
  assert.strictEqual(dom.ids().length, 5, 'the six were not pulled back out');
  assert.strictEqual(calls.hints, 1, 'a stash-only pass said nothing');
});

test('an unchanged row says nothing at all', () => {
  // It runs on every settle pass. Reporting each one would be noise.
  const dom = build({ open: 'feed' });
  const calls = withScroller(dom);
  dom.api.orderDock();
  assert.strictEqual(calls.hints, 0, 'it reported a row that did not change');
});

test('reordering the dock never moves the dock', () => {
  const dom = build({ open: 'feed' });
  const holder = dom.document.getElementById('dockStash');
  holder.children.slice().forEach((node) => dom.track.appendChild(node));
  const calls = withScroller(dom);
  dom.api.orderDock();
  assert.strictEqual(calls.centre, 0,
    'reordering the row scrolls it, which is the driver\'s to do');
  assert.ok(!/scheduleDockAutoCenter|centerDockOnSave/.test(SRC),
    'feed-first.js reaches into the dock\'s scrolling');
});

test('nothing watches the track, so nothing arms the auto-centre behind a driver', () => {
  // Code, not the comment that explains why the code is gone.
  const init = PART6.slice(PART6.indexOf('function initDockScroller'))
    .split('\n').filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join('\n');
  assert.ok(!/ResizeObserver/.test(init),
    'the dock track is under a standing watch again');
  assert.ok(!/\.observe\(/.test(init), 'something is observing the dock again');
  /* Every remaining caller is something the driver did:
   *
   *   its own re-arm while a finger is still down
   *   scrollDockByStep   -- a tap on a chevron
   *   handleDockInteraction -- a scroll or a wheel
   *   endDockDrag        -- letting go
   *   the resize listener -- the window itself changed
   *   initDockScroller   -- once, at boot
   *
   * Six. A seventh means something arms the dock's movement that a driver did
   * not do, which is the bug; it has to be looked at rather than counted past. */
  const code = PART6.split('\n')
    .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
    .join('\n')
    .replace(/function scheduleDockAutoCenter\(\)/, '');
  const armed = [...code.matchAll(/scheduleDockAutoCenter\(\)/g)].length;
  assert.strictEqual(armed, 6,
    `scheduleDockAutoCenter is called ${armed} times; a caller was added or removed`);
});

test('the hints are still reachable from outside app.part6', () => {
  // feed-first.js calls it by name off window. If that export goes, the row
  // change is reported into nothing and the chevrons go stale again silently.
  assert.ok(/window\.updateDockScrollHints\s*=\s*updateDockScrollHints/.test(PART6),
    'updateDockScrollHints is no longer exported');
  assert.ok(/window\.updateDockScrollHints/.test(SRC),
    'feed-first.js no longer reports the row change');
});

test('the answer sits at the top, and nothing sits on it', () => {
  /* It used to ride the sheet's top edge, which moved every time the sheet did
   * and put it in the busiest part of the map -- the zone the driver is
   * standing in, with their own marker in it. Top centre is where a glance
   * lands and it does not move.
   *
   * The two buttons that were up there are gone, so the band is the pill's
   * own. map-action.js un-hides the segmented control once it has wired it up,
   * and it does that by removing the hidden ATTRIBUTE -- so the rule that
   * takes it away has to be a style, and has to be !important. */
  const pill = CSS.match(/body\.feed-first #mapAction\s*\{([^}]*)\}/s);
  assert.ok(pill, 'no rule places the answer pill');
  assert.ok(/top:\s*calc\(env\(safe-area-inset-top/.test(pill[1]),
    'the pill is not anchored to the top of the screen');
  assert.ok(/bottom:\s*auto/.test(pill[1]), 'it is still anchored to the bottom too');
  assert.ok(!/--tj-split/.test(pill[1]), 'it still rides the sheet');

  /* The pair used to be HIDDEN here. Hidden still ships: the markup is in the
   * DOM, the script still wires it, it just is not painted -- which is exactly
   * how the old interface came back once. They are deleted now, so this asks
   * index.html whether they exist at all rather than asking the CSS whether
   * they are covered up. */
  assert.ok(!/mapSegmented|mapSegCenter|mapSegReport/.test(INDEX),
    'the pair at the top right is back in the markup');
  assert.ok(!/mapControlStack|id="btnCenter"/.test(INDEX),
    'the old recentre button is back in the markup');
});

test('the sheet is not modal', () => {
  // The map behind stays visible and usable, which is the point of the layout,
  // so the scrim that used to dim it has no job.
  assert.ok(/body\.feed-first #dockBackdrop\s*\{[^}]*display:\s*none/s.test(CSS),
    'a panel still dims the map behind it');
});

test('the app says which panel is in the drawer', () => {
  // openPanelKey is a module variable nobody outside app.js can read.
  const APP = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.ok(/tlc:drawer-changed/.test(APP), 'nothing announces the drawer');
  assert.ok(/tlc:drawer-changed/.test(SRC), 'feed-first.js is guessing instead');
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
