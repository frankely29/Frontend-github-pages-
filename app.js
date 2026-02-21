// =======================
// NYC FHV HOTSPOT MAP (STRICT RULES)
// - Railway ONLY (no local data)
// - Colors from rating(1–100) for selected 20-minute window
//   Green Best, Blue Medium, Sky Normal, Red Avoid
// - Bottom slider uses NYC time zone + starts at closest NYC time-of-week (week wrap)
// - No icons, no checkmarks, no X
// - No polygon outline (stroke disabled)
// - Calls Railway /timeline, if not ready -> POST /generate -> POLL /timeline until ready
// - Loads frames from /frame/{idx}
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
  const p = getNYCParts(new Date(iso));
  return p.dow * 1440 + p.minuteOfDay;
}

function addMinutesISO(iso, minutes) {
  const d = new Date(iso);
  return new Date(d.getTime() + minutes * 60 * 1000).toISOString();
}

// ===== STRICT COLOR BUCKETS (MANDATORY) =====
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

// Normalize rating to strict 1–100 (handles 0–1 and 1–10 safely)
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
  }
}).addTo(map);

// ---------- UI ----------
const slider = document.getElementById("slider");
const timeLabel = document.getElementById("timeLabel");
const btnNow = document.getElementById("btnNow");
const btnGenerate = document.getElementById("btnGenerate");

let timeline = [];

// ---------- Railway-only API ----------
async function apiGET(path) {
  return fetch(`${BASE}${path}`, {
    cache: "no-store",
    headers: { accept: "application/json" }
  });
}

async function apiPOST(path) {
  // IMPORTANT: your backend returns 405 on GET, so /generate requires POST
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

// ✅ closest NYC minute-of-week with week wrap handling
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

// ---------- Timeline handling ----------

// Poll /timeline until it becomes ready (longer wait for async backends)
async function pollTimelineUntilReady(maxSeconds = 120) {
  const start = Date.now();
  let attempt = 0;

  while ((Date.now() - start) / 1000 < maxSeconds) {
    attempt++;

    const res = await apiGET("/timeline");
    const data = await readJsonOrText(res);

    if (res.ok) {
      const t = Array.isArray(data) ? data : (data.timeline || []);
      timeline = t.filter(Boolean);
      sortTimeline();
      return true;
    }

    const msg = String((data && data.error) ? data.error : data).toLowerCase();

    // If still not ready, keep waiting
    if (msg.includes("timeline not ready")) {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      setStatus(`Generating… waiting for timeline (${elapsed}s)`);
      // gentle backoff
      await sleep(700 + Math.min(2000, attempt * 120));
      continue;
    }

    // Some other error (404/500/etc)
    throw new Error(`Timeline error (${res.status}): ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }

  return false; // timed out
}

async function generateOnRailway() {
  // Your params (still Railway-only)
  const genPath =
    "/generate?bin_minutes=20&good_n=200&bad_n=120&win_good_n=80&win_bad_n=40&min_trips_per_window=10&simplify_meters=25";

  const res = await apiPOST(genPath);
  const data = await readJsonOrText(res);

  if (!res.ok) {
    throw new Error(`Generate failed (${res.status}): ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }

  // even if it returns "ok", backend might still be building in background
  return data;
}

async function loadTimelineAuto() {
  // 1) try timeline quickly
  const first = await apiGET("/timeline");
  if (first.ok) {
    const data = await first.json();
    timeline = Array.isArray(data) ? data : (data.timeline || []);
    sortTimeline();
    return;
  }

  const firstData = await readJsonOrText(first);
  const msg = String((firstData && firstData.error) ? firstData.error : firstData).toLowerCase();

  // 2) if not ready -> POST generate
  if (msg.includes("timeline not ready")) {
    setStatus("Generating…");
    await generateOnRailway();

    // 3) poll timeline for up to 120 seconds
    const ok = await pollTimelineUntilReady(120);
    if (!ok) {
      throw new Error("Timeline never became ready after generate (backend is not producing timeline).");
    }
    return;
  }

  // 4) unexpected error
  throw new Error(`Failed /timeline (${first.status}): ${typeof firstData === "string" ? firstData : JSON.stringify(firstData)}`);
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

// Throttle slider
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

    const ok = await pollTimelineUntilReady(120);
    if (!ok) throw new Error("Timeline never became ready after generate.");

    setSliderBounds();
    const idx = pickIndexClosestToNow();
    await goToIndex(idx);
    setStatus(`Loaded ${timeline.length} steps`);
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
    await loadTimelineAuto();

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