(function() {
const core = window.TlcModeInternals || {};

const COMMUNITY_CROWDING_SOURCE_ID = "community-crowding-zones";
const COMMUNITY_CROWDING_LINE_LAYER_ID = "community-crowding-line";
const COMMUNITY_CROWDING_MIN_ZOOM = 10.8;
const COMMUNITY_CROWDING_MIN_DRIVER_COUNT = 2;
const COMMUNITY_CROWDING_WATCH_THRESHOLD = 0.45;
const COMMUNITY_CROWDING_CROWDED_THRESHOLD = 0.78;
const COMMUNITY_CROWDING_HEAVY_THRESHOLD = 1.10;

let crowdingInputSignature = "";
let crowdingFeatureCount = 0;
let crowdingPendingHandle = 0;
let crowdingPendingFrame = null;
let crowdingZoneStats = new Map();
let zoneGeometryIndexCache = [];
let zoneGeometryIndexSignature = "";
let latestPresenceFingerprint = "";
let latestPresenceRowCount = 0;

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function normalizeZoneId(value) {
  return String(value ?? "").trim();
}

function pointInRing(lng, lat, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = Number(ring[i]?.[0]);
    const yi = Number(ring[i]?.[1]);
    const xj = Number(ring[j]?.[0]);
    const yj = Number(ring[j]?.[1]);
    if (!Number.isFinite(xi) || !Number.isFinite(yi) || !Number.isFinite(xj) || !Number.isFinite(yj)) continue;
    const intersects = ((yi > lat) !== (yj > lat))
      && (lng < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygonLngLat(lng, lat, polygonCoords) {
  if (!Array.isArray(polygonCoords) || !polygonCoords.length) return false;
  if (!pointInRing(lng, lat, polygonCoords[0])) return false;
  for (let i = 1; i < polygonCoords.length; i += 1) {
    if (pointInRing(lng, lat, polygonCoords[i])) return false;
  }
  return true;
}

function featureContainsLngLat(feature, lngLat) {
  const lng = Number(lngLat?.lng);
  const lat = Number(lngLat?.lat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;

  const geomType = String(feature?.geometry?.type || "");
  const coords = feature?.geometry?.coordinates;

  if (geomType === "Polygon") {
    return pointInPolygonLngLat(lng, lat, coords);
  }
  if (geomType === "MultiPolygon" && Array.isArray(coords)) {
    for (const polygonCoords of coords) {
      if (pointInPolygonLngLat(lng, lat, polygonCoords)) return true;
    }
  }

  return false;
}

function bboxFromCoords(coords) {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;

  const walk = (node) => {
    if (!Array.isArray(node)) return;
    if (node.length >= 2 && Number.isFinite(Number(node[0])) && Number.isFinite(Number(node[1]))) {
      const lng = Number(node[0]);
      const lat = Number(node[1]);
      if (lng < minLng) minLng = lng;
      if (lat < minLat) minLat = lat;
      if (lng > maxLng) maxLng = lng;
      if (lat > maxLat) maxLat = lat;
      return;
    }
    for (const child of node) walk(child);
  };

  walk(coords);

  if (![minLng, minLat, maxLng, maxLat].every(Number.isFinite)) return null;
  return { minLng, minLat, maxLng, maxLat };
}

function featureBBoxArea(feature) {
  const bb = bboxFromCoords(feature?.geometry?.coordinates);
  if (!bb) return Infinity;
  return Math.max(0, (bb.maxLng - bb.minLng) * (bb.maxLat - bb.minLat));
}

function getCurrentFrameZoneFeatures() {
  return core.getCurrentFrame?.()?.polygons?.features || [];
}

function getZoneGeometryIndexSignature(features) {
  return (features || [])
    .map((feature) => {
      const props = feature?.properties || {};
      const id = String(props.LocationID ?? "");
      const geomType = String(feature?.geometry?.type || "");
      const bb = bboxFromCoords(feature?.geometry?.coordinates);
      const w = bb ? Number(bb.maxLng - bb.minLng).toFixed(6) : "0";
      const h = bb ? Number(bb.maxLat - bb.minLat).toFixed(6) : "0";
      return `${id}|${geomType}|${w}|${h}`;
    })
    .sort()
    .join("###");
}

function getZoneGeometryIndex(frame) {
  const features = frame?.polygons?.features || [];
  const signature = getZoneGeometryIndexSignature(features);
  if (signature === zoneGeometryIndexSignature) return zoneGeometryIndexCache;

  zoneGeometryIndexSignature = signature;
  zoneGeometryIndexCache = features.map((feature) => {
    const props = feature?.properties || {};
    const bb = bboxFromCoords(feature?.geometry?.coordinates);
    return {
      zoneId: String(props.LocationID ?? ""),
      feature,
      bbox: bb,
      bboxArea: bb ? Math.max(0, (bb.maxLng - bb.minLng) * (bb.maxLat - bb.minLat)) : Infinity,
    };
  });

  return zoneGeometryIndexCache;
}

function findContainingZoneFeature(indexRows, lngLat) {
  const lng = Number(lngLat?.lng);
  const lat = Number(lngLat?.lat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;

  const matches = [];
  for (const row of indexRows) {
    const bb = row?.bbox;
    if (!bb) continue;
    if (lng < bb.minLng || lng > bb.maxLng || lat < bb.minLat || lat > bb.maxLat) continue;
    if (featureContainsLngLat(row.feature, { lng, lat })) {
      matches.push(row);
    }
  }

  if (!matches.length) return null;
  matches.sort((a, b) => Number(a.bboxArea) - Number(b.bboxArea));
  return matches[0]?.feature || null;
}

function assignPresenceRowsToZones(frame, presenceRows) {
  const indexRows = getZoneGeometryIndex(frame);
  const counts = new Map();

  for (const row of presenceRows || []) {
    const lat = Number(row?.lat);
    const lng = Number(row?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const feature = findContainingZoneFeature(indexRows, { lng, lat });
    const zoneId = String(feature?.properties?.LocationID ?? "");
    if (!zoneId) continue;

    counts.set(zoneId, Number(counts.get(zoneId) || 0) + 1);
  }

  return counts;
}

function getZoneDemandReference(props) {
  const nextTrips = Number(props?.next_pickups_shadow ?? NaN);
  if (Number.isFinite(nextTrips) && nextTrips > 0) return nextTrips;

  const pickups = Number(props?.pickups ?? NaN);
  if (Number.isFinite(pickups) && pickups > 0) return pickups;

  return 1;
}

function getCrowdingBucket(score, communityDriverCount) {
  if (communityDriverCount < COMMUNITY_CROWDING_MIN_DRIVER_COUNT) return "none";
  if (score >= COMMUNITY_CROWDING_HEAVY_THRESHOLD) return "heavy";
  if (score >= COMMUNITY_CROWDING_CROWDED_THRESHOLD) return "crowded";
  if (score >= COMMUNITY_CROWDING_WATCH_THRESHOLD) return "watch";
  return "none";
}

function getCrowdingPenalty(bucket, confidence) {
  const c = clamp01(confidence);
  if (bucket === "watch") return 4 * (0.5 + 0.5 * c);
  if (bucket === "crowded") return 8 * (0.5 + 0.5 * c);
  if (bucket === "heavy") return 12 * (0.5 + 0.5 * c);
  return 0;
}

function buildCommunityCrowdingStats(frame, presenceRows) {
  const features = frame?.polygons?.features || [];
  const zoneCounts = assignPresenceRowsToZones(frame, presenceRows);
  const stats = new Map();
  let flaggedCount = 0;
  let watchCount = 0;
  let crowdedCount = 0;
  let heavyCount = 0;

  for (const feature of features) {
    const props = feature?.properties || {};
    const zoneId = String(props.LocationID ?? "");
    if (!zoneId) continue;

    const communityDriverCount = Number(zoneCounts.get(zoneId) || 0);
    const demandReference = Math.max(1, Number(getZoneDemandReference(props) || 1));

    const pressureRaw = communityDriverCount / Math.max(1, Math.sqrt(demandReference));
    const confidence = communityDriverCount < COMMUNITY_CROWDING_MIN_DRIVER_COUNT
      ? 0
      : clamp01((communityDriverCount - 1) / 3);

    const crowdingScore = pressureRaw * (0.55 + 0.45 * confidence);
    const bucket = getCrowdingBucket(crowdingScore, communityDriverCount);
    const penalty = getCrowdingPenalty(bucket, confidence);

    if (bucket !== "none") {
      flaggedCount += 1;
      if (bucket === "watch") watchCount += 1;
      if (bucket === "crowded") crowdedCount += 1;
      if (bucket === "heavy") heavyCount += 1;
    }

    stats.set(zoneId, {
      zoneId,
      communityDriverCount,
      demandReference,
      pressureRaw,
      confidence,
      crowdingScore,
      bucket,
      penalty,
      zoneName: String(props.zone_name || ""),
      borough: String(props.borough || ""),
    });
  }

  return {
    stats,
    summary: {
      flaggedCount,
      watchCount,
      crowdedCount,
      heavyCount,
    },
  };
}

function crowdingLineColorForBucket(bucket) {
  if (bucket === "heavy") return "#ff5a36";
  if (bucket === "crowded") return "#ff9f1a";
  if (bucket === "watch") return "#ffd24a";
  return "#ffd24a";
}

function buildCommunityCrowdingFeatureCollection(frame, crowdingStatsMap) {
  const features = [];
  const zoneFeatures = frame?.polygons?.features || [];

  for (const feature of zoneFeatures) {
    const zoneId = String(feature?.properties?.LocationID ?? "");
    const stat = crowdingStatsMap.get(zoneId);
    if (!stat || stat.bucket === "none") continue;

    features.push({
      type: "Feature",
      geometry: feature.geometry,
      properties: {
        LocationID: zoneId,
        crowding_bucket: stat.bucket,
        crowding_score: stat.crowdingScore,
        crowding_confidence: stat.confidence,
        community_driver_count: stat.communityDriverCount,
        demand_reference: stat.demandReference,
        crowding_penalty: stat.penalty,
        crowding_color: crowdingLineColorForBucket(stat.bucket),
      },
    });
  }

  crowdingFeatureCount = features.length;
  return { type: "FeatureCollection", features };
}

function getCrowdingInputSignature(frame, presenceRows, statsSummary) {
  const frameTime = String(frame?.time || "");
  const zonePart = Array.from(crowdingZoneStats.values())
    .map((stat) => [
      stat.zoneId,
      stat.communityDriverCount,
      stat.bucket,
      Number(stat.crowdingScore || 0).toFixed(3),
      Number(stat.confidence || 0).toFixed(3),
    ].join("|"))
    .sort()
    .join("###");

  return [
    frameTime,
    latestPresenceFingerprint || "",
    String(Array.isArray(presenceRows) ? presenceRows.length : 0),
    zonePart,
  ].join("@@");
}

function clearCommunityCrowdingSource() {
  const map = core.getMap?.();
  const src = map?.getSource?.(COMMUNITY_CROWDING_SOURCE_ID);
  if (src) {
    src.setData({ type: "FeatureCollection", features: [] });
  }
  crowdingInputSignature = "";
  crowdingFeatureCount = 0;
  crowdingZoneStats = new Map();
}

function refreshCommunityCrowding(frame) {
  const map = core.getMap?.();
  if (!map || !core.getCurrentFrame?.()) return;

  const src = map.getSource(COMMUNITY_CROWDING_SOURCE_ID);
  if (!src || !frame) {
    clearCommunityCrowdingSource();
    return;
  }

  const presenceRows = window.TlcCommunityModule?.getCachedPresenceRowsSnapshot?.() || [];
  latestPresenceRowCount = Array.isArray(presenceRows) ? presenceRows.length : 0;

  const result = buildCommunityCrowdingStats(frame, presenceRows);
  crowdingZoneStats = result.stats;

  const nextSignature = getCrowdingInputSignature(frame, presenceRows, result.summary);
  if (nextSignature === crowdingInputSignature) return;

  const fc = buildCommunityCrowdingFeatureCollection(frame, crowdingZoneStats);
  src.setData(fc);
  crowdingInputSignature = nextSignature;
}

function scheduleCommunityCrowdingRefresh(frame = null) {
  crowdingPendingFrame = frame || crowdingPendingFrame || core.getCurrentFrame?.() || null;
  if (crowdingPendingHandle) return;

  const runner = () => {
    crowdingPendingHandle = 0;
    const nextFrame = crowdingPendingFrame;
    crowdingPendingFrame = null;
    if (!nextFrame) return;
    refreshCommunityCrowding(nextFrame);
  };

  if (typeof window.requestAnimationFrame === "function") {
    crowdingPendingHandle = window.requestAnimationFrame(runner);
  } else {
    crowdingPendingHandle = window.setTimeout(runner, 16);
  }
}

async function ensureCommunityCrowdingSourceAndLayers() {
  const map = core.getMap?.();
  if (!map) return false;
  const styleReady = await core.waitForStyleReady?.();
  if (styleReady === false) return false;

  if (!map.getSource(COMMUNITY_CROWDING_SOURCE_ID)) {
    map.addSource(COMMUNITY_CROWDING_SOURCE_ID, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }

  if (!map.getLayer(COMMUNITY_CROWDING_LINE_LAYER_ID)) {
    map.addLayer(
      {
        id: COMMUNITY_CROWDING_LINE_LAYER_ID,
        type: "line",
        source: COMMUNITY_CROWDING_SOURCE_ID,
        minzoom: COMMUNITY_CROWDING_MIN_ZOOM,
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
        paint: {
          "line-color": ["coalesce", ["to-string", ["get", "crowding_color"]], "#ffd24a"],
          "line-opacity": 0.88,
          "line-width": [
            "match", ["get", "crowding_bucket"],
            "heavy", 3.2,
            "crowded", 2.7,
            "watch", 2.2,
            2.2,
          ],
          "line-dasharray": [1.5, 1.2],
        },
      },
      "zones-line"
    );
  }

  return true;
}

function getZoneCommunityCrowdingSnapshot(locationId) {
  const zoneId = String(locationId || "").trim();
  return zoneId ? (crowdingZoneStats.get(zoneId) || null) : null;
}

function getZoneCommunityCrowdingPenalty(locationId) {
  const stat = getZoneCommunityCrowdingSnapshot(locationId);
  return Number(stat?.penalty || 0);
}

function getActiveCrowdingZoneIdsSnapshot() {
  return Array.from(crowdingZoneStats.values())
    .filter((stat) => stat.bucket && stat.bucket !== "none")
    .map((stat) => stat.zoneId)
    .sort();
}

window.TlcCommunityCrowdingModule = {
  ensureCommunityCrowdingSourceAndLayers,
  scheduleCommunityCrowdingRefresh,
  clearCommunityCrowdingSource: clearCommunityCrowdingSource,
  getZoneCommunityCrowdingSnapshot,
  getZoneCommunityCrowdingPenalty,
  getActiveCrowdingZoneIdsSnapshot,
};

window.getCommunityCrowdingDebug = function getCommunityCrowdingDebug() {
  const map = core.getMap?.();
  const buckets = { watch: 0, crowded: 0, heavy: 0 };
  for (const stat of crowdingZoneStats.values()) {
    if (stat.bucket === "watch") buckets.watch += 1;
    if (stat.bucket === "crowded") buckets.crowded += 1;
    if (stat.bucket === "heavy") buckets.heavy += 1;
  }

  return {
    presenceRowCount: latestPresenceRowCount,
    sourceReady: !!map?.getSource?.(COMMUNITY_CROWDING_SOURCE_ID),
    lineLayerReady: !!map?.getLayer?.(COMMUNITY_CROWDING_LINE_LAYER_ID),
    flaggedZoneCount: crowdingFeatureCount,
    watchCount: buckets.watch,
    crowdedCount: buckets.crowded,
    heavyCount: buckets.heavy,
    inputSignature: crowdingInputSignature || "",
    refreshPending: !!crowdingPendingHandle,
    activeZoneIds: getActiveCrowdingZoneIdsSnapshot(),
  };
};

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("team-joseo-community-presence-cache-updated", (event) => {
    latestPresenceFingerprint = String(event?.detail?.fingerprint || "");
    scheduleCommunityCrowdingRefresh();
  });

  window.addEventListener("team-joseo-frame-rendered", () => {
    scheduleCommunityCrowdingRefresh(core.getCurrentFrame?.());
  });

  window.addEventListener("tlc-zone-owner-ready", () => {
    Promise.resolve(ensureCommunityCrowdingSourceAndLayers())
      .then(() => {
        scheduleCommunityCrowdingRefresh(core.getCurrentFrame?.());
      })
      .catch(() => {});
  });
}
})();
