/*
 * app.part3.js
 * Leaderboard + badges + report preferences panel.
 */
(function () {
  const LS_TOKEN = 'community_token_v1';
  const PANEL_KEY = 'leaderboard';

  const state = {
    metric: 'miles',
    period: 'weekly',
    list: [],
    myRank: null,
    myBadges: null,
    prefs: { weekly: false, monthly: false, yearly: false },
    status: '',
    statusType: '',
    loading: false,
  };

  function getToken() {
    try { return localStorage.getItem(LS_TOKEN) || ''; } catch (_) { return ''; }
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

  async function postAuth(path, body) {
    if (typeof window.postJSON === 'function') return window.postJSON(path, body, getToken());
    const headers = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetchJSON(`${apiBase()}${path}`, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  }

  function esc(v) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(v);
    return String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }

  function fmtValue(val) {
    const num = Number(val);
    if (!Number.isFinite(num)) return '—';
    if (state.metric === 'hours') return `${num.toFixed(1)} h`;
    return `${num.toFixed(1)} mi`;
  }

  function inferBadge(rank, rowBadge) {
    const b = String(rowBadge || '').toLowerCase();
    if (b.includes('crown')) return 'crown';
    if (b.includes('gold')) return 'gold';
    if (b.includes('silver')) return 'silver';
    if (b.includes('ruby')) return 'ruby';
    if (rank === 1) return 'crown';
    if (rank === 2) return 'gold';
    if (rank === 3) return 'silver';
    return '';
  }

  function badgeChip(badge) {
    if (!badge) return '';
    const meta = {
      crown: { txt: '👑 Crown', cls: 'badge-crown' },
      gold: { txt: '🥇 Gold', cls: 'badge-gold' },
      silver: { txt: '🥈 Silver', cls: 'badge-silver' },
      ruby: { txt: '♦ Ruby', cls: 'badge-ruby' },
    }[badge];
    if (!meta) return '';
    return `<span class="badgeChip ${meta.cls}">${meta.txt}</span>`;
  }

  function currentUserBadge() {
    const mb = state.myBadges || {};
    const candidates = [
      mb.current_badge,
      mb[`${state.metric}_${state.period}`],
      mb[state.metric],
      mb[state.period],
      mb.badge,
    ].filter(Boolean);
    const found = candidates.map((c) => inferBadge(0, c)).find(Boolean);
    if (found) return found;
    return inferBadge(Number(state.myRank?.rank || 0), state.myRank?.badge);
  }

  function leaderboardPanelHTML() {
    const metricBtn = (m, label) => `<button class="chipBtn ${state.metric === m ? 'active' : ''}" data-lb-metric="${m}">${label}</button>`;
    const periodBtn = (p, label) => `<button class="chipBtn ${state.period === p ? 'active' : ''}" data-lb-period="${p}">${label}</button>`;

    const rows = (state.list || []).slice(0, 10).map((r, i) => {
      const rank = Number(r.rank || i + 1);
      const name = r.display_name || r.name || r.user_name || `Driver ${rank}`;
      const value = r.value ?? r.metric_value ?? r.total ?? r[state.metric];
      const badge = inferBadge(rank, r.badge);
      return `<div class="leaderboardRow">
        <span class="leaderboardRank">#${rank}</span>
        <span class="leaderboardName" title="${esc(name)}">${esc(name)}</span>
        <span class="leaderboardValue">${fmtValue(value)}</span>
        ${badgeChip(badge)}
      </div>`;
    }).join('');

    const meRank = Number(state.myRank?.rank || 0);
    const meName = state.myRank?.display_name || state.myRank?.name || (window.me && window.me.display_name) || 'You';
    const meValue = state.myRank?.value ?? state.myRank?.metric_value ?? state.myRank?.total ?? state.myRank?.[state.metric];
    const myBadge = currentUserBadge();

    return `
      <div class="panelBlock leaderboardPanelWrap">
        <div class="leaderboardTabs">${metricBtn('miles', 'Miles')}${metricBtn('hours', 'Hours')}</div>
        <div class="leaderboardTabs">${periodBtn('daily', 'Daily')}${periodBtn('weekly', 'Weekly')}${periodBtn('monthly', 'Monthly')}${periodBtn('yearly', 'Yearly')}</div>

        <div>
          <div style="font:900 11px/1.2 system-ui;margin-bottom:5px;">Top 10</div>
          <div class="leaderboardList">${rows || '<div class="leaderboardEmpty">No entries yet.</div>'}</div>
        </div>

        <div class="myRankCard">
          <div style="font:900 11px/1.2 system-ui;">My Rank</div>
          <div class="myRankRow"><span>${esc(meName)}</span><span>${meRank ? `#${meRank}` : 'Unranked'}</span></div>
          <div class="myRankRow"><span>${state.metric === 'hours' ? 'Hours' : 'Miles'}</span><span>${fmtValue(meValue)}</span></div>
          <div class="myRankRow"><span>Badge</span><span>${badgeChip(myBadge) || '—'}</span></div>
        </div>

        <div>
          <div style="font:900 11px/1.2 system-ui;margin-bottom:5px;">Badge legend</div>
          <div class="leaderboardLegend">${badgeChip('crown')}${badgeChip('gold')}${badgeChip('silver')}${badgeChip('ruby')}</div>
        </div>

        <div>
          <div style="font:900 11px/1.2 system-ui;margin-bottom:6px;">Email report settings</div>
          <div class="prefsGrid">
            <label class="prefsRow"><span>Weekly reports</span><input id="lbPrefWeekly" type="checkbox" ${state.prefs.weekly ? 'checked' : ''}></label>
            <label class="prefsRow"><span>Monthly reports</span><input id="lbPrefMonthly" type="checkbox" ${state.prefs.monthly ? 'checked' : ''}></label>
            <label class="prefsRow"><span>Yearly reports</span><input id="lbPrefYearly" type="checkbox" ${state.prefs.yearly ? 'checked' : ''}></label>
            <div style="display:flex;justify-content:flex-end;"><button id="lbSavePrefs" class="chipBtn">Save</button></div>
          </div>
          <div id="lbStatus" class="leaderboardStatus ${state.statusType}">${esc(state.status || '')}</div>
        </div>
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
      state.list = [];
      state.myRank = null;
      state.myBadges = null;
      state.status = 'Sign in to view leaderboard.';
      state.statusType = 'err';
      rerenderIfOpen();
      return;
    }

    state.loading = true;
    state.status = 'Loading…';
    state.statusType = '';
    rerenderIfOpen();

    const qs = `metric=${encodeURIComponent(state.metric)}&period=${encodeURIComponent(state.period)}&limit=10`;
    try {
      const [lb, mine, badges, prefs] = await Promise.all([
        getAuth(`/leaderboard?${qs}`),
        getAuth(`/leaderboard/me?metric=${encodeURIComponent(state.metric)}&period=${encodeURIComponent(state.period)}`),
        getAuth('/leaderboard/badges/me').catch(() => ({})),
        getAuth('/leaderboard/email_prefs').catch(() => ({})),
      ]);

      state.list = Array.isArray(lb) ? lb : (lb?.rows || lb?.items || []);
      state.myRank = mine?.data || mine || null;
      state.myBadges = badges?.data || badges || null;
      const p = prefs?.data || prefs || {};
      state.prefs = {
        weekly: !!(p.weekly ?? p.weekly_reports ?? p.weekly_enabled),
        monthly: !!(p.monthly ?? p.monthly_reports ?? p.monthly_enabled),
        yearly: !!(p.yearly ?? p.yearly_reports ?? p.yearly_enabled),
      };
      state.status = '';
      state.statusType = '';
    } catch (err) {
      state.status = `Unable to load leaderboard: ${String(err.message || err)}`;
      state.statusType = 'err';
    } finally {
      state.loading = false;
      rerenderIfOpen();
    }
  }

  async function savePrefs() {
    state.status = 'Saving…';
    state.statusType = '';
    rerenderIfOpen();

    const payload = {
      weekly: !!state.prefs.weekly,
      monthly: !!state.prefs.monthly,
      yearly: !!state.prefs.yearly,
      weekly_reports: !!state.prefs.weekly,
      monthly_reports: !!state.prefs.monthly,
      yearly_reports: !!state.prefs.yearly,
    };

    try {
      await postAuth('/leaderboard/email_prefs', payload);
      state.status = 'Email report settings updated.';
      state.statusType = 'ok';
    } catch (err) {
      state.status = `Save failed: ${String(err.message || err)}`;
      state.statusType = 'err';
    }
    rerenderIfOpen();
  }

  function wireLeaderboardPanel() {
    document.querySelectorAll('[data-lb-metric]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const next = btn.getAttribute('data-lb-metric') || 'miles';
        if (state.metric === next) return;
        state.metric = next;
        loadAll();
      });
    });

    document.querySelectorAll('[data-lb-period]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const next = btn.getAttribute('data-lb-period') || 'weekly';
        if (state.period === next) return;
        state.period = next;
        loadAll();
      });
    });

    const weekly = document.getElementById('lbPrefWeekly');
    const monthly = document.getElementById('lbPrefMonthly');
    const yearly = document.getElementById('lbPrefYearly');
    weekly?.addEventListener('change', () => { state.prefs.weekly = !!weekly.checked; });
    monthly?.addEventListener('change', () => { state.prefs.monthly = !!monthly.checked; });
    yearly?.addEventListener('change', () => { state.prefs.yearly = !!yearly.checked; });
    document.getElementById('lbSavePrefs')?.addEventListener('click', (e) => {
      e.preventDefault();
      savePrefs();
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
