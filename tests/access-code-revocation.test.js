/**
 * Admin control over an access code after it has been handed out.
 *
 * Two layers, both loading the real shipped source:
 *
 *   admin.actions.js       the exact request each control sends. A wrong body
 *                          here is the difference between "stop this code" and
 *                          "cut everyone off".
 *   admin.accesscodes.js   the decisions behind the buttons — who a withdrawal
 *                          would actually affect, which buttons a code gets,
 *                          whether the bulk phrase matches.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures += 1;
  console.log(`  FAIL ${name}${extra !== undefined ? ` :: ${extra}` : ''}`);
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

/* ------------------------------------------------------------------ actions */

function loadActions() {
  const src = fs.readFileSync(path.join(ROOT, 'admin.actions.js'), 'utf8');
  const win = {};
  // eslint-disable-next-line no-new-func
  new Function('window', src)(win);
  if (typeof win.createAdminActions !== 'function') {
    // The module may attach under a namespace; find the factory either way.
    const found = Object.values(win).find((v) => typeof v?.createAdminActions === 'function');
    if (found) return found.createAdminActions;
    throw new Error('admin.actions.js did not expose createAdminActions');
  }
  return win.createAdminActions;
}

function actionsHarness() {
  const sent = [];
  const createAdminActions = loadActions();
  const actions = createAdminActions((path_, opts) => {
    sent.push({ path: path_, method: opts?.method || 'GET', body: opts?.body });
    return Promise.resolve({ ok: true });
  });
  return { actions, sent, last: () => sent[sent.length - 1] };
}

