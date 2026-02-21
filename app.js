<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>NYC HVFHV Hotspot Map</title>

  <!-- Leaflet CSS + JS from CDN (easy, no install needed) -->
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
    integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5n/N0ZDvEg=" crossorigin=""/>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
    integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>

  <style>
    body { margin: 0; font-family: Arial, sans-serif; }
    #map { height: 100vh; width: 100vw; }
    #ui {
      position: absolute;
      top: 10px;
      left: 10px;
      z-index: 1000;
      background: white;
      padding: 12px 16px;
      border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.25);
      max-width: 340px;
    }
    #ui h3 { margin: 0 0 10px; font-size: 1.1em; }
    #controls { display: flex; gap: 8px; margin-bottom: 10px; }
    button {
      padding: 8px 12px;
      font-size: 0.9em;
      cursor: pointer;
      border: none;
      border-radius: 4px;
      background: #1976d2;
      color: white;
    }
    button:hover { background: #1565c0; }
    #timeLabel { font-weight: bold; margin: 8px 0; }
    #statusText { color: #555; font-size: 0.9em; }
    #slider {
      width: 100%;
      margin-top: 8px;
    }
  </style>
</head>
<body>

  <div id="map"></div>

  <div id="ui">
    <h3>NYC HVFHV Zones (1–100)</h3>
    <div>
      <strong>Colors:</strong><br>
      🟢 Green = Best<br>
      🔵 Blue = Medium<br>
      🟦 Sky = Normal<br>
      🔴 Red = Avoid
    </div>
    <div id="controls">
      <button id="btnNow">Now (NYC)</button>
      <button id="btnGenerate">Generate</button>
    </div>
    <div id="timeLabel">Loading time...</div>
    <div id="statusText">Loading...</div>
    <input type="range" id="slider" min="0" max="0" value="0" step="1"/>
  </div>

  <script>
    // ────────────────────────────────────────────────
    //  PASTE YOUR RAILWAY URL HERE (very important!)
    //  Example: https://your-service-name.up.railway.app
    //  Get it from Railway → Service → Settings → Networking → Public Networking → Generate Domain
    window.RAILWAY_BASE_URL = "https://paste-your-railway-url-here.up.railway.app";
    // ────────────────────────────────────────────────

    // ── Helper Functions ────────────────────────────────────────────────
    function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
          .filter(p => p.type !== "literal")
          .map(p => [p.type, p.value])
      );

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

    // ── Color buckets (strict as in your original) ──────────────────────
    function ratingToColor(rating1to100) {
      const r = clamp(Number(rating1to100 || 0), 1, 100);
      if (r <= 25) return "#d32f2f";   // Red = Avoid
      if (r <= 50) return "#81d4fa";   // Sky = Normal
      if (r <= 75) return "#1976d2";   // Blue = Medium
      return "#2e7d32";                // Green = Best
    }

    function getRailwayBase() {
      const base = window.RAILWAY_BASE_URL;
      if (!base || !String(base).trim()) return null;
      return String(base).replace(/\/+$/, "");
    }

    const BASE = getRailwayBase();
    const BIN_MINUTES = 20;

    function getRating1to100(props) {
      const p = props || {};
      let v = p.rating ?? p.rating_1_100 ?? p.score01 ?? p.rating01 ?? p.score ?? p.value ?? null;
      if (v == null) return null;
      v = Number(v);
      if (!Number.isFinite(v) || v <= 0) return null;
      if (v > 0 && v <= 1) return clamp(Math.round(1 + 99 * v), 1, 100);
      if (v > 1 && v <= 10) return clamp(Math.round(v * 10), 1, 100);
      return clamp(Math.round(v), 1, 100);
    }

    // ── Map Setup ───────────────────────────────────────────────────────
    const map = L.map("map", { zoomControl: true }).setView([40.72, -73.98], 12);

    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
    }).addTo(map);

    map.createPane("polys");
    map.getPane("polys").style.zIndex = 400;

    const polyLayer = L.geoJSON(null, {
      pane: "polys",
      style: feature => {
        const rating = getRating1to100(feature?.properties);
        if (rating !== null) {
          return { stroke: false, fillColor: ratingToColor(rating), fillOpacity: 0.72 };
        }
        return { stroke: false, fillColor: "#e0e0e0", fillOpacity: 0.20 };
      }
    }).addTo(map);

    // ── UI Elements ─────────────────────────────────────────────────────
    const slider = document.getElementById("slider");
    const timeLabel = document.getElementById("timeLabel");
    const btnNow = document.getElementById("btnNow");
    const btnGenerate = document.getElementById("btnGenerate");

    let timeline = [];

    // ── API Helpers ─────────────────────────────────────────────────────
    async function apiGET(path) {
      return fetch(`${BASE}${path}`, { cache: "no-store", headers: { accept: "application/json" } });
    }

    async function apiPOST(path) {
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

    // ── Timeline & Generate ─────────────────────────────────────────────
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
        const msg = String((data?.error) ? data.error : data).toLowerCase();
        if (msg.includes("timeline not ready")) {
          const elapsed = Math.floor((Date.now() - start) / 1000);
          setStatus(`Generating… waiting for timeline (${elapsed}s)`);
          await sleep(700 + Math.min(2000, attempt * 120));
          continue;
        }
        throw new Error(`Timeline error (${res.status}): ${JSON.stringify(data)}`);
      }
      return false;
    }

    async function generateOnRailway() {
      const genPath = "/generate?bin_minutes=20&good_n=200&bad_n=120&win_good_n=80&win_bad_n=40&min_trips_per_window=10&simplify_meters=25";
      const res = await apiPOST(genPath);
      const data = await readJsonOrText(res);
      if (!res.ok) throw new Error(`Generate failed (${res.status}): ${JSON.stringify(data)}`);
      return data;
    }

    async function loadTimelineAuto() {
      const first = await apiGET("/timeline");
      if (first.ok) {
        const data = await first.json();
        timeline = Array.isArray(data) ? data : (data.timeline || []);
        sortTimeline();
        return;
      }
      const firstData = await readJsonOrText(first);
      const msg = String((firstData?.error) ? firstData.error : firstData).toLowerCase();
      if (msg.includes("timeline not ready")) {
        setStatus("Generating…");
        await generateOnRailway();
        const ok = await pollTimelineUntilReady(120);
        if (!ok) throw new Error("Timeline never became ready after generate.");
        return;
      }
      throw new Error(`Failed /timeline (${first.status}): ${JSON.stringify(firstData)}`);
    }

    // ── Frame Loading ───────────────────────────────────────────────────
    async function loadFrame(i) {
      const res = await apiGET(`/frame/${encodeURIComponent(i)}`);
      if (!res.ok) {
        const data = await readJsonOrText(res);
        throw new Error(`Failed /frame/${i} (${res.status}): ${JSON.stringify(data)}`);
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

    // ── Event Listeners ─────────────────────────────────────────────────
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
        alert("Missing Railway base URL — edit index.html and add window.RAILWAY_BASE_URL");
        return;
      }
      try {
        setStatus("Generating… (may take 1–2 min)");
        await generateOnRailway();
        const ok = await pollTimelineUntilReady(180); // give extra time
        if (!ok) throw new Error("Timeline never became ready.");
        setSliderBounds();
        const idx = pickIndexClosestToNow();
        await goToIndex(idx);
        setStatus(`Loaded ${timeline.length} steps`);
      } catch (e) {
        console.error(e);
        setStatus("Generate failed — check console or Railway logs");
        alert("Generate failed: " + (e.message || e));
      }
    });

    // ── Start ───────────────────────────────────────────────────────────
    async function boot() {
      if (!BASE) {
        setStatus("ERROR: Missing Railway base URL");
        timeLabel.textContent = "Edit index.html → add your URL";
        alert("Please set window.RAILWAY_BASE_URL in the code (line ~15) with your Railway service URL.");
        return;
      }
      try {
        setStatus("Loading timeline...");
        await loadTimelineAuto();
        if (!timeline.length) {
          setStatus("No timeline data yet — try Generate");
          timeLabel.textContent = "No data";
          return;
        }
        setSliderBounds();
        const idx = pickIndexClosestToNow();
        await goToIndex(idx);
        setStatus(`Ready — ${timeline.length} time windows loaded`);
      } catch (e) {
        console.error(e);
        setStatus("Load failed — check console (F12)");
        timeLabel.textContent = "Failed to load";
      }
    }

    boot();
  </script>
</body>
</html>