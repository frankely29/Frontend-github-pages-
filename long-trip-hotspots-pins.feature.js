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
  const FLAG_W_CSS = 32;
  const FLAG_H_CSS = 40;
  // Single-slice atlas (one color; no per-flag color choice like the
  // 45+ system). Atlas stays the same shape as the 45+ system so the
  // UV math + buffer layout can mirror it 1:1.
  const FLAG_ATLAS_SLICES = ["dollar"];
  const FLAG_PALETTE = {
    fill: "#0f9d58",       // green flag body
    border: "#0b7a44",
    pole: "#1f2937",
    text: "#ffffff",
  };

  const HOTSPOT_ENDPOINT = "/long_trip_hotspots";
  const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // re-poll every 5 min in case admin rebuilt

  // Source/layer IDs
  const BLDG_SOURCE_ID = "lth-buildings";
  const BLDG_LAYER_ID = "lth-buildings-circle";
  const FLAG_CUSTOM_LAYER_ID = "lth-flags-custom-gl";

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
    return list.map(sanitize).filter(Boolean);
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
    return {
      id,
      lat, lng,
      label: String(h?.label || ""),
      dominant_category: String(h?.dominant_category || ""),
      member_count: Number(h?.member_count) || members.length,
      total_weight: Number(h?.total_weight) || 0,
      rationale: String(h?.rationale || ""),
      best_hours: String(h?.best_hours || ""),
      members,
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
    uniform vec2 u_viewport_css_px;
    uniform float u_size_scale;
    varying vec2 v_uv;
    void main() {
      vec2 px = a_anchor_px + a_corner_px * u_size_scale;
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
    // "$" label on the pennant — large and white for legibility at any zoom.
    ctx.fillStyle = FLAG_PALETTE.text;
    ctx.font = `bold ${Math.round(pH * 0.7)}px -apple-system, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(FLAG_TEXT, pX + pW * 0.4, pY + pH * 0.5);
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

  function flagZoomScale(z) {
    if (!Number.isFinite(z)) return 0.85;
    if (z <= 9) return 0.60;
    if (z >= 16) return 1.10;
    if (z <= 13) return 0.60 + (0.85 - 0.60) * ((z - 9) / 4);
    return 0.85 + (1.10 - 0.85) * ((z - 13) / 3);
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

        const FLOATS_PER_VERTEX = 6;
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
          const v0 = i * 4 * FLOATS_PER_VERTEX;
          // Bottom-left
          vertices[v0 +  0] = pt.x; vertices[v0 +  1] = pt.y;
          vertices[v0 +  2] = -halfW; vertices[v0 +  3] = 0;
          vertices[v0 +  4] = uLeft;  vertices[v0 +  5] = 1;
          // Bottom-right
          vertices[v0 +  6] = pt.x; vertices[v0 +  7] = pt.y;
          vertices[v0 +  8] =  halfW; vertices[v0 +  9] = 0;
          vertices[v0 + 10] = uRight; vertices[v0 + 11] = 1;
          // Top-left
          vertices[v0 + 12] = pt.x; vertices[v0 + 13] = pt.y;
          vertices[v0 + 14] = -halfW; vertices[v0 + 15] = -fullH;
          vertices[v0 + 16] = uLeft;  vertices[v0 + 17] = 0;
          // Top-right
          vertices[v0 + 18] = pt.x; vertices[v0 + 19] = pt.y;
          vertices[v0 + 20] =  halfW; vertices[v0 + 21] = -fullH;
          vertices[v0 + 22] = uRight; vertices[v0 + 23] = 0;

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
        const stride = 6 * 4;
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

  // Z-order keeper — same idea as the 45+ flag layer. When zone style
  // reloads insert new layers, MapLibre would otherwise render them on
  // top of our flag/buildings. rAF-batched moveLayer keeps us at the
  // very top.
  function installZOrderKeeper() {
    if (zOrderListenerInstalled || !mapRef) return;
    zOrderListenerInstalled = true;
    const ids = [BLDG_LAYER_ID, FLAG_CUSTOM_LAYER_ID];
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
  // Building circle layer — MapLibre's built-in circle type. Tiny
  // dots, so any sub-pixel drift would be invisible anyway, and
  // queryRenderedFeatures works out of the box for click handling.
  // ---------------------------------------------------------------
  function buildingsGeoJSON() {
    const features = [];
    for (const h of hotspots) {
      for (const m of h.members) {
        features.push({
          type: "Feature",
          properties: {
            hotspot_id: h.id,
            name: m.name,
            category: m.category,
            address: m.address,
            best_hours: m.best_hours,
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
    if (!mapRef.getLayer?.(BLDG_LAYER_ID)) {
      try {
        mapRef.addLayer({
          id: BLDG_LAYER_ID,
          type: "circle",
          source: BLDG_SOURCE_ID,
          paint: {
            "circle-radius": [
              "interpolate", ["linear"], ["zoom"],
              10, 2.5,
              13, 4,
              16, 6.5,
            ],
            "circle-color": "#0f9d58",
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 1.4,
            "circle-opacity": 0.95,
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
        console.info(`[lth] WebGL dollar-flag layer ready; ${hotspots.length} hotspot(s)`);
      }
    } catch (e) {
      console.warn("[lth] ensureFlagLayer failed:", e);
      layerInitStarted = false;
    }
  }

  function syncFlagLayer() {
    if (!flagCustomLayer) return;
    const flagList = hotspots.map((h) => ({
      id: h.id, lat: h.lat, lng: h.lng,
    }));
    flagCustomLayer.setFlags(flagList);
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
    return `
      <div class="lth-popup-header">
        <span class="lth-popup-dollar">$</span>
        <div>
          <div class="lth-popup-title">Long-trip hotspot</div>
          <div class="lth-popup-sub">
            ${escapeHtml(h.member_count)} buildings nearby
            ${intensity}
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

  function attachClickHandler(map) {
    // Match the long-trips-block convention: handle clicks/taps on the
    // map canvas. Long-press on the map is reserved for the 45+ flag
    // feature; we only react to short taps. e.preventDefault here would
    // break pan, so we rely on the long-press handler in the other
    // file having already absorbed the click if it consumed it.
    map.on("click", (e) => {
      const pt = e.point;
      // 1. Building dot has priority — it's smaller and more specific.
      const feat = buildingAtScreenPoint(pt);
      if (feat) {
        showPopup(buildingPopupHtml(feat.properties || {}), pt);
        return;
      }
      // 2. Hotspot flag (CPU hit-test against the WebGL quads).
      const h = hotspotAtScreenPoint(pt);
      if (h) {
        showPopup(flagPopupHtml(h), pt);
        return;
      }
      // 3. Tap on empty map closes any open popup.
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
        background: #0f9d58; color: #fff;
        border-radius: 50%;
        font: 700 16px -apple-system, system-ui, sans-serif;
        flex-shrink: 0;
      }
      .lth-popup-bldg-icon {
        display: inline-flex; align-items: center; justify-content: center;
        width: 22px; height: 22px;
        background: #0f9d58; color: #fff;
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
      hotspots = await fetchHotspots();
      console.info(`[lth] loaded ${hotspots.length} hotspot(s) from /long_trip_hotspots`);
      ensureFlagLayer();
      syncFlagLayer();
      syncBuildingsLayer();
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
