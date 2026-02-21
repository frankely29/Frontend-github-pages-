// =======================
// TLC Hotspot Map - app.js
// - ALWAYS loads data from Railway
// - Polygons = rating gradient (red->yellow->green)
// - Icons = extremes only (Top ✅, Bottom ❌) per time window
// - No mixed signals (✅ won't appear on low-rated/red zones)
// - Phone-friendly: throttled slider, marker pane above polygons
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

function formatTimeLabel(iso){
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday:"short",
    hour:"numeric",
    minute:"2-digit"
  });
}

function getRailwayBase(){
  return (window.RAILWAY_BASE || "").replace(/\/+$/,"");
}

function showError(msg){
  const el = document.getElementById("errorLine");
  el.style.display = "block";
  el.textContent = "ERROR: " + msg;
  document.getElementById("timeLabel").textContent = "Error";
}

function clearError(){
  const el = document.getElementById("errorLine");
  el.style.display = "none";
  el.textContent = "";
}

function num(x){
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

// Try to read a numeric rating from a polygon feature.
// Supports common schemas.
function getFeatureRating(feature){
  const p = feature?.properties || {};
  // best: explicit numeric rating (1..100)
  if (p.rating != null) return num(p.rating);
  if (p.rating_1_100 != null) return num(p.rating_1_100);

  // sometimes stored as score01 (0..1)
  if (p.score01 != null){
    const s = num(p.score01);
    if (s == null) return null;
    return Math.round(1 + 99 * clamp01(s));
  }

  // sometimes stored inside style or color fields only (no rating available)
  return null;
}

// Force polygon styling from rating so map never turns “all red” due to bad style data.
function styleFromRating(rating){
  // rating: 1..100 -> score01 0..1
  const s = clamp01((rating - 1) / 99);
  const fill = scoreToColorHex(s);
  return {
    color: "#2d7f2d",   // outline (green-ish) to keep borders consistent
    weight: 2,
    fillColor: fill,
    fillOpacity: 0.55
  };
}

// If feature has no rating, keep it neutral (gray)
function neutralStyle(){
  return {
    color: "#666",
    weight: 1,
    fillColor: "#cfcfcf",
    fillOpacity: 0.15
  };
}

// Approx centroid from GeoJSON polygon coordinates (fast and good enough for icons)
function roughCentroid(geom){
  try {
    if (!geom) return null;
    if (geom.type === "Polygon"){
      const ring = geom.coordinates?.[0];
      if (!ring || ring.length < 3) return null;
      let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
      for (const [x,y] of ring){
        if (x<minX) minX=x; if (x>maxX) maxX=x;
        if (y<minY) minY=y; if (y>maxY) maxY=y;
      }
      return [(minY+maxY)/2, (minX+maxX)/2]; // [lat,lng]
    }
    if (geom.type === "MultiPolygon"){
      // use first polygon bbox
      const ring = geom.coordinates?.[0]?.[0];
      if (!ring || ring.length < 3) return null;
      let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
      for (const [x,y] of ring){
        if (x<minX) minX=x; if (x>maxX) maxX=x;
        if (y<minY) minY=y; if (y>maxY) maxY=y;
      }
      return [(minY+maxY)/2, (minX+maxX)/2];
    }
    return null;
  } catch {
    return null;
  }
}

// ---------- Leaflet setup ----------
const map = L.map('map', { zoomControl: true }).setView([40.72, -73.98], 12);
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap &copy; CARTO'
}).addTo(map);

// Panes so markers always above polygons
map.createPane("polys");
map.getPane("polys").style.zIndex = 400;
map.createPane("markers");
map.getPane("markers").style.zIndex = 650;

const polyLayer = L.geoJSON(null, {
  pane: "polys",
  style: (f) => {
    const r = getFeatureRating(f);
    if (r == null) return neutralStyle();
    return styleFromRating(r);
  },
  onEachFeature: (feature, layer) => {
    // If your backend includes popup HTML, keep it. Otherwise just show rating.
    const p = feature?.properties || {};
    const r = getFeatureRating(feature);
    if (p.popup){
      layer.bindPopup(p.popup, { maxWidth: 360 });
    } else if (r != null){
      layer.bindPopup(`<b>Rating:</b> ${r}/100`, { maxWidth: 240 });
    }
  }
}).addTo(map);

const markerLayer = L.layerGroup().addTo(map);

let timeline = [];
let dataByTime = new Map();

// Build extreme icons from polygons ONLY (so no mixed signals)
function buildExtremeMarkersFromPolygons(polygonsFC, topN, botN){
  const feats = polygonsFC?.features || [];
  const scored = [];

  for (const f of feats){
    const r = getFeatureRating(f);
    if (r == null) continue;
    const c = roughCentroid(f.geometry);
    if (!c) continue;
    scored.push({ rating: r, lat: c[0], lng: c[1] });
  }

  scored.sort((a,b)=>b.rating-a.rating);

  const tops = scored.slice(0, Math.max(0, topN));
  const bots = scored.slice(Math.max(0, scored.length - Math.max(0, botN)));

  // Deduplicate overlap (if some zones appear in both due to small lists)
  const key = (m)=>`${m.lat.toFixed(5)},${m.lng.toFixed(5)}`;
  const botSet = new Set(bots.map(key));

  const markers = [];
  for (const m of tops){
    if (m.rating < 60) continue; // safety: only show ✅ on genuinely good zones
    markers.push({ kind: "TOP", ...m });
  }
  for (const m of bots){
    if (m.rating > 40) continue; // safety: only show ❌ on genuinely bad zones
    // if it collides with a top marker location, skip bottom to avoid confusion
    if (botSet.has(key(m)) && markers.some(x=>key(x)===key(m))) continue;
    markers.push({ kind: "BOT", ...m });
  }
  return markers;
}

