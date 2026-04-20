(function () {
  function normComps(payload) {
    if (Array.isArray(payload?.items)) return payload.items;
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.comps)) return payload.comps;
    return [];
  }

  function formatCompExpiry(comp, c) {
    const expiresAt = comp?.subscription_comp_expires_at ?? comp?.comp_expires_at ?? comp?.expires_at;
    if (!expiresAt) return 'Forever';
    try {
      return c.formatDateTime(new Date(Number(expiresAt) * 1000).toISOString());
    } catch (_) {
      return '—';
    }
  }

  function daysRemaining(comp) {
    const expiresAt = comp?.subscription_comp_expires_at ?? comp?.comp_expires_at ?? comp?.expires_at;
    if (!expiresAt) return '∞';
    const nowSec = Math.floor(Date.now() / 1000);
    const diff = Number(expiresAt) - nowSec;
    if (diff <= 0) return 'expired';
    return String(Math.max(0, Math.floor(diff / 86400)));
  }

  async function loadAndRender(container, helpers, searchText) {
    const c = helpers?.components || window.AdminComponents;
    const actions = helpers?.actions;
    if (!actions?.listComps) {
      container.innerHTML = '<div class="adminError">Comp actions not available.</div>';
      return;
    }

    const listEl = container.querySelector('#adminCompsList');
    if (listEl) listEl.innerHTML = '<div class="adminMuted">Loading comps...</div>';

    try {
      const payload = await actions.listComps({ limit: 200, offset: 0, search: searchText });
      const comps = normComps(payload);
      if (!comps.length) {
        listEl.innerHTML = `<div class="adminEmpty">${searchText ? 'No comps matched your search.' : 'No active comps.'}</div>`;
        return;
      }

      listEl.innerHTML = comps.map((comp) => {
        const userId = comp?.user_id ?? comp?.id ?? '';
        const email = comp?.email || '—';
        const displayName = comp?.display_name || comp?.name || '—';
        const reason = comp?.subscription_comp_reason || comp?.comp_reason || comp?.reason || '—';
        const grantedAt = comp?.subscription_comp_granted_at || comp?.granted_at;
        const grantedAtText = grantedAt
          ? c.formatDateTime(new Date(Number(grantedAt) * 1000).toISOString())
          : '—';
        return `
          <article class="adminUserCard" data-comp-user-id="${c.esc(userId)}">
            <div class="adminRowBetween">
              <strong>${c.esc(displayName)}</strong>
              <span>${c.badge(`${daysRemaining(comp)} days left`, 'muted')}</span>
            </div>
            <div class="adminMuted">${c.esc(email)} • ID ${c.esc(userId)}</div>
            <div class="adminKV"><span>Reason</span><strong>${c.esc(reason)}</strong></div>
            <div class="adminKV"><span>Granted</span><strong>${c.esc(grantedAtText)}</strong></div>
            <div class="adminKV"><span>Expires</span><strong>${c.esc(formatCompExpiry(comp, c))}</strong></div>
            <div class="adminControlGrid">
              <button type="button" class="adminBtn dangerBtn" data-comps-action="revoke" data-user-id="${c.esc(userId)}">Revoke</button>
            </div>
          </article>
        `;
      }).join('');

      listEl.querySelectorAll('button[data-comps-action="revoke"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('Revoke this comp? User will revert to their underlying subscription state.')) return;
          btn.disabled = true;
          try {
            await actions.revokeComp(btn.dataset.userId);
            helpers?.onMutate?.();
            loadAndRender(container, helpers, searchText);
          } catch (err) {
            alert(`Revoke failed: ${err?.message || 'unknown error'}`);
            btn.disabled = false;
          }
        });
      });
    } catch (err) {
      listEl.innerHTML = `<div class="adminError">${c.esc(err?.message || 'Failed to load comps.')}</div>`;
    }
  }

  function renderAdminComps(container, _payload, helpers) {
    const c = helpers?.components || window.AdminComponents;
    container.innerHTML = `
      <div class="adminSection">
        <div class="adminSectionHead wrap">
          <h3>Active Comps</h3>
          <input id="adminCompsSearch" class="adminInput" type="search" placeholder="Search email, reason, or user" />
        </div>
        <div id="adminCompsList" class="adminList"></div>
      </div>
    `;

    const searchEl = container.querySelector('#adminCompsSearch');
    let searchTimer = 0;
    searchEl?.addEventListener('input', () => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => loadAndRender(container, helpers, searchEl.value), 300);
    });

    loadAndRender(container, helpers, '');
  }

  window.AdminComps = { renderAdminComps };
})();
