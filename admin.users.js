(function () {
  function normUsers(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.users)) return payload.users;
    if (Array.isArray(payload?.rows)) return payload.rows;
    return [];
  }

  function renderAdminUsers(container, payload, helpers) {
    const c = helpers?.components || window.AdminComponents;
    const actions = helpers?.actions;
    const users = normUsers(payload).map((u) => ({ ...u }));

    container.innerHTML = `
      <div class="adminSection">
        <div class="adminSectionHead wrap">
          <h3>Users</h3>
          <input id="adminUsersSearch" class="adminInput" type="search" placeholder="Search email, name, or id" />
        </div>
        <div class="adminMuted">${users.length} users</div>
        <div id="adminUsersList" class="adminList"></div>
      </div>
    `;

    const searchEl = container.querySelector('#adminUsersSearch');
    const listEl = container.querySelector('#adminUsersList');

    function findUser(id) {
      return users.find((row) => String(row.id) === String(id));
    }

    async function toggleAdmin(userId, nextValue) {
      if (!actions) return;
      await actions.setUserAdmin(userId, nextValue);
      const row = findUser(userId);
      if (row) row.is_admin = nextValue;
      helpers?.onMutate?.();
      draw(searchEl?.value || '');
    }

    async function toggleSuspended(userId, nextValue) {
      if (!actions) return;
      await actions.setUserSuspended(userId, nextValue);
      const row = findUser(userId);
      if (row) row.is_suspended = nextValue;
      helpers?.onMutate?.();
      draw(searchEl?.value || '');
    }

    async function viewDetail(userId, target) {
      const row = findUser(userId);
      if (!row || !target) return;
      target.innerHTML = '<div class="adminMuted">Loading detail...</div>';
      try {
        const detail = await actions.fetchUserDetail(userId);
        target.innerHTML = `
          <div class="adminCard compact">
            ${c.keyValueRows(detail || row)}
            ${c.collapsible('Raw JSON', `<pre class="adminPre">${c.esc(JSON.stringify(detail || row, null, 2))}</pre>`)}
          </div>
        `;
      } catch (err) {
        target.innerHTML = `<div class="adminError">${c.esc(err?.message || 'Failed to load user detail')}</div>`;
      }
    }

    function draw(filterRaw) {
      const filter = String(filterRaw || '').trim().toLowerCase();
      const rows = users.filter((u) => {
        if (!filter) return true;
        const blob = [u?.id, u?.email, u?.display_name, u?.name].map((x) => String(x ?? '').toLowerCase()).join(' ');
        return blob.includes(filter);
      });

      if (!rows.length) {
        listEl.innerHTML = '<div class="adminEmpty">No users matched your filter.</div>';
        return;
      }

      listEl.innerHTML = rows.map((u) => `
        <article class="adminUserCard" data-user-id="${c.esc(u?.id ?? '')}">
          <div class="adminRowBetween">
            <strong>${c.esc(u?.display_name || u?.name || 'Unnamed User')}</strong>
            <div class="adminRow">${c.boolBadge(!!u?.is_admin, 'Admin', 'User')} ${c.boolBadge(!u?.is_suspended, 'Active', 'Suspended')}</div>
          </div>
          <div class="adminMuted">${c.esc(u?.email || '—')} • ID ${c.esc(u?.id || '—')}</div>
          <div class="adminRow wrap">
            <span>${c.badge(u?.ghost_mode ? 'Ghost ON' : 'Ghost OFF', u?.ghost_mode ? 'warn' : 'muted')}</span>
            <span>${c.badge(u?.avatar_url ? 'Avatar Set' : 'No Avatar', u?.avatar_url ? 'yes' : 'muted')}</span>
            <span>${c.badge(`Created ${c.formatDateTime(u?.created_at)}`, 'muted')}</span>
          </div>
          <div class="adminControlGrid">
            <button type="button" class="adminToggleBtn" data-action="toggle-admin" data-user-id="${c.esc(u?.id || '')}" data-next="${(!u?.is_admin).toString()}">Admin: ${u?.is_admin ? 'ON' : 'OFF'}</button>
            <button type="button" class="adminToggleBtn" data-action="toggle-suspended" data-user-id="${c.esc(u?.id || '')}" data-next="${(!u?.is_suspended).toString()}">Suspended: ${u?.is_suspended ? 'ON' : 'OFF'}</button>
            <button type="button" class="adminBtn" data-action="view-detail" data-user-id="${c.esc(u?.id || '')}">View Details</button>
          </div>
          <div class="adminUserDetail" data-detail-for="${c.esc(u?.id || '')}" hidden></div>
        </article>
      `).join('');

      listEl.querySelectorAll('button[data-action="toggle-admin"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try { await toggleAdmin(btn.dataset.userId, btn.dataset.next === 'true'); } finally { btn.disabled = false; }
        });
      });

      listEl.querySelectorAll('button[data-action="toggle-suspended"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try { await toggleSuspended(btn.dataset.userId, btn.dataset.next === 'true'); } finally { btn.disabled = false; }
        });
      });

      listEl.querySelectorAll('button[data-action="view-detail"]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const detail = listEl.querySelector(`[data-detail-for="${btn.dataset.userId}"]`);
          const hidden = detail?.hasAttribute('hidden');
          if (!detail) return;
          if (!hidden) {
            detail.setAttribute('hidden', 'hidden');
            return;
          }
          detail.removeAttribute('hidden');
          viewDetail(btn.dataset.userId, detail);
        });
      });
    }

    searchEl?.addEventListener('input', () => draw(searchEl.value));
    draw('');
  }

  window.AdminUsers = { renderAdminUsers };
})();
