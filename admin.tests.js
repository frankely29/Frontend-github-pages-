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

  function safeNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
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
      <div class="adminSection">
        <div class="adminSectionHead wrap">
          <h4>System Tests</h4>
          <button type="button" class="adminBtn" id="adminRunAllTestsBtn">Run All Tests</button>
        </div>
        <div class="adminMuted">Manual read-only diagnostics. Tests run only when triggered.</div>
      </div>
      ${sections}
    `;

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
