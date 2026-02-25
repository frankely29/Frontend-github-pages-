/* =========================================================
   NYC TLC Hotspot Map (Frontend) — WORKING BASE + Friends
   KEEP ALL EXISTING BEHAVIOR EXACTLY
   Added:
   - Username prompt (saved once)
   - Sign in/out button (auto-injected if missing)
   - Auto sign-out after 30 minutes inactivity
   - Realtime friends via WebSocket (graceful fallback if WS unavailable)
   - Username displayed next to your arrow (and friends’ markers)
   - When signed out: map access is blocked (privacy)
   ========================================================= */

const RAILWAY_BASE = "https://web-production-78f67.up.railway.app";
const BIN_MINUTES = 20;

// Refresh current frame every 5 minutes
const REFRESH_MS = 5 * 60 * 1000;

/* =========================================================
   Friends / Presence config
   ========================================================= */
const PRESENCE_WS_PATH = "/ws";              // backend should expose this
const PRESENCE_PING_MS = 15 * 1000;
const PRESENCE_SEND_MS = 3 * 1000;           // send your location every 3s
const INACTIVITY_SIGNOUT_MS = 30 * 60 * 1000; // 30 minutes

const LS_KEY_USERNAME = "friends_username_v1";
const LS_KEY_SESSION = "friends_session_v1"; // lightweight session token
const LS_KEY_LAST_ACTIVE = "friends_last_active_v1";

/* =========================================================
   Small CSS injection for name labels + sign-in overlay
   (index.html stays “as-is”)
   ========================================================= */
(function injectFriendsCSS() {
  const css = `
  .navNameTag{
    position:absolute;
    left: 34px;
    top: 50%;
    transform: translateY(-50%);
    font-family: system-ui,-apple-system,Segoe UI,Roboto,Arial;
    font-weight: 950;
    font-size: 12px;
    color: #111;
    background: rgba(255,255,255,0.92);
    border: 1px solid rgba(0,0,0,0.18);
    border-radius: 999px;
    padding: 2px 8px;
    white-space: nowrap;
    box-shadow: 0 2px 6px rgba(0,0,0,0.12);
    pointer-events:none;
  }
  .friendWrap .navArrow{
    border-bottom-color: #0b2a3a;
    filter: drop-shadow(0 2px 2px rgba(0,0,0,0.35));
  }
  .friendWrap.navMoving .navArrow{
    filter:
      drop-shadow(0 2px 2px rgba(0,0,0,0.35))
      drop-shadow(0 0 6px rgba(0,160,255,0.65));
  }

  .authOverlay{
    position:absolute;
    inset:0;
    z-index: 2000;
    display:none;
    align-items:center;
    justify-content:center;
    background: rgba(255,255,255,0.86);
    backdrop-filter: blur(2px);
    font-family: system-ui,-apple-system,Segoe UI,Roboto,Arial;
  }
  .authOverlay .card{
    width: min(520px, calc(100vw - 28px));
    background: rgba(255,255,255,0.98);
    border-radius: 18px;
    padding: 16px 16px 14px 16px;
    box-shadow: 0 14px 40px rgba(0,0,0,0.22);
    border: 1px solid rgba(0,0,0,0.08);
  }
  .authOverlay .title{
    font-weight: 950;
    font-size: 16px;
    margin-bottom: 6px;
  }
  .authOverlay .sub{
    font-weight: 800;
    font-size: 12px;
    opacity: 0.78;
    line-height: 1.25;
    margin-bottom: 10px;
  }
  .authOverlay .row{
    display:flex;
    gap:10px;
    flex-wrap:wrap;
  }
  .authOverlay input{
    flex: 1 1 220px;
    border-radius: 12px;
    border: 1px solid rgba(0,0,0,0.18);
    padding: 10px 12px;
    font-size: 14px;
    font-weight: 800;
    outline: none;
  }
  .authOverlay button{
    border:none;
    border-radius: 999px;
    padding: 10px 14px;
    font-weight: 950;
    font-size: 14px;
    cursor: pointer;
    background: rgba(0,160,255,0.14);
    color: #0b2a3a;
  }
  .authOverlay button:active{ transform: scale(0.98); }
  `;
  const el = document.createElement("style");
  el.textContent = css;
  document.head.appendChild(el);
})();

