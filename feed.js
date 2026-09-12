/**
 * feed.js — the Feed destination.
 *
 * Registers itself over the shell's placeholder, so adding this file is the
 * whole install: app-shell.js needs no edit, and deleting this file puts the
 * empty state back rather than breaking navigation.
 *
 * The API is already built (social_routes.py): GET /social/feed?scope=… with
 * cursor paging on before_id, POST/DELETE /social/posts/{id}/like. This file
 * renders that and nothing else. Where the backend has no field — comment
 * counts, saves, voice notes — the card leaves the space empty rather than
 * showing a zero that will never move.
 *
 * Following the pattern app.part3.js and app.part4.js already use for talking
 * to the API: the token comes from localStorage under the same key the auth
 * code writes, and the base URL through runtime config with the same
 * fallbacks. Nothing here reimplements auth.
 */
(function () {
  "use strict";

  var LS_TOKEN = "community_token_v1";
  var PAGE_SIZE = 20;

  // Deliberately not "Following / Nearby / Nights" as drawn. `city` is the
  // scope the server actually has — it is city-keyed, not radius-based, so
  // "Nearby" would promise proximity the data cannot keep — and there is no
  // time-of-day scope behind "Nights" at all. A tab that lies about what it
  // filters is worse than a tab with a plainer name.
  var SCOPES = [
    { key: "following", label: "Following" },
    { key: "city", label: "My city" },
    { key: "everyone", label: "Everyone" },
  ];

  var state = {
    scope: "following",
    items: [],
    nextBeforeId: null,
    loading: false,
    error: "",
    mounted: false,
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

  /**
   * A finite number, or null when the field is absent.
   *
   * Number(null) is 0 and Number("") is 0 — both finite. So the obvious
   * Number.isFinite(Number(x)) check reports "absent" as a real zero, which
   * here means a driver with no level badged "LVL 0" (the lowest rank, which
   * they have not earned) and a post with no zone rating badged a red 0, which
   * on the map legend means AVOID. Absent has to be told apart from zero.
   */
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

  async function getAuth(path) {
    var runtime = window.FrontendRuntime;
    if (runtime && typeof runtime.getJSONAuth === "function") return runtime.getJSONAuth(path, token());
    if (typeof window.getJSONAuth === "function") return window.getJSONAuth(path, token());
    return request(path, { method: "GET" });
  }

  async function request(path, opts) {
    var headers = {};
    var t = token();
    if (t) headers.Authorization = "Bearer " + t;
    var res = await fetch(apiBase() + path, Object.assign({ mode: "cors", headers: headers }, opts || {}));
    var text = await res.text();
    if (!res.ok) {
      // Same signals the rest of the app raises, so an expired session takes
      // the whole app back to the landing page rather than leaving this one
      // screen stuck on an error nobody can act on.
      if (res.status === 401) fire("tlc:auth-expired", { status: 401, url: path });
      if (res.status === 402) fire("tlc:payment-required", { status: 402, url: path });
      var err = new Error(text || (res.status + " " + res.statusText));
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : {};
  }

  function fire(type, detail) {
    try { window.dispatchEvent(new CustomEvent(type, { detail: detail })); } catch (_) {}
  }

  /** "18m", "3h", "2d" — a driver reads relative time, not a date. */
  function ago(seconds) {
    var then = num(seconds);
    if (then === null || then <= 0) return "";
    var delta = Math.floor(Date.now() / 1000) - then;
    if (delta < 60) return "now";
    if (delta < 3600) return Math.floor(delta / 60) + "m";
    if (delta < 86400) return Math.floor(delta / 3600) + "h";
    if (delta < 604800) return Math.floor(delta / 86400) + "d";
    return Math.floor(delta / 604800) + "w";
  }

  function initials(name) {
    var parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  // A stable colour per driver, so the same person is the same colour every
  // time you scroll past them. Hashed from the id rather than the name: people
  // change their display name.
  var AVATAR_COLORS = ["#4b3cff", "#0066ff", "#8000ff", "#00a35c", "#e2701a",
    "#c81e5a", "#0e8f9e", "#6b3fd4"];
  function avatarColor(userId) {
    var n = num(userId);
    if (n === null) n = 0;
    return AVATAR_COLORS[Math.abs(Math.round(n)) % AVATAR_COLORS.length];
  }

  // Zone scores use the same bands as the map legend. A pill that coloured a
  // 44 green would be teaching drivers the wrong thing about the map.
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

  /* ------------------------------------------------------------ one card */

  function buildCard(post) {
    var author = post.author || {};
    var card = el("article", "feedCard");
    card.setAttribute("data-post-id", String(post.id));

    var head = el("div", "feedHead");

    var avatar = el("div", "feedAvatar", initials(author.display_name));
    avatar.style.background = avatarColor(author.user_id);
    if (author.avatar_url) {
      var img = el("img", "feedAvatarImg");
      img.src = apiBase() + author.avatar_url;
      img.alt = "";
      img.loading = "lazy";
      // A broken avatar falls back to the initials already underneath it
      // rather than to a browser's broken-image glyph.
      img.addEventListener("error", function () { img.remove(); });
      avatar.appendChild(img);
    }
    head.appendChild(avatar);

    var who = el("div", "feedWho");
    var line1 = el("div", "feedNameRow");
    line1.appendChild(el("span", "feedName", author.display_name || "Driver"));
    var level = num(author.level);
    if (level !== null) line1.appendChild(el("span", "feedLevel", "LVL " + Math.round(level)));
    who.appendChild(line1);

    // Handle, platform, age, city — whichever of them exist. Joined here rather
    // than in the markup so a driver with no handle and no city does not get a
    // row of orphaned separators.
    var meta = [];
    if (author.handle) meta.push("@" + author.handle);
    if (Array.isArray(author.platforms) && author.platforms.length) {
      meta.push(author.platforms.join(" "));
    }
    var age = ago(post.created_at);
    if (age) meta.push(age);
    if (post.city) meta.push(post.city);
    who.appendChild(el("div", "feedMeta", meta.join(" · ")));
    head.appendChild(who);
    card.appendChild(head);

    if (post.zone_name) {
      var zone = el("div", "feedZone");
      zone.appendChild(el("span", "feedZonePin", "◉"));
      zone.appendChild(el("span", "feedZoneName", post.zone_name));
      var tone = scoreColor(post.zone_rating);
      if (tone) {
        var badge = el("span", "feedZoneScore", String(Math.round(post.zone_rating)));
        badge.style.background = tone.bg;
        badge.style.color = tone.fg;
        zone.appendChild(badge);
      }
      card.appendChild(zone);
    }

    if (post.image_thumb_url || post.image_url) {
      var shot = el("img", "feedImage");
      shot.src = apiBase() + (post.image_thumb_url || post.image_url);
      shot.alt = "";
      shot.loading = "lazy";
      shot.addEventListener("error", function () { shot.remove(); });
      card.appendChild(shot);
    }

    if (post.body) card.appendChild(el("div", "feedBody", post.body));

    var actions = el("div", "feedActions");
    var like = el("button", "feedLike");
    like.type = "button";
    like.setAttribute("data-role", "like");
    paintLike(like, post);
    actions.appendChild(like);
    card.appendChild(actions);

    return card;
  }

  function paintLike(button, post) {
    var liked = !!post.liked_by_me;
    button.textContent = (liked ? "♥ " : "♡ ") + (num(post.like_count) || 0);
    button.setAttribute("aria-pressed", liked ? "true" : "false");
    button.classList.toggle("on", liked);
  }

  /* --------------------------------------------------------------- liking */

  async function toggleLike(postId, button) {
    var post = state.items.filter(function (p) { return String(p.id) === String(postId); })[0];
    if (!post || button.disabled) return;

    // Optimistic, because a like that waits for a round trip on a phone in a
    // parking lot feels broken. Every field is restored on failure — a count
    // that drifts from the server is worse than a slow one.
    var before = { liked_by_me: post.liked_by_me, like_count: post.like_count };
    post.liked_by_me = !before.liked_by_me;
    post.like_count = Math.max(0, (num(before.like_count) || 0) + (post.liked_by_me ? 1 : -1));
    paintLike(button, post);
    button.disabled = true;

    try {
      var res = await request("/social/posts/" + encodeURIComponent(postId) + "/like", {
        method: before.liked_by_me ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
      });
      // The server's count wins: two people liking at once means the guess
      // above is one short.
      var served = res ? num(res.like_count) : null;
      if (served !== null) post.like_count = served;
    } catch (_) {
      post.liked_by_me = before.liked_by_me;
      post.like_count = before.like_count;
    } finally {
      button.disabled = false;
      paintLike(button, post);
    }
  }

  /* --------------------------------------------------------------- render */

  function paintScopes() {
    if (!nodes.scopes) return;
    var buttons = nodes.scopes.querySelectorAll("[data-scope]");
    for (var i = 0; i < buttons.length; i += 1) {
      var on = buttons[i].getAttribute("data-scope") === state.scope;
      buttons[i].classList.toggle("on", on);
      buttons[i].setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  function paintList() {
    if (!nodes.list) return;
    nodes.list.textContent = "";

    if (state.error) {
      nodes.list.appendChild(notice(state.error, true));
      return;
    }
    if (!state.items.length) {
      if (state.loading) {
        nodes.list.appendChild(notice("Loading…"));
      } else {
        nodes.list.appendChild(notice(emptyLine()));
      }
      return;
    }

    state.items.forEach(function (post) { nodes.list.appendChild(buildCard(post)); });

    if (state.nextBeforeId) {
      var more = el("button", "feedMore", state.loading ? "Loading…" : "Load more");
      more.type = "button";
      more.disabled = state.loading;
      more.setAttribute("data-role", "more");
      nodes.list.appendChild(more);
    }
  }

  /** Why a feed is empty matters: three scopes are empty for three reasons. */
  function emptyLine() {
    if (state.scope === "following") {
      return "Nobody you follow has posted yet. Try Everyone to find drivers.";
    }
    if (state.scope === "city") {
      return "Nothing from your city yet — or you have not set one. Add it in your profile.";
    }
    return "No posts yet. Be the first.";
  }

  function notice(text, isError) {
    var box = el("div", "feedNotice" + (isError ? " feedNoticeError" : ""), text);
    return box;
  }

  /* ----------------------------------------------------------------- load */

  async function load(options) {
    var append = !!(options && options.append);
    if (state.loading) return;
    state.loading = true;
    state.error = "";
    if (!append) {
      state.items = [];
      state.nextBeforeId = null;
    }
    paintList();

    var scopeAtRequest = state.scope;
    var query = "?scope=" + encodeURIComponent(scopeAtRequest) + "&limit=" + PAGE_SIZE;
    if (append && state.nextBeforeId) query += "&before_id=" + encodeURIComponent(state.nextBeforeId);

    try {
      var data = await getAuth("/social/feed" + query);
      // The driver may have switched tabs while this was in flight. Dropping a
      // stale response is the difference between a tab that works and one that
      // sometimes shows the previous tab's posts.
      if (scopeAtRequest !== state.scope) return;
      var items = (data && data.items) || [];
      state.items = append ? state.items.concat(items) : items;
      state.nextBeforeId = (data && data.next_before_id) || null;
    } catch (err) {
      if (scopeAtRequest !== state.scope) return;
      state.error = err && err.status === 401
        ? "Sign in to see the feed."
        : "Could not load the feed. Pull down to try again.";
    } finally {
      if (scopeAtRequest === state.scope) {
        state.loading = false;
        paintList();
      }
    }
  }

  function setScope(next) {
    if (!next || next === state.scope) return;
    if (!SCOPES.some(function (s) { return s.key === next; })) return;
    state.scope = next;
    paintScopes();
    load();
  }

  /* ---------------------------------------------------------------- mount */

  function onClick(event) {
    var target = event.target;
    if (!target || !target.closest) return;

    var scopeBtn = target.closest("[data-scope]");
    if (scopeBtn) { setScope(scopeBtn.getAttribute("data-scope")); return; }

    var likeBtn = target.closest('[data-role="like"]');
    if (likeBtn) {
      var card = likeBtn.closest("[data-post-id]");
      if (card) toggleLike(card.getAttribute("data-post-id"), likeBtn);
      return;
    }

    var moreBtn = target.closest('[data-role="more"]');
    if (moreBtn) { load({ append: true }); }
  }

  function render(body) {
    var wrap = el("div", "feedScreen");

    var scopes = el("div", "feedScopes");
    scopes.setAttribute("role", "group");
    scopes.setAttribute("aria-label", "Which posts");
    SCOPES.forEach(function (scope) {
      var button = el("button", "feedScope", scope.label);
      button.type = "button";
      button.setAttribute("data-scope", scope.key);
      scopes.appendChild(button);
    });
    wrap.appendChild(scopes);

    var list = el("div", "feedList");
    wrap.appendChild(list);

    body.appendChild(wrap);
    nodes.scopes = scopes;
    nodes.list = list;
    // One delegated listener on a container that is rebuilt every visit, so
    // nothing accumulates across opens.
    wrap.addEventListener("click", onClick);
    paintScopes();
    paintList();
  }

  function onEnter() {
    // Always refetch on open. A timeline is the one screen where showing what
    // was true ten minutes ago is a bug, and posts are small.
    load();
  }

  function onLeave() {
    // Cleared in place rather than reassigned: the exported handle points at
    // this object, and swapping it would leave that handle looking at a map of
    // nodes the shell has already thrown away.
    Object.keys(nodes).forEach(function (key) { delete nodes[key]; });
  }

  function install() {
    var shell = window.TeamJoseoShell;
    if (!shell || typeof shell.register !== "function") return false;
    shell.register({
      key: "feed",
      title: "Feed",
      icon: "▦",
      group: "Network",
      subtitle: "Posts from drivers",
      render: render,
      onEnter: onEnter,
      onLeave: onLeave,
    });
    state.mounted = true;
    return true;
  }

  if (!install()) {
    // app-shell.js registers its placeholder at DOMContentLoaded. If this file
    // ran first there is nothing to register over yet, so wait for the same
    // signal rather than racing it.
    document.addEventListener("DOMContentLoaded", install);
  }

  window.TeamJoseoFeed = {
    _state: state,
    _nodes: nodes,
    scopes: SCOPES,
    setScope: setScope,
    load: load,
    buildCard: buildCard,
    ago: ago,
    initials: initials,
    scoreColor: scoreColor,
    install: install,
  };
})();
