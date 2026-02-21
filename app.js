// =======================
// TLC Hotspot Map - app.js (GitHub Pages)
// - Fetches data from Railway (/hotspots)
// - Phone-friendly
// - Clear meaning:
//    * Polygon color = rating (Red->Yellow->Green)
//    * Icons only for extreme zones (✅ very good, ✖ very low)
//    * Purple pulse dot = "activity intensity" (higher rating => stronger purple)
// - NYC timezone labels
// =======================

function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function lerp(a,b,t){ return a + (b-a)*t; }

function scoreToColorHex(score01){
  const s = clamp01(score01);
  let r,g,b;
  if (s <= 0.5){
    const t = s/0.5;
    r = Math.round(lerp(230,255,t));
    g = Math.round(lerp(0,215,t));
    b = 0;
  } else {
    const t = (s-0.5)/0.5;
    r = Math.round(lerp(255,0,t));
    g = Math.round(lerp(215,176,t));
    b = Math.round(lerp(0,80,t));
  }
  const toHex = (n)=>n.toString(16).padStart(2,'0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function fmtMoney(x){
  if (x === null || x === undefined || Number.isNaN(x)) return "n/a";
  return `$${Number(x).toFixed(2)}`;
}

// Force NYC timezone so labels match NYC time
function formatTimeLabel(iso){
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday:"short",
    hour:"numeric",
    minute:"2-digit"
  });
}

// --- Choose Railway base URL ---
// You can override by adding: ?api=https://yourapp.up.railway.app
function getApiBase(){
  const u = new URL(window.location.href);
  const qp = u.searchParams.get("api");
  if (qp) return qp.replace(/\/+$/,"");
  // default (your current Railway)
  return "https://web-production-78f67.up.railway.app";
}

const API_BASE = getApiBase();

const map = L.map('map', { zoomControl: true }).setView([40.72, -73.98], 12);
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap &copy; CARTO'
}).addTo(map);

// Panes so polygons never cover icons
map.createPane("polys");
map.getPane("polys").style.zIndex = 400;

map.createPane("pulses");
map.getPane("pulses").style.zIndex = 520;

map.createPane("markers");
map.getPane("markers").style.zIndex = 650;

// Layers
const polyLayer = L.geoJSON(null, {
  pane: "polys",
  style: (f) => {
    const p = f?.properties || {};

    // Prefer server-provided style if present
    if (p.style) return p.style;

    // Otherwise compute from rating/score
    let rating = p.rating ?? p.rating_1_100;
    let score01 = p.score01;
    if (rating !== undefined && rating !== null) score01 = (Number(rating) - 1) / 99;

    const fill = scoreToColorHex(score01 ?? 0);
    return {
      color: "#222", weight: 1,
      fillColor: fill, fillOpacity: 0.55
    };
  },
  onEachFeature: (feature, layer) => {
    const p = feature.properties || {};
    if (p.popup) layer.bindPopup(p.popup, { maxWidth: 360 });
  }
}).addTo(map);

const pulseLayer = L.layerGroup([], { pane: "pulses" }).addTo(map);
const markerLayer = L.layerGroup([], { pane: "markers" }).addTo(map);

let timeline = [];
let dataByTime = new Map();

function makeIcon(html){
  return L.divIcon({
    html,
    className: "",
    iconSize: [26,26],
    iconAnchor: [13,13]
  });
}

function rebuildAtIndex(idx){
  const key = timeline[idx];
  const bundle = dataByTime.get(key);
  if (!bundle) return;

  document.getElementById("timeLabel").textContent = formatTimeLabel(key);

  polyLayer.clearLayers();
  pulseLayer.clearLayers();
  markerLayer.clearLayers();

  if (bundle.polygons) polyLayer.addData(bundle.polygons);

  // Markers: only extremes to avoid confusion + overlap
  // ✅ if rating >= 90, ✖ if rating <= 10
  const markers = (bundle.markers || []);
  for (const m of markers){
    const rating = Number(m.rating ?? 0);

    let show = false;
    let icon = null;

    if (rating >= 90){
      show = true;
      icon = makeIcon(
        `<div style="
          width:26px;height:26px;border-radius:13px;
          background:rgba(255,255,255,0.92);
          border:2px solid #00b050;
          display:flex;align-items:center;justify-content:center;
          font-weight:900;color:#00b050;font-size:16px;
        ">✔</div>`
      );
    } else if (rating <= 10){
      show = true;
      icon = makeIcon(
        `<div style="
          width:26px;height:26px;border-radius:13px;
          background:rgba(255,255,255,0.92);
          border:2px solid #e60000;
          display:flex;align-items:center;justify-content:center;
          font-weight:900;color:#e60000;font-size:16px;
        ">✖</div>`
      );
    }

    if (!show) continue;

    const marker = L.marker([m.lat, m.lng], { icon, pane: "markers" });

    const popup = `
      <div style="font-family:Arial; font-size:13px;">
        <div style="font-weight:900; font-size:14px;">${m.zone}</div>
        <div style="color:#666; margin-bottom:4px;">${m.borough}</div>
        <div><b>Rating:</b> <span style="font-weight:900;">${rating}/100</span></div>
        <hr style="margin:6px 0;">
        <div><b>Pickups:</b> ${m.pickups}</div>
        <div><b>Avg driver pay:</b> ${fmtMoney(m.avg_driver_pay)}</div>
        <div><b>Avg tips:</b> ${fmtMoney(m.avg_tips)}</div>
      </div>
    `;
    marker.bindPopup(popup, { maxWidth: 360 });
    marker.addTo(markerLayer);
  }

  // Purple pulse dots (gives “inside zone intensity” feel without true intra-zone heatmap)
  // stronger rating => stronger purple/size
  for (const m of markers){
    const rating = Number(m.rating ?? 0);
    const t = clamp01((rating - 1) / 99);
    const radius = 6 + 16 * t;
    const opacity = 0.15 + 0.35 * t;

    L.circleMarker([m.lat, m.lng], {
      pane: "pulses",
      radius,
      color: "rgba(128, 0, 255, 0.0)",
      fillColor: "rgba(128, 0, 255, 1.0)",
      fillOpacity: opacity,
      weight: 0
    }).addTo(pulseLayer);
  }
}

async function loadHotspots(){
  // Always load from Railway. (This is why GitHub file-size limits don't matter.)
  const url = `${API_BASE}/hotspots`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok){
    throw new Error(`Load failed (${res.status}). ${await res.text()}`);
  }
  return await res.json();
}

async function main(){
  const payload = await loadHotspots();

  timeline = payload.timeline || [];
  dataByTime = new Map((payload.frames || []).map(f => [f.time, f]));

  const slider = document.getElementById("slider");
  slider.min = 0;
  slider.max = Math.max(0, timeline.length - 1);
  slider.step = 1;
  slider.value = 0;

  // Throttle slider for iPhone smoothness
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
    document.getElementById("timeLabel").textContent = "No frames in hotspots JSON.";
  }
}

main().catch(err => {
  console.error(err);
  document.getElementById("timeLabel").textContent = "ERROR: " + err.message;
});