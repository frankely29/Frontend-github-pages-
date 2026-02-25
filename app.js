const RAILWAY_BASE = "https://web-production-78f67.up.railway.app";
const BIN_MINUTES = 20;

// Refresh current frame every 5 minutes
const REFRESH_MS = 5 * 60 * 1000;

// WebSocket endpoint
const WS_BASE = RAILWAY_BASE.replace("https://", "wss://").replace("http://", "ws://");
const WS_URL = `${WS_BASE}/ws`;

const PRESENCE_PING_MS = 15000;     // keepalive ping
const SEND_LOC_MS = 2500;           // send location updates
const USERNAME_KEY = "tlc_hotspot_username";

// ---------- Legend minimize ----------
const legendEl = document.getElementById("legend");
const legendToggleBtn = document.getElementById("legendToggle");
if (legendEl && legendToggleBtn) {
  legendToggleBtn.addEventListener("click", () => {
    const minimized = legendEl.classList.toggle("minimized");
    legendToggleBtn.textContent = minimized ? "+" : "–";
  });
}

/** LABEL VISIBILITY (mobile-friendly, demand-priority)
 * z10: green only
 * z11: green + purple
 * z12: + blue
 * z13: + sky
 * z14: + yellow
 * z15+: + red (everything)
 */
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
function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ---------- Recommendation + Navigation ----------
const recommendEl = document.getElementById("recommendLine");
const navBtn = document.getElementById("navBtn");

let userLatLng = null;
let recommendedDest = null; // {lat,lng,name,borough,rating,distMi}

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

/**
 * Recommendation must be BLUE or higher:
 * blue/purple/green only
 * Closer should matter a lot.
 */
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

    const bucket = (props.bucket || "").trim();
    if (!allowed.has(bucket)) continue;

    const rating = Number(props.rating ?? NaN);
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
  recommendEl.textContent = `Recommended: ${best.name}${bTxt} — Rating ${best.rating} — ${distTxt}`;

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

// Keep your current default view
const map = L.map("map", { zoomControl: true }).setView([40.7128, -74.0060], 11);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap &copy; CARTO",
  maxZoom: 19,
}).addTo(map);

let geoLayer = null;
let timeline = [];
let minutesOfWeek = [];
let currentFrame = null;

// Popup
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

