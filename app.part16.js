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

    const visibleRating = Number(modeModule.effectiveRating?.(props, geom) ?? NaN);
    const visibleBucket = String(modeModule.effectiveBucket?.(props, geom) || "");
    const visibleColor = String(modeModule.effectiveColor?.(props, geom) || "");
    const activeModeTag = String(modeModule.getActiveSpecialModeTagForFeature?.(props, geom) || "");

    const allShadows = shadowModule.getAllZoneShadowSnapshots?.(props) || null;
    const crowding =
      crowdingModule.getZoneCommunityCrowdingSnapshot?.(props?.LocationID) || null;

    return {
      locationId: String(props?.LocationID ?? ""),
      zoneName: String(props?.zone_name || ""),
      borough: String(props?.borough || ""),
      activeModeTag,
      visibleSource,
      visibleSourceLabel,
      visibleRating: Number.isFinite(visibleRating) ? Math.round(visibleRating) : null,
      visibleBucket,
      visibleColor,
      shadowProfiles: allShadows,
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
})();
