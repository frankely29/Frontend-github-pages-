(() => {
  window.TlcDayTendencyState = window.TlcDayTendencyState || {
    payload: null,
    frameContext: null,
    advancedContext: null,
    updatedAt: 0,
    lastPublishedKey: null,
    getPayload() {
      return this.payload || null;
    },
    getFrameContext() {
      return this.frameContext || null;
    },
    getAdvancedContext() {
      return this.advancedContext || null;
    }
  };

  const runtime = window.FrontendRuntime || null;
  const runtimePolling = runtime?.polling || null;
  const DAY_TENDENCY_REFRESH_MS = 30 * 60 * 1000;
  const DAY_TENDENCY_RETRY_MS = 10 * 1000;
  const DAY_TENDENCY_MOVE_CHECK_MS = 30 * 1000;
  const DAY_TENDENCY_MATERIAL_MOVE_METERS = 300;
  const DAY_TENDENCY_FIRST_FIX_CHECK_MS = 1500;
  const DAY_TENDENCY_FIRST_FIX_POLL_KEY = 'day-tendency:first-fix';
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
    visibilityBound: false,
    started: false,
    isRefreshing: false,
    requestSeq: 0,
    activeRequestSeq: 0,
    activeAbortController: null,
    borough: null,
    lastQueryLat: null,
    lastQueryLng: null,
    lastQueryAt: 0,
    hasInitialGpsFix: false,
    hasRenderedRealPayload: false,
    firstFixTimer: null,
    lastPublishedKey: null,
    lastRequestedFrameTime: null,
    lastFetchRoute: null,
    frameRouteRetryAfterMs: 0,
    frameRouteFailureCount: 0,
    frameRenderDebounceTimer: null,
  };

  function apiBase() {
    if (typeof runtime?.resolveApiBase === 'function') {
      return String(runtime.resolveApiBase()).replace(/\/$/, '');
    }
    const source =
      (typeof window !== 'undefined' && window.API_BASE !== undefined)
        ? window.API_BASE
        : ((typeof window !== 'undefined' && window.__TLC_RUNTIME_CONFIG__?.apiBase !== undefined)
            ? window.__TLC_RUNTIME_CONFIG__.apiBase
            : '');
    return String(source || '').replace(/\/$/, '');
  }

  async function fetchJSONWithTimeout(url, timeoutMs = 10000, signal = null) {
    if (runtime?.fetchJSON) {
      return runtime.fetchJSON(url, { method: 'GET', headers: { Accept: 'application/json' }, timeoutMs, signal });
    }
    const controller = signal ? null : new AbortController();
    const timeout = setTimeout(() => (controller ? controller.abort() : null), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: signal || controller?.signal,
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
    const liveFlags = window.TlcModeModule?.getModeFlags?.();
    if (liveFlags) {
      return {
        manhattan_mode: liveFlags.manhattanMode ? 1 : 0,
        staten_island_mode: liveFlags.statenIslandMode ? 1 : 0,
        bronx_wash_heights_mode: liveFlags.bronxWashHeightsMode ? 1 : 0,
        queens_mode: liveFlags.queensMode ? 1 : 0,
        brooklyn_mode: liveFlags.brooklynMode ? 1 : 0,
      };
    }

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

  function normalizeDayTendencyPayload(raw) {
    if (!raw || raw.status === 'insufficient_data') return null;

    const score = Number(raw.score);
    if (!Number.isFinite(score)) return null;

    const confidence = Number(raw.confidence);
    const rawMeterPct = Number(raw.meter_pct);
    const meterPct = Number.isFinite(rawMeterPct) ? rawMeterPct : (score / 100);

    return {
      ...raw,
      score,
      band: raw.band,
      label: raw.label,
      confidence: Number.isFinite(confidence) ? confidence : 1,
      borough: raw.borough,
      source_borough: raw.source_borough,
      scope: raw.scope,
      scope_label: raw.scope_label,
      local_time_label: raw.local_time_label,
      explain: raw.explain,
      status: raw.status,
      meter_pct: Math.max(0, Math.min(1, meterPct)),
    };
  }

  function normalizePublishString(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
  }

  function normalizePublishNumber(value, { min = null, max = null, precision = 4 } = {}) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    let clamped = n;
    if (Number.isFinite(min)) clamped = Math.max(min, clamped);
    if (Number.isFinite(max)) clamped = Math.min(max, clamped);
    return clamped.toFixed(precision);
  }

  function getCurrentFrameTimeIso() {
    const value = window.TlcModeInternals?.getCurrentFrame?.()?.time;
    const text = String(value || '').trim();
    return text || null;
  }

  function getCurrentFrameTimeLabel() {
    const iso = getCurrentFrameTimeIso();
    if (!iso) return null;
    return String(window.TlcMapUiInternals?.formatNYCTimeOnlyLabel?.(iso) || '').trim() || iso;
  }

  function getFeaturePropsAndGeom(feature) {
    if (!feature || typeof feature !== 'object') return { props: null, geom: null };
    return {
      props: feature.properties || feature.props || null,
      geom: feature.geometry || feature.geom || null,
    };
  }

  function resolveVisibleZoneScorePayload(latLng) {
    const mapUi = window.TlcMapUiInternals || null;
    const modeModule = window.TlcModeModule || null;
    if (!mapUi?.resolveZoneFeatureAtLngLat || !modeModule) return null;
    const feature = mapUi.resolveZoneFeatureAtLngLat({ lng: latLng.lng, lat: latLng.lat }) || null;
    if (!feature) return null;
    const { props, geom } = getFeaturePropsAndGeom(feature);
    if (!props) return null;

    const visibleRating = Number(modeModule.effectiveRating?.(props, geom));
    if (!Number.isFinite(visibleRating)) return null;
    const safeScore = Math.max(0, Math.min(100, visibleRating));
    const visibleBucket = String(modeModule.effectiveBucket?.(props, geom) || '').trim() || null;
    const visibleScoreSource = String(modeModule.getVisibleScoreSourceForFeature?.(props, geom) || '').trim() || 'legacy_citywide';
    const visibleScoreSourceLabel = String(modeModule.getVisibleScoreSourceLabel?.(props, geom) || '').trim() || 'Team Joseo score';
    const borough = String(props.borough || props.Borough || '').trim();
    const zoneName = String(props.zone || props.Zone || props.zone_name || props.zoneName || '').trim();
    const locationId = String(props.LocationID || props.location_id || props.locationId || '').trim();
    const localTimeLabel = getCurrentFrameTimeLabel();

    const payload = {
      status: 'ok',
      score: safeScore,
      meter_pct: Math.max(0, Math.min(1, safeScore / 100)),
      band: safeScore < 40 ? 'low' : (safeScore >= 60 ? 'high' : 'normal'),
      label: safeScore < 40 ? 'Low' : (safeScore >= 60 ? 'High' : 'Normal'),
      confidence: 1,
      borough,
      source_borough: borough,
      scope: visibleScoreSource,
      scope_label: visibleScoreSourceLabel,
      source_mode: 'frontend_visible_zone_score',
      explain: 'Live visible Team Joseo zone score',
      local_time_label: localTimeLabel || '',
      zone_name: zoneName || undefined,
      location_id: locationId || undefined,
      bucket: visibleBucket || undefined,
    };

    const frameContext = {
      source: 'frontend_visible_zone_score',
      frame_time: getCurrentFrameTimeIso() || null,
      resolved_scope: {
        scope: visibleScoreSource,
        scope_label: visibleScoreSourceLabel,
      },
      active_zone: {
        location_id: locationId || null,
        zone_name: zoneName || null,
        borough: borough || null,
      }
    };

    const advancedContext = {
      source_of_truth: 'frontend_visible_zone_score',
      source: 'frontend_visible_zone_score',
      ready_for_frontend_adjustment: false,
      global_penalty_points: 0,
      local_penalty_points: 0,
      total_penalty_cap: 0,
      bucket_drop_cap: 0,
      local_scope: visibleScoreSource,
      local_scope_label: visibleScoreSourceLabel,
      local_scope_kind: 'frontend_visible_scope',
      local_source_borough: borough || '',
      local_source_mode: 'frontend_visible_zone_score',
    };

    return { payload, frameContext, advancedContext };
  }

  function normalizeRouteErrorStatus(error) {
    const status = Number(error?.status);
    return Number.isFinite(status) ? status : null;
  }

  function isFrameContextRouteUnavailable(error) {
    const status = normalizeRouteErrorStatus(error);
    if (status === 404 || status === 400) return true;
    const message = String(error?.message || '').toLowerCase();
    return (
      message.includes('failed to fetch') ||
      message.includes('networkerror') ||
      message.includes('network request failed') ||
      message.includes('load failed')
    );
  }

  function canRetryFrameRouteNow() {
    return Date.now() >= Number(STATE.frameRouteRetryAfterMs || 0);
  }

  function pickVisiblePayloadFromFrameContext(frameContextResponse) {
    const local = normalizeDayTendencyPayload(frameContextResponse?.local_context);
    if (local && String(local.status || '').toLowerCase() === 'ok') return local;
    const global = normalizeDayTendencyPayload(frameContextResponse?.global_context);
    if (global && String(global.status || '').toLowerCase() === 'ok') return global;
    return null;
  }

  function buildDayTendencyPublishKey(normalizedPayload) {
    if (!normalizedPayload) return 'null';
    return [
      `status:${normalizePublishString(normalizedPayload.status)}`,
      `score:${normalizePublishNumber(normalizedPayload.score, { min: 0, max: 100, precision: 2 })}`,
      `confidence:${normalizePublishNumber(normalizedPayload.confidence, { min: 0, max: 1, precision: 4 })}`,
      `meter_pct:${normalizePublishNumber(normalizedPayload.meter_pct, { min: 0, max: 1, precision: 4 })}`,
      `band:${normalizePublishString(normalizedPayload.band)}`,
      `label:${normalizePublishString(normalizedPayload.label)}`,
      `borough:${normalizePublishString(normalizedPayload.borough)}`,
      `source_borough:${normalizePublishString(normalizedPayload.source_borough)}`,
      `source_mode:${normalizePublishString(normalizedPayload.source_mode)}`,
      `scope:${normalizePublishString(normalizedPayload.scope)}`,
      `scope_label:${normalizePublishString(normalizedPayload.scope_label)}`,
      `local_time_label:${normalizePublishString(normalizedPayload.local_time_label)}`,
      `explain:${normalizePublishString(normalizedPayload.explain)}`,
    ].join('|');
  }

  // the meter UI is separate from map coloring.
  // app.part11.js consumes this shared payload to bias the final mode-aware rating.
  function publishDayTendencyState({ payload, frameContext = null, advancedContext = null, route = null } = {}) {
    const normalizedPayload = normalizeDayTendencyPayload(payload);
    const payloadKey = buildDayTendencyPublishKey(normalizedPayload);
    const frameKey = normalizePublishString(frameContext?.frame_time || frameContext?.request?.frame_time);
    const advancedReady = String(Boolean(advancedContext?.ready_for_frontend_adjustment));
    const advancedGlobal = normalizePublishNumber(advancedContext?.global_penalty_points, { min: 0, max: 100, precision: 2 });
    const advancedLocal = normalizePublishNumber(advancedContext?.local_penalty_points, { min: 0, max: 100, precision: 2 });
    const advancedCap = normalizePublishNumber(advancedContext?.total_penalty_cap, { min: 0, max: 100, precision: 2 });
    const dropCap = normalizePublishNumber(advancedContext?.bucket_drop_cap, { min: 0, max: 8, precision: 0 });
    const advancedLocalScope = normalizePublishString(advancedContext?.local_scope);
    const advancedLocalScopeLabel = normalizePublishString(advancedContext?.local_scope_label);
    const advancedLocalScopeKind = normalizePublishString(advancedContext?.local_scope_kind);
    const advancedLocalSourceBorough = normalizePublishString(advancedContext?.local_source_borough);
    const advancedLocalSourceMode = normalizePublishString(advancedContext?.local_source_mode);
    const advancedLocalScopeSpecificity = normalizePublishString(advancedContext?.local_context_source_scope_specificity);
    const advancedLocalModelLayer = normalizePublishString(advancedContext?.local_context_source_model_layer);
    const advancedLocalSpecificityWeight = normalizePublishNumber(advancedContext?.local_context_context_specificity_weight, { min: 0, max: 1, precision: 4 });
    const advancedLocalExactScopeSpecific = normalizePublishString(advancedContext?.local_context_exact_scope_specific);
    const advancedLocalBroadScopeFallback = normalizePublishString(advancedContext?.local_context_broad_scope_fallback);
    const frameResolvedScope = normalizePublishString(frameContext?.resolved_scope?.scope);
    const frameResolvedScopeLabel = normalizePublishString(frameContext?.resolved_scope?.scope_label);
    const routeKey = normalizePublishString(route || STATE.lastFetchRoute);
    const nextKey = [
      payloadKey,
      `frame:${frameKey}`,
      `ready:${advancedReady}`,
      `g:${advancedGlobal}`,
      `l:${advancedLocal}`,
      `cap:${advancedCap}`,
      `drop:${dropCap}`,
      `adv_scope:${advancedLocalScope}`,
      `adv_scope_label:${advancedLocalScopeLabel}`,
      `adv_scope_kind:${advancedLocalScopeKind}`,
      `adv_src_borough:${advancedLocalSourceBorough}`,
      `adv_src_mode:${advancedLocalSourceMode}`,
      `adv_scope_specificity:${advancedLocalScopeSpecificity}`,
      `adv_model_layer:${advancedLocalModelLayer}`,
      `adv_specificity_weight:${advancedLocalSpecificityWeight}`,
      `adv_exact_scope_specific:${advancedLocalExactScopeSpecific}`,
      `adv_broad_scope_fallback:${advancedLocalBroadScopeFallback}`,
      `frame_scope:${frameResolvedScope}`,
      `frame_scope_label:${frameResolvedScopeLabel}`,
      `route:${routeKey}`
    ].join('|');
    const prevKey = String(STATE.lastPublishedKey ?? window.TlcDayTendencyState?.lastPublishedKey ?? 'null');
    if (nextKey === prevKey) return normalizedPayload;

    STATE.lastPublishedKey = nextKey;
    window.TlcDayTendencyState.payload = normalizedPayload;
    window.TlcDayTendencyState.frameContext = frameContext || null;
    window.TlcDayTendencyState.advancedContext = advancedContext || null;
    window.TlcDayTendencyState.lastPublishedKey = nextKey;
    window.TlcDayTendencyState.updatedAt = Date.now();
    window.dispatchEvent(new CustomEvent('tlc-day-tendency-updated', { detail: normalizedPayload }));
    return normalizedPayload;
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

  function applyNoZoneResolvedState() {
    const root = ensureDayTendencyRoot();
    if (!root) return;
    if (STATE.score) STATE.score.textContent = '--';
    if (STATE.band) STATE.band.textContent = 'Waiting...';
    if (STATE.marker) STATE.marker.style.bottom = '50%';
    if (STATE.borough) {
      STATE.borough.textContent = '';
      STATE.borough.hidden = true;
    }
    root.title = 'Waiting for an active visible zone score at current location.';
    root.setAttribute('aria-label', 'Waiting for active visible zone score at current location.');
    root.hidden = false;
    positionDayTendencyRoot();
  }

  function scheduleRetryIfNeeded(payload, hadError) {
    const status = String(payload?.status || '').toLowerCase();
    const explain = String(payload?.explain || '').toLowerCase();
    const shouldRetry = hadError || status === 'model_not_ready' || explain.includes('not ready');
    if (!shouldRetry || STATE.retryTimer) return;
    const runner = async () => {
      STATE.retryTimer = null;
      await refreshDayTendencyMeter();
    };
    STATE.retryTimer = runtimePolling
      ? runtimePolling.setTimeout('day-tendency:retry', runner, DAY_TENDENCY_RETRY_MS)
      : window.setTimeout(runner, DAY_TENDENCY_RETRY_MS);
  }

  function handleGpsLossState() {
    STATE.lastQueryLat = null;
    STATE.lastQueryLng = null;
    STATE.lastQueryAt = 0;
    STATE.hasInitialGpsFix = false;
    applyWaitingForGpsState();
    publishDayTendencyState({ payload: null, frameContext: null, advancedContext: null, route: null });
    startFirstFixWatcher();
  }

  async function refreshDayTendencyMeter({ force = false } = {}) {
    const latLng = await getCurrentTendencyLatLng();

    if (!latLng) {
      handleGpsLossState();
      return;
    }

    STATE.hasInitialGpsFix = true;
    if (!force && !movedMateriallyFromLastQuery(latLng) && STATE.lastQueryAt > 0) return;

    const requestSeq = ++STATE.requestSeq;
    STATE.activeRequestSeq = requestSeq;
    if (STATE.activeAbortController) {
      try { STATE.activeAbortController.abort(); } catch (_) {}
    }
    const abortController = new AbortController();
    STATE.activeAbortController = abortController;
    STATE.isRefreshing = true;

    let payload = null;
    let frameContext = null;
    let advancedContext = null;
    let hadError = false;

    try {
      STATE.lastRequestedFrameTime = getCurrentFrameTimeIso();
      const localDerived = resolveVisibleZoneScorePayload(latLng);
      if (localDerived) {
        payload = normalizeDayTendencyPayload(localDerived.payload);
        frameContext = localDerived.frameContext;
        advancedContext = localDerived.advancedContext;
      }
      STATE.frameRouteFailureCount = 0;
      STATE.frameRouteRetryAfterMs = 0;
      STATE.lastFetchRoute = 'frontend_visible_zone_score';

      if (requestSeq !== STATE.requestSeq) return;
      STATE.lastQueryLat = latLng.lat;
      STATE.lastQueryLng = latLng.lng;
      STATE.lastQueryAt = Date.now();
      if (payload) applyDayTendencyPayload(payload);
      else applyNoZoneResolvedState();
      publishDayTendencyState({ payload, frameContext, advancedContext, route: STATE.lastFetchRoute });
    } catch (error) {
      if (abortController.signal.aborted || requestSeq !== STATE.requestSeq) return;
      hadError = true;
      publishDayTendencyState({ payload: null, frameContext: null, advancedContext: null, route: null });
      if (!STATE.hasRenderedRealPayload && STATE.root) STATE.root.hidden = true;
    } finally {
      if (requestSeq === STATE.activeRequestSeq) {
        STATE.isRefreshing = false;
      }
      scheduleRetryIfNeeded(payload, hadError);
    }
  }

  function startFirstFixWatcher() {
    if (STATE.firstFixTimer) return;
    const runner = async () => {
      if (STATE.hasInitialGpsFix) {
        clearFirstFixWatcher();
        return;
      }
      const latLng = await getCurrentTendencyLatLng();
      if (!latLng) {
        if (!STATE.hasRenderedRealPayload) applyWaitingForGpsState();
        return;
      }
      STATE.hasInitialGpsFix = true;
      clearFirstFixWatcher();
      refreshDayTendencyMeter({ force: true });
    };
    STATE.firstFixTimer = runtimePolling
      ? runtimePolling.setInterval(DAY_TENDENCY_FIRST_FIX_POLL_KEY, runner, DAY_TENDENCY_FIRST_FIX_CHECK_MS)
      : window.setInterval(runner, DAY_TENDENCY_FIRST_FIX_CHECK_MS);
  }

  function clearFirstFixWatcher() {
    if (runtimePolling) {
      runtimePolling.clear(DAY_TENDENCY_FIRST_FIX_POLL_KEY);
    } else if (STATE.firstFixTimer) {
      window.clearInterval(STATE.firstFixTimer);
    }
    STATE.firstFixTimer = null;
  }

  function startDayTendencyMeter() {
    if (STATE.started) return;
    STATE.started = true;
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

    if (!STATE.visibilityBound) {
      STATE.visibilityBound = true;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          positionDayTendencyRoot();
          refreshDayTendencyMeter({ force: true });
        }
      });
    }

    window.addEventListener('tlc-mode-changed', () => {
      refreshDayTendencyMeter({ force: true });
    });

    window.addEventListener('team-joseo-frame-rendered', () => {
      if (STATE.frameRenderDebounceTimer) {
        window.clearTimeout(STATE.frameRenderDebounceTimer);
      }
      STATE.frameRenderDebounceTimer = window.setTimeout(() => {
        STATE.frameRenderDebounceTimer = null;
        refreshDayTendencyMeter({ force: true });
      }, 120);
    });

    STATE.positionPollTimer = runtimePolling
      ? runtimePolling.setInterval('day-tendency:position', positionDayTendencyRoot, 5000)
      : window.setInterval(positionDayTendencyRoot, 5000);
    STATE.movementCheckTimer = runtimePolling
      ? runtimePolling.setInterval('day-tendency:movement', () => {
        getCurrentTendencyLatLng().then((latLng) => {
          if (!latLng) {
            handleGpsLossState();
            return;
          }
          if (!movedMateriallyFromLastQuery(latLng)) return;
          if (STATE.isRefreshing) return;
          refreshDayTendencyMeter({ force: true });
        });
      }, DAY_TENDENCY_MOVE_CHECK_MS)
      : window.setInterval(() => {
      getCurrentTendencyLatLng().then((latLng) => {
        if (!latLng) {
          handleGpsLossState();
          return;
        }
        if (!movedMateriallyFromLastQuery(latLng)) return;
        if (STATE.isRefreshing) return;
        refreshDayTendencyMeter({ force: true });
      });
    }, DAY_TENDENCY_MOVE_CHECK_MS);
    STATE.refreshTimer = runtimePolling
      ? runtimePolling.setInterval('day-tendency:refresh', () => {
        refreshDayTendencyMeter({ force: true });
      }, DAY_TENDENCY_REFRESH_MS)
      : window.setInterval(() => {
        refreshDayTendencyMeter({ force: true });
      }, DAY_TENDENCY_REFRESH_MS);

    applyWaitingForGpsState();
    startFirstFixWatcher();

    refreshDayTendencyMeter({ force: true });
  }

  window.getDayTendencyMeterDebug = function () {
    return {
      payload: window.TlcDayTendencyState?.payload || null,
      frameContext: window.TlcDayTendencyState?.frameContext || null,
      advancedContext: window.TlcDayTendencyState?.advancedContext || null,
      updatedAt: window.TlcDayTendencyState?.updatedAt || 0,
      lastPublishedKey: window.TlcDayTendencyState?.lastPublishedKey ?? null,
      lastQueryAt: STATE.lastQueryAt || 0,
      lastQueryLat: STATE.lastQueryLat ?? null,
      lastQueryLng: STATE.lastQueryLng ?? null,
      hasInitialGpsFix: !!STATE.hasInitialGpsFix,
      hasRenderedRealPayload: !!STATE.hasRenderedRealPayload,
      lastRequestedFrameTime: STATE.lastRequestedFrameTime || null,
      lastFetchRoute: STATE.lastFetchRoute || null,
      frameRouteFailureCount: Number(STATE.frameRouteFailureCount || 0),
      frameRouteRetryAfterMs: Number(STATE.frameRouteRetryAfterMs || 0),
      canRetryFrameRouteNow: canRetryFrameRouteNow()
    };
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startDayTendencyMeter, { once: true });
  } else {
    startDayTendencyMeter();
  }
})();
