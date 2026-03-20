/*
 * app.part3.js
 * Leaderboard panel (Miles/Hours + periods + badges + my rank + overview).
 */
(function () {
  const runtime = window.FrontendRuntime || null;
  const LS_TOKEN = 'community_token_v1';
  const PANEL_KEY = 'leaderboard';
  const bindDockToggleFn = window.bindDockToggle || (typeof bindDockToggle === 'function' ? bindDockToggle : null);
  const getOpenPanelKeyFn = window.getOpenPanelKey || (() => (typeof openPanelKey !== 'undefined' ? openPanelKey : null));

  function getOpenDrawerFn() {
    if (typeof window.openDrawer === 'function') return window.openDrawer;
    if (typeof openDrawer === 'function') return openDrawer;
    return null;
  }

  const RANK_BAND_SIZE = 10;
  const RANK_LADDER_MAX_LEVEL = 1000;
  const RANK_LADDER_BAND_TITLES = ['Recruit', 'Runner', 'Courier', 'Navigator', 'Pilot', 'Sentinel', 'Captain', 'Marshal', 'Commander', 'Legend'];
  const RANK_LADDER_BAND_PREFIXES = ['Bronze', 'Copper', 'Iron', 'Steel', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Obsidian', 'Celestial'];

  function createRankLadderFallback() {
    const rows = [];
    const totalBands = Math.ceil(RANK_LADDER_MAX_LEVEL / RANK_BAND_SIZE);
    for (let band = 1; band <= totalBands; band += 1) {
      const startLevel = ((band - 1) * RANK_BAND_SIZE) + 1;
      const endLevel = Math.min(RANK_LADDER_MAX_LEVEL, band * RANK_BAND_SIZE);
      const familyIndex = (band - 1) % RANK_LADDER_BAND_TITLES.length;
      const tierIndex = Math.floor((band - 1) / RANK_LADDER_BAND_TITLES.length) % RANK_LADDER_BAND_PREFIXES.length;
      rows.push({
        start_level: startLevel,
        end_level: endLevel,
        rank_name: `${RANK_LADDER_BAND_PREFIXES[tierIndex]} ${RANK_LADDER_BAND_TITLES[familyIndex]}`,
        rank_icon_key: `band_${String(band).padStart(3, '0')}`,
      });
    }
    return rows;
  }

  const RANK_LADDER_FALLBACK = createRankLadderFallback();

  const state = {
    metric: 'miles',
    period: 'weekly',
    view: 'top',
    rows: [],
    myRow: null,
    badges: [],
    overview: null,
    rankLadder: [],
    rankLadderLoaded: false,
    status: '',
    statusType: '',
  };

  function leaderboardPerfDebugState() {
    window.__mapPerfDebug = window.__mapPerfDebug || {};
    window.__mapPerfDebug.leaderboard = window.__mapPerfDebug.leaderboard || {
      loaded: false,
      opened: false,
      lastError: '',
      lastOpenAt: 0,
      loadAttempts: 0,
    };
    return window.__mapPerfDebug.leaderboard;
  }

  function markLeaderboardLoaded() {
    const debugState = leaderboardPerfDebugState();
    debugState.loaded = true;
    debugState.lastError = '';
  }

  function markLeaderboardOpenError(error) {
    const debugState = leaderboardPerfDebugState();
    debugState.opened = false;
    debugState.lastError = String(error?.message || error || 'Leaderboard error');
  }

  function markLeaderboardOpened() {
    const debugState = leaderboardPerfDebugState();
    debugState.loaded = true;
    debugState.opened = true;
    debugState.lastError = '';
    debugState.lastOpenAt = Date.now();
  }

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
    if (runtime?.fetchJSON) return runtime.fetchJSON(url, opts);
    const shouldBypassCache = opts.cache === 'no-store' || /\/(auth|me|chat|presence)\b/.test(String(url || ''));
    const res = await fetch(url, { mode: 'cors', ...(shouldBypassCache ? { cache: 'no-store' } : {}), ...opts });
    const text = await res.text();
    if (!res.ok) throw new Error(text || `${res.status} ${res.statusText}`);
    return text ? JSON.parse(text) : {};
  }

  function apiBase() {
    if (runtime?.resolveApiBase) return runtime.resolveApiBase();
    if (typeof window !== 'undefined' && window.API_BASE) return String(window.API_BASE);
    return 'https://web-production-78f67.up.railway.app';
  }

  async function getAuth(path) {
    if (runtime?.getJSONAuth) return runtime.getJSONAuth(path, getToken());
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
    const label = badge === 'crown' ? 'Crown' : (badge === 'silver' ? 'Silver' : 'Bronze');
    const svg = typeof window.renderLeaderboardBadgeSvg === 'function'
      ? window.renderLeaderboardBadgeSvg(badge, { size: options.withLabel ? 19 : 18, compact: true })
      : `<svg class="leaderboardBadgeSvg is-fallback" viewBox="0 0 24 24" width="18" height="18" role="img" aria-label="${esc(label)}"><circle cx="12" cy="12" r="9" fill="#cbd5e1" stroke="#475569" stroke-width="1.4"/></svg>`;
    return `<span class="badgeChipSvgWrap">${svg}</span>${options.withLabel ? `<span class="badgeText">${label}</span>` : ''}`;
  }

  function formatMetric(value, metric = state.metric) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return metric === 'hours' ? `${n.toFixed(1)} h` : `${n.toFixed(1)} mi`;
  }

  function safeRankName(title) {
    return String(title || '').trim() || 'Recruit';
  }

  function fallbackRankIcon(rankIconKey) {
    const key = String(rankIconKey || '').trim().toLowerCase();
    if (/legend|mythic|immortal/.test(key)) return '🌟';
    if (/general|brigadier/.test(key)) return '⭐';
    if (/colonel|major|captain|lieutenant/.test(key)) return '🎖️';
    if (/sergeant|corporal|private|recruit/.test(key)) return '🛡️';
    return '🏅';
  }

  function renderRankIcon(rankIconKey) {
    if (typeof window.renderRankBadgeIcon === 'function') {
      return window.renderRankBadgeIcon(rankIconKey, { compact: true });
    }
    return `<span class="leaderboardRankIconFallback" aria-hidden="true">${fallbackRankIcon(rankIconKey)}</span>`;
  }

  function levelTitleLine(level, title, rankIconKey) {
    const n = Number(level);
    const safeLevel = Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
    const safeTitle = safeRankName(title);
    return `<span class="leaderboardTierLine">${renderRankIcon(rankIconKey)}<span>Level ${safeLevel} <span class="leaderboardRankName">${esc(safeTitle)}</span></span></span>`;
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
        ${block('Today', 'daily')}
        ${block('Week', 'weekly')}
        ${block('Month', 'monthly')}
        ${block('Year', 'yearly')}
      </div>`;
  }

  function renderLevelRange(startLevel, endLevel) {
    const start = Number(startLevel);
    const end = Number(endLevel);
    if (!Number.isFinite(start) && !Number.isFinite(end)) return 'Levels —';
    if (Number.isFinite(start) && Number.isFinite(end) && Math.floor(start) === Math.floor(end)) return `Level ${Math.floor(start)}`;
    if (!Number.isFinite(start)) return `Up to Level ${Math.floor(end)}`;
    if (!Number.isFinite(end)) return `Level ${Math.floor(start)}+`;
    return `Levels ${Math.floor(start)}–${Math.floor(end)}`;
  }

  function pickMyProgressionForLadder() {
    const myLevel = Number(state.myRow?.level);
    const safeLevel = Number.isFinite(myLevel) && myLevel > 0 ? Math.floor(myLevel) : 1;
    const ladder = Array.isArray(state.rankLadder) ? state.rankLadder : [];
    const matched = ladder.find((row) => {
      const start = Number(row?.start_level);
      const end = Number(row?.end_level);
      return Number.isFinite(start) && Number.isFinite(end) && safeLevel >= start && safeLevel <= end;
    }) || null;
    return {
      level: safeLevel,
      rankName: safeRankName(state.myRow?.rank_name || state.myRow?.title || matched?.rank_name || 'Recruit'),
      rankIconKey: state.myRow?.rank_icon_key || matched?.rank_icon_key || 'recruit',
    };
  }

  function renderRankLadderView() {
    const ladder = Array.isArray(state.rankLadder) ? state.rankLadder : [];
    const mine = pickMyProgressionForLadder();
    const rows = ladder.map((row) => {
      const start = Number(row?.start_level);
      const end = Number(row?.end_level);
      const isCurrent = Number.isFinite(start) && Number.isFinite(end) && mine.level >= start && mine.level <= end;
      return `<div class="leaderboardRankLadderRow${isCurrent ? ' current' : ''}">
        <div class="leaderboardRankLadderIcon">${renderRankIcon(row?.rank_icon_key)}</div>
        <div class="leaderboardRankLadderText">
          <div class="leaderboardRankLadderTitle">${esc(safeRankName(row?.rank_name || row?.title))}</div>
          <div class="leaderboardRankLadderRange">${esc(renderLevelRange(row?.start_level, row?.end_level))}</div>
        </div>
        ${isCurrent ? '<span class="leaderboardRankLadderChip">You are here</span>' : ''}
      </div>`;
    }).join('');
    return `<div class="leaderboardRanksWrap">
      <div class="myRankCard">
        <div class="leaderboardSectionTitle">My Progression</div>
        <div class="myRankRow"><span>${renderRankIcon(mine.rankIconKey)} ${esc(mine.rankName)}</span><span>Level ${mine.level}</span></div>
      </div>
      <div class="leaderboardRankLadderList">${rows || '<div class="leaderboardEmpty">Rank ladder unavailable.</div>'}</div>
    </div>`;
  }

  async function loadRankLadder() {
    try {
      const res = await getAuth('/leaderboard/ranks');
      const rows = Array.isArray(res?.rows) ? res.rows : null;
      state.rankLadder = rows && rows.length ? rows : RANK_LADDER_FALLBACK.slice();
    } catch (_) {
      state.rankLadder = RANK_LADDER_FALLBACK.slice();
    }
    state.rankLadderLoaded = true;
    return state.rankLadder;
  }

  function leaderboardPanelHTML() {
    const metricBtn = (m, label) => `<button class="chipBtn ${(state.view !== 'ranks' && state.metric === m) ? 'active' : ''}" data-lb-metric="${m}">${label}</button>`;
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
          ${levelTitleLine(row?.level, row?.rank_name || row?.title, row?.rank_icon_key)}
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
        <div class="myRankRow"><span>Progression</span><span>${levelTitleLine(state.myRow?.level, state.myRow?.rank_name || state.myRow?.title, state.myRow?.rank_icon_key)}</span></div>
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
        <div class="leaderboardSectionTitle">See All Users</div>
        <div class="leaderboardList leaderboardAllList">${allRows || '<div class="leaderboardEmpty">No entries yet.</div>'}</div>
      </div>`;

    return `
      <div class="panelBlock leaderboardPanelWrap">
        <div class="leaderboardPanelControls">
          <div class="leaderboardTabs leaderboardViewTabs">${viewBtn('top', 'Overview')}${viewBtn('all', 'See All Users')}${viewBtn('ranks', 'Ranks')}</div>
          ${state.view === 'ranks' ? '' : `<div class="leaderboardTabs">${metricBtn('miles', 'Miles')}${metricBtn('hours', 'Hours')}</div>`}
          ${state.view === 'ranks' ? '' : `<div class="leaderboardTabs">${periodBtn('daily', 'Daily')}${periodBtn('weekly', 'Weekly')}${periodBtn('monthly', 'Monthly')}${periodBtn('yearly', 'Yearly')}</div>`}
        </div>
        <div class="leaderboardPanelBody">
          ${state.view === 'all' ? allView : (state.view === 'ranks' ? renderRankLadderView() : topView)}
        </div>

        <div id="lbStatus" class="leaderboardStatus ${state.statusType}">${esc(state.status || '')}</div>
      </div>`;
  }

  function rerenderIfOpen() {
    if (getOpenPanelKeyFn() !== PANEL_KEY) return;
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
      state.rankLadder = RANK_LADDER_FALLBACK.slice();
      state.rankLadderLoaded = true;
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
      if (!state.rankLadderLoaded) {
        await loadRankLadder().catch(() => RANK_LADDER_FALLBACK.slice());
      }
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
      if (!state.rankLadderLoaded) {
        state.rankLadder = RANK_LADDER_FALLBACK.slice();
        state.rankLadderLoaded = true;
      }
      state.status = `Unable to load leaderboard: ${String(err?.message || err)}`;
      state.statusType = 'err';
      markLeaderboardOpenError(err);
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
        state.view = 'top';
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
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const nextView = btn.getAttribute('data-lb-view') || 'top';
        if (state.view === nextView) return;
        state.view = (nextView === 'all' || nextView === 'ranks') ? nextView : 'top';
        rerenderIfOpen();
        if (state.view === 'ranks' && !state.rankLadderLoaded) {
          await loadRankLadder();
          rerenderIfOpen();
        }
      });
    });
  }

  function injectLeaderboardProgressionStyles() {
    if (document.getElementById('leaderboardProgressionStyles')) return;
    const style = document.createElement('style');
    style.id = 'leaderboardProgressionStyles';
    style.textContent = `
      .leaderboardNameWrap{display:flex;flex-direction:column;min-width:0}
      .leaderboardTierLine{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:700;color:#475569;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .leaderboardRankName{color:#334155}
      .leaderboardRankIconFallback{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;font-size:13px;line-height:1}
      .leaderboardTierLine .rankBadgeIconWrap.compact{width:18px;height:18px;flex:0 0 auto;box-shadow:inset 0 0 0 1px rgba(255,255,255,.35),0 1px 4px rgba(2,6,23,.2)}
      .leaderboardTierLine .rankBadgeIconWrap.compact svg{width:16px;height:16px}
      body:has(#dockDrawer .leaderboardPanelWrap) #dockBackdrop{z-index:9050;background:rgba(0,0,0,.12)}
      #dockDrawer:has(.leaderboardPanelWrap){
        left:50%;
        top:clamp(54px,8dvh,86px);
        bottom:calc(env(safe-area-inset-bottom,0px) + 108px);
        width:min(363px,94vw);
        max-height:none;
        height:auto;
        z-index:9100;
        transform:translate(-50%,16px);
        opacity:0;
        pointer-events:none;
      }
      #dockDrawer:has(.leaderboardPanelWrap).open{transform:translate(-50%,0);opacity:1;pointer-events:auto}
      .leaderboardPanelWrap{gap:7px;max-height:min(69vh,552px);overflow:hidden;padding:8px}
      .leaderboardPanelControls{display:flex;flex-direction:column;gap:5px;flex:0 0 auto}
      .leaderboardTabs .chipBtn{justify-content:center}
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
      .leaderboardViewTabs .chipBtn{flex:1 1 0}
      .leaderboardRanksWrap{display:flex;flex-direction:column;gap:7px;min-height:0}
      .leaderboardRankLadderList{display:flex;flex-direction:column;gap:6px;overflow-y:auto;padding-right:2px}
      .leaderboardRankLadderRow{display:flex;align-items:center;gap:10px;border:1px solid #dbe4ee;background:#f8fbff;border-radius:12px;padding:8px 9px}
      .leaderboardRankLadderRow.current{border-color:#7dd3fc;background:linear-gradient(120deg,#ecfeff,#eff6ff);box-shadow:0 0 0 1px rgba(56,189,248,.3),0 0 16px rgba(14,165,233,.2)}
      .leaderboardRankLadderIcon{flex:0 0 auto;display:grid;place-items:center}
      .leaderboardRankLadderIcon .rankBadgeIconWrap.compact{width:34px;height:34px}
      .leaderboardRankLadderIcon .rankBadgeIconWrap.compact svg{width:24px;height:24px}
      .leaderboardRankLadderText{min-width:0;display:flex;flex-direction:column;gap:1px}
      .leaderboardRankLadderTitle{font:800 13px/1.2 system-ui;color:#0f172a}
      .leaderboardRankLadderRange{font:700 11px/1.2 system-ui;color:#475569}
      .leaderboardRankLadderChip{margin-left:auto;font:800 10px/1 system-ui;padding:5px 7px;border-radius:999px;background:#0ea5e9;color:#ecfeff;white-space:nowrap}
    `;
    document.head.appendChild(style);
  }

  function openLeaderboardPanel() {
    const openDrawerFn = getOpenDrawerFn();
    if (typeof openDrawerFn !== 'function') {
      markLeaderboardOpenError('openDrawer unavailable');
      return false;
    }
    try {
      openDrawerFn(PANEL_KEY, 'Leaderboard', leaderboardPanelHTML());
      wireLeaderboardPanel();
      markLeaderboardOpened();
      void loadAll();
      return true;
    } catch (error) {
      markLeaderboardOpenError(error);
      console.warn('Failed to open leaderboard drawer', error);
      return false;
    }
  }

  function init() {
    injectLeaderboardProgressionStyles();
    markLeaderboardLoaded();
    const btn = document.getElementById('dockLeaderboard');
    if (!btn || typeof bindDockToggleFn !== 'function') return;
    if (btn.dataset.leaderboardBound === '1') return;
    btn.dataset.leaderboardBound = '1';
  }

  window.LeaderboardPanel = {
    init,
    open: openLeaderboardPanel,
    refresh: loadAll,
  };

  init();
})();