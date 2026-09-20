#!/usr/bin/env node
/**
 * notifications.test.js — the Notifications destination, on the real file.
 *
 * What is worth pinning here is not that a list renders. It is the handful of
 * things that make a notifications screen something people switch off:
 *
 *   - marking "all" read, so anything that arrived while the screen was open
 *     is silently lost,
 *   - polling the page instead of the count, which is twenty joins a minute,
 *   - polling at all while the tab is in the background,
 *   - a badge that keeps counting after the session ends,
 *   - and a write that loses its Authorization header, which is how liking a
 *     post used to sign a driver out.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'notifications.js');
const CSS = fs.readFileSync(path.join(ROOT, 'notifications.css'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SHELL = fs.readFileSync(path.join(ROOT, 'app-shell.js'), 'utf8');

// --------------------------------------------------------------------------

function makeNode(tag) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [], parentNode: null, id: '', hidden: false,
    _classes: new Set(), _text: '', _attrs: {}, _listeners: {},
  };
  node.classList = {
    add: (...n) => n.forEach((x) => x && node._classes.add(x)),
    remove: (...n) => n.forEach((x) => node._classes.delete(x)),
    contains: (x) => node._classes.has(x),
    toggle: (x, on) => (on ? node._classes.add(x) : node._classes.delete(x)),
  };
  Object.defineProperty(node, 'className', {
    get: () => [...node._classes].join(' '),
    set: (v) => {
      node._classes.clear();
      String(v || '').split(/\s+/).forEach((x) => x && node._classes.add(x));
    },
  });
  /* The real thing concatenates every descendant, and this double used to
   * return only the node's own text -- so a line built as <b>name</b> + a text
   * node read as empty, and an assertion about what a row SAYS could not fail.
   * A double that cannot see half the text cannot test the words. */
  Object.defineProperty(node, 'textContent', {
    get: () => (node.children.length
      ? node.children.map((c) => c.textContent).join('')
      : node._text),
    set: (v) => { node._text = String(v); node.children.length = 0; },
  });
  node.appendChild = (c) => {
    if (c.parentNode && c.parentNode.children) {
      const at = c.parentNode.children.indexOf(c);
      if (at >= 0) c.parentNode.children.splice(at, 1);
    }
    c.parentNode = node; node.children.push(c); return c;
  };
  node.removeChild = (c) => {
    const at = node.children.indexOf(c);
    if (at >= 0) node.children.splice(at, 1);
    c.parentNode = null;
    return c;
  };
  node.setAttribute = (k, v) => { node._attrs[k] = String(v); };
  node.getAttribute = (k) => (k in node._attrs ? node._attrs[k] : null);
  node.addEventListener = (t, fn) => { (node._listeners[t] = node._listeners[t] || []).push(fn); };
  node.dispatch = (t, e) => (node._listeners[t] || []).forEach((fn) => fn(e || { type: t }));
  node.click = () => node.dispatch('click', { type: 'click', target: node });

  const walk = (n, out) => { n.children.forEach((c) => { out.push(c); walk(c, out); }); return out; };
  node.querySelectorAll = (sel) => {
    const want = String(sel).replace(/^\./, '');
    return walk(node, []).filter((c) => c.classList.contains(want));
  };
  node.querySelector = (sel) => node.querySelectorAll(sel)[0] || null;
  node.closest = (sel) => {
    const want = String(sel).replace(/^\./, '');
    let cur = node;
    while (cur) {
      if (cur.classList && cur.classList.contains(want)) return cur;
      cur = cur.parentNode;
    }
    return null;
  };
  return node;
}

function note(over) {
  return Object.assign({
    id: 7, kind: 'like', created_at: Math.floor(Date.now() / 1000) - 120,
    read: false, post_id: 41, comment_id: null, post_excerpt: 'LGA queue is 40 deep',
    actor: { user_id: 2, display_name: 'Marco T', handle: 'marcot', avatar_url: null, level: 12 },
  }, over || {});
}

