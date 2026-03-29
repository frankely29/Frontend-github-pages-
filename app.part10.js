(function() {
const runtime = window.FrontendRuntime || null;
const FrontendRuntime = runtime;
const runtimePolling = runtime?.polling || null;
const runtimePerf = runtime?.perf || null;
const core = window.TlcCommunityInternals || {};

const emptyGeojson = (...args) => core.emptyGeojson?.(...args) || { type: "FeatureCollection", features: [] };
const waitForStyleReady = (...args) => core.waitForStyleReady?.(...args);
const geometryCenter = (...args) => core.geometryCenter?.(...args);
const haversineMiles = (...args) => core.haversineMiles?.(...args);
const refreshNavNameLabel = (...args) => core.refreshNavNameLabel?.(...args);
const applyDriverLabelZoomStyles = (...args) => core.applyDriverLabelZoomStyles?.(...args);
const setPresenceDirection = (...args) => core.setPresenceDirection?.(...args);
const wireProfileOpenTargets = (...args) => core.wireProfileOpenTargets?.(...args);
const normDeg = (...args) => core.normDeg?.(...args);
const shortestAngleDelta = (...args) => core.shortestAngleDelta?.(...args);
const recordPerfMetric = (...args) => core.recordPerfMetric?.(...args);
const updateOnlineBadge = (...args) => core.updateOnlineBadge?.(...args);

/* =========================================================
   COMMUNITY SETTINGS (cheap polling)
   ========================================================= */
const PRESENCE_PUSH_MS = 8 * 1000; // send my location
const PRESENCE_PULL_MS = 10 * 1000; // fetch all drivers
const PRESENCE_STALE_SEC = 95; // hide if older than this
const PRESENCE_HIDDEN_POLL_MS = 30 * 1000;
const PRESENCE_IDLE_POLL_MS = 10 * 1000;
const PRESENCE_ACTIVE_POLL_MS = 6 * 1000;
const PRESENCE_BOOST_POLL_MS = 7 * 1000;
const PRESENCE_BOOST_WINDOW_MS = 25 * 1000;
const PRESENCE_ACCURACY_THRESHOLD = 120;
const PICKUP_RECENT_LIMIT = 30;
const PICKUP_ZONE_SAMPLE_LIMIT = 100;
const PICKUP_REFRESH_DEBOUNCE_MS = 350;
const PICKUP_FETCH_COOLDOWN_MS = 1200;
const PICKUP_POLL_MS = 30 * 1000;
const PICKUP_MICRO_HOTSPOT_MIN_ZOOM = 10.2;
const PRESENCE_VIEWPORT_BUFFER_RATIO = 0.18;
const PRESENCE_VIEWPORT_MIN_BUFFER_DEG = 0.01;
const PRESENCE_SNAPSHOT_BASE_LIMIT = 350;
const PRESENCE_SNAPSHOT_HIGH_LIMIT = 1200;
const PRESENCE_SNAPSHOT_BOOST_WINDOW_MS = 60 * 1000;
const PRESENCE_VIEWPORT_ROUTE = '/presence/viewport';
const PRESENCE_DELTA_ROUTE = '/presence/delta';
const PRESENCE_ALL_ROUTE = '/presence/all';
const PRESENCE_DELTA_SINCE_MS_PARAM = 'updated_since_ms';
const PRESENCE_DELTA_MAX_PAGES_PER_CYCLE = 5;
const PRESENCE_MOVE_THRESHOLD_MI = 0.018;
const PRESENCE_HEADING_CHANGE_THRESHOLD_DEG = 14;
const PRESENCE_STATIONARY_PUSH_MS = 25 * 1000;
const PRESENCE_MOVING_PUSH_MS = 5 * 1000;
const PRESENCE_REANCHOR_STABLE_RADIUS_MI = 0.18;
const PRESENCE_REANCHOR_MIN_STABLE_MS = 8000;
const PICKUP_VIEWPORT_BUFFER_RATIO = 0.12;
const PICKUP_VIEWPORT_MIN_BUFFER_DEG = 0.01;

let pickupRefreshTimer = null;
let pickupPollTimer = null;
let pickupRefreshInFlight = false;
let pickupRefreshQueued = false;
let pickupRefreshQueuedForce = false;
let pickupOverlayAbortController = null;
let pickupLogBusy = false;
let lastPickupFetchMs = 0;
let lastPickupFetchKey = "";
let lastPickupViewportKey = "";
let pickupHotspotZoneIds = new Set();
let pickupPointsSourceFingerprint = "";
let pickupHotspotsSourceFingerprint = "";
let pickupMicroHotspotsSourceFingerprint = "";
let presencePollTimer = null;
let presencePullAbortController = null;
let presencePullInFlight = false;
let presencePullLoopRunning = false;
let cachedPresenceFingerprint = "";
let renderedPresenceFingerprint = "";
let pickupRequestSerial = 0;
let appliedPickupRequestSerial = 0;
let presenceRequestSerial = 0;
let appliedPresenceRequestSerial = 0;

function recordDuplicateGuard(reason) {
  const perf = core.getFrontendPerfStats?.();
  if (perf) perf.duplicatePollGuards = Number(perf.duplicatePollGuards || 0) + 1;
  recordPerfMetric("dbgPollGuards", `${Number(perf?.duplicatePollGuards || 0)} guard(s) • ${reason}`);
}

function clearPickupOverlayCache() {
  pickupZoneStats = new Map();
  pickupHotspotZoneIds = new Set();
  pickupPointsSourceFingerprint = "";
  pickupHotspotsSourceFingerprint = "";
  pickupMicroHotspotsSourceFingerprint = "";
  lastPickupFetchKey = "";
  lastPickupViewportKey = "";
  if (pickupOverlayAbortController) {
    pickupOverlayAbortController.abort();
    pickupOverlayAbortController = null;
  }
  pickupRefreshInFlight = false;
  pickupRefreshQueued = false;
  pickupRefreshQueuedForce = false;
  emitPickupHotspotZoneShieldUpdate();
}

function normalizePickupZoneId(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return String(n);
}

function normalizePickupHotspotId(value) {
  if (value == null || value === "") return "";
  return String(value);
}

function normalizePickupHotspotIndex(value) {
  if (value == null || value === "") return "";
  const n = Number(value);
  if (Number.isFinite(n)) return String(n);
  return String(value);
}

function pickupHotspotKeyFromParts(zoneId, hotspotId, hotspotIndex) {
  return [zoneId || "", hotspotId || "", hotspotIndex || ""].join("|");
}

function pickupHotspotKeyFromProps(props = {}) {
  const zoneId = normalizePickupZoneId(props.zone_id ?? props.zoneId ?? props.location_id ?? props.LocationID);
  const hotspotId = normalizePickupHotspotId(props.hotspot_id ?? props.hotspotId ?? props.pickup_hotspot_id);
  const hotspotIndex = normalizePickupHotspotIndex(props.hotspot_index ?? props.hotspotIndex ?? props.pickup_hotspot_index);
  return pickupHotspotKeyFromParts(zoneId, hotspotId, hotspotIndex);
}

function getPickupHotspotZoneIdsSnapshot() {
  return Array.from(pickupHotspotZoneIds || []).map((value) => String(value)).sort();
}

function hasPickupHotspotZone(zoneId) {
  const normalized = normalizePickupZoneId(zoneId);
  if (normalized == null) return false;
  return pickupHotspotZoneIds.has(normalized);
}

function emitPickupHotspotZoneShieldUpdate() {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(new CustomEvent("tlc-pickup-hotspot-zones-updated", {
    detail: {
      hotspotZoneIds: getPickupHotspotZoneIdsSnapshot(),
    },
  }));
}

function normalizePickupMicroHotspots(rawInput, allowedZoneIds = null) {
  const shouldKeepZone = (zoneId) => {
    if (!(allowedZoneIds instanceof Set) || allowedZoneIds.size === 0) return true;
    return zoneId != null && allowedZoneIds.has(zoneId);
  };

  if (rawInput?.type === "FeatureCollection" && Array.isArray(rawInput.features)) {
    const features = [];
    for (const feat of rawInput.features) {
      if (!feat || feat.type !== "Feature") continue;
      const coords = Array.isArray(feat?.geometry?.coordinates) ? feat.geometry.coordinates : [];
      const lng = Number(coords?.[0] ?? NaN);
      const lat = Number(coords?.[1] ?? NaN);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const props = (feat?.properties && typeof feat.properties === "object") ? feat.properties : {};
      const zoneId = normalizePickupZoneId(props.zone_id ?? props.zoneId ?? props.location_id ?? props.LocationID);
      if (!shouldKeepZone(zoneId)) continue;
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lng, lat] },
        properties: {
          zone_id: zoneId,
          hotspot_id: normalizePickupHotspotId(props.hotspot_id ?? props.hotspotId ?? props.pickup_hotspot_id),
          hotspot_index: normalizePickupHotspotIndex(props.hotspot_index ?? props.hotspotIndex ?? props.pickup_hotspot_index),
          intensity: Number.isFinite(Number(props.intensity ?? NaN)) ? Number(props.intensity) : 0.4,
          confidence: Number.isFinite(Number(props.confidence ?? NaN)) ? Number(props.confidence) : null,
          radius_m: Number.isFinite(Number(props.radius_m ?? NaN)) ? Number(props.radius_m) : 120,
          event_count: Number.isFinite(Number(props.event_count ?? NaN)) ? Number(props.event_count) : null,
          recommended: !!props.recommended,
          zone_name: props.zone_name ?? "",
          borough: props.borough ?? "",
        },
      });
    }
    return { type: "FeatureCollection", features };
  }

  const out = [];
  const rows = Array.isArray(rawInput)
    ? rawInput
    : (Array.isArray(rawInput?.items)
      ? rawInput.items
      : (Array.isArray(rawInput?.clusters)
        ? rawInput.clusters
        : (Array.isArray(rawInput?.micro_hotspots) ? rawInput.micro_hotspots : [])));

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const props = (row?.properties && typeof row.properties === "object") ? row.properties : row;
    const coords = Array.isArray(row?.geometry?.coordinates) ? row.geometry.coordinates : [];
    const lat = Number(props.center_lat ?? props.lat ?? props.latitude ?? coords?.[1] ?? NaN);
    const lng = Number(props.center_lng ?? props.lng ?? props.lon ?? props.longitude ?? coords?.[0] ?? NaN);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const intensityRaw = Number(props.intensity ?? props.live_strength ?? props.final_score ?? props.hotspot_score ?? NaN);
    const confidenceRaw = Number(props.confidence ?? NaN);
    const radiusRaw = Number(props.radius_m ?? props.radius ?? props.radius_meters ?? NaN);
    const zoneId = normalizePickupZoneId(props.zone_id ?? props.zoneId ?? props.location_id ?? props.LocationID ?? row?.zone_id ?? row?.zoneId ?? row?.location_id ?? row?.LocationID);
    if (!shouldKeepZone(zoneId)) continue;
    out.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lng, lat] },
      properties: {
        zone_id: zoneId,
        hotspot_id: normalizePickupHotspotId(props.hotspot_id ?? props.hotspotId ?? props.pickup_hotspot_id ?? row?.hotspot_id ?? row?.hotspotId),
        hotspot_index: normalizePickupHotspotIndex(props.hotspot_index ?? props.hotspotIndex ?? props.pickup_hotspot_index ?? row?.hotspot_index ?? row?.hotspotIndex),
        intensity: Number.isFinite(intensityRaw) ? intensityRaw : 0.4,
        confidence: Number.isFinite(confidenceRaw) ? confidenceRaw : null,
        radius_m: Number.isFinite(radiusRaw) ? radiusRaw : 120,
        event_count: Number.isFinite(Number(props.event_count ?? props.count ?? NaN)) ? Number(props.event_count ?? props.count) : null,
        recommended: !!props.recommended,
        zone_name: props.zone_name ?? "",
        borough: props.borough ?? "",
      },
    });
  }

  return { type: "FeatureCollection", features: out };
}

function extractNestedPickupMicroHotspots(zoneHotspots, allowedZoneIds = null) {
  if (!zoneHotspots || zoneHotspots.type !== "FeatureCollection" || !Array.isArray(zoneHotspots.features)) {
    return [];
  }

  const shouldKeepZone = (zoneId) => {
    if (!(allowedZoneIds instanceof Set) || allowedZoneIds.size === 0) return true;
    return zoneId != null && allowedZoneIds.has(zoneId);
  };

  const nested = [];
  for (const feat of zoneHotspots.features) {
    const parentZoneId = normalizePickupZoneId(feat?.properties?.zone_id ?? feat?.properties?.zoneId ?? feat?.properties?.location_id ?? feat?.properties?.LocationID);
    const parentHotspotId = normalizePickupHotspotId(feat?.properties?.hotspot_id ?? feat?.properties?.hotspotId ?? feat?.properties?.pickup_hotspot_id);
    const parentHotspotIndex = normalizePickupHotspotIndex(feat?.properties?.hotspot_index ?? feat?.properties?.hotspotIndex ?? feat?.properties?.pickup_hotspot_index);
    const microHotspots = feat?.properties?.micro_hotspots;
    if (!Array.isArray(microHotspots)) continue;
    for (const entry of microHotspots) {
      if (!entry || typeof entry !== "object") continue;
      const props = (entry?.properties && typeof entry.properties === "object") ? entry.properties : null;
      const entryZoneId = normalizePickupZoneId(
        props?.zone_id ?? props?.zoneId ?? props?.location_id ?? props?.LocationID
        ?? entry?.zone_id ?? entry?.zoneId ?? entry?.location_id ?? entry?.LocationID
      );
      if (!entryZoneId && parentZoneId) {
        if (props) props.zone_id = parentZoneId;
        else entry.zone_id = parentZoneId;
      }
      const resolvedZoneId = entryZoneId || parentZoneId;
      if (!shouldKeepZone(resolvedZoneId)) continue;
      if (props) {
        if (props.hotspot_id == null || props.hotspot_id === "") props.hotspot_id = parentHotspotId;
        if (props.hotspot_index == null || props.hotspot_index === "") props.hotspot_index = parentHotspotIndex;
      } else {
        if (entry.hotspot_id == null || entry.hotspot_id === "") entry.hotspot_id = parentHotspotId;
        if (entry.hotspot_index == null || entry.hotspot_index === "") entry.hotspot_index = parentHotspotIndex;
      }
      nested.push(entry);
    }
  }
  return nested;
}

function countPickupMicroHotspotRows(rawInput) {
  if (rawInput == null) return 0;
  if (rawInput?.type === "FeatureCollection" && Array.isArray(rawInput.features)) {
    return rawInput.features.length;
  }
  if (Array.isArray(rawInput)) return rawInput.length;
  if (Array.isArray(rawInput?.items)) return rawInput.items.length;
  if (Array.isArray(rawInput?.clusters)) return rawInput.clusters.length;
  if (Array.isArray(rawInput?.micro_hotspots)) return rawInput.micro_hotspots.length;
  return 0;
}

function pickupMicroHotspotsFingerprint(fc) {
  if (!fc || fc.type !== "FeatureCollection" || !Array.isArray(fc.features) || !fc.features.length) {
    return "";
  }
  const rows = [];
  for (const feat of fc.features) {
    const props = feat?.properties || {};
    const coords = feat?.geometry?.coordinates || [];
    rows.push([
      String(props.zone_id ?? ""),
      String(props.hotspot_id ?? ""),
      String(props.hotspot_index ?? ""),
      String(Number(coords?.[0] ?? NaN)),
      String(Number(coords?.[1] ?? NaN)),
      String(Number(props.intensity ?? NaN)),
      String(Number(props.confidence ?? NaN)),
      String(Number(props.radius_m ?? NaN)),
      props.recommended ? "1" : "0",
    ].join("|"));
  }
  rows.sort();
  return rows.join(";;");
}

function setPickupPointLayerVisibility(visible) {
  if (!map) return;
  const value = visible ? "visible" : "none";
  for (const layerId of ["pickup-heat", "pickup-circles-glow", "pickup-circles"]) {
    if (map.getLayer(layerId)) {
      try { map.setLayoutProperty(layerId, "visibility", value); } catch {}
    }
  }
}

