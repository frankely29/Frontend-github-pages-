/* =========================================================
   NYC TLC Hotspot Map (Frontend) - SIMPLE + STABLE
   ========================================================= */

const RAILWAY_BASE = "https://web-production-78f67.up.railway.app";
const BIN_MINUTES = 20;

const REFRESH_MS = 5 * 60 * 1000;
const NYC_CLOCK_TICK_MS = 60 * 1000;
const USER_SLIDER_GRACE_MS = 25 * 1000;

/* =========================================================
   COMMUNITY SETTINGS (cheap polling)
   ========================================================= */
const PRESENCE_PUSH_MS = 8 * 1000;     // send my location
const PRESENCE_PULL_MS = 10 * 1000;    // fetch all drivers
const PRESENCE_STALE_SEC = 70;         // hide if older than this

const LS_TOKEN = "community_token_v1";
const LS_EMAIL = "community_email_v1";
const LS_DISPLAY_NAME = "community_display_name_v1";

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
const legendLauncherBtn = document.getElementById("legendLauncher");
const utilityDrawerEl = document.getElementById("utilityDrawer");
const utilityToggleBtn = document.getElementById("utilityToggle");
const utilityLauncherBtn = document.getElementById("utilityLauncher");

function setLegendDrawerOpen(open) {
  if (!legendEl) return;
  legendEl.classList.toggle("closed", !open);
  legendEl.classList.remove("minimized");
  legendEl.setAttribute("aria-hidden", open ? "false" : "true");
  if (legendLauncherBtn) legendLauncherBtn.classList.toggle("hidden", !!open);
  if (legendToggleBtn) {
    legendToggleBtn.textContent = open ? "✕" : "☰";
    legendToggleBtn.setAttribute("aria-label", open ? "Close drawer" : "Open drawer");
  }
}

if (legendEl) {
  setLegendDrawerOpen(!legendEl.classList.contains("closed"));
}

if (legendToggleBtn) {
  legendToggleBtn.addEventListener("click", () => {
    const open = legendEl ? legendEl.classList.contains("closed") : false;
    setLegendDrawerOpen(open);
  });
}

if (legendLauncherBtn) {
  legendLauncherBtn.addEventListener("click", () => setLegendDrawerOpen(true));
}

function setRightDrawerOpen(open) {
  if (!utilityDrawerEl) return;
  utilityDrawerEl.classList.toggle("closed", !open);
  utilityDrawerEl.setAttribute("aria-hidden", open ? "false" : "true");
  if (utilityLauncherBtn) utilityLauncherBtn.classList.toggle("hidden", !!open);
  if (utilityToggleBtn) {
    utilityToggleBtn.textContent = open ? "✕" : "☰";
    utilityToggleBtn.setAttribute("aria-label", open ? "Close drawer" : "Open drawer");
  }
}

if (utilityDrawerEl) {
  setRightDrawerOpen(!utilityDrawerEl.classList.contains("closed"));
}

if (utilityToggleBtn) {
  utilityToggleBtn.addEventListener("click", () => {
    const open = utilityDrawerEl ? utilityDrawerEl.classList.contains("closed") : false;
    setRightDrawerOpen(open);
  });
}

if (utilityLauncherBtn) {
  utilityLauncherBtn.addEventListener("click", () => setRightDrawerOpen(true));
}

