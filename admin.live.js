(function () {
  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normRows(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.online)) return payload.online;
    if (Array.isArray(payload?.drivers)) return payload.drivers;
    if (Array.isArray(payload?.rows)) return payload.rows;
    return [];
  }

  function renderAdminLive(container, payload) {
    const rows = normRows(payload);

    if (!rows.length) {
      container.innerHTML = '<div class="adminEmpty">No live drivers online right now.</div>';
      return;
    }

    container.innerHTML = `
      <div class="adminSection">
        <div class="adminSectionHead">
          <h3>Live Online Drivers</h3>
          <div class="adminMuted">${rows.length} active rows</div>
        </div>
        <div class="adminTableWrap">
          <table class="adminTable">
            <thead>
              <tr>
                <th>User ID</th>
                <th>Display Name</th>
                <th>Lat</th>
                <th>Lng</th>
                <th>Heading</th>
                <th>Ghost</th>
                <th>Updated</th>
                <th>Accuracy</th>
                <th>Leaderboard Badge</th>
              </tr>
            </thead>
            <tbody>
              ${rows
                .map(
                  (r) => `<tr>
                    <td>${esc(r?.user_id ?? r?.id ?? '—')}</td>
                    <td>${esc(r?.display_name || r?.name || '—')}</td>
                    <td>${esc(r?.lat ?? '—')}</td>
                    <td>${esc(r?.lng ?? '—')}</td>
                    <td>${esc(r?.heading ?? '—')}</td>
                    <td><span class="adminPill ${r?.ghost_mode ? 'yes' : 'no'}">${r?.ghost_mode ? 'On' : 'Off'}</span></td>
                    <td>${esc(r?.updated_at || '—')}</td>
                    <td>${esc(r?.accuracy_m ?? r?.accuracy ?? '—')}</td>
                    <td>${esc(r?.leaderboard_badge || r?.leaderboard_badge_code || '—')}</td>
                  </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  window.AdminLive = {
    renderAdminLive,
  };
})();
