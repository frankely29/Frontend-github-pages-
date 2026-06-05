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
        position: relative; width: 44px; height: 44px;
        cursor: pointer; user-select: none; -webkit-user-select: none;
        -webkit-touch-callout: none; touch-action: none;
      }
      .ltb-flag-scale {
        position: absolute; left: 0; top: 0; width: 100%; height: 100%;
        transform-origin: 50% 50%;
        transform: scale(var(--ltb-zoom-scale, 1));
        transition: transform 120ms ease-out;
        will-change: transform;
      }
      .ltb-flag-fill {
        position: absolute; inset: 0;
        border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        font: 700 11px/1 -apple-system, system-ui, "Segoe UI", sans-serif;
        color: #1f2937; letter-spacing: 0.5px;
        box-shadow: 0 2px 4px rgba(0,0,0,0.35);
      }
      .ltb-flag-pulse {
        position: absolute; left: 50%; top: 50%;
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
    // Circle shape matching the LTF_DISC_LAYER_ID circle marker.
    // Used only for interactive move/preview states; static flags
    // render via the circle layer (no DOM fallback).
    root.innerHTML = `
      <div class="ltb-flag-scale">
        <div class="ltb-flag-pulse"></div>
        <div class="ltb-flag-fill" style="background:${palette.hex};border:2px solid ${palette.border};">${FLAG_TEXT}</div>
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
  const LTF_DISC_LAYER_ID = "long-trip-flags-disc";          // diamond ◆ symbol layer (was a circle before)
  const LTF_TEXT_LAYER_ID = "long-trip-flags-text";          // "45+" label
  let useLayer = false;
  let flagLayerInitStarted = false;

  // Round lng/lat to 6 decimal places (~11cm precision) before pushing
  // into the GeoJSON source. Why: float64 lon/lat values from MapLibre's
  // map.unproject() carry 15-16 significant digits, but the deep-
  // research investigation behind PR #958 confirmed that geojson-vt's
  // worker-side projection + `Math.round` quantization re-evaluates
  // at every integer zoom level. The rounding error differs per zoom,
  // visible as drift. Pre-snapping client-side to a coarser grid means
  // the same lng/lat hash to the same tile-cell at every zoom level,
  // eliminating the per-zoom re-quantization without needing to play
  // with source `buffer` or `maxzoom` (which break the circle layer).
  //
  // 6 decimals = ~11cm at any latitude. At zoom 22 (the highest a
  // taxi-driver app realistically goes) one pixel ≈ 10cm at the
  // equator, so 11cm rounding is sub-pixel at every zoom we care
  // about. This is the workaround documented in the MapLibre large-
  // data guide ("you can reduce the coordinate precision to around 6
  // decimals").
  function snapCoord(n) {
    return Math.round(n * 1e6) / 1e6;
  }

  // ----- Custom WebGL layer (zero-drift, surgical) -----------------------
  //
  // Why this exists: after 12+ PRs of trying to fix marker drift via
  // MapLibre's standard rendering primitives (symbol layer, circle layer,
  // DOM Marker, source quantization options, coord snap, etc.) the deep-
  // research investigation conclusively confirmed that:
  //
  //   - Symbol layer positions are integer-pixel rounded; no opt-out.
  //   - DOM Marker is CSS-positioned, raced against the WebGL commit.
  //   - Both render OUTSIDE the basemap's per-frame GPU draw, which
  //     introduces one-frame projection lag on iOS Safari.
  //
  // The research-recommended surgical fix is a custom layer (type=custom)
  // -- a MapLibre-supported first-class layer type that lets us draw our
  // own WebGL inside the map's render pipeline, using the SAME projection
  // matrix the basemap uses. Same GL commit. No DOM. No symbol placement.
  // No integer rounding. The price: we write the shader and manage our
  // own buffers.
  //
  // MVP renders flags as colored points only. The "45+" text overlay
  // requires a texture atlas; deferred to a follow-up once we've
  // confirmed zero drift on the geometry.

  const LTF_CUSTOM_LAYER_ID = "long-trip-flags-custom-gl";
  let flagCustomLayer = null;

  // Z-order keeper. Each addLayer() call without a beforeId puts the
  // layer at the END of the layer list (= rendered last = on top). That's
  // correct at the moment of addition. But MapLibre re-renders the layer
  // list whenever the style changes — zones reload, mode switches, source
  // data updates can all insert new layers, and any layer added AFTER the
  // flag layer would render on top, hiding the flag under zone fills.
  //
  // Symptom (intermittent, per-user): flags appear underneath the zone
  // colors. Fix: listen for `styledata` events and re-move the flag
  // layers to the top whenever the style changes. rAF batches multiple
  // events in one frame into a single move pass; an `inMove` flag
  // prevents the recursion that would otherwise happen because
  // moveLayer itself triggers styledata.

  let flagZOrderListenerInstalled = false;
  let flagZOrderMovePending = false;
  let flagZOrderInMove = false;

  function installFlagZOrderKeeper() {
    if (flagZOrderListenerInstalled || !mapRef) return;
    flagZOrderListenerInstalled = true;
    const ids = [LTF_CUSTOM_LAYER_ID, LTF_DISC_LAYER_ID, LTF_TEXT_LAYER_ID];
    const scheduleMove = () => {
      if (flagZOrderInMove || flagZOrderMovePending) return;
      flagZOrderMovePending = true;
      const raf = (typeof window !== "undefined" && window.requestAnimationFrame)
        || ((fn) => setTimeout(fn, 16));
      raf(() => {
        flagZOrderMovePending = false;
        if (!mapRef) return;
        const presentIds = ids.filter((id) => mapRef.getLayer?.(id));
        if (!presentIds.length) return;
        flagZOrderInMove = true;
        try {
          // moveLayer with no second arg moves to the end of the layer
          // list. Doing them in order custom → disc → text leaves them
          // at the very top, with disc above custom and text above disc.
          for (const id of presentIds) {
            try { mapRef.moveLayer(id); } catch (_) {}
          }
        } finally {
          flagZOrderInMove = false;
        }
      });
    };
    try { mapRef.on?.("styledata", scheduleMove); } catch (_) {}
  }

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`[ltb-gl] shader compile failed: ${log}`);
    }
    return shader;
  }

  function linkProgram(gl, vsSource, fsSource) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`[ltb-gl] program link failed: ${log}`);
    }
    return program;
  }

  // Textured-quad pipeline (zero drift + flag SHAPE).
  //
  // Why: every other MapLibre primitive forces a trade-off:
  //   - type=circle: zero drift, circles only.
  //   - type=symbol + icon-image: any shape, but symbol placement
  //     integer-pixel rounds every frame on iOS Safari (the drift).
  //   - DOM Marker: any shape, but CSS positioning races the WebGL
  //     commit on iOS → drift during inertial zoom.
  //
  // A custom layer draws a textured quad inside MapLibre's own render
  // pipeline, using the same projection matrix the basemap uses, in
  // the same GL commit. No symbol placement step. No DOM. No integer
  // rounding. The texture can be any shape — we render the
  // pole+pennant+"45+" flag PNG on a canvas, upload as a texture
  // atlas with one slice per color, sample from the atlas per flag.
  //
  // Quad layout (per flag, 4 vertices, 6 indices):
  //   Anchor (a_anchor_px)  = bottom of pole, in CSS pixels.
  //                           Computed each frame on the CPU via
  //                           map.project([lng, lat]) — see the
  //                           shader comment below for the why.
  //   Corner offsets (a_corner_px) = CSS pixels relative to anchor.
  //     Top of flag is `-h` (above anchor in screen-px convention).
  //     Bottom of flag is at anchor (cy_px=0).
  //   UV (a_uv) picks the right horizontal slice in the atlas.

  // The shader was originally projecting Mercator [0,1] coords through
  // MapLibre's customLayerMatrix (which incorporates a worldSize scale,
  // ~4M at zoom 13). Multiplying small Mercator values by huge worldSize
  // in float32 loses sub-pixel precision — that's what drove the drift
  // back in PR #971/#972. Built-in MapLibre layers avoid it by using
  // per-tile coordinates (small numbers, per-tile matrix incorporates
  // the offset).
  //
  // The fix: project on the CPU via `map.project()` (which is the same
  // function MapLibre uses internally for hit-testing, in float64), and
  // upload the resulting CSS-pixel anchor to the vertex buffer. The
  // shader then just does CSS-px → clip-space — no big numbers, no
  // float32 precision loss.
  //
  // Per-frame rebuild cost is trivial (a few hundred floats), and
  // MapLibre only calls render() on active frames anyway.

  const FLAG_VS = `
    precision highp float;
    attribute vec2 a_anchor_px;
    attribute vec2 a_corner_px;
    attribute vec2 a_uv;
    uniform vec2 u_viewport_css_px;
    uniform float u_size_scale;
    varying vec2 v_uv;
    void main() {
      vec2 px = a_anchor_px + a_corner_px * u_size_scale;
      // CSS px → clip. CSS y is down, clip y is up — flip y.
      vec2 clip = vec2(
            (px.x / u_viewport_css_px.x) * 2.0 - 1.0,
        1.0 - (px.y / u_viewport_css_px.y) * 2.0
      );
      gl_Position = vec4(clip, 0.0, 1.0);
      v_uv = a_uv;
    }
  `;

  const FLAG_FS = `
    precision mediump float;
    uniform sampler2D u_texture;
    varying vec2 v_uv;
    void main() {
      vec4 c = texture2D(u_texture, v_uv);
      if (c.a < 0.02) discard;
      gl_FragColor = c;
    }
  `;

  // Flag atlas: three flag images side-by-side on one canvas.
  // CSS pixels per flag = (FLAG_W_CSS x FLAG_H_CSS); the canvas is
  // drawn at 2x for retina sharpness.
  const FLAG_W_CSS = 34;
  const FLAG_H_CSS = 42;
  const FLAG_ATLAS_SLICES = ["green", "sky", "yellow"];

  function drawFlagInto(ctx, color, xOff, yOff, W, H) {
    const palette = COLORS[color] || COLORS.yellow;
    // Pole: vertical bar near image-center, full height.
    ctx.fillStyle = "#1f2937";
    ctx.fillRect(xOff + W / 2 - 2, yOff, 4, H);
    // Pennant attached at the top of the pole.
    const pX = xOff + W / 2;
    const pY = yOff;
    const pW = Math.round(W * 0.82);
    const pH = Math.round(H * 0.52);
    ctx.fillStyle = palette.hex;
    ctx.strokeStyle = palette.border;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pX, pY);
    ctx.lineTo(pX + pW, pY);
    ctx.lineTo(pX + pW, pY + pH * 0.65);
    ctx.lineTo(pX + pW * 0.6, pY + pH);
    ctx.lineTo(pX, pY + pH);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // "45+" label on the pennant.
    ctx.fillStyle = "#1f2937";
    ctx.font = `bold ${Math.round(pH * 0.5)}px -apple-system, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(FLAG_TEXT, pX + pW * 0.4, pY + pH * 0.45);
  }

  function buildFlagAtlas() {
    const scale = 2; // 2x for retina
    const flagW = FLAG_W_CSS * scale;
    const flagH = FLAG_H_CSS * scale;
    const W = flagW * FLAG_ATLAS_SLICES.length;
    const H = flagH;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    for (let i = 0; i < FLAG_ATLAS_SLICES.length; i++) {
      drawFlagInto(ctx, FLAG_ATLAS_SLICES[i], i * flagW, 0, flagW, flagH);
    }
    return { canvas, flagW, flagH, W, H, slices: FLAG_ATLAS_SLICES };
  }

  // Same curve as the disc layer's circle-radius interpolation:
  // smaller at low zoom, bigger zoomed in.
  function flagZoomScale(z) {
    if (!Number.isFinite(z)) return 0.85;
    if (z <= 9) return 0.60;
    if (z >= 16) return 1.10;
    if (z <= 13) return 0.60 + (0.85 - 0.60) * ((z - 9) / 4);
    return 0.85 + (1.10 - 0.85) * ((z - 13) / 3);
  }

  function createFlagCustomLayer() {
    return {
      id: LTF_CUSTOM_LAYER_ID,
      type: "custom",
      renderingMode: "2d",

      _map: null,
      _gl: null,
      _program: null,
      _vbo: null,
      _ibo: null,
      _texture: null,
      _atlas: null,
      _quadCount: 0,
      _flags: [],
      _attrib: null,
      _uni: null,

      onAdd(map, gl) {
        this._map = map;
        this._gl = gl;

        this._atlas = buildFlagAtlas();
        if (!this._atlas) {
          console.warn("[ltb-gl] atlas build failed");
          return;
        }

        try {
          this._program = linkProgram(gl, FLAG_VS, FLAG_FS);
        } catch (e) {
          console.warn("[ltb-gl] shader setup failed:", e);
          this._program = null;
          return;
        }

        this._attrib = {
          anchor: gl.getAttribLocation(this._program, "a_anchor_px"),
          corner: gl.getAttribLocation(this._program, "a_corner_px"),
          uv: gl.getAttribLocation(this._program, "a_uv"),
        };
        this._uni = {
          viewport: gl.getUniformLocation(this._program, "u_viewport_css_px"),
          sizeScale: gl.getUniformLocation(this._program, "u_size_scale"),
          texture: gl.getUniformLocation(this._program, "u_texture"),
        };

        this._vbo = gl.createBuffer();
        this._ibo = gl.createBuffer();
        this._texture = gl.createTexture();

        // Upload the atlas as a premultiplied texture so MapLibre's
        // (one, one_minus_src_alpha) blend renders it correctly.
        gl.bindTexture(gl.TEXTURE_2D, this._texture);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(
          gl.TEXTURE_2D, 0,
          gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE,
          this._atlas.canvas
        );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, null);

        // _quadCount tracks the number of flags ready to draw. It is
        // updated by setFlags(); the buffer itself is built fresh in
        // render() each frame from the latest map projection.
        this._quadCount = this._flags.length;
      },

      onRemove(_map, gl) {
        if (this._program) gl.deleteProgram(this._program);
        if (this._vbo) gl.deleteBuffer(this._vbo);
        if (this._ibo) gl.deleteBuffer(this._ibo);
        if (this._texture) gl.deleteTexture(this._texture);
        this._program = null;
        this._vbo = null;
        this._ibo = null;
        this._texture = null;
        this._atlas = null;
      },

      setFlags(flags) {
        this._flags = Array.isArray(flags) ? flags : [];
        this._quadCount = this._flags.length;
        // No buffer upload here — render() rebuilds the buffer from the
        // current map projection each frame. We just need a repaint so
        // that next frame's render() picks up the new flag list.
        this._map?.triggerRepaint();
      },

      // Rebuild the vertex buffer for the current camera state. Called
      // from render() every frame (cheap: ~24 floats per flag, well
      // under 500 flags in practice). Uses map.project() — the same
      // function MapLibre uses for hit-testing internally, in float64
      // precision. This is the path that avoids float32 drift.
      _rebuildProjectedBuffer() {
        const gl = this._gl;
        if (!gl || !this._program || !this._atlas || !this._map) return false;
        if (typeof this._map.project !== "function") return false;
        const flags = this._flags;
        if (!flags.length) return false;

        const halfW = FLAG_W_CSS / 2;
        const fullH = FLAG_H_CSS;
        const atlasW = this._atlas.W;
        const flagW = this._atlas.flagW;
        const slices = this._atlas.slices;

        const FLOATS_PER_VERTEX = 6;
        const vertices = new Float32Array(flags.length * 4 * FLOATS_PER_VERTEX);
        const indices = new Uint16Array(flags.length * 6);

        for (let i = 0; i < flags.length; i++) {
          const f = flags[i];
          let pt;
          try {
            pt = this._map.project([f.lng, f.lat]);
          } catch (_) {
            pt = { x: -10000, y: -10000 }; // off-screen if projection fails
          }
          let sliceIdx = slices.indexOf(f.color);
          if (sliceIdx < 0) sliceIdx = slices.indexOf("yellow");
          const uLeft = (sliceIdx * flagW) / atlasW;
          const uRight = ((sliceIdx + 1) * flagW) / atlasW;
          // Atlas y=0 is image-top (the pennant). Anchor (lng/lat) is
          // the pole tip, which is the BOTTOM of the image → v=1 for
          // bottom vertices.
          const v0 = i * 4 * FLOATS_PER_VERTEX;
          // Bottom-left
          vertices[v0 +  0] = pt.x; vertices[v0 +  1] = pt.y;
          vertices[v0 +  2] = -halfW; vertices[v0 +  3] = 0;
          vertices[v0 +  4] = uLeft;  vertices[v0 +  5] = 1;
          // Bottom-right
          vertices[v0 +  6] = pt.x; vertices[v0 +  7] = pt.y;
          vertices[v0 +  8] =  halfW; vertices[v0 +  9] = 0;
          vertices[v0 + 10] = uRight; vertices[v0 + 11] = 1;
          // Top-left (fullH px ABOVE anchor in screen px)
          vertices[v0 + 12] = pt.x; vertices[v0 + 13] = pt.y;
          vertices[v0 + 14] = -halfW; vertices[v0 + 15] = -fullH;
          vertices[v0 + 16] = uLeft;  vertices[v0 + 17] = 0;
          // Top-right
          vertices[v0 + 18] = pt.x; vertices[v0 + 19] = pt.y;
          vertices[v0 + 20] =  halfW; vertices[v0 + 21] = -fullH;
          vertices[v0 + 22] = uRight; vertices[v0 + 23] = 0;

          const base = i * 4;
          // Two triangles: (BL, BR, TL), (TL, BR, TR)
          indices[i * 6 + 0] = base + 0;
          indices[i * 6 + 1] = base + 1;
          indices[i * 6 + 2] = base + 2;
          indices[i * 6 + 3] = base + 2;
          indices[i * 6 + 4] = base + 1;
          indices[i * 6 + 5] = base + 3;
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW);
        return true;
      },

      render(gl, _matrix) {
        if (!this._program || !this._flags.length || !this._texture) return;

        // Re-project for THIS frame's camera before we draw. The
        // `_matrix` MapLibre hands us is unused — we don't want to feed
        // small Mercator coords through worldSize-scaled matrices in
        // float32 (that's what produced the drift).
        if (!this._rebuildProjectedBuffer()) return;

        const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
        const zoom = this._map?.getZoom?.();
        // corner_px is in CSS pixels and viewport uniform is in CSS
        // pixels too, so no dpr multiplication needed.
        const scale = flagZoomScale(zoom);

        gl.useProgram(this._program);
        gl.uniform2f(
          this._uni.viewport,
          gl.drawingBufferWidth / dpr,
          gl.drawingBufferHeight / dpr
        );
        gl.uniform1f(this._uni.sizeScale, scale);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this._texture);
        gl.uniform1i(this._uni.texture, 0);

        const blendWasEnabled = gl.getParameter(gl.BLEND);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        // Pins are screen-anchored UI; don't depth-test against tiles.
        gl.disable(gl.DEPTH_TEST);

        gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
        const stride = 6 * 4; // 6 floats × 4 bytes
        gl.enableVertexAttribArray(this._attrib.anchor);
        gl.vertexAttribPointer(this._attrib.anchor, 2, gl.FLOAT, false, stride, 0);
        gl.enableVertexAttribArray(this._attrib.corner);
        gl.vertexAttribPointer(this._attrib.corner, 2, gl.FLOAT, false, stride, 2 * 4);
        gl.enableVertexAttribArray(this._attrib.uv);
        gl.vertexAttribPointer(this._attrib.uv, 2, gl.FLOAT, false, stride, 4 * 4);

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._ibo);
        gl.drawElements(gl.TRIANGLES, this._quadCount * 6, gl.UNSIGNED_SHORT, 0);

        gl.disableVertexAttribArray(this._attrib.anchor);
        gl.disableVertexAttribArray(this._attrib.corner);
        gl.disableVertexAttribArray(this._attrib.uv);
        if (!blendWasEnabled) gl.disable(gl.BLEND);
      },
    };
  }

  function ensureFlagLayer() {
    if (useLayer || flagLayerInitStarted || !mapRef) return;
    if (!mapRef.isStyleLoaded?.()) {
      // Don't rely on map.once("load", ...) here. If the map already
      // fired "load" before this code runs, the once-listener never
      // fires. And after PR #980's aggressive zone backfill retries,
      // tile sources can briefly flip isStyleLoaded() back to false
      // when they reload — hitting that window would silently strand
      // the flag layer in `flagLayerInitStarted=true` forever, with
      // useLayer never flipping true, which is exactly the
      // "existing flags don't load" symptom.
      //
      // Use a polling loop instead. Idempotent — once useLayer flips
      // true, the poll exits. Capped at 30s so a truly stuck map
      // doesn't poll forever.
      flagLayerInitStarted = true;
      let attempts = 0;
      const pollHandle = setInterval(() => {
        attempts += 1;
        if (useLayer) {
          clearInterval(pollHandle);
          return;
        }
        if (attempts >= 100) {
          clearInterval(pollHandle);
          flagLayerInitStarted = false;
          console.warn("[long-trips-block] ensureFlagLayer poll timed out after 30s");
          return;
        }
        if (!mapRef?.isStyleLoaded?.()) return;
        clearInterval(pollHandle);
        flagLayerInitStarted = false;
        ensureFlagLayer();
      }, 300);
      return;
    }
    flagLayerInitStarted = true;
    try {
      // Three renderers, in order of preference:
      //
      //   1. Custom WebGL textured-quad layer  → flag SHAPE + zero drift
      //   2. Disc circle layer + "45+" text    → zero drift but no shape
      //      (PR #968 fallback if custom fails)
      //   3. DOM Markers                       → drifts on iOS but always
      //      works (handled outside this fn)
      //
      // The custom layer is the target. The disc fallback exists for
      // browsers where WebGL custom-layer setup fails (no WebGL, shader
      // compile error, addLayer rejected, etc.).
      //
      // No `beforeLayer` argument on addLayer, so layers append to the
      // END of the layer list and render on top of zone fills/labels.
      //
      // Hotspot code in app.part10.js is NOT touched.

      // Re-enabling the custom WebGL flag-shape layer (the CPU-projection
      // version from PR #973). Driver's hypothesis: the "drift" reports
      // after #971/#972/#973 may have actually been the DOM-marker
      // fallback flickering during init — the WebGL layer itself was
      // rendering zero-drift, but the DOM fallback was showing the old
      // flag visual on top for a brief moment, which read as drift.
      //
      // PR #976 removed the DOM fallback entirely. If the hypothesis is
      // correct, re-adding the WebGL layer should give the flag shape
      // with zero drift.
      //
      // Strategy:
      //   1. Try the custom WebGL layer first. If addLayer throws (no
      //      WebGL support, etc.), fall back to disc+text.
      //   2. The custom layer bakes "45+" into the flag canvas atlas,
      //      so the separate text layer is only added in the fallback.
      //   3. No DOM-marker fallback (#976/#977 stays).
      //
      // Hotspot code in app.part10.js is NOT touched.

      // Source for the disc + text fallback layers.
      if (!mapRef.getSource?.(LTF_SOURCE_ID)) {
        mapRef.addSource(LTF_SOURCE_ID, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
      }

      // 1. Try the custom WebGL flag-shape layer.
      let customAdded = false;
      try {
        if (mapRef.getLayer?.(LTF_CUSTOM_LAYER_ID)) {
          try { mapRef.removeLayer(LTF_CUSTOM_LAYER_ID); } catch (_) {}
        }
        flagCustomLayer = createFlagCustomLayer();
        mapRef.addLayer(flagCustomLayer);
        if (mapRef.getLayer?.(LTF_CUSTOM_LAYER_ID)) {
          customAdded = true;
          console.info("[long-trips-block] custom WebGL flag layer added (shape, CPU projection)");
        }
      } catch (e) {
        console.warn("[long-trips-block] custom WebGL layer init failed; falling back to disc:", e);
        flagCustomLayer = null;
      }

      // 2. Disc + text fallback (only when custom didn't land).
      let discAdded = false;
      let textAdded = false;
      if (!customAdded) {
        try {
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
          discAdded = true;
          console.info("[long-trips-block] disc fallback layer added");
        } catch (e) {
          console.warn("[long-trips-block] disc layer add failed:", e);
        }
        try {
          if (!mapRef.getLayer?.(LTF_TEXT_LAYER_ID)) {
            mapRef.addLayer({
              id: LTF_TEXT_LAYER_ID,
              type: "symbol",
              source: LTF_SOURCE_ID,
              layout: {
                "text-field": FLAG_TEXT,
                "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
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
                "text-halo-color": "rgba(255,255,255,0.85)",
                "text-halo-width": 1,
              },
            });
          }
          textAdded = true;
          console.info("[long-trips-block] text fallback layer added");
        } catch (e) {
          console.warn("[long-trips-block] text layer add failed:", e);
        }
      } else {
        // Custom WebGL succeeded — the flag PNG already bakes in "45+",
        // so the separate disc/text layers from a prior session would
        // render on top and look wrong. Sweep them.
        if (mapRef.getLayer?.(LTF_DISC_LAYER_ID)) {
          try { mapRef.removeLayer(LTF_DISC_LAYER_ID); } catch (_) {}
        }
        if (mapRef.getLayer?.(LTF_TEXT_LAYER_ID)) {
          try { mapRef.removeLayer(LTF_TEXT_LAYER_ID); } catch (_) {}
        }
      }

      // Remove the PR #969 icon-image symbol layer if it's still on
      // the style from a prior session.
      if (mapRef.getLayer?.(LTF_LAYER_ID)) {
        try { mapRef.removeLayer(LTF_LAYER_ID); } catch (_) {}
      }

      if (!customAdded && !discAdded && !textAdded) {
        console.warn("[long-trips-block] no flag layer landed; nothing will render");
        flagLayerInitStarted = false;
        return;
      }
      // Sweep DOM markers (defensive — there shouldn't be any after #976).
      Object.keys(state.markers).forEach((id) => {
        if (id === state.activeMoveFlagId) return;
        if (id === "__ltb_preview__") return;
        try { state.markers[id].remove(); } catch (_) {}
        delete state.markers[id];
      });
      useLayer = true;
      syncFlagLayer();
      installFlagZOrderKeeper();
      console.info(
        `[long-trips-block] flag layer active.` +
        ` custom=${customAdded ? "yes" : "no"}` +
        ` disc=${discAdded ? "yes" : "no"}` +
        ` text=${textAdded ? "yes" : "no"}`
      );
    } catch (e) {
      console.warn("[long-trips-block] flag layer init failed; falling back to DOM markers:", e);
      flagLayerInitStarted = false;
    }
  }

  // Stub: presence MVP layer's setData-based ensure path; keep the body
  // commented as dead code in case we revert. The active path is now
  // the custom WebGL layer in createFlagCustomLayer above.
  // eslint-disable-next-line no-unused-vars
  function ensureFlagLayer_LEGACY_SYMBOL() {
    return;
    // eslint-disable-next-line no-unreachable
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
      // Driver feedback iteration history:
      //   PR #953  type=symbol icon (full flag PNG)         -> some drift
      //   PR #957  type=circle disc + type=symbol text      -> better, still drift
      //   PR #958  + maxzoom=22 + tolerance=0 + buffer=0    -> drift fixed
      //                                                       but circle + buffer=0
      //                                                       clipped tile edges
      //                                                       -> flags invisible
      //   PR #961  drop buffer=0 only                       -> flags back, drift back
      //   PR #962  switch disc from circle -> symbol+icon-image -> drift fixed,
      //                                                       but addImage path
      //                                                       was flaky and flags
      //                                                       still invisible
      //
      // This PR: stop fighting the source quantization with buffer=0.
      // Instead, drop the lng/lat precision client-side BEFORE pushing
      // into the source (see snapCoord above). With both coords pinned
      // to 6 decimals (~11cm), geojson-vt's per-zoom Math.round always
      // rounds to the same tile-cell at every zoom -- no drift, no
      // change to source `buffer` (default 128, so circle renders), no
      // dependence on addImage. Driver-confirmed presence path is
      // untouched.
      //
      // Two layers on the same source:
      //   LTF_DISC_LAYER_ID    type=circle  -> colored disc (zero-drift
      //                                       once coords are pre-snapped)
      //   LTF_TEXT_LAYER_ID    type=symbol  -> "45+" label
      if (!mapRef.getSource?.(LTF_SOURCE_ID)) {
        mapRef.addSource(LTF_SOURCE_ID, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
          // Drift fix from deep-research: pin tile pyramid to one
          // quantization grid.
          maxzoom: 22,
          // No-op on points but explicit so a future MapLibre default
          // can't reintroduce simplification drift.
          tolerance: 0,
          // NOTE: NO `buffer: 0` here. With type=circle, buffer=0
          // clips circle-radius at tile edges -> flags vanish.
          // Default buffer (128 px) is what makes the disc visible.
          // Drift mitigation comes from snapCoord() instead.
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
            // PR #963 also set circle-pitch-alignment and
            // circle-pitch-scale to "viewport" as belt-and-braces for
            // iOS Safari precision. Removed: those options had no
            // visible benefit on this flat 2D view and we can't rule
            // out that they were the reason the disc didn't render
            // after #963 deployed.
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
    // Exclude the flag currently being interactively moved -- that one
    // is shown via a temp DOM marker for the duration of the drag.
    const hidden = state.activeMoveFlagId;
    const visible = state.flags.filter((f) => f.id !== hidden);

    // Push to the custom WebGL layer when it's the active renderer.
    if (flagCustomLayer?.setFlags) {
      flagCustomLayer.setFlags(visible);
    }

    // Also keep the GeoJSON source in sync for the disc/text fallback
    // path. No-op when only the custom layer is active.
    const src = mapRef.getSource?.(LTF_SOURCE_ID);
    if (src?.setData) {
      const features = visible.map((f) => ({
        type: "Feature",
        id: f.id,
        properties: { id: f.id, color: f.color },
        geometry: { type: "Point", coordinates: [f.lng, f.lat] },
      }));
      src.setData({ type: "FeatureCollection", features });
    }
  }

  function flagAtScreenPoint(point) {
    if (!useLayer || !mapRef) return null;

    // When the custom WebGL layer is the renderer, queryRenderedFeatures
    // cannot see its quads (custom layers are opaque to it). CPU hit-test:
    // project each flag's lng/lat to screen px (float64 via map.project()),
    // then test the tap against the flag's bounding box, matched to the
    // rendered quad sizing.
    if (flagCustomLayer?._program && typeof mapRef.project === "function") {
      const hidden = state.activeMoveFlagId;
      const flags = state.flags.filter((f) => f.id !== hidden);
      if (!flags.length) return null;
      const scale = flagZoomScale(mapRef.getZoom?.());
      const halfW = (FLAG_W_CSS / 2) * scale;
      const fullH = FLAG_H_CSS * scale;
      // Anchor is at pole tip (bottom of flag). Flag extends UP from
      // anchor by fullH px and ±halfW px sideways.
      let best = null;
      let bestDist = Infinity;
      for (const f of flags) {
        let screen;
        try { screen = mapRef.project([f.lng, f.lat]); } catch (_) { continue; }
        const dx = point.x - screen.x;
        const dy = point.y - screen.y;
        if (Math.abs(dx) <= halfW && dy <= 0 && dy >= -fullH) {
          const d = Math.hypot(dx, dy);
          if (d < bestDist) { bestDist = d; best = f; }
        }
      }
      return best;
    }

    // Fallback: queryRenderedFeatures against disc/text layers.
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

  function renderFlag(_flag) {
    // Static flags render exclusively via the diamond symbol layer
    // (LTF_DISC_LAYER_ID + LTF_TEXT_LAYER_ID). No DOM-marker fallback —
    // if the layer isn't ready yet, the flag stays in state.flags and
    // appears once ensureFlagLayer's syncFlagLayer call fires.
    if (useLayer) syncFlagLayer();
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
      element: el, anchor: "center", draggable: true,
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
        element: tempEl, anchor: "center", draggable: true,
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
