(function() {
  const core = window.TlcModeInternals || {};

  function normalizeShadowNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function normalizeShadowText(value) {
    if (value == null) return "";
    return String(value).trim();
  }

  function readCitywideShadowFields(props) {
    const source = props || {};
    return {
      next_pickups_shadow: normalizeShadowNumber(source.next_pickups_shadow),
      median_driver_pay_shadow: normalizeShadowNumber(source.median_driver_pay_shadow),
      median_pay_per_min_shadow: normalizeShadowNumber(source.median_pay_per_min_shadow),
      median_pay_per_mile_shadow: normalizeShadowNumber(source.median_pay_per_mile_shadow),
      median_request_to_pickup_min_shadow: normalizeShadowNumber(source.median_request_to_pickup_min_shadow),
      short_trip_share_shadow: normalizeShadowNumber(source.short_trip_share_shadow),
      shared_ride_share_shadow: normalizeShadowNumber(source.shared_ride_share_shadow),
      downstream_value_shadow: normalizeShadowNumber(source.downstream_value_shadow),
      demand_now_n_shadow: normalizeShadowNumber(source.demand_now_n_shadow),
      demand_next_n_shadow: normalizeShadowNumber(source.demand_next_n_shadow),
      pay_n_shadow: normalizeShadowNumber(source.pay_n_shadow),
      pay_per_min_n_shadow: normalizeShadowNumber(source.pay_per_min_n_shadow),
      pay_per_mile_n_shadow: normalizeShadowNumber(source.pay_per_mile_n_shadow),
      pickup_friction_penalty_n_shadow: normalizeShadowNumber(source.pickup_friction_penalty_n_shadow),
      short_trip_penalty_n_shadow: normalizeShadowNumber(source.short_trip_penalty_n_shadow),
      shared_ride_penalty_n_shadow: normalizeShadowNumber(source.shared_ride_penalty_n_shadow),
      downstream_value_n_shadow: normalizeShadowNumber(source.downstream_value_n_shadow),
      zone_area_sq_miles_shadow: normalizeShadowNumber(source.zone_area_sq_miles_shadow),
      pickups_per_sq_mile_now_shadow: normalizeShadowNumber(source.pickups_per_sq_mile_now_shadow),
      pickups_per_sq_mile_next_shadow: normalizeShadowNumber(source.pickups_per_sq_mile_next_shadow),
      long_trip_share_20plus_shadow: normalizeShadowNumber(source.long_trip_share_20plus_shadow),
      same_zone_dropoff_share_shadow: normalizeShadowNumber(source.same_zone_dropoff_share_shadow),
      demand_density_now_n_shadow: normalizeShadowNumber(source.demand_density_now_n_shadow),
      demand_density_next_n_shadow: normalizeShadowNumber(source.demand_density_next_n_shadow),
      long_trip_share_20plus_n_shadow: normalizeShadowNumber(source.long_trip_share_20plus_n_shadow),
      same_zone_retention_penalty_n_shadow: normalizeShadowNumber(source.same_zone_retention_penalty_n_shadow),
      balanced_trip_share_shadow: normalizeShadowNumber(source.balanced_trip_share_shadow),
      balanced_trip_quality_n_shadow: normalizeShadowNumber(source.balanced_trip_quality_n_shadow),
      busy_now_base_n_shadow: normalizeShadowNumber(source.busy_now_base_n_shadow),
      busy_next_base_n_shadow: normalizeShadowNumber(source.busy_next_base_n_shadow),
      churn_pressure_n_shadow: normalizeShadowNumber(source.churn_pressure_n_shadow),
      manhattan_core_saturation_proxy_n_shadow: normalizeShadowNumber(source.manhattan_core_saturation_proxy_n_shadow),
      earnings_shadow_citywide_anchor_norm_v3: normalizeShadowNumber(source.earnings_shadow_citywide_anchor_norm_v3),
      airport_excluded: !!source.airport_excluded,
      earnings_shadow_score_citywide_v2: normalizeShadowNumber(source.earnings_shadow_score_citywide_v2),
      earnings_shadow_confidence_citywide_v2: normalizeShadowNumber(source.earnings_shadow_confidence_citywide_v2),
      earnings_shadow_rating_citywide_v2: normalizeShadowNumber(source.earnings_shadow_rating_citywide_v2),
      earnings_shadow_bucket_citywide_v2: normalizeShadowText(source.earnings_shadow_bucket_citywide_v2),
      earnings_shadow_color_citywide_v2: normalizeShadowText(source.earnings_shadow_color_citywide_v2),
      earnings_shadow_positive_citywide_v3: normalizeShadowNumber(source.earnings_shadow_positive_citywide_v3),
      earnings_shadow_negative_citywide_v3: normalizeShadowNumber(source.earnings_shadow_negative_citywide_v3),
      earnings_shadow_score_citywide_v3: normalizeShadowNumber(source.earnings_shadow_score_citywide_v3),
      earnings_shadow_confidence_citywide_v3: normalizeShadowNumber(source.earnings_shadow_confidence_citywide_v3),
      earnings_shadow_rating_citywide_v3: normalizeShadowNumber(source.earnings_shadow_rating_citywide_v3),
      earnings_shadow_bucket_citywide_v3: normalizeShadowText(source.earnings_shadow_bucket_citywide_v3),
      earnings_shadow_color_citywide_v3: normalizeShadowText(source.earnings_shadow_color_citywide_v3),
    };
  }

  function readManhattanShadowFields(props) {
    const source = props || {};
    return {
      earnings_shadow_score_manhattan_v2: normalizeShadowNumber(source.earnings_shadow_score_manhattan_v2),
      earnings_shadow_confidence_manhattan_v2: normalizeShadowNumber(source.earnings_shadow_confidence_manhattan_v2),
      earnings_shadow_rating_manhattan_v2: normalizeShadowNumber(source.earnings_shadow_rating_manhattan_v2),
      earnings_shadow_bucket_manhattan_v2: normalizeShadowText(source.earnings_shadow_bucket_manhattan_v2),
      earnings_shadow_color_manhattan_v2: normalizeShadowText(source.earnings_shadow_color_manhattan_v2),
    };
  }

  function readBronxWashHeightsShadowFields(props) {
    return {
      earnings_shadow_score_bronx_wash_heights_v2: normalizeShadowNumber(props?.earnings_shadow_score_bronx_wash_heights_v2),
      earnings_shadow_confidence_bronx_wash_heights_v2: normalizeShadowNumber(props?.earnings_shadow_confidence_bronx_wash_heights_v2),
      earnings_shadow_rating_bronx_wash_heights_v2: normalizeShadowNumber(props?.earnings_shadow_rating_bronx_wash_heights_v2),
      earnings_shadow_bucket_bronx_wash_heights_v2: normalizeShadowText(props?.earnings_shadow_bucket_bronx_wash_heights_v2),
      earnings_shadow_color_bronx_wash_heights_v2: normalizeShadowText(props?.earnings_shadow_color_bronx_wash_heights_v2),
    };
  }

  function readQueensShadowFields(props) {
    return {
      earnings_shadow_score_queens_v2: normalizeShadowNumber(props?.earnings_shadow_score_queens_v2),
      earnings_shadow_confidence_queens_v2: normalizeShadowNumber(props?.earnings_shadow_confidence_queens_v2),
      earnings_shadow_rating_queens_v2: normalizeShadowNumber(props?.earnings_shadow_rating_queens_v2),
      earnings_shadow_bucket_queens_v2: normalizeShadowText(props?.earnings_shadow_bucket_queens_v2),
      earnings_shadow_color_queens_v2: normalizeShadowText(props?.earnings_shadow_color_queens_v2),
    };
  }

  function readBrooklynShadowFields(props) {
    return {
      earnings_shadow_score_brooklyn_v2: normalizeShadowNumber(props?.earnings_shadow_score_brooklyn_v2),
      earnings_shadow_confidence_brooklyn_v2: normalizeShadowNumber(props?.earnings_shadow_confidence_brooklyn_v2),
      earnings_shadow_rating_brooklyn_v2: normalizeShadowNumber(props?.earnings_shadow_rating_brooklyn_v2),
      earnings_shadow_bucket_brooklyn_v2: normalizeShadowText(props?.earnings_shadow_bucket_brooklyn_v2),
      earnings_shadow_color_brooklyn_v2: normalizeShadowText(props?.earnings_shadow_color_brooklyn_v2),
    };
  }

  function readStatenIslandShadowFields(props) {
    return {
      earnings_shadow_score_staten_island_v2: normalizeShadowNumber(props?.earnings_shadow_score_staten_island_v2),
      earnings_shadow_confidence_staten_island_v2: normalizeShadowNumber(props?.earnings_shadow_confidence_staten_island_v2),
      earnings_shadow_rating_staten_island_v2: normalizeShadowNumber(props?.earnings_shadow_rating_staten_island_v2),
      earnings_shadow_bucket_staten_island_v2: normalizeShadowText(props?.earnings_shadow_bucket_staten_island_v2),
      earnings_shadow_color_staten_island_v2: normalizeShadowText(props?.earnings_shadow_color_staten_island_v2),
    };
  }

  function readManhattanV3ShadowFields(props) {
    return {
      earnings_shadow_score_manhattan_v3: normalizeShadowNumber(props?.earnings_shadow_score_manhattan_v3),
      earnings_shadow_confidence_manhattan_v3: normalizeShadowNumber(props?.earnings_shadow_confidence_manhattan_v3),
      earnings_shadow_rating_manhattan_v3: normalizeShadowNumber(props?.earnings_shadow_rating_manhattan_v3),
      earnings_shadow_bucket_manhattan_v3: normalizeShadowText(props?.earnings_shadow_bucket_manhattan_v3),
      earnings_shadow_color_manhattan_v3: normalizeShadowText(props?.earnings_shadow_color_manhattan_v3),
    };
  }

  function readBronxWashHeightsV3ShadowFields(props) {
    return {
      earnings_shadow_score_bronx_wash_heights_v3: normalizeShadowNumber(props?.earnings_shadow_score_bronx_wash_heights_v3),
      earnings_shadow_confidence_bronx_wash_heights_v3: normalizeShadowNumber(props?.earnings_shadow_confidence_bronx_wash_heights_v3),
      earnings_shadow_rating_bronx_wash_heights_v3: normalizeShadowNumber(props?.earnings_shadow_rating_bronx_wash_heights_v3),
      earnings_shadow_bucket_bronx_wash_heights_v3: normalizeShadowText(props?.earnings_shadow_bucket_bronx_wash_heights_v3),
      earnings_shadow_color_bronx_wash_heights_v3: normalizeShadowText(props?.earnings_shadow_color_bronx_wash_heights_v3),
    };
  }

  function readQueensV3ShadowFields(props) {
    return {
      earnings_shadow_score_queens_v3: normalizeShadowNumber(props?.earnings_shadow_score_queens_v3),
      earnings_shadow_confidence_queens_v3: normalizeShadowNumber(props?.earnings_shadow_confidence_queens_v3),
      earnings_shadow_rating_queens_v3: normalizeShadowNumber(props?.earnings_shadow_rating_queens_v3),
      earnings_shadow_bucket_queens_v3: normalizeShadowText(props?.earnings_shadow_bucket_queens_v3),
      earnings_shadow_color_queens_v3: normalizeShadowText(props?.earnings_shadow_color_queens_v3),
    };
  }

  function readBrooklynV3ShadowFields(props) {
    return {
      earnings_shadow_score_brooklyn_v3: normalizeShadowNumber(props?.earnings_shadow_score_brooklyn_v3),
      earnings_shadow_confidence_brooklyn_v3: normalizeShadowNumber(props?.earnings_shadow_confidence_brooklyn_v3),
      earnings_shadow_rating_brooklyn_v3: normalizeShadowNumber(props?.earnings_shadow_rating_brooklyn_v3),
      earnings_shadow_bucket_brooklyn_v3: normalizeShadowText(props?.earnings_shadow_bucket_brooklyn_v3),
      earnings_shadow_color_brooklyn_v3: normalizeShadowText(props?.earnings_shadow_color_brooklyn_v3),
    };
  }

  function readStatenIslandV3ShadowFields(props) {
    return {
      earnings_shadow_score_staten_island_v3: normalizeShadowNumber(props?.earnings_shadow_score_staten_island_v3),
      earnings_shadow_confidence_staten_island_v3: normalizeShadowNumber(props?.earnings_shadow_confidence_staten_island_v3),
      earnings_shadow_rating_staten_island_v3: normalizeShadowNumber(props?.earnings_shadow_rating_staten_island_v3),
      earnings_shadow_bucket_staten_island_v3: normalizeShadowText(props?.earnings_shadow_bucket_staten_island_v3),
      earnings_shadow_color_staten_island_v3: normalizeShadowText(props?.earnings_shadow_color_staten_island_v3),
    };
  }


  function getAllZoneShadowSnapshots(props) {
    return {
      citywide: readCitywideShadowFields(props),
      manhattan: typeof readManhattanShadowFields === "function" ? readManhattanShadowFields(props) : null,
      bronx_wash_heights: typeof readBronxWashHeightsShadowFields === "function" ? readBronxWashHeightsShadowFields(props) : null,
      queens: typeof readQueensShadowFields === "function" ? readQueensShadowFields(props) : null,
      brooklyn: typeof readBrooklynShadowFields === "function" ? readBrooklynShadowFields(props) : null,
      staten_island: typeof readStatenIslandShadowFields === "function" ? readStatenIslandShadowFields(props) : null,
      manhattan_v3: typeof readManhattanV3ShadowFields === "function" ? readManhattanV3ShadowFields(props) : null,
      bronx_wash_heights_v3: typeof readBronxWashHeightsV3ShadowFields === "function" ? readBronxWashHeightsV3ShadowFields(props) : null,
      queens_v3: typeof readQueensV3ShadowFields === "function" ? readQueensV3ShadowFields(props) : null,
      brooklyn_v3: typeof readBrooklynV3ShadowFields === "function" ? readBrooklynV3ShadowFields(props) : null,
      staten_island_v3: typeof readStatenIslandV3ShadowFields === "function" ? readStatenIslandV3ShadowFields(props) : null,
    };
  }

  function getLegacyZoneScoreSnapshot(props, geom) {
    return {
      rating: normalizeShadowNumber(props?.rating),
      bucket: normalizeShadowText(props?.bucket),
      color: normalizeShadowText(props?.style?.fillColor || props?.style?.color || ""),
      activeModeTag: String(window.TlcModeModule?.getActiveSpecialModeTagForFeature?.(props, geom) || "")
    };
  }

  function getZoneShadowComparison(props, geom) {
    const legacy = getLegacyZoneScoreSnapshot(props, geom);
    const shadow = readCitywideShadowFields(props);
    const manhattan_shadow = readManhattanShadowFields(props);
    const bronx_wash_heights_shadow = readBronxWashHeightsShadowFields(props);
    const queens_shadow = readQueensShadowFields(props);
    const brooklyn_shadow = readBrooklynShadowFields(props);
    const staten_island_shadow = readStatenIslandShadowFields(props);
    const manhattan_v3_shadow = readManhattanV3ShadowFields(props);
    const bronx_wash_heights_v3_shadow = readBronxWashHeightsV3ShadowFields(props);
    const queens_v3_shadow = readQueensV3ShadowFields(props);
    const brooklyn_v3_shadow = readBrooklynV3ShadowFields(props);
    const staten_island_v3_shadow = readStatenIslandV3ShadowFields(props);

    const legacyRating = Number(legacy.rating);
    const shadowRating = Number(shadow.earnings_shadow_rating_citywide_v2);
    const citywideV3ShadowRating = Number(shadow.earnings_shadow_rating_citywide_v3);

    return {
      legacy,
      shadow,
      citywide_v3_shadow: {
        earnings_shadow_positive_citywide_v3: shadow.earnings_shadow_positive_citywide_v3,
        earnings_shadow_negative_citywide_v3: shadow.earnings_shadow_negative_citywide_v3,
        earnings_shadow_score_citywide_v3: shadow.earnings_shadow_score_citywide_v3,
        earnings_shadow_confidence_citywide_v3: shadow.earnings_shadow_confidence_citywide_v3,
        earnings_shadow_rating_citywide_v3: shadow.earnings_shadow_rating_citywide_v3,
        earnings_shadow_bucket_citywide_v3: shadow.earnings_shadow_bucket_citywide_v3,
        earnings_shadow_color_citywide_v3: shadow.earnings_shadow_color_citywide_v3,
      },
      manhattan_shadow,
      bronx_wash_heights_shadow,
      queens_shadow,
      brooklyn_shadow,
      staten_island_shadow,
      manhattan_v3_shadow,
      bronx_wash_heights_v3_shadow,
      queens_v3_shadow,
      brooklyn_v3_shadow,
      staten_island_v3_shadow,
      delta_rating:
        Number.isFinite(legacyRating) && Number.isFinite(shadowRating)
          ? shadowRating - legacyRating
          : null,
      shadow_ready:
        Number.isFinite(Number(shadow.earnings_shadow_rating_citywide_v2)),
      citywide_v3_shadow_ready:
        Number.isFinite(Number(shadow.earnings_shadow_rating_citywide_v3)),
      delta_citywide_v3_vs_legacy:
        Number.isFinite(legacyRating) && Number.isFinite(citywideV3ShadowRating)
          ? citywideV3ShadowRating - legacyRating
          : null,
      delta_citywide_v3_vs_citywide_v2:
        Number.isFinite(shadowRating) && Number.isFinite(citywideV3ShadowRating)
          ? citywideV3ShadowRating - shadowRating
          : null,
      manhattan_shadow_ready:
        Number.isFinite(Number(manhattan_shadow.earnings_shadow_rating_manhattan_v2)),
      bronx_wash_heights_shadow_ready:
        Number.isFinite(Number(bronx_wash_heights_shadow.earnings_shadow_rating_bronx_wash_heights_v2)),
      queens_shadow_ready:
        Number.isFinite(Number(queens_shadow.earnings_shadow_rating_queens_v2)),
      brooklyn_shadow_ready:
        Number.isFinite(Number(brooklyn_shadow.earnings_shadow_rating_brooklyn_v2)),
      staten_island_shadow_ready:
        Number.isFinite(Number(staten_island_shadow.earnings_shadow_rating_staten_island_v2)),
      manhattan_v3_shadow_ready:
        Number.isFinite(Number(manhattan_v3_shadow.earnings_shadow_rating_manhattan_v3)),
      bronx_wash_heights_v3_shadow_ready:
        Number.isFinite(Number(bronx_wash_heights_v3_shadow.earnings_shadow_rating_bronx_wash_heights_v3)),
      queens_v3_shadow_ready:
        Number.isFinite(Number(queens_v3_shadow.earnings_shadow_rating_queens_v3)),
      brooklyn_v3_shadow_ready:
        Number.isFinite(Number(brooklyn_v3_shadow.earnings_shadow_rating_brooklyn_v3)),
      staten_island_v3_shadow_ready:
        Number.isFinite(Number(staten_island_v3_shadow.earnings_shadow_rating_staten_island_v3)),
      delta_manhattan_v3_vs_v2:
        Number.isFinite(Number(manhattan_v3_shadow.earnings_shadow_rating_manhattan_v3)) &&
        Number.isFinite(Number(manhattan_shadow.earnings_shadow_rating_manhattan_v2))
          ? Number(manhattan_v3_shadow.earnings_shadow_rating_manhattan_v3) - Number(manhattan_shadow.earnings_shadow_rating_manhattan_v2)
          : null,
      delta_bronx_wash_heights_v3_vs_v2:
        Number.isFinite(Number(bronx_wash_heights_v3_shadow.earnings_shadow_rating_bronx_wash_heights_v3)) &&
        Number.isFinite(Number(bronx_wash_heights_shadow.earnings_shadow_rating_bronx_wash_heights_v2))
          ? Number(bronx_wash_heights_v3_shadow.earnings_shadow_rating_bronx_wash_heights_v3) - Number(bronx_wash_heights_shadow.earnings_shadow_rating_bronx_wash_heights_v2)
          : null,
      delta_queens_v3_vs_v2:
        Number.isFinite(Number(queens_v3_shadow.earnings_shadow_rating_queens_v3)) &&
        Number.isFinite(Number(queens_shadow.earnings_shadow_rating_queens_v2))
          ? Number(queens_v3_shadow.earnings_shadow_rating_queens_v3) - Number(queens_shadow.earnings_shadow_rating_queens_v2)
          : null,
      delta_brooklyn_v3_vs_v2:
        Number.isFinite(Number(brooklyn_v3_shadow.earnings_shadow_rating_brooklyn_v3)) &&
        Number.isFinite(Number(brooklyn_shadow.earnings_shadow_rating_brooklyn_v2))
          ? Number(brooklyn_v3_shadow.earnings_shadow_rating_brooklyn_v3) - Number(brooklyn_shadow.earnings_shadow_rating_brooklyn_v2)
          : null,
      delta_staten_island_v3_vs_v2:
        Number.isFinite(Number(staten_island_v3_shadow.earnings_shadow_rating_staten_island_v3)) &&
        Number.isFinite(Number(staten_island_shadow.earnings_shadow_rating_staten_island_v2))
          ? Number(staten_island_v3_shadow.earnings_shadow_rating_staten_island_v3) - Number(staten_island_shadow.earnings_shadow_rating_staten_island_v2)
          : null,
    };
  }

  function getCurrentFrameZoneFeatureById(locationId) {
    const frame = core.getCurrentFrame?.();
    const features = frame?.polygons?.features || [];
    const target = String(locationId || "").trim();
    if (!target) return null;
    return features.find((feature) => String(feature?.properties?.LocationID ?? "") === target) || null;
  }

  function getZoneShadowComparisonByLocationId(locationId) {
    const feature = getCurrentFrameZoneFeatureById(locationId);
    if (!feature) return null;
    return getZoneShadowComparison(feature.properties || {}, feature.geometry || null);
  }

  function getVisibleShadowProfileKeyForFeature(props, geom) {
    const source = String(window.TlcModeModule?.getVisibleScoreSourceForFeature?.(props, geom) || "");

    switch (source) {
      case "citywide_v3_shadow":
        return "citywide_v3";
      case "citywide_shadow":
        return "citywide_v2";
      case "manhattan_v3_shadow":
        return "manhattan_v3";
      case "manhattan_shadow":
        return "manhattan_v2";
      case "bronx_wash_heights_v3_shadow":
        return "bronx_wash_heights_v3";
      case "bronx_wash_heights_shadow":
        return "bronx_wash_heights_v2";
      case "queens_v3_shadow":
        return "queens_v3";
      case "queens_shadow":
        return "queens_v2";
      case "brooklyn_v3_shadow":
        return "brooklyn_v3";
      case "brooklyn_shadow":
        return "brooklyn_v2";
      case "staten_island_v3_shadow":
        return "staten_island_v3";
      case "staten_island_shadow":
        return "staten_island_v2";
      default:
        return null;
    }
  }

  function isVisibleScoreUsingFallback(props, geom) {
    const source = String(window.TlcModeModule?.getVisibleScoreSourceForFeature?.(props, geom) || "");
    return (
      source === "legacy_citywide" ||
      source === "manhattan_mode_legacy" ||
      source === "bronx_wash_heights_mode_legacy" ||
      source === "queens_mode_legacy" ||
      source === "brooklyn_mode_legacy" ||
      source === "staten_island_mode_legacy"
    );
  }

  function getVisibleShadowReadiness(props, geom) {
    const profileKey = getVisibleShadowProfileKeyForFeature(props, geom);
    const all = getAllZoneShadowSnapshots(props) || {};

    let profileSnapshot = null;
    if (profileKey === "citywide_v3") profileSnapshot = all.citywide;
    if (profileKey === "citywide_v2") profileSnapshot = all.citywide;
    if (profileKey === "manhattan_v3") profileSnapshot = all.manhattan_v3;
    if (profileKey === "manhattan_v2") profileSnapshot = all.manhattan;
    if (profileKey === "bronx_wash_heights_v3") profileSnapshot = all.bronx_wash_heights_v3;
    if (profileKey === "bronx_wash_heights_v2") profileSnapshot = all.bronx_wash_heights;
    if (profileKey === "queens_v3") profileSnapshot = all.queens_v3;
    if (profileKey === "queens_v2") profileSnapshot = all.queens;
    if (profileKey === "brooklyn_v3") profileSnapshot = all.brooklyn_v3;
    if (profileKey === "brooklyn_v2") profileSnapshot = all.brooklyn;
    if (profileKey === "staten_island_v3") profileSnapshot = all.staten_island_v3;
    if (profileKey === "staten_island_v2") profileSnapshot = all.staten_island;

    let shadowReady = false;
    if (profileKey === "citywide_v3") {
      shadowReady = Number.isFinite(Number(profileSnapshot?.earnings_shadow_rating_citywide_v3));
    }
    if (profileKey === "citywide_v2") {
      shadowReady = Number.isFinite(Number(profileSnapshot?.earnings_shadow_rating_citywide_v2));
    }
    if (profileKey === "manhattan_v3") {
      shadowReady = Number.isFinite(Number(profileSnapshot?.earnings_shadow_rating_manhattan_v3));
    }
    if (profileKey === "manhattan_v2") {
      shadowReady = Number.isFinite(Number(profileSnapshot?.earnings_shadow_rating_manhattan_v2));
    }
    if (profileKey === "bronx_wash_heights_v3") {
      shadowReady = Number.isFinite(Number(profileSnapshot?.earnings_shadow_rating_bronx_wash_heights_v3));
    }
    if (profileKey === "bronx_wash_heights_v2") {
      shadowReady = Number.isFinite(Number(profileSnapshot?.earnings_shadow_rating_bronx_wash_heights_v2));
    }
    if (profileKey === "queens_v3") {
      shadowReady = Number.isFinite(Number(profileSnapshot?.earnings_shadow_rating_queens_v3));
    }
    if (profileKey === "queens_v2") {
      shadowReady = Number.isFinite(Number(profileSnapshot?.earnings_shadow_rating_queens_v2));
    }
    if (profileKey === "brooklyn_v3") {
      shadowReady = Number.isFinite(Number(profileSnapshot?.earnings_shadow_rating_brooklyn_v3));
    }
    if (profileKey === "brooklyn_v2") {
      shadowReady = Number.isFinite(Number(profileSnapshot?.earnings_shadow_rating_brooklyn_v2));
    }
    if (profileKey === "staten_island_v3") {
      shadowReady = Number.isFinite(Number(profileSnapshot?.earnings_shadow_rating_staten_island_v3));
    }
    if (profileKey === "staten_island_v2") {
      shadowReady = Number.isFinite(Number(profileSnapshot?.earnings_shadow_rating_staten_island_v2));
    }

    return {
      visibleSource: String(window.TlcModeModule?.getVisibleScoreSourceForFeature?.(props, geom) || ""),
      visibleSourceLabel: String(window.TlcModeModule?.getVisibleScoreSourceLabel?.(props, geom) || ""),
      technicalSourceLabel: String(window.TlcModeModule?.getVisibleScoreTechnicalSourceLabel?.(props, geom) || ""),
      profileKey,
      shadowReady: !!shadowReady,
      usingFallback: isVisibleScoreUsingFallback(props, geom),
    };
  }

  window.getZoneShadowDebugByLocationId = function getZoneShadowDebugByLocationId(locationId) {
    return getZoneShadowComparisonByLocationId(locationId);
  };

  function buildZoneShadowSummary(props, geom) {
    const comparison = getZoneShadowComparison(props, geom);
    const readiness = getVisibleShadowReadiness(props, geom);
    const anyReady = !!(
      comparison?.shadow_ready ||
      comparison?.manhattan_v3_shadow_ready ||
      comparison?.manhattan_shadow_ready ||
      comparison?.bronx_wash_heights_shadow_ready ||
      comparison?.queens_v3_shadow_ready ||
      comparison?.queens_shadow_ready ||
      comparison?.brooklyn_v3_shadow_ready ||
      comparison?.brooklyn_shadow_ready ||
      comparison?.staten_island_v3_shadow_ready ||
      comparison?.staten_island_shadow_ready
    );

    if (!anyReady) return null;

    const shadow = comparison.shadow;
    return {
      legacy_rating: comparison.legacy.rating,
      legacy_bucket: comparison.legacy.bucket,
      shadow_rating: shadow.earnings_shadow_rating_citywide_v2,
      shadow_bucket: shadow.earnings_shadow_bucket_citywide_v2,
      shadow_confidence: shadow.earnings_shadow_confidence_citywide_v2,
      citywide_v3_rating: shadow.earnings_shadow_rating_citywide_v3,
      citywide_v3_bucket: shadow.earnings_shadow_bucket_citywide_v3,
      citywide_v3_confidence: shadow.earnings_shadow_confidence_citywide_v3,
      citywide_v3_positive: shadow.earnings_shadow_positive_citywide_v3,
      citywide_v3_negative: shadow.earnings_shadow_negative_citywide_v3,
      bronx_wash_heights_shadow_rating: comparison.bronx_wash_heights_shadow?.earnings_shadow_rating_bronx_wash_heights_v2 ?? null,
      bronx_wash_heights_shadow_bucket: comparison.bronx_wash_heights_shadow?.earnings_shadow_bucket_bronx_wash_heights_v2 || "",
      bronx_wash_heights_shadow_confidence: comparison.bronx_wash_heights_shadow?.earnings_shadow_confidence_bronx_wash_heights_v2 ?? null,
      queens_shadow_rating: comparison.queens_shadow?.earnings_shadow_rating_queens_v2 ?? null,
      queens_shadow_bucket: comparison.queens_shadow?.earnings_shadow_bucket_queens_v2 || "",
      queens_shadow_confidence: comparison.queens_shadow?.earnings_shadow_confidence_queens_v2 ?? null,
      brooklyn_shadow_rating: comparison.brooklyn_shadow?.earnings_shadow_rating_brooklyn_v2 ?? null,
      brooklyn_shadow_bucket: comparison.brooklyn_shadow?.earnings_shadow_bucket_brooklyn_v2 || "",
      brooklyn_shadow_confidence: comparison.brooklyn_shadow?.earnings_shadow_confidence_brooklyn_v2 ?? null,
      staten_island_shadow_rating: comparison.staten_island_shadow?.earnings_shadow_rating_staten_island_v2 ?? null,
      staten_island_shadow_bucket: comparison.staten_island_shadow?.earnings_shadow_bucket_staten_island_v2 || "",
      staten_island_shadow_confidence: comparison.staten_island_shadow?.earnings_shadow_confidence_staten_island_v2 ?? null,
      manhattan_v3_rating: comparison.manhattan_v3_shadow?.earnings_shadow_rating_manhattan_v3 ?? null,
      manhattan_v3_bucket: comparison.manhattan_v3_shadow?.earnings_shadow_bucket_manhattan_v3 || "",
      manhattan_v3_confidence: comparison.manhattan_v3_shadow?.earnings_shadow_confidence_manhattan_v3 ?? null,
      delta_manhattan_v3_vs_v2: comparison.delta_manhattan_v3_vs_v2,
      bronx_wash_heights_v3_rating: comparison.bronx_wash_heights_v3_shadow?.earnings_shadow_rating_bronx_wash_heights_v3 ?? null,
      bronx_wash_heights_v3_bucket: comparison.bronx_wash_heights_v3_shadow?.earnings_shadow_bucket_bronx_wash_heights_v3 || "",
      bronx_wash_heights_v3_confidence: comparison.bronx_wash_heights_v3_shadow?.earnings_shadow_confidence_bronx_wash_heights_v3 ?? null,
      delta_bronx_wash_heights_v3_vs_v2: comparison.delta_bronx_wash_heights_v3_vs_v2,
      queens_v3_rating: comparison.queens_v3_shadow?.earnings_shadow_rating_queens_v3 ?? null,
      queens_v3_bucket: comparison.queens_v3_shadow?.earnings_shadow_bucket_queens_v3 || "",
      queens_v3_confidence: comparison.queens_v3_shadow?.earnings_shadow_confidence_queens_v3 ?? null,
      delta_queens_v3_vs_v2: comparison.delta_queens_v3_vs_v2,
      brooklyn_v3_rating: comparison.brooklyn_v3_shadow?.earnings_shadow_rating_brooklyn_v3 ?? null,
      brooklyn_v3_bucket: comparison.brooklyn_v3_shadow?.earnings_shadow_bucket_brooklyn_v3 || "",
      brooklyn_v3_confidence: comparison.brooklyn_v3_shadow?.earnings_shadow_confidence_brooklyn_v3 ?? null,
      delta_brooklyn_v3_vs_v2: comparison.delta_brooklyn_v3_vs_v2,
      staten_island_v3_rating: comparison.staten_island_v3_shadow?.earnings_shadow_rating_staten_island_v3 ?? null,
      staten_island_v3_bucket: comparison.staten_island_v3_shadow?.earnings_shadow_bucket_staten_island_v3 || "",
      staten_island_v3_confidence: comparison.staten_island_v3_shadow?.earnings_shadow_confidence_staten_island_v3 ?? null,
      delta_staten_island_v3_vs_v2: comparison.delta_staten_island_v3_vs_v2,
      delta_rating: comparison.delta_rating,
      delta_citywide_v3_vs_legacy: comparison.delta_citywide_v3_vs_legacy,
      delta_citywide_v3_vs_citywide_v2: comparison.delta_citywide_v3_vs_citywide_v2,
      median_driver_pay: shadow.median_driver_pay_shadow,
      median_pay_per_min: shadow.median_pay_per_min_shadow,
      median_pay_per_mile: shadow.median_pay_per_mile_shadow,
      request_to_pickup_min: shadow.median_request_to_pickup_min_shadow,
      short_trip_share: shadow.short_trip_share_shadow,
      shared_ride_share: shadow.shared_ride_share_shadow,
      downstream_value: shadow.downstream_value_shadow,
      zone_area_sq_miles: shadow.zone_area_sq_miles_shadow,
      pickups_per_sq_mile_now: shadow.pickups_per_sq_mile_now_shadow,
      pickups_per_sq_mile_next: shadow.pickups_per_sq_mile_next_shadow,
      long_trip_share_20plus: shadow.long_trip_share_20plus_shadow,
      same_zone_dropoff_share: shadow.same_zone_dropoff_share_shadow,
      demand_density_now_n: shadow.demand_density_now_n_shadow,
      demand_density_next_n: shadow.demand_density_next_n_shadow,
      long_trip_share_20plus_n: shadow.long_trip_share_20plus_n_shadow,
      same_zone_retention_penalty_n: shadow.same_zone_retention_penalty_n_shadow,
      balanced_trip_share: shadow.balanced_trip_share_shadow,
      balanced_trip_quality_n: shadow.balanced_trip_quality_n_shadow,
      busy_now_base_n: shadow.busy_now_base_n_shadow,
      busy_next_base_n: shadow.busy_next_base_n_shadow,
      churn_pressure_n: shadow.churn_pressure_n_shadow,
      manhattan_core_saturation_proxy_n: shadow.manhattan_core_saturation_proxy_n_shadow,
      citywide_anchor_norm_v3: shadow.earnings_shadow_citywide_anchor_norm_v3,
      airport_excluded: !!shadow.airport_excluded,
    };
  }

  window.TlcScoreShadowModule = {
    readCitywideShadowFields,
    readManhattanShadowFields,
    readBronxWashHeightsShadowFields,
    readQueensShadowFields,
    readBrooklynShadowFields,
    readStatenIslandShadowFields,
    readManhattanV3ShadowFields,
    readBronxWashHeightsV3ShadowFields,
    readQueensV3ShadowFields,
    readBrooklynV3ShadowFields,
    readStatenIslandV3ShadowFields,
    getAllZoneShadowSnapshots,
    getZoneShadowComparison,
    getZoneShadowComparisonByLocationId,
    buildZoneShadowSummary,
    getVisibleShadowProfileKeyForFeature,
    isVisibleScoreUsingFallback,
    getVisibleShadowReadiness,
  };
})();
