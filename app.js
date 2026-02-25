const RAILWAY_BASE = "https://web-production-78f67.up.railway.app";
const BIN_MINUTES = 20;

// Refresh current frame every 5 minutes
const REFRESH_MS = 5 * 60 * 1000;

/* =========================================================
   NEW: Realtime presence (friends)
   - Requires a backend WebSocket on Railway
   - Default path: /ws
   ========================================================= */
const PRESENCE_WS_PATH = "/ws";
const INACTIVITY_SIGNOUT_MS = 30 * 60 * 1000; // 30 min
const PRESENCE_SEND_THROTTLE_MS = 1200;       // don't spam location
const PRESENCE_STALE_MS = 2 * 60 * 1000;      // hide others if stale >2 min

const LS_USERNAME_KEY = "nyc_hotspot_username";

/* ===== Username modal ===== */
const nameModal = document.getElementById("nameModal");
const nameInput = document.getElementById("nameInput");
const nameSave = document.getElementById("nameSave");
const btnSignOut = document.getElementById("btnSignOut");

let myUsername = (localStorage.getItem(LS_USERNAME_KEY) || "").trim();
function showNameModal() {
  if (!nameModal) return;
  nameModal.classList.add("show");
  nameModal.setAttribute("aria-hidden", "false");
  if (nameInput) {
    nameInput.value = myUsername || "";
    setTimeout(() => nameInput.focus(), 50);
  }
}
function hideNameModal() {
  if (!nameModal) return;
  nameModal.classList.remove("show");
  nameModal.setAttribute("aria-hidden", "true");
}
function normalizeUsername(s) {
  const t = String(s || "").trim().replace(/\s+/g, " ");
  // simple safety: keep visible + short
  return t.slice(0, 24);
}
function ensureUsernameThen(fn) {
  myUsername = (localStorage.getItem(LS_USERNAME_KEY) || "").trim();
  if (!myUsername) {
    showNameModal();
    return;
  }
  fn();
}
if (nameSave) {
  nameSave.addEventListener("click", () => {
    const u = normalizeUsername(nameInput?.value);
    if (!u) return;
    localStorage.setItem(LS_USERNAME_KEY, u);
    myUsername = u;
    hideNameModal();
    connectPresence(); // start realtime once we have a name
  });
}
if (nameInput) {
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") nameSave?.click();
  });
}

/* ===== Inactivity tracking ===== */
let lastActiveTs = Date.now();
function markActive() {
  lastActiveTs = Date.now();
}
["pointerdown", "touchstart", "keydown", "wheel"].forEach((evt) => {
  window.addEventListener(evt, markActive, { passive: true });
});
document.addEventListener("visibilitychange", () => {
  // If the tab is hidden, we sign out immediately for privacy.
  if (document.visibilityState === "hidden") {
    signOutPresence("tab_hidden");
  } else {
    // back in foreground -> reconnect (if username exists)
    ensureUsernameThen(() => connectPresence());
  }
});

/* ===== Presence websocket + other users markers ===== */
let ws = null;
let wsConnected = false;
let myClientId = null;

const otherUsers = new Map(); // id -> { marker, lastSeen, username }
let lastPresenceSendTs = 0;

