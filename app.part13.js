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

  const state = {
    phase: 2,
    activeStableZoneId: null,
    activeStableZoneName: "",
    activeStableBorough: "",
    activeStableZoneEnterTs: null,
    activeStableZoneDwellMs: 0,
    candidateZoneId: null,
    candidateZoneFirstSeenTs: null,
    candidateZoneConsecutiveHits: 0,
    activeZoneLastSeenTs: null,
    lastUserLocation: null,
    lastFrameTime: null,
    assistantStatus: "idle",
    actionState: "TRACKING",
    actionHeadline: "AI Assistant: locating current zone…",
    actionSubline: "Waiting for location and frame.",
    actionSeverity: "neutral",
    assistantMoveTarget: null,
    visibleScoreSource: null,
    visibleScoreSourceLabel: null,
    rating: null,
    bucket: null,
    airportExcluded: false,
    citywideRank: null,
    citywideTotal: null,
    boroughRank: null,
    boroughTotal: null,
    busyNow: null,
    busyNext: null,
    shortTripPenalty: null,
    longTripShareRaw: null,
    longTripShareN: null,
    balancedTripShareRaw: null,
    balancedTripShareN: null,
    sameZoneRetentionPenalty: null,
    churnPressure: null,
    downstreamValue: null,
    marketSaturationPenalty: null,
    manhattanCoreSaturationPenalty: null,
    busyNowFlag: false,
    slowNowFlag: false,
    shortTripTrapFlag: false,
    longTripFriendlyFlag: false,
    saturationCautionFlag: false,
    goodContinuationFlag: false,
    weakContinuationFlag: false,
    zoneHealth: "mixed",
    tags: [],
    dwellMs: 0,
    dwellSeconds: 0,
    dwellMinutesRounded: 0,
    signalSnapshot: null,
    lastRenderFingerprint: "",
  };

  function numberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
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
      .aiAssistFooter{font-size:11px;opacity:.8}
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

  function getActiveStableZoneFeature(frame) {
    if (!state.activeStableZoneId) return null;
    const features = frame?.polygons?.features || [];
    const feature = features.find((item) => getZoneId(item?.properties || {}) === String(state.activeStableZoneId)) || null;
    if (!feature) return null;
    return { feature, props: feature.properties || {}, geom: feature.geometry || null };
  }

  function buildCurrentZoneSignalSnapshot(props = {}, geom = null) {
    const now = Date.now();
    const dwellMs = state.activeStableZoneEnterTs ? Math.max(0, now - state.activeStableZoneEnterTs) : 0;
    const dwellMinutesRounded = Math.round(dwellMs / 60000);
    return {
      rating: numberOrNull(window.TlcModeModule?.effectiveRating?.(props, geom)),
      bucket: String(window.TlcModeModule?.effectiveBucket?.(props, geom) || "").trim() || null,
      visibleScoreSource: String(window.TlcModeModule?.getVisibleScoreSourceForFeature?.(props, geom) || "legacy_citywide"),
      visibleScoreSourceLabel: String(window.TlcModeModule?.getVisibleScoreSourceLabel?.(props, geom) || "Team Joseo score"),
      borough: String(props.borough || "").trim() || null,
      airportExcluded: props.airport_excluded === true,
      busyNow: numberOrNull(props.busy_now_base_n_shadow),
      busyNext: numberOrNull(props.busy_next_base_n_shadow),
      shortTripPenalty: numberOrNull(props.short_trip_penalty_n ?? props.short_trip_penalty_n_shadow),
      longTripShareRaw: numberOrNull(props.long_trip_share_20plus),
      longTripShareN: numberOrNull(props.long_trip_share_20plus_n),
      balancedTripShareRaw: numberOrNull(props.balanced_trip_share_shadow ?? props.balanced_trip_share),
      balancedTripShareN: numberOrNull(props.balanced_trip_share_n_shadow),
      sameZoneRetentionPenalty: numberOrNull(props.same_zone_retention_penalty_n),
      churnPressure: numberOrNull(props.churn_pressure_n_shadow ?? props.churn_pressure_n),
      downstreamValue: numberOrNull(props.downstream_value_n),
      marketSaturationPenalty: numberOrNull(props.market_saturation_penalty_n_shadow ?? props.market_saturation_penalty_n),
      manhattanCoreSaturationPenalty: numberOrNull(props.manhattan_core_saturation_penalty_n_shadow ?? props.manhattan_core_saturation_penalty_n),
      dwellMs,
      dwellMinutesRounded,
    };
  }

  function computeCurrentZoneDisplayedRanks(frame, activeZoneId, activeBorough) {
    const features = frame?.polygons?.features || [];
    const rows = [];
    for (const feature of features) {
      const props = feature?.properties || {};
      const geom = feature?.geometry || null;
      if (props.airport_excluded === true) continue;
      const zoneId = getZoneId(props);
      if (!zoneId) continue;
      const rating = Number(window.TlcModeModule?.effectiveRating?.(props, geom));
      if (!Number.isFinite(rating)) continue;
      rows.push({
        zoneId,
        borough: String(props.borough || "").trim(),
        rating,
        idSort: Number.isFinite(Number(zoneId)) ? Number(zoneId) : Number.MAX_SAFE_INTEGER,
      });
    }

    rows.sort((a, b) => {
      if (b.rating !== a.rating) return b.rating - a.rating;
      if (a.idSort !== b.idSort) return a.idSort - b.idSort;
      return a.zoneId.localeCompare(b.zoneId);
    });

    const citywideIndex = rows.findIndex((row) => row.zoneId === String(activeZoneId));
    const boroughRows = rows.filter((row) => String(row.borough) === String(activeBorough || ""));
    const boroughIndex = boroughRows.findIndex((row) => row.zoneId === String(activeZoneId));

    return {
      citywideRank: citywideIndex >= 0 ? citywideIndex + 1 : null,
      citywideTotal: rows.length || null,
      boroughRank: boroughIndex >= 0 ? boroughIndex + 1 : null,
      boroughTotal: boroughRows.length || null,
    };
  }

  function classifyCurrentZone(signal) {
    const busyNowFlag = (signal.busyNow ?? -Infinity) >= 0.68;
    const slowNowFlag = (signal.busyNow ?? Infinity) <= 0.35 && (signal.busyNext ?? Infinity) <= 0.40;
    const shortTripTrapFlag = (signal.shortTripPenalty ?? -Infinity) >= 0.62
      && (signal.sameZoneRetentionPenalty ?? -Infinity) >= 0.55
      && (signal.downstreamValue ?? Infinity) <= 0.45;
    const longTripFriendlyFlag = ((signal.longTripShareN ?? -Infinity) >= 0.62
      || ((signal.longTripShareRaw ?? -Infinity) >= 0.24
      && (signal.downstreamValue ?? -Infinity) >= 0.50
      && (signal.shortTripPenalty ?? Infinity) <= 0.55));
    const borough = String(signal.borough || "");
    const saturationCautionFlag = ((borough.includes("Manhattan") && (signal.manhattanCoreSaturationPenalty ?? -Infinity) >= 0.45)
      || (signal.marketSaturationPenalty ?? -Infinity) >= 0.60);
    const goodContinuationFlag = (signal.downstreamValue ?? -Infinity) >= 0.60;
    const weakContinuationFlag = (signal.downstreamValue ?? Infinity) <= 0.35;

    let zoneHealth = "mixed";
    if (busyNowFlag && !shortTripTrapFlag && (longTripFriendlyFlag || goodContinuationFlag) && !saturationCautionFlag) {
      zoneHealth = "good";
    } else if (shortTripTrapFlag || (slowNowFlag && weakContinuationFlag)) {
      zoneHealth = "bad";
    }

    return {
      busyNowFlag,
      slowNowFlag,
      shortTripTrapFlag,
      longTripFriendlyFlag,
      saturationCautionFlag,
      goodContinuationFlag,
      weakContinuationFlag,
      zoneHealth,
    };
  }

  function computeCurrentZoneAction(signal, c) {
    if (signal.airportExcluded) {
      return { actionState: "EXCLUDED", actionHeadline: "Airport zone", actionSubline: "Hotspot opportunity logic excluded here", actionSeverity: "neutral" };
    }
    if (c.shortTripTrapFlag && c.saturationCautionFlag) {
      return { actionState: "LEAVE_NOW", actionHeadline: "Short-trip trap", actionSubline: "Low-quality continuation and elevated saturation", actionSeverity: "alert" };
    }
    if (c.shortTripTrapFlag && !c.busyNowFlag) {
      return { actionState: "LEAVE_NOW", actionHeadline: "Trap zone", actionSubline: "Short trips and low continuation make this a bad hold", actionSeverity: "alert" };
    }
    if (c.slowNowFlag && c.weakContinuationFlag) {
      return { actionState: "MOVE_SOON", actionHeadline: "Slow zone now", actionSubline: "Low pace and weak continuation", actionSeverity: "warn" };
    }
    if (c.busyNowFlag && c.longTripFriendlyFlag && !c.saturationCautionFlag) {
      return { actionState: "STAY", actionHeadline: "Strong zone now", actionSubline: "Good pace and long-trip quality", actionSeverity: "positive" };
    }
    if (c.busyNowFlag && !c.shortTripTrapFlag && c.goodContinuationFlag) {
      return { actionState: "STAY_BRIEFLY", actionHeadline: "Decent zone now", actionSubline: "Good enough to hold briefly", actionSeverity: "positive" };
    }
    if (c.saturationCautionFlag && !c.longTripFriendlyFlag) {
      return { actionState: "MOVE_SOON", actionHeadline: "Saturation caution", actionSubline: "Crowding risk is elevated here", actionSeverity: "warn" };
    }
    if (c.zoneHealth === "bad") {
      return { actionState: "MOVE_SOON", actionHeadline: "Weak zone now", actionSubline: "Current signals are below hold quality", actionSeverity: "warn" };
    }
    return { actionState: "MONITOR", actionHeadline: "Mixed zone", actionSubline: "Monitor before committing to stay", actionSeverity: "neutral" };
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

  function formatDwell(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return "In zone for 0s";
    const sec = Math.floor(ms / 1000);
    if (sec >= 60) return `In zone for ${Math.round(sec / 60)}m`;
    return `In zone for ${sec}s`;
  }

  function toFingerprint() {
    return [
      state.activeStableZoneId || "",
      Number.isFinite(state.rating) ? state.rating.toFixed(2) : "nan",
      state.actionState || "",
      state.citywideRank || "",
      state.citywideTotal || "",
      state.boroughRank || "",
      state.boroughTotal || "",
      state.dwellMinutesRounded || 0,
      state.assistantStatus || "",
    ].join("|");
  }

  function renderBanner() {
    const host = getRecommendEl();
    if (!host) return;
    ensureStyle();

    const zoneTxt = state.activeStableZoneName || "—";
    const boroughTxt = state.activeStableBorough || "—";
    const ratingTxt = Number.isFinite(state.rating) ? `${Math.round(state.rating)} (${state.bucket || "n/a"})` : "n/a";
    const sourceTxt = state.visibleScoreSourceLabel || "Team Joseo score";
    const cityRankTxt = (state.citywideRank && state.citywideTotal) ? `#${state.citywideRank} / ${state.citywideTotal} citywide` : "— citywide";
    const boroughRankTxt = (state.boroughRank && state.boroughTotal) ? `#${state.boroughRank} / ${state.boroughTotal} in borough` : "— in borough";
    const dwellTxt = formatDwell(state.dwellMs);
    const tagsHtml = (state.tags || []).slice(0, 3).map((tag) => `<span class="aiAssistTag">${tag}</span>`).join("");

    host.innerHTML = `
      <div class="aiAssistBanner" data-phase="2" data-state="${state.actionState || "TRACKING"}">
        <div class="aiAssistHeadline">${state.actionHeadline || "AI Assistant"}</div>
        <div class="aiAssistMeta">Zone: ${zoneTxt}</div>
        <div class="aiAssistMeta">Borough: ${boroughTxt}</div>
        <div class="aiAssistMeta">Rating/Bucket: ${ratingTxt}</div>
        <div class="aiAssistMeta">Visible source: ${sourceTxt}</div>
        <div class="aiAssistMeta">${cityRankTxt}</div>
        <div class="aiAssistMeta">${boroughRankTxt}</div>
        <div class="aiAssistMeta">${dwellTxt}</div>
        ${tagsHtml ? `<div class="aiAssistTags">${tagsHtml}</div>` : ""}
        <div class="aiAssistMeta">${state.actionSubline || ""}</div>
        <div class="aiAssistFooter">Phase 2 active: current-zone intelligence</div>
      </div>
    `;
  }

  function clearNavDestination() {
    state.assistantMoveTarget = null;
    window.TlcMapUiModule?.setNavDestination?.(null);
  }

  function applyStatusOnly(status, headline, subline) {
    state.assistantStatus = status;
    state.actionState = status === "airport-excluded" ? "EXCLUDED" : "TRACKING";
    state.actionHeadline = headline;
    state.actionSubline = subline;
    state.actionSeverity = "neutral";
    state.tags = [];
  }

  function updateStableZone(now) {
    const loc = state.lastUserLocation;
    if (!loc || !Number.isFinite(loc.lng) || !Number.isFinite(loc.lat)) {
      applyStatusOnly("locating", "AI Assistant: locating current zone…", "Need a stable zone lock from location updates.");
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
      if (!state.activeStableZoneId) {
        applyStatusOnly("no-stable-zone", "AI Assistant: no stable zone yet", "Hold position briefly for stable zone detection.");
      }
      return;
    }

    const props = feature.properties || {};
    const zoneId = getZoneId(props);
    if (!zoneId) {
      applyStatusOnly("no-stable-zone", "AI Assistant: no stable zone yet", "Hold position briefly for stable zone detection.");
      return;
    }

    state.activeZoneLastSeenTs = now;

    if (state.candidateZoneId !== zoneId) {
      state.candidateZoneId = zoneId;
      state.candidateZoneFirstSeenTs = now;
      state.candidateZoneConsecutiveHits = 1;
      if (!state.activeStableZoneId) {
        applyStatusOnly("locating", "AI Assistant: locating current zone…", "Need a stable zone lock from location updates.");
      }
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

    if (!state.activeStableZoneId) {
      applyStatusOnly("locating", "AI Assistant: locating current zone…", "Need a stable zone lock from location updates.");
    }
  }

  function updateFromFrame(frame, now) {
    if (!frame) {
      state.lastFrameTime = null;
      applyStatusOnly("frame-unavailable", "AI Assistant: frame unavailable", "Waiting for score frame.");
      return;
    }
    state.lastFrameTime = now;
    if (!state.activeStableZoneId) return;

    const resolved = getActiveStableZoneFeature(frame);
    if (!resolved) {
      applyStatusOnly("frame-unavailable", "AI Assistant: frame unavailable for zone", "Waiting for active stable zone geometry.");
      return;
    }

    const signal = buildCurrentZoneSignalSnapshot(resolved.props, resolved.geom);
    const ranks = computeCurrentZoneDisplayedRanks(frame, state.activeStableZoneId, signal.borough || state.activeStableBorough || "");
    const classification = classifyCurrentZone(signal);
    const action = computeCurrentZoneAction(signal, classification);
    const tags = buildAssistantTags(classification);

    state.assistantStatus = signal.airportExcluded ? "airport-excluded" : "classified";
    state.activeStableZoneName = String(resolved.props.zone_name || "").trim() || state.activeStableZoneName || `Zone ${state.activeStableZoneId}`;
    state.activeStableBorough = signal.borough || state.activeStableBorough || "";
    state.visibleScoreSource = signal.visibleScoreSource;
    state.visibleScoreSourceLabel = signal.visibleScoreSourceLabel;
    state.rating = signal.rating;
    state.bucket = signal.bucket;
    state.airportExcluded = signal.airportExcluded;
    state.citywideRank = ranks.citywideRank;
    state.citywideTotal = ranks.citywideTotal;
    state.boroughRank = ranks.boroughRank;
    state.boroughTotal = ranks.boroughTotal;

    state.busyNow = signal.busyNow;
    state.busyNext = signal.busyNext;
    state.shortTripPenalty = signal.shortTripPenalty;
    state.longTripShareRaw = signal.longTripShareRaw;
    state.longTripShareN = signal.longTripShareN;
    state.balancedTripShareRaw = signal.balancedTripShareRaw;
    state.balancedTripShareN = signal.balancedTripShareN;
    state.sameZoneRetentionPenalty = signal.sameZoneRetentionPenalty;
    state.churnPressure = signal.churnPressure;
    state.downstreamValue = signal.downstreamValue;
    state.marketSaturationPenalty = signal.marketSaturationPenalty;
    state.manhattanCoreSaturationPenalty = signal.manhattanCoreSaturationPenalty;

    state.busyNowFlag = classification.busyNowFlag;
    state.slowNowFlag = classification.slowNowFlag;
    state.shortTripTrapFlag = classification.shortTripTrapFlag;
    state.longTripFriendlyFlag = classification.longTripFriendlyFlag;
    state.saturationCautionFlag = classification.saturationCautionFlag;
    state.goodContinuationFlag = classification.goodContinuationFlag;
    state.weakContinuationFlag = classification.weakContinuationFlag;
    state.zoneHealth = classification.zoneHealth;

    state.tags = tags;
    state.actionState = action.actionState;
    state.actionHeadline = action.actionHeadline;
    state.actionSubline = action.actionSubline;
    state.actionSeverity = action.actionSeverity;

    state.signalSnapshot = signal;
  }

  function getSnapshot() {
    const now = Date.now();
    const dwellMs = state.activeStableZoneEnterTs ? Math.max(0, now - state.activeStableZoneEnterTs) : 0;
    return {
      phase: 2,
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
      busyNow: state.busyNow,
      busyNext: state.busyNext,
      shortTripPenalty: state.shortTripPenalty,
      longTripShareRaw: state.longTripShareRaw,
      longTripShareN: state.longTripShareN,
      balancedTripShareRaw: state.balancedTripShareRaw,
      balancedTripShareN: state.balancedTripShareN,
      sameZoneRetentionPenalty: state.sameZoneRetentionPenalty,
      churnPressure: state.churnPressure,
      downstreamValue: state.downstreamValue,
      marketSaturationPenalty: state.marketSaturationPenalty,
      manhattanCoreSaturationPenalty: state.manhattanCoreSaturationPenalty,
      busyNowFlag: state.busyNowFlag,
      slowNowFlag: state.slowNowFlag,
      shortTripTrapFlag: state.shortTripTrapFlag,
      longTripFriendlyFlag: state.longTripFriendlyFlag,
      saturationCautionFlag: state.saturationCautionFlag,
      goodContinuationFlag: state.goodContinuationFlag,
      weakContinuationFlag: state.weakContinuationFlag,
      zoneHealth: state.zoneHealth,
      tags: Array.isArray(state.tags) ? [...state.tags] : [],
      actionState: state.actionState,
      actionHeadline: state.actionHeadline,
      actionSubline: state.actionSubline,
      actionSeverity: state.actionSeverity,
      assistantMoveTarget: null,
      assistantStatus: state.assistantStatus,
      ts: now,
    };
  }

  function refresh(frame) {
    const now = Date.now();
    updateStableZone(now);
    updateFromFrame(getFrame(frame), now);
    const dwellMs = state.activeStableZoneEnterTs ? Math.max(0, now - state.activeStableZoneEnterTs) : 0;
    state.dwellMs = dwellMs;
    state.dwellSeconds = Math.floor(dwellMs / 1000);
    state.dwellMinutesRounded = Math.round(dwellMs / 60000);
    clearNavDestination();

    const nextFingerprint = toFingerprint();
    if (nextFingerprint !== state.lastRenderFingerprint) {
      state.lastRenderFingerprint = nextFingerprint;
      renderBanner();
    }

    const snapshot = getSnapshot();
    window.dispatchEvent(new CustomEvent("tlc-ai-assistant-snapshot-updated", { detail: snapshot }));
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
      phase: 2,
      activeStableZoneId: null,
      activeStableZoneName: "",
      activeStableBorough: "",
      activeStableZoneEnterTs: null,
      activeStableZoneDwellMs: 0,
      candidateZoneId: null,
      candidateZoneFirstSeenTs: null,
      candidateZoneConsecutiveHits: 0,
      activeZoneLastSeenTs: null,
      lastFrameTime: null,
      assistantStatus: "idle",
      actionState: "TRACKING",
      actionHeadline: "AI Assistant: locating current zone…",
      actionSubline: "Waiting for location and frame.",
      actionSeverity: "neutral",
      assistantMoveTarget: null,
      visibleScoreSource: null,
      visibleScoreSourceLabel: null,
      rating: null,
      bucket: null,
      airportExcluded: false,
      citywideRank: null,
      citywideTotal: null,
      boroughRank: null,
      boroughTotal: null,
      busyNow: null,
      busyNext: null,
      shortTripPenalty: null,
      longTripShareRaw: null,
      longTripShareN: null,
      balancedTripShareRaw: null,
      balancedTripShareN: null,
      sameZoneRetentionPenalty: null,
      churnPressure: null,
      downstreamValue: null,
      marketSaturationPenalty: null,
      manhattanCoreSaturationPenalty: null,
      busyNowFlag: false,
      slowNowFlag: false,
      shortTripTrapFlag: false,
      longTripFriendlyFlag: false,
      saturationCautionFlag: false,
      goodContinuationFlag: false,
      weakContinuationFlag: false,
      zoneHealth: "mixed",
      tags: [],
      dwellMs: 0,
      dwellSeconds: 0,
      dwellMinutesRounded: 0,
      signalSnapshot: null,
      lastRenderFingerprint: "",
    });
    clearNavDestination();
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
