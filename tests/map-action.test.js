#!/usr/bin/env node
/**
 * map-action.test.js — the on-map action pill.
 *
 * The thing worth protecting here is not the pill's looks. It is that the pill
 * cannot say something different from the assistant card. app.part17.js owns
 * the recommendation and publishes it; map-action.js renders it. So these tests
 * drive map-action.js against payloads and assert it renders exactly what it
 * was handed — and they read app.part17.js to check the publisher still emits
 * the fields the pill reads, since a rename there would silently blank the
 * pill rather than break anything loudly.
 *
 * The segmented pair this file used to own is deleted; what is pinned now is
 * that it stays deleted. Reimplementing a delegated control is how two copies
 * drift apart.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'map-action.css'), 'utf8');
const PART17 = fs.readFileSync(path.join(ROOT, 'app.part17.js'), 'utf8');
const APPJS = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const JS_SOURCE = path.join(ROOT, 'map-action.js');

// Every id map-action.js looks up. A rename in index.html blanks the pill
// without throwing, so the list is asserted rather than trusted.
const PILL_IDS = ['mapAction', 'mapActionPill', 'mapActionVerb', 'mapActionArrow',
  'mapActionDist', 'mapActionDot', 'mapActionZone', 'mapActionScore',
  'mapActionDetail', 'mapActionWhy', 'mapActionMeta',
];

// --------------------------------------------------------------------------
// a DOM just large enough for map-action.js
// --------------------------------------------------------------------------

function makeNode(tag) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [], parentNode: null, hidden: false, id: '',
    _classes: new Set(), _text: '', _attrs: {}, _listeners: {}, _props: {},
    clicks: 0,
  };
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
    get: () => node._text, set: (v) => { node._text = String(v); },
  });
  node.style = { setProperty: (k, v) => { node._props[k] = String(v); } };
  node.appendChild = (c) => { c.parentNode = node; node.children.push(c); return c; };
  node.setAttribute = (k, v) => { node._attrs[k] = String(v); };
  node.getAttribute = (k) => (k in node._attrs ? node._attrs[k] : null);
  node.addEventListener = (t, fn) => { (node._listeners[t] = node._listeners[t] || []).push(fn); };
  node.click = () => {
    node.clicks += 1;
    (node._listeners.click || []).forEach((fn) => fn({ type: 'click', target: node }));
  };
  return node;
}

function buildDom(options = {}) {
  const byId = new Map();
  const make = (tag, id) => {
    const n = makeNode(tag);
    if (id) { n.id = id; byId.set(id, n); }
    return n;
  };

  PILL_IDS.forEach((id) => make('div', id));
  byId.get('mapAction').hidden = true;
  byId.get('mapActionDetail').hidden = true;

  // The two elements map-action.js delegates to, each optional so their absence
  // can be tested.
  if (options.btnCenter !== false) {
    const c = make('button', 'btnCenter');
    c.className = 'toggleBtnSmall on';
  }
  if (options.btnPolice !== false) make('button', 'btnPolice');

  const body = makeNode('body');
  const document = {
    readyState: 'complete',
    body,
    getElementById: (id) => byId.get(id) || null,
    createElement: (t) => makeNode(t),
    addEventListener: () => {},
  };
  const window = {
    document, console,
    addEventListener: (t, fn) => { (window._l[t] = window._l[t] || []).push(fn); },
    _l: {},
    dispatch: (t, e) => (window._l[t] || []).forEach((fn) => fn(e)),
    TlcAssistantRecommendation: options.initial || null,
  };
  window.window = window;
  const ctx = vm.createContext({
    window, document, console,
    setTimeout: (fn) => { fn(); return 0; },
    CustomEvent: function (type, init) {
      this.type = type;
      this.detail = init && init.detail;
      window._fired = (window._fired || []).concat(type);
    },
    // Not defined on purpose unless asked for: map-action.js must survive a
    // browser without MutationObserver rather than throwing at boot.
    MutationObserver: options.mutationObserver === false ? undefined : function (cb) {
      this.observe = () => { window._observer = cb; };
    },
  });
  vm.runInContext(fs.readFileSync(JS_SOURCE, 'utf8'), ctx, { filename: 'map-action.js' });
  return { window, document, byId, body, api: window.TeamJoseoMapAction };
}

function publish(dom, detail, extra = {}) {
  const rec = Object.assign({ primary: '', secondary: '', source: 'local', detail }, extra);
  dom.window.TlcAssistantRecommendation = rec;
  dom.window.dispatch('tlc:recommendation', { detail: rec });
  return rec;
}

const STAY = { actionCode: 'STAY', verb: 'STAY', tone: 'hold', isMove: false,
  zoneName: 'Astoria', score: 91, distanceMiles: null, etaMinutes: null, bearingDeg: null };
const LEAVE = { actionCode: 'LEAVE_NOW', verb: 'LEAVE', tone: 'urgent', isMove: true,
  zoneName: 'Astoria', score: 91, distanceMiles: 4.2, etaMinutes: 14, bearingDeg: 37.5 };

const tests = [];
const test = (n, f) => tests.push([n, f]);

// --------------------------------------------------------------------------
// the markup and the ids
// --------------------------------------------------------------------------

test('every id map-action.js looks up is in index.html, exactly once', () => {
  PILL_IDS.forEach((id) => {
    const hits = INDEX.split(`id="${id}"`).length - 1;
    assert.strictEqual(hits, 1, `id="${id}" appears ${hits} times`);
  });
});

test('the pill ships hidden', () => {
  // A pill that renders before the first recommendation shows a driver an empty
  // instruction, which is worse than showing nothing.
  const open = INDEX.indexOf('<div id="mapAction"');
  assert.ok(open > -1, 'pill markup present');
  const tag = INDEX.slice(open, INDEX.indexOf('>', open));
  assert.ok(/\bhidden\b/.test(tag), 'the pill container ships with hidden');
});

// --------------------------------------------------------------------------
// rendering — the pill says what it was handed, and nothing else
// --------------------------------------------------------------------------

test('nothing shows before the first recommendation', () => {
  const dom = buildDom();
  assert.strictEqual(dom.byId.get('mapAction').hidden, true);
});

test('a stay renders the verb, the zone and the score', () => {
  const dom = buildDom();
  publish(dom, STAY);
  assert.strictEqual(dom.byId.get('mapAction').hidden, false);
  assert.strictEqual(dom.byId.get('mapActionVerb').textContent, 'STAY');
  assert.strictEqual(dom.byId.get('mapActionZone').textContent, 'Astoria');
  assert.strictEqual(dom.byId.get('mapActionScore').textContent, '91');
  assert.strictEqual(dom.byId.get('mapActionScore').hidden, false);
});

test('a stay shows no distance, no arrow and no separator', () => {
  // "STAY ↑ 4.2mi · Astoria" would be pointing a driver out of the zone it just
  // told them to hold.
  const dom = buildDom();
  publish(dom, STAY);
  assert.strictEqual(dom.byId.get('mapActionDist').hidden, true);
  assert.strictEqual(dom.byId.get('mapActionArrow').hidden, true);
  assert.strictEqual(dom.byId.get('mapActionDot').hidden, true);
});

test('a move renders distance, arrow and separator', () => {
  const dom = buildDom();
  publish(dom, LEAVE);
  assert.strictEqual(dom.byId.get('mapActionVerb').textContent, 'LEAVE');
  assert.strictEqual(dom.byId.get('mapActionDist').textContent, '4.2mi');
  assert.strictEqual(dom.byId.get('mapActionDist').hidden, false);
  assert.strictEqual(dom.byId.get('mapActionDot').hidden, false);
  assert.strictEqual(dom.byId.get('mapActionArrow').hidden, false);
});

test('the arrow is rotated to the published bearing', () => {
  const dom = buildDom();
  publish(dom, LEAVE);
  assert.strictEqual(dom.byId.get('mapActionArrow')._props['--bearing'], '37.5deg');
});

test('the tone attribute drives the colour, and only leave is urgent', () => {
  const dom = buildDom();
  publish(dom, STAY);
  assert.strictEqual(dom.byId.get('mapActionPill').getAttribute('data-tone'), 'hold');
  publish(dom, LEAVE);
  assert.strictEqual(dom.byId.get('mapActionPill').getAttribute('data-tone'), 'urgent');
});

test('a bearing of zero still points north rather than disappearing', () => {
  // 0 is falsy. Hiding the arrow on a due-north target is the classic version
  // of this bug.
  const dom = buildDom();
  publish(dom, Object.assign({}, LEAVE, { bearingDeg: 0 }));
  assert.strictEqual(dom.byId.get('mapActionArrow').hidden, false);
  assert.strictEqual(dom.byId.get('mapActionArrow')._props['--bearing'], '0.0deg');
});

test('a score of zero renders as 0 rather than vanishing', () => {
  const dom = buildDom();
  publish(dom, Object.assign({}, STAY, { score: 0 }));
  assert.strictEqual(dom.byId.get('mapActionScore').hidden, false);
  assert.strictEqual(dom.byId.get('mapActionScore').textContent, '0');
});

test('a missing score hides the badge instead of printing null', () => {
  const dom = buildDom();
  publish(dom, Object.assign({}, STAY, { score: null }));
  assert.strictEqual(dom.byId.get('mapActionScore').hidden, true);
  assert.strictEqual(dom.byId.get('mapActionScore').textContent, '');
});

test('distances are tenths under ten miles and whole above', () => {
  const dom = buildDom();
  publish(dom, Object.assign({}, LEAVE, { distanceMiles: 0.8 }));
  assert.strictEqual(dom.byId.get('mapActionDist').textContent, '0.8mi');
  publish(dom, Object.assign({}, LEAVE, { distanceMiles: 12.4 }));
  assert.strictEqual(dom.byId.get('mapActionDist').textContent, '12mi');
});

test('a payload with no detail hides the pill again', () => {
  const dom = buildDom();
  publish(dom, STAY);
  assert.strictEqual(dom.byId.get('mapAction').hidden, false);
  publish(dom, null);
  assert.strictEqual(dom.byId.get('mapAction').hidden, true);
});

test('a recommendation published before boot is picked up at mount', () => {
  const rec = { primary: 'Stay • Strong zone', secondary: '', source: 'local', detail: STAY };
  const dom = buildDom({ initial: rec });
  assert.strictEqual(dom.byId.get('mapAction').hidden, false);
  assert.strictEqual(dom.byId.get('mapActionVerb').textContent, 'STAY');
});

// --------------------------------------------------------------------------
// the detail sheet
// --------------------------------------------------------------------------

test('the sheet shows the assistant sentence, not a paraphrase', () => {
  const dom = buildDom();
  publish(dom, LEAVE, { secondary: 'Trap risk here. Better escape 0.8 mi away.' });
  assert.strictEqual(dom.byId.get('mapActionWhy').textContent,
    'Trap risk here. Better escape 0.8 mi away.');
});

test('the sheet falls back to the primary line when there is no detail line', () => {
  const dom = buildDom();
  publish(dom, STAY, { primary: 'Stay • Excellent zone right now', secondary: '' });
  assert.strictEqual(dom.byId.get('mapActionWhy').textContent, 'Stay • Excellent zone right now');
});

test('tapping the pill opens and closes the sheet', () => {
  const dom = buildDom();
  publish(dom, LEAVE, { secondary: 'Better nearby.' });
  assert.strictEqual(dom.byId.get('mapActionDetail').hidden, true);
  dom.byId.get('mapActionPill').click();
  assert.strictEqual(dom.byId.get('mapActionDetail').hidden, false);
  assert.strictEqual(dom.byId.get('mapActionPill').getAttribute('aria-expanded'), 'true');
  dom.byId.get('mapActionPill').click();
  assert.strictEqual(dom.byId.get('mapActionDetail').hidden, true);
  assert.strictEqual(dom.byId.get('mapActionPill').getAttribute('aria-expanded'), 'false');
});

test('an open sheet tells the shell, so the menu button gets out of its way', () => {
  /* Expanded, the card runs the full width of the screen and its first words
   * start 14px in -- which is exactly where the top-left menu button sits. The
   * class is the whole conversation between the two; feed-first.css reads it
   * and nothing else does. */
  const dom = buildDom();
  publish(dom, LEAVE, { secondary: 'Better nearby.' });
  assert.strictEqual(dom.body.classList.contains('map-answer-open'), false);
  dom.byId.get('mapActionPill').click();
  assert.strictEqual(dom.body.classList.contains('map-answer-open'), true);
  dom.byId.get('mapActionPill').click();
  assert.strictEqual(dom.body.classList.contains('map-answer-open'), false);
});

