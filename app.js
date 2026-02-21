// TLC Hotspot Map (GitHub Pages frontend)
// DATA SOURCE: Railway only (volume-backed output served by Railway)
//
// Required Railway endpoints:
// - POST  /generate?bin_minutes=20  (creates output on Railway volume)
// - GET   /hotspots_20min.json      (serves output JSON)
// - GET   /status                  (optional, for debugging)

const BASE = (window.RAILWAY_BASE_URL || "").replace(/\/+$/, "");
if (!BASE) {
  setStatus("ERROR: Missing window.RAILWAY_BASE_URL in index.html");
  throw new Error("Missing RAILWAY_BASE_URL");
}

function setStatus(msg) {
  const el = document.getElementById("statusText");
  if (el) el.textContent = msg;
}

function formatTimeNYC(iso) {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit"
  });
}

// Your mandatory color rules:
// Green = Best, Blue = Medium, Sky = Normal, Red = Avoid
//
// We map rating 1..100 into 4 buckets.
// You can adjust thresholds later if you want.
function ratingToBucket(rating) {
  const r = Number(rating);
  if (!Number.isFinite(r)) return { name: "Normal", color: "#7dd3fc" };

  // Avoid: bottom
  if (r <= 25) return { name: "Avoid", color: "#ef4444" };
  // Normal
  if (r <= 50) return { name: "Normal", color: "#7dd3fc" };
  // Medium
  if (r <= 75) return { name: "Medium", color: "#1f6feb" };
  // Best
  return { name: "Best", color: "#1db954" };
}

const map = L.map("map", { zoomControl: true }).setView([40.72, -73.98], 12);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: '&copy; OpenStreetMap &copy; CARTO'
}).addTo(map);

// Layer for zones
const zoneLayer = L.geoJSON(null, {
  // IMPORTANT: no outlines (you asked to remove perimeter outlines)
  style: (feature) => {
    const p = feature?.properties || {};
    // Our code uses properties.rating when present; fallback to properties.score/val.
    const rating = (p.rating ?? p.score ?? p.value ?? p.r ?? null);
    const bucket = ratingToBucket(rating);

    return {
      color: bucket.color,
      weight: 0,           // no outline
      fillColor: bucket.color,
      fillOpacity: 0.45
    };
  },
  onEachFeature: (feature, layer) => {
    const p = feature?.properties || {};
    const rating = (p.rating ?? p.score ?? p.value ?? p.r ?? null);
    const bucket = ratingToBucket(rating);

    const zoneName = p.zone || p.name || p.LocationID || "Zone";
    const borough = p.borough || p.Borough || "";

    const popup = `
      <div style="font-family:Arial; font-size:13px;">
        <div style="font-weight:900; font-size:14px;">${zoneName}</div>
        ${borough ? `<div style="color:#666;">${borough}</div>` : ``}
        <hr style="margin:6px 0;">
        <div><b>Rating:</b> ${rating ?? "n/a"} / 100</div>
        <div><b>Bucket:</b> ${bucket.name}</div>
      </div>
    `;
    layer.bindPopup(popup, { maxWidth: 320 });
  }
}).addTo(map);

let timeline = [];
let framesByTime = new Map();

function rebuildAtIndex(idx) {
  const key = timeline[idx];
  const frame = framesByTime.get(key);
  if (!frame) return;

  document.getElementById("timeLabel").textContent = formatTimeNYC(key);

  zoneLayer.clearLayers();

  // Expected payload format:
  // payload = { timeline: [...], frames: [{ time, polygons: GeoJSON }, ...] }
  //
  // We support both:
  // - frame.polygons
  // - frame.zones
  // - frame.geojson
  const geo = frame.polygons || frame.zones || frame.geojson || null;

  if (geo) {
    zoneLayer.addData(geo);
  }
}

async function fetchHotspots() {
  const url = `${BASE}/hotspots_20min.json?ts=${Date.now()}`; // cache-bust
  const res = await fetch(url, { cache: "no-store" });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Load failed (${res.status}). ${txt}`.trim());
  }

  return await res.json();
}

async function load() {
  setStatus("Loading…");

  const payload = await fetchHotspots();

  timeline = payload.timeline || [];
  const frames = payload.frames || [];

  framesByTime = new Map(frames.map(f => [f.time, f]));

  const slider = document.getElementById("slider");
  slider.min = 0;
  slider.max = Math.max(0, timeline.length - 1);
  slider.step = 1;

  // Start slider near "now" in NYC time
  // We choose the closest frame time to current NYC time.
  let startIdx = 0;
  if (timeline.length > 0) {
    const now = Date.now();
    let best = { i: 0, diff: Infinity };
    for (let i = 0; i < timeline.length; i++) {
      const t = new Date(timeline[i]).getTime();
      const diff = Math.abs(t - now);
      if (diff < best.diff) best = { i, diff };
    }
    startIdx = best.i;
  }

  slider.value = String(startIdx);

  // Smooth slider updates (mobile friendly)
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
    setStatus("No timeline in hotspots_20min.json. Run Generate.");
    document.getElementById("timeLabel").textContent = "No data";
    return;
  }

  rebuildAtIndex(startIdx);
  setStatus(`Loaded ${timeline.length} steps ✓`);
}

async function generateOnRailway() {
  // Uses your existing endpoint
  const url = `${BASE}/generate?bin_minutes=20`;
  setStatus("Generating on Railway…");

  const res = await fetch(url, {
    method: "POST",
    headers: { "accept": "application/json" }
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(json?.error || `Generate failed (${res.status})`);
  }
  return json;
}

// Buttons
document.getElementById("btnReload").addEventListener("click", async () => {
  try { await load(); } catch (e) { setStatus(String(e.message || e)); }
});

document.getElementById("btnGenerate").addEventListener("click", async () => {
  try {
    await generateOnRailway();
    await load();
  } catch (e) {
    setStatus(String(e.message || e));
  }
});

// Boot
load().catch(e => setStatus(String(e.message || e)));