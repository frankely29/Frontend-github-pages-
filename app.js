// =======================
// TLC Hotspot Map - app.js (GitHub Pages)
// Loads hotspots JSON from Railway (NOT GitHub)
// - Colors: rating gradient (red -> yellow -> green) ONLY
// - Icons: extremes ONLY (✔ top, ✖ bottom) so no confusion
// - Phone-friendly slider + panes (markers above polygons)
// =======================

function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function lerp(a,b,t){ return a + (b-a)*t; }

function scoreToColorHex01(score01){
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

// rating 1..100 -> color
function ratingToColor(r){
  const rr = Math.max(1, Math.min(100, Number(r || 1)));
  const s = (rr - 1) / 99; // 0..1
  return scoreToColorHex01(s);
}

function fmtMoney(x){
  if (x === null || x === undefined || Number.isNaN(x)) return "n/a";
  return `$${Number(x).toFixed(2)}`;
}

function fmtNum(x, nd=2){
  if (x === null || x === undefined || Number.isNaN(x)) return "n/a";
  return Number(x).toFixed(nd);
}

// Force NYC timezone for labels
function formatTimeLabel(iso){
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday:"short",
    hour:"numeric",
    minute:"2-digit"
  });
}

// ---- Railway base (set in index.html) ----
const API_BASE = (window.API_BASE || "").replace(/\/+$/,""); // trim trailing /
if (!API_BASE){
  console.warn("API_BASE missing. Set window.API_BASE in index.html");
}

// Map
const map = L.map('map', { zoomControl: true }).setView([40.72, -73.98], 12);
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap &copy; CARTO'
}).addTo(map);

// Panes
map.createPane("polys");
map.getPane("polys").style.zIndex = 400;

map.createPane("markers");
map.getPane("markers").style.zIndex = 650;

// Layers
const polyLayer = L.geoJSON(null, {
  pane: "polys",
  style: (f) => {
    const p = (f && f.properties) ? f.properties : {};
    // We IGNORE server-provided style to prevent “everything red” confusion.
    // We compute style purely from rating (1..100).
    const rating = p.rating ?? p.rating_1_100 ?? p.r ?? 1;
    return {
      color: "#222222",      // neutral border so color = rating only
      weight: 2,
      fillColor: ratingToColor(rating),
      fillOpacity: 0.55
    };
  },
  onEachFeature: (feature, layer) => {
    const p = feature.properties || {};
    // If server provided popup HTML, keep it
    if (p.popup) layer.bindPopup(p.popup, { maxWidth: 360 });
  }
}).addTo(map);

const markerLayer = L.layerGroup().addTo(map);

let timeline = [];
let frames = [];          // array of frames aligned to timeline
let showIcons = true;     // toggle
let topN = 40;            // how many ✔ to show
let bottomN = 40;         // how many ✖ to show

function setStatus(msg){
  document.getElementById("timeLabel").textContent = msg;
}

function iconDiv(html){
  return L.divIcon({ html, className:"", iconSize:[18,18], iconAnchor:[9,9] });
}

function buildIcon(tag){
  if (tag === "TOP"){
    return iconDiv('<div style="font-weight:900; color:#00b050; font-size:18px; line-height:18px;">✔</div>');
  }
  return iconDiv('<div style="font-weight:900; color:#e60000; font-size:18px; line-height:18px;">✖</div>');
}

function getFeatureRating(feature){
  const p = feature.properties || {};
  const r = p.rating ?? p.rating_1_100 ?? p.r;
  return Number(r || 1);
}

function getFeatureCentroidLatLng(feature){
  // crude centroid for polygons in GeoJSON coordinates (lon,lat)
  // good enough for markers (fast, no heavy geo libs in browser)
  try{
    const geom = feature.geometry;
    if (!geom) return null;

    let coords = null;
    if (geom.type === "Polygon"){
      coords = geom.coordinates?.[0];
    } else if (geom.type === "MultiPolygon"){
      coords = geom.coordinates?.[0]?.[0];
    }
    if (!coords || coords.length < 3) return null;

    let minLat=999, maxLat=-999, minLng=999, maxLng=-999;
    for (const [lng, lat] of coords){
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }
    return L.latLng((minLat+maxLat)/2, (minLng+maxLng)/2);
  }catch(e){
    return null;
  }
}

