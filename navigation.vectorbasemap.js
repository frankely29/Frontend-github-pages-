(function () {
  const DEFAULT_SOURCE_ID = "tlc-nav-vector";
  const DEFAULT_SOURCE_URL = "https://demotiles.maplibre.org/tiles/tiles.json";
  const LAYER_IDS = {
    land: "tlc-nav-base-land",
    water: "tlc-nav-base-water",
    buildings: "tlc-nav-base-buildings",
    roads: "tlc-nav-base-roads",
    roadLabels: "tlc-nav-base-road-labels",
  };

  const state = {
    map: null,
    active: false,
    supported: false,
    overlayReady: false,
    vectorSourceId: DEFAULT_SOURCE_ID,
    vectorStyleDescriptor: null,
    roadLayerIds: [],
    roadLabelLayerIds: [],
    buildingLayerIds: [],
    landLayerIds: [],
    waterLayerIds: [],
    originalLayerOrder: null,
    originalPaint: new Map(),
    fallbackModeUsed: false,
    buildingSourceLayer: "building",
    blockSourceLayer: "landuse",
  };

  function hasLayer(id) { return !!state.map?.getLayer?.(id); }
  function hasSource(id) { return !!state.map?.getSource?.(id); }
  function getStyleLayers() { return Array.isArray(state.map?.getStyle?.()?.layers) ? state.map.getStyle().layers : []; }

  function getConfig() {
    const raw = window.__TLC_NAV_VECTOR_BASEMAP_CONFIG__ || window.__TLC_NAV_VECTOR_OVERLAY_CONFIG__ || {};
    const sourceId = String(raw.sourceId || DEFAULT_SOURCE_ID).trim() || DEFAULT_SOURCE_ID;
    const sourceUrl = String(raw.sourceUrl || "").trim();
    const tiles = Array.isArray(raw.tiles) ? raw.tiles.filter((t) => String(t || "").trim()) : null;
    const tileSize = Number(raw.tileSize || 512);
    state.vectorSourceId = sourceId;
    state.vectorStyleDescriptor = {
      sourceId,
      sourceUrl: sourceUrl || DEFAULT_SOURCE_URL,
      tiles: tiles && tiles.length ? tiles.slice() : null,
      tileSize,
      sourceLayers: {
        building: ["building", "buildings", "structure"],
        blocks: ["landuse", "landcover"],
        roads: ["transportation", "road", "roads"],
        roadLabels: ["transportation_name", "road_name", "road_label"],
        land: ["landcover", "landuse"],
        water: ["water"],
      },
    };
    return state.vectorStyleDescriptor;
  }

  function rememberLayerOrder() {
    if (Array.isArray(state.originalLayerOrder) && state.originalLayerOrder.length) return;
    state.originalLayerOrder = getStyleLayers().map((layer) => layer?.id).filter(Boolean);
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
        if (hasLayer(next)) { beforeId = next; break; }
      }
      state.map.moveLayer(layerId, beforeId || undefined);
    }
    state.originalLayerOrder = null;
  }

  function getInsertBeforeId() {
    const candidates = ["zones-fill", "zones-line", "zones-labels", "tlc-nav-building-tint-layer", "tlc-nav-preview-casing", "tlc-nav-preview-line"];
    for (const id of candidates) if (hasLayer(id)) return id;
    return undefined;
  }

  function ensureVectorSource() {
    const descriptor = getConfig();
    if (hasSource(descriptor.sourceId)) return true;
    const sourceDef = { type: "vector" };
    if (descriptor.tiles?.length) {
      sourceDef.tiles = descriptor.tiles.slice();
      sourceDef.tileSize = descriptor.tileSize;
    } else {
      sourceDef.url = descriptor.sourceUrl;
    }
    state.map.addSource(descriptor.sourceId, sourceDef);
    return true;
  }

  function ensureLayer(def) {
    if (hasLayer(def.id)) return;
    state.map.addLayer(def, getInsertBeforeId());
  }

  function resolveUsableLayer(candidates) {
    for (const sourceLayer of candidates) {
      try {
        const features = state.map.querySourceFeatures(state.vectorSourceId, { sourceLayer }) || [];
        if (features.length) return sourceLayer;
      } catch (_err) {}
    }
    return candidates[0] || null;
  }

  function ensureVectorLayers() {
    const desc = state.vectorStyleDescriptor || getConfig();
    const sourceId = desc.sourceId;
    const landLayer = resolveUsableLayer(desc.sourceLayers.land);
    const waterLayer = resolveUsableLayer(desc.sourceLayers.water);
    const buildingLayer = resolveUsableLayer(desc.sourceLayers.building);
    const blockLayer = resolveUsableLayer(desc.sourceLayers.blocks);
    const roadLayer = resolveUsableLayer(desc.sourceLayers.roads);
    const roadLabelLayer = resolveUsableLayer(desc.sourceLayers.roadLabels);

    if (landLayer) {
      ensureLayer({ id: LAYER_IDS.land, type: "fill", source: sourceId, "source-layer": landLayer, paint: { "fill-color": "rgba(246,248,252,0.96)", "fill-opacity": 0.92 } });
    }
    if (waterLayer) {
      ensureLayer({ id: LAYER_IDS.water, type: "fill", source: sourceId, "source-layer": waterLayer, paint: { "fill-color": "rgba(191,216,243,0.95)", "fill-opacity": 0.9 } });
    }
    if (buildingLayer) {
      ensureLayer({ id: LAYER_IDS.buildings, type: "fill", source: sourceId, "source-layer": buildingLayer, paint: { "fill-color": "rgba(216,222,231,0.78)", "fill-opacity": 0.82, "fill-outline-color": "rgba(255,255,255,0.2)" } });
    }
    if (roadLayer) {
      ensureLayer({ id: LAYER_IDS.roads, type: "line", source: sourceId, "source-layer": roadLayer, paint: { "line-color": "rgba(254,254,254,0.98)", "line-opacity": 1, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.8, 13, 1.8, 16, 3.2, 18, 5.1] } });
    }
    if (roadLabelLayer) {
      ensureLayer({ id: LAYER_IDS.roadLabels, type: "symbol", source: sourceId, "source-layer": roadLabelLayer, layout: { "symbol-placement": "line", "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]], "text-size": ["interpolate", ["linear"], ["zoom"], 12, 11, 16, 14] }, paint: { "text-color": "rgba(35,40,48,0.98)", "text-halo-color": "rgba(255,255,255,0.98)", "text-halo-width": 1.2 } });
    }

    state.buildingSourceLayer = buildingLayer || "building";
    state.blockSourceLayer = blockLayer || landLayer || "landuse";
    state.landLayerIds = [LAYER_IDS.land].filter(hasLayer);
    state.waterLayerIds = [LAYER_IDS.water].filter(hasLayer);
    state.buildingLayerIds = [LAYER_IDS.buildings].filter(hasLayer);
    state.roadLayerIds = [LAYER_IDS.roads].filter(hasLayer);
    state.roadLabelLayerIds = [LAYER_IDS.roadLabels].filter(hasLayer);
    state.overlayReady = !!(state.landLayerIds.length + state.waterLayerIds.length + state.buildingLayerIds.length + state.roadLayerIds.length + state.roadLabelLayerIds.length);
  }

  function removeVectorLayers() {
    [LAYER_IDS.roadLabels, LAYER_IDS.roads, LAYER_IDS.buildings, LAYER_IDS.water, LAYER_IDS.land].forEach((id) => {
      if (hasLayer(id)) state.map.removeLayer(id);
    });
    state.roadLayerIds = [];
    state.roadLabelLayerIds = [];
    state.buildingLayerIds = [];
    state.landLayerIds = [];
    state.waterLayerIds = [];
    state.overlayReady = false;
  }

  function activate() {
    if (!state.map?.getStyle?.()) return false;
    rememberLayerOrder();
    try {
      ensureVectorSource();
      ensureVectorLayers();
      state.supported = !!(hasSource(state.vectorSourceId) && state.overlayReady);
      state.fallbackModeUsed = !state.supported;
      state.active = true;
      document.body?.classList?.add("tlc-nav-vector-basemap-active");
      return state.supported;
    } catch (_err) {
      state.active = true;
      state.supported = false;
      state.overlayReady = false;
      state.fallbackModeUsed = true;
      return false;
    }
  }

  function deactivate() {
    if (!state.map?.getStyle?.()) return false;
    removeVectorLayers();
    if (hasSource(state.vectorSourceId)) state.map.removeSource(state.vectorSourceId);
    restoreLayerOrder();
    state.originalPaint.clear();
    state.active = false;
    state.supported = false;
    state.overlayReady = false;
    state.fallbackModeUsed = false;
    document.body?.classList?.remove("tlc-nav-vector-basemap-active");
    return true;
  }

  function reapplyIfNeeded() {
    if (!state.active || !state.map?.getStyle?.()) return false;
    try {
      ensureVectorSource();
      ensureVectorLayers();
      state.supported = !!(hasSource(state.vectorSourceId) && state.overlayReady);
      state.fallbackModeUsed = !state.supported;
      return state.supported;
    } catch (_err) {
      state.supported = false;
      state.fallbackModeUsed = true;
      return false;
    }
  }

  function init(map) {
    state.map = map || null;
    getConfig();
  }

  function getBuildingQueryConfig() {
    if (!state.active || !state.supported || !state.overlayReady) return null;
    return {
      sourceId: state.vectorSourceId,
      sourceLayer: state.buildingSourceLayer,
      blockSourceLayer: state.blockSourceLayer,
      buildingLayerIds: state.buildingLayerIds.slice(),
      landLayerIds: state.landLayerIds.slice(),
      waterLayerIds: state.waterLayerIds.slice(),
      roadLayerIds: state.roadLayerIds.slice(),
      roadLabelLayerIds: state.roadLabelLayerIds.slice(),
    };
  }

  function getSnapshot() {
    return {
      active: !!state.active,
      supported: !!state.supported,
      overlayReady: !!state.overlayReady,
      vectorSourceId: state.vectorSourceId,
      roadLayerIds: state.roadLayerIds.slice(),
      roadLabelLayerIds: state.roadLabelLayerIds.slice(),
      buildingLayerIds: state.buildingLayerIds.slice(),
      landLayerIds: state.landLayerIds.slice(),
      waterLayerIds: state.waterLayerIds.slice(),
      fallbackModeUsed: !!state.fallbackModeUsed,
    };
  }

  window.TlcNavigationVectorBasemapModule = {
    init,
    activate,
    deactivate,
    reapplyIfNeeded,
    getSnapshot,
    getBuildingQueryConfig,
  };

  window.getTeamJoseoNavigationVectorBasemapSnapshot = function getTeamJoseoNavigationVectorBasemapSnapshot() {
    return window.TlcNavigationVectorBasemapModule?.getSnapshot?.() || {
      active: false,
      supported: false,
      overlayReady: false,
      vectorSourceId: DEFAULT_SOURCE_ID,
      roadLayerIds: [],
      roadLabelLayerIds: [],
      buildingLayerIds: [],
      landLayerIds: [],
      waterLayerIds: [],
      fallbackModeUsed: false,
    };
  };
})();
