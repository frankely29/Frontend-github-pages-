(function () {
  const PREVIEW_CASING_LAYER_ID = "tlc-nav-preview-casing";
  const PREVIEW_LINE_LAYER_ID = "tlc-nav-preview-line";
  const EXPLICIT_HOTSPOT_FILL_IDS = ["zones-fill"];
  const EXPLICIT_PREVIEW_ROUTE_IDS = [PREVIEW_CASING_LAYER_ID, PREVIEW_LINE_LAYER_ID];

  const state = {
    map: null,
    active: false,
    originalLayerOrder: null,
    originalPaint: new Map(),
    hotspotFillLayerIds: [],
    hotspotOutlineLayerIds: [],
    roadLayerIds: [],
    streetLabelLayerIds: [],
    previewRouteLayerIds: [],
    routeMarkerPresent: false,
    fallbackModeUsed: false,
  };

  function hasMapLayer(layerId) {
    return !!(state.map?.getLayer?.(layerId));
  }

  function getStyleLayers() {
    const layers = state.map?.getStyle?.()?.layers;
    return Array.isArray(layers) ? layers : [];
  }

  function readLayerTokens(layer) {
    const tokens = [
      layer?.id,
      layer?.["source-layer"],
      layer?.source,
      layer?.metadata?.["mapbox:group"],
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return tokens;
  }

  function isRoadLayer(layer) {
    if (!layer || layer.type !== "line") return false;
    const t = readLayerTokens(layer);
    return /(road|street|bridge|tunnel|motorway|highway|ramp|primary|secondary|tertiary)/.test(t);
  }

  function isStreetLabelLayer(layer) {
    if (!layer || layer.type !== "symbol") return false;
    const t = readLayerTokens(layer);
    return /(road|street)/.test(t) && /(label|name|ref|shield)/.test(t);
  }

  function isHotspotFillLayer(layer, hotspotSourceId) {
    if (!layer || layer.type !== "fill") return false;
    if (EXPLICIT_HOTSPOT_FILL_IDS.includes(layer.id)) return true;
    const t = readLayerTokens(layer);
    if (/(zone|hotspot)/.test(t)) return true;
    return !!(hotspotSourceId && layer.source === hotspotSourceId);
  }

  function isHotspotOutlineLayer(layer, hotspotSourceId) {
    if (!layer || layer.type !== "line") return false;
    const t = readLayerTokens(layer);
    if (/(zone|hotspot|outline|boundary|border)/.test(t)) return true;
    return !!(hotspotSourceId && layer.source === hotspotSourceId);
  }

  function cachePaintProperty(layerId, prop) {
    if (!hasMapLayer(layerId)) return;
    const key = `${layerId}:${prop}`;
    if (state.originalPaint.has(key)) return;
    state.originalPaint.set(key, state.map.getPaintProperty(layerId, prop));
  }

  function setPaintProperty(layerId, prop, value) {
    if (!hasMapLayer(layerId)) return;
    cachePaintProperty(layerId, prop);
    state.map.setPaintProperty(layerId, prop, value);
  }

  function restorePaintProperties() {
    Array.from(state.originalPaint.entries()).forEach(([key, value]) => {
      const [layerId, prop] = key.split(":");
      if (!hasMapLayer(layerId)) return;
      state.map.setPaintProperty(layerId, prop, value == null ? null : value);
    });
    state.originalPaint.clear();
  }

  function discoverLayers() {
    const layers = getStyleLayers();
    const hotspotSourceId = hasMapLayer("zones-fill") ? (state.map.getLayer("zones-fill")?.source || null) : null;

    const hotspotFillLayerIds = [];
    const hotspotOutlineLayerIds = [];
    const roadLayerIds = [];
    const streetLabelLayerIds = [];

    layers.forEach((layer) => {
      if (!layer?.id) return;
      if (isHotspotFillLayer(layer, hotspotSourceId)) hotspotFillLayerIds.push(layer.id);
      if (isHotspotOutlineLayer(layer, hotspotSourceId)) hotspotOutlineLayerIds.push(layer.id);
      if (isRoadLayer(layer)) roadLayerIds.push(layer.id);
      if (isStreetLabelLayer(layer)) streetLabelLayerIds.push(layer.id);
    });

    EXPLICIT_HOTSPOT_FILL_IDS.forEach((layerId) => {
      if (hasMapLayer(layerId) && !hotspotFillLayerIds.includes(layerId)) hotspotFillLayerIds.push(layerId);
    });

    const previewRouteLayerIds = EXPLICIT_PREVIEW_ROUTE_IDS.filter((layerId) => hasMapLayer(layerId));
    const routeMarkerPresent = !!document.querySelector(".maplibregl-marker, .mapboxgl-marker");

    state.hotspotFillLayerIds = hotspotFillLayerIds;
    state.hotspotOutlineLayerIds = hotspotOutlineLayerIds;
    state.roadLayerIds = roadLayerIds;
    state.streetLabelLayerIds = streetLabelLayerIds;
    state.previewRouteLayerIds = previewRouteLayerIds;
    state.routeMarkerPresent = routeMarkerPresent;
  }

  function rememberLayerOrder() {
    if (state.originalLayerOrder?.length) return;
    state.originalLayerOrder = getStyleLayers().map((layer) => layer.id).filter(Boolean);
  }

  function moveHotspotsBelowRoads() {
    const roadAnchor = state.roadLayerIds.find((layerId) => hasMapLayer(layerId));
    if (!roadAnchor) return false;
    if (!state.hotspotFillLayerIds.length) return false;
    state.hotspotFillLayerIds.forEach((layerId) => {
      if (!hasMapLayer(layerId) || layerId === roadAnchor) return;
      state.map.moveLayer(layerId, roadAnchor);
    });
    return true;
  }

  function promoteRoadLabelsAndRoute() {
    state.roadLayerIds.forEach((layerId) => {
      if (hasMapLayer(layerId)) state.map.moveLayer(layerId);
    });
    state.streetLabelLayerIds.forEach((layerId) => {
      if (hasMapLayer(layerId)) state.map.moveLayer(layerId);
    });
    state.hotspotOutlineLayerIds.forEach((layerId) => {
      if (hasMapLayer(layerId)) state.map.moveLayer(layerId);
    });
    state.previewRouteLayerIds.forEach((layerId) => {
      if (hasMapLayer(layerId)) state.map.moveLayer(layerId);
    });
  }

  function applyRouteCorridorStyle(activeFallback) {
    setPaintProperty(PREVIEW_CASING_LAYER_ID, "line-color", activeFallback ? "rgba(248, 250, 252, 0.98)" : "rgba(241, 245, 249, 0.95)");
    setPaintProperty(PREVIEW_CASING_LAYER_ID, "line-opacity", activeFallback ? 1 : 0.98);
    setPaintProperty(
      PREVIEW_CASING_LAYER_ID,
      "line-width",
      activeFallback
        ? ["interpolate", ["linear"], ["zoom"], 10, 10, 15, 14, 18, 18]
        : ["interpolate", ["linear"], ["zoom"], 10, 9, 15, 13, 18, 16]
    );

    setPaintProperty(PREVIEW_LINE_LAYER_ID, "line-color", "#0ea5e9");
    setPaintProperty(PREVIEW_LINE_LAYER_ID, "line-opacity", 0.99);
    setPaintProperty(PREVIEW_LINE_LAYER_ID, "line-width", ["interpolate", ["linear"], ["zoom"], 10, 4.5, 15, 6.5, 18, 8.5]);
  }

  function applyFallbackVisuals() {
    state.hotspotFillLayerIds.forEach((layerId) => {
      if (!hasMapLayer(layerId)) return;
      const current = state.map.getPaintProperty(layerId, "fill-opacity");
      if (typeof current === "number") {
        setPaintProperty(layerId, "fill-opacity", Math.max(0.58, Math.min(0.88, current)));
      } else {
        setPaintProperty(layerId, "fill-opacity", 0.7);
      }
    });
  }

  function restoreOriginalLayerOrder() {
    const original = Array.isArray(state.originalLayerOrder) ? state.originalLayerOrder : [];
    if (!original.length) return;
    for (let i = original.length - 1; i >= 0; i -= 1) {
      const layerId = original[i];
      if (!hasMapLayer(layerId)) continue;
      let beforeId = null;
      for (let j = i + 1; j < original.length; j += 1) {
        const candidate = original[j];
        if (hasMapLayer(candidate)) {
          beforeId = candidate;
          break;
        }
      }
      state.map.moveLayer(layerId, beforeId || undefined);
    }
    state.originalLayerOrder = null;
  }

  function activate() {
    if (!state.map?.getStyle?.()) return false;
    rememberLayerOrder();
    discoverLayers();

    const reordered = moveHotspotsBelowRoads();
    state.fallbackModeUsed = !reordered;
    if (state.fallbackModeUsed) applyFallbackVisuals();

    promoteRoadLabelsAndRoute();
    // Last-resort fallback: if no vector road layers found (raster basemap),
    // reduce zone fill opacity so raster streets show through
    if (!state.roadLayerIds.length) {
      state.fallbackModeUsed = true;
      state.hotspotFillLayerIds.forEach((layerId) => {
        if (!hasMapLayer(layerId)) return;
        cachePaintProperty(layerId, "fill-opacity");
        state.map.setPaintProperty(layerId, "fill-opacity", 0.38);
      });
      state.hotspotOutlineLayerIds.forEach((layerId) => {
        if (!hasMapLayer(layerId)) return;
        cachePaintProperty(layerId, "line-opacity");
        state.map.setPaintProperty(layerId, "line-opacity", 0.7);
      });
    }
    applyRouteCorridorStyle(state.fallbackModeUsed);
    state.active = true;
    return true;
  }

  function deactivate() {
    if (!state.map?.getStyle?.()) return false;
    restorePaintProperties();
    restoreOriginalLayerOrder();
    state.active = false;
    state.fallbackModeUsed = false;
    discoverLayers();
    return true;
  }

  function reapplyIfNeeded() {
    if (!state.active) return false;
    if (!state.map?.getStyle?.()) return false;
    discoverLayers();
    const reordered = moveHotspotsBelowRoads();
    state.fallbackModeUsed = !reordered;
    if (state.fallbackModeUsed) applyFallbackVisuals();
    promoteRoadLabelsAndRoute();
    applyRouteCorridorStyle(state.fallbackModeUsed);
    return true;
  }

  function init(map) {
    state.map = map || null;
    discoverLayers();
  }

  function getSnapshot() {
    return {
      active: !!state.active,
      hotspotFillLayerIds: state.hotspotFillLayerIds.slice(),
      hotspotOutlineLayerIds: state.hotspotOutlineLayerIds.slice(),
      roadLayerIds: state.roadLayerIds.slice(),
      streetLabelLayerIds: state.streetLabelLayerIds.slice(),
      previewRouteLayerIds: state.previewRouteLayerIds.slice(),
      fallbackModeUsed: !!state.fallbackModeUsed,
      routeMarkerPresent: !!state.routeMarkerPresent,
    };
  }

  window.TlcNavigationStreetModeModule = {
    init,
    activate,
    deactivate,
    reapplyIfNeeded,
    getSnapshot,
  };

  window.getTeamJoseoNavigationStreetModeSnapshot = function getTeamJoseoNavigationStreetModeSnapshot() {
    return window.TlcNavigationStreetModeModule?.getSnapshot?.() || {
      active: false,
      hotspotFillLayerIds: [],
      hotspotOutlineLayerIds: [],
      roadLayerIds: [],
      streetLabelLayerIds: [],
      previewRouteLayerIds: [],
      fallbackModeUsed: false,
      routeMarkerPresent: false,
    };
  };
})();
