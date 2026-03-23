(function() {
  const runtime = window.FrontendRuntime || null;
  const runtimePolling = runtime?.polling || null;
  const core = window.TlcZoneLabelInternals || {};

  const LABEL_ZOOM_MIN = 10;
  const BOROUGH_ZOOM_SHOW = 15;
  const LABEL_MAX_CHARS_MID = 14;
  const ZONE_EDGE_INFLUENCE_MIN_ZOOM = 11.8;
  const EDGE_INFLUENCE_SOURCE_ID = "zone-edge-influence";
  const EDGE_INFLUENCE_HALO_LAYER_ID = "zone-edge-influence-halo";
  const EDGE_INFLUENCE_SOFT_LAYER_ID = "zone-edge-influence-soft";
  const EDGE_INFLUENCE_CORE_LAYER_ID = "zone-edge-influence-core";
  const EDGE_INFLUENCE_MIN_RATING_DIFF = 10;
  const EDGE_INFLUENCE_MAX_RATING_DIFF = 30;
  const EDGE_INFLUENCE_CHUNK_DEG = 0.00020;
  const EDGE_INFLUENCE_KEY_DP = 5;

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
  let zoneEdgeTopologyCache = [];
  let zoneEdgeTopologySignature = "";
  let zoneEdgeInfluenceFingerprint = "";
  let zoneEdgeInfluenceFeatureCount = 0;
  let pickupHotspotShieldZoneIds = new Set();

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

  function refreshZoneEdgeInfluenceFromCurrentFrame() {
    const frame = window.TlcCommunityInternals?.getCurrentFrame?.() || window.TlcModeInternals?.getCurrentFrame?.();
    refreshZoneEdgeInfluence(frame || null);
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

  function estimatePolygonOrientationDegrees(poly) {
    const outer = Array.isArray(poly) ? poly[0] : null;
    const bb = ringBBox(outer);
    if (!outer || !bb) return 0;

    if (bb.height > bb.width * 1.65) return 90;
    if (bb.width > bb.height * 1.65) return 0;

    let bestLen2 = 0;
    let bestAngle = 0;
    for (let i = 1; i < outer.length; i++) {
      const a = outer[i - 1];
      const b = outer[i];
      if (!a || !b) continue;
      const dx = Number(b[0]) - Number(a[0]);
      const dy = Number(b[1]) - Number(a[1]);
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
      const len2 = dx * dx + dy * dy;
      if (len2 > bestLen2) {
        bestLen2 = len2;
        bestAngle = (Math.atan2(dy, dx) * 180) / Math.PI;
      }
    }

    const normalized = ((bestAngle + 180) % 360) - 180;
    const candidates = [0, 90, 45, -45];
    let snapped = 0;
    let bestDiff = Infinity;
    for (const c of candidates) {
      const d = Math.min(Math.abs(normalized - c), Math.abs(normalized - (c + 180)), Math.abs(normalized - (c - 180)));
      if (d < bestDiff) {
        bestDiff = d;
        snapped = c;
      }
    }
    if (bestDiff > 28) return 0;
    return snapped;
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

  function zoneBucketRank(bucket) {
    switch (String(bucket || "").trim().toLowerCase()) {
      case "green": return 6;
      case "purple": return 5;
      case "blue": return 4;
      case "sky": return 3;
      case "yellow": return 2;
      case "red": return 1;
      default: return 0;
    }
  }

  function edgeCoordKey(coord) {
    const lng = Number(coord?.[0]);
    const lat = Number(coord?.[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return "";
    return `${lng.toFixed(EDGE_INFLUENCE_KEY_DP)}|${lat.toFixed(EDGE_INFLUENCE_KEY_DP)}`;
  }

  function edgeSegmentKey(a, b) {
    const aKey = edgeCoordKey(a);
    const bKey = edgeCoordKey(b);
    return aKey <= bKey ? `${aKey}__${bKey}` : `${bKey}__${aKey}`;
  }

  function splitSegmentIntoEdgeChunks(startCoord, endCoord) {
    const startLng = Number(startCoord?.[0]);
    const startLat = Number(startCoord?.[1]);
    const endLng = Number(endCoord?.[0]);
    const endLat = Number(endCoord?.[1]);
    if (!Number.isFinite(startLng) || !Number.isFinite(startLat) || !Number.isFinite(endLng) || !Number.isFinite(endLat)) return [];

    const dx = endLng - startLng;
    const dy = endLat - startLat;
    const length = Math.sqrt((dx * dx) + (dy * dy));
    const steps = Math.max(1, Math.min(12, Math.ceil(length / EDGE_INFLUENCE_CHUNK_DEG)));
    const points = [];

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      points.push([
        startLng + (dx * t),
        startLat + (dy * t),
      ]);
    }

    const chunks = [];
    for (let i = 1; i < points.length; i++) {
      chunks.push([points[i - 1], points[i]]);
    }
    return chunks;
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

  function buildZoneEdgeTopology(frame) {
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

          const chunks = splitSegmentIntoEdgeChunks(startCoord, endCoord);
          for (const chunk of chunks) {
            const chunkStart = chunk?.[0];
            const chunkEnd = chunk?.[1];
            if (!Array.isArray(chunkStart) || !Array.isArray(chunkEnd)) continue;
            const key = edgeSegmentKey(chunkStart, chunkEnd);
            if (!key) continue;
            const occurrences = segmentMap.get(key) || [];
            occurrences.push({
              zoneId,
              coords: [chunkStart, chunkEnd],
              interiorSide,
            });
            segmentMap.set(key, occurrences);
          }
        }
      });
    }

    const topology = [];
    for (const occurrences of segmentMap.values()) {
      if (!Array.isArray(occurrences) || occurrences.length !== 2) continue;
      const byZoneId = new Map();
      for (const occurrence of occurrences) {
        if (!occurrence?.zoneId) continue;
        if (!byZoneId.has(occurrence.zoneId)) byZoneId.set(occurrence.zoneId, occurrence);
      }
      if (byZoneId.size !== 2) continue;
      const [a, b] = Array.from(byZoneId.values());
      if (!a || !b || a.zoneId === b.zoneId) continue;
      topology.push({
        aZoneId: a.zoneId,
        bZoneId: b.zoneId,
        aCoords: a.coords,
        bCoords: b.coords,
        aInteriorSide: a.interiorSide,
        bInteriorSide: b.interiorSide,
      });
    }

    return topology;
  }

  function getZoneEdgeTopology(frame) {
    const features = frame?.polygons?.features || [];
    const signature = features
      .map((feature) => getZoneLabelSignature(feature))
      .sort()
      .join("###");
    if (signature === zoneEdgeTopologySignature) return zoneEdgeTopologyCache;
    zoneEdgeTopologySignature = signature;
    zoneEdgeTopologyCache = buildZoneEdgeTopology(frame);
    return zoneEdgeTopologyCache;
  }

  function orientSegmentIntoZoneRightSide(coords, interiorSide) {
    if (!Array.isArray(coords) || coords.length < 2) return coords;
    if (interiorSide === "right") return coords;
    return [coords[1], coords[0]];
  }

  function getFeatureEffectiveRatingForEdge(feature) {
    const rating = window.TlcModeModule?.effectiveRating?.(feature?.properties || {}, feature?.geometry);
    return Number.isFinite(rating) ? rating : NaN;
  }

  function clamp01(v) {
    return Math.max(0, Math.min(1, Number(v) || 0));
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

  // Stronger zone edges next to weaker-bucket neighbors get a subtle inward hue
  // from the weaker zone. Same-bucket neighbors do not get this effect; this is
  // only a heuristic visual hint, not measured sub-zone demand truth.
  function buildZoneEdgeInfluenceFeatureCollection(frame) {
    const topology = getZoneEdgeTopology(frame);
    const features = frame?.polygons?.features || [];
    const zoneFeatureMap = new Map();
    for (const feature of features) {
      const zoneId = String(feature?.properties?.LocationID ?? "");
      if (zoneId) zoneFeatureMap.set(zoneId, feature);
    }

    const edgeFeatures = [];
    for (const edge of topology) {
      const featureA = zoneFeatureMap.get(edge.aZoneId);
      const featureB = zoneFeatureMap.get(edge.bZoneId);
      if (!featureA || !featureB) continue;

      const ratingA = getFeatureEffectiveRatingForEdge(featureA);
      const ratingB = getFeatureEffectiveRatingForEdge(featureB);
      if (!Number.isFinite(ratingA) || !Number.isFinite(ratingB)) continue;

      const bucketA = window.TlcModeModule?.effectiveBucket?.(featureA.properties || {}, featureA.geometry) || featureA.properties?.bucket || "";
      const bucketB = window.TlcModeModule?.effectiveBucket?.(featureB.properties || {}, featureB.geometry) || featureB.properties?.bucket || "";
      const rankA = zoneBucketRank(bucketA);
      const rankB = zoneBucketRank(bucketB);
      if (rankA === rankB) continue;

      const diff = Math.abs(ratingA - ratingB);
      if (diff < EDGE_INFLUENCE_MIN_RATING_DIFF) continue;

      const aIsStronger = rankA > rankB;
      const strongerZoneId = aIsStronger ? edge.aZoneId : edge.bZoneId;
      const weakerZoneId = aIsStronger ? edge.bZoneId : edge.aZoneId;
      if (isPickupHotspotShieldedZone(strongerZoneId)) continue;
      const strongerFeature = aIsStronger ? featureA : featureB;
      const weakerFeature = aIsStronger ? featureB : featureA;
      const strongerCoords = aIsStronger ? edge.aCoords : edge.bCoords;
      const strongerInteriorSide = aIsStronger ? edge.aInteriorSide : edge.bInteriorSide;
      const orientedCoords = orientSegmentIntoZoneRightSide(strongerCoords, strongerInteriorSide);
      const edgeStrength = clamp01((diff - EDGE_INFLUENCE_MIN_RATING_DIFF) / (EDGE_INFLUENCE_MAX_RATING_DIFF - EDGE_INFLUENCE_MIN_RATING_DIFF));
      const edgeColor = getFeatureBaseColorForEdge(weakerFeature);
      const haloWidthPx = 30 + (edgeStrength * 16);
      const softWidthPx = 16 + (edgeStrength * 8);
      const coreWidthPx = 6 + (edgeStrength * 4);
      const haloOpacity = 0.004 + (edgeStrength * 0.018);
      const softOpacity = 0.008 + (edgeStrength * 0.024);
      const coreOpacity = 0.012 + (edgeStrength * 0.028);
      const haloOffsetPx = 8 + (edgeStrength * 4.5);
      const softOffsetPx = 4.5 + (edgeStrength * 2.8);
      const coreOffsetPx = 2 + (edgeStrength * 1.4);

      if (!strongerFeature || !Array.isArray(orientedCoords) || orientedCoords.length < 2) continue;

      edgeFeatures.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: orientedCoords,
        },
        properties: {
          edge_color: edgeColor,
          strong_zone_id: strongerZoneId,
          weak_zone_id: weakerZoneId,
          rating_diff: diff,
          edge_strength: edgeStrength,
          halo_width_px: haloWidthPx,
          soft_width_px: softWidthPx,
          core_width_px: coreWidthPx,
          halo_opacity: haloOpacity,
          soft_opacity: softOpacity,
          core_opacity: coreOpacity,
          halo_offset_px: haloOffsetPx,
          soft_offset_px: softOffsetPx,
          core_offset_px: coreOffsetPx,
        },
      });
    }

    return {
      type: "FeatureCollection",
      features: edgeFeatures,
    };
  }

  function zoneEdgeInfluenceFingerprintFromFc(fc) {
    const rows = Array.isArray(fc?.features) ? fc.features.map((feature) => {
      const props = feature?.properties || {};
      const coords = feature?.geometry?.coordinates || [];
      const firstKey = Array.isArray(coords[0]) ? edgeCoordKey(coords[0]) : "";
      const lastKey = Array.isArray(coords[coords.length - 1]) ? edgeCoordKey(coords[coords.length - 1]) : "";
      return [
        String(props.strong_zone_id ?? ""),
        String(props.weak_zone_id ?? ""),
        Number(props.rating_diff || 0).toFixed(4),
        Number(props.edge_strength || 0).toFixed(4),
        firstKey,
        lastKey,
      ].join("|");
    }) : [];
    return rows.sort().join("###");
  }

  function clearZoneEdgeInfluenceSource() {
    const map = core.getMap?.();
    const edgeSrc = map?.getSource?.(EDGE_INFLUENCE_SOURCE_ID);
    if (!edgeSrc) return;
    edgeSrc.setData(core.emptyGeojson?.() || { type: "FeatureCollection", features: [] });
    zoneEdgeInfluenceFingerprint = "";
    zoneEdgeInfluenceFeatureCount = 0;
  }

  function isZoneEdgeInfluenceZoomActive() {
    const map = core.getMap?.();
    const zoom = Number(map?.getZoom?.());
    return Number.isFinite(zoom) && zoom >= ZONE_EDGE_INFLUENCE_MIN_ZOOM;
  }

  function refreshZoneEdgeInfluence(frame) {
    const map = core.getMap?.();
    const mapReady = core.isMapReady?.();
    if (!map || !mapReady) return;

    const edgeSrc = map.getSource(EDGE_INFLUENCE_SOURCE_ID);
    if (!edgeSrc) return;

    if (!frame) {
      clearZoneEdgeInfluenceSource();
      return;
    }

    const edgeFc = buildZoneEdgeInfluenceFeatureCollection(frame);
    zoneEdgeInfluenceFeatureCount = Array.isArray(edgeFc?.features) ? edgeFc.features.length : 0;
    const edgeFingerprint = zoneEdgeInfluenceFingerprintFromFc(edgeFc);
    if (edgeFingerprint === zoneEdgeInfluenceFingerprint) return;
    edgeSrc.setData(edgeFc);
    zoneEdgeInfluenceFingerprint = edgeFingerprint;
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
        textRotate: orientation,
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

    if (!map.getSource(EDGE_INFLUENCE_SOURCE_ID)) {
      map.addSource(EDGE_INFLUENCE_SOURCE_ID, { type: "geojson", data: core.emptyGeojson?.() || { type: "FeatureCollection", features: [] } });
      zoneEdgeInfluenceFingerprint = "";
      zoneEdgeInfluenceFeatureCount = 0;
    }

    // fill alpha now comes from effectiveFillColor
    // keep fill-opacity at 1 so only the feature color alpha controls dimming
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

    const edgeHaloWidthScaleExpr = [
      "interpolate",
      ["linear"],
      ["zoom"],
      11.8, 0.18,
      12.2, 0.26,
      12.8, 0.40,
      13.4, 0.60,
      14.2, 0.82,
      15.0, 1.00,
      16.0, 1.08
    ];

    const edgeSoftWidthScaleExpr = [
      "interpolate",
      ["linear"],
      ["zoom"],
      11.8, 0.22,
      12.2, 0.32,
      12.8, 0.46,
      13.4, 0.66,
      14.2, 0.86,
      15.0, 1.00,
      16.0, 1.06
    ];

    const edgeCoreWidthScaleExpr = [
      "interpolate",
      ["linear"],
      ["zoom"],
      11.8, 0.30,
      12.2, 0.42,
      12.8, 0.58,
      13.4, 0.76,
      14.2, 0.92,
      15.0, 1.00,
      16.0, 1.04
    ];

    const edgeHaloOffsetScaleExpr = [
      "interpolate",
      ["linear"],
      ["zoom"],
      11.8, 0.25,
      12.2, 0.36,
      12.8, 0.50,
      13.4, 0.68,
      14.2, 0.86,
      15.0, 1.00,
      16.0, 1.04
    ];

    const edgeSoftOffsetScaleExpr = [
      "interpolate",
      ["linear"],
      ["zoom"],
      11.8, 0.30,
      12.2, 0.42,
      12.8, 0.58,
      13.4, 0.74,
      14.2, 0.90,
      15.0, 1.00,
      16.0, 1.03
    ];

    const edgeCoreOffsetScaleExpr = [
      "interpolate",
      ["linear"],
      ["zoom"],
      11.8, 0.36,
      12.2, 0.50,
      12.8, 0.66,
      13.4, 0.82,
      14.2, 0.94,
      15.0, 1.00,
      16.0, 1.02
    ];

    const edgeHaloOpacityZoomExpr = [
      "interpolate",
      ["linear"],
      ["zoom"],
      11.8, 0.40,
      12.2, 0.52,
      12.8, 0.68,
      13.4, 0.82,
      14.2, 0.92,
      15.0, 1.00,
      16.0, 1.00
    ];

    const edgeSoftOpacityZoomExpr = [
      "interpolate",
      ["linear"],
      ["zoom"],
      11.8, 0.46,
      12.2, 0.58,
      12.8, 0.72,
      13.4, 0.84,
      14.2, 0.94,
      15.0, 1.00,
      16.0, 1.00
    ];

    const edgeCoreOpacityZoomExpr = [
      "interpolate",
      ["linear"],
      ["zoom"],
      11.8, 0.52,
      12.2, 0.64,
      12.8, 0.78,
      13.4, 0.88,
      14.2, 0.96,
      15.0, 1.00,
      16.0, 1.00
    ];

    // Inward hue overlay only on the stronger side of meaningful stronger-vs-weaker borders.
    // Keep the white divider line intact above it and remain weaker than hotspot / micro-hotspot overlays.
    if (!map.getLayer(EDGE_INFLUENCE_HALO_LAYER_ID)) {
      map.addLayer({
        id: EDGE_INFLUENCE_HALO_LAYER_ID,
        type: "line",
        source: EDGE_INFLUENCE_SOURCE_ID,
        minzoom: ZONE_EDGE_INFLUENCE_MIN_ZOOM,
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
        paint: {
          "line-color": ["coalesce", ["to-string", ["get", "edge_color"]], "#ffffff"],
          "line-opacity": ["*", ["coalesce", ["to-number", ["get", "halo_opacity"]], 0], edgeHaloOpacityZoomExpr],
          "line-width": ["*", ["coalesce", ["to-number", ["get", "halo_width_px"]], 30], edgeHaloWidthScaleExpr],
          "line-blur": [
            "interpolate",
            ["linear"],
            ["zoom"],
            12.4, 10,
            14, 12,
            16, 14,
          ],
          "line-offset": ["*", ["coalesce", ["to-number", ["get", "halo_offset_px"]], 8], edgeHaloOffsetScaleExpr],
        },
      }, "zones-line");
    }

    if (!map.getLayer(EDGE_INFLUENCE_SOFT_LAYER_ID)) {
      map.addLayer({
        id: EDGE_INFLUENCE_SOFT_LAYER_ID,
        type: "line",
        source: EDGE_INFLUENCE_SOURCE_ID,
        minzoom: ZONE_EDGE_INFLUENCE_MIN_ZOOM,
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
        paint: {
          "line-color": ["coalesce", ["to-string", ["get", "edge_color"]], "#ffffff"],
          "line-opacity": ["*", ["coalesce", ["to-number", ["get", "soft_opacity"]], 0], edgeSoftOpacityZoomExpr],
          "line-width": ["*", ["coalesce", ["to-number", ["get", "soft_width_px"]], 16], edgeSoftWidthScaleExpr],
          "line-blur": [
            "interpolate",
            ["linear"],
            ["zoom"],
            12.4, 4.5,
            14, 5.5,
            16, 6.5,
          ],
          "line-offset": ["*", ["coalesce", ["to-number", ["get", "soft_offset_px"]], 4.5], edgeSoftOffsetScaleExpr],
        },
      }, "zones-line");
    }

    if (!map.getLayer(EDGE_INFLUENCE_CORE_LAYER_ID)) {
      map.addLayer({
        id: EDGE_INFLUENCE_CORE_LAYER_ID,
        type: "line",
        source: EDGE_INFLUENCE_SOURCE_ID,
        minzoom: ZONE_EDGE_INFLUENCE_MIN_ZOOM,
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
        paint: {
          "line-color": ["coalesce", ["to-string", ["get", "edge_color"]], "#ffffff"],
          "line-opacity": ["*", ["coalesce", ["to-number", ["get", "core_opacity"]], 0], edgeCoreOpacityZoomExpr],
          "line-width": ["*", ["coalesce", ["to-number", ["get", "core_width_px"]], 6], edgeCoreWidthScaleExpr],
          "line-blur": [
            "interpolate",
            ["linear"],
            ["zoom"],
            12.4, 1.4,
            14, 1.8,
            16, 2.2,
          ],
          "line-offset": ["*", ["coalesce", ["to-number", ["get", "core_offset_px"]], 2], edgeCoreOffsetScaleExpr],
        },
      }, "zones-line");
    }

    if (!map.getSource("zone-labels")) {
      map.addSource("zone-labels", { type: "geojson", data: core.emptyGeojson?.() || { type: "FeatureCollection", features: [] } });
    }

    if (!map.getLayer("zone-labels")) {
      map.addLayer({
        id: "zone-labels",
        type: "symbol",
        source: "zone-labels",
        layout: {
          "symbol-placement": "point",
          "text-field": ["coalesce", ["get", "label"], ""],
          "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
          "text-size": [
            "interpolate",
            ["linear"],
            ["zoom"],
            7, 0,
            8, 0,
            9, 0,
            10, 0,
            11, 5,
            12, 9,
            15, 20,
          ],
          "text-max-width": ["coalesce", ["get", "textMaxWidth"], 4],
          "text-letter-spacing": ["coalesce", ["get", "letterSpacing"], 0],
          "text-rotate": ["coalesce", ["get", "textRotate"], 0],
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
    }

    await core.ensurePickupSourceAndLayers?.();

    if (!map.__zoneEdgeInfluenceZoomRefreshBound) {
      map.__zoneEdgeInfluenceZoomRefreshBound = true;
      map.on("zoomend", () => {
        if (!isZoneEdgeInfluenceZoomActive()) {
          clearZoneEdgeInfluenceSource();
          return;
        }
        refreshZoneEdgeInfluenceFromCurrentFrame();
      });
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
    refreshZoneEdgeInfluence(frame);
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

  window.TlcZoneLabelModule = {
    ensureZonesSourceAndLayers,
    refreshZoneLabels,
    refreshZoneEdgeInfluence,
    getFeatureCollectionBounds
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

  syncPickupHotspotShieldZoneIdsFromSource();
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("tlc-pickup-hotspot-zones-updated", (event) => {
      setPickupHotspotShieldZoneIds(event?.detail?.hotspotZoneIds || []);
      refreshZoneEdgeInfluenceFromCurrentFrame();
    });
  }

  window.getZoneEdgeInfluenceDebug = function () {
    const map = core.getMap?.();
    return {
      topologyCount: Array.isArray(zoneEdgeTopologyCache) ? zoneEdgeTopologyCache.length : 0,
      topologySignature: zoneEdgeTopologySignature || "",
      fingerprint: zoneEdgeInfluenceFingerprint || "",
      featureCount: zoneEdgeInfluenceFeatureCount,
      zoomActive: isZoneEdgeInfluenceZoomActive(),
      hotspotShieldZoneIds: Array.from(pickupHotspotShieldZoneIds || []).sort(),
      sourceReady: !!map?.getSource?.(EDGE_INFLUENCE_SOURCE_ID),
      haloLayerReady: !!map?.getLayer?.(EDGE_INFLUENCE_HALO_LAYER_ID),
      softLayerReady: !!map?.getLayer?.(EDGE_INFLUENCE_SOFT_LAYER_ID),
      coreLayerReady: !!map?.getLayer?.(EDGE_INFLUENCE_CORE_LAYER_ID),
    };
  };
})();