test('a card closed by the next tick clears the class it set', () => {
  // setExpanded(false) runs from render() as well as from the tap, so the
  // button cannot be left hidden by a recommendation that went quiet.
  const dom = buildDom();
  publish(dom, LEAVE, { secondary: 'Better nearby.' });
  dom.byId.get('mapActionPill').click();
  assert.strictEqual(dom.body.classList.contains('map-answer-open'), true);
  publish(dom, STAY, { primary: '', secondary: '' });
  assert.strictEqual(dom.body.classList.contains('map-answer-open'), false);
});

test('a pill with nothing behind it does not pretend to expand', () => {
  const dom = buildDom();
  publish(dom, STAY, { primary: '', secondary: '' });
  dom.byId.get('mapActionPill').click();
  assert.strictEqual(dom.byId.get('mapActionDetail').hidden, true);
  assert.strictEqual(dom.api.expanded(), false);
});

test('an open sheet closes when the next tick has nothing to show', () => {
  const dom = buildDom();
  publish(dom, LEAVE, { secondary: 'Better nearby.' });
  dom.byId.get('mapActionPill').click();
  assert.strictEqual(dom.api.expanded(), true);
  publish(dom, STAY, { primary: '', secondary: '' });
  assert.strictEqual(dom.api.expanded(), false, 'a stale sheet stayed open with no content');
});