function renderFrame(frame) {
  currentFrame = frame;
  timeLabel.textContent = formatNYCLabel(frame.time);

  if (geoLayer) {
    geoLayer.remove();
    geoLayer = null;
  }

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
map.on("zoomend", () => {
  if (currentFrame) renderFrame(currentFrame);
});

// Debounced slider
let sliderDebounce = null;
slider.addEventListener("input", () => {
  const idx = Number(slider.value);
  if (sliderDebounce) clearTimeout(sliderDebounce);
  sliderDebounce = setTimeout(() => loadFrame(idx).catch(console.error), 80);
});

/* =========================================================
   Auto-center button - stable logic
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
   Username modal (saved once)
   ========================================================= */
const nameModal = document.getElementById("nameModal");
const nameInput = document.getElementById("nameInput");
const nameGo = document.getElementById("nameGo");
const nameErr = document.getElementById("nameErr");

let myName = null;

function showNameModal(errText = "") {
  if (!nameModal) return;
  nameModal.classList.add("show");
  nameModal.setAttribute("aria-hidden", "false");
  if (nameErr) nameErr.textContent = errText || "";
  if (nameInput) {
    nameInput.value = "";
    setTimeout(() => nameInput.focus(), 50);
  }
}

function hideNameModal() {
  if (!nameModal) return;
  nameModal.classList.remove("show");
  nameModal.setAttribute("aria-hidden", "true");
  if (nameErr) nameErr.textContent = "";
}

function validUsername(s) {
  const t = (s || "").trim();
  if (t.length < 2 || t.length > 20) return false;
  // allow letters numbers underscore dash space
  if (!/^[a-zA-Z0-9 _-]+$/.test(t)) return false;
  return true;
}

/* =========================================================
   Presence: WebSocket realtime users
   ========================================================= */
let ws = null;
let wsOpen = false;
let pingTimer = null;

const otherMarkers = new Map(); // name -> L.marker
let myMarker = null;

function makeUserIcon(name, moving) {
  const safeName = escapeHtml(name || "");
  const wrapClass = `userWrap ${moving ? "userMoving" : ""} ${moving ? "" : "userPulse"}`;
  return L.divIcon({
    className: "",
    html: `
      <div class="${wrapClass}">
        <div class="userArrow"></div>
        <div class="userStem"></div>
        <div class="userNameTag">${safeName}</div>
      </div>
    `,
    iconSize: [34, 46],
    iconAnchor: [17, 17],
  });
}

function rotateMarker(marker, deg) {
  // rotate the inner wrap only
  const el = marker?.getElement?.();
  if (!el) return;
  const wrap = el.querySelector(".userWrap");
  if (!wrap) return;
  wrap.style.transform = `rotate(${deg || 0}deg)`;
}

function upsertUserMarker(u) {
  const name = u.name;
  if (!name) return;

  const lat = u.lat, lng = u.lng;
  if (typeof lat !== "number" || typeof lng !== "number") return;

  const heading = (typeof u.heading === "number" && Number.isFinite(u.heading)) ? u.heading : 0;
  const moving = !!u.moving;

  // My marker
  if (name === myName) {
    if (!myMarker) {
      myMarker = L.marker([lat, lng], {
        icon: makeUserIcon(name, moving),
        interactive: false,
        zIndexOffset: 10000,
      }).addTo(map);
    } else {
      myMarker.setLatLng([lat, lng]);
      myMarker.setIcon(makeUserIcon(name, moving));
    }
    rotateMarker(myMarker, heading);
    return;
  }

  // Other markers
  let m = otherMarkers.get(name);
  if (!m) {
    m = L.marker([lat, lng], {
      icon: makeUserIcon(name, moving),
      interactive: false,
      zIndexOffset: 9000,
    }).addTo(map);
    otherMarkers.set(name, m);
  } else {
    m.setLatLng([lat, lng]);
    m.setIcon(makeUserIcon(name, moving));
  }
  rotateMarker(m, heading);
}

function removeMissingUsers(namesSet) {
  for (const [name, marker] of otherMarkers.entries()) {
    if (!namesSet.has(name)) {
      try { marker.remove(); } catch {}
      otherMarkers.delete(name);
    }
  }
  // If I'm missing (server removed me), also remove my marker
  if (myMarker && myName && !namesSet.has(myName)) {
    try { myMarker.remove(); } catch {}
    myMarker = null;
  }
}

function connectWS() {
  if (!myName) return;

  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }

  const url = `${WS_URL}?name=${encodeURIComponent(myName)}`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    wsOpen = true;
    // Start ping
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      try {
        if (wsOpen) ws.send(JSON.stringify({ type: "ping" }));
      } catch {}
    }, PRESENCE_PING_MS);
  };

  ws.onmessage = (ev) => {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === "error") {
      // Username taken or invalid
      const err = msg.error || "Error";
      try { ws.close(); } catch {}
      wsOpen = false;
      localStorage.removeItem(USERNAME_KEY);
      myName = null;
      showNameModal(err);
      return;
    }

    if (msg.type === "users") {
      const arr = Array.isArray(msg.users) ? msg.users : [];
      const namesSet = new Set();
      for (const u of arr) {
        if (!u || !u.name) continue;
        namesSet.add(u.name);
        upsertUserMarker({
          name: u.name,
          lat: u.lat,
          lng: u.lng,
          heading: u.heading,
          moving: u.moving
        });
      }
      removeMissingUsers(namesSet);
      return;
    }
  };

  ws.onclose = () => {
    wsOpen = false;
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  };

  ws.onerror = () => {
    // ignore; onclose will handle state
  };
}

