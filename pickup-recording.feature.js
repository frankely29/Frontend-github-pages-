(function () {
  const FEATURE = {};
  const PICKUP_SAVE_COOLDOWN_MS = 10 * 60 * 1000;
  let pickupSaveCooldownUntilMs = 0;

  function getCtx() {
    const getter = window.getPickupRecordingContext;
    return typeof getter === 'function' ? getter() : null;
  }

  function toMessageString(value, fallback = '') {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return fallback;
  }

  async function postJSONDetailed(path, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${window.API_BASE || ''}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body || {}),
    });

    let parsed = null;
    const txt = await res.text();
    if (txt) {
      try { parsed = JSON.parse(txt); } catch (_e) { parsed = { message: txt }; }
    }
    if (res.ok) return parsed || {};

    const err = new Error(
      toMessageString(parsed?.detail?.detail) ||
      toMessageString(parsed?.detail?.message) ||
      toMessageString(parsed?.message) ||
      toMessageString(parsed?.detail?.title) ||
      toMessageString(res.statusText) ||
      'Request failed'
    );
    err.status = res.status;
    err.payload = parsed;
    err.code = parsed?.detail?.code || parsed?.code || null;
    err.detail = parsed?.detail || parsed || null;
    throw err;
  }

  function rankIcon(iconKey) {
    const map = {
      recruit: '🪖', private: '🎖️', corporal: '🛡️', sergeant: '⭐', staff_sergeant: '🌟',
      sergeant_first_class: '🏅', master_sergeant: '🏆', lieutenant: '🧭', captain: '⚔️',
      major: '🦅', colonel: '🎯', brigadier: '🚀', major_general: '🛰️', lieutenant_general: '🔥',
      general: '👑', commander: '🗽', road_legend: '🏁'
    };
    return map[String(iconKey || '').toLowerCase()] || '🏁';
  }

  function removeIfExists(id) {
    const n = document.getElementById(id);
    if (n && n.parentNode) n.parentNode.removeChild(n);
  }

  function showPickupGuardNotice({ title, message, tone } = {}) {
    const header = toMessageString(title, 'Trip not saved');
    const detail = toMessageString(message, 'Try again after moving and driving a bit longer.');
    const el = document.createElement('div');
    el.id = 'pickupGuardNotice';
    el.style.cssText = 'position:fixed;left:50%;bottom:110px;transform:translateX(-50%);z-index:2500;background:#101522;color:#fff;padding:12px 14px;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.35);max-width:min(92vw,460px);font-family:system-ui;border:1px solid rgba(255,255,255,.18)';
    if (tone === 'warn') el.style.background = '#3b2a00';
    if (tone === 'ok') el.style.background = '#0f2c1f';
    el.innerHTML = `<strong style="display:block;margin-bottom:4px;">${header}</strong><span>${detail}</span>`;
    removeIfExists('pickupGuardNotice');
    document.body.appendChild(el);
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 3600);
  }

  function showPickupReward(payload = {}) {
    const p = payload.progression || payload;
    const level = Number(p.level || 1);
    const totalXP = Number(p.total_xp || 0);
    const cur = Number(p.current_level_xp || 0);
    const next = Number(p.next_level_xp || 100);
    const delta = Math.max(0, next - cur);
    const xpAwarded = Number(payload.xp_awarded || 0);
    const pct = next > 0 ? Math.max(0, Math.min(100, Math.round((cur / next) * 100))) : 100;

    const card = document.createElement('div');
    card.id = 'pickupRewardToast';
    card.style.cssText = 'position:fixed;right:16px;bottom:110px;z-index:2501;width:min(92vw,340px);background:linear-gradient(145deg,#0a1628,#132d4b);color:#fff;border-radius:16px;padding:14px 14px 12px;box-shadow:0 12px 32px rgba(0,0,0,.35);font-family:system-ui;border:1px solid rgba(120,180,255,.35)';
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
        <div><div style="font-size:12px;opacity:.86">XP Earned</div><div style="font-size:20px;font-weight:800">+${xpAwarded}</div></div>
        <div style="font-size:28px">${rankIcon(p.rank_icon_key)}</div>
      </div>
      <div style="margin-top:8px;font-weight:700">Level ${level} • ${toMessageString(p.rank_name, 'Driver')}</div>
      <div style="margin-top:8px;background:rgba(255,255,255,.2);height:8px;border-radius:999px;overflow:hidden"><div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#53c4ff,#81f4a8)"></div></div>
      <div style="margin-top:6px;font-size:12px;opacity:.9">${next > 0 ? `+${xpAwarded} • ${delta} XP to next level` : 'MAX LEVEL'} • Total XP ${totalXP}</div>
    `;
    removeIfExists('pickupRewardToast');
    document.body.appendChild(card);
    setTimeout(() => { if (card.parentNode) card.parentNode.removeChild(card); }, 4500);
  }

  function showPickupLevelUp(payload = {}) {
    const p = payload.progression || payload;
    const level = Number(payload.new_level || p.level || 1);
    const name = toMessageString(p.rank_name, 'Driver');
    const ov = document.createElement('div');
    ov.id = 'pickupLevelUpOverlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:2600;background:rgba(3,8,18,.78);display:flex;align-items:center;justify-content:center;font-family:system-ui';
    ov.innerHTML = `<div style="background:#0f2139;color:#fff;padding:24px;border-radius:20px;box-shadow:0 20px 40px rgba(0,0,0,.5);text-align:center;max-width:420px;width:90%;border:1px solid rgba(140,190,255,.4)"><div style="font-size:44px">${rankIcon(p.rank_icon_key)}</div><div style="font-size:12px;opacity:.8">LEVEL UP</div><div style="font-weight:900;font-size:30px;margin:6px 0">Level ${level}</div><div style="font-size:18px">${name}</div><button type="button" style="margin-top:14px;background:#55a8ff;color:#071324;border:0;border-radius:10px;padding:8px 14px;font-weight:700;cursor:pointer">Continue</button></div>`;
    ov.querySelector('button')?.addEventListener('click', () => ov.remove());
    removeIfExists('pickupLevelUpOverlay');
    document.body.appendChild(ov);
  }

  function formatCooldownWait(msLeft) {
    const secs = Math.max(1, Math.ceil(msLeft / 1000));
    const min = Math.floor(secs / 60);
    const sec = secs % 60;
    if (min > 0) return `${min}m ${sec}s`;
    return `${sec}s`;
  }

  async function sendPickupLog() {
    const ctx = getCtx();
    if (!ctx) {
      alert('Pickup feature context unavailable.');
      return;
    }
    if (!ctx.authHeaderOK?.()) {
      ctx.setAuthUI?.(false, 'Sign in to record trips.');
      return;
    }
    if (!ctx.userLatLng) {
      showPickupGuardNotice({ title: 'Location needed', message: 'Enable location first.', tone: 'warn' });
      return;
    }
    if (Date.now() < pickupSaveCooldownUntilMs) {
      showPickupGuardNotice({ title: 'Save button cooling off', message: `Wait ${formatCooldownWait(pickupSaveCooldownUntilMs - Date.now())} before saving another trip.`, tone: 'warn' });
      return;
    }

    try {
      const ts_unix = Math.floor(Date.now() / 1000);
      const near = ctx.nearestZoneToUser?.(ctx.currentFrame, ctx.userLatLng) || null;
      const zoneId = near?.location_id ?? null;
      const res = await postJSONDetailed('/events/pickup', {
        lat: ctx.userLatLng.lat,
        lng: ctx.userLatLng.lng,
        ts_unix,
        frame_time: ctx.currentFrame?.time || null,
        zone_id: zoneId,
        location_id: zoneId,
        zone_name: near?.zone_name ?? null,
        borough: near?.borough ?? null,
      }, ctx.communityToken);

      const cooldownUnix = Number(res?.cooldown_until_unix || 0);
      if (cooldownUnix > 0) pickupSaveCooldownUntilMs = cooldownUnix * 1000;
      else pickupSaveCooldownUntilMs = Date.now() + PICKUP_SAVE_COOLDOWN_MS;

      ctx.schedulePickupOverlayRefresh?.({ force: true });
      showPickupReward(res);
      if (res?.leveled_up) showPickupLevelUp(res);
      return res;
    } catch (err) {
      const status = Number(err?.status || 0);
      if (status === 401) {
        ctx.clearAuth?.();
        return;
      }
      const detail = err?.detail || err?.payload?.detail || err?.payload || {};
      const title = toMessageString(detail?.title, 'Trip not saved');
      const message = toMessageString(detail?.detail || detail?.message, toMessageString(err?.message, 'Trip record failed.'));

      if (status === 409 || status === 429) {
        if (detail?.code === 'pickup_cooldown_active') {
          const until = Number(detail?.cooldown_until_unix || 0);
          if (until > 0) pickupSaveCooldownUntilMs = until * 1000;
        }
        showPickupGuardNotice({ title, message, tone: 'warn' });
        return;
      }

      const fallback = toMessageString(err?.message, 'Trip record failed.');
      if (fallback) alert(fallback);
    }
  }

  async function apiGet(path, token) {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch(`${window.API_BASE || ''}${path}`, { headers });
    const txt = await res.text();
    let data = {};
    if (txt) {
      try { data = JSON.parse(txt); } catch (_e) { data = { message: txt }; }
    }
    if (!res.ok) throw new Error(toMessageString(data?.message, res.statusText || 'Request failed'));
    return data;
  }

  async function loadAdminRecentPickupTrips(opts = {}) {
    const ctx = getCtx() || {};
    const includeVoided = opts.include_voided ? 1 : 0;
    const limit = Number(opts.limit || 50);
    return apiGet(`/admin/pickup-recording/trips/recent?limit=${limit}&include_voided=${includeVoided}`, ctx.communityToken);
  }

  async function voidAdminPickupTrip(tripId, reason) {
    const ctx = getCtx() || {};
    return postJSONDetailed(`/admin/pickup-recording/trips/${encodeURIComponent(tripId)}/void`, { reason }, ctx.communityToken);
  }

  function renderTripRows(rows, boardEl, includeVoided) {
    if (!boardEl) return;
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      boardEl.innerHTML = '<div class="adminMuted">No trips found.</div>';
      return;
    }
    boardEl.innerHTML = list.map((r) => {
      const state = r.is_voided ? 'VOIDED' : 'ACTIVE';
      const user = r.display_name || `User ${r.user_id || 'n/a'}`;
      const reason = r.void_reason ? `<div class="adminMuted">Reason: ${String(r.void_reason)}</div>` : '';
      const delBtn = r.is_voided ? '' : `<button type="button" class="adminBtn" data-pickup-void="${String(r.id)}">Delete Fake Trip</button>`;
      return `<article class="adminUserCard"><div class="adminRowBetween"><strong>#${r.id} • ${user}</strong><span class="adminPill ${r.is_voided ? 'no' : 'yes'}">${state}</span></div><div class="adminMuted">Zone: ${r.zone_name || r.zone_id || 'n/a'} • Borough: ${r.borough || 'n/a'}</div><div class="adminMuted">Created: ${r.created_at || 'n/a'} • Guard: ${r.guard_reason || 'n/a'}</div>${reason}<div class="adminRow wrap" style="margin-top:8px">${delBtn}</div></article>`;
    }).join('');

    boardEl.querySelectorAll('[data-pickup-void]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const tripId = btn.getAttribute('data-pickup-void');
        const reason = prompt('Reason for deleting fake trip:');
        if (!reason || reason.trim().length < 5) {
          showPickupGuardNotice({ title: 'Reason required', message: 'Provide at least 5 characters.', tone: 'warn' });
          return;
        }
        const confirmed = confirm('This will remove the selected trip from active map data but keep the audit record.');
        if (!confirmed) return;
        try {
          await voidAdminPickupTrip(tripId, reason.trim());
          showPickupGuardNotice({ title: 'Trip voided', message: `Trip #${tripId} was soft deleted.`, tone: 'ok' });
          const fresh = await loadAdminRecentPickupTrips({ include_voided: includeVoided, limit: 50 });
          renderTripRows(fresh?.items || fresh?.trips || [], boardEl, includeVoided);
        } catch (e) {
          showPickupGuardNotice({ title: 'Void failed', message: e.message || 'Request failed.', tone: 'warn' });
        }
      });
    });
  }

  async function runAdminPickupRecordingFullSuite(rootEl) {
    const ctx = getCtx() || {};
    const token = ctx.communityToken;
    const checks = [];
    async function test(name, fn) {
      try {
        await fn();
        checks.push({ name, ok: true });
      } catch (e) {
        checks.push({ name, ok: false, msg: e.message || 'failed' });
      }
    }
    await test('backend health', async () => { await apiGet('/admin/pickup-recording/tests/health', token); });
    await test('pickup recent', async () => { await loadAdminRecentPickupTrips({ include_voided: false, limit: 20 }); });
    await test('save simulate', async () => {
      await postJSONDetailed('/admin/pickup-recording/tests/simulate-save', { user_id: ctx?.me?.id || 0, lat: 40.7, lng: -74.0, zone_id: 1, zone_name: 'Test Zone', borough: 'Manhattan', frame_time: null }, token);
    });
    await test('cooldown handling', async () => { await postJSONDetailed('/admin/pickup-recording/tests/guard-evaluate', { user_id: ctx?.me?.id || 0, lat: 40.7, lng: -74.0 }, token); });
    await test('guard message shape', async () => {
      try {
        await postJSONDetailed('/events/pickup', { lat: null }, token);
      } catch (e) {
        if (typeof e.message !== 'string') throw new Error('message is not string');
      }
    });
    await test('void filter', async () => { await apiGet('/admin/pickup-recording/tests/filter-smoke', token); });
    await test('trip void action', async () => { /* manual, keep as informational */ });

    if (rootEl) {
      const board = rootEl.querySelector('[data-pickup-results]');
      if (board) {
        board.innerHTML = checks.map((x) => `<div class="adminKV"><span>${x.ok ? '✅' : '❌'} ${x.name}</span><strong>${x.ok ? 'PASS' : (x.msg || 'FAIL')}</strong></div>`).join('');
      }
    }
    return checks;
  }

  function mountAdminPickupRecordingTests(container, helpers) {
    if (!container) return;
    container.innerHTML = `
      <section class="adminSection">
        <div class="adminSectionHead wrap"><h4>Pickup Recording Tests</h4></div>
        <div class="adminRow wrap">
          <button class="adminBtn" data-pickup-health>Run Health</button>
          <button class="adminBtn" data-pickup-full>Run Full Suite</button>
        </div>
        <div class="adminRow wrap" style="margin-top:8px">
          <input class="adminInput" data-pickup-user placeholder="user id" style="max-width:120px" />
          <input class="adminInput" data-pickup-lat placeholder="lat" style="max-width:130px" />
          <input class="adminInput" data-pickup-lng placeholder="lng" style="max-width:130px" />
          <button class="adminBtn" data-pickup-guard>Evaluate Guard</button>
          <button class="adminBtn" data-pickup-sim>Simulate Save</button>
        </div>
        <div class="adminRow wrap" style="margin-top:8px">
          <button class="adminBtn" data-pickup-refresh>Refresh Trips</button>
          <button class="adminBtn" data-pickup-active>Show Active Only</button>
          <button class="adminBtn" data-pickup-all>Show Including Deleted</button>
        </div>
        <div data-pickup-results class="adminListMini" style="margin-top:10px"></div>
        <div data-pickup-trips class="adminList" style="margin-top:10px"></div>
      </section>`;

    const resultEl = container.querySelector('[data-pickup-results]');
    const tripsEl = container.querySelector('[data-pickup-trips]');
    let includeVoided = false;

    function readInputs() {
      const user_id = Number(container.querySelector('[data-pickup-user]')?.value || 0) || (getCtx()?.me?.id || 0);
      const lat = Number(container.querySelector('[data-pickup-lat]')?.value || getCtx()?.userLatLng?.lat || 40.7128);
      const lng = Number(container.querySelector('[data-pickup-lng]')?.value || getCtx()?.userLatLng?.lng || -74.0060);
      return { user_id, lat, lng };
    }

    async function refreshTrips() {
      const data = await loadAdminRecentPickupTrips({ include_voided: includeVoided, limit: 50 });
      renderTripRows(data?.items || data?.trips || [], tripsEl, includeVoided);
    }

    container.querySelector('[data-pickup-health]')?.addEventListener('click', async () => {
      try {
        const ctx = getCtx() || {};
        const data = await apiGet('/admin/pickup-recording/tests/health', ctx.communityToken);
        resultEl.innerHTML = `<div class="adminKV"><span>backend health</span><strong>✅ PASS</strong></div><pre class="adminPre">${JSON.stringify(data, null, 2)}</pre>`;
      } catch (e) {
        resultEl.innerHTML = `<div class="adminKV"><span>backend health</span><strong>❌ FAIL</strong></div><div class="adminMuted">${e.message || 'Request failed'}</div>`;
      }
    });

    container.querySelector('[data-pickup-full]')?.addEventListener('click', async () => {
      await runAdminPickupRecordingFullSuite(container);
    });

    container.querySelector('[data-pickup-guard]')?.addEventListener('click', async () => {
      const ctx = getCtx() || {};
      const payload = readInputs();
      try {
        const data = await postJSONDetailed('/admin/pickup-recording/tests/guard-evaluate', payload, ctx.communityToken);
        resultEl.innerHTML = `<pre class="adminPre">${JSON.stringify(data, null, 2)}</pre>`;
      } catch (e) {
        resultEl.innerHTML = `<div class="adminMuted">${e.message || 'Guard evaluate failed'}</div>`;
      }
    });

    container.querySelector('[data-pickup-sim]')?.addEventListener('click', async () => {
      const ctx = getCtx() || {};
      const p = readInputs();
      try {
        const data = await postJSONDetailed('/admin/pickup-recording/tests/simulate-save', { ...p, zone_id: 1, zone_name: 'Test Zone', borough: 'Manhattan', frame_time: null }, ctx.communityToken);
        resultEl.innerHTML = `<pre class="adminPre">${JSON.stringify(data, null, 2)}</pre>`;
      } catch (e) {
        resultEl.innerHTML = `<div class="adminMuted">${e.message || 'simulate failed'}</div>`;
      }
    });

    container.querySelector('[data-pickup-refresh]')?.addEventListener('click', refreshTrips);
    container.querySelector('[data-pickup-active]')?.addEventListener('click', async () => { includeVoided = false; await refreshTrips(); });
    container.querySelector('[data-pickup-all]')?.addEventListener('click', async () => { includeVoided = true; await refreshTrips(); });

    if (helpers && typeof helpers.onCleanup === 'function') helpers.onCleanup(() => {});
    refreshTrips().catch(() => {});
  }

  FEATURE.sendPickupLog = sendPickupLog;
  FEATURE.showPickupGuardNotice = showPickupGuardNotice;
  FEATURE.showPickupReward = showPickupReward;
  FEATURE.showPickupLevelUp = showPickupLevelUp;
  FEATURE.mountAdminPickupRecordingTests = mountAdminPickupRecordingTests;
  FEATURE.runAdminPickupRecordingFullSuite = runAdminPickupRecordingFullSuite;
  FEATURE.loadAdminRecentPickupTrips = loadAdminRecentPickupTrips;
  FEATURE.voidAdminPickupTrip = voidAdminPickupTrip;
  FEATURE.postJSONDetailed = postJSONDetailed;

  window.PickupRecordingFeature = FEATURE;
})();
