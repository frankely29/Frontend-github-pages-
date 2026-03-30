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
  const ZONE_EDGE_CUE_MAX_PATHS = 260;

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
    mergedPaths: 0,
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
    for (const zoneId of list) {
      const normalized = normalizePickupShieldZoneId(zoneId);
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
      const ax = Number(ring[i]?.[0]);
      const ay = Number(ring[i]?.[1]);
      const bx = Number(ring[i + 1]?.[0]);
      const by = Number(ring[i + 1]?.[1]);
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
      const polygons = Array.isArray(geom.coordinates) ? geom.coordinates : [];
      for (const poly of polygons) {
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
          const existing = segmentMap.get(key) || [];
          existing.push({
            zoneId,
            coords: [startCoord, endCoord],
            interiorSide,
          });
          segmentMap.set(key, existing);
        }
      });
    }

    const adjacencyByPair = new Map();

    for (const occurrences of segmentMap.values()) {
      if (!Array.isArray(occurrences) || occurrences.length < 2) continue;

      const byZone = new Map();
      for (const entry of occurrences) {
        if (!entry?.zoneId || byZone.has(entry.zoneId)) continue;
        byZone.set(entry.zoneId, entry);
      }
      if (byZone.size !== 2) continue;

      const pairIds = Array.from(byZone.keys()).sort();
      const aZoneId = pairIds[0];
      const bZoneId = pairIds[1];
      const aEntry = byZone.get(aZoneId);
      const bEntry = byZone.get(bZoneId);
      if (!aEntry || !bEntry) continue;

      const pairKey = `${aZoneId}|${bZoneId}`;
      const pair = adjacencyByPair.get(pairKey) || { aZoneId, bZoneId, segments: [] };
      pair.segments.push({
        aCoords: aEntry.coords,
        bCoords: bEntry.coords,
        aInteriorSide: aEntry.interiorSide,
        bInteriorSide: bEntry.interiorSide,
      });
      adjacencyByPair.set(pairKey, pair);
    }

    return Array.from(adjacencyByPair.values());
  }

  function mergeConnectedLineSegments(segments) {
    const normalized = [];
    for (const segment of Array.isArray(segments) ? segments : []) {
      if (!Array.isArray(segment) || segment.length < 2) continue;
      const a = segment[0];
      const b = segment[1];
      const aKey = edgeCoordKey(a);
      const bKey = edgeCoordKey(b);
      if (!aKey || !bKey) continue;
      normalized.push({ a, b, aKey, bKey });
    }

    const endpointMap = new Map();
    const addEndpoint = (key, idx) => {
      const list = endpointMap.get(key) || [];
      list.push(idx);
      endpointMap.set(key, list);
    };

    for (let i = 0; i < normalized.length; i++) {
      addEndpoint(normalized[i].aKey, i);
      addEndpoint(normalized[i].bKey, i);
    }

    const used = new Set();
    const merged = [];

    const appendUnique = (arr, coord) => {
      const prev = arr[arr.length - 1];
      if (prev && edgeCoordKey(prev) === edgeCoordKey(coord)) return;
      arr.push(coord);
    };

    const prependUnique = (arr, coord) => {
      const first = arr[0];
      if (first && edgeCoordKey(first) === edgeCoordKey(coord)) return;
      arr.unshift(coord);
    };

    const findAttachable = (key) => {
      const indexes = endpointMap.get(key) || [];
      for (const idx of indexes) {
        if (!used.has(idx)) return idx;
      }
      return -1;
    };

    for (let startIdx = 0; startIdx < normalized.length; startIdx++) {
      if (used.has(startIdx)) continue;

      used.add(startIdx);
      const start = normalized[startIdx];
      const path = [start.a, start.b];

      let extended = true;
      while (extended) {
        extended = false;

        const endKey = edgeCoordKey(path[path.length - 1]);
        const nextIdx = findAttachable(endKey);
        if (nextIdx >= 0) {
          used.add(nextIdx);
          const seg = normalized[nextIdx];
          if (seg.aKey === endKey) appendUnique(path, seg.b);
          else appendUnique(path, seg.a);
          extended = true;
        }

        const startKey = edgeCoordKey(path[0]);
        const prevIdx = findAttachable(startKey);
        if (prevIdx >= 0) {
          used.add(prevIdx);
          const seg = normalized[prevIdx];
          if (seg.aKey === startKey) prependUnique(path, seg.b);
          else prependUnique(path, seg.a);
          extended = true;
        }
      }

      if (path.length >= 2) merged.push(path);
    }

    return merged;
  }

  function getZoneTopologySignature(frame) {
    const features = frame?.polygons?.features || [];
    const rows = features.map((feature) => {
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
      const width = Number.isFinite(minLng) && Number.isFinite(maxLng) ? (maxLng - minLng).toFixed(6) : "0";
      const height = Number.isFinite(minLat) && Number.isFinite(maxLat) ? (maxLat - minLat).toFixed(6) : "0";
      return `${id}|${geom?.type || ""}|${width}|${height}`;
    });
    rows.sort();
    return rows.join("###");
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
    const zoneMap = new Map();
    for (const feature of zoneFeatures) {
      const zoneId = String(feature?.properties?.LocationID ?? "");
      if (zoneId) zoneMap.set(zoneId, feature);
    }

    let sharedSegments = 0;
    let mergedPaths = 0;
    let skippedMissingRating = 0;
    let skippedMinDiff = 0;
    let skippedShielded = 0;

    const builtFeatures = [];

    for (const pair of adjacency) {
      const aFeature = zoneMap.get(pair.aZoneId);
      const bFeature = zoneMap.get(pair.bZoneId);
      if (!aFeature || !bFeature) continue;

      const ratingA = getFeatureEffectiveRatingForEdge(aFeature);
      const ratingB = getFeatureEffectiveRatingForEdge(bFeature);
      if (!Number.isFinite(ratingA) || !Number.isFinite(ratingB)) {
        skippedMissingRating += 1;
        continue;
      }

      const diff = Math.abs(ratingA - ratingB);
      if (diff < ZONE_EDGE_CUE_MIN_RATING_DIFF) {
        skippedMinDiff += 1;
        continue;
      }

      const strongerIsA = ratingA >= ratingB;
      const strongZoneId = strongerIsA ? pair.aZoneId : pair.bZoneId;
      const weakZoneId = strongerIsA ? pair.bZoneId : pair.aZoneId;
      const strongFeature = strongerIsA ? aFeature : bFeature;

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

      const strongSegments = [];
      for (const segment of pair.segments || []) {
        sharedSegments += 1;
        const coords = strongerIsA ? segment.aCoords : segment.bCoords;
        const interiorSide = strongerIsA ? segment.aInteriorSide : segment.bInteriorSide;
        const oriented = orientSegmentIntoZoneRightSide(coords, interiorSide);
        if (!Array.isArray(oriented) || oriented.length < 2) continue;
        strongSegments.push([oriented[0], oriented[1]]);
      }

      const merged = mergeConnectedLineSegments(strongSegments);
      mergedPaths += merged.length;

      for (const path of merged) {
        if (!Array.isArray(path) || path.length < 2) continue;
        builtFeatures.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: path },
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

    builtFeatures.sort((a, b) => Number(b?.properties?.rating_diff || 0) - Number(a?.properties?.rating_diff || 0));
    const features = builtFeatures.slice(0, ZONE_EDGE_CUE_MAX_PATHS);

    edgeCueBuildStats = {
      adjacencyPairs: Array.isArray(adjacency) ? adjacency.length : 0,
      sharedSegments,
      mergedPaths,
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
    const hotspotShieldSignature = Array.from(pickupHotspotShieldZoneIds || []).sort().join(",");

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

    return `${topologySignature}@@${hotspotShieldSignature}@@${rows.join("###")}`;
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

    const styleReady = await core.waitForStyleReady?.();
    if (!styleReady) return false;

    if (!map.getSource(ZONE_EDGE_CUE_SOURCE_ID)) {
      map.addSource(ZONE_EDGE_CUE_SOURCE_ID, {
        type: "geojson",
        data: core.emptyGeojson?.() || { type: "FeatureCollection", features: [] }
      });
    }

    for (const layerId of ZONE_EDGE_CUE_LEGACY_LAYER_IDS) {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
    }

    if (ZONE_EDGE_CUE_SOURCE_ID !== "zone-edge-influence" && map.getSource("zone-edge-influence")) {
      if (map.getLayer("zone-edge-influence")) map.removeLayer("zone-edge-influence");
      map.removeSource("zone-edge-influence");
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
          "line-offset": 0,
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
          ],
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
      const nextFrame = edgeCuePendingFrame;
      edgeCuePendingFrame = null;
      if (!nextFrame) return;
      await refreshZoneEdgeCue(nextFrame);
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

    window.addEventListener("tlc-pickup-hotspot-zones-updated", () => {
      syncPickupHotspotShieldZoneIdsFromSource();
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
    const zoomLevel = Number(map?.getZoom?.() || 0);
    return {
      topologyCount: Array.isArray(edgeCueAdjacencyCache) ? edgeCueAdjacencyCache.length : 0,
      topologySignature: edgeCueTopologySignature,
      inputSignature: edgeCueInputSignature,
      featureCount: edgeCueFeatureCount,
      hasSourceData: Array.isArray(sourceData?.features) ? sourceData.features.length > 0 : edgeCueFeatureCount > 0,
      zoomLevel,
      zoomActive: zoomLevel >= ZONE_EDGE_CUE_MIN_ZOOM,
      buildStats: edgeCueBuildStats,
      hotspotShieldZoneIds: Array.from(pickupHotspotShieldZoneIds || []).sort(),
      sourceReady: !!source,
      baseLayerReady: !!map?.getLayer?.(ZONE_EDGE_CUE_BASE_LAYER_ID),
      innerLayerReady: !!map?.getLayer?.(ZONE_EDGE_CUE_INNER_LAYER_ID),
      refreshPending: !!edgeCueRefreshHandle,
      maxPaths: ZONE_EDGE_CUE_MAX_PATHS,
    };
  };

  window.TlcZoneEdgeCueModule = {
    ensureZoneEdgeCueSourceAndLayers,
    refreshZoneEdgeCue,
    scheduleZoneEdgeCueRefresh,
    clearZoneEdgeCueSource,
  };
})();

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

  const state = {
    phase: 3,
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
    signalSnapshot: null,
    bestNearbyOverall: null,
    bestNearbyTrapEscape: null,
    bestNearbyLongTrip: null,
    assistantTags: [],
    assistantReasonFragments: [],
    dwellMs: 0,
    lastRenderFingerprint: "",
    lastActionFingerprint: "",
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
      .aiAssistHeadline{font-weight:700}
      .aiAssistMeta{font-size:12px;opacity:.95}
      .aiAssistTags{display:flex;flex-wrap:wrap;gap:4px}
      .aiAssistTag{font-size:11px;opacity:.95;padding:1px 6px;border-radius:999px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15)}
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

  function computeCurrentZoneDisplayedRanks(frame, activeZoneId, activeBorough) {
    const features = frame?.polygons?.features || [];
    const rows = [];
    for (const feature of features) {
      const signal = buildAssistantFeatureSignal(feature);
      if (!signal.locationId || signal.airportExcluded || !Number.isFinite(signal.visibleRating)) continue;
      rows.push({
        zoneId: signal.locationId,
        borough: signal.borough,
        rating: signal.visibleRating,
        idSort: Number.isFinite(Number(signal.locationId)) ? Number(signal.locationId) : Number.MAX_SAFE_INTEGER,
      });
    }
    rows.sort((a, b) => (b.rating - a.rating) || (a.idSort - b.idSort) || a.zoneId.localeCompare(b.zoneId));
    const citywideIndex = rows.findIndex((row) => row.zoneId === String(activeZoneId));
    const boroughRows = rows.filter((row) => row.borough === String(activeBorough || ""));
    const boroughIndex = boroughRows.findIndex((row) => row.zoneId === String(activeZoneId));
    return {
      citywideRank: citywideIndex >= 0 ? citywideIndex + 1 : null,
      citywideTotal: rows.length || null,
      boroughRank: boroughIndex >= 0 ? boroughIndex + 1 : null,
      boroughTotal: boroughRows.length || null,
    };
  }

  function classifyCurrentZone(signal) {
    const busyNowFlag = (signal.busyNowBase ?? -Infinity) >= 0.68;
    const slowNowFlag = (signal.busyNowBase ?? Infinity) <= 0.35 && (signal.busyNextBase ?? Infinity) <= 0.40;
    const shortTripTrapFlag = (signal.shortTripPenalty ?? 0) >= 0.62
      && (signal.sameZoneRetentionPenalty ?? 0) >= 0.55
      && (signal.continuationRaw ?? 1) <= 0.45;
    const longTripFriendlyFlag = (signal.longTripShare20Plus ?? 0) >= 0.62;
    const saturationCautionFlag = ((signal.borough || "").includes("Manhattan") && (signal.manhattanCoreSaturationPenalty ?? 0) >= 0.45)
      || (signal.marketSaturationPenalty ?? 0) >= 0.60;
    const goodContinuationFlag = (signal.continuationRaw ?? 0) >= 0.60;
    const weakContinuationFlag = (signal.continuationRaw ?? 1) <= 0.35;
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

  function buildHeadline() {
    const zone = state.activeStableZoneName || "—";
    const target = state.assistantMoveTarget?.zoneName || "—";
    if (state.actionCode === "STAY") return `STAY — ${zone}`;
    if (state.actionCode === "MOVE_SOON") return `MOVE SOON → ${target}`;
    if (state.actionCode === "LEAVE_NOW") return `LEAVE NOW → ${target}`;
    if (state.actionCode === "STAY_BRIEFLY") return `STAY BRIEFLY → ${target}`;
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

  function toFingerprint() {
    return [
      state.activeStableZoneId || "",
      state.actionCode || "",
      state.actionReason || "",
      state.assistantMoveTarget?.locationId || "",
      Number.isFinite(state.rating) ? state.rating.toFixed(2) : "nan",
      Number.isFinite(state.currentZoneHoldScore) ? state.currentZoneHoldScore.toFixed(2) : "nan",
      state.dwellMs ? Math.round(state.dwellMs / 10000) : 0,
    ].join("|");
  }

  function renderBanner() {
    const host = getRecommendEl();
    if (!host) return;
    ensureStyle();

    const ratingTxt = Number.isFinite(state.rating) ? `${Math.round(state.rating)} (${state.bucket || "n/a"})` : "n/a";
    const cityRankTxt = (state.citywideRank && state.citywideTotal) ? `#${state.citywideRank} / ${state.citywideTotal} citywide` : "— citywide";
    const boroughRankTxt = (state.boroughRank && state.boroughTotal) ? `#${state.boroughRank} / ${state.boroughTotal} in borough` : "— in borough";
    const tagsHtml = (state.assistantTags || []).slice(0, 3).map((tag) => `<span class="aiAssistTag">${tag}</span>`).join("");
    const target = state.assistantMoveTarget;

    host.innerHTML = `
      <div class="aiAssistBanner" data-phase="3" data-state="${state.actionCode || "MONITOR"}">
        <div class="aiAssistHeadline">${buildHeadline()}</div>
        <div class="aiAssistMeta">Current: ${state.activeStableZoneName || "—"} • ${ratingTxt} • ${state.visibleScoreSourceLabel || "Team Joseo score"}</div>
        <div class="aiAssistMeta">${formatDwell(state.dwellMs)}</div>
        <div class="aiAssistMeta">${cityRankTxt} • ${boroughRankTxt}</div>
        ${tagsHtml ? `<div class="aiAssistTags">${tagsHtml}</div>` : ""}
        ${target ? `<div class="aiAssistMeta">Target: ${target.zoneName} (${target.borough || "—"}) • ${formatMiles(target.distanceMiles)} • rating ${Math.round(target.visibleRating || 0)} • ${state.actionReason.replaceAll("_", " ")}</div>` : ""}
        <div class="aiAssistMeta">${buildSubline()}</div>
      </div>
    `;
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
    state.actionHeadline = headline;
    state.actionSubline = subline;
    state.actionSeverity = "neutral";
    state.assistantMoveTarget = null;
    state.navActive = applyNavDestination(state.actionCode, null);
  }

  function updateFromFrame(frame, now) {
    if (!frame) {
      applyStatusOnly("frame-unavailable", "AI Assistant: frame unavailable", "Waiting for score frame.");
      return;
    }
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
    const ranks = computeCurrentZoneDisplayedRanks(frame, state.activeStableZoneId, currentSignal.borough || state.activeStableBorough || "");

    state.phase = 3;
    state.assistantStatus = currentSignal.airportExcluded ? "airport-excluded" : "classified";
    state.activeStableZoneName = currentSignal.zoneName;
    state.activeStableBorough = currentSignal.borough;
    state.visibleScoreSource = currentSignal.visibleScoreSource;
    state.visibleScoreSourceLabel = currentSignal.visibleScoreSourceLabel;
    state.rating = currentSignal.visibleRating;
    state.bucket = currentSignal.visibleBucket;
    state.airportExcluded = currentSignal.airportExcluded;
    state.citywideRank = ranks.citywideRank;
    state.citywideTotal = ranks.citywideTotal;
    state.boroughRank = ranks.boroughRank;
    state.boroughTotal = ranks.boroughTotal;

    state.signalSnapshot = currentSignal;
    state.currentZoneHoldScore = decision.holdScore;
    state.bestNearbyOverall = serializeCandidate(candidateSet.bestNearbyOverall, decision.holdScore);
    state.bestNearbyTrapEscape = serializeCandidate(candidateSet.bestNearbyTrapEscape, decision.holdScore);
    state.bestNearbyLongTrip = serializeCandidate(candidateSet.bestNearbyLongTrip, decision.holdScore);

    state.assistantTags = buildAssistantTags(decision.classification);
    state.actionCode = decision.actionCode;
    state.actionReason = decision.actionReason;
    state.actionSeverity = decision.actionSeverity;
    state.assistantMoveTarget = decision.moveTarget;
    state.scoreAdvantageVsCurrent = decision.moveTarget?.scoreAdvantageVsCurrent ?? null;
    state.navActive = applyNavDestination(state.actionCode, state.assistantMoveTarget);
    state.assistantReasonFragments = buildAssistantActionExplanation(getSnapshot(now));
    state.actionHeadline = buildHeadline();
    state.actionSubline = buildSubline();
  }

  function getSnapshot(tsNow = Date.now()) {
    const dwellMs = state.activeStableZoneEnterTs ? Math.max(0, tsNow - state.activeStableZoneEnterTs) : 0;
    return {
      phase: 3,
      activeStableZoneId: state.activeStableZoneId,
      activeStableZoneName: state.activeStableZoneName,
      activeStableBorough: state.activeStableBorough,
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
      actionCode: state.actionCode,
      actionReason: state.actionReason,
      actionSeverity: state.actionSeverity,
      scoreAdvantageVsCurrent: state.scoreAdvantageVsCurrent,
      navActive: !!state.navActive,
      candidateSearchRadiusOverall: AI_ASSISTANT_NEARBY_OVERALL_MAX_MI,
      candidateSearchRadiusTrapEscape: AI_ASSISTANT_NEARBY_TRAP_ESCAPE_MAX_MI,
      candidateSearchRadiusLongTrip: AI_ASSISTANT_NEARBY_LONG_TRIP_MAX_MI,
      assistantTags: Array.isArray(state.assistantTags) ? [...state.assistantTags] : [],
      assistantReasonFragments: Array.isArray(state.assistantReasonFragments) ? [...state.assistantReasonFragments] : [],
      assistantStatus: state.assistantStatus,
      ts: tsNow,
    };
  }

  function refresh(frame) {
    const now = Date.now();
    updateStableZone(now);
    updateFromFrame(getFrame(frame), now);
    state.dwellMs = state.activeStableZoneEnterTs ? Math.max(0, now - state.activeStableZoneEnterTs) : 0;

    const nextFingerprint = toFingerprint();
    if (nextFingerprint !== state.lastRenderFingerprint) {
      state.lastRenderFingerprint = nextFingerprint;
      renderBanner();
    }

    const snapshot = getSnapshot(now);
    window.dispatchEvent(new CustomEvent("tlc-ai-assistant-snapshot-updated", { detail: snapshot }));

    const actionFingerprint = [
      snapshot.actionCode || "",
      snapshot.actionReason || "",
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
    Object.assign(state, {
      phase: 3,
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
      signalSnapshot: null,
      bestNearbyOverall: null,
      bestNearbyTrapEscape: null,
      bestNearbyLongTrip: null,
      assistantTags: [],
      assistantReasonFragments: [],
      dwellMs: 0,
      lastRenderFingerprint: "",
      lastActionFingerprint: "",
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

  renderBanner();
})();
