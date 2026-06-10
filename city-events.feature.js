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
  const PULSE_RING2_ID = "cbe-pulse-ring2";
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
  const PULSE_PERIOD_MS = 1500;
  const PULSE_R_MIN = 8;
  const PULSE_R_MAX = 30;
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
      for (const id of [PULSE_RING1_ID, PULSE_RING2_ID]) {
        if (!mapRef.getLayer(id)) {
          mapRef.addLayer({
            id, type: "circle", source: SRC_ID, minzoom: MIN_ZOOM, filter: letoutFilter,
            paint: {
              "circle-radius": PULSE_R_MIN, "circle-color": "rgba(0,0,0,0)",
              "circle-stroke-color": PULSE_COLOR, "circle-stroke-width": 2.5, "circle-stroke-opacity": 0,
            },
          });
        }
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
    const ids = [PULSE_GLOW_ID, PULSE_RING1_ID, PULSE_RING2_ID, ICON_LAYER_ID, LABEL_LAYER_ID];
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
    const op = 0.55 * (1 - t);
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
      setRing(PULSE_RING2_ID, (t + 0.5) % 1, z);
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