function rebuildAtIndex(idx){
  const frame = frames[idx];
  const key = timeline[idx];
  if (!frame || !key) return;

  setStatus(formatTimeLabel(key));

  polyLayer.clearLayers();
  markerLayer.clearLayers();

  const fc = frame.polygons;
  if (!fc || !fc.features || fc.features.length === 0){
    return;
  }

  polyLayer.addData(fc);

  if (!showIcons) return;

  // Create extremes based on rating of polygons on THIS time window
  const feats = fc.features.slice();
  feats.sort((a,b)=>getFeatureRating(b)-getFeatureRating(a));

  const tops = feats.slice(0, Math.min(topN, feats.length));
  const bottoms = feats.slice(Math.max(0, feats.length - bottomN));

  // Avoid duplicates if small
  const bottomSet = new Set(bottoms.map(f => f.properties?.LocationID ?? f.properties?.location_id ?? JSON.stringify(f.geometry)));
  const topFiltered = tops.filter(f => !bottomSet.has(f.properties?.LocationID ?? f.properties?.location_id ?? JSON.stringify(f.geometry)));

  // Add TOP ✔
  for (const f of topFiltered){
    const ll = getFeatureCentroidLatLng(f);
    if (!ll) continue;
    const r = getFeatureRating(f);
    const p = f.properties || {};
    const zoneName = p.zone || p.Zone || p.name || `Zone ${p.LocationID ?? ""}`;
    const borough = p.borough || p.Borough || "NYC";

    const m = L.marker(ll, { icon: buildIcon("TOP"), pane:"markers" });
    m.bindPopup(`
      <div style="font-family:Arial; font-size:13px;">
        <div style="font-weight:900; font-size:14px;">${zoneName}</div>
        <div style="color:#666; margin-bottom:4px;">${borough} — <b>VERY GOOD (TOP)</b></div>
        <div><b>Rating:</b> <span style="font-weight:900; color:#00b050;">${Math.round(r)}/100</span></div>
      </div>
    `, { maxWidth: 360 });
    m.addTo(markerLayer);
  }

  // Add BOTTOM ✖
  for (const f of bottoms){
    const ll = getFeatureCentroidLatLng(f);
    if (!ll) continue;
    const r = getFeatureRating(f);
    const p = f.properties || {};
    const zoneName = p.zone || p.Zone || p.name || `Zone ${p.LocationID ?? ""}`;
    const borough = p.borough || p.Borough || "NYC";

    const m = L.marker(ll, { icon: buildIcon("BOTTOM"), pane:"markers" });
    m.bindPopup(`
      <div style="font-family:Arial; font-size:13px;">
        <div style="font-weight:900; font-size:14px;">${zoneName}</div>
        <div style="color:#666; margin-bottom:4px;">${borough} — <b>VERY LOW (BOTTOM)</b></div>
        <div><b>Rating:</b> <span style="font-weight:900; color:#e60000;">${Math.round(r)}/100</span></div>
      </div>
    `, { maxWidth: 360 });
    m.addTo(markerLayer);
  }
}

async function loadHotspots(){
  // Always fetch from Railway; GitHub cannot store 113MB
  const url = `${API_BASE}/hotspots_20min.json?ts=${Date.now()}`;
  const res = await fetch(url, { cache:"no-store" });
  if (!res.ok){
    const txt = await res.text().catch(()=> "");
    throw new Error(`Failed to fetch hotspots (${res.status}). ${txt || "Did you run /generate on Railway?"}`);
  }
  return await res.json();
}

async function main(){
  // UI controls
  const iconsToggle = document.getElementById("toggleIcons");
  const topInput = document.getElementById("topN");
  const botInput = document.getElementById("bottomN");

  iconsToggle.addEventListener("change", ()=>{
    showIcons = !!iconsToggle.checked;
    rebuildAtIndex(Number(document.getElementById("slider").value));
  });

  topInput.addEventListener("change", ()=>{
    topN = Math.max(0, Math.min(300, Number(topInput.value || 40)));
    rebuildAtIndex(Number(document.getElementById("slider").value));
  });

  botInput.addEventListener("change", ()=>{
    bottomN = Math.max(0, Math.min(300, Number(botInput.value || 40)));
    rebuildAtIndex(Number(document.getElementById("slider").value));
  });

  setStatus("Loading…");
  const payload = await loadHotspots();

  timeline = payload.timeline || [];
  frames = (payload.frames || []).map(f => ({
    time: f.time,
    polygons: f.polygons
  }));

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