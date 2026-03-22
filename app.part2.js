/*
 * app.part2.js
 *
 * New chat implementation for the NYC TLC Hotspot Map.  This module is
 * completely self‑contained and does not rely on the removed chat code in
 * app.js.  It reads the JWT token directly from localStorage, builds the
 * chat UI, fetches and sends messages, polls for updates, and binds
 * itself to the chat dock button.
 */
(function() {
  console.log('app.part2.js loaded');
  const runtime = window.FrontendRuntime || null;
  const runtimePolling = runtime?.polling || null;
  const runtimePerf = runtime?.perf || null;

  // Chat constants
  const CHAT_ROOM = typeof window !== 'undefined' && window.CHAT_ROOM ? window.CHAT_ROOM : 'global';
  // Reduce the polling interval so new messages appear more promptly.
  const CHAT_POLL_MS = typeof window !== 'undefined' && window.CHAT_POLL_MS
    ? window.CHAT_POLL_MS
    : 1500;
  const CHAT_CLOSED_POLL_MS = 5000;
  const CHAT_HIDDEN_POLL_MS = 12000;
  const PRIVATE_CHAT_OPEN_POLL_MS = 3500;
  const PRIVATE_CHAT_CLOSED_POLL_MS = 7500;
  const PRIVATE_CHAT_HIDDEN_POLL_MS = 15000;
  const DRIVER_PROFILE_DM_POLL_OPEN_MS = 4000;
  const DRIVER_PROFILE_DM_POLL_HIDDEN_MS = 14000;
  const CHAT_LIVE_CAPABILITIES_PATH = '/chat/live/capabilities';
  const CHAT_LIVE_CAPABILITIES_TTL_MS = 90 * 1000;
  const CHAT_LIVE_RECONNECT_BASE_MS = 1500;
  const CHAT_LIVE_RECONNECT_MAX_MS = 30000;
  const CHAT_LIVE_CONNECTED_PUBLIC_OPEN_POLL_MS = 4000;
  const CHAT_LIVE_CONNECTED_PUBLIC_CLOSED_POLL_MS = 15000;
  const CHAT_LIVE_CONNECTED_PUBLIC_HIDDEN_POLL_MS = 25000;
  const CHAT_LIVE_CONNECTED_PRIVATE_OPEN_POLL_MS = 7000;
  const CHAT_LIVE_CONNECTED_PRIVATE_CLOSED_POLL_MS = 18000;
  const CHAT_LIVE_CONNECTED_PRIVATE_HIDDEN_POLL_MS = 28000;

  // Token helper (matches LS_TOKEN in app.js)
  const LS_TOKEN = 'community_token_v1';
  function getCommunityToken() {
    try { return localStorage.getItem(LS_TOKEN) || ''; } catch (_) { return ''; }
  }


  /* =========================================================
     MOVED TO app.part7.js
     Chat Voice + Chat Audio module
     Search there for:
     - primeChatSoundSystem
     - playChatTone
     - bindVoiceComposerControls
     - bindVoicePlayers
     - renderVoiceNotePlayer
     - sendChatVoiceDraft
     - cancelChatVoiceRecording
     ========================================================= */

  function chatVoiceModuleRef() { return window.TlcChatVoiceModule || null; }
  function createChatVoiceStateProxy() {
    return new Proxy({}, {
      get(_target, prop) { return chatVoiceModuleRef()?.chatVoiceState?.[prop]; },
      set(_target, prop, value) { if (chatVoiceModuleRef()?.chatVoiceState) chatVoiceModuleRef().chatVoiceState[prop] = value; return true; },
      has(_target, prop) { return prop in (chatVoiceModuleRef()?.chatVoiceState || {}); }
    });
  }
  function createChatVoiceDraftProxy() {
    return new Proxy({}, {
      get(_target, prop) { return chatVoiceModuleRef()?.chatVoiceDraftState?.[prop]; },
      set(_target, prop, value) { if (chatVoiceModuleRef()?.chatVoiceDraftState) chatVoiceModuleRef().chatVoiceDraftState[prop] = value; return true; },
      has(_target, prop) { return prop in (chatVoiceModuleRef()?.chatVoiceDraftState || {}); }
    });
  }
  function createChatVoiceRuntimeProxy(key) {
    return new Proxy({}, {
      get(_target, prop) { return chatVoiceModuleRef()?.[key]?.[prop]; },
      set(_target, prop, value) { if (chatVoiceModuleRef()?.[key]) chatVoiceModuleRef()[key][prop] = value; return true; },
      has(_target, prop) { return prop in (chatVoiceModuleRef()?.[key] || {}); }
    });
  }
  function createChatVoiceMapProxy(key) {
    const fallback = new Map();
    return new Proxy(fallback, {
      get(_target, prop) {
        const target = chatVoiceModuleRef()?.[key] || fallback;
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(_target, prop, value) {
        const target = chatVoiceModuleRef()?.[key] || fallback;
        target[prop] = value;
        return true;
      },
      has(_target, prop) {
        const target = chatVoiceModuleRef()?.[key] || fallback;
        return prop in target;
      }
    });
  }

  const chatVoiceState = createChatVoiceStateProxy();
  const chatVoiceDraftState = createChatVoiceDraftProxy();
  const voicePlaybackRuntime = createChatVoiceRuntimeProxy('voicePlaybackRuntime');
  const chatSoundRuntime = createChatVoiceRuntimeProxy('chatSoundRuntime');
  const chatSoundState = createChatVoiceRuntimeProxy('chatSoundState');
  const voiceAssetCache = createChatVoiceMapProxy('voiceAssetCache');

  function primeChatSoundSystem(...args) { return window.TlcChatVoiceModule?.primeChatSoundSystem?.(...args); }
  function primeChatAudio(...args) { return window.TlcChatVoiceModule?.primeChatAudio?.(...args); }
  function playChatTone(...args) { return window.TlcChatVoiceModule?.playChatTone?.(...args); }
  function bindVoiceComposerControls(...args) { return window.TlcChatVoiceModule?.bindVoiceComposerControls?.(...args); }
  function bindVoicePlayers(...args) { return window.TlcChatVoiceModule?.bindVoicePlayers?.(...args); }
  function renderVoiceNotePlayer(...args) { return window.TlcChatVoiceModule?.renderVoiceNotePlayer?.(...args) || ''; }
  function prefetchVoiceBlobUrls(...args) { return window.TlcChatVoiceModule?.prefetchVoiceBlobUrls?.(...args); }
  function preserveVoicePlaybackAcrossRender(...args) { return window.TlcChatVoiceModule?.preserveVoicePlaybackAcrossRender?.(...args); }
  function sendChatVoiceDraft(...args) { return window.TlcChatVoiceModule?.sendChatVoiceDraft?.(...args); }
  function hasChatVoiceDraft(...args) { return window.TlcChatVoiceModule?.hasChatVoiceDraft?.(...args); }
  function cancelChatVoiceRecording(...args) { return window.TlcChatVoiceModule?.cancelChatVoiceRecording?.(...args); }
  function syncVoiceComposerSendButton(...args) { return window.TlcChatVoiceModule?.syncVoiceComposerSendButton?.(...args); }
  function clearVoiceAssetsForMessages(...args) { return window.TlcChatVoiceModule?.clearVoiceAssetsForMessages?.(...args); }
  function pruneVoiceAssetCache(...args) { return window.TlcChatVoiceModule?.pruneVoiceAssetCache?.(...args); }
  function stopSharedVoicePlayback(...args) { return window.TlcChatVoiceModule?.stopSharedVoicePlayback?.(...args); }
  function hardStopSharedVoicePlaybackForBackground(...args) { return window.TlcChatVoiceModule?.hardStopSharedVoicePlaybackForBackground?.(...args); }
  function hardStopSharedVoicePlaybackForRadio(...args) { return window.TlcChatVoiceModule?.hardStopSharedVoicePlaybackForRadio?.(...args); }
  function syncAllVoicePlayers(...args) { return window.TlcChatVoiceModule?.syncAllVoicePlayers?.(...args); }
  function syncAllVoiceRecorderUis(...args) { return window.TlcChatVoiceModule?.syncAllVoiceRecorderUis?.(...args); }
  function buildVoiceComposer(...args) { return window.TlcChatVoiceModule?.buildVoiceComposer?.(...args) || ''; }
  function seedChatIncomingAudioBaseline(...args) { return window.TlcChatVoiceModule?.seedChatIncomingAudioBaseline?.(...args); }
  function collectFreshIncomingMessagesForAudio(...args) { return window.TlcChatVoiceModule?.collectFreshIncomingMessagesForAudio?.(...args) || []; }
  function getVoiceMessageDomKey(...args) { return window.TlcChatVoiceModule?.getVoiceMessageDomKey?.(...args) || ''; }
  function escapeCssValue(...args) { return window.TlcChatVoiceModule?.escapeCssValue?.(...args) || ''; }
  function isChatVoiceBusy(...args) { return !!window.TlcChatVoiceModule?.isChatVoiceBusy?.(...args); }
  function getVoiceRecorderState(...args) { return window.TlcChatVoiceModule?.getVoiceRecorderState?.(...args) || null; }







  const VOICE_NOTE_MAX_MS = 60000;
  const CHAT_RETENTION_MS = 24 * 60 * 60 * 1000;





















  // Chat state
  let chatPollTimer = null;
  let chatPollInFlight = false;
  let publicChatMessages = [];
  let chatLastSeen = null;
  let chatLatestMessageId = null;
  let chatLastReadId = loadChatLastReadId();
  let chatSeenKeys = new Set();
  let unreadChatCount = 0;
  let unreadPrivateCount = 0;
  let chatInitialHistoryLoaded = false;
  let chatInitialHistoryLoadAttempted = false;
  let chatInitialHistoryRetryQueued = false;
  let chatHiddenBaselineReady = false;

  // Kill-feed bootstrap guard.
  // We seed startup history into seen-keys, then suppress feed replay until
  // one post-bootstrap poll has been absorbed as history too.
  let killFeedBootstrapReady = false;
  let killFeedBootstrapPollConsumed = false;

  let activeChatTab = 'public';
  let privateThreads = [];
  let privateActiveUserId = null;
  let privateActiveDisplayName = '';
  let privateBackendThreadIds = new Set();
  let privateMessagesByUserId = Object.create(null);
  let privateUnreadByUserId = Object.create(null);
  let privateLastMessageIdByUserId = Object.create(null);
  let privateThreadPollTimer = null;
  let privateThreadPollInFlight = false;
  let chatPollAbortController = null;
  let privateThreadAbortController = null;
  const privateMessageAbortControllers = new Map();
  let driverProfilePollInFlight = false;
  const chatLiveRuntime = {
    capabilitiesCheckedAt: 0,
    capabilitiesInFlight: null,
    capabilities: null,
    public: {
      key: 'public',
      es: null,
      url: '',
      status: 'idle',
      reconnectAttempts: 0,
      reconnectTimer: null,
      connectSeq: 0,
      lastEventId: '',
      lastMessageId: null,
      reconnectCount: 0,
      lastConnectAt: 0,
      lastDisconnectReason: '',
      lastEventAt: 0,
      lastMergeKey: '',
      lastReconcileAt: 0,
      lastError: '',
    },
    private: {
      key: 'private',
      es: null,
      url: '',
      status: 'idle',
      reconnectAttempts: 0,
      reconnectTimer: null,
      connectSeq: 0,
      lastEventId: '',
      lastMessageId: null,
      reconnectCount: 0,
      lastConnectAt: 0,
      lastDisconnectReason: '',
      lastEventAt: 0,
      lastMergeKey: '',
      lastReconcileAt: 0,
      lastThreadUserId: '',
      lastError: '',
    },
    pendingPublicReconcile: null,
    pendingPrivateRefresh: null,
    pendingPrivateThreadReconcile: new Map(),
  };

  function chatLastReadStorageKey() {
    return `tlc_chat_last_read_${CHAT_ROOM}`;
  }

  function chatReadBaselineStorageKey() {
    return `tlc_chat_read_baseline_${CHAT_ROOM}`;
  }

  function parseMessageId(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function messageNumericId(msg) {
    return parseMessageId(msg?.id);
  }

  function loadChatLastReadId() {
    try {
      return parseMessageId(localStorage.getItem(chatLastReadStorageKey()));
    } catch (_) {
      return null;
    }
  }

  function saveChatLastReadId(id) {
    const parsed = parseMessageId(id);
    if (parsed === null) return;
    const next = chatLastReadId === null ? parsed : Math.max(chatLastReadId, parsed);
    chatLastReadId = next;
    try {
      localStorage.setItem(chatLastReadStorageKey(), String(next));
    } catch (_) {}
  }

  function hasChatReadBaseline() {
    try {
      return localStorage.getItem(chatReadBaselineStorageKey()) === '1';
    } catch (_) {
      return false;
    }
  }

  function markChatReadBaselineDone() {
    try {
      localStorage.setItem(chatReadBaselineStorageKey(), '1');
    } catch (_) {}
  }

  function maybeInitializeChatReadBaseline() {
    if (chatLastReadId !== null) return false;
    if (hasChatReadBaseline()) return false;
    if (chatLatestMessageId === null) return false;
    saveChatLastReadId(chatLatestMessageId);
    markChatReadBaselineDone();
    clearChatUnreadBadge();
    return true;
  }

  function getPerfDebugRoot() {
    if (typeof window === 'undefined') return null;
    window.__mapPerfDebug = window.__mapPerfDebug || {};
    if (!window.__mapPerfDebug.chatPolls) {
      window.__mapPerfDebug.chatPolls = { public_open: 0, public_closed: 0, public_hidden: 0, private_open: 0, private_closed: 0, private_hidden: 0 };
    }
    return window.__mapPerfDebug;
  }

  function bumpChatPollStat(key) {
    const perf = getPerfDebugRoot();
    if (!perf?.chatPolls) return;
    perf.chatPolls[key] = Number(perf.chatPolls[key] || 0) + 1;
  }

  function bumpChatErrorStat() {
    runtimePerf?.bumpCounter?.('chat_poll_errors', 1);
  }

  function abortControllerSafe(controller) {
    if (!controller) return;
    try { controller.abort(); } catch (_) {}
  }

  function replaceAbortController(currentController, nextController) {
    abortControllerSafe(currentController);
    return nextController;
  }

  function getDriverProfilePollIntervalMs() {
    if (document.visibilityState === 'hidden') {
      return isChatLiveConnected('private') ? Math.max(DRIVER_PROFILE_DM_POLL_HIDDEN_MS, CHAT_LIVE_CONNECTED_PRIVATE_HIDDEN_POLL_MS) : DRIVER_PROFILE_DM_POLL_HIDDEN_MS;
    }
    return isChatLiveConnected('private') ? Math.max(DRIVER_PROFILE_DM_POLL_OPEN_MS, CHAT_LIVE_CONNECTED_PRIVATE_OPEN_POLL_MS) : DRIVER_PROFILE_DM_POLL_OPEN_MS;
  }

  // Remember which chat messages have been displayed in the kill feed.
  // Once a message has been shown, it will never appear again, even after it expires.
  const killFeedSeenKeys = new Set();

  // Create a kill feed container if one doesn’t already exist
  let killFeedContainer = document.getElementById('killFeed');
  if (!killFeedContainer) {
    killFeedContainer = document.createElement('div');
    killFeedContainer.id = 'killFeed';
    killFeedContainer.className = 'killFeed';
    document.body.appendChild(killFeedContainer);
  }

  function updateChatUnreadBadge() {
    const btn = document.getElementById('dockChat');
    if (!btn) return;
    unreadPrivateCount = Object.values(privateUnreadByUserId).reduce((acc, n) => acc + (Number(n) || 0), 0);
    const totalUnread = unreadChatCount + unreadPrivateCount;
    if (totalUnread > 0) {
      btn.dataset.unread = totalUnread > 99 ? '99+' : String(totalUnread);
    } else {
      delete btn.dataset.unread;
    }
  }

  function clearChatUnreadBadge() {
    unreadChatCount = 0;
    updateChatUnreadBadge();
  }

  function markChatReadThroughLatestLoaded() {
    if (chatLatestMessageId !== null) saveChatLastReadId(chatLatestMessageId);
    clearChatUnreadBadge();
  }

  function isChatPanelOpen() {
    return typeof openPanelKey !== 'undefined' && openPanelKey === 'chat';
  }

  function msgUserId(msg) {
    if (msg?.sender_user_id != null) return String(msg.sender_user_id);
    if (msg?.senderUserId != null) return String(msg.senderUserId);
    if (msg?.user_id != null) return String(msg.user_id);
    if (msg?.userId != null) return String(msg.userId);
    return null;
  }

  function normalizeMessageType(value, fallback = 'text') {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return fallback;
    if (raw.includes('voice') || raw.includes('audio')) return 'voice';
    return raw;
  }

  function resolveChatAssetUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw) || raw.startsWith('blob:') || raw.startsWith('data:')) return raw;
    const base = String(typeof RAILWAY_BASE !== 'undefined' ? RAILWAY_BASE : (window?.API_BASE || '') || '').trim();
    if (!base) return raw;
    if (raw.startsWith('/')) return `${base}${raw}`;
    return `${base}/${raw}`;
  }

  function normalizeAudioUrl(raw) {
    const url = raw?.audio_url || raw?.voice_url || raw?.media_url || raw?.file_url || raw?.attachment_url || raw?.audioUrl || raw?.voiceUrl || raw?.mediaUrl || '';
    return resolveChatAssetUrl(url);
  }

  function normalizeAudioDurationMs(raw) {
    const candidates = [raw?.audio_duration_ms, raw?.voice_duration_ms, raw?.duration_ms, raw?.audioDurationMs, raw?.voiceDurationMs, raw?.durationMs];
    for (const value of candidates) {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) return Math.round(n);
    }
    return null;
  }

  function normalizeAudioMimeType(raw) {
    const mime = raw?.audio_mime_type || raw?.voice_mime_type || raw?.mime_type || raw?.content_type || raw?.audioMimeType || raw?.voiceMimeType || raw?.mimeType || '';
    return String(mime || '').trim();
  }

  function normalizeCanonicalChatMessage(raw, options = {}) {
    const meId = String(options.meId || currentChatSelfUserId() || '');
    const meDisplayName = currentChatSelfDisplayName();
    const fallbackDisplayName = String(options.fallbackDisplayName || 'Driver').trim() || 'Driver';
    const senderUserId = raw?.sender_user_id ?? raw?.senderUserId ?? raw?.user_id ?? raw?.userId ?? null;
    const recipientUserId = raw?.recipient_user_id ?? raw?.recipientUserId ?? raw?.other_user_id ?? raw?.otherUserId ?? null;
    const displayName = String(raw?.displayName || raw?.display_name || raw?.user_name || raw?.name || raw?.sender_display_name || raw?.recipient_display_name || raw?.other_display_name || fallbackDisplayName).trim() || fallbackDisplayName;
    const text = String(raw?.text || raw?.message || raw?.body || '').trim();
    const audioUrl = normalizeAudioUrl(raw);
    const messageType = normalizeMessageType(raw?.message_type || raw?.messageType || raw?.type, audioUrl ? 'voice' : 'text');
    const sender = senderUserId == null ? null : String(senderUserId);
    const recipient = recipientUserId == null ? null : String(recipientUserId);
    const fallbackUserId = options.scope === 'public' ? sender : (sender || recipient);
    const normalizedDisplayName = normalizeChatDisplayName(displayName);
    const normalizedSelfDisplayName = normalizeChatDisplayName(meDisplayName);
    const ownById = !!(meId && sender && meId === sender);
    const ownByName = !sender && !!(normalizedSelfDisplayName && normalizedDisplayName && normalizedSelfDisplayName === normalizedDisplayName);
    const explicitOwn = raw?.isOwn === true || raw?.is_own === true;
    return {
      id: parseMessageId(raw?.id),
      messageType,
      text,
      createdAt: raw?.created_at || raw?.createdAt || raw?.ts || raw?.timestamp || null,
      isOwn: !!(explicitOwn || ownById || ownByName),
      displayName,
      audioUrl,
      audioDurationMs: normalizeAudioDurationMs(raw),
      audioMimeType: normalizeAudioMimeType(raw),
      userId: fallbackUserId == null ? null : String(fallbackUserId),
      senderUserId: sender,
      recipientUserId: recipient,
      raw,
    };
  }

  function normalizePublicChatMessage(raw) {
    return normalizeCanonicalChatMessage(raw, { scope: 'public' });
  }


  function normalizePublicMessagesPayload(payload) {
    const list = Array.isArray(payload) ? payload : (Array.isArray(payload?.messages) ? payload.messages : (payload?.message ? [payload.message] : []));
    return list.map((raw) => normalizePublicChatMessage(raw));
  }

  function normalizePrivateChatMessage(raw, meId = currentChatSelfUserId()) {
    return normalizeCanonicalChatMessage(raw, { scope: 'private', meId });
  }

  function normalizePrivateThread(raw) {
    const otherUserId = raw?.other_user_id ?? raw?.otherUserId ?? raw?.user_id ?? raw?.userId ?? raw?.recipient_user_id ?? raw?.recipientUserId ?? null;
    const displayName = String(raw?.other_display_name || raw?.display_name || raw?.name || raw?.user_name || 'Driver').trim() || 'Driver';
    const audioUrl = normalizeAudioUrl(raw);
    const threadMessageType = normalizeMessageType(raw?.last_message_type || raw?.message_type || raw?.type, audioUrl ? 'voice' : 'text');
    const previewText = threadMessageType === 'voice'
      ? '🎤 Voice note'
      : String(raw?.last_message_text || raw?.last_text || raw?.last_message || raw?.text || '').trim();
    const avatarUrl = String(raw?.avatar_url || raw?.avatarUrl || raw?.other_avatar_url || raw?.otherAvatarUrl || '').trim();
    const lastAt = raw?.last_message_at || raw?.last_created_at || raw?.created_at || raw?.createdAt || raw?.timestamp || raw?.ts || null;
    const lastSenderUserId = raw?.last_sender_user_id ?? raw?.lastSenderUserId ?? null;
    const unread = Number(raw?.unread_count ?? raw?.unreadCount ?? 0);
    return {
      otherUserId: otherUserId == null ? null : String(otherUserId),
      displayName,
      avatarUrl,
      previewText,
      lastAt,
      lastSenderUserId: lastSenderUserId == null ? null : String(lastSenderUserId),
      unreadCount: Number.isFinite(unread) && unread > 0 ? unread : 0,
      raw,
    };
  }


  function isOwnMessage(msg) {
    if (msg?.isOwn === true) return true;
    const selfId = currentChatSelfUserId() || null;
    const senderId = msg?.senderUserId != null ? String(msg.senderUserId) : msgUserId(msg);
    return !!(selfId && senderId && selfId === senderId);
  }

  const CHAT_OUTGOING_ECHO_SUPPRESS_MS = 8000;
  const recentOutgoingChatEchoes = window.TlcChatRecentOutgoingEchoes || (window.TlcChatRecentOutgoingEchoes = new Map());

  function currentChatSelfUserId() {
    const globalWindow = typeof window !== 'undefined' ? window : null;
    const candidates = [
      globalWindow?.communityMeId,
      globalWindow?.communityMe?.id,
      globalWindow?.me?.id,
      typeof localStorage !== 'undefined' ? localStorage.getItem('community_me_id_v1') : '',
    ];
    for (const value of candidates) {
      if (value != null && String(value).trim()) return String(value).trim();
    }
    return '';
  }

  function currentChatSelfDisplayName() {
    const globalWindow = typeof window !== 'undefined' ? window : null;
    const candidates = [
      globalWindow?.communityDisplayName,
      globalWindow?.communityMe?.display_name,
      globalWindow?.me?.display_name,
      typeof localStorage !== 'undefined' ? localStorage.getItem('community_display_name_v1') : '',
    ];
    for (const value of candidates) {
      const normalized = normalizeChatDisplayName(value);
      if (normalized) return String(value || '').trim();
    }
    return '';
  }

  function normalizeChatDisplayName(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function normalizeEchoText(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function makeOutgoingEchoFingerprint(text, userId = currentChatSelfUserId()) {
    const normalized = normalizeEchoText(text);
    if (!normalized || !userId) return '';
    return `${userId}|${normalized}`;
  }

  function pruneOutgoingEchoMap(mapRef) {
    const now = Date.now();
    for (const [key, expiresAt] of mapRef.entries()) {
      if (expiresAt <= now) mapRef.delete(key);
    }
  }

  function rememberOutgoingChatEcho(textOrMsg) {
    pruneOutgoingEchoMap(recentOutgoingChatEchoes);
    const text = typeof textOrMsg === 'string'
      ? textOrMsg
      : (textOrMsg?.text || textOrMsg?.message || '');
    const userId = typeof textOrMsg === 'string'
      ? currentChatSelfUserId()
      : (msgUserId(textOrMsg) || currentChatSelfUserId());
    const fp = makeOutgoingEchoFingerprint(text, userId);
    if (!fp) return;
    recentOutgoingChatEchoes.set(fp, Date.now() + CHAT_OUTGOING_ECHO_SUPPRESS_MS);
  }

  function isSuppressedOutgoingChatEcho(msg) {
    pruneOutgoingEchoMap(recentOutgoingChatEchoes);
    const fp = makeOutgoingEchoFingerprint(
      msg?.text || msg?.message || '',
      msgUserId(msg) || currentChatSelfUserId()
    );
    return !!(fp && recentOutgoingChatEchoes.has(fp));
  }

























  const CHAT_AUDIO_SEEN_KEY_LIMIT = 800;









  let lastObservedChatAuthReady = null;
  let chatNotificationsBootstrapped = false;
  let chatNotificationsBootstrapInFlight = false;
  let chatFirstInteractionBound = false;













  function isChatAuthReady() {
    const hasToken = !!getCommunityToken();
    if (typeof authHeaderOK === 'function') {
      return hasToken && authHeaderOK();
    }
    return hasToken;
  }

  function isEventSourceSupported() {
    return typeof window !== 'undefined' && typeof window.EventSource !== 'undefined';
  }

  function chatLiveTransportState(key) {
    return key === 'private' ? chatLiveRuntime.private : chatLiveRuntime.public;
  }

  function isChatLiveConnected(key) {
    return chatLiveTransportState(key)?.status === 'connected';
  }

  function updateChatLiveMergeDebug(key, messages = [], extra = {}) {
    const state = chatLiveTransportState(key);
    if (!state) return;
    const list = Array.isArray(messages) ? messages : [];
    const lastMessage = list.length ? list[list.length - 1] : null;
    state.lastMergeKey = extra.lastMergeKey || (lastMessage ? getMessageMergeKey(lastMessage) : state.lastMergeKey || '');
    const messageId = parseMessageId(extra.lastMessageId ?? messageNumericId(lastMessage));
    if (messageId !== null) state.lastMessageId = messageId;
    if (extra.threadUserId) state.lastThreadUserId = String(extra.threadUserId);
    if (extra.reconciledAt) state.lastReconcileAt = extra.reconciledAt;
  }

  function clearChatLiveReconnectTimer(key) {
    const state = chatLiveTransportState(key);
    if (!state?.reconnectTimer) return;
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  function resetChatLiveTransportState(key, reason = 'reset') {
    const state = chatLiveTransportState(key);
    if (!state) return;
    clearChatLiveReconnectTimer(key);
    if (state.es) {
      try { state.es.close(); } catch (_) {}
    }
    state.es = null;
    state.url = '';
    state.status = 'idle';
    state.reconnectAttempts = 0;
    state.lastDisconnectReason = reason;
    state.lastError = '';
  }

  function teardownChatLiveRuntime(reason = 'teardown') {
    clearChatLiveReconnectTimer('public');
    clearChatLiveReconnectTimer('private');
    resetChatLiveTransportState('public', reason);
    resetChatLiveTransportState('private', reason);
    chatLiveRuntime.capabilitiesCheckedAt = 0;
    chatLiveRuntime.capabilitiesInFlight = null;
    chatLiveRuntime.capabilities = null;
    if (chatLiveRuntime.pendingPublicReconcile) {
      clearTimeout(chatLiveRuntime.pendingPublicReconcile);
      chatLiveRuntime.pendingPublicReconcile = null;
    }
    if (chatLiveRuntime.pendingPrivateRefresh) {
      clearTimeout(chatLiveRuntime.pendingPrivateRefresh);
      chatLiveRuntime.pendingPrivateRefresh = null;
    }
    if (chatLiveRuntime.pendingPrivateThreadReconcile instanceof Map) {
      for (const timer of chatLiveRuntime.pendingPrivateThreadReconcile.values()) {
        clearTimeout(timer);
      }
      chatLiveRuntime.pendingPrivateThreadReconcile.clear();
    }
  }

  function normalizeChatLiveCapabilityEndpoint(source, fallbackKeys = []) {
    const candidates = [
      source?.url,
      source?.sse_url,
      source?.stream_url,
      source?.streamUrl,
      source?.eventsource_url,
      source?.eventSourceUrl,
      ...fallbackKeys.map((key) => source?.[key]),
    ];
    const url = candidates.map((value) => String(value || '').trim()).find(Boolean) || '';
    const explicitEnabled = source?.enabled;
    const disabled = explicitEnabled === false || source?.available === false || source?.disabled === true;
    return {
      enabled: !disabled && !!url,
      url,
    };
  }

  function normalizeChatLiveCapabilityShape(payload) {
    const source = payload && typeof payload === 'object' ? payload : {};
    const publicSource = source.public || source.public_chat || source.publicChat || source.chat || source.public_live || {};
    const privateSource = source.private || source.dm || source.private_messages || source.privateMessages || source.private_live || {};
    const publicEndpoint = normalizeChatLiveCapabilityEndpoint(publicSource, ['public_url', 'public_sse_url']);
    const privateEndpoint = normalizeChatLiveCapabilityEndpoint(privateSource, ['private_url', 'private_sse_url', 'dm_url']);

    if (!publicEndpoint.url) {
      const payloadPublicUrl = String(source.public_url || source.public_sse_url || source.publicStreamUrl || '').trim();
      if (payloadPublicUrl) {
        publicEndpoint.url = payloadPublicUrl;
        publicEndpoint.enabled = source.public_enabled !== false && source.enabled !== false;
      }
    }

    if (!privateEndpoint.url) {
      const payloadPrivateUrl = String(source.private_url || source.private_sse_url || source.privateStreamUrl || source.dm_url || '').trim();
      if (payloadPrivateUrl) {
        privateEndpoint.url = payloadPrivateUrl;
        privateEndpoint.enabled = source.private_enabled !== false && source.enabled !== false;
      }
    }

    return {
      checkedAt: Date.now(),
      public: {
        enabled: !!publicEndpoint.enabled,
        url: String(publicEndpoint.url || '').trim(),
      },
      private: {
        enabled: !!privateEndpoint.enabled,
        url: String(privateEndpoint.url || '').trim(),
      },
    };
  }

  function readChatLiveConfigFromWindow() {
    const cfg = typeof window !== 'undefined' ? (window.CHAT_LIVE_CONFIG || null) : null;
    if (!cfg || typeof cfg !== 'object') return null;
    return normalizeChatLiveCapabilityShape(cfg);
  }

  async function fetchChatLiveCapabilities({ force = false } = {}) {
    if (!isChatAuthReady()) return null;
    const inlineConfig = readChatLiveConfigFromWindow();
    if (inlineConfig && (inlineConfig.public.enabled || inlineConfig.private.enabled)) {
      chatLiveRuntime.capabilities = inlineConfig;
      chatLiveRuntime.capabilitiesCheckedAt = Date.now();
      return inlineConfig;
    }
    if (!force && chatLiveRuntime.capabilities && (Date.now() - chatLiveRuntime.capabilitiesCheckedAt) < CHAT_LIVE_CAPABILITIES_TTL_MS) {
      return chatLiveRuntime.capabilities;
    }
    if (!force && chatLiveRuntime.capabilitiesInFlight) return chatLiveRuntime.capabilitiesInFlight;
    const token = getCommunityToken();
    if (!token) return null;
    chatLiveRuntime.capabilitiesInFlight = (async () => {
      try {
        const data = await getJSONAuth(CHAT_LIVE_CAPABILITIES_PATH, token, { cache: 'no-store' });
        const normalized = normalizeChatLiveCapabilityShape(data);
        chatLiveRuntime.capabilities = normalized;
        chatLiveRuntime.capabilitiesCheckedAt = Date.now();
        return normalized;
      } catch (err) {
        chatLiveRuntime.capabilities = {
          checkedAt: Date.now(),
          public: { enabled: false, url: '' },
          private: { enabled: false, url: '' },
        };
        chatLiveRuntime.capabilitiesCheckedAt = Date.now();
        return chatLiveRuntime.capabilities;
      } finally {
        chatLiveRuntime.capabilitiesInFlight = null;
      }
    })();
    return chatLiveRuntime.capabilitiesInFlight;
  }

  function schedulePublicReconcile(reason = 'live-event', delay = 0) {
    if (chatLiveRuntime.pendingPublicReconcile) return;
    chatLiveRuntime.pendingPublicReconcile = setTimeout(() => {
      chatLiveRuntime.pendingPublicReconcile = null;
      chatLiveRuntime.public.lastReconcileAt = Date.now();
      scheduleChatPoll({ immediate: true });
    }, Math.max(0, delay));
  }

  function schedulePrivateThreadsRefresh(reason = 'live-event', delay = 0) {
    if (chatLiveRuntime.pendingPrivateRefresh) return;
    chatLiveRuntime.pendingPrivateRefresh = setTimeout(async () => {
      chatLiveRuntime.pendingPrivateRefresh = null;
      chatLiveRuntime.private.lastReconcileAt = Date.now();
      try {
        await chatRefreshPrivateThreads();
      } catch (_) {}
      schedulePrivatePoll({ immediate: true });
    }, Math.max(0, delay));
  }

  function schedulePrivateThreadReconcile(userId, reason = 'live-event', delay = 0) {
    const uid = String(userId || '').trim();
    if (!uid) return;
    if (!(chatLiveRuntime.pendingPrivateThreadReconcile instanceof Map)) {
      chatLiveRuntime.pendingPrivateThreadReconcile = new Map();
    }
    if (chatLiveRuntime.pendingPrivateThreadReconcile.has(uid)) return;
    const timer = setTimeout(async () => {
      chatLiveRuntime.pendingPrivateThreadReconcile.delete(uid);
      chatLiveRuntime.private.lastReconcileAt = Date.now();
      try {
        if (privateActiveUserId === uid) {
          await chatPollPrivateActiveThread({ visible: activeChatTab === 'private' && isChatPanelOpen(), forceFull: false });
        }
        if (driverProfileState.open && String(driverProfileState.userId || '') === uid && !driverProfileState.isSelf) {
          await pollDriverProfileDmOnce();
        }
      } catch (_) {}
    }, Math.max(0, delay));
    chatLiveRuntime.pendingPrivateThreadReconcile.set(uid, timer);
  }

  function applyLivePrivateThreadSummaries(threads = []) {
    const list = (Array.isArray(threads) ? threads : []).map(normalizePrivateThread).filter((thread) => !!thread.otherUserId);
    if (!list.length) return;
    const nextById = new Map((Array.isArray(privateThreads) ? privateThreads : []).map((thread) => [privateThreadUserId(thread), thread]).filter(([uid]) => !!uid));
    list.forEach((thread) => {
      const uid = privateThreadUserId(thread);
      if (!uid) return;
      const existing = nextById.get(uid) || null;
      const visibleThread = activeChatTab === 'private' && isChatPanelOpen() && privateActiveUserId === uid;
      const nextUnread = visibleThread ? 0 : Math.max(Number(privateUnreadByUserId[uid] || 0), Number(thread.unreadCount || 0));
      privateUnreadByUserId[uid] = nextUnread;
      nextById.set(uid, {
        ...(existing || {}),
        ...thread,
        unreadCount: nextUnread,
      });
    });
    privateThreads = Array.from(nextById.values()).sort((a, b) => String(privateThreadTime(b)).localeCompare(String(privateThreadTime(a))));
    renderPrivateTabUnread();
    if (activeChatTab === 'private' && !privateActiveUserId) renderPrivateThreadList();
    updateChatUnreadBadge();
  }

  function handlePublicLiveMessages(messages = [], source = 'sse') {
    const normalized = normalizePublicMessagesPayload(messages);
    if (!normalized.length) return;
    if (!chatInitialHistoryLoaded && !chatHiddenBaselineReady) {
      schedulePublicReconcile('bootstrap-needed', 0);
      return;
    }
    const merged = upsertPublicChatMessages(normalized);
    advanceChatWatermarksFromMessages(normalized);
    const freshIncoming = chatSoundState.baselineReady ? collectFreshIncomingMessagesForAudio(normalized) : [];
    if (!chatSoundState.baselineReady) seedChatIncomingAudioBaseline(normalized);
    if (!killFeedBootstrapReady) {
      seedKillFeedSeenKeys(publicChatMessages);
      killFeedBootstrapReady = true;
      killFeedBootstrapPollConsumed = true;
    }
    updateChatLiveMergeDebug('public', normalized, {
      lastMessageId: messageNumericId(normalized[normalized.length - 1]),
      lastMergeKey: getMessageMergeKey(normalized[normalized.length - 1]),
    });
    const panelOpen = isChatPanelOpen() && activeChatTab === 'public';
    if (panelOpen) {
      renderChatMessages(merged, { replace: true });
      markChatReadThroughLatestLoaded();
      if (killFeedContainer) killFeedContainer.style.display = 'none';
    } else {
      if (killFeedContainer) killFeedContainer.style.display = 'flex';
      showKillFeed(normalized);
    }
    if (freshIncoming.length > 0) void playChatTone('incoming');
    if (!panelOpen && !maybeInitializeChatReadBaseline()) rebuildUnreadBadgeFromMessages(publicChatMessages);
  }

  function applyLivePrivateMessages(otherUserId, messages = [], options = {}) {
    const uid = String(otherUserId || '').trim();
    const normalized = normalizePrivateMessagesPayload(messages);
    if (!uid || !normalized.length) return;
    const previousLast = Number(privateLastMessageIdByUserId[uid] || 0);
    const merged = mergePrivateMessages(uid, normalized);
    const visibleInboxThread = activeChatTab === 'private' && isChatPanelOpen() && privateActiveUserId === uid;
    const visibleDriverProfile = driverProfileState.open && !driverProfileState.isSelf && String(driverProfileState.userId || '') === uid;
    const visible = options.visible === true || visibleInboxThread || visibleDriverProfile;
    const freshIncoming = collectFreshIncomingDriverProfileDm(normalized).filter((msg) => !msg.isOwn);
    const unseenIncoming = normalized.filter((msg) => !msg.isOwn && Number(msg?.id || 0) > previousLast);
    if (visible) {
      privateUnreadByUserId[uid] = 0;
    } else if (unseenIncoming.length) {
      privateUnreadByUserId[uid] = Number(privateUnreadByUserId[uid] || 0) + unseenIncoming.length;
    }
    privateUpsertThreadFromMessages(uid, merged, { displayName: options.displayName || privateActiveDisplayName || driverProfileState.displayName || '' });
    if (visibleInboxThread) renderPrivateConversation();
    if (visibleDriverProfile) {
      driverProfileState.messages = privateMessagesByUserId[uid] || merged;
      driverProfileState.latestMessageId = (driverProfileState.messages || []).reduce((max, msg) => Math.max(max, Number(msg?.id || 0)), 0) || null;
      updateDriverProfileDmList(driverProfileState.messages);
    }
    updateChatLiveMergeDebug('private', normalized, {
      lastMessageId: messageNumericId(normalized[normalized.length - 1]),
      lastMergeKey: getMessageMergeKey(normalized[normalized.length - 1]),
      threadUserId: uid,
    });
    renderPrivateTabUnread();
    updateChatUnreadBadge();
    if (freshIncoming.length > 0 && !visible) void playChatTone('incoming');
  }

  function safeParseLiveEvent(event) {
    const type = String(event?.type || 'message');
    const data = String(event?.data || '').trim();
    let payload = {};
    if (data) {
      try { payload = JSON.parse(data); } catch (_) { payload = { raw: data }; }
    }
    return { type, payload, lastEventId: String(event?.lastEventId || payload?.event_id || payload?.id || '').trim() };
  }

  function handlePublicLiveEvent(event) {
    const parsed = safeParseLiveEvent(event);
    const state = chatLiveRuntime.public;
    state.lastEventAt = Date.now();
    state.lastEventId = parsed.lastEventId || state.lastEventId || '';
    const payload = parsed.payload || {};
    if (payload.keepalive || parsed.type === 'ping' || parsed.type === 'keepalive') return;
    if (parsed.type === 'battle_result' || parsed.type === 'game_battle_result' || payload.event_name === 'battle_result' || payload.event_name === 'game_battle_result' || payload.battle_result || payload.winner_display_name) {
      showBattleFeedEntry(payload.battle_result || payload);
      if (payload.match_id && isGamesPanelOpen()) {
        void loadGamesBattleDashboard({ silent: true });
        if (Number(gamesState.activeMatch?.id || 0) === Number(payload.match_id || 0)) {
          void loadActiveBattleMatch({ silent: true, preferredMatchId: Number(payload.match_id) });
        }
      }
      return;
    }
    if (payload.message || Array.isArray(payload.messages) || Array.isArray(payload.rows)) {
      handlePublicLiveMessages(payload.messages || payload.rows || [payload.message], 'sse');
      return;
    }
    if (payload.message_id != null || payload.after != null || payload.cursor != null || payload.reconcile === true) {
      schedulePublicReconcile('public-live-nudge', 50);
    }
  }

  function resolvePrivateLiveThreadUserId(payload = {}) {
    return String(payload.other_user_id || payload.otherUserId || payload.user_id || payload.userId || payload.thread_user_id || payload.threadUserId || '').trim();
  }

  function handlePrivateLiveEvent(event) {
    const parsed = safeParseLiveEvent(event);
    const state = chatLiveRuntime.private;
    state.lastEventAt = Date.now();
    state.lastEventId = parsed.lastEventId || state.lastEventId || '';
    const payload = parsed.payload || {};
    if (payload.keepalive || parsed.type === 'ping' || parsed.type === 'keepalive') return;
    if (payload.thread || Array.isArray(payload.threads)) {
      applyLivePrivateThreadSummaries(payload.threads || [payload.thread]);
    }
    if (payload.message || Array.isArray(payload.messages)) {
      const first = payload.message || (Array.isArray(payload.messages) ? payload.messages[0] : null) || {};
      const uid = resolvePrivateLiveThreadUserId(first) || resolvePrivateLiveThreadUserId(payload);
      if (uid) {
        applyLivePrivateMessages(uid, payload.messages || [payload.message], { displayName: payload.display_name || payload.displayName || '' });
        return;
      }
    }
    const uid = resolvePrivateLiveThreadUserId(payload);
    if (uid) {
      if ((activeChatTab === 'private' && privateActiveUserId === uid) || (driverProfileState.open && String(driverProfileState.userId || '') === uid && !driverProfileState.isSelf)) {
        schedulePrivateThreadReconcile(uid, 'private-live-thread-nudge', 60);
      } else {
        schedulePrivateThreadsRefresh('private-live-summary-nudge', 100);
      }
      return;
    }
    if (payload.reconcile === true || parsed.type === 'dm_summary' || parsed.type === 'thread_summary') {
      schedulePrivateThreadsRefresh('private-live-reconcile', 120);
    }
  }

  function bindChatLiveTransportEvents(key, eventSource) {
    const handler = key === 'private' ? handlePrivateLiveEvent : handlePublicLiveEvent;
    const eventNames = ['message', 'public_message', 'chat_message', 'chat_public_message', 'private_message', 'dm_message', 'dm_summary', 'thread_summary', 'thread_update', 'chat_nudge', 'ping', 'keepalive'];
    eventNames.forEach((eventName) => {
      eventSource.addEventListener(eventName, handler);
    });
    eventSource.onmessage = handler;
  }

  function queueChatLiveReconnect(key, reason = 'reconnect') {
    const state = chatLiveTransportState(key);
    if (!state || !isChatAuthReady()) return;
    if (state.reconnectTimer) return;
    state.reconnectAttempts += 1;
    state.reconnectCount += 1;
    state.lastDisconnectReason = reason;
    state.status = 'polling';
    const delay = Math.min(CHAT_LIVE_RECONNECT_MAX_MS, CHAT_LIVE_RECONNECT_BASE_MS * Math.max(1, 2 ** Math.max(0, state.reconnectAttempts - 1)));
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      ensureChatLiveTransport(key).catch(() => {});
    }, delay);
  }

  function closeChatLiveTransport(key, reason = 'close', { suppressReconnect = true } = {}) {
    const state = chatLiveTransportState(key);
    if (!state) return;
    clearChatLiveReconnectTimer(key);
    const es = state.es;
    state.es = null;
    state.status = 'polling';
    state.lastDisconnectReason = reason;
    if (es) {
      try { es.close(); } catch (_) {}
    }
    if (!suppressReconnect && isChatAuthReady()) queueChatLiveReconnect(key, reason);
  }

  async function ensureChatLiveTransport(key) {
    const state = chatLiveTransportState(key);
    if (!state) return;
    if (!isChatAuthReady() || !isEventSourceSupported()) {
      closeChatLiveTransport(key, 'unsupported', { suppressReconnect: true });
      return;
    }
    const caps = await fetchChatLiveCapabilities();
    const target = key === 'private' ? caps?.private : caps?.public;
    const url = String(target?.url || '').trim();
    if (!target?.enabled || !url) {
      closeChatLiveTransport(key, 'capability-unavailable', { suppressReconnect: true });
      return;
    }
    if (state.es && state.url === url && (state.status === 'connecting' || state.status === 'connected')) return;
    closeChatLiveTransport(key, 'refresh-connection', { suppressReconnect: true });
    const seq = state.connectSeq + 1;
    state.connectSeq = seq;
    state.status = 'connecting';
    state.url = url;
    state.lastConnectAt = Date.now();
    try {
      const es = new window.EventSource(url);
      state.es = es;
      bindChatLiveTransportEvents(key, es);
      es.onopen = () => {
        if (state.connectSeq !== seq) return;
        state.status = 'connected';
        state.reconnectAttempts = 0;
        state.lastError = '';
        if (key === 'public') scheduleChatPoll({ immediate: true });
        if (key === 'private') schedulePrivatePoll({ immediate: true });
      };
      es.onerror = () => {
        if (state.connectSeq !== seq) return;
        state.lastError = 'EventSource error';
        closeChatLiveTransport(key, 'eventsource-error', { suppressReconnect: false });
        if (key === 'public') scheduleChatPoll({ immediate: true });
        if (key === 'private') schedulePrivatePoll({ immediate: true });
      };
    } catch (err) {
      state.lastError = String(err?.message || err || 'connect failed');
      closeChatLiveTransport(key, 'connect-failed', { suppressReconnect: false });
    }
  }

  async function ensureChatLiveTransports() {
    if (!isChatAuthReady()) {
      teardownChatLiveRuntime('signed-out');
      return;
    }
    await Promise.allSettled([
      ensureChatLiveTransport('public'),
      ensureChatLiveTransport('private'),
    ]);
  }



































  attachChatSoundStateHandlers();





  function hydrateChatStateFromMessages(messages) {
    if (!Array.isArray(messages) || !messages.length) return;
    for (const msg of messages) {
      const key = chatMsgKey(msg);
      chatSeenKeys.add(key);
      const cursor = chatMsgCursor(msg);
      if (cursor !== null && cursor !== undefined) chatLastSeen = cursor;
      const id = messageNumericId(msg);
      if (id !== null) {
        chatLatestMessageId = chatLatestMessageId === null ? id : Math.max(chatLatestMessageId, id);
      }
    }
  }

  function advanceChatWatermarksFromMessages(messages) {
    if (!Array.isArray(messages) || !messages.length) return;
    for (const msg of messages) {
      const cursor = chatMsgCursor(msg);
      if (cursor !== null && cursor !== undefined) chatLastSeen = cursor;
      const id = messageNumericId(msg);
      if (id !== null) {
        chatLatestMessageId = chatLatestMessageId === null ? id : Math.max(chatLatestMessageId, id);
      }
    }
  }

  function rebuildUnreadBadgeFromMessages(messages) {
    if (!Array.isArray(messages) || !messages.length) {
      unreadChatCount = 0;
      updateChatUnreadBadge();
      return;
    }
    unreadChatCount = messages.reduce(
      (acc, msg) => (shouldCountUnread(msg, { ignoreOpenPanel: true }) ? acc + 1 : acc),
      0
    );
    updateChatUnreadBadge();
  }

  async function ensureChatNotificationsBootstrapped(trigger = 'interaction') {
    if (chatNotificationsBootstrapped || chatNotificationsBootstrapInFlight) return chatNotificationsBootstrapped;
    chatNotificationsBootstrapInFlight = true;
    try {
      if (!isChatAuthReady()) {
        chatNotificationsBootstrapped = false;
        return false;
      }

      chatResetState();
      const result = await chatFetchMessages({ limit: 60 });
      if (!result?.ok) {
        chatNotificationsBootstrapped = false;
        return false;
      }
      const msgs = result?.ok && Array.isArray(result.messages) ? result.messages : [];
      hydrateChatStateFromMessages(msgs);
      seedChatIncomingAudioBaseline(msgs);
      seedKillFeedSeenKeys(msgs);
      killFeedBootstrapReady = true;
      killFeedBootstrapPollConsumed = false;

      if (!maybeInitializeChatReadBaseline()) {
        rebuildUnreadBadgeFromMessages(msgs);
      }

      chatInitialHistoryLoaded = true;
      chatInitialHistoryRetryQueued = false;

      syncChatPollingState();
      await chatPollOnce();
      chatNotificationsBootstrapped = true;
      return true;
    } catch (err) {
      console.warn('ensureChatNotificationsBootstrapped failed', err);
      chatNotificationsBootstrapped = false;
      return false;
    } finally {
      chatNotificationsBootstrapInFlight = false;
    }
  }

  async function onChatFirstInteraction(evt) {
    const target = evt?.target;
    if (target && typeof target.closest === 'function' && target.closest('[data-chat-voice-trigger]')) return;
    await primeChatSoundSystem(evt?.type || 'interaction');
    await ensureChatNotificationsBootstrapped(evt?.type || 'interaction');
  }

  function removeChatFirstInteractionListeners() {
    if (!chatFirstInteractionBound) return;
    ['pointerdown', 'touchstart', 'click', 'keydown'].forEach((evtName) => {
      document.removeEventListener(evtName, onChatFirstInteraction, true);
    });
    chatFirstInteractionBound = false;
  }

  function bindChatFirstInteractionListeners() {
    if (chatFirstInteractionBound) return;
    ['pointerdown', 'touchstart', 'click', 'keydown'].forEach((evtName) => {
      document.addEventListener(evtName, onChatFirstInteraction, { passive: true, capture: true });
    });
    chatFirstInteractionBound = true;
  }

  function observeChatAuthState() {
    const authReady = typeof authHeaderOK === 'function' && authHeaderOK();
    if (lastObservedChatAuthReady === null) {
      lastObservedChatAuthReady = authReady;
      return;
    }
    if (authReady !== lastObservedChatAuthReady) {
      lastObservedChatAuthReady = authReady;
      if (authReady) {
        chatNotificationsBootstrapped = false;
        ensureChatNotificationsBootstrapped('auth-signed-in')
          .catch((err) => console.warn('chat auth bootstrap failed', err));
      } else {
        chatNotificationsBootstrapped = false;
        bindChatFirstInteractionListeners();
      }
    }
  }

  attachChatSoundStateHandlers();
  bindChatSoundPrimeListeners();
  bindChatFirstInteractionListeners();

  function shouldCountUnread(msg, { ignoreOpenPanel = false } = {}) {
    if (isOwnMessage(msg)) return false;
    if (!ignoreOpenPanel && isChatPanelOpen()) return false;
    const msgId = messageNumericId(msg);
    if (msgId === null) return false;
    if (chatLastReadId === null) return false;
    return msgId > chatLastReadId;
  }

  // Append new messages to the kill feed. Keep only the last 4 and
  // remove each after 30 seconds.
  function showKillFeed(msgs) {
    if (!Array.isArray(msgs)) return;

    msgs.forEach((msg) => {
      // Use chatMsgKey() if available to generate a stable key; fall back to a simple composite.
      const key = (typeof chatMsgKey === 'function')
        ? chatMsgKey(msg)
        : `${msg.room || ''}|${msg.user_id || msg.userId || ''}|${msg.created_at || msg.ts || ''}`;

      // Do not show messages that have already been displayed in the feed.
      if (killFeedSeenKeys.has(key)) return;
      killFeedSeenKeys.add(key);

      const normalized = normalizePublicChatMessage(msg);
      const who = normalized.displayName || 'Driver';
      const body = normalized.messageType === 'voice'
        ? '🎤 Voice note'
        : String(normalized.text || '').trim();
      if (!body) return;

      const div = document.createElement('div');
      div.className = 'killFeedMsg';
      const text = document.createElement('span');
      text.className = 'killFeedText';
      text.textContent = `${who}: ${body}`;
      div.appendChild(text);
      killFeedContainer.appendChild(div);

      // Keep only the last four messages visible at any time.
      while (killFeedContainer.childNodes.length > 4) {
        killFeedContainer.removeChild(killFeedContainer.firstChild);
      }

      // Remove this message from the DOM after 30 seconds. Do NOT remove it
      // from killFeedSeenKeys, so duplicates are never displayed again.
      setTimeout(() => {
        if (div.parentNode) div.parentNode.removeChild(div);
      }, 30000);
      if (shouldCountUnread(msg)) {
        unreadChatCount += 1;
        updateChatUnreadBadge();
      }
    });
  }


  function showBattleFeedEntry(payload = {}) {
    const matchId = String(payload?.match_id || payload?.matchId || '').trim();
    const key = `battle:${matchId || `${payload?.winner_user_id || ''}:${payload?.completed_at || ''}`}`;
    if (killFeedSeenKeys.has(key)) return;
    killFeedSeenKeys.add(key);
    const winner = String(payload?.winner_display_name || 'Driver').trim() || 'Driver';
    const loser = String(payload?.loser_display_name || 'Driver').trim() || 'Driver';
    const game = String(payload?.game_type || 'battle').trim() || 'battle';
    const xp = Number(payload?.winner_xp_awarded || 0);
    const level = Number(payload?.winner_new_level || payload?.new_level || 0);
    const textBits = [`🏁 ${winner} beat ${loser}`, `in ${game}`];
    if (xp > 0) textBits.push(`(+${formatProgressNumber(xp, { maxFractionDigits: 0 })} XP)`);
    if (level > 0) textBits.push(`Lvl ${Math.floor(level)}`);
    const div = document.createElement('div');
    div.className = 'killFeedMsg battleFeedMsg';
    const text = document.createElement('span');
    text.className = 'killFeedText';
    text.textContent = textBits.join(' ');
    div.appendChild(text);
    killFeedContainer.appendChild(div);
    while (killFeedContainer.childNodes.length > 4) {
      killFeedContainer.removeChild(killFeedContainer.firstChild);
    }
    setTimeout(() => {
      if (div.parentNode) div.parentNode.removeChild(div);
    }, 30000);
  }







































































  function renderPublicMessageRow(message) {
    const msg = normalizePublicChatMessage(message);
    const own = !!msg?.isOwn;
    const safeName = escapeHtml(msg.displayName || 'Driver');
    const time = escapeHtml(formatChatTime(msg.createdAt));
    const bubbleClass = own ? 'chatBubbleSelf' : 'chatBubbleOther';
    const body = msg.messageType === 'voice'
      ? renderVoiceNotePlayer(msg, 'public')
      : `<div class="${bubbleClass} chatPublicTextBubble">${escapeHtml(String(msg.text || ''))}</div>`;
    return `<div class="chatMsgRow ${own ? 'self' : 'other'}${msg.messageType === 'voice' ? ' chatMsgRowVoice' : ''}" data-chat-row="public" data-message-key="${escapeHtml(getVoiceMessageDomKey(msg))}" data-message-id="${escapeHtml(String(msg?.id ?? ''))}" data-message-scope="public" data-audio-url="${escapeHtml(String(msg?.audioUrl || ''))}"><div class="chatMsgNameLine"><strong class="chatMsgName">${safeName}</strong></div><div class="chatMsgBubbleWrap">${body}</div><div class="chatMsgTime">${time}</div></div>`;
  }

  function renderPrivateConversationRow(message, scope = 'private') {
    const msg = normalizePrivateChatMessage(message, currentChatSelfUserId());
    const own = !!msg?.isOwn;
    const cls = own ? 'chatBubbleSelf' : 'chatBubbleOther';
    const body = msg?.messageType === 'voice'
      ? renderVoiceNotePlayer(msg, scope === 'profile-dm' ? 'driverProfile' : 'private')
      : `<div class="${cls}">${escapeHtml(String(msg?.text || ''))}</div>`;
    const t = escapeHtml(formatChatTime(msg?.createdAt));
    return `<div class="chatPrivateMsgRow ${own ? 'self' : 'other'}" data-chat-row="${escapeHtml(scope)}" data-message-key="${escapeHtml(getVoiceMessageDomKey(msg))}" data-message-id="${escapeHtml(String(msg?.id ?? ''))}" data-message-scope="${escapeHtml(scope)}" data-audio-url="${escapeHtml(String(msg?.audioUrl || ''))}">${body}<div class="chatMsgTime">${t}</div></div>`;
  }





  function reconcileMessageList(listEl, messages, { scope = 'public', rowRenderer, replace = false, emptyHtml = '' } = {}) {
    if (!listEl) return false;
    const nextMessages = Array.isArray(messages) ? messages : [];
    const existingRows = new Map(Array.from(listEl.querySelectorAll?.('[data-message-key]') || []).map((row) => [row.dataset.messageKey, row]));
    const nextRows = [];
    let changed = false;
    if (!nextMessages.length) {
      if (replace || listEl.childElementCount > 0) {
        listEl.innerHTML = emptyHtml;
        changed = true;
      }
      listEl.dataset.hasMessages = '0';
      return changed;
    }
    nextMessages.forEach((message) => {
      const key = getVoiceMessageDomKey(message);
      const existing = existingRows.get(key) || null;
      const nextHtml = rowRenderer(message, scope);
      let row = existing;
      if (!row) {
        row = createNodeFromHtml(nextHtml);
        changed = true;
      } else {
        const nextAudioUrl = String(message?.audioUrl || '').trim();
        const sameVoiceRow = shouldReuseVoiceRow(buildVoicePlayerMessageFromDataset(existing.querySelector?.('[data-voice-player]') || existing), message);
        const sameTextRow = row.dataset.audioUrl === nextAudioUrl && row.outerHTML === nextHtml;
        if (!sameVoiceRow && !sameTextRow) {
          row = createNodeFromHtml(nextHtml);
          changed = true;
        }
      }
      if (row) nextRows.push(row);
      existingRows.delete(key);
    });
    if (existingRows.size) changed = true;
    let orderChanged = false;
    let cursor = listEl.firstElementChild;
    nextRows.forEach((row) => {
      if (row === cursor) {
        cursor = cursor ? cursor.nextElementSibling : null;
        return;
      }
      orderChanged = true;
      listEl.insertBefore(row, cursor || null);
    });
    while (cursor) {
      const nextCursor = cursor.nextElementSibling;
      listEl.removeChild(cursor);
      cursor = nextCursor;
      orderChanged = true;
    }
    listEl.dataset.hasMessages = '1';
    return changed || orderChanged;
  }


































































  // Build panel HTML or a sign‑in prompt
  function chatPanelHTML() {
    if (typeof authHeaderOK === 'function' && !authHeaderOK()) {
      return `
        <div class="panelBlock chatPanelWrap">
          <div class="chatSignedOut">Sign in to chat with the community.</div>
        </div>
      `;
    }
    return `
      <div class="panelBlock chatPanelWrap">
        <div class="chatHeader">Community chat</div>
        <div class="chatTabs" role="tablist" aria-label="Chat tabs">
          <button id="chatTabPublic" class="chatTabBtn ${activeChatTab === 'public' ? 'active' : ''}" type="button" role="tab" aria-selected="${activeChatTab === 'public'}">Public</button>
          <button id="chatTabPrivate" class="chatTabBtn ${activeChatTab === 'private' ? 'active' : ''}" type="button" role="tab" aria-selected="${activeChatTab === 'private'}">Private<span id="chatPrivateTabUnread" class="chatPrivateTabUnread"></span></button>
          <div class="chatTabIndicator"></div>
        </div>
        <div class="chatBody">
          <div id="chatPublicView" class="chatTabContent ${activeChatTab === 'public' ? '' : 'hidden'}">
            <div id="chatList" class="chatList" aria-live="polite"></div>
          </div>
          <div id="chatPublicComposer" class="chatComposerWrap ${activeChatTab === 'public' ? '' : 'hidden'}">
            <div class="chatComposer">
              <input id="chatInput" type="text" class="chatInput" placeholder="Message drivers…" maxlength="600" />
              <button id="chatSendBtn" class="chipBtn" type="button">Send</button>
            </div>
            ${buildVoiceComposer('public')}
          </div>
          <div id="chatPrivateView" class="chatTabContent ${activeChatTab === 'private' ? '' : 'hidden'}">
            <div id="chatPrivateWrap" class="chatPrivateWrap"></div>
          </div>
        </div>
      </div>
    `;
  }

  // Helpers for message keys, timestamps, scroll behaviour, etc.
  function chatMsgCursor(msg) { return msg?.id ?? msg?.createdAt ?? msg?.created_at ?? null; }
  function chatMsgKey(msg) {
    const id = msg?.id;
    if (id !== undefined && id !== null) return `id:${id}`;
    const t = msg?.createdAt || msg?.created_at || '';
    const n = msg?.displayName || msg?.display_name || msg?.user_name || msg?.name || '';
    const body = msg?.text || msg?.message || msg?.audioUrl || '';
    return `fallback:${t}|${n}|${body}`;
  }
  function formatChatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (!Number.isFinite(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function isChatNearBottom(listEl, px = 80) {
    if (!listEl) return true;
    return listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight <= px;
  }
  function setChatStatus(text) {
    const listEl = document.getElementById('chatList');
    if (!listEl || listEl.dataset.hasMessages === '1') return;
    if (typeof escapeHtml === 'function') {
      listEl.innerHTML = `<div class="chatEmpty">${escapeHtml(text)}</div>`;
    } else {
      listEl.textContent = text;
    }
  }


  function privateThreadUserId(thread) {
    return thread?.otherUserId != null ? String(thread.otherUserId) : null;
  }

  function privateThreadName(thread) {
    return String(thread?.displayName || 'Driver').trim() || 'Driver';
  }

  function privateThreadPreview(thread) {
    return String(thread?.previewText || '').trim();
  }

  function privateThreadTime(thread) {
    return thread?.lastAt || '';
  }

  function privateThreadUnreadCount(thread) {
    const uid = privateThreadUserId(thread);
    if (!uid) return 0;
    const serverUnread = Number(thread?.unreadCount);
    const localUnread = Number(privateUnreadByUserId[uid] || 0);
    if (Number.isFinite(serverUnread)) return Math.max(localUnread, serverUnread);
    return localUnread;
  }

  function normalizePrivateMessagesPayload(payload) {
    const list = Array.isArray(payload) ? payload : (Array.isArray(payload?.messages) ? payload.messages : (payload?.message ? [payload.message] : []));
    const meId = currentChatSelfUserId();
    return list
      .map((raw) => normalizePrivateChatMessage(raw, meId))
      .sort((a, b) => compareChatMessages(a, b));
  }

  function compareChatMessages(a, b) {
    const aid = parseMessageId(a?.id);
    const bid = parseMessageId(b?.id);
    if (aid !== null && bid !== null && aid !== bid) return aid - bid;
    return String(a?.createdAt || '').localeCompare(String(b?.createdAt || ''));
  }

  function parseChatCreatedAtMs(value) {
    if (value === null || value === undefined || value === '') return NaN;
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return NaN;
      return value > 1e12 ? value : value * 1000;
    }
    const raw = String(value || '').trim();
    if (!raw) return NaN;
    if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
      const numeric = Number(raw);
      if (!Number.isFinite(numeric)) return NaN;
      return numeric > 1e12 ? numeric : numeric * 1000;
    }
    const parsed = new Date(raw).getTime();
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  function isMessageExpired(message, now = Date.now()) {
    const createdAtMs = parseChatCreatedAtMs(message?.createdAt || message?.created_at || null);
    if (!Number.isFinite(createdAtMs)) return false;
    return createdAtMs <= (now - CHAT_RETENTION_MS);
  }

  function pruneExpiredMessageList(list, now = Date.now()) {
    const source = Array.isArray(list) ? list : [];
    const kept = [];
    const removed = [];
    source.forEach((message) => {
      if (isMessageExpired(message, now)) removed.push(message);
      else kept.push(message);
    });
    return { kept, removed };
  }

  function pruneExpiredVoiceAssets(removedMessages = []) {
    const removed = Array.isArray(removedMessages) ? removedMessages : [];
    if (!removed.length) return;
    const removedIds = new Set();
    removed.forEach((message) => {
      const messageId = parseMessageId(message?.id);
      const domKey = getVoiceMessageDomKey(message);
      if (messageId !== null) removedIds.add(messageId);
      if (domKey) {
        const selector = `[data-message-key="${escapeCssValue(domKey)}"]`;
        document.querySelectorAll?.(selector).forEach((row) => row.remove());
      }
    });
    for (const messageId of removedIds) {
      const isActiveMessage = parseMessageId(voicePlaybackRuntime.activeMessageId) === messageId;
      for (const [key, entry] of Array.from(voiceAssetCache.entries())) {
        if (!key.startsWith(`${messageId}::`)) continue;
        const blobUrl = String(entry?.blobUrl || '').trim();
        if (blobUrl && (!isActiveMessage || blobUrl !== voicePlaybackRuntime.activeBlobUrl)) {
          try { URL.revokeObjectURL(blobUrl); } catch (_) {}
        }
        if (!isActiveMessage || blobUrl !== voicePlaybackRuntime.activeBlobUrl) voiceAssetCache.delete(key);
      }
    }
    if (removedIds.size) syncAllVoicePlayers();
  }

  function pruneExpiredChatState() {
    const now = Date.now();
    const removedMessages = [];

    const publicResult = pruneExpiredMessageList(publicChatMessages, now);
    publicChatMessages = publicResult.kept;
    removedMessages.push(...publicResult.removed);

    const retainedThreadIds = new Set(privateBackendThreadIds || []);
    const nextPrivateMessages = Object.create(null);
    Object.entries(privateMessagesByUserId || {}).forEach(([uid, list]) => {
      const result = pruneExpiredMessageList(list, now);
      if (result.kept.length) nextPrivateMessages[uid] = result.kept;
      removedMessages.push(...result.removed);
      if (result.kept.length) {
        const latestId = result.kept.reduce((max, msg) => Math.max(max, Number(msg?.id || 0)), 0);
        if (latestId) privateLastMessageIdByUserId[uid] = latestId;
        else delete privateLastMessageIdByUserId[uid];
      } else {
        delete privateLastMessageIdByUserId[uid];
        if (!retainedThreadIds.has(uid)) delete privateUnreadByUserId[uid];
      }
    });
    privateMessagesByUserId = nextPrivateMessages;

    const nextThreads = [];
    (Array.isArray(privateThreads) ? privateThreads : []).forEach((thread) => {
      const uid = privateThreadUserId(thread);
      if (!uid) return;
      const messages = privateMessagesByUserId[uid] || [];
      if (!messages.length && !retainedThreadIds.has(uid)) return;
      if (!messages.length) {
        nextThreads.push(thread);
        return;
      }
      const latest = messages[messages.length - 1] || {};
      nextThreads.push({
        ...thread,
        previewText: latest?.messageType === 'voice' ? '🎤 Voice note' : String(latest?.text || thread?.previewText || '').trim(),
        lastAt: latest?.createdAt || thread?.lastAt || null,
        lastSenderUserId: latest?.senderUserId || thread?.lastSenderUserId || null,
        unreadCount: Number(privateUnreadByUserId[uid] || 0),
      });
    });
    privateThreads = nextThreads.sort((a, b) => String(privateThreadTime(b)).localeCompare(String(privateThreadTime(a))));

    if (driverProfileState && Array.isArray(driverProfileState.messages)) {
      const driverResult = pruneExpiredMessageList(driverProfileState.messages, now);
      driverProfileState.messages = driverResult.kept;
      removedMessages.push(...driverResult.removed);
      driverProfileState.latestMessageId = driverProfileState.messages.reduce((max, msg) => Math.max(max, Number(msg?.id || 0)), 0) || null;
    }

    pruneExpiredVoiceAssets(removedMessages);
    pruneVoiceAssetCache();

    const latestPublicId = publicChatMessages.reduce((max, msg) => Math.max(max, Number(msg?.id || 0)), 0) || null;
    chatLatestMessageId = latestPublicId;
    chatLastSeen = publicChatMessages.length ? chatMsgCursor(publicChatMessages[publicChatMessages.length - 1]) : null;
    chatSeenKeys = new Set(publicChatMessages.map((msg) => chatMsgKey(msg)));
    rebuildUnreadBadgeFromMessages(publicChatMessages);
    renderPrivateTabUnread();
  }

  function getMessageMergeKey(msg) {
    if (msg?.id != null) return `id:${msg.id}`;
    return `fallback:${msg?.createdAt || ''}|${msg?.senderUserId || msg?.userId || ''}|${msg?.recipientUserId || ''}|${msg?.text || ''}|${msg?.audioUrl || ''}`;
  }

  function messageCompletenessScore(msg) {
    let score = 0;
    if (parseMessageId(msg?.id) !== null) score += 10;
    if (String(msg?.text || '').trim()) score += 1;
    if (String(msg?.createdAt || '').trim()) score += 1;
    if (String(msg?.displayName || '').trim()) score += 1;
    if (normalizeMessageType(msg?.messageType, msg?.audioUrl ? 'voice' : 'text') === 'voice') score += 2;
    if (String(msg?.audioUrl || '').trim()) score += 6;
    if (Number.isFinite(Number(msg?.audioDurationMs))) score += 1;
    if (String(msg?.audioMimeType || '').trim()) score += 1;
    if (String(msg?.senderUserId || '').trim()) score += 1;
    if (String(msg?.recipientUserId || '').trim()) score += 1;
    return score;
  }

  function mergeMessagePair(existing, incoming) {
    if (!existing) return incoming;
    if (!incoming) return existing;
    const incomingVoiceUpgrade = normalizeMessageType(existing?.messageType, existing?.audioUrl ? 'voice' : 'text') === 'voice'
      && normalizeMessageType(incoming?.messageType, incoming?.audioUrl ? 'voice' : 'text') === 'voice'
      && !String(existing?.audioUrl || '').trim()
      && !!String(incoming?.audioUrl || '').trim();
    const existingVoiceUpgrade = normalizeMessageType(existing?.messageType, existing?.audioUrl ? 'voice' : 'text') === 'voice'
      && normalizeMessageType(incoming?.messageType, incoming?.audioUrl ? 'voice' : 'text') === 'voice'
      && !!String(existing?.audioUrl || '').trim()
      && !String(incoming?.audioUrl || '').trim();
    const preferred = incomingVoiceUpgrade || (!existingVoiceUpgrade && messageCompletenessScore(incoming) >= messageCompletenessScore(existing))
      ? incoming
      : existing;
    const fallback = preferred === incoming ? existing : incoming;
    return {
      ...fallback,
      ...preferred,
      id: parseMessageId(preferred?.id ?? fallback?.id),
      messageType: normalizeMessageType(preferred?.messageType || fallback?.messageType, preferred?.audioUrl || fallback?.audioUrl ? 'voice' : 'text'),
      text: String(preferred?.text || fallback?.text || '').trim(),
      createdAt: preferred?.createdAt || fallback?.createdAt || null,
      isOwn: preferred?.isOwn === true || fallback?.isOwn === true,
      displayName: String(preferred?.displayName || fallback?.displayName || 'Driver').trim() || 'Driver',
      audioUrl: String(preferred?.audioUrl || fallback?.audioUrl || '').trim(),
      audioDurationMs: normalizeAudioDurationMs(preferred) ?? normalizeAudioDurationMs(fallback),
      audioMimeType: String(preferred?.audioMimeType || fallback?.audioMimeType || '').trim(),
      userId: preferred?.userId || fallback?.userId || null,
      senderUserId: preferred?.senderUserId || fallback?.senderUserId || null,
      recipientUserId: preferred?.recipientUserId || fallback?.recipientUserId || null,
      raw: preferred?.raw || fallback?.raw || null,
    };
  }

  function upsertChatMessages(base = [], incoming = []) {
    const merged = new Map();
    [...(Array.isArray(base) ? base : []), ...(Array.isArray(incoming) ? incoming : [])].forEach((msg) => {
      if (!msg) return;
      const key = getMessageMergeKey(msg);
      merged.set(key, mergeMessagePair(merged.get(key), msg));
    });
    return Array.from(merged.values()).sort(compareChatMessages);
  }

  function setPublicChatMessages(messages = []) {
    publicChatMessages = upsertChatMessages([], messages);
    pruneExpiredChatState();
    pruneVoiceAssetCache();
    return publicChatMessages;
  }

  function upsertPublicChatMessages(messages = []) {
    publicChatMessages = upsertChatMessages(publicChatMessages, messages);
    pruneExpiredChatState();
    pruneVoiceAssetCache();
    return publicChatMessages;
  }

  function mergePrivateMessages(otherUserId, messages = []) {
    const uid = String(otherUserId || '');
    if (!uid) return [];
    privateMessagesByUserId[uid] = upsertChatMessages(privateMessagesByUserId[uid] || [], messages);
    pruneExpiredChatState();
    const merged = privateMessagesByUserId[uid] || [];
    const latestId = merged.reduce((max, msg) => {
      const id = parseMessageId(msg?.id);
      return id === null ? max : Math.max(max, id);
    }, 0);
    privateLastMessageIdByUserId[uid] = latestId || privateLastMessageIdByUserId[uid] || null;
    pruneVoiceAssetCache();
    return merged;
  }


  function privateUpsertThreadFromMessages(otherUserId, messages = [], options = {}) {
    const uid = String(otherUserId || '');
    if (!uid || !Array.isArray(messages) || !messages.length) return;
    const latest = messages[messages.length - 1] || {};
    const existing = privateThreads.find((thread) => privateThreadUserId(thread) === uid) || null;
    const next = {
      otherUserId: uid,
      displayName: String(options.displayName || (privateActiveUserId === uid && privateActiveDisplayName) || existing?.displayName || latest?.displayName || 'Driver').trim() || 'Driver',
      avatarUrl: existing?.avatarUrl || '',
      previewText: latest?.messageType === 'voice' ? '🎤 Voice note' : String(latest?.text || existing?.previewText || '').trim(),
      lastAt: latest?.createdAt || existing?.lastAt || null,
      lastSenderUserId: latest?.senderUserId || existing?.lastSenderUserId || null,
      unreadCount: Number(privateUnreadByUserId[uid] || 0),
      raw: existing?.raw || latest?.raw || null,
    };
    privateThreads = [next, ...privateThreads.filter((thread) => privateThreadUserId(thread) !== uid)]
      .sort((a, b) => String(privateThreadTime(b)).localeCompare(String(privateThreadTime(a))));
  }

  function syncPrivateThreadMeta(userId, displayName = '') {
    const uid = String(userId || '');
    if (!uid) return;
    const idx = privateThreads.findIndex((thread) => privateThreadUserId(thread) === uid);
    if (idx === -1) {
      privateThreads.unshift({
        otherUserId: uid,
        displayName: String(displayName || 'Driver').trim() || 'Driver',
        avatarUrl: '',
        previewText: '',
        lastAt: null,
        lastSenderUserId: null,
        unreadCount: Number(privateUnreadByUserId[uid] || 0),
        raw: null,
      });
      return;
    }
    const existing = privateThreads[idx];
    privateThreads[idx] = {
      ...existing,
      displayName: String(displayName || existing.displayName || 'Driver').trim() || 'Driver',
      unreadCount: Number(privateUnreadByUserId[uid] || 0),
    };
  }

  async function chatFetchPrivateThreads() {
    const token = getCommunityToken();
    if (!token) return [];
    try {
      privateThreadAbortController = replaceAbortController(privateThreadAbortController, new AbortController());
      const data = await getJSONAuth('/chat/private/threads', token, { signal: privateThreadAbortController.signal });
      const list = Array.isArray(data) ? data : (Array.isArray(data?.threads) ? data.threads : []);
      return list.map(normalizePrivateThread).filter((thread) => !!thread.otherUserId);
    } catch (err) {
      if (err?.name === 'AbortError') return [];
      console.warn('chatFetchPrivateThreads failed', err);
      return [];
    }
  }

  async function chatFetchPrivateMessages(otherUserId, { limit = 50, sinceId = null, markRead = true, signal = null, supersede = false } = {}) {
    const token = getCommunityToken();
    if (!token || !otherUserId) return [];
    const uid = encodeURIComponent(String(otherUserId));
    const qs = new URLSearchParams();
    qs.set('limit', String(limit));
    qs.set('mark_read', markRead ? 'true' : 'false');
    if (sinceId !== null && sinceId !== undefined && String(sinceId).trim() !== '') {
      qs.set('since_id', String(sinceId));
    }
    let requestSignal = signal;
    if (!requestSignal && supersede) {
      const nextController = new AbortController();
      const previousController = privateMessageAbortControllers.get(uid);
      abortControllerSafe(previousController);
      privateMessageAbortControllers.set(uid, nextController);
      requestSignal = nextController.signal;
    }
    try {
      const data = await getJSONAuth(`/chat/private/${uid}?${qs.toString()}`, token, requestSignal ? { signal: requestSignal } : {});
      return normalizePrivateMessagesPayload(data);
    } catch (err) {
      if (err?.name === 'AbortError') return [];
      throw err;
    }
  }

  async function chatSendPrivateMessage(otherUserId, payload) {
    const token = getCommunityToken();
    if (!token || !otherUserId) throw new Error('Private chat unavailable');
    const uid = encodeURIComponent(String(otherUserId));
    if (typeof payload === 'string') {
      return await postJSON(`/chat/private/${uid}`, { text: payload }, token);
    }
    return await postJSON(`/chat/private/${uid}`, payload || {}, token);
  }

  async function chatSendPublicVoiceNote(blob, durationMs, mimeType, room = CHAT_ROOM) {
    const token = getCommunityToken();
    if (!token) throw new Error('Not signed in');
    return await postChatVoiceMultipart(
      `/chat/rooms/${encodeURIComponent(String(room || CHAT_ROOM))}/voice`,
      blob,
      durationMs,
      token,
      mimeType,
    );
  }

  async function chatSendPrivateVoiceNote(otherUserId, blob, durationMs, mimeType) {
    const token = getCommunityToken();
    if (!token || !otherUserId) throw new Error('Private chat unavailable');
    return await postChatVoiceMultipart(
      `/chat/private/${encodeURIComponent(String(otherUserId))}/voice`,
      blob,
      durationMs,
      token,
      mimeType,
    );
  }

  async function refreshVoiceUploadFallback(scope, options = {}) {
    const previousLatestId = parseMessageId(options.previousLatestId);
    const afterId = previousLatestId === null ? null : Math.max(0, previousLatestId - 1);
    if (scope === 'public') {
      const result = await chatFetchMessages({ after: afterId, limit: 20 });
      return result?.ok ? (result.messages || []) : [];
    }
    const uid = String(options.otherUserId || '');
    if (!uid) return [];
    return await chatFetchPrivateMessages(uid, {
      sinceId: afterId,
      limit: 20,
      markRead: options.markRead !== false,
    });
  }

  async function integrateUploadedVoiceMessage(scope, response, options = {}) {
    const normalized = scope === 'public'
      ? normalizePublicMessagesPayload(response)
      : normalizePrivateMessagesPayload(response);
    const completeMessages = normalized.filter(isCompleteVoiceMessage);
    let appliedMessages = normalized;
    if (!completeMessages.length) {
      const refreshed = await refreshVoiceUploadFallback(scope, options);
      if (refreshed.length) appliedMessages = refreshed;
    }
    if (!appliedMessages.length) return [];
    pruneExpiredChatState();
    if (scope === 'public') {
      const merged = upsertPublicChatMessages(appliedMessages);
      advanceChatWatermarksFromMessages(appliedMessages);
      renderChatMessages(merged, { replace: true });
      const latestVoice = appliedMessages.filter((msg) => msg.messageType === 'voice');
      if (latestVoice.length) void prefetchVoiceBlobUrls(latestVoice);
      if (isChatPanelOpen()) markChatReadThroughLatestLoaded();
      return merged;
    }
    const uid = String(options.otherUserId || '');
    const merged = mergePrivateMessages(uid, appliedMessages);
    privateUnreadByUserId[uid] = 0;
    privateUpsertThreadFromMessages(uid, merged, { displayName: options.displayName || privateActiveDisplayName || driverProfileState.displayName || '' });
    const latestVoice = appliedMessages.filter((msg) => msg.messageType === 'voice');
    if (latestVoice.length) void prefetchVoiceBlobUrls(latestVoice);
    return merged;
  }

  function renderPrivateThreadList() {
    pruneExpiredChatState();
    const wrap = document.getElementById('chatPrivateWrap');
    if (!wrap) return;
    const sorted = privateThreads.slice().sort((a, b) => String(privateThreadTime(b)).localeCompare(String(privateThreadTime(a))));
    const rows = sorted.map((thread) => {
      const uid = privateThreadUserId(thread);
      const name = privateThreadName(thread);
      const preview = privateThreadPreview(thread) || 'No messages yet';
      const unread = privateThreadUnreadCount(thread);
      const ts = formatChatTime(privateThreadTime(thread));
      const initials = name.slice(0, 2).toUpperCase();
      return `<button type="button" class="chatPrivateThreadRow" data-private-thread="${uid || ''}" data-private-name="${escapeHtml(name)}"><span class="chatPrivateThreadAvatar">${escapeHtml(initials)}</span><span class="chatPrivateThreadBody"><span class="chatPrivateThreadName">${escapeHtml(name)}</span><span class="chatPrivateThreadPreview">${escapeHtml(preview)}</span></span><span class="chatPrivateThreadMeta"><span class="chatPrivateThreadTime">${escapeHtml(ts)}</span>${unread > 0 ? `<span class="chatPrivateThreadUnread">${unread > 99 ? '99+' : unread}</span>` : ''}</span></button>`;
    }).join('');

    wrap.innerHTML = `<div class="chatPrivateThreadList"><div class="chatPrivateThreadToolbar"><button id="chatPrivateNewMessageBtn" class="chipBtn" type="button">New Message</button></div>${rows || '<div class="chatEmpty">No private conversations yet</div>'}</div>`;

    wrap.querySelectorAll('[data-private-thread]').forEach((btn) => {
      btn.addEventListener('click', () => openPrivateConversation(btn.getAttribute('data-private-thread'), btn.getAttribute('data-private-name') || ''));
    });
    const newBtn = document.getElementById('chatPrivateNewMessageBtn');
    if (newBtn) newBtn.addEventListener('click', promptNewPrivateMessageThread);
  }

  function renderPrivateConversationMessages(messages) {
    return (messages || []).map((msg) => renderPrivateConversationRow(msg, 'private')).join('');
  }

  function bindPrivateConversationComposer(userId) {
    const sendBtn = document.getElementById('chatPrivateSendBtn');
    const input = document.getElementById('chatPrivateInput');
    if (sendBtn && sendBtn.dataset.boundUserId === String(userId || '')) return;
    if (sendBtn) sendBtn.dataset.boundUserId = String(userId || '');
    if (input) input.dataset.boundUserId = String(userId || '');
    const sendNow = async () => {
      if (chatVoiceState.scope === 'private' && isChatVoiceBusy()) return;
      if (hasChatVoiceDraft('private')) {
        sendBtn.disabled = true;
        try {
          await sendChatVoiceDraft('private', {
            userId,
            onUploaded: async (response) => {
              const previousLatestId = privateLastMessageIdByUserId[String(userId)] || null;
              const merged = await integrateUploadedVoiceMessage('private', response, { previousLatestId, otherUserId: userId, markRead: true, displayName: privateActiveDisplayName });
              if (!merged.length) await chatPollPrivateActiveThread({ visible: true, forceFull: false });
              renderPrivateConversation();
              renderPrivateTabUnread();
              updateChatUnreadBadge();
              await playChatTone('outgoing');
            },
          });
        } catch (err) {
          console.warn('private voice send failed', err);
          alert(err?.message || 'Voice note failed to send.');
        } finally {
          syncVoiceComposerSendButton('private');
        }
        return;
      }
      const text = String(input?.value || '').trim();
      if (!text || !userId || !sendBtn) return;
      sendBtn.disabled = true;
      try {
        await primeChatSoundSystem('private-send-click');
        const response = await chatSendPrivateMessage(userId, { text });
        rememberOutgoingDmEcho(text);
        const sent = normalizePrivateMessagesPayload(response);
        if (sent.length) mergePrivateMessages(userId, sent);
        else await chatPollPrivateActiveThread({ visible: true, forceFull: false });
        if (input) input.value = '';
        privateUnreadByUserId[String(userId)] = 0;
        privateUpsertThreadFromMessages(userId, privateMessagesByUserId[String(userId)] || sent, { displayName: privateActiveDisplayName });
        renderPrivateConversation();
        renderPrivateTabUnread();
        updateChatUnreadBadge();
        await playChatTone('outgoing');
      } catch (err) {
        console.warn('private send failed', err);
        alert(err?.message || 'Message failed to send.');
      } finally {
        syncVoiceComposerSendButton('private');
      }
    };
    sendBtn?.addEventListener('click', sendNow);
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendNow();
      }
    });
    bindVoiceComposerControls('private', () => ({
      userId,
      onUploaded: async (response) => {
        const previousLatestId = privateLastMessageIdByUserId[String(userId)] || null;
        const merged = await integrateUploadedVoiceMessage('private', response, { previousLatestId, otherUserId: userId, markRead: true, displayName: privateActiveDisplayName });
        if (!merged.length) await chatPollPrivateActiveThread({ visible: true, forceFull: false });
        renderPrivateConversation();
        renderPrivateTabUnread();
        updateChatUnreadBadge();
        await playChatTone('outgoing');
      },
    }));
  }

  function renderPrivateConversation() {
    const wrap = document.getElementById('chatPrivateWrap');
    if (!wrap || !privateActiveUserId) return;
    const prevList = document.getElementById('chatPrivateConversationList');
    const preserveScrollTop = prevList ? prevList.scrollTop : 0;
    const shouldStickToBottom = isChatNearBottom(prevList, 80);
    pruneExpiredChatState();
    const messages = privateMessagesByUserId[privateActiveUserId] || [];
    if (!wrap.querySelector('.chatPrivateConversation')) {
      wrap.innerHTML = `<div class="chatPrivateConversation"><div class="chatPrivateHeader"><button id="chatPrivateBackBtn" class="chatPrivateBackBtn" type="button">Back</button><div class="chatPrivateTitle">${escapeHtml(privateActiveDisplayName || 'Private chat')}</div></div><div id="chatPrivateConversationList" class="chatList"></div><div class="chatComposer chatComposerPrivate"><input id="chatPrivateInput" type="text" class="chatInput" placeholder="Message privately…" maxlength="600"><button id="chatPrivateSendBtn" class="chipBtn" type="button">Send</button></div>${buildVoiceComposer('private', 'chatVoiceComposerPrivate')}</div>`;
    } else {
      const titleEl = wrap.querySelector('.chatPrivateTitle');
      if (titleEl) titleEl.textContent = privateActiveDisplayName || 'Private chat';
    }
    const list = document.getElementById('chatPrivateConversationList');
    void preserveVoicePlaybackAcrossRender(() => {
      reconcileMessageList(list, messages, {
        scope: 'private',
        rowRenderer: renderPrivateConversationRow,
        replace: true,
        emptyHtml: '<div class="chatEmpty">No messages yet.</div>',
      });
    });
    if (list) {
      if (shouldStickToBottom || !prevList) list.scrollTop = list.scrollHeight;
      else list.scrollTop = preserveScrollTop;
    }
    const backBtn = document.getElementById('chatPrivateBackBtn');
    if (backBtn && backBtn.dataset.bound !== '1') {
      backBtn.dataset.bound = '1';
      backBtn.addEventListener('click', () => {
        if (chatVoiceState.scope === 'private') cancelChatVoiceRecording('Recording canceled');
        privateActiveUserId = null;
        privateActiveDisplayName = '';
        renderPrivateThreadList();
      });
    }
    bindPrivateConversationComposer(privateActiveUserId);
    bindVoicePlayers(wrap);
    void prefetchVoiceBlobUrls(messages.filter((msg) => msg?.messageType === 'voice'));
  }

  function updateDriverProfileDmList(messages = driverProfileState.messages || []) {
    pruneExpiredChatState();
    const dmList = document.getElementById('driverProfileDmList');
    if (!dmList) return false;
    const previousScrollTop = dmList.scrollTop;
    const nearBottom = isChatNearBottom(dmList, 80);
    void preserveVoicePlaybackAcrossRender(() => {
      reconcileMessageList(dmList, messages, {
        scope: 'profile-dm',
        rowRenderer: (message) => renderPrivateConversationRow(message, 'profile-dm'),
        replace: true,
        emptyHtml: '<div class="driverProfileStatus">No private messages yet.</div>',
      });
    });
    bindVoicePlayers(dmList);
    void prefetchVoiceBlobUrls((messages || []).filter((msg) => msg?.messageType === 'voice'));
    if (nearBottom) dmList.scrollTop = dmList.scrollHeight;
    else dmList.scrollTop = previousScrollTop;
    return true;
  }

  async function openPrivateConversation(userId, displayName = '', options = {}) {
    if (!userId) return;
    if (chatVoiceState.scope === 'private' && chatVoiceState.otherUserId && String(chatVoiceState.otherUserId) !== String(userId)) {
      cancelChatVoiceRecording('Recording canceled');
    }
    const uid = String(userId);
    privateActiveUserId = uid;
    privateActiveDisplayName = String(displayName || privateActiveDisplayName || privateThreads.find((thread) => thread.otherUserId === uid)?.displayName || 'Driver').trim() || 'Driver';
    privateUnreadByUserId[uid] = 0;
    syncPrivateThreadMeta(uid, privateActiveDisplayName);
    updateChatUnreadBadge();
    const messages = await chatFetchPrivateMessages(uid, { limit: options.limit || 60, markRead: options.markRead !== false, sinceId: null, supersede: true });
    privateMessagesByUserId[uid] = upsertChatMessages([], messages);
    pruneVoiceAssetCache();
    const latestId = messages.reduce((max, msg) => Math.max(max, Number(msg?.id || 0)), 0);
    privateLastMessageIdByUserId[uid] = latestId || null;
    privateUpsertThreadFromMessages(uid, messages, { displayName: privateActiveDisplayName });
    renderPrivateConversation();
    renderPrivateTabUnread();
    updateChatUnreadBadge();
  }

  async function chatRefreshPrivateThreads() {
    const threads = await chatFetchPrivateThreads();
    privateBackendThreadIds = new Set((Array.isArray(threads) ? threads : []).map((thread) => privateThreadUserId(thread)).filter(Boolean));
    const nextById = new Map();
    threads.forEach((thread) => {
      const uid = privateThreadUserId(thread);
      if (!uid) return;
      const unread = activeChatTab === 'private' && isChatPanelOpen() && privateActiveUserId === uid ? 0 : Number(thread.unreadCount || 0);
      privateUnreadByUserId[uid] = Math.max(0, unread);
      nextById.set(uid, { ...thread, unreadCount: privateUnreadByUserId[uid] });
    });
    privateThreads.forEach((thread) => {
      const uid = privateThreadUserId(thread);
      if (!uid) return;
      if (!nextById.has(uid)) nextById.set(uid, { ...thread, unreadCount: Number(privateUnreadByUserId[uid] || 0) });
    });
    privateThreads = Array.from(nextById.values()).sort((a, b) => String(privateThreadTime(b)).localeCompare(String(privateThreadTime(a))));
    pruneExpiredChatState();
    renderPrivateTabUnread();
    if (activeChatTab === 'private' && !privateActiveUserId) renderPrivateThreadList();
    updateChatUnreadBadge();
  }

  async function chatPollPrivateActiveThread({ visible = activeChatTab === 'private' && isChatPanelOpen(), forceFull = false } = {}) {
    if (!privateActiveUserId) return;
    const uid = String(privateActiveUserId);
    const sinceId = forceFull ? null : (privateLastMessageIdByUserId[uid] || null);
    const incoming = await chatFetchPrivateMessages(uid, { limit: forceFull ? 60 : 30, sinceId, markRead: !!visible, supersede: true });
    if (!incoming.length && visible) {
      privateUnreadByUserId[uid] = 0;
      renderPrivateTabUnread();
      updateChatUnreadBadge();
      return;
    }
    const previousLast = Number(privateLastMessageIdByUserId[uid] || 0);
    const merged = forceFull ? incoming.slice() : mergePrivateMessages(uid, incoming);
    pruneExpiredChatState();
    if (forceFull) {
      privateMessagesByUserId[uid] = upsertChatMessages([], merged);
      pruneExpiredChatState();
      pruneVoiceAssetCache();
    }
    const latestId = (privateMessagesByUserId[uid] || merged || []).reduce((max, msg) => Math.max(max, Number(msg?.id || 0)), 0);
    privateLastMessageIdByUserId[uid] = latestId || privateLastMessageIdByUserId[uid] || null;
    const unseenIncoming = incoming.filter((msg) => !msg.isOwn && Number(msg?.id || 0) > previousLast);
    if (visible) {
      privateUnreadByUserId[uid] = 0;
    } else if (unseenIncoming.length) {
      privateUnreadByUserId[uid] = Number(privateUnreadByUserId[uid] || 0) + unseenIncoming.length;
      if (collectFreshIncomingDriverProfileDm(incoming).length > 0) void playChatTone('incoming');
    }
    privateUpsertThreadFromMessages(uid, privateMessagesByUserId[uid] || merged, { displayName: privateActiveDisplayName });
    if (activeChatTab === 'private' && privateActiveUserId === uid) renderPrivateConversation();
    renderPrivateTabUnread();
    updateChatUnreadBadge();
  }

  function renderPrivateTabUnread() {
    const tabUnread = document.getElementById('chatPrivateTabUnread');
    const count = Object.values(privateUnreadByUserId).reduce((acc, n) => acc + (Number(n) || 0), 0);
    if (tabUnread) {
      tabUnread.textContent = count > 0 ? (count > 99 ? '99+' : String(count)) : '';
      tabUnread.classList.toggle('show', count > 0);
    }
  }

  function switchChatTab(nextTab) {
    const upcomingTab = nextTab === 'private' ? 'private' : 'public';
    if (chatVoiceState.scope === 'public' && upcomingTab !== 'public') cancelChatVoiceRecording('Recording canceled');
    if (chatVoiceState.scope === 'private' && upcomingTab !== 'private') cancelChatVoiceRecording('Recording canceled');
    activeChatTab = upcomingTab;
    const publicView = document.getElementById('chatPublicView');
    const publicComposer = document.getElementById('chatPublicComposer');
    const privateView = document.getElementById('chatPrivateView');
    const publicBtn = document.getElementById('chatTabPublic');
    const privateBtn = document.getElementById('chatTabPrivate');
    if (publicView) publicView.classList.toggle('hidden', activeChatTab !== 'public');
    if (publicComposer) publicComposer.classList.toggle('hidden', activeChatTab !== 'public');
    if (privateView) privateView.classList.toggle('hidden', activeChatTab !== 'private');
    if (publicBtn) {
      publicBtn.classList.toggle('active', activeChatTab === 'public');
      publicBtn.setAttribute('aria-selected', String(activeChatTab === 'public'));
    }
    if (privateBtn) {
      privateBtn.classList.toggle('active', activeChatTab === 'private');
      privateBtn.setAttribute('aria-selected', String(activeChatTab === 'private'));
    }
    if (activeChatTab === 'private') {
      if (privateActiveUserId) {
        renderPrivateConversation();
        chatPollPrivateActiveThread({ visible: true, forceFull: false }).catch((err) => console.warn('private conversation refresh failed', err));
      } else {
        renderPrivateThreadList();
      }
      chatRefreshPrivateThreads();
    }
    renderPrivateTabUnread();
  }

  function promptNewPrivateMessageThread() {
    const known = [];
    if (Array.isArray(window.lastDrivers) && window.lastDrivers.length) known.push(...window.lastDrivers);
    if (Array.isArray(window.visibleDrivers) && window.visibleDrivers.length) known.push(...window.visibleDrivers);
    if (Array.isArray(window.drivers) && window.drivers.length) known.push(...window.drivers);
    const meId = window?.me?.id != null ? String(window.me.id) : '';
    const candidates = [];
    const seen = new Set();
    for (const drv of known) {
      const id = drv?.id != null ? String(drv.id) : '';
      if (!id || id === meId || seen.has(id)) continue;
      seen.add(id);
      candidates.push({ id, name: String(drv?.display_name || drv?.name || `Driver ${id}`).trim() || `Driver ${id}` });
    }
    if (!candidates.length) {
      alert('No active drivers available yet.');
      return;
    }
    const sample = candidates.slice(0, 12).map((c, i) => `${i + 1}. ${c.name}`).join('\n');
    const input = window.prompt(`Start a new message with\n${sample}\n\nEnter number or user ID:`);
    if (!input) return;
    const trimmed = String(input).trim();
    const idx = Number(trimmed);
    const picked = Number.isFinite(idx) && idx >= 1 && idx <= candidates.length
      ? candidates[idx - 1]
      : candidates.find((c) => c.id === trimmed);
    if (!picked) return;
    privateActiveDisplayName = picked.name;
    openPrivateConversation(picked.id, picked.name);
  }

  function getPrivatePollIntervalMs() {
    if (document.visibilityState === 'hidden') return isChatLiveConnected('private') ? CHAT_LIVE_CONNECTED_PRIVATE_HIDDEN_POLL_MS : PRIVATE_CHAT_HIDDEN_POLL_MS;
    if (isChatPanelOpen()) return isChatLiveConnected('private') ? CHAT_LIVE_CONNECTED_PRIVATE_OPEN_POLL_MS : PRIVATE_CHAT_OPEN_POLL_MS;
    return isChatLiveConnected('private') ? CHAT_LIVE_CONNECTED_PRIVATE_CLOSED_POLL_MS : PRIVATE_CHAT_CLOSED_POLL_MS;
  }

  function schedulePrivatePoll({ immediate = false } = {}) {
    if (runtimePolling) runtimePolling.clear('chat:private-poll');
    if (privateThreadPollTimer) clearTimeout(privateThreadPollTimer);
    if (!isChatAuthReady()) {
      privateThreadPollTimer = null;
      return;
    }
    const delay = immediate ? 0 : getPrivatePollIntervalMs();
    bumpChatPollStat(document.visibilityState === 'hidden' ? 'private_hidden' : (isChatPanelOpen() ? 'private_open' : 'private_closed'));
    const runner = async () => {
      privateThreadPollTimer = null;
      if (privateThreadPollInFlight) return;
      privateThreadPollInFlight = true;
      try {
        if (!isChatAuthReady()) return;
        await chatRefreshPrivateThreads();
        if (privateActiveUserId) {
          const visible = activeChatTab === 'private' && isChatPanelOpen();
          await chatPollPrivateActiveThread({ visible, forceFull: false });
        }
      } finally {
        privateThreadPollInFlight = false;
        if (isChatAuthReady()) schedulePrivatePoll();
      }
    };
    if (runtimePolling) {
      privateThreadPollTimer = runtimePolling.setTimeout('chat:private-poll', runner, Math.max(0, delay));
      return;
    }
    privateThreadPollTimer = setTimeout(runner, Math.max(0, delay));
  }

  function startPrivatePolling() {
    schedulePrivatePoll({ immediate: true });
  }

  function stopPrivatePolling() {
    if (runtimePolling) runtimePolling.clear('chat:private-poll');
    if (!privateThreadPollTimer) return;
    clearTimeout(privateThreadPollTimer);
    privateThreadPollTimer = null;
  }
  function chatResetState() {
    teardownChatLiveRuntime('chat-reset');
    void cancelChatVoiceRecording('Recording canceled');
    clearChatVoiceDraft('reset');
    chatLastSeen = null;
    chatLatestMessageId = null;
    publicChatMessages = [];
    revokeVoiceBlobUrls();
    chatLastReadId = loadChatLastReadId();
    chatSeenKeys = new Set();
    unreadChatCount = 0;
    privateThreads = [];
    privateBackendThreadIds = new Set();
    privateActiveUserId = null;
    privateActiveDisplayName = '';
    privateMessagesByUserId = Object.create(null);
    privateUnreadByUserId = Object.create(null);
    privateLastMessageIdByUserId = Object.create(null);
    updateChatUnreadBadge();
    chatSoundRuntime.lastObservedIncomingId = null;
    chatSoundRuntime.seenIncomingKeys = new Set();
    chatSoundRuntime.dmBaselineReady = false;
    chatSoundState.baselineReady = false;
    chatHiddenBaselineReady = false;
    killFeedBootstrapReady = false;
    killFeedBootstrapPollConsumed = false;
  }

  function seedKillFeedSeenKeys(msgs) {
    if (!Array.isArray(msgs) || !msgs.length) return;
    for (const msg of msgs) {
      killFeedSeenKeys.add(chatMsgKey(msg));
    }
  }

  // Render messages and manage scroll position
  function renderChatMessages(messages, { replace = false } = {}) {
    pruneExpiredChatState();
    const listEl = document.getElementById('chatList');
    if (!listEl) return;
    const nextMessages = Array.isArray(messages) ? messages.map((msg) => normalizePublicChatMessage(msg)) : [];
    if (!nextMessages.length) {
      if (replace) {
        chatSeenKeys = new Set();
        listEl.innerHTML = '';
        listEl.dataset.hasMessages = '0';
        setChatStatus('No messages yet.');
      }
      return;
    }
    const nearBottom = isChatNearBottom(listEl, 80);
    void preserveVoicePlaybackAcrossRender(() => {
      if (replace) chatSeenKeys = new Set();
      reconcileMessageList(listEl, nextMessages, {
        scope: 'public',
        rowRenderer: renderPublicMessageRow,
        replace,
      });
    });
    nextMessages.forEach((msg) => {
      const key = chatMsgKey(msg);
      chatSeenKeys.add(key);
      const cursor = chatMsgCursor(msg);
      if (cursor !== null && cursor !== undefined) chatLastSeen = cursor;
      const id = messageNumericId(msg);
      if (id !== null) chatLatestMessageId = chatLatestMessageId === null ? id : Math.max(chatLatestMessageId, id);
    });
    bindVoicePlayers(listEl);
    void prefetchVoiceBlobUrls(nextMessages.filter((msg) => msg.messageType === 'voice'));
    if (nearBottom || replace) listEl.scrollTop = listEl.scrollHeight;
  }


  async function chatFetchMessages({ after = null, limit = 50 } = {}) {
    const token = getCommunityToken();
    if (!token) return { ok: false, reason: 'not_ready' };
    const qs = new URLSearchParams();
    qs.set('limit', String(limit));
    if (after !== null && after !== undefined && String(after).trim() !== '') {
      qs.set('after', String(after));
    }
    try {
      chatPollAbortController = replaceAbortController(chatPollAbortController, new AbortController());
      const data = await getJSONAuth(`/chat/rooms/${CHAT_ROOM}?${qs.toString()}`, token, { signal: chatPollAbortController.signal });
      return { ok: true, messages: normalizePublicMessagesPayload(data) };
    } catch (err) {
      if (err?.name === 'AbortError') return { ok: false, reason: 'aborted' };
      console.warn('chatFetchMessages failed', err);
      return { ok: false, reason: 'failed', error: err };
    }
  }

  async function chatLoadInitial() {
    chatInitialHistoryLoadAttempted = true;
    const result = await chatFetchMessages({ limit: 60 });
    if (!result?.ok) {
      if (result?.reason === 'not_ready') setChatStatus('Loading chat...');
      else setChatStatus('Chat unavailable right now.');
      return { ok: false, messages: [] };
    }
    const msgs = setPublicChatMessages(Array.isArray(result.messages) ? result.messages : []);
    seedChatIncomingAudioBaseline(msgs);
    renderChatMessages(msgs, { replace: true });
    chatInitialHistoryLoaded = true;
    chatHiddenBaselineReady = true;
    chatInitialHistoryRetryQueued = false;
    seedKillFeedSeenKeys(msgs);
    killFeedBootstrapReady = true;
    if (!maybeInitializeChatReadBaseline()) rebuildUnreadBadgeFromMessages(msgs);
    return { ok: true, messages: msgs };
  }

  async function chatFetchIncremental({ panelOpen = isChatPanelOpen() } = {}) {
    const cursor = panelOpen ? chatLastSeen : (chatLatestMessageId ?? chatLastSeen);
    const limit = panelOpen ? 50 : (chatHiddenBaselineReady ? 12 : 1);
    return chatFetchMessages({ after: cursor, limit });
  }

  async function chatSend(text) {
    const token = getCommunityToken();
    if (!token) throw new Error('Not signed in');
    return postJSON(`/chat/rooms/${CHAT_ROOM}`, { text }, token);
  }

  async function chatPollOnce() {
    if (chatPollInFlight) return;
    if (typeof authHeaderOK === 'function' && !authHeaderOK()) return;
    chatPollInFlight = true;
    try {
      const panelOpen = isChatPanelOpen();
      if (panelOpen && !chatInitialHistoryLoaded) {
        await chatLoadInitial();
        return;
      }
      const msgs = await chatFetchIncremental({ panelOpen });
      if (!msgs?.ok) {
        if (panelOpen && !chatInitialHistoryLoaded) setChatStatus(msgs?.reason === 'not_ready' ? 'Loading chat...' : 'Chat unavailable right now.');
        return;
      }
      const loadedMsgs = Array.isArray(msgs.messages) ? msgs.messages : [];
      if (!panelOpen && !chatHiddenBaselineReady) {
        const baselineMsgs = loadedMsgs.length ? upsertPublicChatMessages(loadedMsgs) : publicChatMessages;
        pruneExpiredChatState();
        advanceChatWatermarksFromMessages(loadedMsgs);
        if (!chatSoundState.baselineReady) seedChatIncomingAudioBaseline(baselineMsgs);
        if (!killFeedBootstrapReady) {
          seedKillFeedSeenKeys(baselineMsgs);
          killFeedBootstrapReady = true;
          killFeedBootstrapPollConsumed = true;
        }
        chatHiddenBaselineReady = true;
        if (!maybeInitializeChatReadBaseline()) rebuildUnreadBadgeFromMessages(baselineMsgs);
        return;
      }
      const mergedMsgs = loadedMsgs.length ? upsertPublicChatMessages(loadedMsgs) : publicChatMessages;
      pruneExpiredChatState();
      advanceChatWatermarksFromMessages(loadedMsgs);
      const hadIncomingAudioBaseline = chatSoundState.baselineReady;
      const freshIncoming = hadIncomingAudioBaseline ? collectFreshIncomingMessagesForAudio(loadedMsgs) : [];
      if (freshIncoming.length > 0) void playChatTone('incoming');
      if (!hadIncomingAudioBaseline && loadedMsgs.length) seedChatIncomingAudioBaseline(loadedMsgs);
      if (!killFeedBootstrapReady) {
        seedKillFeedSeenKeys(loadedMsgs);
        killFeedBootstrapReady = true;
        killFeedBootstrapPollConsumed = true;
      }
      if (panelOpen) {
        renderChatMessages(mergedMsgs, { replace: true });
        markChatReadThroughLatestLoaded();
        if (killFeedContainer) killFeedContainer.style.display = 'none';
      } else {
        if (killFeedContainer) killFeedContainer.style.display = 'flex';
        if (killFeedBootstrapReady && !killFeedBootstrapPollConsumed) {
          seedKillFeedSeenKeys(loadedMsgs);
          killFeedBootstrapPollConsumed = true;
        } else if (killFeedBootstrapReady && killFeedBootstrapPollConsumed) {
          showKillFeed(loadedMsgs);
        }
      }
    } catch (e) {
      console.warn('chat poll failed:', e);
      bumpChatErrorStat();
    } finally {
      chatPollInFlight = false;
      if (typeof authHeaderOK === 'function' && authHeaderOK()) scheduleChatPoll();
    }
  }
  function getChatPollIntervalMs() {
    if (document.visibilityState === 'hidden') {
      return isChatLiveConnected('public') ? CHAT_LIVE_CONNECTED_PUBLIC_HIDDEN_POLL_MS : CHAT_HIDDEN_POLL_MS;
    }
    if (isChatPanelOpen()) return isChatLiveConnected('public') ? CHAT_LIVE_CONNECTED_PUBLIC_OPEN_POLL_MS : CHAT_POLL_MS;
    return isChatLiveConnected('public') ? CHAT_LIVE_CONNECTED_PUBLIC_CLOSED_POLL_MS : CHAT_CLOSED_POLL_MS;
  }
  function scheduleChatPoll({ immediate = false } = {}) {
    if (runtimePolling) runtimePolling.clear('chat:public-poll');
    if (chatPollTimer) clearTimeout(chatPollTimer);
    if (typeof authHeaderOK === 'function' && !authHeaderOK()) {
      chatPollTimer = null;
      return;
    }
    const delay = immediate ? 0 : getChatPollIntervalMs();
    bumpChatPollStat(document.visibilityState === 'hidden' ? 'public_hidden' : (isChatPanelOpen() ? 'public_open' : 'public_closed'));
    const runner = () => {
      chatPollTimer = null;
      chatPollOnce();
    };
    if (runtimePolling) {
      chatPollTimer = runtimePolling.setTimeout('chat:public-poll', runner, Math.max(0, delay));
      return;
    }
    chatPollTimer = setTimeout(runner, Math.max(0, delay));
  }
  function startChatPolling() {
    if (typeof authHeaderOK === 'function' && !authHeaderOK()) return;
    scheduleChatPoll({ immediate: true });
  }
  function stopChatPolling() {
    if (runtimePolling) runtimePolling.clear('chat:public-poll');
    if (!chatPollTimer) return;
    clearTimeout(chatPollTimer);
    chatPollTimer = null;
  }
  function syncChatPollingState() {
    if (typeof authHeaderOK === 'function' && authHeaderOK()) {
      startChatPolling();
      startPrivatePolling();
      ensureChatLiveTransports().catch(() => {});
      if (!isChatPanelOpen() && (chatVoiceState.scope === 'public' || chatVoiceState.scope === 'private')) {
        cancelChatVoiceRecording('Recording canceled');
      }
      if (isChatPanelOpen() && chatInitialHistoryLoadAttempted && !chatInitialHistoryLoaded && !chatInitialHistoryRetryQueued) {
        chatInitialHistoryRetryQueued = true;
        chatLoadInitial().catch((e) => {
          console.warn('chat initial retry failed:', e);
          setChatStatus('Chat unavailable right now.');
        }).finally(() => {
          chatInitialHistoryRetryQueued = false;
        });
      }
    } else {
      cancelChatVoiceRecording('Recording canceled');
      teardownChatLiveRuntime('auth-missing');
      stopChatPolling();
      stopPrivatePolling();
    }
  }

  // Wire up the chat panel: event handlers, initial load, polling
  function wireChatPanel() {
    pruneExpiredChatState();
    ensureChatNotificationsBootstrapped('chat-panel-open');
    scheduleChatPoll({ immediate: true });
    schedulePrivatePoll({ immediate: true });
    const tabPublic = document.getElementById('chatTabPublic');
    const tabPrivate = document.getElementById('chatTabPrivate');
    if (tabPublic && tabPublic.dataset.bound !== '1') {
      tabPublic.dataset.bound = '1';
      tabPublic.addEventListener('click', () => switchChatTab('public'));
    }
    if (tabPrivate && tabPrivate.dataset.bound !== '1') {
      tabPrivate.dataset.bound = '1';
      tabPrivate.addEventListener('click', () => switchChatTab('private'));
    }

    const chatInput = document.getElementById('chatInput');
    const chatSendBtn = document.getElementById('chatSendBtn');
    if (!chatInput || !chatSendBtn) return;
    chatInput.style.fontSize = '16px';
    chatInput.setAttribute('autocapitalize', 'sentences');
    chatInput.setAttribute('autocomplete', 'off');
    chatInput.setAttribute('autocorrect', 'on');
    chatInput.setAttribute('spellcheck', 'true');
    chatInput.setAttribute('enterkeyhint', 'send');
    const sendNow = async () => {
      if (chatVoiceState.scope === 'public' && isChatVoiceBusy()) return;
      if (hasChatVoiceDraft('public')) {
        chatSendBtn.disabled = true;
        try {
          await sendChatVoiceDraft('public', {
            room: CHAT_ROOM,
            onUploaded: async (response) => {
              const previousLatestId = chatLatestMessageId;
              const merged = await integrateUploadedVoiceMessage('public', response, { previousLatestId, room: CHAT_ROOM });
              if (Array.isArray(merged) && merged.length) seedChatIncomingAudioBaseline(merged);
              await playChatTone('outgoing');
              await chatPollOnce();
            },
          });
        } catch (e) {
          console.warn('voice draft send failed:', e);
          alert(e?.message || 'Voice note failed to send.');
        } finally {
          syncVoiceComposerSendButton('public');
        }
        return;
      }
      const textValue = String(chatInput.value || '').trim();
      if (!textValue) return;
      chatSendBtn.disabled = true;
      try {
        await primeChatSoundSystem('chat-send-click');
        await ensureChatNotificationsBootstrapped('chat-send-click');
        const msg = await chatSend(textValue);
        rememberOutgoingChatEcho(textValue);
        const sentMessages = normalizePublicMessagesPayload(msg);
        if (sentMessages.length > 0) {
          sentMessages.forEach(rememberOutgoingChatEcho);
          seedChatIncomingAudioBaseline(sentMessages);
          renderChatMessages(upsertPublicChatMessages(sentMessages), { replace: true });
        }
        chatInput.value = '';
        await playChatTone('outgoing');
        await chatPollOnce();
      } catch (e) {
        console.warn('chat send failed:', e);
        alert(e?.message || 'Message failed to send.');
      } finally {
        syncVoiceComposerSendButton('public');
      }
    };
    if (chatSendBtn.dataset.chatSendBound !== '1') {
      chatSendBtn.dataset.chatSendBound = '1';
      chatSendBtn.addEventListener('click', (e) => { e.preventDefault(); sendNow(); });
    }
    if (chatInput.dataset.chatEnterBound !== '1') {
      chatInput.dataset.chatEnterBound = '1';
      chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendNow(); } });
    }
    bindVoiceComposerControls('public', () => ({
      room: CHAT_ROOM,
      onUploaded: async (response) => {
        const previousLatestId = chatLatestMessageId;
        const merged = await integrateUploadedVoiceMessage('public', response, { previousLatestId, room: CHAT_ROOM });
        if (Array.isArray(merged) && merged.length) seedChatIncomingAudioBaseline(merged);
        await playChatTone('outgoing');
        await chatPollOnce();
      },
    }));
    bindVoicePlayers(document.getElementById('chatList') || document);

    chatLoadInitial()
      .then((result) => {
        if (result?.ok) return chatPollOnce();
        return null;
      })
      .catch((e) => {
        console.warn('chat initial load failed:', e);
        setChatStatus('Chat unavailable right now.');
      });
    syncChatPollingState();
    startPrivatePolling();
    chatRefreshPrivateThreads();
    switchChatTab(activeChatTab);

    markChatReadThroughLatestLoaded();
  }


  /* =========================================================
   MOVED TO app.part6.js
   Map Identity + Avatar Cropper module
   Search there for:
   - mapIdentityRenderSelfLabel
   - mapIdentityRenderDriverLabel
   - mapIdentityApplyZoomStyles
   - mapIdentityApplySelfOrbit
   - initMapIdentityProfileControls
   - clearMapIdentityTempState
   ========================================================= */

  function mapIdentityRenderSelfLabel(args = {}) { return window.TlcMapIdentityModule?.mapIdentityRenderSelfLabel?.(args) || ''; }
  function mapIdentityRenderDriverLabel(args = {}) { return window.TlcMapIdentityModule?.mapIdentityRenderDriverLabel?.(args) || ''; }
  function mapIdentityApplyZoomStyles(zoomValue) { return window.TlcMapIdentityModule?.mapIdentityApplyZoomStyles?.(zoomValue); }
  function mapIdentityApplySelfOrbit(orbitMeta) { return window.TlcMapIdentityModule?.mapIdentityApplySelfOrbit?.(orbitMeta); }
  function initMapIdentityProfileControls() { return window.TlcMapIdentityModule?.initMapIdentityProfileControls?.(); }
  function clearMapIdentityTempState() { return window.TlcMapIdentityModule?.clearMapIdentityTempState?.(); }

  function normalizeLeaderboardBadge(code) {
    const badge = String(code || '').trim().toLowerCase();
    if (badge === 'crown') return 'crown';
    if (badge === 'silver') return 'silver';
    if (badge === 'bronze') return 'bronze';
    return '';
  }

  function leaderboardBadgePriority(code) {
    const normalized = normalizeLeaderboardBadge(code);
    if (normalized === 'crown') return 3;
    if (normalized === 'silver') return 2;
    if (normalized === 'bronze') return 1;
    return 0;
  }

  function leaderboardBadgeMeta(code) {
    const normalized = normalizeLeaderboardBadge(code);
    if (!normalized) {
      return {
        code: '',
        label: '',
        rewardTitle: '',
        profileLabel: '',
        toneClass: ''
      };
    }
    if (normalized === 'crown') {
      return {
        code: 'crown',
        label: 'Crown',
        rewardTitle: '1st Place',
        profileLabel: 'Daily Miles Leader',
        toneClass: 'is-crown'
      };
    }
    if (normalized === 'silver') {
      return {
        code: 'silver',
        label: 'Silver',
        rewardTitle: '2nd Place',
        profileLabel: 'Silver Tier',
        toneClass: 'is-silver'
      };
    }
    return {
      code: 'bronze',
      label: 'Bronze',
      rewardTitle: '3rd Place',
      profileLabel: 'Bronze Tier',
      toneClass: 'is-bronze'
    };
  }

  function renderLeaderboardBadgeSvg(code, options = {}) {
    const meta = leaderboardBadgeMeta(code);
    if (!meta.code) return '';
    const size = Math.max(12, Number(options?.size) || (options?.compact ? 18 : 20));
    const classes = ['leaderboardBadgeSvg', meta.toneClass, options?.mapWearable ? 'is-map' : '', options?.compact ? 'is-compact' : '']
      .filter(Boolean)
      .join(' ');
    const title = escapeHtml(meta.label);
    let svg = '';
    if (meta.code === 'crown') {
      svg = `<svg class="${classes}" viewBox="0 0 72 56" width="${size}" height="${size}" role="img" aria-label="${title}" focusable="false">
        <defs>
          <linearGradient id="crownGoldMain" x1="10" y1="12" x2="61" y2="51" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#fff5c8"/>
            <stop offset="0.33" stop-color="#f2be4a"/>
            <stop offset="0.68" stop-color="#cb8f21"/>
            <stop offset="1" stop-color="#8a510f"/>
          </linearGradient>
          <linearGradient id="crownGoldShadow" x1="15" y1="20" x2="59" y2="43" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#8f5a15" stop-opacity="0.08"/>
            <stop offset="0.56" stop-color="#6f3d09" stop-opacity="0.34"/>
            <stop offset="1" stop-color="#4d2503" stop-opacity="0.42"/>
          </linearGradient>
          <linearGradient id="crownBandGold" x1="12" y1="44" x2="60" y2="54" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#f5df91"/>
            <stop offset="0.55" stop-color="#cf9022"/>
            <stop offset="1" stop-color="#7a460a"/>
          </linearGradient>
          <linearGradient id="crownBlueDiamond" x1="36" y1="30" x2="36" y2="47" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#91e5ff"/>
            <stop offset="0.42" stop-color="#2b97ff"/>
            <stop offset="1" stop-color="#1650b5"/>
          </linearGradient>
          <linearGradient id="crownRuby" x1="25" y1="36" x2="25" y2="42" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#ff7e95"/>
            <stop offset="0.48" stop-color="#df1338"/>
            <stop offset="1" stop-color="#8a0d22"/>
          </linearGradient>
          <linearGradient id="crownTeal" x1="16" y1="34" x2="16" y2="42" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#97f4ef"/>
            <stop offset="0.45" stop-color="#2abeb1"/>
            <stop offset="1" stop-color="#117f75"/>
          </linearGradient>
        </defs>
        <g id="crownBody">
          <path d="M11.2 43.8c1.5-10.5 6.4-20.8 12.8-21.8 1.8-.3 3.2.4 4.5 1.8L36 30.5l7.5-6.7c1.3-1.4 2.7-2.1 4.5-1.8 6.4 1 11.3 11.3 12.8 21.8H11.2Z" fill="url(#crownGoldMain)" stroke="#754208" stroke-width="2.1" stroke-linejoin="round"/>
          <path d="M13 43c4.2-1.2 8.2-5.9 10.5-13.4M59 43c-4.2-1.2-8.2-5.9-10.5-13.4" fill="none" stroke="rgba(255,242,176,.52)" stroke-width="1.5" stroke-linecap="round"/>
          <path d="M24.2 23c-.8 4.7.4 10.5 3.3 13.8h17c2.9-3.3 4.1-9.1 3.3-13.8" fill="url(#crownGoldShadow)"/>
        </g>
        <g id="crownBaseRim">
          <path d="M10.5 43.6h51a0 0 0 0 1 0 0v5.1c0 2.4-1.9 4.3-4.3 4.3H14.8c-2.4 0-4.3-1.9-4.3-4.3v-5.1a0 0 0 0 1 0 0Z" fill="url(#crownBandGold)" stroke="#6d3f08" stroke-width="2.2"/>
          <path d="M13.8 45.5c10.2-2.7 34.2-2.7 44.4 0" fill="none" stroke="rgba(255,248,216,.48)" stroke-width="1.4" stroke-linecap="round"/>
        </g>
        <g id="fleurDeLisGroup">
          <path d="M36 6.3c4.3 5 6.1 8.1 6.1 11.2 0 3.5-1.6 6.1-6.1 10.7-4.5-4.6-6.1-7.2-6.1-10.7 0-3.1 1.8-6.2 6.1-11.2Z" fill="url(#crownGoldMain)" stroke="#6f3d08" stroke-width="1.5"/>
          <path d="M35.9 27.6c-.2-4.8-.3-9.6.1-14.4" fill="none" stroke="rgba(255,241,176,.6)" stroke-width="1.2" stroke-linecap="round"/>
          <path d="M31.8 13.4c-4.2.3-7.1 2.5-9.2 7 4.2.3 7 1.7 8.8 4.8 2.2-3.3 2.6-7.3.4-11.8Z" fill="url(#crownGoldMain)" stroke="#6f3d08" stroke-width="1.4"/>
          <path d="M40.2 13.4c4.2.3 7.1 2.5 9.2 7-4.2.3-7 1.7-8.8 4.8-2.2-3.3-2.6-7.3-.4-11.8Z" fill="url(#crownGoldMain)" stroke="#6f3d08" stroke-width="1.4"/>
          <path d="M30.8 25.1c-1.5 2.3-1.4 4.4.2 6.7 2 .2 3.5-.4 4.8-2-.3-1.7-1.1-3.2-2.8-4.7h-2.2Z" fill="url(#crownGoldMain)" stroke="#764509" stroke-width="1.2"/>
          <path d="M41.2 25.1c1.5 2.3 1.4 4.4-.2 6.7-2 .2-3.5-.4-4.8-2 .3-1.7 1.1-3.2 2.8-4.7h2.2Z" fill="url(#crownGoldMain)" stroke="#764509" stroke-width="1.2"/>
          <path d="M36 25.6c1.5 1.5 2.1 3.2 1.8 5.6-.6 1-1.2 1.7-1.8 2.1-.6-.4-1.2-1.1-1.8-2.1-.3-2.4.3-4.1 1.8-5.6Z" fill="url(#crownGoldMain)" stroke="#764509" stroke-width="1.2"/>
          <path d="M31.4 23.8h9.2" stroke="#734308" stroke-width="1.1" stroke-linecap="round"/>
          <ellipse cx="32.9" cy="23.8" rx="1" ry="0.65" fill="#f4cb62"/><ellipse cx="35.2" cy="23.8" rx="1" ry="0.65" fill="#f4cb62"/><ellipse cx="37.4" cy="23.8" rx="1" ry="0.65" fill="#f4cb62"/><ellipse cx="39.1" cy="23.8" rx="1" ry="0.65" fill="#f4cb62"/>
        </g>
        <g id="leftTridentGroup">
          <path d="M16.2 16.5c.8 1.1.9 2.6.1 4.2-1.1.8-2 .8-2.8 0 1.4-2.3 1.8-3.7 2.7-4.2Zm3.1 0c-.4 2.5-.2 4.9.1 7.2m0-7.2c1.3.9 1.9 2.3 2.5 4.2-.8.8-1.7.8-2.8 0-.8-1.6-.7-3.1.3-4.2Z" fill="url(#crownGoldMain)" stroke="#6f3e08" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M16.3 20.8c.4 1.4 1.6 1.9 3.1 1.9s2.7-.5 3.1-1.9" fill="none" stroke="#734208" stroke-width="1"/>
          <path d="M19.4 22.6c1.3 1.4 1.7 4.7 1.2 9.6" fill="none" stroke="#714109" stroke-width="1.2" stroke-linecap="round"/>
        </g>
        <g id="rightTridentGroup">
          <path d="M55.8 16.5c-.8 1.1-.9 2.6-.1 4.2 1.1.8 2 .8 2.8 0-1.4-2.3-1.8-3.7-2.7-4.2Zm-3.1 0c.4 2.5.2 4.9-.1 7.2m0-7.2c-1.3.9-1.9 2.3-2.5 4.2.8.8 1.7.8 2.8 0 .8-1.6.7-3.1-.3-4.2Z" fill="url(#crownGoldMain)" stroke="#6f3e08" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M55.7 20.8c-.4 1.4-1.6 1.9-3.1 1.9s-2.7-.5-3.1-1.9" fill="none" stroke="#734208" stroke-width="1"/>
          <path d="M52.6 22.6c-1.3 1.4-1.7 4.7-1.2 9.6" fill="none" stroke="#714109" stroke-width="1.2" stroke-linecap="round"/>
        </g>
        <g id="centerBlueDiamond">
          <path d="M28 34.4 31.8 29h8.4l3.8 5.4-8 8.9-8-8.9Z" fill="url(#crownBlueDiamond)" stroke="#1d46a6" stroke-width="1.4" stroke-linejoin="round"/>
          <path d="M31.8 29 36 34.4 40.2 29m-12.2 5.4h16m-8 0v8.9" fill="none" stroke="rgba(212,242,255,.7)" stroke-width="1" stroke-linecap="round"/>
        </g>
        <g id="leftRedDiamond">
          <path d="M22.5 37.6 25 34.6l2.5 3-2.5 3.1-2.5-3.1Z" fill="url(#crownRuby)" stroke="#781022" stroke-width="1.1"/>
        </g>
        <g id="rightRedDiamond">
          <path d="M44.5 37.6 47 34.6l2.5 3-2.5 3.1-2.5-3.1Z" fill="url(#crownRuby)" stroke="#781022" stroke-width="1.1"/>
        </g>
        <g id="leftTealGem">
          <ellipse cx="16.5" cy="37.1" rx="2.15" ry="3" fill="url(#crownTeal)" stroke="#0f635a" stroke-width="1.1"/>
          <path d="M15.6 35.8c.5-.2.9-.2 1.5 0" stroke="rgba(218,255,250,.7)" stroke-width="0.8" stroke-linecap="round"/>
        </g>
        <g id="rightTealGem">
          <ellipse cx="55.5" cy="37.1" rx="2.15" ry="3" fill="url(#crownTeal)" stroke="#0f635a" stroke-width="1.1"/>
          <path d="M54.6 35.8c.5-.2.9-.2 1.5 0" stroke="rgba(218,255,250,.7)" stroke-width="0.8" stroke-linecap="round"/>
        </g>
      </svg>`;
    } else if (meta.code === 'silver') {
      svg = `<svg class="${classes}" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="${title}" focusable="false">
        <path d="M22 6h20l-2.4 14H24.4L22 6Z" fill="#e2e8f0" stroke="#475569" stroke-width="2.2"/>
        <path d="M24.5 20h15L35 29.5h-6L24.5 20Z" fill="#cbd5e1" stroke="#475569" stroke-width="2"/>
        <path d="M32 30 47 18v16c0 10.8-6.3 18.2-15 22-8.7-3.8-15-11.2-15-22V18L32 30Z" fill="#d1d9e6" stroke="#475569" stroke-width="2.8" stroke-linejoin="round"/>
        <circle cx="32" cy="36" r="8" fill="#f8fafc" stroke="#64748b" stroke-width="2.2"/>
        <path d="m28.4 36.2 2.3 2.5 4.8-5" fill="none" stroke="#64748b" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`;
    } else {
      svg = `<svg class="${classes}" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="${title}" focusable="false">
        <path d="M22 6h20l-2.4 14H24.4L22 6Z" fill="#f8d0a2" stroke="#6b3f1f" stroke-width="2.2"/>
        <path d="M24.5 20h15L35 29.5h-6L24.5 20Z" fill="#d89051" stroke="#6b3f1f" stroke-width="2"/>
        <path d="M32 30 47 18v16c0 10.8-6.3 18.2-15 22-8.7-3.8-15-11.2-15-22V18L32 30Z" fill="#ce8a51" stroke="#6b3f1f" stroke-width="2.8" stroke-linejoin="round"/>
        <circle cx="32" cy="36" r="8" fill="#f6cfaa" stroke="#7b4b27" stroke-width="2.2"/>
        <path d="M32 31v10M27 36h10" fill="none" stroke="#7b4b27" stroke-width="2.2" stroke-linecap="round"/>
      </svg>`;
    }
    if (!options?.withLabel) return svg;
    return `<span class="badgeSvgLabelWrap">${svg}<span class="badgeText">${escapeHtml(meta.label)}</span></span>`;
  }



  const CHESS_PIECE_SVGS = {
    P: '<path d="M50 22a10 10 0 1 1 0 20a10 10 0 0 1 0-20Zm0 23c-11 0-18 8-18 18h36c0-10-7-18-18-18Z"/>',
    N: '<path d="M34 69h34v-4H50l11-11-6-12-11-8-8 6 6 8-8 12v9Z"/><circle cx="54" cy="43" r="2.5" fill="currentColor"/>',
    B: '<path d="M50 22l7 7-7 7-7-7 7-7Zm0 17c-9 0-15 7-15 16h30c0-9-6-16-15-16Zm-18 27h36v5H32z"/>',
    R: '<path d="M35 27h6v8h6v-8h6v8h6v-8h6v13H35V27Zm3 15h24l-2 23H40l-2-23Zm-6 23h36v5H32z"/>',
    Q: '<path d="M35 33a4 4 0 1 1 0-8a4 4 0 0 1 0 8Zm15-3a4 4 0 1 1 0-8a4 4 0 0 1 0 8Zm15 3a4 4 0 1 1 0-8a4 4 0 0 1 0 8Z"/><path d="M33 36h34l-5 24H38l-5-24Zm-1 29h36v5H32z"/>',
    K: '<path d="M48 22h4v7h7v4h-7v7h-4v-7h-7v-4h7v-7Zm-14 20h32l-4 22H38l-4-22Zm-2 23h36v5H32z"/>'
  };
  const UNO_COLORS = ['red','yellow','green','blue'];
  const UNO_ACTIONS = ['skip','reverse','draw2'];

  /* =========================================================
   MOVED TO app.part4.js
   Games + Battles module
   Search there for:
   - gamesPanelHTML
   - wireGamesPanel
   - isGamesPanelOpen
   - loadGamesBattleDashboard
   - loadActiveBattleMatch
   - openGamesBattleComposer
   ========================================================= */
  function gamesPanelHTML() { return window.TlcGamesModule?.gamesPanelHTML?.() || '<div class="panelBlock gamesPanelWrap"><div class="gamesStatus">Games module unavailable.</div></div>'; }
  function wireGamesPanel() { return window.TlcGamesModule?.wireGamesPanel?.(); }
  function isGamesPanelOpen() { return !!window.TlcGamesModule?.isGamesPanelOpen?.(); }
  async function loadGamesBattleDashboard(opts = {}) { return await window.TlcGamesModule?.loadGamesBattleDashboard?.(opts); }
  async function loadActiveBattleMatch(opts = {}) { return await window.TlcGamesModule?.loadActiveBattleMatch?.(opts); }
  function openGamesBattleComposer(opts = {}) { return window.TlcGamesModule?.openGamesBattleComposer?.(opts); }

  /* =========================================================
   MOVED TO app.part5.js
   Driver Profile + Progression module
   Search there for:
   - ensureDriverProfileUI
   - openDriverProfileModal
   - renderDriverProfileModal
   - showLevelUpOverlay
   - syncMyProgression
   - handlePickupProgressionDelta
   ========================================================= */
  const driverProfileState = window.TlcDriverProfileSharedState || (window.TlcDriverProfileSharedState = {
    open: false,
    userId: null,
    isSelf: false,
    source: '',
    loading: false,
    displayName: '',
    profile: null,
    myProgression: null,
    messages: [],
    latestMessageId: null,
    error: '',
    status: '',
    sending: false,
    pollTimer: null,
    dmInitialLoadComplete: false,
  });
  const recentOutgoingDmEchoes = window.TlcDriverProfileRecentOutgoingDmEchoes || (window.TlcDriverProfileRecentOutgoingDmEchoes = new Map());

  function ensureDriverProfileUI() { return window.TlcDriverProfileModule?.ensureDriverProfileUI?.(); }
  async function fetchDriverProfile(userId) { return await window.TlcDriverProfileModule?.fetchDriverProfile?.(userId); }
  async function fetchDriverProfileDmThread(userId, opts = {}) { return await window.TlcDriverProfileModule?.fetchDriverProfileDmThread?.(userId, opts); }
  async function sendDriverProfileDm(userId, payload) { return await window.TlcDriverProfileModule?.sendDriverProfileDm?.(userId, payload); }
  function openDriverProfileModal(opts = {}) { return window.TlcDriverProfileModule?.openDriverProfileModal?.(opts); }
  function closeDriverProfileModal() { return window.TlcDriverProfileModule?.closeDriverProfileModal?.(); }
  function renderDriverProfileModal() { return window.TlcDriverProfileModule?.renderDriverProfileModal?.(); }
  function startDriverProfileDmPolling() { return window.TlcDriverProfileModule?.startDriverProfileDmPolling?.(); }
  function stopDriverProfileDmPolling() { return window.TlcDriverProfileModule?.stopDriverProfileDmPolling?.(); }
  function openPrivateChatWithUser(userId, displayName = '') { return window.TlcDriverProfileModule?.openPrivateChatWithUser?.(userId, displayName); }
  function updateDriverProfileLayout() { return window.TlcDriverProfileModule?.updateDriverProfileLayout?.(); }
  function ensureLevelUpOverlay() { return window.TlcDriverProfileModule?.ensureLevelUpOverlay?.(); }
  function updatePickupRewardLayout() { return window.TlcDriverProfileModule?.updatePickupRewardLayout?.(); }
  function scheduleDriverProfileDmPoll(opts = {}) { return window.TlcDriverProfileModule?.scheduleDriverProfileDmPoll?.(opts); }
  function showLevelUpOverlay(payload = {}) { return window.TlcDriverProfileModule?.showLevelUpOverlay?.(payload); }
  function formatProgressNumber(value, opts = {}) { return window.TlcDriverProfileModule?.formatProgressNumber?.(value, opts) || '0'; }
  function renderRankBadgeIcon(rankIconKey, opts = {}) { return window.TlcDriverProfileModule?.renderRankBadgeIcon?.(rankIconKey, opts) || ''; }
  function ensurePickupProgressReward() { return window.TlcDriverProfileModule?.ensurePickupProgressReward?.(); }
  function renderPickupProgressReward(payload = {}) { return window.TlcDriverProfileModule?.renderPickupProgressReward?.(payload); }
  async function syncMyProgression(opts = {}) { return await window.TlcDriverProfileModule?.syncMyProgression?.(opts); }
  function handlePickupProgressionDelta(payload = {}) { return window.TlcDriverProfileModule?.handlePickupProgressionDelta?.(payload); }
  async function syncLeaderboardBadgeRewards(opts = {}) { return await window.TlcDriverProfileModule?.syncLeaderboardBadgeRewards?.(opts); }

  window.TlcChatCoreInternals = {
    getCommunityToken,
    currentChatSelfUserId,
    currentChatSelfDisplayName,
    normalizeChatDisplayName,
    parseMessageId,
    msgUserId,
    normalizeMessageType,
    normalizeAudioUrl,
    normalizeAudioDurationMs,
    normalizeAudioMimeType,
    normalizePublicChatMessage,
    normalizePrivateChatMessage,
    normalizePublicMessagesPayload,
    normalizePrivateMessagesPayload,
    compareChatMessages,
    formatChatTime,
    isOwnMessage,
    isSuppressedOutgoingChatEcho,
    isSuppressedOutgoingDmEcho,
    renderPrivateConversationRow
  };

  window.TlcChatInternals = {
    getCommunityToken,
    normalizePrivateMessagesPayload,
    renderPrivateConversationRow,
    bindVoiceComposerControls,
    bindVoicePlayers,
    sendChatVoiceDraft,
    integrateUploadedVoiceMessage,
    playChatTone,
    cancelChatVoiceRecording,
    hasChatVoiceDraft,
    syncVoiceComposerSendButton,
    primeChatSoundSystem,
    chatFetchPrivateMessages,
    chatSendPrivateMessage,
    clearVoiceAssetsForMessages,
    pruneVoiceAssetCache,
    renderPrivateTabUnread,
    updateChatUnreadBadge,
    parseMessageId,
    formatChatTime,
    buildVoiceComposer,
    getDriverProfilePollIntervalMs,
    isChatNearBottom,
    upsertChatMessages,
    mergePrivateMessages,
    pruneExpiredChatState,
    privateUpsertThreadFromMessages,
    syncPrivateThreadMeta,
    currentChatSelfUserId,
    msgUserId,
    makeOutgoingEchoFingerprint,
    pruneOutgoingEchoMap,
    isOwnMessage,
    prefetchVoiceBlobUrls,
    isChatVoiceBusy,
    getVoiceRecorderState,
    leaderboardBadgeMeta,
    leaderboardBadgePriority,
    normalizeLeaderboardBadge,
    formatBattleDate,
    formatBattlePct,
    defaultBattleStats,
    chatPanelHTML,
    wireChatPanel,
    switchChatTab,
    openPrivateConversation,
    openPanel: typeof openPanel === 'function' ? openPanel : null,
    driverProfileState,
    CHAT_OUTGOING_ECHO_SUPPRESS_MS,
  };
  Object.defineProperties(window.TlcChatInternals, {
    privateThreads: { get: () => privateThreads, set: (value) => { privateThreads = Array.isArray(value) ? value : []; } },
    privateMessagesByUserId: { get: () => privateMessagesByUserId, set: (value) => { privateMessagesByUserId = value || Object.create(null); } },
    privateUnreadByUserId: { get: () => privateUnreadByUserId, set: (value) => { privateUnreadByUserId = value || Object.create(null); } },
    privateActiveDisplayName: { get: () => privateActiveDisplayName, set: (value) => { privateActiveDisplayName = String(value || ''); } },
    activeChatTab: { get: () => activeChatTab, set: (value) => { activeChatTab = String(value || 'public'); } },
    publicChatMessages: { get: () => publicChatMessages, set: (value) => { publicChatMessages = Array.isArray(value) ? value : []; } },
    chatSoundRuntime: { get: () => window.TlcChatVoiceModule?.chatSoundRuntime || null },
    recentOutgoingDmEchoes: { get: () => recentOutgoingDmEchoes },
  });

  // Expose chat functions for app.js to call if needed
  window.chatPanelHTML = chatPanelHTML;
  window.wireChatPanel = wireChatPanel;
  window.syncChatPollingState = syncChatPollingState;
  window.stopChatPolling = stopChatPolling;
  window.startChatPolling = startChatPolling;
  window.chatResetState = chatResetState;
  window.mapIdentityRenderSelfLabel = mapIdentityRenderSelfLabel;
  window.mapIdentityRenderDriverLabel = mapIdentityRenderDriverLabel;
  window.mapIdentityApplyZoomStyles = mapIdentityApplyZoomStyles;
  window.mapIdentityApplySelfOrbit = mapIdentityApplySelfOrbit;
  window.initMapIdentityProfileControls = initMapIdentityProfileControls;
  window.ensureDriverProfileUI = ensureDriverProfileUI;
  window.openDriverProfileModal = openDriverProfileModal;
  window.closeDriverProfileModal = closeDriverProfileModal;
  window.renderDriverProfileModal = renderDriverProfileModal;
  window.fetchDriverProfile = fetchDriverProfile;
  window.fetchDriverProfileDmThread = fetchDriverProfileDmThread;
  window.sendDriverProfileDm = sendDriverProfileDm;
  window.startDriverProfileDmPolling = startDriverProfileDmPolling;
  window.stopDriverProfileDmPolling = stopDriverProfileDmPolling;
  window.openPrivateChatWithUser = openPrivateChatWithUser;
  window.updateDriverProfileLayout = updateDriverProfileLayout;
  window.showLevelUpOverlay = showLevelUpOverlay;
  window.formatProgressNumber = formatProgressNumber;
  window.renderRankBadgeIcon = renderRankBadgeIcon;
  window.ensurePickupProgressReward = ensurePickupProgressReward;
  window.renderPickupProgressReward = renderPickupProgressReward;
  window.syncMyProgression = syncMyProgression;
  window.handlePickupProgressionDelta = handlePickupProgressionDelta;
  window.normalizeLeaderboardBadge = normalizeLeaderboardBadge;
  window.leaderboardBadgePriority = leaderboardBadgePriority;
  window.leaderboardBadgeMeta = leaderboardBadgeMeta;
  window.renderLeaderboardBadgeSvg = renderLeaderboardBadgeSvg;
  window.syncLeaderboardBadgeRewards = syncLeaderboardBadgeRewards;
  window.openGamesBattleComposer = openGamesBattleComposer;

  // Bind the chat dock button using its ID
  if (typeof bindDockToggle === 'function') {
    const chatBtn = document.getElementById('dockChat');
    if (chatBtn) { bindDockToggle(chatBtn, 'chat', 'Chat', chatPanelHTML, wireChatPanel); }
    const gamesBtn = document.getElementById('dockGames');
    if (gamesBtn) { bindDockToggle(gamesBtn, 'games', 'Games', gamesPanelHTML, wireGamesPanel); }
  }

  // Example night mode toggle (optional)
  function toggleNightMode() { document.body.classList.toggle('night'); }
  window.toggleNightMode = toggleNightMode;

  ensureDriverProfileUI();
  ensureLevelUpOverlay();
  ensurePickupProgressReward();
  window.addEventListener('resize', updatePickupRewardLayout);
  window.addEventListener('orientationchange', updatePickupRewardLayout);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', updatePickupRewardLayout);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && typeof authHeaderOK === 'function' && authHeaderOK()) {
      syncMyProgression({ forcePopupCheck: true });
      scheduleChatPoll({ immediate: true });
      schedulePrivatePoll({ immediate: true });
      ensureChatLiveTransports().catch(() => {});
      if (driverProfileState.open && driverProfileState.userId && !driverProfileState.isSelf) scheduleDriverProfileDmPoll({ immediate: true });
    }
    syncChatPollingState();
  });

  const observeChatAuthLoop = () => {
    observeChatAuthState();
    maybeSyncProgressionOnSignInState();
  };
  const clearIdentityLoop = () => {
    if (typeof authHeaderOK === 'function' && !authHeaderOK()) clearMapIdentityTempState();
  };

  if (runtimePolling) {
    runtimePolling.setInterval('chat:auth-observer', observeChatAuthLoop, 2000);
    runtimePolling.setInterval('chat:identity-clear', clearIdentityLoop, 2500);
  } else {
    window.setInterval(observeChatAuthLoop, 2000);
    window.setInterval(clearIdentityLoop, 2500);
  }

  window.getChatTransportDebugState = function () {
    return {
      capabilitiesCheckedAt: chatLiveRuntime.capabilitiesCheckedAt || 0,
      capabilities: chatLiveRuntime.capabilities,
      public: {
        mode: isChatLiveConnected('public') ? 'sse+poll' : 'poll-only',
        status: chatLiveRuntime.public.status,
        reconnectCount: chatLiveRuntime.public.reconnectCount,
        lastEventId: chatLiveRuntime.public.lastEventId,
        lastMessageId: chatLiveRuntime.public.lastMessageId,
        lastMergedKey: chatLiveRuntime.public.lastMergeKey,
        lastReconcileAt: chatLiveRuntime.public.lastReconcileAt,
        lastEventAt: chatLiveRuntime.public.lastEventAt,
        lastDisconnectReason: chatLiveRuntime.public.lastDisconnectReason,
        pollingActive: !!chatPollTimer,
      },
      private: {
        mode: isChatLiveConnected('private') ? 'sse+poll' : 'poll-only',
        status: chatLiveRuntime.private.status,
        reconnectCount: chatLiveRuntime.private.reconnectCount,
        lastEventId: chatLiveRuntime.private.lastEventId,
        lastMessageId: chatLiveRuntime.private.lastMessageId,
        lastMergedKey: chatLiveRuntime.private.lastMergeKey,
        lastThreadUserId: chatLiveRuntime.private.lastThreadUserId,
        lastReconcileAt: chatLiveRuntime.private.lastReconcileAt,
        lastEventAt: chatLiveRuntime.private.lastEventAt,
        lastDisconnectReason: chatLiveRuntime.private.lastDisconnectReason,
        pollingActive: !!privateThreadPollTimer,
      },
    };
  };

})();
