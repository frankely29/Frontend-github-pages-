(function () {
  function renderAdminSystem(container, payload, helpers) {
    const c = helpers?.components || window.AdminComponents;
    const p = payload || {};
    const counts = p.counts || p.summary || p.resources || {};

    const leaderboard = typeof p.leaderboard_status === 'object' && p.leaderboard_status
      ? p.leaderboard_status
      : p.leaderboard || { status: p.leaderboard_status || '—' };

    container.innerHTML = `
      <div class="adminGrid two">
        <div class="adminCard compact">
          <h4>System Status</h4>
          <div class="adminKV"><span>Backend Status</span><strong>${c.esc(c.formatValue(p.backend_status || p.status || 'unknown'))}</strong></div>
          <div class="adminKV"><span>Timeline Ready</span><strong>${c.esc(c.boolText(!!p.timeline_ready, 'Yes', 'No'))}</strong></div>
          <div class="adminKV"><span>Frame Status</span><strong>${c.esc(c.formatValue(p.frame_status || p.frame_count || p.frame_ready))}</strong></div>
        </div>
        <div class="adminCard compact">
          <h4>Leaderboard</h4>
          ${c.keyValueRows(leaderboard)}
        </div>
      </div>
      <div class="adminSection">
        <h4>Resource Counts</h4>
        ${c.keyValueRows(counts)}
      </div>
      ${c.collapsible('Advanced Diagnostics', `<pre class="adminPre">${c.esc(JSON.stringify(p, null, 2))}</pre>`)}
    `;
  }

  window.AdminSystem = { renderAdminSystem };
})();
