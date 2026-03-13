(function () {
  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normUsers(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.users)) return payload.users;
    if (Array.isArray(payload?.rows)) return payload.rows;
    return [];
  }

  function formatDate(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return esc(value);
    return d.toLocaleString();
  }

  function boolChip(v, trueLabel, falseLabel) {
    return `<span class="adminPill ${v ? 'yes' : 'no'}">${v ? trueLabel : falseLabel}</span>`;
  }

  function renderAdminUsers(container, payload, helpers) {
    const users = normUsers(payload);

    container.innerHTML = `
      <div class="adminSection">
        <div class="adminSectionHead">
          <h3>Users</h3>
          <input id="adminUsersSearch" class="adminInput" type="search" placeholder="Search email, name, or id" />
        </div>
        <div class="adminMuted">Read-only user directory (${users.length})</div>
        <div id="adminUsersTableWrap"></div>
      </div>
    `;

    const searchEl = container.querySelector('#adminUsersSearch');
    const wrap = container.querySelector('#adminUsersTableWrap');

    function draw(filterRaw) {
      const filter = String(filterRaw || '').trim().toLowerCase();
      const rows = users.filter((u) => {
        if (!filter) return true;
        const blob = [u?.id, u?.email, u?.display_name, u?.name]
          .map((x) => String(x ?? '').toLowerCase())
          .join(' ');
        return blob.includes(filter);
      });

      if (!rows.length) {
        wrap.innerHTML = `<div class="adminEmpty">No users matched your filter.</div>`;
        return;
      }

      wrap.innerHTML = `
        <div class="adminTableWrap">
          <table class="adminTable">
            <thead>
              <tr>
                <th>User ID</th>
                <th>Email</th>
                <th>Display Name</th>
                <th>Admin</th>
                <th>Ghost</th>
                <th>Created</th>
                <th>Avatar</th>
                <th>Subscription</th>
              </tr>
            </thead>
            <tbody>
              ${rows
                .map(
                  (u) => `<tr>
                    <td>${esc(u?.id ?? '—')}</td>
                    <td>${esc(u?.email ?? '—')}</td>
                    <td>${esc(u?.display_name || u?.name || '—')}</td>
                    <td>${boolChip(!!u?.is_admin, 'Yes', 'No')}</td>
                    <td>${boolChip(!!u?.ghost_mode, 'On', 'Off')}</td>
                    <td>${formatDate(u?.created_at)}</td>
                    <td>${u?.avatar_url ? '<span class="adminDot on" title="Avatar URL present"></span>' : '<span class="adminDot"></span>'}</td>
                    <td>${esc(u?.subscription_status || u?.subscription_tier || '—')}</td>
                  </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    searchEl?.addEventListener('input', () => draw(searchEl.value));
    draw('');
  }

  window.AdminUsers = {
    renderAdminUsers,
  };
})();
