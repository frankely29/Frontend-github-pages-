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

  function paintMenu() {
    var body = byId(MENU_ID) && byId(MENU_ID).querySelector(".shellMenuBody");
    if (!body) return;
    body.textContent = "";

    var groups = [];
    visibleEntries().forEach(function (entry) {
      var name = entry.group || "";
      var bucket = groups.filter(function (g) { return g.name === name; })[0];
      if (!bucket) {
        bucket = { name: name, items: [] };
        groups.push(bucket);
      }
      bucket.items.push(entry);
    });

    groups.forEach(function (group) {
      if (group.name) body.appendChild(el("div", "shellGroup", group.name));
      group.items.forEach(function (entry) {
        var item = el("button", "shellItem");
        item.type = "button";
        item.setAttribute("data-shell-key", entry.key);
        if (entry.key === current) item.classList.add("on");

        var icon = el("span", "shellItemIcon");
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = entry.icon || "•";
        item.appendChild(icon);

        var text = el("span", "shellItemText");
        text.appendChild(el("span", "shellItemTitle", entry.title || entry.key));
        if (entry.subtitle) text.appendChild(el("span", "shellItemSub", entry.subtitle));
        item.appendChild(text);

        if (entry.key === current) {
          item.appendChild(el("span", "shellItemHere", "Here"));
        }
        body.appendChild(item);
      });
    });
  }

  // ------------------------------------------------------------- destinations

  function openScreen(key, options) {
    var entry = find(key);
    if (!entry) return false;

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
    menu.appendChild(el("div", "shellMenuBody"));
    document.body.appendChild(menu);

    // One delegated listener rather than one per item, because the list is
    // repainted whenever a destination registers.
    menu.addEventListener("click", function (event) {
      var item = event.target && event.target.closest
        ? event.target.closest(".shellItem")
        : null;
      if (!item) return;
      var key = item.getAttribute("data-shell-key");
      if (!key) return;
      if (key === "map") {
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
      render: function (body) { body.appendChild(emptyState("Post", "Nothing here yet.")); },
    });
    register({ key: "chat", title: "Chat", icon: "✉", group: "Network", dock: "dockChat" });

    register({ key: "leaderboard", title: "Leaderboard", icon: "⚑", group: "Driving", dock: "dockLeaderboard" });
    register({ key: "games", title: "Games", icon: "❖", group: "Driving", dock: "dockGames" });
    register({ key: "music", title: "Music", icon: "♪", group: "Driving", dock: "dockMusic" });

    register({ key: "colors", title: "Colours", icon: "◐", group: "Map", dock: "dockColors" });
    register({ key: "modes", title: "Modes", icon: "⚙", group: "Map", dock: "dockModes" });

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

  window.TeamJoseoShell = {
    register: register,
    open: openScreen,
    close: leaveScreen,
    openMenu: openMenu,
    closeMenu: closeMenu,
    refreshChrome: applyAdminChrome,
    emptyState: emptyState,
    _registry: registry,
  };
})();
