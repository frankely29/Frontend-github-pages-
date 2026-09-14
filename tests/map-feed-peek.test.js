#!/usr/bin/env node
/**
 * map-feed-peek.test.js — the feed panel on the map, on the real shipped file.
 *
 * What is worth pinning is not that it renders a row. It is the handful of
 * decisions that would quietly go wrong:
 *
 *   - a refresh that fails blanking posts a driver was mid-glance at,
 *   - the panel driving feed.js's own state and resetting the Feed screen,
 *   - it disappearing when the map locks, which is exactly backwards,
 *   - and it landing on top of the top button row or the preview countdown.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'map-feed-peek.js');
const CSS = fs.readFileSync(path.join(ROOT, 'map-feed-peek.css'), 'utf8');
const SHELL_CSS = fs.readFileSync(path.join(ROOT, 'app-shell.css'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SRC = fs.readFileSync(SOURCE, 'utf8');

// --------------------------------------------------------------------------
// the smallest DOM this file touches
// --------------------------------------------------------------------------

function makeNode(tag) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [], parentNode: null, style: {}, hidden: false, id: '',
    _classes: new Set(), _text: '', _attrs: {}, _listeners: {},
  };
  node.classList = {
    add: (...n) => n.forEach((x) => x && node._classes.add(x)),
    remove: (...n) => n.forEach((x) => node._classes.delete(x)),
    contains: (x) => node._classes.has(x),
    toggle: (x, on) => { if (on) node._classes.add(x); else node._classes.delete(x); },
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
    set(v) { node._text = String(v); node.children.forEach((c) => { c.parentNode = null; }); node.children = []; },
  });
  node.appendChild = (c) => { c.parentNode = node; node.children.push(c); return c; };
  node.remove = () => {
    if (!node.parentNode) return;
    const i = node.parentNode.children.indexOf(node);
    if (i >= 0) node.parentNode.children.splice(i, 1);
    node.parentNode = null;
  };
  node.setAttribute = (k, v) => { node._attrs[k] = String(v); };
  node.getAttribute = (k) => (k in node._attrs ? node._attrs[k] : null);
  node.removeAttribute = (k) => { delete node._attrs[k]; };
  node.addEventListener = (t, fn) => { (node._listeners[t] = node._listeners[t] || []).push(fn); };
  node.dispatch = (t, e) => (node._listeners[t] || []).forEach((fn) => fn(e || { type: t }));
  const walk = (n, out) => { n.children.forEach((c) => { out.push(c); walk(c, out); }); return out; };
  node.querySelectorAll = (sel) => {
    const want = String(sel).replace(/^\./, '');
    return walk(node, []).filter((c) => c.classList.contains(want));
  };
  node.querySelector = (sel) => node.querySelectorAll(sel)[0] || null;
  return node;
}

/** The shipped markup, rebuilt: #mapFeedPeek wrapping a .peekList. */
function build(options = {}) {
  const host = makeNode('div');
  host.id = 'mapFeedPeek';
  const head = makeNode('div'); head.className = 'peekHead';
  const list = makeNode('div'); list.className = 'peekList';
  host.appendChild(head); host.appendChild(list);

  const bodyEl = makeNode('body');
  const calls = [];
  const responses = (options.responses || []).slice();
  const opened = [];

  const document = {
    readyState: 'complete',
    hidden: false,
    body: bodyEl,
    createElement: (t) => makeNode(t),
    getElementById: (id) => (id === 'mapFeedPeek' ? host : null),
    addEventListener: (t, fn) => { (document._l[t] = document._l[t] || []).push(fn); },
    _l: {},
    dispatch: (t, e) => (document._l[t] || []).forEach((fn) => fn(e)),
  };
  const window = {
    document, console,
    API_BASE: 'https://api.example.com',
    TeamJoseoShell: { open: (k) => opened.push(k) },
    TeamJoseoFeed: options.noFeed ? undefined : {
      ago: () => '3m',
      initials: (n) => String(n || '?').slice(0, 1).toUpperCase(),
    },
    setInterval: (fn, ms) => { window._interval = { fn, ms }; return 1; },
    clearInterval: () => { window._interval = null; },
    addEventListener: (t, fn) => { (window._l[t] = window._l[t] || []).push(fn); },
    _l: {},
    dispatch: (t, e) => (window._l[t] || []).forEach((fn) => fn(e)),
  };
  window.window = window;

  const ctx = vm.createContext({
    window, document, console,
    localStorage: { getItem: () => (options.token === undefined ? 'a-token' : options.token) },
    fetch: async (url, opts) => {
      calls.push({ url, opts: opts || {} });
      const next = responses.shift();
      if (!next) throw new Error(`no canned response for ${url}`);
      if (next.throws) { const e = new Error('network down'); e.status = next.status; throw e; }
      return {
        ok: next.status === undefined || (next.status >= 200 && next.status < 300),
        status: next.status === undefined ? 200 : next.status,
        statusText: 'x',
        text: async () => JSON.stringify(next.body === undefined ? {} : next.body),
      };
    },
    Object, Number, Math, Array, String, Date, JSON, Error, encodeURIComponent, Boolean,
  });
  vm.runInContext(fs.readFileSync(SOURCE, 'utf8'), ctx, { filename: 'map-feed-peek.js' });

  return { window, document, host, list, body: bodyEl, calls, opened,
           api: window.TeamJoseoMapFeedPeek };
}

