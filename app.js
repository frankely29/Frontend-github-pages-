const RAILWAY_BASE = "https://web-production-78f67.up.railway.app";
const BIN_MINUTES = 20;

// ---------------------- LIVE LOCATION ----------------------
const ENABLE_LIVE_LOCATION = true;

let autoCenterEnabled = true;
let gpsWatchId = null;
let gpsFirstFixDone = false;

let myPosMarker = null;
let myAccCircle = null;

// Used for bearing + motion detection
let lastFix = null; // {lat,lng,ts,speedMps,headingDeg}
const MOVING_SPEED_MPS = 1.1;      // ~2.5 mph (tweak if you want)
const STATIONARY_SPEED_MPS = 0.6;  // below this = stationary

// ---------------------- LABEL RULES ----------------------
const LABEL_ZOOM_MIN = 10;
const BOROUGH_ZOOM_SHOW = 14;
const LABEL_MAX_CHARS_MID = 14;

// z10: green
// z11: + purple
// z12: + blue
// z13: + sky
// z14: + yellow
// z15+: + red
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

// ---------------------- TIME HELPERS ----------------------
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

// ---------------------- NETWORK ----------------------
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

// ---------------------- BUCKET LABEL ----------------------
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

// ---------------------- LABEL HELPERS ----------------------
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
  const z = Math.round(zoom);
  if (!shouldShowLabel(bucket, z)) return "";

  const zoneText = z < 13 ? shortenLabel(name, LABEL_MAX_CHARS_MID) : name;

  const borough = (props.borough || "").trim();
  const showBorough = z >= BOROUGH_ZOOM_SHOW && borough;

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

// ---------------------- LEAFLET MAP ----------------------
const slider = document.getElementById("slider");
const timeLabel = document.getElementById("timeLabel");
const autoCenterBtn = document.getElementById("autoCenterBtn");

const map = L.map("map", { zoomControl: true }).setView([40.7128, -74.0060], 11);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap &copy; CARTO",
  maxZoom: 19,
}).addTo(map);

let geoLayer = null;
let timeline = [];
let minutesOfWeek = [];
let currentFrame = null;

// ---------------------- POPUP ----------------------
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

// ---------------------- RENDER ----------------------
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

// ---------------------- AUTO-CENTER BUTTON ----------------------
function updateAutoCenterUI() {
  if (!autoCenterBtn) return;
  autoCenterBtn.textContent = `Auto-center: ${autoCenterEnabled ? "ON" : "OFF"}`;
  autoCenterBtn.classList.toggle("on", autoCenterEnabled);
  autoCenterBtn.classList.toggle("off", !autoCenterEnabled);
}
if (autoCenterBtn) {
  autoCenterBtn.addEventListener("click", () => {
    autoCenterEnabled = !autoCenterEnabled;
    updateAutoCenterUI();
  });
  updateAutoCenterUI();
}

// ---------------------- BEARING / HEADING HELPERS ----------------------
function toRad(d) { return (d * Math.PI) / 180; }
function toDeg(r) { return (r * 180) / Math.PI; }

// Bearing from A->B (degrees, 0=N, 90=E)
function bearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  let θ = toDeg(Math.atan2(y, x));
  θ = (θ + 360) % 360;
  return θ;
}

function buildArrowHTML(heading, moving) {
  const cls = moving ? "my-loc moving" : "my-loc stationary";
  // Rotate the whole container so SVG rotates too
  return `
    <div class="${cls}" style="transform: rotate(${Math.round(heading)}deg);">
      <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true">
        <path d="M12 2 L21 22 L12 17 L3 22 Z"
          fill="#0066ff"
          stroke="#ffffff"
          stroke-width="1.7"/>
      </svg>
    </div>
  `;
}

// ---------------------- LIVE LOCATION ----------------------
function startLiveLocation() {
  if (!ENABLE_LIVE_LOCATION) return;

  if (!("geolocation" in navigator)) {
    console.warn("Geolocation not supported on this browser.");
    return;
  }

  if (gpsWatchId != null) return;

  gpsWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const acc = pos.coords.accuracy || 0;

      // Speed and heading can be null on iOS sometimes
      const speed = (pos.coords.speed == null ? null : Number(pos.coords.speed)); // m/s
      const heading = (pos.coords.heading == null ? null : Number(pos.coords.heading)); // degrees

      const nowTs = Date.now();
      const ll = [lat, lng];

      // Determine movement
      // If speed is null, infer "moving" by distance over time from lastFix
      let inferredSpeed = speed;
      let inferredHeading = heading;

      if (lastFix) {
        const dt = Math.max(1, (nowTs - lastFix.ts) / 1000);

        // If heading not provided, compute bearing from last point
        if (inferredHeading == null) {
          inferredHeading = bearingDeg(lastFix.lat, lastFix.lng, lat, lng);
        }

        // If speed not provided, infer using rough distance (Leaflet has distanceTo)
        if (inferredSpeed == null) {
          const p1 = L.latLng(lastFix.lat, lastFix.lng);
          const p2 = L.latLng(lat, lng);
          const meters = p1.distanceTo(p2);
          inferredSpeed = meters / dt;
        }
      } else {
        // First fix: if no heading, default north
        if (inferredHeading == null) inferredHeading = 0;
        if (inferredSpeed == null) inferredSpeed = 0;
      }

      const moving = (inferredSpeed >= MOVING_SPEED_MPS);
      const stationary = (inferredSpeed <= STATIONARY_SPEED_MPS);

      // For in-between speeds, treat as moving (no pulse)
      const isMovingForStyle = moving && !stationary;

      // Build icon HTML
      const icon = L.divIcon({
        className: "", // IMPORTANT: prevents Leaflet default marker styling
        html: buildArrowHTML(inferredHeading ?? 0, isMovingForStyle),
        iconSize: [34, 34],
        iconAnchor: [17, 17],
      });

      if (!myPosMarker) {
        myPosMarker = L.marker(ll, {
          icon,
          interactive: false,
          keyboard: false,
          zIndexOffset: 999999,
        }).addTo(map);
      } else {
        myPosMarker.setLatLng(ll);
        myPosMarker.setIcon(icon); // update rotation + glow/pulse
      }

      if (!myAccCircle) {
        myAccCircle = L.circle(ll, {
          radius: Math.max(10, acc),
          weight: 1,
          color: "#0066ff",
          opacity: 0.25,
          fillColor: "#0066ff",
          fillOpacity: 0.06,
          interactive: false,
        }).addTo(map);
      } else {
        myAccCircle.setLatLng(ll);
        myAccCircle.setRadius(Math.max(10, acc));
      }

      // Auto-center behavior
      if (!gpsFirstFixDone) {
        gpsFirstFixDone = true;
        if (autoCenterEnabled) map.setView(ll, map.getZoom(), { animate: true });
      } else {
        if (autoCenterEnabled) map.panTo(ll, { animate: true });
      }

      lastFix = { lat, lng, ts: nowTs, speedMps: inferredSpeed, headingDeg: inferredHeading };
    },
    (err) => {
      console.warn("Geolocation error:", err);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 3000,
      timeout: 15000,
    }
  );
}

// ---------------------- BOOT ----------------------
startLiveLocation();

loadTimeline().catch((err) => {
  console.error(err);
  timeLabel.textContent = `Error loading timeline: ${err.message}`;
});