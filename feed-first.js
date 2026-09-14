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

  /* One line over a blurred card.
   *
   * #mapLockCard explains the lock properly -- Subscribe, a redeem box, Manage
   * subscription -- and is taller than the 30% card it would be explaining, so
   * feed-first.css hides it here and this takes its place. Tapping opens the
   * full map, which is where that card lives and where there is room for it. */
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

  function installCardTap() {
    if (byId("mapCardOpen")) return;
    var button = document.createElement("button");
    button.type = "button";
    button.id = "mapCardOpen";
    button.setAttribute("aria-label", "Open the full map");
    button.addEventListener("click", function () {
      var s = shell();
      if (s && typeof s.close === "function") s.close();
    });
    document.body.appendChild(button);
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
    // The card and the full screen are different sizes and MapLibre measures
    // its container, not the window. Without this the map keeps drawing at
    // whichever size it was when the switch happened.
    if (typeof window.resizeMapToViewport === "function") {
      window.resizeMapToViewport();
      // Once after the layout has actually settled, because the class change
      // and the reflow are not the same frame.
      window.setTimeout(window.resizeMapToViewport, 80);
      window.setTimeout(window.resizeMapToViewport, 400);
    }
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
    installCardTap();
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
    isHome: function () {
      return !!(document.body && document.body.classList.contains("feed-first"));
    },
    _icons: ICONS,
    home: HOME,
  };
})();
