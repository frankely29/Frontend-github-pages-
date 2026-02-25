/* =========================================================
   NYC TLC Hotspot Map — app.js
   KEEP ALL EXISTING FEATURES EXACTLY + Friends Presence
   - Legend minimize
   - Zoom-based label visibility
   - NYC-time slider/timeline
   - Staten Island Mode (SI-local percentile recolor, persisted)
   - Blue+ closer-weighted recommendations + Navigate link
   - Stable Auto-center logic (suppression during programmatic pan/zoom)
   - Live GPS arrow rotation from heading/bearing
   - 5-minute auto-refresh
   - Friends: username saved, sign-in/out, auto sign-out after 30 min inactive,
              show other users realtime, YOUR name bubble does NOT rotate
   ========================================================= */

const RAILWAY_BASE = "https://web-production-78f67.up.railway.app";
const BIN_MINUTES = 20;

// Refresh current frame every 5 minutes
const REFRESH_MS = 5 * 60 * 1000;

// ---------- Friends / Presence settings ----------
const PRESENCE_POLL_MS = 4000;         // how often we fetch other users
const PRESENCE_PUSH_MS = 3500;         // how often we POST our own location
const INACTIVE_SIGNOUT_MS = 30 * 60 * 1000; // 30 minutes

// LocalStorage keys
const LS_KEY_USERNAME = "friends_username";
const LS_KEY_SIGNED_IN = "friends_signed_in"; // "1" or "0"
const LS_KEY_SESSION = "friends_session_token"; // stable per device unless cleared

// NOTE: Backend endpoints expected (won't break map if missing):
// POST  /presence/signin   {username, session_token}
// POST  /presence/signout  {username, session_token}
// POST  /presence/update   {username, session_token, lat, lng, heading, ts}
// GET   /presence/list     -> {users:[{username,lat,lng,heading,updated_at_ms}]}  (any similar shape accepted)

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

// POST helper (friends)
async function postJSON(url, bodyObj) {
  return fetchJSON(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj || {}),
  });
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
   Staten Island Mode (toggle anywhere)  — EXACT BEHAVIOR
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
    if (currentFrame) renderFrame(currentFrame); // re-render regardless of your location
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
   Recommendation + Navigation  — EXACT BEHAVIOR
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
   Leaflet map  — EXACT BEHAVIOR
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
  if (!isSignedIn()) return; // signed out => no access
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
   Friends UI + State (NO DUPLICATE BUTTONS)
   ========================================================= */
let presenceBtn = null;
let presenceStatusEl = null;

function ensureSessionToken() {
  let tok = localStorage.getItem(LS_KEY_SESSION);
  if (!tok) {
    tok = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(LS_KEY_SESSION, tok);
  }
  return tok;
}

function getUsername() {
  return (localStorage.getItem(LS_KEY_USERNAME) || "").trim();
}

function isSignedIn() {
  return (localStorage.getItem(LS_KEY_SIGNED_IN) || "0") === "1" && !!getUsername();
}

function setSignedInFlag(v) {
  localStorage.setItem(LS_KEY_SIGNED_IN, v ? "1" : "0");
}