/* =========================================================
   Legend minimize (unchanged)
   ========================================================= */
const legendEl = document.getElementById("legend");
const legendToggleBtn = document.getElementById("legendToggle");
if (legendEl && legendToggleBtn) {
  legendToggleBtn.addEventListener("click", () => {
    const minimized = legendEl.classList.toggle("minimized");
    legendToggleBtn.textContent = minimized ? "+" : "–";
  });
}

/** LABEL VISIBILITY (mobile-friendly, demand-priority) */
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

// ---------- Time helpers ----------
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

// ---------- Network ----------
async function fetchJSON(url) {
  const res = await fetch(url, { cache: "no-store", mode: "cors" });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} @ ${url} :: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON @ ${url} :: ${text.slice(0, 200)}`);
  }
}

// ---------- Bucket label ----------
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

// ---------- Label helpers ----------
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
   Staten Island Mode (toggle anywhere) — UNCHANGED
   ========================================================= */
const btnStatenIsland = document.getElementById("btnStatenIsland");
const modeNote = document.getElementById("modeNote");

const LS_KEY_STATEN = "staten_island_mode_enabled";
let statenIslandMode = (localStorage.getItem(LS_KEY_STATEN) || "0") === "1";

function isStatenIslandFeature(props) {
  const b = (props?.borough || "").toString().toLowerCase();
  return b.includes("staten");
}

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
      if (sorted[mid] <= r) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
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

function effectiveBucket(props) {
  if (statenIslandMode && isStatenIslandFeature(props) && props.si_local_bucket) return props.si_local_bucket;
  return (props.bucket || "").trim();
}
function effectiveColor(props) {
  if (statenIslandMode && isStatenIslandFeature(props) && props.si_local_color) return props.si_local_color;
  const st = props?.style || {};
  return st.fillColor || st.color || "#000";
}

function labelHTML(props, zoom) {
  const name = (props.zone_name || "").trim();
  if (!name) return "";

  const b = effectiveBucket(props);
  if (!shouldShowLabel(b, Math.round(zoom))) return "";

  const zoneText = zoom < 13 ? shortenLabel(name, LABEL_MAX_CHARS_MID) : name;

  const borough = (props.borough || "").trim();
  const showBorough = zoom >= BOROUGH_ZOOM_SHOW && borough;

  return `
    <div class="zn">${escapeHtml(zoneText)}</div>
    ${showBorough ? `<div class="br">${escapeHtml(borough)}</div>` : ""}
  `;
}

/* =========================================================
   Recommendation + Navigation — UNCHANGED
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

function geometryCenter(geom) {
  let pts = [];
  if (!geom) return null;

  if (geom.type === "Polygon") {
    pts = geom.coordinates?.[0] || [];
  } else if (geom.type === "MultiPolygon") {
    const polys = geom.coordinates || [];
    for (const p of polys) {
      const ring = p?.[0] || [];
      pts.push(...ring);
    }
  } else {
    return null;
  }

  if (!pts.length) return null;

  let sumLng = 0,
    sumLat = 0;
  for (const [lng, lat] of pts) {
    sumLng += lng;
    sumLat += lat;
  }
  return { lat: sumLat / pts.length, lng: sumLng / pts.length };
}

// Blue+ rule on effective bucket
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

    const b = effectiveBucket(props);
    if (!allowed.has(b)) continue;

    const rating =
      statenIslandMode && isStatenIslandFeature(props) && Number.isFinite(Number(props.si_local_rating))
        ? Number(props.si_local_rating)
        : Number(props.rating ?? NaN);

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
        usedLocal: statenIslandMode && isStatenIslandFeature(props) && Number.isFinite(Number(props.si_local_rating)),
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
  const modeTag = best.usedLocal ? " (SI-local)" : "";
  recommendEl.textContent = `Recommended: ${best.name}${bTxt} — Rating ${best.rating}${modeTag} — ${distTxt}`;

  setNavDestination({
    lat: best.lat,
    lng: best.lng,
    name: best.name,
    borough: best.borough,
    rating: best.rating,
    distMi: best.dMi,
  });
}

/* =========================================================
   Leaflet map — UNCHANGED defaults
   ========================================================= */
const slider = document.getElementById("slider");
const timeLabel = document.getElementById("timeLabel");

const map = L.map("map", { zoomControl: true }).setView([40.7128, -74.0060], 11);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap &copy; CARTO",
  maxZoom: 19,
}).addTo(map);

let geoLayer = null;
let timeline = [];
let minutesOfWeek = [];
let currentFrame = null;

function buildPopupHTML(props) {
  const zoneName = (props.zone_name || "").trim();
  const borough = (props.borough || "").trim();

  const rating = props.rating ?? "";
  const bucket = props.bucket ?? "";
  const pickups = props.pickups ?? "";
  const pay = props.avg_driver_pay == null ? "n/a" : props.avg_driver_pay.toFixed(2);

  let extra = "";
  if (statenIslandMode && isStatenIslandFeature(props) && Number.isFinite(Number(props.si_local_rating))) {
    extra = `<div style="margin-top:6px;"><b>Staten Local Rating:</b> ${props.si_local_rating} (${prettyBucket(
      props.si_local_bucket
    )})</div>`;
  }

  return `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; font-size:13px;">
      <div style="font-weight:800; margin-bottom:2px;">${escapeHtml(
        zoneName || `Zone ${props.LocationID ?? ""}`
      )}</div>
      ${
        borough
          ? `<div style="opacity:0.8; margin-bottom:6px;">${escapeHtml(borough)}</div>`
          : `<div style="margin-bottom:6px;"></div>`
      }
      <div><b>NYC Rating:</b> ${rating} (${prettyBucket(bucket)})</div>
      ${extra}
      <div style="margin-top:6px;"><b>Pickups (last ${BIN_MINUTES} min):</b> ${pickups}</div>
      <div><b>Avg Driver Pay:</b> $${pay}</div>
    </div>
  `;
}

function renderFrame(frame) {
  currentFrame = frame;
  if (statenIslandMode) applyStatenLocalView(currentFrame);

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
      const fill = effectiveColor(props);

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
      layer.bindPopup(buildPopupHTML(props), { maxWidth: 320 });

      const html = labelHTML(props, zoomNow);
      if (!html) return;

      layer.bindTooltip(html, {
        permanent: true,
        direction: "center",
        className: `zone-label ${zClass}`,
        opacity: 0.92,
        interactive: false,
      });
    },
  }).addTo(map);

  updateRecommendation(currentFrame);
}

async function loadFrame(idx) {
  const frame = await fetchJSON(`${RAILWAY_BASE}/frame/${idx}`);
  renderFrame(frame);
}

async function loadTimeline() {
  const t = await fetchJSON(`${RAILWAY_BASE}/timeline`);
  timeline = Array.isArray(t) ? t : t.timeline || [];
  if (!timeline.length) throw new Error("Timeline empty. Run /generate once on Railway.");

  minutesOfWeek = timeline.map(minuteOfWeekFromIso);

  slider.min = "0";
  slider.max = String(timeline.length - 1);
  slider.step = "1";

  const nowMinWeek = getNowNYCMinuteOfWeekRounded();
  const idx = pickClosestIndex(minutesOfWeek, nowMinWeek);
  slider.value = String(idx);

  await loadFrame(idx);
}

map.on("zoomend", () => {
  if (currentFrame) renderFrame(currentFrame);
});

let sliderDebounce = null;
slider.addEventListener("input", () => {
  const idx = Number(slider.value);
  if (sliderDebounce) clearTimeout(sliderDebounce);
  sliderDebounce = setTimeout(() => loadFrame(idx).catch(console.error), 80);
});

/* =========================================================
   Auto-center button (inside bottom bar) - stable logic
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

    markActiveNow();
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
map.on("dragstart", () => {
  markActiveNow();
  disableAutoCenterBecauseUserIsExploring();
});
map.on("zoomstart", () => {
  markActiveNow();
  disableAutoCenterBecauseUserIsExploring();
});

/* =========================================================
   Live location arrow + auto-center (unchanged base)
   BUT: now includes username label next to arrow
   ========================================================= */
let gpsFirstFixDone = false;
let navMarker = null;
let lastPos = null;
let lastHeadingDeg = 0;
let lastMoveTs = 0;

// Friends state
let signedIn = false;
let currentUsername = "";
let sessionToken = "";
let geoWatchId = null;

let presenceWS = null;
let presencePingTimer = null;
let presenceSendTimer = null;

// friend markers: key -> { marker, lastSeenMs }
const friendMarkers = new Map();

function makeNavIcon(name, wrapClass = "") {
  const safeName = escapeHtml((name || "").trim());
  const nameHtml = safeName ? `<div class="navNameTag">${safeName}</div>` : "";
  return L.divIcon({
    className: "",
    html: `<div id="navWrap" class="navArrowWrap navPulse ${wrapClass}">${nameHtml}<div class="navArrow"></div></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function setNavVisual(isMoving) {
  const el = document.getElementById("navWrap");
  if (!el) return;
  el.classList.toggle("navMoving", !!isMoving);
  el.classList.toggle("navPulse", !isMoving);
}

