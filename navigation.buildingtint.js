(function () {
  const PREVIEW_CASING_LAYER_ID = "tlc-nav-preview-casing";
  const PREVIEW_LINE_LAYER_ID = "tlc-nav-preview-line";
  const BUILDING_TINT_SOURCE_ID = "tlc-nav-building-tint-source";
  const BUILDING_TINT_LAYER_ID = "tlc-nav-building-tint-layer";
  const EXPLICIT_HOTSPOT_FILL_IDS = ["zones-fill"];
  const REFRESH_THROTTLE_MS = 700;
  const MIN_BUILDING_TINT_FEATURES_FOR_SUPPRESSION = 8;

  const state = {
    map: null,
    active: false,
    supported: false,
    fallbackModeUsed: false,
    buildingSourceId: null,
    buildingSourceLayer: null,
    blockSourceLayer: null,
    buildingLayerAnchorId: null,
    hotspotSourceId: null,
    hotspotFillLayerIds: [],
    hotspotOutlineLayerIds: [],
    hotspotSourceLayerIds: [],
    hotspotFeatureSnapshot: [],
    roadLayerIds: [],
    streetLabelLayerIds: [],
    blockSurfaceLayerIds: [],
    originalLayerOrder: null,
    originalPaint: new Map(),
    buildingTintSourceId: BUILDING_TINT_SOURCE_ID,
    buildingTintLayerId: BUILDING_TINT_LAYER_ID,
    lastViewportKey: "",
    lastRefreshAt: 0,
    refreshInFlight: false,
    buildingTintFeatureCount: 0,
    zoneFillSuppressed: false,
    usingVectorOverlayGeometry: false,
  };

  function getStyleLayers() {
    const layers = state.map?.getStyle?.()?.layers;
    return Array.isArray(layers) ? layers : [];
  }

  function hasLayer(layerId) {
    return !!state.map?.getLayer?.(layerId);
  }

  function hasSource(sourceId) {
    return !!state.map?.getSource?.(sourceId);
  }

  function readLayerTokens(layer) {
    return [
      layer?.id,
      layer?.source,
      layer?.["source-layer"],
      layer?.metadata?.["mapbox:group"],
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  function isRoadLayer(layer) {
    if (!layer || layer.type !== "line") return false;
    return /(road|street|motorway|highway|primary|secondary|tertiary|bridge|tunnel)/.test(readLayerTokens(layer));
  }

  function isStreetLabelLayer(layer) {
    if (!layer || layer.type !== "symbol") return false;
    const tokens = readLayerTokens(layer);
    return /(road|street|motorway|highway)/.test(tokens) && /(label|name|ref|shield)/.test(tokens);
  }

  function isHotspotFillLayer(layer, hotspotSourceId) {
    if (!layer || layer.type !== "fill") return false;
    if (EXPLICIT_HOTSPOT_FILL_IDS.includes(layer.id)) return true;
    const tokens = readLayerTokens(layer);
    if (/(zone|hotspot)/.test(tokens)) return true;
    return !!(hotspotSourceId && layer.source === hotspotSourceId);
  }


  function isHotspotOutlineLayer(layer, hotspotSourceId) {
    if (!layer || layer.type !== "line") return false;
    const tokens = readLayerTokens(layer);
    if (/(zone|hotspot)/.test(tokens) && /(outline|border|stroke|line)/.test(tokens)) return true;
    return !!(hotspotSourceId && layer.source === hotspotSourceId && /(zone|hotspot)/.test(tokens));
  }

  function detectStyleDependencies() {
    const layers = getStyleLayers();
    const buildingCandidates = [];
    const roadLayerIds = [];
    const streetLabelLayerIds = [];

    let hotspotSourceId = hasLayer("zones-fill") ? (state.map.getLayer("zones-fill")?.source || null) : null;
    const hotspotFillLayerIds = [];
    const hotspotOutlineLayerIds = [];
    const hotspotSourceLayerIds = new Set();

    layers.forEach((layer) => {
      if (!layer?.id) return;
      const tokens = readLayerTokens(layer);
      if ((layer.type === "fill" || layer.type === "fill-extrusion") && /(building|buildings|structure)/.test(tokens)) {
        buildingCandidates.push(layer);
      }
      if (isRoadLayer(layer)) roadLayerIds.push(layer.id);
      if (isStreetLabelLayer(layer)) streetLabelLayerIds.push(layer.id);
      if (isHotspotFillLayer(layer, hotspotSourceId)) {
        hotspotFillLayerIds.push(layer.id);
        hotspotSourceId = hotspotSourceId || layer.source || null;
        if (layer["source-layer"]) hotspotSourceLayerIds.add(layer["source-layer"]);
      }
      if (isHotspotOutlineLayer(layer, hotspotSourceId)) {
        hotspotOutlineLayerIds.push(layer.id);
        if (layer["source-layer"]) hotspotSourceLayerIds.add(layer["source-layer"]);
      }
    });

    EXPLICIT_HOTSPOT_FILL_IDS.forEach((layerId) => {
      if (hasLayer(layerId) && !hotspotFillLayerIds.includes(layerId)) hotspotFillLayerIds.push(layerId);
    });

    const preferredBuilding = buildingCandidates.find((layer) => layer.type === "fill")
      || buildingCandidates.find((layer) => layer.type === "fill-extrusion")
      || null;
    const vectorBuildingConfig = window.TlcNavigationVectorBasemapModule?.getBuildingQueryConfig?.() || null;

    state.buildingSourceId = vectorBuildingConfig?.sourceId || preferredBuilding?.source || null;
    state.buildingSourceLayer = vectorBuildingConfig?.sourceLayer || preferredBuilding?.["source-layer"] || null;
    state.blockSourceLayer = vectorBuildingConfig?.blockSourceLayer || "landuse";
    state.buildingLayerAnchorId = vectorBuildingConfig?.buildingLayerIds?.[0] || preferredBuilding?.id || null;
    state.hotspotSourceId = hotspotSourceId;
    state.hotspotFillLayerIds = hotspotFillLayerIds;
    state.hotspotOutlineLayerIds = hotspotOutlineLayerIds;
    state.hotspotSourceLayerIds = Array.from(hotspotSourceLayerIds);
    state.roadLayerIds = vectorBuildingConfig?.roadLayerIds?.length ? vectorBuildingConfig.roadLayerIds.slice() : roadLayerIds;
    state.streetLabelLayerIds = vectorBuildingConfig?.roadLabelLayerIds?.length ? vectorBuildingConfig.roadLabelLayerIds.slice() : streetLabelLayerIds;
    state.blockSurfaceLayerIds = vectorBuildingConfig?.blockSurfaceLayerIds?.length ? vectorBuildingConfig.blockSurfaceLayerIds.slice() : [];
    state.usingVectorOverlayGeometry = !!(vectorBuildingConfig?.sourceId && vectorBuildingConfig?.buildingLayerIds?.length);
    state.supported = !!(state.buildingSourceId && state.buildingSourceLayer);
    state.fallbackModeUsed = !state.supported;
  }

  function rememberLayerOrder() {
    if (Array.isArray(state.originalLayerOrder) && state.originalLayerOrder.length) return;
    state.originalLayerOrder = getStyleLayers().map((layer) => layer?.id).filter(Boolean);
  }

  function cachePaint(layerId, prop) {
    const key = `${layerId}:${prop}`;
    if (state.originalPaint.has(key) || !hasLayer(layerId)) return;
    state.originalPaint.set(key, state.map.getPaintProperty(layerId, prop));
  }

  function setPaint(layerId, prop, value) {
    if (!hasLayer(layerId)) return;
    cachePaint(layerId, prop);
    state.map.setPaintProperty(layerId, prop, value);
  }

  function restorePaint() {
    Array.from(state.originalPaint.entries()).forEach(([key, value]) => {
      const [layerId, prop] = key.split(":");
      if (!hasLayer(layerId)) return;
      state.map.setPaintProperty(layerId, prop, value == null ? null : value);
    });
    state.originalPaint.clear();
  }

  function restoreLayerOrder() {
    const original = Array.isArray(state.originalLayerOrder) ? state.originalLayerOrder : [];
    if (!original.length) return;
    for (let i = original.length - 1; i >= 0; i -= 1) {
      const layerId = original[i];
      if (!hasLayer(layerId)) continue;
      let beforeId;
      for (let j = i + 1; j < original.length; j += 1) {
        const next = original[j];
        if (hasLayer(next)) {
          beforeId = next;
          break;
        }
      }
      state.map.moveLayer(layerId, beforeId || undefined);
    }
    state.originalLayerOrder = null;
  }


  function restorePaintKeys(keys) {
    keys.forEach((key) => {
      const value = state.originalPaint.get(key);
      if (typeof value === "undefined") return;
      const sep = key.indexOf(":");
      const layerId = key.slice(0, sep);
      const prop = key.slice(sep + 1);
      if (!hasLayer(layerId)) return;
      state.map.setPaintProperty(layerId, prop, value == null ? null : value);
      state.originalPaint.delete(key);
    });
  }

  function getViewportKey() {
    if (!state.map) return "";
    const center = state.map.getCenter?.();
    const zoom = Number(state.map.getZoom?.() || 0).toFixed(2);
    const bearing = Number(state.map.getBearing?.() || 0).toFixed(1);
    if (!center) return `${zoom}:${bearing}`;
    return `${center.lng.toFixed(3)}:${center.lat.toFixed(3)}:${zoom}:${bearing}`;
  }

  function ensureBuildingTintLayer() {
    if (!state.map?.getStyle?.()) return false;

    if (!hasSource(state.buildingTintSourceId)) {
      state.map.addSource(state.buildingTintSourceId, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }

    if (!hasLayer(state.buildingTintLayerId)) {
      const firstRoad = state.roadLayerIds.find((id) => hasLayer(id));
      state.map.addLayer({
        id: state.buildingTintLayerId,
        type: "fill",
        source: state.buildingTintSourceId,
        paint: {
          "fill-color": ["coalesce", ["get", "hotspotColor"], "rgba(59,130,246,0.35)"],
          "fill-opacity": ["coalesce", ["get", "hotspotOpacity"], 0.34],
          "fill-outline-color": "rgba(255,255,255,0.12)",
        },
      }, firstRoad || undefined);
    }

    return true;
  }

  function clearBuildingTintData() {
    const source = state.map?.getSource?.(state.buildingTintSourceId);
    if (source?.setData) {
      source.setData({ type: "FeatureCollection", features: [] });
    }
    state.buildingTintFeatureCount = 0;
    state.hotspotFeatureSnapshot = [];
    state.zoneFillSuppressed = false;
  }

  function extractColorFromFeature(feature) {
    const props = feature?.properties || {};
    return String(
      props.zoneColor
      || props.color
      || props.fill
      || props.fillColor
      || props.hex
      || props.hotspotColor
      || ""
    ).trim();
  }

  function getHotspotBucket(feature) {
    const p = feature?.properties || {};
    return p.bucket || p.zoneBucket || p.ratingBucket || null;
  }

  function getHotspotRating(feature) {
    const p = feature?.properties || {};
    const rating = Number(p.rating ?? p.score ?? p.hotspotRating ?? p.teamJoseoScore);
    return Number.isFinite(rating) ? rating : null;
  }

  function normalizePolygonCoordinates(geometry) {
    if (!geometry?.type || !geometry?.coordinates) return [];
    if (geometry.type === "Polygon") return [geometry.coordinates];
    if (geometry.type === "MultiPolygon") return geometry.coordinates;
    return [];
  }

  function pointInRing(point, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = Number(ring[i][0]);
      const yi = Number(ring[i][1]);
      const xj = Number(ring[j][0]);
      const yj = Number(ring[j][1]);
      const intersects = ((yi > point[1]) !== (yj > point[1]))
        && (point[0] < ((xj - xi) * (point[1] - yi)) / ((yj - yi) || Number.EPSILON) + xi);
      if (intersects) inside = !inside;
    }
    return inside;
  }

  function pointInPolygon(point, geometry) {
    const polygons = normalizePolygonCoordinates(geometry);
    for (const polygon of polygons) {
      const outer = polygon?.[0];
      if (!Array.isArray(outer) || !outer.length) continue;
      if (!pointInRing(point, outer)) continue;
      let inHole = false;
      for (let i = 1; i < polygon.length; i += 1) {
        if (pointInRing(point, polygon[i])) {
          inHole = true;
          break;
        }
      }
      if (!inHole) return true;
    }
    return false;
  }

  function representativePoint(feature) {
    const geometry = feature?.geometry;
    const polygons = normalizePolygonCoordinates(geometry);
    if (!polygons.length) return null;
    const ring = polygons[0]?.[0];
    if (!Array.isArray(ring) || ring.length < 3) return null;

    let area = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const x0 = Number(ring[j][0]);
      const y0 = Number(ring[j][1]);
      const x1 = Number(ring[i][0]);
      const y1 = Number(ring[i][1]);
      const f = x0 * y1 - x1 * y0;
      area += f;
      cx += (x0 + x1) * f;
      cy += (y0 + y1) * f;
    }

    if (Math.abs(area) > 1e-8) {
      const denom = area * 3;
      return [cx / denom, cy / denom];
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    ring.forEach((coord) => {
      const x = Number(coord[0]);
      const y = Number(coord[1]);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    });
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
    return [(minX + maxX) / 2, (minY + maxY) / 2];
  }

  function featureHash(feature) {
    if (!feature) return "";
    if (feature.id != null) return String(feature.id);
    const g = feature.geometry;
    return `${g?.type || "g"}:${JSON.stringify(g?.coordinates || []).slice(0, 400)}`;
  }

  function featureIntersectsViewport(feature) {
    const bounds = state.map?.getBounds?.();
    if (!bounds) return true;
    const polygons = normalizePolygonCoordinates(feature?.geometry);
    if (!polygons.length) return false;
    for (const polygon of polygons) {
      const ring = polygon?.[0] || [];
      for (const coord of ring) {
        const lng = Number(coord[0]);
        const lat = Number(coord[1]);
        if (bounds.contains([lng, lat])) return true;
      }
    }
    const c = representativePoint(feature);
    return !!(c && bounds.contains([c[0], c[1]]));
  }

  function getHotspotFeaturesFromSource() {
    if (!state.hotspotSourceId || !state.map?.querySourceFeatures) return [];
    const sourceLayers = state.hotspotSourceLayerIds.filter(Boolean);
    try {
      if (sourceLayers.length) {
        const acc = [];
        sourceLayers.forEach((sourceLayer) => {
          const features = state.map.querySourceFeatures(state.hotspotSourceId, { sourceLayer }) || [];
          acc.push(...features);
        });
        return acc;
      }
      return state.map.querySourceFeatures(state.hotspotSourceId) || [];
    } catch (_err) {
      return [];
    }
  }

  function getHotspotFeaturesFromRenderedLayers() {
    const layerIds = state.hotspotFillLayerIds.filter((id) => hasLayer(id));
    if (!layerIds.length) return [];
    try {
      return state.map.queryRenderedFeatures(undefined, { layers: layerIds }) || [];
    } catch (_err) {
      return [];
    }
  }

  function getActiveHotspotFeatures() {
    const sourceFeatures = getHotspotFeaturesFromSource();
    if (sourceFeatures.length) {
      state.hotspotFeatureSnapshot = sourceFeatures;
      return sourceFeatures;
    }

    if (Array.isArray(state.hotspotFeatureSnapshot) && state.hotspotFeatureSnapshot.length) {
      return state.hotspotFeatureSnapshot;
    }

    const rendered = getHotspotFeaturesFromRenderedLayers();
    if (rendered.length) state.hotspotFeatureSnapshot = rendered;
    return rendered;
  }

  function suppressZoneFillForNavigation() {
    state.hotspotFillLayerIds.forEach((layerId) => {
      if (!hasLayer(layerId)) return;
      setPaint(layerId, "fill-opacity", 0);
    });
    state.hotspotOutlineLayerIds.forEach((layerId) => {
      if (!hasLayer(layerId)) return;
      setPaint(layerId, "line-opacity", 0);
    });
    state.zoneFillSuppressed = true;
  }

  function restoreZoneFillAfterNavigationSuppression() {
    const keys = [];
    state.hotspotFillLayerIds.forEach((layerId) => keys.push(`${layerId}:fill-opacity`));
    state.hotspotOutlineLayerIds.forEach((layerId) => keys.push(`${layerId}:line-opacity`));
    restorePaintKeys(keys);
    state.zoneFillSuppressed = false;
  }

  function assignHotspot(buildingPoint, hotspotFeatures) {
    for (const hotspot of hotspotFeatures) {
      if (!pointInPolygon(buildingPoint, hotspot?.geometry)) continue;
      const color = extractColorFromFeature(hotspot);
      if (!color) return null;
      return {
        color,
        bucket: getHotspotBucket(hotspot),
        rating: getHotspotRating(hotspot),
      };
    }
    return null;
  }

  function buildTintFeature(buildingFeature, hotspotMeta) {
    return {
      type: "Feature",
      geometry: buildingFeature.geometry,
      properties: {
        hotspotColor: hotspotMeta.color,
        hotspotBucket: hotspotMeta.bucket,
        hotspotRating: hotspotMeta.rating,
        hotspotOpacity: 0.42,
      },
    };
  }

  function getCarrierQueryConfig() {
    const zoom = Number(state.map?.getZoom?.() || 0);
    if (zoom >= 16 || !state.blockSourceLayer) {
      return { sourceLayer: state.buildingSourceLayer, opacity: 0.44, mode: "building" };
    }
    return { sourceLayer: state.blockSourceLayer, opacity: 0.30, mode: "block" };
  }

  function moveLayersForNavigationReadability() {
    if (hasLayer(state.buildingTintLayerId)) {
      const roadAnchor = state.roadLayerIds.find((id) => hasLayer(id))
        || state.streetLabelLayerIds.find((id) => hasLayer(id));
      if (roadAnchor && state.buildingTintLayerId !== roadAnchor) {
        state.map.moveLayer(state.buildingTintLayerId, roadAnchor);
      }
    }

    state.roadLayerIds.forEach((id) => {
      if (hasLayer(id)) state.map.moveLayer(id);
    });
    state.streetLabelLayerIds.forEach((id) => {
      if (hasLayer(id)) state.map.moveLayer(id);
    });

    if (hasLayer(PREVIEW_CASING_LAYER_ID)) state.map.moveLayer(PREVIEW_CASING_LAYER_ID);
    if (hasLayer(PREVIEW_LINE_LAYER_ID)) state.map.moveLayer(PREVIEW_LINE_LAYER_ID);
  }

  function refreshForViewport(force = false) {
    if (!state.active || !state.supported || !state.map?.getStyle?.()) return false;
    const now = Date.now();
    const viewportKey = getViewportKey();

    if (!force) {
      if (state.refreshInFlight) return false;
      if (viewportKey === state.lastViewportKey && (now - Number(state.lastRefreshAt || 0)) < REFRESH_THROTTLE_MS) return false;
      if ((now - Number(state.lastRefreshAt || 0)) < REFRESH_THROTTLE_MS) return false;
    }

    state.refreshInFlight = true;
    try {
      const carrier = getCarrierQueryConfig();
      const queryOptions = carrier?.sourceLayer ? { sourceLayer: carrier.sourceLayer } : undefined;
      const rawBuildings = state.map.querySourceFeatures(state.buildingSourceId, queryOptions) || [];

      const hotspotFeatures = getActiveHotspotFeatures();
      if (!hotspotFeatures.length) {
        state.fallbackModeUsed = true;
        clearBuildingTintData();
        restoreZoneFillAfterNavigationSuppression();
        window.TlcNavigationStreetModeModule?.activate?.();
        return false;
      }

      const deduped = new Map();
      rawBuildings.forEach((feature) => {
        if (!feature || !feature.geometry) return;
        if (!featureIntersectsViewport(feature)) return;
        const key = featureHash(feature);
        if (!key || deduped.has(key)) return;
        deduped.set(key, feature);
      });

      const tintedFeatures = [];
      deduped.forEach((buildingFeature) => {
        const point = representativePoint(buildingFeature);
        if (!point) return;
        const hotspotMeta = assignHotspot(point, hotspotFeatures);
        if (!hotspotMeta?.color) return;
        const tintFeature = buildTintFeature(buildingFeature, hotspotMeta);
        tintFeature.properties.hotspotOpacity = carrier?.opacity ?? 0.42;
        tintedFeatures.push(tintFeature);
      });

      const source = state.map.getSource(state.buildingTintSourceId);
      if (source?.setData) {
        source.setData({
          type: "FeatureCollection",
          features: tintedFeatures,
        });
        state.buildingTintFeatureCount = tintedFeatures.length;
      }

      state.lastViewportKey = viewportKey;
      state.lastRefreshAt = now;

      const minFeaturesForSuppression = state.usingVectorOverlayGeometry ? 1 : MIN_BUILDING_TINT_FEATURES_FOR_SUPPRESSION;
      if (state.buildingTintFeatureCount >= minFeaturesForSuppression && state.usingVectorOverlayGeometry) {
        state.fallbackModeUsed = false;
        window.TlcNavigationStreetModeModule?.deactivate?.();
        suppressZoneFillForNavigation();
      } else {
        state.fallbackModeUsed = true;
        restoreZoneFillAfterNavigationSuppression();
        window.TlcNavigationStreetModeModule?.activate?.();
      }

      moveLayersForNavigationReadability();
      return true;
    } catch (_err) {
      state.fallbackModeUsed = true;
      restoreZoneFillAfterNavigationSuppression();
      window.TlcNavigationStreetModeModule?.activate?.();
      return false;
    } finally {
      state.refreshInFlight = false;
    }
  }

  function activate() {
    if (!state.map?.getStyle?.()) return false;
    rememberLayerOrder();
    detectStyleDependencies();
    window.TlcNavigationStreetModeModule?.init?.(state.map);

    if (!state.supported) {
      state.active = true;
      state.fallbackModeUsed = true;
      window.TlcNavigationStreetModeModule?.activate?.();
      return true;
    }

    try {
      ensureBuildingTintLayer();
      moveLayersForNavigationReadability();
      state.active = true;
      state.fallbackModeUsed = false;
      window.TlcNavigationStreetModeModule?.deactivate?.();
      return refreshForViewport(true) || true;
    } catch (_err) {
      state.active = true;
      state.fallbackModeUsed = true;
      window.TlcNavigationStreetModeModule?.activate?.();
      return true;
    }
  }

  function deactivate() {
    if (!state.map?.getStyle?.()) return false;

    clearBuildingTintData();
    restoreZoneFillAfterNavigationSuppression();
    if (hasLayer(state.buildingTintLayerId)) {
      state.map.removeLayer(state.buildingTintLayerId);
    }
    if (hasSource(state.buildingTintSourceId)) {
      state.map.removeSource(state.buildingTintSourceId);
    }

    restorePaint();
    restoreLayerOrder();

    state.active = false;
    state.supported = false;
    state.fallbackModeUsed = false;
    state.buildingSourceId = null;
    state.buildingSourceLayer = null;
    state.blockSourceLayer = null;
    state.buildingLayerAnchorId = null;
    state.lastViewportKey = "";
    state.lastRefreshAt = 0;
    state.refreshInFlight = false;
    state.buildingTintFeatureCount = 0;
    state.hotspotFeatureSnapshot = [];
    state.zoneFillSuppressed = false;
    state.usingVectorOverlayGeometry = false;
    state.blockSurfaceLayerIds = [];

    window.TlcNavigationStreetModeModule?.deactivate?.();
    return true;
  }

  function reapplyIfNeeded() {
    if (!state.active || !state.map?.getStyle?.()) return false;

    detectStyleDependencies();
    if (!state.supported) {
      state.fallbackModeUsed = true;
      window.TlcNavigationStreetModeModule?.reapplyIfNeeded?.();
      return true;
    }

    ensureBuildingTintLayer();
    moveLayersForNavigationReadability();
    return refreshForViewport(false);
  }

  function init(map) {
    state.map = map || null;
    detectStyleDependencies();
    window.TlcNavigationStreetModeModule?.init?.(state.map);
  }

  function getSnapshot() {
    return {
      active: !!state.active,
      supported: !!state.supported,
      fallbackModeUsed: !!state.fallbackModeUsed,
      buildingSourceId: state.buildingSourceId,
      buildingSourceLayer: state.buildingSourceLayer,
      blockSourceLayer: state.blockSourceLayer,
      buildingTintFeatureCount: Number(state.buildingTintFeatureCount || 0),
      hotspotSourceId: state.hotspotSourceId,
      hotspotFillLayerIds: state.hotspotFillLayerIds.slice(),
      hotspotOutlineLayerIds: state.hotspotOutlineLayerIds.slice(),
      hotspotSourceLayerIds: state.hotspotSourceLayerIds.slice(),
      roadLayerIds: state.roadLayerIds.slice(),
      streetLabelLayerIds: state.streetLabelLayerIds.slice(),
      blockSurfaceLayerIds: state.blockSurfaceLayerIds.slice(),
      usingVectorOverlayGeometry: !!state.usingVectorOverlayGeometry,
      buildingTintLayerId: state.buildingTintLayerId,
      lastViewportKey: state.lastViewportKey,
      refreshInFlight: !!state.refreshInFlight,
      zoneFillSuppressed: !!state.zoneFillSuppressed,
    };
  }

  window.TlcNavigationBuildingTintModule = {
    init,
    activate,
    deactivate,
    refreshForViewport,
    reapplyIfNeeded,
    getSnapshot,
  };

  window.getTeamJoseoNavigationBuildingTintSnapshot = function getTeamJoseoNavigationBuildingTintSnapshot() {
    return window.TlcNavigationBuildingTintModule?.getSnapshot?.() || {
      active: false,
      supported: false,
      fallbackModeUsed: true,
      buildingSourceId: null,
      buildingSourceLayer: null,
      blockSourceLayer: null,
      buildingTintFeatureCount: 0,
      hotspotSourceId: null,
      hotspotFillLayerIds: [],
      hotspotOutlineLayerIds: [],
      hotspotSourceLayerIds: [],
      roadLayerIds: [],
      streetLabelLayerIds: [],
      blockSurfaceLayerIds: [],
      usingVectorOverlayGeometry: false,
      buildingTintLayerId: BUILDING_TINT_LAYER_ID,
      lastViewportKey: "",
      refreshInFlight: false,
      zoneFillSuppressed: false,
    };
  };
})();
