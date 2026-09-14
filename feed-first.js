/**
 * feed-first.js — the feed is the screen, the map is a card on it.
 *
 * Three jobs, and deliberately no fourth:
 *
 *   1. Put Feed and Map into the dock. The dock has always been panels and
 *      actions; under Feed First it carries navigation too, so it needs the
 *      two buttons it never had and an active state it never had either.
 *   2. Hold body.feed-first while the Feed screen is the open destination,
 *      which is what feed-first.css lays out against.
 *   3. Open the Feed on boot, once, for a signed-in driver arriving with no
 *      deep link.
 *
 * What it does NOT do is touch the dock's own behaviour. The sideways slide,
 * the scroll hints and the ten-second auto-recentre on Save all live in
 * app.part6.js and keep working exactly as they do today -- two buttons are
 * appended to the track and that is the whole of the interference. Delete this
 * file and the app is the map-first app again, with a dock of the same width
 * it has now.
 */
(function () {
  "use strict";

  var LS_TOKEN = "community_token_v1";
  var HOME = "feed";
  var booted = false;

  /* Drawn to the set in app.js:1700-1740 -- 24-unit grid, 1.75 stroke, round
   * caps and joins, currentColor so night mode works. The dock never needed
   * either of these because it never navigated. */
  var ICONS = {
    dockFeed: '<svg viewBox="0 0 24 24" width="23" height="23" aria-hidden="true" focusable="false"'
      + ' style="display:block" fill="none" stroke="currentColor" stroke-width="1.75"'
      + ' stroke-linecap="round" stroke-linejoin="round">'
      + '<rect x="3.4" y="4.8" width="17.2" height="14.4" rx="3.2"></rect>'
      + '<path d="M7.2 9.6h9.6M7.2 12.6h9.6M7.2 15.6h5.8"></path></svg>',
    dockMap: '<svg viewBox="0 0 24 24" width="23" height="23" aria-hidden="true" focusable="false"'
      + ' style="display:block" fill="none" stroke="currentColor" stroke-width="1.75"'
      + ' stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M12 20.8c4.1-4.6 6.2-7.9 6.2-10.4a6.2 6.2 0 1 0-12.4 0c0 2.5 2.1 5.8 6.2 10.4z"></path>'
      + '<circle cx="12" cy="10.2" r="2.4"></circle></svg>',
  };

  function byId(id) { return document.getElementById(id); }

  function token() {
    try { return localStorage.getItem(LS_TOKEN) || ""; } catch (_) { return ""; }
  }

  function shell() {
    return (typeof window !== "undefined" && window.TeamJoseoShell) || null;
  }

  function openKey() {
    var s = shell();
    if (!s || typeof s.current !== "function") return null;
    return s.current();
  }

  /* ------------------------------------------------------------ the dock */

  function makeDockButton(id, label) {
    var button = document.createElement("button");
    button.type = "button";
    button.id = id;
    // dockBtnMain is the 56px size the other navigable panels use. A 46px
    // navigation button next to 56px panel buttons reads as less important
    // than Colours, which it very much is not.
    button.className = "dockBtn dockBtnMain";
    button.setAttribute("aria-label", label);
    var icon = document.createElement("span");
    icon.className = "dockIcon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = ICONS[id] || "";
    icon.style.fontSize = "0";
    icon.style.display = "inline-grid";
    icon.style.placeItems = "center";
    icon.style.lineHeight = "1";
    button.appendChild(icon);
    return button;
  }

  function installDockButtons() {
    var track = byId("dockTrack");
    if (!track || byId("dockFeed")) return;

    var feed = makeDockButton("dockFeed", "Feed");
    var map = makeDockButton("dockMap", "Map");

    // Immediately left of Save, because the dock re-centres itself on Save
    // after ten seconds of no interaction. Anywhere else and the two buttons a
    // driver navigates with would drift off the edge on their own.
    var save = byId("pickupFab");
    if (save && save.parentNode === track) {
      track.insertBefore(feed, save);
      track.insertBefore(map, save);
    } else {
      track.appendChild(feed);
      track.appendChild(map);
    }

    feed.addEventListener("click", function () {
      var s = shell();
      if (s && typeof s.open === "function") s.open(HOME);
    });
    map.addEventListener("click", function () {
      var s = shell();
      if (s && typeof s.close === "function") s.close();
    });
  }

  /* ------------------------------------------------------------ the card */

  /* One line over a blurred map.
   *
   * #mapLockCard explains the lock properly -- Subscribe, a redeem box, Manage
   * subscription -- and is fixed at 50%/50%, which with the sheet up is behind
   * it. feed-first.css hides it here and this rides the seam instead. Tapping
   * opens the map screen, where that card lives and has room. */
  function installCardLock() {
    if (byId("mapCardLocked")) return;
    var button = document.createElement("button");
    button.type = "button";
    button.id = "mapCardLocked";
    button.textContent = "\uD83D\uDD12 Map locked \u2014 tap to see plans";
    button.setAttribute("aria-label", "The map is locked. Tap to see plans.");
    button.addEventListener("click", function () {
      var s = shell();
      if (s && typeof s.close === "function") s.close();
    });
    document.body.appendChild(button);
  }

  /* ------------------------------------------------------------ the sheet
   *
   * Two detents and free dragging between them. The map behind never changes
   * size -- the sheet slides over it -- so there is no resize on any frame of
   * a drag, which is what makes this cheap enough to follow a finger exactly.
   *
   * EXPANDED is 39% rather than the 28% that was drawn: the approved sheet was
   * 72% of the screen and is 15% shorter than that here, which is 61%, which
   * starts at 39%.
   */
  var EXPANDED = 0.39;
  var MINIMIZED = 0.66;
  var LS_HINTS = "tj_sheet_hints_v1";
  var HINTS_UNTIL = 3;

  /* Minimised is where it opens.
   *
   * The map is what a driver opens this app for; the feed is what they look at
   * while they wait. Starting expanded put two thirds of the reason they came
   * behind two thirds of the reason they stayed. The arrow points up from
   * here, so the first thing the hint teaches is "pull this up for more". */
  var split = MINIMIZED;
  var dragging = null;

  function vh() {
    return Math.max(1, window.innerHeight || 800);
  }

  function hintsUsed() {
    try { return Number(localStorage.getItem(LS_HINTS) || 0) || 0; } catch (_) { return 0; }
  }

  function noteUse() {
    try { localStorage.setItem(LS_HINTS, String(hintsUsed() + 1)); } catch (_) {}
    paintHint();
  }

  /* A hint that never goes away has stopped being a hint. */
  function paintHint() {
    var handle = byId("tjSheetHandle");
    if (!handle) return;
    handle.classList.toggle("tj-hint", hintsUsed() < HINTS_UNTIL);
  }

  function paintSplit() {
    if (!document.body) return;
    document.body.style.setProperty("--tj-split", (split * 100).toFixed(2) + "%");
    var min = split > (EXPANDED + MINIMIZED) / 2;
    document.body.classList.toggle("tj-min", min);
    var handle = byId("tjSheetHandle");
    if (handle) {
      handle.setAttribute("aria-expanded", min ? "false" : "true");
      handle.setAttribute("aria-label", min ? "Show more posts" : "Show more map");
    }
  }

  function setSplit(next, options) {
    split = Math.min(0.92, Math.max(0.16, next));
    paintSplit();
    if (options && options.remember) {
      try { localStorage.setItem("tj_sheet_split_v1", String(split)); } catch (_) {}
    }
  }

  function snap(options) {
    var mid = (EXPANDED + MINIMIZED) / 2;
    setSplit(split > mid ? MINIMIZED : EXPANDED, { remember: true });
    if (options && options.used) noteUse();
  }

  function toggle() {
    var mid = (EXPANDED + MINIMIZED) / 2;
    setSplit(split > mid ? EXPANDED : MINIMIZED, { remember: true });
    noteUse();
  }

  function restoreSplit() {
    var saved = null;
    try { saved = localStorage.getItem("tj_sheet_split_v1"); } catch (_) {}
    var n = Number(saved);
    setSplit(Number.isFinite(n) && n > 0 ? n : MINIMIZED);
  }

  function onDown(event) {
    if (!event || (event.button !== undefined && event.button !== 0)) return;
    dragging = { y: event.clientY, from: split, moved: false };
    document.body.classList.add("tj-dragging");
    var handle = byId("tjSheetHandle");
    if (handle && typeof handle.setPointerCapture === "function" && event.pointerId !== undefined) {
      try { handle.setPointerCapture(event.pointerId); } catch (_) {}
    }
  }

  function onMove(event) {
    if (!dragging) return;
    var dy = event.clientY - dragging.y;
    // Four pixels of slop, so a tap that wobbles is still a tap.
    if (Math.abs(dy) > 4) dragging.moved = true;
    setSplit(dragging.from + dy / vh());
    if (event.preventDefault) event.preventDefault();
  }

  function onUp() {
    if (!dragging) return;
    var moved = dragging.moved;
    dragging = null;
    document.body.classList.remove("tj-dragging");
    if (moved) snap({ used: true });
    else toggle();
  }

  function installHandle() {
    if (byId("tjSheetHandle")) return;
    var handle = document.createElement("button");
    handle.type = "button";
    handle.id = "tjSheetHandle";
    handle.setAttribute("aria-controls", "shellScreens");

    var grab = document.createElement("span");
    grab.className = "tjGrab";
    grab.setAttribute("aria-hidden", "true");
    handle.appendChild(grab);

    var arrow = document.createElement("span");
    arrow.className = "tjArrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none"'
      + ' stroke="currentColor" stroke-width="2.6" stroke-linecap="round"'
      + ' stroke-linejoin="round" style="display:block">'
      + '<path d="m6 9.5 6 6 6-6"></path></svg>';
    handle.appendChild(arrow);

    handle.addEventListener("pointerdown", onDown);
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
    // Keyboard: the arrows do what the drag does.
    handle.addEventListener("keydown", function (event) {
      if (!event) return;
      if (event.key === "ArrowUp") { setSplit(EXPANDED, { remember: true }); noteUse(); }
      else if (event.key === "ArrowDown") { setSplit(MINIMIZED, { remember: true }); noteUse(); }
      else return;
      event.preventDefault();
    });

    document.body.appendChild(handle);
    restoreSplit();
    paintHint();
  }

  /* ----------------------------------------------------------- the state */

  function apply() {
    if (!document.body) return;
    var home = openKey() === HOME;
    var was = document.body.classList.contains("feed-first");
    document.body.classList.toggle("feed-first", home);

    var feed = byId("dockFeed");
    var map = byId("dockMap");
    if (feed) feed.classList.toggle("on", home);
    // Map is "where you are" only when nothing is covering it.
    if (map) map.classList.toggle("on", !openKey());

    if (home === was) return;
    paintSplit();
    paintHint();
    /* Deliberately no map resize.
     *
     * The map is full bleed in both states -- the sheet slides over it rather
     * than shrinking it -- so its container never changes and MapLibre has
     * nothing to re-measure. That is what makes dragging cheap enough to
     * follow a finger: the alternative, a card that grows and shrinks, re-lays
     * out and re-renders the whole map on every frame of the gesture. */
  }

  /* Land on the feed, once.
   *
   * Only for a signed-in driver, and only when they arrived without a deep
   * link -- a bookmark to #/chat has to win, and a signed-out visitor is
   * looking at the welcome page with nothing of theirs to show. */
  function openHomeOnce() {
    if (booted) return;
    if (!token()) return;
    if (String(window.location.hash || "").indexOf("#/") === 0) { booted = true; return; }
    var s = shell();
    if (!s || typeof s.open !== "function") return;
    booted = true;
    s.open(HOME);
  }

  function mount() {
    if (!document.body) return;
    installDockButtons();
    installHandle();
    installCardLock();
    apply();
    openHomeOnce();

    window.addEventListener("tlc:shell-screen-changed", apply);
    // The dock is built by index.html but the shell registers over it at
    // DOMContentLoaded, and /me arrives later still; re-running is free.
    window.addEventListener("tlc:auth-state-changed", function () {
      installDockButtons();
      openHomeOnce();
      apply();
    });
    [300, 1200, 3000].forEach(function (ms) {
      window.setTimeout(function () { installDockButtons(); openHomeOnce(); apply(); }, ms);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }

  window.TeamJoseoFeedFirst = {
    apply: apply,
    installDockButtons: installDockButtons,
    installHandle: installHandle,
    setSplit: setSplit,
    toggle: toggle,
    snap: snap,
    split: function () { return split; },
    detents: { expanded: EXPANDED, minimized: MINIMIZED },
    isHome: function () {
      return !!(document.body && document.body.classList.contains("feed-first"));
    },
    _icons: ICONS,
    home: HOME,
  };
})();
