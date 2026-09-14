/**
 * subscription.paywall.js — Paywall UI module for Team Joseo Map.
 */
(function () {
  'use strict';

  // Subscribe and Manage moved onto the landing page. Both spellings are
  // matched so the busy label ("Connecting to Paddle…") still finds its button
  // whichever markup a document carries.
  const CHECKOUT_BTN = '[data-paywall-checkout-btn], [data-landing-subscribe]';
  const PORTAL_BTN = '[data-paywall-portal-btn], [data-landing-portal]';

  const runtime = (typeof window !== 'undefined') ? window.FrontendRuntime : null;

  let trialCountdownEl = null;
  let visible = false;
  let pendingCheckout = false;
  let pendingPortal = false;

  function getSubscriptionFromMe() {
    const meObj = (typeof window !== 'undefined') ? window.me : null;
    if (!meObj) return null;
    return meObj.subscription || null;
  }

  // The server is the authority on access and publishes its verdict as
  // subscription.has_access. Re-deriving it here from a hand-written status list
  // is what made the paywall disagree with the API: 'past_due' (still inside a
  // paid window) and 'trialing' (a Paddle plan that opens with a trial) both
  // grant access server-side, but neither appeared in the list -- so a driver
  // with a working account sat behind a paywall, and post-checkout polling for
  // one of those statuses never finished.
  //
  // Fall back to the status list only when has_access is absent (older payload).
  function hasAccess() {
    const sub = getSubscriptionFromMe();
    if (!sub) return false;
    if (typeof sub.has_access === 'boolean') return sub.has_access;
    return sub.status === 'active' || sub.status === 'comp';
  }

  // Kept for the countdown pill, which asks a narrower question: is this driver
  // on a PAID plan (so no trial pill), as opposed to having access by any means.
  function hasActiveSubscription() {
    const sub = getSubscriptionFromMe();
    if (!sub) return false;
    return ['active', 'comp', 'past_due', 'trialing'].indexOf(sub.status) !== -1;
  }

  function getTrialInfo() {
    const meObj = (typeof window !== 'undefined') ? window.me : null;
    if (!meObj) return { onTrial: false, daysRemaining: null };

    const sub = meObj.subscription || null;
    const subDays = sub && typeof sub.days_remaining === 'number' ? sub.days_remaining : null;

    if (subDays !== null) {
      // The pill is for the free signup trial, which the server reports with no
      // subscription status at all ('none'/null). It compared against 'trial',
      // a value the server never emits -- harmless only because every other
      // branch happened to hide the pill anyway.
      const onTrial = sub.status === null || sub.status === 'none';
      return { onTrial, daysRemaining: Math.max(0, subDays) };
    }

    const expires = Number(meObj.trial_expires_at || 0);
    if (!expires) return { onTrial: false, daysRemaining: null };
    const now = Math.floor(Date.now() / 1000);
    const remaining = Math.max(0, Math.floor((expires - now) / 86400));
    return { onTrial: true, daysRemaining: remaining };
  }

  function ensureTrialCountdownEl() {
    if (trialCountdownEl) return trialCountdownEl;
    trialCountdownEl = document.getElementById('trialCountdownPill');
    return trialCountdownEl;
  }

  /* Locking now means the MAP, not the document.
   *
   * This used to raise #lockedOverlay over the whole app: a driver whose trial
   * ended lost the feed, the dock and every screen, and was shown the
   * signed-out page with a Subscribe button -- which reads as "your sign-in
   * failed" however carefully it is worded. They are in the app now. The map is
   * what they cannot have.
   *
   * The state itself lives in applyMapLockState (app.part10.js) as one class on
   * <html>, so the inline boot CSS can apply it before any script has loaded.
   * show()/hide() stay as the module's public verbs because callers outside
   * this file speak them.
   */
  function setMapLock(on) {
    const locked = !!on;
    visible = locked;
    if (typeof window === 'undefined') return;
    window.__paywallVisible = locked;
    // Locking explicitly ends the preview as well, or its ticker would keep a
    // countdown running over a map that is already covered.
    if (locked && typeof window.endMapPreview === 'function') { window.endMapPreview(); return; }
    if (typeof window.applyMapLockState === 'function') window.applyMapLockState(locked);
  }

  // `options.reason` is accepted and ignored: it used to write into a modal's
  // message line, and the map lock card states the reason in its own words.
  // Kept in the signature because callers still pass it.
  function show(options = {}) {   // eslint-disable-line no-unused-vars
    setMapLock(true);
  }

  function hide() {
    setMapLock(false);
  }

  function isVisible() {
    return !!visible;
  }

  async function triggerCheckout() {
    if (pendingCheckout) return;
    pendingCheckout = true;

    const btn = document.querySelector(CHECKOUT_BTN);
    const originalLabel = btn ? btn.textContent : '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Connecting to Paddle…';
    }

    try {
      const token = runtime?.getToken?.() || '';
      if (!token) {
        throw new Error('Sign in required before checkout');
      }

      const result = await runtime.postJSON('/subscription/checkout', {}, token);
      const checkoutUrl = result?.checkout_url;
      if (!checkoutUrl) {
        throw new Error('Backend did not return a checkout URL');
      }

      try {
        sessionStorage.setItem('tlc_checkout_pending', String(Date.now()));
      } catch (_) {}

      window.location.href = checkoutUrl;
    } catch (err) {
      console.warn('Checkout failed:', err);
      if (btn) {
        btn.disabled = false;
        btn.textContent = originalLabel || 'Subscribe ($8/week)';
      }
      alert(err?.message || 'Could not start checkout. Please try again.');
      pendingCheckout = false;
    }
  }

  async function openPortal() {
    if (pendingPortal) return;
    pendingPortal = true;

    const btn = document.querySelector(PORTAL_BTN);
    const originalLabel = btn ? btn.textContent : '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Opening portal…';
    }

    try {
      const token = runtime?.getToken?.() || '';
      if (!token) {
        throw new Error('Sign in required');
      }

      const result = await runtime.postJSON('/subscription/portal', {}, token);
      const portalUrl = result?.portal_url;
      if (!portalUrl) {
        throw new Error('Backend did not return a portal URL');
      }

      window.open(portalUrl, '_blank', 'noopener');
    } catch (err) {
      console.warn('Portal open failed:', err);
      alert(err?.message || 'Could not open subscription portal. Please try again.');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = originalLabel || 'Manage subscription';
      }
      pendingPortal = false;
    }
  }

  // Going from locked-out to allowed mid-session needs a reload.
  //
  // The app loads its map data once at startup. When that happens while the
  // account has no access those requests fail, nothing retries them, and the map
  // stays blank -- so granting access afterwards (redeeming a code, or paying)
  // fixes the account but not the page the driver is looking at. They had to
  // know to reload by hand.
  //
  // Guarded so it can fire at most once in a short window: if access were
  // somehow granted and the page still failed, an ungated reload would loop and
  // the driver could not even read the error.
  const RELOAD_GUARD_KEY = 'tlc_access_reload_at';
  const RELOAD_GUARD_MS = 30000;

  function reloadIntoAccess() {
    try {
      const prev = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) || 0);
      if (prev && (Date.now() - prev) < RELOAD_GUARD_MS) return false;
      sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
    } catch (_) {
      // sessionStorage can throw (private mode, blocked storage). Reloading once
      // is still right; we just lose the loop guard.
    }
    try {
      window.location.reload();
    } catch (_) {
      return false;
    }
    return true;
  }

  let pendingRedeem = false;

  function setRedeemStatus(text, kind) {
    const el = document.querySelector('[data-paywall-redeem-status]');
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.textContent = text;
    el.classList.toggle('isError', kind === 'error');
    el.classList.toggle('isOk', kind === 'ok');
  }

  async function redeemCode() {
    if (pendingRedeem) return;
    const input = document.querySelector('[data-paywall-redeem-input]');
    const code = (input?.value || '').trim();
    if (!code) {
      setRedeemStatus('Enter your code first.', 'error');
      return;
    }

    pendingRedeem = true;
    const btn = document.querySelector('[data-paywall-redeem-btn]');
    const originalLabel = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
    setRedeemStatus('Checking your code…', '');

    try {
      const token = runtime?.getToken?.() || '';
      if (!token) throw new Error('Sign in first, then redeem your code.');

      await runtime.postJSON('/subscription/redeem', { code }, token);

      // Re-read /me so the whole app (not just this overlay) sees the new
      // access, then let the normal auth-state path decide to hide.
      if (typeof window.loadMe === 'function') {
        try { await window.loadMe(); } catch (_) {}
      }
      if (input) input.value = '';
      renderTrialCountdown();
      if (hasAccess()) {
        hide();
        // The map failed to load while this account was locked out and will not
        // retry on its own, so reload straight into the working app rather than
        // leaving a blank map behind the dismissed overlay.
        setRedeemStatus('Code accepted — loading your map…', 'ok');
        if (!reloadIntoAccess()) {
          setRedeemStatus('Code accepted. Reload the page to load your map.', 'ok');
        }
      } else {
        // The code was accepted but /me still reports no access. Say so rather
        // than silently leaving the overlay up with a success message on it.
        setRedeemStatus('Code accepted, but access has not refreshed yet. Reload the page.', 'error');
      }
    } catch (err) {
      // The server's message is the useful one here -- revoked, expired,
      // already used, not a real code -- so prefer it over a generic string.
      const detail = err?.payload?.detail || err?.detail || err?.message;
      setRedeemStatus(String(detail || 'That code could not be redeemed.'), 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = originalLabel || 'Redeem'; }
      pendingRedeem = false;
    }
  }

  function wireRedeem() {
    const btn = document.querySelector('[data-paywall-redeem-btn]');
    if (btn && !btn.__tlcWired) {
      btn.addEventListener('click', (ev) => { ev.preventDefault(); redeemCode(); });
      btn.__tlcWired = true;
    }
    const input = document.querySelector('[data-paywall-redeem-input]');
    if (input && !input.__tlcWired) {
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); redeemCode(); }
      });
      input.__tlcWired = true;
    }
  }

  function renderTrialCountdown() {
    const el = ensureTrialCountdownEl();
    if (!el) return;

    const { onTrial, daysRemaining } = getTrialInfo();
    const meObj = (typeof window !== 'undefined') ? window.me : null;
    if (!meObj || meObj.is_admin || hasActiveSubscription()) {
      el.hidden = true;
      el.setAttribute('aria-hidden', 'true');
      return;
    }

    if (!onTrial || daysRemaining === null) {
      el.hidden = true;
      el.setAttribute('aria-hidden', 'true');
      return;
    }

    const label = daysRemaining === 0
      ? 'Trial ends today'
      : daysRemaining === 1
        ? '1 day left in trial'
        : `${daysRemaining} days left in trial`;
    el.textContent = label;
    el.hidden = false;
    el.setAttribute('aria-hidden', 'false');

    el.classList.toggle('urgent', daysRemaining <= 2);
    el.classList.toggle('warning', daysRemaining > 2 && daysRemaining <= 4);
  }

  /* A 402 locks the map. It used to lock the whole app.
   *
   * show() raises #lockedOverlay over everything, and this fired on ANY 402 from
   * ANY endpoint -- so the first gated request after the trial ended slammed the
   * signed-out page over a driver who was reading the feed. Under the current
   * model 402s are routine and expected: the map is paid, the feed is not, and
   * the response to one is to lock the map and leave the driver where they are.
   */
  function handlePaymentRequired(event) {
    if (hasAccess()) return;
    const meObj = (typeof window !== 'undefined') ? window.me : null;
    if (meObj?.is_admin) return;
    // A 402 means the gate has stopped serving this route, so the preview is
    // over whatever the client's clock still says.
    if (typeof window !== 'undefined' && typeof window.endMapPreview === 'function') {
      window.endMapPreview();
      return;
    }
    if (typeof window !== 'undefined' && typeof window.applyMapLockState === 'function') {
      window.applyMapLockState(true);
      return;
    }
    // No app shell to lock into -- nothing to do but leave the page alone.
    // Never fall back to the document lock: that is the bug this replaced.
  }

  /* Lock or unlock the map from what the server said, rather than waiting to
   * catch a 402.
   *
   * The lock used to be purely reactive: it appeared only if a gated request
   * failed while this listener happened to be registered, so a request that
   * fired earlier -- or one whose failure was swallowed by its caller -- left a
   * driver looking at an app where nothing loaded and nothing explained why.
   *
   * Still requires an explicit has_access === false. A /me that has not loaded
   * yet (no subscription block at all) must never lock a paid driver out of
   * their own map.
   */
  function handleAuthStateChanged() {
    renderTrialCountdown();
    const meObj = (typeof window !== 'undefined') ? window.me : null;
    const hasAnyAccess = !!(meObj?.is_admin) || hasAccess();
    const sub = getSubscriptionFromMe();
    const serverSaysNoAccess = !!sub && sub.has_access === false;

    if (typeof window === 'undefined') return;
    /* Through applyMapAccessState, not straight to the lock.
     *
     * "No access" is not the same as "no map": the gate gives an unpaid driver
     * a few minutes of it, and /me says how many are left. Locking here on
     * has_access === false alone -- which is what this used to do -- took the
     * preview away before it started, so the feature existed on the server and
     * was invisible in the app. applyMapAccessState re-arms from the server's
     * number, so this listener firing again on a /me refresh keeps the two
     * clocks together instead of restarting the preview.
     */
    if (typeof window.applyMapAccessState === 'function') {
      if (hasAnyAccess) window.applyMapAccessState(false);
      else if (serverSaysNoAccess && !meObj?.is_admin) window.applyMapAccessState(true);
      return;
    }
    if (typeof window.applyMapLockState !== 'function') return;
    if (hasAnyAccess) {
      window.applyMapLockState(false);
    } else if (serverSaysNoAccess && !meObj?.is_admin) {
      window.applyMapLockState(true);
    }
  }

  async function handlePostCheckoutReturn() {
    const url = new URL(window.location.href);
    const checkoutParam = url.searchParams.get('checkout');
    const hadPendingCheckout = (() => {
      try {
        return !!sessionStorage.getItem('tlc_checkout_pending');
      } catch (_) {
        return false;
      }
    })();

    if (checkoutParam === 'success' || hadPendingCheckout) {
      try {
        sessionStorage.removeItem('tlc_checkout_pending');
      } catch (_) {}

      if (checkoutParam) {
        url.searchParams.delete('checkout');
        try {
          window.history.replaceState({}, document.title, url.toString());
        } catch (_) {}
      }

      const refreshMe = async () => {
        if (typeof window.loadMe === 'function') {
          try {
            await window.loadMe();
          } catch (e) {
            console.warn('loadMe during post-checkout return failed:', e);
          }
        }
      };

      // Poll the server's own has_access verdict. Waiting on a status
      // allow-list meant a checkout that landed on 'trialing' or 'past_due'
      // never cleared the overlay even though the API had already let the
      // driver in.
      for (let i = 0; i < 5; i++) {
        await refreshMe();
        if (hasAccess()) {
          hide();
          // Same reason as redeeming: the driver came back from Paddle into a
          // page whose map requests already failed while they had no access.
          // Hiding the overlay would reveal a blank map they paid for.
          reloadIntoAccess();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }

      renderTrialCountdown();
    }
  }

  function wireCheckoutButton() {
    const btn = document.querySelector(CHECKOUT_BTN);
    if (btn && !btn.__tlcWired) {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        triggerCheckout();
      });
      btn.__tlcWired = true;
    }
  }

  function wirePortalButton() {
    const btn = document.querySelector(PORTAL_BTN);
    if (btn && !btn.__tlcWired) {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        openPortal();
      });
      btn.__tlcWired = true;
    }
  }

  function initialize() {
    if (typeof window === 'undefined' || !window.document) return;

    window.addEventListener('tlc:payment-required', handlePaymentRequired);
    window.addEventListener('tlc:auth-state-changed', handleAuthStateChanged);

    // When a page is restored from bfcache (user hit "back" from Paddle
    // checkout without completing), module-level flags like pendingCheckout
    // stay true and the Subscribe button is stuck on "Connecting to Paddle…".
    // Reset in-flight flags and restore the button so the user can retry.
    window.addEventListener('pageshow', (event) => {
      if (!event.persisted) return;
      pendingCheckout = false;
      pendingPortal = false;
      const checkoutBtn = document.querySelector(CHECKOUT_BTN);
      if (checkoutBtn) {
        checkoutBtn.disabled = false;
        if (/connecting to paddle/i.test(checkoutBtn.textContent || '')) {
          checkoutBtn.textContent = 'Subscribe ($8/week)';
        }
      }
      const portalBtn = document.querySelector(PORTAL_BTN);
      if (portalBtn) {
        portalBtn.disabled = false;
        if (/opening portal/i.test(portalBtn.textContent || '')) {
          portalBtn.textContent = 'Manage subscription';
        }
      }
    });

    const tryWire = () => {
      wireCheckoutButton();
      wirePortalButton();
      wireRedeem();
      renderTrialCountdown();
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', tryWire);
    } else {
      tryWire();
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        handlePostCheckoutReturn().catch((e) => console.warn('Post-checkout return handling failed:', e));
      });
    } else {
      handlePostCheckoutReturn().catch((e) => console.warn('Post-checkout return handling failed:', e));
    }
  }

  const TlcPaywallModule = {
    show,
    hide,
    isVisible,
    triggerCheckout,
    openPortal,
    renderTrialCountdown,
    hasActiveSubscription,
    hasAccess,
    redeemCode,
    getTrialInfo,
  };

  if (typeof window !== 'undefined') {
    window.TlcPaywallModule = TlcPaywallModule;
  }

  initialize();
})();
