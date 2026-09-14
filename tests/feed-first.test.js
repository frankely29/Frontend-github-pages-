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

  // The seven panels that share one container. Under Feed First it wears the
  // same geometry as the feed's screen, so the double needs it to test that.
  const drawer = makeNode('div'); drawer.id = 'dockDrawer';
  const drawerClose = makeNode('button'); drawerClose.id = 'dockDrawerClose';
  drawer.appendChild(drawerClose);
  body.appendChild(drawer);

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
    drawer,
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

test('the sheet is up for any destination, down for none', () => {
  // It used to be feed-only, so tapping Chat left the sheet layout behind and
  // put a floating card back on the screen -- the two-widget look the whole
  // design exists to remove.
  const dom = build({ open: 'feed' });
  assert.ok(dom.body.classList.contains('feed-first'));
  dom.setOpen('post');
  assert.ok(dom.body.classList.contains('feed-first'), 'posting fell out of the sheet');
  dom.setOpen(null);
  assert.ok(!dom.body.classList.contains('feed-first'), 'the full map kept the sheet layout');
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
  assert.strictEqual(dom.split(), 66, 'the sheet does not open minimised');
  assert.ok(dom.body.classList.contains('tj-min'));
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
  assert.strictEqual(dom.split(), 39, 'precondition: expanded');
  dom.drag(260);
  assert.strictEqual(dom.split(), 66, 'it did not snap to the minimised detent');
  assert.ok(dom.body.classList.contains('tj-min'), 'nothing marks the minimised state');
});

test('a short drag falls back to where it started', () => {
  // Snapping to the nearest detent, not to wherever the finger stopped.
  const dom = build({ open: 'feed' });
  dom.drag(-40);
  assert.strictEqual(dom.split(), 66, 'a nudge moved it to the wrong detent');
});

test('dragging it back up expands it again', () => {
  const dom = build({ open: 'feed' });
  dom.drag(260);
  dom.drag(-260);
  assert.strictEqual(dom.split(), 39);
  assert.ok(!dom.body.classList.contains('tj-min'));
});

test('a tap toggles, a drag does not', () => {
  // Four pixels of slop, so a tap that wobbles is still a tap.
  const dom = build({ open: 'feed' });
  dom.tap();
  assert.strictEqual(dom.split(), 39, 'tapping the handle did nothing');
  dom.tap();
  assert.strictEqual(dom.split(), 66);
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

test('where they left it is where it opens', () => {
  const dom = build({ open: 'feed', storage: { tj_sheet_split_v1: '0.39' } });
  assert.strictEqual(dom.split(), 39, 'it forgot the sheet was expanded');
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
  assert.strictEqual(dom.split(), 66);
  dom.handle().dispatch('keydown', { key: 'ArrowUp', preventDefault() {} });
  assert.strictEqual(dom.split(), 39);
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
  const m = CSS.match(/body\.feed-first #dock\s*\{([^}]*bottom[^}]*)\}/s);
  assert.ok(m, 'the dock keeps the scrubber offset under Feed First');
  const px = Number((m[1].match(/\+\s*(\d+)px/) || [])[1]);
  assert.ok(Number.isFinite(px) && px <= 14, `dock sits ${px}px above the safe area`);
  assert.ok(/safe-area-inset-bottom/.test(m[1]), 'the dock ignores the home indicator');
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

test('the sheet looks the same whatever is in it', () => {
  // app-shell.css hides the menu button on body.shell-screen-open, which is
  // true for the feed and false for a dock panel -- so it reappeared the moment
  // you opened Chat and vanished again on the way back.
  assert.ok(/body\.feed-first \.shellMenuBtn\s*\{[^}]*display:\s*none/s.test(CSS),
    'the menu button comes and goes with the occupant');
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
