(function() {
  const runtime = window.FrontendRuntime || null;
  const runtimePolling = runtime?.polling || null;
  const core = window.TlcModeInternals || {};

  const legendEl = document.getElementById("legend");
  const btnStatenIsland = document.getElementById("btnStatenIsland");
  const btnBronxWashHeightsMode = document.getElementById("btnBronxWashHeightsMode");
  const btnQueensMode = document.getElementById("btnQueensMode");
  const btnBrooklynMode = document.getElementById("btnBrooklynMode");
  const modeNote = document.getElementById("modeNote");

  const LS_KEY_STATEN = "staten_island_mode_enabled";
  const LS_KEY_MANHATTAN = "manhattan_mode_enabled";
  const LS_KEY_BRONX_WASH_HEIGHTS = "bronx_wash_heights_mode";
  const LS_KEY_QUEENS = "queens_mode_enabled";
  const LS_KEY_BROOKLYN = "brooklyn_mode_enabled";

  const MANHATTAN_PICKUP_WEIGHT = 0.40;
  const MANHATTAN_NEXT_BIN_WEIGHT = 0.35;
  const MANHATTAN_PAY_WEIGHT = 0.25;
  const MANHATTAN_FADE_PENALTY_WEIGHT = 0.15;
  const MANHATTAN_GLOBAL_PENALTY = 0.98;

  const MANHATTAN_MIN_ZONES = 40;
  const MANHATTAN_CORE_MAX_LAT = 40.795;

  const BRONX_WASH_HEIGHTS_TRIP_FREQUENCY_WEIGHT = 0.55;
  const BRONX_WASH_HEIGHTS_FOLLOWUP_WEIGHT = 0.20;
  const BRONX_WASH_HEIGHTS_LOCAL_MOMENTUM_WEIGHT = 0.15;
  const BRONX_WASH_HEIGHTS_PROXIMITY_WEIGHT = 0.10;

  const QUEENS_TRIP_FREQUENCY_WEIGHT = 0.60;
  const QUEENS_FOLLOWUP_WEIGHT = 0.20;
  const QUEENS_LOCAL_MOMENTUM_WEIGHT = 0.12;
  const QUEENS_PROXIMITY_WEIGHT = 0.08;
  const QUEENS_DEAD_ZONE_PENALTY_WEIGHT = 0.03;
  const QUEENS_MIN_ZONES = 8;
  const QUEENS_NEARBY_RADIUS_MI = 1.35;
  const BROOKLYN_MIN_ZONES = 3;

  const BRONX_WASH_HEIGHTS_MANHATTAN_ZONE_IDS = new Set([
    "41", "42", "74", "75", "116", "127", "128", "151", "152", "166", "243", "244",
  ]);

  let statenIslandMode = (localStorage.getItem(LS_KEY_STATEN) || "0") === "1";
  let bronxWashHeightsMode = (localStorage.getItem(LS_KEY_BRONX_WASH_HEIGHTS) || "0") === "1";
  let manhattanMode = (localStorage.getItem(LS_KEY_MANHATTAN) || "0") === "1";
  let queensMode = (localStorage.getItem(LS_KEY_QUEENS) || "0") === "1";
  let brooklynMode = (localStorage.getItem(LS_KEY_BROOKLYN) || "0") === "1";

  function isStatenIslandFeature(props) {
    const b = (props?.borough || "").toString().toLowerCase();
    return b.includes("staten");
  }

  function isManhattanFeature(props) {
    const b = (props?.borough || "").toString().toLowerCase();
    return b.includes("manhattan");
  }

  function isQueensFeature(props) {
    const b = (props?.borough || "").toString().toLowerCase();
    return b.includes("queens");
  }

  function isAirportZone(props) {
    const zoneName = (props?.zone_name || "").toString().toLowerCase();
    const locationId = String(props?.LocationID ?? "").trim();
    const airportNameMatch = /airport|jfk|la guardia|laguardia|newark/i.test(zoneName);
    const airportLocationIdSet = new Set(["1", "132", "138"]);
    return airportNameMatch || airportLocationIdSet.has(locationId);
  }

  function isQueensModeZone(props) {
    return isQueensFeature(props) && !isAirportZone(props);
  }

  function isBrooklynFeature(props) {
    const b = (props?.borough || "").toString().toLowerCase();
    return b.includes("brooklyn");
  }

  function isBrooklynModeZone(props) {
    return isBrooklynFeature(props);
  }

  function isBronxWashHeightsBorough(props) {
    const b = (props?.borough || "").toString().toLowerCase();
    return b.includes("bronx");
  }

  function isBronxWashHeightsCorridorZone(props) {
    const b = (props?.borough || "").toString().toLowerCase();
    if (!b.includes("manhattan")) return false;
    return BRONX_WASH_HEIGHTS_MANHATTAN_ZONE_IDS.has(String(props?.LocationID ?? "").trim());
  }

  function isBronxWashHeightsModeZone(props) {
    return isBronxWashHeightsBorough(props) || isBronxWashHeightsCorridorZone(props);
  }

  function isCoreManhattan(props, geom) {
    if (!isManhattanFeature(props)) return false;
    const c = core.geometryCenter?.(geom);
    if (!c || !Number.isFinite(c.lat)) return false;
    return c.lat <= MANHATTAN_CORE_MAX_LAT;
  }

  function isManhattanModeZone(props, geom) {
    return isCoreManhattan(props, geom) && !isBronxWashHeightsModeZone(props);
  }

  function enforceSpecialModeExclusivity() {
    statenIslandMode = !!statenIslandMode;
    bronxWashHeightsMode = !!bronxWashHeightsMode;
    manhattanMode = !!manhattanMode;
    queensMode = !!queensMode;
    brooklynMode = !!brooklynMode;
  }

  function persistSpecialModeState() {
    localStorage.setItem(LS_KEY_BRONX_WASH_HEIGHTS, bronxWashHeightsMode ? "1" : "0");
    localStorage.setItem(LS_KEY_MANHATTAN, manhattanMode ? "1" : "0");
    localStorage.setItem(LS_KEY_STATEN, statenIslandMode ? "1" : "0");
    localStorage.setItem(LS_KEY_QUEENS, queensMode ? "1" : "0");
    localStorage.setItem(LS_KEY_BROOKLYN, brooklynMode ? "1" : "0");
  }

  function ensureManhattanButton() {
    let btn = document.getElementById("btnManhattan");
    if (btn) return btn;

    btn = document.createElement("button");
    btn.id = "btnManhattan";
    btn.type = "button";
    btn.className = "navBtn";
    btn.style.marginLeft = "6px";
    btn.style.padding = "6px 10px";
    btn.style.borderRadius = "10px";
    btn.style.border = "1px solid rgba(0,0,0,0.2)";
    btn.style.background = "rgba(255,255,255,0.95)";
    btn.style.fontWeight = "700";
    btn.style.fontSize = "12px";

    const navRow =
      document.getElementById("navRow") ||
      (legendEl ? legendEl.querySelector(".navRow") : null) ||
      legendEl;

    if (navRow) {
      if (btnStatenIsland && btnStatenIsland.parentElement === navRow) {
        btnStatenIsland.insertAdjacentElement("afterend", btn);
      } else {
        navRow.appendChild(btn);
      }
    } else {
      document.body.appendChild(btn);
    }

    return btn;
  }

  const btnManhattan = ensureManhattanButton();

  function syncManhattanUI() {
    if (!btnManhattan) return;
    btnManhattan.textContent = manhattanMode ? "Manhattan Mode: ON" : "Manhattan Mode: OFF";
    btnManhattan.classList.toggle("on", !!manhattanMode);
  }

  function syncQueensUI() {
    if (!btnQueensMode) return;
    btnQueensMode.textContent = queensMode ? "Queens Mode: ON" : "Queens Mode: OFF";
    btnQueensMode.classList.toggle("on", !!queensMode);
  }

  function syncBrooklynUI() {
    if (!btnBrooklynMode) return;
    btnBrooklynMode.textContent = brooklynMode ? "Brooklyn Mode: ON" : "Brooklyn Mode: OFF";
    btnBrooklynMode.classList.toggle("on", !!brooklynMode);
  }

  function syncStatenIslandUI() {
    if (btnStatenIsland) {
      btnStatenIsland.textContent = statenIslandMode ? "Staten Island Mode: ON" : "Staten Island Mode: OFF";
      btnStatenIsland.classList.toggle("on", !!statenIslandMode);
    }
    if (modeNote) {
      const activeLabels = [];
      if (queensMode) activeLabels.push("Queens Mode");
      if (manhattanMode) activeLabels.push("Manhattan Mode");
      if (statenIslandMode) activeLabels.push("Staten Island Mode");
      if (bronxWashHeightsMode) activeLabels.push("Bronx/Wash Heights Mode");
      if (brooklynMode) activeLabels.push("Brooklyn Mode");

      if (activeLabels.length > 1) {
        const joined = activeLabels.length === 2
          ? `${activeLabels[0]} and ${activeLabels[1]}`
          : `${activeLabels.slice(0, -1).join(", ")}, and ${activeLabels[activeLabels.length - 1]}`;
        modeNote.innerHTML = `${joined} are <b>ON</b>: each applies only to its own scope. Other zones continue using the Team Joseo citywide score.`;
      } else if (queensMode) {
        modeNote.innerHTML = `Queens Mode is <b>ON</b>: Team Joseo Queens earnings score for non-airport Queens zones, balancing busy-for-size demand, trip quality, continuation, and trap avoidance. Airport zones are excluded from hotspot logic. Other zones continue using the Team Joseo citywide score.`;
      } else if (bronxWashHeightsMode) {
        modeNote.innerHTML = `Bronx/Wash Heights Mode is <b>ON</b>: Team Joseo Bronx/Wash Heights earnings score for the Bronx and the defined upper-Manhattan corridor, balancing flow, busy-for-size demand, continuation, and trap avoidance. Airport zones remain excluded from hotspot logic. Other zones continue using the Team Joseo citywide score.`;
      } else if (manhattanMode) {
        modeNote.innerHTML = `Manhattan Mode is <b>ON</b>: Team Joseo Manhattan earnings score for core Manhattan, citywide-first with extra saturation caution while balancing trip quality, pay quality, continuation, and trap avoidance. Airport zones remain excluded from hotspot logic. Other zones continue using the Team Joseo citywide score.`;
      } else if (statenIslandMode) {
        modeNote.innerHTML = `Staten Island Mode is <b>ON</b>: Team Joseo Staten Island earnings score for Staten Island zones, balancing sparse-market stability, trip quality, pay quality, continuation, and trap avoidance. Airport zones remain excluded from hotspot logic. Other zones continue using the Team Joseo citywide score.`;
      } else if (brooklynMode) {
        modeNote.innerHTML = `Brooklyn Mode is <b>ON</b>: Team Joseo Brooklyn earnings score for Brooklyn zones, balancing busy-for-size demand, trip quality, pay efficiency, continuation, and trap avoidance. Airport zones remain excluded from hotspot logic. Other zones continue using the Team Joseo citywide score.`;
      } else {
        modeNote.innerHTML = `Base colors reflect the Team Joseo citywide score for the selected 20-minute window, blending busy-for-size demand density (not raw trip count), trip quality, pay quality, continuation, and trap avoidance. Airport zones are excluded from hotspot logic.`;
      }
    }
  }

  function syncBronxWashHeightsUI() {
    if (!btnBronxWashHeightsMode) return;
    btnBronxWashHeightsMode.textContent = bronxWashHeightsMode
      ? "Bronx/Wash Heights Mode: ON"
      : "Bronx/Wash Heights Mode: OFF";
    btnBronxWashHeightsMode.classList.toggle("on", !!bronxWashHeightsMode);
  }

  function colorFromLocalRating(r) {
    const x = Math.max(1, Math.min(100, Math.round(r)));
    if (x >= 87) return { bucket: "green", color: "#00b050" };
    if (x >= 73) return { bucket: "purple", color: "#8000ff" };
    if (x >= 60) return { bucket: "indigo", color: "#4b3cff" };
    if (x >= 48) return { bucket: "blue", color: "#0066ff" };
    if (x >= 40) return { bucket: "sky", color: "#66ccff" };
    if (x >= 33) return { bucket: "yellow", color: "#ffd400" };
    if (x >= 25) return { bucket: "orange", color: "#ff8c00" };
    return { bucket: "red", color: "#e60000" };
  }


  function clampRating100(value) {
    return Math.max(1, Math.min(100, Number(value) || 0));
  }

  function readCitywideShadowRating(props) {
    const n = Number(props?.earnings_shadow_rating_citywide_v2 ?? NaN);
    return Number.isFinite(n) ? Math.max(1, Math.min(100, Math.round(n))) : NaN;
  }

  function readCitywideShadowBucket(props) {
    const text = String(props?.earnings_shadow_bucket_citywide_v2 || "").trim();
    return text || "";
  }

  function readCitywideShadowColor(props) {
    const text = String(props?.earnings_shadow_color_citywide_v2 || "").trim();
    return text || "";
  }

  function readCitywideShadowConfidence(props) {
    const n = Number(props?.earnings_shadow_confidence_citywide_v2 ?? NaN);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : NaN;
  }

  function readCitywideV3ShadowRating(props) {
    const n = Number(props?.earnings_shadow_rating_citywide_v3 ?? NaN);
    return Number.isFinite(n) ? Math.max(1, Math.min(100, Math.round(n))) : NaN;
  }

  function readCitywideV3ShadowBucket(props) {
    const text = String(props?.earnings_shadow_bucket_citywide_v3 || "").trim();
    return text || "";
  }

  function readCitywideV3ShadowColor(props) {
    const text = String(props?.earnings_shadow_color_citywide_v3 || "").trim();
    return text || "";
  }

  function readCitywideV3ShadowConfidence(props) {
    const n = Number(props?.earnings_shadow_confidence_citywide_v3 ?? NaN);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : NaN;
  }

  function readManhattanShadowRating(props) {
    const n = Number(props?.earnings_shadow_rating_manhattan_v2 ?? NaN);
    return Number.isFinite(n) ? Math.max(1, Math.min(100, Math.round(n))) : NaN;
  }

  function readManhattanShadowBucket(props) {
    const text = String(props?.earnings_shadow_bucket_manhattan_v2 || "").trim();
    return text || "";
  }

  function readManhattanShadowColor(props) {
    const text = String(props?.earnings_shadow_color_manhattan_v2 || "").trim();
    return text || "";
  }

  function readManhattanShadowConfidence(props) {
    const n = Number(props?.earnings_shadow_confidence_manhattan_v2 ?? NaN);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : NaN;
  }

  function readManhattanV3ShadowRating(props) {
    const n = Number(props?.earnings_shadow_rating_manhattan_v3 ?? NaN);
    return Number.isFinite(n) ? Math.max(1, Math.min(100, Math.round(n))) : NaN;
  }

  function readManhattanV3ShadowBucket(props) {
    const text = String(props?.earnings_shadow_bucket_manhattan_v3 || "").trim();
    return text || "";
  }

  function readManhattanV3ShadowColor(props) {
    const text = String(props?.earnings_shadow_color_manhattan_v3 || "").trim();
    return text || "";
  }

  function readManhattanV3ShadowConfidence(props) {
    const n = Number(props?.earnings_shadow_confidence_manhattan_v3 ?? NaN);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : NaN;
  }

  function readBronxWashHeightsShadowRating(props) {
    const n = Number(props?.earnings_shadow_rating_bronx_wash_heights_v2 ?? NaN);
    return Number.isFinite(n) ? Math.max(1, Math.min(100, Math.round(n))) : NaN;
  }

  function readBronxWashHeightsShadowBucket(props) {
    const text = String(props?.earnings_shadow_bucket_bronx_wash_heights_v2 || "").trim();
    return text || "";
  }

  function readBronxWashHeightsShadowColor(props) {
    const text = String(props?.earnings_shadow_color_bronx_wash_heights_v2 || "").trim();
    return text || "";
  }

  function readBronxWashHeightsShadowConfidence(props) {
    const n = Number(props?.earnings_shadow_confidence_bronx_wash_heights_v2 ?? NaN);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : NaN;
  }

  function readBronxWashHeightsV3ShadowRating(props) {
    const n = Number(props?.earnings_shadow_rating_bronx_wash_heights_v3 ?? NaN);
    return Number.isFinite(n) ? Math.max(1, Math.min(100, Math.round(n))) : NaN;
  }

  function readBronxWashHeightsV3ShadowBucket(props) {
    const text = String(props?.earnings_shadow_bucket_bronx_wash_heights_v3 || "").trim();
    return text || "";
  }

  function readBronxWashHeightsV3ShadowColor(props) {
    const text = String(props?.earnings_shadow_color_bronx_wash_heights_v3 || "").trim();
    return text || "";
  }

  function readBronxWashHeightsV3ShadowConfidence(props) {
    const n = Number(props?.earnings_shadow_confidence_bronx_wash_heights_v3 ?? NaN);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : NaN;
  }

  function readQueensShadowRating(props) {
    const n = Number(props?.earnings_shadow_rating_queens_v2 ?? NaN);
    return Number.isFinite(n) ? Math.max(1, Math.min(100, Math.round(n))) : NaN;
  }

  function readQueensShadowBucket(props) {
    const text = String(props?.earnings_shadow_bucket_queens_v2 || "").trim();
    return text || "";
  }

  function readQueensShadowColor(props) {
    const text = String(props?.earnings_shadow_color_queens_v2 || "").trim();
    return text || "";
  }

  function readQueensShadowConfidence(props) {
    const n = Number(props?.earnings_shadow_confidence_queens_v2 ?? NaN);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : NaN;
  }

  function readQueensV3ShadowRating(props) {
    const n = Number(props?.earnings_shadow_rating_queens_v3 ?? NaN);
    return Number.isFinite(n) ? Math.max(1, Math.min(100, Math.round(n))) : NaN;
  }

  function readQueensV3ShadowBucket(props) {
    const text = String(props?.earnings_shadow_bucket_queens_v3 || "").trim();
    return text || "";
  }

  function readQueensV3ShadowColor(props) {
    const text = String(props?.earnings_shadow_color_queens_v3 || "").trim();
    return text || "";
  }

  function readQueensV3ShadowConfidence(props) {
    const n = Number(props?.earnings_shadow_confidence_queens_v3 ?? NaN);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : NaN;
  }

  function readBrooklynShadowRating(props) {
    const n = Number(props?.earnings_shadow_rating_brooklyn_v2 ?? NaN);
    return Number.isFinite(n) ? Math.max(1, Math.min(100, Math.round(n))) : NaN;
  }

  function readBrooklynShadowBucket(props) {
    const text = String(props?.earnings_shadow_bucket_brooklyn_v2 || "").trim();
    return text || "";
  }

  function readBrooklynShadowColor(props) {
    const text = String(props?.earnings_shadow_color_brooklyn_v2 || "").trim();
    return text || "";
  }

  function readBrooklynShadowConfidence(props) {
    const n = Number(props?.earnings_shadow_confidence_brooklyn_v2 ?? NaN);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : NaN;
  }

  function readBrooklynV3ShadowRating(props) {
    const n = Number(props?.earnings_shadow_rating_brooklyn_v3 ?? NaN);
    return Number.isFinite(n) ? Math.max(1, Math.min(100, Math.round(n))) : NaN;
  }

  function readBrooklynV3ShadowBucket(props) {
    const text = String(props?.earnings_shadow_bucket_brooklyn_v3 || "").trim();
    return text || "";
  }

  function readBrooklynV3ShadowColor(props) {
    const text = String(props?.earnings_shadow_color_brooklyn_v3 || "").trim();
    return text || "";
  }

  function readBrooklynV3ShadowConfidence(props) {
    const n = Number(props?.earnings_shadow_confidence_brooklyn_v3 ?? NaN);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : NaN;
  }

  function readStatenIslandShadowRating(props) {
    const n = Number(props?.earnings_shadow_rating_staten_island_v2 ?? NaN);
    return Number.isFinite(n) ? Math.max(1, Math.min(100, Math.round(n))) : NaN;
  }

  function readStatenIslandShadowBucket(props) {
    const text = String(props?.earnings_shadow_bucket_staten_island_v2 || "").trim();
    return text || "";
  }

  function readStatenIslandShadowColor(props) {
    const text = String(props?.earnings_shadow_color_staten_island_v2 || "").trim();
    return text || "";
  }

  function readStatenIslandShadowConfidence(props) {
    const n = Number(props?.earnings_shadow_confidence_staten_island_v2 ?? NaN);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : NaN;
  }

  function readStatenIslandV3ShadowRating(props) {
    const n = Number(props?.earnings_shadow_rating_staten_island_v3 ?? NaN);
    return Number.isFinite(n) ? Math.max(1, Math.min(100, Math.round(n))) : NaN;
  }

  function readStatenIslandV3ShadowBucket(props) {
    const text = String(props?.earnings_shadow_bucket_staten_island_v3 || "").trim();
    return text || "";
  }

  function readStatenIslandV3ShadowColor(props) {
    const text = String(props?.earnings_shadow_color_staten_island_v3 || "").trim();
    return text || "";
  }

  function readStatenIslandV3ShadowConfidence(props) {
    const n = Number(props?.earnings_shadow_confidence_staten_island_v3 ?? NaN);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : NaN;
  }

  function getLiveDayTendencyPayload() {
    return window.TlcDayTendencyState?.getPayload?.() || null;
  }

  function getLiveDayTendencyFrameContext() {
    return window.TlcDayTendencyState?.getFrameContext?.() || window.TlcDayTendencyState?.frameContext || null;
  }

  function getLiveDayTendencyAdvancedContext() {
    return window.TlcDayTendencyState?.getAdvancedContext?.() || window.TlcDayTendencyState?.advancedContext || null;
  }

  function getTendencyConfidenceFactor(payload) {
    const confidence = Number(payload?.confidence);
    if (!Number.isFinite(confidence)) return 1;
    return Math.max(0.35, Math.min(1, confidence));
  }

  function getLowTendencyFactor(payload) {
    const score = Number(payload?.score);
    if (!Number.isFinite(score)) return 0;
    if (score >= 80) return 0;
    return Math.max(0, Math.min(1, (80 - score) / 80));
  }

  function normalizeBoroughName(value) {
    return String(value || '').trim().toLowerCase();
  }

  function normalizeTendencyScope(value) {
    const scope = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
    if (!scope) return '';
    if (scope === 'real_location') return '';
    if (scope === 'citywide') return 'citywide';
    if (scope === 'manhattan_mode') return 'manhattan';
    if (scope === 'staten_island_mode') return 'staten_island';
    if (scope === 'queens_mode') return 'queens';
    if (scope === 'brooklyn_mode') return 'brooklyn';
    if (scope === 'bronx_wash_heights_mode') return 'bronx_wash_heights';
    if (scope === 'statenisland') return 'staten_island';
    if (scope === 'bronxwashheights') return 'bronx_wash_heights';
    return scope;
  }

  function isSpecialTendencyScope(scope) {
    return (
      scope === 'staten_island' ||
      scope === 'manhattan' ||
      scope === 'queens' ||
      scope === 'brooklyn' ||
      scope === 'bronx_wash_heights'
    );
  }

  function getFeatureBoroughName(props) {
    return normalizeBoroughName(props?.borough);
  }

  function getTendencyScopeWeight(props, geom, payload) {
    if (!payload) return 0;

    const payloadScope = normalizeTendencyScope(payload?.scope || payload?.source_mode);
    if (payloadScope === 'staten_island') return isStatenIslandFeature(props) ? 1 : 0;
    if (payloadScope === 'manhattan') return isManhattanModeZone(props, geom) ? 1 : 0;
    if (payloadScope === 'queens') return isQueensModeZone(props) ? 1 : 0;
    if (payloadScope === 'brooklyn') return isBrooklynModeZone(props) ? 1 : 0;
    if (payloadScope === 'bronx_wash_heights') return isBronxWashHeightsModeZone(props) ? 1 : 0;

    const payloadBorough = normalizeBoroughName(payload?.source_borough || payload?.borough);
    if (payloadBorough) {
      return getFeatureBoroughName(props) === payloadBorough ? 1 : 0;
    }

    if (!payloadScope || payloadScope === 'citywide' || !isSpecialTendencyScope(payloadScope)) {
      return 0;
    }

    return 0;
  }


  const BUCKET_THRESHOLDS = [
    { bucket: 'green', minRating: 87, rank: 0 },
    { bucket: 'purple', minRating: 73, rank: 1 },
    { bucket: 'indigo', minRating: 60, rank: 2 },
    { bucket: 'blue', minRating: 48, rank: 3 },
    { bucket: 'sky', minRating: 40, rank: 4 },
    { bucket: 'yellow', minRating: 33, rank: 5 },
    { bucket: 'orange', minRating: 25, rank: 6 },
    { bucket: 'red', minRating: 1, rank: 7 },
  ];

  const BUCKET_MIN_BY_NAME = BUCKET_THRESHOLDS.reduce((acc, item) => {
    acc[item.bucket] = item.minRating;
    return acc;
  }, {});

  const BUCKET_RANK_BY_NAME = BUCKET_THRESHOLDS.reduce((acc, item) => {
    acc[item.bucket] = item.rank;
    return acc;
  }, {});

  function getBucketRank(bucket) {
    const key = String(bucket || '').trim().toLowerCase();
    if (!key) return null;
    return Number.isFinite(BUCKET_RANK_BY_NAME[key]) ? BUCKET_RANK_BY_NAME[key] : null;
  }

  function getBucketMinRating(bucket) {
    const key = String(bucket || '').trim().toLowerCase();
    if (!key) return null;
    return Number.isFinite(BUCKET_MIN_BY_NAME[key]) ? BUCKET_MIN_BY_NAME[key] : null;
  }

  function clampAdjustedRatingToBucketDropCap(baseRating, adjustedRating, bucketDropCap) {
    const baseBucket = getBucketForRating(baseRating);
    const baseRank = getBucketRank(baseBucket);
    if (!Number.isFinite(baseRank)) {
      return { adjustedRating, bucketDropCapTriggered: false, minAllowedRating: null, baseBucket, adjustedBucket: getBucketForRating(adjustedRating) };
    }
    const cap = Number.isFinite(Number(bucketDropCap)) ? Math.max(0, Math.floor(Number(bucketDropCap))) : 1;
    const maxAllowedRank = Math.min(7, baseRank + cap);
    const minAllowedBucket = BUCKET_THRESHOLDS.find((item) => item.rank === maxAllowedRank)?.bucket || 'red';
    const minAllowedRating = getBucketMinRating(minAllowedBucket) || 1;
    if (adjustedRating >= minAllowedRating) {
      return { adjustedRating, bucketDropCapTriggered: false, minAllowedRating, baseBucket, adjustedBucket: getBucketForRating(adjustedRating) };
    }
    return {
      adjustedRating: minAllowedRating,
      bucketDropCapTriggered: true,
      minAllowedRating,
      baseBucket,
      adjustedBucket: getBucketForRating(minAllowedRating),
    };
  }

  function normalizeLocalScope(value) {
    const key = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
    if (!key || key === 'citywide' || key === 'none' || key === 'null') return '';
    if (key === 'manhattan_mode') return 'manhattan_mode';
    if (key === 'staten_island_mode') return 'staten_island_mode';
    if (key === 'bronx_wash_heights_mode') return 'bronx_wash_heights_mode';
    if (key === 'queens_mode') return 'queens_mode';
    if (key === 'brooklyn_mode') return 'brooklyn_mode';
    if (key === 'manhattan') return 'manhattan';
    if (key === 'queens') return 'queens';
    if (key === 'brooklyn') return 'brooklyn';
    if (key === 'staten_island' || key === 'statenisland') return 'staten_island';
    if (key === 'bronx_wash_heights' || key === 'bronxwashheights') return 'bronx_wash_heights';
    return key;
  }

  function getAdvancedLocalScope(advancedContext) {
    return normalizeLocalScope(
      advancedContext?.resolved_local_scope ||
      advancedContext?.local_scope ||
      advancedContext?.scope ||
      advancedContext?.scope_key ||
      advancedContext?.local_scope_key
    );
  }

  function isFeatureInAdvancedLocalScope(scope, props, geom) {
    if (!scope || scope === 'citywide') return false;
    if (scope === 'manhattan_mode') return isManhattanModeZone(props, geom);
    if (scope === 'staten_island_mode') return isStatenIslandFeature(props);
    if (scope === 'bronx_wash_heights_mode') return isBronxWashHeightsModeZone(props);
    if (scope === 'queens_mode') return isQueensModeZone(props);
    if (scope === 'brooklyn_mode') return isBrooklynModeZone(props);
    if (scope === 'manhattan') return isManhattanFeature(props);
    if (scope === 'queens') return isQueensFeature(props);
    if (scope === 'brooklyn') return isBrooklynFeature(props);
    if (scope === 'staten_island') return isStatenIslandFeature(props);
    if (scope === 'bronx_wash_heights') return isBronxWashHeightsModeZone(props);
    return false;
  }

  function getTendencyAdjustmentMeta(baseRating, props, geom) {
    const fallbackRating = clampRating100(baseRating);
    if (!Number.isFinite(Number(baseRating))) {
      return {
        adjustedRating: fallbackRating,
        adjustedFiniteRating: null,
        globalPenaltyApplied: 0,
        localPenaltyApplied: 0,
        totalPenaltyApplied: 0,
        localScopeMatch: false,
        localScope: '',
        bucketDropCapTriggered: false,
        reason: 'non_finite_base',
      };
    }

    if (isAirportZone(props)) {
      return {
        adjustedRating: fallbackRating,
        adjustedFiniteRating: fallbackRating,
        globalPenaltyApplied: 0,
        localPenaltyApplied: 0,
        totalPenaltyApplied: 0,
        localScopeMatch: false,
        localScope: '',
        bucketDropCapTriggered: false,
        reason: 'airport_zone',
      };
    }

    const advancedContext = getLiveDayTendencyAdvancedContext();
    if (!advancedContext) {
      return {
        adjustedRating: fallbackRating,
        adjustedFiniteRating: fallbackRating,
        globalPenaltyApplied: 0,
        localPenaltyApplied: 0,
        totalPenaltyApplied: 0,
        localScopeMatch: false,
        localScope: '',
        bucketDropCapTriggered: false,
        reason: 'missing_advanced_context',
      };
    }

    if (!advancedContext.ready_for_frontend_adjustment) {
      return {
        adjustedRating: fallbackRating,
        adjustedFiniteRating: fallbackRating,
        globalPenaltyApplied: 0,
        localPenaltyApplied: 0,
        totalPenaltyApplied: 0,
        localScopeMatch: false,
        localScope: getAdvancedLocalScope(advancedContext),
        bucketDropCapTriggered: false,
        reason: 'advanced_context_not_ready',
      };
    }

    const globalPenaltyApplied = Math.max(0, Number(advancedContext.global_penalty_points) || 0);
    const localScope = getAdvancedLocalScope(advancedContext);
    const localScopeMatch = isFeatureInAdvancedLocalScope(localScope, props, geom);
    const localPenaltyApplied = localScopeMatch ? Math.max(0, Number(advancedContext.local_penalty_points) || 0) : 0;
    const totalPenaltyCap = Math.max(0, Number(advancedContext.total_penalty_cap) || 0);
    const totalPenaltyApplied = Math.min(totalPenaltyCap, globalPenaltyApplied + localPenaltyApplied);
    const adjustedBeforeBucketCap = clampRating100(Number(baseRating) - totalPenaltyApplied);
    const bucketCapResult = clampAdjustedRatingToBucketDropCap(Number(baseRating), adjustedBeforeBucketCap, advancedContext.bucket_drop_cap);

    return {
      adjustedRating: bucketCapResult.adjustedRating,
      adjustedFiniteRating: bucketCapResult.adjustedRating,
      globalPenaltyApplied,
      localPenaltyApplied,
      totalPenaltyApplied,
      localScopeMatch,
      localScope,
      bucketDropCapTriggered: !!bucketCapResult.bucketDropCapTriggered,
      reason: 'adjusted',
    };
  }

  function getVisibleScoreSourceForFeature(props, geom) {
    if (queensMode && isQueensModeZone(props)) {
      if (Number.isFinite(readQueensV3ShadowRating(props))) return "queens_v3_shadow";
      if (Number.isFinite(readQueensShadowRating(props))) return "queens_shadow";
      if (Number.isFinite(Number(props.qn_local_rating))) return "queens_mode_legacy";
    }

    if (brooklynMode && isBrooklynModeZone(props)) {
      if (Number.isFinite(readBrooklynV3ShadowRating(props))) return "brooklyn_v3_shadow";
      if (Number.isFinite(readBrooklynShadowRating(props))) return "brooklyn_shadow";
      if (Number.isFinite(Number(props.bk_local_rating))) return "brooklyn_mode_legacy";
    }

    if (statenIslandMode && isStatenIslandFeature(props)) {
      if (Number.isFinite(readStatenIslandV3ShadowRating(props))) return "staten_island_v3_shadow";
      if (Number.isFinite(readStatenIslandShadowRating(props))) return "staten_island_shadow";
      if (Number.isFinite(Number(props.si_local_rating))) return "staten_island_mode_legacy";
    }

    if (bronxWashHeightsMode && isBronxWashHeightsModeZone(props)) {
      if (Number.isFinite(readBronxWashHeightsV3ShadowRating(props))) return "bronx_wash_heights_v3_shadow";
      if (Number.isFinite(readBronxWashHeightsShadowRating(props))) return "bronx_wash_heights_shadow";
      if (Number.isFinite(Number(props.bwh_local_rating))) return "bronx_wash_heights_mode_legacy";
    }

    if (manhattanMode && isManhattanModeZone(props, geom)) {
      if (Number.isFinite(readManhattanV3ShadowRating(props))) return "manhattan_v3_shadow";
      if (Number.isFinite(readManhattanShadowRating(props))) return "manhattan_shadow";
      if (Number.isFinite(Number(props.mh_local_rating))) return "manhattan_mode_legacy";
    }

    const citywideV3ShadowRating = readCitywideV3ShadowRating(props);
    if (Number.isFinite(citywideV3ShadowRating)) return "citywide_v3_shadow";

    const citywideShadowRating = readCitywideShadowRating(props);
    if (Number.isFinite(citywideShadowRating)) return "citywide_shadow";

    if (Number.isFinite(Number(props?.rating ?? NaN))) return "legacy_citywide";

    return "legacy_citywide";
  }

  function getVisibleScoreSourceLabel(props, geom) {
    const source = getVisibleScoreSourceForFeature(props, geom);

    switch (source) {
      case "citywide_v3_shadow":
      case "citywide_shadow":
      case "legacy_citywide":
        return "Citywide Team Joseo score";
      case "manhattan_shadow":
      case "manhattan_v3_shadow":
      case "manhattan_mode_legacy":
        return "Manhattan Team Joseo score";
      case "bronx_wash_heights_v3_shadow":
      case "bronx_wash_heights_shadow":
      case "bronx_wash_heights_mode_legacy":
        return "Bronx/Wash Heights Team Joseo score";
      case "queens_v3_shadow":
      case "queens_shadow":
      case "queens_mode_legacy":
        return "Queens Team Joseo score";
      case "brooklyn_v3_shadow":
      case "brooklyn_shadow":
      case "brooklyn_mode_legacy":
        return "Brooklyn Team Joseo score";
      case "staten_island_v3_shadow":
      case "staten_island_shadow":
      case "staten_island_mode_legacy":
        return "Staten Island Team Joseo score";
      default:
        return "Team Joseo score";
    }
  }

  function getVisibleScoreTechnicalSourceLabel(props, geom) {
    const source = getVisibleScoreSourceForFeature(props, geom);

    switch (source) {
      case "citywide_v3_shadow":
        return "citywide_v3 live shadow";
      case "citywide_shadow":
        return "citywide_v2 fallback shadow";
      case "manhattan_v3_shadow":
        return "manhattan_v3 live shadow";
      case "manhattan_shadow":
        return "manhattan_v2 fallback shadow";
      case "manhattan_mode_legacy":
        return "manhattan legacy fallback";
      case "bronx_wash_heights_v3_shadow":
        return "bronx_wash_heights_v3 live shadow";
      case "bronx_wash_heights_shadow":
        return "bronx_wash_heights_v2 fallback shadow";
      case "bronx_wash_heights_mode_legacy":
        return "bronx_wash_heights legacy fallback";
      case "queens_v3_shadow":
        return "queens_v3 live shadow";
      case "queens_shadow":
        return "queens_v2 fallback shadow";
      case "queens_mode_legacy":
        return "queens legacy fallback";
      case "brooklyn_v3_shadow":
        return "brooklyn_v3 live shadow";
      case "brooklyn_shadow":
        return "brooklyn_v2 fallback shadow";
      case "brooklyn_mode_legacy":
        return "brooklyn legacy fallback";
      case "staten_island_v3_shadow":
        return "staten_island_v3 live shadow";
      case "staten_island_shadow":
        return "staten_island_v2 fallback shadow";
      case "staten_island_mode_legacy":
        return "staten_island legacy fallback";
      case "legacy_citywide":
        return "legacy citywide fallback";
      default:
        return source || "unknown";
    }
  }

  function isVisibleScoreUsingFallback(props, geom) {
    const source = getVisibleScoreSourceForFeature(props, geom);
    return (
      source === "citywide_shadow" ||
      source === "legacy_citywide" ||
      source === "manhattan_shadow" ||
      source === "manhattan_mode_legacy" ||
      source === "bronx_wash_heights_shadow" ||
      source === "bronx_wash_heights_mode_legacy" ||
      source === "queens_shadow" ||
      source === "queens_mode_legacy" ||
      source === "brooklyn_shadow" ||
      source === "brooklyn_mode_legacy" ||
      source === "staten_island_shadow" ||
      source === "staten_island_mode_legacy"
    );
  }

  function getModeAwareBaseRating(props, geom) {
    if (queensMode && isQueensModeZone(props)) {
      const shadowRatingV3 = readQueensV3ShadowRating(props);
      if (Number.isFinite(shadowRatingV3)) return shadowRatingV3;
      const shadowRatingV2 = readQueensShadowRating(props);
      if (Number.isFinite(shadowRatingV2)) return shadowRatingV2;
      if (Number.isFinite(Number(props.qn_local_rating))) return Number(props.qn_local_rating);
    }
    if (brooklynMode && isBrooklynModeZone(props)) {
      const shadowRatingV3 = readBrooklynV3ShadowRating(props);
      if (Number.isFinite(shadowRatingV3)) return shadowRatingV3;
      const shadowRatingV2 = readBrooklynShadowRating(props);
      if (Number.isFinite(shadowRatingV2)) return shadowRatingV2;
      if (Number.isFinite(Number(props.bk_local_rating))) return Number(props.bk_local_rating);
    }
    if (statenIslandMode && isStatenIslandFeature(props)) {
      const shadowRatingV3 = readStatenIslandV3ShadowRating(props);
      if (Number.isFinite(shadowRatingV3)) return shadowRatingV3;
      const shadowRatingV2 = readStatenIslandShadowRating(props);
      if (Number.isFinite(shadowRatingV2)) return shadowRatingV2;
      if (Number.isFinite(Number(props.si_local_rating))) return Number(props.si_local_rating);
    }
    if (bronxWashHeightsMode && isBronxWashHeightsModeZone(props)) {
      const shadowRatingV3 = readBronxWashHeightsV3ShadowRating(props);
      if (Number.isFinite(shadowRatingV3)) return shadowRatingV3;
      const shadowRatingV2 = readBronxWashHeightsShadowRating(props);
      if (Number.isFinite(shadowRatingV2)) return shadowRatingV2;
      if (Number.isFinite(Number(props.bwh_local_rating))) return Number(props.bwh_local_rating);
    }
    if (manhattanMode && isManhattanModeZone(props, geom)) {
      const shadowRatingV3 = readManhattanV3ShadowRating(props);
      if (Number.isFinite(shadowRatingV3)) return shadowRatingV3;
      const shadowRatingV2 = readManhattanShadowRating(props);
      if (Number.isFinite(shadowRatingV2)) return shadowRatingV2;
      if (Number.isFinite(Number(props.mh_local_rating))) return Number(props.mh_local_rating);
    }

    const citywideV3ShadowRating = readCitywideV3ShadowRating(props);
    if (Number.isFinite(citywideV3ShadowRating)) {
      return citywideV3ShadowRating;
    }

    const citywideShadowRating = readCitywideShadowRating(props);
    if (Number.isFinite(citywideShadowRating)) {
      return citywideShadowRating;
    }

    const legacyCitywideRating = Number(props?.rating ?? NaN);
    if (Number.isFinite(legacyCitywideRating)) {
      return legacyCitywideRating;
    }

    return NaN;
  }

  function getModeAwareBaseBucket(props, geom) {
    const rating = getModeAwareBaseRating(props, geom);
    if (Number.isFinite(rating)) return getBucketForRating(rating);

    const source = getVisibleScoreSourceForFeature(props, geom);
    const legacyBucket = String(props?.bucket || "").trim();
    if (source === "queens_v3_shadow") {
      return readQueensV3ShadowBucket(props) || legacyBucket;
    }
    if (source === "queens_shadow") {
      return readQueensShadowBucket(props) || legacyBucket;
    }
    if (source === "brooklyn_v3_shadow") {
      return readBrooklynV3ShadowBucket(props) || legacyBucket;
    }
    if (source === "brooklyn_shadow") {
      return readBrooklynShadowBucket(props) || legacyBucket;
    }
    if (source === "staten_island_v3_shadow") {
      return readStatenIslandV3ShadowBucket(props) || legacyBucket;
    }
    if (source === "staten_island_shadow") {
      return readStatenIslandShadowBucket(props) || legacyBucket;
    }
    if (source === "bronx_wash_heights_v3_shadow") {
      return readBronxWashHeightsV3ShadowBucket(props) || legacyBucket;
    }
    if (source === "bronx_wash_heights_shadow") {
      return readBronxWashHeightsShadowBucket(props) || legacyBucket;
    }
    if (source === "manhattan_v3_shadow") {
      return readManhattanV3ShadowBucket(props) || legacyBucket;
    }
    if (source === "manhattan_shadow") {
      return readManhattanShadowBucket(props) || legacyBucket;
    }
    if (source === "citywide_v3_shadow") {
      return readCitywideV3ShadowBucket(props) || legacyBucket;
    }
    if (source === "citywide_shadow") {
      return readCitywideShadowBucket(props) || legacyBucket;
    }
    if (source === "legacy_citywide" && legacyBucket) return legacyBucket;
    return "";
  }

  function getModeAwareBaseColor(props, geom) {
    const rating = getModeAwareBaseRating(props, geom);
    if (Number.isFinite(rating)) return getColorForRating(rating);

    const source = getVisibleScoreSourceForFeature(props, geom);
    const legacyColor = String(props?.style?.fillColor || props?.style?.color || "").trim();
    if (source === "queens_v3_shadow") {
      return readQueensV3ShadowColor(props) || legacyColor;
    }
    if (source === "queens_shadow") {
      return readQueensShadowColor(props) || legacyColor;
    }
    if (source === "brooklyn_v3_shadow") {
      return readBrooklynV3ShadowColor(props) || legacyColor;
    }
    if (source === "brooklyn_shadow") {
      return readBrooklynShadowColor(props) || legacyColor;
    }
    if (source === "staten_island_v3_shadow") {
      return readStatenIslandV3ShadowColor(props) || legacyColor;
    }
    if (source === "staten_island_shadow") {
      return readStatenIslandShadowColor(props) || legacyColor;
    }
    if (source === "bronx_wash_heights_v3_shadow") {
      return readBronxWashHeightsV3ShadowColor(props) || legacyColor;
    }
    if (source === "bronx_wash_heights_shadow") {
      return readBronxWashHeightsShadowColor(props) || legacyColor;
    }
    if (source === "manhattan_v3_shadow") {
      return readManhattanV3ShadowColor(props) || legacyColor;
    }
    if (source === "manhattan_shadow") {
      return readManhattanShadowColor(props) || legacyColor;
    }
    if (source === "citywide_v3_shadow") {
      return readCitywideV3ShadowColor(props) || legacyColor;
    }
    if (source === "citywide_shadow") {
      return readCitywideShadowColor(props) || legacyColor;
    }
    if (source === "legacy_citywide" && legacyColor) return legacyColor;
    return "";
  }

  function getTendencyAdjustedRating(baseRating, props, geom) {
    return getTendencyAdjustmentMeta(baseRating, props, geom).adjustedRating;
  }

  function getTendencyFillAlpha(props, geom) {
    const advancedContext = getLiveDayTendencyAdvancedContext();
    if (advancedContext?.ready_for_frontend_adjustment && !isAirportZone(props)) return 1;
    const payload = getLiveDayTendencyPayload();
    if (!payload) return 1;
    const scopeWeight = getTendencyScopeWeight(props, geom, payload);
    if (scopeWeight <= 0) return 1;
    const lowFactor = getLowTendencyFactor(payload);
    if (lowFactor <= 0) return 1;
    const confidence = getTendencyConfidenceFactor(payload);
    const dimStrength = lowFactor * confidence * scopeWeight;
    const alpha = 1 - (dimStrength * 0.18);
    return Math.max(0.82, Math.min(1, alpha));
  }

  function hexToRgba(color, alpha) {
    const raw = String(color || '').trim();
    const match = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!match) return color;
    const hex = match[1];
    const normalized = hex.length === 3
      ? hex.split('').map((ch) => ch + ch).join('')
      : hex;
    const r = parseInt(normalized.slice(0, 2), 16);
    const g = parseInt(normalized.slice(2, 4), 16);
    const b = parseInt(normalized.slice(4, 6), 16);
    const safeAlpha = Math.max(0, Math.min(1, Number(alpha)));
    return `rgba(${r}, ${g}, ${b}, ${safeAlpha})`;
  }

  function effectiveFillColor(props, geom) {
    const baseColor = effectiveColor(props, geom);
    const alpha = getTendencyFillAlpha(props, geom);
    if (alpha >= 0.999) return baseColor;
    return hexToRgba(baseColor, alpha);
  }

  function applyStatenLocalView(frame) {
    const feats = frame?.polygons?.features || [];
    if (!feats.length) return frame;

    const siRatings = [];
    for (const f of feats) {
      const props = f.properties || {};
      if (!isStatenIslandFeature(props)) continue;
      const r = Number(props.rating ?? NaN);
      if (!Number.isFinite(r)) continue;
      siRatings.push(r);
    }
    if (siRatings.length < 3) return frame;

    const sorted = siRatings.slice().sort((a, b) => a - b);
    const n = sorted.length;

    function percentileOfRating(r) {
      let lo = 0;
      let hi = n - 1;
      let ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] <= r) {
          ans = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (n <= 1) return 0;
      return Math.max(0, Math.min(1, ans / (n - 1)));
    }

    for (const f of feats) {
      const props = f.properties || {};
      if (!isStatenIslandFeature(props)) {
        props.si_local_rating = null;
        props.si_local_bucket = null;
        props.si_local_color = null;
        continue;
      }
      const r = Number(props.rating ?? NaN);
      if (!Number.isFinite(r)) continue;

      const p = percentileOfRating(r);
      const localRating = 1 + 99 * p;
      const { bucket, color } = colorFromLocalRating(localRating);
      props.si_local_rating = Math.round(localRating);
      props.si_local_bucket = bucket;
      props.si_local_color = color;
    }

    return frame;
  }

  function applyManhattanLocalView(frame) {
    const feats = frame?.polygons?.features || [];
    if (!feats.length) return frame;

    const nextFramePickupsById = core.getNextFramePickupsById?.() || new Map();
    const mPickups = [];
    const mNextBinPickups = [];
    const mPay = [];

    const clearManhattanLocalProps = (props) => {
      props.mh_local_score = null;
      props.mh_local_rating = null;
      props.mh_local_bucket = null;
      props.mh_local_color = null;
      props.mh_pickup_strength = null;
      props.mh_next_bin_strength = null;
      props.mh_pay_strength = null;
      props.mh_fade_penalty = null;
    };

    for (const f of feats) {
      const props = f.properties || {};
      if (!isManhattanModeZone(props, f.geometry)) continue;

      const pu = Number(props.pickups ?? NaN);
      const nextPu = Number(nextFramePickupsById.get(String(props.LocationID ?? "")) ?? NaN);
      const pay = Number(props.avg_driver_pay ?? NaN);

      if (Number.isFinite(pu)) mPickups.push(pu);
      if (Number.isFinite(nextPu)) mNextBinPickups.push(nextPu);
      if (Number.isFinite(pay)) mPay.push(pay);
    }

    if (mPickups.length < MANHATTAN_MIN_ZONES || mPay.length < MANHATTAN_MIN_ZONES) {
      for (const f of feats) {
        clearManhattanLocalProps(f.properties || {});
      }
      return frame;
    }

    const pickSorted = mPickups.slice().sort((a, b) => a - b);
    const nextBinSorted = mNextBinPickups.length >= MANHATTAN_MIN_ZONES
      ? mNextBinPickups.slice().sort((a, b) => a - b)
      : null;
    const paySorted = mPay.slice().sort((a, b) => a - b);

    function percentileFromSorted(sorted, v) {
      const n = sorted.length;
      if (n <= 1) return 0;
      let lo = 0;
      let hi = n - 1;
      let ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] <= v) {
          ans = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return Math.max(0, Math.min(1, ans / (n - 1)));
    }

    for (const f of feats) {
      const props = f.properties || {};

      if (!isManhattanModeZone(props, f.geometry)) {
        clearManhattanLocalProps(props);
        continue;
      }

      const pu = Number(props.pickups ?? NaN);
      const nextPuRaw = Number(nextFramePickupsById.get(String(props.LocationID ?? "")) ?? NaN);
      const pay = Number(props.avg_driver_pay ?? NaN);

      if (!Number.isFinite(pu) || !Number.isFinite(pay)) {
        clearManhattanLocalProps(props);
        continue;
      }

      const pickupStrength = percentileFromSorted(pickSorted, pu);
      const nextBinStrength = (nextBinSorted && Number.isFinite(nextPuRaw))
        ? percentileFromSorted(nextBinSorted, nextPuRaw)
        : pickupStrength;
      const payStrength = percentileFromSorted(paySorted, pay);
      const fadePenalty = Math.max(0, pickupStrength - nextBinStrength);

      let modeScore =
        (MANHATTAN_PICKUP_WEIGHT * pickupStrength) +
        (MANHATTAN_NEXT_BIN_WEIGHT * nextBinStrength) +
        (MANHATTAN_PAY_WEIGHT * payStrength) -
        (MANHATTAN_FADE_PENALTY_WEIGHT * fadePenalty);

      modeScore = Math.max(0, Math.min(1, modeScore));

      let localRating = 1 + 99 * modeScore;
      localRating = localRating * MANHATTAN_GLOBAL_PENALTY;
      localRating = Math.max(1, Math.min(100, localRating));

      const { bucket, color } = colorFromLocalRating(localRating);
      props.mh_local_score = modeScore;
      props.mh_local_rating = Math.round(localRating);
      props.mh_local_bucket = bucket;
      props.mh_local_color = color;
      props.mh_pickup_strength = pickupStrength;
      props.mh_next_bin_strength = nextBinStrength;
      props.mh_pay_strength = payStrength;
      props.mh_fade_penalty = fadePenalty;
    }

    return frame;
  }

  function applyBronxWashHeightsLocalView(frame) {
    const feats = frame?.polygons?.features || [];
    if (!feats.length) return frame;

    const nextFramePickupsById = core.getNextFramePickupsById?.() || new Map();
    const scopedPickups = [];
    const scopedFollowups = [];

    for (const f of feats) {
      const props = f.properties || {};
      if (!isBronxWashHeightsModeZone(props)) continue;

      const pu = Number(props.pickups ?? NaN);
      const followup = Number(nextFramePickupsById.get(String(props.LocationID ?? "")) ?? NaN);
      if (Number.isFinite(pu)) scopedPickups.push(pu);
      if (Number.isFinite(followup)) scopedFollowups.push(followup);
    }

    if (scopedPickups.length < 8) {
      for (const f of feats) {
        const props = f.properties || {};
        props.bwh_local_rating = null;
        props.bwh_local_bucket = null;
        props.bwh_local_color = null;
        props.bwh_local_score = null;
      }
      return frame;
    }

    const pickSorted = scopedPickups.slice().sort((a, b) => a - b);
    const followupSorted = scopedFollowups.slice().sort((a, b) => a - b);

    function percentileFromSorted(sorted, v) {
      const n = sorted.length;
      if (n <= 1) return 0;
      let lo = 0;
      let hi = n - 1;
      let ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] <= v) {
          ans = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return Math.max(0, Math.min(1, ans / (n - 1)));
    }

    for (const f of feats) {
      const props = f.properties || {};
      if (!isBronxWashHeightsModeZone(props)) {
        props.bwh_local_rating = null;
        props.bwh_local_bucket = null;
        props.bwh_local_color = null;
        props.bwh_local_score = null;
        continue;
      }

      const pu = Number(props.pickups ?? NaN);
      if (!Number.isFinite(pu)) {
        props.bwh_local_rating = null;
        props.bwh_local_bucket = null;
        props.bwh_local_color = null;
        props.bwh_local_score = null;
        continue;
      }

      const curId = String(props.LocationID ?? "");
      const followup = Number(nextFramePickupsById.get(curId) ?? NaN);

      const tripFrequencyStrength = percentileFromSorted(pickSorted, pu);
      const followupTripStrength = Number.isFinite(followup)
        ? percentileFromSorted(followupSorted, followup)
        : tripFrequencyStrength;
      const localMomentumStrength = (tripFrequencyStrength * 0.6) + (followupTripStrength * 0.4);
      const proximityStrength = 1;

      let modeScore =
        (BRONX_WASH_HEIGHTS_TRIP_FREQUENCY_WEIGHT * tripFrequencyStrength) +
        (BRONX_WASH_HEIGHTS_FOLLOWUP_WEIGHT * followupTripStrength) +
        (BRONX_WASH_HEIGHTS_LOCAL_MOMENTUM_WEIGHT * localMomentumStrength) +
        (BRONX_WASH_HEIGHTS_PROXIMITY_WEIGHT * proximityStrength);

      modeScore = Math.max(0, Math.min(1, modeScore));
      const localRating = 1 + 99 * modeScore;

      const { bucket, color } = colorFromLocalRating(localRating);
      props.bwh_local_score = modeScore;
      props.bwh_local_rating = Math.round(localRating);
      props.bwh_local_bucket = bucket;
      props.bwh_local_color = color;
    }

    return frame;
  }

  function applyQueensLocalView(frame) {
    const feats = frame?.polygons?.features || [];
    if (!feats.length) return frame;

    const nextFramePickupsById = core.getNextFramePickupsById?.() || new Map();
    const userLatLng = core.getUserLatLng?.() || null;
    const scoped = [];
    const scopedPickups = [];
    const scopedFollowups = [];

    for (const f of feats) {
      const props = f.properties || {};
      if (!isQueensModeZone(props)) continue;

      const center = core.geometryCenter?.(f.geometry) || null;
      const pu = Number(props.pickups ?? NaN);
      const followupRaw = Number(nextFramePickupsById.get(String(props.LocationID ?? "")) ?? NaN);

      const row = { f, props, center, pu, followupRaw };
      scoped.push(row);

      if (Number.isFinite(pu)) scopedPickups.push(pu);
      if (Number.isFinite(followupRaw)) scopedFollowups.push(followupRaw);
    }

    if (scoped.length < QUEENS_MIN_ZONES) {
      for (const f of feats) {
        const props = f.properties || {};
        props.qn_local_score = null;
        props.qn_local_rating = null;
        props.qn_local_bucket = null;
        props.qn_local_color = null;
      }
      return frame;
    }

    const pickSorted = scopedPickups.slice().sort((a, b) => a - b);
    const followupSorted = scopedFollowups.slice().sort((a, b) => a - b);

    function percentileFromSorted(sorted, v) {
      const n = sorted.length;
      if (n <= 1) return 0;
      let lo = 0;
      let hi = n - 1;
      let ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] <= v) {
          ans = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return Math.max(0, Math.min(1, ans / (n - 1)));
    }

    const momentumRawList = [];
    for (const row of scoped) {
      if (!row.center) {
        row.localMomentumRaw = 0;
        momentumRawList.push(0);
        continue;
      }

      let sum = 0;
      let count = 0;
      for (const near of scoped) {
        if (!near.center || !Number.isFinite(near.pu)) continue;
        const dMi = core.haversineMiles?.(row.center, near.center) || 0;
        if (dMi <= QUEENS_NEARBY_RADIUS_MI) {
          sum += near.pu;
          count += 1;
        }
      }
      const raw = count > 0 ? sum / count : 0;
      row.localMomentumRaw = raw;
      momentumRawList.push(raw);
    }

    const momentumSorted = momentumRawList.slice().sort((a, b) => a - b);

    for (const f of feats) {
      const props = f.properties || {};
      if (!isQueensModeZone(props)) {
        props.qn_local_score = null;
        props.qn_local_rating = null;
        props.qn_local_bucket = null;
        props.qn_local_color = null;
        continue;
      }

      const row = scoped.find((x) => x.f === f);
      const tripFrequencyStrength = Number.isFinite(row?.pu)
        ? percentileFromSorted(pickSorted, row.pu)
        : 0;
      const followupTripStrength = Number.isFinite(row?.followupRaw)
        ? percentileFromSorted(followupSorted, row.followupRaw)
        : tripFrequencyStrength;
      const localMomentumStrength = percentileFromSorted(momentumSorted, Number(row?.localMomentumRaw ?? 0));

      let proximityStrength = 0.5;
      if (userLatLng && row?.center) {
        const dMi = core.haversineMiles?.(userLatLng, row.center) || 0;
        proximityStrength = Math.max(0, Math.min(1, 1 - (dMi / 8)));
      }

      const deadZonePenalty = Math.max(0, Math.min(1, 1 - Math.max(followupTripStrength, localMomentumStrength)));

      let modeScore =
        (QUEENS_TRIP_FREQUENCY_WEIGHT * tripFrequencyStrength) +
        (QUEENS_FOLLOWUP_WEIGHT * followupTripStrength) +
        (QUEENS_LOCAL_MOMENTUM_WEIGHT * localMomentumStrength) +
        (QUEENS_PROXIMITY_WEIGHT * proximityStrength) -
        (QUEENS_DEAD_ZONE_PENALTY_WEIGHT * deadZonePenalty);

      modeScore = Math.max(0, Math.min(1, modeScore));
      const localRating = 1 + 99 * modeScore;
      const { bucket, color } = colorFromLocalRating(localRating);

      props.qn_local_score = modeScore;
      props.qn_local_rating = Math.round(localRating);
      props.qn_local_bucket = bucket;
      props.qn_local_color = color;
    }

    return frame;
  }

  function applyBrooklynLocalView(frame) {
    const feats = frame?.polygons?.features || [];
    if (!feats.length) return frame;

    const bkRatings = [];
    for (const f of feats) {
      const props = f.properties || {};
      if (!isBrooklynModeZone(props)) continue;
      const r = Number(props.rating ?? NaN);
      if (!Number.isFinite(r)) continue;
      bkRatings.push(r);
    }

    if (bkRatings.length < BROOKLYN_MIN_ZONES) {
      for (const f of feats) {
        const props = f.properties || {};
        props.bk_local_rating = null;
        props.bk_local_bucket = null;
        props.bk_local_color = null;
        props.bk_local_score = null;
      }
      return frame;
    }

    const sorted = bkRatings.slice().sort((a, b) => a - b);
    const n = sorted.length;

    function percentileOfRating(r) {
      let lo = 0;
      let hi = n - 1;
      let ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] <= r) {
          ans = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (n <= 1) return 0;
      return Math.max(0, Math.min(1, ans / (n - 1)));
    }

    for (const f of feats) {
      const props = f.properties || {};
      if (!isBrooklynModeZone(props)) {
        props.bk_local_rating = null;
        props.bk_local_bucket = null;
        props.bk_local_color = null;
        props.bk_local_score = null;
        continue;
      }

      const r = Number(props.rating ?? NaN);
      if (!Number.isFinite(r)) {
        props.bk_local_rating = null;
        props.bk_local_bucket = null;
        props.bk_local_color = null;
        props.bk_local_score = null;
        continue;
      }

      const percentile = percentileOfRating(r);
      const localRating = 1 + 99 * percentile;
      const { bucket, color } = colorFromLocalRating(localRating);

      props.bk_local_score = percentile;
      props.bk_local_rating = Math.round(localRating);
      props.bk_local_bucket = bucket;
      props.bk_local_color = color;
    }

    return frame;
  }

  function getModeFlags() {
    return { statenIslandMode, bronxWashHeightsMode, manhattanMode, queensMode, brooklynMode };
  }

  function normalizeModeKey(key) {
    switch (String(key || "")) {
      case "statenIsland":
      case "statenIslandMode":
        return "statenIsland";
      case "bronxWashHeights":
      case "bronxWashHeightsMode":
        return "bronxWashHeights";
      case "manhattan":
      case "manhattanMode":
        return "manhattan";
      case "queens":
      case "queensMode":
        return "queens";
      case "brooklyn":
      case "brooklynMode":
        return "brooklyn";
      default:
        return "";
    }
  }

  function toggleModeByKey(key, desiredState) {
    const normalizedKey = normalizeModeKey(key);
    const useDesiredState = typeof desiredState === "boolean";

    switch (normalizedKey) {
      case "statenIsland":
        statenIslandMode = useDesiredState ? desiredState : !statenIslandMode;
        break;
      case "bronxWashHeights":
        bronxWashHeightsMode = useDesiredState ? desiredState : !bronxWashHeightsMode;
        break;
      case "manhattan":
        manhattanMode = useDesiredState ? desiredState : !manhattanMode;
        break;
      case "queens":
        queensMode = useDesiredState ? desiredState : !queensMode;
        break;
      case "brooklyn":
        brooklynMode = useDesiredState ? desiredState : !brooklynMode;
        break;
      default:
        return getModeFlags();
    }

    enforceSpecialModeExclusivity();
    persistSpecialModeState();
    syncStatenIslandUI();
    syncBronxWashHeightsUI();
    syncManhattanUI();
    syncQueensUI();
    syncBrooklynUI();
    const flags = getModeFlags();
    window.dispatchEvent(new CustomEvent('tlc-mode-changed', { detail: flags }));
    return flags;
  }

  function getBucketForRating(rating) {
    return colorFromLocalRating(rating).bucket;
  }

  function getColorForRating(rating) {
    return colorFromLocalRating(rating).color;
  }

  function effectiveBucket(props, geom) {
    const baseRating = getModeAwareBaseRating(props, geom);
    const meta = getTendencyAdjustmentMeta(baseRating, props, geom);
    if (Number.isFinite(meta.adjustedFiniteRating)) return getBucketForRating(meta.adjustedFiniteRating);
    return getModeAwareBaseBucket(props, geom);
  }

  function effectiveColor(props, geom) {
    const baseRating = getModeAwareBaseRating(props, geom);
    const meta = getTendencyAdjustmentMeta(baseRating, props, geom);
    if (Number.isFinite(meta.adjustedFiniteRating)) return getColorForRating(meta.adjustedFiniteRating);
    return getModeAwareBaseColor(props, geom);
  }

  function effectiveRating(props, geom) {
    const baseRating = getModeAwareBaseRating(props, geom);
    return getTendencyAdjustedRating(baseRating, props, geom);
  }

  function getFeatureVisibleScoreDebug(props, geom) {
    const visibleScoreSource = getVisibleScoreSourceForFeature(props, geom);
    const airportExcluded = isAirportZone(props);
    const activeMode = getActiveSpecialModeTagForFeature(props, geom) || "citywide";
    const rating = effectiveRating(props, geom);
    const derivedFromRating = Number.isFinite(Number(rating));
    const bucket = effectiveBucket(props, geom);
    const color = effectiveColor(props, geom);
    return {
      visibleScoreSource,
      airport_excluded: airportExcluded,
      active_mode: activeMode,
      chosen_rating_source: visibleScoreSource,
      chosen_bucket_source: derivedFromRating ? "derived_from_rating" : visibleScoreSource,
      chosen_color_source: derivedFromRating ? "derived_from_rating" : visibleScoreSource,
      chosen_rating: Number.isFinite(Number(rating)) ? Number(rating) : null,
      chosen_bucket: String(bucket || ""),
      chosen_color: String(color || "")
    };
  }

  function getActiveSpecialModeTagForFeature(props, geom) {
    if (queensMode && isQueensModeZone(props)) return "queens";
    if (brooklynMode && isBrooklynModeZone(props)) return "brooklyn";
    if (statenIslandMode && isStatenIslandFeature(props)) return "staten_island";
    if (bronxWashHeightsMode && isBronxWashHeightsModeZone(props)) return "bronx_wash_heights";
    if (manhattanMode && isManhattanModeZone(props, geom)) return "manhattan";
    return null;
  }

  window.addEventListener('tlc-day-tendency-updated', () => {
    core.renderCurrentFrame?.();
  });

  if (btnManhattan) {
    btnManhattan.addEventListener("pointerdown", (e) => e.stopPropagation());
    btnManhattan.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
    btnManhattan.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleModeByKey("manhattan");
      core.renderCurrentFrame?.();
    });
  }

  if (btnStatenIsland) {
    btnStatenIsland.addEventListener("pointerdown", (e) => e.stopPropagation());
    btnStatenIsland.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
    btnStatenIsland.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleModeByKey("statenIsland");
      core.renderCurrentFrame?.();
    });
  }

  if (btnQueensMode) {
    btnQueensMode.addEventListener("pointerdown", (e) => e.stopPropagation());
    btnQueensMode.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
    btnQueensMode.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleModeByKey("queens");
      core.renderCurrentFrame?.();
    });
  }

  if (btnBrooklynMode) {
    btnBrooklynMode.addEventListener("pointerdown", (e) => e.stopPropagation());
    btnBrooklynMode.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
    btnBrooklynMode.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleModeByKey("brooklyn");
      core.renderCurrentFrame?.();
    });
  }

  if (btnBronxWashHeightsMode) {
    btnBronxWashHeightsMode.addEventListener("pointerdown", (e) => e.stopPropagation());
    btnBronxWashHeightsMode.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
    btnBronxWashHeightsMode.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleModeByKey("bronxWashHeights");
      core.renderCurrentFrame?.();
    });
  }

  window.getDayTendencyColorDebug = function (props, geom) {
    const payload = getLiveDayTendencyPayload();
    const frameContext = getLiveDayTendencyFrameContext();
    const advancedContext = getLiveDayTendencyAdvancedContext();
    const baseRating = getModeAwareBaseRating(props, geom);
    const adjustmentMeta = getTendencyAdjustmentMeta(baseRating, props, geom);
    const finalRating = effectiveRating(props, geom);
    const scopeWeight = getTendencyScopeWeight(props, geom, payload);
    const lowTendencyFactor = getLowTendencyFactor(payload);
    const fillAlpha = getTendencyFillAlpha(props, geom);
    const baseColor = effectiveColor(props, geom);
    const fillColor = effectiveFillColor(props, geom);
    return {
      payload,
      frameContext,
      advancedContext,
      modeFlags: getModeFlags(),
      activeModeTag: getActiveSpecialModeTagForFeature(props, geom),
      visibleScoreSource: getVisibleScoreSourceForFeature(props, geom),
      citywideV3ShadowRating: readCitywideV3ShadowRating(props),
      citywideV3ShadowBucket: readCitywideV3ShadowBucket(props),
      citywideV3ShadowConfidence: readCitywideV3ShadowConfidence(props),
      citywideShadowRating: readCitywideShadowRating(props),
      citywideShadowBucket: readCitywideShadowBucket(props),
      citywideShadowConfidence: readCitywideShadowConfidence(props),
      manhattanShadowRating: readManhattanShadowRating(props),
      manhattanShadowBucket: readManhattanShadowBucket(props),
      manhattanShadowConfidence: readManhattanShadowConfidence(props),
      manhattanV3ShadowRating: readManhattanV3ShadowRating(props),
      manhattanV3ShadowBucket: readManhattanV3ShadowBucket(props),
      manhattanV3ShadowConfidence: readManhattanV3ShadowConfidence(props),
      bronxWashHeightsV3ShadowRating: readBronxWashHeightsV3ShadowRating(props),
      bronxWashHeightsV3ShadowBucket: readBronxWashHeightsV3ShadowBucket(props),
      bronxWashHeightsV3ShadowConfidence: readBronxWashHeightsV3ShadowConfidence(props),
      bronxWashHeightsShadowRating: readBronxWashHeightsShadowRating(props),
      bronxWashHeightsShadowBucket: readBronxWashHeightsShadowBucket(props),
      bronxWashHeightsShadowConfidence: readBronxWashHeightsShadowConfidence(props),
      queensV3ShadowRating: readQueensV3ShadowRating(props),
      queensV3ShadowBucket: readQueensV3ShadowBucket(props),
      queensV3ShadowConfidence: readQueensV3ShadowConfidence(props),
      queensShadowRating: readQueensShadowRating(props),
      queensShadowBucket: readQueensShadowBucket(props),
      queensShadowConfidence: readQueensShadowConfidence(props),
      brooklynV3ShadowRating: readBrooklynV3ShadowRating(props),
      brooklynV3ShadowBucket: readBrooklynV3ShadowBucket(props),
      brooklynV3ShadowConfidence: readBrooklynV3ShadowConfidence(props),
      brooklynShadowRating: readBrooklynShadowRating(props),
      brooklynShadowBucket: readBrooklynShadowBucket(props),
      brooklynShadowConfidence: readBrooklynShadowConfidence(props),
      statenIslandShadowRating: readStatenIslandShadowRating(props),
      statenIslandShadowBucket: readStatenIslandShadowBucket(props),
      statenIslandShadowConfidence: readStatenIslandShadowConfidence(props),
      statenIslandV3ShadowRating: readStatenIslandV3ShadowRating(props),
      statenIslandV3ShadowBucket: readStatenIslandV3ShadowBucket(props),
      statenIslandV3ShadowConfidence: readStatenIslandV3ShadowConfidence(props),
      baseRating,
      adjustedRating: adjustmentMeta.adjustedRating,
      finalRating,
      scopeWeight,
      lowTendencyFactor,
      fillAlpha,
      baseColor,
      fillColor,
      baseBucket: getBucketForRating(baseRating),
      adjustedBucket: Number.isFinite(adjustmentMeta.adjustedFiniteRating) ? getBucketForRating(adjustmentMeta.adjustedFiniteRating) : null,
      globalPenaltyApplied: adjustmentMeta.globalPenaltyApplied,
      localPenaltyApplied: adjustmentMeta.localPenaltyApplied,
      totalPenaltyApplied: adjustmentMeta.totalPenaltyApplied,
      localScopeMatch: adjustmentMeta.localScopeMatch,
      bucketDropCapTriggered: adjustmentMeta.bucketDropCapTriggered,
      finalBucket: effectiveBucket(props, geom)
    };
  };

  window.TlcModeModule = {
    getModeFlags,
    toggleModeByKey,
    syncStatenIslandUI,
    syncBronxWashHeightsUI,
    syncManhattanUI,
    syncQueensUI,
    syncBrooklynUI,
    applyStatenLocalView,
    applyManhattanLocalView,
    applyBronxWashHeightsLocalView,
    applyQueensLocalView,
    applyBrooklynLocalView,
    getBucketForRating,
    getColorForRating,
    effectiveBucket,
    effectiveColor,
    effectiveFillColor,
    effectiveRating,
    getTendencyFillAlpha,
    getActiveSpecialModeTagForFeature,
    getVisibleScoreSourceForFeature,
    getVisibleScoreSourceLabel,
    getVisibleScoreTechnicalSourceLabel,
    isVisibleScoreUsingFallback,
    getModeAwareBaseRating,
    getModeAwareBaseBucket,
    getModeAwareBaseColor,
    getFeatureVisibleScoreDebug,
    readCitywideV3ShadowRating,
    readCitywideV3ShadowBucket,
    readCitywideV3ShadowColor,
    readCitywideV3ShadowConfidence,
    readManhattanShadowRating,
    readManhattanShadowBucket,
    readManhattanV3ShadowRating,
    readManhattanV3ShadowBucket,
    readManhattanV3ShadowColor,
    readManhattanV3ShadowConfidence,
    readManhattanShadowConfidence,
    readBrooklynShadowRating,
    readBrooklynShadowBucket,
    readBrooklynV3ShadowRating,
    readBrooklynV3ShadowBucket,
    readBrooklynV3ShadowColor,
    readBrooklynV3ShadowConfidence,
    readBrooklynShadowConfidence,
    readQueensShadowRating,
    readQueensShadowBucket,
    readQueensShadowConfidence,
    readQueensV3ShadowRating,
    readQueensV3ShadowBucket,
    readQueensV3ShadowColor,
    readQueensV3ShadowConfidence,
    readBronxWashHeightsShadowRating,
    readBronxWashHeightsShadowBucket,
    readBronxWashHeightsShadowConfidence,
    readBronxWashHeightsV3ShadowRating,
    readBronxWashHeightsV3ShadowBucket,
    readBronxWashHeightsV3ShadowColor,
    readBronxWashHeightsV3ShadowConfidence,
    readStatenIslandShadowRating,
    readStatenIslandShadowBucket,
    readStatenIslandShadowConfidence,
    readStatenIslandV3ShadowRating,
    readStatenIslandV3ShadowBucket,
    readStatenIslandV3ShadowColor,
    readStatenIslandV3ShadowConfidence
  };

  enforceSpecialModeExclusivity();
  persistSpecialModeState();
  syncStatenIslandUI();
  syncBronxWashHeightsUI();
  syncManhattanUI();
  syncQueensUI();
  syncBrooklynUI();
})();
