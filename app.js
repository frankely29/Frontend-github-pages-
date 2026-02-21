// =======================
// TLC Hotspot Map - app.js (NO icons, NO outlines)
// - Loads timeline/frames from Railway
// - NYC timezone label
// - Discrete bucket colors:
//   Green = Best, Blue = Medium, Sky = Normal, Red = Avoid
// - Removes polygon stroke outline completely
// - Uses higher fillOpacity so colors don't wash out
// =======================

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function setStatus(msg){
  const el = document.getElementById("statusText");
  if (el) el.textContent = msg;
}

const BIN_MINUTES = 20;

function nycTimeLabel(iso){
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit"
  });
}

function addMinutesISO(iso, minutes){
  const d = new Date(iso);
  const d2 = new Date(d.getTime() + minutes * 60 * 1000);
  return d2.toISOString();
}

// ✅ Your desired bucket rules (clear / not “gradient mixed”)
function ratingToBucketColor(rating){
  const r = clamp(Number(rating || 0), 0, 100);

  // Red = lowest (avoid)
  if (r <= 25) return "#d32f2f";

  // Sky = normal
  if (r <= 50) return "#81d4fa";

  // Blue = medium
  if (r <= 75) return "#1976d2";

  // Green = best
  return "#2e7d32";
}

function getRailwayBase(){
  if (window.RAILWAY_BASE_URL && String(window.RAILWAY_BASE_URL).trim()){
    return String(window.RAILWAY_BASE_URL).replace(/\/+$/, "");
  }
  const qs = new URLSearchParams(location.search);
  const q = qs.get("railway");
  if (q) return String(q).replace(/\/+$/, "");
  return null;
}

const BASE = getRailwayBase();

// Leaflet setup
const map = L.map("map", { zoomControl: true }).setView([40.72, -73.98], 12);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: '&copy; OpenStreetMap &copy; CARTO'
}).addTo(map);

// Pane for polygons
map.createPane("polys");
map.getPane("polys").style.zIndex = 400;

// Layers
const polyLayer = L.geoJSON(null, {
  pane: "polys",
  style: (feature) => {
    const p = feature?.properties || {};

    // Find rating from common fields
    const rating =
      p.rating ??
      p.rating_1_100 ??
      (p.rating01 !== undefined ? Math.round(1 + 99 * Number(p.rating01)) : null) ??
      (p.score01 !== undefined ? Math.round(1 + 99 * Number(p.score01)) : null);

    // IMPORTANT:
    // - NO OUTLINE: stroke:false removes the perimeter/outline completely
    // - Higher opacity so red/sky/blue/green look correct on the basemap
    if (rating !== null && rating !== undefined && !Number.isNaN(Number(rating))){
      return {
        stroke: false,               // ✅ removes green perimeter outline
        fillColor: ratingToBucketColor(rating),
        fillOpacity: 0.72            // ✅ stronger color, less “mixed”
      };
    }

    // If rating missing, show neutral very light (so it doesn't look like "avoid")
    return {
      stroke: false,
      fillColor: "#e0e0e0",
      fillOpacity: 0.20
    };
  },
  onEachFeature: (feature, layer) => {
    const p = feature?.properties || {};
    const rating =
      p.rating ??
      p.rating_1_100 ??
      (p.score01 !== undefined ? Math.round(1 + 99 * Number(p.score01)) : null);

    const zone = p.zone || p.name || "Zone";
    const borough = p.borough || "";

    const popup = `
      <div style="font-family:Arial; font-size:13px;">
        <div style="font-weight:900; font-size:14px;">${zone}</div>
        ${borough ? `<div style="color:#666; margin-bottom:6px;">${borough}</div>` : ""}
        <div><b>Rating:</b> ${rating ?? "n/a"} / 100</div>
      </div>
    `;
    layer.bindPopup(popup, { maxWidth: 360 });
  }
}).addTo(map);

// UI
const slider = document.getElementById("slider");
const timeLabel = document.getElementById("timeLabel");
const btnGenerate = document.getElementById("btnGenerate");
const btnReload = document.getElementById("btnReload");

let timeline = [];

// API helpers
async function apiGET(path){
  const url = `${BASE}${path}`;
  return await fetch(url, { cache: "no-store" });
}

async function apiPOST(path){
  const url = `${BASE}${path}`;
  return await fetch(url, {
    method: "POST",
    headers: { "accept": "application/json" },
    body: ""
  });
}

function sortTimelineInPlace(){
  timeline.sort((a,b) => new Date(a).getTime() - new Date(b).getTime());
}

