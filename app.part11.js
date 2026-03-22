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
        modeNote.innerHTML = `${joined} are <b>ON</b>: each applies only to its own scope.`;
      } else if (queensMode) {
        modeNote.innerHTML = `Queens Mode is <b>ON</b>: non-airport Queens anti-dead-zone trip-flow mode. Airport zones are excluded. Pay average is ignored.`;
      } else if (bronxWashHeightsMode) {
        modeNote.innerHTML = `Bronx/Wash Heights Mode is <b>ON</b>: trip-frequency prioritization for <b>Bronx + Manhattan 100th St and up corridor</b>.<br/>Pay average is ignored for this mode.`;
      } else if (manhattanMode) {
        modeNote.innerHTML = `Manhattan Mode is <b>ON</b>: core Manhattan anti-saturation proxy. Strong now + still strong next bin beats flash-in-the-pan zones. Bronx/Wash Heights corridor stays excluded.`;
      } else if (statenIslandMode) {
        modeNote.innerHTML = `Staten Island Mode is <b>ON</b>: Staten Island colors are <b>relative within Staten Island</b> only.<br/>Other boroughs remain NYC-wide.`;
      } else if (brooklynMode) {
        modeNote.innerHTML = `Brooklyn Mode is <b>ON</b>: Brooklyn zones are ranked relative within Brooklyn only from best to worst.`;
      } else {
        modeNote.innerHTML = `Colors come from rating (1–100) for the selected 20-minute window.<br/>Time label is NYC time.`;
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
    if (x >= 90) return { bucket: "green", color: "#00b050" };
    if (x >= 80) return { bucket: "purple", color: "#8000ff" };
    if (x >= 65) return { bucket: "blue", color: "#0066ff" };
    if (x >= 45) return { bucket: "sky", color: "#66ccff" };
    if (x >= 25) return { bucket: "yellow", color: "#ffd400" };
    return { bucket: "red", color: "#e60000" };
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

  function toggleModeByKey(key) {
    switch (String(key || "")) {
      case "statenIsland":
        statenIslandMode = !statenIslandMode;
        break;
      case "bronxWashHeights":
        bronxWashHeightsMode = !bronxWashHeightsMode;
        break;
      case "manhattan":
        manhattanMode = !manhattanMode;
        break;
      case "queens":
        queensMode = !queensMode;
        break;
      case "brooklyn":
        brooklynMode = !brooklynMode;
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
    return getModeFlags();
  }

  function effectiveBucket(props, geom) {
    if (queensMode && isQueensModeZone(props) && props.qn_local_bucket) return props.qn_local_bucket;
    if (brooklynMode && isBrooklynModeZone(props) && props.bk_local_bucket) return props.bk_local_bucket;
    if (bronxWashHeightsMode && isBronxWashHeightsModeZone(props) && props.bwh_local_bucket) return props.bwh_local_bucket;
    if (statenIslandMode && isStatenIslandFeature(props) && props.si_local_bucket) return props.si_local_bucket;
    if (manhattanMode && isManhattanModeZone(props, geom) && props.mh_local_bucket) return props.mh_local_bucket;
    return (props?.bucket || "").trim();
  }

  function effectiveColor(props, geom) {
    if (queensMode && isQueensModeZone(props) && props.qn_local_color) return props.qn_local_color;
    if (brooklynMode && isBrooklynModeZone(props) && props.bk_local_color) return props.bk_local_color;
    if (bronxWashHeightsMode && isBronxWashHeightsModeZone(props) && props.bwh_local_color) return props.bwh_local_color;
    if (statenIslandMode && isStatenIslandFeature(props) && props.si_local_color) return props.si_local_color;
    if (manhattanMode && isManhattanModeZone(props, geom) && props.mh_local_color) return props.mh_local_color;
    const st = props?.style || {};
    return st.fillColor || st.color || "#000";
  }

  function effectiveRating(props, geom) {
    if (queensMode && isQueensModeZone(props) && Number.isFinite(Number(props.qn_local_rating))) {
      return Number(props.qn_local_rating);
    }
    if (brooklynMode && isBrooklynModeZone(props) && Number.isFinite(Number(props.bk_local_rating))) {
      return Number(props.bk_local_rating);
    }
    if (bronxWashHeightsMode && isBronxWashHeightsModeZone(props) && Number.isFinite(Number(props.bwh_local_rating))) {
      return Number(props.bwh_local_rating);
    }
    if (statenIslandMode && isStatenIslandFeature(props) && Number.isFinite(Number(props.si_local_rating))) {
      return Number(props.si_local_rating);
    }
    if (manhattanMode && isManhattanModeZone(props, geom) && Number.isFinite(Number(props.mh_local_rating))) {
      return Number(props.mh_local_rating);
    }
    return Number(props?.rating ?? NaN);
  }

  function getActiveSpecialModeTagForFeature(props, geom) {
    if (queensMode && isQueensModeZone(props)) return "queens";
    if (brooklynMode && isBrooklynModeZone(props)) return "brooklyn";
    if (statenIslandMode && isStatenIslandFeature(props)) return "staten_island";
    if (bronxWashHeightsMode && isBronxWashHeightsModeZone(props)) return "bronx_wash_heights";
    if (manhattanMode && isManhattanModeZone(props, geom)) return "manhattan";
    return null;
  }

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
    effectiveBucket,
    effectiveColor,
    effectiveRating,
    getActiveSpecialModeTagForFeature
  };

  enforceSpecialModeExclusivity();
  persistSpecialModeState();
  syncStatenIslandUI();
  syncBronxWashHeightsUI();
  syncManhattanUI();
  syncQueensUI();
  syncBrooklynUI();
})();