function pickupHotspotsFingerprint(fc) {
  if (!fc || fc.type !== "FeatureCollection" || !Array.isArray(fc.features) || !fc.features.length) {
    return "";
  }
  const rows = [];
  for (const feat of fc.features) {
    const props = feat?.properties || {};
    const zoneId = props?.zone_id;
    if (zoneId == null) continue;
    const sampleSize = Number(props?.sample_size ?? NaN);
    const intensity = Number(props?.intensity ?? NaN);
    const hotspotId = normalizePickupHotspotId(props?.hotspot_id ?? props?.hotspotId ?? props?.pickup_hotspot_id);
    const hotspotIndex = normalizePickupHotspotIndex(props?.hotspot_index ?? props?.hotspotIndex ?? props?.pickup_hotspot_index);
    const signature = props?.signature;
    if (signature != null && signature !== "") {
      rows.push([
        String(zoneId),
        hotspotId,
        hotspotIndex,
        String(signature),
        Number.isFinite(sampleSize) ? String(sampleSize) : "",
        Number.isFinite(intensity) ? String(intensity) : "",
      ].join("|"));
      continue;
    }
    const latestCreatedAt = Number(props?.latest_created_at ?? NaN);
    rows.push([
      String(zoneId),
      hotspotId,
      hotspotIndex,
      "",
      Number.isFinite(sampleSize) ? String(sampleSize) : "",
      Number.isFinite(latestCreatedAt) ? String(latestCreatedAt) : "",
    ].join("|"));
  }
  rows.sort();
  return rows.join(";;");
}

function pickupPointsFingerprintFromFeatures(fc) {
  if (!fc || fc.type !== "FeatureCollection" || !Array.isArray(fc.features) || !fc.features.length) {
    return "";
  }
  const rows = [];
  for (const feat of fc.features) {
    const props = feat?.properties || {};
    const id = props?.id ?? feat?.id ?? "";
    const zoneId = props?.zone_id ?? "";
    const createdAt = props?.created_at ?? props?.ts ?? "";
    rows.push([String(id), String(zoneId), String(createdAt)].join("|"));
  }
  rows.sort();
  return rows.join(";;");
}

function setPickupOverlayData(fc, items = [], zoneStats = [], zoneHotspots = emptyGeojson(), microHotspots = emptyGeojson()) {
  pickupZoneStats = new Map();
  pickupHotspotZoneIds = new Set();

  if (Array.isArray(zoneStats) && zoneStats.length) {
    for (const stat of zoneStats) {
      const zoneId = stat?.zone_id;
      if (zoneId == null) continue;
      const key = String(zoneId);
      const sampleSize = Number(stat?.sample_size ?? NaN);
      const sampleLimit = Number(stat?.sample_limit ?? NaN);
      const latestCreatedAt = Number(stat?.latest_created_at ?? NaN);
      const avgLat = Number(stat?.avg_lat ?? NaN);
      const avgLng = Number(stat?.avg_lng ?? NaN);

      pickupZoneStats.set(key, {
        zone_id: Number(zoneId),
        zone_name: stat?.zone_name ?? "",
        borough: stat?.borough ?? "",
        sample_size: Number.isFinite(sampleSize) ? sampleSize : 0,
        sample_limit: Number.isFinite(sampleLimit) ? sampleLimit : PICKUP_ZONE_SAMPLE_LIMIT,
        latest_created_at: Number.isFinite(latestCreatedAt) ? latestCreatedAt : null,
        avg_lat: Number.isFinite(avgLat) ? avgLat : null,
        avg_lng: Number.isFinite(avgLng) ? avgLng : null,
      });
    }
  } else {
    for (const it of items || []) {
      const zoneId = it?.zone_id;
      if (zoneId == null) continue;
      const key = String(zoneId);
      const existing = pickupZoneStats.get(key) || {
        zone_id: Number(zoneId),
        zone_name: it?.zone_name ?? "",
        borough: it?.borough ?? "",
        sample_size: 0,
        sample_limit: PICKUP_ZONE_SAMPLE_LIMIT,
        latest_created_at: null,
        avg_lat: null,
        avg_lng: null,
      };
      existing.sample_size += 1;
      const ts = Number(it?.created_at ?? NaN);
      if (Number.isFinite(ts) && (!existing.latest_created_at || ts > existing.latest_created_at)) {
        existing.latest_created_at = ts;
      }
      pickupZoneStats.set(key, existing);
    }
  }

  const validatedZoneHotspots = (zoneHotspots && zoneHotspots.type === "FeatureCollection" && Array.isArray(zoneHotspots.features))
    ? zoneHotspots
    : emptyGeojson();

  const hotspotCoveredZoneIds = new Set();
  const zoneHotspotZoneIds = new Set();
  const visibleHotspotKeys = new Set();
  const hotspotIds = new Set();
  const perZoneHotspotCounts = {};
  for (const feat of validatedZoneHotspots.features) {
    const props = feat?.properties || {};
    const zoneId = normalizePickupZoneId(props.zone_id ?? props.zoneId ?? props.location_id ?? props.LocationID);
    if (zoneId == null) continue;
    const hotspotId = normalizePickupHotspotId(props.hotspot_id ?? props.hotspotId ?? props.pickup_hotspot_id);
    const hotspotIndex = normalizePickupHotspotIndex(props.hotspot_index ?? props.hotspotIndex ?? props.pickup_hotspot_index);
    hotspotCoveredZoneIds.add(zoneId);
    zoneHotspotZoneIds.add(zoneId);
    pickupHotspotZoneIds.add(zoneId);
    visibleHotspotKeys.add(pickupHotspotKeyFromParts(zoneId, hotspotId, hotspotIndex));
    if (hotspotId) hotspotIds.add(hotspotId);
    perZoneHotspotCounts[zoneId] = (perZoneHotspotCounts[zoneId] || 0) + 1;
  }

  const hotspotFingerprint = pickupHotspotsFingerprint(validatedZoneHotspots);
  const hotspotSrc = map?.getSource?.("pickup-zone-hotspots");
  if (hotspotSrc && typeof hotspotSrc.setData === "function" && hotspotFingerprint !== pickupHotspotsSourceFingerprint) {
    hotspotSrc.setData(validatedZoneHotspots);
    pickupHotspotsSourceFingerprint = hotspotFingerprint;
  }

  const rawMicroHotspots = (microHotspots && microHotspots.type === "FeatureCollection" && Array.isArray(microHotspots.features))
    ? microHotspots
    : emptyGeojson();
  const normalizedMicroHotspots = normalizePickupMicroHotspots(rawMicroHotspots, hotspotCoveredZoneIds);
  const validatedMicroHotspots = {
    type: "FeatureCollection",
    features: (normalizedMicroHotspots.features || []).filter((feat) => {
      const key = pickupHotspotKeyFromProps(feat?.properties || {});
      return visibleHotspotKeys.has(key);
    }),
  };

  const microFingerprint = pickupMicroHotspotsFingerprint(validatedMicroHotspots);
  const microSrc = map?.getSource?.("pickup-micro-hotspots");
  if (microSrc && typeof microSrc.setData === "function" && microFingerprint !== pickupMicroHotspotsSourceFingerprint) {
    microSrc.setData(validatedMicroHotspots);
    pickupMicroHotspotsSourceFingerprint = microFingerprint;
  }
  const microHotspotZoneIds = new Set();

  for (const feat of validatedMicroHotspots.features) {
    const zoneId = normalizePickupZoneId(feat?.properties?.zone_id ?? feat?.properties?.zoneId ?? feat?.properties?.location_id ?? feat?.properties?.LocationID);
    if (zoneId == null) continue;
    microHotspotZoneIds.add(zoneId);
    pickupHotspotZoneIds.add(zoneId);
  }

  const inputPickupFeatures = Array.isArray(fc?.features) ? fc.features : [];
  const totalInputPickupDotCount = inputPickupFeatures.length;
  const filteredFeatures = inputPickupFeatures.filter((feat) => {
    const zoneId = normalizePickupZoneId(feat?.properties?.zone_id ?? feat?.properties?.zoneId ?? feat?.properties?.location_id ?? feat?.properties?.LocationID);
    if (zoneId == null) return true;
    return !hotspotCoveredZoneIds.has(zoneId);
  });
  const filteredPickupPointsFc = { type: "FeatureCollection", features: filteredFeatures };
  const hasVisiblePickupPoints = filteredPickupPointsFc.features.length > 0;
  const remainingPickupDotCount = filteredPickupPointsFc.features.length;
  const suppressedPickupDotCount = Math.max(0, totalInputPickupDotCount - remainingPickupDotCount);
  window.__pickupDebug = {
    coveredZones: Array.from(hotspotCoveredZoneIds || []),
    zoneHotspotCount: validatedZoneHotspots.features.length,
    distinctCoveredZoneCount: hotspotCoveredZoneIds.size,
    hotspotIds: Array.from(hotspotIds),
    perZoneHotspotCounts,
    microHotspotCount: validatedMicroHotspots.features.length,
    hotspotCoveredZoneIds: Array.from(hotspotCoveredZoneIds || []),
    suppressedZoneIds: Array.from(hotspotCoveredZoneIds || []),
    totalInputPickupDotCount,
    suppressedPickupDotCount,
    remainingPickupDotCount,
    zoneHotspotZoneIds: Array.from(zoneHotspotZoneIds || []),
    microHotspotZoneIds: Array.from(microHotspotZoneIds || []),
    visiblePickupDotCount: filteredPickupPointsFc.features.length,
  };
  setPickupPointLayerVisibility(hasVisiblePickupPoints);
  const visiblePointsFingerprint = pickupPointsFingerprintFromFeatures(filteredPickupPointsFc);

  const src = map?.getSource?.("pickup-points");
  if (src && typeof src.setData === "function" && visiblePointsFingerprint !== pickupPointsSourceFingerprint) {
    src.setData(filteredPickupPointsFc);
    pickupPointsSourceFingerprint = visiblePointsFingerprint;
  }

  emitPickupHotspotZoneShieldUpdate();
}

function clearPickupOverlay() {
  setPickupOverlayData(emptyGeojson(), [], [], emptyGeojson(), emptyGeojson());
}

