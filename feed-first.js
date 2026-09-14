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

  /* Everything that can BE the sheet.
   *
   * #dockDrawer holds the seven swap-in panels, but two dock buttons never
   * used it: Profile opens .driverProfileSheet inside #driverProfileModalRoot,
   * and Admin opens .adminPanel inside .adminPortal. Both are their own
   * fixed-position containers with their own z-index and their own backdrop,
   * which is why they still looked like the old app while everything else had
   * moved into the sheet.
   *
   * They are the same shape -- a flex column with a header and a scrolling
   * body -- so they get the same geometry, and this list is what the rest of
   * the file asks "is the sheet up, and who is in it".
   */
  var HOSTS = [
    { sel: "#dockDrawer" },
    { sel: "#driverProfileModalRoot",
      close: function () {
        try { if (typeof window.closeDriverProfileModal === "function") window.closeDriverProfileModal(); } catch (_) {}
      } },
    { sel: ".adminPortal",
      close: function () {
        try { if (window.AdminPortal && typeof window.AdminPortal.close === "function") window.AdminPortal.close(); } catch (_) {}
      } },
  ];

  function hostNode(host) {
    try { return document.querySelector(host.sel); } catch (_) { return null; }
  }

  function openHost() {
    for (var i = 0; i < HOSTS.length; i += 1) {
      var node = hostNode(HOSTS[i]);
      if (node && node.classList && node.classList.contains("open")) return HOSTS[i];
    }
    return null;
  }

  /* One occupant. Opening any host closes the others -- they are all at the
   * same layer now, so two open at once is one sitting on top of the other. */
  function closeOtherHosts(keep) {
    HOSTS.forEach(function (host) {
      if (host === keep) return;
      var node = hostNode(host);
      if (!node || !node.classList || !node.classList.contains("open")) return;
      if (typeof host.close === "function") host.close();
      else closeDrawer();
    });
  }

  /* The other thing that can be the sheet.
   *
   * Chat, the leaderboard, games, music, colours, modes and profile all share
   * one container -- #dockDrawer -- with their content swapped into it. Under
   * Feed First it wears the same geometry as the feed's screen, so "is the
   * sheet up" is a question about either of them. */
  function drawerOpen() {
    return !!openHost();
  }

  /* Who is in the sheet: the feed, something else, or nobody.
   *
   * The feed is the one a driver lives on, so it opens where they left it --
   * minimised by default, because the map is what they came for. Everything
   * else is something they went looking for, so it opens expanded: nobody taps
   * Chat wanting a third of Chat. */
  function occupant() {
    if (drawerOpen()) return "panel";
    var key = openKey();
    if (!key) return null;
    return key === HOME ? "feed" : "panel";
  }

  function closeDrawer() {
    if (!drawerOpen()) return false;
    // Through its own close button rather than a private function: closeDrawer
    // in app.js is not exported, and the button does the whole teardown --
    // chat polling, the auto-minimise timer, the keyboard mode.
    var close = byId("dockDrawerClose");
    if (close && typeof close.click === "function") { close.click(); return true; }
    return false;
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
      closeOtherHosts(null);
      var s = shell();
      if (s && typeof s.open === "function") s.open(HOME);
    });
    map.addEventListener("click", function () {
      // Asking for the map means the sheet stays down. Without this flag,
      // closing the panel on the way out would be read as "nothing is in the
      // sheet" and put the feed straight back up.
      goingToMap = true;
      closeOtherHosts(null);
      var s = shell();
      if (s && typeof s.close === "function") s.close();
      window.setTimeout(function () { goingToMap = false; }, 400);
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
  /* MINIMIZED was 66%, which put the sheet's top edge at 631pt on a 956pt
   * screen. The dock's top edge is at 862, so the feed had 231pt to work in:
   * 42 for the handle, ~44 for the scope chips, and a post card is ~180. The
   * card's own bottom row -- the like and Reply buttons -- landed at 875, 13pt
   * under the dock. Measured off a screenshot, reported as "some of the feed
   * box is covered by the icons".
   *
   * 60% puts the top edge at 574 and the first card's last row at ~834, 28pt
   * clear of the dock -- and those 28pt show the top sliver of the next card,
   * which is the affordance that says the list keeps going. */
  var MINIMIZED = 0.6;
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

  /* ------------------------------------------------- the keyboard, and the gap
   *
   * Two separate measurements, both of which move the bottom of the sheet.
   *
   * THE KEYBOARD. A position: fixed sheet is anchored to the LAYOUT viewport,
   * which the keyboard does not change -- so the composer stays where it was
   * and the keyboard covers it. iOS then scrolls the whole document to reveal
   * the focused input, which is what tore the layout apart: the header went off
   * the top and a band of nothing appeared above the keyboard. Anchoring the
   * sheet to the keyboard instead, and undoing that scroll, keeps it whole.
   *
   * THE GAP. On this phone every bottom-anchored thing sits ~62pt above the
   * physical bottom of the screen, because in a standalone web app the layout
   * viewport comes out one status bar shorter than the screen it is painted
   * on. Nothing in CSS can see that; window.innerHeight against screen.height
   * can. Guarded hard -- standalone only, portrait only, and only a band in a
   * plausible range -- so anywhere it does not apply it measures zero and
   * changes nothing.
   */
  /* How tall the keyboard is, and how far iOS has slid the window down to
   * reveal the field under it. They are two different numbers and the first
   * cut of this conflated them.
   *
   * The layout viewport keeps its height when the keyboard opens; the VISUAL
   * viewport is the part of it still on screen. When the focused field is near
   * the bottom, iOS does not scroll the document -- it slides the visual
   * viewport down inside the layout one, which is visualViewport.offsetTop.
   *
   * Subtracting offsetTop as well, as this did, cancels the keyboard out
   * exactly when the slide is largest: a field at the bottom of the sheet read
   * a keyboard height of about zero, tj-kb-up never turned on, the dock stayed
   * on screen over the keyboard and the sheet's own header was left above the
   * top of the window. That is the photo.
   */
  function keyboardInset() {
    var vv = window.visualViewport;
    if (!vv) return 0;
    var inset = Math.round((window.innerHeight || 0) - (Number(vv.height) || 0));
    // Under about 60px it is a toolbar or a rounding artefact, not a keyboard.
    return inset > 60 ? inset : 0;
  }

  /** How far the window has been slid down inside the layout viewport. */
  function viewportShift() {
    var vv = window.visualViewport;
    if (!vv) return 0;
    var top = Math.round(Number(vv.offsetTop) || 0);
    return top > 0 ? top : 0;
  }

  /* --tj-vgap is gone, and this is why.
   *
   * After the keyboard closes, iOS leaves a standalone web view about 62pt
   * shorter than the screen it is painted in. That was measured correctly.
   * What was wrong was the conclusion: everything anchored to the bottom was
   * given a NEGATIVE offset to reach past the viewport edge, and a fixed
   * element cannot be painted outside the viewport -- it is clipped there.
   *
   * The photo shows exactly that. The Save button is 68pt tall and 28pt of it
   * survives; the round buttons are 53 and 21 survives. Both cut at the same
   * line, 62pt up. The compensation did not fill the strip, it sawed the dock
   * in half.
   *
   * The strip is the canvas behind the viewport, and the only thing that
   * paints there is the root background. So feed-first.css gives the canvas
   * the sheet's own colour and the strip stops existing to look at. */
  function paintViewport() {
    if (!document.body) return;
    var kb = keyboardInset();
    document.body.style.setProperty("--tj-kb", kb + "px");
    document.body.style.setProperty("--tj-vtop", (kb > 0 ? viewportShift() : 0) + "px");
    document.body.classList.toggle("tj-kb-up", kb > 0);
    // iOS also scrolls the document itself when it can. With the sheet
    // following the keyboard there is nothing down there to reveal.
    if (kb > 0 && (window.scrollY || window.pageYOffset)) {
      try { window.scrollTo(0, 0); } catch (_) {}
    }
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
    // Nothing is persisted. The feed opens minimised and a panel opens
    // expanded, so a stored split would only ever fight one of them.
  }

  /* Scroll the open thread's last row up past the dock.
   *
   * The dock floats over the sheet rather than sitting under it, so the feed's
   * own bottom edge is not the line that matters -- the dock's top edge is.
   * Measure it rather than guessing: the dock's offset and height have both
   * moved twice this week.
   */
  function revealComposer(postId) {
    var body = document.querySelector("#shellScreens .shellScreenBody");
    // The card that was opened, not the first open thread on the screen.
    var card = postId === undefined || postId === null
      ? null
      : document.querySelector('#shellScreens [data-post-id="' + String(postId) + '"]');
    var scope = card || document.getElementById("shellScreens");
    var rows = scope && scope.querySelectorAll
      ? scope.querySelectorAll(".feedReplyRow, .feedThreadNote")
      : null;
    var row = rows && rows.length ? rows[rows.length - 1] : null;
    if (!body || !row || !row.getBoundingClientRect || !body.getBoundingClientRect) return;
    var dock = document.getElementById("dock");
    var box = row.getBoundingClientRect();
    var floor = body.getBoundingClientRect().bottom;
    if (dock && dock.getBoundingClientRect) {
      var dockBox = dock.getBoundingClientRect();
      // Only when it is actually over the sheet -- it is hidden under the
      // keyboard, and a hidden dock has a zero box.
      if (dockBox.height > 0 && dockBox.top < floor) floor = dockBox.top;
    }
    var over = box.bottom - (floor - 12);
    if (over > 0) body.scrollTop = (body.scrollTop || 0) + over;
  }

  function snap(options) {
    var mid = (EXPANDED + MINIMIZED) / 2;
    setSplit(split > mid ? MINIMIZED : EXPANDED);
    if (options && options.used) noteUse();
  }

  function toggle() {
    var mid = (EXPANDED + MINIMIZED) / 2;
    setSplit(split > mid ? EXPANDED : MINIMIZED);
    noteUse();
  }

  /* The feed always opens minimised.
   *
   * It used to reopen wherever it was last left, which meant a driver who had
   * pulled it up once got a two-thirds-covered map every time they came back
   * to it. Entering the map is the moment you want the map. Dragging still
   * works and still holds while you are there -- it just does not persist. */
  function feedSplit() {
    return MINIMIZED;
  }

  function restoreSplit() {
    setSplit(feedSplit());
  }

  /* Open where this occupant belongs.
   *
   * Only on a change of occupant, never on every repaint -- otherwise a driver
   * who has just dragged the sheet somewhere would be snapped back by the next
   * /me refresh. */
  var lastOccupant = null;
  function splitForOccupant() {
    var who = occupant();
    if (who === lastOccupant) return;
    lastOccupant = who;
    if (who === "panel") setSplit(EXPANDED);
    else if (who === "feed") setSplit(feedSplit());
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
      if (event.key === "ArrowUp") { setSplit(EXPANDED); noteUse(); }
      else if (event.key === "ArrowDown") { setSplit(MINIMIZED); noteUse(); }
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
    /* The sheet is up for any destination, not just the feed.
     *
     * It used to be feed-only, which meant tapping Chat left the sheet layout
     * behind and put a floating card back on the screen -- the two-widget look
     * this whole design exists to get rid of. */
    var home = !!openKey() || drawerOpen();
    var was = document.body.classList.contains("feed-first");
    document.body.classList.toggle("feed-first", home);

    var feed = byId("dockFeed");
    var map = byId("dockMap");
    // Feed is "where you are" only when the feed is what is in the sheet --
    // not whenever the sheet happens to be up.
    if (feed) feed.classList.toggle("on", openKey() === HOME && !drawerOpen());
    // And the map only when nothing is covering it at all.
    if (map) map.classList.toggle("on", !openKey() && !drawerOpen());

    splitForOccupant();
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

  /* One occupant, enforced from wherever the change came from.
   *
   * This used to live inside the tlc:drawer-changed listener, so it only ran
   * for the seven swap-in panels. Profile fires nothing -- it is opened
   * straight from app.part5.js -- so it appeared with the feed still open, and
   * since both sit at z-index 9200 the feed, appended later, painted on top.
   * Profile was open, correctly positioned and completely invisible.
   */
  var goingToMap = false;
  function enforceSingleOccupant() {
    var host = openHost();
    var s = shell();
    if (host) {
      closeOtherHosts(host);
      if (openKey() && s && typeof s.close === "function") s.close();
      return;
    }
    // Nothing is in the sheet: back to the feed, unless the driver asked for
    // the bare map.
    if (goingToMap) return;
    if (!openKey() && s && typeof s.open === "function") s.open(HOME);
  }

  var linked = [];
  function linkHosts() {
    if (typeof window.MutationObserver !== "function") return;
    HOSTS.forEach(function (host) {
      var node = hostNode(host);
      if (!node || linked.indexOf(node) >= 0) return;
      linked.push(node);
      var observer = new window.MutationObserver(function () {
        enforceSingleOccupant();
        apply();
      });
      observer.observe(node, { attributes: true, attributeFilter: ["class"] });
    });
  }

  function mount() {
    if (!document.body) return;
    installDockButtons();
    installHandle();
    installCardLock();
    apply();
    openHomeOnce();

    linkHosts();
    paintViewport();
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", paintViewport);
      window.visualViewport.addEventListener("scroll", paintViewport);
    }
    window.addEventListener("resize", paintViewport);
    window.addEventListener("orientationchange", function () {
      window.setTimeout(paintViewport, 250);
    });
    window.addEventListener("tlc:shell-screen-changed", apply);

    /* The drawer announces itself; the other two do not.
     *
     * Profile and Admin are opened by code in app.part5.js and a lazily loaded
     * admin module, and neither fires anything. Watching the one attribute
     * that changes -- `open` on their root -- is cheaper than reaching into
     * either of them, and it cannot miss a path that opens them some other
     * way. The roots are built lazily, so linking is retried rather than done
     * once. */
    document.addEventListener("click", function (event) {
      var hit = event && event.target && event.target.closest
        ? event.target.closest("#dockProfile, #dockAdmin") : null;
      if (!hit) return;
      window.setTimeout(function () { linkHosts(); apply(); }, 60);
      window.setTimeout(function () { linkHosts(); apply(); }, 400);
    }, true);

    /* One sheet, one occupant.
     *
     * The feed screen and the drawer are different elements at the same layer,
     * so with both open the feed sat on top of the panel a driver had just
     * asked for. Opening a panel leaves the feed; closing one goes back to it.
     * That is what "the feed changes to the chat box" has to mean. */
    window.addEventListener("tlc:drawer-changed", function () {
      enforceSingleOccupant();
      apply();
    });
    /* Replying needs the sheet up.
     *
     * Opening a thread grows the card by a divider, the replies and a
     * composer, onto the bottom of a card that was already the last thing
     * above the dock -- so the field a driver just asked for opened
     * underneath the icons. Reported as "it expands down behind the icons".
     *
     * Moving the minimised detent up far enough to fit a composer would take
     * half the map for a case that lasts as long as one reply, and would fail
     * again the moment a thread has three of them in it. The sheet already has
     * an expanded detent; this is what it is for. */
    window.addEventListener("tlc:feed-thread-opened", function (event) {
      var postId = event && event.detail ? event.detail.postId : null;
      setSplit(EXPANDED);
      noteUse();
      // The thread is fetched after it opens, so the composer moves once more
      // when the replies land. Three passes: after the layout, after the
      // sheet's 260ms transition, and after a slow round trip.
      [80, 320, 1100].forEach(function (ms) {
        window.setTimeout(function () { revealComposer(postId); }, ms);
      });
    });
    // The dock is built by index.html but the shell registers over it at
    // DOMContentLoaded, and /me arrives later still; re-running is free.
    window.addEventListener("tlc:auth-state-changed", function () {
      installDockButtons();
      openHomeOnce();
      apply();
    });
    [300, 1200, 3000].forEach(function (ms) {
      window.setTimeout(function () {
        installDockButtons(); linkHosts(); openHomeOnce(); apply();
      }, ms);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }

  window.TeamJoseoFeedFirst = {
    apply: apply,
    paintViewport: paintViewport,
    keyboardInset: keyboardInset,
    viewportShift: viewportShift,
    installDockButtons: installDockButtons,
    installHandle: installHandle,
    setSplit: setSplit,
    toggle: toggle,
    snap: snap,
    revealComposer: revealComposer,
    split: function () { return split; },
    detents: { expanded: EXPANDED, minimized: MINIMIZED },
    isHome: function () {
      return !!(document.body && document.body.classList.contains("feed-first"));
    },
    _icons: ICONS,
    home: HOME,
  };
})();
