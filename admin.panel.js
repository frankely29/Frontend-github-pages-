(function () {
  const state = {
    me: null,
    token: '',
    isOpen: false,
    activeTab: 'dashboard',
    tabCache: {},
    loadingTab: null,
  };

  const tabs = [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'users', label: 'Users' },
    { key: 'live', label: 'Live' },
    { key: 'reports', label: 'Reports' },
    { key: 'system', label: 'System' },
  ];

  let root;
  let launcher;
  let bodyEl;
  let tabsEl;
  let titleEl;

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function isAdmin() {
    return !!state?.me?.is_admin;
  }

  function authFetch(path) {
  const headers = { 'Accept': 'application/json' };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  const base =
    (typeof window !== 'undefined' && window.API_BASE)
      ? String(window.API_BASE).replace(/\/+$/, '')
      : window.location.origin;

  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;

  return fetch(url, { headers }).then(async (res) => {
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ''}`);
    }
    return res.json();
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
    const d = data || {};
    const cards = [
      ['Total Users', d.total_users],
      ['Online Users', d.online_users],
      ['Ghosted Online', d.ghosted_online_users],
      ['Police Reports', d.police_reports_count],
      ['Pickup Logs', d.pickup_logs_count],
      ['Admins', d.admins_count],
      ['Leaderboard', d.leaderboard_status || d.leaderboard?.status || '—'],
      ['Timeline / Frame', `${d.timeline_ready ?? '—'} / ${d.frame_ready ?? d.frame_status ?? '—'}`],
    ];

    bodyEl.innerHTML = `
      <div class="adminGrid">
        ${cards
          .map(
            ([k, v]) => `<div class="adminCard"><div class="adminCardLabel">${esc(k)}</div><div class="adminCardValue">${esc(v ?? '—')}</div></div>`
          )
          .join('')}
      </div>
      <div class="adminSection">
        <h4>Raw Summary</h4>
        <pre class="adminPre">${esc(JSON.stringify(d, null, 2))}</pre>
      </div>
    `;
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
      if (key === 'dashboard') payload = await authFetch('/admin/summary');
      if (key === 'users') payload = await authFetch('/admin/users');
      if (key === 'live') payload = await authFetch('/admin/live');
      if (key === 'reports') {
        const [police, pickups] = await Promise.all([
          authFetch('/admin/reports/police'),
          authFetch('/admin/reports/pickups'),
        ]);
        payload = { police, pickups };
      }
      if (key === 'system') payload = await authFetch('/admin/system');

      state.tabCache[key] = payload;
      paintTab(key, payload);
    } catch (err) {
      setBodyError(err?.message || `Unable to load ${key}.`);
    } finally {
      state.loadingTab = null;
    }
  }

  function paintTab(key, payload) {
    if (key === 'dashboard') {
      renderDashboard(payload);
      return;
    }

    if (key === 'users') {
      if (window.AdminUsers?.renderAdminUsers) {
        window.AdminUsers.renderAdminUsers(bodyEl, payload, {});
      } else {
        setBodyError('Admin users module failed to load.');
      }
      return;
    }

    if (key === 'live') {
      if (window.AdminLive?.renderAdminLive) {
        window.AdminLive.renderAdminLive(bodyEl, payload, {});
      } else {
        setBodyError('Admin live module failed to load.');
      }
      return;
    }

    if (key === 'reports') {
      if (window.AdminReports?.renderAdminReports) {
        window.AdminReports.renderAdminReports(bodyEl, payload?.police, payload?.pickups, {});
      } else {
        setBodyError('Admin reports module failed to load.');
      }
      return;
    }

    if (key === 'system') {
      if (window.AdminSystem?.renderAdminSystem) {
        window.AdminSystem.renderAdminSystem(bodyEl, payload, {});
      } else {
        setBodyError('Admin system module failed to load.');
      }
      return;
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
    state.isOpen = false;
    root.classList.remove('open');
    root.setAttribute('aria-hidden', 'true');
  }

  function refreshAll() {
    state.tabCache = {};
    if (state.isOpen) {
      renderActiveTab({ force: true });
    }
  }

  function setSession(next) {
    state.me = next?.me || null;
    state.token = next?.token || '';
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
