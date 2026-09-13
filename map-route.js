/**
 * map-route.js — the dotted line from the driver to the zone they should go to.
 *
 * The other half of the action pill. The pill says LEAVE · 4.2mi · Astoria; this
 * draws the line, so "which way is that" is answered by looking rather than by
 * reading a bearing off a small arrow.
 *
 * FLUIDITY IS THE WHOLE CONSTRAINT
 *
 * A line that follows a moving driver is the easiest thing in this app to make
 * the map feel slow, so every choice here is about doing almost nothing per
 * frame:
 *
 *   - Layers are added ONCE. Nothing is added or removed as the driver moves;
 *     the line is hidden by emptying its source, never by touching the style.
 *   - One source update per animation frame at most, coalesced. GPS can fire
 *     several times a second and the browser only paints sixty.
 *   - An update is skipped entirely unless the driver has actually moved a
 *     meaningful distance. Standing at a light produces jitter of a few metres,
 *     and redrawing for that is work with nothing to show for it.
 *   - The line is two coordinates. Not a routed path -- routing is what the
 *     Navigate button does, it costs a network round trip per recalculation,
 *     and a driver glancing down wants the direction, not the turns.
 *
 * WHERE IT ENDS IS NOT THIS FILE'S DECISION
 *
 * app.part17.js publishes the target with the words, in the same tick. This
 * reads targetLat/targetLng off that and nothing else, so the line cannot point
 * somewhere the pill is not naming.
 */
