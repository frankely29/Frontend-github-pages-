/* Drives the real runtime.shared.js to check the 401 -> tlc:auth-expired signal. */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'runtime.shared.js'), 'utf8');

const events = [];
let nextResponse = null;

class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = init?.detail; }
}

const listeners = {};
const win = {
  location: { hostname: 'frankely29.github.io', protocol: 'https:' },
  API_BASE: 'https://api.example.test',
  CustomEvent,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
  dispatchEvent(ev) { events.push({ type: ev.type, detail: ev.detail }); (listeners[ev.type] || []).forEach((f) => f(ev)); return true; },
  addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
};
win.window = win;

global.window = win;
global.CustomEvent = CustomEvent;
global.localStorage = { getItem: () => '', setItem: () => {}, removeItem: () => {} };
global.performance = { now: () => Date.now() };
global.AbortController = class { constructor() { this.signal = {}; } abort() {} };
global.fetch = async () => nextResponse;

// eslint-disable-next-line no-new-func
new Function('window', 'localStorage', 'fetch', 'CustomEvent', 'AbortController', 'performance', src)(
  win, global.localStorage, global.fetch, CustomEvent, global.AbortController, global.performance
);

const runtime = win.FrontendRuntime;
if (!runtime || typeof runtime.fetchJSON !== 'function') {
  console.error('FAIL: runtime.shared.js did not expose FrontendRuntime.fetchJSON');
  process.exit(1);
}

function respond(status, body) {
  nextResponse = {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body || {})),
  };
}

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures += 1;
  console.log(`  FAIL ${name}${extra ? ` :: ${extra}` : ''}`);
}

async function call(pathOrUrl, status, body, headers) {
  events.length = 0;
  respond(status, body);
  let err = null;
  try {
    await runtime.fetchJSON(pathOrUrl, headers ? { headers } : {});
  } catch (e) { err = e; }
  return { err, fired: events.map((e) => e.type), events: events.slice() };
}

(async () => {
  const AUTH = { Authorization: 'Bearer abc.def.ghi' };

  // 1. authenticated 401 on a gated feed -> signal
  let r = await call('/timeline', 401, { detail: 'Invalid token' }, AUTH);
  check('401 on /timeline with token fires tlc:auth-expired', r.fired.includes('tlc:auth-expired'), JSON.stringify(r.fired));
  check('401 error still propagates with status', r.err?.status === 401, String(r.err?.status));
  check('401 detail carries the url', String(r.events[0]?.detail?.url || '').endsWith('/timeline'), r.events[0]?.detail?.url);

  // 2. no Authorization header -> no signal (nothing to clear; user is signed out)
  r = await call('/timeline', 401, { detail: 'Missing Bearer token' });
  check('401 without a token does not fire', !r.fired.includes('tlc:auth-expired'), JSON.stringify(r.fired));

  // 3. credential-check endpoints are carved out
  for (const p of ['/auth/login', '/auth/signup', '/me/change_password']) {
    r = await call(p, 401, { detail: 'Invalid email or password' }, AUTH);
    check(`401 on ${p} does not fire`, !r.fired.includes('tlc:auth-expired'), JSON.stringify(r.fired));
  }

  // 4. query strings must not defeat the carve-out
  r = await call('/auth/login?next=%2F', 401, { detail: 'Invalid email or password' }, AUTH);
  check('401 on /auth/login?next=... does not fire', !r.fired.includes('tlc:auth-expired'), JSON.stringify(r.fired));

  // 5. the 402 paywall signal is untouched
  r = await call('/timeline', 402, { detail: 'Subscription required' }, AUTH);
  check('402 still fires tlc:payment-required', r.fired.includes('tlc:payment-required'), JSON.stringify(r.fired));
  check('402 does not fire tlc:auth-expired', !r.fired.includes('tlc:auth-expired'), JSON.stringify(r.fired));

  // 6. other statuses stay silent
  for (const s of [400, 403, 404, 500, 503]) {
    r = await call('/timeline', s, { detail: 'nope' }, AUTH);
    check(`${s} fires nothing`, r.fired.length === 0, JSON.stringify(r.fired));
  }

  // 7. success path unaffected
  events.length = 0;
  respond(200, { timeline: ['2025-10-01T00:00:00'] });
  const okPayload = await runtime.fetchJSON('/timeline', { headers: AUTH });
  check('200 returns parsed json', Array.isArray(okPayload?.timeline), JSON.stringify(okPayload));
  check('200 fires nothing', events.length === 0, JSON.stringify(events.map((e) => e.type)));

  // 8. lowercase header name still counts as authenticated
  r = await call('/timeline', 401, { detail: 'Invalid token' }, { authorization: 'Bearer abc' });
  check('lowercase authorization header counts', r.fired.includes('tlc:auth-expired'), JSON.stringify(r.fired));

  // 9. an empty Authorization value is not a token
  r = await call('/timeline', 401, { detail: 'Missing Bearer token' }, { Authorization: '' });
  check('empty Authorization value does not fire', !r.fired.includes('tlc:auth-expired'), JSON.stringify(r.fired));

  // 10. postJSON/getJSONAuth go through the same choke point
  events.length = 0;
  respond(401, { detail: 'Invalid token' });
  try { await runtime.getJSONAuth('/me/stats', 'abc.def'); } catch (_) {}
  check('getJSONAuth 401 fires', events.some((e) => e.type === 'tlc:auth-expired'), JSON.stringify(events.map((e) => e.type)));

  events.length = 0;
  respond(401, { detail: 'Invalid token' });
  try { await runtime.postJSON('/presence/update', {}, 'abc.def'); } catch (_) {}
  check('postJSON 401 fires', events.some((e) => e.type === 'tlc:auth-expired'), JSON.stringify(events.map((e) => e.type)));

  // 11. changePassword via accountActions must NOT fire (wrong-password case)
  events.length = 0;
  respond(401, { detail: 'Incorrect current password' });
  const actions = runtime.createAccountActions({ getToken: () => 'abc.def' });
  try { await actions.changePassword('wrong', 'newpassword123'); } catch (_) {}
  check('changePassword 401 does not fire', !events.some((e) => e.type === 'tlc:auth-expired'), JSON.stringify(events.map((e) => e.type)));

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