async function loadTimeline(){
  // Prefer /timeline
  let res = await apiGET("/timeline");

  // Fallback to /download
  if (res.status === 404) {
    res = await apiGET("/download");
    if (!res.ok) throw new Error(`Failed /download (${res.status})`);
    const payload = await res.json();
    timeline = payload.timeline || [];
    sortTimelineInPlace();
    setStatus(`Loaded ${timeline.length} steps ✓`);
    return;
  }

  if (!res.ok) {
    const txt = await res.text().catch(()=> "");
    throw new Error(`Timeline not ready (${res.status}). ${txt}`);
  }

  const data = await res.json();
  timeline = data.timeline || [];
  sortTimelineInPlace();
  setStatus(`Loaded ${timeline.length} steps ✓`);
}

async function loadFrameByIndex(i){
  // Prefer /frame?i=
  let res = await apiGET(`/frame?i=${encodeURIComponent(i)}`);

  // Fallback to /download (slow)
  if (res.status === 404){
    res = await apiGET("/download");
    if (!res.ok) throw new Error(`Failed /download (${res.status})`);
    const payload = await res.json();
    const frames = payload.frames || [];
    const frame = frames[i];
    if (!frame) throw new Error("Frame missing in download JSON");
    return frame;
  }

  if (!res.ok){
    const txt = await res.text().catch(()=> "");
    throw new Error(`Frame fetch failed (${res.status}). ${txt}`);
  }

  return await res.json();
}

function renderFrame(frame){
  const t = frame?.time;

  if (t){
    // show NYC time + end time (20-min window)
    const endISO = addMinutesISO(t, BIN_MINUTES);
    const startNY = nycTimeLabel(t);
    const endNY = nycTimeLabel(endISO).replace(/^[A-Za-z]{3}\s/, ""); // remove weekday on end
    timeLabel.textContent = `${startNY} – ${endNY}`;
  }

  polyLayer.clearLayers();

  const polys = frame?.polygons;
  if (polys){
    polyLayer.addData(polys);
  }
}

function setSliderBounds(){
  slider.min = 0;
  slider.max = Math.max(0, timeline.length - 1);
  slider.step = 1;
  slider.value = 0;
}

// Smooth slider updates
let pendingIdx = null;
slider.addEventListener("input", () => {
  pendingIdx = Number(slider.value);
  if (slider._raf) return;

  slider._raf = requestAnimationFrame(async () => {
    slider._raf = null;
    if (pendingIdx === null) return;

    try {
      const frame = await loadFrameByIndex(pendingIdx);
      renderFrame(frame);
    } catch (e) {
      console.error(e);
      setStatus("Load failed ✖");
      timeLabel.textContent = "Load failed";
    }
  });
});

btnReload?.addEventListener("click", () => location.reload());

btnGenerate?.addEventListener("click", async () => {
  if (!BASE) {
    alert("Missing Railway base URL. Edit index.html: window.RAILWAY_BASE_URL = 'https://...'");
    return;
  }
  setStatus("Generating…");
  try {
    const res = await apiPOST("/generate?bin_minutes=20&good_n=200&bad_n=120&win_good_n=80&win_bad_n=40&min_trips_per_window=10&simplify_meters=25");
    if (!res.ok) throw new Error(`Generate failed (${res.status})`);
    await boot(true);
  } catch (e) {
    console.error(e);
    setStatus("Generate failed ✖");
    alert(String(e.message || e));
  }
});

async function boot(forceRegenerateIfNeeded=false){
  if (!BASE){
    setStatus("Load failed ✖");
    timeLabel.textContent = "ERROR: Missing Railway base URL";
    return;
  }

  try {
    setStatus("Loading…");

    await loadTimeline();
    setSliderBounds();

    if (timeline.length > 0){
      const frame0 = await loadFrameByIndex(0);
      renderFrame(frame0);
      setStatus(`Loaded ${timeline.length} steps ✓`);
      return;
    }

    setStatus("No data ✖");
    timeLabel.textContent = "No timeline data";
  } catch (e) {
    console.error(e);

    if (forceRegenerateIfNeeded || String(e.message || "").includes("not ready")) {
      try {
        setStatus("Not ready. Generating…");
        const r = await apiPOST("/generate?bin_minutes=20&good_n=200&bad_n=120&win_good_n=80&win_bad_n=40&min_trips_per_window=10&simplify_meters=25");
        if (!r.ok) throw new Error(`Generate failed (${r.status})`);

        await loadTimeline();
        setSliderBounds();
        const frame0 = await loadFrameByIndex(0);
        renderFrame(frame0);
        setStatus(`Loaded ${timeline.length} steps ✓`);
        return;
      } catch (e2) {
        console.error(e2);
      }
    }

    setStatus("Load failed ✖");
    timeLabel.textContent = "Load failed";
  }
}

boot(false);