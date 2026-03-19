(function () {
  const loadedGroups = new Map();
  const scriptGroups = {
    leaderboard: [
      './app.part3.js?v=railway3',
    ],
    admin: [
      './admin.components.js?v=adminv2',
      './admin.actions.js?v=adminv2',
      './admin.users.js?v=adminv2',
      './admin.live.js?v=adminv2',
      './admin.reports.js?v=adminv2',
      './admin.system.js?v=adminv2',
      './admin.trips.js?v=adminv2',
      './admin.tests.js?v=adminv2',
      './admin.panel.js?v=adminv2',
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
        }
        for (const src of scriptGroups[key]) {
          await loadScript(src);
        }
        if (key === 'leaderboard') {
          const debugState = leaderboardPerfDebugState();
          debugState.loaded = typeof window.LeaderboardPanel?.open === 'function';
          debugState.lastError = debugState.loaded ? '' : 'Leaderboard module loaded without open()';
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
    const preload = () => preloadModuleGroup('leaderboard');
    button.addEventListener('pointerenter', preload, { once: true, passive: true });
    button.addEventListener('focus', preload, { once: true, passive: true });
    button.addEventListener('touchstart', preload, { once: true, passive: true });
  }

  wireLeaderboardPreload('dockLeaderboard');

  wireDeferredDockButton('dockAdmin', 'admin', async () => {
    window.syncAdminPortalSession?.();
    window.AdminPortal?.open?.();
  });

  window.loadFrontendModuleGroup = loadFrontendModuleGroup;
})();
