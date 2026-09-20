/**
 * app-shell.js — the navigation layout: a menu, and destinations to reach.
 *
 * The approved design turns the app from "a map with drawers on top of it" into
 * "a map plus somewhere else to go". Three parts:
 *
 *   1. A menu button top-left that opens a list of every destination.
 *   2. Full-screen destinations, each with one obvious way back to the map.
 *   3. The time scrubber hidden from drivers, which is what lets the dock drop
 *      into the space it leaves.
 *
 * WHY THIS IS ITS OWN FILE, with no shared globals:
 *
 * The map lives across app.part2.js .. app.part17.js -- roughly 52,000 lines
 * sharing mutable module-level state, app.part8.js alone being 7,200 lines of
 * chat UI. Adding a navigation layer by editing those is how the map breaks. So
 * this follows the pattern admin.panel.js already uses for admin.users.js and
 * friends: one self-contained module with its own registry, reaching into the
 * existing app through exactly two documented seams --
 *
 *   - existing destinations are opened by CLICKING their dock button, so none
 *     of that logic is reimplemented or even read;
 *   - `window.me` is read for the admin flag, and nothing is written to it.
 *
 * Everything else here is new DOM that the rest of the app does not know about,
 * which means this file can be deleted and the map still works.
 */
(function () {
  "use strict";

  var SCREEN_HOST_ID = "shellScreens";
  var MENU_ID = "shellMenu";
  var STATUS_ID = "shellConditions";

  /* The readings, gathered into one horizontal bar directly under the menu's
   * "Joseo" header, so they appear only while the drawer is open.
   *
   * This bar has moved three times: a stack at the bottom of the drawer, then
   * a strip pinned over the map, now here. The bar itself is the thing that
   * was right -- one line, tendency then online then weather -- so what
   * changes here is only where it hangs, not how it is built.
   *
   * #dayTendencyMeter is built lazily by day-tendency.js the first time it has
   * a reading, so relocateStatus runs again after mount rather than once.
   *
   * #aiAssistantDock is deliberately NOT here. It rendered the same
   * recommendation as the map pill -- same primary and secondary line, the
   * pill's own "why" is rec.secondary || rec.primary -- so the app was showing
   * one answer twice and inviting the driver to wonder which one to believe.
   * The pill is the one that stays; hideDuplicateAssistant() retires the card. */
  var STATUS_NODE_IDS = [
    "dayTendencyMeter",
    "onlineBadge",
    "weatherBadge",
  ];

  function hideDuplicateAssistant() {
    var dock = byId("aiAssistantDock");
    if (!dock || dock.dataset.shellRetired === "1") return;
    dock.dataset.shellRetired = "1";
    dock.hidden = true;
    dock.style.display = "none";
  }

  function relocateStatus() {
    var host = byId(STATUS_ID);
    if (!host) return;
    STATUS_NODE_IDS.forEach(function (id) {
      var node = byId(id);
      if (!node || node.parentNode === host) return;
      // The map versions are fixed-position and carry inline offsets written
      // by their own layout code. Clearing them here means the CSS below is
      // not fighting a style attribute for the rest of the session.
      node.style.left = "";
      node.style.right = "";
      node.style.top = "";
      node.style.bottom = "";
      node.style.width = "";
      node.style.maxWidth = "";
      node.style.transform = "";
      host.appendChild(node);
    });
  }
  var SCRIM_ID = "shellScrim";
  var BUTTON_ID = "shellMenuBtn";

  /** Destinations, in menu order. `dock` routes to an existing panel. */
  var registry = [];
  var current = null;       // key of the open full-screen destination, or null
  var lastFocus = null;

  // ---------------------------------------------------------------- utilities

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function isAdmin() {
    try {
      var me = window.me;
      var flag = me && me.is_admin;
      return flag === true || flag === 1 || flag === "1" || flag === "true";
    } catch (_) {
      return false;
    }
  }

  /* Destinations an unpaid driver does not get.
   *
   * Held here as a list of keys rather than only as a flag on each entry,
   * because every one of these is registered twice -- app-shell.js puts up a
   * placeholder and the real file (chat.js, compose.js, ...) registers over it.
   * A flag set on the placeholder is thrown away by the second registration,
   * silently, and the destination quietly unlocks. The list cannot be dropped
   * that way. `paid: true` on an entry still works, for anything registered
   * later that wants to opt in.
   *
   * The map is not in here: it has its own timed preview and its own class.
   * The feed is not in here either -- reading is free, and feed.js takes away
   * the buttons that write.
   */
  var PAID_KEYS = ["post", "chat", "leaderboard", "games"];

  /* Which dock button belongs to which destination.
   *
   * Two jobs. It answers "is the dock already showing this?", which is what
   * keeps the menu from being a second copy of the row below it; and it is
   * where the menu borrows its artwork from, so the two never drift apart.
   *
   * `entry.dock` says the same thing for most of these, but not for Feed: Feed
   * opens through its own render() and must not take the dock branch of
   * openScreen, while the dock still carries a Feed button.
   *
   * Here rather than as a field on the entry, for the same reason PAID_KEYS is:
   * feed.js, compose.js and profile.js all re-register over app-shell.js's
   * placeholders, and register() REPLACES the entry, so a field set on the
   * placeholder is thrown away by the second registration -- silently, and Feed
   * quietly reappears in the menu. Measured in the browser, which is how this
   * comment exists. Post has no button at all and keeps its text glyph. */
  var DOCK_BUTTON = {
    feed: "dockFeed", chat: "dockChat", music: "dockMusic",
    leaderboard: "dockLeaderboard", map: "dockMap", games: "dockGames",
    colors: "dockColors", modes: "dockModes", profile: "dockProfile",
    admin: "dockAdmin",
  };

  /* The dock's own icon for a destination, or "" if it has no button.
   *
   * Borrowed, not copied: applyDockIconModel() in app.js and ICONS in
   * feed-first.js are where these are drawn, and a second set of the same paths
   * here is a second set to keep in step. The menu inherits its own colour, so
   * they arrive monochrome -- except Colours, whose three discs carry their own
   * fills in both places, which is the point of them. */
  function dockArt(entry) {
    var id = (entry && (entry.dock || DOCK_BUTTON[entry.key])) || "";
    if (!id) return "";
    var button = byId(id);
    var icon = button && button.querySelector && button.querySelector(".dockIcon");
    return (icon && icon.innerHTML) || "";
  }

  function featuresLocked() {
    try {
      return !!(window.isFeatureLocked && window.isFeatureLocked());
    } catch (_) {
      return false;
    }
  }

  function entryIsPaid(entry) {
    if (!entry) return false;
    if (entry.paid === true) return true;
    return PAID_KEYS.indexOf(entry.key) >= 0;
  }

  function entryIsLocked(entry) {
    if (!entryIsPaid(entry)) return false;
    if (isAdmin()) return false;
    return featuresLocked();
  }

  function paywall() {
    return (typeof window !== "undefined" && window.TlcPaywallModule) || null;
  }

  // ------------------------------------------------------------------ registry

  /**
   * register({ key, title, icon, group, dock, render, onEnter, onLeave })
   *
   * `dock` names an existing dock button id: choosing it clicks that button and
   * closes the menu, so today's panels keep working untouched.
   * `render(body)` fills a full-screen destination instead.
   */
  function register(entry) {
    if (!entry || !entry.key) return;
    var existing = registry.findIndex(function (item) { return item.key === entry.key; });
    if (existing >= 0) registry[existing] = entry;
    else registry.push(entry);
    if (byId(MENU_ID)) paintMenu();
  }

  function find(key) {
    return registry.filter(function (item) { return item.key === key; })[0] || null;
  }

  function visibleEntries() {
    return registry.filter(function (item) {
      if (item.adminOnly && !isAdmin()) return false;
      return true;
    });
  }

  // -------------------------------------------------------------------- menu

  function openMenu() {
    var menu = byId(MENU_ID);
    var scrim = byId(SCRIM_ID);
    if (!menu || !scrim) return;
    lastFocus = document.activeElement;
    paintMenu();
    menu.hidden = false;
    scrim.hidden = false;
    // Two frames: the element has to be laid out before the transform can
    // animate from it, or the drawer appears already open.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        menu.classList.add("open");
        scrim.classList.add("open");
      });
    });
    document.body.classList.add("shell-menu-open");
    var first = menu.querySelector(".shellItem");
    if (first && typeof first.focus === "function") first.focus();
  }

  function closeMenu() {
    var menu = byId(MENU_ID);
    var scrim = byId(SCRIM_ID);
    if (!menu || !scrim) return;
    menu.classList.remove("open");
    scrim.classList.remove("open");
    document.body.classList.remove("shell-menu-open");
    window.setTimeout(function () {
      if (!menu.classList.contains("open")) {
        menu.hidden = true;
        scrim.hidden = true;
      }
    }, 220);
    if (lastFocus && typeof lastFocus.focus === "function") {
      try { lastFocus.focus(); } catch (_) {}
    }
    lastFocus = null;
  }

  function menuIsOpen() {
    var menu = byId(MENU_ID);
    return !!(menu && menu.classList.contains("open"));
  }

  /* Does this destination belong in the menu, or does the dock already have it?
   *
   * The two used to list the same eleven things, so the menu was a longer copy
   * of the row below it. The split is: the dock is what you touch while
   * driving, the menu is what you set once and leave.
   *
   * Derived rather than listed. A second hard-coded list of dock keys here
   * would drift away from feed-first.js's the first time either moved, so the
   * question asked is the one that is actually true on screen: is this entry's
   * button sitting in the dock's track right now? Buttons the dock no longer
   * shows live in #dockStash, so they answer no and appear here instead.
   */
  function inMenu(entry) {
    if (!entry) return true;
    var id = entry.dock || DOCK_BUTTON[entry.key];
    if (!id) return true;
    var button = byId(id);
    var track = byId("dockTrack");
    if (!button || !track) return true;
    return button.parentNode !== track;
  }

  /* Three tabs instead of four headings.
   *
   * The menu is settings now, and settings sort into map, account and the rest.
   * Headings spent a third of a short panel saying so; tabs say it in one row
   * and keep the panel the same height whatever is behind them -- which is the
   * whole point of the chosen design: never more than four rows underneath.
   *
   * Listed rather than derived from entry.group because the groups were built
   * for a list of eleven destinations and read oddly across three tabs: Post
   * belongs with Profile under You, not under Network with a Chat that is now
   * in the dock. Anything this list has not heard of lands in More, so a
   * destination added later shows up somewhere rather than vanishing. */
  var MENU_TABS = [
    { id: "map", label: "Map", keys: ["map", "colors", "modes"] },
    { id: "you", label: "You", keys: ["notifications", "profile", "post"] },
    { id: "more", label: "More", keys: ["games", "admin"] },
  ];
  var activeTab = MENU_TABS[0].id;

  function tabFor(key) {
    for (var i = 0; i < MENU_TABS.length; i += 1) {
      if (MENU_TABS[i].keys.indexOf(key) >= 0) return MENU_TABS[i].id;
    }
    return MENU_TABS[MENU_TABS.length - 1].id;
  }

  function paintTabs(menu, counts) {
    var bar = menu.querySelector(".shellTabs");
    if (!bar) return;
    bar.textContent = "";
    MENU_TABS.forEach(function (tab) {
      // A tab with nothing behind it is a dead third of the control. Admin is
      // the usual cause: it is the only thing in More for a driver.
      if (!counts[tab.id]) return;
      var button = el("button", "shellTab", tab.label);
      button.type = "button";
      button.setAttribute("data-shell-tab", tab.id);
      button.setAttribute("role", "tab");
      var on = tab.id === activeTab;
      button.setAttribute("aria-selected", on ? "true" : "false");
      if (on) button.classList.add("on");
      bar.appendChild(button);
    });
  }

  function paintMenu() {
    var menu = byId(MENU_ID);
    var body = menu && menu.querySelector(".shellMenuBody");
    if (!body) return;
    body.textContent = "";

    var listed = visibleEntries().filter(inMenu);
    var counts = {};
    listed.forEach(function (entry) {
      var id = tabFor(entry.key);
      counts[id] = (counts[id] || 0) + 1;
    });
    // The remembered tab can empty out -- Admin leaving takes More with it --
    // and an empty panel under a selected tab looks broken rather than empty.
    if (!counts[activeTab]) {
      activeTab = (MENU_TABS.filter(function (t) { return counts[t.id]; })[0]
        || MENU_TABS[0]).id;
    }
    paintTabs(menu, counts);

    /* Ordered by the tab's own key list rather than by registration, so the
       order written above is the order on screen. Registration order put Post
       above Profile under You because compose.js loads before profile.js,
       which is not a reason for anything. */
    var tab = MENU_TABS.filter(function (t) { return t.id === activeTab; })[0];
    var order = (tab && tab.keys) || [];
    var rank = function (entry) {
      var at = order.indexOf(entry.key);
      return at < 0 ? order.length : at;
    };
    var groups = [{ name: "", items: listed.filter(function (entry) {
      return tabFor(entry.key) === activeTab;
    }).sort(function (a, b) { return rank(a) - rank(b); }) }];

    groups.forEach(function (group) {
      if (group.name) body.appendChild(el("div", "shellGroup", group.name));
      group.items.forEach(function (entry) {
        var item = el("button", "shellItem");
        item.type = "button";
        item.setAttribute("data-shell-key", entry.key);
        if (entry.key === current) item.classList.add("on");

        var icon = el("span", "shellItemIcon");
        icon.setAttribute("aria-hidden", "true");
        var art = dockArt(entry);
        if (art) icon.innerHTML = art;
        else icon.textContent = entry.icon || "•";
        item.appendChild(icon);

        var text = el("span", "shellItemText");
        text.appendChild(el("span", "shellItemTitle", entry.title || entry.key));
        if (entry.subtitle) text.appendChild(el("span", "shellItemSub", entry.subtitle));
        item.appendChild(text);

        if (entry.key === current) {
          item.appendChild(el("span", "shellItemHere", "Here"));
        } else if (entryIsLocked(entry)) {
          // Still listed, still tappable. Hiding these would leave an unpaid
          // driver with a menu that looks like a smaller app rather than a
          // locked one, and nothing to tap to find out what they are missing.
          item.classList.add("locked");
          item.appendChild(el("span", "shellItemLock", "🔒"));
          item.setAttribute("aria-label", (entry.title || entry.key) + " — locked, subscribe to open");
        }
        body.appendChild(item);
      });
    });
  }

  // ------------------------------------------------------------- destinations

  /* What a locked destination shows instead of itself.
   *
   * One panel for all of them, with the destination's own name in it, rather
   * than four bespoke screens: the message is the same every time, and a screen
   * that has to be written per destination is a screen that gets forgotten the
   * next time one is added.
   *
   * Subscribe goes through the paywall module, which already owns the Paddle
   * checkout. There is no second implementation of taking money here.
   */
  function lockPanel(entry) {
    var wrap = el("div", "shellLock");
    wrap.appendChild(el("div", "shellLockMark", "🔒"));
    wrap.appendChild(el("div", "shellLockTitle", (entry.title || entry.key) + " is part of the plan"));
    wrap.appendChild(el("div", "shellLockLine",
      "Your subscription has ended. The feed stays open to read — "
      + "chat, the leaderboard, games and posting come back when you start a plan."));

    var go = el("button", "shellLockBtn", "Subscribe — $8/week");
    go.type = "button";
    go.addEventListener("click", function () {
      if (paywall() && typeof paywall().triggerCheckout === "function") {
        paywall().triggerCheckout();
      }
    });
    wrap.appendChild(go);

    var manage = el("button", "shellLockGhost", "Manage subscription");
    manage.type = "button";
    manage.addEventListener("click", function () {
      if (paywall() && typeof paywall().openPortal === "function") paywall().openPortal();
    });
    wrap.appendChild(manage);

    wrap.appendChild(el("div", "shellLockFine",
      "Already paid on another account? Sign out and back in as that one."));
    return wrap;
  }

  function showLockScreen(key, entry, options) {
    var host = byId(SCREEN_HOST_ID);
    if (!host) return false;
    if (current && current !== key) leaveScreen({ silent: true });
    var title = host.querySelector(".shellScreenTitle");
    var body = host.querySelector(".shellScreenBody");
    if (title) title.textContent = entry.title || key;
    if (body) {
      body.textContent = "";
      body.scrollTop = 0;
      body.appendChild(lockPanel(entry));
    }
    current = key;
    announceScreen();
    host.hidden = false;
    document.body.classList.add("shell-screen-open");
    requestAnimationFrame(function () { host.classList.add("open"); });
    closeMenu();
    // No hash for a lock screen. A bookmark or a reload should not land a
    // driver back on the wall; it should land them where the app works.
    if (options && options.pushHash === true) {
      try { window.location.hash = "#/" + key; } catch (_) {}
    }
    return true;
  }

  /* Which destination is open, said out loud.
   *
   * `current` was a module variable nobody outside could read, so anything that
   * needed to lay out differently per destination had to guess from the hash --
   * which the lock screen deliberately does not set, and which a
   * pushHash:false open does not either. One event, fired wherever `current`
   * changes, and the answer is never stale.
   */
  function announceScreen() {
    try {
      window.dispatchEvent(new CustomEvent("tlc:shell-screen-changed",
        { detail: { key: current } }));
    } catch (_) {}
  }

  function openScreen(key, options) {
    var entry = find(key);
    if (!entry) return false;

    // Before the dock branch, deliberately: chat, the leaderboard and games are
    // dock panels, and clicking their button is what opens them. Checking after
    // would open the panel and then paint over it.
    if (entryIsLocked(entry)) return showLockScreen(key, entry, options);

    if (entry.dock) {
      // An existing panel. Click its button rather than reimplementing it.
      closeMenu();
      var button = byId(entry.dock);
      if (button && typeof button.click === "function") {
        button.click();
        return true;
      }
      return false;
    }
    if (typeof entry.render !== "function") return false;

    var host = byId(SCREEN_HOST_ID);
    if (!host) return false;

    if (current && current !== key) leaveScreen({ silent: true });

    var title = host.querySelector(".shellScreenTitle");
    var body = host.querySelector(".shellScreenBody");
    if (title) title.textContent = entry.title || key;
    if (body) {
      body.textContent = "";
      body.scrollTop = 0;
      try {
        entry.render(body);
      } catch (err) {
        body.appendChild(el("div", "shellEmpty", "This screen could not load."));
        if (window.console && console.warn) console.warn("[shell] render failed:", err);
      }
    }

    current = key;
    announceScreen();
    host.hidden = false;
    document.body.classList.add("shell-screen-open");
    requestAnimationFrame(function () { host.classList.add("open"); });
    closeMenu();

    if (typeof entry.onEnter === "function") {
      try { entry.onEnter(body); } catch (_) {}
    }
    if (!options || options.pushHash !== false) {
      var hash = "#/" + key;
      if (window.location.hash !== hash) {
        try { window.location.hash = hash; } catch (_) {}
      }
    }
    return true;
  }

  function leaveScreen(options) {
    var host = byId(SCREEN_HOST_ID);
    var entry = current ? find(current) : null;
    if (entry && typeof entry.onLeave === "function") {
      try { entry.onLeave(); } catch (_) {}
    }
    current = null;
    announceScreen();
    if (host) {
      host.classList.remove("open");
      window.setTimeout(function () {
        if (!host.classList.contains("open")) host.hidden = true;
      }, 220);
    }
    document.body.classList.remove("shell-screen-open");
    if (!options || !options.silent) {
      if (window.location.hash && window.location.hash.indexOf("#/") === 0) {
        // Replace rather than push, so tapping back once from the map does not
        // walk the driver through every screen they visited.
        try {
          window.history.replaceState(null, "",
            window.location.pathname + window.location.search);
        } catch (_) {
          window.location.hash = "";
        }
      }
    }
  }

  function syncFromHash() {
    var hash = String(window.location.hash || "");
    if (hash.indexOf("#/") !== 0) {
      if (current) leaveScreen({ silent: true });
      return;
    }
    var key = hash.slice(2).split("?")[0];
    if (!key) {
      if (current) leaveScreen({ silent: true });
      return;
    }
    if (key === current) return;
    var entry = find(key);
    // A hash for a dock panel would bounce the driver into a panel on every
    // reload, which is not what a bookmark should do.
    if (!entry || entry.dock) return;
    openScreen(key, { pushHash: false });
  }

  // --------------------------------------------------------- the time machine

  /**
   * The scrubber is an operator tool, not a driver one, and the 38px offset on
   * #dock exists only to clear it. Hiding it for drivers is what earns the dock
   * the extra space -- one body class decides both, so the two builds differ by
   * a class rather than by a layout.
   */
  function applyAdminChrome() {
    var admin = isAdmin();
    document.body.classList.toggle("shell-admin", admin);
    document.body.classList.toggle("shell-no-scrubber", !admin);
    return admin;
  }

  // ------------------------------------------------------------------ mounting

  function buildChrome() {
    if (byId(BUTTON_ID)) return;

    var button = el("button", "shellMenuBtn");
    button.id = BUTTON_ID;
    button.type = "button";
    button.setAttribute("aria-label", "Menu");
    button.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" ' +
      'stroke-width="1.9" stroke-linecap="round"/></svg>';
    button.addEventListener("click", function () {
      if (menuIsOpen()) closeMenu(); else openMenu();
    });
    document.body.appendChild(button);

    var scrim = el("div", "shellScrim");
    scrim.id = SCRIM_ID;
    scrim.hidden = true;
    scrim.addEventListener("click", closeMenu);
    document.body.appendChild(scrim);

    var menu = el("aside", "shellMenu");
    menu.id = MENU_ID;
    menu.hidden = true;
    menu.setAttribute("aria-label", "Destinations");

    var header = el("div", "shellMenuHeader");
    header.appendChild(el("span", "shellMenuTitle", "Joseo"));
    var close = el("button", "shellMenuClose", "✕");
    close.type = "button";
    close.setAttribute("aria-label", "Close menu");
    close.addEventListener("click", closeMenu);
    header.appendChild(close);
    menu.appendChild(header);

    /* The segmented control. Built once and repainted by paintTabs, so the
       element the click listener below delegates to is always the same one. */
    var tabs = el("div", "shellTabs");
    tabs.setAttribute("role", "tablist");
    menu.appendChild(tabs);

    menu.appendChild(el("div", "shellMenuBody"));

    document.body.appendChild(menu);

    // The conditions bar, directly under the header and above the destination
    // list. Inside the drawer, so it is on screen exactly when the drawer is
    // and needs no show/hide logic of its own. Nothing here is rebuilt or
    // duplicated -- relocateStatus() moves the live nodes, so every updater
    // that already holds a reference to them keeps working untouched.
    var status = el("div", "shellConditions");
    status.id = STATUS_ID;
    menu.insertBefore(status, menu.querySelector(".shellMenuBody"));

    // One delegated listener rather than one per item, because the list is
    // repainted whenever a destination registers.
    menu.addEventListener("click", function (event) {
      var target = event.target || null;
      var tab = target && target.closest ? target.closest(".shellTab") : null;
      if (tab) {
        var id = tab.getAttribute("data-shell-tab");
        // Repaint even when it has not changed: cheap, and it keeps the
        // selected state honest if anything else repainted underneath.
        if (id) activeTab = id;
        paintMenu();
        return;
      }
      var item = target && target.closest
        ? target.closest(".shellItem")
        : null;
      if (!item) return;
      var key = item.getAttribute("data-shell-key");
      if (!key) return;
      if (key === "map") {
        /* The dock's Map button does the right thing -- it drops the sheet to
         * its minimised detent and leaves the feed running underneath. This
         * used to call leaveScreen() instead, which CLOSES the shell screen,
         * and closing the shell screen is exactly how the old map-first
         * interface came back. Now that Map is reachable only from here, that
         * bug would have been the only way to hit it. Click the real button. */
        var mapBtn = byId("dockMap");
        if (mapBtn && typeof mapBtn.click === "function") {
          closeMenu();
          mapBtn.click();
          return;
        }
        leaveScreen();
        closeMenu();
        return;
      }
      openScreen(key);
    });

    var host = el("section", "shellScreen");
    host.id = SCREEN_HOST_ID;
    host.hidden = true;
    var bar = el("header", "shellScreenBar");
    var back = el("button", "shellBack");
    back.type = "button";
    back.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path d="M14.5 5.5 8 12l6.5 6.5" fill="none" stroke="currentColor" ' +
      'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      "<span>Map</span>";
    back.addEventListener("click", function () { leaveScreen(); });
    bar.appendChild(back);
    bar.appendChild(el("h2", "shellScreenTitle", ""));
    host.appendChild(bar);
    host.appendChild(el("div", "shellScreenBody"));
    document.body.appendChild(host);

    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return;
      if (menuIsOpen()) { closeMenu(); return; }
      if (current) leaveScreen();
    });

    /* The dock is the other way in.
     *
     * openScreen() covers the menu, but #dockChat and friends are buttons a
     * driver taps directly, and their own handlers live in app.part*.js. This
     * catches the click on the way down -- capture, before those handlers run
     * -- and turns it into the lock screen instead of the panel. Written
     * against the registry rather than a hard-coded list of ids, so a
     * destination that declares itself paid is covered the moment it registers.
     */
    document.addEventListener("click", function (event) {
      if (!featuresLocked() || isAdmin()) return;
      // Walked by id rather than matched by selector. The tap often lands on an
      // icon inside the button, so it has to walk up -- and a compound CSS
      // selector for "a dock button" would be one more thing to get subtly
      // wrong here and in every double that stands in for the DOM.
      var node = event.target || null;
      var entry = null;
      while (node && !entry) {
        if (node.id) {
          entry = registry.filter(function (item) {
            return item.dock === node.id;
          })[0] || null;
        }
        node = node.parentNode || null;
      }
      if (!entry || !entryIsLocked(entry)) return;
      if (typeof event.preventDefault === "function") event.preventDefault();
      if (typeof event.stopPropagation === "function") event.stopPropagation();
      showLockScreen(entry.key, entry);
    }, true);

    window.addEventListener("hashchange", syncFromHash);
  }

  function registerDefaults() {
    register({ key: "map", title: "Map", icon: "◉", group: "" });

    register({
      key: "feed", title: "Feed", icon: "▦", group: "Network",
      subtitle: "Posts from drivers",
      render: function (body) { body.appendChild(emptyState("Feed", "Nothing here yet.")); },
    });
    register({
      key: "post", title: "Post", icon: "＋", group: "Network",
      subtitle: "Share what you see",
      paid: true,
      render: function (body) { body.appendChild(emptyState("Post", "Nothing here yet.")); },
    });
    register({ key: "chat", title: "Chat", icon: "✉︎", group: "Network", dock: "dockChat", paid: true });

    register({ key: "leaderboard", title: "Leaderboard", icon: "⚑", group: "Driving", dock: "dockLeaderboard", paid: true });
    register({ key: "games", title: "Games", icon: "❖", group: "Driving", dock: "dockGames", paid: true });
    register({ key: "music", title: "Music", icon: "♪", group: "Driving", dock: "dockMusic" });

    register({ key: "colors", title: "Colours", icon: "◐", group: "Map", dock: "dockColors" });
    register({ key: "modes", title: "Modes", icon: "⚙︎", group: "Map", dock: "dockModes" });

    register({ key: "profile", title: "Profile", icon: "○", group: "You", dock: "dockProfile" });
    register({ key: "admin", title: "Admin", icon: "⛭", group: "You", dock: "dockAdmin", adminOnly: true });
  }

  /** A destination with nothing in it yet still says what it is. */
  function emptyState(title, line) {
    var wrap = el("div", "shellEmpty");
    wrap.appendChild(el("div", "shellEmptyTitle", title));
    wrap.appendChild(el("div", "shellEmptyLine", line));
    return wrap;
  }

  function mount() {
    if (!document.body) return;
    buildChrome();
    registerDefaults();
    applyAdminChrome();
    paintMenu();
    syncFromHash();
    // Clear the map top now, not on the first menu open -- otherwise the
    // chips a driver is meant to stop seeing are exactly what they see until
    // they happen to open the menu. The retries catch #dayTendencyMeter and
    // the assistant dock, which their own scripts build a beat later.
    relocateStatus();
    hideDuplicateAssistant();
    [400, 1500, 4000].forEach(function (ms) {
      window.setTimeout(function () {
        relocateStatus();
        hideDuplicateAssistant();
      }, ms);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }

  // The admin flag arrives with /me, after this file has already mounted, so
  // the chrome is re-applied whenever auth state changes rather than once.
  window.addEventListener("tlc:auth-state-changed", applyAdminChrome);
  window.addEventListener("tlc:auth-expired", applyAdminChrome);

  /* Access can change while the app is open -- a subscription taken out from
   * the lock panel, a preview running out -- so the menu's locks are repainted
   * rather than decided once at mount. If the driver is standing on a
   * destination that has just locked, they are shown the wall; if it has just
   * unlocked, they are shown the real thing.
   */
  function onLockChanged() {
    paintMenu();
    if (!current) return;
    var entry = find(current);
    if (!entry) return;
    if (!entryIsPaid(entry)) return;
    var key = current;
    // Leave first. A dock destination that has just unlocked opens by clicking
    // its own button, which does nothing about the lock panel still sitting in
    // the screen host on top of it.
    leaveScreen({ silent: true });
    openScreen(key, { pushHash: false });
  }
  window.addEventListener("tlc:feature-lock-changed", onLockChanged);
  window.addEventListener("tlc:auth-state-changed", paintMenu);

  window.TeamJoseoShell = {
    register: register,
    open: openScreen,
    close: leaveScreen,
    openMenu: openMenu,
    closeMenu: closeMenu,
    refreshChrome: applyAdminChrome,
    emptyState: emptyState,
    current: function () { return current; },
    isLocked: function (key) { return entryIsLocked(find(key)); },
    lockedKeys: function () { return PAID_KEYS.slice(); },
    _registry: registry,
  };
})();
