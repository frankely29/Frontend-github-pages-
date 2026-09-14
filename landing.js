/**
 * landing.js — the two doors on the signed-out page.
 *
 * Deliberately thin. Signing in and signing up already work: app.part10.js
 * binds #btnLogin and #btnSignup by id and reads #authEmail, #authPass,
 * #authName and #authGhost. None of that is touched here, and none of it is
 * reimplemented. This file only decides which door the page is showing.
 *
 * BOTH BUTTONS STAY IN THE DOM. app.part10.js attaches its listener once, at
 * load, to whichever element has that id — so a pane that created and destroyed
 * its buttons would hand back a button nobody is listening to. They are hidden
 * and shown instead, which is why `hidden` here is a display switch and never a
 * removal.
 */
(function () {
  "use strict";

  var DOORS = {
    signup: {
      title: "Create account",
      lede: "Your name and city are what other drivers see.",
      submit: "signup",
      showName: true,
      showExtras: true,
      showPromise: true,
      hint: "At least 6 characters.",
      swap: "Already have one? <b data-landing-go=\"signin\">Sign in</b>",
      autocomplete: "new-password",
    },
    signin: {
      title: "Sign in",
      lede: "Same account on every device — your posts, trips and chats come with you.",
      submit: "signin",
      showName: false,
      showExtras: false,
      showPromise: false,
      hint: "",
      swap: "No account yet? <b data-landing-go=\"signup\">Create one</b>",
      autocomplete: "current-password",
    },
  };

  var root = null;
  var currentDoor = "signup";
  var lapsed = false;
  var openPane = "";
  var resolving = false;

  function q(selector) {
    return root ? root.querySelector(selector) : null;
  }

  function show(pane) {
    if (!root) return;
    var already = openPane === pane;
    var panes = root.querySelectorAll("[data-landing-pane]");
    for (var i = 0; i < panes.length; i += 1) {
      var node = panes[i];
      node.hidden = node.getAttribute("data-landing-pane") !== pane;
    }
    openPane = pane;
    // A pane that scrolled to the bottom last time should not OPEN there --
    // but only on the way in. This used to run on every call, and the paywall
    // re-announces a locked account more than once, so each re-announcement
    // threw a driver who was reading the page back to the top mid-scroll.
    if (already) return;
    var open = q('[data-landing-pane="' + pane + '"]');
    if (open) open.scrollTop = 0;
  }

  function applyDoor(name) {
    var door = DOORS[name] || DOORS.signup;
    currentDoor = DOORS[name] ? name : "signup";

    var title = q("[data-landing-title]");
    var lede = q("[data-landing-lede]");
    var nameField = q('[data-landing-field="name"]');
    var cityField = q('[data-landing-field="city"]');
    var codeField = q('[data-landing-field="code"]');
    var promise = q("[data-landing-promise]");
    var hint = q("[data-landing-hint]");
    var swap = q("[data-landing-swap]");
    var signup = document.getElementById("btnSignup");
    var login = document.getElementById("btnLogin");
    var pass = document.getElementById("authPass");

    if (title) title.textContent = door.title;
    if (lede) lede.textContent = door.lede;
    if (nameField) nameField.hidden = !door.showName;
    // Signing in needs neither: the account already knows its city, and a code
    // is redeemed from the menu once you are in.
    if (cityField) cityField.hidden = !door.showExtras;
    if (codeField) codeField.hidden = !door.showExtras;
    if (promise) promise.hidden = !door.showPromise;
    if (hint) {
      hint.textContent = door.hint;
      hint.hidden = !door.hint;
    }
    if (swap) swap.innerHTML = door.swap;
    if (signup) signup.hidden = door.submit !== "signup";
    if (login) login.hidden = door.submit !== "signin";
    // Password managers offer to save a new password on signup and to fill the
    // existing one on sign-in; the same field has to say which it is.
    if (pass) pass.setAttribute("autocomplete", door.autocomplete);
  }

  /* The same page, shown to a driver whose free week has run out.
   *
   * The approved entry flow is land, one form, the map -- there is no
   * subscribe screen in it, deliberately, because the trial starts inside
   * /auth/signup and there was nothing to choose. A lapsed account still has
   * to be told something, and this is the only approved surface that can tell
   * them: same hero, same pitch, same "$8/week after the trial" they already
   * read, with the button that was going to be their second visit anyway.
   *
   * Only the call to action changes. Swapping the copy on the existing
   * buttons would have been fewer nodes, but those two carry data-landing-go
   * and clicking them navigates; a button labelled "Subscribe" that opens the
   * sign-up form is worse than a second block. */
  function setLapsed(on) {
    if (!root) return;
    var locked = !!on;
    // Re-entrant by design: the paywall announces a locked account on more
    // than one event. Doing the work again is harmless, but show() below is
    // not free -- it used to reset the scroll position every time.
    if (locked === lapsed && !resolving) return;
    resolving = false;
    var blocks = root.querySelectorAll("[data-landing-cta]");
    for (var i = 0; i < blocks.length; i += 1) {
      var wants = blocks[i].getAttribute("data-landing-cta") === "lapsed";
      blocks[i].hidden = wants !== locked;
    }
    var fine = root.querySelectorAll("[data-landing-fine]");
    for (var j = 0; j < fine.length; j += 1) {
      var f = fine[j].getAttribute("data-landing-fine") === "lapsed";
      fine[j].hidden = f !== locked;
    }
    // Sign in stays, locked or not. It used to be hidden here on the reasoning
    // that it "makes no sense to someone already signed in" -- but the locked
    // page is the one screen with no other way off it. Subscribe, Manage
    // subscription and a redeem box all assume this is the right account; a
    // driver on the wrong one, or one who has a second account that is paid up,
    // had to pay to get out. It is also the only sign-in button on this page,
    // so hiding it hid the whole affordance.
    var top = q("[data-landing-go='signin'].landingGhostBtn");
    if (top) top.hidden = false;
    if (locked) nameTheAccount();
    lapsed = locked;
    if (locked) show("pitch");
  }

  /* Say whose account this is, when that is known.
   *
   * The markup ships "You're signed in." on its own, so the message holds even
   * before this script runs or if /me never answered. Naming the account is
   * what makes it land: a driver who has just typed a password wants to see
   * that it was accepted, and their own name is the proof. Falls back to the
   * email, then to the bare sentence -- never to a stray "as undefined".
   */
  function nameTheAccount() {
    var el = q("[data-landing-locked-title]");
    if (!el) return;
    var me = (typeof window !== "undefined" && window.me) || null;
    var who = me && (me.display_name || me.email);
    el.textContent = who
      ? "You're signed in as " + String(who).trim() + "."
      : "You're signed in.";
  }

  /* Is this page actually in front of someone right now?
   *
   * Asked of the rendering, not of one class. #lockedOverlay is raised three
   * different ways -- the `show` class, html.tj-auth-pending while the app is
   * still working out who this is, and html.tj-locked when access has lapsed --
   * and only the first of those sets `show`. Checking that class alone meant the
   * page counted as "not on screen" during boot and while locked, which are
   * precisely the states a driver with a dead or expired token is in when they
   * go to sign in again. A 401 landing then threw them off the form they were
   * typing into and back to the pitch: "after I type email and password it takes
   * me back to welcome page".
   */
  function onScreen() {
    var overlay = document.getElementById("lockedOverlay");
    if (!overlay) return false;
    if (typeof window.getComputedStyle !== "function") {
      return overlay.classList.contains("show");
    }
    return window.getComputedStyle(overlay).display !== "none";
  }

  function paywall() {
    return (typeof window !== "undefined" && window.TlcPaywallModule) || null;
  }

  function goTo(target) {
    if (target === "pitch") {
      show("pitch");
      return;
    }
    if (!DOORS[target]) return;
    applyDoor(target);
    show("form");
    var focusTarget = document.getElementById(
      target === "signup" ? "authName" : "authEmail");
    if (focusTarget && typeof focusTarget.focus === "function") {
      try { focusTarget.focus(); } catch (_) {}
    }
  }

  function onClick(event) {
    var trigger = event.target && event.target.closest
      ? event.target.closest("[data-landing-go]")
      : null;
    if (!trigger) {
      // The lapsed buttons drive the paywall module directly: it already owns
      // the Paddle checkout and portal calls, and a second implementation of
      // "take their money" is the last thing this file should grow.
      var sub = event.target && event.target.closest
        ? event.target.closest("[data-landing-subscribe]") : null;
      if (sub) {
        event.preventDefault();
        if (paywall()) paywall().triggerCheckout();
        return;
      }
      var portal = event.target && event.target.closest
        ? event.target.closest("[data-landing-portal]") : null;
      if (portal) {
        event.preventDefault();
        if (paywall()) paywall().openPortal();
      }
      return;
    }
    // Never preventDefault on the submit buttons: their real listener lives in
    // app.part10.js and this handler must not get in front of it.
    goTo(trigger.getAttribute("data-landing-go"));
  }

  function mount() {
    root = document.getElementById("landing");
    if (!root) return;
    root.addEventListener("click", onClick);
    applyDoor("signup");
    show("pitch");

    /* Resolve only if nothing has answered yet.
     *
     * index.html clears tj-auth-pending the moment setAuthUI decides, and that
     * can happen before this script exists -- it is a separate request either
     * way, and setAuthUI can win. Whether the
     * answer beats the mount is a race, and on the losing side this hid every
     * button on the page with nothing left to come along and unhide them: a
     * driver with an expired token got a welcome page with no way in at all,
     * no Sign in and no Create account. Caught by a click that failed because
     * the button it wanted carried hidden="".
     *
     * The class is the app's own record of whether the question is still open,
     * so ask that rather than guessing from a token that may already have been
     * cleared.
     */
    var html = (typeof document !== "undefined") ? document.documentElement : null;
    var stillAsking = !!(html && html.classList.contains("tj-auth-pending"));
    if (stillAsking && hasStoredToken()) setResolving();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }

  /* Coming back to the signed-out page should show the pitch, not the form
   * someone was halfway through when their token expired.
   *
   * "Coming back" is the whole of it, and this used to fire while they were
   * still here. A dead token is exactly what a driver has when they go to sign
   * in again, and the app keeps polling with it -- /frame, /timeline,
   * /city_events -- so a 401 lands at some arbitrary moment and this threw
   * whoever was typing their password back to the pitch. Measured: form at
   * 4301ms, 401 on /frame/0, pitch at 5386ms, two characters into the
   * password. The polls repeat, so there was no finishing the form at all.
   *
   * So: only when the page is not in front of them. If the welcome page is on
   * screen with the form open, someone is using it, and an expiry they already
   * know about is no reason to take it away.
   */
  window.addEventListener("tlc:auth-expired", function () {
    if (!root) return;
    if (onScreen() && openPane === "form") return;
    show("pitch");
  });

  /* Boot shows this page before anything knows which version of it to show.
   *
   * With a token in hand, setAuthUI(false) can still run while /me is in
   * flight -- and that reveals the signed-out page, so a lapsed driver saw
   * "Create account / I already have an account" flash up before it was
   * replaced by Subscribe. Both are wrong for them; one of them is wrong and
   * looks like the old design coming back.
   *
   * So while the answer is unknown the page keeps its hero, its pitch and its
   * carousel, and simply shows no call to action yet. A signed-out visitor
   * never enters this state -- no token, nothing to resolve -- and gets their
   * buttons on the first paint as before. */
  function setResolving() {
    if (!root) return;
    resolving = true;
    var blocks = root.querySelectorAll("[data-landing-cta], [data-landing-fine]");
    for (var i = 0; i < blocks.length; i += 1) blocks[i].hidden = true;
    var top = q("[data-landing-go='signin'].landingGhostBtn");
    if (top) top.hidden = true;
  }

  function hasStoredToken() {
    try {
      return !!(window.localStorage && window.localStorage.getItem("community_token_v1"));
    } catch (_) {
      return false;
    }
  }

  window.TeamJoseoLanding = {
    goTo: goTo,
    setLapsed: setLapsed,
    setResolving: setResolving,
    isResolving: function () { return resolving; },
    isLapsed: function () { return lapsed; },
    door: function () { return currentDoor; },
    _doors: DOORS,
  };
})();