function formatRelativeAge(tsUnix) {
  const ts = Number(tsUnix ?? NaN);
  if (!Number.isFinite(ts) || ts <= 0) return "unknown";
  const diffSec = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.max(1, Math.round(diffSec / 60))}m ago`;
  if (diffSec < 86400) return `${Math.max(1, Math.round(diffSec / 3600))}h ago`;
  return `${Math.max(1, Math.round(diffSec / 86400))}d ago`;
}

function buildPickupFeatureCollection(items) {
  const features = [];
  for (const it of items || []) {
    const lat = Number(it?.lat ?? NaN);
    const lng = Number(it?.lng ?? NaN);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const createdAt = Number(it?.created_at ?? NaN);
    const ageSec = Number.isFinite(createdAt) ? Math.max(0, Math.floor(Date.now() / 1000 - createdAt)) : 0;
    const recencyScore = Math.max(0.2, 1 - ageSec / (12 * 3600));
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lng, lat] },
      properties: {
        id: it?.id ?? null,
        zone_id: it?.zone_id ?? null,
        zone_name: it?.zone_name ?? "",
        borough: it?.borough ?? "",
        frame_time: it?.frame_time ?? "",
        created_at: Number.isFinite(createdAt) ? createdAt : null,
        recency_score: recencyScore,
      },
    });
  }
  return { type: "FeatureCollection", features };
}

async function ensurePickupSourceAndLayers() {
  if (!map) return false;
  const styleReady = await waitForStyleReady();
  if (!styleReady) return false;

  if (!map.getSource("pickup-points")) {
    map.addSource("pickup-points", { type: "geojson", data: emptyGeojson() });
  }

  if (!map.getSource("pickup-zone-hotspots")) {
    map.addSource("pickup-zone-hotspots", { type: "geojson", data: emptyGeojson() });
  }

  if (!map.getSource("pickup-micro-hotspots")) {
    map.addSource("pickup-micro-hotspots", { type: "geojson", data: emptyGeojson() });
  }

  const hotspotBeforeLayer = map.getLayer("zones-line")
    ? "zones-line"
    : (map.getLayer("zone-labels") ? "zone-labels" : undefined);

  if (map.getLayer("pickup-zone-hotspots-core")) {
    map.removeLayer("pickup-zone-hotspots-core");
  }
  if (map.getLayer("pickup-zone-hotspots-line-halo")) {
    map.removeLayer("pickup-zone-hotspots-line-halo");
  }

  if (!map.getLayer("pickup-zone-hotspots-underpaint")) {
    map.addLayer(
      {
        id: "pickup-zone-hotspots-underpaint",
        type: "fill",
        source: "pickup-zone-hotspots",
        paint: {
          "fill-color": [
            "interpolate",
            ["linear"],
            ["coalesce", ["get", "intensity"], 0.35],
            0.00,
            "#fffef8",
            0.45,
            "#fff9df",
            0.75,
            "#fff4c9",
            1.00,
            "#ffeeb6",
          ],
          "fill-opacity": [
            "interpolate",
            ["linear"],
            ["coalesce", ["get", "intensity"], 0.35],
            0.00,
            0.52,
            0.45,
            0.64,
            0.75,
            0.74,
            1.00,
            0.84,
          ],
        },
      },
      hotspotBeforeLayer
    );
  } else {
    map.setPaintProperty("pickup-zone-hotspots-underpaint", "fill-color", [
      "interpolate",
      ["linear"],
      ["coalesce", ["get", "intensity"], 0.35],
      0.00,
      "#fffef8",
      0.45,
      "#fff9df",
      0.75,
      "#fff4c9",
      1.00,
      "#ffeeb6",
    ]);
    map.setPaintProperty("pickup-zone-hotspots-underpaint", "fill-opacity", [
      "interpolate",
      ["linear"],
      ["coalesce", ["get", "intensity"], 0.35],
      0.00,
      0.52,
      0.45,
      0.64,
      0.75,
      0.74,
      1.00,
      0.84,
    ]);
  }

  if (!map.getLayer("pickup-zone-hotspots-fill")) {
    map.addLayer(
      {
        id: "pickup-zone-hotspots-fill",
        type: "fill",
        source: "pickup-zone-hotspots",
        paint: {
          "fill-color": [
            "interpolate",
            ["linear"],
            ["coalesce", ["get", "intensity"], 0.35],
            0.00,
            "#fff7bd",
            0.45,
            "#ffe781",
            0.75,
            "#ffd94d",
            1.00,
            "#ffc92b",
          ],
          "fill-opacity": [
            "interpolate",
            ["linear"],
            ["coalesce", ["get", "intensity"], 0.35],
            0.00,
            0.46,
            0.45,
            0.58,
            0.75,
            0.70,
            1.00,
            0.80,
          ],
        },
      },
      hotspotBeforeLayer
    );
  } else {
    map.setPaintProperty("pickup-zone-hotspots-fill", "fill-color", [
      "interpolate",
      ["linear"],
      ["coalesce", ["get", "intensity"], 0.35],
      0.00,
      "#fff7bd",
      0.45,
      "#ffe781",
      0.75,
      "#ffd94d",
      1.00,
      "#ffc92b",
    ]);
    map.setPaintProperty("pickup-zone-hotspots-fill", "fill-opacity", [
      "interpolate",
      ["linear"],
      ["coalesce", ["get", "intensity"], 0.35],
      0.00,
      0.46,
      0.45,
      0.58,
      0.75,
      0.70,
      1.00,
      0.80,
    ]);
  }

  if (!map.getLayer("pickup-zone-hotspots-line")) {
    map.addLayer(
      {
        id: "pickup-zone-hotspots-line",
        type: "line",
        source: "pickup-zone-hotspots",
        minzoom: 10.8,
        paint: {
          "line-color": [
            "interpolate",
            ["linear"],
            ["coalesce", ["get", "intensity"], 0.35],
            0.00,
            "#fffbe0",
            0.45,
            "#ffef9c",
            0.75,
            "#ffe16e",
            1.00,
            "#ffd03e",
          ],
          "line-opacity": [
            "interpolate",
            ["linear"],
            ["coalesce", ["get", "intensity"], 0.35],
            0.00,
            0.88,
            0.45,
            0.94,
            0.75,
            0.97,
            1.00,
            0.99,
          ],
          "line-width": [
            "interpolate",
            ["linear"],
            ["coalesce", ["get", "intensity"], 0.35],
            0.00,
            3.6,
            0.45,
            4.8,
            0.75,
            6.4,
            1.00,
            7.6,
          ],
        },
      },
      hotspotBeforeLayer
    );
  } else {
    map.setPaintProperty("pickup-zone-hotspots-line", "line-color", [
      "interpolate",
      ["linear"],
      ["coalesce", ["get", "intensity"], 0.35],
      0.00,
      "#fffbe0",
      0.45,
      "#ffef9c",
      0.75,
      "#ffe16e",
      1.00,
      "#ffd03e",
    ]);
    map.setPaintProperty("pickup-zone-hotspots-line", "line-opacity", [
      "interpolate",
      ["linear"],
      ["coalesce", ["get", "intensity"], 0.35],
      0.00,
      0.88,
      0.45,
      0.94,
      0.75,
      0.97,
      1.00,
      0.99,
    ]);
    map.setPaintProperty("pickup-zone-hotspots-line", "line-width", [
      "interpolate",
      ["linear"],
      ["coalesce", ["get", "intensity"], 0.35],
      0.00,
      3.6,
      0.45,
      4.8,
      0.75,
      6.4,
      1.00,
      7.6,
    ]);
  }

  if (map.getLayer("pickup-zone-hotspots-underpaint")) {
    map.moveLayer("pickup-zone-hotspots-underpaint", hotspotBeforeLayer);
  }
  if (map.getLayer("pickup-zone-hotspots-fill")) {
    map.moveLayer("pickup-zone-hotspots-fill", hotspotBeforeLayer);
  }
  if (map.getLayer("pickup-zone-hotspots-line")) {
    map.moveLayer("pickup-zone-hotspots-line", hotspotBeforeLayer);
  }

  if (!map.getLayer("pickup-micro-hotspots-glow")) {
    map.addLayer({
      id: "pickup-micro-hotspots-glow",
      type: "circle",
      source: "pickup-micro-hotspots",
      minzoom: PICKUP_MICRO_HOTSPOT_MIN_ZOOM,
      paint: {
        "circle-radius": [
          "interpolate", ["linear"], ["zoom"],
          PICKUP_MICRO_HOTSPOT_MIN_ZOOM, ["case", ["coalesce", ["get", "recommended"], false], 5.8, 4.0],
          16, ["case", ["coalesce", ["get", "recommended"], false], 8.0, 5.2]
        ],
        "circle-color": ["case", ["coalesce", ["get", "recommended"], false], "rgba(255,215,79,0.16)", "rgba(255,215,79,0.06)"],
        "circle-opacity": ["case", ["coalesce", ["get", "recommended"], false], 0.56, 0.20],
        "circle-blur": 0.7,
      },
    }, "zone-labels");
  }

  if (!map.getLayer("pickup-micro-hotspots-core")) {
    map.addLayer({
      id: "pickup-micro-hotspots-core",
      type: "circle",
      source: "pickup-micro-hotspots",
      minzoom: PICKUP_MICRO_HOTSPOT_MIN_ZOOM,
      paint: {
        "circle-radius": [
          "interpolate", ["linear"], ["zoom"],
          PICKUP_MICRO_HOTSPOT_MIN_ZOOM, ["case", ["coalesce", ["get", "recommended"], false], 2.8, 1.7],
          16, ["case", ["coalesce", ["get", "recommended"], false], 4.2, 2.4]
        ],
        "circle-color": ["case", ["coalesce", ["get", "recommended"], false], "rgba(255,255,255,0.98)", "rgba(255,243,199,0.62)"],
        "circle-opacity": ["case", ["coalesce", ["get", "recommended"], false], 0.98, 0.36],
        "circle-stroke-color": ["case", ["coalesce", ["get", "recommended"], false], "rgba(255,190,46,1)", "rgba(255,190,46,0.45)"],
        "circle-stroke-width": ["case", ["coalesce", ["get", "recommended"], false], 1.0, 0.6],
      },
    }, "zone-labels");
  }

  if (!map.getLayer("pickup-micro-hotspots-ring")) {
    map.addLayer({
      id: "pickup-micro-hotspots-ring",
      type: "circle",
      source: "pickup-micro-hotspots",
      minzoom: 11.0,
      paint: {
        "circle-radius": [
          "interpolate", ["linear"], ["zoom"],
          PICKUP_MICRO_HOTSPOT_MIN_ZOOM, ["case", ["coalesce", ["get", "recommended"], false], 6.8, 5.0],
          16, ["case", ["coalesce", ["get", "recommended"], false], 9.6, 6.8]
        ],
        "circle-color": "rgba(0,0,0,0)",
        "circle-stroke-color": ["case", ["coalesce", ["get", "recommended"], false], "rgba(255,201,64,0.72)", "rgba(255,201,64,0.34)"],
        "circle-stroke-width": ["case", ["coalesce", ["get", "recommended"], false], 1.0, 0.6],
        "circle-opacity": ["case", ["coalesce", ["get", "recommended"], false], 0.46, 0.22],
      },
    }, "zone-labels");
  }

  if (!map.getLayer("pickup-heat")) {
    map.addLayer(
      {
        id: "pickup-heat",
        type: "heatmap",
        source: "pickup-points",
        minzoom: 10.8,
        paint: {
          "heatmap-weight": ["interpolate", ["linear"], ["coalesce", ["get", "recency_score"], 0.2], 0, 0.2, 1, 1],
          "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 9, 0.6, 12, 0.95, 15, 1.25],
          "heatmap-color": [
            "interpolate",
            ["linear"],
            ["heatmap-density"],
            0,
            "rgba(0,0,0,0)",
            0.15,
            "rgba(102,204,255,0.18)",
            0.35,
            "rgba(0,102,255,0.28)",
            0.55,
            "rgba(128,0,255,0.42)",
            0.75,
            "rgba(0,176,80,0.58)",
            1,
            "rgba(0,176,80,0.88)"
          ],
          "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 9, 12, 12, 18, 14, 24, 16, 32],
          "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 9, 0.55, 15, 0.82],
        },
      },
      "zone-labels"
    );
  }

  if (!map.getLayer("pickup-circles-glow")) {
    map.addLayer(
      {
        id: "pickup-circles-glow",
        type: "circle",
        source: "pickup-points",
        minzoom: 12.0,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 7, 16, 14],
          "circle-color": "rgba(0,176,80,0.28)",
          "circle-blur": 0.7,
          "circle-opacity": 0.9,
        },
      },
      "zone-labels"
    );
  }

  if (!map.getLayer("pickup-circles")) {
    map.addLayer(
      {
        id: "pickup-circles",
        type: "circle",
        source: "pickup-points",
        minzoom: 12.0,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 3.5, 16, 6],
          "circle-color": "rgba(255,255,255,0.92)",
          "circle-stroke-width": 2,
          "circle-stroke-color": "rgba(0,176,80,0.96)",
          "circle-opacity": 0.95,
        },
      },
      "zone-labels"
    );
  }

  if (!map.__pickupOverlayWired) {
    map.__pickupOverlayWired = true;

    map.on("mouseenter", "pickup-circles", () => {
      try { map.getCanvas().style.cursor = "pointer"; } catch {}
    });
    map.on("mouseleave", "pickup-circles", () => {
      try { map.getCanvas().style.cursor = ""; } catch {}
    });
    map.on("click", "pickup-circles", (e) => {
      try {
        const feat = e?.features?.[0];
        if (!feat) return;
        const props = feat.properties || {};
        const zoneName = (props.zone_name || "").trim();
        const borough = (props.borough || "").trim();
        const frameTime = (props.frame_time || "").trim();
        const createdAt = Number(props.created_at ?? NaN);
        const when = Number.isFinite(createdAt) ? formatRelativeAge(createdAt) : "unknown";
        const zoneStat = pickupZoneStats.get(String(props.zone_id ?? ""));
        const zoneAvgSample = Number(zoneStat?.sample_size ?? 0);
        const zoneAvgLimit = Number(zoneStat?.sample_limit ?? PICKUP_ZONE_SAMPLE_LIMIT);
        const zoneAvgLine = zoneAvgSample > 0
          ? `<div><b>Zone avg:</b> ${zoneAvgSample}/${zoneAvgLimit} trips used</div>`
          : "";
        new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: "280px" })
          .setLngLat(e.lngLat)
          .setHTML(`
            <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; font-size:13px;">
              <div style="font-weight:900; margin-bottom:4px;">Recorded trip report</div>
              <div><b>Zone:</b> ${escapeHtml(zoneName || `Zone ${props.zone_id || ""}`)}</div>
              ${borough ? `<div><b>Borough:</b> ${escapeHtml(borough)}</div>` : ""}
              <div><b>When:</b> ${escapeHtml(when)}</div>
              ${frameTime ? `<div><b>Frame:</b> ${escapeHtml(frameTime)}</div>` : ""}
              ${zoneAvgLine}
            </div>
          `)
          .addTo(map);
      } catch (err) {
        console.warn("pickup popup failed:", err);
      }
    });

    map.on("mouseenter", "pickup-zone-hotspots-fill", () => {
      try { map.getCanvas().style.cursor = "pointer"; } catch {}
    });
    map.on("mouseleave", "pickup-zone-hotspots-fill", () => {
      try { map.getCanvas().style.cursor = ""; } catch {}
    });
    map.on("click", "pickup-zone-hotspots-fill", (e) => {
      try {
        const feat = e?.features?.[0];
        if (!feat) return;
        const props = feat.properties || {};
        const zoneName = (props.zone_name || "").trim();
        const borough = (props.borough || "").trim();
        const sampleSize = Number(props.sample_size ?? NaN);
        const safeSampleSize = Number.isFinite(sampleSize) ? sampleSize : 0;
        const hotspotIndexRaw = Number(props.hotspot_index ?? props.hotspotIndex ?? NaN);
        const hotspotLabel = Number.isFinite(hotspotIndexRaw) ? `Hotspot #${Math.max(1, Math.round(hotspotIndexRaw) + 1)}` : "Hotspot";
        const mergedCount = Number(
          props.merged_component_count
          ?? props.merged_components_count
          ?? props.merged_candidates_count
          ?? props.merged_count
          ?? NaN
        );
        const merged = !!(props.merged || props.was_merged || props.is_merged || (Number.isFinite(mergedCount) && mergedCount > 1));
        const mergeLine = `<div><b>Merge:</b> ${merged ? "Merged from multiple candidate components" : "Single candidate component"}</div>`;
        new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: "290px" })
          .setLngLat(e.lngLat)
          .setHTML(`
            <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; font-size:13px;">
              <div style="font-weight:900; margin-bottom:4px;">Live hotspot area</div>
              <div><b>Zone:</b> ${escapeHtml(zoneName || `Zone ${props.zone_id || ""}`)}</div>
              ${borough ? `<div><b>Borough:</b> ${escapeHtml(borough)}</div>` : ""}
              <div><b>${escapeHtml(hotspotLabel)}</b></div>
              <div><b>Sample size:</b> ${safeSampleSize}</div>
              ${mergeLine}
              <div style="margin-top:6px;">Live hotspot area from recent recorded trips.</div>
              <div style="opacity:0.8; margin-top:2px;">Dynamic hotspot from latest ${PICKUP_ZONE_SAMPLE_LIMIT} trips max.</div>
            </div>
          `)
          .addTo(map);
      } catch (err) {
        console.warn("pickup hotspot popup failed:", err);
      }
    });

    map.on("mouseenter", "pickup-micro-hotspots-core", () => {
      try { map.getCanvas().style.cursor = "pointer"; } catch {}
    });
    map.on("mouseleave", "pickup-micro-hotspots-core", () => {
      try { map.getCanvas().style.cursor = ""; } catch {}
    });
    map.on("click", "pickup-micro-hotspots-core", (e) => {
      try {
        const feat = e?.features?.[0];
        if (!feat) return;
        const props = feat.properties || {};
        const zoneName = (props.zone_name || "").trim();
        const confidence = Number(props.confidence ?? NaN);
        const confidenceLine = Number.isFinite(confidence) ? `<div><b>Confidence:</b> ${(Math.max(0, Math.min(1, confidence)) * 100).toFixed(0)}%</div>` : "";
        const recLine = props.recommended ? `<div><b>Status:</b> Recommended micro-hotspot</div>` : "";
        new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: "300px" })
          .setLngLat(e.lngLat)
          .setHTML(`
            <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; font-size:13px;">
              <div style="font-weight:900; margin-bottom:4px;">Best wait point</div>
              <div><b>Zone:</b> ${escapeHtml(zoneName || `Zone ${props.zone_id || ""}`)}</div>
              ${recLine}
              ${confidenceLine}
            </div>
          `)
          .addTo(map);
      } catch (err) {
        console.warn("pickup micro-hotspot popup failed:", err);
      }
    });
  }

  await window.TlcCommunityCrowdingModule?.ensureCommunityCrowdingSourceAndLayers?.();

  return true;
}

function getBufferedMapBounds(bufferRatio = 0, minBufferDeg = 0) {
  if (!map || typeof map.getBounds !== "function") return null;
  const bounds = map.getBounds();
  if (!bounds) return null;
  const west = Number(bounds.getWest?.());
  const east = Number(bounds.getEast?.());
  const south = Number(bounds.getSouth?.());
  const north = Number(bounds.getNorth?.());
  if (![west, east, south, north].every(Number.isFinite)) return null;
  const lngSpan = Math.max(Math.abs(east - west), minBufferDeg * 2);
  const latSpan = Math.max(Math.abs(north - south), minBufferDeg * 2);
  const lngBuffer = Math.max(minBufferDeg, lngSpan * bufferRatio);
  const latBuffer = Math.max(minBufferDeg, latSpan * bufferRatio);
  return {
    west: Math.min(west, east) - lngBuffer,
    east: Math.max(west, east) + lngBuffer,
    south: Math.min(south, north) - latBuffer,
    north: Math.max(south, north) + latBuffer,
  };
}

function getPresenceViewportSignature() {
  if (!map || typeof map.getBounds !== "function") return "";
  const bounds = map.getBounds();
  if (!bounds) return "";
  const west = Number(bounds.getWest?.());
  const east = Number(bounds.getEast?.());
  const south = Number(bounds.getSouth?.());
  const north = Number(bounds.getNorth?.());
  const zoom = Number(map?.getZoom?.());
  if (![west, east, south, north, zoom].every(Number.isFinite)) return "";
  const roundCoord = (value) => Number(value).toFixed(2);
  const zoomBucket = (Math.round(zoom * 2) / 2).toFixed(1);
  return [
    roundCoord(Math.min(west, east)),
    roundCoord(Math.max(west, east)),
    roundCoord(Math.min(south, north)),
    roundCoord(Math.max(south, north)),
    zoomBucket,
  ].join('|');
}

function getPresenceRequestParams() {
  const bounds = getBufferedMapBounds(PRESENCE_VIEWPORT_BUFFER_RATIO, PRESENCE_VIEWPORT_MIN_BUFFER_DEG);
  const params = new URLSearchParams();
  if (bounds) {
    params.set("min_lng", String(bounds.west));
    params.set("max_lng", String(bounds.east));
    params.set("min_lat", String(bounds.south));
    params.set("max_lat", String(bounds.north));
  }
  const zoom = Number(map?.getZoom?.());
  if (Number.isFinite(zoom)) params.set("zoom", String(zoom));
  params.set("mode", zoom >= 12 ? "full" : "lite");
  params.set("limit", String(getPresenceSnapshotLimit()));
  params.set("include_removed", "true");
  params.set("padding_ratio", String(PRESENCE_VIEWPORT_BUFFER_RATIO));
  const viewportSignature = getPresenceViewportSignature();
  if (viewportSignature) params.set("viewport_sig", viewportSignature);
  params.set("refresh_tier", document.hidden ? "hidden" : (autoCenter ? "visible-fast" : "visible-idle"));
  return params;
}

function normalizePresenceRemovalId(value) {
  if (value == null || value === "") return "";
  if (typeof value === "object") {
    const objectId = value.user_id ?? value.userId ?? value.id;
    if (objectId == null || objectId === "") return "";
    return String(objectId);
  }
  return String(value);
}

