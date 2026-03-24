(function() {
  const core = window.TlcZoneLabelInternals || {};

  const ZONE_EDGE_CUE_MIN_ZOOM = 12.2;
  const ZONE_EDGE_CUE_SOURCE_ID = "zone-edge-cue";
  const ZONE_EDGE_CUE_BASE_LAYER_ID = "zone-edge-cue-base";
  const ZONE_EDGE_CUE_INNER_LAYER_ID = "zone-edge-cue-inner";
  const ZONE_EDGE_CUE_MIN_RATING_DIFF = 6;
  const ZONE_EDGE_CUE_MAX_RATING_DIFF = 30;
  const ZONE_EDGE_CUE_KEY_DP = 5;
  const ZONE_EDGE_CUE_MATCH_DP = 5;
  const ZONE_EDGE_CUE_MAX_FEATURES = 160;

  let edgeCueAdjacencyCache = [];
  let edgeCueTopologySignature = "";
  let edgeCueInputSignature = "";
  let edgeCueCachedFc = { type: "FeatureCollection", features: [] };
  let edgeCuePendingFrame = null;
  let edgeCueRefreshHandle = 0;
  let edgeCueFeatureCount = 0;
  let edgeCueBuildStats = {
    adjacencyPairs: 0,
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
    const values = Array.isArray(zoneIds) ? zoneIds : [];
    for (const value of values) {
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
      if (!Array.isArray(a) || !Array.isArray(b)) continue;
      const ax = Number(a[0]);
      const ay = Number(a[1]);
      const bx = Number(b[0]);
      const by = Number(b[1]);
      if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) continue;
      area += (ax * by) - (bx * ay);
    }
    return area / 2;
  }

  function forEachOuterRing(feature, cb) {
    const geom = feature?.geometry;
    if (!geom || typeof cb !== "function") return;

    if (geom.type === "Polygon") {
      const ring = Array.isArray(geom.coordinates) ? geom.coordinates[0] : null;
      if (Array.isArray(ring)) cb(ring);
      return;
    }

    if (geom.type === "MultiPolygon") {
      const polys = Array.isArray(geom.coordinates) ? geom.coordinates : [];
      for (const poly of polys) {
        const ring = Array.isArray(poly) ? poly[0] : null;
        if (Array.isArray(ring)) cb(ring);
      }
    }
  }

  function edgeCoordKey(coord) {
    const x = Number(coord?.[0]);
    const y = Number(coord?.[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return "";
    return `${x.toFixed(ZONE_EDGE_CUE_MATCH_DP)}|${y.toFixed(ZONE_EDGE_CUE_MATCH_DP)}`;
  }

  function normalizeSegmentKey(a, b) {
    const ak = edgeCoordKey(a);
    const bk = edgeCoordKey(b);
    if (!ak || !bk) return "";
    const lo = ak < bk ? ak : bk;
    const hi = ak < bk ? bk : ak;
    return `${lo}__${hi}`;
  }

  function segmentFingerprint(coords) {
    const a = Array.isArray(coords?.[0])
      ? `${Number(coords[0][0]).toFixed(ZONE_EDGE_CUE_KEY_DP)}|${Number(coords[0][1]).toFixed(ZONE_EDGE_CUE_KEY_DP)}`
      : "";
    const b = Array.isArray(coords?.[1])
      ? `${Number(coords[1][0]).toFixed(ZONE_EDGE_CUE_KEY_DP)}|${Number(coords[1][1]).toFixed(ZONE_EDGE_CUE_KEY_DP)}`
      : "";
    return `${a}__${b}`;
  }

  function buildZoneEdgeAdjacency(frame) {
    const features = frame?.polygons?.features || [];
    const segmentMap = new Map();

    for (const feature of features) {
      const zoneId = String(feature?.properties?.LocationID ?? "");
      if (!zoneId) continue;

      forEachOuterRing(feature, (ring) => {
        if (!Array.isArray(ring) || ring.length < 2) return;
        const interiorSide = ringSignedArea(ring) > 0 ? "left" : "right";

        for (let i = 1; i < ring.length; i++) {
          const startCoord = ring[i - 1];
          const endCoord = ring[i];
          if (!Array.isArray(startCoord) || !Array.isArray(endCoord)) continue;
          const key = normalizeSegmentKey(startCoord, endCoord);
          if (!key) continue;
          const list = segmentMap.get(key) || [];
          list.push({
            zoneId,
            coords: [startCoord, endCoord],
            interiorSide,
          });
          segmentMap.set(key, list);
        }
      });
    }

    const pairMap = new Map();

    for (const [, occurrences] of segmentMap.entries()) {
      if (!Array.isArray(occurrences) || occurrences.length < 2) continue;

      const byZone = new Map();
      for (const occ of occurrences) {
        if (!occ?.zoneId) continue;
        if (!byZone.has(occ.zoneId)) byZone.set(occ.zoneId, occ);
      }
      if (byZone.size !== 2) continue;

      const [aZoneId, bZoneId] = Array.from(byZone.keys()).sort();
      const aOcc = byZone.get(aZoneId);
      const bOcc = byZone.get(bZoneId);
      if (!aOcc || !bOcc) continue;

      const pairKey = `${aZoneId}|${bZoneId}`;
      const entry = pairMap.get(pairKey) || {
        aZoneId,
        bZoneId,
        segments: [],
      };
      entry.segments.push({
        aCoords: aOcc.coords,
        bCoords: bOcc.coords,
        aInteriorSide: aOcc.interiorSide,
        bInteriorSide: bOcc.interiorSide,
      });
      pairMap.set(pairKey, entry);
    }

    return Array.from(pairMap.values()).map((entry) => {
      const seen = new Set();
      const segments = [];
      for (const seg of entry.segments || []) {
        const fp = `${segmentFingerprint(seg.aCoords)}@@${segmentFingerprint(seg.bCoords)}`;
        if (seen.has(fp)) continue;
        seen.add(fp);
        segments.push(seg);
      }
      return {
        aZoneId: entry.aZoneId,
        bZoneId: entry.bZoneId,
        segments,
      };
    });
  }

  function getZoneTopologySignature(frame) {
    const features = frame?.polygons?.features || [];
    return features
      .map((feature) => {
        const props = feature?.properties || {};
        const id = String(props.LocationID ?? "");
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

  function orientSegmentIntoZoneInterior(coords, interiorSide) {
    if (!Array.isArray(coords) || coords.length < 2) return coords;
    if (interiorSide === "right") return coords;
    return [coords[1], coords[0]];
  }

  function buildZoneEdgeCueFeatureCollection(frame) {
    const adjacency = getZoneEdgeAdjacency(frame);
    edgeCueBuildStats = {
      adjacencyPairs: Array.isArray(adjacency) ? adjacency.length : 0,
      builtFeatures: 0,
      skippedMissingRating: 0,
      skippedMinDiff: 0,
      skippedShielded: 0,
    };

    const features = frame?.polygons?.features || [];
    const zoneFeatureMap = new Map();
    for (const feature of features) {
      const zoneId = String(feature?.properties?.LocationID ?? "");
      if (zoneId) zoneFeatureMap.set(zoneId, feature);
    }

    const out = [];

    for (const pair of adjacency) {
      const featureA = zoneFeatureMap.get(pair.aZoneId);
      const featureB = zoneFeatureMap.get(pair.bZoneId);
      if (!featureA || !featureB) continue;

      const ratingA = getFeatureEffectiveRatingForEdge(featureA);
      const ratingB = getFeatureEffectiveRatingForEdge(featureB);

      if (!Number.isFinite(ratingA) || !Number.isFinite(ratingB)) {
        edgeCueBuildStats.skippedMissingRating += 1;
        continue;
      }

      const diff = Math.abs(ratingA - ratingB);
      if (diff < ZONE_EDGE_CUE_MIN_RATING_DIFF) {
        edgeCueBuildStats.skippedMinDiff += 1;
        continue;
      }

      if (ratingA === ratingB) continue;

      const aIsStronger = ratingA > ratingB;
      const strongerZoneId = aIsStronger ? pair.aZoneId : pair.bZoneId;
      const weakerZoneId = aIsStronger ? pair.bZoneId : pair.aZoneId;

      if (isPickupHotspotShieldedZone(strongerZoneId)) {
        edgeCueBuildStats.skippedShielded += 1;
        continue;
      }

      const weakerFeature = aIsStronger ? featureB : featureA;

      const edgeStrength = clamp01(
        (diff - ZONE_EDGE_CUE_MIN_RATING_DIFF) /
        (ZONE_EDGE_CUE_MAX_RATING_DIFF - ZONE_EDGE_CUE_MIN_RATING_DIFF)
      );

      const baseWidthPx = 2.2 + (edgeStrength * 1.0);
      const innerWidthPx = 4.8 + (edgeStrength * 1.8);
      const baseOpacity = 0.16 + (edgeStrength * 0.05);
      const innerOpacity = 0.13 + (edgeStrength * 0.08);
      const innerOffsetPx = 0.9 + (edgeStrength * 0.8);

      for (const segment of pair.segments || []) {
        const strongerCoords = aIsStronger ? segment.aCoords : segment.bCoords;
        const strongerInteriorSide = aIsStronger ? segment.aInteriorSide : segment.bInteriorSide;
        const oriented = orientSegmentIntoZoneInterior(strongerCoords, strongerInteriorSide);
        if (!Array.isArray(oriented) || oriented.length < 2) continue;

        out.push({
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: oriented,
          },
          properties: {
            edge_color: getFeatureBaseColorForEdge(weakerFeature),
            strong_zone_id: strongerZoneId,
            weak_zone_id: weakerZoneId,
            rating_diff: diff,
            edge_strength: edgeStrength,
            base_width_px: baseWidthPx,
            inner_width_px: innerWidthPx,
            base_opacity: baseOpacity,
            inner_opacity: innerOpacity,
            inner_offset_px: innerOffsetPx,
          },
        });
      }
    }

    out.sort((a, b) => Number(b?.properties?.rating_diff || 0) - Number(a?.properties?.rating_diff || 0));
    const featuresOut = out.slice(0, ZONE_EDGE_CUE_MAX_FEATURES);
    edgeCueBuildStats.builtFeatures = featuresOut.length;

    return {
      type: "FeatureCollection",
      features: featuresOut,
    };
  }

  function getZoneEdgeCueInputSignature(frame) {
    const topologySignature = getZoneTopologySignature(frame);
    syncPickupHotspotShieldZoneIdsFromSource();

    const features = frame?.polygons?.features || [];
    const hotspotSig = Array.from(pickupHotspotShieldZoneIds || []).sort().join(",");
    const rows = [];

    for (const feature of features) {
      const zoneId = String(feature?.properties?.LocationID ?? "");
      if (!zoneId) continue;

      const rating = getFeatureEffectiveRatingForEdge(feature);
      const color = String(getFeatureBaseColorForEdge(feature) || "");
      rows.push(`${zoneId}|${Number.isFinite(rating) ? rating.toFixed(2) : "nan"}|${color}`);
    }

    rows.sort();
    return `${topologySignature}@@${hotspotSig}@@${rows.join("###")}`;
  }

  function getCachedZoneEdgeCueFeatureCollection(frame) {
    const inputSignature = getZoneEdgeCueInputSignature(frame);
    if (inputSignature === edgeCueInputSignature && edgeCueCachedFc) {
      return edgeCueCachedFc;
    }

    const nextFc = buildZoneEdgeCueFeatureCollection(frame);
    edgeCueInputSignature = inputSignature;
    edgeCueCachedFc = nextFc;
    return nextFc;
  }

  function clearZoneEdgeCueSource() {
    const map = core.getMap?.();
    const edgeSrc = map?.getSource?.(ZONE_EDGE_CUE_SOURCE_ID);
    if (edgeSrc) {
      edgeSrc.setData(core.emptyGeojson?.() || { type: "FeatureCollection", features: [] });
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

    [
      "zone-edge-influence-halo",
      "zone-edge-influence-soft",
      "zone-edge-influence-core",
      "zone-edge-influence-seed",
    ].forEach((id) => {
      if (map.getLayer(id)) map.removeLayer(id);
    });

    if (!map.getLayer(ZONE_EDGE_CUE_BASE_LAYER_ID)) {
      map.addLayer({
        id: ZONE_EDGE_CUE_BASE_LAYER_ID,
        type: "line",
        source: ZONE_EDGE_CUE_SOURCE_ID,
        minzoom: ZONE_EDGE_CUE_MIN_ZOOM,
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
        paint: {
          "line-color": ["coalesce", ["to-string", ["get", "edge_color"]], "#ffffff"],
          "line-opacity": ["coalesce", ["to-number", ["get", "base_opacity"]], 0.16],
          "line-width": [
            "*",
            ["coalesce", ["to-number", ["get", "base_width_px"]], 2.2],
            ["interpolate", ["linear"], ["zoom"], 12, 0.9, 14, 1.0, 16, 1.08]
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
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
        paint: {
          "line-color": ["coalesce", ["to-string", ["get", "edge_color"]], "#ffffff"],
          "line-opacity": ["coalesce", ["to-number", ["get", "inner_opacity"]], 0.13],
          "line-width": [
            "*",
            ["coalesce", ["to-number", ["get", "inner_width_px"]], 4.8],
            ["interpolate", ["linear"], ["zoom"], 12, 0.9, 14, 1.0, 16, 1.08]
          ],
          "line-blur": 0.55,
          "line-offset": [
            "*",
            ["coalesce", ["to-number", ["get", "inner_offset_px"]], 0.9],
            ["interpolate", ["linear"], ["zoom"], 12, 0.9, 14, 1.0, 16, 1.08]
          ]
        }
      }, "zones-line");
    }

    return true;
  }

  async function refreshZoneEdgeCue(frame) {
    const map = core.getMap?.();
    const mapReady = core.isMapReady?.();
    if (!map || !mapReady) return;

    await ensureZoneEdgeCueSourceAndLayers();

    const edgeSrc = map.getSource(ZONE_EDGE_CUE_SOURCE_ID);
    if (!edgeSrc) return;
    if (!frame) return;

    const edgeFc = getCachedZoneEdgeCueFeatureCollection(frame);
    edgeCueFeatureCount = Array.isArray(edgeFc?.features) ? edgeFc.features.length : 0;
    edgeSrc.setData(edgeFc);
  }

  function scheduleZoneEdgeCueRefresh(frame = null) {
    edgeCuePendingFrame =
      frame ||
      edgeCuePendingFrame ||
      window.TlcCommunityInternals?.getCurrentFrame?.() ||
      window.TlcModeInternals?.getCurrentFrame?.() ||
      null;

    if (edgeCueRefreshHandle) return;

    const runner = () => {
      edgeCueRefreshHandle = 0;
      const nextFrame = edgeCuePendingFrame;
      edgeCuePendingFrame = null;
      if (!nextFrame) return;
      refreshZoneEdgeCue(nextFrame);
    };

    if (typeof window.requestAnimationFrame === "function") {
      edgeCueRefreshHandle = window.requestAnimationFrame(runner);
    } else {
      edgeCueRefreshHandle = window.setTimeout(runner, 16);
    }
  }

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    syncPickupHotspotShieldZoneIdsFromSource();

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
      topologySignature: edgeCueTopologySignature || "",
      inputSignature: edgeCueInputSignature || "",
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
