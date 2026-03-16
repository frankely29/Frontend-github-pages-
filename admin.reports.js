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
      if (type === 'police') {
        const ok = window.confirm('Clear this police report?');
        if (!ok) return;
        await actions.clearPoliceReport(id);
        state.policeRows = state.policeRows.filter((r) => String(r.id) !== String(id));
        helpers?.onMutate?.();
        draw();
        return;
      }

      if (!actions.voidRecordedTrip) return;
      const reasonRaw = prompt('Enter reason for deleting this fake trip:');
      if (reasonRaw === null) return;
      const reason = String(reasonRaw || '').trim();
      if (reason.length < 5) {
        alert('Please enter at least 5 characters for the delete reason.');
        return;
      }
      const ok = window.confirm('This will soft-delete the recorded trip from active data but preserve the audit row. Continue?');
      if (!ok) return;

      await actions.voidRecordedTrip(id, reason);
      state.pickupRows = state.pickupRows.filter((r) => String(r.id) !== String(id));
      helpers?.onMutate?.();
      draw();
      if (c?.toast) c.toast('Recorded trip soft-deleted successfully.', 'success');
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
          <button type="button" class="adminBtn danger" data-clear-type="${state.tab}" data-clear-id="${c.esc(r?.id ?? '')}">${state.tab === 'police' ? 'Clear Report' : 'Delete Fake Trip'}</button>
        </article>
      `).join('');

      listEl.querySelectorAll('[data-clear-id]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await clearRow(btn.dataset.clearType, btn.dataset.clearId);
          } catch (err) {
            const type = btn.dataset.clearType;
            if (type === 'pickups') {
              alert(err?.message || 'Failed to delete fake trip.');
            } else {
              alert(err?.message || 'Failed to clear report.');
            }
          } finally {
            btn.disabled = false;
          }
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
