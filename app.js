/* =========================================================
   NYC TLC Hotspot Map (Front-end) - app.js
   =========================================================
   PURPOSE (high level)
   - Shows NYC TLC hotspot “frames” (20-minute bins) coming from your Railway backend
   - Slider + map can run in LIVE mode (auto-sync to NYC current time)
   - Optional Auto-center follows your GPS arrow, BUT you can still explore the map freely

   KEY UX RULES (your request)
   - Auto-center should NOT trap you. You can drag/zoom anytime.
   - When you drag/zoom (user exploring), Auto-center pauses for a short time.
   - You can tap Auto-center back ON at any time.

   WARNING / WHAT BREAKS
   1) If your backend has no /timeline yet → timeline fetch will fail.
      Fix: hit /generate once (or ensure Option A auto-generation ran).
   2) If geolocation permission is blocked → arrow won’t move and recs won’t work.
   3) If you change BIN_MINUTES here but backend frames were built with a different bin,
      your “NYC now rounding” will not align perfectly (still works, but mismatched bins).
   ========================================================= */

const RAILWAY_BASE = "https://web-production-78f67.up.railway.app";
const BIN_MINUTES = 20;

/* Auto-refresh current selected frame every 5 minutes (keeps colors/polygons updated) */
const REFRESH_MS = 5 * 60 * 1000;

/* FOLLOW / AUTO-CENTER SETTINGS
   - AUTO_CENTER_MIN_ZOOM controls how zoomed-in we go when re-centering.
   - Lower number = more zoomed OUT (shows more area).
*/
const AUTO_CENTER_MIN_ZOOM = 13;

/* When you manually drag/zoom, we pause auto-follow for this many ms.
   Increase if you want more time to explore without the map re-centering. */
const EXPLORE_PAUSE_MS = 20_000;

/* LIVE MODE SETTINGS (slider sync to NYC “now”) */
const LIVE_MODE = true;
/* How often we try to snap slider to NYC “now” */
const LIVE_TICK_MS = 20_000;
/* How often we refresh /timeline (useful if backend regenerated frames) */
const TIMELINE_REFRESH_MS = 30 * 60 * 1000;

// ---------- Legend minimize ----------
const legendEl = document.getElementById("legend");
const legendToggleBtn = document.getElementById("legendToggle");
if (legendEl && legendToggleBtn) {
  legendToggleBtn.addEventListener("click", () => {
    const minimized = legendEl.classList.toggle("minimized");
    legendToggleBtn.textContent = minimized ? "+" : "–";
  });
}

/* =========================================================
   Label Visibility (mobile-friendly)
   - We show fewer labels when zoomed out (cleaner)
   - We prioritize better buckets at mid zoom levels
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
   Time helpers (NYC time alignment)
   - Backend frames contain an ISO string like "2025-01-06T00:20:00"
   - We treat that as an ISO-without-timezone label (week anchor style)
   - Slider auto-sync picks closest frame to NYC "now" minute-of-week
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
   Network
   - fetchJSON with strict error message so you can debug quickly
   ========================================================= */
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

/* =========================================================
   UI helper: bucket → label
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
   Staten Island Mode (local recolor)
   - When ON: Staten Island features get their own percentile-based recolor
   - Other boroughs remain NYC-wide
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
    let lo = 0,
      hi = n - 1,
      ans = -1;
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
      : `Colors come from rating (1–100) for the selected ${BIN_MINUTES}-minute window.<br/>Time label is NYC time.`;
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
   Recommendation + Navigation
   - Picks best “Blue+” zone (blue/purple/green) with distance penalty
   - Updates whenever your location changes or frame changes
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
   Leaflet map initialization
   ========================================================= */
const slider = document.getElementById("slider");
const timeLabel = document.getElementById("timeLabel");

const map = L.map("map", { zoomControl: true }).setView([40.7128, -74.006], 10);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap &copy; CARTO",
  maxZoom: 19,
}).addTo(map);

/* Panes:
   - labelsPane: labels sit above polygons, below nav arrow
   - navPane: nav arrow always on top */
const labelsPane = map.createPane("labelsPane");
labelsPane.style.zIndex = 450;
const navPane = map.createPane("navPane");
navPane.style.zIndex = 1000;

let geoLayer = null;
let timeline = [];
let minutesOfWeek = [];
let currentFrame = null;

/* Popup builder for a zone */
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
      <div style="font-weight:800; margin-bottom:2px;">${escapeHtml(zoneName || `Zone ${props.LocationID ?? ""}`)}</div>
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

/* Render a single frame (polygons + tooltips + popups) */
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
        pane: "labelsPane",
      });
    },
  }).addTo(map);

  updateRecommendation(currentFrame);
}

/* Load a frame by index */
async function loadFrame(idx) {
  const frame = await fetchJSON(`${RAILWAY_BASE}/frame/${idx}`);
  renderFrame(frame);
}

