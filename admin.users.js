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

  function openCompModal({ mode, userId, onDone }) {
    const actions = window.AdminActions?.createAdminActions
      ? null // resolved via helpers in caller
      : null;

    // Remove any existing modal
    document.querySelectorAll('.adminCompModalBackdrop').forEach((el) => el.remove());

    const isGrant = mode === 'grant';
    const title = isGrant ? 'Grant Free Access' : 'Extend Free Access';
    const showReason = isGrant;

    const backdrop = document.createElement('div');
    backdrop.className = 'adminCompModalBackdrop';
    backdrop.innerHTML = `
      <div class="adminCompModalCard">
        <h3 style="margin-top:0;">${title}</h3>
        <label style="display:block;margin:8px 0 4px;">Duration unit</label>
        <select class="adminInput" data-comp-field="duration_unit">
          <option value="hours">Hours</option>
          <option value="days" selected>Days</option>
          <option value="weeks">Weeks</option>
          <option value="forever">Forever</option>
        </select>
        <label style="display:block;margin:8px 0 4px;">Duration value</label>
        <input type="number" min="1" value="30" class="adminInput" data-comp-field="duration_value" />
        ${showReason ? `
          <label style="display:block;margin:8px 0 4px;">Reason (required, min 3 chars)</label>
          <textarea rows="3" class="adminInput" data-comp-field="reason" placeholder="e.g. launch grandfather, VIP partner"></textarea>
        ` : ''}
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px;">
          <button type="button" class="adminBtn" data-comp-action="cancel">Cancel</button>
          <button type="button" class="adminBtn primaryBtn" data-comp-action="submit">${isGrant ? 'Grant' : 'Extend'}</button>
        </div>
      </div>
    `;
    backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;';
    const card = backdrop.querySelector('.adminCompModalCard');
    card.style.cssText = 'background:#fff;padding:20px;border-radius:12px;min-width:320px;max-width:90vw;';
    document.body.appendChild(backdrop);

    const unitSelect = backdrop.querySelector('[data-comp-field="duration_unit"]');
    const valueInput = backdrop.querySelector('[data-comp-field="duration_value"]');
    const reasonInput = backdrop.querySelector('[data-comp-field="reason"]');

    unitSelect.addEventListener('change', () => {
      const isForever = unitSelect.value === 'forever';
      valueInput.disabled = isForever;
      if (isForever) valueInput.value = '0';
      else if (valueInput.value === '0') valueInput.value = '30';
    });

    backdrop.querySelector('[data-comp-action="cancel"]').addEventListener('click', () => backdrop.remove());
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) backdrop.remove();
    });

    backdrop.querySelector('[data-comp-action="submit"]').addEventListener('click', async () => {
      const actionsObj = window.__AdminUsersActionsRef;
      if (!actionsObj) {
        alert('Admin actions not available.');
        return;
      }
      const unit = unitSelect.value;
      const value = Number(valueInput.value || 0);
      const reason = reasonInput ? String(reasonInput.value || '').trim() : '';

      if (isGrant && reason.length < 3) {
        alert('Reason is required (min 3 characters).');
        return;
      }
      if (unit !== 'forever' && (!Number.isFinite(value) || value < 1)) {
        alert('Duration value must be at least 1.');
        return;
      }

      const submitBtn = backdrop.querySelector('[data-comp-action="submit"]');
      submitBtn.disabled = true;
      try {
        if (isGrant) {
          await actionsObj.grantComp(userId, unit, value, reason);
        } else {
          await actionsObj.extendComp(userId, unit, value);
        }
        backdrop.remove();
        onDone?.();
      } catch (err) {
        alert(`Action failed: ${err?.message || 'unknown error'}`);
        submitBtn.disabled = false;
      }
    });
  }

  function renderAdminUsers(container, payload, helpers) {
    const c = helpers?.components || window.AdminComponents;
    const actions = helpers?.actions;
    window.__AdminUsersActionsRef = actions; // expose for modal to use
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
        const record = detail || row;
        const hasPickupCount = record?.pickup_count !== undefined && record?.pickup_count !== null;
        const hasVoidedPickupCount = record?.voided_pickup_count !== undefined && record?.voided_pickup_count !== null;
        const pickupSummary = (hasPickupCount || hasVoidedPickupCount)
          ? `
            <div class="adminKV"><span>Active pickup logs</span><strong>${c.esc(hasPickupCount ? record.pickup_count : '—')}</strong></div>
            <div class="adminKV"><span>Voided pickup logs</span><strong>${c.esc(hasVoidedPickupCount ? record.voided_pickup_count : '—')}</strong></div>
          `
          : '';

        const subStatus = String(record?.subscription_status || '').toLowerCase();
        const compReason = record?.subscription_comp_reason || '';
        const compExpiresAt = record?.subscription_comp_expires_at;
        const isCompForever = subStatus === 'comp' && !compExpiresAt;
        const compExpiryText = isCompForever
          ? 'Forever'
          : compExpiresAt
            ? c.formatDateTime(new Date(Number(compExpiresAt) * 1000).toISOString())
            : '—';
        const hasActiveComp = subStatus === 'comp';

        const compSectionHtml = hasActiveComp
          ? `
            <div class="adminCompSection">
              <div class="adminKV"><span>Free access</span><strong>${c.esc(compReason || '—')}</strong></div>
              <div class="adminKV"><span>Expires</span><strong>${c.esc(compExpiryText)}</strong></div>
              <div class="adminControlGrid">
                <button type="button" class="adminBtn" data-comp-action="extend" data-user-id="${c.esc(userId)}">Extend</button>
                <button type="button" class="adminBtn dangerBtn" data-comp-action="revoke" data-user-id="${c.esc(userId)}">Revoke</button>
              </div>
            </div>
          `
          : `
            <div class="adminCompSection">
              <div class="adminMuted">No active comp.</div>
              <div class="adminControlGrid">
                <button type="button" class="adminBtn" data-comp-action="grant" data-user-id="${c.esc(userId)}">Grant Free Access</button>
              </div>
            </div>
          `;

        target.innerHTML = `
          <div class="adminCard compact">
            ${pickupSummary}
            ${compSectionHtml}
            ${c.keyValueRows(record)}
            ${c.collapsible('Raw JSON', `<pre class="adminPre">${c.esc(JSON.stringify(record, null, 2))}</pre>`)}
          </div>
        `;

        target.querySelectorAll('button[data-comp-action="grant"]').forEach((btn) => {
          btn.addEventListener('click', () => openCompModal({ mode: 'grant', userId: btn.dataset.userId, onDone: () => viewDetail(userId, target) }));
        });
        target.querySelectorAll('button[data-comp-action="extend"]').forEach((btn) => {
          btn.addEventListener('click', () => openCompModal({ mode: 'extend', userId: btn.dataset.userId, onDone: () => viewDetail(userId, target) }));
        });
        target.querySelectorAll('button[data-comp-action="revoke"]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            if (!confirm('Revoke this user\'s free access? They will revert to their underlying subscription state.')) return;
            btn.disabled = true;
            try {
              await actions.revokeComp(btn.dataset.userId);
              helpers?.onMutate?.();
              viewDetail(userId, target);
            } catch (err) {
              alert(`Revoke failed: ${err?.message || 'unknown error'}`);
            } finally {
              btn.disabled = false;
            }
          });
        });
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
