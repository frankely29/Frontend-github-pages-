/* Extracts the real tlc:auth-expired listener block out of app.part10.js and
   drives it, so the guard semantics are tested against shipped source. */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app.part10.js'), 'utf8');

const START = '// Any authenticated request coming back 401 means the stored token is dead.';
const END = 'function requireCommunityToken(';
const i = SRC.indexOf(START);
const j = SRC.indexOf(END, i);
if (i < 0 || j < 0) {
  console.error('FAIL: could not locate the tlc:auth-expired listener block in app.part10.js');
  process.exit(1);
}
const block = SRC.slice(i, j);
if (!/addEventListener\("tlc:auth-expired"/.test(block)) {
  console.error('FAIL: extracted block does not register a tlc:auth-expired listener');
  process.exit(1);
}

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures += 1;
  console.log(`  FAIL ${name}${extra ? ` :: ${extra}` : ''}`);
}

function scenario({ signedIn }) {
  const listeners = {};
  const calls = { clearAuth: 0, setAuthUI: [], warn: 0 };
  let token = signedIn ? 'abc.def.ghi' : '';

  const win = {
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    dispatchEvent(ev) { (listeners[ev.type] || []).forEach((f) => f(ev)); },
  };
  const authHeaderOK = () => typeof token === 'string' && token.trim().length > 0;
  const clearAuth = () => { calls.clearAuth += 1; token = ''; };
  const setAuthUI = (state, note) => { calls.setAuthUI.push([state, note]); };
  const consoleMock = { warn: () => { calls.warn += 1; } };

  // eslint-disable-next-line no-new-func
  new Function('window', 'authHeaderOK', 'clearAuth', 'setAuthUI', 'console', block)(
    win, authHeaderOK, clearAuth, setAuthUI, consoleMock
  );

  return {
    calls,
    fire: (detail) => win.dispatchEvent({ type: 'tlc:auth-expired', detail }),
    registered: !!(listeners['tlc:auth-expired'] || []).length,
  };
}

// 1. listener actually registers
let s = scenario({ signedIn: true });
check('listener registers on window', s.registered);

// 2. a signed-in user gets signed out with an honest note
s.fire({ status: 401, url: 'https://api.test/timeline' });
check('clearAuth called once', s.calls.clearAuth === 1, String(s.calls.clearAuth));
check('setAuthUI told to show signed-out', s.calls.setAuthUI[0]?.[0] === false, JSON.stringify(s.calls.setAuthUI[0]));
check('note names an expired session', /expired/i.test(s.calls.setAuthUI[0]?.[1] || ''), s.calls.setAuthUI[0]?.[1]);
check('the rejecting url is logged', s.calls.warn === 1, String(s.calls.warn));

// 3. the burst case: every feed 401s at once, only the first acts
s.fire({ status: 401, url: 'https://api.test/presence/all' });
s.fire({ status: 401, url: 'https://api.test/chat/recent' });
s.fire({ status: 401, url: 'https://api.test/events/pickups/recent' });
check('a burst of 401s still signs out exactly once', s.calls.clearAuth === 1, String(s.calls.clearAuth));
check('a burst does not re-render the note repeatedly', s.calls.setAuthUI.length === 1, String(s.calls.setAuthUI.length));

// 4. already signed out -> no-op (no spurious overlay churn)
s = scenario({ signedIn: false });
s.fire({ status: 401, url: 'https://api.test/timeline' });
check('signed-out user is left alone', s.calls.clearAuth === 0 && s.calls.setAuthUI.length === 0,
  `clearAuth=${s.calls.clearAuth} setAuthUI=${s.calls.setAuthUI.length}`);

// 5. a missing detail must not throw
s = scenario({ signedIn: true });
let threw = null;
try { s.fire(undefined); } catch (e) { threw = e; }
check('an event with no detail does not throw', !threw, threw?.message);
check('and it still signs out', s.calls.clearAuth === 1, String(s.calls.clearAuth));

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
