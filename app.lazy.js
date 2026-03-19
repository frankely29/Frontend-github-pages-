(function () {
  const loadedGroups = new Map();
  let leaderboardReadyPromise = null;
  const scriptGroups = {
    leaderboard: [
      './app.part3.js?v=railway3',
    ],
    admin: [
      './admin.components.js?v=adminv3',
      './admin.actions.js?v=adminv3',
      './admin.users.js?v=adminv3',
      './admin.live.js?v=adminv3',
      './admin.reports.js?v=adminv3',
      './admin.system.js?v=adminv3',
      './admin.trips.js?v=adminv3',
      './admin.tests.js?v=adminv3',
      './admin.panel.js?v=adminv3',
    ],
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

  function getLeaderboardPanel() {
    return typeof window.LeaderboardPanel?.open === 'function' ? window.LeaderboardPanel : null;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[data-lazy-src="${src}"]`);
      if (existing?.dataset.loaded === '1') {
        resolve();
        return;
      }
      if (existing) {
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.dataset.lazySrc = src;
      script.addEventListener('load', () => {
        script.dataset.loaded = '1';
        resolve();
      }, { once: true });
      script.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
      document.body.appendChild(script);
    });
  }

  async function loadFrontendModuleGroup(groupName) {
    const key = String(groupName || '').trim();
    if (!scriptGroups[key]) throw new Error(`Unknown frontend module group: ${key}`);
    if (!loadedGroups.has(key)) {
      loadedGroups.set(key, (async () => {
        if (key === 'leaderboard') {
          const debugState = leaderboardPerfDebugState();
          debugState.loadAttempts = Number(debugState.loadAttempts || 0) + 1;
          console.info('leaderboard lazy load started');
        }
        for (const src of scriptGroups[key]) {
          await loadScript(src);
        }
        if (key === 'leaderboard') {
          const debugState = leaderboardPerfDebugState();
          debugState.loaded = typeof window.LeaderboardPanel?.open === 'function';
          debugState.lastError = debugState.loaded ? '' : 'Leaderboard module loaded without open()';
          console.info('leaderboard lazy load resolved');
        }
        if (key === 'admin' && typeof window.syncAdminPortalSession === 'function') {
          window.syncAdminPortalSession();
        }
      })().catch((error) => {
        if (key === 'leaderboard') {
          const debugState = leaderboardPerfDebugState();
          debugState.loaded = false;
          debugState.lastError = String(error?.message || error || 'Failed to load leaderboard module group');
        }
        loadedGroups.delete(key);
        throw error;
      }));
    }
    return loadedGroups.get(key);
  }

  async function ensureLeaderboardPanelReady() {
    const debugState = leaderboardPerfDebugState();
    const readyPanel = getLeaderboardPanel();
    if (readyPanel) {
      debugState.loaded = true;
      debugState.lastError = '';
      return readyPanel;
    }
    if (!leaderboardReadyPromise) {
      leaderboardReadyPromise = (async () => {
        await loadFrontendModuleGroup('leaderboard');
        const loadedPanel = getLeaderboardPanel();
        if (!loadedPanel) {
          const error = new Error('Leaderboard module missing open() after lazy load');
          debugState.loaded = false;
          debugState.lastError = error.message;
          console.error('leaderboard module missing open()');
          throw error;
        }
        debugState.loaded = true;
        debugState.lastError = '';
        return loadedPanel;
      })().catch((error) => {
        leaderboardReadyPromise = null;
        debugState.loaded = false;
        debugState.lastError = String(error?.message || error || 'Failed to prepare leaderboard module');
        console.error('leaderboard lazy load failed', error);
        throw error;
      });
    }
    return leaderboardReadyPromise;
  }

  function wireDeferredDockButton(buttonId, groupName, onLoaded) {
    const button = document.getElementById(buttonId);
    if (!button || button.dataset.lazyLoaderBound === '1') return;
    button.dataset.lazyLoaderBound = '1';
    button.addEventListener('click', async (event) => {
      const alreadyReady = groupName === 'leaderboard'
        ? typeof window.LeaderboardPanel?.open === 'function'
        : typeof window.AdminPortal?.open === 'function';
      if (alreadyReady) return;
      event.preventDefault();
      event.stopPropagation();
      try {
        await loadFrontendModuleGroup(groupName);
        await onLoaded?.();
      } catch (error) {
        console.warn(`Failed to lazy-load ${groupName} modules`, error);
      }
    }, true);
  }

  function wireLeaderboardDockButton(buttonId) {
    const button = document.getElementById(buttonId);
    if (!button || button.dataset.leaderboardLazyBound === '1') return;
    button.dataset.leaderboardLazyBound = '1';
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      try {
        const panel = await ensureLeaderboardPanelReady();
        if (typeof panel?.open !== 'function') {
          console.error('leaderboard module missing open()');
          return;
        }
        console.info('leaderboard open invoked');
        panel.open();
      } catch (error) {
        console.error('leaderboard open failed', error);
      }
    }, true);
  }

  function preloadModuleGroup(groupName) {
    if (!window.requestIdleCallback) {
      setTimeout(() => {
        loadFrontendModuleGroup(groupName).catch(() => {});
      }, 180);
      return;
    }
    window.requestIdleCallback(() => {
      loadFrontendModuleGroup(groupName).catch(() => {});
    }, { timeout: 1500 });
  }

  function wireLeaderboardPreload(buttonId) {
    const button = document.getElementById(buttonId);
    if (!button || button.dataset.lazyPreloadBound === '1') return;
    button.dataset.lazyPreloadBound = '1';
    const preload = () => ensureLeaderboardPanelReady().catch(() => {});
    button.addEventListener('pointerenter', preload, { once: true, passive: true });
    button.addEventListener('focus', preload, { once: true, passive: true });
    button.addEventListener('touchstart', preload, { once: true, passive: true });
  }

  wireLeaderboardPreload('dockLeaderboard');
  wireLeaderboardDockButton('dockLeaderboard');

  wireDeferredDockButton('dockAdmin', 'admin', async () => {
    window.syncAdminPortalSession?.();
    window.AdminPortal?.open?.();
  });

  window.ensureLeaderboardPanelReady = ensureLeaderboardPanelReady;
  window.loadFrontendModuleGroup = loadFrontendModuleGroup;
})();
