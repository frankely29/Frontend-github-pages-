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
