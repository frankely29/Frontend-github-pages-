const RAILWAY_BASE = "https://web-production-78f67.up.railway.app";
const BIN_MINUTES = 20;

// Auto-refresh current frame (no page reload)
const REFRESH_MS = 60 * 1000;
const TIMELINE_REFRESH_MS = 10 * 60 * 1000;

// MORE ZOOMED OUT (lower = zoomed out)
const AUTO_FOLLOW_ZOOM = 13;

// Grey zones treatment
const GREY_IS_WORSE_THAN_RED = true;
const GREY_MARKER_STYLE = "poop"; // "poop" | "x"

// ---------- Legend minimize ----------
const legendEl = document.getElementById("legend");
const legendToggleBtn = document.getElementById("legendToggle");
if (legendEl && legendToggleBtn) {
  legendToggleBtn.addEventListener("click", () => {
    const minimized = legendEl.classList.toggle("minimized");
    legendToggleBtn.textContent = minimized ? "+" : "–";
  });
}

const LABEL_ZOOM_MIN = 10;
const BOROUGH_ZOOM_SHOW = 15;
const LABEL_MAX_CHARS_MID = 14;

function shouldShowLabel(bucket, zoom) {
  if (zoom < LABEL_ZOOM_MIN) return false;
  const b = (bucket || "").trim();
  if (b === "nodata") return false;
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

function prettyBucket(b) {
  const m = {
    green: "Highest",
    purple: "High",
    blue: "Medium",
    sky: "Normal",
    yellow: "Below Normal",
    red: "Very Low / Avoid",
    nodata: "Worst / Avoid",
  };
  return m[b] || (b ?? "");
}

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

function isGreyWorstZone(props) {
  if (!GREY_IS_WORSE_THAN_RED) return false;
  if (!props) return false;
  if (props.low_sample === true) return true;
  const b = (props.bucket || "").trim();
  if (b === "nodata") return true;
  if (props.rating == null) return true;
  return false;
}

function effectiveBucket(props) {
  if (isGreyWorstZone(props)) return "nodata";
  return (props.bucket || "").trim();
}
function effectiveColor(props) {
  if (isGreyWorstZone(props)) return "#bdbdbd";
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

function buildPopupHTML(props) {
  const zoneName = (props.zone_name || "").trim();
  const borough = (props.borough || "").trim();

  if (isGreyWorstZone(props)) {
    return `
      <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; font-size:13px;">
        <div style="font-weight:900; margin-bottom:2px;">${escapeHtml(zoneName || `Zone ${props.LocationID ?? ""}`)}</div>
        ${borough ? `<div style="opacity:0.8; margin-bottom:6px;">${escapeHtml(borough)}</div>` : `<div style="margin-bottom:6px;"></div>`}
        <div><b>Status:</b> WORST / AVOID</div>
        <div style="margin-top:6px;"><b>Pickups (last ${BIN_MINUTES} min):</b> ${props.pickups ?? 0}</div>
      </div>
    `;
  }

  const rating = props.rating ?? "";
  const bucket = props.bucket ?? "";
  const pickups = props.pickups ?? "";
  const pay = props.avg_driver_pay == null ? "n/a" : Number(props.avg_driver_pay).toFixed(2);

  return `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; font-size:13px;">
      <div style="font-weight:800; margin-bottom:2px;">${escapeHtml(zoneName || `Zone ${props.LocationID ?? ""}`)}</div>
      ${borough ? `<div style="opacity:0.8; margin-bottom:6px;">${escapeHtml(borough)}</div>` : `<div style="margin-bottom:6px;"></div>`}
      <div><b>NYC Rating:</b> ${rating} (${prettyBucket(bucket)})</div>
      <div style="margin-top:6px;"><b>Pickups (last ${BIN_MINUTES} min):</b> ${pickups}</div>
      <div><b>Avg Driver Pay:</b> $${pay}</div>
    </div>
  `;
}

function makeWorstIcon() {
  const content = (GREY_MARKER_STYLE === "poop") ? "💩" : "✕";
  const size = 34;
  const fontSize = (GREY_MARKER_STYLE === "poop") ? 24 : 22;

  return L.divIcon({
    className: "",
    html: `
      <div style="
        width:${size}px;height:${size}px;border-radius:999px;
        background: rgba(255,255,255,0.85);
        border: 2px solid rgba(0,0,0,0.20);
        display:flex;align-items:center;justify-content:center;
        font-family: system-ui,-apple-system,Segoe UI,Roboto,Arial;
        font-weight: 1000;
        font-size: ${fontSize}px;
        color: rgba(0,0,0,0.65);
        box-shadow: 0 2px 10px rgba(0,0,0,0.12);
      ">${content}</div>
    `,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// ---------- Leaflet map ----------
const slider = document.getElementById("slider");
const timeLabel = document.getElementById("timeLabel");

const map = L.map("map", { zoomControl: true }).setView([40.7128, -74.0060], 10);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap &copy; CARTO",
  maxZoom: 19,
}).addTo(map);

// Panes so arrow is ALWAYS on top
map.createPane("worstPane");
map.getPane("worstPane").style.zIndex = 1600;

map.createPane("navPane");
map.getPane("navPane").style.zIndex = 2000;

let geoLayer = null;
let worstLayer = L.layerGroup([], { pane: "worstPane" }).addTo(map);

let timeline = [];
let minutesOfWeek = [];
let currentFrame = null;

function renderFrame(frame) {
  currentFrame = frame;

  timeLabel.textContent = formatNYCLabel(currentFrame.time);

  if (geoLayer) {
    geoLayer.remove();
    geoLayer = null;
  }
  worstLayer.clearLayers();

  const zoomNow = map.getZoom();
  const zClass = zoomClass(zoomNow);

  geoLayer = L.geoJSON(currentFrame.polygons, {
    style: (feature) => {
      const props = feature?.properties || {};
      const st = props.style || {};
      const fill = effectiveColor(props);
      const b = effectiveBucket(props);

      return {
        color: fill,
        weight: st.weight ?? 0,
        opacity: st.opacity ?? 0,
        fillColor: fill,
        fillOpacity: (b === "nodata") ? 0.45 : (st.fillOpacity ?? 0.82),
      };
    },
    onEachFeature: (feature, layer) => {
      const props = feature.properties || {};
      layer.bindPopup(buildPopupHTML(props), { maxWidth: 320 });

      const html = labelHTML(props, zoomNow);
      if (html) {
        layer.bindTooltip(html, {
          permanent: true,
          direction: "center",
          className: `zone-label ${zClass}`,
          opacity: 0.92,
          interactive: false,
        });
      }

      if (isGreyWorstZone(props)) {
        const center = geometryCenter(feature.geometry);
        if (center) {
          worstLayer.addLayer(
            L.marker([center.lat, center.lng], {
              icon: makeWorstIcon(),
              interactive: false,
              zIndexOffset: 700,
              pane: "worstPane",
            })
          );
        }
      }
    },
  }).addTo(map);
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
   Auto-center button
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
      suppressAutoDisableFor(800, () =>
        map.setView(userLatLng, Math.max(map.getZoom(), AUTO_FOLLOW_ZOOM), { animate: true })
      );
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

/* =========================
   Live location arrow + auto-center
   ========================= */
let gpsFirstFixDone = false;
let navMarker = null;
let lastPos = null;
let lastHeadingDeg = 0;
let lastMoveTs = 0;

function makeNavIcon() {
  return L.divIcon({
    className: "",
    html: `<div id="navWrap" class="navArrowWrap navPulse"><div class="navArrow"></div></div>`,
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

function startLocationWatch() {
  if (!("geolocation" in navigator)) {
    if (recommendEl) recommendEl.textContent = "Recommended: location not supported";
    return;
  }

  navMarker = L.marker([40.7128, -74.0060], {
    icon: makeNavIcon(),
    interactive: false,
    zIndexOffset: 999999,
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
        suppressAutoDisableFor(1200, () => map.setView(userLatLng, AUTO_FOLLOW_ZOOM, { animate: true }));
      } else if (autoCenter) {
        suppressAutoDisableFor(700, () => map.panTo(userLatLng, { animate: true }));
      }
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
   Auto-refresh without page reload
   ========================================================= */
async function refreshCurrentFrame() {
  try {
    const idx = Number(slider.value || "0");
    await loadFrame(idx);
  } catch (e) {
    console.warn("Auto-refresh failed:", e);
  }
}

async function refreshTimelineSometimes() {
  try {
    const t = await fetchJSON(`${RAILWAY_BASE}/timeline`);
    const newTimeline = Array.isArray(t) ? t : (t.timeline || []);
    if (!Array.isArray(newTimeline) || !newTimeline.length) return;

    if (newTimeline.length !== timeline.length) {
      timeline = newTimeline;
      minutesOfWeek = timeline.map(minuteOfWeekFromIso);
      slider.max = String(timeline.length - 1);
      const idx = Math.min(Number(slider.value || "0"), timeline.length - 1);
      slider.value = String(idx);
      await loadFrame(idx);
    }
  } catch {
    // silent
  }
}

setInterval(refreshCurrentFrame, REFRESH_MS);
setInterval(refreshTimelineSometimes, TIMELINE_REFRESH_MS);

// Boot
loadTimeline().catch((err) => {
  console.error(err);
  timeLabel.textContent = `Error loading timeline: ${err.message}`;
});
startLocationWatch();