/* Load timeline and initialize slider to NYC “now” */
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
  lastAutoIdx = idx;
}

/* Re-render labels on zoom (because label rules depend on zoom level) */
map.on("zoomend", () => {
  if (currentFrame) renderFrame(currentFrame);
});

/* Slider input: load selected frame
   IMPORTANT: this does NOT disable Auto-center.
   It only changes which time window is displayed. */
let sliderDebounce = null;
slider.addEventListener("input", () => {
  const idx = Number(slider.value);
  if (sliderDebounce) clearTimeout(sliderDebounce);
  sliderDebounce = setTimeout(() => loadFrame(idx).catch(console.error), 80);
});

/* =========================================================
   Auto-center (FOLLOW) that still lets you explore
   =========================================================
   RULE:
   - Auto-center ON means: we follow your GPS updates.
   - BUT if you drag/zoom, we PAUSE following for EXPLORE_PAUSE_MS.
   - Auto-center can remain ON during the pause (we do not force OFF).
   - After the pause ends, following resumes automatically.
   ========================================================= */
const btnCenter = document.getElementById("btnCenter");
let autoCenter = true;

/* This blocks our “user exploring disables follow” logic for a bit
   when we do programmatic pan/zoom. */
let suppressAutoDisableUntil = 0;
function suppressAutoDisableFor(ms, fn) {
  suppressAutoDisableUntil = Date.now() + ms;
  fn();
}

/* This is the NEW “pause follow so user can explore” timer */
let followPausedUntil = 0;
function pauseFollowFor(ms) {
  followPausedUntil = Date.now() + ms;
}
function isFollowPaused() {
  return Date.now() < followPausedUntil;
}

function syncCenterButton() {
  if (!btnCenter) return;
  const pausedTag = autoCenter && isFollowPaused() ? " (paused)" : "";
  btnCenter.textContent = autoCenter ? `Auto-center: ON${pausedTag}` : "Auto-center: OFF";
  btnCenter.classList.toggle("on", !!autoCenter);
}
syncCenterButton();

/* Clicking the button toggles follow on/off */
if (btnCenter) {
  btnCenter.addEventListener("pointerdown", (e) => e.stopPropagation());
  btnCenter.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });

  btnCenter.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();

    autoCenter = !autoCenter;
    if (autoCenter) {
      // When turning ON, re-center immediately (and remove pause)
      followPausedUntil = 0;
      if (userLatLng) {
        const z = Math.max(map.getZoom(), AUTO_CENTER_MIN_ZOOM);
        suppressAutoDisableFor(900, () => map.setView(userLatLng, z, { animate: true }));
      }
    }
    syncCenterButton();
  });
}

/* When user begins exploring, pause follow (do NOT force OFF) */
function onUserExploreStart() {
  if (Date.now() < suppressAutoDisableUntil) return; // ignore our own pan/zoom
  if (!autoCenter) return; // no need to pause if already OFF
  pauseFollowFor(EXPLORE_PAUSE_MS);
  syncCenterButton();
}

/* User exploring signals */
map.on("dragstart", onUserExploreStart);
map.on("zoomstart", onUserExploreStart);

/* =========================================================
   GPS arrow marker (always on top)
   ========================================================= */
let gpsFirstFixDone = false;
let navMarker = null;
let lastPos = null;
let lastHeadingDeg = 0;
let lastMoveTs = 0;