function setNavRotation(deg) {
  const el = document.getElementById("navWrap");
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

/* =========================================================
   Auth UI (auto-inject button + overlay)
   ========================================================= */
const mapDiv = document.getElementById("map");

const authOverlay = (function buildOverlay() {
  const ov = document.createElement("div");
  ov.className = "authOverlay";
  ov.innerHTML = `
    <div class="card">
      <div class="title">Sign in to use the map</div>
      <div class="sub">
        Enter a username once. You’ll be visible to friends while signed in.<br/>
        For privacy: you’ll be signed out automatically after 30 minutes inactive.
      </div>
      <div class="row">
        <input id="authNameInput" placeholder="Username (e.g., Frankelly)" maxlength="24" autocomplete="off" />
        <button id="authGoBtn" type="button">Sign in</button>
      </div>
    </div>
  `;
  if (mapDiv && mapDiv.parentElement) mapDiv.parentElement.appendChild(ov);
  return ov;
})();

function ensureAuthButton() {
  // Try to place inside legend navRow
  const navRow = document.querySelector(".navRow");
  let btn = document.getElementById("btnAuth");
  if (btn) return btn;

  btn = document.createElement("button");
  btn.id = "btnAuth";
  btn.className = "modeBtn";
  btn.type = "button";
  btn.textContent = "Sign in";
  btn.addEventListener("pointerdown", (e) => e.stopPropagation());
  btn.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    markActiveNow();
    if (signedIn) signOut("manual");
    else showAuthOverlay(true);
  });

  if (navRow) navRow.appendChild(btn);
  else if (legendEl) legendEl.appendChild(btn);

  return btn;
}

