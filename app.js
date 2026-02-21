// =======================
// TLC Hotspot Map - app.js
// FIXES:
// 1) Always colors polygons from rating (1–100) — ignores JSON color styles
// 2) No checkmarks / X markers (removed)
// 3) NYC time labels
// 4) Phone friendly + throttled slider
// 5) Reads data from Railway /download
// =======================

function clamp01(x){ return Math.max(0, Math.min(1, x)); }

function fmtNum(x, nd=0){
  if (x === null || x === undefined || Number.isNaN(x)) return "n/a";
  return Number(x).toFixed(nd);
}

// Force NYC timezone
function formatTimeLabel(iso){
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday:"short",
    hour:"numeric",
    minute:"2-digit"
  });
}

// ---- Rating extraction (robust across versions) ----
function getRatingFromFeature(f){
  const p = (f && f.properties) ? f.properties : {};
  // try common keys
  const candidates = [
    p.rating, p.rating_1_100, p.rating_overall_1_100,
    p.r, p.score, p.score01
  ];

  for (const v of candidates){
    if (v === null || v === undefined) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;

    // score01 -> convert to 1..100
    if (n >= 0 && n <= 1) return Math.round(1 + 99 * n);

    // already rating
    if (n >= 1 && n <= 1000) return Math.round(n);
  }

  // if we truly have nothing, return 1 (avoid crashing)
  return 1;
}

// ---- YOUR REQUIRED COLOR RULES ----
// Green = best
// Blue = medium
// Sky blue = normal
// Red = lowest (avoid)
function ratingToColor(rating){
  const r = Math.max(1, Math.min(100, Number(rating)));

  // 1-25 red, 26-50 sky, 51-75 blue, 76-100 green
  if (r <= 25) return "#d73027";     // red
  if (r <= 50) return "#7ec8ff";     // sky blue
  if (r <= 75) return "#1f78ff";     // blue
  return "#2ecc71";                  // green
}

// More “detail”: we vary opacity by rating so greens look stronger than weak greens
function ratingToOpacity(rating){
  const r = Math.max(1, Math.min(100, Number(rating)));
  // 0.20 .. 0.70
  return 0.20 + (r / 100) * 0.50;
}

function showError(msg){
  const el = document.getElementById("errorLine");
  el.style.display = "block";
  el.textContent = msg;
}

function clearError(){
  const el = document.getElementById("errorLine");
  el.style.display = "none";
  el.textContent = "";
}

const map = L.map('map', { zoomControl: true }).setView([40.72, -73.98], 12);
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap &copy; CARTO'
}).addTo(map);

// Put polygons under everything (future-proof)
map.createPane("polys");
map.getPane("polys").style.zIndex = 400;

const polyLayer = L.geoJSON(null, {
  pane: "polys",
  style: (feature) => {
    const rating = getRatingFromFeature(feature);
    const fillColor = ratingToColor(rating);
    const fillOpacity = ratingToOpacity(rating);

    // outline slightly darker, constant thickness
    return {
      color: "#1b1b1b",
      weight: 1,
      fillColor,
      fillOpacity
    };
  },
  onEachFeature: (feature, layer) => {
    const rating = getRatingFromFeature(feature);
    const p = feature.properties || {};
    const zone = p.zone || p.Zone || p.name || p.LocationID || "Zone";
    const borough = p.borough || p.Borough || "";

    // If your JSON already includes popup HTML, use it.
    // Otherwise create a simple popup.
    if (p.popup){
      layer.bindPopup(p.popup, { maxWidth: 360 });
    } else {
      const popup = `
        <div style="font-family:Arial; font-size:13px;">
          <div style="font-weight:900; font-size:14px;">${zone}</div>
          <div style="color:#666; margin-bottom:4px;">${borough}</div>
          <div><b>Rating:</b> ${fmtNum(rating,0)}/100</div>
        </div>
      `;
      layer.bindPopup(popup, { maxWidth: 360 });
    }
  }
}).addTo(map);

let timeline = [];
let dataByTime = new Map();

function rebuildAtIndex(idx){
  const key = timeline[idx];
  const bundle = dataByTime.get(key);
  if (!bundle) return;

  document.getElementById("timeLabel").textContent = formatTimeLabel(key);

  polyLayer.clearLayers();
  if (bundle.polygons) polyLayer.addData(bundle.polygons);
}

async function fetchHotspotsFromRailway(){
  const base = (window.RAILWAY_BASE_URL || "").trim();
  if (!base) throw new Error("Missing window.RAILWAY_BASE_URL in index.html");

  // Railway FastAPI endpoint: /download returns the latest generated hotspots_20min.json
  const url = `${base.replace(/\/+$/,"")}/download`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok){
    // if /download missing, show a clearer message
    throw new Error(`Failed to fetch hotspots (${res.status}). On Railway, run /generate then retry.`);
  }
  return await res.json();
}

async function main(){
  clearError();
  document.getElementById("loadStatus").textContent = "Loading from Railway…";

  const payload = await fetchHotspotsFromRailway();

  timeline = payload.timeline || [];
  dataByTime = new Map((payload.frames || []).map(f => [f.time, f]));

  const slider = document.getElementById("slider");
  slider.min = 0;
  slider.max = Math.max(0, timeline.length - 1);
  slider.step = 1;
  slider.value = 0;

  // Throttle slider on iPhone
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
    document.getElementById("loadStatus").textContent =
      `Loaded ${timeline.length} time steps from Railway ✅`;
  } else {
    document.getElementById("timeLabel").textContent = "No data";
    document.getElementById("loadStatus").textContent = "Loaded, but timeline is empty.";
  }
}

main().catch(err => {
  console.error(err);
  showError("ERROR: " + err.message);
  document.getElementById("loadStatus").textContent = "Load failed ❌";
  document.getElementById("timeLabel").textContent = "Load failed";
});