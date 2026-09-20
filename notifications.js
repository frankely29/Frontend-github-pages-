/**
 * notifications.js — who touched your posts while you were driving.
 *
 * Registers itself as a shell destination, the same way feed.js and profile.js
 * do: adding this file is the whole install, and deleting it removes the
 * destination rather than breaking navigation.
 *
 * The API is social_routes.py:
 *   GET  /social/notifications?limit&before_id   a page, newest first
 *   GET  /social/notifications/unread            just the number
 *   POST /social/notifications/read              {before_id?}
 *
 * Two things this file is careful about, because both are how a notifications
 * screen becomes something people turn off:
 *
 *   1. It marks read up to the newest row it actually SHOWED, never "all".
 *      Something that arrives while the screen is open was never on it, so
 *      marking it read would lose it silently. The server takes before_id for
 *      exactly this.
 *
 *   2. The badge is polled, the page is not. A count is one indexed read; a
 *      page joins users and posts for twenty rows. Polling the page to keep a
 *      dot up to date is how a phone's battery goes.
 */
(function () {
  "use strict";

  var LS_TOKEN = "community_token_v1";
  var PAGE_SIZE = 20;

  /* How often the badge asks. Sixty seconds is a compromise between a dot that
   * feels live and a request every time a driver looks at their phone at a
   * light. It only runs while the tab is visible -- see startPolling. */
  var POLL_MS = 60000;

  var state = {
    items: [],
    nextBeforeId: null,
    loading: false,
    error: "",
    unread: 0,
    mounted: false,
    open: false,
    pollTimer: null,
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

  async function request(path, opts) {
    var t = token();
    // Merge, do not replace -- see the same note in feed.js. A write that
    // loses its Authorization header comes back 401 and signs the driver out.
    var init = Object.assign({ mode: "cors" }, opts || {});
    init.headers = Object.assign({}, (opts && opts.headers) || {});
    if (t) init.headers.Authorization = "Bearer " + t;
    var res = await fetch(apiBase() + path, init);
    var text = await res.text();
    if (!res.ok) {
      if (res.status === 401 && init.headers.Authorization) {
        fire("tlc:auth-expired", { status: 401, url: path, token: t });
      }
      if (res.status === 402) fire("tlc:payment-required", { status: 402, url: path });
      var err = new Error(text || (res.status + " " + res.statusText));
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : {};
  }

  /** "18m", "3h", "2d" — the same shape feed.js uses, for the same reason. */
  function ago(seconds) {
    var then = num(seconds);
    if (then === null || then <= 0) return "";
    var delta = Math.max(0, Math.floor(Date.now() / 1000) - then);
    if (delta < 60) return "now";
    if (delta < 3600) return Math.floor(delta / 60) + "m";
    if (delta < 86400) return Math.floor(delta / 3600) + "h";
    return Math.floor(delta / 86400) + "d";
  }

  function initials(name) {
    var parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  /* --------------------------------------------------------------- the words
   *
   * One sentence per kind, and the actor's name is a separate node so it can
   * be weighted without the sentence being assembled from fragments in three
   * places. An unknown kind gets a plain sentence rather than nothing: the
   * server is allowed to add a kind before this file knows about it, and a
   * blank row is worse than a vague one.
   */
  var SAID = {
    like: "liked your post",
    comment: "commented on your post",
    reply: "replied to you",
    follow: "started following you",
  };

  function sentence(kind) {
    return SAID[String(kind || "")] || "did something on your post";
  }

  /* ------------------------------------------------------------------ data */

  async function load(opts) {
    var append = !!(opts && opts.append);
    if (state.loading) return;
    state.loading = true;
    state.error = "";
    if (!append) paint();
    try {
      var path = "/social/notifications?limit=" + PAGE_SIZE;
      if (append && state.nextBeforeId) path += "&before_id=" + state.nextBeforeId;
      var data = await request(path, { method: "GET" });
      var items = (data && data.items) || [];
      state.items = append ? state.items.concat(items) : items;
      state.nextBeforeId = (data && data.next_before_id) || null;
      state.unread = num(data && data.unread) || 0;
      paintBadge();
      // Read up to the newest row this page actually showed -- never "all".
      // Something that lands while the screen is open was never on it.
      if (!append && state.items.length) markRead(state.items[0].id);
    } catch (err) {
      state.error = (err && err.status === 402)
        ? "Notifications are part of a plan."
        : "Couldn't load notifications.";
    } finally {
      state.loading = false;
      paint();
    }
  }

  async function markRead(beforeId) {
    try {
      var data = await request("/social/notifications/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(beforeId ? { before_id: beforeId } : {}),
      });
      state.unread = num(data && data.unread) || 0;
      /* The badge clears; the rows on screen do NOT stop looking new.
       *
       * Flipping them here was worse than it sounds: opening the screen ran
       * this immediately, so every row lost its mark in the same frame it
       * appeared and a driver could never see WHICH ones were new -- the one
       * question the screen exists to answer. The server has them as read, so
       * they come back read the next time the screen is opened, which is the
       * right moment for them to go quiet.
       *
       * Rows are never removed either. "Read" is not "gone". */
      paintBadge();
    } catch (_) {
      // A badge that failed to clear is not worth an error message.
    }
  }

  async function refreshCount() {
    if (!token()) return;
    try {
      var data = await request("/social/notifications/unread", { method: "GET" });
      state.unread = num(data && data.unread) || 0;
      paintBadge();
    } catch (_) {
      // Offline, or not paid. Either way the badge simply does not move.
    }
  }

  /* ---------------------------------------------------------------- the dot
   *
   * Lives on the menu button, because that is the one piece of chrome on
   * screen at all times and the destination is inside the menu. Built here
   * rather than in app-shell.js so the shell keeps knowing nothing about the
   * social API -- the same seam feed.js respects.
   */
  function paintBadge() {
    var button = document.getElementById("shellMenuBtn");
    if (!button) return;
    var dot = button.querySelector(".shellMenuDot");
    if (!state.unread) {
      if (dot && dot.parentNode) dot.parentNode.removeChild(dot);
      return;
    }
    if (!dot) {
      dot = el("span", "shellMenuDot");
      dot.setAttribute("aria-hidden", "true");
      button.appendChild(dot);
    }
    // A number up to 9, then "9+". Two digits in a 16px dot is unreadable, and
    // the exact count past nine changes nothing a driver would do.
    dot.textContent = state.unread > 9 ? "9+" : String(state.unread);
  }

  /* ---------------------------------------------------------------- render */

  function row(item) {
    var button = el("button", "notifRow");
    button.type = "button";
    button.setAttribute("data-notif-id", String(item.id || ""));
    if (!item.read) button.classList.add("unread");

    var actor = item.actor || {};
    var face = el("span", "notifFace", initials(actor.display_name));
    if (actor.avatar_url) {
      var img = el("img", "notifFaceImg");
      img.src = actor.avatar_url;
      img.alt = "";
      img.loading = "lazy";
      face.textContent = "";
      face.appendChild(img);
    }
    button.appendChild(face);

    var text = el("span", "notifText");
    var line = el("span", "notifLine");
    line.appendChild(el("b", "notifWho", actor.display_name || "A driver"));
    line.appendChild(document.createTextNode(" " + sentence(item.kind)));
    text.appendChild(line);
    // The post's own first line, so the row says WHICH post. A follow has no
    // post and gets nothing rather than an empty second line.
    if (item.post_excerpt) text.appendChild(el("span", "notifQuote", item.post_excerpt));
    button.appendChild(text);

    button.appendChild(el("span", "notifWhen", ago(item.created_at)));
    return button;
  }

  function paint() {
    var body = nodes.body;
    if (!body) return;
    body.textContent = "";

    if (state.error) {
      body.appendChild(el("div", "shellEmpty", state.error));
      return;
    }
    if (state.loading && !state.items.length) {
      body.appendChild(el("div", "shellEmpty", "Loading…"));
      return;
    }
    if (!state.items.length) {
      body.appendChild(el("div", "shellEmpty",
        "Nothing yet. Likes, replies and new followers show up here."));
      return;
    }

    var list = el("div", "notifList");
    state.items.forEach(function (item) { list.appendChild(row(item)); });
    body.appendChild(list);

    if (state.nextBeforeId) {
      var more = el("button", "notifMore", state.loading ? "Loading…" : "Older");
      more.type = "button";
      more.disabled = !!state.loading;
      more.addEventListener("click", function () { load({ append: true }); });
      body.appendChild(more);
    }
  }

  /** Tapping a row opens what it is about. */
  function onClick(event) {
    var target = event.target;
    var button = target && target.closest ? target.closest(".notifRow") : null;
    if (!button) return;
    var id = num(button.getAttribute("data-notif-id"));
    var item = state.items.filter(function (n) { return n.id === id; })[0];
    if (!item) return;
    /* A follow is about a person, and profile.js already has the entry point
     * for "show me this driver" -- it sets the target, opens the screen and
     * writes the hash so a reload stays on them. */
    var profile = window.TeamJoseoProfile;
    if (!item.post_id && item.actor && item.actor.user_id
        && profile && typeof profile.open === "function") {
      profile.open(item.actor.user_id);
      return;
    }

    /* Everything else is about a post, and the feed is where a post is read.
     *
     * It opens the feed and stops there rather than scrolling to the post and
     * expanding its thread. Doing that properly means fetching the one post --
     * it may not be in the scope that is loaded, and usually is not, since the
     * scope that matters here is whichever one the driver last looked at --
     * and that is its own change. Opening the wrong end of the right screen is
     * honest; firing an event nothing listens for would not be. */
    var shell = window.TeamJoseoShell;
    if (shell && typeof shell.open === "function") shell.open("feed");
  }

  function render(body) {
    nodes.body = body;
    body.addEventListener("click", onClick);
    paint();
  }

  function onEnter() {
    state.open = true;
    load({ append: false });
  }

  function onLeave() {
    state.open = false;
    Object.keys(nodes).forEach(function (key) { delete nodes[key]; });
  }

  /* --------------------------------------------------------------- polling
   *
   * Only while the tab is visible. A backgrounded PWA polling every minute is
   * a battery complaint, and the count is re-read the moment it comes back.
   */
  function startPolling() {
    stopPolling();
    if (typeof document.hidden === "boolean" && document.hidden) return;
    state.pollTimer = window.setInterval(refreshCount, POLL_MS);
  }

  function stopPolling() {
    if (state.pollTimer) window.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  function onVisibility() {
    if (document.hidden) { stopPolling(); return; }
    refreshCount();
    startPolling();
  }

  /* --------------------------------------------------------------- install */

  function install() {
    var shell = window.TeamJoseoShell;
    if (!shell || typeof shell.register !== "function") return false;
    shell.register({
      key: "notifications",
      title: "Notifications",
      icon: "◔",
      group: "Network",
      subtitle: "Likes, replies and follows",
      render: render,
      onEnter: onEnter,
      onLeave: onLeave,
    });
    state.mounted = true;
    refreshCount();
    startPolling();
    return true;
  }

  document.addEventListener("visibilitychange", onVisibility);
  // Signing in or out changes whose notifications these are.
  window.addEventListener("tlc:auth-state-changed", function () {
    state.items = [];
    state.nextBeforeId = null;
    state.unread = 0;
    paintBadge();
    refreshCount();
  });
  window.addEventListener("tlc:auth-expired", function () {
    state.unread = 0;
    paintBadge();
    stopPolling();
  });

  if (!install()) {
    document.addEventListener("DOMContentLoaded", install);
  }

  window.TeamJoseoNotifications = {
    _state: state,
    refresh: refreshCount,
    load: load,
    markRead: markRead,
  };
})();
