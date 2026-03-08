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
 * Provide a default backend host for all API calls. If your frontend is deployed on a
 * different host than the backend, this constant ensures requests target the correct
 * server. You can override this default by defining `window.API_BASE` before
 * this script runs. If `window.API_BASE` is defined, it will be used instead of
 * the default.
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
const HEADING_COMPASS_STALE_MS = 2500;
const MAX_JUMP_MILES = 2.0;
let lastMapBearingDeg = 0;
let lastRotateTs = 0;

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
const PICKUP_RECENT_LIMIT = 30;
const PICKUP_ZONE_SAMPLE_LIMIT = 100;
const PICKUP_REFRESH_DEBOUNCE_MS = 350;
const PICKUP_FETCH_COOLDOWN_MS = 1200;

let pickupRefreshTimer = null;
let pickupRefreshInFlight = false;
let pickupLogBusy = false;
let lastPickupFetchMs = 0;
let lastPickupFetchKey = "";
let pickupZoneStats = new Map();

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
const dockMusic = document.getElementById("dockMusic");
const dockProfile = document.getElementById("dockProfile");

const dockDrawer = document.getElementById("dockDrawer");
const dockDrawerTitle = document.getElementById("dockDrawerTitle");
const dockDrawerBody = document.getElementById("dockDrawerBody");
const dockDrawerClose = document.getElementById("dockDrawerClose");
const dockBackdrop = document.getElementById("dockBackdrop");

const USER_AGENT = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
const IS_TESLA_BROWSER = /\bTesla\//i.test(USER_AGENT);
const DRAWER_AUTO_MINIMIZE_MS = 5000;

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
  clearDrawerAutoMinimizeTimer();
  drawerAutoMinimizeTimer = setTimeout(() => {
    if (!openPanelKey) return;
    closeDrawer();
  }, DRAWER_AUTO_MINIMIZE_MS);
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
  [dockColors, dockModes, dockChat, dockMusic, dockProfile].forEach((b) => b && b.classList.remove("dockBtnActive"));
  if (openPanelKey === "colors") dockColors?.classList.add("dockBtnActive");
  if (openPanelKey === "modes") dockModes?.classList.add("dockBtnActive");
  if (openPanelKey === "chat") dockChat?.classList.add("dockBtnActive");
  if (openPanelKey === "music") dockMusic?.classList.add("dockBtnActive");
  if (openPanelKey === "profile") dockProfile?.classList.add("dockBtnActive");
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
        <button id="dockPoliceBtn" class="chipBtn">🚨 Police</button>
        <button id="dockPickupBtn" class="chipBtn">✅ Record Trip</button>
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
    </div>
  `;
}

function wireProfilePanel() {
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

function colorsPanelHTML() {
  const teslaRows = `
      <div style="display:flex;align-items:center;gap:8px;"><span style="display:inline-block;width:12px;height:12px;border-radius:4px;background:#00b050;border:1px solid rgba(0,0,0,0.15);flex:0 0 12px;"></span>Green = Highest</div>
      <div style="display:flex;align-items:center;gap:8px;"><span style="display:inline-block;width:12px;height:12px;border-radius:4px;background:#8000ff;border:1px solid rgba(0,0,0,0.15);flex:0 0 12px;"></span>Purple = High</div>
      <div style="display:flex;align-items:center;gap:8px;"><span style="display:inline-block;width:12px;height:12px;border-radius:4px;background:#0066ff;border:1px solid rgba(0,0,0,0.15);flex:0 0 12px;"></span>Blue = Medium</div>
      <div style="display:flex;align-items:center;gap:8px;"><span style="display:inline-block;width:12px;height:12px;border-radius:4px;background:#66ccff;border:1px solid rgba(0,0,0,0.15);flex:0 0 12px;"></span>Sky = Normal</div>
      <div style="display:flex;align-items:center;gap:8px;"><span style="display:inline-block;width:12px;height:12px;border-radius:4px;background:#ffd400;border:1px solid rgba(0,0,0,0.15);flex:0 0 12px;"></span>Yellow = Below Normal</div>
      <div style="display:flex;align-items:center;gap:8px;"><span style="display:inline-block;width:12px;height:12px;border-radius:4px;background:#e60000;border:1px solid rgba(0,0,0,0.15);flex:0 0 12px;"></span>Red = Very Low / Avoid</div>
  `;
  const defaultRows = `
      <div>🟩 Green = Highest</div>
      <div>🟪 Purple = High</div>
      <div>🟦 Blue = Medium</div>
      <div>🟦 Sky = Normal</div>
      <div>🟨 Yellow = Below Normal</div>
      <div>🟥 Red = Very Low / Avoid</div>
  `;

  return `
    <div class="panelBlock">
      <div style="font-weight:800;margin-bottom:8px;">Demand Colors</div>
      ${IS_TESLA_BROWSER ? teslaRows : defaultRows}
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
bindDockToggle(dockColors, "colors", "Colors", colorsPanelHTML);
bindDockToggle(dockProfile, "profile", "Profile", profilePanelHTML, wireProfilePanel);

