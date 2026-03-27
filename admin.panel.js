(function () {
  const runtime = window.FrontendRuntime || null;
  const DEFAULT_API_BASE = 'https://web-production-78f67.up.railway.app';
  const components = () => window.AdminComponents || {};

  const state = {
    me: null,
    token: '',
    isOpen: false,
    activeTab: 'dashboard',
    tabCache: {},
    loadingTab: null,
    actions: null,
    tabCleanup: null,
  };

  const tabs = [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'users', label: 'Users' },
    { key: 'live', label: 'Live' },
    { key: 'reports', label: 'Reports' },
    { key: 'system', label: 'System' },
    { key: 'trips', label: 'Trips' },
    { key: 'tests', label: 'Tests' },
  ];

  let root;
  let launcher;
  let bodyEl;
  let tabsEl;
  let titleEl;

  function esc(value) {
    return (components().esc || String)(value ?? '').toString()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function isAdmin() {
    return !!state?.me?.is_admin;
  }

  function authRequest(path, options = {}) {
    if (runtime?.requestJSONDetailed) {
      return runtime.requestJSONDetailed(path, {
        method: options.method || 'GET',
        body: options.body,
        token: state.token,
        headers: { Accept: 'application/json', ...(options.headers || {}) },
      });
    }
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    const base = runtime?.resolveApiBase
      ? runtime.resolveApiBase()
      : (() => {
          if (typeof window !== 'undefined' && window.API_BASE !== undefined) {
            const apiBase = String(window.API_BASE || '').trim();
            if (apiBase) return apiBase.replace(/\/+$/, '');
          }
          const runtimeConfigApiBase = String(window.__TLC_RUNTIME_CONFIG__?.apiBase || '').trim();
          if (runtimeConfigApiBase) return runtimeConfigApiBase.replace(/\/+$/, '');
          return DEFAULT_API_BASE;
        })();

    const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;

    return fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    }).then(async (res) => {
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ''}`);
      }
      const type = res.headers.get('content-type') || '';
      if (type.includes('application/json')) return res.json();
      return null;
    });
  }

  function ensureDom() {
    if (root && launcher) return;

    launcher = document.createElement('button');
    launcher.id = 'adminPortalLauncher';
    launcher.className = 'adminPortalLauncher';
    launcher.type = 'button';
    launcher.textContent = 'Admin';
    launcher.hidden = true;
    launcher.addEventListener('click', () => open());
    document.body.appendChild(launcher);

    root = document.createElement('div');
    root.id = 'adminPortalRoot';
    root.className = 'adminPortal';
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = `
      <div class="adminPanel">
        <div class="adminPanelHeader">
          <h2 id="adminPanelTitle">Admin Portal</h2>
          <div class="adminHeaderActions">
            <button type="button" id="adminPanelRefresh" class="adminBtn">Refresh</button>
            <button type="button" id="adminPanelClose" class="adminBtn">Close</button>
          </div>
        </div>
        <div id="adminPanelTabs" class="adminTabs"></div>
        <div id="adminPanelBody" class="adminPanelBody"></div>
      </div>
    `;

    root.addEventListener('click', (e) => {
      if (e.target === root) close();
    });

    document.body.appendChild(root);

    bodyEl = root.querySelector('#adminPanelBody');
    tabsEl = root.querySelector('#adminPanelTabs');
    titleEl = root.querySelector('#adminPanelTitle');

    root.querySelector('#adminPanelClose')?.addEventListener('click', () => close());
    root.querySelector('#adminPanelRefresh')?.addEventListener('click', () => refreshAll());

    drawTabs();
    refreshVisibility();
  }

  function drawTabs() {
    tabsEl.innerHTML = tabs
      .map((t) => `<button type="button" class="adminTabBtn${state.activeTab === t.key ? ' active' : ''}" data-tab="${t.key}">${esc(t.label)}</button>`)
      .join('');
    tabsEl.querySelectorAll('.adminTabBtn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.activeTab = btn.dataset.tab;
        drawTabs();
        renderActiveTab({ force: false });
      });
    });
  }

  function setBodyLoading(tab) {
    state.loadingTab = tab;
    bodyEl.innerHTML = `<div class="adminLoading">Loading ${esc(tab)}…</div>`;
  }

  function setBodyError(message) {
    bodyEl.innerHTML = `<div class="adminError">${esc(message || 'Failed to load data.')}</div>`;
  }

  function setBodyEmpty(message) {
    bodyEl.innerHTML = `<div class="adminEmpty">${esc(message || 'No data available.')}</div>`;
  }

  function renderDashboard(data) {
    const c = components();
    const d = data || {};
    const adminCount = d.admin_users ?? d.admins_count ?? 0;
    const policeRecentCount = d.police_reports_recent_count ?? d.police_reports_count ?? 0;
    const pickupRecentCount = d.pickup_logs_recent_count ?? d.pickup_logs_count ?? 0;
    const voidedPickupRecentCount = d.pickup_logs_voided_recent_count ?? null;
    const leaderboard = d.leaderboard_status || d.leaderboard;
    const leaderboardLines = typeof leaderboard === 'object' && leaderboard
      ? c.keyValueRows(leaderboard)
      : `<div class="adminKV"><span>Status</span><strong>${esc(c.formatValue ? c.formatValue(leaderboard) : leaderboard || '—')}</strong></div>`;

    bodyEl.innerHTML = `
      <div class="adminGrid">
        ${(c.statCard ? c.statCard('Total Users', d.total_users) : '')}
        ${(c.statCard ? c.statCard('Online Users', d.online_users) : '')}
        ${(c.statCard ? c.statCard('Ghosted Online', d.ghosted_online_users) : '')}
        ${(c.statCard ? c.statCard('Recent Police Reports', policeRecentCount) : '')}
        ${(c.statCard ? c.statCard('Active Pickup Logs', pickupRecentCount) : '')}
        ${(c.statCard ? c.statCard('Admins', adminCount) : '')}
        ${(voidedPickupRecentCount !== null && c.statCard ? c.statCard('Voided Pickup Logs', voidedPickupRecentCount) : '')}
        ${(c.statCard ? c.statCard('Timeline Ready', c.boolText ? c.boolText(!!d.timeline_ready, 'Ready', 'Not Ready') : d.timeline_ready) : '')}
        ${(c.statCard ? c.statCard('Frame Status', d.frame_count || d.frame_status || d.frame_ready || '—') : '')}
      </div>
      <div class="adminSection">
        <h4>Leaderboard Status</h4>
        ${leaderboardLines}
      </div>
      ${(c.collapsible ? c.collapsible('Advanced Diagnostics', `<pre class="adminPre">${esc(JSON.stringify(d, null, 2))}</pre>`) : '')}
    `;
  }

  function helpers() {
    return {
      request: authRequest,
      actions: state.actions,
      components: window.AdminComponents,
      onMutate: () => {
        state.tabCache = {};
      },
      registerCleanup: (cleanup) => {
        state.tabCleanup = typeof cleanup === 'function' ? cleanup : null;
      },
    };
  }

  async function renderActiveTab({ force }) {
    if (!bodyEl) return;
    if (!isAdmin()) {
      setBodyError('Admin access required.');
      return;
    }

    const key = state.activeTab;
    titleEl.textContent = `Admin Portal • ${tabs.find((t) => t.key === key)?.label || 'Dashboard'}`;

    if (!force && state.tabCache[key]) {
      paintTab(key, state.tabCache[key]);
      return;
    }

    try {
      setBodyLoading(key);
      let payload;
      if (key === 'dashboard') payload = await authRequest('/admin/summary');
      if (key === 'users') payload = await authRequest('/admin/users');
      if (key === 'live') payload = await authRequest('/admin/live');
      if (key === 'reports') {
        const [police, pickups] = await Promise.all([
          authRequest('/admin/reports/police'),
          authRequest('/admin/reports/pickups'),
        ]);
        payload = { police, pickups };
      }
      if (key === 'system') payload = await authRequest('/admin/system');
      if (key === 'trips') {
        const [summary, recent] = await Promise.all([
          authRequest('/admin/trips/summary'),
          authRequest('/admin/trips/recent?limit=20&include_voided=1'),
        ]);
        payload = { summary, recent };
      }
      if (key === 'tests') payload = {};

      state.tabCache[key] = payload;
      paintTab(key, payload);
    } catch (err) {
      setBodyError(err?.message || `Unable to load ${key}.`);
    } finally {
      state.loadingTab = null;
    }
  }

  function runTabCleanup() {
    if (typeof state.tabCleanup === 'function') {
      try {
        state.tabCleanup();
      } catch (_error) {
        // no-op cleanup guard
      }
    }
    state.tabCleanup = null;
  }

  function paintTab(key, payload) {
    runTabCleanup();
    const h = helpers();
    if (key === 'dashboard') {
      renderDashboard(payload);
      return;
    }
    if (key === 'users') return window.AdminUsers?.renderAdminUsers ? window.AdminUsers.renderAdminUsers(bodyEl, payload, h) : setBodyError('Admin users module failed to load.');
    if (key === 'live') return window.AdminLive?.renderAdminLive ? window.AdminLive.renderAdminLive(bodyEl, payload, h) : setBodyError('Admin live module failed to load.');
    if (key === 'reports') return window.AdminReports?.renderAdminReports ? window.AdminReports.renderAdminReports(bodyEl, payload?.police, payload?.pickups, h) : setBodyError('Admin reports module failed to load.');
    if (key === 'system') return window.AdminSystem?.renderAdminSystem ? window.AdminSystem.renderAdminSystem(bodyEl, payload, h) : setBodyError('Admin system module failed to load.');
    if (key === 'trips') return window.AdminTrips?.renderAdminTrips ? window.AdminTrips.renderAdminTrips(bodyEl, payload, h) : setBodyError('Admin trips module failed to load.');
    if (key === 'tests') {
      console.info('Admin tests tab rendered');
      return window.AdminTests?.renderAdminTests ? window.AdminTests.renderAdminTests(bodyEl, payload, { ...h, session: { me: state.me } }) : setBodyError('Admin tests module failed to load.');
    }

    setBodyEmpty('Unknown tab.');
  }

  function open() {
    ensureDom();
    if (!isAdmin()) {
      root.classList.add('open');
      root.setAttribute('aria-hidden', 'false');
      setBodyError('Admin access required.');
      return;
    }
    state.isOpen = true;
    root.classList.add('open');
    root.setAttribute('aria-hidden', 'false');
    drawTabs();
    renderActiveTab({ force: false });
  }

  function close() {
    if (!root) return;
    runTabCleanup();
    state.isOpen = false;
    root.classList.remove('open');
    root.setAttribute('aria-hidden', 'true');
  }

  function refreshAll() {
    runTabCleanup();
    state.tabCache = {};
    if (state.isOpen) {
      renderActiveTab({ force: true });
    }
  }

  function setSession(next) {
    state.me = next?.me || null;
    state.token = next?.token || '';
    state.actions = window.AdminActions?.createAdminActions(authRequest) || null;
    refreshVisibility();
    if (state.isOpen) {
      if (!isAdmin()) {
        setBodyError('Admin access required.');
      } else {
        renderActiveTab({ force: true });
      }
    }
  }

  function refreshVisibility() {
    ensureDom();
    const show = isAdmin();
    launcher.hidden = !show;
    if (!show && state.isOpen) close();
  }

  function init(initialSession) {
    ensureDom();
    state.actions = window.AdminActions?.createAdminActions(authRequest) || null;
    if (initialSession) setSession(initialSession);
    refreshVisibility();
  }

  window.AdminPortal = {
    init,
    open,
    close,
    refresh: refreshAll,
    refreshAll,
    setSession,
    refreshVisibility,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init());
  } else {
    init();
  }
})();
