const RAILWAY_BASE = "https://web-production-78f67.up.railway.app";
const BIN_MINUTES = 20;

// Refresh current frame every 5 minutes
const REFRESH_MS = 5 * 60 * 1000;

/* =========================================================
   Friends / Auth settings
   ========================================================= */
const FRIENDS_HEARTBEAT_MS = 5000;
const INACTIVITY_SIGNOUT_MS = 30 * 60 * 1000; // 30 minutes
const LS_KEY_USERNAME = "tlc_friends_username";
const LS_KEY_LAST_ACTIVE = "tlc_friends_last_active_unix";

/* =========================================================
   iPhone view safety (keep UI in view; avoid scroll)
   ========================================================= */
(function viewportSafety() {
  try {
    document.documentElement.style.height = "100%";
    document.body.style.height = "100%";
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";

    const sliderWrap = document.querySelector(".sliderWrap");
    const legend = document.getElementById("legend");

    function apply() {
      // Safe-area bottom for iPhone + dynamic address bar
      const safeBottom = "env(safe-area-inset-bottom, 0px)";
      if (sliderWrap) sliderWrap.style.bottom = `calc(${safeBottom} + 8px)`;
      if (legend) legend.style.top = `calc(env(safe-area-inset-top, 0px) + 8px)`;
    }

    apply();

    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", apply);
      window.visualViewport.addEventListener("scroll", apply);
    }
    window.addEventListener("resize", apply);
  } catch {}
})();

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
   Staten Island Mode (toggle anywhere) - unchanged behavior
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
   Recommendation + Navigation - unchanged behavior
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

/* =========================================================
   Leaflet map (base)
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

/* =========================================================
   Signed-out overlay + locking map (lose access)
   ========================================================= */
let signedIn = false;

function ensureOverlay() {
  let el = document.getElementById("signedOutOverlay");
  if (el) return el;

  el = document.createElement("div");
  el.id = "signedOutOverlay";
  el.style.position = "absolute";
  el.style.inset = "0";
  el.style.zIndex = "900"; // under legend/slider (1000), above map
  el.style.display = "none";
  el.style.background = "rgba(255,255,255,0.55)";
  el.style.backdropFilter = "blur(2px)";
  el.style.webkitBackdropFilter = "blur(2px)";
  el.style.pointerEvents = "auto";

  const inner = document.createElement("div");
  inner.style.position = "absolute";
  inner.style.left = "50%";
  inner.style.top = "50%";
  inner.style.transform = "translate(-50%, -50%)";
  inner.style.padding = "12px 14px";
  inner.style.borderRadius = "14px";
  inner.style.background = "rgba(255,255,255,0.92)";
  inner.style.boxShadow = "0 6px 18px rgba(0,0,0,0.15)";
  inner.style.fontFamily = "system-ui,-apple-system,Segoe UI,Roboto,Arial";
  inner.style.fontWeight = "900";
  inner.style.fontSize = "14px";
  inner.innerHTML = `Signed out. Tap <b>Sign in</b> to use the map.`;

  el.appendChild(inner);
  document.body.appendChild(el);
  return el;
}

function lockMapInteractions(lock) {
  try {
    if (lock) {
      map.dragging.disable();
      map.scrollWheelZoom.disable();
      map.doubleClickZoom.disable();
      map.touchZoom.disable();
      map.boxZoom.disable();
      map.keyboard.disable();
      if (map.tap) map.tap.disable();
    } else {
      map.dragging.enable();
      map.scrollWheelZoom.enable();
      map.doubleClickZoom.enable();
      map.touchZoom.enable();
      map.boxZoom.enable();
      map.keyboard.enable();
      if (map.tap) map.tap.enable();
    }
  } catch {}
}

function setSignedOutUI(isOut) {
  const overlay = ensureOverlay();
  overlay.style.display = isOut ? "block" : "none";
  lockMapInteractions(isOut);

  // disable slider (no access)
  if (slider) slider.disabled = isOut;

  // recommendation line message
  if (recommendEl && isOut) {
    recommendEl.textContent = "Recommended: sign in to enable location + suggestions";
  }

  // time label
  if (timeLabel && isOut) timeLabel.textContent = "Signed out";

  // remove polygons when signed out
  if (isOut) {
    if (geoLayer) {
      geoLayer.remove();
      geoLayer = null;
    }
    currentFrame = null;
    timeline = [];
    minutesOfWeek = [];
    if (slider) {
      slider.min = "0";
      slider.max = "0";
      slider.value = "0";
    }
  }
}

