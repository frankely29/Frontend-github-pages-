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

/* =========================================================
   COMMUNITY SETTINGS (cheap polling)
   ========================================================= */
const PRESENCE_PUSH_MS = 8 * 1000; // send my location
const PRESENCE_PULL_MS = 10 * 1000; // fetch all drivers
const PRESENCE_STALE_SEC = 70; // hide if older than this

const LS_TOKEN = "community_token_v1";
const LS_EMAIL = "community_email_v1";
const LS_DISPLAY_NAME = "community_display_name_v1";
// NOTE: Chat constants have been moved to app.part2.js.  If you need to override
// them, define `window.CHAT_ROOM` and `window.CHAT_POLL_MS` in your new chat file.
// const CHAT_ROOM = "global";
// const CHAT_POLL_MS = 1200;
const PICKUP_RECENT_LIMIT = 30;
const PICKUP_ZONE_SAMPLE_LIMIT = 100;
const PICKUP_REFRESH_DEBOUNCE_MS = 350;
const PICKUP_FETCH_COOLDOWN_MS = 1200;

// Chat state variables were used by the built‑in chat implementation.  They have
// been migrated to app.part2.js.  Leaving these commented prevents undefined
// variable errors if the old chat logic is removed.
// let chatPollTimer = null;
// let chatLastSeen = null;
// let chatSeenKeys = new Set();
let pickupRefreshTimer = null;
let pickupRefreshInFlight = false;
let pickupLogBusy = false;
let lastPickupFetchMs = 0;
let lastPickupFetchKey = "";
let pickupZoneStats = new Map();
let pickupHotspotZoneIds = new Set();
let pickupPointsSourceFingerprint = "";
let pickupHotspotsSourceFingerprint = "";
let mapPageIsVisible = !document.hidden;

/* =========================================================
   MANHATTAN MODE — DEFAULT SETTINGS (SAFE TO EDIT)
   ========================================================= */
const LS_KEY_MANHATTAN = "manhattan_mode_enabled";

const MANHATTAN_PAY_WEIGHT = 0.55;
const MANHATTAN_VOL_WEIGHT = 0.45;
const MANHATTAN_GLOBAL_PENALTY = 0.98;

const MANHATTAN_MIN_ZONES = 40;
const MANHATTAN_CORE_MAX_LAT = 40.795;

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
   Label visibility rules (kept, but NEW labels are "major map app style")
   ========================================================= */
const LABEL_ZOOM_MIN = 10;
const BOROUGH_ZOOM_SHOW = 15;
const LABEL_MAX_CHARS_MID = 14;

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
async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { cache: "no-store", mode: "cors", ...opts });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} @ ${url} :: ${text.slice(0, 120)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON @ ${url} :: ${text.slice(0, 120)}`);
  }
}
async function postJSON(path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetchJSON(`${RAILWAY_BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body || {}),
  });
}
async function getJSONAuth(path, token) {
  const headers = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetchJSON(`${RAILWAY_BASE}${path}`, { headers });
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
   Label helpers
   ========================================================= */
function shortenLabel(text, maxChars) {
  const t = (text || "").trim();
  if (!t) return "";
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars - 1) + "…";
}

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

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* =========================================================
   Staten Island Mode (local percentile recolor)
   ========================================================= */
const btnStatenIsland = document.getElementById("btnStatenIsland");
const modeNote = document.getElementById("modeNote");

const LS_KEY_STATEN = "staten_island_mode_enabled";
let statenIslandMode = (localStorage.getItem(LS_KEY_STATEN) || "0") === "1";

function isStatenIslandFeature(props) {
  const b = (props?.borough || "").toString().toLowerCase();
  return b.includes("staten");
}

/* =========================================================
   Manhattan Mode
   ========================================================= */
let manhattanMode = (localStorage.getItem(LS_KEY_MANHATTAN) || "0") === "1";

function isManhattanFeature(props) {
  const b = (props?.borough || "").toString().toLowerCase();
  return b.includes("manhattan");
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
   Manhattan core zone check (Uptown exclusion)
   ========================================================= */
function isCoreManhattan(props, geom) {
  if (!isManhattanFeature(props)) return false;
  const c = geometryCenter(geom);
  if (!c || !Number.isFinite(c.lat)) return false;
  return c.lat <= MANHATTAN_CORE_MAX_LAT;
}

/* =========================================================
   Manhattan button (create dynamically)
   ========================================================= */
function ensureManhattanButton() {
  let btn = document.getElementById("btnManhattan");
  if (btn) return btn;

  btn = document.createElement("button");
  btn.id = "btnManhattan";
  btn.type = "button";
  btn.className = "navBtn";
  btn.style.marginLeft = "6px";
  btn.style.padding = "6px 10px";
  btn.style.borderRadius = "10px";
  btn.style.border = "1px solid rgba(0,0,0,0.2)";
  btn.style.background = "rgba(255,255,255,0.95)";
  btn.style.fontWeight = "700";
  btn.style.fontSize = "12px";

  const navRow =
    document.getElementById("navRow") ||
    (legendEl ? legendEl.querySelector(".navRow") : null) ||
    legendEl;

  if (navRow) {
    if (btnStatenIsland && btnStatenIsland.parentElement === navRow) {
      btnStatenIsland.insertAdjacentElement("afterend", btn);
    } else {
      navRow.appendChild(btn);
    }
  } else {
    document.body.appendChild(btn);
  }

  return btn;
}

const btnManhattan = ensureManhattanButton();

function syncManhattanUI() {
  if (!btnManhattan) return;
  btnManhattan.textContent = manhattanMode ? "Manhattan Mode: ON" : "Manhattan Mode: OFF";
  btnManhattan.classList.toggle("on", !!manhattanMode);
}
syncManhattanUI();

if (btnManhattan) {
  btnManhattan.addEventListener("pointerdown", (e) => e.stopPropagation());
  btnManhattan.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });

  btnManhattan.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    manhattanMode = !manhattanMode;
    localStorage.setItem(LS_KEY_MANHATTAN, manhattanMode ? "1" : "0");
    syncManhattanUI();
    if (currentFrame) renderFrame(currentFrame);
  });
}

/* =========================================================
   Shared rating->color helper
   ========================================================= */
function colorFromLocalRating(r) {
  const x = Math.max(1, Math.min(100, Math.round(r)));
  if (x >= 90) return { bucket: "green", color: "#00b050" };
  if (x >= 80) return { bucket: "purple", color: "#8000ff" };
  if (x >= 65) return { bucket: "blue", color: "#0066ff" };
  if (x >= 45) return { bucket: "sky", color: "#66ccff" };
  if (x >= 25) return { bucket: "yellow", color: "#ffd400" };
  return { bucket: "red", color: "#e60000" };
}

function applyStatenLocalView(frame) {
  const feats = frame?.polygons?.features || [];
  if (!feats.length) return frame;

  const siRatings = [];
  for (const f of feats) {
    const props = f.properties || {};
    if (!isStatenIslandFeature(props)) continue;
    const r = Number(props.rating ?? NaN);
    if (!Number.isFinite(r)) continue;
    siRatings.push(r);
  }
  if (siRatings.length < 3) return frame;

  const sorted = siRatings.slice().sort((a, b) => a - b);
  const n = sorted.length;

  function percentileOfRating(r) {
    let lo = 0, hi = n - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] <= r) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (n <= 1) return 0;
    return Math.max(0, Math.min(1, ans / (n - 1)));
  }

  for (const f of feats) {
    const props = f.properties || {};
    if (!isStatenIslandFeature(props)) {
      props.si_local_rating = null;
      props.si_local_bucket = null;
      props.si_local_color = null;
      continue;
    }
    const r = Number(props.rating ?? NaN);
    if (!Number.isFinite(r)) continue;

    const p = percentileOfRating(r);
    const localRating = 1 + 99 * p;

    const { bucket, color } = colorFromLocalRating(localRating);
    props.si_local_rating = Math.round(localRating);
    props.si_local_bucket = bucket;
    props.si_local_color = color;
  }

  return frame;
}

function applyManhattanLocalView(frame) {
  const feats = frame?.polygons?.features || [];
  if (!feats.length) return frame;

  const mPickups = [];
  const mPay = [];

  for (const f of feats) {
    const props = f.properties || {};
    if (!isCoreManhattan(props, f.geometry)) continue;

    const pu = Number(props.pickups ?? NaN);
    const pay = Number(props.avg_driver_pay ?? NaN);

    if (Number.isFinite(pu)) mPickups.push(pu);
    if (Number.isFinite(pay)) mPay.push(pay);
  }

  if (mPickups.length < MANHATTAN_MIN_ZONES || mPay.length < MANHATTAN_MIN_ZONES) {
    for (const f of feats) {
      const props = f.properties || {};
      props.mh_local_rating = null;
      props.mh_local_bucket = null;
      props.mh_local_color = null;
    }
    return frame;
  }

  const pickSorted = mPickups.slice().sort((a, b) => a - b);
  const paySorted = mPay.slice().sort((a, b) => a - b);

  function percentileFromSorted(sorted, v) {
    const n = sorted.length;
    if (n <= 1) return 0;
    let lo = 0, hi = n - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] <= v) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return Math.max(0, Math.min(1, ans / (n - 1)));
  }

  for (const f of feats) {
    const props = f.properties || {};

    if (!isCoreManhattan(props, f.geometry)) {
      props.mh_local_rating = null;
      props.mh_local_bucket = null;
      props.mh_local_color = null;
      continue;
    }

    const pu = Number(props.pickups ?? NaN);
    const pay = Number(props.avg_driver_pay ?? NaN);

    if (!Number.isFinite(pu) || !Number.isFinite(pay)) {
      props.mh_local_rating = null;
      props.mh_local_bucket = null;
      props.mh_local_color = null;
      continue;
    }

    const volP = percentileFromSorted(pickSorted, pu);
    const payP = percentileFromSorted(paySorted, pay);

    let score = MANHATTAN_PAY_WEIGHT * payP + MANHATTAN_VOL_WEIGHT * volP;
    score = Math.max(0, Math.min(1, score));

    let localRating = 1 + 99 * score;
    localRating = localRating * MANHATTAN_GLOBAL_PENALTY;
    localRating = Math.max(1, Math.min(100, localRating));

    const { bucket, color } = colorFromLocalRating(localRating);
    props.mh_local_rating = Math.round(localRating);
    props.mh_local_bucket = bucket;
    props.mh_local_color = color;
  }

  return frame;
}

function syncStatenIslandUI() {
  if (btnStatenIsland) {
    btnStatenIsland.textContent = statenIslandMode ? "Staten Island Mode: ON" : "Staten Island Mode: OFF";
    btnStatenIsland.classList.toggle("on", !!statenIslandMode);
  }
  if (modeNote) {
    modeNote.innerHTML = statenIslandMode
      ? `Staten Island Mode is <b>ON</b>: Staten Island colors are <b>relative within Staten Island</b> only.<br/>Other boroughs remain NYC-wide.`
      : `Colors come from rating (1–100) for the selected 20-minute window.<br/>Time label is NYC time.`;
  }
}
syncStatenIslandUI();

