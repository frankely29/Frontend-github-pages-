(function () {
  const SOURCE_ID = "tlc-nav-preview-source";
  const CASING_LAYER_ID = "tlc-nav-preview-casing";
  const LINE_LAYER_ID = "tlc-nav-preview-line";
  const REFRESH_DISTANCE_MILES = 0.1;
  const REFRESH_INTERVAL_MS = 60 * 1000;
  const LOCATION_POLL_MS = 15000;
  const METERS_PER_MILE = 1609.344;

  const ROUTE_ENDPOINT = String(window.__TLC_NAV_PREVIEW_ROUTE_ENDPOINT__ || "https://router.project-osrm.org/route/v1").trim().replace(/\/+$/, "");
  const GEOCODE_ENDPOINT = String(window.__TLC_NAV_PREVIEW_GEOCODE_ENDPOINT__ || "https://nominatim.openstreetmap.org/search").trim().replace(/\/+$/, "");

  const state = {
    map: null,
    currentDestination: null,
    destinationSource: null,
    currentRouteGeoJSON: null,
    currentRouteSummary: null,
    currentRouteStatus: "Idle",
    currentProfile: "driving",
    currentSourceId: SOURCE_ID,
    currentLineLayerId: LINE_LAYER_ID,
    currentCasingLayerId: CASING_LAYER_ID,
    currentMarker: null,
    lastOrigin: null,
    lastFetchKey: "",
    routeAbortController: null,
    routeCache: new Map(),
    lastRefreshAt: 0,
    locationPollTimer: null,
    userInteracted: false,
    uiOpen: false,
    suppressCloseUntilTs: 0,
    autoCollapseTimer: null,
    inputFocused: false,
    lastInternalInteractAt: 0,
    pendingOutsideClose: false,
  };

  function emptyGeojson() {
    return { type: "FeatureCollection", features: [] };
  }

  function toLatLng(raw) {
    if (!raw || typeof raw !== "object") return null;
    const lat = Number(raw.lat);
    const lng = Number(raw.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  }

  function normalizeDestination(dest) {
    const latLng = toLatLng(dest);
    if (!latLng) return null;
    const name = String(dest?.name || dest?.title || dest?.label || dest?.zoneName || "Selected destination").trim() || "Selected destination";
    return { ...latLng, name };
  }

  function getCore() {
    return window.TlcMapUiInternals || {};
  }

  function getUserOrigin() {
    const origin = getCore().getUserLatLng?.();
    return toLatLng(origin);
  }

  function haversineMiles(a, b) {
    return getCore().haversineMiles?.(a, b) || 0;
  }

  function ensureRouteLayers() {
    const map = state.map;
    if (!map || !map.getStyle()) return false;

    if (!map.getSource(state.currentSourceId)) {
      map.addSource(state.currentSourceId, {
        type: "geojson",
        data: emptyGeojson(),
      });
    }

    if (!map.getLayer(state.currentCasingLayerId)) {
      map.addLayer({
        id: state.currentCasingLayerId,
        type: "line",
        source: state.currentSourceId,
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
        paint: {
          "line-color": "rgba(15, 23, 42, 0.95)",
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 7, 15, 11, 18, 14],
          "line-opacity": 0.92,
        },
      });
    }

    if (!map.getLayer(state.currentLineLayerId)) {
      map.addLayer({
        id: state.currentLineLayerId,
        type: "line",
        source: state.currentSourceId,
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
        paint: {
          "line-color": "#38bdf8",
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 4, 15, 6, 18, 8],
          "line-opacity": 0.98,
        },
      });
    }

    return true;
  }

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

  function formatDistanceMiles(meters) {
    const miles = Number(meters) / METERS_PER_MILE;
    if (!Number.isFinite(miles)) return "--";
    if (miles >= 10) return `${miles.toFixed(1)} mi`;
    if (miles >= 1) return `${miles.toFixed(1)} mi`;
    return `${miles.toFixed(2)} mi`;
  }

  function formatEta(seconds) {
    const mins = Math.max(1, Math.round(Number(seconds) / 60));
    if (!Number.isFinite(mins)) return "--";
    return `${mins} min`;
  }

  function buildMetaText() {
    if (state.currentRouteSummary?.durationSeconds && state.currentRouteSummary?.distanceMeters) {
      return `${formatEta(state.currentRouteSummary.durationSeconds)} • ${formatDistanceMiles(state.currentRouteSummary.distanceMeters)}`;
    }
    return String(state.currentRouteStatus || "Idle");
  }

  function shouldShowMeta(metaText) {
    const status = String(state.currentRouteStatus || "Idle").trim().toLowerCase();
    const hasSummary = !!(state.currentRouteSummary?.durationSeconds && state.currentRouteSummary?.distanceMeters);
    if (hasSummary) return true;
    if (!metaText) return false;
    if (!status || status === "idle") return false;
    return (
      status.startsWith("calculating route") ||
      status.startsWith("route ready") ||
      status.startsWith("waiting for location") ||
      status.startsWith("route unavailable") ||
      status.startsWith("search error")
    );
  }

  function buildToggleText() {
    if (state.currentRouteSummary?.durationSeconds) {
      const mins = Math.max(1, Math.round(Number(state.currentRouteSummary.durationSeconds) / 60));
      if (Number.isFinite(mins)) return `${mins}m`;
    }
    const status = String(state.currentRouteStatus || "Idle").trim().toLowerCase();
    if (status.startsWith("calculating") || status.startsWith("searching") || status.startsWith("preparing")) return "...";
    if (status.startsWith("waiting for location")) return "Loc";
    return "Navigate";
  }

  function positionQuickStackBelowWeather() {
    const { stack } = getQuickEls();
    if (!stack) return;
    const weatherBadge = document.getElementById("weatherBadge");
    if (!weatherBadge || typeof weatherBadge.getBoundingClientRect !== "function") return;
    const rect = weatherBadge.getBoundingClientRect();
    if (!rect || !Number.isFinite(rect.top) || !Number.isFinite(rect.bottom) || !Number.isFinite(rect.right)) return;
    const gapPx = 6;
    const rightInsetPx = Math.max(8, Math.round(window.innerWidth - rect.right));
    const topPx = Math.max(0, Math.round(rect.bottom + gapPx));
    stack.style.top = `${topPx}px`;
    stack.style.right = `${rightInsetPx}px`;
  }

  function syncQuickUiOpenState() {
    syncNavQuickUiState();
  }

  function setUiOpen(open) {
    const nextOpen = !!open;
    state.uiOpen = nextOpen;
    if (nextOpen) {
      state.suppressCloseUntilTs = Date.now() + 200;
    }
    syncQuickUiOpenState();
  }

  function markInternalInteraction(event) {
    const now = Date.now();
    state.lastInternalInteractAt = now;
    state.pendingOutsideClose = false;
    state.suppressCloseUntilTs = now + 250;
    if (event?.stopPropagation) event.stopPropagation();
  }

  function hasRecentInternalInteraction(windowMs = 250) {
    return (Date.now() - Number(state.lastInternalInteractAt || 0)) < windowMs;
  }

  function isEventInsideQuickStack(target) {
    if (!target || !(target instanceof Node)) return false;
    const { stack } = getQuickEls();
    return !!stack?.contains(target);
  }

  function isEventInsideQuickStackPath(event) {
    const { stack } = getQuickEls();
    if (!stack || !event || typeof event.composedPath !== "function") return false;
    const path = event.composedPath();
    return Array.isArray(path) && path.includes(stack);
  }

  function maybeAutoCollapseAfterDelay() {
    if (state.autoCollapseTimer) clearTimeout(state.autoCollapseTimer);
    state.autoCollapseTimer = setTimeout(() => {
      const { input } = getQuickEls();
      const active = document.activeElement;
      if (active && input && active === input) return;
      setUiOpen(false);
    }, 2400);
  }

  function syncNavQuickUiState() {
    const { stack, toggleBtn, toggleText, tray, input, meta } = getQuickEls();
    if (stack) stack.hidden = false;
    if (stack) stack.dataset.open = state.uiOpen ? "1" : "0";
    if (toggleBtn) toggleBtn.setAttribute("aria-expanded", state.uiOpen ? "true" : "false");
    if (tray) tray.hidden = !state.uiOpen;
    if (toggleText) toggleText.textContent = buildToggleText();
    if (input && state.currentDestination?.name && state.destinationSource !== "manual") {
      input.value = state.currentDestination.name;
    }
    if (meta) {
      const metaText = buildMetaText();
      const showMeta = shouldShowMeta(metaText);
      meta.hidden = !showMeta;
      meta.textContent = showMeta ? metaText : "";
      meta.title = showMeta ? metaText : "";
    }
  }

  function closeNavQuickOnOutsidePress(event) {
    if (!state.uiOpen) return;
    if (Date.now() < Number(state.suppressCloseUntilTs || 0)) return;
    if (state.inputFocused) return;
    const target = event?.target;
    if (isEventInsideQuickStack(target)) return;
    if (isEventInsideQuickStackPath(event)) return;
    if (!state.pendingOutsideClose) return;
    if (hasRecentInternalInteraction()) return;
    setUiOpen(false);
  }

  function maybeAutoCollapse() {
    maybeAutoCollapseAfterDelay();
  }

  function setStatus(text) {
    state.currentRouteStatus = String(text || "Idle");
    syncNavQuickUiState();
  }

  function setRouteGeojson(routeFeature) {
    state.currentRouteGeoJSON = routeFeature || null;
    if (!ensureRouteLayers()) return;
    const map = state.map;
    const source = map?.getSource?.(state.currentSourceId);
    if (!source || typeof source.setData !== "function") return;

    source.setData(routeFeature ? {
      type: "FeatureCollection",
      features: [routeFeature],
    } : emptyGeojson());
  }

  function updateMarker() {
    if (!state.map) return;
    const dest = state.currentDestination;

    if (!dest) {
      if (state.currentMarker) {
        state.currentMarker.remove();
        state.currentMarker = null;
      }
      return;
    }

    if (!window.maplibregl?.Marker) return;

    if (!state.currentMarker) {
      state.currentMarker = new maplibregl.Marker({ color: "#38bdf8" });
    }
    state.currentMarker.setLngLat([dest.lng, dest.lat]).addTo(state.map);
  }

  function focusRoute(routeFeature) {
    if (!state.map || !routeFeature?.geometry?.coordinates?.length) return;
    const coords = routeFeature.geometry.coordinates;
    const bounds = new maplibregl.LngLatBounds();
    coords.forEach((coord) => {
      if (Array.isArray(coord) && coord.length >= 2) bounds.extend([coord[0], coord[1]]);
    });
    if (bounds.isEmpty()) return;
    state.map.fitBounds(bounds, {
      padding: { top: 90, right: 50, bottom: 140, left: 50 },
      maxZoom: 15,
      duration: state.userInteracted ? 350 : 500,
    });
    state.userInteracted = true;
  }

  function buildFetchKey(origin, destination) {
    const oLat = origin.lat.toFixed(5);
    const oLng = origin.lng.toFixed(5);
    const dLat = destination.lat.toFixed(5);
    const dLng = destination.lng.toFixed(5);
    return `${state.currentProfile}|${oLat},${oLng}|${dLat},${dLng}`;
  }

  async function fetchRoutePreview(origin, destination) {
    const key = buildFetchKey(origin, destination);
    if (state.routeCache.has(key)) {
      state.lastFetchKey = key;
      return state.routeCache.get(key);
    }

    if (state.routeAbortController) {
      state.routeAbortController.abort();
    }
    const controller = new AbortController();
    state.routeAbortController = controller;

    const url = `${ROUTE_ENDPOINT}/${encodeURIComponent(state.currentProfile)}/${encodeURIComponent(origin.lng)},${encodeURIComponent(origin.lat)};${encodeURIComponent(destination.lng)},${encodeURIComponent(destination.lat)}?overview=full&geometries=geojson&steps=true`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Route preview request failed (${response.status})`);
    }
    const payload = await response.json();
    const route = Array.isArray(payload?.routes) ? payload.routes[0] : null;
    if (!route?.geometry?.coordinates?.length) {
      throw new Error("No route geometry returned");
    }

    const normalized = {
      geometryGeoJSON: {
        type: "Feature",
        properties: { mode: state.currentProfile, distanceMeters: Number(route.distance || 0), durationSeconds: Number(route.duration || 0) },
        geometry: {
          type: "LineString",
          coordinates: route.geometry.coordinates,
        },
      },
      distanceMeters: Number(route.distance || 0),
      durationSeconds: Number(route.duration || 0),
      steps: (Array.isArray(route.legs) ? route.legs : []).flatMap((leg) => Array.isArray(leg?.steps) ? leg.steps : []),
    };

    state.routeCache.set(key, normalized);
    if (state.routeCache.size > 24) {
      const firstKey = state.routeCache.keys().next().value;
      if (firstKey) state.routeCache.delete(firstKey);
    }
    state.lastFetchKey = key;
    return normalized;
  }

  async function runPreviewRefresh(force = false) {
    if (!state.currentDestination) {
      setRouteGeojson(null);
      state.currentRouteSummary = null;
      syncNavQuickUiState();
      emitPreviewUpdated();
      return;
    }

    const origin = getUserOrigin();
    if (!origin) {
      setRouteGeojson(null);
      state.currentRouteSummary = null;
      setStatus("Waiting for location");
      emitPreviewUpdated();
      return;
    }

    const now = Date.now();
    const movedMiles = state.lastOrigin ? haversineMiles(state.lastOrigin, origin) : Infinity;
    const staleMs = now - Number(state.lastRefreshAt || 0);
    const shouldRefresh = force || !state.lastOrigin || movedMiles >= REFRESH_DISTANCE_MILES || staleMs >= REFRESH_INTERVAL_MS;
    if (!shouldRefresh) return;

    state.lastOrigin = origin;
    state.lastRefreshAt = now;
    setStatus("Calculating route…");

    try {
      const normalized = await fetchRoutePreview(origin, state.currentDestination);
      state.currentRouteSummary = {
        distanceMeters: normalized.distanceMeters,
        durationSeconds: normalized.durationSeconds,
        steps: normalized.steps,
      };
      setRouteGeojson(normalized.geometryGeoJSON);
      updateMarker();
      focusRoute(normalized.geometryGeoJSON);
      setStatus("Route ready");
      maybeAutoCollapse();
      syncNavQuickUiState();
      emitPreviewUpdated();
    } catch (error) {
      if (error?.name === "AbortError") return;
      console.warn("navigation preview route fetch failed:", error);
      state.currentRouteSummary = null;
      setStatus("Route unavailable");
      emitPreviewUpdated();
    }
  }

  function shouldApplyDestinationUpdate(source = "assistant") {
    return !(state.destinationSource === "manual" && source !== "manual");
  }


  function getRouteBundle() {
    return {
      destination: state.currentDestination ? { ...state.currentDestination } : null,
      destinationSource: state.destinationSource || null,
      routeFeature: state.currentRouteGeoJSON || null,
      routeSummary: state.currentRouteSummary ? { ...state.currentRouteSummary } : null,
      steps: Array.isArray(state.currentRouteSummary?.steps) ? state.currentRouteSummary.steps.slice() : [],
      status: state.currentRouteStatus,
      profile: state.currentProfile,
      lastFetchKey: state.lastFetchKey || "",
    };
  }

  function emitPreviewUpdated() {
    window.dispatchEvent(new CustomEvent("tlc-nav-preview-updated", {
      detail: { routeBundle: getRouteBundle() },
    }));
  }

  function emitPreviewCleared() {
    window.dispatchEvent(new CustomEvent("tlc-nav-preview-cleared", {
      detail: { routeBundle: getRouteBundle() },
    }));
  }

  function clearPreview(options = {}) {
    const source = String(options?.source || "assistant");
    const clearInput = !!options?.clearInput;
    if (source !== "manual" && state.destinationSource === "manual") {
      return;
    }

    if (state.routeAbortController) {
      state.routeAbortController.abort();
      state.routeAbortController = null;
    }
    state.currentDestination = null;
    state.destinationSource = null;
    state.currentRouteGeoJSON = null;
    state.currentRouteSummary = null;
    state.currentRouteStatus = "Idle";
    state.lastOrigin = null;
    state.lastFetchKey = "";
    setRouteGeojson(null);
    updateMarker();
    if (clearInput) {
      const { input } = getQuickEls();
      if (input) input.value = "";
    }
    syncNavQuickUiState();
    setUiOpen(false);
    emitPreviewCleared();
  }

  async function searchAndSetPreviewDestination(query) {
    const q = String(query || "").trim();
    if (!q) {
      setStatus("Type a destination");
      return null;
    }

    setStatus("Searching…");
    const url = `${GEOCODE_ENDPOINT}?q=${encodeURIComponent(q)}&format=jsonv2&limit=1`;

    try {
      const core = getCore();
      const payload = await (core.fetchJSON?.(url, { headers: { "Accept-Language": "en" } }) || fetch(url).then((r) => r.json()));
      const candidate = Array.isArray(payload) ? payload[0] : null;
      const lat = Number(candidate?.lat);
      const lng = Number(candidate?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        setStatus("Route unavailable");
        return null;
      }
      const name = String(candidate?.display_name || q).trim() || q;
      const normalized = { lat, lng, name };
      setPreviewDestination(normalized, { source: "manual" });
      try {
        window.TlcMapUiModule?.setNavDestination?.(normalized, { source: "manual" });
      } catch (_) {}
      return normalized;
    } catch (error) {
      console.warn("navigation preview geocode failed:", error);
      setStatus("Search error");
      return null;
    }
  }

  function setPreviewDestination(dest, options = {}) {
    const source = String(options?.source || "assistant");
    const normalizedDest = normalizeDestination(dest);
    if (!normalizedDest) {
      clearPreview({ source, clearInput: false });
      return;
    }

    if (!shouldApplyDestinationUpdate(source)) {
      return;
    }

    state.currentDestination = normalizedDest;
    state.destinationSource = source === "manual" ? "manual" : "assistant";
    setStatus("Preparing preview…");
    emitPreviewUpdated();
    updateMarker();
    void runPreviewRefresh(true);
  }

  function refreshPreviewFromUserLocation() {
    void runPreviewRefresh(false);
  }

  function bindUi() {
    const { stack, toggleBtn, tray, input, goBtn, clearBtn } = getQuickEls();

    const bindInternalPress = (el, key) => {
      if (!el || el.dataset[key]) return;
      el.dataset[key] = "1";
      ["pointerdown", "touchstart", "mousedown"].forEach((eventName) => {
        el.addEventListener(eventName, markInternalInteraction);
      });
    };

    bindInternalPress(stack, "boundNavPreviewInternal");
    bindInternalPress(toggleBtn, "boundNavPreviewInternal");
    bindInternalPress(tray, "boundNavPreviewInternal");
    bindInternalPress(input, "boundNavPreviewInternal");
    bindInternalPress(goBtn, "boundNavPreviewInternal");
    bindInternalPress(clearBtn, "boundNavPreviewInternal");

    if (toggleBtn && !toggleBtn.dataset.boundNavPreview) {
      toggleBtn.dataset.boundNavPreview = "1";
      toggleBtn.addEventListener("click", (event) => {
        markInternalInteraction(event);
        setUiOpen(!state.uiOpen);
      });
    }

    if (tray && !tray.dataset.boundNavPreview) {
      tray.dataset.boundNavPreview = "1";
      tray.addEventListener("click", (event) => markInternalInteraction(event));
    }

    if (goBtn && !goBtn.dataset.boundNavPreview) {
      goBtn.dataset.boundNavPreview = "1";
      goBtn.addEventListener("click", (event) => {
        markInternalInteraction(event);
        setUiOpen(true);
        void searchAndSetPreviewDestination(input?.value || "");
      });
    }

    if (input && !input.dataset.boundNavPreview) {
      input.dataset.boundNavPreview = "1";
      input.addEventListener("click", (event) => {
        markInternalInteraction(event);
        setUiOpen(true);
      });
      input.addEventListener("keydown", (event) => {
        markInternalInteraction(event);
        setUiOpen(true);
        if (event.key !== "Enter") return;
        event.preventDefault();
        void searchAndSetPreviewDestination(input.value || "");
      });
      input.addEventListener("focus", () => {
        state.inputFocused = true;
        state.lastInternalInteractAt = Date.now();
        setUiOpen(true);
      });
      input.addEventListener("focusout", (event) => {
        const nextTarget = event?.relatedTarget;
        state.inputFocused = false;
        if (isEventInsideQuickStack(nextTarget)) return;
        setTimeout(() => {
          const active = document.activeElement;
          const activeInsideStack = isEventInsideQuickStack(active);
          if (activeInsideStack) return;
          if (state.inputFocused) return;
          if (hasRecentInternalInteraction()) return;
          if (!state.pendingOutsideClose) return;
          setUiOpen(false);
        }, 0);
      });
    }

    if (clearBtn && !clearBtn.dataset.boundNavPreview) {
      clearBtn.dataset.boundNavPreview = "1";
      clearBtn.addEventListener("click", (event) => {
        markInternalInteraction(event);
        const wasManual = state.destinationSource === "manual";
        clearPreview({ source: wasManual ? "manual" : "assistant", clearInput: true });
        try {
          window.TlcMapUiModule?.setNavDestination?.(null, { source: wasManual ? "manual" : "assistant" });
        } catch (_) {}
      });
    }

    if (tray && !tray.dataset.boundNavPreviewFocus) {
      tray.dataset.boundNavPreviewFocus = "1";
      tray.addEventListener("focusout", (event) => {
        const nextTarget = event?.relatedTarget;
        if (isEventInsideQuickStack(nextTarget)) return;
        setTimeout(() => {
          const active = document.activeElement;
          if (isEventInsideQuickStack(active)) return;
          if (state.inputFocused) return;
          if (hasRecentInternalInteraction()) return;
          if (!state.pendingOutsideClose) return;
          setUiOpen(false);
        }, 0);
      });
    }

    if (document?.body && !document.body.dataset.boundNavPreviewOutside) {
      document.body.dataset.boundNavPreviewOutside = "1";
      const handleDocPress = (event) => {
        const outside = !isEventInsideQuickStack(event?.target) && !isEventInsideQuickStackPath(event);
        state.pendingOutsideClose = outside;
        closeNavQuickOnOutsidePress(event);
      };
      ["pointerdown", "touchstart", "mousedown"].forEach((eventName) => {
        document.addEventListener(eventName, handleDocPress);
      });
    }
  }

  function init(map) {
    if (!map || typeof map.getSource !== "function") return;
    state.map = map;
    bindUi();

    const boot = () => {
      ensureRouteLayers();
      syncNavQuickUiState();
      positionQuickStackBelowWeather();
      if (state.currentDestination) {
        void runPreviewRefresh(true);
      }
    };

    if (map.isStyleLoaded?.()) {
      boot();
    } else {
      map.once("load", boot);
    }

    map.on?.("styledata", () => {
      ensureRouteLayers();
      if (state.currentRouteGeoJSON) {
        setRouteGeojson(state.currentRouteGeoJSON);
      }
    });

    if (state.locationPollTimer) {
      clearInterval(state.locationPollTimer);
    }
    state.locationPollTimer = setInterval(refreshPreviewFromUserLocation, LOCATION_POLL_MS);
    window.addEventListener("resize", positionQuickStackBelowWeather);
    window.addEventListener("orientationchange", positionQuickStackBelowWeather);
    window.addEventListener("tlc-top-badges-updated", positionQuickStackBelowWeather);
  }

  function getSnapshot() {
    return {
      destination: state.currentDestination,
      destinationSource: state.destinationSource,
      hasRoute: !!state.currentRouteGeoJSON,
      distanceMeters: state.currentRouteSummary?.distanceMeters ?? null,
      durationSeconds: state.currentRouteSummary?.durationSeconds ?? null,
      status: state.currentRouteStatus,
      sourceReady: !!state.map?.getSource?.(state.currentSourceId),
      lineLayerReady: !!state.map?.getLayer?.(state.currentLineLayerId),
      markerReady: !!state.currentMarker,
      lastFetchKey: state.lastFetchKey || "",
    };
  }

  window.TlcNavigationPreviewModule = {
    init,
    setPreviewDestination,
    clearPreview,
    refreshPreviewFromUserLocation,
    searchAndSetPreviewDestination,
    shouldApplyDestinationUpdate,
    isManualOverrideActive: () => state.destinationSource === "manual",
    getSnapshot,
    getRouteBundle,
  };

  window.getTeamJoseoNavigationPreviewSnapshot = function getTeamJoseoNavigationPreviewSnapshot() {
    return window.TlcNavigationPreviewModule?.getSnapshot?.() || {
      destination: null,
      destinationSource: null,
      hasRoute: false,
      distanceMeters: null,
      durationSeconds: null,
      status: "Unavailable",
      sourceReady: false,
      lineLayerReady: false,
      markerReady: false,
      lastFetchKey: "",
    };
  };
})();
