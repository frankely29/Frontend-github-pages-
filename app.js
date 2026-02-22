const RAILWAY_BASE = "https://web-production-78f67.up.railway.app";
const BIN_MINUTES = 20;
const REFRESH_MS = 5 * 60 * 1000;

// ---------- DOM ----------
const slider = document.getElementById("slider");
const timeLabel = document.getElementById("timeLabel");
const recommendEl = document.getElementById("recommendLine");

const mapRot = document.getElementById("mapRot");
const btnCenter = document.getElementById("btnCenter");
const btnRotate = document.getElementById("btnRotate");

const legendEl = document.getElementById("legend");
const legendToggleBtn = document.getElementById("legendToggle");
if (legendEl && legendToggleBtn) {
  legendToggleBtn.addEventListener("click", () => {
    const minimized = legendEl.classList.toggle("minimized");
    legendToggleBtn.textContent = minimized ? "+" : "–";
  });
}

// ---------- Persisted toggles ----------
const LS_CENTER = "tlc_recenter_on";
const LS_ROTATE = "tlc_rotate_on";

function lsGetBool(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return fallback;
    return v === "1";
  } catch {
    return fallback;
  }
}
function lsSetBool(key, val) {
  try { localStorage.setItem(key, val ? "1" : "0"); } catch {}
}

// Start ON by default, BUT persist across refresh
let recenterOn = lsGetBool(LS_CENTER, true);
let rotateOn   = lsGetBool(LS_ROTATE, true);

function setBtnState(btn, on) {
  if (!btn) return;
  btn.classList.toggle("on", !!on);
}
function syncButtons() {
  if (btnCenter) {
    btnCenter.textContent = recenterOn ? "Recenter: ON" : "Recenter: OFF";
    setBtnState(btnCenter, recenterOn);
  }
  if (btnRotate) {
    btnRotate.textContent = rotateOn ? "Rotate: ON" : "Rotate: OFF";
    setBtnState(btnRotate, rotateOn);
  }
}
syncButtons();

if (btnCenter) {
  btnCenter.addEventListener("click", () => {
    recenterOn = !recenterOn;
    lsSetBool(LS_CENTER, recenterOn);
    syncButtons();
    if (recenterOn && userLatLng) stableRecenter(userLatLng, true);
  });
}
if (btnRotate) {
  btnRotate.addEventListener("click", () => {
    rotateOn = !rotateOn;
    lsSetBool(LS_ROTATE, rotateOn);
    syncButtons();
    applySynchronizedRotation();
  });
}

// ---------- Leaflet ----------
const map = L.map("map", { zoomControl: true }).setView([40.7128, -74.0060], 11);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap &copy; CARTO",
  maxZoom: 19,
}).addTo(map);

// ---------- State ----------
let geoLayer = null;
let timeline = [];
let minutesOfWeek = [];
let currentFrame = null;

let userLatLng = null;
let navMarker = null;
let gpsFirstFixDone = false;

let lastPos = null; // {lat,lng,ts}
let lastHeadingDeg = 0;
let lastMoveTs = 0;

// If user explores map, disable recenter (keeps exploration usable)
function disableRecenterBecauseUserIsExploring() {
  if (!recenterOn) return;
  recenterOn = false;
  lsSetBool(LS_CENTER, recenterOn);
  syncButtons();
}
map.on("dragstart", disableRecenterBecauseUserIsExploring);
map.on("zoomstart", disableRecenterBecauseUserIsExploring);

// ---------- Rotation (Safari/Tesla safe): rotate mapRot only ----------
function setMapRot(deg) {
  if (!mapRot) return;
  // GPU hint + webkit transform for iOS Safari
  const t = `translateZ(0) rotate(${deg}deg)`;
  mapRot.style.transform = t;
  mapRot.style.webkitTransform = t;
}

// Arrow rotation rules:
// - rotateOn=true (heading-up map): mapRot rotates -heading, arrow stays UP (0)
// - rotateOn=false (north-up map): mapRot 0, arrow rotates to heading
function applyArrowRotation() {
  const el = document.getElementById("navWrap");
  if (!el) return;
  const arrowDeg = rotateOn ? 0 : lastHeadingDeg;
  el.style.transform = `rotate(${arrowDeg}deg)`;
}

function applySynchronizedRotation() {
  if (rotateOn) setMapRot(-lastHeadingDeg);
  else setMapRot(0);
  applyArrowRotation();

  // Leaflet can need a refresh after transforms on mobile
  setTimeout(() => map.invalidateSize(true), 50);
}

// ---------- Nav visuals ----------
function setNavVisual(isMoving) {
  const el = document.getElementById("navWrap");
  if (!el) return;
  el.classList.toggle("navMoving", !!isMoving);
  el.classList.toggle("navPulse", !isMoving);
}

