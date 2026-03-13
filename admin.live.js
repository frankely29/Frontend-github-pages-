(function () {
  function normRows(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.online)) return payload.online;
    if (Array.isArray(payload?.drivers)) return payload.drivers;
    if (Array.isArray(payload?.rows)) return payload.rows;
    return [];
  }

  function renderAdminLive(container, payload, helpers) {
    const c = helpers?.components || window.AdminComponents;
    const rows = normRows(payload);
    const filters = { showGhosted: true, showActive: true };

    container.innerHTML = `
      <div class="adminSection">
        <div class="adminSectionHead wrap">
          <h3>Live Users</h3>
          <div class="adminRow">
            <button class="adminToggleBtn active" data-filter="active">Show Active</button>
            <button class="adminToggleBtn active" data-filter="ghosted">Show Ghosted</button>
          </div>
        </div>
        <div id="adminLiveList" class="adminList"></div>
      </div>
    `;

    const listEl = container.querySelector('#adminLiveList');

    function draw() {
      const filtered = rows.filter((r) => {
        if (!filters.showGhosted && r?.ghost_mode) return false;
        if (!filters.showActive && !r?.ghost_mode) return false;
        return true;
      });

      if (!filtered.length) {
        listEl.innerHTML = '<div class="adminEmpty">No users match selected filters.</div>';
        return;
      }

      listEl.innerHTML = filtered.map((r) => {
        const lat = Number(r?.lat);
        const lng = Number(r?.lng);
        const rough = Number.isFinite(lat) && Number.isFinite(lng) ? `${lat.toFixed(4)}, ${lng.toFixed(4)}` : '—';
        return `
          <article class="adminUserCard">
            <div class="adminRowBetween">
              <strong>${c.esc(r?.display_name || r?.name || 'Unknown')}</strong>
              <div class="adminRow">${c.badge('Online', 'yes')} ${c.badge(r?.ghost_mode ? 'Ghosted' : 'Visible', r?.ghost_mode ? 'warn' : 'muted')}</div>
            </div>
            <div class="adminMuted">ID ${c.esc(r?.user_id ?? r?.id ?? '—')} • Updated ${c.formatDateTime(r?.updated_at)}</div>
            <div class="adminKV"><span>Location</span><strong>${c.esc(rough)}</strong></div>
            <div class="adminKV"><span>Heading</span><strong>${c.esc(c.formatValue(r?.heading))}</strong></div>
            <div class="adminKV"><span>Accuracy</span><strong>${c.esc(c.formatValue(r?.accuracy_m ?? r?.accuracy))}</strong></div>
            <button class="adminBtn" type="button" data-live-view="${c.esc(r?.user_id ?? r?.id ?? '')}">View</button>
          </article>
        `;
      }).join('');

      listEl.querySelectorAll('[data-live-view]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const row = filtered.find((item) => String(item.user_id ?? item.id) === String(btn.dataset.liveView));
          if (!row) return;
          window.alert(`User ${row.display_name || row.name || row.user_id}\nLocation: ${row.lat}, ${row.lng}\nUpdated: ${row.updated_at || '—'}`);
        });
      });
    }

    container.querySelectorAll('[data-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.filter === 'ghosted') filters.showGhosted = !filters.showGhosted;
        if (btn.dataset.filter === 'active') filters.showActive = !filters.showActive;
        btn.classList.toggle('active', (btn.dataset.filter === 'ghosted' && filters.showGhosted) || (btn.dataset.filter === 'active' && filters.showActive));
        draw();
      });
    });

    draw();
  }

  window.AdminLive = { renderAdminLive };
})();