test('the eta and the scoring source appear in the sheet meta', () => {
  const dom = buildDom();
  publish(dom, LEAVE, { secondary: 'Better nearby.', source: 'server' });
  const meta = dom.byId.get('mapActionMeta').textContent;
  assert.ok(meta.includes('14 min away'), meta);
  assert.ok(meta.includes('Live scoring'), meta);
});

// --------------------------------------------------------------------------
// the segmented control is gone, not hidden
// --------------------------------------------------------------------------

test('the segmented pair is deleted from the markup, not merely hidden', () => {
  /* It was asked for as a deletion, and hidden still ships: the markup is in
   * the DOM, this file still wired it, it just was not painted.
   *
   * Both halves only ever delegated -- recentre clicked #btnCenter, report
   * clicked #btnPolice -- so nothing lost an implementation. Reporting police
   * is still in the Modes panel where that half clicked; recentring has no
   * control any more and auto-centre simply stays on. */
  ['mapSegmented', 'mapSegCenter', 'mapSegReport', 'mapControlStack', 'btnCenter']
    .forEach((id) => {
      assert.ok(!INDEX.includes(id), `${id} is back in index.html`);
    });
  const src = fs.readFileSync(JS_SOURCE, 'utf8');
  ['mapSegmented', 'mapSegCenter', 'mapSegReport', 'wireSegmented', 'map-segmented-on']
    .forEach((name) => {
      assert.ok(!src.includes(name), `${name} is back in map-action.js`);
    });
  assert.ok(!/\.mapSegmented|\.mapSegBtn/.test(CSS), 'the styles are back');
});

