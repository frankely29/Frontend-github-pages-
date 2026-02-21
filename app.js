// =======================
// TLC Hotspot Map - app.js (FULL)
// - Phone-friendly
// - Polygons NEVER cover markers (Leaflet panes)
// - Time label forced to NYC time
// - Slider throttled (smooth on iPhone)
// - Loads data from Railway (/hotspots) so GitHub doesn't need 113MB file
// =======================

// >>> CHANGE THIS if Railway domain changes:
const RAILWAY_BASE = "https://web-production-78f67.up.railway.app";
const DATA_URL = `${RAILWAY_BASE}/hotspots?ts=${Date.now()}`; // cache-bust

function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function lerp(a,b,t){ return a + (b-a)*t; }

function fmtMoney(x){
  if (x === null || x === undefined || Number.isNaN(x)) return "n/a";
  return `$${Number(x).toFixed(2)}`;
}

function fmtNum(x, nd=2){
  if (x === null || x === undefined || Number.isNaN(x)) return "n/a";
  return Number(x).toFixed(nd);
}

// Force NYC timezone (so it matches TLC reality)
function formatTimeLabel(iso){
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit"
  });
}

// -------------------
// Map init
// -------------------
const map = L.map("map", { zoomControl: true }).setView([40.72, -73.98], 12);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap &copy; CARTO"
}).addTo(map);

// Panes so polygons never hide markers
map.createPane("polys");
map.getPane("polys").style.zIndex = 400;

map.createPane("markers");
map.getPane("markers").style.zIndex = 650;

// Layers
const polyLayer = L.geoJSON(null, {
  pane: "polys",
  style: (f) => {
    const s = f?.properties?.style;
    if (!s) return { color: "#555", weight: 1, fillOpacity: 0.4 };
    // Leaflet doesn't like dashArray:null
    const style = { ...s };
    if (style.dashArray === null) delete style.dashArray;
    return style;
  },
  onEachFeature: (feature, layer) => {
    const p = feature.properties || {};
    if (p.popup) layer.bindPopup(p.popup, { maxWidth: 360 });
  }
}).addTo(map);

const markerLayer = L.layerGroup([], { pane: "markers" }).addTo(map);

// -------------------
// Data structures
// payload = { timeline: [iso...], frames: [ {time, polygons, markers}, ... ] }
// -------------------
let timeline = [];
let dataByTime = new Map();

function setStatus(msg){
  document.getElementById("timeLabel").textContent = msg;
}

function rebuildAtIndex(idx){
  if (!timeline.length) return;

  const key = timeline[idx];
  const bundle = dataByTime.get(key);
  if (!bundle) return;

  setStatus(formatTimeLabel(key));

  polyLayer.clearLayers();
  markerLayer.clearLayers();

  // Polygons
  if (bundle.polygons) {
    polyLayer.addData(bundle.polygons);
  }

  // Markers (dynamic per frame)
  const markers = bundle.markers || [];
  for (const m of markers){
    const tag = m.tag; // GOOD / BAD
    const iconHtml = tag === "GOOD"
      ? '<div style="font-weight:900; color:#00b050; font-size:18px; line-height:18px;">✔</div>'
      : '<div style="font-weight:900; color:#e60000; font-size:18px; line-height:18px;">✖</div>';

    const icon = L.divIcon({
      html: iconHtml,
      className: "",
      iconSize: [18,18],
      iconAnchor: [9,9]
    });

    const marker = L.marker([m.lat, m.lng], { icon, pane: "markers" });

    const popup = `
      <div style="font-family:Arial; font-size:13px;">
        <div style="font-weight:900; font-size:14px;">${m.zone}</div>
        <div style="color:#666; margin-bottom:4px;">${m.borough} — <b>${m.tag}</b></div>
        <div><b>Rating:</b> <span style="font-weight:900; color:${m.color};">${m.rating}/100</span></div>
        <hr style="margin:6px 0;">
        <div><b>Pickups:</b> ${m.pickups}</div>
        <div><b>Avg driver pay:</b> ${fmtMoney(m.avg_driver_pay)}</div>
        <div><b>Avg tips:</b> ${fmtMoney(m.avg_tips)}</div>
      </div>
    `;

    marker.bindPopup(popup, { maxWidth: 360 });
    marker.addTo(markerLayer);
  }
}

async function fetchJsonOrThrow(url){
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok){
    const txt = await res.text().catch(() => "");
    throw new Error(`Load failed (${res.status}). ${txt || "No response body"}`);
  }
  return await res.json();
}

async function main(){
  setStatus("Loading data...");

  const payload = await fetchJsonOrThrow(DATA_URL);

  timeline = payload.timeline || [];
  const frames = payload.frames || [];

  dataByTime = new Map(frames.map(f => [f.time, f]));

  const slider = document.getElementById("slider");
  slider.min = 0;
  slider.max = Math.max(0, timeline.length - 1);
  slider.step = 1;
  slider.value = 0;

  // Throttled slider for iPhone smoothness
  let pending = null;
  slider.addEventListener("input", () => {
    pending = Number(slider.value);
    if (slider._raf) return;
    slider._raf = requestAnimationFrame(() => {
      slider._raf = null;
      if (pending !== null) rebuildAtIndex(pending);
    });
  });

  if (timeline.length > 0){
    rebuildAtIndex(0);
  } else {
    setStatus("No data in hotspots_20min.json");
  }
}

main().catch(err => {
  console.error(err);
  setStatus("ERROR: " + err.message);
});
