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
      label: 'Score / Manifest / Frame Integrity',
      tests: [
        { key: 'score-manifest', label: 'Test Score Manifest', path: '/admin/tests/score-manifest' },
        { key: 'score-sql-definitions', label: 'Test Score SQL Definitions', path: '/admin/tests/score-sql-definitions' },
        { key: 'zone-geometry-metrics', label: 'Test Zone Geometry Metrics', path: '/admin/tests/zone-geometry-metrics' },
        { key: 'score-frame-integrity', label: 'Test Score Frame Integrity', path: '/admin/tests/score-frame-integrity' },
        { key: 'generated-artifact-sync', label: 'Test Generated Artifact Sync', path: '/admin/tests/generated-artifact-sync' },
      ],
    },
    {
      label: 'Client Map Logic',
      tests: [
        { key: 'client-system-audit', label: 'Test Client System Audit', type: 'client' },
        { key: 'client-score-field-sample', label: 'Test Client Score Field Sample', type: 'client' },
        { key: 'client-visible-source-routing', label: 'Test Client Visible Source Routing', type: 'client' },
        { key: 'client-recommendation-audit', label: 'Test Client Recommendation Audit', type: 'client' },
        { key: 'client-crowding-audit', label: 'Test Client Crowding Audit', type: 'client' },
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

  const LOAD_PRESETS = [100, 300, 500, 1000, 1500, 2000];
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
  const ALLOWED_LOAD_DURATIONS = [30, 45, 60, 90];

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
    const parsed = safeInteger(value, DEFAULT_LOAD_OPTIONS.duration_sec);
    const exact = ALLOWED_LOAD_DURATIONS.find((duration) => duration === parsed);
    if (exact) return exact;
    return ALLOWED_LOAD_DURATIONS.reduce((closest, candidate) => (
      Math.abs(candidate - parsed) < Math.abs(closest - parsed) ? candidate : closest
    ), ALLOWED_LOAD_DURATIONS[0]);
  }

  function normalizeMode(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'map_core') return 'map_core';
    if (normalized === 'map_plus_chat') return 'map_plus_chat';
    if (['map_chat', 'map-chat', 'map+chat', 'chat'].includes(normalized)) return 'map_plus_chat';
    return 'map_core';
  }

  function unwrapAdminTestDetails(payload) {
    if (payload && typeof payload === 'object' && payload.details && typeof payload.details === 'object') {
      return payload.details;
    }
    return payload && typeof payload === 'object' ? payload : {};
  }

  function normalizeLoadConfig(source, includeDefaults = true) {
    const payload = source && typeof source === 'object' ? source : {};
    const configSources = [
      payload,
      unwrapAdminTestDetails(payload),
      pickFirst(payload, ['payload.details', 'current_run', 'last_run', 'selected_config', 'last_result', 'last_result.selected_config', 'details.selected_config', 'details.last_result.selected_config']),
      pickFirst(unwrapAdminTestDetails(payload), ['current_run', 'last_run', 'selected_config', 'last_result', 'last_result.selected_config', 'selected_config', 'details.selected_config']),
    ].filter((entry) => entry && typeof entry === 'object');
    const normalized = {};

    const preset = pickFirst({ configSources }, [
      'configSources.0.preset', 'configSources.0.driverCount', 'configSources.0.driver_count', 'configSources.0.drivers', 'configSources.0.selected_preset',
      'configSources.1.preset', 'configSources.1.driverCount', 'configSources.1.driver_count', 'configSources.1.drivers', 'configSources.1.selected_preset',
      'configSources.2.preset', 'configSources.2.driverCount', 'configSources.2.driver_count', 'configSources.2.drivers', 'configSources.2.selected_preset',
      'configSources.3.preset', 'configSources.3.driverCount', 'configSources.3.driver_count', 'configSources.3.drivers', 'configSources.3.selected_preset',
    ]);
    const duration_sec = pickFirst({ configSources }, [
      'configSources.0.duration_sec', 'configSources.0.durationSeconds', 'configSources.0.duration_seconds', 'configSources.0.duration',
      'configSources.1.duration_sec', 'configSources.1.durationSeconds', 'configSources.1.duration_seconds', 'configSources.1.duration',
      'configSources.2.duration_sec', 'configSources.2.durationSeconds', 'configSources.2.duration_seconds', 'configSources.2.duration',
      'configSources.3.duration_sec', 'configSources.3.durationSeconds', 'configSources.3.duration_seconds', 'configSources.3.duration',
    ]);
    const mode = pickFirst({ configSources }, [
      'configSources.0.mode', 'configSources.0.scenario_mode',
      'configSources.1.mode', 'configSources.1.scenario_mode',
      'configSources.2.mode', 'configSources.2.scenario_mode',
      'configSources.3.mode', 'configSources.3.scenario_mode',
    ]);
    const include_presence_writes = pickFirst({ configSources }, [
      'configSources.0.include_presence_writes', 'configSources.0.includePresenceWrites',
      'configSources.1.include_presence_writes', 'configSources.1.includePresenceWrites',
      'configSources.2.include_presence_writes', 'configSources.2.includePresenceWrites',
      'configSources.3.include_presence_writes', 'configSources.3.includePresenceWrites',
    ]);
    const include_presence_viewport_reads = pickFirst({ configSources }, [
      'configSources.0.include_presence_viewport_reads', 'configSources.0.includeViewportReads', 'configSources.0.include_viewport_reads',
      'configSources.1.include_presence_viewport_reads', 'configSources.1.includeViewportReads', 'configSources.1.include_viewport_reads',
      'configSources.2.include_presence_viewport_reads', 'configSources.2.includeViewportReads', 'configSources.2.include_viewport_reads',
      'configSources.3.include_presence_viewport_reads', 'configSources.3.includeViewportReads', 'configSources.3.include_viewport_reads',
    ]);
    const include_presence_summary_reads = pickFirst({ configSources }, [
      'configSources.0.include_presence_summary_reads', 'configSources.0.includeSummaryReads', 'configSources.0.include_summary_reads',
      'configSources.1.include_presence_summary_reads', 'configSources.1.includeSummaryReads', 'configSources.1.include_summary_reads',
      'configSources.2.include_presence_summary_reads', 'configSources.2.includeSummaryReads', 'configSources.2.include_summary_reads',
      'configSources.3.include_presence_summary_reads', 'configSources.3.includeSummaryReads', 'configSources.3.include_summary_reads',
    ]);
    const include_presence_delta_reads = pickFirst({ configSources }, [
      'configSources.0.include_presence_delta_reads', 'configSources.0.includeDeltaReads', 'configSources.0.include_delta_reads',
      'configSources.1.include_presence_delta_reads', 'configSources.1.includeDeltaReads', 'configSources.1.include_delta_reads',
      'configSources.2.include_presence_delta_reads', 'configSources.2.includeDeltaReads', 'configSources.2.include_delta_reads',
      'configSources.3.include_presence_delta_reads', 'configSources.3.includeDeltaReads', 'configSources.3.include_delta_reads',
    ]);
    const include_pickup_overlay_reads = pickFirst({ configSources }, [
      'configSources.0.include_pickup_overlay_reads', 'configSources.0.includePickupOverlayReads',
      'configSources.1.include_pickup_overlay_reads', 'configSources.1.includePickupOverlayReads',
      'configSources.2.include_pickup_overlay_reads', 'configSources.2.includePickupOverlayReads',
      'configSources.3.include_pickup_overlay_reads', 'configSources.3.includePickupOverlayReads',
    ]);
    const include_leaderboard_reads = pickFirst({ configSources }, [
      'configSources.0.include_leaderboard_reads', 'configSources.0.includeLeaderboardReads',
      'configSources.1.include_leaderboard_reads', 'configSources.1.includeLeaderboardReads',
      'configSources.2.include_leaderboard_reads', 'configSources.2.includeLeaderboardReads',
      'configSources.3.include_leaderboard_reads', 'configSources.3.includeLeaderboardReads',
    ]);
    const include_chat_lite = pickFirst({ configSources }, [
      'configSources.0.include_chat_lite', 'configSources.0.includeChatLite', 'configSources.0.chat_lite_enabled',
      'configSources.1.include_chat_lite', 'configSources.1.includeChatLite', 'configSources.1.chat_lite_enabled',
      'configSources.2.include_chat_lite', 'configSources.2.includeChatLite', 'configSources.2.chat_lite_enabled',
      'configSources.3.include_chat_lite', 'configSources.3.includeChatLite', 'configSources.3.chat_lite_enabled',
    ]);

    if (preset !== undefined) normalized.preset = normalizeDriverCount(preset);
    if (duration_sec !== undefined) normalized.duration_sec = normalizeDuration(duration_sec);
    if (mode !== undefined) normalized.mode = normalizeMode(mode);
    if (include_presence_writes !== undefined) normalized.include_presence_writes = !!include_presence_writes;
    if (include_presence_viewport_reads !== undefined) normalized.include_presence_viewport_reads = !!include_presence_viewport_reads;
    if (include_presence_summary_reads !== undefined) normalized.include_presence_summary_reads = !!include_presence_summary_reads;
    if (include_presence_delta_reads !== undefined) normalized.include_presence_delta_reads = !!include_presence_delta_reads;
    if (include_pickup_overlay_reads !== undefined) normalized.include_pickup_overlay_reads = !!include_pickup_overlay_reads;
    if (include_leaderboard_reads !== undefined) normalized.include_leaderboard_reads = !!include_leaderboard_reads;
    if (include_chat_lite !== undefined) normalized.include_chat_lite = !!include_chat_lite;
    return includeDefaults ? { ...DEFAULT_LOAD_OPTIONS, ...normalized } : normalized;
  }

  function buildLoadRequestBody(config) {
    const normalized = normalizeLoadConfig(config || {}, true);
    return {
      preset: normalized.preset,
      duration_sec: normalized.duration_sec,
      mode: normalized.mode,
      include_presence_writes: !!normalized.include_presence_writes,
      include_presence_viewport_reads: !!normalized.include_presence_viewport_reads,
      include_presence_summary_reads: !!normalized.include_presence_summary_reads,
      include_presence_delta_reads: !!normalized.include_presence_delta_reads,
      include_pickup_overlay_reads: !!normalized.include_pickup_overlay_reads,
      include_leaderboard_reads: !!normalized.include_leaderboard_reads,
      include_chat_lite: !!normalized.include_chat_lite,
    };
  }

  function extractLoadErrorMessage(error, fallback) {
    const detail = error?.detail;
    const payload = error?.payload;
    const statusText = error?.status ? `HTTP ${error.status}` : '';
    const parts = [];

    [
      pickFirst(detail, ['detail', 'message', 'error']),
      pickFirst(payload, ['summary', 'details.error', 'details.message', 'detail.detail', 'detail.message', 'detail.error', 'detail', 'message', 'error']),
      error?.message,
    ].flatMap((value) => toArray(value)).forEach((value) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      if (String(text || '').trim()) parts.push(String(text).trim());
    });

    if (payload && typeof payload === 'object') {
      const payloadText = JSON.stringify(payload);
      if (payloadText && !parts.includes(payloadText)) parts.push(payloadText);
    }

    const message = [...new Set(parts)].join(' | ') || fallback || 'Request failed';
    return [statusText, message].filter(Boolean).join(' — ').trim();
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
    pushReason(reasons, pickFirst(raw, ['current_reasons', 'summary.top_reasons', 'top_reasons', 'reasons', 'failure_reasons', 'debug.reasons', 'debug.failure_reasons']));

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
    const wrapper = payload && typeof payload === 'object' ? payload : {};
    const raw = unwrapAdminTestDetails(wrapper);
    const status = normalizeStatus(pickFirst(raw, ['status', 'state', 'result.status', 'run.status']) || 'idle');
    const currentConfigSources = [
      fallbackConfig,
      wrapper,
      raw,
      pickFirst(wrapper, ['selected_config', 'current_run', 'run', 'result.selected_config', 'result.config', 'config']),
      pickFirst(raw, ['selected_config', 'current_run', 'run', 'result.selected_config', 'result.config', 'config']),
    ].filter((entry) => entry && typeof entry === 'object');
    const config = currentConfigSources.reduce((acc, source) => ({
      ...acc,
      ...normalizeLoadConfig(source, false),
    }), { ...DEFAULT_LOAD_OPTIONS });
    const progressValue = pickFirst(raw, ['progress_percent', 'progress.percent', 'run.progress_percent', 'result.progress_percent']);
    const elapsedValue = pickFirst(raw, ['elapsed_sec', 'elapsed_seconds', 'elapsed', 'run.elapsed_sec', 'run.elapsed_seconds', 'result.elapsed_sec', 'result.elapsed_seconds']);
    const summaryLine = pickFirst(raw, ['summary.line', 'summary.text', 'summary', 'message', 'detail', 'details.message']);
    const lastResultRaw = pickFirst(raw, ['last_result']);
    const normalizedLastResult = lastResultRaw && typeof lastResultRaw === 'object' ? normalizeLoadResponse(lastResultRaw, config) : null;
    const reasons = collectReasons(raw, status);
    const currentMetrics = pickFirst(raw, ['current_metrics']);
    const metrics = collectMetrics(currentMetrics && typeof currentMetrics === 'object' ? { ...raw, metrics: currentMetrics, current_metrics: currentMetrics } : raw, config);
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
      wrapper,
      status,
      active: isActiveLoadStatus(status),
      unsupported: status === 'unsupported' || raw.supported === false || raw.available === false || wrapper.supported === false || wrapper.available === false,
      progressPercent: clamp(safeNumber(progressValue, status === 'pass' || status === 'fail' ? 100 : 0), 0, 100),
      elapsedSeconds: safeNumber(elapsedValue, 0),
      remainingEstimateSeconds: safeNumber(pickFirst(raw, ['remaining_estimate_sec']), 0),
      summary,
      reasons: reasons.length ? reasons : collectReasons(normalizedLastResult?.raw || {}, normalizedLastResult?.status || status),
      metrics: metrics.length ? metrics : (normalizedLastResult?.metrics || []),
      debug: pickFirst(raw, ['debug', 'result.debug']) ?? raw,
      config,
      errorMessage: pickFirst(wrapper, ['summary', 'details.error', 'details.message', 'detail', 'message', 'error']) || pickFirst(raw, ['summary', 'details.error', 'details.message', 'error', 'message', 'detail']) || '',
      checks: toArray(pickFirst(raw, ['checks', 'summary.checks', 'debug.checks'])).length ? toArray(pickFirst(raw, ['checks', 'summary.checks', 'debug.checks'])) : (normalizedLastResult?.checks || []),
      warnings: toArray(pickFirst(raw, ['warnings'])),
      errors: toArray(pickFirst(raw, ['errors'])),
      currentReasons: toArray(pickFirst(raw, ['current_reasons'])),
      activeRunId: pickFirst(raw, ['active_run_id']),
      startedAt: pickFirst(raw, ['started_at']),
      endedAt: pickFirst(raw, ['ended_at']),
      lastResult: normalizedLastResult,
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

  function buildResult(test, response, c, resultState = {}) {
    const defaultDetail = summarize(response.data, c);
    let status = statusFrom(response.ok, response.data);
    let detail = defaultDetail;
    const generatedArtifactSyncFailing = resultState?.['generated-artifact-sync']?.status === 'fail';

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
    if (test.key === 'score-manifest') {
      const data = response.data || {};
      const liveProfiles = safeNumber(data.live_profile_count ?? data.visible_profile_count);
      const v3Profiles = safeNumber(data.v3_profile_count ?? data.visible_v3_profile_count);
      if (status === 'pass') {
        detail = generatedArtifactSyncFailing
          ? `Score manifest appears internally valid, but generated frame artifacts are stale versus deployed code/source data. Live: ${liveProfiles} • V3: ${v3Profiles}`
          : `Visible profiles live are fully on v3. Live: ${liveProfiles} • V3: ${v3Profiles}`;
      } else {
        detail = generatedArtifactSyncFailing
          ? `Score manifest mismatch is consistent with stale generated frame artifacts (not frontend routing logic). Live: ${liveProfiles} • V3: ${v3Profiles}`
          : `Score manifest check failed. Live: ${liveProfiles} • V3: ${v3Profiles}`;
      }
    }
    if (test.key === 'score-sql-definitions') {
      const data = response.data || {};
      const total = safeNumber(data.definition_count ?? data.total_count);
      const missing = safeNumber(data.missing_definition_count ?? data.missing_count);
      detail = status === 'pass'
        ? `SQL definitions look complete. Definitions: ${total} • Missing: ${missing}`
        : `SQL definition mismatch detected. Definitions: ${total} • Missing: ${missing}`;
    }
    if (test.key === 'zone-geometry-metrics') {
      const data = response.data || {};
      const zoneCount = safeNumber(data.zone_count ?? data.metrics_count);
      const invalidArea = safeNumber(data.invalid_area_count ?? data.non_positive_area_count);
      detail = status === 'pass'
        ? `Zone geometry metrics are healthy. Zones: ${zoneCount} • Invalid area: ${invalidArea}`
        : `Zone geometry metrics reported issues. Zones: ${zoneCount} • Invalid area: ${invalidArea}`;
    }
    if (test.key === 'score-frame-integrity') {
      const data = response.data || {};
      const frameCount = safeNumber(data.frame_count ?? data.sampled_frame_count);
      const invalidFeatures = safeNumber(data.invalid_feature_count ?? data.feature_violation_count);
      if (status === 'pass') {
        detail = generatedArtifactSyncFailing
          ? `Sampled frame integrity is locally consistent, but generated frame artifacts are stale versus deployed code/source data. Frames: ${frameCount} • Invalid features: ${invalidFeatures}`
          : `Frame integrity passed on sampled frames. Frames: ${frameCount} • Invalid features: ${invalidFeatures}`;
      } else {
        detail = generatedArtifactSyncFailing
          ? `Frame integrity anomalies are consistent with stale generated frame artifacts (not frontend routing logic). Frames: ${frameCount} • Invalid features: ${invalidFeatures}`
          : `Frame integrity found invalid features. Frames: ${frameCount} • Invalid features: ${invalidFeatures}`;
      }
    }
    if (test.key === 'generated-artifact-sync') {
      const data = response.data || {};
      const reasonCodes = toArray(
        data.reason_codes
        ?? data.reasonCodes
        ?? data?.artifact_sync?.reason_codes
        ?? data?.artifact_sync?.reasonCodes
      );
      const sampledSnapshot = pickFirst(data, [
        'sampled_frame_integrity_snapshot',
        'sampledFrameIntegritySnapshot',
        'frame_integrity_snapshot',
        'frameIntegritySnapshot',
        'artifact_sync.sampled_frame_integrity_snapshot',
        'artifact_sync.frame_integrity_snapshot',
      ]);
      if (status === 'pass') {
        detail = 'Generated frame artifacts match deployed code and source data.';
      } else {
        const reasonSegment = reasonCodes.length
          ? `Reason codes: ${reasonCodes.join(', ')}`
          : 'Reason codes: unavailable';
        const snapshotSegment = sampledSnapshot
          ? `Sampled frame integrity snapshot: ${c.formatValue(sampledSnapshot)}`
          : 'Sampled frame integrity snapshot: unavailable';
        detail = `Generated frame artifacts are stale relative to deployed code or source data. ${reasonSegment} • ${snapshotSegment}`;
      }
    }
    if (test.key === 'client-system-audit') {
      const data = response.data || {};
      detail = status === 'pass'
        ? `Client system audit is available and healthy. Features: ${safeNumber(data.featureCount)} • Fallback: ${safeNumber(data.fallbackCount)}`
        : `Client system audit is missing required hooks or data. Features: ${safeNumber(data.featureCount)} • Fallback: ${safeNumber(data.fallbackCount)}`;
    }
    if (test.key === 'client-score-field-sample') {
      const data = response.data || {};
      if (status === 'pass') {
        detail = generatedArtifactSyncFailing
          ? `Sampled score fields are internally consistent, but generated frame artifacts are stale versus deployed code/source data. Sampled: ${safeNumber(data.sampledFeatureCount)} • Violations: ${safeNumber(data.violationCount)}`
          : `Sampled score fields are valid. Sampled: ${safeNumber(data.sampledFeatureCount)} • Violations: ${safeNumber(data.violationCount)}`;
      } else {
        detail = generatedArtifactSyncFailing
          ? `Score field violations are consistent with stale generated artifacts (not frontend field/routing code). Sampled: ${safeNumber(data.sampledFeatureCount)} • Violations: ${safeNumber(data.violationCount)}`
          : `Score field sample found violations. Sampled: ${safeNumber(data.sampledFeatureCount)} • Violations: ${safeNumber(data.violationCount)}`;
      }
    }
    if (test.key === 'client-visible-source-routing') {
      const data = response.data || {};
      const scenarioCount = Array.isArray(data.scenarios) ? data.scenarios.length : 0;
      const missingWarnings = Array.isArray(data.missingSampleWarnings) ? data.missingSampleWarnings.length : 0;
      if (status === 'pass') {
        detail = generatedArtifactSyncFailing
          ? `Mode routing checks passed, but generated frame artifacts are stale versus deployed code/source data. Scenarios: ${scenarioCount} • Missing samples: ${missingWarnings}`
          : `Mode routing returned valid sources and restored original state. Scenarios: ${scenarioCount} • Missing samples: ${missingWarnings}`;
      } else {
        detail = generatedArtifactSyncFailing
          ? `Mode/source mismatch is consistent with stale generated artifacts rather than frontend routing code regressions. Scenarios: ${scenarioCount} • Missing samples: ${missingWarnings}`
          : `Mode routing check failed or found impossible source mapping. Scenarios: ${scenarioCount} • Missing samples: ${missingWarnings}`;
      }
    }
    if (test.key === 'client-recommendation-audit') {
      const data = response.data || {};
      detail = status === 'pass'
        ? `Recommendation audit returned a valid top zone. Zone: ${data.zoneName || 'n/a'} • Mode: ${data.activeModeTag || 'citywide'}`
        : `Recommendation audit did not return a valid result. Zone: ${data.zoneName || 'n/a'} • Mode: ${data.activeModeTag || 'n/a'}`;
    }
    if (test.key === 'client-crowding-audit') {
      const data = response.data || {};
      detail = status === 'pass'
        ? `Crowding module health checks passed. Source: ${!!data.sourceReady} • Line layer: ${!!data.lineLayerReady}`
        : `Crowding module health checks failed. Source: ${!!data.sourceReady} • Line layer: ${!!data.lineLayerReady}`;
    }

    return {
      status,
      data: response.data,
      detail,
      lastRun: Date.now(),
    };
  }

  function getCurrentFrameFeatures() {
    return window.TlcModeInternals?.getCurrentFrame?.()?.polygons?.features || [];
  }

  function getFeatureZoneId(feature) {
    return String(feature?.properties?.LocationID ?? '').trim();
  }

  function sampleFeatures(features, maxCount = 40) {
    if (!Array.isArray(features) || !features.length) return [];
    const count = Math.max(1, Math.min(maxCount, features.length));
    if (features.length <= count) return features.slice();
    const out = [];
    const seen = new Set();
    for (let i = 0; i < count; i += 1) {
      const ratio = count === 1 ? 0 : (i / (count - 1));
      const idx = Math.max(0, Math.min(features.length - 1, Math.round(ratio * (features.length - 1))));
      if (!seen.has(idx)) {
        seen.add(idx);
        out.push(features[idx]);
      }
    }
    return out;
  }

  function findFeatureByPredicate(features, predicate) {
    if (!Array.isArray(features) || typeof predicate !== 'function') return null;
    for (const feature of features) {
      if (predicate(feature)) return feature;
    }
    return null;
  }

  function isAirportFeature(feature) {
    const props = feature?.properties || {};
    const zoneName = String(props.zone_name || props.Zone || props.name || '').toLowerCase();
    const zoneId = getFeatureZoneId(feature);
    const byName = /airport|jfk|la guardia|laguardia|newark/.test(zoneName);
    const byId = ['1', '132', '138'].includes(zoneId);
    return byName || byId;
  }

  function snapshotModeFlags() {
    return window.TlcModeModule?.getModeFlags?.() || null;
  }

  function setSingleModeState(modeKeyOrNull) {
    const modeModule = window.TlcModeModule;
    const flags = modeModule?.getModeFlags?.() || {};
    Object.keys(flags).forEach((key) => {
      if (flags[key]) modeModule?.toggleModeByKey?.(key, false);
    });
    if (modeKeyOrNull) modeModule?.toggleModeByKey?.(modeKeyOrNull, true);
    window.TlcModeInternals?.renderCurrentFrame?.();
  }

  function restoreModeFlags(snapshot) {
    const modeModule = window.TlcModeModule;
    const current = modeModule?.getModeFlags?.() || {};
    const target = snapshot && typeof snapshot === 'object' ? snapshot : {};
    Object.keys(current).forEach((key) => {
      const shouldBeOn = !!target[key];
      if (!!current[key] !== shouldBeOn) modeModule?.toggleModeByKey?.(key, shouldBeOn);
    });
    Object.keys(target).forEach((key) => {
      if (!(key in current) && target[key]) modeModule?.toggleModeByKey?.(key, true);
    });
    window.TlcModeInternals?.renderCurrentFrame?.();
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
    if (test.key === 'client-system-audit') {
      const hasSystemAudit = typeof window.getTeamJoseoSystemAudit === 'function';
      const hasZoneAudit = typeof window.getTeamJoseoZoneAuditByLocationId === 'function';
      const hasCrowding = typeof window.getCommunityCrowdingDebug === 'function';
      const hasRecommendation = typeof window.getTeamJoseoRecommendationAudit === 'function';
      if (!hasSystemAudit) {
        return { ok: false, data: { error: 'window.getTeamJoseoSystemAudit is not available.', hasZoneAudit, hasCrowding, hasRecommendation } };
      }
      const audit = window.getTeamJoseoSystemAudit();
      const visibleSourceCounts = audit?.visibleSourceCounts || null;
      const featureCount = safeNumber(audit?.featureCount);
      const ok = !!(audit && featureCount > 0 && visibleSourceCounts && typeof visibleSourceCounts === 'object' && hasZoneAudit && hasCrowding && hasRecommendation);
      return {
        ok,
        data: {
          featureCount,
          fallbackCount: safeNumber(audit?.fallbackCount),
          visibleSourceCounts: visibleSourceCounts || {},
          modeFlags: audit?.modeFlags || snapshotModeFlags() || {},
          recommendationPresent: hasRecommendation,
          crowdingHelperPresent: hasCrowding,
          zoneAuditPresent: hasZoneAudit,
        },
      };
    }
    if (test.key === 'client-score-field-sample') {
      const features = getCurrentFrameFeatures();
      const sampled = sampleFeatures(features, 40);
      const violations = [];
      function pushViolation(zoneId, field, value, reason) {
        violations.push({ zoneId, field, value, reason });
      }
      sampled.forEach((feature) => {
        const props = feature?.properties || {};
        const zoneId = getFeatureZoneId(feature);
        const rating = Number(props.rating);
        const score = props.earnings_shadow_rating_citywide_v3;
        const confidence = props.earnings_shadow_confidence_citywide_v3;
        const zoneArea = props.zone_area_sq_miles_shadow;
        const pickupsNow = props.pickups_per_sq_mile_now_shadow;
        const pickupsNext = props.pickups_per_sq_mile_next_shadow;
        const longTripShare = props.long_trip_share_20plus_shadow;
        const sameZoneDropoff = props.same_zone_dropoff_share_shadow;
        const demandNow = props.demand_density_now_n_shadow;
        const demandNext = props.demand_density_next_n_shadow;
        const retentionPenalty = props.same_zone_retention_penalty_n_shadow;

        if (!zoneId) pushViolation(zoneId, 'LocationID', props.LocationID, 'Missing LocationID');
        if (!Number.isFinite(rating)) pushViolation(zoneId, 'rating', props.rating, 'rating must be finite');
        if (!(score === null || (Number.isFinite(Number(score)) && Number(score) >= 1 && Number(score) <= 100))) {
          pushViolation(zoneId, 'earnings_shadow_rating_citywide_v3', score, 'Must be null or 1..100');
        }
        if (score !== null && !(Number.isFinite(Number(confidence)) && Number(confidence) >= 0 && Number(confidence) <= 1)) {
          pushViolation(zoneId, 'earnings_shadow_confidence_citywide_v3', confidence, 'Must be 0..1 when score is non-null');
        }
        if (!(zoneArea === null || (Number.isFinite(Number(zoneArea)) && Number(zoneArea) > 0))) pushViolation(zoneId, 'zone_area_sq_miles_shadow', zoneArea, 'Must be null or > 0');
        if (!(pickupsNow === null || (Number.isFinite(Number(pickupsNow)) && Number(pickupsNow) >= 0))) pushViolation(zoneId, 'pickups_per_sq_mile_now_shadow', pickupsNow, 'Must be null or >= 0');
        if (!(pickupsNext === null || (Number.isFinite(Number(pickupsNext)) && Number(pickupsNext) >= 0))) pushViolation(zoneId, 'pickups_per_sq_mile_next_shadow', pickupsNext, 'Must be null or >= 0');
        if (!(longTripShare === null || (Number.isFinite(Number(longTripShare)) && Number(longTripShare) >= 0 && Number(longTripShare) <= 1))) pushViolation(zoneId, 'long_trip_share_20plus_shadow', longTripShare, 'Must be null or 0..1');
        if (!(sameZoneDropoff === null || (Number.isFinite(Number(sameZoneDropoff)) && Number(sameZoneDropoff) >= 0 && Number(sameZoneDropoff) <= 1))) pushViolation(zoneId, 'same_zone_dropoff_share_shadow', sameZoneDropoff, 'Must be null or 0..1');
        if (!(demandNow === null || (Number.isFinite(Number(demandNow)) && Number(demandNow) >= 0 && Number(demandNow) <= 1))) pushViolation(zoneId, 'demand_density_now_n_shadow', demandNow, 'Must be null or 0..1');
        if (!(demandNext === null || (Number.isFinite(Number(demandNext)) && Number(demandNext) >= 0 && Number(demandNext) <= 1))) pushViolation(zoneId, 'demand_density_next_n_shadow', demandNext, 'Must be null or 0..1');
        if (!(retentionPenalty === null || (Number.isFinite(Number(retentionPenalty)) && Number(retentionPenalty) >= 0 && Number(retentionPenalty) <= 1))) pushViolation(zoneId, 'same_zone_retention_penalty_n_shadow', retentionPenalty, 'Must be null or 0..1');
      });
      return {
        ok: sampled.length > 0 && !violations.length,
        data: {
          sampledFeatureCount: sampled.length,
          violationCount: violations.length,
          firstViolations: violations.slice(0, 10),
        },
      };
    }
    if (test.key === 'client-visible-source-routing') {
      const features = getCurrentFrameFeatures();
      const originalFlags = snapshotModeFlags();
      const scenarios = [];
      const missingSampleWarnings = [];
      let restoreOk = false;

      function inspectZone(label, modeKey, featureFinder, validSources, expectedSource, opts = {}) {
        setSingleModeState(modeKey);
        const feature = featureFinder();
        if (!feature) {
          missingSampleWarnings.push(`${label}: no sample feature found`);
          scenarios.push({ label, ok: false, warning: 'No sample feature found' });
          return;
        }
        const zoneId = getFeatureZoneId(feature);
        const zoneAudit = window.getTeamJoseoZoneAuditByLocationId?.(zoneId) || {};
        const source = String(zoneAudit.visibleSource || zoneAudit.visible_source || '').trim();
        const possible = validSources.includes(source);
        if (opts.disallowSources && opts.disallowSources.includes(source)) {
          scenarios.push({ label, zoneId, source, ok: false, expected: expectedSource, reason: 'Impossible source for scenario' });
          return;
        }
        scenarios.push({
          label,
          zoneId,
          source,
          ok: possible,
          expected: expectedSource,
          expectedSeen: source === expectedSource,
        });
      }

      try {
        setSingleModeState(null);
        const citywide = window.getTeamJoseoSystemAudit?.() || {};
        const citywideCount = safeNumber(citywide?.visibleSourceCounts?.citywide_v3_shadow);
        scenarios.push({
          label: 'Citywide default',
          source: 'citywide_v3_shadow',
          ok: citywideCount > 0,
          count: citywideCount,
        });

        inspectZone(
          'Manhattan',
          'manhattan',
          () => findFeatureByPredicate(features, (feature) => /manhattan/i.test(String(feature?.properties?.borough || feature?.properties?.Borough || '')) && !isAirportFeature(feature)),
          ['manhattan_v3_shadow', 'manhattan_shadow', 'manhattan_mode_legacy'],
          'manhattan_v3_shadow'
        );
        inspectZone(
          'Bronx/Wash Heights',
          'bronxWashHeights',
          () => findFeatureByPredicate(features, (feature) => /bronx/i.test(String(feature?.properties?.borough || feature?.properties?.Borough || ''))),
          ['bronx_wash_heights_v3_shadow', 'bronx_wash_heights_shadow', 'bronx_wash_heights_mode_legacy'],
          'bronx_wash_heights_v3_shadow'
        );
        inspectZone(
          'Queens',
          'queens',
          () => findFeatureByPredicate(features, (feature) => /queens/i.test(String(feature?.properties?.borough || feature?.properties?.Borough || '')) && !isAirportFeature(feature)),
          ['queens_v3_shadow', 'queens_shadow', 'queens_mode_legacy'],
          'queens_v3_shadow'
        );
        const queensAirport = findFeatureByPredicate(features, (feature) => /queens/i.test(String(feature?.properties?.borough || feature?.properties?.Borough || '')) && isAirportFeature(feature));
        if (queensAirport) {
          const airportAudit = window.getTeamJoseoZoneAuditByLocationId?.(getFeatureZoneId(queensAirport)) || {};
          const airportSource = String(airportAudit.visibleSource || airportAudit.visible_source || '').trim();
          scenarios.push({
            label: 'Queens airport exclusion',
            zoneId: getFeatureZoneId(queensAirport),
            source: airportSource,
            ok: airportSource !== 'queens_v3_shadow',
          });
        }
        inspectZone(
          'Brooklyn',
          'brooklyn',
          () => findFeatureByPredicate(features, (feature) => /brooklyn/i.test(String(feature?.properties?.borough || feature?.properties?.Borough || ''))),
          ['brooklyn_v3_shadow', 'brooklyn_shadow', 'brooklyn_mode_legacy'],
          'brooklyn_v3_shadow'
        );
        inspectZone(
          'Staten Island',
          'statenIsland',
          () => findFeatureByPredicate(features, (feature) => /staten/i.test(String(feature?.properties?.borough || feature?.properties?.Borough || ''))),
          ['staten_island_v3_shadow', 'staten_island_shadow', 'staten_island_mode_legacy'],
          'staten_island_v3_shadow'
        );
      } finally {
        try {
          restoreModeFlags(originalFlags);
          restoreOk = true;
        } catch (_restoreError) {
          restoreOk = false;
        }
      }

      const citywideOk = scenarios.find((s) => s.label === 'Citywide default')?.ok === true;
      const boroughScenarioLabels = ['Manhattan', 'Bronx/Wash Heights', 'Queens', 'Brooklyn', 'Staten Island'];
      const boroughScenarios = scenarios.filter((s) => boroughScenarioLabels.includes(s.label));
      const boroughFound = boroughScenarios.length === boroughScenarioLabels.length;
      const impossibleSource = boroughScenarios.some((s) => s.ok === false && !/no sample/i.test(String(s.warning || '')));
      const ok = restoreOk && citywideOk && boroughFound && !impossibleSource;

      return {
        ok,
        data: {
          scenarios,
          missingSampleWarnings,
          restoreOk,
        },
      };
    }
    if (test.key === 'client-recommendation-audit') {
      if (typeof window.getTeamJoseoRecommendationAudit !== 'function') {
        return { ok: false, data: { error: 'window.getTeamJoseoRecommendationAudit is not available.' } };
      }
      const audit = window.getTeamJoseoRecommendationAudit();
      if (!audit) return { ok: false, data: { error: 'Recommendation audit returned null.' } };
      const activeModeTag = String(audit.activeModeTag || 'citywide').trim();
      const ok = !!(audit.zoneName && Number.isFinite(Number(audit.rating)) && activeModeTag);
      return {
        ok,
        data: {
          zoneName: audit.zoneName,
          borough: audit.borough,
          rating: Number(audit.rating),
          distanceMiles: audit.distanceMiles,
          activeModeTag,
          crowdingBucket: audit.crowdingBucket ?? audit.crowding_bucket ?? null,
        },
      };
    }
    if (test.key === 'client-crowding-audit') {
      if (typeof window.getCommunityCrowdingDebug !== 'function') {
        return { ok: false, data: { error: 'window.getCommunityCrowdingDebug is not available.' } };
      }
      const debug = window.getCommunityCrowdingDebug();
      const ok = !!(debug && typeof debug.sourceReady === 'boolean' && typeof debug.lineLayerReady === 'boolean');
      return {
        ok,
        data: {
          sourceReady: !!debug?.sourceReady,
          lineLayerReady: !!debug?.lineLayerReady,
          flaggedZoneCount: safeNumber(debug?.flaggedZoneCount ?? debug?.flagged_zone_count),
          watchCount: safeNumber(debug?.watchCount ?? debug?.watch_count),
          crowdedCount: safeNumber(debug?.crowdedCount ?? debug?.crowded_count),
          heavyCount: safeNumber(debug?.heavyCount ?? debug?.heavy_count),
        },
      };
    }
    return { ok: false, data: { message: 'Client test not implemented.' } };
  }

  function renderLoadTestSection(container, helpers, c) {
    const state = {
      enabled: false,
      busy: false,
      unsupported: false,
      errorMessage: '',
      copyMessage: '',
      capabilityMessage: '',
      formConfig: { ...DEFAULT_LOAD_OPTIONS },
      formDirty: false,
      advancedOptionsOpen: false,
      loadData: normalizeLoadResponse({}, DEFAULT_LOAD_OPTIONS),
      pollTimer: null,
      destroyed: false,
      pollInFlight: false,
      pendingStatusRefresh: false,
      hydratedFromActiveRun: false,
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

    function logFormConfig() {
      console.info('synthetic load test form config', state.formConfig);
    }

    function applyFormConfig(nextConfig, options = {}) {
      const normalized = normalizeLoadConfig(nextConfig || {}, true);
      state.formConfig = normalized;
      if (options.markDirty) state.formDirty = true;
      logFormConfig();
    }

    function updateFormConfig(patch, options = {}) {
      applyFormConfig({ ...state.formConfig, ...(patch || {}) }, options);
    }

    function syncFormFromActiveRun(config) {
      if (state.formDirty || state.hydratedFromActiveRun) return;
      applyFormConfig(config || DEFAULT_LOAD_OPTIONS);
      state.hydratedFromActiveRun = true;
    }

    function shouldPoll() {
      return !state.destroyed && !state.unsupported && (state.loadData.active || state.pendingStatusRefresh);
    }

    async function fetchCapabilities() {
      try {
        const payload = await helpers.request('/admin/tests/load/capabilities');
        const details = unwrapAdminTestDetails(payload);
        const supported = pickFirst(payload || {}, ['supported', 'available']) ?? pickFirst(details, ['supported', 'available']);
        if (supported === false) {
          state.unsupported = true;
          state.capabilityMessage = pickFirst(payload || {}, ['message', 'error']) || pickFirst(details, ['message', 'error']) || 'Synthetic load testing is not available on this backend.';
        }
        const loadPayload = pickFirst(details, ['active_run', 'current_run', 'last_result', 'last_completed_result', 'result']) || details || payload || {};
        state.loadData = normalizeLoadResponse(loadPayload, state.loadData.config);
        if (state.loadData.active) {
          state.enabled = true;
          syncFormFromActiveRun(state.loadData.config);
        }
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
        console.info('synthetic load test status response', payload);
        const next = normalizeLoadResponse(payload, state.loadData.config);
        if (state.destroyed) return;
        state.loadData = next;
        state.errorMessage = '';
        if (next.active) {
          state.enabled = true;
          syncFormFromActiveRun(next.config);
        }
      } catch (error) {
        state.errorMessage = error?.message || 'Failed to refresh load-test status.';
      } finally {
        state.pendingStatusRefresh = false;
        state.pollInFlight = false;
        render();
        syncPolling();
      }
    }

    function syncPolling() {
      if (!shouldPoll()) {
        clearPollTimer();
        return;
      }
      if (state.loadData.active) {
        if (!state.pollTimer) {
          state.pollTimer = setInterval(() => {
            fetchStatus();
          }, LOAD_POLL_MS);
        }
        return;
      }
      clearPollTimer();
      if (state.pendingStatusRefresh && !state.pollInFlight) {
        fetchStatus();
      }
    }

    async function startLoadTest() {
      state.busy = true;
      state.errorMessage = '';
      state.copyMessage = '';
      render();
      try {
        const requestBody = buildLoadRequestBody(state.formConfig);
        console.info('synthetic load test start body', requestBody);
        const payload = await helpers.request('/admin/tests/load/start', {
          method: 'POST',
          body: requestBody,
        });
        console.info('synthetic load test start response', payload);
        const next = normalizeLoadResponse(payload, requestBody);
        if (state.destroyed) return;
        state.loadData = next;

        const startFailed = !next.active && ['fail', 'error', 'idle', 'stopped', 'unsupported'].includes(normalizeStatus(next.status));
        if (startFailed) {
          state.errorMessage = extractLoadErrorMessage({
            status: 200,
            message: next.errorMessage || next.summary || 'Synthetic load test did not start.',
            payload: payload && typeof payload === 'object' ? payload : { message: String(payload || '') },
            detail: payload?.detail || payload?.details || null,
          }, 'Failed to start synthetic load test.');
        } else {
          state.enabled = true;
          state.pendingStatusRefresh = true;
        }
      } catch (error) {
        state.errorMessage = extractLoadErrorMessage(error, 'Failed to start synthetic load test.');
      } finally {
        state.busy = false;
        render();
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
        const next = normalizeLoadResponse(payload, state.loadData.config);
        if (state.destroyed) return;
        state.loadData = next;
        state.pendingStatusRefresh = true;
      } catch (error) {
        state.errorMessage = error?.message || 'Failed to stop synthetic load test.';
      } finally {
        state.busy = false;
        render();
        syncPolling();
      }
    }

    function toggleOption(name) {
      updateFormConfig({ [name]: !state.formConfig[name] }, { markDirty: true });
      render();
    }

    function formatModeLabel(mode) {
      return mode === 'map_plus_chat' ? 'Map + Chat' : 'Map Core';
    }

    function formatOptionState(value) {
      return value ? 'on' : 'off';
    }

    function formatNextRunSummary() {
      return `Next run: ${state.formConfig.preset} drivers • ${formatModeLabel(state.formConfig.mode)} • ${state.formConfig.duration_sec}s`;
    }

    function formatOptionsSummary() {
      return `Options: presence writes ${formatOptionState(state.formConfig.include_presence_writes)}, viewport ${formatOptionState(state.formConfig.include_presence_viewport_reads)}, summary ${formatOptionState(state.formConfig.include_presence_summary_reads)}, delta ${formatOptionState(state.formConfig.include_presence_delta_reads)}, pickup overlay ${formatOptionState(state.formConfig.include_pickup_overlay_reads)}, leaderboard ${formatOptionState(state.formConfig.include_leaderboard_reads)}, chat-lite ${formatOptionState(state.formConfig.include_chat_lite)}`;
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
      const controlsDisabled = active || state.busy || state.unsupported;
      const progressWidth = `${clamp(state.loadData.progressPercent, 0, 100)}%`;
      const statusLabel = formatLoadStatus(state.loadData.status);
      const resultTone = loadTone(state.loadData.status);
      const reasons = state.loadData.reasons.length ? state.loadData.reasons : [state.loadData.summary];
      const summaryText = buildLoadSummary(state.loadData);
      const debugJson = JSON.stringify(state.loadData.debug ?? state.loadData.raw ?? null, null, 2);
      const nextRunSummary = formatNextRunSummary();
      const optionsSummary = formatOptionsSummary();

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
              <div class="adminSectionHead wrap">
                <div>
                  <div class="adminCardLabel">Next run</div>
                  <div class="adminMuted">${c.esc(nextRunSummary)}</div>
                  <div class="adminMuted">${c.esc(optionsSummary)}</div>
                </div>
              </div>

              <div>
                <div class="adminCardLabel">Driver preset</div>
                <div class="adminRow wrap adminLoadPresetRow">
                  ${LOAD_PRESETS.map((preset) => `<button type="button" class="adminToggleBtn${state.formConfig.preset === preset ? ' active' : ''}" data-load-preset="${preset}" ${controlsDisabled ? 'disabled' : ''}>${preset} drivers</button>`).join('')}
                </div>
              </div>

              <div class="adminLoadAdvanced">
                <button type="button" class="adminBtn adminLoadAdvancedToggle" id="adminLoadAdvancedToggle" aria-expanded="${state.advancedOptionsOpen ? 'true' : 'false'}">
                  Advanced options
                </button>
                <div class="adminDetailsBody" ${state.advancedOptionsOpen ? '' : 'hidden'}>
                  <div class="adminRow wrap adminLoadFieldRow">
                    <label class="adminLoadField">
                      <span>Duration seconds</span>
                      <input class="adminInput" type="number" min="30" max="90" step="15" id="adminLoadDuration" value="${c.esc(state.formConfig.duration_sec)}" ${controlsDisabled ? 'disabled' : ''}>
                    </label>
                    <label class="adminLoadField">
                      <span>Mode</span>
                      <select class="adminInput" id="adminLoadMode" ${controlsDisabled ? 'disabled' : ''}>
                        <option value="map_core" ${state.formConfig.mode === 'map_core' ? 'selected' : ''}>Map Core</option>
                        <option value="map_plus_chat" ${state.formConfig.mode === 'map_plus_chat' ? 'selected' : ''}>Map + Chat</option>
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
                    ].map(([key, label]) => `<button type="button" class="adminToggleBtn${state.formConfig[key] ? ' active' : ''}" data-load-option="${key}" ${controlsDisabled ? 'disabled' : ''}>${c.esc(label)}</button>`).join('')}
                  </div>
                </div>
              </div>

              <div class="adminRow wrap adminLoadActionRow">
                <button type="button" class="adminBtn" id="adminLoadStartBtn" ${(active || state.busy || state.unsupported) ? 'disabled' : ''}>Start Load Test</button>
                <button type="button" class="adminBtn danger" id="adminLoadStopBtn" ${(!active || state.busy || state.unsupported) ? 'disabled' : ''}>Stop</button>
                <button type="button" class="adminBtn" id="adminLoadRefreshBtn" ${(state.busy || state.unsupported) ? 'disabled' : ''}>Refresh</button>
              </div>
            </div>
          ` : '<div class="adminMuted">Enable the toggle to configure a server-side synthetic load run. Status stays visible while a run is active.</div>'}

          <div class="adminSectionHead wrap">
            <div>
              <div class="adminCardLabel">Last result / current run</div>
              <div class="adminMuted">Latest server-side status and metrics for the current or most recent synthetic load run.</div>
            </div>
          </div>

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

      container.querySelector('#adminLoadAdvancedToggle')?.addEventListener('click', () => {
        state.advancedOptionsOpen = !state.advancedOptionsOpen;
        render();
      });

      container.querySelectorAll('[data-load-preset]').forEach((button) => {
        button.addEventListener('click', () => {
          updateFormConfig({ preset: normalizeDriverCount(button.dataset.loadPreset) }, { markDirty: true });
          render();
        });
      });

      container.querySelectorAll('[data-load-option]').forEach((button) => {
        button.addEventListener('click', () => toggleOption(button.dataset.loadOption));
      });

      container.querySelector('#adminLoadDuration')?.addEventListener('change', (event) => {
        updateFormConfig({ duration_sec: normalizeDuration(event.currentTarget.value) }, { markDirty: true });
        render();
      });

      container.querySelector('#adminLoadMode')?.addEventListener('change', (event) => {
        updateFormConfig({ mode: normalizeMode(event.currentTarget.value) }, { markDirty: true });
        render();
      });

      container.querySelector('#adminLoadRefreshBtn')?.addEventListener('click', () => {
        state.pendingStatusRefresh = true;
        syncPolling();
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
        const next = buildResult(test, response, c, resultState);
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