(function () {
  "use strict";

  var SRC_LINE = "tlc-action-route";
  var SRC_END = "tlc-action-route-end";
  var SRC_ZONE = "tlc-action-route-zone";
  var LAYER_LINE = "tlc-action-route-line";
  var LAYER_END = "tlc-action-route-arrow";
  var LAYER_ZONE = "tlc-action-route-zone-outline";
  var ARROW_IMAGE = "tlc-action-route-arrow-img";

  // Below this the line is redrawn for GPS jitter rather than for movement.
  // About 8 metres in degrees of latitude; longitude is close enough at NYC
  // latitudes that a separate factor is not worth the arithmetic per fix.
  var MIN_MOVE_DEG = 0.00007;

  var EMPTY = { type: "FeatureCollection", features: [] };

  var state = {
    map: null,
    ready: false,
    target: null,     // { lat, lng, bearingDeg, tone }
    origin: null,     // { lat, lng } last drawn
    pending: null,    // { lat, lng } waiting for a frame
    frame: 0,
    outlined: false,  // whether the destination zone polygon was resolved
    drawn: 0,         // how many times the source was actually written
    skipped: 0,       // how many updates were dropped as noise
  };

  function num(value) {
    if (value === null || value === undefined || value === "") return null;
    var n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function resolveMap() {
    if (typeof window === "undefined") return null;
    if (window.map) return window.map;
    if (window.tlcMap) return window.tlcMap;
    var internals = window.TlcMapUiInternals;
    if (internals && typeof internals.getMap === "function") {
      try { return internals.getMap(); } catch (_) {}
    }
    return null;
  }

  function driverAt() {
    var internals = window.TlcMapUiInternals;
    if (!internals || typeof internals.getUserLatLng !== "function") return null;
    var at = null;
    try { at = internals.getUserLatLng(); } catch (_) { return null; }
    var lat = num(at && at.lat);
    var lng = num(at && at.lng);
    return (lat === null || lng === null) ? null : { lat: lat, lng: lng };
  }

  /* ------------------------------------------------------------ the arrow */

  /**
   * A triangle, drawn once into a canvas and handed to the map as an image.
   *
   * A rotated symbol rather than a DOM marker: a marker has to be repositioned
   * by hand on every pan, zoom and rotate, which is exactly the per-frame cost
   * this file exists to avoid. The map moves symbols itself, on the GPU.
   */
  function addArrowImage(map) {
    if (map.hasImage && map.hasImage(ARROW_IMAGE)) return true;
    var size = 44;
    var canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext("2d");
    if (!ctx) return false;
    ctx.beginPath();
    ctx.moveTo(size / 2, size * 0.16);
    ctx.lineTo(size * 0.82, size * 0.84);
    ctx.lineTo(size / 2, size * 0.68);
    ctx.lineTo(size * 0.18, size * 0.84);
    ctx.closePath();
    ctx.fillStyle = "#0b1220";
    ctx.fill();
    // A pale rim, so the arrow reads on a dark zone as well as a light one.
    ctx.lineWidth = size * 0.055;
    ctx.strokeStyle = "rgba(255,255,255,0.92)";
    ctx.stroke();
    try {
      map.addImage(ARROW_IMAGE, ctx.getImageData(0, 0, size, size), { pixelRatio: 2 });
      return true;
    } catch (_) {
      return false;
    }
  }

  /* ------------------------------------------------------------- the layers */

  function install(map) {
    if (state.ready) return true;
    if (!map || typeof map.getSource !== "function") return false;
    if (typeof map.isStyleLoaded === "function" && !map.isStyleLoaded()) return false;

    try {
      if (!map.getSource(SRC_LINE)) map.addSource(SRC_LINE, { type: "geojson", data: EMPTY });
      if (!map.getSource(SRC_END)) map.addSource(SRC_END, { type: "geojson", data: EMPTY });
      if (!map.getSource(SRC_ZONE)) map.addSource(SRC_ZONE, { type: "geojson", data: EMPTY });
      addArrowImage(map);

      if (!map.getLayer(LAYER_LINE)) {
        map.addLayer({
          id: LAYER_LINE,
          type: "line",
          source: SRC_LINE,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": "#0b1220",
            // Thicker as you zoom in, so it stays a line rather than a hair at
            // street level and a smear at city level.
            "line-width": ["interpolate", ["linear"], ["zoom"], 9, 2.4, 14, 4.5],
            "line-opacity": 0.85,
            // Dots, as drawn. The gap grows with the width or it closes up.
            "line-dasharray": [0.1, 1.9],
          },
        });
      }
      // Under the line and the arrow, so neither is cut by the border.
      if (!map.getLayer(LAYER_ZONE)) {
        map.addLayer({
          id: LAYER_ZONE,
          type: "line",
          source: SRC_ZONE,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": "#0b1220",
            "line-width": ["interpolate", ["linear"], ["zoom"], 9, 2.2, 14, 4.0],
            "line-opacity": 0.95,
          },
        });
      }
      if (!map.getLayer(LAYER_END)) {
        map.addLayer({
          id: LAYER_END,
          type: "symbol",
          source: SRC_END,
          layout: {
            "icon-image": ARROW_IMAGE,
            "icon-size": ["interpolate", ["linear"], ["zoom"], 9, 0.45, 14, 0.7],
            "icon-rotate": ["coalesce", ["get", "bearing"], 0],
            "icon-rotation-alignment": "map",
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
          },
        });
      }
      state.ready = true;
      return true;
    } catch (_) {
      return false;
    }
  }

  /* --------------------------------------------------------------- drawing */

  function clear() {
    state.target = null;
    state.origin = null;
    state.pending = null;
    if (!state.ready || !state.map) return;
    // Emptied, not removed. Removing and re-adding layers is a style
    // recalculation, which is the expensive thing.
    try {
      state.map.getSource(SRC_LINE).setData(EMPTY);
      state.map.getSource(SRC_END).setData(EMPTY);
      state.map.getSource(SRC_ZONE).setData(EMPTY);
    } catch (_) {}
  }

  function write(from, to) {
    if (!state.ready || !state.map) return;
    try {
      state.map.getSource(SRC_LINE).setData({
        type: "FeatureCollection",
        features: [{
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: [[from.lng, from.lat], [to.lng, to.lat]],
          },
        }],
      });
      state.map.getSource(SRC_END).setData({
        type: "FeatureCollection",
        features: [{
          type: "Feature",
          // The arrow points along the line, so it is recomputed from the two
          // live ends rather than taken from the published bearing -- that one
          // is from the moment the recommendation was made, and the driver has
          // moved since.
          properties: { bearing: bearing(from, to) },
          geometry: { type: "Point", coordinates: [to.lng, to.lat] },
        }],
      });
      state.origin = { lat: from.lat, lng: from.lng };
      state.drawn += 1;
    } catch (_) {}
  }

  /**
   * Outline the zone the driver is being sent to.
   *
   * Resolved through the map's own lookup, from the target coordinates the
   * assistant published -- so the outlined polygon is by construction the zone
   * the pill names, not a second guess at it.
   *
   * Done once per target, never per frame: the polygon only changes when the
   * recommendation does, and it is the one piece of geometry here big enough
   * that redrawing it on movement would cost something.
   */
  function outlineTarget(target) {
    if (!state.ready || !state.map) return;
    var internals = window.TlcMapUiInternals;
    var feature = null;
    if (internals && typeof internals.resolveZoneFeatureAtLngLat === "function") {
      try {
        feature = internals.resolveZoneFeatureAtLngLat({ lat: target.lat, lng: target.lng });
      } catch (_) {}
    }
    try {
      // No polygon is not a failure: the line and arrow still say where to go.
      // An outline drawn around a guess would be worse than none.
      state.map.getSource(SRC_ZONE).setData(
        feature && feature.geometry
          ? { type: "FeatureCollection",
              features: [{ type: "Feature", properties: {}, geometry: feature.geometry }] }
          : EMPTY
      );
      state.outlined = !!(feature && feature.geometry);
    } catch (_) {}
  }

  function bearing(from, to) {
    var toRad = Math.PI / 180;
    var lat1 = from.lat * toRad;
    var lat2 = to.lat * toRad;
    var dLng = (to.lng - from.lng) * toRad;
    var y = Math.sin(dLng) * Math.cos(lat2);
    var x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  /** Has the driver moved enough to be worth a redraw? */
  function movedEnough(next) {
    if (!state.origin) return true;
    return Math.abs(next.lat - state.origin.lat) >= MIN_MOVE_DEG
      || Math.abs(next.lng - state.origin.lng) >= MIN_MOVE_DEG;
  }

  function schedule(next) {
    if (!state.target || !next) return;
    if (!movedEnough(next)) { state.skipped += 1; return; }
    state.pending = next;
    if (state.frame) return;
    // Coalesced to one write per frame. GPS can fire faster than the screen
    // paints, and every extra setData is work nobody sees.
    var raf = (typeof window.requestAnimationFrame === "function")
      ? window.requestAnimationFrame
      : function (fn) { return window.setTimeout(fn, 16); };
    state.frame = raf(function () {
      state.frame = 0;
      var pending = state.pending;
      state.pending = null;
      if (pending && state.target) write(pending, state.target);
    });
  }

  /* ---------------------------------------------------------------- inputs */

  function onRecommendation(rec) {
    var detail = rec && rec.detail;
    var lat = num(detail && detail.targetLat);
    var lng = num(detail && detail.targetLng);

    // Staying, monitoring, or a move the assistant could not put a pin in.
    // Either way there is nothing to draw, and a line left over from the last
    // recommendation is worse than none: it points somewhere nobody said.
    if (!detail || !detail.isMove || lat === null || lng === null) {
      clear();
      return;
    }

    var changed = !state.target || state.target.lat !== lat || state.target.lng !== lng;
    state.target = { lat: lat, lng: lng };
    if (changed) outlineTarget(state.target);
    var at = driverAt();
    if (at) {
      // A new target redraws immediately rather than waiting for the driver to
      // move -- otherwise the line appears whenever they next happen to.
      state.origin = null;
      write(at, state.target);
    }
  }

  function onLocation(event) {
    var detail = event && event.detail;
    var lat = num(detail && detail.lat);
    var lng = num(detail && detail.lng);
    if (lat === null || lng === null) return;
    schedule({ lat: lat, lng: lng });
  }

  /* ------------------------------------------------------------------ boot */

  function tryInstall() {
    var map = resolveMap();
    if (!map) return false;
    state.map = map;
    if (!install(map)) return false;
    // A style change (night mode, a basemap swap) drops custom layers, so they
    // are put back and whatever was on screen is redrawn.
    try {
      map.on("styledata", function () {
        state.ready = false;
        if (install(map) && state.target) {
          outlineTarget(state.target);
          var at = driverAt();
          if (at) write(at, state.target);
        }
      });
    } catch (_) {}
    onRecommendation(window.TlcAssistantRecommendation);
    return true;
  }

  function boot() {
    if (tryInstall()) return;
    // The map is built asynchronously and there is no single ready event this
    // module can rely on, so it retries briefly and then gives up rather than
    // polling for the life of the session.
    var tries = 0;
    var timer = window.setInterval(function () {
      tries += 1;
      if (tryInstall() || tries > 60) window.clearInterval(timer);
    }, 500);
  }

  window.addEventListener("tlc:recommendation", function (event) {
    onRecommendation((event && event.detail) || window.TlcAssistantRecommendation);
  });
  window.addEventListener("tlc-user-location-updated", onLocation);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  window.TeamJoseoMapRoute = {
    _state: state,
    install: tryInstall,
    onRecommendation: onRecommendation,
    onLocation: onLocation,
    schedule: schedule,
    movedEnough: movedEnough,
    bearing: bearing,
    clear: clear,
    outlineTarget: outlineTarget,
    MIN_MOVE_DEG: MIN_MOVE_DEG,
  };
})();
