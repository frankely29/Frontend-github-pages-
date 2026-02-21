// =======================
// TLC Hotspot Map - app.js
// System #2 (Correct):
// GitHub Pages loads data from Railway ONLY.
// Colors are computed here from feature.properties.rating (1–100).
// =======================

function clamp(x, a, b){ return Math.max(a, Math.min(b, x)); }

function nycLabelFromISO(iso){
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit"
  });
}

// Strict mandatory color rules (DISCRETE buckets)
// Green = Best, Blue = Medium, Sky = Normal, Red = Avoid
function ratingToFill(rating){
  const r = Number(rating);
  if (!Number.isFinite(r)) return "#bdbdbd"; // fallback gray if missing
  const x = clamp(r, 1, 100);

  // You can adjust these thresholds later, but keep 4 colors as requested.
  if (x >= 76) return "#18a84a"; // Green
  if (x >= 51) return "#1f57ff"; // Blue
  if (x >= 26) return "#64c8ff"; // Sky
  return "#e53935";              // Red
}

function setError(msg){
  const el = document.getElementById("errorLine");
  el.textContent = msg || "";
}

const map = L.map("map", { zoomControl: true }).setView([40.72, -73.98], 12);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap &copy; CARTO"
}).addTo(map);

// Keep polygons under any future markers (even though we removed icons)
map.createPane("polys");
map.getPane("polys").style.zIndex = 400;

const polyLayer = L.geoJSON(null, {
  pane: "polys",
  style: (feature) => {
    const p = feature && feature.properties ? feature.properties : {};
    const fill = ratingToFill(p.rating);

    // No heavy outlines (you asked to remove perimeter outlines)
    // Use a very light border only so zones still separable.
    return {
      color: "rgba(0,0,0,0.08)", // subtle border
      weight: 1,
      fillColor: fill,
      fillOpacity: 0.55
    };
  },
  onEachFeature: (feature, layer) => {
    const p = feature && feature.properties ? feature.properties : {};
    const rating = (p.rating !== undefined) ? p.rating : "n/a";
    const zone = p.zone || p.zone_name || p.name || "Zone";
    const borough = p.borough || "";

    const popup = `
      <div style="font-family:Arial; font-size:13px;">
        <div style="font-weight:900; font-size:14px;">${zone}</div>
        <div style="color:#666; margin-bottom:6px;">${borough}</div>
        <div><b>Rating:</b> ${rating}/100</div>
      </div>
    `;
    layer.bindPopup(popup, { maxWidth: 320 });
  }
}).addTo(map);

let timeline = [];
let framesByTime = new Map();

function rebuildAtIndex(idx){
  const key = timeline[idx];
  const frame = framesByTime.get(key);
  if (!frame) return;

  document.getElementById("timeLabel").textContent = nycLabelFromISO(key);

  polyLayer.clearLayers();

  // Expect frame.polygons = GeoJSON FeatureCollection or array
  if (frame.polygons) polyLayer.addData(frame.polygons);
}

// Choose slider start based on closest NYC "now"
function pickClosestIndexToNowNYC(){
  if (!timeline.length) return 0;

  const now = new Date();
  const nowMs = now.getTime();

  // timeline entries are ISO strings; we pick the closest absolute time
  let bestIdx = 0;
  let bestDiff = Infinity;

  for (let i = 0; i < timeline.length; i++){
    const tMs = new Date(timeline[i]).getTime();
    const diff = Math.abs(tMs - nowMs);
    if (diff < bestDiff){
      bestDiff = diff;
      bestIdx = i;
    }
  }
  return bestIdx;
}

async function fetchRailwayJSON(){
  const base = (window.RAILWAY_BASE_URL || "").replace(/\/+$/, "");
  if (!base) throw new Error("Missing window.RAILWAY_BASE_URL in index.html");

  // Primary: /download (your FastAPI endpoint)
  const url = `${base}/download`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok){
    // show server body for debugging (helps when you see 404/400)
    let body = "";
    try { body = await res.text(); } catch {}
    throw new Error(`Railway fetch failed (${res.status}). ${body}`.slice(0, 300));
  }
  return await res.json();
}

async function main(){
  setError("");

  document.getElementById("tzLabel").textContent = "NYC time";

  const payload = await fetchRailwayJSON();

  timeline = payload.timeline || [];
  framesByTime = new Map((payload.frames || []).map(f => [f.time, f]));

  const slider = document.getElementById("slider");
  slider.min = 0;
  slider.max = Math.max(0, timeline.length - 1);
  slider.step = 1;

  const startIdx = pickClosestIndexToNowNYC();
  slider.value = String(startIdx);

  // Smooth slider on iPhone
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
    rebuildAtIndex(startIdx);
  } else {
    document.getElementById("timeLabel").textContent = "No timeline in Railway data";
    setError("ERROR: No timeline returned. Run /generate on Railway first.");
  }
}

main().catch(err => {
  console.error(err);
  document.getElementById("timeLabel").textContent = "Load failed";
  setError("ERROR: " + (err && err.message ? err.message : String(err)));
});