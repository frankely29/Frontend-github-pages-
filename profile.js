/**
 * profile.js — the Profile destination.
 *
 * Your own profile, or anyone else's. Registers over the shell's placeholder,
 * which today routes to the old dock panel, so this is the whole install and
 * app-shell.js is untouched.
 *
 * Against endpoints that already exist: GET /social/me/profile,
 * GET /social/users/{id}/profile, GET /social/users/{id}/posts, and
 * POST/DELETE /social/users/{id}/follow.
 *
 * WHOSE PROFILE
 *
 * TeamJoseoProfile.open(userId) opens a specific driver; opening the
 * destination with no target shows your own. The target rides in the hash as
 * #/profile?u=<id> so a reload comes back to the same person — the shell's
 * router splits the hash on "?" before matching, so this needs no change
 * there.
 *
 * WHAT IS NOT HERE
 *
 * The design shows a weekly borough rank ("#12 Queens this week") and three
 * named badges. The API serves one badge code and no weekly rank, so those
 * spaces are empty rather than filled with invented numbers. Editing your own
 * profile is a separate piece: the endpoints exist, but a form belongs with
 * its own tests.
 */
(function () {
  "use strict";

  var LS_TOKEN = "community_token_v1";
  var GRID_PAGE = 24;

  var state = {
    target: null,      // user id, or null for "me"
    profile: null,
    posts: [],
    nextBeforeId: null,
    loading: false,
    error: "",
    following: false,  // a follow request in flight
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

  /** 1847 -> "1,847". A follower count is read, not calculated. */
  function group(value) {
    var n = num(value);
    if (n === null) return "—";
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function initials(name) {
    var parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  var AVATAR_COLORS = ["#4b3cff", "#0066ff", "#8000ff", "#00a35c", "#e2701a",
    "#c81e5a", "#0e8f9e", "#6b3fd4"];
  function avatarColor(userId) {
    var n = num(userId);
    if (n === null) n = 0;
    return AVATAR_COLORS[Math.abs(Math.round(n)) % AVATAR_COLORS.length];
  }

  // The map legend's bands, so a chip on a post can never disagree with the
  // colour that zone has on the map.
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

  async function request(path, opts) {
    var headers = {};
    var t = token();
    if (t) headers.Authorization = "Bearer " + t;
    var res = await fetch(apiBase() + path, Object.assign({ mode: "cors", headers: headers }, opts || {}));
    var text = await res.text();
    if (!res.ok) {
      if (res.status === 401) fire("tlc:auth-expired", { status: 401, url: path });
      if (res.status === 402) fire("tlc:payment-required", { status: 402, url: path });
      var err = new Error(text || (res.status + " " + res.statusText));
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : {};
  }

  /* ------------------------------------------------------------- the hash */

  function hashTarget() {
    var hash = String(window.location.hash || "");
    var q = hash.indexOf("?");
    if (q < 0) return null;
    var match = /(?:^|&)u=(\d+)(?:&|$)/.exec(hash.slice(q + 1));
    return match ? Number(match[1]) : null;
  }

  function writeHash() {
    // replaceState rather than assigning location.hash: assigning would push a
    // history entry per profile, so Android back would walk someone backwards
    // through every driver they looked at instead of leaving the screen.
    var next = "#/profile" + (state.target ? "?u=" + state.target : "");
    if (String(window.location.hash || "") === next) return;
    try {
      if (window.history && window.history.replaceState) {
        window.history.replaceState(null, "", next);
      }
    } catch (_) {}
  }

  /* ---------------------------------------------------------------- loading */

  async function load() {
    if (state.loading) return;
    state.loading = true;
    state.error = "";
    state.profile = null;
    state.posts = [];
    state.nextBeforeId = null;
    paint();

    var targetAtRequest = state.target;
    var path = targetAtRequest
      ? "/social/users/" + encodeURIComponent(targetAtRequest) + "/profile"
      : "/social/me/profile";

    try {
      var data = await request(path, { method: "GET" });
      if (targetAtRequest !== state.target) return;
      state.profile = (data && data.profile) || null;
      // Now that the real id is known, pin it: "me" has to become a number
      // before the posts request, or your own grid asks for /users/null/posts.
      if (state.profile && !state.target) state.target = num(state.profile.user_id);
    } catch (err) {
      if (targetAtRequest !== state.target) return;
      state.error = err && err.status === 404
        ? "That driver is not here."
        : "Could not load this profile.";
      state.loading = false;
      paint();
      return;
    }

    try {
      var grid = await request("/social/users/" + encodeURIComponent(state.target)
        + "/posts?limit=" + GRID_PAGE, { method: "GET" });
      if (targetAtRequest !== state.target && targetAtRequest !== null) return;
      state.posts = (grid && grid.items) || [];
      state.nextBeforeId = (grid && grid.next_before_id) || null;
    } catch (_) {
      // The grid failing is not the profile failing. Show the person, say the
      // posts did not load, and leave the rest readable.
      state.posts = [];
      state.nextBeforeId = null;
      state.error = "";
      state.gridError = true;
    }

    state.loading = false;
    paint();
  }

  async function loadMore() {
    if (state.loading || !state.nextBeforeId || !state.target) return;
    state.loading = true;
    paintGrid();
    try {
      var grid = await request("/social/users/" + encodeURIComponent(state.target)
        + "/posts?limit=" + GRID_PAGE + "&before_id=" + encodeURIComponent(state.nextBeforeId),
        { method: "GET" });
      state.posts = state.posts.concat((grid && grid.items) || []);
      state.nextBeforeId = (grid && grid.next_before_id) || null;
    } catch (_) {
      state.gridError = true;
    } finally {
      state.loading = false;
      paintGrid();
    }
  }

  async function toggleFollow() {
    var profile = state.profile;
    if (!profile || profile.is_me || state.following) return;
    var wasFollowing = !!profile.followed_by_me;

    // Optimistic on both the button and the count, because those two numbers
    // disagreeing for a second is more jarring than either being briefly
    // wrong. Both roll back together.
    var beforeCount = num(profile.follower_count);
    profile.followed_by_me = !wasFollowing;
    if (beforeCount !== null) {
      profile.follower_count = Math.max(0, beforeCount + (wasFollowing ? -1 : 1));
    }
    state.following = true;
    paintHead();

    try {
      var res = await request("/social/users/" + encodeURIComponent(profile.user_id) + "/follow", {
        method: wasFollowing ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
      });
      var served = res ? num(res.follower_count) : null;
      if (served !== null) profile.follower_count = served;
    } catch (_) {
      profile.followed_by_me = wasFollowing;
      if (beforeCount !== null) profile.follower_count = beforeCount;
    } finally {
      state.following = false;
      paintHead();
    }
  }

  /* ---------------------------------------------------------------- render */

  function paint() {
    paintHead();
    paintGrid();
  }

  function paintHead() {
    if (!nodes.head) return;
    nodes.head.textContent = "";

    if (state.error) {
      nodes.head.appendChild(el("div", "profileNotice profileNoticeError", state.error));
      return;
    }
    var p = state.profile;
    if (!p) {
      nodes.head.appendChild(el("div", "profileNotice",
        state.loading ? "Loading…" : "No profile."));
      return;
    }

    // The handle is the title the shell shows; falling back to the name means
    // a driver with no handle yet does not get a blank header.
    if (nodes.title) nodes.title.textContent = p.handle ? "@" + p.handle : (p.display_name || "Profile");

    var top = el("div", "profileTop");
    var avatar = el("div", "profileAvatar", initials(p.display_name));
    avatar.style.background = avatarColor(p.user_id);
    if (p.avatar_url) {
      var img = el("img", "profileAvatarImg");
      img.src = apiBase() + p.avatar_url;
      img.alt = "";
      img.addEventListener("error", function () { img.remove(); });
      avatar.appendChild(img);
    }
    top.appendChild(avatar);

    var counts = el("div", "profileCounts");
    counts.appendChild(stat(group(p.post_count), "Posts"));
    counts.appendChild(stat(group(p.follower_count), "Followers"));
    top.appendChild(counts);
    nodes.head.appendChild(top);

    nodes.head.appendChild(el("div", "profileName", p.display_name || "Driver"));
    if (p.bio) nodes.head.appendChild(el("div", "profileBio", p.bio));

    // Platforms, vehicle, years driving — the credentials a generic photo app
    // cannot show. Only the ones that exist; an empty chip row is skipped.
    var tags = [];
    if (Array.isArray(p.platforms) && p.platforms.length) tags.push(p.platforms.join(" · "));
    if (p.vehicle_type) tags.push(p.vehicle_type);
    var since = num(p.driving_since_year);
    if (since !== null) tags.push("TLC since " + Math.round(since));
    if (p.city) tags.push(p.city);
    if (tags.length) {
      var row = el("div", "profileTags");
      tags.forEach(function (text) { row.appendChild(el("span", "profileTag", text)); });
      nodes.head.appendChild(row);
    }

    // following_count is served only to the profile's owner: how many people
    // YOU follow is nobody else's business. Saying so out loud is the point --
    // a driver should know which numbers are public.
    var followingCount = num(p.following_count);
    if (p.is_me && followingCount !== null) {
      nodes.head.appendChild(el("div", "profilePrivate",
        "Following " + group(followingCount) + " · only you can see this"));
    }

    var rep = p.reputation || null;
    var repRows = [];
    if (rep) {
      var level = num(rep.level);
      if (level !== null) {
        repRows.push([String(Math.round(level)),
          rep.rank_name ? "Level · " + rep.rank_name : "Level"]);
      }
      var trips = num(rep.trips_logged);
      if (trips !== null) repRows.push([group(trips), "Trips logged"]);
      var miles = num(rep.lifetime_miles);
      if (miles !== null) repRows.push([group(Math.round(miles)), "Miles driven"]);
    }
    if (repRows.length) {
      var card = el("div", "profileRep");
      card.appendChild(el("div", "profileRepHead", "Verified on Joseo"));
      var grid = el("div", "profileRepGrid");
      repRows.forEach(function (pair) {
        var cell = el("div", "profileRepCell");
        cell.appendChild(el("div", "profileRepValue", pair[0]));
        cell.appendChild(el("div", "profileRepLabel", pair[1]));
        grid.appendChild(cell);
      });
      card.appendChild(grid);
      if (rep.title) card.appendChild(el("div", "profileRepTitle", rep.title));
      nodes.head.appendChild(card);
    }

    if (!p.is_me) {
      var follow = el("button", "profileFollow" + (p.followed_by_me ? " on" : ""));
      follow.type = "button";
      follow.setAttribute("data-role", "follow");
      follow.disabled = state.following;
      follow.textContent = state.following
        ? "…"
        : (p.followed_by_me ? "Following" : "Follow");
      follow.setAttribute("aria-pressed", p.followed_by_me ? "true" : "false");
      nodes.head.appendChild(follow);
    }
  }

  function stat(value, label) {
    var wrap = el("div", "profileStat");
    wrap.appendChild(el("div", "profileStatValue", value));
    wrap.appendChild(el("div", "profileStatLabel", label));
    return wrap;
  }

  function paintGrid() {
    if (!nodes.grid) return;
    nodes.grid.textContent = "";
    if (state.error) return;

    if (!state.posts.length) {
      if (state.loading) return;
      nodes.grid.appendChild(el("div", "profileNotice", state.gridError
        ? "Posts could not be loaded."
        : (state.profile && state.profile.is_me
          ? "You have not posted yet."
          : "No posts yet.")));
      return;
    }

    var tiles = el("div", "profileGridTiles");
    state.posts.forEach(function (post) {
      var tile = el("div", "profileTile");
      tile.setAttribute("data-post-id", String(post.id));
      if (post.image_thumb_url || post.image_url) {
        var img = el("img", "profileTileImg");
        img.src = apiBase() + (post.image_thumb_url || post.image_url);
        img.alt = "";
        img.loading = "lazy";
        img.addEventListener("error", function () { img.remove(); });
        tile.appendChild(img);
      } else {
        // A text post still deserves a tile. Showing the words beats showing
        // an empty square, and a grid of empty squares reads as broken images.
        tile.appendChild(el("div", "profileTileText", post.body || ""));
      }
      if (post.zone_name) {
        var chip = el("div", "profileTileChip");
        chip.appendChild(el("span", "profileTileZone", post.zone_name));
        var tone = scoreColor(post.zone_rating);
        if (tone) {
          var badge = el("span", "profileTileScore", String(Math.round(post.zone_rating)));
          badge.style.background = tone.bg;
          badge.style.color = tone.fg;
          chip.appendChild(badge);
        }
        tile.appendChild(chip);
      }
      tiles.appendChild(tile);
    });
    nodes.grid.appendChild(tiles);

    if (state.nextBeforeId) {
      var more = el("button", "profileMore", state.loading ? "Loading…" : "Load more");
      more.type = "button";
      more.disabled = state.loading;
      more.setAttribute("data-role", "more");
      nodes.grid.appendChild(more);
    }
  }

  function onClick(event) {
    var target = event.target;
    if (!target || !target.closest) return;
    if (target.closest('[data-role="follow"]')) { toggleFollow(); return; }
    if (target.closest('[data-role="more"]')) { loadMore(); }
  }

  function render(body) {
    var wrap = el("div", "profileScreen");
    var head = el("div", "profileHead");
    wrap.appendChild(head);
    var grid = el("div", "profileGrid");
    wrap.appendChild(grid);
    body.appendChild(wrap);

    nodes.head = head;
    nodes.grid = grid;
    // The shell owns the title bar; this is the element it renders into.
    nodes.title = document.querySelector(".shellScreenTitle");
    wrap.addEventListener("click", onClick);
    paint();
  }

  function onEnter() {
    // A target set by open() wins; otherwise honour the hash, so a reload
    // comes back to the same driver rather than to yourself.
    if (state.target === null) state.target = hashTarget();
    state.gridError = false;
    writeHash();
    load();
  }

  function onLeave() {
    // Cleared so the next open without a target means "me" rather than
    // whoever was looked at last.
    state.target = null;
    state.profile = null;
    state.posts = [];
    Object.keys(nodes).forEach(function (key) { delete nodes[key]; });
  }

  /** Open a specific driver's profile. Used by the feed and the menu. */
  function open(userId) {
    var id = num(userId);
    state.target = id;
    var shell = window.TeamJoseoShell;
    if (shell && typeof shell.open === "function") shell.open("profile");
    // openScreen calls onEnter FIRST and writes its own "#/profile" after, so
    // the ?u= written during onEnter is stripped every time on this path. Write
    // it again once the shell is done; openScreen is synchronous, so this runs
    // after that. Without it a reload silently swaps whose profile you are on.
    writeHash();
  }

  function install() {
    var shell = window.TeamJoseoShell;
    if (!shell || typeof shell.register !== "function") return false;
    shell.register({
      key: "profile",
      title: "Profile",
      icon: "○",
      group: "You",
      subtitle: "You, and other drivers",
      render: render,
      onEnter: onEnter,
      onLeave: onLeave,
    });
    return true;
  }

  if (!install()) document.addEventListener("DOMContentLoaded", install);

  window.TeamJoseoProfile = {
    _state: state,
    _nodes: nodes,
    open: open,
    load: load,
    loadMore: loadMore,
    toggleFollow: toggleFollow,
    group: group,
    initials: initials,
    scoreColor: scoreColor,
    hashTarget: hashTarget,
    install: install,
  };
})();
