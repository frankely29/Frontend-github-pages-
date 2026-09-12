#!/usr/bin/env node
/**
 * profile.test.js — the Profile destination, against the real shipped file.
 *
 * The failures that matter here:
 *
 *   - the private following count leaking onto someone else's profile,
 *   - a follow button and a follower count that disagree,
 *   - "me" never resolving to a real id, so your own grid asks the server for
 *     /users/null/posts,
 *   - a failed post grid taking the whole profile down with it,
 *   - and a profile nobody can reach from the feed.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'profile.css'), 'utf8');
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const FEED_JS = fs.readFileSync(path.join(ROOT, 'feed.js'), 'utf8');
const JS_SOURCE = path.join(ROOT, 'profile.js');

// Comments here explain what the code deliberately does NOT do, and name the
// very tokens some of these tests assert are absent. Checks for an absent
// identifier have to read the code alone or they match the prose about it.
function codeOf(file) {
  return fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
}

function makeNode(tag) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [], parentNode: null, hidden: false, id: '', type: '', src: '',
    alt: '', loading: '', disabled: false,
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
      ? node._text + node.children.map((c) => c.textContent).join(' ')
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

function profile(over = {}) {
  return Object.assign({
    user_id: 7, display_name: 'Marcus R.', handle: 'marcus_fhv', city: 'New York',
    avatar_url: null, bio: 'Nights out of Queens since 2019.',
    platforms: ['Uber', 'Lyft'], vehicle_type: 'Toyota Sienna',
    driving_since_year: 2019,
    reputation: { level: 24, rank_name: 'Night Owl', title: 'Airport regular',
      badge_code: 'airport', lifetime_miles: 91234, lifetime_hours: 3100,
      trips_logged: 4106 },
    post_count: 312, follower_count: 1847, following_count: null,
    followed_by_me: false, is_me: false,
  }, over);
}

function gridPost(id, over = {}) {
  return Object.assign({
    id, author: { user_id: 7, display_name: 'Marcus R.' },
    body: 'A post', image_url: null, image_thumb_url: null,
    zone_name: 'JFK Airport', zone_rating: 91,
    like_count: 1, liked_by_me: false, mine: false, created_at: 1,
  }, over);
}

function build(options = {}) {
  const registered = [];
  const calls = [];
  const replaced = [];
  const responses = (options.responses || []).slice();
  const titleNode = makeNode('div');
  titleNode.className = 'shellScreenTitle';

  const document = {
    readyState: 'complete',
    createElement: (t) => makeNode(t),
    querySelector: (sel) => (sel === '.shellScreenTitle' ? titleNode : null),
    addEventListener: (t, fn) => { (document._l = document._l || {})[t] = fn; },
  };
  const window = {
    document, console,
    API_BASE: 'https://api.example.com',
    location: { hash: options.hash === undefined ? '' : options.hash },
    history: { replaceState: (_a, _b, url) => { replaced.push(url); window.location.hash = url; } },
    addEventListener: (t, fn) => { (window._l[t] = window._l[t] || []).push(fn); },
    _l: {}, _fired: [], _opened: [],
    TeamJoseoShell: {
      register: (entry) => registered.push(entry),
      open: (key) => window._opened.push(key),
    },
  };
  window.window = window;

  const timers = [];
  const ctx = vm.createContext({
    window, document, console,
    localStorage: { getItem: () => 'a-token' },
    // Fired by hand, so a test states exactly when the debounce elapses.
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: (id) => { if (id) timers[id - 1] = null; },
    CustomEvent: function (type, init) {
      this.type = type; this.detail = init && init.detail;
      window._fired.push({ type, detail: init && init.detail });
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
    Object, Number, Math, Array, String, JSON, Error, encodeURIComponent, Boolean, RegExp,
  });
  vm.runInContext(fs.readFileSync(JS_SOURCE, 'utf8'), ctx, { filename: 'profile.js' });

  const entry = registered[registered.length - 1] || null;
  const body = makeNode('div');
  if (entry && entry.render) entry.render(body);
  const flush = () => { const pending = timers.splice(0); pending.forEach((fn) => fn && fn()); };
  return { window, document, api: window.TeamJoseoProfile, entry, body, calls,
    replaced, titleNode, registered, timers, flush };
}

const P = (p) => ({ body: { ok: true, profile: p } });
const G = (items, next = null) => ({ body: { ok: true, scope: 'everyone', items, next_before_id: next } });
const tick = () => new Promise((r) => setImmediate(r));

const tests = [];
const test = (n, f) => tests.push([n, f]);

// --------------------------------------------------------------------------
// installation and routing
// --------------------------------------------------------------------------

test('it registers over the shell profile entry', () => {
  const dom = build();
  assert.ok(dom.entry);
  assert.strictEqual(dom.entry.key, 'profile');
  // Registering with a `dock` would send the driver back to the old panel.
  assert.ok(!dom.entry.dock, 'still routes to the dock panel');
});

test('no target means your own profile', async () => {
  const dom = build({ responses: [P(profile({ user_id: 3, is_me: true })), G([])] });
  await dom.entry.onEnter();
  await tick(); await tick();
  assert.ok(dom.calls[0].url.endsWith('/social/me/profile'), dom.calls[0].url);
});

test('a target loads that driver', async () => {
  const dom = build({ responses: [P(profile()), G([])] });
  dom.api._state.target = 7;
  await dom.entry.onEnter();
  await tick(); await tick();
  assert.ok(dom.calls[0].url.endsWith('/social/users/7/profile'), dom.calls[0].url);
});

test('"me" is resolved to a real id before the grid is asked for', async () => {
  // Otherwise your own grid requests /social/users/null/posts, which 404s and
  // leaves your profile permanently empty.
  const dom = build({ responses: [P(profile({ user_id: 3, is_me: true })), G([])] });
  await dom.entry.onEnter();
  await tick(); await tick();
  const gridCall = dom.calls[1].url;
  assert.ok(gridCall.includes('/social/users/3/posts'), gridCall);
  assert.ok(!/null|undefined|NaN/.test(gridCall), gridCall);
});

test('the target survives a reload through the hash', async () => {
  const dom = build({ hash: '#/profile?u=42', responses: [P(profile({ user_id: 42 })), G([])] });
  await dom.entry.onEnter();
  await tick(); await tick();
  assert.ok(dom.calls[0].url.endsWith('/social/users/42/profile'), dom.calls[0].url);
});

test('the hash is replaced, not pushed', () => {
  // Pushing would make Android back walk a driver backwards through every
  // profile they looked at instead of leaving the screen.
  const dom = build({ responses: [P(profile()), G([])] });
  dom.api._state.target = 9;
  dom.entry.onEnter();
  assert.ok(dom.replaced.some((u) => u === '#/profile?u=9'), dom.replaced.join(','));
  assert.ok(!/location\.hash\s*=/.test(codeOf(JS_SOURCE)),
    'it assigns location.hash somewhere');
});

test('open() sets the target and asks the shell to show the screen', () => {
  const dom = build();
  dom.api.open('7');
  assert.strictEqual(dom.api._state.target, 7);
  assert.ok(dom.window._opened.includes('profile'));
});

test('open() leaves the target in the hash, after the shell has written its own', () => {
  // openScreen calls onEnter first and writes "#/profile" afterwards, so a
  // hash written during onEnter is stripped on this path every time. The
  // symptom is quiet: a reload swaps whose profile you were looking at.
  const dom = build({ responses: [P(profile()), G([])] });
  // A shell that behaves like the real one: onEnter, then its own hash write.
  dom.window.TeamJoseoShell.open = (key) => {
    dom.window._opened.push(key);
    dom.entry.onEnter();
    dom.window.location.hash = '#/' + key;
  };
  dom.api.open(7);
  assert.strictEqual(dom.window.location.hash, '#/profile?u=7',
    'the shell stripped the target out of the hash');
});

test('leaving clears the target so the next open is your own profile', () => {
  const dom = build();
  dom.api.open(7);
  dom.entry.onLeave();
  assert.strictEqual(dom.api._state.target, null);
});

test('a garbage hash does not become a request for /users/NaN', async () => {
  const dom = build({ hash: '#/profile?u=abc', responses: [P(profile({ is_me: true })), G([])] });
  await dom.entry.onEnter();
  await tick(); await tick();
  assert.ok(dom.calls[0].url.endsWith('/social/me/profile'), dom.calls[0].url);
});

// --------------------------------------------------------------------------
// what the profile shows
// --------------------------------------------------------------------------

test('the head shows counts, name, bio and driver tags', async () => {
  const dom = build({ responses: [P(profile()), G([])] });
  dom.api._state.target = 7;
  await dom.entry.onEnter();
  await tick(); await tick();
  const text = dom.body.textContent;
  ['1,847', 'Followers', '312', 'Posts', 'Marcus R.', 'Nights out of Queens',
    'Uber · Lyft', 'Toyota Sienna', 'TLC since 2019'].forEach((bit) => {
    assert.ok(text.includes(bit), `missing ${bit} in: ${text}`);
  });
});

test('the read view shows the same words the form does', async () => {
  // The server stores keys. A profile reading "uber · lyft" above a form
  // reading "Uber" looks like two different apps.
  const dom = build({ responses: [
    P(profile({ platforms: ['uber', 'black_car'], vehicle_type: 'minivan' })), G([])] });
  dom.api._state.target = 7;
  await dom.entry.onEnter();
  await tick(); await tick();
  const tags = [...dom.body.querySelectorAll('.profileTag')].map((t) => t.textContent);
  assert.ok(tags.includes('Uber · Black car'), tags.join(' | '));
  assert.ok(tags.includes('Minivan'), tags.join(' | '));
});

test('the shell title becomes the handle', async () => {
  const dom = build({ responses: [P(profile()), G([])] });
  dom.api._state.target = 7;
  await dom.entry.onEnter();
  await tick(); await tick();
  assert.strictEqual(dom.titleNode.textContent, '@marcus_fhv');
});

test('a driver with no handle gets their name in the title, not a blank', async () => {
  const dom = build({ responses: [P(profile({ handle: null })), G([])] });
  dom.api._state.target = 7;
  await dom.entry.onEnter();
  await tick(); await tick();
  assert.strictEqual(dom.titleNode.textContent, 'Marcus R.');
});

test('the reputation card shows level, rank and trips', async () => {
  const dom = build({ responses: [P(profile()), G([])] });
  dom.api._state.target = 7;
  await dom.entry.onEnter();
  await tick(); await tick();
  const card = dom.body.querySelector('.profileRep');
  assert.ok(card, 'no reputation card');
  const text = card.textContent;
  assert.ok(text.includes('24'), text);
  assert.ok(text.includes('Night Owl'), text);
  assert.ok(text.includes('4,106'), text);
});

test('a driver with no reputation at all gets no empty card', async () => {
  // An empty "VERIFIED ON JOSEO" frame with three dashes in it is worse than
  // no frame: it advertises that the driver has nothing.
  const dom = build({ responses: [P(profile({ reputation: null })), G([])] });
  dom.api._state.target = 7;
  await dom.entry.onEnter();
  await tick(); await tick();
  assert.strictEqual(dom.body.querySelector('.profileRep'), null);
});

test('a reputation with only a level still renders', async () => {
  const dom = build({ responses: [
    P(profile({ reputation: { level: 3, rank_name: null, trips_logged: null,
      lifetime_miles: null, title: null } })), G([])] });
  dom.api._state.target = 7;
  await dom.entry.onEnter();
  await tick(); await tick();
  const card = dom.body.querySelector('.profileRep');
  assert.ok(card && card.textContent.includes('3'), 'a partial reputation was dropped');
});

test('a level of 0 is not mistaken for no level', async () => {
  const dom = build({ responses: [
    P(profile({ reputation: { level: 0, rank_name: 'Rookie', trips_logged: 0 } })), G([])] });
  dom.api._state.target = 7;
  await dom.entry.onEnter();
  await tick(); await tick();
  assert.ok(dom.body.querySelector('.profileRep'), 'level 0 dropped the whole card');
});

test('counts are grouped for reading', () => {
  const dom = build();
  assert.strictEqual(dom.api.group(1847), '1,847');
  assert.strictEqual(dom.api.group(312), '312');
  assert.strictEqual(dom.api.group(1234567), '1,234,567');
  assert.strictEqual(dom.api.group(0), '0');
  assert.strictEqual(dom.api.group(null), '—');
});

// --------------------------------------------------------------------------
// the private following count
// --------------------------------------------------------------------------

test('the private following line shows only on your own profile', async () => {
  // The server sends following_count only to the owner. If the client ever
  // rendered it unconditionally, a future API change would leak it silently.
  const mine = build({ responses: [
    P(profile({ is_me: true, following_count: 204 })), G([])] });
  await mine.entry.onEnter();
  await tick(); await tick();
  assert.ok(mine.body.querySelector('.profilePrivate'), 'own profile hid it');
  assert.ok(mine.body.textContent.includes('only you can see this'),
    'it does not say that it is private');

  // Someone else's profile, with the field wrongly populated.
  const theirs = build({ responses: [
    P(profile({ is_me: false, following_count: 204 })), G([])] });
  theirs.api._state.target = 7;
  await theirs.entry.onEnter();
  await tick(); await tick();
  assert.strictEqual(theirs.body.querySelector('.profilePrivate'), null,
    'the private count rendered on someone else\'s profile');
});

// --------------------------------------------------------------------------
// follow
// --------------------------------------------------------------------------

test('your own profile has no follow button', async () => {
  const dom = build({ responses: [P(profile({ is_me: true })), G([])] });
  await dom.entry.onEnter();
  await tick(); await tick();
  assert.strictEqual(dom.body.querySelector('[data-role="follow"]'), null);
});

test('following updates the button and the count together', async () => {
  // Two numbers disagreeing for a second is more jarring than either being
  // briefly wrong, so they move together and roll back together.
  const dom = build({ responses: [P(profile()), G([]),
    { body: { ok: true, follower_count: 1850 } }] });
  dom.api._state.target = 7;
  await dom.entry.onEnter();
  await tick(); await tick();
  dom.body.querySelector('[data-role="follow"]').click();
  assert.strictEqual(dom.api._state.profile.followed_by_me, true);
  assert.strictEqual(dom.api._state.profile.follower_count, 1848);
  await tick(); await tick();
  assert.strictEqual(dom.api._state.profile.follower_count, 1850, 'server count ignored');
  assert.ok(dom.body.textContent.includes('Following'), dom.body.textContent);
});

test('a failed follow rolls back both', async () => {
  const dom = build({ responses: [P(profile()), G([]), { throws: true }] });
  dom.api._state.target = 7;
  await dom.entry.onEnter();
  await tick(); await tick();
  dom.body.querySelector('[data-role="follow"]').click();
  await tick(); await tick();
  assert.strictEqual(dom.api._state.profile.followed_by_me, false);
  assert.strictEqual(dom.api._state.profile.follower_count, 1847);
});

test('unfollowing sends DELETE', async () => {
  const dom = build({ responses: [P(profile({ followed_by_me: true })), G([]),
    { body: { ok: true, follower_count: 1846 } }] });
  dom.api._state.target = 7;
  await dom.entry.onEnter();
  await tick(); await tick();
  dom.body.querySelector('[data-role="follow"]').click();
  await tick(); await tick();
  assert.strictEqual(dom.calls[2].opts.method, 'DELETE');
});

test('two taps on follow send one request', async () => {
  const dom = build({ responses: [P(profile()), G([]),
    { body: { ok: true, follower_count: 1848 } }] });
  dom.api._state.target = 7;
  await dom.entry.onEnter();
  await tick(); await tick();
  const before = dom.calls.length;
  const a = dom.api.toggleFollow();
  const b = dom.api.toggleFollow();
  await Promise.all([a, b]);
  assert.strictEqual(dom.calls.length, before + 1, 'double-followed');
});

test('a follower count never goes negative', async () => {
  const dom = build({ responses: [P(profile({ followed_by_me: true, follower_count: 0 })),
    G([]), { body: { ok: true, follower_count: 0 } }] });
  dom.api._state.target = 7;
  await dom.entry.onEnter();
  await tick(); await tick();
  dom.api.toggleFollow();
  assert.ok(dom.api._state.profile.follower_count >= 0);
});

// --------------------------------------------------------------------------
// the post grid
// --------------------------------------------------------------------------

test('posts render as tiles with their zone chip', async () => {
  const dom = build({ responses: [P(profile()),
    G([gridPost(1, { image_thumb_url: '/social/posts/1/image/thumb' }), gridPost(2)])] });
  dom.api._state.target = 7;
  await dom.entry.onEnter();
  await tick(); await tick();
  assert.strictEqual(dom.body.querySelectorAll('.profileTile').length, 2);
  assert.strictEqual(dom.body.querySelector('.profileTileImg').src,
    'https://api.example.com/social/posts/1/image/thumb');
  assert.ok(dom.body.querySelector('.profileTileChip').textContent.includes('JFK Airport'));
});

test('a text post gets its words rather than an empty square', async () => {
  // A grid of blank squares reads as broken images.
  const dom = build({ responses: [P(profile()),
    G([gridPost(1, { body: 'Marine Park is dead.' })])] });
  dom.api._state.target = 7;
  await dom.entry.onEnter();
  await tick(); await tick();
  const tile = dom.body.querySelector('.profileTileText');
  assert.ok(tile, 'no text tile');
  assert.ok(tile.textContent.includes('Marine Park'), tile.textContent);
});

test('a failed grid does not take the profile down with it', async () => {
  // The person and their credentials are the point; the photos are extra.
  const dom = build({ responses: [P(profile()), { throws: true }] });
  dom.api._state.target = 7;
  await dom.entry.onEnter();
  await tick(); await tick();
  assert.ok(dom.body.textContent.includes('Marcus R.'), 'the profile vanished too');
  assert.ok(dom.body.textContent.includes('could not be loaded'), dom.body.textContent);
});

test('a failed profile does not pretend to have a grid', async () => {
  const dom = build({ responses: [{ status: 404, body: {} }] });
  dom.api._state.target = 99;
  await dom.entry.onEnter();
  await tick(); await tick();
  assert.ok(dom.body.querySelector('.profileNoticeError'));
  assert.ok(dom.body.textContent.includes('not here'), dom.body.textContent);
  assert.strictEqual(dom.calls.length, 1, 'it asked for posts anyway');
});

test('load more pages from the cursor and appends', async () => {
  const dom = build({ responses: [P(profile()), G([gridPost(9)], 9), G([gridPost(8)], null)] });
  dom.api._state.target = 7;
  await dom.entry.onEnter();
  await tick(); await tick();
  dom.body.querySelector('[data-role="more"]').click();
  await tick(); await tick();
  assert.ok(dom.calls[2].url.includes('before_id=9'), dom.calls[2].url);
  assert.strictEqual(dom.api._state.posts.length, 2);
});

test('an empty grid says something different on your own profile', async () => {
  const mine = build({ responses: [P(profile({ is_me: true })), G([])] });
  await mine.entry.onEnter();
  await tick(); await tick();
  assert.ok(/you have not posted/i.test(mine.body.textContent), mine.body.textContent);
});

test('a 401 raises the signal the rest of the app listens for', async () => {
  const dom = build({ responses: [{ status: 401, body: {} }] });
  await dom.entry.onEnter();
  await tick(); await tick();
  assert.ok(dom.window._fired.some((e) => e.type === 'tlc:auth-expired'));
});

// --------------------------------------------------------------------------
// reachable from the feed
// --------------------------------------------------------------------------

test('the feed marks its author block as a profile target', () => {
  // A network whose people are not reachable from their words is a list of
  // announcements.
  assert.ok(FEED_JS.includes('data-role", "author"'), 'the feed author is not tappable');
  assert.ok(FEED_JS.includes('data-user-id'), 'the feed carries no user id to open');
  assert.ok(FEED_JS.includes('TeamJoseoProfile'), 'the feed never opens a profile');
});

test('the feed survives profile.js being absent', () => {
  // Deleting profile.js must cost a tap target, not the feed.
  assert.ok(/typeof window\.TeamJoseoProfile\.open === "function"/.test(FEED_JS),
    'the feed calls into profile.js without checking it is there');
});

test('a tappable author is reachable by keyboard', () => {
  assert.ok(FEED_JS.includes('"tabindex", "0"'), 'the author block is mouse-only');
  assert.ok(RULES.includes('[data-role="author"]:focus-visible'), 'no focus ring');
});


// --------------------------------------------------------------------------
// editing your own profile
// --------------------------------------------------------------------------

const OPTIONS = { body: { ok: true, platforms: ['uber', 'lyft', 'via'],
  vehicle_types: ['sedan', 'minivan', 'ev'] } };

async function opened(over = {}, extra = []) {
  const dom = build({ responses: [P(profile(Object.assign({ is_me: true }, over))),
    G([]), OPTIONS].concat(extra) });
  await dom.entry.onEnter();
  await tick(); await tick();
  dom.body.querySelector('[data-role="edit"]').click();
  await tick(); await tick();
  return dom;
}

test('only your own profile offers an edit button', async () => {
  const mine = build({ responses: [P(profile({ is_me: true })), G([])] });
  await mine.entry.onEnter();
  await tick(); await tick();
  assert.ok(mine.body.querySelector('[data-role="edit"]'), 'no edit button on your own profile');

  const theirs = build({ responses: [P(profile({ is_me: false })), G([])] });
  theirs.api._state.target = 7;
  await theirs.entry.onEnter();
  await tick(); await tick();
  assert.strictEqual(theirs.body.querySelector('[data-role="edit"]'), null,
    'an edit button appeared on someone else\'s profile');
});

test('the form opens with what the profile already says', async () => {
  const dom = await opened();
  const d = dom.api._state.draft;
  assert.strictEqual(d.handle, 'marcus_fhv');
  assert.strictEqual(d.bio, 'Nights out of Queens since 2019.');
  assert.strictEqual(d.platforms.join(','), 'Uber,Lyft');
  assert.strictEqual(d.vehicle_type, 'Toyota Sienna');
  assert.strictEqual(d.driving_since_year, '2019');
});

test('the draft is a copy, so cancel really cancels', async () => {
  // Editing the live profile object would leave Cancel with nothing to restore.
  const dom = await opened();
  dom.api._state.draft.bio = 'Something else entirely';
  dom.api._state.draft.platforms.push('via');
  dom.api.cancelEdit();
  assert.strictEqual(dom.api._state.profile.bio, 'Nights out of Queens since 2019.');
  assert.strictEqual(dom.api._state.profile.platforms.join(','), 'Uber,Lyft');
  assert.strictEqual(dom.api._state.draft, null);
});

test('the closed sets come from the server, not from this file', async () => {
  const dom = await opened();
  const src = codeOf(JS_SOURCE);
  assert.ok(src.includes('/social/identity/options'), 'the options endpoint is not called');
  assert.ok(!src.includes('black_car'), 'the platform list is hard-coded here');
  assert.ok(dom.calls.some((c) => c.url.includes('/social/identity/options')));
});

test('a platform the driver already has is still offered when the list shrinks', async () => {
  // Otherwise a list that lost an entry silently drops their answer on the
  // next save.
  const dom = await opened({ platforms: ['gone_from_list'] });
  const names = [...dom.body.querySelectorAll('[data-platform]')]
    .map((c) => c.getAttribute('data-platform'));
  assert.ok(names.includes('gone_from_list'), names.join(','));
});

test('only changed fields are sent, because the route is a patch', async () => {
  // An omitted field is left alone; an explicit null CLEARS it. Sending the
  // whole draft would let a bio edit wipe a vehicle.
  const dom = await opened();
  dom.api._state.draft.bio = 'New bio.';
  const diff = dom.api.identityDiff();
  assert.deepStrictEqual(Object.keys(diff), ['bio']);
  assert.strictEqual(diff.bio, 'New bio.');
});

test('nothing changed means nothing is sent at all', async () => {
  const dom = await opened();
  assert.strictEqual(Object.keys(dom.api.identityDiff()).length, 0);
  const before = dom.calls.length;
  await dom.api.save();
  assert.strictEqual(dom.calls.length, before, 'an empty save still hit the server');
  assert.strictEqual(dom.api._state.editing, false);
});

test('clearing a field sends null rather than an empty string', async () => {
  // null is how the server is told to clear; "" would be stored as a bio of
  // nothing rather than no bio.
  const dom = await opened();
  dom.api._state.draft.bio = '   ';
  dom.api._state.draft.vehicle_type = '';
  const diff = dom.api.identityDiff();
  assert.strictEqual(diff.bio, null);
  assert.strictEqual(diff.vehicle_type, null);
});

test('the handle goes to its own endpoint, and only when it changed', async () => {
  const dom = await opened({}, [P(profile({ is_me: true, handle: 'newname' }))]);
  dom.api._state.draft.handle = 'newname';
  await dom.api.save();
  await tick();
  const handleCall = dom.calls.filter((c) => c.url.endsWith('/social/me/handle'))[0];
  assert.ok(handleCall, 'the handle was never saved');
  assert.strictEqual(JSON.parse(handleCall.opts.body).handle, 'newname');
});

test('re-typing your own handle in a different case is not a change', async () => {
  const dom = await opened();
  dom.api._state.draft.handle = 'MARCUS_FHV';
  await dom.api.save();
  await tick();
  assert.ok(!dom.calls.some((c) => c.url.endsWith('/social/me/handle')),
    'it tried to claim the handle the driver already owns');
});

test('a taken handle names itself rather than saying "could not save"', async () => {
  const dom = await opened({}, [{ status: 409, body: {} }]);
  dom.api._state.draft.handle = 'taken';
  await dom.api.save();
  await tick();
  assert.ok(/taken/i.test(dom.api._state.saveError), dom.api._state.saveError);
});

test('a failed save keeps the form open with the draft intact', async () => {
  // Closing it would throw away what someone typed and leave them guessing
  // which part landed.
  const dom = await opened({}, [{ throws: true }]);
  dom.api._state.draft.bio = 'Worth keeping.';
  await dom.api.save();
  await tick();
  assert.strictEqual(dom.api._state.editing, true);
  assert.strictEqual(dom.api._state.draft.bio, 'Worth keeping.');
  assert.ok(dom.api._state.saveError, 'no reason shown');
});

test('a partial failure says which part failed', async () => {
  const dom = await opened({}, [
    P(profile({ is_me: true, handle: 'newname' })),  // handle ok
    { throws: true },                                 // identity failed
  ]);
  dom.api._state.draft.handle = 'newname';
  dom.api._state.draft.bio = 'Changed too.';
  await dom.api.save();
  await tick();
  assert.ok(/details/i.test(dom.api._state.saveError), dom.api._state.saveError);
  assert.ok(!/handle/i.test(dom.api._state.saveError),
    'it blamed the handle, which saved fine');
});

test('two taps on save send one round of requests', async () => {
  const dom = await opened({}, [P(profile({ is_me: true }))]);
  dom.api._state.draft.bio = 'Once.';
  const before = dom.calls.length;
  const a = dom.api.save();
  const b = dom.api.save();
  await Promise.all([a, b]);
  assert.strictEqual(dom.calls.length, before + 1, 'double-saved');
});

// --------------------------------------------------------------------------
// the live handle check
// --------------------------------------------------------------------------

test('typing a new handle checks it, once, after a pause', async () => {
  const dom = await opened({}, [{ body: { ok: true, handle: 'newname', available: true } }]);
  dom.api._state.draft.handle = 'n';
  dom.api.checkHandle();
  dom.api._state.draft.handle = 'ne';
  dom.api.checkHandle();
  dom.api._state.draft.handle = 'newname';
  dom.api.checkHandle();
  const before = dom.calls.length;
  dom.flush();
  await tick(); await tick();
  assert.strictEqual(dom.calls.length, before + 1, 'every keystroke hit the server');
  assert.strictEqual(dom.api._state.handleState.available, true);
});

test('your own handle is never reported as taken', async () => {
  const dom = await opened();
  dom.api._state.draft.handle = 'marcus_fhv';
  dom.api.checkHandle();
  assert.strictEqual(dom.api._state.handleState, null);
  assert.strictEqual(dom.timers.filter(Boolean).length, 0, 'it asked anyway');
});

test('a stale check does not overwrite the handle being typed now', async () => {
  const dom = await opened({}, [{ body: { ok: true, handle: 'aaa', available: false,
    reason: 'That handle is taken' } }]);
  dom.api._state.draft.handle = 'aaa';
  dom.api.checkHandle();
  dom.api._state.draft.handle = 'bbb';   // moved on while in flight
  dom.flush();
  await tick(); await tick();
  assert.notStrictEqual(dom.api._state.handleState && dom.api._state.handleState.reason,
    'That handle is taken');
});

test('a handle known to be taken blocks save', async () => {
  const dom = await opened({}, [{ body: { ok: true, handle: 'taken', available: false,
    reason: 'That handle is taken' } }]);
  dom.api._state.draft.handle = 'taken';
  dom.api.checkHandle();
  dom.flush();
  await tick(); await tick();
  assert.strictEqual(dom.api._nodes.saveBtn.disabled, true);
});

test('a check that could not run does not block save', async () => {
  // The server is the real authority. A failed availability check must not
  // lock someone out of saving their bio.
  const dom = await opened({}, [{ throws: true }]);
  dom.api._state.draft.handle = 'unknown';
  dom.api.checkHandle();
  dom.flush();
  await tick(); await tick();
  assert.strictEqual(dom.api._nodes.saveBtn.disabled, false);
});

test('leaving the screen closes the form and cancels a pending check', async () => {
  const dom = await opened();
  dom.api._state.draft.handle = 'halfway';
  dom.api.checkHandle();
  dom.entry.onLeave();
  assert.strictEqual(dom.api._state.editing, false);
  assert.strictEqual(dom.api._state.draft, null);
  assert.strictEqual(dom.timers.filter(Boolean).length, 0, 'a check was left pending');
});

test('the grid is out of the way while the form is open', async () => {
  const dom = build({ responses: [P(profile({ is_me: true })),
    G([gridPost(1)]), OPTIONS] });
  await dom.entry.onEnter();
  await tick(); await tick();
  assert.ok(dom.body.querySelector('.profileTile'), 'no tiles to begin with');
  dom.body.querySelector('[data-role="edit"]').click();
  await tick(); await tick();
  assert.strictEqual(dom.body.querySelector('.profileTile'), null,
    'a photo grid under an open form is something to scroll past to reach Save');
});

test('stored keys are shown as words', async () => {
  const dom = build();
  assert.strictEqual(dom.api.prettyChoice('black_car'), 'Black car');
  assert.strictEqual(dom.api.prettyChoice('uber'), 'Uber');
  // "suv" and "ev" are real VEHICLE_CHOICES; "Suv" and "Ev" read as typos.
  assert.strictEqual(dom.api.prettyChoice('suv'), 'SUV');
  assert.strictEqual(dom.api.prettyChoice('ev'), 'EV');
  assert.strictEqual(dom.api.prettyChoice(''), '');
});

test('toggling a platform does not rebuild the inputs', async () => {
  // A full repaint would throw away the caret, and half of what someone was
  // typing with it.
  const dom = await opened();
  const bioBefore = dom.body.querySelector('.profileTextarea');
  dom.body.querySelector('[data-platform="via"]').click();
  assert.strictEqual(dom.api._state.draft.platforms.indexOf('via') >= 0, true);
  assert.strictEqual(dom.body.querySelector('.profileTextarea'), bioBefore,
    'the form was rebuilt on a chip tap');
});

test('the bio field stops at the server ceiling', async () => {
  const dom = await opened();
  const bio = dom.body.querySelector('.profileTextarea');
  assert.strictEqual(bio.getAttribute('maxlength'), '200');
});

test('a disabled save button looks disabled', () => {
  assert.ok(/\.profileSave:disabled\s*\{/.test(RULES), 'no disabled style');
});

// --------------------------------------------------------------------------
// layout
// --------------------------------------------------------------------------

test('no stylesheet uses the invalid font shorthand', () => {
  // `font: 700 14px/1 inherit` is invalid and dropped whole. It shipped twice
  // before, so every stylesheet is checked on every new one.
  ['profile.css', 'compose.css', 'feed.css', 'map-action.css', 'landing.css', 'app-shell.css']
    .forEach((name) => {
      const text = fs.readFileSync(path.join(ROOT, name), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      const found = text.match(/font:[^;}]*\binherit\b[^;}]*;/g) || [];
      const broken = found.filter((d) => !/^font:\s*inherit\s*;$/.test(d.trim()));
      assert.strictEqual(broken.length, 0, `${name}: ${broken.join(' ')}`);
    });
});

test('the grid cannot widen the screen', () => {
  assert.ok(/grid-template-columns:\s*repeat\(3,\s*1fr\)/.test(RULES), 'three columns');
  assert.ok(/\.profileTile\s*\{[^}]*max-width:\s*100%/.test(RULES),
    'an aspect-ratio tile with no max-width can overflow');
});

test('long text cannot widen the screen', () => {
  assert.ok(/\.profileBio\s*\{[^}]*overflow-wrap:\s*anywhere/.test(RULES), 'bio');
  assert.ok(/\.profileTag\s*\{[^}]*overflow-wrap:\s*anywhere/.test(RULES), 'tags');
  assert.ok(/\.profileTileZone\s*\{[^}]*text-overflow:\s*ellipsis/.test(RULES), 'zone chip');
});

test('both assets are registered in the manifest', () => {
  assert.ok(INDEX.includes('"./profile.css"'), 'css not loaded');
  assert.ok(INDEX.includes('"./profile.js"'), 'js not loaded');
});

test('profile has a night palette', () => {
  assert.ok(CSS.includes('body.night .profileScreen'), 'no night mode');
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
