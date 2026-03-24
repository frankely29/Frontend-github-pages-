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
  const ZONE_EDGE_CUE_MAX_PATHS = 240;

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