/* =========================================================
   Label visibility rules (mobile-friendly)
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
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} @ ${url} :: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON @ ${url} :: ${text.slice(0, 200)}`);
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
function zoomClass(zoom) {
  const z = Math.max(10, Math.min(15, Math.round(zoom)));
  return `z${z}`;
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
    (legendEl ? legendEl : null);

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

function labelHTML(props, zoom) {
  const name = (props.zone_name || "").trim();
  if (!name) return "";

  const b = effectiveBucket(props, null);
  if (!shouldShowLabel(b, Math.round(zoom))) return "";

  const zoneText = zoom < 13 ? shortenLabel(name, LABEL_MAX_CHARS_MID) : name;

  return `<div class="zn">${escapeHtml(zoneText)}</div>`;
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
  navBtn.href = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
    `${lat},${lng}`
  )}&travelmode=driving`;

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
        usedSI: (statenIslandMode && isStatenIslandFeature(props) && Number.isFinite(Number(props.si_local_rating))),
        usedMH: (manhattanMode && isCoreManhattan(props, geom) && Number.isFinite(Number(props.mh_local_rating))),
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
  const modeTag = best.usedSI ? " (SI-local)" : (best.usedMH ? " (Manhattan-adjusted)" : "");
  recommendEl.textContent = `Recommended: ${best.name}${bTxt} — Rating ${best.rating}${modeTag} — ${distTxt}`;

  setNavDestination({ lat: best.lat, lng: best.lng });
}

/* =========================================================
   Leaflet map setup
   ========================================================= */
const slider = document.getElementById("slider");
const timeLabel = document.getElementById("timeLabel");

/* =========================================================
   PRECISION SLIDER POPUP
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
  const trackPx = slider.getBoundingClientRect().width;

  const x = pct * trackPx;
  const pad = 18;
  const clampedX = Math.max(pad, Math.min(trackPx - pad, x));

  sliderBubble.style.left = `${clampedX}px`;
}

function bubbleUpdateNow() {
  setSliderBubbleTextAndPos();
  showSliderBubble();
}

/* =========================================================
   Map
   ========================================================= */
const map = L.map("map", { zoomControl: true }).setView([40.7128, -74.0060], 8);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap &copy; CARTO",
  maxZoom: 19,
}).addTo(map);

const labelsPane = map.createPane("labelsPane");
labelsPane.style.zIndex = 450;

const boroughLabelsPane = map.createPane("boroughLabelsPane");
boroughLabelsPane.style.zIndex = 460;

const navPane = map.createPane("navPane");
navPane.style.zIndex = 1000;

const communityPane = map.createPane("communityPane");
communityPane.style.zIndex = 980;

let geoLayer = null;
let timeline = [];
let minutesOfWeek = [];
let currentFrame = null;
let lastUserSliderTs = 0;
let boroughLabelsLayer = L.layerGroup().addTo(map);
let boroughLabelAnchors = null;

function geometryWeight(geom) {
  if (!geom) return 0;
  if (geom.type === "Polygon") {
    const outer = ringCentroidArea(geom.coordinates?.[0] || []);
    return outer ? Math.abs(outer.area2) : 1;
  }
  if (geom.type === "MultiPolygon") {
    let total = 0;
    for (const poly of geom.coordinates || []) {
      const outer = ringCentroidArea(poly?.[0] || []);
      total += outer ? Math.abs(outer.area2) : 0;
    }
    return total || 1;
  }
  return 1;
}

function buildBoroughLabelAnchors(features) {
  const byBorough = new Map();
  for (const f of features || []) {
    const props = f?.properties || {};
    const borough = (props.borough || "").trim();
    if (!borough) continue;
    const center = geometryCenter(f.geometry);
    if (!center) continue;
    const w = geometryWeight(f.geometry);
    const prev = byBorough.get(borough) || { lat: 0, lng: 0, w: 0 };
    prev.lat += center.lat * w;
    prev.lng += center.lng * w;
    prev.w += w;
    byBorough.set(borough, prev);
  }

  const anchors = [];
  for (const [borough, acc] of byBorough.entries()) {
    if (!acc.w) continue;
    anchors.push({
      borough,
      lat: acc.lat / acc.w,
      lng: acc.lng / acc.w,
    });
  }
  return anchors;
}

function renderBoroughLabels() {
  boroughLabelsLayer.clearLayers();
  for (const b of boroughLabelAnchors || []) {
    L.marker([b.lat, b.lng], {
      pane: "boroughLabelsPane",
      interactive: false,
      zIndexOffset: 50,
      icon: L.divIcon({
        className: "borough-label",
        html: `<div class="btxt">${escapeHtml(b.borough)}</div>`,
      }),
    }).addTo(boroughLabelsLayer);
  }
}

