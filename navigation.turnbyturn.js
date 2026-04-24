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
    rerouteCooldownMs: 6000,
    arrivalState: "none",
    followModeEnabled: false,
    sessionId: 0,

    routeCumulativeMeters: [],
    routeTotalMeters: 0,
    routeTotalDurationSeconds: 0,
    lastKnownLocation: null,
    lastKnownHeadingDeg: null,
    lastKnownHeadingSource: "none",
    offRouteSamples: 0,
    lastFollowCameraAt: 0,
    liveMapSyncRaf: 0,
    lastLiveMapSyncReason: "",
    runtimeSyncListenersBound: false,
    lastStartFailureReason: "",
    hasPreviewRoute: false,
    hasPreviewDestination: false,
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
      banner: document.getElementById("navActiveBanner"),
      bannerPrimary: document.getElementById("navBannerPrimary"),
      bannerIcon: document.getElementById("navBannerIcon"),
      bannerDistance: document.getElementById("navBannerDistance"),
      bannerMeta: document.getElementById("navBannerMeta"),
      bannerStop: document.getElementById("navBannerStop"),
      bannerRecenter: document.getElementById("navBannerRecenter"),
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
    const feet = v * 3.28084;
    const miles = v / 1609.34;
    if (miles >= 0.2) return `${miles.toFixed(1)} mi`;
    return `${Math.max(10, Math.round(feet / 10) * 10)} ft`;
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

  function getManeuverArrow(step) {
    const maneuver = step?.maneuver || {};
    const type = String(maneuver.type || "").toLowerCase();
    const modifier = String(maneuver.modifier || "").toLowerCase();
    if (type === "arrive") return "🏁";
    if (type === "depart") return "➜";
    if (modifier.includes("left") && modifier.includes("sharp")) return "↰";
    if (modifier.includes("right") && modifier.includes("sharp")) return "↱";
    if (modifier.includes("left") && modifier.includes("slight")) return "↖";
    if (modifier.includes("right") && modifier.includes("slight")) return "↗";
    if (modifier.includes("left")) return "←";
    if (modifier.includes("right")) return "→";
    if (modifier.includes("straight")) return "↑";
    if (type === "roundabout" || type === "rotary") return "↻";
    if (type === "merge") return "↗";
    if (type === "fork") return "⑂";
    return "➜";
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

  function deriveRouteHeadingAtProgress(alongMeters) {
    const coords = state.currentRouteFeature?.geometry?.coordinates;
    const cumulative = state.routeCumulativeMeters;
    if (!Array.isArray(coords) || coords.length < 2 || !Array.isArray(cumulative) || cumulative.length < 2) return null;

    let segIdx = 0;
    for (let i = 0; i < cumulative.length - 1; i += 1) {
      if (alongMeters <= cumulative[i + 1]) {
        segIdx = i;
        break;
      }
      segIdx = i;
    }

    const aLng = Number(coords[segIdx][0]);
    const aLat = Number(coords[segIdx][1]);
    const bLng = Number(coords[segIdx + 1]?.[0] ?? aLng);
    const bLat = Number(coords[segIdx + 1]?.[1] ?? aLat);

    const toRad = (v) => (v * Math.PI) / 180;
    const toDeg = (v) => (v * 180) / Math.PI;
    const dLng = toRad(bLng - aLng);
    const lat1 = toRad(aLat);
    const lat2 = toRad(bLat);
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    const bearing = (toDeg(Math.atan2(y, x)) + 360) % 360;
    return Number.isFinite(bearing) ? bearing : null;
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
    window.TlcNavigationVectorBasemapModule?.activate?.();
    window.TlcNavigationBuildingTintModule?.activate?.();
    ensurePreviewRouteOnTop();
  }

  function deactivateBuildingTintMode() {
    window.TlcNavigationBuildingTintModule?.deactivate?.();
    window.TlcNavigationVectorBasemapModule?.deactivate?.();
  }

  function reapplyBuildingTintModeIfNeeded() {
    window.TlcNavigationVectorBasemapModule?.reapplyIfNeeded?.();
    window.TlcNavigationBuildingTintModule?.reapplyIfNeeded?.();
    ensurePreviewRouteOnTop();
  }

  let lastTintSyncAt = 0;
  function scheduleActiveNavigationTintSync(reason) {
    state.lastLiveMapSyncReason = String(reason || "");
    if (!state.active) return false;
    const now = Date.now();
    if (now - lastTintSyncAt < 2000) return false;
    if (state.liveMapSyncRaf) {
      cancelAnimationFrame(state.liveMapSyncRaf);
    }
    state.liveMapSyncRaf = requestAnimationFrame(() => {
      state.liveMapSyncRaf = 0;
      if (!state.active) return;
      lastTintSyncAt = Date.now();
      window.TlcNavigationBuildingTintModule?.refreshForViewport?.(false);
      ensurePreviewRouteOnTop();
    });
    return true;
  }

  function collapseNavTrayDuringNavigation(collapse) {
    const tray = document.getElementById("navQuickTray");
    const toggle = document.getElementById("navQuickToggle");
    if (collapse) {
      if (tray) tray.hidden = true;
      if (toggle) toggle.hidden = true;
    } else if (toggle) {
      toggle.hidden = false;
    }
  }

  function updateCard() {
    const {
      card, primary, secondary, meta, startBtn, stopBtn, recenterBtn,
      banner, bannerPrimary, bannerIcon, bannerDistance, bannerMeta
    } = getEls();
    if (!card) return;

    const readiness = getStartReadiness();
    const hasPreviewRoute = !!state.hasPreviewRoute;
    if (state.active) {
      card.hidden = true;
      collapseNavTrayDuringNavigation(true);
    } else {
      card.hidden = !hasPreviewRoute && !state.hasPreviewDestination;
      collapseNavTrayDuringNavigation(false);
    }
    if (card.hidden && !state.active) return;

    if (!state.active) {
      if (primary) primary.textContent = readiness.canStart ? "Route preview ready" : (readiness.reason || "Manual route required");
      if (secondary) secondary.textContent = state.manualDestination?.name || "Type a destination to start";
      if (meta) meta.textContent = readiness.canStart ? "Tap Start for turn-by-turn" : (readiness.routeStatus || "Waiting for preview");
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

    if (startBtn) {
      startBtn.hidden = state.active || !state.hasPreviewDestination;
      startBtn.disabled = !readiness.canStart;
    }
    if (stopBtn) stopBtn.hidden = !state.active;
    if (recenterBtn) recenterBtn.hidden = !state.active;

    // Update the active navigation banner
    if (banner) {
      banner.hidden = !state.active;
      if (state.active) {
        if (bannerPrimary) bannerPrimary.textContent = state.currentStepInstruction || "Continue on route";
        if (bannerIcon) bannerIcon.textContent = getManeuverArrow(state.currentSteps?.[state.currentStepIndex]);
        if (bannerDistance) {
          const nextStep = state.currentSteps?.[state.currentStepIndex + 1];
          const nextStreetName = String(nextStep?.name || "").trim();
          const distanceText = formatMeters(state.distanceToNextManeuverMeters);
          if (state.arrivalState === "arrived") {
            bannerDistance.textContent = "Arrived at destination";
          } else if (state.arrivalState === "approaching") {
            bannerDistance.textContent = `Approaching • ${distanceText}`;
          } else if (state.rerouteInFlight) {
            bannerDistance.textContent = "Off route • Re-routing…";
          } else {
            bannerDistance.textContent = nextStreetName
              ? `${distanceText} → ${nextStreetName}`
              : `Next in ${distanceText}`;
          }
        }
        if (bannerMeta) {
          bannerMeta.textContent = `Remaining ${formatMeters(state.remainingDistanceMeters)} • ETA ${formatEta(state.remainingDurationSeconds)}`;
        }
      }
    }
  }

  function maybeFollowCamera() {
    if (!state.active || !state.followModeEnabled || !state.map) return;
    if (!state.lastKnownLocation) return;
    const now = Date.now();
    if (now - Number(state.lastFollowCameraAt || 0) < FOLLOW_CAMERA_INTERVAL_MS) return;

    const target = state.snappedPoint || state.lastKnownLocation;
    const zoom = Math.max(15.5, Number(state.map.getZoom?.() || FOLLOW_ZOOM_DEFAULT));
    state.lastFollowCameraAt = now;

    const bearing = Number.isFinite(state.lastKnownHeadingDeg)
      ? state.lastKnownHeadingDeg
      : (Number.isFinite(state.snappedProgressMeters)
        ? (deriveRouteHeadingAtProgress(state.snappedProgressMeters) ?? state.map.getBearing())
        : state.map.getBearing());

    const suppressMs = 750;
    const easeOpts = {
      center: [target.lng, target.lat],
      zoom: Math.min(17.0, zoom),
      bearing,
      pitch: FOLLOW_PITCH_DEFAULT,
      offset: [0, Math.round((window.innerHeight || 0) * 0.18)],
      duration: 550,
      essential: true,
    };
    if (typeof window.suppressAutoDisableFor === "function") {
      window.suppressAutoDisableFor(suppressMs, () => {
        state.map.easeTo(easeOpts);
      });
    } else {
      state.map.easeTo(easeOpts);
    }
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

    const sessionAtStart = state.sessionId;
    const rerouteAsync = async () => {
      try {
        const result = await window.TlcNavigationPreviewModule?.setPreviewDestination?.(
          state.manualDestination,
          { source: "manual" }
        );
        if (sessionAtStart !== state.sessionId || !state.active) return;
        state.rerouteInFlight = false;
        if (result?.routeBundle?.routeFeature) {
          state.offRoute = false;
          state.offRouteSamples = 0;
          state.navigationStatus = "active";
        } else {
          state.navigationStatus = "active";
        }
        updateCard();
      } catch (_err) {
        if (sessionAtStart !== state.sessionId || !state.active) return;
        state.rerouteInFlight = false;
        state.navigationStatus = "active";
        updateCard();
      }
    };
    rerouteAsync();
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
    if (!Number.isFinite(state.lastKnownHeadingDeg) || state.lastKnownHeadingSource !== "gps") {
      const routeHeading = deriveRouteHeadingAtProgress(snapped.alongMeters);
      if (Number.isFinite(routeHeading)) {
        state.lastKnownHeadingDeg = routeHeading;
        state.lastKnownHeadingSource = "route";
      }
    }
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
    state.lastKnownHeadingSource = "none";
    state.rerouteInFlight = false;
    state.arrivalState = "none";
  }

  function onPreviewRouteUpdated(routeBundle) {
    const source = String(routeBundle?.destinationSource || "");
    const destination = toLatLng(routeBundle?.destination);
    const incomingRouteFeature = routeBundle?.routeFeature || null;
    const hasIncomingRoute = !!incomingRouteFeature?.geometry?.coordinates?.length;

    const nextManualDestination = source === "manual" && destination
      ? { ...routeBundle.destination }
      : null;
    const hasIncomingDestination = !!destination;

    if (!hasIncomingRoute && state.active) {
      // Do not stop navigation on transient null routes — keep using the last known route.
      // Only stop if the preview was explicitly cleared (handled by onPreviewRouteCleared).
      state.hasPreviewRoute = false;
      state.hasPreviewDestination = hasIncomingDestination;
      state.manualDestination = nextManualDestination;
      if (!state.hasPreviewDestination && !state.manualDestination) {
        stopNavigation();
        return;
      }
      // Transient failure — skip update but keep navigating with existing route state.
      updateCard();
      return;
    }

    state.manualDestination = nextManualDestination;
    state.currentRouteFeature = incomingRouteFeature;
    state.currentRouteSummary = routeBundle?.routeSummary ? { ...routeBundle.routeSummary } : null;
    state.currentSteps = Array.isArray(routeBundle?.steps) ? routeBundle.steps.slice() : [];
    state.hasPreviewRoute = hasIncomingRoute;
    state.hasPreviewDestination = hasIncomingDestination;
    if (state.hasPreviewRoute) {
      state.lastStartFailureReason = "";
    }
    preprocessRouteMetrics();

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
    state.hasPreviewRoute = false;
    state.hasPreviewDestination = false;
    state.lastStartFailureReason = "";
    stopNavigation();
    updateCard();
  }

  function syncNavigationInputsFromPreview() {
    const routeBundle = window.TlcNavigationPreviewModule?.getRouteBundle?.() || null;
    if (!routeBundle) return;
    const destination = toLatLng(routeBundle?.destination);
    const fallbackDestination = toLatLng(window.TlcManualNavigationModule?.getCurrentDestination?.());

    if (!state.manualDestination && (destination || fallbackDestination)) {
      const src = destination || fallbackDestination;
      state.manualDestination = {
        ...src,
        name: routeBundle?.destination?.name || window.TlcManualNavigationModule?.getCurrentDestination?.()?.name || "Selected destination",
      };
    }

    if (routeBundle?.routeFeature?.geometry?.coordinates?.length) {
      state.currentRouteFeature = routeBundle.routeFeature;
      state.currentRouteSummary = routeBundle?.routeSummary ? { ...routeBundle.routeSummary } : null;
      state.currentSteps = Array.isArray(routeBundle?.steps) ? routeBundle.steps.slice() : [];
      preprocessRouteMetrics();
    }

    state.hasPreviewRoute = !!routeBundle?.routeFeature?.geometry?.coordinates?.length;
    state.hasPreviewDestination = !!destination || !!state.manualDestination;
  }

  function getStartReadiness() {
    const previewSnapshot = window.TlcNavigationPreviewModule?.getSnapshot?.() || {};
    const routeStatus = String(previewSnapshot?.statusReason || previewSnapshot?.status || "").trim();
    const hasDestination = !!state.manualDestination || !!previewSnapshot?.destinationReady || !!state.hasPreviewDestination;
    const hasRoute = !!state.currentRouteFeature?.geometry?.coordinates?.length || !!previewSnapshot?.routeReady || !!state.hasPreviewRoute;

    if (!hasDestination) {
      return { canStart: false, reason: "Type a destination", hasRoute, hasDestination, routeStatus };
    }
    if (!hasRoute) {
      return {
        canStart: false,
        reason: routeStatus || "Searching…",
        hasRoute: false,
        hasDestination: true,
        routeStatus,
      };
    }
    return { canStart: true, reason: "", hasRoute: true, hasDestination: true, routeStatus };
  }

  function onUserLocationUpdate(location) {
    const ll = toLatLng(location);
    if (!ll) return;
    state.lastKnownLocation = ll;
    const rawHeading = Number(location?.heading);
    if (Number.isFinite(rawHeading)) {
      state.lastKnownHeadingDeg = rawHeading;
      state.lastKnownHeadingSource = "gps";
    }
    if (state.active) {
      window.TlcNavigationBuildingTintModule?.refreshForViewport?.();
    }
    refreshProgressFromLocation(ll);
  }

  function startNavigation() {
    if (state.active) return false;
    syncNavigationInputsFromPreview();
    const readiness = getStartReadiness();
    if (!readiness.canStart) {
      state.lastStartFailureReason = readiness.reason;
      updateCard();
      window.dispatchEvent(new CustomEvent("tlc-nav-start-failed", {
        detail: {
          reason: readiness.reason,
          snapshot: getSnapshot(),
        },
      }));
      return false;
    }
    state.lastStartFailureReason = "";

    state.active = true;
    document.body.classList.add("tlc-nav-active");
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
    window.dispatchEvent(new CustomEvent("tlc-nav-started", {
      detail: { snapshot: getSnapshot() },
    }));
    return true;
  }

  function stopNavigation() {
    const wasActive = state.active;
    state.active = false;
    document.body.classList.remove("tlc-nav-active");
    state.navigationStatus = state.arrivalState === "arrived" ? "arrived" : "stopped";
    state.followModeEnabled = false;
    state.offRoute = false;
    state.offRouteSamples = 0;
    state.lastKnownHeadingDeg = null;
    state.lastKnownHeadingSource = "none";
    state.rerouteInFlight = false;
    if (state.liveMapSyncRaf) {
      cancelAnimationFrame(state.liveMapSyncRaf);
    }
    state.liveMapSyncRaf = 0;
    state.lastLiveMapSyncReason = "";
    deactivateBuildingTintMode();
    const { banner } = getEls();
    if (banner) banner.hidden = true;
    updateCard();
    if (wasActive) {
      window.dispatchEvent(new CustomEvent("tlc-nav-stopped", {
        detail: { snapshot: getSnapshot() },
      }));
    }
  }

  function isActive() {
    return !!state.active;
  }

  function canStart() {
    syncNavigationInputsFromPreview();
    return !!getStartReadiness().canStart;
  }

  function toggleNavigation() {
    if (state.active) {
      stopNavigation();
      return false;
    }
    return startNavigation();
  }

  function recenterNavigationCamera() {
    state.followModeEnabled = true;
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
    const { bannerStop, bannerRecenter } = getEls();
    if (bannerStop && !bannerStop.dataset.boundTurnNav) {
      bannerStop.dataset.boundTurnNav = "1";
      bannerStop.addEventListener("click", () => {
        stopNavigation();
      });
    }
    if (bannerRecenter && !bannerRecenter.dataset.boundTurnNav) {
      bannerRecenter.dataset.boundTurnNav = "1";
      bannerRecenter.addEventListener("click", recenterNavigationCamera);
    }
  }

  function init(map) {
    state.map = map || null;

    // Register the preview-event listeners FIRST, before any submodule init
    // call that could throw synchronously. If the vector-basemap or
    // building-tint init failed (missing layer, malformed style, etc.), the
    // exception would propagate out of init() and skip the listener
    // registration below — leaving turn-by-turn deaf to preview events and
    // navTurnCard permanently hidden even after a successful route. Binding
    // listeners first ensures the Start Nav button shows up regardless of
    // any downstream init hiccup.
    window.addEventListener("tlc-nav-preview-updated", (event) => {
      onPreviewRouteUpdated(event?.detail?.routeBundle || null);
    });

    window.addEventListener("tlc-nav-preview-cleared", () => {
      onPreviewRouteCleared();
    });

    window.addEventListener("tlc-user-location-updated", (event) => {
      onUserLocationUpdate(event?.detail || null);
    });

    bindUi();

    // Submodule inits are wrapped in try/catch so a failure in a purely
    // visual module (vector basemap, building tint) cannot abort the core
    // nav wiring above.
    try {
      window.TlcNavigationVectorBasemapModule?.init?.(state.map);
    } catch (err) {
      console.warn("VectorBasemapModule init failed:", err);
    }
    try {
      window.TlcNavigationBuildingTintModule?.init?.(state.map);
    } catch (err) {
      console.warn("BuildingTintModule init failed:", err);
    }

    if (state.map?.on) {
      state.map.on("styledata", () => {
        if (state.active) {
          reapplyBuildingTintModeIfNeeded();
        }
      });
      let lastIdleReapplyAt = 0;
      state.map.on("idle", () => {
        if (!state.active) return;
        const now = Date.now();
        if (now - lastIdleReapplyAt < 3000) return;
        lastIdleReapplyAt = now;
        reapplyBuildingTintModeIfNeeded();
      });
    }

    // (preview-updated, preview-cleared, and user-location-updated
    // listeners were moved to the top of init() so a submodule init throw
    // doesn't leave them unregistered.)

    if (!state.runtimeSyncListenersBound) {
      state.runtimeSyncListenersBound = true;
      window.addEventListener("team-joseo-frame-rendered", () => {
        scheduleActiveNavigationTintSync("frame-rendered");
      });
      window.addEventListener("tlc-mode-changed", () => {
        scheduleActiveNavigationTintSync("mode-changed");
      });
    }

    const routeBundle = window.TlcNavigationPreviewModule?.getRouteBundle?.();
    if (routeBundle) {
      onPreviewRouteUpdated(routeBundle);
    } else {
      updateCard();
    }
  }

  function getSnapshot() {
    const readiness = getStartReadiness();
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
      lastLiveMapSyncReason: state.lastLiveMapSyncReason || "",
      lastKnownHeadingDeg: state.lastKnownHeadingDeg,
      lastKnownHeadingSource: state.lastKnownHeadingSource || "none",
      canStart: !!readiness.canStart,
      hasPreviewRoute: !!state.hasPreviewRoute,
      hasPreviewDestination: !!state.hasPreviewDestination,
      lastStartFailureReason: state.lastStartFailureReason || "",
    };
  }

  window.TlcNavigationTurnModule = {
    init,
    startNavigation,
    stopNavigation,
    toggleNavigation,
    isActive,
    canStart,
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
      lastKnownHeadingDeg: null,
      lastKnownHeadingSource: "none",
      sessionId: 0,
      canStart: false,
      hasPreviewRoute: false,
      hasPreviewDestination: false,
      lastStartFailureReason: "",
    };
  };
})();