/* This icon is a DIV. Your index.html CSS controls the “pointy arrow” look. */
function makeNavIcon() {
  return L.divIcon({
    className: "",
    html: `<div id="navWrap" class="navArrowWrap navPulse"><div class="navArrow"></div></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

/* Glow vs pulse depending on movement */
function setNavVisual(isMoving) {
  const el = document.getElementById("navWrap");
  if (!el) return;
  el.classList.toggle("navMoving", !!isMoving);
  el.classList.toggle("navPulse", !isMoving);
}

/* Rotate arrow to face heading/bearing */
function setNavRotation(deg) {
  const el = document.getElementById("navWrap");
  if (!el) return;
  el.style.transform = `rotate(${deg}deg)`;
}

/* Bearing used if device doesn’t provide heading */
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

/* Start real-time location tracking */
function startLocationWatch() {
  if (!("geolocation" in navigator)) {
    if (recommendEl) recommendEl.textContent = "Recommended: location not supported";
    return;
  }

  /* Create the arrow marker in navPane so it stays above labels/polygons */
  navMarker = L.marker([40.7128, -74.006], {
    icon: makeNavIcon(),
    interactive: false, // IMPORTANT: don’t block taps on zones
    zIndexOffset: 2000000,
    pane: "navPane",
  }).addTo(map);

  navigator.geolocation.watchPosition(
    (pos) => {
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

        /* Heading priority:
           1) Device heading (if available)
           2) Bearing from last position (if moved enough) */
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

      /* FOLLOW behavior:
         - If Auto-center ON and not paused, follow user.
         - If paused, do nothing (user is exploring).
      */
      if (autoCenter && !isFollowPaused()) {
        const desiredZoom = Math.max(map.getZoom(), AUTO_CENTER_MIN_ZOOM);

        if (!gpsFirstFixDone) {
          gpsFirstFixDone = true;
          suppressAutoDisableFor(1200, () => map.setView(userLatLng, desiredZoom, { animate: true }));
        } else {
          /* If user is zoomed out, bring them back to minimum follow zoom;
             otherwise pan smoothly. */
          if (map.getZoom() < AUTO_CENTER_MIN_ZOOM) {
            suppressAutoDisableFor(900, () => map.setView(userLatLng, desiredZoom, { animate: true }));
          } else {
            suppressAutoDisableFor(700, () => map.panTo(userLatLng, { animate: true }));
          }
        }
      }

      /* Recompute recommendation when location changes */
      if (currentFrame) updateRecommendation(currentFrame);
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

  /* Every ~1s update arrow visual state for “recently moved” */
  setInterval(() => {
    const now = Date.now();
    const recentlyMoved = lastMoveTs && now - lastMoveTs < 5000;
    setNavVisual(!!recentlyMoved);
  }, 1200);
}

/* =========================================================
   LIVE MODE: Keep slider + map aligned to NYC “now”
   =========================================================
   IMPORTANT: Live mode does NOT stop you from exploring.
   - When you touch/drag slider: we pause auto-advance
   - When you drag/zoom map: we pause auto-follow (different pause)
   ========================================================= */
let lastAutoIdx = null;
let pauseLiveUntil = 0;

function pauseLiveFor(ms) {
  pauseLiveUntil = Date.now() + ms;
}
function liveIsPaused() {
  return Date.now() < pauseLiveUntil;
}

/* Pause Live auto-advance while user touches slider */
if (slider) {
  const pause = () => pauseLiveFor(15_000);
  slider.addEventListener("pointerdown", pause);
  slider.addEventListener("touchstart", pause, { passive: true });
  slider.addEventListener("mousedown", pause);
}

/* Jump slider to nearest “now” frame if not paused */
async function jumpToNowFrameIfNeeded() {
  if (!LIVE_MODE) return;
  if (!timeline || !timeline.length) return;
  if (liveIsPaused()) return;

  const nowMinWeek = getNowNYCMinuteOfWeekRounded();
  const idx = pickClosestIndex(minutesOfWeek, nowMinWeek);

  if (lastAutoIdx === idx) return;

  slider.value = String(idx);
  lastAutoIdx = idx;

  await loadFrame(idx);
}

/* Refresh timeline periodically (useful if backend regenerated frames) */
async function refreshTimelineAndMaybeJump() {
  try {
    const t = await fetchJSON(`${RAILWAY_BASE}/timeline`);
    timeline = Array.isArray(t) ? t : t.timeline || [];
    if (!timeline.length) return;

    minutesOfWeek = timeline.map(minuteOfWeekFromIso);

    slider.min = "0";
    slider.max = String(timeline.length - 1);
    slider.step = "1";

    await jumpToNowFrameIfNeeded();
  } catch (e) {
    console.warn("Timeline refresh failed:", e);
  }
}

/* Live tick: every 20s snap to NYC now (unless slider paused) */
setInterval(() => {
  jumpToNowFrameIfNeeded().catch((e) => console.warn("Auto-advance failed:", e));
}, LIVE_TICK_MS);

/* Auto-refresh selected frame every 5 minutes (colors/polygons update) */
async function refreshCurrentFrame() {
  try {
    const idx = Number(slider.value || "0");
    await loadFrame(idx);
  } catch (e) {
    console.warn("Auto-refresh failed:", e);
  }
}
setInterval(refreshCurrentFrame, REFRESH_MS);

/* Refresh timeline every 30 minutes */
setInterval(() => {
  refreshTimelineAndMaybeJump().catch((e) => console.warn("Timeline+frame refresh failed:", e));
}, TIMELINE_REFRESH_MS);

/* Catch up when returning to the tab/app */
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    refreshTimelineAndMaybeJump().catch(() => {});
    refreshCurrentFrame().catch(() => {});
  }
});
window.addEventListener("focus", () => {
  refreshTimelineAndMaybeJump().catch(() => {});
  refreshCurrentFrame().catch(() => {});
});

/* =========================================================
   Boot
   ========================================================= */
setNavDestination(null);

loadTimeline().catch((err) => {
  console.error(err);
  timeLabel.textContent = `Error loading timeline: ${err.message}`;
});

startLocationWatch();