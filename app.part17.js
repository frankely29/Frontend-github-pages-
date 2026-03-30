(function() {
  const STABLE_MIN_MS = 3000;
  const STABLE_MIN_HITS = 2;
  const CLEAR_GRACE_MS = 5000;
  const STYLE_ID = "tlc-ai-assistant-style";

  const state = {
    activeStableZoneId: null,
    activeStableZoneName: "",
    activeStableBorough: "",
    activeStableZoneEnterTs: null,
    activeStableZoneDwellMs: 0,
    candidateZoneId: null,
    candidateZoneFirstSeenTs: null,
    candidateZoneConsecutiveHits: 0,
    candidateZoneName: "",
    candidateZoneBorough: "",
    candidateZoneAirportExcluded: false,
    activeZoneLastSeenTs: null,
    lastUserLocation: null,
    lastFrameTime: null,
    visibleScoreSource: null,
    visibleScoreSourceLabel: null,
    visibleRating: null,
    visibleBucket: null,
    airportExcluded: false,
    assistantStatus: "idle",
    assistantHeadline: "AI Assistant: locating current zone…",
    assistantSubline: "Waiting for location and frame.",
    assistantSeverity: "neutral",
    assistantMoveTarget: null,
    assistantPhase: 1,
    short_trip_penalty_n_shadow: null,
    busy_now_base_n_shadow: null,
    busy_next_base_n_shadow: null,
    long_trip_share_20plus: null,
    balanced_trip_share_shadow: null,
    churn_pressure_n_shadow: null,
    market_saturation_penalty_n_shadow: null,
    manhattan_core_saturation_penalty_n_shadow: null,
    downstream_next_value_raw: null,
    rating: null,
    bucket: null,
  };

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .aiAssistBanner{display:flex;flex-direction:column;gap:2px;line-height:1.25}
      .aiAssistHeadline{font-weight:700}
      .aiAssistMeta{font-size:12px;opacity:.95}
      .aiAssistFooter{font-size:11px;opacity:.8}
    `;
    document.head.appendChild(style);
  }

  function numberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function getRecommendEl() {
    return window.TlcMapUiInternals?.getRecommendEl?.() || document.getElementById("recommendLine") || null;
  }

  function getFrame(frame) {
    return frame || window.TlcModeInternals?.getCurrentFrame?.() || null;
  }

  function formatDwell(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "In zone for 0s";
    const sec = Math.floor(ms / 1000);
    if (sec >= 60) return `In zone for ${Math.round(sec / 60)}m`;
    return `In zone for ${sec}s`;
  }

  function applyNeutralStatus(reason) {
    state.assistantSeverity = "neutral";
    if (reason === "frame-unavailable") {
      state.assistantStatus = "frame-unavailable";
      state.assistantHeadline = "AI Assistant: frame unavailable";
      state.assistantSubline = "Waiting for score frame.";
      return;
    }
    if (reason === "locating") {
      state.assistantStatus = "locating";
      state.assistantHeadline = "AI Assistant: locating current zone…";
      state.assistantSubline = "Need a stable zone lock from location updates.";
      return;
    }
    if (reason === "airport") {
      state.assistantStatus = "airport-excluded";
      state.assistantHeadline = "AI Assistant: airport zone — hotspot logic excluded";
      state.assistantSubline = "Airport zone is excluded for hotspot guidance.";
      return;
    }
    state.assistantStatus = "no-stable-zone";
    state.assistantHeadline = "AI Assistant: no stable zone yet";
    state.assistantSubline = "Hold position briefly for stable zone detection.";
  }

  function renderBanner() {
    const host = getRecommendEl();
    if (!host) return;
    ensureStyle();

    const zoneTxt = state.activeStableZoneName || "—";
    const boroughTxt = state.activeStableBorough || "—";
    const ratingTxt = Number.isFinite(state.visibleRating) ? `${Math.round(state.visibleRating)} (${state.visibleBucket || "n/a"})` : "n/a";
    const sourceTxt = state.visibleScoreSourceLabel || "Team Joseo score";
    const dwellTxt = formatDwell(state.activeStableZoneDwellMs);

    host.innerHTML = `
      <div class="aiAssistBanner" data-phase="1">
        <div class="aiAssistHeadline">AI Assistant</div>
        <div class="aiAssistMeta">${state.assistantHeadline}</div>
        <div class="aiAssistMeta">Zone: ${zoneTxt} • Borough: ${boroughTxt}</div>
        <div class="aiAssistMeta">Rating/Bucket: ${ratingTxt}</div>
        <div class="aiAssistMeta">Visible source: ${sourceTxt}</div>
        <div class="aiAssistMeta">${dwellTxt}</div>
        <div class="aiAssistFooter">Phase 1 active: stable zone tracking</div>
      </div>
    `;
  }

  function getSnapshot() {
    const now = Date.now();
    const dwellMs = state.activeStableZoneEnterTs ? Math.max(0, now - state.activeStableZoneEnterTs) : 0;
    return {
      ...state,
      activeStableZoneDwellMs: dwellMs,
      dwell_ms: dwellMs,
      dwell_seconds: Math.floor(dwellMs / 1000),
      dwell_minutes_rounded: Math.round(dwellMs / 60000),
      ts: now,
    };
  }

  function emitZoneChanged() {
    window.dispatchEvent(new CustomEvent("tlc-ai-assistant-zone-changed", { detail: getSnapshot() }));
  }

  function clearNavDestination() {
    window.TlcMapUiModule?.setNavDestination?.(null);
  }

  function setActiveStableZoneFromFeature(feature, now) {
    const props = feature?.properties || {};
    const nextId = String(window.TlcMapUiInternals?.getZoneLocationId?.(props) || "").trim() || null;
    const changed = nextId !== state.activeStableZoneId;

    state.activeStableZoneId = nextId;
    state.activeStableZoneName = String(props.zone_name || "").trim() || (nextId ? `Zone ${nextId}` : "");
    state.activeStableBorough = String(props.borough || "").trim();
    state.activeStableZoneEnterTs = now;
    state.activeStableZoneDwellMs = 0;
    state.airportExcluded = props.airport_excluded === true;

    if (changed) emitZoneChanged();
  }

  function updateStableZone(now) {
    const loc = state.lastUserLocation;
    if (!loc || !Number.isFinite(loc.lng) || !Number.isFinite(loc.lat)) {
      applyNeutralStatus("locating");
      return;
    }

    const feature = window.TlcMapUiInternals?.resolveZoneFeatureAtLngLat?.({ lng: loc.lng, lat: loc.lat }) || null;

    if (!feature) {
      if (state.activeStableZoneId && state.activeZoneLastSeenTs && now - state.activeZoneLastSeenTs > CLEAR_GRACE_MS) {
        state.activeStableZoneId = null;
        state.activeStableZoneName = "";
        state.activeStableBorough = "";
        state.activeStableZoneEnterTs = null;
      }
      if (!state.activeStableZoneId) applyNeutralStatus("no-stable-zone");
      return;
    }

    const props = feature.properties || {};
    const zoneId = String(window.TlcMapUiInternals?.getZoneLocationId?.(props) || "").trim() || null;
    if (!zoneId) {
      applyNeutralStatus("no-stable-zone");
      return;
    }

    state.activeZoneLastSeenTs = now;

    if (state.candidateZoneId !== zoneId) {
      state.candidateZoneId = zoneId;
      state.candidateZoneFirstSeenTs = now;
      state.candidateZoneConsecutiveHits = 1;
      state.candidateZoneName = String(props.zone_name || "").trim();
      state.candidateZoneBorough = String(props.borough || "").trim();
      state.candidateZoneAirportExcluded = props.airport_excluded === true;
      if (!state.activeStableZoneId) applyNeutralStatus("locating");
      return;
    }

    state.candidateZoneConsecutiveHits += 1;

    const stableForMs = now - (state.candidateZoneFirstSeenTs || now);
    const isStable = state.candidateZoneConsecutiveHits >= STABLE_MIN_HITS && stableForMs >= STABLE_MIN_MS;

    if (isStable && state.activeStableZoneId !== zoneId) {
      setActiveStableZoneFromFeature(feature, now);
    }

    if (!state.activeStableZoneId) {
      applyNeutralStatus("locating");
    }
  }

  function updateFrameDerivedState(frame, now) {
    const activeId = state.activeStableZoneId;
    if (!frame) {
      state.lastFrameTime = null;
      applyNeutralStatus("frame-unavailable");
      return;
    }

    state.lastFrameTime = now;
    if (!activeId) return;

    const features = frame?.polygons?.features || [];
    const feature = features.find((f) => String(window.TlcMapUiInternals?.getZoneLocationId?.(f?.properties || {})) === String(activeId)) || null;
    if (!feature) return;

    const props = feature.properties || {};
    const geom = feature.geometry || null;

    state.visibleScoreSource = String(window.TlcModeModule?.getVisibleScoreSourceForFeature?.(props, geom) || window.TlcMapUiInternals?.getVisibleScoreSourceForFeature?.(props, geom) || "legacy_citywide");
    state.visibleScoreSourceLabel = String(window.TlcModeModule?.getVisibleScoreSourceLabel?.(props, geom) || window.TlcMapUiInternals?.getVisibleScoreSourceLabel?.(props, geom) || "Team Joseo score");
    state.visibleRating = numberOrNull(window.TlcModeModule?.effectiveRating?.(props, geom));
    state.visibleBucket = String(window.TlcModeModule?.effectiveBucket?.(props, geom) || "").trim() || null;
    state.rating = state.visibleRating;
    state.bucket = state.visibleBucket;

    state.short_trip_penalty_n_shadow = numberOrNull(props.short_trip_penalty_n_shadow);
    state.busy_now_base_n_shadow = numberOrNull(props.busy_now_base_n_shadow);
    state.busy_next_base_n_shadow = numberOrNull(props.busy_next_base_n_shadow);
    state.long_trip_share_20plus = numberOrNull(props.long_trip_share_20plus);
    state.balanced_trip_share_shadow = numberOrNull(props.balanced_trip_share_shadow ?? props.balanced_trip_share);
    state.churn_pressure_n_shadow = numberOrNull(props.churn_pressure_n_shadow);
    state.market_saturation_penalty_n_shadow = numberOrNull(props.market_saturation_penalty_n_shadow);
    state.manhattan_core_saturation_penalty_n_shadow = numberOrNull(props.manhattan_core_saturation_penalty_n_shadow ?? props.manhattan_core_saturation_proxy_n_shadow);
    state.downstream_next_value_raw = numberOrNull(props.downstream_next_value_raw);

    if (state.airportExcluded) {
      applyNeutralStatus("airport");
    } else {
      state.assistantStatus = "tracking";
      state.assistantHeadline = "AI Assistant: tracking current zone";
      state.assistantSubline = "Stable polygon containment lock active.";
      state.assistantSeverity = "info";
    }
  }

  function refresh(frame) {
    const now = Date.now();
    updateStableZone(now);
    updateFrameDerivedState(getFrame(frame), now);
    state.activeStableZoneDwellMs = state.activeStableZoneEnterTs ? Math.max(0, now - state.activeStableZoneEnterTs) : 0;
    clearNavDestination();
    renderBanner();
    return getSnapshot();
  }

  function handleUserLocationUpdate(detail) {
    const lat = Number(detail?.lat ?? NaN);
    const lng = Number(detail?.lng ?? NaN);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return refresh();
    }

    state.lastUserLocation = {
      lat,
      lng,
      ts: Number(detail?.ts ?? Date.now()) || Date.now(),
      heading: Number.isFinite(Number(detail?.heading)) ? Number(detail.heading) : null,
      accuracy: Number.isFinite(Number(detail?.accuracy)) ? Number(detail.accuracy) : null,
    };

    return refresh();
  }

  function updateAssistantForFrame(frame) {
    return refresh(frame);
  }

  function forceRefresh() {
    return refresh();
  }

  function clearState() {
    state.activeStableZoneId = null;
    state.activeStableZoneName = "";
    state.activeStableBorough = "";
    state.activeStableZoneEnterTs = null;
    state.activeStableZoneDwellMs = 0;
    state.candidateZoneId = null;
    state.candidateZoneFirstSeenTs = null;
    state.candidateZoneConsecutiveHits = 0;
    state.candidateZoneName = "";
    state.candidateZoneBorough = "";
    state.candidateZoneAirportExcluded = false;
    state.activeZoneLastSeenTs = null;
    state.lastFrameTime = null;
    state.visibleScoreSource = null;
    state.visibleScoreSourceLabel = null;
    state.visibleRating = null;
    state.visibleBucket = null;
    state.airportExcluded = false;
    state.assistantStatus = "idle";
    state.assistantHeadline = "AI Assistant: locating current zone…";
    state.assistantSubline = "Waiting for location and frame.";
    state.assistantSeverity = "neutral";
    state.assistantMoveTarget = null;
    state.rating = null;
    state.bucket = null;
    renderBanner();
    clearNavDestination();
    return getSnapshot();
  }

  window.TlcAiAssistantModule = {
    updateAssistantForFrame,
    handleUserLocationUpdate,
    getSnapshot,
    forceRefresh,
    clearState,
  };

  window.getTeamJoseoAiAssistantSnapshot = () => window.TlcAiAssistantModule?.getSnapshot?.() || null;

  window.addEventListener("tlc-user-location-updated", (event) => {
    window.TlcAiAssistantModule?.handleUserLocationUpdate?.(event?.detail || {});
  });

  window.addEventListener("team-joseo-frame-rendered", () => {
    window.TlcAiAssistantModule?.forceRefresh?.();
  });

  window.addEventListener("tlc-mode-changed", () => {
    window.TlcAiAssistantModule?.forceRefresh?.();
  });

  renderBanner();
})();
