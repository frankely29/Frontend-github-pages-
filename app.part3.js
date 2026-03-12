/*
 * app.part3.js
 * Leaderboard panel (Miles/Hours + periods + badges + my rank + overview).
 */
(function () {
  const LS_TOKEN = 'community_token_v1';
  const PANEL_KEY = 'leaderboard';

  const state = {
    metric: 'miles',
    period: 'weekly',
    view: 'top',
    rows: [],
    myRow: null,
    badges: [],
    overview: null,
    status: '',
    statusType: '',
  };

  function getToken() {
    try { return localStorage.getItem(LS_TOKEN) || ''; } catch (_) { return ''; }
  }

  function esc(v) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(v);
    return String(v ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  async function fetchJSON(url, opts = {}) {
    const res = await fetch(url, { cache: 'no-store', mode: 'cors', ...opts });
    const text = await res.text();
    if (!res.ok) throw new Error(text || `${res.status} ${res.statusText}`);
    return text ? JSON.parse(text) : {};
  }

  function apiBase() {
    if (typeof window !== 'undefined' && window.API_BASE) return String(window.API_BASE);
    return 'https://web-production-78f67.up.railway.app';
  }

  async function getAuth(path) {
    if (typeof window.getJSONAuth === 'function') return window.getJSONAuth(path, getToken());
    const headers = {};
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetchJSON(`${apiBase()}${path}`, { headers });
  }

  function strictBadgeCode(badgeCode) {
    const badge = String(badgeCode || '').trim().toLowerCase();
    if (badge === 'crown') return 'crown';
    if (badge === 'silver') return 'silver';
    if (badge === 'bronze') return 'bronze';
    return null;
  }

  function badgeChip(badgeCode, options = {}) {
    const badge = strictBadgeCode(badgeCode);
    if (!badge) return '';
    const badgeClass = badge === 'crown' ? 'badgeEmojiCrown' : (badge === 'silver' ? 'badgeEmojiSilver' : 'badgeEmojiBronze');
    const label = badge === 'crown' ? 'Crown' : (badge === 'silver' ? 'Silver' : 'Bronze');
    const icon = badge === 'crown' ? '👑' : (badge === 'silver' ? '🥈' : '🥉');
    return `<span class="badgeEmoji ${badgeClass}" aria-label="${label}">${icon}</span>${options.withLabel ? `<span class="badgeText">${label}</span>` : ''}`;
  }

  function formatMetric(value, metric = state.metric) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return metric === 'hours' ? `${n.toFixed(1)} h` : `${n.toFixed(1)} mi`;
  }

  function normalizeTierTitle(title) {
    const normalized = String(title || '').trim().toLowerCase();
    if (normalized === 'rookie') return 'Rookie';
    if (normalized === 'driver') return 'Driver';
    if (normalized === 'pro') return 'Pro';
    if (normalized === 'veteran') return 'Veteran';
    if (normalized === 'legend') return 'Legend';
    return String(title || 'Rookie').trim() || 'Rookie';
  }

  function tierClassName(title) {
    const tier = normalizeTierTitle(title).toLowerCase();
    if (tier === 'driver') return 'driverTierDriver';
    if (tier === 'pro') return 'driverTierPro';
    if (tier === 'veteran') return 'driverTierVeteran';
    if (tier === 'legend') return 'driverTierLegend';
    return 'driverTierRookie';
  }

  function levelTitleLine(level, title) {
    const n = Number(level);
    const safeLevel = Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
    const safeTitle = normalizeTierTitle(title);
    return `<span class="leaderboardTierLine">L${safeLevel} <span class="${tierClassName(safeTitle)}">${esc(safeTitle)}</span></span>`;
  }

  function selectedMyBadge() {
    const badgeList = Array.isArray(state.badges) ? state.badges : [];
    const exact = badgeList.find((b) => b?.metric === state.metric && b?.period === state.period);
    if (exact) return strictBadgeCode(exact.badge_code);
    return strictBadgeCode(state.myRow?.badge_code);
  }

  function renderOverview() {
    if (!state.overview || typeof state.overview !== 'object') return '';
    const block = (periodLabel, periodKey) => {
      const row = state.overview[periodKey] || {};
      return `<div class="myRankRow"><span>${periodLabel}</span><span>${formatMetric(row[state.metric], state.metric)}</span></div>`;
    };

    return `
      <div class="myRankCard">
        <div style="font:900 11px/1.2 system-ui;">My Summary</div>
        ${block('Today', 'today')}
        ${block('Week', 'week')}
        ${block('Month', 'month')}
        ${block('Year', 'year')}
      </div>`;
  }

  function leaderboardPanelHTML() {
    const metricBtn = (m, label) => `<button class="chipBtn ${state.metric === m ? 'active' : ''}" data-lb-metric="${m}">${label}</button>`;
    const periodBtn = (p, label) => `<button class="chipBtn ${state.period === p ? 'active' : ''}" data-lb-period="${p}">${label}</button>`;
    const viewBtn = (v, label) => `<button class="chipBtn ${state.view === v ? 'active' : ''}" data-lb-view="${v}">${label}</button>`;

    const renderRows = (rows, options = {}) => rows.map((row, idx) => {
      const rank = Number(row?.rank_position || idx + 1);
      const name = row?.display_name || row?.name || row?.user_name || `Driver ${rank}`;
      const value = row?.metric_value;
      const badge = strictBadgeCode(row?.badge_code);
      const rowClass = rank <= 3 && !options.compact ? ` leaderboardTop${rank}` : '';
      return `<div class="leaderboardRow${rowClass}">
        <span class="leaderboardRank">#${rank}</span>
        <span class="leaderboardNameWrap">
          <span class="leaderboardName" title="${esc(name)}">${esc(name)}</span>
          ${levelTitleLine(row?.level, row?.title)}
        </span>
        <span class="leaderboardValue">${formatMetric(value)}</span>
        <span class="leaderboardBadgeCell">${badgeChip(badge)}</span>
      </div>`;
    }).join('');

    const topRows = renderRows(state.rows.slice(0, 10));
    const allRows = renderRows(state.rows, { compact: true });

    const myRank = Number(state.myRow?.rank_position || 0);
    const myName = state.myRow?.display_name || state.myRow?.name || (window.me && window.me.display_name) || 'You';
    const myValue = state.myRow?.metric_value;
    const topView = `
      <div>
        <div class="leaderboardSectionTitle">Top 10</div>
        <div class="leaderboardList">${topRows || '<div class="leaderboardEmpty">No entries yet.</div>'}</div>
      </div>

      <div class="myRankCard">
        <div class="leaderboardSectionTitle">My Rank</div>
        <div class="myRankRow"><span>${esc(myName)}</span><span>${myRank ? `#${myRank}` : 'Unranked'}</span></div>
        <div class="myRankRow"><span>Progression</span><span>${levelTitleLine(state.myRow?.level, state.myRow?.title)}</span></div>
        <div class="myRankRow"><span>${state.metric === 'hours' ? 'Hours' : 'Miles'}</span><span>${formatMetric(myValue)}</span></div>
        <div class="myRankRow"><span>Badge</span><span>${badgeChip(selectedMyBadge()) || '—'}</span></div>
      </div>

      ${renderOverview()}

      <div>
        <div class="leaderboardSectionTitle">Badge legend</div>
        <div class="leaderboardLegend">${badgeChip('crown', { withLabel: true })} ${badgeChip('silver', { withLabel: true })} ${badgeChip('bronze', { withLabel: true })}</div>
      </div>`;

    const allView = `
      <div class="myRankCard leaderboardMyRankCompact">
        <div class="leaderboardSectionTitle">My Rank</div>
        <div class="myRankRow"><span>${esc(myName)}</span><span>${myRank ? `#${myRank}` : 'Unranked'}</span></div>
        <div class="myRankRow"><span>${state.metric === 'hours' ? 'Hours' : 'Miles'}</span><span>${formatMetric(myValue)}</span></div>
      </div>
      <div>
        <div class="leaderboardSectionTitle">All Users</div>
        <div class="leaderboardList leaderboardAllList">${allRows || '<div class="leaderboardEmpty">No entries yet.</div>'}</div>
      </div>`;

    return `
      <div class="panelBlock leaderboardPanelWrap">
        <div class="leaderboardPanelControls">
          <div class="leaderboardTabs">${metricBtn('miles', 'Miles')}${metricBtn('hours', 'Hours')}</div>
          <div class="leaderboardTabs">${periodBtn('daily', 'Daily')}${periodBtn('weekly', 'Weekly')}${periodBtn('monthly', 'Monthly')}${periodBtn('yearly', 'Yearly')}</div>
          <div class="leaderboardTabs leaderboardViewTabs">${viewBtn('top', 'Top')}${viewBtn('all', 'All')}</div>
        </div>
        <div class="leaderboardPanelBody">
          ${state.view === 'all' ? allView : topView}
        </div>

        <div id="lbStatus" class="leaderboardStatus ${state.statusType}">${esc(state.status || '')}</div>
      </div>`;
  }

  function rerenderIfOpen() {
    if (typeof openPanelKey === 'undefined' || openPanelKey !== PANEL_KEY) return;
    const body = document.getElementById('dockDrawerBody');
    if (!body) return;
    body.innerHTML = leaderboardPanelHTML();
    wireLeaderboardPanel();
  }

  async function loadAll() {
    if (!getToken()) {
      state.rows = [];
      state.myRow = null;
      state.badges = [];
      state.overview = null;
      state.status = 'Sign in to view leaderboard.';
      state.statusType = 'err';
      rerenderIfOpen();
      return;
    }

    state.status = 'Loading…';
    state.statusType = '';
    rerenderIfOpen();

    const metric = encodeURIComponent(state.metric);
    const period = encodeURIComponent(state.period);
    try {
      const boardPromise = getAuth(`/leaderboard?metric=${metric}&period=${period}`)
        .catch(() => getAuth(`/leaderboard?metric=${metric}&period=${period}&limit=10`));
      const [boardRes, meRes, badgesRes, overviewRes] = await Promise.all([
        boardPromise,
        getAuth(`/leaderboard/me?metric=${metric}&period=${period}`),
        getAuth('/leaderboard/badges/me').catch(() => ({ badges: [] })),
        getAuth('/leaderboard/overview/me').catch(() => null),
      ]);

      state.rows = Array.isArray(boardRes?.rows) ? boardRes.rows : [];
      state.myRow = meRes?.row || null;
      state.badges = Array.isArray(badgesRes?.badges) ? badgesRes.badges : [];
      state.overview = overviewRes && typeof overviewRes === 'object' ? overviewRes : null;
      state.status = '';
      state.statusType = '';
    } catch (err) {
      state.rows = [];
      state.myRow = null;
      state.badges = [];
      state.overview = null;
      state.status = `Unable to load leaderboard: ${String(err?.message || err)}`;
      state.statusType = 'err';
    }

    rerenderIfOpen();
  }

  function wireLeaderboardPanel() {
    document.querySelectorAll('[data-lb-metric]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const nextMetric = btn.getAttribute('data-lb-metric') || 'miles';
        if (state.metric === nextMetric) return;
        state.metric = nextMetric;
        loadAll();
      });
    });

    document.querySelectorAll('[data-lb-period]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const nextPeriod = btn.getAttribute('data-lb-period') || 'weekly';
        if (state.period === nextPeriod) return;
        state.period = nextPeriod;
        loadAll();
      });
    });

    document.querySelectorAll('[data-lb-view]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const nextView = btn.getAttribute('data-lb-view') || 'top';
        if (state.view === nextView) return;
        state.view = nextView === 'all' ? 'all' : 'top';
        rerenderIfOpen();
      });
    });
  }

  function injectLeaderboardProgressionStyles() {
    if (document.getElementById('leaderboardProgressionStyles')) return;
    const style = document.createElement('style');
    style.id = 'leaderboardProgressionStyles';
    style.textContent = `
      .leaderboardNameWrap{display:flex;flex-direction:column;min-width:0}
      .leaderboardTierLine{font-size:11px;font-weight:700;color:#475569;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .leaderboardPanelWrap{gap:7px;max-height:min(64vh,560px);overflow:hidden;padding:8px}
      .leaderboardPanelControls{display:flex;flex-direction:column;gap:5px;flex:0 0 auto}
      .leaderboardViewTabs .chipBtn{min-width:52px;justify-content:center}
      .leaderboardPanelBody{display:flex;flex-direction:column;gap:7px;min-height:0;overflow-y:auto;padding-right:2px}
      .leaderboardPanelBody>div{flex:0 0 auto}
      .leaderboardSectionTitle{font:900 11px/1.2 system-ui;margin-bottom:4px}
      .leaderboardList{gap:4px;margin-top:2px}
      .leaderboardRow{gap:7px}
      .myRankCard{padding:7px;gap:4px}
      .myRankRow{line-height:1.2}
      .leaderboardLegend{gap:5px}
      .leaderboardAllList{max-height:100%;overflow-y:auto;padding-right:2px}
      .leaderboardMyRankCompact{margin-bottom:1px}
      .driverTierRookie{color:#64748b}
      .driverTierDriver{color:#2563eb}
      .driverTierPro{color:#16a34a}
      .driverTierVeteran{color:#7c3aed}
      .driverTierLegend{color:#b45309}
    `;
    document.head.appendChild(style);
  }

  function init() {
    injectLeaderboardProgressionStyles();
    const btn = document.getElementById('dockLeaderboard');
    if (!btn || typeof bindDockToggle !== 'function') return;

    bindDockToggle(btn, PANEL_KEY, 'Leaderboard', leaderboardPanelHTML, () => {
      wireLeaderboardPanel();
      loadAll();
    });
  }

  init();
})();
