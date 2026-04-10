// BOOT_SIGNATURE: railway-frontend-v1
/* =========================================================
   Team Joseo Map (Frontend) - SIMPLE + STABLE (MapLibre)
   ✅ Restored: Staten Island Mode, Manhattan Mode, Ghost Mode,
      Self GPS/nav arrow + auto-center, presence, slider, weather, radio.
   ✅ Added back (OLD behavior): Zone click popup details (like Leaflet bindPopup)
   ✅ Upgraded labels (NEW): Clean professional MapLibre symbol labels
      - always visible (from zoom >= 10)
      - centered & non-overlapping-ish via halo + size scaling
      - computed “inside polygon” label points (no floating outside zones)
   ========================================================= */

/*
 * API base configuration
 *
 * Runtime config should provide API base. This fallback only supports local/dev hosts
 * unless a deployment injects `window.__TLC_DEFAULT_API_BASE__`.
 */
const DEFAULT_API_BASE = (() => {
  if (typeof window === "undefined") return "";
  const configured = String(window.__TLC_DEFAULT_API_BASE__ || "").trim();
  if (configured) return configured.replace(/\/+$/, "");
  const host = String(window.location?.hostname || "").toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".local")) {
    return `${window.location.protocol}//${host === "127.0.0.1" ? "127.0.0.1" : "localhost"}:3000`;
  }
  return String(window.API_BASE || "").trim().replace(/\/+$/, "");
})();
const FrontendRuntime = (typeof window !== "undefined" && window.FrontendRuntime) ? window.FrontendRuntime : null;
function resolveAppApiBase() {
  if (FrontendRuntime?.resolveApiBase) {
    return FrontendRuntime.resolveApiBase();
  }
  const source =
    (typeof window !== "undefined" && window.API_BASE !== undefined)
      ? window.API_BASE
      : ((typeof window !== "undefined" && window.__TLC_RUNTIME_CONFIG__?.apiBase !== undefined)
          ? window.__TLC_RUNTIME_CONFIG__.apiBase
          : DEFAULT_API_BASE);
  return String(source || DEFAULT_API_BASE || "").trim().replace(/\/+$/, "");
}
const RAILWAY_BASE = resolveAppApiBase();
const BIN_MINUTES = 20;
const runtimePolling = FrontendRuntime?.polling || null;
const runtimePerf = FrontendRuntime?.perf || null;

const REFRESH_MS = 5 * 60 * 1000;
const NYC_CLOCK_TICK_MS = 60 * 1000;
const USER_SLIDER_GRACE_MS = 25 * 1000;
window.__TLC_NAV_VECTOR_BASEMAP_CONFIG__ = Object.assign(
  {
    sourceId: "tlc-nav-vector",
  },
  (typeof window !== "undefined" && window.__TLC_NAV_VECTOR_BASEMAP_CONFIG__) || {}
);

let map; // global MapLibre instance
let pendingFrame = null;
let mapReady = false;
let didFitToZonesOnce = false;

const ROTATE_ENABLED = true;
const ROTATE_MIN_MPH = 1.0;
const ROTATE_MIN_DELTA_DEG = 1.5;
const ROTATE_RATE_LIMIT_MS = 120;
const ROTATE_ANIM_MS = 220;
const STARTUP_GPS_PRIORITY_TIMEOUT_MS = 4500;
const STARTUP_INITIAL_USER_ZOOM = 13.0;
const STARTUP_FALLBACK_ZOOM = 12.3;
const ENABLE_BOOT_ZONE_FIT = false;
const GPS_ACCURACY_THRESHOLD = 50;
const PRESENCE_ACCURACY_THRESHOLD = 120;
const HEADING_MIN_SPEED_MPS = 0.8;
const HEADING_DERIVE_MIN_MILES = 0.002;
const HEADING_SMOOTHING = 0.42;
const HEADING_NOISE_DEADBAND_DEG = 1.2;
const HEADING_BIG_TURN_DEG = 12;
const HEADING_COMPASS_STALE_MS = 2500;
const MAX_JUMP_MILES = 2.0;
let lastMapBearingDeg = 0;
let lastRotateTs = 0;
// Track the last time we re-centered the map while auto-center is on.
let lastAutoCenterTs = 0;

const debugOnce = {
  frame: false,
  mapCenter: false,
  selfMarker: false,
  otherMarker: false,
  zonesSetData: false,
};

function dbg(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(text || "");
}

const appBootStartedAt = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
let firstUsableMapRecorded = false;
let startupGpsPriorityResolved = false;
let startupFirstGoodGpsFix = false;
let startupLocationPermissionResolved = false;
let startupLocationTerminalFailure = false;
let startupVisualFallbackApplied = false;
let startupTimelineReady = false;
let startupLoadingForceHidden = false;
let startupViewportReadyEmitted = false;
let startupLocalZoomDone = false;
let startupVisibleViewportFetchReleased = false;
let startupGpsPriorityTimer = null;
let startupInitialFrameIndex = null;
let startupViewportFrameStarted = false;
let startupViewportFrameRendered = false;
let startupFullFrameBackfillStarted = false;
let startupFullFrameBackfillCompleted = false;
let startupFullFrameRetryCount = 0;
let startupFullFrameRetryTimer = null;
let startupCameraLockEventSent = false;
let startupInitialCameraLocked = false;
let startupCameraLockReason = "";
let startupCameraLockedEventEmitted = false;

const LS_TOKEN = "community_token_v1";
const LS_EMAIL = "community_email_v1";
const LS_DISPLAY_NAME = "community_display_name_v1";
const PICKUP_ZONE_SAMPLE_LIMIT = 100;
let pickupZoneStats = new Map();
// NOTE: Chat constants have been moved to app.part2.js.  If you need to override
// them, define `window.CHAT_ROOM` and `window.CHAT_POLL_MS` in your new chat file.
// const CHAT_ROOM = "global";
// const CHAT_POLL_MS = 1200;
// Chat state variables were used by the built‑in chat implementation.  They have
// been migrated to app.part2.js.  Leaving these commented prevents undefined
// variable errors if the old chat logic is removed.
// let chatPollTimer = null;
// let chatLastSeen = null;
// let chatSeenKeys = new Set();
let mapPageIsVisible = !document.hidden;
let lastPresenceInteractionBoostUntil = 0;
let lastRenderedFrameIndex = -1;
let lastRenderedFrameSignature = "";
const timelineCache = { data: null, loadedAt: 0 };
const frameCache = new Map();
const frameCacheOrder = [];
const FRAME_CACHE_MAX = 8;
const processedFrameVisualCache = new Map();
const processedFrameVisualOrder = [];
const PROCESSED_FRAME_VISUAL_CACHE_MAX = 4;
let lastZoneLabelFrameSignature = "";
let lastZoneLabelZoomBucket = "";
let lastZoneLabelVisualSignature = "";
let lastZoneLabelVisibilitySignature = "";
const TIMELINE_CACHE_TTL_MS = 10 * 60 * 1000;
const FRAME_PREFETCH_DISTANCE = 2;
const frontendPerfStats = {
  presencePollsAttempted: 0,
  presencePollsCompleted: 0,
  presencePollsAborted: 0,
  pickupFetchesAttempted: 0,
  pickupFetchesCompleted: 0,
  pickupFetchesAborted: 0,
  chatPolls: { public_open: 0, public_closed: 0, public_hidden: 0, private_open: 0, private_closed: 0, private_hidden: 0 },
  abortedRequests: 0,
  frameCacheHits: 0,
  frameCacheMisses: 0,
  timelineCacheHits: 0,
  timelineCacheMisses: 0,
  avatarCacheHits: 0,
  avatarCacheMisses: 0,
  blankMapWarnings: 0,
  duplicatePollGuards: 0,
};
const avatarThumbCache = new Map();
let timelineLoadAbortController = null;
let frameLoadAbortController = null;
let pendingFrameLoad = null;
let timelineLoadPromise = null;
const frameRequestState = new Map();
window.__mapPerfDebug = window.__mapPerfDebug || frontendPerfStats;
window.__mapPerfDebug.leaderboard = window.__mapPerfDebug.leaderboard || {
  loaded: false,
  opened: false,
  lastError: '',
  lastOpenAt: 0,
  loadAttempts: 0,
};

/* =========================================================
   MOVED TO app.part11.js
   Special Modes + Local Scoring module
   Search there for:
   - getModeFlags
   - toggleModeByKey
   - applyStatenLocalView
   - applyManhattanLocalView
   - effectiveBucket
   - effectiveColor
   ========================================================= */

/* =========================================================
   Legend minimize
   ========================================================= */
const legendEl = document.getElementById("legend");
const legendToggleBtn = document.getElementById("legendToggle");
if (legendEl && legendToggleBtn) {
  legendToggleBtn.addEventListener("click", () => {
    const minimized = legendEl.classList.toggle("minimized");
    legendToggleBtn.textContent = minimized ? "+" : "–";
  });
}

/* =========================================================
   Time helpers
   ========================================================= */
function parseIsoNoTz(iso) {
  const rawInput = String(iso ?? "");
  const trimmed = rawInput.trim();
  const normalizedSeparator = trimmed.replace(/^(\d{4}-\d{2}-\d{2})\s+/, "$1T");
  const withoutTimezone = normalizedSeparator.replace(/(?:Z|[+\-]\d{2}:?\d{2})$/i, "");
  const normalized = withoutTimezone.replace(/\.\d+$/, "");
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) {
    throw new Error(`Failed to parse timestamp "${rawInput}" (normalized="${normalized}")`);
  }
  const [, yStr, moStr, dStr, hStr, miStr, sStr] = match;
  const Y = Number(yStr);
  const M = Number(moStr);
  const D = Number(dStr);
  const h = Number(hStr);
  const m = Number(miStr);
  const s = Number(sStr);
  if (
    !Number.isFinite(Y) || !Number.isFinite(M) || !Number.isFinite(D) ||
    !Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s) ||
    M < 1 || M > 12 || D < 1 || D > 31 || h < 0 || h > 23 || m < 0 || m > 59 || s < 0 || s > 59
  ) {
    throw new Error(`Failed to parse timestamp "${rawInput}" (normalized="${normalized}")`);
  }
  return { Y, M, D, h, m, s };
}
function dowMon0FromIso(iso) {
  const { Y, M, D, h, m, s } = parseIsoNoTz(iso);
  const dt = new Date(Date.UTC(Y, M - 1, D, h, m, s));
  const dowSun0 = dt.getUTCDay();
  return dowSun0 === 0 ? 6 : dowSun0 - 1;
}
function minuteOfWeekFromIso(iso) {
  const { h, m } = parseIsoNoTz(iso);
  const dow_m = dowMon0FromIso(iso);
  return dow_m * 1440 + (h * 60 + m);
}
const NYC_TIMEZONE = "America/New_York";
function getTimeZoneOffsetMs(epochMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(epochMs));
  const mapped = {};
  for (const p of parts) mapped[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(mapped.year),
    Number(mapped.month) - 1,
    Number(mapped.day),
    Number(mapped.hour),
    Number(mapped.minute),
    Number(mapped.second)
  );
  return asUtc - epochMs;
}
function nycLocalToEpochMs({ Y, M, D, h, m, s }) {
  let guess = Date.UTC(Y, M - 1, D, h, m, s || 0);
  for (let i = 0; i < 4; i += 1) {
    const offset = getTimeZoneOffsetMs(guess, NYC_TIMEZONE);
    guess = Date.UTC(Y, M - 1, D, h, m, s || 0) - offset;
  }
  return guess;
}
function timelineIsoToEpochMs(iso) {
  const text = String(iso || "");
  if (!text) return NaN;
  if (/[zZ]|[+\-]\d{2}:?\d{2}$/.test(text)) {
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  try {
    const parts = parseIsoNoTz(text);
    return nycLocalToEpochMs(parts);
  } catch (_) {
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
}
function pickClosestTimelineIndexByEpoch(frameEpochs, targetEpochMs) {
  if (!Array.isArray(frameEpochs) || frameEpochs.length === 0) return 0;
  if (!Number.isFinite(targetEpochMs)) return 0;
  let bestIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < frameEpochs.length; i += 1) {
    const ts = Number(frameEpochs[i]);
    if (!Number.isFinite(ts)) continue;
    const diff = Math.abs(ts - targetEpochMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  return bestIdx;
}
function formatNYCLabel(iso) {
  const epochMs = timelineIsoToEpochMs(iso);
  if (!Number.isFinite(epochMs)) return String(iso || "");
  return new Intl.DateTimeFormat("en-US", {
    timeZone: NYC_TIMEZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(epochMs));
}
function formatNYCTimeOnlyLabel(iso) {
  return formatNYCLabel(iso);
}
function getNYCPartsFromEpochMs(epochMs) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NYC_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(epochMs));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  const hour = Number(map.hour);
  const minute = Number(map.minute);
  const second = Number(map.second);
  const minuteOfDay = hour * 60 + minute;
  const binMinuteOfDay = Math.floor(minuteOfDay / BIN_MINUTES) * BIN_MINUTES;
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    minuteOfDay,
    binMinuteOfDay,
    monthKey: `${month}`,
    monthDayKey: `${month}-${day}`,
    monthDayBinKey: `${month}-${day}|${binMinuteOfDay}`,
  };
}
function buildTimelineCalendarMeta(timeline, timelineEpochMs) {
  return (timeline || []).map((iso, idx) => {
    const epochMs = Number(timelineEpochMs?.[idx]);
    return {
      idx,
      iso,
      epochMs,
      ...getNYCPartsFromEpochMs(epochMs),
    };
  });
}
function getNowNYCFrameTarget() {
  return getNYCPartsFromEpochMs(Date.now());
}
function chooseBestCalendarMatchedTimelineIndex(metaList, target) {
  if (!Array.isArray(metaList) || !metaList.length) return 0;
  const nowEpoch = Date.now();

  const sortWithRules = (items, keyFn) => {
    return [...items].sort((a, b) => {
      const ka = keyFn(a);
      const kb = keyFn(b);
      for (let i = 0; i < Math.max(ka.length, kb.length); i += 1) {
        const av = ka[i];
        const bv = kb[i];
        if (av < bv) return -1;
        if (av > bv) return 1;
      }
      return 0;
    });
  };

  const exactMonthDayBin = metaList.filter((m) => m.monthDayBinKey === target.monthDayBinKey);
  if (exactMonthDayBin.length) {
    return sortWithRules(exactMonthDayBin, (m) => [
      m.year === target.year ? 0 : 1,
      -m.year,
      Math.abs(m.epochMs - nowEpoch),
    ])[0].idx;
  }

  const exactMonthDay = metaList.filter((m) => m.monthDayKey === target.monthDayKey);
  if (exactMonthDay.length) {
    return sortWithRules(exactMonthDay, (m) => [
      Math.abs(m.binMinuteOfDay - target.binMinuteOfDay),
      m.year === target.year ? 0 : 1,
      -m.year,
      Math.abs(m.epochMs - nowEpoch),
    ])[0].idx;
  }

  const sameMonth = metaList.filter((m) => m.month === target.month);
  if (sameMonth.length) {
    return sortWithRules(sameMonth, (m) => [
      Math.abs(m.day - target.day),
      Math.abs(m.binMinuteOfDay - target.binMinuteOfDay),
      m.year === target.year ? 0 : 1,
      -m.year,
      Math.abs(m.epochMs - nowEpoch),
    ])[0].idx;
  }

  return pickClosestTimelineIndexByEpoch(metaList.map((m) => m.epochMs), nowEpoch);
}
function getNowNYCMinuteOfWeekRounded() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const map = {};
  for (const p of parts) map[p.type] = p.value;

  const dowMap = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const dow_m = dowMap[map.weekday] ?? 0;

  const hour = Number(map.hour);
  const minute = Number(map.minute);

  const total = dow_m * 1440 + hour * 60 + minute;
  return Math.floor(total / BIN_MINUTES) * BIN_MINUTES;
}
function addMinutesOfWeek(minuteOfWeek, deltaMinutes) {
  const mod = 7 * 1440;
  let out = (Number(minuteOfWeek) + Number(deltaMinutes)) % mod;
  if (out < 0) out += mod;
  return out;
}
function getNextBinNowNYCMinuteOfWeek() {
  const currentBinStart = getNowNYCMinuteOfWeekRounded();
  return addMinutesOfWeek(currentBinStart, BIN_MINUTES);
}
function cyclicDiff(a, b, mod) {
  const d = Math.abs(a - b);
  return Math.min(d, mod - d);
}
function pickClosestIndex(minutesOfWeekArr, target) {
  let bestIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < minutesOfWeekArr.length; i++) {
    const diff = cyclicDiff(minutesOfWeekArr[i], target, 7 * 1440);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/* =========================================================
   Network helper (+ auth support)
   ========================================================= */
function shouldBypassBrowserCache(url) {
  if (FrontendRuntime?.shouldBypassBrowserCache) return FrontendRuntime.shouldBypassBrowserCache(url);
  const text = String(url || "");
  return /\/presence\/|\/events\/pickups\/recent|\/chat\/|\/auth\/|\/me(\b|\/)/.test(text);
}

async function fetchJSON(url, opts = {}) {
  if (FrontendRuntime?.fetchJSON) return FrontendRuntime.fetchJSON(url, opts);
  const fetchOpts = { mode: "cors", ...opts };
  if (fetchOpts.cache === undefined && shouldBypassBrowserCache(url)) {
    fetchOpts.cache = "no-store";
  }
  const res = await fetch(url, fetchOpts);
  const text = await res.text();
  let parsed = null;
  let hasParsedJson = false;
  if (text) {
    try {
      parsed = JSON.parse(text);
      hasParsedJson = true;
    } catch (_) {}
  }
  if (!res.ok) {
    if (hasParsedJson && isPreparingMonthPayload(parsed)) {
      return parsed;
    }
    const err = new Error(`${res.status} ${res.statusText} @ ${url} :: ${text.slice(0, 120)}`);
    err.status = res.status;
    err.url = url;
    throw err;
  }
  if (hasParsedJson) return parsed;
  throw new Error(`Invalid JSON @ ${url} :: ${text.slice(0, 120)}`);
}
async function postJSON(path, body, token) {
  if (FrontendRuntime?.postJSON) return FrontendRuntime.postJSON(path, body, token);
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetchJSON(`${RAILWAY_BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body || {}),
  });
}
async function getJSONAuth(path, token, opts = {}) {
  if (FrontendRuntime?.getJSONAuth) return FrontendRuntime.getJSONAuth(path, token, opts);
  const headers = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetchJSON(`${RAILWAY_BASE}${path}`, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
}

/* =========================================================
   Buckets (display names)
   ========================================================= */
function prettyBucket(b) {
  const m = {
    green: "Highest",
    purple: "Very High",
    indigo: "High",
    blue: "Medium",
    sky: "Normal",
    orange: "Low",
    yellow: "Below Normal",
    red: "Very Low / Avoid",
  };
  return m[b] || (b ?? "");
}

/* =========================================================
   MOVED TO app.part12.js
   Zone Labels + Zones Source module
   Search there for:
   - ensureZonesSourceAndLayers
   - refreshZoneLabels
   - getFeatureCollectionBounds
   - buildZoneLabelsFeatureCollection
   ========================================================= */

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* =========================================================
   FIX: Accurate polygon centroid (area-weighted)
   ========================================================= */
function ringCentroidArea(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null;

  const pts = ring.slice();
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
    pts.push([first[0], first[1]]);
  }

  let A = 0;
  let Cx = 0;
  let Cy = 0;

  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const cross = x0 * y1 - x1 * y0;
    A += cross;
    Cx += (x0 + x1) * cross;
    Cy += (y0 + y1) * cross;
  }

  if (Math.abs(A) < 1e-12) return null;
  const inv = 1 / (3 * A);
  return { lng: Cx * inv, lat: Cy * inv, area2: A };
}
function polygonCentroid(geom) {
  const rings = geom?.coordinates;
  if (!Array.isArray(rings) || rings.length === 0) return null;

  const outer = ringCentroidArea(rings[0]);
  if (!outer) return null;

  let sumArea2 = outer.area2;
  let sumLng = outer.lng * outer.area2;
  let sumLat = outer.lat * outer.area2;

  for (let i = 1; i < rings.length; i++) {
    const hole = ringCentroidArea(rings[i]);
    if (!hole) continue;
    sumArea2 += hole.area2;
    sumLng += hole.lng * hole.area2;
    sumLat += hole.lat * hole.area2;
  }

  if (Math.abs(sumArea2) < 1e-12) return { lat: outer.lat, lng: outer.lng };
  return { lat: sumLat / sumArea2, lng: sumLng / sumArea2 };
}
function multiPolygonCentroid(geom) {
  const polys = geom?.coordinates;
  if (!Array.isArray(polys) || polys.length === 0) return null;

  let sumArea2 = 0;
  let sumLat = 0;
  let sumLng = 0;

  for (const poly of polys) {
    const c = polygonCentroid({ type: "Polygon", coordinates: poly });
    if (!c) continue;

    const outer = ringCentroidArea(poly?.[0] || []);
    const w = outer ? outer.area2 : 1;

    sumArea2 += w;
    sumLat += c.lat * w;
    sumLng += c.lng * w;
  }

  if (Math.abs(sumArea2) < 1e-12) return null;
  return { lat: sumLat / sumArea2, lng: sumLng / sumArea2 };
}
function geometryCenter(geom) {
  if (!geom) return null;
  if (geom.type === "Polygon") return polygonCentroid(geom);
  if (geom.type === "MultiPolygon") return multiPolygonCentroid(geom);
  return null;
}

/* =========================================================
   Map projection helpers (for collisions, etc.)
   ========================================================= */
function projectToPoint(lng, lat) {
  if (!map) return { x: 0, y: 0 };
  const p = map.project([lng, lat]);
  return { x: p.x, y: p.y };
}
function pointDistance(p1, p2) {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/* =========================================================
   Recommendation + Navigation
   ========================================================= */
const recommendEl = document.getElementById("recommendLine");
const navBtn = document.getElementById("navBtn");

let userLatLng = null;
let routeableNavLatLng = null;

/* =========================================================
   MOVED TO app.part9.js
   Recommendation + Weather + Online badge module
   Search there for:
   - setNavDestination
   - updateRecommendation
   - updateOnlineBadge
   - scheduleWeatherUpdateSoon
   - updateWeatherNow
   ========================================================= */
function setNavDisabled(disabled) { return window.TlcMapUiModule?.setNavDisabled?.(disabled); }
function setNavDestination(dest) { return window.TlcMapUiModule?.setNavDestination?.(dest); }
function hasRecommendedDestination() { return !!window.TlcMapUiModule?.hasRecommendedDestination?.(); }
function updateRecommendation(frame) { return window.TlcMapUiModule?.updateRecommendation?.(frame); }
function getModeFlags() { return window.TlcModeModule?.getModeFlags?.() || { statenIslandMode:false, bronxWashHeightsMode:false, manhattanMode:false, queensMode:false, brooklynMode:false }; }
function toggleModeByKey(key) { return window.TlcModeModule?.toggleModeByKey?.(key); }
function syncStatenIslandUI(...args) { return window.TlcModeModule?.syncStatenIslandUI?.(...args); }
function syncBronxWashHeightsUI(...args) { return window.TlcModeModule?.syncBronxWashHeightsUI?.(...args); }
function syncManhattanUI(...args) { return window.TlcModeModule?.syncManhattanUI?.(...args); }
function syncQueensUI(...args) { return window.TlcModeModule?.syncQueensUI?.(...args); }
function syncBrooklynUI(...args) { return window.TlcModeModule?.syncBrooklynUI?.(...args); }
function applyStatenLocalView(frame) { return window.TlcModeModule?.applyStatenLocalView?.(frame) || frame; }
function applyManhattanLocalView(frame) { return window.TlcModeModule?.applyManhattanLocalView?.(frame) || frame; }
function applyBronxWashHeightsLocalView(frame) { return window.TlcModeModule?.applyBronxWashHeightsLocalView?.(frame) || frame; }
function applyQueensLocalView(frame) { return window.TlcModeModule?.applyQueensLocalView?.(frame) || frame; }
function applyBrooklynLocalView(frame) { return window.TlcModeModule?.applyBrooklynLocalView?.(frame) || frame; }
function effectiveBucket(props, geom) { return window.TlcModeModule?.effectiveBucket?.(props, geom) || (props?.bucket || '').trim(); }
function effectiveColor(props, geom) { return window.TlcModeModule?.effectiveColor?.(props, geom) || (props?.style?.fillColor || props?.style?.color || '#000'); }
function effectiveRating(props, geom) { return window.TlcModeModule?.effectiveRating?.(props, geom) ?? Number(props?.rating ?? NaN); }
function getActiveSpecialModeTagForFeature(props, geom) { return window.TlcModeModule?.getActiveSpecialModeTagForFeature?.(props, geom) || null; }
function getVisibleScoreSourceForFeature(props, geom) { return window.TlcModeModule?.getVisibleScoreSourceForFeature?.(props, geom) || "legacy_citywide"; }
function getVisibleScoreSourceLabel(props, geom) { return window.TlcModeModule?.getVisibleScoreSourceLabel?.(props, geom) || "Team Joseo score"; }
function getCurrentFrameForAssistant() { return currentFrame || null; }

window.TlcMapUiInternals = {
  getRecommendEl: () => recommendEl,
  getNavButton: () => navBtn,
  getUserLatLng: () => userLatLng,
  getRouteableLatLng: () => routeableNavLatLng || userLatLng,
  getSpecialModes: () => getModeFlags(),
  getCurrentFrame: getCurrentFrameForAssistant,
  effectiveBucket,
  effectiveRating,
  getActiveSpecialModeTagForFeature,
  getVisibleScoreSourceForFeature,
  getVisibleScoreSourceLabel,
  resolveZoneFeatureAtLngLat,
  getZoneLocationId,
  geometryCenter,
  haversineMiles,
  fetchJSON,
  formatNYCTimeOnlyLabel,
  setBodyTheme,
  applyNightBasemap
};

function haversineMiles(a, b) {
  const R = 3958.7613;
  const toRad = (x) => (x * Math.PI) / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const h = s1 * s1 + Math.cos(lat1) * Math.cos(lat2) * s2 * s2;

  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/* =========================================================
   Map setup + UI nodes
   ========================================================= */
const slider = document.getElementById("slider");
const timeLabel = document.getElementById("timeLabel");
const debugToggle = document.getElementById("debugToggle");
const debugPanel = document.getElementById("debugPanel");
const dbgReloadFrame = document.getElementById("dbgReloadFrame");
const dockColors = document.getElementById("dockColors");
const dockModes = document.getElementById("dockModes");
const dockChat = document.getElementById("dockChat");
const dockGames = document.getElementById("dockGames");
const dockMusic = document.getElementById("dockMusic");
const dockProfile = document.getElementById("dockProfile");
const dockLeaderboard = document.getElementById("dockLeaderboard");
const dockAdmin = document.getElementById("dockAdmin");

const dockDrawer = document.getElementById("dockDrawer");
const dockDrawerTitle = document.getElementById("dockDrawerTitle");
const dockDrawerBody = document.getElementById("dockDrawerBody");
const dockDrawerClose = document.getElementById("dockDrawerClose");
const dockBackdrop = document.getElementById("dockBackdrop");

const USER_AGENT = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
const IS_TESLA_BROWSER = /\bTesla\//i.test(USER_AGENT);
const DRAWER_AUTO_MINIMIZE_MS = 5000;
const DRAWER_AUTO_MINIMIZE_MS_BY_PANEL = {
  games: 60000,
  chat: 60000,
  leaderboard: 60000,
  colors: 30000,
  profile: 30000,
};

let openPanelKey = null;
let drawerAutoMinimizeTimer = null;

function clearDrawerAutoMinimizeTimer() {
  if (drawerAutoMinimizeTimer) {
    clearTimeout(drawerAutoMinimizeTimer);
    drawerAutoMinimizeTimer = null;
  }
}

function touchDrawerAutoMinimizeTimer() {
  if (!openPanelKey) {
    clearDrawerAutoMinimizeTimer();
    return;
  }
  const autoMinimizeMs = DRAWER_AUTO_MINIMIZE_MS_BY_PANEL[openPanelKey] ?? DRAWER_AUTO_MINIMIZE_MS;
  clearDrawerAutoMinimizeTimer();
  drawerAutoMinimizeTimer = setTimeout(() => {
    if (!openPanelKey) return;
    closeDrawer();
  }, autoMinimizeMs);
}

function bindDrawerAutoMinimizeActivity() {
  if (!dockDrawer) return;
  const events = ["pointerdown", "click", "input", "keydown", "focusin", "touchstart", "wheel"];
  for (const eventName of events) {
    dockDrawer.addEventListener(eventName, () => {
      if (!openPanelKey) return;
      touchDrawerAutoMinimizeTimer();
    }, true);
  }
}

function syncDrawerPanelPosition() {
  if (!dockDrawer) return;
  dockDrawer.classList.remove("panelChat", "panelMusic");
  if (openPanelKey === "chat") dockDrawer.classList.add("panelChat");
  if (openPanelKey === "music") dockDrawer.classList.add("panelMusic");
}

function syncDockActiveButton() {
  [dockColors, dockModes, dockChat, dockGames, dockMusic, dockProfile, dockLeaderboard, dockAdmin].forEach((b) => b && b.classList.remove("dockBtnActive"));
  if (openPanelKey === "colors") dockColors?.classList.add("dockBtnActive");
  if (openPanelKey === "modes") dockModes?.classList.add("dockBtnActive");
  if (openPanelKey === "chat") dockChat?.classList.add("dockBtnActive");
  if (openPanelKey === "games") dockGames?.classList.add("dockBtnActive");
  if (openPanelKey === "music") dockMusic?.classList.add("dockBtnActive");
  if (openPanelKey === "profile") dockProfile?.classList.add("dockBtnActive");
  if (openPanelKey === "leaderboard") dockLeaderboard?.classList.add("dockBtnActive");
  if (openPanelKey === "admin") dockAdmin?.classList.add("dockBtnActive");
}

function openDrawer(key, title, html) {
  openPanelKey = key;
  if (dockDrawerTitle) dockDrawerTitle.textContent = title;
  if (dockDrawerBody) dockDrawerBody.innerHTML = html;
  dockDrawer?.classList.add("open");
  dockBackdrop?.classList.add("open");
  dockDrawer?.setAttribute("aria-hidden", "false");
  dockBackdrop?.setAttribute("aria-hidden", "false");
  syncDrawerPanelPosition();
  syncDockActiveButton();
  // If a chat implementation defines syncChatPollingState on window, call it.
  if (typeof window !== "undefined" && typeof window.syncChatPollingState === "function") {
    window.syncChatPollingState();
  }
  touchDrawerAutoMinimizeTimer();
}

function closeDrawer() {
  clearDrawerAutoMinimizeTimer();
  openPanelKey = null;
  dockDrawer?.classList.remove("open");
  dockBackdrop?.classList.remove("open");
  dockDrawer?.setAttribute("aria-hidden", "true");
  dockBackdrop?.setAttribute("aria-hidden", "true");
  syncDrawerPanelPosition();
  syncDockActiveButton();
  // If a chat implementation defines syncChatPollingState on window, call it.
  if (typeof window !== "undefined" && typeof window.syncChatPollingState === "function") {
    window.syncChatPollingState();
  }
}

function toggleDrawer(key, title, html) {
  if (openPanelKey === key) {
    closeDrawer();
  } else {
    openDrawer(key, title, html);
  }
}

window.openDrawer = openDrawer;
window.closeDrawer = closeDrawer;
window.toggleDrawer = toggleDrawer;
window.bindDockToggle = bindDockToggle;
window.getOpenPanelKey = () => openPanelKey;

function leaderboardPerfDebugState() {
  window.__mapPerfDebug = window.__mapPerfDebug || frontendPerfStats;
  window.__mapPerfDebug.leaderboard = window.__mapPerfDebug.leaderboard || {
    loaded: false,
    opened: false,
    lastError: '',
    lastOpenAt: 0,
    loadAttempts: 0,
  };
  return window.__mapPerfDebug.leaderboard;
}

async function ensureLeaderboardPanelReady() {
  const debugState = leaderboardPerfDebugState();
  if (typeof window.LeaderboardPanel?.open === 'function') {
    debugState.loaded = true;
    debugState.lastError = '';
    return true;
  }
  debugState.loadAttempts = Number(debugState.loadAttempts || 0) + 1;
  try {
    if (typeof window.loadFrontendModuleGroup === 'function') {
      await window.loadFrontendModuleGroup('leaderboard');
    }
  } catch (error) {
    debugState.loaded = false;
    debugState.lastError = String(error?.message || error || 'Failed to load leaderboard modules');
    console.warn('Failed to lazy-load leaderboard modules', error);
    return false;
  }
  if (typeof window.LeaderboardPanel?.open === 'function') {
    debugState.loaded = true;
    debugState.lastError = '';
    return true;
  }
  debugState.loaded = false;
  debugState.lastError = 'LeaderboardPanel.open unavailable after lazy load';
  console.warn('Leaderboard panel failed to initialize after lazy load.');
  return false;
}

window.ensureLeaderboardPanelReady = ensureLeaderboardPanelReady;

dockBackdrop?.addEventListener("click", closeDrawer);
dockDrawerClose?.addEventListener("click", closeDrawer);
dockDrawer?.addEventListener("click", (e) => e.stopPropagation());
bindDrawerAutoMinimizeActivity();

function musicPanelHTML() {
  return `
    <div class="panelBlock">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <button id="dockHot97Btn" class="chipBtn">${hot97Playing ? "⏸" : "▶"} HOT 97.1</button>
        <button id="dockMegaBtn" class="chipBtn">${megaPlaying ? "⏸" : "▶"} La Mega 97.9</button>
        <button id="dockKQBtn" class="chipBtn">${kqPlaying ? "⏸" : "▶"} KQ 94.5</button>
        <button id="dockZ100Btn" class="chipBtn">${z100Playing ? "⏸" : "▶"} Z100</button>
        <div style="margin-left:auto;font-weight:700;opacity:0.75;">${escapeHtml(radioStatusEl?.textContent || "Radio: off")}</div>
      </div>
    </div>
  `;
}

function wireMusicPanel() {
  const a = document.getElementById("dockHot97Btn");
  const b = document.getElementById("dockMegaBtn");
  const c = document.getElementById("dockKQBtn");
  const d = document.getElementById("dockZ100Btn");
  a?.addEventListener("click", async (e) => {
    e.preventDefault();
    await toggleHot97();
    openDrawer("music", "Music", musicPanelHTML());
    wireMusicPanel();
  });
  b?.addEventListener("click", async (e) => {
    e.preventDefault();
    await toggleMega();
    openDrawer("music", "Music", musicPanelHTML());
    wireMusicPanel();
  });
  c?.addEventListener("click", async (e) => {
    e.preventDefault();
    await toggleKQ();
    openDrawer("music", "Music", musicPanelHTML());
    wireMusicPanel();
  });
  d?.addEventListener("click", async (e) => {
    e.preventDefault();
    await toggleZ100();
    openDrawer("music", "Music", musicPanelHTML());
    wireMusicPanel();
  });
}

function modesPanelHTML() {
  const modeFlags = getModeFlags();
  return `
    <div class="panelBlock">
      <div style="font-weight:700;margin-bottom:8px;">${escapeHtml(recommendEl?.textContent || "")}</div>

      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
        <button id="dockAuthBtn" class="chipBtn">${authHeaderOK() ? "Sign out" : "Sign in"}</button>
        <a id="dockNavBtn" class="chipBtn ${hasRecommendedDestination() ? "" : "disabled"}" href="${navBtn?.href || "#"}" target="_blank" rel="noopener">Navigate</a>
      </div>

      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
        <button id="dockStatenBtn" class="chipBtn">${modeFlags.statenIslandMode ? "Staten Island: ON" : "Staten Island: OFF"}</button>
        <button id="dockQueensBtn" class="chipBtn">${modeFlags.queensMode ? "Queens: ON" : "Queens: OFF"}</button>
        <button id="dockBrooklynBtn" class="chipBtn">${modeFlags.brooklynMode ? "Brooklyn: ON" : "Brooklyn: OFF"}</button>
        <button id="dockManhattanBtn" class="chipBtn">${modeFlags.manhattanMode ? "Manhattan: ON" : "Manhattan: OFF"}</button>
        <button id="dockBronxWashHeightsBtn" class="chipBtn">${modeFlags.bronxWashHeightsMode ? "Bronx/Wash Heights: ON" : "Bronx/Wash Heights: OFF"}</button>
        <button id="dockGhostBtn" class="chipBtn">${me?.ghost_mode ? "Ghost: ON" : "Ghost: OFF"}</button>
      </div>

      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <button id="dockPoliceBtn" class="chipBtn"><span aria-hidden="true" style="display:inline-grid;place-items:center;line-height:1;vertical-align:middle;margin-right:6px;"><svg viewBox="0 0 24 24" width="12" height="12" focusable="false" style="display:block"><path d="M12 2.2 4.2 6v6.1c0 4.4 3 8.3 7.8 9.7 4.8-1.4 7.8-5.3 7.8-9.7V6L12 2.2Z" fill="currentColor"/><path d="M12 6.7v5.2" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="15.4" r="1.2" fill="#fff"/></svg></span>Police</button>
        <button id="dockPickupBtn" class="chipBtn"><span aria-hidden="true" style="display:inline-grid;place-items:center;line-height:1;vertical-align:middle;margin-right:6px;"><svg viewBox="0 0 24 24" width="12" height="12" focusable="false" style="display:block"><circle cx="12" cy="12" r="9" fill="currentColor"/><path d="m8 12.4 2.5 2.6 5.5-5.6" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>Save</button>
      </div>

      <div style="margin-top:10px;opacity:0.75;font-weight:600;">
        ${escapeHtml(communityNote?.textContent || "")}
      </div>
    </div>
  `;
}

function wireModesPanel() {
  document.getElementById("dockAuthBtn")?.addEventListener("click", (e) => {
    e.preventDefault();
    if (authHeaderOK()) {
      signOutNow({ reload: true });
      return;
    }
    setAuthUI(false, "Status: signed out");
    openDrawer("modes", "Modes", modesPanelHTML());
    wireModesPanel();
  });

  document.getElementById("dockStatenBtn")?.addEventListener("click", (e) => {
    e.preventDefault();
    toggleModeByKey('statenIsland');
    if (currentFrame) renderFrame(currentFrame);
    openDrawer("modes", "Modes", modesPanelHTML());
    wireModesPanel();
  });

  document.getElementById("dockQueensBtn")?.addEventListener("click", (e) => {
    e.preventDefault();
    toggleModeByKey('queens');
    if (currentFrame) renderFrame(currentFrame);
    openDrawer("modes", "Modes", modesPanelHTML());
    wireModesPanel();
  });

  document.getElementById("dockBrooklynBtn")?.addEventListener("click", (e) => {
    e.preventDefault();
    toggleModeByKey('brooklyn');
    if (currentFrame) renderFrame(currentFrame);
    openDrawer("modes", "Modes", modesPanelHTML());
    wireModesPanel();
  });

  document.getElementById("dockManhattanBtn")?.addEventListener("click", (e) => {
    e.preventDefault();
    toggleModeByKey('manhattan');
    if (currentFrame) renderFrame(currentFrame);
    openDrawer("modes", "Modes", modesPanelHTML());
    wireModesPanel();
  });

  document.getElementById("dockBronxWashHeightsBtn")?.addEventListener("click", (e) => {
    e.preventDefault();
    toggleModeByKey('bronxWashHeights');
    if (currentFrame) renderFrame(currentFrame);
    openDrawer("modes", "Modes", modesPanelHTML());
    wireModesPanel();
  });

  document.getElementById("dockGhostBtn")?.addEventListener("click", (e) => {
    e.preventDefault();
    if (!authHeaderOK()) return;
    const nextGhost = !Boolean(me?.ghost_mode);
    updateMeProfile({ ghost_mode: nextGhost }).then(() => {
      openDrawer("modes", "Modes", modesPanelHTML());
      wireModesPanel();
    });
  });

  document.getElementById("dockPoliceBtn")?.addEventListener("click", (e) => {
    e.preventDefault();
    sendPoliceReport();
  });
  document.getElementById("dockPickupBtn")?.addEventListener("click", (e) => {
    e.preventDefault();
    sendPickupLog();
  });
}


function profilePanelHTML() {
  if (!authHeaderOK()) {
    return `
      <div class="panelBlock">
        <div>Please sign in to manage your account.</div>
      </div>
    `;
  }
  return `
    <div class="panelBlock">
      <div style="font-weight:700;margin-bottom:8px;">Account</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
        <button id="profileChangePwdBtn" class="chipBtn">Change Password</button>
        <button id="profileDeleteAccountBtn" class="chipBtn dangerBtn">Delete Account</button>
        <button id="profileSignOutBtn" class="chipBtn">${authHeaderOK() ? "Sign Out" : "Sign In"}</button>
      </div>
      <div id="profileMapIdentitySection"></div>
    </div>
  `;
}

function wireProfilePanel() {
  if (typeof window !== "undefined" && typeof window.initMapIdentityProfileControls === "function") {
    window.initMapIdentityProfileControls();
  }
  // Change password
  document.getElementById("profileChangePwdBtn")?.addEventListener("click", async (e) => {
    e.preventDefault();
    if (!authHeaderOK()) {
      setAuthUI(false, "Status: signed out");
      closeDrawer();
      return;
    }
    const oldPwd = prompt("Enter your current password:");
    if (oldPwd === null) return;
    const newPwd = prompt("Enter your new password:");
    if (newPwd === null) return;
    try {
      await postJSON("/me/change_password", { old_password: oldPwd, new_password: newPwd }, communityToken);
      alert("Password changed successfully.");
    } catch (err) {
      alert(err?.detail || "Error changing password.");
    }
  });

  // Delete account
  document.getElementById("profileDeleteAccountBtn")?.addEventListener("click", async (e) => {
    e.preventDefault();
    if (!authHeaderOK()) {
      setAuthUI(false, "Status: signed out");
      closeDrawer();
      return;
    }
    if (!confirm("Are you sure you want to delete your account? This cannot be undone.")) return;
    try {
      await postJSON("/me/delete_account", {}, communityToken);
      // Sign out locally after deletion
      clearAuth();
      alert("Account deleted successfully.");
      location.reload();
    } catch (err) {
      alert(err?.detail || "Error deleting account.");
    }
  });

  // Sign out or sign in
  document.getElementById("profileSignOutBtn")?.addEventListener("click", (e) => {
    e.preventDefault();
    if (authHeaderOK()) {
      signOutNow({ reload: true });
      return;
    }
    setAuthUI(false, "Status: signed out");
    closeDrawer();
  });
}

// The built‑in chat panel implementation has been removed from app.js.
// A new chat implementation is provided in app.part2.js.

/* function chatPanelHTML() {} */

/* chatMsgCursor has been removed */

/* chatMsgKey has been removed */

/* formatChatTime has been removed */

/* isChatNearBottom has been removed */

/* setChatStatus has been removed */

/* chatResetState has been removed */

/* renderChatMessages has been removed */

/* chatFetchMessages has been removed */

/* chatLoadInitial has been removed */

/* chatFetchNew has been removed */

/* chatSend has been removed */

/* chatPollOnce has been removed */

/* startChatPolling has been removed */

/* stopChatPolling has been removed */

/* syncChatPollingState has been removed */

/* wireChatPanel has been removed */

function colorsPanelHTML() {
  const modeFlags = getModeFlags();
  const swatch = (fill) => `<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false" style="display:inline-block;vertical-align:middle;flex:0 0 12px;forced-color-adjust:none;-webkit-print-color-adjust:exact;print-color-adjust:exact;"><rect x="0.5" y="0.5" width="11" height="11" rx="3" fill="${fill}" stroke="rgba(0,0,0,0.15)"/></svg>`;
  const rows = `
      <div style="display:flex;align-items:center;gap:8px;">${swatch("#00b050")}Green = 87–100 Highest</div>
      <div style="display:flex;align-items:center;gap:8px;">${swatch("#8000ff")}Purple = 73–86 Very High</div>
      <div style="display:flex;align-items:center;gap:8px;">${swatch("#4b3cff")}Indigo = 60–72 High</div>
      <div style="display:flex;align-items:center;gap:8px;">${swatch("#0066ff")}Blue = 48–59 Medium</div>
      <div style="display:flex;align-items:center;gap:8px;">${swatch("#66ccff")}Sky Blue = 40–47 Normal</div>
      <div style="display:flex;align-items:center;gap:8px;">${swatch("#ffd400")}Yellow = 33–39 Below Normal</div>
      <div style="display:flex;align-items:center;gap:8px;">${swatch("#ff8c00")}Orange = 25–32 Low</div>
      <div style="display:flex;align-items:center;gap:8px;">${swatch("#e60000")}Red = 1–24 Very Low / Avoid</div>
  `;

  return `
    <div class="panelBlock">
      <div style="font-weight:800;margin-bottom:8px;">Team Joseo Score Colors</div>
      ${rows}
      <div style="margin-top:10px;opacity:0.75;font-weight:600;">
        ${(() => {
          const active = [];
          if (modeFlags.queensMode) active.push("Queens Mode");
          if (modeFlags.brooklynMode) active.push("Brooklyn Mode");
          if (modeFlags.statenIslandMode) active.push("Staten Island Mode");
          if (modeFlags.bronxWashHeightsMode) active.push("Bronx/Wash Heights Mode");
          if (modeFlags.manhattanMode) active.push("Manhattan Mode");
          if (!active.length) {
            return "Base colors reflect the Team Joseo citywide score (earnings opportunity), balancing busy-for-size demand density, trip quality, continuation, and trap avoidance. Airport zones are excluded from hotspot logic. Time label is NYC time. Dashed amber/orange outline = Team Joseo community crowding caution (community-only, not TLC/HVFHV truth).";
          }
          const joined = active.length === 1
            ? active[0]
            : active.length === 2
              ? `${active[0]} and ${active[1]}`
              : `${active.slice(0, -1).join(", ")}, and ${active[active.length - 1]}`;
          return `${joined} can override colors only inside its own scope. Other zones still use the Team Joseo citywide score. Dashed amber/orange outline = Team Joseo community crowding caution (community-only, not TLC/HVFHV truth).`;
        })()}
      </div>
    </div>
  `;
}

function bindDockToggle(btn, key, title, htmlFactory, wireFn) {
  if (!btn) return;
  btn.addEventListener("pointerdown", (e) => e.stopPropagation());
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleDrawer(key, title, htmlFactory());
    if (openPanelKey === key && typeof wireFn === "function") wireFn();
  });
}

