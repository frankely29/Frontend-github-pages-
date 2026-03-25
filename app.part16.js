(function() {
  const core = window.TlcModeInternals || {};

  function getCurrentFrameZoneFeatureById(locationId) {
    const frame = core.getCurrentFrame?.();
    const features = frame?.polygons?.features || [];
    const target = String(locationId || "").trim();
    if (!target) return null;
    return features.find((feature) => String(feature?.properties?.LocationID ?? "") === target) || null;
  }

  function safeRound(value, digits = 2) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const factor = 10 ** digits;
    return Math.round(n * factor) / factor;
  }

  function getVisibleScoreAudit(props, geom) {
    const modeModule = window.TlcModeModule || {};
    const shadowModule = window.TlcScoreShadowModule || {};
    const crowdingModule = window.TlcCommunityCrowdingModule || {};

    const visibleSource =
      String(modeModule.getVisibleScoreSourceForFeature?.(props, geom) || "legacy_citywide");

    const visibleSourceLabel =
      String(modeModule.getVisibleScoreSourceLabel?.(props, geom) || visibleSource);
    const technicalSourceLabel =
      String(modeModule.getVisibleScoreTechnicalSourceLabel?.(props, geom) || visibleSource);
    const usingFallback = !!modeModule.isVisibleScoreUsingFallback?.(props, geom);
    const shadowReadiness = shadowModule.getVisibleShadowReadiness?.(props, geom) || null;

    const visibleRating = Number(modeModule.effectiveRating?.(props, geom) ?? NaN);
    const visibleBucket = String(modeModule.effectiveBucket?.(props, geom) || "");
    const visibleColor = String(modeModule.effectiveColor?.(props, geom) || "");
    const activeModeTag = String(modeModule.getActiveSpecialModeTagForFeature?.(props, geom) || "");

    const allShadows = shadowModule.getAllZoneShadowSnapshots?.(props) || null;
    const shadowCitywide = allShadows?.citywide || null;
    const citywideV2Rating = Number(shadowCitywide?.earnings_shadow_rating_citywide_v2 ?? NaN);
    const citywideV3Rating = Number(shadowCitywide?.earnings_shadow_rating_citywide_v3 ?? NaN);
    const densityTripQuality = shadowCitywide
      ? {
          zoneAreaSqMiles: safeRound(shadowCitywide.zone_area_sq_miles_shadow, 2),
          pickupsPerSqMileNow: safeRound(shadowCitywide.pickups_per_sq_mile_now_shadow, 1),
          pickupsPerSqMileNext: safeRound(shadowCitywide.pickups_per_sq_mile_next_shadow, 1),
          longTripShare20Plus: safeRound(shadowCitywide.long_trip_share_20plus_shadow, 4),
          sameZoneDropoffShare: safeRound(shadowCitywide.same_zone_dropoff_share_shadow, 4),
          demandDensityNowN: safeRound(shadowCitywide.demand_density_now_n_shadow, 4),
          demandDensityNextN: safeRound(shadowCitywide.demand_density_next_n_shadow, 4),
          longTripShare20PlusN: safeRound(shadowCitywide.long_trip_share_20plus_n_shadow, 4),
          sameZoneRetentionPenaltyN: safeRound(shadowCitywide.same_zone_retention_penalty_n_shadow, 4),
        }
      : null;
    const citywideV3Candidate = shadowCitywide
      ? {
          citywideV3Rating: safeRound(shadowCitywide.earnings_shadow_rating_citywide_v3, 2),
          citywideV3Bucket: String(shadowCitywide.earnings_shadow_bucket_citywide_v3 || ""),
          citywideV3Confidence: safeRound(shadowCitywide.earnings_shadow_confidence_citywide_v3, 3),
          citywideV3Positive: safeRound(shadowCitywide.earnings_shadow_positive_citywide_v3, 3),
          citywideV3Negative: safeRound(shadowCitywide.earnings_shadow_negative_citywide_v3, 3),
          citywideV3DeltaVsLegacy:
            Number.isFinite(citywideV3Rating) && Number.isFinite(Number(props?.rating))
              ? safeRound(citywideV3Rating - Number(props.rating), 2)
              : null,
          citywideV3DeltaVsCitywideV2:
            Number.isFinite(citywideV3Rating) && Number.isFinite(citywideV2Rating)
              ? safeRound(citywideV3Rating - citywideV2Rating, 2)
              : null,
        }
      : null;
    const boroughV3Candidates = allShadows
      ? {
          manhattan: {
            rating: safeRound(allShadows.manhattan_v3?.earnings_shadow_rating_manhattan_v3, 2),
            bucket: String(allShadows.manhattan_v3?.earnings_shadow_bucket_manhattan_v3 || ""),
            confidence: safeRound(allShadows.manhattan_v3?.earnings_shadow_confidence_manhattan_v3, 3),
            deltaVsV2: safeRound(
              Number.isFinite(Number(allShadows.manhattan_v3?.earnings_shadow_rating_manhattan_v3)) &&
              Number.isFinite(Number(allShadows.manhattan?.earnings_shadow_rating_manhattan_v2))
                ? Number(allShadows.manhattan_v3.earnings_shadow_rating_manhattan_v3) - Number(allShadows.manhattan.earnings_shadow_rating_manhattan_v2)
                : null,
              2
            ),
          },
          bronx_wash_heights: {
            rating: safeRound(allShadows.bronx_wash_heights_v3?.earnings_shadow_rating_bronx_wash_heights_v3, 2),
            bucket: String(allShadows.bronx_wash_heights_v3?.earnings_shadow_bucket_bronx_wash_heights_v3 || ""),
            confidence: safeRound(allShadows.bronx_wash_heights_v3?.earnings_shadow_confidence_bronx_wash_heights_v3, 3),
            deltaVsV2: safeRound(
              Number.isFinite(Number(allShadows.bronx_wash_heights_v3?.earnings_shadow_rating_bronx_wash_heights_v3)) &&
              Number.isFinite(Number(allShadows.bronx_wash_heights?.earnings_shadow_rating_bronx_wash_heights_v2))
                ? Number(allShadows.bronx_wash_heights_v3.earnings_shadow_rating_bronx_wash_heights_v3) - Number(allShadows.bronx_wash_heights.earnings_shadow_rating_bronx_wash_heights_v2)
                : null,
              2
            ),
          },
          queens: {
            rating: safeRound(allShadows.queens_v3?.earnings_shadow_rating_queens_v3, 2),
            bucket: String(allShadows.queens_v3?.earnings_shadow_bucket_queens_v3 || ""),
            confidence: safeRound(allShadows.queens_v3?.earnings_shadow_confidence_queens_v3, 3),
            deltaVsV2: safeRound(
              Number.isFinite(Number(allShadows.queens_v3?.earnings_shadow_rating_queens_v3)) &&
              Number.isFinite(Number(allShadows.queens?.earnings_shadow_rating_queens_v2))
                ? Number(allShadows.queens_v3.earnings_shadow_rating_queens_v3) - Number(allShadows.queens.earnings_shadow_rating_queens_v2)
                : null,
              2
            ),
          },
          brooklyn: {
            rating: safeRound(allShadows.brooklyn_v3?.earnings_shadow_rating_brooklyn_v3, 2),
            bucket: String(allShadows.brooklyn_v3?.earnings_shadow_bucket_brooklyn_v3 || ""),
            confidence: safeRound(allShadows.brooklyn_v3?.earnings_shadow_confidence_brooklyn_v3, 3),
            deltaVsV2: safeRound(
              Number.isFinite(Number(allShadows.brooklyn_v3?.earnings_shadow_rating_brooklyn_v3)) &&
              Number.isFinite(Number(allShadows.brooklyn?.earnings_shadow_rating_brooklyn_v2))
                ? Number(allShadows.brooklyn_v3.earnings_shadow_rating_brooklyn_v3) - Number(allShadows.brooklyn.earnings_shadow_rating_brooklyn_v2)
                : null,
              2
            ),
          },
          staten_island: {
            rating: safeRound(allShadows.staten_island_v3?.earnings_shadow_rating_staten_island_v3, 2),
            bucket: String(allShadows.staten_island_v3?.earnings_shadow_bucket_staten_island_v3 || ""),
            confidence: safeRound(allShadows.staten_island_v3?.earnings_shadow_confidence_staten_island_v3, 3),
            deltaVsV2: safeRound(
              Number.isFinite(Number(allShadows.staten_island_v3?.earnings_shadow_rating_staten_island_v3)) &&
              Number.isFinite(Number(allShadows.staten_island?.earnings_shadow_rating_staten_island_v2))
                ? Number(allShadows.staten_island_v3.earnings_shadow_rating_staten_island_v3) - Number(allShadows.staten_island.earnings_shadow_rating_staten_island_v2)
                : null,
              2
            ),
          },
        }
      : null;
    const manhattanV3LiveCandidate = allShadows
      ? {
          manhattanV3Rating: safeRound(allShadows.manhattan_v3?.earnings_shadow_rating_manhattan_v3, 2),
          manhattanV3Bucket: String(allShadows.manhattan_v3?.earnings_shadow_bucket_manhattan_v3 || ""),
          manhattanV3Confidence: safeRound(allShadows.manhattan_v3?.earnings_shadow_confidence_manhattan_v3, 3),
          manhattanV3DeltaVsV2: safeRound(
            Number.isFinite(Number(allShadows.manhattan_v3?.earnings_shadow_rating_manhattan_v3)) &&
            Number.isFinite(Number(allShadows.manhattan?.earnings_shadow_rating_manhattan_v2))
              ? Number(allShadows.manhattan_v3.earnings_shadow_rating_manhattan_v3) - Number(allShadows.manhattan.earnings_shadow_rating_manhattan_v2)
              : null,
            2
          ),
        }
      : null;
    const bronxWashHeightsV3LiveCandidate = allShadows
      ? {
          bronxWashHeightsV3Rating: safeRound(allShadows.bronx_wash_heights_v3?.earnings_shadow_rating_bronx_wash_heights_v3, 2),
          bronxWashHeightsV3Bucket: String(allShadows.bronx_wash_heights_v3?.earnings_shadow_bucket_bronx_wash_heights_v3 || ""),
          bronxWashHeightsV3Confidence: safeRound(allShadows.bronx_wash_heights_v3?.earnings_shadow_confidence_bronx_wash_heights_v3, 3),
          bronxWashHeightsV3DeltaVsV2: safeRound(
            Number.isFinite(Number(allShadows.bronx_wash_heights_v3?.earnings_shadow_rating_bronx_wash_heights_v3)) &&
            Number.isFinite(Number(allShadows.bronx_wash_heights?.earnings_shadow_rating_bronx_wash_heights_v2))
              ? Number(allShadows.bronx_wash_heights_v3.earnings_shadow_rating_bronx_wash_heights_v3) - Number(allShadows.bronx_wash_heights.earnings_shadow_rating_bronx_wash_heights_v2)
              : null,
            2
          ),
        }
      : null;
    const queensV3LiveCandidate = allShadows
      ? {
          queensV3Rating: safeRound(allShadows.queens_v3?.earnings_shadow_rating_queens_v3, 2),
          queensV3Bucket: String(allShadows.queens_v3?.earnings_shadow_bucket_queens_v3 || ""),
          queensV3Confidence: safeRound(allShadows.queens_v3?.earnings_shadow_confidence_queens_v3, 3),
          queensV3DeltaVsV2: safeRound(
            Number.isFinite(Number(allShadows.queens_v3?.earnings_shadow_rating_queens_v3)) &&
            Number.isFinite(Number(allShadows.queens?.earnings_shadow_rating_queens_v2))
              ? Number(allShadows.queens_v3.earnings_shadow_rating_queens_v3) - Number(allShadows.queens.earnings_shadow_rating_queens_v2)
              : null,
            2
          ),
        }
      : null;
    const crowding =
      crowdingModule.getZoneCommunityCrowdingSnapshot?.(props?.LocationID) || null;

    return {
      locationId: String(props?.LocationID ?? ""),
      zoneName: String(props?.zone_name || ""),
      borough: String(props?.borough || ""),
      activeModeTag,
      visibleSource,
      visibleSourceLabel,
      technicalSourceLabel,
      usingFallback,
      visibleRating: Number.isFinite(visibleRating) ? Math.round(visibleRating) : null,
      visibleBucket,
      visibleColor,
      shadowProfiles: allShadows,
      shadowReadiness,
      densityTripQuality,
      citywideV3Candidate,
      manhattanV3LiveCandidate,
      bronxWashHeightsV3LiveCandidate,
      queensV3LiveCandidate,
      boroughV3Candidates,
      crowding: crowding
        ? {
            bucket: String(crowding.bucket || ""),
            bucketLabel: String(crowdingModule.getCommunityCrowdingBucketLabel?.(crowding.bucket) || ""),
            confidence: safeRound(crowding.confidence, 3),
            communityDriverCount: Number(crowding.communityDriverCount || 0),
            penalty: safeRound(crowding.penalty, 2),
            crowdingScore: safeRound(crowding.crowdingScore, 3),
            demandReference: safeRound(crowding.demandReference, 2),
          }
        : null,
    };
  }

  function summarizeVisibleScoreSources(frame) {
    const features = frame?.polygons?.features || [];
    const counts = {};
    let shadowReadyCount = 0;
    let fallbackCount = 0;

    for (const feature of features) {
      const props = feature?.properties || {};
      const geom = feature?.geometry || null;

      const source = String(window.TlcModeModule?.getVisibleScoreSourceForFeature?.(props, geom) || "unknown");
      counts[source] = Number(counts[source] || 0) + 1;

      const readiness = window.TlcScoreShadowModule?.getVisibleShadowReadiness?.(props, geom);
      if (readiness?.shadowReady) shadowReadyCount += 1;
      if (readiness?.usingFallback) fallbackCount += 1;
    }

    return {
      counts,
      shadowReadyCount,
      fallbackCount,
      featureCount: features.length,
    };
  }

  function getTeamJoseoSystemAudit() {
    const frame = core.getCurrentFrame?.() || null;
    const frameSummary = summarizeVisibleScoreSources(frame);
    const recommendation = window.getTeamJoseoRecommendationAudit?.() || null;
    const crowding = window.getCommunityCrowdingDebug?.() || null;
    const modeFlags = window.TlcModeModule?.getModeFlags?.() || {};

    return {
      frameTime: String(frame?.time || ""),
      featureCount: Number(frameSummary.featureCount || 0),
      visibleSourceCounts: frameSummary.counts || {},
      shadowReadyCount: Number(frameSummary.shadowReadyCount || 0),
      fallbackCount: Number(frameSummary.fallbackCount || 0),
      modeFlags,
      recommendation,
      communityCrowding: crowding,
    };
  }

  function getVisibleScoreAuditByLocationId(locationId) {
    const feature = getCurrentFrameZoneFeatureById(locationId);
    if (!feature) return null;
    return getVisibleScoreAudit(feature.properties || {}, feature.geometry || null);
  }

  window.TlcZoneAuditModule = {
    getCurrentFrameZoneFeatureById,
    getVisibleScoreAudit,
    getVisibleScoreAuditByLocationId,
  };

  window.getTeamJoseoZoneAuditByLocationId = function getTeamJoseoZoneAuditByLocationId(locationId) {
    return getVisibleScoreAuditByLocationId(locationId);
  };

  window.getTeamJoseoBoroughV3AuditByLocationId = function getTeamJoseoBoroughV3AuditByLocationId(locationId) {
    const audit = getVisibleScoreAuditByLocationId(locationId);
    return audit?.boroughV3Candidates || null;
  };

  window.getBoroughV3CandidateDebugByLocationId = function getBoroughV3CandidateDebugByLocationId(locationId) {
    return window.getTeamJoseoBoroughV3AuditByLocationId(locationId);
  };

  window.getTeamJoseoSystemAudit = getTeamJoseoSystemAudit;
})();
