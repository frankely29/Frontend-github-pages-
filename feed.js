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
    // The post whose Delete has been tapped once. See paintPostDelete.
    confirmDelete: null,
  };

  var nodes = {};

  /* ----------------------------------------------------------------- utils */

  function token() {
    try { return localStorage.getItem(LS_TOKEN) || ""; } catch (_) { return ""; }
  }

  /* Reading is free; joining in is not.
   *
   * The server decides this -- the feed reads are open and every write still
   * returns 402 -- and this only stops the app from offering a button that is
   * going to fail. A driver who taps Like and watches the heart come back a
   * second later has been told "no" in the worst possible way.
   */
  function locked() {
    try {
      return !!(window.isFeatureLocked && window.isFeatureLocked());
    } catch (_) {
      return false;
    }
  }

  function subscribe() {
    var paywall = window.TlcPaywallModule;
    if (paywall && typeof paywall.triggerCheckout === "function") paywall.triggerCheckout();
  }

  function subscribeButton(label) {
    var button = el("button", "feedJoinBtn", label || "Subscribe");
    button.type = "button";
    button.setAttribute("data-role", "subscribe");
    return button;
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

  /* The crest and the rank, beside whoever is talking.
   *
   * This line used to read "LVL 445" and nothing else. Two things wrong with
   * that on a driver network. The number is the XP engine's, out of a
   * thousand, while the rank a driver actually has is one of thirty -- so the
   * feed and the Ranks tab disagreed about the same person. And the crest,
   * which is the whole point of having painted thirty of them, was nowhere on
   * the screen a driver spends the most time looking at.
   *
   * The key is the source for both, so the crest and the words can never
   * disagree. No key -- an older payload, a cold progression cache -- and the
   * line is just the name, which is the honest thing to show rather than a
   * number from a scale nobody has been given.
   */
  function appendRankTo(row, person) {
    var key = person && person.rank_icon_key;
    var api = window.TeamJoseoRank;
    if (!key || !api) return;
    var rank = api.fromKey(key);
    if (typeof window.renderRankBadgeIcon === "function") {
      var crest = el("span", "feedRankCrest");
      crest.innerHTML = window.renderRankBadgeIcon(key, { compact: true });
      crest.setAttribute("aria-hidden", "true");
      row.appendChild(crest);
    }
    /* "Wyvern II · 2" -- the name the badge is showing, and where that sits
       on the ladder of thirty. */
    row.appendChild(el("span", "feedLevel", rank.label + " · " + rank.band));
  }

  async function getAuth(path) {
    var runtime = window.FrontendRuntime;
    if (runtime && typeof runtime.getJSONAuth === "function") return runtime.getJSONAuth(path, token());
    if (typeof window.getJSONAuth === "function") return window.getJSONAuth(path, token());
    return request(path, { method: "GET" });
  }

  async function request(path, opts) {
    var t = token();
    /* Object.assign copies whole values, so a caller passing its own headers
     * REPLACED this object rather than adding to it -- and every write here
     * passes { "Content-Type": "application/json" }. Liking a post, replying,
     * and deleting a comment all went out with no Authorization at all, got
     * 401, and signed the driver out. Reads pass no headers, which is why the
     * feed loaded fine and only doing something broke. Merge, do not replace. */
    var init = Object.assign({ mode: "cors" }, opts || {});
    init.headers = Object.assign({}, (opts && opts.headers) || {});
    if (t) init.headers.Authorization = "Bearer " + t;
    var res = await fetch(apiBase() + path, init);
    var text = await res.text();
    if (!res.ok) {
      /* Same signals the rest of the app raises, so an expired session takes
       * the whole app back to the landing page rather than leaving this one
       * screen stuck on an error nobody can act on.
       *
       * Only a request that actually carried the token can prove the token is
       * dead. A 401 on one that went out anonymous is a bug in this file, and
       * tearing the session down for it is how a single dropped header became
       * "liking a post signs you out". */
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

  // Acronyms the server stores lowercase. Without these, VEHICLE_CHOICES
  // "suv" and "ev" render as "Suv" and "Ev", which reads as a typo.
  var UPPER_CHOICES = { suv: "SUV", ev: "EV", tlc: "TLC", fhv: "FHV" };

  /** "black_car" -> "Black car". The server stores keys; a driver reads words. */
  function prettyChoice(value) {
    var key = String(value || "").trim().toLowerCase();
    if (UPPER_CHOICES[key]) return UPPER_CHOICES[key];
    var text = String(value || "").replace(/_/g, " ").trim();
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
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
    avatar.setAttribute("data-role", "author");
    if (num(author.user_id) !== null) avatar.setAttribute("data-user-id", String(author.user_id));
    head.appendChild(avatar);

    var who = el("div", "feedWho");
    // The author block opens their profile. A network whose people are not
    // reachable from their words is a list of announcements.
    who.setAttribute("data-role", "author");
    if (num(author.user_id) !== null) {
      who.setAttribute("data-user-id", String(author.user_id));
      who.setAttribute("role", "button");
      who.setAttribute("tabindex", "0");
    }
    var line1 = el("div", "feedNameRow");
    line1.appendChild(el("span", "feedName", author.display_name || "Driver"));
    appendRankTo(line1, author);
    who.appendChild(line1);

    // Handle, platform, age, city — whichever of them exist. Joined here rather
    // than in the markup so a driver with no handle and no city does not get a
    // row of orphaned separators.
    var meta = [];
    if (author.handle) meta.push("@" + author.handle);
    if (Array.isArray(author.platforms) && author.platforms.length) {
      meta.push(author.platforms.map(prettyChoice).join(" "));
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

    var replies = el("button", "feedReplies");
    replies.type = "button";
    replies.setAttribute("data-role", "replies");
    replies.setAttribute("aria-expanded", "false");
    paintReplies(replies, post);
    actions.appendChild(replies);

    /* Your own post, and only when the plan would let the server agree. The
     * backend takes a delete on require_user, so offering it to a lapsed
     * driver is a button whose only outcome is a 402 -- the same reason Like
     * and Reply go quiet. */
    if (post.mine && !locked()) {
      var del = el("button", "feedPostDelete", "Delete");
      del.type = "button";
      del.setAttribute("data-role", "delete-post");
      del.setAttribute("aria-label", "Delete this post");
      paintPostDelete(del, post);
      actions.appendChild(del);
    }
    card.appendChild(actions);

    // Threads open in place. A separate screen per post would mean losing your
    // place in the feed to read two lines, and coming back to a refetched one.
    var thread = el("div", "feedThread");
    thread.hidden = true;
    thread.setAttribute("data-role", "thread");
    card.appendChild(thread);

    return card;
  }

  /* Deleting a post is two taps, and no window.confirm().
   *
   * A post cannot be undeleted, and the control sits in a row with Like, which
   * a thumb reaches for without looking. A native confirm() in a standalone
   * web app is a system sheet with the site's hostname on it -- it reads like
   * the browser interrupting, not like this app asking -- so the button asks
   * for itself: "Delete" becomes "Sure?" and only the second tap is the one.
   */
  function paintPostDelete(button, post) {
    var armed = String(state.confirmDelete || "") === String(post.id);
    button.textContent = armed ? "Sure?" : "Delete";
    button.classList.toggle("armed", armed);
    button.setAttribute("aria-label", armed
      ? "Tap again to delete this post"
      : "Delete this post");
  }

  function disarmDelete() {
    var armed = state.confirmDelete;
    state.confirmDelete = null;
    if (!armed || !nodes.list || !nodes.list.querySelector) return;
    var card = nodes.list.querySelector('[data-post-id="' + armed + '"]');
    var button = card && card.querySelector
      ? card.querySelector('[data-role="delete-post"]') : null;
    var post = findPost(armed);
    if (button && post) paintPostDelete(button, post);
  }

  async function deletePost(postId, card) {
    var post = findPost(postId);
    if (!post || locked()) return;

    // First tap arms, second deletes. Anything else that repaints the feed
    // disarms it, so a post left armed and scrolled past does not go off
    // under a thumb three minutes later.
    if (String(state.confirmDelete || "") !== String(postId)) {
      state.confirmDelete = String(postId);
      var button = card.querySelector('[data-role="delete-post"]');
      if (button) paintPostDelete(button, post);
      return;
    }
    state.confirmDelete = null;

    try {
      await request("/social/posts/" + encodeURIComponent(postId), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });
      state.items = state.items.filter(function (p) {
        return String(p.id) !== String(postId);
      });
      delete threads[String(postId)];
      state.error = "";
    } catch (err) {
      state.error = err && err.status === 403
        ? "That isn't your post."
        : "Could not delete that post.";
    }
    paintList();
  }

  function paintReplies(button, post) {
    var n = num(post.comment_count) || 0;
    // No count until there is one: "0 replies" invites nothing, an unadorned
    // "Reply" does.
    button.textContent = n ? "Replies " + n : "Reply";
  }

  function paintLike(button, post) {
    var liked = !!post.liked_by_me;
    button.textContent = (liked ? "♥ " : "♡ ") + (num(post.like_count) || 0);
    button.setAttribute("aria-pressed", liked ? "true" : "false");
    button.classList.toggle("on", liked);
    // The count still shows. What a post is worth is part of reading it; only
    // adding to it is behind the plan.
    var off = locked();
    button.disabled = off;
    button.classList.toggle("disabled", off);
    if (off) button.title = "Subscribe to like posts";
    else button.removeAttribute("title");
  }

  /* --------------------------------------------------------------- liking */

  async function toggleLike(postId, button) {
    if (locked()) return;
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


  /* --------------------------------------------------------------- threads */

  // Keyed by post id: { open, loading, items, nextAfterId, error, sending }.
  // Kept out of the post objects so a feed refetch does not blow away an open
  // thread someone is reading.
  var threads = {};

  function threadState(postId) {
    var key = String(postId);
    if (!threads[key]) {
      threads[key] = { open: false, loading: false, items: [], nextAfterId: null,
        error: "", sending: false, loaded: false, replyTo: null };
    }
    return threads[key];
  }

  function findPost(postId) {
    return state.items.filter(function (p) { return String(p.id) === String(postId); })[0] || null;
  }

  async function toggleThread(postId, card) {
    var t = threadState(postId);
    t.open = !t.open;
    paintThread(postId, card);
    /* Opening a thread adds a divider, the replies and a composer to the
     * bottom of a card that was already the last thing above the dock, so the
     * field you just asked for lands underneath the icons. This file does not
     * own the sheet and should not reach for it -- it says what happened and
     * feed-first.js decides what that means, the same way the shell and the
     * drawer already announce themselves. */
    if (t.open) fire("tlc:feed-thread-opened", { postId: postId });
    // Fetched on first open only. Re-fetching every time someone collapses and
    // expands a thread to re-read it is a request per glance.
    if (t.open && !t.loaded && !t.loading) loadThread(postId, card);
  }

  async function loadThread(postId, card, options) {
    var t = threadState(postId);
    var append = !!(options && options.append);
    if (t.loading) return;
    t.loading = true;
    t.error = "";
    paintThread(postId, card);

    var query = "?limit=20";
    if (append && t.nextAfterId) query += "&after_id=" + encodeURIComponent(t.nextAfterId);
    try {
      var data = await getAuth("/social/posts/" + encodeURIComponent(postId) + "/comments" + query);
      var items = (data && data.items) || [];
      t.items = append ? t.items.concat(items) : items;
      t.nextAfterId = (data && data.next_after_id) || null;
      t.loaded = true;
      // The server's count, not the length of what was fetched: a page is 20
      // and a thread can be longer.
      var post = findPost(postId);
      if (post && num(data && data.comment_count) !== null) {
        post.comment_count = num(data.comment_count);
      }
    } catch (err) {
      t.error = err && err.status === 404
        ? "This post is gone."
        : "Could not load replies.";
    } finally {
      t.loading = false;
      paintThread(postId, card);
    }
  }

  function findComment(t, commentId) {
    return t.items.filter(function (c) {
      return String(c.id) === String(commentId);
    })[0] || null;
  }

  /* Point the thread's one composer at a reply, or back at the post.
   *
   * The aim is held on the thread, not on the DOM, so it survives the repaints
   * that a reply landing or a delete cause. It is dropped the moment the
   * comment it names is gone -- paintThread re-checks, so an aim at something
   * someone else deleted does not send a parent_id the server will 404.
   */
  function aimReply(postId, commentId, card) {
    var t = threadState(postId);
    var target = commentId ? findComment(t, commentId) : null;
    if (!commentId || !target) {
      t.replyTo = null;
    } else {
      var author = target.author || {};
      t.replyTo = { id: target.id, name: author.display_name || "Driver" };
    }
    paintThread(postId, card);
    var input = card.querySelector('[data-role="reply-input"]');
    // The tap that aimed it is the gesture, so the keyboard is allowed up.
    if (input && typeof input.focus === "function") {
      try { input.focus(); } catch (_) {}
    }
  }

  async function sendReply(postId, card) {
    if (locked()) return;
    var t = threadState(postId);
    if (t.sending) return;
    var input = card.querySelector('[data-role="reply-input"]');
    var text = String((input && input.value) || "").trim();
    if (!text) return;

    t.sending = true;
    t.error = "";
    paintThread(postId, card);
    try {
      // Re-read rather than trusting what was aimed a minute ago: the comment
      // can have been deleted while the reply was being typed, and a parent_id
      // pointing at nothing is a 404 that loses what they wrote.
      var aimedAt = t.replyTo && findComment(t, t.replyTo.id) ? t.replyTo.id : null;
      var payload = { body: text };
      if (aimedAt) payload.parent_id = aimedAt;
      var data = await request("/social/posts/" + encodeURIComponent(postId) + "/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (data && data.comment) t.items = t.items.concat([data.comment]);
      t.replyTo = null;
      var post = findPost(postId);
      if (post && num(data && data.comment_count) !== null) {
        post.comment_count = num(data.comment_count);
      }
      t.draft = "";
    } catch (err) {
      // The draft is kept and put back into the field below. Making someone
      // retype a reply because the network dropped is unforgivable.
      t.draft = text;
      t.error = err && err.status === 402
        ? "Your trial has ended — start a plan to reply."
        : "Could not post that reply.";
    } finally {
      t.sending = false;
      paintThread(postId, card);
      var button = card.querySelector('[data-role="replies"]');
      var post2 = findPost(postId);
      if (button && post2) paintReplies(button, post2);
      // A reply landing pushes the composer down by its own height, so the
      // field somebody is still typing in walks under the dock. Same signal as
      // opening the thread, for the same reason.
      if (t.open) fire("tlc:feed-thread-opened", { postId: postId });
    }
  }

  async function deleteComment(postId, commentId, card) {
    var t = threadState(postId);
    try {
      var data = await request("/social/comments/" + encodeURIComponent(commentId), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });
      t.items = t.items.filter(function (c) { return String(c.id) !== String(commentId); });
      var post = findPost(postId);
      if (post && num(data && data.comment_count) !== null) {
        post.comment_count = num(data.comment_count);
      }
    } catch (_) {
      t.error = "Could not delete that reply.";
    }
    paintThread(postId, card);
    var button = card.querySelector('[data-role="replies"]');
    var post2 = findPost(postId);
    if (button && post2) paintReplies(button, post2);
  }

  /* Two levels, out of a tree of any depth.
   *
   * The server stores the comment that was actually answered, which can be
   * three or four down. Drawing that as written would indent a phone off its
   * own right edge, so every reply is drawn under its TOP-LEVEL ancestor and
   * the "@name" says which of its neighbours it answered.
   *
   * Ancestors always arrive first -- ids ascend and a thread pages forwards --
   * so walking up cannot run off the end of what is loaded. A reply whose
   * parent was deleted has no ancestor at all and stands as a root, which is
   * where it reads best anyway.
   */
  function threadRoots(items) {
    var byId = {};
    items.forEach(function (c) { byId[String(c.id)] = c; });

    var roots = [];
    var kids = {};
    items.forEach(function (c) {
      var walk = c;
      var guard = 0;
      // A cycle cannot happen through the API -- a parent is always older than
      // its child -- but a loop here would hang the feed, so it is bounded.
      while (walk && walk.parent_id != null && byId[String(walk.parent_id)] && guard < 64) {
        walk = byId[String(walk.parent_id)];
        guard += 1;
      }
      if (!walk || String(walk.id) === String(c.id)) { roots.push(c); return; }
      (kids[String(walk.id)] = kids[String(walk.id)] || []).push(c);
    });

    return roots.map(function (root) {
      return { comment: root, children: kids[String(root.id)] || [] };
    });
  }

  function buildComment(comment, options) {
    var author = comment.author || {};
    var row = el("div", "feedComment" + (options && options.nested ? " feedCommentNested" : ""));
    row.setAttribute("data-comment-id", String(comment.id));

    var avatar = el("div", "feedCommentAvatar", initials(author.display_name));
    avatar.style.background = avatarColor(author.user_id);
    avatar.setAttribute("data-role", "author");
    if (num(author.user_id) !== null) avatar.setAttribute("data-user-id", String(author.user_id));
    row.appendChild(avatar);

    var main = el("div", "feedCommentMain");
    var head = el("div", "feedCommentHead");
    var who = el("span", "feedCommentName", author.display_name || "Driver");
    who.setAttribute("data-role", "author");
    if (num(author.user_id) !== null) who.setAttribute("data-user-id", String(author.user_id));
    head.appendChild(who);
    /* A comment is smaller than a post but it is still someone talking, and
       the crest is the fastest way to know who is worth listening to. */
    appendRankTo(head, author);
    var age = ago(comment.created_at);
    if (age) head.appendChild(el("span", "feedCommentAge", age));
    if (!locked()) {
      var answer = el("button", "feedCommentReply", "Reply");
      answer.type = "button";
      answer.setAttribute("data-role", "reply-to");
      answer.setAttribute("aria-label", "Reply to " + (author.display_name || "this driver"));
      head.appendChild(answer);
    }
    if (comment.can_delete) {
      var del = el("button", "feedCommentDelete", "Delete");
      del.type = "button";
      del.setAttribute("data-role", "delete-comment");
      del.setAttribute("aria-label", "Delete this reply");
      head.appendChild(del);
    }
    main.appendChild(head);
    /* At one indent a reply to a reply and a reply to the post look identical,
     * so the name of whoever was answered is the only thing that says which.
     * It comes from the server rather than being parsed out of the text: a
     * mention typed by hand is a string, this is the actual relation. */
    var answered = comment.reply_to;
    if (answered && answered.display_name) {
      var at = el("div", "feedCommentAnswering");
      var tag = el("span", "feedCommentAnsweringName",
        "@" + (answered.handle || answered.display_name));
      tag.setAttribute("data-role", "author");
      if (num(answered.user_id) !== null) {
        tag.setAttribute("data-user-id", String(answered.user_id));
      }
      at.appendChild(tag);
      main.appendChild(at);
    }
    main.appendChild(el("div", "feedCommentBody", comment.body || ""));
    row.appendChild(main);
    return row;
  }

  function paintThread(postId, card) {
    var host = card.querySelector('[data-role="thread"]');
    if (!host) return;
    var t = threadState(postId);
    var button = card.querySelector('[data-role="replies"]');
    if (button) button.setAttribute("aria-expanded", t.open ? "true" : "false");

    host.hidden = !t.open;
    if (!t.open) return;
    host.textContent = "";

    if (t.loading && !t.items.length) {
      host.appendChild(el("div", "feedThreadNote", "Loading…"));
    }
    threadRoots(t.items).forEach(function (branch) {
      host.appendChild(buildComment(branch.comment));
      branch.children.forEach(function (child) {
        host.appendChild(buildComment(child, { nested: true }));
      });
    });

    if (t.nextAfterId) {
      var more = el("button", "feedThreadMore", t.loading ? "Loading…" : "Earlier replies");
      more.type = "button";
      more.disabled = t.loading;
      more.setAttribute("data-role", "more-replies");
      host.appendChild(more);
    }
    if (!t.loading && !t.items.length && !t.error) {
      host.appendChild(el("div", "feedThreadNote", "No replies yet."));
    }
    if (t.error) host.appendChild(el("div", "feedThreadNote feedThreadError", t.error));

    /* Replies are readable and unwritable.
     *
     * The thread above is all served -- GET /social/posts/{id}/comments is open
     * -- so an unpaid driver reads the whole conversation and is stopped only at
     * the point of adding to it. A disabled text field would be crueller and
     * less clear than saying what it costs.
     */
    if (locked()) {
      var wall = el("div", "feedReplyRow feedReplyLocked");
      wall.appendChild(el("span", "feedReplyLockedLine", "Subscribe to reply."));
      wall.appendChild(subscribeButton("Subscribe"));
      host.appendChild(wall);
      return;
    }

    /* One composer per thread, aimed rather than one per comment.
     *
     * A field under every reply is a dozen fields on screen, a dozen drafts to
     * keep, and on a phone it pushes the conversation off the bottom. Tapping
     * Reply on a comment points the one composer at it and says so, and the
     * line has its own X because the way out of a mis-tap has to be visible. */
    var aimed = t.replyTo && findComment(t, t.replyTo.id) ? t.replyTo : null;
    if (aimed) {
      var aimRow = el("div", "feedReplyAim");
      aimRow.appendChild(el("span", "feedReplyAimLine",
        "Replying to " + (aimed.name || "that reply")));
      var clear = el("button", "feedReplyAimClear", "\u00d7");
      clear.type = "button";
      clear.setAttribute("data-role", "clear-reply-to");
      clear.setAttribute("aria-label", "Reply to the post instead");
      aimRow.appendChild(clear);
      host.appendChild(aimRow);
    }

    var composer = el("div", "feedReplyRow");
    var input = el("input", "feedReplyInput");
    input.type = "text";
    input.setAttribute("data-role", "reply-input");
    input.setAttribute("placeholder", aimed
      ? "Reply to " + (aimed.name || "that reply") + "\u2026"
      : "Reply\u2026");
    input.setAttribute("maxlength", "600");
    input.value = t.draft || "";
    input.disabled = t.sending;
    composer.appendChild(input);
    var send = el("button", "feedReplySend", t.sending ? "…" : "Send");
    send.type = "button";
    send.disabled = t.sending;
    send.setAttribute("data-role", "send-reply");
    composer.appendChild(send);
    host.appendChild(composer);
    // Keystrokes are held on the thread so a repaint mid-typing -- a reply
    // landing, a delete -- does not swallow what is half written.
    input.addEventListener("input", function () { t.draft = input.value || ""; });
    input.addEventListener("keydown", function (e) {
      if (e && e.key === "Enter") { e.preventDefault(); sendReply(postId, card); }
    });
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
    // A rebuilt list is a new list; nothing in it is still half way through a
    // confirmation somebody started before it reloaded.
    state.confirmDelete = null;
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

    state.items.forEach(function (post) {
      var card = buildCard(post);
      nodes.list.appendChild(card);
      // A thread already open stays open across a repaint of the list.
      if (threads[String(post.id)] && threads[String(post.id)].open) {
        paintThread(post.id, card);
      }
    });

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
      pruneThreads();
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

  /** Threads for posts that are no longer on screen are not worth keeping. */
  function pruneThreads() {
    var live = {};
    state.items.forEach(function (p) { live[String(p.id)] = true; });
    Object.keys(threads).forEach(function (key) {
      if (!live[key]) delete threads[key];
    });
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

    // One tap anywhere else puts an armed Delete back to sleep.
    if (state.confirmDelete && !target.closest('[data-role="delete-post"]')) {
      disarmDelete();
    }

    if (target.closest('[data-role="subscribe"]')) { subscribe(); return; }

    var scopeBtn = target.closest("[data-scope]");
    if (scopeBtn) {
      if (scopeBtn.disabled) return;
      setScope(scopeBtn.getAttribute("data-scope"));
      return;
    }

    var authorEl = target.closest('[data-role="author"]');
    if (authorEl) {
      var userId = authorEl.getAttribute("data-user-id");
      // profile.js registers itself; if it is not loaded, a tap does nothing
      // rather than throwing. Better a dead tap than a dead feed.
      if (userId && window.TeamJoseoProfile && typeof window.TeamJoseoProfile.open === "function") {
        window.TeamJoseoProfile.open(userId);
      }
      return;
    }

    var likeBtn = target.closest('[data-role="like"]');
    if (likeBtn) {
      var card = likeBtn.closest("[data-post-id]");
      if (card) toggleLike(card.getAttribute("data-post-id"), likeBtn);
      return;
    }

    var moreBtn = target.closest('[data-role="more"]');
    if (moreBtn) { load({ append: true }); return; }

    var card = target.closest("[data-post-id]");
    if (!card) return;
    var postId = card.getAttribute("data-post-id");

    if (target.closest('[data-role="replies"]')) { toggleThread(postId, card); return; }
    if (target.closest('[data-role="send-reply"]')) { sendReply(postId, card); return; }
    if (target.closest('[data-role="more-replies"]')) {
      loadThread(postId, card, { append: true });
      return;
    }
    if (target.closest('[data-role="delete-post"]')) { deletePost(postId, card); return; }

    var replyTo = target.closest('[data-role="reply-to"]');
    if (replyTo) {
      var answering = replyTo.closest("[data-comment-id]");
      if (answering) aimReply(postId, answering.getAttribute("data-comment-id"), card);
      return;
    }
    if (target.closest('[data-role="clear-reply-to"]')) { aimReply(postId, null, card); return; }

    var del = target.closest('[data-role="delete-comment"]');
    if (del) {
      var row = del.closest("[data-comment-id]");
      if (row) deleteComment(postId, row.getAttribute("data-comment-id"), card);
    }
  }

  /* Following is empty for anyone who cannot follow.
   *
   * It is the default tab, and it is the worst possible first screen for a
   * driver who has just been locked out: an empty list under a heading they
   * have no way to fill. Everyone is the shop window -- other drivers talking
   * about what the map told them -- so that is where they land.
   */
  function normaliseScope() {
    if (locked() && state.scope === "following") state.scope = "everyone";
  }

  function render(body) {
    var wrap = el("div", "feedScreen");
    normaliseScope();

    if (locked()) {
      var join = el("div", "feedJoin");
      // Short on purpose: at 390px the longer version wrapped to four lines and
      // pushed the posts -- the thing they came for -- most of a thumb down.
      join.appendChild(el("span", "feedJoinLine",
        "Reading is free. Subscribe to reply, like and post."));
      join.appendChild(subscribeButton("Subscribe — $8/week"));
      wrap.appendChild(join);
    }

    var scopes = el("div", "feedScopes");
    scopes.setAttribute("role", "group");
    scopes.setAttribute("aria-label", "Which posts");
    SCOPES.forEach(function (scope) {
      var button = el("button", "feedScope", scope.label);
      button.type = "button";
      button.setAttribute("data-scope", scope.key);
      if (scope.key === "following" && locked()) {
        button.disabled = true;
        button.classList.add("disabled");
        button.title = "Subscribe to follow drivers";
      }
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
    normaliseScope();
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
    buildComment: buildComment,
    _threads: threads,
    threadState: threadState,
    toggleThread: toggleThread,
    loadThread: loadThread,
    sendReply: sendReply,
    deleteComment: deleteComment,
    ago: ago,
    initials: initials,
    prettyChoice: prettyChoice,
    scoreColor: scoreColor,
    install: install,
  };
})();