function normalizePresenceRow(it, nowUnix) {
  const uid = String(it?.user_id ?? it?.userId ?? it?.id ?? "");
  if (!uid) return null;
  if (me && String(me.id) === uid) return null;

  const lat = Number(it?.lat ?? it?.latitude ?? NaN);
  const lng = Number(it?.lng ?? it?.longitude ?? NaN);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const updated = Number(it?.updated_at_unix ?? it?.ts_unix ?? it?.updated_at ?? NaN);
  if (Number.isFinite(updated) && nowUnix - updated > PRESENCE_STALE_SEC) return null;

  const reportedAccuracy = Number(it?.accuracy ?? it?.acc ?? NaN);
  if (Number.isFinite(reportedAccuracy) && reportedAccuracy > PRESENCE_ACCURACY_THRESHOLD) return null;

  return {
    uid,
    name: it?.display_name || it?.name || it?.email || "Driver",
    avatarUrl: getCachedAvatarUrl(uid, it?.avatar_thumb_url || it?.avatar_url || "", it?.avatar_version || it?.avatarVersion || ""),
    mode: it?.map_identity_mode || "name",
    lat,
    lng,
    heading: Number(it?.heading ?? it?.bearing ?? NaN),
    leaderboardBadgeCode: it?.leaderboard_badge_code || '',
    leaderboardHasCrown: !!it?.leaderboard_has_crown,
    updatedAt: it?.updated_at ?? it?.updated_at_unix ?? it?.ts_unix ?? null,
  };
}

function rebuildCachedPresenceRowsFromStore() {
  const nowUnix = Date.now() / 1000;
  const rows = [];
  for (const [uid, row] of presenceStore.entries()) {
    const updated = Number(row?.updatedAt ?? NaN);
    if (Number.isFinite(updated) && nowUnix - updated > PRESENCE_STALE_SEC) {
      presenceStore.delete(uid);
      continue;
    }
    rows.push(row);
  }
  return rows;
}

function mergePresencePayload(list, { replaceStore = false, removals = [] } = {}) {
  if (replaceStore) presenceStore.clear();
  for (const removal of removals || []) {
    const uid = normalizePresenceRemovalId(removal);
    if (uid) presenceStore.delete(uid);
  }
  const nowUnix = Date.now() / 1000;
  for (const item of list || []) {
    const normalized = normalizePresenceRow(item, nowUnix);
    if (!normalized) continue;
    presenceStore.set(String(normalized.uid), normalized);
  }
  return rebuildCachedPresenceRowsFromStore();
}

function presenceHasViewportBounds(params) {
  return ["min_lng", "max_lng", "min_lat", "max_lat"].every((key) => {
    const value = params?.get?.(key);
    return value !== null && value !== "";
  });
}

function isPresenceDeltaUnsupportedError(error) {
  const status = Number(error?.status ?? NaN);
  if (status === 404 || status === 405 || status === 501) return true;
  const message = String(error?.message || "").toLowerCase();
  const detail = JSON.stringify(error?.detail || error?.payload || "").toLowerCase();
  return (
    message.includes("not implemented") ||
    message.includes("unsupported") ||
    detail.includes("not implemented") ||
    detail.includes("unsupported")
  );
}

function normalizePresenceSyncTimestampMs(value) {
  if (value === null || value === undefined || value === "") return NaN;
  if (typeof value === "string" && /[a-z]/i.test(value)) {
    const parsedDate = Date.parse(value);
    return Number.isFinite(parsedDate) ? parsedDate : NaN;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return NaN;
  return numeric > 1e12 ? Math.floor(numeric) : Math.floor(numeric * 1000);
}

function getPresenceDeltaCursorMs() {
  const cursorMs = normalizePresenceSyncTimestampMs(presenceLastSyncCursor);
  if (Number.isFinite(cursorMs) && cursorMs > 0) return cursorMs;
  const timestampMs = normalizePresenceSyncTimestampMs(presenceLastSyncTimestamp);
  if (Number.isFinite(timestampMs) && timestampMs > 0) return timestampMs;
  return 0;
}

function updatePresenceSyncCursorFromPayload(payload) {
  const nextSyncTs = normalizePresenceSyncTimestampMs(
    payload?.next_updated_since_ms ??
    payload?.cursor ??
    payload?.next_cursor ??
    payload?.sync_cursor ??
    payload?.last_sync_ms ??
    payload?.server_ts_ms ??
    payload?.server_time_ms ??
    payload?.server_ts ??
    payload?.server_time ??
    payload?.next_since_ts ??
    payload?.last_sync_ts ??
    payload?.last_updated_at
  );
  if (Number.isFinite(nextSyncTs) && nextSyncTs > 0) {
    presenceLastSyncCursor = nextSyncTs;
    presenceLastSyncTimestamp = nextSyncTs;
    return nextSyncTs;
  }
  const maxItemUpdatedAt = extractPresenceItems(payload).reduce((maxTs, item) => {
    const itemTs = normalizePresenceSyncTimestampMs(
      item?.updated_at_ms ??
      item?.updated_at ??
      item?.updated_at_unix ??
      item?.ts_unix ??
      item?.last_seen_at
    );
    return Number.isFinite(itemTs) && itemTs > maxTs ? itemTs : maxTs;
  }, 0);
  const fallbackTs = maxItemUpdatedAt > 0 ? maxItemUpdatedAt : Date.now();
  presenceLastSyncCursor = fallbackTs;
  presenceLastSyncTimestamp = fallbackTs;
  return fallbackTs;
}

function extractPresenceItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.changes)) return payload.changes;
  if (Array.isArray(payload?.drivers)) return payload.drivers;
  if (Array.isArray(payload?.presence)) return payload.presence;
  return [];
}

function hasUsablePresencePayload(payload) {
  if (Array.isArray(payload)) return true;
  if (!payload || typeof payload !== "object") return false;
  return (
    Array.isArray(payload.items) ||
    Array.isArray(payload.changes) ||
    Array.isArray(payload.drivers) ||
    Array.isArray(payload.presence) ||
    Array.isArray(payload.removed) ||
    Array.isArray(payload.removed_user_ids) ||
    Array.isArray(payload.deleted_user_ids) ||
    payload.full_snapshot === true ||
    payload.replace_all === true
  );
}

function isUsablePresenceCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0;
}

async function fetchPresencePayload(params, signal) {
  const prefersViewportSnapshot = presenceHasViewportBounds(params);
  let deltaCursorMs = getPresenceDeltaCursorMs();

  if (presenceDeltaMode !== 'disabled' && deltaCursorMs > 0) {
    try {
      let pageCount = 0;
      let hasMore = true;
      let finalDeltaPayload = null;
      let aggregatedItems = [];
      let aggregatedRemoved = [];
      let sawReplaceAll = false;

      while (hasMore && pageCount < PRESENCE_DELTA_MAX_PAGES_PER_CYCLE) {
        const requestCursorMs = deltaCursorMs;
        const deltaParams = new URLSearchParams(params.toString());
        deltaParams.set(PRESENCE_DELTA_SINCE_MS_PARAM, String(Math.floor(requestCursorMs)));
        const delta = await getJSONAuth(`${PRESENCE_DELTA_ROUTE}?${deltaParams.toString()}`, communityToken, { signal });
        if (!hasUsablePresencePayload(delta)) {
          throw Object.assign(new Error("Unsupported /presence/delta response shape"), { status: 422, detail: delta });
        }

        pageCount += 1;
        finalDeltaPayload = delta;
        // Aggregate delta pages and merge once in pullPresenceAll().
        aggregatedItems = aggregatedItems.concat(extractPresenceItems(delta));
        if (Array.isArray(delta?.removed)) aggregatedRemoved = aggregatedRemoved.concat(delta.removed);
        if (Array.isArray(delta?.removed_user_ids)) aggregatedRemoved = aggregatedRemoved.concat(delta.removed_user_ids);
        if (Array.isArray(delta?.deleted_user_ids)) aggregatedRemoved = aggregatedRemoved.concat(delta.deleted_user_ids);

        const replaceStore = !!(
          delta?.full_snapshot === true ||
          delta?.replace_all === true ||
          delta?.mode === 'full'
        );
        sawReplaceAll = sawReplaceAll || replaceStore;

        const nextCursorMs = normalizePresenceSyncTimestampMs(
          delta?.next_updated_since_ms ??
          delta?.cursor ??
          delta?.next_cursor ??
          delta?.sync_cursor
        );
        if (Number.isFinite(nextCursorMs) && nextCursorMs > 0) {
          deltaCursorMs = nextCursorMs;
        }

        hasMore = delta?.has_more === true || delta?.hasMore === true;
        if (hasMore && (!Number.isFinite(nextCursorMs) || nextCursorMs <= requestCursorMs)) {
          hasMore = false;
        }
        if (sawReplaceAll) break;
      }

      const deltaResponse = {
        ...(finalDeltaPayload && typeof finalDeltaPayload === "object" ? finalDeltaPayload : {}),
        items: aggregatedItems,
        removed: aggregatedRemoved,
      };
      if (sawReplaceAll) {
        deltaResponse.full_snapshot = true;
      }
      if (Number.isFinite(deltaCursorMs) && deltaCursorMs > 0) {
        deltaResponse.next_updated_since_ms = deltaCursorMs;
      }

      presenceDeltaMode = 'enabled';
      return { payload: deltaResponse, mode: 'delta' };
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      if (isPresenceDeltaUnsupportedError(error)) {
        presenceDeltaMode = 'disabled';
      } else {
        console.warn('/presence/delta failed, falling back to snapshot presence fetch:', error);
      }
    }
  }

  if (prefersViewportSnapshot && presenceViewportMode !== 'disabled') {
    try {
      const viewport = await getJSONAuth(`${PRESENCE_VIEWPORT_ROUTE}?${params.toString()}`, communityToken, { signal });
      if (!hasUsablePresencePayload(viewport)) {
        throw Object.assign(new Error("Unsupported /presence/viewport response shape"), { status: 422, detail: viewport });
      }
      presenceViewportMode = 'enabled';
      return { payload: viewport, mode: 'viewport' };
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      if (isPresenceDeltaUnsupportedError(error)) {
        presenceViewportMode = 'disabled';
      } else {
        console.warn('/presence/viewport failed, falling back to /presence/all:', error);
      }
    }
  }

  const full = await getJSONAuth(`${PRESENCE_ALL_ROUTE}?${params.toString()}`, communityToken, { signal });
  return { payload: full, mode: 'full' };
}

function pickupOverlayQueryPath(limit = PICKUP_RECENT_LIMIT) {
  const bounds = getBufferedMapBounds(PICKUP_VIEWPORT_BUFFER_RATIO, PICKUP_VIEWPORT_MIN_BUFFER_DEG);
  if (!bounds) return null;
  const west = Number(bounds.west);
  const east = Number(bounds.east);
  const south = Number(bounds.south);
  const north = Number(bounds.north);
  if (![west, east, south, north].every(Number.isFinite)) return null;

  const qs = new URLSearchParams({
    limit: String(limit),
    zone_sample_limit: String(PICKUP_ZONE_SAMPLE_LIMIT),
    min_lng: String(Math.min(west, east)),
    max_lng: String(Math.max(west, east)),
    min_lat: String(Math.min(south, north)),
    max_lat: String(Math.max(south, north)),
  });
  return `/events/pickups/recent?${qs.toString()}`;
}

function buildPickupViewportKey() {
  if (!map) return "";
  const b = map.getBounds?.();
  if (!b) return "";
  const zoom = Number(map.getZoom?.());
  const west = Number(b.getWest?.());
  const east = Number(b.getEast?.());
  const south = Number(b.getSouth?.());
  const north = Number(b.getNorth?.());
  if (![west, east, south, north, zoom].every(Number.isFinite)) return "";
  const roundCoord = (value) => Number(value).toFixed(2);
  const zoomBucket = (Math.round(zoom * 2) / 2).toFixed(1);
  return [
    roundCoord(Math.min(west, east)),
    roundCoord(Math.max(west, east)),
    roundCoord(Math.min(south, north)),
    roundCoord(Math.max(south, north)),
    zoomBucket,
  ].join("|");
}

async function refreshPickupOverlay({ force = false } = {}) {
  frontendPerfStats.pickupFetchesAttempted += 1;
  const startedAt = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  if (pickupRefreshInFlight) {
    pickupRefreshQueued = true;
    pickupRefreshQueuedForce = pickupRefreshQueuedForce || !!force;
    return;
  }
  if (!mapPageIsVisible) return;
  if (!map || !mapReady) return;
  const ready = await ensurePickupSourceAndLayers();
  if (!ready) return;

  if (!authHeaderOK()) {
    clearPickupOverlay();
    return;
  }

  const path = pickupOverlayQueryPath(PICKUP_RECENT_LIMIT);
  if (!path) return;
  const viewportKey = buildPickupViewportKey();

  const now = Date.now();
  if (!force && path === lastPickupFetchKey && viewportKey === lastPickupViewportKey && now - lastPickupFetchMs < PICKUP_FETCH_COOLDOWN_MS) return;

  pickupOverlayAbortController = new AbortController();
  const requestSerial = ++pickupRequestSerial;

  pickupRefreshInFlight = true;
  lastPickupFetchKey = path;
  lastPickupViewportKey = viewportKey;
  lastPickupFetchMs = now;

  try {
    const data = await getJSONAuth(path, communityToken, { signal: pickupOverlayAbortController.signal });
    if (requestSerial < appliedPickupRequestSerial) return;
    frontendPerfStats.pickupFetchesCompleted += 1;
    const items = Array.isArray(data) ? data : data?.items || [];
    const zoneStats = Array.isArray(data?.zone_stats) ? data.zone_stats : [];
    const zoneHotspots = (data?.zone_hotspots && data.zone_hotspots.type === "FeatureCollection" && Array.isArray(data.zone_hotspots.features))
      ? data.zone_hotspots
      : emptyGeojson();
    const hotspotPolygonZoneIds = new Set();
    for (const feat of zoneHotspots.features || []) {
      const zoneId = normalizePickupZoneId(feat?.properties?.zone_id ?? feat?.properties?.zoneId ?? feat?.properties?.location_id ?? feat?.properties?.LocationID);
      if (zoneId != null) hotspotPolygonZoneIds.add(zoneId);
    }
    const topLevelMicroHotspotPayload = data?.micro_hotspots ?? data?.micro_hotspot_clusters ?? data?.hotspot_micro_clusters ?? null;
    const topLevelMicroHotspots = normalizePickupMicroHotspots(topLevelMicroHotspotPayload, hotspotPolygonZoneIds);
    const nestedMicroHotspotRows = extractNestedPickupMicroHotspots(zoneHotspots, hotspotPolygonZoneIds);
    const fallbackNestedMicroHotspots = normalizePickupMicroHotspots(nestedMicroHotspotRows, hotspotPolygonZoneIds);
    const mergedMicroByKey = new Map();
    for (const feat of [...(topLevelMicroHotspots.features || []), ...(fallbackNestedMicroHotspots.features || [])]) {
      const key = [
        String(feat?.properties?.zone_id ?? ""),
        String(feat?.properties?.hotspot_id ?? ""),
        String(feat?.properties?.hotspot_index ?? ""),
      ].join("|");
      if (!mergedMicroByKey.has(key)) mergedMicroByKey.set(key, feat);
    }
    const microHotspots = { type: "FeatureCollection", features: Array.from(mergedMicroByKey.values()) };
    const zoneHotspotCount = zoneHotspots?.features?.length ?? 0;
    const normalizedMicroHotspotCount = microHotspots?.features?.length ?? 0;
    const fc = buildPickupFeatureCollection(items);
    appliedPickupRequestSerial = requestSerial;
    setPickupOverlayData(fc, items, zoneStats, zoneHotspots, microHotspots);
    const coveredZonesCount = window.__pickupDebug?.hotspotCoveredZoneIds?.length ?? 0;
    const visibleDotsCount = window.__pickupDebug?.visiblePickupDotCount ?? 0;
    console.log(
      `[pickup overlay] zoneHotspots=${zoneHotspotCount} microHotspots=${normalizedMicroHotspotCount} coveredZones=${coveredZonesCount} visibleDots=${visibleDotsCount}`
    );
  } catch (e) {
    if (e?.name === "AbortError") {
      frontendPerfStats.pickupFetchesAborted += 1;
      return;
    }
    const status = Number(e?.status ?? NaN);
    if (status === 401) {
      clearAuth();
      return;
    }
    console.warn(`/events/pickups/recent failed (${path}):`, e);
  } finally {
    const endedAt = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    recordPerfMetric("dbgPickupOverlay", `${Math.max(0, Math.round(endedAt - startedAt))}ms`);
    runtimePerf?.recordDuration?.("pickup_overlay_fetch", endedAt - startedAt);
    pickupRefreshInFlight = false;
    pickupOverlayAbortController = null;
    const queuedFollowUp = pickupRefreshQueued;
    const queuedForce = pickupRefreshQueuedForce;
    pickupRefreshQueued = false;
    pickupRefreshQueuedForce = false;
    if (queuedFollowUp && authHeaderOK() && !document.hidden && mapPageIsVisible && map && mapReady) {
      schedulePickupOverlayRefresh({ force: queuedForce });
    }
  }
}

