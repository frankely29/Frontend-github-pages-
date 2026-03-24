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

  function getLegacyZoneScoreSnapshot(props, geom) {
    return {
      rating: Number(window.TlcModeModule?.effectiveRating?.(props, geom) ?? NaN),
      bucket: String(window.TlcModeModule?.effectiveBucket?.(props, geom) || ""),
      color: String(window.TlcModeModule?.effectiveColor?.(props, geom) || ""),
      activeModeTag: String(window.TlcModeModule?.getActiveSpecialModeTagForFeature?.(props, geom) || "")
    };
  }

  function getZoneShadowComparison(props, geom) {
    const legacy = getLegacyZoneScoreSnapshot(props, geom);
    const shadow = readCitywideShadowFields(props);

    const legacyRating = Number(legacy.rating);
    const shadowRating = Number(shadow.earnings_shadow_rating_citywide_v2);

    return {
      legacy,
      shadow,
      delta_rating:
        Number.isFinite(legacyRating) && Number.isFinite(shadowRating)
          ? shadowRating - legacyRating
          : null,
      shadow_ready:
        Number.isFinite(Number(shadow.earnings_shadow_rating_citywide_v2)),
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

  window.getZoneShadowDebugByLocationId = function getZoneShadowDebugByLocationId(locationId) {
    return getZoneShadowComparisonByLocationId(locationId);
  };

  function formatShadowPct(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "n/a";
    return `${Math.round(Math.max(0, Math.min(1, n)) * 100)}%`;
  }

  function formatShadowMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "n/a";
    return `$${n.toFixed(2)}`;
  }

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
      delta_rating: comparison.delta_rating,
      median_driver_pay: shadow.median_driver_pay_shadow,
      median_pay_per_min: shadow.median_pay_per_min_shadow,
      median_pay_per_mile: shadow.median_pay_per_mile_shadow,
      request_to_pickup_min: shadow.median_request_to_pickup_min_shadow,
      short_trip_share: shadow.short_trip_share_shadow,
      shared_ride_share: shadow.shared_ride_share_shadow,
      downstream_value: shadow.downstream_value_shadow,
      median_driver_pay_text: formatShadowMoney(shadow.median_driver_pay_shadow),
      median_pay_per_min_text: formatShadowMoney(shadow.median_pay_per_min_shadow),
      median_pay_per_mile_text: formatShadowMoney(shadow.median_pay_per_mile_shadow),
      short_trip_share_text: formatShadowPct(shadow.short_trip_share_shadow),
      shared_ride_share_text: formatShadowPct(shadow.shared_ride_share_shadow),
      confidence_text: formatShadowPct(shadow.earnings_shadow_confidence_citywide_v2),
    };
  }

  window.TlcScoreShadowModule = {
    readCitywideShadowFields,
    getZoneShadowComparison,
    getZoneShadowComparisonByLocationId,
    buildZoneShadowSummary,
  };
})();
