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
  const AI_ASSISTANT_BUSY_NOW_MIN = 0.68;
  const AI_ASSISTANT_SLOW_NOW_MAX = 0.35;
  const AI_ASSISTANT_SLOW_NEXT_MAX = 0.40;
  const AI_ASSISTANT_SHORT_TRIP_TRAP_MIN = 0.62;
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
      const payload = await window.TlcMapUiInternals?.fetchJSON?.(url, { signal: controller.signal, cache: "no-store" });
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
      refresh().catch(() => {});
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