function rebuildAtIndex(idx){
  const key = timeline[idx];
  const bundle = dataByTime.get(key);
  if (!bundle) return;

  document.getElementById("timeLabel").textContent = formatTimeLabel(key);

  polyLayer.clearLayers();
  markerLayer.clearLayers();

  // Polygons
  if (bundle.polygons){
    polyLayer.addData(bundle.polygons);
  }

  // Icons controls
  const showIcons = document.getElementById("toggleIcons").checked;
  if (!showIcons) return;

  const topN = Math.max(0, Math.min(200, Number(document.getElementById("topN").value || 0)));
  const botN = Math.max(0, Math.min(200, Number(document.getElementById("botN").value || 0)));

  // Preferred: if backend provides clean markers with rating and tag that matches rating.
  // Otherwise: derive from polygons so it never shows ✅ on red zones.
  let markers = null;

  if (Array.isArray(bundle.markers) && bundle.markers.length){
    // Only accept backend markers if they have rating numbers
    const ok = bundle.markers.every(m => Number.isFinite(Number(m.rating)));
    if (ok){
      // Filter into extremes by rating to prevent mixed signals
      const ms = bundle.markers.map(m => ({
        rating: Number(m.rating),
        lat: Number(m.lat),
        lng: Number(m.lng),
        zone: m.zone || "",
        borough: m.borough || ""
      })).filter(m => Number.isFinite(m.lat) && Number.isFinite(m.lng));

      ms.sort((a,b)=>b.rating-a.rating);
      const tops = ms.slice(0, topN).filter(m => m.rating >= 60);
      const bots = ms.slice(Math.max(0, ms.length - botN)).filter(m => m.rating <= 40);

      markers = [
        ...tops.map(m=>({kind:"TOP", ...m})),
        ...bots.map(m=>({kind:"BOT", ...m}))
      ];
    }
  }

  if (!markers){
    markers = buildExtremeMarkersFromPolygons(bundle.polygons, topN, botN);
  }

  for (const m of markers){
    const iconHtml = (m.kind === "TOP")
      ? '<div style="width:28px;height:28px;border-radius:999px;background:#fff;border:3px solid #00b050;display:flex;align-items:center;justify-content:center;font-weight:900;color:#00b050;font-size:16px;line-height:16px;">✓</div>'
      : '<div style="width:28px;height:28px;border-radius:999px;background:#fff;border:3px solid #e60000;display:flex;align-items:center;justify-content:center;font-weight:900;color:#e60000;font-size:16px;line-height:16px;">×</div>';

    const icon = L.divIcon({
      html: iconHtml,
      className: "",
      iconSize: [28,28],
      iconAnchor: [14,14]
    });

    const marker = L.marker([m.lat, m.lng], { icon, pane:"markers" });

    const popup = `
      <div style="font-family:Arial; font-size:13px;">
        <div style="font-weight:900; font-size:14px;">${m.kind === "TOP" ? "Top (Best)" : "Bottom (Worst)"}</div>
        <div><b>Rating:</b> ${m.rating}/100</div>
      </div>
    `;
    marker.bindPopup(popup, { maxWidth: 260 });
    marker.addTo(markerLayer);
  }
}

async function fetchHotspotsFromRailway(){
  const base = getRailwayBase();
  if (!base) throw new Error("Missing window.RAILWAY_BASE in index.html");

  // Primary endpoint
  let res = await fetch(`${base}/hotspots`, { cache: "no-store" });

  // Fallbacks (in case your backend uses different names)
  if (!res.ok) res = await fetch(`${base}/download`, { cache: "no-store" });

  if (!res.ok){
    const txt = await res.text().catch(()=> "");
    throw new Error(`Failed to fetch hotspots (${res.status}). ${txt || "Check Railway /hotspots or /download"}`);
  }
  return await res.json();
}

async function main(){
  clearError();

  // minimize button
  const minBtn = document.getElementById("minBtn");
  const panelBody = document.getElementById("panelBody");
  let minimized = false;
  minBtn.addEventListener("click", () => {
    minimized = !minimized;
    panelBody.style.display = minimized ? "none" : "block";
    minBtn.textContent = minimized ? "Open" : "Min";
  });

  const statusLine = document.getElementById("statusLine");
  statusLine.textContent = "Loading from Railway…";

  const payload = await fetchHotspotsFromRailway();

  timeline = payload.timeline || [];
  dataByTime = new Map((payload.frames || []).map(f => [f.time, f]));

  if (!timeline.length){
    statusLine.textContent = "No timeline data returned by Railway.";
    document.getElementById("timeLabel").textContent = "No data";
    return;
  }

  statusLine.textContent = `Loaded ${timeline.length} steps from Railway ✅`;

  const slider = document.getElementById("slider");
  slider.min = 0;
  slider.max = Math.max(0, timeline.length - 1);
  slider.step = 1;
  slider.value = 0;

  // Throttle slider (smooth iPhone)
  let pending = null;
  slider.addEventListener("input", () => {
    pending = Number(slider.value);
    if (slider._raf) return;
    slider._raf = requestAnimationFrame(() => {
      slider._raf = null;
      if (pending !== null) rebuildAtIndex(pending);
    });
  });

  // Rebuild when icon controls change
  document.getElementById("toggleIcons").addEventListener("change", ()=>rebuildAtIndex(Number(slider.value)));
  document.getElementById("topN").addEventListener("change", ()=>rebuildAtIndex(Number(slider.value)));
  document.getElementById("botN").addEventListener("change", ()=>rebuildAtIndex(Number(slider.value)));

  rebuildAtIndex(0);
}

main().catch(err => {
  console.error(err);
  showError(err.message || String(err));
});