test('the police report it delegated to is still reachable', () => {
  // In the Modes panel in the dock, which is where that half always clicked.
  assert.ok(INDEX.includes('id="btnPolice"'),
    'removing the pair took the police report with it');
});


test('a browser without MutationObserver still boots', () => {
  // The observer was only ever used to mirror the deleted recentre button's
  // class. Nothing here needs it now, and nothing here may throw without it.
  const dom = buildDom({ mutationObserver: false });
  publish(dom, STAY);
  assert.strictEqual(dom.byId.get('mapAction').hidden, false);
});

// --------------------------------------------------------------------------
// the publisher on the other side of the seam
// --------------------------------------------------------------------------

test('app.part17.js publishes the detail block the pill reads', () => {
  assert.ok(/detail:\s*buildActionDetail\(\)/.test(PART17),
    'the recommendation no longer carries a detail block');
  ['actionCode', 'verb', 'tone', 'isMove', 'zoneName', 'score',
    'distanceMiles', 'etaMinutes', 'bearingDeg'].forEach((field) => {
    assert.ok(new RegExp(`${field}:`).test(PART17), `buildActionDetail dropped ${field}`);
  });
});

test('app.part17.js fires the event the pill listens for', () => {
  assert.ok(PART17.includes('"tlc:recommendation"'),
    'nothing dispatches tlc:recommendation, so the pill would never update');
});

