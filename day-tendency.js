(() => {
  const DAY_TENDENCY_REFRESH_MS = 30 * 60 * 1000;
  const DAY_TENDENCY_RETRY_MS = 10 * 1000;
  const DAY_TENDENCY_MOVE_CHECK_MS = 60 * 1000;
  const DAY_TENDENCY_MATERIAL_MOVE_METERS = 1200;
  const DAY_TENDENCY_FIRST_FIX_CHECK_MS = 1500;
  const MODE_FLAG_KEYS = {
    manhattan_mode: 'manhattan_mode_enabled',
    staten_island_mode: 'staten_island_mode_enabled',
    bronx_wash_heights_mode: 'bronx_wash_heights_mode',
    queens_mode: 'queens_mode_enabled',
    brooklyn_mode: 'brooklyn_mode_enabled',
  };

  const STATE = {
    root: null,
    marker: null,
    score: null,
    band: null,
    refreshTimer: null,
    retryTimer: null,
    resizeObserver: null,
    mutationObserver: null,
    positionPollTimer: null,
    movementCheckTimer: null,
    isRefreshing: false,
    borough: null,
    lastQueryLat: null,
    lastQueryLng: null,
    lastQueryAt: 0,
    hasInitialGpsFix: false,
    hasRenderedRealPayload: false,
    firstFixTimer: null,
  };

  function apiBase() {
    return String(window.API_BASE || '').replace(/\/$/, '');
  }

  async function fetchJSONWithTimeout(url, timeoutMs = 10000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  function ensureDayTendencyStyles() {
    if (document.getElementById('dayTendencyStyles')) return;

    const style = document.createElement('style');
    style.id = 'dayTendencyStyles';
    style.textContent = `
      .dayTendencyMeter {
        position: fixed;
        top: 56px;
        left: 12px;
        padding: 0;
        border: 0;
        background: transparent;
        box-shadow: none;
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
        z-index: 1100;
        color: #111;
        font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        pointer-events: none;
        user-select: none;
      }
      .dayTendencyInner {
        display: flex;
        align-items: flex-start;
        gap: 5px;
      }
      .dayTendencyBarWrap {
        display: flex;
        align-items: flex-start;
        gap: 5px;
      }
      .dayTendencyScale {
        position: relative;
        width: 13px;
        height: 118px;
        border-radius: 999px;
        border: 1px solid rgba(0, 0, 0, 0.18);
        background: linear-gradient(to top, #e60000 0%, #ffd400 50%, #00b050 100%);
        overflow: hidden;
      }
      .dayTendencyMarker {
        position: absolute;
        left: -1px;
        width: calc(100% + 2px);
        border-top: 2px solid #fff;
        box-shadow: 0 0 2px rgba(0, 0, 0, 0.55);
        pointer-events: none;
      }
      .dayTendencyInfoCol {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        justify-content: flex-start;
        line-height: 1.05;
        min-height: 118px;
        gap: 2px;
      }
      .dayTendencyLabelVertical {
        writing-mode: vertical-rl;
        text-orientation: upright;
        transform: none;
        font-size: 13px;
        line-height: 1;
        font-weight: 800;
        letter-spacing: 0.01em;
        color: #111;
        text-shadow: 0 1px 3px rgba(255, 255, 255, 0.9), 0 0 2px rgba(255, 255, 255, 0.75);
      }
      .dayTendencyValueStack {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        justify-content: flex-start;
        gap: 2px;
      }
      .dayTendencyScore {
        font-size: 22px;
        font-weight: 800;
        line-height: 1;
        color: #111;
        text-shadow: 0 1px 3px rgba(255, 255, 255, 0.9), 0 0 2px rgba(255, 255, 255, 0.75);
      }
      .dayTendencyBand {
        font-size: 12px;
        line-height: 1.1;
        font-weight: 700;
        color: #111;
        text-shadow: 0 1px 3px rgba(255, 255, 255, 0.9), 0 0 2px rgba(255, 255, 255, 0.75);
      }
      .dayTendencyBorough {
        font-size: 10px;
        line-height: 1.1;
        font-weight: 700;
        color: #222;
        text-shadow: 0 1px 3px rgba(255, 255, 255, 0.9), 0 0 2px rgba(255, 255, 255, 0.75);
      }
    `;
    document.head.appendChild(style);
  }

  function ensureDayTendencyRoot() {
    if (STATE.root && document.body.contains(STATE.root)) return STATE.root;

    let root = document.getElementById('dayTendencyMeter');
    if (!root) {
      root = document.createElement('div');
      root.id = 'dayTendencyMeter';
      root.className = 'dayTendencyMeter';
      root.hidden = true;
      root.setAttribute('role', 'status');
      root.setAttribute('aria-live', 'polite');
      root.innerHTML = `
        <div class="dayTendencyInner">
          <div class="dayTendencyBarWrap">
            <div class="dayTendencyScale">
              <div class="dayTendencyMarker"></div>
            </div>
            <div class="dayTendencyInfoCol">
              <div class="dayTendencyLabelVertical">Tendency</div>
              <div class="dayTendencyValueStack">
                <div class="dayTendencyScore">--</div>
                <div class="dayTendencyBand">--</div>
                <div class="dayTendencyBorough" hidden></div>
              </div>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(root);
    }

    STATE.root = root;
    STATE.marker = root.querySelector('.dayTendencyMarker');
    STATE.score = root.querySelector('.dayTendencyScore');
    STATE.band = root.querySelector('.dayTendencyBand');
    STATE.borough = root.querySelector('.dayTendencyBorough');
    return root;
  }

  function positionDayTendencyRoot() {
    const root = ensureDayTendencyRoot();
    if (!root) return;

    let top = 56;
    let left = 12;
    const badge = document.getElementById('onlineBadge');

    if (badge) {
      const rect = badge.getBoundingClientRect();
      top = rect.bottom + 8;
      left = rect.left;
    }

    const meterHeight = root.offsetHeight || 140;
    const meterWidth = root.offsetWidth || 80;
    const minTop = 8;
    const minLeft = 8;
    const maxTop = Math.max(minTop, window.innerHeight - meterHeight - 8);
    const maxLeft = Math.max(minLeft, window.innerWidth - meterWidth - 8);

    top = Math.max(minTop, Math.min(top, maxTop));
    left = Math.max(minLeft, Math.min(left, maxLeft));

    root.style.top = `${Math.round(top)}px`;
    root.style.left = `${Math.round(left)}px`;
  }

  function bandText(band) {
    const b = String(band || '').toLowerCase();
    if (b === 'high') return 'High';
    if (b === 'low') return 'Low';
    return 'Normal';
  }

  function scoreToPct(score) {
    const n = Number(score);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, n));
  }

  function isFiniteCoordPair(lat, lng) {
    return Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));
  }

  function normalizeLatLng(input) {
    if (!input || typeof input !== 'object') return null;
    const lat = Number(input.lat);
    const lng = Number(input.lng);
    if (!isFiniteCoordPair(lat, lng)) return null;
    return { lat, lng };
  }

  async function getCurrentTendencyLatLng() {
    try {
      if (typeof window.getCurrentTendencyLatLng === 'function') {
        const fromStable = normalizeLatLng(window.getCurrentTendencyLatLng());
        if (fromStable) return fromStable;
      }
    } catch (_) {}
    return null;
  }

  function readModeFlagValue(storageKey) {
    try {
      return (localStorage.getItem(storageKey) || '0') === '1' ? 1 : 0;
    } catch (_) {
      return 0;
    }
  }

  function getCurrentModeFlags() {
    return {
      manhattan_mode: readModeFlagValue(MODE_FLAG_KEYS.manhattan_mode),
      staten_island_mode: readModeFlagValue(MODE_FLAG_KEYS.staten_island_mode),
      bronx_wash_heights_mode: readModeFlagValue(MODE_FLAG_KEYS.bronx_wash_heights_mode),
      queens_mode: readModeFlagValue(MODE_FLAG_KEYS.queens_mode),
      brooklyn_mode: readModeFlagValue(MODE_FLAG_KEYS.brooklyn_mode),
    };
  }

  function haversineMeters(a, b) {
    const toRad = (x) => (x * Math.PI) / 180;
    const R = 6371000;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function movedMateriallyFromLastQuery(latLng) {
    if (!latLng) return false;
    if (!isFiniteCoordPair(STATE.lastQueryLat, STATE.lastQueryLng)) return true;
    const meters = haversineMeters(
      { lat: Number(STATE.lastQueryLat), lng: Number(STATE.lastQueryLng) },
      { lat: latLng.lat, lng: latLng.lng }
    );
    return meters > DAY_TENDENCY_MATERIAL_MOVE_METERS;
  }

  function applyDayTendencyPayload(payload) {
    const root = ensureDayTendencyRoot();
    if (!root) return false;

    if (!payload || payload.status === 'insufficient_data') {
      root.hidden = true;
      return false;
    }

    const numericScore = Number(payload.score);
    if (!Number.isFinite(numericScore)) {
      root.hidden = true;
      return false;
    }

    const scorePct = scoreToPct(numericScore);
    const pct = Number.isFinite(Number(payload?.meter_pct))
      ? Math.max(0, Math.min(100, Number(payload.meter_pct) * 100))
      : scorePct;

    const roundedScore = String(Math.round(numericScore));
    const label = payload.label || bandText(payload.band);
    const confidencePct = Number.isFinite(Number(payload?.confidence))
      ? Math.round(Number(payload.confidence) * 100)
      : 0;
    const localTimeLabel = String(payload?.local_time_label || '').trim();
    const timeBlockContext = localTimeLabel
      ? `Typical ${localTimeLabel} time blocks in this dataset`
      : 'Typical time blocks in this dataset';
    const explain = payload.explain ? ` • ${payload.explain}` : '';

    if (STATE.score) STATE.score.textContent = roundedScore;
    if (STATE.band) STATE.band.textContent = label;
    if (STATE.marker) STATE.marker.style.bottom = `${pct}%`;

    const borough = String(payload?.borough || '').trim();
    const scope = String(payload?.scope || '').trim();
    const scopeLabel = String(payload?.scope_label || '').trim();
    const sourceBorough = String(payload?.source_borough || '').trim();
    const sourceMode = String(payload?.source_mode || '').trim();
    if (STATE.borough) {
      if (borough) {
        STATE.borough.textContent = borough;
        STATE.borough.hidden = false;
      } else {
        STATE.borough.textContent = '';
        STATE.borough.hidden = true;
      }
    }

    root.title = `${label} • Score ${numericScore}/100${borough ? ` • Borough ${borough}` : ''}${scopeLabel ? ` • Scope ${scopeLabel}` : ''}${scope ? ` • Scope key ${scope}` : ''}${sourceBorough ? ` • Source borough ${sourceBorough}` : ''}${sourceMode ? ` • Source mode ${sourceMode}` : ''} • Confidence ${confidencePct}% • ${timeBlockContext}${explain}`;
    root.setAttribute(
      'aria-label',
      `Current time block tendency expected ${String(label).toLowerCase()}, score ${roundedScore} out of 100${
        borough ? `, borough ${borough}` : ''
      }, confidence ${confidencePct} percent${
        localTimeLabel ? ` for ${localTimeLabel}` : ''
      }`
    );
    root.hidden = false;
    STATE.hasRenderedRealPayload = true;
    positionDayTendencyRoot();
    return true;
  }

  function applyWaitingForGpsState() {
    const root = ensureDayTendencyRoot();
    if (!root) return;
    if (STATE.score) STATE.score.textContent = '--';
    if (STATE.band) STATE.band.textContent = 'Locating...';
    if (STATE.marker) STATE.marker.style.bottom = '50%';
    if (STATE.borough) {
      STATE.borough.textContent = '';
      STATE.borough.hidden = true;
    }
    root.title = 'Waiting for GPS location before loading tendency.';
    root.setAttribute('aria-label', 'Waiting for GPS location before loading tendency.');
    root.hidden = false;
    positionDayTendencyRoot();
  }

  function scheduleRetryIfNeeded(payload, hadError) {
    const status = String(payload?.status || '').toLowerCase();
    const explain = String(payload?.explain || '').toLowerCase();
    const shouldRetry = hadError || status === 'model_not_ready' || explain.includes('not ready');
    if (!shouldRetry || STATE.retryTimer) return;
    STATE.retryTimer = window.setTimeout(async () => {
      STATE.retryTimer = null;
      await refreshDayTendencyMeter();
    }, DAY_TENDENCY_RETRY_MS);
  }

  async function refreshDayTendencyMeter({ force = false } = {}) {
    if (STATE.isRefreshing) return;
    const latLng = await getCurrentTendencyLatLng();

    if (!latLng) {
      if (!STATE.hasInitialGpsFix && !STATE.hasRenderedRealPayload) {
        applyWaitingForGpsState();
      }
      return;
    }

    STATE.hasInitialGpsFix = true;
    if (!force && !movedMateriallyFromLastQuery(latLng) && STATE.lastQueryAt > 0) return;

    STATE.isRefreshing = true;
    let payload = null;
    let hadError = false;

    try {
      const base = apiBase();
      if (!base) throw new Error('API base missing');
      const modeFlags = getCurrentModeFlags();
      const params = new URLSearchParams({
        lat: String(latLng.lat),
        lng: String(latLng.lng),
        manhattan_mode: String(modeFlags.manhattan_mode),
        staten_island_mode: String(modeFlags.staten_island_mode),
        bronx_wash_heights_mode: String(modeFlags.bronx_wash_heights_mode),
        queens_mode: String(modeFlags.queens_mode),
        brooklyn_mode: String(modeFlags.brooklyn_mode),
      });
      const query = `?${params.toString()}`;
      payload = await fetchJSONWithTimeout(`${base}/day_tendency/today${query}`, 10000);
      STATE.lastQueryLat = latLng.lat;
      STATE.lastQueryLng = latLng.lng;
      STATE.lastQueryAt = Date.now();
      applyDayTendencyPayload(payload);
    } catch (_) {
      hadError = true;
      if (!STATE.hasRenderedRealPayload && STATE.root) STATE.root.hidden = true;
    } finally {
      scheduleRetryIfNeeded(payload, hadError);
      STATE.isRefreshing = false;
    }
  }

  function startFirstFixWatcher() {
    if (STATE.firstFixTimer) return;
    STATE.firstFixTimer = window.setInterval(async () => {
      if (STATE.hasInitialGpsFix) {
        window.clearInterval(STATE.firstFixTimer);
        STATE.firstFixTimer = null;
        return;
      }
      const latLng = await getCurrentTendencyLatLng();
      if (!latLng) {
        if (!STATE.hasRenderedRealPayload) applyWaitingForGpsState();
        return;
      }
      STATE.hasInitialGpsFix = true;
      window.clearInterval(STATE.firstFixTimer);
      STATE.firstFixTimer = null;
      refreshDayTendencyMeter({ force: true });
    }, DAY_TENDENCY_FIRST_FIX_CHECK_MS);
  }

  function startDayTendencyMeter() {
    ensureDayTendencyStyles();
    ensureDayTendencyRoot();
    positionDayTendencyRoot();

    const badge = document.getElementById('onlineBadge');

    if ('ResizeObserver' in window && badge) {
      STATE.resizeObserver = new ResizeObserver(() => positionDayTendencyRoot());
      STATE.resizeObserver.observe(badge);
    }

    if ('MutationObserver' in window && badge) {
      STATE.mutationObserver = new MutationObserver(() => positionDayTendencyRoot());
      STATE.mutationObserver.observe(badge, {
        attributes: true,
        childList: true,
        subtree: true,
      });
    }

    window.addEventListener('resize', positionDayTendencyRoot, { passive: true });
    window.addEventListener('orientationchange', positionDayTendencyRoot, { passive: true });
    window.addEventListener('scroll', positionDayTendencyRoot, { passive: true });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        positionDayTendencyRoot();
        refreshDayTendencyMeter({ force: true });
      }
    });

    STATE.positionPollTimer = window.setInterval(positionDayTendencyRoot, 5000);
    STATE.movementCheckTimer = window.setInterval(() => {
      getCurrentTendencyLatLng().then((latLng) => {
        if (!latLng) return;
        if (!movedMateriallyFromLastQuery(latLng)) return;
        if (STATE.isRefreshing) return;
        refreshDayTendencyMeter({ force: true });
      });
    }, DAY_TENDENCY_MOVE_CHECK_MS);
    STATE.refreshTimer = window.setInterval(() => {
      refreshDayTendencyMeter({ force: true });
    }, DAY_TENDENCY_REFRESH_MS);

    applyWaitingForGpsState();
    startFirstFixWatcher();

    refreshDayTendencyMeter({ force: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startDayTendencyMeter, { once: true });
  } else {
    startDayTendencyMeter();
  }
})();
