(function () {
  const OVERLAY_PREFIX = "tlc-nav-vec";
  const DEFAULT_SOURCE_ID = "tlc-nav-vector";
  const DEFAULT_SOURCE_URL = "https://demotiles.maplibre.org/tiles/tiles.json";

  const LAYER_IDS = {
    land: `${OVERLAY_PREFIX}-land`,
    water: `${OVERLAY_PREFIX}-water`,
    buildings: `${OVERLAY_PREFIX}-buildings`,
    roads: `${OVERLAY_PREFIX}-roads`,
    roadLabels: `${OVERLAY_PREFIX}-road-labels`,
  };

  const state = {
    map: null,
    active: false,
    supported: false,
    fallbackModeUsed: false,
    vectorSourceId: DEFAULT_SOURCE_ID,
    vectorSourceUrlOrTiles: DEFAULT_SOURCE_URL,
    roadLayerIds: [],
    roadLabelLayerIds: [],
    buildingLayerIds: [],
    landLayerIds: [],
    waterLayerIds: [],
    overlayLayerIds: [],
    originalLayerOrder: null,
    originalPaint: new Map(),
    overlayReady: false,
    buildingSourceLayer: null,
  };

  function hasLayer(id) {
    return !!state.map?.getLayer?.(id);
  }

  function hasSource(id) {
    return !!state.map?.getSource?.(id);
  }

  function getStyleLayers() {
    const layers = state.map?.getStyle?.()?.layers;
    return Array.isArray(layers) ? layers : [];
  }

  function getConfig() {
    const raw = window.__TLC_NAV_VECTOR_OVERLAY_CONFIG__ || {};
    const sourceId = String(raw.sourceId || DEFAULT_SOURCE_ID).trim() || DEFAULT_SOURCE_ID;
    const sourceUrl = String(raw.sourceUrl || "").trim();
    const tiles = Array.isArray(raw.tiles) ? raw.tiles.filter((v) => String(v || "").trim()) : null;
    state.vectorSourceId = sourceId;
    state.vectorSourceUrlOrTiles = sourceUrl || (tiles && tiles.length ? tiles.slice() : DEFAULT_SOURCE_URL);
    return { sourceId, sourceUrl, tiles };
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

  function getOverlayInsertBeforeId() {
    const candidates = [
      "zones-fill",
      "zones-line",
      "zones-labels",
      "tlc-nav-building-tint-layer",
      "tlc-nav-preview-casing",
      "tlc-nav-preview-line",
    ];
    for (const id of candidates) {
      if (hasLayer(id)) return id;
    }
    return undefined;
  }

  function ensureVectorSource() {
    const { sourceId, sourceUrl, tiles } = getConfig();
    if (hasSource(sourceId)) return true;

    const sourceDef = {
      type: "vector",
    };

    if (sourceUrl) {
      sourceDef.url = sourceUrl;
    } else if (tiles && tiles.length) {
      sourceDef.tiles = tiles;
      sourceDef.tileSize = Number(window.__TLC_NAV_VECTOR_OVERLAY_CONFIG__?.tileSize || 512);
    } else {
      sourceDef.url = DEFAULT_SOURCE_URL;
    }

    state.map.addSource(sourceId, sourceDef);
    return true;
  }

  function ensureLayer(layerDef) {
    if (hasLayer(layerDef.id)) return;
    state.map.addLayer(layerDef, getOverlayInsertBeforeId());
  }

  function resolveBuildingSourceLayer() {
    const candidates = ["building", "buildings", "structure", "landuse"];
    for (const sourceLayer of candidates) {
      try {
        const features = state.map.querySourceFeatures(state.vectorSourceId, { sourceLayer }) || [];
        if (features.length) {
          state.buildingSourceLayer = sourceLayer;
          return;
        }
      } catch (_err) {
        // no-op: keep looking
      }
    }
    state.buildingSourceLayer = "building";
  }

  function ensureOverlayLayers() {
    const sourceId = state.vectorSourceId;

    ensureLayer({
      id: LAYER_IDS.land,
      type: "fill",
      source: sourceId,
      "source-layer": "landcover",
      paint: {
        "fill-color": "rgba(246, 248, 252, 0.95)",
        "fill-opacity": 0.9,
      },
    });

    ensureLayer({
      id: LAYER_IDS.water,
      type: "fill",
      source: sourceId,
      "source-layer": "water",
      paint: {
        "fill-color": "rgba(187, 215, 244, 0.9)",
        "fill-opacity": 0.85,
      },
    });

    ensureLayer({
      id: LAYER_IDS.buildings,
      type: "fill",
      source: sourceId,
      "source-layer": "building",
      paint: {
        "fill-color": "rgba(213, 220, 228, 0.82)",
        "fill-opacity": 0.8,
        "fill-outline-color": "rgba(255,255,255,0.16)",
      },
    });

    ensureLayer({
      id: LAYER_IDS.roads,
      type: "line",
      source: sourceId,
      "source-layer": "transportation",
      paint: {
        "line-color": "rgba(255,255,255,0.98)",
        "line-opacity": 0.98,
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          10, 0.8,
          13, 1.8,
          16, 3.6,
          18, 5.8,
        ],
      },
    });

    ensureLayer({
      id: LAYER_IDS.roadLabels,
      type: "symbol",
      source: sourceId,
      "source-layer": "transportation_name",
      layout: {
        "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]],
        "text-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          12, 11,
          16, 14,
        ],
        "symbol-placement": "line",
      },
      paint: {
        "text-color": "rgba(35, 40, 48, 0.95)",
        "text-halo-color": "rgba(255,255,255,0.96)",
        "text-halo-width": 1.1,
      },
    });

    state.landLayerIds = [LAYER_IDS.land].filter((id) => hasLayer(id));
    state.waterLayerIds = [LAYER_IDS.water].filter((id) => hasLayer(id));
    state.buildingLayerIds = [LAYER_IDS.buildings].filter((id) => hasLayer(id));
    state.roadLayerIds = [LAYER_IDS.roads].filter((id) => hasLayer(id));
    state.roadLabelLayerIds = [LAYER_IDS.roadLabels].filter((id) => hasLayer(id));
    state.overlayLayerIds = [
      ...state.landLayerIds,
      ...state.waterLayerIds,
      ...state.buildingLayerIds,
      ...state.roadLayerIds,
      ...state.roadLabelLayerIds,
    ];
    state.overlayReady = state.overlayLayerIds.length > 0;
    resolveBuildingSourceLayer();
  }

  function removeOverlayLayers() {
    [
      LAYER_IDS.roadLabels,
      LAYER_IDS.roads,
      LAYER_IDS.buildings,
      LAYER_IDS.water,
      LAYER_IDS.land,
    ].forEach((id) => {
      if (hasLayer(id)) state.map.removeLayer(id);
    });
    state.overlayLayerIds = [];
    state.landLayerIds = [];
    state.waterLayerIds = [];
    state.buildingLayerIds = [];
    state.roadLayerIds = [];
    state.roadLabelLayerIds = [];
    state.overlayReady = false;
    state.buildingSourceLayer = null;
  }

  function activate() {
    if (!state.map?.getStyle?.()) return false;
    rememberLayerOrder();

    try {
      ensureVectorSource();
      ensureOverlayLayers();
      state.supported = !!(hasSource(state.vectorSourceId) && state.overlayReady);
      state.fallbackModeUsed = !state.supported;
      state.active = true;
      document.body?.classList?.add("tlc-nav-vector-overlay-active");
      return state.supported;
    } catch (_err) {
      state.supported = false;
      state.fallbackModeUsed = true;
      state.active = true;
      state.overlayReady = false;
      return false;
    }
  }

  function deactivate() {
    if (!state.map?.getStyle?.()) return false;
    removeOverlayLayers();

    if (hasSource(state.vectorSourceId)) {
      state.map.removeSource(state.vectorSourceId);
    }

    restoreLayerOrder();
    state.active = false;
    state.supported = false;
    state.fallbackModeUsed = false;
    state.overlayReady = false;
    state.originalPaint.clear();
    document.body?.classList?.remove("tlc-nav-vector-overlay-active");
    return true;
  }

  function reapplyIfNeeded() {
    if (!state.active || !state.map?.getStyle?.()) return false;
    try {
      ensureVectorSource();
      ensureOverlayLayers();
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
    state.supported = false;
    state.overlayReady = false;
  }

  function getBuildingQueryConfig() {
    if (!state.overlayReady || !state.supported) return null;
    return {
      sourceId: state.vectorSourceId,
      sourceLayer: state.buildingSourceLayer || "building",
      buildingLayerIds: state.buildingLayerIds.slice(),
      roadLayerIds: state.roadLayerIds.slice(),
      roadLabelLayerIds: state.roadLabelLayerIds.slice(),
    };
  }

  function getSnapshot() {
    return {
      active: !!state.active,
      supported: !!state.supported,
      fallbackModeUsed: !!state.fallbackModeUsed,
      overlayReady: !!state.overlayReady,
      vectorSourceId: state.vectorSourceId,
      roadLayerIds: state.roadLayerIds.slice(),
      roadLabelLayerIds: state.roadLabelLayerIds.slice(),
      buildingLayerIds: state.buildingLayerIds.slice(),
      overlayLayerIds: state.overlayLayerIds.slice(),
    };
  }

  window.TlcNavigationVectorOverlayModule = {
    init,
    activate,
    deactivate,
    reapplyIfNeeded,
    getSnapshot,
    getBuildingQueryConfig,
  };

  window.getTeamJoseoNavigationVectorOverlaySnapshot = function getTeamJoseoNavigationVectorOverlaySnapshot() {
    return window.TlcNavigationVectorOverlayModule?.getSnapshot?.() || {
      active: false,
      supported: false,
      overlayReady: false,
      vectorSourceId: DEFAULT_SOURCE_ID,
      roadLayerIds: [],
      roadLabelLayerIds: [],
      buildingLayerIds: [],
      overlayLayerIds: [],
    };
  };
})();
