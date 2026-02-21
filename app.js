// =======================
// app.js (STRICT RULES)
// - Railway ONLY
// - Colors from rating (1–100) in 20-minute window
//   Green Best, Blue Medium, Sky Normal, Red Avoid
// - Slider shows NYC time and starts at closest NYC time-of-week (week wrap)
// - No icons, no checkmarks, no X
// - No polygon outline (stroke disabled)
// - If /timeline not ready -> POST /generate once -> retry /timeline
// - Frames load from /frame/{idx}
// =======================

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function setStatus(msg) {
  const el = document.getElementById("statusText");
  if (el) el.textContent = msg;
}

function nycTimeLabel(iso) {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit"
  });
}

function getNYCParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });

  const parts = Object.fromEntries(
    fmt.formatToParts(date)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value])
  );

  // Monday=0 ... Sunday=6
  const dowMap = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

  return {
    dow: dowMap[parts.weekday] ?? 0,
    minuteOfDay: (Number(parts.hour) || 0) * 60 + (Number(parts.minute) || 0)
  };
}

function timelineMinuteOfWeekNYC(iso) {
  const parts = getNYCParts(new Date(iso));
  return parts.dow * 1440 + parts.minuteOfDay;
}

function addMinutesISO(iso, minutes) {
  const d = new Date(iso);
  return new Date(d.getTime() + minutes * 60 * 1000).toISOString();
}

// ✅ STRICT bucket colors (your rules)
function ratingToColor(rating1to100) {
  const r = clamp(Number(rating1to100 || 0), 1, 100);

  if (r <= 25) return "#d32f2f";  // Red = Avoid
  if (r <= 50) return "#81d4fa";  // Sky = Normal
  if (r <= 75) return "#1976d2";  // Blue = Medium
  return "#2e7d32";               // Green = Best
}

function getRailwayBase() {
  const base = window.RAILWAY_BASE_URL;
  if (!base || !String(base).trim()) return null;
  return String(base).replace(/\/+$/, "");
}

const BASE = getRailwayBase();
const BIN_MINUTES = 20;

// ✅ Normalize rating to strict 1–100 (handles 0–1 and 1–10 too)
function getRating1to100(props) {
  const p = props || {};
  let v =
    p.rating ??
    p.rating_1_100 ??
    p.score01 ??
    p.rating01 ??
    p.score ??
    p.value ??
    null;

  if (v === null || v === undefined) return null;

  v = Number(v);
  if (!Number.isFinite(v) || v <= 0) return null;

  if (v > 0 && v <= 1) return clamp(Math.round(1 + 99 * v), 1, 100); // 0–1
  if (v > 1 && v <= 10) return clamp(Math.round(v * 10), 1, 100);    // 1–10
  return clamp(Math.round(v), 1, 100);                                // 1–100
}

// ---------- Map ----------
const map = L.map("map", { zoomControl: true }).setView([40.72, -73.98], 12);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap &copy; CARTO"
}).addTo(map);

map.createPane("polys");
map.getPane("polys").style.zIndex = 400;

const polyLayer = L.geoJSON(null, {
  pane: "polys",
  style: (feature) => {
    const rating = getRating1to100(feature?.properties);

    // ✅ NO OUTLINE
    if (rating !== null) {
      return { stroke: false, fillColor: ratingToColor(rating), fillOpacity: 0.72 };
    }

    // Missing rating -> neutral gray (NOT red)
    return { stroke: false, fillColor: "#e0e0e0", fillOpacity: 0.20 };
  },
  onEachFeature: (feature, layer) => {
    const p = feature?.properties || {};
    const rating = getRating1to100(p);

    const zone = p.zone || p.name || p.LocationID || "Zone";
    const borough = p.borough || p.Borough || "";

    layer.bindPopup(
      `<div style="font-family:Arial; font-size:13px;">
        <div style="font-weight:900; font-size:14px;">${zone}</div>
        ${borough ? `<div style="color:#666; margin-bottom:6px;">${borough}</div>` : ""}
        <div><b>Rating:</b> ${rating ?? "n/a"} / 100</div>
      </div>`,
      { maxWidth: 360 }
    );
  }
}).addTo(map);

// ---------- UI ----------
const slider = document.getElementById("slider");
const timeLabel = document.getElementById("timeLabel");
const btnNow = document.getElementById("btnNow");
const btnGenerate = document.getElementById("btnGenerate");

let timeline = [];
let _generatedThisBoot = false;

// ---------- Railway-only API ----------
async function apiGET(path) {
  return fetch(`${BASE}${path}`, { cache: "no-store", headers: { accept: "application/json" } });
}

async function apiPOST(path) {
  // IMPORTANT: Railway /generate requires POST (your 405 confirms it)
  return fetch(`${BASE}${path}`, {
    method: "POST",
    cache: "no-store",
    headers: { accept: "application/json" },
    body: ""
  });
}

async function readJsonOrText(res) {
  const txt = await res.text().catch(() => "");
  try { return JSON.parse(txt); } catch { return txt; }
}

function sortTimeline() {
  timeline.sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
}

function setSliderBounds() {
  slider.min = 0;
  slider.max = Math.max(0, timeline.length - 1);
  slider.step = 1;
}

