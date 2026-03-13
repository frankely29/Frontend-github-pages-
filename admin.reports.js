(function () {
  function pickRows(payload, preferredKey) {
    if (Array.isArray(payload)) return payload;
    if (preferredKey && Array.isArray(payload?.[preferredKey])) return payload[preferredKey];
    if (Array.isArray(payload?.rows)) return payload.rows;
    return [];
  }

  function byNewest(a, b) {
    const da = new Date(a?.created_at || a?.timestamp || 0).getTime();
    const db = new Date(b?.created_at || b?.timestamp || 0).getTime();
    return db - da;
  }

  function renderAdminReports(container, policePayload, pickupPayload, helpers) {
    const c = helpers?.components || window.AdminComponents;
    const actions = helpers?.actions;
    const state = {
      tab: 'police',
      policeRows: pickRows(policePayload, 'reports').slice().sort(byNewest),
      pickupRows: pickRows(pickupPayload, 'logs').slice().sort(byNewest),
    };

    container.innerHTML = `
      <div class="adminSection">
        <div class="adminRow">
          <button class="adminTabBtn active" data-rtab="police">Police</button>
          <button class="adminTabBtn" data-rtab="pickups">Pickups</button>
        </div>
        <div id="adminReportsList" class="adminList"></div>
      </div>
    `;

    const listEl = container.querySelector('#adminReportsList');

    async function clearRow(type, id) {
      if (!actions) return;
      const ok = window.confirm(`Clear this ${type} report?`);
      if (!ok) return;
      if (type === 'police') {
        await actions.clearPoliceReport(id);
        state.policeRows = state.policeRows.filter((r) => String(r.id) !== String(id));
      } else {
        await actions.clearPickupLog(id);
        state.pickupRows = state.pickupRows.filter((r) => String(r.id) !== String(id));
      }
      helpers?.onMutate?.();
      draw();
    }

    function draw() {
      const rows = state.tab === 'police' ? state.policeRows : state.pickupRows;
      if (!rows.length) {
        listEl.innerHTML = `<div class="adminEmpty">No ${state.tab} reports found.</div>`;
        return;
      }

      listEl.innerHTML = rows.map((r) => `
        <article class="adminUserCard">
          <div class="adminRowBetween">
            <strong>#${c.esc(r?.id ?? '—')}</strong>
            ${c.badge(c.formatDateTime(r?.created_at), 'muted')}
          </div>
          <div class="adminKV"><span>User</span><strong>${c.esc(c.formatValue(r?.user_id))}</strong></div>
          <div class="adminKV"><span>Location</span><strong>${c.esc(`${c.formatValue(r?.lat)}, ${c.formatValue(r?.lng)}`)}</strong></div>
          ${state.tab === 'pickups' ? `<div class="adminKV"><span>Zone</span><strong>${c.esc(c.formatValue(r?.zone_name || r?.zone_id))}</strong></div>` : ''}
          <button type="button" class="adminBtn danger" data-clear-type="${state.tab}" data-clear-id="${c.esc(r?.id ?? '')}">${state.tab === 'police' ? 'Clear Report' : 'Clear Pickup Log'}</button>
        </article>
      `).join('');

      listEl.querySelectorAll('[data-clear-id]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try { await clearRow(btn.dataset.clearType, btn.dataset.clearId); } finally { btn.disabled = false; }
        });
      });
    }

    container.querySelectorAll('[data-rtab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.tab = btn.dataset.rtab;
        container.querySelectorAll('[data-rtab]').forEach((b) => b.classList.toggle('active', b === btn));
        draw();
      });
    });

    draw();
  }

  window.AdminReports = { renderAdminReports };
})();
