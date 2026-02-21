// =======================
// TLC Hotspot Map - app.js (Frontend)
// STRICT: reads Railway only
// Uses: GET /timeline + GET /frame/{idx}
// Slider initializes to closest NYC current time window (week wrap)
// =======================

const BASE = (window.RAILWAY_BASE_URL || "").replace(/\/$/, "");
if (!BASE) {
  throw new Error("Missing RAILWAY_BASE_URL in index.html");
}

function formatTimeLabelNYC(iso) {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Convert a frame ISO string to "minute-of-week" in NYC local time
// Monday 00:00 = 0 ... Sunday 23:59 = 10079
function minuteOfWeekNYC(iso) {
  const d = new Date(iso);
  // weekday as short, hour/min in NYC:
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const wk = parts.find(p => p.type === "weekday")?.value || "Mon";
  const hh = parseInt(parts.find(p => p.type === "hour")?.value || "0", 10);
  const mm = parseInt(parts.find(p => p.type === "minute")?.value || "0", 10);

  // Map weekday to Monday=0..Sunday=6
  const map = { Mon:0, Tue:1, Wed:2, Thu:3, Fri:4, Sat:5, Sun:6 };
  const dow = map[wk] ?? 0;

  return dow * 1440 + hh * 60 + mm;
}

function nowMinuteOfWeekNYC() {
  // Use current time but interpret in NYC timezone via Intl
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const wk = parts.find(p => p.type === "weekday")?.value || "Mon";
  const hh = parseInt(parts.find(p => p.type === "hour")?.value || "0", 10);
  const mm = parseInt(parts.find(p => p.type === "minute")?.value || "0", 10);

  const map = { Mon:0, Tue:1, Wed:2, Thu:3, Fri:4, Sat:5, Sun:6 };
  const dow = map[wk] ?? 0;

  return dow * 1440 + hh * 60 + mm;
}

// Closest index with week wrap:
// distance = min(|a-b|, 10080-|a-b|)
function closestIndexByMinuteOfWeek(timeline) {
  const nowMow = nowMinuteOfWeekNYC();
  let bestIdx = 0;
  let bestDist = Infinity;

  for (let i = 0; i < timeline.length; i++) {
    const m = minuteOfWeekNYC(timeline[i]);
    const diff = Math.abs(m - nowMow);
    const dist = Math.min(diff, 10080 - diff);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

// Map
const map = L.map("map", { zoomControl: true }).setView([40.72, -73.98], 12);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap &copy; CARTO",
}).addTo(map);

map.createPane("polys");
map.getPane("polys").style.zIndex = 400;

const polyLayer = L.geoJSON(null, {
  pane: "polys",
  style: (f) => {
    const st = f && f.properties && f.properties.style;
    return st || { color: "#999", weight: 0, fillColor: "#999", fillOpacity: 0.0 };
  },
  onEachFeature: (feature, layer) => {
    const p = feature.properties || {};
    const popup = `
      <div style="font-family:Arial; font-size:13px;">
        <div style="font-weight:900; font-size:14px;">Zone ${p.LocationID}</div>
        <div><b>Rating:</b> ${p.rating}/100</div>
        <hr style="margin:6px 0;">
        <div><b>Pickups:</b> ${p.pickups}</div>
        <div><b>Avg driver pay:</b> ${p.avg_driver_pay == null ? "n/a" : "$" + Number(p.avg_driver_pay).toFixed(2)}</div>
        <div><b>Avg tips:</b> ${p.avg_tips == null ? "n/a" : "$" + Number(p.avg_tips).toFixed(2)}</div>
      </div>
    `;
    layer.bindPopup(popup, { maxWidth: 320 });
  },
}).addTo(map);

// State
let timeline = [];
const frameCache = new Map(); // idx -> frame
let activeFetch = null;

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { cache: "no-store", ...opts });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function loadTimeline() {
  const data = await fetchJSON(`${BASE}/timeline`);
  timeline = data.timeline || [];
  return timeline;
}

async function loadFrame(idx) {
  if (frameCache.has(idx)) return frameCache.get(idx);

  // Abort previous in-flight request (prevents race when sliding fast)
  if (activeFetch) activeFetch.abort();
  activeFetch = new AbortController();

  const frame = await fetchJSON(`${BASE}/frame/${idx}`, { signal: activeFetch.signal });
  frameCache.set(idx, frame);

  // keep cache from growing forever
  if (frameCache.size > 80) {
    const firstKey = frameCache.keys().next().value;
    frameCache.delete(firstKey);
  }

  return frame;
}

function renderFrame(frame) {
  const key = frame.time;
  document.getElementById("timeLabel").textContent = formatTimeLabelNYC(key);

  polyLayer.clearLayers();
  if (frame.polygons) polyLayer.addData(frame.polygons);
}

async function renderIndex(idx) {
  const frame = await loadFrame(idx);
  renderFrame(frame);
}

async function main() {
  const slider = document.getElementById("slider");

  await loadTimeline();

  slider.min = 0;
  slider.max = Math.max(0, timeline.length - 1);
  slider.step = 1;

  // ✅ initialize to closest NYC current time window (week wrap)
  const startIdx = timeline.length ? closestIndexByMinuteOfWeek(timeline) : 0;
  slider.value = String(startIdx);

  let pending = null;
  slider.addEventListener("input", () => {
    pending = Number(slider.value);
    if (slider._raf) return;

    slider._raf = requestAnimationFrame(async () => {
      slider._raf = null;
      if (pending !== null) {
        try {
          await renderIndex(pending);
        } catch (e) {
          console.error(e);
          document.getElementById("timeLabel").textContent = "ERROR: " + e.message;
        }
      }
    });
  });

  if (timeline.length > 0) {
    await renderIndex(startIdx);
  } else {
    document.getElementById("timeLabel").textContent = "No timeline available. Run /generate on Railway.";
  }
}

main().catch((err) => {
  console.error(err);
  document.getElementById("timeLabel").textContent = "ERROR: " + err.message;
});