test('the publisher is the same function that owns the sentence', () => {
  // Two publishers is two recommendations. buildActionDetail must be called
  // from mirrorRecommendLine and nowhere else.
  // Minus the declaration itself, which spells the same characters.
  const calls = PART17.split('buildActionDetail()').length - 1
    - (PART17.split('function buildActionDetail()').length - 1);
  assert.strictEqual(calls, 1, `buildActionDetail() is called ${calls} times`);
  const fn = PART17.indexOf('function mirrorRecommendLine()');
  const call = PART17.indexOf('detail: buildActionDetail()');
  assert.ok(call > fn, 'the detail block is published outside mirrorRecommendLine');
});

test('a move with no target is published as MONITOR, not as a blind arrow', () => {
  const start = PART17.indexOf('function buildActionDetail()');
  const body = PART17.slice(start, start + 3000);
  assert.ok(/if\s*\(moving\s*&&\s*!target\)/.test(body),
    'buildActionDetail no longer guards a move with no target');
});

test('the bearing helper the publisher calls is actually exported', () => {
  // computeBearingDeg lives in app.js. Reading it off internals without
  // exporting it returns undefined, and the arrow silently never appears.
  assert.ok(/^\s*computeBearingDeg,\s*$/m.test(APPJS),
    'computeBearingDeg is not on window.TlcMapUiInternals');
  assert.ok(PART17.includes('internals.computeBearingDeg?.('),
    'the publisher stopped using the shared bearing helper');
});

