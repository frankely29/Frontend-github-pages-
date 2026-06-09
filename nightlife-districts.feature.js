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
  const PULSE_RING2_ID = "nld-pulse-ring2";
  const SPRITE_ID = "nld-sprite-cocktail";

  const MIN_ZOOM = 11;
  const LABEL_MIN_ZOOM = 13;

  // Distinct magenta identity (gold #fbbf24 is the dollar-flag pulse).
  const PIN_COLOR = "#ec4899";
  const PIN_DARK = "#9d174d";
  const PULSE_COLOR = "#ec4899";
  const PULSE_PERIOD_MS = 1500;
  const PULSE_R_MIN = 8;
  const PULSE_R_MAX = 30;
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
          paint: { "circle-radius": 12, "circle-color": PULSE_COLOR, "circle-opacity": 0.18, "circle-blur": 0.6 },
        });
      }
      for (const id of [PULSE_RING1_ID, PULSE_RING2_ID]) {
        if (!mapRef.getLayer(id)) {
          mapRef.addLayer({
            id, type: "circle", source: SRC_ID, minzoom: MIN_ZOOM, filter: primeFilter,
            paint: {
              "circle-radius": PULSE_R_MIN, "circle-color": "rgba(0,0,0,0)",
              "circle-stroke-color": PULSE_COLOR, "circle-stroke-width": 2.5, "circle-stroke-opacity": 0,
            },
          });
        }
      }
      // District pins (magenta cocktail sprite), dimmed by time-of-day.
      if (!mapRef.getLayer(ICON_LAYER_ID)) {
        mapRef.addLayer({
          id: ICON_LAYER_ID, type: "symbol", source: SRC_ID, minzoom: MIN_ZOOM,
          layout: {
            "icon-image": SPRITE_ID,
            "icon-size": ["interpolate", ["linear"], ["zoom"], 11, 0.4, 14, 0.62, 16, 0.8, 18, 0.95],
            "icon-allow-overlap": true, "icon-ignore-placement": true, "icon-anchor": "bottom",
          },
          paint: { "icon-opacity": ["coalesce", ["get", "dim"], 0.9] },
        });
      }
      // District-name labels from z13, collision-managed.
      if (!mapRef.getLayer(LABEL_LAYER_ID)) {
        mapRef.addLayer({
          id: LABEL_LAYER_ID, type: "symbol", source: SRC_ID, minzoom: LABEL_MIN_ZOOM,
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

  // ---------------------------------------------------------------
  // Let-out pulse animation
  // ---------------------------------------------------------------
  const _raf = (typeof window !== "undefined" && window.requestAnimationFrame)
    ? window.requestAnimationFrame.bind(window)
    : (cb) => setTimeout(() => cb(Date.now()), PULSE_FPS_MS);

  function pulseZoomScale(z) {
    if (typeof z !== "number") return 1;
    if (z <= 11) return 0.7;
    if (z >= 16) return 1.4;
    return 0.7 + (z - 11) * (0.7 / 5);
  }
  function setRing(id, t, zScale) {
    if (!mapRef.getLayer?.(id)) return;
    const radius = (PULSE_R_MIN + (PULSE_R_MAX - PULSE_R_MIN) * t) * zScale;
    const opacity = 0.55 * (1 - t);
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
      setRing(PULSE_RING2_ID, (t + 0.5) % 1, z);
      if (mapRef.getLayer?.(PULSE_GLOW_ID)) {
        const glow = 0.12 + 0.10 * (0.5 + 0.5 * Math.sin(ts / 500));
        try {
          mapRef.setPaintProperty(PULSE_GLOW_ID, "circle-radius", 12 * z);
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