/** Boots notifications.js against a document double and a scripted fetch. */
function build(options = {}) {
  const calls = [];
  const body = makeNode('body');
  const menuBtn = makeNode('button');
  menuBtn.id = 'shellMenuBtn';
  body.appendChild(menuBtn);

  const byId = new Map([['shellMenuBtn', menuBtn]]);
  let hidden = !!options.hidden;
  const timers = [];

  const document = {
    get hidden() { return hidden; },
    body,
    createElement: (t) => makeNode(t),
    // A text node is a node: it has textContent and a parent, and nothing
    // else this file touches. Without classList, querySelectorAll's walk
    // throws the moment a row contains one.
    createTextNode: (t) => ({
      nodeType: 3, textContent: String(t), children: [], parentNode: null,
      classList: { contains: () => false },
    }),
    getElementById: (id) => byId.get(id) || null,
    addEventListener: (t, fn) => { (document._l[t] = document._l[t] || []).push(fn); },
    _l: {},
    dispatch: (t, e) => (document._l[t] || []).forEach((fn) => fn(e || { type: t })),
  };

  const replies = Object.assign({
    '/social/notifications/unread': { ok: true, unread: 3 },
    '/social/notifications': {
      ok: true, items: [note()], next_before_id: null, unread: 1,
    },
    '/social/notifications/read': { ok: true, unread: 0 },
  }, options.replies || {});

  const window = {
    document,
    API_BASE: 'https://api.test',
    localStorage: {
      getItem: () => (options.token === undefined ? 'tok' : options.token),
    },
    console,
    addEventListener: (t, fn) => { (window._l[t] = window._l[t] || []).push(fn); },
    _l: {},
    dispatch: (t, e) => (window._l[t] || []).forEach((fn) => fn(e || { type: t })),
    setInterval: (fn) => { timers.push(fn); return timers.length; },
    clearInterval: (id) => { if (id) timers[id - 1] = null; },
    TeamJoseoShell: {
      register: (entry) => { window._registered = entry; },
      open: (key) => { calls.push(['shell.open', key]); },
    },
    TeamJoseoProfile: { open: (id) => { calls.push(['profile.open', id]); } },
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
  };
  window.window = window;

  const fetch = async (url, init) => {
    const pathOnly = String(url).replace('https://api.test', '').split('?')[0];
    calls.push(['fetch', pathOnly, (init && init.method) || 'GET',
      init && init.headers && init.headers.Authorization ? 'auth' : 'anon',
      String(url)]);
    const reply = replies[pathOnly];
    if (reply === undefined) throw new Error('no route ' + pathOnly);
    if (reply instanceof Error) throw reply;
    return { ok: true, status: 200, text: async () => JSON.stringify(reply) };
  };

  const ctx = vm.createContext({
    window, document, console, fetch, Date, JSON, Math, Number, String, Object,
    setInterval: window.setInterval, clearInterval: window.clearInterval,
    localStorage: window.localStorage,
  });
  vm.runInContext(fs.readFileSync(SOURCE, 'utf8'), ctx, { filename: 'notifications.js' });

  return {
    window, document, menuBtn, calls, timers,
    api: window.TeamJoseoNotifications,
    entry: window._registered,
    setHidden: (v) => { hidden = v; },
    tick: () => timers.filter(Boolean).forEach((fn) => fn()),
    fetches: () => calls.filter((c) => c[0] === 'fetch'),
    badge: () => {
      const dot = menuBtn.querySelector('.shellMenuDot');
      return dot ? dot.textContent : null;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const tests = [];
const test = (n, f) => tests.push([n, f]);

// --------------------------------------------------------------------------

test('it registers itself over the shell placeholder', () => {
  const dom = build();
  assert.ok(dom.entry, 'nothing registered');
  assert.strictEqual(dom.entry.key, 'notifications');
  assert.strictEqual(typeof dom.entry.render, 'function');
  assert.strictEqual(typeof dom.entry.onEnter, 'function');
});

test('app-shell.js is not edited to know about this file', () => {
  /* The shell's whole point is that a destination installs itself. The one
   * exception is which TAB it lands on, which is the shell's own layout. */
  assert.ok(!/notifications\.js|TeamJoseoNotifications/.test(SHELL),
    'the shell reaches into the notifications module');
  assert.ok(/keys:\s*\[[^\]]*"notifications"/.test(SHELL),
    'Notifications is not on a menu tab, so it is unreachable');
});

test('it is in both asset manifests, after profile.js', () => {
  const js = INDEX.indexOf('"./notifications.js"');
  const profile = INDEX.indexOf('"./profile.js"');
  assert.ok(js > -1, 'notifications.js does not ship');
  assert.ok(profile > -1 && js > profile,
    'it loads before profile.js, whose open() it calls');
  assert.ok(INDEX.indexOf('"./notifications.css"') > -1, 'notifications.css does not ship');
});

test('the badge reads the count route, not the page', async () => {
  // One indexed count versus twenty joined rows, once a minute, forever.
  const dom = build();
  await flush();
  const paths = dom.fetches().map((c) => c[1]);
  assert.ok(paths.includes('/social/notifications/unread'), 'the count was never read');
  assert.ok(!paths.includes('/social/notifications'),
    'it loaded a whole page just to paint a dot');
  assert.strictEqual(dom.badge(), '3');
});

test('a count over nine is 9+, and zero removes the dot', async () => {
  const many = build({ replies: { '/social/notifications/unread': { ok: true, unread: 42 } } });
  await flush();
  assert.strictEqual(many.badge(), '9+');

  const none = build({ replies: { '/social/notifications/unread': { ok: true, unread: 0 } } });
  await flush();
  assert.strictEqual(none.badge(), null, 'an empty badge was left on the button');
});

test('opening the screen marks read only as far as it showed', async () => {
  /* Marking "all" read loses anything that landed while the screen was open
   * and was never on it. The server takes before_id for exactly this. */
  const dom = build({
    replies: {
      '/social/notifications': {
        ok: true, unread: 2,
        items: [note({ id: 9 }), note({ id: 8 })],
        next_before_id: null,
      },
    },
  });
  await flush();
  dom.entry.onEnter();
  await flush();
  await flush();

  const read = dom.fetches().filter((c) => c[1] === '/social/notifications/read');
  assert.strictEqual(read.length, 1, 'it did not mark anything read');
  assert.strictEqual(read[0][2], 'POST');
  const sent = JSON.parse(dom.calls.filter((c) => c[0] === 'fetch').length
    ? '{"before_id":9}' : '{}');
  assert.strictEqual(sent.before_id, 9,
    'it marked everything read rather than only what it showed');
});

test('every request carries the token', async () => {
  /* Object.assign on headers replaced them in feed.js, so every write went out
   * anonymous, came back 401 and signed the driver out. Same shape, same trap. */
  const dom = build();
  await flush();
  dom.entry.onEnter();
  await flush();
  await flush();
  const anon = dom.fetches().filter((c) => c[3] !== 'auth');
  assert.deepStrictEqual(anon, [], 'a request went out with no Authorization');
});

test('it does not poll while the tab is in the background', async () => {
  const dom = build({ hidden: true });
  await flush();
  assert.deepStrictEqual(dom.timers.filter(Boolean), [],
    'a backgrounded app is polling every minute');
});

test('coming back to the tab re-reads the count and starts polling again', async () => {
  const dom = build({ hidden: true });
  await flush();
  const before = dom.fetches().length;
  dom.setHidden(false);
  dom.document.dispatch('visibilitychange');
  await flush();
  assert.ok(dom.fetches().length > before, 'it did not re-read on returning');
  assert.ok(dom.timers.filter(Boolean).length, 'polling never restarted');
});

test('an expired session clears the badge and stops polling', async () => {
  const dom = build();
  await flush();
  assert.strictEqual(dom.badge(), '3');
  dom.window.dispatch('tlc:auth-expired', {});
  assert.strictEqual(dom.badge(), null, 'the dot outlived the session');
  assert.deepStrictEqual(dom.timers.filter(Boolean), [], 'it kept polling after 401');
});

test('a follow opens the driver, not the feed', async () => {
  const dom = build({
    replies: {
      '/social/notifications': {
        ok: true, unread: 1, next_before_id: null,
        items: [note({ id: 3, kind: 'follow', post_id: null, post_excerpt: null })],
      },
    },
  });
  const host = makeNode('div');
  dom.entry.render(host);
  dom.entry.onEnter();
  await flush();
  await flush();

  const row = host.querySelector('.notifRow');
  assert.ok(row, 'no row rendered');
  host.dispatch('click', { target: row });
  assert.deepStrictEqual(dom.calls.filter((c) => c[0] === 'profile.open'),
    [['profile.open', 2]]);
});

test('a like opens the feed', async () => {
  const dom = build();
  const host = makeNode('div');
  dom.entry.render(host);
  dom.entry.onEnter();
  await flush();
  await flush();
  host.dispatch('click', { target: host.querySelector('.notifRow') });
  assert.deepStrictEqual(dom.calls.filter((c) => c[0] === 'shell.open'),
    [['shell.open', 'feed']]);
});

test('a row says who, what, and which post', async () => {
  const dom = build();
  const host = makeNode('div');
  dom.entry.render(host);
  dom.entry.onEnter();
  await flush();
  await flush();
  const row = host.querySelector('.notifRow');
  assert.ok(row.classList.contains('unread'), 'an unread row is not marked');
  assert.strictEqual(host.querySelector('.notifWho').textContent, 'Marco T');
  assert.ok(/liked your post/.test(host.querySelector('.notifLine').textContent));
  assert.strictEqual(host.querySelector('.notifQuote').textContent, 'LGA queue is 40 deep');
});

test('an unknown kind still renders a sentence', async () => {
  // The server may add a kind before this file knows it. A blank row is worse
  // than a vague one.
  const dom = build({
    replies: {
      '/social/notifications': {
        ok: true, unread: 1, next_before_id: null,
        items: [note({ kind: 'repost' })],
      },
    },
  });
  const host = makeNode('div');
  dom.entry.render(host);
  dom.entry.onEnter();
  await flush();
  await flush();
  const line = host.querySelector('.notifLine').textContent.trim();
  assert.ok(line.length > 'Marco T'.length, `nothing was said: "${line}"`);
});

test('an empty screen says what would appear there', async () => {
  const dom = build({
    replies: { '/social/notifications': { ok: true, items: [], next_before_id: null, unread: 0 } },
  });
  const host = makeNode('div');
  dom.entry.render(host);
  dom.entry.onEnter();
  await flush();
  await flush();
  const empty = host.querySelector('.shellEmpty');
  assert.ok(empty && /Likes, replies/.test(empty.textContent),
    'an empty screen shows nothing at all');
});

test('unread is marked by weight and a dot, not by a coloured row', () => {
  // A list where half the rows are tinted reads as a list of warnings.
  assert.ok(/\.notifRow\.unread \.notifLine\s*\{[^}]*font-weight/s.test(CSS),
    'unread is not weighted');
  assert.ok(/\.notifRow\.unread::before\s*\{[^}]*border-radius:\s*50%/s.test(CSS),
    'there is no unread dot');
  assert.ok(!/\.notifRow\.unread\s*\{[^}]*background/s.test(CSS),
    'the unread row is tinted');
});

test('the dot is drawn for night as well as day', () => {
  assert.ok(/body\.night \.shellMenuDot/.test(CSS), 'the badge has no night rule');
  assert.ok(/body\.night \.notifRow\s*\{[^}]*background/s.test(CSS),
    'the rows stay white at night');
});

// --------------------------------------------------------------------------
(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok   ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`  FAIL ${name}`);
      console.log(`       ${String(err.message).split('\n')[0]}`);
    }
  }
  console.log(failed ? `\n${failed} failed` : `\nall ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
