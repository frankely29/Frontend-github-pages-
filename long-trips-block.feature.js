// Long Trips Block: driver-placed flags on the map marking spots worth
// waiting at for long (45+ min) trips. Three colors: green = best, sky =
// medium, yellow = normal. Long-press the map for 3 seconds to place;
// long-press an existing flag to Move / Remove / Keep it.
//
// Storage: shared across all drivers via the backend's /long_trip_flags
// endpoints. localStorage is kept purely as a last-seen cache so the map
// can paint instantly on load (while the GET request is in flight) and
// so the feature degrades gracefully when the backend is unreachable.
// Anyone-can-edit per driver request: no creator check, any authenticated
// driver can move or remove any flag.
(function () {
  const STORAGE_KEY = "tlcLongTripBlockFlags";
  const HOLD_MS = 3000;                // long-press on existing flag -> Edit dialog
  const MAP_HOLD_DIM_MS = 3000;        // long-press on map -> zones dim
  const MAP_HOLD_PICK_MS = 5000;       // keep holding past this -> color picker / place flag
  const MOVE_TOLERANCE_PX = 18;
  const MAX_LOCAL_CACHE = 500;
  const SUPPRESS_NEXT_CLICK_MS = 600;
  const FLAG_TEXT = "45+";

  const COLORS = {
    green:  { hex: "#10b981", border: "#047857", label: "Best (Green)" },
    sky:    { hex: "#38bdf8", border: "#0369a1", label: "Medium (Sky Blue)" },
    yellow: { hex: "#facc15", border: "#a16207", label: "Normal (Yellow)" },
  };

  const state = {
    flags: [],
    markers: Object.create(null),
    suppressClickUntilMs: 0,
    pickerOpen: false,
    placementActive: false,
    activeMoveFlagId: null,
    backendAvailable: null, // null = unknown, true/false = decided
  };
  let mapRef = null;
  let initDone = false;

  function uid() {
    return `ltb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  // ----- API layer -------------------------------------------------------
  // Uses the same RAILWAY_BASE + getCommunityAuthHeaders that app.js
  // already exposes as classic-script globals. typeof guards keep us safe
  // if either is missing (e.g. running in a stripped test harness).

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

  function sanitizeFlag(entry) {
    if (!entry || typeof entry !== "object") return null;
    const id = typeof entry.id === "string" ? entry.id : null;
    if (!id) return null;
    const lng = Number(entry.lng);
    const lat = Number(entry.lat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return null;
    if (!Object.prototype.hasOwnProperty.call(COLORS, entry.color)) return null;
    return {
      id,
      lng,
      lat,
      color: entry.color,
      createdAt: Number.isFinite(Number(entry.createdAt)) ? Number(entry.createdAt) : Date.now(),
      createdBy: typeof entry.createdBy === "string" ? entry.createdBy : null,
    };
  }

  async function apiList() {
    // Cache-buster: belt-and-braces against any layer that might
    // serve a stale GET response (browser, CDN, Railway edge).
    const url = `${apiBase()}/long_trip_flags?_=${Date.now()}`;
    const r = await fetch(url, {
      method: "GET",
      headers: authHeaders(),
      cache: "no-store",
    });
    if (!r.ok) {
      const err = new Error(`list ${r.status}`);
      err.status = r.status;
      err.url = url;
      throw err;
    }
    const data = await r.json();
    const raw = Array.isArray(data?.flags) ? data.flags : [];
    return raw.map(sanitizeFlag).filter(Boolean);
  }

  async function apiCreate(lngLat, color) {
    const r = await fetch(`${apiBase()}/long_trip_flags`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ lng: lngLat.lng, lat: lngLat.lat, color }),
    });
    if (!r.ok) throw new Error(`create ${r.status}`);
    return sanitizeFlag(await r.json());
  }

  async function apiUpdate(id, partial) {
    const r = await fetch(`${apiBase()}/long_trip_flags/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(partial),
    });
    if (!r.ok) throw new Error(`update ${r.status}`);
    return sanitizeFlag(await r.json());
  }

  async function apiDelete(id) {
    const r = await fetch(`${apiBase()}/long_trip_flags/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (!r.ok && r.status !== 404) throw new Error(`delete ${r.status}`);
    return true;
  }

  // ----- Local cache (last-seen) ----------------------------------------

  function loadCache() {
    try {
      const raw = window.localStorage?.getItem?.(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      state.flags = parsed.map(sanitizeFlag).filter(Boolean).slice(-MAX_LOCAL_CACHE);
    } catch (_) { state.flags = []; }
  }

  function saveCache() {
    try {
      window.localStorage?.setItem?.(STORAGE_KEY, JSON.stringify(state.flags));
    } catch (_) { /* quota or disabled */ }
  }

  // ----- CSS + flag DOM --------------------------------------------------

  function injectCss() {
    if (document.getElementById("long-trips-block-css")) return;
    const css = `
      .ltb-flag {
        position: relative; width: 34px; height: 42px;
        cursor: pointer; user-select: none; -webkit-user-select: none;
        -webkit-touch-callout: none; touch-action: none;
      }
      .ltb-flag-scale {
        position: absolute; left: 0; top: 0; width: 100%; height: 100%;
        transform-origin: 50% 100%;
        transform: scale(var(--ltb-zoom-scale, 1));
        transition: transform 120ms ease-out;
        will-change: transform;
      }
      .ltb-flag-pole {
        position: absolute; left: 50%; bottom: 0; width: 2px; height: 100%;
        background: #1f2937; transform: translateX(-50%);
        box-shadow: 0 1px 2px rgba(0,0,0,0.4);
      }
      .ltb-flag-pennant {
        position: absolute; left: 50%; top: 0; width: 28px; height: 22px;
        display: flex; align-items: center; justify-content: center;
        font: 700 11px/1 -apple-system, system-ui, "Segoe UI", sans-serif;
        color: #1f2937; letter-spacing: 0.5px;
        clip-path: polygon(0 0, 100% 0, 100% 65%, 60% 100%, 0 100%);
        box-shadow: 0 2px 4px rgba(0,0,0,0.35);
      }
      .ltb-flag-pulse {
        position: absolute; left: 50%; top: 11px;
        width: 4px; height: 4px; border-radius: 50%;
        transform: translate(-50%, -50%);
        background: currentColor; opacity: 0;
        pointer-events: none;
      }
      .ltb-flag.is-holding .ltb-flag-pulse {
        opacity: 1; animation: ltb-pulse 3s linear forwards;
      }
      @keyframes ltb-pulse {
        0%   { transform: translate(-50%, -50%) scale(0.8); opacity: 0.8; }
        100% { transform: translate(-50%, -50%) scale(14);  opacity: 0; }
      }
      .ltb-flag.is-moving .ltb-flag-scale {
        filter: drop-shadow(0 0 6px rgba(59,130,246,0.95));
        animation: ltb-move-bob 800ms ease-in-out infinite alternate;
      }
      .ltb-flag.is-preview .ltb-flag-scale {
        filter: drop-shadow(0 0 6px rgba(16,185,129,0.95));
        animation: ltb-move-bob 800ms ease-in-out infinite alternate;
      }
      @keyframes ltb-move-bob {
        from { transform: scale(var(--ltb-zoom-scale, 1)) translateY(0); }
        to   { transform: scale(var(--ltb-zoom-scale, 1)) translateY(-4px); }
      }

      .ltb-place-bar {
        position: fixed; left: 50%; bottom: 28px;
        transform: translateX(-50%);
        z-index: 9999;
        display: flex; flex-direction: column; gap: 8px;
        padding: 12px 16px;
        background: rgba(15,23,42,0.94);
        color: #ffffff;
        border-radius: 14px;
        box-shadow: 0 10px 28px rgba(0,0,0,0.45);
        font: 600 13px/1.2 -apple-system, system-ui, "Segoe UI", sans-serif;
        align-items: center;
        min-width: 240px; max-width: calc(100vw - 32px);
        animation: ltb-toast-in 200ms ease-out;
      }
      .ltb-place-bar .ltb-place-hint {
        font-size: 12px; color: rgba(255,255,255,0.85);
        text-align: center;
      }
      .ltb-place-bar .ltb-place-actions {
        display: flex; gap: 8px;
      }
      .ltb-place-bar .ltb-place-actions button {
        padding: 9px 16px; border-radius: 8px; border: 0;
        cursor: pointer;
        font: 700 13px/1 -apple-system, system-ui, sans-serif;
      }
      .ltb-place-bar .ltb-place-cancel {
        background: rgba(255,255,255,0.14); color: #ffffff;
      }
      .ltb-place-bar .ltb-place-confirm {
        background: #10b981; color: #ffffff;
      }
      .ltb-place-bar .ltb-place-confirm:active,
      .ltb-place-bar .ltb-place-cancel:active { transform: translateY(1px); }

      .ltb-hold-indicator {
        position: fixed; pointer-events: none; z-index: 9998;
        width: 56px; height: 56px; border-radius: 50%;
        transform: translate(-50%, -50%);
        background: rgba(15,23,42,0.10);
        border: 2px solid rgba(15,23,42,0.6);
        animation: ltb-hold-fill 5s linear forwards;
      }
      @keyframes ltb-hold-fill {
        0%   { transform: translate(-50%, -50%) scale(0.4); opacity: 0.0; }
        20%  { transform: translate(-50%, -50%) scale(0.6); opacity: 0.5; }
        60%  { transform: translate(-50%, -50%) scale(0.9); opacity: 0.85; }
        100% { transform: translate(-50%, -50%) scale(1.15); opacity: 0.95; }
      }

      .ltb-picker-backdrop {
        position: fixed; inset: 0; z-index: 9999;
        background: rgba(15,23,42,0.45);
        display: flex; align-items: center; justify-content: center;
        padding: 16px;
      }
      .ltb-picker-card {
        background: #ffffff; border-radius: 12px; padding: 18px 16px 14px;
        max-width: 320px; width: 100%;
        box-shadow: 0 10px 32px rgba(0,0,0,0.35);
        font: 400 14px/1.4 -apple-system, system-ui, "Segoe UI", sans-serif;
        color: #0f172a;
      }
      .ltb-picker-title { margin: 0 0 4px; font-size: 15px; font-weight: 700; }
      .ltb-picker-sub { margin: 0 0 12px; font-size: 12px; color: #475569; line-height: 1.35; }
      .ltb-picker-buttons { display: flex; flex-direction: column; gap: 8px; }
      .ltb-picker-buttons button {
        display: flex; align-items: center; gap: 10px;
        padding: 10px 12px; border-radius: 8px; border: 1px solid #cbd5e1;
        background: #ffffff; cursor: pointer;
        font: 600 13px/1 -apple-system, system-ui, sans-serif;
        color: #0f172a;
      }
      .ltb-picker-buttons button:active { transform: translateY(1px); }
      .ltb-picker-buttons .ltb-swatch {
        width: 18px; height: 18px; border-radius: 4px;
        box-shadow: inset 0 0 0 1px rgba(0,0,0,0.18);
      }
      .ltb-picker-buttons .ltb-cancel {
        margin-top: 4px; justify-content: center; color: #475569;
        background: #f1f5f9; border-color: #e2e8f0;
      }
      .ltb-remove-card .ltb-picker-buttons button.ltb-remove {
        background: #fef2f2; border-color: #fecaca; color: #991b1b;
        justify-content: center;
      }
      .ltb-remove-card .ltb-picker-buttons button.ltb-move {
        background: #eff6ff; border-color: #bfdbfe; color: #1d4ed8;
        justify-content: center;
      }

      .ltb-move-toast {
        position: fixed; left: 50%; bottom: 110px;
        transform: translateX(-50%);
        z-index: 9998;
        padding: 10px 14px;
        background: rgba(15,23,42,0.92);
        color: #ffffff; border-radius: 999px;
        font: 600 12px/1 -apple-system, system-ui, "Segoe UI", sans-serif;
        box-shadow: 0 6px 18px rgba(0,0,0,0.35);
        pointer-events: none;
        animation: ltb-toast-in 200ms ease-out;
      }
      @keyframes ltb-toast-in {
        from { opacity: 0; transform: translate(-50%, 8px); }
        to   { opacity: 1; transform: translate(-50%, 0); }
      }
    `;
    const style = document.createElement("style");
    style.id = "long-trips-block-css";
    style.textContent = css;
    document.head.appendChild(style);
  }

  function buildFlagElement(flag) {
    const palette = COLORS[flag.color] || COLORS.yellow;
    const root = document.createElement("div");
    root.className = "ltb-flag";
    root.dataset.flagId = flag.id;
    root.style.color = palette.hex;
    root.innerHTML = `
      <div class="ltb-flag-scale">
        <div class="ltb-flag-pulse"></div>
        <div class="ltb-flag-pole"></div>
        <div class="ltb-flag-pennant" style="background:${palette.hex};border:1px solid ${palette.border};">${FLAG_TEXT}</div>
      </div>
    `;
    return root;
  }

  // ----- GeoJSON layer rendering (zero-drift, hotspot-style) -------------
  //
  // Driver: "the hotspot have a perfect system we can copy."
  //
  // Hotspots render via map.addSource + map.addLayer -- the GPU projects
  // them using the same matrix as the basemap. Zero drift at fractional
  // zoom. DOM markers (MapLibre's Marker class) can't match that because
  // they're positioned in JavaScript every frame, always a sub-pixel
  // behind the GPU.
  //
  // This module historically rendered flags as DOM markers (kept below
  // as buildFlagElement + the per-flag renderFlag DOM path). Now we
  // ALSO try to register a symbol layer. If init succeeds, we sweep
  // every existing DOM marker and let the layer render flags going
  // forward -- zero drift, matches hotspots exactly. If init fails for
  // any reason (style not loaded, hasImage missing, browser quirk),
  // useLayer stays false and the DOM-marker path keeps working as it
  // does today. Worst case: drivers see flags with the existing drift.
  // Best case: zero drift.

  const LTF_SOURCE_ID = "long-trip-flags";
  const LTF_LAYER_ID = "long-trip-flags-icons";              // legacy id (replaced)
  const LTF_DISC_LAYER_ID = "long-trip-flags-disc";          // circle layer (zero-drift)
  const LTF_TEXT_LAYER_ID = "long-trip-flags-text";          // "45+" label
  let useLayer = false;
  let flagLayerInitStarted = false;

  function ensureFlagLayer() {
    if (useLayer || flagLayerInitStarted || !mapRef) return;
    if (!mapRef.isStyleLoaded?.()) {
      // Wait for style ready, then try once.
      flagLayerInitStarted = true;
      mapRef.once?.("load", () => {
        flagLayerInitStarted = false;
        ensureFlagLayer();
      });
      return;
    }
    flagLayerInitStarted = true;
    try {
      // Driver: "use the hotspot system" -- the hotspot's micro_hotspots
      // layer uses type=circle for point geometry, which renders purely
      // on the GPU shader at the projected pixel position. No symbol
      // placement worker, no per-frame collision/sort pass, no chance
      // of lagging the basemap by a frame during rapid zoom. That's
      // why hotspots have true zero drift.
      //
      // Previous flag layer used type=symbol with an addImage icon. That
      // path goes through MapLibre's symbol placement pipeline and the
      // driver was seeing residual drift on it. Replacing with two
      // hotspot-style layers, both backed by the same point geojson:
      //
      //   long-trip-flags-disc  type=circle  -- the colored disc, zero-
      //                                        drift position anchor
      //   long-trip-flags-text  type=symbol  -- the "45+" label text
      //                                        on top of the disc
      //
      // The disc is what carries the position. The text is overlaid;
      // even if the symbol placement pipeline introduces sub-pixel jitter
      // on the label, it's rendered ON TOP of the rock-solid disc so it
      // never appears to "slide off" the geographic point. The marker
      // looks like a flag-sized colored badge with "45+" on it,
      // preserving the visual identity of the feature.
      if (!mapRef.getSource?.(LTF_SOURCE_ID)) {
        mapRef.addSource(LTF_SOURCE_ID, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
          // Drift root cause: geojson-vt quantizes points to integer
          // tile-grid coordinates (`Math.round(extent * (x * z2 - tx))`)
          // and rebuilds tiles at every integer zoom up to source maxzoom
          // (default 18). The quantization grid is finer at higher
          // zooms, so a point's rounded position differs between
          // adjacent zoom levels -- visible as drift during zoom
          // animation. Set maxzoom = 22 so tiles are only quantized at
          // one fixed-grid level and re-used for all zooms below.
          // (https://github.com/maplibre/maplibre-gl-js/issues/2507)
          maxzoom: 22,
          // tolerance is Douglas-Peucker simplification. It's a no-op
          // on Point features (geojson-vt doesn't simplify points), but
          // set explicitly to 0 to document the intent and guarantee no
          // simplification gets added by future MapLibre changes.
          tolerance: 0,
          // buffer is in tile-pixels; default 128. Lower buffer means
          // a point near a tile boundary may not be replicated into
          // neighboring tiles -- harmless for our use case where there
          // is one global GeoJSON source rather than user-tilted views.
          buffer: 0,
        });
      }
      if (!mapRef.getLayer?.(LTF_DISC_LAYER_ID)) {
        mapRef.addLayer({
          id: LTF_DISC_LAYER_ID,
          type: "circle",
          source: LTF_SOURCE_ID,
          paint: {
            "circle-radius": [
              "interpolate", ["linear"], ["zoom"],
              9, 12,
              13, 16,
              16, 22,
            ],
            "circle-color": [
              "match", ["get", "color"],
              "green", "#10b981",
              "sky", "#38bdf8",
              "yellow", "#facc15",
              "#94a3b8",
            ],
            "circle-stroke-color": [
              "match", ["get", "color"],
              "green", "#047857",
              "sky", "#0369a1",
              "yellow", "#a16207",
              "#1f2937",
            ],
            "circle-stroke-width": 2.5,
            "circle-opacity": 0.96,
          },
        });
      }
      if (!mapRef.getLayer?.(LTF_TEXT_LAYER_ID)) {
        mapRef.addLayer({
          id: LTF_TEXT_LAYER_ID,
          type: "symbol",
          source: LTF_SOURCE_ID,
          layout: {
            "text-field": FLAG_TEXT,
            "text-font": ["Open Sans Regular"],
            "text-size": [
              "interpolate", ["linear"], ["zoom"],
              9, 9,
              13, 11,
              16, 13,
            ],
            "text-anchor": "center",
            "text-allow-overlap": true,
            "text-ignore-placement": true,
          },
          paint: {
            "text-color": "#1f2937",
            // Slight halo so the label reads against any disc color.
            "text-halo-color": "rgba(255,255,255,0.85)",
            "text-halo-width": 1,
          },
        });
      }
      // If the legacy symbol-icon layer from PR #953 is still on the
      // style (e.g. from an earlier session), remove it -- we don't
      // want to render twice.
      if (mapRef.getLayer?.(LTF_LAYER_ID)) {
        try { mapRef.removeLayer(LTF_LAYER_ID); } catch (_) {}
      }
      // Layer is live. Sweep the existing DOM markers so we don't
      // double-render, then push current state into the layer.
      Object.keys(state.markers).forEach((id) => {
        // Don't sweep markers for flags currently in interactive states
        // (move, placement preview). Those still need their DOM marker.
        if (id === state.activeMoveFlagId) return;
        if (id === "__ltb_preview__") return;
        try { state.markers[id].remove(); } catch (_) {}
        delete state.markers[id];
      });
      useLayer = true;
      syncFlagLayer();
      console.info("[long-trips-block] circle+text layer rendering active (zero-drift)");
    } catch (e) {
      console.warn("[long-trips-block] layer init failed; falling back to DOM markers:", e);
      // Leave useLayer = false. Existing DOM marker path keeps working.
      flagLayerInitStarted = false;
    }
  }

  function syncFlagLayer() {
    if (!useLayer || !mapRef) return;
    const src = mapRef.getSource?.(LTF_SOURCE_ID);
    if (!src?.setData) return;
    // Exclude the flag currently being interactively moved -- that one
    // is shown via a temp DOM marker for the duration of the drag.
    const hidden = state.activeMoveFlagId;
    const features = state.flags
      .filter((f) => f.id !== hidden)
      .map((f) => ({
        type: "Feature",
        id: f.id,
        properties: { id: f.id, color: f.color },
        geometry: { type: "Point", coordinates: [f.lng, f.lat] },
      }));
    src.setData({ type: "FeatureCollection", features });
  }

  function flagAtScreenPoint(point) {
    if (!useLayer || !mapRef) return null;
    // Hit-test the disc layer (the circle carries the position; the
    // text label is positioned on top of it). queryRenderedFeatures
    // accepts an array of layer ids -- include both so a press that
    // lands on the "45+" text but not the disc edge still registers.
    const layers = [];
    if (mapRef.getLayer?.(LTF_DISC_LAYER_ID)) layers.push(LTF_DISC_LAYER_ID);
    if (mapRef.getLayer?.(LTF_TEXT_LAYER_ID)) layers.push(LTF_TEXT_LAYER_ID);
    if (!layers.length) return null;
    let features;
    try {
      features = mapRef.queryRenderedFeatures(point, { layers });
    } catch (_) { return null; }
    if (!features || !features.length) return null;
    const id = features[0]?.properties?.id;
    if (!id) return null;
    return state.flags.find((f) => f.id === id) || null;
  }

  function renderFlag(flag) {
    if (useLayer) { syncFlagLayer(); return; }
    if (!mapRef || !window.maplibregl?.Marker) return;
    const el = buildFlagElement(flag);
    el.style.setProperty("--ltb-zoom-scale", scaleForZoom(mapRef.getZoom?.()).toFixed(3));
    const marker = new window.maplibregl.Marker({ element: el, anchor: "bottom" })
      .setLngLat([flag.lng, flag.lat])
      .addTo(mapRef);
    state.markers[flag.id] = marker;
    attachFlagLongPress(el, flag);
  }

  function attachFlagLongPress(el, flag) {
    let timer = null;
    let pressStart = null;
    let startX = 0;
    let startY = 0;
    const cancel = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      pressStart = null;
      el.classList.remove("is-holding");
    };
    el.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      if (state.placementActive || state.pickerOpen) return;
      pressStart = Date.now();
      startX = e.clientX; startY = e.clientY;
      el.classList.add("is-holding");
      try { el.setPointerCapture?.(e.pointerId); } catch (_) {}
      timer = setTimeout(() => {
        showRemovePicker(flag, () => {
          state.suppressClickUntilMs = Date.now() + SUPPRESS_NEXT_CLICK_MS;
        });
        cancel();
      }, HOLD_MS);
    });
    el.addEventListener("pointermove", (e) => {
      if (!pressStart) return;
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > MOVE_TOLERANCE_PX) cancel();
    });
    el.addEventListener("pointerup", cancel);
    el.addEventListener("pointercancel", cancel);
    el.addEventListener("pointerleave", cancel);
  }

  function removeAllRenderedFlags() {
    Object.keys(state.markers).forEach((id) => {
      try { state.markers[id].remove(); } catch (_) {}
      delete state.markers[id];
    });
    if (useLayer) syncFlagLayer();
  }

  // ----- Map long-press --------------------------------------------------

  function attachMapLongPress(map) {
    // Two-stage hold:
    //   t=0           finger down, hold indicator starts filling
    //   t=3s          zones dim   (driver can browse the streets under)
    //   t=5s          color picker opens / placement starts
    // Lifting before 3s -> nothing happens. Lifting between 3s and 5s ->
    // dim restores. The split lets drivers eyeball a candidate spot
    // without committing to placing a flag.
    let dimTimer = null;
    let pickTimer = null;
    let startClientX = 0;
    let startClientY = 0;
    let startLngLat = null;
    let indicatorEl = null;
    let activeTouchId = null;
    let lastStartAt = 0;

    const cancel = () => {
      if (dimTimer) { clearTimeout(dimTimer); dimTimer = null; }
      if (pickTimer) { clearTimeout(pickTimer); pickTimer = null; }
      if (indicatorEl) { indicatorEl.remove(); indicatorEl = null; }
      startLngLat = null;
      activeTouchId = null;
      if (!state.pickerOpen && !state.placementActive) restoreZoneFills();
    };

    const startHold = (clientX, clientY, lngLat) => {
      if (state.placementActive || state.activeMoveFlagId) return;
      if (Date.now() - lastStartAt < 120) return;
      lastStartAt = Date.now();
      cancel();
      startClientX = clientX; startClientY = clientY; startLngLat = lngLat;
      indicatorEl = document.createElement("div");
      indicatorEl.className = "ltb-hold-indicator";
      indicatorEl.style.left = `${clientX}px`;
      indicatorEl.style.top = `${clientY}px`;
      document.body.appendChild(indicatorEl);

      // Stage 1: dim zones at MAP_HOLD_DIM_MS (3s).
      dimTimer = setTimeout(() => {
        dimTimer = null;
        if (!startLngLat) return; // hold already cancelled
        dimZoneFills();
      }, MAP_HOLD_DIM_MS);

      // Stage 2: open the color picker at MAP_HOLD_PICK_MS (5s).
      pickTimer = setTimeout(() => {
        const lngLatCopy = startLngLat;
        pickTimer = null;
        if (dimTimer) { clearTimeout(dimTimer); dimTimer = null; }
        if (indicatorEl) { indicatorEl.remove(); indicatorEl = null; }
        startLngLat = null;
        activeTouchId = null;
        if (!lngLatCopy) { restoreZoneFills(); return; }
        state.suppressClickUntilMs = Date.now() + SUPPRESS_NEXT_CLICK_MS;
        state.pickerOpen = true;
        // Make sure zones are dim before the picker opens, even if the
        // user passed through the 3s boundary mid-frame.
        dimZoneFills();
        showColorPicker(lngLatCopy, (color) => {
          state.pickerOpen = false;
          if (color) {
            // Hand off dim to the positioning phase so the driver can
            // drag the preview flag to the exact spot before committing.
            enterPlacementPositioning(lngLatCopy, color, () => {
              restoreZoneFills();
            });
          } else {
            restoreZoneFills();
          }
        });
      }, MAP_HOLD_PICK_MS);
    };

    const checkMove = (clientX, clientY) => {
      if (!pickTimer && !dimTimer && !flagHoldTimer) return;
      if (Math.hypot(clientX - startClientX, clientY - startClientY) > MOVE_TOLERANCE_PX) {
        cancel();
        cancelFlagHold();
      }
    };

    // When the layer is active there's no DOM .ltb-flag to attach a
    // pointerdown to, so the existing flag long-press path doesn't
    // fire. Hit-test the layer at touch start; if a flag is under the
    // press, start a 3s timer for the Edit dialog instead of the
    // map-placement timers.
    let flagHoldTimer = null;
    let flagHoldFlag = null;
    const cancelFlagHold = () => {
      if (flagHoldTimer) { clearTimeout(flagHoldTimer); flagHoldTimer = null; }
      flagHoldFlag = null;
    };
    const startFlagHold = (flag, cx, cy) => {
      if (state.placementActive || state.pickerOpen) return;
      cancelFlagHold();
      flagHoldFlag = flag;
      startClientX = cx; startClientY = cy;
      flagHoldTimer = setTimeout(() => {
        const f = flagHoldFlag;
        cancelFlagHold();
        if (f) {
          showRemovePicker(f, () => {
            state.suppressClickUntilMs = Date.now() + SUPPRESS_NEXT_CLICK_MS;
          });
        }
      }, HOLD_MS);
    };

    map.on("mousedown", (e) => {
      const orig = e.originalEvent;
      if (orig?.button !== 0) return;
      const target = orig?.target;
      if (target instanceof Element && target.closest?.(".ltb-flag")) return;
      // Layer hit-test for the no-DOM case.
      const hit = flagAtScreenPoint(e.point);
      if (hit) { startFlagHold(hit, orig.clientX, orig.clientY); return; }
      startHold(orig.clientX, orig.clientY, e.lngLat);
    });

    map.on("touchstart", (e) => {
      const orig = e.originalEvent;
      if (!orig?.touches || orig.touches.length !== 1) { cancel(); cancelFlagHold(); return; }
      const touch = orig.touches[0];
      const target = touch.target;
      if (target instanceof Element && target.closest?.(".ltb-flag")) return;
      activeTouchId = touch.identifier;
      const hit = flagAtScreenPoint(e.point);
      if (hit) { startFlagHold(hit, touch.clientX, touch.clientY); return; }
      startHold(touch.clientX, touch.clientY, e.lngLat);
    });

    map.on("mousemove", (e) => {
      const orig = e.originalEvent;
      checkMove(orig.clientX, orig.clientY);
    });

    map.on("touchmove", (e) => {
      const orig = e.originalEvent;
      if (!orig?.touches) { cancel(); cancelFlagHold(); return; }
      let touch = null;
      for (const t of orig.touches) {
        if (t.identifier === activeTouchId) { touch = t; break; }
      }
      if (!touch) { cancel(); cancelFlagHold(); return; }
      checkMove(touch.clientX, touch.clientY);
    });

    const cancelAll = () => { cancel(); cancelFlagHold(); };
    map.on("mouseup", cancelAll);
    map.on("touchend", cancelAll);
    map.on("touchcancel", cancelAll);
    map.on("dragstart", cancelAll);
    map.on("zoomstart", cancelAll);
    map.on("pitchstart", cancelAll);
    map.on("rotatestart", cancelAll);

    document.addEventListener("click", (e) => {
      if (state.suppressClickUntilMs && Date.now() < state.suppressClickUntilMs) {
        e.stopPropagation();
        e.preventDefault();
      }
    }, { capture: true });
  }

  // ----- Pickers ---------------------------------------------------------

  function showColorPicker(lngLat, callback) {
    let resolved = false;
    const backdrop = document.createElement("div");
    backdrop.className = "ltb-picker-backdrop";
    backdrop.innerHTML = `
      <div class="ltb-picker-card">
        <div class="ltb-picker-title">Long-trip waiting spot</div>
        <div class="ltb-picker-sub">Tag this spot as a good place to wait for trips of 45+ minutes. Choose a flag color:</div>
        <div class="ltb-picker-buttons">
          ${["green", "sky", "yellow"].map((c) => `
            <button type="button" data-color="${c}">
              <span class="ltb-swatch" style="background:${COLORS[c].hex};"></span>
              <span>${COLORS[c].label}</span>
            </button>
          `).join("")}
          <button type="button" class="ltb-cancel" data-color="">Cancel</button>
        </div>
      </div>
    `;
    const finish = (color) => {
      if (resolved) return;
      resolved = true;
      backdrop.remove();
      callback(color || null);
    };
    backdrop.addEventListener("click", (e) => {
      const btn = e.target.closest?.("button");
      if (btn) { finish(btn.dataset.color); return; }
      if (e.target === backdrop) finish(null);
    });
    document.body.appendChild(backdrop);
  }

  function showRemovePicker(flag, onChoiceMade) {
    let resolved = false;
    const swatch = COLORS[flag.color] || COLORS.yellow;
    const backdrop = document.createElement("div");
    backdrop.className = "ltb-picker-backdrop";
    backdrop.innerHTML = `
      <div class="ltb-picker-card ltb-remove-card">
        <div class="ltb-picker-title">Edit this spot</div>
        <div class="ltb-picker-sub">
          <span class="ltb-swatch" style="display:inline-block;vertical-align:middle;margin-right:6px;background:${swatch.hex};"></span>
          ${swatch.label} flag · ${FLAG_TEXT}
        </div>
        <div class="ltb-picker-buttons">
          <button type="button" class="ltb-move" data-action="move">Move</button>
          <button type="button" class="ltb-remove" data-action="remove">Remove</button>
          <button type="button" class="ltb-cancel" data-action="cancel">Keep</button>
        </div>
      </div>
    `;
    const finish = (action) => {
      if (resolved) return;
      resolved = true;
      backdrop.remove();
      if (action === "remove") removeFlag(flag.id);
      else if (action === "move") enterMoveMode(flag);
      onChoiceMade?.();
    };
    backdrop.addEventListener("click", (e) => {
      const btn = e.target.closest?.("button");
      if (btn) { finish(btn.dataset.action); return; }
      if (e.target === backdrop) finish("cancel");
    });
    document.body.appendChild(backdrop);
  }

  // ----- Zoom-scale + zone-fill dim -------------------------------------

  const SCALE_ZOOM_MAX = 15;
  const SCALE_ZOOM_MIN = 9;
  const SCALE_FLOOR = 0.3;
  function scaleForZoom(zoom) {
    if (!Number.isFinite(zoom)) return 1;
    if (zoom >= SCALE_ZOOM_MAX) return 1;
    if (zoom <= SCALE_ZOOM_MIN) return SCALE_FLOOR;
    const t = (zoom - SCALE_ZOOM_MIN) / (SCALE_ZOOM_MAX - SCALE_ZOOM_MIN);
    return SCALE_FLOOR + (1 - SCALE_FLOOR) * t;
  }
  function applyScaleToAllMarkers() {
    if (!mapRef) return;
    const value = scaleForZoom(mapRef.getZoom?.()).toFixed(3);
    Object.values(state.markers).forEach((marker) => {
      const el = marker?.getElement?.();
      if (el) el.style.setProperty("--ltb-zoom-scale", value);
    });
  }

  const DIMMABLE_LAYER_IDS = [
    "zones-fill",
    "pickup-zone-hotspots-fill",
    "pickup-zone-hotspots-underpaint",
  ];
  const DIMMED_OPACITY = 0.12;
  let savedFillOpacities = null;
  function dimZoneFills() {
    if (!mapRef || savedFillOpacities) return;
    savedFillOpacities = {};
    for (const id of DIMMABLE_LAYER_IDS) {
      try {
        if (mapRef.getLayer?.(id)) {
          savedFillOpacities[id] = mapRef.getPaintProperty(id, "fill-opacity");
          mapRef.setPaintProperty(id, "fill-opacity", DIMMED_OPACITY);
        }
      } catch (_) {}
    }
  }
  function restoreZoneFills() {
    if (!mapRef || !savedFillOpacities) return;
    for (const id of Object.keys(savedFillOpacities)) {
      try {
        if (mapRef.getLayer?.(id)) {
          mapRef.setPaintProperty(id, "fill-opacity", savedFillOpacities[id]);
        }
      } catch (_) {}
    }
    savedFillOpacities = null;
  }

  // ----- Placement positioning ------------------------------------------
  // After the color picker resolves we don't commit the flag straight
  // away. Driver feedback: long-press lands on a finger-blob area, the
  // exact lng/lat is usually off by a block. So we drop a draggable
  // preview marker at the long-press spot, keep zones dimmed so the
  // underlying streets are easy to read, and offer Place / Cancel.

  function enterPlacementPositioning(lngLat, color, onDone) {
    if (!mapRef || !window.maplibregl?.Marker) { onDone(); return; }
    state.placementActive = true;

    const previewFlag = {
      id: "__ltb_preview__",
      lng: lngLat.lng,
      lat: lngLat.lat,
      color,
      createdAt: Date.now(),
    };
    const el = buildFlagElement(previewFlag);
    el.classList.add("is-preview");
    el.style.setProperty("--ltb-zoom-scale", scaleForZoom(mapRef.getZoom?.()).toFixed(3));
    const marker = new window.maplibregl.Marker({
      element: el, anchor: "bottom", draggable: true,
    })
      .setLngLat([lngLat.lng, lngLat.lat])
      .addTo(mapRef);

    const bar = document.createElement("div");
    bar.className = "ltb-place-bar";
    bar.innerHTML = `
      <span class="ltb-place-hint">Drag the flag to the exact spot</span>
      <div class="ltb-place-actions">
        <button type="button" class="ltb-place-cancel">Cancel</button>
        <button type="button" class="ltb-place-confirm">Place here</button>
      </div>
    `;
    document.body.appendChild(bar);

    let cleanedUp = false;
    const cleanup = (shouldPlace) => {
      if (cleanedUp) return;
      cleanedUp = true;
      const finalLngLat = marker.getLngLat?.();
      try { marker.remove(); } catch (_) {}
      try { bar.remove(); } catch (_) {}
      state.placementActive = false;
      if (shouldPlace && finalLngLat
        && Number.isFinite(finalLngLat.lng)
        && Number.isFinite(finalLngLat.lat)) {
        addFlag({ lng: finalLngLat.lng, lat: finalLngLat.lat }, color);
      }
      onDone();
    };

    bar.querySelector(".ltb-place-confirm").addEventListener("click", () => {
      state.suppressClickUntilMs = Date.now() + SUPPRESS_NEXT_CLICK_MS;
      cleanup(true);
    });
    bar.querySelector(".ltb-place-cancel").addEventListener("click", () => {
      state.suppressClickUntilMs = Date.now() + SUPPRESS_NEXT_CLICK_MS;
      cleanup(false);
    });
    // Walk-away safety net: don't leave the map locked in placement mode
    // forever if the driver gets distracted.
    setTimeout(() => cleanup(false), 60000);
  }

  // ----- Move mode ------------------------------------------------------

  function enterMoveMode(flag) {
    if (state.placementActive || state.pickerOpen) return;
    if (state.activeMoveFlagId && state.activeMoveFlagId !== flag.id) {
      exitMoveMode(state.activeMoveFlagId);
    }
    state.activeMoveFlagId = flag.id;

    // Layer-rendered flags don't have a DOM marker. Create a temp one
    // for the drag, then exclude the flag from the layer so we don't
    // see both. The temp marker is destroyed on cleanup() and the layer
    // re-renders at the new lng/lat. DOM-rendered flags (fallback path)
    // already have state.markers[flag.id]; reuse it.
    let marker = state.markers[flag.id];
    let createdTempMarker = false;
    if (!marker) {
      if (!mapRef || !window.maplibregl?.Marker) {
        state.activeMoveFlagId = null;
        return;
      }
      const tempEl = buildFlagElement(flag);
      tempEl.style.setProperty("--ltb-zoom-scale", scaleForZoom(mapRef.getZoom?.()).toFixed(3));
      marker = new window.maplibregl.Marker({
        element: tempEl, anchor: "bottom", draggable: true,
      })
        .setLngLat([flag.lng, flag.lat])
        .addTo(mapRef);
      state.markers[flag.id] = marker;
      createdTempMarker = true;
      // Hide the layer feature for this flag while the temp marker shows.
      syncFlagLayer();
    } else {
      try { marker.setDraggable?.(true); } catch (_) {}
    }
    const el = marker.getElement?.();
    if (el) el.classList.add("is-moving");

    // Dim zones while moving so the streets underneath read clearly.
    dimZoneFills();

    const toast = document.createElement("div");
    toast.className = "ltb-move-toast";
    toast.textContent = "Drag the flag to a new spot";
    document.body.appendChild(toast);

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      try { marker.setDraggable?.(false); } catch (_) {}
      if (el) el.classList.remove("is-moving");
      marker.off?.("dragend", onDragEnd);
      try { toast.remove(); } catch (_) {}
      restoreZoneFills();
      if (state.activeMoveFlagId === flag.id) state.activeMoveFlagId = null;
      if (createdTempMarker) {
        try { marker.remove(); } catch (_) {}
        delete state.markers[flag.id];
        syncFlagLayer();  // re-include in the layer at the new lng/lat
      }
    };
    const onDragEnd = async () => {
      const lngLat = marker.getLngLat?.();
      if (lngLat && Number.isFinite(lngLat.lng) && Number.isFinite(lngLat.lat)) {
        flag.lng = lngLat.lng;
        flag.lat = lngLat.lat;
        saveCache();
        toast.textContent = "Saving…";
        // Always try the API; previous gate ("skip if backendAvailable
        // === false") silently broke sharing after one transient failure.
        try {
          const updated = await apiUpdate(flag.id, { lng: lngLat.lng, lat: lngLat.lat });
          if (updated) {
            flag.lng = updated.lng; flag.lat = updated.lat;
            marker.setLngLat?.([flag.lng, flag.lat]);
            saveCache();
          }
          state.backendAvailable = true;
          toast.textContent = "Spot moved";
        } catch (e) {
          state.backendAvailable = false;
          console.warn(
            `[long-trips-block] move failed (${e?.status || "network"} ${e?.url || ""}), kept local:`, e
          );
          toast.textContent = "Saved locally";
        }
        setTimeout(cleanup, 900);
      } else {
        cleanup();
      }
    };
    marker.on?.("dragend", onDragEnd);
    setTimeout(cleanup, 30000);
  }

  function exitMoveMode(flagId) {
    const marker = state.markers[flagId];
    if (!marker) return;
    try { marker.setDraggable?.(false); } catch (_) {}
    const el = marker.getElement?.();
    if (el) el.classList.remove("is-moving");
    if (state.activeMoveFlagId === flagId) state.activeMoveFlagId = null;
  }

  // ----- Mutations (API + local fallback) -------------------------------

  // Brief auto-dismiss toast for placement / delete / move feedback.
  // Reuses the .ltb-move-toast styling (centered pill at bottom).
  // Driver doesn't want a permanent status widget; this only appears for
  // ~2-3 seconds right after an action and confirms whether it actually
  // reached the backend so cross-driver sync is observable.
  function showPlacementToast(message, kind = "ok") {
    if (typeof document === "undefined") return;
    const toast = document.createElement("div");
    toast.className = "ltb-move-toast";
    toast.textContent = message;
    if (kind === "error") toast.style.background = "rgba(153,27,27,0.95)";
    document.body.appendChild(toast);
    setTimeout(() => { try { toast.remove(); } catch (_) {} }, kind === "error" ? 3500 : 1600);
  }

  async function addFlag(lngLat, color) {
    if (!Object.prototype.hasOwnProperty.call(COLORS, color)) return;
    if (!lngLat || !Number.isFinite(lngLat.lng) || !Number.isFinite(lngLat.lat)) return;
    // Always try the API. The previous gate ("skip if backendAvailable
    // === false") meant that one transient poll failure left every
    // subsequent placement local-only, which silently broke sharing.
    let flag = null;
    let createErr = null;
    try {
      flag = await apiCreate(lngLat, color);
      state.backendAvailable = true;
    } catch (e) {
      createErr = e;
      state.backendAvailable = false;
      console.warn(
        `[long-trips-block] create failed (${e?.status || "network"} ${e?.url || ""}), saving locally:`, e
      );
    }
    if (!flag) {
      flag = {
        id: uid(),
        lng: lngLat.lng,
        lat: lngLat.lat,
        color,
        createdAt: Date.now(),
        createdBy: null,
      };
    }
    state.flags.push(flag);
    if (state.flags.length > MAX_LOCAL_CACHE) {
      const dropped = state.flags.shift();
      if (dropped) {
        const m = state.markers[dropped.id];
        if (m) { try { m.remove(); } catch (_) {} delete state.markers[dropped.id]; }
      }
    }
    saveCache();
    renderFlag(flag);
    if (createErr) {
      const code = createErr?.status || "net";
      showPlacementToast(`Not shared: ${code} (only on your device)`, "error");
    } else {
      showPlacementToast("Saved — others will see it within 20s", "ok");
    }
  }

  async function removeFlag(id) {
    const idx = state.flags.findIndex((f) => f.id === id);
    if (idx === -1) return;
    state.flags.splice(idx, 1);
    const marker = state.markers[id];
    if (marker) { try { marker.remove(); } catch (_) {} delete state.markers[id]; }
    if (useLayer) syncFlagLayer();
    saveCache();
    // Always try; same reasoning as addFlag.
    try {
      await apiDelete(id);
      state.backendAvailable = true;
    } catch (e) {
      state.backendAvailable = false;
      console.warn(
        `[long-trips-block] delete failed (${e?.status || "network"} ${e?.url || ""}), kept local removal:`, e
      );
    }
  }

  // ----- Reconcile + poll -----------------------------------------------
  // Driver feedback after the first cut: other drivers weren't seeing
  // newly-placed flags until they manually refreshed. So we poll every
  // POLL_INTERVAL_MS and reconcile incrementally instead of wiping +
  // re-rendering everything (which would jitter markers and would also
  // wipe local flags that haven't been POSTed yet).

  const POLL_INTERVAL_MS = 20000;
  let pollTimer = null;

  function reconcileFromServer(serverFlags) {
    if (!mapRef) return;
    const serverById = new Map(serverFlags.map((f) => [f.id, f]));
    const next = [];

    // 1. Flags the server has: add if new, update if moved/recolored.
    //    Skip the flag currently being dragged so polling doesn't fight
    //    the user's in-flight move.
    for (const sf of serverFlags) {
      const local = state.flags.find((f) => f.id === sf.id);
      if (state.activeMoveFlagId === sf.id) {
        next.push(local || sf);
        continue;
      }
      if (!local) {
        next.push(sf);
        renderFlag(sf);
        continue;
      }
      const changed = local.lng !== sf.lng || local.lat !== sf.lat || local.color !== sf.color;
      if (changed) {
        const m = state.markers[sf.id];
        if (m) { try { m.remove(); } catch (_) {} delete state.markers[sf.id]; }
        next.push(sf);
        renderFlag(sf);
      } else {
        next.push(local);
      }
    }

    // 2. Flags the server doesn't have: drop them IF they have a
    //    server-issued id (ltf-…) — someone else removed them.
    //    Keep local-only ids (ltb-…) because they're queued local writes
    //    that never reached the backend (e.g. offline placement).
    for (const local of state.flags) {
      if (serverById.has(local.id)) continue;
      const isServerId = String(local.id || "").startsWith("ltf-");
      if (isServerId) {
        const m = state.markers[local.id];
        if (m) { try { m.remove(); } catch (_) {} delete state.markers[local.id]; }
      } else {
        next.push(local);
      }
    }

    state.flags = next;
    saveCache();
    applyScaleToAllMarkers();
    // One layer update covers all add/update/delete from the reconcile
    // (the per-renderFlag calls above are no-ops on the layer path; this
    // commits the final state in one src.setData).
    if (useLayer) syncFlagLayer();
  }

  async function pollOnce({ silent } = {}) {
    // Don't poll mid-action — would jitter markers / re-fight UI.
    if (state.placementActive) return;
    if (typeof document !== "undefined" && document.hidden) return;
    try {
      const serverFlags = await apiList();
      reconcileFromServer(serverFlags);
      state.backendAvailable = true;
      if (!silent) {
        console.info(`[long-trips-block] poll synced ${serverFlags.length} flag(s)`);
      }
    } catch (e) {
      state.backendAvailable = false;
      console.warn(
        `[long-trips-block] poll failed (${e?.status || "network"} ${e?.url || ""}):`, e
      );
    }
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => { pollOnce({ silent: true }); }, POLL_INTERVAL_MS);
    if (typeof document !== "undefined") {
      // Poll immediately when the tab becomes visible — covers the
      // "driver Alt-Tab'd back" case without waiting up to 20s.
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) pollOnce({ silent: true });
      });
    }
  }

  // ----- Init -----------------------------------------------------------

  async function init(map) {
    if (initDone) return;
    initDone = true;
    mapRef = map;
    injectCss();
    console.info(`[long-trips-block] init: API base = ${apiBase() || "(empty)"}; auth = ${Object.keys(authHeaders()).length ? "yes" : "NO TOKEN"}`);

    // Paint cached flags immediately so the map doesn't look empty while
    // the GET request is in flight. renderFlag routes to DOM markers
    // initially; ensureFlagLayer() below promotes us to the zero-drift
    // GeoJSON layer if it initializes successfully.
    loadCache();
    state.flags.forEach(renderFlag);
    applyScaleToAllMarkers();
    map.on("zoom", applyScaleToAllMarkers);
    attachMapLongPress(map);
    // Try to upgrade to layer rendering. ensureFlagLayer waits for the
    // map style to be loaded if it isn't yet. On success, sweeps the
    // DOM markers and switches to the layer. On failure, useLayer
    // stays false and the DOM marker path continues unchanged.
    ensureFlagLayer();

    // First sync: same reconciliation path the poller uses, so the
    // initial render and steady-state stay consistent.
    try {
      const serverFlags = await apiList();
      reconcileFromServer(serverFlags);
      state.backendAvailable = true;
      console.info(`[long-trips-block] initial sync: ${serverFlags.length} flag(s) from server`);
    } catch (e) {
      state.backendAvailable = false;
      console.warn(
        `[long-trips-block] server unreachable on init (${e?.status || "network"} ${e?.url || ""}); using local cache:`, e
      );
    }

    // Start polling so other drivers' flags appear within POLL_INTERVAL_MS.
    startPolling();
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
        console.info("[long-trips-block] initialized");
      } catch (e) {
        console.warn("[long-trips-block] init failed:", e);
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

  window.LongTripsBlockFeature = {
    addFlag,
    removeFlag,
    getFlags: () => state.flags.map((f) => ({ ...f })),
    enterMoveMode,
    refresh: async () => {
      try {
        const serverFlags = await apiList();
        reconcileFromServer(serverFlags);
        state.backendAvailable = true;
        return serverFlags.length;
      } catch (e) {
        state.backendAvailable = false;
        throw e;
      }
    },
    clearAll: () => {
      removeAllRenderedFlags();
      state.flags = [];
      saveCache();
    },
  };
})();
