// =======================
// TLC Hotspot Map - app.js (Phone-first)
// - Loads data from Railway (no GitHub 25MB limit)
// - Fixes confusing icon vs color meaning
// - Declutters markers (less overlap)
// - NYC time labels
// - Clear legend
// =======================

// IMPORTANT: put your Railway domain here (no trailing slash)
const API_BASE = "https://web-production-78f67.up.railway.app";

// ---- helpers ----
function fmtMoney(x){
  if (x === null || x === undefined || Number.isNaN(x)) return "n/a";
  return `$${Number(x).toFixed(2)}`;
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

// Rating -> color meaning (CLEAR)
// Purple = elite, Green = good, Yellow = ok, Red = bad
function ratingToColors(r){
  const x = Number(r || 0);
  if (x >= 90) return { fill:"#7a2cff", border:"#5b19cc" };   // purple elite
  if (x >= 70) return { fill:"#00b050", border:"#007a38" };   // green good
  if (x >= 50) return { fill:"#ffd700", border:"#b59b00" };   // yellow ok
  return { fill:"#e60000", border:"#990000" };                // red bad
}

// Icon should match meaning (NO contradictions)
function ratingToIconType(r){
  const x = Number(r || 0);
  if (x >= 70) return "GOOD";  // check only for good zones
  if (x <= 49) return "BAD";   // X only for bad zones
  return "NONE";               // no icon for mid zones (reduces clutter)
}

// ---- map ----
const map = L.map("map", { zoomControl: true }).setView([40.72, -73.98], 12);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap &copy; CARTO",
}).addTo(map);

// PANES (polygons never cover markers)
map.createPane("polys");
map.getPane("polys").style.zIndex = 400;

map.createPane("markers");
map.getPane("markers").style.zIndex = 650;

// Layers
const polyLayer = L.geoJSON(null, {
  pane: "polys",
  style: (feature) => {
    const p = feature?.properties || {};
    // our JSON can store rating in different property names; support several
    const rating = p.rating ?? p.rating_1_100 ?? p.rating_window ?? null;
    const c = ratingToColors(rating);
    return { color: c.border, weight: 2, fillColor: c.fill, fillOpacity: 0.38 };
  },
  onEachFeature: (feature, layer) => {
    const p = feature.properties || {};
    if (p.popup) layer.bindPopup(p.popup, { maxWidth: 360 });
  },
}).addTo(map);

const markerLayer = L.layerGroup().addTo(map);

let timeline = [];
let dataByTime = new Map();

function setStatus(msg){
  const el = document.getElementById("timeLabel");
  if (el) el.textContent = msg;
}

function showError(msg){
  console.error(msg);
  setStatus("ERROR: " + msg);
}

// Declutter markers: only show at zoom >= 13 and spaced out
function renderMarkersDecluttered(markers){
  markerLayer.clearLayers();

  const zoom = map.getZoom();
  const MIN_ZOOM = 13;
  if (zoom < MIN_ZOOM) return;

  const placed = [];
  const MIN_PX = 26;

  // show highest ratings first (so good zones win when crowded)
  const sorted = [...(markers || [])].sort((a,b) => Number(b.rating||0) - Number(a.rating||0));

  for (const m of sorted){
    if (!m || m.lat == null || m.lng == null) continue;

    const iconType = ratingToIconType(m.rating);
    if (iconType === "NONE") continue;

    const pt = map.latLngToContainerPoint([m.lat, m.lng]);
    let ok = true;
    for (const q of placed){
      const dx = pt.x - q.x;
      const dy = pt.y - q.y;
      if (dx*dx + dy*dy < MIN_PX*MIN_PX){ ok = false; break; }
    }
    if (!ok) continue;
    placed.push(pt);

    const iconHtml = (iconType === "GOOD")
      ? '<div style="font-weight:900; color:#00b050; font-size:16px; line-height:16px;">✔</div>'
      : '<div style="font-weight:900; color:#e60000; font-size:16px; line-height:16px;">✖</div>';

    const icon = L.divIcon({
      html: iconHtml,
      className: "",
      iconSize: [16,16],
      iconAnchor: [8,8],
    });

    const popup = `
      <div style="font-family:Arial; font-size:13px;">
        <div style="font-weight:900; font-size:14px;">${m.zone || "Zone"}</div>
        <div style="color:#666; margin-bottom:4px;">${m.borough || "Unknown"}</div>
        <div><b>Rating:</b> <span style="font-weight:900;">${Number(m.rating||0)}/100</span></div>
        <hr style="margin:6px 0;">
        <div><b>Pickups:</b> ${m.pickups ?? "n/a"}</div>
        <div><b>Avg driver pay:</b> ${fmtMoney(m.avg_driver_pay)}</div>
        <div><b>Avg tips:</b> ${fmtMoney(m.avg_tips)}</div>
      </div>
    `;

    L.marker([m.lat, m.lng], { icon, pane:"markers" })
      .bindPopup(popup, { maxWidth: 360 })
      .addTo(markerLayer);
  }
}