function schedulePickupOverlayRefresh({ force = false } = {}) {
  if (!force) {
    const nextViewportKey = buildPickupViewportKey();
    if (nextViewportKey && nextViewportKey === lastPickupViewportKey) return;
  }
  if (runtimePolling) runtimePolling.clear("app:pickup-refresh");
  if (pickupRefreshTimer) clearTimeout(pickupRefreshTimer);
  const runner = () => {
    pickupRefreshTimer = null;
    refreshPickupOverlay({ force }).catch((e) => console.warn("/events/pickups/recent refresh scheduler failed:", e));
  };
  if (runtimePolling) {
    pickupRefreshTimer = runtimePolling.setTimeout("app:pickup-refresh", runner, force ? 0 : PICKUP_REFRESH_DEBOUNCE_MS);
    return;
  }
  pickupRefreshTimer = setTimeout(runner, force ? 0 : PICKUP_REFRESH_DEBOUNCE_MS);
}

function clearPickupPollTimer() {
  if (runtimePolling) runtimePolling.clear("app:pickup-poll");
  if (pickupPollTimer) {
    clearTimeout(pickupPollTimer);
    pickupPollTimer = null;
  }
}

function schedulePickupPoll({ immediate = false } = {}) {
  clearPickupPollTimer();
  if (!authHeaderOK() || document.hidden) return;
  const delay = immediate ? 0 : PICKUP_POLL_MS;
  const runner = () => {
    pickupPollTimer = null;
    runPickupPollLoop().catch((e) => console.warn("pickup poll loop failed:", e));
  };
  if (runtimePolling) {
    pickupPollTimer = runtimePolling.setTimeout("app:pickup-poll", runner, Math.max(0, delay));
    return;
  }
  pickupPollTimer = setTimeout(runner, Math.max(0, delay));
}

async function runPickupPollLoop() {
  if (!authHeaderOK() || document.hidden) {
    clearPickupPollTimer();
    return;
  }

  try {
    await refreshPickupOverlay({ force: true });
  } finally {
    if (authHeaderOK() && !document.hidden) schedulePickupPoll();
  }
}

window.runCommunityVisibilitySmokeTest = async function () {
  const result = {
    signed_in: !!communityToken,
    me_id: null,
    me_is_admin: false,
    presence_all_ok: false,
    presence_all_count: 0,
    presence_summary_ok: false,
    online_count: 0,
    ghosted_count: 0,
    pickup_overlay_ok: false,
    pickup_items_count: 0,
    pickup_zone_hotspot_count: 0,
    pickup_micro_hotspot_count: 0,
    errors: [],
  };

  const token = communityToken;
  if (!token) {
    result.errors.push("Not signed in.");
    window.__communityVisibilitySmokeTest = result;
    return result;
  }

  try {
    const meData = await getJSONAuth("/me", token);
    result.me_id = meData?.id ?? null;
    result.me_is_admin = !!meData?.is_admin;
  } catch (e) {
    console.warn("/me smoke test failed:", e);
    result.errors.push(`/me: ${e?.message || String(e)}`);
  }

  try {
    const presenceAll = await getJSONAuth("/presence/all", token);
    const items = Array.isArray(presenceAll) ? presenceAll : (Array.isArray(presenceAll?.items) ? presenceAll.items : []);
    result.presence_all_ok = true;
    result.presence_all_count = items.length;
  } catch (e) {
    console.warn("/presence/all smoke test failed:", e);
    result.errors.push(`/presence/all: ${e?.message || String(e)}`);
  }

  try {
    const summary = await getJSONAuth("/presence/summary", token);
    result.presence_summary_ok = true;
    result.online_count = Number(summary?.online_count) || 0;
    result.ghosted_count = Number(summary?.ghosted_count) || 0;
  } catch (e) {
    console.warn("/presence/summary smoke test failed:", e);
    result.errors.push(`/presence/summary: ${e?.message || String(e)}`);
  }

  try {
    const path = pickupOverlayQueryPath(PICKUP_RECENT_LIMIT);
    if (!path) {
      throw new Error("Pickup overlay query path unavailable.");
    }
    const overlay = await getJSONAuth(path, token);
    const items = Array.isArray(overlay) ? overlay : (Array.isArray(overlay?.items) ? overlay.items : []);
    const zoneHotspots = (overlay?.zone_hotspots && overlay.zone_hotspots.type === "FeatureCollection" && Array.isArray(overlay.zone_hotspots.features))
      ? overlay.zone_hotspots.features
      : [];
    const topLevelMicroHotspotPayload = overlay?.micro_hotspots ?? overlay?.micro_hotspot_clusters ?? overlay?.hotspot_micro_clusters ?? null;
    const microHotspots = normalizePickupMicroHotspots(topLevelMicroHotspotPayload, new Set());
    result.pickup_overlay_ok = true;
    result.pickup_items_count = items.length;
    result.pickup_zone_hotspot_count = zoneHotspots.length;
    result.pickup_micro_hotspot_count = Array.isArray(microHotspots?.features) ? microHotspots.features.length : 0;
  } catch (e) {
    console.warn("/events/pickups/recent smoke test failed:", e);
    result.errors.push(`/events/pickups/recent: ${e?.message || String(e)}`);
  }

  window.__communityVisibilitySmokeTest = result;
  return result;
};


/* =========================================================
   COMMUNITY (AUTH + PRESENCE + POLICE + PICKUP)
   ========================================================= */
const lockedOverlay = document.getElementById("lockedOverlay");
const authEmail = document.getElementById("authEmail");
const authPass = document.getElementById("authPass");
const authName = document.getElementById("authName");
const authGhost = document.getElementById("authGhost");
const btnLogin = document.getElementById("btnLogin");
const btnSignup = document.getElementById("btnSignup");
const authStatus = document.getElementById("authStatus");
const btnAuth = document.getElementById("btnAuth");
const btnGhostMode = document.getElementById("btnGhostMode");
const btnChangePassword = document.getElementById("btnChangePassword");
const btnDeleteAccount = document.getElementById("btnDeleteAccount");

const btnPolice = document.getElementById("btnPolice");
const btnPickup = document.getElementById("btnPickup");
const pickupFab = document.getElementById("pickupFab");
const communityNote = document.getElementById("communityNote");

function syncCommunityIdentityGlobals() {
  const hasWindow = typeof window !== "undefined";
  const hasLocalStorage = typeof localStorage !== "undefined";
  const signedIn = !!(authHeaderOK() && me);
  const displayName = String(me?.display_name || "").trim();

  if (signedIn) {
    const meId = me?.id != null ? String(me.id) : "";
    if (hasWindow) {
      window.me = me || null;
      window.communityMe = me || null;
      window.communityMeId = meId;
      window.communityDisplayName = displayName;
    }
    if (hasLocalStorage) {
      if (meId) localStorage.setItem("community_me_id_v1", meId);
      else localStorage.removeItem("community_me_id_v1");
      localStorage.setItem("community_display_name_v1", displayName);
    }
    return;
  }

  if (hasWindow) {
    window.me = null;
    window.communityMe = null;
    window.communityMeId = "";
    window.communityDisplayName = "";
  }
  if (hasLocalStorage) {
    localStorage.removeItem("community_me_id_v1");
  }
}
function syncAdminPortalSession() {
  if (typeof window === 'undefined' || !window.AdminPortal) return;
  window.AdminPortal.setSession?.({ me, token: communityToken });
  window.AdminPortal.refreshVisibility?.();

  const isAdminUser = !!me?.is_admin;
  if (dockAdmin) {
    dockAdmin.hidden = !isAdminUser;
    dockAdmin.setAttribute("aria-hidden", isAdminUser ? "false" : "true");
  }

  const floatingAdminLauncher = document.getElementById("adminPortalLauncher");
  if (floatingAdminLauncher) {
    floatingAdminLauncher.hidden = true;
    floatingAdminLauncher.style.display = "none";
    floatingAdminLauncher.setAttribute("aria-hidden", "true");
  }
}

window.syncAdminPortalSession = syncAdminPortalSession;

// other drivers markers
const otherMarkers = new Map(); // user_id -> marker
const driverMarkerVisualSignature = new Map();
const presenceStore = new Map();
let cachedPresenceRows = [];
let presenceRenderMode = 'full';
let presenceFocusedUserId = null;
let presenceLiteSourceFingerprint = '';
let presenceAdaptiveRenderRaf = 0;
let presenceLastSyncTimestamp = 0;
let presenceLastSyncCursor = 0;
let presenceDeltaMode = 'probe';
let presenceViewportMode = 'probe';
let lastPresenceViewportSignature = '';
let lastPresenceFetchViewportSignature = '';
let presenceSnapshotBoostUntilMs = 0;
let presenceLastSnapshotOverflow = false;
let presenceLastSnapshotVisibleTotal = 0;

function resetPresenceSnapshotOverflowState() {
  presenceSnapshotBoostUntilMs = 0;
  presenceLastSnapshotOverflow = false;
  presenceLastSnapshotVisibleTotal = 0;
}

function markPresenceSnapshotOverflowSignal() {
  presenceSnapshotBoostUntilMs = Date.now() + PRESENCE_SNAPSHOT_BOOST_WINDOW_MS;
  presenceLastSnapshotOverflow = true;
}

function notePresenceSnapshotResponseShape(payload, returnedCount) {
  const hasMore = payload?.has_more === true || payload?.hasMore === true;
  const visibleTotal = Number(
    payload?.visible_count_total ??
    payload?.visibleCountTotal ??
    payload?.summary?.visible_count_total ??
    payload?.counts?.visible_count_total
  );
  presenceLastSnapshotVisibleTotal = Number.isFinite(visibleTotal) && visibleTotal > 0 ? visibleTotal : 0;
  const isTruncated = hasMore
    || (presenceLastSnapshotVisibleTotal > 0 && Number.isFinite(returnedCount) && presenceLastSnapshotVisibleTotal > returnedCount);
  if (isTruncated) {
    markPresenceSnapshotOverflowSignal();
    return;
  }
  presenceLastSnapshotOverflow = false;
}

function getPresenceSnapshotLimit() {
  const nowMs = Date.now();
  const boostActive = presenceSnapshotBoostUntilMs > nowMs;
  const cachedCount = Array.isArray(cachedPresenceRows) ? cachedPresenceRows.length : 0;
  const renderHeavy = presenceRenderMode === 'heavy';
  const highCachedCount = cachedCount > 250;
  const visibleOverflow = presenceLastSnapshotVisibleTotal > 0 && presenceLastSnapshotVisibleTotal > cachedCount;
  if (renderHeavy || highCachedCount || boostActive || presenceLastSnapshotOverflow || visibleOverflow) {
    return PRESENCE_SNAPSHOT_HIGH_LIMIT;
  }
  return PRESENCE_SNAPSHOT_BASE_LIMIT;
}


function getCachedPresenceRowsSnapshot() {
  return Array.isArray(cachedPresenceRows)
    ? cachedPresenceRows.map((row) => ({ ...row }))
    : [];
}

// Bridge event for downstream modules (e.g., app.part15.js) to react to cache refreshes.
function emitCommunityPresenceCacheUpdated(detail = {}) {
  const crowdingFingerprint = presenceRowsCrowdingFingerprint(cachedPresenceRows);
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(new CustomEvent("team-joseo-community-presence-cache-updated", {
    detail: {
      count: Array.isArray(cachedPresenceRows) ? cachedPresenceRows.length : 0,
      fingerprint: cachedPresenceFingerprint || "",
      crowdingFingerprint,
      ...detail,
    },
  }));
}

const PRESENCE_FULL_MAX_VISIBLE = 50;
const PRESENCE_MEDIUM_MAX_VISIBLE = 100;
const PRESENCE_FULL_TO_MEDIUM_UP = 56;
const PRESENCE_MEDIUM_TO_FULL_DOWN = 44;
const PRESENCE_MEDIUM_TO_HEAVY_UP = 106;
const PRESENCE_HEAVY_TO_MEDIUM_DOWN = 92;
const PRESENCE_MEDIUM_RICH_LIMIT = 24;
const PRESENCE_HEAVY_RICH_LIMIT = 10;

const PRESENCE_LABEL_COLLISION_PX = 28;
const PRESENCE_SLOT_SEQUENCE = [
  { side: "E", angleDeg: 0 },
  { side: "W", angleDeg: 180 },
  { side: "N", angleDeg: -90 },
  { side: "S", angleDeg: 90 },
  { side: "NE", angleDeg: -45 },
  { side: "NW", angleDeg: -135 },
  { side: "SE", angleDeg: 45 },
  { side: "SW", angleDeg: 135 },
];

const accountActions = FrontendRuntime?.createAccountActions
  ? FrontendRuntime.createAccountActions({
      getToken: () => communityToken,
      clearAuth: () => clearAuth(),
      closeDrawer: () => closeDrawer(),
      requireToken: (actionLabel) => requireCommunityToken(actionLabel),
      afterSignOut: () => syncAdminPortalSession(),
      onPasswordChanged: () => {
        if (authPass) authPass.value = "";
      },
    })
  : null;

function syncGhostUI() {
  const ghostOn = !!me?.ghost_mode;
  if (btnGhostMode) {
    btnGhostMode.textContent = ghostOn ? "Ghost Mode: ON" : "Ghost Mode: OFF";
    btnGhostMode.classList.toggle("on", ghostOn);
    btnGhostMode.classList.toggle("disabled", !authHeaderOK());
  }
  if (authGhost) authGhost.checked = ghostOn;
}

function closeBlockingUiForSignedOutState() {
  const safeCall = (fn) => {
    if (typeof fn !== "function") return;
    try { fn(); } catch (_err) {}
  };

  safeCall(closeDrawer);
  safeCall(window.AdminPortal?.close?.bind(window.AdminPortal));
  safeCall(window.closeDriverProfileModal);
  safeCall(window.closeHot97Modal);
  safeCall(window.closeZonePopup);
  safeCall(window.closeActivePanel);
  safeCall(window.closePanel);
  safeCall(window.clearPanelBackdropState);
  safeCall(window.clearVisibleBackdropPanelState);
}

function showAuthOverlayAndFocus(reasonText = "Status: signed out") {
  setAuthUI(false, reasonText);
  closeBlockingUiForSignedOutState();

  if (lockedOverlay) {
    lockedOverlay.classList.add("show", "signed-out");
    lockedOverlay.setAttribute("aria-hidden", "false");
  }

  const emailValue = authEmail?.value?.trim?.() || "";
  const firstField = !emailValue ? authEmail : authPass;
  if (typeof firstField?.focus === "function") {
    firstField.focus();
    if (typeof firstField.select === "function" && firstField === authEmail) firstField.select();
  }
}

function signOutNow({ reload = false } = {}) {
  if (accountActions?.signOutNow) {
    accountActions.signOutNow({ reload: false });
  } else {
    clearAuth();
  }
  closeBlockingUiForSignedOutState();
  showAuthOverlayAndFocus("Status: signed out");
  if (reload) {
    setTimeout(() => {
      window.location.reload();
    }, 40);
  }
}

