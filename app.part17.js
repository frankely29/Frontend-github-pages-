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
    outlookStatus: "idle",
    outlookLastErrorCode: "",
    outlookLastErrorMessage: "",
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
    const allCandidates = [];
    const currentBorough = normalizeAssistantBoroughName(currentSignal?.borough);
    for (const feature of (frame?.polygons?.features || [])) {
      const signal = buildAssistantFeatureSignal(feature);
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
    const mergedByLocationId = new Map();
    [baseTopByQuickScore, guaranteedNearCandidates, guaranteedSameBoroughNearCandidates].forEach((bucket) => {
      (bucket || []).forEach((candidate) => {
        const id = String(candidate?.signal?.locationId || "").trim();
        if (!id) return;
        const existing = mergedByLocationId.get(id);
        if (!existing || (safeNum(candidate?.quickScore, -Infinity) || -Infinity) > (safeNum(existing?.quickScore, -Infinity) || -Infinity)) {
          mergedByLocationId.set(id, candidate);
        }
      });
    });
    return [...mergedByLocationId.values()].sort((a, b) => b.quickScore - a.quickScore).slice(0, 12);
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
    const bestWorthwhileTarget = bestSameBoroughNear || bestCrossBoroughNear || bestFarAllowed || null;

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
      chosenTargetGroup: bestSameBoroughNear ? "same_borough_near" : (bestCrossBoroughNear ? "near" : (bestFarAllowed ? "far_exception" : "none")),
      chosenTargetReasoningMode: bestSameBoroughNear || bestCrossBoroughNear
        ? "practical_near_preference"
        : (bestFarAllowed ? "far_target_exception" : "stay_not_worth_moving"),
    };
  }

  function deriveNoWasteStayDecision(currentSignal, bestWorthwhileTarget, bestRejectedTarget, currentMetrics, currentTravelMetrics) {
    if (bestWorthwhileTarget) return null;
    if (bestRejectedTarget && (safeNum(bestRejectedTarget?.netMoveEdge, -Infinity) || -Infinity) < (safeNum(bestRejectedTarget?.moveWorthThreshold, Infinity) || Infinity)) {
      return { actionCode: "STAY", reasonCode: "moving_not_worth_it", reasonText: "Moving is not worth the time", worthMoving: false };
    }
    if (!bestRejectedTarget?.viability?.viable && ["trap_at_arrival", "slow_at_arrival", "saturation_at_arrival", "target_chasey", "long_eta_no_hold"].includes(bestRejectedTarget?.viability?.viabilityRejectCode)) {
      return { actionCode: "STAY", reasonCode: "target_weak_on_arrival", reasonText: "Target weak by the time you get there", worthMoving: false };
    }
    if (currentMetrics?.stayHoldsAfterArrival && (safeNum(currentTravelMetrics?.travelWindowMinRating, 0) || 0) >= 46) {
      return { actionCode: "STAY", reasonCode: "current_zone_holds", reasonText: "Current zone still holds on arrival", worthMoving: false };
    }
    if ((safeNum(currentSignal?.visibleRating, 0) || 0) >= 48) {
      return { actionCode: "STAY", reasonCode: "decent_rating_zone", reasonText: "Decent rating zone", worthMoving: false };
    }
    return { actionCode: "STAY", reasonCode: "moving_not_worth_it", reasonText: "Moving is not worth the time", worthMoving: false };
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
    let dataQualityReason = "Checking outlook.";
    if (!hasCurrent || outlookStatus === "error" || noSuccessfulForCurrentKey) {
      dataQualityMode = "degraded";
      dataQualityReason = outlookStatus === "error"
        ? "Outlook temporarily unavailable."
        : "Checking outlook.";
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
        return { actionCode: "STAY", reasonCode: "decent_rating_zone", reasonText: "Decent rating zone", worthMoving: false };
      }
      return { actionCode: "MONITOR", reasonCode: "checking_outlook", reasonText: "Checking outlook.", worthMoving: false };
    }
    if (dataQualityMode === "partial" && !strongNearTarget && currentRating >= 45) {
      return { actionCode: "STAY", reasonCode: "moving_not_worth_it", reasonText: "Moving is not worth the time", worthMoving: false };
    }
    if (dataQualityMode === "partial" && strongNearTarget) {
      return { actionCode: "MOVE_SOON", reasonCode: "near_target_clear_edge", reasonText: "Near target has a clear edge", worthMoving: true };
    }
    return null;
  }

  function deriveAssistantRecommendationReason(currentSignal, currentMetrics, bestWorthwhileTarget, bestRejectedTarget, currentTravelMetrics) {
    if (!currentSignal?.locationId) {
      return { actionCode: "MONITOR", reasonCode: "collecting_context", reasonText: "Collecting more context.", worthMoving: false };
    }
    if (bestWorthwhileTarget) {
      const currentCls = classifyAssistantSignal(currentSignal || {});
      if (currentCls?.shortTrap || currentMetrics?.stayTrapAtArrival) {
        return { actionCode: "MOVE_SOON", reasonCode: "low_trip_trap_risk", reasonText: "Risk of low-trip trap", worthMoving: true };
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
    if (stabilityReasonCode === "move_edge_not_far_enough") return "Moving is not worth the time";
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

  function isCompactLaneMode() {
    return document.getElementById("aiAssistantDock")?.dataset?.aiCompactLane === "1";
  }

  function isSafeDegradedStayFallback() {
    if (state.dataQualityMode !== "degraded") return false;
    if (state.finalActionCode !== "STAY") return false;
    if (state.assistantMoveTarget) return false;
    return ["good_zone_now", "decent_rating_zone", "moving_not_worth_it"].includes(String(state.recommendationReasonCode || "").trim());
  }

  function buildAssistantPrimaryLine() {
    if (isSafeDegradedStayFallback()) {
      const reasonText = state.recommendationReasonText || state.committedReasonText || state.finalActionReason;
      return `Stay • ${humanizeAssistantReason(reasonText)}`;
    }
    if (state.dataQualityMode === "degraded" && state.finalActionCode === "MONITOR") return "Monitor • Checking outlook.";
    const committedAction = state.committedActionCode || "MONITOR";
    const committedReason = state.committedReasonText || state.recommendationReasonText || state.finalActionReason;
    const action = humanActionLabel(committedAction);
    const reason = humanizeAssistantReason(committedReason);
    if (state.usedCachedRecommendationFallback && state.dataQualityMode !== "full") {
      return `${action} • ${reason} (recent fallback)`;
    }
    return `${action} • ${reason}`;
  }

  function buildAssistantSecondaryLine() {
    const committedAction = state.committedActionCode || "MONITOR";
    const committedTarget = state.committedMoveTarget || state.assistantMoveTarget || null;
    const weakDataMode = state.dataQualityMode === "partial" || state.dataQualityMode === "degraded";
    if (isSafeDegradedStayFallback()) return "Stay here for now";
    if (state.dataQualityMode === "degraded" && state.finalActionCode === "MONITOR") return "Waiting for clearer signal";
    if (weakDataMode && (!committedTarget || (safeNum(committedTarget?.etaMinutes, Infinity) || Infinity) > AI_ASSISTANT_NEAR_TARGET_MAX_ETA_MIN)) {
      return committedAction === "STAY" ? "Stay here for now" : "Waiting for clearer signal";
    }
    if ((committedAction === "MOVE_SOON" || committedAction === "LEAVE_NOW")
      && committedTarget?.zoneName
      && Number.isFinite(committedTarget?.etaMinutes)) {
      return `Go to ${committedTarget.zoneName} • ${Math.round(committedTarget.etaMinutes)} min`;
    }
    if (committedAction === "STAY") return "Stay here for now";
    if (committedAction === "STAY_BRIEFLY") return "Stay here briefly";
    if (committedAction === "MONITOR") return "Waiting for clearer signal";
    return "Waiting for clearer signal";
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
    const compactLane = isCompactLaneMode();
    const list = [];
    const primary = buildAssistantPrimaryLine();
    list.push({ key: "action", text: primary, severity: severityForAction(state.finalActionCode) });

    const allowTargetInCompact = state.dataQualityMode === "full"
      || ((safeNum(state.assistantMoveTarget?.etaMinutes, Infinity) || Infinity) <= AI_ASSISTANT_NEAR_TARGET_MAX_ETA_MIN);
    if (state.assistantMoveTarget?.zoneName && Number.isFinite(state.assistantMoveTarget?.etaMinutes) && allowTargetInCompact) {
      const targetSummary = compactLane
        ? `Target ${state.assistantMoveTarget.zoneName}`
        : `Go to ${state.assistantMoveTarget.zoneName} • ${Math.round(state.assistantMoveTarget.etaMinutes || 0)} min`;
      if (!primary.includes(targetSummary)) {
        list.push({ key: "target", text: targetSummary, severity: "info" });
      }
    }

    if (!compactLane && state.targetStrongUntilTime) {
      const until = internals.formatNYCTimeOnlyLabel?.(state.targetStrongUntilTime) || state.targetStrongUntilTime;
      list.push({ key: "target_window", text: `Target stronger through ${until}.`, severity: "info" });
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
      if (state.dataQualityMode === "degraded") {
        finalized = [{ key: "action", text: "Monitor • Checking outlook.", severity: "info" }];
      } else if (state.dataQualityMode === "partial" && !state.assistantMoveTarget) {
        finalized = [{ key: "action", text: "Stay • Moving is not worth the time", severity: "caution" }];
      }
    }
    if (!finalized.length) {
      finalized.push({ key: "fallback", text: "Monitor: Mixed signals.", severity: "info" });
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
    if (isSafeDegradedStayFallback()) {
      const reasonText = state.recommendationReasonText || state.committedReasonText || state.finalActionReason;
      recommendLine.textContent = `AI Assistant: Stay • ${humanizeAssistantReason(reasonText)} • Stay here for now`;
      return;
    }
    if (state.dataQualityMode === "degraded" && state.finalActionCode === "MONITOR") {
      recommendLine.textContent = "AI Assistant: Monitor • Checking outlook. • Waiting for clearer signal";
      return;
    }
    const committedAction = state.committedActionCode || state.finalActionCode || "MONITOR";
    const action = humanActionLabel(committedAction);
    const reason = state.committedReasonText || state.recommendationReasonText || humanizeAssistantReason(state.finalActionReason);
    let mirror = `AI Assistant: ${action} • ${reason}`;
    if ((committedAction === "MOVE_SOON" || committedAction === "LEAVE_NOW") && state.assistantMoveTarget?.zoneName && Number.isFinite(state.assistantMoveTarget?.etaMinutes)) {
      mirror += ` • Go to ${state.assistantMoveTarget.zoneName} • ${Math.round(state.assistantMoveTarget.etaMinutes)} min`;
    } else if (committedAction === "STAY") {
      mirror += " • Stay here for now";
    } else if (committedAction === "STAY_BRIEFLY") {
      mirror += " • Stay here briefly";
    } else if (committedAction === "MONITOR") {
      mirror += " • Waiting for clearer signal";
    }
    recommendLine.textContent = mirror;
  }

  function renderWidget() {
    if (!dockMount) return;
    const compactLane = isCompactLaneMode();
    buildMessages();
    const primaryLine = buildAssistantPrimaryLine();
    const secondaryLine = buildAssistantSecondaryLine();
    const iconType = leadingIconKindFromAction(state.finalActionCode);

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
    if (state.chosenTargetGroup === "same_borough_near") return "Why this target: same-borough practical move";
    if (state.chosenTargetGroup === "near") return "Why this target: closer strong zone";
    if (state.chosenTargetGroup === "far_exception") return "Why this target: far target exception";
    if (state.chosenTargetReasoningMode === "stay_not_worth_moving") return "Why staying: moving is not worth the time";
    if (state.targetViabilityRejectReasonText) return `Why staying: ${state.targetViabilityRejectReasonText}`;
    return "Why staying: moving is not worth the time";
  }

  function buildPanelHtml() {
    const trustModeLine = state.dataQualityMode === "full"
      ? "Trust mode: full"
      : (state.usedCachedRecommendationFallback
          ? `Trust mode: ${state.dataQualityMode} — using recent same-zone fallback`
          : `Trust mode: ${state.dataQualityMode} — ${humanizeAssistantReason(state.dataQualityReason || "Checking outlook.")}`);
    return `
      <div class="aiAssistantPanel">
        <section class="aiAssistantSection"><strong>Current Zone</strong><div>${state.activeStableZoneName || "—"} • ${state.activeStableBorough || "—"} • ${Math.round(state.visibleRating || 0)} ${prettyBucket(state.visibleBucket)} • ${state.visibleScoreSourceLabel}</div></section>
        <section class="aiAssistantSection"><strong>Stay Coach</strong><div>${state.dwellCoachSummaryText}</div><div>${state.dwellCoachReasonFragments.join(" • ")}</div></section>
        <section class="aiAssistantSection"><strong>Outlook</strong><div>${state.outlookSummaryText}</div><div>${state.moveTargetOutlookSummaryText || ""}</div>${(state.outlookStatus || state.outlookLastErrorCode) ? `<div><small>Status: ${state.outlookStatus || "idle"}${state.outlookLastErrorCode ? ` (${state.outlookLastErrorCode})` : ""}</small></div>` : ""}</section>
        <section class="aiAssistantSection"><strong>Rankings</strong><div>Best now: ${state.citywideBestNow?.zoneName || "—"} • Worst now: ${state.citywideWorstNow?.zoneName || "—"}</div>${buildRankList(state.citywideTop10Best)}${buildRankList(state.boroughTop5Best)}</section>
        ${state.assistantMoveTarget ? `<section class="aiAssistantSection"><strong>Move Target</strong><div>${state.assistantMoveTarget.zoneName} • ${Math.round(state.assistantMoveTarget.etaMinutes || 0)} min • ${state.assistantMoveTarget.distanceMiles.toFixed(1)} mi</div></section>` : ""}
        ${(Number.isFinite(state.stayScenarioValue) || Number.isFinite(state.moveScenarioValue)) ? `<section class="aiAssistantSection"><strong>Move Decision</strong><div>Stay scenario: ${(state.stayScenarioValue || 0).toFixed(1)}</div><div>Move scenario: ${(state.moveScenarioValue || 0).toFixed(1)}</div><div>ETA: ${Math.round(state.etaMinutes || 0)} min</div><div>Deadhead cost: ${(state.totalDeadheadCost || 0).toFixed(1)}</div><div>Confidence penalty: ${(state.moveConfidencePenalty || 0).toFixed(1)}</div><div>Net move edge: ${(state.netMoveEdge || 0) >= 0 ? "+" : ""}${(state.netMoveEdge || 0).toFixed(1)}</div><div>Worth-moving threshold: ${(state.moveWorthThreshold || 0).toFixed(1)}</div><div><small>${compactTargetWhyLine()}</small></div></section>` : ""}
        <section class="aiAssistantSection"><strong>Recommendation Stability</strong><div>Proposed: ${humanActionLabel(state.proposedActionCode)} • ${state.proposedReasonText || "—"}</div><div>Committed: ${humanActionLabel(state.committedActionCode)} • ${state.committedReasonText || "—"}</div><div>Confidence: ${Math.round(state.recommendationConfidenceScore || 0)} (${state.recommendationConfidenceLevel || "low"})</div><div>Stable since: ${state.committedSinceTs ? new Date(state.committedSinceTs).toLocaleTimeString() : "—"}</div><div>Switch cooldown until: ${state.recommendationSwitchCooldownUntilTs ? new Date(state.recommendationSwitchCooldownUntilTs).toLocaleTimeString() : "—"}</div><div>Minimum hold until: ${state.recommendationMinHoldUntilTs ? new Date(state.recommendationMinHoldUntilTs).toLocaleTimeString() : "—"}</div><div>Stability reason: ${state.stabilityReasonText || "Committed recommendation is stable."}</div></section>
        <section class="aiAssistantSection"><small>${trustModeLine}</small></section>
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
    state.dataQualityReason = "Checking outlook.";
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

  async function recompute(frame) {
    const liveFrame = frame || internals.getCurrentFrame?.() || null;
    state.lastFrameTime = frameTimeIso(liveFrame);
    const zoneChanged = applyStableZoneFromLocation();
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
    const shortlist = buildArrivalAwareCandidateShortlist(liveFrame, activeSignal);
    state.arrivalAwareCandidateShortlist = shortlist;
    state.shortlistCandidateIds = shortlist.map((c) => String(c?.signal?.locationId || "").trim()).filter(Boolean);
    state.shortlistCandidateZones = shortlist.map((c) => String(c?.signal?.zoneName || "").trim() || "Unknown zone");
    state.shortlistCandidateEtas = shortlist.map((c) => Math.round(safeNum(c?.etaMinutes, 0) || 0));

    const cls = activeSignal ? classifyAssistantSignal(activeSignal) : null;
    const base = computeBaseAction(activeSignal, cls);
    state.baseActionCode = base.code;
    state.baseActionReason = base.reason;

    const locationIds = [state.activeStableZoneId, ...shortlist.map((c) => c.signal.locationId)].filter(Boolean);
    const hasOutlookContext = !!state.lastFrameTime && locationIds.length > 0;
    const currentOutlookKey = hasOutlookContext
      ? buildOutlookCacheKey(state.lastFrameTime, locationIds, state.visibleScoreSource)
      : "";
    const outlook = await fetchOutlook(liveFrame, locationIds, state.visibleScoreSource);
    let effectiveOutlook = outlook;
    const hasCachedCurrentKey = !!currentOutlookKey && state.outlookCache.has(currentOutlookKey);
    if (!effectiveOutlook
      && state.outlookStatus === "loading"
      && state.lastSuccessfulOutlookKey === currentOutlookKey
      && hasCachedCurrentKey) {
      effectiveOutlook = state.outlookCache.get(currentOutlookKey) || null;
    }
    if (!effectiveOutlook && hasCachedCurrentKey && state.lastSuccessfulOutlookKey === currentOutlookKey) {
      effectiveOutlook = state.outlookCache.get(currentOutlookKey) || null;
    }
    const byId = buildOutlookPointsByLocation(effectiveOutlook);
    const currentPoints = byId?.[state.activeStableZoneId] || byId?.[String(state.activeStableZoneId)] || [];
    const evaluated = [];
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
        state.committedReasonText = cached.reasonText || state.committedReasonText || "Checking outlook.";
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
      state.outlookSummaryText = "Checking outlook.";
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
        state.committedReasonText = "Checking outlook.";
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
      state.finalActionReason = "Checking outlook.";
      state.recommendationReasonText = "Checking outlook.";
    }
    state.dwellCoachSummaryText = `${humanActionLabel(state.finalActionCode)}: ${state.recommendationReasonText}`;
    state.dwellCoachReasonFragments = [
      `Stay ${(state.stayWindowAvgRating || state.stayProjectedRating || 0).toFixed(1)}`,
      `Move ${(state.targetPaybackAvgRating || state.targetArrivalProjectedRating || 0).toFixed(1)}`,
      `Edge ${(state.netMoveEdge || 0).toFixed(1)}`,
      `Need ${(state.moveWorthThreshold || 0).toFixed(1)}`
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
    if (zoneChanged) window.dispatchEvent(new CustomEvent("tlc-ai-assistant-snapshot-updated", { detail: snapshot() }));
    emitSnapshotEvents();
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
    state.dataQualityReason = "Checking outlook.";
    state.currentPointsCount = 0;
    state.targetPointsCount = 0;
    state.hasRecentSuccessfulOutlook = false;
    state.isUsingCachedOutlook = false;
    state.isPartialOutlook = false;
    state.canTrustFarMoves = false;
    state.usedCachedRecommendationFallback = false;
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