bindDockToggle(dockMusic, "music", "Music", musicPanelHTML, wireMusicPanel);
bindDockToggle(dockModes, "modes", "Modes", modesPanelHTML, wireModesPanel);
/* FALLBACK BINDER ONLY:
   Owner modules self-export and self-bind first.
   This function exists only to recover from late readiness.
*/
/* DEBUG HELPER:
   Use getTlcOwnerBootState() in console to see whether chat/games owners and dock bindings are actually ready.
*/
window.getTlcOwnerBootState = function getTlcOwnerBootState() {
  return {
    chatOwnerReady: typeof window.isTlcChatOwnerReady === "function" ? window.isTlcChatOwnerReady() : false,
    gamesOwnerReady: typeof window.isTlcGamesOwnerReady === "function" ? window.isTlcGamesOwnerReady() : false,
    chatOwnerBootstrapped:
      typeof window.isTlcChatOwnerBootstrapped === "function"
        ? window.isTlcChatOwnerBootstrapped()
        : false,
    ownerReadyEventsBound:
      !!window.__TLC_OWNER_READY_EVENTS_BOUND__,
    zoneOwnerReady:
      typeof window.isTlcZoneOwnerReady === "function"
        ? window.isTlcZoneOwnerReady()
        : false,
    chatOwnerStatus: typeof window.getTlcChatOwnerStatus === "function" ? window.getTlcChatOwnerStatus() : null,
    gamesOwnerStatus: typeof window.getTlcGamesOwnerStatus === "function" ? window.getTlcGamesOwnerStatus() : null,
    zoneOwnerStatus:
      typeof window.getTlcZoneOwnerStatus === "function"
        ? window.getTlcZoneOwnerStatus()
        : null,
    zoneReadyEventsBound:
      !!window.__TLC_ZONE_READY_EVENTS_BOUND__,
    hasDockChat: !!document.getElementById("dockChat"),
    hasDockGames: !!document.getElementById("dockGames"),
    dockChatBound: !!document.getElementById("dockChat")?.dataset?.tlcBoundChat,
    dockGamesBound: !!document.getElementById("dockGames")?.dataset?.tlcBoundGames,
    openPanelKey: typeof window.getOpenPanelKey === "function" ? window.getOpenPanelKey() : null
  };
};

function ensureDockChatAndGamesBindings() {
  if (typeof bindDockToggle !== "function") return;

  const chatHtmlFactory =
    window.chatPanelHTML ||
    window.TlcChatCoreModule?.chatPanelHTML;

  const chatWireFactory =
    window.wireChatPanel ||
    window.TlcChatCoreModule?.wireChatPanel;

  if (
    dockChat &&
    !dockChat.dataset.tlcBoundChat &&
    typeof chatHtmlFactory === "function" &&
    typeof chatWireFactory === "function"
  ) {
    dockChat.dataset.tlcBoundChat = "1";
    bindDockToggle(
      dockChat,
      "chat",
      "Chat",
      () => chatHtmlFactory(),
      () => chatWireFactory()
    );
  }

  const gamesOwnerReady = typeof window.isTlcGamesOwnerReady === "function"
    ? window.isTlcGamesOwnerReady()
    : !!window.TlcGamesModule;
  const gamesHtmlFactory = gamesOwnerReady ? window.TlcGamesModule?.gamesPanelHTML : null;
  const gamesWireFactory = gamesOwnerReady ? window.TlcGamesModule?.wireGamesPanel : null;

  if (
    dockGames &&
    !dockGames.dataset.tlcBoundGames &&
    typeof gamesHtmlFactory === "function" &&
    typeof gamesWireFactory === "function"
  ) {
    dockGames.dataset.tlcBoundGames = "1";
    bindDockToggle(
      dockGames,
      "games",
      "Games",
      () => gamesHtmlFactory(),
      () => gamesWireFactory()
    );
  }
}

function bindDockOwnersOnReadyEvents() {
  if (window.__TLC_OWNER_READY_EVENTS_BOUND__) return;
  window.__TLC_OWNER_READY_EVENTS_BOUND__ = true;

  window.addEventListener("tlc-chat-owner-ready", () => {
    ensureDockChatAndGamesBindings();
  });

  window.addEventListener("tlc-games-owner-ready", () => {
    ensureDockChatAndGamesBindings();
  });
}

ensureDockChatAndGamesBindings();
bindDockOwnersOnReadyEvents();
bindZoneOwnerReadyEvents();
window.addEventListener("load", ensureDockChatAndGamesBindings);
window.addEventListener("pageshow", ensureDockChatAndGamesBindings);
window.addEventListener("focus", ensureDockChatAndGamesBindings);
setTimeout(ensureDockChatAndGamesBindings, 0);
setTimeout(ensureDockChatAndGamesBindings, 400);
setTimeout(ensureDockChatAndGamesBindings, 1200);

bindDockToggle(dockColors, "colors", "Colors", colorsPanelHTML);
if (dockProfile) {
  dockProfile.addEventListener("pointerdown", (e) => e.stopPropagation());
  dockProfile.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!authHeaderOK()) {
      toggleDrawer("modes", "Modes", modesPanelHTML());
      wireModesPanel();
      return;
    }
    closeDrawer();
    const myId = Number(me?.id);
    if (!Number.isFinite(myId)) return;
    window.openDriverProfileModal?.({ userId: myId, isSelf: true, source: "dock-profile" });
  });
}


if (dockAdmin) {
  dockAdmin.addEventListener("pointerdown", (e) => e.stopPropagation());
  dockAdmin.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeDrawer();
    if (!window.AdminPortal?.open && typeof window.loadFrontendModuleGroup === "function") {
      await window.loadFrontendModuleGroup("admin");
      syncAdminPortalSession();
    }
    window.AdminPortal?.open?.();
  });
}

function enforceSaveButtonTheme() {
  const saveBtn = document.getElementById("pickupFab");
  if (!saveBtn) return;
  saveBtn.classList.add("dockBtn", "dockBtnSave", "dockBtnSaveMain");
  saveBtn.style.removeProperty("background");
  saveBtn.style.removeProperty("color");
  saveBtn.style.removeProperty("filter");
  saveBtn.style.removeProperty("opacity");
  const iconEl = saveBtn.querySelector(".pickupFabIcon");
  if (iconEl && !iconEl.querySelector("svg")) {
    iconEl.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" style="display:block"><path d="m6.5 12.4 3.6 3.6 7.4-7.4" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
}

function applyDockIconModel() {

  const setIcon = (button, svgMarkup) => {
    const iconEl = button?.querySelector?.(".dockIcon");
    if (!iconEl) return;
    iconEl.innerHTML = svgMarkup;
    iconEl.style.fontSize = "0";
    iconEl.style.display = "inline-grid";
    iconEl.style.placeItems = "center";
    iconEl.style.lineHeight = "1";
  };

  setIcon(dockColors, `
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false" style="display:block">
      <circle cx="12" cy="12" r="10" fill="#f2f8ff"/>
      <path d="M12 2a10 10 0 0 1 8.7 5l-5.7 1.1-1.9-4.6Z" fill="#9b5cff"/>
      <path d="M20.7 7a10 10 0 0 1 1.2 6.6l-5.8.8-1.1-6.3Z" fill="#2f7cff"/>
      <path d="M21.9 13.6A10 10 0 0 1 17 20.7l-4.3-3.9 3.2-2.7Z" fill="#ff5d6f"/>
      <path d="M17 20.7A10 10 0 0 1 7 20.5l1.5-5.7 4.2 1.9Z" fill="#ffc928"/>
      <path d="M7 20.5A10 10 0 0 1 2 12.1l5.8-.9 1 3.7Z" fill="#2ecf73"/>
      <circle cx="12" cy="12" r="10" fill="none" stroke="#2c4972" stroke-width="1.1"/>
    </svg>
  `);

  setIcon(dockModes, `
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false" style="display:block">
      <path d="M10.3 2h3.4l.5 2.2a8 8 0 0 1 1.8.8l1.9-1.2 2.4 2.4-1.2 1.9c.3.6.6 1.2.8 1.8L22 10.3v3.4l-2.2.5a8 8 0 0 1-.8 1.8l1.2 1.9-2.4 2.4-1.9-1.2a8 8 0 0 1-1.8.8l-.5 2.2h-3.4l-.5-2.2a8 8 0 0 1-1.8-.8l-1.9 1.2-2.4-2.4 1.2-1.9a8 8 0 0 1-.8-1.8L2 13.7v-3.4l2.2-.5c.2-.6.5-1.2.8-1.8L3.8 6.1l2.4-2.4 1.9 1.2a8 8 0 0 1 1.8-.8L10.3 2Z" fill="#4e78ff"/>
      <circle cx="12" cy="12" r="4.4" fill="#73d2ff"/>
      <circle cx="12" cy="12" r="2.45" fill="#ffffff"/>
      <circle cx="12" cy="12" r="8.25" fill="none" stroke="#2d4f9e" stroke-width="1.1" opacity="0.35"/>
    </svg>
  `);

  setIcon(dockChat, `
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false" style="display:block">
      <path d="M4.8 5.5h14.4a2.8 2.8 0 0 1 2.8 2.8v7.1a2.8 2.8 0 0 1-2.8 2.8H11l-4.2 3.3c-.9.7-2.2 0-2.1-1.2l.3-2.1A2.8 2.8 0 0 1 2 15.4V8.3a2.8 2.8 0 0 1 2.8-2.8Z" fill="#5865f2" stroke="#22337f" stroke-width="1.3" stroke-linejoin="round"/>
      <circle cx="8.3" cy="11.8" r="1.2" fill="#fff"/>
      <circle cx="12" cy="11.8" r="1.2" fill="#fff"/>
      <circle cx="15.7" cy="11.8" r="1.2" fill="#fff"/>
    </svg>
  `);

  setIcon(dockGames, `
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false" style="display:block">
      <path d="M8.2 8.4h7.6c2.1 0 3.9 1.3 4.7 3.2l1 2.4c.9 2.2-.8 4.7-3.2 4.7-1 0-1.9-.4-2.5-1.1l-1.4-1.6h-4.8l-1.4 1.6c-.6.7-1.6 1.1-2.5 1.1-2.4 0-4.1-2.5-3.2-4.7l1-2.4c.8-1.9 2.6-3.2 4.7-3.2Z" fill="#334155" stroke="#0f172a" stroke-width="1.2"/>
      <path d="M8 12.1h3.5M9.75 10.35v3.5" stroke="#e2e8f0" stroke-width="1.4" stroke-linecap="round"/>
      <circle cx="15.7" cy="11.2" r="1" fill="#60a5fa"/>
      <circle cx="17.7" cy="12.8" r="1" fill="#facc15"/>
      <circle cx="15.3" cy="14.4" r="1" fill="#34d399"/>
      <circle cx="13.6" cy="12.8" r="1" fill="#f87171"/>
    </svg>
  `);

  setIcon(dockMusic, `
    <span style="font-size:22px; line-height:1;">🥁</span>
  `);

  setIcon(dockProfile, `
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false" style="display:block">
      <circle cx="12" cy="12" r="10" fill="#eef3ff"/>
      <circle cx="12" cy="8" r="4" fill="#f4c7a1"/>
      <path d="M4 20a8 8 0 0 1 16 0v.2H4Z" fill="#5c6cf0"/>
      <path d="M4 20a8 8 0 0 1 16 0" fill="none" stroke="#3c47b8" stroke-width="1.6" stroke-linecap="round"/>
      <path d="M8.2 7.8c.4-2 2-3.4 3.8-3.4s3.4 1.5 3.8 3.4c-.8-.6-1.6-.9-2.7-.9h-2.2c-1 0-1.9.3-2.7.9Z" fill="#5d4037"/>
    </svg>
  `);

  setIcon(dockLeaderboard, `
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false" style="display:block">
      <path d="M4.2 20h15.6" stroke="#7a5313" stroke-width="1.4" stroke-linecap="round"/>
      <rect x="5.2" y="11.2" width="3.3" height="6" rx="1" fill="#3f8cff"/>
      <rect x="10.35" y="8.4" width="3.3" height="8.8" rx="1" fill="#2ecf73"/>
      <rect x="15.5" y="5.5" width="3.3" height="11.7" rx="1" fill="#ffb300"/>
      <path d="M12 2.5 13.2 5h2.7l-2.2 1.8.8 2.8L12 8.1 9.5 9.6l.8-2.8L8 5h2.7L12 2.5Z" fill="#ffcc2f" stroke="#b57f00" stroke-width="0.8"/>
    </svg>
  `);

  setIcon(dockAdmin, `
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false" style="display:block">
      <path d="M12 2.4 19.3 5v5.5c0 4.9-2.7 8.5-7.3 11.1-4.6-2.6-7.3-6.2-7.3-11.1V5L12 2.4Z" fill="#eaf1ff" stroke="#1e3a8a" stroke-width="1.35" stroke-linejoin="round"/>
      <path d="M8 9h8M8 12h8M8 15h5.2" stroke="#1f2937" stroke-width="1.45" stroke-linecap="round"/>
      <circle cx="16.8" cy="15" r="1.4" fill="#4f46e5" stroke="#312e81" stroke-width="0.7"/>
    </svg>
  `);

  const pickupIconEl = document.querySelector("#pickupFab .pickupFabIcon");
  if (pickupIconEl) {
    pickupIconEl.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" style="display:block"><path d="m6.5 12.4 3.6 3.6 7.4-7.4" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    pickupIconEl.style.fontSize = "0";
    pickupIconEl.style.display = "inline-grid";
    pickupIconEl.style.placeItems = "center";
    pickupIconEl.style.lineHeight = "1";
  }

  enforceSaveButtonTheme();
}

applyDockIconModel();

/* =========================================================
   Precision Slider Popup
   ========================================================= */
const sliderBubble = document.getElementById("sliderBubble");
let bubbleHideTimer = null;

function showSliderBubble() {
  if (!sliderBubble) return;
  sliderBubble.classList.add("show");
  if (bubbleHideTimer) clearTimeout(bubbleHideTimer);
  bubbleHideTimer = setTimeout(() => sliderBubble.classList.remove("show"), 900);
}

function setSliderBubbleTextAndPos() {
  if (!sliderBubble || !slider || !timeline.length) return;

  const idx = Math.max(0, Math.min(timeline.length - 1, Number(slider.value || 0)));
  const iso = timeline[idx];
  const label = iso ? formatNYCLabel(iso) : "…";
  sliderBubble.textContent = label;

  const min = Number(slider.min || 0);
  const max = Number(slider.max || 1);
  const pct = max > min ? (idx - min) / (max - min) : 0;
  const sliderRect = slider.getBoundingClientRect();
  const trackPx = sliderRect.width;

  const x = pct * trackPx;
  const pad = 18;
  const clampedX = Math.max(pad, Math.min(trackPx - pad, x));

  sliderBubble.style.left = `${sliderRect.left + clampedX}px`;
  sliderBubble.style.top = `${sliderRect.top - 38}px`;
}

function bubbleUpdateNow() {
  setSliderBubbleTextAndPos();
  showSliderBubble();
}

const debugEnabled = new URLSearchParams(window.location.search).get("debug") === "1";
if (debugToggle && debugPanel) {
  if (debugEnabled) {
    debugToggle.hidden = false;
  } else {
    debugToggle.hidden = true;
    debugPanel.hidden = true;
  }
  debugToggle.addEventListener("click", () => {
    if (!debugEnabled) return;
    debugPanel.hidden = !debugPanel.hidden;
  });
}
if (dbgReloadFrame) {
  dbgReloadFrame.addEventListener("click", () => {
    const idx = Number(slider?.value || "0");
    loadFrame(idx, { force: true }).catch(console.error);
  });
}

window.TlcZoneLabelInternals = {
  getMap: () => map,
  isMapReady: () => mapReady,
  waitForStyleReady,
  emptyGeojson,
  geometryCenter,
  ensurePickupSourceAndLayers,
  debugEnabled
};

/* =========================================================
   MapLibre init
   ========================================================= */
let zonePopup = null;
let zonePopupAutoCloseTimer = null;
let zonePopupActivityListenersBound = false;
let zonePopupLocationId = "";
let zonePopupLngLat = null;

function startZonePopupAutoCloseTimer() {
  clearTimeout(zonePopupAutoCloseTimer);
  zonePopupAutoCloseTimer = setTimeout(() => {
    closeZonePopup();
  }, 10000);
}

function resetZonePopupAutoCloseTimer() {
  if (zonePopup) {
    clearTimeout(zonePopupAutoCloseTimer);
    zonePopupAutoCloseTimer = setTimeout(() => {
      closeZonePopup();
    }, 10000);
  }
}

function getZonePopupMetrics(zoomValue) {
  const z = Number(zoomValue);
  const zoom = Number.isFinite(z) ? z : 13;
  const t = Math.max(0, Math.min(1, (zoom - 10) / 6));

  return {
    maxWidthPx: Math.round(150 + (t * 58)),
    fontPx: 9.5 + (t * 2.0),
    titlePx: 11.5 + (t * 2.5),
    paddingPx: 6 + (t * 4),
    lineGapPx: 3 + (t * 2),
    borderRadiusPx: 10 + (t * 2),
  };
}

function getZoneLocationId(props = {}) {
  return String(props?.LocationID ?? props?.location_id ?? "").trim() || null;
}

function popupPointInRing(lng, lat, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = Number(ring[i]?.[0]);
    const yi = Number(ring[i]?.[1]);
    const xj = Number(ring[j]?.[0]);
    const yj = Number(ring[j]?.[1]);
    if (!Number.isFinite(xi) || !Number.isFinite(yi) || !Number.isFinite(xj) || !Number.isFinite(yj)) continue;

    const intersect =
      ((yi > lat) !== (yj > lat)) &&
      (lng < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi);

    if (intersect) inside = !inside;
  }
  return inside;
}

