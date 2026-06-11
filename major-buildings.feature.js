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
  const LABEL_MIN_ZOOM = 13;  // show the HOSPITAL/HOTEL type tag from a neighborhood zoom
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
            "text-field": ["upcase", ["get", "type"]],
            "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
            "text-size": ["interpolate", ["linear"], ["zoom"], 13, 9.5, 16, 12, 18, 14],
            "text-anchor": "bottom", "text-offset": [0, -2.4],
            "text-letter-spacing": 0.08, "text-padding": 6,
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
