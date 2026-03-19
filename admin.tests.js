(function () {
  const GROUPS = [
    {
      label: 'Backend/API',
      tests: [
        { key: 'backend-status', label: 'Test Backend Status', path: '/admin/tests/backend-status' },
        { key: 'timeline', label: 'Test Timeline Ready', path: '/admin/tests/timeline' },
        { key: 'frame-current', label: 'Test Current Frame', path: '/admin/tests/frame-current' },
        { key: 'admin-auth', label: 'Test Admin Auth', path: '/admin/tests/admin-auth' },
      ],
    },
    {
      label: 'Community / Presence',
      tests: [
        { key: 'presence-summary', label: 'Test Presence Summary', path: '/admin/tests/presence-summary' },
        { key: 'presence-live', label: 'Test Presence Live Feed', path: '/admin/tests/presence-live' },
        { key: 'presence-endpoint', label: 'Test Shared Presence Endpoint', path: '/admin/tests/presence-endpoint' },
        { key: 'me', label: 'Test My Session / Me Endpoint', path: '/admin/tests/me' },
      ],
    },
    {
      label: 'Trips / Reports',
      tests: [
        { key: 'trips-summary', label: 'Test Trips Summary', path: '/admin/tests/trips-summary' },
        { key: 'trips-recent', label: 'Test Recent Trips', path: '/admin/tests/trips-recent' },
        { key: 'police-reports', label: 'Test Police Reports', path: '/admin/tests/police-reports' },
        { key: 'pickup-reports', label: 'Test Pickup Reports', path: '/admin/tests/pickup-reports' },
        { key: 'pickup-hotspots-live', label: 'Test Pickup Hotspot Generation', path: '/events/pickups/recent?limit=200&zone_sample_limit=100&debug=1' },
        { key: 'pickup-overlay-endpoint', label: 'Test Shared Pickup Overlay Endpoint', path: '/admin/tests/pickup-overlay-endpoint' },
      ],
    },
    {
      label: 'Optional External/Client checks',
      tests: [
        { key: 'weather-api', label: 'Test Weather API request', type: 'client' },
        { key: 'radio-ui', label: 'Test radio/audio availability only at the UI/client level if already feasible without changing app behavior', type: 'client' },
        { key: 'admin-session', label: 'Test local admin session state', type: 'client' },
        { key: 'client-community-smoke', label: 'Test Client Community Smoke', type: 'client' },
      ],
    },
  ];

  const LOAD_PRESETS = [100, 300, 500, 1000];
  const DEFAULT_LOAD_OPTIONS = Object.freeze({
    preset: 100,
    duration_sec: 60,
    mode: 'map_core',
    include_presence_writes: true,
    include_presence_viewport_reads: true,
    include_presence_summary_reads: true,
    include_presence_delta_reads: true,
    include_pickup_overlay_reads: false,
    include_leaderboard_reads: false,
    include_chat_lite: false,
  });
  const LOAD_POLL_MS = 2000;

  function summarize(data, c) {
    if (data === null || data === undefined) return 'No response body.';
    if (typeof data !== 'object') return String(data);
    const entries = Object.entries(data).slice(0, 4);
    if (!entries.length) return 'Empty response object.';
    return entries.map(([k, v]) => `${c.toLabel(k)}: ${c.formatValue(v)}`).join(' • ');
  }

  function flattenRows(data, c) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return '';
    const entries = Object.entries(data);
    if (!entries.length) return '';
    return `<div class="adminListMini">${entries.slice(0, 8).map(([k, v]) => `<div class="adminKV"><span>${c.esc(c.toLabel(k))}</span><strong>${c.esc(c.formatValue(v))}</strong></div>`).join('')}</div>`;
  }

  function statusFrom(ok, data) {
    if (ok === false) return 'fail';
    if (data && typeof data === 'object') {
      if (data.ok === false || data.success === false || data.status === 'fail' || data.status === 'error') return 'fail';
    }
    return 'pass';
  }

  function safeNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function safeInteger(value, fallback = 0) {
    return Math.round(safeNumber(value, fallback));
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function toArray(value) {
    if (Array.isArray(value)) return value.filter((entry) => entry !== undefined && entry !== null && entry !== '');
    if (value === undefined || value === null || value === '') return [];
    return [value];
  }

  function pickFirst(source, paths) {
    for (const path of paths) {
      const parts = String(path).split('.');
      let cursor = source;
      let found = true;
      for (const part of parts) {
        if (!cursor || typeof cursor !== 'object' || !(part in cursor)) {
          found = false;
          break;
        }
        cursor = cursor[part];
      }
      if (found && cursor !== undefined) return cursor;
    }
    return undefined;
  }

  function normalizeStatus(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text) return 'idle';
    if (['ok', 'passed', 'complete_pass', 'completed_pass', 'success'].includes(text)) return 'pass';
    if (['failed', 'complete_fail', 'completed_fail'].includes(text)) return 'fail';
    if (['stopping', 'cancelling', 'canceling'].includes(text)) return 'stopped';
    return text;
  }

  function isActiveLoadStatus(status) {
    return ['running', 'starting', 'queued', 'in_progress', 'active'].includes(normalizeStatus(status));
  }

  function formatLoadStatus(status) {
    const normalized = normalizeStatus(status);
    if (normalized === 'pass') return 'PASS';
    if (normalized === 'fail') return 'FAIL';
    if (normalized === 'stopped') return 'Stopped';
    if (normalized === 'error') return 'Error';
    if (normalized === 'running') return 'Running';
    if (normalized === 'unsupported') return 'Unavailable';
    return normalized ? normalized.replace(/[_-]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()) : 'Idle';
  }

  function loadTone(status) {
    const normalized = normalizeStatus(status);
    if (normalized === 'pass') return 'yes';
    if (normalized === 'fail' || normalized === 'error') return 'no';
    if (normalized === 'running') return 'warn';
    if (normalized === 'stopped') return 'muted';
    return 'muted';
  }

  function copyText(text) {
    if (navigator?.clipboard?.writeText) return navigator.clipboard.writeText(text);
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', 'readonly');
    el.style.position = 'absolute';
    el.style.left = '-9999px';
    document.body.appendChild(el);
    el.select();
    try {
      document.execCommand('copy');
      document.body.removeChild(el);
      return Promise.resolve();
    } catch (error) {
      document.body.removeChild(el);
      return Promise.reject(error);
    }
  }

  function formatPercent(value) {
    const num = safeNumber(value, NaN);
    if (!Number.isFinite(num)) return '—';
    return `${num.toFixed(num >= 10 ? 0 : 1)}%`;
  }

  function formatDuration(value) {
    const num = safeNumber(value, NaN);
    if (!Number.isFinite(num)) return '—';
    return `${num.toFixed(num >= 10 ? 0 : 1)}s`;
  }

  function formatLatency(value) {
    const num = safeNumber(value, NaN);
    if (!Number.isFinite(num)) return '—';
    return `${num.toFixed(num >= 100 ? 0 : num >= 10 ? 1 : 2)} ms`;
  }

  function formatBytes(value) {
    const num = safeNumber(value, NaN);
    if (!Number.isFinite(num)) return '—';
    if (Math.abs(num) < 1024) return `${num.toFixed(0)} B`;
    if (Math.abs(num) < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
    return `${(num / (1024 * 1024)).toFixed(2)} MB`;
  }

  function normalizeDriverCount(value) {
    const count = safeInteger(value, DEFAULT_LOAD_OPTIONS.preset);
    if (LOAD_PRESETS.includes(count)) return count;
    return DEFAULT_LOAD_OPTIONS.preset;
  }

  function normalizeDuration(value) {
    return clamp(safeInteger(value, DEFAULT_LOAD_OPTIONS.duration_sec), 5, 600);
  }

  function normalizeMode(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'map_core') return 'map_core';
    if (['map+chat', 'map_chat', 'map-chat', 'chat', 'map_plus_chat'].includes(normalized)) return 'map_plus_chat';
    return 'map_core';
  }

  function normalizeLoadConfig(source) {
    const config = source && typeof source === 'object' ? source : {};
    const normalized = {};
    const driverCount = pickFirst(config, ['preset', 'driverCount', 'driver_count', 'drivers', 'config.preset', 'config.driver_count', 'selected_preset']);
    const durationSeconds = pickFirst(config, ['duration_sec', 'durationSeconds', 'duration_seconds', 'duration', 'config.duration_sec', 'config.duration_seconds']);
    const mode = pickFirst(config, ['mode', 'scenario_mode', 'config.mode']);
    const includePresenceWrites = pickFirst(config, ['include_presence_writes', 'includePresenceWrites', 'config.include_presence_writes']);
    const includeViewportReads = pickFirst(config, ['include_presence_viewport_reads', 'includeViewportReads', 'include_viewport_reads', 'config.include_presence_viewport_reads', 'config.include_viewport_reads']);
    const includeSummaryReads = pickFirst(config, ['include_presence_summary_reads', 'includeSummaryReads', 'include_summary_reads', 'config.include_presence_summary_reads', 'config.include_summary_reads']);
    const includeDeltaReads = pickFirst(config, ['include_presence_delta_reads', 'includeDeltaReads', 'include_delta_reads', 'config.include_presence_delta_reads', 'config.include_delta_reads']);
    const includePickupOverlayReads = pickFirst(config, ['include_pickup_overlay_reads', 'includePickupOverlayReads', 'config.include_pickup_overlay_reads']);
    const includeLeaderboardReads = pickFirst(config, ['include_leaderboard_reads', 'includeLeaderboardReads', 'config.include_leaderboard_reads']);
    const includeChatLite = pickFirst(config, ['include_chat_lite', 'includeChatLite', 'chat_lite_enabled', 'config.include_chat_lite']);

    if (driverCount !== undefined) normalized.preset = normalizeDriverCount(driverCount);
    if (durationSeconds !== undefined) normalized.duration_sec = normalizeDuration(durationSeconds);
    if (mode !== undefined) normalized.mode = normalizeMode(mode);
    if (includePresenceWrites !== undefined) normalized.include_presence_writes = !!includePresenceWrites;
    if (includeViewportReads !== undefined) normalized.include_presence_viewport_reads = !!includeViewportReads;
    if (includeSummaryReads !== undefined) normalized.include_presence_summary_reads = !!includeSummaryReads;
    if (includeDeltaReads !== undefined) normalized.include_presence_delta_reads = !!includeDeltaReads;
    if (includePickupOverlayReads !== undefined) normalized.include_pickup_overlay_reads = !!includePickupOverlayReads;
    if (includeLeaderboardReads !== undefined) normalized.include_leaderboard_reads = !!includeLeaderboardReads;
    if (includeChatLite !== undefined) normalized.include_chat_lite = !!includeChatLite;
    return normalized;
  }

  function buildLoadRequestBody(config) {
    return {
      preset: config.preset,
      duration_sec: config.duration_sec,
      mode: config.mode,
      include_presence_writes: !!config.include_presence_writes,
      include_presence_viewport_reads: !!config.include_presence_viewport_reads,
      include_presence_summary_reads: !!config.include_presence_summary_reads,
      include_presence_delta_reads: !!config.include_presence_delta_reads,
      include_pickup_overlay_reads: !!config.include_pickup_overlay_reads,
      include_leaderboard_reads: !!config.include_leaderboard_reads,
      include_chat_lite: !!config.include_chat_lite,
    };
  }

  function extractLoadErrorMessage(error, fallback) {
    const detail = error?.detail;
    const payload = error?.payload;
    const pieces = [
      pickFirst(detail, ['detail', 'message', 'error']),
      pickFirst(payload, ['detail.detail', 'detail.message', 'detail.error', 'detail', 'message', 'error']),
      error?.message,
    ];
    const text = pieces
      .flatMap((value) => toArray(value))
      .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
      .find((value) => String(value || '').trim());
    return String(text || fallback || 'Request failed').trim();
  }

  function pushReason(target, value) {
    toArray(value).forEach((entry) => {
      const text = String(entry && typeof entry === 'object'
        ? entry.reason || entry.message || entry.summary || JSON.stringify(entry)
        : entry || '').trim();
      if (text) target.push(text);
    });
  }

  function collectReasons(raw, status) {
    const reasons = [];
    pushReason(reasons, pickFirst(raw, ['summary.top_reasons', 'top_reasons', 'reasons', 'failure_reasons', 'debug.reasons', 'debug.failure_reasons']));

    const checks = toArray(pickFirst(raw, ['checks', 'summary.checks', 'debug.checks']));
    checks.forEach((check) => {
      if (!check || typeof check !== 'object') return;
      const checkStatus = normalizeStatus(check.status || check.result);
      if (checkStatus === 'fail' || check.failed === true) {
        const label = check.label || check.name || check.metric || 'Check';
        const message = check.reason || check.message || check.summary || `${label} exceeded threshold.`;
        pushReason(reasons, `${label}: ${message}`);
      }
    });

    if (!reasons.length && normalizeStatus(status) === 'pass') {
      pushReason(reasons, pickFirst(raw, ['summary.pass_reasons', 'summary.notes', 'notes']));
    }

    return [...new Set(reasons)].slice(0, 6);
  }

  function collectMetrics(raw, config) {
    const metrics = [];
    const add = (label, value, formatter) => {
      if (value === undefined || value === null || value === '') return;
      metrics.push({ label, value: formatter ? formatter(value) : String(value) });
    };

    add('Driver count', pickFirst(raw, ['preset', 'driver_count', 'drivers', 'config.preset', 'config.driver_count', 'summary.preset', 'summary.driver_count']) ?? config.preset);
    add('Duration', pickFirst(raw, ['duration_sec', 'duration_seconds', 'config.duration_sec', 'config.duration_seconds', 'summary.duration_sec', 'summary.duration_seconds']) ?? config.duration_sec, formatDuration);
    add('Total operations', pickFirst(raw, ['total_operations', 'summary.total_operations', 'metrics.total_operations', 'debug.total_operations']));
    add('Error rate', pickFirst(raw, ['error_rate', 'summary.error_rate', 'metrics.error_rate', 'debug.error_rate']), formatPercent);
    add('Presence write p50', pickFirst(raw, ['presence_write_p50_ms', 'metrics.presence_write.p50_ms', 'debug.presence_write.p50_ms']), formatLatency);
    add('Presence write p95', pickFirst(raw, ['presence_write_p95_ms', 'metrics.presence_write.p95_ms', 'debug.presence_write.p95_ms']), formatLatency);
    add('Viewport read p50', pickFirst(raw, ['viewport_read_p50_ms', 'metrics.viewport_read.p50_ms', 'debug.viewport_read.p50_ms']), formatLatency);
    add('Viewport read p95', pickFirst(raw, ['viewport_read_p95_ms', 'metrics.viewport_read.p95_ms', 'debug.viewport_read.p95_ms']), formatLatency);
    add('Summary read p50', pickFirst(raw, ['summary_read_p50_ms', 'metrics.summary_read.p50_ms', 'debug.summary_read.p50_ms']), formatLatency);
    add('Summary read p95', pickFirst(raw, ['summary_read_p95_ms', 'metrics.summary_read.p95_ms', 'debug.summary_read.p95_ms']), formatLatency);
    add('Delta read p50', pickFirst(raw, ['delta_read_p50_ms', 'metrics.delta_read.p50_ms', 'debug.delta_read.p50_ms']), formatLatency);
    add('Delta read p95', pickFirst(raw, ['delta_read_p95_ms', 'metrics.delta_read.p95_ms', 'debug.delta_read.p95_ms']), formatLatency);
    add('Chat p50', pickFirst(raw, ['chat_p50_ms', 'metrics.chat.p50_ms', 'debug.chat.p50_ms', 'metrics.chat_lite.p50_ms']), formatLatency);
    add('Chat p95', pickFirst(raw, ['chat_p95_ms', 'metrics.chat.p95_ms', 'debug.chat.p95_ms', 'metrics.chat_lite.p95_ms']), formatLatency);
    add('Memory growth', pickFirst(raw, ['memory_growth_bytes', 'metrics.memory_growth_bytes', 'debug.memory_growth_bytes', 'memory.growth_bytes']), formatBytes);

    return metrics;
  }

  function buildLoadSummary(normalized) {
    const reasons = normalized.reasons.length ? normalized.reasons : ['No detailed reasons returned.'];
    const metricLines = normalized.metrics.slice(0, 6).map((metric) => `${metric.label}: ${metric.value}`);
    return [
      `Status: ${formatLoadStatus(normalized.status)}`,
      `Preset: ${normalized.config.preset} drivers`,
      `Duration: ${normalized.config.duration_sec}s`,
      `Mode: ${normalized.config.mode === 'map_plus_chat' ? 'Map + Chat' : 'Map Core'}`,
      `Summary: ${normalized.summary}`,
      `Reasons: ${reasons.join(' | ')}`,
      metricLines.length ? `Metrics: ${metricLines.join(' | ')}` : 'Metrics: none returned',
    ].join('\n');
  }

  function normalizeLoadResponse(payload, fallbackConfig) {
    const raw = payload && typeof payload === 'object' ? payload : {};
    const status = normalizeStatus(pickFirst(raw, ['status', 'state', 'result.status', 'run.status']) || 'idle');
    const config = {
      ...DEFAULT_LOAD_OPTIONS,
      ...fallbackConfig,
      ...normalizeLoadConfig(raw),
    };
    const progressValue = pickFirst(raw, ['progress_percent', 'progress.percent', 'run.progress_percent', 'result.progress_percent']);
    const elapsedValue = pickFirst(raw, ['elapsed_seconds', 'elapsed', 'run.elapsed_seconds', 'result.elapsed_seconds']);
    const summaryLine = pickFirst(raw, ['summary.line', 'summary.text', 'summary', 'message', 'detail']) || '';
    const reasons = collectReasons(raw, status);
    const metrics = collectMetrics(raw, config);
    const summary = typeof summaryLine === 'string' && summaryLine.trim()
        ? summaryLine.trim()
        : normalizeStatus(status) === 'pass'
          ? `PASS — all enabled checks stayed within thresholds for ${config.preset} drivers.`
        : normalizeStatus(status) === 'fail'
          ? `FAIL — one or more enabled checks exceeded thresholds at the ${config.preset}-driver preset.`
          : normalizeStatus(status) === 'running'
            ? `Running synthetic load test for ${config.preset} drivers.`
            : normalizeStatus(status) === 'stopped'
              ? 'Load test was stopped before completion.'
              : normalizeStatus(status) === 'error'
                ? 'Backend returned an error for the synthetic load test.'
                : 'No synthetic load test has been started yet.';

    return {
      raw,
      status,
      active: isActiveLoadStatus(status),
      unsupported: status === 'unsupported' || raw.supported === false || raw.available === false,
      progressPercent: clamp(safeNumber(progressValue, status === 'pass' || status === 'fail' ? 100 : 0), 0, 100),
      elapsedSeconds: safeNumber(elapsedValue, 0),
      summary,
      reasons,
      metrics,
      debug: pickFirst(raw, ['debug', 'result.debug']) ?? raw,
      config,
      errorMessage: pickFirst(raw, ['error', 'message']) || '',
      checks: toArray(pickFirst(raw, ['checks', 'summary.checks', 'debug.checks'])),
      updatedAt: Date.now(),
    };
  }

  function parsePickupHotspotResult(response) {
    const data = response?.data || {};
    const debug = data.pickup_hotspot_debug || {};
    const zones = Array.isArray(debug.zone_debug) ? debug.zone_debug : [];

    const qualifiedZones = zones.filter((zone) => {
      const pointCount = safeNumber(zone?.point_count);
      const minThreshold = safeNumber(zone?.min_points_threshold);
      return pointCount >= minThreshold && minThreshold > 0;
    });

    const renderedQualifiedZones = qualifiedZones.filter((zone) => {
      const zoneHotspotCount = safeNumber(zone?.hotspot_feature_count);
      const zoneMicroCount = safeNumber(zone?.micro_hotspot_count);
      return zoneHotspotCount > 0 || zoneMicroCount > 0 || zone?.feature_emitted === true;
    });

    const zoneHotspotCount = zones.reduce((total, zone) => total + safeNumber(zone?.hotspot_feature_count), 0);
    const topLevelMicroCount = Array.isArray(debug.micro_hotspots)
      ? debug.micro_hotspots.length
      : safeNumber(debug.micro_hotspot_count);

    const emittedMicroFromZones = zones.reduce((total, zone) => total + safeNumber(zone?.micro_hotspot_count), 0);
    const orphanMicroCount = Math.max(topLevelMicroCount - emittedMicroFromZones, 0);

    const qualifiedZoneIds = qualifiedZones.map((zone) => zone?.zone_id).filter((id) => id !== undefined && id !== null);
    const renderedZoneIds = renderedQualifiedZones.map((zone) => zone?.zone_id).filter((id) => id !== undefined && id !== null);

    const globalErrors = Array.isArray(debug.global_errors) ? debug.global_errors : [];
    const zoneErrors = zones
      .filter((zone) => Array.isArray(zone?.errors) && zone.errors.length)
      .map((zone) => `${zone.zone_id}: ${zone.errors.join('; ')}`);

    const zone14 = zones.find((zone) => safeNumber(zone?.zone_id) === 14);
    const zone14Line = zone14
      ? `Zone 14: qualified=${safeNumber(zone14?.point_count) >= safeNumber(zone14?.min_points_threshold) && safeNumber(zone14?.min_points_threshold) > 0} feature_emitted=${zone14?.feature_emitted === true} method=${zone14?.render_method || zone14?.method || 'n/a'}`
      : 'Zone 14: no debug data';

    let status = 'pass';
    let reason = '';

    if (!qualifiedZones.length) {
      status = 'pass';
      reason = 'No zones currently meet the threshold.';
    } else if (renderedQualifiedZones.length) {
      status = 'pass';
      reason = 'Qualified zone hotspot output detected.';
    } else {
      status = 'fail';
      reason = 'Qualified zones found but no hotspot output emitted for them.';
    }

    const detailParts = [
      reason,
      `Qualified zones: ${qualifiedZoneIds.length ? qualifiedZoneIds.join(', ') : 'none'}`,
      `Rendered zones: ${renderedZoneIds.length ? renderedZoneIds.join(', ') : 'none'}`,
      `Zone hotspots: ${zoneHotspotCount}`,
      `Micro hotspots: ${topLevelMicroCount}`,
      `Orphan micro hotspots: ${orphanMicroCount}`,
      zone14Line,
    ];

    if (globalErrors.length) detailParts.push(`Global errors: ${globalErrors.join(' | ')}`);
    if (zoneErrors.length) detailParts.push(`Zone errors: ${zoneErrors.join(' • ')}`);

    return {
      status,
      detail: detailParts.join(' • '),
    };
  }

  function collectRadioSignals(scope) {
    const signals = {
      audioObjects: [],
      audioFunctions: [],
      streamUrls: [],
      initializedFlags: [],
    };
    if (!scope || typeof scope !== 'object') return signals;

    const names = Object.getOwnPropertyNames(scope);
    names.forEach((name) => {
      let value;
      try {
        value = scope[name];
      } catch (_error) {
        return;
      }
      const key = String(name || '').toLowerCase();
      const looksRadioRelated = /radio|audio|stream|player/.test(key);

      if (typeof value === 'function' && looksRadioRelated) {
        signals.audioFunctions.push(name);
      }

      if (value && typeof value === 'object') {
        const isAudioObject = typeof Audio !== 'undefined' && value instanceof Audio;
        const hasAudioShape = typeof value.play === 'function' && (typeof value.pause === 'function' || 'src' in value);
        if (looksRadioRelated && (isAudioObject || hasAudioShape)) {
          signals.audioObjects.push(name);
        }

        const initialized = value.initialized === true || value.isInitialized === true || value.ready === true;
        if (looksRadioRelated && initialized) {
          signals.initializedFlags.push(name);
        }

        const candidateUrl = value.streamUrl || value.url || value.src;
        if (typeof candidateUrl === 'string' && /^https?:\/\//i.test(candidateUrl) && /stream|radio|audio/.test(candidateUrl.toLowerCase())) {
          signals.streamUrls.push(candidateUrl);
        }
      }

      if (typeof value === 'string' && /^https?:\/\//i.test(value) && /stream|radio|audio/.test(value.toLowerCase()) && looksRadioRelated) {
        signals.streamUrls.push(value);
      }
    });

    signals.audioObjects = [...new Set(signals.audioObjects)];
    signals.audioFunctions = [...new Set(signals.audioFunctions)];
    signals.streamUrls = [...new Set(signals.streamUrls)];
    signals.initializedFlags = [...new Set(signals.initializedFlags)];
    return signals;
  }

  function buildResult(test, response, c) {
    const defaultDetail = summarize(response.data, c);
    let status = statusFrom(response.ok, response.data);
    let detail = defaultDetail;

    if (test.key === 'radio-ui') {
      const data = response.data || {};
      const hasDomAudio = !!data.domAudioTagPresent;
      const hasLogic = !!(data.audioObjectCount || data.audioFunctionCount || data.streamUrlCount || data.initializedCount);
      status = hasLogic ? 'pass' : 'fail';
      if (hasLogic && !hasDomAudio) {
        detail = 'No DOM audio tag found, but radio logic is available.';
      } else if (hasLogic) {
        detail = 'Radio logic detected on client. Audio objects/functions present.';
      } else {
        detail = 'Radio logic not detected on client.';
      }
    }

    if (test.key === 'frame-current') {
      const data = response.data || {};
      const apiReportsOk = data.frame_endpoint_ok === true || data.frame_api_ok === true;
      const hasFrameFeatures = safeNumber(data.frame_features_count) > 0;
      if (apiReportsOk || hasFrameFeatures) {
        status = 'pass';
        detail = 'Frame API returned usable data.';
      }
    }

    if (test.key === 'pickup-hotspots-live') {
      const parsed = parsePickupHotspotResult(response);
      status = parsed.status;
      detail = parsed.detail;
    }

    if (test.key === 'presence-endpoint') {
      const data = response.data || {};
      const visibleCount = safeNumber(data.visible_count ?? data.presence_all_count ?? data.count);
      const onlineCount = safeNumber(data.online_count);
      const ghostedCount = safeNumber(data.ghosted_count);
      const backendType = data.backend_type || data.storage_backend || 'n/a';
      const sqlMode = data.sql_mode || data.mode || 'n/a';
      detail = `Visible: ${visibleCount} • Online: ${onlineCount} • Ghosted: ${ghostedCount} • Backend: ${backendType} • SQL mode: ${sqlMode}`;
      status = statusFrom(response.ok, data);
    }

    if (test.key === 'pickup-overlay-endpoint') {
      const data = response.data || {};
      const pickupItemCount = safeNumber(data.pickup_item_count ?? data.items_count ?? data.count);
      const zoneStatsCount = safeNumber(data.zone_stats_count ?? data.zone_count);
      const hotspotCount = safeNumber(data.hotspot_count ?? data.zone_hotspot_count);
      const microHotspotCount = safeNumber(data.micro_hotspot_count ?? data.pickup_micro_hotspot_count);
      const sampledZoneIds = Array.isArray(data.sampled_zone_ids) ? data.sampled_zone_ids.slice(0, 8).join(', ') : 'none';
      detail = `Pickup items: ${pickupItemCount} • Zone stats: ${zoneStatsCount} • Hotspots: ${hotspotCount} • Micro hotspots: ${microHotspotCount} • Sampled zones: ${sampledZoneIds || 'none'}`;
      status = statusFrom(response.ok, data);
    }

    if (test.key === 'client-community-smoke') {
      const data = response.data || {};
      const allSharedOk = !!(data.presence_all_ok && data.presence_summary_ok && data.pickup_overlay_ok);
      status = allSharedOk ? 'pass' : 'fail';
      detail = `Me: ${data.me_id ?? 'n/a'} • Admin: ${!!data.me_is_admin} • Presence all: ${safeNumber(data.presence_all_count)} • Online: ${safeNumber(data.online_count)} • Ghosted: ${safeNumber(data.ghosted_count)} • Zone hotspots: ${safeNumber(data.pickup_zone_hotspot_count)} • Micro hotspots: ${safeNumber(data.pickup_micro_hotspot_count)}`;
    }

    return {
      status,
      data: response.data,
      detail,
      lastRun: Date.now(),
    };
  }

  function runClientTest(test, helpers) {
    if (test.key === 'admin-session') {
      const me = helpers?.session?.me || null;
      return { ok: !!me?.is_admin, data: { isAdmin: !!me?.is_admin, userId: me?.id || 'N/A' } };
    }
    if (test.key === 'weather-api') {
      return { ok: typeof fetch === 'function', data: { fetchAvailable: typeof fetch === 'function' } };
    }
    if (test.key === 'radio-ui') {
      const signals = collectRadioSignals(window);
      const domAudioTagPresent = !!document.querySelector('audio');
      const hasRadioLogic = !!(signals.audioObjects.length || signals.audioFunctions.length || signals.streamUrls.length || signals.initializedFlags.length);
      return {
        ok: hasRadioLogic,
        data: {
          radioLogicDetected: hasRadioLogic,
          domAudioTagPresent,
          audioObjectCount: signals.audioObjects.length,
          audioFunctionCount: signals.audioFunctions.length,
          streamUrlCount: signals.streamUrls.length,
          initializedCount: signals.initializedFlags.length,
          audioObjects: signals.audioObjects,
          audioFunctions: signals.audioFunctions,
          streamUrls: signals.streamUrls,
          initializedFlags: signals.initializedFlags,
        },
      };
    }

    if (test.key === 'client-community-smoke') {
      if (typeof window.runCommunityVisibilitySmokeTest !== 'function') {
        return { ok: false, data: { error: 'window.runCommunityVisibilitySmokeTest is not available.' } };
      }
      return window.runCommunityVisibilitySmokeTest()
        .then((data) => ({
          ok: !!(data?.presence_all_ok && data?.presence_summary_ok && data?.pickup_overlay_ok),
          data: data || {},
        }))
        .catch((error) => ({ ok: false, data: { error: error?.message || 'Smoke test failed.' } }));
    }
    return { ok: false, data: { message: 'Client test not implemented.' } };
  }

  function renderLoadTestSection(container, helpers, c) {
    const state = {
      enabled: false,
      busy: false,
      copyMessage: '',
      errorMessage: '',
      capabilityMessage: '',
      unsupported: false,
      loadData: normalizeLoadResponse({}, DEFAULT_LOAD_OPTIONS),
      config: { ...DEFAULT_LOAD_OPTIONS },
      pollTimer: null,
      destroyed: false,
      pollInFlight: false,
    };

    function clearPollTimer() {
      if (state.pollTimer) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
      }
    }

    function cleanup() {
      state.destroyed = true;
      clearPollTimer();
    }

    helpers?.registerCleanup?.(cleanup);

    function shouldPoll() {
      return !state.destroyed && !state.unsupported && (state.enabled || state.loadData.active);
    }

    async function fetchCapabilities() {
      try {
        const payload = await helpers.request('/admin/tests/load/capabilities');
        const supported = pickFirst(payload || {}, ['supported', 'available']);
        if (supported === false) {
          state.unsupported = true;
          state.capabilityMessage = pickFirst(payload || {}, ['message', 'error']) || 'Synthetic load testing is not available on this backend.';
        }
        const defaults = normalizeLoadConfig(payload?.defaults || payload?.default_config || payload || {});
        state.config = { ...state.config, ...defaults };
        state.loadData = normalizeLoadResponse(
          pickFirst(payload || {}, ['active_run', 'current_run', 'last_result', 'last_completed_result', 'result']) || payload || {},
          state.config,
        );
        if (pickFirst(payload || {}, ['active_run', 'current_run'])) {
          state.loadData = normalizeLoadResponse(pickFirst(payload, ['active_run', 'current_run']), state.config);
        }
        if (state.loadData.active) state.enabled = true;
      } catch (error) {
        const message = error?.message || 'Failed to load load-test capabilities.';
        if (/404|405/i.test(message)) {
          state.unsupported = true;
          state.capabilityMessage = 'Synthetic load-test endpoints are not available yet on this backend.';
        } else {
          state.errorMessage = message;
        }
      }
      if (state.destroyed) return;
      render();
      syncPolling();
    }

    async function fetchStatus() {
      if (state.pollInFlight || state.destroyed || state.unsupported) return;
      state.pollInFlight = true;
      try {
        const payload = await helpers.request('/admin/tests/load/status');
        const next = normalizeLoadResponse(payload, state.config);
        if (state.destroyed) return;
        state.loadData = next;
        state.errorMessage = '';
        if (state.destroyed) return;
      } catch (error) {
        state.errorMessage = error?.message || 'Failed to refresh load-test status.';
      } finally {
        state.pollInFlight = false;
        render();
        syncPolling();
      }
    }

    function syncPolling() {
      if (shouldPoll()) {
        if (!state.pollTimer) {
          state.pollTimer = setInterval(() => {
            fetchStatus();
          }, LOAD_POLL_MS);
        }
      } else {
        clearPollTimer();
      }
    }

    async function startLoadTest() {
      state.busy = true;
      state.errorMessage = '';
      state.copyMessage = '';
      render();
      try {
        const payload = await helpers.request('/admin/tests/load/start', {
          method: 'POST',
          body: buildLoadRequestBody(state.config),
        });
        const next = normalizeLoadResponse(payload, state.config);
        if (state.destroyed) return;
        state.loadData = next;
        if (!next.active && normalizeStatus(next.status) !== 'running' && /active/i.test(next.errorMessage || next.summary)) {
          state.errorMessage = next.errorMessage || next.summary;
        } else {
          state.enabled = true;
        }
      } catch (error) {
        state.errorMessage = extractLoadErrorMessage(error, 'Failed to start synthetic load test.');
      } finally {
        state.busy = false;
        render();
        fetchStatus();
        syncPolling();
      }
    }

    async function stopLoadTest() {
      state.busy = true;
      state.errorMessage = '';
      state.copyMessage = '';
      render();
      try {
        const payload = await helpers.request('/admin/tests/load/stop', {
          method: 'POST',
          body: {},
        });
        const next = normalizeLoadResponse(payload, state.config);
        if (state.destroyed) return;
        state.loadData = next;
      } catch (error) {
        state.errorMessage = error?.message || 'Failed to stop synthetic load test.';
      } finally {
        state.busy = false;
        render();
        fetchStatus();
        syncPolling();
      }
    }

    function toggleOption(name) {
      state.config[name] = !state.config[name];
      render();
      syncPolling();
    }

    function renderMetricGrid() {
      if (!state.loadData.metrics.length) {
        return '<div class="adminMuted">No load metrics returned yet.</div>';
      }
      return `<div class="adminGrid two adminLoadMetrics">${state.loadData.metrics.map((metric) => c.statCard ? c.statCard(metric.label, metric.value) : `<div class="adminCard"><div class="adminCardLabel">${c.esc(metric.label)}</div><div class="adminCardValue">${c.esc(metric.value)}</div></div>`).join('')}</div>`;
    }

    function renderChecks() {
      if (!state.loadData.checks.length) return '';
      return `
        <div class="adminSection adminLoadChecks">
          <h4>Checks</h4>
          <div class="adminListMini">
            ${state.loadData.checks.slice(0, 8).map((check) => {
              const label = check?.label || check?.name || check?.metric || 'Check';
              const value = check?.reason || check?.message || check?.summary || check?.status || check?.result || 'No detail';
              return `<div class="adminKV"><span>${c.esc(label)}</span><strong>${c.esc(String(value))}</strong></div>`;
            }).join('')}
          </div>
        </div>
      `;
    }

    function render() {
      const mount = container.querySelector('#adminSyntheticLoadMount');
      if (!mount || state.destroyed) return;
      const controlsVisible = state.enabled || state.loadData.active;
      const active = state.loadData.active;
      const progressWidth = `${clamp(state.loadData.progressPercent, 0, 100)}%`;
      const statusLabel = formatLoadStatus(state.loadData.status);
      const resultTone = loadTone(state.loadData.status);
      const reasons = state.loadData.reasons.length ? state.loadData.reasons : [state.loadData.summary];
      const summaryText = buildLoadSummary(state.loadData);
      const debugJson = JSON.stringify(state.loadData.debug ?? state.loadData.raw ?? null, null, 2);

      mount.innerHTML = `
        <section class="adminSection adminLoadSection">
          <div class="adminSectionHead wrap">
            <div>
              <h4>Synthetic Load Test</h4>
              <div class="adminCardLabel">Synthetic Load Test</div>
              <div class="adminMuted">Admin-only synthetic benchmark. Runs on the server. Does not create real subscribers.</div>
            </div>
            ${c.badge ? c.badge(statusLabel, resultTone) : ''}
          </div>

          <label class="adminLoadToggleRow">
            <span>
              <strong>Enable Load Test Controls</strong>
              <span class="adminMuted adminLoadSafety">This creates temporary synthetic server load.</span>
            </span>
            <input type="checkbox" class="adminLoadToggleInput" id="adminLoadEnableToggle" ${state.enabled ? 'checked' : ''} ${state.unsupported ? 'disabled' : ''}>
          </label>

          ${state.unsupported ? `<div class="adminError">${c.esc(state.capabilityMessage || 'Synthetic load testing is unavailable.')}</div>` : ''}
          ${state.errorMessage ? `<div class="adminError">${c.esc(state.errorMessage)}</div>` : ''}
          ${state.copyMessage ? `<div class="adminLoading">${c.esc(state.copyMessage)}</div>` : ''}

          ${controlsVisible ? `
            <div class="adminLoadControls">
              <div>
                <div class="adminCardLabel">Driver preset</div>
                <div class="adminRow wrap adminLoadPresetRow">
                  ${LOAD_PRESETS.map((preset) => `<button type="button" class="adminToggleBtn${state.config.preset === preset ? ' active' : ''}" data-load-preset="${preset}" ${active || state.busy ? 'disabled' : ''}>${preset} drivers</button>`).join('')}
                </div>
              </div>

              <details class="adminDetails adminLoadAdvanced">
                <summary>Advanced options</summary>
                <div class="adminDetailsBody">
                  <div class="adminRow wrap adminLoadFieldRow">
                    <label class="adminLoadField">
                      <span>Duration seconds</span>
                      <input class="adminInput" type="number" min="5" max="600" step="5" id="adminLoadDuration" value="${c.esc(state.config.duration_sec)}" ${active || state.busy ? 'disabled' : ''}>
                    </label>
                    <label class="adminLoadField">
                      <span>Mode</span>
                      <select class="adminInput" id="adminLoadMode" ${active || state.busy ? 'disabled' : ''}>
                        <option value="map_core" ${state.config.mode === 'map_core' ? 'selected' : ''}>Map Core</option>
                        <option value="map_plus_chat" ${state.config.mode === 'map_plus_chat' ? 'selected' : ''}>Map + Chat</option>
                      </select>
                    </label>
                  </div>
                  <div class="adminControlGrid adminLoadCheckboxGrid">
                    ${[
                      ['include_presence_writes', 'Include presence writes'],
                      ['include_presence_viewport_reads', 'Include viewport reads'],
                      ['include_presence_summary_reads', 'Include summary reads'],
                      ['include_presence_delta_reads', 'Include delta reads'],
                      ['include_pickup_overlay_reads', 'Include pickup overlay reads'],
                      ['include_leaderboard_reads', 'Include leaderboard reads'],
                      ['include_chat_lite', 'Include chat-lite'],
                    ].map(([key, label]) => `<button type="button" class="adminToggleBtn${state.config[key] ? ' active' : ''}" data-load-option="${key}" ${active || state.busy ? 'disabled' : ''}>${c.esc(label)}</button>`).join('')}
                  </div>
                </div>
              </details>

              <div class="adminRow wrap adminLoadActionRow">
                <button type="button" class="adminBtn" id="adminLoadStartBtn" ${(active || state.busy || state.unsupported) ? 'disabled' : ''}>Start Load Test</button>
                <button type="button" class="adminBtn danger" id="adminLoadStopBtn" ${(!active || state.busy || state.unsupported) ? 'disabled' : ''}>Stop</button>
              </div>
            </div>
          ` : '<div class="adminMuted">Enable the toggle to configure a server-side synthetic load run. Status stays visible while a run is active.</div>'}

          <div class="adminLoadStatusCard adminLoadStatus-${c.esc(normalizeStatus(state.loadData.status))}">
            <div class="adminRowBetween adminLoadStatusHead">
              <strong>${c.esc(statusLabel)}</strong>
              <span class="adminMuted">Elapsed ${c.esc(formatDuration(state.loadData.elapsedSeconds))}</span>
            </div>
            <div class="adminMuted">${c.esc(state.loadData.summary)}</div>
            <div class="adminRow wrap adminLoadMetaRow">
              ${c.badge ? c.badge(`${state.loadData.config.preset} drivers`, 'muted') : ''}
              ${c.badge ? c.badge(state.loadData.config.mode === 'map_plus_chat' ? 'Map + Chat' : 'Map Core', 'muted') : ''}
              ${c.badge ? c.badge(`${Math.round(state.loadData.progressPercent)}% progress`, active ? 'warn' : resultTone) : ''}
            </div>
            <div class="adminLoadProgress" role="progressbar" aria-valuenow="${Math.round(state.loadData.progressPercent)}" aria-valuemin="0" aria-valuemax="100">
              <span style="width:${progressWidth}"></span>
            </div>
          </div>

          <div class="adminLoadResultCard adminLoadResult-${c.esc(resultTone)}">
            <div class="adminLoadResultBadge">${c.esc(statusLabel)}</div>
            <div class="adminLoadResultSummary">${c.esc(state.loadData.summary)}</div>
            <ul class="adminLoadReasonList">
              ${reasons.map((reason) => `<li>${c.esc(reason)}</li>`).join('')}
            </ul>
          </div>

          <div class="adminSection adminLoadMetricsSection">
            <h4>Metrics</h4>
            ${renderMetricGrid()}
          </div>

          ${renderChecks()}

          <div class="adminSection">
            <div class="adminSectionHead wrap">
              <h4>Copyable output</h4>
              <div class="adminRow wrap adminLoadCopyRow">
                <button type="button" class="adminBtn" id="adminLoadCopySummaryBtn">Copy Summary</button>
                <button type="button" class="adminBtn" id="adminLoadCopyDebugBtn">Copy Debug JSON</button>
              </div>
            </div>
            <div class="adminMuted">Copy the summary for a readable report or the raw debug JSON for deeper analysis.</div>
            ${c.collapsible ? c.collapsible('Raw Debug JSON', `<pre class="adminPre adminLoadDebugPre">${c.esc(debugJson)}</pre>`, 'adminRawResponse') : `<pre class="adminPre adminLoadDebugPre">${c.esc(debugJson)}</pre>`}
          </div>
        </section>
      `;

      container.querySelector('#adminLoadEnableToggle')?.addEventListener('change', (event) => {
        state.enabled = !!event.currentTarget.checked;
        state.copyMessage = '';
        render();
        syncPolling();
      });

      container.querySelectorAll('[data-load-preset]').forEach((button) => {
        button.addEventListener('click', () => {
          state.config.preset = normalizeDriverCount(button.dataset.loadPreset);
          render();
        });
      });

      container.querySelectorAll('[data-load-option]').forEach((button) => {
        button.addEventListener('click', () => toggleOption(button.dataset.loadOption));
      });

      container.querySelector('#adminLoadDuration')?.addEventListener('change', (event) => {
        state.config.duration_sec = normalizeDuration(event.currentTarget.value);
        render();
      });

      container.querySelector('#adminLoadMode')?.addEventListener('change', (event) => {
        state.config.mode = normalizeMode(event.currentTarget.value);
        render();
      });

      container.querySelector('#adminLoadStartBtn')?.addEventListener('click', () => startLoadTest());
      container.querySelector('#adminLoadStopBtn')?.addEventListener('click', () => stopLoadTest());

      container.querySelector('#adminLoadCopySummaryBtn')?.addEventListener('click', async () => {
        try {
          await copyText(summaryText);
          state.copyMessage = 'Copied summary to clipboard.';
        } catch (error) {
          state.copyMessage = error?.message || 'Unable to copy summary.';
        }
        render();
      });

      container.querySelector('#adminLoadCopyDebugBtn')?.addEventListener('click', async () => {
        try {
          await copyText(debugJson);
          state.copyMessage = 'Copied debug JSON to clipboard.';
        } catch (error) {
          state.copyMessage = error?.message || 'Unable to copy debug JSON.';
        }
        render();
      });
    }

    render();
    fetchCapabilities();
  }

  function renderAdminTests(container, _payload, helpers) {
    const c = helpers?.components || window.AdminComponents;
    const resultState = {};

    const sections = GROUPS.map((group) => `
      <section class="adminSection">
        <h4>${c.esc(group.label)}</h4>
        <div class="adminList">${group.tests.map((test) => `
          <article class="adminUserCard adminTestCard" data-test-key="${c.esc(test.key)}">
            <div class="adminRowBetween">
              <strong>${c.esc(test.label)}</strong>
              ${c.statusBadge ? c.statusBadge('pending') : c.badge('Pending', 'warn')}
            </div>
            <div class="adminMuted" data-test-detail>Pending</div>
            <div class="adminMuted" data-test-run>Last run: Never</div>
            <div class="adminRow wrap">
              <button type="button" class="adminBtn" data-test-run-btn="${c.esc(test.key)}">Run Test</button>
              ${c.collapsible('Raw Response', '<pre class="adminPre" data-test-raw>—</pre>', 'adminRawResponse')}
            </div>
          </article>
        `).join('')}</div>
      </section>
    `).join('');

    container.innerHTML = `
      <div id="adminSyntheticLoadMount"></div>
      <div class="adminSection">
        <div class="adminSectionHead wrap">
          <h4>System Tests</h4>
          <button type="button" class="adminBtn" id="adminRunAllTestsBtn">Run All Tests</button>
        </div>
        <div class="adminMuted">Manual read-only diagnostics. Tests run only when triggered.</div>
      </div>
      ${sections}
      <div id="adminPickupRecordingSuiteMount"></div>
    `;

    renderLoadTestSection(container, helpers, c);

    const pickupSuiteMount = container.querySelector('#adminPickupRecordingSuiteMount');
    if (pickupSuiteMount && window.PickupRecordingFeature && typeof window.PickupRecordingFeature.mountAdminPickupRecordingTests === 'function') {
      window.PickupRecordingFeature.mountAdminPickupRecordingTests(pickupSuiteMount, helpers);
    }

    function paintResult(test, result) {
      const card = container.querySelector(`[data-test-key="${CSS.escape(test.key)}"]`);
      if (!card) return;
      const status = result.status || 'fail';
      const badgeEl = card.querySelector('.adminPill');
      if (badgeEl) {
        badgeEl.outerHTML = c.statusBadge ? c.statusBadge(status) : c.badge(c.toLabel(status), status === 'pass' ? 'yes' : status === 'fail' ? 'no' : 'warn');
      }
      const detailEl = card.querySelector('[data-test-detail]');
      const runEl = card.querySelector('[data-test-run]');
      const rawEl = card.querySelector('[data-test-raw]');
      if (detailEl) detailEl.innerHTML = `${c.esc(result.detail || 'No detail available.')}${flattenRows(result.data, c)}`;
      if (runEl) runEl.textContent = `Last run: ${new Date(result.lastRun).toLocaleString()}`;
      if (rawEl) rawEl.textContent = JSON.stringify(result.data ?? null, null, 2);
    }

    async function executeTest(test) {
      const button = container.querySelector(`[data-test-run-btn="${CSS.escape(test.key)}"]`);
      if (button) button.disabled = true;
      try {
        let response;
        if (test.type === 'client') {
          response = await Promise.resolve(runClientTest(test, helpers));
        } else {
          const data = await helpers.request(test.path);
          response = { ok: true, data };
        }
        const next = buildResult(test, response, c);
        resultState[test.key] = next;
        paintResult(test, next);
      } catch (error) {
        const next = {
          status: 'fail',
          data: { error: error?.message || 'Unknown error' },
          detail: error?.message || 'Request failed.',
          lastRun: Date.now(),
        };
        resultState[test.key] = next;
        paintResult(test, next);
      } finally {
        if (button) button.disabled = false;
      }
    }

    container.querySelectorAll('[data-test-run-btn]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const test = GROUPS.flatMap((g) => g.tests).find((t) => t.key === btn.dataset.testRunBtn);
        if (test) executeTest(test);
      });
    });

    container.querySelector('#adminRunAllTestsBtn')?.addEventListener('click', async (e) => {
      const trigger = e.currentTarget;
      trigger.disabled = true;
      const tests = GROUPS.flatMap((g) => g.tests);
      for (const test of tests) {
        // sequential to avoid aggressive parallel fanout
        // eslint-disable-next-line no-await-in-loop
        await executeTest(test);
      }
      trigger.disabled = false;
    });
  }

  window.AdminTests = { renderAdminTests };
})();
