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
      ],
    },
    {
      label: 'Optional External/Client checks',
      tests: [
        { key: 'weather-api', label: 'Test Weather API request', type: 'client' },
        { key: 'radio-ui', label: 'Test radio/audio availability only at the UI/client level if already feasible without changing app behavior', type: 'client' },
        { key: 'admin-session', label: 'Test local admin session state', type: 'client' },
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

  function runClientTest(test, helpers) {
    if (test.key === 'admin-session') {
      const me = helpers?.session?.me || null;
      return { ok: !!me?.is_admin, data: { isAdmin: !!me?.is_admin, userId: me?.id || 'N/A' } };
    }
    if (test.key === 'weather-api') {
      return { ok: typeof fetch === 'function', data: { fetchAvailable: typeof fetch === 'function' } };
    }
    if (test.key === 'radio-ui') {
      const hasAudio = !!document.querySelector('audio');
      return { ok: hasAudio, data: { audioElementPresent: hasAudio } };
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
          response = runClientTest(test, helpers);
        } else {
          const data = await helpers.request(test.path);
          response = { ok: true, data };
        }
        const status = statusFrom(response.ok, response.data);
        const next = {
          status,
          data: response.data,
          detail: summarize(response.data, c),
          lastRun: Date.now(),
        };
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