const btnAuth = ensureAuthButton();

function showAuthOverlay(show) {
  if (!authOverlay) return;
  authOverlay.style.display = show ? "flex" : "none";

  // Block map interactions when overlay is visible
  if (mapDiv) mapDiv.style.pointerEvents = show ? "none" : "auto";
  try {
    if (show) map.dragging.disable();
    else map.dragging.enable();
  } catch {}
  try {
    if (show) map.touchZoom.disable();
    else map.touchZoom.enable();
  } catch {}
  try {
    if (show) map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();
  } catch {}
  try {
    if (show) map.scrollWheelZoom.disable();
    else map.scrollWheelZoom.enable();
  } catch {}
  try {
    if (show) map.boxZoom.disable();
    else map.boxZoom.enable();
  } catch {}
  try {
    if (show) map.keyboard.disable();
    else map.keyboard.enable();
  } catch {}
}

function setAuthButtonUI() {
  if (!btnAuth) return;
  btnAuth.textContent = signedIn ? "Sign out" : "Sign in";
  btnAuth.classList.toggle("on", !!signedIn);
}

function sanitizeUsername(name) {
  const s = (name || "").trim().replace(/\s+/g, " ");
  if (!s) return "";
  // allow letters/numbers/space/_-.
  const cleaned = s.replace(/[^\w\s\-.]/g, "");
  return cleaned.slice(0, 24);
}

function getOrCreateSessionToken() {
  let tok = localStorage.getItem(LS_KEY_SESSION) || "";
  if (tok && tok.length >= 10) return tok;

  // simple random token (not “secure”; just session identity)
  tok = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  localStorage.setItem(LS_KEY_SESSION, tok);
  return tok;
}

function markActiveNow() {
  const now = Date.now();
  localStorage.setItem(LS_KEY_LAST_ACTIVE, String(now));
}

function lastActiveMs() {
  const v = Number(localStorage.getItem(LS_KEY_LAST_ACTIVE) || "0");
  return Number.isFinite(v) ? v : 0;
}