/* =========================================================
   NEXT BIN CACHE
   ========================================================= */
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
  const pay = props.avg_driver_pay == null ? "n/a" : props.avg_driver_pay.toFixed(2);

  const nextPuVal = nextFramePickupsById.get(String(props.LocationID ?? ""));
  const nextPickups = (nextPuVal == null) ? "n/a" : String(Math.round(nextPuVal));

  const nextPayVal = nextFramePayById.get(String(props.LocationID ?? ""));
  const nextPay = (nextPayVal == null) ? "n/a" : Number(nextPayVal).toFixed(2);

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
      <div><b>Avg Pay per Trip (next ${BIN_MINUTES} min historical):</b> $${nextPay}</div>
      <div><b>Avg Pay per Trip (last 20 min):</b> $${pay}</div>
    </div>
  `;
}

function renderFrame(frame) {
  currentFrame = frame;

  if (statenIslandMode) applyStatenLocalView(currentFrame);
  if (manhattanMode) applyManhattanLocalView(currentFrame);

  timeLabel.textContent = formatNYCLabel(currentFrame.time);

  if (geoLayer) {
    geoLayer.remove();
    geoLayer = null;
  }

  const zoomNow = map.getZoom();
  const zClass = zoomClass(zoomNow);

  geoLayer = L.geoJSON(currentFrame.polygons, {
    style: (feature) => {
      const props = feature?.properties || {};
      const st = props.style || {};
      const fill = effectiveColor(props, feature.geometry);

      return {
        color: fill,
        weight: st.weight ?? 0,
        opacity: st.opacity ?? 0,
        fillColor: fill,
        fillOpacity: st.fillOpacity ?? 0.82,
      };
    },
    onEachFeature: (feature, layer) => {
      const props = feature.properties || {};
      layer.bindPopup(buildPopupHTML(props, feature.geometry), { maxWidth: 320 });

      const html = labelHTML(props, zoomNow);
      if (!html) return;

      layer.bindTooltip(html, {
        permanent: true,
        direction: "center",
        className: `zone-label ${zClass}`,
        opacity: 0.92,
        interactive: false,
        pane: "labelsPane",
      });
    },
  }).addTo(map);

  if (!boroughLabelAnchors) {
    boroughLabelAnchors = buildBoroughLabelAnchors(currentFrame?.polygons?.features || []);
  }
  renderBoroughLabels();

  updateRecommendation(currentFrame);
}

async function loadFrame(idx) {
  loadNextFramePickupsMap(idx).catch(() => {});
  const frame = await fetchJSON(`${RAILWAY_BASE}/frame/${idx}`);
  renderFrame(frame);
}

async function loadTimeline() {
  const t = await fetchJSON(`${RAILWAY_BASE}/timeline`);
  timeline = Array.isArray(t) ? t : (t.timeline || []);
  if (!timeline.length) throw new Error("Timeline empty. Run /generate once on Railway.");

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

map.on("zoomend", () => {
  if (currentFrame) renderFrame(currentFrame);
  if (authHeaderOK()) pullPresenceAll().catch(() => {});
});

let sliderDebounce = null;

slider.addEventListener("pointerdown", bubbleUpdateNow);
slider.addEventListener("touchstart", bubbleUpdateNow, { passive: true });

slider.addEventListener("input", () => {
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

function syncCenterButton() {
  if (!btnCenter) return;
  btnCenter.textContent = autoCenter ? "Auto-center: ON" : "Auto-center: OFF";
  btnCenter.classList.toggle("on", !!autoCenter);
}
syncCenterButton();

if (btnCenter) {
  btnCenter.addEventListener("pointerdown", (e) => e.stopPropagation());
  btnCenter.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });

  btnCenter.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();

    autoCenter = !autoCenter;
    syncCenterButton();

    if (autoCenter && userLatLng) {
      suppressAutoDisableFor(800, () => map.panTo(userLatLng, { animate: true }));
    }
  });
}

function disableAutoCenterBecauseUserIsExploring() {
  if (Date.now() < suppressAutoDisableUntil) return;
  if (!autoCenter) return;
  autoCenter = false;
  syncCenterButton();
}
map.on("dragstart", disableAutoCenterBecauseUserIsExploring);
map.on("zoomstart", disableAutoCenterBecauseUserIsExploring);

/* =========================================================
   Live location arrow + follow behavior
   ========================================================= */
let gpsFirstFixDone = false;
let navMarker = null;
let lastPos = null;
let lastHeadingDeg = 0;
let lastMoveTs = 0;

function makeNavIcon() {
  const myName = authHeaderOK() ? (me?.display_name || "") : "";
  return L.divIcon({
    className: "",
    html: `
      <div id="navWrap" class="navArrowWrap navPulse">
        <div id="navArrowRot" class="navArrowRot"><div class="navArrow"></div></div>
        <div id="navMeName" class="meName" style="display:${myName ? "block" : "none"}">${escapeHtml(myName)}</div>
      </div>
    `,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function refreshNavNameLabel() {
  const el = document.getElementById("navMeName");
  if (!el) return;
  const myName = authHeaderOK() ? (me?.display_name || "") : "";
  el.textContent = myName;
  el.style.display = myName ? "block" : "none";
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

  navMarker = L.marker([40.7128, -74.0060], {
    icon: makeNavIcon(),
    interactive: false,
    zIndexOffset: 2000000,
    pane: "navPane",
  }).addTo(map);

  navigator.geolocation.watchPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const heading = pos.coords.heading;
      const accuracy = pos.coords.accuracy;
      const ts = pos.timestamp || Date.now();

      userLatLng = { lat, lng };
      lastGpsAccuracyM = (typeof accuracy === "number" && Number.isFinite(accuracy)) ? accuracy : null;
      if (navMarker) navMarker.setLatLng(userLatLng);

      let isMoving = false;

      if (lastPos) {
        const dMi = haversineMiles({ lat: lastPos.lat, lng: lastPos.lng }, userLatLng);
        const dtSec = Math.max(1, (ts - lastPos.ts) / 1000);
        const mph = (dMi / dtSec) * 3600;

        isMoving = mph >= 2.0;

        if (typeof heading === "number" && Number.isFinite(heading)) {
          lastHeadingDeg = heading;
        } else if (dMi > 0.01) {
          lastHeadingDeg = computeBearingDeg({ lat: lastPos.lat, lng: lastPos.lng }, userLatLng);
        }

        if (isMoving) lastMoveTs = ts;
      }

      lastPos = { lat, lng, ts };

      setNavRotation(lastHeadingDeg);
      setNavVisual(isMoving);

      if (!gpsFirstFixDone) {
        gpsFirstFixDone = true;
        const targetZoom = Math.max(map.getZoom(), 12.5);
        suppressAutoDisableFor(1200, () => map.setView(userLatLng, targetZoom, { animate: true }));
      } else {
        if (autoCenter) {
          suppressAutoDisableFor(700, () => map.panTo(userLatLng, { animate: true }));
        }
      }

      if (currentFrame) updateRecommendation(currentFrame);

      scheduleWeatherUpdateSoon();

      // community push (auth only)
      communityMaybePushPresence(ts, heading, lastGpsAccuracyM);
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
    const recentlyMoved = lastMoveTs && (now - lastMoveTs) < 5000;
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
   WEATHER BADGE + FX (unchanged)
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
    const intensity = (c >= 65 || c >= 81) ? 0.85 : (c >= 63 ? 0.65 : 0.45);
    return { text: "Rain", icon: "🌧️", kind: "rain", intensity };
  }
  if ((c >= 71 && c <= 77) || (c >= 85 && c <= 86)) {
    const intensity = (c >= 75 || c >= 86) ? 0.85 : 0.6;
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
  const lng = userLatLng?.lng ?? -74.0060;
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
  const count = Math.max(
    40,
    Math.min(240, Math.floor(base * (kind === "rain" ? 2.4 : 1.6) * (0.6 + intensity)))
  );

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

  const shouldRun = (wxState.kind !== "none" && wxState.intensity > 0);
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
   RADIO (kept simple; manual play)
   ========================================================= */
const btnHot97 = document.getElementById("btnHot97");
const btnMega979 = document.getElementById("btnMega979");
const radioStatusEl = document.getElementById("radioStatus");

const radioModal = document.getElementById("radioModal");
const radioFrame = document.getElementById("radioFrame");
const radioModalClose = document.getElementById("radioModalClose");
const radioModalTitle = document.getElementById("radioModalTitle");

const HOT97_STREAM_URL = "https://26313.live.streamtheworld.com/WQHTFMAAC.aac";
const MEGA979_STREAM_URL = "https://liveaudio.lamusica.com/NY_WSKQ_icy";

const megaAudio = new Audio();
megaAudio.src = MEGA979_STREAM_URL;
megaAudio.preload = "none";
megaAudio.crossOrigin = "anonymous";

const hot97Audio = new Audio();
hot97Audio.src = HOT97_STREAM_URL;
hot97Audio.preload = "none";
hot97Audio.crossOrigin = "anonymous";

let megaPlaying = false;
let hot97Playing = false;

function setRadioStatus(txt) {
  if (radioStatusEl) radioStatusEl.textContent = txt;
}
function setBtnState(btn, on) {
  if (!btn) return;
  btn.classList.toggle("on", !!on);
  const base = btn === btnMega979 ? "La Mega 97.9" : "HOT 97.1";
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

async function toggleMega() {
  try {
    if (hot97Playing) {
      hot97Audio.pause();
      hot97Playing = false;
      setBtnState(btnHot97, false);
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

const btnPolice = document.getElementById("btnPolice");
const btnPickup = document.getElementById("btnPickup");
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

function stableUidParity(uid) {
  const uidStr = String(uid || "");
  const uidNum = Number.parseInt(uidStr, 10);
  if (Number.isFinite(uidNum)) return Math.abs(uidNum) % 2;

  let hash = 0;
  for (let i = 0; i < uidStr.length; i++) {
    hash = ((hash << 5) - hash) + uidStr.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 2;
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

function setAuthUI(signedIn, note) {
  if (btnAuth) btnAuth.textContent = signedIn ? "Sign out" : "Sign in";
  if (communityNote) {
    communityNote.textContent = signedIn
      ? "Community: live drivers are visible. Police reports + pickups are shared."
      : "Community: sign in to see other drivers + report police + log pickups.";
  }

  const showLock = !signedIn;
  if (lockedOverlay) {
    lockedOverlay.classList.toggle("show", showLock);
    lockedOverlay.setAttribute("aria-hidden", showLock ? "false" : "true");
  }

  // buttons still exist, but are useful only if signed in
  if (btnPolice) btnPolice.classList.toggle("disabled", !signedIn);
  if (btnPickup) btnPickup.classList.toggle("disabled", !signedIn);
  if (btnGhostMode) btnGhostMode.classList.toggle("disabled", !signedIn);

  if (authStatus) authStatus.textContent = note || (signedIn ? "Status: signed in" : "Status: signed out");
  syncGhostUI();
  refreshNavNameLabel();
}

function clearAuth() {
  communityToken = "";
  me = null;
  localStorage.removeItem(LS_TOKEN);
  setAuthUI(false, "Status: signed out");
  clearOtherDrivers();
}

function authHeaderOK() {
  return communityToken && communityToken.length > 10;
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
  return (authName && authName.value ? authName.value.trim() : "");
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
    localStorage.setItem(LS_DISPLAY_NAME, (email.split("@")[0] || "Driver"));
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

function safeEmail() {
  return (authEmail && authEmail.value ? authEmail.value.trim() : (localStorage.getItem(LS_EMAIL) || "").trim());
}
function safePass() {
  return (authPass && authPass.value ? authPass.value : "");
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
      // sign out
      clearAuth();
    } else {
      // show overlay
      setAuthUI(false, "Status: signed out");
    }
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

function makeDriverIcon(name, headingDeg, labelSide = "right", labelDx = 0, labelDy = 0) {
  const safe = (name || "Driver").trim() || "Driver";
  const rot = Number.isFinite(headingDeg) ? headingDeg : 0;
  const defaultLabelX = labelSide === "left" ? -28 : 28;
  const labelTranslateX = Number.isFinite(labelDx) ? labelDx : defaultLabelX;
  const labelTranslateY = Number.isFinite(labelDy) ? labelDy : -8;
  const html = `
    <div class="otherDrvWrap">
      <div class="otherArrowWrap otherPulse" style="transform:rotate(${rot}deg)">
        <div class="otherArrow"></div>
      </div>
      <div class="otherDrvName" style="transform:translate(${labelTranslateX}px, ${labelTranslateY}px);">
        ${escapeHtml(safe)}
      </div>
    </div>
  `;
  return L.divIcon({
    className: "",
    html,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  });
}

function clearOtherDrivers() {
  for (const m of otherMarkers.values()) {
    try { m.remove(); } catch {}
  }
  otherMarkers.clear();
}

function upsertDriverMarker(userId, name, lat, lng, heading, labelSide, labelDx = 0, labelDy = 0) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  if (!userId) return;

  const existing = otherMarkers.get(userId);
  if (existing) {
    existing.setLatLng([lat, lng]);
    existing.setIcon(makeDriverIcon(name || `Driver ${userId}`, heading, labelSide, labelDx, labelDy));
    return;
  }

  const mk = L.marker([lat, lng], {
    icon: makeDriverIcon(name || `Driver ${userId}`, heading, labelSide, labelDx, labelDy),
    interactive: false,
    pane: "communityPane",
    zIndexOffset: 1500000,
  }).addTo(map);

  otherMarkers.set(userId, mk);
}

async function pullPresenceAll() {
  if (!authHeaderOK()) return;

  try {
    const list = await getJSONAuth("/presence/all", communityToken);
    const now = Date.now() / 1000;

    // expected list array; if wrapped, try .items
    const items = Array.isArray(list) ? list : (list?.items || []);
    const seen = new Set();
    const visibleDrivers = [];

    for (const it of items) {
      const uid = String(it.user_id ?? it.userId ?? it.id ?? "");
      if (!uid) continue;

      // hide self
      if (me && (String(me.id) === uid)) continue;

      const lat = Number(it.lat ?? it.latitude ?? NaN);
      const lng = Number(it.lng ?? it.longitude ?? NaN);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      // staleness check
      const updated = Number(it.updated_at_unix ?? it.ts_unix ?? it.updated_at ?? NaN);
      if (Number.isFinite(updated)) {
        if ((now - updated) > PRESENCE_STALE_SEC) continue;
      }

      const name = it.display_name || it.name || it.email || "Driver";
      const heading = Number(it.heading ?? it.bearing ?? NaN);
      visibleDrivers.push({ uid, name, heading, lat, lng });
      seen.add(uid);
    }

    const selfPt = userLatLng
      ? map.latLngToLayerPoint([userLatLng.lat, userLatLng.lng])
      : null;

    const driversWithPoints = visibleDrivers.map((drv) => ({
      ...drv,
      basePoint: map.latLngToLayerPoint([drv.lat, drv.lng]),
    }));

    const COLLISION_PX = 28;
    const clustered = new Set();
    const collisionClusters = [];

    for (let i = 0; i < driversWithPoints.length; i++) {
      const start = driversWithPoints[i];
      if (clustered.has(start.uid)) continue;

      const cluster = [];
      const queue = [start];
      clustered.add(start.uid);

      while (queue.length) {
        const current = queue.pop();
        cluster.push(current);

        for (const candidate of driversWithPoints) {
          if (clustered.has(candidate.uid)) continue;
          if (current.basePoint.distanceTo(candidate.basePoint) > COLLISION_PX) continue;
          clustered.add(candidate.uid);
          queue.push(candidate);
        }
      }

      cluster.sort((a, b) => a.uid.localeCompare(b.uid));
      collisionClusters.push(cluster);
    }

    for (const group of collisionClusters) {

      for (let idx = 0; idx < group.length; idx++) {
        const drv = group[idx];
        let labelSide = (idx % 2 === 0) ? "right" : "left";

        let labelDx = 0;
        let labelDy = 0;

        const basePoint = drv.basePoint;

        if (selfPt) {
          const distPx = basePoint.distanceTo(selfPt);
          if (distPx < SELF_COLLISION_THRESHOLD_PX) {
            labelDx = (SELF_LABEL_SIDE === "right")
              ? -SELF_COLLISION_OFFSET_PX
              : SELF_COLLISION_OFFSET_PX;
            labelDy = 0;
            labelSide = sideFromOffsetX(labelDx, SELF_LABEL_SIDE === "left" ? "right" : "left");
          }
        }

        if (group.length > 1 && labelDx === 0 && labelDy === 0) {
          [labelDx, labelDy] = LABEL_OFFSETS[idx % LABEL_OFFSETS.length];
          labelSide = sideFromOffsetX(labelDx, labelSide);
        }

        // Keep marker pinned to the true reported coordinates; shift labels only.
        upsertDriverMarker(drv.uid, drv.name, drv.lat, drv.lng, drv.heading, labelSide, labelDx, labelDy);
      }
    }

    // remove markers not in latest response
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
async function communityMaybePushPresence(tsMsOrUnix, heading, accuracy) {
  if (!authHeaderOK()) return;
  if (!userLatLng) return;

  const nowMs = Date.now();
  if ((nowMs - lastPresencePushMs) < PRESENCE_PUSH_MS) return;
  lastPresencePushMs = nowMs;

  try {
    const ts_unix = Math.floor((tsMsOrUnix ? Number(tsMsOrUnix) : Date.now()) / 1000);
    await postJSON("/presence/update", {
      lat: userLatLng.lat,
      lng: userLatLng.lng,
      heading: (typeof heading === "number" && Number.isFinite(heading)) ? heading : null,
      accuracy: (typeof accuracy === "number" && Number.isFinite(accuracy)) ? accuracy : null,
      ts_unix,
    }, communityToken);
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
  // if somehow super far, still return (NYC-wide)
  return best;
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
    await postJSON("/events/police", {
      lat: userLatLng.lat,
      lng: userLatLng.lng,
      ts_unix,
    }, communityToken);

    alert("Police report sent to community ✅");
  } catch (e) {
    alert(`Police report failed: ${e.message || e}`);
  }
}

async function sendPickupLog() {
  if (!authHeaderOK()) {
    setAuthUI(false, "Sign in to log pickups.");
    return;
  }
  if (!userLatLng) {
    alert("Enable location first.");
    return;
  }
  try {
    const ts_unix = Math.floor(Date.now() / 1000);
    const near = nearestZoneToUser(currentFrame, userLatLng);

    await postJSON("/events/pickup", {
      lat: userLatLng.lat,
      lng: userLatLng.lng,
      ts_unix,
      frame_time: currentFrame?.time || null,
      location_id: near?.location_id ?? null,
      zone_name: near?.zone_name ?? null,
      borough: near?.borough ?? null,
    }, communityToken);

    const label = near?.zone_name ? `${near.zone_name}${near.borough ? ` (${near.borough})` : ""}` : "your location";
    alert(`Pickup logged ✅ (${label})`);
  } catch (e) {
    alert(`Pickup log failed: ${e.message || e}`);
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

/* poll presence */
setInterval(() => {
  pullPresenceAll().catch(() => {});
}, PRESENCE_PULL_MS);

/* =========================================================
   Boot
   ========================================================= */
setNavDestination(null);

loadTimeline().catch((err) => {
  console.error(err);
  timeLabel.textContent = `Error loading timeline: ${err.message}`;
});

/* auth boot */
(async () => {
  if (authHeaderOK()) {
    setAuthUI(true, "Checking session…");
    await loadMe();
    if (authHeaderOK()) {
      setAuthUI(true, `Status: signed in as ${me?.display_name || me?.email || "Driver"}`);
      pullPresenceAll().catch(() => {});
    } else {
      setAuthUI(false, "Status: signed out");
    }
  } else {
    setAuthUI(false, "Status: signed out");
  }
})();

startLocationWatch();
updateWeatherNow().catch(() => {});
