/**
 * compose.js — the Post destination.
 *
 * A feed nobody can post to is a reader. This is the writing half, against the
 * two endpoints that already exist: POST /social/posts for text, and
 * POST /social/posts/photo (multipart) for a photo plus its caption.
 *
 * WHAT IS NOT HERE, AND WHY
 *
 * The design draws three modes: Photo, Voice, Text. There is no audio endpoint
 * on the server, so there is no Voice tab. A tab that opens a recorder and
 * then cannot post it is worse than a tab that is not there — it takes
 * someone's time and their words and drops both.
 *
 * THE ZONE TAG
 *
 * "Tag the zone you're in" is read from the map's own resolver
 * (TlcMapUiInternals.resolveZoneFeatureAtLngLat plus effectiveRating), not
 * from the recommendation. The recommendation names where a driver should GO;
 * tagging a post with that would say "I am at JFK" to everyone while the
 * driver sits in Astoria being told to drive to JFK. Same resolver as the map
 * means the tag cannot disagree with what the driver is looking at.
 *
 * Installed by registering over the shell's placeholder, so app-shell.js needs
 * no edit and deleting this file restores the empty state.
 */
(function () {
  "use strict";

  var LS_TOKEN = "community_token_v1";
  var MAX_BODY = 2000;
  // The server's own ceiling. Checked here too so a driver on a slow
  // connection is told before the upload rather than after it.
  var MAX_IMAGE_BYTES = 8 * 1024 * 1024;

  var MODES = [
    { key: "photo", label: "Photo" },
    { key: "text", label: "Text" },
  ];

  var state = {
    mode: "photo",
    body: "",
    file: null,
    previewUrl: "",
    zone: null,        // { name, rating, lat, lng } or null
    tagZone: true,
    posting: false,
    error: "",
    done: "",
  };

  var nodes = {};

  /* ----------------------------------------------------------------- utils */

  function token() {
    try { return localStorage.getItem(LS_TOKEN) || ""; } catch (_) { return ""; }
  }

  function apiBase() {
    var runtime = window.FrontendRuntime;
    if (runtime && typeof runtime.resolveApiBase === "function") return runtime.resolveApiBase();
    var base = String(window.API_BASE || "").trim();
    if (base) return base.replace(/\/+$/, "");
    var cfg = String((window.__TLC_RUNTIME_CONFIG__ || {}).apiBase || "").trim();
    return cfg ? cfg.replace(/\/+$/, "") : "";
  }

  function num(value) {
    if (value === null || value === undefined || value === "") return null;
    var n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag || "div");
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function fire(type, detail) {
    try { window.dispatchEvent(new CustomEvent(type, { detail: detail })); } catch (_) {}
  }

  function scoreColor(rating) {
    var n = num(rating);
    if (n === null) return null;
    if (n >= 83) return { bg: "#00b050", fg: "#fff" };
    if (n >= 75) return { bg: "#8000ff", fg: "#fff" };
    if (n >= 68) return { bg: "#4b3cff", fg: "#fff" };
    if (n >= 60) return { bg: "#0066ff", fg: "#fff" };
    if (n >= 50) return { bg: "#66ccff", fg: "#0b1220" };
    if (n >= 40) return { bg: "#ffd400", fg: "#3d2e00" };
    if (n >= 30) return { bg: "#ff8c00", fg: "#fff" };
    return { bg: "#e60000", fg: "#fff" };
  }

  /* ------------------------------------------------------- where the driver is */

  /**
   * The zone under the driver right now, from the map's own resolver.
   *
   * Returns null rather than guessing. A post tagged with the wrong zone is
   * worse than an untagged one: the tag is the part other drivers act on.
   */
  function readZone() {
    var internals = window.TlcMapUiInternals;
    if (!internals || typeof internals.resolveZoneFeatureAtLngLat !== "function") return null;
    var at = typeof internals.getUserLatLng === "function" ? internals.getUserLatLng() : null;
    var lat = num(at && at.lat);
    var lng = num(at && at.lng);
    if (lat === null || lng === null) return null;

    var feature = null;
    try { feature = internals.resolveZoneFeatureAtLngLat({ lat: lat, lng: lng }); } catch (_) {}
    if (!feature) return { name: "", rating: null, lat: lat, lng: lng };

    var props = feature.properties || {};
    var name = String(props.zone_name || props.Zone || "").trim();
    var rating = null;
    try {
      // The VISIBLE rating, which is what the driver is looking at -- special
      // modes (Queens, Brooklyn, night) change it, and posting the raw score
      // would tag a number the map is not showing.
      if (typeof internals.effectiveRating === "function") {
        rating = num(internals.effectiveRating(props, feature.geometry));
      }
    } catch (_) {}
    if (rating === null) rating = num(props.rating);
    return { name: name, rating: rating, lat: lat, lng: lng };
  }

  /* --------------------------------------------------------------- posting */

  function canPost() {
    if (state.posting) return false;
    // The server requires text or a photo. Enforcing it here means the button
    // is simply not live rather than the driver getting a 400 for it.
    if (state.mode === "photo" && state.file) return true;
    return String(state.body || "").trim().length > 0;
  }

  function fields() {
    var out = {};
    var body = String(state.body || "").trim();
    if (body) out.body = body;
    if (state.tagZone && state.zone) {
      if (state.zone.name) out.zone_name = state.zone.name;
      if (state.zone.rating !== null && state.zone.rating !== undefined) {
        out.zone_rating = Math.round(state.zone.rating);
      }
      if (state.zone.lat !== null) out.lat = state.zone.lat;
      if (state.zone.lng !== null) out.lng = state.zone.lng;
    }
    return out;
  }

  async function submit() {
    if (!canPost()) return;
    state.posting = true;
    state.error = "";
    state.done = "";
    paint();

    var headers = {};
    var t = token();
    if (t) headers.Authorization = "Bearer " + t;

    var path;
    var init;
    if (state.mode === "photo" && state.file) {
      var form = new FormData();
      form.append("file", state.file);
      var data = fields();
      Object.keys(data).forEach(function (key) { form.append(key, String(data[key])); });
      path = "/social/posts/photo";
      // No Content-Type: the browser has to set the multipart boundary, and
      // setting it by hand produces a body the server cannot parse.
      init = { method: "POST", headers: headers, body: form };
    } else {
      headers["Content-Type"] = "application/json";
      path = "/social/posts";
      init = { method: "POST", headers: headers, body: JSON.stringify(fields()) };
    }

    try {
      var res = await fetch(apiBase() + path, Object.assign({ mode: "cors" }, init));
      var text = await res.text();
      if (!res.ok) {
        if (res.status === 401) fire("tlc:auth-expired", { status: 401, url: path });
        if (res.status === 402) fire("tlc:payment-required", { status: 402, url: path });
        var err = new Error(text || (res.status + " " + res.statusText));
        err.status = res.status;
        throw err;
      }
      var parsed = text ? JSON.parse(text) : {};
      reset();
      state.done = "Posted.";
      // The feed refetches on open, but a driver who taps Post and then Feed
      // within the same second can beat that. Announcing it lets the feed
      // decide; nothing here reaches into it.
      fire("tlc:post-created", { post: parsed && parsed.post });
    } catch (e) {
      state.error = describe(e);
    } finally {
      state.posting = false;
      paint();
    }
  }

  function describe(e) {
    var status = e && e.status;
    if (status === 401) return "Sign in to post.";
    if (status === 402) return "Your trial has ended — start a plan to post.";
    if (status === 413) return "That photo is too large. Try a smaller one.";
    if (status === 415) return "That file is not an image the server accepts.";
    if (status === 429) return "Slow down a moment, then try again.";
    return "Could not post. Check your connection and try again.";
  }

  function reset() {
    state.body = "";
    clearFile();
    if (nodes.body) nodes.body.value = "";
  }

  function clearFile() {
    // Object URLs are not garbage collected. A driver flipping through ten
    // photos leaks ten of them without this.
    if (state.previewUrl && window.URL && window.URL.revokeObjectURL) {
      try { window.URL.revokeObjectURL(state.previewUrl); } catch (_) {}
    }
    state.previewUrl = "";
    state.file = null;
    if (nodes.file) { try { nodes.file.value = ""; } catch (_) {} }
  }

  function takeFile(file) {
    if (!file) return;
    if (!/^image\//i.test(String(file.type || ""))) {
      state.error = "That file is not an image.";
      paint();
      return;
    }
    if (num(file.size) !== null && file.size > MAX_IMAGE_BYTES) {
      state.error = "That photo is larger than 8MB. Try a smaller one.";
      paint();
      return;
    }
    clearFile();
    state.file = file;
    state.error = "";
    if (window.URL && window.URL.createObjectURL) {
      try { state.previewUrl = window.URL.createObjectURL(file); } catch (_) {}
    }
    paint();
  }

  /* ---------------------------------------------------------------- render */

  function paint() {
    paintModes();
    paintPhoto();
    paintZone();
    paintFooter();
  }

  function paintModes() {
    if (!nodes.modes) return;
    var buttons = nodes.modes.querySelectorAll("[data-mode]");
    for (var i = 0; i < buttons.length; i += 1) {
      var on = buttons[i].getAttribute("data-mode") === state.mode;
      buttons[i].classList.toggle("on", on);
      buttons[i].setAttribute("aria-pressed", on ? "true" : "false");
    }
    if (nodes.photoRow) nodes.photoRow.hidden = state.mode !== "photo";
  }

  function paintPhoto() {
    if (!nodes.preview) return;
    if (state.previewUrl) {
      nodes.preview.src = state.previewUrl;
      nodes.preview.hidden = false;
      if (nodes.pickLabel) nodes.pickLabel.textContent = "Change photo";
      if (nodes.drop) nodes.drop.hidden = true;
    } else {
      nodes.preview.hidden = true;
      nodes.preview.removeAttribute("src");
      if (nodes.pickLabel) nodes.pickLabel.textContent = "Add a photo";
      if (nodes.drop) nodes.drop.hidden = false;
    }
    if (nodes.clear) nodes.clear.hidden = !state.file;
  }

  function paintZone() {
    if (!nodes.zoneRow) return;
    nodes.zoneRow.textContent = "";

    if (!state.zone || !state.zone.name) {
      // Honest about why, because the two reasons have different fixes: turn
      // location on, or wait for the map to finish loading.
      nodes.zoneRow.appendChild(el("div", "composeZoneNone",
        "No zone yet — the tag appears once the map has your location."));
      return;
    }

    var pill = el("button", "composeZonePill" + (state.tagZone ? " on" : ""));
    pill.type = "button";
    pill.setAttribute("data-role", "toggle-zone");
    pill.setAttribute("aria-pressed", state.tagZone ? "true" : "false");
    pill.appendChild(el("span", "composeZonePin", "◉"));
    pill.appendChild(el("span", "composeZoneName", state.zone.name));
    var tone = scoreColor(state.zone.rating);
    if (tone) {
      var badge = el("span", "composeZoneScore", String(Math.round(state.zone.rating)));
      if (state.tagZone) {
        badge.style.background = tone.bg;
        badge.style.color = tone.fg;
      }
      pill.appendChild(badge);
    }
    nodes.zoneRow.appendChild(pill);
    nodes.zoneRow.appendChild(el("div", "composeZoneHint", state.tagZone
      ? "Other drivers will see where this was posted from."
      : "Tap to tag this post with your zone."));
  }

  function paintFooter() {
    if (nodes.count) {
      var left = MAX_BODY - String(state.body || "").length;
      nodes.count.textContent = left <= 200 ? String(left) : "";
      nodes.count.classList.toggle("over", left < 0);
    }
    if (nodes.submit) {
      nodes.submit.disabled = !canPost();
      nodes.submit.textContent = state.posting ? "Posting…" : "Post";
    }
    if (nodes.status) {
      var message = state.error || state.done;
      nodes.status.textContent = message;
      nodes.status.hidden = !message;
      nodes.status.classList.toggle("composeStatusError", !!state.error);
    }
  }

  function onClick(event) {
    var target = event.target;
    if (!target || !target.closest) return;

    var mode = target.closest("[data-mode]");
    if (mode) {
      var next = mode.getAttribute("data-mode");
      if (next && next !== state.mode) {
        state.mode = next;
        // Switching to Text keeps the photo rather than discarding it: someone
        // who taps the wrong tab should not lose what they picked.
        state.error = "";
        paint();
      }
      return;
    }
    if (target.closest('[data-role="toggle-zone"]')) {
      state.tagZone = !state.tagZone;
      paintZone();
      return;
    }
    if (target.closest('[data-role="clear-photo"]')) {
      clearFile();
      paint();
      return;
    }
    if (target.closest('[data-role="submit"]')) {
      submit();
    }
  }

  function render(body) {
    var wrap = el("div", "composeScreen");

    var modes = el("div", "composeModes");
    modes.setAttribute("role", "group");
    modes.setAttribute("aria-label", "What kind of post");
    MODES.forEach(function (mode) {
      var button = el("button", "composeMode", mode.label);
      button.type = "button";
      button.setAttribute("data-mode", mode.key);
      modes.appendChild(button);
    });
    wrap.appendChild(modes);

    var photoRow = el("div", "composePhoto");
    var pick = el("label", "composePick");
    var file = el("input");
    file.type = "file";
    file.accept = "image/*";
    file.className = "composeFileInput";
    pick.appendChild(file);
    var pickLabel = el("span", "composePickLabel", "Add a photo");
    pick.appendChild(pickLabel);
    photoRow.appendChild(pick);

    var drop = el("div", "composeDrop", "Whatever you are looking at right now.");
    photoRow.appendChild(drop);

    var preview = el("img", "composePreview");
    preview.alt = "";
    preview.hidden = true;
    photoRow.appendChild(preview);

    var clear = el("button", "composeClear", "Remove photo");
    clear.type = "button";
    clear.hidden = true;
    clear.setAttribute("data-role", "clear-photo");
    photoRow.appendChild(clear);
    wrap.appendChild(photoRow);

    var text = el("textarea", "composeBody");
    text.setAttribute("maxlength", String(MAX_BODY));
    text.setAttribute("rows", "5");
    text.setAttribute("placeholder",
      "Say what you're seeing — queue length, a pay change, a spot that's working…");
    wrap.appendChild(text);

    var zoneHead = el("div", "composeLabel", "Tag the zone you're in");
    wrap.appendChild(zoneHead);
    var zoneRow = el("div", "composeZone");
    wrap.appendChild(zoneRow);

    var footer = el("div", "composeFooter");
    var count = el("div", "composeCount");
    footer.appendChild(count);
    var submitBtn = el("button", "composeSubmit", "Post");
    submitBtn.type = "button";
    submitBtn.setAttribute("data-role", "submit");
    footer.appendChild(submitBtn);
    wrap.appendChild(footer);

    var status = el("div", "composeStatus");
    status.hidden = true;
    status.setAttribute("role", "status");
    wrap.appendChild(status);

    body.appendChild(wrap);

    nodes.modes = modes;
    nodes.photoRow = photoRow;
    nodes.file = file;
    nodes.pickLabel = pickLabel;
    nodes.drop = drop;
    nodes.preview = preview;
    nodes.clear = clear;
    nodes.body = text;
    nodes.zoneRow = zoneRow;
    nodes.count = count;
    nodes.submit = submitBtn;
    nodes.status = status;

    wrap.addEventListener("click", onClick);
    text.addEventListener("input", function () {
      state.body = text.value || "";
      state.done = "";
      paintFooter();
    });
    file.addEventListener("change", function () {
      takeFile(file.files && file.files[0]);
    });

    paint();
  }

  function onEnter() {
    // Read the zone on open rather than once at load: a driver who opens this
    // after an hour of driving is somewhere else entirely.
    state.zone = readZone();
    state.error = "";
    state.done = "";
    paint();
  }

  function onLeave() {
    // The draft survives; the object URL does not. Someone who ducks back to
    // the map to check a score should find their words still there.
    clearFile();
    Object.keys(nodes).forEach(function (key) { delete nodes[key]; });
  }

  function install() {
    var shell = window.TeamJoseoShell;
    if (!shell || typeof shell.register !== "function") return false;
    shell.register({
      key: "post",
      title: "Post",
      icon: "＋",
      group: "Network",
      subtitle: "Share what you see",
      render: render,
      onEnter: onEnter,
      onLeave: onLeave,
    });
    return true;
  }

  if (!install()) document.addEventListener("DOMContentLoaded", install);

  window.TeamJoseoCompose = {
    _state: state,
    _nodes: nodes,
    modes: MODES,
    readZone: readZone,
    canPost: canPost,
    fields: fields,
    submit: submit,
    takeFile: takeFile,
    clearFile: clearFile,
    describe: describe,
    install: install,
  };
})();