function autoSignOutIfInactive() {
  if (!signedIn) return;
  const now = Date.now();
  const last = lastActiveMs();
  if (last && now - last > INACTIVITY_SIGNOUT_MS) {
    signOut("inactive_30m");
  }
}

/* =========================================================
   Presence (WebSocket)
   ========================================================= */
function wsURL() {
  // RAILWAY_BASE like https://... -> wss://...
  try {
    const u = new URL(RAILWAY_BASE);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = PRESENCE_WS_PATH;
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    // fallback naive
    return RAILWAY_BASE.replace(/^https:/, "wss:").replace(/^http:/, "ws:") + PRESENCE_WS_PATH;
  }
}

function closePresenceWS() {
  try {
    if (presencePingTimer) clearInterval(presencePingTimer);
    presencePingTimer = null;
    if (presenceSendTimer) clearInterval(presenceSendTimer);
    presenceSendTimer = null;

    if (presenceWS) {
      presenceWS.onopen = null;
      presenceWS.onmessage = null;
      presenceWS.onerror = null;
      presenceWS.onclose = null;
      presenceWS.close();
    }
  } catch {}
  presenceWS = null;
}

function clearFriendMarkers() {
  for (const [, obj] of friendMarkers.entries()) {
    try {
      obj.marker.remove();
    } catch {}
  }
  friendMarkers.clear();
}

