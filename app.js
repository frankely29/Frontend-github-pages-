// =======================
// TLC Hotspot Map - app.js (STABLE COLORS + REAL DATA)
// - Polygons use backend style.fillColor (so it never becomes "all red")
// - Icons only show extremes (TOP/BOTTOM) so no mixed signals
// - NYC time label
// - Smooth slider on iPhone
// - Loads JSON from Railway: GET /hotspots
// =======================

function fmtMoney(x){
  if (x === null || x === undefined || Number.isNaN(x)) return "n/a";
  return `$${Number(x).toFixed(2)}`;
}

function formatTimeLabel(iso){
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday:"short",
    hour:"numeric",
    minute:"2-digit"
  });
}

const map = L.map("map", { zoomControl:true }).setView([40.72, -73.98], 12);
L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap &copy; CARTO"
}).addTo(map);

// panes (markers always above)
map.createPane("polys");
map.getPane("polys").style.zIndex = 400;
map.createPane("markers");
map.getPane("markers").style.zIndex = 650;

const polyLayer = L.geoJSON(null, {
  pane: "polys",
  style: (feature) => {
    const p = feature?.properties || {};
    // ✅ Use backend style (critical)
    if (p.style && typeof p.style === "object") return p.style;
    return { color:"#555", weight:1, fillColor:"#ffd700", fillOpacity:0.4 };
  },
  onEachFeature: (feature, layer) => {
    const p = feature.properties || {};
    if (p.popup) layer.bindPopup(p.popup, { maxWidth: 360 });
  }
}).addTo(map);

const markerLayer = L.layerGroup().addTo(map);

let timeline = [];
let dataByTime = new Map();

function makeIcon(tag){
  const isGood = (tag === "GOOD" || tag === "TOP");
  const html = isGood
    ? `<div style="width:26px;height:26px;border-radius:13px;background:#fff;border:2px solid #00b050;display:flex;align-items:center;justify-content:center;font-weight:900;color:#00b050;font-size:18px;">✓</div>`
    : `<div style="width:26px;height:26px;border-radius:13px;background:#fff;border:2px solid #e60000;display:flex;align-items:center;justify-content:center;font-weight:900;color:#e60000;font-size:18px;">×</div>`;
  return L.divIcon({ html, className:"", iconSize:[26,26], iconAnchor:[13,13] });
}

function rebuildAtIndex(idx){
  const key = timeline[idx];
  const bundle = dataByTime.get(key);
  if (!bundle) return;

  document.getElementById("timeLabel").textContent = formatTimeLabel(key);

  polyLayer.clearLayers();
  markerLayer.clearLayers();

  if (bundle.polygons) polyLayer.addData(bundle.polygons);

  for (const m of (bundle.markers || [])){
    const marker = L.marker([m.lat, m.lng], { icon: makeIcon(m.tag), pane:"markers" });

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

async function fetchHotspots(){
  const base = (window.RAILWAY_BASE_URL || "").trim().replace(/\/+$/,"");
  if (!base) throw new Error("Missing window.RAILWAY_BASE_URL in index.html");

  const r = await fetch(`${base}/hotspots`, { cache:"no-store" });
  if (!r.ok){
    const t = await r.text().catch(()=> "");
    throw new Error(`Failed to fetch hotspots (${r.status}). ${t}`);
  }
  return await r.json();
}

async function main(){
  document.getElementById("timeLabel").textContent = "Loading…";

  const payload = await fetchHotspots();

  timeline = payload.timeline || [];
  dataByTime = new Map((payload.frames || []).map(f => [f.time, f]));

  const slider = document.getElementById("slider");
  slider.min = 0;
  slider.max = Math.max(0, timeline.length - 1);
  slider.step = 1;
  slider.value = 0;

  // iPhone smooth slider
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
    document.getElementById("timeLabel").textContent = "No timeline returned";
  }
}

main().catch(err => {
  console.error(err);
  document.getElementById("timeLabel").textContent = "ERROR: " + err.message;
});