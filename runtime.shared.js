(function () {
  const DEFAULT_API_BASE = 'https://web-production-78f67.up.railway.app';
  const perfRoot = (typeof window !== 'undefined')
    ? (window.__mapPerfDebug = window.__mapPerfDebug || {})
    : {};

  function resolveApiBase(explicitBase) {
    const source = explicitBase !== undefined
      ? explicitBase
      : (typeof window !== 'undefined' && window.API_BASE !== undefined
          ? window.API_BASE
          : DEFAULT_API_BASE);
    const normalized = String(source || DEFAULT_API_BASE).trim() || DEFAULT_API_BASE;
    return normalized.replace(/\/+$/, '');
  }

  if (typeof window !== 'undefined' && window.API_BASE === undefined) {
    window.API_BASE = DEFAULT_API_BASE;
  }

  function toAbsoluteUrl(urlOrPath, baseOverride) {
    const text = String(urlOrPath || '').trim();
    if (!text) return resolveApiBase(baseOverride);
    if (/^https?:\/\//i.test(text)) return text;
    const base = resolveApiBase(baseOverride);
    return `${base}${text.startsWith('/') ? text : `/${text}`}`;
  }

  function shouldBypassBrowserCache(urlOrPath) {
    const text = String(urlOrPath || '');
    return /\/(presence\/|events\/pickups\/recent|chat\/|auth\/|me(\b|\/)|day_tendency\/today|admin\/)/.test(text);
  }

  function getToken(storageKey = 'community_token_v1') {
    try {
      return localStorage.getItem(storageKey) || '';
    } catch (_) {
      return '';
    }
  }

  function authHeaders(token, headers = {}) {
    const next = { ...headers };
    if (token) next.Authorization = `Bearer ${token}`;
    return next;
  }

  function isAbortError(error) {
    return error?.name === 'AbortError' || error?.code === 20;
  }

  function assignErrorMeta(error, meta = {}) {
    const err = error instanceof Error ? error : new Error(String(error || 'Request failed'));
    Object.assign(err, meta);
    return err;
  }

  function parsePayload(text) {
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (_) {
      return { message: text };
    }
  }

  async function fetchText(urlOrPath, opts = {}) {
    const controller = opts.signal ? null : new AbortController();
    const timeoutMs = Number(opts.timeoutMs || 0);
    const timer = controller && timeoutMs > 0
      ? window.setTimeout(() => controller.abort(), timeoutMs)
      : null;
    const absoluteUrl = toAbsoluteUrl(urlOrPath, opts.baseOverride);
    const fetchOptions = {
      mode: 'cors',
      ...opts,
      signal: opts.signal || controller?.signal,
      headers: opts.headers || undefined,
    };
    delete fetchOptions.baseOverride;
    delete fetchOptions.timeoutMs;
    delete fetchOptions.expectJson;
    delete fetchOptions.token;
    delete fetchOptions.path;
    if (fetchOptions.cache === undefined && shouldBypassBrowserCache(absoluteUrl)) {
      fetchOptions.cache = 'no-store';
    }
    try {
      const res = await fetch(absoluteUrl, fetchOptions);
      const text = await res.text();
      if (!res.ok) {
        const payload = parsePayload(text);
        const message = payload?.detail?.detail || payload?.detail?.message || payload?.message || `${res.status} ${res.statusText}`;
        throw assignErrorMeta(new Error(String(message || 'Request failed')), {
          status: res.status,
          url: absoluteUrl,
          payload,
          detail: payload?.detail || payload || null,
        });
      }
      return { res, text, url: absoluteUrl };
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw assignErrorMeta(error, { url: absoluteUrl });
    } finally {
      if (timer) window.clearTimeout(timer);
    }
  }

  async function fetchJSON(urlOrPath, opts = {}) {
    const { text } = await fetchText(urlOrPath, opts);
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (error) {
      throw assignErrorMeta(new Error(`Invalid JSON @ ${urlOrPath} :: ${text.slice(0, 120)}`), {
        cause: error,
        payload: { message: text },
      });
    }
  }

  function postJSON(path, body, token, opts = {}) {
    return fetchJSON(path, {
      ...opts,
      method: 'POST',
      headers: authHeaders(token, { 'Content-Type': 'application/json', ...(opts.headers || {}) }),
      body: JSON.stringify(body || {}),
    });
  }

  function getJSONAuth(path, token, opts = {}) {
    return fetchJSON(path, {
      ...opts,
      headers: authHeaders(token, opts.headers || {}),
    });
  }

  async function requestJSONDetailed(path, opts = {}) {
    const method = String(opts.method || 'GET').toUpperCase();
    const headers = authHeaders(opts.token, { Accept: 'application/json', ...(opts.headers || {}) });
    const hasJsonBody = opts.body !== undefined && !(opts.body instanceof FormData);
    if (hasJsonBody && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    return fetchJSON(path, {
      ...opts,
      method,
      headers,
      body: hasJsonBody ? JSON.stringify(opts.body || {}) : opts.body,
    });
  }

  const pollRegistry = new Map();
  function clearPoll(key) {
    const entry = pollRegistry.get(key);
    if (!entry) return;
    if (entry.type === 'interval') window.clearInterval(entry.id);
    else window.clearTimeout(entry.id);
    pollRegistry.delete(key);
  }
  function scheduleTimeout(key, fn, delay) {
    clearPoll(key);
    const safeDelay = Math.max(0, Number(delay || 0));
    const id = window.setTimeout(async () => {
      const active = pollRegistry.get(key);
      if (!active || active.id !== id) return;
      pollRegistry.delete(key);
      await fn();
    }, safeDelay);
    pollRegistry.set(key, { id, type: 'timeout', delay: safeDelay, createdAt: Date.now() });
    return id;
  }
  function scheduleInterval(key, fn, delay) {
    clearPoll(key);
    const safeDelay = Math.max(1, Number(delay || 1));
    const id = window.setInterval(fn, safeDelay);
    pollRegistry.set(key, { id, type: 'interval', delay: safeDelay, createdAt: Date.now() });
    return id;
  }

  function bumpCounter(name, by = 1) {
    perfRoot.counters = perfRoot.counters || {};
    perfRoot.counters[name] = Number(perfRoot.counters[name] || 0) + Number(by || 0);
    return perfRoot.counters[name];
  }

  function setMetric(name, value) {
    perfRoot.metrics = perfRoot.metrics || {};
    perfRoot.metrics[name] = value;
    return value;
  }

  function recordDuration(name, ms) {
    perfRoot.timings = perfRoot.timings || {};
    const prev = perfRoot.timings[name] || { count: 0, last_ms: 0, max_ms: 0 };
    const next = {
      count: prev.count + 1,
      last_ms: Math.round(ms),
      max_ms: Math.max(Number(prev.max_ms || 0), Math.round(ms)),
    };
    perfRoot.timings[name] = next;
    return next;
  }

  async function timeAsync(name, fn) {
    const start = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    try {
      return await fn();
    } finally {
      const end = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      recordDuration(name, end - start);
    }
  }

  function createAccountActions(options = {}) {
    const storageKeys = Array.isArray(options.storageKeys) && options.storageKeys.length
      ? options.storageKeys.slice()
      : ['community_token_v1', 'community_token'];
    return {
      signOutNow({ reload = false, reloadDelayMs = 40 } = {}) {
        if (typeof options.clearAuth === 'function') options.clearAuth();
        for (const key of storageKeys) {
          try { localStorage.removeItem(key); } catch (_) {}
        }
        if (typeof options.closeDrawer === 'function') options.closeDrawer();
        if (typeof options.afterSignOut === 'function') options.afterSignOut();
        if (reload) {
          window.setTimeout(() => {
            window.location.reload();
          }, reloadDelayMs);
        }
      },
      async changePassword(oldPassword, newPassword) {
        if (typeof options.requireToken === 'function' && !options.requireToken('change password')) return null;
        const result = await postJSON('/me/change_password', {
          old_password: oldPassword,
          new_password: newPassword,
        }, options.getToken?.() || '');
        if (typeof options.onPasswordChanged === 'function') options.onPasswordChanged(result);
        return result;
      },
      async deleteAccount({ confirmMessage = 'Are you sure you want to delete your account? This cannot be undone.' } = {}) {
        if (typeof options.requireToken === 'function' && !options.requireToken('delete account')) return false;
        if (typeof window.confirm === 'function' && !window.confirm(confirmMessage)) return false;
        await postJSON('/me/delete_account', {}, options.getToken?.() || '');
        this.signOutNow({ reload: true });
        return true;
      },
    };
  }

  const runtime = {
    DEFAULT_API_BASE,
    resolveApiBase,
    toAbsoluteUrl,
    shouldBypassBrowserCache,
    getToken,
    authHeaders,
    fetchText,
    fetchJSON,
    postJSON,
    getJSONAuth,
    requestJSONDetailed,
    isAbortError,
    polling: {
      clear: clearPoll,
      setTimeout: scheduleTimeout,
      setInterval: scheduleInterval,
      get(key) { return pollRegistry.get(key) || null; },
    },
    perf: {
      bumpCounter,
      setMetric,
      recordDuration,
      timeAsync,
    },
    createAccountActions,
  };

  if (typeof window !== 'undefined') {
    window.FrontendRuntime = runtime;
  }
})();