/**
 * map-action.js — the on-map action pill and the segmented map control.
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
 * The two seams into the rest of the app, both deliberate and both by id:
 *   - #btnCenter  — the existing auto-centre toggle. The segmented control's
 *                   left half clicks it and mirrors its "on" class.
 *   - #btnPolice  — the existing police report button in the modes panel. The
 *                   right half clicks it.
 * Delegating rather than rewiring means neither behaviour has two
 * implementations that can drift apart, and it means this file can be deleted
 * without taking a feature with it.
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
  }

  function onPillClick() {
    if (!String(el.why && el.why.textContent || "").trim()) return;
    setExpanded(!expanded);
  }

  /* ----------------------------------------------------- segmented control */

  function mirrorCenterState() {
    var source = byId("btnCenter");
    if (!source || !el.segCenter) return;
    // #btnCenter carries its state in an "on" class, which app.js toggles. Read
    // it rather than tracking a parallel boolean that can fall out of step with
    // the control that actually drives the map.
    var on = source.classList.contains("on");
    el.segCenter.setAttribute("aria-pressed", on ? "true" : "false");
  }

  function wireSegmented() {
    var center = byId("btnCenter");
    var police = byId("btnPolice");
    if (!el.segmented) return;
    // Only offer a half that has something to click. A dead button on the map
    // is worse than a narrower control.
    setHidden(el.segCenter, !center);
    setHidden(el.segReport, !police);
    if (!center && !police) return;

    setHidden(el.segmented, false);

    if (center && el.segCenter) {
      el.segCenter.addEventListener("click", function () {
        center.click();
        // The class flips inside that handler; read it back on the next frame.
        setTimeout(mirrorCenterState, 0);
      });
      mirrorCenterState();
      // app.js also flips the class on its own (following the driver, losing
      // the fix). Watch the attribute rather than guessing when that happens.
      if (typeof MutationObserver === "function") {
        new MutationObserver(mirrorCenterState)
          .observe(center, { attributes: true, attributeFilter: ["class"] });
      }
    }

    if (police && el.segReport) {
      el.segReport.addEventListener("click", function () { police.click(); });
    }

    // Only now that the segmented control is real does the original stack go
    // away. Hiding it first would leave a driver with no recentre button at all
    // if anything above threw.
    document.body.classList.add("map-segmented-on");

    // That class also drops the badge strip below this control. The assistant
    // card is positioned from the badges' live rects by app.part17.js, which
    // recomputes on resize and on this event — and a badge that MOVES neither
    // resizes nor fires anything, so without this the card stays on the old
    // line and sits under the control. Ask for the recompute directly.
    try {
      window.dispatchEvent(new CustomEvent("tlc-top-badges-updated"));
    } catch (_) {}
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
    el.why = byId("mapActionWhy");
    el.meta = byId("mapActionMeta");
    el.segmented = byId("mapSegmented");
    el.segCenter = byId("mapSegCenter");
    el.segReport = byId("mapSegReport");

    if (el.pill) el.pill.addEventListener("click", onPillClick);
    wireSegmented();

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
