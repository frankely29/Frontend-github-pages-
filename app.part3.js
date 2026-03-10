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

  function badgeChip(badgeCode) {
    const badge = strictBadgeCode(badgeCode);
    if (!badge) return '';
    if (badge === 'crown') {
      return '<span class="badgeChip badge-crown" aria-label="Crown">👑</span>';
    }
    const meta = {
      silver: { label: 'Silver', cls: 'badgeIcon badge-medal-silver', svg: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 2h4l1 6H9z" fill="#9aa5ae"></path><path d="M13 2h4l-2 6h-3z" fill="#6f7d88"></path><circle cx="12" cy="15" r="6" fill="#dfe5ea" stroke="#8a98a3" stroke-width="1.2"></circle><circle cx="12" cy="15" r="3.2" fill="#f7fafc" opacity="0.8"></circle></svg>' },
      bronze: { label: 'Bronze', cls: 'badgeIcon badge-medal-bronze', svg: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 2h4l1 6H9z" fill="#b46c3e"></path><path d="M13 2h4l-2 6h-3z" fill="#8f4f2b"></path><circle cx="12" cy="15" r="6" fill="#d08a55" stroke="#8f4f2b" stroke-width="1.2"></circle><circle cx="12" cy="15" r="3.2" fill="#efb27e" opacity="0.8"></circle></svg>' },
    }[badge];
    if (!meta) return '';
    return `<span class="${meta.cls}" aria-label="${meta.label} medal">${meta.svg}</span>`;
  }

  function formatMetric(value, metric = state.metric) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return metric === 'hours' ? `${n.toFixed(1)} h` : `${n.toFixed(1)} mi`;
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

    const topRows = state.rows.slice(0, 10).map((row, idx) => {
      const rank = Number(row?.rank_position || idx + 1);
      const name = row?.display_name || row?.name || row?.user_name || `Driver ${rank}`;
      const value = row?.metric_value;
      const badge = strictBadgeCode(row?.badge_code);
      return `<div class="leaderboardRow">
        <span class="leaderboardRank">#${rank}</span>
        <span class="leaderboardName" title="${esc(name)}">${esc(name)}</span>
        <span class="leaderboardValue">${formatMetric(value)}</span>
        ${badgeChip(badge)}
      </div>`;
    }).join('');

    const myRank = Number(state.myRow?.rank_position || 0);
    const myName = state.myRow?.display_name || state.myRow?.name || (window.me && window.me.display_name) || 'You';
    const myValue = state.myRow?.metric_value;

    return `
      <div class="panelBlock leaderboardPanelWrap">
        <div class="leaderboardTabs">${metricBtn('miles', 'Miles')}${metricBtn('hours', 'Hours')}</div>
        <div class="leaderboardTabs">${periodBtn('daily', 'Daily')}${periodBtn('weekly', 'Weekly')}${periodBtn('monthly', 'Monthly')}${periodBtn('yearly', 'Yearly')}</div>

        <div>
          <div style="font:900 11px/1.2 system-ui;margin-bottom:5px;">Top 10</div>
          <div class="leaderboardList">${topRows || '<div class="leaderboardEmpty">No entries yet.</div>'}</div>
        </div>

        <div class="myRankCard">
          <div style="font:900 11px/1.2 system-ui;">My Rank</div>
          <div class="myRankRow"><span>${esc(myName)}</span><span>${myRank ? `#${myRank}` : 'Unranked'}</span></div>
          <div class="myRankRow"><span>${state.metric === 'hours' ? 'Hours' : 'Miles'}</span><span>${formatMetric(myValue)}</span></div>
          <div class="myRankRow"><span>Badge</span><span>${badgeChip(selectedMyBadge()) || '—'}</span></div>
        </div>

        ${renderOverview()}

        <div>
          <div style="font:900 11px/1.2 system-ui;margin-bottom:5px;">Badge legend</div>
          <div class="leaderboardLegend">${badgeChip('crown')} Crown 👑 ${badgeChip('silver')} Silver 🥈 ${badgeChip('bronze')} Bronze 🥉</div>
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
      const [boardRes, meRes, badgesRes, overviewRes] = await Promise.all([
        getAuth(`/leaderboard?metric=${metric}&period=${period}&limit=10`),
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
  }

  function init() {
    const btn = document.getElementById('dockLeaderboard');
    if (!btn || typeof bindDockToggle !== 'function') return;

    bindDockToggle(btn, PANEL_KEY, 'Leaderboard', leaderboardPanelHTML, () => {
      wireLeaderboardPanel();
      loadAll();
    });
  }

  init();
})();
