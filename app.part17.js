(function() {
  const AI_ASSISTANT_STABLE_MIN_MS = 3000;
  const AI_ASSISTANT_STABLE_MIN_HITS = 2;
  const AI_ASSISTANT_CLEAR_GRACE_MS = 5000;
  const AI_ASSISTANT_HEARTBEAT_MS_VISIBLE = 15000;
  const AI_ASSISTANT_HEARTBEAT_MS_HIDDEN = 60000;
  const AI_ASSISTANT_PRE_STABLE_HEARTBEAT_MS = 2500;
  const AI_ASSISTANT_PROPOSAL_MIN_STABLE_MS = 8000;
  const AI_ASSISTANT_PROPOSAL_MIN_HITS = 2;
  const AI_ASSISTANT_STAY_TO_MOVE_EXTRA_BUFFER = 2.5;
  const AI_ASSISTANT_MOVE_TO_STAY_EXTRA_BUFFER = 1.5;
  const AI_ASSISTANT_TARGET_REPLACE_EDGE_BUFFER = 3.0;
  const AI_ASSISTANT_RECOMMENDATION_SWITCH_COOLDOWN_MS = 15000;
  const AI_ASSISTANT_RECOMMENDATION_MIN_HOLD_MS = 12000;
  const AI_ASSISTANT_EMERGENCY_BYPASS_EDGE = 6.0;
  const AI_ASSISTANT_NEAR_TARGET_MAX_ETA_MIN = 12;
  const AI_ASSISTANT_FAR_TARGET_SOFT_CAP_MIN = 16;
  const AI_ASSISTANT_FAR_TARGET_HARD_CAP_MIN = 20;
  const AI_ASSISTANT_NEAR_TARGET_EDGE_BUFFER = 2.5;
  const AI_ASSISTANT_FAR_TARGET_EXTRA_EDGE_REQUIRED = 4.0;
  const AI_ASSISTANT_SAME_BOROUGH_PREFERENCE_BONUS = 1.5;
  const AI_ASSISTANT_MEANINGFUL_REPOSITION_MILES = 0.75;
  const AI_ASSISTANT_MEANINGFUL_REPOSITION_MIN_MS = 150000;
  const AI_ASSISTANT_COUNTDOWN_SUPPRESS_MS = 4 * 60000;
  const AI_ASSISTANT_TRAP_SUPPRESS_MS = 3 * 60000;
  const AI_ASSISTANT_PICKUP_SUPPRESS_MS = 4 * 60000;
  const AI_ASSISTANT_TRAP_MESSAGE_COOLDOWN_MS = 75000;
  const AI_ASSISTANT_STAY_MESSAGE_COOLDOWN_MS = 45000;
  const AI_ASSISTANT_MOVE_MESSAGE_COOLDOWN_MS = 30000;
  const AI_ASSISTANT_FULL_RECOMPUTE_MIN_MS = 900;
  const AI_ASSISTANT_SAME_ZONE_REPOSITION_MILES = 0.1;

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
    arrivalAwareCandidateShortlist: [],
    shortlistCandidateIds: [],
    shortlistCandidateZones: [],
    shortlistCandidateEtas: [],
    sameBoroughNearCandidateCount: 0,
    crossBoroughNearCandidateCount: 0,
    farCandidateCount: 0,
    farCandidatesRejectedForDistance: 0,
    bestArrivalAwareCandidate: null,
    bestCandidateNotWorthMoving: null,
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
    lastPickupRecordedAtMs: null,
    lastPickupRecordedZoneId: null,
    countdownEligible: false,
    countdownActive: false,
    countdownStartTs: null,
    countdownDeadlineTs: null,
    countdownMinutesRemaining: null,
    countdownReasonCode: "",
    countdownReasonText: "",
    countdownTarget: null,
    countdownHoldWindowReason: "",
    countdownEscalationLevel: 0,
    countdownSuppressedUntilTs: 0,
    trapSuppressedUntilTs: 0,
    lastCountdownTargetId: null,
    lastCountdownTargetChangedAtTs: 0,
    lastTrapMessageAtTs: 0,
    lastStayMessageAtTs: 0,
    lastMoveMessageAtTs: 0,
    quietModeReason: "",
    stableZoneEntryUserLocation: null,
    lastMeaningfulRepositionAtMs: null,
    lastMeaningfulRepositionDistanceMiles: 0,
    sameZonePickupCountSinceEntry: 0,
    sameZonePickupCountRolling: 0,
    trapMovementScore: 0,
    trapPickupScore: 0,
    trapTimeScore: 0,
    trapCompositeScore: 0,
    trapModeActive: false,
    trapDetectedAtMs: null,
    trapReasonSummary: "",
    trapNeedsNearbyEscape: false,
    trapEscapeTarget: null,
    trapSeverityLevel: 0,
    recentZoneMovementSamples: [],
    assistantReasonFragments: [],
    assistantMessages: [],
    activeMessageIndex: 0,
    activeMessageKey: "",
    activeMessageSeverity: "info",
    activeMessageIcon: "info",
    rotationPaused: false,
    expanded: false,
    rankingsExpanded: false,
    outlookExpanded: false,
    dwellExpanded: false,
    feedUpdatedAt: 0,
    assistantFeedVersion: 1,
    assistantFeedMaterialKey: "",
    assistantAlertKey: "",
    recommendationReasonCode: "collecting_context",
    recommendationReasonText: "Collecting more context.",
    chosenTargetGroup: "none",
    chosenTargetReasoningMode: "collecting_context",
    recommendationWorthMoving: false,
    dataQualityMode: "degraded",
    dataQualityLabel: "degraded",
    dataQualityReason: "Waiting for outlook context.",
    currentPointsCount: 0,
    targetPointsCount: 0,
    hasRecentSuccessfulOutlook: false,
    isUsingCachedOutlook: false,
    isPartialOutlook: false,
    canTrustFarMoves: false,
    usedCachedRecommendationFallback: false,
    proposedActionCode: null,
    proposedReasonCode: null,
    proposedReasonText: "",
    proposedMoveTarget: null,
    proposedNetMoveEdge: null,
    proposedWorthThreshold: null,
    proposedSinceTs: null,
    proposedStableHits: 0,
    committedActionCode: null,
    committedReasonCode: null,
    committedReasonText: "",
    committedMoveTarget: null,
    committedSinceTs: null,
    recommendationConfidenceScore: null,
    recommendationConfidenceLevel: "low",
    recommendationSwitchCooldownUntilTs: 0,
    recommendationMinHoldUntilTs: 0,
    recommendationStickyTargetId: null,
    recommendationStickyTargetSinceTs: null,
    stabilityReasonCode: "",
    stabilityReasonText: "",
    etaMinutes: null,
    distanceMiles: null,
    stayProjectedRating: null,
    targetArrivalProjectedRating: null,
    stayWindowAvgRating: null,
    targetWindowAvgRating: null,
    stayWindowMinRating: null,
    targetWindowMinRating: null,
    moveScenarioValue: null,
    stayScenarioValue: null,
    netMoveEdge: null,
    moveWorthThreshold: null,
    currentTravelWindowAvgRating: null,
    currentTravelWindowMinRating: null,
    targetPaybackAvgRating: null,
    targetPaybackMinRating: null,
    totalDeadheadCost: null,
    moveConfidencePenalty: null,
    confidencePenaltyReasons: [],
    targetViableOnArrival: null,
    targetViabilityRejectCode: null,
    targetViabilityRejectReasonText: "",
    frameFeatures: [],
    outlookCache: new Map(),
    outlookAbortController: null,
    outlookRequestKey: "",
    outlookInFlightKey: "",
    outlookInFlightPromise: null,
    outlookEnrichRefreshKey: "",
    outlookStatus: "idle",
    outlookLastErrorCode: "",
    outlookLastErrorMessage: "",
    guidanceStatus: "idle",
    guidanceCache: new Map(),
    guidanceInFlightKey: "",
    guidanceInFlightPromise: null,
    guidanceAbortController: null,
    guidanceLastErrorCode: "",
    guidanceLastErrorMessage: "",
    serverGuidance: null,
    serverGuidanceUpdatedAt: 0,
    guidanceSource: "local",
    lastGuidanceRequestKey: "",
    lastSuccessfulGuidanceKey: "",
    lastSuccessfulGuidanceAt: 0,
    guidanceEnrichRefreshKey: "",
    lastGuidancePrimaryLine: "",
    lastGuidanceSecondaryLine: "",
    lastSuccessfulOutlookKey: "",
    lastSuccessfulOutlookAt: 0,
    lastGoodRecommendationZoneId: "",
    lastGoodRecommendationFrameTime: "",
    lastGoodRecommendationSavedAt: 0,
    lastGoodRecommendationPayload: null,
    heartbeatHandle: null,
    heartbeatKey: null,
    touchPauseUntil: 0,
    hoverPaused: false,
    rotationTimerHandle: null,
    lastFullAssistantRecomputeAtMs: 0,
    lastFullAssistantRecomputeZoneId: null,
    lastFullAssistantRecomputeFrameTime: null,
    lastFullAssistantRecomputeLat: null,
    lastFullAssistantRecomputeLng: null,
    lastAssistantRenderKey: "",
    lastRecommendLineKey: "",
    lastLightPassPrimaryLine: "",
    lastLightPassSecondaryLine: "",
    assistantFrameSignalCache: new Map(),
    assistantRankingsCache: new Map(),
    assistantNearbyCandidateCache: new Map(),
    assistantShortlistCache: new Map(),
    assistantCandidateEvalCache: new Map(),
    assistantRecomputeTimer: null,
    assistantRecomputeRaf: null,
    assistantRecomputePendingFrame: null,
    assistantRecomputePendingUrgent: false,
    assistantRecomputePendingReasons: new Set(),
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

  function isStrongOpportunityBucket(value) {
    const text = String(value || "").trim().toLowerCase();
    if (!text) return false;
    return [
      "purple",
      "indigo",
      "green",
      "highest",
      "very high",
      "high",
    ].includes(text);
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

  function trimMapCache(map, max = 8) {
    if (!(map instanceof Map)) return;
    while (map.size > max) {
      const first = map.keys().next();
      if (first?.done) break;
      map.delete(first.value);
    }
  }

  function getAssistantFrameKey(frame) {
    return `${frameTimeIso(frame) || "none"}|${Number(frame?.polygons?.features?.length || 0)}`;
  }

  function getAssistantModeTendencySignature() {
    const flags = modeModule.getModeFlags?.() || {};
    const tendency = window.TlcDayTendencyState?.getAdvancedContext?.() || window.TlcDayTendencyState?.advancedContext || null;
    return [
      flags.statenIslandMode ? 1 : 0,
      flags.bronxWashHeightsMode ? 1 : 0,
      flags.manhattanMode ? 1 : 0,
      flags.queensMode ? 1 : 0,
      flags.brooklynMode ? 1 : 0,
      tendency?.ready_for_frontend_adjustment ? 1 : 0,
      tendency?.resolved_local_scope || tendency?.local_scope || "",
      tendency?.global_penalty_points ?? "",
      tendency?.local_penalty_points ?? "",
    ].join("|");
  }

  function getAssistantGuidanceModeFlags() {
    const flags = modeModule.getModeFlags?.() || {};
    return {
      statenIslandMode: !!flags.statenIslandMode,
      bronxWashHeightsMode: !!flags.bronxWashHeightsMode,
      queensMode: !!flags.queensMode,
      brooklynMode: !!flags.brooklynMode,
    };
  }

  function buildGuidanceCacheKey(frameTime, userLocation, modeFlags) {
    if (!frameTime) return "";
    const lat = safeNum(userLocation?.lat);
    const lng = safeNum(userLocation?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "";
    const flags = modeFlags || {};
    return [
      frameTime,
      lat.toFixed(5),
      lng.toFixed(5),
      flags.statenIslandMode ? 1 : 0,
      flags.bronxWashHeightsMode ? 1 : 0,
      flags.queensMode ? 1 : 0,
      flags.brooklynMode ? 1 : 0,
    ].join("|");
  }

  function getSignalsForFrame(frame) {
    const frameKey = `${getAssistantFrameKey(frame)}|${getAssistantModeTendencySignature()}`;
    if (state.assistantFrameSignalCache.has(frameKey)) return state.assistantFrameSignalCache.get(frameKey) || [];
    const signals = (frame?.polygons?.features || [])
      .map(buildAssistantFeatureSignal)
      .filter((s) => s.locationId && Number.isFinite(s.visibleRating) && Number.isFinite(s.centerLat) && Number.isFinite(s.centerLng));
    state.assistantFrameSignalCache.set(frameKey, signals);
    trimMapCache(state.assistantFrameSignalCache, 6);
    return signals;
  }

  function computeNearbyAssistantCandidates(frame, currentSignal) {
    const out = { overall: null, trap_escape: null, long_trip: null };
    if (!currentSignal) return out;
    const frameKey = getAssistantFrameKey(frame);
    const cacheKey = `${frameKey}|${currentSignal.locationId}|${getAssistantModeTendencySignature()}`;
    if (state.assistantNearbyCandidateCache.has(cacheKey)) return state.assistantNearbyCandidateCache.get(cacheKey) || out;
    const all = getSignalsForFrame(frame).filter((s) => !s.airportExcluded);
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
    state.assistantNearbyCandidateCache.set(cacheKey, out);
    trimMapCache(state.assistantNearbyCandidateCache, 10);
    return out;
  }

  function normalizeAssistantBoroughName(value) {
    const text = String(value || "").trim().toLowerCase();
    if (/manhattan/.test(text)) return "manhattan";
    if (/brooklyn/.test(text)) return "brooklyn";
    if (/queens/.test(text)) return "queens";
    if (/bronx/.test(text)) return "bronx";
    if (/staten/.test(text)) return "staten_island";
    return "default";
  }

  function estimateAssistantTravelMinutes(currentSignal, candidateSignal) {
    const distanceMiles = internals.haversineMiles?.(
      { lat: currentSignal?.centerLat, lng: currentSignal?.centerLng },
      { lat: candidateSignal?.centerLat, lng: candidateSignal?.centerLng }
    ) || Infinity;
    const boroughKey = normalizeAssistantBoroughName(candidateSignal?.borough);
    const speedByBorough = {
      manhattan: 10,
      brooklyn: 14,
      queens: 15,
      bronx: 14,
      staten_island: 20,
      default: 14,
    };
    const baseSpeedMph = speedByBorough[boroughKey] || speedByBorough.default;
    const boroughChangePenalty = normalizeAssistantBoroughName(currentSignal?.borough) !== boroughKey ? 2.5 : 0;
    const manhattanPenalty = boroughKey === "manhattan" ? 1.5 : 0;
    const rawEta = Math.ceil(2.0 + ((distanceMiles / baseSpeedMph) * 60) + boroughChangePenalty + manhattanPenalty);
    const etaMinutes = Math.max(3, Math.min(25, Number.isFinite(rawEta) ? rawEta : 25));
    return { distanceMiles, etaMinutes };
  }

  function buildArrivalAwareCandidateShortlist(frame, currentSignal) {
    if (!currentSignal?.locationId) return [];
    const frameKey = getAssistantFrameKey(frame);
    const cacheKey = `${frameKey}|${currentSignal.locationId}|${getAssistantModeTendencySignature()}`;
    if (state.assistantShortlistCache.has(cacheKey)) return state.assistantShortlistCache.get(cacheKey) || [];
    const allCandidates = [];
    const currentBorough = normalizeAssistantBoroughName(currentSignal?.borough);
    for (const signal of getSignalsForFrame(frame)) {
      if (!signal?.locationId || signal.locationId === currentSignal.locationId) continue;
      if (signal.airportExcluded) continue;
      if (!Number.isFinite(signal.visibleRating)) continue;
      if (!Number.isFinite(signal.centerLat) || !Number.isFinite(signal.centerLng)) continue;
      const { distanceMiles, etaMinutes } = estimateAssistantTravelMinutes(currentSignal, signal);
      if (!Number.isFinite(distanceMiles) || distanceMiles > 5.0) continue;
      const quickScore = signal.visibleRating - (distanceMiles * 3.0);
      const isSameBorough = normalizeAssistantBoroughName(signal?.borough) === currentBorough;
      allCandidates.push({ signal, distanceMiles, etaMinutes, quickScore, isSameBorough });
    }
    const baseTopByQuickScore = allCandidates.slice().sort((a, b) => b.quickScore - a.quickScore).slice(0, 8);
    const guaranteedNearCandidates = allCandidates
      .filter((item) =>
        (safeNum(item?.etaMinutes, Infinity) || Infinity) <= 12
        && (safeNum(item?.distanceMiles, Infinity) || Infinity) <= 3.5
        && (safeNum(item?.signal?.visibleRating, -Infinity) || -Infinity) >= ((safeNum(currentSignal?.visibleRating, 0) || 0) + 3)
      )
      .sort((a, b) => {
        if (a.etaMinutes !== b.etaMinutes) return a.etaMinutes - b.etaMinutes;
        return (safeNum(b?.signal?.visibleRating, 0) || 0) - (safeNum(a?.signal?.visibleRating, 0) || 0);
      })
      .slice(0, 4);
    const guaranteedSameBoroughNearCandidates = allCandidates
      .filter((item) =>
        !!item?.isSameBorough
        && (safeNum(item?.etaMinutes, Infinity) || Infinity) <= 12
        && (safeNum(item?.signal?.visibleRating, -Infinity) || -Infinity) >= ((safeNum(currentSignal?.visibleRating, 0) || 0) + 2)
      )
      .sort((a, b) => {
        if (a.etaMinutes !== b.etaMinutes) return a.etaMinutes - b.etaMinutes;
        return (safeNum(b?.signal?.visibleRating, 0) || 0) - (safeNum(a?.signal?.visibleRating, 0) || 0);
      })
      .slice(0, 4);
    const currentVisibleRating = safeNum(currentSignal?.visibleRating, 0) || 0;
    const guaranteedAdjacentStrongCandidates = allCandidates
      .filter((item) => {
        const eta = safeNum(item?.etaMinutes, Infinity) || Infinity;
        const distance = safeNum(item?.distanceMiles, Infinity) || Infinity;
        const visibleRating = safeNum(item?.signal?.visibleRating, -Infinity) || -Infinity;
        const bucketStrong = isStrongOpportunityBucket(item?.signal?.visibleBucket);
        const projectedArrivalStrong = visibleRating >= (currentVisibleRating + 5)
          || (
            (safeNum(item?.signal?.busyNowBase, 0) || 0) >= 0.54
            && (safeNum(item?.signal?.continuationRaw, 0) || 0) >= 0.52
          );
        return !!item?.isSameBorough
          && eta <= 6
          && distance <= 1.2
          && visibleRating >= (currentVisibleRating + 3)
          && (bucketStrong || projectedArrivalStrong);
      })
      .sort((a, b) => {
        if (a.etaMinutes !== b.etaMinutes) return a.etaMinutes - b.etaMinutes;
        const ratingDelta = (safeNum(b?.signal?.visibleRating, 0) || 0) - (safeNum(a?.signal?.visibleRating, 0) || 0);
        if (ratingDelta !== 0) return ratingDelta;
        return (safeNum(a?.distanceMiles, Infinity) || Infinity) - (safeNum(b?.distanceMiles, Infinity) || Infinity);
      })
      .slice(0, 4);
    const mergedByLocationId = new Map();
    [baseTopByQuickScore, guaranteedNearCandidates, guaranteedSameBoroughNearCandidates, guaranteedAdjacentStrongCandidates].forEach((bucket) => {
      (bucket || []).forEach((candidate) => {
        const id = String(candidate?.signal?.locationId || "").trim();
        if (!id) return;
        const existing = mergedByLocationId.get(id);
        if (!existing || (safeNum(candidate?.quickScore, -Infinity) || -Infinity) > (safeNum(existing?.quickScore, -Infinity) || -Infinity)) {
          mergedByLocationId.set(id, candidate);
        }
      });
    });
    const shortlist = [...mergedByLocationId.values()].sort((a, b) => b.quickScore - a.quickScore).slice(0, 12);
    state.assistantShortlistCache.set(cacheKey, shortlist);
    trimMapCache(state.assistantShortlistCache, 10);
    return shortlist;
  }

  function computeRankings(frame, activeSignal) {
    const frameKey = getAssistantFrameKey(frame);
    const borough = String(activeSignal?.borough || "").trim();
    const cacheKey = `${frameKey}|${borough}|${getAssistantModeTendencySignature()}`;
    let cached = state.assistantRankingsCache.get(cacheKey) || null;
    if (!cached) {
      const signals = getSignalsForFrame(frame).filter((s) => !s.airportExcluded);
      signals.sort(sortByRatingThenId);
      const boroughSignals = signals.filter((s) => String(s.borough || "") === borough);
      cached = { signals, boroughSignals, borough };
      state.assistantRankingsCache.set(cacheKey, cached);
      trimMapCache(state.assistantRankingsCache, 10);
    }
    const signals = cached.signals;
    const boroughSignals = cached.boroughSignals;

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
    return String(
      frame?.frame_time ||
      frame?.frame_iso ||
      frame?.time_iso ||
      frame?.time ||
      ""
    ).trim() || null;
  }

  function buildOutlookCacheKey(frameTime, locationIds, visibleSource) {
    return [frameTime || "none", [...locationIds].sort().join(","), visibleSource || "legacy_citywide"].join("|");
  }

  function getAssistantOutlookByLocationId(outlookPayload) {
    const primary = outlookPayload?.zones_by_location_id;
    if (primary && typeof primary === "object" && !Array.isArray(primary)) return primary;
    const legacy = outlookPayload?.by_location_id;
    if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) return legacy;
    return {};
  }

  function extractAssistantOutlookTrack(point, visibleScoreSource) {
    const tracks = point?.tracks;
    if (!tracks || typeof tracks !== "object") return null;
    const exact = String(visibleScoreSource || "").trim();
    if (exact && tracks[exact]) return tracks[exact];
    const isV3Family = /_v3(?:$|_)/i.test(exact) || /citywide_v3/i.test(exact);
    if (isV3Family && tracks.citywide_v3_shadow) return tracks.citywide_v3_shadow;
    if (tracks.citywide_shadow) return tracks.citywide_shadow;
    return null;
  }

  function extractAssistantOutlookRaw(point, fallbackSignal, visibleScoreSource) {
    const fallback = fallbackSignal || {};
    const track = extractAssistantOutlookTrack(point, visibleScoreSource);
    const raw = (point?.raw && typeof point.raw === "object") ? point.raw : {};
    return {
      rating: safeNum(track?.rating, safeNum(fallback.visibleRating, safeNum(fallback.rating, 0)) || 0) || 0,
      bucket: String(track?.bucket || fallback.visibleBucket || fallback.bucket || "").trim() || null,
      busy_now_base: safeNum(raw?.busy_now_base_n_shadow, safeNum(fallback.busyNowBase, 0)) || 0,
      busy_next_base: safeNum(raw?.busy_next_base_n_shadow, safeNum(fallback.busyNextBase, 0)) || 0,
      short_trip_penalty: safeNum(raw?.short_trip_penalty_n_shadow, safeNum(fallback.shortTripPenalty, 0)) || 0,
      long_trip_share_20plus: safeNum(raw?.long_trip_share_20plus, safeNum(fallback.longTripShare20Plus, 0)) || 0,
      balanced_trip_share: safeNum(raw?.balanced_trip_share_shadow, safeNum(raw?.balanced_trip_share, safeNum(fallback.balancedTripShare, 0))) || 0,
      churn_pressure: safeNum(raw?.churn_pressure_n_shadow, safeNum(fallback.churnPressure, 0)) || 0,
      market_saturation_penalty: safeNum(raw?.market_saturation_penalty_n_shadow, safeNum(fallback.marketSaturationPenalty, 0)) || 0,
      manhattan_core_saturation_penalty: safeNum(raw?.manhattan_core_saturation_penalty_n_shadow, safeNum(fallback.manhattanCoreSaturationPenalty, 0)) || 0,
      continuation_raw: safeNum(raw?.downstream_next_value_raw, safeNum(fallback.continuationRaw, 0)) || 0,
      frame_time: String(point?.frame_time || point?.ts || "").trim() || null,
    };
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
      const normalized = extractAssistantOutlookRaw(p, currentSignal, state.visibleScoreSource);
      const pseudo = {
        ...currentSignal,
        visibleRating: safeNum(normalized.rating, nowRating) || nowRating,
        busyNowBase: safeNum(normalized.busy_now_base, currentSignal?.busyNowBase || 0) || 0,
        shortTripPenalty: safeNum(normalized.short_trip_penalty, currentSignal?.shortTripPenalty || 0) || 0,
        churnPressure: safeNum(normalized.churn_pressure, currentSignal?.churnPressure || 0) || 0,
        continuationRaw: safeNum(normalized.continuation_raw, currentSignal?.continuationRaw || 0) || 0,
        marketSaturationPenalty: safeNum(normalized.market_saturation_penalty, currentSignal?.marketSaturationPenalty || 0) || 0,
        manhattanCoreSaturationPenalty: safeNum(normalized.manhattan_core_saturation_penalty, currentSignal?.manhattanCoreSaturationPenalty || 0) || 0,
        longTripShare20Plus: safeNum(normalized.long_trip_share_20plus, currentSignal?.longTripShare20Plus || 0) || 0,
      };
      const cls = classifyAssistantSignal(pseudo);
      const ts = normalized.frame_time;
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

  function getAssistantArrivalBinIndex(etaMinutes, pointCount) {
    if (!pointCount || pointCount <= 0) return 0;
    const rawIndex = Math.floor(((safeNum(etaMinutes, 0) || 0) + 10) / 20);
    return Math.max(0, Math.min(pointCount - 1, rawIndex));
  }

  function readOutlookRating(point, fallback = null) {
    const normalized = extractAssistantOutlookRaw(point, { visibleRating: fallback }, state.visibleScoreSource);
    return safeNum(normalized?.rating, fallback);
  }

  function classifyAssistantFuturePoint(point, baseSignal) {
    const normalized = extractAssistantOutlookRaw(point, baseSignal, state.visibleScoreSource);
    const rating = safeNum(normalized?.rating, safeNum(baseSignal?.visibleRating, 0) || 0) || 0;
    const pseudoSignal = {
      ...baseSignal,
      visibleRating: rating,
      visibleBucket: String(modeModule.effectiveBucket?.({ bucket: normalized?.bucket }, null) || normalized?.bucket || baseSignal?.visibleBucket || "").trim() || null,
      busyNowBase: safeNum(normalized?.busy_now_base, safeNum(baseSignal?.busyNowBase, 0) || 0) || 0,
      shortTripPenalty: safeNum(normalized?.short_trip_penalty, safeNum(baseSignal?.shortTripPenalty, 0) || 0) || 0,
      churnPressure: safeNum(normalized?.churn_pressure, safeNum(baseSignal?.churnPressure, 0) || 0) || 0,
      continuationRaw: safeNum(normalized?.continuation_raw, safeNum(baseSignal?.continuationRaw, 0) || 0) || 0,
      marketSaturationPenalty: safeNum(normalized?.market_saturation_penalty, safeNum(baseSignal?.marketSaturationPenalty, 0) || 0) || 0,
      manhattanCoreSaturationPenalty: safeNum(normalized?.manhattan_core_saturation_penalty, safeNum(baseSignal?.manhattanCoreSaturationPenalty, 0) || 0) || 0,
      longTripShare20Plus: safeNum(normalized?.long_trip_share_20plus, safeNum(baseSignal?.longTripShare20Plus, 0) || 0) || 0,
    };
    const cls = classifyAssistantSignal(pseudoSignal);
    return {
      rating,
      bucket: pseudoSignal.visibleBucket,
      isTrap: !!cls.shortTrap,
      isSlow: !!cls.slowNow,
      isBusy: !!cls.busyNow,
      isSaturationCaution: !!cls.saturationCaution,
      hasGoodContinuation: !!cls.continuationGood,
      hasWeakContinuation: !!cls.continuationWeak,
      longTripFriendly: !!cls.longFriendly,
      frameTime: normalized?.frame_time || null,
    };
  }

  function getAssistantArrivalProjection(points, etaMinutes) {
    if (!Array.isArray(points) || !points.length) {
      return { arrivalIndex: 0, arrivalPoint: null, nextPoint: null, arrivalProjectedRating: null };
    }
    const arrivalIndex = getAssistantArrivalBinIndex(etaMinutes, points.length);
    const arrivalPoint = points[arrivalIndex] || null;
    const nextPoint = points[arrivalIndex + 1] || null;
    const arrivalRating = readOutlookRating(arrivalPoint);
    const nextRating = readOutlookRating(nextPoint);
    const arrivalProjectedRating = Number.isFinite(nextRating)
      ? ((arrivalRating || 0) * 0.65) + (nextRating * 0.35)
      : arrivalRating;
    return { arrivalIndex, arrivalPoint, nextPoint, arrivalProjectedRating };
  }

  function deriveStayArrivalWindowMetrics(currentZonePoints, currentSignal, etaMinutes) {
    const points = Array.isArray(currentZonePoints) ? currentZonePoints : [];
    if (!points.length) {
      const fallback = safeNum(currentSignal?.visibleRating, 0) || 0;
      return {
        stayArrivalIndex: 0,
        stayArrivalProjectedRating: fallback,
        stayWindowMinRating: fallback,
        stayWindowAvgRating: fallback,
        stayWindowTrendDelta: 0,
        stayTrapAtArrival: false,
        staySlowAtArrival: false,
        staySaturationAtArrival: false,
        stayImprovesSoon: false,
        stayWeakensSoon: false,
        stayHoldsAfterArrival: true,
      };
    }
    const stayArrivalIndex = getAssistantArrivalBinIndex(etaMinutes, points.length);
    const windowPoints = points.slice(stayArrivalIndex, stayArrivalIndex + 3);
    const arrivalPoint = points[stayArrivalIndex] || null;
    const nextPoint = points[stayArrivalIndex + 1] || null;
    const arrivalCls = classifyAssistantFuturePoint(arrivalPoint, currentSignal);
    const nextRating = readOutlookRating(nextPoint);
    const stayArrivalProjectedRating = Number.isFinite(nextRating)
      ? ((arrivalCls.rating || 0) * 0.70) + (nextRating * 0.30)
      : (arrivalCls.rating || 0);
    const windowClassified = windowPoints.map((p) => classifyAssistantFuturePoint(p, currentSignal)).filter(Boolean);
    const ratings = windowClassified.map((p) => p.rating).filter((n) => Number.isFinite(n));
    const stayWindowMinRating = ratings.length ? Math.min(...ratings) : arrivalCls.rating;
    const stayWindowAvgRating = ratings.length ? (ratings.reduce((sum, n) => sum + n, 0) / ratings.length) : arrivalCls.rating;
    const lastWindowRating = ratings.length ? ratings[ratings.length - 1] : arrivalCls.rating;
    const stayWindowTrendDelta = (lastWindowRating || 0) - (arrivalCls.rating || 0);
    const stayHoldsAfterArrival = stayWindowMinRating >= (stayArrivalProjectedRating - 4) && !(arrivalCls.isTrap || arrivalCls.isSlow);
    return {
      stayArrivalIndex,
      stayArrivalProjectedRating,
      stayWindowMinRating,
      stayWindowAvgRating,
      stayWindowTrendDelta,
      stayTrapAtArrival: arrivalCls.isTrap,
      staySlowAtArrival: arrivalCls.isSlow,
      staySaturationAtArrival: arrivalCls.isSaturationCaution,
      stayImprovesSoon: stayWindowTrendDelta >= 3,
      stayWeakensSoon: stayWindowTrendDelta <= -3,
      stayHoldsAfterArrival,
    };
  }

  function deriveTargetArrivalWindowMetrics(candidatePoints, candidateSignal, etaMinutes) {
    const points = Array.isArray(candidatePoints) ? candidatePoints : [];
    if (!points.length) {
      const fallback = safeNum(candidateSignal?.visibleRating, 0) || 0;
      return {
        targetArrivalIndex: 0,
        targetArrivalProjectedRating: fallback,
        targetWindowMinRating: fallback,
        targetWindowAvgRating: fallback,
        targetWindowTrendDelta: 0,
        targetTrapAtArrival: false,
        targetSlowAtArrival: false,
        targetSaturationAtArrival: false,
        targetImprovesSoon: false,
        targetWeakensSoon: false,
        targetHoldsAfterArrival: true,
        targetLooksChasey: false,
      };
    }
    const targetArrivalIndex = getAssistantArrivalBinIndex(etaMinutes, points.length);
    const windowPoints = points.slice(targetArrivalIndex, targetArrivalIndex + 3);
    const arrivalPoint = points[targetArrivalIndex] || null;
    const nextPoint = points[targetArrivalIndex + 1] || null;
    const arrivalCls = classifyAssistantFuturePoint(arrivalPoint, candidateSignal);
    const nextRating = readOutlookRating(nextPoint);
    const targetArrivalProjectedRating = Number.isFinite(nextRating)
      ? ((arrivalCls.rating || 0) * 0.65) + (nextRating * 0.35)
      : (arrivalCls.rating || 0);
    const windowClassified = windowPoints.map((p) => classifyAssistantFuturePoint(p, candidateSignal)).filter(Boolean);
    const ratings = windowClassified.map((p) => p.rating).filter((n) => Number.isFinite(n));
    const targetWindowMinRating = ratings.length ? Math.min(...ratings) : arrivalCls.rating;
    const targetWindowAvgRating = ratings.length ? (ratings.reduce((sum, n) => sum + n, 0) / ratings.length) : arrivalCls.rating;
    const lastWindowRating = ratings.length ? ratings[ratings.length - 1] : arrivalCls.rating;
    const targetWindowTrendDelta = (lastWindowRating || 0) - (arrivalCls.rating || 0);
    const targetHoldsAfterArrival = targetWindowMinRating >= (targetArrivalProjectedRating - 4) && !arrivalCls.isTrap && !arrivalCls.isSlow;
    const targetLooksChasey = (targetArrivalProjectedRating >= 58) && (targetWindowTrendDelta <= -5 || targetWindowMinRating <= (targetArrivalProjectedRating - 6));
    return {
      targetArrivalIndex,
      targetArrivalProjectedRating,
      targetWindowMinRating,
      targetWindowAvgRating,
      targetWindowTrendDelta,
      targetTrapAtArrival: arrivalCls.isTrap,
      targetSlowAtArrival: arrivalCls.isSlow,
      targetSaturationAtArrival: arrivalCls.isSaturationCaution,
      targetImprovesSoon: targetWindowTrendDelta >= 3,
      targetWeakensSoon: targetWindowTrendDelta <= -3,
      targetHoldsAfterArrival,
      targetLooksChasey,
    };
  }

  function isAssistantCandidateViableOnArrival(currentMetrics, targetMetrics, etaMinutes) {
    if (targetMetrics?.targetTrapAtArrival) return { viable: false, viabilityRejectCode: "trap_at_arrival", viabilityRejectReasonText: "Target weak by arrival." };
    if (targetMetrics?.targetSlowAtArrival && (safeNum(targetMetrics?.targetArrivalProjectedRating, 0) || 0) < 52) return { viable: false, viabilityRejectCode: "slow_at_arrival", viabilityRejectReasonText: "Target weak by arrival." };
    if (targetMetrics?.targetSaturationAtArrival && (safeNum(targetMetrics?.targetArrivalProjectedRating, 0) || 0) < 56) return { viable: false, viabilityRejectCode: "saturation_at_arrival", viabilityRejectReasonText: "Target weak by arrival." };
    if (targetMetrics?.targetLooksChasey) return { viable: false, viabilityRejectCode: "target_chasey", viabilityRejectReasonText: "Move is chasing a short spike." };
    if ((safeNum(etaMinutes, 0) || 0) > 12 && !targetMetrics?.targetHoldsAfterArrival) return { viable: false, viabilityRejectCode: "long_eta_no_hold", viabilityRejectReasonText: "Target may cool off before you get there." };
    if ((safeNum(targetMetrics?.targetWindowMinRating, 0) || 0) < 48 && (safeNum(currentMetrics?.stayWindowMinRating, 0) || 0) >= 48) {
      return { viable: false, viabilityRejectCode: "current_holds_better", viabilityRejectReasonText: "Current zone holds better than the target." };
    }
    return { viable: true, viabilityRejectCode: null, viabilityRejectReasonText: "" };
  }

  function deriveTravelWindowMetrics(currentZonePoints, currentSignal, etaMinutes) {
    const points = Array.isArray(currentZonePoints) ? currentZonePoints : [];
    if (!points.length) {
      const fallback = safeNum(currentSignal?.visibleRating, 0) || 0;
      return {
        travelWindowPointCount: 1,
        travelWindowAvgRating: fallback,
        travelWindowMinRating: fallback,
        travelWindowTrendDelta: 0,
        travelWindowBusyCount: 0,
        travelWindowTrapCount: 0,
        travelWindowSlowCount: 0,
      };
    }
    const arrivalIndex = getAssistantArrivalBinIndex(etaMinutes, points.length);
    const travelPoints = points.slice(0, arrivalIndex + 1);
    const classified = travelPoints.map((p) => classifyAssistantFuturePoint(p, currentSignal)).filter(Boolean);
    const ratings = classified.map((p) => p.rating).filter((n) => Number.isFinite(n));
    const currentRating = safeNum(classified[0]?.rating, safeNum(currentSignal?.visibleRating, 0) || 0) || 0;
    const arrivalRating = safeNum(classified[classified.length - 1]?.rating, currentRating) || currentRating;
    return {
      travelWindowPointCount: classified.length || 1,
      travelWindowAvgRating: ratings.length ? ratings.reduce((sum, n) => sum + n, 0) / ratings.length : currentRating,
      travelWindowMinRating: ratings.length ? Math.min(...ratings) : currentRating,
      travelWindowTrendDelta: arrivalRating - currentRating,
      travelWindowBusyCount: classified.filter((p) => p.isBusy).length,
      travelWindowTrapCount: classified.filter((p) => p.isTrap).length,
      travelWindowSlowCount: classified.filter((p) => p.isSlow).length,
    };
  }

  function deriveTargetPaybackWindowMetrics(candidatePoints, candidateSignal, etaMinutes) {
    const points = Array.isArray(candidatePoints) ? candidatePoints : [];
    if (!points.length) {
      const fallback = safeNum(candidateSignal?.visibleRating, 0) || 0;
      return {
        paybackPointCount: 1,
        paybackAvgRating: fallback,
        paybackMinRating: fallback,
        paybackTrendDelta: 0,
        paybackBusyCount: 0,
        paybackTrapCount: 0,
        paybackSlowCount: 0,
        paybackHolds: true,
      };
    }
    const arrivalIndex = getAssistantArrivalBinIndex(etaMinutes, points.length);
    const paybackPoints = points.slice(arrivalIndex, arrivalIndex + 3);
    const classified = paybackPoints.map((p) => classifyAssistantFuturePoint(p, candidateSignal)).filter(Boolean);
    const ratings = classified.map((p) => p.rating).filter((n) => Number.isFinite(n));
    const arrivalRating = safeNum(classified[0]?.rating, safeNum(candidateSignal?.visibleRating, 0) || 0) || 0;
    const arrivalProjection = getAssistantArrivalProjection(points, etaMinutes);
    const targetArrivalProjectedRating = safeNum(arrivalProjection?.arrivalProjectedRating, arrivalRating) || arrivalRating;
    const lastRating = safeNum(classified[classified.length - 1]?.rating, arrivalRating) || arrivalRating;
    const paybackAvgRating = ratings.length ? ratings.reduce((sum, n) => sum + n, 0) / ratings.length : arrivalRating;
    const paybackMinRating = ratings.length ? Math.min(...ratings) : arrivalRating;
    const paybackTrapCount = classified.filter((p) => p.isTrap).length;
    const paybackSlowCount = classified.filter((p) => p.isSlow).length;
    return {
      paybackPointCount: classified.length || 1,
      paybackAvgRating,
      paybackMinRating,
      paybackTrendDelta: lastRating - arrivalRating,
      paybackBusyCount: classified.filter((p) => p.isBusy).length,
      paybackTrapCount,
      paybackSlowCount,
      paybackHolds: paybackMinRating >= (targetArrivalProjectedRating - 4) && paybackTrapCount === 0 && paybackSlowCount <= 1,
    };
  }

  function deriveAssistantDeadheadCost(currentSignal, candidateSignal, etaMinutes, distanceMiles) {
    const timeCost = (safeNum(etaMinutes, 0) || 0) * 0.60;
    const distanceCost = (safeNum(distanceMiles, 0) || 0) * 0.45;
    const currentBorough = normalizeAssistantBoroughName(currentSignal?.borough);
    const targetBorough = normalizeAssistantBoroughName(candidateSignal?.borough);
    const boroughSwitchCost = currentBorough && targetBorough && currentBorough !== targetBorough ? 1.5 : 0;
    const manhattanEntryCost = targetBorough === "manhattan" && currentBorough !== "manhattan" ? 1.5 : 0;
    return {
      timeCost,
      distanceCost,
      boroughSwitchCost,
      manhattanEntryCost,
      totalDeadheadCost: timeCost + distanceCost + boroughSwitchCost + manhattanEntryCost,
    };
  }

  function deriveAssistantMoveConfidencePenalty(targetMetrics, viability, etaMinutes) {
    let confidencePenalty = 0;
    const confidencePenaltyReasons = [];
    if (!viability?.viable) { confidencePenalty += 2.0; confidencePenaltyReasons.push("target_not_viable"); }
    if (!targetMetrics?.paybackHolds) { confidencePenalty += 1.5; confidencePenaltyReasons.push("payback_does_not_hold"); }
    if ((safeNum(targetMetrics?.paybackTrendDelta, 0) || 0) <= -4) { confidencePenalty += 1.5; confidencePenaltyReasons.push("payback_trending_down"); }
    if ((safeNum(targetMetrics?.paybackPointCount, 0) || 0) < 2) { confidencePenalty += 1.0; confidencePenaltyReasons.push("insufficient_payback_points"); }
    if ((safeNum(etaMinutes, 0) || 0) > 14) { confidencePenalty += 1.0; confidencePenaltyReasons.push("long_eta"); }
    if ((safeNum(targetMetrics?.paybackTrapCount, 0) || 0) > 0) { confidencePenalty += 1.5; confidencePenaltyReasons.push("payback_trap_risk"); }
    if ((safeNum(targetMetrics?.paybackSlowCount, 0) || 0) > 1) { confidencePenalty += 1.0; confidencePenaltyReasons.push("payback_slow_risk"); }
    return { confidencePenalty, confidencePenaltyReasons };
  }

  function evaluateEconomicsAwareMoveCandidate(candidateSignal, currentSignal, candidatePoints, currentPoints, etaMinutes, distanceMiles) {
    const currentMetrics = deriveStayArrivalWindowMetrics(currentPoints, currentSignal, etaMinutes);
    const targetMetrics = deriveTargetArrivalWindowMetrics(candidatePoints, candidateSignal, etaMinutes);
    const currentTravelMetrics = deriveTravelWindowMetrics(currentPoints, currentSignal, etaMinutes);
    const targetPaybackMetrics = deriveTargetPaybackWindowMetrics(candidatePoints, candidateSignal, etaMinutes);
    targetPaybackMetrics.paybackHolds = targetPaybackMetrics.paybackMinRating >= (safeNum(targetMetrics?.targetArrivalProjectedRating, 0) - 4) && targetPaybackMetrics.paybackTrapCount === 0 && targetPaybackMetrics.paybackSlowCount <= 1;
    const viability = isAssistantCandidateViableOnArrival(currentMetrics, targetMetrics, etaMinutes);
    const deadheadCost = deriveAssistantDeadheadCost(currentSignal, candidateSignal, etaMinutes, distanceMiles);
    const confidencePenalty = deriveAssistantMoveConfidencePenalty(targetPaybackMetrics, viability, etaMinutes);
    const stayScenarioValue =
      (0.45 * (safeNum(currentTravelMetrics?.travelWindowAvgRating, 0) || 0)) +
      (0.55 * (safeNum(currentMetrics?.stayWindowAvgRating, 0) || 0)) -
      ((safeNum(currentSignal?.communityCrowdingPenalty, 0) || 0) * 0.75);
    const moveScenarioValue =
      (0.40 * (safeNum(targetMetrics?.targetArrivalProjectedRating, 0) || 0)) +
      (0.60 * (safeNum(targetPaybackMetrics?.paybackAvgRating, 0) || 0)) -
      ((safeNum(candidateSignal?.communityCrowdingPenalty, 0) || 0) * 0.75) -
      (safeNum(deadheadCost?.totalDeadheadCost, 0) || 0) -
      (safeNum(confidencePenalty?.confidencePenalty, 0) || 0);
    const netMoveEdge = moveScenarioValue - stayScenarioValue;
    return {
      candidateSignal,
      distanceMiles,
      etaMinutes,
      moveScenarioValue,
      stayScenarioValue,
      netMoveEdge,
      currentTravelMetrics,
      currentMetrics,
      targetMetrics,
      targetPaybackMetrics,
      viability,
      deadheadCost,
      confidencePenalty,
    };
  }

  function getAssistantMoveWorthThreshold(currentSignal, currentTravelMetrics, currentMetrics, targetMetrics, targetPaybackMetrics, deadheadCost, etaMinutes) {
    const eta = safeNum(etaMinutes, 0) || 0;
    let threshold = 10.0;
    if (eta <= 5) threshold = 4.0;
    else if (eta <= 9) threshold = 5.5;
    else if (eta <= 14) threshold = 7.5;

    const currentCls = classifyAssistantSignal(currentSignal || {});
    if (currentCls?.shortTrap || currentCls?.slowNow) threshold -= 2.0;
    if ((safeNum(currentTravelMetrics?.travelWindowAvgRating, 0) || 0) >= 52) threshold += 1.5;
    if (currentMetrics?.stayHoldsAfterArrival) threshold += 1.5;
    if (!targetPaybackMetrics?.paybackHolds) threshold += 2.0;
    if ((safeNum(deadheadCost?.totalDeadheadCost, 0) || 0) >= 10) threshold += 1.5;
    if (currentMetrics?.stayWeakensSoon && targetMetrics?.targetImprovesSoon) threshold -= 1.5;
    return threshold;
  }

  function sortPracticalTargetOrder(a, b) {
    if (b.netMoveEdge !== a.netMoveEdge) return b.netMoveEdge - a.netMoveEdge;
    const aPayback = safeNum(a?.targetPaybackMetrics?.paybackAvgRating, 0) || 0;
    const bPayback = safeNum(b?.targetPaybackMetrics?.paybackAvgRating, 0) || 0;
    if (bPayback !== aPayback) return bPayback - aPayback;
    if (a.etaMinutes !== b.etaMinutes) return a.etaMinutes - b.etaMinutes;
    const aCost = safeNum(a?.deadheadCost?.totalDeadheadCost, Infinity);
    const bCost = safeNum(b?.deadheadCost?.totalDeadheadCost, Infinity);
    if (aCost !== bCost) return aCost - bCost;
    return (safeNum(b?.targetMetrics?.targetArrivalProjectedRating, 0) || 0) - (safeNum(a?.targetMetrics?.targetArrivalProjectedRating, 0) || 0);
  }

  function shouldNearTargetDominate(bestNearEval, farEval, currentSignal) {
    if (!bestNearEval || !farEval) return { dominate: false, code: "", reason: "" };
    const farEta = safeNum(farEval?.etaMinutes, 0) || 0;
    const nearEta = safeNum(bestNearEval?.etaMinutes, 0) || 0;
    const farEdge = safeNum(farEval?.netMoveEdge, -Infinity) || -Infinity;
    const nearEdge = safeNum(bestNearEval?.netMoveEdge, -Infinity) || -Infinity;
    const farPayback = safeNum(farEval?.targetPaybackMetrics?.paybackAvgRating, 0) || 0;
    const nearPayback = safeNum(bestNearEval?.targetPaybackMetrics?.paybackAvgRating, 0) || 0;
    const farCost = safeNum(farEval?.deadheadCost?.totalDeadheadCost, Infinity) || Infinity;
    const nearCost = safeNum(bestNearEval?.deadheadCost?.totalDeadheadCost, Infinity) || Infinity;
    const currentCls = classifyAssistantSignal(currentSignal || {});
    const metrics = bestNearEval?.currentMetrics || farEval?.currentMetrics || {};
    const currentCollapsing = !!currentCls?.shortTrap
      || !!metrics?.stayTrapAtArrival
      || (!!metrics?.staySlowAtArrival && (safeNum(metrics?.stayWindowMinRating, 100) || 100) < 46)
      || (safeNum(metrics?.stayWindowTrendDelta, 0) || 0) <= -5;
    const nearIsSameBorough = !!bestNearEval?.isSameBorough;
    const nearIsWorthwhile = !!bestNearEval?.isWorthMoving;
    const farCostJustified = farCost <= (nearCost + 0.8);

    if (nearIsWorthwhile && farEta > 20) {
      const canOverride = currentCollapsing
        && farEdge >= (nearEdge + 6.0)
        && farPayback >= (nearPayback + 4.0);
      if (!canOverride) return { dominate: true, code: "target_too_far_for_edge", reason: "Target is too far for the edge" };
    }
    if (nearIsWorthwhile && nearIsSameBorough && nearEta <= 12 && farEta > 16) {
      const canOverride = farEdge >= (nearEdge + 5.5) && farPayback >= (nearPayback + 3.5);
      if (!canOverride) return { dominate: true, code: "same_borough_target_preferred", reason: "Closer same-borough target makes more sense" };
    }
    if (nearIsWorthwhile && nearEta <= 10) {
      const canOverride = farEdge >= (nearEdge + 5.0) && farCostJustified && currentCollapsing;
      if (!canOverride) return { dominate: true, code: "closer_strong_target_available", reason: "Closer strong zone available" };
    }
    if (nearIsWorthwhile && nearEdge >= (safeNum(bestNearEval?.moveWorthThreshold, Infinity) || Infinity)) {
      const canOverride = farEdge >= (nearEdge + 5.0) && farPayback >= (nearPayback + 3.0) && farCostJustified && currentCollapsing;
      if (!canOverride) return { dominate: true, code: "far_target_not_worth_time", reason: "Far target is not worth the time" };
    }
    return { dominate: false, code: "", reason: "" };
  }

  function findAdjacentStrongNearbyTarget(currentSignal, candidateEvaluations) {
    const currentBorough = normalizeAssistantBoroughName(currentSignal?.borough);
    const currentVisibleRating = safeNum(currentSignal?.visibleRating, 0) || 0;
    const currentStayArrival = safeNum(currentSignal?.visibleRating, 0) || 0;
    const options = (Array.isArray(candidateEvaluations) ? candidateEvaluations : [])
      .filter((evalObj) => {
        if (!evalObj?.candidateSignal?.locationId) return false;
        const sameBorough = normalizeAssistantBoroughName(evalObj?.candidateSignal?.borough) === currentBorough;
        if (!sameBorough) return false;
        const eta = safeNum(evalObj?.etaMinutes, Infinity) || Infinity;
        const distance = safeNum(evalObj?.distanceMiles, Infinity) || Infinity;
        if (eta > 6 || distance > 1.2) return false;
        const visibleRating = safeNum(evalObj?.candidateSignal?.visibleRating, -Infinity) || -Infinity;
        if (visibleRating < (currentVisibleRating + 4)) return false;
        const strongBucket = isStrongOpportunityBucket(evalObj?.candidateSignal?.visibleBucket);
        const arrivalProjected = safeNum(evalObj?.targetMetrics?.targetArrivalProjectedRating, 0) || 0;
        const stayProjected = safeNum(evalObj?.currentMetrics?.stayArrivalProjectedRating, currentStayArrival) || currentStayArrival;
        const clearlyBetterOnArrival = arrivalProjected >= (stayProjected + 4);
        if (!(strongBucket || clearlyBetterOnArrival)) return false;
        if (!evalObj?.viability?.viable) return false;
        if (evalObj?.targetMetrics?.targetLooksChasey) return false;
        if (!evalObj?.targetPaybackMetrics?.paybackHolds) return false;
        return true;
      })
      .sort((a, b) => {
        const etaDelta = (safeNum(a?.etaMinutes, Infinity) || Infinity) - (safeNum(b?.etaMinutes, Infinity) || Infinity);
        if (etaDelta !== 0) return etaDelta;
        const arrivalDelta = (safeNum(b?.targetMetrics?.targetArrivalProjectedRating, 0) || 0) - (safeNum(a?.targetMetrics?.targetArrivalProjectedRating, 0) || 0);
        if (arrivalDelta !== 0) return arrivalDelta;
        return sortPracticalTargetOrder(a, b);
      });
    return options[0] || null;
  }

  function isDriverAlreadyNextToStrongOpportunity(currentSignal, adjacentEval) {
    if (!currentSignal || !adjacentEval) return false;
    const eta = safeNum(adjacentEval?.etaMinutes, Infinity) || Infinity;
    const distance = safeNum(adjacentEval?.distanceMiles, Infinity) || Infinity;
    if (eta > 5 || distance > 1.0) return false;
    const strongBucket = isStrongOpportunityBucket(adjacentEval?.candidateSignal?.visibleBucket);
    const currentStayArrival = safeNum(adjacentEval?.currentMetrics?.stayArrivalProjectedRating, safeNum(currentSignal?.visibleRating, 0) || 0) || 0;
    const arrivalProjected = safeNum(adjacentEval?.targetMetrics?.targetArrivalProjectedRating, 0) || 0;
    return strongBucket || arrivalProjected >= (currentStayArrival + 4);
  }

  function shouldAdjacentStrongTargetDominate(adjacentEval, selectedEval, currentSignal) {
    if (!adjacentEval) return false;
    if (!selectedEval || String(selectedEval?.candidateSignal?.locationId || "") === String(adjacentEval?.candidateSignal?.locationId || "")) return true;
    const adjacentEta = safeNum(adjacentEval?.etaMinutes, Infinity) || Infinity;
    const selectedEta = safeNum(selectedEval?.etaMinutes, Infinity) || Infinity;
    if (adjacentEta > 6) return false;
    const selectedArrival = safeNum(selectedEval?.targetMetrics?.targetArrivalProjectedRating, 0) || 0;
    const adjacentArrival = safeNum(adjacentEval?.targetMetrics?.targetArrivalProjectedRating, 0) || 0;
    const selectedMoveEdge = safeNum(selectedEval?.netMoveEdge, -Infinity) || -Infinity;
    const adjacentMoveEdge = safeNum(adjacentEval?.netMoveEdge, -Infinity) || -Infinity;
    const selectedPayback = safeNum(selectedEval?.targetPaybackMetrics?.paybackAvgRating, 0) || 0;
    const adjacentPayback = safeNum(adjacentEval?.targetPaybackMetrics?.paybackAvgRating, 0) || 0;
    const selectedPaybackHolds = !!selectedEval?.targetPaybackMetrics?.paybackHolds;
    const currentMetrics = selectedEval?.currentMetrics || adjacentEval?.currentMetrics || {};
    const currentCls = classifyAssistantSignal(currentSignal || {});
    const currentWeakeningEnough = !!currentCls?.shortTrap
      || !!currentMetrics?.stayTrapAtArrival
      || (!!currentMetrics?.staySlowAtArrival && (safeNum(currentMetrics?.stayWindowMinRating, 100) || 100) < 46)
      || (safeNum(currentMetrics?.stayWindowTrendDelta, 0) || 0) <= -5
      || !!currentMetrics?.stayWeakensSoon;
    const selectedDramaticallyBetterByArrival = selectedArrival >= (adjacentArrival + 4);
    const overrideAllowed = (selectedMoveEdge >= (adjacentMoveEdge + 6))
      && selectedDramaticallyBetterByArrival
      && selectedPaybackHolds
      && (selectedPayback >= (adjacentPayback + 3))
      && currentWeakeningEnough;
    const nearbySafetyActive = isDriverAlreadyNextToStrongOpportunity(currentSignal, adjacentEval);
    if (nearbySafetyActive) return !overrideAllowed;
    if (selectedEta >= (adjacentEta + 4) && !selectedDramaticallyBetterByArrival) return true;
    return !overrideAllowed;
  }

  function isFarTargetStillWorthIt(bestNearEval, farEval, currentSignal, currentMetrics) {
    const eta = safeNum(farEval?.etaMinutes, 0) || 0;
    const nearExists = !!bestNearEval;
    const nearIsSameBorough = !!bestNearEval?.isSameBorough;
    const nearIsWorthwhile = nearExists && !!bestNearEval?.isWorthMoving;
    const currentCls = classifyAssistantSignal(currentSignal || {});
    const metrics = currentMetrics || farEval?.currentMetrics || {};
    const currentCollapsing = !!currentCls?.shortTrap
      || !!metrics?.stayTrapAtArrival
      || (!!metrics?.staySlowAtArrival && (safeNum(metrics?.stayWindowMinRating, 100) || 100) < 46)
      || (safeNum(metrics?.stayWindowTrendDelta, 0) || 0) <= -5;
    const farEdge = safeNum(farEval?.netMoveEdge, -Infinity) || -Infinity;
    const farThreshold = safeNum(farEval?.moveWorthThreshold, Infinity) || Infinity;
    const nearEdge = safeNum(bestNearEval?.netMoveEdge, -Infinity) || -Infinity;
    const farPayback = safeNum(farEval?.targetPaybackMetrics?.paybackAvgRating, 0) || 0;
    const nearPayback = safeNum(bestNearEval?.targetPaybackMetrics?.paybackAvgRating, 0) || 0;
    const nearDominance = shouldNearTargetDominate(bestNearEval, farEval, currentSignal);

    if (nearDominance.dominate) {
      return { ok: false, code: nearDominance.code || "far_target_not_worth_time", reason: nearDominance.reason || "Far target is not worth the time" };
    }

    if (eta > AI_ASSISTANT_FAR_TARGET_HARD_CAP_MIN) {
      if (nearExists) return { ok: false, code: "same_borough_target_preferred", reason: "Closer same-borough target makes more sense" };
      if (!currentCollapsing || farEdge < (farThreshold + 6.0)) {
        return { ok: false, code: "target_too_far_for_edge", reason: "Target is too far for the edge" };
      }
      return { ok: true };
    }

    if (eta > AI_ASSISTANT_FAR_TARGET_SOFT_CAP_MIN && nearExists) {
      let requiredEdgeDelta = AI_ASSISTANT_FAR_TARGET_EXTRA_EDGE_REQUIRED;
      if (nearIsSameBorough) requiredEdgeDelta += AI_ASSISTANT_SAME_BOROUGH_PREFERENCE_BONUS;
      if (nearIsWorthwhile) requiredEdgeDelta += AI_ASSISTANT_NEAR_TARGET_EDGE_BUFFER;
      const dominatesOnEdge = farEdge >= (nearEdge + requiredEdgeDelta);
      const dominatesOnPayback = farPayback >= (nearPayback + 3.0);
      if (!dominatesOnEdge || !dominatesOnPayback) {
        return { ok: false, code: nearIsSameBorough ? "same_borough_target_preferred" : "closer_strong_target_available", reason: nearIsSameBorough ? "Closer same-borough target makes more sense" : "Closer strong zone available" };
      }
    }

    if (nearIsWorthwhile) {
      const requiredNearBeat = nearIsSameBorough
        ? (AI_ASSISTANT_FAR_TARGET_EXTRA_EDGE_REQUIRED + AI_ASSISTANT_SAME_BOROUGH_PREFERENCE_BONUS)
        : AI_ASSISTANT_FAR_TARGET_EXTRA_EDGE_REQUIRED;
      if (farEdge < (nearEdge + requiredNearBeat)) {
        return { ok: false, code: nearIsSameBorough ? "same_borough_target_preferred" : "closer_strong_target_available", reason: nearIsSameBorough ? "Closer same-borough target makes more sense" : "Closer strong zone available" };
      }
    }

    return { ok: true };
  }

  function chooseBestEconomicsAwareTarget(candidateEvaluations, currentSignal) {
    const sorted = (Array.isArray(candidateEvaluations) ? candidateEvaluations : []).slice().sort(sortPracticalTargetOrder);
    const worthwhile = sorted.filter((it) => !!it.viability?.viable && (safeNum(it.netMoveEdge, -Infinity) || -Infinity) >= (safeNum(it.moveWorthThreshold, Infinity) || Infinity));
    worthwhile.forEach((item) => {
      item.isNearTarget = (safeNum(item?.etaMinutes, Infinity) || Infinity) <= AI_ASSISTANT_NEAR_TARGET_MAX_ETA_MIN;
      item.isSameBorough = normalizeAssistantBoroughName(item?.candidateSignal?.borough) === normalizeAssistantBoroughName(currentSignal?.borough);
      item.rejectionCode = "";
      item.rejectionReasonText = "";
    });
    const nearCandidates = worthwhile.filter((it) => it.isNearTarget);
    const sameBoroughNearCandidates = nearCandidates.filter((it) => it.isSameBorough).sort(sortPracticalTargetOrder);
    const crossBoroughNearCandidates = nearCandidates.filter((it) => !it.isSameBorough).sort(sortPracticalTargetOrder);
    const farCandidates = worthwhile.filter((it) => !it.isNearTarget).sort(sortPracticalTargetOrder);
    const farCandidatesOverSoftCap = farCandidates.filter((it) => (safeNum(it?.etaMinutes, 0) || 0) > AI_ASSISTANT_FAR_TARGET_SOFT_CAP_MIN);
    const farCandidatesOverHardCap = farCandidates.filter((it) => (safeNum(it?.etaMinutes, 0) || 0) > AI_ASSISTANT_FAR_TARGET_HARD_CAP_MIN);
    const bestNearEval = sameBoroughNearCandidates[0] || crossBoroughNearCandidates[0] || null;

    const allowedFarCandidates = [];
    let farCandidatesRejectedForDistance = 0;
    farCandidates.forEach((farEval) => {
      const decision = isFarTargetStillWorthIt(bestNearEval, farEval, currentSignal, farEval?.currentMetrics);
      if (decision.ok) {
        allowedFarCandidates.push(farEval);
        return;
      }
      farEval.rejectionCode = decision.code || "far_target_not_worth_time";
      farEval.rejectionReasonText = decision.reason || "Far target is not worth the time";
      if (["closer_strong_target_available", "same_borough_target_preferred", "target_too_far_for_edge", "far_target_not_worth_time"].includes(farEval.rejectionCode)) {
        farCandidatesRejectedForDistance += 1;
      }
    });
    const bestSameBoroughNear = sameBoroughNearCandidates[0] || null;
    const bestCrossBoroughNear = crossBoroughNearCandidates[0] || null;
    const bestFarAllowed = allowedFarCandidates.sort(sortPracticalTargetOrder)[0] || null;
    let bestWorthwhileTarget = bestSameBoroughNear || bestCrossBoroughNear || bestFarAllowed || null;
    const bestAdjacentStrongTarget = findAdjacentStrongNearbyTarget(currentSignal, worthwhile);
    if (bestAdjacentStrongTarget && shouldAdjacentStrongTargetDominate(bestAdjacentStrongTarget, bestWorthwhileTarget, currentSignal)) {
      bestWorthwhileTarget = bestAdjacentStrongTarget;
      bestWorthwhileTarget.preferredReasonCode = "adjacent_strong_zone_preferred";
      bestWorthwhileTarget.preferredReasonText = "Closer strong nearby zone makes more sense";
    }

    const bestRejectedTarget =
      sorted.find((it) => !!it.rejectionCode)
      || sorted.find((it) => !it.isWorthMoving || !it.viability?.viable)
      || sorted[0]
      || null;
    if (bestRejectedTarget && !bestRejectedTarget.rejectionCode && bestRejectedTarget.isWorthMoving === false) {
      bestRejectedTarget.rejectionCode = "far_target_not_worth_time";
      bestRejectedTarget.rejectionReasonText = "Far target is not worth the time";
    }
    return {
      bestWorthwhileTarget,
      bestRejectedTarget,
      bestNearEval,
      sameBoroughNearCandidates,
      crossBoroughNearCandidates,
      farCandidatesOverSoftCap,
      farCandidatesOverHardCap,
      farCandidateCount: farCandidates.length,
      farCandidatesRejectedForDistance,
      chosenTargetGroup: bestWorthwhileTarget?.preferredReasonCode === "adjacent_strong_zone_preferred"
        ? "adjacent_strong_near"
        : (bestSameBoroughNear ? "same_borough_near" : (bestCrossBoroughNear ? "near" : (bestFarAllowed ? "far_exception" : "none"))),
      chosenTargetReasoningMode: bestWorthwhileTarget?.preferredReasonCode === "adjacent_strong_zone_preferred"
        ? "adjacent_strong_zone_preferred"
        : (bestSameBoroughNear || bestCrossBoroughNear
        ? "practical_near_preference"
        : (bestFarAllowed ? "far_target_exception" : "stay_not_worth_moving")),
    };
  }

  function deriveStayReasonText(currentSignal, currentMetrics, currentTravelMetrics, bestRejectedTarget) {
    const currentRating = safeNum(currentSignal?.visibleRating, 0) || 0;
    const holds = !!currentMetrics?.stayHoldsAfterArrival && (safeNum(currentTravelMetrics?.travelWindowMinRating, 0) || 0) >= 50;
    if (holds && currentRating >= 56) return { reasonCode: "good_zone_now", reasonText: "Good zone right now" };
    if (holds || currentRating >= 48) return { reasonCode: "decent_rating_zone", reasonText: "Decent area for now" };
    const rejectedEta = safeNum(bestRejectedTarget?.etaMinutes, Infinity) || Infinity;
    if (Number.isFinite(rejectedEta) && rejectedEta > AI_ASSISTANT_NEAR_TARGET_MAX_ETA_MIN) {
      return { reasonCode: "moving_not_worth_it", reasonText: "Other areas are too far right now" };
    }
    return { reasonCode: "nearby_options_not_strong", reasonText: "Nearby options not strong enough yet" };
  }

  function hasStrongTrapLanguageEvidence() {
    const composite = safeNum(state.trapCompositeScore, 0) || 0;
    const pickupCount = safeNum(state.sameZonePickupCountSinceEntry, 0) || 0;
    const minsInZone = dwellMins();
    const movementWeak = (safeNum(state.trapMovementScore, 0) || 0) >= 1;
    const continuationWeak = (safeNum(state.activeStableFeatureSignal?.continuationRaw, 1) || 1) <= 0.45;
    const stayWeak = (safeNum(state.stayWindowAvgRating, 0) || 0) < 49;
    const hasEscape = !!state.trapEscapeTarget?.candidateSignal;
    const earningsHit = (safeNum(state.stayWindowAvgRating, 0) || 0) < 47;
    return composite >= 7
      && (pickupCount >= 2 || (minsInZone >= 12 && movementWeak && continuationWeak) || (minsInZone >= 14 && stayWeak))
      && (hasEscape || earningsHit);
  }

  function shouldThrottleKind(kind) {
    const now = Date.now();
    if (kind === "trap") return now < ((safeNum(state.lastTrapMessageAtTs, 0) || 0) + AI_ASSISTANT_TRAP_MESSAGE_COOLDOWN_MS);
    if (kind === "stay") return now < ((safeNum(state.lastStayMessageAtTs, 0) || 0) + AI_ASSISTANT_STAY_MESSAGE_COOLDOWN_MS);
    if (kind === "move") return now < ((safeNum(state.lastMoveMessageAtTs, 0) || 0) + AI_ASSISTANT_MOVE_MESSAGE_COOLDOWN_MS);
    return false;
  }

  function deriveNoWasteStayDecision(currentSignal, bestWorthwhileTarget, bestRejectedTarget, currentMetrics, currentTravelMetrics) {
    if (bestWorthwhileTarget) return null;
    if (bestRejectedTarget && (safeNum(bestRejectedTarget?.netMoveEdge, -Infinity) || -Infinity) < (safeNum(bestRejectedTarget?.moveWorthThreshold, Infinity) || Infinity)) {
      const stay = deriveStayReasonText(currentSignal, currentMetrics, currentTravelMetrics, bestRejectedTarget);
      return { actionCode: "STAY", reasonCode: stay.reasonCode, reasonText: stay.reasonText, worthMoving: false };
    }
    if (!bestRejectedTarget?.viability?.viable && ["trap_at_arrival", "slow_at_arrival", "saturation_at_arrival", "target_chasey", "long_eta_no_hold"].includes(bestRejectedTarget?.viability?.viabilityRejectCode)) {
      return { actionCode: "STAY", reasonCode: "target_weak_on_arrival", reasonText: "Weak when you get there", worthMoving: false };
    }
    const stay = deriveStayReasonText(currentSignal, currentMetrics, currentTravelMetrics, bestRejectedTarget);
    return { actionCode: "STAY", reasonCode: stay.reasonCode, reasonText: stay.reasonText, worthMoving: false };
  }

  function deriveAssistantDataQuality(currentPoints, targetPoints, outlookStatus, currentRequestKey) {
    const currentPointsCount = Array.isArray(currentPoints) ? currentPoints.length : 0;
    const targetPointsCount = Array.isArray(targetPoints) ? targetPoints.length : 0;
    const hasCurrent = currentPointsCount >= 1;
    const hasStrongCurrent = currentPointsCount >= 2;
    const sparseTarget = targetPointsCount > 0 && targetPointsCount < 2;
    const sameKeyCached = !!currentRequestKey
      && state.outlookCache.has(currentRequestKey)
      && state.lastSuccessfulOutlookKey === currentRequestKey;
    const hasRecentSuccessfulOutlook = sameKeyCached || !!(state.lastSuccessfulOutlookKey && state.lastSuccessfulOutlookAt > 0);
    const loadingFromCache = outlookStatus === "loading" && sameKeyCached;
    const hasUsableOutlook = outlookStatus === "ready" || sameKeyCached;
    const noSuccessfulForCurrentKey = !!currentRequestKey && state.lastSuccessfulOutlookKey !== currentRequestKey;

    let dataQualityMode = "degraded";
    let dataQualityReason = "Checking more data.";
    if (!hasCurrent || outlookStatus === "error" || noSuccessfulForCurrentKey) {
      dataQualityMode = "degraded";
      dataQualityReason = outlookStatus === "error"
        ? "Outlook temporarily unavailable."
        : "Checking more data.";
    } else if (hasStrongCurrent && hasUsableOutlook && !loadingFromCache && !sparseTarget) {
      dataQualityMode = "full";
      dataQualityReason = "Outlook and current-zone signal are complete.";
    } else {
      dataQualityMode = "partial";
      dataQualityReason = loadingFromCache
        ? "Using cached outlook while refreshing."
        : "Outlook is partial; using conservative guidance.";
    }

    return {
      dataQualityMode,
      dataQualityLabel: dataQualityMode,
      dataQualityReason,
      currentPointsCount,
      targetPointsCount,
      hasRecentSuccessfulOutlook,
      isUsingCachedOutlook: sameKeyCached,
      isPartialOutlook: dataQualityMode === "partial",
      canTrustFarMoves: dataQualityMode === "full",
    };
  }

  function resolvePreviewTargetSignal(previewTargetLike) {
    if (!previewTargetLike) return null;
    if (previewTargetLike.locationId) return previewTargetLike;
    if (previewTargetLike.candidateSignal) return previewTargetLike.candidateSignal;
    return null;
  }

  function shouldReuseLastGoodRecommendation(currentZoneId, currentFrameTime, dataQualityMode) {
    if (!currentZoneId || !currentFrameTime) return false;
    if (!(dataQualityMode === "partial" || dataQualityMode === "degraded")) return false;
    if (!state.lastGoodRecommendationPayload) return false;
    if (!state.lastGoodRecommendationSavedAt) return false;
    if (String(currentZoneId) !== String(state.lastGoodRecommendationZoneId || "")) return false;
    if ((Date.now() - state.lastGoodRecommendationSavedAt) > 90000) return false;
    const frameMs = Date.parse(String(currentFrameTime || ""));
    const cachedFrameMs = Date.parse(String(state.lastGoodRecommendationFrameTime || ""));
    if (Number.isFinite(frameMs) && Number.isFinite(cachedFrameMs) && frameMs < (cachedFrameMs - 60000)) return false;
    return true;
  }

  function deriveSafeFallbackDecision(currentSignal, dataQualityMode, bestNearEval) {
    const currentRating = safeNum(currentSignal?.visibleRating, 0) || 0;
    const nearEval = bestNearEval || null;
    const nearEta = safeNum(nearEval?.etaMinutes, Infinity) || Infinity;
    const nearEdge = safeNum(nearEval?.netMoveEdge, -Infinity) || -Infinity;
    const nearThreshold = safeNum(nearEval?.moveWorthThreshold, Infinity) || Infinity;
    const nearBeatsBy = nearEdge - nearThreshold;
    const sameBorough = !!nearEval?.isSameBorough;
    const obviouslySuperior = (safeNum(nearEval?.targetPaybackMetrics?.paybackAvgRating, 0) || 0) >= (currentRating + 6);
    const strongNearTarget = !!nearEval
      && !!nearEval?.viability?.viable
      && nearEta <= 12
      && nearBeatsBy >= 2.5
      && (sameBorough || obviouslySuperior);

    if (dataQualityMode === "degraded" && !strongNearTarget) {
      if (currentRating >= 58) {
        return { actionCode: "STAY", reasonCode: "good_zone_now", reasonText: "Good zone right now", worthMoving: false };
      }
      if (currentRating >= 45) {
        return { actionCode: "STAY", reasonCode: "decent_rating_zone", reasonText: "Decent area for now", worthMoving: false };
      }
      return { actionCode: "MONITOR", reasonCode: "checking_outlook", reasonText: "Checking more data.", worthMoving: false };
    }
    if (dataQualityMode === "partial" && !strongNearTarget && currentRating >= 45) {
      return { actionCode: "STAY", reasonCode: "moving_not_worth_it", reasonText: "Other areas are too far right now", worthMoving: false };
    }
    if (dataQualityMode === "partial" && strongNearTarget) {
      return { actionCode: "MOVE_SOON", reasonCode: "near_target_clear_edge", reasonText: "Better nearby area is ready", worthMoving: true };
    }
    return null;
  }

  function deriveAssistantRecommendationReason(currentSignal, currentMetrics, bestWorthwhileTarget, bestRejectedTarget, currentTravelMetrics) {
    if (!currentSignal?.locationId) {
      return { actionCode: "MONITOR", reasonCode: "collecting_context", reasonText: "Collecting more context.", worthMoving: false };
    }
    if (bestWorthwhileTarget) {
      if (String(bestWorthwhileTarget?.preferredReasonCode || "").trim() === "adjacent_strong_zone_preferred") {
        return { actionCode: "MOVE_SOON", reasonCode: "near_target_clear_edge", reasonText: "Better nearby area is ready", worthMoving: true };
      }
      const currentCls = classifyAssistantSignal(currentSignal || {});
      if (currentCls?.shortTrap || currentMetrics?.stayTrapAtArrival) {
        const strongTrapEvidence = hasStrongTrapLanguageEvidence();
        if (strongTrapEvidence) {
          return { actionCode: "MOVE_SOON", reasonCode: "low_trip_trap_risk", reasonText: "Trap risk rising", worthMoving: true };
        }
        return { actionCode: "MOVE_SOON", reasonCode: "zone_about_to_cool_off", reasonText: "Area may cool off", worthMoving: true };
      }
      if (currentMetrics?.stayWeakensSoon) {
        if (currentMetrics?.stayWindowTrendDelta <= -5 && bestWorthwhileTarget?.targetMetrics?.targetImprovesSoon && bestWorthwhileTarget?.targetMetrics?.targetHoldsAfterArrival) {
          return { actionCode: "LEAVE_NOW", reasonCode: "nearby_zone_about_to_get_busier", reasonText: "Zone nearby about to get busier", worthMoving: true };
        }
        return { actionCode: "MOVE_SOON", reasonCode: "zone_about_to_cool_off", reasonText: "Zone about to cool off", worthMoving: true };
      }
      if ((safeNum(bestWorthwhileTarget?.targetPaybackMetrics?.paybackAvgRating, 0) || 0) >= ((safeNum(bestWorthwhileTarget?.targetMetrics?.targetArrivalProjectedRating, 0) || 0) + 2)) {
        return { actionCode: "MOVE_SOON", reasonCode: "stronger_when_you_arrive", reasonText: "Stronger when you arrive", worthMoving: true };
      }
      return { actionCode: "MOVE_SOON", reasonCode: "worth_the_drive_time", reasonText: "Worth the drive time", worthMoving: true };
    }
    return deriveNoWasteStayDecision(currentSignal, bestWorthwhileTarget, bestRejectedTarget, currentMetrics, currentTravelMetrics);
  }

  function deriveAssistantRecommendationConfidence(bestEval, currentSignal) {
    const evalObj = bestEval || {};
    const margin = (safeNum(evalObj?.netMoveEdge, 0) || 0) - (safeNum(evalObj?.moveWorthThreshold, 0) || 0);
    const positiveMarginBoost = Math.max(0, Math.min(20, margin * 3.5));
    const etaMinutes = safeNum(evalObj?.etaMinutes, safeNum(evalObj?.candidateSignal?.etaMinutes, 0)) || 0;
    const longEtaPenalty = Math.max(0, Math.min(15, (etaMinutes - 5) * 1.2));
    const confidencePenalty = safeNum(evalObj?.confidencePenalty?.confidencePenalty, 0) || 0;
    const currentCls = classifyAssistantSignal(currentSignal || {});
    const currentWeakBoost = (currentCls?.shortTrap || currentCls?.slowNow || (safeNum(currentSignal?.churnPressure, 0) || 0) >= 0.58) ? 8 : 0;
    let score = 50;
    score += positiveMarginBoost;
    if (evalObj?.viability?.viable) score += 10;
    if (evalObj?.targetPaybackMetrics?.paybackHolds) score += 8;
    score -= longEtaPenalty;
    score -= (confidencePenalty * 1.5);
    score += currentWeakBoost;
    score = Math.max(0, Math.min(100, Math.round(score)));
    const level = score >= 75 ? "high" : (score >= 50 ? "medium" : "low");
    return { recommendationConfidenceScore: score, recommendationConfidenceLevel: level };
  }

  function deriveProposedRecommendation(currentSignal, bestWorthwhileTarget, bestRejectedTarget, currentMetrics, currentTravelMetrics, safeOverrideDecision = null) {
    const selected = bestWorthwhileTarget || bestRejectedTarget || null;
    const baseDecision = safeOverrideDecision || deriveAssistantRecommendationReason(
      currentSignal,
      currentMetrics || {},
      bestWorthwhileTarget,
      bestRejectedTarget,
      currentTravelMetrics || {}
    );
    const confidence = deriveAssistantRecommendationConfidence(selected, currentSignal);
    return {
      actionCode: baseDecision.actionCode,
      reasonCode: baseDecision.reasonCode,
      reasonText: baseDecision.reasonText,
      moveTarget: bestWorthwhileTarget
        ? {
            ...bestWorthwhileTarget.candidateSignal,
            etaMinutes: bestWorthwhileTarget.etaMinutes,
            distanceMiles: bestWorthwhileTarget.distanceMiles,
            targetArrivalProjectedRating: bestWorthwhileTarget.targetMetrics?.targetArrivalProjectedRating,
            targetPaybackAvgRating: bestWorthwhileTarget.targetPaybackMetrics?.paybackAvgRating,
            totalDeadheadCost: bestWorthwhileTarget.deadheadCost?.totalDeadheadCost,
            moveConfidencePenalty: bestWorthwhileTarget.confidencePenalty?.confidencePenalty,
            netMoveEdge: bestWorthwhileTarget.netMoveEdge,
            moveWorthThreshold: bestWorthwhileTarget.moveWorthThreshold,
            targetViableOnArrival: bestWorthwhileTarget.viability?.viable,
          }
        : null,
      netMoveEdge: selected?.netMoveEdge ?? null,
      moveWorthThreshold: selected?.moveWorthThreshold ?? null,
      recommendationWorthMoving: !!baseDecision.worthMoving,
      recommendationConfidenceScore: confidence.recommendationConfidenceScore,
      recommendationConfidenceLevel: confidence.recommendationConfidenceLevel,
    };
  }

  function buildAssistantRecommendationProposalKey(proposal) {
    const actionCode = String(proposal?.actionCode || "MONITOR");
    const reasonCode = String(proposal?.reasonCode || "unknown");
    const targetId = String(proposal?.moveTarget?.locationId || "none");
    return `${actionCode}|${reasonCode}|${targetId}`;
  }

  function isMoveAction(actionCode) {
    return actionCode === "MOVE_SOON" || actionCode === "LEAVE_NOW";
  }

  function shouldAssistantBypassStabilityDelay(proposal, currentSignal) {
    if (!proposal || proposal.actionCode !== "LEAVE_NOW") return false;
    const urgentReason = ["low_trip_trap_risk", "nearby_zone_about_to_get_busier", "zone_about_to_die"].includes(proposal.reasonCode);
    if (!urgentReason) return false;
    const netMoveEdge = safeNum(proposal.netMoveEdge, -Infinity) || -Infinity;
    const threshold = safeNum(proposal.moveWorthThreshold, Infinity) || Infinity;
    if (netMoveEdge < (threshold + AI_ASSISTANT_EMERGENCY_BYPASS_EDGE)) return false;
    return !!currentSignal?.locationId;
  }

  function isImmediateSafeDegradedStayPromotion(proposal) {
    if (state.dataQualityMode !== "degraded") return false;
    if (state.committedActionCode !== "MONITOR") return false;
    if (!proposal || proposal.actionCode !== "STAY") return false;
    if (proposal.moveTarget) return false;
    return ["good_zone_now", "decent_rating_zone", "moving_not_worth_it"].includes(String(proposal.reasonCode || "").trim());
  }

  function isImmediateCountdownPromotion(proposal, nowTs) {
    if (!state.countdownDeadlineTs) return false;
    if (nowTs < state.countdownDeadlineTs) return false;
    if (!proposal) return false;
    if (!["MOVE_SOON", "LEAVE_NOW"].includes(String(proposal.actionCode || ""))) return false;
    if (!proposal.moveTarget || !state.countdownTarget) return false;
    return String(proposal.moveTarget.locationId || "") === String(state.countdownTarget.locationId || "");
  }

  function commitAssistantRecommendation(proposal, nowTs) {
    state.committedActionCode = proposal.actionCode;
    state.committedReasonCode = proposal.reasonCode;
    state.committedReasonText = proposal.reasonText;
    state.committedMoveTarget = proposal.moveTarget || null;
    state.committedSinceTs = nowTs;
    state.recommendationSwitchCooldownUntilTs = nowTs + AI_ASSISTANT_RECOMMENDATION_SWITCH_COOLDOWN_MS;
    state.recommendationMinHoldUntilTs = nowTs + AI_ASSISTANT_RECOMMENDATION_MIN_HOLD_MS;
    if (proposal.moveTarget?.locationId) {
      const targetId = String(proposal.moveTarget.locationId);
      if (state.recommendationStickyTargetId !== targetId) {
        state.recommendationStickyTargetId = targetId;
        state.recommendationStickyTargetSinceTs = nowTs;
      }
    } else {
      state.recommendationStickyTargetId = null;
      state.recommendationStickyTargetSinceTs = null;
    }
  }

  function stabilizeAssistantRecommendation(proposal, nowTs) {
    const previousProposedActionCode = state.proposedActionCode;
    const previousProposedReasonCode = state.proposedReasonCode;
    const previousProposedReasonText = state.proposedReasonText;
    const previousProposedMoveTarget = state.proposedMoveTarget;
    const previousProposedNetMoveEdge = state.proposedNetMoveEdge;
    const previousProposedWorthThreshold = state.proposedWorthThreshold;
    const previousProposedSinceTs = state.proposedSinceTs;
    const previousProposedStableHits = safeNum(state.proposedStableHits, 0) || 0;
    const committedProposal = {
      actionCode: state.committedActionCode,
      reasonCode: state.committedReasonCode,
      moveTarget: state.committedMoveTarget,
    };
    const committedKey = buildAssistantRecommendationProposalKey(committedProposal);
    const proposalKey = buildAssistantRecommendationProposalKey(proposal);
    state.stabilityReasonCode = "";
    state.stabilityReasonText = "";

    if (!state.committedActionCode) {
      state.proposedActionCode = proposal.actionCode;
      state.proposedReasonCode = proposal.reasonCode;
      state.proposedReasonText = proposal.reasonText;
      state.proposedMoveTarget = proposal.moveTarget || null;
      state.proposedNetMoveEdge = proposal.netMoveEdge;
      state.proposedWorthThreshold = proposal.moveWorthThreshold;
      state.proposedSinceTs = nowTs;
      state.proposedStableHits = 1;
      commitAssistantRecommendation(proposal, nowTs);
      return;
    }

    if (proposalKey === committedKey) {
      state.committedReasonText = proposal.reasonText;
      state.committedReasonCode = proposal.reasonCode;
      state.committedMoveTarget = proposal.moveTarget || state.committedMoveTarget || null;
      state.proposedActionCode = proposal.actionCode;
      state.proposedReasonCode = proposal.reasonCode;
      state.proposedReasonText = proposal.reasonText || previousProposedReasonText || "";
      state.proposedMoveTarget = proposal.moveTarget || null;
      state.proposedNetMoveEdge = safeNum(proposal.netMoveEdge, previousProposedNetMoveEdge);
      state.proposedWorthThreshold = safeNum(proposal.moveWorthThreshold, previousProposedWorthThreshold);
      state.proposedSinceTs = previousProposedSinceTs ?? nowTs;
      state.proposedStableHits = previousProposedStableHits + 1;
      return;
    }

    const priorProposedKey = buildAssistantRecommendationProposalKey({
      actionCode: previousProposedActionCode,
      reasonCode: previousProposedReasonCode,
      moveTarget: previousProposedMoveTarget,
    });
    if (proposalKey !== priorProposedKey) {
      state.proposedActionCode = proposal.actionCode;
      state.proposedReasonCode = proposal.reasonCode;
      state.proposedReasonText = proposal.reasonText;
      state.proposedMoveTarget = proposal.moveTarget || null;
      state.proposedNetMoveEdge = proposal.netMoveEdge;
      state.proposedWorthThreshold = proposal.moveWorthThreshold;
      state.proposedSinceTs = nowTs;
      state.proposedStableHits = 1;
    } else {
      state.proposedActionCode = proposal.actionCode;
      state.proposedReasonCode = proposal.reasonCode;
      state.proposedReasonText = proposal.reasonText;
      state.proposedMoveTarget = proposal.moveTarget || null;
      state.proposedNetMoveEdge = proposal.netMoveEdge;
      state.proposedWorthThreshold = proposal.moveWorthThreshold;
      state.proposedSinceTs = previousProposedSinceTs ?? nowTs;
      state.proposedStableHits = previousProposedStableHits + 1;
    }

    const isCommittedStay = state.committedActionCode === "STAY" || state.committedActionCode === "STAY_BRIEFLY";
    if (isCommittedStay && isMoveAction(proposal.actionCode)) {
      const required = (safeNum(proposal.moveWorthThreshold, 0) || 0) + AI_ASSISTANT_STAY_TO_MOVE_EXTRA_BUFFER;
      if ((safeNum(proposal.netMoveEdge, -Infinity) || -Infinity) < required) {
        state.stabilityReasonCode = "move_edge_not_far_enough";
        state.stabilityReasonText = "Moving is not clearly worth it yet.";
        return;
      }
    }

    if (isMoveAction(state.committedActionCode) && proposal.actionCode === "STAY") {
      const committedTargetViable = state.committedMoveTarget?.targetViableOnArrival !== false;
      const committedEdge = safeNum(state.committedMoveTarget?.netMoveEdge, 0) || 0;
      const committedThreshold = safeNum(state.committedMoveTarget?.moveWorthThreshold, 0) || 0;
      const allowCancel = !committedTargetViable || committedEdge < (committedThreshold - AI_ASSISTANT_MOVE_TO_STAY_EXTRA_BUFFER) || nowTs >= (safeNum(state.recommendationMinHoldUntilTs, 0) || 0);
      if (!allowCancel) {
        state.stabilityReasonCode = "holding_existing_move";
        state.stabilityReasonText = "Current move target still makes sense.";
        return;
      }
    }

    if (isMoveAction(state.committedActionCode)
      && state.committedMoveTarget?.locationId
      && isMoveAction(proposal.actionCode)
      && proposal.moveTarget?.locationId
      && String(proposal.moveTarget.locationId) !== String(state.committedMoveTarget.locationId)) {
      const currentViable = state.committedMoveTarget?.targetViableOnArrival !== false;
      const currentEdge = safeNum(state.committedMoveTarget?.netMoveEdge, -Infinity) || -Infinity;
      const newEdge = safeNum(proposal.netMoveEdge, -Infinity) || -Infinity;
      if (currentViable && newEdge < (currentEdge + AI_ASSISTANT_TARGET_REPLACE_EDGE_BUFFER)) {
        state.stabilityReasonCode = "current_target_still_better_enough";
        state.stabilityReasonText = "Current target still makes the most sense.";
        return;
      }
    }

    if (isImmediateSafeDegradedStayPromotion(proposal)) {
      commitAssistantRecommendation(proposal, nowTs);
      state.stabilityReasonCode = "safe_degraded_stay_promoted";
      state.stabilityReasonText = "Safe stay fallback promoted immediately.";
      return;
    }

    if (isImmediateCountdownPromotion(proposal, nowTs)) {
      commitAssistantRecommendation(proposal, nowTs);
      state.stabilityReasonCode = "countdown_expired_move_promoted";
      state.stabilityReasonText = "Countdown finished. Move now.";
      return;
    }

    const bypass = shouldAssistantBypassStabilityDelay(proposal, state.activeStableFeatureSignal);
    const stableEnough = (nowTs - (safeNum(state.proposedSinceTs, nowTs) || nowTs)) >= AI_ASSISTANT_PROPOSAL_MIN_STABLE_MS
      && (safeNum(state.proposedStableHits, 0) || 0) >= AI_ASSISTANT_PROPOSAL_MIN_HITS;
    const cooldownReady = nowTs >= (safeNum(state.recommendationSwitchCooldownUntilTs, 0) || 0);
    if (!bypass && (!stableEnough || !cooldownReady)) {
      state.stabilityReasonCode = "proposal_not_stable_yet";
      state.stabilityReasonText = "Waiting to confirm the recommendation.";
      return;
    }
    commitAssistantRecommendation(proposal, nowTs);
  }

  function deriveStableRecommendationReason(committedRecommendation, stabilityReasonCode, stabilityReasonText) {
    if (stabilityReasonCode === "proposal_not_stable_yet" && stabilityReasonText) return "Waiting to confirm the recommendation";
    if (stabilityReasonCode === "move_edge_not_far_enough") return "Other areas are too far right now";
    if (stabilityReasonCode === "holding_existing_move") return "Current target still makes sense";
    if (stabilityReasonCode === "current_target_still_better_enough") return "Current target still makes sense";
    const reasonText = String(committedRecommendation?.reasonText || "").trim();
    return reasonText || "Waiting to confirm the recommendation";
  }

  async function fetchOutlook(frame, locationIds, visibleSource) {
    const frameTime = frameTimeIso(frame);
    const ids = Array.isArray(locationIds) ? locationIds.filter(Boolean) : [];
    if (!frameTime || !ids.length) return null;
    const key = buildOutlookCacheKey(frameTime, ids, visibleSource);
    state.outlookRequestKey = key;
    if (state.outlookCache.has(key)) {
      state.outlookStatus = "ready";
      state.outlookLastErrorCode = "";
      state.outlookLastErrorMessage = "";
      return state.outlookCache.get(key);
    }
    if (state.outlookInFlightKey === key && state.outlookInFlightPromise) {
      return state.outlookInFlightPromise;
    }
    if (state.outlookInFlightPromise && state.outlookInFlightKey && state.outlookInFlightKey !== key && state.outlookAbortController) {
      state.outlookAbortController.abort();
    }
    const ac = new AbortController();
    state.outlookAbortController = ac;
    state.outlookInFlightKey = key;
    state.outlookStatus = "loading";
    state.outlookLastErrorCode = "";
    state.outlookLastErrorMessage = "";
    const apiBase = String(window.API_BASE || window.__TLC_RUNTIME_CONFIG__?.apiBase || "").trim().replace(/\/+$/, "");
    const url = `${apiBase}/assistant/outlook?frame_time=${encodeURIComponent(frameTime)}&location_ids=${encodeURIComponent([...ids].sort().join(","))}`;
    const fetchPromise = (async () => {
      try {
        const data = await (internals.fetchJSON?.(url, { signal: ac.signal }) || fetch(url, { signal: ac.signal }).then((r) => r.json()));
        const payload = data || null;
        state.outlookCache.set(key, payload);
        state.outlookRequestKey = key;
        state.lastSuccessfulOutlookKey = key;
        state.lastSuccessfulOutlookAt = Date.now();
        state.outlookStatus = "ready";
        state.outlookLastErrorCode = "";
        state.outlookLastErrorMessage = "";
        return payload;
      } catch (err) {
        if (err?.name === "AbortError") {
          const sameKeyStillActive = state.outlookInFlightKey === key;
          state.outlookStatus = sameKeyStillActive ? "loading" : "idle";
          if (sameKeyStillActive) {
            state.outlookLastErrorCode = "";
            state.outlookLastErrorMessage = "";
          } else {
            state.outlookLastErrorCode = "aborted";
            state.outlookLastErrorMessage = "Outlook request restarted.";
          }
          return null;
        }
        state.outlookStatus = "error";
        state.outlookLastErrorCode = String(err?.status || err?.name || "fetch_failed");
        state.outlookLastErrorMessage = String(err?.message || "Outlook request failed.");
        return null;
      } finally {
        if (state.outlookInFlightPromise === fetchPromise) {
          state.outlookInFlightKey = "";
          state.outlookInFlightPromise = null;
          if (state.outlookAbortController === ac) state.outlookAbortController = null;
        }
      }
    })();
    state.outlookInFlightPromise = fetchPromise;
    try {
      return await fetchPromise;
    } catch (_err) {
      return null;
    }
  }

  function normalizeServerGuidance(payload) {
    if (!payload || typeof payload !== "object") return null;
    const actionRaw = String(payload.action || "").trim().toLowerCase();
    const actionMap = {
      hold: "HOLD",
      micro_reposition: "MICRO_REPOSITION",
      move_nearby: "MOVE_NEARBY",
      wait_dispatch: "WAIT_DISPATCH",
    };
    const actionCode = actionMap[actionRaw] || "";
    if (!actionCode) return null;
    if (typeof payload.message !== "string") return null;
    const targetZone = (payload.target_zone && typeof payload.target_zone === "object") ? payload.target_zone : null;
    const currentZone = (payload.current_zone && typeof payload.current_zone === "object") ? payload.current_zone : null;
    if (payload.reason_codes != null && !Array.isArray(payload.reason_codes)) return null;
    if (payload.confidence != null && !Number.isFinite(Number(payload.confidence))) return null;
    return {
      actionCode,
      confidence: safeNum(payload.confidence),
      message: String(payload.message || "").trim(),
      reasonCodes: Array.isArray(payload.reason_codes) ? payload.reason_codes.map((it) => String(it || "").trim()).filter(Boolean) : [],
      currentZone: currentZone ? {
        id: String(currentZone.id || currentZone.location_id || currentZone.locationId || "").trim(),
        name: String(currentZone.name || currentZone.zone_name || currentZone.zoneName || "").trim(),
      } : null,
      targetZone: targetZone ? {
        id: String(targetZone.id || targetZone.location_id || targetZone.locationId || "").trim(),
        name: String(targetZone.name || targetZone.zone_name || targetZone.zoneName || "").trim(),
        centerLat: safeNum(targetZone.center_lat ?? targetZone.centerLat ?? targetZone.lat),
        centerLng: safeNum(targetZone.center_lng ?? targetZone.centerLng ?? targetZone.lng),
      } : null,
      triplessMinutes: safeNum(payload.tripless_minutes),
      stationaryMinutes: safeNum(payload.stationary_minutes),
      movementMinutes: safeNum(payload.movement_minutes),
      dispatchUncertainty: safeNum(payload.dispatch_uncertainty),
      moveCooldownUntilTs: safeNum(payload.move_cooldown_until_unix),
      holdUntilTs: safeNum(payload.hold_until_unix),
    };
  }

  async function fetchGuidance(frame, userLocation, modeFlags) {
    const frameTime = frameTimeIso(frame);
    const key = buildGuidanceCacheKey(frameTime, userLocation, modeFlags);
    state.lastGuidanceRequestKey = key;
    if (!frameTime || !key) return null;
    if (state.guidanceCache.has(key)) {
      state.guidanceStatus = "ready";
      state.guidanceLastErrorCode = "";
      state.guidanceLastErrorMessage = "";
      return state.guidanceCache.get(key);
    }
    if (state.guidanceInFlightKey === key && state.guidanceInFlightPromise) return state.guidanceInFlightPromise;
    if (state.guidanceInFlightPromise && state.guidanceInFlightKey && state.guidanceInFlightKey !== key && state.guidanceAbortController) {
      state.guidanceAbortController.abort();
    }
    const ac = new AbortController();
    state.guidanceAbortController = ac;
    state.guidanceInFlightKey = key;
    state.guidanceStatus = "loading";
    state.guidanceLastErrorCode = "";
    state.guidanceLastErrorMessage = "";
    const apiBase = String(window.API_BASE || window.__TLC_RUNTIME_CONFIG__?.apiBase || "").trim().replace(/\/+$/, "");
    const params = new URLSearchParams({
      frame_time: frameTime,
      lat: String(userLocation.lat),
      lng: String(userLocation.lng),
      staten_island_mode: modeFlags?.statenIslandMode ? "1" : "0",
      bronx_wash_heights_mode: modeFlags?.bronxWashHeightsMode ? "1" : "0",
      queens_mode: modeFlags?.queensMode ? "1" : "0",
      brooklyn_mode: modeFlags?.brooklynMode ? "1" : "0",
    });
    const url = `${apiBase}/assistant/guidance?${params.toString()}`;
    const fetchPromise = (async () => {
      try {
        const resp = await fetch(url, { signal: ac.signal, credentials: "include" });
        if (resp.status === 401 || resp.status === 403) {
          state.guidanceStatus = "error";
          state.guidanceLastErrorCode = String(resp.status);
          state.guidanceLastErrorMessage = "Guidance requires signed-in account context.";
          return null;
        }
        if (!resp.ok) {
          state.guidanceStatus = "error";
          state.guidanceLastErrorCode = String(resp.status || "fetch_failed");
          state.guidanceLastErrorMessage = `Guidance request failed (${resp.status}).`;
          return null;
        }
        const data = await resp.json();
        const payload = data || null;
        const normalized = normalizeServerGuidance(payload);
        if (!normalized) {
          state.guidanceStatus = "error";
          state.guidanceLastErrorCode = "malformed_payload";
          state.guidanceLastErrorMessage = "Guidance payload was malformed; using local guidance.";
          return null;
        }
        state.guidanceCache.set(key, payload);
        trimMapCache(state.guidanceCache, 18);
        state.lastSuccessfulGuidanceKey = key;
        state.lastSuccessfulGuidanceAt = Date.now();
        state.guidanceStatus = "ready";
        state.guidanceLastErrorCode = "";
        state.guidanceLastErrorMessage = "";
        return payload;
      } catch (err) {
        if (err?.name === "AbortError") return null;
        state.guidanceStatus = "error";
        state.guidanceLastErrorCode = String(err?.status || err?.name || "fetch_failed");
        state.guidanceLastErrorMessage = String(err?.message || "Guidance request failed.");
        return null;
      } finally {
        if (state.guidanceInFlightPromise === fetchPromise) {
          state.guidanceInFlightKey = "";
          state.guidanceInFlightPromise = null;
          if (state.guidanceAbortController === ac) state.guidanceAbortController = null;
        }
      }
    })();
    state.guidanceInFlightPromise = fetchPromise;
    try {
      return await fetchPromise;
    } catch (_err) {
      return null;
    }
  }

  function buildOutlookPointsByLocation(outlook) {
    const map = {};
    const byLocationPayloads = [outlook?.zones_by_location_id, outlook?.by_location_id];
    for (const byLocation of byLocationPayloads) {
      if (!byLocation || typeof byLocation !== "object" || Array.isArray(byLocation)) continue;
      for (const [idRaw, zoneEntry] of Object.entries(byLocation)) {
        const id = String(idRaw || zoneEntry?.location_id || zoneEntry?.locationId || "").trim();
        if (!id) continue;
        if (Array.isArray(zoneEntry)) {
          map[id] = zoneEntry;
          continue;
        }
        map[id] = Array.isArray(zoneEntry?.points)
          ? zoneEntry.points
          : (Array.isArray(zoneEntry?.horizon_points) ? zoneEntry.horizon_points : (map[id] || []));
      }
    }
    const listPayloads = [outlook?.zones, outlook?.items];
    for (const listPayload of listPayloads) {
      if (!Array.isArray(listPayload)) continue;
      for (const zoneEntry of listPayload) {
        const id = String(zoneEntry?.location_id || zoneEntry?.locationId || "").trim();
        if (!id) continue;
        if (Array.isArray(zoneEntry)) {
          map[id] = zoneEntry;
          continue;
        }
        map[id] = Array.isArray(zoneEntry?.points)
          ? zoneEntry.points
          : (Array.isArray(zoneEntry?.horizon_points) ? zoneEntry.horizon_points : (map[id] || []));
      }
    }
    return map;
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

  function friendlyReasonFromCode(reasonCode, fallbackText = "") {
    const map = {
      good_zone_now: "Good zone right now",
      decent_rating_zone: "Decent area for now",
      moving_not_worth_it: "Other areas are too far right now",
      low_trip_trap_risk: "Trap risk rising",
      zone_about_to_cool_off: "Area may cool off",
      nearby_zone_about_to_get_busier: "Nearby area is getting better",
      worth_the_drive_time: "Worth the drive right now",
      stronger_when_you_arrive: "Better when you get there",
      target_weak_on_arrival: "Weak when you get there",
      checking_outlook: "Checking more data",
      collecting_context: "Waiting for a clearer signal",
      current_zone_holds: "This area still looks better right now",
      near_target_clear_edge: "Better nearby area is ready",
      nearby_options_not_strong: "Nearby options not strong enough yet",
    };
    return map[String(reasonCode || "").trim()] || fallbackText;
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
      .replace(/Nearby zone has better score; prepare to move\.?/gi, "Move soon if no trip.")
      .replace(/Current zone is acceptable; keep monitoring\.?/gi, "Mixed signals.")
      .replace(/Waiting for stable zone\.?/gi, "Learning this area.")
      .replace(/Outlook unavailable\.?/gi, "Checking more data.")
      .replace(/Checking outlook\.?/gi, "Checking more data.")
      .replace(/Collecting more context\.?/gi, "Learning this area.")
      .replace(/Decent rating zone\.?/gi, "Decent area for now.")
      .replace(/Moving is not worth the time\.?/gi, "Other areas are too far right now.")
      .replace(/Target weak by the time you get there\.?/gi, "Weak when you get there.")
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

  function isCompactLaneMode() {
    return document.getElementById("aiAssistantDock")?.dataset?.aiCompactLane === "1";
  }

  function isSafeDegradedStayFallback() {
    if (state.dataQualityMode !== "degraded") return false;
    if (state.finalActionCode !== "STAY") return false;
    if (state.assistantMoveTarget) return false;
    return ["good_zone_now", "decent_rating_zone", "moving_not_worth_it"].includes(String(state.recommendationReasonCode || "").trim());
  }

  function safeDegradedStayPrimaryLine() {
    const reasonCode = String(state.recommendationReasonCode || "").trim();
    if (reasonCode === "good_zone_now") return "Stay • Good zone right now";
    if (reasonCode === "decent_rating_zone") return "Stay • Decent area for now";
    if (reasonCode === "moving_not_worth_it") return "Stay • Other areas are too far right now";
    if (reasonCode === "nearby_options_not_strong") return "Stay briefly • Nearby options not strong enough yet";
    const reasonText = state.recommendationReasonText || state.committedReasonText || state.finalActionReason;
    return `Stay • ${humanizeAssistantReason(reasonText)}`;
  }

  function resetCountdownCoachState() {
    state.countdownEligible = false;
    state.countdownActive = false;
    state.countdownStartTs = null;
    state.countdownDeadlineTs = null;
    state.countdownMinutesRemaining = null;
    state.countdownReasonCode = "";
    state.countdownReasonText = "";
    state.countdownTarget = null;
    state.countdownHoldWindowReason = "";
    state.countdownEscalationLevel = 0;
  }

  function hasPickupSinceCurrentZoneEntry() {
    if (!state.lastPickupRecordedAtMs || !state.activeStableZoneEnterTs) return false;
    if (state.lastPickupRecordedAtMs < state.activeStableZoneEnterTs) return false;
    if (state.lastPickupRecordedZoneId && state.activeStableZoneId
      && String(state.lastPickupRecordedZoneId) !== String(state.activeStableZoneId)) {
      return false;
    }
    return true;
  }

  function sampleRecentSameZoneMovement(currentZoneId, currentUserLocation) {
    if (!currentZoneId || !currentUserLocation) return;
    const nextSample = {
      lat: safeNum(currentUserLocation?.lat),
      lng: safeNum(currentUserLocation?.lng),
      ts: safeNum(currentUserLocation?.ts, Date.now()) || Date.now(),
    };
    if (!Number.isFinite(nextSample.lat) || !Number.isFinite(nextSample.lng)) return;
    const samples = Array.isArray(state.recentZoneMovementSamples) ? state.recentZoneMovementSamples : [];
    const prev = samples.length ? samples[samples.length - 1] : null;
    if (prev) {
      const deltaMs = nextSample.ts - (safeNum(prev.ts, nextSample.ts) || nextSample.ts);
      if (deltaMs < 20000) return;
    }
    samples.push(nextSample);
    const keepAfter = Date.now() - (18 * 60000);
    state.recentZoneMovementSamples = samples.filter((s) => (safeNum(s?.ts, 0) || 0) >= keepAfter).slice(-24);
  }

  function isMeaningfulRepositionInSameZone(currentZoneId, currentUserLocation) {
    if (!currentZoneId || !currentUserLocation) return false;
    if (!state.activeStableZoneId || String(state.activeStableZoneId) !== String(currentZoneId)) return false;
    const baseAnchor = state.stableZoneEntryUserLocation;
    if (!baseAnchor || !Number.isFinite(baseAnchor.lat) || !Number.isFinite(baseAnchor.lng)) return false;
    const nowMs = Date.now();
    const elapsedSinceLast = state.lastMeaningfulRepositionAtMs
      ? nowMs - state.lastMeaningfulRepositionAtMs
      : Infinity;
    if (elapsedSinceLast < AI_ASSISTANT_MEANINGFUL_REPOSITION_MIN_MS) return false;
    const distanceFromAnchor = internals.haversineMiles?.(
      { lat: baseAnchor.lat, lng: baseAnchor.lng },
      { lat: currentUserLocation.lat, lng: currentUserLocation.lng }
    ) || 0;
    if (!Number.isFinite(distanceFromAnchor) || distanceFromAnchor < AI_ASSISTANT_MEANINGFUL_REPOSITION_MILES) return false;
    state.lastMeaningfulRepositionAtMs = nowMs;
    state.lastMeaningfulRepositionDistanceMiles = distanceFromAnchor;
    state.stableZoneEntryUserLocation = {
      lat: currentUserLocation.lat,
      lng: currentUserLocation.lng,
      ts: safeNum(currentUserLocation.ts, nowMs) || nowMs,
    };
    state.sameZonePickupCountRolling = Math.max(0, (safeNum(state.sameZonePickupCountRolling, 0) || 0) - 1);
    state.trapTimeScore = Math.max(0, (safeNum(state.trapTimeScore, 0) || 0) - 0.75);
    state.trapMovementScore = Math.max(0, (safeNum(state.trapMovementScore, 0) || 0) - 1.5);
    return true;
  }

  function deriveTrapCoachState(currentSignal, currentMetrics, bestWorthwhileTarget) {
    const minsInZone = dwellMins();
    const sameZonePickups = safeNum(state.sameZonePickupCountSinceEntry, 0) || 0;
    const rollingPickups = safeNum(state.sameZonePickupCountRolling, 0) || 0;
    const nowMs = Date.now();
    const lastRepositionAgoMs = state.lastMeaningfulRepositionAtMs ? (nowMs - state.lastMeaningfulRepositionAtMs) : Infinity;
    const repositionedRecently = lastRepositionAgoMs <= (8 * 60000);
    const recentSamples = Array.isArray(state.recentZoneMovementSamples) ? state.recentZoneMovementSamples : [];
    const firstSample = recentSamples.length ? recentSamples[0] : null;
    const lastSample = recentSamples.length ? recentSamples[recentSamples.length - 1] : null;
    const sampleDistanceMiles = (firstSample && lastSample)
      ? (internals.haversineMiles?.({ lat: firstSample.lat, lng: firstSample.lng }, { lat: lastSample.lat, lng: lastSample.lng }) || 0)
      : 0;

    let trapTimeScore = 0;
    if (minsInZone >= 5) trapTimeScore += 1;
    if (minsInZone >= 8) trapTimeScore += 1;
    if (minsInZone >= 12) trapTimeScore += 1;
    if (minsInZone >= 15) trapTimeScore += 1;

    let trapPickupScore = 0;
    if (sameZonePickups >= 2) trapPickupScore += 1.5;
    if (sameZonePickups >= 3) trapPickupScore += 1.5;
    if (rollingPickups >= 4) trapPickupScore += 0.75;

    let trapMovementScore = 0;
    if (minsInZone >= 8 && sampleDistanceMiles < 0.4) trapMovementScore += 1;
    if (minsInZone >= 12 && sampleDistanceMiles < 0.6) trapMovementScore += 1;
    if (!state.lastMeaningfulRepositionAtMs && minsInZone >= 10) trapMovementScore += 0.75;
    if (repositionedRecently) trapMovementScore = Math.max(0, trapMovementScore - 1.5);

    const shortTripPenalty = safeNum(currentSignal?.shortTripPenalty, 0) || 0;
    const churnPressure = safeNum(currentSignal?.churnPressure, 0) || 0;
    const continuationWeak = (safeNum(currentSignal?.continuationRaw, 1) || 1) <= 0.45;
    const stayWeakensSoon = !!currentMetrics?.stayWeakensSoon;
    const stayAvg = safeNum(currentMetrics?.stayWindowAvgRating, safeNum(state.stayWindowAvgRating, 0) || 0) || 0;
    const stayMin = safeNum(currentMetrics?.stayWindowMinRating, safeNum(state.stayWindowMinRating, 0) || 0) || 0;
    const zoneScore = (shortTripPenalty >= 0.62 ? 1 : 0)
      + (churnPressure >= 0.58 ? 1 : 0)
      + (continuationWeak ? 1 : 0)
      + (stayWeakensSoon ? 0.75 : 0)
      + (stayAvg < 50 ? 0.75 : 0)
      + (stayMin < 47 ? 0.5 : 0);

    const escapeTarget = bestWorthwhileTarget || null;
    const hasEscape = !!escapeTarget?.candidateSignal;
    const composite = trapTimeScore + trapPickupScore + trapMovementScore + zoneScore;
    const strongEvidence = composite >= 7
      && (
        sameZonePickups >= 2
        || (minsInZone >= 12 && trapMovementScore >= 1 && continuationWeak)
        || (minsInZone >= 14 && stayAvg < 49)
      )
      && (hasEscape || stayAvg < 47);
    const mediumEvidence = composite >= 5 && (sameZonePickups >= 1 || minsInZone >= 10);
    let trapSeverityLevel = 0;
    if (strongEvidence && hasEscape) trapSeverityLevel = 3;
    else if (strongEvidence || mediumEvidence) trapSeverityLevel = 2;
    else if (composite >= 3.8) trapSeverityLevel = 1;
    const trapModeActive = trapSeverityLevel >= 2 && strongEvidence;
    const trapNeedsNearbyEscape = trapModeActive && !hasEscape;

    let trapReasonSummary = "";
    if (!strongEvidence && composite >= 3.8) {
      trapReasonSummary = "Area may cool off soon.";
    } else if (sameZonePickups >= 2 && minsInZone >= 8) {
      trapReasonSummary = "You got trips here but you are still stuck in the same area.";
    } else if (minsInZone >= 10 && trapMovementScore >= 1) {
      trapReasonSummary = "You have been here too long with no meaningful move.";
    } else if (shortTripPenalty >= 0.62) {
      trapReasonSummary = "This area keeps giving short trips.";
    } else if (trapModeActive && hasEscape) {
      trapReasonSummary = "Nearby area is more likely to be better.";
    } else if (trapNeedsNearbyEscape) {
      trapReasonSummary = "Nearby options are not strong enough yet.";
    }

    return {
      trapTimeScore,
      trapPickupScore,
      trapMovementScore,
      trapCompositeScore: composite,
      trapModeActive,
      trapSeverityLevel,
      trapReasonSummary,
      trapNeedsNearbyEscape,
      trapEscapeTarget: hasEscape ? escapeTarget : null,
    };
  }

  function isCountdownTargetStillValid(targetEval, currentSignal, currentMetrics, dataQualityMode) {
    if (!targetEval) return false;
    if (!targetEval?.viability?.viable) return false;
    if (!targetEval?.targetMetrics?.targetHoldsAfterArrival) return false;
    if (!targetEval?.targetPaybackMetrics?.paybackHolds) return false;
    if (targetEval?.targetMetrics?.targetLooksChasey) return false;
    if (targetEval?.targetMetrics?.targetTooFarForEdge) return false;
    if (!targetEval?.isNearTarget && !targetEval?.isSameBorough) return false;
    if (dataQualityMode !== "full" && !targetEval?.isNearTarget) return false;
    const moveEdge = safeNum(targetEval?.netMoveEdge, -Infinity) || -Infinity;
    const moveThreshold = safeNum(targetEval?.moveWorthThreshold, Infinity) || Infinity;
    if (moveEdge < moveThreshold) return false;
    return isCountdownTargetEconomicallyValid(targetEval, currentSignal, currentMetrics, dataQualityMode);
  }

  function isCountdownTargetEconomicallyValid(target, currentSignal, currentMetrics, dataQualityMode) {
    if (!target) return false;
    const etaMinutes = safeNum(target?.etaMinutes, Infinity) || Infinity;
    const sameBorough = normalizeAssistantBoroughName(target?.candidateSignal?.borough) === normalizeAssistantBoroughName(currentSignal?.borough);
    const nearEnough = etaMinutes <= AI_ASSISTANT_NEAR_TARGET_MAX_ETA_MIN;
    const withinFarCap = etaMinutes <= AI_ASSISTANT_FAR_TARGET_SOFT_CAP_MIN;
    const viableOnArrival = !!target?.viability?.viable
      && !target?.targetMetrics?.targetLooksChasey
      && !["trap_at_arrival", "slow_at_arrival", "target_chasey", "long_eta_no_hold"].includes(String(target?.viability?.viabilityRejectCode || ""));
    if (!viableOnArrival) return false;
    const paybackHolds = !!target?.targetPaybackMetrics?.paybackHolds;
    const paybackAvg = safeNum(target?.targetPaybackMetrics?.paybackAvgRating, 0) || 0;
    const stayAvg = safeNum(currentMetrics?.stayWindowAvgRating, 0) || 0;
    const moveEdge = safeNum(target?.netMoveEdge, -Infinity) || -Infinity;
    const moveThreshold = safeNum(target?.moveWorthThreshold, Infinity) || Infinity;
    const clearlySuperior = (paybackAvg - stayAvg) >= 3.0 && moveEdge >= (moveThreshold + 0.8);
    const sameBoroughPreferencePass = sameBorough && nearEnough;
    if (!sameBoroughPreferencePass && !(clearlySuperior && withinFarCap)) return false;
    if (dataQualityMode !== "full" && !sameBoroughPreferencePass) return false;
    return paybackHolds && moveEdge >= moveThreshold;
  }

  function isUrgentTrapCondition(trapState) {
    return !!trapState?.trapModeActive
      && (safeNum(trapState?.trapSeverityLevel, 0) || 0) >= 3
      && !!trapState?.trapEscapeTarget?.candidateSignal;
  }

  function shouldReplaceCountdownTarget(currentTarget, newTarget) {
    if (!newTarget?.locationId) return false;
    if (!currentTarget?.locationId) return true;
    if (String(currentTarget.locationId) === String(newTarget.locationId)) return false;
    const changedRecently = (Date.now() - (safeNum(state.lastCountdownTargetChangedAtTs, 0) || 0)) < (2 * 60000);
    const currentEta = safeNum(currentTarget?.etaMinutes, Infinity) || Infinity;
    const newEta = safeNum(newTarget?.etaMinutes, Infinity) || Infinity;
    const currentMoveAdv = safeNum(currentTarget?.netMoveEdge, -Infinity) || -Infinity;
    const newMoveAdv = safeNum(newTarget?.netMoveEdge, -Infinity) || -Infinity;
    const currentArrival = safeNum(currentTarget?.targetArrivalProjectedRating, 0) || 0;
    const newArrival = safeNum(newTarget?.targetArrivalProjectedRating, 0) || 0;
    const sameBorough = normalizeAssistantBoroughName(currentTarget?.borough) === normalizeAssistantBoroughName(newTarget?.borough);
    if (changedRecently) {
      if ((newMoveAdv - currentMoveAdv) >= 6) return true;
      if ((newArrival - currentArrival) >= 4 && (currentEta - newEta) >= 3) return true;
      return false;
    }
    if (sameBorough && Number.isFinite(currentEta) && Number.isFinite(newEta) && (currentEta - newEta) >= 3) return true;
    if ((newMoveAdv - currentMoveAdv) >= 4) return true;
    if ((newArrival - currentArrival) >= 3 && newEta < currentEta) return true;
    return false;
  }

  function deriveCountdownCoach(currentSignal, bestWorthwhileTarget, currentMetrics, currentTravelMetrics, dataQualityMode, trapState) {
    const now = Date.now();
    const minsInZone = dwellMins();
    const target = bestWorthwhileTarget || null;
    const cls = classifyAssistantSignal(currentSignal || {});
    const hasStableZone = !!state.activeStableZoneId && !!state.activeStableZoneEnterTs;
    const hasPickupSinceZoneEntry = hasPickupSinceCurrentZoneEntry();
    const isUrgentNow = state.finalActionCode === "LEAVE_NOW" || state.finalActionCode === "MOVE_SOON";
    const goodHoldWindow = !!currentMetrics?.stayHoldsAfterArrival
      && (safeNum(currentTravelMetrics?.travelWindowMinRating, 0) || 0) >= 50
      && !currentMetrics?.stayWeakensSoon;
    const noImmediateUrgency = !isUrgentNow;
    const targetEconomicallyValid = isCountdownTargetEconomicallyValid(target, currentSignal, currentMetrics, dataQualityMode);

    const eligible = hasStableZone
      && minsInZone >= 5
      && noImmediateUrgency
      && targetEconomicallyValid
      && !goodHoldWindow;
    const urgentTrap = isUrgentTrapCondition(trapState);
    const countdownSuppressed = now < (safeNum(state.countdownSuppressedUntilTs, 0) || 0);
    const pickupSuppressed = hasPickupSinceZoneEntry && now < ((safeNum(state.lastPickupRecordedAtMs, 0) || 0) + AI_ASSISTANT_PICKUP_SUPPRESS_MS);
    const blockedByQuietMode = (countdownSuppressed || pickupSuppressed) && !urgentTrap;

    if (!eligible || blockedByQuietMode) {
      if (blockedByQuietMode) {
        state.quietModeReason = pickupSuppressed ? "pickup_recent" : "hold_improved";
      }
      return {
        eligible: false,
        active: false,
        reasonCode: goodHoldWindow ? "good_hold_window" : (blockedByQuietMode ? "quiet_mode_active" : "countdown_not_eligible"),
        reasonText: goodHoldWindow ? "Current hold window remains strong." : (blockedByQuietMode ? "No countdown needed right now." : "Countdown not needed."),
        target: null,
        holdWindowReason: goodHoldWindow ? "Stay • Good zone right now" : "",
        escalationLevel: 0,
      };
    }

    const trapUrgency = !!trapState?.trapModeActive
      && (safeNum(trapState?.trapSeverityLevel, 0) || 0) >= 2
      && !!trapState?.trapEscapeTarget?.candidateSignal;
    const coolingButDecent = (safeNum(currentMetrics?.stayWindowAvgRating, 0) || 0) >= 49
      && !!currentMetrics?.stayWeakensSoon;
    const acceptableButWatch = (safeNum(currentMetrics?.stayWindowAvgRating, 0) || 0) >= 52
      && !currentMetrics?.stayWeakensSoon;
    let durationMin = 5;
    let reasonCode = "wait_then_move";
    const targetZoneName = String(target?.candidateSignal?.zoneName || "the better nearby area").trim();
    let reasonText = `If no trip in 5 min, move to ${targetZoneName}`;
    let escalationLevel = 1;

    if (trapUrgency) {
      durationMin = 3;
      reasonCode = "trap_risk_rising";
      reasonText = `If no trip in 3 min, go to ${targetZoneName}`;
      escalationLevel = (safeNum(trapState?.trapSeverityLevel, 2) || 2) >= 3 ? 3 : 2;
    } else if (coolingButDecent) {
      durationMin = 5;
      reasonCode = "zone_cooling";
      reasonText = `If no trip in 5 min, move to ${targetZoneName}`;
      escalationLevel = 1;
    } else if (acceptableButWatch) {
      durationMin = 4;
      reasonCode = "good_zone_protection";
      reasonText = `If no trip in 4 min, move to ${targetZoneName}`;
      escalationLevel = 0;
    }

    return {
      eligible: true,
      active: true,
      durationMin,
      reasonCode,
      reasonText,
      target: target?.candidateSignal
        ? {
            ...target.candidateSignal,
            etaMinutes: target.etaMinutes,
            distanceMiles: target.distanceMiles,
            netMoveEdge: target.netMoveEdge,
            targetArrivalProjectedRating: target?.targetMetrics?.targetArrivalProjectedRating,
          }
        : null,
      holdWindowReason: "",
      escalationLevel,
      arrivalNarrowWindow: (safeNum(target?.targetMetrics?.targetWindowTrendDelta, 0) || 0) <= -3,
      trapState: trapState || null,
    };
  }

  function buildAssistantPrimaryLine() {
    const primary = derivePrimaryDriverDecision();
    state.lastGuidancePrimaryLine = primary?.line || "";
    if (primary?.kind === "trap") state.lastTrapMessageAtTs = Date.now();
    if (primary?.kind === "stay") state.lastStayMessageAtTs = Date.now();
    if (primary?.kind === "move") state.lastMoveMessageAtTs = Date.now();
    return primary?.line || "Monitor • Checking more data";
  }

  function derivePrimaryDriverDecisionLocalFast(activeSignal, bestNearby) {
    if (!activeSignal) return { actionCode: "MONITOR", reasonText: "Checking more data." };
    const currentRating = safeNum(activeSignal?.visibleRating, 0) || 0;
    const nearbyRating = safeNum(bestNearby?.signal?.visibleRating, 0) || 0;
    const nearbyEta = safeNum(bestNearby?.etaMinutes, Infinity);
    const ratingGap = nearbyRating - currentRating;
    if (ratingGap >= 8 && nearbyEta <= AI_ASSISTANT_NEAR_TARGET_MAX_ETA_MIN) {
      return { actionCode: "MOVE_SOON", reasonText: "Better nearby area is ready" };
    }
    if (currentRating >= 56) return { actionCode: "STAY", reasonText: "Good zone right now" };
    if (currentRating >= 48) return { actionCode: "STAY", reasonText: "Decent area for now" };
    if (state.activeStableZoneId) return { actionCode: "STAY_BRIEFLY", reasonText: "Nearby options not strong enough yet" };
    return { actionCode: "MONITOR", reasonText: "Checking more data." };
  }

  function derivePrimaryDriverDecision() {
    const serverPrimary = deriveServerPrimaryDecision();
    if (serverPrimary) return serverPrimary;
    if (state.trapModeActive && state.trapNeedsNearbyEscape) {
      return { line: "Stay briefly • Nearby options not strong enough yet", kind: "trap" };
    }
    if (state.stabilityReasonCode === "countdown_expired_move_promoted" && isMoveAction(state.finalActionCode)) {
      return { line: "Move now • Better nearby area is ready", kind: "move" };
    }
    if (state.countdownActive && state.countdownReasonCode === "trap_risk_rising") {
      if (hasStrongTrapLanguageEvidence() && (safeNum(state.trapSeverityLevel, 0) || 0) >= 3 && !shouldThrottleKind("trap")) {
        return { line: "Move soon • Trap risk rising", kind: "trap" };
      }
      return { line: "Stay briefly • Area may cool off", kind: "stay" };
    }
    if (state.countdownActive && state.countdownReasonCode === "zone_cooling") {
      return { line: "Stay briefly • Area may cool off", kind: "stay" };
    }
    if (state.countdownActive && (state.committedActionCode === "STAY" || state.committedActionCode === "STAY_BRIEFLY")) {
      return { line: "Stay • Good zone right now", kind: "stay" };
    }
    if (isSafeDegradedStayFallback()) {
      return { line: safeDegradedStayPrimaryLine(), kind: "stay" };
    }
    const committedAction = state.committedActionCode || state.finalActionCode || "MONITOR";
    const fallbackReason = state.committedReasonText || state.recommendationReasonText || state.finalActionReason;
    const committedReason = friendlyReasonFromCode(state.committedReasonCode, fallbackReason) || fallbackReason;
    const action = humanActionLabel(committedAction);
    const reason = humanizeAssistantReason(committedReason);
    const isDecisionAction = committedAction === "STAY" || committedAction === "STAY_BRIEFLY" || committedAction === "MOVE_SOON" || committedAction === "LEAVE_NOW";
    if (isDecisionAction) {
      const moveLabel = committedAction === "LEAVE_NOW" ? "Move now" : action;
      if (state.usedCachedRecommendationFallback && state.dataQualityMode !== "full") {
        return { line: `${moveLabel} • ${reason} (recent fallback)`, kind: committedAction.startsWith("MOVE") || committedAction === "LEAVE_NOW" ? "move" : "stay" };
      }
      return { line: `${moveLabel} • ${reason}`, kind: committedAction.startsWith("MOVE") || committedAction === "LEAVE_NOW" ? "move" : "stay" };
    }
    if (state.dataQualityMode !== "full" && state.finalActionCode === "MONITOR") {
      if ((safeNum(state.stayWindowAvgRating, 0) || 0) >= 48) return { line: "Stay • Decent area for now", kind: "stay" };
      if ((safeNum(state.stayWindowAvgRating, 0) || 0) >= 44) return { line: "Stay briefly • Nearby options not strong enough yet", kind: "stay" };
      if (state.activeStableZoneId) return { line: "Stay • Nearby options not strong enough yet", kind: "stay" };
      return { line: "Monitor • Checking more data", kind: "monitor" };
    }
    if (committedAction === "MONITOR") {
      if ((safeNum(state.stayWindowAvgRating, 0) || 0) >= 50) return { line: "Stay • Good zone right now", kind: "stay" };
      if ((safeNum(state.stayWindowAvgRating, 0) || 0) >= 46) return { line: "Stay • Decent area for now", kind: "stay" };
      if (state.activeStableZoneId) {
        const hasUsefulDecision = state.countdownActive
          || state.finalActionCode === "STAY"
          || state.finalActionCode === "STAY_BRIEFLY"
          || (isMoveAction(state.finalActionCode) && !!state.assistantMoveTarget);
        if (hasUsefulDecision) return { line: "Stay briefly • Nearby options not strong enough yet", kind: "stay" };
      }
    }
    return { line: `${action} • ${reason}`, kind: "monitor" };
  }

  function activeServerGuidance() {
    const guidance = state.serverGuidance;
    if (!guidance || !guidance.actionCode) return null;
    if (!state.serverGuidanceUpdatedAt) return null;
    if (Date.now() - state.serverGuidanceUpdatedAt > (5 * 60000)) return null;
    return guidance;
  }

  function deriveServerPrimaryDecision() {
    const guidance = activeServerGuidance();
    if (!guidance) return null;
    const targetName = guidance?.targetZone?.name || "nearby zone";
    if (guidance.actionCode === "HOLD") return { line: "Stay in current area", kind: "stay" };
    if (guidance.actionCode === "MICRO_REPOSITION") return { line: "Micro-reposition nearby", kind: "stay" };
    if (guidance.actionCode === "MOVE_NEARBY") return { line: `Move toward ${targetName}`, kind: "move" };
    if (guidance.actionCode === "WAIT_DISPATCH") return { line: "Wait for dispatch", kind: "monitor" };
    return null;
  }

  function buildServerSecondaryLine(guidance) {
    if (!guidance) return "";
    const clueParts = [];
    if (Number.isFinite(guidance.triplessMinutes)) clueParts.push(`Tripless: ${Math.max(0, Math.round(guidance.triplessMinutes))}m`);
    if (Number.isFinite(guidance.stationaryMinutes)) clueParts.push(`Still: ${Math.max(0, Math.round(guidance.stationaryMinutes))}m`);
    if (Number.isFinite(guidance.movementMinutes)) clueParts.push(`Moved: ${Math.max(0, Math.round(guidance.movementMinutes))}m`);
    if (Number.isFinite(guidance.moveCooldownUntilTs)) {
      const mins = Math.max(0, Math.round((guidance.moveCooldownUntilTs * 1000 - Date.now()) / 60000));
      if (mins > 0) clueParts.push(`Move cooldown: ${mins}m`);
    }
    if (Number.isFinite(guidance.holdUntilTs)) {
      const mins = Math.max(0, Math.round((guidance.holdUntilTs * 1000 - Date.now()) / 60000));
      if (mins > 0) clueParts.push(`Hold: ${mins}m`);
    }
    if (Number.isFinite(guidance.dispatchUncertainty)) clueParts.push(`Dispatch: ${Math.round(guidance.dispatchUncertainty * 100)}% uncertain`);
    const base = guidance.message || "Local demand signal is mixed right now.";
    const compact = clueParts.length ? `${base} • ${clueParts[0]}` : base;
    return compact.replace(/\bdwell\b/gi, "stay");
  }

  function buildAssistantSecondaryLine() {
    const server = activeServerGuidance();
    if (server) {
      const line = buildServerSecondaryLine(server);
      if (line) {
        state.lastGuidanceSecondaryLine = line;
        return line;
      }
    }
    if (state.trapModeActive && state.trapNeedsNearbyEscape) {
      state.lastGuidanceSecondaryLine = "Waiting for a better nearby area";
      return "Waiting for a better nearby area";
    }
    if (state.countdownActive && state.countdownTarget?.zoneName) {
      const minsLeft = Math.max(1, Math.round(state.countdownMinutesRemaining || 0));
      if (state.countdownReasonCode === "trap_risk_rising") {
        const line = `If no trip in ${minsLeft} min, go to ${state.countdownTarget.zoneName}`;
        state.lastGuidanceSecondaryLine = line;
        return line;
      }
      if (state.countdownReasonCode === "zone_cooling") {
        const line = state.countdownReasonText.includes("arrival")
          ? `Move in ${minsLeft} min • target stronger by arrival`
          : `If no trip in ${minsLeft} min, move to ${state.countdownTarget.zoneName}`;
        state.lastGuidanceSecondaryLine = line;
        return line;
      }
      const line = `If no trip in ${minsLeft} min, move to ${state.countdownTarget.zoneName}`;
      state.lastGuidanceSecondaryLine = line;
      return line;
    }
    const committedAction = state.committedActionCode || "MONITOR";
    const committedTarget = state.committedMoveTarget || state.assistantMoveTarget || null;
    const weakDataMode = state.dataQualityMode === "partial" || state.dataQualityMode === "degraded";
    const safeDegradedStayFallback = isSafeDegradedStayFallback();
    if (safeDegradedStayFallback) {
      state.lastGuidanceSecondaryLine = "Stay here for now";
      return "Stay here for now";
    }
    if (state.dataQualityMode === "degraded" && state.finalActionCode === "MONITOR" && !safeDegradedStayFallback) {
      state.lastGuidanceSecondaryLine = "Waiting for a clearer signal";
      return "Waiting for a clearer signal";
    }
    if (weakDataMode && (!committedTarget || (safeNum(committedTarget?.etaMinutes, Infinity) || Infinity) > AI_ASSISTANT_NEAR_TARGET_MAX_ETA_MIN)) {
      const line = committedAction === "STAY" ? "Stay here for now" : "Waiting for a clearer signal";
      state.lastGuidanceSecondaryLine = line;
      return line;
    }
    if ((committedAction === "MOVE_SOON" || committedAction === "LEAVE_NOW")
      && committedTarget?.zoneName
      && Number.isFinite(committedTarget?.etaMinutes)) {
      const line = `Go to ${committedTarget.zoneName} • ${Math.round(committedTarget.etaMinutes)} min`;
      state.lastGuidanceSecondaryLine = line;
      return line;
    }
    if (committedAction === "STAY") {
      state.lastGuidanceSecondaryLine = "Stay here for now";
      return "Stay here for now";
    }
    if (committedAction === "STAY_BRIEFLY") {
      state.lastGuidanceSecondaryLine = "Stay here briefly";
      return "Stay here briefly";
    }
    if (committedAction === "MONITOR") {
      if ((safeNum(state.stayWindowAvgRating, 0) || 0) >= 50) {
        state.lastGuidanceSecondaryLine = "Stay here for now";
        return "Stay here for now";
      }
      if ((safeNum(state.stayWindowAvgRating, 0) || 0) >= 46) {
        state.lastGuidanceSecondaryLine = "Nearby options not strong enough yet";
        return "Nearby options not strong enough yet";
      }
      state.lastGuidanceSecondaryLine = "Waiting for a clearer signal";
      return "Waiting for a clearer signal";
    }
    state.lastGuidanceSecondaryLine = "Waiting for a clearer signal";
    return "Waiting for a clearer signal";
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
    // Phase 1: recommendations are advisory only.
    // Navigation ownership is manual and handled by TlcManualNavigationModule.
    return;
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
    const compactLane = isCompactLaneMode();
    const list = [];
    const primaryDecision = derivePrimaryDriverDecision();
    const primary = primaryDecision?.line || buildAssistantPrimaryLine();
    const primarySeverity = primaryDecision?.kind === "move"
      ? "move"
      : (primaryDecision?.kind === "stay" || primaryDecision?.kind === "trap")
        ? "caution"
        : severityForAction(state.finalActionCode);
    list.push({ key: "action", text: primary, severity: primarySeverity });

    const allowTargetInCompact = state.dataQualityMode === "full"
      || ((safeNum(state.assistantMoveTarget?.etaMinutes, Infinity) || Infinity) <= AI_ASSISTANT_NEAR_TARGET_MAX_ETA_MIN);
    if (state.assistantMoveTarget?.zoneName && Number.isFinite(state.assistantMoveTarget?.etaMinutes) && allowTargetInCompact) {
      const targetSummary = `Go to ${state.assistantMoveTarget.zoneName} • ${Math.round(state.assistantMoveTarget.etaMinutes || 0)} min`;
      if (!primary.includes(targetSummary)) {
        list.push({ key: "target", text: targetSummary, severity: "info" });
      }
    }

    if (!compactLane && state.targetStrongUntilTime) {
      const until = internals.formatNYCTimeOnlyLabel?.(state.targetStrongUntilTime) || state.targetStrongUntilTime;
      list.push({ key: "target_window", text: `Nearby area looks stronger until ${until}.`, severity: "info" });
    }

    const rawOutlook = String(state.outlookSummaryText || "").trim();
    const outlookText = humanizeAssistantReason(rawOutlook);
    const outlookMeaningful = rawOutlook && !/^outlook unavailable\.?$/i.test(rawOutlook) && !/^checking outlook\.?$/i.test(outlookText);
    if (!compactLane && outlookMeaningful) {
      list.push({ key: "outlook", text: outlookText, severity: "info" });
    }
    const targetOutlook = humanizeAssistantReason(state.moveTargetOutlookSummaryText);
    if (!compactLane && String(targetOutlook || "").trim() && !/^checking outlook\.?$/i.test(targetOutlook)) {
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
    let finalized = uniq;
    if (compactLane) {
      const preferredOrder = ["action", "target", "rank"];
      const preferred = [];
      for (const key of preferredOrder) {
        const found = uniq.find((m) => m.key === key);
        if (found) preferred.push(found);
      }
      finalized = preferred.length ? preferred : uniq.slice(0, 1);
      if (isSafeDegradedStayFallback()) {
        finalized = [{ key: "action", text: safeDegradedStayPrimaryLine(), severity: "positive" }];
      } else if (state.dataQualityMode === "degraded" && state.finalActionCode === "MONITOR") {
        const stayAvg = safeNum(state.stayWindowAvgRating, 0) || 0;
        const decisionLine = primaryDecision?.line || primary;
        const hasDecision = /^(Stay|Stay briefly|Move soon|Move now)\s•/i.test(String(decisionLine || "").trim());
        const stableZoneFallback = state.activeStableZoneId ? "Stay • Nearby options not strong enough yet" : "Monitor • Checking more data";
        finalized = [{
          key: "action",
          text: hasDecision ? decisionLine : (stayAvg >= 44 ? "Stay briefly • Nearby options not strong enough yet" : stableZoneFallback),
          severity: hasDecision ? primarySeverity : (stayAvg >= 44 || state.activeStableZoneId ? "caution" : "info")
        }];
      } else if (state.dataQualityMode === "partial" && !state.assistantMoveTarget) {
        finalized = [{ key: "action", text: "Stay • Other areas are too far right now", severity: "caution" }];
      }
    }
    if (!finalized.length) {
      finalized.push({ key: "fallback", text: "Monitor • Waiting for a clearer signal", severity: "info" });
    }
    state.assistantMessages = finalized;
    state.activeMessageIndex = 0;
    const active = finalized[state.activeMessageIndex] || { key: "none", text: "AI Assistant ready.", severity: "info" };
    state.activeMessageKey = active.key;
    state.activeMessageSeverity = active.severity;
    state.activeMessageIcon = active.severity;
  }

  function mirrorRecommendLine() {
    if (!recommendLine) return;
    const primary = buildAssistantPrimaryLine();
    const secondary = buildAssistantSecondaryLine();
    const key = `${primary}|${secondary}`;
    if (state.lastRecommendLineKey === key) return;
    state.lastRecommendLineKey = key;
    recommendLine.textContent = `AI Assistant: ${primary} • ${secondary}`;
  }

  function renderWidget() {
    if (!dockMount) return;
    const compactLane = isCompactLaneMode();
    buildMessages();
    const primaryLine = buildAssistantPrimaryLine();
    const secondaryLine = buildAssistantSecondaryLine();
    const serverAction = activeServerGuidance()?.actionCode || "";
    const iconType = serverAction === "MOVE_NEARBY"
      ? "move"
      : (serverAction === "HOLD" ? "positive" : (serverAction === "MICRO_REPOSITION" || serverAction === "WAIT_DISPATCH" ? "caution" : leadingIconKindFromAction(state.finalActionCode)));
    const renderKey = [
      compactLane ? 1 : 0,
      state.expanded ? 1 : 0,
      iconType,
      String(primaryLine || ""),
      String(secondaryLine || ""),
      state.expanded ? String(state.assistantMoveTarget?.locationId || "") : "",
      state.expanded ? String(state.countdownMinutesRemaining || "") : "",
      state.expanded ? String(state.outlookSummaryText || "") : "",
    ].join("|");
    if (state.lastAssistantRenderKey === renderKey) return;
    state.lastAssistantRenderKey = renderKey;

    dockMount.innerHTML = `
      <div class="aiAssistantWidget ${compactLane ? "aiAssistantWidget--compactLane" : ""} ${state.expanded ? "is-expanded" : ""}" id="aiAssistantWidget">
        <div class="aiAssistantMainRow">
          <div class="aiAssistantIconChip aiAssistantIconChip--${iconType}">${iconMarkup(iconType)}</div>
          <div class="aiAssistantMessageStack">
            <div class="aiAssistantPrimaryText">${String(primaryLine || "").replace(/dwell/gi, "stay")}</div>
            <div class="aiAssistantSecondaryText">${String(secondaryLine || "").replace(/dwell/gi, "stay")}</div>
          </div>
          <button class="aiAssistantExpandBtn" type="button" data-ai-action="toggle-expanded" aria-expanded="${state.expanded ? "true" : "false"}">${state.expanded ? "−" : "+"}</button>
        </div>
        ${state.expanded ? buildPanelHtml() : ""}
      </div>
    `;
    clearMessageRotationTimer();
    updateAssistantDockLayout();
  }

  function buildRankList(items) {
    return `<ol class="aiAssistantList">${(items || []).map((it) => `<li>${it.zoneName} (${Math.round(it.visibleRating || 0)})</li>`).join("")}</ol>`;
  }

  function compactTargetWhyLine() {
    if (state.chosenTargetGroup === "same_borough_near") return "Why this area: close and easy to reach";
    if (state.chosenTargetGroup === "near") return "Why this area: nearby option looks better";
    if (state.chosenTargetGroup === "far_exception") return "Why this area: longer drive but stronger area";
    if (state.chosenTargetReasoningMode === "stay_not_worth_moving") return "Why staying: other areas are too far right now";
    if (state.targetViabilityRejectReasonText) return `Why staying: ${humanizeAssistantReason(state.targetViabilityRejectReasonText)}`;
    return "Why staying: other areas are too far right now";
  }

  function buildPanelHtml() {
    const cautionDataLine = state.dataQualityMode === "degraded"
      ? "Using a cautious recommendation because some live data is missing."
      : (state.dataQualityMode === "partial" ? "Using a cautious recommendation while data refreshes." : "");
    const showMoveCheck = !!state.assistantMoveTarget
      && Number.isFinite(state.stayScenarioValue)
      && Number.isFinite(state.moveScenarioValue)
      && Number.isFinite(state.netMoveEdge)
      && Number.isFinite(state.moveWorthThreshold)
      && (Math.abs(safeNum(state.netMoveEdge, 0) || 0) >= 0.1 || Math.abs(safeNum(state.moveWorthThreshold, 0) || 0) >= 0.1);
    const outlookStatusLine = (state.outlookStatus || state.outlookLastErrorCode)
      ? `<div><small>${state.outlookStatus === "loading" ? "Refreshing live outlook data." : (state.outlookStatus === "error" ? "Live outlook data is temporarily unavailable." : "Live outlook data updated.")}</small></div>`
      : "";
    const serverGuidance = activeServerGuidance();
    const guidanceStatusLine = state.guidanceStatus
      ? `<div><small>${state.guidanceSource === "server" ? "Using account-aware server guidance." : (state.guidanceStatus === "loading" ? "Checking account-aware guidance." : "Using local guidance while account context is unavailable.")}</small></div>`
      : "";
    const guidanceMetricLine = serverGuidance
      ? `<div>${[
          Number.isFinite(serverGuidance.triplessMinutes) ? `Tripless: ${Math.round(serverGuidance.triplessMinutes)}m` : "",
          Number.isFinite(serverGuidance.stationaryMinutes) ? `Still: ${Math.round(serverGuidance.stationaryMinutes)}m` : "",
          Number.isFinite(serverGuidance.movementMinutes) ? `Moved: ${Math.round(serverGuidance.movementMinutes)}m` : "",
        ].filter(Boolean).slice(0, 2).join(" • ")}</div>`
      : "";
    const guidanceTimingLine = serverGuidance
      ? `<div>${[
          Number.isFinite(serverGuidance.dispatchUncertainty) ? `Dispatch uncertainty: ${Math.round(serverGuidance.dispatchUncertainty * 100)}%` : "",
          Number.isFinite(serverGuidance.moveCooldownUntilTs) ? `Move cooldown until ${new Date(serverGuidance.moveCooldownUntilTs * 1000).toLocaleTimeString()}` : "",
          Number.isFinite(serverGuidance.holdUntilTs) ? `Hold until ${new Date(serverGuidance.holdUntilTs * 1000).toLocaleTimeString()}` : "",
        ].filter(Boolean).slice(0, 2).join(" • ")}</div>`
      : "";
    const committedActionText = humanActionLabel(state.committedActionCode);
    const committedReasonText = humanizeAssistantReason(friendlyReasonFromCode(state.committedReasonCode, state.committedReasonText || "—"));
    return `
      <div class="aiAssistantPanel">
        <section class="aiAssistantSection"><strong>Current area</strong><div>${state.activeStableZoneName || "—"} • ${state.activeStableBorough || "—"} • ${Math.round(state.visibleRating || 0)} ${prettyBucket(state.visibleBucket)} • ${state.visibleScoreSourceLabel}</div></section>
        <section class="aiAssistantSection"><strong>Advice</strong><div>${buildAssistantPrimaryLine()}</div><div>${buildAssistantSecondaryLine()}</div>${serverGuidance?.targetZone?.name ? `<div>Target zone: ${serverGuidance.targetZone.name}</div>` : ""}${guidanceMetricLine}${guidanceTimingLine}${guidanceStatusLine}</section>
        <section class="aiAssistantSection"><strong>Countdown</strong><div>${state.countdownActive ? `Countdown active • ${Math.max(1, Math.round(state.countdownMinutesRemaining || 0))} min left` : "Countdown inactive"}</div><div>${state.countdownReasonText || state.countdownHoldWindowReason || "No countdown needed."}</div>${state.countdownActive && state.countdownTarget?.zoneName ? `<div>Target: ${state.countdownTarget.zoneName} • ${Math.round(state.countdownTarget.etaMinutes || 0)} min</div>` : ""}</section>
        ${(state.trapModeActive || (safeNum(state.trapSeverityLevel, 0) || 0) >= 2 || state.trapReasonSummary) ? `<section class="aiAssistantSection"><strong>Area check</strong><div>${state.trapReasonSummary || "No trap signs right now."}</div>${state.trapEscapeTarget?.candidateSignal?.zoneName ? `<div>Nearby option: ${state.trapEscapeTarget.candidateSignal.zoneName} • ${Math.round(state.trapEscapeTarget.etaMinutes || 0)} min</div>` : ""}</section>` : ""}
        <section class="aiAssistantSection"><strong>What may happen next</strong><div>${state.outlookSummaryText}</div>${state.moveTargetOutlookSummaryText ? `<div>${state.moveTargetOutlookSummaryText}</div>` : ""}${outlookStatusLine}</section>
        <section class="aiAssistantSection"><strong>Best areas right now</strong><div>Best now: ${state.citywideBestNow?.zoneName || "—"} • Worst now: ${state.citywideWorstNow?.zoneName || "—"}</div>${buildRankList(state.citywideTop10Best)}${buildRankList(state.boroughTop5Best)}</section>
        ${state.assistantMoveTarget ? `<section class="aiAssistantSection"><strong>Nearby option</strong><div>${state.assistantMoveTarget.zoneName} • ${Math.round(state.assistantMoveTarget.etaMinutes || 0)} min • ${state.assistantMoveTarget.distanceMiles.toFixed(1)} mi</div></section>` : ""}
        ${showMoveCheck ? `<section class="aiAssistantSection"><strong>If you decide to move</strong><div>Drive time: ${Math.round(state.etaMinutes || 0)} min</div><div><small>${compactTargetWhyLine()}</small></div></section>` : ""}
        <section class="aiAssistantSection"><strong>Assistant status</strong><div>Current advice: ${committedActionText} • ${committedReasonText}</div><div>Last update: ${state.committedSinceTs ? new Date(state.committedSinceTs).toLocaleTimeString() : "—"}</div></section>
        ${cautionDataLine ? `<section class="aiAssistantSection"><small>${cautionDataLine}</small></section>` : ""}
        <section class="aiAssistantSection"><small>Assistant uses the same visible Team Joseo score path the map is showing.</small></section>
      </div>
    `;
  }

  function updateAssistantDockLayout() {
    const dock = document.getElementById("aiAssistantDock");
    const onlineBadge = document.getElementById("onlineBadge");
    const weatherBadge = document.getElementById("weatherBadge");
    if (!dock || !onlineBadge || !weatherBadge) return;

    const onlineRect = onlineBadge.getBoundingClientRect?.();
    const weatherRect = weatherBadge.getBoundingClientRect?.();
    if (!onlineRect || !weatherRect) return;
    if (![onlineRect.right, weatherRect.left, window.innerWidth].every((n) => Number.isFinite(n))) return;

    const laneLeft = Math.ceil(onlineRect.right + 10);
    const laneRight = Math.floor(weatherRect.left - 10);
    const laneWidth = Math.floor(laneRight - laneLeft);
    const laneCenter = Math.floor((laneLeft + laneRight) / 2);

    if (laneWidth >= 140) {
      const dockWidth = Math.min(220, laneWidth);
      dock.style.left = `${laneCenter}px`;
      dock.style.right = "auto";
      dock.style.width = `${dockWidth}px`;
      dock.style.maxWidth = `${dockWidth}px`;
      dock.style.transform = "translateX(-50%)";
      dock.style.top = "calc(env(safe-area-inset-top) + 10px)";
      dock.dataset.aiCompactLane = laneWidth < 210 ? "1" : "0";
      return;
    }

    dock.style.left = "50%";
    dock.style.right = "auto";
    dock.style.width = "min(220px, calc(100vw - 32px))";
    dock.style.maxWidth = "calc(100vw - 32px)";
    dock.style.transform = "translateX(-50%)";
    dock.style.top = "calc(env(safe-area-inset-top) + 10px)";
    dock.dataset.aiCompactLane = "1";
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

  function clearMessageRotationTimer() {
    if (state.rotationTimerHandle) {
      clearTimeout(state.rotationTimerHandle);
      state.rotationTimerHandle = null;
    }
  }

  function feedMaterialKey() {
    const dwellBucket = Math.floor((state.activeStableZoneDwellMs || 0) / 60000);
    return [
      state.activeStableZoneId || "",
      state.finalActionCode || "",
      state.finalActionReason || "",
      state.proposedActionCode || "",
      state.proposedReasonCode || "",
      state.committedActionCode || "",
      state.committedReasonCode || "",
      state.committedMoveTarget?.locationId || "",
      state.stabilityReasonCode || "",
      state.dwellRiskCode || "",
      state.dwellEscalationLevel || 0,
      state.assistantMoveTarget?.locationId || "",
      state.currentZoneCitywideRank || "",
      state.currentZoneBoroughRank || "",
      state.holdUntilTime || "",
      state.countdownReasonCode || "",
      state.countdownTarget?.locationId || "",
      state.countdownMinutesRemaining || "",
      state.trapSeverityLevel || 0,
      state.trapEscapeTarget?.candidateSignal?.locationId || "",
      state.trapModeActive ? 1 : 0,
      dwellBucket,
    ].join("|");
  }

  function snapshot() {
    const server = activeServerGuidance();
    return {
      ...state,
      guidanceSource: state.guidanceSource,
      guidanceStatus: state.guidanceStatus,
      serverGuidanceAction: server?.actionCode || "",
      serverGuidanceConfidence: server?.confidence ?? null,
      serverGuidanceReasonCodes: Array.isArray(server?.reasonCodes) ? [...server.reasonCodes] : [],
      serverGuidanceTriplessMinutes: server?.triplessMinutes ?? null,
      serverGuidanceStationaryMinutes: server?.stationaryMinutes ?? null,
      serverGuidanceMovementMinutes: server?.movementMinutes ?? null,
      serverGuidanceDispatchUncertainty: server?.dispatchUncertainty ?? null,
      serverGuidanceTargetZoneId: server?.targetZone?.id || "",
      serverGuidanceTargetZoneName: server?.targetZone?.name || "",
      outlookCache: undefined,
      outlookAbortController: undefined,
      guidanceCache: undefined,
      guidanceAbortController: undefined,
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

  function resetRecommendationStateForZoneChange(previousZoneId, nowTs = Date.now()) {
    state.activeStableZoneEnterTs = nowTs;
    state.activeStableZoneDwellMs = 0;
    state.assistantMoveTarget = null;
    state.bestArrivalAwareCandidate = null;
    state.bestCandidateNotWorthMoving = null;
    state.arrivalAwareCandidateShortlist = [];
    state.shortlistCandidateIds = [];
    state.shortlistCandidateZones = [];
    state.shortlistCandidateEtas = [];
    state.sameBoroughNearCandidateCount = 0;
    state.crossBoroughNearCandidateCount = 0;
    state.farCandidateCount = 0;
    state.farCandidatesRejectedForDistance = 0;
    state.currentZoneOutlook = null;
    state.moveTargetOutlook = null;
    state.outlookSummaryText = "Outlook unavailable.";
    state.moveTargetOutlookSummaryText = "";
    state.outlookStatus = "idle";
    state.outlookLastErrorCode = "";
    state.outlookLastErrorMessage = "";
    state.guidanceStatus = "idle";
    state.guidanceLastErrorCode = "";
    state.guidanceLastErrorMessage = "";
    state.serverGuidance = null;
    state.serverGuidanceUpdatedAt = 0;
    state.guidanceSource = "local";
    state.lastGuidanceRequestKey = "";
    state.lastSuccessfulGuidanceKey = "";
    state.lastSuccessfulGuidanceAt = 0;
    state.guidanceEnrichRefreshKey = "";
    state.outlookInFlightKey = "";
    state.outlookInFlightPromise = null;
    state.lastSuccessfulOutlookKey = "";
    state.lastSuccessfulOutlookAt = 0;
    state.etaMinutes = null;
    state.distanceMiles = null;
    state.stayProjectedRating = null;
    state.targetArrivalProjectedRating = null;
    state.stayWindowAvgRating = null;
    state.targetWindowAvgRating = null;
    state.stayWindowMinRating = null;
    state.targetWindowMinRating = null;
    state.stayScenarioValue = null;
    state.moveScenarioValue = null;
    state.currentTravelWindowAvgRating = null;
    state.currentTravelWindowMinRating = null;
    state.targetPaybackAvgRating = null;
    state.targetPaybackMinRating = null;
    state.totalDeadheadCost = null;
    state.moveConfidencePenalty = null;
    state.confidencePenaltyReasons = [];
    state.netMoveEdge = null;
    state.moveWorthThreshold = null;
    state.targetViableOnArrival = null;
    state.targetViabilityRejectCode = null;
    state.targetViabilityRejectReasonText = "";
    state.proposedActionCode = null;
    state.proposedReasonCode = null;
    state.proposedReasonText = "";
    state.proposedMoveTarget = null;
    state.proposedNetMoveEdge = null;
    state.proposedWorthThreshold = null;
    state.proposedSinceTs = null;
    state.proposedStableHits = 0;
    state.committedActionCode = null;
    state.committedReasonCode = null;
    state.committedReasonText = "";
    state.committedMoveTarget = null;
    state.committedSinceTs = null;
    state.recommendationSwitchCooldownUntilTs = 0;
    state.recommendationMinHoldUntilTs = 0;
    state.recommendationStickyTargetId = null;
    state.recommendationStickyTargetSinceTs = null;
    state.recommendationConfidenceScore = null;
    state.recommendationConfidenceLevel = "low";
    state.stabilityReasonCode = "";
    state.stabilityReasonText = "";
    state.recommendationReasonCode = "collecting_context";
    state.recommendationReasonText = "Collecting more context.";
    state.dataQualityMode = "degraded";
    state.dataQualityLabel = "degraded";
    state.dataQualityReason = "Checking more data.";
    state.currentPointsCount = 0;
    state.targetPointsCount = 0;
    state.hasRecentSuccessfulOutlook = false;
    state.isUsingCachedOutlook = false;
    state.isPartialOutlook = false;
    state.canTrustFarMoves = false;
    state.usedCachedRecommendationFallback = false;
    state.chosenTargetGroup = "none";
    state.chosenTargetReasoningMode = "collecting_context";
    state.baseActionCode = "MONITOR";
    state.baseActionReason = "Collecting more context.";
    state.finalActionCode = "MONITOR";
    state.finalActionReason = "Collecting more context.";
    state.actionSeverity = "info";
    state.holdUntilTime = null;
    state.trapUntilTime = null;
    state.busyUntilTime = null;
    state.slowUntilTime = null;
    state.nextImprovementTime = null;
    state.nextWorseningTime = null;
    state.targetStrongUntilTime = null;
    state.stableZoneEntryUserLocation = state.lastUserLocation && Number.isFinite(state.lastUserLocation.lat) && Number.isFinite(state.lastUserLocation.lng)
      ? { lat: state.lastUserLocation.lat, lng: state.lastUserLocation.lng, ts: nowTs }
      : null;
    state.lastMeaningfulRepositionAtMs = null;
    state.lastMeaningfulRepositionDistanceMiles = 0;
    state.sameZonePickupCountSinceEntry = 0;
    state.sameZonePickupCountRolling = Math.max(0, Math.floor((safeNum(state.sameZonePickupCountRolling, 0) || 0) * 0.5));
    state.trapMovementScore = 0;
    state.trapPickupScore = 0;
    state.trapTimeScore = 0;
    state.trapCompositeScore = 0;
    state.trapModeActive = false;
    state.trapDetectedAtMs = null;
    state.trapReasonSummary = "";
    state.trapNeedsNearbyEscape = false;
    state.trapEscapeTarget = null;
    state.trapSeverityLevel = 0;
    state.recentZoneMovementSamples = state.stableZoneEntryUserLocation ? [state.stableZoneEntryUserLocation] : [];
    state.countdownSuppressedUntilTs = 0;
    state.trapSuppressedUntilTs = 0;
    state.lastCountdownTargetId = null;
    state.lastCountdownTargetChangedAtTs = 0;
    state.lastTrapMessageAtTs = 0;
    state.lastStayMessageAtTs = 0;
    state.lastMoveMessageAtTs = 0;
    state.quietModeReason = "";
    resetCountdownCoachState();
    if (state.outlookAbortController) state.outlookAbortController.abort();
    if (previousZoneId && String(state.outlookRequestKey || "").includes(String(previousZoneId))) {
      state.outlookRequestKey = "";
      state.outlookCache.clear();
    }
  }

  function applyStableZoneFromLocation() {
    const loc = state.lastUserLocation;
    const now = Date.now();
    if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) return false;
    const feature = internals.resolveZoneFeatureAtLngLat?.({ lat: loc.lat, lng: loc.lng }) || null;
    if (!feature) {
      if (state.activeStableZoneId && state.activeZoneLastSeenTs && now - state.activeZoneLastSeenTs > AI_ASSISTANT_CLEAR_GRACE_MS) {
        state.activeStableZoneId = null;
        state.activeStableZoneName = "";
        state.activeStableBorough = "";
        state.activeStableZoneEnterTs = null;
        state.stableZoneEntryUserLocation = null;
        state.recentZoneMovementSamples = [];
        state.trapModeActive = false;
        state.trapCompositeScore = 0;
        state.trapReasonSummary = "";
        state.trapEscapeTarget = null;
        state.trapNeedsNearbyEscape = false;
        state.trapSeverityLevel = 0;
        resetCountdownCoachState();
      }
      return false;
    }
    const signal = buildAssistantFeatureSignal(feature);
    state.activeZoneLastSeenTs = now;
    if (!signal.locationId) return false;
    if (state.candidateZoneId !== signal.locationId) {
      state.candidateZoneId = signal.locationId;
      state.candidateZoneFirstSeenTs = now;
      state.candidateZoneHits = 1;
      return false;
    }
    state.candidateZoneHits += 1;
    const stableMs = now - (state.candidateZoneFirstSeenTs || now);
    if (state.candidateZoneHits >= AI_ASSISTANT_STABLE_MIN_HITS && stableMs >= AI_ASSISTANT_STABLE_MIN_MS) {
      if (state.activeStableZoneId !== signal.locationId) {
        const previousZoneId = state.activeStableZoneId;
        state.activeStableZoneId = signal.locationId;
        state.activeStableZoneName = signal.zoneName;
        state.activeStableBorough = signal.borough;
        resetRecommendationStateForZoneChange(previousZoneId, now);
        window.dispatchEvent(new CustomEvent("tlc-ai-assistant-zone-changed", { detail: snapshot() }));
        window.dispatchEvent(new CustomEvent("tlc-ai-assistant-snapshot-updated", { detail: snapshot() }));
        return true;
      }
    }
    return false;
  }

  function shouldRunFullAssistantPass({ zoneChanged, frameChanged, meaningfulRepositioned, urgent = false }) {
    if (urgent) return true;
    const now = Date.now();
    const zoneId = String(state.activeStableZoneId || "");
    const frameTime = String(state.lastFrameTime || "");
    if (zoneChanged) return true;
    if (frameChanged) return true;
    if (state.lastPickupRecordedAtMs && now - state.lastPickupRecordedAtMs < 1500) return true;
    if (!state.lastFullAssistantRecomputeAtMs) return true;
    if (zoneId && zoneId !== String(state.lastFullAssistantRecomputeZoneId || "")) return true;
    if (frameTime && frameTime !== String(state.lastFullAssistantRecomputeFrameTime || "")) return true;
    if (meaningfulRepositioned) return true;
    if (state.lastUserLocation && Number.isFinite(state.lastUserLocation.lat) && Number.isFinite(state.lastUserLocation.lng)
      && Number.isFinite(state.lastFullAssistantRecomputeLat) && Number.isFinite(state.lastFullAssistantRecomputeLng)) {
      const moved = internals.haversineMiles?.(
        { lat: state.lastFullAssistantRecomputeLat, lng: state.lastFullAssistantRecomputeLng },
        { lat: state.lastUserLocation.lat, lng: state.lastUserLocation.lng }
      ) || 0;
      if (moved >= AI_ASSISTANT_SAME_ZONE_REPOSITION_MILES) return true;
    }
    return (now - state.lastFullAssistantRecomputeAtMs) >= AI_ASSISTANT_FULL_RECOMPUTE_MIN_MS;
  }

  function runAssistantLightPass() {
    const nowTs = Date.now();
    if (state.countdownActive && state.countdownDeadlineTs) {
      state.countdownMinutesRemaining = Math.max(0, Math.ceil((state.countdownDeadlineTs - nowTs) / 60000));
      if (state.countdownMinutesRemaining <= 0) resetCountdownCoachState();
    }
    const primary = buildAssistantPrimaryLine();
    const secondary = buildAssistantSecondaryLine();
    if (primary !== state.lastLightPassPrimaryLine || secondary !== state.lastLightPassSecondaryLine) {
      state.lastLightPassPrimaryLine = primary;
      state.lastLightPassSecondaryLine = secondary;
      mirrorRecommendLine();
      renderWidget();
    }
    emitSnapshotEvents();
  }

  async function recompute(frame, options = {}) {
    const urgent = !!options.urgent;
    const liveFrame = frame || internals.getCurrentFrame?.() || null;
    state.lastFrameTime = frameTimeIso(liveFrame);
    const prevFrameTime = String(state.lastFullAssistantRecomputeFrameTime || "");
    const frameChanged = prevFrameTime !== String(state.lastFrameTime || "");
    const zoneChanged = applyStableZoneFromLocation();
    if (zoneChanged) {
      state.sameZonePickupCountSinceEntry = 0;
      state.sameZonePickupCountRolling = Math.max(0, Math.floor((safeNum(state.sameZonePickupCountRolling, 0) || 0) * 0.5));
      state.recentZoneMovementSamples = [];
      if (state.lastUserLocation && Number.isFinite(state.lastUserLocation.lat) && Number.isFinite(state.lastUserLocation.lng)) {
        state.stableZoneEntryUserLocation = { lat: state.lastUserLocation.lat, lng: state.lastUserLocation.lng, ts: Date.now() };
        state.recentZoneMovementSamples = [{ lat: state.lastUserLocation.lat, lng: state.lastUserLocation.lng, ts: Date.now() }];
      } else {
        state.stableZoneEntryUserLocation = null;
      }
      state.lastMeaningfulRepositionAtMs = null;
      state.lastMeaningfulRepositionDistanceMiles = 0;
      state.trapTimeScore = 0;
      state.trapPickupScore = 0;
      state.trapMovementScore = 0;
      state.trapCompositeScore = 0;
      state.trapModeActive = false;
      state.trapDetectedAtMs = null;
      state.trapReasonSummary = "";
      state.trapNeedsNearbyEscape = false;
      state.trapEscapeTarget = null;
      state.trapSeverityLevel = 0;
      state.countdownSuppressedUntilTs = 0;
      state.trapSuppressedUntilTs = 0;
      state.quietModeReason = "";
    }
    sampleRecentSameZoneMovement(state.activeStableZoneId, state.lastUserLocation);
    const meaningfulRepositioned = isMeaningfulRepositionInSameZone(state.activeStableZoneId, state.lastUserLocation);
    state.activeStableZoneDwellMs = state.activeStableZoneEnterTs ? Math.max(0, Date.now() - state.activeStableZoneEnterTs) : 0;
    if (!shouldRunFullAssistantPass({ zoneChanged, frameChanged, meaningfulRepositioned, urgent })) {
      runAssistantLightPass();
      return;
    }

    const frameSignals = getSignalsForFrame(liveFrame);
    const activeSignal = state.activeStableZoneId
      ? frameSignals.find((s) => s.locationId === state.activeStableZoneId) || null
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
    const shortlist = buildArrivalAwareCandidateShortlist(liveFrame, activeSignal);
    state.arrivalAwareCandidateShortlist = shortlist;
    state.shortlistCandidateIds = shortlist.map((c) => String(c?.signal?.locationId || "").trim()).filter(Boolean);
    state.shortlistCandidateZones = shortlist.map((c) => String(c?.signal?.zoneName || "").trim() || "Unknown zone");
    state.shortlistCandidateEtas = shortlist.map((c) => Math.round(safeNum(c?.etaMinutes, 0) || 0));

    const cls = activeSignal ? classifyAssistantSignal(activeSignal) : null;
    const base = computeBaseAction(activeSignal, cls);
    state.baseActionCode = base.code;
    state.baseActionReason = base.reason;

    const localFastDecision = derivePrimaryDriverDecisionLocalFast(activeSignal, nearby.overall);
    const modeFlags = getAssistantGuidanceModeFlags();
    const guidanceKey = buildGuidanceCacheKey(state.lastFrameTime, state.lastUserLocation, modeFlags);
    state.lastGuidanceRequestKey = guidanceKey;
    let effectiveGuidance = null;
    if (guidanceKey && state.guidanceCache.has(guidanceKey)) {
      effectiveGuidance = normalizeServerGuidance(state.guidanceCache.get(guidanceKey));
      if (effectiveGuidance) {
        state.guidanceStatus = "ready";
        state.guidanceLastErrorCode = "";
        state.guidanceLastErrorMessage = "";
        state.lastSuccessfulGuidanceKey = guidanceKey;
        state.lastSuccessfulGuidanceAt = Date.now();
      } else {
        state.guidanceStatus = "error";
        state.guidanceLastErrorCode = "malformed_cached_payload";
        state.guidanceLastErrorMessage = "Cached guidance payload was malformed; using local guidance.";
      }
    } else if (guidanceKey) {
      state.guidanceStatus = state.guidanceInFlightKey === guidanceKey ? "loading" : state.guidanceStatus;
      if (state.guidanceEnrichRefreshKey !== guidanceKey) {
        state.guidanceEnrichRefreshKey = guidanceKey;
        fetchGuidance(liveFrame, state.lastUserLocation, modeFlags)
          .then((payload) => {
            if (state.guidanceEnrichRefreshKey !== guidanceKey) return;
            state.guidanceEnrichRefreshKey = "";
            if (payload) scheduleAssistantRecompute({ reason: "guidance-enriched", urgent: false });
          })
          .catch(() => {
            state.guidanceEnrichRefreshKey = "";
          });
      }
    } else {
      state.guidanceEnrichRefreshKey = "";
      state.guidanceStatus = "idle";
    }
    if (effectiveGuidance) {
      state.serverGuidance = effectiveGuidance;
      state.serverGuidanceUpdatedAt = Date.now();
      state.guidanceSource = "server";
    } else {
      state.serverGuidance = null;
      state.serverGuidanceUpdatedAt = 0;
      state.guidanceSource = "local";
    }

    const locationIds = [state.activeStableZoneId, ...shortlist.map((c) => c.signal.locationId)].filter(Boolean);
    const hasOutlookContext = !!state.lastFrameTime && locationIds.length > 0;
    const currentOutlookKey = hasOutlookContext
      ? buildOutlookCacheKey(state.lastFrameTime, locationIds, state.visibleScoreSource)
      : "";
    let effectiveOutlook = null;
    const hasCachedCurrentKey = !!currentOutlookKey && state.outlookCache.has(currentOutlookKey);
    if (hasCachedCurrentKey) {
      effectiveOutlook = state.outlookCache.get(currentOutlookKey) || null;
      state.outlookStatus = "ready";
      state.outlookLastErrorCode = "";
      state.outlookLastErrorMessage = "";
    } else if (hasOutlookContext) {
      state.outlookStatus = state.outlookInFlightKey === currentOutlookKey ? "loading" : state.outlookStatus;
      if (state.outlookEnrichRefreshKey !== currentOutlookKey) {
        state.outlookEnrichRefreshKey = currentOutlookKey;
        fetchOutlook(liveFrame, locationIds, state.visibleScoreSource)
          .then(() => {
            if (state.outlookEnrichRefreshKey !== currentOutlookKey) return;
            state.outlookEnrichRefreshKey = "";
            scheduleAssistantRecompute({ reason: "outlook-enriched", urgent: false });
          })
          .catch(() => {
            state.outlookEnrichRefreshKey = "";
          });
      }
    } else {
      state.outlookEnrichRefreshKey = "";
    }
    if (!effectiveOutlook && hasOutlookContext) {
      state.finalActionCode = state.finalActionCode || localFastDecision.actionCode;
      if (!state.recommendationReasonText || /checking more data/i.test(String(state.recommendationReasonText || ""))) {
        state.recommendationReasonText = localFastDecision.reasonText;
      }
      if (!state.finalActionReason || /checking more data/i.test(String(state.finalActionReason || ""))) {
        state.finalActionReason = localFastDecision.reasonText;
      }
      renderWidget();
      mirrorRecommendLine();
    }
    if (!effectiveOutlook
      && state.outlookStatus === "loading"
      && state.lastSuccessfulOutlookKey === currentOutlookKey
      && hasCachedCurrentKey) {
      effectiveOutlook = state.outlookCache.get(currentOutlookKey) || null;
    }
    const byId = buildOutlookPointsByLocation(effectiveOutlook);
    const currentPoints = byId?.[state.activeStableZoneId] || byId?.[String(state.activeStableZoneId)] || [];
    const evalCacheKey = `${getAssistantFrameKey(liveFrame)}|${state.activeStableZoneId || "none"}|${state.visibleScoreSource}|${shortlist.map((c) => c.signal.locationId).join(",")}`;
    let evaluated = state.assistantCandidateEvalCache.get(evalCacheKey) || null;
    if (!evaluated) {
      evaluated = [];
      for (const candidate of shortlist) {
        const targetPoints = byId?.[candidate.signal.locationId] || byId?.[String(candidate.signal.locationId)] || [];
        const evaluation = evaluateEconomicsAwareMoveCandidate(
          candidate.signal,
          activeSignal,
          targetPoints,
          currentPoints,
          candidate.etaMinutes,
          candidate.distanceMiles
        );
        evaluation.moveWorthThreshold = getAssistantMoveWorthThreshold(
          activeSignal,
          evaluation.currentTravelMetrics,
          evaluation.currentMetrics,
          evaluation.targetMetrics,
          evaluation.targetPaybackMetrics,
          evaluation.deadheadCost,
          evaluation.etaMinutes
        );
        evaluation.isWorthMoving = !!evaluation.viability?.viable && evaluation.netMoveEdge >= evaluation.moveWorthThreshold;
        evaluated.push(evaluation);
      }
      state.assistantCandidateEvalCache.set(evalCacheKey, evaluated);
      trimMapCache(state.assistantCandidateEvalCache, 10);
    }
    const picked = chooseBestEconomicsAwareTarget(evaluated, activeSignal);
    const bestNearEval = picked.bestNearEval || null;
    let bestWorthwhile = picked.bestWorthwhileTarget;
    const bestNotWorth = picked.bestRejectedTarget;
    state.chosenTargetGroup = picked.chosenTargetGroup || "none";
    state.chosenTargetReasoningMode = picked.chosenTargetReasoningMode || "collecting_context";
    state.sameBoroughNearCandidateCount = Array.isArray(picked.sameBoroughNearCandidates) ? picked.sameBoroughNearCandidates.length : 0;
    state.crossBoroughNearCandidateCount = Array.isArray(picked.crossBoroughNearCandidates) ? picked.crossBoroughNearCandidates.length : 0;
    state.farCandidateCount = safeNum(picked.farCandidateCount, 0) || 0;
    state.farCandidatesRejectedForDistance = safeNum(picked.farCandidatesRejectedForDistance, 0) || 0;
    state.bestArrivalAwareCandidate = bestWorthwhile;
    state.bestCandidateNotWorthMoving = bestNotWorth;

    const previewTargetSignal = resolvePreviewTargetSignal(state.committedMoveTarget || bestWorthwhile || bestNotWorth || null);
    const previewTargetPoints = previewTargetSignal?.locationId
      ? (byId?.[previewTargetSignal.locationId] || byId?.[String(previewTargetSignal.locationId)] || [])
      : [];
    const dataQuality = deriveAssistantDataQuality(currentPoints, previewTargetPoints, state.outlookStatus, currentOutlookKey);
    Object.assign(state, dataQuality);
    state.usedCachedRecommendationFallback = false;

    if (!state.canTrustFarMoves && bestWorthwhile && (safeNum(bestWorthwhile?.etaMinutes, Infinity) || Infinity) > AI_ASSISTANT_NEAR_TARGET_MAX_ETA_MIN) {
      bestWorthwhile = null;
    }

    const selectedForReason = bestWorthwhile || bestNotWorth;
    const strongHoldZone = !!selectedForReason?.currentMetrics?.stayHoldsAfterArrival
      && (safeNum(selectedForReason?.currentTravelMetrics?.travelWindowMinRating, 0) || 0) >= 52
      && !selectedForReason?.currentMetrics?.stayWeakensSoon;
    const trapState = deriveTrapCoachState(
      activeSignal,
      selectedForReason?.currentMetrics || {},
      bestWorthwhile
    );
    state.trapTimeScore = trapState.trapTimeScore;
    state.trapPickupScore = trapState.trapPickupScore;
    state.trapMovementScore = trapState.trapMovementScore;
    state.trapCompositeScore = trapState.trapCompositeScore;
    state.trapModeActive = trapState.trapModeActive;
    state.trapReasonSummary = trapState.trapReasonSummary;
    state.trapNeedsNearbyEscape = trapState.trapNeedsNearbyEscape;
    state.trapEscapeTarget = trapState.trapEscapeTarget;
    state.trapSeverityLevel = trapState.trapSeverityLevel;
    if (trapState.trapModeActive && !state.trapDetectedAtMs) state.trapDetectedAtMs = Date.now();
    if (!trapState.trapModeActive) state.trapDetectedAtMs = null;
    if (meaningfulRepositioned) {
      state.trapSuppressedUntilTs = Date.now() + AI_ASSISTANT_TRAP_SUPPRESS_MS;
      state.quietModeReason = "meaningful_reposition";
      state.trapModeActive = false;
      state.trapSeverityLevel = Math.max(0, (safeNum(state.trapSeverityLevel, 0) || 0) - 1);
      if (!state.trapReasonSummary) state.trapReasonSummary = "You made a meaningful move inside this area.";
    }
    if (Date.now() < (safeNum(state.trapSuppressedUntilTs, 0) || 0) && !isUrgentTrapCondition(trapState)) {
      state.trapModeActive = false;
      state.trapSeverityLevel = Math.min(1, safeNum(state.trapSeverityLevel, 0) || 0);
      if (!state.trapReasonSummary) state.trapReasonSummary = "Nearby options not strong enough yet.";
    }
    if (strongHoldZone && !isUrgentTrapCondition(trapState)) {
      state.quietModeReason = "good_hold_zone";
      state.trapModeActive = false;
      state.trapSeverityLevel = 0;
      state.trapReasonSummary = "Good zone right now.";
    }
    state.etaMinutes = selectedForReason?.etaMinutes ?? null;
    state.distanceMiles = selectedForReason?.distanceMiles ?? null;
    state.stayProjectedRating = selectedForReason?.currentMetrics?.stayArrivalProjectedRating ?? safeNum(activeSignal?.visibleRating, null);
    state.targetArrivalProjectedRating = selectedForReason?.targetMetrics?.targetArrivalProjectedRating ?? null;
    state.stayWindowAvgRating = selectedForReason?.currentMetrics?.stayWindowAvgRating ?? null;
    state.targetWindowAvgRating = selectedForReason?.targetMetrics?.targetWindowAvgRating ?? null;
    state.stayWindowMinRating = selectedForReason?.currentMetrics?.stayWindowMinRating ?? null;
    state.targetWindowMinRating = selectedForReason?.targetMetrics?.targetWindowMinRating ?? null;
    state.stayScenarioValue = selectedForReason?.stayScenarioValue ?? null;
    state.moveScenarioValue = selectedForReason?.moveScenarioValue ?? null;
    state.currentTravelWindowAvgRating = selectedForReason?.currentTravelMetrics?.travelWindowAvgRating ?? null;
    state.currentTravelWindowMinRating = selectedForReason?.currentTravelMetrics?.travelWindowMinRating ?? null;
    state.targetPaybackAvgRating = selectedForReason?.targetPaybackMetrics?.paybackAvgRating ?? null;
    state.targetPaybackMinRating = selectedForReason?.targetPaybackMetrics?.paybackMinRating ?? null;
    state.totalDeadheadCost = selectedForReason?.deadheadCost?.totalDeadheadCost ?? null;
    state.moveConfidencePenalty = selectedForReason?.confidencePenalty?.confidencePenalty ?? null;
    state.confidencePenaltyReasons = selectedForReason?.confidencePenalty?.confidencePenaltyReasons ?? [];
    state.netMoveEdge = selectedForReason?.netMoveEdge ?? null;
    state.moveWorthThreshold = selectedForReason?.moveWorthThreshold ?? null;
    state.targetViableOnArrival = selectedForReason?.viability?.viable ?? null;
    state.targetViabilityRejectCode = selectedForReason?.viability?.viabilityRejectCode ?? selectedForReason?.rejectionCode ?? null;
    state.targetViabilityRejectReasonText = selectedForReason?.viability?.viabilityRejectReasonText ?? selectedForReason?.rejectionReasonText ?? "";

    const safeOverrideDecision = deriveSafeFallbackDecision(activeSignal, state.dataQualityMode, bestNearEval);
    const canReuseLastGood = shouldReuseLastGoodRecommendation(state.activeStableZoneId, state.lastFrameTime, state.dataQualityMode);
    if (canReuseLastGood) {
      const cached = state.lastGoodRecommendationPayload || null;
      if (cached) {
        state.usedCachedRecommendationFallback = true;
        state.committedActionCode = cached.actionCode || state.committedActionCode || "MONITOR";
        state.committedReasonCode = cached.reasonCode || state.committedReasonCode || "checking_outlook";
        state.committedReasonText = cached.reasonText || state.committedReasonText || "Checking more data.";
        state.committedMoveTarget = cached.moveTarget || null;
        state.committedSinceTs = state.committedSinceTs || Date.now();
        state.recommendationConfidenceScore = cached.recommendationConfidenceScore ?? state.recommendationConfidenceScore;
        state.recommendationConfidenceLevel = cached.recommendationConfidenceLevel || state.recommendationConfidenceLevel || "low";
      }
    }

    const proposal = deriveProposedRecommendation(
      activeSignal,
      bestWorthwhile,
      bestNotWorth,
      selectedForReason?.currentMetrics || {},
      selectedForReason?.currentTravelMetrics || {},
      safeOverrideDecision
    );
    if (!state.usedCachedRecommendationFallback) {
      state.recommendationConfidenceScore = proposal.recommendationConfidenceScore;
      state.recommendationConfidenceLevel = proposal.recommendationConfidenceLevel;
    }
    if (!state.usedCachedRecommendationFallback) {
      stabilizeAssistantRecommendation(proposal, Date.now());
    }

    const outlookMoveTarget = (state.committedMoveTarget || proposal?.moveTarget || null);
    const targetPoints = outlookMoveTarget ? (byId?.[outlookMoveTarget.locationId] || byId?.[String(outlookMoveTarget.locationId)] || []) : [];
    state.currentZoneOutlook = interpretOutlookPoints(currentPoints, activeSignal);
    state.moveTargetOutlook = interpretOutlookPoints(targetPoints, outlookMoveTarget);
    Object.assign(state, state.currentZoneOutlook || {});
    const hasSuccessfulPayloadForCurrentKey = !!currentOutlookKey
      && state.lastSuccessfulOutlookKey === currentOutlookKey
      && state.outlookCache.has(currentOutlookKey);
    const hasCurrentPoints = Array.isArray(currentPoints) && currentPoints.length > 0;
    if (hasCurrentPoints) {
      state.outlookSummaryText = state.currentZoneOutlook?.outlookSummaryText || "Outlook is mixed.";
      state.moveTargetOutlookSummaryText = state.moveTargetOutlook?.outlookSummaryText || "";
    } else if (hasSuccessfulPayloadForCurrentKey) {
      state.outlookSummaryText = "Outlook is mixed.";
      state.moveTargetOutlookSummaryText = "";
    } else if (state.outlookStatus === "loading") {
      state.outlookSummaryText = "Checking more data.";
      state.moveTargetOutlookSummaryText = "";
    } else if (state.outlookStatus === "error") {
      state.outlookSummaryText = "Outlook temporarily unavailable.";
      state.moveTargetOutlookSummaryText = "";
    } else if (!state.activeStableZoneId || !state.lastFrameTime) {
      state.outlookSummaryText = "Outlook unavailable.";
      state.moveTargetOutlookSummaryText = "";
    } else {
      state.outlookSummaryText = "Outlook is mixed.";
      state.moveTargetOutlookSummaryText = "";
    }

    if (state.dataQualityMode !== "full" && (safeNum(state.committedMoveTarget?.etaMinutes, Infinity) || Infinity) > AI_ASSISTANT_NEAR_TARGET_MAX_ETA_MIN) {
      state.committedMoveTarget = null;
      if (isMoveAction(state.committedActionCode)) {
        state.committedActionCode = "MONITOR";
        state.committedReasonCode = "checking_outlook";
        state.committedReasonText = "Checking more data.";
      }
    }
    state.assistantMoveTarget = state.committedMoveTarget || null;
    state.recommendationReasonCode = state.committedReasonCode || proposal.reasonCode;
    state.recommendationReasonText = deriveStableRecommendationReason(
      { reasonText: state.committedReasonText || proposal.reasonText },
      state.stabilityReasonCode,
      state.stabilityReasonText
    );
    state.recommendationWorthMoving = !!proposal.recommendationWorthMoving;
    state.finalActionCode = state.committedActionCode || proposal.actionCode;
    state.finalActionReason = state.recommendationReasonText;
    state.actionSeverity = (state.finalActionCode === "LEAVE_NOW" || state.finalActionCode === "MOVE_SOON") ? "move" : (state.finalActionCode === "STAY" ? "positive" : "info");
    if (state.dataQualityMode !== "full" && state.finalActionCode === "MOVE_SOON" && !state.assistantMoveTarget) {
      state.finalActionCode = "MONITOR";
      state.finalActionReason = "Checking more data.";
      state.recommendationReasonText = "Checking more data.";
    }
    const nowTs = Date.now();
    const countdownCoach = deriveCountdownCoach(
      activeSignal,
      bestWorthwhile,
      selectedForReason?.currentMetrics || {},
      selectedForReason?.currentTravelMetrics || {},
      state.dataQualityMode,
      trapState
    );
    const currentCountdownEval = state.countdownTarget?.locationId
      ? (evaluated.find((it) => String(it?.candidateSignal?.locationId || "") === String(state.countdownTarget.locationId)) || null)
      : null;
    let selectedCountdownTarget = countdownCoach?.target || null;
    if (state.countdownActive && state.countdownTarget?.locationId && selectedCountdownTarget?.locationId) {
      const canReplace = shouldReplaceCountdownTarget(state.countdownTarget, selectedCountdownTarget);
      if (!canReplace) selectedCountdownTarget = state.countdownTarget;
    }
    const selectedCountdownEval = selectedCountdownTarget?.locationId
      ? (evaluated.find((it) => String(it?.candidateSignal?.locationId || "") === String(selectedCountdownTarget.locationId)) || null)
      : null;
    const countdownTargetStillValid = isCountdownTargetStillValid(
      selectedCountdownEval || currentCountdownEval || bestWorthwhile,
      activeSignal,
      selectedForReason?.currentMetrics || {},
      state.dataQualityMode
    );
    const nextTargetId = String(selectedCountdownTarget?.locationId || "").trim();
    const activeTargetId = String(state.countdownTarget?.locationId || "").trim();
    const countdownTargetChanged = !!activeTargetId && !!nextTargetId && nextTargetId !== activeTargetId;
    const goodHoldNow = !!selectedForReason?.currentMetrics?.stayHoldsAfterArrival
      && (safeNum(selectedForReason?.currentTravelMetrics?.travelWindowMinRating, 0) || 0) >= 50
      && !selectedForReason?.currentMetrics?.stayWeakensSoon;
    const shouldCancelCountdown = !countdownCoach.eligible
      || !selectedCountdownTarget
      || !countdownTargetStillValid
      || (hasPickupSinceCurrentZoneEntry() && !(trapState?.trapModeActive))
      || goodHoldNow;
    if (shouldCancelCountdown) {
      if (state.countdownActive && goodHoldNow) {
        state.countdownSuppressedUntilTs = nowTs + AI_ASSISTANT_COUNTDOWN_SUPPRESS_MS;
        state.quietModeReason = "hold_improved";
      }
      resetCountdownCoachState();
      state.countdownHoldWindowReason = goodHoldNow ? "Stay • Good zone right now" : (countdownCoach.holdWindowReason || "");
    } else {
      const countdownChanged = nextTargetId !== activeTargetId
        || String(state.countdownReasonCode || "") !== String(countdownCoach.reasonCode || "");
      if (!state.countdownActive || !state.countdownStartTs || !state.countdownDeadlineTs || countdownChanged) {
        state.countdownStartTs = nowTs;
        state.countdownDeadlineTs = state.countdownStartTs + ((safeNum(countdownCoach.durationMin, 5) || 5) * 60000);
      }
      state.countdownEligible = true;
      state.countdownActive = true;
      state.countdownReasonCode = countdownCoach.reasonCode || "";
      state.countdownReasonText = countdownCoach.reasonText || "";
      state.countdownTarget = selectedCountdownTarget || null;
      if (selectedCountdownTarget?.locationId && !state.lastCountdownTargetId) {
        state.lastCountdownTargetId = String(selectedCountdownTarget.locationId).trim();
        state.lastCountdownTargetChangedAtTs = nowTs;
      }
      if (countdownTargetChanged) {
        state.lastCountdownTargetId = String(selectedCountdownTarget?.locationId || "").trim() || null;
        state.lastCountdownTargetChangedAtTs = nowTs;
      }
      state.countdownEscalationLevel = safeNum(countdownCoach.escalationLevel, 0) || 0;
      state.countdownMinutesRemaining = Math.max(0, Math.ceil((state.countdownDeadlineTs - nowTs) / 60000));
      if (state.countdownMinutesRemaining <= 0) {
        const recheckValid = isCountdownTargetStillValid(
          selectedCountdownEval || currentCountdownEval || bestWorthwhile,
          activeSignal,
          selectedForReason?.currentMetrics || {},
          state.dataQualityMode
        );
        if (recheckValid && isMoveAction(state.finalActionCode)
          && String(state.assistantMoveTarget?.locationId || "") === String(state.countdownTarget?.locationId || "")) {
          state.stabilityReasonCode = "countdown_expired_move_promoted";
          state.stabilityReasonText = "Countdown finished. Move now.";
        } else {
          state.countdownSuppressedUntilTs = nowTs + AI_ASSISTANT_COUNTDOWN_SUPPRESS_MS;
          state.quietModeReason = "countdown_expired_recheck_failed";
          state.finalActionCode = "STAY";
          const tooFar = (safeNum(state.assistantMoveTarget?.etaMinutes, Infinity) || Infinity) > AI_ASSISTANT_NEAR_TARGET_MAX_ETA_MIN;
          state.recommendationReasonCode = tooFar ? "moving_not_worth_it" : "nearby_options_not_strong";
          state.recommendationReasonText = tooFar ? "Other areas are too far right now" : "Nearby options not strong enough yet";
          state.finalActionReason = state.recommendationReasonText;
        }
        resetCountdownCoachState();
      }
    }
    if (!bestWorthwhile && !bestNotWorth) {
      resetCountdownCoachState();
    }
    if (state.countdownReasonCode === "good_hold_window" || (state.finalActionCode === "STAY" && !bestWorthwhile)) {
      resetCountdownCoachState();
      state.countdownHoldWindowReason = "Stay • Good zone right now";
    }
    state.dwellCoachSummaryText = `${humanActionLabel(state.finalActionCode)}: ${state.recommendationReasonText}`;
    state.dwellCoachReasonFragments = [
      `Current area ${(state.stayWindowAvgRating || state.stayProjectedRating || 0).toFixed(1)}`,
      `Nearby area ${(state.targetPaybackAvgRating || state.targetArrivalProjectedRating || 0).toFixed(1)}`,
      `Drive time ${Math.round(state.etaMinutes || 0)} min`
    ];

    const canCacheLastGoodRecommendation = !!state.activeStableZoneId
      && !!state.committedActionCode
      && state.dataQualityMode === "full"
      && (state.recommendationConfidenceLevel === "medium" || state.recommendationConfidenceLevel === "high")
      && state.committedActionCode !== "MONITOR"
      && (!isMoveAction(state.committedActionCode) || !!state.committedMoveTarget);
    if (canCacheLastGoodRecommendation) {
      state.lastGoodRecommendationZoneId = String(state.activeStableZoneId || "");
      state.lastGoodRecommendationFrameTime = String(state.lastFrameTime || "");
      state.lastGoodRecommendationSavedAt = Date.now();
      state.lastGoodRecommendationPayload = {
        actionCode: state.committedActionCode,
        reasonCode: state.committedReasonCode,
        reasonText: state.committedReasonText,
        moveTarget: state.committedMoveTarget,
        recommendationConfidenceScore: state.recommendationConfidenceScore,
        recommendationConfidenceLevel: state.recommendationConfidenceLevel,
      };
    }
    applyNavOwnership();
    mirrorRecommendLine();
    renderWidget();
    state.lastFullAssistantRecomputeAtMs = Date.now();
    state.lastFullAssistantRecomputeZoneId = state.activeStableZoneId || null;
    state.lastFullAssistantRecomputeFrameTime = state.lastFrameTime || null;
    state.lastFullAssistantRecomputeLat = Number.isFinite(state.lastUserLocation?.lat) ? state.lastUserLocation.lat : null;
    state.lastFullAssistantRecomputeLng = Number.isFinite(state.lastUserLocation?.lng) ? state.lastUserLocation.lng : null;
    if (zoneChanged) window.dispatchEvent(new CustomEvent("tlc-ai-assistant-snapshot-updated", { detail: snapshot() }));
    emitSnapshotEvents();
  }

  function scheduleAssistantRecompute({ reason = "unknown", urgent = false, frame = null } = {}) {
    if (frame) state.assistantRecomputePendingFrame = frame;
    state.assistantRecomputePendingUrgent = state.assistantRecomputePendingUrgent || !!urgent;
    state.assistantRecomputePendingReasons.add(String(reason || "unknown"));
    if (urgent) {
      if (state.assistantRecomputeRaf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(state.assistantRecomputeRaf);
      if (state.assistantRecomputeTimer) clearTimeout(state.assistantRecomputeTimer);
      state.assistantRecomputeRaf = null;
      state.assistantRecomputeTimer = null;
      const pendingFrame = state.assistantRecomputePendingFrame;
      state.assistantRecomputePendingFrame = null;
      const urgentFlag = state.assistantRecomputePendingUrgent;
      state.assistantRecomputePendingUrgent = false;
      state.assistantRecomputePendingReasons.clear();
      recompute(pendingFrame, { urgent: urgentFlag }).catch(() => {});
      return;
    }
    if (state.assistantRecomputeRaf || state.assistantRecomputeTimer) return;
    if (typeof requestAnimationFrame === "function") {
      state.assistantRecomputeRaf = requestAnimationFrame(() => {
        state.assistantRecomputeRaf = null;
        const pendingFrame = state.assistantRecomputePendingFrame;
        state.assistantRecomputePendingFrame = null;
        const urgentFlag = state.assistantRecomputePendingUrgent;
        state.assistantRecomputePendingUrgent = false;
        state.assistantRecomputePendingReasons.clear();
        recompute(pendingFrame, { urgent: urgentFlag }).catch(() => {});
      });
    } else {
      state.assistantRecomputeTimer = setTimeout(() => {
        state.assistantRecomputeTimer = null;
        const pendingFrame = state.assistantRecomputePendingFrame;
        state.assistantRecomputePendingFrame = null;
        const urgentFlag = state.assistantRecomputePendingUrgent;
        state.assistantRecomputePendingUrgent = false;
        state.assistantRecomputePendingReasons.clear();
        recompute(pendingFrame, { urgent: urgentFlag }).catch(() => {});
      }, 48);
    }
  }

  function startHeartbeat() {
    const hasStable = !!state.activeStableZoneId;
    const hasPreStableContext = !hasStable && (!!state.candidateZoneId || !!state.lastUserLocation);
    const mode = hasStable ? "stable" : (hasPreStableContext ? "prestable" : "off");
    const key = `${mode}|${document.hidden ? "hidden" : "visible"}`;
    if (state.heartbeatKey === key) return;
    state.heartbeatKey = key;
    if (state.heartbeatHandle && runtimePolling) runtimePolling.clearInterval(state.heartbeatHandle);
    if (state.heartbeatHandle && !runtimePolling) clearInterval(state.heartbeatHandle);
    state.heartbeatHandle = null;
    if (mode === "off") return;
    const ms = hasStable
      ? (document.hidden ? AI_ASSISTANT_HEARTBEAT_MS_HIDDEN : AI_ASSISTANT_HEARTBEAT_MS_VISIBLE)
      : AI_ASSISTANT_PRE_STABLE_HEARTBEAT_MS;
    if (runtimePolling) {
      const id = `ai-assistant-heartbeat-${document.hidden ? "hidden" : "visible"}`;
      runtimePolling.setInterval(id, () => scheduleAssistantRecompute({ reason: "heartbeat", urgent: false }), ms);
      state.heartbeatHandle = id;
    } else {
      state.heartbeatHandle = setInterval(() => { scheduleAssistantRecompute({ reason: "heartbeat", urgent: false }); }, ms);
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
    scheduleAssistantRecompute({ reason: "location-updated", urgent: false });
    startHeartbeat();
  }

  function updateAssistantForFrame(frame) {
    scheduleAssistantRecompute({ reason: "frame-update", urgent: true, frame });
    startHeartbeat();
  }

  function clearState() {
    state.activeStableZoneId = null;
    state.activeStableZoneName = "";
    state.activeStableBorough = "";
    state.activeStableZoneEnterTs = null;
    state.activeStableZoneDwellMs = 0;
    state.assistantMoveTarget = null;
    state.proposedActionCode = null;
    state.proposedReasonCode = null;
    state.proposedReasonText = "";
    state.proposedMoveTarget = null;
    state.proposedNetMoveEdge = null;
    state.proposedWorthThreshold = null;
    state.proposedSinceTs = null;
    state.proposedStableHits = 0;
    state.committedActionCode = null;
    state.committedReasonCode = null;
    state.committedReasonText = "";
    state.committedMoveTarget = null;
    state.committedSinceTs = null;
    state.recommendationSwitchCooldownUntilTs = 0;
    state.recommendationMinHoldUntilTs = 0;
    state.recommendationStickyTargetId = null;
    state.recommendationStickyTargetSinceTs = null;
    state.stabilityReasonCode = "";
    state.stabilityReasonText = "";
    state.dataQualityMode = "degraded";
    state.dataQualityLabel = "degraded";
    state.dataQualityReason = "Checking more data.";
    state.currentPointsCount = 0;
    state.targetPointsCount = 0;
    state.hasRecentSuccessfulOutlook = false;
    state.isUsingCachedOutlook = false;
    state.isPartialOutlook = false;
    state.canTrustFarMoves = false;
    state.usedCachedRecommendationFallback = false;
    state.guidanceStatus = "idle";
    state.guidanceLastErrorCode = "";
    state.guidanceLastErrorMessage = "";
    state.serverGuidance = null;
    state.serverGuidanceUpdatedAt = 0;
    state.guidanceSource = "local";
    state.lastGuidanceRequestKey = "";
    state.lastSuccessfulGuidanceKey = "";
    state.lastSuccessfulGuidanceAt = 0;
    state.guidanceEnrichRefreshKey = "";
    state.lastGuidancePrimaryLine = "";
    state.lastGuidanceSecondaryLine = "";
    resetCountdownCoachState();
    state.lastPickupRecordedAtMs = null;
    state.lastPickupRecordedZoneId = null;
    state.stableZoneEntryUserLocation = null;
    state.lastMeaningfulRepositionAtMs = null;
    state.lastMeaningfulRepositionDistanceMiles = 0;
    state.sameZonePickupCountSinceEntry = 0;
    state.sameZonePickupCountRolling = 0;
    state.trapMovementScore = 0;
    state.trapPickupScore = 0;
    state.trapTimeScore = 0;
    state.trapCompositeScore = 0;
    state.trapModeActive = false;
    state.trapDetectedAtMs = null;
    state.trapReasonSummary = "";
    state.trapNeedsNearbyEscape = false;
    state.trapEscapeTarget = null;
    state.trapSeverityLevel = 0;
    state.recentZoneMovementSamples = [];
    state.countdownSuppressedUntilTs = 0;
    state.trapSuppressedUntilTs = 0;
    state.lastCountdownTargetId = null;
    state.lastCountdownTargetChangedAtTs = 0;
    state.lastTrapMessageAtTs = 0;
    state.lastStayMessageAtTs = 0;
    state.lastMoveMessageAtTs = 0;
    state.quietModeReason = "";
    state.finalActionCode = "MONITOR";
    state.finalActionReason = "Waiting for stable zone.";
    state.lastAssistantRenderKey = "";
    state.lastRecommendLineKey = "";
    state.lastLightPassPrimaryLine = "";
    state.lastLightPassSecondaryLine = "";
    if (state.assistantRecomputeRaf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(state.assistantRecomputeRaf);
    if (state.assistantRecomputeTimer) clearTimeout(state.assistantRecomputeTimer);
    state.assistantRecomputeRaf = null;
    state.assistantRecomputeTimer = null;
    renderWidget();
    mirrorRecommendLine();
  }

  function forceRefresh() {
    scheduleAssistantRecompute({ reason: "force-refresh", urgent: true });
    startHeartbeat();
  }

  function toggleExpanded() { state.expanded = !state.expanded; renderWidget(); }
  function toggleRankingsExpanded() { state.rankingsExpanded = !state.rankingsExpanded; renderWidget(); }
  function toggleOutlookExpanded() { state.outlookExpanded = !state.outlookExpanded; renderWidget(); }
  function toggleDwellExpanded() { state.dwellExpanded = !state.dwellExpanded; renderWidget(); }

  function attachEvents() {
    window.addEventListener("tlc-user-location-updated", (e) => handleUserLocationUpdate(e?.detail || {}));
    window.addEventListener("team-joseo-frame-rendered", () => scheduleAssistantRecompute({ reason: "frame-rendered", urgent: true }));
    window.addEventListener("tlc-mode-changed", () => scheduleAssistantRecompute({ reason: "mode-changed", urgent: true }));
    window.addEventListener("tlc-pickup-recorded", (e) => {
      const detail = e?.detail || {};
      state.lastPickupRecordedAtMs = Date.now();
      state.lastPickupRecordedZoneId = detail?.zoneId ? String(detail.zoneId) : null;
      state.countdownSuppressedUntilTs = state.lastPickupRecordedAtMs + AI_ASSISTANT_PICKUP_SUPPRESS_MS;
      state.trapSuppressedUntilTs = state.lastPickupRecordedAtMs + AI_ASSISTANT_PICKUP_SUPPRESS_MS;
      state.quietModeReason = "pickup_recent";
      if (state.activeStableZoneId && state.lastPickupRecordedZoneId
        && String(state.lastPickupRecordedZoneId) === String(state.activeStableZoneId)) {
        state.sameZonePickupCountSinceEntry = (safeNum(state.sameZonePickupCountSinceEntry, 0) || 0) + 1;
        state.sameZonePickupCountRolling = (safeNum(state.sameZonePickupCountRolling, 0) || 0) + 1;
      } else if (state.lastPickupRecordedZoneId && state.activeStableZoneId
        && String(state.lastPickupRecordedZoneId) !== String(state.activeStableZoneId)) {
        state.sameZonePickupCountSinceEntry = 0;
        state.sameZonePickupCountRolling = Math.max(0, Math.floor((safeNum(state.sameZonePickupCountRolling, 0) || 0) * 0.5));
      }
      resetCountdownCoachState();
      scheduleAssistantRecompute({ reason: "pickup-recorded", urgent: true });
    });
    document.addEventListener("visibilitychange", () => { startHeartbeat(); updateAssistantDockLayout(); });
    document.addEventListener("click", (e) => {
      const action = e.target?.closest?.("[data-ai-action]")?.getAttribute("data-ai-action");
      if (!action) return;
      if (action === "toggle-expanded") toggleExpanded();
    });
    if (dockMount) {
      dockMount.addEventListener("mouseenter", () => { state.hoverPaused = true; clearMessageRotationTimer(); });
      dockMount.addEventListener("mouseleave", () => { state.hoverPaused = false; });
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
