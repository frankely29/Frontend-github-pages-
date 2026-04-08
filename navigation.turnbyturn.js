(function () {
  const PREVIEW_SOURCE_ID = "tlc-nav-preview-source";
  const PREVIEW_CASING_LAYER_ID = "tlc-nav-preview-casing";
  const PREVIEW_LINE_LAYER_ID = "tlc-nav-preview-line";

  const FOLLOW_ZOOM_DEFAULT = 16.2;
  const FOLLOW_PITCH_DEFAULT = 38;
  const FOLLOW_CAMERA_INTERVAL_MS = 650;
  const OFF_ROUTE_METERS = 85;
  const OFF_ROUTE_CONFIRM_SAMPLES = 3;
  const ARRIVAL_APPROACHING_METERS = 120;
  const ARRIVAL_REACHED_METERS = 28;

  const state = {
    active: false,
    map: null,
    navigationStatus: "idle",
    manualDestination: null,
    currentRouteFeature: null,
    currentRouteSummary: null,
    currentSteps: [],
    currentStepIndex: 0,
    currentStepInstruction: "",
    distanceToNextManeuverMeters: null,
    remainingDistanceMeters: null,
    remainingDurationSeconds: null,
    snappedPoint: null,
    snappedProgressMeters: 0,
    offRoute: false,
    rerouteInFlight: false,
    lastRerouteAt: 0,
    rerouteCooldownMs: 12000,
    arrivalState: "none",
    followModeEnabled: false,
    sessionId: 0,

    routeCumulativeMeters: [],
    routeTotalMeters: 0,
    routeTotalDurationSeconds: 0,
    lastKnownLocation: null,
    offRouteSamples: 0,
    lastFollowCameraAt: 0,
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

  function formatMeters(meters) {
    const v = Number(meters);
    if (!Number.isFinite(v)) return "--";
    if (v < 1000) return `${Math.max(1, Math.round(v))} m`;
    return `${(v / 1000).toFixed(1)} km`;
  }

  function formatEta(seconds) {
    const mins = Math.max(1, Math.round(Number(seconds || 0) / 60));
    if (!Number.isFinite(mins)) return "--";
    return `${mins} min`;
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

  function getInstruction(step, idx) {
    if (!step) return idx > 0 ? "Continue on route" : "Head to destination";
    const maneuver = step.maneuver || {};
    const explicit = String(step.instruction || maneuver.instruction || "").trim();
    if (explicit) return explicit;
    const type = String(maneuver.type || "continue").trim();
    const modifier = String(maneuver.modifier || "").trim();
    const roadName = String(step.name || "").trim();
    if (type === "arrive") return "Arrive at destination";
    const label = `${type.charAt(0).toUpperCase()}${type.slice(1)}${modifier ? ` ${modifier}` : ""}${roadName ? ` onto ${roadName}` : ""}`;
    return label.trim() || "Continue on route";
  }

  function deriveStepRanges(rawSteps, totalMeters) {
    const steps = Array.isArray(rawSteps) ? rawSteps : [];
    let cursor = 0;
    return steps.map((step, idx) => {
      const distance = Number(step?.distance);
      const span = Number.isFinite(distance) && distance >= 0
        ? distance
        : (idx === steps.length - 1 ? Math.max(0, totalMeters - cursor) : 0);
      const start = cursor;
      cursor += span;
      return {
        ...step,
        _startDistance: start,
        _endDistance: cursor,
        _instruction: getInstruction(step, idx),
      };
    });
  }

  function preprocessRouteMetrics() {
    const coords = state.currentRouteFeature?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) {
      state.routeCumulativeMeters = [];
      state.routeTotalMeters = 0;
      state.currentSteps = [];
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
    state.routeTotalMeters = total;
    state.routeTotalDurationSeconds = Number(state.currentRouteSummary?.durationSeconds || state.currentRouteFeature?.properties?.durationSeconds || 0);
    state.currentSteps = deriveStepRanges(state.currentSteps, total);
  }

  function snapToRoute(location) {
    const coords = state.currentRouteFeature?.geometry?.coordinates;
    const cumulative = state.routeCumulativeMeters;
    if (!Array.isArray(coords) || coords.length < 2 || !Array.isArray(cumulative) || cumulative.length < 2) return null;

    const latScale = 111320;
    const lngScale = Math.max(1, Math.cos((location.lat * Math.PI) / 180) * 111320);
    const px = location.lng * lngScale;
    const py = location.lat * latScale;

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

      const projX = ax + (t * dx);
      const projY = ay + (t * dy);
      const planarDistanceMeters = Math.hypot(px - projX, py - projY);
      if (!best || planarDistanceMeters < best.distanceFromRouteMeters) {
        const segLength = Math.max(0, cumulative[i + 1] - cumulative[i]);
        const alongMeters = cumulative[i] + segLength * t;
        const snappedLng = aLng + (bLng - aLng) * t;
        const snappedLat = aLat + (bLat - aLat) * t;
        best = {
          alongMeters,
          distanceFromRouteMeters: planarDistanceMeters,
          point: { lng: snappedLng, lat: snappedLat },
        };
      }
    }

    return best;
  }

  function updateStepProgress(alongMeters) {
    const steps = Array.isArray(state.currentSteps) ? state.currentSteps : [];
    let idx = 0;
    for (let i = 0; i < steps.length; i += 1) {
      idx = i;
      if (alongMeters <= Number(steps[i]._endDistance || 0)) break;
    }
    state.currentStepIndex = idx;
    const step = steps[idx] || null;
    state.currentStepInstruction = step?._instruction || "Continue on route";
    const stepEnd = Number(step?._endDistance || state.routeTotalMeters);
    state.distanceToNextManeuverMeters = Math.max(0, stepEnd - alongMeters);
  }

  function ensurePreviewRouteOnTop() {
    const map = state.map;
    if (!map?.getStyle?.()) return;
    if (map.getLayer?.(PREVIEW_CASING_LAYER_ID)) {
      map.moveLayer(PREVIEW_CASING_LAYER_ID);
    }
    if (map.getLayer?.(PREVIEW_LINE_LAYER_ID)) {
      map.moveLayer(PREVIEW_LINE_LAYER_ID);
    }
  }

  function activateBuildingTintMode() {
    window.TlcNavigationBuildingTintModule?.activate?.();
    ensurePreviewRouteOnTop();
  }

  function deactivateBuildingTintMode() {
    window.TlcNavigationBuildingTintModule?.deactivate?.();
  }

  function reapplyBuildingTintModeIfNeeded() {
    window.TlcNavigationBuildingTintModule?.reapplyIfNeeded?.();
    ensurePreviewRouteOnTop();
  }

  function updateCard() {
    const { card, primary, secondary, meta, startBtn, stopBtn, recenterBtn } = getEls();
    if (!card) return;

    const hasPreviewRoute = !!state.currentRouteFeature?.geometry?.coordinates?.length;
    card.hidden = !hasPreviewRoute && !state.active;
    if (card.hidden) return;

    if (!state.active) {
      if (primary) primary.textContent = hasPreviewRoute ? "Route preview ready" : "Manual route required";
      if (secondary) secondary.textContent = state.manualDestination?.name || "Type a destination to start";
      if (meta) meta.textContent = "Tap Start for turn-by-turn";
    } else {
      if (primary) primary.textContent = state.currentStepInstruction || "Continue on route";
      if (secondary) {
        if (state.arrivalState === "arrived") secondary.textContent = "Arrived at destination";
        else if (state.arrivalState === "approaching") secondary.textContent = `Approaching • ${formatMeters(state.distanceToNextManeuverMeters)}`;
        else if (state.rerouteInFlight) secondary.textContent = "Off route • Re-routing…";
        else secondary.textContent = `Next in ${formatMeters(state.distanceToNextManeuverMeters)}`;
      }
      if (meta) {
        meta.textContent = `Remaining ${formatMeters(state.remainingDistanceMeters)} • ETA ${formatEta(state.remainingDurationSeconds)}`;
      }
    }

    if (startBtn) startBtn.hidden = state.active || !hasPreviewRoute;
    if (stopBtn) stopBtn.hidden = !state.active;
    if (recenterBtn) recenterBtn.hidden = !state.active;
  }

  function maybeFollowCamera() {
    if (!state.active || !state.followModeEnabled || !state.map) return;
    if (!state.lastKnownLocation) return;
    const now = Date.now();
    if (now - Number(state.lastFollowCameraAt || 0) < FOLLOW_CAMERA_INTERVAL_MS) return;

    const target = state.snappedPoint || state.lastKnownLocation;
    const zoom = Math.max(15.5, Number(state.map.getZoom?.() || FOLLOW_ZOOM_DEFAULT));
    state.lastFollowCameraAt = now;

    state.map.easeTo({
      center: [target.lng, target.lat],
      zoom: Math.min(17.0, zoom),
      pitch: FOLLOW_PITCH_DEFAULT,
      offset: [0, Math.round((window.innerHeight || 0) * 0.18)],
      duration: 550,
      essential: true,
    });
  }

  function evaluateArrival() {
    if (!state.manualDestination || !state.lastKnownLocation) return;
    const toDestMeters = metersBetween(state.lastKnownLocation, state.manualDestination);
    if (toDestMeters <= ARRIVAL_REACHED_METERS || Number(state.remainingDistanceMeters) <= ARRIVAL_REACHED_METERS) {
      state.arrivalState = "arrived";
      state.navigationStatus = "arrived";
      return;
    }
    if (toDestMeters <= ARRIVAL_APPROACHING_METERS || Number(state.remainingDistanceMeters) <= ARRIVAL_APPROACHING_METERS) {
      state.arrivalState = "approaching";
      return;
    }
    state.arrivalState = "none";
  }

  function maybeReroute() {
    if (!state.active || !state.offRoute || state.rerouteInFlight || !state.manualDestination) return;
    const now = Date.now();
    if ((now - Number(state.lastRerouteAt || 0)) < state.rerouteCooldownMs) return;
    state.rerouteInFlight = true;
    state.navigationStatus = "rerouting";
    state.lastRerouteAt = now;
    updateCard();

    window.TlcNavigationPreviewModule?.setPreviewDestination?.(state.manualDestination, { source: "manual" });

    window.setTimeout(() => {
      state.rerouteInFlight = false;
      if (state.active && state.arrivalState !== "arrived") {
        state.navigationStatus = "active";
      }
      updateCard();
    }, 1400);
  }

  function refreshProgressFromLocation(location) {
    if (!state.active || !state.currentRouteFeature) return;

    const snapped = snapToRoute(location);
    if (!snapped) return;

    state.snappedPoint = snapped.point;
    state.snappedProgressMeters = snapped.alongMeters;
    state.remainingDistanceMeters = Math.max(0, state.routeTotalMeters - snapped.alongMeters);
    state.remainingDurationSeconds = state.routeTotalMeters > 0
      ? Math.max(0, Math.round((state.remainingDistanceMeters / state.routeTotalMeters) * Number(state.routeTotalDurationSeconds || 0)))
      : 0;

    if (snapped.distanceFromRouteMeters > OFF_ROUTE_METERS) {
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
    maybeReroute();
    maybeFollowCamera();
    ensurePreviewRouteOnTop();
    updateCard();
  }

  function resetActiveProgress() {
    state.currentStepIndex = 0;
    state.currentStepInstruction = "";
    state.distanceToNextManeuverMeters = null;
    state.remainingDistanceMeters = state.routeTotalMeters || null;
    state.remainingDurationSeconds = state.routeTotalDurationSeconds || null;
    state.snappedPoint = null;
    state.snappedProgressMeters = 0;
    state.offRoute = false;
    state.offRouteSamples = 0;
    state.rerouteInFlight = false;
    state.arrivalState = "none";
  }

  function onPreviewRouteUpdated(routeBundle) {
    const source = String(routeBundle?.destinationSource || "");
    const destination = toLatLng(routeBundle?.destination);

    state.manualDestination = source === "manual" && destination
      ? { ...routeBundle.destination }
      : null;

    state.currentRouteFeature = routeBundle?.routeFeature || null;
    state.currentRouteSummary = routeBundle?.routeSummary ? { ...routeBundle.routeSummary } : null;
    state.currentSteps = Array.isArray(routeBundle?.steps) ? routeBundle.steps.slice() : [];
    preprocessRouteMetrics();

    if (!state.currentRouteFeature && state.active) {
      stopNavigation();
      return;
    }

    if (state.active && state.lastKnownLocation) {
      window.TlcNavigationBuildingTintModule?.refreshForViewport?.(true);
      refreshProgressFromLocation(state.lastKnownLocation);
    }

    ensurePreviewRouteOnTop();
    updateCard();
  }

  function onPreviewRouteCleared() {
    state.manualDestination = null;
    state.currentRouteFeature = null;
    state.currentRouteSummary = null;
    state.currentSteps = [];
    state.routeCumulativeMeters = [];
    state.routeTotalMeters = 0;
    state.routeTotalDurationSeconds = 0;
    stopNavigation();
    updateCard();
  }

  function onUserLocationUpdate(location) {
    const ll = toLatLng(location);
    if (!ll) return;
    state.lastKnownLocation = ll;
    if (state.active) {
      window.TlcNavigationBuildingTintModule?.refreshForViewport?.();
    }
    refreshProgressFromLocation(ll);
  }

  function startNavigation() {
    if (state.active) return true;
    if (!state.currentRouteFeature?.geometry?.coordinates?.length) return false;
    if (!state.manualDestination) return false;

    state.active = true;
    state.navigationStatus = "active";
    state.followModeEnabled = true;
    state.sessionId += 1;
    resetActiveProgress();
    activateBuildingTintMode();
    ensurePreviewRouteOnTop();

    if (state.lastKnownLocation) {
      refreshProgressFromLocation(state.lastKnownLocation);
    } else {
      maybeFollowCamera();
    }

    updateCard();
    return true;
  }

  function stopNavigation() {
    state.active = false;
    state.navigationStatus = state.arrivalState === "arrived" ? "arrived" : "stopped";
    state.followModeEnabled = false;
    state.offRoute = false;
    state.offRouteSamples = 0;
    state.rerouteInFlight = false;
    deactivateBuildingTintMode();
    updateCard();
  }

  function toggleNavigation() {
    if (state.active) {
      stopNavigation();
      return false;
    }
    return startNavigation();
  }

  function recenterNavigationCamera() {
    state.lastFollowCameraAt = 0;
    maybeFollowCamera();
    if (state.active) window.TlcNavigationBuildingTintModule?.refreshForViewport?.();
  }

  function bindUi() {
    const { startBtn, stopBtn, recenterBtn } = getEls();
    if (startBtn && !startBtn.dataset.boundTurnNav) {
      startBtn.dataset.boundTurnNav = "1";
      startBtn.addEventListener("click", () => {
        startNavigation();
      });
    }
    if (stopBtn && !stopBtn.dataset.boundTurnNav) {
      stopBtn.dataset.boundTurnNav = "1";
      stopBtn.addEventListener("click", () => {
        stopNavigation();
      });
    }
    if (recenterBtn && !recenterBtn.dataset.boundTurnNav) {
      recenterBtn.dataset.boundTurnNav = "1";
      recenterBtn.addEventListener("click", recenterNavigationCamera);
    }
  }

  function init(map) {
    state.map = map || null;
    window.TlcNavigationBuildingTintModule?.init?.(state.map);
    bindUi();

    if (state.map?.on) {
      state.map.on("styledata", () => {
        if (state.active) {
          reapplyBuildingTintModeIfNeeded();
        }
      });
      state.map.on("idle", () => {
        if (state.active) reapplyBuildingTintModeIfNeeded();
      });
    }

    window.addEventListener("tlc-nav-preview-updated", (event) => {
      onPreviewRouteUpdated(event?.detail?.routeBundle || null);
    });

    window.addEventListener("tlc-nav-preview-cleared", () => {
      onPreviewRouteCleared();
    });

    window.addEventListener("tlc-user-location-updated", (event) => {
      onUserLocationUpdate(event?.detail || null);
    });

    const routeBundle = window.TlcNavigationPreviewModule?.getRouteBundle?.();
    if (routeBundle) {
      onPreviewRouteUpdated(routeBundle);
    } else {
      updateCard();
    }
  }

  function getSnapshot() {
    return {
      active: !!state.active,
      navigationStatus: state.navigationStatus,
      destination: state.manualDestination ? { ...state.manualDestination } : null,
      currentStepIndex: state.currentStepIndex,
      currentStepInstruction: state.currentStepInstruction || null,
      distanceToNextManeuverMeters: state.distanceToNextManeuverMeters,
      remainingDistanceMeters: state.remainingDistanceMeters,
      remainingDurationSeconds: state.remainingDurationSeconds,
      offRoute: !!state.offRoute,
      rerouteInFlight: !!state.rerouteInFlight,
      lastRerouteAt: state.lastRerouteAt,
      arrivalState: state.arrivalState,
      followModeEnabled: !!state.followModeEnabled,
      sessionId: state.sessionId,
    };
  }

  window.TlcNavigationTurnModule = {
    init,
    startNavigation,
    stopNavigation,
    toggleNavigation,
    onPreviewRouteUpdated,
    onUserLocationUpdate,
    getSnapshot,
  };

  window.getTeamJoseoTurnNavigationSnapshot = function getTeamJoseoTurnNavigationSnapshot() {
    return window.TlcNavigationTurnModule?.getSnapshot?.() || {
      active: false,
      navigationStatus: "unavailable",
      destination: null,
      currentStepIndex: 0,
      currentStepInstruction: null,
      distanceToNextManeuverMeters: null,
      remainingDistanceMeters: null,
      remainingDurationSeconds: null,
      offRoute: false,
      rerouteInFlight: false,
      lastRerouteAt: 0,
      arrivalState: "none",
      followModeEnabled: false,
      sessionId: 0,
    };
  };
})();
