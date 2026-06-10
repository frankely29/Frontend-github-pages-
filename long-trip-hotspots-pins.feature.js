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
//   - Tap a $ flag      → popup listing the buildings it represents (address)
//   - Tap a building dot → popup with that building's name, address, best hours
//
// Backend: GET /long_trip_hotspots (built via POST /admin/long_trip_hotspots/rebuild)
(function () {
  "use strict";

  // ---------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------
  const FLAG_TEXT = "$";
  // Doubled width per driver request — wider banner reads from further
  // away. Height held at the previous value so the pole still feels
  // like a flagpole, not a billboard.
  const FLAG_W_CSS = 64;
  const FLAG_H_CSS = 40;
  // Single-slice atlas (one color; no per-flag color choice like the
  // 45+ system). Atlas stays the same shape as the 45+ system so the
  // UV math + buffer layout can mirror it 1:1.
  const FLAG_ATLAS_SLICES = ["dollar"];
  // Gold flag with a dark "$" — high contrast, unambiguous "money"
  // signal, and stands out against both the cool zone colors (sky,
  // blue) and warm ones (red, orange).
  const FLAG_PALETTE = {
    fill: "#fbbf24",       // gold flag body (amber-400)
    border: "#a16207",     // dark amber border
    pole: "#1f2937",
    text: "#1f2937",       // near-black "$" reads cleanly on gold
  };

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
  const BLDG_IMAGE_ID = "lth-building-sprite"; // sprite registered via map.addImage
  const FLAG_CUSTOM_LAYER_ID = "lth-flags-custom-gl";

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
  const PULSE_RING2_LAYER_ID = "lth-pulse-ring2";
  const PULSE_PERIOD_MS = 1600;    // one ring-expansion cycle
  const PULSE_R_MIN = 6;           // ring radius (px) at cycle start
  const PULSE_R_MAX = 26;          // ring radius (px) at cycle end (fades out)
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
  let flagCustomLayer = null;
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

  // ---------------------------------------------------------------
  // WebGL flag layer — adapted from long-trips-block's flag system.
  // Same CPU-projection trick that eliminates the iOS Safari drift:
  // project each flag to CSS pixels via map.project() each frame
  // (float64), then upload only screen-px anchors to the GPU.
  // ---------------------------------------------------------------

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`[lth-gl] shader compile failed: ${log}`);
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
      throw new Error(`[lth-gl] program link failed: ${log}`);
    }
    return program;
  }

  const FLAG_VS = `
    precision highp float;
    attribute vec2 a_anchor_px;
    attribute vec2 a_corner_px;
    attribute vec2 a_uv;
    attribute float a_dim;
    uniform vec2 u_viewport_css_px;
    uniform float u_size_scale;
    varying vec2 v_uv;
    varying float v_dim;
    void main() {
      vec2 px = a_anchor_px + a_corner_px * u_size_scale;
      vec2 clip = vec2(
            (px.x / u_viewport_css_px.x) * 2.0 - 1.0,
        1.0 - (px.y / u_viewport_css_px.y) * 2.0
      );
      gl_Position = vec4(clip, 0.0, 1.0);
      v_uv = a_uv;
      v_dim = a_dim;
    }
  `;

  const FLAG_FS = `
    precision mediump float;
    uniform sampler2D u_texture;
    varying vec2 v_uv;
    varying float v_dim;
    void main() {
      vec4 c = texture2D(u_texture, v_uv);
      if (c.a < 0.02) discard;
      // Texture is premultiplied — scaling all 4 channels by v_dim
      // gives the same visual effect as multiplying alpha against
      // unpremultiplied. v_dim is in [0,1].
      gl_FragColor = c * v_dim;
    }
  `;

  function drawDollarFlagInto(ctx, xOff, yOff, W, H) {
    // Pole: vertical bar near image-center, full height.
    ctx.fillStyle = FLAG_PALETTE.pole;
    ctx.fillRect(xOff + W / 2 - 2, yOff, 4, H);
    // Pennant: rectangular flag attached at the top of the pole.
    const pX = xOff + W / 2;
    const pY = yOff;
    const pW = Math.round(W * 0.82);
    const pH = Math.round(H * 0.55);
    ctx.fillStyle = FLAG_PALETTE.fill;
    ctx.strokeStyle = FLAG_PALETTE.border;
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
    // "$" label on the pennant — large and dark for legibility at any zoom.
    // Font sized to nearly the pennant height so the symbol dominates
    // the flag; vertical center via textBaseline=middle.
    ctx.fillStyle = FLAG_PALETTE.text;
    ctx.font = `900 ${Math.round(pH * 0.95)}px -apple-system, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(FLAG_TEXT, pX + pW * 0.45, pY + pH * 0.5);
  }

  function buildFlagAtlas() {
    const scale = 2; // 2x for retina
    const flagW = FLAG_W_CSS * scale;
    const flagH = FLAG_H_CSS * scale;
    const PAD = 2; // gutter, same as the 45+ atlas — guards against LINEAR bleed
    const padW = flagW + PAD;
    const W = padW * FLAG_ATLAS_SLICES.length;
    const H = flagH;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    for (let i = 0; i < FLAG_ATLAS_SLICES.length; i++) {
      const xOff = i * padW;
      ctx.save();
      ctx.beginPath();
      ctx.rect(xOff, 0, flagW, flagH);
      ctx.clip();
      drawDollarFlagInto(ctx, xOff, 0, flagW, flagH);
      ctx.restore();
    }
    return { canvas, flagW, flagH, padW, W, H, slices: FLAG_ATLAS_SLICES };
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

  function createFlagCustomLayer() {
    return {
      id: FLAG_CUSTOM_LAYER_ID,
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
          console.warn("[lth-gl] atlas build failed");
          return;
        }

        try {
          this._program = linkProgram(gl, FLAG_VS, FLAG_FS);
        } catch (e) {
          console.warn("[lth-gl] shader setup failed:", e);
          this._program = null;
          return;
        }

        this._attrib = {
          anchor: gl.getAttribLocation(this._program, "a_anchor_px"),
          corner: gl.getAttribLocation(this._program, "a_corner_px"),
          uv: gl.getAttribLocation(this._program, "a_uv"),
          dim: gl.getAttribLocation(this._program, "a_dim"),
        };
        this._uni = {
          viewport: gl.getUniformLocation(this._program, "u_viewport_css_px"),
          sizeScale: gl.getUniformLocation(this._program, "u_size_scale"),
          texture: gl.getUniformLocation(this._program, "u_texture"),
        };

        this._vbo = gl.createBuffer();
        this._ibo = gl.createBuffer();
        this._texture = gl.createTexture();

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
        this._map?.triggerRepaint();
      },

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
        const padW = this._atlas.padW || flagW;

        // 7 floats per vertex: 2 anchor_px + 2 corner_px + 2 uv + 1 dim
        const FLOATS_PER_VERTEX = 7;
        const vertices = new Float32Array(flags.length * 4 * FLOATS_PER_VERTEX);
        const indices = new Uint16Array(flags.length * 6);

        for (let i = 0; i < flags.length; i++) {
          const f = flags[i];
          let pt;
          try {
            pt = this._map.project([f.lng, f.lat]);
          } catch (_) {
            pt = { x: -10000, y: -10000 };
          }
          // Single-slice atlas: always sample slot 0.
          const uLeft = 0;
          const uRight = flagW / atlasW;
          const dim = Number.isFinite(f.dim) ? f.dim : 1.0;
          const v0 = i * 4 * FLOATS_PER_VERTEX;
          // Bottom-left
          vertices[v0 +  0] = pt.x; vertices[v0 +  1] = pt.y;
          vertices[v0 +  2] = -halfW; vertices[v0 +  3] = 0;
          vertices[v0 +  4] = uLeft;  vertices[v0 +  5] = 1;
          vertices[v0 +  6] = dim;
          // Bottom-right
          vertices[v0 +  7] = pt.x; vertices[v0 +  8] = pt.y;
          vertices[v0 +  9] =  halfW; vertices[v0 + 10] = 0;
          vertices[v0 + 11] = uRight; vertices[v0 + 12] = 1;
          vertices[v0 + 13] = dim;
          // Top-left
          vertices[v0 + 14] = pt.x; vertices[v0 + 15] = pt.y;
          vertices[v0 + 16] = -halfW; vertices[v0 + 17] = -fullH;
          vertices[v0 + 18] = uLeft;  vertices[v0 + 19] = 0;
          vertices[v0 + 20] = dim;
          // Top-right
          vertices[v0 + 21] = pt.x; vertices[v0 + 22] = pt.y;
          vertices[v0 + 23] =  halfW; vertices[v0 + 24] = -fullH;
          vertices[v0 + 25] = uRight; vertices[v0 + 26] = 0;
          vertices[v0 + 27] = dim;

          const base = i * 4;
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

        if (!this._rebuildProjectedBuffer()) return;

        const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
        const zoom = this._map?.getZoom?.();
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
        gl.disable(gl.DEPTH_TEST);

        gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
        const stride = 7 * 4; // 7 floats × 4 bytes (anchor.xy + corner.xy + uv.xy + dim)
        gl.enableVertexAttribArray(this._attrib.anchor);
        gl.vertexAttribPointer(this._attrib.anchor, 2, gl.FLOAT, false, stride, 0);
        gl.enableVertexAttribArray(this._attrib.corner);
        gl.vertexAttribPointer(this._attrib.corner, 2, gl.FLOAT, false, stride, 2 * 4);
        gl.enableVertexAttribArray(this._attrib.uv);
        gl.vertexAttribPointer(this._attrib.uv, 2, gl.FLOAT, false, stride, 4 * 4);
        if (this._attrib.dim >= 0) {
          gl.enableVertexAttribArray(this._attrib.dim);
          gl.vertexAttribPointer(this._attrib.dim, 1, gl.FLOAT, false, stride, 6 * 4);
        }

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._ibo);
        gl.drawElements(gl.TRIANGLES, this._quadCount * 6, gl.UNSIGNED_SHORT, 0);

        gl.disableVertexAttribArray(this._attrib.anchor);
        gl.disableVertexAttribArray(this._attrib.corner);
        gl.disableVertexAttribArray(this._attrib.uv);
        if (this._attrib.dim >= 0) gl.disableVertexAttribArray(this._attrib.dim);
        if (!blendWasEnabled) gl.disable(gl.BLEND);
      },
    };
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
      PULSE_GLOW_LAYER_ID, PULSE_RING1_LAYER_ID, PULSE_RING2_LAYER_ID,
      BLDG_LAYER_ID, FLAG_CUSTOM_LAYER_ID,
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

  function ensureBuildingSpriteRegistered() {
    if (!mapRef || mapRef.hasImage?.(BLDG_IMAGE_ID)) return;
    const sprite = buildBuildingSprite();
    if (!sprite) return;
    try {
      mapRef.addImage(BLDG_IMAGE_ID, sprite, { pixelRatio: 2 });
    } catch (e) {
      console.warn("[lth] building sprite registration failed:", e);
    }
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
            "icon-image": BLDG_IMAGE_ID,
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
    // Two stroke-only rings; radius + stroke-opacity driven by the loop.
    for (const id of [PULSE_RING1_LAYER_ID, PULSE_RING2_LAYER_ID]) {
      if (mapRef.getLayer?.(id)) continue;
      try {
        mapRef.addLayer({
          id,
          type: "circle",
          source: PULSE_SOURCE_ID,
          paint: {
            "circle-radius": PULSE_R_MIN,
            "circle-color": "rgba(0,0,0,0)",   // ring only — no fill
            "circle-opacity": 0,
            "circle-stroke-color": PULSE_COLOR,
            "circle-stroke-width": 2.5,
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
    const op = 0.55 * (1 - t); // fade as the ring grows
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
      setRing(PULSE_RING2_LAYER_ID, (t + 0.5) % 1, zScale);
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

      if (mapRef.getLayer?.(FLAG_CUSTOM_LAYER_ID)) {
        try { mapRef.removeLayer(FLAG_CUSTOM_LAYER_ID); } catch (_) {}
      }
      flagCustomLayer = createFlagCustomLayer();
      mapRef.addLayer(flagCustomLayer);
      if (mapRef.getLayer?.(FLAG_CUSTOM_LAYER_ID)) {
        useLayer = true;
        installZOrderKeeper();
        syncBuildingsLayer();
        syncFlagLayer();
        syncPulseLayer();
        console.info(`[lth] WebGL dollar-flag layer ready; ${hotspots.length} hotspot(s)`);
      }
    } catch (e) {
      console.warn("[lth] ensureFlagLayer failed:", e);
      layerInitStarted = false;
    }
  }

  function syncFlagLayer() {
    if (!flagCustomLayer) return;
    const now = nycHourAndDay();
    // Only flags whose hotspot is in its prime window are drawn — the gold
    // dollar-flag appears (pulsing) at the best pickup hours and is hidden
    // from the map at all other times.
    const flagList = hotspots
      .filter((h) => primeForHotspot(h, now))
      .map((h) => ({
        id: h.id, lat: h.lat, lng: h.lng,
        dim: dimForHotspot(h, now),
      }));
    flagCustomLayer.setFlags(flagList);
  }

  // Re-evaluate dim every minute. Cheap (rebuilds 17 vertex slots in
  // the flag VBO and reshuffles the buildings GeoJSON), idempotent
  // when the hour hasn't changed.
  function tickDim() {
    if (!useLayer) return;
    syncFlagLayer();
    syncBuildingsLayer();
    syncPulseLayer();
  }

  // ---------------------------------------------------------------
  // Click handling — CPU hit-test for the flag, queryRenderedFeatures
  // for the building dots (those are a built-in circle layer).
  // ---------------------------------------------------------------
  function hotspotAtScreenPoint(point) {
    if (!useLayer || !mapRef || !flagCustomLayer?._program) return null;
    if (typeof mapRef.project !== "function") return null;
    const scale = flagZoomScale(mapRef.getZoom?.());
    const halfW = (FLAG_W_CSS / 2) * scale;
    const fullH = FLAG_H_CSS * scale;
    let best = null;
    let bestDist = Infinity;
    for (const h of hotspots) {
      let screen;
      try { screen = mapRef.project([h.lng, h.lat]); } catch (_) { continue; }
      const dx = point.x - screen.x;
      const dy = point.y - screen.y;
      // Anchor is at pole tip (bottom of flag). Flag extends UP from
      // anchor by fullH px and ±halfW px sideways.
      if (Math.abs(dx) <= halfW && dy <= 0 && dy >= -fullH) {
        const d = Math.hypot(dx, dy);
        if (d < bestDist) { bestDist = d; best = h; }
      }
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
        <span class="lth-popup-dollar">$</span>
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
      syncFlagLayer();
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
