/**
 * map-action.js — the on-map action pill.
 *
 * WHAT THIS FILE IS ALLOWED TO DECIDE: nothing.
 *
 * app.part17.js owns the recommendation. It publishes both the sentence and
 * the same recommendation in parts on window.TlcAssistantRecommendation, and
 * fires "tlc:recommendation" when either changes. This file renders those
 * parts. It does not read zone scores, it does not compare candidates, and it
 * does not decide when a driver should leave — a second opinion on screen is
 * worse than no opinion, because the driver cannot tell which one to follow.
 *
 * It USED to own a segmented control at the top right as well -- recentre and
 * report police, each half delegating to a button that already existed. Both
 * are gone: the pair was asked to be removed, and then asked to be removed
 * rather than hidden. Reporting police is still in the Modes panel in the dock,
 * where that half only ever clicked; recentring has no control any more and
 * auto-centre simply stays on.
 */
(function () {
  "use strict";

  var el = {};
  var expanded = false;
  var lastKey = "";

  function byId(id) { return document.getElementById(id); }

  function fmtMiles(miles) {
    if (!Number.isFinite(miles)) return "";
    // Under a mile, tenths are the difference between "around the corner" and
    // "across the neighbourhood". Over ten, they are noise.
    if (miles < 10) return miles.toFixed(1) + "mi";
    return Math.round(miles) + "mi";
  }

  function setHidden(node, hide) {
    if (node) node.hidden = !!hide;
  }

  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  /**
   * Render one published recommendation. Called on every tick, so it bails on
   * an unchanged payload rather than rewriting the DOM sixty times a minute.
   */
  function render(rec) {
    if (!el.root) return;
    var detail = rec && rec.detail;
    if (!detail || !detail.verb) {
      // No recommendation yet. An empty pill invites a driver to read meaning
      // into a blank, so show nothing at all until there is something to say.
      setHidden(el.root, true);
      return;
    }

    var key = [
      detail.verb, detail.tone, detail.zoneName, detail.score,
      detail.distanceMiles, detail.bearingDeg, rec.secondary,
    ].join("|");
    if (key === lastKey) {
      setHidden(el.root, false);
      return;
    }
    lastKey = key;

    if (el.pill) el.pill.setAttribute("data-tone", String(detail.tone || "idle"));
    setText(el.verb, String(detail.verb || ""));

    var zone = String(detail.zoneName || "").trim();
    setText(el.zone, zone);

    var dist = detail.isMove ? fmtMiles(detail.distanceMiles) : "";
    setText(el.dist, dist);
    setHidden(el.dist, !dist);
    // The separator exists only to separate. With one side missing it is a
    // floating bullet.
    setHidden(el.dot, !(dist && zone));

    var hasScore = Number.isFinite(detail.score);
    setText(el.score, hasScore ? String(detail.score) : "");
    setHidden(el.score, !hasScore);

    var bearing = Number.isFinite(detail.bearingDeg) ? detail.bearingDeg : null;
    if (bearing === null) {
      setHidden(el.arrow, true);
    } else {
      setHidden(el.arrow, false);
      if (el.arrow) el.arrow.style.setProperty("--bearing", bearing.toFixed(1) + "deg");
    }

    // The expanded sheet shows the assistant's own sentence rather than a
    // paraphrase, for the same reason the pill shows its fields: one voice.
    setText(el.why, String((rec.secondary || rec.primary || "")).trim());
    var meta = [];
    if (Number.isFinite(detail.etaMinutes)) meta.push(detail.etaMinutes + " min away");
    if (rec.source) meta.push(rec.source === "server" ? "Live scoring" : "On-device scoring");
    setText(el.meta, meta.join(" • "));

    // A pill with nothing behind it should not pretend to expand.
    var hasDetail = !!String(el.why && el.why.textContent || "").trim();
    if (!hasDetail && expanded) setExpanded(false);
    if (el.pill) el.pill.style.cursor = hasDetail ? "pointer" : "default";

    setHidden(el.root, false);
  }

  function setExpanded(next) {
    expanded = !!next;
    setHidden(el.detail, !expanded);
    if (el.pill) el.pill.setAttribute("aria-expanded", expanded ? "true" : "false");
    // The card only paints while it has something to hold. Collapsed it has to
    // be fully transparent, or the pill stops being a badge on the map and
    // becomes a badge on an empty white slab.
    if (el.card) el.card.classList.toggle("open", expanded);
    // Expanded, the card is the widest thing on the screen and its top-left
    // corner is where the menu button lives. The class lets the shell get out
    // of the way; nothing else reads it.
    if (document.body) document.body.classList.toggle("map-answer-open", expanded);
  }

  function onPillClick() {
    if (!String(el.why && el.why.textContent || "").trim()) return;
    setExpanded(!expanded);
  }

  /* ------------------------------------------------------------------ boot */

  function mount() {
    el.root = byId("mapAction");
    if (!el.root) return;
    el.pill = byId("mapActionPill");
    el.verb = byId("mapActionVerb");
    el.arrow = byId("mapActionArrow");
    el.dist = byId("mapActionDist");
    el.dot = byId("mapActionDot");
    el.zone = byId("mapActionZone");
    el.score = byId("mapActionScore");
    el.detail = byId("mapActionDetail");
    el.card = byId("mapActionCard");
    el.why = byId("mapActionWhy");
    el.meta = byId("mapActionMeta");

    if (el.pill) el.pill.addEventListener("click", onPillClick);

    window.addEventListener("tlc:recommendation", function (event) {
      render((event && event.detail) || window.TlcAssistantRecommendation);
    });
    // A recommendation published before this file ran would otherwise wait for
    // the next tick, which can be twenty seconds of an empty map.
    render(window.TlcAssistantRecommendation);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }

  window.TeamJoseoMapAction = {
    render: render,
    expanded: function () { return expanded; },
    _el: el,
  };
})();
