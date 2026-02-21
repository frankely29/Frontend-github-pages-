// =======================
// TLC Hotspot Map - app.js (Stable Phone Version)
// - Loads from Railway: /timeline + /frame/{idx}
// - Avoids 113MB download on phone
// - NO checkmarks/icons
// - Color rules:
//   Green = best
//   Blue = medium
//   Sky = normal
//   Red = avoid
// =======================

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

// Force NYC timezone labels
function formatTimeLabel(iso){
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit"
  });
}

// Your 4-bucket color rules (by rating 1–100)
function ratingToBucketColor(r){
  const x = clamp(Number(r || 0), 1, 100);
  // tweak thresholds if you want:
  // 1-25  = red (avoid)
  // 26-50 = sky (normal)
  // 51-75 = blue (medium)
  // 76-100= green (best)
  if (x <= 25) return { fill:"#d61f1f", stroke:"#a31212" };      // red
  if (x <= 50) return { fill:"#75c7ff", stroke:"#2f7fb0" };      // sky
  if (x <= 75) return { fill:"#1d63ff", stroke:"#0f3aa0" };      // blue
  return { fill:"#18b85a", stroke:"#0e7a3a" };                   // green
}

function setError(msg){
  const el = document.getElementById("errorLine");
  el.style.display = "block";
  el.textContent = msg;
}

function clearError(){
  const el = document.getElementById("errorLine");
  el.style.display = "none";
  el.textContent = "";
}

const BASE = (window.RAILWAY_BASE_URL || "").replace(/\/+$/, "");
if (!BASE) {
  setError("Missing window.RAILWAY_BASE_URL in index.html");
  throw new Error("Missing window.RAILWAY_BASE_URL");
}

// Map init
const map = L.map("map", { zoomControl: true }).setView([40.72, -73.98], 12);
L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap &copy; CARTO"
}).addTo(map);

// Pane so polygons always render cleanly
map.createPane("polys");
map.getPane("polys").style.zIndex = 400;

const polyLayer = L.geoJSON(null, {
  pane: "polys",
  style: (feature) => {
    const p = feature?.properties || {};
    // Prefer rating if present, otherwise fall back to old fillColor if your data already has it
    const rating = p.rating ?? p.rating_1_100 ?? p.score ?? null;

    if (rating !== null && rating !== undefined) {
      const c = ratingToBucketColor(rating);
      return {
        color: c.stroke,
        weight: 2,
        fillColor: c.fill,
        fillOpacity: 0.45
      };
    }

    // Fallback (in case your frame still has "style")
    if (p.style && p.style.fillColor) {
      return {
        color: p.style.color || "#333",
        weight: p.style.weight || 2,
        fillColor: p.style.fillColor,
        fillOpacity: (p.style.fillOpacity ?? 0.45)
      };
    }

    return { color:"#333", weight:2, fillColor:"#cccccc", fillOpacity:0.25 };
  },
  onEachFeature: (feature, layer) => {
    const p = feature?.properties || {};
    // If builder gave popup HTML, keep it
    if (p.popup) layer.bindPopup(p.popup, { maxWidth: 360 });

    // Otherwise create a simple popup from rating
    if (!p.popup) {
      const rating = p.rating ?? p.rating_1_100 ?? p.score ?? "n/a";
      layer.bindPopup(`<b>Rating:</b> ${rating}`, { maxWidth: 240 });
    }
  }
}).addTo(map);

let timeline = [];
let frameCache = new Map(); // small cache of recently used frames

async function fetchJson(url){
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const text = await res.text().catch(()=> "");
    throw new Error(`Load failed (${res.status}). ${text || ""}`.trim());
  }
  return res.json();
}

function setStatus(text){
  document.getElementById("loadStatus").textContent = text;
}

function clearLayers(){
  polyLayer.clearLayers();
}

function normalizePolygons(frame){
  // Expected from your generator: frame.polygons is a GeoJSON FeatureCollection
  // But if your frame uses different shape, handle gracefully.
  if (!frame) return null;

  if (frame.polygons && frame.polygons.type === "FeatureCollection") return frame.polygons;
  if (frame.polygons && frame.polygons.features) return { type:"FeatureCollection", features: frame.polygons.features };

  // Sometimes the whole frame is a FeatureCollection already
  if (frame.type === "FeatureCollection" && frame.features) return frame;

  return null;
}

async function loadFrame(idx){
  // small cache to reduce repeated network fetch while sliding
  if (frameCache.has(idx)) return frameCache.get(idx);

  const fr = await fetchJson(`${BASE}/frame/${idx}`);
  frameCache.set(idx, fr);

  // Keep cache small (phone memory)
  if (frameCache.size > 8) {
    const firstKey = frameCache.keys().next().value;
    frameCache.delete(firstKey);
  }

  return fr;
}

function rebuildAtIndex(idx){
  clearLayers();

  const t = timeline[idx];
  document.getElementById("timeLabel").textContent = t ? formatTimeLabel(t) : "—";

  // Load frame async, show status
  setStatus("Loading…");
  clearError();

  loadFrame(idx).then(frame => {
    const polys = normalizePolygons(frame);
    if (!polys) {
      setStatus("Loaded (no polygons)");
      return;
    }
    polyLayer.addData(polys);
    setStatus("Loaded ✓");
  }).catch(err => {
    console.error(err);
    setStatus("Load failed ✖");
    setError(err.message);
  });
}

async function main(){
  setStatus("Loading timeline…");
  clearError();

  const meta = await fetchJson(`${BASE}/timeline`);
  timeline = meta.timeline || [];

  const slider = document.getElementById("slider");
  slider.min = 0;
  slider.max = Math.max(0, timeline.length - 1);
  slider.step = 1;
  slider.value = 0;

  // Throttle slider rendering for iPhone
  let pending = null;
  slider.addEventListener("input", () => {
    pending = Number(slider.value);
    if (slider._raf) return;
    slider._raf = requestAnimationFrame(() => {
      slider._raf = null;
      if (pending !== null) rebuildAtIndex(pending);
    });
  });

  if (timeline.length === 0) {
    setStatus("No timeline (run /generate)");
    document.getElementById("timeLabel").textContent = "No data";
    return;
  }

  // Load first frame
  rebuildAtIndex(0);
}

main().catch(err => {
  console.error(err);
  setStatus("Load failed ✖");
  setError(err.message);
});