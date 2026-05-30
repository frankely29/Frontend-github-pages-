// Long Trips Block: driver-placed flags on the map marking spots worth
// waiting at for long (45+ min) trips. Three colors: green = best, sky =
// medium, yellow = normal. Long-press the map for 3 seconds to place;
// long-press an existing flag for 3 seconds to remove. Storage is
// localStorage-only (per-driver, per-device); shared/cross-device sync is
// a follow-up if drivers want it.
(function () {
  const STORAGE_KEY = "tlcLongTripBlockFlags";
  const HOLD_MS = 3000;
  const MOVE_TOLERANCE_PX = 18;
  const MAX_FLAGS = 200;
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
  };
  let mapRef = null;
  let initDone = false;

  function uid() {
    return `ltb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function load() {
    try {
      const raw = window.localStorage?.getItem?.(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      state.flags = parsed.filter((f) =>
        f && typeof f.id === "string"
          && Number.isFinite(f.lng) && Number.isFinite(f.lat)
          && Object.prototype.hasOwnProperty.call(COLORS, f.color)
      ).slice(-MAX_FLAGS);
    } catch (_) {
      state.flags = [];
    }
  }

  function save() {
    try {
      window.localStorage?.setItem?.(STORAGE_KEY, JSON.stringify(state.flags));
    } catch (_) { /* quota or disabled — silent */ }
  }

  function injectCss() {
    if (document.getElementById("long-trips-block-css")) return;
    const css = `
      .ltb-flag {
        position: relative; width: 34px; height: 42px;
        cursor: pointer; user-select: none; -webkit-user-select: none;
        -webkit-touch-callout: none; touch-action: none;
        /* No transform here -- MapLibre Marker drives this element's
           translate3d every frame; any class transform would be clobbered. */
      }
      .ltb-flag-scale {
        position: absolute; left: 0; top: 0; width: 100%; height: 100%;
        transform-origin: 50% 100%;  /* scale toward the pin tip (bottom-center) */
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

      .ltb-hold-indicator {
        position: fixed; pointer-events: none; z-index: 9998;
        width: 56px; height: 56px; border-radius: 50%;
        transform: translate(-50%, -50%);
        background: rgba(15,23,42,0.10);
        border: 2px solid rgba(15,23,42,0.6);
        animation: ltb-hold-fill 3s linear forwards;
      }
      @keyframes ltb-hold-fill {
        0%   { transform: translate(-50%, -50%) scale(0.4); opacity: 0.0; }
        25%  { transform: translate(-50%, -50%) scale(0.7); opacity: 0.6; }
        100% { transform: translate(-50%, -50%) scale(1.1); opacity: 0.95; }
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
      .ltb-picker-title {
        margin: 0 0 4px; font-size: 15px; font-weight: 700;
      }
      .ltb-picker-sub {
        margin: 0 0 12px; font-size: 12px; color: #475569; line-height: 1.35;
      }
      .ltb-picker-buttons {
        display: flex; flex-direction: column; gap: 8px;
      }
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
    // Inner .ltb-flag-scale element carries the zoom-driven scale transform.
    // The outer .ltb-flag is positioned by MapLibre Marker (it sets its own
    // translate3d each frame); putting a scale on the outer element would
    // be clobbered. The inner element scales toward bottom-center so the
    // pin tip stays anchored at the lat/lng as it shrinks.
    root.innerHTML = `
      <div class="ltb-flag-scale">
        <div class="ltb-flag-pulse"></div>
        <div class="ltb-flag-pole"></div>
        <div class="ltb-flag-pennant" style="background:${palette.hex};border:1px solid ${palette.border};">${FLAG_TEXT}</div>
      </div>
    `;
    return root;
  }

  function renderFlag(flag) {
    if (!mapRef || !window.maplibregl?.Marker) return;
    const el = buildFlagElement(flag);
    // Initialise scale so newly-dropped flags appear at the right size
    // immediately, before the first zoom event would otherwise update it.
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
      // Don't let the map see this — the flag's long-press shouldn't double
      // as a map long-press.
      e.stopPropagation();
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
  }

  function attachMapLongPress(map) {
    // Route via MapLibre's own event system instead of raw DOM
    // pointerdown/pointermove on the canvas-container. MapLibre normalises
    // mouse and touch into 'mousedown' / 'touchstart' events with
    // pre-computed e.lngLat, sidestepping two bugs the previous DOM-event
    // path was hitting on mobile:
    //   1. e.offsetX/offsetY on the canvas-container was inconsistent on
    //      iOS Safari, so map.unproject() got the wrong screen point and
    //      the picker dropped the flag in the wrong spot (or threw).
    //   2. MapLibre's gesture handlers attach to the canvas itself with
    //      capture, so pointer events on the container were sometimes
    //      delivered AFTER MapLibre had already started consuming them --
    //      the hold timer never had a chance to fire.
    // Cancel on dragstart/zoomstart as a belt-and-suspenders guard so the
    // hold dies the moment MapLibre decides the gesture is a pan/zoom.

    let timer = null;
    let startClientX = 0;
    let startClientY = 0;
    let startLngLat = null;
    let indicatorEl = null;
    let activeTouchId = null;
    let lastStartAt = 0;

    const cancel = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (indicatorEl) { indicatorEl.remove(); indicatorEl = null; }
      startLngLat = null;
      activeTouchId = null;
      // Restore zone fills if we dimmed them and the picker isn't open
      // (the picker has its own backdrop and will call restore on its own
      // dismissal). Safe to call when nothing was dimmed -- it's a no-op.
      restoreZoneFills();
    };

    const startHold = (clientX, clientY, lngLat) => {
      // Mouse + touch may both fire on hybrid devices; ignore the second
      // event when they land within 120ms of each other.
      if (Date.now() - lastStartAt < 120) return;
      lastStartAt = Date.now();
      cancel();
      startClientX = clientX; startClientY = clientY; startLngLat = lngLat;
      indicatorEl = document.createElement("div");
      indicatorEl.className = "ltb-hold-indicator";
      indicatorEl.style.left = `${clientX}px`;
      indicatorEl.style.top = `${clientY}px`;
      document.body.appendChild(indicatorEl);
      // Dim the zone fills so the street grid underneath becomes visible
      // -- otherwise the colored zones cover the streets and it's hard to
      // pick the right block. Restored by cancel() above or by the
      // picker's resolve callback below.
      dimZoneFills();
      timer = setTimeout(() => {
        const lngLatCopy = startLngLat;
        // Don't restore fills yet -- the picker is about to open. Strip
        // the indicator + timer state but keep the fills dimmed so the
        // street context is still visible during the picker.
        if (timer) { clearTimeout(timer); timer = null; }
        if (indicatorEl) { indicatorEl.remove(); indicatorEl = null; }
        startLngLat = null;
        activeTouchId = null;
        if (!lngLatCopy) { restoreZoneFills(); return; }
        state.suppressClickUntilMs = Date.now() + SUPPRESS_NEXT_CLICK_MS;
        showColorPicker(lngLatCopy, (color) => {
          if (color) addFlag(lngLatCopy, color);
          restoreZoneFills();
        });
      }, HOLD_MS);
    };

    const checkMove = (clientX, clientY) => {
      if (!timer) return;
      if (Math.hypot(clientX - startClientX, clientY - startClientY) > MOVE_TOLERANCE_PX) cancel();
    };

    map.on("mousedown", (e) => {
      const orig = e.originalEvent;
      if (orig?.button !== 0) return;
      const target = orig?.target;
      if (target instanceof Element && target.closest?.(".ltb-flag")) return;
      startHold(orig.clientX, orig.clientY, e.lngLat);
    });

    map.on("touchstart", (e) => {
      const orig = e.originalEvent;
      if (!orig?.touches || orig.touches.length !== 1) {
        // Multi-finger -- almost certainly a pinch-zoom; stand down.
        cancel();
        return;
      }
      const touch = orig.touches[0];
      const target = touch.target;
      if (target instanceof Element && target.closest?.(".ltb-flag")) return;
      activeTouchId = touch.identifier;
      startHold(touch.clientX, touch.clientY, e.lngLat);
    });

    map.on("mousemove", (e) => {
      const orig = e.originalEvent;
      checkMove(orig.clientX, orig.clientY);
    });

    map.on("touchmove", (e) => {
      const orig = e.originalEvent;
      if (!orig?.touches) return cancel();
      let touch = null;
      for (const t of orig.touches) {
        if (t.identifier === activeTouchId) { touch = t; break; }
      }
      if (!touch) return cancel();
      checkMove(touch.clientX, touch.clientY);
    });

    map.on("mouseup", cancel);
    map.on("touchend", cancel);
    map.on("touchcancel", cancel);
    map.on("dragstart", cancel);
    map.on("zoomstart", cancel);
    map.on("pitchstart", cancel);
    map.on("rotatestart", cancel);

    // Suppress the trailing click MapLibre synthesizes after a long-press
    // fires, so the existing zone-click popup doesn't pop on top of our
    // color picker. Capture-phase on document covers both MapLibre's
    // own click events and any DOM-level zone-click handler.
    document.addEventListener("click", (e) => {
      if (state.suppressClickUntilMs && Date.now() < state.suppressClickUntilMs) {
        e.stopPropagation();
        e.preventDefault();
      }
    }, { capture: true });
  }

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
        <div class="ltb-picker-title">Remove this spot?</div>
        <div class="ltb-picker-sub">
          <span class="ltb-swatch" style="display:inline-block;vertical-align:middle;margin-right:6px;background:${swatch.hex};"></span>
          ${swatch.label} flag · ${FLAG_TEXT}
        </div>
        <div class="ltb-picker-buttons">
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
      onChoiceMade?.();
    };
    backdrop.addEventListener("click", (e) => {
      const btn = e.target.closest?.("button");
      if (btn) { finish(btn.dataset.action); return; }
      if (e.target === backdrop) finish("cancel");
    });
    document.body.appendChild(backdrop);
  }

  function addFlag(lngLat, color) {
    if (!Object.prototype.hasOwnProperty.call(COLORS, color)) return;
    if (!lngLat || !Number.isFinite(lngLat.lng) || !Number.isFinite(lngLat.lat)) return;
    if (state.flags.length >= MAX_FLAGS) {
      // Drop oldest to make room. Cap is generous, so this is a soft guard.
      const dropped = state.flags.shift();
      if (dropped) {
        const m = state.markers[dropped.id];
        if (m) { try { m.remove(); } catch (_) {} delete state.markers[dropped.id]; }
      }
    }
    const flag = {
      id: uid(),
      lng: lngLat.lng,
      lat: lngLat.lat,
      color,
      createdAt: Date.now(),
    };
    state.flags.push(flag);
    save();
    renderFlag(flag);
  }

  function removeFlag(id) {
    const idx = state.flags.findIndex((f) => f.id === id);
    if (idx === -1) return;
    state.flags.splice(idx, 1);
    const marker = state.markers[id];
    if (marker) { try { marker.remove(); } catch (_) {} delete state.markers[id]; }
    save();
  }

  // Compute a marker scale that mimics how MapLibre symbol layers
  // (hotspot dots, zone labels) shrink with the zoom-out. Full size at
  // z>=15 (close-in detail view), 30% at z<=9 (citywide overview),
  // linear between. Markers stay anchored at their lat/lng -- only the
  // visual scales.
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
    const scale = scaleForZoom(mapRef.getZoom?.());
    const value = scale.toFixed(3);
    Object.values(state.markers).forEach((marker) => {
      const el = marker?.getElement?.();
      if (el) el.style.setProperty("--ltb-zoom-scale", value);
    });
  }

  // Dim the zone fill layers while the driver is mid-hold so the
  // street grid underneath becomes visible -- otherwise the colored
  // zones cover the streets and it's hard to pick a precise spot. Save
  // the original paint expression (which may be an interpolate-by-zoom
  // expression) and restore it on every exit path.
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
      } catch (_) { /* layer not present yet -- skip */ }
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

  function init(map) {
    if (initDone) return;
    initDone = true;
    mapRef = map;
    injectCss();
    load();
    state.flags.forEach(renderFlag);
    applyScaleToAllMarkers();
    map.on("zoom", applyScaleToAllMarkers);
    attachMapLongPress(map);
  }

  function resolveMapInstance() {
    // app.js declares `let map;` at top level (classic script). That
    // creates a global lexical binding accessible as the bare identifier
    // `map`, but does NOT mirror onto window.map -- so polling
    // `window.map` returns undefined forever and our init never runs.
    // Try the lexical global first, then a couple of fallbacks for
    // forward-compat with module-script migrations.
    try {
      // eslint-disable-next-line no-undef
      if (typeof map !== "undefined" && map) return map;
    } catch (_) { /* ReferenceError shouldn't fire from typeof but be safe */ }
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
    clearAll: () => {
      removeAllRenderedFlags();
      state.flags = [];
      save();
    },
  };
})();
