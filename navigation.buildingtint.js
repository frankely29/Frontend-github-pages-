(function () {
  const PREVIEW_CASING_LAYER_ID = "tlc-nav-preview-casing";
  const PREVIEW_LINE_LAYER_ID = "tlc-nav-preview-line";
  const BUILDING_TINT_SOURCE_ID = "tlc-nav-building-tint-source";
  const BUILDING_TINT_LAYER_ID = "tlc-nav-building-tint-layer";
  const EXPLICIT_HOTSPOT_FILL_IDS = ["zones-fill"];
  const REFRESH_THROTTLE_MS = 700;

  const state = {
    map: null,
    active: false,
    supported: false,
    fallbackModeUsed: false,
    buildingSourceId: null,
    buildingSourceLayer: null,
    buildingLayerAnchorId: null,
    hotspotSourceId: null,
    hotspotFillLayerIds: [],
    roadLayerIds: [],
    streetLabelLayerIds: [],
    originalLayerOrder: null,
    originalPaint: new Map(),
    buildingTintSourceId: BUILDING_TINT_SOURCE_ID,
    buildingTintLayerId: BUILDING_TINT_LAYER_ID,
    lastViewportKey: "",
    lastRefreshAt: 0,
    refreshInFlight: false,
    buildingTintFeatureCount: 0,
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

  function detectStyleDependencies() {
    const layers = getStyleLayers();
    const buildingCandidates = [];
    const roadLayerIds = [];
    const streetLabelLayerIds = [];

    let hotspotSourceId = hasLayer("zones-fill") ? (state.map.getLayer("zones-fill")?.source || null) : null;
    const hotspotFillLayerIds = [];

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
      }
    });

    EXPLICIT_HOTSPOT_FILL_IDS.forEach((layerId) => {
      if (hasLayer(layerId) && !hotspotFillLayerIds.includes(layerId)) hotspotFillLayerIds.push(layerId);
    });

    const preferredBuilding = buildingCandidates.find((layer) => layer.type === "fill")
      || buildingCandidates.find((layer) => layer.type === "fill-extrusion")
      || null;

    state.buildingSourceId = preferredBuilding?.source || null;
    state.buildingSourceLayer = preferredBuilding?.["source-layer"] || null;
    state.buildingLayerAnchorId = preferredBuilding?.id || null;
    state.hotspotSourceId = hotspotSourceId;
    state.hotspotFillLayerIds = hotspotFillLayerIds;
    state.roadLayerIds = roadLayerIds;
    state.streetLabelLayerIds = streetLabelLayerIds;
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

  function getHotspotFeatures() {
    const layerIds = state.hotspotFillLayerIds.filter((id) => hasLayer(id));
    if (!layerIds.length) return [];
    try {
      return state.map.queryRenderedFeatures(undefined, { layers: layerIds }) || [];
    } catch (_err) {
      return [];
    }
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
        hotspotOpacity: 0.36,
      },
    };
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

  function minimizeZoneFillForNavigation() {
    state.hotspotFillLayerIds.forEach((layerId) => {
      if (!hasLayer(layerId)) return;
      setPaint(layerId, "fill-opacity", 0.08);
    });
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
      const rawBuildings = state.map.querySourceFeatures(state.buildingSourceId, {
        sourceLayer: state.buildingSourceLayer,
      }) || [];

      const hotspotFeatures = getHotspotFeatures();
      if (!hotspotFeatures.length) {
        state.fallbackModeUsed = true;
        clearBuildingTintData();
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
        tintedFeatures.push(buildTintFeature(buildingFeature, hotspotMeta));
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
      state.fallbackModeUsed = false;
      moveLayersForNavigationReadability();
      minimizeZoneFillForNavigation();
      return true;
    } catch (_err) {
      state.fallbackModeUsed = true;
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
      minimizeZoneFillForNavigation();
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
    state.buildingLayerAnchorId = null;
    state.lastViewportKey = "";
    state.lastRefreshAt = 0;
    state.refreshInFlight = false;
    state.buildingTintFeatureCount = 0;

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
    minimizeZoneFillForNavigation();
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
      buildingTintFeatureCount: Number(state.buildingTintFeatureCount || 0),
      hotspotSourceId: state.hotspotSourceId,
      hotspotFillLayerIds: state.hotspotFillLayerIds.slice(),
      roadLayerIds: state.roadLayerIds.slice(),
      streetLabelLayerIds: state.streetLabelLayerIds.slice(),
      buildingTintLayerId: state.buildingTintLayerId,
      lastViewportKey: state.lastViewportKey,
      refreshInFlight: !!state.refreshInFlight,
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
      buildingTintFeatureCount: 0,
      hotspotSourceId: null,
      hotspotFillLayerIds: [],
      roadLayerIds: [],
      streetLabelLayerIds: [],
      buildingTintLayerId: BUILDING_TINT_LAYER_ID,
      lastViewportKey: "",
      refreshInFlight: false,
    };
  };
})();
