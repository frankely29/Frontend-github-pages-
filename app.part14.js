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
      earnings_shadow_score_citywide_v2: normalizeShadowNumber(source.earnings_shadow_score_citywide_v2),
      earnings_shadow_confidence_citywide_v2: normalizeShadowNumber(source.earnings_shadow_confidence_citywide_v2),
      earnings_shadow_rating_citywide_v2: normalizeShadowNumber(source.earnings_shadow_rating_citywide_v2),
      earnings_shadow_bucket_citywide_v2: normalizeShadowText(source.earnings_shadow_bucket_citywide_v2),
      earnings_shadow_color_citywide_v2: normalizeShadowText(source.earnings_shadow_color_citywide_v2),
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


  function getAllZoneShadowSnapshots(props) {
    return {
      citywide: readCitywideShadowFields(props),
      manhattan: typeof readManhattanShadowFields === "function" ? readManhattanShadowFields(props) : null,
      bronx_wash_heights: typeof readBronxWashHeightsShadowFields === "function" ? readBronxWashHeightsShadowFields(props) : null,
      queens: typeof readQueensShadowFields === "function" ? readQueensShadowFields(props) : null,
      brooklyn: typeof readBrooklynShadowFields === "function" ? readBrooklynShadowFields(props) : null,
      staten_island: typeof readStatenIslandShadowFields === "function" ? readStatenIslandShadowFields(props) : null,
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

    const legacyRating = Number(legacy.rating);
    const shadowRating = Number(shadow.earnings_shadow_rating_citywide_v2);

    return {
      legacy,
      shadow,
      manhattan_shadow,
      bronx_wash_heights_shadow,
      queens_shadow,
      brooklyn_shadow,
      staten_island_shadow,
      delta_rating:
        Number.isFinite(legacyRating) && Number.isFinite(shadowRating)
          ? shadowRating - legacyRating
          : null,
      shadow_ready:
        Number.isFinite(Number(shadow.earnings_shadow_rating_citywide_v2)),
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
      case "citywide_shadow":
        return "citywide_v2";
      case "manhattan_shadow":
        return "manhattan_v2";
      case "bronx_wash_heights_shadow":
        return "bronx_wash_heights_v2";
      case "queens_shadow":
        return "queens_v2";
      case "brooklyn_shadow":
        return "brooklyn_v2";
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
    if (profileKey === "citywide_v2") profileSnapshot = all.citywide;
    if (profileKey === "manhattan_v2") profileSnapshot = all.manhattan;
    if (profileKey === "bronx_wash_heights_v2") profileSnapshot = all.bronx_wash_heights;
    if (profileKey === "queens_v2") profileSnapshot = all.queens;
    if (profileKey === "brooklyn_v2") profileSnapshot = all.brooklyn;
    if (profileKey === "staten_island_v2") profileSnapshot = all.staten_island;

    let shadowReady = false;
    if (profileKey === "citywide_v2") {
      shadowReady = Number.isFinite(Number(profileSnapshot?.earnings_shadow_rating_citywide_v2));
    }
    if (profileKey === "manhattan_v2") {
      shadowReady = Number.isFinite(Number(profileSnapshot?.earnings_shadow_rating_manhattan_v2));
    }
    if (profileKey === "bronx_wash_heights_v2") {
      shadowReady = Number.isFinite(Number(profileSnapshot?.earnings_shadow_rating_bronx_wash_heights_v2));
    }
    if (profileKey === "queens_v2") {
      shadowReady = Number.isFinite(Number(profileSnapshot?.earnings_shadow_rating_queens_v2));
    }
    if (profileKey === "brooklyn_v2") {
      shadowReady = Number.isFinite(Number(profileSnapshot?.earnings_shadow_rating_brooklyn_v2));
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
    if (!comparison?.shadow_ready) return null;

    const shadow = comparison.shadow;
    return {
      legacy_rating: comparison.legacy.rating,
      legacy_bucket: comparison.legacy.bucket,
      shadow_rating: shadow.earnings_shadow_rating_citywide_v2,
      shadow_bucket: shadow.earnings_shadow_bucket_citywide_v2,
      shadow_confidence: shadow.earnings_shadow_confidence_citywide_v2,
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
      delta_rating: comparison.delta_rating,
      median_driver_pay: shadow.median_driver_pay_shadow,
      median_pay_per_min: shadow.median_pay_per_min_shadow,
      median_pay_per_mile: shadow.median_pay_per_mile_shadow,
      request_to_pickup_min: shadow.median_request_to_pickup_min_shadow,
      short_trip_share: shadow.short_trip_share_shadow,
      shared_ride_share: shadow.shared_ride_share_shadow,
      downstream_value: shadow.downstream_value_shadow,
    };
  }

  window.TlcScoreShadowModule = {
    readCitywideShadowFields,
    readManhattanShadowFields,
    readBronxWashHeightsShadowFields,
    readQueensShadowFields,
    readBrooklynShadowFields,
    readStatenIslandShadowFields,
    getAllZoneShadowSnapshots,
    getZoneShadowComparison,
    getZoneShadowComparisonByLocationId,
    buildZoneShadowSummary,
    getVisibleShadowProfileKeyForFeature,
    isVisibleScoreUsingFallback,
    getVisibleShadowReadiness,
  };
})();