const post = (over = {}) => Object.assign({
  id: 1, body: 'Red Hook is moving.', created_at: Math.floor(Date.now() / 1000) - 200,
  author: { user_id: 9, display_name: 'Aisha D.', avatar_url: null },
}, over);
const feedBody = (items) => ({ body: { ok: true, items } });
const tick = () => new Promise((r) => setImmediate(r));

const tests = [];
const test = (n, f) => tests.push([n, f]);

// --------------------------------------------------------------------------

test('it shows the latest posts without anyone opening the feed', async () => {
  const dom = build({ responses: [feedBody([post({ id: 1, body: 'Red Hook is moving.' }),
    post({ id: 2, body: 'JFK queue is 40 deep.' })])] });
  await tick(); await tick();
  const rows = dom.host.querySelectorAll('.peekRow');
  assert.strictEqual(rows.length, 2, 'posts did not render');
  assert.ok(dom.host.textContent.includes('Red Hook is moving.'), dom.host.textContent);
  assert.ok(dom.host.textContent.includes('Aisha D.'), 'no author');
});

test('it asks for everyone, not the scope the Feed screen is on', async () => {
  // Following is empty for anyone who cannot follow, and a quiet city has no
  // city posts. An empty quarter of the map teaches a driver there is nothing
  // here, which is the opposite of what the panel is for.
  const dom = build({ responses: [feedBody([post()])] });
  await tick(); await tick();
  assert.ok(dom.calls[0].url.includes('scope=everyone'), dom.calls[0].url);
  assert.ok(/limit=\d+/.test(dom.calls[0].url), 'it asks for the whole feed');
});

test('it never drives feed.js state', async () => {
  // feed.js owns the Feed SCREEN. Two callers writing one list means a peek
  // refresh silently resets whatever the driver had loaded and scrolled to.
  assert.ok(!/TeamJoseoFeed\.(load|setScope|_state)/.test(SRC),
    'the peek reaches into the Feed screen state');
});

test('tapping anywhere in it opens the feed', async () => {
  const dom = build({ responses: [feedBody([post()])] });
  await tick(); await tick();
  dom.host.dispatch('click', { type: 'click', preventDefault() {} });
  assert.deepStrictEqual(dom.opened, ['feed']);
});

test('it is reachable from a keyboard', async () => {
  const dom = build({ responses: [feedBody([post()])] });
  await tick(); await tick();
  dom.host.dispatch('keydown', { key: 'Enter', preventDefault() {} });
  assert.deepStrictEqual(dom.opened, ['feed']);
});

test('a failed refresh keeps the posts already on screen', async () => {
  // A driver glancing at three posts should not watch them vanish because one
  // request timed out in a tunnel.
  const dom = build({ responses: [feedBody([post({ body: 'Still here.' })]), { throws: true }] });
  await tick(); await tick();
  assert.ok(dom.host.textContent.includes('Still here.'));
  await dom.api.load();
  await tick();
  assert.ok(dom.host.textContent.includes('Still here.'),
    `a failed refresh blanked the panel: "${dom.host.textContent}"`);
});

