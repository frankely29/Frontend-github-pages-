/**
 * admin.accesscodes.js — mint and manage free-access codes.
 *
 * Comps and codes solve the same problem from opposite ends: a comp is granted
 * TO a user you can already look up, a code is handed to someone who redeems it
 * themselves. They live in separate tabs for that reason.
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
        const state = String(token?.state || 'active');
        const tone = STATE_TONES[state] || 'muted';
        const uses = `${Number(token?.uses || 0)} / ${Number(token?.max_uses || 1)}`;
        return `
          <article class="adminUserCard" data-code="${c.esc(token?.code || '')}">
            <div class="adminRowBetween">
              <strong class="adminCodeValue">${c.esc(token?.code || '—')}</strong>
              <span>${c.badge(STATE_LABELS[state] || state, tone)}</span>
            </div>
            <div class="adminKV"><span>Grants</span><strong>${c.esc(accessLabel(token))}</strong></div>
            <div class="adminKV"><span>Redeemable</span><strong>${c.esc(redeemByLabel(token, c))}</strong></div>
            <div class="adminKV"><span>Used</span><strong>${c.esc(uses)}</strong></div>
            <div class="adminKV"><span>Created</span><strong>${c.esc(fmtTs(token?.created_at, c))}</strong></div>
            ${token?.note ? `<div class="adminKV"><span>Note</span><strong>${c.esc(token.note)}</strong></div>` : ''}
            <div class="adminControlGrid">
              <button type="button" class="adminBtn" data-codes-action="copy"
                      data-code="${c.esc(token?.code || '')}">Copy code</button>
              ${state === 'active'
                ? `<button type="button" class="adminBtn dangerBtn" data-codes-action="revoke"
                           data-code="${c.esc(token?.code || '')}">Revoke</button>`
                : ''}
            </div>
          </article>
        `;
      }).join('');

      wireRowActions(container, helpers, listEl);
    } catch (err) {
      listEl.innerHTML = `<div class="adminError">${c.esc(err?.message || 'Failed to load access codes.')}</div>`;
    }
  }

  function wireRowActions(container, helpers, listEl) {
    const actions = helpers?.actions;

    listEl.querySelectorAll('button[data-codes-action="copy"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
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
      });
    });

    listEl.querySelectorAll('button[data-codes-action="revoke"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const code = btn.dataset.code || '';
        if (!confirm(
          `Revoke ${code}?\n\nIt can no longer be redeemed. Anyone who already ` +
          `redeemed it keeps their access — remove that individually from Comps.`
        )) return;
        btn.disabled = true;
        try {
          await actions.revokeAccessToken(code);
          helpers?.onMutate?.();
          loadAndRender(btn.closest('.adminSectionWrap') || document, helpers);
        } catch (err) {
          alert(`Revoke failed: ${err?.message || 'unknown error'}`);
          btn.disabled = false;
        }
      });
    });
  }

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

    loadAndRender(container, helpers);
  }

  window.AdminAccessCodes = { renderAdminAccessCodes };
})();
