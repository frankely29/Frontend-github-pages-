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
    searchInFlight: false,
    activeSearchToken: 0,
  };
  let manualNavInitialized = false;

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

  function buildMetaText() {
    const preview = window.TlcNavigationPreviewModule?.getSnapshot?.() || {};
    const durationSeconds = Number(preview.durationSeconds);
    const distanceMeters = Number(preview.distanceMeters);
    if (Number.isFinite(durationSeconds) && Number.isFinite(distanceMeters) && durationSeconds > 0 && distanceMeters > 0) {
      const miles = distanceMeters / 1609.344;
      const mins = Math.max(1, Math.round(durationSeconds / 60));
      return `${mins} min • ${miles >= 1 ? miles.toFixed(1) : miles.toFixed(2)} mi`;
    }
    return String(state.status || "Idle");
  }

  function syncUi() {
    const { stack, toggleBtn, toggleText, tray, input, meta } = getQuickEls();
    if (stack) {
      stack.hidden = false;
      stack.dataset.open = state.uiOpen ? "1" : "0";
    }
    if (toggleBtn) toggleBtn.setAttribute("aria-expanded", state.uiOpen ? "true" : "false");
    if (tray) tray.hidden = !state.uiOpen;
    if (toggleText) {
      if (state.status === "Searching…" || state.status === "Preparing preview…" || state.status === "Calculating route…") toggleText.textContent = "...";
      else if (state.routePreviewReady) toggleText.textContent = "Route";
      else toggleText.textContent = "Navigate";
    }
    if (input && state.manualDestinationLabel && document.activeElement !== input) {
      input.value = state.manualDestinationLabel;
    }
    if (meta) {
      const text = buildMetaText();
      meta.hidden = !text || text === "Idle";
      meta.textContent = meta.hidden ? "" : text;
      meta.title = meta.hidden ? "" : text;
    }
  }

  function open() {
    state.uiOpen = true;
    syncUi();
    window.requestAnimationFrame(() => {
      const { input } = getQuickEls();
      input?.focus?.();
    });
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
    updateExternalNav();
    syncUi();
    return normalized;
  }

  async function searchAndPreview(query) {
    if (state.searchInFlight) {
      return null;
    }

    const q = String(query || "").trim();
    if (!q) {
      state.status = "Type a destination";
      syncUi();
      return null;
    }

    const searchToken = state.activeSearchToken + 1;
    state.activeSearchToken = searchToken;
    state.searchInFlight = true;
    state.lastManualQuery = q;
    state.status = "Searching…";
    syncUi();

    try {
      const result = await window.TlcNavigationPreviewModule?.searchAndSetPreviewDestination?.(q);
      if (searchToken !== state.activeSearchToken) return null;
      if (!result?.destination || String(result?.routeBundle?.destinationSource || "") !== "manual") {
        const previewSnapshot = window.TlcNavigationPreviewModule?.getSnapshot?.() || {};
        const previewStatus = String(previewSnapshot.statusReason || previewSnapshot.status || "").trim();
        const canAdoptPreviewDestination = String(previewSnapshot.destinationSource || "") === "manual"
          && !!previewSnapshot.destination
          && previewStatus !== "Destination not found"
          && previewStatus !== "Search error"
          && previewStatus !== "Search timed out";
        if (canAdoptPreviewDestination) {
          setManualDestination(previewSnapshot.destination);
        }
        state.routePreviewReady = !!previewSnapshot.routeReady && String(previewSnapshot.destinationSource || "") === "manual";
        state.routeActive = false;
        state.status = String(previewStatus || "Route unavailable");
        syncUi();
        return null;
      }

      const accepted = setManualDestination(result.destination);
      if (!accepted) {
        state.routeActive = false;
        state.routePreviewReady = false;
        state.status = "Route unavailable";
        syncUi();
        return null;
      }

      const previewStatus = String(result?.routeBundle?.statusReason || result?.routeBundle?.status || "");
      const previewReady = !!result?.routeBundle?.startReady || isManualPreviewReady(result?.routeBundle);
      state.routePreviewReady = previewReady;
      state.routeActive = false;
      state.status = previewReady ? "Preview ready" : (previewStatus || "Waiting for location");
      syncUi();
      return result;
    } finally {
      if (searchToken === state.activeSearchToken) {
        state.searchInFlight = false;
      }
    }
  }

  function clear() {
    state.activeSearchToken += 1;
    state.searchInFlight = false;
    window.TlcNavigationTurnModule?.stopNavigation?.();
    window.TlcNavigationPreviewModule?.clearPreview?.({ clearInput: true });
    state.manualDestination = null;
    state.manualDestinationLabel = "";
    state.routeActive = false;
    state.routePreviewReady = false;
    state.externalNavUrl = "";
    state.status = "Idle";
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

  function isManualPreviewReady(routeBundle) {
    if (!routeBundle || String(routeBundle.destinationSource || "") !== "manual") return false;
    const hasRouteFeature = !!routeBundle?.routeFeature?.geometry?.coordinates?.length;
    return hasRouteFeature && String(routeBundle.status || "").toLowerCase() === "route ready";
  }

  function bindUi() {
    const { stack, toggleBtn, input, goBtn, clearBtn } = getQuickEls();

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
        close();
      };
      ["pointerdown", "touchstart", "mousedown"].forEach((eventName) => {
        document.addEventListener(eventName, outsideClose);
      });
    }

    window.addEventListener("tlc-nav-preview-updated", (event) => {
      const routeBundle = event?.detail?.routeBundle || null;
      state.routePreviewReady = isManualPreviewReady(routeBundle);
      if (!state.routeActive && String(routeBundle?.destinationSource || "") === "manual") {
        state.status = state.routePreviewReady
          ? "Preview ready"
          : String(routeBundle?.statusReason || routeBundle?.status || state.status || "Waiting for location");
      }
      syncUi();
    });

    window.addEventListener("tlc-nav-preview-ready", (event) => {
      const routeBundle = event?.detail?.routeBundle || null;
      state.routePreviewReady = isManualPreviewReady(routeBundle);
      if (!state.routeActive && state.manualDestination && state.routePreviewReady) {
        state.status = "Preview ready";
      }
      syncUi();
    });

    window.addEventListener("tlc-nav-preview-failed", (event) => {
      state.routePreviewReady = false;
      state.routeActive = false;
      state.status = String(event?.detail?.status || ((state.status === "Searching…" || state.status === "Preparing preview…") ? "Route unavailable" : state.status));
      syncUi();
    });

    window.addEventListener("tlc-nav-preview-cleared", () => {
      state.routeActive = false;
      state.routePreviewReady = false;
      if (!state.manualDestination) {
        state.status = "Idle";
      }
      syncUi();
    });

    window.addEventListener("tlc-nav-started", () => {
      state.routeActive = true;
      state.status = "Navigating…";
      syncUi();
    });

    window.addEventListener("tlc-nav-stopped", () => {
      if (state.manualDestination && state.routePreviewReady) {
        state.routeActive = false;
        state.status = "Preview ready";
      } else {
        state.routeActive = false;
        if (!state.manualDestination) state.status = "Idle";
      }
      syncUi();
    });

    window.addEventListener("tlc-nav-start-failed", (event) => {
      state.routeActive = false;
      const reason = String(event?.detail?.reason || "").trim();
      if (reason) state.status = reason;
      syncUi();
    });
  }

  function init() {
    if (manualNavInitialized) return;
    manualNavInitialized = true;
    bindUi();
    syncUi();
  }

  function initManualNavigationWhenDomReady() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => {
        window.TlcManualNavigationModule?.init?.();
      }, { once: true });
      return;
    }
    window.TlcManualNavigationModule?.init?.();
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

  initManualNavigationWhenDomReady();
})();
