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
      lede: "Your name is what other drivers see in the feed and in chat.",
      submit: "signup",
      showName: true,
      showPromise: true,
      hint: "At least 6 characters.",
      swap: "Already have one? <b data-landing-go=\"signin\">Sign in</b>",
      autocomplete: "new-password",
    },
    signin: {
      title: "Sign in",
      lede: "Same account on every device — your trips and chats come with you.",
      submit: "signin",
      showName: false,
      showPromise: false,
      hint: "",
      swap: "No account yet? <b data-landing-go=\"signup\">Create one</b>",
      autocomplete: "current-password",
    },
  };

  var root = null;
  var currentDoor = "signup";

  function q(selector) {
    return root ? root.querySelector(selector) : null;
  }

  function show(pane) {
    if (!root) return;
    var panes = root.querySelectorAll("[data-landing-pane]");
    for (var i = 0; i < panes.length; i += 1) {
      var node = panes[i];
      node.hidden = node.getAttribute("data-landing-pane") !== pane;
    }
    // A pane that scrolled to the bottom last time should not open there.
    var open = q('[data-landing-pane="' + pane + '"]');
    if (open) open.scrollTop = 0;
  }

  function applyDoor(name) {
    var door = DOORS[name] || DOORS.signup;
    currentDoor = DOORS[name] ? name : "signup";

    var title = q("[data-landing-title]");
    var lede = q("[data-landing-lede]");
    var nameField = q('[data-landing-field="name"]');
    var promise = q("[data-landing-promise]");
    var hint = q("[data-landing-hint]");
    var swap = q("[data-landing-swap]");
    var signup = document.getElementById("btnSignup");
    var login = document.getElementById("btnLogin");
    var pass = document.getElementById("authPass");

    if (title) title.textContent = door.title;
    if (lede) lede.textContent = door.lede;
    if (nameField) nameField.hidden = !door.showName;
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
    if (!trigger) return;
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
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }

  // Coming back to the signed-out page should show the pitch, not the form
  // someone was halfway through when their token expired.
  window.addEventListener("tlc:auth-expired", function () {
    if (root) show("pitch");
  });

  window.TeamJoseoLanding = {
    goTo: goTo,
    door: function () { return currentDoor; },
    _doors: DOORS,
  };
})();
