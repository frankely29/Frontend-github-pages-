(function () {
  const FEATURE = {};
  let pickupSaveInFlight = false;
  let pickupSaveCooldownUntilMs = 0;

  function getCtx() {
    const getter = window.getPickupRecordingContext;
    return typeof getter === 'function' ? getter() : null;
  }

  function toSafeString(value, fallback = '') {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return fallback;
  }

  function extractPickupErrorMessage(err) {
    const candidates = [
      err?.detail?.detail,
      err?.detail?.message,
      err?.payload?.detail?.detail,
      err?.payload?.detail?.message,
      err?.payload?.message,
      err?.message,
    ];
    for (const candidate of candidates) {
      const msg = toSafeString(candidate);
      if (msg && msg !== '[object Object]') return msg;
    }
    return 'Request failed';
  }

  function createErrorWithMeta(message, meta = {}) {
    const error = new Error(toSafeString(message, 'Request failed'));
    error.status = Number(meta.status || 0);
    error.payload = meta.payload || null;
    error.code = meta.code || null;
    error.detail = meta.detail || null;
    return error;
  }

  async function postJSONDetailed(path, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    let res;
    try {
      res = await fetch(`${window.API_BASE || ''}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body || {}),
      });
    } catch (fetchErr) {
      throw createErrorWithMeta(extractPickupErrorMessage(fetchErr), {});
    }

    let payload = null;
    const text = await res.text();
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (_err) {
        payload = { message: text };
      }
    }

    if (res.ok) return payload || {};

    const message =
      toSafeString(payload?.detail?.detail) ||
      toSafeString(payload?.detail?.message) ||
      toSafeString(payload?.message) ||
      toSafeString(payload?.detail?.title) ||
      toSafeString(res.statusText) ||
      'Request failed';

    throw createErrorWithMeta(message, {
      status: res.status,
      payload,
      code: payload?.detail?.code || payload?.code || null,
      detail: payload?.detail || payload || null,
    });
  }

  async function apiGet(path, token) {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch(`${window.API_BASE || ''}${path}`, { headers });
    const text = await res.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (_err) {
        payload = { message: text };
      }
    }
    if (!res.ok) {
      throw createErrorWithMeta(
        toSafeString(payload?.message) || toSafeString(res.statusText) || 'Request failed',
        { status: res.status, payload, code: payload?.code || null, detail: payload?.detail || payload || null }
      );
    }
    return payload || {};
  }

  function removeIfExists(id) {
    const node = document.getElementById(id);
    if (node?.parentNode) node.parentNode.removeChild(node);
  }

  function rankIcon(iconKey) {
    const map = {
      recruit: '🪖', private: '🎖️', corporal: '🛡️', sergeant: '⭐', staff_sergeant: '🌟',
      sergeant_first_class: '🏅', master_sergeant: '🏆', lieutenant: '🧭', captain: '⚔️',
      major: '🦅', colonel: '🎯', brigadier: '🚀', major_general: '🛰️', lieutenant_general: '🔥',
      general: '👑', commander: '🗽', road_legend: '🏁',
    };
    return map[String(iconKey || '').toLowerCase()] || '🏁';
  }

  function ensurePickupGuardNotice() {
    let root = document.getElementById('pickupGuardNotice');
    if (!root) {
      root = document.createElement('div');
      root.id = 'pickupGuardNotice';
      root.style.cssText = 'position:fixed;left:50%;bottom:110px;transform:translateX(-50%);z-index:2500;max-width:min(92vw,460px);font-family:system-ui;display:none';
      document.body.appendChild(root);
    }
    return root;
  }

  function showPickupGuardNotice({ title, message, tone } = {}) {
    const root = ensurePickupGuardNotice();
    const palette = tone === 'danger'
      ? { bg: '#3b1010', border: 'rgba(255,120,120,.45)' }
      : tone === 'warning'
        ? { bg: '#3b2a00', border: 'rgba(255,200,120,.45)' }
        : { bg: '#0f2c1f', border: 'rgba(120,255,180,.45)' };

    const header = toSafeString(title, 'Trip not saved');
    const detail = toSafeString(message, 'Try again after moving and driving a bit longer.');
    root.style.display = 'block';
    root.style.background = palette.bg;
    root.style.color = '#fff';
    root.style.padding = '12px 14px';
    root.style.borderRadius = '12px';
    root.style.boxShadow = '0 10px 30px rgba(0,0,0,.35)';
    root.style.border = `1px solid ${palette.border}`;
    root.innerHTML = `<strong style="display:block;margin-bottom:4px;"></strong><span></span>`;
    const strong = root.querySelector('strong');
    const span = root.querySelector('span');
    if (strong) strong.textContent = header;
    if (span) span.textContent = detail;
    window.clearTimeout(root._pickupTimer);
    root._pickupTimer = window.setTimeout(() => {
      root.style.display = 'none';
    }, 3600);
  }

  function showPickupReward(payload = {}) {
    const p = payload.progression || payload;
    const level = Number(p.level || 1);
    const rankName = toSafeString(p.rank_name, 'Driver');
    const xpAwarded = Number(payload.xp_awarded || 0);
    const currentXP = Number(p.current_level_xp || 0);
    const nextXP = Number(p.next_level_xp || 0);
    const totalXP = Number(p.total_xp || 0);
    const progressPct = nextXP > 0 ? Math.max(0, Math.min(100, Math.round((currentXP / nextXP) * 100))) : 100;
    const toNext = Math.max(0, nextXP - currentXP);

    removeIfExists('pickupRewardToast');
    const card = document.createElement('div');
    card.id = 'pickupRewardToast';
    card.style.cssText = 'position:fixed;right:16px;bottom:110px;z-index:2501;width:min(92vw,340px);background:linear-gradient(145deg,#0a1628,#132d4b);color:#fff;border-radius:16px;padding:14px 14px 12px;box-shadow:0 12px 32px rgba(0,0,0,.35);font-family:system-ui;border:1px solid rgba(120,180,255,.35)';
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
        <div><div style="font-size:12px;opacity:.86">XP Earned</div><div style="font-size:20px;font-weight:800"></div></div>
        <div style="font-size:28px"></div>
      </div>
      <div data-rank style="margin-top:8px;font-weight:700"></div>
      <div style="margin-top:8px;background:rgba(255,255,255,.2);height:8px;border-radius:999px;overflow:hidden"><div data-progress style="height:100%;background:linear-gradient(90deg,#53c4ff,#81f4a8)"></div></div>
      <div data-footer style="margin-top:6px;font-size:12px;opacity:.9"></div>
    `;
    const xpEl = card.querySelector('div div div:nth-child(2)');
    const iconEl = card.querySelector('div div:nth-child(2)');
    const rankEl = card.querySelector('[data-rank]');
    const progressEl = card.querySelector('[data-progress]');
    const footerEl = card.querySelector('[data-footer]');
    if (xpEl) xpEl.textContent = `+${xpAwarded}`;
    if (iconEl) iconEl.textContent = rankIcon(p.rank_icon_key);
    if (rankEl) rankEl.textContent = `Level ${level} • ${rankName}`;
    if (progressEl) progressEl.style.width = `${progressPct}%`;
    if (footerEl) footerEl.textContent = nextXP > 0 ? `+${xpAwarded} • ${toNext} XP to next level • Total XP ${totalXP}` : `MAX LEVEL • Total XP ${totalXP}`;

    document.body.appendChild(card);
    window.setTimeout(() => { if (card.parentNode) card.parentNode.removeChild(card); }, 4500);
  }

  function showPickupLevelUp(payload = {}) {
    const p = payload.progression || payload;
    const level = Number(payload.new_level || p.level || 1);
    const name = toSafeString(p.rank_name, 'Driver');
    removeIfExists('pickupLevelUpOverlay');

    const overlay = document.createElement('div');
    overlay.id = 'pickupLevelUpOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2600;background:rgba(3,8,18,.78);display:flex;align-items:center;justify-content:center;font-family:system-ui';
    overlay.innerHTML = '<div style="background:#0f2139;color:#fff;padding:24px;border-radius:20px;box-shadow:0 20px 40px rgba(0,0,0,.5);text-align:center;max-width:420px;width:90%;border:1px solid rgba(140,190,255,.4)"><div data-icon style="font-size:44px"></div><div style="font-size:12px;opacity:.8">LEVEL UP</div><div data-level style="font-weight:900;font-size:30px;margin:6px 0"></div><div data-name style="font-size:18px"></div><button type="button" style="margin-top:14px;background:#55a8ff;color:#071324;border:0;border-radius:10px;padding:8px 14px;font-weight:700;cursor:pointer">Continue</button></div>';
    overlay.querySelector('[data-icon]').textContent = rankIcon(p.rank_icon_key);
    overlay.querySelector('[data-level]').textContent = `Level ${level}`;
    overlay.querySelector('[data-name]').textContent = name;
    overlay.querySelector('button')?.addEventListener('click', () => overlay.remove());
    document.body.appendChild(overlay);
  }

  function formatCooldownWait(msLeft) {
    const secs = Math.max(1, Math.ceil(msLeft / 1000));
    const min = Math.floor(secs / 60);
    const sec = secs % 60;
    return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
  }

  async function sendPickupLog() {
    if (pickupSaveInFlight) return;

    const ctx = getCtx();
    if (!ctx) {
      alert('Pickup feature unavailable.');
      return;
    }
    if (!ctx.authHeaderOK?.()) {
      ctx.setAuthUI?.(false, 'Sign in to record trips.');
      return;
    }
    if (!ctx.userLatLng) {
      showPickupGuardNotice({ title: 'Location needed', message: 'Enable location first.', tone: 'warning' });
      return;
    }

    if (Date.now() < pickupSaveCooldownUntilMs) {
      showPickupGuardNotice({
        title: 'Save button cooling off',
        message: `Wait ${formatCooldownWait(pickupSaveCooldownUntilMs - Date.now())} before saving another trip.`,
        tone: 'warning',
      });
      return;
    }

    pickupSaveInFlight = true;
    try {
      const tsUnix = Math.floor(Date.now() / 1000);
      const near = ctx.nearestZoneToUser?.(ctx.currentFrame, ctx.userLatLng) || null;
      const zoneId = near?.location_id ?? null;
      const res = await postJSONDetailed('/events/pickup', {
        lat: ctx.userLatLng.lat,
        lng: ctx.userLatLng.lng,
        ts_unix: tsUnix,
        frame_time: ctx.currentFrame?.time || null,
        zone_id: zoneId,
        location_id: zoneId,
        zone_name: near?.zone_name ?? null,
        borough: near?.borough ?? null,
      }, ctx.communityToken);

      const cooldownUnix = Number(res?.cooldown_until_unix || 0);
      if (cooldownUnix > 0) pickupSaveCooldownUntilMs = cooldownUnix * 1000;

      ctx.schedulePickupOverlayRefresh?.({ force: true });
      showPickupReward(res);
      if (res?.leveled_up) showPickupLevelUp(res);
      return res;
    } catch (err) {
      const status = Number(err?.status || 0);
      const code = toSafeString(err?.code) || toSafeString(err?.detail?.code) || toSafeString(err?.payload?.detail?.code);
      const readable = extractPickupErrorMessage(err);

      if (status === 401) {
        ctx.clearAuth?.();
        return;
      }

      if (code === 'pickup_cooldown_active') {
        const untilUnix = Number(err?.detail?.cooldown_until_unix || err?.payload?.detail?.cooldown_until_unix || 0);
        if (untilUnix > 0) pickupSaveCooldownUntilMs = untilUnix * 1000;
        showPickupGuardNotice({ title: 'Save button cooling off', message: readable, tone: 'warning' });
        return;
      }
      if (code === 'pickup_same_position' || code === 'pickup_needs_recent_driving') {
        showPickupGuardNotice({ title: 'Trip not saved', message: readable, tone: 'danger' });
        return;
      }

      alert(readable);
    } finally {
      pickupSaveInFlight = false;
    }
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

  function setBoardResult(board, key, ok, detail) {
    if (!board) return;
    const safeDetail = toSafeString(detail, ok ? 'PASS' : 'FAIL');
    const row = board.querySelector(`[data-result="${key}"]`);
    if (!row) return;
    row.querySelector('[data-status]').textContent = ok ? '✅ PASS' : '❌ FAIL';
    row.querySelector('[data-detail]').textContent = safeDetail;
  }

  function renderTripRows(rows, boardEl, includeVoided, resultBoard) {
    if (!boardEl) return;
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      boardEl.innerHTML = '<div class="adminMuted">No trips found.</div>';
      return;
    }

    boardEl.innerHTML = list.map((r) => {
      const state = r.is_voided ? 'VOIDED' : 'ACTIVE';
      const reason = r.void_reason ? `Reason: ${toSafeString(r.void_reason, 'n/a')}` : '';
      const delBtn = r.is_voided ? '' : `<button type="button" class="adminBtn" data-pickup-void="${String(r.id)}">Delete Fake Trip</button>`;
      return `<article class="adminUserCard"><div class="adminRowBetween"><strong>#${String(r.id)} • ${toSafeString(r.display_name, `User ${toSafeString(r.user_id, 'n/a')}`)}</strong><span class="adminPill ${r.is_voided ? 'no' : 'yes'}">${state}</span></div><div class="adminMuted">Zone: ${toSafeString(r.zone_name, toSafeString(r.zone_id, 'n/a'))} • Borough: ${toSafeString(r.borough, 'n/a')}</div><div class="adminMuted">Created: ${toSafeString(r.created_at, 'n/a')} • Guard: ${toSafeString(r.guard_reason, 'n/a')}</div>${reason ? `<div class="adminMuted">${reason}</div>` : ''}<div class="adminRow wrap" style="margin-top:8px">${delBtn}</div></article>`;
    }).join('');

    boardEl.querySelectorAll('[data-pickup-void]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const tripId = btn.getAttribute('data-pickup-void');
        const reason = prompt('Reason for deleting fake trip:');
        if (!reason || reason.trim().length < 5) {
          showPickupGuardNotice({ title: 'Reason required', message: 'Provide at least 5 characters.', tone: 'warning' });
          setBoardResult(resultBoard, 'void_specific_trip', false, 'Reason too short.');
          return;
        }
        const confirmed = confirm('This will remove the selected trip from active map data but keep the audit record. Continue?');
        if (!confirmed) return;

        try {
          await voidAdminPickupTrip(tripId, reason.trim());
          setBoardResult(resultBoard, 'void_specific_trip', true, `Trip #${tripId} voided.`);
          const refreshed = await loadAdminRecentPickupTrips({ include_voided: includeVoided, limit: 50 });
          renderTripRows(refreshed?.items || refreshed?.trips || [], boardEl, includeVoided, resultBoard);
        } catch (error) {
          const msg = extractPickupErrorMessage(error);
          setBoardResult(resultBoard, 'void_specific_trip', false, msg);
          showPickupGuardNotice({ title: 'Void failed', message: msg, tone: 'danger' });
        }
      });
    });
  }

  async function runAdminPickupRecordingFullSuite(rootEl) {
    const ctx = getCtx() || {};
    const token = ctx.communityToken;
    const board = rootEl?.querySelector('[data-pickup-results]');

    const run = async (key, fn) => {
      try {
        const data = await fn();
        setBoardResult(board, key, true, 'PASS');
        return { ok: true, data };
      } catch (error) {
        const msg = extractPickupErrorMessage(error);
        setBoardResult(board, key, false, msg);
        return { ok: false, error: msg };
      }
    };

    await run('backend_health', () => apiGet('/admin/pickup-recording/tests/health', token));
    await run('guard_evaluate', () => postJSONDetailed('/admin/pickup-recording/tests/guard-evaluate', { user_id: ctx?.me?.id || 0, lat: 40.7, lng: -74.0 }, token));
    await run('simulate_save', () => postJSONDetailed('/admin/pickup-recording/tests/simulate-save', { user_id: ctx?.me?.id || 0, lat: 40.7, lng: -74.0, zone_id: 1, zone_name: 'Test Zone', borough: 'Manhattan', frame_time: null }, token));
    await run('recent_trips_load', () => loadAdminRecentPickupTrips({ include_voided: false, limit: 20 }));
    await run('active_filter', () => loadAdminRecentPickupTrips({ include_voided: false, limit: 20 }));
    await run('include_deleted_filter', () => loadAdminRecentPickupTrips({ include_voided: true, limit: 20 }));
    await run('structured_message_shape', async () => {
      try {
        await postJSONDetailed('/events/pickup', { lat: null }, token);
      } catch (error) {
        const msg = extractPickupErrorMessage(error);
        if (!msg || msg === '[object Object]') throw new Error('Invalid message shape');
        return;
      }
      throw new Error('Expected a guard error');
    });
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
        <div data-pickup-results class="adminListMini" style="margin-top:10px">
          <div class="adminKV" data-result="backend_health"><span>backend health</span><strong data-status>—</strong><span data-detail class="adminMuted">Pending</span></div>
          <div class="adminKV" data-result="guard_evaluate"><span>guard evaluate</span><strong data-status>—</strong><span data-detail class="adminMuted">Pending</span></div>
          <div class="adminKV" data-result="simulate_save"><span>simulate save</span><strong data-status>—</strong><span data-detail class="adminMuted">Pending</span></div>
          <div class="adminKV" data-result="recent_trips_load"><span>recent trips load</span><strong data-status>—</strong><span data-detail class="adminMuted">Pending</span></div>
          <div class="adminKV" data-result="active_filter"><span>active filter</span><strong data-status>—</strong><span data-detail class="adminMuted">Pending</span></div>
          <div class="adminKV" data-result="include_deleted_filter"><span>include deleted filter</span><strong data-status>—</strong><span data-detail class="adminMuted">Pending</span></div>
          <div class="adminKV" data-result="void_specific_trip"><span>void specific trip</span><strong data-status>—</strong><span data-detail class="adminMuted">Pending/manual</span></div>
          <div class="adminKV" data-result="structured_message_shape"><span>structured message shape</span><strong data-status>—</strong><span data-detail class="adminMuted">Pending</span></div>
        </div>
        <div data-pickup-trips class="adminList" style="margin-top:10px"></div>
      </section>`;

    const resultEl = container.querySelector('[data-pickup-results]');
    const tripsEl = container.querySelector('[data-pickup-trips]');
    let includeVoided = false;

    const readInputs = () => ({
      user_id: Number(container.querySelector('[data-pickup-user]')?.value || 0) || (getCtx()?.me?.id || 0),
      lat: Number(container.querySelector('[data-pickup-lat]')?.value || getCtx()?.userLatLng?.lat || 40.7128),
      lng: Number(container.querySelector('[data-pickup-lng]')?.value || getCtx()?.userLatLng?.lng || -74.0060),
    });

    const refreshTrips = async () => {
      try {
        const data = await loadAdminRecentPickupTrips({ include_voided: includeVoided, limit: 50 });
        setBoardResult(resultEl, 'recent_trips_load', true, `Loaded ${(data?.items || data?.trips || []).length} trips.`);
        setBoardResult(resultEl, includeVoided ? 'include_deleted_filter' : 'active_filter', true, includeVoided ? 'Include deleted ON' : 'Active only');
        renderTripRows(data?.items || data?.trips || [], tripsEl, includeVoided, resultEl);
      } catch (error) {
        setBoardResult(resultEl, 'recent_trips_load', false, extractPickupErrorMessage(error));
      }
    };

    container.querySelector('[data-pickup-health]')?.addEventListener('click', async () => {
      try {
        const ctx = getCtx() || {};
        await apiGet('/admin/pickup-recording/tests/health', ctx.communityToken);
        setBoardResult(resultEl, 'backend_health', true, 'PASS');
      } catch (error) {
        setBoardResult(resultEl, 'backend_health', false, extractPickupErrorMessage(error));
      }
    });

    container.querySelector('[data-pickup-full]')?.addEventListener('click', async () => {
      await runAdminPickupRecordingFullSuite(container);
    });

    container.querySelector('[data-pickup-guard]')?.addEventListener('click', async () => {
      const ctx = getCtx() || {};
      try {
        await postJSONDetailed('/admin/pickup-recording/tests/guard-evaluate', readInputs(), ctx.communityToken);
        setBoardResult(resultEl, 'guard_evaluate', true, 'PASS');
      } catch (error) {
        setBoardResult(resultEl, 'guard_evaluate', false, extractPickupErrorMessage(error));
      }
    });

    container.querySelector('[data-pickup-sim]')?.addEventListener('click', async () => {
      const ctx = getCtx() || {};
      const payload = readInputs();
      try {
        await postJSONDetailed('/admin/pickup-recording/tests/simulate-save', { ...payload, zone_id: 1, zone_name: 'Test Zone', borough: 'Manhattan', frame_time: null }, ctx.communityToken);
        setBoardResult(resultEl, 'simulate_save', true, 'PASS');
      } catch (error) {
        setBoardResult(resultEl, 'simulate_save', false, extractPickupErrorMessage(error));
      }
    });

    container.querySelector('[data-pickup-refresh]')?.addEventListener('click', refreshTrips);
    container.querySelector('[data-pickup-active]')?.addEventListener('click', async () => {
      includeVoided = false;
      await refreshTrips();
    });
    container.querySelector('[data-pickup-all]')?.addEventListener('click', async () => {
      includeVoided = true;
      await refreshTrips();
    });

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

  window.PickupRecordingFeature = FEATURE;
})();
