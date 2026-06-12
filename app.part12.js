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

    // Zoom-aware zone transparency. Zones stay at full, solid color when
    // zoomed out (borough/overview — easy to compare zones at a glance),
    // then ramp to 40% opacity (60% transparent) as the driver zooms in
    // close, so the street layout underneath shows through for navigation.
    // Linear between z11 (opaque) and z16 (60% transparent); held at 0.4
    // beyond z16. Fade begins at z11 so the transparency comes in earlier
    // (less zooming). Tune the 11/16 breakpoints or the 0.4 floor to taste.
    const zonesFillOpacityExpr = [
      "interpolate", ["linear"], ["zoom"],
      11, 1,
      16, 0.4
    ];

    if (!map.getLayer("zones-fill")) {
      map.addLayer({
        id: "zones-fill",
        type: "fill",
        source: "zones",
        paint: {
          "fill-color": zonesFillColorExpr,
          "fill-opacity": zonesFillOpacityExpr,
        },
      });
    } else {
      map.setPaintProperty("zones-fill", "fill-color", zonesFillColorExpr);
      map.setPaintProperty("zones-fill", "fill-opacity", zonesFillOpacityExpr);
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

    // Demand-trend labels: a catchy on-map badge under the zone name that warns
    // when the NEXT 20-minute bin changes the zone's color bucket (▲ heating /
    // ▼ cooling) and at what clock time. Rendered as its own symbol layer
    // because the trend changes every frame & with the selected mode (the zone
    // name layer is geometry-cached and stable).
    if (!map.getSource("zone-trend-labels")) {
      map.addSource("zone-trend-labels", { type: "geojson", data: core.emptyGeojson?.() || { type: "FeatureCollection", features: [] } });
    }
    const zoneTrendIconSizeExpr = [
      "interpolate", ["linear"], ["zoom"],
      // Mirror the zone-name text-size zoom curve exactly (0 below z11, then the
      // 0.45 -> 0.75 -> 1.0 factor). The sprite's 14px font is ~1.3x a typical
      // zone name (~10.8px), so badges scale with zoom identically to names but
      // ~30% larger -- and shrink/disappear when zoomed out, preventing the
      // crowded look from afar.
      7, 0,
      8, 0,
      9, 0,
      10, 0,
      11, 0.45,
      12, 0.75,
      15, 1.0
    ];
    if (!map.getLayer("zone-trend-labels")) {
      map.addLayer({
        id: "zone-trend-labels",
        type: "symbol",
        source: "zone-trend-labels",
        layout: {
          "symbol-placement": "point",
          // Nearer zones (lower sort key) are placed first, so they win
          // collision over far-away ones.
          "symbol-sort-key": ["get", "sortKey"],
          // Drawn as a canvas sprite (icon), NOT map text: the basemap font has
          // no arrow glyphs, so "7:40 ↑" is rendered to a canvas and registered
          // via map.addImage() -- the codebase's reliable cross-device approach.
          "icon-image": ["get", "trendSprite"],
          "icon-size": zoneTrendIconSizeExpr,
          "icon-anchor": "top",
          "icon-offset": [0, 12],
          // Collision ON: from afar, crowded badges (dense small Manhattan
          // zones) drop out for a clean look; zooming in opens space so more
          // appear. Names stay always-on (they ignore placement), so badges
          // only ever thin against each other.
          "icon-allow-overlap": false,
          "icon-ignore-placement": false,
          "icon-padding": 2,
        },
        minzoom: LABEL_ZOOM_MIN,
      });
    } else {
      map.setLayoutProperty("zone-trend-labels", "icon-size", zoneTrendIconSizeExpr);
    }

    await core.ensurePickupSourceAndLayers?.();

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

  function formatBinClockLabel(iso) {
    const m = String(iso || "").match(/T(\d{2}):(\d{2})/);
    if (!m) return "";
    let hour = parseInt(m[1], 10);
    const minute = m[2];
    const meridiem = hour >= 12 ? "PM" : "AM";
    hour = hour % 12;
    if (hour === 0) hour = 12;
    // Compact, context-obvious (the current frame's full time is shown in the
    // scrubber): "7:20" rather than "7:20 AM".
    void meridiem;
    return `${hour}:${minute}`;
  }

  // Track the driver's location (from the geolocation watch in app.js, via the
  // existing 'tlc-user-location-updated' event) so trend badges near the driver
  // win collision over far-away ones. Falls back to the map view center when no
  // location is available.
  let trendDriverLngLat = null;
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("tlc-user-location-updated", (e) => {
      const d = (e && e.detail) || {};
      if (Number.isFinite(d.lng) && Number.isFinite(d.lat)) trendDriverLngLat = [Number(d.lng), Number(d.lat)];
    });
  }

  // Render the trend badge text ("7:40 ↑") to a canvas and register it with the
  // map as an icon. Used instead of map text because the basemap font has no
  // arrow glyphs (they render blank) -- a canvas uses the full system fonts, the
  // codebase's reliable cross-device approach (see strategic-points sprites).
  // Built once per (direction, time) id.
  function ensureTrendSprite(map, id, text, color, fontPx) {
    try {
      if (typeof map.hasImage === "function" && map.hasImage(id)) return;
      const dpr = 2;
      const size = Math.max(8, Math.round(Number(fontPx) || 14));
      const font = `800 ${size}px -apple-system, system-ui, "Segoe UI", Roboto, Arial, sans-serif`;
      const gauge = document.createElement("canvas").getContext("2d");
      gauge.font = font;
      const padX = 5;
      const padY = 3;
      const w = Math.ceil(gauge.measureText(text).width) + padX * 2;
      const h = size + padY * 2;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      const ctx = canvas.getContext("2d");
      ctx.scale(dpr, dpr);
      ctx.font = font;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      // White outline so it reads on any zone color.
      ctx.lineJoin = "round";
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = "rgba(255,255,255,0.96)";
      ctx.strokeText(text, padX, h / 2);
      ctx.fillStyle = color;
      ctx.fillText(text, padX, h / 2);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      map.addImage(id, { width: canvas.width, height: canvas.height, data: data.data }, { pixelRatio: dpr });
    } catch (e) {
      /* non-fatal: skip the badge if sprite creation fails */
    }
  }

  // Build the per-zone demand-trend badges for the selected mode: every rated
  // zone gets the next-bin time + a direction glyph -- "7:40 ↑" rising /
  // "7:40 ↓" cooling / "7:40 =" holding -- colored with the bucket color the
  // zone will be NEXT bin, so the hue previews the upcoming state. The
  // proximity declutter (symbol-sort-key) thins them where they crowd.
  function buildZoneTrendLabelsFeatureCollection(frame) {
    const modeModule = window.TlcModeModule || {};
    const getBase = modeModule.getModeAwareBaseRating;
    const getNext = modeModule.getModeAwareNextBinRating;
    const getColor = typeof modeModule.getColorForRating === "function" ? modeModule.getColorForRating : null;
    const map = core.getMap?.();
    if (!map || typeof getBase !== "function" || typeof getNext !== "function") {
      return { type: "FeatureCollection", features: [] };
    }
    const timeLabel = formatBinClockLabel(frame?.next_time);
    const timeKey = String(timeLabel).replace(/[^0-9]/g, "") || "x";
    const upText = timeLabel ? `${timeLabel} ↑` : "↑";
    const downText = timeLabel ? `${timeLabel} ↓` : "↓";
    const sameText = timeLabel ? `${timeLabel} =` : "=";
    // "Near" reference for collision priority: the driver's location, else the
    // current map view center.
    let anchorLng = null;
    let anchorLat = null;
    if (trendDriverLngLat) {
      anchorLng = trendDriverLngLat[0];
      anchorLat = trendDriverLngLat[1];
    } else if (typeof map.getCenter === "function") {
      const c = map.getCenter();
      anchorLng = c && c.lng;
      anchorLat = c && c.lat;
    }
    const feats = frame?.polygons?.features || [];
    const out = [];
    for (const f of feats) {
      const props = f?.properties || {};
      const locationId = String(props.LocationID ?? "");
      if (!locationId) continue;
      const geom = f?.geometry;
      const cur = getBase(props, geom);
      if (!Number.isFinite(cur)) continue;
      const nxt = getNext(props, geom);
      // Three-way next-bin trend for every rated zone: up if the next bin is
      // higher, down if lower, = if it holds (or has no forecast). Compare the
      // rounded 0-100 ratings so sub-point noise reads as "same".
      let dir = "same";
      if (Number.isFinite(nxt)) {
        const delta = Math.round(nxt) - Math.round(cur);
        dir = delta > 0 ? "up" : (delta < 0 ? "down" : "same");
      }
      // Reuse the cached zone-name position so the trend sits under the name.
      const signature = getZoneLabelSignature(f);
      const layout = zoneLabelLayoutCache.get(`${locationId}|${signature}`) || buildZoneLabelLayoutFeature(f);
      if (!layout || !layout.geometry) continue;
      // Size the badge to the zone exactly like the name does (small Manhattan
      // zones -> small badges that fit and don't drift out of the zone), then
      // +30%. Keyed so each (size, direction, time) sprite is built once.
      const nameSize = Number(layout.properties && layout.properties.textSize) || 10;
      const badgeFont = Math.max(9, Math.round(nameSize * 1.3));
      const dirText = dir === "up" ? upText : (dir === "down" ? downText : sameText);
      // Arrow color = the bucket color the zone will be NEXT bin (the held color
      // when steady), so the hue previews the upcoming state while the glyph
      // shows the direction. The white halo keeps it legible over a like-colored
      // zone. Encode the color into the sprite id so each hue caches separately.
      const colorRating = Number.isFinite(nxt) ? nxt : cur;
      const nextColor = getColor ? getColor(colorRating) : (dir === "up" ? "#0a8f2c" : dir === "down" ? "#d12727" : "#5a6573");
      const colorKey = String(nextColor).replace(/[^0-9a-zA-Z]/g, "");
      const spriteId = `zone-trend-${dir}-${colorKey}-${timeKey}-${badgeFont}`;
      ensureTrendSprite(map, spriteId, dirText, nextColor, badgeFont);
      // Collision priority: nearer zones get a lower sort key, so when badges
      // overlap (dense Manhattan, zoomed out) the ones near the driver survive
      // and far ones drop.
      const coords = (layout.geometry && layout.geometry.coordinates) || [];
      let sortKey = 0;
      if (Number.isFinite(anchorLng) && Number.isFinite(Number(coords[0]))) {
        const dLng = Number(coords[0]) - anchorLng;
        const dLat = Number(coords[1]) - anchorLat;
        sortKey = Math.round((dLng * dLng + dLat * dLat) * 1e7);
      }
      out.push({
        type: "Feature",
        geometry: layout.geometry,
        properties: { LocationID: props.LocationID, trendSprite: spriteId, sortKey },
      });
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

    // Demand-trend labels live in their own source so they refresh every frame
    // and on mode change (the zone-name layer is geometry-cached and stable).
    const trendSrc = map.getSource("zone-trend-labels");
    if (trendSrc) {
      trendSrc.setData(buildZoneTrendLabelsFeatureCollection(frame));
    }
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