function popupPointInPolygonLngLat(lng, lat, polyCoords) {
  if (!Array.isArray(polyCoords) || polyCoords.length === 0) return false;
  const outer = polyCoords[0];
  if (!popupPointInRing(lng, lat, outer)) return false;

  for (let i = 1; i < polyCoords.length; i += 1) {
    if (popupPointInRing(lng, lat, polyCoords[i])) return false;
  }
  return true;
}

function popupFeatureContainsLngLat(feature, lngLat) {
  const geom = feature?.geometry;
  if (!geom || !lngLat) return false;

  const lng = Number(lngLat.lng);
  const lat = Number(lngLat.lat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;

  if (geom.type === "Polygon") {
    return popupPointInPolygonLngLat(lng, lat, geom.coordinates);
  }

  if (geom.type === "MultiPolygon") {
    const polys = Array.isArray(geom.coordinates) ? geom.coordinates : [];
    return polys.some((poly) => popupPointInPolygonLngLat(lng, lat, poly));
  }

  return false;
}

function popupFeatureBBoxArea(feature) {
  const geom = feature?.geometry;
  const coords = geom?.coordinates;
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;

  const visit = (node) => {
    if (!Array.isArray(node)) return;
    if (node.length >= 2 && Number.isFinite(node[0]) && Number.isFinite(node[1])) {
      minLng = Math.min(minLng, Number(node[0]));
      minLat = Math.min(minLat, Number(node[1]));
      maxLng = Math.max(maxLng, Number(node[0]));
      maxLat = Math.max(maxLat, Number(node[1]));
      return;
    }
    node.forEach(visit);
  };

  visit(coords);

  if (!Number.isFinite(minLng) || !Number.isFinite(minLat) || !Number.isFinite(maxLng) || !Number.isFinite(maxLat)) {
    return Infinity;
  }

  return (maxLng - minLng) * (maxLat - minLat);
}

function getCurrentZoneSourceFeatures() {
  return currentFrame?.polygons?.features || [];
}

function resolveZoneFeatureForPopupById(locationId) {
  const targetId = String(locationId || "").trim();
  if (!targetId) return null;
  const features = getCurrentZoneSourceFeatures();
  return features.find((feature) => getZoneLocationId(feature?.properties || {}) === targetId) || null;
}

function queryZoneHitsAroundPoint(point, pad = 12) {
  if (!map || !point) return [];
  const p = Number(pad) || 12;
  const bbox = [
    [point.x - p, point.y - p],
    [point.x + p, point.y + p],
  ];

  return map.queryRenderedFeatures(bbox, {
    layers: ["zones-fill", "zones-line", "zone-labels"],
  }) || [];
}

function findZoneFeatureBySourceContainment(lngLat) {
  const matches = getCurrentZoneSourceFeatures().filter((feature) =>
    popupFeatureContainsLngLat(feature, lngLat)
  );

  if (!matches.length) return null;

  matches.sort((a, b) => {
    const areaA = popupFeatureBBoxArea(a);
    const areaB = popupFeatureBBoxArea(b);
    if (areaA !== areaB) return areaA - areaB;

    const idA = Number(getZoneLocationId(a?.properties || {}));
    const idB = Number(getZoneLocationId(b?.properties || {}));
    if (Number.isFinite(idA) && Number.isFinite(idB)) return idA - idB;

    return 0;
  });

  return matches[0] || null;
}

function resolveZoneFeatureAtLngLat(lngLat) {
  return findZoneFeatureBySourceContainment(lngLat) || null;
}

function pickZoneFeatureForPopup(point, lngLat) {
  const contained = findZoneFeatureBySourceContainment(lngLat);
  if (contained) return contained;

  const hitPads = [8, 14, 22, 32];
  for (const pad of hitPads) {
    const hits = queryZoneHitsAroundPoint(point, pad);

    if (!hits.length) continue;

    const resolvedCandidates = [];
    for (const hit of hits) {
      const hitId = getZoneLocationId(hit?.properties || {});
      if (!hitId) continue;
      const resolved = resolveZoneFeatureForPopupById(hitId);
      if (resolved) resolvedCandidates.push(resolved);
    }

    if (!resolvedCandidates.length) continue;

    resolvedCandidates.sort((a, b) => popupFeatureBBoxArea(a) - popupFeatureBBoxArea(b));
    return resolvedCandidates[0] || null;
  }

  return null;
}

function syncOpenZonePopupMetrics() {
  if (!zonePopup || !zonePopupLocationId || !zonePopupLngLat) return;
  const feature = resolveZoneFeatureForPopupById(zonePopupLocationId);
  if (!feature) return;
  const props = feature.properties || {};
  const geom = feature.geometry || null;
  zonePopup.setHTML(buildPopupHTML(props, geom, getZonePopupMetrics(map?.getZoom?.())));
}

window.getZonePopupDebug = function getZonePopupDebug() {
  return {
    popupOpen: !!zonePopup,
    popupLocationId: zonePopupLocationId || "",
    popupLngLat: zonePopupLngLat || null,
    sourceFeatureCount: Array.isArray(getCurrentZoneSourceFeatures()) ? getCurrentZoneSourceFeatures().length : 0,
  };
};

window.getCurrentZoneShadowDebug = function getCurrentZoneShadowDebug(locationId) {
  return window.TlcScoreShadowModule?.getZoneShadowComparisonByLocationId?.(locationId) || null;
};

function initMap() {
  map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {
        "carto-raster": {
          type: "raster",
          tiles: [
            "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
            "https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
            "https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
          ],
          tileSize: 256,
        },
      },
      layers: [
        {
          id: "carto-base",
          type: "raster",
          source: "carto-raster",
          paint: { "raster-opacity": 1 },
        },
      ],
      glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
      sprite: "",
    },
    center: [-73.98, 40.73],
    zoom: STARTUP_INITIAL_USER_ZOOM,
    attributionControl: { position: "bottom-right" },
    localIdeographFontFamily: "sans-serif",
  });
  map.on("load", () => {
    enforceSaveButtonTheme();
    mapReady = true;
    map.resize();
    applyNightBasemap(!!window.TlcMapUiModule?.getWeatherState?.()?.isNight);
    // Explicit navigation init order:
    // 1) preview service, 2) manual widget owner, 3) turn-by-turn engine.
    window.TlcNavigationPreviewModule?.init?.(map);
    window.TlcManualNavigationModule?.init?.();
    window.TlcNavigationTurnModule?.init?.(map);

    ensureZonesSourceAndLayers().catch((e) => console.warn("zones source/layers init failed:", e));

    if (!debugOnce.mapCenter) {
      const c = map.getCenter();
      console.log("DEBUG map center lngLat", { lng: c.lng, lat: c.lat });
      debugOnce.mapCenter = true;
    }

    // Restore “user exploring disables auto-center” behavior
    map.on("dragstart", disableAutoCenterBecauseUserIsExploring);
    map.on("zoomstart", disableAutoCenterBecauseUserIsExploring);

    // Presence refresh on moves to keep label collision offsets stable
    map.on("moveend", () => {
      if (authHeaderOK()) {
        notePresenceBoost();
        scheduleAdaptivePresenceRender();
        schedulePickupOverlayRefresh();
        schedulePresencePoll({ immediate: true, reason: "viewport-change" });
      }
      applyDriverLabelZoomStyles();
      if (currentFrameIsViewportSubset() || !startupFullFrameBackfillCompleted) {
        void ensureStartupFullFrameBackfill(getCurrentStartupFrameIndex(), "moveend-promote-full-frame");
      }
    });
    map.on("zoom", () => {
      if (authHeaderOK()) scheduleAdaptivePresenceRender();
      applyDriverLabelZoomStyles();
      syncOpenZonePopupMetrics();
    });
    map.on("zoomend", () => {
      if (authHeaderOK()) {
        scheduleAdaptivePresenceRender();
        schedulePickupOverlayRefresh();
        schedulePresencePoll({ immediate: true, reason: "viewport-change" });
      }
      applyDriverLabelZoomStyles();
      syncOpenZonePopupMetrics();
      if (currentFrameIsViewportSubset() || !startupFullFrameBackfillCompleted) {
        void ensureStartupFullFrameBackfill(getCurrentStartupFrameIndex(), "zoomend-promote-full-frame");
      }
    });
    map.on("rotateend", () => {
      if (authHeaderOK()) scheduleAdaptivePresenceRender();
    });
    map.on("rotate", () => {
      if (Number.isFinite(lastHeadingDeg)) setNavRotation(lastHeadingDeg);
    });

    // Zone click popup (restored)
    wireZoneClickPopup();

    document.addEventListener("pointerdown", markUserActivity, { passive: true });
    document.addEventListener("touchstart", markUserActivity, { passive: true });
    document.addEventListener("touchmove", markUserActivity, { passive: true });
    document.addEventListener("wheel", markUserActivity, { passive: true });
    document.addEventListener("keydown", markUserActivity);
    document.addEventListener("click", markUserActivity, { passive: true });

    map.on("dragstart", markUserActivity);
    map.on("drag", markUserActivity);
    map.on("dragend", markUserActivity);
    map.on("zoomstart", markUserActivity);
    map.on("zoom", markUserActivity);
    map.on("zoomend", markUserActivity);
    map.on("rotatestart", markUserActivity);
    map.on("rotate", markUserActivity);
    map.on("rotateend", markUserActivity);
    map.on("pitchstart", markUserActivity);
    map.on("pitch", markUserActivity);
    map.on("pitchend", markUserActivity);
    map.on("movestart", markUserActivity);
    map.on("move", markUserActivity);
    map.on("moveend", markUserActivity);

    scheduleAutoFocusFromInactivity();

    maybeResolveStartupLoading("map-ready");
    recordPerfMetric("dbgBlankMap", "map loaded");

    map.triggerRepaint();
    setTimeout(() => map.triggerRepaint(), 150);
    setTimeout(() => map.triggerRepaint(), 400);
    setTimeout(() => map.triggerRepaint(), 800);

    if (pendingFrame) {
      renderFrame(pendingFrame);
      pendingFrame = null;
    }

    applyDriverLabelZoomStyles();

    if (authHeaderOK()) {
      scheduleAdaptivePresenceRender();
    }
  });

  map.on("style.load", () => {
    map.triggerRepaint();
    if (authHeaderOK()) scheduleAdaptivePresenceRender();
  });
  map.on("error", (e) => console.error("MapLibre error:", e));
}

function preventBrowserZoomUI() {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const isMapEventTarget = (target) => {
    if (!(target instanceof Element)) return false;
    return !!target.closest("#map");
  };

  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const key = String(e.key || "").toLowerCase();
    if (key === "+" || key === "=" || key === "-" || key === "0") {
      e.preventDefault();
    }
  });

  document.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey && !isMapEventTarget(e.target)) {
        e.preventDefault();
      }
    },
    { passive: false }
  );

  ["gesturestart", "gesturechange", "gestureend"].forEach((evt) => {
    document.addEventListener(
      evt,
      (e) => {
        if (!isMapEventTarget(e.target)) {
          e.preventDefault();
        }
      },
      { passive: false }
    );
  });
}

async function waitForStyleReady(timeoutMs = 5000) {
  if (!map) return false;
  if (map.isStyleLoaded()) return true;

  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(tid);
      map.off("styledata", onStyleData);
      map.off("load", onLoad);
      map.off("error", onError);
      resolve(ok);
    };
    const onStyleData = () => {
      if (map?.isStyleLoaded()) done(true);
    };
    const onLoad = () => done(!!map?.isStyleLoaded());
    const onError = () => done(false);

    const tid = setTimeout(() => done(!!map?.isStyleLoaded()), timeoutMs);
    map.on("styledata", onStyleData);
    map.on("load", onLoad);
    map.on("error", onError);
  });
}

async function ensureZonesSourceAndLayers(...args) { return await (window.TlcZoneLabelModule?.ensureZonesSourceAndLayers?.(...args) || Promise.resolve(false)); }
function refreshZoneLabels(...args) { return window.TlcZoneLabelModule?.refreshZoneLabels?.(...args); }
function getFeatureCollectionBounds(...args) { return window.TlcZoneLabelModule?.getFeatureCollectionBounds?.(...args) || null; }

function bindZoneOwnerReadyEvents() {
  if (window.__TLC_ZONE_READY_EVENTS_BOUND__) return;
  window.__TLC_ZONE_READY_EVENTS_BOUND__ = true;

  window.addEventListener("tlc-zone-owner-ready", async () => {
    try {
      if (!map || !mapReady) return;
      const ready = await ensureZonesSourceAndLayers();
      if (!ready) return;

      const frameToRender = currentFrame || pendingFrame || null;
      if (frameToRender) {
        pendingFrame = null;
        await renderFrame(frameToRender);
      }
    } catch (error) {
      console.warn("Zone owner ready recovery failed:", error);
    }
  });
}

function emptyGeojson() {
  return { type: "FeatureCollection", features: [] };
}

/* =========================================================
   MOVED TO app.part10.js
   Community pickup overlay + presence fetch module
   Search there for:
   - ensurePickupSourceAndLayers
   - schedulePickupOverlayRefresh
   - refreshPickupOverlay
   - schedulePresencePoll
   - pullPresenceAll
   ========================================================= */
async function ensurePickupSourceAndLayers(...args) { return await (window.TlcCommunityModule?.ensurePickupSourceAndLayers?.(...args) || Promise.resolve(false)); }
function clearPickupOverlay(...args) { return window.TlcCommunityModule?.clearPickupOverlay?.(...args); }
function clearPickupOverlayCache(...args) { return window.TlcCommunityModule?.clearPickupOverlayCache?.(...args); }
async function refreshPickupOverlay(...args) { return await (window.TlcCommunityModule?.refreshPickupOverlay?.(...args) || Promise.resolve()); }
function schedulePickupOverlayRefresh(...args) { return window.TlcCommunityModule?.schedulePickupOverlayRefresh?.(...args); }
function schedulePickupPoll(...args) { return window.TlcCommunityModule?.schedulePickupPoll?.(...args); }
function clearPickupPollTimer(...args) { return window.TlcCommunityModule?.clearPickupPollTimer?.(...args); }
function schedulePresencePoll(...args) { return window.TlcCommunityModule?.schedulePresencePoll?.(...args); }
function scheduleAdaptivePresenceRender(...args) { return window.TlcCommunityModule?.scheduleAdaptivePresenceRender?.(...args); }
async function pullPresenceAll(...args) { return await (window.TlcCommunityModule?.pullPresenceAll?.(...args) || Promise.resolve()); }
async function communityMaybePushPresence(...args) { return await (window.TlcCommunityModule?.communityMaybePushPresence?.(...args) || Promise.resolve()); }
function notePresenceBoost(...args) { return window.TlcCommunityModule?.notePresenceBoost?.(...args); }

/* =========================================================
   Zone click popup (restored like Leaflet bindPopup)
   ========================================================= */
function closeZonePopup() {
  try {
    if (zonePopup) zonePopup.remove();
  } catch {}
  zonePopup = null;
  zonePopupLocationId = "";
  zonePopupLngLat = null;
  clearTimeout(zonePopupAutoCloseTimer);
  zonePopupAutoCloseTimer = null;
}

function closeMapTapPanels() {
  try { closeDrawer?.(); } catch (_) {}
  try { window.closeDriverProfileModal?.(); } catch (_) {}
  try { window.AdminPortal?.close?.(); } catch (_) {}
}

function wireZoneClickPopup() {
  if (!map) return;

  map.on("mouseenter", "zones-fill", () => {
    try { map.getCanvas().style.cursor = "pointer"; } catch (_) {}
  });

  map.on("mouseleave", "zones-fill", () => {
    try { map.getCanvas().style.cursor = ""; } catch (_) {}
  });

  function openZonePopupFromResolvedFeature(feature, lngLat) {
    if (!feature || !lngLat) {
      closeZonePopup();
      return false;
    }

    const props = feature.properties || {};
    const geom = feature.geometry || null;
    window.__TEAM_JOSEO_LAST_CLICKED_FEATURE_SCORE_DEBUG__ =
      window.TlcModeModule?.getFeatureVisibleScoreDebug?.(props, geom) || null;

    closeZonePopup();

    zonePopupLocationId = getZoneLocationId(props);
    zonePopupLngLat = { lng: lngLat.lng, lat: lngLat.lat };

    zonePopup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: false,
      maxWidth: "208px",
    })
      .setLngLat([lngLat.lng, lngLat.lat])
      .setHTML(buildPopupHTML(props, geom))
      .addTo(map);

    startZonePopupAutoCloseTimer();
    return true;
  }

  if (!map.__zonePopupClickBound) {
    map.__zonePopupClickBound = true;
    map.on("click", (e) => {
      const zoneFeature = pickZoneFeatureForPopup(e.point, e.lngLat);

      if (!zoneFeature) {
        closeZonePopup();
        closeMapTapPanels();
        return;
      }

      openZonePopupFromResolvedFeature(zoneFeature, e.lngLat);
    });
  }

  if (!zonePopupActivityListenersBound) {
    document.addEventListener("pointerdown", (event) => {
      const target = event.target;
      const insidePopup = target && typeof target.closest === "function" && target.closest(".maplibregl-popup");
      if (!insidePopup) {
        closeZonePopup();
      } else {
        resetZonePopupAutoCloseTimer();
      }
    }, true);

    document.addEventListener("touchstart", (event) => {
      const target = event.target;
      const insidePopup = target && typeof target.closest === "function" && target.closest(".maplibregl-popup");
      if (!insidePopup) {
        closeZonePopup();
      } else {
        resetZonePopupAutoCloseTimer();
      }
    }, true);

    zonePopupActivityListenersBound = true;
  }
}


/* =========================================================
   Timeline / frames
   ========================================================= */
let timeline = [];
let timelineEpochMs = [];
let timelineCalendarMeta = [];
let timelineActiveMonthKey = "";
let timelineAvailableMonthKeys = [];
let timelineScope = "";
let timelinePreparingState = null;
let timelinePrepareRetryTimer = null;
let framePrepareRetryTimer = null;
let framePrepareRetryIdx = null;
const TIMELINE_PREPARE_DEFAULT_RETRY_MS = 3000;
let currentFrame = null;
let lastUserSliderTs = 0;

/* NEXT BIN CACHE */
let nextFramePickupsById = new Map();
let nextFramePayById = new Map();

window.TlcModeInternals = {
  getCurrentFrame: () => currentFrame,
  getUserLatLng: () => userLatLng,
  getNextFramePickupsById: () => nextFramePickupsById,
  getNextFramePayById: () => nextFramePayById,
  getMap: () => map,
  geometryCenter,
  haversineMiles,
  renderCurrentFrame: () => { if (currentFrame) renderFrame(currentFrame); },
  prettyBucket
};

function trackFrameCacheOrder(idx) {
  const existing = frameCacheOrder.indexOf(idx);
  if (existing >= 0) frameCacheOrder.splice(existing, 1);
  frameCacheOrder.push(idx);
  while (frameCacheOrder.length > FRAME_CACHE_MAX) {
    const evictIdx = frameCacheOrder.shift();
    frameCache.delete(evictIdx);
  }
}

function rememberFrame(idx, frame) {
  frameCache.set(idx, frame);
  trackFrameCacheOrder(idx);
  return frame;
}

function clearFrameRequest(idx) {
  const key = Number(idx);
  const state = frameRequestState.get(key);
  if (state?.controller) {
    try { state.controller.abort(); } catch (_) {}
  }
  frameRequestState.delete(key);
}

async function fetchFrameData(idx, { priority = "active", force = false } = {}) {
  const normalizedIdx = Number(idx);
  if (!Number.isInteger(normalizedIdx) || normalizedIdx < 0) throw new Error(`Invalid frame index: ${idx}`);
  if (!force && frameCache.has(normalizedIdx)) return getCachedFrame(normalizedIdx);
  const existing = frameRequestState.get(normalizedIdx);
  if (existing?.promise) return existing.promise;
  if (priority === "active" && frameLoadAbortController) {
    try { frameLoadAbortController.abort(); } catch (_) {}
  }
  const controller = new AbortController();
  const state = { controller, priority, promise: null };
  if (priority === "active") frameLoadAbortController = controller;
  frontendPerfStats.frameCacheMisses += 1;
  state.promise = fetchJSON(`${RAILWAY_BASE}${buildFramePathWithMonthKey(normalizedIdx)}`, { signal: controller.signal, cache: force ? "reload" : undefined })
    .then((frame) => {
      if (isPreparingMonthPayload(frame)) return frame;
      return rememberFrame(normalizedIdx, frame);
    })
    .finally(() => {
      const latest = frameRequestState.get(normalizedIdx);
      if (latest?.controller === controller) frameRequestState.delete(normalizedIdx);
      if (frameLoadAbortController === controller) frameLoadAbortController = null;
    });
  frameRequestState.set(normalizedIdx, state);
  return state.promise;
}

function buildFramePathWithMonthKey(idx) {
  const normalizedIdx = Number(idx);
  if (!Number.isInteger(normalizedIdx) || normalizedIdx < 0) return "/frame/0";
  if (!timelineActiveMonthKey) return `/frame/${normalizedIdx}`;
  const params = new URLSearchParams({ month_key: String(timelineActiveMonthKey) });
  return `/frame/${normalizedIdx}?${params.toString()}`;
}

function buildViewportFramePathWithMonthKey(idx, paddingRatio = 0.18) {
  const normalizedIdx = Number(idx);
  if (!Number.isInteger(normalizedIdx) || normalizedIdx < 0 || !map || typeof map.getBounds !== "function") return null;
  const bounds = map.getBounds?.();
  if (!bounds || typeof bounds.getSouth !== "function" || typeof bounds.getWest !== "function" || typeof bounds.getNorth !== "function" || typeof bounds.getEast !== "function") {
    return null;
  }
  const minLat = Number(bounds.getSouth());
  const minLng = Number(bounds.getWest());
  const maxLat = Number(bounds.getNorth());
  const maxLng = Number(bounds.getEast());
  if (![minLat, minLng, maxLat, maxLng].every(Number.isFinite)) return null;
  const params = new URLSearchParams({
    min_lat: String(minLat),
    min_lng: String(minLng),
    max_lat: String(maxLat),
    max_lng: String(maxLng),
    padding_ratio: String(Number.isFinite(Number(paddingRatio)) ? Number(paddingRatio) : 0.18),
  });
  if (timelineActiveMonthKey) params.set("month_key", String(timelineActiveMonthKey));
  return `/frame/${normalizedIdx}/viewport?${params.toString()}`;
}

async function fetchViewportFrameData(idx, { force = false } = {}) {
  const path = buildViewportFramePathWithMonthKey(idx);
  if (!path) return null;
  try {
    const payload = await fetchJSON(`${RAILWAY_BASE}${path}`, { cache: force ? "reload" : undefined });
    if (isPreparingMonthPayload(payload)) {
      applyTimelinePreparingUi(payload);
      const retryMs = Number(payload?.retry_after_sec) > 0
        ? Number(payload.retry_after_sec) * 1000
        : TIMELINE_PREPARE_DEFAULT_RETRY_MS;
      scheduleFramePrepareRetry(idx, retryMs);
      return currentFrame || payload;
    }
    return payload;
  } catch (_) {
    return null;
  }
}

function currentFrameIsViewportSubset() {
  return !!(currentFrame && currentFrame._viewport_subset === true);
}

function getCurrentStartupFrameIndex() {
  const sliderIdx = Number(slider?.value);
  if (Number.isInteger(sliderIdx) && sliderIdx >= 0) return sliderIdx;
  if (Number.isInteger(startupInitialFrameIndex) && startupInitialFrameIndex >= 0) return startupInitialFrameIndex;
  return 0;
}

function clearStartupFullFrameRetryTimer() {
  if (startupFullFrameRetryTimer) clearTimeout(startupFullFrameRetryTimer);
  startupFullFrameRetryTimer = null;
}

function scheduleStartupFullFrameRetry(idx, delayMs, reason = "") {
  clearStartupFullFrameRetryTimer();
  const normalizedIdx = Math.max(0, Number(idx) || 0);
  const timeoutMs = Math.max(0, Number(delayMs) || 0);
  startupFullFrameRetryTimer = setTimeout(() => {
    startupFullFrameRetryTimer = null;
    if (startupFullFrameBackfillCompleted) return;
    if (!currentFrameIsViewportSubset()) return;
    if (pendingFrameLoad?.idx === normalizedIdx) return;
    if (frameRequestState.get(normalizedIdx)?.promise) return;
    startupFullFrameRetryCount += 1;
    void ensureStartupFullFrameBackfill(normalizedIdx, reason || "retry");
  }, timeoutMs);
}

