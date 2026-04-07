(function () {
  const OFF_ROUTE_METERS = 85;
  const OFF_ROUTE_CONFIRM_SAMPLES = 2;
  const REROUTE_COOLDOWN_MS = 12000;
  const ARRIVING_METERS = 120;
  const ARRIVED_METERS = 28;

  const state = {
    active: false,
    map: null,
    currentDestination: null,
    currentRouteFeature: null,
    currentRouteSteps: [],
    currentStepIndex: 0,
    currentStep: null,
    snappedDistanceMeters: 0,
    remainingDistanceMeters: 0,
    remainingDurationSeconds: 0,
    offRoute: false,
    rerouteInFlight: false,
    lastRerouteAt: 0,
    lastSnapAt: 0,
    lastKnownLocation: null,
    arrivalState: "none",
    navigationStatus: "idle",
    routeSessionId: 0,
    distanceToNextManeuverMeters: null,
    routeCumulativeMeters: [],
    totalRouteMeters: 0,
    totalRouteDurationSeconds: 0,
    destinationSource: null,
    offRouteSamples: 0,
  };

  function getEls() {
    return {
      card: document.getElementById("navTurnCard"),
      primary: document.getElementById("navTurnPrimary"),
      secondary: document.getElementById("navTurnSecondary"),
      meta: document.getElementById("navTurnMeta"),
      startBtn: document.getElementById("navTurnStartBtn"),
      stopBtn: document.getElementById("navTurnStopBtn"),
      recenterBtn: document.getElementById("navTurnRecenterBtn"),
    };
  }

  function toLatLng(raw) {
    const lat = Number(raw?.lat);
    const lng = Number(raw?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  }

  function metersBetween(a, b) {
    if (!a || !b) return 0;
    const R = 6371000;
    const toRad = (v) => (v * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function formatMeters(m) {
    const meters = Number(m);
    if (!Number.isFinite(meters)) return "--";
    if (meters < 1000) return `${Math.max(1, Math.round(meters))} m`;
    return `${(meters / 1000).toFixed(1)} km`;
  }

  function formatEta(seconds) {
    const mins = Math.max(1, Math.round(Number(seconds || 0) / 60));
    if (!Number.isFinite(mins)) return "--";
    return `${mins} min`;
  }

  function buildInstruction(step, fallbackIndex) {
    if (!step) return fallbackIndex > 0 ? "Continue on route" : "Head to destination";
    const maneuver = step.maneuver || {};
    const type = String(maneuver.type || "").trim();
    const modifier = String(maneuver.modifier || "").trim();
    const name = String(step.name || "").trim();
    const explicit = String(maneuver.instruction || step.instruction || "").trim();
    if (explicit) return explicit;
    if (type === "arrive") return "Arrive at destination";
    const typeText = type ? type[0].toUpperCase() + type.slice(1) : "Continue";
    const modText = modifier ? ` ${modifier}` : "";
    const road = name ? ` onto ${name}` : "";
    return `${typeText}${modText}${road}`.trim();
  }

  function deriveStepRanges(steps, totalMeters) {
    const safeSteps = Array.isArray(steps) ? steps : [];
    let cursor = 0;
    return safeSteps.map((step, idx) => {
      const d = Number(step?.distance);
      const seg = Number.isFinite(d) && d >= 0 ? d : (idx === safeSteps.length - 1 ? Math.max(0, totalMeters - cursor) : 0);
      const start = cursor;
      cursor += seg;
      return {
        ...step,
        _startDistance: start,
        _endDistance: cursor,
        _instruction: buildInstruction(step, idx),
      };
    });
  }

  function updateCard() {
    const { card, primary, secondary, meta, startBtn, stopBtn, recenterBtn } = getEls();
    if (!card) return;
    const hasRoute = !!state.currentRouteFeature?.geometry?.coordinates?.length;
    const shouldShow = hasRoute || state.active;
    card.hidden = !shouldShow;
    if (!shouldShow) return;

    if (!state.active) {
      if (primary) primary.textContent = "Route preview ready";
      if (secondary) secondary.textContent = state.currentDestination?.name || "";
      if (meta) meta.textContent = "Tap Start for turn-by-turn";
    } else {
      const instr = state.currentStep?._instruction || "Continue on route";
      if (primary) primary.textContent = instr;
      if (secondary) {
        if (state.arrivalState === "arrived") secondary.textContent = "Arrived at destination";
        else if (state.arrivalState === "approaching") secondary.textContent = "Arriving soon";
        else if (state.offRoute) secondary.textContent = "Off route • Re-routing…";
        else secondary.textContent = `Next in ${formatMeters(state.distanceToNextManeuverMeters)}`;
      }
      if (meta) meta.textContent = `Remaining ${formatMeters(state.remainingDistanceMeters)} • ETA ${formatEta(state.remainingDurationSeconds)}`;
    }

    if (startBtn) startBtn.hidden = state.active || !hasRoute;
    if (stopBtn) stopBtn.hidden = !state.active;
    if (recenterBtn) recenterBtn.hidden = !state.active;
  }

  function preprocessRoute() {
    const coords = state.currentRouteFeature?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) {
      state.routeCumulativeMeters = [];
      state.totalRouteMeters = 0;
      return;
    }
    const cumulative = [0];
    let total = 0;
    for (let i = 1; i < coords.length; i += 1) {
      const a = { lng: Number(coords[i - 1][0]), lat: Number(coords[i - 1][1]) };
      const b = { lng: Number(coords[i][0]), lat: Number(coords[i][1]) };
      total += metersBetween(a, b);
      cumulative.push(total);
    }
    state.routeCumulativeMeters = cumulative;
    state.totalRouteMeters = total;
    const fallback = Number(state.currentRouteFeature?.properties?.durationSeconds) || 0;
    state.totalRouteDurationSeconds = Number(state.currentRouteFeature?.properties?.durationSeconds || fallback || 0);
    state.currentRouteSteps = deriveStepRanges(state.currentRouteSteps, total);
  }

  function snapToRoute(location) {
    const coords = state.currentRouteFeature?.geometry?.coordinates;
    const cumulative = state.routeCumulativeMeters;
    if (!Array.isArray(coords) || coords.length < 2 || !Array.isArray(cumulative) || !cumulative.length) return null;

    const lat = location.lat;
    const lng = location.lng;
    const latScale = 111320;
    const lngScale = Math.max(1, Math.cos((lat * Math.PI) / 180) * 111320);
    const px = lng * lngScale;
    const py = lat * latScale;

    let best = null;
    for (let i = 0; i < coords.length - 1; i += 1) {
      const aLng = Number(coords[i][0]);
      const aLat = Number(coords[i][1]);
      const bLng = Number(coords[i + 1][0]);
      const bLat = Number(coords[i + 1][1]);
      const ax = aLng * lngScale;
      const ay = aLat * latScale;
      const bx = bLng * lngScale;
      const by = bLat * latScale;
      const dx = bx - ax;
      const dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      const t = lenSq > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq)) : 0;
      const projX = ax + t * dx;
      const projY = ay + t * dy;
      const dist = Math.hypot(px - projX, py - projY);
      if (!best || dist < best.distanceMeters) {
        const segLen = Math.max(0, cumulative[i + 1] - cumulative[i]);
        best = {
          distanceMeters: dist,
          alongMeters: cumulative[i] + segLen * t,
        };
      }
    }
    return best;
  }

  function updateStepProgress(alongMeters) {
    const steps = Array.isArray(state.currentRouteSteps) ? state.currentRouteSteps : [];
    let idx = 0;
    for (let i = 0; i < steps.length; i += 1) {
      if (alongMeters <= Number(steps[i]._endDistance || 0)) {
        idx = i;
        break;
      }
      idx = i;
    }
    state.currentStepIndex = idx;
    state.currentStep = steps[idx] || null;
    const stepEnd = Number(state.currentStep?._endDistance || state.totalRouteMeters);
    state.distanceToNextManeuverMeters = Math.max(0, stepEnd - alongMeters);
  }

  function rerouteIfNeeded() {
    if (!state.active || !state.offRoute || state.rerouteInFlight || !state.currentDestination) return;
    const now = Date.now();
    if (now - Number(state.lastRerouteAt || 0) < REROUTE_COOLDOWN_MS) return;
    state.rerouteInFlight = true;
    state.lastRerouteAt = now;
    state.navigationStatus = "rerouting";
    updateCard();
    const source = state.destinationSource === "manual" ? "manual" : "assistant";
    window.TlcNavigationPreviewModule?.setPreviewDestination?.(state.currentDestination, { source });
    setTimeout(() => {
      state.rerouteInFlight = false;
      if (state.active) state.navigationStatus = "active";
      updateCard();
    }, 1200);
  }

  function evaluateArrival() {
    if (!state.active || !state.currentDestination || !state.lastKnownLocation) return;
    const toDest = metersBetween(state.lastKnownLocation, state.currentDestination);
    if (toDest <= ARRIVED_METERS || state.remainingDistanceMeters <= ARRIVED_METERS) {
      state.arrivalState = "arrived";
      state.navigationStatus = "arrived";
      stopNavigation({ auto: true, keepRoute: true });
      return;
    }
    if (toDest <= ARRIVING_METERS || state.remainingDistanceMeters <= ARRIVING_METERS) {
      state.arrivalState = "approaching";
    } else {
      state.arrivalState = "none";
    }
  }

  function handleProgress(location) {
    if (!state.active || !state.currentRouteFeature) return;
    const snapped = snapToRoute(location);
    if (!snapped) return;
    state.lastSnapAt = Date.now();
    state.snappedDistanceMeters = snapped.distanceMeters;
    state.remainingDistanceMeters = Math.max(0, state.totalRouteMeters - snapped.alongMeters);
    state.remainingDurationSeconds = state.totalRouteMeters > 0
      ? Math.max(0, Math.round((state.remainingDistanceMeters / state.totalRouteMeters) * Number(state.totalRouteDurationSeconds || 0)))
      : 0;

    if (snapped.distanceMeters > OFF_ROUTE_METERS) {
      state.offRouteSamples += 1;
    } else {
      state.offRouteSamples = 0;
      state.offRoute = false;
    }
    if (state.offRouteSamples >= OFF_ROUTE_CONFIRM_SAMPLES) {
      state.offRoute = true;
    }

    updateStepProgress(snapped.alongMeters);
    evaluateArrival();
    rerouteIfNeeded();
    updateCard();
  }

  function onLocationUpdate(location) {
    const ll = toLatLng(location);
    if (!ll) return;
    state.lastKnownLocation = ll;
    handleProgress(ll);
  }

  function onRoutePreviewUpdated(routeBundle) {
    state.currentDestination = toLatLng(routeBundle?.destination) ? { ...routeBundle.destination } : null;
    state.destinationSource = String(routeBundle?.destinationSource || "assistant");
    state.currentRouteFeature = routeBundle?.routeFeature || null;
    state.currentRouteSteps = Array.isArray(routeBundle?.steps) ? routeBundle.steps.slice() : [];
    state.totalRouteDurationSeconds = Number(routeBundle?.routeSummary?.durationSeconds || 0);
    preprocessRoute();
    if (state.active) {
      state.navigationStatus = "active";
      state.routeSessionId += 1;
      if (state.lastKnownLocation) handleProgress(state.lastKnownLocation);
    }
    updateCard();
  }

  function stopNavigation(options = {}) {
    const auto = !!options.auto;
    state.active = false;
    if (!auto) {
      state.arrivalState = "none";
      state.navigationStatus = "stopped";
    }
    state.offRoute = false;
    state.offRouteSamples = 0;
    state.rerouteInFlight = false;
    updateCard();
  }

  function startNavigation() {
    if (!state.currentRouteFeature?.geometry?.coordinates?.length) return false;
    state.active = true;
    state.navigationStatus = "active";
    state.arrivalState = "none";
    state.offRoute = false;
    state.offRouteSamples = 0;
    state.routeSessionId += 1;
    if (state.lastKnownLocation) handleProgress(state.lastKnownLocation);
    updateCard();
    return true;
  }

  function toggleNavigation() {
    if (state.active) {
      stopNavigation();
      return false;
    }
    return startNavigation();
  }

  function recenter() {
    if (!state.map || !state.lastKnownLocation) return;
    state.map.easeTo({ center: [state.lastKnownLocation.lng, state.lastKnownLocation.lat], duration: 320, zoom: Math.max(14, Number(state.map.getZoom?.() || 14)) });
  }

  function bindUi() {
    const { startBtn, stopBtn, recenterBtn } = getEls();
    if (startBtn && !startBtn.dataset.boundTurnNav) {
      startBtn.dataset.boundTurnNav = "1";
      startBtn.addEventListener("click", () => startNavigation());
    }
    if (stopBtn && !stopBtn.dataset.boundTurnNav) {
      stopBtn.dataset.boundTurnNav = "1";
      stopBtn.addEventListener("click", () => stopNavigation());
    }
    if (recenterBtn && !recenterBtn.dataset.boundTurnNav) {
      recenterBtn.dataset.boundTurnNav = "1";
      recenterBtn.addEventListener("click", recenter);
    }
  }

  function init(map) {
    state.map = map || null;
    bindUi();
    const bundle = window.TlcNavigationPreviewModule?.getRouteBundle?.();
    if (bundle) onRoutePreviewUpdated(bundle);

    window.addEventListener("tlc-nav-preview-updated", (event) => {
      onRoutePreviewUpdated(event?.detail?.routeBundle || null);
    });
    window.addEventListener("tlc-nav-preview-cleared", () => {
      state.currentDestination = null;
      state.currentRouteFeature = null;
      state.currentRouteSteps = [];
      state.totalRouteMeters = 0;
      state.totalRouteDurationSeconds = 0;
      stopNavigation();
      updateCard();
    });
    window.addEventListener("tlc-user-location-updated", (event) => {
      onLocationUpdate(event?.detail || null);
    });

    updateCard();
  }

  function getSnapshot() {
    return {
      active: state.active,
      offRoute: state.offRoute,
      navigationStatus: state.navigationStatus,
      destination: state.currentDestination,
      currentStepIndex: state.currentStepIndex,
      currentStepInstruction: state.currentStep?._instruction || null,
      distanceToNextManeuverMeters: state.distanceToNextManeuverMeters,
      remainingDistanceMeters: state.remainingDistanceMeters,
      remainingDurationSeconds: state.remainingDurationSeconds,
      arrivalState: state.arrivalState,
      rerouteInFlight: state.rerouteInFlight,
      lastRerouteAt: state.lastRerouteAt,
      routeSessionId: state.routeSessionId,
    };
  }

  window.TlcNavigationTurnModule = {
    init,
    startNavigation,
    stopNavigation,
    toggleNavigation,
    onRoutePreviewUpdated,
    onLocationUpdate,
    getSnapshot,
  };

  window.getTeamJoseoTurnNavigationSnapshot = function getTeamJoseoTurnNavigationSnapshot() {
    return window.TlcNavigationTurnModule?.getSnapshot?.() || {
      active: false,
      offRoute: false,
      navigationStatus: "unavailable",
      destination: null,
      currentStepIndex: 0,
      currentStepInstruction: null,
      distanceToNextManeuverMeters: null,
      remainingDistanceMeters: null,
      remainingDurationSeconds: null,
      arrivalState: "none",
      rerouteInFlight: false,
      lastRerouteAt: 0,
      routeSessionId: 0,
    };
  };
})();
