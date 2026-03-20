(function() {
  const DEFAULT_API_BASE = 'https://web-production-78f67.up.railway.app';
  const API_BASE = (typeof window !== 'undefined' && window.API_BASE !== undefined)
    ? String(window.API_BASE || DEFAULT_API_BASE)
    : DEFAULT_API_BASE;
  const LS_TOKEN = 'community_token_v1';
  const HUB_KEY = 'games';
  const SEARCH_DEBOUNCE_MS = 250;
  const REFRESH_POLL_MS = 30000;
  const TYPE_ORDER = ['daily_miles', 'daily_hours', 'weekly_miles', 'weekly_hours'];
  const TYPE_META = {
    daily_miles: { label: 'Daily Miles', unit: 'miles' },
    daily_hours: { label: 'Daily Hours', unit: 'hours' },
    weekly_miles: { label: 'Weekly Miles', unit: 'miles' },
    weekly_hours: { label: 'Weekly Hours', unit: 'hours' },
  };
  const TAB_ORDER = ['create', 'incoming', 'outgoing', 'active', 'history'];

  const state = {
    activeTab: 'create',
    catalog: TYPE_ORDER.map((key) => ({ key, ...TYPE_META[key] })),
    selectedType: 'daily_miles',
    selectedUser: null,
    pendingProfileTarget: null,
    users: [],
    usersLoading: false,
    usersError: '',
    usersQuery: '',
    status: '',
    error: '',
    loading: false,
    incoming: [],
    outgoing: [],
    active: null,
    history: [],
    challengeFeed: [],
    searchTimer: null,
    refreshTimer: null,
    mountRoot: null,
    lastRefreshAt: 0,
  };

  function getToken() {
    try { return localStorage.getItem(LS_TOKEN) || ''; } catch (_) { return ''; }
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function initialsFor(name) {
    const text = String(name || '').trim();
    if (!text) return 'DR';
    const parts = text.split(/\s+/).filter(Boolean).slice(0, 2);
    const initials = parts.map((part) => part.slice(0, 1).toUpperCase()).join('');
    return initials || text.slice(0, 2).toUpperCase();
  }

  function apiUrl(path) {
    if (/^https?:\/\//i.test(path)) return path;
    return `${API_BASE}${path}`;
  }

  async function fetchJSON(path, opts = {}) {
    const token = getToken();
    const headers = { ...(opts.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(apiUrl(path), { ...opts, headers, mode: 'cors', cache: 'no-store' });
    const text = await res.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (_) {
      payload = null;
    }
    if (!res.ok) {
      const err = new Error(payload?.detail || payload?.message || text || `${res.status} ${res.statusText}`);
      err.status = res.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  }

  function challengeTypeMeta(type) {
    return TYPE_META[type] || { label: String(type || 'Challenge'), unit: 'score' };
  }

  function formatDateTime(value) {
    if (!value) return '—';
    const dt = new Date(value);
    if (!Number.isFinite(dt.getTime())) return String(value);
    try {
      return new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(dt);
    } catch (_) {
      return dt.toLocaleString();
    }
  }

  function resolveImageUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^(data:|blob:|https?:)/i.test(raw)) return raw;
    if (raw.startsWith('//')) return `https:${raw}`;
    if (raw.startsWith('/')) return `${API_BASE}${raw}`;
    return `${API_BASE}/${raw.replace(/^\/+/, '')}`;
  }

  function normalizeUser(row = {}) {
    const userId = Number(row?.user_id ?? row?.id ?? row?.uid ?? row?.target_user_id ?? 0);
    if (!Number.isFinite(userId) || userId <= 0) return null;
    return {
      userId,
      displayName: String(row?.display_name || row?.name || row?.email || `Driver ${userId}`).trim() || `Driver ${userId}`,
      avatarUrl: resolveImageUrl(row?.avatar_thumb_url || row?.avatar_url || row?.avatarThumbUrl || row?.avatarUrl || ''),
      online: row?.online === true || row?.is_online === true,
      rankIcon: String(row?.rank_icon_key || row?.rankIconKey || row?.level_badge || '').trim(),
      level: Number(row?.level || row?.rank_level || 0) || 0,
    };
  }

  function deriveOtherUser(item = {}) {
    return normalizeUser({
      user_id: item?.other_user_id ?? item?.opponent_user_id ?? item?.challenged_user_id ?? item?.challenger_user_id ?? item?.user_id,
      display_name: item?.other_user_display_name || item?.opponent_display_name || item?.challenged_display_name || item?.challenger_display_name || item?.display_name,
      avatar_thumb_url: item?.other_avatar_thumb_url || item?.opponent_avatar_thumb_url || item?.avatar_thumb_url,
      avatar_url: item?.other_avatar_url || item?.opponent_avatar_url || item?.avatar_url,
      online: item?.other_user_online ?? item?.opponent_online ?? item?.online,
      rank_icon_key: item?.other_rank_icon_key || item?.opponent_rank_icon_key || item?.rank_icon_key,
      level: item?.other_level || item?.opponent_level || item?.level,
    });
  }

  function normalizeChallenge(row = {}) {
    const item = row && typeof row === 'object' ? row : {};
    const challengeId = Number(item?.id ?? item?.challenge_id ?? 0) || String(item?.id || item?.challenge_id || '');
    const type = String(item?.challenge_type || item?.type || item?.battle_type || '').trim() || 'daily_miles';
    const opponent = deriveOtherUser(item) || state.pendingProfileTarget || null;
    return {
      id: challengeId,
      type,
      opponent,
      status: String(item?.status || item?.state || 'pending'),
      createdAt: item?.created_at || item?.sent_at || item?.started_at || null,
      startedAt: item?.started_at || item?.accepted_at || item?.created_at || null,
      endAt: item?.end_at || item?.expires_at || item?.ends_at || null,
      completedAt: item?.completed_at || item?.resolved_at || null,
      myScore: Number(item?.my_score ?? item?.score_me ?? item?.challenger_score ?? item?.current_score ?? 0) || 0,
      opponentScore: Number(item?.opponent_score ?? item?.score_opponent ?? item?.challenged_score ?? item?.other_score ?? 0) || 0,
      result: String(item?.result || item?.outcome || '').trim(),
      leaderText: String(item?.leader_text || item?.leader || '').trim(),
      statusText: String(item?.status_text || item?.summary || item?.status || '').trim(),
      raw: item,
    };
  }

  function normalizeCatalog(payload) {
    const rawRows = Array.isArray(payload?.rows) ? payload.rows
      : Array.isArray(payload?.types) ? payload.types
      : Array.isArray(payload) ? payload
      : [];
    const next = rawRows.map((row) => {
      const key = String(row?.key || row?.type || row?.challenge_type || '').trim();
      if (!key || !TYPE_META[key]) return null;
      return { key, label: String(row?.label || TYPE_META[key].label), unit: String(row?.unit || TYPE_META[key].unit) };
    }).filter(Boolean);
    if (!next.length) return TYPE_ORDER.map((key) => ({ key, ...TYPE_META[key] }));
    next.sort((a, b) => TYPE_ORDER.indexOf(a.key) - TYPE_ORDER.indexOf(b.key));
    return next;
  }

  function challengeArray(payload) {
    if (Array.isArray(payload?.rows)) return payload.rows;
    if (Array.isArray(payload?.challenges)) return payload.challenges;
    if (Array.isArray(payload)) return payload;
    return [];
  }

  function historyArray(payload) {
    if (Array.isArray(payload?.rows)) return payload.rows;
    if (Array.isArray(payload?.history)) return payload.history;
    if (Array.isArray(payload)) return payload;
    return [];
  }

  function activeChallengeFromPayload(payload) {
    const candidate = payload?.challenge || payload?.active_challenge || payload?.activeChallenge || payload?.row || payload;
    if (!candidate || typeof candidate !== 'object') return null;
    if (!candidate.id && !candidate.challenge_id) return null;
    return normalizeChallenge(candidate);
  }

  function ensureSelectedUser(rows) {
    if (!state.selectedUser || !state.selectedUser.userId) return;
    const match = (rows || []).find((row) => Number(row.userId) === Number(state.selectedUser.userId));
    if (match) {
      state.selectedUser = { ...state.selectedUser, ...match };
    }
  }

  function selectedTypeExists() {
    return state.catalog.some((item) => item.key === state.selectedType);
  }

  function setStatus(message, { error = false } = {}) {
    state.status = error ? '' : String(message || '');
    state.error = error ? String(message || '') : '';
  }

  function scheduleRefreshPoll() {
    if (state.refreshTimer) {
      window.clearTimeout(state.refreshTimer);
      state.refreshTimer = null;
    }
    state.refreshTimer = window.setTimeout(() => {
      state.refreshTimer = null;
      if (!state.mountRoot || !state.mountRoot.isConnected || window.getOpenPanelKey?.() !== HUB_KEY) return;
      void refresh();
    }, REFRESH_POLL_MS);
  }

  function selectedTargetCardHtml() {
    if (!state.selectedUser) {
      return '<div class="workBattlesCard workBattlesCardMuted">Pick a driver to challenge.</div>';
    }
    return `<div class="workBattlesCard workBattlesSelectedCard">${userRowInnerHtml(state.selectedUser, { compact: true })}</div>`;
  }

  function renderAvatar(user, extraClass = '') {
    const name = user?.displayName || 'Driver';
    const avatarUrl = resolveImageUrl(user?.avatarUrl);
    const onlineDot = user?.online ? '<span class="workBattlesOnlineDot" aria-hidden="true"></span>' : '';
    const rankHtml = user?.rankIcon
      ? `<span class="workBattlesRankBadge" title="Rank icon">${escapeHtml(String(user.rankIcon).replace(/[_-]+/g, ' '))}</span>`
      : (user?.level ? `<span class="workBattlesRankBadge">Lv ${escapeHtml(String(user.level))}</span>` : '');
    const avatarBody = avatarUrl
      ? `<img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(name)} avatar" loading="lazy">`
      : `<span>${escapeHtml(initialsFor(name))}</span>`;
    return `<span class="workBattlesAvatar ${extraClass}">${avatarBody}${onlineDot}</span><span class="workBattlesUserMetaBadgeWrap">${rankHtml}</span>`;
  }

  function userRowInnerHtml(user, { compact = false } = {}) {
    const selected = state.selectedUser && Number(state.selectedUser.userId) === Number(user?.userId);
    return `<div class="workBattlesUserIdentity${compact ? ' compact' : ''}">
      ${renderAvatar(user)}
      <span class="workBattlesUserMeta">
        <span class="workBattlesUserName">${escapeHtml(user?.displayName || 'Driver')}</span>
        <span class="workBattlesUserSubline">${user?.online ? 'Online now' : 'Available'}${user?.level ? ` • Level ${escapeHtml(String(user.level))}` : ''}${selected ? ' • Selected' : ''}</span>
      </span>
    </div>`;
  }

  function renderUserRow(user) {
    const selected = state.selectedUser && Number(state.selectedUser.userId) === Number(user?.userId);
    return `<button type="button" class="workBattlesUserRow${selected ? ' selected' : ''}" data-work-battles-user="${escapeHtml(String(user.userId))}">${userRowInnerHtml(user)}</button>`;
  }

  function renderChallengeCard(item, mode) {
    const meta = challengeTypeMeta(item?.type);
    const opponentName = item?.opponent?.displayName || 'Driver';
    let actionHtml = '';
    if (mode === 'incoming') {
      actionHtml = `<div class="workBattlesActionRow"><button type="button" class="chipBtn" data-work-battles-accept="${escapeHtml(String(item.id))}">Accept</button><button type="button" class="chipBtn" data-work-battles-decline="${escapeHtml(String(item.id))}">Decline</button></div>`;
    } else if (mode === 'outgoing') {
      actionHtml = `<div class="workBattlesActionRow"><button type="button" class="chipBtn" data-work-battles-cancel="${escapeHtml(String(item.id))}">Cancel</button></div>`;
    }
    return `<article class="workBattlesCard">
      <div class="workBattlesCardTop">
        ${renderAvatar(item?.opponent || { displayName: opponentName }, 'small')}
        <div class="workBattlesCardTitleWrap">
          <div class="workBattlesCardTitle">${escapeHtml(opponentName)}</div>
          <div class="workBattlesCardMeta">${escapeHtml(meta.label)} • ${escapeHtml(item?.statusText || item?.status || 'Pending')}</div>
        </div>
      </div>
      <div class="workBattlesStatus">Sent ${escapeHtml(formatDateTime(item?.createdAt))}${item?.endAt ? ` • Ends ${escapeHtml(formatDateTime(item.endAt))}` : ''}</div>
      ${actionHtml}
    </article>`;
  }

  function leaderText(item) {
    if (item?.leaderText) return item.leaderText;
    if (item?.myScore > item?.opponentScore) return 'You are leading.';
    if (item?.myScore < item?.opponentScore) return `${item?.opponent?.displayName || 'Opponent'} is leading.`;
    return 'Challenge is tied.';
  }

  function renderActiveCard(item) {
    if (!item) return '<div class="workBattlesCard workBattlesCardMuted">No active work challenge right now.</div>';
    const meta = challengeTypeMeta(item?.type);
    const opponentName = item?.opponent?.displayName || 'Driver';
    return `<article class="workBattlesCard">
      <div class="workBattlesCardTop">
        ${renderAvatar(item?.opponent || { displayName: opponentName }, 'small')}
        <div class="workBattlesCardTitleWrap">
          <div class="workBattlesCardTitle">${escapeHtml(meta.label)}</div>
          <div class="workBattlesCardMeta">vs ${escapeHtml(opponentName)}</div>
        </div>
      </div>
      <div class="workBattlesStatus">Started ${escapeHtml(formatDateTime(item?.startedAt))} • Ends ${escapeHtml(formatDateTime(item?.endAt))}</div>
      <div class="workBattlesScoreRow">
        <div class="workBattlesScoreCell"><span class="workBattlesScoreLabel">My score</span><strong>${escapeHtml(String(item?.myScore ?? 0))}</strong></div>
        <div class="workBattlesScoreCell"><span class="workBattlesScoreLabel">Opponent</span><strong>${escapeHtml(String(item?.opponentScore ?? 0))}</strong></div>
      </div>
      <div class="workBattlesStatus">${escapeHtml(leaderText(item))}</div>
      <div class="workBattlesStatus">${escapeHtml(item?.statusText || item?.status || 'Active')}</div>
    </article>`;
  }

  function historyResultLabel(item) {
    const result = String(item?.result || '').toLowerCase();
    if (result === 'won' || result === 'win') return 'Won';
    if (result === 'lost' || result === 'loss') return 'Lost';
    if (result === 'tied' || result === 'tie' || result === 'draw') return 'Tied';
    if (item?.myScore > item?.opponentScore) return 'Won';
    if (item?.myScore < item?.opponentScore) return 'Lost';
    return 'Tied';
  }

  function renderHistoryCard(item) {
    const meta = challengeTypeMeta(item?.type);
    const result = historyResultLabel(item);
    return `<article class="workBattlesCard ${result === 'Won' ? 'win' : (result === 'Lost' ? 'loss' : 'tie')}">
      <div class="workBattlesCardTitle">${escapeHtml(meta.label)} • ${escapeHtml(result)}</div>
      <div class="workBattlesCardMeta">vs ${escapeHtml(item?.opponent?.displayName || 'Driver')}</div>
      <div class="workBattlesScoreRow compact">
        <div class="workBattlesScoreCell"><span class="workBattlesScoreLabel">Final</span><strong>${escapeHtml(String(item?.myScore ?? 0))}</strong></div>
        <div class="workBattlesScoreCell"><span class="workBattlesScoreLabel">Opponent</span><strong>${escapeHtml(String(item?.opponentScore ?? 0))}</strong></div>
      </div>
      <div class="workBattlesStatus">Completed ${escapeHtml(formatDateTime(item?.completedAt || item?.endAt || item?.createdAt))}</div>
    </article>`;
  }

  function emptyStateHtml(text) {
    return `<div class="workBattlesCard workBattlesCardMuted">${escapeHtml(text)}</div>`;
  }

  function renderCreateSection() {
    const usersHtml = state.usersLoading
      ? '<div class="workBattlesStatus">Loading drivers…</div>'
      : state.users.length
        ? state.users.map(renderUserRow).join('')
        : emptyStateHtml(state.usersError || 'No drivers found for that search.');
    return `<section class="workBattlesSection${state.activeTab === 'create' ? ' active' : ''}" data-work-battles-section="create">
      <div class="workBattlesSectionHeader">Create a work battle</div>
      <div class="workBattlesMetricChips">${state.catalog.map((item) => `<button type="button" class="chipBtn${state.selectedType === item.key ? ' active' : ''}" data-work-battles-type="${escapeHtml(item.key)}">${escapeHtml(item.label)}</button>`).join('')}</div>
      <label class="workBattlesSearchWrap">
        <span class="workBattlesSearchLabel">Challenge a driver</span>
        <input id="workBattlesSearch" class="driverProfileInput" type="search" placeholder="Search drivers" value="${escapeHtml(state.usersQuery)}">
      </label>
      <div class="workBattlesUserList">${usersHtml}</div>
      ${selectedTargetCardHtml()}
      <div class="workBattlesActionRow"><button type="button" id="workBattlesSendBtn" class="chipBtn primary" ${state.selectedUser ? '' : 'disabled'}>Send Challenge</button><button type="button" id="workBattlesRefreshBtn" class="chipBtn">Refresh</button></div>
    </section>`;
  }

  function renderSectionList(tab, items, emptyText) {
    const cards = items.length
      ? items.map((item) => tab === 'history' ? renderHistoryCard(item) : renderChallengeCard(item, tab)).join('')
      : emptyStateHtml(emptyText);
    return `<section class="workBattlesSection${state.activeTab === tab ? ' active' : ''}" data-work-battles-section="${escapeHtml(tab)}">
      <div class="workBattlesSectionHeader">${escapeHtml(tab.charAt(0).toUpperCase() + tab.slice(1))}</div>
      ${cards}
    </section>`;
  }

  function panelHtml() {
    return `<div class="panelBlock workBattlesWrap">
      <div class="workBattlesTabs">${TAB_ORDER.map((tab) => `<button type="button" class="chipBtn${state.activeTab === tab ? ' active' : ''}" data-work-battles-tab="${escapeHtml(tab)}">${escapeHtml(tab.charAt(0).toUpperCase() + tab.slice(1))}</button>`).join('')}</div>
      ${(state.error || state.status) ? `<div class="workBattlesStatus${state.error ? ' err' : ''}">${escapeHtml(state.error || state.status)}</div>` : ''}
      ${renderCreateSection()}
      ${renderSectionList('incoming', state.incoming, 'No incoming challenges.')}
      ${renderSectionList('outgoing', state.outgoing, 'No outgoing challenges.')}
      <section class="workBattlesSection${state.activeTab === 'active' ? ' active' : ''}" data-work-battles-section="active">
        <div class="workBattlesSectionHeader">Active</div>
        ${renderActiveCard(state.active)}
      </section>
      ${renderSectionList('history', state.history, 'No completed challenges yet.')}
    </div>`;
  }

  function bindPanelEvents() {
    const body = state.mountRoot;
    if (!body) return;

    body.querySelectorAll('[data-work-battles-tab]').forEach((btn) => btn.addEventListener('click', () => {
      state.activeTab = String(btn.getAttribute('data-work-battles-tab') || 'create');
      render();
    }));

    body.querySelectorAll('[data-work-battles-type]').forEach((btn) => btn.addEventListener('click', () => {
      state.selectedType = String(btn.getAttribute('data-work-battles-type') || 'daily_miles');
      render();
    }));

    body.querySelectorAll('[data-work-battles-user]').forEach((btn) => btn.addEventListener('click', () => {
      const id = Number(btn.getAttribute('data-work-battles-user'));
      const selected = state.users.find((row) => Number(row.userId) === id) || state.selectedUser;
      if (!selected) return;
      state.selectedUser = selected;
      render();
    }));

    body.querySelectorAll('[data-work-battles-accept]').forEach((btn) => btn.addEventListener('click', () => {
      void mutateChallenge(btn.getAttribute('data-work-battles-accept'), 'accept');
    }));
    body.querySelectorAll('[data-work-battles-decline]').forEach((btn) => btn.addEventListener('click', () => {
      void mutateChallenge(btn.getAttribute('data-work-battles-decline'), 'decline');
    }));
    body.querySelectorAll('[data-work-battles-cancel]').forEach((btn) => btn.addEventListener('click', () => {
      void mutateChallenge(btn.getAttribute('data-work-battles-cancel'), 'cancel');
    }));

    document.getElementById('workBattlesRefreshBtn')?.addEventListener('click', () => {
      void refresh({ forceUsers: true });
    });
    document.getElementById('workBattlesSendBtn')?.addEventListener('click', () => {
      void sendChallenge();
    });

    document.getElementById('workBattlesSearch')?.addEventListener('input', (event) => {
      state.usersQuery = String(event.target?.value || '');
      if (state.searchTimer) window.clearTimeout(state.searchTimer);
      state.searchTimer = window.setTimeout(() => {
        state.searchTimer = null;
        void loadUsers({ query: state.usersQuery, force: true });
      }, SEARCH_DEBOUNCE_MS);
    });
  }

  function render() {
    if (window.getOpenPanelKey?.() !== HUB_KEY) return;
    const body = state.mountRoot;
    if (!body) return;
    body.innerHTML = panelHtml();
    bindPanelEvents();
  }

  async function loadCatalog() {
    try {
      const payload = await fetchJSON('/work-battles/catalog');
      state.catalog = normalizeCatalog(payload);
      if (!selectedTypeExists()) state.selectedType = state.catalog[0]?.key || 'daily_miles';
    } catch (error) {
      state.catalog = TYPE_ORDER.map((key) => ({ key, ...TYPE_META[key] }));
      if (!selectedTypeExists()) state.selectedType = 'daily_miles';
      setStatus(error?.message || 'Catalog unavailable. Using defaults.', { error: false });
    }
  }

  async function loadUsers({ query = '', force = false } = {}) {
    state.usersLoading = true;
    state.usersError = '';
    render();
    try {
      const payload = await fetchJSON(`/work-battles/users?q=${encodeURIComponent(String(query || '').trim())}&limit=40`);
      const rows = (Array.isArray(payload?.rows) ? payload.rows : Array.isArray(payload?.users) ? payload.users : Array.isArray(payload) ? payload : [])
        .map(normalizeUser)
        .filter(Boolean);
      state.users = rows;
      ensureSelectedUser(rows);
      if (state.pendingProfileTarget?.userId && !state.selectedUser) {
        state.selectedUser = state.pendingProfileTarget;
      }
      if (!rows.length && force && !state.usersQuery.trim()) {
        state.usersError = 'No challengeable drivers are available right now.';
      }
    } catch (error) {
      state.users = [];
      state.usersError = error?.message || 'Unable to load drivers.';
      if (state.pendingProfileTarget?.userId) state.selectedUser = state.pendingProfileTarget;
    } finally {
      state.usersLoading = false;
      render();
    }
  }

  async function refresh(options = {}) {
    state.loading = true;
    if (!options.silent) setStatus('Refreshing work battles…');
    render();
    try {
      await loadCatalog();
      const [aggregateRes, incomingRes, outgoingRes, activeRes, historyRes] = await Promise.all([
        fetchJSON('/work-battles/challenges').catch(() => null),
        fetchJSON('/work-battles/challenges/incoming').catch(() => null),
        fetchJSON('/work-battles/challenges/outgoing').catch(() => null),
        fetchJSON('/work-battles/active/me').catch(() => null),
        fetchJSON('/work-battles/history/me').catch(() => null),
      ]);
      const aggregateIncoming = challengeArray(aggregateRes?.incoming);
      const aggregateOutgoing = challengeArray(aggregateRes?.outgoing);
      state.challengeFeed = challengeArray(aggregateRes).map(normalizeChallenge).filter(Boolean);
      state.incoming = (challengeArray(incomingRes).length ? challengeArray(incomingRes) : aggregateIncoming).map(normalizeChallenge).filter(Boolean);
      state.outgoing = (challengeArray(outgoingRes).length ? challengeArray(outgoingRes) : aggregateOutgoing).map(normalizeChallenge).filter(Boolean);
      state.active = activeChallengeFromPayload(activeRes)
        || activeChallengeFromPayload(aggregateRes?.active)
        || activeChallengeFromPayload(aggregateRes?.active_challenge)
        || null;
      state.history = historyArray(historyRes).map(normalizeChallenge).filter(Boolean);
      state.lastRefreshAt = Date.now();
      if (options.forceUsers || !state.users.length || state.pendingProfileTarget || (!state.usersQuery && state.activeTab === 'create')) {
        await loadUsers({ query: state.usersQuery, force: !!options.forceUsers || !!state.pendingProfileTarget });
      }
      if (state.pendingProfileTarget?.userId) {
        state.selectedUser = state.selectedUser && Number(state.selectedUser.userId) === Number(state.pendingProfileTarget.userId)
          ? state.selectedUser
          : state.pendingProfileTarget;
        state.pendingProfileTarget = null;
      }
      setStatus(options.silent ? '' : 'Work battles updated.');
    } catch (error) {
      setStatus(error?.message || 'Unable to refresh work battles right now.', { error: true });
    } finally {
      state.loading = false;
      render();
      scheduleRefreshPoll();
    }
  }

  async function sendChallenge() {
    if (!state.selectedUser?.userId) {
      setStatus('Pick a driver first.', { error: true });
      render();
      return;
    }
    const challengeType = state.selectedType || 'daily_miles';
    const displayType = challengeTypeMeta(challengeType).label;
    setStatus(`Sending ${displayType} challenge…`);
    render();
    try {
      await fetchJSON('/work-battles/challenges', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challenged_user_id: Number(state.selectedUser.userId),
          challenge_type: challengeType,
        }),
      });
      state.activeTab = 'outgoing';
      setStatus(`${displayType} challenge sent.`);
      await refresh({ silent: true, forceUsers: true });
    } catch (error) {
      setStatus(error?.message || 'Unable to send challenge.', { error: true });
      render();
    }
  }

  async function mutateChallenge(challengeId, action) {
    if (!challengeId || !action) return;
    const label = action === 'accept' ? 'Accepting' : action === 'decline' ? 'Declining' : 'Canceling';
    const successLabel = action === 'accept' ? 'Challenge accepted.' : action === 'decline' ? 'Challenge declined.' : 'Challenge canceled.';
    setStatus(`${label} challenge…`);
    render();
    try {
      await fetchJSON(`/work-battles/challenges/${encodeURIComponent(String(challengeId))}/${encodeURIComponent(String(action))}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (action === 'accept') state.activeTab = 'active';
      if (action === 'decline') state.activeTab = 'incoming';
      if (action === 'cancel') state.activeTab = 'outgoing';
      setStatus(successLabel);
      await refresh({ silent: true, forceUsers: false });
    } catch (error) {
      setStatus(error?.message || 'Challenge action failed.', { error: true });
      render();
    }
  }

  function mount(containerEl, options = {}) {
    if (containerEl instanceof HTMLElement) state.mountRoot = containerEl;
    if (!state.mountRoot) return;
    const profileTarget = options?.profileTarget;
    if (profileTarget && typeof profileTarget === 'object') {
      const numericId = Number(profileTarget.userId);
      if (Number.isFinite(numericId) && numericId > 0) {
        state.pendingProfileTarget = {
          userId: numericId,
          displayName: String(profileTarget.displayName || `Driver ${numericId}`).trim() || `Driver ${numericId}`,
          avatarUrl: String(profileTarget.avatarUrl || ''),
          online: !!profileTarget.online,
          rankIcon: String(profileTarget.rankIcon || ''),
          level: Number(profileTarget.level || 0) || 0,
        };
        state.selectedUser = state.pendingProfileTarget;
        state.activeTab = 'create';
      }
    }
    render();
    if (!state.lastRefreshAt || (Date.now() - state.lastRefreshAt) > REFRESH_POLL_MS) {
      void refresh({ silent: false, forceUsers: !state.users.length || !!state.pendingProfileTarget });
    } else if (!state.users.length) {
      void loadUsers({ query: state.usersQuery, force: !!state.pendingProfileTarget });
    }
  }

  function openHub(options = {}) {
    const profileTarget = options?.profileTarget && typeof options.profileTarget === 'object'
      ? options.profileTarget
      : (state.pendingProfileTarget || null);
    if (window.GameHubUI?.open) {
      window.GameHubUI.open({ initialTab: 'work-battles', profileTarget });
      return true;
    }
    if (typeof window.openDrawer === 'function') {
      window.openDrawer(HUB_KEY, 'Games', '<div id="workBattlesPanelMount" class="gameHubEmbeddedWorkBattles"></div>');
      const host = document.getElementById('workBattlesPanelMount');
      if (host) mount(host, profileTarget ? { profileTarget } : {});
      return true;
    }
    return false;
  }

  function bindDockButton(buttonEl) {
    if (!buttonEl) return false;
    if (buttonEl.__workBattlesPointerHandler) {
      buttonEl.removeEventListener('pointerdown', buttonEl.__workBattlesPointerHandler);
    }
    if (buttonEl.__workBattlesClickHandler) {
      buttonEl.removeEventListener('click', buttonEl.__workBattlesClickHandler);
    }
    buttonEl.__workBattlesPointerHandler = (event) => event.stopPropagation();
    buttonEl.__workBattlesClickHandler = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (window.getOpenPanelKey?.() === HUB_KEY) {
        window.closeDrawer?.();
        return;
      }
      openHub();
    };
    buttonEl.addEventListener('pointerdown', buttonEl.__workBattlesPointerHandler);
    buttonEl.addEventListener('click', buttonEl.__workBattlesClickHandler);
    buttonEl.dataset.workBattlesDockBound = '1';
    buttonEl.dataset.gamesDockBound = '1';
    return true;
  }

  function openForProfileTarget({ userId, displayName } = {}) {
    const numericId = Number(userId);
    if (!Number.isFinite(numericId) || numericId <= 0) {
      openHub();
      return;
    }
    state.pendingProfileTarget = {
      userId: numericId,
      displayName: String(displayName || `Driver ${numericId}`).trim() || `Driver ${numericId}`,
      avatarUrl: '',
      online: false,
      rankIcon: '',
      level: 0,
    };
    state.selectedUser = state.pendingProfileTarget;
    state.activeTab = 'create';
    openHub({ profileTarget: state.pendingProfileTarget });
  }

  function getPendingProfileTarget() {
    return state.pendingProfileTarget ? { ...state.pendingProfileTarget } : null;
  }

  function clearPendingProfileTarget() {
    state.pendingProfileTarget = null;
  }

  window.WorkBattlesUI = {
    bindDockButton,
    mount,
    openHub,
    refresh: () => refresh({ silent: false, forceUsers: true }),
    openForProfileTarget,
    getPendingProfileTarget,
    clearPendingProfileTarget,
  };

  try {
    window.initCommunityDockBindings?.();
  } catch (error) {
    console.warn('WorkBattles dock bootstrap retry failed', error);
  }
})();