async function ensureStartupFullFrameBackfill(idx, reason = "") {
  const normalizedIdx = Math.max(0, Number(idx) || 0);
  if (!Number.isInteger(normalizedIdx) || normalizedIdx < 0) return null;
  if (startupFullFrameBackfillCompleted) return null;
  if (pendingFrameLoad?.idx === normalizedIdx) return pendingFrameLoad.promise || null;
  if (frameRequestState.get(normalizedIdx)?.promise) return frameRequestState.get(normalizedIdx)?.promise || null;
  startupFullFrameBackfillStarted = true;
  if (debugEnabled && reason) dbg("dbgFrame", `startup full-frame backfill (${reason})`);
  try {
    const frame = await loadFrame(normalizedIdx);
    if (frame && frame._viewport_subset !== true && currentFrame?._viewport_subset !== true) {
      startupFullFrameBackfillCompleted = true;
      clearStartupFullFrameRetryTimer();
    }
    return frame;
  } catch (_) {
    return null;
  }
}

function getCachedFrame(idx) {
  if (!frameCache.has(idx)) return null;
  const frame = frameCache.get(idx);
  trackFrameCacheOrder(idx);
  frontendPerfStats.frameCacheHits += 1;
  return frame;
}

function frameSignature(frame) {
  const featureCount = Number(frame?.polygons?.features?.length ?? 0);
  return `${String(frame?.time ?? "")}|${featureCount}`;
}

function getRenderVisualSignature(modeFlags) {
  const flags = modeFlags || getModeFlags();
  const tendency = window.TlcDayTendencyState?.getAdvancedContext?.() || window.TlcDayTendencyState?.advancedContext || null;
  const tendencySig = tendency
    ? [
        tendency.ready_for_frontend_adjustment ? 1 : 0,
        tendency.global_penalty_points ?? "",
        tendency.local_penalty_points ?? "",
        tendency.total_penalty_cap ?? "",
        tendency.bucket_drop_cap ?? "",
        tendency.resolved_local_scope || tendency.local_scope || tendency.scope || "",
      ].join(":")
    : "none";
  return [
    flags.statenIslandMode ? 1 : 0,
    flags.bronxWashHeightsMode ? 1 : 0,
    flags.manhattanMode ? 1 : 0,
    flags.queensMode ? 1 : 0,
    flags.brooklynMode ? 1 : 0,
    tendencySig,
  ].join("|");
}

function trackProcessedFrameVisualOrder(key) {
  const existing = processedFrameVisualOrder.indexOf(key);
  if (existing >= 0) processedFrameVisualOrder.splice(existing, 1);
  processedFrameVisualOrder.push(key);
  while (processedFrameVisualOrder.length > PROCESSED_FRAME_VISUAL_CACHE_MAX) {
    const evict = processedFrameVisualOrder.shift();
    processedFrameVisualCache.delete(evict);
  }
}

function getProcessedFrameVisualFromCache(key) {
  if (!processedFrameVisualCache.has(key)) return null;
  const cached = processedFrameVisualCache.get(key);
  trackProcessedFrameVisualOrder(key);
  return cached || null;
}

function rememberProcessedFrameVisual(key, fc) {
  processedFrameVisualCache.set(key, fc);
  trackProcessedFrameVisualOrder(key);
  return fc;
}

function getZoneLabelZoomBucket() {
  if (!map || typeof map.getZoom !== "function") return "none";
  const zoom = Number(map.getZoom());
  if (!Number.isFinite(zoom)) return "none";
  return String(Math.floor(zoom * 2) / 2);
}

function getZoneLabelVisibilitySignature() {
  if (!map || typeof map.getLayoutProperty !== "function") return "none";
  const ids = ["zones-labels", "zones-fill", "zones-line"];
  return ids.map((id) => `${id}:${String(map.getLayoutProperty(id, "visibility") || "visible")}`).join("|");
}

function prefetchFrame(idx) {
  const normalizedIdx = Number(idx);
  if (!Number.isInteger(normalizedIdx) || normalizedIdx < 0 || normalizedIdx >= timeline.length) return;
  if (frameCache.has(normalizedIdx) || frameRequestState.has(normalizedIdx)) return;
  fetchFrameData(normalizedIdx, { priority: "prefetch" }).catch((e) => {
    if (e?.name === "AbortError") return;
    console.warn(`Frame prefetch failed (${normalizedIdx}):`, e);
  });
}

async function loadNextFramePickupsMap(curIdx) {
  try {
    if (!timeline.length) return;

    const nextIdx = Math.min(timeline.length - 1, Number(curIdx) + 1);
    if (nextIdx === Number(curIdx)) {
      nextFramePickupsById = new Map();
      nextFramePayById = new Map();
      return;
    }

    const frame = getCachedFrame(nextIdx) || await fetchFrameData(nextIdx, { priority: "prefetch" });
    const feats = frame?.polygons?.features || [];

    const puMap = new Map();
    const payMap = new Map();

    for (const f of feats) {
      const props = f?.properties || {};
      const id = props.LocationID;
      if (id == null) continue;

      const pu = Number(props.pickups ?? NaN);
      if (Number.isFinite(pu)) puMap.set(String(id), pu);

      const pay = Number(props.avg_driver_pay ?? NaN);
      if (Number.isFinite(pay)) payMap.set(String(id), pay);
    }

    nextFramePickupsById = puMap;
    nextFramePayById = payMap;
  } catch (e) {
    console.warn("Next-bin pickups preload failed:", e);
    nextFramePickupsById = new Map();
    nextFramePayById = new Map();
  }
}

function formatZonePopupRelativeAge(tsUnix) {
  const ts = Number(tsUnix ?? NaN);
  if (!Number.isFinite(ts) || ts <= 0) return "unknown";

  const diffSec = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.max(1, Math.round(diffSec / 60))}m ago`;
  if (diffSec < 86400) return `${Math.max(1, Math.round(diffSec / 3600))}h ago`;
  return `${Math.max(1, Math.round(diffSec / 86400))}d ago`;
}

function buildZoneShadowPreviewHTML(props, geom) {
  const shadowSummary = window.TlcScoreShadowModule?.buildZoneShadowSummary?.(props, geom);
  if (!shadowSummary) return "";

  const showPreview =
    debugEnabled ||
    window.__TEAM_JOSEO_SHADOW_PREVIEW__ === true;

  if (!showPreview) return "";

  const delta = Number(shadowSummary.delta_rating);
  const deltaText = Number.isFinite(delta)
    ? (delta > 0 ? `+${Math.round(delta)}` : `${Math.round(delta)}`)
    : "n/a";

  const confidence = Number(shadowSummary.shadow_confidence);
  const confidenceText = Number.isFinite(confidence)
    ? `${Math.round(Math.max(0, Math.min(1, confidence)) * 100)}%`
    : "n/a";

  const zoneAreaSqMiles = Number(shadowSummary.zone_area_sq_miles);
  const pickupsPerSqMileNow = Number(shadowSummary.pickups_per_sq_mile_now);
  const pickupsPerSqMileNext = Number(shadowSummary.pickups_per_sq_mile_next);
  const longTripShare20Plus = Number(shadowSummary.long_trip_share_20plus);
  const sameZoneDropoffShare = Number(shadowSummary.same_zone_dropoff_share);
  const balancedTripShare = Number(shadowSummary.balanced_trip_share);
  const busyNowBaseN = Number(shadowSummary.busy_now_base_n);
  const busyNextBaseN = Number(shadowSummary.busy_next_base_n);
  const churnPressureN = Number(shadowSummary.churn_pressure_n);
  const manhattanCoreSaturationProxyN = Number(shadowSummary.manhattan_core_saturation_proxy_n);
  const citywideAnchorNormV3 = Number(shadowSummary.citywide_anchor_norm_v3);
  const airportExcluded = !!shadowSummary.airport_excluded;

  const zoneAreaLine = Number.isFinite(zoneAreaSqMiles)
    ? `<div><b>Zone area:</b> ${zoneAreaSqMiles.toFixed(2)} sq mi</div>`
    : "";
  const pickupsPerSqMileNowLine = Number.isFinite(pickupsPerSqMileNow)
    ? `<div><b>Pickups / sq mi now:</b> ${pickupsPerSqMileNow.toFixed(1).replace(/\.0$/, "")}</div>`
    : "";
  const pickupsPerSqMileNextLine = Number.isFinite(pickupsPerSqMileNext)
    ? `<div><b>Pickups / sq mi next:</b> ${pickupsPerSqMileNext.toFixed(1).replace(/\.0$/, "")}</div>`
    : "";
  const longTripShare20PlusLine = Number.isFinite(longTripShare20Plus)
    ? `<div><b>20+ min share:</b> ${Math.round(longTripShare20Plus * 100)}%</div>`
    : "";
  const sameZoneDropoffShareLine = Number.isFinite(sameZoneDropoffShare)
    ? `<div><b>Same-zone dropoff share:</b> ${Math.round(sameZoneDropoffShare * 100)}%</div>`
    : "";
  const balancedTripShareLine = Number.isFinite(balancedTripShare)
    ? `<div><b>Balanced trip share:</b> ${Math.round(balancedTripShare * 100)}%</div>`
    : "";
  const busyNowBaseNLine = Number.isFinite(busyNowBaseN)
    ? `<div><b>Busy-now base (n):</b> ${busyNowBaseN.toFixed(3)}</div>`
    : "";
  const busyNextBaseNLine = Number.isFinite(busyNextBaseN)
    ? `<div><b>Busy-next base (n):</b> ${busyNextBaseN.toFixed(3)}</div>`
    : "";
  const churnPressureNLine = Number.isFinite(churnPressureN)
    ? `<div><b>Churn pressure (n):</b> ${churnPressureN.toFixed(3)}</div>`
    : "";
  const manhattanCoreSaturationProxyNLine = Number.isFinite(manhattanCoreSaturationProxyN)
    ? `<div><b>Manhattan saturation proxy (n):</b> ${manhattanCoreSaturationProxyN.toFixed(3)}</div>`
    : "";
  const citywideAnchorNormV3Line = Number.isFinite(citywideAnchorNormV3)
    ? `<div><b>Citywide anchor norm v3:</b> ${citywideAnchorNormV3.toFixed(3)}</div>`
    : "";
  const citywideV3Rating = Number(shadowSummary.citywide_v3_rating);
  const citywideV3Confidence = Number(shadowSummary.citywide_v3_confidence);
  const citywideV3Positive = Number(shadowSummary.citywide_v3_positive);
  const citywideV3Negative = Number(shadowSummary.citywide_v3_negative);
  const citywideV3DeltaVsLegacy = Number(shadowSummary.delta_citywide_v3_vs_legacy);
  const citywideV3DeltaVsCitywideV2 = Number(shadowSummary.delta_citywide_v3_vs_citywide_v2);
  const hasCitywideV3Data =
    Number.isFinite(citywideV3Rating) ||
    Number.isFinite(citywideV3Confidence) ||
    Number.isFinite(citywideV3Positive) ||
    Number.isFinite(citywideV3Negative);
  const citywideV3ConfidenceText = Number.isFinite(citywideV3Confidence)
    ? `${Math.round(Math.max(0, Math.min(1, citywideV3Confidence)) * 100)}%`
    : "n/a";
  const citywideV3DeltaVsLegacyText = Number.isFinite(citywideV3DeltaVsLegacy)
    ? (citywideV3DeltaVsLegacy > 0 ? `+${Math.round(citywideV3DeltaVsLegacy)}` : `${Math.round(citywideV3DeltaVsLegacy)}`)
    : "n/a";
  const citywideV3DeltaVsCitywideV2Text = Number.isFinite(citywideV3DeltaVsCitywideV2)
    ? (citywideV3DeltaVsCitywideV2 > 0 ? `+${Math.round(citywideV3DeltaVsCitywideV2)}` : `${Math.round(citywideV3DeltaVsCitywideV2)}`)
    : "n/a";
  const citywideV3Section = hasCitywideV3Data
    ? `
      <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(0,0,0,0.08);">
        <div style="font-weight:800;margin-bottom:4px;">Team Joseo citywide_v3 candidate</div>
        <div><b>Rating:</b> ${Number.isFinite(citywideV3Rating) ? Math.round(citywideV3Rating) : "n/a"} (${escapeHtml(shadowSummary.citywide_v3_bucket || "")})</div>
        <div><b>Confidence:</b> ${escapeHtml(citywideV3ConfidenceText)}</div>
        <div><b>Positive score:</b> ${Number.isFinite(citywideV3Positive) ? citywideV3Positive.toFixed(3) : "n/a"}</div>
        <div><b>Negative score:</b> ${Number.isFinite(citywideV3Negative) ? citywideV3Negative.toFixed(3) : "n/a"}</div>
        <div><b>Delta vs legacy:</b> ${escapeHtml(citywideV3DeltaVsLegacyText)}</div>
        <div><b>Delta vs citywide_v2:</b> ${escapeHtml(citywideV3DeltaVsCitywideV2Text)}</div>
      </div>`
    : "";
  const activeModeTag = String(window.TlcModeModule?.getActiveSpecialModeTagForFeature?.(props, geom) || "");
  const boroughV3SpecByMode = {
    manhattan: {
      title: "Team Joseo Manhattan_v3 live",
      rating: shadowSummary.manhattan_v3_rating,
      bucket: shadowSummary.manhattan_v3_bucket,
      confidence: shadowSummary.manhattan_v3_confidence,
      delta: shadowSummary.delta_manhattan_v3_vs_v2,
    },
    bronx_wash_heights: {
      title: "Team Joseo Bronx/Wash Heights_v3 live",
      rating: shadowSummary.bronx_wash_heights_v3_rating,
      bucket: shadowSummary.bronx_wash_heights_v3_bucket,
      confidence: shadowSummary.bronx_wash_heights_v3_confidence,
      delta: shadowSummary.delta_bronx_wash_heights_v3_vs_v2,
    },
    queens: {
      title: "Team Joseo Queens_v3 live",
      rating: shadowSummary.queens_v3_rating,
      bucket: shadowSummary.queens_v3_bucket,
      confidence: shadowSummary.queens_v3_confidence,
      delta: shadowSummary.delta_queens_v3_vs_v2,
    },
    brooklyn: {
      title: "Team Joseo Brooklyn_v3 live",
      rating: shadowSummary.brooklyn_v3_rating,
      bucket: shadowSummary.brooklyn_v3_bucket,
      confidence: shadowSummary.brooklyn_v3_confidence,
      delta: shadowSummary.delta_brooklyn_v3_vs_v2,
    },
    staten_island: {
      title: "Team Joseo Staten Island_v3 live",
      rating: shadowSummary.staten_island_v3_rating,
      bucket: shadowSummary.staten_island_v3_bucket,
      confidence: shadowSummary.staten_island_v3_confidence,
      delta: shadowSummary.delta_staten_island_v3_vs_v2,
    },
  };
  const boroughV3Spec = boroughV3SpecByMode[activeModeTag] || null;
  const boroughV3Section = boroughV3Spec
    ? (() => {
        const boroughRating = Number(boroughV3Spec.rating);
        const boroughConfidence = Number(boroughV3Spec.confidence);
        const boroughDelta = Number(boroughV3Spec.delta);
        const hasBoroughV3Data =
          Number.isFinite(boroughRating) ||
          Number.isFinite(boroughConfidence) ||
          Number.isFinite(boroughDelta) ||
          String(boroughV3Spec.bucket || "").trim().length > 0;
        if (!hasBoroughV3Data) return "";

        const boroughConfidenceText = Number.isFinite(boroughConfidence)
          ? `${Math.round(Math.max(0, Math.min(1, boroughConfidence)) * 100)}%`
          : "n/a";
        const boroughDeltaText = Number.isFinite(boroughDelta)
          ? (boroughDelta > 0 ? `+${Math.round(boroughDelta)}` : `${Math.round(boroughDelta)}`)
          : "n/a";
        return `
      <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(0,0,0,0.08);">
        <div style="font-weight:800;margin-bottom:4px;">${escapeHtml(boroughV3Spec.title)}</div>
        <div><b>Rating:</b> ${Number.isFinite(boroughRating) ? Math.round(boroughRating) : "n/a"} (${escapeHtml(boroughV3Spec.bucket || "")})</div>
        <div><b>Confidence:</b> ${escapeHtml(boroughConfidenceText)}</div>
        <div><b>Delta vs v2:</b> ${escapeHtml(boroughDeltaText)}</div>
      </div>`;
      })()
    : "";

  return `
    <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(0,0,0,0.08);">
      <div style="font-weight:800;margin-bottom:4px;">Team Joseo shadow score preview</div>
      <div><b>Legacy rating:</b> ${Number.isFinite(Number(shadowSummary.legacy_rating)) ? Math.round(Number(shadowSummary.legacy_rating)) : "n/a"} (${escapeHtml(shadowSummary.legacy_bucket || "")})</div>
      <div><b>Shadow rating:</b> ${Number.isFinite(Number(shadowSummary.shadow_rating)) ? Math.round(Number(shadowSummary.shadow_rating)) : "n/a"} (${escapeHtml(shadowSummary.shadow_bucket || "")})</div>
      <div><b>Delta:</b> ${escapeHtml(deltaText)}</div>
      <div><b>Confidence:</b> ${escapeHtml(confidenceText)}</div>
      <div><b>Median driver pay:</b> ${Number.isFinite(Number(shadowSummary.median_driver_pay)) ? `$${Number(shadowSummary.median_driver_pay).toFixed(2)}` : "n/a"}</div>
      <div><b>Pay / min:</b> ${Number.isFinite(Number(shadowSummary.median_pay_per_min)) ? `$${Number(shadowSummary.median_pay_per_min).toFixed(2)}` : "n/a"}</div>
      <div><b>Pay / mile:</b> ${Number.isFinite(Number(shadowSummary.median_pay_per_mile)) ? `$${Number(shadowSummary.median_pay_per_mile).toFixed(2)}` : "n/a"}</div>
      <div><b>Req→pickup:</b> ${Number.isFinite(Number(shadowSummary.request_to_pickup_min)) ? `${Number(shadowSummary.request_to_pickup_min).toFixed(1)} min` : "n/a"}</div>
      <div><b>Short-trip share:</b> ${Number.isFinite(Number(shadowSummary.short_trip_share)) ? `${Math.round(Number(shadowSummary.short_trip_share) * 100)}%` : "n/a"}</div>
      <div><b>Shared-ride share:</b> ${Number.isFinite(Number(shadowSummary.shared_ride_share)) ? `${Math.round(Number(shadowSummary.shared_ride_share) * 100)}%` : "n/a"}</div>
      <div><b>Downstream value:</b> ${Number.isFinite(Number(shadowSummary.downstream_value)) ? Number(shadowSummary.downstream_value).toFixed(3) : "n/a"}</div>
      ${zoneAreaLine}
      ${pickupsPerSqMileNowLine}
      ${pickupsPerSqMileNextLine}
      ${balancedTripShareLine}
      ${busyNowBaseNLine}
      ${busyNextBaseNLine}
      ${churnPressureNLine}
      ${manhattanCoreSaturationProxyNLine}
      ${citywideAnchorNormV3Line}
      <div><b>Airport excluded:</b> ${airportExcluded ? "yes" : "no"}</div>
      ${longTripShare20PlusLine}
      ${sameZoneDropoffShareLine}
      ${citywideV3Section}
      ${boroughV3Section}
    </div>
  `;
}

function getPopupVisibleRating(props, geom) {
  const n = Number(window.TlcModeModule?.effectiveRating?.(props, geom) ?? NaN);
  return Number.isFinite(n) ? Math.round(n) : "n/a";
}

function getPopupVisibleBucket(props, geom) {
  return String(window.TlcModeModule?.effectiveBucket?.(props, geom) || "");
}

function getPopupVisibleScoreSource(props, geom) {
  return String(window.TlcModeModule?.getVisibleScoreSourceForFeature?.(props, geom) || "legacy_citywide");
}

function getPopupVisibleScoreSourceLabel(props, geom) {
  return String(window.TlcModeModule?.getVisibleScoreSourceLabel?.(props, geom) || "Team Joseo score");
}

function buildZoneAuditPreviewHTML(props, geom) {
  const showAudit =
    debugEnabled ||
    window.__TEAM_JOSEO_AUDIT__ === true;

  if (!showAudit) return "";

  const audit = window.TlcZoneAuditModule?.getVisibleScoreAudit?.(props, geom);
  if (!audit) return "";
  const readiness = window.TlcScoreShadowModule?.getVisibleShadowReadiness?.(props, geom) || null;

  const crowding = audit.crowding;
  const crowdingLine = crowding
    ? `<div><b>Community caution:</b> ${escapeHtml(crowding.bucketLabel || crowding.bucket || "")} • ${Math.round(Number(crowding.confidence || 0) * 100)}% confidence • penalty ${Number(crowding.penalty || 0).toFixed(1)}</div>`
    : `<div><b>Community caution:</b> none</div>`;
  const contributionBreakdown = readVisibleContributionBreakdown(props, geom);
  const reasonLabelMap = {
    busy_size_positive: "busy for its size",
    pay_quality_positive: "pay quality",
    trip_mix_positive: "trip mix quality",
    continuation_positive: "good continuation",
    short_trip_penalty: "short-trip penalty",
    retention_penalty: "same-zone retention penalty",
    friction_penalty: "pickup/shared friction",
    saturation_penalty: "market saturation",
  };
  const mainStrengths = contributionBreakdown
    ? Object.entries(contributionBreakdown.positive)
      .filter(([, value]) => Number.isFinite(value) && value > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([key]) => reasonLabelMap[key])
    : [];
  const mainDeductions = contributionBreakdown
    ? Object.entries(contributionBreakdown.negative)
      .filter(([, value]) => Number.isFinite(value) && value > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([key]) => reasonLabelMap[key])
    : [];
  const contributionReasonsHtml = contributionBreakdown
    ? `
      ${mainStrengths.length ? `<div><b>Main strengths:</b> ${escapeHtml(mainStrengths.join(" • "))}</div>` : ""}
      ${mainDeductions.length ? `<div><b>Main deductions:</b> ${escapeHtml(mainDeductions.join(" • "))}</div>` : ""}
    `
    : "";

  return `
    <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(0,0,0,0.08);">
      <div style="font-weight:800;margin-bottom:4px;">Team Joseo audit</div>
      <div><b>Visible source:</b> ${escapeHtml(audit.visibleSourceLabel || audit.visibleSource || "")}</div>
      <div><b>Technical source:</b> ${escapeHtml(audit.technicalSourceLabel || audit.visibleSource || "")}</div>
      <div><b>Fallback:</b> ${audit.usingFallback ? "yes" : "no"}</div>
      <div><b>Profile key:</b> ${escapeHtml(readiness?.profileKey || "none")}</div>
      <div><b>Shadow ready:</b> ${readiness?.shadowReady ? "yes" : "no"}</div>
      <div><b>Mode tag:</b> ${escapeHtml(audit.activeModeTag || "citywide")}</div>
      ${contributionReasonsHtml}
      ${crowdingLine}
    </div>
  `;
}


function buildCommunityCrowdingHTML(props) {
  const zoneId = String(props?.LocationID ?? "");
  const stat = window.TlcCommunityCrowdingModule?.getZoneCommunityCrowdingSnapshot?.(zoneId);
  if (!stat || !stat.bucket || stat.bucket === "none") return "";

  const label =
    stat.bucket === "heavy" ? "Heavy caution" :
    stat.bucket === "crowded" ? "Crowded caution" :
    "Watch";

  const confidenceText = `${Math.round(Math.max(0, Math.min(1, Number(stat.confidence || 0))) * 100)}%`;

  return `
    <div style="margin-top:6px;">
      <b>Community crowding:</b> ${escapeHtml(label)}
    </div>
    <div><b>Visible Team Joseo drivers:</b> ${Math.max(0, Math.round(Number(stat.communityDriverCount || 0)))}</div>
    <div><b>Confidence:</b> ${escapeHtml(confidenceText)}</div>
    <div style="opacity:0.78;">Community-only caution.</div>
  `;
}

function isAirportExcludedZone(props) {
  if (props?.airport_excluded === true) return true;
  const zoneName = String(props?.zone_name || "").toLowerCase();
  const locationId = String(props?.LocationID ?? "").trim();
  return /airport|jfk|la guardia|laguardia|newark/i.test(zoneName) || ["1", "132", "138"].includes(locationId);
}

function getVisibleV3ProfileKeyForFeature(props, geom) {
  const source = getPopupVisibleScoreSource(props, geom);
  const mapBySource = {
    citywide_v3_shadow: "citywide_v3",
    manhattan_v3_shadow: "manhattan_v3",
    bronx_wash_heights_v3_shadow: "bronx_wash_heights_v3",
    queens_v3_shadow: "queens_v3",
    brooklyn_v3_shadow: "brooklyn_v3",
    staten_island_v3_shadow: "staten_island_v3",
  };
  return mapBySource[source] || null;
}

function readVisibleContributionBreakdown(props, geom) {
  const summary = window.TlcScoreShadowModule?.buildZoneShadowSummary?.(props, geom) || null;
  const profile = String(summary?.visible_v3_profile_key || getVisibleV3ProfileKeyForFeature(props, geom) || "");
  if (!profile) return null;

  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
  const read = (field) => num(props?.[field]);
  const fromSummaryOrProps = (summaryKey, propField) => {
    const summaryValue = num(summary?.[summaryKey]);
    if (Number.isFinite(summaryValue)) return summaryValue;
    return read(`${propField}_${profile}`);
  };

  const contributions = {
    profile,
    positive: {
      busy_size_positive: fromSummaryOrProps("busy_size_positive_v3", "earnings_shadow_busy_size_positive"),
      pay_quality_positive: fromSummaryOrProps("pay_quality_positive_v3", "earnings_shadow_pay_quality_positive"),
      trip_mix_positive: fromSummaryOrProps("trip_mix_positive_v3", "earnings_shadow_trip_mix_positive"),
      continuation_positive: fromSummaryOrProps("continuation_positive_v3", "earnings_shadow_continuation_positive"),
    },
    negative: {
      short_trip_penalty: fromSummaryOrProps("short_trip_penalty_v3", "earnings_shadow_short_trip_penalty"),
      retention_penalty: fromSummaryOrProps("retention_penalty_v3", "earnings_shadow_retention_penalty"),
      friction_penalty: fromSummaryOrProps("friction_penalty_v3", "earnings_shadow_friction_penalty"),
      saturation_penalty: fromSummaryOrProps("saturation_penalty_v3", "earnings_shadow_saturation_penalty"),
    },
    mechanics: {
      citywide_anchor_input: num(summary?.citywide_anchor_input_v3) ?? read("earnings_shadow_citywide_anchor_input_v3"),
      citywide_anchor_base: num(summary?.citywide_anchor_base_v3) ?? read("earnings_shadow_citywide_anchor_base_v3"),
      citywide_anchor_display: num(summary?.citywide_anchor_display_v3) ?? read("earnings_shadow_citywide_anchor_display_v3"),
      citywide_anchor_norm: num(summary?.citywide_anchor_norm_v3) ?? read("earnings_shadow_citywide_anchor_norm_v3"),
      local_rank: num(summary?.visible_rank_v3) ?? read(`earnings_shadow_visible_rank_${profile}`),
      base_visible_score: num(summary?.visible_base_score_v3) ?? read(`earnings_shadow_visible_base_score_${profile}`),
      final_visible_score: num(summary?.visible_score_v3) ?? read(`earnings_shadow_visible_score_${profile}`),
      visible_confidence: num(summary?.visible_confidence_v3) ?? read(`earnings_shadow_confidence_${profile}`),
    },
  };

  const hasContributionFields = [
    ...Object.values(contributions.positive),
    ...Object.values(contributions.negative),
  ].some((value) => Number.isFinite(value));

  return hasContributionFields ? contributions : null;
}

function buildRealContributionReasonSummary(props, geom) {
  const contributionBreakdown = readVisibleContributionBreakdown(props, geom);
  if (!contributionBreakdown) return null;

  const positiveThresholds = {
    busy_size_positive: 0.10,
    pay_quality_positive: 0.08,
    trip_mix_positive: 0.04,
    continuation_positive: 0.05,
  };
  const negativeThresholds = {
    short_trip_penalty: 0.03,
    retention_penalty: 0.03,
    friction_penalty: 0.02,
    saturation_penalty: 0.03,
  };

  const top = (groups, thresholds) => groups
    .filter(([key, value]) => Number.isFinite(value) && value > 0 && value >= Number(thresholds?.[key] ?? Number.POSITIVE_INFINITY))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2);

  const topPositiveContributions = top(Object.entries(contributionBreakdown.positive), positiveThresholds);
  const topNegativeContributions = top(Object.entries(contributionBreakdown.negative), negativeThresholds);

  const positiveLabels = {
    busy_size_positive: "busy for its size",
    pay_quality_positive: "pay quality",
    trip_mix_positive: "trip mix quality",
    continuation_positive: "good continuation",
  };
  const negativeLabels = {
    short_trip_penalty: "short-trip penalty",
    retention_penalty: "same-zone retention penalty",
    friction_penalty: "pickup/shared friction",
    saturation_penalty: "market saturation",
  };

  return {
    contributionBreakdown,
    strengths: topPositiveContributions.map(([key]) => positiveLabels[key]).filter(Boolean),
    deductions: topNegativeContributions.map(([key]) => negativeLabels[key]).filter(Boolean),
  };
}

function buildZoneWhyReasons(props, geom, visibleScoreSource) {
  const summary = window.TlcScoreShadowModule?.buildZoneShadowSummary?.(props, geom) || null;
  const contributionBreakdown = readVisibleContributionBreakdown(props, geom);
  const visibleSaturationPenalty = Number(contributionBreakdown?.negative?.saturation_penalty);
  const reasons = [];
  const pushReason = (text) => {
    if (!text || reasons.includes(text) || reasons.length >= 5) return;
    reasons.push(text);
  };
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

  const busyNow = num(summary?.busy_now_base_n);
  const busyNext = num(summary?.busy_next_base_n);
  const tripMix = num(summary?.balanced_trip_share);
  const churnPressure = num(summary?.churn_pressure_n);
  const retentionPenalty = num(summary?.same_zone_retention_penalty_n);
  const shortTripPenalty = num(summary?.short_trip_share);
  const area = num(summary?.zone_area_sq_miles);

  if (isAirportExcludedZone(props)) pushReason("airport excluded from hotspot logic");
  if (Number.isFinite(area) && area > 0 && Number.isFinite(busyNow) && busyNow >= 0.6) pushReason("busy for its size right now");
  if (Number.isFinite(busyNext) && busyNext >= 0.6) pushReason("good next-bin carry");
  if (Number.isFinite(tripMix) && tripMix >= 0.45) pushReason("balanced trip mix");
  if (Number.isFinite(shortTripPenalty) && shortTripPenalty >= 0.55) pushReason("short-trip trap risk");
  if (Number.isFinite(churnPressure) && churnPressure >= 0.6) pushReason("same-zone churn risk");
  if (Number.isFinite(retentionPenalty) && retentionPenalty >= 0.55) pushReason("same-zone retention penalty is elevated");
  if (Number.isFinite(visibleSaturationPenalty) && visibleSaturationPenalty > 0.05 && (
    visibleScoreSource === "manhattan_v3_shadow" ||
    (visibleScoreSource === "citywide_v3_shadow" && isManhattanFeature(props))
  )) {
    pushReason("Manhattan saturation caution");
  } else if (Number.isFinite(visibleSaturationPenalty) && visibleSaturationPenalty > 0.05 && visibleScoreSource === "citywide_v3_shadow") {
    pushReason("market saturation caution");
  }

  return reasons.slice(0, 5);
}

function resolveScoreTripCount(directCount, areaSqMiles, pickupsPerSqMile) {
  const direct = Number(directCount);
  if (Number.isFinite(direct) && direct >= 0) {
    return { value: Math.round(direct), estimated: false };
  }

  const area = Number(areaSqMiles);
  const density = Number(pickupsPerSqMile);
  if (Number.isFinite(area) && area > 0 && Number.isFinite(density) && density >= 0) {
    return { value: Math.round(area * density), estimated: true };
  }

  return { value: null, estimated: false };
}

function buildPopupHTML(props, geom, metrics = getZonePopupMetrics(map?.getZoom?.())) {
  const zoneName = (props.zone_name || "").trim();
  const borough = (props.borough || "").trim();

  const visibleRating = getPopupVisibleRating(props, geom);
  const visibleBucket = getPopupVisibleBucket(props, geom);
  const visibleScoreSource = getPopupVisibleScoreSource(props, geom);
  const airportExcluded = isAirportExcludedZone(props);
  const realContributionSummary = buildRealContributionReasonSummary(props, geom);
  const contributionBreakdown = realContributionSummary?.contributionBreakdown || null;
  const whyReasons = buildZoneWhyReasons(props, geom, visibleScoreSource);
  const strengthReasons = realContributionSummary?.strengths || [];
  const deductionReasons = realContributionSummary?.deductions || [];
  const hasContributionBreakdown = !!contributionBreakdown;
  const hasRealContributionReasons = strengthReasons.length > 0 || deductionReasons.length > 0;
  const whyReasonsHtml = hasContributionBreakdown
    ? (hasRealContributionReasons
      ? `
        ${strengthReasons.length ? `<div style="margin-top:${metrics.lineGapPx + 1}px;"><b>Main strengths:</b> ${escapeHtml(strengthReasons.join(" • "))}</div>` : ""}
        ${deductionReasons.length ? `<div><b>Main deductions:</b> ${escapeHtml(deductionReasons.join(" • "))}</div>` : ""}
      `
      : "")
    : (whyReasons.length
      ? `<div style="margin-top:${metrics.lineGapPx + 1}px;"><b>Why this zone:</b> ${escapeHtml(whyReasons.join(" • "))}</div>`
      : "");
  const isVisibleV3Source = /_v3_shadow$/.test(visibleScoreSource);
  const shadowSummary = isVisibleV3Source
    ? (window.TlcScoreShadowModule?.buildZoneShadowSummary?.(props, geom) || null)
    : null;
  const zoneAreaSqMilesShadow = Number(shadowSummary?.zone_area_sq_miles);
  const pickupsPerSqMileNowShadow = Number(shadowSummary?.pickups_per_sq_mile_now);
  const pickupsPerSqMileNextShadow = Number(shadowSummary?.pickups_per_sq_mile_next);
  const busySizeContribution = Number(contributionBreakdown?.positive?.busy_size_positive);
  const v3SizeEvidenceHtml = isVisibleV3Source
    ? `
      <div style="margin-top:${metrics.lineGapPx + 1}px;"><b>Zone area:</b> ${Number.isFinite(zoneAreaSqMilesShadow) ? `${zoneAreaSqMilesShadow.toFixed(2)} sq mi` : "n/a"}</div>
      <div><b>Pickups / sq mi now:</b> ${Number.isFinite(pickupsPerSqMileNowShadow) ? pickupsPerSqMileNowShadow.toFixed(1).replace(/\.0$/, "") : "n/a"}</div>
      <div><b>Pickups / sq mi next:</b> ${Number.isFinite(pickupsPerSqMileNextShadow) ? pickupsPerSqMileNextShadow.toFixed(1).replace(/\.0$/, "") : "n/a"}</div>
      ${Number.isFinite(busySizeContribution) ? `<div><b>Busy/size contribution:</b> ${busySizeContribution.toFixed(3)}</div>` : ""}
    `
    : "";
  const contributionDebugHtml = (debugEnabled || window.__TEAM_JOSEO_AUDIT__ === true) && contributionBreakdown
    ? `
      <div style="margin-top:${metrics.lineGapPx + 1}px;">
        <b>Visible score debug:</b>
        <div><b>Citywide anchor input:</b> ${Number.isFinite(contributionBreakdown.mechanics.citywide_anchor_input) ? contributionBreakdown.mechanics.citywide_anchor_input.toFixed(3) : "n/a"}</div>
        <div><b>Citywide anchor base:</b> ${Number.isFinite(contributionBreakdown.mechanics.citywide_anchor_base) ? contributionBreakdown.mechanics.citywide_anchor_base.toFixed(3) : "n/a"}</div>
        <div><b>Citywide anchor display:</b> ${Number.isFinite(contributionBreakdown.mechanics.citywide_anchor_display) ? contributionBreakdown.mechanics.citywide_anchor_display.toFixed(3) : "n/a"}</div>
        <div><b>Citywide anchor norm:</b> ${Number.isFinite(contributionBreakdown.mechanics.citywide_anchor_norm) ? contributionBreakdown.mechanics.citywide_anchor_norm.toFixed(3) : "n/a"}</div>
        <div><b>Local rank:</b> ${Number.isFinite(contributionBreakdown.mechanics.local_rank) ? contributionBreakdown.mechanics.local_rank.toFixed(3) : "n/a"}</div>
        <div><b>Base visible score:</b> ${Number.isFinite(contributionBreakdown.mechanics.base_visible_score) ? contributionBreakdown.mechanics.base_visible_score.toFixed(3) : "n/a"}</div>
        <div><b>Final visible score:</b> ${Number.isFinite(contributionBreakdown.mechanics.final_visible_score) ? contributionBreakdown.mechanics.final_visible_score.toFixed(3) : "n/a"}</div>
        <div><b>Visible profile confidence:</b> ${Number.isFinite(contributionBreakdown.mechanics.visible_confidence) ? contributionBreakdown.mechanics.visible_confidence.toFixed(3) : "n/a"}</div>
      </div>
    `
    : "";
  const airportExcludedLine = airportExcluded
    ? `<div style="margin-top:${metrics.lineGapPx + 1}px;color:#9a3412;"><b>Excluded:</b> Airport zone — not part of hotspot opportunity logic.</div>`
    : "";
  const pickups = props.pickups ?? "";
  const pay = props.avg_driver_pay == null ? "n/a" : Number(props.avg_driver_pay).toFixed(2);
  const pickupsNowShadow = Number(props.pickups_now_shadow);
  const nextPickupsShadow = Number(props.next_pickups_shadow);
  const scoreTripsNow = resolveScoreTripCount(
    props.pickups_now_shadow,
    props.zone_area_sq_miles_shadow,
    props.pickups_per_sq_mile_now_shadow
  );
  const scoreTripsNext = resolveScoreTripCount(
    props.next_pickups_shadow,
    props.zone_area_sq_miles_shadow,
    props.pickups_per_sq_mile_next_shadow
  );
  const scoreTripsNowDisplay = scoreTripsNow.value == null
    ? "n/a"
    : `${scoreTripsNow.estimated ? "~" : ""}${scoreTripsNow.value}`;
  const scoreTripsNextDisplay = scoreTripsNext.value == null
    ? "n/a"
    : `${scoreTripsNext.estimated ? "~" : ""}${scoreTripsNext.value}`;
  const popupMetricWarningLines = [];
  if (debugEnabled || window.__TEAM_JOSEO_AUDIT__ === true) {
    const zoneAreaShadow = Number(props.zone_area_sq_miles_shadow);
    const pickupsPerSqMileNowDirect = Number(props.pickups_per_sq_mile_now_shadow);
    const pickupsPerSqMileNextDirect = Number(props.pickups_per_sq_mile_next_shadow);
    const computedNow = Number.isFinite(zoneAreaShadow) && zoneAreaShadow > 0 && Number.isFinite(pickupsPerSqMileNowDirect) && pickupsPerSqMileNowDirect >= 0
      ? zoneAreaShadow * pickupsPerSqMileNowDirect
      : null;
    const computedNext = Number.isFinite(zoneAreaShadow) && zoneAreaShadow > 0 && Number.isFinite(pickupsPerSqMileNextDirect) && pickupsPerSqMileNextDirect >= 0
      ? zoneAreaShadow * pickupsPerSqMileNextDirect
      : null;
    if (Number.isFinite(pickupsNowShadow) && Number.isFinite(computedNow) && Math.abs(pickupsNowShadow - computedNow) > 2.0) {
      popupMetricWarningLines.push("<div style=\"color:#9a3412;\"><b>Popup metric warning:</b> current score trip count disagrees with area × density</div>");
    }
    if (Number.isFinite(nextPickupsShadow) && Number.isFinite(computedNext) && Math.abs(nextPickupsShadow - computedNext) > 2.0) {
      popupMetricWarningLines.push("<div style=\"color:#9a3412;\"><b>Popup metric warning:</b> next score trip count disagrees with area × density</div>");
    }
  }
  const medianDriverPayShadow = Number(props.median_driver_pay_shadow);
  const medianPayPerMinShadow = Number(props.median_pay_per_min_shadow);
  const medianPayPerMileShadow = Number(props.median_pay_per_mile_shadow);

  const nextPuVal = nextFramePickupsById.get(String(props.LocationID ?? ""));
  const nextPickups = nextPuVal == null ? "n/a" : String(Math.round(nextPuVal));

  const nextPayVal = nextFramePayById.get(String(props.LocationID ?? ""));
  const nextPay = nextPayVal == null ? "n/a" : Number(nextPayVal).toFixed(2);
  const zoneCommunity = pickupZoneStats.get(String(props.LocationID ?? ""));
  const communityPickupCount = Number(zoneCommunity?.sample_size ?? 0);
  const communitySampleLimit = Number(zoneCommunity?.sample_limit ?? PICKUP_ZONE_SAMPLE_LIMIT);
  const communityLastTs = zoneCommunity?.latest_created_at ?? null;
  const communityPickupLine = communityPickupCount > 0
    ? `<div style="margin-top:6px;"><b>Community zone avg:</b> ${communityPickupCount}/${communitySampleLimit} trips used${communityLastTs ? ` • last ${escapeHtml(formatZonePopupRelativeAge(communityLastTs))}` : ""}</div>`
    : "";
  const legacyPreviewHtml = (debugEnabled || window.__TEAM_JOSEO_AUDIT__ === true)
    ? `
      <div style="margin-top:${metrics.lineGapPx + 1}px;opacity:0.78;">
        <b>Legacy preview:</b>
        <div><b>Legacy pickups preview:</b> ${escapeHtml(String(pickups))}</div>
        <div><b>Legacy avg pay preview:</b> $${pay}</div>
      </div>
    `
    : "";
  const popupMetricEvidenceHtml = isVisibleV3Source
    ? `
      <div style="margin-top:${metrics.lineGapPx + 1}px;"><b>Trips counted for score (last 20 min):</b> ${scoreTripsNowDisplay}</div>
      <div><b>Trips counted for score (next 20 min):</b> ${scoreTripsNextDisplay}</div>
      <div><b>Median driver pay:</b> ${Number.isFinite(medianDriverPayShadow) ? `$${medianDriverPayShadow.toFixed(2)}` : "n/a"}</div>
      <div><b>Median pay / min:</b> ${Number.isFinite(medianPayPerMinShadow) ? `$${medianPayPerMinShadow.toFixed(2)}` : "n/a"}</div>
      <div><b>Median pay / mile:</b> ${Number.isFinite(medianPayPerMileShadow) ? `$${medianPayPerMileShadow.toFixed(2)}` : "n/a"}</div>
      ${popupMetricWarningLines.join("")}
      ${legacyPreviewHtml}
    `
    : `
      <div style="margin-top:${metrics.lineGapPx + 1}px;"><b>Pickups (last ${BIN_MINUTES} min):</b> ${pickups}</div>
      <div><b>Next ${BIN_MINUTES} min:</b> ${nextPickups}</div>
      ${communityPickupLine}
      <div><b>Avg Pay next ${BIN_MINUTES} min:</b> $${nextPay}</div>
      <div><b>Avg Pay last 20 min:</b> $${pay}</div>
    `;

  let extra = "";
  const modeFlags = getModeFlags();
  const activeModeTag = getActiveSpecialModeTagForFeature(props, geom);
  const getRatingVisualsFromShownRating = (rating) => {
    const n = Number(rating);
    if (!Number.isFinite(n)) return { bucket: "", color: "" };
    const modeModule = window.TlcModeModule;
    if (typeof modeModule?.getBucketForRating === "function" || typeof modeModule?.getColorForRating === "function") {
      return {
        bucket: typeof modeModule?.getBucketForRating === "function" ? String(modeModule.getBucketForRating(n) || "") : "",
        color: typeof modeModule?.getColorForRating === "function" ? String(modeModule.getColorForRating(n) || "") : ""
      };
    }
    return {
      bucket: String(effectiveBucket(props, geom) || ""),
      color: String(effectiveColor(props, geom) || "")
    };
  };
  const getBucketFromShownRating = (rating) => {
    return getRatingVisualsFromShownRating(rating).bucket;
  };

  if (modeFlags.statenIslandMode && activeModeTag === "staten_island") {
    const statenIslandV3ShadowRating = Number(window.TlcModeModule?.readStatenIslandV3ShadowRating?.(props) ?? NaN);
    const statenIslandShadowRating = Number(window.TlcModeModule?.readStatenIslandShadowRating?.(props) ?? NaN);
    if (Number.isFinite(statenIslandV3ShadowRating)) {
      extra += `<div style="margin-top:6px;"><b>Staten Island earnings score:</b> ${statenIslandV3ShadowRating} (${prettyBucket(getBucketFromShownRating(statenIslandV3ShadowRating))})</div>`;
    } else if (Number.isFinite(statenIslandShadowRating)) {
      extra += `<div style="margin-top:6px;"><b>Staten Island earnings score:</b> ${statenIslandShadowRating} (${prettyBucket(getBucketFromShownRating(statenIslandShadowRating))})</div>`;
    } else if (Number.isFinite(Number(props.si_local_rating))) {
      extra += `<div style="margin-top:6px;"><b>Staten Island earnings score:</b> ${props.si_local_rating} (${prettyBucket(getBucketFromShownRating(props.si_local_rating))})</div>`;
    }
  }

  if (modeFlags.manhattanMode && activeModeTag === "manhattan") {
    const manhattanV3ShadowRating = Number(window.TlcModeModule?.readManhattanV3ShadowRating?.(props) ?? NaN);
    const manhattanShadowRating = Number(window.TlcModeModule?.readManhattanShadowRating?.(props) ?? NaN);
    if (Number.isFinite(manhattanV3ShadowRating)) {
      extra += `<div style="margin-top:6px;"><b>Manhattan earnings score:</b> ${manhattanV3ShadowRating} (${prettyBucket(getBucketFromShownRating(manhattanV3ShadowRating))})</div>`;
    } else if (Number.isFinite(manhattanShadowRating)) {
      extra += `<div style="margin-top:6px;"><b>Manhattan earnings score:</b> ${manhattanShadowRating} (${prettyBucket(getBucketFromShownRating(manhattanShadowRating))})</div>`;
    } else if (Number.isFinite(Number(props.mh_local_rating))) {
      extra += `<div style="margin-top:6px;"><b>Manhattan earnings score:</b> ${props.mh_local_rating} (${prettyBucket(getBucketFromShownRating(props.mh_local_rating))})</div>`;
    }
  }

  if (modeFlags.queensMode && activeModeTag === "queens") {
    const queensV3ShadowRating = Number(window.TlcModeModule?.readQueensV3ShadowRating?.(props) ?? NaN);
    const queensShadowRating = Number(window.TlcModeModule?.readQueensShadowRating?.(props) ?? NaN);
    if (Number.isFinite(queensV3ShadowRating)) {
      extra += `<div style="margin-top:6px;"><b>Queens earnings score:</b> ${queensV3ShadowRating} (${prettyBucket(getBucketFromShownRating(queensV3ShadowRating))})</div>`;
    } else if (Number.isFinite(queensShadowRating)) {
      extra += `<div style="margin-top:6px;"><b>Queens earnings score:</b> ${queensShadowRating} (${prettyBucket(getBucketFromShownRating(queensShadowRating))})</div>`;
    } else if (Number.isFinite(Number(props.qn_local_rating))) {
      extra += `<div style="margin-top:6px;"><b>Queens earnings score:</b> ${props.qn_local_rating} (${prettyBucket(getBucketFromShownRating(props.qn_local_rating))})</div>`;
    }
  }

  if (modeFlags.brooklynMode && activeModeTag === "brooklyn") {
    const brooklynV3ShadowRating = Number(window.TlcModeModule?.readBrooklynV3ShadowRating?.(props) ?? NaN);
    const brooklynShadowRating = Number(window.TlcModeModule?.readBrooklynShadowRating?.(props) ?? NaN);
    if (Number.isFinite(brooklynV3ShadowRating)) {
      extra += `<div style="margin-top:6px;"><b>Brooklyn earnings score:</b> ${brooklynV3ShadowRating} (${prettyBucket(getBucketFromShownRating(brooklynV3ShadowRating))})</div>`;
    } else if (Number.isFinite(brooklynShadowRating)) {
      extra += `<div style="margin-top:6px;"><b>Brooklyn earnings score:</b> ${brooklynShadowRating} (${prettyBucket(getBucketFromShownRating(brooklynShadowRating))})</div>`;
    } else if (Number.isFinite(Number(props.bk_local_rating))) {
      extra += `<div style="margin-top:6px;"><b>Brooklyn earnings score:</b> ${props.bk_local_rating} (${prettyBucket(getBucketFromShownRating(props.bk_local_rating))})</div>`;
    }
  }

  if (modeFlags.bronxWashHeightsMode && activeModeTag === "bronx_wash_heights") {
    const bwhV3ShadowRating = Number(window.TlcModeModule?.readBronxWashHeightsV3ShadowRating?.(props) ?? NaN);
    const bwhV2ShadowRating = Number(window.TlcModeModule?.readBronxWashHeightsShadowRating?.(props) ?? NaN);
    if (Number.isFinite(bwhV3ShadowRating)) {
      extra += `<div style="margin-top:6px;"><b>Bronx/Wash Heights earnings score:</b> ${bwhV3ShadowRating} (${prettyBucket(getBucketFromShownRating(bwhV3ShadowRating))})</div>`;
    } else if (Number.isFinite(bwhV2ShadowRating)) {
      extra += `<div style="margin-top:6px;"><b>Bronx/Wash Heights earnings score:</b> ${bwhV2ShadowRating} (${prettyBucket(getBucketFromShownRating(bwhV2ShadowRating))})</div>`;
    } else if (Number.isFinite(Number(props.bwh_local_rating))) {
      extra += `<div style="margin-top:6px;"><b>Bronx/Wash Heights earnings score:</b> ${props.bwh_local_rating} (${prettyBucket(getBucketFromShownRating(props.bwh_local_rating))})</div>`;
    }
  }

  const showRawHvfBase = (debugEnabled || window.__TEAM_JOSEO_SHADOW_PREVIEW__ === true) && (visibleScoreSource === "citywide_shadow" || visibleScoreSource === "citywide_v3_shadow");
  const rawHvfBaseRating = Number.isFinite(Number(props?.rating)) ? Math.round(Number(props.rating)) : "n/a";
  const rawHvfBaseBucket = String(props?.bucket || "");

  return `
  <div
    class="zonePopupCard"
    style="
      max-width:${metrics.maxWidthPx}px;
      padding:${metrics.paddingPx}px;
      border-radius:${metrics.borderRadiusPx}px;
      font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;
      font-size:${metrics.fontPx}px;
      line-height:1.22;
      box-shadow:0 6px 18px rgba(0,0,0,0.18);
    "
  >
    <div style="font-weight:800;font-size:${metrics.titlePx}px;margin-bottom:${metrics.lineGapPx}px;">
      ${escapeHtml(zoneName || `Zone ${props.LocationID ?? ""}`)}
    </div>
    ${borough ? `<div style="opacity:0.78;margin-bottom:${metrics.lineGapPx + 1}px;">${escapeHtml(borough)}</div>` : `<div style="margin-bottom:${metrics.lineGapPx + 1}px;"></div>`}
    <div><b>Team Joseo Score:</b> ${visibleRating} (${prettyBucket(visibleBucket)})</div>
    <div><b>Score source:</b> ${escapeHtml(getPopupVisibleScoreSourceLabel(props, geom))}</div>
    ${airportExcludedLine}
    ${whyReasonsHtml}
    ${v3SizeEvidenceHtml}
    ${contributionDebugHtml}
    ${extra}
    ${popupMetricEvidenceHtml}
    ${isVisibleV3Source ? communityPickupLine : ""}
    ${showRawHvfBase ? `<div><b>Raw HVFHV base rating:</b> ${rawHvfBaseRating} (${prettyBucket(rawHvfBaseBucket)})</div>` : ""}
    ${buildZoneShadowPreviewHTML(props, geom)}
    ${buildCommunityCrowdingHTML(props)}
    ${buildZoneAuditPreviewHTML(props, geom)}
  </div>
