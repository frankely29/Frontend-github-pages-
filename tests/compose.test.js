#!/usr/bin/env node
/**
 * compose.test.js — the Post destination, driven against the real shipped file.
 *
 * The failures worth catching here are the ones that cost a driver their post
 * or mislabel it:
 *
 *   - tagging a post with the zone the app told them to DRIVE TO rather than
 *     the one they are standing in,
 *   - setting Content-Type on a multipart upload, which kills the boundary and
 *     makes the server reject a photo that was fine,
 *   - a Post button that is live with nothing to post, so the driver gets a
 *     400 instead of a disabled button,
 *   - leaking an object URL per photo previewed,
 *   - and a zone tag that shows a different number from the map.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'compose.css'), 'utf8');
// Comments explain what the rules deliberately do NOT do, so a check for an
// absent declaration has to look at the rules alone or it matches the prose.
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const JS_SOURCE = path.join(ROOT, 'compose.js');

function makeNode(tag) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [], parentNode: null, hidden: false, id: '', type: '', src: '',
    alt: '', accept: '', value: '', disabled: false, files: null,
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
  node.setAttribute = (k, v) => { node._attrs[k] = String(v); };
  node.getAttribute = (k) => (k in node._attrs ? node._attrs[k] : null);
  node.removeAttribute = (k) => { delete node._attrs[k]; };
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

// A zone feature shaped the way the map's source produces them.
const ZONE = {
  properties: { zone_name: 'JFK Airport', rating: 55 },
  geometry: { type: 'Polygon', coordinates: [] },
};

function build(options = {}) {
  const registered = [];
  const calls = [];
  const revoked = [];
  const created = [];
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
    URL: {
      createObjectURL: (f) => { created.push(f); return 'blob:' + created.length; },
      revokeObjectURL: (u) => revoked.push(u),
    },
    TeamJoseoShell: { register: (entry) => registered.push(entry) },
    TlcMapUiInternals: options.noInternals ? undefined : {
      getUserLatLng: () => (options.at === undefined ? { lat: 40.64, lng: -73.78 } : options.at),
      resolveZoneFeatureAtLngLat: () => (options.zone === undefined ? ZONE : options.zone),
      // The VISIBLE rating, which special modes change. 91 here while the raw
      // property says 55, so a test can tell which one was used.
      effectiveRating: () => (options.effective === undefined ? 91 : options.effective),
    },
  };
  window.window = window;

  class FakeFormData {
    constructor() { this.entries = []; }
    append(k, v) { this.entries.push([k, v]); }
    get(k) { const hit = this.entries.filter((e) => e[0] === k)[0]; return hit ? hit[1] : null; }
  }

  const ctx = vm.createContext({
    window, document, console,
    localStorage: { getItem: () => (options.token === undefined ? 'a-token' : options.token) },
    FormData: FakeFormData,
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
        text: async () => JSON.stringify(next.body === undefined ? { ok: true, post: { id: 1 } } : next.body),
      };
    },
    Object, Number, Math, Array, String, JSON, Error, encodeURIComponent, Boolean,
  });
  vm.runInContext(fs.readFileSync(JS_SOURCE, 'utf8'), ctx, { filename: 'compose.js' });

  const entry = registered[registered.length - 1] || null;
  const body = makeNode('div');
  if (entry && entry.render) entry.render(body);
  return { window, document, api: window.TeamJoseoCompose, entry, body, calls,
    revoked, created, registered, FakeFormData };
}

const fakeFile = (over = {}) => Object.assign({ name: 'shot.jpg', type: 'image/jpeg', size: 1024 }, over);
const tick = () => new Promise((r) => setImmediate(r));
const typeBody = (dom, text) => {
  dom.api._nodes.body.value = text;
  dom.api._nodes.body.dispatch('input');
};

const tests = [];
const test = (n, f) => tests.push([n, f]);

// --------------------------------------------------------------------------
// installation and modes
// --------------------------------------------------------------------------

test('it registers over the shell post placeholder', () => {
  const dom = build();
  assert.ok(dom.entry, 'nothing registered');
  assert.strictEqual(dom.entry.key, 'post');
});

test('there is no Voice tab, because there is no audio endpoint', () => {
  // A tab that opens a recorder and then cannot post it takes someone's time
  // and their words and drops both.
  const dom = build();
  assert.strictEqual(dom.api.modes.map((m) => m.key).join(','), 'photo,text');
  assert.ok(!dom.body.textContent.includes('Voice'), dom.body.textContent);
});

test('switching to Text keeps a photo already picked', () => {
  // Tapping the wrong tab must not throw away what someone chose.
  const dom = build();
  dom.api.takeFile(fakeFile());
  dom.body.querySelectorAll('[data-mode]')[1].click();
  assert.strictEqual(dom.api._state.mode, 'text');
  assert.ok(dom.api._state.file, 'the photo was discarded by a tab change');
});

test('app-shell.js is not edited to know about compose', () => {
  const shell = fs.readFileSync(path.join(ROOT, 'app-shell.js'), 'utf8');
  assert.ok(!shell.includes('TeamJoseoCompose'), 'the shell reaches into compose');
});

// --------------------------------------------------------------------------
// the zone tag
// --------------------------------------------------------------------------

test('the zone comes from where the driver is, not where they were told to go', () => {
  // This is the one that matters. TlcAssistantRecommendation names the zone to
  // DRIVE TO; tagging with it would tell everyone "I am at JFK" while the
  // driver sits in Astoria being told to drive to JFK.
  const src = fs.readFileSync(JS_SOURCE, 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
  assert.ok(!src.includes('TlcAssistantRecommendation'),
    'compose reads the recommendation — it must read the map resolver instead');
  assert.ok(src.includes('resolveZoneFeatureAtLngLat'), 'it does not use the map resolver');
});

test('the tag shows the visible rating, the one on the map', () => {
  // Special modes (Queens, Brooklyn, night) change the visible score. Posting
  // props.rating would tag a number the map is not showing.
  const dom = build();
  const zone = dom.api.readZone();
  assert.strictEqual(zone.rating, 91, 'used the raw property instead of the visible rating');
  assert.strictEqual(zone.name, 'JFK Airport');
});

test('no location means no tag rather than a guessed one', () => {
  const dom = build({ at: null });
  assert.strictEqual(dom.api.readZone(), null);
});

test('a location outside every zone still carries the coordinates', () => {
  const dom = build({ zone: null });
  const zone = dom.api.readZone();
  assert.strictEqual(zone.name, '');
  assert.strictEqual(zone.lat, 40.64);
});

test('no map internals at all does not throw', () => {
  const dom = build({ noInternals: true });
  assert.strictEqual(dom.api.readZone(), null);
});

test('the zone tag can be turned off, and then is not sent', async () => {
  const dom = build({ responses: [{}] });
  await dom.entry.onEnter();
  typeBody(dom, 'Marine Park is dead.');
  assert.ok(dom.api.fields().zone_name, 'tagged by default');
  dom.body.querySelector('[data-role="toggle-zone"]').click();
  const sent = dom.api.fields();
  assert.ok(!('zone_name' in sent), 'zone was still sent after untagging');
  assert.ok(!('lat' in sent), 'coordinates were still sent after untagging');
});

test('a rating of 0 is still tagged', () => {
  const dom = build({ effective: 0 });
  const dom2 = build({ effective: 0 });
  dom2.entry.onEnter();
  dom2.api._state.body = 'x';
  assert.strictEqual(dom2.api.fields().zone_rating, 0);
  assert.strictEqual(dom.api.readZone().rating, 0);
});

// --------------------------------------------------------------------------
// what can be posted
// --------------------------------------------------------------------------

test('an empty form cannot be posted', () => {
  // The server requires text or a photo. A live button here means a 400
  // instead of a disabled button.
  const dom = build();
  assert.strictEqual(dom.api.canPost(), false);
  assert.strictEqual(dom.api._nodes.submit.disabled, true);
});

test('whitespace alone is not a post', () => {
  const dom = build();
  typeBody(dom, '    \n  ');
  assert.strictEqual(dom.api.canPost(), false);
});

test('text alone can be posted', () => {
  const dom = build();
  typeBody(dom, 'Lot is moving.');
  assert.strictEqual(dom.api.canPost(), true);
  assert.strictEqual(dom.api._nodes.submit.disabled, false);
});

test('a photo with no caption can be posted', () => {
  const dom = build();
  dom.api.takeFile(fakeFile());
  assert.strictEqual(dom.api.canPost(), true);
});

test('a non-image file is refused before any upload', () => {
  const dom = build();
  dom.api.takeFile(fakeFile({ type: 'application/pdf' }));
  assert.strictEqual(dom.api._state.file, null);
  assert.ok(/not an image/i.test(dom.api._state.error), dom.api._state.error);
});

test('an oversized photo is refused before the upload, not after it', () => {
  // Telling someone on a parking-lot connection after a 20MB upload is the
  // worst possible moment to tell them.
  const dom = build();
  dom.api.takeFile(fakeFile({ size: 20 * 1024 * 1024 }));
  assert.strictEqual(dom.api._state.file, null);
  assert.ok(/8MB/.test(dom.api._state.error), dom.api._state.error);
});

// --------------------------------------------------------------------------
// posting
// --------------------------------------------------------------------------

test('text posts as JSON to the text route', async () => {
  const dom = build({ responses: [{}] });
  await dom.entry.onEnter();
  typeBody(dom, 'Lot is moving.');
  await dom.api.submit();
  const call = dom.calls[0];
  assert.ok(call.url.endsWith('/social/posts'), call.url);
  assert.strictEqual(call.opts.headers['Content-Type'], 'application/json');
  const sent = JSON.parse(call.opts.body);
  assert.strictEqual(sent.body, 'Lot is moving.');
  assert.strictEqual(sent.zone_name, 'JFK Airport');
  assert.strictEqual(sent.zone_rating, 91);
});

test('a photo posts multipart to the photo route', async () => {
  const dom = build({ responses: [{}] });
  await dom.entry.onEnter();
  dom.api.takeFile(fakeFile());
  typeBody(dom, 'T4 holding lot.');
  await dom.api.submit();
  const call = dom.calls[0];
  assert.ok(call.url.endsWith('/social/posts/photo'), call.url);
  assert.strictEqual(call.opts.body.get('file').name, 'shot.jpg');
  assert.strictEqual(call.opts.body.get('body'), 'T4 holding lot.');
  assert.strictEqual(call.opts.body.get('zone_name'), 'JFK Airport');
});

test('a multipart upload never sets Content-Type itself', async () => {
  // The browser has to set the multipart boundary. Setting the header by hand
  // produces a body the server cannot parse, and the photo fails for no
  // visible reason.
  const dom = build({ responses: [{}] });
  await dom.entry.onEnter();
  dom.api.takeFile(fakeFile());
  await dom.api.submit();
  const headers = dom.calls[0].opts.headers || {};
  assert.ok(!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type'),
    'Content-Type was set on a multipart body: ' + JSON.stringify(headers));
});

test('in Text mode a picked photo is not uploaded', async () => {
  // The photo is kept across a tab switch, but Text means text. Uploading it
  // anyway would post something the driver did not choose to post.
  const dom = build({ responses: [{}] });
  await dom.entry.onEnter();
  dom.api.takeFile(fakeFile());
  dom.body.querySelectorAll('[data-mode]')[1].click();
  typeBody(dom, 'Just words.');
  await dom.api.submit();
  assert.ok(dom.calls[0].url.endsWith('/social/posts'), dom.calls[0].url);
});

test('a successful post clears the form and announces itself', async () => {
  const dom = build({ responses: [{ body: { ok: true, post: { id: 42 } } }] });
  await dom.entry.onEnter();
  typeBody(dom, 'Posted text.');
  await dom.api.submit();
  assert.strictEqual(dom.api._state.body, '');
  assert.strictEqual(dom.api._nodes.body.value, '');
  assert.strictEqual(dom.api._state.file, null);
  const announced = dom.window._fired.filter((e) => e.type === 'tlc:post-created')[0];
  assert.ok(announced, 'nothing announced the new post');
  assert.strictEqual(announced.detail.post.id, 42);
});

test('a failed post keeps the draft', async () => {
  // Losing someone's words because the network dropped is unforgivable; they
  // have to retype what they already said.
  const dom = build({ responses: [{ throws: true }] });
  await dom.entry.onEnter();
  typeBody(dom, 'Words worth keeping.');
  await dom.api.submit();
  assert.strictEqual(dom.api._state.body, 'Words worth keeping.');
  assert.ok(dom.api._state.error, 'no error shown');
});

test('a failed photo post keeps the photo too', async () => {
  const dom = build({ responses: [{ throws: true }] });
  await dom.entry.onEnter();
  dom.api.takeFile(fakeFile());
  await dom.api.submit();
  assert.ok(dom.api._state.file, 'the photo was dropped on a failed upload');
});

test('two taps on Post send one post', async () => {
  const dom = build({ responses: [{}] });
  await dom.entry.onEnter();
  typeBody(dom, 'Once.');
  const a = dom.api.submit();
  const b = dom.api.submit();
  await Promise.all([a, b]);
  assert.strictEqual(dom.calls.length, 1, 'double-posted');
});

test('each failure says something a driver can act on', () => {
  const dom = build();
  const cases = [[401, /sign in/i], [402, /trial|plan/i], [413, /large/i],
    [415, /image/i], [429, /slow/i]];
  cases.forEach(([status, pattern]) => {
    const message = dom.api.describe({ status });
    assert.ok(pattern.test(message), `${status} -> ${message}`);
  });
  assert.ok(/connection/i.test(dom.api.describe({})), 'no generic fallback');
});

test('a 401 and a 402 raise the signals the rest of the app listens for', async () => {
  const a = build({ responses: [{ status: 401, body: {} }] });
  await a.entry.onEnter();
  a.api._state.body = 'x';
  await a.api.submit();
  assert.ok(a.window._fired.some((e) => e.type === 'tlc:auth-expired'));

  const b = build({ responses: [{ status: 402, body: {} }] });
  await b.entry.onEnter();
  b.api._state.body = 'x';
  await b.api.submit();
  assert.ok(b.window._fired.some((e) => e.type === 'tlc:payment-required'));
});

test('a signed-out driver sends no Authorization header at all', async () => {
  const dom = build({ token: '', responses: [{}] });
  await dom.entry.onEnter();
  typeBody(dom, 'x');
  await dom.api.submit();
  const headers = dom.calls[0].opts.headers || {};
  assert.ok(!('Authorization' in headers), JSON.stringify(headers));
});

// --------------------------------------------------------------------------
// object URLs
// --------------------------------------------------------------------------

test('previewing a second photo revokes the first url', () => {
  // Object URLs are not garbage collected. Flipping through ten photos leaks
  // ten of them.
  const dom = build();
  dom.api.takeFile(fakeFile({ name: 'a.jpg' }));
  const first = dom.api._state.previewUrl;
  dom.api.takeFile(fakeFile({ name: 'b.jpg' }));
  assert.ok(dom.revoked.includes(first), `never revoked ${first}`);
  assert.notStrictEqual(dom.api._state.previewUrl, first);
});

test('leaving the screen revokes the preview url', () => {
  const dom = build();
  dom.api.takeFile(fakeFile());
  const url = dom.api._state.previewUrl;
  dom.entry.onLeave();
  assert.ok(dom.revoked.includes(url), `never revoked ${url}`);
});

test('removing the photo revokes its url and relives the button', () => {
  const dom = build();
  dom.api.takeFile(fakeFile());
  const url = dom.api._state.previewUrl;
  dom.body.querySelector('[data-role="clear-photo"]').click();
  assert.ok(dom.revoked.includes(url));
  assert.strictEqual(dom.api.canPost(), false);
});

// --------------------------------------------------------------------------
// re-entry
// --------------------------------------------------------------------------

test('opening the screen re-reads the zone', () => {
  // A driver who opens this after an hour of driving is somewhere else.
  const dom = build();
  dom.api._state.zone = null;
  dom.entry.onEnter();
  assert.ok(dom.api._state.zone && dom.api._state.zone.name, 'the zone was not re-read');
});

test('the last post confirmation does not linger into the next one', () => {
  const dom = build();
  dom.api._state.done = 'Posted.';
  dom.entry.onEnter();
  assert.strictEqual(dom.api._state.done, '');
});

// --------------------------------------------------------------------------
// markup and layout
// --------------------------------------------------------------------------

test('the file input is clipped rather than display:none', () => {
  // A display:none input is skipped by some browsers' pickers and by keyboard
  // focus, so the picker silently does nothing.
  assert.ok(!/\.composeFileInput\s*\{[^}]*display:\s*none/.test(RULES),
    'the file input is display:none');
  assert.ok(/\.composeFileInput\s*\{[^}]*opacity:\s*0/.test(RULES), 'not clipped either');
});

test('a disabled Post button looks disabled', () => {
  // A green button that does nothing when tapped reads as a broken app rather
  // than an empty form.
  assert.ok(/\.composeSubmit:disabled\s*\{/.test(CSS), 'no disabled style');
});

test('the hidden attribute actually hides every toggled block', () => {
  ['.composePhoto[hidden]', '.composePreview[hidden]', '.composeClear[hidden]',
    '.composeStatus[hidden]', '.composeDrop[hidden]'].forEach((sel) => {
    assert.ok(CSS.includes(sel), `${sel} missing — a flex/grid display beats [hidden]`);
  });
});

test('long content cannot widen the screen', () => {
  assert.ok(/\.composeBody\s*\{[^}]*box-sizing:\s*border-box/.test(CSS),
    'the textarea overflows its padding');
  assert.ok(/\.composePreview\s*\{[^}]*max-width:\s*100%/.test(CSS), 'preview');
  assert.ok(/\.composeZoneName\s*\{[^}]*text-overflow:\s*ellipsis/.test(CSS), 'zone name');
});

test('the body length cap matches the server', () => {
  const src = fs.readFileSync(JS_SOURCE, 'utf8');
  assert.ok(src.includes('2000'), 'MAX_BODY_CHARS on the server is 2000');
});

test('no stylesheet uses the invalid font shorthand', () => {
  // `font: 700 14px/1 inherit` is INVALID CSS: `inherit` is legal only as the
  // value of the whole property, never as the family inside the shorthand. The
  // browser drops the entire declaration, so every weight and size written
  // that way silently does nothing -- the textarea fell back to the UA's
  // monospace and the tabs to Arial 13px. Checked across every stylesheet this
  // work added, not just this one, because it shipped in two of them.
  ['compose.css', 'feed.css', 'map-action.css', 'landing.css', 'app-shell.css']
    .forEach((name) => {
      const text = fs.readFileSync(path.join(ROOT, name), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      const bad = text.match(/font:[^;}]*\binherit\b[^;}]*;/g) || [];
      // A bare `font: inherit` is fine; anything else ending in inherit is not.
      const broken = bad.filter((decl) => !/^font:\s*inherit\s*;$/.test(decl.trim()));
      assert.strictEqual(broken.length, 0,
        `${name} has an invalid font shorthand: ${broken.join(' ')}`);
    });
});

test('the empty character counter does not steal width from Post', () => {
  assert.ok(/\.composeCount:empty\s*\{[^}]*display:\s*none/.test(RULES),
    'the counter reserves space even when it says nothing');
});

test('both assets are registered in the manifest', () => {
  assert.ok(INDEX.includes('"./compose.css"'), 'css not loaded');
  assert.ok(INDEX.includes('"./compose.js"'), 'js not loaded');
});

test('compose has a night palette', () => {
  assert.ok(CSS.includes('body.night .composeBody'),
    'a white textarea at 3am is the whole reason the app has a night mode');
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
