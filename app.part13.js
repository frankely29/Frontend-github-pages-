(function() {
  const core = window.TlcZoneLabelInternals || {};

  const ZONE_EDGE_CUE_MIN_ZOOM = 12.2;
  const ZONE_EDGE_CUE_SOURCE_ID = "zone-edge-cue";
  const ZONE_EDGE_CUE_BASE_LAYER_ID = "zone-edge-cue-base";
  const ZONE_EDGE_CUE_INNER_LAYER_ID = "zone-edge-cue-inner";
  const ZONE_EDGE_CUE_LEGACY_LAYER_IDS = [
    "zone-edge-influence",
    "zone-edge-influence-halo",
    "zone-edge-influence-soft",
    "zone-edge-influence-core",
    "zone-edge-influence-seed",
    "zone-edge-cue-base-old",
    "zone-edge-cue-inner-old"
  ];
  const ZONE_EDGE_CUE_MIN_RATING_DIFF = 6;
  const ZONE_EDGE_CUE_MAX_RATING_DIFF = 30;
  const ZONE_EDGE_CUE_COORD_DP = 6;
  const ZONE_EDGE_CUE_MAX_FEATURES = 220;

  let edgeCueAdjacencyCache = [];
  let edgeCueTopologySignature = "";
  let edgeCueInputSignature = "";
  let edgeCueCachedFc = { type: "FeatureCollection", features: [] };
  let edgeCuePendingFrame = null;
  let edgeCueRefreshHandle = 0;
  let edgeCueFeatureCount = 0;
  let edgeCueBuildStats = {
    adjacencyPairs: 0,
    sharedSegments: 0,
    builtFeatures: 0,
    skippedMissingRating: 0,
    skippedMinDiff: 0,
    skippedShielded: 0,
  };
  let pickupHotspotShieldZoneIds = new Set();

  function normalizePickupShieldZoneId(value) {
    if (value == null || value === "") return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return String(n);
  }

  function setPickupHotspotShieldZoneIds(zoneIds) {
    const next = new Set();
    const list = Array.isArray(zoneIds) ? zoneIds : [];
    for (const value of list) {
      const normalized = normalizePickupShieldZoneId(value);
      if (normalized != null) next.add(normalized);
    }
    pickupHotspotShieldZoneIds = next;
  }

  function isPickupHotspotShieldedZone(zoneId) {
    const normalized = normalizePickupShieldZoneId(zoneId);
    if (normalized == null) return false;
    return pickupHotspotShieldZoneIds.has(normalized);
  }

  function syncPickupHotspotShieldZoneIdsFromSource() {
    const snapshot = window.TlcCommunityModule?.getPickupHotspotZoneIdsSnapshot?.()
      || window.__pickupDebug?.hotspotCoveredZoneIds
      || [];
    setPickupHotspotShieldZoneIds(snapshot);
  }

  function ringSignedArea(ring) {
    if (!Array.isArray(ring) || ring.length < 3) return 0;
    let area = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i];
      const b = ring[i + 1];
      const ax = Number(a?.[0]);
      const ay = Number(a?.[1]);
      const bx = Number(b?.[0]);
      const by = Number(b?.[1]);
      if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) continue;
      area += (ax * by) - (bx * ay);
    }
    return area / 2;
  }

  function forEachOuterRing(feature, cb) {
    if (typeof cb !== "function") return;
    const geom = feature?.geometry;
    if (!geom) return;

    if (geom.type === "Polygon") {
      const ring = Array.isArray(geom.coordinates) ? geom.coordinates[0] : null;
      if (Array.isArray(ring) && ring.length > 1) cb(ring);
      return;
    }

    if (geom.type === "MultiPolygon") {
      const polys = Array.isArray(geom.coordinates) ? geom.coordinates : [];
      for (const poly of polys) {
        const ring = Array.isArray(poly) ? poly[0] : null;
        if (Array.isArray(ring) && ring.length > 1) cb(ring);
      }
    }
  }

  function edgeCoordKey(coord) {
    const lng = Number(coord?.[0]);
    const lat = Number(coord?.[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return "";
    return `${lng.toFixed(ZONE_EDGE_CUE_COORD_DP)}|${lat.toFixed(ZONE_EDGE_CUE_COORD_DP)}`;
  }

  function sharedSegmentKey(a, b) {
    const aKey = edgeCoordKey(a);
    const bKey = edgeCoordKey(b);
    if (!aKey || !bKey) return "";
    return aKey <= bKey ? `${aKey}__${bKey}` : `${bKey}__${aKey}`;
  }

  function buildZoneEdgeAdjacency(frame) {
    const features = frame?.polygons?.features || [];
    const segmentMap = new Map();

    for (const feature of features) {
      const zoneId = String(feature?.properties?.LocationID ?? "");
      if (!zoneId) continue;

      forEachOuterRing(feature, (ring) => {
        const interiorSide = ringSignedArea(ring) > 0 ? "left" : "right";
        for (let i = 1; i < ring.length; i++) {
          const startCoord = ring[i - 1];
          const endCoord = ring[i];
          if (!Array.isArray(startCoord) || !Array.isArray(endCoord)) continue;
          const key = sharedSegmentKey(startCoord, endCoord);
          if (!key) continue;
          const list = segmentMap.get(key) || [];
          list.push({ zoneId, coords: [startCoord, endCoord], interiorSide });
          segmentMap.set(key, list);
        }
      });
    }

    const pairMap = new Map();

    for (const occurrences of segmentMap.values()) {
      if (!Array.isArray(occurrences) || occurrences.length < 2) continue;

      const zoneMap = new Map();
      for (const occurrence of occurrences) {
        if (!occurrence?.zoneId) continue;
        if (!zoneMap.has(occurrence.zoneId)) zoneMap.set(occurrence.zoneId, occurrence);
      }

      if (zoneMap.size !== 2) continue;

      const zoneIds = Array.from(zoneMap.keys()).sort();
      const aZoneId = zoneIds[0];
      const bZoneId = zoneIds[1];
      const aOccurrence = zoneMap.get(aZoneId);
      const bOccurrence = zoneMap.get(bZoneId);
      if (!aOccurrence || !bOccurrence) continue;

      const pairKey = `${aZoneId}|${bZoneId}`;
      const entry = pairMap.get(pairKey) || {
        aZoneId,
        bZoneId,
        segments: []
      };

      entry.segments.push({
        aCoords: aOccurrence.coords,
        bCoords: bOccurrence.coords,
        aInteriorSide: aOccurrence.interiorSide,
        bInteriorSide: bOccurrence.interiorSide
      });

      pairMap.set(pairKey, entry);
    }

    return Array.from(pairMap.values());
  }

  function getZoneTopologySignature(frame) {
    const features = frame?.polygons?.features || [];
    return features
      .map((feature) => {
        const id = String(feature?.properties?.LocationID ?? "");
        const geom = feature?.geometry;
        let minLng = Infinity;
        let minLat = Infinity;
        let maxLng = -Infinity;
        let maxLat = -Infinity;

        const visit = (coords) => {
          if (!Array.isArray(coords)) return;
          if (coords.length >= 2 && Number.isFinite(coords[0]) && Number.isFinite(coords[1])) {
            minLng = Math.min(minLng, coords[0]);
            minLat = Math.min(minLat, coords[1]);
            maxLng = Math.max(maxLng, coords[0]);
            maxLat = Math.max(maxLat, coords[1]);
            return;
          }
          coords.forEach(visit);
        };

        visit(geom?.coordinates);
        const w = Number.isFinite(minLng) && Number.isFinite(maxLng) ? (maxLng - minLng).toFixed(6) : "0";
        const h = Number.isFinite(minLat) && Number.isFinite(maxLat) ? (maxLat - minLat).toFixed(6) : "0";
        return `${id}|${geom?.type || ""}|${w}|${h}`;
      })
      .sort()
      .join("###");
  }

  function getZoneEdgeAdjacency(frame) {
    const signature = getZoneTopologySignature(frame);
    if (signature === edgeCueTopologySignature) return edgeCueAdjacencyCache;
    edgeCueTopologySignature = signature;
    edgeCueAdjacencyCache = buildZoneEdgeAdjacency(frame);
    return edgeCueAdjacencyCache;
  }

  function getFeatureEffectiveRatingForEdge(feature) {
    const props = feature?.properties || {};
    const geom = feature?.geometry;
    const rating = window.TlcModeModule?.effectiveRating?.(props, geom);
    if (Number.isFinite(rating)) return rating;

    const fallback = Number(props?.rating ?? NaN);
    return Number.isFinite(fallback) ? fallback : NaN;
  }

  function getFeatureBaseColorForEdge(feature) {
    const props = feature?.properties || {};
    const geom = feature?.geometry;
    return (
      window.TlcModeModule?.effectiveColor?.(props, geom) ||
      props?.effectiveColor ||
      props?.style?.fillColor ||
      props?.style?.color ||
      "#ffffff"
    );
  }

  function clamp01(v) {
    return Math.max(0, Math.min(1, Number(v) || 0));
  }

  function orientSegmentIntoZoneRightSide(coords, interiorSide) {
    if (!Array.isArray(coords) || coords.length < 2) return coords;
    if (interiorSide === "right") return coords;
    return [coords[1], coords[0]];
  }

  function buildZoneEdgeCueFeatureCollection(frame) {
    const adjacency = getZoneEdgeAdjacency(frame);
    const zoneFeatures = frame?.polygons?.features || [];
    const zoneFeatureMap = new Map();
    for (const feature of zoneFeatures) {
      const zoneId = String(feature?.properties?.LocationID ?? "");
      if (zoneId) zoneFeatureMap.set(zoneId, feature);
    }

    let sharedSegments = 0;
    let skippedMissingRating = 0;
    let skippedMinDiff = 0;
    let skippedShielded = 0;

    const built = [];

    for (const pair of adjacency) {
      const featureA = zoneFeatureMap.get(pair.aZoneId);
      const featureB = zoneFeatureMap.get(pair.bZoneId);
      if (!featureA || !featureB) continue;

      const ratingA = getFeatureEffectiveRatingForEdge(featureA);
      const ratingB = getFeatureEffectiveRatingForEdge(featureB);
      if (!Number.isFinite(ratingA) || !Number.isFinite(ratingB)) {
        skippedMissingRating += 1;
        continue;
      }

      const diff = Math.abs(ratingA - ratingB);
      if (diff < ZONE_EDGE_CUE_MIN_RATING_DIFF) {
        skippedMinDiff += 1;
        continue;
      }

      const aStrong = ratingA > ratingB;
      const strongZoneId = aStrong ? pair.aZoneId : pair.bZoneId;
      const weakZoneId = aStrong ? pair.bZoneId : pair.aZoneId;
      const strongFeature = aStrong ? featureA : featureB;

      if (isPickupHotspotShieldedZone(strongZoneId)) {
        skippedShielded += 1;
        continue;
      }

      const edgeStrength = clamp01(
        (diff - ZONE_EDGE_CUE_MIN_RATING_DIFF) /
        (ZONE_EDGE_CUE_MAX_RATING_DIFF - ZONE_EDGE_CUE_MIN_RATING_DIFF)
      );

      const baseWidthPx = 2.1 + (edgeStrength * 0.9);
      const innerWidthPx = 4.8 + (edgeStrength * 1.6);
      const baseOpacity = 0.15 + (edgeStrength * 0.05);
      const innerOpacity = 0.12 + (edgeStrength * 0.08);
      const innerOffsetPx = 0.9 + (edgeStrength * 0.7);

      for (const segment of pair.segments || []) {
        sharedSegments += 1;
        const strongerCoords = aStrong ? segment.aCoords : segment.bCoords;
        const strongerInteriorSide = aStrong ? segment.aInteriorSide : segment.bInteriorSide;
        const orientedCoords = orientSegmentIntoZoneRightSide(strongerCoords, strongerInteriorSide);
        if (!Array.isArray(orientedCoords) || orientedCoords.length < 2) continue;

        built.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: orientedCoords },
          properties: {
            edge_color: getFeatureBaseColorForEdge(strongFeature),
            strong_zone_id: strongZoneId,
            weak_zone_id: weakZoneId,
            rating_diff: diff,
            edge_strength: edgeStrength,
            base_width_px: baseWidthPx,
            inner_width_px: innerWidthPx,
            base_opacity: baseOpacity,
            inner_opacity: innerOpacity,
            inner_offset_px: innerOffsetPx,
          }
        });
      }
    }

    built.sort((a, b) => Number(b?.properties?.rating_diff || 0) - Number(a?.properties?.rating_diff || 0));
    const features = built.slice(0, ZONE_EDGE_CUE_MAX_FEATURES);

    edgeCueBuildStats = {
      adjacencyPairs: Array.isArray(adjacency) ? adjacency.length : 0,
      sharedSegments,
      builtFeatures: features.length,
      skippedMissingRating,
      skippedMinDiff,
      skippedShielded,
    };

    return { type: "FeatureCollection", features };
  }

  function getZoneEdgeCueInputSignature(frame) {
    const topologySignature = getZoneTopologySignature(frame);
    syncPickupHotspotShieldZoneIdsFromSource();

    const shieldSignature = Array.from(pickupHotspotShieldZoneIds || []).sort().join(",");
    const rows = [];
    const features = frame?.polygons?.features || [];

    for (const feature of features) {
      const zoneId = String(feature?.properties?.LocationID ?? "");
      if (!zoneId) continue;
      const rating = getFeatureEffectiveRatingForEdge(feature);
      const color = String(getFeatureBaseColorForEdge(feature) || "");
      rows.push(`${zoneId}|${Number.isFinite(rating) ? rating.toFixed(3) : "nan"}|${color}`);
    }

    rows.sort();
    return `${topologySignature}@@${shieldSignature}@@${rows.join("###")}`;
  }

  function getCachedZoneEdgeCueFeatureCollection(frame) {
    const signature = getZoneEdgeCueInputSignature(frame);
    if (signature === edgeCueInputSignature) return edgeCueCachedFc;

    edgeCueInputSignature = signature;
    edgeCueCachedFc = buildZoneEdgeCueFeatureCollection(frame);
    return edgeCueCachedFc;
  }

  function clearZoneEdgeCueSource() {
    const map = core.getMap?.();
    const src = map?.getSource?.(ZONE_EDGE_CUE_SOURCE_ID);
    if (src) {
      src.setData(core.emptyGeojson?.() || { type: "FeatureCollection", features: [] });
    }

    edgeCueInputSignature = "";
    edgeCueCachedFc = { type: "FeatureCollection", features: [] };
    edgeCueFeatureCount = 0;
    edgeCuePendingFrame = null;

    if (edgeCueRefreshHandle) {
      if (typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(edgeCueRefreshHandle);
      } else {
        clearTimeout(edgeCueRefreshHandle);
      }
    }
    edgeCueRefreshHandle = 0;
  }

  async function ensureZoneEdgeCueSourceAndLayers() {
    const map = core.getMap?.();
    if (!map) return false;

    const ready = await core.waitForStyleReady?.();
    if (!ready) return false;

    if (!map.getSource(ZONE_EDGE_CUE_SOURCE_ID)) {
      map.addSource(ZONE_EDGE_CUE_SOURCE_ID, {
        type: "geojson",
        data: core.emptyGeojson?.() || { type: "FeatureCollection", features: [] }
      });
    }

    for (const id of ZONE_EDGE_CUE_LEGACY_LAYER_IDS) {
      if (map.getLayer(id)) map.removeLayer(id);
    }

    if (!map.getLayer(ZONE_EDGE_CUE_BASE_LAYER_ID)) {
      map.addLayer({
        id: ZONE_EDGE_CUE_BASE_LAYER_ID,
        type: "line",
        source: ZONE_EDGE_CUE_SOURCE_ID,
        minzoom: ZONE_EDGE_CUE_MIN_ZOOM,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["coalesce", ["to-string", ["get", "edge_color"]], "#ffffff"],
          "line-opacity": ["coalesce", ["to-number", ["get", "base_opacity"]], 0.15],
          "line-width": [
            "*",
            ["coalesce", ["to-number", ["get", "base_width_px"]], 2.1],
            ["interpolate", ["linear"], ["zoom"], 12, 0.92, 14, 1.0, 16, 1.08]
          ],
          "line-blur": 0.18,
          "line-offset": 0
        }
      }, "zones-line");
    }

    if (!map.getLayer(ZONE_EDGE_CUE_INNER_LAYER_ID)) {
      map.addLayer({
        id: ZONE_EDGE_CUE_INNER_LAYER_ID,
        type: "line",
        source: ZONE_EDGE_CUE_SOURCE_ID,
        minzoom: ZONE_EDGE_CUE_MIN_ZOOM,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["coalesce", ["to-string", ["get", "edge_color"]], "#ffffff"],
          "line-opacity": ["coalesce", ["to-number", ["get", "inner_opacity"]], 0.12],
          "line-width": [
            "*",
            ["coalesce", ["to-number", ["get", "inner_width_px"]], 4.8],
            ["interpolate", ["linear"], ["zoom"], 12, 0.92, 14, 1.0, 16, 1.08]
          ],
          "line-blur": 0.55,
          "line-offset": [
            "*",
            ["coalesce", ["to-number", ["get", "inner_offset_px"]], 0.9],
            ["interpolate", ["linear"], ["zoom"], 12, 0.92, 14, 1.0, 16, 1.08]
          ]
        }
      }, "zones-line");
    }

    return true;
  }

  async function refreshZoneEdgeCue(frame) {
    const map = core.getMap?.();
    const mapReady = core.isMapReady?.();
    if (!map || !mapReady || !frame) return;

    const src = map.getSource(ZONE_EDGE_CUE_SOURCE_ID);
    if (!src) return;

    const fc = getCachedZoneEdgeCueFeatureCollection(frame);
    edgeCueFeatureCount = Array.isArray(fc?.features) ? fc.features.length : 0;
    src.setData(fc);
  }

  function scheduleZoneEdgeCueRefresh(frame = null) {
    edgeCuePendingFrame =
      frame ||
      edgeCuePendingFrame ||
      window.TlcCommunityInternals?.getCurrentFrame?.() ||
      window.TlcModeInternals?.getCurrentFrame?.() ||
      null;

    if (edgeCueRefreshHandle) return;

    const run = async () => {
      edgeCueRefreshHandle = 0;
      const next = edgeCuePendingFrame;
      edgeCuePendingFrame = null;
      if (!next) return;
      await refreshZoneEdgeCue(next);
    };

    if (typeof window.requestAnimationFrame === "function") {
      edgeCueRefreshHandle = window.requestAnimationFrame(() => {
        run();
      });
    } else {
      edgeCueRefreshHandle = window.setTimeout(() => {
        run();
      }, 16);
    }
  }

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    syncPickupHotspotShieldZoneIdsFromSource();

    window.addEventListener("tlc-zone-owner-ready", async () => {
      await ensureZoneEdgeCueSourceAndLayers();
      const frame =
        window.TlcCommunityInternals?.getCurrentFrame?.() ||
        window.TlcModeInternals?.getCurrentFrame?.() ||
        null;
      if (frame) scheduleZoneEdgeCueRefresh(frame);
    });

    window.addEventListener("tlc-pickup-hotspot-zones-updated", (event) => {
      setPickupHotspotShieldZoneIds(event?.detail?.hotspotZoneIds || []);
      scheduleZoneEdgeCueRefresh();
    });

    window.addEventListener("tlc-mode-changed", () => {
      scheduleZoneEdgeCueRefresh();
    });

    window.addEventListener("tlc-day-tendency-updated", () => {
      scheduleZoneEdgeCueRefresh();
    });
  }

  window.getZoneEdgeCueDebug = function () {
    const map = core.getMap?.();
    const source = map?.getSource?.(ZONE_EDGE_CUE_SOURCE_ID);
    const sourceData = source && typeof source._data !== "undefined" ? source._data : null;
    return {
      topologyCount: Array.isArray(edgeCueAdjacencyCache) ? edgeCueAdjacencyCache.length : 0,
      topologySignature: edgeCueTopologySignature,
      inputSignature: edgeCueInputSignature,
      featureCount: edgeCueFeatureCount,
      hasSourceData: Array.isArray(sourceData?.features) ? sourceData.features.length > 0 : edgeCueFeatureCount > 0,
      zoomLevel: Number(map?.getZoom?.() || 0),
      zoomActive: Number(map?.getZoom?.() || 0) >= ZONE_EDGE_CUE_MIN_ZOOM,
      buildStats: edgeCueBuildStats,
      hotspotShieldZoneIds: Array.from(pickupHotspotShieldZoneIds || []).sort(),
      sourceReady: !!source,
      baseLayerReady: !!map?.getLayer?.(ZONE_EDGE_CUE_BASE_LAYER_ID),
      innerLayerReady: !!map?.getLayer?.(ZONE_EDGE_CUE_INNER_LAYER_ID),
      refreshPending: !!edgeCueRefreshHandle,
      maxFeatures: ZONE_EDGE_CUE_MAX_FEATURES,
    };
  };

  window.TlcZoneEdgeCueModule = {
    ensureZoneEdgeCueSourceAndLayers,
    refreshZoneEdgeCue,
    scheduleZoneEdgeCueRefresh,
    clearZoneEdgeCueSource,
  };
})();