function applyTeslaDockIconCompatibility() {
  if (!IS_TESLA_BROWSER) return;

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
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false" style="display:block">
      <circle cx="12" cy="12" r="9" fill="#ffffff" opacity="0.98"/>
      <circle cx="8" cy="9" r="2.6" fill="#00b050"/>
      <circle cx="14.8" cy="8" r="2.4" fill="#8000ff"/>
      <circle cx="16.3" cy="13.7" r="2.4" fill="#0066ff"/>
      <circle cx="10.3" cy="16.4" r="2.2" fill="#ffd400"/>
      <circle cx="18.2" cy="18.2" r="1.2" fill="rgba(255,255,255,0)"/>
      <path d="M19 18.4c0 1.4-1.1 2.4-2.5 2.4H12A8.4 8.4 0 1 1 20.4 12c0 1.3-.8 2.2-1.8 2.2h-1.1c-.7 0-1.2.5-1.2 1.1 0 .3.1.5.3.8.3.5.4 1 .4 1.3Z" fill="none" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/>
    </svg>
  `);

  setIcon(dockModes, `
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false" style="display:block">
      <path d="M10.3 2h3.4l.5 2.2a8 8 0 0 1 1.8.8l1.9-1.2 2.4 2.4-1.2 1.9c.3.6.6 1.2.8 1.8L22 10.3v3.4l-2.2.5a8 8 0 0 1-.8 1.8l1.2 1.9-2.4 2.4-1.9-1.2a8 8 0 0 1-1.8.8l-.5 2.2h-3.4l-.5-2.2a8 8 0 0 1-1.8-.8l-1.9 1.2-2.4-2.4 1.2-1.9a8 8 0 0 1-.8-1.8L2 13.7v-3.4l2.2-.5c.2-.6.5-1.2.8-1.8L3.8 6.1l2.4-2.4 1.9 1.2a8 8 0 0 1 1.8-.8L10.3 2Z" fill="#4f7cff" opacity="0.95"/>
      <circle cx="12" cy="12" r="3.2" fill="#ffffff"/>
      <circle cx="12" cy="12" r="7.8" fill="none" stroke="#111" stroke-width="1.2" opacity="0.15"/>
    </svg>
  `);

  setIcon(dockChat, `
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false" style="display:block">
      <path d="M5 5.5h14a2.5 2.5 0 0 1 2.5 2.5v6.3a2.5 2.5 0 0 1-2.5 2.5H11l-4.8 3v-3H5A2.5 2.5 0 0 1 2.5 14.3V8A2.5 2.5 0 0 1 5 5.5Z" fill="#2f7cff"/>
      <circle cx="8.3" cy="11.1" r="1.2" fill="#ffffff"/>
      <circle cx="12" cy="11.1" r="1.2" fill="#ffffff"/>
      <circle cx="15.7" cy="11.1" r="1.2" fill="#ffffff"/>
    </svg>
  `);

  setIcon(dockMusic, `
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false" style="display:block">
      <path d="M15.5 4v9.1a3.2 3.2 0 1 1-1.5-2.7V6.2l7-1.7v7a3.2 3.2 0 1 1-1.5-2.7V3L15.5 4Z" fill="#ffffff"/>
    </svg>
  `);

  setIcon(dockProfile, `
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false" style="display:block">
      <circle cx="12" cy="8" r="4" fill="#111"/>
      <path d="M4 20a8 8 0 0 1 16 0" fill="none" stroke="#111" stroke-width="2.4" stroke-linecap="round"/>
    </svg>
  `);
}

applyTeslaDockIconCompatibility();

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
        pullPresenceAll().catch(() => {});
        schedulePickupOverlayRefresh();
      }
      applyDriverLabelZoomStyles();
    });
    map.on("zoomend", () => {
      if (authHeaderOK()) {
        pullPresenceAll().catch(() => {});
        schedulePickupOverlayRefresh();
      }
      applyDriverLabelZoomStyles();
    });

    // Zone click popup (restored)
    wireZoneClickPopup();

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
          10, 6,
          11, 7,
          12, 8,
          13, 10,
          14, 12,
          15, 13,
          16, 15
        ],
        "text-max-width": 7,
        "text-anchor": "center",
        "text-justify": "center",
        "text-allow-overlap": false,
        "text-ignore-placement": false,
        "text-padding": 1.5,
      },
      paint: {
        "text-color": "#111111",
        "text-halo-color": "rgba(255,255,255,0.90)",
        "text-halo-width": 1.8,
        "text-halo-blur": 0.6,
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
  lastPickupFetchKey = "";
}

function setPickupOverlayData(fc, items = [], zoneStats = []) {
  pickupZoneStats = new Map();

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

  const src = map?.getSource?.("pickup-points");
  if (src && typeof src.setData === "function") {
    src.setData(fc || emptyGeojson());
  }
}

function clearPickupOverlay() {
  setPickupOverlayData(emptyGeojson(), []);
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

  if (!map.getLayer("pickup-heat")) {
    map.addLayer(
      {
        id: "pickup-heat",
        type: "heatmap",
        source: "pickup-points",
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
        minzoom: 12,
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
        minzoom: 12,
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
    const fc = buildPickupFeatureCollection(items);
    setPickupOverlayData(fc, items, zoneStats);
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
        maxWidth: "340px",
      })
        .setLngLat([lngLat.lng, lngLat.lat])
        .setHTML(html)
        .addTo(map);
    } catch (err) {
      console.warn("zone popup failed:", err);
    }
  });
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

  // “Major map app style”: show labels always (>= LABEL_ZOOM_MIN), but still avoid empty names.
  for (const f of feats) {
    const props = f?.properties || {};
    const name = (props.zone_name || "").trim();
    if (!name) continue;

    const z = map ? Math.round(map.getZoom()) : 12;

    // More aggressive truncation when zoomed out to keep labels compact and inside zones
    let maxChars = name.length;
    if (z <= 10) maxChars = 9;
    else if (z === 11) maxChars = 11;
    else if (z === 12) maxChars = 13;
    else if (z === 13) maxChars = 16;
    else maxChars = 28;

    const label = shortenLabel(name, maxChars);

    const pt = findInteriorPointForGeometry(f.geometry);
    if (!pt) continue;

    out.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [pt.lng, pt.lat] },
      properties: {
        LocationID: props.LocationID,
        label,
      },
    });
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

  if (timeLabel && currentFrame?.time) timeLabel.textContent = formatNYCLabel(currentFrame.time);
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

  const nowMinWeek = getNowNYCMinuteOfWeekRounded();
  const idx = pickClosestIndex(minutesOfWeek, nowMinWeek);
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

  if (pts.length <= 1) {
    const z = clamp(map.getZoom(), AUTO_ZOOM_MIN, AUTO_ZOOM_MAX);
    suppressAutoDisableFor(700, () => map.flyTo({ center: pts[0], zoom: z, duration: 600 }));
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
  const el = document.createElement("div");
  el.innerHTML = `
    <div id="navWrap" class="navArrowWrap navPulse">
      <div id="navArrowRot" class="navArrowRot"><div class="navArrow"></div></div>
      <div id="navMeName" class="meName" style="display:${myName ? "block" : "none"}">${escapeHtml(myName)}</div>
    </div>
  `;
  return el;
}

function refreshNavNameLabel() {
  const el = document.getElementById("navMeName");
  if (!el) return;
  const myName = authHeaderOK() ? me?.display_name || "" : "";
  el.textContent = myName;
  el.style.display = myName ? "block" : "none";
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
  el.style.transform = `rotate(${deg}deg)`;
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
  const target = normDeg(nextDeg);
  const finalDeg = smooth ? blendAngleDeg(lastHeadingDeg, target, alpha) : target;
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
    navMarker = new maplibregl.Marker({
      element: makeNavIcon(),
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

      userLatLng = { lat, lng };
      lastGpsAccuracyM = typeof accuracy === "number" && Number.isFinite(accuracy) ? accuracy : null;

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
        suppressAutoDisableFor(700, () => map.easeTo({
          center: [c.lng, c.lat],
          zoom: map.getZoom(),
          bearing: targetBearing,
          duration: 320,
          essential: true,
        }));
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

    const nowMinWeek = getNowNYCMinuteOfWeekRounded();
    const bestIdx = pickClosestIndex(minutesOfWeek, nowMinWeek);

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
  if (document.visibilityState === "visible") {
    refreshCurrentFrame().catch(() => {});
    tickNYCClockAndAdvanceIfNeeded().catch(() => {});
    updateWeatherNow().catch(() => {});
    if (timeline.length) bubbleUpdateNow();
  }
});

/* =========================================================
   WEATHER BADGE + FX (unchanged from old)
   ========================================================= */
const weatherBadge = document.getElementById("weatherBadge");
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
function setWeatherBadge(icon, text) {
  if (!weatherBadge) return;
  const iconEl = weatherBadge.querySelector(".wxIcon");
  const txtEl = weatherBadge.querySelector(".wxTxt");
  if (iconEl) iconEl.textContent = icon;
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

const z100Audio = new Audio();
z100Audio.src = Z100_STREAM_URL;
z100Audio.preload = "none";
z100Audio.crossOrigin = "anonymous";

let megaPlaying = false;
let hot97Playing = false;
let kqPlaying = false;
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

// other drivers markers
const otherMarkers = new Map(); // user_id -> marker

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
  if (typeof window !== "undefined" && typeof window.syncChatPollingState === "function") {
    window.syncChatPollingState();
  }

  if (signedIn) {
    schedulePickupOverlayRefresh({ force: true });
  } else {
    clearPickupOverlay();
  }

  if (openPanelKey === "chat") {
    const html = (typeof window !== "undefined" && typeof window.chatPanelHTML === "function")
      ? window.chatPanelHTML() : "";
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
function driverLabelFontPx() {
  const z = map?.getZoom?.() || 12;
  if (z >= 15) return 11;
  if (z >= 14) return 10.5;
  if (z >= 13) return 10;
  if (z >= 12) return 9.5;
  if (z >= 11) return 9;
  if (z >= 10) return 8.5;
  return 8;
}

function applyDriverLabelZoomStyles() {
  const sizePx = driverLabelFontPx();
  document.querySelectorAll(".otherDrvName, .meName").forEach((el) => {
    el.style.fontSize = `${sizePx}px`;
    el.style.padding = sizePx <= 8.5 ? "2px 6px" : "3px 7px";
  });
}

function makeDriverIcon(name, headingDeg, labelSide = "right", labelDx = 0, labelDy = 0) {
  const safe = (name || "Driver").trim() || "Driver";
  const rot = Number.isFinite(headingDeg) ? headingDeg : 0;
  const defaultLabelX = labelSide === "left" ? -28 : 28;
  const labelTranslateX = Number.isFinite(labelDx) ? labelDx : defaultLabelX;
  const labelTranslateY = Number.isFinite(labelDy) ? labelDy : -8;
  const fontPx = driverLabelFontPx();

  const el = document.createElement("div");
  el.className = "otherDrvWrap";
  el.innerHTML = `
    <div class="otherArrowWrap otherPulse" style="transform:rotate(${rot}deg)">
      <div class="otherArrow"></div>
    </div>
    <div class="otherDrvName" style="font-size:${fontPx}px;transform:translate(${labelTranslateX}px, ${labelTranslateY}px);">
      ${escapeHtml(safe)}
    </div>
  `;
  return el;
}

function clearOtherDrivers() {
  for (const m of otherMarkers.values()) {
    try { m.remove(); } catch {}
  }
  otherMarkers.clear();
}

function upsertDriverMarker(userId, name, lat, lng, heading, labelSide, labelDx = 0, labelDy = 0) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !map) return;
  if (!userId) return;

  const existing = otherMarkers.get(userId);
  if (existing) {
    existing.setLngLat([lng, lat]);
    const el = existing.getElement();
    const newEl = makeDriverIcon(name || `Driver ${userId}`, heading, labelSide, labelDx, labelDy);
    el.innerHTML = newEl.innerHTML;
    return;
  }

  const el = makeDriverIcon(name || `Driver ${userId}`, heading, labelSide, labelDx, labelDy);
  // Pin the marker's bottom-center to the exact coordinates so arrow-tip stays true.
  const mk = new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat([lng, lat]).addTo(map);

  if (!debugOnce.otherMarker) {
    console.log("DEBUG other marker lngLat", { lng, lat });
    debugOnce.otherMarker = true;
  }

  otherMarkers.set(userId, mk);
  applyDriverLabelZoomStyles();
}

async function pullPresenceAll() {
  if (!authHeaderOK() || !map) return;

  try {
    const list = await getJSONAuth("/presence/all", communityToken);
    const now = Date.now() / 1000;

    const items = Array.isArray(list) ? list : list?.items || [];
    const seen = new Set();

    for (const it of items) {
      const uid = String(it.user_id ?? it.userId ?? it.id ?? "");
      if (!uid) continue;
      if (me && String(me.id) === uid) continue;

      let lat = Number(it.lat ?? it.latitude ?? NaN);
      let lng = Number(it.lng ?? it.longitude ?? NaN);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      // Normalise to ~1 m precision to prevent tiny floating-point GPS drift.
      lat = Math.round(lat * 100000) / 100000;
      lng = Math.round(lng * 100000) / 100000;

      const updated = Number(it.updated_at_unix ?? it.ts_unix ?? it.updated_at ?? NaN);
      if (Number.isFinite(updated) && now - updated > PRESENCE_STALE_SEC) continue;

      const name = it.display_name || it.name || it.email || "Driver";
      const heading = Number(it.heading ?? it.bearing ?? NaN);

      // Always render the marker at the provided lat/lng with a consistent label side.
      upsertDriverMarker(uid, name, lat, lng, heading, "right", 0, 0);
      seen.add(uid);
    }

    // Remove markers for drivers that are no longer present.
    for (const uid of Array.from(otherMarkers.keys())) {
      if (!seen.has(uid)) {
        const mk = otherMarkers.get(uid);
        try { mk.remove(); } catch {}
        otherMarkers.delete(uid);
      }
    }
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

  // Start GPS AFTER map exists
  startLocationWatch();
  updateWeatherNow().catch(() => {});
})().catch((err) => {
  console.error(err);
  if (timeLabel) timeLabel.textContent = `Error: ${err?.message || err}`;
});
