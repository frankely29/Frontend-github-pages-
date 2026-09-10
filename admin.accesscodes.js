/**
 * admin.accesscodes.js — mint and manage free-access codes.
 *
 * Comps and codes solve the same problem from opposite ends: a comp is granted
 * TO a user you can already look up, a code is handed to someone who redeems it
 * themselves. They live in separate tabs for that reason.
 *
 * Revocation is deliberately two separate decisions, because they are two
 * different intents:
 *
 *   Revoke                 stop the code being redeemed from now on
 *   Revoke + remove access ALSO take back what it already granted
 *
 * The second one is destructive and irreversible from here (Restore brings the
 * code back, never the access), so it always names the people it would affect
 * before doing anything.
 */
(function () {
  const STATE_TONES = {
    active: 'good',
    used_up: 'muted',
    expired: 'muted',
    revoked: 'danger',
  };

  const STATE_LABELS = {
    active: 'Active',
    used_up: 'Used up',
    expired: 'Expired',
    revoked: 'Revoked',
  };

  const BULK_CONFIRM_PHRASE = 'REVOKE ALL';

  function normTokens(payload) {
    if (Array.isArray(payload?.items)) return payload.items;
    if (Array.isArray(payload)) return payload;
    return [];
  }

  function fmtTs(ts, c) {
    if (!ts) return '—';
    try {
      return c.formatDateTime(new Date(Number(ts) * 1000).toISOString());
    } catch (_) {
      return '—';
    }
  }

  function accessLabel(token) {
    if (token?.grants_forever || token?.access_days === null || token?.access_days === undefined) {
      return 'Forever';
    }
    const days = Number(token.access_days);
    return days === 1 ? '1 day' : `${days} days`;
  }

  function redeemByLabel(token, c) {
    if (!token?.redeem_by) return 'No deadline';
    const nowSec = Math.floor(Date.now() / 1000);
    const diff = Number(token.redeem_by) - nowSec;
    if (diff <= 0) return `Expired ${fmtTs(token.redeem_by, c)}`;
    const days = Math.max(0, Math.floor(diff / 86400));
    return days === 0 ? 'Expires today' : `${days}d left (${fmtTs(token.redeem_by, c)})`;
  }

  function personLabel(item) {
    return item?.display_name || item?.email || `user ${item?.user_id}`;
  }

  function plural(n, one, many) {
    return Number(n) === 1 ? one : many;
  }

  function accessStateLabel(item, c) {
    if (!item?.comp_active) return 'no access';
    if (item.comp_is_forever) return 'access: forever';
    return `access until ${fmtTs(item.comp_expires_at, c)}`;
  }

  /* ------------------------------------------------------- decisions (pure)
   * These carry the safety-relevant judgements — which buttons a code gets,
   * who a withdrawal would actually cut off, whether the bulk phrase matches.
   * They are kept free of the DOM so they can be tested directly; getting any
   * of them wrong means either a dead button or an unasked-for revocation.
   */

  /** What a withdrawal on this code would really do, from a redemption list. */
  function withdrawalPlan(items) {
    const list = Array.isArray(items) ? items : [];
    const affected = list.filter((i) => !!i?.traces_to_code);
    return {
      total: list.length,
      affected: affected.length,
      names: affected.map(personLabel),
    };
  }

  /** Which action buttons a code row offers. */
  function cardActions(token) {
    const state = String(token?.state || 'active');
    const used = Number(token?.uses || 0);
    const actions = ['copy'];
    // A revoked code offers Restore in place of Revoke. Withdrawal stays
    // available on ANY state with redemptions: a used-up or expired code is
    // exactly where already-handed-out access lives.
    actions.push(state === 'revoked' ? 'restore' : 'revoke');
    if (used > 0) actions.push('revoke-withdraw');
    return actions;
  }

  /** How one redeemer row presents itself. */
  function redeemerRowMode(item) {
    if (item?.traces_to_code) return 'removable';
    return item?.comp_active ? 'elsewhere' : 'none';
  }

  function bulkConfirmAccepted(typed) {
    return String(typed || '').trim().toUpperCase() === BULK_CONFIRM_PHRASE;
  }

  /* ---------------------------------------------------------------- helpers */

  async function withBusyButton(btn, label, fn) {
    if (!btn) return fn();
    const restore = btn.textContent;
    btn.disabled = true;
    btn.textContent = label;
    try {
      return await fn();
    } finally {
      btn.disabled = false;
      btn.textContent = restore;
    }
  }

  /* ------------------------------------------------------------ redemptions */

  async function loadRedemptions(container, helpers, code, bodyEl) {
    const c = helpers?.components || window.AdminComponents;
    const actions = helpers?.actions;
    if (!actions?.listAccessTokenRedemptions) {
      bodyEl.innerHTML = '<div class="adminError">Redemption listing not available.</div>';
      return;
    }
    bodyEl.innerHTML = '<div class="adminMuted">Loading…</div>';
    try {
      const payload = await actions.listAccessTokenRedemptions(code);
      const items = normTokens(payload);
      if (!items.length) {
        bodyEl.innerHTML = '<div class="adminMuted">Nobody has redeemed this code yet.</div>';
        return;
      }
      bodyEl.innerHTML = items.map((item) => {
        // traces_to_code is the server's own withdrawal condition. Showing it
        // means "Remove access" is never a button that silently does nothing.
        const mode = redeemerRowMode(item);
        const removable = mode === 'removable';
        return `
          <div class="adminRedeemer">
            <div class="adminRedeemerWho">
              <strong>${c.esc(personLabel(item))}</strong>
              <span class="adminMuted">${c.esc(item?.email || '')}</span>
            </div>
            <div class="adminRedeemerMeta">
              <span>redeemed ${c.esc(fmtTs(item?.redeemed_at, c))}</span>
              <span>${c.esc(accessStateLabel(item, c))}</span>
            </div>
            ${removable
              ? `<button type="button" class="adminBtn dangerBtn" data-codes-action="revoke-one"
                         data-code="${c.esc(code)}" data-user-id="${c.esc(item.user_id)}"
                         data-who="${c.esc(personLabel(item))}">Remove access</button>`
              : `<span class="adminMuted adminRedeemerNote">${
                  mode === 'elsewhere'
                    ? 'access came from elsewhere — manage it in Comps'
                    : 'no access to remove'
                }</span>`}
          </div>
        `;
      }).join('');
    } catch (err) {
      bodyEl.innerHTML = `<div class="adminError">${c.esc(err?.message || 'Could not load redemptions.')}</div>`;
    }
  }

  /** How many people a withdrawal on this code would actually cut off. */
  async function countWithdrawable(actions, code) {
    return withdrawalPlan(normTokens(await actions.listAccessTokenRedemptions(code)));
  }

  /* ------------------------------------------------------------------- list */

  async function loadAndRender(container, helpers) {
    const c = helpers?.components || window.AdminComponents;
    const actions = helpers?.actions;
    const listEl = container.querySelector('#adminCodesList');
    if (!listEl) return;

    if (!actions?.listAccessTokens) {
      listEl.innerHTML = '<div class="adminError">Access-code actions not available.</div>';
      return;
    }

    listEl.innerHTML = '<div class="adminMuted">Loading codes...</div>';
    const showInactive = !!container.querySelector('#adminCodesShowInactive')?.checked;

    try {
      const payload = await actions.listAccessTokens({ limit: 200, includeInactive: showInactive });
      const tokens = normTokens(payload);
      if (!tokens.length) {
        listEl.innerHTML = `<div class="adminEmpty">${
          showInactive ? 'No access codes yet.' : 'No active codes.'
        }</div>`;
        return;
      }

      listEl.innerHTML = tokens.map((token) => {
        const code = String(token?.code || '');
        const state = String(token?.state || 'active');
        const tone = STATE_TONES[state] || 'muted';
        const used = Number(token?.uses || 0);
        const uses = `${used} / ${Number(token?.max_uses || 1)}`;
        const available = cardActions(token);
        const isRevoked = available.includes('restore');
        return `
          <article class="adminUserCard" data-code="${c.esc(code)}">
            <div class="adminRowBetween">
              <strong class="adminCodeValue">${c.esc(code || '—')}</strong>
              <span>${c.badge(STATE_LABELS[state] || state, tone)}</span>
            </div>
            <div class="adminKV"><span>Grants</span><strong>${c.esc(accessLabel(token))}</strong></div>
            <div class="adminKV"><span>Redeemable</span><strong>${c.esc(redeemByLabel(token, c))}</strong></div>
            <div class="adminKV"><span>Used</span><strong>${c.esc(uses)}</strong></div>
            <div class="adminKV"><span>Created</span><strong>${c.esc(fmtTs(token?.created_at, c))}</strong></div>
            ${isRevoked
              ? `<div class="adminKV"><span>Revoked</span><strong>${c.esc(fmtTs(token?.revoked_at, c))}</strong></div>`
              : ''}
            ${token?.note ? `<div class="adminKV"><span>Note</span><strong>${c.esc(token.note)}</strong></div>` : ''}
            ${used > 0
              ? `<details class="adminDetails adminRedeemers" data-code="${c.esc(code)}">
                   <summary>Who used it (${used})</summary>
                   <div class="adminDetailsBody" data-codes-redeemers="${c.esc(code)}"></div>
                 </details>`
              : ''}
            <div class="adminControlGrid">
              <button type="button" class="adminBtn" data-codes-action="copy"
                      data-code="${c.esc(code)}">Copy code</button>
              ${isRevoked
                ? `<button type="button" class="adminBtn" data-codes-action="restore"
                           data-code="${c.esc(code)}">Restore code</button>`
                : `<button type="button" class="adminBtn dangerBtn" data-codes-action="revoke"
                           data-code="${c.esc(code)}">Revoke</button>`}
              ${available.includes('revoke-withdraw')
                ? `<button type="button" class="adminBtn dangerBtn" data-codes-action="revoke-withdraw"
                           data-code="${c.esc(code)}">Revoke + remove access</button>`
                : ''}
            </div>
          </article>
        `;
      }).join('');
    } catch (err) {
      listEl.innerHTML = `<div class="adminError">${c.esc(err?.message || 'Failed to load access codes.')}</div>`;
    }
  }

  /* ---------------------------------------------------------------- actions */

  async function doCopy(container, btn) {
    const code = btn.dataset.code || '';
    const restore = btn.textContent;
    try {
      await navigator.clipboard.writeText(code);
      btn.textContent = 'Copied';
    } catch (_) {
      // Clipboard is blocked in plenty of contexts (insecure origin, denied
      // permission). Select the code instead so it can still be copied by
      // hand rather than leaving the button looking broken.
      const el = container.querySelector(`.adminUserCard[data-code="${CSS.escape(code)}"] .adminCodeValue`);
      if (el && window.getSelection) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      btn.textContent = 'Select + copy';
    }
    window.setTimeout(() => { btn.textContent = restore; }, 1600);
  }

  async function doRevoke(container, helpers, btn) {
    const code = btn.dataset.code || '';
    if (!confirm(
      `Revoke ${code}?\n\nIt can no longer be redeemed. Anyone who already ` +
      `redeemed it KEEPS their access — use "Revoke + remove access" if you ` +
      `want that taken back too.\n\nYou can undo this with Restore.`
    )) return;
    await withBusyButton(btn, 'Revoking…', async () => {
      await helpers.actions.revokeAccessToken(code);
      helpers?.onMutate?.();
      await loadAndRender(container, helpers);
    });
  }

  async function doRevokeAndWithdraw(container, helpers, btn) {
    const code = btn.dataset.code || '';
    const actions = helpers.actions;

    let who;
    try {
      who = await withBusyButton(btn, 'Checking…', () => countWithdrawable(actions, code));
    } catch (err) {
      alert(`Could not check who redeemed ${code}: ${err?.message || 'unknown error'}`);
      return;
    }

    if (!who.affected) {
      alert(
        `Nobody would lose access.\n\n${who.total} ${plural(who.total, 'person', 'people')} redeemed ` +
        `${code}, but none of them are currently getting their access from it.\n\n` +
        `Use plain Revoke to stop the code being redeemed.`
      );
      return;
    }

    const names = who.names.slice(0, 8).join('\n  ');
    const more = who.names.length > 8 ? `\n  …and ${who.names.length - 8} more` : '';
    if (!confirm(
      `Revoke ${code} AND remove access from ${who.affected} ` +
      `${plural(who.affected, 'person', 'people')}?\n\n  ${names}${more}\n\n` +
      `They lose access immediately. This cannot be undone from here — ` +
      `Restore brings the code back, not the access.\n\n` +
      `Anyone who also pays keeps their paid subscription.`
    )) return;

    await withBusyButton(btn, 'Removing…', async () => {
      const result = await actions.revokeAccessToken(code, { withdrawAccess: true });
      helpers?.onMutate?.();
      await loadAndRender(container, helpers);
      const n = Number(result?.withdrawn_count ?? who.affected);
      alert(`${code} revoked. Removed access from ${n} ${plural(n, 'person', 'people')}.`);
    });
  }

  async function doRestore(container, helpers, btn) {
    const code = btn.dataset.code || '';
    if (!confirm(`Restore ${code} so it can be redeemed again?\n\nThis does not give back any access that was removed.`)) return;
    await withBusyButton(btn, 'Restoring…', async () => {
      const result = await helpers.actions.restoreAccessToken(code);
      helpers?.onMutate?.();
      await loadAndRender(container, helpers);
      // A restored code can still be used up or past its redeem-by, so say what
      // it actually is now rather than implying it works again.
      const state = String(result?.state || 'active');
      if (state !== 'active') {
        alert(`${code} is no longer revoked, but it is ${STATE_LABELS[state] || state} so it still cannot be redeemed.`);
      }
    });
  }

  async function doRevokeOne(container, helpers, btn) {
    const code = btn.dataset.code || '';
    const userId = btn.dataset.userId || '';
    const who = btn.dataset.who || `user ${userId}`;
    if (!confirm(
      `Remove ${who}'s access?\n\nThe code stays usable for everyone else. ` +
      `If they also pay, their paid subscription is untouched.`
    )) return;
    await withBusyButton(btn, 'Removing…', async () => {
      await helpers.actions.revokeAccessTokenRedemption(code, userId);
      helpers?.onMutate?.();
      const bodyEl = container.querySelector(`[data-codes-redeemers="${CSS.escape(code)}"]`);
      if (bodyEl) await loadRedemptions(container, helpers, code, bodyEl);
    });
  }

  async function doRevokeAll(container, helpers) {
    const btn = container.querySelector('#adminCodesRevokeAllBtn');
    const withdraw = !!container.querySelector('#adminCodesRevokeAllWithdraw')?.checked;
    const resultEl = container.querySelector('#adminCodesBulkResult');
    const typed = String(container.querySelector('#adminCodesRevokeAllConfirm')?.value || '').trim();

    if (!bulkConfirmAccepted(typed)) {
      resultEl.innerHTML = `<div class="adminError">Type ${BULK_CONFIRM_PHRASE} to confirm.</div>`;
      return;
    }
    if (!confirm(
      `Revoke EVERY code that can still be redeemed?` +
      (withdraw
        ? `\n\nAnd remove access from everyone who ever redeemed any code — ` +
          `including codes that are already used up or expired. This cannot be undone.`
        : `\n\nAccess already granted is kept.`)
    )) return;

    resultEl.innerHTML = '<div class="adminMuted">Working…</div>';
    await withBusyButton(btn, 'Revoking…', async () => {
      try {
        const out = await helpers.actions.revokeAllAccessTokens({ withdrawAccess: withdraw });
        const revoked = Number(out?.revoked_count || 0);
        const withdrawn = Number(out?.withdrawn_count || 0);
        resultEl.innerHTML = `<div class="adminCodeResult">Revoked ${revoked} ${
          plural(revoked, 'code', 'codes')
        }${withdraw ? `, removed access from ${withdrawn} ${plural(withdrawn, 'person', 'people')}` : ''}.</div>`;
        const confirmEl = container.querySelector('#adminCodesRevokeAllConfirm');
        if (confirmEl) confirmEl.value = '';
        helpers?.onMutate?.();
        await loadAndRender(container, helpers);
      } catch (err) {
        const c = helpers?.components || window.AdminComponents;
        resultEl.innerHTML = `<div class="adminError">${c.esc(err?.message || 'Bulk revoke failed.')}</div>`;
      }
    });
  }

  /* ----------------------------------------------------------------- create */

  async function handleCreate(container, helpers) {
    const c = helpers?.components || window.AdminComponents;
    const actions = helpers?.actions;
    const resultEl = container.querySelector('#adminCodesCreateResult');
    const btn = container.querySelector('#adminCodesCreateBtn');

    const forever = !!container.querySelector('#adminCodesForever')?.checked;
    const accessDays = container.querySelector('#adminCodesAccessDays')?.value;
    const redeemByDays = container.querySelector('#adminCodesRedeemBy')?.value;
    const maxUses = container.querySelector('#adminCodesMaxUses')?.value || '1';
    const note = container.querySelector('#adminCodesNote')?.value || '';

    if (!forever && (!accessDays || Number(accessDays) <= 0)) {
      resultEl.innerHTML = '<div class="adminError">Enter how many days of access, or tick Forever.</div>';
      return;
    }

    btn.disabled = true;
    const restore = btn.textContent;
    btn.textContent = 'Creating…';
    resultEl.innerHTML = '<div class="adminMuted">Creating code…</div>';

    try {
      const created = await actions.createAccessToken({
        accessDays: forever ? null : accessDays,
        redeemByDays,
        maxUses,
        note,
      });
      const code = created?.code || '';
      resultEl.innerHTML = `
        <div class="adminCodeResult">
          <div class="adminMuted">New code — give this to the driver:</div>
          <div class="adminCodeBig" id="adminCodesNewValue">${c.esc(code)}</div>
          <div class="adminMuted">
            Grants ${c.esc(accessLabel(created))} •
            ${c.esc(created?.max_uses > 1 ? `${created.max_uses} uses` : 'single use')}
          </div>
          <button type="button" class="adminBtn" id="adminCodesCopyNew">Copy code</button>
        </div>
      `;
      container.querySelector('#adminCodesCopyNew')?.addEventListener('click', async (ev) => {
        try {
          await navigator.clipboard.writeText(code);
          ev.target.textContent = 'Copied';
        } catch (_) {
          ev.target.textContent = 'Copy blocked — select it above';
        }
      });
      const noteEl = container.querySelector('#adminCodesNote');
      if (noteEl) noteEl.value = '';
      helpers?.onMutate?.();
      loadAndRender(container, helpers);
    } catch (err) {
      resultEl.innerHTML = `<div class="adminError">${c.esc(err?.message || 'Could not create the code.')}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = restore;
    }
  }

  /* ----------------------------------------------------------------- render */

  function renderAdminAccessCodes(container, _payload, helpers) {
    container.innerHTML = `
      <div class="adminSection adminSectionWrap">
        <div class="adminSectionHead wrap">
          <h3>Create a free access code</h3>
        </div>
        <div class="adminCodesForm">
          <label class="adminField">
            <span>Days of access</span>
            <input id="adminCodesAccessDays" class="adminInput" type="number" min="1" max="3650"
                   value="30" inputmode="numeric" />
          </label>
          <label class="adminCheckRow">
            <input id="adminCodesForever" type="checkbox" />
            <span>Forever (no expiry)</span>
          </label>
          <label class="adminField">
            <span>Code must be used within (days)</span>
            <input id="adminCodesRedeemBy" class="adminInput" type="number" min="1" max="3650"
                   placeholder="optional" inputmode="numeric" />
          </label>
          <label class="adminField">
            <span>How many people can use it</span>
            <input id="adminCodesMaxUses" class="adminInput" type="number" min="1" max="10000"
                   value="1" inputmode="numeric" />
          </label>
          <label class="adminField adminFieldWide">
            <span>Note (who is it for?)</span>
            <input id="adminCodesNote" class="adminInput" type="text" maxlength="200"
                   placeholder="e.g. Marcus — referral" />
          </label>
          <div class="adminFieldWide">
            <button type="button" class="adminBtn primaryBtn" id="adminCodesCreateBtn">Create code</button>
          </div>
        </div>
        <div id="adminCodesCreateResult"></div>
      </div>

      <div class="adminSection adminSectionWrap">
        <div class="adminSectionHead wrap">
          <h3>Issued codes</h3>
          <label class="adminCheckRow">
            <input id="adminCodesShowInactive" type="checkbox" checked />
            <span>Include used / expired / revoked</span>
          </label>
        </div>
        <div id="adminCodesList" class="adminList"></div>
      </div>

      <div class="adminSection adminSectionWrap adminDangerZone">
        <div class="adminSectionHead wrap">
          <h3>Revoke everything</h3>
        </div>
        <div class="adminMuted">
          Revokes every code that can still be redeemed. Tick the box to also take
          back access already granted — that reaches used-up and expired codes too,
          since those are where handed-out access actually lives.
        </div>
        <label class="adminCheckRow">
          <input id="adminCodesRevokeAllWithdraw" type="checkbox" />
          <span>Also remove access from everyone who redeemed a code</span>
        </label>
        <div class="adminCodesForm">
          <label class="adminField">
            <span>Type ${BULK_CONFIRM_PHRASE} to confirm</span>
            <input id="adminCodesRevokeAllConfirm" class="adminInput" type="text"
                   autocomplete="off" placeholder="${BULK_CONFIRM_PHRASE}" />
          </label>
          <div>
            <button type="button" class="adminBtn dangerBtn" id="adminCodesRevokeAllBtn">Revoke all codes</button>
          </div>
        </div>
        <div id="adminCodesBulkResult"></div>
      </div>
    `;

    // "Forever" and a day count are mutually exclusive; disabling the field
    // makes that obvious instead of silently ignoring whatever is typed in it.
    const foreverEl = container.querySelector('#adminCodesForever');
    const daysEl = container.querySelector('#adminCodesAccessDays');
    foreverEl?.addEventListener('change', () => {
      if (daysEl) daysEl.disabled = !!foreverEl.checked;
    });

    container.querySelector('#adminCodesCreateBtn')
      ?.addEventListener('click', () => handleCreate(container, helpers));
    container.querySelector('#adminCodesShowInactive')
      ?.addEventListener('change', () => loadAndRender(container, helpers));
    container.querySelector('#adminCodesRevokeAllBtn')
      ?.addEventListener('click', () => doRevokeAll(container, helpers));

    // Delegated, so the list can be re-rendered as often as it likes without
    // leaking a listener per row on every refresh.
    const HANDLERS = {
      copy: (btn) => doCopy(container, btn),
      revoke: (btn) => doRevoke(container, helpers, btn),
      'revoke-withdraw': (btn) => doRevokeAndWithdraw(container, helpers, btn),
      restore: (btn) => doRestore(container, helpers, btn),
      'revoke-one': (btn) => doRevokeOne(container, helpers, btn),
    };
    const onClick = (ev) => {
      const btn = ev.target?.closest?.('button[data-codes-action]');
      if (!btn || !container.contains(btn)) return;
      const handler = HANDLERS[btn.dataset.codesAction];
      if (handler) handler(btn);
    };

    // Redeemers are fetched when the row is opened, not for every code up
    // front: one request per code would make the list unusable at 200 codes.
    const onToggle = (ev) => {
      const details = ev.target;
      if (!details?.classList?.contains?.('adminRedeemers') || !details.open) return;
      const code = details.dataset.code || '';
      const bodyEl = details.querySelector('[data-codes-redeemers]');
      if (bodyEl && !bodyEl.dataset.loaded) {
        bodyEl.dataset.loaded = '1';
        loadRedemptions(container, helpers, code, bodyEl);
      }
    };

    container.addEventListener('click', onClick);
    container.addEventListener('toggle', onToggle, true);
    // The panel reuses one body element for every tab, so leaving these
    // attached would stack another pair each time the tab is reopened — and a
    // single Revoke click would then raise one confirm per visit.
    helpers?.registerCleanup?.(() => {
      container.removeEventListener('click', onClick);
      container.removeEventListener('toggle', onToggle, true);
    });

    loadAndRender(container, helpers);
  }

  window.AdminAccessCodes = {
    renderAdminAccessCodes,
    BULK_CONFIRM_PHRASE,
    // Exposed for tests: the decisions above are where a mistake becomes an
    // unasked-for revocation or a button that does nothing.
    _decisions: { withdrawalPlan, cardActions, redeemerRowMode, bulkConfirmAccepted },
  };
})();
