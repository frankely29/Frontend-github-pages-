(function () {
  const state = {
    uiOpen: false,
    manualDestination: null,
    manualDestinationLabel: "",
    routeActive: false,
    routePreviewReady: false,
    externalNavUrl: "",
    lastManualQuery: "",
    status: "Idle",
    source: "manual",
  };

  function getQuickEls() {
    return {
      stack: document.getElementById("navQuickStack"),
      toggleBtn: document.getElementById("navQuickToggle"),
      toggleText: document.getElementById("navQuickToggleText"),
      tray: document.getElementById("navQuickTray"),
      input: document.getElementById("navQuickInput"),
      goBtn: document.getElementById("navQuickGo"),
      clearBtn: document.getElementById("navQuickClear"),
      meta: document.getElementById("navQuickMeta"),
    };
  }

  function normalizeDestination(dest) {
    if (!dest || typeof dest !== "object") return null;
    const lat = Number(dest.lat);
    const lng = Number(dest.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const name = String(dest.name || dest.label || dest.title || "Selected destination").trim() || "Selected destination";
    return { lat, lng, name };
  }

  function buildExternalNavUrl(dest) {
    if (!dest) return "";
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${dest.lat},${dest.lng}`)}&travelmode=driving`;
  }

  function updateExternalNav() {
    state.externalNavUrl = buildExternalNavUrl(state.manualDestination);
    if (window.TlcMapUiModule?.setManualNavDestination) {
      window.TlcMapUiModule.setManualNavDestination(state.manualDestination);
    } else {
      window.TlcMapUiModule?.setNavDestination?.(state.manualDestination, { source: "manual" });
    }
  }

  function updateMetaFromPreview() {
    const preview = window.TlcNavigationPreviewModule?.getSnapshot?.() || {};
    state.status = String(preview.status || "Idle");
    state.routePreviewReady = preview.status === "Route ready";
    state.routeActive = !!preview.hasRoute;

    const { meta } = getQuickEls();
    if (!meta) return;

    const durationSeconds = Number(preview.durationSeconds);
    const distanceMeters = Number(preview.distanceMeters);

    if (Number.isFinite(durationSeconds) && Number.isFinite(distanceMeters) && durationSeconds > 0 && distanceMeters > 0) {
      const miles = distanceMeters / 1609.344;
      const mins = Math.max(1, Math.round(durationSeconds / 60));
      const text = `${mins} min • ${miles >= 1 ? miles.toFixed(1) : miles.toFixed(2)} mi`;
      meta.hidden = false;
      meta.textContent = text;
      meta.title = text;
      return;
    }

    if (state.status && state.status !== "Idle") {
      meta.hidden = false;
      meta.textContent = state.status;
      meta.title = state.status;
      return;
    }

    meta.hidden = true;
    meta.textContent = "";
    meta.title = "";
  }

  function syncUi() {
    const { stack, toggleBtn, toggleText, tray, input } = getQuickEls();
    if (stack) {
      stack.hidden = false;
      stack.dataset.open = state.uiOpen ? "1" : "0";
    }
    if (toggleBtn) toggleBtn.setAttribute("aria-expanded", state.uiOpen ? "true" : "false");
    if (tray) tray.hidden = !state.uiOpen;
    if (toggleText) toggleText.textContent = "Navigate";
    if (input && state.manualDestinationLabel && document.activeElement !== input) {
      input.value = state.manualDestinationLabel;
    }
    updateMetaFromPreview();
  }

  function open() {
    state.uiOpen = true;
    syncUi();
  }

  function close() {
    state.uiOpen = false;
    syncUi();
  }

  function setManualDestination(dest) {
    const normalized = normalizeDestination(dest);
    if (!normalized) return null;
    state.manualDestination = normalized;
    state.manualDestinationLabel = normalized.name;
    state.routeActive = false;
    state.routePreviewReady = false;
    updateExternalNav();
    syncUi();
    return normalized;
  }

  async function searchAndPreview(query) {
    const q = String(query || "").trim();
    if (!q) {
      state.status = "Type a destination";
      updateMetaFromPreview();
      return null;
    }
    state.lastManualQuery = q;
    state.status = "Searching…";
    updateMetaFromPreview();

    const normalized = await window.TlcNavigationPreviewModule?.searchAndSetPreviewDestination?.(q);
    const accepted = setManualDestination(normalized);
    if (!accepted) {
      state.status = "Route unavailable";
      updateMetaFromPreview();
      return null;
    }

    state.status = "Preparing preview…";
    updateMetaFromPreview();
    return accepted;
  }

  function clear() {
    state.manualDestination = null;
    state.manualDestinationLabel = "";
    state.routeActive = false;
    state.routePreviewReady = false;
    state.externalNavUrl = "";
    state.status = "Idle";
    window.TlcNavigationPreviewModule?.clearPreview?.({ clearInput: true });
    updateExternalNav();
    const { input } = getQuickEls();
    if (input) input.value = "";
    close();
  }

  function getCurrentDestination() {
    return state.manualDestination ? { ...state.manualDestination } : null;
  }

  function hasActiveManualRoute() {
    return !!state.routeActive;
  }

  function getSnapshot() {
    return {
      manualDestination: state.manualDestination ? { ...state.manualDestination } : null,
      routeActive: !!state.routeActive,
      routePreviewReady: !!state.routePreviewReady,
      externalNavUrl: state.externalNavUrl || "",
      status: state.status,
      uiOpen: !!state.uiOpen,
      source: state.source,
      lastManualQuery: state.lastManualQuery || "",
    };
  }

  function bindUi() {
    const { stack, toggleBtn, tray, input, goBtn, clearBtn } = getQuickEls();

    if (toggleBtn && !toggleBtn.dataset.boundManualNav) {
      toggleBtn.dataset.boundManualNav = "1";
      toggleBtn.addEventListener("click", () => {
        if (state.uiOpen) close(); else open();
      });
    }

    if (input && !input.dataset.boundManualNav) {
      input.dataset.boundManualNav = "1";
      input.addEventListener("focus", () => open());
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        void searchAndPreview(input.value || "");
      });
    }

    if (goBtn && !goBtn.dataset.boundManualNav) {
      goBtn.dataset.boundManualNav = "1";
      goBtn.addEventListener("click", () => {
        void searchAndPreview(input?.value || "");
      });
    }

    if (clearBtn && !clearBtn.dataset.boundManualNav) {
      clearBtn.dataset.boundManualNav = "1";
      clearBtn.addEventListener("click", () => clear());
    }

    if (document?.addEventListener && !document.body?.dataset?.boundManualNavOutside) {
      if (document.body) document.body.dataset.boundManualNavOutside = "1";
      const outsideClose = (event) => {
        if (!state.uiOpen) return;
        const target = event?.target;
        if (stack && target instanceof Node && stack.contains(target)) return;
        if (tray && target instanceof Node && tray.contains(target)) return;
        close();
      };
      ["pointerdown", "touchstart", "mousedown"].forEach((eventName) => {
        document.addEventListener(eventName, outsideClose);
      });
    }

    window.addEventListener("tlc-nav-preview-updated", () => {
      updateMetaFromPreview();
      const preview = window.TlcNavigationPreviewModule?.getSnapshot?.() || {};
      state.routeActive = !!preview.hasRoute;
      state.routePreviewReady = preview.status === "Route ready";
      state.status = String(preview.status || state.status || "Idle");
    });

    window.addEventListener("tlc-nav-preview-cleared", () => {
      state.routeActive = false;
      state.routePreviewReady = false;
      if (!state.manualDestination) {
        state.status = "Idle";
      }
      updateMetaFromPreview();
    });
  }

  function init() {
    bindUi();
    syncUi();
  }

  window.TlcManualNavigationModule = {
    init,
    open,
    close,
    setManualDestination,
    searchAndPreview,
    clear,
    getCurrentDestination,
    hasActiveManualRoute,
    getSnapshot,
  };

  window.getTeamJoseoManualNavigationSnapshot = function getTeamJoseoManualNavigationSnapshot() {
    return window.TlcManualNavigationModule?.getSnapshot?.() || {
      manualDestination: null,
      routeActive: false,
      routePreviewReady: false,
      externalNavUrl: "",
      status: "Unavailable",
      uiOpen: false,
      source: "manual",
      lastManualQuery: "",
    };
  };
})();