test('a 401 does clear them', async () => {
  // The app is about to show the welcome page; these are not their posts.
  const dom = build({ responses: [feedBody([post({ body: 'Theirs.' })]),
    { throws: true, status: 401 }] });
  await tick(); await tick();
  await dom.api.load();
  await tick();
  assert.ok(!dom.host.textContent.includes('Theirs.'), dom.host.textContent);
});

test('signing out empties it', async () => {
  const dom = build({ responses: [feedBody([post({ body: 'Mine.' })])] });
  await tick(); await tick();
  dom.window.dispatch('tlc:auth-expired', {});
  assert.ok(!dom.host.textContent.includes('Mine.'), dom.host.textContent);
});

test('a signed-out driver gets no panel and no request', async () => {
  const dom = build({ token: '', responses: [] });
  await tick(); await tick();
  assert.strictEqual(dom.calls.length, 0, 'it called the API with no token');
  assert.strictEqual(dom.host.hidden, true, 'the panel is on screen with nothing in it');
});

test('an empty feed invites the first post rather than showing nothing', async () => {
  const dom = build({ responses: [feedBody([])] });
  await tick(); await tick();
  assert.ok(/be the first/i.test(dom.host.textContent), dom.host.textContent);
});

test('it refreshes on a timer, and not while nobody is looking', async () => {
  const dom = build({ responses: [feedBody([post()]), feedBody([post({ id: 2 })])] });
  await tick(); await tick();
  const before = dom.calls.length;
  dom.document.hidden = true;
  dom.window._interval.fn();
  await tick();
  assert.strictEqual(dom.calls.length, before, 'it polled a hidden tab');
  dom.document.hidden = false;
  dom.body.classList.add('shell-screen-open');
  dom.window._interval.fn();
  await tick();
  assert.strictEqual(dom.calls.length, before, 'it polled while a screen covered the map');
  dom.body.classList.remove('shell-screen-open');
  dom.window._interval.fn();
  await tick();
  assert.strictEqual(dom.calls.length, before + 1, 'it never refreshes');
});

test('the refresh interval is not a poll', async () => {
  const dom = build({ responses: [feedBody([post()])] });
  await tick(); await tick();
  assert.ok(dom.window._interval.ms >= 60000,
    `refreshing every ${dom.window._interval.ms}ms is a poll`);
});

test('it works if feed.js never loaded', async () => {
  // Load order is the manifest's business; this file must not depend on
  // winning it.
  const dom = build({ noFeed: true, responses: [feedBody([post()])] });
  await tick(); await tick();
  assert.ok(dom.host.querySelectorAll('.peekRow').length === 1,
    'it fell over without TeamJoseoFeed');
});

test('a post with only a photo still says something', async () => {
  const dom = build({ responses: [feedBody([
    post({ body: '', image_thumb_url: '/img/1.jpg' })])] });
  await tick(); await tick();
  assert.ok(/photo/i.test(dom.host.textContent), dom.host.textContent);
});