function updatePresenceUI() {
  // Create once, never duplicates
  if (!legendEl) return;

  // Put the auth row inside .legendBody (under nav row)
  const body = legendEl.querySelector(".legendBody");
  if (!body) return;

  // remove any accidental duplicates from older code
  const dupes = body.querySelectorAll("#presenceRow");
  if (dupes.length > 1) {
    for (let i = 1; i < dupes.length; i++) dupes[i].remove();
  }

  let row = body.querySelector("#presenceRow");
  if (!row) {
    row = document.createElement("div");
    row.id = "presenceRow";
    row.className = "navRow";
    row.style.marginTop = "2px";
    row.style.marginBottom = "6px";
    row.style.gap = "8px";

    // insert AFTER the existing navRow if present, else at top
    const navRow = body.querySelector(".navRow");
    if (navRow && navRow.parentElement === body) {
      navRow.insertAdjacentElement("afterend", row);
    } else {
      body.insertAdjacentElement("afterbegin", row);
    }
  }

  // button
  presenceBtn = row.querySelector("#btnPresenceAuth");
  if (!presenceBtn) {
    presenceBtn = document.createElement("button");
    presenceBtn.id = "btnPresenceAuth";
    presenceBtn.type = "button";
    // reuse your existing CSS button class if present
    presenceBtn.className = "modeBtn";
    presenceBtn.textContent = "Sign in";
    presenceBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    presenceBtn.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
    presenceBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (isSignedIn()) {
        await signOutFlow("manual");
      } else {
        await signInFlow();
      }
    });
    row.appendChild(presenceBtn);
  }

  // status
  presenceStatusEl = row.querySelector("#presenceStatus");
  if (!presenceStatusEl) {
    presenceStatusEl = document.createElement("div");
    presenceStatusEl.id = "presenceStatus";
    presenceStatusEl.style.fontFamily = "system-ui,-apple-system,Segoe UI,Roboto,Arial";
    presenceStatusEl.style.fontSize = "10px";
    presenceStatusEl.style.fontWeight = "800";
    presenceStatusEl.style.opacity = "0.85";
    presenceStatusEl.style.alignSelf = "center";
    presenceStatusEl.style.whiteSpace = "nowrap";
    row.appendChild(presenceStatusEl);
  }

  if (isSignedIn()) {
    const u = getUsername();
    presenceBtn.textContent = "Sign out";
    presenceBtn.classList.add("on");
    presenceStatusEl.textContent = `Online: ${u}`;
  } else {
    presenceBtn.textContent = "Sign in";
    presenceBtn.classList.remove("on");
    presenceStatusEl.textContent = "Offline";
  }
}

updatePresenceUI();

/* =========================================================
   Friends markers (other users) + YOUR marker (with name)
   IMPORTANT FIXES:
   - Name bubble does NOT rotate with arrow
   - No duplicates
   ========================================================= */
let friendsLayer = L.layerGroup().addTo(map);
let friendsByName = new Map(); // username -> marker

function makePersonIcon(username, isSelf) {
  // We keep your existing arrow CSS classes for the arrow itself.
  // Rotation will be applied ONLY to the arrow wrapper (.navArrowWrap), not the name bubble.
  const safeName = escapeHtml(username || "");
  const nameHtml = safeName
    ? `<div class="navNameBubble" style="
        position:absolute; left: 34px; top: 50%;
        transform: translateY(-50%);
        background: rgba(255,255,255,0.86);
        border: 1px solid rgba(0,0,0,0.18);
        border-radius: 999px;
        padding: 3px 10px;
        font-family: system-ui,-apple-system,Segoe UI,Roboto,Arial;
        font-weight: 950;
        font-size: 12px;
        color: #111;
        box-shadow: 0 2px 6px rgba(0,0,0,0.08);
        white-space: nowrap;
        pointer-events:none;
      ">${safeName}</div>`
    : "";

  // A small ring under self makes it easy to spot without changing your CSS file:
  const ring = isSelf
    ? `<div style="
         position:absolute; left: 50%; top: 50%;
         width: 36px; height: 36px; border-radius: 999px;
         border: 2px solid rgba(0,160,255,0.55);
         transform: translate(-50%,-50%);
         pointer-events:none;
       "></div>`
    : "";

  const html = `
    <div class="personWrap" style="position:relative; width: 180px; height: 42px; pointer-events:none;">
      ${ring}
      <div class="navArrowWrap navPulse" style="position:absolute; left:15px; top:21px; transform: translate(-50%,-50%);">
        <div class="navArrow"></div>
      </div>
      ${nameHtml}
    </div>
  `;

  return L.divIcon({
    className: "",
    html,
    iconSize: [180, 42],
    iconAnchor: [15, 21],
  });
}

