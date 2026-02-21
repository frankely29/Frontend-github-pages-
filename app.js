// =======================
// TLC Hotspot Map - app.js
// - Loads hotspots from Railway (/download)
// - NYC timezone labels
// - NO checkmarks / NO X markers
// - 4-color rule: Green(best), Blue(medium), Sky(normal), Red(avoid)
// - If not generated, you can press Generate (calls /generate)
// =======================

const RAILWAY = (window.RAILWAY_BASE_URL || "").trim();

function setStatus(ok, msg){
  const el = document.getElementById("statusLine");
  el.textContent = msg;
  el.classList.toggle("ok", !!ok);
  el.classList.toggle("bad", !ok);
}

function setError(msg){
  const err = document.getElementById("errText");
  err.textContent = msg || "";
}

function fmtNYCTime(iso){
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit"
  });
}

// Your color rules (discrete buckets)
function ratingToFill(r){
  const x = Number(r);
  if (!Number.isFinite(x)) return "#7dd3fc";      // fallback = Normal (sky)
  if (x >= 75) return "#1db954";                 // Best (green)
  if (x >= 55) return "#1f6feb";                 // Medium (blue)
  if (x >= 35) return "#7dd3fc";                 // Normal (sky)
  return "#ef4444";                              // Avoid (red)
}

function getRatingFromFeature(feature){
  const p = feature && feature.properties ? feature.properties : {};
  // support multiple possible keys
  return (
    p.rating ??
    p.rating_1_100 ??
    p.rating1_100 ??
    (p.meta && p.meta.rating) ??
    (p.style && p.style.rating) ??
    null
  );
}

// Leaflet init
const map = L.map("map", { zoomControl: true }).setView([40.72, -73.98], 12);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap &copy; CARTO"
}).addTo(map);

// Pane so polygons are under UI (and consistent)
map.createPane("polys");
map.getPane("polys").style.zIndex = 350;

const polyLayer = L.geoJSON(null, {
  pane: "polys",
  style: (feature) => {
    const p = feature?.properties || {};
    const rating = getRatingFromFeature(feature);
    const fill = ratingToFill(rating);

    // border a bit darker for readability
    const border =
      fill === "#1db954" ? "#137a37" :
      fill === "#1f6feb" ? "#174ea6" :
      fill === "#7dd3fc" ? "#2b9fd6" :
      "#991b1b";

    return {
      color: border,
      weight: 2,
      fillColor: fill,
      fillOpacity: 0.55
    };
  },
  onEachFeature: (feature, layer) => {
    const p = feature?.properties || {};
    const rating = getRatingFromFeature(feature);

    // Optional popup (simple + useful)
    const zone = p.zone || p.Zone || p.name || p.LocationID || "Zone";
    const borough = p.borough || p.Borough || "";
    const pickups = p.pickups ?? p.Pickups ?? null;

    const html = `
      <div style="font-family:Arial; font-size:13px;">
        <div style="font-weight:900; font-size:14px;">${zone}${borough ? " — " + borough : ""}</div>
        <div><b>Rating:</b> ${rating ?? "n/a"} / 100</div>
        ${pickups !== null ? `<div><b>Pickups:</b> ${pickups}</div>` : ""}
      </div>
    `;
    layer.bindPopup(html, { maxWidth: 320 });
  }
}).addTo(map);

let timeline = [];
let framesByTime = new Map();

function clearMap(){
  polyLayer.clearLayers();
}

function drawAtIndex(idx){
  const t = timeline[idx];
  const frame = framesByTime.get(t);
  if (!frame) return;

  document.getElementById("timeLabel").textContent = fmtNYCTime(t);
  clearMap();

  // Expect frame.polygons to be a GeoJSON FeatureCollection or array of features
  if (frame.polygons){
    polyLayer.addData(frame.polygons);
  } else if (frame.features){
    polyLayer.addData({ type: "FeatureCollection", features: frame.features });
  }
}

// Fetch hotspots json from Railway
async function fetchHotspots(){
  if (!RAILWAY){
    throw new Error('Missing window.RAILWAY_BASE_URL in index.html');
  }

  // Always use /download (your FastAPI already has it)
  const url = `${RAILWAY.replace(/\/+$/,"")}/download?ts=${Date.now()}`;

  const res = await fetch(url, { cache: "no-store", mode: "cors" });

  if (!res.ok){
    // Common case: not generated yet
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to fetch hotspots (${res.status}). ${text}`);
  }

  return await res.json();
}

// Call /generate on Railway, then reload /download
async function generateOnRailway(){
  if (!RAILWAY){
    setError("Missing Railway URL in index.html");
    return;
  }
  setError("");
  setStatus(true, "Generating on Railway…");

  const genUrl = `${RAILWAY.replace(/\/+$/,"")}/generate?bin_minutes=20&good_n=200&bad_n=120&win_good_n=80&win_bad_n=40&min_trips_per_window=10&simplify_meters=25`;

  const res = await fetch(genUrl, {
    method: "POST",
    headers: { "accept": "application/json" },
    mode: "cors"
  });

  if (!res.ok){
    const txt = await res.text().catch(()=> "");
    setStatus(false, "Generate failed");
    setError(`Generate failed (${res.status}): ${txt}`);
    return;
  }

  const data = await res.json().catch(()=> ({}));
  setStatus(true, `Generated ✓ (${data.size_mb ? data.size_mb.toFixed(2) : "?"} MB). Loading…`);

  // Now reload hotspots
  await loadAndRender();
}

async function loadAndRender(){
  setError("");
  setStatus(true, "Loading from Railway…");

  const payload = await fetchHotspots();

  timeline = payload.timeline || [];
  const frames = payload.frames || [];
  framesByTime = new Map(frames.map(f => [f.time, f]));

  const slider = document.getElementById("slider");
  slider.min = 0;
  slider.max = Math.max(0, timeline.length - 1);
  slider.step = 1;
  slider.value = 0;

  // Smooth slider on iPhone (throttled)
  let pending = null;
  slider.addEventListener("input", () => {
    pending = Number(slider.value);
    if (slider._raf) return;
    slider._raf = requestAnimationFrame(() => {
      slider._raf = null;
      if (pending !== null) drawAtIndex(pending);
    });
  }, { passive: true });

  if (timeline.length === 0){
    setStatus(false, "No timeline returned from Railway.");
    document.getElementById("timeLabel").textContent = "No data";
    clearMap();
    return;
  }

  drawAtIndex(0);
  setStatus(true, `Loaded ${timeline.length} steps ✓`);
}

function setupUI(){
  const btn = document.getElementById("genBtn");
  btn.addEventListener("click", () => generateOnRailway());

  const toggleBtn = document.getElementById("toggleBtn");
  const panelBody = document.getElementById("panelBody");

  toggleBtn.addEventListener("click", () => {
    const hidden = panelBody.classList.toggle("hidden");
    toggleBtn.textContent = hidden ? "Max" : "Min";
  });
}

(async function main(){
  setupUI();

  try{
    await loadAndRender();
  } catch (e){
    console.error(e);
    setStatus(false, "Load failed ✗");
    setError(String(e.message || e));
    document.getElementById("timeLabel").textContent = "Load failed";
    clearMap();
  }
})();