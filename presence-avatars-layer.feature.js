/**
 * Presence avatar layer — zero-drift WebGL textured-quad rendering.
 *
 * Same approach as long-trip flags (PR #978): a MapLibre custom layer
 * renders each driver's avatar as a textured quad inside the basemap's
 * own render pipeline. Position is projected via map.project() each
 * frame in JS float64, which avoids both the GPU float32 precision
 * loss and the DOM-CSS-vs-WebGL frame race that DOM markers suffer
 * from on iOS Safari.
 *
 * Stage 1 scope: avatar IMAGE only. The existing DOM marker keeps
 * the name label, badge, and click handler — only the visible avatar
 * <img> is hidden once the WebGL texture is loaded. Name / badge text
 * can move to symbol layers in a follow-up.
 *
 * Public API: window.TlcPresenceAvatarLayerModule
 *   ensureInstalled(map)            — adds the layer once style is ready
 *   setDrivers(driverArray)         — updates the layer with current drivers
 *   isAvatarReady(userId)           — has the texture loaded for this driver?
 *   driverAtScreenPoint({x,y})      — CPU hit-test for click handlers
 *   reset()                         — clears state (sign-out / map reset)
 *
 * Each driver record should have: { userId, lng, lat, avatarUrl }.
 */

(function () {
  if (typeof window === "undefined" || !window.maplibregl) return;

  const LAYER_ID = "presence-avatars-custom-gl";
  const AVATAR_SIZE_CSS = 36; // visual diameter in CSS pixels

  let layerImpl = null;
  let mapRef = null;
  let installedOn = null;
  let installInProgress = false;

  // --- Shaders ----------------------------------------------------------
  //
  // CPU-projected anchor (float64 in JS via map.project), simple CSS-px
  // to clip-space transform in the shader. Matches the long-trip flag
  // layer's projection path so the drift fix is identical.

  const VS = `
    precision highp float;
    attribute vec2 a_anchor_px;
    attribute vec2 a_corner_px;
    attribute vec2 a_uv;
    uniform vec2 u_viewport_css_px;
    varying vec2 v_uv;
    void main() {
      vec2 px = a_anchor_px + a_corner_px;
      vec2 clip = vec2(
            (px.x / u_viewport_css_px.x) * 2.0 - 1.0,
        1.0 - (px.y / u_viewport_css_px.y) * 2.0
      );
      gl_Position = vec4(clip, 0.0, 1.0);
      v_uv = a_uv;
    }
  `;

  // Circular mask + 2 px white ring to match the existing CSS visual.
  const FS = `
    precision mediump float;
    uniform sampler2D u_texture;
    varying vec2 v_uv;
    void main() {
      vec2 c = v_uv - vec2(0.5);
      float d = length(c);
      if (d > 0.5) discard;
      // Outer ring band (white, slightly translucent)
      if (d > 0.46) {
        gl_FragColor = vec4(1.0, 1.0, 1.0, 0.95);
        return;
      }
      gl_FragColor = texture2D(u_texture, v_uv);
    }
  `;

  function compileShader(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error("[presence-avatars] shader compile: " + log);
    }
    return sh;
  }

  function linkProgram(gl, vsSrc, fsSrc) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error("[presence-avatars] program link: " + log);
    }
    return p;
  }

  function createLayer() {
    return {
      id: LAYER_ID,
      type: "custom",
      renderingMode: "2d",

      _map: null,
      _gl: null,
      _program: null,
      _vbo: null,
      _attrib: null,
      _uni: null,

      // [{ userId, lng, lat, avatarUrl }, ...] — the current driver list.
      _drivers: [],
      // userId (string) -> { tex, loaded, url, failed }
      _textures: new Map(),

      onAdd(map, gl) {
        this._map = map;
        this._gl = gl;
        try {
          this._program = linkProgram(gl, VS, FS);
        } catch (e) {
          console.warn(String(e));
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
          texture: gl.getUniformLocation(this._program, "u_texture"),
        };
        this._vbo = gl.createBuffer();
      },

      onRemove(_map, gl) {
        if (this._program) gl.deleteProgram(this._program);
        if (this._vbo) gl.deleteBuffer(this._vbo);
        for (const ent of this._textures.values()) {
          if (ent.tex) gl.deleteTexture(ent.tex);
        }
        this._textures.clear();
        this._program = null;
        this._vbo = null;
      },

      setDrivers(drivers) {
        const list = Array.isArray(drivers) ? drivers : [];
        this._drivers = list;
        const present = new Set(list.map((d) => String(d.userId)));

        // Free textures for drivers that left.
        for (const uid of Array.from(this._textures.keys())) {
          if (!present.has(uid)) {
            const ent = this._textures.get(uid);
            if (ent?.tex && this._gl) this._gl.deleteTexture(ent.tex);
            this._textures.delete(uid);
          }
        }

        // Load avatars for new drivers, or refresh on URL change.
        for (const d of list) {
          const uid = String(d.userId);
          const cur = this._textures.get(uid);
          if (cur && cur.url === d.avatarUrl) continue;
          if (cur?.tex && this._gl) this._gl.deleteTexture(cur.tex);
          this._textures.set(uid, {
            tex: null,
            loaded: false,
            url: d.avatarUrl,
          });
          this._loadAvatar(uid, d.avatarUrl);
        }

        this._map?.triggerRepaint();
      },

      _loadAvatar(userId, url) {
        if (!url || !this._gl) return;
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.decoding = "async";
        const onSettled = (ok) => {
          const ent = this._textures.get(userId);
          // Stale callback (driver changed avatar or left while loading).
          if (!ent || ent.url !== url) return;
          if (!ok || !this._gl) {
            ent.failed = true;
            return;
          }
          try {
            const gl = this._gl;
            const tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.texImage2D(
              gl.TEXTURE_2D, 0,
              gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE,
              img
            );
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.bindTexture(gl.TEXTURE_2D, null);
            ent.tex = tex;
            ent.loaded = true;
            this._map?.triggerRepaint();
            // Notify the integration layer so the DOM marker's avatar
            // <img> can be hidden in favor of the WebGL render.
            try {
              if (typeof window.onPresenceAvatarLayerReady === "function") {
                window.onPresenceAvatarLayerReady(userId);
              }
            } catch (_) {}
          } catch (e) {
            ent.failed = true;
          }
        };
        img.onload = () => onSettled(true);
        img.onerror = () => onSettled(false);
        img.src = url;
      },

      render(gl, _matrix) {
        if (!this._program || !this._drivers.length) return;
        if (typeof this._map?.project !== "function") return;

        const dpr =
          (typeof window !== "undefined" && window.devicePixelRatio) || 1;
        gl.useProgram(this._program);
        gl.uniform2f(
          this._uni.viewport,
          gl.drawingBufferWidth / dpr,
          gl.drawingBufferHeight / dpr
        );

        const blendWasEnabled = gl.getParameter(gl.BLEND);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.disable(gl.DEPTH_TEST);

        const half = AVATAR_SIZE_CSS / 2;
        // 4 verts × 6 floats (anchor xy, corner xy, uv xy)
        const verts = new Float32Array(24);

        for (const d of this._drivers) {
          const uid = String(d.userId);
          const ent = this._textures.get(uid);
          if (!ent?.loaded || !ent.tex) continue;

          let pt;
          try { pt = this._map.project([d.lng, d.lat]); } catch (_) { continue; }

          // TRIANGLE_STRIP order: BL, BR, TL, TR
          verts[ 0] = pt.x; verts[ 1] = pt.y; verts[ 2] = -half; verts[ 3] =  half; verts[ 4] = 0; verts[ 5] = 1;
          verts[ 6] = pt.x; verts[ 7] = pt.y; verts[ 8] =  half; verts[ 9] =  half; verts[10] = 1; verts[11] = 1;
          verts[12] = pt.x; verts[13] = pt.y; verts[14] = -half; verts[15] = -half; verts[16] = 0; verts[17] = 0;
          verts[18] = pt.x; verts[19] = pt.y; verts[20] =  half; verts[21] = -half; verts[22] = 1; verts[23] = 0;

          gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
          gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);

          const stride = 6 * 4;
          gl.enableVertexAttribArray(this._attrib.anchor);
          gl.vertexAttribPointer(this._attrib.anchor, 2, gl.FLOAT, false, stride, 0);
          gl.enableVertexAttribArray(this._attrib.corner);
          gl.vertexAttribPointer(this._attrib.corner, 2, gl.FLOAT, false, stride, 2 * 4);
          gl.enableVertexAttribArray(this._attrib.uv);
          gl.vertexAttribPointer(this._attrib.uv, 2, gl.FLOAT, false, stride, 4 * 4);

          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, ent.tex);
          gl.uniform1i(this._uni.texture, 0);

          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }

        gl.disableVertexAttribArray(this._attrib.anchor);
        gl.disableVertexAttribArray(this._attrib.corner);
        gl.disableVertexAttribArray(this._attrib.uv);
        if (!blendWasEnabled) gl.disable(gl.BLEND);
      },
    };
  }

  function ensureInstalled(map) {
    if (!map) return false;
    if (installedOn === map && map.getLayer?.(LAYER_ID)) return true;
    if (installInProgress) return false;

    // Poll for the style to be ready. Same pattern as PR #982 for the
    // flag layer — map.once("load") can fail to fire and isStyleLoaded
    // can flip false transiently during zone tile reloads.
    if (!map.isStyleLoaded?.()) {
      installInProgress = true;
      let attempts = 0;
      const t = setInterval(() => {
        attempts += 1;
        if (map.getLayer?.(LAYER_ID)) {
          clearInterval(t);
          installInProgress = false;
          return;
        }
        if (attempts >= 100) {
          clearInterval(t);
          installInProgress = false;
          console.warn("[presence-avatars] install poll timed out");
          return;
        }
        if (!map.isStyleLoaded?.()) return;
        clearInterval(t);
        installInProgress = false;
        ensureInstalled(map);
      }, 300);
      return false;
    }

    try {
      if (map.getLayer?.(LAYER_ID)) {
        try { map.removeLayer(LAYER_ID); } catch (_) {}
      }
      layerImpl = createLayer();
      map.addLayer(layerImpl);
      if (map.getLayer?.(LAYER_ID)) {
        installedOn = map;
        mapRef = map;
        // Same z-order self-heal pattern as the flag layer (PR #983).
        installZOrderKeeper(map);
        console.info("[presence-avatars] layer installed");
        return true;
      }
    } catch (e) {
      console.warn("[presence-avatars] install failed:", e);
    }
    return false;
  }

  let zOrderListenerInstalled = false;
  let zOrderMovePending = false;
  let zOrderInMove = false;

  function installZOrderKeeper(map) {
    if (zOrderListenerInstalled || !map) return;
    zOrderListenerInstalled = true;
    const schedule = () => {
      if (zOrderInMove || zOrderMovePending) return;
      zOrderMovePending = true;
      const raf =
        (typeof window !== "undefined" && window.requestAnimationFrame) ||
        ((fn) => setTimeout(fn, 16));
      raf(() => {
        zOrderMovePending = false;
        if (!map.getLayer?.(LAYER_ID)) return;
        zOrderInMove = true;
        try { map.moveLayer(LAYER_ID); } catch (_) {}
        zOrderInMove = false;
      });
    };
    try { map.on?.("styledata", schedule); } catch (_) {}
  }

  function setDrivers(drivers) {
    if (layerImpl?.setDrivers) layerImpl.setDrivers(drivers);
  }

  function isAvatarReady(userId) {
    const ent = layerImpl?._textures?.get(String(userId));
    return !!ent?.loaded;
  }

  function driverAtScreenPoint(point) {
    if (!layerImpl?._drivers?.length || !mapRef) return null;
    const half = AVATAR_SIZE_CSS / 2;
    let best = null;
    let bestDist = Infinity;
    for (const d of layerImpl._drivers) {
      const uid = String(d.userId);
      const ent = layerImpl._textures.get(uid);
      if (!ent?.loaded) continue;
      let pt;
      try { pt = mapRef.project([d.lng, d.lat]); } catch (_) { continue; }
      const dx = point.x - pt.x;
      const dy = point.y - pt.y;
      const r2 = dx * dx + dy * dy;
      if (r2 > half * half) continue;
      const dist = Math.sqrt(r2);
      if (dist < bestDist) { bestDist = dist; best = d; }
    }
    return best;
  }

  function reset() {
    if (layerImpl?.setDrivers) layerImpl.setDrivers([]);
  }

  window.TlcPresenceAvatarLayerModule = {
    ensureInstalled,
    setDrivers,
    isAvatarReady,
    driverAtScreenPoint,
    reset,
  };
})();
