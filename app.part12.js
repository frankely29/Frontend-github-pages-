(function() {
  const runtime = window.FrontendRuntime || null;
  const runtimePolling = runtime?.polling || null;
  const core = window.TlcZoneLabelInternals || {};

  const LABEL_ZOOM_MIN = 10;
  const BOROUGH_ZOOM_SHOW = 15;
  const LABEL_MAX_CHARS_MID = 14;
  const ZONE_EDGE_INFLUENCE_MIN_ZOOM = 12.2;
  const EDGE_INFLUENCE_SOURCE_ID = "zone-edge-influence";
  const EDGE_INFLUENCE_BASE_LAYER_ID = "zone-edge-cue-base";
  const EDGE_INFLUENCE_INNER_LAYER_ID = "zone-edge-cue-inner";
  const EDGE_INFLUENCE_LEGACY_LAYER_IDS = [
    "zone-edge-influence-halo",
    "zone-edge-influence-soft",
    "zone-edge-influence-core",
    "zone-edge-influence-seed",
  ];
  const EDGE_INFLUENCE_MIN_RATING_DIFF = 6;
  const EDGE_INFLUENCE_MAX_RATING_DIFF = 30;
  const EDGE_INFLUENCE_KEY_DP = 5;
  const EDGE_INFLUENCE_MATCH_GRID_DEG = 0.00045;
  const EDGE_INFLUENCE_MATCH_MAX_DIST_DEG = 0.00045;
  const EDGE_INFLUENCE_MATCH_ANGLE_BUCKET_DEG = 15;
  const EDGE_INFLUENCE_MATCH_MAX_ANGLE_DEG = 26;
  const EDGE_INFLUENCE_MIN_SEGMENT_LENGTH_DEG = 0.00005;
  const EDGE_INFLUENCE_MAX_FEATURES = 96;

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
  let zoneEdgeInfluenceInputSignature = "";
  let zoneEdgeInfluenceCachedFc = { type: "FeatureCollection", features: [] };
  let zoneEdgeInfluencePendingFrame = null;
  let zoneEdgeInfluenceRefreshHandle = 0;
  let zoneEdgeInfluenceBuildStats = {
    adjacencyPairs: 0,
    builtFeatures: 0,
    skippedMissingRating: 0,
    skippedMinDiff: 0,
    skippedShielded: 0,
  };
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

  function normalizeEdgeAngleDeg(angle) {
    let a = Number(angle) || 0;
    while (a < 0) a += 180;
    while (a >= 180) a -= 180;
    return a;
  }

  function edgeSegmentLengthDeg(coords) {
    if (!Array.isArray(coords) || coords.length < 2) return 0;
    const a = coords[0];
    const b = coords[1];
    const dx = Number(b?.[0]) - Number(a?.[0]);
    const dy = Number(b?.[1]) - Number(a?.[1]);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 0;
    return Math.sqrt((dx * dx) + (dy * dy));
  }

  function edgeSegmentMidpoint(coords) {
    if (!Array.isArray(coords) || coords.length < 2) return null;
    const a = coords[0];
    const b = coords[1];
    const lng1 = Number(a?.[0]);
    const lat1 = Number(a?.[1]);
    const lng2 = Number(b?.[0]);
    const lat2 = Number(b?.[1]);
    if (!Number.isFinite(lng1) || !Number.isFinite(lat1) || !Number.isFinite(lng2) || !Number.isFinite(lat2)) return null;
    return {
      lng: (lng1 + lng2) / 2,
      lat: (lat1 + lat2) / 2,
    };
  }

  function edgeSegmentAngleDeg(coords) {
    if (!Array.isArray(coords) || coords.length < 2) return 0;
    const a = coords[0];
    const b = coords[1];
    const dx = Number(b?.[0]) - Number(a?.[0]);
    const dy = Number(b?.[1]) - Number(a?.[1]);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 0;
    return normalizeEdgeAngleDeg((Math.atan2(dy, dx) * 180) / Math.PI);
  }

  function edgeMidpointDistanceDeg(a, b) {
    const dx = Number(a?.lng) - Number(b?.lng);
    const dy = Number(a?.lat) - Number(b?.lat);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return Infinity;
    return Math.sqrt((dx * dx) + (dy * dy));
  }

  function edgeAnglesCompatible(aDeg, bDeg) {
    const a = normalizeEdgeAngleDeg(aDeg);
    const b = normalizeEdgeAngleDeg(bDeg);
    const diff = Math.abs(a - b);
    const wrapped = Math.min(diff, 180 - diff);
    return wrapped <= EDGE_INFLUENCE_MATCH_MAX_ANGLE_DEG;
  }

  function edgeSegmentBucketParts(coords) {
    const midpoint = edgeSegmentMidpoint(coords);
    if (!midpoint) return null;
    const angle = edgeSegmentAngleDeg(coords);
    return {
      gx: Math.round(midpoint.lng / EDGE_INFLUENCE_MATCH_GRID_DEG),
      gy: Math.round(midpoint.lat / EDGE_INFLUENCE_MATCH_GRID_DEG),
      ga: Math.round(angle / EDGE_INFLUENCE_MATCH_ANGLE_BUCKET_DEG),
    };
  }

  function edgeNeighborBucketKeys(parts) {
    if (!parts) return [];
    const keys = [];
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let da = -1; da <= 1; da += 1) {
          keys.push(`${parts.gx + dx}|${parts.gy + dy}|${parts.ga + da}`);
        }
      }
    }
    return keys;
  }

  function buildLightweightZoneEdgeTopology(frame) {
    const features = frame?.polygons?.features || [];
    const bucketMap = new Map();
    const segments = [];

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

          const coords = [startCoord, endCoord];
          const lengthDeg = edgeSegmentLengthDeg(coords);
          if (lengthDeg < EDGE_INFLUENCE_MIN_SEGMENT_LENGTH_DEG) continue;

          const midpoint = edgeSegmentMidpoint(coords);
          const bucketParts = edgeSegmentBucketParts(coords);
          if (!midpoint || !bucketParts) continue;

          const occurrence = {
            zoneId,
            coords,
            interiorSide,
            midpoint,
            angleDeg: edgeSegmentAngleDeg(coords),
            lengthDeg,
            bucketParts,
          };

          const bucketKey = `${bucketParts.gx}|${bucketParts.gy}|${bucketParts.ga}`;
          const list = bucketMap.get(bucketKey) || [];
          list.push(occurrence);
          bucketMap.set(bucketKey, list);
          segments.push(occurrence);
        }
      });
    }

    const bestByPair = new Map();

    for (const a of segments) {
      const neighborKeys = edgeNeighborBucketKeys(a.bucketParts);

      for (const neighborKey of neighborKeys) {
        const candidates = bucketMap.get(neighborKey) || [];

        for (const b of candidates) {
          if (!b?.zoneId) continue;
          if (a === b) continue;
          if (a.zoneId === b.zoneId) continue;
          if (!edgeAnglesCompatible(a.angleDeg, b.angleDeg)) continue;

          const dist = edgeMidpointDistanceDeg(a.midpoint, b.midpoint);
          if (dist > EDGE_INFLUENCE_MATCH_MAX_DIST_DEG) continue;

          const zoneLo = a.zoneId < b.zoneId ? a.zoneId : b.zoneId;
          const zoneHi = a.zoneId < b.zoneId ? b.zoneId : a.zoneId;
          const pairKey = `${zoneLo}|${zoneHi}`;

          const score = ((a.lengthDeg + b.lengthDeg) * 0.5) - (dist * 8);
          const current = bestByPair.get(pairKey);

          if (!current || score > current.score) {
            bestByPair.set(pairKey, {
              score,
              aZoneId: a.zoneId,
              bZoneId: b.zoneId,
              aCoords: a.coords,
              bCoords: b.coords,
              aInteriorSide: a.interiorSide,
              bInteriorSide: b.interiorSide,
            });
          }
        }
      }
    }

    return Array.from(bestByPair.values()).map(({ score, ...edge }) => edge);
  }

  function getZoneEdgeTopology(frame) {
    const features = frame?.polygons?.features || [];
    const signature = features
      .map((feature) => getZoneLabelSignature(feature))
      .sort()
      .join("###");

    if (signature === zoneEdgeTopologySignature) return zoneEdgeTopologyCache;
    zoneEdgeTopologySignature = signature;
    zoneEdgeTopologyCache = buildLightweightZoneEdgeTopology(frame);
    return zoneEdgeTopologyCache;
  }

  function orientSegmentIntoZoneRightSide(coords, interiorSide) {
    if (!Array.isArray(coords) || coords.length < 2) return coords;
    if (interiorSide === "right") return coords;
    return [coords[1], coords[0]];
  }

  function trimSegment(coords, factor = 0.82) {
    if (!Array.isArray(coords) || coords.length < 2) return coords;
    const a = coords[0];
    const b = coords[1];
    const ax = Number(a?.[0]);
    const ay = Number(a?.[1]);
    const bx = Number(b?.[0]);
    const by = Number(b?.[1]);
    if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) return coords;

    const keep = Math.max(0.2, Math.min(1, factor));
    const margin = (1 - keep) / 2;

    return [
      [ax + ((bx - ax) * margin), ay + ((by - ay) * margin)],
      [bx - ((bx - ax) * margin), by - ((by - ay) * margin)],
    ];
  }

  function getZoneEdgeInfluenceInputSignature(frame) {
    getZoneEdgeTopology(frame);
    syncPickupHotspotShieldZoneIdsFromSource();

    const features = frame?.polygons?.features || [];
    const hotspotSig = Array.from(pickupHotspotShieldZoneIds || []).sort().join(",");
    const rows = [];

    for (const feature of features) {
      const zoneId = String(feature?.properties?.LocationID ?? "");
      if (!zoneId) continue;

      const rating = getFeatureEffectiveRatingForEdge(feature);
      const color = String(getFeatureBaseColorForEdge(feature) || "");

      rows.push(
        `${zoneId}|${Number.isFinite(rating) ? rating.toFixed(2) : "nan"}|${color}`
      );
    }

    rows.sort();
    return `${zoneEdgeTopologySignature}@@${hotspotSig}@@${rows.join("###")}`;
  }

  function buildZoneEdgeInfluenceFeatureCollection(frame) {
    const topology = getZoneEdgeTopology(frame);
    zoneEdgeInfluenceBuildStats = {
      adjacencyPairs: Array.isArray(topology) ? topology.length : 0,
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

    const rawFeatures = [];

    for (const edge of topology) {
      const featureA = zoneFeatureMap.get(edge.aZoneId);
      const featureB = zoneFeatureMap.get(edge.bZoneId);
      if (!featureA || !featureB) continue;

      const ratingA = getFeatureEffectiveRatingForEdge(featureA);
      const ratingB = getFeatureEffectiveRatingForEdge(featureB);

      if (!Number.isFinite(ratingA) || !Number.isFinite(ratingB)) {
        zoneEdgeInfluenceBuildStats.skippedMissingRating += 1;
        continue;
      }

      const diff = Math.abs(ratingA - ratingB);
      if (diff < EDGE_INFLUENCE_MIN_RATING_DIFF) {
        zoneEdgeInfluenceBuildStats.skippedMinDiff += 1;
        continue;
      }

      if (ratingA === ratingB) continue;

      const aIsStronger = ratingA > ratingB;
      const strongerZoneId = aIsStronger ? edge.aZoneId : edge.bZoneId;
      const weakerZoneId = aIsStronger ? edge.bZoneId : edge.aZoneId;

      if (isPickupHotspotShieldedZone(strongerZoneId)) {
        zoneEdgeInfluenceBuildStats.skippedShielded += 1;
        continue;
      }

      const strongerCoords = aIsStronger ? edge.aCoords : edge.bCoords;
      const strongerInteriorSide = aIsStronger ? edge.aInteriorSide : edge.bInteriorSide;
      const weakerFeature = aIsStronger ? featureB : featureA;

      const orientedCoords = trimSegment(
        orientSegmentIntoZoneRightSide(strongerCoords, strongerInteriorSide),
        0.84
      );

      if (!Array.isArray(orientedCoords) || orientedCoords.length < 2) continue;

      const edgeStrength = clamp01(
        (diff - EDGE_INFLUENCE_MIN_RATING_DIFF) /
        (EDGE_INFLUENCE_MAX_RATING_DIFF - EDGE_INFLUENCE_MIN_RATING_DIFF)
      );

      rawFeatures.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: orientedCoords,
        },
        properties: {
          edge_color: getFeatureBaseColorForEdge(weakerFeature),
          strong_zone_id: strongerZoneId,
          weak_zone_id: weakerZoneId,
          rating_diff: diff,
          edge_strength: edgeStrength,
          base_width_px: 2.2 + (edgeStrength * 1.4),
          inner_width_px: 5.4 + (edgeStrength * 2.2),
          base_opacity: 0.10 + (edgeStrength * 0.05),
          inner_opacity: 0.08 + (edgeStrength * 0.08),
          inner_offset_px: 1.1 + (edgeStrength * 1.1),
        },
      });
    }

    rawFeatures.sort((a, b) => Number(b?.properties?.rating_diff || 0) - Number(a?.properties?.rating_diff || 0));
    const featuresOut = rawFeatures.slice(0, EDGE_INFLUENCE_MAX_FEATURES);
    zoneEdgeInfluenceBuildStats.builtFeatures = featuresOut.length;

    return {
      type: "FeatureCollection",
      features: featuresOut,
    };
  }

  function zoneEdgeInfluenceFingerprintFromFc(fc) {
    const rows = Array.isArray(fc?.features)
      ? fc.features.map((feature) => {
          const props = feature?.properties || {};
          const coords = feature?.geometry?.coordinates || [];
          const first = Array.isArray(coords[0]) ? `${Number(coords[0][0]).toFixed(EDGE_INFLUENCE_KEY_DP)}|${Number(coords[0][1]).toFixed(EDGE_INFLUENCE_KEY_DP)}` : "";
          const last = Array.isArray(coords[coords.length - 1]) ? `${Number(coords[coords.length - 1][0]).toFixed(EDGE_INFLUENCE_KEY_DP)}|${Number(coords[coords.length - 1][1]).toFixed(EDGE_INFLUENCE_KEY_DP)}` : "";
          return [
            String(props.strong_zone_id ?? ""),
            String(props.weak_zone_id ?? ""),
            Number(props.rating_diff || 0).toFixed(3),
            first,
            last,
          ].join("|");
        })
      : [];

    return rows.sort().join("###");
  }

  function clearZoneEdgeInfluenceSource() {
    const map = core.getMap?.();
    const edgeSrc = map?.getSource?.(EDGE_INFLUENCE_SOURCE_ID);
    if (edgeSrc) {
      edgeSrc.setData(core.emptyGeojson?.() || { type: "FeatureCollection", features: [] });
    }

    zoneEdgeInfluenceFingerprint = "";
    zoneEdgeInfluenceFeatureCount = 0;
    zoneEdgeInfluenceInputSignature = "";
    zoneEdgeInfluenceCachedFc = { type: "FeatureCollection", features: [] };
    zoneEdgeInfluencePendingFrame = null;

    if (zoneEdgeInfluenceRefreshHandle) {
      if (typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(zoneEdgeInfluenceRefreshHandle);
      } else {
        clearTimeout(zoneEdgeInfluenceRefreshHandle);
      }
    }
    zoneEdgeInfluenceRefreshHandle = 0;
  }

  function isZoneEdgeInfluenceZoomActive() {
    const map = core.getMap?.();
    const zoom = Number(map?.getZoom?.());
    return Number.isFinite(zoom) && zoom >= ZONE_EDGE_INFLUENCE_MIN_ZOOM;
  }

  function getCachedZoneEdgeInfluenceFeatureCollection(frame) {
    const inputSignature = getZoneEdgeInfluenceInputSignature(frame);
    if (inputSignature === zoneEdgeInfluenceInputSignature && zoneEdgeInfluenceCachedFc) {
      return zoneEdgeInfluenceCachedFc;
    }

    const nextFc = buildZoneEdgeInfluenceFeatureCollection(frame);
    zoneEdgeInfluenceInputSignature = inputSignature;
    zoneEdgeInfluenceCachedFc = nextFc;
    return nextFc;
  }

  function scheduleZoneEdgeInfluenceRefresh(frame = null) {
    zoneEdgeInfluencePendingFrame =
      frame ||
      zoneEdgeInfluencePendingFrame ||
      window.TlcCommunityInternals?.getCurrentFrame?.() ||
      window.TlcModeInternals?.getCurrentFrame?.() ||
      null;

    if (zoneEdgeInfluenceRefreshHandle) return;

    const runner = () => {
      zoneEdgeInfluenceRefreshHandle = 0;
      const nextFrame = zoneEdgeInfluencePendingFrame;
      zoneEdgeInfluencePendingFrame = null;
      if (!nextFrame) return;
      refreshZoneEdgeInfluence(nextFrame);
    };

    if (typeof window.requestAnimationFrame === "function") {
      zoneEdgeInfluenceRefreshHandle = window.requestAnimationFrame(runner);
    } else {
      zoneEdgeInfluenceRefreshHandle = window.setTimeout(runner, 16);
    }
  }

  function refreshZoneEdgeInfluenceFromCurrentFrame() {
    const frame =
      window.TlcCommunityInternals?.getCurrentFrame?.() ||
      window.TlcModeInternals?.getCurrentFrame?.() ||
      null;

    if (!frame) return;
    scheduleZoneEdgeInfluenceRefresh(frame);
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

    const edgeFc = getCachedZoneEdgeInfluenceFeatureCollection(frame);
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

    EDGE_INFLUENCE_LEGACY_LAYER_IDS.forEach((id) => {
      if (map.getLayer(id)) {
        map.removeLayer(id);
      }
    });

    if (!map.getSource(EDGE_INFLUENCE_SOURCE_ID)) {
      map.addSource(EDGE_INFLUENCE_SOURCE_ID, {
        type: "geojson",
        data: core.emptyGeojson?.() || { type: "FeatureCollection", features: [] }
      });
      zoneEdgeInfluenceFingerprint = "";
      zoneEdgeInfluenceFeatureCount = 0;
    }

    if (!map.getLayer(EDGE_INFLUENCE_BASE_LAYER_ID)) {
      map.addLayer({
        id: EDGE_INFLUENCE_BASE_LAYER_ID,
        type: "line",
        source: EDGE_INFLUENCE_SOURCE_ID,
        minzoom: ZONE_EDGE_INFLUENCE_MIN_ZOOM,
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
        paint: {
          "line-color": ["coalesce", ["to-string", ["get", "edge_color"]], "#ffffff"],
          "line-opacity": ["coalesce", ["to-number", ["get", "base_opacity"]], 0.12],
          "line-width": [
            "*",
            ["coalesce", ["to-number", ["get", "base_width_px"]], 2.4],
            ["interpolate", ["linear"], ["zoom"], 12, 0.85, 14, 1.0, 16, 1.10]
          ],
          "line-blur": 0.25,
          "line-offset": 0
        }
      }, "zones-line");
    }

    if (!map.getLayer(EDGE_INFLUENCE_INNER_LAYER_ID)) {
      map.addLayer({
        id: EDGE_INFLUENCE_INNER_LAYER_ID,
        type: "line",
        source: EDGE_INFLUENCE_SOURCE_ID,
        minzoom: ZONE_EDGE_INFLUENCE_MIN_ZOOM,
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
        paint: {
          "line-color": ["coalesce", ["to-string", ["get", "edge_color"]], "#ffffff"],
          "line-opacity": ["coalesce", ["to-number", ["get", "inner_opacity"]], 0.10],
          "line-width": [
            "*",
            ["coalesce", ["to-number", ["get", "inner_width_px"]], 5.8],
            ["interpolate", ["linear"], ["zoom"], 12, 0.80, 14, 1.0, 16, 1.08]
          ],
          "line-blur": 0.8,
          "line-offset": [
            "*",
            ["coalesce", ["to-number", ["get", "inner_offset_px"]], 1.2],
            ["interpolate", ["linear"], ["zoom"], 12, 0.80, 14, 1.0, 16, 1.10]
          ]
        }
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

    const frame =
      window.TlcCommunityInternals?.getCurrentFrame?.() ||
      window.TlcModeInternals?.getCurrentFrame?.() ||
      null;

    if (frame) {
      scheduleZoneEdgeInfluenceRefresh(frame);
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
    scheduleZoneEdgeInfluenceRefresh(frame);
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
      scheduleZoneEdgeInfluenceRefresh();
    });

    window.addEventListener("tlc-mode-changed", () => {
      scheduleZoneEdgeInfluenceRefresh();
    });

    window.addEventListener("tlc-day-tendency-updated", () => {
      scheduleZoneEdgeInfluenceRefresh();
    });
  }

  window.getZoneEdgeInfluenceDebug = function () {
    const map = core.getMap?.();
    return {
      topologyCount: Array.isArray(zoneEdgeTopologyCache) ? zoneEdgeTopologyCache.length : 0,
      topologySignature: zoneEdgeTopologySignature || "",
      fingerprint: zoneEdgeInfluenceFingerprint || "",
      featureCount: zoneEdgeInfluenceFeatureCount,
      hasSourceData: zoneEdgeInfluenceFeatureCount > 0,
      zoomLevel: Number(core.getMap?.()?.getZoom?.() || 0),
      zoomActive: isZoneEdgeInfluenceZoomActive(),
      maxFeatures: EDGE_INFLUENCE_MAX_FEATURES,
      matchMode: "single-best-pair",
      buildStats: zoneEdgeInfluenceBuildStats,
      hotspotShieldZoneIds: Array.from(pickupHotspotShieldZoneIds || []).sort(),
      sourceReady: !!map?.getSource?.(EDGE_INFLUENCE_SOURCE_ID),
      baseLayerReady: !!map?.getLayer?.(EDGE_INFLUENCE_BASE_LAYER_ID),
      innerLayerReady: !!map?.getLayer?.(EDGE_INFLUENCE_INNER_LAYER_ID),
      inputSignature: zoneEdgeInfluenceInputSignature || "",
      cachedFeatureCount: Array.isArray(zoneEdgeInfluenceCachedFc?.features) ? zoneEdgeInfluenceCachedFc.features.length : 0,
      refreshPending: !!zoneEdgeInfluenceRefreshHandle,
      legacyLayersRemaining: EDGE_INFLUENCE_LEGACY_LAYER_IDS.filter((id) => !!map?.getLayer?.(id)),
    };
  };
})();