/* =========================================================
   Popup / rendering (unchanged)
   ========================================================= */
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

  await loadFrame(idx);
}

// Re-render on zoom (no network)
map.on("zoomend", () => {
  if (currentFrame) renderFrame(currentFrame);
});

// Debounced slider (only if signed in)
let sliderDebounce = null;
slider.addEventListener("input", () => {
  if (!signedIn) return;
  const idx = Number(slider.value);
  if (sliderDebounce) clearTimeout(sliderDebounce);
  sliderDebounce = setTimeout(() => loadFrame(idx).catch(console.error), 80);
});

/* =========================================================
   Auto-center button (inside bottom bar) - unchanged
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
   Friend markers + your marker (username NOT rotating)
   ========================================================= */
(function injectFriendCSS() {
  const css = `
    .friendWrap{ position:relative; width:34px; height:34px; }
    .friendRot{ position:absolute; left:50%; top:50%; width:34px; height:34px; transform:translate(-50%,-50%) rotate(0deg); transform-origin:50% 50%; }
    .friendArrow{
      position:absolute; left:50%; top:50%;
      width:0; height:0;
      transform:translate(-50%,-62%);
      border-left:9px solid transparent;
      border-right:9px solid transparent;
      border-bottom:20px solid #111;
      filter: drop-shadow(0 2px 2px rgba(0,0,0,0.35));
    }
    .friendTail{
      position:absolute; left:50%; top:50%;
      width:6px; height:10px;
      transform:translate(-50%,6px);
      background:#111;
      border-radius:4px;
      filter: drop-shadow(0 2px 2px rgba(0,0,0,0.25));
    }
    .friendLabel{
      position:absolute;
      left: 38px;
      top: 50%;
      transform: translateY(-50%);
      background: rgba(255,255,255,0.90);
      border: 1px solid rgba(0,0,0,0.18);
      border-radius: 999px;
      padding: 3px 8px;
      font-family: system-ui,-apple-system,Segoe UI,Roboto,Arial;
      font-weight: 950;
      font-size: 12px;
      white-space: nowrap;
      max-width: 180px;
      overflow: hidden;
      text-overflow: ellipsis;
      box-shadow: 0 2px 6px rgba(0,0,0,0.10);
      pointer-events: none;
    }
    .friendDot{
      position:absolute; left:50%; top:50%;
      width:22px; height:22px;
      transform:translate(-50%,-50%);
      border-radius:999px;
      border: 2px solid rgba(0,160,255,0.75);
      box-shadow: 0 0 10px rgba(0,160,255,0.25);
      pointer-events:none;
    }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
})();

/* =========================
   Live location arrow + auto-center (enhanced)
   ========================= */
let gpsFirstFixDone = false;
let navMarker = null;
let watchId = null;
let lastPos = null;
let lastHeadingDeg = 0;
let lastMoveTs = 0;

function makeSelfIcon(username) {
  const safeName = escapeHtml(username || "");
  return L.divIcon({
    className: "",
    html: `
      <div class="friendWrap">
        <div class="friendDot"></div>
        <div id="selfRot" class="friendRot">
          <div class="friendArrow"></div>
          <div class="friendTail"></div>
        </div>
        ${safeName ? `<div class="friendLabel">${safeName}</div>` : ``}
      </div>
    `,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

function setSelfRotation(deg) {
  const el = document.getElementById("selfRot");
  if (!el) return;
  el.style.transform = `translate(-50%,-50%) rotate(${deg}deg)`;
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

function startLocationWatch(username) {
  if (!("geolocation" in navigator)) {
    if (recommendEl) recommendEl.textContent = "Recommended: location not supported";
    return;
  }

  if (navMarker) {
    try { navMarker.remove(); } catch {}
    navMarker = null;
  }

  navMarker = L.marker([40.7128, -74.0060], {
    icon: makeSelfIcon(username),
    interactive: false,
    zIndexOffset: 9999,
  }).addTo(map);

  if (watchId != null) {
    try { navigator.geolocation.clearWatch(watchId); } catch {}
    watchId = null;
  }

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      // activity timestamp
      bumpActivity();

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
      setSelfRotation(lastHeadingDeg);

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
    const recentlyMoved = lastMoveTs && (now - lastMoveTs) < 5000;
    // (kept minimal; your old pulse/moving effects were CSS-only before)
    // If you want, we can re-add moving glow later.
    void recentlyMoved;
  }, 1200);
}

/* =========================================================
   Friends presence (polling heartbeat)
   Backend expected:
     POST /friends/heartbeat  { username, lat, lng, heading, ts }
       -> { users: [ {username, lat, lng, heading, ts} ] }
     POST /friends/signout    { username }
   If these endpoints don't exist yet, it fails silently.
   ========================================================= */
let presenceTimer = null;
const friendMarkers = new Map(); // username -> L.marker

function makeFriendIcon(username) {
  const safeName = escapeHtml(username || "");
  return L.divIcon({
    className: "",
    html: `
      <div class="friendWrap">
        <div class="friendDot"></div>
        <div class="friendRot" data-frot="1">
          <div class="friendArrow"></div>
          <div class="friendTail"></div>
        </div>
        ${safeName ? `<div class="friendLabel">${safeName}</div>` : ``}
      </div>
    `,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

function setFriendRotation(marker, deg) {
  const el = marker?._icon?.querySelector?.('[data-frot="1"]');
  if (!el) return;
  el.style.transform = `translate(-50%,-50%) rotate(${deg}deg)`;
}

async function heartbeatFriends(username) {
  if (!signedIn) return;
  if (!userLatLng) return;

  try {
    const payload = {
      username,
      lat: userLatLng.lat,
      lng: userLatLng.lng,
      heading: Number.isFinite(lastHeadingDeg) ? lastHeadingDeg : null,
      ts: Date.now(),
    };

    const data = await fetchJSON(`${RAILWAY_BASE}/friends/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const users = Array.isArray(data?.users) ? data.users : [];

    const seen = new Set();

    for (const u of users) {
      const un = (u.username || "").trim();
      if (!un) continue;
      if (un === username) continue;

      const lat = Number(u.lat);
      const lng = Number(u.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      seen.add(un);

      let m = friendMarkers.get(un);
      if (!m) {
        m = L.marker([lat, lng], { icon: makeFriendIcon(un), interactive: false, zIndexOffset: 5000 }).addTo(map);
        friendMarkers.set(un, m);
      } else {
        m.setLatLng([lat, lng]);
      }

      const hd = Number(u.heading);
      if (Number.isFinite(hd)) setFriendRotation(m, hd);
    }

    // remove stale not returned
    for (const [un, m] of friendMarkers.entries()) {
      if (!seen.has(un)) {
        try { m.remove(); } catch {}
        friendMarkers.delete(un);
      }
    }
  } catch (e) {
    // If backend doesn't have friends endpoints yet, don't break the map
    // console.warn("friends heartbeat failed:", e);
  }
}

function startPresence(username) {
  stopPresence();
  presenceTimer = setInterval(() => heartbeatFriends(username), FRIENDS_HEARTBEAT_MS);
}
function stopPresence() {
  if (presenceTimer) clearInterval(presenceTimer);
  presenceTimer = null;

  for (const [, m] of friendMarkers.entries()) {
    try { m.remove(); } catch {}
  }
  friendMarkers.clear();
}

async function serverSignOut(username) {
  try {
    await fetchJSON(`${RAILWAY_BASE}/friends/signout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
    });
  } catch {}
}

/* =========================================================
   Auth UI (single button, no duplicates)
   ========================================================= */
function ensureAuthButton() {
  // Remove any duplicates created by older versions
  const existing = Array.from(document.querySelectorAll('[data-auth-btn="1"]'));
  if (existing.length > 1) {
    for (let i = 1; i < existing.length; i++) existing[i].remove();
  }
  if (existing[0]) return existing[0];

  // Place it in legend under navRow (same area as Navigate + Staten Island)
  const navRow = document.querySelector(".navRow");
  if (!navRow) return null;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "modeBtn";
  btn.setAttribute("data-auth-btn", "1");
  btn.textContent = "Sign in";

  // prevent map drag on tap
  btn.addEventListener("pointerdown", (e) => e.stopPropagation());
  btn.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });

  navRow.appendChild(btn);
  return btn;
}

const btnAuth = ensureAuthButton();

function setAuthButtonLabel() {
  if (!btnAuth) return;
  btnAuth.textContent = signedIn ? "Sign out" : "Sign in";
  btnAuth.classList.toggle("on", !!signedIn);
}

function promptUsernameIfNeeded() {
  let u = (localStorage.getItem(LS_KEY_USERNAME) || "").trim();
  if (u) return u;

  u = (prompt("Enter a username (shown on the map):") || "").trim();
  if (!u) return null;

  // keep it clean
  u = u.replace(/\s+/g, "_").slice(0, 18);
  localStorage.setItem(LS_KEY_USERNAME, u);
  return u;
}

function bumpActivity() {
  localStorage.setItem(LS_KEY_LAST_ACTIVE, String(Date.now()));
}
function isInactiveTooLong() {
  const t = Number(localStorage.getItem(LS_KEY_LAST_ACTIVE) || "0");
  if (!Number.isFinite(t) || t <= 0) return true;
  return (Date.now() - t) > INACTIVITY_SIGNOUT_MS;
}

/* =========================================================
   Sign in / out behavior
   ========================================================= */
let inactivityTimer = null;
function startInactivityWatch() {
  stopInactivityWatch();
  inactivityTimer = setInterval(() => {
    if (!signedIn) return;
    if (isInactiveTooLong()) {
      doSignOut("inactive");
    }
  }, 15000);
}
function stopInactivityWatch() {
  if (inactivityTimer) clearInterval(inactivityTimer);
  inactivityTimer = null;
}

async function doSignIn() {
  const username = promptUsernameIfNeeded();
  if (!username) return;

  signedIn = true;
  bumpActivity();
  setAuthButtonLabel();
  setSignedOutUI(false);

  // update self icon with name
  startLocationWatch(username);

  // Start map data
  setNavDestination(null);
  await loadTimeline().catch((err) => {
    console.error(err);
    if (timeLabel) timeLabel.textContent = `Error loading timeline: ${err.message}`;
  });

  // Start friends presence + inactivity tracking
  startPresence(username);
  startInactivityWatch();
}

async function doSignOut(reason = "manual") {
  const username = (localStorage.getItem(LS_KEY_USERNAME) || "").trim();

  signedIn = false;
  setAuthButtonLabel();
  stopPresence();
  stopInactivityWatch();

  // stop gps
  if (watchId != null) {
    try { navigator.geolocation.clearWatch(watchId); } catch {}
    watchId = null;
  }
  userLatLng = null;
  lastPos = null;

  if (navMarker) {
    try { navMarker.remove(); } catch {}
    navMarker = null;
  }

  // server cleanup (best-effort)
  if (username) serverSignOut(username);

  // lock + remove access
  setSignedOutUI(true);

  // keep Staten button still usable (you wanted toggle anywhere)
  // but it only affects colors when signed in and frames are loaded
  if (reason === "inactive") {
    // optional small hint
    if (recommendEl) recommendEl.textContent = "Signed out due to inactivity. Tap Sign in to continue.";
  }
}

/* =========================================================
   Auto-refresh every 5 minutes (only when signed in)
   ========================================================= */
async function refreshCurrentFrame() {
  if (!signedIn) return;
  try {
    const idx = Number(slider.value || "0");
    await loadFrame(idx);
  } catch (e) {
    console.warn("Auto-refresh failed:", e);
  }
}
setInterval(refreshCurrentFrame, REFRESH_MS);

/* =========================================================
   Auth button handler
   ========================================================= */
if (btnAuth) {
  btnAuth.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (signedIn) {
      await doSignOut("manual");
    } else {
      await doSignIn();
    }
  });
}

/* =========================================================
   Boot
   - If user was active recently, auto sign-in
   - Otherwise start signed out (privacy)
   ========================================================= */
setNavDestination(null);
setSignedOutUI(true);
setAuthButtonLabel();

(function bootAuth() {
  const username = (localStorage.getItem(LS_KEY_USERNAME) || "").trim();
  if (username && !isInactiveTooLong()) {
    // auto sign-in if they were active recently
    doSignIn().catch(console.error);
  } else {
    // signed out by default for privacy
    // (no auto load of timeline)
  }
})();