if (btnStatenIsland) {
  btnStatenIsland.addEventListener("pointerdown", (e) => e.stopPropagation());
  btnStatenIsland.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });

  btnStatenIsland.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    statenIslandMode = !statenIslandMode;
    localStorage.setItem(LS_KEY_STATEN, statenIslandMode ? "1" : "0");
    syncStatenIslandUI();
    if (currentFrame) renderFrame(currentFrame);
  });
}

/* =========================================================
   Effective selection helpers
   ========================================================= */
function effectiveBucket(props, geom) {
  if (statenIslandMode && isStatenIslandFeature(props) && props.si_local_bucket) return props.si_local_bucket;
  if (manhattanMode && isCoreManhattan(props, geom) && props.mh_local_bucket) return props.mh_local_bucket;
  return (props.bucket || "").trim();
}
function effectiveColor(props, geom) {
  if (statenIslandMode && isStatenIslandFeature(props) && props.si_local_color) return props.si_local_color;
  if (manhattanMode && isCoreManhattan(props, geom) && props.mh_local_color) return props.mh_local_color;
  const st = props?.style || {};
  return st.fillColor || st.color || "#000";
}
function effectiveRating(props, geom) {
  if (statenIslandMode && isStatenIslandFeature(props) && Number.isFinite(Number(props.si_local_rating))) {
    return Number(props.si_local_rating);
  }
  if (manhattanMode && isCoreManhattan(props, geom) && Number.isFinite(Number(props.mh_local_rating))) {
    return Number(props.mh_local_rating);
  }
  return Number(props.rating ?? NaN);
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
let recommendedDest = null;

function setNavDisabled(disabled) {
  if (!navBtn) return;
  navBtn.classList.toggle("disabled", !!disabled);
}
function setNavDestination(dest) {
  recommendedDest = dest || null;
  if (!navBtn) return;

  if (!recommendedDest) {
    navBtn.href = "#";
    setNavDisabled(true);
    return;
  }

  const { lat, lng } = recommendedDest;
  navBtn.href = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${lat},${lng}`)}&travelmode=driving`;
  setNavDisabled(false);
}

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

function updateRecommendation(frame) {
  if (!recommendEl) return;

  if (!userLatLng) {
    recommendEl.textContent = "Recommended: enable location to get suggestions";
    setNavDestination(null);
    return;
  }

  const feats = frame?.polygons?.features || [];
  if (!feats.length) {
    recommendEl.textContent = "Recommended: …";
    setNavDestination(null);
    return;
  }

  const allowed = new Set(["blue", "purple", "green"]);
  const DIST_PENALTY_PER_MILE = 4.0;

  let best = null;

  for (const f of feats) {
    const props = f.properties || {};
    const geom = f.geometry;

    const b = effectiveBucket(props, geom);
    if (!allowed.has(b)) continue;

    const rating = effectiveRating(props, geom);
    if (!Number.isFinite(rating)) continue;

    const center = geometryCenter(geom);
    if (!center) continue;

    const dMi = haversineMiles(userLatLng, center);
    const score = rating - dMi * DIST_PENALTY_PER_MILE;

    if (!best || score > best.score) {
      best = {
        score,
        dMi,
        rating,
        lat: center.lat,
        lng: center.lng,
        name: (props.zone_name || "").trim() || `Zone ${props.LocationID ?? ""}`,
        borough: (props.borough || "").trim(),
        usedSI: statenIslandMode && isStatenIslandFeature(props) && Number.isFinite(Number(props.si_local_rating)),
        usedMH: manhattanMode && isCoreManhattan(props, geom) && Number.isFinite(Number(props.mh_local_rating)),
      };
    }
  }

  if (!best) {
    recommendEl.textContent = "Recommended: no Blue+ zone nearby right now";
    setNavDestination(null);
    return;
  }

  const distTxt = best.dMi >= 10 ? `${best.dMi.toFixed(0)} mi` : `${best.dMi.toFixed(1)} mi`;
  const bTxt = best.borough ? ` (${best.borough})` : "";
  const modeTag = best.usedSI ? " (SI-local)" : best.usedMH ? " (Manhattan-adjusted)" : "";
  recommendEl.textContent = `Recommended: ${best.name}${bTxt} — Rating ${best.rating}${modeTag} — ${distTxt}`;

  setNavDestination({ lat: best.lat, lng: best.lng });
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
  [dockColors, dockModes, dockChat, dockGames, dockMusic, dockProfile, dockLeaderboard].forEach((b) => b && b.classList.remove("dockBtnActive"));
  if (openPanelKey === "colors") dockColors?.classList.add("dockBtnActive");
  if (openPanelKey === "modes") dockModes?.classList.add("dockBtnActive");
  if (openPanelKey === "chat") dockChat?.classList.add("dockBtnActive");
  if (openPanelKey === "games") dockGames?.classList.add("dockBtnActive");
  if (openPanelKey === "music") dockMusic?.classList.add("dockBtnActive");
  if (openPanelKey === "profile") dockProfile?.classList.add("dockBtnActive");
  if (openPanelKey === "leaderboard") dockLeaderboard?.classList.add("dockBtnActive");
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
  return `
    <div class="panelBlock">
      <div style="font-weight:700;margin-bottom:8px;">${escapeHtml(recommendEl?.textContent || "")}</div>

      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
        <button id="dockAuthBtn" class="chipBtn">${authHeaderOK() ? "Sign out" : "Sign in"}</button>
        <a id="dockNavBtn" class="chipBtn ${recommendedDest ? "" : "disabled"}" href="${navBtn?.href || "#"}" target="_blank" rel="noopener">Navigate</a>
      </div>

      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
        <button id="dockStatenBtn" class="chipBtn">${statenIslandMode ? "Staten Island: ON" : "Staten Island: OFF"}</button>
        <button id="dockManhattanBtn" class="chipBtn">${manhattanMode ? "Manhattan: ON" : "Manhattan: OFF"}</button>
        <button id="dockGhostBtn" class="chipBtn">${me?.ghost_mode ? "Ghost: ON" : "Ghost: OFF"}</button>
      </div>

      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <button id="dockPoliceBtn" class="chipBtn"><span aria-hidden="true" style="display:inline-grid;place-items:center;line-height:1;vertical-align:middle;margin-right:6px;"><svg viewBox="0 0 24 24" width="12" height="12" focusable="false" style="display:block"><path d="M12 2.2 4.2 6v6.1c0 4.4 3 8.3 7.8 9.7 4.8-1.4 7.8-5.3 7.8-9.7V6L12 2.2Z" fill="currentColor"/><path d="M12 6.7v5.2" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="15.4" r="1.2" fill="#fff"/></svg></span>Police</button>
        <button id="dockPickupBtn" class="chipBtn"><span aria-hidden="true" style="display:inline-grid;place-items:center;line-height:1;vertical-align:middle;margin-right:6px;"><svg viewBox="0 0 24 24" width="12" height="12" focusable="false" style="display:block"><circle cx="12" cy="12" r="9" fill="currentColor"/><path d="m8 12.4 2.5 2.6 5.5-5.6" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>Record Trip</button>
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
    statenIslandMode = !statenIslandMode;
    localStorage.setItem(LS_KEY_STATEN, statenIslandMode ? "1" : "0");
    syncStatenIslandUI();
    if (currentFrame) renderFrame(currentFrame);
    openDrawer("modes", "Modes", modesPanelHTML());
    wireModesPanel();
  });

  document.getElementById("dockManhattanBtn")?.addEventListener("click", (e) => {
    e.preventDefault();
    manhattanMode = !manhattanMode;
    localStorage.setItem(LS_KEY_MANHATTAN, manhattanMode ? "1" : "0");
    syncManhattanUI();
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
        ${statenIslandMode
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
    <span style="font-size:22px; line-height:1;">💬</span>
  `);

  setIcon(dockGames, `
    <span style="font-size:22px; line-height:1;">🎮</span>
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
    loadFrame(idx).catch(console.error);
  });
}

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
    mapReady = true;
    map.resize();
    applyNightBasemap(!!wxState?.isNight);

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
        scheduleAdaptivePresenceRender();
        schedulePickupOverlayRefresh();
      }
      applyDriverLabelZoomStyles();
    });
    map.on("zoomend", () => {
      if (authHeaderOK()) {
        scheduleAdaptivePresenceRender();
        schedulePickupOverlayRefresh();
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

    document.addEventListener("pointerdown", resetInactivityTimer, { passive: true });
    document.addEventListener("touchstart", resetInactivityTimer, { passive: true });
    resetInactivityTimer();

    map.on("click", (e) => {
      const features = map.queryRenderedFeatures(e.point, { layers: ["zones-fill"] });
      if (!features.length) closeAllPanels();
    });

    const loading = document.getElementById("mapLoading");
    if (loading) loading.style.display = "none";

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

async function ensureZonesSourceAndLayers() {
  if (!map) return false;
  const styleReady = await waitForStyleReady();
  if (!styleReady) return false;

  // Polygons source
  if (!map.getSource("zones")) {
    map.addSource("zones", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  }

  // Fill
  if (!map.getLayer("zones-fill")) {
    map.addLayer({
      id: "zones-fill",
      type: "fill",
      source: "zones",
      paint: {
        "fill-color": ["coalesce", ["to-string", ["get", "effectiveColor"]], "#66aaff"],
        "fill-opacity": 0.82,
      },
    });
  }

  // Outline
  if (!map.getLayer("zones-line")) {
    map.addLayer({
      id: "zones-line",
      type: "line",
      source: "zones",
      paint: { "line-color": "#ffffff", "line-width": 1, "line-opacity": 1 },
    });
  }

  // Labels source (points INSIDE polygons)
  if (!map.getSource("zone-labels")) {
    map.addSource("zone-labels", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  }

  // Labels layer (clean, professional, fun)
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
          07, 00,
          08, 00,
          09, 00,
          10, 00,
          11, 05,
          12, 09,
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

  await ensurePickupSourceAndLayers();
  return true;
}

function emptyGeojson() {
  return { type: "FeatureCollection", features: [] };
}

function clearPickupOverlayCache() {
  pickupZoneStats = new Map();
  pickupHotspotZoneIds = new Set();
  pickupPointsSourceFingerprint = "";
  pickupHotspotsSourceFingerprint = "";
  lastPickupFetchKey = "";
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
    const signature = props?.signature;
    if (signature != null && signature !== "") {
      rows.push([
        String(zoneId),
        String(signature),
        Number.isFinite(sampleSize) ? String(sampleSize) : "",
        Number.isFinite(intensity) ? String(intensity) : "",
      ].join("|"));
      continue;
    }
    const latestCreatedAt = Number(props?.latest_created_at ?? NaN);
    rows.push([
      String(zoneId),
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

function setPickupOverlayData(fc, items = [], zoneStats = [], zoneHotspots = emptyGeojson()) {
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

  for (const feat of validatedZoneHotspots.features) {
    const zoneId = feat?.properties?.zone_id;
    if (zoneId != null) pickupHotspotZoneIds.add(String(zoneId));
  }

  const hotspotFingerprint = pickupHotspotsFingerprint(validatedZoneHotspots);
  const hotspotSrc = map?.getSource?.("pickup-zone-hotspots");
  if (hotspotSrc && typeof hotspotSrc.setData === "function" && hotspotFingerprint !== pickupHotspotsSourceFingerprint) {
    hotspotSrc.setData(validatedZoneHotspots);
    pickupHotspotsSourceFingerprint = hotspotFingerprint;
  }

  const filteredFeatures = Array.isArray(fc?.features)
    ? fc.features.filter((feat) => {
      const zoneId = feat?.properties?.zone_id;
      return zoneId == null || !pickupHotspotZoneIds.has(String(zoneId));
    })
    : [];
  const filteredPickupPointsFc = { type: "FeatureCollection", features: filteredFeatures };
  const visiblePointsFingerprint = pickupPointsFingerprintFromFeatures(filteredPickupPointsFc);

  const src = map?.getSource?.("pickup-points");
  if (src && typeof src.setData === "function" && visiblePointsFingerprint !== pickupPointsSourceFingerprint) {
    src.setData(filteredPickupPointsFc);
    pickupPointsSourceFingerprint = visiblePointsFingerprint;
  }
}

function clearPickupOverlay() {
  setPickupOverlayData(emptyGeojson(), [], [], emptyGeojson());
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
            "#fffdf3",
            0.45,
            "#fff9de",
            0.75,
            "#fff6cf",
            1.00,
            "#fff3c2",
          ],
          "fill-opacity": [
            "interpolate",
            ["linear"],
            ["coalesce", ["get", "intensity"], 0.35],
            0.00,
            0.18,
            0.45,
            0.24,
            0.75,
            0.30,
            1.00,
            0.36,
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
      "#fffdf3",
      0.45,
      "#fff9de",
      0.75,
      "#fff6cf",
      1.00,
      "#fff3c2",
    ]);
    map.setPaintProperty("pickup-zone-hotspots-underpaint", "fill-opacity", [
      "interpolate",
      ["linear"],
      ["coalesce", ["get", "intensity"], 0.35],
      0.00,
      0.18,
      0.45,
      0.24,
      0.75,
      0.30,
      1.00,
      0.36,
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
            "#8df4ff",
            0.45,
            "#4ce4f2",
            0.75,
            "#17d3e6",
            1.00,
            "#00c2d8",
          ],
          "fill-opacity": [
            "interpolate",
            ["linear"],
            ["coalesce", ["get", "intensity"], 0.35],
            0.00,
            0.18,
            0.45,
            0.28,
            0.75,
            0.38,
            1.00,
            0.50,
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
      "#8df4ff",
      0.45,
      "#4ce4f2",
      0.75,
      "#17d3e6",
      1.00,
      "#00c2d8",
    ]);
    map.setPaintProperty("pickup-zone-hotspots-fill", "fill-opacity", [
      "interpolate",
      ["linear"],
      ["coalesce", ["get", "intensity"], 0.35],
      0.00,
      0.18,
      0.45,
      0.28,
      0.75,
      0.38,
      1.00,
      0.50,
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
            "#f8ffff",
            0.45,
            "#dfffff",
            0.75,
            "#b8fbff",
            1.00,
            "#8df4ff",
          ],
          "line-opacity": [
            "interpolate",
            ["linear"],
            ["coalesce", ["get", "intensity"], 0.35],
            0.00,
            0.72,
            0.45,
            0.82,
            0.75,
            0.90,
            1.00,
            0.96,
          ],
          "line-width": [
            "interpolate",
            ["linear"],
            ["coalesce", ["get", "intensity"], 0.35],
            0.00,
            1.8,
            0.45,
            2.4,
            0.75,
            3.0,
            1.00,
            3.6,
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
      "#f8ffff",
      0.45,
      "#dfffff",
      0.75,
      "#b8fbff",
      1.00,
      "#8df4ff",
    ]);
    map.setPaintProperty("pickup-zone-hotspots-line", "line-opacity", [
      "interpolate",
      ["linear"],
      ["coalesce", ["get", "intensity"], 0.35],
      0.00,
      0.72,
      0.45,
      0.82,
      0.75,
      0.90,
      1.00,
      0.96,
    ]);
    map.setPaintProperty("pickup-zone-hotspots-line", "line-width", [
      "interpolate",
      ["linear"],
      ["coalesce", ["get", "intensity"], 0.35],
      0.00,
      1.8,
      0.45,
      2.4,
      0.75,
      3.0,
      1.00,
      3.6,
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
              <div style="font-weight:900; margin-bottom:4px;">Community trip</div>
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
        new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: "290px" })
          .setLngLat(e.lngLat)
          .setHTML(`
            <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; font-size:13px;">
              <div style="font-weight:900; margin-bottom:4px;">Community hotspot</div>
              <div><b>Zone:</b> ${escapeHtml(zoneName || `Zone ${props.zone_id || ""}`)}</div>
              ${borough ? `<div><b>Borough:</b> ${escapeHtml(borough)}</div>` : ""}
              <div><b>Sample size:</b> ${safeSampleSize}</div>
              <div style="margin-top:6px;">Community hotspot from recent recorded trips.</div>
              <div style="opacity:0.8; margin-top:2px;">Dynamic hotspot from latest ${PICKUP_ZONE_SAMPLE_LIMIT} trips max.</div>
            </div>
          `)
          .addTo(map);
      } catch (err) {
        console.warn("pickup hotspot popup failed:", err);
      }
    });
  }

  return true;
}

function pickupOverlayQueryPath(limit = PICKUP_RECENT_LIMIT) {
  if (!map) return null;
  const b = map.getBounds();
  if (!b) return null;
  const west = Number(b.getWest());
  const east = Number(b.getEast());
  const south = Number(b.getSouth());
  const north = Number(b.getNorth());
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

async function refreshPickupOverlay({ force = false } = {}) {
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

  const now = Date.now();
  if (!force && pickupRefreshInFlight) return;
  if (!force && path === lastPickupFetchKey && now - lastPickupFetchMs < PICKUP_FETCH_COOLDOWN_MS) return;

  pickupRefreshInFlight = true;
  lastPickupFetchKey = path;
  lastPickupFetchMs = now;

  try {
    const data = await getJSONAuth(path, communityToken);
    const items = Array.isArray(data) ? data : data?.items || [];
    const zoneStats = Array.isArray(data?.zone_stats) ? data.zone_stats : [];
    const zoneHotspots = (data?.zone_hotspots && data.zone_hotspots.type === "FeatureCollection" && Array.isArray(data.zone_hotspots.features))
      ? data.zone_hotspots
      : emptyGeojson();
    const fc = buildPickupFeatureCollection(items);
    setPickupOverlayData(fc, items, zoneStats, zoneHotspots);
  } catch (e) {
    console.warn("pickup overlay refresh failed:", e);
  } finally {
    pickupRefreshInFlight = false;
  }
}

function schedulePickupOverlayRefresh({ force = false } = {}) {
  if (pickupRefreshTimer) clearTimeout(pickupRefreshTimer);
  pickupRefreshTimer = setTimeout(() => {
    pickupRefreshTimer = null;
    refreshPickupOverlay({ force }).catch((e) => console.warn("pickup overlay refresh failed:", e));
  }, force ? 0 : PICKUP_REFRESH_DEBOUNCE_MS);
}

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
   Label point computation (inside polygon) — for “major map app” behavior
   - We DO NOT modify polygon geometry arrays.
   - We create a separate point FeatureCollection for labels.
   ========================================================= */

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function bboxFromCoords(coords) {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
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

// ray-casting point in ring
function pointInRing(ptLng, ptLat, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect =
      ((yi > ptLat) !== (yj > ptLat)) &&
      (ptLng < ((xj - xi) * (ptLat - yi)) / (yj - yi + 1e-15) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// point in polygon (outer + holes)
function pointInPolygonLngLat(ptLng, ptLat, polyCoords) {
  if (!Array.isArray(polyCoords) || polyCoords.length === 0) return false;
  const outer = polyCoords[0];
  if (!pointInRing(ptLng, ptLat, outer)) return false;

  // holes: if inside any hole => outside
  for (let i = 1; i < polyCoords.length; i++) {
    if (pointInRing(ptLng, ptLat, polyCoords[i])) return false;
  }
  return true;
}

// choose largest polygon in multipolygon by bbox area (cheap & stable)
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

// Find a point inside polygon. Start at centroid; if outside, spiral search inside bbox.
function findInteriorPointForGeometry(geom) {
  if (!geom) return null;

  let poly = null;
  if (geom.type === "Polygon") poly = geom.coordinates;
  else if (geom.type === "MultiPolygon") poly = pickLargestPolygonFromMulti(geom.coordinates);
  else return null;

  if (!poly) return null;

  const bb = bboxFromCoords(poly);
  if (!bb) return null;

  // seed = centroid (area-weighted)
  let seed = geometryCenter({ type: "Polygon", coordinates: poly });
  if (seed && Number.isFinite(seed.lng) && Number.isFinite(seed.lat)) {
    if (pointInPolygonLngLat(seed.lng, seed.lat, poly)) return seed;
  }

  // fallback seed = bbox center
  const cx = (bb.minLng + bb.maxLng) / 2;
  const cy = (bb.minLat + bb.maxLat) / 2;
  if (pointInPolygonLngLat(cx, cy, poly)) return { lng: cx, lat: cy };

  // spiral search around bbox center
  const w = bb.maxLng - bb.minLng;
  const h = bb.maxLat - bb.minLat;

  // step size scaled by bbox
  const stepLng = Math.max(w / 40, 1e-4);
  const stepLat = Math.max(h / 40, 1e-4);

  const maxR = 60; // attempts radius steps
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

  // last fallback: bbox center even if not perfect (should be rare)
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
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
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

async function loadNextFramePickupsMap(curIdx) {
  try {
    if (!timeline.length) return;

    const nextIdx = Math.min(timeline.length - 1, Number(curIdx) + 1);
    if (nextIdx === Number(curIdx)) {
      nextFramePickupsById = new Map();
      nextFramePayById = new Map();
      return;
    }

    const frame = await fetchJSON(`${RAILWAY_BASE}/frame/${nextIdx}`);
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

  if (statenIslandMode && isStatenIslandFeature(props) && Number.isFinite(Number(props.si_local_rating))) {
    extra += `<div style="margin-top:6px;"><b>Staten Local Rating:</b> ${props.si_local_rating} (${prettyBucket(props.si_local_bucket)})</div>`;
  }

  if (manhattanMode && isCoreManhattan(props, geom) && Number.isFinite(Number(props.mh_local_rating))) {
    extra += `<div style="margin-top:6px;"><b>Manhattan Adjusted:</b> ${props.mh_local_rating} (${prettyBucket(props.mh_local_bucket)})</div>`;
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

/* =========================================================
   Label refresh (MapLibre symbol layer)
   ========================================================= */
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
  if (!map || !mapReady) return;
  if (!frame) return;
  const src = map.getSource("zone-labels");
  if (!src) return;

  const fc = buildZoneLabelsFeatureCollection(frame);
  src.setData(fc);
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

  // apply modes to mutate props (same as old)
  if (statenIslandMode) applyStatenLocalView(frame);
  if (manhattanMode) applyManhattanLocalView(frame);

  const fc = frame.polygons || { type: "FeatureCollection", features: [] };

  // IMPORTANT FIX: always recompute effectiveColor each render so toggles update instantly
  for (const f of fc.features) {
    const props = f.properties || {};
    const col = effectiveColor(props, f.geometry) || (props?.style?.fillColor || props?.style?.color) || "#66aaff";
    props.effectiveColor = col;
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
}

/* =========================================================
   Load frame / timeline
   ========================================================= */
async function loadFrame(idx) {
  const frameUrl = `${RAILWAY_BASE}/frame/${idx}`;
  loadNextFramePickupsMap(idx).catch(() => {});
  const frame = await fetchJSON(frameUrl);

  if (debugEnabled) {
    dbg("dbgFrame", `OK ${frameUrl}`);
    dbg("dbgFrameKeys", Object.keys(frame || {}).join(", "));
    dbg("dbgPolyCount", frame?.polygons?.features?.length ?? 0);
  }

  await renderFrame(frame);
}

async function loadTimeline() {
  const timelineUrl = `${RAILWAY_BASE}/timeline`;
  const t = await fetchJSON(timelineUrl);
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
});

/* =========================================================
   Auto-center
   ========================================================= */
const btnCenter = document.getElementById("btnCenter");
let autoCenter = true;
let inactivityTimer = null;

function resetInactivityTimer() {
  clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(() => {
    if (!autoCenter) {
      autoCenter = true;
      syncCenterButton();
      if (typeof autoCenterAndAutoZoom === "function") {
        autoCenterAndAutoZoom();
      }
    }
  }, 30000);
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
syncCenterButton();

if (btnCenter) {
  btnCenter.addEventListener("pointerdown", (e) => e.stopPropagation());
  btnCenter.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });

  // --- center helper: always use the navMarker's real position (arrow) ---
  function getSelfCenterLngLat() {
    if (navMarker && typeof navMarker.getLngLat === "function") {
      const p = navMarker.getLngLat();
      if (p && Number.isFinite(p.lng) && Number.isFinite(p.lat)) return { lng: p.lng, lat: p.lat };
    }
    if (userLatLng && Number.isFinite(userLatLng.lng) && Number.isFinite(userLatLng.lat)) return { lng: userLatLng.lng, lat: userLatLng.lat };
    return null;
  }

  btnCenter.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();

    autoCenter = !autoCenter;
    syncCenterButton();

    if (autoCenter && map) {
      const c = getSelfCenterLngLat();
      if (c) {
        suppressAutoDisableFor(900, () => {
          map.flyTo({
            center: [c.lng, c.lat],
            zoom: Math.max(map.getZoom(), 13.0),
            bearing: Number.isFinite(lastHeadingDeg) ? normDeg(lastHeadingDeg) : map.getBearing(),
            duration: 600
          });
        });
      }
    } else if (map && mapReady) {
      const b = map.getBearing ? map.getBearing() : 0;
      lastMapBearingDeg = normDeg(b);
    }
  });
}

function disableAutoCenterBecauseUserIsExploring() {
  if (Date.now() < suppressAutoDisableUntil) return;
  if (!autoCenter) return;
  autoCenter = false;
  syncCenterButton();
  resetInactivityTimer();
}

/* =========================================================
   Live location arrow + follow behavior
   ========================================================= */
let gpsFirstFixDone = false;
let navMarker = null;
let lastPos = null;
let lastHeadingDeg = 0;
let lastMoveTs = 0;

function makeNavIcon() {
  const myName = authHeaderOK() ? me?.display_name || "" : "";
  const navLabelHTML = (typeof window !== "undefined" && typeof window.mapIdentityRenderSelfLabel === "function")
    ? window.mapIdentityRenderSelfLabel({
      name: myName,
      avatarUrl: me?.avatar_url,
      mode: me?.map_identity_mode,
      zoom: map?.getZoom?.(),
      leaderboardBadgeCode: me?.leaderboard_badge_code,
      leaderboardHasCrown: !!me?.leaderboard_has_crown
    })
    : `<div id="navMeName" class="meName" style="display:${myName ? "block" : "none"}">${escapeHtml(myName)}</div>`;
  const el = document.createElement("div");
  el.innerHTML = `
    <div id="navWrap" class="navArrowWrap navPulse">
      <div id="navArrowRot" class="navArrowRot"><div class="navArrow"></div></div>
      ${navLabelHTML}
    </div>
  `;
  return el;
}

function wireProfileOpenTargets(rootEl, userId, options = {}) {
  if (!rootEl || !userId) return;
  const normalizedUserId = Number(userId);
  if (!Number.isFinite(normalizedUserId)) return;
  const isSelf = !!options?.isSelf;
  const selectorList = isSelf
    ? ["#navWrap", ".selfIdentitySlot", ".meAvatarBadge", ".meName", ".mapIdentityWrap", ".mapIdentityCore"]
    : [".otherDrvWrap", ".otherDrvIdentitySlot", ".otherDrvAvatarBadge", ".otherDrvName", ".mapIdentityWrap", ".mapIdentityCore"];
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
    const current = wrap.querySelector("[data-map-identity-label='1']");
    if (current) current.remove();
    wrap.insertAdjacentHTML(
      "beforeend",
      window.mapIdentityRenderSelfLabel({
        name: myName,
        avatarUrl: me?.avatar_url,
        mode: me?.map_identity_mode,
        zoom: map?.getZoom?.(),
        leaderboardBadgeCode: me?.leaderboard_badge_code,
        leaderboardHasCrown: !!me?.leaderboard_has_crown
      })
    );
  } else {
    const el = document.getElementById("navMeName");
    if (!el) return;
    el.textContent = myName;
    el.style.display = myName ? "block" : "none";
  }
  const navWrap = document.getElementById("navWrap");
  if (navWrap) wireProfileOpenTargets(navWrap, me?.id, { isSelf: true });
  applyDriverLabelZoomStyles();
}

function setNavVisual(isMoving) {
  const el = document.getElementById("navWrap");
  if (!el) return;
  el.classList.toggle("navMoving", !!isMoving);
  el.classList.toggle("navPulse", !isMoving);
}
function setNavRotation(deg) {
  const el = document.getElementById("navArrowRot");
  if (!el) return;
  let relative = deg;
  if (map && typeof map.getBearing === "function") {
    const bearing = Number(map.getBearing()) || 0;
    relative = normDeg(deg - bearing);
  }
  el.style.transform = `rotate(${relative}deg)`;
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
    const idx = Number(slider.value || "0");
    await loadFrame(idx);
  } catch (e) {
    console.warn("Auto-refresh failed:", e);
  }
}
setInterval(refreshCurrentFrame, REFRESH_MS);

async function tickNYCClockAndAdvanceIfNeeded() {
  try {
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
setInterval(tickNYCClockAndAdvanceIfNeeded, NYC_CLOCK_TICK_MS);

document.addEventListener("visibilitychange", () => {
  mapPageIsVisible = !document.hidden;
  if (document.visibilityState === "visible") {
    refreshCurrentFrame().catch(() => {});
    tickNYCClockAndAdvanceIfNeeded().catch(() => {});
    updateWeatherNow().catch(() => {});
    refreshPickupOverlay({ force: true }).catch(() => {});
    pullPresenceAll().catch(() => {});
    if (timeline.length) bubbleUpdateNow();
  }
});

/* =========================================================
   WEATHER BADGE + FX (unchanged from old)
   ========================================================= */
const weatherBadge = document.getElementById("weatherBadge");

/* =========================================================
   ONLINE USERS BADGE
   ========================================================= */
// Grab the online users badge element.  This badge mirrors the weather badge
// but sits on the left side of the screen.  It displays the number of drivers
// currently online.  The count is updated in pullPresenceAll().
const onlineBadge = document.getElementById("onlineBadge");
function updateOnlineBadge(count, ghostedCount = 0) {
  if (!onlineBadge) return;
  // Constrain the count to a non-negative integer.
  const n = Number(count);
  const display = Number.isFinite(n) && n >= 0 ? n : 0;
  const g = Number(ghostedCount);
  const ghostedDisplay = Number.isFinite(g) && g >= 0 ? g : 0;
  const mainLine = `${display} online`;
  const txtEl = onlineBadge.querySelector(".onlineTxt") || onlineBadge.querySelector("#onlineTxt");
  if (txtEl) {
    txtEl.textContent = mainLine;
  } else {
    // Compatibility fallback for older single-line badge markup.
    const textWrapEl = onlineBadge.querySelector(".onlineTextWrap");
    if (textWrapEl) {
      textWrapEl.textContent = mainLine;
    } else {
      onlineBadge.textContent = mainLine;
    }
  }
  const ghostTxtEl = onlineBadge.querySelector(".onlineGhostTxt");
  if (ghostTxtEl) {
    if (ghostedDisplay > 0) {
      ghostTxtEl.textContent = `${ghostedDisplay} Ghosted`;
      ghostTxtEl.hidden = false;
    } else {
      ghostTxtEl.hidden = true;
    }
  }
  onlineBadge.title = ghostedDisplay > 0
    ? `${display} online • ${ghostedDisplay} ghosted`
    : `${display} online`;
}

function applyBadgeIconModel() {

  const setIconMarkup = (iconEl, svgMarkup) => {
    if (!iconEl) return;
    iconEl.innerHTML = svgMarkup;
    iconEl.style.fontSize = "0";
    iconEl.style.display = "inline-grid";
    iconEl.style.placeItems = "center";
    iconEl.style.lineHeight = "1";
  };

  const onlineIconEl = onlineBadge?.querySelector?.(".onlineIcon");
  setIconMarkup(
    onlineIconEl,
    `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false" style="display:block"><circle cx="8" cy="10" r="3.3" fill="currentColor"/><circle cx="16.3" cy="10.6" r="2.7" fill="currentColor" opacity="0.88"/><path d="M2.8 19a5.2 5.2 0 0 1 10.4 0M12 19a4.3 4.3 0 0 1 8.6 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`
  );

  const weatherIconEl = weatherBadge?.querySelector?.(".wxIcon");
  setIconMarkup(
    weatherIconEl,
    `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false" style="display:block"><circle cx="9" cy="8" r="3" fill="currentColor" opacity="0.95"/><path d="M9 4.4v1.4M5.4 8H4M14 8h1.4M6.5 5.6l-1-1M11.5 5.6l1-1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M8.4 18.2h8a3.1 3.1 0 0 0 .1-6.2 4.4 4.4 0 0 0-8.2 1.7A2.4 2.4 0 0 0 8.4 18.2Z" fill="currentColor"/></svg>`
  );

  const pickupIconEl = document.querySelector("#pickupFab .pickupFabIcon");
  setIconMarkup(
    pickupIconEl,
    `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false" style="display:block"><circle cx="12" cy="12" r="9" fill="#24c862"/><path d="m7.4 12.3 3 3.1 6.2-6.1" fill="none" stroke="#ffffff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`
  );
}

