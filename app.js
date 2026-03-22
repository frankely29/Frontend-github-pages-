// BOOT_SIGNATURE: railway-frontend-v1
/* =========================================================
   NYC TLC Hotspot Map (Frontend) - SIMPLE + STABLE (MapLibre)
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
 * Historically the frontend hard‑coded a Railway domain (e.g. https://web-production-78f67.up.railway.app)
 * as the base for all API calls.  When only app.js is replaced without updating other files,
 * using window.location.origin can break critical endpoints like `/timeline` because the static
 * frontend is often hosted separately from the backend.  To maintain compatibility we
 * provide a default API base that points at the original backend.  You can override this by
 * setting `window.API_BASE` before app.js loads.  This allows new deployments to specify
 * their backend host without modifying the source code.
 */
const DEFAULT_API_BASE = "https://web-production-78f67.up.railway.app";
const RAILWAY_BASE = (typeof window !== "undefined" && window.API_BASE !== undefined)
  ? String(window.API_BASE || DEFAULT_API_BASE)
  : DEFAULT_API_BASE;
const BIN_MINUTES = 20;
const FrontendRuntime = (typeof window !== "undefined" && window.FrontendRuntime) ? window.FrontendRuntime : null;
const runtimePolling = FrontendRuntime?.polling || null;
const runtimePerf = FrontendRuntime?.perf || null;

const REFRESH_MS = 5 * 60 * 1000;
const NYC_CLOCK_TICK_MS = 60 * 1000;
const USER_SLIDER_GRACE_MS = 25 * 1000;

let map; // global MapLibre instance
let pendingFrame = null;
let mapReady = false;
let didFitToZonesOnce = false;

