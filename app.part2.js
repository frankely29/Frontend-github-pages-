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

  async function postMultipartAuth(path, formData, token) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetchJSON(`${RAILWAY_BASE}${path}`, {
      method: 'POST',
      headers,
      body: formData,
    });
  }

  function buildChatVoiceUploadFile(blob, selectedMimeType) {
    const mime = String(blob?.type || selectedMimeType || 'audio/mp4').trim() || 'audio/mp4';
    const loweredMime = mime.toLowerCase();
    const ext = loweredMime.includes('mp4') || loweredMime.includes('m4a')
      ? 'm4a'
      : (loweredMime.includes('ogg')
        ? 'ogg'
        : (loweredMime.includes('mpeg') || loweredMime.includes('mp3')
          ? 'mp3'
          : 'webm'));
    return new File([blob], `voice-${Date.now()}.${ext}`, { type: mime });
  }

  async function postChatVoiceMultipart(path, blob, durationMs, token, selectedMimeType) {
    const file = buildChatVoiceUploadFile(blob, selectedMimeType);
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('duration_ms', String(Math.max(0, Math.round(durationMs || 0))));
    return postMultipartAuth(path, form, token);
  }

  const VOICE_NOTE_MAX_MS = 60000;
  const CHAT_RETENTION_MS = 24 * 60 * 60 * 1000;
  const CHAT_VOICE_SCOPE_CONFIG = {
    public: { stateScope: 'public', domKey: 'public' },
    private: { stateScope: 'private', domKey: 'private' },
    driverProfile: { stateScope: 'profile-dm', domKey: 'driverProfile' },
    'profile-dm': { stateScope: 'profile-dm', domKey: 'driverProfile' },
  };
  const CHAT_VOICE_MIME_TYPES = [
    'audio/mp4',
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
  ];
  const CHAT_VOICE_BUSY_PHASES = new Set(['preparing', 'requesting', 'recording', 'stopping', 'uploading']);
  const CHAT_VOICE_IDLE_STATUS = 'Tap mic to record (max 1:00)';
  const CHAT_VOICE_MAX_REACHED_STATUS = '1:00 max reached. Tap Send or Cancel.';
  const CHAT_VOICE_TEXT_LOCK_PLACEHOLDER = 'Send or cancel voice note first';
  const chatVoiceState = {
    phase: 'idle',
    stream: null,
    recorder: null,
    chunks: [],
    startedAt: 0,
    timerId: null,
    mimeType: '',
    queuedIncomingTone: 0,
    queuedOutgoingTone: 0,
    lastError: '',
    scope: '',
    room: '',
    otherUserId: '',
    durationMs: 0,
    statusText: CHAT_VOICE_IDLE_STATUS,
    errorText: '',
    cancelRequested: false,
  };
  const chatVoiceDraftState = {
    status: 'idle',
    blob: null,
    file: null,
    mimeType: '',
    durationMs: 0,
    objectUrl: '',
    startedAt: 0,
    scope: '',
    room: '',
    otherUserId: '',
    error: '',
  };
  const voiceAssetCache = new Map();
  const voicePlaybackAudio = new Audio();
  voicePlaybackAudio.preload = 'auto';
  voicePlaybackAudio.playsInline = true;
  const voicePlaybackRuntime = {
    activeMessageId: null,
    activeScope: '',
    activeAudio: voicePlaybackAudio,
    activeBlobUrl: '',
    activeAudioUrl: '',
    isPlaying: false,
    isSeeking: false,
    currentTime: 0,
    lastUserAction: '',
    suppressTonesUntil: 0,
    pendingToneQueue: [],
    cache: voiceAssetCache,
    lastPauseReason: '',
  };

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
  const recentOutgoingChatEchoes = new Map();

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

  function getChatAudioSession() {
    try {
      return navigator && navigator.audioSession ? navigator.audioSession : null;
    } catch (_) {
      return null;
    }
  }

  function isChatVoiceBusy() {
    return CHAT_VOICE_BUSY_PHASES.has(String(chatVoiceState.phase || 'idle'));
  }

  function setChatAudioSessionType(type) {
    const session = getChatAudioSession();
    if (!session || !type) return false;
    try {
      if (session.type !== type) session.type = type;
      return session.type === type;
    } catch (_) {
      return false;
    }
  }

  function pauseActiveChatVoicePlayback() {
    stopSharedVoicePlayback('capture', { resetPosition: false, clearActive: false });
  }

  function applyChatAudioSessionAmbient(reason = 'chat') {
    if (isChatVoiceBusy() || isVoicePlaybackActive()) return false;
    if (setChatAudioSessionType('ambient')) return true;
    return setChatAudioSessionType('auto');
  }

  async function prepareChatAudioForCapture(reason = 'voice-capture') {
    pauseActiveChatVoicePlayback();
    chatVoiceState.phase = 'preparing';
    chatVoiceState.lastError = '';
    if (!setChatAudioSessionType('play-and-record')) {
      setChatAudioSessionType('auto');
    }
    chatVoiceState.phase = 'requesting';
    return true;
  }

  async function restoreChatAudioAfterCapture(reason = 'voice-capture') {
    const queuedIncoming = chatVoiceState.queuedIncomingTone > 0;
    const queuedOutgoing = chatVoiceState.queuedOutgoingTone > 0;
    stopChatVoiceTracks();
    resetChatVoiceState();
    if (!setChatAudioSessionType('ambient')) {
      setChatAudioSessionType('auto');
    }
    chatVoiceState.queuedIncomingTone = 0;
    chatVoiceState.queuedOutgoingTone = 0;
    if (queuedIncoming) queuePendingChatTone('incoming');
    if (queuedOutgoing) queuePendingChatTone('outgoing');
    await flushPendingChatTones();
    syncAllVoiceRecorderUis();
    return true;
  }

  const chatSoundRuntime = {
    userPrimed: false,
    webAudioReady: false,
    htmlAudioReady: false,
    pendingIncoming: 0,
    pendingOutgoing: 0,
    lastPrimeAt: 0,
    lastLifecycleResetAt: 0,
    lastObservedIncomingId: null,
    dmLastObservedIncomingId: null,
    dmBaselineReady: false,
    seenIncomingKeys: new Set(),
  };

  const CHAT_AUDIO_SEEN_KEY_LIMIT = 800;

  function chatAudioMsgKey(msg) {
    const rawId = msg?.id;
    if (rawId !== null && rawId !== undefined && String(rawId).trim() !== '') {
      return `id:${String(rawId)}`;
    }
    const created = String(msg?.created_at || msg?.ts || msg?.timestamp || '');
    const who = String(msg?.user_id || msg?.userId || msg?.display_name || msg?.user_name || msg?.name || '');
    const body = String(msg?.text || msg?.message || '');
    if (!created && !who && !body) return '';
    return `fallback:${created}|${who}|${body}`;
  }

  function rememberSeenIncomingChatKey(msg) {
    const key = chatAudioMsgKey(msg);
    if (!key) return;
    chatSoundRuntime.seenIncomingKeys.add(key);
    if (chatSoundRuntime.seenIncomingKeys.size <= CHAT_AUDIO_SEEN_KEY_LIMIT) return;
    const overflow = chatSoundRuntime.seenIncomingKeys.size - CHAT_AUDIO_SEEN_KEY_LIMIT;
    let removed = 0;
    for (const oldest of chatSoundRuntime.seenIncomingKeys) {
      chatSoundRuntime.seenIncomingKeys.delete(oldest);
      removed += 1;
      if (removed >= overflow) break;
    }
  }

  const chatSoundState = {
    incomingPool: [],
    outgoingPool: [],
    incomingPoolIndex: 0,
    outgoingPoolIndex: 0,
    baselineReady: false,
    primeListenersBound: false,
    primeInFlight: false,
    handlersAttached: false,
    incomingToneDataUrl: '',
    outgoingToneDataUrl: '',
    silentToneDataUrl: ''
  };
  let chatAudioCtx = null;
  let chatAudioUnlocked = false;
  let chatAudioReady = false;
  let lastObservedChatAuthReady = null;
  let chatNotificationsBootstrapped = false;
  let chatNotificationsBootstrapInFlight = false;
  let chatFirstInteractionBound = false;

  function ensureChatSoundContext() {
    if (!isChatVoiceBusy()) applyChatAudioSessionAmbient('ensure-context');
    if (chatAudioCtx && chatAudioCtx.state !== 'closed') return chatAudioCtx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      chatAudioCtx = null;
      return null;
    }
    chatAudioCtx = new Ctx();
    attachChatSoundStateHandlers();
    return chatAudioCtx;
  }

  function bindChatAudioUnlockListeners() {
    bindChatSoundPrimeListeners();
  }

  function removeChatAudioUnlockListeners() {
    removeChatSoundPrimeListeners();
  }

  function queuePendingChatTone(kind) {
    if (isChatVoiceBusy() || isVoicePlaybackActive()) {
      if (kind === 'incoming') chatVoiceState.queuedIncomingTone = 1;
      else if (kind === 'outgoing') chatVoiceState.queuedOutgoingTone = 1;
      voicePlaybackRuntime.pendingToneQueue.push(kind);
      return;
    }
    if (kind === 'incoming') chatSoundRuntime.pendingIncoming = 1;
    else if (kind === 'outgoing') chatSoundRuntime.pendingOutgoing = 1;
  }

  function resetChatSoundLifecycle(reason = 'unknown') {
    const keepHtmlReady = !!chatSoundRuntime?.htmlAudioReady;
    chatAudioUnlocked = false;
    chatAudioReady = keepHtmlReady;

    if (typeof chatSoundRuntime !== 'undefined' && chatSoundRuntime) {
      chatSoundRuntime.userPrimed = keepHtmlReady;
      chatSoundRuntime.webAudioReady = false;
      chatSoundRuntime.htmlAudioReady = keepHtmlReady;
      if (!keepHtmlReady) chatSoundRuntime.lastPrimeAt = 0;
      chatSoundRuntime.lastLifecycleResetAt = Date.now();
    }

    bindChatSoundPrimeListeners?.();
    bindChatAudioUnlockListeners?.();
  }

  function reconcileChatSoundRuntime(reason = 'unknown') {
    let ctxState = null;
    try {
      ctxState = chatAudioCtx ? chatAudioCtx.state : null;
    } catch (_) {
      ctxState = null;
    }

    const anyAudioReady = !!(chatSoundRuntime?.webAudioReady || chatSoundRuntime?.htmlAudioReady);

    if (!chatAudioCtx || ctxState === 'closed') {
      chatAudioCtx = null;
      chatAudioUnlocked = anyAudioReady;
      chatAudioReady = anyAudioReady;
      if (typeof chatSoundRuntime !== 'undefined' && chatSoundRuntime) {
        chatSoundRuntime.webAudioReady = false;
        chatSoundRuntime.userPrimed = !!chatSoundRuntime.htmlAudioReady;
      }
      bindChatSoundPrimeListeners?.();
      bindChatAudioUnlockListeners?.();
      return chatAudioReady;
    }

    if (ctxState === 'running') {
      chatAudioUnlocked = true;
      if (typeof chatSoundRuntime !== 'undefined' && chatSoundRuntime) {
        chatSoundRuntime.webAudioReady = true;
        chatSoundRuntime.userPrimed = !!(chatSoundRuntime.webAudioReady || chatSoundRuntime.htmlAudioReady);
      }
      chatAudioReady = !!(chatSoundRuntime?.webAudioReady || chatSoundRuntime?.htmlAudioReady);
      return chatAudioReady;
    }

    const htmlReady = !!chatSoundRuntime?.htmlAudioReady;
    chatAudioUnlocked = htmlReady;
    chatAudioReady = htmlReady;
    if (typeof chatSoundRuntime !== 'undefined' && chatSoundRuntime) {
      chatSoundRuntime.webAudioReady = false;
      chatSoundRuntime.userPrimed = htmlReady;
    }
    bindChatSoundPrimeListeners?.();
    bindChatAudioUnlockListeners?.();
    return chatAudioReady;
  }

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

  function makeChatToneDataUrl(kind) {
    const sampleRate = 22050;
    const spec = kind === 'incoming'
      ? { duration: 0.16, startFreq: 720, endFreq: 900, peak: 0.18 }
      : kind === 'outgoing'
        ? { duration: 0.095, startFreq: 560, endFreq: 720, peak: 0.14 }
        : { duration: 0.02, startFreq: 440, endFreq: 440, peak: 0 };
    const total = Math.max(1, Math.floor(sampleRate * spec.duration));
    const attack = Math.max(1, Math.floor(total * 0.15));
    const releaseStart = Math.floor(total * 0.55);
    const pcm = new Int16Array(total);
    let phase = 0;
    for (let i = 0; i < total; i += 1) {
      const t = total <= 1 ? 0 : i / (total - 1);
      const freq = spec.startFreq + ((spec.endFreq - spec.startFreq) * t);
      phase += (2 * Math.PI * freq) / sampleRate;
      let env = 1;
      if (i < attack) env = i / attack;
      else if (i > releaseStart) env = Math.max(0, 1 - ((i - releaseStart) / Math.max(1, total - releaseStart)));
      const sample = Math.sin(phase) * spec.peak * env;
      pcm[i] = Math.max(-32768, Math.min(32767, Math.floor(sample * 32767)));
    }
    const dataSize = pcm.length * 2;
    const wav = new Uint8Array(44 + dataSize);
    const view = new DataView(wav.buffer);
    const write = (offset, text) => { for (let i = 0; i < text.length; i += 1) wav[offset + i] = text.charCodeAt(i); };
    write(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    write(8, 'WAVE');
    write(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    write(36, 'data');
    view.setUint32(40, dataSize, true);
    for (let i = 0; i < pcm.length; i += 1) {
      view.setInt16(44 + (i * 2), pcm[i], true);
    }
    let binary = '';
    for (let i = 0; i < wav.length; i += 1) binary += String.fromCharCode(wav[i]);
    return `data:audio/wav;base64,${btoa(binary)}`;
  }

  function ensureChatHtmlAudioPools() {
    if (!chatSoundState.incomingToneDataUrl) chatSoundState.incomingToneDataUrl = makeChatToneDataUrl('incoming');
    if (!chatSoundState.outgoingToneDataUrl) chatSoundState.outgoingToneDataUrl = makeChatToneDataUrl('outgoing');
    if (!chatSoundState.silentToneDataUrl) chatSoundState.silentToneDataUrl = makeChatToneDataUrl('silent');
    const ensurePool = (pool, size, src) => {
      while (pool.length < size) {
        const el = new Audio(src);
        el.preload = 'auto';
        el.playsInline = true;
        pool.push(el);
      }
    };
    ensurePool(chatSoundState.incomingPool, 4, chatSoundState.incomingToneDataUrl);
    ensurePool(chatSoundState.outgoingPool, 4, chatSoundState.outgoingToneDataUrl);
  }

  async function tryPlayChatToneHtml(kind) {
    ensureChatHtmlAudioPools();
    const isIncoming = kind === 'incoming';
    const pool = isIncoming ? chatSoundState.incomingPool : chatSoundState.outgoingPool;
    if (!pool.length) return false;
    const idxKey = isIncoming ? 'incomingPoolIndex' : 'outgoingPoolIndex';
    const idx = chatSoundState[idxKey] % pool.length;
    chatSoundState[idxKey] = (chatSoundState[idxKey] + 1) % pool.length;
    const el = pool[idx];
    if (!el) return false;
    el.pause();
    try { el.currentTime = 0; } catch (_) {}
    el.muted = false;
    el.volume = 1;
    try {
      await el.play();
      chatSoundRuntime.htmlAudioReady = true;
      return true;
    } catch (_) {
      return false;
    }
  }

  async function tryPlayChatToneWebAudio(kind) {
    const ctx = ensureChatSoundContext();
    if (!ctx) return false;
    try {
      if (ctx.state === 'suspended' || ctx.state === 'interrupted') await ctx.resume();
    } catch (_) {}
    if (ctx.state !== 'running') {
      chatSoundRuntime.webAudioReady = false;
      return false;
    }
    const now = ctx.currentTime;
    const incoming = kind === 'incoming';
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(incoming ? 0.16 : 0.12, now + (incoming ? 0.016 : 0.01));
    gain.gain.exponentialRampToValueAtTime(0.0001, now + (incoming ? 0.16 : 0.095));
    gain.connect(ctx.destination);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(incoming ? 720 : 560, now);
    osc.frequency.exponentialRampToValueAtTime(incoming ? 900 : 720, now + (incoming ? 0.14 : 0.09));
    osc.connect(gain);
    osc.start(now);
    osc.stop(now + (incoming ? 0.16 : 0.095));
    chatSoundRuntime.webAudioReady = true;
    return true;
  }

  async function primeChatSoundSystem(trigger = 'interaction') {
    if (chatSoundState.primeInFlight) return chatAudioReady;
    if (isChatVoiceBusy()) return false;
    chatSoundState.primeInFlight = true;
    applyChatAudioSessionAmbient(trigger);
    reconcileChatSoundRuntime('prime-start');
    ensureChatHtmlAudioPools();
    attachChatSoundStateHandlers();

    let htmlPrimedSuccess = false;
    try {
      const primer = new Audio(chatSoundState.silentToneDataUrl || makeChatToneDataUrl('silent'));
      primer.preload = 'auto';
      primer.playsInline = true;
      primer.muted = true;
      await primer.play();
      primer.pause();
      try { primer.currentTime = 0; } catch (_) {}
      htmlPrimedSuccess = true;
    } catch (_) {}

    const ctx = ensureChatSoundContext();
    if (ctx) {
      try {
        if (ctx.state === 'suspended' || ctx.state === 'interrupted') await ctx.resume();
      } catch (_) {}
    }

    const ctxRunning = !!(ctx && ctx.state === 'running');
    chatAudioUnlocked = ctxRunning || htmlPrimedSuccess;
    chatAudioReady = chatAudioUnlocked;
    chatSoundRuntime.webAudioReady = ctxRunning;
    chatSoundRuntime.htmlAudioReady = !!htmlPrimedSuccess;
    chatSoundRuntime.userPrimed = !!(chatSoundRuntime.webAudioReady || chatSoundRuntime.htmlAudioReady);

    if (chatSoundRuntime.userPrimed) {
      chatSoundRuntime.lastPrimeAt = Date.now();
      removeChatSoundPrimeListeners();
      removeChatAudioUnlockListeners();
      await flushPendingChatTones();
    } else {
      bindChatSoundPrimeListeners();
      bindChatAudioUnlockListeners();
    }

    chatSoundState.primeInFlight = false;
    return chatSoundRuntime.userPrimed;
  }

  async function primeChatAudio(trigger = 'interaction') {
    return primeChatSoundSystem(trigger);
  }

  function canPlayChatTone() {
    reconcileChatSoundRuntime('can-play');
    return !!chatAudioReady;
  }

  function canPlayChatSound() {
    return canPlayChatTone();
  }

  async function playIncomingSoftTone() {
    return playChatTone('incoming');
  }

  async function playOutgoingSoftTone() {
    return playChatTone('outgoing');
  }

  async function playChatTone(kind) {
    if (window.radioPlaybackRuntime?.isPlaying) return false;
    if (isChatVoiceBusy() || isVoicePlaybackActive() || Date.now() < Number(voicePlaybackRuntime.suppressTonesUntil || 0)) {
      queuePendingChatTone(kind);
      return false;
    }
    reconcileChatSoundRuntime(`play-${kind}-start`);
    if (kind === 'incoming') applyChatAudioSessionAmbient('incoming-tone');
    if (kind === 'outgoing') applyChatAudioSessionAmbient('outgoing-tone');
    ensureChatHtmlAudioPools();
    ensureChatSoundContext();
    if (!canPlayChatTone()) {
      queuePendingChatTone(kind);
      bindChatSoundPrimeListeners();
      bindChatAudioUnlockListeners();
      return false;
    }
    if (await tryPlayChatToneHtml(kind)) return true;
    if (await tryPlayChatToneWebAudio(kind)) return true;
    queuePendingChatTone(kind);
    markChatSoundNeedsPrime('play-failed');
    return false;
  }

  async function flushPendingChatTones() {
    if (isChatVoiceBusy() || isVoicePlaybackActive()) return;
    reconcileChatSoundRuntime('flush-pending');
    if (!chatAudioReady) return;
    const incomingPending = chatSoundRuntime.pendingIncoming > 0 || voicePlaybackRuntime.pendingToneQueue.includes('incoming');
    const outgoingPending = chatSoundRuntime.pendingOutgoing > 0 || voicePlaybackRuntime.pendingToneQueue.includes('outgoing');
    chatSoundRuntime.pendingIncoming = 0;
    chatSoundRuntime.pendingOutgoing = 0;
    voicePlaybackRuntime.pendingToneQueue = [];
    if (incomingPending) await playChatTone('incoming');
    if (outgoingPending) await playChatTone('outgoing');
  }

  function onChatSoundPrimeInteraction(evt) {
    const target = evt?.target;
    if (target && typeof target.closest === 'function' && target.closest('[data-chat-voice-trigger]')) return;
    void primeChatSoundSystem(evt?.type || 'interaction');
  }

  function removeChatSoundPrimeListeners() {
    if (!chatSoundState.primeListenersBound) return;
    ['pointerdown', 'touchstart', 'click', 'keydown'].forEach((evtName) => {
      document.removeEventListener(evtName, onChatSoundPrimeInteraction, true);
    });
    chatSoundState.primeListenersBound = false;
  }

  function bindChatSoundPrimeListeners() {
    if (chatAudioReady || chatSoundState.primeListenersBound) return;
    ['pointerdown', 'touchstart', 'click', 'keydown'].forEach((evtName) => {
      document.addEventListener(evtName, onChatSoundPrimeInteraction, { passive: true, capture: true });
    });
    chatSoundState.primeListenersBound = true;
  }

  function markChatSoundNeedsPrime(reason) {
    const keepHtmlReady = !!chatSoundRuntime?.htmlAudioReady;
    chatAudioUnlocked = false;
    chatAudioReady = keepHtmlReady;
    chatSoundRuntime.userPrimed = keepHtmlReady;
    chatSoundRuntime.webAudioReady = false;
    chatSoundRuntime.htmlAudioReady = keepHtmlReady;
    bindChatSoundPrimeListeners();
    bindChatAudioUnlockListeners();
  }

  function attachChatSoundStateHandlers() {
    if (!chatSoundState.handlersAttached) {
      window.addEventListener('pageshow', (evt) => {
        resetChatSoundLifecycle(evt?.persisted ? 'pageshow-persisted' : 'pageshow');
        reconcileChatSoundRuntime('pageshow');
      });

      window.addEventListener('pagehide', () => {
        void cancelChatVoiceRecording('Recording canceled');
        chatAudioUnlocked = false;
        chatAudioReady = false;
        if (typeof chatSoundRuntime !== 'undefined' && chatSoundRuntime) {
          chatSoundRuntime.userPrimed = false;
          chatSoundRuntime.webAudioReady = false;
        }
        bindChatSoundPrimeListeners?.();
        bindChatAudioUnlockListeners?.();
      });

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          void cancelChatVoiceRecording('Recording canceled');
          return;
        }
        if (document.visibilityState === 'visible') {
          reconcileChatSoundRuntime('visibility-visible');
          if (!chatAudioReady) {
            bindChatSoundPrimeListeners?.();
            bindChatAudioUnlockListeners?.();
          }
        }
      });

      window.addEventListener('focus', () => {
        reconcileChatSoundRuntime('window-focus');
        if (!chatAudioReady) {
          bindChatSoundPrimeListeners?.();
          bindChatAudioUnlockListeners?.();
        }
      });
      chatSoundState.handlersAttached = true;
    }
    const ctx = chatAudioCtx;
    if (ctx) {
      ctx.onstatechange = () => {
        if (ctx.state === 'running') {
          chatSoundRuntime.webAudioReady = true;
          chatSoundRuntime.userPrimed = !!(chatSoundRuntime.webAudioReady || chatSoundRuntime.htmlAudioReady);
          chatAudioUnlocked = chatSoundRuntime.userPrimed;
          chatAudioReady = chatSoundRuntime.userPrimed;
        } else if (ctx.state === 'suspended' || ctx.state === 'interrupted' || ctx.state === 'closed') {
          chatSoundRuntime.webAudioReady = false;
          if (ctx.state === 'closed') chatAudioCtx = null;
          markChatSoundNeedsPrime(`ctx-${ctx.state}`);
        }
      };
    }
  }

  attachChatSoundStateHandlers();
  resetChatSoundLifecycle('module-init');
  reconcileChatSoundRuntime('module-init');

  function seedChatIncomingAudioBaseline(messages) {
    if (!Array.isArray(messages) || !messages.length) {
      chatSoundState.baselineReady = true;
      return;
    }
    let maxId = chatSoundRuntime.lastObservedIncomingId;
    for (const msg of messages) {
      rememberSeenIncomingChatKey(msg);
      const id = messageNumericId(msg);
      if (id === null) continue;
      maxId = maxId === null ? id : Math.max(maxId, id);
    }
    chatSoundRuntime.lastObservedIncomingId = maxId;
    chatSoundState.baselineReady = true;
  }

  function collectFreshIncomingMessagesForAudio(messages) {
    if (!Array.isArray(messages) || !messages.length) {
      chatSoundState.baselineReady = true;
      return [];
    }
    const fresh = [];
    let maxId = chatSoundRuntime.lastObservedIncomingId;
    const baselineReady = chatSoundState.baselineReady;
    for (const msg of messages) {
      const fallbackKey = chatAudioMsgKey(msg);
      const id = messageNumericId(msg);
      const freshByNumericId = id !== null && baselineReady && (maxId === null || id > maxId);
      const freshBySeenKey = id === null && baselineReady && !!fallbackKey && !chatSoundRuntime.seenIncomingKeys.has(fallbackKey);
      const isFresh = freshByNumericId || freshBySeenKey;
      if (isFresh && !isOwnMessage(msg) && !isSuppressedOutgoingChatEcho(msg)) fresh.push(msg);
      if (id !== null) {
        maxId = maxId === null ? id : Math.max(maxId, id);
      }
      rememberSeenIncomingChatKey(msg);
    }
    chatSoundRuntime.lastObservedIncomingId = maxId;
    chatSoundState.baselineReady = true;
    return fresh;
  }

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

  function voiceScopeConfig(scope) {
    return CHAT_VOICE_SCOPE_CONFIG[scope] || null;
  }

  function voiceScopeDomKey(scope) {
    return voiceScopeConfig(scope)?.domKey || String(scope || 'public');
  }

  function voiceScopeStateKey(scope) {
    return voiceScopeConfig(scope)?.stateScope || String(scope || 'public');
  }

  function chatSupportsVoiceRecording() {
    return !!(navigator?.mediaDevices?.getUserMedia && typeof window.MediaRecorder !== 'undefined');
  }

  function chooseChatVoiceMimeType() {
    if (typeof window.MediaRecorder === 'undefined') return '';
    for (const type of CHAT_VOICE_MIME_TYPES) {
      try {
        if (typeof window.MediaRecorder.isTypeSupported !== 'function' || window.MediaRecorder.isTypeSupported(type)) {
          return type;
        }
      } catch (_) {}
    }
    return '';
  }

  function formatChatVoiceDuration(durationMs) {
    const totalSeconds = Math.max(0, Math.round((Number(durationMs) || 0) / 1000));
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }

  function chatPickVoiceMimeType() { return chooseChatVoiceMimeType(); }
  function chatFormatVoiceDuration(durationMs) { return formatChatVoiceDuration(durationMs); }
  function formatVoiceNoteDuration(durationMs) { return formatChatVoiceDuration(durationMs); }

  function voiceNoteLabel(message) {
    return message?.text || 'Voice note';
  }

  function buildVoiceComposer(surface, extraClass = '') {
    return `<div class="chatVoiceComposer ${extraClass}" data-voice-surface="${surface}">
      <div class="chatVoicePreview">
        <button class="chatVoiceBtn" id="${surface}VoiceStartBtn" type="button" aria-label="Record voice note" data-chat-voice-trigger="1">🎤</button>
        <button class="chatVoiceBtn recording" id="${surface}VoiceStopBtn" type="button" aria-label="Stop voice note" hidden data-chat-voice-trigger="1">Stop</button>
        <button class="chatVoiceBtn" id="${surface}VoiceCancelBtn" type="button" aria-label="Cancel voice note" hidden data-chat-voice-trigger="1">Cancel</button>
        <div class="chatVoiceMeta">
          <div class="chatVoiceStatus" id="${surface}VoiceStatus" aria-live="polite">${CHAT_VOICE_IDLE_STATUS}</div>
          <div class="chatVoiceTimer" id="${surface}VoiceTimer">0:00</div>
          <div class="chatVoiceStatus" id="${surface}VoiceUpload" hidden></div>
          <div class="chatVoiceError" id="${surface}VoiceError" hidden></div>
        </div>
      </div>
      <div class="chatVoiceDraft" id="${surface}VoiceDraft" hidden>
        <div class="chatVoiceDraftTitle">Voice note ready. Tap Send to send the voice note.</div>
        <div class="chatVoiceDraftMeta">
          <span class="chatVoiceDraftDuration" id="${surface}VoiceDraftDuration">0:00</span>
        </div>
        <div class="chatVoiceDraftActions">
          <button class="chatVoiceBtn" id="${surface}VoiceDraftPreviewBtn" type="button" data-chat-voice-trigger="1">Play</button>
          <button class="chatVoiceBtn" id="${surface}VoiceDraftCancelBtn" type="button" data-chat-voice-trigger="1">Cancel</button>
          <button class="chatVoiceBtn" id="${surface}VoiceDraftSendBtn" type="button" data-chat-voice-trigger="1">Send</button>
        </div>
      </div>
    </div>`;
  }

  function isCompleteVoiceMessage(message) {
    return parseMessageId(message?.id) !== null
      && normalizeMessageType(message?.messageType, message?.audioUrl ? 'voice' : 'text') === 'voice'
      && !!String(message?.audioUrl || '').trim();
  }

  function getVoiceAssetCacheKey(message) {
    const messageId = parseMessageId(message?.id);
    const audioUrl = String(message?.audioUrl || '').trim();
    return `${messageId === null ? 'unknown' : messageId}::${audioUrl}`;
  }

  function getVoiceMessageDomKey(message) {
    return getMessageMergeKey(message);
  }

  function isVoicePlaybackActive() {
    const activeAudio = voicePlaybackRuntime.activeAudio;
    return !!(voicePlaybackRuntime.isPlaying && activeAudio && !activeAudio.paused && !activeAudio.ended);
  }

  function isVoicePlaybackMessage(messageId, scope) {
    return parseMessageId(messageId) === parseMessageId(voicePlaybackRuntime.activeMessageId)
      && String(scope || '').trim() === String(voicePlaybackRuntime.activeScope || '').trim();
  }

  function isVoiceRowRendered(messageId, audioUrl = '') {
    if (messageId === null || messageId === undefined || messageId === '') return false;
    const selector = `[data-message-id="${String(messageId)}"]`;
    const rows = document.querySelectorAll?.(selector);
    if (!rows || !rows.length) return false;
    if (!audioUrl) return true;
    return Array.from(rows).some((row) => String(row?.dataset?.audioUrl || '').trim() === String(audioUrl).trim());
  }

  function releaseVoiceBlobUrl(messageId, reason = 'release') {
    const targetId = parseMessageId(messageId);
    if (targetId === null) return;
    for (const [key, entry] of voiceAssetCache.entries()) {
      if (!key.startsWith(`${targetId}::`)) continue;
      const blobUrl = String(entry?.blobUrl || '').trim();
      const audioUrl = String(key.split('::').slice(1).join('::') || '').trim();
      const isProtected = (parseMessageId(voicePlaybackRuntime.activeMessageId) === targetId && voicePlaybackRuntime.activeBlobUrl === blobUrl)
        || isVoiceRowRendered(targetId, audioUrl);
      if (isProtected) continue;
      if (blobUrl) {
        try { URL.revokeObjectURL(blobUrl); } catch (_) {}
      }
      voiceAssetCache.delete(key);
    }
  }

  function shouldReuseVoiceRow(oldMsg, newMsg) {
    if (!oldMsg || !newMsg) return false;
    if (normalizeMessageType(oldMsg?.messageType, oldMsg?.audioUrl ? 'voice' : 'text') !== 'voice') return false;
    if (normalizeMessageType(newMsg?.messageType, newMsg?.audioUrl ? 'voice' : 'text') !== 'voice') return false;
    return getVoiceMessageDomKey(oldMsg) === getVoiceMessageDomKey(newMsg)
      && String(oldMsg?.audioUrl || '').trim() === String(newMsg?.audioUrl || '').trim()
      && Number(oldMsg?.audioDurationMs || 0) === Number(newMsg?.audioDurationMs || 0)
      && String(oldMsg?.text || '') === String(newMsg?.text || '');
  }

  function escapeCssValue(value) {
    const raw = String(value || '');
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(raw);
    return raw.replace(/["\\]/g, '\\$&');
  }

  function clearVoiceAssetForMessage(messageId) {
    const targetId = parseMessageId(messageId);
    if (targetId === null) return;
    releaseVoiceBlobUrl(targetId, 'clear-message');
  }

  function clearVoiceAssetsForMessages(messages = []) {
    (Array.isArray(messages) ? messages : []).forEach((message) => {
      const id = parseMessageId(message?.id);
      if (id !== null) clearVoiceAssetForMessage(id);
    });
  }

  function stopSharedVoicePlayback(reason = 'stop', { resetPosition = false, clearActive = false } = {}) {
    const audio = voicePlaybackRuntime.activeAudio;
    voicePlaybackRuntime.lastPauseReason = reason;
    if (audio) {
      try {
        if (!audio.paused) audio.pause();
      } catch (_) {}
      if (resetPosition) {
        try { audio.currentTime = 0; } catch (_) {}
      }
    }
    if (clearActive) {
      voicePlaybackRuntime.activeMessageId = null;
      voicePlaybackRuntime.activeScope = '';
      voicePlaybackRuntime.activeBlobUrl = '';
      voicePlaybackRuntime.activeAudioUrl = '';
      voicePlaybackRuntime.currentTime = 0;
      voicePlaybackRuntime.isPlaying = false;
      voicePlaybackRuntime.isSeeking = false;
    }
    syncAllVoicePlayers();
  }

  function revokeVoiceBlobUrls() {
    stopSharedVoicePlayback('reset', { resetPosition: true, clearActive: true });
    for (const entry of voiceAssetCache.values()) {
      const blobUrl = String(entry?.blobUrl || '').trim();
      if (blobUrl && blobUrl !== voicePlaybackRuntime.activeBlobUrl) {
        try { URL.revokeObjectURL(blobUrl); } catch (_) {}
      }
    }
    voiceAssetCache.clear();
  }

  function collectTrackedVoiceMessages() {
    const messages = [];
    if (Array.isArray(publicChatMessages)) messages.push(...publicChatMessages);
    Object.values(privateMessagesByUserId || {}).forEach((list) => {
      if (Array.isArray(list)) messages.push(...list);
    });
    return messages.filter((msg) => normalizeMessageType(msg?.messageType, msg?.audioUrl ? 'voice' : 'text') === 'voice');
  }

  function pruneVoiceAssetCache(messages = collectTrackedVoiceMessages()) {
    const activeKeys = new Set((messages || [])
      .map((message) => getVoiceAssetCacheKey(message))
      .filter((key) => !key.endsWith('::')));
    for (const [key, entry] of voiceAssetCache.entries()) {
      if (activeKeys.has(key)) continue;
      const messageId = parseMessageId(key.split('::')[0]);
      if (messageId !== null) releaseVoiceBlobUrl(messageId, 'prune');
      else if (entry?.blobUrl) {
        try { URL.revokeObjectURL(entry.blobUrl); } catch (_) {}
        voiceAssetCache.delete(key);
      }
    }
  }

  async function ensureVoiceBlobUrl(message, attempt = 0) {
    const audioUrl = String(message?.audioUrl || '').trim();
    const key = getVoiceAssetCacheKey(message);
    if (!audioUrl) {
      voiceAssetCache.set(key, {
        status: 'error',
        blobUrl: '',
        mimeType: String(message?.audioMimeType || '').trim(),
        error: 'Voice note unavailable.',
      });
      return '';
    }
    const cached = voiceAssetCache.get(key);
    if (cached?.status === 'ready' && cached.blobUrl) return cached.blobUrl;
    if (cached?.status === 'loading' && cached.promise) return cached.promise;
    const token = getCommunityToken();
    const promise = (async () => {
      try {
        const headers = new Headers();
        if (token) headers.set('Authorization', `Bearer ${token}`);
        const response = await fetch(audioUrl, {
          method: 'GET',
          headers,
          cache: 'force-cache',
        });
        if (!response.ok) throw new Error(`Voice fetch failed (${response.status})`);
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        const next = {
          status: 'ready',
          blobUrl,
          mimeType: blob.type || String(message?.audioMimeType || '').trim(),
          error: '',
        };
        const previous = voiceAssetCache.get(key);
        if (previous?.blobUrl && previous.blobUrl !== blobUrl && previous.blobUrl !== voicePlaybackRuntime.activeBlobUrl) {
          try { URL.revokeObjectURL(previous.blobUrl); } catch (_) {}
        }
        voiceAssetCache.set(key, next);
        refreshVoicePlayersForMessage(message);
        return blobUrl;
      } catch (error) {
        console.warn('voice blob fetch failed', { message, error, attempt });
        if (attempt < 1) {
          voiceAssetCache.delete(key);
          return ensureVoiceBlobUrl(message, attempt + 1);
        }
        voiceAssetCache.set(key, {
          status: 'error',
          blobUrl: '',
          mimeType: String(message?.audioMimeType || '').trim(),
          error: 'Voice note unavailable.',
        });
        refreshVoicePlayersForMessage(message);
        return '';
      }
    })();
    voiceAssetCache.set(key, {
      status: 'loading',
      blobUrl: '',
      mimeType: String(message?.audioMimeType || '').trim(),
      error: '',
      promise,
    });
    promise.finally(() => refreshVoicePlayersForMessage(message));
    return promise;
  }

  function prefetchVoiceBlobUrls(messages = []) {
    const voiceMessages = (Array.isArray(messages) ? messages : [])
      .filter((message) => normalizeMessageType(message?.messageType, message?.audioUrl ? 'voice' : 'text') === 'voice');
    if (!voiceMessages.length) return Promise.resolve([]);
    return Promise.allSettled(voiceMessages.map((message) => ensureVoiceBlobUrl(message)));
  }

  function buildVoicePlayerMessageFromDataset(player) {
    return {
      id: parseMessageId(player?.dataset?.messageId),
      messageType: 'voice',
      text: String(player?.dataset?.voiceLabel || 'Voice note'),
      createdAt: player?.dataset?.createdAt || null,
      isOwn: player?.dataset?.voiceOwn === '1',
      displayName: player?.dataset?.displayName || 'Driver',
      audioUrl: String(player?.dataset?.audioUrl || '').trim(),
      audioDurationMs: Number(player?.dataset?.durationMs || 0) || 0,
      audioMimeType: String(player?.dataset?.audioMimeType || '').trim(),
      senderUserId: player?.dataset?.senderUserId || null,
      recipientUserId: player?.dataset?.recipientUserId || null,
    };
  }

  function getRenderedVoicePlayers(messageId, scope = '') {
    const selector = `[data-voice-player][data-message-id="${String(messageId)}"]${scope ? `[data-message-scope="${escapeCssValue(scope)}"]` : ''}`;
    return Array.from(document.querySelectorAll?.(selector) || []);
  }

  function syncAllVoicePlayers() {
    document.querySelectorAll?.('[data-voice-player]').forEach((player) => syncVoicePlayerUi(player));
  }

  function updateVoicePlayerVisualState(player, state = {}) {
    if (!player) return;
    const btn = player.querySelector('[data-voice-toggle]');
    const progressBar = player.querySelector('.chatVoiceProgressBar');
    const durationEl = player.querySelector('[data-voice-duration]');
    const loadingEl = player.querySelector('.chatVoiceLoading');
    const errorEl = player.querySelector('.chatVoiceError');
    const isPlaying = !!state.isPlaying;
    if (btn) {
      btn.textContent = state.loading ? '…' : (isPlaying ? '❚❚' : '▶');
      btn.setAttribute('aria-label', state.loading ? 'Loading voice note' : (isPlaying ? 'Pause voice note' : 'Play voice note'));
      btn.disabled = !!state.loading;
    }
    const durationMs = Number(state.durationMs);
    if (durationEl && Number.isFinite(durationMs) && durationMs >= 0) {
      durationEl.textContent = formatChatVoiceDuration(durationMs);
    }
    const progress = Math.max(0, Math.min(100, Number(state.progressPct) || 0));
    if (progressBar) progressBar.style.width = `${progress}%`;
    if (loadingEl) {
      const loadingText = String(state.loadingText || '').trim();
      loadingEl.hidden = !loadingText;
      loadingEl.textContent = loadingText;
    }
    if (errorEl) {
      const errorText = String(state.errorText || '').trim();
      errorEl.hidden = !errorText;
      errorEl.textContent = errorText;
    }
    player.classList.toggle('is-loading', !!state.loading);
    player.classList.toggle('is-error', !!state.errorText);
    player.classList.toggle('is-playing', isPlaying);
    player.classList.toggle('is-active', !!state.isActive);
  }

  function syncVoicePlayerUi(player) {
    if (!player) return;
    const message = buildVoicePlayerMessageFromDataset(player);
    const cacheEntry = voiceAssetCache.get(getVoiceAssetCacheKey(message));
    const isActive = isVoicePlaybackMessage(message?.id, String(player.dataset.messageScope || ''));
    const activeAudio = voicePlaybackRuntime.activeAudio;
    const activeDurationMs = isActive && Number.isFinite(activeAudio?.duration) && activeAudio.duration > 0
      ? Math.round(activeAudio.duration * 1000)
      : (Number(message?.audioDurationMs) || 0);
    const progressPct = isActive && activeAudio && Number.isFinite(activeAudio.duration) && activeAudio.duration > 0
      ? (activeAudio.currentTime / activeAudio.duration) * 100
      : 0;
    updateVoicePlayerVisualState(player, {
      durationMs: activeDurationMs,
      progressPct,
      loading: cacheEntry?.status === 'loading',
      loadingText: cacheEntry?.status === 'loading' ? 'Loading audio…' : '',
      errorText: cacheEntry?.status === 'error' ? (cacheEntry.error || 'Voice note unavailable.') : '',
      isPlaying: isActive && !!voicePlaybackRuntime.isPlaying,
      isActive,
    });
  }

  function renderVoiceNotePlayer(message, variant = 'chat') {
    const bubbleRole = message?.isOwn ? 'self' : 'other';
    const messageId = message?.id != null ? String(message.id) : `${variant}-${Math.random().toString(36).slice(2, 8)}`;
    const messageScope = variant === 'private' ? 'private' : (variant === 'driverProfile' ? 'profile-dm' : 'public');
    const durationText = formatChatVoiceDuration(message?.audioDurationMs);
    return `<div class="chatVoiceBubble ${bubbleRole} ${variant}" data-voice-player="${escapeHtml(messageId)}" data-message-id="${escapeHtml(messageId)}" data-message-scope="${escapeHtml(messageScope)}" data-audio-url="${escapeHtml(String(message?.audioUrl || ''))}" data-duration-ms="${escapeHtml(String(Number(message?.audioDurationMs || 0) || 0))}" data-audio-mime-type="${escapeHtml(String(message?.audioMimeType || ''))}" data-created-at="${escapeHtml(String(message?.createdAt || ''))}" data-display-name="${escapeHtml(String(message?.displayName || 'Driver'))}" data-voice-label="${escapeHtml(voiceNoteLabel(message))}" data-voice-own="${message?.isOwn ? '1' : '0'}" data-sender-user-id="${escapeHtml(String(message?.senderUserId || ''))}" data-recipient-user-id="${escapeHtml(String(message?.recipientUserId || ''))}">
      <button class="chatVoiceBtn" type="button" data-voice-toggle aria-label="Play voice note">▶</button>
      <div class="chatVoiceMeta">
        <div class="chatVoiceTitle">🎤 Voice note</div>
        <div class="chatVoiceDuration" data-voice-duration>${escapeHtml(durationText || '0:00')}</div>
        <div class="chatVoiceProgress"><div class="chatVoiceProgressBar"></div></div>
        <div class="chatVoiceLoading" hidden></div>
        <div class="chatVoiceError" hidden></div>
      </div>
    </div>`;
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

  function createNodeFromHtml(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html || '').trim();
    return tpl.content.firstElementChild || null;
  }

  function refreshVoicePlayersForMessage(message) {
    const messageId = parseMessageId(message?.id);
    if (messageId === null) return;
    getRenderedVoicePlayers(messageId).forEach((player) => syncVoicePlayerUi(player));
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

  async function startSharedVoicePlaybackForMessage(player, message) {
    const messageId = parseMessageId(message?.id);
    const scope = String(player?.dataset?.messageScope || 'public').trim();
    const audioUrl = String(message?.audioUrl || '').trim();
    const audio = voicePlaybackRuntime.activeAudio;
    const alreadyActive = isVoicePlaybackMessage(messageId, scope);
    try {
      if (alreadyActive && voicePlaybackRuntime.isPlaying) {
        voicePlaybackRuntime.lastUserAction = 'pause';
        stopSharedVoicePlayback('user', { resetPosition: false, clearActive: false });
        return;
      }
      updateVoicePlayerVisualState(player, {
        durationMs: Number(message?.audioDurationMs) || 0,
        progressPct: alreadyActive && Number.isFinite(audio?.duration) && audio.duration > 0 ? (audio.currentTime / audio.duration) * 100 : 0,
        loading: true,
        loadingText: 'Loading audio…',
        errorText: '',
        isPlaying: false,
        isActive: true,
      });
      const blobUrl = await ensureVoiceBlobUrl(message);
      if (!blobUrl) {
        syncVoicePlayerUi(player);
        return;
      }
      const switchingMessages = !alreadyActive && parseMessageId(voicePlaybackRuntime.activeMessageId) !== null;
      if (switchingMessages) stopSharedVoicePlayback('switch', { resetPosition: true, clearActive: true });
      if (!alreadyActive) {
        try { audio.currentTime = 0; } catch (_) {}
      }
      if (audio.src !== blobUrl) audio.src = blobUrl;
      voicePlaybackRuntime.activeMessageId = messageId;
      voicePlaybackRuntime.activeScope = scope;
      voicePlaybackRuntime.activeBlobUrl = blobUrl;
      voicePlaybackRuntime.activeAudioUrl = audioUrl;
      voicePlaybackRuntime.lastPauseReason = 'play';
      voicePlaybackRuntime.lastUserAction = 'play';
      await audio.play();
      syncAllVoicePlayers();
    } catch (error) {
      console.warn('voice playback failed', { message, error });
      const cacheKey = getVoiceAssetCacheKey(message);
      const entry = voiceAssetCache.get(cacheKey) || {};
      voiceAssetCache.set(cacheKey, {
        ...entry,
        status: 'error',
        error: 'Unable to play voice note right now.',
      });
      syncAllVoicePlayers();
    }
  }

  function bindSharedVoicePlaybackEvents() {
    if (voicePlaybackRuntime.eventsBound) return;
    voicePlaybackRuntime.eventsBound = true;
    voicePlaybackAudio.addEventListener('play', () => {
      voicePlaybackRuntime.isPlaying = true;
      voicePlaybackRuntime.currentTime = Number.isFinite(voicePlaybackAudio.currentTime) ? voicePlaybackAudio.currentTime : 0;
      voicePlaybackRuntime.activeBlobUrl = String(voicePlaybackAudio.currentSrc || voicePlaybackAudio.src || voicePlaybackRuntime.activeBlobUrl || '').trim();
      voicePlaybackRuntime.suppressTonesUntil = Date.now() + 250;
      syncAllVoicePlayers();
      syncAllVoiceRecorderUis();
    });
    voicePlaybackAudio.addEventListener('pause', () => {
      voicePlaybackRuntime.currentTime = Number.isFinite(voicePlaybackAudio.currentTime) ? voicePlaybackAudio.currentTime : voicePlaybackRuntime.currentTime;
      voicePlaybackRuntime.isPlaying = false;
      if (voicePlaybackRuntime.lastPauseReason === 'switch' || voicePlaybackRuntime.lastPauseReason === 'stop') {
        voicePlaybackRuntime.currentTime = 0;
      }
      syncAllVoicePlayers();
      syncAllVoiceRecorderUis();
      if (voicePlaybackRuntime.lastPauseReason === 'user' || voicePlaybackRuntime.lastPauseReason === 'switch' || voicePlaybackRuntime.lastPauseReason === 'stop') {
        void flushPendingChatTones();
      }
    });
    voicePlaybackAudio.addEventListener('ended', () => {
      voicePlaybackRuntime.isPlaying = false;
      voicePlaybackRuntime.currentTime = 0;
      voicePlaybackRuntime.lastPauseReason = 'ended';
      try { voicePlaybackAudio.currentTime = 0; } catch (_) {}
      syncAllVoicePlayers();
      syncAllVoiceRecorderUis();
      void flushPendingChatTones();
    });
    voicePlaybackAudio.addEventListener('timeupdate', () => {
      voicePlaybackRuntime.currentTime = Number.isFinite(voicePlaybackAudio.currentTime) ? voicePlaybackAudio.currentTime : voicePlaybackRuntime.currentTime;
      const players = getRenderedVoicePlayers(voicePlaybackRuntime.activeMessageId, voicePlaybackRuntime.activeScope);
      players.forEach((player) => syncVoicePlayerUi(player));
    });
    voicePlaybackAudio.addEventListener('loadedmetadata', () => syncAllVoicePlayers());
    voicePlaybackAudio.addEventListener('waiting', () => syncAllVoicePlayers());
    voicePlaybackAudio.addEventListener('stalled', () => syncAllVoicePlayers());
    voicePlaybackAudio.addEventListener('seeking', () => {
      voicePlaybackRuntime.isSeeking = true;
    });
    voicePlaybackAudio.addEventListener('seeked', () => {
      voicePlaybackRuntime.isSeeking = false;
      syncAllVoicePlayers();
    });
    voicePlaybackAudio.addEventListener('error', () => {
      const key = `${parseMessageId(voicePlaybackRuntime.activeMessageId) === null ? 'unknown' : voicePlaybackRuntime.activeMessageId}::${String(voicePlaybackRuntime.activeAudioUrl || '').trim()}`;
      const entry = voiceAssetCache.get(key) || {};
      voiceAssetCache.set(key, {
        ...entry,
        status: 'error',
        error: entry.error || 'Unable to play voice note right now.',
      });
      syncAllVoicePlayers();
    });
  }

  function bindVoicePlayer(player) {
    if (!player || player.dataset.voiceBound === '1') return;
    player.dataset.voiceBound = '1';
    const btn = player.querySelector('[data-voice-toggle]');
    if (!btn) return;
    bindSharedVoicePlaybackEvents();
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const message = buildVoicePlayerMessageFromDataset(player);
      void startSharedVoicePlaybackForMessage(player, message);
    });
    syncVoicePlayerUi(player);
  }

  function bindVoicePlayers(root = document) {
    bindSharedVoicePlaybackEvents();
    root.querySelectorAll?.('[data-voice-player]').forEach(bindVoicePlayer);
  }

  async function preserveVoicePlaybackAcrossRender(renderFn) {
    renderFn();
    syncAllVoicePlayers();
  }


  function getVoiceRecorderState(scope) {
    const stateScope = voiceScopeStateKey(scope);
    const isActive = !!stateScope && chatVoiceState.scope === stateScope;
    return {
      ...chatVoiceState,
      scope: stateScope,
      isActive,
      recorder: isActive ? chatVoiceState.recorder : null,
      stream: isActive ? chatVoiceState.stream : null,
      chunks: isActive ? chatVoiceState.chunks : [],
      draft: chatVoiceDraftState.scope === stateScope ? { ...chatVoiceDraftState } : null,
    };
  }

  function getChatVoiceDraft(scope) {
    const stateScope = voiceScopeStateKey(scope);
    if (!stateScope || chatVoiceDraftState.scope !== stateScope || chatVoiceDraftState.status === 'idle') return null;
    return chatVoiceDraftState;
  }

  function hasChatVoiceDraft(scope) {
    return !!getChatVoiceDraft(scope);
  }

  function clearChatVoiceDraft(reason = 'clear') {
    if (chatVoiceDraftState.objectUrl && voicePlaybackAudio.src === chatVoiceDraftState.objectUrl) {
      stopSharedVoicePlayback('draft-clear', { resetPosition: true, clearActive: true });
      try { voicePlaybackAudio.removeAttribute('src'); } catch (_) {}
    }
    if (chatVoiceDraftState.objectUrl) {
      try { URL.revokeObjectURL(chatVoiceDraftState.objectUrl); } catch (_) {}
    }
    chatVoiceDraftState.status = 'idle';
    chatVoiceDraftState.blob = null;
    chatVoiceDraftState.file = null;
    chatVoiceDraftState.mimeType = '';
    chatVoiceDraftState.durationMs = 0;
    chatVoiceDraftState.objectUrl = '';
    chatVoiceDraftState.startedAt = 0;
    chatVoiceDraftState.scope = '';
    chatVoiceDraftState.room = '';
    chatVoiceDraftState.otherUserId = '';
    chatVoiceDraftState.error = '';
  }

  function setChatVoiceDraft(scope, blob, options = {}) {
    const normalizedScope = voiceScopeStateKey(scope);
    clearChatVoiceDraft('replace');
    const mimeType = String(options.mimeType || blob?.type || '').trim() || 'audio/mp4';
    const safeBlob = blob instanceof Blob ? blob : new Blob([], { type: mimeType });
    chatVoiceDraftState.status = 'ready';
    chatVoiceDraftState.blob = safeBlob;
    chatVoiceDraftState.file = buildChatVoiceUploadFile(safeBlob, mimeType);
    chatVoiceDraftState.mimeType = mimeType;
    chatVoiceDraftState.durationMs = Math.max(0, Math.round(Number(options.durationMs) || 0));
    chatVoiceDraftState.objectUrl = URL.createObjectURL(safeBlob);
    chatVoiceDraftState.startedAt = Number(options.startedAt || Date.now()) || Date.now();
    chatVoiceDraftState.scope = normalizedScope;
    chatVoiceDraftState.room = String(options.room || '');
    chatVoiceDraftState.otherUserId = options.userId == null ? '' : String(options.userId);
    chatVoiceDraftState.error = '';
  }

  function getVoiceComposerInput(scope) {
    const normalizedScope = voiceScopeStateKey(scope);
    if (normalizedScope === 'public') return document.getElementById('chatInput');
    if (normalizedScope === 'private') return document.getElementById('chatPrivateInput');
    if (normalizedScope === 'profile-dm') return document.getElementById('driverProfileInput');
    return null;
  }

  function getVoiceComposerSendButton(scope) {
    const normalizedScope = voiceScopeStateKey(scope);
    if (normalizedScope === 'public') return document.getElementById('chatSendBtn');
    if (normalizedScope === 'private') return document.getElementById('chatPrivateSendBtn');
    if (normalizedScope === 'profile-dm') return document.getElementById('driverProfileSendBtn');
    return null;
  }

  function setVoiceRecorderStatus(scope, text = '', errorText = '') {
    const stateScope = voiceScopeStateKey(scope);
    if (!stateScope || chatVoiceState.scope === stateScope || !chatVoiceState.scope || chatVoiceDraftState.scope === stateScope) {
      chatVoiceState.statusText = String(text || '').trim() || CHAT_VOICE_IDLE_STATUS;
      chatVoiceState.errorText = String(errorText || '').trim();
      chatVoiceState.lastError = chatVoiceState.errorText;
      if (chatVoiceDraftState.scope === stateScope) chatVoiceDraftState.error = chatVoiceState.errorText;
    }
    const domKey = voiceScopeDomKey(scope);
    const statusEl = document.getElementById(`${domKey}VoiceStatus`);
    const errorEl = document.getElementById(`${domKey}VoiceError`);
    if (statusEl) statusEl.textContent = String(text || '').trim() || CHAT_VOICE_IDLE_STATUS;
    if (errorEl) {
      const nextError = String(errorText || '').trim();
      errorEl.textContent = nextError;
      errorEl.hidden = !nextError;
    }
  }

  function syncVoiceComposerTextLock(scope) {
    const input = getVoiceComposerInput(scope);
    if (!input) return;
    if (!input.dataset.voicePlaceholderDefault) input.dataset.voicePlaceholderDefault = input.getAttribute('placeholder') || '';
    const draft = getChatVoiceDraft(scope);
    const lockInput = !!draft && (draft.status === 'ready' || draft.status === 'sending');
    input.disabled = lockInput;
    input.setAttribute('placeholder', lockInput ? CHAT_VOICE_TEXT_LOCK_PLACEHOLDER : (input.dataset.voicePlaceholderDefault || ''));
  }

  function syncVoiceComposerSendButton(scope) {
    const sendBtn = getVoiceComposerSendButton(scope);
    if (!sendBtn) return;
    const stateScope = voiceScopeStateKey(scope);
    const isRecordingScope = chatVoiceState.scope === stateScope && (chatVoiceState.phase === 'recording' || chatVoiceState.phase === 'stopping' || chatVoiceState.phase === 'requesting' || chatVoiceState.phase === 'preparing');
    const draft = getChatVoiceDraft(scope);
    const isUploadingDraft = !!draft && draft.status === 'sending';
    sendBtn.disabled = isRecordingScope || isUploadingDraft;
  }

  function syncVoiceRecorderUi(scope) {
    const domKey = voiceScopeDomKey(scope);
    const stateScope = voiceScopeStateKey(scope);
    const isActive = !!stateScope && chatVoiceState.scope === stateScope;
    const isRecording = isActive && chatVoiceState.phase === 'recording';
    const isStopping = isActive && chatVoiceState.phase === 'stopping';
    const draft = getChatVoiceDraft(scope);
    const isDraftReady = !!draft && draft.status === 'ready';
    const isDraftSending = !!draft && draft.status === 'sending';
    const startBtn = document.getElementById(`${domKey}VoiceStartBtn`);
    const stopBtn = document.getElementById(`${domKey}VoiceStopBtn`);
    const cancelBtn = document.getElementById(`${domKey}VoiceCancelBtn`);
    const timerEl = document.getElementById(`${domKey}VoiceTimer`);
    const uploadEl = document.getElementById(`${domKey}VoiceUpload`);
    const statusEl = document.getElementById(`${domKey}VoiceStatus`);
    const errorEl = document.getElementById(`${domKey}VoiceError`);
    const draftWrap = document.getElementById(`${domKey}VoiceDraft`);
    const draftDurationEl = document.getElementById(`${domKey}VoiceDraftDuration`);
    const draftSendBtn = document.getElementById(`${domKey}VoiceDraftSendBtn`);
    const draftCancelBtn = document.getElementById(`${domKey}VoiceDraftCancelBtn`);
    const draftPreviewBtn = document.getElementById(`${domKey}VoiceDraftPreviewBtn`);
    const canStart = !isRecording && !isStopping && !isDraftSending;
    if (startBtn) {
      startBtn.hidden = isRecording || isStopping;
      startBtn.disabled = !canStart;
      startBtn.classList.toggle('busy', !canStart && !isDraftReady);
      startBtn.classList.toggle('recording', isRecording);
      startBtn.textContent = isDraftReady ? 'Re-record' : '🎤';
    }
    if (stopBtn) {
      stopBtn.hidden = !isRecording;
      stopBtn.disabled = !isRecording;
      stopBtn.classList.toggle('busy', isStopping);
    }
    if (cancelBtn) {
      cancelBtn.hidden = !(isRecording || isStopping);
      cancelBtn.disabled = isStopping;
      cancelBtn.classList.toggle('busy', isStopping);
    }
    if (timerEl) {
      timerEl.textContent = isRecording
        ? formatChatVoiceDuration(chatVoiceState.durationMs)
        : (isDraftReady || isDraftSending ? formatChatVoiceDuration(draft?.durationMs || 0) : '0:00');
    }
    if (uploadEl) {
      uploadEl.hidden = !isDraftSending;
      uploadEl.textContent = isDraftSending ? 'Uploading voice note…' : '';
    }
    if (statusEl) {
      if (isRecording) statusEl.textContent = 'Recording voice note…';
      else if (isDraftSending) statusEl.textContent = 'Uploading voice note…';
      else if (isDraftReady) statusEl.textContent = String(chatVoiceState.statusText || 'Voice note ready. Tap Send to send the voice note.').trim() || 'Voice note ready. Tap Send to send the voice note.';
      else if (!statusEl.textContent.trim()) statusEl.textContent = CHAT_VOICE_IDLE_STATUS;
    }
    if (errorEl) {
      const nextError = String((draft?.error || (isActive ? chatVoiceState.errorText : '')) || '').trim();
      errorEl.textContent = nextError;
      errorEl.hidden = !nextError;
    }
    if (draftWrap) draftWrap.hidden = !(isDraftReady || isDraftSending);
    if (draftDurationEl) draftDurationEl.textContent = formatChatVoiceDuration(draft?.durationMs || 0);
    if (draftSendBtn) {
      draftSendBtn.disabled = !isDraftReady || isDraftSending;
      draftSendBtn.hidden = !isDraftReady && !isDraftSending;
    }
    if (draftCancelBtn) {
      draftCancelBtn.disabled = isDraftSending;
      draftCancelBtn.hidden = !isDraftReady && !isDraftSending;
    }
    if (draftPreviewBtn) {
      const previewPlaying = !!(draft?.objectUrl && voicePlaybackRuntime.lastUserAction === `draft:${stateScope}` && !voicePlaybackAudio.paused && voicePlaybackAudio.src === draft.objectUrl);
      draftPreviewBtn.dataset.previewPlaying = previewPlaying ? '1' : '0';
      draftPreviewBtn.hidden = !isDraftReady && !isDraftSending;
      draftPreviewBtn.disabled = !draft?.objectUrl || isDraftSending;
      draftPreviewBtn.textContent = previewPlaying ? 'Pause' : 'Play';
    }
    syncVoiceComposerTextLock(scope);
    syncVoiceComposerSendButton(scope);
  }

  function syncAllVoiceRecorderUis() {
    syncVoiceRecorderUi('public');
    syncVoiceRecorderUi('private');
    syncVoiceRecorderUi('driverProfile');
  }

  function stopChatVoiceTracks() {
    try {
      chatVoiceState.stream?.getTracks?.().forEach((track) => track.stop());
    } catch (_) {}
    chatVoiceState.stream = null;
  }

  function resetChatVoiceState() {
    if (chatVoiceState.timerId) {
      window.clearInterval(chatVoiceState.timerId);
      chatVoiceState.timerId = null;
    }
    chatVoiceState.recorder = null;
    chatVoiceState.chunks = [];
    chatVoiceState.startedAt = 0;
    chatVoiceState.mimeType = '';
    chatVoiceState.durationMs = 0;
    chatVoiceState.scope = '';
    chatVoiceState.room = '';
    chatVoiceState.otherUserId = '';
    chatVoiceState.statusText = CHAT_VOICE_IDLE_STATUS;
    chatVoiceState.errorText = '';
    chatVoiceState.cancelRequested = false;
    chatVoiceState.phase = 'idle';
  }


  function mapChatVoiceError(err) {
    const name = String(err?.name || '');
    const rawMessage = String(err?.message || '');
    const lowered = rawMessage.toLowerCase();
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
      return 'Microphone permission was denied.';
    }
    if (name === 'NotFoundError') {
      return 'No microphone was found.';
    }
    if (name === 'NotReadableError' || name === 'AbortError' || lowered.includes('audiosession category is not compatible with audio capture') || lowered.includes('incompatiblecategory')) {
      return 'iPhone audio mode was wrong for recording. Audio was reset. Tap mic again.';
    }
    if (rawMessage) return 'Unable to start voice recording right now.';
    return 'Unable to start voice recording right now.';
  }

  async function uploadChatVoiceNote(scope, blob, durationMs, options = {}) {
    const normalizedScope = voiceScopeStateKey(scope);
    const mimeType = String(options.mimeType || chatVoiceDraftState.mimeType || chatVoiceState.mimeType || blob?.type || '').trim();
    if (normalizedScope === 'public') {
      return await chatSendPublicVoiceNote(blob, durationMs, mimeType, options.room || CHAT_ROOM);
    }
    if (normalizedScope === 'private' || normalizedScope === 'profile-dm') {
      return await chatSendPrivateVoiceNote(options.userId, blob, durationMs, mimeType);
    }
    throw new Error('Voice notes are not available here.');
  }

  async function sendChatVoiceDraft(scope, options = {}) {
    const normalizedScope = voiceScopeStateKey(scope);
    const domScope = normalizedScope === 'profile-dm' ? 'driverProfile' : normalizedScope;
    const draft = getChatVoiceDraft(scope);
    if (!draft || draft.status !== 'ready' || !draft.blob) return false;
    chatVoiceDraftState.status = 'sending';
    chatVoiceDraftState.error = '';
    setVoiceRecorderStatus(domScope, 'Uploading voice note…', '');
    syncAllVoiceRecorderUis();
    try {
      const response = await uploadChatVoiceNote(normalizedScope, draft.blob, draft.durationMs, {
        ...options,
        room: draft.room || options.room,
        userId: draft.otherUserId || options.userId,
        mimeType: draft.mimeType || options.mimeType,
      });
      if (typeof options.onUploaded === 'function') {
        await options.onUploaded(response, { blob: draft.blob, durationMs: draft.durationMs, scope: normalizedScope });
      }
      clearChatVoiceDraft('sent');
      setVoiceRecorderStatus(domScope, CHAT_VOICE_IDLE_STATUS, '');
      syncAllVoiceRecorderUis();
      return true;
    } catch (err) {
      console.warn('voice note upload failed', err);
      chatVoiceDraftState.status = 'ready';
      chatVoiceDraftState.error = 'Voice upload failed. Please try again.';
      setVoiceRecorderStatus(domScope, 'Voice note ready', chatVoiceDraftState.error);
      syncAllVoiceRecorderUis();
      throw err;
    }
  }

  async function discardChatVoiceDraft(scope, reason = 'Voice note discarded') {
    const normalizedScope = voiceScopeStateKey(scope);
    if (!normalizedScope) return false;
    const domScope = normalizedScope === 'profile-dm' ? 'driverProfile' : normalizedScope;
    const draft = getChatVoiceDraft(scope);
    if (!draft && chatVoiceState.scope !== normalizedScope) return false;
    clearChatVoiceDraft('discard');
    setVoiceRecorderStatus(domScope, CHAT_VOICE_IDLE_STATUS, '');
    syncAllVoiceRecorderUis();
    return true;
  }

  async function toggleChatVoiceDraftPreview(scope, button) {
    const normalizedScope = voiceScopeStateKey(scope);
    const draft = getChatVoiceDraft(scope);
    if (!draft?.objectUrl) return false;
    try {
      if (voicePlaybackRuntime.lastUserAction === `draft:${normalizedScope}` && !voicePlaybackAudio.paused && voicePlaybackAudio.src === draft.objectUrl) {
        voicePlaybackRuntime.lastPauseReason = 'user';
        voicePlaybackAudio.pause();
        if (button) button.dataset.previewPlaying = '0';
        syncVoiceRecorderUi(scope);
        return true;
      }
      stopSharedVoicePlayback('preview-switch', { resetPosition: true, clearActive: true });
      if (voicePlaybackAudio.src !== draft.objectUrl) voicePlaybackAudio.src = draft.objectUrl;
      voicePlaybackRuntime.lastUserAction = `draft:${normalizedScope}`;
      await voicePlaybackAudio.play();
      if (button) button.dataset.previewPlaying = '1';
      syncVoiceRecorderUi(scope);
      return true;
    } catch (err) {
      if (button) button.dataset.previewPlaying = '0';
      chatVoiceDraftState.error = 'Unable to preview voice note right now.';
      syncVoiceRecorderUi(scope);
      return false;
    }
  }

  async function startChatVoiceRecording(scope, options = {}) {
    const normalizedScope = voiceScopeStateKey(scope);
    const domScope = normalizedScope === 'profile-dm' ? 'driverProfile' : normalizedScope;
    if (!normalizedScope) return false;
    if (!chatSupportsVoiceRecording()) {
      setVoiceRecorderStatus(domScope, CHAT_VOICE_IDLE_STATUS, 'Voice notes are not supported on this browser.');
      syncAllVoiceRecorderUis();
      return false;
    }
    if (isChatVoiceBusy()) {
      setVoiceRecorderStatus(domScope, chatVoiceState.statusText || 'Finish current voice note first', 'Finish the current voice note first.');
      syncAllVoiceRecorderUis();
      return false;
    }
    if (hasChatVoiceDraft(normalizedScope)) clearChatVoiceDraft('re-record');

    await prepareChatAudioForCapture(`${normalizedScope}-voice-start`);
    chatVoiceState.scope = normalizedScope;
    chatVoiceState.room = String(options.room || CHAT_ROOM || '');
    chatVoiceState.otherUserId = options.userId == null ? '' : String(options.userId);
    chatVoiceState.mimeType = chooseChatVoiceMimeType();
    chatVoiceState.cancelRequested = false;
    chatVoiceState.durationMs = 0;
    setVoiceRecorderStatus(domScope, 'Requesting microphone…', '');
    syncAllVoiceRecorderUis();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chatVoiceState.stream = stream;
      chatVoiceState.recorder = chatVoiceState.mimeType
        ? new MediaRecorder(stream, { mimeType: chatVoiceState.mimeType })
        : new MediaRecorder(stream);
      chatVoiceState.mimeType = chatVoiceState.mimeType || chatVoiceState.recorder.mimeType || '';
      chatVoiceState.chunks = [];
      chatVoiceState.startedAt = Date.now();
      chatVoiceState.phase = 'recording';
      setVoiceRecorderStatus(domScope, 'Recording voice note…', '');
      chatVoiceState.recorder.addEventListener('dataavailable', (event) => {
        if (event.data && event.data.size > 0) chatVoiceState.chunks.push(event.data);
      });
      chatVoiceState.recorder.addEventListener('stop', () => {
        const finalizeScope = chatVoiceState.scope || normalizedScope;
        const finalizeOptions = { ...options, room: chatVoiceState.room || options.room, userId: chatVoiceState.otherUserId || options.userId };
        void (async () => {
          const domTarget = finalizeScope === 'profile-dm' ? 'driverProfile' : finalizeScope;
          const durationMs = Math.max(0, Date.now() - Number(chatVoiceState.startedAt || 0));
          const chunks = chatVoiceState.chunks.slice();
          const mimeType = chatVoiceState.mimeType || chatVoiceState.recorder?.mimeType || 'audio/mp4';
          const startedAt = chatVoiceState.startedAt || Date.now();
          const canceled = !!chatVoiceState.cancelRequested;
          if (canceled || !chunks.length) {
            await restoreChatAudioAfterCapture('voice-stop-cancel');
            clearChatVoiceDraft('stop-cancel');
            setVoiceRecorderStatus(domTarget, CHAT_VOICE_IDLE_STATUS, '');
            syncAllVoiceRecorderUis();
            return;
          }
          const safeDurationMs = Math.min(durationMs, VOICE_NOTE_MAX_MS);
          const blob = new Blob(chunks, { type: mimeType });
          setChatVoiceDraft(finalizeScope, blob, {
            mimeType,
            durationMs: safeDurationMs,
            startedAt,
            room: finalizeOptions.room,
            userId: finalizeOptions.userId,
          });
          await restoreChatAudioAfterCapture('voice-stop-draft-ready');
          setVoiceRecorderStatus(domTarget, safeDurationMs >= VOICE_NOTE_MAX_MS ? CHAT_VOICE_MAX_REACHED_STATUS : 'Voice note ready. Tap Send to send the voice note.', '');
          syncAllVoiceRecorderUis();
        })().catch((err) => {
          console.warn('voice note finish failed', err);
        });
      }, { once: true });
      chatVoiceState.recorder.start();
      chatVoiceState.timerId = window.setInterval(() => {
        const elapsed = Math.max(0, Date.now() - chatVoiceState.startedAt);
        const cappedElapsed = Math.min(elapsed, VOICE_NOTE_MAX_MS);
        chatVoiceState.durationMs = cappedElapsed;
        setVoiceRecorderStatus(domScope, 'Recording voice note…', '');
        syncAllVoiceRecorderUis();
        if (elapsed >= VOICE_NOTE_MAX_MS && chatVoiceState.recorder?.state === 'recording') {
          chatVoiceState.durationMs = VOICE_NOTE_MAX_MS;
          void stopChatVoiceRecording();
        }
      }, 250);
      syncAllVoiceRecorderUis();
      return true;
    } catch (err) {
      const rawMessage = String(err?.message || '');
      const lowered = rawMessage.toLowerCase();
      if (lowered.includes('audiosession category is not compatible with audio capture')) {
        await restoreChatAudioAfterCapture('incompatible-category');
      } else {
        stopChatVoiceTracks();
        await restoreChatAudioAfterCapture('voice-start-error');
      }
      const friendlyMessage = mapChatVoiceError(err);
      chatVoiceState.lastError = friendlyMessage;
      setVoiceRecorderStatus(domScope, CHAT_VOICE_IDLE_STATUS, friendlyMessage);
      syncAllVoiceRecorderUis();
      return false;
    }
  }

  async function stopChatVoiceRecording() {
    if (!chatVoiceState.recorder || chatVoiceState.phase !== 'recording') return false;
    chatVoiceState.phase = 'stopping';
    chatVoiceState.durationMs = Math.max(0, Date.now() - Number(chatVoiceState.startedAt || 0));
    syncAllVoiceRecorderUis();
    try {
      chatVoiceState.recorder.stop();
      return true;
    } catch (err) {
      await restoreChatAudioAfterCapture('voice-stop-error');
      const domScope = chatVoiceState.scope === 'profile-dm' ? 'driverProfile' : chatVoiceState.scope;
      setVoiceRecorderStatus(domScope, CHAT_VOICE_IDLE_STATUS, 'Voice note failed to stop cleanly.');
      syncAllVoiceRecorderUis();
      return false;
    }
  }

  async function cancelChatVoiceRecording(reason = 'Recording canceled') {
    const activeScope = chatVoiceState.scope;
    const domScope = activeScope === 'profile-dm' ? 'driverProfile' : activeScope;
    chatVoiceState.cancelRequested = true;
    chatVoiceState.chunks = [];
    if (domScope) setVoiceRecorderStatus(domScope, reason, '');
    if (chatVoiceState.recorder && chatVoiceState.recorder.state === 'recording') {
      chatVoiceState.phase = 'stopping';
      syncAllVoiceRecorderUis();
      try {
        chatVoiceState.recorder.stop();
        return true;
      } catch (_) {}
    }
    if (activeScope) clearChatVoiceDraft('cancel');
    await restoreChatAudioAfterCapture('voice-cancel');
    if (domScope) setVoiceRecorderStatus(domScope, CHAT_VOICE_IDLE_STATUS, '');
    syncAllVoiceRecorderUis();
    return true;
  }

  function startVoiceRecording(scope, options) {
    return startChatVoiceRecording(scope, options);
  }

  function cancelVoiceRecording(scope) {
    const normalizedScope = voiceScopeStateKey(scope);
    if (!normalizedScope) return false;
    if (chatVoiceState.scope === normalizedScope) return cancelChatVoiceRecording('Recording canceled');
    if (chatVoiceDraftState.scope === normalizedScope) return discardChatVoiceDraft(normalizedScope, 'Voice note discarded');
    return false;
  }

  function stopActiveVoiceRecording(scope) {
    const normalizedScope = voiceScopeStateKey(scope);
    if (!normalizedScope || chatVoiceState.scope !== normalizedScope) return false;
    return stopChatVoiceRecording();
  }

  function bindVoiceComposerControls(surface, optionsFactory) {
    const startBtn = document.getElementById(`${surface}VoiceStartBtn`);
    const stopBtn = document.getElementById(`${surface}VoiceStopBtn`);
    const cancelBtn = document.getElementById(`${surface}VoiceCancelBtn`);
    const draftPreviewBtn = document.getElementById(`${surface}VoiceDraftPreviewBtn`);
    const draftCancelBtn = document.getElementById(`${surface}VoiceDraftCancelBtn`);
    const draftSendBtn = document.getElementById(`${surface}VoiceDraftSendBtn`);
    if (startBtn?.dataset.voiceComposerBound === '1') {
      syncVoiceRecorderUi(surface);
      return;
    }
    if (startBtn) startBtn.dataset.voiceComposerBound = '1';
    const stopEvent = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    startBtn?.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const options = typeof optionsFactory === 'function' ? optionsFactory() : {};
      await startChatVoiceRecording(surface, options);
    });
    stopBtn?.addEventListener('click', (event) => {
      stopEvent(event);
      void stopActiveVoiceRecording(surface);
    });
    cancelBtn?.addEventListener('click', (event) => {
      stopEvent(event);
      void cancelVoiceRecording(surface);
    });
    draftCancelBtn?.addEventListener('click', (event) => {
      stopEvent(event);
      void discardChatVoiceDraft(surface);
    });
    draftSendBtn?.addEventListener('click', async (event) => {
      stopEvent(event);
      const options = typeof optionsFactory === 'function' ? optionsFactory() : {};
      try {
        await sendChatVoiceDraft(surface, options);
      } catch (_) {}
    });
    draftPreviewBtn?.addEventListener('click', (event) => {
      stopEvent(event);
      void toggleChatVoiceDraftPreview(surface, draftPreviewBtn);
    });
    syncVoiceRecorderUi(surface);
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


  const MAP_IDENTITY_MODE_NAME = 'name';
  const MAP_IDENTITY_MODE_AVATAR = 'avatar';
  const MAP_IDENTITY_IMG_SIZE = 160;
  const MAP_IDENTITY_CROP_VIEW_SIZE = 220;
  const MAP_IDENTITY_MIN_ZOOM = 10;
  const MAP_IDENTITY_MAX_ZOOM = 16;
  let mapIdentityTempAvatarDataUrl = '';
  let mapIdentitySavedAvatarDataUrl = '';
  let mapIdentityCropState = null;

  function clampMapIdentity(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function normalizeMapIdentityMode(mode) {
    return mode === MAP_IDENTITY_MODE_AVATAR ? MAP_IDENTITY_MODE_AVATAR : MAP_IDENTITY_MODE_NAME;
  }

  function safeMapAvatarUrl(url) {
    const resolver = window.resolveMapAvatarUrl;
    if (typeof resolver === 'function') return resolver(url);
    if (typeof url !== 'string') return '';
    const trimmed = url.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('data:image/')) return trimmed;
    return '';
  }

  function syncMapIdentitySavedAvatarCache() {
    const serverAvatar = safeMapAvatarUrl(window?.me?.avatar_url);
    if (serverAvatar) {
      mapIdentitySavedAvatarDataUrl = serverAvatar;
      return serverAvatar;
    }
    return '';
  }

  function mapIdentityZoomT(zoomValue) {
    const z = Number.isFinite(zoomValue)
      ? zoomValue
      : (Number.isFinite(window?.map?.getZoom?.()) ? window.map.getZoom() : 12);
    const t = (z - MAP_IDENTITY_MIN_ZOOM) / (MAP_IDENTITY_MAX_ZOOM - MAP_IDENTITY_MIN_ZOOM);
    return clampMapIdentity(t, 0, 1);
  }

  function mapIdentityVisualConfig(zoomValue) {
    const t = mapIdentityZoomT(zoomValue);
    const smooth = t * t * (3 - 2 * t);
    const emphasize = Math.pow(smooth, 0.9);
    const avatarPx = +(18 + (52 - 18) * emphasize).toFixed(2);
    const tipSizePx = +(4 + (8 - 4) * emphasize).toFixed(2);
    const crownPx = clampMapIdentity(Math.round(avatarPx * 0.76), 18, 32);
    const podiumPx = clampMapIdentity(Math.round(avatarPx * 0.40), 12, 18);
    return {
      avatarPx,
      crownPx,
      podiumPx,
      crownLiftPx: Math.round(crownPx * 0.36),
      rootPx: +(30 + (66 - 30) * emphasize).toFixed(2),
      tipSizePx,
      tipOrbitPx: +((avatarPx * 0.5) - 1 + (tipSizePx * 0.1)).toFixed(2),
      initialsFontPx: +(8 + (18 - 8) * emphasize).toFixed(2),
      badgeFontPx: +(13 + (17 - 13) * emphasize).toFixed(2),
      arrowBodyPx: +(18 + (27 - 18) * t).toFixed(2),
      arrowLeftRightPx: +(4.5 + (7 - 4.5) * t).toFixed(2),
      arrowAccentPx: +(10 + (14 - 10) * t).toFixed(2)
    };
  }

  function mapIdentityBadgeSizeConfig(avatarPx) {
    const baseAvatar = Number(avatarPx);
    const safeAvatarPx = Number.isFinite(baseAvatar) ? baseAvatar : 28;
    const crownPx = clampMapIdentity(Math.round(safeAvatarPx * 0.76), 18, 32);
    const podiumPx = clampMapIdentity(Math.round(safeAvatarPx * 0.40), 12, 18);
    return {
      crownPx,
      podiumPx,
      crownLiftPx: Math.round(crownPx * 0.36)
    };
  }

  function shouldUseAvatarLabel(mode, avatarUrl) {
    return normalizeMapIdentityMode(mode) === MAP_IDENTITY_MODE_AVATAR && !!safeMapAvatarUrl(avatarUrl);
  }

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

  function mapIdentityBadgeOverlayHTML({ badgeCode, avatarPx, code }) {
    const meta = leaderboardBadgeMeta(badgeCode || code);
    if (!meta.code) return '';
    const badgeSizeCfg = mapIdentityBadgeSizeConfig(avatarPx);
    const size = meta.code === 'crown' ? badgeSizeCfg.crownPx : badgeSizeCfg.podiumPx;
    return `<span class="mapIdentityBadgeOverlay mapBadgeWearable ${meta.toneClass}" aria-label="${escapeHtml(meta.label)}">${renderLeaderboardBadgeSvg(meta.code, { size, mapWearable: true, compact: true })}</span>`;
  }

  function mapIdentityInitials(name) {
    const safe = String(name || '').trim();
    if (!safe) return 'D';
    const parts = safe.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return `${parts[0][0] || ''}${parts[1][0] || ''}`.toUpperCase();
    const compact = safe.replace(/[^\p{L}\p{N}]/gu, '');
    return (compact.slice(0, 2) || safe.slice(0, 2) || 'D').toUpperCase();
  }

  function mapIdentityPresenceCoreHTML({ markerClass, name, avatarUrl, cfg, leaderboardBadgeCode, orbitMeta = null, directionId = '' }) {
    const safeAvatar = safeMapAvatarUrl(avatarUrl);
    const avatarHTML = safeAvatar
      ? `<div class="mapPresenceAvatar"><img src="${escapeHtml(safeAvatar)}" alt="avatar" loading="lazy"></div>`
      : `<div class="mapPresenceInitials">${escapeHtml(mapIdentityInitials(name))}</div>`;
    const dirAttr = directionId ? ` id="${escapeHtml(directionId)}"` : '';
    const orbitAttrs = mapIdentityOrbitDataAttrs(orbitMeta);
    return `
      <div class="mapPresenceOrbit ${markerClass}" data-map-identity-label="1" data-map-presence-orbit="1" ${orbitAttrs}>
        <div class="mapPresenceRoot">
          <div class="mapPresenceDirectionRot"${dirAttr} aria-hidden="true">
          <span class="mapPresenceDirectionTip"></span>
          </div>
          <div class="mapPresenceShell" style="width:${cfg.avatarPx}px;height:${cfg.avatarPx}px;">
            ${avatarHTML}
          </div>
          <span class="mapPresenceBadgeOverlay">${mapIdentityBadgeOverlayHTML({ badgeCode: leaderboardBadgeCode, avatarPx: cfg.avatarPx })}</span>
        </div>
      </div>
    `;
  }

  function mapIdentityOverlayWrapHTML(coreHTML, badgeMeta = {}) {
    return `<div class="mapIdentityWrap"><div class="mapIdentityCore">${coreHTML}</div>${mapIdentityBadgeOverlayHTML(badgeMeta)}</div>`;
  }

  function mapIdentityAvatarLabelHTML(avatarUrl, className, styleText, badgeMeta = {}) {
    const safeUrl = escapeHtml(avatarUrl);
    return mapIdentityOverlayWrapHTML(
      `<div class="${className}" style="${styleText}" data-map-identity-label="1"><img src="${safeUrl}" alt="avatar" loading="lazy"></div>`,
      badgeMeta
    );
  }


  function mapIdentityOverlapBadgeHTML(overlapMeta) {
    const count = Number(overlapMeta?.count);
    const leader = !!overlapMeta?.leader;
    if (!Number.isFinite(count) || count <= 1 || !leader) return '';
    const extra = Math.max(0, Math.round(count) - 1);
    const text = extra > 0 ? `+${extra}` : `${Math.round(count)}`;
    return `<span class="mapIdentityOverlapBadge" style="position:absolute;top:-4px;right:-4px;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:#111;color:#fff;border:1px solid rgba(255,255,255,0.7);font-size:10px;line-height:14px;font-weight:700;text-align:center;pointer-events:none;">${escapeHtml(text)}</span>`;
  }

  function mapIdentityRenderSelfLabel({ name, avatarUrl, mode, zoom, leaderboardBadgeCode, orbitMeta = null, overlapMeta = null }) {
    const safeName = (String(name || 'Driver').trim() || 'Driver');
    const cfg = mapIdentityVisualConfig(zoom);
    const effectiveOrbitMeta = orbitMeta || overlapMeta || null;
    const slotSide = String(effectiveOrbitMeta?.side || '').trim();
    const sideClass = slotSide ? ` slot-${slotSide}` : '';
    return `<div class="selfIdentitySlot${sideClass}" data-map-identity-label="1">${mapIdentityPresenceCoreHTML({ markerClass: 'mapPresenceSelf', name: safeName, avatarUrl, cfg, leaderboardBadgeCode, directionId: 'navPresenceDirectionRot', orbitMeta: effectiveOrbitMeta })}</div>`;
  }

  function mapIdentityOrbitStyleText(orbitMeta, zoomValue) {
    const count = Number(orbitMeta?.count);
    if (!Number.isFinite(count) || count <= 1) return '';

    const angleRad = (Number(orbitMeta?.angleDeg) || 0) * (Math.PI / 180);
    const cfg = mapIdentityVisualConfig(zoomValue);
    const ring = Math.max(0, Number(orbitMeta?.ring) || 0);

    const baseRadiusPx = Math.max(16, (cfg.rootPx * 0.54));
    const ringGapPx = Math.max(12, cfg.rootPx * 0.42);

    const radius = baseRadiusPx + (ring * ringGapPx);
    const dx = +(Math.cos(angleRad) * radius).toFixed(2);
    const dy = +(Math.sin(angleRad) * radius).toFixed(2);

    return `--marker-slot-x:${dx}px;--marker-slot-y:${dy}px;`;
  }

  function mapIdentityOrbitDataAttrs(orbitMeta) {
    const idx = Number(orbitMeta?.index);
    const count = Number(orbitMeta?.count);
    const angle = Number(orbitMeta?.angleDeg);
    const ring = Number(orbitMeta?.ring);
    return [
      `data-orbit-index="${Number.isFinite(idx) ? Math.round(idx) : 0}"`,
      `data-orbit-count="${Number.isFinite(count) ? Math.round(count) : 1}"`,
      `data-orbit-angle="${Number.isFinite(angle) ? +angle.toFixed(2) : 0}"`,
      `data-orbit-ring="${Number.isFinite(ring) ? Math.max(0, Math.round(ring)) : 0}"`
    ].join(' ');
  }

  function mapIdentityReadOrbitMeta(slot) {
    if (!slot?.dataset) return null;
    return {
      index: Number(slot.dataset.orbitIndex) || 0,
      count: Number(slot.dataset.orbitCount) || 1,
      angleDeg: Number(slot.dataset.orbitAngle) || 0,
      ring: Number(slot.dataset.orbitRing) || 0
    };
  }

  function mapIdentityApplyOrbitStyleToSlot(slot) {
    if (!slot) return;
    const orbitMeta = mapIdentityReadOrbitMeta(slot);
    const orbitStyle = mapIdentityOrbitStyleText(orbitMeta, map?.getZoom?.());
    slot.style.removeProperty('--identity-slot-x');
    slot.style.removeProperty('--identity-slot-y');
    if (!orbitStyle) {
      slot.style.removeProperty('--marker-slot-x');
      slot.style.removeProperty('--marker-slot-y');
      return;
    }
    orbitStyle.split(';').forEach((chunk) => {
      const [prop, value] = chunk.split(':');
      if (!prop || !value) return;
      slot.style.setProperty(prop.trim(), value.trim());
    });
  }

  function mapIdentityRefreshOrbitSlots() {
    document.querySelectorAll('.mapPresenceOrbit[data-map-presence-orbit="1"]').forEach((slot) => {
      mapIdentityApplyOrbitStyleToSlot(slot);
    });
  }

  function mapIdentityRenderDriverLabel({ name, avatarUrl, mode, zoom, orbitMeta = null, overlapMeta = null, leaderboardBadgeCode }) {

    const effectiveOrbitMeta = orbitMeta || overlapMeta || null;
    const safeName = (String(name || 'Driver').trim() || 'Driver');
    const cfg = mapIdentityVisualConfig(zoom);
    const slotSide = String(effectiveOrbitMeta?.side || '').trim();
    const sideClass = slotSide ? ` slot-${slotSide}` : '';
    return `<div class="otherDrvIdentitySlot${sideClass}" data-map-identity-label="1">${mapIdentityPresenceCoreHTML({ markerClass: 'mapPresenceOther', name: safeName, avatarUrl, cfg, leaderboardBadgeCode, orbitMeta: effectiveOrbitMeta })}</div>`;
  }

  function mapIdentityApplySelfOrbit(orbitMeta) {
    const slot = document.querySelector('#navWrap .mapPresenceOrbit[data-map-presence-orbit="1"]');
    if (!slot) return;
    const sideClasses = ['slot-E', 'slot-W', 'slot-N', 'slot-S', 'slot-NE', 'slot-NW', 'slot-SE', 'slot-SW'];
    const slotHost = slot.closest('.selfIdentitySlot');
    sideClasses.forEach((cls) => slotHost?.classList.remove(cls));

    const slotSide = String(orbitMeta?.side || '').trim();
    const orbitStyle = mapIdentityOrbitStyleText(orbitMeta, map?.getZoom?.());
    slot.setAttribute('data-orbit-index', Number.isFinite(orbitMeta?.index) ? `${Math.round(orbitMeta.index)}` : '0');
    slot.setAttribute('data-orbit-count', Number.isFinite(orbitMeta?.count) ? `${Math.round(orbitMeta.count)}` : '1');
    slot.setAttribute('data-orbit-angle', Number.isFinite(orbitMeta?.angleDeg) ? `${+orbitMeta.angleDeg.toFixed(2)}` : '0');
    slot.setAttribute('data-orbit-ring', Number.isFinite(orbitMeta?.ring) ? `${Math.max(0, Math.round(orbitMeta.ring))}` : '0');

    if (!orbitStyle) {
      slot.style.removeProperty('--marker-slot-x');
      slot.style.removeProperty('--marker-slot-y');
      return;
    }

    orbitStyle.split(';').forEach((chunk) => {
      const [prop, value] = chunk.split(':');
      if (!prop || !value) return;
      slot.style.setProperty(prop.trim(), value.trim());
    });

    if (slotSide) slotHost?.classList.add(`slot-${slotSide}`);
  }

  function mapIdentityApplyZoomStyles(zoomValue) {
    const cfg = mapIdentityVisualConfig(zoomValue);
    const rootStyle = document.documentElement?.style;
    if (rootStyle) {
      rootStyle.setProperty('--map-ident-arrow-body', `${cfg.arrowBodyPx}px`);
      rootStyle.setProperty('--map-ident-arrow-left-right', `${cfg.arrowLeftRightPx}px`);
      rootStyle.setProperty('--map-ident-arrow-accent', `${cfg.arrowAccentPx}px`);
      rootStyle.setProperty('--map-ident-badge-font', `${cfg.badgeFontPx}px`);
      rootStyle.setProperty('--map-presence-root-px', `${cfg.rootPx}px`);
      rootStyle.setProperty('--map-presence-avatar', `${cfg.avatarPx}px`);
      rootStyle.setProperty('--map-presence-initials-font', `${cfg.initialsFontPx}px`);
      rootStyle.setProperty('--map-presence-tip-size', `${cfg.tipSizePx}px`);
      rootStyle.setProperty('--map-presence-tip-orbit', `${cfg.tipOrbitPx}px`);
      rootStyle.setProperty('--map-presence-badge-font', `${cfg.badgeFontPx}px`);
      rootStyle.setProperty('--map-presence-badge-scale', `${(cfg.rootPx / 54).toFixed(3)}`);
      rootStyle.setProperty('--map-crown-size', `${cfg.crownPx}px`);
      rootStyle.setProperty('--map-podium-size', `${cfg.podiumPx}px`);
      rootStyle.setProperty('--map-crown-lift', `${cfg.crownLiftPx}px`);
    }
    document.querySelectorAll('#navWrap, .otherDrvWrap').forEach((el) => {
      el.style.width = `${cfg.rootPx}px`;
      el.style.height = `${cfg.rootPx}px`;
    });
    document.querySelectorAll('.mapPresenceRoot').forEach((el) => {
      el.style.width = `${cfg.rootPx}px`;
      el.style.height = `${cfg.rootPx}px`;
    });
    document.querySelectorAll('.mapPresenceShell').forEach((el) => {
      el.style.width = `${cfg.avatarPx}px`;
      el.style.height = `${cfg.avatarPx}px`;
    });
    mapIdentityRefreshOrbitSlots();
  }

  function readMapIdentityFile(file) {
    if (!file) throw new Error('No file selected');
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error('Could not read image'));
      fr.readAsDataURL(file);
    });
  }

  async function loadMapIdentityImage(url) {
    return new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not decode image'));
      el.src = url;
    });
  }

  function closeMapIdentityCropper() {
    const modal = document.getElementById('mapIdentityCropModal');
    if (modal) modal.remove();
    mapIdentityCropState = null;
  }

  function applyMapIdentityCropTransform() {
    if (!mapIdentityCropState) return;
    const { imgEl, image, viewport, baseScale, zoom, tx, ty } = mapIdentityCropState;
    const scale = baseScale * zoom;
    const scaledW = (image.naturalWidth || image.width) * scale;
    const scaledH = (image.naturalHeight || image.height) * scale;
    const maxX = Math.max(0, (scaledW - viewport) / 2);
    const maxY = Math.max(0, (scaledH - viewport) / 2);
    mapIdentityCropState.tx = clampMapIdentity(tx, -maxX, maxX);
    mapIdentityCropState.ty = clampMapIdentity(ty, -maxY, maxY);
    imgEl.style.transform = `translate(-50%, -50%) translate(${mapIdentityCropState.tx}px, ${mapIdentityCropState.ty}px) scale(${scale})`;
  }

  async function exportMapIdentityCropDataUrl() {
    if (!mapIdentityCropState) throw new Error('Crop state not ready');
    const { image, viewport, baseScale, zoom, tx, ty } = mapIdentityCropState;
    const scale = baseScale * zoom;
    const iw = image.naturalWidth || image.width;
    const ih = image.naturalHeight || image.height;
    let sx = (iw / 2) + ((-viewport / 2) - tx) / scale;
    let sy = (ih / 2) + ((-viewport / 2) - ty) / scale;
    let sw = viewport / scale;
    let sh = viewport / scale;
    sw = Math.min(sw, iw);
    sh = Math.min(sh, ih);
    sx = clampMapIdentity(sx, 0, iw - sw);
    sy = clampMapIdentity(sy, 0, ih - sh);
    const canvas = document.createElement('canvas');
    canvas.width = MAP_IDENTITY_IMG_SIZE;
    canvas.height = MAP_IDENTITY_IMG_SIZE;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, MAP_IDENTITY_IMG_SIZE, MAP_IDENTITY_IMG_SIZE);
    return canvas.toDataURL('image/jpeg', 0.82);
  }

  async function openMapIdentityCropper(file) {
    const imageUrl = await readMapIdentityFile(file);
    const image = await loadMapIdentityImage(imageUrl);
    closeMapIdentityCropper();
    const modal = document.createElement('div');
    modal.id = 'mapIdentityCropModal';
    modal.className = 'mapIdentityCropModal';
    modal.style.zIndex = '11050';
    modal.innerHTML = `
      <div class="mapIdentityCropCard">
        <div class="mapIdentityCropTitle">Crop photo</div>
        <div class="mapIdentityCropViewport" id="mapIdentityCropViewport">
          <img id="mapIdentityCropImage" alt="Crop preview">
        </div>
        <input id="mapIdentityCropZoom" class="mapIdentityCropZoom" type="range" min="1" max="3" step="0.01" value="1">
        <div class="mapIdentityCropActions">
          <button id="mapIdentityCropCancel" class="chipBtn">Cancel</button>
          <button id="mapIdentityCropConfirm" class="chipBtn">Use Photo</button>
        </div>
      </div>
    `;
    const card = modal.querySelector('.mapIdentityCropCard');
    if (card) card.style.zIndex = '11051';
    document.body.appendChild(modal);
    const imgEl = modal.querySelector('#mapIdentityCropImage');
    const zoomEl = modal.querySelector('#mapIdentityCropZoom');
    const viewportEl = modal.querySelector('#mapIdentityCropViewport');
    imgEl.src = imageUrl;
    const baseScale = Math.max(
      MAP_IDENTITY_CROP_VIEW_SIZE / (image.naturalWidth || image.width),
      MAP_IDENTITY_CROP_VIEW_SIZE / (image.naturalHeight || image.height)
    );
    mapIdentityCropState = {
      image,
      imgEl,
      zoomEl,
      viewport: MAP_IDENTITY_CROP_VIEW_SIZE,
      baseScale,
      zoom: 1,
      tx: 0,
      ty: 0,
      pointerId: null,
      startX: 0,
      startY: 0,
      startTx: 0,
      startTy: 0
    };
    applyMapIdentityCropTransform();

    viewportEl.addEventListener('pointerdown', (evt) => {
      if (!mapIdentityCropState) return;
      mapIdentityCropState.pointerId = evt.pointerId;
      mapIdentityCropState.startX = evt.clientX;
      mapIdentityCropState.startY = evt.clientY;
      mapIdentityCropState.startTx = mapIdentityCropState.tx;
      mapIdentityCropState.startTy = mapIdentityCropState.ty;
      viewportEl.setPointerCapture(evt.pointerId);
    });
    viewportEl.addEventListener('pointermove', (evt) => {
      if (!mapIdentityCropState || mapIdentityCropState.pointerId !== evt.pointerId) return;
      mapIdentityCropState.tx = mapIdentityCropState.startTx + (evt.clientX - mapIdentityCropState.startX);
      mapIdentityCropState.ty = mapIdentityCropState.startTy + (evt.clientY - mapIdentityCropState.startY);
      applyMapIdentityCropTransform();
    });
    const endDrag = (evt) => {
      if (!mapIdentityCropState || mapIdentityCropState.pointerId !== evt.pointerId) return;
      mapIdentityCropState.pointerId = null;
    };
    viewportEl.addEventListener('pointerup', endDrag);
    viewportEl.addEventListener('pointercancel', endDrag);
    zoomEl.addEventListener('input', () => {
      if (!mapIdentityCropState) return;
      mapIdentityCropState.zoom = clampMapIdentity(Number(zoomEl.value) || 1, 1, 3);
      applyMapIdentityCropTransform();
    });

    modal.querySelector('#mapIdentityCropCancel')?.addEventListener('click', (e) => {
      e.preventDefault();
      closeMapIdentityCropper();
    });
    modal.querySelector('#mapIdentityCropConfirm')?.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        const processed = await exportMapIdentityCropDataUrl();
        mapIdentityTempAvatarDataUrl = processed;
        mapIdentitySavedAvatarDataUrl = processed;
        await saveMapIdentityUpdate({ avatar_url: processed, map_identity_mode: MAP_IDENTITY_MODE_AVATAR });
        closeMapIdentityCropper();
      } catch (err) {
        alert(err?.message || 'Image processing failed.');
      }
    });
  }

  function mapIdentityCurrentState() {
    const meObj = (typeof window !== 'undefined' && window.me) ? window.me : {};
    const serverAvatar = syncMapIdentitySavedAvatarCache();
    return {
      mode: normalizeMapIdentityMode(meObj?.map_identity_mode),
      avatarUrl: serverAvatar || mapIdentitySavedAvatarDataUrl || mapIdentityTempAvatarDataUrl,
      name: meObj?.display_name || 'Driver'
    };
  }

  function renderMapIdentityProfileSection() {
    const host = document.getElementById('profileMapIdentitySection');
    if (!host) return;
    const state = mapIdentityCurrentState();
    const hasAvatar = !!state.avatarUrl;
    host.innerHTML = `
      <div class="mapIdentitySection">
        <div class="mapIdentityTitle">Map Identity</div>
        <div class="mapIdentityModes">
          <button id="mapIdentityModeName" class="chipBtn ${state.mode === 'name' ? 'active' : ''}">Show Name</button>
          <button id="mapIdentityModeAvatar" class="chipBtn ${state.mode === 'avatar' ? 'active' : ''}">Show Photo</button>
        </div>
        <div class="mapIdentityAvatarRow">
          <div class="mapIdentityPreviewWrap">
            ${hasAvatar ? `<img id="mapIdentityPreview" class="mapIdentityPreview" src="${escapeHtml(state.avatarUrl)}" alt="Profile preview">` : `<div id="mapIdentityPreview" class="mapIdentityPreview mapIdentityPreviewFallback">${escapeHtml((state.name || 'D')[0].toUpperCase())}</div>`}
          </div>
          <div class="mapIdentityActions">
            <button id="mapIdentityChoosePhoto" class="chipBtn">Choose Photo</button>
            <button id="mapIdentityRemovePhoto" class="chipBtn">Remove Photo</button>
          </div>
        </div>
        <input id="mapIdentityFileInput" type="file" accept="image/*" hidden>
      </div>
    `;
  }

  async function saveMapIdentityUpdate(updates) {
    if (typeof authHeaderOK === 'function' && !authHeaderOK()) return;
    if (typeof updateMeProfile !== 'function') return;
    await updateMeProfile(updates);
    if (typeof refreshNavNameLabel === 'function') refreshNavNameLabel();
    renderMapIdentityProfileSection();
  }

  function initMapIdentityProfileControls() {
    renderMapIdentityProfileSection();
    const fileInput = document.getElementById('mapIdentityFileInput');
    document.getElementById('mapIdentityModeName')?.addEventListener('click', async (e) => {
      e.preventDefault();
      await saveMapIdentityUpdate({ map_identity_mode: MAP_IDENTITY_MODE_NAME });
    });
    document.getElementById('mapIdentityModeAvatar')?.addEventListener('click', async (e) => {
      e.preventDefault();
      const state = mapIdentityCurrentState();
      if (!state.avatarUrl) {
        alert('Choose a photo first.');
        return;
      }
      await saveMapIdentityUpdate({ map_identity_mode: MAP_IDENTITY_MODE_AVATAR });
    });
    document.getElementById('mapIdentityChoosePhoto')?.addEventListener('click', (e) => {
      e.preventDefault();
      fileInput?.click();
    });
    document.getElementById('mapIdentityRemovePhoto')?.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!confirm('Remove your saved photo?')) return;
      mapIdentitySavedAvatarDataUrl = '';
      mapIdentityTempAvatarDataUrl = '';
      await saveMapIdentityUpdate({ avatar_url: '', map_identity_mode: MAP_IDENTITY_MODE_NAME });
    });
    fileInput?.addEventListener('change', async () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      try {
        await openMapIdentityCropper(f);
      } catch (err) {
        alert(err?.message || 'Image processing failed.');
      } finally {
        fileInput.value = '';
      }
    });
  }

  function clearMapIdentityTempState() {
    closeMapIdentityCropper();
    const fileInput = document.getElementById('mapIdentityFileInput');
    if (fileInput) fileInput.value = '';
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

  function shuffleInPlace(items) {
    const list = Array.isArray(items) ? items : [];
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }

  function createDominoTileSet() {
    const tiles = [];
    for (let left = 0; left <= 6; left += 1) {
      for (let right = left; right <= 6; right += 1) {
        tiles.push([left, right]);
      }
    }
    return shuffleInPlace(tiles.slice());
  }

  function createInitialDominoesState() {
    const deck = createDominoTileSet();
    return {
      board: [],
      playerHand: deck.splice(0, 7),
      cpuHand: deck.splice(0, 7),
      boneyard: deck,
      turn: 'player',
      over: false,
      winner: '',
      message: 'Your turn. Match doubles or chain ends.',
      passStreak: 0,
    };
  }

  function createInitialBilliardsPracticeState() {
    return {
      playerScore: 0,
      cpuScore: 0,
      targetScore: 3,
      shotsTaken: 0,
      over: false,
      message: 'Practice mode ready. Sink 3 before the bot does.',
      balls: [
        { x: 0.22, y: 0.5, color: '#ffffff' },
        { x: 0.7, y: 0.32, color: '#fbbf24' },
        { x: 0.76, y: 0.5, color: '#38bdf8' },
        { x: 0.7, y: 0.68, color: '#f97316' },
      ],
    };
  }

  function gamesDefaultChallengeUserState() {
    return { rows: [], loadedAt: 0, query: '', loading: false, error: '', selected: null };
  }

  const gamesState = {
    activeTab: 'chess',
    activeModeByGame: { chess: 'cpu', uno: 'cpu', dominoes: 'cpu', billiards: 'cpu' },
    battleTab: 'overview',
    chess: createInitialChessState(),
    uno: createInitialUnoState(),
    unoWaitingColor: false,
    dominoes: createInitialDominoesState(),
    billiards: createInitialBilliardsPracticeState(),
    dashboard: { incoming: [], outgoing: [], activeMatch: null, history: [] },
    activeMatch: null,
    history: [],
    challengesLoadedAt: 0,
    matchLoadedAt: 0,
    loading: false,
    matchLoading: false,
    status: '',
    error: '',
    challengeComposer: { targetUserId: '', targetDisplayName: '', gameType: 'dominoes' },
    challengeUsers: gamesDefaultChallengeUserState(),
    battleNotificationsSeen: new Set(),
    billiardsAim: { angle: 0.1, power: 0.58 },
  };

  const GAMES_DASHBOARD_POLL_MS = 12000;
  const GAMES_ACTIVE_MATCH_POLL_MS = 2800;
  let gamesDashboardPollTimer = null;
  let gamesMatchPollTimer = null;

  function isGamesPanelOpen() {
    return typeof openPanelKey !== 'undefined' && openPanelKey === 'games';
  }

  function getGamesAuthToken() {
    try { return localStorage.getItem(LS_TOKEN) || ''; } catch (_) { return ''; }
  }

  async function gamesApiGet(path) {
    const token = getGamesAuthToken();
    if (runtime?.getJSONAuth) return runtime.getJSONAuth(path, token);
    if (window.FrontendRuntime?.getJSONAuth) return window.FrontendRuntime.getJSONAuth(path, token);
    return getJSONAuth(path, token);
  }

  async function gamesApiPost(path, body = {}) {
    const token = getGamesAuthToken();
    if (runtime?.postJSON) return runtime.postJSON(path, body, token);
    if (window.FrontendRuntime?.postJSON) return window.FrontendRuntime.postJSON(path, body, token);
    return postJSON(path, body, token);
  }

  function defaultBattleStats() {
    return {
      wins: 0,
      losses: 0,
      total_matches: 0,
      matches_played: 0,
      win_rate: 0,
      dominoes_wins: 0,
      dominoes_losses: 0,
      billiards_wins: 0,
      billiards_losses: 0,
      game_xp_earned: 0,
    };
  }

  function formatBattlePct(value) {
    const n = Number(value);
    return `${Number.isFinite(n) ? Math.max(0, Math.min(100, n * 100)) : 0}`.replace(/\.0+$/, '') + '%';
  }

  function setGamesStatus(message = '', isError = false) {
    gamesState.status = String(message || '');
    gamesState.error = isError ? gamesState.status : '';
  }

  function scheduleGamesDashboardPoll({ immediate = false } = {}) {
    if (gamesDashboardPollTimer) window.clearTimeout(gamesDashboardPollTimer);
    gamesDashboardPollTimer = window.setTimeout(async () => {
      gamesDashboardPollTimer = null;
      if (!isGamesPanelOpen()) return;
      await loadGamesBattleDashboard({ silent: true });
      scheduleGamesDashboardPoll();
    }, immediate ? 0 : GAMES_DASHBOARD_POLL_MS);
  }

  function scheduleGamesMatchPoll({ immediate = false } = {}) {
    if (gamesMatchPollTimer) window.clearTimeout(gamesMatchPollTimer);
    const activeId = Number(gamesState.activeMatch?.id || gamesState.dashboard?.activeMatch?.id || 0);
    if (!activeId) return;
    gamesMatchPollTimer = window.setTimeout(async () => {
      gamesMatchPollTimer = null;
      if (!isGamesPanelOpen()) return;
      await loadActiveBattleMatch({ silent: true, preferredMatchId: activeId });
      if (Number(gamesState.activeMatch?.id || 0)) scheduleGamesMatchPoll();
    }, immediate ? 0 : GAMES_ACTIVE_MATCH_POLL_MS);
  }

  async function loadGamesBattleDashboard({ silent = false } = {}) {
    if (!getGamesAuthToken()) return null;
    if (!silent) {
      gamesState.loading = true;
      setGamesStatus('Loading battle hub…');
      rerenderGamesPanel();
    }
    try {
      const [incomingRes, outgoingRes, activeRes, historyRes, aggregateRes] = await Promise.all([
        gamesApiGet('/games/challenges/incoming').catch(() => null),
        gamesApiGet('/games/challenges/outgoing').catch(() => null),
        gamesApiGet('/games/matches/active/me').catch(() => null),
        gamesApiGet('/games/history/me').catch(() => ({ ok: false, rows: [] })),
        gamesApiGet('/games/challenges').catch(() => null),
      ]);
      const challengesRes = aggregateRes || {};
      gamesState.dashboard = {
        incoming: Array.isArray(incomingRes?.rows) ? incomingRes.rows : (Array.isArray(challengesRes?.incoming) ? challengesRes.incoming : []),
        outgoing: Array.isArray(outgoingRes?.rows) ? outgoingRes.rows : (Array.isArray(challengesRes?.outgoing) ? challengesRes.outgoing : []),
        activeMatch: activeRes?.match || activeRes?.active_match || activeRes?.activeMatch || challengesRes?.active_match || challengesRes?.activeMatch || null,
        history: Array.isArray(historyRes?.rows) ? historyRes.rows : Array.isArray(historyRes?.history) ? historyRes.history : [],
      };
      gamesState.history = gamesState.dashboard.history.slice();
      gamesState.challengesLoadedAt = Date.now();
      if (!gamesState.activeMatch && gamesState.dashboard.activeMatch) gamesState.activeMatch = gamesState.dashboard.activeMatch;
      if (gamesState.dashboard.activeMatch?.id) scheduleGamesMatchPoll({ immediate: true });
      if (!silent) setGamesStatus('');
      return gamesState.dashboard;
    } catch (err) {
      setGamesStatus(err?.message || 'Unable to load battle hub.', true);
      return null;
    } finally {
      gamesState.loading = false;
      rerenderGamesPanel();
    }
  }

  async function loadActiveBattleMatch({ silent = false, preferredMatchId = null } = {}) {
    if (!getGamesAuthToken()) return null;
    if (!silent) {
      gamesState.matchLoading = true;
      setGamesStatus('Loading active battle…');
      rerenderGamesPanel();
    }
    const numericId = Number(preferredMatchId || gamesState.dashboard?.activeMatch?.id || gamesState.activeMatch?.id || 0);
    try {
      const res = numericId
        ? await gamesApiGet(`/games/matches/${encodeURIComponent(numericId)}`)
        : await gamesApiGet('/games/matches/active/me');
      const match = res?.match || res?.active_match || res?.activeMatch || null;
      if (match) {
        gamesState.activeMatch = match;
        gamesState.dashboard.activeMatch = {
          id: match.id,
          game_type: match.game_type,
          opponent_display_name: match.opponent_display_name,
          opponent_user_id: match.opponent_user_id,
          status: match.status,
        };
        gamesState.matchLoadedAt = Date.now();
      } else if (!silent) {
        gamesState.activeMatch = null;
      }
      if (res?.reward_contract) {
        gamesState.battleNotificationsSeen.add(`reward:${match?.id || 'unknown'}`);
        showBattleProgressReward(res.reward_contract, match);
      }
      rerenderGamesPanel();
      return match;
    } catch (err) {
      if (!silent) setGamesStatus(err?.message || 'Unable to load active battle.', true);
      return null;
    } finally {
      gamesState.matchLoading = false;
    }
  }

  async function createBattleChallenge(targetUserId, gameType) {
    if (!targetUserId) return;
    setGamesStatus('Sending challenge…');
    rerenderGamesPanel();
    try {
      await gamesApiPost('/games/challenges', {
        target_user_id: Number(targetUserId),
        challenged_user_id: Number(targetUserId),
        game_type: String(gameType || 'dominoes'),
        game_key: String(gameType || 'dominoes'),
      });
      setGamesStatus('Challenge sent.');
      gamesState.battleTab = 'outgoing';
      await loadGamesBattleDashboard({ silent: true });
    } catch (err) {
      setGamesStatus(err?.message || 'Challenge failed.', true);
    }
    rerenderGamesPanel();
  }

  async function respondToChallenge(challengeId, action) {
    if (!challengeId || !action) return;
    const path = `/games/challenges/${encodeURIComponent(challengeId)}/${action}`;
    setGamesStatus(`${action === 'accept' ? 'Accepting' : action === 'decline' ? 'Declining' : 'Canceling'} challenge…`);
    rerenderGamesPanel();
    try {
      const res = await gamesApiPost(path, {});
      setGamesStatus(action === 'accept' ? 'Battle accepted.' : action === 'decline' ? 'Challenge declined.' : 'Challenge canceled.');
      await loadGamesBattleDashboard({ silent: true });
      const matchId = Number(res?.match?.id || res?.active_match?.id || res?.match_id || 0);
      if (matchId) {
        gamesState.battleTab = 'active';
        await loadActiveBattleMatch({ silent: true, preferredMatchId: matchId });
      }
    } catch (err) {
      setGamesStatus(err?.message || 'Challenge action failed.', true);
    }
    rerenderGamesPanel();
  }

  async function submitBattleMove(payload) {
    const matchId = Number(gamesState.activeMatch?.id || 0);
    if (!matchId || !payload || typeof payload !== 'object') return;
    setGamesStatus('Submitting move…');
    rerenderGamesPanel();
    try {
      const res = await gamesApiPost(`/games/matches/${encodeURIComponent(matchId)}/move`, payload);
      if (res?.match) gamesState.activeMatch = res.match;
      if (res?.reward_contract) showBattleProgressReward(res.reward_contract, res.match || gamesState.activeMatch);
      setGamesStatus(res?.match?.status === 'completed' ? 'Battle completed.' : 'Move submitted.');
      await loadGamesBattleDashboard({ silent: true });
      rerenderGamesPanel();
    } catch (err) {
      setGamesStatus(err?.message || 'Move failed.', true);
      rerenderGamesPanel();
    }
  }

  async function forfeitBattleMatch() {
    const matchId = Number(gamesState.activeMatch?.id || 0);
    if (!matchId) return;
    if (typeof confirm === 'function' && !confirm('Forfeit this battle?')) return;
    setGamesStatus('Forfeiting battle…');
    rerenderGamesPanel();
    try {
      const res = await gamesApiPost(`/games/matches/${encodeURIComponent(matchId)}/forfeit`, {});
      if (res?.match) gamesState.activeMatch = res.match;
      if (res?.reward_contract) showBattleProgressReward(res.reward_contract, res.match || gamesState.activeMatch);
      await loadGamesBattleDashboard({ silent: true });
      rerenderGamesPanel();
    } catch (err) {
      setGamesStatus(err?.message || 'Unable to forfeit.', true);
      rerenderGamesPanel();
    }
  }

  function formatBattleDate(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function battleResultLabel(row) {
    const result = String(row?.result || row?.outcome || '').toLowerCase();
    if (result === 'win' || row?.winner === true) return 'Win';
    if (result === 'loss' || row?.winner === false) return 'Loss';
    if (result) return result.replace(/_/g, ' ');
    return 'Pending';
  }

  function challengeMetaLine(item) {
    const game = String(item?.game_type || 'battle').replace(/^./, (m) => m.toUpperCase());
    const expires = item?.expires_at ? ` • expires ${formatBattleDate(item.expires_at)}` : '';
    return `${game}${expires}`;
  }

  function renderChallengeRow(item, type) {
    const opponent = escapeHtml(String(item?.other_user_display_name || item?.opponent_display_name || item?.challenged_display_name || item?.challenger_display_name || item?.display_name || 'Driver'));
    const actions = type === 'incoming'
      ? `<div class="gamesActionRow"><button class="chipBtn" data-games-accept="${escapeHtml(String(item?.id || ''))}">Accept</button><button class="chipBtn" data-games-decline="${escapeHtml(String(item?.id || ''))}">Decline</button></div>`
      : `<div class="gamesActionRow"><button class="chipBtn" data-games-cancel="${escapeHtml(String(item?.id || ''))}">Cancel</button></div>`;
    return `<article class="gamesBattleCard">
      <div class="gamesBattleTitle">${opponent}</div>
      <div class="gamesBattleMeta">${escapeHtml(challengeMetaLine(item))}</div>
      ${actions}
    </article>`;
  }

  function renderBattleHistoryRow(item) {
    const label = battleResultLabel(item);
    const xp = Number(item?.xp_awarded || item?.winner_xp_awarded || item?.xp || 0);
    const game = String(item?.game_type || 'battle').replace(/^./, (m) => m.toUpperCase());
    const opponent = String(item?.opponent_display_name || item?.loser_display_name || item?.winner_display_name || 'Driver');
    return `<article class="gamesBattleCard compact ${label === 'Win' ? 'win' : (label === 'Loss' ? 'loss' : '')}">
      <div class="gamesBattleTitle">${escapeHtml(game)} • ${escapeHtml(label)}</div>
      <div class="gamesBattleMeta">vs ${escapeHtml(opponent)} • ${escapeHtml(formatBattleDate(item?.completed_at))}</div>
      <div class="gamesBattleReward">${xp > 0 ? `+${formatProgressNumber(xp, { maxFractionDigits: 0 })} XP` : 'Completed'}</div>
    </article>`;
  }

  function renderBattleOverview() {
    const incoming = Array.isArray(gamesState.dashboard?.incoming) ? gamesState.dashboard.incoming : [];
    const outgoing = Array.isArray(gamesState.dashboard?.outgoing) ? gamesState.dashboard.outgoing : [];
    const history = Array.isArray(gamesState.history) ? gamesState.history.slice(0, 5) : [];
    const active = gamesState.activeMatch || gamesState.dashboard?.activeMatch || null;
    const composer = gamesState.challengeComposer || {};
    return `<div class="gamesBattleColumns">
      <section class="gamesBattlePanel">
        <div class="gamesSectionHeader">Create challenge</div>
        <div class="gamesChallengeComposer">
          <input id="gamesChallengeTarget" class="driverProfileInput gamesComposerInput" type="number" min="1" inputmode="numeric" placeholder="Driver ID" value="${escapeHtml(String(composer.targetUserId || ''))}">
          <input id="gamesChallengeTargetName" class="driverProfileInput gamesComposerInput" type="text" placeholder="Driver name (optional)" value="${escapeHtml(String(composer.targetDisplayName || ''))}">
          <div class="gamesTabs gamesMiniTabs">
            <button class="chipBtn ${composer.gameType === 'dominoes' ? 'active' : ''}" data-games-select-type="dominoes">Dominoes</button>
            <button class="chipBtn ${composer.gameType === 'billiards' ? 'active' : ''}" data-games-select-type="billiards">Billiards</button>
          </div>
          <button id="gamesSendChallengeBtn" class="chipBtn">Send Challenge</button>
        </div>
      </section>
      <section class="gamesBattlePanel">
        <div class="gamesSectionHeader">Battle inbox</div>
        <div class="gamesBattleList">${incoming.length ? incoming.map((row) => renderChallengeRow(row, 'incoming')).join('') : '<div class="leaderboardEmpty">No incoming challenges.</div>'}</div>
      </section>
      <section class="gamesBattlePanel">
        <div class="gamesSectionHeader">Outgoing</div>
        <div class="gamesBattleList">${outgoing.length ? outgoing.map((row) => renderChallengeRow(row, 'outgoing')).join('') : '<div class="leaderboardEmpty">No outgoing challenges.</div>'}</div>
      </section>
      <section class="gamesBattlePanel">
        <div class="gamesSectionHeader">Active battle</div>
        ${active ? `<div class="gamesBattleCard"><div class="gamesBattleTitle">${escapeHtml(String(active.game_type || 'battle').replace(/^./, (m) => m.toUpperCase()))}</div><div class="gamesBattleMeta">${escapeHtml(String(active.opponent_display_name || 'Driver'))}</div><button class="chipBtn" data-games-tab="active">Open Match</button></div>` : '<div class="leaderboardEmpty">No active battle.</div>'}
      </section>
      <section class="gamesBattlePanel">
        <div class="gamesSectionHeader">Recent history</div>
        <div class="gamesBattleList">${history.length ? history.map(renderBattleHistoryRow).join('') : '<div class="leaderboardEmpty">No recent battles yet.</div>'}</div>
      </section>
    </div>`;
  }

  function isLocalPlayersTurn(match) {
    const meId = String(window?.me?.id || '');
    return !!meId && String(match?.current_turn_user_id || match?.currentTurnUserId || '') === meId;
  }

  function renderDominoesTile(tile, playable = false, attrs = '') {
    const left = Number(Array.isArray(tile) ? tile[0] : tile?.[0]);
    const right = Number(Array.isArray(tile) ? tile[1] : tile?.[1]);
    const safeLeft = Number.isFinite(left) ? left : 0;
    const safeRight = Number.isFinite(right) ? right : 0;
    const dots = [safeLeft, safeRight].map((value, idx) => {
      const positions = {
        1: [[12, 18]], 2: [[8, 14], [16, 22]], 3: [[8, 14], [12, 18], [16, 22]],
        4: [[8, 14], [16, 14], [8, 22], [16, 22]], 5: [[8, 14], [16, 14], [12, 18], [8, 22], [16, 22]],
        6: [[8, 13], [16, 13], [8, 18], [16, 18], [8, 23], [16, 23]],
      };
      return (positions[value] || []).map(([x, y]) => `<circle cx="${x}" cy="${y + (idx * 22)}" r="1.9"/>`).join('');
    }).join('');
    return `<button type="button" class="gamesDominoTile${playable ? ' playable' : ''}" ${attrs}>` +
      `<svg viewBox="0 0 24 48" aria-hidden="true"><rect x="1.5" y="1.5" width="21" height="45" rx="4" fill="rgba(255,255,255,.95)" stroke="rgba(15,23,42,.35)" stroke-width="1.5"/><path d="M4 24h16" stroke="rgba(15,23,42,.35)" stroke-width="1.4"/>${dots}</svg>` +
      `<span class="sr-only">${safeLeft}-${safeRight}</span></button>`;
  }

  function renderDominoesBattle(host, match) {
    const state = match?.match_state || match?.state || {};
    const myHand = Array.isArray(state?.your_hand || state?.my_hand || state?.player_hand) ? (state.your_hand || state.my_hand || state.player_hand) : [];
    const board = Array.isArray(state?.board_chain || state?.board || state?.chain) ? (state.board_chain || state.board || state.chain) : [];
    const playable = new Set((Array.isArray(state?.playable_tiles) ? state.playable_tiles : []).map((tile) => JSON.stringify(tile)));
    const myTurn = isLocalPlayersTurn(match);
    host.innerHTML = `<div class="gamesBattleArena">
      <div class="gamesBattleTopline"><div class="gamesStatus">${escapeHtml(String(match?.status === 'completed' ? (match?.result_summary || 'Match complete.') : (myTurn ? 'Your turn' : 'Opponent turn')))}</div><button id="gamesForfeitBtn" class="chipBtn dangerBtn" ${match?.status === 'completed' ? 'disabled' : ''}>Forfeit</button></div>
      <div class="gamesBattleMeta">Opponent hand: ${escapeHtml(String(state?.opponent_hand_count ?? state?.other_hand_count ?? '—'))} • Boneyard: ${escapeHtml(String(state?.boneyard_count ?? state?.stock_count ?? '—'))}</div>
      <div class="gamesDominoBoard">${board.length ? board.map((tile) => `<div class="gamesDominoBoardTile">${renderDominoesTile(tile)}</div>`).join('') : '<div class="leaderboardEmpty">Board waiting for first move.</div>'}</div>
      <div class="gamesActionRow"><button id="gamesDominoDrawBtn" class="chipBtn" ${!myTurn || !state?.can_draw ? 'disabled' : ''}>Draw Tile</button><button id="gamesDominoPassBtn" class="chipBtn" ${!myTurn || !state?.can_pass ? 'disabled' : ''}>Pass</button></div>
      <div class="gamesMiniLabel">Your hand</div>
      <div class="gamesDominoHand">${myHand.map((tile, idx) => {
        const encoded = escapeHtml(JSON.stringify(tile));
        const canPlay = myTurn && playable.has(JSON.stringify(tile));
        return `<div class="gamesDominoTileWrap">${renderDominoesTile(tile, canPlay, `${canPlay ? `data-domino-tile="${encoded}"` : 'disabled'}`)}<div class="gamesDominoActions"><button class="chipBtn miniChip" ${canPlay ? `data-domino-play='${encoded}' data-domino-side="left"` : 'disabled'}>Left</button><button class="chipBtn miniChip" ${canPlay ? `data-domino-play='${encoded}' data-domino-side="right"` : 'disabled'}>Right</button></div></div>`;
      }).join('')}</div>
      ${match?.status === 'completed' ? `<div class="gamesBattleResult">${escapeHtml(String(match?.result_summary || 'Battle completed.'))}</div>` : ''}
    </div>`;
    document.getElementById('gamesForfeitBtn')?.addEventListener('click', (e) => { e.preventDefault(); void forfeitBattleMatch(); });
    document.getElementById('gamesDominoDrawBtn')?.addEventListener('click', (e) => { e.preventDefault(); void submitBattleMove({ move_type: 'draw_tile' }); });
    document.getElementById('gamesDominoPassBtn')?.addEventListener('click', (e) => { e.preventDefault(); void submitBattleMove({ move_type: 'pass' }); });
    host.querySelectorAll('[data-domino-play]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const raw = btn.getAttribute('data-domino-play') || '[]';
        const side = btn.getAttribute('data-domino-side') || 'left';
        let tile = [];
        try { tile = JSON.parse(raw); } catch (_) {}
        void submitBattleMove({ move_type: 'play_tile', tile, side });
      });
    });
  }

  function drawBilliardsCanvas(canvas, match) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const state = match?.match_state || match?.state || {};
    const balls = Array.isArray(state?.balls) ? state.balls : [];
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0a6b47';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(255,255,255,.24)';
    ctx.lineWidth = 4;
    ctx.strokeRect(6, 6, width - 12, height - 12);
    const pockets = [[12,12],[width/2,10],[width-12,12],[12,height-12],[width/2,height-10],[width-12,height-12]];
    ctx.fillStyle = '#0f172a';
    pockets.forEach(([x,y]) => { ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.fill(); });
    balls.forEach((ball, idx) => {
      const x = Number(ball?.x);
      const y = Number(ball?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || ball?.pocketed) return;
      ctx.beginPath();
      ctx.fillStyle = String(ball?.color || (idx === 0 ? '#ffffff' : '#fbbf24'));
      ctx.arc(x * width, y * height, idx === 0 ? 8 : 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(15,23,42,.28)';
      ctx.stroke();
    });
    if (isLocalPlayersTurn(match) && balls[0] && !balls[0].pocketed) {
      const cue = balls[0];
      const aim = gamesState.billiardsAim || { angle: 0, power: 0.5 };
      const startX = cue.x * width;
      const startY = cue.y * height;
      const lineLen = 24 + (aim.power * 52);
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.lineTo(startX + Math.cos(aim.angle) * lineLen, startY + Math.sin(aim.angle) * lineLen);
      ctx.stroke();
    }
  }

  function renderBilliardsBattle(host, match) {
    const state = match?.match_state || match?.state || {};
    const myTurn = isLocalPlayersTurn(match);
    host.innerHTML = `<div class="gamesBattleArena">
      <div class="gamesBattleTopline"><div class="gamesStatus">${escapeHtml(String(match?.status === 'completed' ? (match?.result_summary || 'Match complete.') : (myTurn ? 'Line up your shot.' : 'Waiting for opponent shot.')))}</div><button id="gamesForfeitBtn" class="chipBtn dangerBtn" ${match?.status === 'completed' ? 'disabled' : ''}>Forfeit</button></div>
      <div class="gamesBattleMeta">Targets left: ${escapeHtml(String(state?.your_targets_remaining ?? state?.player_targets_remaining ?? '—'))} • Opponent: ${escapeHtml(String(state?.opponent_targets_remaining ?? '—'))}</div>
      <canvas id="gamesBilliardsCanvas" class="gamesBilliardsCanvas" width="320" height="180"></canvas>
      <div class="gamesBilliardsControls">
        <label class="gamesControlLabel">Angle <input id="gamesBilliardsAngle" type="range" min="-314" max="314" step="1" value="${Math.round((gamesState.billiardsAim.angle || 0) * 100)}" ${!myTurn || match?.status === 'completed' ? 'disabled' : ''}></label>
        <label class="gamesControlLabel">Power <input id="gamesBilliardsPower" type="range" min="10" max="100" step="1" value="${Math.round((gamesState.billiardsAim.power || 0.58) * 100)}" ${!myTurn || match?.status === 'completed' ? 'disabled' : ''}></label>
        <button id="gamesBilliardsShotBtn" class="chipBtn" ${!myTurn || match?.status === 'completed' ? 'disabled' : ''}>Take Shot</button>
      </div>
      <div class="gamesBattleMeta">Rule: first player to pocket every target ball, then the final ball, wins.</div>
      ${match?.status === 'completed' ? `<div class="gamesBattleResult">${escapeHtml(String(match?.result_summary || 'Battle completed.'))}</div>` : ''}
    </div>`;
    const canvas = document.getElementById('gamesBilliardsCanvas');
    drawBilliardsCanvas(canvas, match);
    document.getElementById('gamesForfeitBtn')?.addEventListener('click', (e) => { e.preventDefault(); void forfeitBattleMatch(); });
    document.getElementById('gamesBilliardsAngle')?.addEventListener('input', (e) => {
      gamesState.billiardsAim.angle = Number(e.target.value || 0) / 100;
      drawBilliardsCanvas(canvas, match);
    });
    document.getElementById('gamesBilliardsPower')?.addEventListener('input', (e) => {
      gamesState.billiardsAim.power = Math.max(0.1, Math.min(1, Number(e.target.value || 58) / 100));
      drawBilliardsCanvas(canvas, match);
    });
    document.getElementById('gamesBilliardsShotBtn')?.addEventListener('click', (e) => {
      e.preventDefault();
      void submitBattleMove({ move_type: 'shot', angle: Number(gamesState.billiardsAim.angle || 0), power: Number(gamesState.billiardsAim.power || 0.58) });
    });
  }

  function renderActiveBattle(host) {
    const match = gamesState.activeMatch;
    if (!match) {
      host.innerHTML = '<div class="leaderboardEmpty">No active battle right now.</div>';
      return;
    }
    if (String(match?.game_type || '') === 'billiards') {
      renderBilliardsBattle(host, match);
      return;
    }
    renderDominoesBattle(host, match);
  }

  function showBattleProgressReward(progression = {}, match = {}) {
    const payload = progression?.progression ? progression : { progression };
    if (!renderPickupProgressReward(payload)) return;
    updatePickupRewardLayout();
    const root = ensurePickupProgressReward();
    const kickerEl = document.getElementById('pickupProgressRewardKicker');
    const footEl = document.getElementById('pickupProgressRewardFoot');
    if (kickerEl) kickerEl.textContent = `${String(match?.game_type || 'Battle').replace(/^./, (m) => m.toUpperCase())} Battle Complete`;
    if (footEl && match?.winner_display_name && match?.loser_display_name) {
      footEl.textContent = `${match.winner_display_name} defeated ${match.loser_display_name}`;
    }
    root.classList.remove('show');
    void root.offsetWidth;
    root.classList.add('show');
    root.setAttribute('aria-hidden', 'false');
    if (showBattleProgressReward._timer) window.clearTimeout(showBattleProgressReward._timer);
    showBattleProgressReward._timer = window.setTimeout(() => {
      root.classList.remove('show');
      root.setAttribute('aria-hidden', 'true');
      showBattleProgressReward._timer = null;
    }, 3800);
    if (progression?.leveled_up || progression?.new_level > progression?.previous_level) {
      showLevelUpOverlay(progression);
    }
  }

  function activeGamesMode() {
    return gamesState.activeModeByGame[gamesState.activeTab] || 'cpu';
  }

  function setGamesTabMode(gameKey, mode) {
    gamesState.activeModeByGame[gameKey] = mode === 'vs_driver' ? 'vs_driver' : 'cpu';
    if (gamesState.activeModeByGame[gameKey] === 'vs_driver') {
      gamesState.challengeComposer.gameType = gameKey === 'billiards' ? 'billiards' : 'dominoes';
      void loadGamesBattleDashboard({ silent: true });
      void loadChallengeableUsers({ query: gamesState.challengeUsers.query || '', gameKey });
    }
  }

  function normalizeChallengeUser(row = {}) {
    const id = Number(row?.user_id ?? row?.id ?? row?.uid ?? 0);
    if (!Number.isFinite(id) || id <= 0) return null;
    return {
      user_id: id,
      display_name: String(row?.display_name || row?.name || row?.email || `Driver ${id}`),
      avatar_thumb_url: safeMapAvatarUrl(row?.avatar_thumb_url || row?.avatar_url || ''),
      rank_icon_key: row?.rank_icon_key || row?.rankIconKey || '',
      level: Number(row?.level || 0) || 0,
      online: !!(row?.online || row?.is_online),
      leaderboard_badge_code: row?.leaderboard_badge_code || '',
    };
  }

  async function loadChallengeableUsers({ query = '', gameKey = null, force = false } = {}) {
    if (!getGamesAuthToken()) return [];
    const nextQuery = String(query || '').trim();
    const activeGame = gameKey || gamesState.challengeComposer.gameType || 'dominoes';
    const cacheFresh = !force && gamesState.challengeUsers.loadedAt && (Date.now() - gamesState.challengeUsers.loadedAt < 15000);
    if (cacheFresh && nextQuery === gamesState.challengeUsers.query) return gamesState.challengeUsers.rows;
    gamesState.challengeUsers.loading = true;
    gamesState.challengeUsers.error = '';
    gamesState.challengeUsers.query = nextQuery;
    rerenderGamesPanel();
    try {
      const route = `/games/users?q=${encodeURIComponent(nextQuery)}&limit=80&game_key=${encodeURIComponent(activeGame)}`;
      let payload = await gamesApiGet(route).catch(() => null);
      let rows = Array.isArray(payload?.rows) ? payload.rows : Array.isArray(payload?.users) ? payload.users : [];
      if (!rows.length) {
        payload = await gamesApiGet('/presence/all?mode=full&limit=500').catch(() => null);
        const fallbackRows = Array.isArray(payload) ? payload : Array.isArray(payload?.items) ? payload.items : [];
        rows = fallbackRows.filter((row) => {
          const meId = Number(window?.me?.id || 0);
          const rowId = Number(row?.user_id ?? row?.id ?? row?.uid ?? 0);
          if (!rowId || (meId && rowId === meId)) return false;
          const label = String(row?.display_name || row?.name || row?.email || '').toLowerCase();
          return !nextQuery || label.includes(nextQuery.toLowerCase());
        });
      }
      gamesState.challengeUsers.rows = rows.map(normalizeChallengeUser).filter(Boolean);
      gamesState.challengeUsers.loadedAt = Date.now();
      return gamesState.challengeUsers.rows;
    } catch (err) {
      gamesState.challengeUsers.error = err?.message || 'Unable to load drivers.';
      return [];
    } finally {
      gamesState.challengeUsers.loading = false;
      rerenderGamesPanel();
    }
  }

  function battleRowsForGame(gameKey) {
    const normalizedKey = gameKey === 'billiards' ? 'billiards' : 'dominoes';
    const matchKey = (row) => String(row?.game_key || row?.game_type || '').toLowerCase();
    return {
      incoming: (gamesState.dashboard?.incoming || []).filter((row) => matchKey(row) === normalizedKey),
      outgoing: (gamesState.dashboard?.outgoing || []).filter((row) => matchKey(row) === normalizedKey),
      history: (gamesState.history || []).filter((row) => matchKey(row) === normalizedKey).slice(0, 5),
      active: String(gamesState.activeMatch?.game_key || gamesState.activeMatch?.game_type || '').toLowerCase() === normalizedKey ? gamesState.activeMatch : null,
    };
  }

  function renderChallengeableUsers(gameKey) {
    const state = gamesState.challengeUsers;
    const rows = Array.isArray(state.rows) ? state.rows : [];
    const selectedId = Number(state.selected?.user_id || gamesState.challengeComposer.targetUserId || 0);
    return `<section class="gamesBattlePanel">
      <div class="gamesSectionHeader">Vs Driver</div>
      <input id="gamesChallengeSearch" class="driverProfileInput gamesComposerInput" type="search" placeholder="Search drivers" value="${escapeHtml(state.query || '')}">
      <div class="gamesUserList">
        ${state.loading ? '<div class="leaderboardEmpty">Loading drivers…</div>' : ''}
        ${!state.loading && !rows.length ? '<div class="leaderboardEmpty">No drivers found.</div>' : rows.map((row) => `
          <button type="button" class="gamesUserRow ${selectedId === row.user_id ? 'selected' : ''}" data-games-user="${row.user_id}">
            <span class="gamesUserAvatar">${row.avatar_thumb_url ? `<img src="${escapeHtml(row.avatar_thumb_url)}" alt="" loading="lazy">` : escapeHtml((row.display_name || 'D').slice(0, 2).toUpperCase())}</span>
            <span class="gamesUserMeta"><strong>${escapeHtml(row.display_name)}</strong><span>${row.level ? `Level ${escapeHtml(String(row.level))}` : 'Driver'} ${row.online ? '• Online' : ''}</span></span>
            <span class="gamesUserRank">${row.rank_icon_key ? renderRankBadgeIcon(row.rank_icon_key, { compact: true }) : ''}</span>
          </button>`).join('')}
      </div>
      <div class="gamesChallengeComposer">
        <input id="gamesChallengeTargetName" class="driverProfileInput gamesComposerInput" type="text" placeholder="Selected driver" readonly value="${escapeHtml(String(state.selected?.display_name || gamesState.challengeComposer.targetDisplayName || ''))}">
        <button id="gamesSendChallengeBtn" class="chipBtn" ${!(state.selected?.user_id || gamesState.challengeComposer.targetUserId) ? 'disabled' : ''}>Challenge to ${escapeHtml(gameKey === 'billiards' ? 'Billiards' : 'Dominoes')}</button>
      </div>
      ${state.error ? `<div class="gamesStatus err">${escapeHtml(state.error)}</div>` : ''}
    </section>`;
  }

  function renderBattleInboxStack(gameKey) {
    const battleRows = battleRowsForGame(gameKey);
    return `<div class="gamesBattleColumns">
      ${renderChallengeableUsers(gameKey)}
      <section class="gamesBattlePanel"><div class="gamesSectionHeader">Incoming</div><div class="gamesBattleList">${battleRows.incoming.length ? battleRows.incoming.map((row) => renderChallengeRow(row, 'incoming')).join('') : '<div class="leaderboardEmpty">No incoming challenges.</div>'}</div></section>
      <section class="gamesBattlePanel"><div class="gamesSectionHeader">Outgoing</div><div class="gamesBattleList">${battleRows.outgoing.length ? battleRows.outgoing.map((row) => renderChallengeRow(row, 'outgoing')).join('') : '<div class="leaderboardEmpty">No outgoing challenges.</div>'}</div></section>
      <section class="gamesBattlePanel"><div class="gamesSectionHeader">Active battle</div>${battleRows.active ? `<div class="gamesBattleCard"><div class="gamesBattleTitle">${escapeHtml(String(battleRows.active.opponent_display_name || 'Driver'))}</div><div class="gamesBattleMeta">${escapeHtml(String(gameKey === 'billiards' ? 'Billiards' : 'Dominoes'))} • ${escapeHtml(String(battleRows.active.status || 'active'))}</div><button class="chipBtn" data-games-open-active="1">Open Match</button></div>` : '<div class="leaderboardEmpty">No active battle.</div>'}</section>
      <section class="gamesBattlePanel"><div class="gamesSectionHeader">Recent history</div><div class="gamesBattleList">${battleRows.history.length ? battleRows.history.map(renderBattleHistoryRow).join('') : '<div class="leaderboardEmpty">No recent battles yet.</div>'}</div></section>
    </div>`;
  }

  function dominoValueAtSide(tile, side) {
    const pair = Array.isArray(tile) ? tile : [];
    return Number(pair[side === 'right' ? 1 : 0] || 0);
  }

  function dominoesOpenEnds(board) {
    if (!Array.isArray(board) || !board.length) return null;
    return { left: dominoValueAtSide(board[0], 'left'), right: dominoValueAtSide(board[board.length - 1], 'right') };
  }

  function dominoesPlayableSides(tile, board) {
    const pair = Array.isArray(tile) ? tile : [];
    if (!board.length) return ['left', 'right'];
    const ends = dominoesOpenEnds(board);
    const values = [Number(pair[0] || 0), Number(pair[1] || 0)];
    const sides = [];
    if (values.includes(ends.left)) sides.push('left');
    if (values.includes(ends.right)) sides.push('right');
    return sides;
  }

  function orientDominoForSide(tile, board, side) {
    const pair = Array.isArray(tile) ? tile.slice(0, 2) : [0, 0];
    if (!board.length) return pair;
    const ends = dominoesOpenEnds(board);
    if (side === 'left') return Number(pair[1]) === ends.left ? pair : [pair[1], pair[0]];
    return Number(pair[0]) === ends.right ? pair : [pair[1], pair[0]];
  }

  function settleDominoesCpuTurn() {
    const state = gamesState.dominoes;
    if (state.over || state.turn !== 'cpu') return;
    const playable = state.cpuHand.map((tile, index) => ({ tile, index, sides: dominoesPlayableSides(tile, state.board) })).filter((entry) => entry.sides.length);
    if (!playable.length) {
      if (state.boneyard.length) {
        state.cpuHand.push(state.boneyard.shift());
        state.message = 'CPU drew a tile.';
        rerenderGamesPanel();
        window.setTimeout(settleDominoesCpuTurn, 320);
        return;
      }
      state.passStreak += 1;
      if (state.passStreak >= 2) {
        state.over = true;
        const playerPips = state.playerHand.flat().reduce((sum, value) => sum + Number(value || 0), 0);
        const cpuPips = state.cpuHand.flat().reduce((sum, value) => sum + Number(value || 0), 0);
        state.winner = playerPips <= cpuPips ? 'player' : 'cpu';
        state.message = state.winner === 'player' ? 'Blocked board. You win on lower pips.' : 'Blocked board. CPU wins on lower pips.';
      } else {
        state.turn = 'player';
        state.message = 'CPU passed. Your turn.';
      }
      rerenderGamesPanel();
      return;
    }
    const pick = playable[Math.floor(Math.random() * playable.length)];
    const side = pick.sides[Math.floor(Math.random() * pick.sides.length)];
    const oriented = orientDominoForSide(pick.tile, state.board, side);
    state.cpuHand.splice(pick.index, 1);
    if (side === 'left') state.board.unshift(oriented);
    else state.board.push(oriented);
    state.passStreak = 0;
    if (!state.cpuHand.length) {
      state.over = true;
      state.winner = 'cpu';
      state.message = 'CPU used every tile and won.';
    } else {
      state.turn = 'player';
      state.message = `CPU played ${oriented[0]}-${oriented[1]}. Your turn.`;
    }
    rerenderGamesPanel();
  }

  function renderDominoesCpu(host) {
    const state = gamesState.dominoes;
    const playable = state.playerHand.map((tile, index) => ({ tile, index, sides: dominoesPlayableSides(tile, state.board) }));
    host.innerHTML = `<div class="gamesBattleArena">
      <div class="gamesBattleTopline"><div class="gamesStatus">${escapeHtml(state.message)}</div><div class="gamesBattleMeta">CPU hand: ${escapeHtml(String(state.cpuHand.length))} • Boneyard: ${escapeHtml(String(state.boneyard.length))}</div></div>
      <div class="gamesDominoBoard">${state.board.length ? state.board.map((tile) => `<div class="gamesDominoBoardTile">${renderDominoesTile(tile)}</div>`).join('') : '<div class="leaderboardEmpty">Board waiting for first tile.</div>'}</div>
      <div class="gamesActionRow"><button id="gamesDominoCpuDrawBtn" class="chipBtn" ${state.over || state.turn !== 'player' || !state.boneyard.length ? 'disabled' : ''}>Draw</button><button id="gamesDominoCpuPassBtn" class="chipBtn" ${state.over || state.turn !== 'player' ? 'disabled' : ''}>Pass</button></div>
      <div class="gamesMiniLabel">Your hand</div>
      <div class="gamesDominoHand">${playable.map((entry) => `<div class="gamesDominoTileWrap">${renderDominoesTile(entry.tile, state.turn === 'player' && !state.over && entry.sides.length)}<div class="gamesDominoActions"><button class="chipBtn miniChip" ${entry.sides.includes('left') && state.turn === 'player' && !state.over ? `data-domino-cpu="${entry.index}" data-domino-side="left"` : 'disabled'}>Left</button><button class="chipBtn miniChip" ${entry.sides.includes('right') && state.turn === 'player' && !state.over ? `data-domino-cpu="${entry.index}" data-domino-side="right"` : 'disabled'}>Right</button></div></div>`).join('')}</div>
    </div>`;
    document.getElementById('gamesDominoCpuDrawBtn')?.addEventListener('click', () => {
      if (!state.boneyard.length || state.over || state.turn !== 'player') return;
      state.playerHand.push(state.boneyard.shift());
      state.message = 'You drew a tile.';
      rerenderGamesPanel();
    });
    document.getElementById('gamesDominoCpuPassBtn')?.addEventListener('click', () => {
      if (state.over || state.turn !== 'player') return;
      state.passStreak += 1;
      state.turn = 'cpu';
      state.message = 'You passed.';
      rerenderGamesPanel();
      window.setTimeout(settleDominoesCpuTurn, 320);
    });
    host.querySelectorAll('[data-domino-cpu]').forEach((btn) => btn.addEventListener('click', () => {
      const index = Number(btn.getAttribute('data-domino-cpu'));
      const side = btn.getAttribute('data-domino-side') || 'left';
      const tile = state.playerHand[index];
      if (!tile || state.over || state.turn !== 'player') return;
      const oriented = orientDominoForSide(tile, state.board, side);
      state.playerHand.splice(index, 1);
      if (side === 'left') state.board.unshift(oriented);
      else state.board.push(oriented);
      state.passStreak = 0;
      if (!state.playerHand.length) {
        state.over = true;
        state.winner = 'player';
        state.message = 'You win! Your hand is empty.';
      } else {
        state.turn = 'cpu';
        state.message = `You played ${oriented[0]}-${oriented[1]}. CPU thinking…`;
        rerenderGamesPanel();
        window.setTimeout(settleDominoesCpuTurn, 320);
        return;
      }
      rerenderGamesPanel();
    }));
  }

  function drawBilliardsPracticeCanvas(canvas) {
    drawBilliardsCanvas(canvas, { state: { balls: gamesState.billiards.balls }, current_turn_user_id: window?.me?.id || 1 });
  }

  function settleBilliardsCpuTurn() {
    const state = gamesState.billiards;
    if (state.over) return;
    const madeShot = Math.random() > 0.48;
    if (madeShot) state.cpuScore += 1;
    if (state.cpuScore >= state.targetScore) {
      state.over = true;
      state.message = 'Bot cleared the rack first.';
    } else {
      state.message = madeShot ? 'Bot sank one. Your turn.' : 'Bot missed. Your turn.';
    }
    rerenderGamesPanel();
  }

  function renderBilliardsCpu(host) {
    const state = gamesState.billiards;
    host.innerHTML = `<div class="gamesBattleArena">
      <div class="gamesBattleTopline"><div class="gamesStatus">${escapeHtml(state.message)}</div><div class="gamesBattleMeta">You ${escapeHtml(String(state.playerScore))} • Bot ${escapeHtml(String(state.cpuScore))}</div></div>
      <canvas id="gamesBilliardsCpuCanvas" class="gamesBilliardsCanvas" width="320" height="180"></canvas>
      <div class="gamesBilliardsControls">
        <label class="gamesControlLabel">Angle <input id="gamesBilliardsAngle" type="range" min="-314" max="314" step="1" value="${Math.round((gamesState.billiardsAim.angle || 0) * 100)}" ${state.over ? 'disabled' : ''}></label>
        <label class="gamesControlLabel">Power <input id="gamesBilliardsPower" type="range" min="10" max="100" step="1" value="${Math.round((gamesState.billiardsAim.power || 0.58) * 100)}" ${state.over ? 'disabled' : ''}></label>
        <button id="gamesBilliardsShotBtn" class="chipBtn" ${state.over ? 'disabled' : ''}>Take Shot</button>
      </div>
      <div class="gamesBattleMeta">First to ${escapeHtml(String(state.targetScore))} wins this quick practice race.</div>
    </div>`;
    const canvas = document.getElementById('gamesBilliardsCpuCanvas');
    drawBilliardsPracticeCanvas(canvas);
    document.getElementById('gamesBilliardsAngle')?.addEventListener('input', (e) => { gamesState.billiardsAim.angle = Number(e.target.value || 0) / 100; drawBilliardsPracticeCanvas(canvas); });
    document.getElementById('gamesBilliardsPower')?.addEventListener('input', (e) => { gamesState.billiardsAim.power = Math.max(0.1, Math.min(1, Number(e.target.value || 58) / 100)); drawBilliardsPracticeCanvas(canvas); });
    document.getElementById('gamesBilliardsShotBtn')?.addEventListener('click', () => {
      if (state.over) return;
      state.shotsTaken += 1;
      const madeShot = Math.random() < (0.18 + (gamesState.billiardsAim.power * 0.32));
      if (madeShot) state.playerScore += 1;
      if (state.playerScore >= state.targetScore) {
        state.over = true;
        state.message = 'You cleared the practice rack first.';
      } else {
        state.message = madeShot ? 'Nice shot. Bot turn…' : 'Missed shot. Bot turn…';
        rerenderGamesPanel();
        window.setTimeout(settleBilliardsCpuTurn, 420);
        return;
      }
      rerenderGamesPanel();
    });
  }

  function renderGamesVsDriver(host, gameKey) {
    host.innerHTML = renderBattleInboxStack(gameKey);
    document.getElementById('gamesChallengeSearch')?.addEventListener('input', (e) => {
      gamesState.challengeUsers.query = String(e.target.value || '');
      void loadChallengeableUsers({ query: gamesState.challengeUsers.query, gameKey, force: true });
    });
    host.querySelectorAll('[data-games-user]').forEach((btn) => btn.addEventListener('click', () => {
      const userId = Number(btn.getAttribute('data-games-user'));
      const row = (gamesState.challengeUsers.rows || []).find((item) => Number(item.user_id) === userId) || null;
      gamesState.challengeUsers.selected = row;
      gamesState.challengeComposer.targetUserId = String(userId || '');
      gamesState.challengeComposer.targetDisplayName = row?.display_name || '';
      gamesState.challengeComposer.gameType = gameKey;
      rerenderGamesPanel();
    }));
    document.getElementById('gamesSendChallengeBtn')?.addEventListener('click', (e) => {
      e.preventDefault();
      const selected = gamesState.challengeUsers.selected;
      if (!selected?.user_id) return;
      void createBattleChallenge(selected.user_id, gameKey);
    });
    host.querySelector('[data-games-open-active="1"]')?.addEventListener('click', (e) => {
      e.preventDefault();
      const match = battleRowsForGame(gameKey).active;
      if (match?.id) {
        loadActiveBattleMatch({ silent: true, preferredMatchId: match.id }).then(() => rerenderGamesPanel());
      }
    });
  }

  function gamesPanelHTML() {
    const activeTab = gamesState.activeTab || 'chess';
    const activeMode = activeGamesMode();
    const showModeSelector = activeTab === 'dominoes' || activeTab === 'billiards';
    return `
      <div class="panelBlock gamesPanelWrap">
        <div class="gamesTabs gamesModeTabs">
          <button id="gamesTabChess" class="chipBtn gamesTabBtn ${activeTab === 'chess' ? 'active' : ''}">Chess</button>
          <button id="gamesTabUno" class="chipBtn gamesTabBtn ${activeTab === 'uno' ? 'active' : ''}">UNO</button>
          <button id="gamesTabDominoes" class="chipBtn gamesTabBtn ${activeTab === 'dominoes' ? 'active' : ''}">Dominoes</button>
          <button id="gamesTabBilliards" class="chipBtn gamesTabBtn ${activeTab === 'billiards' ? 'active' : ''}">Billiards</button>
          <button id="gamesResetBtn" class="chipBtn">New Game</button>
        </div>
        ${showModeSelector ? `<div class="gamesTabs gamesBattleTabs">
          <button class="chipBtn gamesTabBtn ${activeMode === 'cpu' ? 'active' : ''}" data-games-mode="cpu">CPU</button>
          <button class="chipBtn gamesTabBtn ${activeMode === 'vs_driver' ? 'active' : ''}" data-games-mode="vs_driver">Vs Driver</button>
        </div>` : ''}
        <div class="gamesStatus ${gamesState.error ? 'err' : ''}">${escapeHtml(gamesState.status || '')}</div>
        <div id="gamesContent"></div>
      </div>
    `;
  }

  function wireGamesPanel() {
    document.getElementById('gamesTabChess')?.addEventListener('click', (e) => { e.preventDefault(); gamesState.activeTab = 'chess'; rerenderGamesPanel(); });
    document.getElementById('gamesTabUno')?.addEventListener('click', (e) => { e.preventDefault(); gamesState.activeTab = 'uno'; rerenderGamesPanel(); });
    document.getElementById('gamesTabDominoes')?.addEventListener('click', (e) => { e.preventDefault(); gamesState.activeTab = 'dominoes'; rerenderGamesPanel(); });
    document.getElementById('gamesTabBilliards')?.addEventListener('click', (e) => { e.preventDefault(); gamesState.activeTab = 'billiards'; rerenderGamesPanel(); });
    document.querySelectorAll('[data-games-mode]').forEach((btn) => btn.addEventListener('click', (e) => {
      e.preventDefault();
      setGamesTabMode(gamesState.activeTab, btn.getAttribute('data-games-mode') || 'cpu');
      rerenderGamesPanel();
    }));
    document.getElementById('gamesResetBtn')?.addEventListener('click', (e) => {
      e.preventDefault();
      if (gamesState.activeTab === 'chess') gamesState.chess = createInitialChessState();
      else if (gamesState.activeTab === 'uno') {
        gamesState.uno = createInitialUnoState();
        gamesState.unoWaitingColor = false;
      } else if (gamesState.activeTab === 'dominoes' && activeGamesMode() === 'cpu') {
        gamesState.dominoes = createInitialDominoesState();
      } else if (gamesState.activeTab === 'billiards' && activeGamesMode() === 'cpu') {
        gamesState.billiards = createInitialBilliardsPracticeState();
      } else {
        gamesState.challengeComposer = { targetUserId: '', targetDisplayName: '', gameType: gamesState.activeTab === 'billiards' ? 'billiards' : 'dominoes' };
        gamesState.challengeUsers.selected = null;
        setGamesStatus('Challenge composer reset.');
      }
      rerenderGamesPanel();
      if (gamesState.activeTab === 'uno') maybeRunUnoCpuTurn();
      if (activeGamesMode() === 'vs_driver') {
        void loadGamesBattleDashboard({ silent: true });
        void loadChallengeableUsers({ query: gamesState.challengeUsers.query || '', gameKey: gamesState.activeTab, force: true });
      }
    });
    renderGamesContent();
    if (activeGamesMode() === 'vs_driver') {
      scheduleGamesDashboardPoll();
      if (gamesState.dashboard?.activeMatch?.id || gamesState.activeMatch?.id) scheduleGamesMatchPoll();
    }
  }

  function rerenderGamesPanel() {
    if (!isGamesPanelOpen()) return;
    const body = document.getElementById('dockDrawerBody');
    if (!body) return;
    body.innerHTML = gamesPanelHTML();
    wireGamesPanel();
  }

  function renderGamesContent() {
    const host = document.getElementById('gamesContent');
    if (!host) return;
    if (gamesState.activeTab === 'chess') {
      renderChessContent(host);
      return;
    }
    if (gamesState.activeTab === 'uno') {
      renderUnoContent(host);
      return;
    }
    if (gamesState.activeTab === 'dominoes') {
      if (activeGamesMode() === 'cpu') renderDominoesCpu(host);
      else if (battleRowsForGame('dominoes').active) renderActiveBattle(host);
      else renderGamesVsDriver(host, 'dominoes');
    } else {
      if (activeGamesMode() === 'cpu') renderBilliardsCpu(host);
      else if (battleRowsForGame('billiards').active) renderActiveBattle(host);
      else renderGamesVsDriver(host, 'billiards');
    }
    host.querySelectorAll('[data-games-accept]').forEach((btn) => btn.addEventListener('click', (e) => { e.preventDefault(); void respondToChallenge(btn.getAttribute('data-games-accept'), 'accept'); }));
    host.querySelectorAll('[data-games-decline]').forEach((btn) => btn.addEventListener('click', (e) => { e.preventDefault(); void respondToChallenge(btn.getAttribute('data-games-decline'), 'decline'); }));
    host.querySelectorAll('[data-games-cancel]').forEach((btn) => btn.addEventListener('click', (e) => { e.preventDefault(); void respondToChallenge(btn.getAttribute('data-games-cancel'), 'cancel'); }));
  }

  function openGamesBattleComposer({ targetUserId = '', displayName = '', gameType = 'dominoes' } = {}) {
    const normalizedGame = gameType === 'billiards' ? 'billiards' : 'dominoes';
    gamesState.activeTab = normalizedGame;
    gamesState.activeModeByGame[normalizedGame] = 'vs_driver';
    gamesState.challengeComposer = {
      targetUserId: String(targetUserId || '').trim(),
      targetDisplayName: String(displayName || '').trim(),
      gameType: normalizedGame,
    };
    gamesState.challengeUsers.selected = targetUserId ? { user_id: Number(targetUserId), display_name: String(displayName || 'Driver') } : null;
    if (typeof openPanel === 'function') {
      openPanel('games', 'Games', gamesPanelHTML(), wireGamesPanel);
    } else {
      rerenderGamesPanel();
    }
    void loadGamesBattleDashboard({ silent: true });
    void loadChallengeableUsers({ query: '', gameKey: normalizedGame, force: true });
  }


  function chessPieceName(type) {
    if (type === 'P') return 'pawn';
    if (type === 'N') return 'knight';
    if (type === 'B') return 'bishop';
    if (type === 'R') return 'rook';
    if (type === 'Q') return 'queen';
    if (type === 'K') return 'king';
    return 'piece';
  }

  function chessPieceSvg(piece) {
    const isWhite = piece[0] === 'w';
    const type = piece[1];
    const bodyFill = isWhite ? '#f8f8f8' : '#1c1c1c';
    const bodyStroke = isWhite ? '#3a3a3a' : '#ececec';
    const glyph = CHESS_PIECE_SVGS[type] || CHESS_PIECE_SVGS.P;
    return `<svg class="chessPieceIcon" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><circle cx="50" cy="50" r="34" fill="${bodyFill}" class="chessPieceBase"></circle><g fill="${bodyStroke}" class="chessPieceMark">${glyph}</g></svg>`;
  }

  function createInitialChessState() {
    return {
      board: [
        ['bR','bN','bB','bQ','bK','bB','bN','bR'],
        ['bP','bP','bP','bP','bP','bP','bP','bP'],
        [null,null,null,null,null,null,null,null],
        [null,null,null,null,null,null,null,null],
        [null,null,null,null,null,null,null,null],
        [null,null,null,null,null,null,null,null],
        ['wP','wP','wP','wP','wP','wP','wP','wP'],
        ['wR','wN','wB','wQ','wK','wB','wN','wR']
      ],
      turn: 'w',
      selected: null,
      legalTargets: [],
      over: false,
      message: 'Your turn (White)'
    };
  }

  function renderChessContent(host) {
    const s = gamesState.chess;
    const legalSet = new Set(s.legalTargets.map((m) => `${m.r},${m.c}`));
    host.innerHTML = `
      <div class="gamesStatus">${escapeHtml(s.message)}</div>
      <div class="gamesBoard" id="gamesChessBoard"></div>
    `;
    const boardEl = document.getElementById('gamesChessBoard');
    if (!boardEl) return;
    for (let r = 0; r < 8; r += 1) {
      for (let c = 0; c < 8; c += 1) {
        const piece = s.board[r][c];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `gamesSq ${(r + c) % 2 === 0 ? 'light' : 'dark'}`;
        if (s.selected && s.selected.r === r && s.selected.c === c) btn.classList.add('sel');
        if (legalSet.has(`${r},${c}`)) btn.classList.add('legal');
        if (piece) {
          btn.innerHTML = chessPieceSvg(piece);
          btn.setAttribute('aria-label', `${piece[0] === 'w' ? 'White' : 'Black'} ${chessPieceName(piece[1])}`);
        } else {
          btn.textContent = '';
          btn.removeAttribute('aria-label');
        }
        btn.disabled = s.over || s.turn !== 'w';
        btn.addEventListener('click', () => onChessSquareClick(r, c));
        boardEl.appendChild(btn);
      }
    }
  }

  function onChessSquareClick(r, c) {
    const s = gamesState.chess;
    if (s.over || s.turn !== 'w') return;
    const p = s.board[r][c];
    if (s.selected) {
      const target = s.legalTargets.find((m) => m.r === r && m.c === c);
      if (target) {
        applyChessMove(s, target);
        s.selected = null;
        s.legalTargets = [];
        updateChessStatus();
        rerenderGamesPanel();
        if (!s.over && s.turn === 'b') setTimeout(runChessCpuTurn, 240);
        return;
      }
    }
    if (p && p[0] === 'w') {
      s.selected = { r, c };
      s.legalTargets = legalChessMovesForPiece(s, r, c);
    } else {
      s.selected = null;
      s.legalTargets = [];
    }
    rerenderGamesPanel();
  }

  function runChessCpuTurn() {
    const s = gamesState.chess;
    if (s.over || s.turn !== 'b') return;
    const moves = legalChessMoves(s, 'b');
    if (!moves.length) {
      updateChessStatus();
      rerenderGamesPanel();
      return;
    }
    let best = [];
    let bestScore = -1e9;
    for (const mv of moves) {
      let score = 0;
      if (mv.capture) score += pieceValue(mv.capture) * 10 - pieceValue(mv.piece);
      if (mv.promotion) score += 8;
      score += Math.random() * 0.2;
      if (score > bestScore) { bestScore = score; best = [mv]; }
      else if (Math.abs(score - bestScore) < 0.001) best.push(mv);
    }
    const pick = best[Math.floor(Math.random() * best.length)] || moves[0];
    applyChessMove(s, pick);
    updateChessStatus();
    rerenderGamesPanel();
  }

  function pieceValue(piece) {
    if (!piece) return 0;
    const t = piece[1];
    if (t === 'P') return 1;
    if (t === 'N' || t === 'B') return 3;
    if (t === 'R') return 5;
    if (t === 'Q') return 9;
    if (t === 'K') return 100;
    return 0;
  }

  function cloneBoard(board) { return board.map((row) => row.slice()); }

  function applyChessMove(state, move) {
    const b = state.board;
    const piece = b[move.from.r][move.from.c];
    b[move.from.r][move.from.c] = null;
    b[move.r][move.c] = move.promotion ? `${piece[0]}Q` : piece;
    state.turn = state.turn === 'w' ? 'b' : 'w';
  }

  function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }

  function legalChessMovesForPiece(state, r, c) {
    const p = state.board[r][c];
    if (!p) return [];
    const all = legalChessMoves(state, p[0]);
    return all.filter((m) => m.from.r === r && m.from.c === c);
  }

  function legalChessMoves(state, color) {
    const raw = [];
    for (let r = 0; r < 8; r += 1) {
      for (let c = 0; c < 8; c += 1) {
        const p = state.board[r][c];
        if (!p || p[0] !== color) continue;
        raw.push(...pieceMoves(state.board, r, c, p));
      }
    }
    return raw.filter((mv) => {
      const b = cloneBoard(state.board);
      const piece = b[mv.from.r][mv.from.c];
      b[mv.from.r][mv.from.c] = null;
      b[mv.r][mv.c] = mv.promotion ? `${piece[0]}Q` : piece;
      return !isKingInCheck(b, color);
    });
  }

  function pieceMoves(board, r, c, piece) {
    const color = piece[0];
    const type = piece[1];
    const enemy = color === 'w' ? 'b' : 'w';
    const out = [];
    const push = (nr, nc, opts = {}) => {
      if (!inBounds(nr, nc)) return;
      const target = board[nr][nc];
      if (target && target[0] === color) return;
      out.push({ from: { r, c }, r: nr, c: nc, piece, capture: target || null, promotion: !!opts.promotion });
    };

    if (type === 'P') {
      const dir = color === 'w' ? -1 : 1;
      const start = color === 'w' ? 6 : 1;
      const promoRow = color === 'w' ? 0 : 7;
      const nr = r + dir;
      if (inBounds(nr, c) && !board[nr][c]) {
        push(nr, c, { promotion: nr === promoRow });
        const nr2 = r + dir * 2;
        if (r === start && !board[nr2][c]) push(nr2, c);
      }
      for (const dc of [-1, 1]) {
        const nc = c + dc;
        if (!inBounds(nr, nc)) continue;
        const t = board[nr][nc];
        if (t && t[0] === enemy) push(nr, nc, { promotion: nr === promoRow });
      }
      return out;
    }

    if (type === 'N') {
      [[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]].forEach(([dr,dc]) => push(r+dr,c+dc));
      return out;
    }

    if (type === 'K') {
      for (let dr=-1; dr<=1; dr+=1) for (let dc=-1; dc<=1; dc+=1) if (dr||dc) push(r+dr,c+dc);
      return out;
    }

    const dirs = type === 'B' ? [[1,1],[1,-1],[-1,1],[-1,-1]] : type === 'R' ? [[1,0],[-1,0],[0,1],[0,-1]] : [[1,1],[1,-1],[-1,1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
    for (const [dr,dc] of dirs) {
      let nr = r + dr;
      let nc = c + dc;
      while (inBounds(nr,nc)) {
        const t = board[nr][nc];
        if (!t) {
          out.push({ from:{r,c}, r:nr, c:nc, piece, capture:null, promotion:false });
        } else {
          if (t[0] !== color) out.push({ from:{r,c}, r:nr, c:nc, piece, capture:t, promotion:false });
          break;
        }
        nr += dr;
        nc += dc;
      }
    }
    return out;
  }

  function isKingInCheck(board, color) {
    let kr = -1; let kc = -1;
    for (let r = 0; r < 8; r += 1) for (let c = 0; c < 8; c += 1) if (board[r][c] === `${color}K`) { kr = r; kc = c; }
    if (kr < 0) return true;
    const enemy = color === 'w' ? 'b' : 'w';
    for (let r = 0; r < 8; r += 1) {
      for (let c = 0; c < 8; c += 1) {
        const p = board[r][c];
        if (!p || p[0] !== enemy) continue;
        const moves = pieceMoves(board, r, c, p);
        if (moves.some((m) => m.r === kr && m.c === kc)) return true;
      }
    }
    return false;
  }

  function updateChessStatus() {
    const s = gamesState.chess;
    const legal = legalChessMoves(s, s.turn);
    const inCheck = isKingInCheck(s.board, s.turn);
    if (!legal.length) {
      s.over = true;
      if (inCheck) s.message = s.turn === 'w' ? 'Checkmate. CPU wins.' : 'Checkmate. You win!';
      else s.message = 'Stalemate.';
      return;
    }
    s.over = false;
    if (s.turn === 'w') s.message = inCheck ? 'Your turn (White) - Check!' : 'Your turn (White)';
    else s.message = inCheck ? 'CPU turn (Black) - Check!' : 'CPU turn (Black)';
  }

  function createUnoDeck() {
    const deck = [];
    for (const color of UNO_COLORS) {
      deck.push({ color, type: 'num', value: 0 });
      for (let n = 1; n <= 9; n += 1) {
        deck.push({ color, type: 'num', value: n });
        deck.push({ color, type: 'num', value: n });
      }
      for (const action of UNO_ACTIONS) {
        deck.push({ color, type: action });
        deck.push({ color, type: action });
      }
    }
    for (let i = 0; i < 4; i += 1) deck.push({ color: 'wild', type: 'wild' });
    for (let i = 0; i < 4; i += 1) deck.push({ color: 'wild', type: 'wild4' });
    for (let i = deck.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
    }
    return deck;
  }

  function createInitialUnoState() {
    const deck = createUnoDeck();
    const player = []; const cpu = [];
    for (let i = 0; i < 7; i += 1) { player.push(deck.pop()); cpu.push(deck.pop()); }
    let first = deck.pop();
    while (first && first.color === 'wild') { deck.unshift(first); first = deck.pop(); }
    return {
      player,
      cpu,
      draw: deck,
      discard: [first],
      turn: 'player',
      currentColor: first?.color || 'red',
      over: false,
      message: 'Your turn'
    };
  }

  function cardLabel(card) {
    if (!card) return '';
    if (card.type === 'num') return `${card.value}`;
    if (card.type === 'skip') return 'SKIP';
    if (card.type === 'reverse') return 'REV';
    if (card.type === 'draw2') return '+2';
    if (card.type === 'wild') return 'W';
    if (card.type === 'wild4') return '+4';
    return '?';
  }

  function isUnoPlayable(card, top, color) {
    if (!card || !top) return false;
    if (card.color === 'wild') return true;
    if (card.color === color) return true;
    if (card.type === 'num' && top.type === 'num' && card.value === top.value) return true;
    return card.type === top.type;
  }

  function ensureUnoDraw(state) {
    if (state.draw.length) return;
    if (state.discard.length <= 1) return;
    const top = state.discard.pop();
    state.draw = state.discard;
    state.discard = [top];
    for (let i = state.draw.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = state.draw[i]; state.draw[i] = state.draw[j]; state.draw[j] = t;
    }
  }

  function drawUnoCard(state, hand) {
    ensureUnoDraw(state);
    if (!state.draw.length) return null;
    const c = state.draw.pop();
    hand.push(c);
    return c;
  }


  function unoCardFaceMarkup(card) {
    const label = cardLabel(card);
    if (!card) return '';
    if (card.color === 'wild') {
      return `<span class="gamesUnoFace gamesUnoFaceWild"><span class="gamesUnoBadge" aria-hidden="true"></span><span>${escapeHtml(label)}</span></span>`;
    }
    return `<span class="gamesUnoFace"><span>${escapeHtml(label)}</span></span>`;
  }

  function renderUnoContent(host) {
    const s = gamesState.uno;
    const top = s.discard[s.discard.length - 1];
    host.innerHTML = `
      <div class="gamesUnoRows">
        <div class="gamesStatus">${escapeHtml(s.message)}${s.over ? '' : s.turn === 'player' ? '' : ' (CPU thinking...)'}</div>
        <div class="gamesUnoTop">
          <div>
            <div class="gamesMiniLabel">CPU cards: ${s.cpu.length}</div>
            <div class="gamesUnoHand">${s.cpu.slice(0, 6).map(() => '<div class="gamesUnoCard mini wild"><span class="gamesUnoBackTag"><span class="gamesUnoBadge" aria-hidden="true"></span><span>UNO</span></span></div>').join('')}</div>
          </div>
          <div class="gamesUnoPile">
            <div>
              <div class="gamesMiniLabel">Draw (${s.draw.length})</div>
              <button id="unoDrawBtn" class="gamesUnoCard mini wild" ${s.over || s.turn !== 'player' || gamesState.unoWaitingColor ? 'disabled' : ''}><span class="gamesUnoBackTag"><span class="gamesUnoBadge" aria-hidden="true"></span><span>Draw</span></span></button>
            </div>
            <div>
              <div class="gamesMiniLabel">Discard (${s.currentColor})</div>
              <div class="gamesUnoCard ${top?.color || 'wild'}">${unoCardFaceMarkup(top)}</div>
            </div>
          </div>
        </div>
        <div class="gamesMiniLabel">Your hand</div>
        <div id="unoPlayerHand" class="gamesUnoHand"></div>
        <div id="unoColorPick" class="gamesUnoColorPick"></div>
      </div>
    `;
    const handEl = document.getElementById('unoPlayerHand');
    if (handEl) {
      s.player.forEach((card, idx) => {
        const playable = !s.over && s.turn === 'player' && !gamesState.unoWaitingColor && isUnoPlayable(card, top, s.currentColor);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `gamesUnoCard ${card.color} ${playable ? '' : 'unplayable'}`;
        btn.innerHTML = unoCardFaceMarkup(card);
        btn.disabled = !playable;
        btn.addEventListener('click', () => onUnoPlayerPlay(idx));
        handEl.appendChild(btn);
      });
    }
    document.getElementById('unoDrawBtn')?.addEventListener('click', (e) => {
      e.preventDefault();
      if (s.over || s.turn !== 'player' || gamesState.unoWaitingColor) return;
      const drawn = drawUnoCard(s, s.player);
      if (drawn && isUnoPlayable(drawn, top, s.currentColor)) {
        s.message = 'You drew a playable card.';
      } else {
        s.turn = 'cpu';
        s.message = 'CPU turn';
        rerenderGamesPanel();
        setTimeout(maybeRunUnoCpuTurn, 420);
      }
      rerenderGamesPanel();
    });
    renderUnoColorPicker();
  }

  function renderUnoColorPicker() {
    const holder = document.getElementById('unoColorPick');
    if (!holder) return;
    if (!gamesState.unoWaitingColor) { holder.innerHTML = ''; return; }
    holder.innerHTML = '<div class="gamesMiniLabel" style="width:100%;">Choose color:</div>';
    UNO_COLORS.forEach((color) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `gamesUnoCard mini ${color}`;
      btn.textContent = color[0].toUpperCase();
      btn.addEventListener('click', () => {
        const s = gamesState.uno;
        s.currentColor = color;
        gamesState.unoWaitingColor = false;
        finalizeUnoTurnAfterCard();
      });
      holder.appendChild(btn);
    });
  }

  function onUnoPlayerPlay(index) {
    const s = gamesState.uno;
    if (s.over || s.turn !== 'player') return;
    const top = s.discard[s.discard.length - 1];
    const card = s.player[index];
    if (!isUnoPlayable(card, top, s.currentColor)) return;
    s.player.splice(index, 1);
    s.discard.push(card);
    if (card.color !== 'wild') s.currentColor = card.color;
    if (s.player.length === 0) { s.over = true; s.message = 'You win!'; rerenderGamesPanel(); return; }
    if (card.color === 'wild') { gamesState.unoWaitingColor = true; rerenderGamesPanel(); return; }
    finalizeUnoTurnAfterCard();
  }

  function finalizeUnoTurnAfterCard() {
    const s = gamesState.uno;
    const card = s.discard[s.discard.length - 1];
    let cpuExtraDraw = 0;
    let skipCpu = false;
    if (card.type === 'skip') skipCpu = true;
    if (card.type === 'reverse') skipCpu = true;
    if (card.type === 'draw2') cpuExtraDraw = 2;
    if (card.type === 'wild4') cpuExtraDraw = 4;
    for (let i = 0; i < cpuExtraDraw; i += 1) drawUnoCard(s, s.cpu);
    if (skipCpu) {
      s.turn = 'player';
      s.message = 'CPU skipped. Your turn.';
      rerenderGamesPanel();
      return;
    }
    s.turn = 'cpu';
    s.message = 'CPU turn';
    rerenderGamesPanel();
    setTimeout(maybeRunUnoCpuTurn, 420);
  }

  function maybeRunUnoCpuTurn() {
    const s = gamesState.uno;
    if (s.over || s.turn !== 'cpu') return;
    const top = s.discard[s.discard.length - 1];
    let idx = s.cpu.findIndex((card) => isUnoPlayable(card, top, s.currentColor));
    if (idx < 0) {
      drawUnoCard(s, s.cpu);
      idx = s.cpu.findIndex((card) => isUnoPlayable(card, top, s.currentColor));
      if (idx < 0) {
        s.turn = 'player';
        s.message = 'Your turn';
        rerenderGamesPanel();
        return;
      }
    }
    const card = s.cpu.splice(idx, 1)[0];
    s.discard.push(card);
    if (card.color === 'wild') {
      const counts = { red:0, yellow:0, green:0, blue:0 };
      s.cpu.forEach((c) => { if (counts[c.color] != null) counts[c.color] += 1; });
      s.currentColor = UNO_COLORS.sort((a,b) => counts[b]-counts[a])[0] || 'red';
    } else {
      s.currentColor = card.color;
    }
    if (s.cpu.length === 0) { s.over = true; s.message = 'CPU wins.'; rerenderGamesPanel(); return; }
    let playerDraw = 0;
    let skipPlayer = false;
    if (card.type === 'skip') skipPlayer = true;
    if (card.type === 'reverse') skipPlayer = true;
    if (card.type === 'draw2') playerDraw = 2;
    if (card.type === 'wild4') playerDraw = 4;
    for (let i = 0; i < playerDraw; i += 1) drawUnoCard(s, s.player);
    if (skipPlayer) {
      s.turn = 'cpu';
      s.message = 'You were skipped.';
      rerenderGamesPanel();
      setTimeout(maybeRunUnoCpuTurn, 420);
      return;
    }
    s.turn = 'player';
    s.message = 'Your turn';
    rerenderGamesPanel();
  }

  function getDockViewport() {
    return document.getElementById('dockViewport');
  }

  function getDockTrack() {
    return document.getElementById('dockTrack');
  }

  function getDockSaveButton() {
    return document.getElementById('pickupFab');
  }

  function updateDockScrollHints() {
    const dock = document.getElementById('dock');
    const viewport = getDockViewport();
    if (!dock || !viewport) return;
    const maxScroll = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    const leftVisible = viewport.scrollLeft > 2;
    const rightVisible = viewport.scrollLeft < (maxScroll - 2);
    dock.classList.toggle('dock-can-scroll-left', leftVisible);
    dock.classList.toggle('dock-can-scroll-right', rightVisible);
  }

  function centerDockOnSave({ behavior = 'smooth' } = {}) {
    const viewport = getDockViewport();
    const saveBtn = getDockSaveButton();
    if (!viewport || !saveBtn) return;

    const viewportWidth = viewport.clientWidth;
    const targetLeft = saveBtn.offsetLeft + (saveBtn.offsetWidth / 2) - (viewportWidth / 2);
    const maxScroll = Math.max(0, viewport.scrollWidth - viewportWidth);
    const clampedLeft = Math.max(0, Math.min(maxScroll, targetLeft));
    viewport.scrollTo({ left: clampedLeft, behavior });
  }

  let dockAutoCenterTimer = 0;
  let dockPointerIsDown = false;

  function cancelDockAutoCenter() {
    if (!dockAutoCenterTimer) return;
    clearTimeout(dockAutoCenterTimer);
    dockAutoCenterTimer = 0;
  }

  function scheduleDockAutoCenter() {
    cancelDockAutoCenter();
    dockAutoCenterTimer = setTimeout(() => {
      if (dockPointerIsDown) {
        scheduleDockAutoCenter();
        return;
      }
      dockAutoCenterTimer = 0;
      centerDockOnSave({ behavior: 'smooth' });
    }, 10000);
  }

  function scrollDockByStep(direction) {
    const viewport = getDockViewport();
    if (!viewport) return;
    const step = Math.max(120, Math.round(viewport.clientWidth * 1.2));
    viewport.scrollBy({ left: direction * step, behavior: 'smooth' });
    scheduleDockAutoCenter();
  }

  function initDockScroller() {
    const viewport = getDockViewport();
    const leftHint = document.getElementById('dockScrollHintLeft');
    const rightHint = document.getElementById('dockScrollHintRight');
    if (!viewport) return;

    let rafId = 0;
    const scheduleHintUpdate = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        updateDockScrollHints();
      });
    };

    const handleDockInteraction = () => {
      cancelDockAutoCenter();
      scheduleHintUpdate();
      scheduleDockAutoCenter();
    };

    const beginDockDrag = () => {
      dockPointerIsDown = true;
      handleDockInteraction();
    };

    const endDockDrag = () => {
      if (!dockPointerIsDown) return;
      dockPointerIsDown = false;
      scheduleDockAutoCenter();
    };

    viewport.addEventListener('scroll', handleDockInteraction, { passive: true });
    viewport.addEventListener('pointerdown', beginDockDrag, { passive: true });
    viewport.addEventListener('touchstart', beginDockDrag, { passive: true });
    viewport.addEventListener('wheel', handleDockInteraction, { passive: true });
    window.addEventListener('pointerup', endDockDrag, { passive: true });
    window.addEventListener('pointercancel', endDockDrag, { passive: true });
    window.addEventListener('touchend', endDockDrag, { passive: true });
    window.addEventListener('touchcancel', endDockDrag, { passive: true });
    window.addEventListener('resize', () => {
      centerDockOnSave({ behavior: 'auto' });
      scheduleHintUpdate();
      scheduleDockAutoCenter();
    });

    leftHint?.addEventListener('click', () => scrollDockByStep(-1));
    rightHint?.addEventListener('click', () => scrollDockByStep(1));

    centerDockOnSave({ behavior: 'auto' });
    scheduleHintUpdate();
    scheduleDockAutoCenter();
    setTimeout(() => {
      centerDockOnSave({ behavior: 'auto' });
      scheduleHintUpdate();
    }, 120);
  }


  const driverProfileState = {
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
    dmInitialLoadComplete: false,
    pollTimer: null,
    error: "",
    status: "",
    sending: false
  };
  
  const recentOutgoingDmEchoes = new Map();
  let driverProfileLayoutBound = false;
  let driverProfileLayoutTimer50 = null;
  let driverProfileLayoutTimer180 = null;

  function injectDriverProfileStyles() {
    if (document.getElementById('driverProfileModalStyles')) return;
    const style = document.createElement('style');
    style.id = 'driverProfileModalStyles';
    style.textContent = `
      #driverProfileModalRoot{position:fixed;inset:0;z-index:9800;display:none}
      #driverProfileModalRoot.open{display:block}
      .driverProfileBackdrop{position:absolute;inset:0;background:rgba(7,10,19,.42);z-index:9800}
      .driverProfileSheet{position:absolute;left:50%;transform:translate(-50%,110%);bottom:var(--driver-profile-bottom-offset, 14px);width:min(430px,calc(100vw - 16px));max-height:calc(100dvh - var(--driver-profile-bottom-offset, 14px) - env(safe-area-inset-top) - 6px);background:rgba(255,255,255,.985);border-radius:24px 24px 16px 16px;box-shadow:0 -12px 30px rgba(0,0,0,.2);display:flex;flex-direction:column;overflow:hidden;transition:transform .18s ease-out;z-index:9801}
      #driverProfileModalRoot.open .driverProfileSheet{transform:translate(-50%,0)}
      .driverProfileBody{display:flex;flex-direction:column;min-height:0;height:100%}
      .driverProfileHeader{display:flex;align-items:flex-start;justify-content:space-between;gap:5px;padding:7px 10px 4px}
      .driverProfileIdentity{display:flex;gap:6px;align-items:center;min-width:0}
      .driverProfileAvatar{width:44px;height:44px;border-radius:999px;flex:0 0 44px;object-fit:cover;background:#e8edf5}
      .driverProfileName{font-size:15px;line-height:1.18;font-weight:700;color:#111827;word-break:break-word}
      .driverProfileBadgeRow{display:flex;align-items:center;gap:5px;margin-top:1px;min-height:20px}
      .driverProfileBadgeChipWrap{display:inline-flex;align-items:center;gap:7px}.driverProfileBadgeLabel{font-size:11px;font-weight:700;color:#334155;letter-spacing:.15px}
      .driverProfileProgressWrap{background:#f8fafc;border:1px solid #e2e8f0;border-radius:11px;padding:5px;margin-bottom:6px}
      .driverProfileProgressHead{display:flex;align-items:center;justify-content:space-between;gap:5px;margin-bottom:3px}
      .driverProfileProgressLine{font-size:12px;font-weight:700;color:#0f172a;display:flex;align-items:center;gap:5px;min-width:0;flex-wrap:wrap}
      .driverProfileProgressMeta{font-size:11px;color:#475569;line-height:1.3}
      .driverProfileProgressBar{height:7px;border-radius:999px;background:#e2e8f0;overflow:hidden;margin:2px 0 3px}
      .driverProfileProgressFill{height:100%;background:linear-gradient(90deg,#3b82f6,#22c55e);border-radius:999px;transition:width .2s ease-out}
      .driverProfileRankName{color:#0f172a;font-weight:800}
      .driverProfileBreakdownGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px 7px;margin-top:3px;padding-top:3px;border-top:1px dashed #dbe4ee}
      .rankBadgeIconWrap{width:56px;height:56px;display:grid;place-items:center;border-radius:999px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.35),0 5px 14px rgba(2,6,23,.2)}
      .rankBadgeIconWrap.compact{width:44px;height:44px}
      .rankBadgeIconWrap.toneRecruit{background:linear-gradient(140deg,#64748b,#334155);color:#e2e8f0}
      .rankBadgeIconWrap.toneEnlisted{background:linear-gradient(140deg,#2563eb,#0f172a);color:#dbeafe}
      .rankBadgeIconWrap.toneOfficer{background:linear-gradient(140deg,#7c3aed,#1e1b4b);color:#ede9fe}
      .rankBadgeIconWrap.toneGeneral{background:linear-gradient(140deg,#f59e0b,#7c2d12);color:#fef3c7}
      .rankBadgeIconWrap.toneLegend{background:linear-gradient(140deg,#22d3ee,#4f46e5);color:#ecfeff;box-shadow:0 0 0 1px rgba(255,255,255,.25),0 0 18px rgba(56,189,248,.5)}
      #levelUpOverlayRoot{position:fixed;inset:0;z-index:9845;display:none;pointer-events:none;align-items:center;justify-content:center;padding:20px}
      #levelUpOverlayRoot.open{display:flex}
      .levelUpOverlayCard{position:relative;isolation:isolate;min-width:min(390px,calc(100vw - 24px));max-width:min(460px,calc(100vw - 20px));background:linear-gradient(150deg,rgba(7,12,24,.97),rgba(15,23,42,.94) 46%,rgba(30,64,175,.28) 100%);border:1px solid rgba(125,211,252,.44);border-radius:24px;box-shadow:0 22px 58px rgba(2,6,23,.68),0 0 44px rgba(56,189,248,.33),inset 0 0 0 1px rgba(255,255,255,.05);padding:22px 20px;color:#e2e8f0;display:flex;align-items:center;gap:16px;opacity:0;transform:translateY(16px) scale(.9);transition:opacity .32s ease,transform .42s cubic-bezier(.18,.85,.24,1.2)}
      .levelUpOverlayCard::before{content:'';position:absolute;inset:-18%;z-index:-1;background:radial-gradient(circle,rgba(56,189,248,.26) 0%,rgba(59,130,246,.16) 40%,rgba(14,116,144,0) 72%);opacity:0;transform:scale(.86)}
      #levelUpOverlayRoot.open .levelUpOverlayCard{opacity:1;transform:translateY(0) scale(1)}
      #levelUpOverlayRoot.open .levelUpOverlayCard::before{animation:levelUpOverlayBurst .9s ease-out .1s both}
      .levelUpOverlayCard .rankBadgeIconWrap{width:74px;height:74px;flex:0 0 74px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.42),0 12px 26px rgba(2,6,23,.5),0 0 30px rgba(56,189,248,.34)}
      .levelUpOverlayCard .rankBadgeIconWrap svg{width:42px;height:42px}
      .levelUpOverlayText{min-width:0;display:flex;flex-direction:column;gap:4px}
      .levelUpTag{font-size:12px;font-weight:900;letter-spacing:1px;text-transform:uppercase;color:#67e8f9}
      .levelUpTitle{font-size:24px;font-weight:900;line-height:1.04;color:#fff}
      .levelUpSub{font-size:15px;font-weight:800;color:#c7d2fe}
      .levelUpXp{font-size:13px;font-weight:800;color:#93c5fd}
      .pickupProgressReward{position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom, 0px) + var(--pickup-reward-bottom, 240px));width:min(320px,calc(100vw - 22px));transform:translate(-50%,26px) scale(.9);opacity:0;z-index:9802;pointer-events:none;display:block;color:#e2e8f0;transition:opacity .42s ease,transform .42s cubic-bezier(.16,.82,.24,1.18);text-shadow:0 4px 20px rgba(2,6,23,.62),0 1px 1px rgba(2,6,23,.45)}
      .pickupProgressRewardCard{position:relative;overflow:hidden;border-radius:22px;padding:14px 14px 13px;background:linear-gradient(160deg,rgba(2,6,23,.94) 0%,rgba(15,23,42,.92) 50%,rgba(30,64,175,.44) 100%);border:1px solid rgba(125,211,252,.34);box-shadow:0 20px 46px rgba(2,6,23,.56),0 0 34px rgba(56,189,248,.28),inset 0 1px 0 rgba(255,255,255,.1);display:flex;flex-direction:column;align-items:center;gap:7px}
      .pickupProgressRewardCard::before{content:'';position:absolute;inset:-24% -12% auto -12%;height:86%;background:radial-gradient(circle at top,rgba(125,211,252,.28) 0%,rgba(56,189,248,0) 65%);opacity:.7;pointer-events:none}
      .pickupProgressReward.show{opacity:1;transform:translate(-50%,0) scale(1)}
      .pickupProgressRewardKicker,.pickupProgressRewardXp,.pickupProgressRewardLevel,.pickupProgressRewardRank,.pickupProgressRewardFoot{opacity:0;transform:translateY(7px);transition:opacity .24s ease,transform .24s ease}
      .pickupProgressReward.show .pickupProgressRewardKicker{opacity:1;transform:translateY(0);transition-delay:.05s}
      .pickupProgressReward.show .pickupProgressRewardXp{opacity:1;transform:translateY(0);transition-delay:.11s}
      .pickupProgressReward.show .pickupProgressRewardLevel,.pickupProgressReward.show .pickupProgressRewardRank{opacity:1;transform:translateY(0);transition-delay:.18s}
      .pickupProgressReward.show .pickupProgressRewardFoot{opacity:1;transform:translateY(0);transition-delay:.25s}
      .pickupProgressRewardKicker{font-size:12px;font-weight:900;letter-spacing:1px;text-transform:uppercase;color:#dbeafe}
      .pickupProgressRewardXp{font-size:16px;font-weight:900;line-height:1;color:#67e8f9}
      .pickupProgressRewardIcon{position:relative;display:grid;place-items:center;opacity:0;transform:scale(.74)}
      .pickupProgressReward.show .pickupProgressRewardIcon{opacity:1;animation:pickupProgressRewardIconPop .62s cubic-bezier(.2,.8,.2,1) .1s both}
      .pickupProgressRewardIcon::before{content:'';position:absolute;inset:-13px;border-radius:999px;background:radial-gradient(circle,rgba(110,231,255,.5) 0%,rgba(56,189,248,.24) 46%,rgba(56,189,248,0) 72%);filter:blur(1px);opacity:0;transform:scale(.58)}
      .pickupProgressReward.show .pickupProgressRewardIcon::before{animation:pickupProgressRewardGlow .76s ease-out .14s both}
      .pickupProgressReward .rankBadgeIconWrap{width:70px;height:70px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.44),0 0 0 1px rgba(15,23,42,.2),0 14px 30px rgba(2,6,23,.52),0 0 26px rgba(56,189,248,.35)}
      .pickupProgressReward .rankBadgeIconWrap svg{width:40px;height:40px}
      .pickupProgressRewardLevel{font-size:22px;font-weight:900;line-height:1.08;color:#fff}
      .pickupProgressRewardRank{margin-top:-1px;font-size:16px;font-weight:800;line-height:1.18;color:#bfdbfe;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .pickupProgressRewardBar{width:min(248px,100%);height:9px;border-radius:999px;background:rgba(148,163,184,.3);box-shadow:0 0 0 1px rgba(148,163,184,.25),0 0 16px rgba(59,130,246,.3);overflow:hidden}
      .pickupProgressRewardFill{height:100%;width:0;background:linear-gradient(90deg,#22d3ee 0%,#3b82f6 56%,#22c55e 100%);border-radius:999px;transition:width .62s cubic-bezier(.2,.84,.2,1);transition-delay:.2s}
      .pickupProgressRewardFoot{font-size:12px;line-height:1.22;font-weight:800;color:#dbeafe;text-align:center}
      @keyframes pickupProgressRewardIconPop{0%{transform:scale(.68)}40%{transform:scale(1.18)}100%{transform:scale(1)}}
      @keyframes pickupProgressRewardGlow{0%{opacity:0;transform:scale(.5)}34%{opacity:1;transform:scale(1.04)}100%{opacity:0;transform:scale(1.3)}}
      @keyframes levelUpOverlayBurst{0%{opacity:0;transform:scale(.82)}38%{opacity:1;transform:scale(1.02)}100%{opacity:0;transform:scale(1.24)}}
      .driverProfileClose{border:0;background:#e5e7eb;color:#111827;border-radius:10px;padding:7px 9px;font-size:13px}
      .driverProfileScroll{overflow:auto;-webkit-overflow-scrolling:touch;padding:0 10px 6px;min-height:0}
      .driverProfileSectionTitle{font-size:12px;font-weight:700;color:#111827;margin:1px 0 3px}
      .driverProfileStats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:3px;margin-bottom:6px}
      .driverProfileStatCard{background:#f8fafc;border:1px solid #e2e8f0;border-radius:11px;padding:4px 5px}
      .driverProfileStatPeriod{font-size:11px;font-weight:700;color:#0f172a;margin-bottom:2px}
      .driverProfileStatRow{display:flex;align-items:center;justify-content:space-between;gap:4px;margin-top:0}
      .driverProfileStatLabel{font-size:11px;color:#475569}
      .driverProfileStatValue{font-size:13px;font-weight:700;color:#0f172a}
      .driverProfileDailyRanks{margin-top:3px;padding-top:2px;border-top:1px dashed #dbe4ee}
      .driverProfileDailyRanks .driverProfileStatLabel{font-size:10px}
      .driverProfileDailyRanks .driverProfileStatValue{font-size:11px}
      .driverProfileDmWrap{display:flex;flex-direction:column;border:1px solid #e2e8f0;border-radius:11px;background:#fff;min-height:130px}
      .driverProfileDmList{display:flex;flex-direction:column;gap:7px;overflow:auto;max-height:min(22vh,190px);padding:9px}
      .driverProfileDmList .chatPrivateMsgRow{margin:0}
      .driverProfileDmList .chatBubbleSelf,.driverProfileDmList .chatBubbleOther{max-width:86%}
      .driverProfileComposer{display:flex;gap:7px;padding:8px;border-top:1px solid #e2e8f0;padding-bottom:8px}
      .driverProfileInput{flex:1;min-width:0;border:1px solid #cbd5e1;border-radius:10px;padding:9px;font-size:16px;color:#0f172a}
      .driverProfileSendBtn{border:0;border-radius:10px;background:#1d4ed8;color:#fff;font-weight:600;padding:9px 11px}
      .driverProfileSendBtn:disabled{opacity:.6}
      .driverProfileVoiceComposer{padding:0 8px calc(8px + env(safe-area-inset-bottom));border-top:0}
      .driverProfileDmList .chatVoiceBubble{max-width:100%}
      .driverProfileStatus{font-size:12px;color:#64748b;padding:0 10px 7px}
      .driverProfileError{font-size:12px;color:#b91c1c;background:#fee2e2;border:1px solid #fecaca;border-radius:10px;padding:8px;margin:2px 10px 7px}
      .driverProfileLoading{padding:14px 10px;color:#334155;font-size:13px}
      .driverProfileActions{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:5px}
      .driverProfileActionBtn{border:1px solid #cbd5e1;background:#f8fafc;color:#0f172a;border-radius:10px;padding:8px 10px;font-size:13px;font-weight:600}
      .driverProfileActionBtn.danger{border-color:#fecaca;background:#fff1f2;color:#b91c1c}
      .driverProfileMapIdentity{border:1px solid #e2e8f0;border-radius:11px;padding:5px;background:#fff}
      .driverProfileMapIdentity #profileMapIdentitySection{margin:0}
    `;
    document.head.appendChild(style);
  }

  function updateDriverProfileLayout() {
    const root = document.getElementById('driverProfileModalRoot') || document.querySelector('[data-driver-profile-modal-root]');
    if (!root) return;
    const dock = document.getElementById('dock');
    const sliderWrap = document.getElementById('sliderWrap');
    const mapControlStack = document.querySelector('.mapControlStack');
    void mapControlStack;

    let bottomOffset = 16;
    if (dock) {
      bottomOffset = Math.max(bottomOffset, window.innerHeight - dock.getBoundingClientRect().top + 10);
    }
    if (sliderWrap) {
      bottomOffset = Math.max(bottomOffset, window.innerHeight - sliderWrap.getBoundingClientRect().top + 8);
    }
    root.style.setProperty('--driver-profile-bottom-offset', `${Math.max(16, Math.round(bottomOffset))}px`);
  }

  function scheduleDriverProfileLayoutUpdate() {
    updateDriverProfileLayout();
    if (driverProfileLayoutTimer50) window.clearTimeout(driverProfileLayoutTimer50);
    if (driverProfileLayoutTimer180) window.clearTimeout(driverProfileLayoutTimer180);
    driverProfileLayoutTimer50 = window.setTimeout(updateDriverProfileLayout, 50);
    driverProfileLayoutTimer180 = window.setTimeout(updateDriverProfileLayout, 180);
  }

  function bindDriverProfileLayoutEvents() {
    if (driverProfileLayoutBound) return;
    driverProfileLayoutBound = true;
    window.addEventListener('resize', updateDriverProfileLayout);
    window.addEventListener('orientationchange', updateDriverProfileLayout);
    if (window.visualViewport && typeof window.visualViewport.addEventListener === 'function') {
      window.visualViewport.addEventListener('resize', updateDriverProfileLayout);
    }
  }

  function ensureDriverProfileUI() {
    injectDriverProfileStyles();
    bindDriverProfileLayoutEvents();
    let root = document.getElementById('driverProfileModalRoot');
    if (root) {
      updateDriverProfileLayout();
      return root;
    }

    root = document.createElement('div');
    root.id = 'driverProfileModalRoot';
    root.innerHTML = `
      <div class="driverProfileBackdrop"></div>
      <section class="driverProfileSheet" role="dialog" aria-modal="true" aria-label="Driver profile">
        <div class="driverProfileBody" id="driverProfileBody"></div>
      </section>
    `;
    const backdrop = root.querySelector('.driverProfileBackdrop');
    const sheet = root.querySelector('.driverProfileSheet');
    backdrop?.addEventListener('click', () => closeDriverProfileModal());
    sheet?.addEventListener('click', (ev) => ev.stopPropagation());
    document.body.appendChild(root);
    updateDriverProfileLayout();
    return root;
  }

  function driverProfileBadgeChip(code) {
    const meta = leaderboardBadgeMeta(code);
    if (!meta.code) return '<span class="driverProfileBadgeLabel">No badge yet</span>';
    return `<span class="driverProfileBadgeChipWrap"><span class="badgeSvgWrap">${renderLeaderboardBadgeSvg(meta.code, { size: 30 })}</span><span class="driverProfileBadgeLabel">${escapeHtml(meta.profileLabel)}</span></span>`;
  }

  function driverProfileAvatarHTML(profileUser) {
    const name = String(profileUser?.display_name || 'Driver').trim() || 'Driver';
    const avatarUrl = String(profileUser?.avatar_url || '').trim();
    if (avatarUrl) {
      return `<img class="driverProfileAvatar" src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(name)} avatar">`;
    }
    return `<div class="driverProfileAvatar" style="display:flex;align-items:center;justify-content:center;font-weight:700;color:#334155;">${escapeHtml(name.slice(0, 1).toUpperCase())}</div>`;
  }

  function formatDriverProfileStat(value, kind = 'value') {
    if (kind === 'rank') {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? `#${n}` : '—';
    }
    const n = Number(value);
    if (!Number.isFinite(n)) return '0';
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  function normalizeDriverTier(title) {
    return String(title || '').trim() || 'Recruit';
  }

  function formatProgressNumber(value, { maxFractionDigits = 1 } = {}) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0';
    return n.toLocaleString(undefined, { maximumFractionDigits: maxFractionDigits });
  }

  const LEGACY_RANK_ICON_BAND_MAP = {
    recruit: 1,
    private: 2,
    corporal: 3,
    sergeant: 4,
    staff_sergeant: 5,
    sergeant_first_class: 6,
    master_sergeant: 7,
    lieutenant: 8,
    captain: 9,
    major: 10,
    colonel: 11,
    brigadier: 12,
    major_general: 13,
    lieutenant_general: 14,
    general: 15,
    commander: 16,
    road_legend: 17,
  };

  function resolveRankIconBand(rankIconKey) {
    const key = String(rankIconKey || '').trim().toLowerCase();
    const match = key.match(/^band_(\d{1,3})$/);
    if (match) {
      const value = Number(match[1]);
      return Math.max(1, Math.min(100, value));
    }
    return Math.max(1, Math.min(100, Number(LEGACY_RANK_ICON_BAND_MAP[key] || 1)));
  }

  function resolveRankIconTone(rankIconKey) {
    const band = resolveRankIconBand(rankIconKey);
    if (band >= 91) return 'toneLegend';
    if (band >= 71) return 'toneGeneral';
    if (band >= 41) return 'toneOfficer';
    if (band >= 11) return 'toneEnlisted';
    return 'toneRecruit';
  }

  function buildRankBadgeShell(shellIndex) {
    const shells = [
      '<path d="M24 4L42 12v12c0 12-8.4 18.8-18 22C14.4 42.8 6 36 6 24V12z" />',
      '<path d="M24 4l16 10v12L24 44 8 26V14z" />',
      '<path d="M24 3l17 8 4 17-11 14H14L3 28l4-17z" />',
      '<circle cx="24" cy="24" r="18" />',
      '<path d="M24 4l18 16-18 24L6 20z" />',
      '<path d="M12 8h24l10 12-10 20H12L2 20z" />',
      '<path d="M24 5c11 0 18 7 18 16 0 12-9 20-18 23C15 41 6 33 6 21 6 12 13 5 24 5z" />',
      '<path d="M24 3l19 14-7 25H12L5 17z" />',
      '<path d="M10 10h28l6 14-6 14H10L4 24z" />',
      '<rect x="7" y="7" width="34" height="34" rx="11" ry="11" />',
    ];
    return shells[((shellIndex % shells.length) + shells.length) % shells.length];
  }

  function buildRankBadgeGlyph(glyphIndex) {
    const glyphs = [
      '<path d="M24 13l3.8 7.8 8.6 1.2-6.2 6 1.5 8.8L24 32.5l-7.7 4.3 1.5-8.8-6.2-6 8.6-1.2z" />',
      '<path d="M17 14h14v5H17zM14 23h20v5H14zM11 32h26v4H11z" />',
      '<path d="M24 10l10 14-10 14-10-14z" />',
      '<circle cx="24" cy="24" r="6" /><path d="M24 11v6M24 31v6M11 24h6M31 24h6" stroke="currentColor" stroke-width="3" stroke-linecap="round" fill="none"/>',
      '<path d="M16 33V17l8-5 8 5v16l-8 5z" />',
      '<path d="M14 33l10-18 10 18h-6l-4-7-4 7z" />',
      '<path d="M14 18h20v4H14zM17 24h14v4H17zM20 30h8v4h-8z" />',
      '<path d="M24 11l11 7v12l-11 7-11-7V18z" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="24" cy="24" r="4" />',
      '<path d="M18 12h12l4 9-10 15L14 21z" />',
      '<path d="M24 12c5.5 0 10 4.5 10 10s-4.5 14-10 14-10-8.5-10-14 4.5-10 10-10z" /><path d="M18 24h12" stroke="currentColor" stroke-width="3" stroke-linecap="round" fill="none"/>',
    ];
    return glyphs[((glyphIndex % glyphs.length) + glyphs.length) % glyphs.length];
  }

  function renderRankBadgeIcon(rankIconKey, { compact = false } = {}) {
    const band = resolveRankIconBand(rankIconKey);
    const toneClass = resolveRankIconTone(rankIconKey);
    const shellIndex = Math.floor((band - 1) / 10);
    const glyphIndex = (band - 1) % 10;
    const size = compact ? 54 : 68;
    const hue = ((band - 1) * 17) % 360;
    const accentHue = (hue + 42) % 360;
    const shell = buildRankBadgeShell(shellIndex);
    const glyph = buildRankBadgeGlyph(glyphIndex);
    const gradientId = `rbg-${band}-${compact ? 'c' : 'f'}`;
    return `<div class="rankBadgeIconWrap ${toneClass}${compact ? ' compact' : ''}" aria-hidden="true" data-rank-band="${band}">
      <svg viewBox="0 0 48 48" width="${size}" height="${size}" role="presentation" focusable="false">
        <defs>
          <linearGradient id="${gradientId}" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="hsl(${hue} 88% 68%)"/>
            <stop offset="55%" stop-color="hsl(${accentHue} 85% 58%)"/>
            <stop offset="100%" stop-color="hsl(${(accentHue + 35) % 360} 72% 32%)"/>
          </linearGradient>
        </defs>
        <circle cx="24" cy="24" r="22" fill="rgba(255,255,255,.22)"/>
        <g fill="url(#${gradientId})" stroke="rgba(15,23,42,.26)" stroke-width="1.3">${shell}</g>
        <g fill="rgba(255,255,255,.92)" stroke="rgba(15,23,42,.18)" stroke-width="0.8">${glyph}</g>
        <circle cx="24" cy="24" r="20.6" fill="none" stroke="rgba(255,255,255,.28)" stroke-width="1"/>
      </svg>
    </div>`;
  }

  function renderDriverProgressionSection(progression) {
    const level = Number(progression?.level);
    const safeLevel = Number.isFinite(level) && level > 0 ? Math.floor(level) : 1;
    const title = normalizeDriverTier(progression?.rank_name || progression?.title);
    const totalXp = Number(progression?.total_xp);
    const currentLevelXp = Number(progression?.current_level_xp);
    const nextLevelXp = Number(progression?.next_level_xp);
    const xpToNextLevel = Number(progression?.xp_to_next_level);
    const maxLevelReached = progression?.max_level_reached === true;
    const lifetimeMiles = Number(progression?.lifetime_miles);
    const lifetimeHours = Number(progression?.lifetime_hours);
    const lifetimePickups = Number(progression?.lifetime_pickups_recorded);
    const milesXp = Number(progression?.xp_breakdown?.miles_xp);
    const hoursXp = Number(progression?.xp_breakdown?.hours_xp);
    const reportXp = Number(progression?.xp_breakdown?.report_xp);
    const gameXp = Number(progression?.xp_breakdown?.game_xp);

    let progressPct = 1;
    if (!maxLevelReached) {
      const denom = nextLevelXp - currentLevelXp;
      if (Number.isFinite(denom) && denom > 0 && Number.isFinite(totalXp)) {
        progressPct = (totalXp - currentLevelXp) / denom;
      } else {
        progressPct = 0;
      }
    }
    const clampedPct = Math.max(0, Math.min(1, progressPct));

    const nextLevelLabel = maxLevelReached
      ? 'MAX LEVEL'
      : `Next Level: ${safeLevel + 1} at ${formatProgressNumber(nextLevelXp, { maxFractionDigits: 0 })} XP`;
    const xpToNextLabel = maxLevelReached
      ? ''
      : `<div class="driverProfileProgressMeta">XP to Next Level: ${escapeHtml(formatProgressNumber(xpToNextLevel, { maxFractionDigits: 0 }))}</div>`;

    return `<div class="driverProfileProgressWrap">
      <div class="driverProfileProgressHead">
        <div class="driverProfileProgressLine">Level ${safeLevel} • <span class="driverProfileRankName">${escapeHtml(title)}</span></div>
        ${renderRankBadgeIcon(progression?.rank_icon_key, { compact: true })}
      </div>
      <div class="driverProfileProgressMeta">Total XP: ${escapeHtml(formatProgressNumber(totalXp, { maxFractionDigits: 0 }))}</div>
      <div class="driverProfileProgressBar" aria-hidden="true"><div class="driverProfileProgressFill" style="width:${(clampedPct * 100).toFixed(1)}%"></div></div>
      <div class="driverProfileProgressMeta">${escapeHtml(nextLevelLabel)}</div>
      ${xpToNextLabel}
      <div class="driverProfileBreakdownGrid">
        <div class="driverProfileProgressMeta">Miles: ${escapeHtml(formatProgressNumber(lifetimeMiles))}</div>
        <div class="driverProfileProgressMeta">Hours: ${escapeHtml(formatProgressNumber(lifetimeHours))}</div>
        <div class="driverProfileProgressMeta">Reported Trips: ${escapeHtml(formatProgressNumber(lifetimePickups, { maxFractionDigits: 0 }))}</div>
        <div class="driverProfileProgressMeta">Miles XP: ${escapeHtml(formatProgressNumber(milesXp, { maxFractionDigits: 0 }))}</div>
        <div class="driverProfileProgressMeta">Hours XP: ${escapeHtml(formatProgressNumber(hoursXp, { maxFractionDigits: 0 }))}</div>
        <div class="driverProfileProgressMeta">Report XP: ${escapeHtml(formatProgressNumber(reportXp, { maxFractionDigits: 0 }))}</div>
        <div class="driverProfileProgressMeta">Game XP: ${escapeHtml(formatProgressNumber(gameXp, { maxFractionDigits: 0 }))}</div>
      </div>
    </div>`;
  }

  function renderDriverProfilePeriodCard(label, data, extraHtml = '') {
    const pickups = Number(data?.pickups ?? data?.pickup_count ?? data?.reported_trips);
    const pickupLine = Number.isFinite(pickups)
      ? `<div class="driverProfileStatRow"><div class="driverProfileStatLabel">Pickups</div><div class="driverProfileStatValue">${escapeHtml(formatDriverProfileStat(pickups, 'value'))}</div></div>`
      : '';
    return `<div class="driverProfileStatCard">
      <div class="driverProfileStatPeriod">${escapeHtml(label)}</div>
      <div class="driverProfileStatRow"><div class="driverProfileStatLabel">Miles</div><div class="driverProfileStatValue">${escapeHtml(formatDriverProfileStat(data?.miles, 'value'))}</div></div>
      <div class="driverProfileStatRow"><div class="driverProfileStatLabel">Hours</div><div class="driverProfileStatValue">${escapeHtml(formatDriverProfileStat(data?.hours, 'value'))}</div></div>
      ${pickupLine}
      ${extraHtml}
    </div>`;
  }

  function renderBattleStatsSection(stats) {
    const safe = { ...defaultBattleStats(), ...(stats && typeof stats === 'object' ? stats : {}) };
    const totalMatches = Number(safe.total_matches ?? safe.matches_played ?? 0) || 0;
    const wins = Number(safe.wins ?? safe.total_wins ?? 0) || 0;
    const losses = Number(safe.losses ?? safe.total_losses ?? 0) || 0;
    const winRate = safe.win_rate ?? (totalMatches > 0 ? (wins / totalMatches) : 0);
    const cards = [
      ['Wins', wins],
      ['Losses', losses],
      ['Matches', totalMatches],
      ['Win rate', formatBattlePct(winRate)],
      ['Dominoes W', safe.dominoes_wins],
      ['Dominoes L', safe.dominoes_losses],
      ['Billiards W', safe.billiards_wins],
      ['Billiards L', safe.billiards_losses],
      ['Game XP', formatProgressNumber(safe.game_xp_earned, { maxFractionDigits: 0 })],
    ];
    return `<div class="driverProfileBattleGrid">${cards.map(([label, value]) => `<div class="driverProfileBattleCard"><div class="driverProfileBattleLabel">${escapeHtml(String(label))}</div><div class="driverProfileBattleValue">${escapeHtml(String(value))}</div></div>`).join('')}</div>`;
  }

  function renderRecentBattlesList(items) {
    const rows = Array.isArray(items) ? items.slice(0, 5) : [];
    if (!rows.length) return '<div class="driverProfileStatus">No recent battles yet.</div>';
    return `<div class="driverProfileRecentBattles">${rows.map((row) => {
      const result = battleResultLabel(row);
      const game = String(row?.game_key || row?.game_type || 'battle').replace(/^./, (m) => m.toUpperCase());
      const opponent = String(row?.opponent_display_name || row?.opponent_name || 'Driver');
      const xp = Number(row?.xp_awarded ?? row?.xp_delta ?? row?.xp ?? 0);
      return `<article class="driverProfileRecentBattle ${result.toLowerCase()}"><div class="driverProfileRecentBattleTop"><strong>${escapeHtml(game)}</strong><span>${escapeHtml(result)}</span></div><div class="driverProfileRecentBattleMeta">vs ${escapeHtml(opponent)} • ${escapeHtml(formatBattleDate(row?.completed_at))}</div><div class="driverProfileRecentBattleMeta">${xp > 0 ? `+${escapeHtml(formatProgressNumber(xp, { maxFractionDigits: 0 }))} XP` : 'Completed'}</div></article>`;
    }).join('')}</div>`;
  }

  async function fetchDriverProfile(userId) {
    const token = getCommunityToken();
    return await getJSONAuth(`/drivers/${encodeURIComponent(userId)}/profile`, token);
  }

  async function fetchDriverProfileDmThread(userId, { after = null, limit = 30, markRead = true } = {}) {
    return await chatFetchPrivateMessages(userId, { sinceId: after, limit, markRead });
  }

  const PROGRESSION_SYNC_INTERVAL_MS = 90000;
  let progressionSyncTimer = null;
  let progressionSyncInFlight = false;
  let levelUpOverlayHideTimer = null;
  let lastLevelUpPopupKey = '';
  let lastLevelUpPopupAt = 0;
  let leaderboardBadgeRewardHideTimer = null;
  let lastBadgeRewardPopupKey = '';
  let lastBadgeRewardPopupAt = 0;

  function progressionLastSeenStorageKey(userId) {
    return `progression_last_seen_level_v1_${String(userId || '').trim()}`;
  }

  function readStoredProgressionLevel(userId) {
    const key = progressionLastSeenStorageKey(userId);
    if (!key.endsWith('_')) {
      try {
        const raw = localStorage.getItem(key);
        const parsed = Number(raw);
        return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  function writeStoredProgressionLevel(userId, level) {
    const key = progressionLastSeenStorageKey(userId);
    const safeLevel = Number(level);
    if (!key.endsWith('_') && Number.isFinite(safeLevel) && safeLevel > 0) {
      try { localStorage.setItem(key, String(Math.floor(safeLevel))); } catch (_) {}
    }
  }

  function updatePickupRewardLayout() {
    const root = document.documentElement;
    const viewportHeight = Number(window.visualViewport?.height) || window.innerHeight || 0;
    const floorBottom = 240;
    const clearance = 28;
    const tops = [];
    const pushTop = (sel) => {
      const node = document.querySelector(sel);
      if (!node || typeof node.getBoundingClientRect !== 'function') return;
      const rect = node.getBoundingClientRect();
      if (Number.isFinite(rect?.top)) tops.push(rect.top);
    };
    pushTop('#dock');
    pushTop('#sliderWrap');
    pushTop('#pickupFab');
    document.querySelectorAll('.dockDrawer.open,.dockDrawer[open],#dockDrawer.open,#dockDrawer[open]').forEach((node) => {
      if (!node || typeof node.getBoundingClientRect !== 'function') return;
      const rect = node.getBoundingClientRect();
      if (Number.isFinite(rect?.top)) tops.push(rect.top);
    });
    const clusterTop = tops.length ? Math.min(...tops) : null;
    let bottom = floorBottom;
    if (Number.isFinite(viewportHeight) && viewportHeight > 0 && Number.isFinite(clusterTop)) {
      bottom = Math.max(floorBottom, Math.round((viewportHeight - clusterTop) + clearance));
    }
    root.style.setProperty('--pickup-reward-bottom', `${bottom}px`);
    return bottom;
  }

  function ensurePickupProgressReward() {
    let el = document.getElementById('pickupProgressReward');
    if (el) {
      updatePickupRewardLayout();
      return el;
    }
    el = document.createElement('div');
    el.id = 'pickupProgressReward';
    el.className = 'pickupProgressReward';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `<div class="pickupProgressRewardCard">
      <div class="pickupProgressRewardKicker" id="pickupProgressRewardKicker">Trip Saved</div>
      <div class="pickupProgressRewardIcon" id="pickupProgressRewardIcon"></div>
      <div class="pickupProgressRewardXp" id="pickupProgressRewardXp"></div>
      <div class="pickupProgressRewardLevel" id="pickupProgressRewardLevel"></div>
      <div class="pickupProgressRewardRank" id="pickupProgressRewardRank"></div>
      <div class="pickupProgressRewardBar"><div class="pickupProgressRewardFill" id="pickupProgressRewardFill"></div></div>
      <div class="pickupProgressRewardFoot" id="pickupProgressRewardFoot"></div>
    </div>`;
    document.body.appendChild(el);
    updatePickupRewardLayout();
    return el;
  }

  function computeProgressRatio(progression = {}) {
    const level = Number(progression?.level);
    const totalXp = Number(progression?.total_xp);
    const currentLevelXp = Number(progression?.current_level_xp);
    const nextLevelXp = Number(progression?.next_level_xp);
    const isMaxLevel = progression?.is_max_level === true
      || progression?.max_level_reached === true
      || progression?.xp_to_next_level === 0
      || (Number.isFinite(level) && Number.isFinite(nextLevelXp) && Number.isFinite(currentLevelXp) && nextLevelXp <= currentLevelXp);
    if (isMaxLevel) return 1;
    if (!Number.isFinite(totalXp) || !Number.isFinite(currentLevelXp) || !Number.isFinite(nextLevelXp) || nextLevelXp <= currentLevelXp) return 0;
    const pct = (totalXp - currentLevelXp) / (nextLevelXp - currentLevelXp);
    return Math.min(1, Math.max(0, pct));
  }

  function renderPickupProgressReward(payload = {}) {
    const progression = payload?.progression && typeof payload.progression === 'object' ? payload.progression : payload;
    if (!progression || typeof progression !== 'object') return false;
    ensurePickupProgressReward();
    ensureLeaderboardBadgeRewardOverlay();
    const level = Number(progression?.level);
    const safeLevel = Number.isFinite(level) && level > 0 ? Math.floor(level) : 1;
    const xpAwarded = Number(payload?.xp_awarded ?? progression?.xp_awarded);
    const earnedLabel = `+${formatProgressNumber(Number.isFinite(xpAwarded) && xpAwarded > 0 ? xpAwarded : 0, { maxFractionDigits: 0 })} XP`;
    const rankName = normalizeDriverTier(progression?.rank_name || progression?.title || 'Rookie');
    const xpToNext = Number(progression?.xp_to_next_level);
    const isMaxLevel = progression?.is_max_level === true
      || progression?.max_level_reached === true
      || (Number.isFinite(xpToNext) && xpToNext <= 0);
    const footer = isMaxLevel
      ? 'MAX LEVEL'
      : `${formatProgressNumber(Number.isFinite(xpToNext) && xpToNext > 0 ? xpToNext : 0, { maxFractionDigits: 0 })} XP to Level ${safeLevel + 1}`;
    const pct = computeProgressRatio(progression);
    const kickerEl = document.getElementById('pickupProgressRewardKicker');
    const iconEl = document.getElementById('pickupProgressRewardIcon');
    const xpEl = document.getElementById('pickupProgressRewardXp');
    const levelEl = document.getElementById('pickupProgressRewardLevel');
    const rankEl = document.getElementById('pickupProgressRewardRank');
    const fillEl = document.getElementById('pickupProgressRewardFill');
    const footEl = document.getElementById('pickupProgressRewardFoot');
    if (!kickerEl || !iconEl || !xpEl || !levelEl || !rankEl || !fillEl || !footEl) return false;
    kickerEl.textContent = 'Trip Saved';
    iconEl.innerHTML = renderRankBadgeIcon(progression?.rank_icon_key, { compact: false });
    xpEl.textContent = earnedLabel;
    levelEl.textContent = `Level ${safeLevel}`;
    rankEl.textContent = String(rankName || 'Rookie');
    fillEl.style.width = '0%';
    footEl.textContent = footer;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        fillEl.style.width = `${Math.round(pct * 100)}%`;
      });
    });
    return true;
  }

  function showPickupProgressReward(payload = {}) {
    const rendered = renderPickupProgressReward(payload);
    if (!rendered) return;
    updatePickupRewardLayout();
    const el = ensurePickupProgressReward();
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    el.setAttribute('aria-hidden', 'false');
    if (showPickupProgressReward._timer) window.clearTimeout(showPickupProgressReward._timer);
    showPickupProgressReward._timer = window.setTimeout(() => {
      el.classList.remove('show');
      el.setAttribute('aria-hidden', 'true');
      showPickupProgressReward._timer = null;
    }, 3600);
  }

  function ensureLevelUpOverlay() {
    let root = document.getElementById('levelUpOverlayRoot');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'levelUpOverlayRoot';
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = '<div class="levelUpOverlayCard" id="levelUpOverlayCard"></div>';
    document.body.appendChild(root);
    return root;
  }

  function shouldSkipLevelUpPopup(payload = {}) {
    const safeLevel = Number(payload?.new_level ?? payload?.level);
    const userId = Number(window?.me?.id);
    if (!Number.isFinite(safeLevel) || safeLevel <= 0) return false;
    const key = `${Number.isFinite(userId) ? userId : 'anon'}:${Math.floor(safeLevel)}`;
    const now = Date.now();
    if (key === lastLevelUpPopupKey && (now - lastLevelUpPopupAt) < 3000) return true;
    lastLevelUpPopupKey = key;
    lastLevelUpPopupAt = now;
    return false;
  }

  function showLevelUpOverlay(payload = {}) {
    if (shouldSkipLevelUpPopup(payload)) return;
    const root = ensureLevelUpOverlay();
    const card = document.getElementById('levelUpOverlayCard');
    if (!card) return;
    const level = Number(payload?.new_level ?? payload?.level);
    const previousLevel = Number(payload?.previous_level);
    const safeLevel = Number.isFinite(level) && level > 0 ? Math.floor(level) : 1;
    const safePrevLevel = Number.isFinite(previousLevel) && previousLevel > 0 ? Math.floor(previousLevel) : null;
    const transitionLabel = (safePrevLevel && safePrevLevel !== safeLevel)
      ? `Level ${safePrevLevel} → ${safeLevel}`
      : `Level ${safeLevel}`;
    const rankName = normalizeDriverTier(payload?.rank_name || payload?.title || 'New Rank Reached');
    const xpAwarded = Number(payload?.xp_awarded);
    const xpLine = Number.isFinite(xpAwarded) && xpAwarded > 0
      ? `<div class="levelUpXp">+${escapeHtml(formatProgressNumber(xpAwarded, { maxFractionDigits: 0 }))} XP</div>`
      : '';
    card.innerHTML = `${renderRankBadgeIcon(payload?.rank_icon_key, { compact: false })}
      <div class="levelUpOverlayText">
        <div class="levelUpTag">Level Up</div>
        <div class="levelUpTitle">Promotion Unlocked</div>
        <div class="levelUpSub">${escapeHtml(rankName)} • ${escapeHtml(transitionLabel)}</div>
        ${xpLine}
      </div>`;
    root.classList.add('open');
    root.setAttribute('aria-hidden', 'false');
    if (levelUpOverlayHideTimer) window.clearTimeout(levelUpOverlayHideTimer);
    levelUpOverlayHideTimer = window.setTimeout(() => {
      root.classList.remove('open');
      root.setAttribute('aria-hidden', 'true');
      levelUpOverlayHideTimer = null;
    }, 3900);
  }

  function ensureLeaderboardBadgeRewardOverlay() {
    let root = document.getElementById('leaderboardBadgeRewardRoot');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'leaderboardBadgeRewardRoot';
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = `<div class="leaderboardBadgeRewardCard" id="leaderboardBadgeRewardCard">
      <div class="leaderboardBadgeRewardIcon" id="leaderboardBadgeRewardIcon"></div>
      <div class="leaderboardBadgeRewardTag">Podium Badge Earned</div>
      <div class="leaderboardBadgeRewardTitle" id="leaderboardBadgeRewardTitle"></div>
      <div class="leaderboardBadgeRewardSub" id="leaderboardBadgeRewardSub"></div>
    </div>`;
    document.body.appendChild(root);
    return root;
  }

  function getBestCurrentLeaderboardBadgeRow(rows) {
    const list = Array.isArray(rows) ? rows : [];
    let best = null;
    for (const row of list) {
      const code = normalizeLeaderboardBadge(row?.badge_code);
      const rank = Number(row?.rank_position);
      if (!code) continue;
      if (!Number.isFinite(rank) || rank < 1 || rank > 3) continue;
      if (!best || rank < Number(best.rank_position || 99)) best = row;
    }
    return best || null;
  }

  function leaderboardBadgeRewardStorageKey(userId) {
    return `leaderboard_badge_reward_seen_v2_${userId}`;
  }

  function readStoredLeaderboardBadgeRewardState(userId) {
    if (!Number.isFinite(Number(userId))) return null;
    try {
      const raw = localStorage.getItem(leaderboardBadgeRewardStorageKey(Math.floor(Number(userId))));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return {
        badge_code: normalizeLeaderboardBadge(parsed.badge_code),
        rank_position: Number(parsed.rank_position),
        metric: String(parsed.metric || ''),
        period: String(parsed.period || ''),
        period_key: String(parsed.period_key || '')
      };
    } catch (_) {
      return null;
    }
  }

  function writeStoredLeaderboardBadgeRewardState(userId, state) {
    if (!Number.isFinite(Number(userId)) || !state) return;
    const payload = {
      badge_code: normalizeLeaderboardBadge(state.badge_code),
      rank_position: Number(state.rank_position),
      metric: String(state.metric || ''),
      period: String(state.period || ''),
      period_key: String(state.period_key || '')
    };
    try {
      localStorage.setItem(leaderboardBadgeRewardStorageKey(Math.floor(Number(userId))), JSON.stringify(payload));
    } catch (_) {}
  }

  function showLeaderboardBadgeRewardOverlay(badgeRowOrMeta, options = {}) {
    const meta = leaderboardBadgeMeta(badgeRowOrMeta?.badge_code || badgeRowOrMeta?.code);
    if (!meta.code) return false;
    const periodKey = String(badgeRowOrMeta?.period_key || options?.period_key || '');
    const popupKey = [meta.code, String(badgeRowOrMeta?.rank_position || ''), String(badgeRowOrMeta?.metric || ''), String(badgeRowOrMeta?.period || ''), periodKey].join(':');
    const now = Date.now();
    if (popupKey && popupKey === lastBadgeRewardPopupKey && (now - lastBadgeRewardPopupAt) < 3200) return false;
    lastBadgeRewardPopupKey = popupKey;
    lastBadgeRewardPopupAt = now;
    const root = ensureLeaderboardBadgeRewardOverlay();
    const icon = document.getElementById('leaderboardBadgeRewardIcon');
    const title = document.getElementById('leaderboardBadgeRewardTitle');
    const sub = document.getElementById('leaderboardBadgeRewardSub');
    if (!icon || !title || !sub) return false;
    icon.innerHTML = renderLeaderboardBadgeSvg(meta.code, { size: 88, compact: false });
    title.textContent = meta.rewardTitle || 'Podium Badge';
    sub.textContent = meta.code === 'crown' ? 'Daily Miles Leader' : 'Top 3 Daily Miles';
    root.classList.add('open');
    root.setAttribute('aria-hidden', 'false');
    if (leaderboardBadgeRewardHideTimer) window.clearTimeout(leaderboardBadgeRewardHideTimer);
    leaderboardBadgeRewardHideTimer = window.setTimeout(() => {
      root.classList.remove('open');
      root.setAttribute('aria-hidden', 'true');
      leaderboardBadgeRewardHideTimer = null;
    }, 3800);
    return true;
  }

  function shouldShowLeaderboardBadgeReward(prevState, nextState) {
    const prevCode = normalizeLeaderboardBadge(prevState?.badge_code);
    const nextCode = normalizeLeaderboardBadge(nextState?.badge_code);
    if (!nextCode) return false;
    if (!prevCode) return true;
    const prevPriority = leaderboardBadgePriority(prevCode);
    const nextPriority = leaderboardBadgePriority(nextCode);
    if (nextPriority > prevPriority) return true;
    if (nextPriority < prevPriority) return false;
    const prevPeriod = String(prevState?.period_key || '');
    const nextPeriod = String(nextState?.period_key || '');
    if (!prevPeriod || !nextPeriod || prevPeriod === nextPeriod) return false;
    return false;
  }

  async function syncLeaderboardBadgeRewards(options = {}) {
    const token = getCommunityToken();
    const userId = Number(window?.me?.id);
    if (!token || !Number.isFinite(userId)) return null;
    try {
      const payload = await getJSONAuth('/leaderboard/badges/me', token);
      const rows = Array.isArray(payload?.badges) ? payload.badges : [];
      const best = getBestCurrentLeaderboardBadgeRow(rows);
      const nextState = best ? {
        badge_code: normalizeLeaderboardBadge(best.badge_code),
        rank_position: Number(best.rank_position),
        metric: String(best.metric || ''),
        period: String(best.period || ''),
        period_key: String(best.period_key || '')
      } : null;
      const prevState = readStoredLeaderboardBadgeRewardState(userId);
      if (!prevState) {
        if (nextState) writeStoredLeaderboardBadgeRewardState(userId, nextState);
        return nextState;
      }
      if (nextState && !options?.suppressInitialPopup && shouldShowLeaderboardBadgeReward(prevState, nextState)) {
        showLeaderboardBadgeRewardOverlay(nextState, options);
      }
      if (nextState) writeStoredLeaderboardBadgeRewardState(userId, nextState);
      return nextState;
    } catch (err) {
      console.warn('syncLeaderboardBadgeRewards failed', err);
      return null;
    }
  }


  async function fetchMyProgression() {
    const token = getCommunityToken();
    if (!token) return null;
    return await getJSONAuth('/leaderboard/progression/me', token);
  }

  async function syncMyProgression({ forcePopupCheck = false } = {}) {
    if (progressionSyncInFlight) return null;
    if (typeof authHeaderOK === 'function' && !authHeaderOK()) return null;
    progressionSyncInFlight = true;
    try {
      const payload = await fetchMyProgression();
      const progression = payload?.progression || payload || null;
      const userId = Number(window?.me?.id);
      const level = Number(progression?.level);
      const safeLevel = Number.isFinite(level) && level > 0 ? Math.floor(level) : null;
      if (!Number.isFinite(userId) || !safeLevel) return progression;
      const prev = readStoredProgressionLevel(userId);
      if (prev === null) {
        writeStoredProgressionLevel(userId, safeLevel);
        return progression;
      }
      if ((forcePopupCheck || prev !== null) && safeLevel > prev) {
        showLevelUpOverlay({
          ...progression,
          previous_level: prev,
          new_level: safeLevel,
          leveled_up: true,
        });
      }
      writeStoredProgressionLevel(userId, safeLevel);
      await syncLeaderboardBadgeRewards({ suppressInitialPopup: false });
      return progression;
    } catch (err) {
      console.warn('syncMyProgression failed', err);
      return null;
    } finally {
      progressionSyncInFlight = false;
    }
  }

  function startProgressionSyncInterval() {
    if (progressionSyncTimer) return;
    const runner = () => {
      if (document.visibilityState === 'hidden') return;
      syncMyProgression({ forcePopupCheck: true });
    };
    if (runtimePolling) {
      progressionSyncTimer = runtimePolling.setInterval('chat:progression-sync', runner, PROGRESSION_SYNC_INTERVAL_MS);
      return;
    }
    progressionSyncTimer = window.setInterval(runner, PROGRESSION_SYNC_INTERVAL_MS);
  }

  function stopProgressionSyncInterval() {
    if (runtimePolling) runtimePolling.clear('chat:progression-sync');
    if (!progressionSyncTimer) return;
    window.clearInterval(progressionSyncTimer);
    progressionSyncTimer = null;
  }

  function handlePickupProgressionDelta(payload = {}) {
    const progressionPayload = payload?.progression && typeof payload.progression === 'object' ? payload.progression : payload;
    const leveledUp = payload?.leveled_up === true || progressionPayload?.leveled_up === true;
    showPickupProgressReward(payload);
    const meId = Number(window?.me?.id);
    const nextLevel = Number(progressionPayload?.level);
    if (Number.isFinite(meId) && Number.isFinite(nextLevel) && nextLevel > 0) {
      writeStoredProgressionLevel(meId, Math.floor(nextLevel));
    }
    if (leveledUp) {
      showLevelUpOverlay({
        ...progressionPayload,
        previous_level: Number(payload?.previous_level),
        new_level: Number(payload?.new_level ?? progressionPayload?.level),
        xp_awarded: payload?.xp_awarded ?? progressionPayload?.xp_awarded,
        leveled_up: true,
      });
    }
    syncLeaderboardBadgeRewards({ suppressInitialPopup: false });
  }

  async function maybeSyncProgressionOnSignInState() {
    if (typeof authHeaderOK !== 'function') return;
    if (authHeaderOK()) {
      startProgressionSyncInterval();
      await syncMyProgression({ forcePopupCheck: false });
      await syncLeaderboardBadgeRewards({ suppressInitialPopup: true });
    } else {
      stopProgressionSyncInterval();
    }
  }


  async function sendDriverProfileDm(userId, payload) {
    return await chatSendPrivateMessage(userId, payload);
  }

  function parseDriverMsgId(msg) {
    const id = Number(msg?.id);
    return Number.isFinite(id) ? id : null;
  }

  function seedDriverProfileDmAudioBaseline(messages) {
    if (!Array.isArray(messages) || !messages.length) {
      chatSoundRuntime.dmBaselineReady = true;
      return;
    }
    let maxId = chatSoundRuntime.dmLastObservedIncomingId;
    for (const msg of messages) {
      const id = parseDriverMsgId(msg);
      if (id === null) continue;
      maxId = maxId === null ? id : Math.max(maxId, id);
    }
    chatSoundRuntime.dmLastObservedIncomingId = maxId;
    chatSoundRuntime.dmBaselineReady = true;
  }

  function collectFreshIncomingDriverProfileDm(messages) {
    if (!Array.isArray(messages) || !messages.length) return [];
    const fresh = [];
    let maxId = chatSoundRuntime.dmLastObservedIncomingId;
    const baselineReady = chatSoundRuntime.dmBaselineReady === true;
    for (const msg of messages) {
      const id = parseDriverMsgId(msg);
      if (id === null) continue;
      const isFresh = baselineReady && (maxId === null || id > maxId);
      if (isFresh && !isOwnMessage(msg) && !isSuppressedOutgoingDmEcho(msg)) fresh.push(msg);
      maxId = maxId === null ? id : Math.max(maxId, id);
    }
    chatSoundRuntime.dmLastObservedIncomingId = maxId;
    chatSoundRuntime.dmBaselineReady = true;
    return fresh;
  }

  function normalizeDriverMessages(payload) {
    return normalizePrivateMessagesPayload(payload);
  }

  function appendDriverProfileMessages(messages, { replace = false } = {}) {
    const uid = String(driverProfileState.userId || '');
    if (!uid) return;
    const normalized = normalizeDriverMessages(messages);
    const next = replace ? upsertChatMessages([], normalized) : mergePrivateMessages(uid, normalized);
    pruneExpiredChatState();
    if (replace) {
      privateMessagesByUserId[uid] = next;
      pruneExpiredChatState();
      pruneVoiceAssetCache();
    }
    driverProfileState.messages = privateMessagesByUserId[uid] || next || [];
    driverProfileState.latestMessageId = (driverProfileState.messages || []).reduce((max, msg) => {
      const id = parseDriverMsgId(msg);
      return id === null ? max : Math.max(max, id);
    }, 0) || null;
    privateUpsertThreadFromMessages(uid, driverProfileState.messages, { displayName: driverProfileState.displayName || '' });
  }

  function currentDriverProfileDmScope() {
    return driverProfileState && driverProfileState.userId
      ? `dm:${driverProfileState.userId}`
      : 'dm:unknown';
  }

  function rememberOutgoingDmEcho(textOrMsg) {
    pruneOutgoingEchoMap(recentOutgoingDmEchoes);
    const text = typeof textOrMsg === 'string'
      ? textOrMsg
      : (textOrMsg?.text || textOrMsg?.message || '');
    const userId = typeof textOrMsg === 'string'
      ? currentChatSelfUserId()
      : (msgUserId(textOrMsg) || currentChatSelfUserId());
    const fp = makeOutgoingEchoFingerprint(text, userId);
    if (!fp) return;
    recentOutgoingDmEchoes.set(`${currentDriverProfileDmScope()}|${fp}`, Date.now() + CHAT_OUTGOING_ECHO_SUPPRESS_MS);
  }

  function isSuppressedOutgoingDmEcho(msg) {
    pruneOutgoingEchoMap(recentOutgoingDmEchoes);
    const fp = makeOutgoingEchoFingerprint(
      msg?.text || msg?.message || '',
      msgUserId(msg) || currentChatSelfUserId()
    );
    if (!fp) return false;
    return recentOutgoingDmEchoes.has(`${currentDriverProfileDmScope()}|${fp}`);
  }

  function closeDriverProfileModal() {
    if (chatVoiceState.scope === 'profile-dm') cancelChatVoiceRecording('Recording canceled');
    stopDriverProfileDmPolling();
    clearVoiceAssetsForMessages(driverProfileState.messages);
    driverProfileState.open = false;
    driverProfileState.userId = null;
    pruneVoiceAssetCache();
    driverProfileState.isSelf = false;
    driverProfileState.status = '';
    chatSoundRuntime.dmLastObservedIncomingId = null;
    chatSoundRuntime.dmBaselineReady = false;
    driverProfileState.dmInitialLoadComplete = false;
    const root = ensureDriverProfileUI();
    root.classList.remove('open');
    if (driverProfileLayoutTimer50) window.clearTimeout(driverProfileLayoutTimer50);
    if (driverProfileLayoutTimer180) window.clearTimeout(driverProfileLayoutTimer180);
    renderDriverProfileModal();
  }

  function bindSelfProfileActions() {
    document.getElementById('driverProfileChangePwdBtn')?.addEventListener('click', async (e) => {
      e.preventDefault();
      const signedIn = typeof window.authHeaderOK === 'function' ? window.authHeaderOK() : !!getCommunityToken();
      if (!signedIn) return;
      const oldPwd = prompt('Enter your current password:');
      if (oldPwd === null) return;
      const newPwd = prompt('Enter your new password:');
      if (newPwd === null) return;
      try {
        await postJSON('/me/change_password', { old_password: oldPwd, new_password: newPwd }, getCommunityToken());
        alert('Password changed successfully.');
      } catch (err) {
        alert(err?.detail || 'Error changing password.');
      }
    });

    document.getElementById('driverProfileDeleteAccountBtn')?.addEventListener('click', async (e) => {
      e.preventDefault();
      const signedIn = typeof window.authHeaderOK === 'function' ? window.authHeaderOK() : !!getCommunityToken();
      if (!signedIn) return;
      if (!confirm('Are you sure you want to delete your account? This cannot be undone.')) return;
      try {
        await postJSON('/me/delete_account', {}, getCommunityToken());
        if (typeof window.clearAuth === 'function') window.clearAuth();
        alert('Account deleted successfully.');
        location.reload();
      } catch (err) {
        alert(err?.detail || 'Error deleting account.');
      }
    });

    document.getElementById('driverProfileSignOutBtn')?.addEventListener('click', (e) => {
      e.preventDefault();
      if (typeof window.signOutNow === 'function') {
        window.signOutNow({ reload: true });
      }
    });

    if (typeof window.initMapIdentityProfileControls === 'function') {
      window.initMapIdentityProfileControls();
    }
  }

  function renderDriverProfileModal() {
    const root = ensureDriverProfileUI();
    const body = document.getElementById('driverProfileBody');
    if (!body) return;

    if (!driverProfileState.open) {
      root.classList.remove('open');
      body.innerHTML = '';
      return;
    }

    root.classList.add('open');
    updateDriverProfileLayout();

    if (driverProfileState.loading) {
      body.innerHTML = '<div class="driverProfileLoading">Loading driver profile…</div>';
      updateDriverProfileLayout();
      return;
    }

    if (driverProfileState.error && !driverProfileState.profile) {
      body.innerHTML = `
        <div class="driverProfileHeader"><button class="driverProfileClose" id="driverProfileCloseBtn" type="button">Close</button></div>
        <div class="driverProfileError">${escapeHtml(driverProfileState.error)}</div>
        <div class="driverProfileStatus"><button class="driverProfileClose" id="driverProfileRetryBtn" type="button">Retry</button></div>
      `;
      document.getElementById('driverProfileCloseBtn')?.addEventListener('click', closeDriverProfileModal);
      document.getElementById('driverProfileRetryBtn')?.addEventListener('click', () => {
        if (driverProfileState.userId != null) {
          openDriverProfileModal({ userId: driverProfileState.userId, isSelf: driverProfileState.isSelf, source: driverProfileState.source });
        }
      });
      updateDriverProfileLayout();
      return;
    }

    const profilePayload = driverProfileState.profile || {};
    const profileUser = profilePayload.user || {};
    const daily = profilePayload.daily || {};
    const weekly = profilePayload.weekly || {};
    const monthly = profilePayload.monthly || {};
    const yearly = profilePayload.yearly || {};
    const selfMode = !!driverProfileState.isSelf;
    const progression = (selfMode && driverProfileState.myProgression) ? driverProfileState.myProgression : (profilePayload.progression || {});
    const name = String(profileUser?.display_name || 'Driver').trim() || 'Driver';

    const dailyRanksHtml = `<div class="driverProfileDailyRanks">
      <div class="driverProfileStatRow"><div class="driverProfileStatLabel">Miles rank</div><div class="driverProfileStatValue">${escapeHtml(formatDriverProfileStat(daily?.miles_rank, 'rank'))}</div></div>
      <div class="driverProfileStatRow"><div class="driverProfileStatLabel">Hours rank</div><div class="driverProfileStatValue">${escapeHtml(formatDriverProfileStat(daily?.hours_rank, 'rank'))}</div></div>
    </div>`;

    const previousDmList = document.getElementById('driverProfileDmList');
    const previousDmScrollTop = previousDmList ? previousDmList.scrollTop : 0;
    const previousDmNearBottom = isChatNearBottom(previousDmList, 80);
    const messages = normalizeDriverMessages(driverProfileState.messages);
    const dmHtml = messages.length
      ? messages.map((msg) => renderPrivateConversationRow(msg, 'profile-dm')).join('')
      : '<div class="driverProfileStatus">No private messages yet.</div>';

    const accountActionsHtml = `
      <div class="driverProfileSectionTitle">Account actions</div>
      <div class="driverProfileActions">
        <button class="driverProfileActionBtn" id="driverProfileChangePwdBtn" type="button">Change Password</button>
        <button class="driverProfileActionBtn danger" id="driverProfileDeleteAccountBtn" type="button">Delete Account</button>
        <button class="driverProfileActionBtn" id="driverProfileSignOutBtn" type="button">Sign Out</button>
      </div>
      <div class="driverProfileSectionTitle">Map identity</div>
      <div class="driverProfileMapIdentity"><div id="profileMapIdentitySection"></div></div>
    `;

    body.innerHTML = `
      <div class="driverProfileHeader">
        <div class="driverProfileIdentity">
          ${driverProfileAvatarHTML(profileUser)}
          <div>
            <div class="driverProfileName">${escapeHtml(name)}</div>
            <div class="driverProfileBadgeRow">${driverProfileBadgeChip(profileUser?.leaderboard_badge_code)}</div>
          </div>
        </div>
        <div class="driverProfileHeaderActions">
          ${selfMode ? '' : '<button class="driverProfileActionBtn" id="driverProfileChallengeBtn" type="button">Challenge</button><button class="driverProfileActionBtn" id="driverProfileOpenInboxBtn" type="button">Message</button>'}
          <button class="driverProfileClose" id="driverProfileCloseBtn" type="button">Close</button>
        </div>
      </div>
      <div class="driverProfileScroll">
        ${renderDriverProgressionSection(progression)}
        <div class="driverProfileSectionTitle">Work stats</div>
        <div class="driverProfileStats">
          ${renderDriverProfilePeriodCard('Daily', daily, dailyRanksHtml)}
          ${renderDriverProfilePeriodCard('Weekly', weekly)}
          ${renderDriverProfilePeriodCard('Monthly', monthly)}
          ${renderDriverProfilePeriodCard('Yearly', yearly)}
        </div>
        <div class="driverProfileSectionTitle">Battle record</div>
        ${renderBattleStatsSection(profilePayload?.battle_record || profilePayload?.battle_stats)}
        <div class="driverProfileSectionTitle">Recent battles</div>
        ${renderRecentBattlesList(profilePayload?.recent_battles || profilePayload?.battle_history)}
        ${selfMode ? accountActionsHtml : `
          <div class="driverProfileSectionTitle">Private messages</div>
          <div class="driverProfileDmWrap">
            <div class="driverProfileDmList" id="driverProfileDmList">${dmHtml}</div>
            <div class="driverProfileComposer">
              <input class="driverProfileInput" id="driverProfileInput" type="text" placeholder="Type a private message">
              <button class="driverProfileSendBtn" id="driverProfileSendBtn" type="button" ${driverProfileState.sending ? 'disabled' : ''}>Send</button>
            </div>
            ${buildVoiceComposer('driverProfile', 'driverProfileVoiceComposer')}
          </div>
        `}
      </div>
      ${driverProfileState.error ? `<div class="driverProfileError">${escapeHtml(driverProfileState.error)}</div>` : ''}
      ${driverProfileState.status ? `<div class="driverProfileStatus">${escapeHtml(driverProfileState.status)}</div>` : ''}
    `;

    document.getElementById('driverProfileCloseBtn')?.addEventListener('click', closeDriverProfileModal);
    document.getElementById('driverProfileOpenInboxBtn')?.addEventListener('click', () => {
      openPrivateChatWithUser(driverProfileState.userId, name);
      closeDriverProfileModal();
    });
    document.getElementById('driverProfileChallengeBtn')?.addEventListener('click', () => {
      openGamesBattleComposer({ targetUserId: driverProfileState.userId, displayName: name, gameType: 'dominoes' });
      closeDriverProfileModal();
    });

    if (selfMode) {
      bindSelfProfileActions();
      updateDriverProfileLayout();
      return;
    }

    const input = document.getElementById('driverProfileInput');
    const sendBtn = document.getElementById('driverProfileSendBtn');
    const submit = async () => {
      if (driverProfileState.sending || !driverProfileState.userId || driverProfileState.isSelf) return;
      if (chatVoiceState.scope === 'profile-dm' && isChatVoiceBusy()) return;
      if (hasChatVoiceDraft('profile-dm')) {
        driverProfileState.sending = true;
        driverProfileState.error = '';
        if (sendBtn) sendBtn.disabled = true;
        try {
          await sendChatVoiceDraft('profile-dm', {
            userId: driverProfileState.userId,
            onUploaded: async (sent) => {
              const previousLatestId = driverProfileState.latestMessageId || null;
              const merged = await integrateUploadedVoiceMessage('private', sent, { previousLatestId, otherUserId: driverProfileState.userId, markRead: true, displayName: driverProfileState.displayName });
              if (merged.length) {
                seedDriverProfileDmAudioBaseline(merged);
                driverProfileState.messages = merged;
                driverProfileState.latestMessageId = merged.reduce((max, msg) => Math.max(max, Number(msg?.id || 0)), 0) || null;
              } else {
                const refreshed = await fetchDriverProfileDmThread(driverProfileState.userId, { limit: 30, markRead: true });
                appendDriverProfileMessages(refreshed, { replace: true });
                seedDriverProfileDmAudioBaseline(driverProfileState.messages);
              }
              privateUnreadByUserId[String(driverProfileState.userId)] = 0;
              renderPrivateTabUnread();
              updateChatUnreadBadge();
              await playChatTone('outgoing');
              updateDriverProfileDmList(driverProfileState.messages);
            },
          });
        } catch (err) {
          driverProfileState.error = err?.message || 'Voice note failed to send.';
          const errorEl = body.querySelector('.driverProfileError');
          if (errorEl) errorEl.textContent = driverProfileState.error;
        } finally {
          driverProfileState.sending = false;
          syncVoiceComposerSendButton('profile-dm');
        }
        return;
      }
      const textValue = String(input?.value || '').trim();
      if (!textValue) return;
      driverProfileState.sending = true;
      driverProfileState.error = '';
      if (sendBtn) sendBtn.disabled = true;
      try {
        await primeChatSoundSystem('dm-send-click');
        const sent = await sendDriverProfileDm(driverProfileState.userId, { text: textValue });
        rememberOutgoingDmEcho(textValue);
        input.value = '';
        const sentMessages = normalizeDriverMessages(sent);
        if (sentMessages.length) {
          sentMessages.forEach(rememberOutgoingDmEcho);
          seedDriverProfileDmAudioBaseline(sentMessages);
          appendDriverProfileMessages(sentMessages);
        } else {
          const refreshed = await fetchDriverProfileDmThread(driverProfileState.userId, { limit: 30, markRead: true });
          appendDriverProfileMessages(refreshed, { replace: true });
          seedDriverProfileDmAudioBaseline(driverProfileState.messages);
        }
        privateUnreadByUserId[String(driverProfileState.userId)] = 0;
        renderPrivateTabUnread();
        updateChatUnreadBadge();
        await playChatTone('outgoing');
        updateDriverProfileDmList(driverProfileState.messages);
      } catch (err) {
        driverProfileState.error = err?.message || 'Message failed to send.';
        const errorEl = body.querySelector('.driverProfileError');
        if (errorEl) errorEl.textContent = driverProfileState.error;
      } finally {
        driverProfileState.sending = false;
        syncVoiceComposerSendButton('profile-dm');
      }
    };
    sendBtn?.addEventListener('click', (ev) => { ev.preventDefault(); submit(); });
    input?.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        submit();
      }
    });
    bindVoiceComposerControls('driverProfile', () => ({
      userId: driverProfileState.userId,
      onUploaded: async (sent) => {
        const previousLatestId = driverProfileState.latestMessageId || null;
        const merged = await integrateUploadedVoiceMessage('private', sent, { previousLatestId, otherUserId: driverProfileState.userId, markRead: true, displayName: driverProfileState.displayName });
        if (merged.length) {
          seedDriverProfileDmAudioBaseline(merged);
          driverProfileState.messages = merged;
          driverProfileState.latestMessageId = merged.reduce((max, msg) => Math.max(max, Number(msg?.id || 0)), 0) || null;
        } else {
          const refreshed = await fetchDriverProfileDmThread(driverProfileState.userId, { limit: 30, markRead: true });
          appendDriverProfileMessages(refreshed, { replace: true });
          seedDriverProfileDmAudioBaseline(driverProfileState.messages);
        }
        privateUnreadByUserId[String(driverProfileState.userId)] = 0;
        renderPrivateTabUnread();
        updateChatUnreadBadge();
        await playChatTone('outgoing');
        updateDriverProfileDmList(driverProfileState.messages);
      },
    }));
    bindVoicePlayers(document.getElementById('driverProfileDmList') || document);
    void prefetchVoiceBlobUrls(messages.filter((msg) => msg?.messageType === 'voice'));

    const dmList = document.getElementById('driverProfileDmList');
    if (dmList) {
      if (previousDmNearBottom || !previousDmList) dmList.scrollTop = dmList.scrollHeight;
      else dmList.scrollTop = previousDmScrollTop;
    }
    updateDriverProfileLayout();
  }

  async function openDriverProfileModal({ userId, isSelf = false, source = '' } = {}) {
    if (chatVoiceState.scope === 'profile-dm') cancelChatVoiceRecording('Recording canceled');
    const nextUserId = Number(userId);
    if (!Number.isFinite(nextUserId)) return;
    const meId = Number(window?.me?.id);
    const selfMode = Boolean(isSelf) || (Number.isFinite(meId) && meId === nextUserId);
    ensureDriverProfileUI();
    stopDriverProfileDmPolling();
    driverProfileState.open = true;
    driverProfileState.userId = nextUserId;
    driverProfileState.isSelf = selfMode;
    driverProfileState.source = String(source || '');
    driverProfileState.loading = true;
    driverProfileState.displayName = '';
    driverProfileState.profile = null;
    driverProfileState.myProgression = null;
    clearVoiceAssetsForMessages(driverProfileState.messages);
    driverProfileState.messages = [];
    pruneVoiceAssetCache();
    driverProfileState.latestMessageId = null;
    chatSoundRuntime.dmLastObservedIncomingId = null;
    chatSoundRuntime.dmBaselineReady = false;
    driverProfileState.dmInitialLoadComplete = false;
    driverProfileState.error = '';
    driverProfileState.status = '';
    driverProfileState.sending = false;
    scheduleDriverProfileLayoutUpdate();
    renderDriverProfileModal();

    try {
      const profileRes = await fetchDriverProfile(nextUserId);
      if (!driverProfileState.open || driverProfileState.userId !== nextUserId) return;
      driverProfileState.profile = profileRes || {};
      driverProfileState.displayName = String(driverProfileState.profile?.user?.display_name || privateThreads.find((thread) => thread.otherUserId === String(nextUserId))?.displayName || 'Driver').trim() || 'Driver';
      syncPrivateThreadMeta(nextUserId, driverProfileState.displayName);
      if (selfMode) {
        const latestProgression = await syncMyProgression({ forcePopupCheck: false });
        if (latestProgression && driverProfileState.open && driverProfileState.userId === nextUserId) {
          driverProfileState.myProgression = latestProgression;
        }
      }
      if (!selfMode) {
        const dmRes = await fetchDriverProfileDmThread(nextUserId, { limit: 30, markRead: true });
        if (!driverProfileState.open || driverProfileState.userId !== nextUserId) return;
        appendDriverProfileMessages(dmRes, { replace: true });
        seedDriverProfileDmAudioBaseline(driverProfileState.messages);
        driverProfileState.dmInitialLoadComplete = true;
        privateUnreadByUserId[String(nextUserId)] = 0;
        renderPrivateTabUnread();
        updateChatUnreadBadge();
      }
    } catch (err) {
      if (!driverProfileState.open || driverProfileState.userId !== nextUserId) return;
      driverProfileState.error = err?.message || 'Unable to load driver profile.';
    } finally {
      if (!driverProfileState.open || driverProfileState.userId !== nextUserId) return;
      driverProfileState.loading = false;
      renderDriverProfileModal();
      scheduleDriverProfileLayoutUpdate();
      if (!selfMode) startDriverProfileDmPolling();
    }
  }

  async function pollDriverProfileDmOnce() {
    if (!driverProfileState.open || !driverProfileState.userId || driverProfileState.isSelf) return;
    try {
      const incoming = await fetchDriverProfileDmThread(driverProfileState.userId, {
        after: driverProfileState.latestMessageId,
        limit: 30,
        markRead: true
      });
      if (!incoming.length) return;
      const hasIncomingFromOther = driverProfileState.dmInitialLoadComplete
        && collectFreshIncomingDriverProfileDm(incoming).length > 0;
      appendDriverProfileMessages(incoming);
      privateUnreadByUserId[String(driverProfileState.userId)] = 0;
      renderPrivateTabUnread();
      updateChatUnreadBadge();
      if (hasIncomingFromOther) void playChatTone('incoming');
      updateDriverProfileDmList(driverProfileState.messages);
    } catch (_) {}
  }

  function scheduleDriverProfileDmPoll({ immediate = false } = {}) {
    if (driverProfileState.isSelf || !driverProfileState.open || !driverProfileState.userId) return;
    if (driverProfileState.pollTimer) window.clearTimeout(driverProfileState.pollTimer);
    const delay = immediate ? 0 : getDriverProfilePollIntervalMs();
    driverProfileState.pollTimer = window.setTimeout(async () => {
      driverProfileState.pollTimer = null;
      if (driverProfilePollInFlight) return;
      driverProfilePollInFlight = true;
      try {
        await pollDriverProfileDmOnce();
      } finally {
        driverProfilePollInFlight = false;
        if (driverProfileState.open && driverProfileState.userId && !driverProfileState.isSelf) scheduleDriverProfileDmPoll();
      }
    }, delay);
  }

  function startDriverProfileDmPolling() {
    if (driverProfileState.isSelf) return;
    stopDriverProfileDmPolling();
    scheduleDriverProfileDmPoll({ immediate: true });
  }

  function stopDriverProfileDmPolling() {
    if (!driverProfileState.pollTimer) return;
    window.clearTimeout(driverProfileState.pollTimer);
    driverProfileState.pollTimer = null;
  }

  function openPrivateChatWithUser(userId, displayName = '') {
    if (!userId) return;
    if (typeof openPanel === 'function') {
      openPanel('chat', 'Chat', chatPanelHTML(), wireChatPanel);
    }
    activeChatTab = 'private';
    if (displayName) privateActiveDisplayName = String(displayName);
    setTimeout(() => {
      switchChatTab('private');
      openPrivateConversation(String(userId), displayName);
    }, 0);
  }

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
  window.initDockScroller = initDockScroller;
  window.updateDockScrollHints = updateDockScrollHints;
  window.scrollDockByStep = scrollDockByStep;
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
  window.syncMyProgression = syncMyProgression;
  window.handlePickupProgressionDelta = handlePickupProgressionDelta;
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

  initDockScroller();
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

  window.testChatIncomingSound = async function () {
    await primeChatSoundSystem('manual-test-incoming');
    return playChatTone('incoming');
  };

  window.testChatOutgoingSound = async function () {
    await primeChatSoundSystem('manual-test-outgoing');
    return playChatTone('outgoing');
  };

  window.getChatSoundDebugState = function () {
    return {
      userPrimed: chatSoundRuntime.userPrimed,
      htmlAudioReady: chatSoundRuntime.htmlAudioReady,
      webAudioReady: chatSoundRuntime.webAudioReady,
      ctxState: chatAudioCtx ? chatAudioCtx.state : null,
      pendingIncoming: chatSoundRuntime.pendingIncoming,
      pendingOutgoing: chatSoundRuntime.pendingOutgoing,
      lastObservedIncomingId: chatSoundRuntime.lastObservedIncomingId
    };
  };


  window.getChatAudioLifecycleDebug = function () {
    return {
      chatAudioUnlocked,
      chatAudioReady,
      ctxExists: !!chatAudioCtx,
      ctxState: chatAudioCtx ? chatAudioCtx.state : null,
      userPrimed: typeof chatSoundRuntime !== 'undefined' ? chatSoundRuntime.userPrimed : null,
      webAudioReady: typeof chatSoundRuntime !== 'undefined' ? chatSoundRuntime.webAudioReady : null,
      htmlAudioReady: typeof chatSoundRuntime !== 'undefined' ? chatSoundRuntime.htmlAudioReady : null,
      pendingIncoming: typeof chatSoundRuntime !== 'undefined' ? chatSoundRuntime.pendingIncoming : null,
      pendingOutgoing: typeof chatSoundRuntime !== 'undefined' ? chatSoundRuntime.pendingOutgoing : null,
      lastPrimeAt: typeof chatSoundRuntime !== 'undefined' ? chatSoundRuntime.lastPrimeAt : null,
      lastLifecycleResetAt: typeof chatSoundRuntime !== 'undefined' ? chatSoundRuntime.lastLifecycleResetAt : null,
      lastObservedIncomingId: typeof chatSoundRuntime !== 'undefined' ? chatSoundRuntime.lastObservedIncomingId : null,
    };
  };
  window.getChatAudioDebugState = function () {
    let audioSessionType = null;
    try {
      audioSessionType = navigator && navigator.audioSession ? navigator.audioSession.type : null;
    } catch (_) {
      audioSessionType = null;
    }
    return {
      chatAudioUnlocked,
      chatAudioReady,
      ctxState: chatAudioCtx ? chatAudioCtx.state : null,
      audioSessionType,
      recentOutgoingChatEchoes: recentOutgoingChatEchoes.size,
      recentOutgoingDmEchoes: typeof recentOutgoingDmEchoes !== 'undefined' ? recentOutgoingDmEchoes.size : 0,
    };
  };

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