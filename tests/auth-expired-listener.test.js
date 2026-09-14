/* Extracts the real tlc:auth-expired listener block out of app.part10.js and
   drives it, so the guard semantics are tested against shipped source. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app.part10.js'), 'utf8');

// Anchored on the registration itself, not on the comment above it. Keying off
// prose meant a reworded comment failed as "block not found", which looks like a
// broken test rather than a broken behaviour -- and hid whether the checks below
// actually pass or fail.
const ANCHOR = 'addEventListener("tlc:auth-expired"';
const END = 'function requireCommunityToken(';
const anchor = SRC.indexOf(ANCHOR);
const i = anchor < 0 ? -1 : SRC.lastIndexOf('if (typeof window !== "undefined") {', anchor);
const j = anchor < 0 ? -1 : SRC.indexOf(END, anchor);
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

function scenario({ signedIn, token: startToken }) {
  const listeners = {};
  const calls = { clearAuth: 0, setAuthUI: [], warn: 0 };
  let token = signedIn ? (startToken || 'abc.def.ghi') : '';

  const win = {
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    dispatchEvent(ev) { (listeners[ev.type] || []).forEach((f) => f(ev)); },
  };
  const authHeaderOK = () => typeof token === 'string' && token.trim().length > 0;
  const clearAuth = () => { calls.clearAuth += 1; token = ''; };
  const setAuthUI = (state, note) => { calls.setAuthUI.push([state, note]); };
  const consoleMock = { warn: () => { calls.warn += 1; } };

  // communityToken is read by the listener to tell "this session was rejected"
  // from "a request made with a token we have since replaced". It has to be
  // live -- clearAuth empties it, and a scenario can sign in again mid-test --
  // so it is a getter on the context rather than a copied value.
  const ctx = vm.createContext({
    window: win, authHeaderOK, clearAuth, setAuthUI, console: consoleMock,
  });
  Object.defineProperty(ctx, 'communityToken', { get: () => token });
  vm.runInContext(block, ctx, { filename: 'app.part10.js#auth-expired' });

  return {
    calls,
    fire: (detail) => win.dispatchEvent({ type: 'tlc:auth-expired', detail }),
    signInAs: (next) => { token = next; },
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

// 6. THE SIGN-IN RACE.
// A request made with the old token can land after a new sign-in has already
// succeeded. Its 401 says nothing about the new session, and acting on it threw
// a driver who had just signed in straight back to the welcome page. Reproduced
// in a browser by holding the polls' 401s: map at first, then overlay back up
// 15s later with "Session expired -- sign in again."
s = scenario({ signedIn: true, token: 'OLD.token.value' });
s.signInAs('NEW.token.value');
s.fire({ status: 401, url: 'https://api.test/frame/0', token: 'OLD.token.value' });
check('a 401 for a replaced token does not sign the new session out',
  s.calls.clearAuth === 0 && s.calls.setAuthUI.length === 0,
  `clearAuth=${s.calls.clearAuth} setAuthUI=${s.calls.setAuthUI.length}`);

// 7. ...and a real expiry must still work, or the fix has deleted the behaviour
// rather than narrowed it.
s.fire({ status: 401, url: 'https://api.test/frame/0', token: 'NEW.token.value' });
check('a 401 for the token actually in use still signs out',
  s.calls.clearAuth === 1, String(s.calls.clearAuth));

// 8. an event from a dispatcher that cannot name the token keeps the old
// behaviour: better a spurious sign-out than a session that can never end.
s = scenario({ signedIn: true, token: 'abc.def.ghi' });
s.fire({ status: 401, url: 'https://api.test/timeline' });
check('an event with no token still signs out', s.calls.clearAuth === 1, String(s.calls.clearAuth));

// 9. every dispatcher in the app names the token it sent, or the guard above is
// dead weight wherever one does not.
const DISPATCHERS = ['runtime.shared.js', 'app.js', 'feed.js', 'compose.js', 'profile.js'];
DISPATCHERS.forEach((file) => {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const at = src.indexOf('tlc:auth-expired');
  if (at < 0) return;                       // nothing to dispatch here
  const near = src.slice(at, at + 700);
  check(`${file} says which token was rejected`, /token\s*:/.test(near),
    'dispatches tlc:auth-expired without a token');
});

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