function rebuildAtIndex(idx){
  const key = timeline[idx];
  const bundle = dataByTime.get(key);
  if (!bundle) return;

  setStatus(formatTimeLabel(key));

  polyLayer.clearLayers();
  if (bundle.polygons) polyLayer.addData(bundle.polygons);

  renderMarkersDecluttered(bundle.markers || []);
}

// Fetch JSON with good phone debugging
async function fetchJson(url){
  const res = await fetch(url, { cache: "no-store" });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} :: ${text.slice(0,200)}`);
  try { return JSON.parse(text); }
  catch { throw new Error(`Bad JSON :: ${text.slice(0,200)}`); }
}

// Try /download first, fallback /hotspots
async function loadHotspotsFromRailway(){
  // quick status check so errors are obvious
  await fetchJson(`${API_BASE}/status`);

  try {
    return await fetchJson(`${API_BASE}/download`);
  } catch (e1) {
    // fallback
    return await fetchJson(`${API_BASE}/hotspots`);
  }
}

function injectLegend(){
  const legend = document.getElementById("legend");
  if (!legend) return;

  legend.innerHTML = `
    <div style="
      position: fixed; top: 18px; left: 18px; width: 420px; z-index: 9999;
      background: rgba(255,255,255,0.97); padding: 12px;
      border: 2px solid #111; border-radius: 10px;
      font-family: Arial; font-size: 14px; box-shadow: 0 2px 10px rgba(0,0,0,0.25);
    ">
      <div style="font-weight:900; margin-bottom:8px; font-size:15px;">
        NYC HVFHV Pickup Zones (1–100)
      </div>

      <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:8px;">
        <div><span style="display:inline-block;width:14px;height:14px;background:#7a2cff;border:2px solid #5b19cc;"></span> 90–100 Elite (purple)</div>
        <div><span style="display:inline-block;width:14px;height:14px;background:#00b050;border:2px solid #007a38;"></span> 70–89 Good (green)</div>
        <div><span style="display:inline-block;width:14px;height:14px;background:#ffd700;border:2px solid #b59b00;"></span> 50–69 OK (yellow)</div>
        <div><span style="display:inline-block;width:14px;height:14px;background:#e60000;border:2px solid #990000;"></span> 1–49 Bad (red)</div>
      </div>

      <div style="display:flex; gap:14px; align-items:center; margin-bottom:6px;">
        <div><span style="color:#00b050; font-weight:900;">✔</span> Icon = GOOD zone only</div>
        <div><span style="color:#e60000; font-weight:900;">✖</span> Icon = BAD zone only</div>
      </div>

      <div style="margin-top:8px; color:#444; font-size:12px; line-height:1.35;">
        • Slider = 20-minute windows (NYC time).<br/>
        • Icons show only at zoom 13+ to reduce clutter.<br/>
        • Click a polygon or icon for details.
      </div>
    </div>
  `;
}

async function main(){
  injectLegend();
  setStatus("Loading hotspots…");

  const payload = await loadHotspotsFromRailway();

  timeline = payload.timeline || [];
  dataByTime = new Map((payload.frames || []).map(f => [f.time, f]));

  const slider = document.getElementById("slider");
  slider.min = 0;
  slider.max = Math.max(0, timeline.length - 1);
  slider.step = 1;
  slider.value = 0;

  // Throttle slider for iPhone
  let pending = null;
  slider.addEventListener("input", () => {
    pending = Number(slider.value);
    if (slider._raf) return;
    slider._raf = requestAnimationFrame(() => {
      slider._raf = null;
      if (pending !== null) rebuildAtIndex(pending);
    });
  });

  // Rerender markers when zoom changes (declutter depends on zoom)
  map.on("zoomend", () => {
    rebuildAtIndex(Number(slider.value || 0));
  });

  if (timeline.length > 0){
    rebuildAtIndex(0);
  } else {
    setStatus("No data in hotspots_20min.json");
  }
}

main().catch(err => showError(err.message));
