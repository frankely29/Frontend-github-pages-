const RAILWAY_BASE = "https://web-production-78f67.up.railway.app";
const BIN_MINUTES = 20;

// Refresh current frame every 5 minutes
const REFRESH_MS = 5 * 60 * 1000;

// Friends / presence
const PRESENCE_POLL_MS = 5000;
const PRESENCE_PUSH_MS = 8000;
const INACTIVE_SIGNOUT_MINUTES = 30;

/* =========================================================
   Auth (Option A)
   - Username saved forever
   - Signed-in flag saved; after Sign Out it stays signed out even on refresh
   ========================================================= */
const LS_USER = "fhv_username";
const LS_SIGNED = "fhv_signed_in";
const LS_CLIENT = "fhv_client_id";

function getOrCreateClientId() {
  let id = localStorage.getItem(LS_CLIENT);
  if (!id) {
    id = (crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
    localStorage.setItem(LS_CLIENT, id);
  }
  return id;
}
const CLIENT_ID = getOrCreateClientId();

function getSavedUsername() {
  return (localStorage.getItem(LS_USER) || "").trim();
}
function setSavedUsername(u) {
  localStorage.setItem(LS_USER, (u || "").trim());
}
function isSignedIn() {
  return (localStorage.getItem(LS_SIGNED) || "0") === "1";
}
function setSignedIn(v) {
  localStorage.setItem(LS_SIGNED, v ? "1" : "0");
}

// ---------- Legend minimize ----------
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
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
    mode: "cors",
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} @ ${url} :: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    return { ok: true };
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
   Staten Island Mode (toggle anywhere)
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

  let sumLng = 0, sumLat = 0;
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

    const rating = (statenIslandMode && isStatenIslandFeature(props) && Number.isFinite(Number(props.si_local_rating)))
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
        usedLocal: (statenIslandMode && isStatenIslandFeature(props) && Number.isFinite(Number(props.si_local_rating))),
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

// ---------- Leaflet map ----------
const slider = document.getElementById("slider");
const timeLabel = document.getElementById("timeLabel");
const lockedOverlay = document.getElementById("lockedOverlay");

// DO NOT REVERT: start zoomed OUT to see more boroughs
const map = L.map("map", { zoomControl: true }).setView([40.7128, -74.0060], 10);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap &copy; CARTO",
  maxZoom: 19,
}).addTo(map);

let geoLayer = null;
let timeline = [];
let minutesOfWeek = [];
let currentFrame = null;
let timelineLoaded = false;