function makeWsUrl() {
  // page may be https (GitHub pages) -> use wss to Railway
  const base = new URL(RAILWAY_BASE);
  const proto = base.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${base.host}${PRESENCE_WS_PATH}`;
}

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function connectPresence() {
  myUsername = (localStorage.getItem(LS_USERNAME_KEY) || "").trim();
  if (!myUsername) return;

  // already connected
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const wsUrl = makeWsUrl();
  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    console.warn("Presence WS failed:", e);
    return;
  }

  ws.onopen = () => {
    wsConnected = true;
    // Hello message: let server assign id + store username
    sendWs({ type: "hello", username: myUsername });
  };

  ws.onmessage = (ev) => {
    const msg = safeJsonParse(ev.data);
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "welcome") {
      // {type:"welcome", id:"..."}
      myClientId = msg.id || null;
      return;
    }

    if (msg.type === "state") {
      // {type:"state", users:[{id,username,lat,lng,heading,ts}]}
      const users = Array.isArray(msg.users) ? msg.users : [];
      applyPresenceState(users);
      return;
    }

    if (msg.type === "user_left") {
      // {type:"user_left", id:"..."}
      const id = msg.id;
      if (id) removeOtherUser(id);
      return;
    }
  };

  ws.onclose = () => {
    wsConnected = false;
    myClientId = null;
    ws = null;
  };

  ws.onerror = (e) => {
    console.warn("Presence WS error:", e);
  };
}

function sendWs(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch {}
}

function signOutPresence(reason) {
  // tell server we are leaving, then close socket
  if (ws && ws.readyState === WebSocket.OPEN) {
    sendWs({ type: "signout", reason: reason || "manual" });
  }
  try { ws?.close(); } catch {}
  ws = null;
  wsConnected = false;
  myClientId = null;

  // remove other users too (optional, keeps map clean)
  for (const [id] of otherUsers.entries()) removeOtherUser(id);
}

if (btnSignOut) {
  btnSignOut.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    // remove saved name? user asked sign out button; keep username saved so they don't retype.
    signOutPresence("manual_signout");
  });
}

/* ===== Other user marker icon ===== */
function makeOtherUserIcon(username, isMoving) {
  const safeName = escapeHtml(username || "User");
  return L.divIcon({
    className: "",
    html: `
      <div class="navArrowWrap ${isMoving ? "navMoving" : "navPulse"}">
        <div class="navArrow"></div>
        <div class="userLabel">${safeName}</div>
      </div>
    `,
    iconSize: [30, 44],
    iconAnchor: [15, 15],
  });
}

function setOtherUserRotation(marker, deg) {
  const el = marker?.getElement?.();
  if (!el) return;
  const wrap = el.querySelector(".navArrowWrap");
  if (!wrap) return;
  wrap.style.transform = `rotate(${deg}deg)`;
}

function applyPresenceState(users) {
  const now = Date.now();
  const seenIds = new Set();

  for (const u of users) {
    if (!u || typeof u !== "object") continue;
    const id = String(u.id || "");
    if (!id) continue;
    if (myClientId && id === myClientId) continue; // don't render yourself from server

    const lat = Number(u.lat);
    const lng = Number(u.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const heading = Number(u.heading);
    const ts = Number(u.ts);
    const username = String(u.username || "User").slice(0, 24);
    const ageOk = Number.isFinite(ts) ? (now - ts) < PRESENCE_STALE_MS : true;
    if (!ageOk) continue;

    seenIds.add(id);

    const isMoving = !!u.moving;

    let entry = otherUsers.get(id);
    if (!entry) {
      const marker = L.marker([lat, lng], {
        icon: makeOtherUserIcon(username, isMoving),
        interactive: false,
        zIndexOffset: 8000,
      }).addTo(map);

      entry = { marker, lastSeen: now, username };
      otherUsers.set(id, entry);
    } else {
      entry.lastSeen = now;
      // If username changed, rebuild icon
      if (entry.username !== username) {
        entry.username = username;
        entry.marker.setIcon(makeOtherUserIcon(username, isMoving));
      }
      entry.marker.setLatLng([lat, lng]);
    }

    if (Number.isFinite(heading)) {
      setOtherUserRotation(entry.marker, heading);
    }
  }

  // remove users not in latest state
  for (const [id, entry] of otherUsers.entries()) {
    if (!seenIds.has(id)) {
      // keep briefly or remove immediately — remove immediately for correctness
      removeOtherUser(id);
    }
  }
}

function removeOtherUser(id) {
  const entry = otherUsers.get(id);
  if (!entry) return;
  try { entry.marker.remove(); } catch {}
  otherUsers.delete(id);
}

// Periodic cleanup (stale)
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of otherUsers.entries()) {
    if ((now - entry.lastSeen) > PRESENCE_STALE_MS) removeOtherUser(id);
  }
}, 30000);

// Inactivity auto sign-out (privacy)
setInterval(() => {
  const now = Date.now();
  if ((now - lastActiveTs) > INACTIVITY_SIGNOUT_MS) {
    signOutPresence("inactive_30min");
  }
}, 20000);


/* =========================================================
   YOUR ORIGINAL CODE STARTS (kept as-is)
   ========================================================= */

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
const modeNoteEl = document.getElementById("modeNote");

// Staten Island mode toggle (works anywhere)
const btnStatenIsland = document.getElementById("btnStatenIsland");
let statenIslandMode = false;

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

function syncStatenButton() {
  if (!btnStatenIsland) return;
  btnStatenIsland.textContent = `Staten Island Mode: ${statenIslandMode ? "ON" : "OFF"}`;
  btnStatenIsland.classList.toggle("on", !!statenIslandMode);

  if (modeNoteEl) {
    if (statenIslandMode) {
      modeNoteEl.innerHTML =
        `Staten Island Mode is ON: recommendations compare Staten Island zones only (still real data).<br/>Time label is NYC time.`;
    } else {
      modeNoteEl.innerHTML =
        `Colors come from rating (1–100) for the selected 20-minute window.<br/>Time label is NYC time.`;
    }
  }
}

if (btnStatenIsland) {
  btnStatenIsland.addEventListener("pointerdown", (e) => e.stopPropagation());
  btnStatenIsland.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    statenIslandMode = !statenIslandMode;
    syncStatenButton();

    if (currentFrame) updateRecommendation(currentFrame);
  });
}
syncStatenButton();

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
 * Recommendation logic:
 * - Normal mode: ONLY Blue/Purple/Green (blue+). Closer matters.
 * - Staten Island mode: ONLY Staten Island zones, allow ANY bucket
 *   (because SI is often low demand). Still uses real rating values.
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

  const allowedBluePlus = new Set(["blue", "purple", "green"]);

  // Distance penalty:
  // Normal mode: stronger (closer wins among good zones)
  // Staten mode: slightly weaker (SI is sparse; don't over-penalize distance)
  const DIST_PENALTY_PER_MILE = statenIslandMode ? 2.5 : 4.0;

  let best = null;

  for (const f of feats) {
    const props = f.properties || {};
    const geom = f.geometry;

    const rating = Number(props.rating ?? NaN);
    if (!Number.isFinite(rating)) continue;

    const borough = (props.borough || "").trim();
    const bucket = (props.bucket || "").trim();

    if (statenIslandMode) {
      // Staten Island zones only
      if (borough !== "Staten Island") continue;
      // allow all buckets so you can compare within SI
    } else {
      // Normal mode: require blue+
      if (!allowedBluePlus.has(bucket)) continue;
    }

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
        borough,
        bucket,
      };
    }
  }

  if (!best) {
    if (statenIslandMode) {
      recommendEl.textContent = "Recommended: no Staten Island data in this frame";
    } else {
      recommendEl.textContent = "Recommended: no Blue+ zone nearby right now";
    }
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

// DO NOT REVERT: default zoom OUT to see more boroughs
const map = L.map("map", { zoomControl: true }).setView([40.7128, -74.0060], 10);

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

function maybeSendPresence(lat, lng, headingDeg, moving) {
  const now = Date.now();
  if (!wsConnected || !ws || ws.readyState !== WebSocket.OPEN) return;
  if ((now - lastPresenceSendTs) < PRESENCE_SEND_THROTTLE_MS) return;

  lastPresenceSendTs = now;
  sendWs({
    type: "loc",
    lat,
    lng,
    heading: Number.isFinite(headingDeg) ? headingDeg : null,
    moving: !!moving,
    ts: now
  });
}

function startLocationWatch() {
  if (!("geolocation" in navigator)) {
    if (recommendEl) recommendEl.textContent = "Recommended: location not supported";
    return;
  }

  navMarker = L.marker([40.7128, -74.0060], {
    icon: makeNavIcon(),
    interactive: false,
    zIndexOffset: 9999,
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

        // DO NOT REVERT: GPS first fix zoom more zoomed out (borough visibility)
        const targetZoom = Math.max(map.getZoom(), 12);

        suppressAutoDisableFor(1200, () => map.setView(userLatLng, targetZoom, { animate: true }));
      } else {
        if (autoCenter) {
          suppressAutoDisableFor(700, () => map.panTo(userLatLng, { animate: true }));
        }
      }

      if (currentFrame) updateRecommendation(currentFrame);

      // NEW: presence send (only if username exists & WS connected)
      if (myUsername) maybeSendPresence(lat, lng, lastHeadingDeg, isMoving);
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

// Boot
setNavDestination(null);
loadTimeline().catch((err) => {
  console.error(err);
  timeLabel.textContent = `Error loading timeline: ${err.message}`;
});

// Start location tracking always (your behavior unchanged)
startLocationWatch();

// NEW: start presence after username is known
if (!myUsername) {
  showNameModal();
} else {
  connectPresence();
}