function setMarkerMoving(marker, isMoving) {
  const el = marker?.getElement?.();
  if (!el) return;
  const wrap = el.querySelector(".navArrowWrap");
  if (!wrap) return;
  wrap.classList.toggle("navMoving", !!isMoving);
  wrap.classList.toggle("navPulse", !isMoving);
}

function setMarkerRotation(marker, deg) {
  const el = marker?.getElement?.();
  if (!el) return;
  const wrap = el.querySelector(".navArrowWrap");
  if (!wrap) return;
  wrap.style.transform = `translate(-50%,-50%) rotate(${deg}deg)`;
}

/* =========================================================
   Sign-in/out behavior (map access control)
   - Sign out => lose access to demand polygons (no timeline/frames)
   - Refresh does NOT auto sign-in unless LS_KEY_SIGNED_IN == "1"
   - Username is saved, so next sign-in is one tap (no retype)
   - Auto sign-out after 30 minutes inactive
   ========================================================= */
let timelineLoadedOnce = false;
let geoWatchId = null;
let startedLocationOnce = false;

let lastActiveMs = Date.now();
function bumpActivity() {
  lastActiveMs = Date.now();
}

map.on("click", bumpActivity);
map.on("dragstart", bumpActivity);
map.on("zoomstart", bumpActivity);

async function signInFlow() {
  // If username exists, don’t force retype.
  let username = getUsername();
  if (!username) {
    username = (prompt("Enter a username to be visible to friends:", "") || "").trim();
    if (!username) return;
    // keep it simple and safe
    username = username.replace(/\s+/g, "_").slice(0, 24);
    localStorage.setItem(LS_KEY_USERNAME, username);
  }

  // You only become “signed in” when you explicitly sign in (not by refresh)
  setSignedInFlag(true);
  bumpActivity();
  updatePresenceUI();

  // Tell backend (best effort)
  try {
    await postJSON(`${RAILWAY_BASE}/presence/signin`, {
      username,
      session_token: ensureSessionToken(),
    });
  } catch (e) {
    // Backend may not have it yet — do not break the map
    console.warn("presence/signin failed:", e?.message || e);
  }

  enableMapAccess();
  startPresenceLoops();
}

async function signOutFlow(reason = "manual") {
  const username = getUsername();
  setSignedInFlag(false);
  updatePresenceUI();

  // Stop sharing and hide everyone immediately
  stopPresenceLoops();
  clearFriends();
  stopLocationWatch();

  // Remove access to demand polygons
  disableMapAccess();

  // Tell backend (best effort)
  try {
    await postJSON(`${RAILWAY_BASE}/presence/signout`, {
      username,
      session_token: ensureSessionToken(),
      reason,
    });
  } catch (e) {
    console.warn("presence/signout failed:", e?.message || e);
  }
}

function disableMapAccess() {
  // clear geo layer
  if (geoLayer) {
    geoLayer.remove();
    geoLayer = null;
  }
  currentFrame = null;

  // disable slider interaction
  if (slider) slider.disabled = true;

  // disable nav
  setNavDestination(null);

  // show message
  if (timeLabel) timeLabel.textContent = "Signed out — tap Sign in to use the map";
  if (recommendEl) recommendEl.textContent = "Recommended: sign in to get suggestions";
}

function enableMapAccess() {
  if (slider) slider.disabled = false;

  // Load timeline/frames only when signed in
  if (!timelineLoadedOnce) {
    loadTimeline()
      .then(() => {
        timelineLoadedOnce = true;
      })
      .catch((err) => {
        console.error(err);
        timeLabel.textContent = `Error loading timeline: ${err.message}`;
      });
  } else {
    // re-render if we still have currentFrame cached elsewhere (we clear it on signout)
    // so simply reload current slider index
    const idx = Number(slider.value || "0");
    loadFrame(idx).catch((e) => console.warn(e));
  }

  // Start GPS only when signed in
  if (!startedLocationOnce) startLocationWatch();
  startedLocationOnce = true;
}