`;

}

window.getCurrentZoneCommunityCrowdingDebug = function getCurrentZoneCommunityCrowdingDebug(locationId) {
  return window.TlcCommunityCrowdingModule?.getZoneCommunityCrowdingSnapshot?.(locationId) || null;
};


/* =========================================================
   Render frame
   ========================================================= */

function emitTeamJoseoFrameRendered(frame, featureCount) {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(new CustomEvent("team-joseo-frame-rendered", {
    detail: {
      time: String(frame?.time || ""),
      featureCount: Number(featureCount || 0),
    },
  }));
}

async function renderFrame(frame, options = {}) {
  const { temporaryViewportSubset = false, skipRecommendationUpdate = false } = options || {};
  if (!map || !mapReady) {
    pendingFrame = frame;
    return;
  }

  const zonesReady = await ensureZonesSourceAndLayers();
  if (!zonesReady || !map.getSource("zones")) {
    pendingFrame = frame;
    return;
  }

  currentFrame = frame;
  if (temporaryViewportSubset !== true && frame?._viewport_subset !== true) {
    startupFullFrameBackfillCompleted = true;
    clearStartupFullFrameRetryTimer();
  }
  const currentFrameSig = frameSignature(frame);
  lastRenderedFrameSignature = currentFrameSig;

  // apply modes to mutate props (same as old)
  const modeFlags = getModeFlags();
  if (modeFlags.queensMode) applyQueensLocalView(frame);
  if (modeFlags.brooklynMode) applyBrooklynLocalView(frame);
  if (modeFlags.bronxWashHeightsMode) applyBronxWashHeightsLocalView(frame);
  if (modeFlags.statenIslandMode) applyStatenLocalView(frame);
  if (modeFlags.manhattanMode) applyManhattanLocalView(frame);

  const fc = frame.polygons || { type: "FeatureCollection", features: [] };
  const visualSignature = getRenderVisualSignature(modeFlags);
  const processedVisualKey = `${currentFrameSig}|${visualSignature}`;
  let processedFc = getProcessedFrameVisualFromCache(processedVisualKey);
  if (!processedFc) {
    for (const f of fc.features) {
      const props = f.properties || {};
      const baseCol = effectiveColor(props, f.geometry) || "#66aaff";
      const fillCol = window.TlcModeModule?.effectiveFillColor?.(props, f.geometry) || baseCol;
      props.effectiveColor = baseCol;
      props.effectiveFillColor = fillCol;
    }
    processedFc = fc;
    rememberProcessedFrameVisual(processedVisualKey, processedFc);
  } else if (processedFc !== fc) {
    for (let i = 0; i < fc.features.length; i += 1) {
      const live = fc.features[i]?.properties || {};
      const cached = processedFc.features?.[i]?.properties || {};
      live.effectiveColor = cached.effectiveColor || live.effectiveColor || "#66aaff";
      live.effectiveFillColor = cached.effectiveFillColor || cached.effectiveColor || live.effectiveColor || "#66aaff";
    }
  }

  if (!debugOnce.frame) {
    console.log("DEBUG frame", { time: frame?.time, featureCount: fc.features.length });
    debugOnce.frame = true;
  }

  map.getSource("zones").setData(processedFc || fc);

  // Labels update (points inside polygons)
  const nextZoomBucket = getZoneLabelZoomBucket();
  const nextVisibilitySig = getZoneLabelVisibilitySignature();
  const shouldRefreshLabels =
    lastZoneLabelFrameSignature !== currentFrameSig
    || lastZoneLabelZoomBucket !== nextZoomBucket
    || lastZoneLabelVisualSignature !== visualSignature
    || lastZoneLabelVisibilitySignature !== nextVisibilitySig;
  if (shouldRefreshLabels) {
    refreshZoneLabels(frame);
    lastZoneLabelFrameSignature = currentFrameSig;
    lastZoneLabelZoomBucket = nextZoomBucket;
    lastZoneLabelVisualSignature = visualSignature;
    lastZoneLabelVisibilitySignature = nextVisibilitySig;
  }
  emitTeamJoseoFrameRendered(frame, fc.features.length);
  if (temporaryViewportSubset && debugEnabled) {
    dbg("dbgFrame", `startup viewport subset rendered (${fc.features.length})`);
  }

  if (debugEnabled) {
    dbg("dbgSetData", `OK features=${fc.features.length}`);
    dbg(
      "dbgLayers",
      `source=${Boolean(map.getSource("zones"))} fill=${Boolean(map.getLayer("zones-fill"))} line=${Boolean(
        map.getLayer("zones-line")
      )}`
    );
  }

  const bounds = getFeatureCollectionBounds(fc);
  if (debugEnabled) dbg("dbgBounds", bounds ? `${bounds.minLng},${bounds.minLat},${bounds.maxLng},${bounds.maxLat}` : "invalid");

  if (ENABLE_BOOT_ZONE_FIT && fc.features.length > 0 && !didFitToZonesOnce && bounds) {
    map.fitBounds(
      [
        [bounds.minLng, bounds.minLat],
        [bounds.maxLng, bounds.maxLat],
      ],
      { padding: 40, duration: 0 }
    );
    didFitToZonesOnce = true;
  }
  if (debugEnabled) dbg("dbgFit", didFitToZonesOnce);

  if (timeLabel && currentFrame?.time) {
    timeLabel.textContent = `Showing Team Joseo Score At ${formatNYCLabel(currentFrame.time)}`;
  }
  if (!skipRecommendationUpdate) updateRecommendation(currentFrame);
  markFirstUsableMap("frame rendered");
}

/* =========================================================
   Load frame / timeline
   ========================================================= */
async function loadFrame(idx, { force = false } = {}) {
  const frameStartedAt = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  const normalizedIdx = Math.max(0, Number(idx) || 0);
  const frameUrl = `${RAILWAY_BASE}${buildFramePathWithMonthKey(normalizedIdx)}`;
  if (pendingFrameLoad?.idx === normalizedIdx && pendingFrameLoad?.promise && !force) return pendingFrameLoad.promise;
  const cachedFrame = !force ? getCachedFrame(normalizedIdx) : null;
  if (!force && normalizedIdx === lastRenderedFrameIndex && cachedFrame && lastRenderedFrameSignature === frameSignature(cachedFrame)) {
    prefetchFrame(normalizedIdx + 1);
    prefetchFrame(normalizedIdx - 1);
    return cachedFrame;
  }
  loadNextFramePickupsMap(idx).catch(() => {});
  let frame = cachedFrame;
  if (!frame) {
    const promise = fetchFrameData(normalizedIdx, { priority: "active", force });
    pendingFrameLoad = { idx: normalizedIdx, promise };
    frame = await promise;
  }
  if (isPreparingMonthPayload(frame)) {
    applyTimelinePreparingUi(frame);
    const retryMs = Number(frame?.retry_after_sec) > 0
      ? Number(frame.retry_after_sec) * 1000
      : TIMELINE_PREPARE_DEFAULT_RETRY_MS;
    scheduleFramePrepareRetry(normalizedIdx, retryMs);
    if (String(frame?.status || "") === "preparing_month") {
      scheduleTimelinePrepareRetry(retryMs);
    }
    if (pendingFrameLoad?.idx === normalizedIdx) pendingFrameLoad = null;
    return currentFrame || null;
  }

  if (debugEnabled) {
    dbg("dbgFrame", `OK ${frameUrl}`);
    dbg("dbgFrameKeys", Object.keys(frame || {}).join(", "));
    dbg("dbgPolyCount", frame?.polygons?.features?.length ?? 0);
  }

  await renderFrame(frame);
  clearFramePrepareRetryTimer();
  if (pendingFrameLoad?.idx === normalizedIdx) pendingFrameLoad = null;
  lastRenderedFrameIndex = normalizedIdx;
  for (let delta = 1; delta <= FRAME_PREFETCH_DISTANCE; delta += 1) {
    prefetchFrame(normalizedIdx + delta);
    prefetchFrame(normalizedIdx - delta);
  }
  const frameEndedAt = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  recordPerfMetric("dbgFrameTiming", `${Math.max(0, Math.round(frameEndedAt - frameStartedAt))}ms @ ${normalizedIdx}`);
  runtimePerf?.recordDuration?.("frame_fetch_render", frameEndedAt - frameStartedAt);
  return frame;
}

async function runStartupViewportFrameSequence(idx) {
  const normalizedIdx = Math.max(0, Number(idx) || 0);
  if (startupViewportFrameStarted) return;
  if (!startupInitialCameraLocked) return;
  if (startupInitialFrameIndex !== null && normalizedIdx !== startupInitialFrameIndex) return;
  startupViewportFrameStarted = true;

  const viewportFrame = await fetchViewportFrameData(normalizedIdx);
  const viewportFeatures = viewportFrame?.polygons?.features;
  if (viewportFrame && Array.isArray(viewportFeatures) && viewportFeatures.length > 0) {
    await renderFrame(viewportFrame, { temporaryViewportSubset: true, skipRecommendationUpdate: true });
    startupViewportFrameRendered = true;
    void ensureStartupFullFrameBackfill(normalizedIdx, "startup-viewport-sequence");
    scheduleStartupFullFrameRetry(normalizedIdx, 1200, "startup-retry-1");
    scheduleStartupFullFrameRetry(normalizedIdx, 3200, "startup-retry-2");
    return;
  }
  void ensureStartupFullFrameBackfill(normalizedIdx, "viewport-fetch-failed");
}

function parseMonthKey(text) {
  const value = String(text || "").trim();
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]) };
}

function formatMonthKeyForUi(monthKey) {
  const parsed = parseMonthKey(monthKey);
  if (!parsed) return String(monthKey || "");
  const dt = new Date(Date.UTC(parsed.year, parsed.month - 1, 1));
  const monthName = dt.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  return `${monthName} ${parsed.year}`;
}

function isPreparingMonthPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  const status = String(payload.status || "");
  if (status === "preparing_frame") return true;
  if (status === "preparing_month") {
    return !!(payload.target_month_key || payload.target_month_label);
  }
  return false;
}

function clearTimelinePrepareRetryTimer() {
  if (timelinePrepareRetryTimer) clearTimeout(timelinePrepareRetryTimer);
  timelinePrepareRetryTimer = null;
}

function clearFramePrepareRetryTimer() {
  if (framePrepareRetryTimer) clearTimeout(framePrepareRetryTimer);
  framePrepareRetryTimer = null;
  framePrepareRetryIdx = null;
}

function scheduleTimelinePrepareRetry(delayMs = TIMELINE_PREPARE_DEFAULT_RETRY_MS) {
  if (timelinePrepareRetryTimer) return;
  const retryMs = Math.max(250, Number(delayMs) || TIMELINE_PREPARE_DEFAULT_RETRY_MS);
  timelinePrepareRetryTimer = setTimeout(() => {
    timelinePrepareRetryTimer = null;
    void loadTimeline({ force: true }).catch((err) => {
      console.warn("timeline prepare retry failed:", err);
    });
  }, retryMs);
}

function scheduleFramePrepareRetry(idx, delayMs = TIMELINE_PREPARE_DEFAULT_RETRY_MS) {
  const normalizedIdx = Math.max(0, Number(idx) || 0);
  if (framePrepareRetryTimer && framePrepareRetryIdx === normalizedIdx) return;
  clearFramePrepareRetryTimer();
  const retryMs = Math.max(250, Number(delayMs) || TIMELINE_PREPARE_DEFAULT_RETRY_MS);
  framePrepareRetryIdx = normalizedIdx;
  framePrepareRetryTimer = setTimeout(() => {
    framePrepareRetryTimer = null;
    framePrepareRetryIdx = null;
    void loadFrame(normalizedIdx, { force: true }).catch((err) => {
      console.warn("frame prepare retry failed:", err);
    });
  }, retryMs);
}

function applyTimelinePreparingUi(payload) {
  timelinePreparingState = payload;
  const targetMonthKey = String(payload?.target_month_key || "");
  const label = String(payload?.target_month_label || "").trim() || formatMonthKeyForUi(targetMonthKey);
  const status = String(payload?.status || "");
  if (status === "preparing_frame") {
    if (timeLabel) timeLabel.textContent = `Preparing ${label} frame…`;
    if (recommendEl) recommendEl.textContent = "Monitor • Preparing frame";
    return;
  }
  if (timeLabel) timeLabel.textContent = `Preparing ${label} historical data…`;
  if (recommendEl) recommendEl.textContent = "Monitor • Preparing historical month";
}

function clearTimelinePreparingUi({ clearRetryTimer = false } = {}) {
  timelinePreparingState = null;
  if (clearRetryTimer) clearTimelinePrepareRetryTimer();
}

function timelineMonthMatchesCurrentNYCMonth() {
  const active = parseMonthKey(timelineActiveMonthKey);
  if (!active) return false;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NYC_TIMEZONE,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const year = Number(parts.find((p) => p.type === "year")?.value || NaN);
  const month = Number(parts.find((p) => p.type === "month")?.value || NaN);
  return Number.isFinite(year) && Number.isFinite(month) && month === active.month && year === active.year;
}

async function loadTimeline({ force = false } = {}) {
  const timelineStartedAt = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  const timelineUrl = `${RAILWAY_BASE}/timeline`;
  const cacheFresh = timelineCache.data && (Date.now() - Number(timelineCache.loadedAt || 0) < TIMELINE_CACHE_TTL_MS);
  const canReuseTimeline = !!(!force && cacheFresh && (!timelineActiveMonthKey || timelineMonthMatchesCurrentNYCMonth()));
  if (canReuseTimeline) frontendPerfStats.timelineCacheHits += 1;
  else frontendPerfStats.timelineCacheMisses += 1;
  if (!canReuseTimeline && timelineLoadPromise) return timelineLoadPromise;
  const loadPromise = (async () => {
    if (timelineLoadAbortController) {
      try { timelineLoadAbortController.abort(); } catch (_) {}
    }
    timelineLoadAbortController = new AbortController();
    const payload = canReuseTimeline
      ? timelineCache.data
      : await fetchJSON(timelineUrl, { signal: timelineLoadAbortController.signal, cache: force ? "reload" : undefined });
    if (isPreparingMonthPayload(payload)) {
      applyTimelinePreparingUi(payload);
      const retryMs = Number(payload?.retry_after_sec) > 0
        ? Number(payload.retry_after_sec) * 1000
        : TIMELINE_PREPARE_DEFAULT_RETRY_MS;
      scheduleTimelinePrepareRetry(retryMs);
      return null;
    }

    clearTimelinePreparingUi({ clearRetryTimer: true });
    timelineCache.data = payload;
    timelineCache.loadedAt = Date.now();
    timelineActiveMonthKey = String(payload?.active_month_key || "");
    timelineAvailableMonthKeys = Array.isArray(payload?.available_month_keys) ? payload.available_month_keys : [];
    timelineScope = String(payload?.timeline_scope || "");
    timeline = Array.isArray(payload) ? payload : payload.timeline || [];
    if (!timeline.length) throw new Error("Timeline is temporarily unavailable. Retrying shortly.");

    if (debugEnabled) dbg("dbgTimeline", `OK ${timelineUrl} count=${timeline.length}`);

    try {
      timeline.map(minuteOfWeekFromIso);
    } catch (err) {
      let firstBadTimelineEntry = null;
      for (const entry of timeline) {
        try {
          minuteOfWeekFromIso(entry);
        } catch (_) {
          firstBadTimelineEntry = entry;
          break;
        }
      }
      console.error(
        "[timeline] Failed to parse timeline entry for minute-of-week calculation.",
        { firstBadTimelineEntry, totalEntries: timeline.length },
        err
      );
      throw new Error(
        `[timeline] Invalid timeline timestamp entry: "${firstBadTimelineEntry ?? "unknown"}"`,
        { cause: err }
      );
    }

    timelineEpochMs = timeline.map(timelineIsoToEpochMs);
    timelineCalendarMeta = buildTimelineCalendarMeta(timeline, timelineEpochMs);

    slider.min = "0";
    slider.max = String(timeline.length - 1);
    slider.step = "1";

    const target = getNowNYCFrameTarget();
    const idx = chooseBestCalendarMatchedTimelineIndex(timelineCalendarMeta, target);
    slider.value = String(idx);
    startupInitialFrameIndex = idx;

    bubbleUpdateNow();
    if (startupInitialCameraLocked) {
      void runStartupViewportFrameSequence(idx);
    }
    const timelineEndedAt = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    recordPerfMetric("dbgTimelineTiming", `${Math.max(0, Math.round(timelineEndedAt - timelineStartedAt))}ms`);
    runtimePerf?.recordDuration?.("timeline_fetch", timelineEndedAt - timelineStartedAt);
    return timeline;
  })();
  timelineLoadPromise = loadPromise.finally(() => {
    timelineLoadPromise = null;
    timelineLoadAbortController = null;
  });
  return timelineLoadPromise;
}

let sliderDebounce = null;

slider?.addEventListener("pointerdown", bubbleUpdateNow);
slider?.addEventListener("touchstart", bubbleUpdateNow, { passive: true });

slider?.addEventListener("input", () => {
  lastUserSliderTs = Date.now();
  bubbleUpdateNow();

  const idx = Number(slider.value);
  if (sliderDebounce) clearTimeout(sliderDebounce);
  sliderDebounce = setTimeout(() => loadFrame(idx).catch(console.error), 80);
});

window.addEventListener("resize", () => {
  if (timeline.length) setSliderBubbleTextAndPos();
  enforceSaveButtonTheme();
});
window.addEventListener("team-joseo-startup-camera-locked", () => {
  if (startupInitialFrameIndex === null || startupViewportFrameStarted) return;
  void runStartupViewportFrameSequence(startupInitialFrameIndex);
});
window.addEventListener("orientationchange", () => enforceSaveButtonTheme());

/* =========================================================
   Auto-center
   ========================================================= */
const btnCenter = document.getElementById("btnCenter");
let autoCenter = true;
let inactivityTimer = null;
const AUTO_FOCUS_INACTIVITY_MS = 20000;
const AUTO_FOCUS_RETURN_ZOOM = 13.0;
const AUTO_FOCUS_ZOOM_GRACE_MS = 9000;
let autoFocusZoomUntil = 0;

function cancelAutoFocusInactivityTimer() {
  if (inactivityTimer) clearTimeout(inactivityTimer);
  inactivityTimer = null;
}

function scheduleAutoFocusFromInactivity() {
  cancelAutoFocusInactivityTimer();
  inactivityTimer = setTimeout(() => {
    inactivityTimer = null;
    handleAutoFocusInactivityTimeout();
  }, AUTO_FOCUS_INACTIVITY_MS);
}

function markUserActivity() {
  // Ignore movement/zoom/rotate events caused by our own map animations.
  if (Date.now() < suppressAutoDisableUntil) return;
  scheduleAutoFocusFromInactivity();
  notePresenceBoost();
}

function armAutoFocusZoomWindow(ms = AUTO_FOCUS_ZOOM_GRACE_MS) {
  autoFocusZoomUntil = Math.max(autoFocusZoomUntil, Date.now() + Math.max(0, Number(ms) || 0));
}

function clearAutoFocusZoomWindow() {
  autoFocusZoomUntil = 0;
}

function isAutoFocusZoomWindowActive(now = Date.now()) {
  return now < autoFocusZoomUntil;
}

function getSelfCenterLngLat() {
  if (navMarker && typeof navMarker.getLngLat === "function") {
    const p = navMarker.getLngLat();
    if (p && Number.isFinite(p.lng) && Number.isFinite(p.lat)) return { lng: p.lng, lat: p.lat };
  }
  if (userLatLng && Number.isFinite(userLatLng.lng) && Number.isFinite(userLatLng.lat)) {
    return { lng: userLatLng.lng, lat: userLatLng.lat };
  }
  return null;
}

let suppressAutoDisableUntil = 0;
function suppressAutoDisableFor(ms, fn) {
  suppressAutoDisableUntil = Date.now() + ms;
  fn();
}

const AUTO_ZOOM_MIN = 11.0;
const AUTO_ZOOM_MAX = 14.0;
const AUTO_FIT_PADDING = 70;
let lastAutoFitMs = 0;

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function getAutoFollowZoom({ forceZoom = false } = {}) {
  const currentZoom = Number(map?.getZoom?.());
  const baseZoom = Number.isFinite(currentZoom) ? currentZoom : AUTO_FOCUS_RETURN_ZOOM;
  if (forceZoom || isAutoFocusZoomWindowActive()) {
    return Math.max(baseZoom, AUTO_FOCUS_RETURN_ZOOM);
  }
  return baseZoom;
}

function autoCenterAndAutoZoom() {
  if (!map || !userLatLng) return;

  // If autoCenter is disabled, do nothing.  Without this check the map may
  // keep snapping back to the user's location and appear to “shake.”
  if (!autoCenter) return;

  const now = Date.now();
  if (now - lastAutoFitMs < 2500) return;
  lastAutoFitMs = now;

  const pts = [];
  pts.push([userLatLng.lng, userLatLng.lat]);

  for (const mk of otherMarkers.values()) {
    try {
      const ll = mk.getLngLat();
      if (ll && Number.isFinite(ll.lng) && Number.isFinite(ll.lat)) {
        pts.push([ll.lng, ll.lat]);
      }
    } catch {}
  }

  // When there is only one point to follow, compute the difference to the current
  // map center and only fly if the change is significant (~0.0002 degrees).
  if (pts.length <= 1) {
    const z = clamp(getAutoFollowZoom(), AUTO_ZOOM_MIN, AUTO_ZOOM_MAX);
    const curr = map.getCenter();
    const dx = pts[0][0] - curr.lng;
    const dy = pts[0][1] - curr.lat;
    const threshold = 0.0002;
    if (Math.abs(dx) > threshold || Math.abs(dy) > threshold) {
      suppressAutoDisableFor(700, () =>
        map.flyTo({ center: pts[0], zoom: z, duration: 600 })
      );
    }
    return;
  }

  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of pts) {
    minLng = Math.min(minLng, lng);
    minLat = Math.min(minLat, lat);
    maxLng = Math.max(maxLng, lng);
    maxLat = Math.max(maxLat, lat);
  }

  suppressAutoDisableFor(900, () => {
    map.fitBounds(
      [
        [minLng, minLat],
        [maxLng, maxLat],
      ],
      {
        padding: AUTO_FIT_PADDING,
        duration: 650,
        maxZoom: AUTO_ZOOM_MAX,
      }
    );

    setTimeout(() => {
      const zNow = map.getZoom();
      const zClamped = clamp(zNow, AUTO_ZOOM_MIN, AUTO_ZOOM_MAX);
      if (Math.abs(zNow - zClamped) > 0.01) {
        map.setZoom(zClamped);
      }
    }, 720);
  });
}

function syncCenterButton() {
  if (!btnCenter) return;
  btnCenter.classList.toggle("on", !!autoCenter);
}

function refreshAutoCenterCamera({ forceZoom = false } = {}) {
  if (!map || !autoCenter) return;
  const c = getSelfCenterLngLat();
  if (!c) return;
  if (forceZoom) armAutoFocusZoomWindow();
  const targetZoom = getAutoFollowZoom({ forceZoom });

  suppressAutoDisableFor(900, () => {
    map.flyTo({
      center: [c.lng, c.lat],
      zoom: Number.isFinite(targetZoom) ? targetZoom : AUTO_FOCUS_RETURN_ZOOM,
      bearing: Number.isFinite(lastHeadingDeg) ? normDeg(lastHeadingDeg) : map.getBearing(),
      duration: 650,
      essential: true,
    });
  });
}

function setAutoCenterEnabled(next, reason = "manual") {
  const enabled = !!next;
  const changed = autoCenter !== enabled;
  autoCenter = enabled;
  syncCenterButton();

  if (!autoCenter && map && mapReady) {
    clearAutoFocusZoomWindow();
    const b = map.getBearing ? map.getBearing() : 0;
    lastMapBearingDeg = normDeg(b);
  }

  if (autoCenter && (changed || reason === "inactive-timeout")) {
    const shouldForceZoom = changed || reason === "inactive-timeout";
    if (shouldForceZoom) armAutoFocusZoomWindow();
    refreshAutoCenterCamera({ forceZoom: shouldForceZoom });
  }
  if (changed && authHeaderOK()) {
    schedulePresencePoll({ immediate: true });
  }
  return changed;
}

function handleAutoFocusInactivityTimeout() {
  if (!map || !mapReady) return;
  if (!getSelfCenterLngLat()) return;
  if (autoCenter) {
    refreshAutoCenterCamera({ forceZoom: true });
    return;
  }
  setAutoCenterEnabled(true, "inactive-timeout");
}

syncCenterButton();

if (btnCenter) {
  btnCenter.addEventListener("pointerdown", (e) => e.stopPropagation());
  btnCenter.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });

  btnCenter.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    markUserActivity();
    setAutoCenterEnabled(!autoCenter, "manual");
  });
}

function disableAutoCenterBecauseUserIsExploring() {
  if (Date.now() < suppressAutoDisableUntil) return;
  if (!autoCenter) return;
  setAutoCenterEnabled(false, "manual");
  markUserActivity();
}

/* =========================================================
   Live location arrow + follow behavior
   ========================================================= */
let gpsFirstFixDone = false;
let navMarker = null;
let lastPos = null;
let lastHeadingDeg = 0;
let lastMoveTs = 0;
let lastSelfOrbitMeta = null;

function makeNavIcon() {
  const myName = authHeaderOK() ? me?.display_name || "" : "";
  const resolvedAvatarUrl = window.safeMapAvatarUrl?.(me?.avatar_thumb_url || me?.avatar_url || '') || '';
  const navLabelHTML = (typeof window !== "undefined" && typeof window.mapIdentityRenderSelfLabel === "function")
    ? window.mapIdentityRenderSelfLabel({
      name: myName,
      avatarUrl: me?.avatar_thumb_url || me?.avatar_url,
      mode: me?.map_identity_mode,
      zoom: map?.getZoom?.(),
      leaderboardBadgeCode: me?.leaderboard_badge_code,
      leaderboardHasCrown: !!me?.leaderboard_has_crown,
      orbitMeta: lastSelfOrbitMeta
    })
    : `
      <div id="navMeName" class="mapPresenceRoot selfIdentitySlot" data-map-presence-placeholder="1">
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
        <div id="navPresenceDirectionRot" class="mapPresenceDirectionRot"><div class="mapPresenceDirectionTip"></div></div>
      </div>`;

  const el = document.createElement("div");
  // ISSUE NOTE:
  // Keep avatar markers photo-only for now.
  // The legacy pulse ring used to sit behind the avatar and leak through on zoom-out.
  el.innerHTML = `
    <div id="navWrap" class="mapPresenceHost">
      ${navLabelHTML}
    </div>
  `;
  return el;
}

function setPresenceDirection(rootEl, headingDeg, isSelf = false) {
  if (!rootEl) return;
  const directionEl = isSelf
    ? rootEl.querySelector('#navPresenceDirectionRot')
    : rootEl.querySelector('.mapPresenceDirectionRot');
  if (!directionEl) return;
  let relative = Number.isFinite(headingDeg) ? headingDeg : 0;
  if (isSelf && map && typeof map.getBearing === 'function') {
    const bearing = Number(map.getBearing()) || 0;
    relative = normDeg(relative - bearing);
  }
  directionEl.style.transform = `rotate(${relative}deg)`;
}

function wireProfileOpenTargets(rootEl, userId, options = {}) {
  if (!rootEl || !userId) return;
  const normalizedUserId = Number(userId);
  if (!Number.isFinite(normalizedUserId)) return;
  const isSelf = !!options?.isSelf;
  const selectorList = isSelf
    ? ["#navWrap", ".selfIdentitySlot", ".mapPresenceOrbit", ".mapPresenceRoot", ".mapPresenceShell", ".mapPresenceAvatar", ".mapPresenceInitials", ".mapPresenceDirectionRot", ".mapPresenceDirectionTip", ".mapPresenceBadgeOverlay"]
    : [".otherDrvWrap", ".otherDrvIdentitySlot", ".mapPresenceOrbit", ".mapPresenceRoot", ".mapPresenceShell", ".mapPresenceAvatar", ".mapPresenceInitials", ".mapPresenceDirectionRot", ".mapPresenceDirectionTip", ".mapPresenceBadgeOverlay"];
  const clickHandler = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (isSelf) {
      window.openDriverProfileModal?.({ userId: normalizedUserId, isSelf: true, source: "self-marker" });
      return;
    }
    presenceFocusedUserId = normalizedUserId;
    scheduleAdaptivePresenceRender();
    window.openDriverProfileModal?.({ userId: normalizedUserId, isSelf: false, source: "driver-marker" });
  };
  const targets = new Set([rootEl]);
  selectorList.forEach((selector) => {
    rootEl.querySelectorAll(selector).forEach((el) => targets.add(el));
  });
  targets.forEach((el) => {
    if (!el) return;
    const wiredFlag = isSelf ? 'selfProfileWired' : 'driverProfileWired';
    const wiredUserFlag = isSelf ? 'selfProfileUserId' : 'driverProfileUserId';
    const userIdText = String(normalizedUserId);
    if (el.dataset[wiredFlag] === '1' && el.dataset[wiredUserFlag] === userIdText) return;
    el.dataset[wiredFlag] = '1';
    el.dataset[wiredUserFlag] = userIdText;
    el.style.pointerEvents = 'auto';
    el.style.cursor = 'pointer';
    el.style.touchAction = 'manipulation';
    el.addEventListener('click', clickHandler);
  });
}

function refreshNavNameLabel() {
  const myName = authHeaderOK() ? me?.display_name || "" : "";
  const wrap = document.getElementById("navWrap");
  if (wrap && typeof window !== "undefined" && typeof window.mapIdentityRenderSelfLabel === "function") {
    wrap.innerHTML = window.mapIdentityRenderSelfLabel({
      name: myName,
      avatarUrl: me?.avatar_thumb_url || me?.avatar_url,
      mode: me?.map_identity_mode,
      zoom: map?.getZoom?.(),
      leaderboardBadgeCode: me?.leaderboard_badge_code,
      leaderboardHasCrown: !!me?.leaderboard_has_crown,
      orbitMeta: lastSelfOrbitMeta
    });
  } else {
    const el = document.getElementById("navMeName");
    if (!el) return;
    const avatarEl = el.querySelector('.mapPresenceAvatar');
    if (avatarEl && avatarEl.tagName === 'IMG') {
      const nextAvatar = window.safeMapAvatarUrl?.(me?.avatar_thumb_url || me?.avatar_url || '') || '';
      if (nextAvatar) {
        avatarEl.src = nextAvatar;
      }
    }
  }
  const navWrap = document.getElementById("navWrap");
  if (navWrap) wireProfileOpenTargets(navWrap, me?.id, { isSelf: true });
  applyDriverLabelZoomStyles();
  if (typeof window !== "undefined" && typeof window.mapIdentityApplySelfOrbit === "function") {
    window.mapIdentityApplySelfOrbit(lastSelfOrbitMeta);
  }
  setNavRotation(lastHeadingDeg);
}

function setNavVisual(isMoving) {
  const el = document.getElementById("navWrap");
  if (!el) return;
  // ISSUE NOTE:
  // Disable the legacy moving/pulse marker visuals for now.
  // They were part of the old arrow marker stack and caused visible drift/leakage
  // behind avatar photos when zooming out.
  el.classList.remove("navMoving");
  el.classList.remove("navPulse");
  el.dataset.moving = isMoving ? "1" : "0";
}
function setNavRotation(deg) {
  const navWrap = document.getElementById("navWrap");
  setPresenceDirection(navWrap, deg, true);
}
function normDeg(d) {
  return ((d % 360) + 360) % 360;
}
function shortestAngleDelta(a, b) {
  let d = normDeg(b) - normDeg(a);
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}
function blendAngleDeg(from, to, alpha = HEADING_SMOOTHING) {
  if (!Number.isFinite(from)) return normDeg(to);
  const a = clamp(alpha, 0, 1);
  return normDeg(from + shortestAngleDelta(from, to) * a);
}
function getCurrentTendencyLatLng() {
  if (userLatLng && Number.isFinite(userLatLng.lat) && Number.isFinite(userLatLng.lng)) {
    return { lat: userLatLng.lat, lng: userLatLng.lng };
  }
  return null;
}
window.getCurrentTendencyLatLng = getCurrentTendencyLatLng;

function getSelfMapCenter() {
  if (navMarker && typeof navMarker.getLngLat === "function") {
    const p = navMarker.getLngLat();
    if (p && Number.isFinite(p.lng) && Number.isFinite(p.lat)) return { lng: p.lng, lat: p.lat };
  }
  if (userLatLng && Number.isFinite(userLatLng.lng) && Number.isFinite(userLatLng.lat)) {
    return { lng: userLatLng.lng, lat: userLatLng.lat };
  }
  if (map && typeof map.getCenter === "function") {
    const p = map.getCenter();
    if (p && Number.isFinite(p.lng) && Number.isFinite(p.lat)) return { lng: p.lng, lat: p.lat };
  }
  return null;
}
function maybeRotateMapTo(deg) {
  if (!ROTATE_ENABLED) return;
  if (!map || !mapReady) return;
  if (!autoCenter) return;

  const now = Date.now();
  if (now - lastRotateTs < ROTATE_RATE_LIMIT_MS) return;

  const target = normDeg(deg);
  const delta = shortestAngleDelta(lastMapBearingDeg, target);
  if (Math.abs(delta) < ROTATE_MIN_DELTA_DEG) return;

  const c = getSelfMapCenter();
  if (!c) return;

  lastRotateTs = now;
  lastMapBearingDeg = target;

  suppressAutoDisableFor(ROTATE_ANIM_MS + 120, () => {
    map.easeTo({
      center: [c.lng, c.lat],
      zoom: getAutoFollowZoom(),
      bearing: target,
      duration: ROTATE_ANIM_MS,
      essential: true,
    });
  });
}
let lastCompassHeadingDeg = null;
let lastCompassTs = 0;
let deviceOrientationWatching = false;
let deviceOrientationArmDone = false;
let lastHeadingSource = "none";
let lastHeadingTs = 0;
function getFreshCompassHeading(now = Date.now()) {
  return Number.isFinite(lastCompassHeadingDeg) && (now - lastCompassTs) <= HEADING_COMPASS_STALE_MS
    ? normDeg(lastCompassHeadingDeg)
    : null;
}
function applyHeadingDeg(nextDeg, { source = "gps", ts = Date.now(), smooth = true, rotateMap = false, alpha = HEADING_SMOOTHING } = {}) {
  if (!Number.isFinite(nextDeg)) return lastHeadingDeg;
  const prevDeg = Number.isFinite(lastHeadingDeg) ? normDeg(lastHeadingDeg) : normDeg(nextDeg);
  const target = normDeg(nextDeg);
  const smoothedDeg = smooth ? blendAngleDeg(prevDeg, target, alpha) : target;

  const deadband = source === "compass"
    ? HEADING_NOISE_DEADBAND_DEG
    : source === "derived"
      ? HEADING_NOISE_DEADBAND_DEG * 0.9
      : HEADING_NOISE_DEADBAND_DEG * 0.8;
  const delta = shortestAngleDelta(prevDeg, smoothedDeg);

  let finalDeg = smoothedDeg;
  if (Math.abs(delta) < deadband) {
    finalDeg = prevDeg;
  } else if (Math.abs(delta) < HEADING_BIG_TURN_DEG) {
    finalDeg = normDeg(prevDeg + delta * 0.82);
  }

  lastHeadingDeg = finalDeg;
  lastHeadingSource = source;
  lastHeadingTs = ts;
  setNavRotation(finalDeg);
  if (rotateMap) maybeRotateMapTo(finalDeg);
  return finalDeg;
}
function getScreenAngleDeg() {
  const raw = Number(window.screen?.orientation?.angle ?? window.orientation ?? 0);
  return Number.isFinite(raw) ? raw : 0;
}
function extractCompassHeadingDeg(evt) {
  if (!evt) return null;
  if (typeof evt.webkitCompassHeading === "number" && Number.isFinite(evt.webkitCompassHeading)) {
    return normDeg(evt.webkitCompassHeading);
  }
  const alpha = Number(evt.alpha);
  if (!Number.isFinite(alpha)) return null;
  return normDeg((360 - alpha) + getScreenAngleDeg());
}
function handleDeviceOrientation(evt) {
  const heading = extractCompassHeadingDeg(evt);
  if (!Number.isFinite(heading)) return;
  const ts = Date.now();
  lastCompassHeadingDeg = heading;
  lastCompassTs = ts;
  const recentlyMoved = !!lastMoveTs && (ts - lastMoveTs) < 3500;
  applyHeadingDeg(heading, {
    source: "compass",
    ts,
    smooth: true,
    rotateMap: autoCenter,
    alpha: recentlyMoved ? 0.22 : 0.38,
  });
}
function startDeviceOrientationWatch() {
  if (deviceOrientationWatching || typeof window === "undefined") return;
  deviceOrientationWatching = true;
  window.addEventListener("deviceorientationabsolute", handleDeviceOrientation, true);
  window.addEventListener("deviceorientation", handleDeviceOrientation, true);
}
async function requestDeviceOrientationAccess() {
  try {
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      const result = await DeviceOrientationEvent.requestPermission();
      if (result !== "granted") return false;
    }
    startDeviceOrientationWatch();
    return true;
  } catch (e) {
    console.warn("Device orientation permission failed:", e);
    return false;
  }
}
function armDeviceOrientationAccess() {
  if (deviceOrientationArmDone || typeof document === "undefined") return;
  deviceOrientationArmDone = true;

  const unlock = () => {
    requestDeviceOrientationAccess().catch((e) => console.warn("Device orientation start failed:", e));
    document.removeEventListener("pointerup", unlock, true);
    document.removeEventListener("touchend", unlock, true);
    document.removeEventListener("click", unlock, true);
  };

  document.addEventListener("pointerup", unlock, true);
  document.addEventListener("touchend", unlock, true);
  document.addEventListener("click", unlock, true);
}
function computeBearingDeg(from, to) {
  const toRad = (x) => (x * Math.PI) / 180;
  const toDeg = (x) => (x * 180) / Math.PI;

  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const dLng = toRad(to.lng - from.lng);

  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

  let brng = toDeg(Math.atan2(y, x));
  brng = (brng + 360) % 360;
  return brng;
}

function startLocationWatch() {
  if (!("geolocation" in navigator)) {
    if (recommendEl) recommendEl.textContent = "Recommended: location not supported";
    return;
  }
  if (!map) return;

  if (!navMarker) {
    const navEl = makeNavIcon();
    wireProfileOpenTargets(navEl, me?.id, { isSelf: true });
    navMarker = new maplibregl.Marker({
      element: navEl,
      anchor: "center",
      offset: [0, 0],
    })
      .setLngLat([-74.006, 40.7128])
      .addTo(map);
    navMarker.getElement().style.zIndex = "2000";
  }

  requestDeviceOrientationAccess().catch(() => {});
  armDeviceOrientationAccess();

  navigator.geolocation.watchPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const heading = pos.coords.heading;
      const accuracy = pos.coords.accuracy;
      const speedMps = pos.coords.speed;
      const ts = pos.timestamp || Date.now();

      lastGpsAccuracyM = typeof accuracy === "number" && Number.isFinite(accuracy) ? accuracy : null;
      routeableNavLatLng = { lat, lng };
      window.TlcNavigationPreviewModule?.refreshPreviewFromUserLocation?.();

      // Ignore noisy fixes after the initial lock. Otherwise a brief accuracy
      // spike (e.g. 120-300m) can make the marker/presence jump and then snap
      // back, which looks like the map is "confused".
      if (Number.isFinite(accuracy) && accuracy > PRESENCE_ACCURACY_THRESHOLD) {
        setNavVisual(false);
        return;
      }

      userLatLng = { lat, lng };

      const hasUsableAccuracy = !Number.isFinite(accuracy) || accuracy <= GPS_ACCURACY_THRESHOLD || !gpsFirstFixDone;
      if (!hasUsableAccuracy) {
        setNavVisual(false);
        communityMaybePushPresence(ts, Number.isFinite(lastHeadingDeg) ? lastHeadingDeg : heading, lastGpsAccuracyM);
        return;
      }

      window.dispatchEvent(new CustomEvent("tlc-user-location-updated", {
        detail: {
          lat,
          lng,
          ts: ts || Date.now(),
          heading: Number.isFinite(lastHeadingDeg) ? lastHeadingDeg : (Number.isFinite(heading) ? heading : null),
          accuracy: Number.isFinite(accuracy) ? accuracy : null,
        }
      }));

      if (navMarker) navMarker.setLngLat([lng, lat]);
      if (authHeaderOK()) scheduleAdaptivePresenceRender();

      if (!debugOnce.selfMarker) {
        console.log("DEBUG self marker lngLat", { lng, lat });
        debugOnce.selfMarker = true;
      }

      let isMoving = false;
      let headingCandidate = null;
      let headingSource = "stale";
      const freshCompass = getFreshCompassHeading(ts);

      if (lastPos) {
        const dMi = haversineMiles({ lat: lastPos.lat, lng: lastPos.lng }, userLatLng);
        const dtSec = Math.max(1, (ts - lastPos.ts) / 1000);
        const mph = (dMi / dtSec) * 3600;
        const hasGoodAccuracy = Number.isFinite(accuracy) && accuracy < GPS_ACCURACY_THRESHOLD;
        const speedValid = Number.isFinite(speedMps) && speedMps >= HEADING_MIN_SPEED_MPS;
        const movedEnough = dMi >= HEADING_DERIVE_MIN_MILES;

        isMoving = (mph >= ROTATE_MIN_MPH || speedValid || movedEnough) && hasGoodAccuracy;

        if (Number.isFinite(heading) && (speedValid || mph >= ROTATE_MIN_MPH || hasGoodAccuracy)) {
          headingCandidate = heading;
          headingSource = "gps";
        } else if (movedEnough && hasGoodAccuracy) {
          headingCandidate = computeBearingDeg({ lat: lastPos.lat, lng: lastPos.lng }, userLatLng);
          headingSource = "derived";
        } else if (Number.isFinite(freshCompass)) {
          headingCandidate = freshCompass;
          headingSource = "compass";
        }

        if (isMoving || movedEnough) lastMoveTs = ts;
      } else if (Number.isFinite(freshCompass)) {
        headingCandidate = freshCompass;
        headingSource = "compass";
      }

      lastPos = { lat, lng, ts };

      if (Number.isFinite(headingCandidate)) {
        applyHeadingDeg(headingCandidate, {
          source: headingSource,
          ts,
          smooth: gpsFirstFixDone,
          rotateMap: false,
          alpha: headingSource === "gps" ? 0.58 : headingSource === "derived" ? 0.46 : 0.30,
        });
      } else if (Number.isFinite(lastHeadingDeg)) {
        setNavRotation(lastHeadingDeg);
      }

      setNavVisual(isMoving);

      const targetBearing = Number.isFinite(lastHeadingDeg)
        ? normDeg(lastHeadingDeg)
        : (Number.isFinite(freshCompass) ? normDeg(freshCompass) : map.getBearing());

      if (!gpsFirstFixDone) {
        startupLocationPermissionResolved = true;
        startupFirstGoodGpsFix = true;
        startupGpsPriorityResolved = true;
        startupInitialCameraLocked = true;
        startupLocalZoomDone = true;
        startupVisualFallbackApplied = false;
        startupLocationTerminalFailure = false;
        startupCameraLockReason = "first-good-gps-fix";
        emitStartupCameraLocked("first-good-gps-fix");
        if (startupGpsPriorityTimer) {
          clearTimeout(startupGpsPriorityTimer);
          startupGpsPriorityTimer = null;
        }
        gpsFirstFixDone = true;
        suppressAutoDisableFor(1200, () => map.jumpTo({
          center: [lng, lat],
          zoom: STARTUP_INITIAL_USER_ZOOM,
          bearing: targetBearing,
        }));
        maybeResolveStartupLoading("first-good-gps-fix");
        lastMapBearingDeg = targetBearing;
        lastRotateTs = Date.now();
      } else if (autoCenter && map) {
        const c = getSelfMapCenter() || { lng, lat };
        // Compare against the current map center. Only recenter if the
        // difference exceeds ~0.0002 degrees (~15 m at NYC latitude).
        const curr = map.getCenter();
        const dx = c.lng - curr.lng;
        const dy = c.lat - curr.lat;
        const threshold = 0.0002;
        const nowTs = Date.now();
        const movedEnough = Math.abs(dx) > threshold || Math.abs(dy) > threshold;
        // Do not recenter more often than once every second.
        if (movedEnough && nowTs - lastAutoCenterTs > 1000) {
          lastAutoCenterTs = nowTs;
          const targetZoom = getAutoFollowZoom();
          suppressAutoDisableFor(700, () => map.easeTo({
            center: [c.lng, c.lat],
            zoom: targetZoom,
            bearing: targetBearing,
            duration: 320,
            essential: true,
          }));
        }
        lastMapBearingDeg = targetBearing;
        lastRotateTs = Date.now();
      }

      if (currentFrame) updateRecommendation(currentFrame);

      scheduleWeatherUpdateSoon();

      // community push (auth only)
      communityMaybePushPresence(ts, Number.isFinite(lastHeadingDeg) ? lastHeadingDeg : heading, lastGpsAccuracyM);
    },
    (err) => {
      console.warn("Geolocation error:", err);
      if (recommendEl) recommendEl.textContent = "Recommended: location blocked (enable it)";
      setNavDestination(null);
      if (startupFirstGoodGpsFix) return;
      const deniedCode = (typeof err?.PERMISSION_DENIED === "number") ? err.PERMISSION_DENIED : 1;
      const unavailableCode = (typeof err?.POSITION_UNAVAILABLE === "number") ? err.POSITION_UNAVAILABLE : 2;
      const timeoutCode = (typeof err?.TIMEOUT === "number") ? err.TIMEOUT : 3;
      const code = Number(err?.code);
      let reason = "gps-error-fallback";
      if (code === deniedCode) reason = "gps-permission-denied";
      else if (code === unavailableCode) reason = "gps-position-unavailable";
      else if (code === timeoutCode) reason = "gps-watch-timeout";
      resolveStartupLocationFailure(reason);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 15000,
    }
  );

  setInterval(() => {
    const now = Date.now();
    const recentlyMoved = lastMoveTs && now - lastMoveTs < 5000;
    setNavVisual(!!recentlyMoved);
  }, 1200);
}

/* =========================================================
   AUTO-UPDATE
   ========================================================= */
async function refreshCurrentFrame() {
  try {
    if (document.hidden) return;
    const idx = Number(slider.value || "0");
    await loadFrame(idx);
  } catch (e) {
    console.warn("Auto-refresh failed:", e);
  }
}
if (runtimePolling) runtimePolling.setInterval("app:frame-refresh", refreshCurrentFrame, REFRESH_MS);
else setInterval(refreshCurrentFrame, REFRESH_MS);

async function tickNYCClockAndAdvanceIfNeeded() {
  try {
    if (document.hidden) return;
    if (Date.now() - lastUserSliderTs < USER_SLIDER_GRACE_MS) return;
    if (timelinePreparingState) return;
    if (!timeline.length || !timelineEpochMs.length) return;
    if (!timelineMonthMatchesCurrentNYCMonth()) {
      await loadTimeline({ force: true });
      return;
    }

    const target = getNowNYCFrameTarget();
    const bestIdx = chooseBestCalendarMatchedTimelineIndex(timelineCalendarMeta, target);

    const curIdx = Number(slider.value || "0");
    if (bestIdx === curIdx) return;

    slider.value = String(bestIdx);
    bubbleUpdateNow();
    await loadFrame(bestIdx);
  } catch (e) {
    console.warn("NYC clock tick failed:", e);
  }
}
if (runtimePolling) runtimePolling.setInterval("app:nyc-clock", tickNYCClockAndAdvanceIfNeeded, NYC_CLOCK_TICK_MS);
else setInterval(tickNYCClockAndAdvanceIfNeeded, NYC_CLOCK_TICK_MS);

window.getTimelineSelectionDebug = function getTimelineSelectionDebug() {
  const target = getNowNYCFrameTarget();
  const idx = chooseBestCalendarMatchedTimelineIndex(timelineCalendarMeta, target);
  const selected = timelineCalendarMeta[idx] || null;
  return {
    target,
    selected,
    selectedIso: selected?.iso || null,
    selectedIdx: idx,
    timelineLength: timelineCalendarMeta.length,
  };
};

document.addEventListener("visibilitychange", () => {
  mapPageIsVisible = !document.hidden;
  if (document.visibilityState === "visible") {
    if (timelinePreparingState || !timelineMonthMatchesCurrentNYCMonth()) {
      void loadTimeline({ force: true }).catch(() => {});
    }
    refreshCurrentFrame().catch(() => {});
    tickNYCClockAndAdvanceIfNeeded().catch(() => {});
    updateWeatherNow().catch(() => {});
    notePresenceBoost();
    schedulePresencePoll({ immediate: true });
    if (timeline.length) bubbleUpdateNow();
  } else {
    clearPickupPollTimer();
    schedulePresencePoll();
  }
});

/* =========================================================
   MOVED TO app.part9.js
   Recommendation + Weather + Online badge module
   Search there for:
   - updateOnlineBadge
   - applyBadgeIconModel
   - scheduleWeatherUpdateSoon
   - updateWeatherNow
   - getWeatherState
   ========================================================= */
function updateOnlineBadge(...args) { return window.TlcMapUiModule?.updateOnlineBadge?.(...args); }
function applyBadgeIconModel(...args) { return window.TlcMapUiModule?.applyBadgeIconModel?.(...args); }
function scheduleWeatherUpdateSoon(...args) { return window.TlcMapUiModule?.scheduleWeatherUpdateSoon?.(...args); }
async function updateWeatherNow(...args) { return await (window.TlcMapUiModule?.updateWeatherNow?.(...args) || Promise.resolve()); }

function setBodyTheme({ isNight, isSunny }) {
  document.body.classList.toggle("night", !!isNight);
  document.body.classList.toggle("sunny", !!isSunny && !isNight);
  applyNightBasemap(!!isNight);
  enforceSaveButtonTheme();
}

function applyNightBasemap(isNight) {
  if (!map) return;
  try {
    map.setPaintProperty("carto-base", "raster-brightness-max", isNight ? 0.55 : 1.0);
    map.setPaintProperty("carto-base", "raster-brightness-min", isNight ? 0.12 : 0.0);
    map.setPaintProperty("carto-base", "raster-contrast", isNight ? 0.25 : 0.0);
    map.setPaintProperty("carto-base", "raster-saturation", isNight ? -0.25 : 0.0);
  } catch (e) {
    console.warn("applyNightBasemap failed:", e);
  }
}
setInterval(() => {
  const {
    presencePollsAttempted,
    presencePollsCompleted,
    presencePollsAborted,
    pickupFetchesAttempted,
    pickupFetchesCompleted,
    pickupFetchesAborted,
    abortedRequests,
    frameCacheHits,
    frameCacheMisses,
    timelineCacheHits,
    timelineCacheMisses,
    avatarCacheHits,
    avatarCacheMisses,
  } = frontendPerfStats;
  if (!presencePollsAttempted && !pickupFetchesAttempted && !abortedRequests && !frameCacheHits && !frameCacheMisses && !timelineCacheHits && !timelineCacheMisses && !avatarCacheHits && !avatarCacheMisses) return;
  console.log(
    `[perf] presence=${presencePollsCompleted}/${presencePollsAttempted} presenceAborted=${presencePollsAborted} pickup=${pickupFetchesCompleted}/${pickupFetchesAttempted} pickupAborted=${pickupFetchesAborted} aborted=${abortedRequests} frameCache=${frameCacheHits}/${frameCacheMisses} timelineCache=${timelineCacheHits}/${timelineCacheMisses} avatarCache=${avatarCacheHits}/${avatarCacheMisses}`
  );
  frontendPerfStats.presencePollsAttempted = 0;
  frontendPerfStats.presencePollsCompleted = 0;
  frontendPerfStats.presencePollsAborted = 0;
  frontendPerfStats.pickupFetchesAttempted = 0;
  frontendPerfStats.pickupFetchesCompleted = 0;
  frontendPerfStats.pickupFetchesAborted = 0;
  frontendPerfStats.abortedRequests = 0;
  frontendPerfStats.frameCacheHits = 0;
  frontendPerfStats.frameCacheMisses = 0;
  frontendPerfStats.timelineCacheHits = 0;
  frontendPerfStats.timelineCacheMisses = 0;
  frontendPerfStats.avatarCacheHits = 0;
  frontendPerfStats.avatarCacheMisses = 0;
  frontendPerfStats.chatPolls.public_open = 0;
  frontendPerfStats.chatPolls.public_closed = 0;
  frontendPerfStats.chatPolls.public_hidden = 0;
  frontendPerfStats.chatPolls.private_open = 0;
  frontendPerfStats.chatPolls.private_closed = 0;
  frontendPerfStats.chatPolls.private_hidden = 0;
}, 60 * 1000);

/* =========================================================
   RADIO (shared playback lane)
   ========================================================= */
const btnHot97 = document.getElementById("btnHot97");
const btnMega979 = document.getElementById("btnMega979");
const btnKQ945 = document.getElementById("btnKQ945");
const btnAlofoke993 = document.getElementById("btnAlofoke993");
const btnZ100 = document.getElementById("btnZ100");
const radioStatusEl = document.getElementById("radioStatus");

const radioModal = document.getElementById("radioModal");
const radioFrame = document.getElementById("radioFrame");
const radioModalClose = document.getElementById("radioModalClose");
const radioModalTitle = document.getElementById("radioModalTitle");

const HOT97_STREAM_URL = "https://26313.live.streamtheworld.com/WQHTFMAAC.aac";
const MEGA979_STREAM_URL = "https://liveaudio.lamusica.com/NY_WSKQ_icy";
const KQ945_STREAM_URL = "https://radio.yaservers.com:9990/stream?icy=http";
const KQ945_SITE_URL = "https://kq94.net/";
const ALOFOKE993_STREAM_URL = "https://radiordomi.com:8566/stream";
const Z100_STREAM_URL = "https://stream.revma.ihrhls.com/zc1469";

function configureRadioAudioElement(audioEl) {
  if (!audioEl) return null;
  audioEl.preload = "none";
  audioEl.autoplay = false;
  audioEl.controls = false;
  audioEl.loop = false;
  audioEl.volume = 1;
  audioEl.muted = false;
  if ("playsInline" in audioEl) audioEl.playsInline = true;
  try { audioEl.setAttribute("playsinline", ""); } catch (_) {}
  try { audioEl.setAttribute("webkit-playsinline", ""); } catch (_) {}
  try { audioEl.setAttribute("x-webkit-airplay", "allow"); } catch (_) {}
  try { audioEl.setAttribute("aria-hidden", "true"); } catch (_) {}
  try { audioEl.crossOrigin = "anonymous"; } catch (_) {}
  return audioEl;
}

const sharedPlaybackAudio = configureRadioAudioElement(new Audio());

function ensureRadioAudioHost() {
  if (typeof document === "undefined") return null;
  let host = document.getElementById("radioAudioHost");
  if (host) return host;
  host = document.createElement("div");
  host.id = "radioAudioHost";
  host.setAttribute("aria-hidden", "true");
  host.style.position = "fixed";
  host.style.width = "1px";
  host.style.height = "1px";
  host.style.overflow = "hidden";
  host.style.opacity = "0";
  host.style.pointerEvents = "none";
  host.style.bottom = "0";
  host.style.left = "0";
  host.style.zIndex = "-1";
  const mountTarget = document.body || document.documentElement;
  mountTarget?.appendChild(host);
  return host;
}

if (typeof document !== "undefined") {
  const mountRadioAudioElement = () => {
    const host = ensureRadioAudioHost();
    if (!host || !sharedPlaybackAudio || sharedPlaybackAudio.parentNode === host) return;
    host.appendChild(sharedPlaybackAudio);
  };
  if (document.body) mountRadioAudioElement();
  else document.addEventListener("DOMContentLoaded", mountRadioAudioElement, { once: true });
}

let megaPlaying = false;
let hot97Playing = false;
let kqPlaying = false;
let alofoke993Playing = false;
let z100Playing = false;

const radioStations = [
  {
    key: "mega",
    label: "La Mega 97.9",
    url: MEGA979_STREAM_URL,
    button: btnMega979,
    failStatus: "Radio: La Mega failed to play",
    errorStatus: "Radio: La Mega stream error",
    failAlert: "La Mega 97.9 could not start. Turn volume up and try again.",
  },
  {
    key: "hot97",
    label: "HOT 97.1",
    url: HOT97_STREAM_URL,
    button: btnHot97,
    failStatus: "Radio: HOT 97.1 failed to play",
    errorStatus: "Radio: HOT 97.1 stream error",
    failAlert: "HOT 97.1 could not start. Turn volume up and try again.",
  },
  {
    key: "kq",
    label: "KQ 94.5 FM",
    url: KQ945_STREAM_URL,
    button: btnKQ945,
    failStatus: "Radio: KQ 94.5 FM failed to play",
    errorStatus: "Radio: KQ 94.5 FM stream error",
    failAlert: "KQ 94.5 FM could not start. Turn volume up and try again.",
  },
  {
    key: "alofoke993",
    label: "Alofoke 99.3 FM",
    url: ALOFOKE993_STREAM_URL,
    button: btnAlofoke993,
    failStatus: "Radio: Alofoke 99.3 FM failed to play",
    errorStatus: "Radio: Alofoke 99.3 FM stream error",
    failAlert: "Alofoke 99.3 FM could not start. Turn volume up and try again.",
  },
  {
    key: "z100",
    label: "Z100",
    url: Z100_STREAM_URL,
    button: btnZ100,
    failStatus: "Radio: Z100 failed to play",
    errorStatus: "Radio: Z100 stream error",
    failAlert: "Z100 could not start. Turn volume up and try again.",
  },
];
const radioStationByKey = new Map(radioStations.map((station) => [station.key, station]));

function getRadioStation(stationRef) {
  const normalized = String(stationRef || "").trim();
  if (!normalized) return null;
  if (typeof stationRef === "object" && stationRef && stationRef.key && stationRef.url) return stationRef;
  return radioStationByKey.get(normalized)
    || radioStations.find((station) => station.label === normalized)
    || null;
}

function getSharedNavigatorAudioSession() {
  try {
    return navigator && navigator.audioSession ? navigator.audioSession : null;
  } catch (_) {
    return null;
  }
}

function setSharedNavigatorAudioSessionType(type) {
  const session = getSharedNavigatorAudioSession();
  if (!session || !type) return false;
  try {
    if (session.type !== type) session.type = type;
    return session.type === type;
  } catch (_) {
    return false;
  }
}

function setRadioStatus(txt) {
  if (radioStatusEl) radioStatusEl.textContent = txt;
}

function setBtnState(btn, on) {
  if (!btn) return;
  btn.classList.toggle("on", !!on);
  const base = btn === btnMega979 ? "La Mega 97.9"
             : btn === btnHot97 ? "HOT 97.1"
             : btn === btnKQ945 ? "KQ 94.5"
             : btn === btnAlofoke993 ? "Alofoke 99.3 FM"
             : btn === btnZ100 ? "Z100"
             : "";
  btn.textContent = (on ? "⏸ " : "▶ ") + base;
}

function waitForRadioPauseSettle(audioEl, timeoutMs = 320) {
  return new Promise((resolve) => {
    if (!audioEl || audioEl.paused || audioEl.ended) {
      resolve(true);
      return;
    }

    let finished = false;
    const done = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timerId);
      audioEl.removeEventListener("pause", onPaused);
      audioEl.removeEventListener("emptied", onPaused);
      resolve(result);
    };

    const onPaused = () => done(true);
    const timerId = window.setTimeout(() => {
      done(!!audioEl.paused || !!audioEl.ended);
    }, timeoutMs);

    audioEl.addEventListener("pause", onPaused, { once: true });
    audioEl.addEventListener("emptied", onPaused, { once: true });
  });
}

function restoreSharedAudioOutputState(audioEl) {
  if (!audioEl) return;
  try { audioEl.muted = false; } catch (_) {}
  try { audioEl.volume = 1; } catch (_) {}
}

const TlcSharedAudio = (typeof window !== "undefined" && window.TlcSharedAudio && typeof window.TlcSharedAudio === "object")
  ? window.TlcSharedAudio
  : {};

Object.assign(TlcSharedAudio, {
  audioEl: sharedPlaybackAudio,
  owner: String(TlcSharedAudio.owner || "idle"),
  radioStationKey: String(TlcSharedAudio.radioStationKey || ""),
  radioStationLabel: String(TlcSharedAudio.radioStationLabel || ""),
  radioSourceUrl: String(TlcSharedAudio.radioSourceUrl || ""),
  desiredRadioStationKey: String(TlcSharedAudio.desiredRadioStationKey || ""),
  desiredRadioStationLabel: String(TlcSharedAudio.desiredRadioStationLabel || ""),
  desiredRadioSourceUrl: String(TlcSharedAudio.desiredRadioSourceUrl || ""),
  suspendedRadio: TlcSharedAudio.suspendedRadio || null,
  userPausedRadio: !!TlcSharedAudio.userPausedRadio,
  recorderLock: !!TlcSharedAudio.recorderLock,
  voiceContext: TlcSharedAudio.voiceContext || null,
  lastPauseReason: String(TlcSharedAudio.lastPauseReason || ""),
  mediaSessionBound: !!TlcSharedAudio.mediaSessionBound,
  isRadioActive() {
    return this.owner === "radio" && !!this.radioStationKey && !this.audioEl.paused && !this.audioEl.ended;
  },
  isVoiceActive() {
    return this.owner === "voice" && !!this.voiceContext && !this.audioEl.paused && !this.audioEl.ended;
  },
  isPlaybackBusy() {
    return this.owner === "radio" || this.owner === "voice" || this.owner === "record" || this.recorderLock;
  },
  getAudio() {
    return this.audioEl;
  },
  setPlaybackSession(reason = "playback") {
    if (setSharedNavigatorAudioSessionType("playback")) return "playback";
    if (setSharedNavigatorAudioSessionType("auto")) return "auto";
    return "unsupported";
  },
  setAutoSession(reason = "auto") {
    if (setSharedNavigatorAudioSessionType("auto")) return "auto";
    return "unsupported";
  },
  setRecordSession(reason = "record") {
    if (setSharedNavigatorAudioSessionType("play-and-record")) return "play-and-record";
    if (setSharedNavigatorAudioSessionType("auto")) return "auto";
    return "unsupported";
  },
  syncMediaSession(state = "none", title = "") {
    try {
      if (!navigator.mediaSession) return;
      navigator.mediaSession.playbackState = state;
      if (this.owner === "radio" && title && typeof MediaMetadata !== "undefined") {
        navigator.mediaSession.metadata = new MediaMetadata({
          title,
          artist: "TLC Map Radio",
        });
      } else if (state === "none" || this.owner !== "radio") {
        navigator.mediaSession.metadata = null;
      }
    } catch (_) {}
  },
  async startRadio(stationRef) {
    const station = getRadioStation(stationRef);
    if (!station || this.recorderLock) return false;
    if (this.owner === "voice") {
      await this.stopVoicePlayback("radio-start", { resetPosition: true, clearSource: true, resumeRadio: false });
    }
    this.owner = "radio";
    this.desiredRadioStationKey = station.key;
    this.desiredRadioStationLabel = station.label;
    this.desiredRadioSourceUrl = station.url;
    this.radioStationKey = station.key;
    this.radioStationLabel = station.label;
    this.radioSourceUrl = station.url;
    this.userPausedRadio = false;
    this.suspendedRadio = null;
    this.lastPauseReason = "radio-play";
    this.voiceContext = null;
    this.setPlaybackSession("radio-play");
    try {
      try { this.audioEl.muted = false; } catch (_) {}
      try { this.audioEl.volume = 1; } catch (_) {}
      if ((this.audioEl.currentSrc || this.audioEl.src || "") !== station.url) {
        this.audioEl.src = station.url;
        this.audioEl.load();
      }
      const playPromise = this.audioEl.play();
      if (playPromise && typeof playPromise.then === "function") await playPromise;
      this.syncMediaSession("playing", station.label);
      setRadioStatus(`Radio: ${station.label} playing`);
      refreshRadioButtons();
      return true;
    } catch (error) {
      console.warn(`${station.label} play failed:`, error);
      this.owner = this.recorderLock ? "record" : "idle";
      this.radioStationKey = "";
      this.radioStationLabel = "";
      this.radioSourceUrl = "";
      this.desiredRadioStationKey = "";
      this.desiredRadioStationLabel = "";
      this.desiredRadioSourceUrl = "";
      this.suspendedRadio = null;
      this.syncMediaSession("none", "");
      refreshRadioButtons();
      return false;
    }
  },
  stopRadio(reason = "stop") {
    if (this.owner !== "radio" && !this.desiredRadioStationKey) return false;
    try { this.audioEl.pause(); } catch (_) {}
    try { this.audioEl.removeAttribute("src"); } catch (_) {}
    try { this.audioEl.src = ""; } catch (_) {}
    try { this.audioEl.load(); } catch (_) {}
    if (reason === "manual-stop") this.userPausedRadio = true;
    this.owner = this.recorderLock ? "record" : "idle";
    this.radioStationKey = "";
    this.radioStationLabel = "";
    this.radioSourceUrl = "";
    this.desiredRadioStationKey = "";
    this.desiredRadioStationLabel = "";
    this.desiredRadioSourceUrl = "";
    this.suspendedRadio = null;
    this.lastPauseReason = reason;
    if (!this.recorderLock) this.setAutoSession(reason);
    this.syncMediaSession("none", "");
    setRadioStatus("Radio: off");
    refreshRadioButtons();
    return true;
  },
  pauseRadioForVoice(reason = "voice") {
    if (this.owner !== "radio" || !this.desiredRadioStationKey) return false;
    if (String(reason || "").includes("record")) {
      try { this.audioEl.muted = true; } catch (_) {}
      try { this.audioEl.volume = 0; } catch (_) {}
    }
    this.suspendedRadio = {
      key: this.desiredRadioStationKey,
      label: this.desiredRadioStationLabel,
      url: this.desiredRadioSourceUrl,
      shouldResume: !this.userPausedRadio,
    };
    this.lastPauseReason = reason;
    try { this.audioEl.pause(); } catch (_) {}
    this.owner = this.recorderLock ? "record" : "idle";
    this.syncMediaSession("paused", this.desiredRadioStationLabel || this.radioStationLabel || "");
    setRadioStatus(`Radio: ${this.desiredRadioStationLabel || this.radioStationLabel || "Radio"} paused`);
    refreshRadioButtons();
    return true;
  },
  async resumeRadioAfterVoice(reason = "voice-resume") {
    const suspended = this.suspendedRadio;
    if (!suspended || !suspended.shouldResume || this.recorderLock || this.owner === "voice") return false;
    const didResume = await this.startRadio(suspended);
    if (didResume) this.suspendedRadio = null;
    return didResume;
  },
  async startVoicePlayback(params = {}) {
    const src = String(params.src || "").trim();
    if (!src || this.recorderLock) return false;
    if (this.owner === "radio") this.pauseRadioForVoice("voice-play");
    const sameSrc = String(this.audioEl.currentSrc || this.audioEl.src || "").trim() === src;

    restoreSharedAudioOutputState(this.audioEl);

    if (sameSrc && this.audioEl.ended) {
      try { this.audioEl.currentTime = 0; } catch (_) {}
    }
    if (this.owner === "voice" && sameSrc && !this.audioEl.paused && !this.audioEl.ended) {
      await this.stopVoicePlayback("user", { resetPosition: false, clearSource: false, resumeRadio: false });
      return true;
    }
    this.owner = "voice";
    this.voiceContext = {
      messageId: params.messageId ?? null,
      scope: String(params.scope || ""),
      audioUrl: String(params.audioUrl || ""),
      blobUrl: String(params.blobUrl || src),
    };
    this.lastPauseReason = "voice-play";
    this.setPlaybackSession("voice-play");
    if (!sameSrc) {
      this.audioEl.src = src;
      this.audioEl.load();
    }
    const playPromise = this.audioEl.play();
    if (playPromise && typeof playPromise.then === "function") await playPromise;
    this.syncMediaSession("playing", "");
    refreshRadioButtons();
    return true;
  },
  async stopVoicePlayback(reason = "voice-stop", options = {}) {
    const { resetPosition = false, clearSource = false, resumeRadio = true } = options || {};
    if (this.owner === "voice") {
      try { this.audioEl.pause(); } catch (_) {}
    }
    if (resetPosition) {
      try { this.audioEl.currentTime = 0; } catch (_) {}
    }
    if (clearSource) {
      try { this.audioEl.removeAttribute("src"); } catch (_) {}
      try { this.audioEl.src = ""; } catch (_) {}
      try { this.audioEl.load(); } catch (_) {}
    }
    this.lastPauseReason = reason;
    this.voiceContext = null;
    this.owner = this.recorderLock ? "record" : "idle";
    if (!this.recorderLock) {
      if (resumeRadio) await this.resumeRadioAfterVoice(reason);
      else this.setAutoSession(reason);
    }
    if (this.owner !== "radio") this.syncMediaSession("none", "");
    restoreSharedAudioOutputState(this.audioEl);
    refreshRadioButtons();
    return true;
  },
  beginRecordingCapture(reason = "record-start") {
    return this.forcePauseRadioForVoiceCapture(reason);
  },

  async forcePauseRadioForVoiceCapture(reason = "record-start") {
    this.recorderLock = true;

    if (this.owner === "voice" && typeof this.stopVoicePlayback === "function") {
      try {
        await this.stopVoicePlayback("record-start", {
          resetPosition: true,
          clearSource: true,
          resumeRadio: false
        });
      } catch (_) {}
    }

    const audioEl = this.getAudio?.() || this.audioEl || null;
    const stationKey = String(this.desiredRadioStationKey || this.radioStationKey || "").trim();
    const stationLabel = String(this.desiredRadioStationLabel || this.radioStationLabel || "").trim();
    const stationUrl = String(this.desiredRadioSourceUrl || this.radioSourceUrl || "").trim();
    const hadRadio = !!stationKey;

    if (hadRadio) {
      this.suspendedRadio = {
        key: stationKey,
        label: stationLabel,
        url: stationUrl,
        shouldResume: !this.userPausedRadio
      };
    }

    this.radioStationKey = "";
    this.radioStationLabel = "";
    this.radioSourceUrl = "";
    this.desiredRadioStationKey = "";
    this.desiredRadioStationLabel = "";
    this.desiredRadioSourceUrl = "";
    this.owner = "record";
    this.lastPauseReason = reason;

    if (audioEl) {
      try { audioEl.muted = true; } catch (_) {}
      try { audioEl.volume = 0; } catch (_) {}
      try { audioEl.pause(); } catch (_) {}

      try {
        await waitForRadioPauseSettle(audioEl, 320);
      } catch (_) {}

      try { audioEl.removeAttribute("src"); } catch (_) {}
      try { audioEl.src = ""; } catch (_) {}
      try { audioEl.load(); } catch (_) {}
      try { audioEl.currentTime = 0; } catch (_) {}
    }

    this.syncMediaSession("none", "");
    this.setRecordSession(reason);
    setRadioStatus("Radio: paused for recording");
    refreshRadioButtons();
    return true;
  },
  async endRecordingCapture(reason = "record-end") {
    this.recorderLock = false;
    if (this.owner === "record") this.owner = "idle";

    restoreSharedAudioOutputState(this.audioEl);
    if (this.suspendedRadio?.shouldResume) return this.resumeRadioAfterVoice(reason);
    this.setAutoSession(reason);
    refreshRadioButtons();
    return false;
  },
  async hardStopVoiceForBackground(reason = "hidden") {
    await this.stopVoicePlayback(reason, { resetPosition: true, clearSource: true, resumeRadio: false });
    this.setAutoSession(reason);
    return true;
  },
  getDebugState() {
    const audioSession = getSharedNavigatorAudioSession();
    return {
      owner: this.owner,
      radioStationKey: this.radioStationKey,
      desiredRadioStationKey: this.desiredRadioStationKey,
      userPausedRadio: this.userPausedRadio,
      recorderLock: this.recorderLock,
      voiceContext: this.voiceContext,
      currentSrc: String(this.audioEl?.currentSrc || this.audioEl?.src || ""),
      paused: !!this.audioEl?.paused,
      ended: !!this.audioEl?.ended,
      muted: !!this.audioEl?.muted,
      volume: Number(this.audioEl?.volume ?? 0),
      readyState: Number(this.audioEl?.readyState ?? 0),
      networkState: Number(this.audioEl?.networkState ?? 0),
      visibilityState: typeof document !== "undefined" ? document.visibilityState : "",
      audioSessionType: audioSession?.type || "",
      mediaSessionPlaybackState: navigator.mediaSession?.playbackState || "none",
    };
  },
});

function bindSharedMediaSessionHandlers() {
  try {
    if (!navigator.mediaSession || TlcSharedAudio.mediaSessionBound) return;
    TlcSharedAudio.mediaSessionBound = true;
    navigator.mediaSession.setActionHandler("play", async () => {
      if (TlcSharedAudio.desiredRadioStationKey && TlcSharedAudio.owner !== "voice" && !TlcSharedAudio.recorderLock) {
        await TlcSharedAudio.startRadio(TlcSharedAudio.desiredRadioStationKey);
      }
    });
    navigator.mediaSession.setActionHandler("pause", async () => {
      if (TlcSharedAudio.owner === "radio") TlcSharedAudio.stopRadio("media-session-pause");
      else if (TlcSharedAudio.owner === "voice") await TlcSharedAudio.stopVoicePlayback("media-session-pause", { resetPosition: false, clearSource: false, resumeRadio: false });
    });
    navigator.mediaSession.setActionHandler("stop", async () => {
      if (TlcSharedAudio.owner === "radio") TlcSharedAudio.stopRadio("manual-stop");
      else if (TlcSharedAudio.owner === "voice") await TlcSharedAudio.stopVoicePlayback("media-session-stop", { resetPosition: true, clearSource: true, resumeRadio: false });
    });
  } catch (_) {}
}

function syncRadioPlaybackFlags() {
  const activeKey = TlcSharedAudio.owner === "radio" ? TlcSharedAudio.radioStationKey : "";
  megaPlaying = activeKey === "mega";
  hot97Playing = activeKey === "hot97";
  kqPlaying = activeKey === "kq";
  alofoke993Playing = activeKey === "alofoke993";
  z100Playing = activeKey === "z100";
}

function refreshRadioButtons() {
  syncRadioPlaybackFlags();
  setBtnState(btnMega979, megaPlaying);
  setBtnState(btnHot97, hot97Playing);
  setBtnState(btnKQ945, kqPlaying);
  setBtnState(btnAlofoke993, alofoke993Playing);
  setBtnState(btnZ100, z100Playing);
}

function isAnyRadioPlaying() {
  return TlcSharedAudio.isRadioActive();
}

function bindSharedPlaybackElementHandlers() {
  if (!sharedPlaybackAudio || sharedPlaybackAudio.__tlcSharedHandlersBound) return;
  sharedPlaybackAudio.__tlcSharedHandlersBound = true;
  sharedPlaybackAudio.addEventListener("playing", () => {
    if (TlcSharedAudio.owner === "radio") {
      TlcSharedAudio.syncMediaSession("playing", TlcSharedAudio.radioStationLabel || TlcSharedAudio.desiredRadioStationLabel || "");
      setRadioStatus(`Radio: ${TlcSharedAudio.radioStationLabel || TlcSharedAudio.desiredRadioStationLabel || "playing"} playing`);
      refreshRadioButtons();
      return;
    }
    if (TlcSharedAudio.owner === "voice") {
      TlcSharedAudio.syncMediaSession("playing", "");
    }
  });
  sharedPlaybackAudio.addEventListener("pause", () => {
    if (TlcSharedAudio.owner === "radio") {
      TlcSharedAudio.syncMediaSession("paused", TlcSharedAudio.radioStationLabel || TlcSharedAudio.desiredRadioStationLabel || "");
      refreshRadioButtons();
    }
  });
  sharedPlaybackAudio.addEventListener("ended", async () => {
    if (TlcSharedAudio.owner === "voice") {
      await TlcSharedAudio.stopVoicePlayback("ended", { resetPosition: true, clearSource: true, resumeRadio: true });
      return;
    }
    if (TlcSharedAudio.owner === "radio") {
      TlcSharedAudio.stopRadio("ended");
    }
  });
  sharedPlaybackAudio.addEventListener("error", async () => {
    const station = getRadioStation(TlcSharedAudio.radioStationKey || TlcSharedAudio.desiredRadioStationKey);
    if (TlcSharedAudio.owner === "voice") {
      await TlcSharedAudio.stopVoicePlayback("error", { resetPosition: true, clearSource: true, resumeRadio: true });
      return;
    }
    TlcSharedAudio.stopRadio("error");
    setRadioStatus(station?.errorStatus || "Radio: stream error");
  });
}

function closeHot97Modal() {
  if (radioModal && radioModal.classList.contains("open")) {
    radioModal.classList.remove("open");
    radioModal.setAttribute("aria-hidden", "true");
  }
  if (radioFrame) radioFrame.src = "about:blank";
}
function openHot97Modal() { closeHot97Modal(); }

function openStationWebModal(title, url) {
  if (!radioModal || !radioFrame || !radioModalTitle) return;
  radioModalTitle.textContent = title;
  radioFrame.src = url;
  radioModal.classList.add("open");
  radioModal.setAttribute("aria-hidden", "false");
}

async function toggleStation(stationKey) {
  const station = radioStationByKey.get(String(stationKey || "").trim());
  if (!station) return false;
  closeHot97Modal();
  const sameActive = TlcSharedAudio.desiredRadioStationKey === station.key && (TlcSharedAudio.owner === "radio" || !!TlcSharedAudio.desiredRadioStationKey);
  if (sameActive) {
    TlcSharedAudio.stopRadio("manual-stop");
    return true;
  }
  try {
    if (typeof window.pauseSharedVoicePlaybackForRadio === "function") {
      try { window.pauseSharedVoicePlaybackForRadio("radio-start"); } catch (_) {}
    }
    const ok = await TlcSharedAudio.startRadio(station);
    if (!ok) throw new Error("play failed");
    setRadioStatus(`Radio: ${station.label} playing`);
    return true;
  } catch (e) {
    console.warn(`${station.label} play failed:`, e);
    TlcSharedAudio.stopRadio("play-failed");
    setRadioStatus(station.failStatus);
    if (station.key === "kq") {
      try { window.open(KQ945_SITE_URL, "_blank", "noopener"); } catch (_) {}
    }
    alert(station.failAlert);
    return false;
  }
}

async function toggleAlofoke993() { return toggleStation("alofoke993"); }
async function toggleMega() { return toggleStation("mega"); }
async function toggleHot97() { return toggleStation("hot97"); }
async function toggleKQ() { return toggleStation("kq"); }
async function toggleZ100() { return toggleStation("z100"); }

if (btnMega979) {
  btnMega979.addEventListener("pointerdown", (e) => e.stopPropagation());
  btnMega979.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleMega();
  });
}
if (btnHot97) {
  btnHot97.addEventListener("pointerdown", (e) => e.stopPropagation());
  btnHot97.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleHot97();
  });
}
if (btnKQ945) {
  btnKQ945.addEventListener("pointerdown", (e) => e.stopPropagation());
  btnKQ945.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleKQ();
  });
}
if (btnAlofoke993) {
  btnAlofoke993.addEventListener("pointerdown", (e) => e.stopPropagation());
  btnAlofoke993.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleAlofoke993();
  });
}
if (btnZ100) {
  btnZ100.addEventListener("pointerdown", (e) => e.stopPropagation());
  btnZ100.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleZ100();
  });
}
if (radioModalClose) {
  radioModalClose.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeHot97Modal();
  });
}
if (radioModal) {
  radioModal.addEventListener("click", (e) => {
    const card = radioModal.querySelector(".radioModalCard");
    if (card && card.contains(e.target)) return;
    closeHot97Modal();
  });
}

bindSharedMediaSessionHandlers();
bindSharedPlaybackElementHandlers();

if (typeof window !== "undefined") {
  window.TlcSharedAudio = TlcSharedAudio;
  window.getSharedNavigatorAudioSession = getSharedNavigatorAudioSession;
  window.setSharedNavigatorAudioSessionType = setSharedNavigatorAudioSessionType;
  window.ensurePlaybackAudioSession = (reason = "playback") => TlcSharedAudio.setPlaybackSession(reason);
  window.pauseRadioForVoicePlayback = (reason = "voice-play") => TlcSharedAudio.pauseRadioForVoice(reason);
  window.resumeRadioAfterVoicePlayback = (reason = "voice-stop") => TlcSharedAudio.resumeRadioAfterVoice(reason);
  window.pauseRadioForVoiceCapture = (reason = "record-start") => TlcSharedAudio.beginRecordingCapture(reason);
  window.forcePauseRadioForVoiceCapture = (reason = "record-start") => TlcSharedAudio.forcePauseRadioForVoiceCapture(reason);
  window.resumeRadioAfterVoiceCapture = (reason = "record-end") => TlcSharedAudio.endRecordingCapture(reason);
  window.resumeRadioIfNeeded = (reason = "resume") => {
    if (!TlcSharedAudio.desiredRadioStationKey || TlcSharedAudio.userPausedRadio || TlcSharedAudio.recorderLock || TlcSharedAudio.owner === "voice") return false;
    return TlcSharedAudio.startRadio(TlcSharedAudio.desiredRadioStationKey);
  };
  window.isAnyRadioPlaying = isAnyRadioPlaying;
  window.getRadioAudioDebugState = function getRadioAudioDebugState() {
    return TlcSharedAudio.getDebugState();
  };

  window.addEventListener("pageshow", () => {
    if (TlcSharedAudio.owner === "idle" && TlcSharedAudio.desiredRadioStationKey && !TlcSharedAudio.userPausedRadio && !TlcSharedAudio.recorderLock && !TlcSharedAudio.isVoiceActive()) {
      void TlcSharedAudio.startRadio(TlcSharedAudio.desiredRadioStationKey);
    }
  });
  window.addEventListener("focus", () => {
    if (TlcSharedAudio.owner === "idle" && TlcSharedAudio.desiredRadioStationKey && !TlcSharedAudio.userPausedRadio && !TlcSharedAudio.recorderLock && !TlcSharedAudio.isVoiceActive()) {
      void TlcSharedAudio.startRadio(TlcSharedAudio.desiredRadioStationKey);
    }
  });
  window.addEventListener("pagehide", () => {
    if (TlcSharedAudio.owner === "radio") {
      TlcSharedAudio.setPlaybackSession("radio-pagehide");
      TlcSharedAudio.syncMediaSession(sharedPlaybackAudio.paused ? "paused" : "playing", TlcSharedAudio.radioStationLabel || TlcSharedAudio.desiredRadioStationLabel || "");
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (TlcSharedAudio.owner === "radio") {
        TlcSharedAudio.setPlaybackSession("radio-hidden");
        TlcSharedAudio.syncMediaSession(sharedPlaybackAudio.paused ? "paused" : "playing", TlcSharedAudio.radioStationLabel || TlcSharedAudio.desiredRadioStationLabel || "");
      }
      return;
    }
    if (TlcSharedAudio.desiredRadioStationKey && !TlcSharedAudio.userPausedRadio && !TlcSharedAudio.recorderLock && TlcSharedAudio.owner !== "voice" && sharedPlaybackAudio.paused) {
      void TlcSharedAudio.startRadio(TlcSharedAudio.desiredRadioStationKey);
    }
  });
}

refreshRadioButtons();
refreshRadioButtons();

/* =========================================================
   COMMUNITY (AUTH + PRESENCE + POLICE + PICKUP)
   ========================================================= */
let communityToken = localStorage.getItem(LS_TOKEN) || "";
let me = null;
let lastGpsAccuracyM = null;

function authHeaderOK() {
  return typeof communityToken === "string" && communityToken.trim().length > 0;
}

window.TlcCommunityInternals = {
  getMap: () => map,
  isMapReady: () => mapReady,
  getCurrentFrame: () => currentFrame,
  getUserLatLng: () => userLatLng,
  getCommunityTokenState: () => communityToken,
  setCommunityTokenState: (value) => { communityToken = String(value || ""); },
  getMeState: () => me,
  setMeState: (value) => { me = value || null; },
  getLastGpsAccuracy: () => lastGpsAccuracyM,
  getLastSelfOrbitMeta: () => lastSelfOrbitMeta,
  setLastSelfOrbitMeta: (value) => { lastSelfOrbitMeta = value || null; },
  getFrontendPerfStats: () => frontendPerfStats,
  getAvatarThumbCache: () => avatarThumbCache,
  getMapPageVisible: () => mapPageIsVisible,
  getPresenceBoostUntil: () => lastPresenceInteractionBoostUntil,
  setPresenceBoostUntil: (value) => { lastPresenceInteractionBoostUntil = Number(value) || 0; },
  isStartupViewportReady: () => !!(mapReady && startupGpsPriorityResolved && startupLocalZoomDone),
  hasStartupFirstGoodGpsFix: () => !!startupFirstGoodGpsFix,
  hasStartupLocationPermissionResolved: () => !!startupLocationPermissionResolved,
  hasStartupLocationTerminalFailure: () => !!startupLocationTerminalFailure,
  hasStartupVisualFallbackApplied: () => !!startupVisualFallbackApplied,
  isStartupTimelineReady: () => !!startupTimelineReady,
  hasStartupVisibleViewportFetchReleased: () => !!startupVisibleViewportFetchReleased,
  isStartupCameraLocked: () => !!startupInitialCameraLocked,
  getStartupCameraLockReason: () => startupCameraLockReason || "",
  isStartupViewportFrameRendered: () => !!startupViewportFrameRendered,
  hasStartupFullFrameBackfillStarted: () => !!startupFullFrameBackfillStarted,
  hasStartupFullFrameBackfillCompleted: () => !!startupFullFrameBackfillCompleted,
  getStartupFullFrameRetryCount: () => Number(startupFullFrameRetryCount || 0),
  isCurrentFrameViewportSubset: () => currentFrameIsViewportSubset(),
  waitForStyleReady,
  emptyGeojson,
  geometryCenter,
  haversineMiles,
  refreshNavNameLabel,
  applyDriverLabelZoomStyles,
  setPresenceDirection,
  wireProfileOpenTargets,
  normDeg,
  shortestAngleDelta,
  recordPerfMetric,
  updateOnlineBadge
};

function recordPerfMetric(metricId, value) {
  runtimePerf?.setMetric?.(metricId, value);
  dbg(metricId, value);
}

function markFirstUsableMap(reason = "") {
  if (firstUsableMapRecorded) return;
  firstUsableMapRecorded = true;
  const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  const elapsedMs = Math.max(0, Math.round(now - appBootStartedAt));
  recordPerfMetric("dbgFirstUsableMap", `${elapsedMs}ms${reason ? ` (${reason})` : ""}`);
}

function getMapLoadingEl() {
  return document.getElementById("mapLoading");
}

function getMapEl() {
  return document.getElementById("map");
}

function setStartupMapCanvasVisibility(visible) {
  const mapEl = getMapEl();
  if (!mapEl) return;
  mapEl.style.opacity = "1";
  mapEl.style.visibility = "visible";
}

function emitStartupCameraLocked(reason = "") {
  if (!startupInitialCameraLocked) startupInitialCameraLocked = true;
  if (reason) startupCameraLockReason = String(reason);
  if (startupCameraLockEventSent) return;
  startupCameraLockEventSent = true;
  if (startupCameraLockedEventEmitted) return;
  startupCameraLockedEventEmitted = true;
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(new CustomEvent("team-joseo-startup-camera-locked", {
    detail: {
      reason: startupCameraLockReason || reason,
      hasLiveGps: !!startupFirstGoodGpsFix,
      timelineReady: !!startupTimelineReady,
    },
  }));
}

function emitStartupViewportReady(reason = "") {
  if (startupViewportReadyEmitted) return;
  startupViewportReadyEmitted = true;
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(new CustomEvent("team-joseo-startup-viewport-ready", {
    detail: {
      reason,
      hasLiveGps: !!startupFirstGoodGpsFix,
      mapReady: !!mapReady,
      localZoomDone: !!startupLocalZoomDone,
      timelineReady: !!startupTimelineReady,
    },
  }));
}

function resolveStartupLocationFailure(reason = "gps-error-fallback") {
  if (startupFirstGoodGpsFix) return;
  if (startupGpsPriorityTimer) {
    clearTimeout(startupGpsPriorityTimer);
    startupGpsPriorityTimer = null;
  }
  startupLocationPermissionResolved = true;
  startupLocationTerminalFailure = true;
  startupGpsPriorityResolved = true;
  startupInitialCameraLocked = true;
  startupLocalZoomDone = true;
  startupVisualFallbackApplied = false;
  startupCameraLockReason = String(reason || "gps-error-fallback");
  if (map) {
    const center = map.getCenter?.();
    map.jumpTo({
      center: [center?.lng ?? -73.98, center?.lat ?? 40.73],
      zoom: STARTUP_FALLBACK_ZOOM,
    });
  }
  emitStartupCameraLocked(startupCameraLockReason);
  maybeResolveStartupLoading(startupCameraLockReason);
}

function markStartupVisibleViewportFetchReleased(reason = "") {
  if (startupVisibleViewportFetchReleased) return;
  startupVisibleViewportFetchReleased = true;
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(new CustomEvent("team-joseo-startup-visible-fetch-released", {
    detail: { reason: String(reason || "") },
  }));
}

function markStartupLocalZoomDone(reason = "") {
  if (startupLocalZoomDone) return;
  startupLocalZoomDone = true;
  maybeResolveStartupLoading(reason || "startup-local-zoom-done");
}

function hideStartupLoadingOverlay(reason = "") {
  if (startupLoadingForceHidden) return;
  startupLoadingForceHidden = true;
  const loading = getMapLoadingEl();
  if (loading) loading.style.display = "none";
  if (reason) recordPerfMetric("dbgBlankMap", `startup overlay hidden: ${reason}`);
  emitStartupViewportReady(reason || "startup-ready");
  markStartupVisibleViewportFetchReleased(reason || "startup-ready");
}

function maybeResolveStartupLoading(reason = "") {
  if (startupLoadingForceHidden) return;
  if (!mapReady) return;
  if (!startupInitialCameraLocked && !startupVisualFallbackApplied) return;
  hideStartupLoadingOverlay(reason || "startup-ready");
  if (startupInitialCameraLocked) {
    emitStartupCameraLocked(startupCameraLockReason || reason || "startup-ready");
  }
}

function recordBlankMapWarning(reason) {
  frontendPerfStats.blankMapWarnings += 1;
  recordPerfMetric("dbgBlankMap", reason || "warning");
}

function recordDuplicateGuard(reason) {
  frontendPerfStats.duplicatePollGuards += 1;
  recordPerfMetric("dbgPollGuards", `${frontendPerfStats.duplicatePollGuards} guard(s) • ${reason}`);
}

// other drivers marker HTML
function applyDriverLabelZoomStyles() {
  const zoom = map?.getZoom?.();
  if (typeof window !== "undefined" && typeof window.mapIdentityApplyZoomStyles === "function") {
    window.mapIdentityApplyZoomStyles(zoom);
  }
}

/* =========================================================
   MOVED TO app.part10.js
   Community / Auth / Presence / Pickup actions module
   Search there for:
   - setAuthUI
   - clearAuth
   - loadMe
   - updateMeProfile
   - syncAdminPortalSession
   - sendPoliceReport
   - sendPickupLog
   ========================================================= */
function syncGhostUI(...args) { return window.TlcCommunityModule?.syncGhostUI?.(...args); }
function signOutNow(...args) { return window.TlcCommunityModule?.signOutNow?.(...args); }
function setAuthUI(...args) { return window.TlcCommunityModule?.setAuthUI?.(...args); }
function clearAuth(...args) { return window.TlcCommunityModule?.clearAuth?.(...args); }
async function loadMe(...args) { return await (window.TlcCommunityModule?.loadMe?.(...args) || Promise.resolve(null)); }
async function updateMeProfile(...args) { return await (window.TlcCommunityModule?.updateMeProfile?.(...args) || Promise.resolve()); }
function syncAdminPortalSession(...args) { return window.TlcCommunityModule?.syncAdminPortalSession?.(...args); }
async function sendPoliceReport(...args) { return await (window.TlcCommunityModule?.sendPoliceReport?.(...args) || Promise.resolve()); }
async function sendPickupLog(...args) { return await (window.TlcCommunityModule?.sendPickupLog?.(...args) || Promise.resolve()); }

window.getPickupRecordingContext = function getPickupRecordingContext() { return window.TlcCommunityModule?.getPickupRecordingContext?.() || {}; };

/* =========================================================
   Boot
   ========================================================= */
setNavDestination(null);

(async () => {
  if (debugEnabled) {
    dbg("dbgBaseUrl", RAILWAY_BASE || "(relative)");
    try {
      await fetchJSON(`${RAILWAY_BASE}/status`);
      dbg("dbgStatus", "OK");
    } catch (e) {
      dbg("dbgStatus", `FAIL ${e?.message || e}`);
    }
  }

  const loading = getMapLoadingEl();
  if (loading) loading.style.display = "flex";
  setStartupMapCanvasVisibility(true);
  if (timeLabel && !startupTimelineReady) {
    timeLabel.textContent = "Showing Team Joseo Score loading…";
  }
  window.setTimeout(() => {
    if (!firstUsableMapRecorded) recordBlankMapWarning("first usable map still pending after 6s");
  }, 6000);
  setTimeout(() => {
    maybeResolveStartupLoading("hard-safety-timeout");
  }, 12000);

  preventBrowserZoomUI();
  initMap();
  startLocationWatch();
  startupGpsPriorityTimer = setTimeout(() => {
    startupGpsPriorityTimer = null;
    if (startupFirstGoodGpsFix || startupInitialCameraLocked || startupLocationPermissionResolved) return;
    const applyTimeoutVisualFallback = () => {
      if (!map) return;
      const center = map.getCenter?.();
      map.jumpTo({
        center: [center?.lng ?? -73.98, center?.lat ?? 40.73],
        zoom: STARTUP_FALLBACK_ZOOM,
      });
      startupGpsPriorityResolved = true;
      startupVisualFallbackApplied = true;
      startupCameraLockReason = "gps-timeout-visual-fallback";
      maybeResolveStartupLoading("gps-timeout-visual-fallback");
    };
    if (map && !mapReady) {
      map.once("load", () => {
        if (!startupFirstGoodGpsFix) applyTimeoutVisualFallback();
      });
      return;
    }
    applyTimeoutVisualFallback();
  }, STARTUP_GPS_PRIORITY_TIMEOUT_MS);
  const timelinePromise = loadTimeline()
    .then((loadedTimeline) => {
      startupTimelineReady = Array.isArray(loadedTimeline) && loadedTimeline.length > 0;
    })
    .catch((err) => {
      console.warn("timeline load failed during boot:", err);
      if (!timelinePreparingState && timeLabel) timeLabel.textContent = `Error: ${err?.message || err}`;
    });
  void timelinePromise;

  // Community/auth bootstrap moved to app.part10.js

  updateWeatherNow().catch(() => {});
})().catch((err) => {
  console.error(err);
  if (!timelinePreparingState && timeLabel) timeLabel.textContent = `Error: ${err?.message || err}`;
});
