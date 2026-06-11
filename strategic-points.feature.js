// =============================================================================
// STRATEGIC POINTS — unified map-overlay system
// =============================================================================
// One file combining the four Strategic Points overlays. Each overlay is kept
// as its own self-contained IIFE (distinct layer/source/CSS id prefixes), so
// behavior is identical to the previous four standalone files — they are simply
// unified here under one "Strategic Points" system:
//   1) Long-trip hotspots  (lth-*) — server POI/building clusters + buildings
//   2) Major buildings     (mbf-*) — 38 NYC hospitals & hotels
//   3) Nightlife districts (nld-*) — bars & restaurants (let-out)
//   4) City events         (cbe-*) — concerts / sports / conventions
// All point types share one gold pulse (#fbbf24). The retired "$" dollar flag
// is no longer rendered.
// =============================================================================

// ============================ 1) LONG-TRIP HOTSPOTS ============================
// Long-trip HOTSPOT pins — server-built dollar-flag markers indicating
// spots where 3+ "high-traffic-or-wealthy" buildings cluster. Distinct
// from long-trips-block.feature.js (driver-placed 45+ flags): hotspots
// are READ-ONLY for drivers, built by the backend once per admin
// rebuild, and shared across all drivers.
//
// Per driver request, the rendering uses the SAME WebGL textured-quad
// pattern as long-trips-block.feature.js so the dollar flag is
// zero-drift on iOS Safari, the same way the 45+ flags are.
//
// Click behavior:
//   - Tap a hotspot (its pulse) → popup listing the buildings it represents
//   - Tap a building             → popup with its name, address, best hours
//
// Backend: GET /long_trip_hotspots (built via POST /admin/long_trip_hotspots/rebuild)
(function () {
  "use strict";

  // ---------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------

  const HOTSPOT_ENDPOINT = "/long_trip_hotspots";
  const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // re-poll every 5 min in case admin rebuilt
  const DIM_TICK_INTERVAL_MS = 60 * 1000;    // re-evaluate time-of-day dim every minute

  // Dim multipliers applied to the flag (premultiplied alpha in shader)
  // and the building dots (data-driven circle-opacity). Medium is set
  // high (0.95) so flags stay clearly visible during normal hours;
  // only off-hours produce a noticeable fade.
  const DIM_PEAK = 1.0;    // peak: full brightness
  const DIM_MEDIUM = 0.95; // normal hours: very nearly full
  const DIM_OFF = 0.25;    // off hours: visibly faded but still readable

  // Source/layer IDs
  const BLDG_SOURCE_ID = "lth-buildings";
  const BLDG_LAYER_ID = "lth-buildings-icon";  // symbol layer (building sprite)
  const BLDG_LABEL_LAYER_ID = "lth-buildings-label"; // text-only NAME labels (separate from icons so names show farther out)
  const BLDG_LABEL_MIN_ZOOM = 10;  // building names readable from a city-overview zoom
  const BLDG_IMAGE_ID = "lth-building-sprite"; // generic fallback sprite (map.addImage)
  // Per-category building sprites — every hotspot member category gets its own
  // recognizable building so a cluster reads as a real, varied skyline instead
  // of identical towers. hotel_luxury & hospital reuse the Major-Buildings art;
  // corporate is a sleek blue-glass financial tower; the rest are bespoke. Any
  // category not listed here falls back to BLDG_IMAGE_ID (the generic tower).
  const BLDG_SPRITE_BY_CATEGORY = {
    hotel_luxury:    "lth-bldg-hotel",
    hospital:        "lth-bldg-hospital",
    corporate:       "lth-bldg-corporate",
    airport:         "lth-bldg-airport",
    transit_hub:     "lth-bldg-transit",
    private_school:  "lth-bldg-school",
    private_club:    "lth-bldg-club",
    luxury_condo:    "lth-bldg-condo",
    luxury_shopping: "lth-bldg-shopping",
    performance:     "lth-bldg-performance",
    stadium:         "lth-bldg-stadium",
    convention:      "lth-bldg-convention",
    tourist:         "lth-bldg-tourist",
  };

  // Prime-time pulse — a gold "best time to be near it" beacon at each
  // flag's pole base. Rendered as map-anchored circle layers (no iOS
  // drift, the same reason the flags use CPU projection) and animated
  // only while ≥1 flag is in its prime window. The flag + building
  // layers stay on top, so the pulse reads as a halo on the ground
  // beneath the pole. The "prime" window comes from the backend
  // dim_schedule and is always a subset of "peak", so a pulsing flag is
  // also at full brightness.
  const PULSE_SOURCE_ID = "lth-pulse";
  const PULSE_GLOW_LAYER_ID = "lth-pulse-glow";
  const PULSE_RING1_LAYER_ID = "lth-pulse-ring1";
  const PULSE_PERIOD_MS = 2200;    // one ring-expansion cycle
  const PULSE_R_MIN = 6;           // ring radius (px) at cycle start
  const PULSE_R_MAX = 20;          // ring radius (px) at cycle end (fades out)
  const PULSE_FPS_MS = 33;         // throttle paint updates to ~30fps
  const PULSE_COLOR = "#fbbf24";   // gold — matches the dollar flag

  // Show building icons at zoom ≥ 12 (mid-borough scale). Previously
  // 14 was too tight — drivers couldn't see them at most working
  // zooms. 12 keeps them visible at normal driving zooms while
  // hiding them when looking at the whole city.
  const BLDG_MIN_ZOOM = 12;

  // ---------------------------------------------------------------
  // Module state
  // ---------------------------------------------------------------
  let mapRef = null;
  let initDone = false;
  let hotspots = [];                // array of {id, lat, lng, label, members:[...]}
  let layerInitStarted = false;
  let useLayer = false;
  let zOrderListenerInstalled = false;
  let zOrderMovePending = false;
  let zOrderInMove = false;
  let pulseActive = false;          // is the pulse animation loop running
  let pulseRAF = null;              // requestAnimationFrame handle
  let pulseLastPaint = 0;           // last frame ts we pushed paint updates
  // Closure calendar served by the backend (federal holidays + school
  // recesses). Used to dark/de-pulse weekday-only + seasonal flags by date.
  let calendar = { holidays: [], seasonal_closures: {} };

  // ---------------------------------------------------------------
  // NYC-local time + dim evaluation
  // ---------------------------------------------------------------
  // NYC's offset shifts ±1h between EST and EDT. Using the browser's
  // Intl machinery is the cleanest way to get a DST-correct local
  // hour without hard-coding any offset.
  function nycHourAndDay() {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hourCycle: "h23",
        hour: "2-digit",
        weekday: "short",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date());
      let hour = 0;
      let weekday = "Mon";
      let y = "", mo = "", da = "";
      for (const p of parts) {
        if (p.type === "hour") hour = Number(p.value) || 0;
        else if (p.type === "weekday") weekday = p.value;
        else if (p.type === "year") y = p.value;
        else if (p.type === "month") mo = p.value;
        else if (p.type === "day") da = p.value;
      }
      const isWeekend = (weekday === "Sat" || weekday === "Sun");
      // ymd "YYYY-MM-DD" matches the backend holiday list; md "MM-DD"
      // matches the recurring seasonal-closure ranges.
      return { hour, isWeekend, ymd: `${y}-${mo}-${da}`, md: `${mo}-${da}` };
    } catch (_) {
      // Worst case: fall back to UTC. Off-by-a-few-hours is better
      // than crashing.
      const d = new Date();
      const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
      const da = String(d.getUTCDate()).padStart(2, "0");
      return {
        hour: d.getUTCHours(),
        isWeekend: (d.getUTCDay() === 0 || d.getUTCDay() === 6),
        ymd: `${d.getUTCFullYear()}-${mo}-${da}`, md: `${mo}-${da}`,
      };
    }
  }

  function hourInRanges(hour, ranges) {
    if (!Array.isArray(ranges) || !ranges.length) return false;
    for (const r of ranges) {
      if (!Array.isArray(r) || r.length < 2) continue;
      const a = r[0], b = r[1];
      // Wrapping ranges (e.g. [23, 5] = 11pm–5am) cross midnight.
      if (a <= b) {
        if (hour >= a && hour < b) return true;
      } else {
        if (hour >= a || hour < b) return true;
      }
    }
    return false;
  }

  // Why this hotspot is closed right now, or null if open. A closed flag
  // is dimmed off and never pulses. Two sources, both from the backend
  // calendar:
  //   - weekday_only types (offices, schools) close on weekends and on
  //     federal holidays (calendar.holidays);
  //   - per-category seasonal closures — the school flag all summer and
  //     over recesses, as explicit [start, end] ISO date ranges
  //     (calendar.seasonal_closures).
  function closureReason(h, now) {
    const sched = h.dim_schedule;
    if (sched && sched.weekday_only) {
      if (now.isWeekend) return "weekend";
      if (Array.isArray(calendar.holidays) && calendar.holidays.includes(now.ymd)) return "holiday";
    }
    const ranges = calendar.seasonal_closures && calendar.seasonal_closures[h.dominant_category];
    if (Array.isArray(ranges)) {
      for (const r of ranges) {
        // r = ["YYYY-MM-DD","YYYY-MM-DD"]; fixed-width ISO strings compare
        // chronologically, so a plain string range check is correct.
        if (Array.isArray(r) && r.length === 2 && now.ymd >= r[0] && now.ymd <= r[1]) return "break";
      }
    }
    return null;
  }

  function dimForHotspot(h, now) {
    const sched = h.dim_schedule;
    if (!sched) return DIM_PEAK;
    if (closureReason(h, now)) return DIM_OFF;        // closed: weekend / holiday / school break
    if (hourInRanges(now.hour, sched.peak)) return DIM_PEAK;
    if (hourInRanges(now.hour, sched.off)) return DIM_OFF;
    return DIM_MEDIUM;
  }

  // True when "now" is inside this hotspot's prime window — the tightest
  // "best time to be near it" window (a subset of peak). Drives the
  // pulsing ring at the flag's pole base and the popup's "Prime time"
  // chip. A closed flag (weekend / holiday / school break) never pulses.
  function primeForHotspot(h, now) {
    const sched = h.dim_schedule;
    if (!sched) return false;
    if (closureReason(h, now)) return false;
    return hourInRanges(now.hour, sched.prime);
  }

  // ---------------------------------------------------------------
  // API helpers — match long-trips-block.feature.js
  // ---------------------------------------------------------------
  function apiBase() {
    try {
      // eslint-disable-next-line no-undef
      if (typeof RAILWAY_BASE === "string" && RAILWAY_BASE) return RAILWAY_BASE;
    } catch (_) {}
    if (typeof window !== "undefined" && window.API_BASE) {
      return String(window.API_BASE).replace(/\/+$/, "");
    }
    return "";
  }

  function authHeaders() {
    try {
      // eslint-disable-next-line no-undef
      if (typeof getCommunityAuthHeaders === "function") {
        const h = getCommunityAuthHeaders();
        return (h && typeof h === "object") ? h : {};
      }
    } catch (_) {}
    return {};
  }

  async function fetchHotspots() {
    const url = `${apiBase()}${HOTSPOT_ENDPOINT}?_=${Date.now()}`;
    const r = await fetch(url, {
      method: "GET",
      headers: authHeaders(),
      cache: "no-store",
    });
    if (!r.ok) {
      const err = new Error(`hotspots list ${r.status}`);
      err.status = r.status;
      err.url = url;
      throw err;
    }
    const data = await r.json();
    const list = Array.isArray(data?.hotspots) ? data.hotspots : [];
    return {
      hotspots: list.map(sanitize).filter(Boolean),
      calendar: sanitizeCalendar(data?.calendar),
    };
  }

  // Defensive parse of the backend closure calendar. Holidays must be
  // "YYYY-MM-DD"; seasonal ranges must be ["MM-DD","MM-DD"]. Anything
  // malformed is dropped, leaving an empty calendar (→ weekend-only
  // behavior), so an old/partial backend response degrades gracefully.
  function sanitizeCalendar(c) {
    const empty = { holidays: [], seasonal_closures: {} };
    if (!c || typeof c !== "object") return empty;
    const ymd = /^\d{4}-\d{2}-\d{2}$/;
    const holidays = Array.isArray(c.holidays)
      ? c.holidays.filter((s) => typeof s === "string" && ymd.test(s))
      : [];
    const seasonal = {};
    if (c.seasonal_closures && typeof c.seasonal_closures === "object") {
      for (const cat of Object.keys(c.seasonal_closures)) {
        const raw = c.seasonal_closures[cat];
        const ranges = Array.isArray(raw) ? raw.filter(
          (r) => Array.isArray(r) && r.length === 2 && ymd.test(r[0]) && ymd.test(r[1])
        ) : [];
        if (ranges.length) seasonal[cat] = ranges;
      }
    }
    return { holidays, seasonal_closures: seasonal };
  }

  function sanitize(h) {
    if (!h || typeof h !== "object") return null;
    const lat = Number(h.lat);
    const lng = Number(h.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const id = Number(h.id) || 0;
    const members = Array.isArray(h.members) ? h.members.map((m) => ({
      name: String(m?.name || ""),
      category: String(m?.category || ""),
      lat: Number(m?.lat),
      lng: Number(m?.lng),
      address: String(m?.address || "Address not listed"),
      best_hours: String(m?.best_hours || "Varies"),
    })).filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lng) && m.name) : [];
    const dim_schedule = sanitizeDimSchedule(h?.dim_schedule);
    return {
      id,
      lat, lng,
      label: String(h?.label || ""),
      dominant_category: String(h?.dominant_category || ""),
      member_count: Number(h?.member_count) || members.length,
      total_weight: Number(h?.total_weight) || 0,
      rationale: String(h?.rationale || ""),
      best_hours: String(h?.best_hours || ""),
      dim_schedule,
      members,
    };
  }

  function sanitizeDimSchedule(s) {
    if (!s || typeof s !== "object") {
      return { peak: [], off: [], prime: [], weekday_only: false };
    }
    const cleanRanges = (arr) => Array.isArray(arr) ? arr.map((r) => {
      if (!Array.isArray(r) || r.length < 2) return null;
      const a = Math.max(0, Math.min(24, Number(r[0])));
      const b = Math.max(0, Math.min(24, Number(r[1])));
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      return [a, b];
    }).filter(Boolean) : [];
    return {
      peak: cleanRanges(s.peak),
      off: cleanRanges(s.off),
      prime: cleanRanges(s.prime),
      weekday_only: Boolean(s.weekday_only),
    };
  }

  // Wider zoom-size curve so flags shrink at city-overview zooms (avoid
  // crowding) and grow at street-level zooms (clearly visible target).
  // Linear piecewise interpolation:
  //   z ≤ 10   → 0.35  (city overview — tiny)
  //   z 10–13  → 0.35 → 0.80
  //   z 13–15  → 0.80 → 1.20
  //   z 15–17  → 1.20 → 1.65
  //   z ≥ 17   → 1.65  (street level — bold)
  function flagZoomScale(z) {
    if (!Number.isFinite(z)) return 0.80;
    if (z <= 10) return 0.35;
    if (z >= 17) return 1.65;
    if (z <= 13) return 0.35 + (0.80 - 0.35) * ((z - 10) / 3);
    if (z <= 15) return 0.80 + (1.20 - 0.80) * ((z - 13) / 2);
    return 1.20 + (1.65 - 1.20) * ((z - 15) / 2);
  }

  // Z-order keeper — same idea as the 45+ flag layer. When zone style
  // reloads insert new layers, MapLibre would otherwise render them on
  // top of our flag/buildings. rAF-batched moveLayer keeps us at the
  // very top.
  function installZOrderKeeper() {
    if (zOrderListenerInstalled || !mapRef) return;
    zOrderListenerInstalled = true;
    // Pulse rings first so that, after each moveLayer-to-top sweep, they
    // end up below the buildings + flag (moved last) — a ground halo
    // under the pole rather than over the flag.
    const ids = [
      PULSE_GLOW_LAYER_ID, PULSE_RING1_LAYER_ID,
      BLDG_LAYER_ID, BLDG_LABEL_LAYER_ID,
    ];
    const scheduleMove = () => {
      if (zOrderInMove || zOrderMovePending) return;
      zOrderMovePending = true;
      const raf = (typeof window !== "undefined" && window.requestAnimationFrame)
        || ((fn) => setTimeout(fn, 16));
      raf(() => {
        zOrderMovePending = false;
        if (!mapRef) return;
        const presentIds = ids.filter((id) => mapRef.getLayer?.(id));
        if (!presentIds.length) return;
        // Skip when our layers are already the topmost, in order. moveLayer
        // always fires another "styledata" (even for a no-op move to the
        // top), which re-triggers this handler every frame and continuously
        // re-places the symbol building layer — that re-placement reads as
        // flashing. Only actually move when a style reload has knocked us
        // out of place. Defaults to moving if the order can't be read, so
        // there's no regression vs. the old always-move behavior.
        let order = null;
        try {
          order = (typeof mapRef.getLayersOrder === "function")
            ? mapRef.getLayersOrder()
            : (mapRef.getStyle?.()?.layers || []).map((l) => l.id);
        } catch (_) { order = null; }
        if (Array.isArray(order) && order.length >= presentIds.length) {
          const tail = order.slice(-presentIds.length);
          if (tail.every((id, i) => id === presentIds[i])) return;
        }
        zOrderInMove = true;
        try {
          // buildings → flag last so the flag sits on top of the dots.
          for (const id of presentIds) {
            try { mapRef.moveLayer(id); } catch (_) {}
          }
        } finally {
          zOrderInMove = false;
        }
      });
    };
    try { mapRef.on?.("styledata", scheduleMove); } catch (_) {}
  }

  // ---------------------------------------------------------------
  // Building marker layer — a small "building" sprite (simple gold
  // tower silhouette with windows) rendered via MapLibre's symbol
  // layer. We generate the sprite on a canvas and register it via
  // map.addImage() — that's reliable across every browser/device,
  // unlike Unicode emoji which depend on the device font.
  //
  // queryRenderedFeatures works against the symbol layer for click
  // hit-testing the same way it did for the previous circle layer.
  // ---------------------------------------------------------------
  function buildBuildingSprite() {
    // 80×80 canvas at 2× DPR. A single slim SKYSCRAPER — one tall
    // glass tower with a stepped setback, a gold crown and a roof
    // antenna. One clean focal tower per building (instead of a
    // 3-tower cluster) keeps the map uncluttered while still reading
    // as a downtown high-rise. Vertical window mullions survive
    // downscaling so it stays glassy at the small on-map icon sizes,
    // and the gold crown/antenna tie back to the dollar flag.
    const SIZE = 80;
    const canvas = document.createElement("canvas");
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.clearRect(0, 0, SIZE, SIZE);

    const BODY = "#1f2937";       // slate tower body
    const BORDER = "#a16207";     // dark amber border (flag border)
    const ROOF = "#fbbf24";       // gold crown / antenna (flag fill)
    const WINDOW_ON = "#fde68a";  // pale gold lit-window mullions

    const groundY = 76;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = BORDER;

    // Fill a tier with vertical glass mullions, then break them into
    // lit windows with thin horizontal floor bands.
    function glass(x, w, top, bottom, cols) {
      ctx.fillStyle = WINDOW_ON;
      const inset = 2.5, stripeW = 1.6;
      const gap = (w - inset * 2 - cols * stripeW) / (cols - 1);
      for (let c = 0; c < cols; c++) {
        ctx.fillRect(x + inset + c * (stripeW + gap), top, stripeW, bottom - top);
      }
      ctx.fillStyle = BODY;
      for (let fy = top + 5; fy < bottom - 2; fy += 7) {
        ctx.fillRect(x + 1.5, fy, w - 3, 1.3);
      }
    }

    // Main shaft (slim + tall = skyscraper proportions).
    ctx.fillStyle = BODY;
    ctx.fillRect(29, 26, 22, 50);
    ctx.strokeRect(29, 26, 22, 50);
    // Stepped setback tier sitting on the shaft.
    ctx.fillRect(34, 12, 12, 14);
    ctx.strokeRect(34, 12, 12, 14);
    // Gold crown cap.
    ctx.fillStyle = ROOF;
    ctx.fillRect(34, 9, 12, 3);
    ctx.strokeRect(34, 9, 12, 3);
    // Roof antenna — slim mast + finial ball.
    ctx.fillRect(39, 2, 2, 7);
    ctx.beginPath();
    ctx.arc(40, 2, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Glass curtain wall on both tiers.
    glass(29, 22, 29, 73, 4);
    glass(34, 12, 15, 24, 2);

    // Short street baseline grounding the tower.
    ctx.fillStyle = BORDER;
    ctx.fillRect(26, groundY, 28, 2);

    const img = ctx.getImageData(0, 0, SIZE, SIZE);
    return { width: SIZE, height: SIZE, data: img.data };
  }

  // ---------------------------------------------------------------
  // Per-category building sprites (80×80 @ 2× DPR, base near the bottom edge
  // so "icon-anchor":"bottom" plants them at the lat/lng). The generic tower
  // above (buildBuildingSprite) is the fallback; these add a distinct, bolder
  // building per category. Reuses the Major-Buildings drawing vocabulary.
  // ---------------------------------------------------------------
  const BLDG_SIZE = 80;
  function spriteFromDraw(drawFn) {
    const canvas = document.createElement("canvas");
    canvas.width = BLDG_SIZE;
    canvas.height = BLDG_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.clearRect(0, 0, BLDG_SIZE, BLDG_SIZE);
    ctx.lineJoin = "round";
    try { drawFn(ctx); } catch (_) { return null; }
    const img = ctx.getImageData(0, 0, BLDG_SIZE, BLDG_SIZE);
    return { width: BLDG_SIZE, height: BLDG_SIZE, data: img.data };
  }
  function bldgRoundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  // Shared wide block: cap + body + window grid + ground bar. The big emblem
  // is drawn on top by each caller. `P` = { body, border, window, cap }.
  function bldgWideBlock(ctx, P) {
    ctx.fillStyle = P.cap;
    bldgRoundRect(ctx, 19, 12, 42, 8, 3); ctx.fill();
    ctx.fillStyle = P.body; ctx.strokeStyle = P.border; ctx.lineWidth = 3;
    bldgRoundRect(ctx, 16, 18, 48, 56, 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = P.window;
    for (let ry = 25; ry <= 64; ry += 9) {
      for (let cx = 23; cx <= 53; cx += 9) ctx.fillRect(cx, ry, 5, 5);
    }
    ctx.fillStyle = P.border; ctx.fillRect(13, 74, 54, 4);
  }
  function bldgStar(ctx, cx, cy, spikes, outer, inner) {
    let rot = -Math.PI / 2;
    const step = Math.PI / spikes;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(rot) * outer, cy + Math.sin(rot) * outer);
    for (let i = 0; i < spikes; i++) {
      rot += step; ctx.lineTo(cx + Math.cos(rot) * inner, cy + Math.sin(rot) * inner);
      rot += step; ctx.lineTo(cx + Math.cos(rot) * outer, cy + Math.sin(rot) * outer);
    }
    ctx.closePath();
  }

  // hotel_luxury — gold block + white star + awning (matches Major Buildings).
  function drawHotelBldg(ctx) {
    bldgWideBlock(ctx, { body: "#f7c64f", border: "#92400e", window: "#cf962f", cap: "#92400e" });
    ctx.fillStyle = "#ffffff"; ctx.strokeStyle = "#92400e"; ctx.lineWidth = 1.6;
    bldgStar(ctx, 40, 45, 5, 14, 6); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#92400e";
    ctx.beginPath(); ctx.moveTo(28, 70); ctx.lineTo(52, 70); ctx.lineTo(48, 78); ctx.lineTo(32, 78); ctx.closePath(); ctx.fill();
  }
  // hospital — white/blue block + red cross (matches Major Buildings).
  function drawHospitalBldg(ctx) {
    bldgWideBlock(ctx, { body: "#eaf2fd", border: "#1d4ed8", window: "#9cc0f5", cap: "#1d4ed8" });
    const cx = 40, cy = 46, R = 14;
    ctx.fillStyle = "#ffffff"; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = "#dc2626"; ctx.stroke();
    ctx.fillStyle = "#dc2626"; const a = 3.6, l = 18;
    ctx.fillRect(cx - a, cy - l / 2, a * 2, l); ctx.fillRect(cx - l / 2, cy - a, l, a * 2);
  }
  // corporate — sleek blue-glass financial tower.
  function drawCorporateBldg(ctx) {
    const body = "#1e3a8a", border = "#1e40af", win = "#93c5fd";
    ctx.fillStyle = border; ctx.fillRect(25, 10, 30, 4);
    ctx.fillStyle = "#cbd5e1"; ctx.fillRect(39, 3, 2, 8);
    ctx.fillStyle = body; ctx.strokeStyle = border; ctx.lineWidth = 3;
    bldgRoundRect(ctx, 26, 14, 28, 60, 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = win;
    for (let ry = 19; ry <= 66; ry += 7) for (let cx = 30; cx <= 47; cx += 7) ctx.fillRect(cx, ry, 5, 4.5);
    ctx.save(); ctx.globalAlpha = 0.5; ctx.fillStyle = "#bfdbfe"; ctx.fillRect(30, 16, 4, 56); ctx.restore();
    ctx.fillStyle = border; ctx.fillRect(22, 74, 36, 4);
  }
  // airport — terminal + control tower + gliding plane.
  function drawAirportBldg(ctx) {
    const body = "#e5edf6", border = "#0369a1", win = "#7dd3fc";
    ctx.fillStyle = body; ctx.strokeStyle = border; ctx.lineWidth = 3;
    bldgRoundRect(ctx, 12, 46, 56, 28, 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = win; for (let cx = 18; cx <= 58; cx += 8) ctx.fillRect(cx, 53, 5, 14);
    ctx.fillStyle = body; ctx.strokeStyle = border;
    bldgRoundRect(ctx, 49, 22, 12, 26, 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = border; ctx.fillRect(48, 19, 14, 5);
    ctx.fillStyle = "#0369a1";
    ctx.save(); ctx.translate(28, 30); ctx.rotate(-0.5);
    ctx.fillRect(-1.6, -11, 3.2, 22); ctx.fillRect(-10, -2, 20, 3.2); ctx.fillRect(-4.5, 8, 9, 2.6);
    ctx.restore();
    ctx.fillStyle = border; ctx.fillRect(10, 74, 60, 4);
  }
  // transit_hub — station block + white subway roundel.
  function drawTransitBldg(ctx) {
    bldgWideBlock(ctx, { body: "#334155", border: "#0f766e", window: "#5eead4", cap: "#0f766e" });
    const cx = 40, cy = 46, R = 13;
    ctx.fillStyle = "#ffffff"; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#0f766e"; ctx.fillRect(cx - R, cy - 3, R * 2, 6);
    ctx.fillStyle = "#ffffff"; ctx.font = "900 13px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("M", cx, cy + 0.5);
  }
  // private_school — brick block + pennant + white mortarboard.
  function drawSchoolBldg(ctx) {
    bldgWideBlock(ctx, { body: "#b45309", border: "#7c2d12", window: "#fde68a", cap: "#7c2d12" });
    ctx.strokeStyle = "#7c2d12"; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(40, 6); ctx.lineTo(40, 18); ctx.stroke();
    ctx.fillStyle = "#dc2626"; ctx.beginPath(); ctx.moveTo(40, 6); ctx.lineTo(52, 9); ctx.lineTo(40, 12); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.beginPath(); ctx.moveTo(40, 38); ctx.lineTo(54, 44); ctx.lineTo(40, 50); ctx.lineTo(26, 44); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#1f2937"; ctx.fillRect(34, 46, 12, 6);
    ctx.strokeStyle = "#fde68a"; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(50, 45); ctx.lineTo(50, 54); ctx.stroke();
    ctx.fillStyle = "#fde68a"; ctx.beginPath(); ctx.arc(50, 55, 1.8, 0, Math.PI * 2); ctx.fill();
  }
  // private_club — deep-green block + gold crest + awning.
  function drawClubBldg(ctx) {
    bldgWideBlock(ctx, { body: "#166534", border: "#052e16", window: "#86efac", cap: "#052e16" });
    ctx.fillStyle = "#fbbf24"; ctx.strokeStyle = "#052e16"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(40, 36); ctx.lineTo(50, 40); ctx.lineTo(50, 48);
    ctx.quadraticCurveTo(50, 54, 40, 58); ctx.quadraticCurveTo(30, 54, 30, 48); ctx.lineTo(30, 40); ctx.closePath(); ctx.fill(); ctx.stroke();
    bldgStar(ctx, 40, 46, 5, 5.5, 2.4); ctx.fillStyle = "#052e16"; ctx.fill();
    ctx.fillStyle = "#052e16"; ctx.beginPath(); ctx.moveTo(28, 70); ctx.lineTo(52, 70); ctx.lineTo(48, 78); ctx.lineTo(32, 78); ctx.closePath(); ctx.fill();
  }
  // luxury_condo — residential tower with balcony bands.
  function drawCondoBldg(ctx) {
    const body = "#d6d3d1", border = "#57534e", rail = "#0891b2";
    ctx.fillStyle = border; ctx.fillRect(27, 12, 26, 4);
    ctx.fillStyle = body; ctx.strokeStyle = border; ctx.lineWidth = 3;
    bldgRoundRect(ctx, 26, 16, 28, 58, 3); ctx.fill(); ctx.stroke();
    ctx.fillStyle = rail; for (let y = 22; y <= 66; y += 8) ctx.fillRect(28, y, 24, 3);
    ctx.fillStyle = "#a8a29e"; for (let y = 26; y <= 66; y += 8) for (let cx = 31; cx <= 47; cx += 8) ctx.fillRect(cx, y, 5, 3);
    ctx.fillStyle = border; ctx.fillRect(23, 74, 34, 4);
  }
  // luxury_shopping — storefront + striped awning + shopping bag.
  function drawShoppingBldg(ctx) {
    bldgWideBlock(ctx, { body: "#fbcfe8", border: "#9d174d", window: "#fce7f3", cap: "#9d174d" });
    const ax = 16, aw = 48, ay = 40;
    for (let i = 0; i < 6; i++) { ctx.fillStyle = i % 2 ? "#ffffff" : "#db2777"; ctx.fillRect(ax + i * (aw / 6), ay, aw / 6, 7); }
    ctx.fillStyle = "#9d174d"; ctx.fillRect(ax, ay + 7, aw, 2);
    ctx.fillStyle = "#ffffff"; ctx.strokeStyle = "#9d174d"; ctx.lineWidth = 1.6;
    bldgRoundRect(ctx, 34, 52, 14, 16, 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(41, 53, 4, Math.PI, 0); ctx.stroke();
  }
  // performance — theater facade + gold marquee.
  function drawPerformanceBldg(ctx) {
    bldgWideBlock(ctx, { body: "#7f1d1d", border: "#450a0a", window: "#fca5a5", cap: "#450a0a" });
    ctx.fillStyle = "#f59e0b"; ctx.strokeStyle = "#fff7ed"; ctx.lineWidth = 1.4;
    bldgRoundRect(ctx, 22, 40, 36, 14, 3); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#fff7ed";
    for (let cx = 27; cx <= 53; cx += 6) { ctx.beginPath(); ctx.arc(cx, 40, 1.4, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.arc(cx, 54, 1.4, 0, Math.PI * 2); ctx.fill(); }
    bldgStar(ctx, 40, 47, 5, 5, 2.2); ctx.fillStyle = "#7f1d1d"; ctx.fill();
  }
  // stadium — arena bowl + floodlights.
  function drawStadiumBldg(ctx) {
    ctx.strokeStyle = "#9ca3af"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(20, 30); ctx.lineTo(20, 50); ctx.moveTo(60, 30); ctx.lineTo(60, 50); ctx.stroke();
    ctx.fillStyle = "#fde68a"; bldgRoundRect(ctx, 14, 24, 12, 8, 2); ctx.fill(); bldgRoundRect(ctx, 54, 24, 12, 8, 2); ctx.fill();
    ctx.fillStyle = "#e5e7eb"; ctx.strokeStyle = "#1f2937"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(40, 52, 28, 18, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#15803d"; ctx.beginPath(); ctx.ellipse(40, 52, 16, 9, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(40, 44); ctx.lineTo(40, 60); ctx.stroke();
  }
  // convention — wide curved hall + banner.
  function drawConventionBldg(ctx) {
    const body = "#0f766e", border = "#134e4a", win = "#5eead4";
    ctx.fillStyle = border; ctx.beginPath(); ctx.moveTo(12, 34); ctx.quadraticCurveTo(40, 18, 68, 34); ctx.lineTo(68, 40); ctx.lineTo(12, 40); ctx.closePath(); ctx.fill();
    ctx.fillStyle = body; ctx.strokeStyle = border; ctx.lineWidth = 3;
    bldgRoundRect(ctx, 14, 40, 52, 34, 3); ctx.fill(); ctx.stroke();
    ctx.fillStyle = win; for (let cx = 20; cx <= 58; cx += 8) ctx.fillRect(cx, 48, 5, 18);
    ctx.fillStyle = "#f59e0b"; ctx.fillRect(36, 22, 16, 12); ctx.fillStyle = "#134e4a"; ctx.fillRect(36, 22, 16, 3);
    ctx.fillStyle = border; ctx.fillRect(11, 74, 58, 4);
  }
  // tourist — stone monument / obelisk.
  function drawTouristBldg(ctx) {
    const stone = "#e7e5e4", border = "#78716c", cap = "#0ea5e9";
    ctx.fillStyle = stone; ctx.strokeStyle = border; ctx.lineWidth = 3;
    bldgRoundRect(ctx, 28, 60, 24, 14, 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(40, 8); ctx.lineTo(46, 60); ctx.lineTo(34, 60); ctx.closePath();
    ctx.fillStyle = stone; ctx.fill(); ctx.stroke();
    ctx.fillStyle = cap; ctx.beginPath(); ctx.moveTo(40, 8); ctx.lineTo(44, 16); ctx.lineTo(36, 16); ctx.closePath(); ctx.fill();
    ctx.fillStyle = border; ctx.fillRect(22, 74, 36, 4);
  }

  const BLDG_CATEGORY_DRAW = {
    "lth-bldg-hotel": drawHotelBldg,
    "lth-bldg-hospital": drawHospitalBldg,
    "lth-bldg-corporate": drawCorporateBldg,
    "lth-bldg-airport": drawAirportBldg,
    "lth-bldg-transit": drawTransitBldg,
    "lth-bldg-school": drawSchoolBldg,
    "lth-bldg-club": drawClubBldg,
    "lth-bldg-condo": drawCondoBldg,
    "lth-bldg-shopping": drawShoppingBldg,
    "lth-bldg-performance": drawPerformanceBldg,
    "lth-bldg-stadium": drawStadiumBldg,
    "lth-bldg-convention": drawConventionBldg,
    "lth-bldg-tourist": drawTouristBldg,
  };

  function ensureBuildingSpriteRegistered() {
    if (!mapRef) return;
    const add = (id, sprite) => {
      if (!sprite || mapRef.hasImage?.(id)) return;
      try { mapRef.addImage(id, sprite, { pixelRatio: 2 }); }
      catch (e) { console.warn("[lth] sprite registration failed:", id, e); }
    };
    // Generic fallback tower (unchanged design).
    add(BLDG_IMAGE_ID, buildBuildingSprite());
    // One distinct building per category.
    for (const id of Object.keys(BLDG_CATEGORY_DRAW)) add(id, spriteFromDraw(BLDG_CATEGORY_DRAW[id]));
  }

  // Data-driven icon-image: each member's category maps to its own sprite, with
  // the generic tower as the fallback for any unmapped category.
  function buildingIconImageExpr() {
    const expr = ["match", ["get", "category"]];
    for (const cat of Object.keys(BLDG_SPRITE_BY_CATEGORY)) expr.push(cat, BLDG_SPRITE_BY_CATEGORY[cat]);
    expr.push(BLDG_IMAGE_ID);
    return expr;
  }

  function buildingsGeoJSON() {
    const now = nycHourAndDay();
    const features = [];
    for (const h of hotspots) {
      const dim = dimForHotspot(h, now);
      const prime = primeForHotspot(h, now);
      for (const m of h.members) {
        features.push({
          type: "Feature",
          properties: {
            hotspot_id: h.id,
            name: m.name,
            category: m.category,
            address: m.address,
            best_hours: m.best_hours,
            dim,
            prime,
          },
          geometry: { type: "Point", coordinates: [m.lng, m.lat] },
        });
      }
    }
    return { type: "FeatureCollection", features };
  }

  function ensureBuildingsLayer() {
    if (!mapRef) return;
    if (!mapRef.getSource?.(BLDG_SOURCE_ID)) {
      try {
        mapRef.addSource(BLDG_SOURCE_ID, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
      } catch (e) {
        console.warn("[lth] buildings source add failed:", e);
        return;
      }
    }
    // Register the building sprite (idempotent) before adding the
    // symbol layer that references it.
    ensureBuildingSpriteRegistered();

    if (!mapRef.getLayer?.(BLDG_LAYER_ID)) {
      try {
        mapRef.addLayer({
          id: BLDG_LAYER_ID,
          type: "symbol",
          source: BLDG_SOURCE_ID,
          minzoom: BLDG_MIN_ZOOM, // hidden at city-overview zooms
          // Hide a hotspot's buildings unless it is in its prime window — the
          // cluster only appears (with its flag + pulse) at the best pickup
          // hours, and is absent from the map otherwise.
          filter: ["==", ["get", "prime"], true],
          layout: {
            "icon-image": buildingIconImageExpr(),
            // Slimmer size curve. Each hotspot renders 3+ building
            // sprites, so the previous 0.65–1.55 curve made clusters
            // look bulky and crowded the map. Scaled down ~40% — the
            // skyline still reads, but markers no longer dominate.
            "icon-size": [
              "interpolate", ["linear"], ["zoom"],
              BLDG_MIN_ZOOM, 0.38,
              14, 0.52,
              16, 0.70,
              18, 0.92,
            ],
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
            "icon-anchor": "bottom", // anchor the building base at the lat/lng
          },
          paint: {
            // Data-driven dim — each feature carries its parent
            // hotspot's current dim value (recomputed every minute
            // by the dim tick).
            "icon-opacity": ["coalesce", ["get", "dim"], 0.95],
          },
        });
      } catch (e) {
        console.warn("[lth] buildings layer add failed:", e);
      }
    }

    // Separate text-only NAME label layer. Kept apart from the icon layer so
    // the names can appear from a much farther-out zoom than the building
    // sprites — the building icons are unchanged. Collision-deconflicted so it
    // stays legible even at city scale.
    if (!mapRef.getLayer?.(BLDG_LABEL_LAYER_ID)) {
      try {
        mapRef.addLayer({
          id: BLDG_LABEL_LAYER_ID,
          type: "symbol",
          source: BLDG_SOURCE_ID,
          minzoom: BLDG_LABEL_MIN_ZOOM,
          filter: ["==", ["get", "prime"], true],
          layout: {
            "text-field": ["get", "name"],
            "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
            "text-size": ["interpolate", ["linear"], ["zoom"], 10, 9, 13, 10.5, 17, 13],
            "text-anchor": "top",
            "text-offset": [0, 0.5],
            "text-max-width": 7,
            "text-allow-overlap": false,
          },
          paint: {
            "text-color": "#111827",
            "text-halo-color": "#ffffff",
            "text-halo-width": 1.4,
            "text-opacity": ["coalesce", ["get", "dim"], 0.95],
          },
        });
      } catch (e) {
        console.warn("[lth] buildings label layer add failed:", e);
      }
    }
  }

  function syncBuildingsLayer() {
    if (!mapRef) return;
    const src = mapRef.getSource?.(BLDG_SOURCE_ID);
    if (src?.setData) {
      try { src.setData(buildingsGeoJSON()); } catch (_) {}
    }
  }

  // ---------------------------------------------------------------
  // Prime-time pulse — gold beacon at the flag's pole base
  // ---------------------------------------------------------------
  // The source holds one point per flag currently in its prime window.
  // Two stroke-only "radar" rings expand + fade out of phase, over a
  // steady soft glow. Animated only while ≥1 flag is prime, throttled to
  // ~30fps, and paused while the tab is hidden.
  function ensurePulseLayers() {
    if (!mapRef) return;
    if (!mapRef.getSource?.(PULSE_SOURCE_ID)) {
      try {
        mapRef.addSource(PULSE_SOURCE_ID, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
      } catch (e) {
        console.warn("[lth] pulse source add failed:", e);
        return;
      }
    }
    // Steady soft glow sitting at the pole base.
    if (!mapRef.getLayer?.(PULSE_GLOW_LAYER_ID)) {
      try {
        mapRef.addLayer({
          id: PULSE_GLOW_LAYER_ID,
          type: "circle",
          source: PULSE_SOURCE_ID,
          paint: {
            "circle-radius": 9,
            "circle-color": PULSE_COLOR,
            "circle-opacity": 0.2,
            "circle-blur": 0.6,
            "circle-stroke-width": 0,
          },
        });
      } catch (e) { console.warn("[lth] pulse glow add failed:", e); }
    }
    // Single stroke-only ring; radius + stroke-opacity driven by the loop.
    if (!mapRef.getLayer?.(PULSE_RING1_LAYER_ID)) {
      try {
        mapRef.addLayer({
          id: PULSE_RING1_LAYER_ID,
          type: "circle",
          source: PULSE_SOURCE_ID,
          paint: {
            "circle-radius": PULSE_R_MIN,
            "circle-color": "rgba(0,0,0,0)",   // ring only — no fill
            "circle-opacity": 0,
            "circle-stroke-color": PULSE_COLOR,
            "circle-stroke-width": 3.5,
            "circle-stroke-opacity": 0,
          },
        });
      } catch (e) { console.warn("[lth] pulse ring add failed:", e); }
    }
  }

  function pulseGeoJSON(now) {
    const features = [];
    for (const h of hotspots) {
      if (!primeForHotspot(h, now)) continue;
      features.push({
        type: "Feature",
        properties: { hotspot_id: h.id },
        geometry: { type: "Point", coordinates: [h.lng, h.lat] },
      });
    }
    return { type: "FeatureCollection", features };
  }

  // Recompute which flags are in prime time; (re)start or stop the loop.
  function syncPulseLayer() {
    if (!mapRef) return;
    const src = mapRef.getSource?.(PULSE_SOURCE_ID);
    if (!src?.setData) return;
    const fc = pulseGeoJSON(nycHourAndDay());
    try { src.setData(fc); } catch (_) {}
    if (fc.features.length > 0) startPulse();
    else stopPulse();
  }

  function _now() {
    return (typeof performance !== "undefined" && performance.now)
      ? performance.now() : Date.now();
  }
  function _raf(fn) {
    if (typeof window !== "undefined" && window.requestAnimationFrame) {
      return window.requestAnimationFrame(fn);
    }
    return setTimeout(() => fn(_now()), PULSE_FPS_MS);
  }

  function setRing(layerId, t, zScale) {
    if (!mapRef?.getLayer?.(layerId)) return;
    const r = (PULSE_R_MIN + t * (PULSE_R_MAX - PULSE_R_MIN)) * zScale;
    const op = 0.85 * (1 - t); // fade as the ring grows
    try {
      mapRef.setPaintProperty(layerId, "circle-radius", r);
      mapRef.setPaintProperty(layerId, "circle-stroke-opacity", op);
    } catch (_) {}
  }

  function pulseFrame(ts) {
    if (!pulseActive) { pulseRAF = null; return; }
    // Throttle the paint pushes to ~30fps; the rAF itself is cheap.
    if (ts - pulseLastPaint >= PULSE_FPS_MS) {
      pulseLastPaint = ts;
      const zScale = flagZoomScale(mapRef?.getZoom?.());
      const t = (ts % PULSE_PERIOD_MS) / PULSE_PERIOD_MS; // 0..1
      setRing(PULSE_RING1_LAYER_ID, t, zScale);
      if (mapRef?.getLayer?.(PULSE_GLOW_LAYER_ID)) {
        // Gentle breathing on the steady glow.
        const glow = 0.16 + 0.12 * (0.5 + 0.5 * Math.sin(ts / 600));
        try {
          mapRef.setPaintProperty(PULSE_GLOW_LAYER_ID, "circle-radius", 9 * zScale);
          mapRef.setPaintProperty(PULSE_GLOW_LAYER_ID, "circle-opacity", glow);
        } catch (_) {}
      }
    }
    pulseRAF = _raf(pulseFrame);
  }

  function startPulse() {
    if (pulseActive) return;
    if (typeof document !== "undefined" && document.hidden) return;
    pulseActive = true;
    pulseLastPaint = 0;
    pulseRAF = _raf(pulseFrame);
  }

  function stopPulse() {
    pulseActive = false;
    if (pulseRAF != null && typeof window !== "undefined" && window.cancelAnimationFrame) {
      try { window.cancelAnimationFrame(pulseRAF); } catch (_) {}
    }
    pulseRAF = null;
  }

  // ---------------------------------------------------------------
  // Layer setup
  // ---------------------------------------------------------------
  function ensureFlagLayer() {
    if (useLayer || layerInitStarted || !mapRef) return;
    if (!mapRef.isStyleLoaded?.()) {
      layerInitStarted = true;
      let attempts = 0;
      const pollHandle = setInterval(() => {
        attempts += 1;
        if (useLayer) { clearInterval(pollHandle); return; }
        if (attempts >= 100) {
          clearInterval(pollHandle);
          layerInitStarted = false;
          console.warn("[lth] ensureFlagLayer poll timed out after 30s");
          return;
        }
        if (!mapRef?.isStyleLoaded?.()) return;
        clearInterval(pollHandle);
        layerInitStarted = false;
        ensureFlagLayer();
      }, 300);
      return;
    }
    layerInitStarted = true;
    try {
      ensurePulseLayers();
      ensureBuildingsLayer();

      // The gold "$" dollar flag has been retired — only the per-category
      // buildings + the prime-time pulse render now. The old WebGL flag layer
      // is no longer added (its now-dead code is removed in the Strategic
      // Points merge). "Ready" is gated on the buildings layer, which used to
      // ride on the flag layer being present.
      if (mapRef.getLayer?.(BLDG_LAYER_ID)) {
        useLayer = true;
        installZOrderKeeper();
        syncBuildingsLayer();
        syncPulseLayer();
        console.info(`[lth] hotspot buildings + pulse ready; ${hotspots.length} hotspot(s)`);
      }
    } catch (e) {
      console.warn("[lth] ensureFlagLayer failed:", e);
      layerInitStarted = false;
    }
  }

  // Re-evaluate dim every minute. Cheap (rebuilds 17 vertex slots in
  // the flag VBO and reshuffles the buildings GeoJSON), idempotent
  // when the hour hasn't changed.
  function tickDim() {
    if (!useLayer) return;
    syncBuildingsLayer();
    syncPulseLayer();
  }

  // ---------------------------------------------------------------
  // Click handling — CPU hit-test for the flag, queryRenderedFeatures
  // for the building dots (those are a built-in circle layer).
  // ---------------------------------------------------------------
  function hotspotAtScreenPoint(point) {
    if (!useLayer || !mapRef || typeof mapRef.project !== "function") return null;
    // The cluster summary now opens by tapping near a prime hotspot's center
    // (where the pulse sits) — this replaces the old "$" flag tap target. Only
    // prime hotspots are tappable, matching when the buildings + pulse show.
    const TAP_R = 22; // px tolerance around the hotspot center
    const now = nycHourAndDay();
    let best = null;
    let bestDist = Infinity;
    for (const h of hotspots) {
      if (!primeForHotspot(h, now)) continue;
      let screen;
      try { screen = mapRef.project([h.lng, h.lat]); } catch (_) { continue; }
      const d = Math.hypot(point.x - screen.x, point.y - screen.y);
      if (d <= TAP_R && d < bestDist) { bestDist = d; best = h; }
    }
    return best;
  }

  function buildingAtScreenPoint(point) {
    if (!mapRef?.queryRenderedFeatures) return null;
    if (!mapRef.getLayer?.(BLDG_LAYER_ID)) return null;
    try {
      // 12px tap-tolerance box around the click point.
      const box = [
        [point.x - 12, point.y - 12],
        [point.x + 12, point.y + 12],
      ];
      const feats = mapRef.queryRenderedFeatures(box, { layers: [BLDG_LAYER_ID] });
      if (feats && feats.length) return feats[0];
    } catch (_) {}
    return null;
  }

  // ---------------------------------------------------------------
  // Popup UI — lightweight DOM overlay anchored to the map container.
  // No MapLibre Popup dependency so it works whether the map exposes
  // it or not.
  // ---------------------------------------------------------------
  let activePopup = null;

  function closePopup() {
    if (activePopup) {
      try { activePopup.remove(); } catch (_) {}
      activePopup = null;
    }
  }

  function showPopup(html, screenPoint) {
    closePopup();
    const container = mapRef?.getCanvasContainer?.();
    if (!container) return;
    const popup = document.createElement("div");
    popup.className = "lth-popup";
    popup.innerHTML = html;
    // Position relative to the map container.
    const left = Math.max(8, Math.min(container.clientWidth - 280, screenPoint.x - 140));
    const top = Math.max(8, screenPoint.y - 16);
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
    popup.style.transform = "translateY(-100%)";
    // Close on background tap; stopPropagation inside so the popup
    // itself doesn't close when the driver taps an item.
    popup.addEventListener("click", (e) => { e.stopPropagation(); });
    popup.addEventListener("touchstart", (e) => { e.stopPropagation(); }, { passive: true });
    const closeBtn = document.createElement("button");
    closeBtn.className = "lth-popup-close";
    closeBtn.type = "button";
    closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.addEventListener("click", closePopup);
    popup.appendChild(closeBtn);
    container.appendChild(popup);
    activePopup = popup;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function flagPopupHtml(h) {
    const items = h.members.slice().sort((a, b) => a.name.localeCompare(b.name)).map((m) => `
      <li class="lth-popup-item">
        <div class="lth-popup-bldg">${escapeHtml(m.name)}</div>
        <div class="lth-popup-addr">${escapeHtml(m.address)}</div>
      </li>
    `).join("");
    // Rationale + best-hours + intensity together explain WHY this is
    // a hotspot, not just WHICH buildings are in it. The intensity
    // (total_weight) is shown rounded — it's an internal score
    // (~5 → minimum cluster, ~17+ → strongest in the city) so we just
    // round it instead of pretending it's a meaningful unit.
    const rationale = h.rationale ? `
      <div class="lth-popup-row">
        <b>Why this is a hotspot</b>
        <div>${escapeHtml(h.rationale)}</div>
      </div>
    ` : "";
    const bestHours = h.best_hours ? `
      <div class="lth-popup-row">
        <b>Best hours</b>
        <div>${escapeHtml(h.best_hours)}</div>
      </div>
    ` : "";
    const intensity = Number.isFinite(h.total_weight) && h.total_weight > 0
      ? `<span class="lth-popup-intensity">Intensity ${h.total_weight.toFixed(1)}</span>`
      : "";
    // Live time-of-day state — a verbal echo of the visual. A closure
    // (weekend / holiday / school break) outranks everything; otherwise
    // "Prime time" (the pulsing window) outranks the peak/steady/off dim.
    const nowTod = nycHourAndDay();
    const closed = closureReason(h, nowTod);
    const isPrime = !closed && primeForHotspot(h, nowTod);
    const dimNow = dimForHotspot(h, nowTod);
    let dimLabel = "";
    let dimClass = "";
    let stateSuffix = " now";
    if (closed) {
      dimClass = "lth-popup-state-off";
      stateSuffix = "";
      dimLabel = closed === "holiday" ? "Closed today (holiday)"
               : closed === "break" ? "Closed (school break)"
               : "Closed weekends";
    }
    else if (isPrime) { dimLabel = "Prime time"; dimClass = "lth-popup-state-prime"; }
    else if (dimNow >= DIM_PEAK - 0.01) { dimLabel = "Peak hours"; dimClass = "lth-popup-state-peak"; }
    else if (dimNow <= DIM_OFF + 0.01) { dimLabel = "Off hours"; dimClass = "lth-popup-state-off"; }
    else { dimLabel = "Steady"; dimClass = "lth-popup-state-medium"; }
    const stateDot = isPrime ? `<span class="lth-pulse-dot"></span>` : "";
    const stateChip = `<span class="lth-popup-state ${dimClass}">${stateDot}${dimLabel}${stateSuffix}</span>`;
    return `
      <div class="lth-popup-header">
        <span class="lth-popup-dollar">★</span>
        <div>
          <div class="lth-popup-title">Long-trip hotspot</div>
          <div class="lth-popup-sub">
            ${escapeHtml(h.member_count)} buildings nearby
            ${intensity}
            ${stateChip}
          </div>
        </div>
      </div>
      ${rationale}
      ${bestHours}
      <div class="lth-popup-row">
        <b>Buildings represented</b>
        <ul class="lth-popup-list">${items}</ul>
      </div>
      <div class="lth-popup-hint">Tap a building dot for its hours.</div>
    `;
  }

  function buildingPopupHtml(props) {
    return `
      <div class="lth-popup-header">
        <span class="lth-popup-bldg-icon">●</span>
        <div>
          <div class="lth-popup-title">${escapeHtml(props.name)}</div>
          <div class="lth-popup-sub">${escapeHtml(props.category).replace(/_/g, " ")}</div>
        </div>
      </div>
      <div class="lth-popup-row"><b>Address</b><div>${escapeHtml(props.address)}</div></div>
      <div class="lth-popup-row"><b>Best hours</b><div>${escapeHtml(props.best_hours)}</div></div>
    `;
  }

  // The zone-popup click handler in app.js is registered before ours
  // and there's no way to stop its propagation in MapLibre. So when
  // our handler detects a flag/building hit, we close the zone popup
  // that the earlier handler just opened.
  function closeAnyZonePopup() {
    try {
      document.querySelectorAll(".maplibregl-popup").forEach((node) => {
        try { node.remove(); } catch (_) {}
      });
    } catch (_) {}
  }

  function attachClickHandler(map) {
    map.on("click", (e) => {
      const pt = e.point;
      // 1. Building icon has priority — it's smaller and more specific.
      const feat = buildingAtScreenPoint(pt);
      if (feat) {
        closeAnyZonePopup();
        showPopup(buildingPopupHtml(feat.properties || {}), pt);
        return;
      }
      // 2. Hotspot flag (CPU hit-test against the WebGL quads).
      const h = hotspotAtScreenPoint(pt);
      if (h) {
        closeAnyZonePopup();
        showPopup(flagPopupHtml(h), pt);
        return;
      }
      // 3. Tap on empty map (or a bare zone) closes our popup; the
      // zone popup handler will decide whether to open the zone one.
      closePopup();
    });
    map.on("movestart", closePopup);
  }

  // ---------------------------------------------------------------
  // CSS
  // ---------------------------------------------------------------
  function injectCss() {
    if (document.getElementById("lth-pins-css")) return;
    const style = document.createElement("style");
    style.id = "lth-pins-css";
    style.textContent = `
      .lth-popup {
        position: absolute;
        z-index: 1300;
        background: #ffffff;
        color: #111827;
        border-radius: 12px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.18);
        padding: 12px 14px 10px;
        width: 280px;
        max-height: 60vh;
        overflow-y: auto;
        font: 13px/1.4 -apple-system, system-ui, sans-serif;
        pointer-events: auto;
      }
      .lth-popup-close {
        position: absolute;
        top: 4px; right: 6px;
        background: transparent;
        border: none;
        font: 700 22px/1 -apple-system, system-ui, sans-serif;
        color: #6b7280;
        cursor: pointer;
        padding: 2px 8px;
      }
      .lth-popup-close:hover { color: #111827; }
      .lth-popup-header {
        display: flex; align-items: center; gap: 10px;
        padding-right: 22px; margin-bottom: 8px;
      }
      .lth-popup-dollar {
        display: inline-flex; align-items: center; justify-content: center;
        width: 28px; height: 28px;
        background: #fbbf24; color: #1f2937;
        border: 1.5px solid #a16207;
        border-radius: 50%;
        font: 800 16px -apple-system, system-ui, sans-serif;
        flex-shrink: 0;
      }
      .lth-popup-bldg-icon {
        display: inline-flex; align-items: center; justify-content: center;
        width: 22px; height: 22px;
        background: #fbbf24; color: #1f2937;
        border: 1.5px solid #a16207;
        border-radius: 50%;
        font: 700 14px -apple-system, system-ui, sans-serif;
        flex-shrink: 0;
      }
      .lth-popup-title { font-weight: 700; font-size: 14px; }
      .lth-popup-sub  { color: #6b7280; font-size: 11px; text-transform: capitalize; }
      .lth-popup-intensity {
        display: inline-block; margin-left: 6px;
        padding: 1px 6px;
        background: #ecfdf5; color: #047857;
        border-radius: 8px;
        font-size: 10.5px; font-weight: 700;
        text-transform: none; letter-spacing: 0;
      }
      .lth-popup-state {
        display: inline-block; margin-left: 6px;
        padding: 1px 6px;
        border-radius: 8px;
        font-size: 10.5px; font-weight: 700;
        text-transform: none; letter-spacing: 0;
      }
      .lth-popup-state-peak    { background: #ecfdf5; color: #047857; }
      .lth-popup-state-medium  { background: #fef3c7; color: #92400e; }
      .lth-popup-state-off     { background: #f1f5f9; color: #475569; }
      .lth-popup-state-prime   { background: #fff7ed; color: #b45309; }
      .lth-pulse-dot {
        display: inline-block;
        width: 7px; height: 7px;
        margin-right: 4px;
        border-radius: 50%;
        background: #f59e0b;
        vertical-align: middle;
        animation: lth-pulse-dot 1.4s ease-out infinite;
      }
      @keyframes lth-pulse-dot {
        0%   { box-shadow: 0 0 0 0 rgba(245,158,11,0.55); }
        70%  { box-shadow: 0 0 0 6px rgba(245,158,11,0); }
        100% { box-shadow: 0 0 0 0 rgba(245,158,11,0); }
      }
      .lth-popup-list {
        list-style: none; padding: 0; margin: 4px 0 0;
      }
      .lth-popup-item {
        padding: 6px 0;
        border-bottom: 1px solid #f3f4f6;
      }
      .lth-popup-bldg { font-weight: 600; font-size: 12.5px; }
      .lth-popup-addr { color: #4b5563; font-size: 11.5px; margin-top: 1px; }
      .lth-popup-hint { color: #6b7280; font-size: 10.5px; font-style: italic; margin-top: 4px; }
      .lth-popup-row {
        margin-top: 6px;
        padding-top: 6px;
        border-top: 1px solid #f3f4f6;
      }
      .lth-popup-row b {
        display: block; font-size: 10.5px; color: #6b7280;
        text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px;
      }
      .lth-popup-row div { font-size: 12.5px; color: #111827; }
    `;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------
  // Init + refresh loop
  // ---------------------------------------------------------------
  async function refresh() {
    try {
      const res = await fetchHotspots();
      hotspots = res.hotspots;
      calendar = res.calendar;
      console.info(`[lth] loaded ${hotspots.length} hotspot(s) from /long_trip_hotspots`);
      ensureFlagLayer();
      syncBuildingsLayer();
      syncPulseLayer();
    } catch (e) {
      console.warn("[lth] fetch failed:", e?.message || e);
    }
  }

  async function init(map) {
    if (initDone) return;
    initDone = true;
    mapRef = map;
    injectCss();
    console.info(`[lth] init: API base = ${apiBase() || "(empty)"}; auth = ${Object.keys(authHeaders()).length ? "yes" : "NO TOKEN"}`);

    attachClickHandler(map);
    await refresh();
    // Re-poll periodically so admin rebuilds appear without a full
    // page reload.
    setInterval(refresh, REFRESH_INTERVAL_MS);
    // Re-evaluate the time-of-day dim every minute so a flag visibly
    // dims/brightens when its category crosses a peak/off boundary
    // (e.g. a hotel cluster crossing midnight, or a corporate
    // cluster crossing 8am).
    setInterval(tickDim, DIM_TICK_INTERVAL_MS);
    // Pause the pulse animation while the tab is hidden (battery); on
    // return, re-sync so it resumes only if a flag is still in prime.
    if (typeof document !== "undefined" && document.addEventListener) {
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) stopPulse();
        else syncPulseLayer();
      });
    }
  }

  function resolveMapInstance() {
    try {
      // eslint-disable-next-line no-undef
      if (typeof map !== "undefined" && map) return map;
    } catch (_) {}
    if (typeof window !== "undefined") {
      if (window.map) return window.map;
      if (window.tlcMap) return window.tlcMap;
      if (window.TlcMapUiInternals?.getMap) {
        try { return window.TlcMapUiInternals.getMap(); } catch (_) {}
      }
    }
    return null;
  }

  function waitForMap() {
    const candidate = resolveMapInstance();
    if (candidate
      && typeof candidate.getCanvasContainer === "function"
      && typeof candidate.unproject === "function"
      && typeof candidate.on === "function") {
      try {
        init(candidate);
        console.info("[lth] initialized");
      } catch (e) {
        console.warn("[lth] init failed:", e);
      }
      return;
    }
    setTimeout(waitForMap, 200);
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    waitForMap();
  } else {
    document.addEventListener("DOMContentLoaded", waitForMap);
  }

  window.LongTripHotspotsFeature = {
    refresh,
    getHotspots: () => hotspots.map((h) => ({ ...h, members: h.members.map((m) => ({ ...m })) })),
  };
})();


// ============================ 2) MAJOR BUILDINGS ==============================
// Major NYC landmark buildings — a standalone, read-only map layer that
// shows individual MAJOR hospitals and hotels with distinct, identifiable
// icons and a time-of-day "pulse" when a pickup is most likely (hotels in
// the morning checkout window, hospitals in the afternoon discharge window).
//
// Deliberately separate from the long-trip dollar-flag system: no flags, no
// clustering, no backend — just a curated static list of landmarks rendered
// as MapLibre symbol (icons + names) and circle (pulse) layers. Read-only.
(function () {
  "use strict";

  // ---------------------------------------------------------------
  // Curated data — genuinely MAJOR NYC hospitals + hotels, citywide.
  // Coordinates reused from the hand-curated backend long-trip POI list
  // plus public addresses. `type` ("hospital" | "hotel") drives the icon
  // shape, the pulse color, and the prime (best-pickup) window.
  // ---------------------------------------------------------------
  const LANDMARKS = [
    // ---- Major hospitals ----
    ["hospital", "NewYork-Presbyterian / Weill Cornell", 40.7646, -73.9543, "525 E 68th St, Manhattan"],
    ["hospital", "NewYork-Presbyterian / Columbia", 40.8418, -73.9419, "630 W 168th St, Manhattan"],
    ["hospital", "NYU Langone (Tisch Hospital)", 40.7421, -73.9744, "550 1st Ave, Manhattan"],
    ["hospital", "Mount Sinai Hospital", 40.7894, -73.9529, "1468 Madison Ave, Manhattan"],
    ["hospital", "Mount Sinai West", 40.7706, -73.9876, "1000 10th Ave, Manhattan"],
    ["hospital", "Mount Sinai Morningside", 40.8044, -73.9609, "1111 Amsterdam Ave, Manhattan"],
    ["hospital", "Mount Sinai Beth Israel", 40.7325, -73.9824, "281 1st Ave, Manhattan"],
    ["hospital", "Bellevue Hospital", 40.7392, -73.9759, "462 1st Ave, Manhattan"],
    ["hospital", "Memorial Sloan Kettering", 40.7644, -73.9568, "1275 York Ave, Manhattan"],
    ["hospital", "Hospital for Special Surgery", 40.7649, -73.9560, "535 E 70th St, Manhattan"],
    ["hospital", "Lenox Hill Hospital", 40.7740, -73.9601, "100 E 77th St, Manhattan"],
    ["hospital", "NYP Lower Manhattan", 40.7102, -74.0033, "170 William St, Manhattan"],
    ["hospital", "Montefiore Medical Center", 40.8810, -73.8779, "111 E 210th St, Bronx"],
    ["hospital", "Lincoln Medical Center", 40.8175, -73.9251, "234 E 149th St, Bronx"],
    ["hospital", "Maimonides Medical Center", 40.6363, -73.9931, "4802 10th Ave, Brooklyn"],
    ["hospital", "SUNY Downstate / Kings County", 40.6557, -73.9472, "451 Clarkson Ave, Brooklyn"],
    ["hospital", "Elmhurst Hospital Center", 40.7448, -73.8829, "79-01 Broadway, Queens"],
    ["hospital", "NewYork-Presbyterian Queens", 40.7656, -73.8268, "56-45 Main St, Queens"],
    ["hospital", "Staten Island University Hospital", 40.5832, -74.0884, "475 Seaview Ave, Staten Island"],
    // ---- Major hotels ----
    ["hotel", "The Plaza", 40.7644, -73.9743, "768 5th Ave, Manhattan"],
    ["hotel", "Waldorf Astoria New York", 40.7560, -73.9744, "301 Park Ave, Manhattan"],
    ["hotel", "The St. Regis New York", 40.7615, -73.9742, "2 E 55th St, Manhattan"],
    ["hotel", "The Pierre", 40.7676, -73.9719, "2 E 61st St, Manhattan"],
    ["hotel", "Mandarin Oriental New York", 40.7686, -73.9819, "80 Columbus Cir, Manhattan"],
    ["hotel", "Lotte New York Palace", 40.7585, -73.9742, "455 Madison Ave, Manhattan"],
    ["hotel", "The Ritz-Carlton Central Park", 40.7659, -73.9776, "50 Central Park S, Manhattan"],
    ["hotel", "The Peninsula New York", 40.7617, -73.9754, "700 5th Ave, Manhattan"],
    ["hotel", "Four Seasons Downtown", 40.7137, -74.0083, "27 Barclay St, Manhattan"],
    ["hotel", "New York Marriott Marquis", 40.7589, -73.9854, "1535 Broadway, Manhattan"],
    ["hotel", "New York Hilton Midtown", 40.7621, -73.9789, "1335 6th Ave, Manhattan"],
    ["hotel", "Sheraton New York Times Square", 40.7625, -73.9826, "811 7th Ave, Manhattan"],
    ["hotel", "The Carlyle", 40.7747, -73.9633, "35 E 76th St, Manhattan"],
    ["hotel", "The Mark Hotel", 40.7740, -73.9618, "25 E 77th St, Manhattan"],
    ["hotel", "Park Hyatt New York", 40.7659, -73.9817, "153 W 57th St, Manhattan"],
    ["hotel", "The Knickerbocker", 40.7563, -73.9854, "6 Times Square, Manhattan"],
    ["hotel", "Conrad New York Downtown", 40.7144, -74.0152, "102 North End Ave, Manhattan"],
    ["hotel", "The Beekman", 40.7113, -74.0064, "123 Nassau St, Manhattan"],
    ["hotel", "1 Hotel Brooklyn Bridge", 40.7032, -73.9931, "60 Furman St, Brooklyn"],
  ].map(([type, name, lat, lng, address]) => ({ type, name, lat, lng, address }));

  // Per-type metadata. `prime` = NYC-local hour windows when a pickup is
  // most likely, grounded in research:
  //   - hotels: standard checkout is 11am–noon, so guests depart (often to
  //     the airport) across the morning → best window ~7am–noon.
  //   - hospitals: ~55% of discharges are in the afternoon (with structured
  //     2–3pm reassessment), so the discharge-pickup wave is ~noon–5pm.
  //     Open 24/7, so they are never "closed", just off-peak.
  const TYPE_INFO = {
    hospital: {
      label: "Major hospital",
      prime: [[12, 17]],
      bestHours: "Discharges peak afternoon ~1–5pm · open 24/7",
      color: "#ef4444",
      emblem: "✙", // heavy cross
    },
    hotel: {
      label: "Major hotel",
      prime: [[7, 12]],
      bestHours: "Checkout 11am–noon · morning airport runs ~7am–noon",
      color: "#f59e0b",
      emblem: "★", // star
    },
  };

  const SRC_ID = "mbf-landmarks";
  const ICON_LAYER_ID = "mbf-icons";
  const LABEL_LAYER_ID = "mbf-labels";
  const PULSE_SRC_ID = "mbf-pulse";
  const PULSE_GLOW_ID = "mbf-pulse-glow";
  const PULSE_RING1_ID = "mbf-pulse-ring1";
  const SPRITE_HOSPITAL = "mbf-sprite-hospital";
  const SPRITE_HOTEL = "mbf-sprite-hotel";
  const MIN_ZOOM = 11;        // show landmarks from mid-borough scale up
  const LABEL_MIN_ZOOM = 11;  // show the building NAME from a mid-borough zoom
  const REFRESH_MS = 60 * 1000;
  const PULSE_PERIOD_MS = 2200;
  const PULSE_R_MIN = 7;
  const PULSE_R_MAX = 20;
  const PULSE_FPS_MS = 33;
  // Pulse de-clutter: collapse overlapping pulse rings by SCREEN distance
  // so clustered landmarks and nearby dollar-flag pulses don't pile up.
  const MIN_PULSE_GAP_PX = 58;   // min screen gap between two landmark pulses
  const FLAG_PULSE_GAP_PX = 44;  // keep landmark pulses clear of flag pulses

  let mapRef = null;
  let initDone = false;
  let layersReady = false;
  let zOrderInstalled = false;
  let pulseActive = false;
  let pulseRAF = null;
  let pulseLastPaint = 0;

  // ---------------------------------------------------------------
  // NYC-local time + prime evaluation (DST-correct via Intl).
  // ---------------------------------------------------------------
  function nycHour() {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit",
      }).formatToParts(new Date());
      for (const p of parts) if (p.type === "hour") return Number(p.value) || 0;
      return 0;
    } catch (_) { return new Date().getUTCHours(); }
  }

  function hourInRanges(hour, ranges) {
    if (!Array.isArray(ranges)) return false;
    for (const r of ranges) {
      if (!Array.isArray(r) || r.length < 2) continue;
      const a = r[0], b = r[1];
      if (a <= b) { if (hour >= a && hour < b) return true; }
      else { if (hour >= a || hour < b) return true; }
    }
    return false;
  }

  function isPrimeNow(type, hour) {
    const info = TYPE_INFO[type];
    return info ? hourInRanges(hour, info.prime) : false;
  }

  // ---------------------------------------------------------------
  // Sprites — distinct, identifiable building icons per type.
  //   hospital: white tower + blue trim + bold red medical cross
  //   hotel:    gold tower + window bands + white star + entrance awning
  // Generated on a canvas and registered via map.addImage — reliable on
  // every device, unlike emoji which depend on the system font.
  // ---------------------------------------------------------------
  function spriteData(draw) {
    const SIZE = 80;
    const canvas = document.createElement("canvas");
    canvas.width = SIZE; canvas.height = SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.clearRect(0, 0, SIZE, SIZE);
    draw(ctx);
    return { width: SIZE, height: SIZE, data: ctx.getImageData(0, 0, SIZE, SIZE).data };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // A bold, WIDE building block — far easier to read on the map than a slim
  // tower — with a flat roof cap, a window grid, and a ground bar. The big
  // type emblem (cross / star) is drawn on top by the per-type functions.
  // `P` = { body, border, window, cap } palette.
  function drawWideBuilding(ctx, P) {
    ctx.lineJoin = "round";
    // Flat roof cap.
    ctx.fillStyle = P.cap;
    roundRect(ctx, 19, 12, 42, 8, 3); ctx.fill();
    // Main body (wide block).
    ctx.fillStyle = P.body;
    ctx.strokeStyle = P.border;
    ctx.lineWidth = 3;
    roundRect(ctx, 16, 18, 48, 56, 4);
    ctx.fill(); ctx.stroke();
    // Window grid.
    ctx.fillStyle = P.window;
    for (let ry = 25; ry <= 64; ry += 9) {
      for (let cx = 23; cx <= 53; cx += 9) ctx.fillRect(cx, ry, 5, 5);
    }
    // Ground bar.
    ctx.fillStyle = P.border;
    ctx.fillRect(13, 74, 54, 4);
  }

  function starPath(ctx, cx, cy, spikes, outer, inner) {
    let rot = -Math.PI / 2;
    const step = Math.PI / spikes;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(rot) * outer, cy + Math.sin(rot) * outer);
    for (let i = 0; i < spikes; i++) {
      rot += step;
      ctx.lineTo(cx + Math.cos(rot) * inner, cy + Math.sin(rot) * inner);
      rot += step;
      ctx.lineTo(cx + Math.cos(rot) * outer, cy + Math.sin(rot) * outer);
    }
    ctx.closePath();
  }

  function drawHospital(ctx) {
    // Bold white-and-blue hospital block with a BIG red medical cross.
    drawWideBuilding(ctx, { body: "#eaf2fd", border: "#1d4ed8", window: "#9cc0f5", cap: "#1d4ed8" });
    const cx = 40, cy = 46, R = 14;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = "#dc2626"; ctx.stroke();
    ctx.fillStyle = "#dc2626";
    const a = 3.6, l = 18;
    ctx.fillRect(cx - a, cy - l / 2, a * 2, l);
    ctx.fillRect(cx - l / 2, cy - a, l, a * 2);
  }

  function drawHotel(ctx) {
    // Bold amber-gold hotel block with a BIG star + entrance awning.
    drawWideBuilding(ctx, { body: "#f7c64f", border: "#92400e", window: "#cf962f", cap: "#92400e" });
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#92400e";
    ctx.lineWidth = 1.6;
    starPath(ctx, 40, 45, 5, 14, 6);
    ctx.fill(); ctx.stroke();
    // Entrance awning at the base.
    ctx.fillStyle = "#92400e";
    ctx.beginPath();
    ctx.moveTo(28, 70); ctx.lineTo(52, 70); ctx.lineTo(48, 78); ctx.lineTo(32, 78);
    ctx.closePath(); ctx.fill();
  }

  function ensureSprites() {
    if (!mapRef) return;
    if (!mapRef.hasImage?.(SPRITE_HOSPITAL)) {
      const s = spriteData(drawHospital);
      if (s) { try { mapRef.addImage(SPRITE_HOSPITAL, s, { pixelRatio: 2 }); } catch (_) {} }
    }
    if (!mapRef.hasImage?.(SPRITE_HOTEL)) {
      const s = spriteData(drawHotel);
      if (s) { try { mapRef.addImage(SPRITE_HOTEL, s, { pixelRatio: 2 }); } catch (_) {} }
    }
  }

  // ---------------------------------------------------------------
  // GeoJSON
  // ---------------------------------------------------------------
  // The dense Midtown cluster (Times Sq / 5th Ave / Central Park South) is
  // the only crowded area, so ONLY its landmarks are shrunk at zoom-out (via
  // a data-driven icon-size keyed to this `midtown` flag). Everywhere else
  // keeps the normal size. The box captures the Midtown hotels but excludes
  // the UES medical row and the downtown / outer-borough landmarks.
  function isMidtown(lat, lng) {
    return lat >= 40.748 && lat <= 40.771 && lng >= -73.993 && lng <= -73.969;
  }

  function landmarksGeoJSON() {
    const hour = nycHour();
    return {
      type: "FeatureCollection",
      features: LANDMARKS.map((L, i) => ({
        type: "Feature",
        properties: {
          idx: i, type: L.type, name: L.name, address: L.address,
          midtown: isMidtown(L.lat, L.lng),
          prime: isPrimeNow(L.type, hour),
        },
        geometry: { type: "Point", coordinates: [L.lng, L.lat] },
      })),
    };
  }

  // Screen positions of the dollar-flag hotspots (if that feature is
  // loaded), so landmark pulses can stay clear of the flag pulses.
  function flagScreenPoints() {
    try {
      const hs = window.LongTripHotspotsFeature?.getHotspots?.();
      if (!Array.isArray(hs) || typeof mapRef?.project !== "function") return [];
      const pts = [];
      for (const h of hs) {
        if (!Number.isFinite(h?.lat) || !Number.isFinite(h?.lng)) continue;
        try { pts.push(mapRef.project([h.lng, h.lat])); } catch (_) {}
      }
      return pts;
    } catch (_) { return []; }
  }

  // The set of prime-time landmarks to actually PULSE, thinned in SCREEN
  // space so overlapping rings don't pile up: drop any that sit too close
  // to an already-kept pulse or to a dollar-flag pulse. Recomputed on
  // move/zoom, so the set adapts to scale — denser at street level, sparse
  // when zoomed out. (Icons are never thinned; only the rings.)
  function thinnedPulseGeoJSON() {
    const hour = nycHour();
    const prime = LANDMARKS.filter((L) => isPrimeNow(L.type, hour));
    const toFeature = (L) => ({
      type: "Feature",
      properties: { type: L.type },
      geometry: { type: "Point", coordinates: [L.lng, L.lat] },
    });
    if (!prime.length || typeof mapRef?.project !== "function") {
      return { type: "FeatureCollection", features: prime.map(toFeature) };
    }
    const flagPts = flagScreenPoints();
    const keptPx = [];
    const kept = [];
    for (const L of prime) {
      let px;
      try { px = mapRef.project([L.lng, L.lat]); } catch (_) { continue; }
      let blocked = false;
      for (const f of flagPts) {
        if (Math.hypot(px.x - f.x, px.y - f.y) < FLAG_PULSE_GAP_PX) { blocked = true; break; }
      }
      if (!blocked) {
        for (const k of keptPx) {
          if (Math.hypot(px.x - k.x, px.y - k.y) < MIN_PULSE_GAP_PX) { blocked = true; break; }
        }
      }
      if (blocked) continue;
      kept.push(L);
      keptPx.push(px);
    }
    return { type: "FeatureCollection", features: kept.map(toFeature) };
  }

  // ---------------------------------------------------------------
  // Layer setup
  // ---------------------------------------------------------------
  function ensureLayers() {
    if (!mapRef || layersReady) return;
    if (!mapRef.isStyleLoaded?.()) return;
    try {
      ensureSprites();

      if (!mapRef.getSource(SRC_ID)) {
        mapRef.addSource(SRC_ID, { type: "geojson", data: landmarksGeoJSON() });
      }
      if (!mapRef.getSource(PULSE_SRC_ID)) {
        mapRef.addSource(PULSE_SRC_ID, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      }

      // Unified gold Strategic Points pulse (was keyed to building type — the
      // building SPRITES keep their per-type colors; only the pulse is gold).
      const colorByType = "#fbbf24";

      // Pulse: a steady glow + two expanding stroke rings, below the icons.
      if (!mapRef.getLayer(PULSE_GLOW_ID)) {
        mapRef.addLayer({
          id: PULSE_GLOW_ID, type: "circle", source: PULSE_SRC_ID, minzoom: MIN_ZOOM,
          paint: {
            "circle-radius": 10, "circle-color": colorByType,
            "circle-opacity": 0.16, "circle-blur": 0.6, "circle-stroke-width": 0,
          },
        });
      }
      if (!mapRef.getLayer(PULSE_RING1_ID)) {
        mapRef.addLayer({
          id: PULSE_RING1_ID, type: "circle", source: PULSE_SRC_ID, minzoom: MIN_ZOOM,
          paint: {
            "circle-radius": PULSE_R_MIN, "circle-color": "rgba(0,0,0,0)",
            "circle-opacity": 0, "circle-stroke-color": colorByType,
            "circle-stroke-width": 3.5, "circle-stroke-opacity": 0,
          },
        });
      }

      // Building icons (distinct sprite per type).
      if (!mapRef.getLayer(ICON_LAYER_ID)) {
        mapRef.addLayer({
          id: ICON_LAYER_ID, type: "symbol", source: SRC_ID, minzoom: MIN_ZOOM,
          // Only show a landmark while it is in its prime pickup window
          // (hotels: checkout mornings; hospitals: the discharge window).
          filter: ["==", ["get", "prime"], true],
          layout: {
            "icon-image": ["match", ["get", "type"], "hospital", SPRITE_HOSPITAL, SPRITE_HOTEL],
            // Per-feature size. The dense Midtown cluster is shrunk hard at
            // zoom-out so it doesn't blob together at a distance (converging
            // to full size by z18). Everything else is the original size
            // scaled to 80% (a uniform 20% smaller, per request). First
            // value in each case = Midtown, second = elsewhere.
            "icon-size": ["interpolate", ["linear"], ["zoom"],
              11, ["case", ["get", "midtown"], 0.24, 0.40],
              14, ["case", ["get", "midtown"], 0.42, 0.59],
              16, ["case", ["get", "midtown"], 0.72, 0.74],
              18, ["case", ["get", "midtown"], 1.12, 0.90],
            ],
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
            "icon-anchor": "bottom",
          },
        });
      }

      // Type tag ABOVE each building — "HOSPITAL" / "HOTEL" — so it's
      // instantly clear what the building is. Colored by type, sits just
      // above the icon, shown from a neighborhood zoom up. (The full name
      // is in the tap popup.)
      if (!mapRef.getLayer(LABEL_LAYER_ID)) {
        mapRef.addLayer({
          id: LABEL_LAYER_ID, type: "symbol", source: SRC_ID, minzoom: LABEL_MIN_ZOOM,
          filter: ["==", ["get", "prime"], true],
          layout: {
            // The building NAME (the icon already shows hospital vs hotel),
            // from a mid-borough zoom; collision keeps it legible.
            "text-field": ["get", "name"],
            "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
            "text-size": ["interpolate", ["linear"], ["zoom"], 11, 9.5, 16, 12, 18, 14],
            "text-anchor": "bottom", "text-offset": [0, -2.4],
            "text-letter-spacing": 0.02, "text-padding": 6,
            "text-max-width": 8, "text-optional": true,
            "text-allow-overlap": false,
          },
          paint: {
            "text-color": ["match", ["get", "type"], "hospital", "#dc2626", "#b45309"],
            "text-halo-color": "#ffffff", "text-halo-width": 2.2,
          },
        });
      }

      layersReady = true;
      installZOrderKeeper();
      syncPulse();
      console.info(`[mbf] major-buildings layer ready; ${LANDMARKS.length} landmarks`);
    } catch (e) {
      console.warn("[mbf] ensureLayers failed:", e);
    }
  }

  // Keep our layers on top, and re-add them if a full style reload drops
  // the source/layers (mirrors the long-trip layer's z-order keeper).
  function installZOrderKeeper() {
    if (zOrderInstalled || !mapRef) return;
    zOrderInstalled = true;
    const ids = [PULSE_GLOW_ID, PULSE_RING1_ID, ICON_LAYER_ID, LABEL_LAYER_ID];
    let pending = false;
    const onStyle = () => {
      if (pending) return;
      pending = true;
      const raf = (typeof window !== "undefined" && window.requestAnimationFrame) || ((fn) => setTimeout(fn, 16));
      raf(() => {
        pending = false;
        if (!mapRef) return;
        // Only act when a full style reload has actually dropped our layers:
        // re-add them and lift them once. We deliberately do NOT moveLayer on
        // every styledata — the flag system runs its own z-order keeper, and
        // two keepers each lifting to the top re-trigger each other's
        // styledata every frame (moveLayer fires styledata), which makes the
        // icons flash. Adding once + recovering on reload is enough.
        if (mapRef.getSource?.(SRC_ID) && mapRef.getLayer?.(ICON_LAYER_ID)) return;
        layersReady = false;
        ensureLayers();
        for (const id of ids) {
          if (mapRef.getLayer?.(id)) { try { mapRef.moveLayer(id); } catch (_) {} }
        }
      });
    };
    try { mapRef.on?.("styledata", onStyle); } catch (_) {}
  }

  // ---------------------------------------------------------------
  // Pulse animation — runs only while >=1 landmark is in its prime
  // window, throttled to ~30fps, paused while the tab is hidden.
  // ---------------------------------------------------------------
  function rafSchedule(fn) {
    if (typeof window !== "undefined" && window.requestAnimationFrame) return window.requestAnimationFrame(fn);
    return setTimeout(() => fn(typeof performance !== "undefined" ? performance.now() : Date.now()), PULSE_FPS_MS);
  }

  function pulseZoomScale(z) {
    if (!Number.isFinite(z)) return 0.8;
    if (z <= 11) return 0.5;
    if (z >= 18) return 1.25;
    return 0.5 + (z - 11) / 7 * 0.75;
  }

  function setRing(id, t, zScale) {
    if (!mapRef?.getLayer?.(id)) return;
    const r = (PULSE_R_MIN + t * (PULSE_R_MAX - PULSE_R_MIN)) * zScale;
    const op = 0.85 * (1 - t);
    try {
      mapRef.setPaintProperty(id, "circle-radius", r);
      mapRef.setPaintProperty(id, "circle-stroke-opacity", op);
    } catch (_) {}
  }

  function pulseFrame(ts) {
    if (!pulseActive) { pulseRAF = null; return; }
    if (ts - pulseLastPaint >= PULSE_FPS_MS) {
      pulseLastPaint = ts;
      const z = pulseZoomScale(mapRef?.getZoom?.());
      const t = (ts % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
      setRing(PULSE_RING1_ID, t, z);
      if (mapRef?.getLayer?.(PULSE_GLOW_ID)) {
        const glow = 0.14 + 0.10 * (0.5 + 0.5 * Math.sin(ts / 600));
        try {
          mapRef.setPaintProperty(PULSE_GLOW_ID, "circle-radius", 10 * z);
          mapRef.setPaintProperty(PULSE_GLOW_ID, "circle-opacity", glow);
        } catch (_) {}
      }
    }
    pulseRAF = rafSchedule(pulseFrame);
  }

  function startPulse() {
    if (pulseActive) return;
    if (typeof document !== "undefined" && document.hidden) return;
    pulseActive = true;
    pulseLastPaint = 0;
    pulseRAF = rafSchedule(pulseFrame);
  }

  function stopPulse() {
    pulseActive = false;
    if (pulseRAF != null && typeof window !== "undefined" && window.cancelAnimationFrame) {
      try { window.cancelAnimationFrame(pulseRAF); } catch (_) {}
    }
    pulseRAF = null;
  }

  // Rebuild the icon/label source each minute so each landmark's `prime`
  // flag tracks the clock — the building only shows during its prime pickup
  // window and is hidden from the map otherwise.
  function syncIcons() {
    if (!mapRef || !layersReady) return;
    const src = mapRef.getSource?.(SRC_ID);
    if (src?.setData) { try { src.setData(landmarksGeoJSON()); } catch (_) {} }
  }

  function syncPulse() {
    if (!mapRef || !layersReady) return;
    const src = mapRef.getSource?.(PULSE_SRC_ID);
    if (!src?.setData) return;
    const fc = thinnedPulseGeoJSON();
    try { src.setData(fc); } catch (_) {}
    if (fc.features.length > 0) startPulse();
    else stopPulse();
  }

  // ---------------------------------------------------------------
  // Click popup — lightweight DOM overlay in the map container.
  // ---------------------------------------------------------------
  let activePopup = null;

  function closePopup() {
    if (activePopup) { try { activePopup.remove(); } catch (_) {} activePopup = null; }
  }

  function closeZonePopups() {
    try {
      document.querySelectorAll(".maplibregl-popup, .mapboxgl-popup").forEach((n) => {
        try { n.remove(); } catch (_) {}
      });
    } catch (_) {}
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function landmarkPopupHtml(p) {
    const info = TYPE_INFO[p.type] || TYPE_INFO.hotel;
    const prime = isPrimeNow(p.type, nycHour());
    const chip = prime
      ? `<span class="mbf-chip mbf-chip-prime"><span class="mbf-dot"></span>Prime pickup now</span>`
      : `<span class="mbf-chip mbf-chip-off">Off-peak now</span>`;
    return `
      <div class="mbf-pop-head">
        <span class="mbf-pop-emblem mbf-pop-${escapeHtml(p.type)}">${info.emblem}</span>
        <div>
          <div class="mbf-pop-title">${escapeHtml(p.name)}</div>
          <div class="mbf-pop-sub">${escapeHtml(info.label)} ${chip}</div>
        </div>
      </div>
      <div class="mbf-pop-row"><b>Address</b><div>${escapeHtml(p.address)}</div></div>
      <div class="mbf-pop-row"><b>Best pickup hours</b><div>${escapeHtml(info.bestHours)}</div></div>
    `;
  }

  function showPopup(html, point) {
    closePopup();
    const container = mapRef?.getCanvasContainer?.();
    if (!container) return;
    const popup = document.createElement("div");
    popup.className = "mbf-popup";
    popup.innerHTML = html;
    const left = Math.max(8, Math.min(container.clientWidth - 272, point.x - 132));
    const top = Math.max(8, point.y - 16);
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
    popup.style.transform = "translateY(-100%)";
    popup.addEventListener("click", (e) => e.stopPropagation());
    popup.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
    const close = document.createElement("button");
    close.className = "mbf-popup-close";
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", closePopup);
    popup.appendChild(close);
    container.appendChild(popup);
    activePopup = popup;
  }

  function landmarkAt(point) {
    if (!mapRef?.queryRenderedFeatures || !mapRef.getLayer?.(ICON_LAYER_ID)) return null;
    try {
      const box = [[point.x - 14, point.y - 14], [point.x + 14, point.y + 14]];
      const feats = mapRef.queryRenderedFeatures(box, { layers: [ICON_LAYER_ID] });
      if (feats && feats.length) return feats[0];
    } catch (_) {}
    return null;
  }

  function attachClick(map) {
    map.on("click", (e) => {
      if (!layersReady) return;
      const f = landmarkAt(e.point);
      if (f) {
        closeZonePopups();
        showPopup(landmarkPopupHtml(f.properties || {}), e.point);
      } else {
        closePopup();
      }
    });
    map.on("movestart", closePopup);
    // Re-thin the pulse set when the view settles, so overlapping rings
    // collapse/expand with zoom.
    map.on("moveend", syncPulse);
  }

  // ---------------------------------------------------------------
  // CSS
  // ---------------------------------------------------------------
  function injectCss() {
    if (document.getElementById("mbf-css")) return;
    const style = document.createElement("style");
    style.id = "mbf-css";
    style.textContent = `
      .mbf-popup {
        position: absolute; z-index: 1300;
        background: #fff; color: #111827; border-radius: 12px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.18);
        padding: 12px 14px 10px; width: 272px; max-height: 56vh; overflow-y: auto;
        font: 13px/1.4 -apple-system, system-ui, sans-serif; pointer-events: auto;
      }
      .mbf-popup-close {
        position: absolute; top: 4px; right: 6px; background: transparent; border: none;
        font: 700 22px/1 -apple-system, system-ui, sans-serif; color: #6b7280; cursor: pointer; padding: 2px 8px;
      }
      .mbf-popup-close:hover { color: #111827; }
      .mbf-pop-head { display: flex; align-items: center; gap: 10px; padding-right: 22px; margin-bottom: 8px; }
      .mbf-pop-emblem {
        display: inline-flex; align-items: center; justify-content: center;
        width: 30px; height: 30px; border-radius: 8px; flex-shrink: 0;
        font-size: 17px; font-weight: 800; color: #fff;
      }
      .mbf-pop-hospital { background: #ef4444; }
      .mbf-pop-hotel { background: #f59e0b; }
      .mbf-pop-title { font-weight: 700; font-size: 14px; }
      .mbf-pop-sub { color: #6b7280; font-size: 11px; margin-top: 1px; }
      .mbf-chip {
        display: inline-block; margin-left: 4px; padding: 1px 6px; border-radius: 8px;
        font-size: 10.5px; font-weight: 700;
      }
      .mbf-chip-prime { background: #fff7ed; color: #b45309; }
      .mbf-chip-off { background: #f1f5f9; color: #475569; }
      .mbf-dot {
        display: inline-block; width: 7px; height: 7px; margin-right: 4px;
        border-radius: 50%; background: #f59e0b; vertical-align: middle;
        animation: mbf-dot 1.4s ease-out infinite;
      }
      @keyframes mbf-dot {
        0% { box-shadow: 0 0 0 0 rgba(245,158,11,0.55); }
        70% { box-shadow: 0 0 0 6px rgba(245,158,11,0); }
        100% { box-shadow: 0 0 0 0 rgba(245,158,11,0); }
      }
      .mbf-pop-row { margin-top: 6px; padding-top: 6px; border-top: 1px solid #f3f4f6; }
      .mbf-pop-row b { display: block; font-size: 10.5px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
      .mbf-pop-row div { font-size: 12.5px; color: #111827; }
    `;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------
  function init(map) {
    if (initDone) return;
    initDone = true;
    mapRef = map;
    injectCss();
    attachClick(map);

    let attempts = 0;
    const poll = setInterval(() => {
      attempts += 1;
      if (layersReady) { clearInterval(poll); return; }
      if (attempts > 150) { clearInterval(poll); console.warn("[mbf] style not ready after 45s"); return; }
      if (mapRef?.isStyleLoaded?.()) ensureLayers();
    }, 300);

    // Re-evaluate which landmarks are in their prime window every minute —
    // refresh both the icons (show/hide) and the pulse set.
    setInterval(() => { syncIcons(); syncPulse(); }, REFRESH_MS);

    if (typeof document !== "undefined" && document.addEventListener) {
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) stopPulse();
        else { syncIcons(); syncPulse(); }
      });
    }
    console.info("[mbf] initialized");
  }

  function resolveMap() {
    try { if (typeof map !== "undefined" && map) return map; } catch (_) {}
    if (typeof window !== "undefined") {
      if (window.map) return window.map;
      if (window.tlcMap) return window.tlcMap;
      if (window.TlcMapUiInternals?.getMap) {
        try { return window.TlcMapUiInternals.getMap(); } catch (_) {}
      }
    }
    return null;
  }

  function waitForMap() {
    const m = resolveMap();
    if (m && typeof m.getCanvasContainer === "function" && typeof m.on === "function") {
      try { init(m); } catch (e) { console.warn("[mbf] init failed:", e); }
      return;
    }
    setTimeout(waitForMap, 200);
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    waitForMap();
  } else {
    document.addEventListener("DOMContentLoaded", waitForMap);
  }

  window.MajorBuildingsFeature = {
    refresh: syncPulse,
    getLandmarks: () => LANDMARKS.map((L) => ({ ...L })),
  };
})();


// ============================ 3) NIGHTLIFE DISTRICTS ==========================
// Nightlife & dining districts — pickup pulse on the map.
//
// Parallel of long-trip-hotspots-pins.feature.js, for the after-dark crowd:
// the backend (GET /nightlife_districts) serves curated clusters of upscale
// restaurants + bars/clubs. We drop one magenta cocktail-glass pin per
// district and pulse it during the LET-OUT window — dinner let-out through
// last call (later on Fri/Sat) — the best time to be parked nearby. Distinct
// magenta keeps it visually separate from the gold dollar-flag prime pulse.
//
// Self-contained IIFE (same pattern as the other *.feature.js): no imports,
// computes the time-of-day dim + pulse client-side from each district's
// dim_schedule (prime = weeknight, prime_weekend = Fri/Sat; hour ranges wrap
// past midnight). Nightlife never "closes", so there is no holiday calendar.
(function () {
  "use strict";

  const ENDPOINT = "/nightlife_districts";
  const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // re-poll (admin rebuild / seed)
  const TICK_INTERVAL_MS = 60 * 1000;        // re-evaluate dim + pulse each min

  const SRC_ID = "nld-src";
  const ICON_LAYER_ID = "nld-icons";
  const LABEL_LAYER_ID = "nld-labels";
  const PULSE_GLOW_ID = "nld-pulse-glow";
  const PULSE_RING1_ID = "nld-pulse-ring1";
  const SPRITE_ID = "nld-sprite-cocktail";

  const MIN_ZOOM = 9;   // pulse + pins visible from the city-overview zoom
  const LABEL_MIN_ZOOM = 13;

  // Magenta cocktail-pin identity stays; the PULSE is now the unified gold of
  // the Strategic Points system (one gold pulse for every point type).
  const PIN_COLOR = "#ec4899";
  const PIN_DARK = "#9d174d";
  const PULSE_COLOR = "#fbbf24";
  const PULSE_PERIOD_MS = 2200;  // calm single-pulse cycle
  const PULSE_R_MIN = 8;
  const PULSE_R_MAX = 20;        // one compact inner ring
  const PULSE_FPS_MS = 33;

  const DIM_PEAK = 1.0;     // open + busy hours
  const DIM_MEDIUM = 0.9;   // open, off-peak
  const DIM_OFF = 0.28;     // closed/quiet (daytime)

  let mapRef = null;
  let districts = [];
  let layersReady = false;
  let pulseActive = false;
  let pulseRAF = null;
  let pulseLastPaint = 0;
  let zOrderInstalled = false;
  let zOrderPending = false;
  let zOrderInMove = false;

  // ---------------------------------------------------------------
  // API helpers — match long-trip-hotspots-pins.feature.js
  // ---------------------------------------------------------------
  function apiBase() {
    try {
      // eslint-disable-next-line no-undef
      if (typeof RAILWAY_BASE === "string" && RAILWAY_BASE) return RAILWAY_BASE;
    } catch (_) {}
    if (typeof window !== "undefined" && window.API_BASE) {
      return String(window.API_BASE).replace(/\/+$/, "");
    }
    return "";
  }
  function authHeaders() {
    try {
      // eslint-disable-next-line no-undef
      if (typeof getCommunityAuthHeaders === "function") {
        const h = getCommunityAuthHeaders();
        return (h && typeof h === "object") ? h : {};
      }
    } catch (_) {}
    return {};
  }

  // ---------------------------------------------------------------
  // NYC time-of-day + let-out window
  // ---------------------------------------------------------------
  function nycNightContext() {
    // { hour: 0-23, weekday: 0(Sun)-6(Sat), isWeekendNight }
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York", weekday: "short", hour: "numeric", hour12: false,
      }).formatToParts(new Date());
      let hour = 0, wdName = "Sun";
      for (const p of parts) {
        if (p.type === "hour") hour = parseInt(p.value, 10) % 24;
        if (p.type === "weekday") wdName = p.value;
      }
      const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wdName] ?? 0;
      // Weekend nights = Fri & Sat nights, each running to ~5am the next day.
      const isWeekendNight =
        (wd === 5 && hour >= 17) ||
        (wd === 6 && (hour >= 17 || hour < 5)) ||
        (wd === 0 && hour < 5);
      return { hour, weekday: wd, isWeekendNight };
    } catch (_) {
      const d = new Date();
      return { hour: d.getUTCHours(), weekday: d.getUTCDay(), isWeekendNight: false };
    }
  }

  // Hour ranges may wrap past midnight: [21, 2] = 9pm-2am.
  function hourInRanges(hour, ranges) {
    if (!Array.isArray(ranges) || !ranges.length) return false;
    for (const r of ranges) {
      if (!Array.isArray(r) || r.length < 2) continue;
      const a = r[0], b = r[1];
      if (a <= b) { if (hour >= a && hour < b) return true; }
      else { if (hour >= a || hour < b) return true; }
    }
    return false;
  }

  function primeRanges(sched, ctx) {
    // Fri/Sat nights run later — use prime_weekend when available.
    if (ctx.isWeekendNight && Array.isArray(sched.prime_weekend) && sched.prime_weekend.length) {
      return sched.prime_weekend;
    }
    return sched.prime || [];
  }
  function isPrime(d, ctx) {
    const s = d.dim_schedule;
    return !!s && hourInRanges(ctx.hour, primeRanges(s, ctx));
  }
  function dimFor(d, ctx) {
    const s = d.dim_schedule;
    if (!s) return DIM_MEDIUM;
    if (isPrime(d, ctx)) return DIM_PEAK;
    if (hourInRanges(ctx.hour, s.peak)) return DIM_PEAK;
    if (hourInRanges(ctx.hour, s.off)) return DIM_OFF;
    return DIM_MEDIUM;
  }

  // ---------------------------------------------------------------
  // Sprite — a magenta map-pin with a white cocktail (martini) glass
  // ---------------------------------------------------------------
  function spriteData() {
    const SIZE = 80;
    const canvas = document.createElement("canvas");
    canvas.width = SIZE; canvas.height = SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.clearRect(0, 0, SIZE, SIZE);
    // Teardrop pin, bottom-anchored at the district.
    ctx.lineJoin = "round";
    ctx.fillStyle = PIN_COLOR;
    ctx.strokeStyle = PIN_DARK;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(40, 30, 20, Math.PI * 0.85, Math.PI * 0.15, false);
    ctx.lineTo(40, 74);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // White martini glass emblem.
    ctx.fillStyle = "#ffffff";
    ctx.beginPath(); ctx.moveTo(31, 22); ctx.lineTo(49, 22); ctx.lineTo(40, 33); ctx.closePath(); ctx.fill(); // bowl
    ctx.fillRect(39, 33, 2, 9);   // stem
    ctx.fillRect(34, 42, 12, 2);  // base
    ctx.fillStyle = PIN_DARK;     // olive
    ctx.beginPath(); ctx.arc(40, 28, 1.7, 0, Math.PI * 2); ctx.fill();
    return { width: SIZE, height: SIZE, data: ctx.getImageData(0, 0, SIZE, SIZE).data };
  }
  function ensureSprite() {
    if (!mapRef || mapRef.hasImage?.(SPRITE_ID)) return;
    const s = spriteData();
    if (s) { try { mapRef.addImage(SPRITE_ID, s, { pixelRatio: 2 }); } catch (_) {} }
  }

  // ---------------------------------------------------------------
  // Data fetch + sanitize
  // ---------------------------------------------------------------
  function sanitize(d) {
    if (!d || typeof d !== "object") return null;
    const lat = Number(d.lat), lng = Number(d.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const members = Array.isArray(d.members) ? d.members.filter((m) => m && m.name) : [];
    const s = d.dim_schedule && typeof d.dim_schedule === "object" ? d.dim_schedule : {};
    return {
      id: d.id,
      lat, lng,
      label: String(d.label || ""),
      rationale: String(d.rationale || ""),
      best_hours: String(d.best_hours || ""),
      members,
      dim_schedule: {
        peak: Array.isArray(s.peak) ? s.peak : [],
        off: Array.isArray(s.off) ? s.off : [],
        prime: Array.isArray(s.prime) ? s.prime : [],
        prime_weekend: Array.isArray(s.prime_weekend) ? s.prime_weekend : [],
      },
    };
  }

  async function fetchDistricts() {
    const url = `${apiBase()}${ENDPOINT}?_=${Date.now()}`;
    const r = await fetch(url, { method: "GET", headers: authHeaders(), cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const list = Array.isArray(data?.districts) ? data.districts : [];
    return list.map(sanitize).filter(Boolean);
  }

  // ---------------------------------------------------------------
  // GeoJSON — one feature per district, carrying its current dim + prime
  // ---------------------------------------------------------------
  function districtsGeoJSON() {
    const ctx = nycNightContext();
    const features = [];
    for (let i = 0; i < districts.length; i++) {
      const d = districts[i];
      features.push({
        type: "Feature",
        properties: {
          idx: i,
          label: d.label,
          dim: dimFor(d, ctx),
          prime: isPrime(d, ctx),
        },
        geometry: { type: "Point", coordinates: [d.lng, d.lat] },
      });
    }
    return { type: "FeatureCollection", features };
  }
  function anyPrime() {
    const ctx = nycNightContext();
    return districts.some((d) => isPrime(d, ctx));
  }

  // ---------------------------------------------------------------
  // Layers
  // ---------------------------------------------------------------
  function ensureLayers() {
    if (!mapRef || layersReady) return;
    if (!mapRef.isStyleLoaded?.()) return;
    try {
      ensureSprite();
      if (!mapRef.getSource(SRC_ID)) {
        mapRef.addSource(SRC_ID, { type: "geojson", data: districtsGeoJSON() });
      }
      // Pulse (below the pins): magenta glow + two expanding rings, only for
      // districts currently in their let-out window.
      const primeFilter = ["==", ["get", "prime"], true];
      if (!mapRef.getLayer(PULSE_GLOW_ID)) {
        mapRef.addLayer({
          id: PULSE_GLOW_ID, type: "circle", source: SRC_ID, minzoom: MIN_ZOOM, filter: primeFilter,
          paint: { "circle-radius": 18, "circle-color": PULSE_COLOR, "circle-opacity": 0.32, "circle-blur": 0.6 },
        });
      }
      if (!mapRef.getLayer(PULSE_RING1_ID)) {
        mapRef.addLayer({
          id: PULSE_RING1_ID, type: "circle", source: SRC_ID, minzoom: MIN_ZOOM, filter: primeFilter,
          paint: {
            "circle-radius": PULSE_R_MIN, "circle-color": "rgba(0,0,0,0)",
            "circle-stroke-color": PULSE_COLOR, "circle-stroke-width": 3.5, "circle-stroke-opacity": 0,
          },
        });
      }
      // District pins (magenta cocktail sprite), dimmed by time-of-day.
      if (!mapRef.getLayer(ICON_LAYER_ID)) {
        mapRef.addLayer({
          id: ICON_LAYER_ID, type: "symbol", source: SRC_ID, minzoom: MIN_ZOOM,
          // Only show a district while it is in its let-out window (pulsing).
          filter: primeFilter,
          layout: {
            "icon-image": SPRITE_ID,
            "icon-size": ["interpolate", ["linear"], ["zoom"], 9, 0.3, 11, 0.42, 14, 0.62, 16, 0.8, 18, 0.95],
            "icon-allow-overlap": true, "icon-ignore-placement": true, "icon-anchor": "bottom",
          },
          paint: { "icon-opacity": ["coalesce", ["get", "dim"], 0.9] },
        });
      }
      // District-name labels from z13, collision-managed.
      if (!mapRef.getLayer(LABEL_LAYER_ID)) {
        mapRef.addLayer({
          id: LABEL_LAYER_ID, type: "symbol", source: SRC_ID, minzoom: LABEL_MIN_ZOOM,
          filter: primeFilter,
          layout: {
            "text-field": ["get", "label"],
            "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
            "text-size": ["interpolate", ["linear"], ["zoom"], 13, 10, 16, 12],
            "text-anchor": "top", "text-offset": [0, 0.6], "text-max-width": 9,
            "text-allow-overlap": false, "text-padding": 6, "text-optional": true,
          },
          paint: {
            "text-color": PIN_DARK, "text-halo-color": "#ffffff", "text-halo-width": 2,
            "text-opacity": ["coalesce", ["get", "dim"], 0.9],
          },
        });
      }
      layersReady = true;
      installZOrderKeeper();
      syncPulse();
      console.info(`[nld] nightlife layer ready; ${districts.length} district(s)`);
    } catch (e) {
      console.warn("[nld] ensureLayers failed:", e);
    }
  }

  function pushData() {
    if (!mapRef) return;
    const src = mapRef.getSource?.(SRC_ID);
    if (src && src.setData) { try { src.setData(districtsGeoJSON()); } catch (_) {} }
    syncPulse();
  }

  // Z-order keeper. The zone choropleth re-adds its fill layers on top
  // (aggressive backfill on style reloads / mode switches), which would bury
  // our pins + pulse under the zone colors — the reported symptom. Re-lift
  // our layers whenever a style change drops a zone layer above us. It is
  // zone-aware (only acts when a `*zone*` layer is actually above us) so we
  // settle just above the zones and never ping-pong with the other point
  // overlays, which lift themselves to the very top on the same event.
  function installZOrderKeeper() {
    if (zOrderInstalled || !mapRef) return;
    zOrderInstalled = true;
    // Bottom -> top: glow, rings, pin, label (label ends up topmost).
    const ids = [PULSE_GLOW_ID, PULSE_RING1_ID, ICON_LAYER_ID, LABEL_LAYER_ID];
    const scheduleMove = () => {
      if (zOrderInMove || zOrderPending) return;
      zOrderPending = true;
      const raf = (typeof window !== "undefined" && window.requestAnimationFrame)
        || ((fn) => setTimeout(fn, 16));
      raf(() => {
        zOrderPending = false;
        if (!mapRef) return;
        const present = ids.filter((id) => mapRef.getLayer?.(id));
        if (!present.length) return;
        let order = null;
        try {
          order = (typeof mapRef.getLayersOrder === "function")
            ? mapRef.getLayersOrder()
            : (mapRef.getStyle?.()?.layers || []).map((l) => l.id);
        } catch (_) { order = null; }
        if (Array.isArray(order) && order.length) {
          let zoneMax = -1;
          for (let i = 0; i < order.length; i++) {
            if (/zone/i.test(order[i])) zoneMax = i;
          }
          const ourMin = Math.min.apply(null, present.map((id) => order.indexOf(id)));
          if (zoneMax < 0 || ourMin > zoneMax) return; // already above the zones
        }
        zOrderInMove = true;
        try {
          for (const id of present) { try { mapRef.moveLayer(id); } catch (_) {} }
        } finally {
          zOrderInMove = false;
        }
      });
    };
    try { mapRef.on?.("styledata", scheduleMove); } catch (_) {}
    scheduleMove();
  }

  // ---------------------------------------------------------------
  // Let-out pulse animation
  // ---------------------------------------------------------------
  const _raf = (typeof window !== "undefined" && window.requestAnimationFrame)
    ? window.requestAnimationFrame.bind(window)
    : (cb) => setTimeout(() => cb(Date.now()), PULSE_FPS_MS);

  function pulseZoomScale(z) {
    if (typeof z !== "number") return 1;
    if (z <= 9) return 0.5;            // shrink to a compact dot when zoomed out
    if (z >= 16) return 1.4;
    return 0.5 + (z - 9) * (0.9 / 7);  // grow smoothly as you zoom in
  }
  function setRing(id, t, zScale) {
    if (!mapRef.getLayer?.(id)) return;
    const radius = (PULSE_R_MIN + (PULSE_R_MAX - PULSE_R_MIN) * t) * zScale;
    const opacity = 0.85 * (1 - t);
    try {
      mapRef.setPaintProperty(id, "circle-radius", radius);
      mapRef.setPaintProperty(id, "circle-stroke-opacity", opacity);
    } catch (_) {}
  }
  function pulseFrame(ts) {
    if (!pulseActive) { pulseRAF = null; return; }
    if (ts - pulseLastPaint >= PULSE_FPS_MS) {
      pulseLastPaint = ts;
      const z = pulseZoomScale(mapRef?.getZoom?.());
      const t = (ts % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
      setRing(PULSE_RING1_ID, t, z);
      if (mapRef.getLayer?.(PULSE_GLOW_ID)) {
        const glow = 0.22 + 0.14 * (0.5 + 0.5 * Math.sin(ts / 500));
        try {
          mapRef.setPaintProperty(PULSE_GLOW_ID, "circle-radius", 18 * z);
          mapRef.setPaintProperty(PULSE_GLOW_ID, "circle-opacity", glow);
        } catch (_) {}
      }
    }
    pulseRAF = _raf(pulseFrame);
  }
  function startPulse() {
    if (pulseActive) return;
    pulseActive = true; pulseLastPaint = 0; pulseRAF = _raf(pulseFrame);
  }
  function stopPulse() {
    pulseActive = false;
    if (pulseRAF != null && typeof window !== "undefined" && window.cancelAnimationFrame) {
      try { window.cancelAnimationFrame(pulseRAF); } catch (_) {}
    }
    pulseRAF = null;
  }
  function syncPulse() {
    if (layersReady && anyPrime()) startPulse();
    else stopPulse();
  }

  // ---------------------------------------------------------------
  // Popup (tap a pin)
  // ---------------------------------------------------------------
  let activePopup = null;
  function closePopup() { if (activePopup) { try { activePopup.remove(); } catch (_) {} activePopup = null; } }
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  const CAT_LABEL = {
    upscale_restaurant: "Restaurant", wine_bar: "Wine bar", cocktail_bar: "Cocktail bar",
    rooftop_bar: "Rooftop", lounge: "Lounge", nightclub: "Club",
  };
  function stateChip(d) {
    const ctx = nycNightContext();
    if (isPrime(d, ctx)) {
      return `<span class="nld-chip nld-chip-prime"><span class="nld-dot"></span>Prime — best pickup (let-out)</span>`;
    }
    const s = d.dim_schedule;
    if (s && hourInRanges(ctx.hour, s.peak)) return `<span class="nld-chip nld-chip-open">Busy now</span>`;
    if (s && hourInRanges(ctx.hour, s.off)) return `<span class="nld-chip nld-chip-quiet">Quiet now</span>`;
    return `<span class="nld-chip nld-chip-open">Open</span>`;
  }
  function popupHtml(d) {
    const venues = d.members.slice(0, 10).map((m) => {
      const tag = CAT_LABEL[m.category] || "Venue";
      const addr = m.address ? ` · ${escapeHtml(m.address)}` : "";
      return `<div class="nld-venue"><span class="nld-venue-tag">${escapeHtml(tag)}</span>${escapeHtml(m.name)}<span class="nld-venue-addr">${addr}</span></div>`;
    }).join("");
    const more = d.members.length > 10 ? `<div class="nld-more">+${d.members.length - 10} more</div>` : "";
    return `
      <div class="nld-pop-head">
        <span class="nld-pop-tag">Nightlife</span>
        <div class="nld-pop-title">${escapeHtml(d.label)}</div>
      </div>
      <div class="nld-pop-row">${stateChip(d)}</div>
      ${d.rationale ? `<div class="nld-pop-row"><b>Why</b><div>${escapeHtml(d.rationale)}</div></div>` : ""}
      ${d.best_hours ? `<div class="nld-pop-row"><b>Best time</b><div>${escapeHtml(d.best_hours)}</div></div>` : ""}
      <div class="nld-pop-row"><b>Venues</b>${venues}${more}</div>
    `;
  }
  function showPopup(html, point) {
    closePopup();
    const container = mapRef?.getCanvasContainer?.();
    if (!container) return;
    const popup = document.createElement("div");
    popup.className = "nld-popup";
    popup.innerHTML = html;
    const left = Math.max(8, Math.min(container.clientWidth - 290, point.x - 145));
    popup.style.left = `${left}px`;
    popup.style.top = `${Math.max(8, point.y - 16)}px`;
    popup.style.transform = "translateY(-100%)";
    popup.addEventListener("click", (e) => e.stopPropagation());
    popup.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
    const close = document.createElement("button");
    close.className = "nld-popup-close"; close.type = "button"; close.textContent = "×";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", closePopup);
    popup.appendChild(close);
    container.appendChild(popup);
    activePopup = popup;
  }
  function districtAt(point) {
    if (!mapRef?.queryRenderedFeatures || !mapRef.getLayer?.(ICON_LAYER_ID)) return null;
    try {
      const box = [[point.x - 16, point.y - 16], [point.x + 16, point.y + 16]];
      const feats = mapRef.queryRenderedFeatures(box, { layers: [ICON_LAYER_ID] });
      if (feats && feats.length) return feats[0];
    } catch (_) {}
    return null;
  }
  function attachClick(map) {
    map.on("click", (e) => {
      if (!layersReady) return;
      const f = districtAt(e.point);
      if (f) {
        const idx = Number(f.properties?.idx);
        const d = Number.isFinite(idx) ? districts[idx] : null;
        if (d) showPopup(popupHtml(d), e.point);
      } else { closePopup(); }
    });
    map.on("movestart", closePopup);
  }

  // ---------------------------------------------------------------
  // CSS
  // ---------------------------------------------------------------
  function injectCss() {
    if (document.getElementById("nld-css")) return;
    const style = document.createElement("style");
    style.id = "nld-css";
    style.textContent = `
      .nld-popup { position:absolute; z-index:1300; background:#fff; color:#111827; border-radius:12px;
        box-shadow:0 8px 24px rgba(0,0,0,0.18); padding:12px 14px 10px; width:290px; max-height:58vh; overflow-y:auto;
        font:13px/1.4 -apple-system, system-ui, sans-serif; pointer-events:auto; }
      .nld-popup-close { position:absolute; top:4px; right:6px; background:transparent; border:none;
        font:700 22px/1 -apple-system, system-ui, sans-serif; color:#6b7280; cursor:pointer; padding:2px 8px; }
      .nld-popup-close:hover { color:#111827; }
      .nld-pop-head { padding-right:22px; margin-bottom:6px; }
      .nld-pop-tag { display:inline-block; padding:1px 7px; border-radius:7px; font-size:10px; font-weight:800;
        text-transform:uppercase; letter-spacing:0.5px; color:#fff; background:#ec4899; }
      .nld-pop-title { font-weight:700; font-size:14px; margin-top:4px; }
      .nld-chip { display:inline-block; padding:2px 8px; border-radius:8px; font-size:11px; font-weight:700; }
      .nld-chip-prime { background:#fdf2f8; color:#be185d; }
      .nld-chip-open { background:#ecfeff; color:#0e7490; }
      .nld-chip-quiet { background:#f1f5f9; color:#475569; }
      .nld-dot { display:inline-block; width:7px; height:7px; margin-right:5px; border-radius:50%; background:#ec4899;
        vertical-align:middle; animation:nld-dot 1.4s ease-out infinite; }
      @keyframes nld-dot { 0% { box-shadow:0 0 0 0 rgba(236,72,153,0.55);} 70% { box-shadow:0 0 0 6px rgba(236,72,153,0);} 100% { box-shadow:0 0 0 0 rgba(236,72,153,0);} }
      .nld-pop-row { margin-top:6px; padding-top:6px; border-top:1px solid #f3f4f6; }
      .nld-pop-row b { display:block; font-size:10.5px; color:#6b7280; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:2px; }
      .nld-pop-row > div { font-size:12.5px; color:#111827; }
      .nld-venue { font-size:12.5px; color:#111827; margin-top:3px; }
      .nld-venue-tag { display:inline-block; min-width:62px; margin-right:6px; padding:0 5px; border-radius:5px;
        background:#fdf2f8; color:#be185d; font-size:10px; font-weight:700; }
      .nld-venue-addr { color:#9ca3af; font-size:11px; }
      .nld-more { margin-top:3px; font-size:11px; color:#9ca3af; }
    `;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------
  // Refresh + tick
  // ---------------------------------------------------------------
  async function refresh() {
    try {
      const next = await fetchDistricts();
      districts = next;
      ensureLayers();
      pushData();
    } catch (e) {
      console.warn("[nld] refresh failed:", e);
    }
  }
  function tick() {
    if (!layersReady) return;
    pushData(); // recompute dim + prime, restart/stop pulse as the hour crosses
  }

  // ---------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------
  function init(map) {
    if (mapRef) return;
    mapRef = map;
    injectCss();
    attachClick(map);
    const boot = () => { ensureLayers(); refresh(); };
    if (map.isStyleLoaded?.()) boot();
    else map.once?.("load", boot);
    // Re-add layers if the base style reloads (sprites/layers get cleared).
    map.on?.("styledata", () => { if (!mapRef.getLayer?.(ICON_LAYER_ID)) { layersReady = false; ensureLayers(); pushData(); } });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) stopPulse(); else syncPulse();
    });
    setInterval(refresh, REFRESH_INTERVAL_MS);
    setInterval(tick, TICK_INTERVAL_MS);
  }

  function resolveMapInstance() {
    try {
      // eslint-disable-next-line no-undef
      if (typeof map !== "undefined" && map) return map;
    } catch (_) {}
    if (typeof window !== "undefined") {
      if (window.map) return window.map;
      if (window.tlcMap) return window.tlcMap;
      if (window.TlcMapUiInternals?.getMap) {
        try { return window.TlcMapUiInternals.getMap(); } catch (_) {}
      }
    }
    return null;
  }
  function waitForMap() {
    const candidate = resolveMapInstance();
    if (candidate
      && typeof candidate.getCanvasContainer === "function"
      && typeof candidate.unproject === "function"
      && typeof candidate.on === "function") {
      try { init(candidate); console.info("[nld] initialized"); }
      catch (e) { console.warn("[nld] init failed:", e); }
      return;
    }
    setTimeout(waitForMap, 200);
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    waitForMap();
  } else {
    document.addEventListener("DOMContentLoaded", waitForMap);
  }

  window.NightlifeDistrictsFeature = {
    refresh,
    getDistricts: () => districts.map((d) => ({ ...d, members: d.members.map((m) => ({ ...m })) })),
  };
})();


// ============================ 4) CITY EVENTS ==================================
// City Events — big NYC events (concerts, sports, conventions) on the map.
//
// Reads GET /city_events (today's events, fetched from Ticketmaster by the
// backend) and drops a pin per event. The driver-relevant signal is the
// LET-OUT: when an event is almost over and people stream out needing rides
// all at once. Each event runs upcoming → in-progress → "letting out" →
// ended (derived here from start time + a per-category duration estimate),
// and only the letting-out venues PULSE (gold ring = best pickup now),
// matching the dollar-flag prime-time pulse language.
//
// Self-contained + read-only, mirroring major-buildings.feature.js.
(function () {
  "use strict";

  const EVENTS_ENDPOINT = "/city_events";
  const REFRESH_MS = 10 * 60 * 1000;   // re-poll the backend every 10 min
  const TICK_MS = 60 * 1000;           // re-evaluate let-out state every minute

  const SRC_ID = "cbe-events";
  const ICON_LAYER_ID = "cbe-icons";
  const LABEL_LAYER_ID = "cbe-labels";
  const PULSE_GLOW_ID = "cbe-pulse-glow";
  const PULSE_RING1_ID = "cbe-pulse-ring1";
  const SPRITES = { concert: "cbe-sprite-concert", sports: "cbe-sprite-sports", convention: "cbe-sprite-convention" };

  const MIN_ZOOM = 11;
  const LABEL_MIN_ZOOM = 13;

  // Per-category estimated duration (seconds) — Ticketmaster gives a start,
  // rarely an end. Kept under the backend's ~6h retain window so an event
  // stays served through its let-out.
  const DURATION = { concert: 3 * 3600, sports: 3 * 3600, convention: 5 * 3600, event: 3 * 3600 };
  const LETOUT_LEAD = 15 * 60;   // people start trickling out ~15m before the end
  const LETOUT_TAIL = 45 * 60;   // the surge runs ~45m past the end

  const PULSE_COLOR = "#fbbf24";       // gold = "best time, now" (matches the flag prime pulse)
  const PULSE_PERIOD_MS = 2200;
  const PULSE_R_MIN = 8;
  const PULSE_R_MAX = 20;
  const PULSE_FPS_MS = 33;

  const CAT = {
    concert:    { color: "#8b5cf6", dark: "#6d28d9", label: "Concert" },
    sports:     { color: "#f97316", dark: "#c2410c", label: "Sports" },
    convention: { color: "#14b8a6", dark: "#0f766e", label: "Convention" },
    event:      { color: "#6b7280", dark: "#374151", label: "Event" },
  };

  let mapRef = null;
  let initDone = false;
  let layersReady = false;
  let zOrderInstalled = false;
  let events = [];
  let pulseActive = false;
  let pulseRAF = null;
  let pulseLastPaint = 0;

  // ---------------------------------------------------------------
  // API helpers (shared convention with the other features)
  // ---------------------------------------------------------------
  function apiBase() {
    try { if (typeof RAILWAY_BASE === "string" && RAILWAY_BASE) return RAILWAY_BASE; } catch (_) {}
    if (typeof window !== "undefined" && window.API_BASE) return String(window.API_BASE).replace(/\/+$/, "");
    return "";
  }
  function authHeaders() {
    try {
      if (typeof getCommunityAuthHeaders === "function") {
        const h = getCommunityAuthHeaders();
        return (h && typeof h === "object") ? h : {};
      }
    } catch (_) {}
    return {};
  }
  async function fetchEvents() {
    const url = `${apiBase()}${EVENTS_ENDPOINT}?_=${Date.now()}`;
    const r = await fetch(url, { method: "GET", headers: authHeaders(), cache: "no-store" });
    if (!r.ok) throw new Error(`city_events ${r.status}`);
    const data = await r.json();
    const list = Array.isArray(data?.events) ? data.events : [];
    return list.map(sanitize).filter(Boolean);
  }
  function sanitize(e) {
    if (!e || typeof e !== "object") return null;
    const lat = Number(e.lat), lng = Number(e.lng), startAt = Number(e.startAt);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(startAt)) return null;
    let cat = String(e.category || "event");
    if (!CAT[cat]) cat = "event";
    return {
      id: Number(e.id) || 0,
      name: String(e.name || "Event"),
      category: cat,
      venue: String(e.venue || ""),
      lat, lng,
      startAt,
      endAt: Number.isFinite(Number(e.endAt)) ? Number(e.endAt) : null,
      url: String(e.url || ""),
    };
  }

  // ---------------------------------------------------------------
  // Time / state
  // ---------------------------------------------------------------
  function now() { return Date.now() / 1000; }
  function endEst(e) { return e.endAt || (e.startAt + (DURATION[e.category] || DURATION.event)); }
  // upcoming | in_progress | letting_out | ended
  function eventState(e) {
    const t = now();
    const end = endEst(e);
    if (t < e.startAt) return "upcoming";
    if (t < end - LETOUT_LEAD) return "in_progress";
    if (t < end + LETOUT_TAIL) return "letting_out";
    return "ended";
  }
  function fmtTime(unix) {
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York", hour: "numeric", minute: "2-digit",
      }).format(new Date(unix * 1000));
    } catch (_) { return ""; }
  }

  // ---------------------------------------------------------------
  // Sprites — a colored map-pin per category with a white emblem.
  // ---------------------------------------------------------------
  function spriteData(draw) {
    const SIZE = 80;
    const canvas = document.createElement("canvas");
    canvas.width = SIZE; canvas.height = SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.clearRect(0, 0, SIZE, SIZE);
    draw(ctx);
    return { width: SIZE, height: SIZE, data: ctx.getImageData(0, 0, SIZE, SIZE).data };
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  // Teardrop pin (head + point), bottom-anchored at the venue.
  function drawPin(ctx, cat, emblem) {
    const c = CAT[cat] || CAT.event;
    ctx.lineJoin = "round";
    ctx.fillStyle = c.color;
    ctx.strokeStyle = c.dark;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(40, 30, 20, Math.PI * 0.85, Math.PI * 0.15, false);
    ctx.lineTo(40, 74);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    emblem(ctx);
  }
  function drawConcert(ctx) {
    drawPin(ctx, "concert", (c) => {
      c.fillStyle = "#ffffff";
      c.beginPath(); c.ellipse(35, 36, 5, 4, -0.35, 0, Math.PI * 2); c.fill();   // note head
      c.fillRect(39, 21, 2.6, 15);                                                // stem
      c.beginPath(); c.moveTo(41.6, 21); c.quadraticCurveTo(49, 24, 41.6, 29); c.fill(); // flag
    });
  }
  function drawSports(ctx) {
    drawPin(ctx, "sports", (c) => {
      c.fillStyle = "#ffffff";
      c.beginPath(); c.arc(40, 30, 9, 0, Math.PI * 2); c.fill();                  // ball
      c.strokeStyle = CAT.sports.dark; c.lineWidth = 1.4;
      c.beginPath(); c.arc(34, 26, 9, -0.3, 0.9); c.stroke();                     // seams
      c.beginPath(); c.arc(46, 34, 9, Math.PI - 0.3, Math.PI + 0.9); c.stroke();
    });
  }
  function drawConvention(ctx) {
    drawPin(ctx, "convention", (c) => {
      c.fillStyle = "#ffffff";
      roundRect(c, 31, 21, 18, 17, 2.5); c.fill();                                // badge card
      c.fillStyle = CAT.convention.color;
      c.beginPath(); c.arc(36, 27, 2.6, 0, Math.PI * 2); c.fill();                // photo dot
      c.fillRect(40, 25, 7, 1.6); c.fillRect(40, 28, 7, 1.6);                     // name lines
      c.fillRect(33, 33, 14, 2.4);                                               // bottom bar
    });
  }
  function ensureSprites() {
    if (!mapRef) return;
    const defs = [["concert", drawConcert], ["sports", drawSports], ["convention", drawConvention]];
    for (const [cat, draw] of defs) {
      const id = SPRITES[cat];
      if (mapRef.hasImage?.(id)) continue;
      const s = spriteData(draw);
      if (s) { try { mapRef.addImage(id, s, { pixelRatio: 2 }); } catch (_) {} }
    }
  }

  // ---------------------------------------------------------------
  // GeoJSON — all non-ended events; `letout` flags the pulsing ones.
  // ---------------------------------------------------------------
  function eventsGeoJSON() {
    const features = [];
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const st = eventState(e);
      if (st === "ended") continue;
      const cat = CAT[e.category] ? e.category : "event";
      features.push({
        type: "Feature",
        properties: {
          idx: i,
          name: e.name,
          category: cat,
          spriteCategory: SPRITES[cat] ? cat : "concert",
          venue: e.venue,
          startAt: e.startAt,
          endAt: e.endAt,
          url: e.url,
          letout: st === "letting_out",
        },
        geometry: { type: "Point", coordinates: [e.lng, e.lat] },
      });
    }
    return { type: "FeatureCollection", features };
  }
  function hasLetout() {
    return events.some((e) => eventState(e) === "letting_out");
  }

  // ---------------------------------------------------------------
  // Layers
  // ---------------------------------------------------------------
  function ensureLayers() {
    if (!mapRef || layersReady) return;
    if (!mapRef.isStyleLoaded?.()) return;
    try {
      ensureSprites();
      if (!mapRef.getSource(SRC_ID)) {
        mapRef.addSource(SRC_ID, { type: "geojson", data: eventsGeoJSON() });
      }

      // Pulse (below the pins): gold glow + two stroke rings, only for
      // letting-out events.
      const letoutFilter = ["==", ["get", "letout"], true];
      if (!mapRef.getLayer(PULSE_GLOW_ID)) {
        mapRef.addLayer({
          id: PULSE_GLOW_ID, type: "circle", source: SRC_ID, minzoom: MIN_ZOOM, filter: letoutFilter,
          paint: { "circle-radius": 12, "circle-color": PULSE_COLOR, "circle-opacity": 0.18, "circle-blur": 0.6 },
        });
      }
      if (!mapRef.getLayer(PULSE_RING1_ID)) {
        mapRef.addLayer({
          id: PULSE_RING1_ID, type: "circle", source: SRC_ID, minzoom: MIN_ZOOM, filter: letoutFilter,
          paint: {
            "circle-radius": PULSE_R_MIN, "circle-color": "rgba(0,0,0,0)",
            "circle-stroke-color": PULSE_COLOR, "circle-stroke-width": 3.5, "circle-stroke-opacity": 0,
          },
        });
      }

      // Event pins (sprite by category).
      if (!mapRef.getLayer(ICON_LAYER_ID)) {
        mapRef.addLayer({
          id: ICON_LAYER_ID, type: "symbol", source: SRC_ID, minzoom: MIN_ZOOM,
          // Only show an event while it is letting out (pulsing) — the
          // best-pickup surge window — and hide it from the map otherwise.
          filter: letoutFilter,
          layout: {
            "icon-image": ["match", ["get", "spriteCategory"],
              "sports", SPRITES.sports, "convention", SPRITES.convention, SPRITES.concert],
            "icon-size": ["interpolate", ["linear"], ["zoom"], 11, 0.4, 14, 0.62, 16, 0.8, 18, 0.95],
            "icon-allow-overlap": true, "icon-ignore-placement": true, "icon-anchor": "bottom",
          },
        });
      }

      // Event-name labels — from z13, collision-managed so they don't pile up.
      if (!mapRef.getLayer(LABEL_LAYER_ID)) {
        mapRef.addLayer({
          id: LABEL_LAYER_ID, type: "symbol", source: SRC_ID, minzoom: LABEL_MIN_ZOOM,
          filter: letoutFilter,
          layout: {
            "text-field": ["get", "name"],
            "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
            "text-size": ["interpolate", ["linear"], ["zoom"], 13, 10, 16, 12],
            "text-anchor": "top", "text-offset": [0, 0.6], "text-max-width": 8,
            "text-allow-overlap": false, "text-padding": 6, "text-optional": true,
          },
          paint: {
            "text-color": ["match", ["get", "category"],
              "sports", CAT.sports.dark, "convention", CAT.convention.dark, CAT.concert.dark],
            "text-halo-color": "#ffffff", "text-halo-width": 2,
          },
        });
      }

      layersReady = true;
      installZOrderKeeper();
      syncPulse();
      console.info(`[cbe] city-events layer ready; ${events.length} event(s)`);
    } catch (e) {
      console.warn("[cbe] ensureLayers failed:", e);
    }
  }

  function installZOrderKeeper() {
    if (zOrderInstalled || !mapRef) return;
    zOrderInstalled = true;
    const ids = [PULSE_GLOW_ID, PULSE_RING1_ID, ICON_LAYER_ID, LABEL_LAYER_ID];
    let pending = false;
    const onStyle = () => {
      if (pending) return;
      pending = true;
      const raf = (typeof window !== "undefined" && window.requestAnimationFrame) || ((fn) => setTimeout(fn, 16));
      raf(() => {
        pending = false;
        if (!mapRef) return;
        // Passive: only re-add + lift after a real style reload dropped us.
        if (mapRef.getSource?.(SRC_ID) && mapRef.getLayer?.(ICON_LAYER_ID)) return;
        layersReady = false;
        ensureLayers();
        for (const id of ids) { if (mapRef.getLayer?.(id)) { try { mapRef.moveLayer(id); } catch (_) {} } }
      });
    };
    try { mapRef.on?.("styledata", onStyle); } catch (_) {}
  }

  // ---------------------------------------------------------------
  // Let-out pulse animation
  // ---------------------------------------------------------------
  function rafSchedule(fn) {
    if (typeof window !== "undefined" && window.requestAnimationFrame) return window.requestAnimationFrame(fn);
    return setTimeout(() => fn(typeof performance !== "undefined" ? performance.now() : Date.now()), PULSE_FPS_MS);
  }
  function pulseZoomScale(z) {
    if (!Number.isFinite(z)) return 0.8;
    if (z <= 11) return 0.55;
    if (z >= 18) return 1.25;
    return 0.55 + (z - 11) / 7 * 0.7;
  }
  function setRing(id, t, zScale) {
    if (!mapRef?.getLayer?.(id)) return;
    const r = (PULSE_R_MIN + t * (PULSE_R_MAX - PULSE_R_MIN)) * zScale;
    const op = 0.85 * (1 - t);
    try {
      mapRef.setPaintProperty(id, "circle-radius", r);
      mapRef.setPaintProperty(id, "circle-stroke-opacity", op);
    } catch (_) {}
  }
  function pulseFrame(ts) {
    if (!pulseActive) { pulseRAF = null; return; }
    if (ts - pulseLastPaint >= PULSE_FPS_MS) {
      pulseLastPaint = ts;
      const z = pulseZoomScale(mapRef?.getZoom?.());
      const t = (ts % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
      setRing(PULSE_RING1_ID, t, z);
      if (mapRef?.getLayer?.(PULSE_GLOW_ID)) {
        const glow = 0.16 + 0.12 * (0.5 + 0.5 * Math.sin(ts / 500));
        try {
          mapRef.setPaintProperty(PULSE_GLOW_ID, "circle-radius", 12 * z);
          mapRef.setPaintProperty(PULSE_GLOW_ID, "circle-opacity", glow);
        } catch (_) {}
      }
    }
    pulseRAF = rafSchedule(pulseFrame);
  }
  function startPulse() {
    if (pulseActive) return;
    if (typeof document !== "undefined" && document.hidden) return;
    pulseActive = true; pulseLastPaint = 0; pulseRAF = rafSchedule(pulseFrame);
  }
  function stopPulse() {
    pulseActive = false;
    if (pulseRAF != null && typeof window !== "undefined" && window.cancelAnimationFrame) {
      try { window.cancelAnimationFrame(pulseRAF); } catch (_) {}
    }
    pulseRAF = null;
  }
  function syncPulse() {
    if (!mapRef || !layersReady) return;
    if (hasLetout()) startPulse(); else stopPulse();
  }

  // ---------------------------------------------------------------
  // Popup
  // ---------------------------------------------------------------
  let activePopup = null;
  function closePopup() { if (activePopup) { try { activePopup.remove(); } catch (_) {} activePopup = null; } }
  function closeZonePopups() {
    try { document.querySelectorAll(".maplibregl-popup, .mapboxgl-popup").forEach((n) => { try { n.remove(); } catch (_) {} }); } catch (_) {}
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function statusChipHtml(e) {
    const st = eventState(e);
    if (st === "letting_out") {
      return `<span class="cbe-chip cbe-chip-letout"><span class="cbe-dot"></span>Letting out — best pickup</span>`;
    }
    if (st === "in_progress") {
      return `<span class="cbe-chip cbe-chip-live">In progress · lets out ~${escapeHtml(fmtTime(endEst(e)))}</span>`;
    }
    const mins = Math.max(0, Math.round((e.startAt - now()) / 60));
    let when;
    if (mins <= 120) when = mins < 60 ? `Starts in ${mins}m` : `Starts in ${Math.floor(mins / 60)}h ${mins % 60}m`;
    else when = `Starts ${escapeHtml(fmtTime(e.startAt))}`;
    return `<span class="cbe-chip cbe-chip-upcoming">${when}</span>`;
  }
  function eventFromProps(p) {
    const idx = Number(p.idx);
    if (Number.isFinite(idx) && events[idx]) return events[idx];
    // fallback: reconstruct from props (idx can go stale between ticks)
    return {
      name: p.name, category: p.category, venue: p.venue, url: p.url,
      startAt: Number(p.startAt), endAt: p.endAt != null ? Number(p.endAt) : null,
    };
  }
  function eventPopupHtml(p) {
    const e = eventFromProps(p);
    const c = CAT[e.category] || CAT.event;
    const ticket = e.url
      ? `<div class="cbe-pop-row"><a class="cbe-ticket" href="${escapeHtml(e.url)}" target="_blank" rel="noopener">Tickets / info ↗</a></div>`
      : "";
    const venue = e.venue ? `<div class="cbe-pop-row"><b>Venue</b><div>${escapeHtml(e.venue)}</div></div>` : "";
    return `
      <div class="cbe-pop-head cbe-pop-${escapeHtml(e.category)}">
        <span class="cbe-pop-tag">${escapeHtml(c.label)}</span>
        <div class="cbe-pop-title">${escapeHtml(e.name)}</div>
      </div>
      <div class="cbe-pop-row">${statusChipHtml(e)}</div>
      ${venue}
      <div class="cbe-pop-row"><b>Time</b><div>${escapeHtml(fmtTime(e.startAt))} – ~${escapeHtml(fmtTime(endEst(e)))}</div></div>
      ${ticket}
    `;
  }
  function showPopup(html, point) {
    closePopup();
    const container = mapRef?.getCanvasContainer?.();
    if (!container) return;
    const popup = document.createElement("div");
    popup.className = "cbe-popup";
    popup.innerHTML = html;
    const left = Math.max(8, Math.min(container.clientWidth - 280, point.x - 140));
    const top = Math.max(8, point.y - 16);
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
    popup.style.transform = "translateY(-100%)";
    popup.addEventListener("click", (e) => e.stopPropagation());
    popup.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
    const close = document.createElement("button");
    close.className = "cbe-popup-close"; close.type = "button"; close.textContent = "×";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", closePopup);
    popup.appendChild(close);
    container.appendChild(popup);
    activePopup = popup;
  }
  function eventAt(point) {
    if (!mapRef?.queryRenderedFeatures || !mapRef.getLayer?.(ICON_LAYER_ID)) return null;
    try {
      const box = [[point.x - 16, point.y - 16], [point.x + 16, point.y + 16]];
      const feats = mapRef.queryRenderedFeatures(box, { layers: [ICON_LAYER_ID] });
      if (feats && feats.length) return feats[0];
    } catch (_) {}
    return null;
  }
  function attachClick(map) {
    map.on("click", (e) => {
      if (!layersReady) return;
      const f = eventAt(e.point);
      if (f) { closeZonePopups(); showPopup(eventPopupHtml(f.properties || {}), e.point); }
      else closePopup();
    });
    map.on("movestart", closePopup);
  }

  // ---------------------------------------------------------------
  // CSS
  // ---------------------------------------------------------------
  function injectCss() {
    if (document.getElementById("cbe-css")) return;
    const style = document.createElement("style");
    style.id = "cbe-css";
    style.textContent = `
      .cbe-popup { position:absolute; z-index:1300; background:#fff; color:#111827; border-radius:12px;
        box-shadow:0 8px 24px rgba(0,0,0,0.18); padding:12px 14px 10px; width:280px; max-height:56vh; overflow-y:auto;
        font:13px/1.4 -apple-system, system-ui, sans-serif; pointer-events:auto; }
      .cbe-popup-close { position:absolute; top:4px; right:6px; background:transparent; border:none;
        font:700 22px/1 -apple-system, system-ui, sans-serif; color:#6b7280; cursor:pointer; padding:2px 8px; }
      .cbe-popup-close:hover { color:#111827; }
      .cbe-pop-head { padding-right:22px; margin-bottom:6px; }
      .cbe-pop-tag { display:inline-block; padding:1px 7px; border-radius:7px; font-size:10px; font-weight:800;
        text-transform:uppercase; letter-spacing:0.5px; color:#fff; }
      .cbe-pop-concert .cbe-pop-tag { background:#8b5cf6; }
      .cbe-pop-sports .cbe-pop-tag { background:#f97316; }
      .cbe-pop-convention .cbe-pop-tag { background:#14b8a6; }
      .cbe-pop-event .cbe-pop-tag { background:#6b7280; }
      .cbe-pop-title { font-weight:700; font-size:14px; margin-top:4px; }
      .cbe-chip { display:inline-block; padding:2px 8px; border-radius:8px; font-size:11px; font-weight:700; }
      .cbe-chip-letout { background:#fff7ed; color:#b45309; }
      .cbe-chip-live { background:#ecfeff; color:#0e7490; }
      .cbe-chip-upcoming { background:#f1f5f9; color:#475569; }
      .cbe-dot { display:inline-block; width:7px; height:7px; margin-right:5px; border-radius:50%; background:#f59e0b;
        vertical-align:middle; animation:cbe-dot 1.4s ease-out infinite; }
      @keyframes cbe-dot { 0% { box-shadow:0 0 0 0 rgba(245,158,11,0.55);} 70% { box-shadow:0 0 0 6px rgba(245,158,11,0);} 100% { box-shadow:0 0 0 0 rgba(245,158,11,0);} }
      .cbe-pop-row { margin-top:6px; padding-top:6px; border-top:1px solid #f3f4f6; }
      .cbe-pop-row b { display:block; font-size:10.5px; color:#6b7280; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:2px; }
      .cbe-pop-row div { font-size:12.5px; color:#111827; }
      .cbe-ticket { color:#2563eb; font-weight:700; text-decoration:none; font-size:12.5px; }
      .cbe-ticket:hover { text-decoration:underline; }
    `;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------
  // Refresh + tick + init
  // ---------------------------------------------------------------
  function pushData() {
    const src = mapRef?.getSource?.(SRC_ID);
    if (src?.setData) { try { src.setData(eventsGeoJSON()); } catch (_) {} }
    syncPulse();
  }
  async function refresh() {
    try {
      events = await fetchEvents();
      console.info(`[cbe] loaded ${events.length} event(s) from ${EVENTS_ENDPOINT}`);
      ensureLayers();
      pushData();
    } catch (e) {
      console.warn("[cbe] fetch failed:", e?.message || e);
    }
  }
  function tick() {
    if (!layersReady) return;
    pushData();  // recompute states (ended drop-off, new let-outs) + pulse
  }
  function init(map) {
    if (initDone) return;
    initDone = true;
    mapRef = map;
    injectCss();
    attachClick(map);
    let attempts = 0;
    const poll = setInterval(() => {
      attempts += 1;
      if (layersReady) { clearInterval(poll); return; }
      if (attempts > 150) { clearInterval(poll); console.warn("[cbe] style not ready after 45s"); return; }
      if (mapRef?.isStyleLoaded?.()) ensureLayers();
    }, 300);
    refresh();
    setInterval(refresh, REFRESH_MS);
    setInterval(tick, TICK_MS);
    if (typeof document !== "undefined" && document.addEventListener) {
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) stopPulse(); else syncPulse();
      });
    }
    console.info("[cbe] initialized");
  }

  function resolveMap() {
    try { if (typeof map !== "undefined" && map) return map; } catch (_) {}
    if (typeof window !== "undefined") {
      if (window.map) return window.map;
      if (window.tlcMap) return window.tlcMap;
      if (window.TlcMapUiInternals?.getMap) { try { return window.TlcMapUiInternals.getMap(); } catch (_) {} }
    }
    return null;
  }
  function waitForMap() {
    const m = resolveMap();
    if (m && typeof m.getCanvasContainer === "function" && typeof m.on === "function") {
      try { init(m); } catch (e) { console.warn("[cbe] init failed:", e); }
      return;
    }
    setTimeout(waitForMap, 200);
  }
  if (document.readyState === "complete" || document.readyState === "interactive") {
    waitForMap();
  } else {
    document.addEventListener("DOMContentLoaded", waitForMap);
  }

  window.CityEventsFeature = {
    refresh,
    getEvents: () => events.map((e) => ({ ...e, state: eventState(e) })),
  };
})();