let lastProgressionSyncSignedInState = null;
function maybeSyncProgressionLifecycleForAuthState(signedIn) {
  const nextSignedIn = !!signedIn;
  if (lastProgressionSyncSignedInState === nextSignedIn) return;
  lastProgressionSyncSignedInState = nextSignedIn;
  try {
    const maybePromise = window.TlcDriverProfileModule?.maybeSyncProgressionOnSignInState?.();
    if (maybePromise && typeof maybePromise.catch === "function") {
      maybePromise.catch((err) => console.warn("Progression sync gate failed:", err));
    }
  } catch (err) {
    console.warn("Progression sync gate failed:", err);
  }
}

function setAuthUI(signedIn, note) {
  if (btnAuth) btnAuth.textContent = signedIn ? "Sign out" : "Sign in";
  if (communityNote) {
    communityNote.textContent = signedIn
      ? "Community: live drivers, police reports, and trip heat are visible."
      : "Community: sign in to see other drivers, report police, and record trips.";
  }

  const showLock = !signedIn;
  if (lockedOverlay) {
    lockedOverlay.classList.toggle("show", showLock);
    lockedOverlay.setAttribute("aria-hidden", showLock ? "false" : "true");
  }

  if (btnPolice) btnPolice.classList.toggle("disabled", !signedIn);
  if (btnPickup) btnPickup.classList.toggle("disabled", !signedIn);
  if (pickupFab) pickupFab.classList.toggle("disabled", !signedIn);
  enforceSaveButtonTheme();
  if (btnGhostMode) btnGhostMode.classList.toggle("disabled", !signedIn);
  if (btnChangePassword) btnChangePassword.classList.toggle("disabled", !signedIn);
  if (btnDeleteAccount) btnDeleteAccount.classList.toggle("disabled", !signedIn);

  if (authStatus) authStatus.textContent = note || (signedIn ? "Status: signed in" : "Status: signed out");
  syncGhostUI();
  refreshNavNameLabel();
  // Update chat polling state only if a new chat implementation defines it.
  if (typeof window !== "undefined" && typeof window.syncChatPollingState === "function") {
    window.syncChatPollingState();
  }

  if (signedIn) {
    notePresenceBoost();
    schedulePresencePoll({ immediate: true });
    schedulePickupPoll({ immediate: true });
  } else {
    clearPresencePollTimer();
    clearPickupPollTimer();
    clearPickupOverlay();
  }

  if (openPanelKey === "chat") {
    // If the chat panel is currently open, refresh it using the new chat implementation.
    const html = (typeof window !== "undefined" && typeof window.chatPanelHTML === "function") ? window.chatPanelHTML() : "";
    openDrawer("chat", "Chat", html);
    if (typeof window !== "undefined" && typeof window.wireChatPanel === "function") {
      window.wireChatPanel();
    }
  }

  maybeSyncProgressionLifecycleForAuthState(signedIn);
}

function clearAuth() {
  communityToken = "";
  me = null;
  localStorage.removeItem(LS_TOKEN);
  localStorage.removeItem("community_token");
  syncCommunityIdentityGlobals();
  // Reset chat state if a new chat implementation exists.
  if (typeof window !== "undefined") {
    if (typeof window.chatResetState === "function") window.chatResetState();
    if (typeof window.stopChatPolling === "function") window.stopChatPolling();
  }
  clearOtherDrivers();
  resetPresenceSnapshotOverflowState();
  clearPresencePollTimer();
  clearPickupPollTimer();
  if (presencePullAbortController) {
    presencePullAbortController.abort();
    presencePullAbortController = null;
  }
  presencePullInFlight = false;
  clearPickupOverlayCache();
  clearPickupOverlay();
  if (authPass) authPass.value = "";
  if (authGhost) authGhost.checked = false;
  lastPresencePushMs = 0;
  lastPresenceSentLatLng = null;
  lastPresenceHeadingDegSent = null;
  lastPresenceLargeJumpCandidate = null;
  window.resetMapIdentityLocalState?.();
  showAuthOverlayAndFocus("Status: signed out");
  syncAdminPortalSession();
}

function requireCommunityToken(actionLabel = "perform this action") {
  if (authHeaderOK()) return true;
  setAuthUI(false, `Sign in to ${actionLabel}.`);
  return false;
}

function authSuspensionMessage(errLike) {
  const text = String(errLike?.detail || errLike?.message || errLike || '').trim();
  if (/account\s+suspended/i.test(text)) return "Account suspended. Contact admin.";
  return '';
}

async function loadMe() {
  if (!authHeaderOK()) return null;
  try {
    const data = await getJSONAuth("/me", communityToken);
    me = data || null;
    if (me?.display_name) localStorage.setItem(LS_DISPLAY_NAME, me.display_name);
    syncCommunityIdentityGlobals();
    syncGhostUI();
    refreshNavNameLabel();
    syncAdminPortalSession();
    return me;
  } catch (e) {
    console.warn("/me failed:", e);
    const status = Number(e?.status ?? NaN);
    const suspendedText = authSuspensionMessage(e);
    if (status === 403 && suspendedText) {
      clearAuth();
      setAuthUI(false, suspendedText);
      return null;
    }
    // A 403 can be caused by a backend role-gating regression.
    // Do not force-log users out for that case.
    if (status === 401) {
      clearAuth();
      return null;
    }

    const fallbackDisplayName = (localStorage.getItem(LS_DISPLAY_NAME) || "").trim();
    const fallbackEmail = (localStorage.getItem(LS_EMAIL) || "").trim();
    me = {
      ...(me || {}),
      id: me?.id ?? localStorage.getItem("community_me_id_v1") ?? null,
      display_name: fallbackDisplayName || me?.display_name || fallbackEmail.split("@")[0] || "Driver",
      email: me?.email || fallbackEmail || null,
      is_admin: !!me?.is_admin,
    };
    syncCommunityIdentityGlobals();
    refreshNavNameLabel();
    syncGhostUI();
    syncAdminPortalSession();
    return me;
  }
}

function safeName() {
  return authName && authName.value ? authName.value.trim() : "";
}

async function updateMeProfile(updates) {
  if (!authHeaderOK()) return;
  await postJSON("/me/update", updates, communityToken);
  await loadMe();
  syncCommunityIdentityGlobals();
}

async function applyPostAuthPreferences({ email, forceGhostSync, desiredGhostMode }) {
  if (!authHeaderOK()) return;

  const updates = {};
  const typedName = safeName();
  if (typedName && typedName !== (me?.display_name || "")) {
    updates.display_name = typedName;
  }

  const shouldSyncGhostMode = forceGhostSync || desiredGhostMode != null;
  const desiredGhost = !!desiredGhostMode;
  const currentGhost = !!me?.ghost_mode;
  if (shouldSyncGhostMode && desiredGhost !== currentGhost) {
    updates.ghost_mode = desiredGhost;
  }

  if (Object.keys(updates).length) {
    await updateMeProfile(updates);
  }

  if (typedName) {
    localStorage.setItem(LS_DISPLAY_NAME, typedName);
  } else if (me?.display_name) {
    localStorage.setItem(LS_DISPLAY_NAME, me.display_name);
  } else if (email) {
    localStorage.setItem(LS_DISPLAY_NAME, email.split("@")[0] || "Driver");
  }
}

async function doLogin(email, password, desiredGhostMode) {
  const body = { email, password };
  const data = await postJSON("/auth/login", body, null);
  const token = data?.token || data?.access_token || "";
  if (!token) throw new Error("Login success but token missing.");
  communityToken = token;
  localStorage.setItem(LS_TOKEN, token);
  localStorage.setItem(LS_EMAIL, email);
  await loadMe();
  syncCommunityIdentityGlobals();
  setAuthUI(true, `Status: signed in as ${me?.display_name || me?.email || email}`);
  if (authPass) authPass.value = "";
  try {
    await applyPostAuthPreferences({ email, forceGhostSync: true, desiredGhostMode });
  } catch (e) {
    console.warn("Post-login preference sync failed:", e);
  }
  syncAdminPortalSession();
}

async function doSignup(email, password, desiredGhostMode) {
  const display_name = safeName() || (email || "").split("@")[0] || "Driver";
  const body = { email, password, display_name };
  const data = await postJSON("/auth/signup", body, null);
  const token = data?.token || data?.access_token || "";
  if (!token) throw new Error("Signup success but token missing.");
  communityToken = token;
  localStorage.setItem(LS_TOKEN, token);
  localStorage.setItem(LS_EMAIL, email);
  await loadMe();
  syncCommunityIdentityGlobals();
  setAuthUI(true, `Status: account created • signed in as ${me?.display_name || me?.email || email}`);
  if (authPass) authPass.value = "";
  try {
    await applyPostAuthPreferences({ email, forceGhostSync: true, desiredGhostMode });
  } catch (e) {
    console.warn("Post-signup preference sync failed:", e);
  }
  syncAdminPortalSession();
}

async function changePassword(oldPwd, newPwd) {
  if (!requireCommunityToken("change password")) return;
  try {
    if (accountActions?.changePassword) {
      await accountActions.changePassword(oldPwd, newPwd);
    } else {
      await postJSON(
        "/me/change_password",
        { old_password: oldPwd, new_password: newPwd },
        communityToken
      );
      if (authPass) authPass.value = "";
    }
    alert("Password changed successfully.");
  } catch (err) {
    alert(err?.detail || err?.message || "Error changing password.");
  }
}

function openChangePasswordDialog() {
  if (!requireCommunityToken("change password")) return;

  const oldPwd = prompt("Enter your current password:", "");
  if (oldPwd === null) return;

  const newPwd = prompt("Enter your new password:", "");
  if (newPwd === null) return;

  const oldTrimmed = oldPwd.trim();
  const newTrimmed = newPwd.trim();
  if (!oldTrimmed || !newTrimmed) {
    alert("Both old and new passwords are required.");
    return;
  }
  changePassword(oldTrimmed, newTrimmed);
}

async function deleteAccount() {
  if (!requireCommunityToken("delete account")) return;
  try {
    if (accountActions?.deleteAccount) {
      await accountActions.deleteAccount({ confirmMessage: "Are you sure you want to delete your account? This cannot be undone." });
    } else {
      if (!confirm("Are you sure you want to delete your account? This cannot be undone.")) return;
      await postJSON("/me/delete_account", {}, communityToken);
      clearAuth();
      localStorage.removeItem("community_token");
      location.reload();
    }
  } catch (err) {
    alert(err?.detail || err?.message || "Error deleting account.");
  }
}

function safeEmail() {
  return authEmail && authEmail.value ? authEmail.value.trim() : (localStorage.getItem(LS_EMAIL) || "").trim();
}
function safePass() {
  return authPass && authPass.value ? authPass.value : "";
}

window.getAuthUiDebugState = function getAuthUiDebugState() {
  return {
    tokenPresent: !!communityToken,
    meId: me?.id ?? null,
    signedIn: !!authHeaderOK(),
    authStatusText: authStatus?.textContent || "",
    lockedOverlayVisible: !!(lockedOverlay && lockedOverlay.classList.contains("show") && lockedOverlay.getAttribute("aria-hidden") !== "true"),
  };
};

if (authEmail) authEmail.value = localStorage.getItem(LS_EMAIL) || "";
if (authName) authName.value = localStorage.getItem(LS_DISPLAY_NAME) || "";

if (btnLogin) {
  btnLogin.addEventListener("click", async () => {
    try {
      const email = safeEmail();
      const password = safePass();
      const desiredGhostMode = !!(authGhost && authGhost.checked);
      if (!email || !password) throw new Error("Enter email + password.");
      setAuthUI(false, "Signing in…");
      await doLogin(email, password, desiredGhostMode);
    } catch (e) {
      if (authHeaderOK()) {
        console.warn("Login completed but a non-auth step failed:", e);
        setAuthUI(true, `Status: signed in as ${me?.display_name || me?.email || safeEmail()}`);
        return;
      }
      const suspendedText = authSuspensionMessage(e);
      setAuthUI(false, suspendedText || `Sign in failed: ${e.message || e}`);
    }
  });
}
if (btnSignup) {
  btnSignup.addEventListener("click", async () => {
    try {
      const email = safeEmail();
      const password = safePass();
      const desiredGhostMode = !!(authGhost && authGhost.checked);
      if (!email || !password) throw new Error("Enter email + password.");
      setAuthUI(false, "Creating account…");
      await doSignup(email, password, desiredGhostMode);
    } catch (e) {
      if (authHeaderOK()) {
        console.warn("Signup completed but a non-auth step failed:", e);
        setAuthUI(true, `Status: signed in as ${me?.display_name || me?.email || safeEmail()}`);
        return;
      }
      setAuthUI(false, `Create account failed: ${e.message || e}`);
    }
  });
}

if (btnAuth) {
  btnAuth.addEventListener("pointerdown", (e) => e.stopPropagation());
  btnAuth.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (authHeaderOK()) {
      signOutNow({ reload: false });
      return;
    }
    showAuthOverlayAndFocus("Status: signed out");
  });
}

if (btnGhostMode) {
  btnGhostMode.addEventListener("pointerdown", (e) => e.stopPropagation());
  btnGhostMode.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!authHeaderOK()) {
      setAuthUI(false, "Sign in to toggle Ghost Mode.");
      return;
    }
    try {
      const nextGhost = !Boolean(me?.ghost_mode);
      await updateMeProfile({ ghost_mode: nextGhost });
      setAuthUI(true, `Status: signed in as ${me?.display_name || me?.email || "Driver"}`);
    } catch (err) {
      setAuthUI(true, `Ghost mode update failed: ${err.message || err}`);
    }
  });
}

if (btnChangePassword) {
  btnChangePassword.addEventListener("pointerdown", (e) => e.stopPropagation());
  btnChangePassword.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openChangePasswordDialog();
  });
}

if (btnDeleteAccount) {
  btnDeleteAccount.addEventListener("pointerdown", (e) => e.stopPropagation());
  btnDeleteAccount.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await deleteAccount();
  });
}