test('long posts are clipped by CSS, never trimmed in script', () => {
  // A post cut to a character count is cut at the wrong width on every screen
  // but the one it was measured on.
  assert.ok(!/\.slice\(0,\s*\d{2,}\)|substring\(/.test(SRC),
    'the peek trims post text itself');
  assert.ok(/\.peekBody\s*\{[^}]*text-overflow:\s*ellipsis/s.test(CSS),
    'nothing clips the post line');
  assert.ok(/\.peekBody\s*\{[^}]*white-space:\s*nowrap/s.test(CSS), 'it can wrap to two lines');
});

// --------------------------------------------------------------------------
// where it sits
// --------------------------------------------------------------------------

const rule = (css, sel) => {
  const m = css.match(new RegExp('(^|[}\\n])\\s*'
    + sel.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'm'));
  assert.ok(m, `no rule for "${sel}"`);
  return m[2];
};

test('it takes about a quarter of the screen', () => {
  const body = rule(CSS, '#mapFeedPeek');
  const m = body.match(/height:\s*clamp\([^,]+,\s*(\d+)(dvh|vh)/);
  assert.ok(m, `no clamped viewport height: "${body.trim().slice(0, 120)}"`);
  assert.strictEqual(Number(m[1]), 25, `the panel is ${m[1]}% of the screen, not a quarter`);
  assert.ok(/@supports \(height: 25dvh\)/.test(CSS),
    'no dvh height, so on a phone this is a quarter of more than the driver can see');
});

test('it sits below the top button row, never on it', () => {
  // The menu button on the left and the recentre/report pair on the right both
  // run from safe-area + 14 to + 62.
  const body = rule(CSS, '#mapFeedPeek');
  const m = body.match(/top:\s*calc\(env\(safe-area-inset-top,\s*0px\)\s*\+\s*(\d+)px\)/);
  assert.ok(m, `no safe-area-aware top: "${body.trim().slice(0, 160)}"`);
  assert.ok(Number(m[1]) >= 62, `it starts at +${m[1]}px, under the menu button`);
});

test('the preview countdown and the panel are never in the same slot', () => {
  // This is the collision that clipped the countdown's own text the first time
  // something was put in that row.
  assert.ok(/html\.tj-map-preview:not\(\.tj-map-locked\)\s+#mapFeedPeek\s*\{[^}]*top:/s.test(CSS),
    'the panel does not move out of the countdown\'s way');
});

test('it stays when the map locks', () => {
  // Backwards would be to take it away: reading the feed is free, and drivers
  // talking about what the map told them is the reason to pay for the map.
  const critical = (INDEX.match(/<style id="tjBootCritical">([\s\S]*?)<\/style>/) || [])[1] || '';
  const rules = critical.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/tj-map-locked[^{]*#mapFeedPeek/.test(rules),
    'the map lock hides the feed panel');
  // `backdrop-filter: blur()` is the frosted background and is wanted; a bare
  // `filter: blur()` would blur the posts themselves, which is the map's
  // punishment, not the feed's. The first cut of this assertion did not tell
  // them apart and failed on the frosting.
  const panel = rule(CSS, '#mapFeedPeek');
  assert.ok(!/(^|[^-])filter:\s*blur/.test(panel),
    `the posts themselves are blurred: "${panel.trim().slice(0, 160)}"`);
});

test('it is out of the way while a destination is open', () => {
  assert.ok(/body\.shell-screen-open[^{]*#mapFeedPeek/s.test(SHELL_CSS),
    'the panel floats over the Feed screen it just opened');
});

test('it does not outrank the app chrome', () => {
  const z = Number((rule(CSS, '#mapFeedPeek').match(/z-index:\s*(\d+)/) || [])[1]);
  assert.ok(Number.isFinite(z), 'no z-index');
  assert.ok(z > 700, `z-index ${z} is under the map's own canvas`);
  assert.ok(z < 3000, `z-index ${z} puts the panel over the dock and the menu button`);
});

test('nothing inside it steals the tap', () => {
  assert.ok(/#mapFeedPeek \*\s*\{[^}]*pointer-events:\s*none/s.test(CSS),
    'a child can swallow the tap that opens the feed');
});

test('it is in the markup and in the manifest', () => {
  const noComments = INDEX.replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(/id="mapFeedPeek"/.test(noComments), 'the panel is not in the page');
  assert.ok(/class="peekList"/.test(noComments), 'nothing for the posts to render into');
  assert.ok(/role="button"/.test(noComments.slice(noComments.indexOf('id="mapFeedPeek"') - 120,
    noComments.indexOf('id="mapFeedPeek"') + 200)), 'it does not announce itself as tappable');
  assert.ok(INDEX.includes('"./map-feed-peek.css"'), 'css not loaded');
  assert.ok(INDEX.includes('"./map-feed-peek.js"'), 'script not loaded');
});

test('it has a night palette', () => {
  assert.ok(/body\.night #mapFeedPeek/.test(CSS), 'a white slab on a night map');
});

let failed = 0;
(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ok   ${name}`); }
    catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err && err.message}`); }
  }
  console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
