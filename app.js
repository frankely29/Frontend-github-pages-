// =======================
// TLC Hotspot Map - app.js (NO ICONS)
// - Loads data from Railway /download (not GitHub)
// - Colors polygons by rating 1–100 (Gray→Red→Yellow→Green)
// - Clear error messages if anything fails
// - Slider throttled for iPhone
// =======================

function clamp(x, a, b){ return Math.max(a, Math.min(b, x)); }

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

// Continuous “more detailed” gradient with a Gray floor for very low.
// rating 1..100
function ratingToColor(rating){
  const r = Number(rating);
  if (!Number.isFinite(r)) return { fill:"#9b9b9b", op:0.18 };

  const v = clamp(r, 1, 100);

  // 1..12 = gray (very low)
  if (v <= 12){
    return { fill:"#9b9b9b", op:0.18 };
  }

  // 13..100 mapped into red->yellow->green
  const t = (v - 13) / (100 - 13); // 0..1

  let R,G,B;

  // red -> yellow (0..0.5), yellow -> green (0.5..1)
  if (t <= 0.5){
    const k = t / 0.5;
    // red (214,0,0) to yellow (255,215,0)
    R = Math.round(214 + (255-214)*k);
    G = Math.round(0   + (215-0)*k);
    B = 0;
  } else {
    const k = (t - 0.5) / 0.5;
    // yellow (255,215,0) to green (0,176,80)
    R = Math.round(255 + (0-255)*k);
    G = Math.round(215 + (176-215)*k);
    B = Math.round(0   + (80-0)*k);
  }

  // Slightly stronger opacity for higher ratings so “good areas” pop more
  const op = 0.22 + (t * 0.28); // 0.22..0.50
  return { fill:`rgb(${R},${G},${B})`, op };
}

const RAILWAY_BASE_URL = (window.RAILWAY_BASE_URL || "").replace(/\/+$/,"");

const map = L.map('map', { zoomControl: true }).setView([40.72, -73.98], 12);
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap &copy; CARTO'
}).addTo(map);

// keep polygons clean and readable
map.createPane("polys");
map.getPane("polys").style.zIndex = 400;

const polyLayer = L.geoJSON(null, {
  pane: "polys",
  style: (feature) => {
    const p = feature?.properties || {};

    // Prefer rating fields if present:
    const rating =
      p.rating ?? p.rating_1_100 ?? p.rating1_100 ?? p.r ??
      // fallback to builder style if rating missing
      null;

    const { fill, op } = ratingToColor(rating);

    // If builder provided fillColor, use it ONLY if rating missing
    const finalFill = (rating === null || rating === undefined)
      ? (p.style?.fillColor || fill)
      : fill;

    const finalOp = (rating === null || rating === undefined)
      ? (p.style?.fillOpacity ?? op)
      : op;

    return {
      color: "#1b1b1b",
      weight: 2,
      fillColor: finalFill,
      fillOpacity: finalOp
    };
  },
  onEachFeature: (feature, layer) => {
    const p = feature?.properties || {};
    if (p.popup){
      layer.bindPopup(p.popup, { maxWidth: 360 });
    } else {
      // safe fallback popup
      const rating = p.rating ?? p.rating_1_100 ?? "n/a";
      const pickups = p.pickups ?? "n/a";
      layer.bindPopup(
        `<div style="font-family:Arial;font-size:13px;">
          <div style="font-weight:900;">Zone</div>
          <div><b>Rating:</b> ${rating}/100</div>
          <div><b>Pickups:</b> ${pickups}</div>
        </div>`,
        { maxWidth: 320 }
      );
    }
  }
}).addTo(map);

let timeline = [];
let dataByTime = new Map();

function setStatus(ok, msg){
  const el = document.getElementById("statusLine");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("bad", !ok);
}

function clearMap(){
  polyLayer.clearLayers();
}

function rebuildAtIndex(idx){
  const key = timeline[idx];
  const bundle = dataByTime.get(key);
  if (!bundle) return;

  document.getElementById("timeLabel").textContent = formatTimeLabel(key);

  clearMap();

  if (bundle.polygons){
    polyLayer.addData(bundle.polygons);
  }
}

async function fetchHotspots(){
  if (!RAILWAY_BASE_URL){
    throw new Error("Missing window.RAILWAY_BASE_URL (set it in index.html)");
  }

  // quick ping so you know Railway is reachable
  const ping = await fetch(`${RAILWAY_BASE_URL}/?ts=${Date.now()}`, { cache:"no-store" });
  if (!ping.ok){
    throw new Error(`Railway not reachable (GET / failed: ${ping.status})`);
  }

  // load the big json from Railway
  const res = await fetch(`${RAILWAY_BASE_URL}/download?ts=${Date.now()}`, { cache:"no-store" });
  if (!res.ok){
    const txt = await res.text().catch(()=> "");
    throw new Error(`Download failed (${res.status}). ${txt.slice(0,120)}`);
  }

  const payload = await res.json();

  // Expect: { timeline: [...], frames: [{time, polygons, ...}, ...] }
  timeline = payload.timeline || [];
  dataByTime = new Map((payload.frames || []).map(f => [f.time, f]));

  if (!timeline.length || !dataByTime.size){
    throw new Error("Data format missing timeline/frames (JSON shape changed).");
  }

  setStatus(true, `Loaded ${timeline.length} steps from Railway ✅`);
}

function setupSlider(){
  const slider = document.getElementById("slider");
  slider.min = 0;
  slider.max = Math.max(0, timeline.length - 1);
  slider.step = 1;
  slider.value = 0;

  // iPhone smoothness
  let pending = null;
  slider.addEventListener("input", () => {
    pending = Number(slider.value);
    if (slider._raf) return;
    slider._raf = requestAnimationFrame(() => {
      slider._raf = null;
      if (pending !== null) rebuildAtIndex(pending);
    });
  });
}

function setupPanel(){
  const panel = document.getElementById("panel");
  const body = document.getElementById("panelBody");
  const btn = document.getElementById("minBtn");

  btn.addEventListener("click", () => {
    const minimized = body.classList.toggle("hidden");
    btn.textContent = minimized ? "Max" : "Min";
    panel.style.width = minimized ? "auto" : "230px";
  });
}

async function main(){
  setupPanel();

  try{
    setStatus(true, "Loading…");
    await fetchHotspots();
  } catch (e){
    console.error(e);
    setStatus(false, "ERROR: " + e.message);
    document.getElementById("timeLabel").textContent = "Load failed";
    return;
  }

  setupSlider();

  // show first frame
  rebuildAtIndex(0);
}

main();