function makeNavIcon() {
  return L.divIcon({
    className: "",
    html: `<div id="navWrap" class="navArrowWrap navPulse"><div class="navArrow"></div></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

// ---------- Utils ----------
async function fetchJSON(url) {
  const res = await fetch(url, { cache: "no-store", mode: "cors" });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} @ ${url} :: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); }
  catch { throw new Error(`Invalid JSON @ ${url} :: ${text.slice(0, 200)}`); }
}

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
  const names = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
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

  const mapv = {};
  for (const p of parts) mapv[p.type] = p.value;

  const dowMap = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const dow_m = dowMap[mapv.weekday] ?? 0;

  const hour = Number(mapv.hour);
  const minute = Number(mapv.minute);

  const total = dow_m * 1440 + hour * 60 + minute;
  return Math.floor(total / BIN_MINUTES) * BIN_MINUTES;
}
function cyclicDiff(a, b, mod) {
  const d = Math.abs(a - b);
  return Math.min(d, mod - d);
}
function pickClosestIndex(arr, target) {
  let bestIdx = 0, bestDiff = Infinity;
  for (let i = 0; i < arr.length; i++) {
    const diff = cyclicDiff(arr[i], target, 7 * 1440);
    if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
  }
  return bestIdx;
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
  const h = s1*s1 + Math.cos(lat1)*Math.cos(lat2)*s2*s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
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

// ---------- Labels ----------
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
function shortenLabel(text, maxChars) {
  const t = (text || "").trim();
  if (!t) return "";
  return t.length <= maxChars ? t : (t.slice(0, maxChars - 1) + "…");
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
function labelHTML(props, zoom) {
  const name = (props.zone_name || "").trim();
  if (!name) return "";

  const bucket = (props.bucket || "").trim();
  if (!shouldShowLabel(bucket, Math.round(zoom))) return "";

  const zoneText = zoom < 13 ? shortenLabel(name, LABEL_MAX_CHARS_MID) : name;

  const borough = (props.borough || "").trim();
  const showBorough = zoom >= BOROUGH_ZOOM_SHOW && borough;

  return `
    <div class="zn">${escapeHtml(zoneText)}</div>
    ${showBorough ? `<div class="br">${escapeHtml(borough)}</div>` : ""}
  `;
}

// ---------- Popup ----------
function prettyBucket(b) {
  const m = { green:"Highest", purple:"High", blue:"Medium", sky:"Normal", yellow:"Below Normal", red:"Very Low / Avoid" };
  return m[b] || (b ?? "");
}
function buildPopupHTML(props) {
  const zoneName = (props.zone_name || "").trim();
  const borough = (props.borough || "").trim();
  const rating = props.rating ?? "";
  const bucket = props.bucket ?? "";
  const pickups = props.pickups ?? "";
  const pay = props.avg_driver_pay == null ? "n/a" : props.avg_driver_pay.toFixed(2);

  return `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; font-size:13px;">
      <div style="font-weight:800; margin-bottom:2px;">${escapeHtml(zoneName || `Zone ${props.LocationID ?? ""}`)}</div>
      ${borough ? `<div style="opacity:0.8; margin-bottom:6px;">${escapeHtml(borough)}</div>` : `<div style="margin-bottom:6px;"></div>`}
      <div><b>Rating:</b> ${rating} (${prettyBucket(bucket)})</div>
      <div><b>Pickups (last ${BIN_MINUTES} min):</b> ${pickups}</div>
      <div><b>Avg Driver Pay:</b> $${pay}</div>
    </div>
  `;
}

// ---------- Recommendation ----------
function geometryCenter(geom) {
  let pts = [];
  if (!geom) return null;
  if (geom.type === "Polygon") pts = geom.coordinates?.[0] || [];
  else if (geom.type === "MultiPolygon") {
    const polys = geom.coordinates || [];
    for (const p of polys) pts.push(...(p?.[0] || []));
  } else return null;
  if (!pts.length) return null;
  let sumLng = 0, sumLat = 0;
  for (const [lng, lat] of pts) { sumLng += lng; sumLat += lat; }
  return { lat: sumLat / pts.length, lng: sumLng / pts.length };
}
function updateRecommendation(frame) {
  if (!recommendEl) return;
  if (!userLatLng) { recommendEl.textContent = "Recommended: enable location to get suggestions"; return; }

  const feats = frame?.polygons?.features || [];
  if (!feats.length) { recommendEl.textContent = "Recommended: …"; return; }

  const DIST_PENALTY_PER_MILE = 2.0;
  let best = null;

  for (const f of feats) {
    const props = f.properties || {};
    const center = geometryCenter(f.geometry);
    const rating = Number(props.rating ?? NaN);
    if (!center || !Number.isFinite(rating)) continue;

    const dMi = haversineMiles(userLatLng, center);
    const bucket = (props.bucket || "").trim();
    const hardAvoid = bucket === "red";
    const score = rating - dMi * DIST_PENALTY_PER_MILE - (hardAvoid ? 12 : 0);

    if (!best || score > best.score) {
      best = {
        score,
        dMi,
        rating,
        name: (props.zone_name || "").trim() || `Zone ${props.LocationID ?? ""}`,
        borough: (props.borough || "").trim(),
      };
    }
  }

  if (!best) { recommendEl.textContent = "Recommended: not enough data near you"; return; }
  const distTxt = best.dMi >= 10 ? `${best.dMi.toFixed(0)} mi` : `${best.dMi.toFixed(1)} mi`;
  const bTxt = best.borough ? ` (${best.borough})` : "";
  recommendEl.textContent = `Recommended: ${best.name}${bTxt} — Rating ${best.rating} — ${distTxt}`;
}

// ---------- Render ----------
function renderFrame(frame) {
  currentFrame = frame;
  timeLabel.textContent = formatNYCLabel(frame.time);

  if (geoLayer) { geoLayer.remove(); geoLayer = null; }

  const zoomNow = map.getZoom();
  const zClass = zoomClass(zoomNow);

  geoLayer = L.geoJSON(frame.polygons, {
    style: (feature) => {
      const st = feature?.properties?.style || {};
      return {
        color: st.color || st.fillColor || "#000",
        weight: st.weight ?? 0,
        opacity: st.opacity ?? 0,
        fillColor: st.fillColor || st.color || "#000",
        fillOpacity: st.fillOpacity ?? 0.82,
      };
    },
    onEachFeature: (feature, layer) => {
      const props = feature.properties || {};
      layer.bindPopup(buildPopupHTML(props), { maxWidth: 300 });

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

  updateRecommendation(frame);
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
map.on("zoomend", () => { if (currentFrame) renderFrame(currentFrame); });

// Debounced slider
let sliderDebounce = null;
slider.addEventListener("input", () => {
  const idx = Number(slider.value);
  if (sliderDebounce) clearTimeout(sliderDebounce);
  sliderDebounce = setTimeout(() => loadFrame(idx).catch(console.error), 80);
});

// ---------- Recenter ----------
let lastRecenterAt = 0;
const RECENTER_MIN_INTERVAL_MS = 900;
const RECENTER_MAX_DRIFT_MILES = 0.18;

function stableRecenter(latlng, force = false) {
  if (!recenterOn || !latlng) return;
  const now = Date.now();
  if (!force && (now - lastRecenterAt) < RECENTER_MIN_INTERVAL_MS) return;

  const center = map.getCenter();
  const drift = haversineMiles({ lat: center.lat, lng: center.lng }, { lat: latlng.lat, lng: latlng.lng });

  if (!force && drift < 0.03) return;

  if (drift > RECENTER_MAX_DRIFT_MILES) map.setView(latlng, map.getZoom(), { animate: false });
  else map.panTo(latlng, { animate: true });

  lastRecenterAt = now;
}

// ---------- Location watch ----------
function startLocationWatch() {
  if (!("geolocation" in navigator)) {
    if (recommendEl) recommendEl.textContent = "Recommended: location not supported";
    return;
  }

  navMarker = L.marker([40.7128, -74.0060], { icon: makeNavIcon(), interactive: false, zIndexOffset: 9999 }).addTo(map);

  navigator.geolocation.watchPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const ts = pos.timestamp || Date.now();

      userLatLng = { lat, lng };
      navMarker.setLatLng(userLatLng);

      let isMoving = false;

      if (lastPos) {
        const dMi = haversineMiles({ lat: lastPos.lat, lng: lastPos.lng }, userLatLng);
        const dtSec = Math.max(1, (ts - lastPos.ts) / 1000);
        const mph = (dMi / dtSec) * 3600;

        isMoving = mph >= 2.0;

        if (dMi > 0.01) lastHeadingDeg = computeBearingDeg({ lat: lastPos.lat, lng: lastPos.lng }, userLatLng);
        if (isMoving) lastMoveTs = ts;
      }
      lastPos = { lat, lng, ts };

      // ✅ Single source of truth rotation (heading)
      applySynchronizedRotation();
      setNavVisual(isMoving);

      if (!gpsFirstFixDone) {
        gpsFirstFixDone = true;
        map.setView(userLatLng, Math.max(map.getZoom(), 14), { animate: true });
      } else {
        stableRecenter(userLatLng, false);
      }

      if (currentFrame) updateRecommendation(currentFrame);
    },
    (err) => {
      console.warn("Geolocation error:", err);
      if (recommendEl) recommendEl.textContent = "Recommended: location blocked (enable it)";
    },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
  );

  setInterval(() => {
    const now = Date.now();
    const recentlyMoved = lastMoveTs && (now - lastMoveTs) < 5000;
    setNavVisual(!!recentlyMoved);
  }, 1200);
}

// ---------- Auto-refresh ----------
async function refreshCurrentFrame() {
  try {
    const idx = Number(slider.value || "0");
    await loadFrame(idx);
  } catch (e) {
    console.warn("Auto-refresh failed:", e);
  }
}
setInterval(refreshCurrentFrame, REFRESH_MS);

// ---------- Boot ----------
loadTimeline().catch((err) => {
  console.error(err);
  timeLabel.textContent = `Error loading timeline: ${err.message}`;
});

// Apply persisted rotation state immediately (before GPS moves)
applySynchronizedRotation();

startLocationWatch();