/**
 * map-feed-peek.js — the feed, on the map, without a tap.
 *
 * The top quarter of the map screen shows the latest few posts. Tapping
 * anywhere in it opens the full Feed destination. That is the whole of it: one
 * tap target, one destination, no scrolling inside the panel and no second way
 * to read a post. A panel that scrolled would fight the tap that opens it, and
 * a panel whose rows each went somewhere different would make the big obvious
 * gesture ambiguous.
 *
 * Why a separate file rather than feed.js: feed.js owns the Feed SCREEN. Its
 * state (scope, cursor, open threads) belongs to that screen, and driving it
 * from here would mean two callers writing one list -- a peek refresh would
 * silently reset whatever the driver had loaded and scrolled to. This keeps its
 * own three posts and touches TeamJoseoFeed only to borrow its formatting, so
 * "3 minutes ago" reads the same in both places.
 *
 * Free to read, deliberately. An unpaid driver keeps this when the map behind
 * it locks: seeing drivers talk about what the map told them is the reason to
 * pay for the map, so it is the last thing that should be taken away.
 */
(function () {
  "use strict";

  var LS_TOKEN = "community_token_v1";
  var ROOT_ID = "mapFeedPeek";
  // More than fits, on purpose. The panel is a fixed quarter of the screen and
  // does not scroll, so asking for exactly the number of rows that fit would
  // leave it visibly half empty whenever a post is short and two lines become
  // one. The overflow is clipped under a fade, which reads as "there is more"
  // -- which there is, one tap away.
  var LIMIT = 6;
  // Long enough that it is not a poll, short enough that a driver who glances
  // down after a while is not reading something from an hour ago.
  var REFRESH_MS = 180000;

  var state = { items: [], loading: false, loaded: false, error: "", at: 0 };
  var timer = null;

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

  function el(tag, className, text) {
    var node = document.createElement(tag || "div");
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function root() {
    return document.getElementById(ROOT_ID);
  }

  /* Borrowed from feed.js at call time, not at load time.
   *
   * Load order is the asset manifest's business and this file must not depend
   * on winning it. The fallbacks are deliberately the crude version: if
   * TeamJoseoFeed is there -- and in the shipped app it is -- the two agree,
   * and if it is not, a peek that says "2h" instead of nothing is still the
   * right trade. */
  function ago(ts) {
    var feed = window.TeamJoseoFeed;
    if (feed && typeof feed.ago === "function") return feed.ago(ts);
    var seconds = Math.floor(Date.now() / 1000) - Number(ts || 0);
    if (!Number.isFinite(seconds) || seconds < 0) return "";
    if (seconds < 90) return "now";
    if (seconds < 3600) return Math.round(seconds / 60) + "m";
    if (seconds < 86400) return Math.round(seconds / 3600) + "h";
    return Math.round(seconds / 86400) + "d";
  }

  function initials(name) {
    var feed = window.TeamJoseoFeed;
    if (feed && typeof feed.initials === "function") return feed.initials(name);
    var parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
  }

  /* ------------------------------------------------------------- fetching */

  async function request(path) {
    var headers = {};
    var t = token();
    if (t) headers.Authorization = "Bearer " + t;
    var res = await fetch(apiBase() + path, { mode: "cors", headers: headers });
    var text = await res.text();
    if (!res.ok) {
      var err = new Error(text || (res.status + " " + res.statusText));
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : {};
  }

  /* Everyone, always.
   *
   * Not the driver's chosen scope. This is a window onto the network, and the
   * two scopes that are not "everyone" can both be legitimately empty -- an
   * unpaid driver cannot follow anyone at all, and a driver in a quiet city has
   * no city posts. An empty quarter of the map teaches them there is nothing
   * here, which is the opposite of what it is for. */
  async function load() {
    if (state.loading) return;
    if (!token()) { state.items = []; paint(); return; }
    state.loading = true;
    paint();
    try {
      var data = await request("/social/feed?scope=everyone&limit=" + LIMIT);
      state.items = (data && data.items) || [];
      state.loaded = true;
      state.error = "";
      state.at = Date.now();
    } catch (err) {
      // Never blank what is already on screen for a failed refresh: a driver
      // glancing at three posts should not watch them vanish because one
      // request timed out in a tunnel. 401 is the exception -- the app is about
      // to show the welcome page and these posts are not theirs to keep.
      if (err && err.status === 401) state.items = [];
      state.error = state.items.length ? "" : "Could not load posts.";
    } finally {
      state.loading = false;
      paint();
    }
  }

  /* ------------------------------------------------------------- painting */

  function buildRow(post) {
    var author = post.author || {};
    var row = el("div", "peekRow");

    var avatar = el("div", "peekAvatar", initials(author.display_name));
    if (author.avatar_url) {
      var img = el("img", "peekAvatarImg");
      img.src = apiBase() + author.avatar_url;
      img.alt = "";
      img.loading = "lazy";
      img.addEventListener("error", function () { img.remove(); });
      avatar.appendChild(img);
    }
    row.appendChild(avatar);

    var text = el("div", "peekText");
    var top = el("div", "peekTopLine");
    top.appendChild(el("span", "peekName", author.display_name || "Driver"));
    var age = ago(post.created_at);
    if (age) top.appendChild(el("span", "peekAge", age));
    text.appendChild(top);

    // One line, clipped by CSS rather than cut here: a post trimmed in
    // JavaScript is trimmed at the wrong width on every screen but the one it
    // was measured on.
    var body = String(post.body || "").replace(/\s+/g, " ").trim();
    if (!body && (post.image_thumb_url || post.image_url)) body = "Shared a photo";
    text.appendChild(el("div", "peekBody", body));
    row.appendChild(text);

    return row;
  }

  function paint() {
    var host = root();
    if (!host) return;
    var list = host.querySelector(".peekList");
    if (!list) return;

    if (!token()) { host.hidden = true; return; }
    host.hidden = false;

    list.textContent = "";
    if (state.items.length) {
      state.items.forEach(function (post) { list.appendChild(buildRow(post)); });
      return;
    }
    if (state.loading && !state.loaded) {
      list.appendChild(el("div", "peekNote", "Loading posts…"));
      return;
    }
    list.appendChild(el("div", "peekNote",
      state.error || "No posts yet — be the first."));
  }

  /* --------------------------------------------------------------- opening */

  function openFeed() {
    var shell = window.TeamJoseoShell;
    if (shell && typeof shell.open === "function") shell.open("feed");
  }

  /* ---------------------------------------------------------------- mount */

  function schedule() {
    if (timer !== null) return;
    timer = window.setInterval(function () {
      // Nothing fetched for a screen nobody is looking at, and nothing fetched
      // while a destination is covering the map.
      if (document.hidden) return;
      if (document.body && document.body.classList.contains("shell-screen-open")) return;
      load();
    }, REFRESH_MS);
  }

  function mount() {
    var host = root();
    if (!host || host.__peekMounted) return;
    host.__peekMounted = true;

    host.addEventListener("click", function (event) {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      openFeed();
    });
    host.addEventListener("keydown", function (event) {
      if (!event) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openFeed();
    });

    paint();
    load();
    schedule();

    // Signing in is what makes this panel have anything to say, and signing out
    // is what makes it somebody else's posts.
    window.addEventListener("tlc:auth-state-changed", function () {
      paint();
      load();
    });
    window.addEventListener("tlc:auth-expired", function () {
      state.items = [];
      state.loaded = false;
      paint();
    });
    // Coming back to the app after a while is exactly when the posts on screen
    // are stalest.
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) return;
      if (Date.now() - state.at < 30000) return;
      load();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }

  window.TeamJoseoMapFeedPeek = {
    _state: state,
    load: load,
    paint: paint,
    buildRow: buildRow,
    openFeed: openFeed,
    mount: mount,
    ago: ago,
    initials: initials,
  };
})();
