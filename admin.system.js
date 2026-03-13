(function () {
  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function line(label, value) {
    return `<div class="adminKV"><span>${esc(label)}</span><strong>${esc(value ?? '—')}</strong></div>`;
  }

  function renderAdminSystem(container, payload) {
    const p = payload || {};
    const counts = p.counts || p.summary || {};

    container.innerHTML = `
      <div class="adminGrid two">
        <div class="adminCard">
          <h4>Core Status</h4>
          ${line('Backend Status', p.backend_status || p.status || 'unknown')}
          ${line('Timeline Ready', p.timeline_ready)}
          ${line('Frame Status', p.frame_status || p.frame_ready)}
          ${line('Leaderboard Status', p.leaderboard_status || p.leaderboard?.status || '—')}
        </div>
        <div class="adminCard">
          <h4>Resource Summary</h4>
          ${Object.keys(counts).length
            ? Object.entries(counts)
                .map(([k, v]) => line(k, v))
                .join('')
            : '<div class="adminEmpty">No summary counts returned.</div>'}
        </div>
      </div>
      <div class="adminSection">
        <h4>Diagnostics</h4>
        <pre class="adminPre">${esc(JSON.stringify(p, null, 2))}</pre>
      </div>
    `;
  }

  window.AdminSystem = {
    renderAdminSystem,
  };
})();
