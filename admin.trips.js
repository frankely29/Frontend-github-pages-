(function () {
  function normalizeRows(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.trips)) return payload.trips;
    if (Array.isArray(payload?.rows)) return payload.rows;
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.items)) return payload.items;
    if (Array.isArray(payload?.results)) return payload.results;
    return [];
  }

  function parseTime(value) {
    if (!value) return 0;
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : 0;
  }

  function pick(row, keys, fallback = '—') {
    for (const key of keys) {
      const val = row?.[key];
      if (val !== null && val !== undefined && val !== '') return val;
    }
    return fallback;
  }

  function renderAdminTrips(container, payload, helpers) {
    const c = helpers?.components || window.AdminComponents;
    const summary = payload?.summary && typeof payload.summary === 'object' ? payload.summary : {};
    const rows = normalizeRows(payload?.recent)
      .slice()
      .sort((a, b) => parseTime(pick(b, ['created_at', 'recorded_at', 'frame_time', 'timestamp'], 0)) - parseTime(pick(a, ['created_at', 'recorded_at', 'frame_time', 'timestamp'], 0)));

    const latestTripTime =
      summary.latest_recorded_trip_time ||
      summary.latest_trip_time ||
      summary.latestRecordedTripTime ||
      rows[0]?.created_at ||
      rows[0]?.recorded_at ||
      rows[0]?.frame_time ||
      rows[0]?.timestamp;

    container.innerHTML = `
      <div class="adminGrid two">
        ${c.statCard('Total Recorded Trips', summary.total_recorded_trips ?? summary.total_trips ?? summary.total ?? rows.length ?? 'N/A')}
        ${c.statCard('Trips In Last 24h', summary.trips_last_24h ?? summary.last_24h ?? summary.tripsInLast24h ?? 0)}
        ${c.statCard('Trips In Last 7d', summary.trips_last_7d ?? summary.last_7d ?? summary.tripsInLast7d ?? 0)}
        ${c.statCard('Latest Recorded Trip Time', c.formatDateTime(latestTripTime || 'N/A'))}
      </div>
      <div class="adminSection">
        <div class="adminSectionHead"><h4>Latest Trips</h4><span class="adminMuted">Newest first • showing ${c.esc(String(rows.length || 0))}</span></div>
        <div id="adminTripsList" class="adminList"></div>
      </div>
    `;

    const listEl = container.querySelector('#adminTripsList');
    if (!rows.length) {
      listEl.innerHTML = '<div class="adminEmpty">No recorded trips found.</div>';
      return;
    }

    listEl.innerHTML = rows.map((row) => `
      <article class="adminUserCard">
        <div class="adminRowBetween">
          <strong>Trip #${c.esc(String(pick(row, ['id', 'trip_id', 'log_id'], 'N/A')))}</strong>
          ${c.badge(c.formatDateTime(pick(row, ['created_at', 'recorded_at', 'timestamp'], 'N/A')), 'muted')}
        </div>
        <div class="adminKV"><span>User ID</span><strong>${c.esc(c.formatValue(pick(row, ['user_id'], 'Unknown')))}</strong></div>
        <div class="adminKV"><span>Display Name</span><strong>${c.esc(c.formatValue(pick(row, ['display_name', 'name', 'username'], '—')))}</strong></div>
        <div class="adminKV"><span>Zone</span><strong>${c.esc(`${c.formatValue(pick(row, ['zone_id'], 'N/A'))} • ${c.formatValue(pick(row, ['zone_name'], 'Unknown'))}`)}</strong></div>
        <div class="adminKV"><span>Borough</span><strong>${c.esc(c.formatValue(pick(row, ['borough'], 'Unknown')))}</strong></div>
        <div class="adminKV"><span>Frame Time</span><strong>${c.esc(c.formatValue(pick(row, ['frame_time', 'frame_timestamp'], 'N/A')))}</strong></div>
        <div class="adminKV"><span>Lat/Lng</span><strong>${c.esc(`${c.formatValue(pick(row, ['lat', 'latitude'], 'N/A'))}, ${c.formatValue(pick(row, ['lng', 'lon', 'longitude'], 'N/A'))}`)}</strong></div>
      </article>
    `).join('');
  }

  window.AdminTrips = { renderAdminTrips };
})();