const ROTATE_ENABLED = true;
const ROTATE_MIN_MPH = 1.0;
const ROTATE_MIN_DELTA_DEG = 1.5;
const ROTATE_RATE_LIMIT_MS = 120;
const ROTATE_ANIM_MS = 220;
const GPS_ACCURACY_THRESHOLD = 50;
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
  const [d, t] = iso.split("T");
  const [Y, M, D] = d.split("-").map(Number);
  const [h, m, s] = t.split(":").map(Number);
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
function formatNYCLabel(iso) {
  const { h, m } = parseIsoNoTz(iso);
  const dow_m = dowMon0FromIso(iso);
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const hr12 = ((h + 11) % 12) + 1;
  const ampm = h >= 12 ? "PM" : "AM";
  const mm = String(m).padStart(2, "0");
  return `${names[dow_m]} ${hr12}:${mm} ${ampm}`;
}
function formatNYCTimeOnlyLabel(iso) {
  const { h, m } = parseIsoNoTz(iso);
  const hr12 = ((h + 11) % 12) + 1;
  const ampm = h >= 12 ? "PM" : "AM";
  const mm = String(m).padStart(2, "0");
  return `${hr12}:${mm} ${ampm}`;
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
  if (!res.ok) {
    const err = new Error(`${res.status} ${res.statusText} @ ${url} :: ${text.slice(0, 120)}`);
    err.status = res.status;
    err.url = url;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON @ ${url} :: ${text.slice(0, 120)}`);
  }
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
    purple: "High",
    blue: "Medium",
    sky: "Normal",
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

window.TlcMapUiInternals = {
  getRecommendEl: () => recommendEl,
  getNavButton: () => navBtn,
  getUserLatLng: () => userLatLng,
  getSpecialModes: () => getModeFlags(),
  effectiveBucket,
  effectiveRating,
  getActiveSpecialModeTagForFeature,
  geometryCenter,
  haversineMiles,
  fetchJSON,
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
      <div style="display:flex;align-items:center;gap:8px;">${swatch("#00b050")}Green = Highest</div>
      <div style="display:flex;align-items:center;gap:8px;">${swatch("#8000ff")}Purple = High</div>
      <div style="display:flex;align-items:center;gap:8px;">${swatch("#0066ff")}Blue = Medium</div>
      <div style="display:flex;align-items:center;gap:8px;">${swatch("#66ccff")}Sky = Normal</div>
      <div style="display:flex;align-items:center;gap:8px;">${swatch("#ffd400")}Yellow = Below Normal</div>
      <div style="display:flex;align-items:center;gap:8px;">${swatch("#e60000")}Red = Very Low / Avoid</div>
  `;

  return `
    <div class="panelBlock">
      <div style="font-weight:800;margin-bottom:8px;">Demand Colors</div>
      ${rows}
      <div style="margin-top:10px;opacity:0.75;font-weight:600;">
        ${modeFlags.statenIslandMode
          ? "Staten Island Mode is ON: Staten Island colors are relative within Staten Island only. Other boroughs remain NYC-wide."
          : "Colors come from rating (1–100) for the selected 20-minute window. Time label is NYC time."}
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
// Chat binding has been removed from app.js.  A new chat implementation
// in app.part2.js will call bindDockToggle(dockChat, ...) with its own
// panel and wiring functions.
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
    zoom: 10.2,
    attributionControl: { position: "bottom-right" },
    localIdeographFontFamily: "sans-serif",
  });

  map.on("load", () => {
    enforceSaveButtonTheme();
    mapReady = true;
    map.resize();
    applyNightBasemap(!!window.TlcMapUiModule?.getWeatherState?.()?.isNight);

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
    });
    map.on("zoom", () => {
      if (authHeaderOK()) scheduleAdaptivePresenceRender();
      applyDriverLabelZoomStyles();
    });
    map.on("zoomend", () => {
      if (authHeaderOK()) {
        scheduleAdaptivePresenceRender();
        schedulePickupOverlayRefresh();
        schedulePresencePoll({ immediate: true, reason: "viewport-change" });
      }
      applyDriverLabelZoomStyles();
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

    map.on("click", (e) => {
      const features = map.queryRenderedFeatures(e.point, { layers: ["zones-fill"] });
      if (!features.length) closeAllPanels();
    });

    const loading = document.getElementById("mapLoading");
    if (loading) loading.style.display = "none";
    recordPerfMetric("dbgBlankMap", "map loaded");

    map.triggerRepaint();
    setTimeout(() => map.triggerRepaint(), 150);
    setTimeout(() => map.triggerRepaint(), 400);
    setTimeout(() => map.triggerRepaint(), 800);

    applyDriverLabelZoomStyles();

    if (pendingFrame) {
      renderFrame(pendingFrame);
      pendingFrame = null;
    }
  });

  map.on("style.load", () => map.triggerRepaint());
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
  clearTimeout(zonePopupAutoCloseTimer);
  zonePopupAutoCloseTimer = null;
}

function wireZoneClickPopup() {
  if (!map) return;

  // cursor UX
  map.on("mouseenter", "zones-fill", () => {
    try { map.getCanvas().style.cursor = "pointer"; } catch {}
  });
  map.on("mouseleave", "zones-fill", () => {
    try { map.getCanvas().style.cursor = ""; } catch {}
  });

  map.on("click", "zones-fill", (e) => {
    try {
      const feat = e?.features?.[0];
      if (!feat) return;

      const props = feat.properties || {};
      // MapLibre can stringify nested props; your popup only needs top-level keys used below.
      const geom = feat.geometry || null;

      const lngLat = e.lngLat;
      const html = buildPopupHTML(props, geom);

      closeZonePopup();

      zonePopup = new maplibregl.Popup({
        closeButton: true,
        closeOnClick: true,
        maxWidth: "238px",
      })
        .setLngLat([lngLat.lng, lngLat.lat])
        .setHTML(html)
        .addTo(map);

      startZonePopupAutoCloseTimer();
    } catch (err) {
      console.warn("zone popup failed:", err);
    }
  });

  if (!zonePopupActivityListenersBound) {
    document.addEventListener("pointerdown", resetZonePopupAutoCloseTimer, { passive: true });
    document.addEventListener("touchstart", resetZonePopupAutoCloseTimer, { passive: true });
    zonePopupActivityListenersBound = true;
  }
}

/* =========================================================
   Timeline / frames
   ========================================================= */
let timeline = [];
let minutesOfWeek = [];
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
  state.promise = fetchJSON(`${RAILWAY_BASE}/frame/${normalizedIdx}`, { signal: controller.signal, cache: force ? "reload" : undefined })
    .then((frame) => rememberFrame(normalizedIdx, frame))
    .finally(() => {
      const latest = frameRequestState.get(normalizedIdx);
      if (latest?.controller === controller) frameRequestState.delete(normalizedIdx);
      if (frameLoadAbortController === controller) frameLoadAbortController = null;
    });
  frameRequestState.set(normalizedIdx, state);
  return state.promise;
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

function buildPopupHTML(props, geom) {
  const zoneName = (props.zone_name || "").trim();
  const borough = (props.borough || "").trim();

  const nycRating = props.rating ?? "";
  const nycBucket = props.bucket ?? "";
  const pickups = props.pickups ?? "";
  const pay = props.avg_driver_pay == null ? "n/a" : Number(props.avg_driver_pay).toFixed(2);

  const nextPuVal = nextFramePickupsById.get(String(props.LocationID ?? ""));
  const nextPickups = nextPuVal == null ? "n/a" : String(Math.round(nextPuVal));

  const nextPayVal = nextFramePayById.get(String(props.LocationID ?? ""));
  const nextPay = nextPayVal == null ? "n/a" : Number(nextPayVal).toFixed(2);

  const zoneCommunity = pickupZoneStats.get(String(props.LocationID ?? ""));
  const communityPickupCount = Number(zoneCommunity?.sample_size ?? 0);
  const communitySampleLimit = Number(zoneCommunity?.sample_limit ?? PICKUP_ZONE_SAMPLE_LIMIT);
  const communityLastTs = zoneCommunity?.latest_created_at ?? null;
  const communityPickupLine = communityPickupCount > 0
    ? `<div style="margin-top:6px;"><b>Community zone avg:</b> ${communityPickupCount}/${communitySampleLimit} trips used${communityLastTs ? ` • last ${escapeHtml(formatRelativeAge(communityLastTs))}` : ""}</div>`
    : "";

  let extra = "";
  const modeFlags = getModeFlags();
  const activeModeTag = getActiveSpecialModeTagForFeature(props, geom);

  if (modeFlags.statenIslandMode && activeModeTag === "staten_island" && Number.isFinite(Number(props.si_local_rating))) {
    extra += `<div style="margin-top:6px;"><b>Staten Local Rating:</b> ${props.si_local_rating} (${prettyBucket(props.si_local_bucket)})</div>`;
  }

  if (modeFlags.manhattanMode && activeModeTag === "manhattan" && Number.isFinite(Number(props.mh_local_rating))) {
    extra += `<div style="margin-top:6px;"><b>Manhattan Anti-Saturation:</b> ${props.mh_local_rating} (${prettyBucket(props.mh_local_bucket)})</div>`;
  }

  if (modeFlags.queensMode && activeModeTag === "queens" && Number.isFinite(Number(props.qn_local_rating))) {
    extra += `<div style="margin-top:6px;"><b>Queens Local Flow:</b> ${props.qn_local_rating} (${prettyBucket(props.qn_local_bucket)})</div>`;
  }

  if (modeFlags.brooklynMode && activeModeTag === "brooklyn" && Number.isFinite(Number(props.bk_local_rating))) {
    extra += `<div style="margin-top:6px;"><b>Brooklyn Local Rating:</b> ${props.bk_local_rating} (${prettyBucket(props.bk_local_bucket)})</div>`;
  }

  if (modeFlags.bronxWashHeightsMode && activeModeTag === "bronx_wash_heights" && Number.isFinite(Number(props.bwh_local_rating))) {
    extra += `<div style="margin-top:6px;"><b>Bronx/Wash Heights Trip Flow:</b> ${props.bwh_local_rating} (${prettyBucket(props.bwh_local_bucket)})</div>`;
  }

  return `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; font-size:13px;">
      <div style="font-weight:800; margin-bottom:2px;">${escapeHtml(zoneName || `Zone ${props.LocationID ?? ""}`)}</div>
      ${borough ? `<div style="opacity:0.8; margin-bottom:6px;">${escapeHtml(borough)}</div>` : `<div style="margin-bottom:6px;"></div>`}
      <div><b>NYC Rating:</b> ${nycRating} (${prettyBucket(nycBucket)})</div>
      ${extra}
      <div style="margin-top:6px;"><b>Pickups (last ${BIN_MINUTES} min):</b> ${pickups}</div>
      <div><b>Next ${BIN_MINUTES} min (historical):</b> ${nextPickups}</div>
      ${communityPickupLine}
      <div><b>Avg Pay per Trip (next ${BIN_MINUTES} min historical):</b> $${nextPay}</div>
      <div><b>Avg Pay per Trip (last 20 min):</b> $${pay}</div>
    </div>
  `;
}

/* =========================================================
   Render frame
   ========================================================= */
async function renderFrame(frame) {
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
  lastRenderedFrameSignature = frameSignature(frame);

  // apply modes to mutate props (same as old)
  const modeFlags = getModeFlags();
  if (modeFlags.queensMode) applyQueensLocalView(frame);
  if (modeFlags.brooklynMode) applyBrooklynLocalView(frame);
  if (modeFlags.bronxWashHeightsMode) applyBronxWashHeightsLocalView(frame);
  if (modeFlags.statenIslandMode) applyStatenLocalView(frame);
  if (modeFlags.manhattanMode) applyManhattanLocalView(frame);

  const fc = frame.polygons || { type: "FeatureCollection", features: [] };

  // IMPORTANT FIX: always recompute effectiveColor each render so toggles update instantly
  for (const f of fc.features) {
    const props = f.properties || {};
    const baseCol =
      effectiveColor(props, f.geometry) ||
      (props?.style?.fillColor || props?.style?.color) ||
      "#66aaff";

    const fillCol =
      window.TlcModeModule?.effectiveFillColor?.(props, f.geometry) ||
      baseCol;

    props.effectiveColor = baseCol;
    props.effectiveFillColor = fillCol;
  }

  if (!debugOnce.frame) {
    console.log("DEBUG frame", { time: frame?.time, featureCount: fc.features.length });
    debugOnce.frame = true;
  }

  map.getSource("zones").setData(fc);

  // Labels update (points inside polygons)
  refreshZoneLabels(frame);

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

  if (fc.features.length > 0 && !didFitToZonesOnce && bounds) {
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
    timeLabel.textContent = `Showing Demand At ${formatNYCTimeOnlyLabel(currentFrame.time)}`;
  }
  updateRecommendation(currentFrame);
  markFirstUsableMap("frame rendered");
}

/* =========================================================
   Load frame / timeline
   ========================================================= */
async function loadFrame(idx, { force = false } = {}) {
  const frameStartedAt = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  const normalizedIdx = Math.max(0, Number(idx) || 0);
  const frameUrl = `${RAILWAY_BASE}/frame/${normalizedIdx}`;
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

  if (debugEnabled) {
    dbg("dbgFrame", `OK ${frameUrl}`);
    dbg("dbgFrameKeys", Object.keys(frame || {}).join(", "));
    dbg("dbgPolyCount", frame?.polygons?.features?.length ?? 0);
  }

  await renderFrame(frame);
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

async function loadTimeline({ force = false } = {}) {
  const timelineStartedAt = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  const timelineUrl = `${RAILWAY_BASE}/timeline`;
  const canReuseTimeline = !force && timelineCache.data && (Date.now() - Number(timelineCache.loadedAt || 0) < TIMELINE_CACHE_TTL_MS);
  if (canReuseTimeline) frontendPerfStats.timelineCacheHits += 1;
  else frontendPerfStats.timelineCacheMisses += 1;
  if (!canReuseTimeline && timelineLoadPromise) return timelineLoadPromise;
  const loadPromise = (async () => {
    if (timelineLoadAbortController) {
      try { timelineLoadAbortController.abort(); } catch (_) {}
    }
    timelineLoadAbortController = new AbortController();
    const t = canReuseTimeline
      ? timelineCache.data
      : await fetchJSON(timelineUrl, { signal: timelineLoadAbortController.signal, cache: force ? "reload" : undefined });
    timelineCache.data = t;
    timelineCache.loadedAt = Date.now();
    timeline = Array.isArray(t) ? t : t.timeline || [];
    if (!timeline.length) throw new Error("Timeline empty. Run /generate once on Railway.");

    if (debugEnabled) dbg("dbgTimeline", `OK ${timelineUrl} count=${timeline.length}`);

    minutesOfWeek = timeline.map(minuteOfWeekFromIso);

    slider.min = "0";
    slider.max = String(timeline.length - 1);
    slider.step = "1";

    const targetMinWeek = getNextBinNowNYCMinuteOfWeek();
    const idx = pickClosestIndex(minutesOfWeek, targetMinWeek);
    slider.value = String(idx);

    bubbleUpdateNow();
    await loadFrame(idx);
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
window.addEventListener("orientationchange", () => enforceSaveButtonTheme());

/* =========================================================
   Auto-center
   ========================================================= */
const btnCenter = document.getElementById("btnCenter");
let autoCenter = true;
let inactivityTimer = null;
const AUTO_FOCUS_INACTIVITY_MS = 20000;
const AUTO_FOCUS_RETURN_ZOOM = 13.0;

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
    const z = clamp(map.getZoom(), AUTO_ZOOM_MIN, AUTO_ZOOM_MAX);
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
  const currentZoom = Number(map.getZoom?.());
  const targetZoom = forceZoom
    ? AUTO_FOCUS_RETURN_ZOOM
    : (Number.isFinite(currentZoom) ? currentZoom : AUTO_FOCUS_RETURN_ZOOM);

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
    const b = map.getBearing ? map.getBearing() : 0;
    lastMapBearingDeg = normDeg(b);
  }

  if (autoCenter && (changed || reason === "inactive-timeout")) {
    refreshAutoCenterCamera({ forceZoom: reason === "inactive-timeout" });
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
  const navLabelHTML = (typeof window !== "undefined" && typeof window.mapIdentityRenderSelfLabel === "function")
    ? window.mapIdentityRenderSelfLabel({
      name: myName,
      avatarUrl: me?.avatar_url,
      mode: me?.map_identity_mode,
      zoom: map?.getZoom?.(),
      leaderboardBadgeCode: me?.leaderboard_badge_code,
      leaderboardHasCrown: !!me?.leaderboard_has_crown,
      orbitMeta: lastSelfOrbitMeta
    })
    : `<div id="navMeName" class="mapPresenceInitials" style="display:${myName ? "flex" : "none"}">${escapeHtml((myName || 'D').slice(0, 2).toUpperCase())}</div>`;

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
      avatarUrl: me?.avatar_url,
      mode: me?.map_identity_mode,
      zoom: map?.getZoom?.(),
      leaderboardBadgeCode: me?.leaderboard_badge_code,
      leaderboardHasCrown: !!me?.leaderboard_has_crown,
      orbitMeta: lastSelfOrbitMeta
    });
  } else {
    const el = document.getElementById("navMeName");
    if (!el) return;
    el.textContent = myName;
    el.style.display = myName ? "block" : "none";
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
      zoom: map.getZoom(),
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

      // Ignore noisy fixes after the initial lock. Otherwise a brief accuracy
      // spike (e.g. 120-300m) can make the marker/presence jump and then snap
      // back, which looks like the map is "confused".
      const hasUsableAccuracy = !Number.isFinite(accuracy) || accuracy <= GPS_ACCURACY_THRESHOLD || !gpsFirstFixDone;
      if (!hasUsableAccuracy) {
        setNavVisual(false);
        return;
      }

      userLatLng = { lat, lng };

      if (navMarker) navMarker.setLngLat([lng, lat]);

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
        gpsFirstFixDone = true;
        const targetZoom = Math.max(map.getZoom(), 12.5);
        suppressAutoDisableFor(1200, () => map.easeTo({
          center: [lng, lat],
          zoom: targetZoom,
          bearing: targetBearing,
          duration: 700,
          essential: true,
        }));
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
          suppressAutoDisableFor(700, () => map.easeTo({
            center: [c.lng, c.lat],
            zoom: map.getZoom(),
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
    if (!timeline.length || !minutesOfWeek.length) return;

    const targetMinWeek = getNextBinNowNYCMinuteOfWeek();
    const bestIdx = pickClosestIndex(minutesOfWeek, targetMinWeek);

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

document.addEventListener("visibilitychange", () => {
  mapPageIsVisible = !document.hidden;
  if (document.visibilityState === "visible") {
    refreshCurrentFrame().catch(() => {});
    tickNYCClockAndAdvanceIfNeeded().catch(() => {});
    updateWeatherNow().catch(() => {});
    refreshPickupOverlay({ force: true }).catch(() => {});
    notePresenceBoost();
    schedulePresencePoll({ immediate: true });
    if (timeline.length) bubbleUpdateNow();
  } else {
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

  const loading = document.getElementById("mapLoading");
  if (loading) loading.style.display = "flex";
  window.setTimeout(() => {
    if (!firstUsableMapRecorded) recordBlankMapWarning("first usable map still pending after 6s");
  }, 6000);
  setTimeout(() => {
    const l = document.getElementById("mapLoading");
    if (l) l.style.display = "none";
  }, 7000);

  preventBrowserZoomUI();
  initMap();
  await loadTimeline();

  // Community/auth bootstrap moved to app.part10.js

  // Start GPS AFTER map exists
  startLocationWatch();
  updateWeatherNow().catch(() => {});
})().catch((err) => {
  console.error(err);
  if (timeLabel) timeLabel.textContent = `Error: ${err?.message || err}`;
});
