#!/usr/bin/env node
/**
 * feed.test.js — the Feed destination, driven against the real shipped file.
 *
 * The interesting failures in a feed are not visual. They are: a tab you
 * switched away from writing its results over the tab you switched to, a like
 * count that drifts from the server after a failed request, a cursor that
 * refetches page one forever, and an empty state that says "no posts" when the
 * real answer is "you follow nobody". Each of those gets a test.
 *
 * fetch is replaced with a queue, so every test states exactly what the server
 * said and nothing touches the network.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'feed.css'), 'utf8');
const JS_SOURCE = path.join(ROOT, 'feed.js');

// --------------------------------------------------------------------------
// a DOM just large enough for feed.js
// --------------------------------------------------------------------------

function makeNode(tag) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [], parentNode: null, hidden: false, id: '', type: '', src: '', alt: '',
    loading: '', disabled: false, scrollTop: 0,
    _classes: new Set(), _text: '', _attrs: {}, _listeners: {},
  };
  node.style = new Proxy({}, { get: (t, k) => t[k], set: (t, k, v) => { t[k] = v; return true; } });
  node.classList = {
    add: (...n) => n.forEach((x) => x && node._classes.add(x)),
    remove: (...n) => n.forEach((x) => node._classes.delete(x)),
    contains: (x) => node._classes.has(x),
    toggle: (x, on) => (on ? node._classes.add(x) : node._classes.delete(x)),
  };
  Object.defineProperty(node, 'className', {
    get: () => [...node._classes].join(' '),
    set: (v) => { node._classes.clear(); String(v || '').split(/\s+/).forEach((x) => x && node._classes.add(x)); },
  });
  Object.defineProperty(node, 'textContent', {
    get: () => (node.children.length
      ? node._text + node.children.map((c) => c.textContent).join('')
      : node._text),
    set: (v) => { node._text = String(v); node.children.forEach((c) => { c.parentNode = null; }); node.children = []; },
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
  node.addEventListener = (t, fn) => { (node._listeners[t] = node._listeners[t] || []).push(fn); };
  node.dispatch = (t, e) => (node._listeners[t] || []).forEach((fn) => fn(e || { type: t }));
  node.click = () => {
    const event = { type: 'click', target: node };
    let cur = node;
    while (cur) { cur.dispatch('click', event); cur = cur.parentNode; }
  };
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

function post(overrides = {}) {
  return Object.assign({
    id: 1,
    author: { user_id: 7, display_name: 'Marcus R.', handle: 'marcus',
      city: 'New York', avatar_url: null, level: 24, platforms: ['fhv'] },
    body: "Lot's actually moving tonight.",
    image_url: null, image_thumb_url: null,
    city: 'Queens', lat: null, lng: null,
    zone_name: 'JFK Airport', zone_rating: 91,
    like_count: 128, liked_by_me: false, mine: false,
    created_at: Math.floor(Date.now() / 1000) - 1080,
  }, overrides);
}

function comment(id, over = {}) {
  return Object.assign({
    id,
    post_id: 1,
    author: { user_id: 9, display_name: 'Aisha D.', handle: 'aisha',
      city: 'New York', avatar_url: null, level: 41, platforms: ['lyft'] },
    body: 'Confirmed, moving here too.',
    mine: false, can_delete: false,
    created_at: Math.floor(Date.now() / 1000) - 300,
  }, over);
}

function build(options = {}) {
  const registered = [];
  const calls = [];
  const responses = (options.responses || []).slice();

  const document = {
    readyState: 'complete',
    createElement: (t) => makeNode(t),
    addEventListener: (t, fn) => { (document._l = document._l || {})[t] = fn; },
  };
  const window = {
    document, console,
    API_BASE: 'https://api.example.com',
    addEventListener: (t, fn) => { (window._l[t] = window._l[t] || []).push(fn); },
    _l: {}, _fired: [],
    dispatch: (t, e) => (window._l[t] || []).forEach((fn) => fn(e)),
    TeamJoseoShell: options.noShell ? undefined : {
      register: (entry) => registered.push(entry),
    },
  };
  window.window = window;

  const ctx = vm.createContext({
    window, document, console,
    localStorage: {
      getItem: () => (options.token === undefined ? 'a-token' : options.token),
    },
    CustomEvent: function (type, init) {
      this.type = type; this.detail = init && init.detail;
      window._fired.push(type);
    },
    fetch: async (url, opts) => {
      calls.push({ url, opts: opts || {} });
      const next = responses.shift();
      if (!next) throw new Error(`no canned response for ${url}`);
      if (next.throws) throw new Error('network down');
      return {
        ok: next.status === undefined || (next.status >= 200 && next.status < 300),
        status: next.status === undefined ? 200 : next.status,
        statusText: 'x',
        text: async () => JSON.stringify(next.body === undefined ? {} : next.body),
      };
    },
    Object, Number, Math, Array, String, Date, JSON, Error, encodeURIComponent, Boolean,
  });
  vm.runInContext(fs.readFileSync(JS_SOURCE, 'utf8'), ctx, { filename: 'feed.js' });

  const api = window.TeamJoseoFeed;
  const entry = registered[registered.length - 1] || null;
  const body = makeNode('div');
  if (entry && entry.render) entry.render(body);
  return { window, document, api, entry, body, calls, registered, responses };
}

const feedBody = (items, next = null) => ({ body: { ok: true, scope: 'following', items, next_before_id: next } });
const tick = () => new Promise((r) => setImmediate(r));

const tests = [];
const test = (n, f) => tests.push([n, f]);

// --------------------------------------------------------------------------
// installation
// --------------------------------------------------------------------------

test('it registers itself over the shell placeholder', () => {
  const dom = build();
  assert.ok(dom.entry, 'nothing registered');
  assert.strictEqual(dom.entry.key, 'feed');
  assert.strictEqual(typeof dom.entry.render, 'function');
  assert.strictEqual(typeof dom.entry.onEnter, 'function');
});

test('it waits for the shell rather than racing it', () => {
  // app-shell.js registers its placeholder at DOMContentLoaded. Registering
  // before it would be silently overwritten by the empty state.
  const dom = build({ noShell: true });
  assert.strictEqual(dom.registered.length, 0);
  assert.strictEqual(typeof dom.document._l.DOMContentLoaded, 'function',
    'nothing is waiting to install once the shell exists');
});

test('app-shell.js is not edited to know about the feed', () => {
  const shell = fs.readFileSync(path.join(ROOT, 'app-shell.js'), 'utf8');
  assert.ok(!shell.includes('TeamJoseoFeed'),
    'the shell reaches into the feed — registration is meant to be one-way');
});

// --------------------------------------------------------------------------
// scopes
// --------------------------------------------------------------------------

test('the scopes are the ones the server actually has', () => {
  // "Nearby" and "Nights" were drawn, but the API has no radius scope and no
  // time-of-day scope. A tab that lies about what it filters is worse than a
  // tab with a plainer name.
  const dom = build();
  // Joined rather than deepStrictEqual: the array is built inside the vm's own
  // realm, so it is not reference-equal to one built out here.
  assert.strictEqual(dom.api.scopes.map((s) => s.key).join(','), 'following,city,everyone');
});

test('switching scope refetches with that scope', async () => {
  const dom = build({ responses: [feedBody([]), feedBody([])] });
  await dom.entry.onEnter();
  await tick();
  dom.api.setScope('everyone');
  await tick();
  assert.ok(dom.calls[dom.calls.length - 1].url.includes('scope=everyone'),
    dom.calls[dom.calls.length - 1].url);
});

test('an unknown scope is ignored rather than sent to the server', () => {
  const dom = build({ responses: [] });
  dom.api.setScope('nights');
  assert.strictEqual(dom.api._state.scope, 'following');
  assert.strictEqual(dom.calls.length, 0);
});

test('re-picking the current scope does not refetch', async () => {
  const dom = build({ responses: [feedBody([])] });
  await dom.entry.onEnter();
  await tick();
  const before = dom.calls.length;
  dom.api.setScope('following');
  await tick();
  assert.strictEqual(dom.calls.length, before);
});

test("a late response for a tab you left does not overwrite the tab you are on", async () => {
  // The classic feed bug: tap Everyone while Following is still in flight and
  // the slower response paints the wrong posts under the wrong tab.
  const dom = build({ responses: [feedBody([post({ id: 1 })]), feedBody([post({ id: 99 })])] });
  const first = dom.api.load();
  dom.api._state.scope = 'everyone'; // switched mid-flight
  await first;
  await tick();
  assert.notStrictEqual(dom.api._state.items[0] && dom.api._state.items[0].id, 1,
    'the stale Following response was painted under Everyone');
});

// --------------------------------------------------------------------------
// the card
// --------------------------------------------------------------------------

test('a card shows the name, level, handle, platform, age and city', () => {
  const dom = build();
  const card = dom.api.buildCard(post());
  const text = card.textContent;
  ['Marcus R.', 'LVL 24', '@marcus', 'FHV', '18m', 'Queens'].forEach((bit) => {
    assert.ok(text.includes(bit), `card is missing ${bit} — got: ${text}`);
  });
});

test('the card shows platform keys as words', () => {
  const dom = build();
  const card = dom.api.buildCard(post({
    author: { user_id: 7, display_name: 'A', handle: 'a', level: 1,
      platforms: ['uber', 'black_car'] } }));
  assert.ok(card.textContent.includes('Uber Black car'), card.textContent);
});

test('acronyms the server stores lowercase are not title-cased into typos', () => {
  // VEHICLE_CHOICES has "suv" and "ev". "Suv" and "Ev" read as mistakes.
  const dom = build();
  assert.strictEqual(dom.api.prettyChoice('suv'), 'SUV');
  assert.strictEqual(dom.api.prettyChoice('ev'), 'EV');
  assert.strictEqual(dom.api.prettyChoice('minivan'), 'Minivan');
});

test('a driver with no level and no platform still gets a clean card', () => {
  // Both fields are optional on the API. Rendering "LVL undefined" or a row of
  // orphaned separators is how optional fields go wrong.
  const dom = build();
  const card = dom.api.buildCard(post({
    author: { user_id: 3, display_name: 'Quiet Driver', handle: null, level: null, platforms: [] },
    city: null,
  }));
  const text = card.textContent;
  assert.ok(!text.includes('LVL'), text);
  assert.ok(!text.includes('undefined') && !text.includes('null'), text);
  assert.ok(!/·\s*·/.test(text), `orphaned separator in: ${text}`);
  assert.ok(!/^\s*·|·\s*$/.test(card.querySelector('.feedMeta').textContent),
    'meta line starts or ends with a separator');
});

test('a level of 0 renders rather than vanishing', () => {
  const dom = build();
  const card = dom.api.buildCard(post({
    author: { user_id: 3, display_name: 'New Driver', level: 0, platforms: [] } }));
  assert.ok(card.textContent.includes('LVL 0'), card.textContent);
});

test('the zone score uses the map legend bands', () => {
  // A 44 coloured green here would teach a driver the wrong thing about the
  // map, which is the one surface this app must never contradict.
  const dom = build();
  assert.strictEqual(dom.api.scoreColor(91).bg, '#00b050');
  assert.strictEqual(dom.api.scoreColor(44).bg, '#ffd400');
  assert.strictEqual(dom.api.scoreColor(22).bg, '#e60000');
  assert.strictEqual(dom.api.scoreColor(null), null);
});

test('a score of 0 still gets a badge', () => {
  const dom = build();
  const card = dom.api.buildCard(post({ zone_rating: 0 }));
  assert.ok(card.querySelector('.feedZoneScore'), 'a zero-rated zone lost its badge');
});

test('a post with no zone shows no zone pill', () => {
  const dom = build();
  const card = dom.api.buildCard(post({ zone_name: null, zone_rating: null }));
  assert.strictEqual(card.querySelector('.feedZone'), null);
});

test('image urls are absolute against the api base', () => {
  // They come back as server-relative paths. Rendering them against the Pages
  // origin asks github.io for the photo, which 404s.
  const dom = build();
  const card = dom.api.buildCard(post({ image_thumb_url: '/social/posts/1/image/thumb' }));
  assert.strictEqual(card.querySelector('.feedImage').src,
    'https://api.example.com/social/posts/1/image/thumb');
});

test('relative time reads the way a driver reads it', () => {
  const now = Math.floor(Date.now() / 1000);
  const dom = build();
  assert.strictEqual(dom.api.ago(now - 10), 'now');
  assert.strictEqual(dom.api.ago(now - 1080), '18m');
  assert.strictEqual(dom.api.ago(now - 7200), '2h');
  assert.strictEqual(dom.api.ago(now - 172800), '2d');
  assert.strictEqual(dom.api.ago(0), '');
  assert.strictEqual(dom.api.ago(null), '');
});

test('initials survive one name, three names and no name', () => {
  const dom = build();
  assert.strictEqual(dom.api.initials('Marcus Rivera'), 'MR');
  assert.strictEqual(dom.api.initials('Marcus'), 'MA');
  assert.strictEqual(dom.api.initials('Ana Lucia Diaz'), 'AD');
  assert.strictEqual(dom.api.initials(''), '?');
  assert.strictEqual(dom.api.initials(null), '?');
});

// --------------------------------------------------------------------------
// liking
// --------------------------------------------------------------------------

test('a like paints immediately and keeps the server count', async () => {
  const dom = build({ responses: [feedBody([post({ id: 5, like_count: 128 })]),
    { body: { ok: true, post_id: 5, like_count: 130 } }] });
  await dom.entry.onEnter();
  await tick();
  const button = dom.body.querySelector('[data-role="like"]');
  button.click();
  // Optimistic: 129 before the server answers.
  assert.strictEqual(dom.api._state.items[0].like_count, 129);
  await tick();
  await tick();
  // Two people liked at once; the server's number wins.
  assert.strictEqual(dom.api._state.items[0].like_count, 130);
  assert.strictEqual(dom.api._state.items[0].liked_by_me, true);
});

test('a failed like is rolled all the way back', async () => {
  // A count that drifts from the server is worse than a slow one: the driver
  // sees a like that is not there and never will be.
  const dom = build({ responses: [feedBody([post({ id: 5, like_count: 128 })]), { throws: true }] });
  await dom.entry.onEnter();
  await tick();
  dom.body.querySelector('[data-role="like"]').click();
  await tick();
  await tick();
  assert.strictEqual(dom.api._state.items[0].like_count, 128);
  assert.strictEqual(dom.api._state.items[0].liked_by_me, false);
});

test('unliking sends DELETE, not POST', async () => {
  const dom = build({ responses: [feedBody([post({ id: 5, liked_by_me: true, like_count: 4 })]),
    { body: { ok: true, post_id: 5, like_count: 3 } }] });
  await dom.entry.onEnter();
  await tick();
  dom.body.querySelector('[data-role="like"]').click();
  await tick();
  await tick();
  assert.strictEqual(dom.calls[dom.calls.length - 1].opts.method, 'DELETE');
  assert.strictEqual(dom.api._state.items[0].like_count, 3);
});

test('a like count never goes negative', async () => {
  const dom = build({ responses: [feedBody([post({ id: 5, liked_by_me: true, like_count: 0 })]),
    { body: { ok: true, post_id: 5, like_count: 0 } }] });
  await dom.entry.onEnter();
  await tick();
  dom.body.querySelector('[data-role="like"]').click();
  assert.ok(dom.api._state.items[0].like_count >= 0, 'went negative');
});

// --------------------------------------------------------------------------
// paging
// --------------------------------------------------------------------------

test('load more pages from the cursor rather than refetching page one', async () => {
  const dom = build({ responses: [
    feedBody([post({ id: 20 }), post({ id: 19 })], 19),
    feedBody([post({ id: 18 })], null),
  ] });
  await dom.entry.onEnter();
  await tick();
  dom.body.querySelector('[data-role="more"]').click();
  await tick();
  await tick();
  const last = dom.calls[dom.calls.length - 1].url;
  assert.ok(last.includes('before_id=19'), last);
  assert.strictEqual(dom.api._state.items.length, 3, 'the next page replaced instead of appending');
});

test('no cursor means no load-more button', async () => {
  const dom = build({ responses: [feedBody([post({ id: 1 })], null)] });
  await dom.entry.onEnter();
  await tick();
  assert.strictEqual(dom.body.querySelector('[data-role="more"]'), null);
});

test('the page size is asked for explicitly', async () => {
  const dom = build({ responses: [feedBody([])] });
  await dom.entry.onEnter();
  await tick();
  assert.ok(/limit=\d+/.test(dom.calls[0].url), dom.calls[0].url);
});

// --------------------------------------------------------------------------
// empty and error states
// --------------------------------------------------------------------------

test('each scope explains its own emptiness', async () => {
  // "No posts yet" under Following when the real answer is "you follow nobody"
  // is a dead end: it tells a driver nothing they can act on.
  const dom = build({ responses: [feedBody([]), feedBody([]), feedBody([])] });
  await dom.entry.onEnter();
  await tick();
  const following = dom.body.querySelector('.feedNotice').textContent;
  assert.ok(/follow/i.test(following), following);

  dom.api.setScope('city');
  await tick();
  const city = dom.body.querySelector('.feedNotice').textContent;
  assert.ok(/city/i.test(city), city);
  assert.notStrictEqual(city, following);

  dom.api.setScope('everyone');
  await tick();
  const everyone = dom.body.querySelector('.feedNotice').textContent;
  assert.notStrictEqual(everyone, city);
});

test('a failed load says so instead of showing an empty feed', async () => {
  const dom = build({ responses: [{ throws: true }] });
  await dom.entry.onEnter();
  await tick();
  const notice = dom.body.querySelector('.feedNoticeError');
  assert.ok(notice, 'a network failure rendered as "no posts yet"');
});

test('a 401 raises the same signal the rest of the app listens for', async () => {
  // Otherwise an expired session leaves this one screen stuck on an error
  // nobody can act on, while the rest of the app still thinks it is signed in.
  const dom = build({ responses: [{ status: 401, body: { detail: 'nope' } }] });
  await dom.entry.onEnter();
  await tick();
  assert.ok(dom.window._fired.includes('tlc:auth-expired'), dom.window._fired.join(','));
});

test('a 402 raises the paywall signal', async () => {
  const dom = build({ responses: [{ status: 402, body: { detail: 'pay' } }] });
  await dom.entry.onEnter();
  await tick();
  assert.ok(dom.window._fired.includes('tlc:payment-required'), dom.window._fired.join(','));
});

test('opening the screen always refetches', async () => {
  // A timeline is the one screen where showing what was true ten minutes ago
  // is a bug.
  const dom = build({ responses: [feedBody([post()]), feedBody([post()])] });
  await dom.entry.onEnter();
  await tick();
  const after = dom.calls.length;
  dom.entry.render(makeNode('div'));
  await dom.entry.onEnter();
  await tick();
  assert.ok(dom.calls.length > after, 'the second open served stale posts');
});

test('two loads at once do not both paint', async () => {
  const dom = build({ responses: [feedBody([post({ id: 1 })])] });
  const a = dom.api.load();
  const b = dom.api.load();
  await Promise.all([a, b]);
  await tick();
  assert.strictEqual(dom.calls.length, 1, 'a second load was fired while one was in flight');
});


// --------------------------------------------------------------------------
// threads
// --------------------------------------------------------------------------

const T = (items, next = null, count = null) => ({ body: { ok: true, post_id: 1,
  items, next_after_id: next, comment_count: count === null ? items.length : count } });

async function withFeed(posts, extra = []) {
  const dom = build({ responses: [feedBody(posts)].concat(extra) });
  await dom.entry.onEnter();
  await tick();
  return dom;
}

test('a post with no replies invites one rather than showing a zero', async () => {
  const dom = await withFeed([post({ id: 1, comment_count: 0 })]);
  assert.strictEqual(dom.body.querySelector('[data-role="replies"]').textContent, 'Reply');
});

test('a post with replies shows how many', async () => {
  const dom = await withFeed([post({ id: 1, comment_count: 47 })]);
  assert.strictEqual(dom.body.querySelector('[data-role="replies"]').textContent, 'Replies 47');
});

test('opening a thread fetches it, closing does not refetch', async () => {
  // Re-fetching every time someone collapses and expands to re-read is a
  // request per glance.
  const dom = await withFeed([post({ id: 1, comment_count: 1 })], [T([comment(5)])]);
  dom.body.querySelector('[data-role="replies"]').click();
  await tick(); await tick();
  const after = dom.calls.length;
  assert.ok(dom.calls[after - 1].url.includes('/social/posts/1/comments'),
    dom.calls[after - 1].url);
  assert.ok(dom.body.textContent.includes('Confirmed, moving here too.'), dom.body.textContent);

  dom.body.querySelector('[data-role="replies"]').click();
  await tick();
  dom.body.querySelector('[data-role="replies"]').click();
  await tick();
  assert.strictEqual(dom.calls.length, after, 'it refetched on reopen');
});

test('a closed thread is hidden, not removed', async () => {
  const dom = await withFeed([post({ id: 1 })], [T([comment(5)])]);
  const host = dom.body.querySelector('[data-role="thread"]');
  assert.strictEqual(host.hidden, true);
  dom.body.querySelector('[data-role="replies"]').click();
  await tick(); await tick();
  assert.strictEqual(host.hidden, false);
});

test('an empty thread says so', async () => {
  const dom = await withFeed([post({ id: 1 })], [T([])]);
  dom.body.querySelector('[data-role="replies"]').click();
  await tick(); await tick();
  assert.ok(/no replies yet/i.test(dom.body.textContent), dom.body.textContent);
});

test('sending a reply appends it and updates the count from the server', async () => {
  const dom = await withFeed([post({ id: 1, comment_count: 0 })], [
    T([]),
    { body: { ok: true, comment: comment(7, { body: 'Mine.', mine: true, can_delete: true }),
      comment_count: 12 } },
  ]);
  dom.body.querySelector('[data-role="replies"]').click();
  await tick(); await tick();
  const input = dom.body.querySelector('[data-role="reply-input"]');
  input.value = 'Mine.';
  input.dispatch('input');
  dom.body.querySelector('[data-role="send-reply"]').click();
  await tick(); await tick();

  assert.ok(dom.body.textContent.includes('Mine.'), dom.body.textContent);
  // 12, not 1: a page is 20 and a thread can be longer, so the server's count
  // is the only one worth trusting.
  assert.strictEqual(dom.api._state.items[0].comment_count, 12);
  assert.strictEqual(dom.body.querySelector('[data-role="replies"]').textContent, 'Replies 12');
});

test('an empty reply is not sent', async () => {
  const dom = await withFeed([post({ id: 1 })], [T([])]);
  dom.body.querySelector('[data-role="replies"]').click();
  await tick(); await tick();
  const before = dom.calls.length;
  const input = dom.body.querySelector('[data-role="reply-input"]');
  input.value = '   ';
  input.dispatch('input');
  dom.body.querySelector('[data-role="send-reply"]').click();
  await tick();
  assert.strictEqual(dom.calls.length, before);
});

test('a failed reply keeps what was typed', async () => {
  // Making someone retype a reply because the network dropped is unforgivable.
  const dom = await withFeed([post({ id: 1 })], [T([]), { throws: true }]);
  dom.body.querySelector('[data-role="replies"]').click();
  await tick(); await tick();
  const input = dom.body.querySelector('[data-role="reply-input"]');
  input.value = 'Worth keeping.';
  input.dispatch('input');
  dom.body.querySelector('[data-role="send-reply"]').click();
  await tick(); await tick();
  assert.strictEqual(dom.api.threadState(1).draft, 'Worth keeping.');
  assert.strictEqual(dom.body.querySelector('[data-role="reply-input"]').value, 'Worth keeping.');
  assert.ok(dom.api.threadState(1).error, 'no reason shown');
});

test('two taps on send post one reply', async () => {
  const dom = await withFeed([post({ id: 1 })], [T([]),
    { body: { ok: true, comment: comment(7), comment_count: 1 } }]);
  dom.body.querySelector('[data-role="replies"]').click();
  await tick(); await tick();
  const input = dom.body.querySelector('[data-role="reply-input"]');
  input.value = 'Once.';
  input.dispatch('input');
  const before = dom.calls.length;
  const card = dom.body.querySelector('[data-post-id]');
  const a = dom.api.sendReply(1, card);
  const b = dom.api.sendReply(1, card);
  await Promise.all([a, b]);
  assert.strictEqual(dom.calls.length, before + 1, 'double-posted');
});

test('delete is offered only where the server said it can be', async () => {
  // can_delete is sent rather than derived, so the client cannot offer a
  // delete that 403s.
  const dom = await withFeed([post({ id: 1 })], [
    T([comment(5, { can_delete: false }), comment(6, { can_delete: true })])]);
  dom.body.querySelector('[data-role="replies"]').click();
  await tick(); await tick();
  assert.strictEqual(dom.body.querySelectorAll('[data-role="delete-comment"]').length, 1);
});

test('deleting a reply removes it and takes the server count', async () => {
  const dom = await withFeed([post({ id: 1, comment_count: 2 })], [
    T([comment(5, { can_delete: true }), comment(6)]),
    { body: { ok: true, post_id: 1, comment_count: 1 } },
  ]);
  dom.body.querySelector('[data-role="replies"]').click();
  await tick(); await tick();
  dom.body.querySelector('[data-role="delete-comment"]').click();
  await tick(); await tick();
  assert.strictEqual(dom.calls[dom.calls.length - 1].opts.method, 'DELETE');
  assert.strictEqual(dom.api.threadState(1).items.length, 1);
  assert.strictEqual(dom.api._state.items[0].comment_count, 1);
});

test('earlier replies page forwards from the cursor', async () => {
  const dom = await withFeed([post({ id: 1 })], [
    T([comment(5)], 5), T([comment(6)], null)]);
  dom.body.querySelector('[data-role="replies"]').click();
  await tick(); await tick();
  dom.body.querySelector('[data-role="more-replies"]').click();
  await tick(); await tick();
  assert.ok(dom.calls[dom.calls.length - 1].url.includes('after_id=5'),
    dom.calls[dom.calls.length - 1].url);
  assert.strictEqual(dom.api.threadState(1).items.length, 2);
});

test('a reply author is a profile target too', async () => {
  const dom = await withFeed([post({ id: 1 })], [T([comment(5)])]);
  dom.body.querySelector('[data-role="replies"]').click();
  await tick(); await tick();
  const name = dom.body.querySelector('.feedCommentName');
  assert.strictEqual(name.getAttribute('data-role'), 'author');
  assert.strictEqual(name.getAttribute('data-user-id'), '9');
});

test('an open thread survives the list being rebuilt', async () => {
  // A refetch replaces every card. Without re-painting open threads, a driver
  // reading replies has them vanish under them when the feed refreshes.
  const dom = await withFeed([post({ id: 1, comment_count: 1 })],
    [T([comment(5)]), feedBody([post({ id: 1, comment_count: 1 })])]);
  dom.body.querySelector('[data-role="replies"]').click();
  await tick(); await tick();
  assert.ok(dom.body.textContent.includes('Confirmed, moving here too.'));

  await dom.api.load();
  await tick();
  assert.strictEqual(dom.api.threadState(1).open, true);
  const host = dom.body.querySelector('[data-role="thread"]');
  assert.strictEqual(host.hidden, false, 'the rebuilt card closed the open thread');
  assert.ok(dom.body.textContent.includes('Confirmed, moving here too.'),
    'the replies vanished when the list refreshed');
});

test('threads for posts no longer on screen are dropped', async () => {
  // Otherwise the map grows for the life of the session.
  const dom = await withFeed([post({ id: 1 })], [T([comment(5)]), feedBody([post({ id: 2 })])]);
  dom.body.querySelector('[data-role="replies"]').click();
  await tick(); await tick();
  assert.ok(dom.api._threads['1'], 'no thread to prune');
  await dom.api.load();
  await tick();
  assert.ok(!dom.api._threads['1'], 'a thread for a post that scrolled away was kept');
});

test('a 402 on a reply says the trial ended rather than "could not post"', async () => {
  const dom = await withFeed([post({ id: 1 })], [T([]), { status: 402, body: {} }]);
  dom.body.querySelector('[data-role="replies"]').click();
  await tick(); await tick();
  const input = dom.body.querySelector('[data-role="reply-input"]');
  input.value = 'x';
  input.dispatch('input');
  dom.body.querySelector('[data-role="send-reply"]').click();
  await tick(); await tick();
  assert.ok(/trial|plan/i.test(dom.api.threadState(1).error), dom.api.threadState(1).error);
});

test('the reply field stops at the server ceiling', async () => {
  const dom = await withFeed([post({ id: 1 })], [T([])]);
  dom.body.querySelector('[data-role="replies"]').click();
  await tick(); await tick();
  assert.strictEqual(
    dom.body.querySelector('[data-role="reply-input"]').getAttribute('maxlength'), '600');
});

test('a thread hides properly despite the flex display', () => {
  assert.ok(CSS.includes('.feedThread[hidden]'),
    'display:flex on a container beats the hidden attribute');
});

test('delete sits away from the name a thumb is aiming for', () => {
  // Deleting a reply by mistake is not undoable.
  assert.ok(/\.feedCommentDelete\s*\{[^}]*margin-left:\s*auto/.test(CSS));
});

// --------------------------------------------------------------------------
// auth and wiring
// --------------------------------------------------------------------------

test('the token comes from the key the auth code writes', async () => {
  const dom = build({ responses: [feedBody([])] });
  await dom.entry.onEnter();
  await tick();
  const headers = dom.calls[0].opts.headers || {};
  assert.strictEqual(headers.Authorization, 'Bearer a-token');
});

test('a signed-out driver sends no Authorization header at all', async () => {
  // An empty bearer is not the same as no bearer; some stacks read it as a
  // malformed token and answer 400 rather than 401.
  const dom = build({ token: '', responses: [feedBody([])] });
  await dom.entry.onEnter();
  await tick();
  const headers = dom.calls[0].opts.headers || {};
  assert.ok(!('Authorization' in headers), JSON.stringify(headers));
});

test('feed.js reimplements no auth of its own', () => {
  const src = fs.readFileSync(JS_SOURCE, 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
  ['/auth/login', '/auth/signup', 'setItem'].forEach((token) => {
    assert.ok(!src.includes(token), `feed.js touches ${token}`);
  });
});

test('both assets are registered in the manifest', () => {
  assert.ok(INDEX.includes('"./feed.css"'), 'css not loaded');
  assert.ok(INDEX.includes('"./feed.js"'), 'js not loaded');
});

test('long content cannot widen the screen', () => {
  // A card is inside a full-screen destination at phone width; one long word
  // in a post body would otherwise scroll the whole page sideways.
  assert.ok(/\.feedBody\s*\{[^}]*overflow-wrap:\s*anywhere/.test(CSS), 'post body');
  assert.ok(/\.feedName\s*\{[^}]*text-overflow:\s*ellipsis/.test(CSS), 'display name');
  assert.ok(/\.feedZoneName\s*\{[^}]*text-overflow:\s*ellipsis/.test(CSS), 'zone name');
  assert.ok(/\.feedImage\s*\{[^}]*max-width:\s*100%/.test(CSS), 'image');
});

test('line breaks a driver typed are kept', () => {
  assert.ok(/white-space:\s*pre-wrap/.test(CSS), 'post bodies collapse newlines');
});

test('the feed has a night palette', () => {
  assert.ok(CSS.includes('body.night .feedCard'),
    'white cards at 3am is the whole reason the app has a night mode');
});

// --------------------------------------------------------------------------

let failed = 0;
(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ok   ${name}`); }
    catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
  }
  console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