// ✅ closest NYC time-of-week (week wrap)
function pickIndexClosestToNow() {
  if (!timeline.length) return 0;

  const now = getNYCParts();
  const nowM = now.dow * 1440 + now.minuteOfDay;
  const week = 7 * 24 * 60;

  let bestIdx = 0;
  let bestDiff = Infinity;

  for (let i = 0; i < timeline.length; i++) {
    const tM = timelineMinuteOfWeekNYC(timeline[i]);
    const direct = Math.abs(tM - nowM);
    const wrap = week - direct;
    const diff = Math.min(direct, wrap);

    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  return bestIdx;
}

// ---------- Timeline + Generate ----------
async function generateOnRailway() {
  // Keep your original generate params (still Railway-only)
  const genPath =
    "/generate?bin_minutes=20&good_n=200&bad_n=120&win_good_n=80&win_bad_n=40&min_trips_per_window=10&simplify_meters=25";

  const res = await apiPOST(genPath);
  if (!res.ok) {
    const data = await readJsonOrText(res);
    throw new Error(`Generate failed (${res.status}): ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
}

async function loadTimelineWithAutoGenerate() {
  // Try timeline first
  const res = await apiGET("/timeline");

  if (res.ok) {
    const data = await res.json();
    timeline = Array.isArray(data) ? data : (data.timeline || []);
    sortTimeline();
    return;
  }

  // Not OK -> read message
  const data = await readJsonOrText(res);
  const msg = String((data && data.error) ? data.error : data).toLowerCase();

  // If timeline not ready -> generate ONCE then retry timeline several times
  if (!_generatedThisBoot && msg.includes("timeline not ready")) {
    _generatedThisBoot = true;

    setStatus("Generating… (first time)");
    await generateOnRailway();

    setStatus("Loading…");
    for (let i = 0; i < 15; i++) {
      await sleep(900);

      const res2 = await apiGET("/timeline");
      if (res2.ok) {
        const data2 = await res2.json();
        timeline = Array.isArray(data2) ? data2 : (data2.timeline || []);
        sortTimeline();
        return;
      }
    }

    throw new Error("Timeline still not ready after generate");
  }

  throw new Error(`Failed /timeline (${res.status}): ${typeof data === "string" ? data : JSON.stringify(data)}`);
}

// ---------- Frames ----------
async function loadFrame(i) {
  const res = await apiGET(`/frame/${encodeURIComponent(i)}`);
  if (!res.ok) {
    const data = await readJsonOrText(res);
    throw new Error(`Failed /frame/${i} (${res.status}): ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
  return await res.json();
}

function renderFrame(frame) {
  const t = frame?.time;

  if (t) {
    const endISO = addMinutesISO(t, BIN_MINUTES);
    const startNY = nycTimeLabel(t);
    const endNY = nycTimeLabel(endISO).replace(/^[A-Za-z]{3}\s/, "");
    timeLabel.textContent = `${startNY} – ${endNY} (NYC)`;
  } else {
    timeLabel.textContent = "Unknown time (NYC)";
  }

  polyLayer.clearLayers();

  const geo = frame?.polygons || frame?.geojson || frame?.data || null;
  if (geo) polyLayer.addData(geo);
}

async function goToIndex(i) {
  const idx = clamp(Number(i || 0), 0, timeline.length - 1);
  slider.value = String(idx);

  const frame = await loadFrame(idx);
  renderFrame(frame);
}

// Throttle slider events
let pending = null;

slider.addEventListener("input", () => {
  pending = Number(slider.value);
  if (slider._raf) return;

  slider._raf = requestAnimationFrame(async () => {
    slider._raf = null;
    try {
      await goToIndex(pending);
      setStatus(`Loaded ${timeline.length} steps`);
    } catch (e) {
      console.error(e);
      setStatus("Load failed (frame)");
      timeLabel.textContent = "Load failed";
    }
  });
});

btnNow?.addEventListener("click", async () => {
  try {
    const idx = pickIndexClosestToNow();
    await goToIndex(idx);
    setStatus(`Loaded ${timeline.length} steps`);
  } catch (e) {
    console.error(e);
    setStatus("Load failed (Now)");
  }
});

btnGenerate?.addEventListener("click", async () => {
  if (!BASE) {
    alert("Missing window.RAILWAY_BASE_URL in index.html");
    return;
  }
  try {
    setStatus("Generating…");
    await generateOnRailway();
    _generatedThisBoot = true;
    await boot();
  } catch (e) {
    console.error(e);
    setStatus("Generate failed");
    alert(String(e.message || e));
  }
});

async function boot() {
  if (!BASE) {
    setStatus("Load failed");
    timeLabel.textContent = "ERROR: Missing Railway base URL";
    return;
  }

  try {
    setStatus("Loading…");
    await loadTimelineWithAutoGenerate();

    if (!timeline.length) {
      setStatus("No timeline");
      timeLabel.textContent = "No timeline data";
      return;
    }

    setSliderBounds();

    const idx = pickIndexClosestToNow();
    await goToIndex(idx);

    setStatus(`Loaded ${timeline.length} steps`);
  } catch (e) {
    console.error(e);
    setStatus("Load failed (timeline)");
    timeLabel.textContent = "Load failed";
  }
}

boot();