console.log('\n-- admin.actions.js request shapes --');
(async () => {
  const h = actionsHarness();

  await h.actions.revokeAccessToken('JOSEO-ABCD-EFGH');
  eq('plain revoke posts withdraw_access:false', h.last(), {
    path: '/admin/access_tokens/JOSEO-ABCD-EFGH/revoke',
    method: 'POST',
    body: { withdraw_access: false },
  });

  await h.actions.revokeAccessToken('JOSEO-ABCD-EFGH', { withdrawAccess: true });
  check('withdrawing revoke posts withdraw_access:true', h.last().body.withdraw_access === true,
    JSON.stringify(h.last().body));

  await h.actions.revokeAccessToken('JOSEO-ABCD-EFGH', {});
  check('an empty options object does not withdraw', h.last().body.withdraw_access === false,
    JSON.stringify(h.last().body));

  await h.actions.restoreAccessToken('JOSEO-ABCD-EFGH');
  eq('restore posts to /restore', h.last(), {
    path: '/admin/access_tokens/JOSEO-ABCD-EFGH/restore', method: 'POST', body: {},
  });

  await h.actions.listAccessTokenRedemptions('JOSEO-ABCD-EFGH');
  eq('redemptions is a GET', h.last(), {
    path: '/admin/access_tokens/JOSEO-ABCD-EFGH/redemptions', method: 'GET', body: undefined,
  });

  await h.actions.revokeAccessTokenRedemption('JOSEO-ABCD-EFGH', 42);
  eq('single-redeemer revoke targets the user', h.last(), {
    path: '/admin/access_tokens/JOSEO-ABCD-EFGH/redemptions/42/revoke', method: 'POST', body: {},
  });

  await h.actions.revokeAllAccessTokens();
  eq('bulk revoke sends the exact phrase and does not withdraw by default', h.last(), {
    path: '/admin/access_tokens/revoke_all',
    method: 'POST',
    body: { confirm: 'REVOKE ALL', withdraw_access: false },
  });

  await h.actions.revokeAllAccessTokens({ withdrawAccess: true });
  check('bulk revoke can withdraw', h.last().body.withdraw_access === true, JSON.stringify(h.last().body));

  // A code with characters that must not break out of the path.
  await h.actions.revokeAccessToken('JOSEO/../ADMIN');
  check('codes are percent-encoded into the path',
    h.last().path === '/admin/access_tokens/JOSEO%2F..%2FADMIN/revoke', h.last().path);

  /* ----------------------------------------------------------- decisions */

  console.log('\n-- admin.accesscodes.js decisions --');
  const codesSrc = fs.readFileSync(path.join(ROOT, 'admin.accesscodes.js'), 'utf8');
  const win = { AdminComponents: { esc: (s) => String(s), badge: () => '', formatDateTime: (s) => s } };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'navigator', 'CSS', 'confirm', 'alert', codesSrc)(
    win, { createRange: () => ({}) }, {}, { escape: (s) => s }, () => true, () => {}
  );
  const D = win.AdminAccessCodes?._decisions;
  check('module exposes its decisions', !!D);
  if (!D) { console.log(`\n${failures + 1} check(s) FAILED`); process.exit(1); }

  // withdrawalPlan -- the number the confirmation dialog is built from.
  const redemptions = [
    { user_id: 2, display_name: 'Bee', traces_to_code: true, comp_active: true },
    { user_id: 3, email: 'c@x.com', traces_to_code: false, comp_active: true },
    { user_id: 4, display_name: 'Dee', traces_to_code: true, comp_active: true },
    { user_id: 5, email: 'e@x.com', traces_to_code: false, comp_active: false },
  ];
  const plan = D.withdrawalPlan(redemptions);
  eq('withdrawalPlan counts only who would really lose access',
    [plan.total, plan.affected], [4, 2]);
  eq('withdrawalPlan names them', plan.names, ['Bee', 'Dee']);
  eq('withdrawalPlan on an empty list', [D.withdrawalPlan([]).total, D.withdrawalPlan([]).affected], [0, 0]);
  eq('withdrawalPlan tolerates a non-array', [D.withdrawalPlan(undefined).total, D.withdrawalPlan(null).affected], [0, 0]);
  check('withdrawalPlan falls back to the email when there is no name',
    D.withdrawalPlan([{ user_id: 9, email: 'z@x.com', traces_to_code: true }]).names[0] === 'z@x.com');
  check('withdrawalPlan falls back to the id when there is neither',
    D.withdrawalPlan([{ user_id: 9, traces_to_code: true }]).names[0] === 'user 9');

  // cardActions -- which buttons appear.
  eq('an unused active code offers no withdrawal',
    D.cardActions({ state: 'active', uses: 0 }), ['copy', 'revoke']);
  eq('a used active code offers withdrawal',
    D.cardActions({ state: 'active', uses: 2 }), ['copy', 'revoke', 'revoke-withdraw']);
  eq('a revoked code offers restore instead of revoke',
    D.cardActions({ state: 'revoked', uses: 0 }), ['copy', 'restore']);
  eq('a revoked-but-used code can still have its access withdrawn',
    D.cardActions({ state: 'revoked', uses: 1 }), ['copy', 'restore', 'revoke-withdraw']);
  eq('a used-up code keeps both revoke and withdrawal',
    D.cardActions({ state: 'used_up', uses: 1 }), ['copy', 'revoke', 'revoke-withdraw']);
  eq('an expired code keeps both too',
    D.cardActions({ state: 'expired', uses: 3 }), ['copy', 'revoke', 'revoke-withdraw']);
  eq('a token with no state at all is treated as active', D.cardActions({}), ['copy', 'revoke']);

  // redeemerRowMode -- a button only where it would do something.
  check('a redeemer whose access came from the code gets the button',
    D.redeemerRowMode({ traces_to_code: true, comp_active: true }) === 'removable');
  check('a redeemer with access from elsewhere is pointed at Comps',
    D.redeemerRowMode({ traces_to_code: false, comp_active: true }) === 'elsewhere');
  check('a redeemer with no access shows nothing to remove',
    D.redeemerRowMode({ traces_to_code: false, comp_active: false }) === 'none');
  check('an empty redeemer is not offered a dead button',
    D.redeemerRowMode({}) === 'none');

  // bulkConfirmAccepted -- the guard on the one control that hits everything.
  for (const good of ['REVOKE ALL', 'revoke all', '  Revoke All  ']) {
    check(`bulk phrase accepts ${JSON.stringify(good)}`, D.bulkConfirmAccepted(good) === true);
  }
  for (const bad of ['', ' ', 'revoke', 'REVOKEALL', 'REVOKE-ALL', 'delete all', 'revoke all codes', null, undefined]) {
    check(`bulk phrase rejects ${JSON.stringify(bad)}`, D.bulkConfirmAccepted(bad) === false);
  }
  check('the phrase the UI prints is the phrase it checks',
    D.bulkConfirmAccepted(win.AdminAccessCodes.BULK_CONFIRM_PHRASE) === true);

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
