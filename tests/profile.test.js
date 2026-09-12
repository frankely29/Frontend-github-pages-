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

  const ctx = vm.createContext({
    window, document, console,
    localStorage: { getItem: () => 'a-token' },
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
  return { window, document, api: window.TeamJoseoProfile, entry, body, calls,
    replaced, titleNode, registered };
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
  const src = fs.readFileSync(JS_SOURCE, 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
  assert.ok(!/location\.hash\s*=/.test(src), 'it assigns location.hash somewhere');
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