function maybeAutoSignout() {
  if (!isSignedIn()) return;
  const idle = Date.now() - lastActiveMs;
  if (idle >= INACTIVE_SIGNOUT_MS) {
    signOutFlow("inactive_30min").catch(console.warn);
  }
}

// check inactivity
setInterval(maybeAutoSignout, 30 * 1000);

/* =========================================================
   Live location arrow + auto-center (SIGNED-IN ONLY)
   - uses same movement logic
   - your name bubble stays readable (NOT rotating)
   ========================================================= */
let gpsFirstFixDone = false;
let navMarker = null;
let lastPos = null;
let lastHeadingDeg = 0;
let lastMoveTs = 0;

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
  if (geoWatchId != null && navigator.geolocation && navigator.geolocation.clearWatch) {
    try {
      navigator.geolocation.clearWatch(geoWatchId);
    } catch {}
  }
  geoWatchId = null;

  if (navMarker) {
    navMarker.remove();
    navMarker = null;
  }

  userLatLng = null;
  lastPos = null;
  gpsFirstFixDone = false;
  lastHeadingDeg = 0;
  lastMoveTs = 0;
}

function startLocationWatch() {
  if (!("geolocation" in navigator)) {
    if (recommendEl) recommendEl.textContent = "Recommended: location not supported";
    return;
  }
  if (!isSignedIn()) return;

  // Create your marker once
  const uname = getUsername() || "You";
  navMarker = L.marker([40.7128, -74.0060], {
    icon: makePersonIcon(uname, true),
    interactive: false,
    zIndexOffset: 9999,
  }).addTo(map);

  geoWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      if (!isSignedIn()) return; // if user signed out while watch is still running

      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const heading = pos.coords.heading;
      const ts = pos.timestamp || Date.now();

      bumpActivity();

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

      if (navMarker) {
        setMarkerRotation(navMarker, lastHeadingDeg);
        setMarkerMoving(navMarker, isMoving);
      }

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
    if (navMarker) setMarkerMoving(navMarker, !!recentlyMoved);
  }, 1200);
}

/* =========================================================
   Friends presence loops (poll + push)
   ========================================================= */
let presencePollTimer = null;
let presencePushTimer = null;

function clearFriends() {
  for (const [, m] of friendsByName) {
    try {
      m.remove();
    } catch {}
  }
  friendsByName.clear();
  try {
    friendsLayer.clearLayers();
  } catch {}
  friendsLayer = L.layerGroup().addTo(map);
}

function stopPresenceLoops() {
  if (presencePollTimer) clearInterval(presencePollTimer);
  if (presencePushTimer) clearInterval(presencePushTimer);
  presencePollTimer = null;
  presencePushTimer = null;
}

function startPresenceLoops() {
  stopPresenceLoops();
  if (!isSignedIn()) return;

  // Poll other users
  presencePollTimer = setInterval(() => {
    fetchAndRenderFriends().catch((e) => console.warn("presence/list failed:", e?.message || e));
  }, PRESENCE_POLL_MS);

  // Push our location (best effort)
  presencePushTimer = setInterval(() => {
    pushMyPresence().catch((e) => console.warn("presence/update failed:", e?.message || e));
  }, PRESENCE_PUSH_MS);

  // Run once immediately
  fetchAndRenderFriends().catch(() => {});
  pushMyPresence().catch(() => {});
}

