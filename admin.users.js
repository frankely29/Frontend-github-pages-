(function () {
  function normUsers(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.users)) return payload.users;
    if (Array.isArray(payload?.items)) return payload.items;
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.rows)) return payload.rows;
    return [];
  }

  function toBool(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
      if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === '') return false;
    }
    return !!value;
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
      const trimmedFilter = String(filterRaw ?? '').trim();
      const filter = trimmedFilter ? trimmedFilter.toLowerCase() : '';
      const rows = filter
        ? users.filter((u) => {
          const id = String(u?.id ?? '').toLowerCase();
          const email = String(u?.email ?? '').toLowerCase();
          const displayName = String(u?.display_name ?? u?.displayName ?? '').toLowerCase();
          const name = String(u?.name ?? '').toLowerCase();
          return id.includes(filter) || email.includes(filter) || displayName.includes(filter) || name.includes(filter);
        })
        : users;

      if (!rows.length) {
        listEl.innerHTML = `<div class="adminEmpty">${filter ? 'No users matched your filter.' : 'No users found.'}</div>`;
        return;
      }

      listEl.innerHTML = rows.map((u) => {
        const isAdmin = toBool(u?.is_admin);
        const isSuspended = toBool(u?.is_suspended);
        const userId = u?.id ?? '';
        return `
        <article class="adminUserCard" data-user-id="${c.esc(userId)}">
          <div class="adminRowBetween">
            <strong>${c.esc(u?.display_name || u?.displayName || u?.name || 'Unnamed User')}</strong>
            <div class="adminRow">${c.boolBadge(isAdmin, 'Admin', 'User')} ${c.boolBadge(!isSuspended, 'Active', 'Suspended')}</div>
          </div>
          <div class="adminMuted">${c.esc(u?.email || '—')} • ID ${c.esc(userId || '—')}</div>
          <div class="adminRow wrap">
            <span>${c.badge(toBool(u?.ghost_mode) ? 'Ghost ON' : 'Ghost OFF', toBool(u?.ghost_mode) ? 'warn' : 'muted')}</span>
            <span>${c.badge(u?.avatar_url ? 'Avatar Set' : 'No Avatar', u?.avatar_url ? 'yes' : 'muted')}</span>
            <span>${c.badge(`Created ${c.formatDateTime(u?.created_at)}`, 'muted')}</span>
          </div>
          <div class="adminControlGrid">
            <button type="button" class="adminToggleBtn${isAdmin ? ' active' : ''}" data-action="toggle-admin" data-user-id="${c.esc(userId)}" data-next="${(!isAdmin).toString()}">Admin: ${isAdmin ? 'ON' : 'OFF'}</button>
            <button type="button" class="adminToggleBtn${isSuspended ? ' active' : ''}" data-action="toggle-suspended" data-user-id="${c.esc(userId)}" data-next="${(!isSuspended).toString()}">Suspended: ${isSuspended ? 'ON' : 'OFF'}</button>
            <button type="button" class="adminBtn" data-action="view-detail" data-user-id="${c.esc(userId)}">View Details</button>
          </div>
          <div class="adminUserDetail" data-detail-for="${c.esc(userId)}" hidden></div>
        </article>
      `;
      }).join('');

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