function buildPopupHTML(props) {
  const zoneName = (props.zone_name || "").trim();
  const borough = (props.borough || "").trim();

  const rating = props.rating ?? "";
  const bucket = props.bucket ?? "";
  const pickups = props.pickups ?? "";
  const pay = props.avg_driver_pay == null ? "n/a" : props.avg_driver_pay.toFixed(2);

  let extra = "";
  if (statenIslandMode && isStatenIslandFeature(props) && Number.isFinite(Number(props.si_local_rating))) {
    extra = `<div style="margin-top:6px;"><b>Staten Local Rating:</b> ${props.si_local_rating} (${prettyBucket(props.si_local_bucket)})</div>`;
  }

  return `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; font-size:13px;">
      <div style="font-weight:800; margin-bottom:2px;">${escapeHtml(zoneName || `Zone ${props.LocationID ?? ""}`)}</div>
      ${borough ? `<div style="opacity:0.8; margin-bottom:6px;">${escapeHtml(borough)}</div>` : `<div style="margin-bottom:6px;"></div>`}
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
  timeline = Array.isArray(t) ? t : (t.timeline || []);
  if (!timeline.length) throw new Error("Timeline empty. Run /generate once on Railway.");

  minutesOfWeek = timeline.map(minuteOfWeekFromIso);

  slider.min = "0";
  slider.max = String(timeline.length - 1);
  slider.step = "1";

  const nowMinWeek = getNowNYCMinuteOfWeekRounded();
  const idx = pickClosestIndex(minutesOfWeek, nowMinWeek);
  slider.value = String(idx);

  timelineLoaded = true;
  await loadFrame(idx);
}

map.on("zoomend", () => {
  if (currentFrame) renderFrame(currentFrame);
});

let sliderDebounce = null;
slider.addEventListener("input", () => {
  if (!signedIn) return;
  const idx = Number(slider.value);
  if (sliderDebounce) clearTimeout(sliderDebounce);
  sliderDebounce = setTimeout(() => loadFrame(idx).catch(console.error), 80);
});

/* =========================================================
   Auto-center button (inside bottom bar) - stable logic
   ========================================================= */
const btnCenter = document.getElementById("btnCenter");
const btnRecenter = document.getElementById("btnRecenter");
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

if (btnRecenter) {
  btnRecenter.addEventListener("pointerdown", (e) => e.stopPropagation());
  btnRecenter.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
  btnRecenter.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (userLatLng) suppressAutoDisableFor(900, () => map.setView(userLatLng, Math.max(map.getZoom(), 12), { animate: true }));
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

/* =========================
   Live location arrow + auto-center
   ========================= */
let gpsFirstFixDone = false;
let navMarker = null;
let geoWatchId = null;
let lastPos = null;
let lastHeadingDeg = 0;
let lastMoveTs = 0;

let signedIn = isSignedIn();
let username = getSavedUsername();

function makeNavIcon(name, isFriend) {
  const safeName = escapeHtml((name || "").trim() || "User");
  return L.divIcon({
    className: "",
    html: `
      <div class="navArrowWrap ${isFriend ? "" : "navPulse"}">
        <div class="navArrow ${isFriend ? "friendArrow" : ""}"></div>
        <div class="navName">${safeName}</div>
      </div>
    `,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function setMarkerName(marker, name) {
  const el = marker?.getElement?.();
  const n = el?.querySelector?.(".navName");
  if (n) n.textContent = (name || "").trim();
}

function setArrowRotation(marker, deg) {
  const el = marker?.getElement?.();
  const a = el?.querySelector?.(".navArrow");
  if (!a) return;
  a.style.transform = `translate(-50%, -55%) rotate(${deg}deg)`;
}

function setMarkerMoving(marker, isMoving) {
  const el = marker?.getElement?.();
  const wrap = el?.querySelector?.(".navArrowWrap");
  if (!wrap) return;
  wrap.classList.toggle("navMoving", !!isMoving);
  wrap.classList.toggle("navPulse", !isMoving);
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

function stopLocationWatch() {
  if (geoWatchId != null && navigator.geolocation?.clearWatch) {
    try { navigator.geolocation.clearWatch(geoWatchId); } catch {}
  }
  geoWatchId = null;
  gpsFirstFixDone = false;
  lastPos = null;
  lastHeadingDeg = 0;
  lastMoveTs = 0;
  userLatLng = null;

  if (navMarker) {
    try { navMarker.remove(); } catch {}
  }
  navMarker = null;
}

function startLocationWatch() {
  if (!signedIn) return;

  if (!("geolocation" in navigator)) {
    if (recommendEl) recommendEl.textContent = "Recommended: location not supported";
    return;
  }

  if (!navMarker) {
    navMarker = L.marker([40.7128, -74.0060], {
      icon: makeNavIcon(username || "Me", false),
      interactive: false,
      zIndexOffset: 9999,
    }).addTo(map);
  } else {
    navMarker.setIcon(makeNavIcon(username || "Me", false));
  }

  geoWatchId = navigator.geolocation.watchPosition(
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

        if (typeof heading === "number" && Number.isFinite(heading)) {
          lastHeadingDeg = heading;
        } else if (dMi > 0.01) {
          lastHeadingDeg = computeBearingDeg({ lat: lastPos.lat, lng: lastPos.lng }, userLatLng);
        }

        if (isMoving) lastMoveTs = ts;
      }

      lastPos = { lat, lng, ts };

      setArrowRotation(navMarker, lastHeadingDeg);
      setMarkerMoving(navMarker, isMoving);
      setMarkerName(navMarker, username || "Me");

      if (!gpsFirstFixDone) {
        gpsFirstFixDone = true;
        const targetZoom = Math.max(map.getZoom(), 12);
        suppressAutoDisableFor(1200, () => map.setView(userLatLng, targetZoom, { animate: true }));
      } else {
        if (autoCenter) {
          suppressAutoDisableFor(700, () => map.panTo(userLatLng, { animate: true }));
        }
      }

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

  setInterval(() => {
    const now = Date.now();
    const recentlyMoved = lastMoveTs && (now - lastMoveTs) < 5000;
    if (navMarker) setMarkerMoving(navMarker, !!recentlyMoved);
  }, 1200);
}

/* =========================================================
   Friends (presence)
   ========================================================= */
let presencePollTimer = null;
let presencePushTimer = null;
const friendMarkers = new Map(); // client_id -> L.marker

function clearFriends() {
  for (const m of friendMarkers.values()) {
    try { m.remove(); } catch {}
  }
  friendMarkers.clear();
}

async function presenceUpsert() {
  if (!signedIn) return;
  const payload = {
    client_id: CLIENT_ID,
    username: username || "",
    lat: userLatLng?.lat ?? null,
    lng: userLatLng?.lng ?? null,
    heading: Number.isFinite(lastHeadingDeg) ? lastHeadingDeg : null,
  };
  try {
    await postJSON(`${RAILWAY_BASE}/presence/upsert`, payload);
  } catch (e) {
    console.warn("presenceUpsert failed:", e?.message || e);
  }
}

function upsertFriendMarker(u) {
  const id = u.client_id;
  if (!id || id === CLIENT_ID) return; // IMPORTANT: never draw yourself as a friend
  if (!Number.isFinite(Number(u.lat)) || !Number.isFinite(Number(u.lng))) return;

  const lat = Number(u.lat);
  const lng = Number(u.lng);
  const heading = Number.isFinite(Number(u.heading)) ? Number(u.heading) : 0;
  const name = (u.username || "Friend").toString();

  let m = friendMarkers.get(id);
  if (!m) {
    m = L.marker([lat, lng], {
      icon: makeNavIcon(name, true),
      interactive: false,
      zIndexOffset: 9000,
    }).addTo(map);
    friendMarkers.set(id, m);
  } else {
    m.setLatLng([lat, lng]);
    setMarkerName(m, name);
  }

  setArrowRotation(m, heading);
}

async function pollFriends() {
  if (!signedIn) return;
  try {
    const resp = await fetchJSON(`${RAILWAY_BASE}/presence/list?max_age_min=${INACTIVE_SIGNOUT_MINUTES}`);
    const users = Array.isArray(resp) ? resp : (resp.users || []);

    const seen = new Set();
    for (const u of users) {
      if (!u || !u.client_id) continue;
      if (u.client_id === CLIENT_ID) continue;
      seen.add(u.client_id);
      upsertFriendMarker(u);
    }

    for (const id of Array.from(friendMarkers.keys())) {
      if (!seen.has(id)) {
        try { friendMarkers.get(id)?.remove(); } catch {}
        friendMarkers.delete(id);
      }
    }
  } catch (e) {
    console.warn("pollFriends failed:", e?.message || e);
  }
}

async function presenceSignOut() {
  try {
    await postJSON(`${RAILWAY_BASE}/presence/signout`, { client_id: CLIENT_ID });
  } catch (e) {
    console.warn("presenceSignOut failed:", e?.message || e);
  }
}

function startPresenceLoops() {
  if (presencePollTimer) clearInterval(presencePollTimer);
  if (presencePushTimer) clearInterval(presencePushTimer);

  presencePollTimer = setInterval(pollFriends, PRESENCE_POLL_MS);
  presencePushTimer = setInterval(presenceUpsert, PRESENCE_PUSH_MS);

  pollFriends();
  presenceUpsert();
}

function stopPresenceLoops() {
  if (presencePollTimer) clearInterval(presencePollTimer);
  if (presencePushTimer) clearInterval(presencePushTimer);
  presencePollTimer = null;
  presencePushTimer = null;
  clearFriends();
}

/* =========================================================
   Auth UI (single Sign in/Sign out button)
   ========================================================= */
const btnAuth = document.getElementById("btnAuth");

function setLocked(isLocked) {
  if (lockedOverlay) lockedOverlay.classList.toggle("show", !!isLocked);

  if (slider) slider.disabled = !!isLocked;
  if (btnCenter) btnCenter.disabled = !!isLocked;
  if (btnRecenter) btnRecenter.disabled = !!isLocked;
  if (btnStatenIsland) btnStatenIsland.disabled = !!isLocked;

  setNavDisabled(!!isLocked || !recommendedDest);
}

function syncAuthButton() {
  if (!btnAuth) return;
  btnAuth.textContent = signedIn ? "Sign out" : "Sign in";
  btnAuth.classList.toggle("on", !!signedIn);
}

async function doSignIn() {
  let u = getSavedUsername();
  if (!u) {
    u = (prompt("Enter a username (shown on the map):") || "").trim();
    if (!u) return;
    setSavedUsername(u);
  }

  username = u;
  signedIn = true;
  setSignedIn(true);
  syncAuthButton();

  setLocked(false);
  if (recommendEl) recommendEl.textContent = "Recommended: …";
  if (!timelineLoaded) {
    timeLabel.textContent = "Loading…";
    await loadTimeline();
  }

  startLocationWatch();
  startPresenceLoops();
}

async function doSignOut() {
  signedIn = false;
  setSignedIn(false);
  syncAuthButton();

  stopPresenceLoops();
  stopLocationWatch();
  await presenceSignOut();

  if (geoLayer) {
    try { geoLayer.remove(); } catch {}
    geoLayer = null;
  }
  currentFrame = null;
  setNavDestination(null);

  if (timeLabel) timeLabel.textContent = "Signed out";
  if (recommendEl) recommendEl.textContent = "Sign in to use the map";

  setLocked(true);
}

if (btnAuth) {
  btnAuth.addEventListener("pointerdown", (e) => e.stopPropagation());
  btnAuth.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
  btnAuth.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    (signedIn ? doSignOut() : doSignIn()).catch(console.error);
  });
}

/* =========================================================
   Auto-refresh every 5 minutes
   ========================================================= */
async function refreshCurrentFrame() {
  if (!signedIn || !timelineLoaded) return;
  try {
    const idx = Number(slider.value || "0");
    await loadFrame(idx);
  } catch (e) {
    console.warn("Auto-refresh failed:", e);
  }
}
setInterval(refreshCurrentFrame, REFRESH_MS);

// Boot
setNavDestination(null);
syncAuthButton();

if (signedIn) {
  setLocked(false);
  loadTimeline().catch((err) => {
    console.error(err);
    timeLabel.textContent = `Error loading timeline: ${err.message}`;
  });
  startLocationWatch();
  startPresenceLoops();
} else {
  setLocked(true);
  if (timeLabel) timeLabel.textContent = "Signed out";
  if (recommendEl) recommendEl.textContent = "Sign in to use the map";
}