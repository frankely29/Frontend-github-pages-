/**
 * subscription.paywall.js — Paywall UI module for Team Joseo Map.
 */
(function () {
  'use strict';

  const runtime = (typeof window !== 'undefined') ? window.FrontendRuntime : null;

  let overlayEl = null;
  let trialCountdownEl = null;
  let visible = false;
  let pendingCheckout = false;
  let pendingPortal = false;

  function getSubscriptionFromMe() {
    const meObj = (typeof window !== 'undefined') ? window.me : null;
    if (!meObj) return null;
    return meObj.subscription || null;
  }

  function hasActiveSubscription() {
    const sub = getSubscriptionFromMe();
    return !!(sub && (sub.status === 'active' || sub.status === 'comp' || sub.has_access === true));
  }

  function getTrialInfo() {
    const meObj = (typeof window !== 'undefined') ? window.me : null;
    if (!meObj) return { onTrial: false, daysRemaining: null };

    const sub = meObj.subscription || null;
    const subDays = sub && typeof sub.days_remaining === 'number' ? sub.days_remaining : null;

    if (subDays !== null) {
      const onTrial = sub.status === 'trial' || sub.status === null || sub.status === 'none';
      return { onTrial, daysRemaining: Math.max(0, subDays) };
    }

    const expires = Number(meObj.trial_expires_at || 0);
    if (!expires) return { onTrial: false, daysRemaining: null };
    const now = Math.floor(Date.now() / 1000);
    const remaining = Math.max(0, Math.floor((expires - now) / 86400));
    return { onTrial: true, daysRemaining: remaining };
  }

  function ensureOverlayEl() {
    if (overlayEl) return overlayEl;
    overlayEl = document.getElementById('paywallOverlay');
    return overlayEl;
  }

  function ensureTrialCountdownEl() {
    if (trialCountdownEl) return trialCountdownEl;
    trialCountdownEl = document.getElementById('trialCountdownPill');
    return trialCountdownEl;
  }

  function show(options = {}) {
    const el = ensureOverlayEl();
    if (!el) {
      console.warn('Paywall overlay element not found in DOM');
      return;
    }

    const reason = String(options.reason || '');
    const messageEl = el.querySelector('[data-paywall-message]');
    if (messageEl) {
      messageEl.textContent = reason
        ? reason
        : 'Your Team Joseo Map access requires an active subscription.';
    }

    el.classList.add('show');
    el.setAttribute('aria-hidden', 'false');
    visible = true;
    if (typeof window !== 'undefined') {
      window.__paywallVisible = true;
    }
  }

  function hide() {
    const el = ensureOverlayEl();
    if (!el) return;
    el.classList.remove('show');
    el.setAttribute('aria-hidden', 'true');
    visible = false;
    if (typeof window !== 'undefined') {
      window.__paywallVisible = false;
    }
  }

  function isVisible() {
    return !!visible;
  }

  async function triggerCheckout() {
    if (pendingCheckout) return;
    pendingCheckout = true;

    const btn = document.querySelector('[data-paywall-checkout-btn]');
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

    const btn = document.querySelector('[data-paywall-portal-btn]');
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

  function handlePaymentRequired(event) {
    const detail = event?.detail || {};
    const reason = detail?.reason || detail?.detail?.reason || '';
    if (hasActiveSubscription()) return;
    const meObj = (typeof window !== 'undefined') ? window.me : null;
    if (meObj?.is_admin) return;
    show({ reason });
  }

  function handleAuthStateChanged() {
    renderTrialCountdown();
    if (visible && hasActiveSubscription()) {
      hide();
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

      for (let i = 0; i < 5; i++) {
        await refreshMe();
        if (hasActiveSubscription()) {
          hide();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }

      renderTrialCountdown();
    }
  }

  function wireCheckoutButton() {
    const btn = document.querySelector('[data-paywall-checkout-btn]');
    if (btn && !btn.__tlcWired) {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        triggerCheckout();
      });
      btn.__tlcWired = true;
    }
  }

  function wirePortalButton() {
    const btn = document.querySelector('[data-paywall-portal-btn]');
    if (btn && !btn.__tlcWired) {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        openPortal();
      });
      btn.__tlcWired = true;
    }
  }

  function wireDismissButton() {
    const btn = document.querySelector('[data-paywall-dismiss-btn]');
    if (btn && !btn.__tlcWired) {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        const meObj = (typeof window !== 'undefined') ? window.me : null;
        if (meObj?.is_admin || hasActiveSubscription()) {
          hide();
        }
      });
      btn.__tlcWired = true;
    }
  }

  function initialize() {
    if (typeof window === 'undefined' || !window.document) return;

    window.addEventListener('tlc:payment-required', handlePaymentRequired);
    window.addEventListener('tlc:auth-state-changed', handleAuthStateChanged);

    const tryWire = () => {
      wireCheckoutButton();
      wirePortalButton();
      wireDismissButton();
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
    getTrialInfo,
  };

  if (typeof window !== 'undefined') {
    window.TlcPaywallModule = TlcPaywallModule;
  }

  initialize();
})();