function upsertFriendMarker(userKey, name, lat, lng, headingDeg) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

  // never create a “friend” marker for yourself
  if (userKey === sessionToken) return;

  const existing = friendMarkers.get(userKey);
  const pos = [lat, lng];

  if (!existing) {
    const icon = L.divIcon({
      className: "",
      html: `<div class="navArrowWrap friendWrap navPulse"><div class="navNameTag">${escapeHtml(
        name || "Friend"
      )}</div><div class="navArrow"></div></div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    });

    const m = L.marker(pos, { icon, interactive: false, zIndexOffset: 9000 }).addTo(map);
    friendMarkers.set(userKey, { marker: m, lastSeenMs: Date.now() });

    if (Number.isFinite(headingDeg)) {
      const el = m.getElement()?.querySelector(".navArrowWrap");
      if (el) el.style.transform = `rotate(${headingDeg}deg)`;
    }
    return;
  }

  existing.lastSeenMs = Date.now();
  existing.marker.setLatLng(pos);

  // rotate if provided
  if (Number.isFinite(headingDeg)) {
    const el = existing.marker.getElement()?.querySelector(".navArrowWrap");
    if (el) el.style.transform = `rotate(${headingDeg}deg)`;
  }

  // update name if changed
  const nameEl = existing.marker.getElement()?.querySelector(".navNameTag");
  if (nameEl && (nameEl.textContent || "") !== (name || "")) nameEl.textContent = name || "Friend";
}

function pruneStaleFriends() {
  const now = Date.now();
  for (const [k, v] of friendMarkers.entries()) {
    // if not seen in 2 minutes, remove
    if (now - v.lastSeenMs > 2 * 60 * 1000) {
      try {
        v.marker.remove();
      } catch {}
      friendMarkers.delete(k);
    }
  }
}

function sendPresenceUpdate() {
  if (!signedIn) return;
  if (!presenceWS || presenceWS.readyState !== 1) return;
  if (!userLatLng) return;

  const payload = {
    type: "update",
    session: sessionToken,
    name: currentUsername,
    lat: userLatLng.lat,
    lng: userLatLng.lng,
    heading: Number.isFinite(lastHeadingDeg) ? lastHeadingDeg : null,
    ts: Date.now(),
  };

  try {
    presenceWS.send(JSON.stringify(payload));
  } catch {}
}

function connectPresenceWS() {
  closePresenceWS();
  if (!signedIn) return;

  const url = wsURL();
  try {
    presenceWS = new WebSocket(url);
  } catch (e) {
    console.warn("WS create failed:", e);
    return;
  }

  presenceWS.onopen = () => {
    try {
      presenceWS.send(
        JSON.stringify({
          type: "hello",
          session: sessionToken,
          name: currentUsername,
          ts: Date.now(),
        })
      );
    } catch {}

    // ping
    presencePingTimer = setInterval(() => {
      if (!presenceWS || presenceWS.readyState !== 1) return;
      try {
        presenceWS.send(JSON.stringify({ type: "ping", ts: Date.now() }));
      } catch {}
    }, PRESENCE_PING_MS);

    // update loop
    presenceSendTimer = setInterval(() => {
      sendPresenceUpdate();
      pruneStaleFriends();
    }, PRESENCE_SEND_MS);
  };

  presenceWS.onmessage = (ev) => {
    let msg = null;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    // expected server messages:
    // {type:"snapshot", users:[{session,name,lat,lng,heading}]}
    // {type:"user", action:"upsert"/"remove", session,name,lat,lng,heading}
    if (!msg || !msg.type) return;

    if (msg.type === "snapshot" && Array.isArray(msg.users)) {
      for (const u of msg.users) {
        if (!u) continue;
        upsertFriendMarker(
          String(u.session || ""),
          String(u.name || "Friend"),
          Number(u.lat),
          Number(u.lng),
          u.heading == null ? null : Number(u.heading)
        );
      }
      pruneStaleFriends();
      return;
    }

    if (msg.type === "user") {
      const action = String(msg.action || "");
      const sess = String(msg.session || "");
      if (!sess) return;

      if (action === "remove") {
        const existing = friendMarkers.get(sess);
        if (existing) {
          try {
            existing.marker.remove();
          } catch {}
          friendMarkers.delete(sess);
        }
        return;
      }

      // upsert
      upsertFriendMarker(
        sess,
        String(msg.name || "Friend"),
        Number(msg.lat),
        Number(msg.lng),
        msg.heading == null ? null : Number(msg.heading)
      );
      pruneStaleFriends();
    }
  };

  presenceWS.onerror = (e) => {
    console.warn("WS error:", e);
  };

  presenceWS.onclose = () => {
    // keep map working even if friends fail
    closePresenceWS();
  };
}

/* =========================================================
   Sign in / out logic (privacy + access control)
   ========================================================= */
function lockMapUI(locked) {
  // When locked: disable slider and hide zones layer + stop location watch
  if (slider) slider.disabled = !!locked;
  if (btnCenter) btnCenter.disabled = !!locked;
  if (btnStatenIsland) btnStatenIsland.disabled = !!locked;
  if (navBtn) {
    if (locked) {
      navBtn.classList.add("disabled");
      navBtn.href = "#";
    }
  }

  if (locked) {
    if (geoLayer) {
      try {
        geoLayer.remove();
      } catch {}
      geoLayer = null;
    }
    // keep time label as-is; overlay handles access
  } else {
    // when unlocked, re-render current frame if available
    if (currentFrame) renderFrame(currentFrame);
  }
}

function signIn(name) {
  const cleaned = sanitizeUsername(name);
  if (!cleaned) return false;

  currentUsername = cleaned;
  localStorage.setItem(LS_KEY_USERNAME, currentUsername);

  sessionToken = getOrCreateSessionToken();

  signedIn = true;
  markActiveNow();
  setAuthButtonUI();
  showAuthOverlay(false);
  lockMapUI(false);

  // ensure your marker shows your name (recreate icon)
  if (navMarker) {
    try {
      navMarker.setIcon(makeNavIcon(currentUsername));
    } catch {}
  }

  // presence
  connectPresenceWS();
  return true;
}

function signOut(reason = "manual") {
  signedIn = false;
  setAuthButtonUI();

  // Privacy: stop geolocation + remove your marker + clear friends
  stopLocationWatch();
  clearFriendMarkers();
  closePresenceWS();

  userLatLng = null;
  recommendedDest = null;
  setNavDestination(null);

  lockMapUI(true);
  showAuthOverlay(true);

  console.log("Signed out:", reason);
}

function stopLocationWatch() {
  try {
    if (geoWatchId != null) navigator.geolocation.clearWatch(geoWatchId);
  } catch {}
  geoWatchId = null;

  try {
    if (navMarker) navMarker.remove();
  } catch {}
  navMarker = null;

  gpsFirstFixDone = false;
  lastPos = null;
  lastHeadingDeg = 0;
  lastMoveTs = 0;
}

/* =========================================================
   Location watch (modified ONLY to respect signed-in state)
   ========================================================= */
function startLocationWatch() {
  if (!("geolocation" in navigator)) {
    if (recommendEl) recommendEl.textContent = "Recommended: location not supported";
    return;
  }

  // Create marker on start
  navMarker = L.marker([40.7128, -74.0060], {
    icon: makeNavIcon(currentUsername || ""),
    interactive: false,
    zIndexOffset: 9999,
  }).addTo(map);

  geoWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      // if signed out, ignore updates for privacy
      if (!signedIn) return;

      markActiveNow();

      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const heading = pos.coords.heading;
      const ts = pos.timestamp || Date.now();

      userLatLng = { lat, lng };
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
        const targetZoom = Math.max(map.getZoom(), 14);
        suppressAutoDisableFor(1200, () => map.setView(userLatLng, targetZoom, { animate: true }));
      } else {
        if (autoCenter) {
          suppressAutoDisableFor(700, () => map.panTo(userLatLng, { animate: true }));
        }
      }

      if (currentFrame) updateRecommendation(currentFrame);

      // send to friends
      sendPresenceUpdate();
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
    if (!signedIn) return;
    const now = Date.now();
    const recentlyMoved = lastMoveTs && now - lastMoveTs < 5000;
    setNavVisual(!!recentlyMoved);
  }, 1200);
}

/* =========================================================
   Auto-refresh every 5 minutes — UNCHANGED
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

/* =========================================================
   Auth overlay controls
   ========================================================= */
(function wireOverlay() {
  if (!authOverlay) return;

  const input = authOverlay.querySelector("#authNameInput");
  const goBtn = authOverlay.querySelector("#authGoBtn");

  function attempt() {
    const ok = signIn(input?.value || "");
    if (!ok) {
      alert("Please enter a valid username (letters/numbers/space/_-.)");
      return;
    }
  }

  if (goBtn) goBtn.addEventListener("click", () => {
    attempt();
  });

  if (input) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") attempt();
    });
  }
})();

/* =========================================================
   Activity detection + auto sign-out timer
   ========================================================= */
["pointerdown", "keydown", "touchstart"].forEach((ev) => {
  window.addEventListener(
    ev,
    () => {
      if (signedIn) markActiveNow();
    },
    { passive: true }
  );
});

setInterval(() => {
  autoSignOutIfInactive();
}, 10 * 1000);

// Also treat tab hide as “activity stop” — still uses the same 30m timer
document.addEventListener("visibilitychange", () => {
  if (signedIn && !document.hidden) markActiveNow();
});

/* =========================================================
   BOOT (order matters)
   ========================================================= */
setNavDestination(null);

// Load timeline regardless (you asked: “data & facts are most important”)
// but map is locked until signed in.
loadTimeline()
  .catch((err) => {
    console.error(err);
    timeLabel.textContent = `Error loading timeline: ${err.message}`;
  })
  .finally(() => {
    // keep locked until auth completes
  });

// Initial auth state
(function initialAuth() {
  sessionToken = getOrCreateSessionToken();

  // username saved once; user asked: “only have to enter 1 time”
  const saved = localStorage.getItem(LS_KEY_USERNAME) || "";
  const cleaned = sanitizeUsername(saved);

  if (cleaned) {
    // auto sign in only if not inactive too long (privacy)
    // If last active is older than 30m, force sign-in screen.
    const last = lastActiveMs();
    const now = Date.now();
    const expired = last && now - last > INACTIVITY_SIGNOUT_MS;

    if (!expired) {
      signIn(cleaned);
    } else {
      signedIn = false;
      setAuthButtonUI();
      showAuthOverlay(true);
      lockMapUI(true);
      const input = authOverlay?.querySelector("#authNameInput");
      if (input) input.value = cleaned;
    }
  } else {
    signedIn = false;
    setAuthButtonUI();
    showAuthOverlay(true);
    lockMapUI(true);
  }

  // If signed in, start location + friends
  if (signedIn) {
    startLocationWatch();
  } else {
    // ensure location is not running
    stopLocationWatch();
  }
})();

// If user signs in from overlay, start location watch if not running
(function patchSignInStartWatch() {
  const origSignIn = signIn;
  signIn = function patchedSignIn(name) {
    const ok = origSignIn(name);
    if (ok) {
      // start geolocation if not already
      if (!geoWatchId) startLocationWatch();
    }
    return ok;
  };
})();

/* =========================================================
   When signed out: block map access immediately
   ========================================================= */
showAuthOverlay(!signedIn);
lockMapUI(!signedIn);
setAuthButtonUI();