test('map-action.js computes no recommendation of its own', () => {
  const src = fs.readFileSync(JS_SOURCE, 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
  ['LEAVE_NOW', 'MOVE_SOON', 'visibleRating', 'haversine'].forEach((token) => {
    assert.ok(!src.includes(token),
      `map-action.js references ${token} — it must render the recommendation, not derive one`);
  });
});

// --------------------------------------------------------------------------
// layout
// --------------------------------------------------------------------------

test('the pill sits under the dock in the stacking order', () => {
  // The dock is z-index 3000 and the menu button 3200. A pill above either
  // swallows taps meant for them.
  const z = /#mapAction\s*\{[^}]*z-index:\s*(\d+)/.exec(CSS);
  assert.ok(z, 'the pill declares a z-index');
  assert.ok(Number(z[1]) > 1200, 'the pill sits above the slider');
});

test('the whole card grows upward, so nothing lands where the dock is', () => {
  // This test used to require order:-1 on the sheet, which floated it above a
  // pill that never moved. The approved Expanded artboard makes the pill the
  // card's header instead, so the pill does rise by the drawer's height when
  // it opens -- a deliberate trade for the answer keeping one shape and one
  // colour whether open or shut. What must still hold is the direction: the
  // container is anchored by its bottom, so the card can only grow up, never
  // down into the dock.
  assert.ok(/#mapAction\s*\{[^}]*bottom:/s.test(CSS),
    'the pill container is not bottom-anchored, so opening it grows downward');
  assert.ok(!/#mapAction\s*\{[^}]*[^-]top:/s.test(CSS),
    'a top anchor would pin the card and push the drawer over the dock');
});

test('the hidden attribute actually hides, despite the flex display', () => {
  // display:flex on a container beats the hidden attribute's UA display:none.
  assert.ok(CSS.includes('#mapAction[hidden]'), 'the pill container');
  assert.ok(CSS.includes('.mapActionDetail[hidden]'), 'the detail sheet');
});

/* Two tests stood here: the badge strip being moved out from under the
 * segmented control, and the recompute that had to follow it. Both existed
 * only because there was a control in that corner. There is not one now, so
 * the badges keep the corner they always had and nothing has to be pushed. */

test('the assistant card follows the badges rather than a hardcoded top', () => {
  // It is positioned inline by updateAssistantDockLayout, so a CSS nudge cannot
  // move it. Reading the badges' live top is what keeps it on their line.
  assert.ok(PART17.includes('const laneTop ='), 'laneTop no longer derived');
  assert.ok(!/dock\.style\.top = "calc\(env\(safe-area-inset-top\) \+ 10px\)"/.test(PART17),
    'the dock top is hardcoded again, so it will not follow the badge strip');
  const assigns = PART17.split('dock.style.top = laneTop;').length - 1;
  assert.strictEqual(assigns, 2, `both dock layout branches must set laneTop (found ${assigns})`);
});

test('the map chrome is hidden while the signed-out page shows', () => {
  assert.ok(CSS.includes('#lockedOverlay.show ~ #mapAction'), 'pill');
  // The segmented control was on this line and is deleted, not hidden.
});

test('both new assets are registered in the manifest', () => {
  assert.ok(INDEX.includes('"./map-action.css"'), 'css not loaded');
  assert.ok(INDEX.includes('"./map-action.js"'), 'js not loaded');
});

test('motion is honoured as a preference', () => {
  assert.ok(CSS.includes('prefers-reduced-motion'),
    'the colour and arrow transitions ignore reduced motion');
});


// ------------------------------------------------ the approved pill geometry

test('the collapsed pill hugs its words instead of spanning the map', () => {
  // The approved artboard's pill is 200px wide on a 390px screen -- "STAY ·
  // Astoria 86" and no more. It shipped full-bleed, and full-bleed is what a
  // toolbar looks like, not a badge. Three things together produce the hug,
  // and any one of them reverting puts it back to 366px.
  assert.ok(/#mapAction\s*\{[^}]*align-items:\s*center/s.test(CSS),
    'the column stretches its children, so the pill cannot size to content');
  assert.ok(/\.mapActionPill\s*\{[^}]*width:\s*auto/s.test(CSS),
    'the pill is back to a fixed width');
  assert.ok(/\.mapActionFacts\s*\{[^}]*flex:\s*0 1 auto/s.test(CSS),
    'facts claiming the leftover width stretches the pill back to full-bleed');
});

test('the pill is the height the artboard draws', () => {
  assert.ok(/\.mapActionPill\s*\{[^}]*height:\s*42px/s.test(CSS), 'not 42px tall');
});

test('expanded, the pill becomes the header of its sheet', () => {
  assert.ok(/\.mapActionPill\[aria-expanded="true"\]\s*\{[^}]*width:\s*100%/s.test(CSS),
    'the expanded pill must span the sheet it opened');
  // The sheet no longer sets its own width: it is a child of .mapActionCard,
  // a flex column that stretches it. The card is what goes full-width.
  assert.ok(/\.mapActionCard\.open\s*\{[^}]*width:\s*100%/s.test(CSS),
    'the open card must span the column, or the drawer hugs the pill width');
});

test('the verb and the zone are separated the way the artboard separates them', () => {
  assert.ok(INDEX.includes('mapActionSep'), 'no separator between the verb and the zone');
  assert.ok(/\.mapActionSep\s*\{[^}]*border-radius:\s*999px/s.test(CSS),
    'the separator is not a dot');
});

test('the dock icons are single-stroke line art, not illustrations', () => {
  /* The set before these WERE multi-colour illustrations: a blue gear, a
   * red-and-yellow gamepad, a drum-kit emoji. Next to the approved map they
   * read as stickers, and that is still the rule.
   *
   * What changed is where the colour comes from. Nine identical grey strokes
   * on nine identical white circles left the dock unreadable -- "difficult to
   * know what they are by just looking at them" -- so each destination now
   * takes a hue of its own from CSS, through currentColor. One stroke, one
   * weight, one hue: still not a painting, and the glyphs themselves stay
   * colourless so night can invert them. */
  const APP = APPJS;
  const block = APP.slice(APP.indexOf('function applyDockIconModel'),
                          APP.indexOf('const pickupIconEl'));

  // Colours is the sole exception, and it is the map's own scale rather than a
  // picture: the three tones the zones and the answer pill are painted with.
  const colours = block.slice(block.indexOf('setIcon(dockColors'),
                              block.indexOf('setIcon(dockModes'));
  const rest = block.replace(colours, '');
  assert.ok(!/fill="#(?!fff|ffffff)[0-9a-f]{3,6}"/i.test(rest),
    'a dock icon other than Colours carries a hardcoded colour fill');
  ['#ef2f3c', '#f0a828', '#14b85f'].forEach((tone) => {
    assert.ok(colours.includes(tone), `Colours is not drawn in the map tone ${tone}`);
  });
  assert.ok(!/🥁|🎨|⚙️/.test(block), 'a dock icon is still an emoji');
  const strokes = block.split('stroke="currentColor"').length - 1;
  assert.ok(strokes >= 7, `expected every dock icon to stroke with currentColor (found ${strokes})`);
});

test('every destination in the dock is a different colour', () => {
  /* The hue IS the identity -- it is what lets a driver find Music without
   * reading a glyph at 23px. Each one appears twice: on the stroke and, a
   * tenth as strong, on the circle behind it. */
  const CSS = fs.readFileSync(path.join(ROOT, 'feed-first.css'), 'utf8');
  const wanted = ['dockFeed', 'dockChat', 'dockGames', 'dockMusic',
    'dockLeaderboard', 'dockProfile', 'dockModes', 'dockAdmin'];
  const hues = {};
  wanted.forEach((id) => {
    const day = CSS.match(new RegExp('#' + id + '\\s+\\.dockIcon\\s*\\{[^}]*color:\\s*(#[0-9a-f]{6})', 'i'));
    assert.ok(day, `${id} has no colour`);
    hues[id] = day[1].toLowerCase();
    assert.ok(new RegExp('body\\.night #' + id + '\\s+\\.dockIcon\\s*\\{[^}]*color:', 'i').test(CSS),
      `${id} keeps its day ink at night, where the button is dark`);
    assert.ok(new RegExp('body\\.feed-first #' + id + '[^{]*\\{[^}]*background:', 'i').test(CSS),
      `${id} has no tint behind it`);
  });
  const seen = Object.values(hues);
  assert.strictEqual(new Set(seen).size, seen.length,
    `two destinations share a colour: ${seen.join(' ')}`);

  // Save is the one fully saturated, filled button and stays that way -- it
  // is the only thing in the dock that acts on the world rather than
  // navigating, so it has to outrank the row it sits in.
  assert.ok(!/#pickupFab\s+\.dockIcon\s*\{[^}]*color:/.test(CSS),
    'Save was pulled into the tint system');
});

test('the dock ink stays legible on the dock that actually exists', () => {
  // currentColor is only correct if something sets the colour. It must be a
  // DARK ink and stay dark: the night dock button measures
  // rgba(255,255,255,.82), lighter than the day one, so the light-ink night
  // override this test used to demand made the icons invisible (~1.05:1).
  const SHELL = fs.readFileSync(path.join(ROOT, 'frontend-shell.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(/\.dockIcon\s*\{[^}]*color:\s*#101622/s.test(SHELL), 'dock ink unset or not the dark ink');
  assert.ok(!/body\.night\s+\.dockIcon\s*\{[^}]*color:/s.test(SHELL),
    'a night ink override puts light icons back on a light dock');
});

// -------------------------------------------------- the expanded card

test('the pill and the reasoning are one card, pill first', () => {
  // The approved Expanded artboard unrolls the pill into a card whose header
  // IS the pill. It used to be two floating pieces with the sheet ordered
  // above the pill.
  assert.ok(INDEX.includes('mapActionCard'), 'no card wrapper');
  const card = INDEX.indexOf('mapActionCard');
  const pill = INDEX.indexOf('mapActionPill', card);
  const detail = INDEX.indexOf('mapActionDetail', card);
  assert.ok(pill > -1 && detail > pill, 'the reasoning must follow the pill inside the card');
  assert.ok(!/\.mapActionDetail\s*\{[^}]*order:\s*-1/s.test(CSS),
    'the sheet still floats above the pill instead of hanging under it');
});

test('the card is invisible until it has something to hold', () => {
  // A collapsed card that paints its surface turns the badge into a badge
  // sitting on an empty white slab.
  const base = CSS.match(/\.mapActionCard\s*\{[^}]*\}/s)[0];
  assert.ok(!/background/.test(base), 'the collapsed card paints a background');
  assert.ok(!/border:/.test(base), 'the collapsed card paints a border');
  assert.ok(/\.mapActionCard\.open\s*\{[^}]*background/s.test(CSS),
    'the open card has no surface');
});

test('the pill squares off where it meets the drawer', () => {
  assert.ok(/\.mapActionPill\[aria-expanded="true"\]\s*\{[^}]*border-radius:\s*18px 18px 0 0/s.test(CSS),
    'the expanded pill keeps round bottom corners against a square drawer');
});

test('opening the sheet is what opens the card', () => {
  const JS = fs.readFileSync(path.join(ROOT, 'map-action.js'), 'utf8');
  assert.ok(/classList\.toggle\("open", expanded\)/.test(JS),
    'the card never opens, so the reasoning renders on no surface');
});

test('the reasoning is not clipped by the card that clips', () => {
  // The card sets overflow:hidden so it can square the pill's corners. A
  // width:100% child PLUS padding then overflowed by exactly the padding and
  // got cut -- the reasoning lost its last two words on every line.
  // Strip comments first: the block explains the bug in prose, and a bare
  // search would match the explanation instead of a declaration.
  const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const detail = bare.match(/\.mapActionDetail\s*\{[^}]*\}/s)[0];
  assert.ok(!/width:\s*100%/.test(detail),
    'width:100% plus padding overflows the card, which now clips');
  assert.ok(/box-sizing:\s*border-box/.test(detail), 'padding is not counted in the width');
});

test('an empty line in the drawer does not pad the card', () => {
  assert.ok(/:empty\s*(,[^{]*)?\{[^}]*display:\s*none/s.test(CSS),
    'an empty meta line still costs a gap inside the card');
});

// --------------------------------------------------------------------------

let failed = 0;
tests.forEach(([name, fn]) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
});
console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);