function makeDriverIcon(name, headingDeg, avatarUrl = "", mode = "name", orbitMeta = null, leaderboardBadgeCode = '', leaderboardHasCrown = false) {
  const safe = (name || "Driver").trim() || "Driver";
  const rot = Number.isFinite(headingDeg) ? headingDeg : 0;
  const el = document.createElement("div");
  const resolvedAvatarUrl = window.safeMapAvatarUrl?.(avatarUrl || '') || '';
  const driverLabelHTML = (typeof window !== "undefined" && typeof window.mapIdentityRenderDriverLabel === "function")
    ? window.mapIdentityRenderDriverLabel({ name: safe, avatarUrl, mode, zoom: map?.getZoom?.(), orbitMeta, leaderboardBadgeCode, leaderboardHasCrown })
    : `
      <div class="mapPresenceRoot otherDrvIdentitySlot" data-map-presence-placeholder="1">
        <div class="mapPresenceShell">
          ${resolvedAvatarUrl
            ? `<img class="mapPresenceAvatar" src="${escapeHtml(resolvedAvatarUrl)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
            : `<div class="mapPresenceAvatar" aria-hidden="true" style="display:flex;align-items:center;justify-content:center;background:linear-gradient(160deg,#ecf5ff,#dbeafe);color:#6b7280;">
                <svg viewBox="0 0 24 24" width="14" height="14" focusable="false" aria-hidden="true">
                  <circle cx="12" cy="8" r="4" fill="currentColor"></circle>
                  <path d="M4 20c0-3.6 3.6-6 8-6s8 2.4 8 6" fill="currentColor"></path>
                </svg>
              </div>`}
        </div>
        <div class="mapPresenceDirectionRot"><div class="mapPresenceDirectionTip"></div></div>
      </div>`;
  el.className = "otherDrvWrap";
  el.innerHTML = `
    ${driverLabelHTML}
  `;
  setPresenceDirection(el, rot, false);
  return el;
}

function clearOtherDrivers() {
  resetPresenceSnapshotOverflowState();
  for (const m of otherMarkers.values()) {
    try { m.remove(); } catch {}
  }
  otherMarkers.clear();
  driverMarkerVisualSignature.clear();
  presenceStore.clear();
  cachedPresenceRows = [];
  cachedPresenceFingerprint = '';
  renderedPresenceFingerprint = '';
  presenceFocusedUserId = null;
  presenceLastSyncTimestamp = 0;
  presenceLastSyncCursor = 0;
  presenceDeltaMode = 'probe';
  presenceViewportMode = 'probe';
  lastPresenceViewportSignature = '';
  lastPresenceFetchViewportSignature = '';
  const presenceLiteSource = map?.getSource?.('presence-lite');
  if (presenceLiteSource && typeof presenceLiteSource.setData === 'function') {
    presenceLiteSource.setData(emptyGeojson());
  }
  presenceLiteSourceFingerprint = '';
  emitCommunityPresenceCacheUpdated({
    viewportSignature: "",
  });
}

function getCachedAvatarUrl(userId, avatarUrl = "", avatarVersion = "") {
  const normalizedUserId = String(userId || "").trim();
  const normalizedUrl = String(avatarUrl || "").trim();
  const version = String(avatarVersion || "").trim();
  if (!normalizedUserId) return normalizedUrl;
  const cacheKey = `${normalizedUserId}::${version || normalizedUrl}`;
  if (normalizedUrl) {
    if (avatarThumbCache.has(cacheKey)) frontendPerfStats.avatarCacheHits += 1;
    else frontendPerfStats.avatarCacheMisses += 1;
    avatarThumbCache.set(cacheKey, normalizedUrl);
    return avatarThumbCache.get(cacheKey) || normalizedUrl;
  }
  for (const [key, value] of avatarThumbCache.entries()) {
    if (key.startsWith(`${normalizedUserId}::`) && value) {
      frontendPerfStats.avatarCacheHits += 1;
      return value;
    }
  }
  return normalizedUrl;
}

function buildDriverMarkerVisualSignature(userId, avatarUrl = "", orbitMeta = null, leaderboardBadgeCode = '', leaderboardHasCrown = false) {
  const orbitIndex = Number.isFinite(orbitMeta?.index) ? orbitMeta.index : "";
  const orbitCount = Number.isFinite(orbitMeta?.count) ? orbitMeta.count : "";
  const orbitAngle = Number.isFinite(orbitMeta?.angleDeg) ? orbitMeta.angleDeg : "";
  const orbitSide = orbitMeta?.side || "";
  const orbitRing = Number.isFinite(orbitMeta?.ring) ? orbitMeta.ring : "";
  return [
    String(userId ?? ""),
    String(avatarUrl ?? ""),
    "avatar",
    String(leaderboardBadgeCode ?? ""),
    leaderboardHasCrown ? "1" : "0",
    String(orbitIndex),
    String(orbitCount),
    String(orbitAngle),
    String(orbitSide),
    String(orbitRing),
  ].join("|");
}

function upsertDriverMarker(userId, name, lat, lng, heading, avatarUrl = "", mode = "name", orbitMeta = null, leaderboardBadgeCode = '', leaderboardHasCrown = false) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !map) return;
  if (!userId) return;

  const visualSig = buildDriverMarkerVisualSignature(
    userId,
    avatarUrl,
    orbitMeta,
    leaderboardBadgeCode,
    leaderboardHasCrown
  );

  const existing = otherMarkers.get(userId);
  if (existing) {
    existing.setLngLat([lng, lat]);
    const previousVisualSig = driverMarkerVisualSignature.get(userId) || "";
    if (visualSig !== previousVisualSig) {
      const el = existing.getElement();
      const newEl = makeDriverIcon(name || `Driver ${userId}`, heading, avatarUrl, mode, orbitMeta, leaderboardBadgeCode, leaderboardHasCrown);
      el.innerHTML = newEl.innerHTML;
      wireProfileOpenTargets(el, userId, { isSelf: false });
      driverMarkerVisualSignature.set(userId, visualSig);
    } else {
      const rot = Number.isFinite(heading) ? heading : 0;
      setPresenceDirection(existing.getElement(), rot, false);
    }
    return;
  }

  const el = makeDriverIcon(name || `Driver ${userId}`, heading, avatarUrl, mode, orbitMeta, leaderboardBadgeCode, leaderboardHasCrown);
  wireProfileOpenTargets(el, userId, { isSelf: false });
  const mk = new maplibregl.Marker({ element: el, anchor: "center", offset: [0, 0] })
    .setLngLat([lng, lat])
    .addTo(map);

  // Enable subpixel positioning so the marker isn’t snapped to integer pixel
  // boundaries. This reduces apparent drift when zooming or panning at
  // fractional zoom levels.
  if (typeof mk.setSubpixelPositioning === 'function') {
    mk.setSubpixelPositioning(true);
  }

  if (!debugOnce.otherMarker) {
    console.log("DEBUG other marker lngLat", { lng, lat });
    debugOnce.otherMarker = true;
  }

  otherMarkers.set(userId, mk);
  driverMarkerVisualSignature.set(userId, visualSig);
  applyDriverLabelZoomStyles();
}


function getPresenceRenderBounds() {
  if (!map || typeof map.getBounds !== "function") return null;
  const bounds = map.getBounds();
  if (!bounds || typeof bounds.getSouthWest !== "function" || typeof bounds.getNorthEast !== "function") {
    return null;
  }
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  const minLatRaw = Number(sw?.lat);
  const maxLatRaw = Number(ne?.lat);
  const minLngRaw = Number(sw?.lng);
  const maxLngRaw = Number(ne?.lng);
  if (!Number.isFinite(minLatRaw) || !Number.isFinite(maxLatRaw) || !Number.isFinite(minLngRaw) || !Number.isFinite(maxLngRaw)) {
    return null;
  }
  const latSpan = Math.abs(maxLatRaw - minLatRaw);
  const lngSpan = Math.abs(maxLngRaw - minLngRaw);
  const latPad = latSpan * PRESENCE_VIEWPORT_BUFFER_RATIO;
  const lngPad = lngSpan * PRESENCE_VIEWPORT_BUFFER_RATIO;
  const minLat = Math.max(-90, Math.min(minLatRaw, maxLatRaw) - latPad);
  const maxLat = Math.min(90, Math.max(minLatRaw, maxLatRaw) + latPad);
  const minLng = Math.min(minLngRaw, maxLngRaw) - lngPad;
  const maxLng = Math.max(minLngRaw, maxLngRaw) + lngPad;
  return { minLng, minLat, maxLng, maxLat };
}

function rowInPresenceRenderBounds(row, boundsObj) {
  if (!boundsObj) return true;
  const lat = Number(row?.lat);
  const lng = Number(row?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return lat >= boundsObj.minLat && lat <= boundsObj.maxLat && lng >= boundsObj.minLng && lng <= boundsObj.maxLng;
}

function computePresenceRenderMode(rows) {
  const nextRows = Array.isArray(rows) ? rows : [];
  const boundsObj = getPresenceRenderBounds();
  let visibleCount = boundsObj ? nextRows.filter((row) => rowInPresenceRenderBounds(row, boundsObj)).length : nextRows.length;
  const zoom = map?.getZoom?.();
  if (Number.isFinite(zoom) && zoom < 11.5) {
    visibleCount += 8;
  }

  if (presenceRenderMode === 'full') {
    if (visibleCount >= PRESENCE_FULL_TO_MEDIUM_UP) return 'medium';
    return 'full';
  }
  if (presenceRenderMode === 'medium') {
    if (visibleCount <= PRESENCE_MEDIUM_TO_FULL_DOWN) return 'full';
    if (visibleCount >= PRESENCE_MEDIUM_TO_HEAVY_UP) return 'heavy';
    return 'medium';
  }
  if (visibleCount <= PRESENCE_HEAVY_TO_MEDIUM_DOWN) return 'medium';
  return 'heavy';
}

function chooseRichPresenceUserIds(rows, mode) {
  return new Set((Array.isArray(rows) ? rows : []).map((row) => String(row?.uid)));
}
function clusterPresenceByScreenPosition(rows, selfPos) {
  const richRows = Array.isArray(rows) ? rows : [];
  const nodes = [];
  const map = core.getMap?.();
  const meState = core.getMeState?.();

  for (const row of richRows) {
    const lat = Number(row?.lat);
    const lng = Number(row?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const point = map?.project?.([lng, lat]);
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    nodes.push({ kind: 'row', row, id: String(row?.uid ?? ''), x: point.x, y: point.y });
  }

  const selfLat = Number(selfPos?.lat);
  const selfLng = Number(selfPos?.lng);
  if (Number.isFinite(selfLat) && Number.isFinite(selfLng)) {
    const point = map?.project?.([selfLng, selfLat]);
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      const selfId = String(meState?.id ?? '__self__');
      nodes.push({ kind: 'self', id: selfId, x: point.x, y: point.y });
    }
  }

  for (const row of richRows) row.orbitMeta = null;
  core.setLastSelfOrbitMeta?.(null);

  if (!nodes.length) return;

  const thresholdSq = PRESENCE_LABEL_COLLISION_PX * PRESENCE_LABEL_COLLISION_PX;
  const visited = new Set();

  for (let i = 0; i < nodes.length; i += 1) {
    if (visited.has(i)) continue;
    const queue = [i];
    visited.add(i);
    const memberIndexes = [];

    while (queue.length) {
      const idx = queue.shift();
      memberIndexes.push(idx);
      const a = nodes[idx];
      for (let j = 0; j < nodes.length; j += 1) {
        if (visited.has(j)) continue;
        const b = nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        if ((dx * dx) + (dy * dy) <= thresholdSq) {
          visited.add(j);
          queue.push(j);
        }
      }
    }

    const members = memberIndexes.map((idx) => nodes[idx]).sort((a, b) => a.id.localeCompare(b.id));
    const count = members.length;
    if (count <= 1) continue;

    members.forEach((member, slotIndex) => {
      const seqIndex = slotIndex % PRESENCE_SLOT_SEQUENCE.length;
      const seq = PRESENCE_SLOT_SEQUENCE[seqIndex];
      const ring = Math.floor(slotIndex / PRESENCE_SLOT_SEQUENCE.length);
      const meta = {
        index: slotIndex,
        count,
        side: seq.side,
        angleDeg: seq.angleDeg,
        ring,
      };
      if (member.kind === 'row') {
        member.row.orbitMeta = meta;
      } else {
        core.setLastSelfOrbitMeta?.(meta);
      }
    });
  }
}

function ensurePresenceLiteSourceAndLayers() {
  if (!map || !mapReady) return false;
  let createdPresenceLiteArtifacts = false;
  if (!map.getSource('presence-lite')) {
    map.addSource('presence-lite', { type: 'geojson', data: emptyGeojson() });
    createdPresenceLiteArtifacts = true;
  }

  if (!map.getLayer('presence-lite-body')) {
    map.addLayer({
      id: 'presence-lite-body',
      type: 'circle',
      source: 'presence-lite',
      paint: {
        'circle-color': '#1493ff',
        'circle-opacity': 0.88,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3.5, 13, 5, 16, 6.5],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-opacity': 0.9,
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 16, 1.6],
      },
    });
    createdPresenceLiteArtifacts = true;
  }

  if (!map.getLayer('presence-lite-heading')) {
    map.addLayer({
      id: 'presence-lite-heading',
      type: 'symbol',
      source: 'presence-lite',
      layout: {
        'text-field': '▲',
        'text-size': ['interpolate', ['linear'], ['zoom'], 10, 8, 16, 11],
        'text-allow-overlap': true,
        'text-ignore-placement': true,
        'text-rotate': ['coalesce', ['get', 'heading'], 0],
        'text-rotation-alignment': 'map',
        'text-offset': [0, 0],
      },
      paint: {
        'text-color': '#042f4f',
        'text-halo-color': 'rgba(255,255,255,0.8)',
        'text-halo-width': 0.7,
      },
    });
    createdPresenceLiteArtifacts = true;
  }

  if (!map.__presenceLiteHandlersBound) {
    const onLiteClick = (e) => {
      const feature = e?.features?.[0];
      const userId = Number(feature?.properties?.user_id);
      if (!Number.isFinite(userId)) return;
      presenceFocusedUserId = userId;
      window.openDriverProfileModal?.({ userId, isSelf: false, source: 'presence-lite' });
      scheduleAdaptivePresenceRender();
    };
    const onEnter = () => {
      const canvas = map?.getCanvas?.();
      if (canvas) canvas.style.cursor = 'pointer';
    };
    const onLeave = () => {
      const canvas = map?.getCanvas?.();
      if (canvas) canvas.style.cursor = '';
    };

    map.on('click', 'presence-lite-body', onLiteClick);
    map.on('click', 'presence-lite-heading', onLiteClick);
    map.on('mouseenter', 'presence-lite-body', onEnter);
    map.on('mouseenter', 'presence-lite-heading', onEnter);
    map.on('mouseleave', 'presence-lite-body', onLeave);
    map.on('mouseleave', 'presence-lite-heading', onLeave);
    map.__presenceLiteHandlersBound = true;
  }

  return createdPresenceLiteArtifacts;
}

function presenceLiteFingerprint(fc) {
  const features = Array.isArray(fc?.features) ? fc.features : [];
  const rows = features.map((feature) => {
    const userId = String(feature?.properties?.user_id ?? '');
    const coords = Array.isArray(feature?.geometry?.coordinates) ? feature.geometry.coordinates : [];
    const lng = Number(coords[0]);
    const lat = Number(coords[1]);
    const heading = Number(feature?.properties?.heading ?? 0);
    const lngRounded = Number.isFinite(lng) ? lng.toFixed(6) : 'nan';
    const latRounded = Number.isFinite(lat) ? lat.toFixed(6) : 'nan';
    const headingRounded = Number.isFinite(heading) ? Number(heading).toFixed(1) : '0.0';
    return `${userId}|${latRounded}|${lngRounded}|${headingRounded}`;
  });
  rows.sort();
  return rows.join('||');
}

function presenceRowsFingerprint(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => [
      String(row?.uid ?? ""),
      Number(row?.lat ?? NaN).toFixed(6),
      Number(row?.lng ?? NaN).toFixed(6),
      Number(row?.heading ?? 0).toFixed(1),
      String(row?.avatarUrl ?? ""),
      String(row?.leaderboardBadgeCode ?? ""),
      row?.leaderboardHasCrown ? "1" : "0",
    ].join("|"))
    .sort()
    .join("||");
}

function presenceRowsCrowdingFingerprint(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => [
      String(row?.uid ?? ""),
      Number(row?.lat ?? NaN).toFixed(6),
      Number(row?.lng ?? NaN).toFixed(6),
    ].join("|"))
    .sort()
    .join("||");
}

function notePresenceBoost() {
  lastPresenceInteractionBoostUntil = Date.now() + PRESENCE_BOOST_WINDOW_MS;
}

function getPresencePollIntervalMs() {
  if (!authHeaderOK()) return 0;
  if (document.hidden) return PRESENCE_HIDDEN_POLL_MS;
  if (Date.now() < lastPresenceInteractionBoostUntil) return PRESENCE_BOOST_POLL_MS;
  if (autoCenter) return PRESENCE_ACTIVE_POLL_MS;
  return PRESENCE_IDLE_POLL_MS;
}

function clearPresencePollTimer() {
  if (runtimePolling) runtimePolling.clear("app:presence-poll");
  if (presencePollTimer) {
    clearTimeout(presencePollTimer);
    presencePollTimer = null;
  }
}

function schedulePresencePoll({ immediate = false, reason = "scheduled" } = {}) {
  clearPresencePollTimer();
  if (!authHeaderOK()) return;
  if (immediate && reason === 'viewport-change') {
    const nextViewportSignature = getPresenceViewportSignature();
    if (nextViewportSignature && nextViewportSignature === lastPresenceViewportSignature) {
      immediate = false;
    } else if (nextViewportSignature) {
      lastPresenceViewportSignature = nextViewportSignature;
    }
  }
  const delay = immediate ? 0 : getPresencePollIntervalMs();
  if (!delay && delay !== 0) return;
  const runner = () => {
    presencePollTimer = null;
    runPresencePollLoop().catch((e) => console.warn("presence poll loop failed:", e));
  };
  if (runtimePolling) {
    presencePollTimer = runtimePolling.setTimeout("app:presence-poll", runner, Math.max(0, delay));
    return;
  }
  presencePollTimer = setTimeout(runner, Math.max(0, delay));
}

async function runPresencePollLoop() {
  if (!authHeaderOK()) {
    clearPresencePollTimer();
    return;
  }
  if (presencePullLoopRunning) {
    recordDuplicateGuard("presence poll loop already running");
    return;
  }
  presencePullLoopRunning = true;
  try {
    await pullPresenceAll();
  } finally {
    presencePullLoopRunning = false;
    if (authHeaderOK()) schedulePresencePoll();
  }
}

function scheduleAdaptivePresenceRender() {
  if (presenceAdaptiveRenderRaf) return;
  presenceAdaptiveRenderRaf = window.requestAnimationFrame(() => {
    presenceAdaptiveRenderRaf = 0;
    renderAdaptivePresenceFromCache();
  });
}

function renderAdaptivePresenceFromCache() {
  const map = core.getMap?.();
  const mapReady = core.isMapReady?.();
  const userLatLng = core.getUserLatLng?.();

  if (!map || !mapReady) return;

  const presenceLiteArtifactsCreated = !!ensurePresenceLiteSourceAndLayers();

  const rows = Array.isArray(cachedPresenceRows) ? cachedPresenceRows : [];
  const boundsObj = getPresenceRenderBounds();
  const viewportRows = boundsObj ? rows.filter((row) => rowInPresenceRenderBounds(row, boundsObj)) : rows.slice();
  const nextMode = computePresenceRenderMode(rows);
  const nextRenderFingerprint = `${nextMode}::${presenceRowsFingerprint(viewportRows)}`;

  if (!presenceLiteArtifactsCreated && renderedPresenceFingerprint === nextRenderFingerprint) return;

  presenceRenderMode = nextMode;
  const richUserIds = chooseRichPresenceUserIds(viewportRows, nextMode);
  const richRows = [];
  const liteRows = [];

  for (const row of viewportRows) {
    const uid = String(row.uid);
    if (richUserIds.has(uid)) {
      richRows.push(row);
    }
  }

  const selfPos = (userLatLng && Number.isFinite(userLatLng.lat) && Number.isFinite(userLatLng.lng))
    ? { lat: userLatLng.lat, lng: userLatLng.lng }
    : null;

  clusterPresenceByScreenPosition(richRows, selfPos);

  for (const row of richRows) {
    upsertDriverMarker(
      row.uid,
      row.name,
      row.lat,
      row.lng,
      row.heading,
      row.avatarUrl,
      row.mode,
      row.orbitMeta || null,
      row.leaderboardBadgeCode || '',
      !!row.leaderboardHasCrown
    );
  }

  for (const uid of Array.from(otherMarkers.keys())) {
    if (!richUserIds.has(String(uid))) {
      const mk = otherMarkers.get(uid);
      try { mk.remove(); } catch (_) {}
      otherMarkers.delete(uid);
      driverMarkerVisualSignature.delete(uid);
    }
  }

  const liteFc = {
    type: 'FeatureCollection',
    features: liteRows.map((row) => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [row.lng, row.lat],
      },
      properties: {
        user_id: Number(row.uid),
        display_name: row.name || '',
        heading: Number.isFinite(row.heading) ? row.heading : 0,
        updated_at: row.updatedAt ?? null,
        leaderboard_badge_code: row.leaderboardBadgeCode || '',
      },
    })),
  };

  const source = map.getSource('presence-lite');
  if (source && typeof source.setData === 'function') {
    const nextFingerprint = presenceLiteFingerprint(liteFc);
    if (nextFingerprint !== presenceLiteSourceFingerprint) {
      source.setData(liteFc);
      presenceLiteSourceFingerprint = nextFingerprint;
    }
  }

  if (typeof window !== "undefined" && typeof window.mapIdentityApplySelfOrbit === "function") {
    window.mapIdentityApplySelfOrbit(core.getLastSelfOrbitMeta?.() || null);
  }

  core.applyDriverLabelZoomStyles?.();
  renderedPresenceFingerprint = nextRenderFingerprint;
}

async function pullPresenceAll() {
  const startedAt = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  if (!authHeaderOK() || !map) return;
  if (presencePullInFlight && presencePullAbortController) {
    presencePullAbortController.abort();
    frontendPerfStats.abortedRequests += 1;
  }
  presencePullAbortController = new AbortController();
  presencePullInFlight = true;

  try {
    frontendPerfStats.presencePollsAttempted += 1;
    const requestSerial = ++presenceRequestSerial;
    const params = getPresenceRequestParams();
    const viewportSignature = params.get("viewport_sig") || getPresenceViewportSignature();
    const { payload: list, mode: responseMode } = await fetchPresencePayload(params, presencePullAbortController.signal);
    frontendPerfStats.presencePollsCompleted += 1;
    const activeSignal = presencePullAbortController.signal;
    const items = extractPresenceItems(list);
    if (responseMode === 'viewport' || responseMode === 'full') {
      notePresenceSnapshotResponseShape(list, items.length);
    }
    const removals = [];
    if (Array.isArray(list?.removed)) removals.push(...list.removed);
    if (Array.isArray(list?.removed_user_ids)) removals.push(...list.removed_user_ids);
    if (Array.isArray(list?.deleted_user_ids)) removals.push(...list.deleted_user_ids);
    const replaceStore = !!(
      responseMode === 'viewport' ||
      responseMode === 'full' ||
      list?.full_snapshot === true ||
      list?.replace_all === true ||
      (responseMode === 'delta' && list?.mode === 'full')
    );
    const nextRows = mergePresencePayload(items, { replaceStore, removals });

    updatePresenceSyncCursorFromPayload(list);

    if (requestSerial < appliedPresenceRequestSerial) return;
    const nextFingerprint = presenceRowsFingerprint(nextRows);
    const fingerprintChanged = nextFingerprint !== cachedPresenceFingerprint;
    cachedPresenceRows = nextRows;
    cachedPresenceFingerprint = nextFingerprint;
    appliedPresenceRequestSerial = requestSerial;
    lastPresenceFetchViewportSignature = viewportSignature || lastPresenceFetchViewportSignature;
    if (fingerprintChanged) {
      scheduleAdaptivePresenceRender();
      emitCommunityPresenceCacheUpdated({
        viewportSignature: viewportSignature || lastPresenceFetchViewportSignature || "",
      });
    }

    const listOnlineCount = Number(list?.online_count ?? list?.summary?.online_count ?? list?.counts?.online_count);
    const listGhostedCount = Number(list?.ghosted_count ?? list?.summary?.ghosted_count ?? list?.counts?.ghosted_count);
    const hasPayloadCounts = isUsablePresenceCount(listOnlineCount);
    const shouldFetchSummary = !hasPayloadCounts;

    if (hasPayloadCounts) {
      updateOnlineBadge(listOnlineCount, isUsablePresenceCount(listGhostedCount) ? listGhostedCount : 0);
    } else {
      updateOnlineBadge(nextRows.length, 0);
    }

    if (shouldFetchSummary) {
      void getJSONAuth("/presence/summary", communityToken, { signal: activeSignal })
        .then((summary) => {
          const onlineCount = Number(summary?.online_count);
          const ghostedCount = Number(summary?.ghosted_count);
          if (isUsablePresenceCount(onlineCount)) {
            updateOnlineBadge(onlineCount, isUsablePresenceCount(ghostedCount) ? ghostedCount : 0);
          }
        })
        .catch(() => {});
    }
  } catch (e) {
    if (e?.name === "AbortError") return;
    const status = Number(e?.status ?? NaN);
    if (status === 401) {
      clearAuth();
      return;
    }
    console.warn("/presence/all failed:", e);
  } finally {
    const endedAt = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    recordPerfMetric("dbgPresenceTiming", `${Math.max(0, Math.round(endedAt - startedAt))}ms`);
    runtimePerf?.recordDuration?.("presence_fetch", endedAt - startedAt);
    presencePullInFlight = false;
    presencePullAbortController = null;
  }
}

let lastPresencePushMs = 0;
let lastPresenceSentLatLng = null;
let lastPresenceHeadingDegSent = null;
let lastPresenceLargeJumpCandidate = null;
async function communityMaybePushPresence(tsMsOrUnix, heading, accuracy) {
  if (!authHeaderOK()) return;
  if (!userLatLng) return;
  if (Number.isFinite(accuracy) && accuracy > PRESENCE_ACCURACY_THRESHOLD) return;

  const nowMs = Date.now();
  if (lastPresenceSentLatLng) {
    const jumpMi = haversineMiles(lastPresenceSentLatLng, userLatLng);
    if (jumpMi <= MAX_JUMP_MILES) {
      lastPresenceLargeJumpCandidate = null;
    } else {
      const candidate = lastPresenceLargeJumpCandidate;
      if (!candidate) {
        lastPresenceLargeJumpCandidate = { lat: userLatLng.lat, lng: userLatLng.lng, ts: nowMs };
        return;
      }
      const candidateDistanceMi = haversineMiles(candidate, userLatLng);
      const candidateStableMs = nowMs - Number(candidate.ts || 0);
      const stableEnough = candidateDistanceMi <= PRESENCE_REANCHOR_STABLE_RADIUS_MI
        && candidateStableMs >= PRESENCE_REANCHOR_MIN_STABLE_MS;
      if (stableEnough) {
        lastPresenceSentLatLng = null;
        lastPresenceHeadingDegSent = null;
        lastPresenceLargeJumpCandidate = null;
      } else {
        if (candidateDistanceMi > PRESENCE_REANCHOR_STABLE_RADIUS_MI) {
          lastPresenceLargeJumpCandidate = { lat: userLatLng.lat, lng: userLatLng.lng, ts: nowMs };
        }
        return;
      }
    }
  }

  const moveDeltaMi = lastPresenceSentLatLng ? haversineMiles(lastPresenceSentLatLng, userLatLng) : Infinity;
  const headingDelta = Number.isFinite(lastPresenceHeadingDegSent) && Number.isFinite(heading)
    ? Math.abs(shortestAngleDelta(lastPresenceHeadingDegSent, heading))
    : Infinity;
  const recentlyMoved = Number.isFinite(lastMoveTs) && (nowMs - lastMoveTs) < 7000;
  const minIntervalMs = recentlyMoved ? PRESENCE_MOVING_PUSH_MS : PRESENCE_STATIONARY_PUSH_MS;
  if ((moveDeltaMi < PRESENCE_MOVE_THRESHOLD_MI) && (headingDelta < PRESENCE_HEADING_CHANGE_THRESHOLD_DEG) && (nowMs - lastPresencePushMs < minIntervalMs)) return;
  if (nowMs - lastPresencePushMs < minIntervalMs) return;
  lastPresencePushMs = nowMs;

  try {
    const ts_unix = Math.floor((tsMsOrUnix ? Number(tsMsOrUnix) : Date.now()) / 1000);
    await postJSON(
      "/presence/update",
      {
        lat: userLatLng.lat,
        lng: userLatLng.lng,
        heading: typeof heading === "number" && Number.isFinite(heading) ? heading : null,
        accuracy: typeof accuracy === "number" && Number.isFinite(accuracy) ? accuracy : null,
        ts_unix,
      },
      communityToken
    );
    lastPresenceSentLatLng = { lat: userLatLng.lat, lng: userLatLng.lng };
    lastPresenceHeadingDegSent = Number.isFinite(heading) ? normDeg(heading) : lastPresenceHeadingDegSent;
    lastPresenceLargeJumpCandidate = null;
  } catch (e) {
    console.warn("presence/update failed:", e);
  }
}

function nearestZoneToUser(frame, latlng) {
  const feats = frame?.polygons?.features || [];
  if (!feats.length || !latlng) return null;

  let best = null;
  for (const f of feats) {
    const props = f?.properties || {};
    const c = geometryCenter(f.geometry);
    if (!c) continue;
    const d = haversineMiles(latlng, c);
    if (!best || d < best.d) {
      best = {
        d,
        location_id: props.LocationID ?? null,
        zone_name: (props.zone_name || "").trim() || null,
        borough: (props.borough || "").trim() || null,
      };
    }
  }
  return best;
}

window.getPickupRecordingContext = function getPickupRecordingContext() {
  return {
    authHeaderOK,
    setAuthUI,
    clearAuth,
    communityToken,
    userLatLng,
    currentFrame,
    nearestZoneToUser,
    schedulePickupOverlayRefresh,
    schedulePickupPoll,
    clearPickupPollTimer,
    me,
  };
};

async function sendPoliceReport() {
  if (!authHeaderOK()) {
    setAuthUI(false, "Sign in to report police.");
    return;
  }
  if (!userLatLng) {
    alert("Enable location first.");
    return;
  }

  try {
    const ts_unix = Math.floor(Date.now() / 1000);
    await postJSON("/events/police", { lat: userLatLng.lat, lng: userLatLng.lng, ts_unix }, communityToken);
    alert("Police report sent to community ✅");
  } catch (e) {
    alert(`Police report failed: ${e.message || e}`);
  }
}

async function sendPickupLog() {
  if (window.PickupRecordingFeature && typeof window.PickupRecordingFeature.sendPickupLog === "function") {
    return window.PickupRecordingFeature.sendPickupLog();
  }

  if (pickupLogBusy) return;
  if (!authHeaderOK()) {
    setAuthUI(false, "Sign in to record trips.");
    return;
  }
  if (!userLatLng) {
    alert("Enable location first.");
    return;
  }

  pickupLogBusy = true;
  try {
    const ts_unix = Math.floor(Date.now() / 1000);
    const near = nearestZoneToUser(currentFrame, userLatLng);
    const zoneId = near?.location_id ?? null;

    const pickupRes = await postJSON(
      "/events/pickup",
      {
        lat: userLatLng.lat,
        lng: userLatLng.lng,
        ts_unix,
        frame_time: currentFrame?.time || null,
        zone_id: zoneId,
        location_id: zoneId,
        zone_name: near?.zone_name ?? null,
        borough: near?.borough ?? null,
      },
      communityToken
    );

    schedulePickupOverlayRefresh({ force: true });


    if (window && typeof window.handlePickupProgressionDelta === "function") {
      window.handlePickupProgressionDelta(pickupRes || {});
    }
  } catch (e) {
    const status = Number(e?.status ?? NaN);
    if (status === 401) {
      clearAuth();
      return;
    }
    alert(`Trip record failed: ${e.message || e}`);
  } finally {
    pickupLogBusy = false;
  }
}

if (btnPolice) {
  btnPolice.addEventListener("pointerdown", (e) => e.stopPropagation());
  btnPolice.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    sendPoliceReport();
  });
}
if (btnPickup) {
  btnPickup.addEventListener("pointerdown", (e) => e.stopPropagation());
  btnPickup.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    sendPickupLog();
  });
}
if (pickupFab) {
  pickupFab.addEventListener("pointerdown", (e) => e.stopPropagation());
  pickupFab.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    sendPickupLog();
  });
}


async function bootstrapCommunityModule() {
  if (authEmail) authEmail.value = localStorage.getItem(LS_EMAIL) || "";
  if (authName) authName.value = localStorage.getItem(LS_DISPLAY_NAME) || "";

  if (authHeaderOK()) {
    if (authStatus) authStatus.textContent = "Checking session…";
    await loadMe();
    if (authHeaderOK()) {
      setAuthUI(true, `Status: signed in as ${me?.display_name || me?.email || "Driver"}`);
    } else {
      setAuthUI(false, "Status: signed out");
    }
  } else {
    setAuthUI(false, "Status: signed out");
  }

  syncAdminPortalSession();
}


if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (authHeaderOK()) schedulePickupPoll({ immediate: true });
    } else {
      clearPickupPollTimer();
    }
  });
}

window.TlcCommunityModule = {
  ensurePickupSourceAndLayers,
  clearPickupOverlay,
  clearPickupOverlayCache,
  refreshPickupOverlay,
  schedulePickupOverlayRefresh,
  schedulePickupPoll,
  clearPickupPollTimer,
  syncGhostUI,
  closeBlockingUiForSignedOutState,
  showAuthOverlayAndFocus,
  signOutNow,
  setAuthUI,
  clearAuth,
  loadMe,
  updateMeProfile,
  syncAdminPortalSession,
  schedulePresencePoll,
  scheduleAdaptivePresenceRender,
  pullPresenceAll,
  communityMaybePushPresence,
  sendPoliceReport,
  sendPickupLog,
  notePresenceBoost,
  getCachedPresenceRowsSnapshot,
  getPickupRecordingContext: window.getPickupRecordingContext,
  getPickupHotspotZoneIdsSnapshot,
  hasPickupHotspotZone
};

bootstrapCommunityModule();
})();
