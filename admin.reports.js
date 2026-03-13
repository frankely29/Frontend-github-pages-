(function () {
  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function pickRows(payload, preferredKey) {
    if (Array.isArray(payload)) return payload;
    if (preferredKey && Array.isArray(payload?.[preferredKey])) return payload[preferredKey];
    if (Array.isArray(payload?.rows)) return payload.rows;
    return [];
  }

  function tableOrEmpty(title, rows, cols, renderRow) {
    if (!rows.length) {
      return `<div class="adminSection"><h4>${esc(title)}</h4><div class="adminEmpty">No records found.</div></div>`;
    }
    return `
      <div class="adminSection">
        <h4>${esc(title)} <span class="adminMuted">(${rows.length})</span></h4>
        <div class="adminTableWrap">
          <table class="adminTable">
            <thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
            <tbody>${rows.map(renderRow).join('')}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  function renderAdminReports(container, policePayload, pickupPayload) {
    const policeRows = pickRows(policePayload, 'reports');
    const pickupRows = pickRows(pickupPayload, 'logs');

    container.innerHTML = `
      ${tableOrEmpty(
        'Police Reports',
        policeRows,
        ['ID', 'User ID', 'Lat', 'Lng', 'Created At'],
        (r) => `<tr>
          <td>${esc(r?.id ?? '—')}</td>
          <td>${esc(r?.user_id ?? '—')}</td>
          <td>${esc(r?.lat ?? '—')}</td>
          <td>${esc(r?.lng ?? '—')}</td>
          <td>${esc(r?.created_at ?? '—')}</td>
        </tr>`
      )}
      ${tableOrEmpty(
        'Pickup Logs',
        pickupRows,
        ['ID', 'User ID', 'Zone ID', 'Zone Name', 'Borough', 'Lat', 'Lng', 'Frame Time', 'Created At'],
        (r) => `<tr>
          <td>${esc(r?.id ?? '—')}</td>
          <td>${esc(r?.user_id ?? '—')}</td>
          <td>${esc(r?.zone_id ?? '—')}</td>
          <td>${esc(r?.zone_name ?? '—')}</td>
          <td>${esc(r?.borough ?? '—')}</td>
          <td>${esc(r?.lat ?? '—')}</td>
          <td>${esc(r?.lng ?? '—')}</td>
          <td>${esc(r?.frame_time ?? '—')}</td>
          <td>${esc(r?.created_at ?? '—')}</td>
        </tr>`
      )}
    `;
  }

  window.AdminReports = {
    renderAdminReports,
  };
})();