function wsSend(obj) {
  try {
    if (wsOpen && ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  } catch {}
}

/* =========================================================
   Sign out button
   ========================================================= */
const signOutBtn = document.getElementById("signOutBtn");
if (signOutBtn) {
  signOutBtn.addEventListener("click", () => {
    // Tell server
    wsSend({ type: "signout" });

    // Local cleanup
    localStorage.removeItem(USERNAME_KEY);
    myName = null;

    // Remove markers
    if (myMarker) { try { myMarker.remove(); } catch {} myMarker = null; }
    for (const m of otherMarkers.values()) { try { m.remove(); } catch {} }
    otherMarkers.clear();

    // Close WS
    try { if (ws) ws.close(); } catch {}
    ws = null;
    wsOpen = false;

    // Show modal again
    showNameModal("");
  });
}

/* =========================================================
   Location watch: send to server + keep local auto-center
   ========================================================= */
let gpsFirstFixDone = false;
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

function startLocationWatch() {
  if (!("geolocation" in navigator)) {
    if (recommendEl) recommendEl.textContent = "Recommended: location not supported";
    return;
  }

  // Throttle sending
  let lastSentTs = 0;

  navigator.geolocation.watchPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const heading = pos.coords.heading; // may be null/NaN on iOS unless moving
      const ts = pos.timestamp || Date.now();

      userLatLng = { lat, lng };

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

      // One-time zoom to you on first fix
      if (!gpsFirstFixDone) {
        gpsFirstFixDone = true;
        const targetZoom = Math.max(map.getZoom(), 14);
        suppressAutoDisableFor(1200, () => map.setView(userLatLng, targetZoom, { animate: true }));
      } else {
        if (autoCenter) suppressAutoDisableFor(700, () => map.panTo(userLatLng, { animate: true }));
      }

      if (currentFrame) updateRecommendation(currentFrame);

      // Send to server (throttled)
      const now = Date.now();
      if (now - lastSentTs > SEND_LOC_MS) {
        lastSentTs = now;
        wsSend({
          type: "loc",
          lat,
          lng,
          heading: lastHeadingDeg,
          moving: isMoving
        });
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

  // Keep pulse/visual state based on movement, and send occasional keepalive loc if stationary
  setInterval(() => {
    const now = Date.now();
    const recentlyMoved = lastMoveTs && (now - lastMoveTs) < 5000;

    // If we have a fix but we haven't sent in a while, send a keepalive location
    if (userLatLng && wsOpen) {
      wsSend({
        type: "loc",
        lat: userLatLng.lat,
        lng: userLatLng.lng,
        heading: lastHeadingDeg,
        moving: !!recentlyMoved
      });
    }
  }, 8000);
}

// ---------- Auto-refresh every 5 minutes ----------
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
setNavDestination(null);
loadTimeline().catch((err) => {
  console.error(err);
  timeLabel.textContent = `Error loading timeline: ${err.message}`;
});

// Username flow: load saved, else ask once
(function initUsername() {
  const saved = (localStorage.getItem(USERNAME_KEY) || "").trim();
  if (saved && validUsername(saved)) {
    myName = saved;
    connectWS();
    hideNameModal();
  } else {
    showNameModal("");
  }

  function tryStart() {
    const candidate = (nameInput?.value || "").trim();
    if (!validUsername(candidate)) {
      if (nameErr) nameErr.textContent = "Use 2–20 chars: letters, numbers, space, _ or -";
      return;
    }
    myName = candidate;
    localStorage.setItem(USERNAME_KEY, myName);
    hideNameModal();
    connectWS();
  }

  if (nameGo) nameGo.addEventListener("click", tryStart);
  if (nameInput) {
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") tryStart();
    });
  }
})();

startLocationWatch();