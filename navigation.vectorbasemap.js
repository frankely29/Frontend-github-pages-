(function () {
  const DEFAULT_SOURCE_ID = "tlc-nav-vector";
  const DEFAULT_SOURCE_URL = "https://tiles.openfreemap.org/planet";
  const LAYER_IDS = {
    blocks: "tlc-nav-base-blocks",
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
    blockSurfaceLayerIds: [],
    waterLayerIds: [],
    overlayLayerIds: [],
    originalLayerOrder: null,
    originalPaint: new Map(),
    fallbackModeUsed: false,
    buildingSourceLayer: "building",
    blockSourceLayer: "landuse",
    _sourceDataBound: false,
    _sourceDataHandler: null,
  };

  function hasLayer(id) {
    return !!state.map?.getLayer?.(id);
  }

  function hasSource(id) {
    return !!state.map?.getSource?.(id);
  }

  function getStyleLayers() {
    return Array.isArray(state.map?.getStyle?.()?.layers) ? state.map.getStyle().layers : [];
  }

  function getConfig() {
    const raw = window.__TLC_NAV_VECTOR_BASEMAP_CONFIG__ || {};
    const sourceId = String(raw.sourceId || DEFAULT_SOURCE_ID).trim() || DEFAULT_SOURCE_ID;
    const sourceUrl = String(raw.sourceUrl || "").trim() || DEFAULT_SOURCE_URL;
    const tiles = Array.isArray(raw.tiles) ? raw.tiles.filter((tile) => String(tile || "").trim()) : null;
    const tileSize = Number(raw.tileSize || 512);

    state.vectorSourceId = sourceId;
    state.vectorStyleDescriptor = {
      sourceId,
      sourceUrl,
      tiles: tiles?.length ? tiles.slice() : null,
      tileSize,
      sourceLayers: {
        building: ["building", "buildings", "structure"],
        blocks: ["landuse", "landcover"],
        roads: ["transportation", "road", "roads"],
        roadLabels: ["transportation_name", "road_name", "road_label"],
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
        if (hasLayer(next)) {
          beforeId = next;
          break;
        }
      }
      state.map.moveLayer(layerId, beforeId || undefined);
    }
    state.originalLayerOrder = null;
  }

  function getInsertBeforeId() {
    const candidates = [
      "zones-fill",
      "zones-line",
      "zones-labels",
      "tlc-nav-building-tint-layer",
      "tlc-nav-preview-casing",
      "tlc-nav-preview-line",
    ];
    return candidates.find((id) => hasLayer(id));
  }

  function ensureVectorSource() {
    const descriptor = getConfig();
    if (hasSource(descriptor.sourceId)) return true;

    const sourceDef = { type: "vector" };
    if (descriptor.sourceUrl) {
      sourceDef.url = descriptor.sourceUrl;
    } else if (descriptor.tiles?.length) {
      sourceDef.tiles = descriptor.tiles.slice();
      sourceDef.tileSize = descriptor.tileSize;
    } else {
      sourceDef.tiles = ["https://tiles.openfreemap.org/planet/{z}/{x}/{y}.pbf"];
      sourceDef.tileSize = 512;
    }
    state.map.addSource(descriptor.sourceId, sourceDef);
    return true;
  }

  function ensureLayer(def) {
    if (hasLayer(def.id)) return;
    state.map.addLayer(def, getInsertBeforeId());
  }

  function resolveUsableSourceLayer(candidates) {
    for (const sourceLayer of candidates) {
      try {
        const features = state.map.querySourceFeatures(state.vectorSourceId, { sourceLayer }) || [];
        if (features.length) return sourceLayer;
      } catch (_err) {
        // continue trying candidates
      }
    }
    return candidates[0] || null;
  }

  function ensureVectorLayers() {
    const descriptor = state.vectorStyleDescriptor || getConfig();
    const sourceId = descriptor.sourceId;
    const blockSurfaceSourceLayer = resolveUsableSourceLayer(descriptor.sourceLayers.blocks);
    const waterSourceLayer = resolveUsableSourceLayer(descriptor.sourceLayers.water);
    const buildingSourceLayer = resolveUsableSourceLayer(descriptor.sourceLayers.building);
    const roadSourceLayer = resolveUsableSourceLayer(descriptor.sourceLayers.roads);
    const roadLabelSourceLayer = resolveUsableSourceLayer(descriptor.sourceLayers.roadLabels);

    if (blockSurfaceSourceLayer) {
      ensureLayer({
        id: LAYER_IDS.blocks,
        type: "fill",
        source: sourceId,
        "source-layer": blockSurfaceSourceLayer,
        paint: {
          "fill-color": "rgba(245,247,251,0.95)",
          "fill-opacity": 0.93,
        },
      });
    }

    if (waterSourceLayer) {
      ensureLayer({
        id: LAYER_IDS.water,
        type: "fill",
        source: sourceId,
        "source-layer": waterSourceLayer,
        paint: {
          "fill-color": "rgba(186,214,244,0.93)",
          "fill-opacity": 0.88,
        },
      });
    }

    if (buildingSourceLayer) {
      ensureLayer({
        id: LAYER_IDS.buildings,
        type: "fill",
        source: sourceId,
        "source-layer": buildingSourceLayer,
        paint: {
          "fill-color": "rgba(214,222,233,0.84)",
          "fill-opacity": 0.84,
          "fill-outline-color": "rgba(255,255,255,0.24)",
        },
      });
    }

    if (roadSourceLayer) {
      ensureLayer({
        id: LAYER_IDS.roads,
        type: "line",
        source: sourceId,
        "source-layer": roadSourceLayer,
        paint: {
          "line-color": "rgba(255,255,255,0.99)",
          "line-opacity": 1,
          "line-width": [
            "interpolate", ["linear"], ["zoom"],
            10, 0.7,
            13, 1.6,
            16, 3.1,
            18, 5.0,
          ],
        },
      });
    }

    if (roadLabelSourceLayer) {
      ensureLayer({
        id: LAYER_IDS.roadLabels,
        type: "symbol",
        source: sourceId,
        "source-layer": roadLabelSourceLayer,
        minzoom: 10,
        layout: {
          "symbol-placement": "line",
          "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]],
          "text-size": [
            "interpolate", ["linear"], ["zoom"],
            10, 10,
            14, 12,
            16, 14,
          ],
        },
        paint: {
          "text-color": "rgba(30,35,42,0.98)",
          "text-halo-color": "rgba(255,255,255,0.99)",
          "text-halo-width": 1.2,
        },
      });
    }

    state.buildingSourceLayer = buildingSourceLayer || "building";
    state.blockSourceLayer = blockSurfaceSourceLayer || "landuse";
    state.blockSurfaceLayerIds = [LAYER_IDS.blocks].filter((id) => hasLayer(id));
    state.waterLayerIds = [LAYER_IDS.water].filter((id) => hasLayer(id));
    state.buildingLayerIds = [LAYER_IDS.buildings].filter((id) => hasLayer(id));
    state.roadLayerIds = [LAYER_IDS.roads].filter((id) => hasLayer(id));
    state.roadLabelLayerIds = [LAYER_IDS.roadLabels].filter((id) => hasLayer(id));
    state.overlayLayerIds = [
      ...state.blockSurfaceLayerIds,
      ...state.waterLayerIds,
      ...state.buildingLayerIds,
      ...state.roadLayerIds,
      ...state.roadLabelLayerIds,
    ];
    state.overlayReady = state.overlayLayerIds.length > 0;
  }

  function removeVectorLayers() {
    [
      LAYER_IDS.roadLabels,
      LAYER_IDS.roads,
      LAYER_IDS.buildings,
      LAYER_IDS.water,
      LAYER_IDS.blocks,
    ].forEach((id) => {
      if (hasLayer(id)) state.map.removeLayer(id);
    });
    state.roadLayerIds = [];
    state.roadLabelLayerIds = [];
    state.buildingLayerIds = [];
    state.blockSurfaceLayerIds = [];
    state.waterLayerIds = [];
    state.overlayLayerIds = [];
    state.overlayReady = false;
  }

  function activate() {
    if (!state.map?.getStyle?.()) return false;
    rememberLayerOrder();
    try {
      ensureVectorSource();
      const sourceId = state.vectorSourceId;
      const onSourceData = (e) => {
        if (e?.sourceId !== sourceId || !e?.isSourceLoaded) return;
        if (!state.active) return;
        window.TlcNavigationBuildingTintModule?.refreshForViewport?.(true);
      };
      if (!state._sourceDataBound) {
        state.map.on("sourcedata", onSourceData);
        state._sourceDataBound = true;
        state._sourceDataHandler = onSourceData;
      }
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
    if (state._sourceDataBound && state._sourceDataHandler) {
      state.map.off("sourcedata", state._sourceDataHandler);
      state._sourceDataBound = false;
      state._sourceDataHandler = null;
    }
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
      blockSurfaceLayerIds: state.blockSurfaceLayerIds.slice(),
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
      vectorStyleDescriptor: state.vectorStyleDescriptor ? { ...state.vectorStyleDescriptor } : null,
      roadLayerIds: state.roadLayerIds.slice(),
      roadLabelLayerIds: state.roadLabelLayerIds.slice(),
      buildingLayerIds: state.buildingLayerIds.slice(),
      blockSurfaceLayerIds: state.blockSurfaceLayerIds.slice(),
      waterLayerIds: state.waterLayerIds.slice(),
      overlayLayerIds: state.overlayLayerIds.slice(),
      originalLayerOrder: Array.isArray(state.originalLayerOrder) ? state.originalLayerOrder.slice() : null,
      originalPaint: Array.from(state.originalPaint.entries()),
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
      vectorStyleDescriptor: null,
      roadLayerIds: [],
      roadLabelLayerIds: [],
      buildingLayerIds: [],
      blockSurfaceLayerIds: [],
      waterLayerIds: [],
      overlayLayerIds: [],
      originalLayerOrder: null,
      originalPaint: [],
      fallbackModeUsed: false,
    };
  };
})();