applyBadgeIconModel();

const wxCanvas = document.getElementById("wxCanvas");
const wxCtx = wxCanvas ? wxCanvas.getContext("2d") : null;

let wxState = {
  kind: "none",
  intensity: 0,
  isNight: false,
  tempF: null,
  label: "Weather…",
  lastLat: null,
  lastLng: null,
};

let wxParticles = [];
let wxAnimRunning = false;
let wxNextUpdateTimer = null;

function wxResizeCanvas() {
  if (!wxCanvas) return;
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  wxCanvas.width = Math.floor(window.innerWidth * dpr);
  wxCanvas.height = Math.floor(window.innerHeight * dpr);
  wxCanvas.style.width = `${window.innerWidth}px`;
  wxCanvas.style.height = `${window.innerHeight}px`;
  if (wxCtx) wxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", wxResizeCanvas);
wxResizeCanvas();

function wxDescribe(code) {
  const c = Number(code);
  if (c === 0) return { text: "Clear", icon: "☀️", kind: "none", intensity: 0 };
  if (c >= 1 && c <= 3) return { text: "Cloudy", icon: "⛅", kind: "none", intensity: 0 };
  if (c === 45 || c === 48) return { text: "Fog", icon: "🌫️", kind: "none", intensity: 0 };
  if ((c >= 51 && c <= 57) || (c >= 61 && c <= 67) || (c >= 80 && c <= 82)) {
    const intensity = c >= 65 || c >= 81 ? 0.85 : c >= 63 ? 0.65 : 0.45;
    return { text: "Rain", icon: "🌧️", kind: "rain", intensity };
  }
  if ((c >= 71 && c <= 77) || (c >= 85 && c <= 86)) {
    const intensity = c >= 75 || c >= 86 ? 0.85 : 0.6;
    return { text: "Snow", icon: "❄️", kind: "snow", intensity };
  }
  if (c >= 95 && c <= 99) return { text: "Storm", icon: "⛈️", kind: "rain", intensity: 0.95 };
  return { text: "Weather", icon: "⛅", kind: "none", intensity: 0 };
}
function fFromC(c) {
  if (!Number.isFinite(c)) return null;
  return (c * 9) / 5 + 32;
}
function setBodyTheme({ isNight, isSunny }) {
  document.body.classList.toggle("night", !!isNight);
  document.body.classList.toggle("sunny", !!isSunny && !isNight);
  applyNightBasemap(!!isNight);
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
function getWeatherIconMarkup(icon) {
  const iconMap = {
    "☀️": `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false" style="display:block"><circle cx="12" cy="12" r="4" fill="currentColor"/><path d="M12 2.2v2.4M12 19.4v2.4M2.2 12h2.4M19.4 12h2.4M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M4.9 19.1l1.7-1.7M17.4 6.6l1.7-1.7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
    "⛅": `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false" style="display:block"><circle cx="9" cy="8" r="3" fill="currentColor" opacity="0.95"/><path d="M9 4.4v1.4M5.4 8H4M14 8h1.4M6.5 5.6l-1-1M11.5 5.6l1-1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M8.4 18.2h8a3.1 3.1 0 0 0 .1-6.2 4.4 4.4 0 0 0-8.2 1.7A2.4 2.4 0 0 0 8.4 18.2Z" fill="currentColor"/></svg>`,
    "🌫️": `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false" style="display:block"><path d="M3 8.5h18M2.5 12h15M5 15.5h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
    "🌧️": `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false" style="display:block"><path d="M7.5 13.2h9a3.3 3.3 0 0 0 .1-6.6 4.7 4.7 0 0 0-8.8 1.8 2.8 2.8 0 0 0-.3 5.6Z" fill="currentColor"/><path d="M9 15.2l-1.1 2M12 15.8l-1.1 2M15 15.2l-1.1 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
    "❄️": `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false" style="display:block"><path d="M12 4v16M5 8l14 8M19 8 5 16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/></svg>`,
    "⛈️": `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false" style="display:block"><path d="M7.5 12.8h9a3.3 3.3 0 0 0 .1-6.6 4.7 4.7 0 0 0-8.8 1.8 2.8 2.8 0 0 0-.3 5.6Z" fill="currentColor"/><path d="m12.2 13.2-1.6 3h1.5l-1 3 3-4h-1.8l1.3-2.4Z" fill="currentColor"/></svg>`,
  };
  return iconMap[icon] || icon;
}

function setWeatherBadge(icon, text) {
  if (!weatherBadge) return;
  const iconEl = weatherBadge.querySelector(".wxIcon");
  const txtEl = weatherBadge.querySelector(".wxTxt");
  if (iconEl) {
    const markup = getWeatherIconMarkup(icon);
    if (typeof markup === "string" && markup.startsWith("<svg")) {
      iconEl.innerHTML = markup;
      iconEl.style.fontSize = "0";
      iconEl.style.display = "inline-grid";
      iconEl.style.placeItems = "center";
      iconEl.style.lineHeight = "1";
    } else {
      iconEl.textContent = icon;
      iconEl.style.removeProperty("font-size");
      iconEl.style.removeProperty("display");
      iconEl.style.removeProperty("place-items");
      iconEl.style.removeProperty("line-height");
    }
  }
  if (txtEl) txtEl.textContent = text;
  weatherBadge.title = text;
}
function getWeatherLatLng() {
  const lat = userLatLng?.lat ?? 40.7128;
  const lng = userLatLng?.lng ?? -74.006;
  return { lat, lng };
}
function scheduleWeatherUpdateSoon() {
  if (wxNextUpdateTimer) return;
  wxNextUpdateTimer = setTimeout(() => {
    wxNextUpdateTimer = null;
    updateWeatherNow().catch(() => {});
  }, 2500);
}
async function updateWeatherNow() {
  const { lat, lng } = getWeatherLatLng();

  wxState.lastLat = lat;
  wxState.lastLng = lng;

  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${encodeURIComponent(lat)}` +
    `&longitude=${encodeURIComponent(lng)}` +
    `&current=temperature_2m,weather_code,is_day` +
    `&timezone=America%2FNew_York`;

  try {
    const data = await fetchJSON(url);
    const cur = data?.current || {};
    const tempC = Number(cur.temperature_2m ?? NaN);
    const tempF = fFromC(tempC);
    const code = cur.weather_code;
    const isDay = Number(cur.is_day ?? 1) === 1;

    const desc = wxDescribe(code);
    const label = `${desc.text}${tempF != null ? ` • ${Math.round(tempF)}°F` : ""}`;

    wxState.tempF = tempF;
    wxState.kind = desc.kind;
    wxState.intensity = desc.intensity;
    wxState.isNight = !isDay;
    wxState.label = label;

    setBodyTheme({ isNight: wxState.isNight, isSunny: desc.text === "Clear" });
    setWeatherBadge(desc.icon, label);

    updateWxParticlesForState();
    ensureWxAnimationRunning();
  } catch (e) {
    setWeatherBadge("⛅", "Weather unavailable");
  }
}
setInterval(() => {
  updateWeatherNow().catch(() => {});
}, 10 * 60 * 1000);

function updateWxParticlesForState() {
  if (!wxCanvas || !wxCtx) return;

  const kind = wxState.kind;
  const intensity = wxState.intensity;

  if (kind === "none" || intensity <= 0) {
    wxParticles = [];
    return;
  }

  const base = Math.floor((window.innerWidth * window.innerHeight) / 45000);
  const count = Math.max(40, Math.min(240, Math.floor(base * (kind === "rain" ? 2.4 : 1.6) * (0.6 + intensity))));

  wxParticles = [];
  for (let i = 0; i < count; i++) wxParticles.push(makeParticle(kind));
}
function makeParticle(kind) {
  const w = window.innerWidth;
  const h = window.innerHeight;

  if (kind === "rain") {
    return {
      kind: "rain",
      x: Math.random() * w,
      y: Math.random() * h,
      vx: -1.2 - Math.random() * 1.2,
      vy: 10 + Math.random() * 10,
      len: 10 + Math.random() * 14,
      alpha: 0.12 + Math.random() * 0.12,
      w: 1.0,
    };
  }

  return {
    kind: "snow",
    x: Math.random() * w,
    y: Math.random() * h,
    vx: -0.7 + Math.random() * 1.4,
    vy: 1.2 + Math.random() * 2.2,
    r: 1.0 + Math.random() * 2.2,
    alpha: 0.14 + Math.random() * 0.18,
    drift: Math.random() * Math.PI * 2,
  };
}
function stepParticles() {
  if (!wxCanvas || !wxCtx) return;

  const w = window.innerWidth;
  const h = window.innerHeight;

  wxCtx.clearRect(0, 0, w, h);

  const intensity = wxState.intensity;

  if (wxState.kind === "rain") {
    wxCtx.lineCap = "round";
    for (const p of wxParticles) {
      wxCtx.globalAlpha = p.alpha * (0.7 + intensity);
      wxCtx.lineWidth = p.w;

      wxCtx.beginPath();
      wxCtx.moveTo(p.x, p.y);
      wxCtx.lineTo(p.x + p.vx, p.y + p.len);
      wxCtx.strokeStyle = "#0a3d66";
      wxCtx.stroke();

      p.x += p.vx * (0.9 + intensity);
      p.y += p.vy * (0.85 + intensity);

      if (p.y > h + 30 || p.x < -30) {
        p.x = Math.random() * w;
        p.y = -20 - Math.random() * 200;
      }
    }
    wxCtx.globalAlpha = 1;
    return;
  }

  if (wxState.kind === "snow") {
    for (const p of wxParticles) {
      wxCtx.globalAlpha = p.alpha * (0.7 + intensity);
      wxCtx.beginPath();
      wxCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      wxCtx.fillStyle = "#ffffff";
      wxCtx.fill();

      p.drift += 0.03;
      p.x += (p.vx + Math.sin(p.drift) * 0.6) * (0.7 + intensity);
      p.y += p.vy * (0.7 + intensity);

      if (p.y > h + 20) {
        p.x = Math.random() * w;
        p.y = -10 - Math.random() * 150;
      }
      if (p.x < -20) p.x = w + 10;
      if (p.x > w + 20) p.x = -10;
    }
    wxCtx.globalAlpha = 1;
  }
}
function ensureWxAnimationRunning() {
  if (!wxCanvas || !wxCtx) return;

  const shouldRun = wxState.kind !== "none" && wxState.intensity > 0;
  if (!shouldRun) {
    wxAnimRunning = false;
    wxCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    return;
  }
  if (wxAnimRunning) return;

  wxAnimRunning = true;

  const loop = () => {
    if (!wxAnimRunning) return;
    stepParticles();
    requestAnimationFrame(loop);
  };

  requestAnimationFrame(loop);
}

/* =========================================================
   RADIO (unchanged)
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

const megaAudio = new Audio();
megaAudio.src = MEGA979_STREAM_URL;
megaAudio.preload = "none";
megaAudio.crossOrigin = "anonymous";

const hot97Audio = new Audio();
hot97Audio.src = HOT97_STREAM_URL;
hot97Audio.preload = "none";
hot97Audio.crossOrigin = "anonymous";

const kqAudio = new Audio();
kqAudio.src = KQ945_STREAM_URL;
kqAudio.preload = "none";
kqAudio.crossOrigin = "anonymous";

const alofoke993Audio = new Audio();
alofoke993Audio.src = ALOFOKE993_STREAM_URL;
alofoke993Audio.preload = "none";
alofoke993Audio.crossOrigin = "anonymous";

const z100Audio = new Audio();
z100Audio.src = Z100_STREAM_URL;
z100Audio.preload = "none";
z100Audio.crossOrigin = "anonymous";

let megaPlaying = false;
let hot97Playing = false;
let kqPlaying = false;
let alofoke993Playing = false;
let z100Playing = false;

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


function stopAlofokeSiteMode() {
  if (!alofoke993Playing) return;
  try { alofoke993Audio.pause(); } catch {}
  alofoke993Playing = false;
  setBtnState(btnAlofoke993, false);
}

async function toggleAlofoke993() {
  if (hot97Playing) { hot97Audio.pause(); hot97Playing = false; setBtnState(btnHot97, false); }
  if (megaPlaying) { megaAudio.pause(); megaPlaying = false; setBtnState(btnMega979, false); }
  if (kqPlaying) { kqAudio.pause(); kqPlaying = false; setBtnState(btnKQ945, false); }
  if (z100Playing) { z100Audio.pause(); z100Playing = false; setBtnState(btnZ100, false); }

  closeHot97Modal();

  if (alofoke993Playing) {
    stopAlofokeSiteMode();
    setRadioStatus("Radio: off");
    return;
  }

  alofoke993Playing = true;
  setBtnState(btnAlofoke993, true);
  setBtnState(btnHot97, false);
  setBtnState(btnMega979, false);
  setBtnState(btnKQ945, false);
  setBtnState(btnZ100, false);
  try {
    alofoke993Audio.src = ALOFOKE993_STREAM_URL;
    await alofoke993Audio.play();
    setRadioStatus("Radio: Alofoke 99.3 FM playing");
  } catch (e) {
    console.warn("Alofoke 99.3 FM play failed:", e);
    stopAlofokeSiteMode();
    setRadioStatus("Radio: Alofoke 99.3 FM failed to play");
    alert("Alofoke 99.3 FM could not start. Turn volume up and try again.");
  }
}

async function toggleMega() {
  try {
    if (hot97Playing) {
      hot97Audio.pause();
      hot97Playing = false;
      setBtnState(btnHot97, false);
    }
    if (kqPlaying) {
      kqAudio.pause();
      kqPlaying = false;
      setBtnState(btnKQ945, false);
    }
    if (z100Playing) {
      z100Audio.pause();
      z100Playing = false;
      setBtnState(btnZ100, false);
    }
    if (alofoke993Playing) {
      stopAlofokeSiteMode();
    }
  } catch {}

  try {
    if (megaPlaying) {
      megaAudio.pause();
      megaPlaying = false;
      setBtnState(btnMega979, false);
      setRadioStatus("Radio: off");
      return;
    }

    await megaAudio.play();
    megaPlaying = true;

    setBtnState(btnMega979, true);
    setBtnState(btnHot97, false);
    setBtnState(btnKQ945, false);
    setBtnState(btnAlofoke993, false);
    setBtnState(btnZ100, false);
    setRadioStatus("Radio: La Mega 97.9 playing");
  } catch (e) {
    console.warn("La Mega play failed:", e);
    megaPlaying = false;
    setBtnState(btnMega979, false);
    setRadioStatus("Radio: La Mega failed to play");
    alert("La Mega 97.9 could not start. Turn volume up and try again.");
  }
}

async function toggleHot97() {
  try {
    if (megaPlaying) {
      megaAudio.pause();
      megaPlaying = false;
      setBtnState(btnMega979, false);
    }
    if (kqPlaying) {
      kqAudio.pause();
      kqPlaying = false;
      setBtnState(btnKQ945, false);
    }
    if (z100Playing) {
      z100Audio.pause();
      z100Playing = false;
      setBtnState(btnZ100, false);
    }
    if (alofoke993Playing) {
      stopAlofokeSiteMode();
    }
  } catch {}

  closeHot97Modal();

  if (hot97Playing) {
    try { hot97Audio.pause(); } catch {}
    hot97Playing = false;
    setBtnState(btnHot97, false);
    setRadioStatus("Radio: off");
    return;
  }

  try {
    hot97Audio.src = HOT97_STREAM_URL;
    hot97Audio.volume = 1;

    const p = hot97Audio.play();
    if (p && typeof p.then === "function") await p;

    hot97Playing = true;
    setBtnState(btnHot97, true);
    setBtnState(btnMega979, false);
    setBtnState(btnKQ945, false);
    setBtnState(btnAlofoke993, false);
    setBtnState(btnZ100, false);
    setRadioStatus("Radio: HOT 97.1 playing");
  } catch (e) {
    const errName = e && e.name ? String(e.name) : "";
    if (errName === "AbortError") {
      console.warn("Hot 97 aborted (Safari interruption):", e);
      hot97Playing = false;
      setBtnState(btnHot97, false);
      setRadioStatus("Radio: HOT 97.1 stopped");
      return;
    }

    console.warn("Hot 97 play failed:", e);
    hot97Playing = false;
    setBtnState(btnHot97, false);
    setRadioStatus("Radio: HOT 97.1 failed to play");
    alert("HOT 97.1 could not start. Turn volume up and try again.");
  }
}
async function toggleKQ() {
  if (hot97Playing) { hot97Audio.pause(); hot97Playing = false; setBtnState(btnHot97, false); }
  if (megaPlaying) { megaAudio.pause(); megaPlaying = false; setBtnState(btnMega979, false); }
  if (z100Playing) { z100Audio.pause(); z100Playing = false; setBtnState(btnZ100, false); }
  if (alofoke993Playing) { stopAlofokeSiteMode(); }

  closeHot97Modal();

  if (kqPlaying) {
    try { kqAudio.pause(); } catch {}
    kqPlaying = false;
    setBtnState(btnKQ945, false);
    setRadioStatus("Radio: off");
    return;
  }

  try {
    kqAudio.src = KQ945_STREAM_URL;
    kqAudio.volume = 1;
    const p = kqAudio.play();
    if (p && typeof p.then === "function") await p;

    kqPlaying = true;
    setBtnState(btnKQ945, true);
    setBtnState(btnHot97, false);
    setBtnState(btnMega979, false);
    setBtnState(btnAlofoke993, false);
    setBtnState(btnZ100, false);
    setRadioStatus("Radio: KQ 94.5 FM playing");
  } catch (e) {
    console.warn("KQ 94.5 play failed:", e);
    kqPlaying = false;
    setBtnState(btnKQ945, false);
    setRadioStatus("Radio: KQ 94.5 FM failed to play");
    try { window.open(KQ945_SITE_URL, "_blank", "noopener"); } catch {}
    alert("KQ 94.5 FM could not start. Turn volume up and try again.");
  }
}

async function toggleZ100() {
  if (hot97Playing) { hot97Audio.pause(); hot97Playing = false; setBtnState(btnHot97, false); }
  if (megaPlaying) { megaAudio.pause(); megaPlaying = false; setBtnState(btnMega979, false); }
  if (kqPlaying) { kqAudio.pause(); kqPlaying = false; setBtnState(btnKQ945, false); }
  if (alofoke993Playing) { stopAlofokeSiteMode(); }

  if (z100Playing) {
    z100Audio.pause();
    z100Playing = false;
    setBtnState(btnZ100, false);
    setRadioStatus("Radio: off");
    return;
  }
  try {
    z100Audio.src = Z100_STREAM_URL;
    await z100Audio.play();
    z100Playing = true;
    setBtnState(btnZ100, true);
    setBtnState(btnHot97, false);
    setBtnState(btnMega979, false);
    setBtnState(btnKQ945, false);
    setBtnState(btnAlofoke993, false);
    setRadioStatus("Radio: Z100 playing");
  } catch (e) {
    z100Playing = false;
    setBtnState(btnZ100, false);
    setRadioStatus("Radio: Z100 failed to play");
    alert("Z100 could not start. Turn volume up and try again.");
  }
}


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
megaAudio.addEventListener("ended", () => {
  megaPlaying = false;
  setBtnState(btnMega979, false);
  setRadioStatus("Radio: off");
});
megaAudio.addEventListener("error", () => {
  megaPlaying = false;
  setBtnState(btnMega979, false);
  setRadioStatus("Radio: La Mega stream error");
});
hot97Audio.addEventListener("ended", () => {
  hot97Playing = false;
  setBtnState(btnHot97, false);
  setRadioStatus("Radio: off");
});
hot97Audio.addEventListener("error", () => {
  hot97Playing = false;
  setBtnState(btnHot97, false);
  setRadioStatus("Radio: HOT 97.1 stream error");
});
kqAudio.addEventListener("ended", () => {
  kqPlaying = false;
  setBtnState(btnKQ945, false);
  setRadioStatus("Radio: off");
});
kqAudio.addEventListener("error", () => {
  kqPlaying = false;
  setBtnState(btnKQ945, false);
  setRadioStatus("Radio: KQ 94.5 FM stream error");
});
alofoke993Audio.addEventListener("ended", () => {
  alofoke993Playing = false;
  setBtnState(btnAlofoke993, false);
  setRadioStatus("Radio: off");
});
alofoke993Audio.addEventListener("error", () => {
  alofoke993Playing = false;
  setBtnState(btnAlofoke993, false);
  setRadioStatus("Radio: Alofoke 99.3 FM stream error");
});
z100Audio.addEventListener("ended", () => {
  z100Playing = false;
  setBtnState(btnZ100, false);
  setRadioStatus("Radio: off");
});

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

let communityToken = localStorage.getItem(LS_TOKEN) || "";
let me = null;
let lastGpsAccuracyM = null;

function syncAdminPortalSession() {
  if (typeof window === 'undefined' || !window.AdminPortal) return;
  window.AdminPortal.setSession?.({ me, token: communityToken });
  window.AdminPortal.refreshVisibility?.();
}

// other drivers markers
const otherMarkers = new Map(); // user_id -> marker
const driverMarkerVisualSignature = new Map();
let cachedPresenceRows = [];
let presenceRenderMode = 'full';
let presenceFocusedUserId = null;
let presenceLiteSourceFingerprint = '';
let presenceAdaptiveRenderRaf = 0;

const PRESENCE_FULL_MAX_VISIBLE = 50;
const PRESENCE_MEDIUM_MAX_VISIBLE = 100;
const PRESENCE_FULL_TO_MEDIUM_UP = 56;
const PRESENCE_MEDIUM_TO_FULL_DOWN = 44;
const PRESENCE_MEDIUM_TO_HEAVY_UP = 106;
const PRESENCE_HEAVY_TO_MEDIUM_DOWN = 92;
const PRESENCE_MEDIUM_RICH_LIMIT = 24;
const PRESENCE_HEAVY_RICH_LIMIT = 10;
const PRESENCE_VIEWPORT_BUFFER_RATIO = 0.18;

const LABEL_OFFSETS = [
  [44, 0],
  [-44, 0],
  [0, 30],
  [0, -30],
  [34, 20],
  [-34, 20],
  [34, -20],
  [-34, -20],
];

const SELF_COLLISION_THRESHOLD_PX = 44;
const SELF_COLLISION_OFFSET_PX = 64;
const SELF_LABEL_SIDE = "right";

function sideFromOffsetX(dx, fallback = "right") {
  if (dx > 0) return "right";
  if (dx < 0) return "left";
  return fallback;
}

function syncGhostUI() {
  const ghostOn = !!me?.ghost_mode;
  if (btnGhostMode) {
    btnGhostMode.textContent = ghostOn ? "Ghost Mode: ON" : "Ghost Mode: OFF";
    btnGhostMode.classList.toggle("on", ghostOn);
    btnGhostMode.classList.toggle("disabled", !authHeaderOK());
  }
  if (authGhost) authGhost.checked = ghostOn;
}

function signOutNow({ reload = false } = {}) {
  clearAuth();
  closeDrawer();
  if (reload) {
    setTimeout(() => {
      window.location.reload();
    }, 40);
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
    schedulePickupOverlayRefresh({ force: true });
  } else {
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
}

function clearAuth() {
  communityToken = "";
  me = null;
  localStorage.removeItem(LS_TOKEN);
  localStorage.removeItem("community_token");
  // Reset chat state if a new chat implementation exists.
  if (typeof window !== "undefined") {
    if (typeof window.chatResetState === "function") window.chatResetState();
    if (typeof window.stopChatPolling === "function") window.stopChatPolling();
  }
  clearOtherDrivers();
  clearPickupOverlayCache();
  clearPickupOverlay();
  if (authPass) authPass.value = "";
  if (authGhost) authGhost.checked = false;
  setAuthUI(false, "Status: signed out");
  syncAdminPortalSession();
}

function authHeaderOK() {
  return communityToken && communityToken.length > 10;
}

function requireCommunityToken(actionLabel = "perform this action") {
  if (authHeaderOK()) return true;
  setAuthUI(false, `Sign in to ${actionLabel}.`);
  return false;
}

async function loadMe() {
  if (!authHeaderOK()) return null;
  try {
    const data = await getJSONAuth("/me", communityToken);
    me = data || null;
    if (me?.display_name) localStorage.setItem(LS_DISPLAY_NAME, me.display_name);
    syncGhostUI();
    refreshNavNameLabel();
    syncAdminPortalSession();
    return me;
  } catch (e) {
    console.warn("/me failed:", e);
    clearAuth();
    return null;
  }
}

function safeName() {
  return authName && authName.value ? authName.value.trim() : "";
}

async function updateMeProfile(updates) {
  if (!authHeaderOK()) return;
  await postJSON("/me/update", updates, communityToken);
  await loadMe();
}

async function applyPostAuthPreferences({ email, forceGhostSync, desiredGhostMode }) {
  if (!authHeaderOK()) return;

  const updates = {};
  const typedName = safeName();
  if (typedName && typedName !== (me?.display_name || "")) {
    updates.display_name = typedName;
  }
  if (forceGhostSync) {
    updates.ghost_mode = !!desiredGhostMode;
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
  await applyPostAuthPreferences({ email, forceGhostSync: true, desiredGhostMode });
  setAuthUI(true, `Status: signed in as ${me?.display_name || me?.email || email}`);
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
  await applyPostAuthPreferences({ email, forceGhostSync: true, desiredGhostMode });
  setAuthUI(true, `Status: account created • signed in as ${me?.display_name || me?.email || email}`);
  syncAdminPortalSession();
}

async function changePassword(oldPwd, newPwd) {
  if (!requireCommunityToken("change password")) return;
  try {
    await postJSON(
      "/me/change_password",
      { old_password: oldPwd, new_password: newPwd },
      communityToken
    );
    alert("Password changed successfully.");
    if (authPass) authPass.value = "";
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
  if (!confirm("Are you sure you want to delete your account? This cannot be undone.")) return;
  try {
    await postJSON("/me/delete_account", {}, communityToken);
    clearAuth();
    localStorage.removeItem("community_token");
    location.reload();
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
      setAuthUI(false, `Sign in failed: ${e.message || e}`);
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
      signOutNow({ reload: true });
      return;
    }
    setAuthUI(false, "Status: signed out");
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

// other drivers marker HTML
function applyDriverLabelZoomStyles() {
  const zoom = map?.getZoom?.();
  if (typeof window !== "undefined" && typeof window.mapIdentityApplyZoomStyles === "function") {
    window.mapIdentityApplyZoomStyles(zoom);
  }
}

function makeDriverIcon(name, headingDeg, avatarUrl = "", mode = "name", orbitMeta = null, leaderboardBadgeCode = '', leaderboardHasCrown = false) {
  const safe = (name || "Driver").trim() || "Driver";
  const rot = Number.isFinite(headingDeg) ? headingDeg : 0;
  const el = document.createElement("div");
  const driverLabelHTML = (typeof window !== "undefined" && typeof window.mapIdentityRenderDriverLabel === "function")
    ? window.mapIdentityRenderDriverLabel({ name: safe, avatarUrl, mode, zoom: map?.getZoom?.(), orbitMeta, leaderboardBadgeCode, leaderboardHasCrown })
    : `<div class="otherDrvName">${escapeHtml(safe)}</div>`;
  el.className = "otherDrvWrap";
  el.innerHTML = `
    <div class="otherArrowWrap otherPulse" style="transform:rotate(${rot}deg)">
      <div class="otherArrow"></div>
    </div>
    ${driverLabelHTML}
  `;
  return el;
}

function clearOtherDrivers() {
  for (const m of otherMarkers.values()) {
    try { m.remove(); } catch {}
  }
  otherMarkers.clear();
  driverMarkerVisualSignature.clear();
  cachedPresenceRows = [];
  presenceFocusedUserId = null;
  const presenceLiteSource = map?.getSource?.('presence-lite');
  if (presenceLiteSource && typeof presenceLiteSource.setData === 'function') {
    presenceLiteSource.setData(emptyGeojson());
  }
  presenceLiteSourceFingerprint = '';
}

function buildDriverMarkerVisualSignature(userId, name, avatarUrl = "", mode = "name", orbitMeta = null, leaderboardBadgeCode = '', leaderboardHasCrown = false) {
  const orbitIndex = Number.isFinite(orbitMeta?.index) ? orbitMeta.index : "";
  const orbitCount = Number.isFinite(orbitMeta?.count) ? orbitMeta.count : "";
  return [
    String(userId ?? ""),
    String(name ?? ""),
    String(avatarUrl ?? ""),
    String(mode ?? "name"),
    String(leaderboardBadgeCode ?? ""),
    leaderboardHasCrown ? "1" : "0",
    String(orbitIndex),
    String(orbitCount),
  ].join("|");
}

function upsertDriverMarker(userId, name, lat, lng, heading, avatarUrl = "", mode = "name", orbitMeta = null, leaderboardBadgeCode = '', leaderboardHasCrown = false) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !map) return;
  if (!userId) return;

  const visualSig = buildDriverMarkerVisualSignature(
    userId,
    name,
    avatarUrl,
    mode,
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
      const arrowWrap = existing.getElement()?.querySelector?.(".otherArrowWrap");
      if (arrowWrap) {
        const rot = Number.isFinite(heading) ? heading : 0;
        arrowWrap.style.transform = `rotate(${rot}deg)`;
      }
    }
    return;
  }

  const el = makeDriverIcon(name || `Driver ${userId}`, heading, avatarUrl, mode, orbitMeta, leaderboardBadgeCode, leaderboardHasCrown);
  wireProfileOpenTargets(el, userId, { isSelf: false });
  // A custom HTML marker's triangle arrow sits slightly below the centre of its
  // 40×40 container (the tip is ~7 px below the vertical midpoint). When the
  // marker is anchored at "center" without an offset, the geographic point
  // corresponds to the centre of the container, causing the arrow tip to
  // hover ~7 px above the true location. To pin the arrow tip to the exact
  // latitude/longitude, we anchor the marker at the centre and apply a
  // downward offset equal to that vertical difference. Positive y offsets
  // move the marker downwards relative to its anchor; see MapLibre docs.
  const arrowOffsetY = 7; // pixels the arrow tip sits below the centre
  const mk = new maplibregl.Marker({ element: el, anchor: "center", offset: [0, arrowOffsetY] })
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
  const visibleRows = Array.isArray(rows) ? rows : [];
  if (mode === 'full') {
    return new Set(visibleRows.map((row) => String(row.uid)));
  }
  const maxRich = mode === 'heavy' ? PRESENCE_HEAVY_RICH_LIMIT : PRESENCE_MEDIUM_RICH_LIMIT;
  const sorted = [...visibleRows];
  const focusedId = Number(presenceFocusedUserId);
  const hasFocused = Number.isFinite(focusedId)
    && sorted.some((row) => Number(row?.uid) === focusedId || String(row?.uid) === String(focusedId));

  let anchor = null;
  if (userLatLng && Number.isFinite(userLatLng.lat) && Number.isFinite(userLatLng.lng)) {
    anchor = { lat: userLatLng.lat, lng: userLatLng.lng };
  } else {
    const center = map?.getCenter?.();
    if (center && Number.isFinite(center.lat) && Number.isFinite(center.lng)) {
      anchor = { lat: center.lat, lng: center.lng };
    }
  }

  sorted.sort((a, b) => {
    const aId = String(a?.uid ?? '');
    const bId = String(b?.uid ?? '');
    const aFocused = hasFocused && (Number(a?.uid) === focusedId || aId === String(focusedId));
    const bFocused = hasFocused && (Number(b?.uid) === focusedId || bId === String(focusedId));
    if (aFocused !== bFocused) return aFocused ? -1 : 1;

    if (anchor) {
      const da = haversineMiles(anchor, { lat: Number(a?.lat), lng: Number(a?.lng) });
      const db = haversineMiles(anchor, { lat: Number(b?.lat), lng: Number(b?.lng) });
      if (da !== db) return da - db;
    }
    return aId.localeCompare(bId);
  });

  return new Set(sorted.slice(0, maxRich).map((row) => String(row.uid)));
}

function ensurePresenceLiteSourceAndLayers() {
  if (!map || !mapReady) return;
  if (!map.getSource('presence-lite')) {
    map.addSource('presence-lite', { type: 'geojson', data: emptyGeojson() });
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
}

function presenceLiteFingerprint(fc) {
  const features = Array.isArray(fc?.features) ? fc.features : [];
  const rows = features.map((feature) => {
    const userId = String(feature?.properties?.user_id ?? '');
    const coords = Array.isArray(feature?.geometry?.coordinates) ? feature.geometry.coordinates : [];
    const lng = Number(coords[0]);
    const lat = Number(coords[1]);
    const heading = Number(feature?.properties?.heading ?? 0);
    const lngRounded = Number.isFinite(lng) ? lng.toFixed(5) : 'nan';
    const latRounded = Number.isFinite(lat) ? lat.toFixed(5) : 'nan';
    const headingRounded = Number.isFinite(heading) ? Math.round(heading) : 0;
    return `${userId}|${latRounded}|${lngRounded}|${headingRounded}`;
  });
  rows.sort();
  return rows.join('||');
}

function scheduleAdaptivePresenceRender() {
  if (presenceAdaptiveRenderRaf) return;
  presenceAdaptiveRenderRaf = window.requestAnimationFrame(() => {
    presenceAdaptiveRenderRaf = 0;
    renderAdaptivePresenceFromCache();
  });
}

function renderAdaptivePresenceFromCache() {
  if (!map || !mapReady) return;
  ensurePresenceLiteSourceAndLayers();
  const rows = Array.isArray(cachedPresenceRows) ? cachedPresenceRows : [];
  const boundsObj = getPresenceRenderBounds();
  const viewportRows = boundsObj ? rows.filter((row) => rowInPresenceRenderBounds(row, boundsObj)) : rows.slice();
  const nextMode = computePresenceRenderMode(rows);
  presenceRenderMode = nextMode;
  const richUserIds = chooseRichPresenceUserIds(viewportRows, nextMode);
  const richRows = [];
  const liteRows = [];

  for (const row of viewportRows) {
    const uid = String(row.uid);
    if (richUserIds.has(uid)) {
      richRows.push(row);
    } else {
      liteRows.push(row);
    }
  }

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
      try { mk.remove(); } catch {}
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

  applyDriverLabelZoomStyles();
}

async function pullPresenceAll() {
  if (!authHeaderOK() || !map) return;
  if (!mapPageIsVisible) return;

  try {
    const list = await getJSONAuth("/presence/all", communityToken);
    const now = Date.now() / 1000;
    const items = Array.isArray(list) ? list : list?.items || [];
    const fallbackVisibleCount = Array.isArray(items) ? items.length : 0;
    let badgeUpdatedFromSummary = false;

    // Update the online badge from backend aggregate counts so ghosted users
    // remain hidden on the map but still count as online.
    try {
      const summary = await getJSONAuth("/presence/summary", communityToken);
      const onlineCount = Number(summary?.online_count);
      const ghostedCount = Number(summary?.ghosted_count);
      if (Number.isFinite(onlineCount) && onlineCount >= 0) {
        updateOnlineBadge(onlineCount, Number.isFinite(ghostedCount) ? ghostedCount : 0);
        badgeUpdatedFromSummary = true;
      }
    } catch (e) {
      // Ignore badge updates if anything goes wrong.
    }
    if (!badgeUpdatedFromSummary) {
      updateOnlineBadge(fallbackVisibleCount, 0);
    }
    const candidates = [];

    for (const it of items) {
      const uid = String(it.user_id ?? it.userId ?? it.id ?? "");
      if (!uid) continue;
      if (me && String(me.id) === uid) continue;

      let lat = Number(it.lat ?? it.latitude ?? NaN);
      let lng = Number(it.lng ?? it.longitude ?? NaN);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      // Do NOT round lat/lng. Use the exact coordinates returned by the backend
      // so markers remain accurate even when many drivers share one location.

      const updated = Number(it.updated_at_unix ?? it.ts_unix ?? it.updated_at ?? NaN);
      if (Number.isFinite(updated)) {
        if (now - updated > PRESENCE_STALE_SEC) continue;
      }

      const reportedAccuracy = Number(it.accuracy ?? it.acc ?? NaN);
      if (Number.isFinite(reportedAccuracy) && reportedAccuracy > GPS_ACCURACY_THRESHOLD) {
        continue;
      }

      candidates.push({
        uid,
        name: it.display_name || it.name || it.email || "Driver",
        avatarUrl: it.avatar_url || "",
        mode: it.map_identity_mode || "name",
        lat,
        lng,
        heading: Number(it.heading ?? it.bearing ?? NaN),
        leaderboardBadgeCode: it.leaderboard_badge_code || '',
        leaderboardHasCrown: !!it.leaderboard_has_crown,
        updatedAt: it.updated_at ?? it.updated_at_unix ?? it.ts_unix ?? null,
      });
    }

    const overlapEps = 0.000035;
    const groups = new Map();
    const groupKey = (lat, lng) => `${Math.round(lat / overlapEps)}:${Math.round(lng / overlapEps)}`;

    for (const row of candidates) {
      const key = groupKey(row.lat, row.lng);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }

    const selfPos = userLatLng && Number.isFinite(userLatLng.lat) && Number.isFinite(userLatLng.lng)
      ? { lat: userLatLng.lat, lng: userLatLng.lng }
      : null;
    const selfGroupKey = selfPos ? groupKey(selfPos.lat, selfPos.lng) : null;
    const selfUid = me && me.id != null ? String(me.id) : "self";

    for (const [key, members] of groups.entries()) {
      const includeSelf = !!(selfGroupKey && key === selfGroupKey);
      const sortable = members.map((row) => ({ id: String(row.uid), row }));
      if (includeSelf) sortable.push({ id: selfUid, row: null });
      sortable.sort((a, b) => a.id.localeCompare(b.id));
      const count = sortable.length;
      if (count <= 1) {
        members.forEach((row) => { row.orbitMeta = null; });
        if (includeSelf && typeof window !== "undefined" && typeof window.mapIdentityApplySelfOrbit === "function") {
          window.mapIdentityApplySelfOrbit(null);
        }
        continue;
      }
      sortable.forEach((entry, idx) => {
        const orbitMeta = {
          index: idx,
          count,
          angleDeg: -90 + (idx * 360) / count,
          radiusPx: 11,
        };
        if (entry.row) {
          entry.row.orbitMeta = orbitMeta;
        } else if (typeof window !== "undefined" && typeof window.mapIdentityApplySelfOrbit === "function") {
          window.mapIdentityApplySelfOrbit(orbitMeta);
        }
      });
    }

    if (!selfGroupKey && typeof window !== "undefined" && typeof window.mapIdentityApplySelfOrbit === "function") {
      window.mapIdentityApplySelfOrbit(null);
    }

    cachedPresenceRows = candidates;
    scheduleAdaptivePresenceRender();
  } catch (e) {
    console.warn("presence/all failed:", e);
  }
}

let lastPresencePushMs = 0;
let lastPresenceSentLatLng = null;
async function communityMaybePushPresence(tsMsOrUnix, heading, accuracy) {
  if (!authHeaderOK()) return;
  if (!userLatLng) return;
  if (Number.isFinite(accuracy) && accuracy > GPS_ACCURACY_THRESHOLD) return;

  if (lastPresenceSentLatLng) {
    const jumpMi = haversineMiles(lastPresenceSentLatLng, userLatLng);
    if (jumpMi > MAX_JUMP_MILES) return;
  }

  const nowMs = Date.now();
  if (nowMs - lastPresencePushMs < PRESENCE_PUSH_MS) return;
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

let recordTripToastTimer = null;
function ensureRecordTripToast() {
  let el = document.getElementById("recordTripToast");
  if (el) return el;

  el = document.createElement("div");
  el.id = "recordTripToast";
  el.setAttribute("aria-hidden", "true");
  el.style.cssText = [
    "position:fixed",
    "left:50%",
    "bottom:calc(env(safe-area-inset-bottom, 0px) + 182px)",
    "transform:translate(-50%, 18px) scale(0.94)",
    "opacity:0",
    "pointer-events:none",
    "z-index:9800",
    "transition:opacity 220ms ease, transform 220ms ease",
  ].join(";");
  el.innerHTML = `
    <div aria-label="Trip recorded" style="
      width:72px;
      height:72px;
      border-radius:999px;
      background:#18b45b;
      display:grid;
      place-items:center;
      color:#fff;
      font:900 36px/1 system-ui,-apple-system,Segoe UI,Roboto,Arial;
      box-shadow:0 16px 34px rgba(0,0,0,0.24), 0 0 0 6px rgba(24,180,91,0.18);
      user-select:none;
    ">✔</div>
  `;
  document.body.appendChild(el);
  return el;
}
function hideRecordTripToast() {
  const el = document.getElementById("recordTripToast");
  if (!el) return;
  el.style.opacity = "0";
  el.style.transform = "translate(-50%, 18px) scale(0.94)";
  el.setAttribute("aria-hidden", "true");
}
function showRecordTripToast() {
  const el = ensureRecordTripToast();
  if (recordTripToastTimer) clearTimeout(recordTripToastTimer);
  el.style.opacity = "1";
  el.style.transform = "translate(-50%, 0) scale(1)";
  el.setAttribute("aria-hidden", "false");
  recordTripToastTimer = setTimeout(() => {
    hideRecordTripToast();
    recordTripToastTimer = null;
  }, 3000);
}

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

    await postJSON(
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

    showRecordTripToast();
  } catch (e) {
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

/* poll presence */
setInterval(() => {
  pullPresenceAll().catch(() => {});
}, PRESENCE_PULL_MS);

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
  setTimeout(() => {
    const l = document.getElementById("mapLoading");
    if (l) l.style.display = "none";
  }, 7000);

  initMap();
  await loadTimeline();

  if (authHeaderOK()) {
    setAuthUI(true, "Checking session…");
    await loadMe();
    if (authHeaderOK()) {
      setAuthUI(true, `Status: signed in as ${me?.display_name || me?.email || "Driver"}`);
      pullPresenceAll().catch(() => {});
      schedulePickupOverlayRefresh({ force: true });
    } else {
      setAuthUI(false, "Status: signed out");
    }
  } else {
    setAuthUI(false, "Status: signed out");
  }

  syncAdminPortalSession();

  // Start GPS AFTER map exists
  startLocationWatch();
  updateWeatherNow().catch(() => {});
})().catch((err) => {
  console.error(err);
  if (timeLabel) timeLabel.textContent = `Error: ${err?.message || err}`;
});