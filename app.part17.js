(function() {
  const AI_ASSISTANT_STABLE_MIN_MS = 3000;
  const AI_ASSISTANT_STABLE_MIN_HITS = 2;
  const AI_ASSISTANT_CLEAR_GRACE_MS = 5000;
  const AI_ASSISTANT_ROTATE_MS = 5000;
  const AI_ASSISTANT_HEARTBEAT_MS_VISIBLE = 15000;
  const AI_ASSISTANT_HEARTBEAT_MS_HIDDEN = 60000;

  const runtime = window.FrontendRuntime || null;
  const runtimePolling = runtime?.polling || null;
  const internals = window.TlcMapUiInternals || {};
  const modeModule = window.TlcModeModule || {};
  const crowdModule = window.TlcCommunityCrowdingModule || {};

  const recommendLine = internals.getRecommendEl?.() || document.getElementById("recommendLine");
  const dockMount = document.getElementById("aiAssistantWidgetMount");
  let topBadgeResizeObserver = null;
  let topBadgeObserversInstalled = false;

  const state = {
    activeStableZoneId: null,
    activeStableZoneName: "",
    activeStableBorough: "",
    activeStableZoneEnterTs: null,
    activeStableZoneDwellMs: 0,
    candidateZoneId: null,
    candidateZoneFirstSeenTs: null,
    candidateZoneHits: 0,
    activeStableFeatureSignal: null,
    activeZoneLastSeenTs: null,
    lastUserLocation: null,
    lastFrameTime: null,
    visibleScoreSource: "legacy_citywide",
    visibleScoreSourceLabel: "Team Joseo score",
    visibleRating: null,
    visibleBucket: null,
    airportExcluded: false,
    currentZoneCitywideRank: null,
    currentZoneCitywideTotal: 0,
    currentZoneBoroughRank: null,
    currentZoneBoroughTotal: 0,
    currentBoroughName: "",
    citywideBestNow: null,
    citywideWorstNow: null,
    citywideTop10Best: [],
    citywideTop10Worst: [],
    boroughBestNow: null,
    boroughWorstNow: null,
    boroughTop5Best: [],
    boroughTop5Worst: [],
    bestNearbyOverall: null,
    bestNearbyTrapEscape: null,
    bestNearbyLongTrip: null,
    assistantMoveTarget: null,
    baseActionCode: "MONITOR",
    baseActionReason: "Collecting more context.",
    finalActionCode: "MONITOR",
    finalActionReason: "Collecting more context.",
    actionSeverity: "info",
    scoreAdvantageVsCurrent: null,
    currentZoneOutlook: null,
    moveTargetOutlook: null,
    holdUntilTime: null,
    trapUntilTime: null,
    busyUntilTime: null,
    slowUntilTime: null,
    nextImprovementTime: null,
    nextWorseningTime: null,
    targetStrongUntilTime: null,
    outlookSummaryText: "Outlook unavailable.",
    moveTargetOutlookSummaryText: "",
    dwellRiskCode: "neutral",
    dwellEscalationLevel: 0,
    dwellWarningActive: false,
    dwellWarnAtTs: null,
    dwellUrgentAtTs: null,
    dwellShouldLeaveByTs: null,
    dwellCountdownMs: null,
    dwellCoachSummaryText: "Stay timer starting.",
    dwellCoachReasonFragments: [],
    assistantReasonFragments: [],
    assistantMessages: [],
    activeMessageIndex: 0,
    activeMessageKey: "",
    activeMessageSeverity: "info",
    activeMessageIcon: "info",
    marqueeActive: false,
    marqueeDurationMs: 12000,
    rotationPaused: false,
    expanded: false,
    rankingsExpanded: false,
    outlookExpanded: false,
    dwellExpanded: false,
    feedUpdatedAt: 0,
    assistantFeedVersion: 1,
    assistantFeedMaterialKey: "",
    assistantAlertKey: "",
    frameFeatures: [],
    outlookCache: new Map(),
    outlookAbortController: null,
    heartbeatHandle: null,
    heartbeatKey: null,
    touchPauseUntil: 0,
    hoverPaused: false,
    marqueeTimeout: null,
    rotationTimerHandle: null,
    rotationNextDueAt: 0,
  };

  function safeNum(v, fallback = null) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function prettyBucket(value) {
    const text = String(value || "").trim().toLowerCase();
    const labels = { green: "Highest", purple: "Very High", indigo: "High", blue: "Medium", sky: "Normal", yellow: "Below", orange: "Low", red: "Avoid" };
    return labels[text] || (text ? text[0].toUpperCase() + text.slice(1) : "n/a");
  }

  function getZoneId(props) {
    return String(internals.getZoneLocationId?.(props || {}) || props?.LocationID || "").trim() || null;
  }

  function readCrowdingPenalty(props) {
    const id = getZoneId(props);
    const n = safeNum(crowdModule.getCommunityCrowdingPenaltyForZone?.(id));
    if (Number.isFinite(n)) return n;
    return safeNum(props?.community_crowding_penalty, 0) || 0;
  }

  function readCrowdingBucket(props) {
    const id = getZoneId(props);
    return String(crowdModule.getCommunityCrowdingBucketForZone?.(id) || props?.community_crowding_bucket || "").trim() || "none";
  }

  function buildAssistantFeatureSignal(feature) {
    const props = feature?.properties || {};
    const geom = feature?.geometry || null;
    const center = internals.geometryCenter?.(geom) || null;
    const visibleRating = safeNum(modeModule.effectiveRating?.(props, geom), safeNum(props?.rating));
    const signal = {
      locationId: getZoneId(props),
      zoneName: String(props.zone_name || props.Zone || "").trim() || "Unknown zone",
      borough: String(props.borough || "").trim() || "Unknown",
      centerLat: safeNum(center?.lat),
      centerLng: safeNum(center?.lng),
      visibleRating,
      visibleBucket: String(modeModule.effectiveBucket?.(props, geom) || props?.bucket || "").trim() || null,
      visibleScoreSource: String(modeModule.getVisibleScoreSourceForFeature?.(props, geom) || internals.getVisibleScoreSourceForFeature?.(props, geom) || "legacy_citywide"),
      visibleScoreSourceLabel: String(modeModule.getVisibleScoreSourceLabel?.(props, geom) || internals.getVisibleScoreSourceLabel?.(props, geom) || "Team Joseo score"),
      airportExcluded: !!props.airport_excluded || /airport|jfk|laguardia|newark/i.test(String(props.zone_name || "")),
      communityCrowdingPenalty: readCrowdingPenalty(props),
      communityCrowdingBucket: readCrowdingBucket(props),
      busyNowBase: safeNum(props.busy_now_base_n_shadow, safeNum(props.busy_now_base, 0)) || 0,
      busyNextBase: safeNum(props.busy_next_base_n_shadow, safeNum(props.busy_next_base, 0)) || 0,
      shortTripPenalty: safeNum(props.short_trip_penalty_n_shadow, safeNum(props.short_trip_penalty, 0)) || 0,
      longTripShare20Plus: safeNum(props.long_trip_share_20plus, 0) || 0,
      balancedTripShare: safeNum(props.balanced_trip_share_shadow, safeNum(props.balanced_trip_share, 0)) || 0,
      churnPressure: safeNum(props.churn_pressure_n_shadow, safeNum(props.churn_pressure, 0)) || 0,
      marketSaturationPenalty: safeNum(props.market_saturation_penalty_n_shadow, 0) || 0,
      manhattanCoreSaturationPenalty: safeNum(props.manhattan_core_saturation_penalty_n_shadow, safeNum(props.manhattan_core_saturation_proxy_n_shadow, 0)) || 0,
      continuationRaw: safeNum(props.downstream_next_value_raw, safeNum(props.continuation_raw, 0)) || 0,
      feature,
    };
    return signal;
  }

  function classifyAssistantSignal(signal) {
    const continuationWeak = signal.continuationRaw <= 0.4;
    const continuationGood = signal.continuationRaw >= 0.62;
    const shortTrap = signal.shortTripPenalty >= 0.58 && signal.churnPressure >= 0.5 && continuationWeak;
    const longFriendly = signal.longTripShare20Plus >= 0.5 && signal.continuationRaw >= 0.5 && signal.marketSaturationPenalty < 0.62;
    const busyNow = (signal.visibleRating || 0) >= 60 && signal.busyNowBase >= 0.55;
    const slowNow = (signal.visibleRating || 0) < 48 || signal.busyNowBase <= 0.35;
    const saturationCaution = signal.marketSaturationPenalty >= 0.55 || signal.manhattanCoreSaturationPenalty >= 0.62;
    const tags = [];
    if (shortTrap) tags.push("short_trip_trap");
    if (longFriendly) tags.push("long_trip_friendly");
    if (busyNow) tags.push("busy_now");
    if (slowNow) tags.push("slow_now");
    if (saturationCaution) tags.push("saturation_caution");
    if (continuationGood) tags.push("good_continuation");
    if (continuationWeak) tags.push("weak_continuation");
    const severity = shortTrap ? "move" : (saturationCaution || slowNow ? "caution" : (busyNow ? "positive" : "info"));
    return { tags, shortTrap, longFriendly, busyNow, slowNow, saturationCaution, continuationGood, continuationWeak, severity };
  }

  function sortByRatingThenId(a, b) {
    const ar = safeNum(a?.visibleRating, -Infinity);
    const br = safeNum(b?.visibleRating, -Infinity);
    if (ar !== br) return br - ar;
    const aid = safeNum(a?.locationId, Infinity);
    const bid = safeNum(b?.locationId, Infinity);
    if (aid !== bid) return aid - bid;
    return String(a?.zoneName || "").localeCompare(String(b?.zoneName || ""));
  }

  function scoreAssistantCandidate(signal, currentSignal, distanceMiles, intent) {
    const basePenalty = /queens/i.test(signal.borough) ? 5.0 : (/bronx|wash heights/i.test(signal.zoneName) ? 2.0 : 4.0);
    let score = (signal.visibleRating || 0) - (distanceMiles * basePenalty) - (signal.communityCrowdingPenalty || 0);
    if (intent === "trap_escape") {
      score += (1 - signal.shortTripPenalty) * 16;
      score += (1 - signal.churnPressure) * 10;
      score += signal.continuationRaw * 12;
      score += (1 - signal.marketSaturationPenalty) * 8;
    } else if (intent === "long_trip") {
      score += signal.longTripShare20Plus * 18;
      score += signal.continuationRaw * 10;
      score += (1 - signal.marketSaturationPenalty) * 8;
    } else {
      score += signal.continuationRaw * 4;
    }
    score += ((signal.visibleRating || 0) - (currentSignal?.visibleRating || 0)) * 0.2;
    return score;
  }

  function computeNearbyAssistantCandidates(frame, currentSignal) {
    const out = { overall: null, trap_escape: null, long_trip: null };
    if (!currentSignal) return out;
    const all = (frame?.polygons?.features || []).map(buildAssistantFeatureSignal).filter((s) => s.locationId && !s.airportExcluded && Number.isFinite(s.visibleRating) && Number.isFinite(s.centerLat) && Number.isFinite(s.centerLng));
    const intents = [
      { key: "overall", radius: 3.5 },
      { key: "trap_escape", radius: 4.5 },
      { key: "long_trip", radius: 5.0 },
    ];
    for (const intent of intents) {
      let best = null;
      for (const signal of all) {
        if (signal.locationId === currentSignal.locationId) continue;
        const miles = internals.haversineMiles?.({ lat: currentSignal.centerLat, lng: currentSignal.centerLng }, { lat: signal.centerLat, lng: signal.centerLng }) || Infinity;
        if (!Number.isFinite(miles) || miles > intent.radius) continue;
        const score = scoreAssistantCandidate(signal, currentSignal, miles, intent.key);
        if (!best || score > best.score) {
          best = { signal, score, distanceMiles: miles };
        }
      }
      out[intent.key] = best;
    }
    return out;
  }

  function computeRankings(frame, activeSignal) {
    const signals = (frame?.polygons?.features || []).map(buildAssistantFeatureSignal).filter((s) => s.locationId && Number.isFinite(s.visibleRating) && !s.airportExcluded);
    signals.sort(sortByRatingThenId);
    const borough = String(activeSignal?.borough || "").trim();
    const boroughSignals = signals.filter((s) => String(s.borough || "") === borough);

    state.currentZoneCitywideTotal = signals.length;
    state.currentZoneBoroughTotal = boroughSignals.length;
    state.citywideTop10Best = signals.slice(0, 10);
    state.citywideTop10Worst = [...signals].reverse().slice(0, 10);
    state.citywideBestNow = signals[0] || null;
    state.citywideWorstNow = [...signals].reverse()[0] || null;
    state.boroughTop5Best = boroughSignals.slice(0, 5);
    state.boroughTop5Worst = [...boroughSignals].reverse().slice(0, 5);
    state.boroughBestNow = boroughSignals[0] || null;
    state.boroughWorstNow = [...boroughSignals].reverse()[0] || null;
    state.currentBoroughName = borough;

    const currId = String(activeSignal?.locationId || "");
    state.currentZoneCitywideRank = currId ? (signals.findIndex((s) => s.locationId === currId) + 1 || null) : null;
    state.currentZoneBoroughRank = currId ? (boroughSignals.findIndex((s) => s.locationId === currId) + 1 || null) : null;
  }

  function frameTimeIso(frame) {
    return String(frame?.frame_time || frame?.frame_iso || frame?.time_iso || "").trim() || null;
  }

  function buildOutlookCacheKey(frameTime, locationIds, visibleSource) {
    return [frameTime || "none", [...locationIds].sort().join(","), visibleSource || "legacy_citywide"].join("|");
  }

  function interpretOutlookPoints(points, currentSignal) {
    if (!Array.isArray(points) || !points.length) {
      return {
        holdUntilTime: null,
        trapUntilTime: null,
        busyUntilTime: null,
        slowUntilTime: null,
        nextImprovementTime: null,
        nextWorseningTime: null,
        targetStrongUntilTime: null,
        outlookSummaryText: "Outlook unavailable.",
      };
    }
    let holdUntilTime = null;
    let trapUntilTime = null;
    let busyUntilTime = null;
    let slowUntilTime = null;
    let nextImprovementTime = null;
    let nextWorseningTime = null;
    let targetStrongUntilTime = null;

    const nowRating = currentSignal?.visibleRating || 0;
    points.forEach((p, idx) => {
      const pseudo = {
        ...currentSignal,
        visibleRating: safeNum(p.visible_rating, nowRating) || nowRating,
        busyNowBase: safeNum(p.busy_now_base, currentSignal?.busyNowBase || 0) || 0,
        shortTripPenalty: safeNum(p.short_trip_penalty, currentSignal?.shortTripPenalty || 0) || 0,
        churnPressure: safeNum(p.churn_pressure, currentSignal?.churnPressure || 0) || 0,
        continuationRaw: safeNum(p.continuation_raw, currentSignal?.continuationRaw || 0) || 0,
        marketSaturationPenalty: safeNum(p.market_saturation_penalty, currentSignal?.marketSaturationPenalty || 0) || 0,
        manhattanCoreSaturationPenalty: safeNum(p.manhattan_core_saturation_penalty, currentSignal?.manhattanCoreSaturationPenalty || 0) || 0,
        longTripShare20Plus: safeNum(p.long_trip_share_20plus, currentSignal?.longTripShare20Plus || 0) || 0,
      };
      const cls = classifyAssistantSignal(pseudo);
      const ts = String(p.frame_time || p.ts || "").trim() || null;
      if (!ts) return;
      if (cls.busyNow && !busyUntilTime) busyUntilTime = ts;
      if (cls.slowNow && !slowUntilTime) slowUntilTime = ts;
      if (cls.shortTrap && !trapUntilTime) trapUntilTime = ts;
      if ((cls.busyNow || cls.continuationGood) && !holdUntilTime) holdUntilTime = ts;
      if (pseudo.visibleRating >= nowRating + 4 && !nextImprovementTime) nextImprovementTime = ts;
      if (pseudo.visibleRating <= nowRating - 4 && !nextWorseningTime) nextWorseningTime = ts;
      if ((cls.longFriendly || cls.busyNow) && idx > 0) targetStrongUntilTime = ts;
    });

    const summary = holdUntilTime
      ? `Hold is favorable until ${internals.formatNYCTimeOnlyLabel?.(holdUntilTime) || holdUntilTime}.`
      : (nextImprovementTime
          ? `Next improvement around ${internals.formatNYCTimeOnlyLabel?.(nextImprovementTime) || nextImprovementTime}.`
          : "Outlook is mixed.");

    return { holdUntilTime, trapUntilTime, busyUntilTime, slowUntilTime, nextImprovementTime, nextWorseningTime, targetStrongUntilTime, outlookSummaryText: summary };
  }

  async function fetchOutlook(frame, locationIds, visibleSource) {
    const frameTime = frameTimeIso(frame);
    if (!frameTime || !locationIds.length) return null;
    const key = buildOutlookCacheKey(frameTime, locationIds, visibleSource);
    if (state.outlookCache.has(key)) return state.outlookCache.get(key);
    if (state.outlookAbortController) state.outlookAbortController.abort();
    const ac = new AbortController();
    state.outlookAbortController = ac;
    const apiBase = String(window.API_BASE || window.__TLC_RUNTIME_CONFIG__?.apiBase || "").trim().replace(/\/+$/, "");
    const url = `${apiBase}/assistant/outlook?frame_time=${encodeURIComponent(frameTime)}&location_ids=${encodeURIComponent([...locationIds].sort().join(","))}`;
    try {
      const data = await (internals.fetchJSON?.(url, { signal: ac.signal }) || fetch(url, { signal: ac.signal }).then((r) => r.json()));
      state.outlookCache.set(key, data || null);
      return data || null;
    } catch (_err) {
      return null;
    } finally {
      if (state.outlookAbortController === ac) state.outlookAbortController = null;
    }
  }



  function humanActionLabel(code) {
    const map = {
      STAY: "Stay",
      STAY_BRIEFLY: "Stay briefly",
      MOVE_SOON: "Move soon",
      LEAVE_NOW: "Leave now",
      MONITOR: "Monitor",
    };
    return map[String(code || "").trim()] || "Monitor";
  }

  function humanizeAssistantReason(text) {
    const raw = String(text || "").trim();
    if (!raw) return "Mixed signals.";
    const normalized = raw
      .replace(/Trap dwell risk is escalating\.?/gi, "Trap risk is rising.")
      .replace(/Slow-zone dwell risk is escalating\.?/gi, "Slow zone warning.")
      .replace(/Hold window remains strong\.?/gi, "Good zone right now.")
      .replace(/Hold window is expiring\.?/gi, "This zone may cool off soon.")
      .replace(/Better nearby zone available\.?/gi, "Better nearby zone is available.")
      .replace(/Short-trip trap detected with nearby escape option\.?/gi, "Trap risk is rising.")
      .replace(/Current zone is slow and nearby zone is materially better\.?/gi, "Better nearby zone is available.")
      .replace(/Current zone has strong demand and continuation\.?/gi, "Good zone right now.")
      .replace(/Nearby zone has better score; prepare to move\.?/gi, "Move window coming.")
      .replace(/Current zone is acceptable; keep monitoring\.?/gi, "Mixed signals.")
      .replace(/Waiting for stable zone\.?/gi, "Collecting location context.")
      .replace(/Outlook unavailable\.?/gi, "Checking outlook.")
      .replace(/dwell/gi, "stay");
    return normalized;
  }

  function leadingIconKindFromAction(code) {
    const map = {
      STAY: "positive",
      STAY_BRIEFLY: "caution",
      MOVE_SOON: "move",
      LEAVE_NOW: "move",
      MONITOR: "info",
    };
    return map[String(code || "").trim()] || "info";
  }

  function buildPrimaryHeadline() {
    const action = humanActionLabel(state.finalActionCode);
    if ((state.finalActionCode === "MOVE_SOON" || state.finalActionCode === "LEAVE_NOW")
      && state.assistantMoveTarget?.zoneName
      && Number.isFinite(state.assistantMoveTarget?.distanceMiles)) {
      return `${action} • Go to ${state.assistantMoveTarget.zoneName} • ${state.assistantMoveTarget.distanceMiles.toFixed(1)} mi`;
    }
    return `${action}: ${humanizeAssistantReason(state.finalActionReason)}`;
  }

  function computeBaseAction(currentSignal, cls) {
    if (!currentSignal) return { code: "MONITOR", reason: "Waiting for stable zone." };
    const overall = state.bestNearbyOverall;
    const scoreAdvantage = overall ? ((overall.signal.visibleRating || 0) - (currentSignal.visibleRating || 0)) : 0;
    state.scoreAdvantageVsCurrent = scoreAdvantage;
    if (cls.shortTrap && state.bestNearbyTrapEscape) return { code: "MOVE_SOON", reason: "Short-trip trap detected with nearby escape option." };
    if (cls.slowNow && scoreAdvantage >= 7 && overall) return { code: "MOVE_SOON", reason: "Current zone is slow and nearby zone is materially better." };
    if (cls.busyNow && cls.continuationGood) return { code: "STAY", reason: "Current zone has strong demand and continuation." };
    if (scoreAdvantage >= 10 && overall) return { code: "STAY_BRIEFLY", reason: "Nearby zone has better score; prepare to move." };
    return { code: "MONITOR", reason: "Current zone is acceptable; keep monitoring." };
  }

  function dwellMins() {
    return Math.floor((state.activeStableZoneDwellMs || 0) / 60000);
  }

  function applyDwellOverride(currentCls) {
    const mins = dwellMins();
    state.dwellRiskCode = "neutral";
    state.dwellEscalationLevel = 0;
    state.dwellWarningActive = false;
    state.dwellWarnAtTs = null;
    state.dwellUrgentAtTs = null;
    state.dwellShouldLeaveByTs = null;
    state.dwellCountdownMs = null;
    const now = Date.now();

    if (state.holdUntilTime) {
      const holdTs = Date.parse(state.holdUntilTime);
      if (Number.isFinite(holdTs)) {
        const delta = holdTs - now;
        if (delta <= 10 * 60000) {
          state.dwellRiskCode = "hold_expiring";
          state.dwellEscalationLevel = delta <= 3 * 60000 ? 2 : 1;
          state.dwellWarningActive = true;
          state.dwellCountdownMs = delta;
          state.dwellWarnAtTs = now;
          if (delta <= 0) state.dwellUrgentAtTs = now;
        } else {
          state.dwellRiskCode = "hold_strong";
        }
      }
    }

    if (currentCls?.shortTrap) {
      state.dwellRiskCode = "trap_bad";
      if (mins >= 7) state.dwellEscalationLevel = 2;
      else if (mins >= 4) state.dwellEscalationLevel = 1;
      state.dwellWarningActive = mins >= 4;
    } else if (currentCls?.slowNow) {
      state.dwellRiskCode = "slow_bad";
      if (mins >= 10) state.dwellEscalationLevel = 2;
      else if (mins >= 6) state.dwellEscalationLevel = 1;
      state.dwellWarningActive = mins >= 6;
    } else if ((state.scoreAdvantageVsCurrent || 0) >= 8) {
      state.dwellRiskCode = "mediocre_better_nearby";
      if (mins >= 12) state.dwellEscalationLevel = 2;
      else if (mins >= 8) state.dwellEscalationLevel = 1;
      state.dwellWarningActive = mins >= 8;
    }

    let finalCode = state.baseActionCode;
    let finalReason = state.baseActionReason;

    if (state.dwellRiskCode === "hold_strong") {
      finalCode = "STAY";
      finalReason = "Hold window remains strong.";
    } else if (state.dwellRiskCode === "hold_expiring") {
      finalCode = state.dwellEscalationLevel >= 2 ? "MOVE_SOON" : "STAY_BRIEFLY";
      finalReason = "Hold window is expiring.";
    } else if (state.dwellRiskCode === "trap_bad" || state.dwellRiskCode === "slow_bad") {
      finalCode = state.dwellEscalationLevel >= 2 ? "LEAVE_NOW" : "MOVE_SOON";
      finalReason = state.dwellRiskCode === "trap_bad" ? "Trap dwell risk is escalating." : "Slow-zone dwell risk is escalating.";
    } else if (state.dwellRiskCode === "mediocre_better_nearby") {
      finalCode = state.dwellEscalationLevel >= 1 ? "MOVE_SOON" : "STAY_BRIEFLY";
      finalReason = "Better nearby zone available.";
    }

    state.finalActionCode = finalCode;
    state.finalActionReason = finalReason;
    state.actionSeverity = (finalCode === "LEAVE_NOW" || finalCode === "MOVE_SOON") ? "move" : (finalCode === "STAY" ? "positive" : "caution");

    const reasons = [];
    reasons.push(`Here ${mins}m`);
    reasons.push(`Risk ${state.dwellRiskCode}`);
    if (state.holdUntilTime) reasons.push(`Hold ${internals.formatNYCTimeOnlyLabel?.(state.holdUntilTime) || state.holdUntilTime}`);
    state.dwellCoachReasonFragments = reasons;
    state.dwellCoachSummaryText = `${humanActionLabel(state.finalActionCode)}: ${humanizeAssistantReason(state.finalActionReason)}`;
  }

  function applyNavOwnership() {
    const target = state.assistantMoveTarget;
    if ((state.finalActionCode === "LEAVE_NOW" || state.finalActionCode === "MOVE_SOON") && target) {
      window.TlcMapUiModule?.setNavDestination?.({ lat: target.centerLat, lng: target.centerLng, name: target.zoneName });
      return;
    }
    if (state.finalActionCode === "STAY_BRIEFLY" && target) {
      window.TlcMapUiModule?.setNavDestination?.({ lat: target.centerLat, lng: target.centerLng, name: target.zoneName });
      return;
    }
    window.TlcMapUiModule?.setNavDestination?.(null);
  }

  function iconMarkup(kind) {
    const icons = {
      positive: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m6 12.5 4 4 8-9" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      caution: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3.8 2.9 19.3h18.2Z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 9v5.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17" r="1.2" fill="currentColor"/></svg>',
      move: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 12h13" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="m12.2 7.2 4.8 4.8-4.8 4.8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      info: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 10.2V16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="7.4" r="1.2" fill="currentColor"/></svg>'
    };
    return icons[kind] || icons.info;
  }

  function severityForAction(code) {
    if (code === "LEAVE_NOW" || code === "MOVE_SOON") return "move";
    if (code === "STAY") return "positive";
    if (code === "STAY_BRIEFLY" || code === "MONITOR") return "caution";
    return "info";
  }

  function buildMessages() {
    const list = [];
    const primary = buildPrimaryHeadline();
    list.push({ key: "action", text: primary, severity: severityForAction(state.finalActionCode) });

    if (state.assistantMoveTarget?.zoneName && Number.isFinite(state.assistantMoveTarget?.distanceMiles)) {
      const targetSummary = `Go to ${state.assistantMoveTarget.zoneName} • ${state.assistantMoveTarget.distanceMiles.toFixed(1)} mi`;
      if (!primary.includes(targetSummary)) {
        list.push({ key: "target", text: targetSummary, severity: "info" });
      }
    }

    if (state.targetStrongUntilTime) {
      const until = internals.formatNYCTimeOnlyLabel?.(state.targetStrongUntilTime) || state.targetStrongUntilTime;
      list.push({ key: "target_window", text: `Target stronger through ${until}.`, severity: "info" });
    }

    const rawOutlook = String(state.outlookSummaryText || "").trim();
    const outlookText = humanizeAssistantReason(rawOutlook);
    const outlookMeaningful = rawOutlook && !/^outlook unavailable\.?$/i.test(rawOutlook) && !/^checking outlook\.?$/i.test(outlookText);
    if (outlookMeaningful) {
      list.push({ key: "outlook", text: outlookText, severity: "info" });
    }
    const targetOutlook = humanizeAssistantReason(state.moveTargetOutlookSummaryText);
    if (String(targetOutlook || "").trim() && !/^checking outlook\.?$/i.test(targetOutlook)) {
      list.push({ key: "target_outlook", text: targetOutlook, severity: "info" });
    }
    if (state.currentZoneCitywideRank) {
      list.push({ key: "rank", text: `City #${state.currentZoneCitywideRank}`, severity: "info" });
    }

    const uniq = [];
    const seen = new Set();
    for (const m of list) {
      const cleanedText = String(m.text || "").replace(/\bdwell\b/gi, "stay");
      const key = `${m.key}:${cleanedText}`;
      if (!cleanedText || seen.has(key)) continue;
      seen.add(key);
      uniq.push({ ...m, text: cleanedText });
    }
    if (!uniq.length) {
      uniq.push({ key: "fallback", text: "Monitor: Mixed signals.", severity: "info" });
    }
    state.assistantMessages = uniq;
    if (state.activeMessageIndex >= uniq.length) state.activeMessageIndex = 0;
    const active = uniq[state.activeMessageIndex] || { key: "none", text: "AI Assistant ready.", severity: "info" };
    state.activeMessageKey = active.key;
    state.activeMessageSeverity = active.severity;
    state.activeMessageIcon = active.severity;
  }

  function mirrorRecommendLine() {
    if (!recommendLine) return;
    const action = humanActionLabel(state.finalActionCode);
    const reason = humanizeAssistantReason(state.finalActionReason);
    const reasonForMirror = reason ? `${reason.charAt(0).toUpperCase()}${reason.slice(1)}` : "Mixed signals.";
    const preferTarget = (state.finalActionCode === "MOVE_SOON" || state.finalActionCode === "LEAVE_NOW") && state.assistantMoveTarget?.zoneName;
    const tail = preferTarget ? `Target: ${state.assistantMoveTarget.zoneName}` : reasonForMirror;
    recommendLine.textContent = `AI Assistant: ${action} • ${tail}`;
  }

  function renderWidget() {
    if (!dockMount) return;
    buildMessages();
    const active = state.assistantMessages[state.activeMessageIndex] || { text: "AI Assistant ready.", severity: "info" };
    const iconType = leadingIconKindFromAction(state.finalActionCode);
    const chips = [];
    chips.push(`Zone: ${state.activeStableZoneName || "Locating…"}`);
    if (Number.isFinite(state.visibleRating)) chips.push(`Score ${Math.round(state.visibleRating)}`);
    if (state.currentZoneCitywideRank) chips.push(`City #${state.currentZoneCitywideRank}`);
    chips.push(`Here ${Math.floor((state.activeStableZoneDwellMs || 0) / 60000)}m`);

    dockMount.innerHTML = `
      <div class="aiAssistantWidget ${state.expanded ? "is-expanded" : ""}" id="aiAssistantWidget">
        <div class="aiAssistantMainRow">
          <div class="aiAssistantIconChip aiAssistantIconChip--${iconType}">${iconMarkup(iconType)}</div>
          <div class="aiAssistantTickerViewport" id="aiAssistantTickerViewport">
            <div class="aiAssistantTickerTrack" id="aiAssistantTickerTrack"><div class="aiAssistantTickerTrackInner">${String(active.text || "").replace(/dwell/gi, "stay")}</div></div>
          </div>
          <button class="aiAssistantExpandBtn" type="button" data-ai-action="toggle-expanded" aria-expanded="${state.expanded ? "true" : "false"}">${state.expanded ? "−" : "+"}</button>
        </div>
        <div class="aiAssistantMetaRow">${chips.map((c) => `<span class="aiAssistantMetaChip">${c}</span>`).join("")}</div>
        ${state.expanded ? buildPanelHtml() : ""}
      </div>
    `;
    applyMarqueeIfNeeded();
    clearMessageRotationTimer();
    scheduleNextMessageRotation();
    updateAssistantDockLayout();
  }

  function buildRankList(items) {
    return `<ol class="aiAssistantList">${(items || []).map((it) => `<li>${it.zoneName} (${Math.round(it.visibleRating || 0)})</li>`).join("")}</ol>`;
  }

  function buildPanelHtml() {
    return `
      <div class="aiAssistantPanel">
        <section class="aiAssistantSection"><strong>Current Zone</strong><div>${state.activeStableZoneName || "—"} • ${state.activeStableBorough || "—"} • ${Math.round(state.visibleRating || 0)} ${prettyBucket(state.visibleBucket)} • ${state.visibleScoreSourceLabel}</div></section>
        <section class="aiAssistantSection"><strong>Stay Coach</strong><div>${state.dwellCoachSummaryText}</div><div>${state.dwellCoachReasonFragments.join(" • ")}</div></section>
        <section class="aiAssistantSection"><strong>Outlook</strong><div>${state.outlookSummaryText}</div><div>${state.moveTargetOutlookSummaryText || ""}</div></section>
        <section class="aiAssistantSection"><strong>Rankings</strong><div>Best now: ${state.citywideBestNow?.zoneName || "—"} • Worst now: ${state.citywideWorstNow?.zoneName || "—"}</div>${buildRankList(state.citywideTop10Best)}${buildRankList(state.boroughTop5Best)}</section>
        ${state.assistantMoveTarget ? `<section class="aiAssistantSection"><strong>Move Target</strong><div>${state.assistantMoveTarget.zoneName} • ${state.assistantMoveTarget.distanceMiles.toFixed(1)} mi • ${Math.round(state.assistantMoveTarget.visibleRating || 0)}</div></section>` : ""}
        <section class="aiAssistantSection"><small>Assistant uses the same visible Team Joseo score path the map is showing.</small></section>
      </div>
    `;
  }

  function applyMarqueeIfNeeded() {
    const viewport = document.getElementById("aiAssistantTickerViewport");
    const track = document.getElementById("aiAssistantTickerTrack");
    const inner = track?.querySelector(".aiAssistantTickerTrackInner");
    if (!viewport || !track || !inner) return;
    track.classList.remove("is-marquee");
    inner.style.removeProperty("animation-duration");
    if (state.marqueeTimeout) {
      clearTimeout(state.marqueeTimeout);
      state.marqueeTimeout = null;
    }
    const overflow = inner.scrollWidth - viewport.clientWidth;
    if (overflow > 8) {
      const duration = Math.max(10000, Math.min(22000, overflow * 18));
      const delay = 600;
      inner.style.animationDuration = `${duration}ms`;
      state.marqueeActive = true;
      state.marqueeDurationMs = duration + delay;
      state.marqueeTimeout = setTimeout(() => {
        track.classList.add("is-marquee");
      }, delay);
    } else {
      state.marqueeActive = false;
      state.marqueeDurationMs = 0;
    }
  }



  function updateAssistantDockLayout() {
    const dock = document.getElementById("aiAssistantDock");
    const onlineBadge = document.getElementById("onlineBadge");
    const weatherBadge = document.getElementById("weatherBadge");
    if (!dock || !onlineBadge || !weatherBadge) return;

    const topLane = "calc(env(safe-area-inset-top) + 10px)";
    const fallbackTop = "calc(env(safe-area-inset-top) + 44px)";

    const onlineRect = onlineBadge.getBoundingClientRect?.();
    const weatherRect = weatherBadge.getBoundingClientRect?.();
    if (!onlineRect || !weatherRect) return;
    if (![onlineRect.right, weatherRect.left, window.innerWidth].every((n) => Number.isFinite(n))) return;

    const laneLeft = Math.ceil(onlineRect.right + 10);
    const laneRight = Math.floor(weatherRect.left - 10);
    const laneWidth = Math.floor(laneRight - laneLeft);
    if (laneWidth >= 250) {
      dock.style.left = `${laneLeft}px`;
      dock.style.right = `${Math.max(12, window.innerWidth - laneRight)}px`;
      dock.style.width = `${laneWidth}px`;
      dock.style.maxWidth = `${laneWidth}px`;
      dock.style.transform = "none";
      dock.style.top = topLane;
      return;
    }

    dock.style.left = "50%";
    dock.style.right = "auto";
    dock.style.width = "min(340px, calc(100vw - 32px))";
    dock.style.maxWidth = "calc(100vw - 32px)";
    dock.style.top = fallbackTop;
    dock.style.transform = "translateX(-50%)";
  }

  function installTopBadgeLayoutObservers() {
    if (topBadgeObserversInstalled) return;
    topBadgeObserversInstalled = true;
    const onlineBadge = document.getElementById("onlineBadge");
    const weatherBadge = document.getElementById("weatherBadge");
    if (!onlineBadge || !weatherBadge) return;

    const refresh = () => updateAssistantDockLayout();
    window.addEventListener("resize", refresh, { passive: true });
    window.addEventListener("orientationchange", refresh, { passive: true });
    window.addEventListener("tlc-top-badges-updated", refresh);

    if (typeof ResizeObserver === "function") {
      if (topBadgeResizeObserver) topBadgeResizeObserver.disconnect();
      topBadgeResizeObserver = new ResizeObserver(() => updateAssistantDockLayout());
      topBadgeResizeObserver.observe(onlineBadge);
      topBadgeResizeObserver.observe(weatherBadge);
    }

    updateAssistantDockLayout();
  }

  function shouldPauseRotation() {
    if (state.expanded || state.hoverPaused) return true;
    if (Date.now() < state.touchPauseUntil) return true;
    return false;
  }

  function clearMessageRotationTimer() {
    if (state.rotationTimerHandle) {
      clearTimeout(state.rotationTimerHandle);
      state.rotationTimerHandle = null;
    }
    state.rotationNextDueAt = 0;
  }

  function scheduleNextMessageRotation() {
    clearMessageRotationTimer();
    if (!Array.isArray(state.assistantMessages) || state.assistantMessages.length < 2) return;
    if (shouldPauseRotation()) {
      state.rotationTimerHandle = setTimeout(() => scheduleNextMessageRotation(), 1000);
      return;
    }
    const delay = state.marqueeActive ? ((state.marqueeDurationMs || 0) + 800) : AI_ASSISTANT_ROTATE_MS;
    state.rotationNextDueAt = Date.now() + delay;
    state.rotationTimerHandle = setTimeout(() => {
      if (!Array.isArray(state.assistantMessages) || state.assistantMessages.length < 2) return;
      if (shouldPauseRotation()) {
        state.rotationTimerHandle = setTimeout(() => scheduleNextMessageRotation(), 800);
        return;
      }
      state.activeMessageIndex = (state.activeMessageIndex + 1) % state.assistantMessages.length;
      renderWidget();
    }, delay);
  }

  function feedMaterialKey() {
    const dwellBucket = Math.floor((state.activeStableZoneDwellMs || 0) / 60000);
    return [
      state.activeStableZoneId || "",
      state.finalActionCode || "",
      state.finalActionReason || "",
      state.dwellRiskCode || "",
      state.dwellEscalationLevel || 0,
      state.assistantMoveTarget?.locationId || "",
      state.currentZoneCitywideRank || "",
      state.currentZoneBoroughRank || "",
      state.holdUntilTime || "",
      dwellBucket,
    ].join("|");
  }

  function snapshot() {
    return {
      ...state,
      outlookCache: undefined,
      outlookAbortController: undefined,
      heartbeatHandle: undefined,
      frameFeatures: undefined,
    };
  }

  function emitSnapshotEvents() {
    const key = feedMaterialKey();
    if (state.assistantFeedMaterialKey !== key) {
      state.assistantFeedMaterialKey = key;
      state.feedUpdatedAt = Date.now();
      window.dispatchEvent(new CustomEvent("tlc-ai-assistant-snapshot-updated", { detail: snapshot() }));
    }
    window.dispatchEvent(new CustomEvent("tlc-ai-assistant-action-updated", { detail: snapshot() }));
    if (state.currentZoneOutlook || state.moveTargetOutlook) {
      window.dispatchEvent(new CustomEvent("tlc-ai-assistant-outlook-updated", { detail: snapshot() }));
    }
    if (state.dwellEscalationLevel >= 1) {
      const alertKey = `${state.dwellRiskCode}|${state.dwellEscalationLevel}|${state.activeStableZoneId || ""}`;
      if (alertKey !== state.assistantAlertKey) {
        state.assistantAlertKey = alertKey;
        window.dispatchEvent(new CustomEvent("tlc-ai-assistant-alert", { detail: snapshot() }));
      }
    }
  }

  function applyStableZoneFromLocation() {
    const loc = state.lastUserLocation;
    const now = Date.now();
    if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) return;
    const feature = internals.resolveZoneFeatureAtLngLat?.({ lat: loc.lat, lng: loc.lng }) || null;
    if (!feature) {
      if (state.activeStableZoneId && state.activeZoneLastSeenTs && now - state.activeZoneLastSeenTs > AI_ASSISTANT_CLEAR_GRACE_MS) {
        state.activeStableZoneId = null;
        state.activeStableZoneName = "";
        state.activeStableBorough = "";
        state.activeStableZoneEnterTs = null;
      }
      return;
    }
    const signal = buildAssistantFeatureSignal(feature);
    state.activeZoneLastSeenTs = now;
    if (!signal.locationId) return;
    if (state.candidateZoneId !== signal.locationId) {
      state.candidateZoneId = signal.locationId;
      state.candidateZoneFirstSeenTs = now;
      state.candidateZoneHits = 1;
      return;
    }
    state.candidateZoneHits += 1;
    const stableMs = now - (state.candidateZoneFirstSeenTs || now);
    if (state.candidateZoneHits >= AI_ASSISTANT_STABLE_MIN_HITS && stableMs >= AI_ASSISTANT_STABLE_MIN_MS) {
      if (state.activeStableZoneId !== signal.locationId) {
        state.activeStableZoneId = signal.locationId;
        state.activeStableZoneName = signal.zoneName;
        state.activeStableBorough = signal.borough;
        state.activeStableZoneEnterTs = now;
        state.activeStableZoneDwellMs = 0;
        window.dispatchEvent(new CustomEvent("tlc-ai-assistant-zone-changed", { detail: snapshot() }));
      }
    }
  }

  async function recompute(frame) {
    const liveFrame = frame || internals.getCurrentFrame?.() || null;
    state.lastFrameTime = frameTimeIso(liveFrame);
    applyStableZoneFromLocation();
    state.activeStableZoneDwellMs = state.activeStableZoneEnterTs ? Math.max(0, Date.now() - state.activeStableZoneEnterTs) : 0;

    const activeSignal = state.activeStableZoneId
      ? (liveFrame?.polygons?.features || []).map(buildAssistantFeatureSignal).find((s) => s.locationId === state.activeStableZoneId) || null
      : null;
    state.activeStableFeatureSignal = activeSignal;
    state.visibleRating = activeSignal?.visibleRating ?? null;
    state.visibleBucket = activeSignal?.visibleBucket ?? null;
    state.visibleScoreSource = activeSignal?.visibleScoreSource || "legacy_citywide";
    state.visibleScoreSourceLabel = activeSignal?.visibleScoreSourceLabel || "Team Joseo score";
    state.airportExcluded = !!activeSignal?.airportExcluded;

    computeRankings(liveFrame, activeSignal);
    const nearby = computeNearbyAssistantCandidates(liveFrame, activeSignal);
    state.bestNearbyOverall = nearby.overall;
    state.bestNearbyTrapEscape = nearby.trap_escape;
    state.bestNearbyLongTrip = nearby.long_trip;
    state.assistantMoveTarget = (nearby.trap_escape || nearby.overall || nearby.long_trip)?.signal
      ? { ...(nearby.trap_escape || nearby.overall || nearby.long_trip).signal, distanceMiles: (nearby.trap_escape || nearby.overall || nearby.long_trip).distanceMiles }
      : null;

    const cls = activeSignal ? classifyAssistantSignal(activeSignal) : null;
    const base = computeBaseAction(activeSignal, cls);
    state.baseActionCode = base.code;
    state.baseActionReason = base.reason;

    const locationIds = [state.activeStableZoneId, state.assistantMoveTarget?.locationId].filter(Boolean);
    const outlook = await fetchOutlook(liveFrame, locationIds, state.visibleScoreSource);
    const byId = outlook?.items || outlook?.by_location_id || {};
    const currentPoints = byId?.[state.activeStableZoneId] || byId?.[String(state.activeStableZoneId)] || [];
    const targetPoints = state.assistantMoveTarget ? (byId?.[state.assistantMoveTarget.locationId] || []) : [];
    state.currentZoneOutlook = interpretOutlookPoints(currentPoints, activeSignal);
    state.moveTargetOutlook = interpretOutlookPoints(targetPoints, state.assistantMoveTarget);
    Object.assign(state, state.currentZoneOutlook || {});
    state.outlookSummaryText = state.currentZoneOutlook?.outlookSummaryText || "Outlook unavailable.";
    state.moveTargetOutlookSummaryText = state.moveTargetOutlook?.outlookSummaryText || "";

    applyDwellOverride(cls || {});
    applyNavOwnership();
    mirrorRecommendLine();
    renderWidget();
    emitSnapshotEvents();
  }

  function startHeartbeat() {
    const hasStable = !!state.activeStableZoneId;
    const key = `${hasStable}|${document.hidden ? "hidden" : "visible"}`;
    if (state.heartbeatKey === key) return;
    state.heartbeatKey = key;
    if (state.heartbeatHandle && runtimePolling) runtimePolling.clearInterval(state.heartbeatHandle);
    if (state.heartbeatHandle && !runtimePolling) clearInterval(state.heartbeatHandle);
    state.heartbeatHandle = null;
    if (!hasStable) return;
    const ms = document.hidden ? AI_ASSISTANT_HEARTBEAT_MS_HIDDEN : AI_ASSISTANT_HEARTBEAT_MS_VISIBLE;
    if (runtimePolling) {
      const id = `ai-assistant-heartbeat-${document.hidden ? "hidden" : "visible"}`;
      runtimePolling.setInterval(id, () => recompute().catch(() => {}), ms);
      state.heartbeatHandle = id;
    } else {
      state.heartbeatHandle = setInterval(() => { recompute().catch(() => {}); }, ms);
    }
  }

  function handleUserLocationUpdate(detail) {
    const lat = safeNum(detail?.lat);
    const lng = safeNum(detail?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    state.lastUserLocation = {
      lat,
      lng,
      ts: safeNum(detail?.ts, Date.now()),
      heading: safeNum(detail?.heading),
      accuracy: safeNum(detail?.accuracy),
    };
    recompute().catch(() => {});
    startHeartbeat();
  }

  function updateAssistantForFrame(frame) {
    recompute(frame).catch(() => {});
    startHeartbeat();
  }

  function clearState() {
    state.activeStableZoneId = null;
    state.activeStableZoneName = "";
    state.activeStableBorough = "";
    state.activeStableZoneEnterTs = null;
    state.activeStableZoneDwellMs = 0;
    state.assistantMoveTarget = null;
    state.finalActionCode = "MONITOR";
    state.finalActionReason = "Waiting for stable zone.";
    renderWidget();
    mirrorRecommendLine();
  }

  function forceRefresh() {
    recompute().catch(() => {});
    startHeartbeat();
  }

  function toggleExpanded() { state.expanded = !state.expanded; renderWidget(); }
  function toggleRankingsExpanded() { state.rankingsExpanded = !state.rankingsExpanded; renderWidget(); }
  function toggleOutlookExpanded() { state.outlookExpanded = !state.outlookExpanded; renderWidget(); }
  function toggleDwellExpanded() { state.dwellExpanded = !state.dwellExpanded; renderWidget(); }

  function attachEvents() {
    window.addEventListener("tlc-user-location-updated", (e) => handleUserLocationUpdate(e?.detail || {}));
    window.addEventListener("team-joseo-frame-rendered", () => forceRefresh());
    window.addEventListener("tlc-mode-changed", () => forceRefresh());
    document.addEventListener("visibilitychange", () => { startHeartbeat(); updateAssistantDockLayout(); });
    document.addEventListener("click", (e) => {
      const action = e.target?.closest?.("[data-ai-action]")?.getAttribute("data-ai-action");
      if (!action) return;
      if (action === "toggle-expanded") toggleExpanded();
    });
    if (dockMount) {
      dockMount.addEventListener("mouseenter", () => { state.hoverPaused = true; clearMessageRotationTimer(); });
      dockMount.addEventListener("mouseleave", () => { state.hoverPaused = false; scheduleNextMessageRotation(); });
      dockMount.addEventListener("touchstart", () => { state.touchPauseUntil = Date.now() + 4500; clearMessageRotationTimer(); }, { passive: true });
    }
  }

  window.TlcAiAssistantModule = {
    updateAssistantForFrame,
    handleUserLocationUpdate,
    forceRefresh,
    clearState,
    getSnapshot: snapshot,
    toggleExpanded,
    toggleRankingsExpanded,
    toggleOutlookExpanded,
    toggleDwellExpanded,
  };

  window.getTeamJoseoAiAssistantSnapshot = () => window.TlcAiAssistantModule?.getSnapshot?.() || null;
  window.getTeamJoseoAiAssistantFeedSnapshot = () => window.TlcAiAssistantModule?.getSnapshot?.() || null;

  attachEvents();
  installTopBadgeLayoutObservers();
  renderWidget();
  mirrorRecommendLine();
  updateAssistantDockLayout();
})();
