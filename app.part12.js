(function() {
  const runtime = window.FrontendRuntime || null;
  const runtimePolling = runtime?.polling || null;
  const core = window.TlcZoneLabelInternals || {};

  const LABEL_ZOOM_MIN = 10;
  const BOROUGH_ZOOM_SHOW = 15;
  const LABEL_MAX_CHARS_MID = 14;

  const ZONE_LABEL_SHORT_NAMES = {
    "13": "Battery Pk",
    "74": "East Harlem",
    "75": "East Harlem",
    "87": "FiDi",
    "88": "FiDi",
    "107": "Gramercy",
    "120": "Hamilton",
    "138": "LaGuardia",
    "141": "LIC",
    "151": "Morningside",
    "186": "Penn Sta",
    "230": "Times Sq",
    "236": "Upper East",
    "237": "Upper East",
    "238": "Upper West",
    "239": "Upper West",
    "246": "Chelsea\nYards",
    "264": "Washington\nHeights",
    "265": "Washington\nHeights",
  };

  const ZONE_LABEL_OVERRIDES = {
    "138": { size: 11.6, maxWidth: 5.8, letterSpacing: 0.01 },
    "230": { label: "Times Sq", size: 10.8, maxWidth: 4.4, letterSpacing: 0.015 },
  };

  let zoneLabelLayoutCache = new Map();

  function shouldShowLabel(bucket, zoom) {
    if (zoom < LABEL_ZOOM_MIN) return false;
    const b = (bucket || "").trim();
    if (zoom >= 15) return true;
    if (zoom === 14) return b !== "red";
    if (zoom === 13) return b === "green" || b === "purple" || b === "blue" || b === "sky";
    if (zoom === 12) return b === "green" || b === "purple" || b === "blue";
    if (zoom === 11) return b === "green" || b === "purple";
    return b === "green";
  }

  function shortenLabel(text, maxChars) {
    const t = (text || "").trim();
    if (!t) return "";
    if (t.length <= maxChars) return t;
    return t.slice(0, maxChars - 1) + "…";
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function bboxFromCoords(coords) {
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    const visit = (c) => {
      if (!Array.isArray(c)) return;
      if (c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])) {
        minLng = Math.min(minLng, c[0]);
        minLat = Math.min(minLat, c[1]);
        maxLng = Math.max(maxLng, c[0]);
        maxLat = Math.max(maxLat, c[1]);
        return;
      }
      for (const cc of c) visit(cc);
    };
    visit(coords);
    if (!Number.isFinite(minLng) || !Number.isFinite(minLat) || !Number.isFinite(maxLng) || !Number.isFinite(maxLat)) return null;
    return { minLng, minLat, maxLng, maxLat };
  }

  function pointInRing(ptLng, ptLat, ring) {
    if (!Array.isArray(ring) || ring.length < 3) return false;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0];
      const yi = ring[i][1];
      const xj = ring[j][0];
      const yj = ring[j][1];
      const intersect =
        ((yi > ptLat) !== (yj > ptLat)) &&
        (ptLng < ((xj - xi) * (ptLat - yi)) / (yj - yi + 1e-15) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function pointInPolygonLngLat(ptLng, ptLat, polyCoords) {
    if (!Array.isArray(polyCoords) || polyCoords.length === 0) return false;
    const outer = polyCoords[0];
    if (!pointInRing(ptLng, ptLat, outer)) return false;
    for (let i = 1; i < polyCoords.length; i++) {
      if (pointInRing(ptLng, ptLat, polyCoords[i])) return false;
    }
    return true;
  }

  function pickLargestPolygonFromMulti(multiCoords) {
    if (!Array.isArray(multiCoords) || multiCoords.length === 0) return null;
    let best = null;
    let bestArea = -Infinity;
    for (const poly of multiCoords) {
      const bb = bboxFromCoords(poly);
      if (!bb) continue;
      const area = (bb.maxLng - bb.minLng) * (bb.maxLat - bb.minLat);
      if (area > bestArea) {
        bestArea = area;
        best = poly;
      }
    }
    return best;
  }

  function findInteriorPointForGeometry(geom) {
    if (!geom) return null;

    let poly = null;
    if (geom.type === "Polygon") poly = geom.coordinates;
    else if (geom.type === "MultiPolygon") poly = pickLargestPolygonFromMulti(geom.coordinates);
    else return null;

    if (!poly) return null;

    const bb = bboxFromCoords(poly);
    if (!bb) return null;

    let seed = core.geometryCenter?.({ type: "Polygon", coordinates: poly }) || null;
    if (seed && Number.isFinite(seed.lng) && Number.isFinite(seed.lat)) {
      if (pointInPolygonLngLat(seed.lng, seed.lat, poly)) return seed;
    }

    const cx = (bb.minLng + bb.maxLng) / 2;
    const cy = (bb.minLat + bb.maxLat) / 2;
    if (pointInPolygonLngLat(cx, cy, poly)) return { lng: cx, lat: cy };

    const w = bb.maxLng - bb.minLng;
    const h = bb.maxLat - bb.minLat;
    const stepLng = Math.max(w / 40, 1e-4);
    const stepLat = Math.max(h / 40, 1e-4);

    const maxR = 60;
    for (let r = 1; r <= maxR; r++) {
      const dx = r * stepLng;
      const dy = r * stepLat;
      const candidates = [
        [cx + dx, cy],
        [cx - dx, cy],
        [cx, cy + dy],
        [cx, cy - dy],
        [cx + dx, cy + dy],
        [cx - dx, cy + dy],
        [cx + dx, cy - dy],
        [cx - dx, cy - dy],
      ];

      for (const [x, y] of candidates) {
        const lng = clamp(x, bb.minLng, bb.maxLng);
        const lat = clamp(y, bb.minLat, bb.maxLat);
        if (pointInPolygonLngLat(lng, lat, poly)) return { lng, lat };
      }
    }

    return { lng: cx, lat: cy };
  }

  function normalizeZoneLabelBaseName(name) {
    let base = String(name || "").trim();
    if (!base) return "";

    base = base.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
    base = base
      .replace(/\b(North|South|East|West)\b$/i, "")
      .replace(/\b(District|Airport|Station)\b$/i, "")
      .replace(/\bPark City\b/i, "Park")
      .replace(/\bSquare\b/gi, "Sq")
      .replace(/\bHeights\b/gi, "Heights")
      .replace(/\bTheatre\b/gi, "Theatre")
      .replace(/\s{2,}/g, " ")
      .trim();

    if (base.length > 18 && !base.includes("\n")) {
      const words = base.split(" ");
      if (words.length >= 2) {
        const splitAt = Math.ceil(words.length / 2);
        base = `${words.slice(0, splitAt).join(" ")}\n${words.slice(splitAt).join(" ")}`;
      }
    }

    return base;
  }

  function getPrimaryPolygonForLabel(geom) {
    if (!geom) return null;
    if (geom.type === "Polygon") return geom.coordinates;
    if (geom.type === "MultiPolygon") return pickLargestPolygonFromMulti(geom.coordinates);
    return null;
  }

  function ringBBox(ring) {
    if (!Array.isArray(ring) || !ring.length) return null;
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    for (const pt of ring) {
      if (!Array.isArray(pt) || pt.length < 2) continue;
      const lng = Number(pt[0]);
      const lat = Number(pt[1]);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      if (lng < minLng) minLng = lng;
      if (lat < minLat) minLat = lat;
      if (lng > maxLng) maxLng = lng;
      if (lat > maxLat) maxLat = lat;
    }
    if (!Number.isFinite(minLng) || !Number.isFinite(minLat) || !Number.isFinite(maxLng) || !Number.isFinite(maxLat)) return null;
    return { minLng, minLat, maxLng, maxLat, width: maxLng - minLng, height: maxLat - minLat };
  }

  function estimateZoneLabelSizeBucket(poly) {
    const outer = Array.isArray(poly) ? poly[0] : null;
    const bb = ringBBox(outer);
    if (!bb) return "sm";
    const area = bb.width * bb.height;
    if (area < 0.00007) return "xs";
    if (area < 0.0002) return "sm";
    if (area < 0.0006) return "md";
    return "lg";
  }

  function splitLabelForZoneShape(label, orientation, sizeBucket) {
    const raw = String(label || "").trim();
    if (!raw) return "";
    if (raw.includes("\n")) return raw;

    const words = raw.split(/\s+/).filter(Boolean);
    if (words.length < 2) return raw;
    if (orientation === 90 || sizeBucket === "xs") {
      return `${words[0]}\n${words.slice(1).join(" ")}`;
    }
    if (sizeBucket === "sm" && raw.length > 11) {
      const idx = Math.ceil(words.length / 2);
      return `${words.slice(0, idx).join(" ")}\n${words.slice(idx).join(" ")}`;
    }
    return raw;
  }

  function getZoneLabelSignature(feature) {
    const props = feature?.properties || {};
    const id = String(props.LocationID ?? "");
    const name = String(props.zone_name || "").trim();
    const geom = feature?.geometry;
    const poly = getPrimaryPolygonForLabel(geom);
    const outer = Array.isArray(poly) ? poly[0] : null;
    const bb = ringBBox(outer);
    const w = bb ? bb.width.toFixed(6) : "0";
    const h = bb ? bb.height.toFixed(6) : "0";
    return `${id}|${name}|${geom?.type || ""}|${w}|${h}`;
  }

  function buildZoneLabelLayoutFeature(feature) {
    const props = feature?.properties || {};
    const locationId = String(props.LocationID ?? "");
    const zoneName = String(props.zone_name || "").trim();
    if (!locationId || !zoneName) return null;

    const override = ZONE_LABEL_OVERRIDES[locationId] || null;
    const poly = getPrimaryPolygonForLabel(feature?.geometry);
    const orientation = 0;
    const sizeBucket = estimateZoneLabelSizeBucket(poly);

    const shortName = override?.label || ZONE_LABEL_SHORT_NAMES[locationId] || normalizeZoneLabelBaseName(zoneName);
    const label = splitLabelForZoneShape(shortName, orientation, sizeBucket);

    const interior = findInteriorPointForGeometry(feature?.geometry);
    if (!interior) return null;

    let lng = Number(interior.lng);
    let lat = Number(interior.lat);
    if (Number.isFinite(Number(override?.anchorLng)) && Number.isFinite(Number(override?.anchorLat))) {
      lng = Number(override.anchorLng);
      lat = Number(override.anchorLat);
    } else {
      if (Number.isFinite(Number(override?.dx))) lng += Number(override.dx);
      if (Number.isFinite(Number(override?.dy))) lat += Number(override.dy);
    }

    const sizeByBucket = { xs: 9.2, sm: 10, md: 10.8, lg: 11.8 };
    const widthByBucket = { xs: 3.0, sm: 4.2, md: 5.0, lg: 6.0 };
    const spacingByBucket = { xs: 0.01, sm: 0.015, md: 0.02, lg: 0.025 };
    const textSize = Number.isFinite(Number(override?.size)) ? Number(override.size) : sizeByBucket[sizeBucket] || 10;
    const textMaxWidth = Number.isFinite(Number(override?.maxWidth)) ? Number(override.maxWidth) : widthByBucket[sizeBucket] || 4.2;
    const letterSpacing = Number.isFinite(Number(override?.letterSpacing)) ? Number(override.letterSpacing) : spacingByBucket[sizeBucket] || 0.015;
    const sortKey = sizeBucket === "lg" ? 3 : sizeBucket === "md" ? 2 : 1;

    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [lng, lat] },
      properties: {
        LocationID: props.LocationID,
        label,
        textSize,
        textMaxWidth,
        letterSpacing,
        sortKey,
      },
    };
  }

  async function ensureZonesSourceAndLayers() {
    const map = core.getMap?.();
    if (!map) return false;
    const styleReady = await core.waitForStyleReady?.();
    if (!styleReady) return false;

    if (!map.getSource("zones")) {
      map.addSource("zones", { type: "geojson", data: core.emptyGeojson?.() || { type: "FeatureCollection", features: [] } });
    }

    const zonesFillColorExpr = [
      "coalesce",
      ["to-string", ["get", "effectiveFillColor"]],
      "#66aaff"
    ];

    if (!map.getLayer("zones-fill")) {
      map.addLayer({
        id: "zones-fill",
        type: "fill",
        source: "zones",
        paint: {
          "fill-color": zonesFillColorExpr,
          "fill-opacity": 1,
        },
      });
    } else {
      map.setPaintProperty("zones-fill", "fill-color", zonesFillColorExpr);
      map.setPaintProperty("zones-fill", "fill-opacity", 1);
    }

    if (!map.getLayer("zones-line")) {
      map.addLayer({
        id: "zones-line",
        type: "line",
        source: "zones",
        paint: { "line-color": "#ffffff", "line-width": 1, "line-opacity": 1 },
      });
    }

    if (!map.getSource("zone-labels")) {
      map.addSource("zone-labels", { type: "geojson", data: core.emptyGeojson?.() || { type: "FeatureCollection", features: [] } });
    }

    const zoneLabelTextSizeExpr = [
      "interpolate",
      ["linear"],
      ["zoom"],
      7, 0,
      8, 0,
      9, 0,
      10, 0,
      11, ["*", ["coalesce", ["get", "textSize"], 10], 0.45],
      12, ["*", ["coalesce", ["get", "textSize"], 10], 0.75],
      15, ["*", ["coalesce", ["get", "textSize"], 10], 1.00]
    ];

    if (!map.getLayer("zone-labels")) {
      map.addLayer({
        id: "zone-labels",
        type: "symbol",
        source: "zone-labels",
        layout: {
          "symbol-placement": "point",
          "text-field": ["coalesce", ["get", "label"], ""],
          "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
          "text-size": zoneLabelTextSizeExpr,
          "text-max-width": ["coalesce", ["get", "textMaxWidth"], 4],
          "text-letter-spacing": ["coalesce", ["get", "letterSpacing"], 0],
          "text-rotate": 0,
          "symbol-sort-key": ["coalesce", ["get", "sortKey"], 0],
          "text-anchor": "center",
          "text-justify": "center",
          "text-allow-overlap": true,
          "text-ignore-placement": true,
          "text-padding": 1.5,
        },
        paint: {
          "text-color": "#1f262e",
          "text-halo-color": "rgba(255,255,255,0)",
          "text-halo-width": 0,
          "text-halo-blur": 0,
        },
        minzoom: LABEL_ZOOM_MIN,
      });
    } else {
      map.setLayoutProperty("zone-labels", "text-size", zoneLabelTextSizeExpr);
      map.setLayoutProperty("zone-labels", "text-max-width", ["coalesce", ["get", "textMaxWidth"], 4]);
      map.setLayoutProperty("zone-labels", "text-letter-spacing", ["coalesce", ["get", "letterSpacing"], 0]);
      map.setLayoutProperty("zone-labels", "text-rotate", 0);
      map.setLayoutProperty("zone-labels", "symbol-sort-key", ["coalesce", ["get", "sortKey"], 0]);
    }

    await core.ensurePickupSourceAndLayers?.();

    await window.TlcZoneEdgeCueModule?.ensureZoneEdgeCueSourceAndLayers?.();

    const frame =
      window.TlcCommunityInternals?.getCurrentFrame?.() ||
      window.TlcModeInternals?.getCurrentFrame?.() ||
      null;

    if (frame) {
      window.TlcZoneEdgeCueModule?.scheduleZoneEdgeCueRefresh?.(frame);
    }

    return true;
  }

  function buildZoneLabelsFeatureCollection(frame) {
    const feats = frame?.polygons?.features || [];
    const out = [];
    for (const f of feats) {
      const signature = getZoneLabelSignature(f);
      const locationId = String(f?.properties?.LocationID ?? "");
      if (!locationId) continue;

      const cacheKey = `${locationId}|${signature}`;
      const cached = zoneLabelLayoutCache.get(cacheKey);
      if (cached) {
        out.push(cached);
        continue;
      }

      const built = buildZoneLabelLayoutFeature(f);
      if (!built) continue;
      zoneLabelLayoutCache.set(cacheKey, built);
      out.push(built);
    }

    return { type: "FeatureCollection", features: out };
  }

  function refreshZoneLabels(frame) {
    const map = core.getMap?.();
    const mapReady = core.isMapReady?.();
    if (!map || !mapReady) return;
    if (!frame) return;
    const src = map.getSource("zone-labels");
    if (!src) return;

    const fc = buildZoneLabelsFeatureCollection(frame);
    src.setData(fc);
    window.TlcZoneEdgeCueModule?.scheduleZoneEdgeCueRefresh?.(frame);
  }

  function getFeatureCollectionBounds(fc) {
    if (!fc || !Array.isArray(fc.features) || fc.features.length === 0) return null;

    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;

    const visitCoordinates = (coords) => {
      if (!Array.isArray(coords)) return;
      if (coords.length >= 2 && Number.isFinite(coords[0]) && Number.isFinite(coords[1])) {
        const lng = coords[0];
        const lat = coords[1];
        if (lng < minLng) minLng = lng;
        if (lat < minLat) minLat = lat;
        if (lng > maxLng) maxLng = lng;
        if (lat > maxLat) maxLat = lat;
        return;
      }
      coords.forEach(visitCoordinates);
    };

    fc.features.forEach((f) => visitCoordinates(f?.geometry?.coordinates));

    if (!Number.isFinite(minLng) || !Number.isFinite(minLat) || !Number.isFinite(maxLng) || !Number.isFinite(maxLat)) {
      return null;
    }
    return { minLng, minLat, maxLng, maxLat };
  }

  // Cache of (bbox, polygon-coords-ring, source feature) entries for each
  // zone polygon in the current frame. Lets snapLatLngToZoneInterior do a
  // single bbox pre-filter pass instead of hammering pointInPolygon on all
  // 263+ zones for every presence row.
  let _snapZoneEntriesCache = null;
  let _snapZoneEntriesSig = null;

  function _frameSig(frame) {
    const features = frame?.polygons?.features;
    return `${String(frame?.time ?? "")}|${Number(features?.length ?? 0)}`;
  }

  function _buildZoneSnapEntries(frame) {
    const sig = _frameSig(frame);
    if (_snapZoneEntriesCache && _snapZoneEntriesSig === sig) return _snapZoneEntriesCache;
    const features = Array.isArray(frame?.polygons?.features) ? frame.polygons.features : [];
    const out = [];
    for (const f of features) {
      const geom = f?.geometry;
      if (!geom) continue;
      const polys = geom.type === "Polygon" ? [geom.coordinates]
        : geom.type === "MultiPolygon" ? geom.coordinates
        : null;
      if (!polys) continue;
      for (const poly of polys) {
        const bb = bboxFromCoords(poly);
        if (!bb) continue;
        out.push({ bb, poly, feature: f });
      }
    }
    _snapZoneEntriesCache = out;
    _snapZoneEntriesSig = sig;
    return out;
  }

  // If (ptLat, ptLng) is inside any zone polygon in `frame`, returns null
  // (caller keeps the original GPS coords). Otherwise returns an interior
  // point of the *nearest* zone — guaranteed to be inside its polygon.
  // Used to keep presence avatars from drifting into water / over edges.
  function snapLatLngToZoneInterior(ptLat, ptLng, frame) {
    if (!Number.isFinite(ptLat) || !Number.isFinite(ptLng)) return null;
    const entries = _buildZoneSnapEntries(frame);
    if (!entries.length) return null;

    for (const { bb, poly } of entries) {
      if (ptLng < bb.minLng || ptLng > bb.maxLng) continue;
      if (ptLat < bb.minLat || ptLat > bb.maxLat) continue;
      if (pointInPolygonLngLat(ptLng, ptLat, poly)) return null;
    }

    let best = null;
    let bestDist = Infinity;
    for (const entry of entries) {
      const cx = (entry.bb.minLng + entry.bb.maxLng) / 2;
      const cy = (entry.bb.minLat + entry.bb.maxLat) / 2;
      const dlat = cy - ptLat;
      const dlng = cx - ptLng;
      const d = dlat * dlat + dlng * dlng;
      if (d < bestDist) {
        bestDist = d;
        best = entry;
      }
    }
    if (!best) return null;
    const interior = findInteriorPointForGeometry(best.feature.geometry);
    return interior || null;
  }

  window.TlcZoneLabelModule = {
    ensureZonesSourceAndLayers,
    refreshZoneLabels,
    getFeatureCollectionBounds,
    snapLatLngToZoneInterior,
  };

  function announceZoneOwnerReady() {
    window.__TLC_ZONE_OWNER_READY__ = true;
    window.__TLC_ZONE_OWNER_READY_AT__ = Date.now();
    window.dispatchEvent(new CustomEvent("tlc-zone-owner-ready", {
      detail: {
        source: "app.part12.js",
        ready: true
      }
    }));
  }

  window.isTlcZoneOwnerReady = function isTlcZoneOwnerReady() {
    return !!(
      window.__TLC_ZONE_OWNER_READY__ &&
      window.TlcZoneLabelModule &&
      typeof window.TlcZoneLabelModule.ensureZonesSourceAndLayers === "function" &&
      typeof window.TlcZoneLabelModule.refreshZoneLabels === "function"
    );
  };

  window.getTlcZoneOwnerStatus = function getTlcZoneOwnerStatus() {
    return {
      readyFlag: !!window.__TLC_ZONE_OWNER_READY__,
      readyAt: Number(window.__TLC_ZONE_OWNER_READY_AT__ || 0),
      hasZoneModule: !!window.TlcZoneLabelModule,
      hasEnsureZonesSourceAndLayers: typeof window.TlcZoneLabelModule?.ensureZonesSourceAndLayers === "function",
      hasRefreshZoneLabels: typeof window.TlcZoneLabelModule?.refreshZoneLabels === "function"
    };
  };

  announceZoneOwnerReady();
})();