function normalizePresenceList(payload) {
  // Accept a bunch of shapes safely:
  // {users:[...]} OR [...] OR {data:[...]}
  const arr =
    (payload && Array.isArray(payload.users) && payload.users) ||
    (payload && Array.isArray(payload.data) && payload.data) ||
    (Array.isArray(payload) ? payload : []);
  return arr
    .map((u) => {
      const username = (u.username || u.name || u.user || "").toString().trim();
      const lat = Number(u.lat ?? u.latitude ?? NaN);
      const lng = Number(u.lng ?? u.lon ?? u.longitude ?? NaN);
      const heading = Number(u.heading ?? u.bearing ?? NaN);
      const updated = Number(u.updated_at_ms ?? u.updated_at ?? u.ts ?? NaN);
      if (!username || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return { username, lat, lng, heading: Number.isFinite(heading) ? heading : null, updated_at_ms: updated };
    })
    .filter(Boolean);
}

async function fetchAndRenderFriends() {
  if (!isSignedIn()) return;

  const username = getUsername();
  const session_token = ensureSessionToken();

  let payload;
  try {
    payload = await fetchJSON(`${RAILWAY_BASE}/presence/list?u=${encodeURIComponent(username)}&t=${encodeURIComponent(session_token)}`);
  } catch (e) {
    // If backend doesn’t have it yet, do nothing (map must still work)
    return;
  }

  const list = normalizePresenceList(payload);
  const now = Date.now();

  // remove stale markers > 10 minutes (backend should do this too)
  const alive = new Set();
  for (const u of list) {
    if (!u.username) continue;
    if (u.username === username) continue;

    // if timestamp exists and it's too old, skip
    if (Number.isFinite(u.updated_at_ms) && now - u.updated_at_ms > 10 * 60 * 1000) continue;

    alive.add(u.username);

    let m = friendsByName.get(u.username);
    if (!m) {
      m = L.marker([u.lat, u.lng], {
        icon: makePersonIcon(u.username, false),
        interactive: false,
        zIndexOffset: 9000,
      });
      m.addTo(friendsLayer);
      friendsByName.set(u.username, m);
    } else {
      m.setLatLng([u.lat, u.lng]);
    }

    if (u.heading != null) setMarkerRotation(m, u.heading);
    setMarkerMoving(m, true);
  }

  // delete friends no longer present
  for (const [name, m] of friendsByName.entries()) {
    if (!alive.has(name)) {
      try {
        m.remove();
      } catch {}
      friendsByName.delete(name);
    }
  }
}

async function pushMyPresence() {
  if (!isSignedIn()) return;
  if (!userLatLng) return;

  const username = getUsername();
  const session_token = ensureSessionToken();

  // best-effort: don't block anything if missing backend
  try {
    await postJSON(`${RAILWAY_BASE}/presence/update`, {
      username,
      session_token,
      lat: userLatLng.lat,
      lng: userLatLng.lng,
      heading: lastHeadingDeg,
      ts: Date.now(),
    });
  } catch {
    // ignore
  }
}

/* =========================================================
   Auto-refresh every 5 minutes — EXACT BEHAVIOR
   ========================================================= */
async function refreshCurrentFrame() {
  if (!isSignedIn()) return;
  try {
    const idx = Number(slider.value || "0");
    await loadFrame(idx);
  } catch (e) {
    console.warn("Auto-refresh failed:", e);
  }
}
setInterval(refreshCurrentFrame, REFRESH_MS);

/* =========================================================
   Boot (IMPORTANT):
   - DO NOT auto-sign-in on refresh.
   - Username may be saved, but user must be signed in flag == "1"
   ========================================================= */
function boot() {
  // Always build UI (and de-dup)
  updatePresenceUI();

  // Always start with nav disabled until we have a frame + location
  setNavDestination(null);

  // If they are signed in, enable access and start loops
  if (isSignedIn()) {
    enableMapAccess();
    startPresenceLoops();
    startLocationWatch();
    startedLocationOnce = true;
    timelineLoadedOnce = false; // force loadTimeline path
    // enableMapAccess() will load timeline
  } else {
    // Signed out: no access to frames
    disableMapAccess();
  }
}

boot();