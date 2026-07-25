(function() {
  const STABLE_MIN_MS = 3000;
  const STABLE_MIN_HITS = 2;
  const CLEAR_GRACE_MS = 5000;
  const STYLE_ID = "tlc-ai-assistant-style";

  const AI_ASSISTANT_NEARBY_OVERALL_MAX_MI = 3.5;
  const AI_ASSISTANT_NEARBY_TRAP_ESCAPE_MAX_MI = 4.5;
  const AI_ASSISTANT_NEARBY_LONG_TRIP_MAX_MI = 5.0;
  const AI_ASSISTANT_MOVE_DISTANCE_PENALTY_PER_MI = 4.0;
  const AI_ASSISTANT_MOVE_DISTANCE_PENALTY_PER_MI_BWH = 2.0;
  const AI_ASSISTANT_MOVE_DISTANCE_PENALTY_PER_MI_QUEENS = 5.0;
  const AI_ASSISTANT_MOVE_MIN_ADVANTAGE = 4.0;
  const AI_ASSISTANT_LEAVE_NOW_ADVANTAGE = 7.0;
  const AI_ASSISTANT_LONG_TRIP_SWITCH_ADVANTAGE = 6.0;
  const AI_ASSISTANT_BUSY_NOW_MIN = 0.68;
  const AI_ASSISTANT_SLOW_NOW_MAX = 0.35;
  const AI_ASSISTANT_SLOW_NEXT_MAX = 0.40;
  // Short-trip pressure is a PERCENTILE RANK within the frame (median ~0.50), so
  // a threshold near the middle labels roughly half the city a trap. Kept in step
  // with the server's TRAP_SHORT_TRIP_PENALTY_MIN so the local fallback and the
  // server engine agree on what "short-trip trap" means -- otherwise the wording
  // changes depending on which engine happened to answer.
  const AI_ASSISTANT_SHORT_TRIP_TRAP_MIN = 0.75;
  const AI_ASSISTANT_RETENTION_TRAP_MIN = 0.55;
  const AI_ASSISTANT_CONTINUATION_TRAP_MAX = 0.45;
  const AI_ASSISTANT_LONG_TRIP_FRIENDLY_MIN = 0.62;
  const AI_ASSISTANT_MANHATTAN_SATURATION_MIN = 0.45;
  const AI_ASSISTANT_MARKET_SATURATION_MIN = 0.60;
  const AI_ASSISTANT_GOOD_CONTINUATION_MIN = 0.60;
  const AI_ASSISTANT_WEAK_CONTINUATION_MAX = 0.35;
  const AI_ASSISTANT_HEARTBEAT_MS_VISIBLE = 15000;
  const AI_ASSISTANT_HEARTBEAT_MS_HIDDEN = 60000;
  const AI_ASSISTANT_TRAP_DWELL_WARN_MS = 4 * 60 * 1000;
  const AI_ASSISTANT_TRAP_DWELL_URGENT_MS = 7 * 60 * 1000;
  const AI_ASSISTANT_SLOW_DWELL_WARN_MS = 6 * 60 * 1000;
  const AI_ASSISTANT_SLOW_DWELL_URGENT_MS = 10 * 60 * 1000;
  const AI_ASSISTANT_MEDIOCRE_DWELL_WARN_MS = 8 * 60 * 1000;
  const AI_ASSISTANT_MEDIOCRE_DWELL_URGENT_MS = 12 * 60 * 1000;
  const AI_ASSISTANT_HOLD_EXPIRING_WARN_LEAD_MS = 10 * 60 * 1000;
  const AI_ASSISTANT_HOLD_EXPIRING_URGENT_LEAD_MS = 3 * 60 * 1000;

  const state = {
    phase: 6,
    activeStableZoneId: null,
    activeStableZoneName: "",
    activeStableBorough: "",
    activeStableZoneEnterTs: null,
    candidateZoneId: null,
    candidateZoneFirstSeenTs: null,
    candidateZoneConsecutiveHits: 0,
    activeZoneLastSeenTs: null,
    lastUserLocation: null,
    assistantStatus: "idle",
    actionCode: "MONITOR",
    actionReason: "initializing",
    baseActionCode: "MONITOR",
    baseActionReason: "initializing",
    finalActionCode: "MONITOR",
    finalActionReason: "initializing",
    dwellRiskCode: "neutral",
    dwellEscalationLevel: "none",
    dwellWarningActive: false,
    dwellWarningSinceTs: null,
    dwellWarnAtTs: null,
    dwellUrgentAtTs: null,
    dwellShouldLeaveByTs: null,
    dwellCountdownMs: null,
    dwellCoachSummaryText: "Hold OK",
    dwellCoachReasonFragments: [],
    assistantFeedMaterialKey: "",
    assistantAlertKey: "",
    assistantFeedLastEmittedAt: 0,
    assistantHeartbeatTimer: null,
    actionHeadline: "AI Assistant: locating current zone…",
    actionSubline: "Waiting for location and frame.",
    actionSeverity: "neutral",
    assistantMoveTarget: null,
    currentZoneHoldScore: null,
    scoreAdvantageVsCurrent: null,
    navActive: false,
    visibleScoreSource: null,
    visibleScoreSourceLabel: null,
    rating: null,
    bucket: null,
    airportExcluded: false,
    citywideRank: null,
    citywideTotal: null,
    boroughRank: null,
    boroughTotal: null,
    rankingsCacheKey: "",
    rankingsCache: null,
    rankingsExpanded: false,
    lastRankingsComputedAt: null,
    currentZoneCitywideRank: null,
    currentZoneCitywideTotal: null,
    currentZoneBoroughRank: null,
    currentZoneBoroughTotal: null,
    currentBoroughName: "",
    citywideBestNow: null,
    citywideWorstNow: null,
    citywideTop10Best: [],
    citywideTop10Worst: [],
    boroughBestNow: null,
    boroughWorstNow: null,
    boroughTop5Best: [],
    boroughTop5Worst: [],
    signalSnapshot: null,
    bestNearbyOverall: null,
    bestNearbyTrapEscape: null,
    bestNearbyLongTrip: null,
    assistantTags: [],
    assistantReasonFragments: [],
    dwellMs: 0,
    lastRenderFingerprint: "",
    lastActionFingerprint: "",
    rankingsBound: false,
    outlookCache: {},
    outlookCacheKey: "",
    outlookLoading: false,
    outlookError: "",
    currentZoneOutlook: null,
    moveTargetOutlook: null,
    outlookExpanded: false,
    lastOutlookRequestKey: "",
    lastOutlookLoadedAt: null,
    outlookAbortController: null,
    outlookRequestToken: 0,
    outlookDerived: null,
    outlookLastSignature: "",
    assistantFeedVersion: 1,
    feedUpdatedAt: null,
  };

  function numberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function clamp01(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    if (n <= 0) return 0;
    if (n >= 1) return 1;
    return n;
  }

  function getRecommendEl() {
    return window.TlcMapUiInternals?.getRecommendEl?.() || document.getElementById("recommendLine") || null;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .aiAssistBanner{display:flex;flex-direction:column;gap:2px;line-height:1.25}
      .aiAssistBanner[data-escalation="warn"]{border-left:3px solid #f59e0b;padding-left:6px}
      .aiAssistBanner[data-escalation="urgent"]{border-left:3px solid #ef4444;padding-left:6px}
      .aiAssistHeadline{font-weight:700}
      .aiAssistMeta{font-size:12px;opacity:.95}
      .aiAssistCoach{font-size:12px;font-weight:600}
      .aiAssistTimingChip{display:inline-flex;align-items:center;font-size:11px;padding:1px 8px;border-radius:999px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);width:max-content}
      .aiAssistTags{display:flex;flex-wrap:wrap;gap:4px}
      .aiAssistTag{font-size:11px;opacity:.95;padding:1px 6px;border-radius:999px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15)}
      .aiAssistRankHeader{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
      .aiAssistRankChips{display:flex;gap:6px;flex-wrap:wrap}
      .aiAssistRankChip{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08)}
      .aiAssistRankToggle{font-size:11px;padding:2px 8px;border-radius:8px;border:1px solid rgba(255,255,255,.28);background:rgba(15,23,42,.55);color:#fff;cursor:pointer}
      .aiAssistRankPanel{margin-top:4px;padding:6px;border-radius:10px;border:1px solid rgba(255,255,255,.16);background:rgba(15,23,42,.28);max-height:220px;overflow:auto}
      .aiAssistRankSection{margin-bottom:8px}
      .aiAssistRankTitle{font-size:11px;font-weight:700;opacity:.95}
      .aiAssistRankList{margin:2px 0 0 16px;padding:0}
      .aiAssistRankHint{font-size:10px;opacity:.78}
    `;
    document.head.appendChild(style);
  }

  function getFrame(frame) {
    return frame || window.TlcModeInternals?.getCurrentFrame?.() || null;
  }

  function getZoneId(props = {}) {
    const id = window.TlcMapUiInternals?.getZoneLocationId?.(props) ?? props.LocationID;
    return String(id || "").trim() || null;
  }

  function getFeatureCenter(geom) {
    const center = window.TlcMapUiInternals?.geometryCenter?.(geom) || null;
    const lat = Number(center?.lat ?? NaN);
    const lng = Number(center?.lng ?? NaN);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  }

  function isAirportExcludedFeature(props = {}) {
    if (props.airport_excluded === true) return true;
    const zoneName = String(props.zone_name || "").toLowerCase();
    const locationId = String(props.LocationID || "").trim();
    return /airport|jfk|la guardia|laguardia|newark/i.test(zoneName) || ["1", "132", "138"].includes(locationId);
  }

  function buildAssistantFeatureSignal(feature) {
    const props = feature?.properties || {};
    const geom = feature?.geometry || null;
    const locationId = getZoneId(props);
    const center = getFeatureCenter(geom);
    const communityCrowdingPenaltyRaw = window.TlcCommunityCrowdingModule?.getZoneCommunityCrowdingPenalty?.(locationId);
    const communityCrowdingPenalty = Number.isFinite(Number(communityCrowdingPenaltyRaw)) ? Number(communityCrowdingPenaltyRaw) : 0;
    const crowdingSnapshot = window.TlcCommunityCrowdingModule?.getZoneCommunityCrowdingSnapshot?.(locationId) || null;

    return {
      locationId,
      zoneName: String(props.zone_name || "").trim() || (locationId ? `Zone ${locationId}` : "Unknown zone"),
      borough: String(props.borough || "").trim() || "",
      centerLat: center?.lat ?? null,
      centerLng: center?.lng ?? null,
      visibleRating: numberOrNull(window.TlcModeModule?.effectiveRating?.(props, geom)),
      visibleBucket: String(window.TlcModeModule?.effectiveBucket?.(props, geom) || "").trim() || null,
      visibleScoreSource: String(window.TlcModeModule?.getVisibleScoreSourceForFeature?.(props, geom) || "legacy_citywide"),
      visibleScoreSourceLabel: String(window.TlcModeModule?.getVisibleScoreSourceLabel?.(props, geom) || "Team Joseo score"),
      airportExcluded: isAirportExcludedFeature(props),
      communityCrowdingPenalty,
      communityCrowdingBucket: String(crowdingSnapshot?.bucket || "").trim() || null,
      busyNowBase: numberOrNull(props.busy_now_base_n_shadow),
      busyNextBase: numberOrNull(props.busy_next_base_n_shadow),
      shortTripPenalty: clamp01(props.short_trip_penalty_n ?? props.short_trip_penalty_n_shadow),
      longTripShare20Plus: clamp01(props.long_trip_share_20plus_n ?? props.long_trip_share_20plus),
      balancedTripShare: clamp01(props.balanced_trip_share_n_shadow ?? props.balanced_trip_share_shadow ?? props.balanced_trip_share),
      churnPressure: clamp01(props.churn_pressure_n_shadow ?? props.churn_pressure_n),
      marketSaturationPenalty: clamp01(props.market_saturation_penalty_n_shadow ?? props.market_saturation_penalty_n),
      manhattanCoreSaturationPenalty: clamp01(props.manhattan_core_saturation_penalty_n_shadow ?? props.manhattan_core_saturation_penalty_n),
      continuationRaw: clamp01(props.downstream_value_n),
      sameZoneRetentionPenalty: clamp01(props.same_zone_retention_penalty_n),
      modeTag: String(window.TlcModeModule?.getActiveSpecialModeTagForFeature?.(props, geom) || "").toLowerCase(),
      feature,
    };
  }

  function normalizeBoroughKey(value) {
    return String(value || "").trim().toLowerCase();
  }

  function compareNumbers(a, b, dir = "asc") {
    const av = Number.isFinite(a) ? a : (dir === "asc" ? Infinity : -Infinity);
    const bv = Number.isFinite(b) ? b : (dir === "asc" ? Infinity : -Infinity);
    return dir === "asc" ? av - bv : bv - av;
  }

  function compareAssistantBestRank(a, b) {
    return compareNumbers(a.visibleRating, b.visibleRating, "desc")
      || compareNumbers(a.busyNextBase, b.busyNextBase, "desc")
      || compareNumbers(a.continuationRaw, b.continuationRaw, "desc")
      || compareNumbers(a.shortTripPenalty, b.shortTripPenalty, "asc")
      || compareNumbers(a.marketSaturationPenalty, b.marketSaturationPenalty, "asc")
      || String(a.zoneName || "").localeCompare(String(b.zoneName || ""))
      || String(a.locationId || "").localeCompare(String(b.locationId || ""));
  }

  function compareAssistantWorstRank(a, b) {
    return compareNumbers(a.visibleRating, b.visibleRating, "asc")
      || compareNumbers(a.busyNowBase, b.busyNowBase, "asc")
      || compareNumbers(a.busyNextBase, b.busyNextBase, "asc")
      || compareNumbers(a.continuationRaw, b.continuationRaw, "asc")
      || compareNumbers(a.shortTripPenalty, b.shortTripPenalty, "desc")
      || compareNumbers(a.marketSaturationPenalty, b.marketSaturationPenalty, "desc")
      || String(a.zoneName || "").localeCompare(String(b.zoneName || ""))
      || String(a.locationId || "").localeCompare(String(b.locationId || ""));
  }

  function toRankSnapshotEntry(entry) {
    if (!entry) return null;
    return {
      locationId: entry.locationId,
      zoneName: entry.zoneName,
      borough: entry.borough,
      visibleRating: entry.visibleRating,
      visibleBucket: entry.visibleBucket,
      visibleScoreSource: entry.visibleScoreSource,
      visibleScoreSourceLabel: entry.visibleScoreSourceLabel,
    };
  }

  function buildAssistantRankingUniverse(frame) {
    const features = frame?.polygons?.features || [];
    const universe = [];
    for (const feature of features) {
      const signal = buildAssistantFeatureSignal(feature);
      if (!signal.locationId || !signal.zoneName || signal.airportExcluded || !Number.isFinite(signal.visibleRating)) continue;
      universe.push({
        locationId: signal.locationId,
        zoneName: signal.zoneName,
        borough: signal.borough,
        boroughKey: normalizeBoroughKey(signal.borough),
        visibleRating: signal.visibleRating,
        visibleBucket: signal.visibleBucket,
        visibleScoreSource: signal.visibleScoreSource,
        visibleScoreSourceLabel: signal.visibleScoreSourceLabel,
        busyNowBase: signal.busyNowBase,
        busyNextBase: signal.busyNextBase,
        continuationRaw: signal.continuationRaw,
        shortTripPenalty: signal.shortTripPenalty,
        marketSaturationPenalty: signal.marketSaturationPenalty,
      });
    }
    return universe;
  }

  function getRankingCacheKey(frame) {
    const frameTime = String(frame?.time ?? "");
    const featureCount = Number(frame?.polygons?.features?.length || 0);
    const modeFlags = window.TlcModeModule?.getModeFlags?.() || {};
    return `${frameTime}|${featureCount}|${JSON.stringify(modeFlags)}`;
  }

  function ensureRankings(frame, currentSignal, now) {
    const cacheKey = getRankingCacheKey(frame);
    if (state.rankingsCache && state.rankingsCacheKey === cacheKey) return state.rankingsCache;

    const universe = buildAssistantRankingUniverse(frame);
    const sortedCitywideBest = universe.slice().sort(compareAssistantBestRank);
    const sortedCitywideWorst = universe.slice().sort(compareAssistantWorstRank);

    const citywideBestNow = sortedCitywideBest[0] || null;
    const citywideWorstNow = sortedCitywideWorst[0] || null;
    const citywideTop10Best = sortedCitywideBest.slice(0, 10);
    const citywideTop10Worst = sortedCitywideWorst.slice(0, 10);

    const currentId = String(state.activeStableZoneId || "");
    const citywideIndex = currentId ? sortedCitywideBest.findIndex((entry) => entry.locationId === currentId) : -1;
    const currentZoneCitywideRank = citywideIndex >= 0 ? citywideIndex + 1 : null;
    const currentZoneCitywideTotal = sortedCitywideBest.length || null;

    let currentBoroughName = "";
    let boroughBestNow = null;
    let boroughWorstNow = null;
    let boroughTop5Best = [];
    let boroughTop5Worst = [];
    let currentZoneBoroughRank = null;
    let currentZoneBoroughTotal = null;

    if (currentSignal && !currentSignal.airportExcluded && currentSignal.locationId) {
      currentBoroughName = String(currentSignal.borough || "").trim();
      const boroughKey = normalizeBoroughKey(currentBoroughName);
      if (boroughKey) {
        const boroughUniverse = universe.filter((entry) => entry.boroughKey === boroughKey);
        const sortedBoroughBest = boroughUniverse.slice().sort(compareAssistantBestRank);
        const sortedBoroughWorst = boroughUniverse.slice().sort(compareAssistantWorstRank);
        boroughBestNow = sortedBoroughBest[0] || null;
        boroughWorstNow = sortedBoroughWorst[0] || null;
        boroughTop5Best = sortedBoroughBest.slice(0, 5);
        boroughTop5Worst = sortedBoroughWorst.slice(0, 5);
        const boroughIndex = sortedBoroughBest.findIndex((entry) => entry.locationId === currentSignal.locationId);
        currentZoneBoroughRank = boroughIndex >= 0 ? boroughIndex + 1 : null;
        currentZoneBoroughTotal = sortedBoroughBest.length || null;
      }
    }

    const rankings = {
      rankingsCacheKey: cacheKey,
      rankingsComputed: true,
      currentZoneCitywideRank,
      currentZoneCitywideTotal,
      currentZoneBoroughRank,
      currentZoneBoroughTotal,
      currentBoroughName,
      citywideBestNow: toRankSnapshotEntry(citywideBestNow),
      citywideWorstNow: toRankSnapshotEntry(citywideWorstNow),
      citywideTop10Best: citywideTop10Best.map(toRankSnapshotEntry),
      citywideTop10Worst: citywideTop10Worst.map(toRankSnapshotEntry),
      boroughBestNow: toRankSnapshotEntry(boroughBestNow),
      boroughWorstNow: toRankSnapshotEntry(boroughWorstNow),
      boroughTop5Best: boroughTop5Best.map(toRankSnapshotEntry),
      boroughTop5Worst: boroughTop5Worst.map(toRankSnapshotEntry),
    };

    state.rankingsCacheKey = cacheKey;
    state.rankingsCache = rankings;
    state.lastRankingsComputedAt = now;
    return rankings;
  }

  function classifyCurrentZone(signal) {
    const busyNowFlag = (signal.busyNowBase ?? -Infinity) >= AI_ASSISTANT_BUSY_NOW_MIN;
    const slowNowFlag = (signal.busyNowBase ?? Infinity) <= AI_ASSISTANT_SLOW_NOW_MAX && (signal.busyNextBase ?? Infinity) <= AI_ASSISTANT_SLOW_NEXT_MAX;
    const shortTripTrapFlag = (signal.shortTripPenalty ?? 0) >= AI_ASSISTANT_SHORT_TRIP_TRAP_MIN
      && (signal.sameZoneRetentionPenalty ?? 0) >= AI_ASSISTANT_RETENTION_TRAP_MIN
      && (signal.continuationRaw ?? 1) <= AI_ASSISTANT_CONTINUATION_TRAP_MAX;
    const longTripFriendlyFlag = (signal.longTripShare20Plus ?? 0) >= AI_ASSISTANT_LONG_TRIP_FRIENDLY_MIN;
    const saturationCautionFlag = ((signal.borough || "").includes("Manhattan") && (signal.manhattanCoreSaturationPenalty ?? 0) >= AI_ASSISTANT_MANHATTAN_SATURATION_MIN)
      || (signal.marketSaturationPenalty ?? 0) >= AI_ASSISTANT_MARKET_SATURATION_MIN;
    const goodContinuationFlag = (signal.continuationRaw ?? 0) >= AI_ASSISTANT_GOOD_CONTINUATION_MIN;
    const weakContinuationFlag = (signal.continuationRaw ?? 1) <= AI_ASSISTANT_WEAK_CONTINUATION_MAX;
    return {
      busyNowFlag,
      slowNowFlag,
      shortTripTrapFlag,
      longTripFriendlyFlag,
      saturationCautionFlag,
      goodContinuationFlag,
      weakContinuationFlag,
      trapOrSlowSaturation: shortTripTrapFlag || slowNowFlag || saturationCautionFlag,
      moderateZone: !shortTripTrapFlag && !longTripFriendlyFlag && !goodContinuationFlag,
      notStrongLongTripZone: !longTripFriendlyFlag && (signal.longTripShare20Plus ?? 0) < 0.55,
      strongZone: busyNowFlag && !shortTripTrapFlag && (longTripFriendlyFlag || goodContinuationFlag) && !saturationCautionFlag,
    };
  }

  function buildAssistantTags(c) {
    const tags = [];
    if (c.shortTripTrapFlag) tags.push("Short-trip trap");
    if (c.longTripFriendlyFlag) tags.push("Long-trip friendly");
    if (c.busyNowFlag) tags.push("Busy now");
    if (c.slowNowFlag) tags.push("Slow now");
    if (c.saturationCautionFlag) tags.push("Saturation caution");
    if (c.goodContinuationFlag) tags.push("Good continuation");
    if (c.weakContinuationFlag) tags.push("Weak continuation");
    return tags;
  }

  function getDistancePenaltyPerMile(signal) {
    const tag = String(signal?.modeTag || "");
    if (tag.includes("queens")) return AI_ASSISTANT_MOVE_DISTANCE_PENALTY_PER_MI_QUEENS;
    if (tag.includes("bronx") || tag.includes("wash") || tag.includes("heights")) return AI_ASSISTANT_MOVE_DISTANCE_PENALTY_PER_MI_BWH;
    return AI_ASSISTANT_MOVE_DISTANCE_PENALTY_PER_MI;
  }

  function scoreAssistantCandidate(signal, currentSignal, distanceMiles, intent) {
    const distancePenaltyPerMile = getDistancePenaltyPerMile(signal);
    const baseScore = (signal.visibleRating ?? -Infinity)
      - (distanceMiles * distancePenaltyPerMile)
      - (signal.communityCrowdingPenalty ?? 0);
    let score = baseScore;

    if (intent === "trap_escape") {
      score += 4.0 * (1 - (signal.shortTripPenalty ?? 0));
      score += 3.0 * (1 - (signal.churnPressure ?? 0));
      score += 2.5 * (signal.continuationRaw ?? 0);
      score += 2.0 * (1 - (signal.marketSaturationPenalty ?? 0));
    } else if (intent === "long_trip") {
      score += 5.0 * (signal.longTripShare20Plus ?? 0);
      score += 2.5 * (signal.continuationRaw ?? 0);
      score += 1.5 * (1 - (signal.marketSaturationPenalty ?? 0));
    }

    return {
      intent,
      score,
      baseScore,
      distancePenaltyPerMile,
      distanceMiles,
      signal,
      scoreAdvantageVsCurrent: null,
    };
  }

  function computeNearbyAssistantCandidates(frame, currentStableFeature, snapshot) {
    const currentSignal = buildAssistantFeatureSignal(currentStableFeature);
    const currentCenter = Number.isFinite(currentSignal.centerLat) && Number.isFinite(currentSignal.centerLng)
      ? { lat: currentSignal.centerLat, lng: currentSignal.centerLng }
      : null;
    if (!currentCenter) return { currentSignal, bestNearbyOverall: null, bestNearbyTrapEscape: null, bestNearbyLongTrip: null };

    const features = frame?.polygons?.features || [];
    let bestNearbyOverall = null;
    let bestNearbyTrapEscape = null;
    let bestNearbyLongTrip = null;

    for (const feature of features) {
      const signal = buildAssistantFeatureSignal(feature);
      if (!signal.locationId || signal.locationId === currentSignal.locationId) continue;
      if (signal.airportExcluded || !Number.isFinite(signal.visibleRating)) continue;
      if (!Number.isFinite(signal.centerLat) || !Number.isFinite(signal.centerLng)) continue;

      const distanceMiles = Number(window.TlcMapUiInternals?.haversineMiles?.(currentCenter, { lat: signal.centerLat, lng: signal.centerLng }) || NaN);
      if (!Number.isFinite(distanceMiles)) continue;

      if (distanceMiles <= AI_ASSISTANT_NEARBY_OVERALL_MAX_MI) {
        const candidate = scoreAssistantCandidate(signal, currentSignal, distanceMiles, "overall");
        if (!bestNearbyOverall || candidate.score > bestNearbyOverall.score) bestNearbyOverall = candidate;
      }
      if (distanceMiles <= AI_ASSISTANT_NEARBY_TRAP_ESCAPE_MAX_MI) {
        const candidate = scoreAssistantCandidate(signal, currentSignal, distanceMiles, "trap_escape");
        if (!bestNearbyTrapEscape || candidate.score > bestNearbyTrapEscape.score) bestNearbyTrapEscape = candidate;
      }
      if (distanceMiles <= AI_ASSISTANT_NEARBY_LONG_TRIP_MAX_MI) {
        const candidate = scoreAssistantCandidate(signal, currentSignal, distanceMiles, "long_trip");
        if (!bestNearbyLongTrip || candidate.score > bestNearbyLongTrip.score) bestNearbyLongTrip = candidate;
      }
    }

    return { currentSignal, bestNearbyOverall, bestNearbyTrapEscape, bestNearbyLongTrip };
  }

  function computeCurrentZoneHoldScore(currentSignal) {
    let holdScore = (currentSignal.visibleRating ?? 0) - (currentSignal.communityCrowdingPenalty ?? 0);
    holdScore -= 4.0 * (currentSignal.shortTripPenalty ?? 0);
    holdScore -= 3.0 * (currentSignal.marketSaturationPenalty ?? 0);
    holdScore -= 2.5 * (currentSignal.churnPressure ?? 0);
    holdScore -= 2.0 * (1 - (currentSignal.continuationRaw ?? 0));
    return holdScore;
  }

  function serializeCandidate(candidate, holdScore) {
    if (!candidate) return null;
    const scoreAdvantageVsCurrent = Number(candidate.score - holdScore);
    candidate.scoreAdvantageVsCurrent = scoreAdvantageVsCurrent;
    return {
      locationId: candidate.signal.locationId,
      zoneName: candidate.signal.zoneName,
      borough: candidate.signal.borough,
      lat: candidate.signal.centerLat,
      lng: candidate.signal.centerLng,
      visibleRating: candidate.signal.visibleRating,
      visibleBucket: candidate.signal.visibleBucket,
      visibleScoreSource: candidate.signal.visibleScoreSource,
      visibleScoreSourceLabel: candidate.signal.visibleScoreSourceLabel,
      distanceMiles: candidate.distanceMiles,
      moveIntent: candidate.intent,
      candidateScore: candidate.score,
      scoreAdvantageVsCurrent,
    };
  }

  function decideAssistantAction(currentSignal, candidateSet, snapshot) {
    const classification = classifyCurrentZone(currentSignal);
    const holdScore = computeCurrentZoneHoldScore(currentSignal);
    const overallAdv = candidateSet.bestNearbyOverall ? candidateSet.bestNearbyOverall.score - holdScore : -Infinity;
    const trapAdv = candidateSet.bestNearbyTrapEscape ? candidateSet.bestNearbyTrapEscape.score - holdScore : -Infinity;
    const longAdv = candidateSet.bestNearbyLongTrip ? candidateSet.bestNearbyLongTrip.score - holdScore : -Infinity;

    let actionCode = "MONITOR";
    let actionReason = "no_material_advantage";
    let actionSeverity = "neutral";
    let moveTarget = null;

    if (currentSignal.airportExcluded) {
      actionCode = "MONITOR";
      actionReason = "airport_excluded";
    } else if (classification.trapOrSlowSaturation && candidateSet.bestNearbyTrapEscape && trapAdv >= AI_ASSISTANT_LEAVE_NOW_ADVANTAGE) {
      actionCode = "LEAVE_NOW";
      actionReason = "trap_escape";
      actionSeverity = "alert";
      moveTarget = serializeCandidate(candidateSet.bestNearbyTrapEscape, holdScore);
    } else if (classification.trapOrSlowSaturation && candidateSet.bestNearbyTrapEscape && trapAdv >= AI_ASSISTANT_MOVE_MIN_ADVANTAGE) {
      actionCode = "MOVE_SOON";
      actionReason = "trap_escape";
      actionSeverity = "warn";
      moveTarget = serializeCandidate(candidateSet.bestNearbyTrapEscape, holdScore);
    } else if (classification.moderateZone && candidateSet.bestNearbyOverall && overallAdv >= AI_ASSISTANT_MOVE_MIN_ADVANTAGE) {
      actionCode = "MOVE_SOON";
      actionReason = "overall_better";
      actionSeverity = "warn";
      moveTarget = serializeCandidate(candidateSet.bestNearbyOverall, holdScore);
    } else if (classification.notStrongLongTripZone && candidateSet.bestNearbyLongTrip && longAdv >= AI_ASSISTANT_LONG_TRIP_SWITCH_ADVANTAGE) {
      actionCode = "STAY_BRIEFLY";
      actionReason = "better_long_trip_zone";
      actionSeverity = "positive";
      moveTarget = serializeCandidate(candidateSet.bestNearbyLongTrip, holdScore);
    } else if (classification.strongZone) {
      actionCode = "STAY";
      actionReason = "current_zone_best_nearby";
      actionSeverity = "positive";
    }

    return { actionCode, actionReason, actionSeverity, holdScore, moveTarget, classification };
  }

  function buildAssistantActionExplanation(snapshot) {
    const out = [];
    if (snapshot.shortTripTrapFlag) out.push("current zone is trap-heavy");
    if (snapshot.saturationCautionFlag) out.push("current zone has saturation pressure");
    if (snapshot.actionReason === "better_long_trip_zone") out.push("nearby zone has better long-trip quality");
    if (snapshot.actionReason === "trap_escape") out.push("nearby zone offers a cleaner trap escape");
    if (snapshot.actionReason === "current_zone_best_nearby") out.push("current zone still has the best nearby score");
    if (!snapshot.assistantMoveTarget) out.push("no materially better nearby option");
    if (snapshot.assistantMoveTarget && snapshot.assistantMoveTarget.scoreAdvantageVsCurrent >= AI_ASSISTANT_MOVE_MIN_ADVANTAGE) {
      out.push("nearby zone has less saturation pressure");
    }
    return out.slice(0, 4);
  }

  function formatDwell(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return "In zone for 0s";
    const sec = Math.floor(ms / 1000);
    if (sec >= 60) return `In zone for ${Math.round(sec / 60)}m`;
    return `In zone for ${sec}s`;
  }

  function formatMiles(miles) {
    if (!Number.isFinite(miles)) return "—";
    return `${miles.toFixed(1)} mi`;
  }

  function formatOutlookTimeLabel(iso) {
    if (!iso) return "—";
    return window.TlcMapUiInternals?.formatNYCTimeOnlyLabel?.(iso) || String(iso);
  }

  function getBucketRank(bucket) {
    const order = { red: 0, yellow: 1, orange: 2, sky: 3, blue: 4, indigo: 5, purple: 6, green: 7 };
    return order[String(bucket || "").toLowerCase()] ?? -1;
  }

  function buildOutlookRequestKey(frameTime, locationIds) {
    if (!frameTime || !Array.isArray(locationIds) || !locationIds.length) return "";
    return `${frameTime}|${locationIds.map((id) => String(id || "").trim()).filter(Boolean).sort().join(",")}`;
  }

  function resetOutlookState(errorText = "") {
    if (state.outlookAbortController) {
      try { state.outlookAbortController.abort(); } catch (_) {}
    }
    state.outlookAbortController = null;
    state.outlookLoading = false;
    state.outlookError = errorText || "";
    state.currentZoneOutlook = null;
    state.moveTargetOutlook = null;
    state.outlookDerived = null;
    state.outlookCacheKey = "";
  }

  function pickOutlookTrack(point, visibleScoreSource) {
    const tracks = point?.tracks && typeof point.tracks === "object" ? point.tracks : point?.score_tracks;
    if (!tracks || typeof tracks !== "object") return null;
    const source = String(visibleScoreSource || "").trim();
    if (source && tracks[source]) return tracks[source];
    const isV3 = source.includes("_v3_");
    if (isV3 && tracks.citywide_v3_shadow) return tracks.citywide_v3_shadow;
    if (!isV3 && tracks.citywide_shadow) return tracks.citywide_shadow;
    return null;
  }

  function classifyAssistantOutlookPoint(point, visibleScoreSource) {
    const track = pickOutlookTrack(point, visibleScoreSource);
    if (!track) {
      return { frame_time: point?.frame_time || point?.time || null, rating: null, bucket: null, isTrap: false, isLongTripFriendly: false, isBusy: false, isSlow: false, isSaturationCaution: false, hasGoodContinuation: false, hasWeakContinuation: false };
    }
    const signal = {
      busyNowBase: numberOrNull(track.busy_now_base_n_shadow ?? point?.busy_now_base_n_shadow),
      busyNextBase: numberOrNull(track.busy_next_base_n_shadow ?? point?.busy_next_base_n_shadow),
      shortTripPenalty: clamp01(track.short_trip_penalty_n_shadow ?? track.short_trip_penalty_n ?? point?.short_trip_penalty_n_shadow ?? point?.short_trip_penalty_n),
      sameZoneRetentionPenalty: clamp01(track.same_zone_retention_penalty_n ?? point?.same_zone_retention_penalty_n),
      continuationRaw: clamp01(track.downstream_value_n ?? point?.downstream_value_n),
      longTripShare20Plus: clamp01(track.long_trip_share_20plus_n ?? point?.long_trip_share_20plus_n),
      marketSaturationPenalty: clamp01(track.market_saturation_penalty_n_shadow ?? track.market_saturation_penalty_n ?? point?.market_saturation_penalty_n_shadow ?? point?.market_saturation_penalty_n),
      manhattanCoreSaturationPenalty: clamp01(track.manhattan_core_saturation_penalty_n_shadow ?? track.manhattan_core_saturation_penalty_n ?? point?.manhattan_core_saturation_penalty_n_shadow ?? point?.manhattan_core_saturation_penalty_n),
      borough: String(point?.borough || ""),
    };
    const classification = classifyCurrentZone(signal);
    return {
      frame_time: point?.frame_time || point?.time || null,
      rating: numberOrNull(track.rating ?? point?.rating),
      bucket: String(track.bucket || point?.bucket || "").trim() || null,
      isTrap: !!classification.shortTripTrapFlag,
      isLongTripFriendly: !!classification.longTripFriendlyFlag,
      isBusy: !!classification.busyNowFlag,
      isSlow: !!classification.slowNowFlag,
      isSaturationCaution: !!classification.saturationCautionFlag,
      hasGoodContinuation: !!classification.goodContinuationFlag,
      hasWeakContinuation: !!classification.weakContinuationFlag,
    };
  }

  function lastConsecutiveTime(points, predicate) {
    if (!Array.isArray(points) || !points.length || !predicate(points[0])) return null;
    let last = points[0];
    for (let i = 1; i < points.length; i++) {
      if (!predicate(points[i])) break;
      last = points[i];
    }
    return last.frame_time || null;
  }

  function deriveAssistantOutlookWindows(outlookPayload, visibleScoreSource, currentActionCode) {
    const horizon = Array.isArray(outlookPayload?.horizon) ? outlookPayload.horizon : [];
    const points = horizon.map((point) => classifyAssistantOutlookPoint(point, visibleScoreSource)).filter((point) => point?.frame_time);
    if (!points.length) return null;
    const current = points[0];
    const currentRating = numberOrNull(current.rating);
    const currentBucketRank = getBucketRank(current.bucket);
    const stableBucketUntilTime = lastConsecutiveTime(points, (point) => {
      const pointRank = getBucketRank(point.bucket);
      return pointRank >= 0 && currentBucketRank >= 0 && pointRank >= currentBucketRank - 1;
    });
    const holdUntilTime = (currentActionCode === "STAY" || currentActionCode === "STAY_BRIEFLY")
      ? lastConsecutiveTime(points, (point) => {
        if (!Number.isFinite(currentRating) || !Number.isFinite(point.rating)) return false;
        const stableOk = stableBucketUntilTime ? String(point.frame_time) <= String(stableBucketUntilTime) : false;
        return Math.abs(point.rating - currentRating) <= 4 && stableOk;
      })
      : null;
    let nextImprovementTime = null;
    let nextWorseningTime = null;
    for (let i = 1; i < points.length; i++) {
      const point = points[i];
      if (!nextImprovementTime) {
        const improved = (Number.isFinite(currentRating) && Number.isFinite(point.rating) && point.rating >= currentRating + 4)
          || (current.isTrap && !point.isTrap)
          || (current.isSlow && !point.isSlow);
        if (improved) nextImprovementTime = point.frame_time;
      }
      if (!nextWorseningTime) {
        const worsened = (Number.isFinite(currentRating) && Number.isFinite(point.rating) && point.rating <= currentRating - 4)
          || (current.isBusy && point.isSlow)
          || (!current.isTrap && point.isTrap)
          || (currentBucketRank >= 0 && getBucketRank(point.bucket) >= 0 && getBucketRank(point.bucket) < currentBucketRank - 1);
        if (worsened) nextWorseningTime = point.frame_time;
      }
      if (nextImprovementTime && nextWorseningTime) break;
    }
    return {
      activeFromTime: current.frame_time || null,
      activeUntilTime: points[points.length - 1]?.frame_time || null,
      busyUntilTime: lastConsecutiveTime(points, (point) => point.isBusy),
      slowUntilTime: lastConsecutiveTime(points, (point) => point.isSlow),
      trapUntilTime: lastConsecutiveTime(points, (point) => point.isTrap),
      longTripFriendlyUntilTime: lastConsecutiveTime(points, (point) => point.isLongTripFriendly),
      saturationUntilTime: lastConsecutiveTime(points, (point) => point.isSaturationCaution),
      holdUntilTime,
      nextImprovementTime,
      nextWorseningTime,
      stableBucketUntilTime,
      outlookSummaryCode: "neutral",
      outlookReasonFragments: [],
      points,
    };
  }

  function deriveTargetOutlookWindows(outlookPayload, visibleScoreSource) {
    const base = deriveAssistantOutlookWindows(outlookPayload, visibleScoreSource, "MOVE_SOON");
    if (!base) return null;
    return {
      targetStrongUntilTime: base.stableBucketUntilTime,
      targetTrapUntilTime: base.trapUntilTime,
      targetBusyUntilTime: base.busyUntilTime,
      targetLongTripFriendlyUntilTime: base.longTripFriendlyUntilTime,
      targetStableBucketUntilTime: base.stableBucketUntilTime,
    };
  }

  function buildCurrentZoneOutlookSummary(snapshot) {
    if (snapshot.outlookLoading) return "Outlook loading…";
    if (snapshot.outlookError) return "Outlook unavailable";
    if ((snapshot.actionCode === "LEAVE_NOW" || snapshot.actionCode === "MOVE_SOON") && snapshot.trapUntilTime) return `Trap risk until ${formatOutlookTimeLabel(snapshot.trapUntilTime)}`;
    if ((snapshot.actionCode === "LEAVE_NOW" || snapshot.actionCode === "MOVE_SOON") && snapshot.saturationUntilTime) return `Saturation risk until ${formatOutlookTimeLabel(snapshot.saturationUntilTime)}`;
    if ((snapshot.actionCode === "STAY" || snapshot.actionCode === "STAY_BRIEFLY") && snapshot.holdUntilTime) return `Hold until ${formatOutlookTimeLabel(snapshot.holdUntilTime)}`;
    if (snapshot.busyUntilTime) return `Busy until ${formatOutlookTimeLabel(snapshot.busyUntilTime)}`;
    if (snapshot.slowUntilTime) return `Slow until ${formatOutlookTimeLabel(snapshot.slowUntilTime)}`;
    if (snapshot.nextImprovementTime) return `Improves after ${formatOutlookTimeLabel(snapshot.nextImprovementTime)}`;
    return "Outlook neutral";
  }

  function buildMoveTargetOutlookSummary(snapshot) {
    if (!snapshot?.assistantMoveTarget) return "";
    if (snapshot.outlookLoading) return "Target outlook loading…";
    if (snapshot.outlookError) return "Target outlook unavailable";
    if (snapshot.targetStrongUntilTime) return `Target strong through ${formatOutlookTimeLabel(snapshot.targetStrongUntilTime)}`;
    if (snapshot.targetTrapUntilTime) return `Target trap risk until ${formatOutlookTimeLabel(snapshot.targetTrapUntilTime)}`;
    if (snapshot.targetBusyUntilTime) return `Target busy until ${formatOutlookTimeLabel(snapshot.targetBusyUntilTime)}`;
    return "Target outlook neutral";
  }

  function buildOutlookReasonFragments(snapshot) {
    const out = [];
    if (snapshot.trapUntilTime) out.push(`trap risk until ${formatOutlookTimeLabel(snapshot.trapUntilTime)}`);
    if (snapshot.holdUntilTime) out.push(`hold until ${formatOutlookTimeLabel(snapshot.holdUntilTime)}`);
    if (snapshot.nextImprovementTime) out.push(`improves after ${formatOutlookTimeLabel(snapshot.nextImprovementTime)}`);
    if (snapshot.nextWorseningTime) out.push(`worsens after ${formatOutlookTimeLabel(snapshot.nextWorseningTime)}`);
    return out.slice(0, 4);
  }

  function toEpochMs(value) {
    if (value == null || value === "") return null;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function deriveAssistantDwellRisk(snapshot, nowTs) {
    if (!snapshot?.activeStableZoneId || snapshot.airportExcluded) return "neutral";
    const baseActionCode = String(snapshot.baseActionCode || snapshot.actionCode || "MONITOR");
    const visibleRating = Number(snapshot.rating);
    const scoreAdv = Number(snapshot.assistantMoveTarget?.scoreAdvantageVsCurrent ?? snapshot.scoreAdvantageVsCurrent ?? NaN);
    const holdUntilTs = toEpochMs(snapshot.holdUntilTime);
    const nextWorseningTs = toEpochMs(snapshot.nextWorseningTime);
    const trapUntilTs = toEpochMs(snapshot.trapUntilTime);
    const noMateriallyBetterNearby = !snapshot.assistantMoveTarget || !(scoreAdv >= AI_ASSISTANT_MOVE_MIN_ADVANTAGE);

    if (
      baseActionCode === "STAY"
      && Number.isFinite(visibleRating) && visibleRating >= 60
      && noMateriallyBetterNearby
      && (
        (Number(snapshot.currentZoneCitywideRank) > 0 && Number(snapshot.currentZoneCitywideRank) <= 10)
        || (Number(snapshot.currentZoneBoroughRank) > 0 && Number(snapshot.currentZoneBoroughRank) <= 3)
        || (holdUntilTs && holdUntilTs - nowTs > 20 * 60 * 1000)
      )
    ) {
      return "hold_strong";
    }
    if (
      baseActionCode === "STAY_BRIEFLY"
      || (holdUntilTs && holdUntilTs - nowTs <= 15 * 60 * 1000)
      || (nextWorseningTs && nextWorseningTs - nowTs <= 20 * 60 * 1000)
    ) {
      return "hold_expiring";
    }
    if (
      snapshot.assistantMoveTarget
      && (trapUntilTs || Number(snapshot.shortTripPenalty) >= 0.58)
      && Number.isFinite(scoreAdv) && scoreAdv >= 4.0
    ) {
      return "trap_bad";
    }
    if (
      snapshot.assistantMoveTarget
      && Number.isFinite(visibleRating) && visibleRating < 48
      && Number(snapshot.busyNowBase) <= 0.35
      && Number.isFinite(scoreAdv) && scoreAdv >= 4.0
    ) {
      return "slow_bad";
    }
    if (
      snapshot.assistantMoveTarget
      && Number.isFinite(scoreAdv) && scoreAdv >= 4.0
    ) {
      return "mediocre_better_nearby";
    }
    return "neutral";
  }

  function deriveAssistantDwellEscalation(snapshot, dwellRiskCode, nowTs) {
    const dwellMs = Number(snapshot?.dwellMs || 0);
    const holdUntilTs = toEpochMs(snapshot?.holdUntilTime);
    const result = { dwellEscalationLevel: "none", dwellWarnAtTs: null, dwellUrgentAtTs: null, dwellShouldLeaveByTs: null, dwellCountdownMs: null };
    if (dwellRiskCode === "neutral" || dwellRiskCode === "hold_strong") return result;
    if (dwellRiskCode === "hold_expiring") {
      if (!holdUntilTs) {
        result.dwellEscalationLevel = "info";
        return result;
      }
      result.dwellWarnAtTs = holdUntilTs - AI_ASSISTANT_HOLD_EXPIRING_WARN_LEAD_MS;
      result.dwellUrgentAtTs = holdUntilTs - AI_ASSISTANT_HOLD_EXPIRING_URGENT_LEAD_MS;
      result.dwellShouldLeaveByTs = holdUntilTs;
      result.dwellCountdownMs = Math.max(0, holdUntilTs - nowTs);
      if (holdUntilTs <= nowTs || holdUntilTs - nowTs <= AI_ASSISTANT_HOLD_EXPIRING_URGENT_LEAD_MS) result.dwellEscalationLevel = "urgent";
      else if (holdUntilTs - nowTs <= AI_ASSISTANT_HOLD_EXPIRING_WARN_LEAD_MS) result.dwellEscalationLevel = "warn";
      else result.dwellEscalationLevel = "info";
      return result;
    }
    const startTs = snapshot?.activeStableZoneEnterTs || nowTs;
    if (dwellRiskCode === "trap_bad") {
      result.dwellWarnAtTs = startTs + AI_ASSISTANT_TRAP_DWELL_WARN_MS;
      result.dwellUrgentAtTs = startTs + AI_ASSISTANT_TRAP_DWELL_URGENT_MS;
      result.dwellShouldLeaveByTs = result.dwellUrgentAtTs;
      result.dwellCountdownMs = Math.max(0, result.dwellShouldLeaveByTs - nowTs);
      result.dwellEscalationLevel = dwellMs >= AI_ASSISTANT_TRAP_DWELL_URGENT_MS ? "urgent" : (dwellMs >= AI_ASSISTANT_TRAP_DWELL_WARN_MS ? "warn" : "info");
      return result;
    }
    if (dwellRiskCode === "slow_bad") {
      result.dwellWarnAtTs = startTs + AI_ASSISTANT_SLOW_DWELL_WARN_MS;
      result.dwellUrgentAtTs = startTs + AI_ASSISTANT_SLOW_DWELL_URGENT_MS;
      result.dwellShouldLeaveByTs = result.dwellUrgentAtTs;
      result.dwellCountdownMs = Math.max(0, result.dwellShouldLeaveByTs - nowTs);
      result.dwellEscalationLevel = dwellMs >= AI_ASSISTANT_SLOW_DWELL_URGENT_MS ? "urgent" : (dwellMs >= AI_ASSISTANT_SLOW_DWELL_WARN_MS ? "warn" : "info");
      return result;
    }
    if (dwellRiskCode === "mediocre_better_nearby") {
      result.dwellWarnAtTs = startTs + AI_ASSISTANT_MEDIOCRE_DWELL_WARN_MS;
      result.dwellUrgentAtTs = startTs + AI_ASSISTANT_MEDIOCRE_DWELL_URGENT_MS;
      result.dwellShouldLeaveByTs = result.dwellUrgentAtTs;
      result.dwellCountdownMs = Math.max(0, result.dwellShouldLeaveByTs - nowTs);
      result.dwellEscalationLevel = dwellMs >= AI_ASSISTANT_MEDIOCRE_DWELL_URGENT_MS ? "urgent" : (dwellMs >= AI_ASSISTANT_MEDIOCRE_DWELL_WARN_MS ? "warn" : "info");
      return result;
    }
    return result;
  }

  function actionPriority(code) {
    return ({ MONITOR: 0, STAY: 1, STAY_BRIEFLY: 2, MOVE_SOON: 3, LEAVE_NOW: 4 }[String(code || "MONITOR")] ?? 0);
  }

  function applyAssistantDwellOverride(snapshot, dwellRiskCode, dwellEscalationLevel) {
    const baseActionCode = String(snapshot.baseActionCode || snapshot.actionCode || "MONITOR");
    const moveTarget = snapshot.assistantMoveTarget;
    let finalActionCode = baseActionCode;
    let finalActionReason = String(snapshot.baseActionReason || snapshot.actionReason || "baseline");
    if (dwellRiskCode === "hold_strong") return { finalActionCode: "STAY", finalActionReason: "hold_strong" };
    if (dwellRiskCode === "hold_expiring") {
      if (dwellEscalationLevel === "urgent") return { finalActionCode: moveTarget ? "MOVE_SOON" : "MONITOR", finalActionReason: "hold_window_expired_or_near_end" };
      return { finalActionCode: "STAY_BRIEFLY", finalActionReason: "hold_window_expiring" };
    }
    if (dwellRiskCode === "trap_bad") {
      if (dwellEscalationLevel === "urgent") return { finalActionCode: moveTarget ? "LEAVE_NOW" : "MOVE_SOON", finalActionReason: "stayed_too_long_in_trap" };
      if (dwellEscalationLevel === "warn") return { finalActionCode: moveTarget ? "MOVE_SOON" : "MONITOR", finalActionReason: "trap_dwell_warning" };
      if (actionPriority(finalActionCode) < actionPriority("STAY_BRIEFLY")) return { finalActionCode: "STAY_BRIEFLY", finalActionReason: "trap_dwell_info" };
      return { finalActionCode, finalActionReason };
    }
    if (dwellRiskCode === "slow_bad") {
      if (dwellEscalationLevel === "urgent") return { finalActionCode: moveTarget ? "LEAVE_NOW" : "MOVE_SOON", finalActionReason: "stayed_too_long_in_slow_zone" };
      if (dwellEscalationLevel === "warn") return { finalActionCode: moveTarget ? "MOVE_SOON" : "MONITOR", finalActionReason: "slow_zone_dwell_warning" };
      return { finalActionCode, finalActionReason };
    }
    if (dwellRiskCode === "mediocre_better_nearby") {
      if (dwellEscalationLevel === "urgent") return { finalActionCode: moveTarget ? "MOVE_SOON" : "MONITOR", finalActionReason: "better_nearby_zone_after_overstay" };
      if (dwellEscalationLevel === "warn") return { finalActionCode: "STAY_BRIEFLY", finalActionReason: "move_soon_better_zone_nearby" };
      return { finalActionCode, finalActionReason };
    }
    return { finalActionCode, finalActionReason };
  }

  function buildAssistantDwellCoachReasonFragments(snapshot) {
    const out = [];
    if (snapshot.dwellRiskCode === "hold_strong" && Number(snapshot.currentZoneBoroughRank) > 0 && snapshot.currentZoneBoroughRank <= 3) out.push("top borough zone");
    if (snapshot.dwellRiskCode === "hold_expiring" && snapshot.holdUntilTime) out.push("hold window ends soon");
    if (snapshot.dwellRiskCode === "trap_bad") out.push("trap risk still active");
    if (snapshot.assistantMoveTarget && Number.isFinite(snapshot.assistantMoveTarget.scoreAdvantageVsCurrent)) out.push(`better nearby zone +${snapshot.assistantMoveTarget.scoreAdvantageVsCurrent.toFixed(1)}`);
    if (snapshot.dwellRiskCode === "slow_bad") out.push(`slow zone for ${Math.max(0, Math.round((snapshot.dwellMs || 0) / 60000))}m`);
    if (snapshot.targetStrongUntilTime) out.push(`move target stronger through ${formatOutlookTimeLabel(snapshot.targetStrongUntilTime)}`);
    return out.slice(0, 4);
  }

  function buildAssistantDwellCoachSummary(snapshot) {
    if (snapshot.dwellRiskCode === "hold_strong") return "Hold OK — this is still a strong zone";
    if (snapshot.dwellRiskCode === "hold_expiring") return snapshot.dwellEscalationLevel === "urgent" ? "Window expiring — prepare to move" : "Move in a few minutes — hold window narrowing";
    if (snapshot.dwellRiskCode === "trap_bad") return snapshot.dwellEscalationLevel === "urgent" ? "Leave now — trap risk and overstay" : "Move in a few minutes — trap risk building";
    if (snapshot.dwellRiskCode === "slow_bad") return snapshot.dwellEscalationLevel === "urgent" ? "Leave now — slow zone overstay" : "Move in a few minutes — slow zone overstay";
    if (snapshot.dwellRiskCode === "mediocre_better_nearby") return snapshot.dwellEscalationLevel === "urgent" ? "Move in a few minutes — better nearby option" : "Move in a few minutes — better nearby option";
    return "Hold OK";
  }

  function getAssistantAuthHeaders(existingHeaders = {}) {
    try {
      const runtimeApi = window.FrontendRuntime || null;
      if (runtimeApi?.getToken && runtimeApi?.authHeaders) {
        const token = runtimeApi.getToken();
        return token ? { ...existingHeaders, ...runtimeApi.authHeaders(token) } : { ...existingHeaders };
      }
      const token = (typeof localStorage !== "undefined") ? (localStorage.getItem("community_token_v1") || "") : "";
      return token ? { ...existingHeaders, Authorization: `Bearer ${token}` } : { ...existingHeaders };
    } catch (_) {
      return { ...existingHeaders };
    }
  }

  async function fetchAssistantOutlook(frameTime, locationIds) {
    const requestKey = buildOutlookRequestKey(frameTime, locationIds);
    if (!frameTime || !Array.isArray(locationIds) || !locationIds.length) {
      resetOutlookState("");
      return null;
    }
    if (state.outlookCache[requestKey]) {
      state.outlookCacheKey = requestKey;
      state.outlookError = "";
      state.outlookLoading = false;
      return state.outlookCache[requestKey];
    }
    if (state.outlookAbortController) {
      try { state.outlookAbortController.abort(); } catch (_) {}
    }
    const controller = new AbortController();
    state.outlookAbortController = controller;
    state.outlookLoading = true;
    state.outlookError = "";
    const token = (state.outlookRequestToken || 0) + 1;
    state.outlookRequestToken = token;
    try {
      const encodedIds = locationIds.map((id) => encodeURIComponent(String(id))).join(",");
      const apiBase = typeof window.FrontendRuntime?.resolveApiBase === "function" ? String(window.FrontendRuntime.resolveApiBase() || "") : "";
      const path = `/assistant/outlook?frame_time=${encodeURIComponent(frameTime)}&location_ids=${encodedIds}`;
      const url = apiBase ? `${apiBase}${path}` : path;
      const payload = await window.TlcMapUiInternals?.fetchJSON?.(url, {
        signal: controller.signal,
        cache: "no-store",
        headers: getAssistantAuthHeaders(),
      });
      if (token !== state.outlookRequestToken) return null;
      state.outlookCache[requestKey] = payload || {};
      state.outlookCacheKey = requestKey;
      state.lastOutlookLoadedAt = Date.now();
      state.outlookLoading = false;
      state.outlookError = "";
      return payload || {};
    } catch (err) {
      if (controller.signal.aborted) return null;
      state.outlookLoading = false;
      state.outlookError = "Outlook unavailable";
      return null;
    }
  }

  function reevaluateAssistantDwell(nowTs) {
    const snapshot = getSnapshot(nowTs);
    const riskCode = deriveAssistantDwellRisk(snapshot, nowTs);
    const escalation = deriveAssistantDwellEscalation(snapshot, riskCode, nowTs);
    const finalAction = applyAssistantDwellOverride(snapshot, riskCode, escalation.dwellEscalationLevel);
    const previousWarningActive = !!state.dwellWarningActive;
    const nextWarningActive = escalation.dwellEscalationLevel === "warn" || escalation.dwellEscalationLevel === "urgent";

    state.dwellRiskCode = riskCode;
    state.dwellEscalationLevel = escalation.dwellEscalationLevel;
    state.dwellWarnAtTs = escalation.dwellWarnAtTs;
    state.dwellUrgentAtTs = escalation.dwellUrgentAtTs;
    state.dwellShouldLeaveByTs = escalation.dwellShouldLeaveByTs;
    state.dwellCountdownMs = escalation.dwellCountdownMs;
    state.dwellWarningActive = nextWarningActive;
    if (nextWarningActive && !previousWarningActive) state.dwellWarningSinceTs = nowTs;
    if (!nextWarningActive) state.dwellWarningSinceTs = null;
    state.finalActionCode = finalAction.finalActionCode;
    state.finalActionReason = finalAction.finalActionReason;
    state.actionCode = state.finalActionCode;
    state.actionReason = state.finalActionReason;
    state.dwellCoachSummaryText = buildAssistantDwellCoachSummary(getSnapshot(nowTs));
    state.dwellCoachReasonFragments = buildAssistantDwellCoachReasonFragments(getSnapshot(nowTs));
    state.navActive = applyNavDestination(state.finalActionCode, state.assistantMoveTarget);
    state.actionHeadline = buildHeadline();
    state.actionSubline = buildSubline();
  }

  function buildHeadline() {
    // Single source of truth: the assistant dock publishes the recommendation
    // (server-aware, hour-aware) on window.TlcAssistantRecommendation. Mirror it
    // here so the top banner and the dock card NEVER show different
    // recommendations on screen at the same time. Fall back to the local action-
    // code shape only when the assistant hasn't published a line yet.
    const shared = (window.TlcAssistantRecommendation || null);
    if (shared && shared.primary) return shared.primary;
    const zone = state.activeStableZoneName || "—";
    const target = state.assistantMoveTarget?.zoneName || "—";
    const actionCode = state.finalActionCode || state.actionCode;
    if (actionCode === "STAY") return `STAY — ${zone}`;
    if (actionCode === "MOVE_SOON") return `MOVE SOON → ${target}`;
    if (actionCode === "LEAVE_NOW") return `LEAVE NOW → ${target}`;
    if (actionCode === "STAY_BRIEFLY") return `STAY BRIEFLY — ${zone}`;
    return `MONITOR — ${zone}`;
  }

  function buildSubline() {
    if (state.assistantMoveTarget && state.actionReason === "trap_escape") {
      return `Trap risk here. Better nearby escape in ${formatMiles(state.assistantMoveTarget.distanceMiles)}.`;
    }
    if (state.assistantMoveTarget && state.actionReason === "better_long_trip_zone") {
      return "Nearby long-trip zone scores better.";
    }
    if (state.assistantMoveTarget) {
      return `Nearby alternative scores +${(state.scoreAdvantageVsCurrent || 0).toFixed(1)} vs current.`;
    }
    return "Current zone still beats nearby options.";
  }

  function buildCitywideStandingLabel(snapshot) {
    if (!snapshot?.currentZoneCitywideRank || !snapshot?.currentZoneCitywideTotal) return "Citywide —/—";
    return `Citywide #${snapshot.currentZoneCitywideRank}/${snapshot.currentZoneCitywideTotal}`;
  }

  function buildBoroughStandingLabel(snapshot) {
    const borough = snapshot?.currentBoroughName || snapshot?.activeStableBorough || "Borough";
    if (!snapshot?.currentZoneBoroughRank || !snapshot?.currentZoneBoroughTotal) return `${borough} —/—`;
    return `${borough} #${snapshot.currentZoneBoroughRank}/${snapshot.currentZoneBoroughTotal}`;
  }

  function buildBestNowSummary(snapshot) {
    if (snapshot?.boroughBestNow?.zoneName) return `Best in borough now: ${snapshot.boroughBestNow.zoneName}`;
    if (snapshot?.citywideBestNow?.zoneName) return `Best citywide now: ${snapshot.citywideBestNow.zoneName}`;
    return "Best now unavailable";
  }

  function renderRankingList(items) {
    if (!Array.isArray(items) || !items.length) return "<div class=\"aiAssistMeta\">No ranking entries</div>";
    const rows = items.map((entry, index) => {
      const score = Number.isFinite(entry?.visibleRating) ? Math.round(entry.visibleRating) : "n/a";
      return `<li>${index + 1}. ${entry?.zoneName || "Unknown"} (${entry?.borough || "—"}) — ${score}</li>`;
    }).join("");
    return `<ol class="aiAssistRankList">${rows}</ol>`;
  }

  function formatTimeChip(snapshot) {
    if (!snapshot?.activeStableZoneId) return "Hold OK";
    if (snapshot.dwellEscalationLevel === "urgent" && snapshot.dwellShouldLeaveByTs) return `Leave by ${formatOutlookTimeLabel(snapshot.dwellShouldLeaveByTs)}`;
    if (snapshot.dwellEscalationLevel === "info" && snapshot.dwellWarnAtTs) {
      const mins = Math.max(0, Math.ceil((toEpochMs(snapshot.dwellWarnAtTs) - snapshot.ts) / 60000));
      return `Warn in ${mins}m`;
    }
    if (snapshot.dwellEscalationLevel === "warn" && snapshot.dwellShouldLeaveByTs) return `Leave by ${formatOutlookTimeLabel(snapshot.dwellShouldLeaveByTs)}`;
    return "Hold OK";
  }

  function dwellRiskHumanLabel(code) {
    return ({
      hold_strong: "Strong hold zone",
      hold_expiring: "Hold window expiring",
      trap_bad: "Trap zone overstay",
      slow_bad: "Slow zone overstay",
      mediocre_better_nearby: "Better nearby zone available",
      neutral: "Neutral dwell state",
    }[String(code || "neutral")] || "Neutral dwell state");
  }

  function toFingerprint() {
    return [
      state.activeStableZoneId || "",
      state.finalActionCode || state.actionCode || "",
      state.finalActionReason || state.actionReason || "",
      state.dwellRiskCode || "",
      state.dwellEscalationLevel || "",
      state.assistantMoveTarget?.locationId || "",
      Number.isFinite(state.rating) ? state.rating.toFixed(2) : "nan",
      Number.isFinite(state.currentZoneHoldScore) ? state.currentZoneHoldScore.toFixed(2) : "nan",
      state.currentZoneCitywideRank || "",
      state.currentZoneBoroughRank || "",
      state.rankingsCacheKey || "",
      state.outlookCacheKey || "",
      state.outlookLoading ? "1" : "0",
      state.outlookError || "",
      state.outlookDerived?.trapUntilTime || "",
      state.outlookDerived?.holdUntilTime || "",
      state.outlookDerived?.nextImprovementTime || "",
      state.dwellMs ? Math.round(state.dwellMs / 10000) : 0,
    ].join("|");
  }

  function renderBanner() {
    const host = getRecommendEl();
    if (!host) return;
    ensureStyle();
    bindRankingsToggleOnce();

    const ratingTxt = Number.isFinite(state.rating) ? `${Math.round(state.rating)} (${state.bucket || "n/a"})` : "n/a";
    const snapshot = getSnapshot();
    const cityRankTxt = buildCitywideStandingLabel(snapshot);
    const boroughRankTxt = buildBoroughStandingLabel(snapshot);
    const bestSummaryTxt = buildBestNowSummary(snapshot);
    const tagsHtml = (state.assistantTags || []).slice(0, 3).map((tag) => `<span class="aiAssistTag">${tag}</span>`).join("");
    const target = state.assistantMoveTarget;
    const canShowBorough = !!(snapshot.currentBoroughName && snapshot.currentZoneBoroughTotal);
    const boroughFallback = `<div class="aiAssistMeta">Borough rankings available after stable zone entry</div>`;
    const rankingsPanel = state.rankingsExpanded ? `
      <div class="aiAssistRankPanel" data-role="assistant-rankings-panel">
        <div class="aiAssistRankSection">
          <div class="aiAssistRankTitle">Dwell Coach</div>
          ${snapshot.activeStableZoneId ? `
          <div class="aiAssistMeta">Dwell time: ${formatDwell(snapshot.dwellMs)}</div>
          <div class="aiAssistMeta">Base action: ${snapshot.baseActionCode || "MONITOR"} (${snapshot.baseActionReason || "—"})</div>
          <div class="aiAssistMeta">Final action: ${snapshot.finalActionCode || "MONITOR"} (${snapshot.finalActionReason || "—"})</div>
          <div class="aiAssistMeta">Dwell risk: ${dwellRiskHumanLabel(snapshot.dwellRiskCode)}</div>
          <div class="aiAssistMeta">Escalation: ${snapshot.dwellEscalationLevel || "none"}</div>
          <div class="aiAssistMeta">Warn threshold: ${snapshot.dwellWarnAtTs ? formatOutlookTimeLabel(snapshot.dwellWarnAtTs) : "—"}</div>
          <div class="aiAssistMeta">Urgent threshold: ${snapshot.dwellUrgentAtTs ? formatOutlookTimeLabel(snapshot.dwellUrgentAtTs) : "—"}</div>
          <div class="aiAssistMeta">Leave by / recheck: ${snapshot.dwellShouldLeaveByTs ? formatOutlookTimeLabel(snapshot.dwellShouldLeaveByTs) : "—"}</div>
          <div class="aiAssistMeta">Coach: ${snapshot.dwellCoachSummaryText || "Hold OK"}</div>
          ${Array.isArray(snapshot.dwellCoachReasonFragments) && snapshot.dwellCoachReasonFragments.length
            ? `<div class="aiAssistMeta">Reasons: ${snapshot.dwellCoachReasonFragments.join(" • ")}</div>`
            : `<div class="aiAssistMeta">Reasons: none</div>`}
          ` : `<div class="aiAssistMeta">Neutral dwell state — no active stable zone yet.</div>`}
        </div>
        <div class="aiAssistRankSection">
          <div class="aiAssistRankTitle">Outlook</div>
          <div class="aiAssistMeta">Current phase: ${snapshot.activeFromTime ? formatOutlookTimeLabel(snapshot.activeFromTime) : "n/a"}</div>
          <div class="aiAssistMeta">Busy until: ${snapshot.busyUntilTime ? formatOutlookTimeLabel(snapshot.busyUntilTime) : "—"}</div>
          <div class="aiAssistMeta">Slow until: ${snapshot.slowUntilTime ? formatOutlookTimeLabel(snapshot.slowUntilTime) : "—"}</div>
          <div class="aiAssistMeta">Trap until: ${snapshot.trapUntilTime ? formatOutlookTimeLabel(snapshot.trapUntilTime) : "—"}</div>
          <div class="aiAssistMeta">Long-trip friendly until: ${snapshot.longTripFriendlyUntilTime ? formatOutlookTimeLabel(snapshot.longTripFriendlyUntilTime) : "—"}</div>
          <div class="aiAssistMeta">Saturation caution until: ${snapshot.saturationUntilTime ? formatOutlookTimeLabel(snapshot.saturationUntilTime) : "—"}</div>
          <div class="aiAssistMeta">Hold until: ${snapshot.holdUntilTime ? formatOutlookTimeLabel(snapshot.holdUntilTime) : "—"}</div>
          <div class="aiAssistMeta">Improves after: ${snapshot.nextImprovementTime ? formatOutlookTimeLabel(snapshot.nextImprovementTime) : "—"}</div>
          <div class="aiAssistMeta">Worsens after: ${snapshot.nextWorseningTime ? formatOutlookTimeLabel(snapshot.nextWorseningTime) : "—"}</div>
          ${target ? `<div class="aiAssistMeta">Target strong until: ${snapshot.targetStrongUntilTime ? formatOutlookTimeLabel(snapshot.targetStrongUntilTime) : "—"}</div><div class="aiAssistMeta">Target trap until: ${snapshot.targetTrapUntilTime ? formatOutlookTimeLabel(snapshot.targetTrapUntilTime) : "—"}</div><div class="aiAssistMeta">Target busy until: ${snapshot.targetBusyUntilTime ? formatOutlookTimeLabel(snapshot.targetBusyUntilTime) : "—"}</div><div class="aiAssistMeta">Target long-trip friendly until: ${snapshot.targetLongTripFriendlyUntilTime ? formatOutlookTimeLabel(snapshot.targetLongTripFriendlyUntilTime) : "—"}</div><div class="aiAssistMeta">Target stable bucket until: ${snapshot.targetStableBucketUntilTime ? formatOutlookTimeLabel(snapshot.targetStableBucketUntilTime) : "—"}</div>` : ""}
          <div class="aiAssistRankHint">Outlook is based on the next 6 current-source-of-truth frame bins.</div>
          <div class="aiAssistRankHint">Times are NYC local time.</div>
        </div>
        <div class="aiAssistRankSection">
          <div class="aiAssistRankTitle">Current standing</div>
          <div class="aiAssistMeta">${cityRankTxt}</div>
          <div class="aiAssistMeta">${boroughRankTxt}</div>
          <div class="aiAssistMeta">Current visible score: ${Number.isFinite(snapshot.rating) ? Math.round(snapshot.rating) : "n/a"}</div>
          <div class="aiAssistMeta">Current visible bucket: ${snapshot.bucket || "n/a"}</div>
          <div class="aiAssistMeta">Current visible source: ${snapshot.visibleScoreSourceLabel || "Team Joseo score"}</div>
        </div>
        <div class="aiAssistRankSection">
          <div class="aiAssistRankTitle">Citywide best/worst now</div>
          <div class="aiAssistMeta">Best citywide now: ${snapshot.citywideBestNow?.zoneName || "n/a"}</div>
          <div class="aiAssistMeta">Worst citywide now: ${snapshot.citywideWorstNow?.zoneName || "n/a"}</div>
        </div>
        <div class="aiAssistRankSection">
          <div class="aiAssistRankTitle">Top 10 citywide best now</div>
          ${renderRankingList(snapshot.citywideTop10Best)}
        </div>
        <div class="aiAssistRankSection">
          <div class="aiAssistRankTitle">Top 10 citywide worst now</div>
          ${renderRankingList(snapshot.citywideTop10Worst)}
        </div>
        <div class="aiAssistRankSection">
          <div class="aiAssistRankTitle">Current borough best/worst now</div>
          ${canShowBorough ? `<div class="aiAssistMeta">Best in borough now: ${snapshot.boroughBestNow?.zoneName || "n/a"}</div><div class="aiAssistMeta">Worst in borough now: ${snapshot.boroughWorstNow?.zoneName || "n/a"}</div>` : boroughFallback}
        </div>
        <div class="aiAssistRankSection">
          <div class="aiAssistRankTitle">Top 5 borough best now</div>
          ${canShowBorough ? renderRankingList(snapshot.boroughTop5Best) : boroughFallback}
        </div>
        <div class="aiAssistRankSection">
          <div class="aiAssistRankTitle">Top 5 borough worst now</div>
          ${canShowBorough ? renderRankingList(snapshot.boroughTop5Worst) : boroughFallback}
        </div>
        <div class="aiAssistRankHint">Rankings use the same visible Team Joseo score path the map is showing right now.</div>
        <div class="aiAssistRankHint">Community crowding caution is separate and does not reorder these standings.</div>
      </div>
    ` : "";

    host.innerHTML = `
      <div class="aiAssistBanner" data-phase="6" data-state="${state.finalActionCode || state.actionCode || "MONITOR"}" data-escalation="${state.dwellEscalationLevel || "none"}">
        <div class="aiAssistHeadline">${buildHeadline()}</div>
        <div class="aiAssistCoach">${snapshot.dwellCoachSummaryText || "Hold OK"}</div>
        <div class="aiAssistTimingChip">${formatTimeChip(snapshot)}</div>
        <div class="aiAssistMeta">Current: ${state.activeStableZoneName || "—"} • ${ratingTxt} • ${state.visibleScoreSourceLabel || "Team Joseo score"}</div>
        <div class="aiAssistMeta">${formatDwell(state.dwellMs)}</div>
        <div class="aiAssistMeta">${snapshot.outlookSummaryText || "Outlook neutral"}</div>
        ${snapshot.moveTargetOutlookSummaryText ? `<div class="aiAssistMeta">${snapshot.moveTargetOutlookSummaryText}</div>` : ""}
        <div class="aiAssistRankHeader">
          <div class="aiAssistRankChips">
            <span class="aiAssistRankChip">${cityRankTxt}</span>
            <span class="aiAssistRankChip">${boroughRankTxt}</span>
          </div>
          <button type="button" class="aiAssistRankToggle" data-assistant-rankings-toggle="1">${state.rankingsExpanded ? "Hide rankings" : "Rankings"}</button>
        </div>
        ${tagsHtml ? `<div class="aiAssistTags">${tagsHtml}</div>` : ""}
        ${target ? `<div class="aiAssistMeta">Target: ${target.zoneName} (${target.borough || "—"}) • ${formatMiles(target.distanceMiles)} • rating ${Math.round(target.visibleRating || 0)} • ${state.actionReason.replaceAll("_", " ")}</div>` : ""}
        <div class="aiAssistMeta">${buildSubline()}</div>
        <div class="aiAssistMeta">${bestSummaryTxt}</div>
        ${rankingsPanel}
      </div>
    `;
  }

  function bindRankingsToggleOnce() {
    if (state.rankingsBound) return;
    const host = getRecommendEl();
    if (!host) return;
    host.addEventListener("click", (event) => {
      const target = event?.target;
      if (!(target instanceof Element)) return;
      if (!target.closest("[data-assistant-rankings-toggle=\"1\"]")) return;
      state.rankingsExpanded = !state.rankingsExpanded;
      renderBanner();
    });
    state.rankingsBound = true;
  }

  function applyRankingsToState(rankings) {
    state.citywideRank = rankings?.currentZoneCitywideRank ?? null;
    state.citywideTotal = rankings?.currentZoneCitywideTotal ?? null;
    state.boroughRank = rankings?.currentZoneBoroughRank ?? null;
    state.boroughTotal = rankings?.currentZoneBoroughTotal ?? null;
    state.currentZoneCitywideRank = rankings?.currentZoneCitywideRank ?? null;
    state.currentZoneCitywideTotal = rankings?.currentZoneCitywideTotal ?? null;
    state.currentZoneBoroughRank = rankings?.currentZoneBoroughRank ?? null;
    state.currentZoneBoroughTotal = rankings?.currentZoneBoroughTotal ?? null;
    state.currentBoroughName = rankings?.currentBoroughName || "";
    state.citywideBestNow = rankings?.citywideBestNow || null;
    state.citywideWorstNow = rankings?.citywideWorstNow || null;
    state.citywideTop10Best = rankings?.citywideTop10Best || [];
    state.citywideTop10Worst = rankings?.citywideTop10Worst || [];
    state.boroughBestNow = rankings?.boroughBestNow || null;
    state.boroughWorstNow = rankings?.boroughWorstNow || null;
    state.boroughTop5Best = rankings?.boroughTop5Best || [];
    state.boroughTop5Worst = rankings?.boroughTop5Worst || [];
  }

  function applyNavDestination(actionCode, moveTarget) {
    const shouldSet = !!moveTarget && ["LEAVE_NOW", "MOVE_SOON", "STAY_BRIEFLY"].includes(actionCode);
    if (shouldSet) {
      window.TlcMapUiModule?.setNavDestination?.({ lat: moveTarget.lat, lng: moveTarget.lng });
      return true;
    }
    window.TlcMapUiModule?.setNavDestination?.(null);
    return false;
  }

  function updateStableZone(now) {
    const loc = state.lastUserLocation;
    if (!loc || !Number.isFinite(loc.lng) || !Number.isFinite(loc.lat)) {
      state.assistantStatus = "locating";
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
      state.assistantStatus = state.activeStableZoneId ? "tracking" : "no-stable-zone";
      return;
    }

    const props = feature.properties || {};
    const zoneId = getZoneId(props);
    if (!zoneId) {
      state.assistantStatus = "no-stable-zone";
      return;
    }

    state.activeZoneLastSeenTs = now;
    if (state.candidateZoneId !== zoneId) {
      state.candidateZoneId = zoneId;
      state.candidateZoneFirstSeenTs = now;
      state.candidateZoneConsecutiveHits = 1;
      state.assistantStatus = state.activeStableZoneId ? "tracking" : "locating";
      return;
    }

    state.candidateZoneConsecutiveHits += 1;
    const stableForMs = now - (state.candidateZoneFirstSeenTs || now);
    const isStable = state.candidateZoneConsecutiveHits >= STABLE_MIN_HITS && stableForMs >= STABLE_MIN_MS;
    if (isStable && state.activeStableZoneId !== zoneId) {
      state.activeStableZoneId = zoneId;
      state.activeStableZoneName = String(props.zone_name || "").trim() || `Zone ${zoneId}`;
      state.activeStableBorough = String(props.borough || "").trim();
      state.activeStableZoneEnterTs = now;
    }

    state.assistantStatus = state.activeStableZoneId ? "tracking" : "locating";
  }

  function getActiveStableZoneFeature(frame) {
    if (!state.activeStableZoneId) return null;
    return (frame?.polygons?.features || []).find((item) => getZoneId(item?.properties || {}) === String(state.activeStableZoneId)) || null;
  }

  function applyStatusOnly(status, headline, subline) {
    state.assistantStatus = status;
    state.actionCode = "MONITOR";
    state.actionReason = "insufficient_inputs";
    state.baseActionCode = "MONITOR";
    state.baseActionReason = "insufficient_inputs";
    state.finalActionCode = "MONITOR";
    state.finalActionReason = "insufficient_inputs";
    state.dwellRiskCode = "neutral";
    state.dwellEscalationLevel = "none";
    state.dwellWarningActive = false;
    state.dwellWarnAtTs = null;
    state.dwellUrgentAtTs = null;
    state.dwellShouldLeaveByTs = null;
    state.dwellCountdownMs = null;
    state.dwellCoachSummaryText = "Hold OK";
    state.dwellCoachReasonFragments = [];
    state.actionHeadline = headline;
    state.actionSubline = subline;
    state.actionSeverity = "neutral";
    state.assistantMoveTarget = null;
    state.navActive = applyNavDestination(state.finalActionCode, null);
  }

  function updateFromFrame(frame, now) {
    if (!frame) {
      state.rankingsCacheKey = "";
      state.rankingsCache = null;
      applyStatusOnly("frame-unavailable", "AI Assistant: frame unavailable", "Waiting for score frame.");
      return;
    }
    const baseRankings = ensureRankings(frame, null, now);
    applyRankingsToState(baseRankings);
    if (!state.activeStableZoneId) {
      applyStatusOnly("locating", "AI Assistant: locating current zone…", "Need a stable zone lock from location updates.");
      return;
    }

    const currentStableFeature = getActiveStableZoneFeature(frame);
    if (!currentStableFeature) {
      applyStatusOnly("frame-unavailable", "AI Assistant: frame unavailable for zone", "Waiting for active stable zone geometry.");
      return;
    }

    const candidateSet = computeNearbyAssistantCandidates(frame, currentStableFeature, state.signalSnapshot || null);
    const currentSignal = candidateSet.currentSignal;
    const decision = decideAssistantAction(currentSignal, candidateSet, state.signalSnapshot || null);
    const rankings = ensureRankings(frame, currentSignal, now);

    state.phase = 6;
    state.assistantStatus = currentSignal.airportExcluded ? "airport-excluded" : "classified";
    state.activeStableZoneName = currentSignal.zoneName;
    state.activeStableBorough = currentSignal.borough;
    state.visibleScoreSource = currentSignal.visibleScoreSource;
    state.visibleScoreSourceLabel = currentSignal.visibleScoreSourceLabel;
    state.rating = currentSignal.visibleRating;
    state.bucket = currentSignal.visibleBucket;
    state.airportExcluded = currentSignal.airportExcluded;
    applyRankingsToState(rankings);

    state.signalSnapshot = currentSignal;
    state.currentZoneHoldScore = decision.holdScore;
    state.bestNearbyOverall = serializeCandidate(candidateSet.bestNearbyOverall, decision.holdScore);
    state.bestNearbyTrapEscape = serializeCandidate(candidateSet.bestNearbyTrapEscape, decision.holdScore);
    state.bestNearbyLongTrip = serializeCandidate(candidateSet.bestNearbyLongTrip, decision.holdScore);

    state.assistantTags = buildAssistantTags(decision.classification);
    state.baseActionCode = decision.actionCode;
    state.baseActionReason = decision.actionReason;
    state.actionCode = decision.actionCode;
    state.actionReason = decision.actionReason;
    state.finalActionCode = decision.actionCode;
    state.finalActionReason = decision.actionReason;
    state.actionSeverity = decision.actionSeverity;
    state.assistantMoveTarget = decision.moveTarget;
    state.scoreAdvantageVsCurrent = decision.moveTarget?.scoreAdvantageVsCurrent ?? null;
    state.navActive = applyNavDestination(state.finalActionCode, state.assistantMoveTarget);
    state.assistantReasonFragments = buildAssistantActionExplanation(getSnapshot(now));
    state.actionHeadline = buildHeadline();
    state.actionSubline = buildSubline();
  }

  function getSnapshot(tsNow = Date.now()) {
    const dwellMs = state.activeStableZoneEnterTs ? Math.max(0, tsNow - state.activeStableZoneEnterTs) : 0;
    const snapshot = {
      phase: 6,
      activeStableZoneId: state.activeStableZoneId,
      activeStableZoneName: state.activeStableZoneName,
      activeStableBorough: state.activeStableBorough,
      activeStableZoneEnterTs: state.activeStableZoneEnterTs,
      visibleScoreSource: state.visibleScoreSource,
      visibleScoreSourceLabel: state.visibleScoreSourceLabel,
      rating: state.rating,
      bucket: state.bucket,
      airportExcluded: state.airportExcluded,
      dwellMs,
      dwellSeconds: Math.floor(dwellMs / 1000),
      dwellMinutesRounded: Math.round(dwellMs / 60000),
      citywideRank: state.citywideRank,
      citywideTotal: state.citywideTotal,
      boroughRank: state.boroughRank,
      boroughTotal: state.boroughTotal,
      currentZoneCitywideRank: state.currentZoneCitywideRank,
      currentZoneCitywideTotal: state.currentZoneCitywideTotal,
      currentZoneBoroughRank: state.currentZoneBoroughRank,
      currentZoneBoroughTotal: state.currentZoneBoroughTotal,
      currentBoroughName: state.currentBoroughName,
      citywideBestNow: toRankSnapshotEntry(state.citywideBestNow),
      citywideWorstNow: toRankSnapshotEntry(state.citywideWorstNow),
      citywideTop10Best: Array.isArray(state.citywideTop10Best) ? state.citywideTop10Best.map(toRankSnapshotEntry) : [],
      citywideTop10Worst: Array.isArray(state.citywideTop10Worst) ? state.citywideTop10Worst.map(toRankSnapshotEntry) : [],
      boroughBestNow: toRankSnapshotEntry(state.boroughBestNow),
      boroughWorstNow: toRankSnapshotEntry(state.boroughWorstNow),
      boroughTop5Best: Array.isArray(state.boroughTop5Best) ? state.boroughTop5Best.map(toRankSnapshotEntry) : [],
      boroughTop5Worst: Array.isArray(state.boroughTop5Worst) ? state.boroughTop5Worst.map(toRankSnapshotEntry) : [],
      rankingsComputed: !!state.rankingsCache,
      rankingsCacheKey: state.rankingsCacheKey || "",
      rankingsExpanded: !!state.rankingsExpanded,
      outlookLoading: !!state.outlookLoading,
      outlookError: state.outlookError || "",
      currentZoneOutlook: state.currentZoneOutlook ? { ...state.currentZoneOutlook } : null,
      moveTargetOutlook: state.moveTargetOutlook ? { ...state.moveTargetOutlook } : null,
      activeFromTime: state.outlookDerived?.activeFromTime || null,
      activeUntilTime: state.outlookDerived?.activeUntilTime || null,
      busyUntilTime: state.outlookDerived?.busyUntilTime || null,
      slowUntilTime: state.outlookDerived?.slowUntilTime || null,
      trapUntilTime: state.outlookDerived?.trapUntilTime || null,
      longTripFriendlyUntilTime: state.outlookDerived?.longTripFriendlyUntilTime || null,
      saturationUntilTime: state.outlookDerived?.saturationUntilTime || null,
      holdUntilTime: state.outlookDerived?.holdUntilTime || null,
      nextImprovementTime: state.outlookDerived?.nextImprovementTime || null,
      nextWorseningTime: state.outlookDerived?.nextWorseningTime || null,
      stableBucketUntilTime: state.outlookDerived?.stableBucketUntilTime || null,
      targetStrongUntilTime: state.outlookDerived?.targetStrongUntilTime || null,
      targetTrapUntilTime: state.outlookDerived?.targetTrapUntilTime || null,
      targetBusyUntilTime: state.outlookDerived?.targetBusyUntilTime || null,
      targetLongTripFriendlyUntilTime: state.outlookDerived?.targetLongTripFriendlyUntilTime || null,
      targetStableBucketUntilTime: state.outlookDerived?.targetStableBucketUntilTime || null,
      outlookExpanded: !!state.outlookExpanded,
      busyNowBase: state.signalSnapshot?.busyNowBase ?? null,
      busyNextBase: state.signalSnapshot?.busyNextBase ?? null,
      shortTripPenalty: state.signalSnapshot?.shortTripPenalty ?? null,
      longTripShare20Plus: state.signalSnapshot?.longTripShare20Plus ?? null,
      balancedTripShare: state.signalSnapshot?.balancedTripShare ?? null,
      churnPressure: state.signalSnapshot?.churnPressure ?? null,
      continuationRaw: state.signalSnapshot?.continuationRaw ?? null,
      marketSaturationPenalty: state.signalSnapshot?.marketSaturationPenalty ?? null,
      manhattanCoreSaturationPenalty: state.signalSnapshot?.manhattanCoreSaturationPenalty ?? null,
      shortTripTrapFlag: (state.assistantTags || []).includes("Short-trip trap"),
      slowNowFlag: (state.assistantTags || []).includes("Slow now"),
      longTripFriendlyFlag: (state.assistantTags || []).includes("Long-trip friendly"),
      saturationCautionFlag: (state.assistantTags || []).includes("Saturation caution"),
      goodContinuationFlag: (state.assistantTags || []).includes("Good continuation"),
      weakContinuationFlag: (state.assistantTags || []).includes("Weak continuation"),
      currentZoneHoldScore: state.currentZoneHoldScore,
      bestNearbyOverall: state.bestNearbyOverall,
      bestNearbyTrapEscape: state.bestNearbyTrapEscape,
      bestNearbyLongTrip: state.bestNearbyLongTrip,
      assistantMoveTarget: state.assistantMoveTarget,
      baseActionCode: state.baseActionCode || state.actionCode,
      baseActionReason: state.baseActionReason || state.actionReason,
      finalActionCode: state.finalActionCode || state.actionCode,
      finalActionReason: state.finalActionReason || state.actionReason,
      actionCode: state.actionCode,
      actionReason: state.actionReason,
      actionSeverity: state.actionSeverity,
      dwellRiskCode: state.dwellRiskCode || "neutral",
      dwellEscalationLevel: state.dwellEscalationLevel || "none",
      dwellWarningActive: !!state.dwellWarningActive,
      dwellWarningSinceTs: state.dwellWarningSinceTs,
      dwellWarnAtTs: state.dwellWarnAtTs,
      dwellUrgentAtTs: state.dwellUrgentAtTs,
      dwellShouldLeaveByTs: state.dwellShouldLeaveByTs,
      dwellCountdownMs: state.dwellCountdownMs,
      dwellCoachSummaryText: state.dwellCoachSummaryText || "",
      dwellCoachReasonFragments: Array.isArray(state.dwellCoachReasonFragments) ? [...state.dwellCoachReasonFragments] : [],
      assistantFeedVersion: 1,
      feedUpdatedAt: state.feedUpdatedAt,
      scoreAdvantageVsCurrent: state.scoreAdvantageVsCurrent,
      navActive: !!state.navActive,
      candidateSearchRadiusOverall: AI_ASSISTANT_NEARBY_OVERALL_MAX_MI,
      candidateSearchRadiusTrapEscape: AI_ASSISTANT_NEARBY_TRAP_ESCAPE_MAX_MI,
      candidateSearchRadiusLongTrip: AI_ASSISTANT_NEARBY_LONG_TRIP_MAX_MI,
      assistantTags: Array.isArray(state.assistantTags) ? [...state.assistantTags] : [],
      assistantReasonFragments: Array.isArray(state.assistantReasonFragments) ? [...state.assistantReasonFragments] : [],
      assistantStatus: state.assistantStatus,
      outlookSummaryText: "",
      moveTargetOutlookSummaryText: "",
      outlookReasonFragments: [],
      ts: tsNow,
    };
    snapshot.outlookSummaryText = buildCurrentZoneOutlookSummary(snapshot);
    snapshot.moveTargetOutlookSummaryText = buildMoveTargetOutlookSummary(snapshot);
    snapshot.outlookReasonFragments = buildOutlookReasonFragments(snapshot);
    return snapshot;
  }

  function buildAssistantFeedMaterialKey(snapshot) {
    const dwellMinuteBucket = Math.floor((snapshot?.dwellMs || 0) / 60000);
    return [
      snapshot?.activeStableZoneId || "",
      snapshot?.finalActionCode || "",
      snapshot?.finalActionReason || "",
      snapshot?.dwellRiskCode || "",
      snapshot?.dwellEscalationLevel || "",
      snapshot?.assistantMoveTarget?.locationId || "",
      snapshot?.currentZoneCitywideRank || "",
      snapshot?.currentZoneBoroughRank || "",
      snapshot?.holdUntilTime || "",
      dwellMinuteBucket,
    ].join("|");
  }

  function buildAssistantAlertKey(snapshot) {
    return [
      snapshot?.activeStableZoneId || "",
      snapshot?.dwellRiskCode || "",
      snapshot?.dwellEscalationLevel || "",
      snapshot?.assistantMoveTarget?.locationId || "",
    ].join("|");
  }

  function emitAssistantFeedEvents(snapshot, nowTs) {
    const materialKey = buildAssistantFeedMaterialKey(snapshot);
    if (materialKey !== state.assistantFeedMaterialKey) {
      state.assistantFeedMaterialKey = materialKey;
      state.assistantFeedLastEmittedAt = nowTs;
      state.feedUpdatedAt = nowTs;
      window.dispatchEvent(new CustomEvent("tlc-ai-assistant-snapshot-updated", { detail: snapshot }));
    }
    const alertKey = buildAssistantAlertKey(snapshot);
    const escalated = snapshot.dwellEscalationLevel === "warn" || snapshot.dwellEscalationLevel === "urgent";
    if (escalated && alertKey !== state.assistantAlertKey) {
      state.assistantAlertKey = alertKey;
      window.dispatchEvent(new CustomEvent("tlc-ai-assistant-alert", { detail: snapshot }));
    }
  }

  function clearAssistantHeartbeat() {
    if (state.assistantHeartbeatTimer) {
      clearInterval(state.assistantHeartbeatTimer);
      state.assistantHeartbeatTimer = null;
    }
  }

  function ensureAssistantHeartbeat() {
    if (!state.activeStableZoneId) {
      clearAssistantHeartbeat();
      return;
    }
    const intervalMs = document.visibilityState === "hidden" ? AI_ASSISTANT_HEARTBEAT_MS_HIDDEN : AI_ASSISTANT_HEARTBEAT_MS_VISIBLE;
    if (state.assistantHeartbeatTimer) return;
    state.assistantHeartbeatTimer = setInterval(() => {
      refresh().catch((err) => {
        console.warn("Assistant heartbeat refresh failed:", err);
      });
    }, intervalMs);
  }

  async function refresh(frame) {
    const now = Date.now();
    const activeFrame = getFrame(frame);
    updateStableZone(now);
    ensureAssistantHeartbeat();
    updateFromFrame(activeFrame, now);
    await refreshOutlook(activeFrame, now);
    state.dwellMs = state.activeStableZoneEnterTs ? Math.max(0, now - state.activeStableZoneEnterTs) : 0;
    reevaluateAssistantDwell(now);

    const nextFingerprint = toFingerprint();
    if (nextFingerprint !== state.lastRenderFingerprint) {
      state.lastRenderFingerprint = nextFingerprint;
      renderBanner();
    }

    const snapshot = getSnapshot(now);
    emitAssistantFeedEvents(snapshot, now);

    const actionFingerprint = [
      snapshot.finalActionCode || "",
      snapshot.finalActionReason || "",
      snapshot.assistantMoveTarget?.locationId || "",
      snapshot.navActive ? "1" : "0",
      Number.isFinite(snapshot.scoreAdvantageVsCurrent) ? snapshot.scoreAdvantageVsCurrent.toFixed(2) : "nan",
    ].join("|");
    if (actionFingerprint !== state.lastActionFingerprint) {
      state.lastActionFingerprint = actionFingerprint;
      window.dispatchEvent(new CustomEvent("tlc-ai-assistant-action-updated", { detail: snapshot }));
    }

    return snapshot;
  }

  async function refreshOutlook(frame, now) {
    const frameTime = String(frame?.time || "");
    const currentId = String(state.activeStableZoneId || "").trim();
    const targetId = String(state.assistantMoveTarget?.locationId || "").trim();
    const locationIds = [currentId, targetId].filter(Boolean).filter((id, idx, arr) => arr.indexOf(id) === idx);
    const requestKey = buildOutlookRequestKey(frameTime, locationIds);
    const sourceKey = `${state.visibleScoreSource || ""}|${state.assistantMoveTarget?.visibleScoreSource || ""}`;
    const refreshKey = `${requestKey}|${sourceKey}`;
    if (!requestKey) {
      resetOutlookState("");
      return;
    }
    if (state.lastOutlookRequestKey === refreshKey && (state.currentZoneOutlook || state.moveTargetOutlook || state.outlookError)) return;
    state.lastOutlookRequestKey = refreshKey;
    const payload = await fetchAssistantOutlook(frameTime, locationIds);
    const byId = payload?.outlook_by_location_id || payload?.locations || {};
    state.currentZoneOutlook = byId?.[currentId] || null;
    state.moveTargetOutlook = targetId ? (byId?.[targetId] || null) : null;
    const currentDerived = deriveAssistantOutlookWindows(state.currentZoneOutlook, state.visibleScoreSource, state.baseActionCode || state.actionCode);
    const targetDerived = deriveTargetOutlookWindows(state.moveTargetOutlook, state.assistantMoveTarget?.visibleScoreSource);
    state.outlookDerived = { ...(currentDerived || {}), ...(targetDerived || {}) };
    const snap = getSnapshot(now);
    const signature = JSON.stringify({
      outlookLoading: snap.outlookLoading,
      outlookError: snap.outlookError,
      currentZoneOutlook: snap.currentZoneOutlook,
      moveTargetOutlook: snap.moveTargetOutlook,
      activeFromTime: snap.activeFromTime,
      activeUntilTime: snap.activeUntilTime,
      busyUntilTime: snap.busyUntilTime,
      slowUntilTime: snap.slowUntilTime,
      trapUntilTime: snap.trapUntilTime,
      longTripFriendlyUntilTime: snap.longTripFriendlyUntilTime,
      saturationUntilTime: snap.saturationUntilTime,
      holdUntilTime: snap.holdUntilTime,
      nextImprovementTime: snap.nextImprovementTime,
      nextWorseningTime: snap.nextWorseningTime,
      stableBucketUntilTime: snap.stableBucketUntilTime,
      targetStrongUntilTime: snap.targetStrongUntilTime,
      targetTrapUntilTime: snap.targetTrapUntilTime,
      targetBusyUntilTime: snap.targetBusyUntilTime,
      targetLongTripFriendlyUntilTime: snap.targetLongTripFriendlyUntilTime,
      targetStableBucketUntilTime: snap.targetStableBucketUntilTime,
      outlookSummaryText: snap.outlookSummaryText,
      moveTargetOutlookSummaryText: snap.moveTargetOutlookSummaryText,
      outlookReasonFragments: snap.outlookReasonFragments,
    });
    if (signature !== state.outlookLastSignature) {
      state.outlookLastSignature = signature;
      window.dispatchEvent(new CustomEvent("tlc-ai-assistant-outlook-updated", { detail: snap }));
    }
  }

  function handleUserLocationUpdate(detail) {
    const lat = Number(detail?.lat ?? NaN);
    const lng = Number(detail?.lng ?? NaN);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      state.lastUserLocation = { lat, lng, ts: Number(detail?.ts ?? Date.now()) || Date.now() };
    }
    return refresh();
  }

  function updateAssistantForFrame(frame) {
    return refresh(frame);
  }

  function forceRefresh() {
    return refresh();
  }

  function clearState() {
    clearAssistantHeartbeat();
    Object.assign(state, {
      phase: 6,
      activeStableZoneId: null,
      activeStableZoneName: "",
      activeStableBorough: "",
      activeStableZoneEnterTs: null,
      candidateZoneId: null,
      candidateZoneFirstSeenTs: null,
      candidateZoneConsecutiveHits: 0,
      activeZoneLastSeenTs: null,
      lastUserLocation: null,
      assistantStatus: "idle",
      actionCode: "MONITOR",
      actionReason: "initializing",
      baseActionCode: "MONITOR",
      baseActionReason: "initializing",
      finalActionCode: "MONITOR",
      finalActionReason: "initializing",
      dwellRiskCode: "neutral",
      dwellEscalationLevel: "none",
      dwellWarningActive: false,
      dwellWarningSinceTs: null,
      dwellWarnAtTs: null,
      dwellUrgentAtTs: null,
      dwellShouldLeaveByTs: null,
      dwellCountdownMs: null,
      dwellCoachSummaryText: "Hold OK",
      dwellCoachReasonFragments: [],
      assistantFeedMaterialKey: "",
      assistantAlertKey: "",
      assistantFeedLastEmittedAt: 0,
      assistantHeartbeatTimer: null,
      actionHeadline: "AI Assistant: locating current zone…",
      actionSubline: "Waiting for location and frame.",
      actionSeverity: "neutral",
      assistantMoveTarget: null,
      currentZoneHoldScore: null,
      scoreAdvantageVsCurrent: null,
      navActive: false,
      visibleScoreSource: null,
      visibleScoreSourceLabel: null,
      rating: null,
      bucket: null,
      airportExcluded: false,
      citywideRank: null,
      citywideTotal: null,
      boroughRank: null,
      boroughTotal: null,
      rankingsCacheKey: "",
      rankingsCache: null,
      rankingsExpanded: false,
      lastRankingsComputedAt: null,
      currentZoneCitywideRank: null,
      currentZoneCitywideTotal: null,
      currentZoneBoroughRank: null,
      currentZoneBoroughTotal: null,
      currentBoroughName: "",
      citywideBestNow: null,
      citywideWorstNow: null,
      citywideTop10Best: [],
      citywideTop10Worst: [],
      boroughBestNow: null,
      boroughWorstNow: null,
      boroughTop5Best: [],
      boroughTop5Worst: [],
      signalSnapshot: null,
      bestNearbyOverall: null,
      bestNearbyTrapEscape: null,
      bestNearbyLongTrip: null,
      assistantTags: [],
      assistantReasonFragments: [],
      dwellMs: 0,
      lastRenderFingerprint: "",
      lastActionFingerprint: "",
      rankingsBound: state.rankingsBound,
      outlookCache: {},
      outlookCacheKey: "",
      outlookLoading: false,
      outlookError: "",
      currentZoneOutlook: null,
      moveTargetOutlook: null,
      outlookExpanded: false,
      lastOutlookRequestKey: "",
      lastOutlookLoadedAt: null,
      outlookAbortController: null,
      outlookRequestToken: 0,
      outlookDerived: null,
      outlookLastSignature: "",
      assistantFeedVersion: 1,
      feedUpdatedAt: null,
    });
    applyNavDestination("MONITOR", null);
    renderBanner();
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
  window.getTeamJoseoAiAssistantFeedSnapshot = () => window.TlcAiAssistantModule?.getSnapshot?.() || null;

  document.addEventListener("visibilitychange", () => {
    clearAssistantHeartbeat();
    ensureAssistantHeartbeat();
  });

  renderBanner();
  bindRankingsToggleOnce();
})();
