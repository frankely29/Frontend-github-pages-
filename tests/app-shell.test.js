#!/usr/bin/env node
/**
 * app-shell.test.js — the navigation layout behaves, on the real shipped file.
 *
 * A DOM small enough to hand-build, then app-shell.js is evaluated against it
 * exactly as the browser would. What is worth testing here is not that a menu
 * opens; it is the handful of things that would quietly ruin the layout:
 *
 *   - the scrubber staying visible for a driver, or vanishing for an admin,
 *   - the dock not moving into the space the scrubber left,
 *   - a destination that leaves the map's chrome floating over it,
 *   - a menu entry for an existing panel that reimplements the panel instead
 *     of clicking it,
 *   - and the back button walking someone through every screen they visited.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = path.join(__dirname, '..', 'app-shell.js');

// --------------------------------------------------------------------------
// the smallest DOM this file actually touches
// --------------------------------------------------------------------------

function makeClassList(node) {
  // Backed by node._classes, which `className` also writes to. The source sets
  // className directly (el('div', 'shellItem')) AND uses classList.add, so a
  // classList that only tracked add() would report half the truth.
  const set = node._classes;
  return {
    add(...names) { names.forEach((n) => n && set.add(n)); },
    remove(...names) { names.forEach((n) => set.delete(n)); },
    toggle(name, force) {
      const want = force === undefined ? !set.has(name) : !!force;
      if (want) this.add(name); else this.remove(name);
      return want;
    },
    contains(name) { return set.has(name); },
    get size() { return set.size; },
  };
}

function makeNode(tag) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    parentNode: null,
    style: {},
    hidden: false,
    id: '',
    _classes: new Set(),
    _text: '',
    _html: '',
    _attrs: {},
    _listeners: {},
    clicks: 0,
  };
  node.classList = makeClassList(node);
  Object.defineProperty(node, 'className', {
    get() { return [...node._classes].join(' '); },
    set(v) {
      node._classes.clear();
      String(v || '').split(/\s+/).forEach((n) => n && node._classes.add(n));
    },
  });
  node.appendChild = (child) => { child.parentNode = node; node.children.push(child); return child; };
  // The shell inserts the conditions bar between the header and the list, so
  // this double needs the real insertBefore contract: place before the
  // reference, or append when the reference is null/absent.
  node.insertBefore = (child, ref) => {
    child.parentNode = node;
    const at = ref ? node.children.indexOf(ref) : -1;
    if (at < 0) node.children.push(child);
    else node.children.splice(at, 0, child);
    return child;
  };
  node.setAttribute = (k, v) => { node._attrs[k] = String(v); };
  node.getAttribute = (k) => (k in node._attrs ? node._attrs[k] : null);
  node.addEventListener = (type, fn) => {
    (node._listeners[type] = node._listeners[type] || []).push(fn);
  };
  node.removeEventListener = () => {};
  node.dispatch = (type, event) => {
    (node._listeners[type] || []).forEach((fn) => fn(event || { type }));
  };
  node.click = () => { node.clicks += 1; node.dispatch('click', { type: 'click', target: node }); };
  node.focus = () => {};
  Object.defineProperty(node, 'textContent', {
    get() { return node._text; },
    set(v) { node._text = String(v); node.children.length = 0; },
  });
  Object.defineProperty(node, 'innerHTML', {
    get() { return node._html; },
    set(v) { node._html = String(v); },
  });

  function walk(n, out) {
    n.children.forEach((c) => { out.push(c); walk(c, out); });
    return out;
  }
  node.querySelectorAll = (selector) => {
    const want = String(selector).replace(/^\./, '');
    return walk(node, []).filter((c) => c.classList.contains(want));
  };
  node.querySelector = (selector) => node.querySelectorAll(selector)[0] || null;
  node.closest = (selector) => {
    const want = String(selector).replace(/^\./, '');
    let cur = node;
    while (cur) {
      if (cur.classList && cur.classList.contains(want)) return cur;
      cur = cur.parentNode;
    }
    return null;
  };
  return node;
}

function makeEnv({ admin = false, dockButtons = ['dockChat', 'dockGames'] } = {}) {
  const byId = new Map();
  const body = makeNode('body');
  const document = {
    readyState: 'complete',
    body,
    activeElement: null,
    createElement: (tag) => makeNode(tag),
    getElementById: (id) => byId.get(id) || null,
    addEventListener: (type, fn) => { (document._l[type] = document._l[type] || []).push(fn); },
    _l: {},
    dispatch: (type, event) => (document._l[type] || []).forEach((fn) => fn(event)),
  };
  dockButtons.forEach((id) => {
    const b = makeNode('button');
    b.id = id;
    byId.set(id, b);
  });

  // The shell appends its chrome to body; index it as the browser would.
  const realAppend = body.appendChild;
  body.appendChild = (child) => {
    realAppend(child);
    if (child.id) byId.set(child.id, child);
    return child;
  };

  const location = { hash: '', pathname: '/', search: '' };
  const window = {
    document,
    location,
    me: admin ? { is_admin: true } : { is_admin: false },
    console,
    requestAnimationFrame: (fn) => fn(),
    setTimeout: (fn) => { fn(); return 0; },
    history: { replaceState: (_s, _t, url) => { location.hash = ''; if (url) location.pathname = '/'; } },
    addEventListener: (type, fn) => { (window._l[type] = window._l[type] || []).push(fn); },
    _l: {},
    dispatch: (type, event) => (window._l[type] || []).forEach((fn) => fn(event)),
  };
  window.window = window;

  const context = vm.createContext({ window, document, console, requestAnimationFrame: window.requestAnimationFrame });
  vm.runInContext(fs.readFileSync(SOURCE, 'utf8'), context, { filename: 'app-shell.js' });
  return { window, document, body, byId, shell: window.TeamJoseoShell };
}

function menuKeys(env) {
  const menu = env.byId.get('shellMenu');
  return menu.querySelectorAll('.shellItem').map((i) => i.getAttribute('data-shell-key'));
}

function clickMenuItem(env, key) {
  const menu = env.byId.get('shellMenu');
  const item = menu.querySelectorAll('.shellItem')
    .filter((i) => i.getAttribute('data-shell-key') === key)[0];
  assert.ok(item, `menu has no item for "${key}"`);
  menu.dispatch('click', { target: item });
}

// --------------------------------------------------------------------------
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('mounts a menu button, a menu and a screen host', () => {
  const env = makeEnv();
  assert.ok(env.byId.get('shellMenuBtn'), 'menu button');
  assert.ok(env.byId.get('shellMenu'), 'menu');
  assert.ok(env.byId.get('shellScreens'), 'screen host');
  assert.strictEqual(env.byId.get('shellMenu').hidden, true, 'menu starts closed');
  assert.strictEqual(env.byId.get('shellScreens').hidden, true, 'no screen open');
});

test('the driver build hides the scrubber and lowers the dock', () => {
  // The 38px offset on #dock exists only to clear the slider. If the class that
  // hides one does not also lower the other, the driver just gets a gap.
  const env = makeEnv({ admin: false });
  assert.ok(env.body.classList.contains('shell-no-scrubber'),
    'scrubber must be hidden for drivers');
  assert.ok(!env.body.classList.contains('shell-admin'));
});

test('the admin build keeps the scrubber', () => {
  const env = makeEnv({ admin: true });
  assert.ok(env.body.classList.contains('shell-admin'));
  assert.ok(!env.body.classList.contains('shell-no-scrubber'),
    'the time machine is the admin build');
});

test('the admin flag is re-read when auth state changes', () => {
  // /me arrives after this file has mounted, so reading the flag once would
  // leave an admin looking at the driver build until they reload.
  const env = makeEnv({ admin: false });
  assert.ok(env.body.classList.contains('shell-no-scrubber'));
  env.window.me = { is_admin: true };
  env.window.dispatch('tlc:auth-state-changed', {});
  assert.ok(env.body.classList.contains('shell-admin'));
  assert.ok(!env.body.classList.contains('shell-no-scrubber'));
});

test('admin-only destinations are hidden from drivers', () => {
  assert.ok(!menuKeys(makeEnv({ admin: false })).includes('admin'));
  assert.ok(menuKeys(makeEnv({ admin: true })).includes('admin'));
});

test('the menu lists the map and the new destinations', () => {
  const keys = menuKeys(makeEnv());
  ['map', 'feed', 'post', 'chat', 'profile'].forEach((k) => {
    assert.ok(keys.includes(k), `menu is missing "${k}"`);
  });
});

test('an existing panel is opened by clicking its dock button', () => {
  // Not reimplemented, not read — clicked. That is the whole integration.
  const env = makeEnv();
  const dockChat = env.byId.get('dockChat');
  assert.strictEqual(dockChat.clicks, 0);
  clickMenuItem(env, 'chat');
  assert.strictEqual(dockChat.clicks, 1, 'the dock button should have been clicked');
  assert.strictEqual(env.byId.get('shellScreens').hidden, true,
    'a dock panel must not also open a full screen');
});

test('a full-screen destination opens, titles itself and can be left', () => {
  const env = makeEnv();
  const host = env.byId.get('shellScreens');
  clickMenuItem(env, 'feed');
  assert.strictEqual(host.hidden, false);
  assert.strictEqual(host.querySelector('.shellScreenTitle').textContent, 'Feed');
  assert.ok(env.body.classList.contains('shell-screen-open'),
    'the map chrome is hidden by this class — without it the dock floats over the screen');

  host.querySelector('.shellBack').click();
  assert.ok(!env.body.classList.contains('shell-screen-open'));
  assert.strictEqual(host.hidden, true);
});

test('opening a destination sets a hash, leaving clears it without a history entry', () => {
  // Replace, not push: otherwise tapping back on the map walks the driver
  // backwards through every screen they looked at.
  const env = makeEnv();
  clickMenuItem(env, 'feed');
  assert.strictEqual(env.window.location.hash, '#/feed');
  env.byId.get('shellScreens').querySelector('.shellBack').click();
  assert.strictEqual(env.window.location.hash, '');
});

test('a deep link opens its destination on load', () => {
  const env = makeEnv();
  env.window.location.hash = '#/post';
  env.window.dispatch('hashchange', {});
  assert.strictEqual(env.byId.get('shellScreens').hidden, false);
  assert.strictEqual(
    env.byId.get('shellScreens').querySelector('.shellScreenTitle').textContent, 'Post');
});

test('a hash for a dock panel is ignored', () => {
  // Otherwise a reload drops the driver into a panel every single time.
  const env = makeEnv();
  env.window.location.hash = '#/chat';
  env.window.dispatch('hashchange', {});
  assert.strictEqual(env.byId.get('shellScreens').hidden, true);
  assert.strictEqual(env.byId.get('dockChat').clicks, 0);
});

test('an unknown hash does not open anything', () => {
  const env = makeEnv();
  env.window.location.hash = '#/not-a-screen';
  env.window.dispatch('hashchange', {});
  assert.strictEqual(env.byId.get('shellScreens').hidden, true);
});

test('switching destinations replaces rather than stacks', () => {
  const env = makeEnv();
  clickMenuItem(env, 'feed');
  clickMenuItem(env, 'post');
  const host = env.byId.get('shellScreens');
  assert.strictEqual(host.querySelector('.shellScreenTitle').textContent, 'Post');
  assert.strictEqual(host.querySelectorAll('.shellScreenBody').length, 1,
    'one body, reused — not one per visit');
});

test('a destination registered later appears in the menu', () => {
  const env = makeEnv();
  assert.ok(!menuKeys(env).includes('saved'));
  env.shell.register({ key: 'saved', title: 'Saved trips', group: 'You', render() {} });
  assert.ok(menuKeys(env).includes('saved'),
    'the registry is how features get added without touching this file');
});

test('a render that throws still leaves a usable screen', () => {
  const env = makeEnv();
  env.shell.register({
    key: 'broken', title: 'Broken', render() { throw new Error('nope'); },
  });
  env.shell.open('broken');
  const host = env.byId.get('shellScreens');
  assert.strictEqual(host.hidden, false, 'the screen still opens');
  assert.ok(host.querySelector('.shellBack'), 'and can still be left');
});

test('escape closes the menu, then the screen', () => {
  const env = makeEnv();
  env.shell.openMenu();
  assert.ok(env.byId.get('shellMenu').classList.contains('open'));
  env.document.dispatch('keydown', { key: 'Escape' });
  assert.ok(!env.byId.get('shellMenu').classList.contains('open'));

  clickMenuItem(env, 'feed');
  env.document.dispatch('keydown', { key: 'Escape' });
  assert.ok(!env.body.classList.contains('shell-screen-open'));
});

test('the current destination is marked in the menu', () => {
  const env = makeEnv();
  clickMenuItem(env, 'feed');
  env.shell.openMenu();
  const menu = env.byId.get('shellMenu');
  const feed = menu.querySelectorAll('.shellItem')
    .filter((i) => i.getAttribute('data-shell-key') === 'feed')[0];
  assert.ok(feed.classList.contains('on'), 'you should be able to see where you are');
});

test('exposes a stable public surface', () => {
  const env = makeEnv();
  ['register', 'open', 'close', 'openMenu', 'closeMenu', 'refreshChrome'].forEach((fn) => {
    assert.strictEqual(typeof env.shell[fn], 'function', `TeamJoseoShell.${fn}`);
  });
});

// --------------------------------------------------------------------------
// ---------------------------------------------- conditions moved off the map

const SHELL_SRC = fs.readFileSync(SOURCE, 'utf8');
const SHELL_CSS = fs.readFileSync(path.join(__dirname, '..', 'app-shell.css'), 'utf8');
const PART17_SRC = fs.readFileSync(path.join(__dirname, '..', 'app.part17.js'), 'utf8');

test('the three readings are gathered into the map strip', () => {
  // Tendency, drivers online and weather each used to float separately over
  // the zones. They belong together in one bar; if one is dropped from the
  // list it silently goes back to floating on its own.
  ['dayTendencyMeter', 'onlineBadge', 'weatherBadge'].forEach((id) => {
    assert.ok(SHELL_SRC.includes(`"${id}"`), `${id} is not gathered into the strip`);
  });
});

test('the assistant card is retired rather than gathered', () => {
  // It rendered the same recommendation as the map pill -- the pill's own
  // "why" is the same rec.secondary || rec.primary the card showed -- so the
  // app was giving one answer twice and inviting a driver to wonder which to
  // believe. Putting it in the strip would just move the duplicate.
  const list = SHELL_SRC.slice(SHELL_SRC.indexOf('STATUS_NODE_IDS'),
                               SHELL_SRC.indexOf('function hideDuplicateAssistant'));
  assert.ok(!/"aiAssistantDock"/.test(list), 'the duplicate card is back in the strip');
  assert.ok(/hideDuplicateAssistant/.test(SHELL_SRC), 'nothing retires the duplicate card');
});

test('the map is cleared at mount, not on the first menu open', () => {
  // Relocating only on open means the chips a driver is meant to stop seeing
  // are exactly what they see until they happen to open the drawer.
  const mount = SHELL_SRC.slice(SHELL_SRC.indexOf('function mount'));
  assert.ok(/relocateStatus\(\)/.test(mount), 'mount never relocates');
});

test('relocation runs again after mount, for the lazily-built widgets', () => {
  // day-tendency.js builds its meter the first time it has a reading, so a
  // single pass at mount misses it and the rail floats loose over the zones.
  assert.ok(/setTimeout\(function \(\) \{\s*relocateStatus\(\);/.test(SHELL_SRC),
    'nothing re-runs relocation, so late-built widgets stay loose');
});

test('relocation moves the live node rather than rebuilding it', () => {
  // Every updater in the app holds a reference to these elements by id.
  // Cloning or re-creating them would leave the updaters writing to orphans:
  // the widgets would appear in the menu and never change again.
  assert.ok(/host\.appendChild\(node\)/.test(SHELL_SRC), 'node is not moved');
  assert.ok(!/cloneNode/.test(SHELL_SRC), 'a clone would strip the live wiring');
});

test('the gathered widgets stop being anchored to the viewport', () => {
  assert.ok(/#shellConditions > #dayTendencyMeter[\s\S]{0,500}position:\s*static/.test(SHELL_CSS),
    'the widgets keep the fixed positioning that had them floating separately');
  assert.ok(/box-sizing:\s*border-box/.test(SHELL_CSS.slice(SHELL_CSS.indexOf('#shellConditions'))),
    'without border-box their padding pushes them past the bar edge');
});

test('the bar hangs under the header, inside the drawer', () => {
  // Inside the drawer is what makes it appear only while the drawer is open --
  // no show/hide logic of its own, nothing to leave stuck on screen. Appending
  // it to the menu would put it under the destination list instead.
  assert.ok(/insertBefore\(status, menu\.querySelector\(["']\.shellMenuBody["']\)\)/.test(SHELL_SRC),
    'the bar is not placed between the header and the list');
  assert.ok(!/#shellConditions\s*\{[^}]*position:\s*fixed/s.test(SHELL_CSS),
    'a fixed bar would float over the map instead of sitting in the drawer');
});

test('the tendency rail lies down without losing its marker', () => {
  // The rail is drawn as a 13x118 vertical column whose marker is placed by
  // `bottom`. Laying it flat means the marker has to move along the other
  // axis, which is why day-tendency.js now states a percentage
  // (--tendency-pct) and lets the CSS decide which edge it drives.
  const DT = fs.readFileSync(path.join(__dirname, '..', 'day-tendency.js'), 'utf8');
  assert.ok(/--tendency-pct/.test(DT), 'the marker position is still hardcoded to one axis');
  assert.ok(!/marker\.style\.bottom/.test(DT), 'the marker still writes bottom directly');
  assert.ok(/#shellConditions[\s\S]{0,4000}min-height:\s*0\s*!important/.test(SHELL_CSS),
    'the info column keeps min-height:118px and holds the bar open');
});

test('the meter shows the whole range, with the score marked on it', () => {
  // A single number cannot say how good 49 is. The rail did, and the drawer
  // version has to as well: the full worst-to-best gradient, red at the left
  // so the scale runs the same direction as the number beside it, and a
  // marker that moves. A dot coloured by the score was tried here and is not
  // the same thing -- it loses the range.
  assert.ok(/#shellConditions \.dayTendencyScale[\s\S]{0,600}linear-gradient\(to right, #e60000/.test(SHELL_CSS),
    'the meter is not a worst-to-best gradient running left to right');
  assert.ok(/#shellConditions \.dayTendencyMarker[\s\S]{0,400}left:\s*var\(--tendency-pct/.test(SHELL_CSS),
    'the marker does not track the score');
  assert.ok(!/#shellConditions \.dayTendencyMarker\s*\{[^}]*display:\s*none/s.test(SHELL_CSS),
    'the marker is hidden, so the meter shows a range with nothing marked on it');
});

test('the marker reads a percentage rather than one fixed edge', () => {
  // day-tendency.js states the position and the CSS decides which edge it
  // drives: `bottom` on the vertical rail, `left` here. Writing to bottom
  // directly is what made the rail impossible to lay flat.
  const DT = fs.readFileSync(path.join(__dirname, '..', 'day-tendency.js'), 'utf8');
  assert.ok(/--tendency-pct/.test(DT), 'the marker position is hardcoded to one axis again');
  assert.ok(!/marker\.style\.bottom/.test(DT), 'the marker writes bottom directly again');
});

test('the online count keeps its number when the word is dropped', () => {
  // "online" next to a two-person icon says it twice, and those ~45px are what
  // let the tendency label read in full. The word stays in the DOM so
  // textContent still reads "N online" for anything that inspects it.
  const P9 = fs.readFileSync(path.join(__dirname, '..', 'app.part9.js'), 'utf8');
  assert.ok(/onlineNum/.test(P9) && /onlineWord/.test(P9),
    'the count and the word are still one string, so the word cannot be dropped');
  const INDEX = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(/onlineNum/.test(INDEX),
    'the first paint still ships the unsplit string, so it differs from every later one');
  assert.ok(/#shellConditions \.onlineWord\s*\{[^}]*display:\s*none/s.test(SHELL_CSS),
    'the redundant word is not dropped in the bar');
});

test('the assistant card stops threading itself between the badges', () => {
  // updateAssistantDockLayout positioned the card in the lane between the
  // online and weather badges. The card is retired and the badges are inside
  // the strip, so there is no lane -- and the inline left/top it writes would
  // outlive the change.
  const fn = PART17_SRC.slice(PART17_SRC.indexOf('function updateAssistantDockLayout'));
  const guard = fn.indexOf('shellRetired');
  const laneMath = fn.indexOf('laneLeft');
  assert.ok(guard > -1, 'no guard for the retired card');
  assert.ok(guard < laneMath, 'the guard must come before the lane maths runs');
});

test('the menu is destinations again, with no readings in it', () => {
  // The readings spent one revision at the bottom of the drawer, where they
  // ate a third of it and still had to be opened to be read.
  assert.ok(!/shellStatus/.test(SHELL_CSS), 'the menu still styles a Conditions block');
  assert.ok(!/shellStatus/.test(SHELL_SRC), 'the menu still builds a Conditions block');
  assert.ok(/\.shellMenuBody\s*\{[^}]*overflow-y:\s*auto/s.test(SHELL_CSS),
    'the destination list cannot scroll');
});

let failed = 0;
tests.forEach(([name, fn]) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${err && err.message}`);
  }
});
console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);
