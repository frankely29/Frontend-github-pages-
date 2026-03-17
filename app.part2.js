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

  // Chat constants
  const CHAT_ROOM = typeof window !== 'undefined' && window.CHAT_ROOM ? window.CHAT_ROOM : 'global';
  // Reduce the polling interval so new messages appear more promptly.
  const CHAT_POLL_MS = typeof window !== 'undefined' && window.CHAT_POLL_MS
    ? window.CHAT_POLL_MS
    : 800; // milliseconds

  // Token helper (matches LS_TOKEN in app.js)
  const LS_TOKEN = 'community_token_v1';
  function getCommunityToken() {
    try { return localStorage.getItem(LS_TOKEN) || ''; } catch (_) { return ''; }
  }

  // Chat state
  let chatPollTimer = null;
  let chatLastSeen = null;
  let chatLatestMessageId = null;
  let chatLastReadId = loadChatLastReadId();
  let chatSeenKeys = new Set();
  let unreadChatCount = 0;
  let chatInitialHistoryLoaded = false;
  let chatInitialHistoryLoadAttempted = false;
  let chatInitialHistoryRetryQueued = false;

  // Kill-feed bootstrap guard.
  // We seed startup history into seen-keys, then suppress feed replay until
  // one post-bootstrap poll has been absorbed as history too.
  let killFeedBootstrapReady = false;
  let killFeedBootstrapPollConsumed = false;

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
    if (unreadChatCount > 0) {
      btn.dataset.unread = unreadChatCount > 99 ? '99+' : String(unreadChatCount);
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
    if (msg?.user_id != null) return String(msg.user_id);
    if (msg?.userId != null) return String(msg.userId);
    return null;
  }

  function isOwnMessage(msg) {
    const selfId = (typeof window !== 'undefined' && window.me && window.me.id != null)
      ? String(window.me.id)
      : null;
    const senderId = msgUserId(msg);
    return !!(selfId && senderId && selfId === senderId);
  }

  const CHAT_OUTGOING_ECHO_SUPPRESS_MS = 8000;
  const recentOutgoingChatEchoes = new Map();

  function currentChatSelfUserId() {
    return (window && window.me && window.me.id != null) ? String(window.me.id) : '';
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

  function applyChatAudioSessionAmbient(reason = 'chat') {
    const session = getChatAudioSession();
    if (!session) return false;
    try {
      if (session.type !== 'ambient') session.type = 'ambient';
      return session.type === 'ambient';
    } catch (_) {
      return false;
    }
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
    applyChatAudioSessionAmbient('ensure-context');
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
    reconcileChatSoundRuntime('flush-pending');
    if (!chatAudioReady) return;
    const incomingPending = chatSoundRuntime.pendingIncoming > 0;
    const outgoingPending = chatSoundRuntime.pendingOutgoing > 0;
    chatSoundRuntime.pendingIncoming = 0;
    chatSoundRuntime.pendingOutgoing = 0;
    if (incomingPending) await playChatTone('incoming');
    if (outgoingPending) await playChatTone('outgoing');
  }

  function onChatSoundPrimeInteraction(evt) {
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

      const who = msg.display_name || msg.user_name || msg.name || 'Driver';
      const body = String(msg.text || msg.message || '').trim();
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
        <div id="chatList" class="chatList" aria-live="polite"></div>
        <div class="chatComposer">
          <input id="chatInput" type="text" class="chatInput" placeholder="Message drivers…" maxlength="600" />
          <button id="chatSendBtn" class="chipBtn" type="button">Send</button>
        </div>
      </div>
    `;
  }

  // Helpers for message keys, timestamps, scroll behaviour, etc.
  function chatMsgCursor(msg) { return msg?.id ?? msg?.created_at ?? null; }
  function chatMsgKey(msg) {
    const id = msg?.id;
    if (id !== undefined && id !== null) return `id:${id}`;
    const t = msg?.created_at || '';
    const n = msg?.display_name || msg?.user_name || msg?.name || '';
    const body = msg?.text || msg?.message || '';
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
  function chatResetState() {
    chatLastSeen = null;
    chatLatestMessageId = null;
    chatLastReadId = loadChatLastReadId();
    chatSeenKeys = new Set();
    unreadChatCount = 0;
    updateChatUnreadBadge();
    chatSoundRuntime.lastObservedIncomingId = null;
    chatSoundRuntime.seenIncomingKeys = new Set();
    chatSoundRuntime.dmBaselineReady = false;
    chatSoundState.baselineReady = false;
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
    const listEl = document.getElementById('chatList');
    if (!listEl) return;
    if (replace) {
      // Reset the per-panel dedupe cache when rebuilding the chat list.
      // The notification bootstrap seeds chatSeenKeys so we do not replay
      // alerts, but that should not suppress initial message rendering after
      // a page refresh.
      chatSeenKeys = new Set();
      listEl.innerHTML = '';
      listEl.dataset.hasMessages = '0';
    }
    if (!Array.isArray(messages) || !messages.length) {
      if (replace) setChatStatus('No messages yet.');
      return;
    }
    const nearBottom = isChatNearBottom(listEl, 80);
    const frag = document.createDocumentFragment();
    let appended = 0;
    for (const msg of messages) {
      const key = chatMsgKey(msg);
      if (chatSeenKeys.has(key)) continue;
      chatSeenKeys.add(key);
      const row = document.createElement('div');
      row.className = 'chatMsgRow';
      const line = document.createElement('div');
      line.className = 'chatMsgLine';
      const who = document.createElement('strong');
      who.className = 'chatMsgName';
      who.textContent = `${msg?.display_name || msg?.user_name || msg?.name || 'Driver'}: `;
      const text = document.createElement('span');
      text.className = 'chatMsgText';
      text.textContent = String(msg?.text || msg?.message || '');
      const time = document.createElement('div');
      time.className = 'chatMsgTime';
      time.textContent = formatChatTime(msg?.created_at || msg?.ts || msg?.timestamp);
      line.appendChild(who);
      line.appendChild(text);
      row.appendChild(line);
      row.appendChild(time);
      frag.appendChild(row);
      const cursor = chatMsgCursor(msg);
      if (cursor !== null && cursor !== undefined) chatLastSeen = cursor;
      const id = messageNumericId(msg);
      if (id !== null) chatLatestMessageId = chatLatestMessageId === null ? id : Math.max(chatLatestMessageId, id);
      appended += 1;
    }
    if (!appended) {
      if (replace) setChatStatus('No messages yet.');
      return;
    }
    if (!replace && listEl.dataset.hasMessages !== '1') {
      listEl.innerHTML = '';
    }
    listEl.dataset.hasMessages = '1';
    if (replace) listEl.innerHTML = '';
    listEl.appendChild(frag);
    if (nearBottom || replace) listEl.scrollTop = listEl.scrollHeight;
  }

  // Fetch messages. Only proceed if a token is present.
  async function chatFetchMessages({ after = null, limit = 50 } = {}) {
    const token = getCommunityToken();
    if (!token) return { ok: false, reason: 'not_ready' };
    const qs = new URLSearchParams();
    qs.set('limit', String(limit));
    if (after !== null && after !== undefined && String(after).trim() !== '') {
      qs.set('after', String(after));
    }
    try {
      const data = await getJSONAuth(`/chat/rooms/${CHAT_ROOM}?${qs.toString()}`, token);
      return { ok: true, messages: Array.isArray(data) ? data : data?.messages || [] };
    } catch (err) {
      console.warn('chatFetchMessages failed', err);
      return { ok: false, reason: 'failed', error: err };
    }
  }

  // Load initial and new messages
  async function chatLoadInitial() {
    chatInitialHistoryLoadAttempted = true;
    const result = await chatFetchMessages({ limit: 60 });
    if (!result?.ok) {
      if (result?.reason === 'not_ready') {
        setChatStatus('Loading chat...');
      } else {
        setChatStatus('Chat unavailable right now.');
      }
      return { ok: false, messages: [] };
    }
    const msgs = Array.isArray(result.messages) ? result.messages : [];
    seedChatIncomingAudioBaseline(msgs);
    renderChatMessages(msgs, { replace: true });
    chatInitialHistoryLoaded = true;
    chatInitialHistoryRetryQueued = false;
    // Initial history should never replay into kill feed notifications.
    seedKillFeedSeenKeys(msgs);
    killFeedBootstrapReady = true;
    if (!maybeInitializeChatReadBaseline()) {
      rebuildUnreadBadgeFromMessages(msgs);
    }
    return { ok: true, messages: msgs };
  }
  async function chatFetchNew() { return chatFetchMessages({ after: chatLastSeen, limit: 50 }); }

  // Send a message (requires token)
  async function chatSend(text) {
    const token = getCommunityToken();
    if (!token) { throw new Error('Not signed in'); }
    return postJSON(`/chat/rooms/${CHAT_ROOM}`, { text }, token);
  }

  // Poll once and control polling
  async function chatPollOnce() {
    // Only poll when authenticated.
    if (typeof authHeaderOK === 'function' && !authHeaderOK()) return;

    try {
      const msgs = await chatFetchNew();
      if (!msgs?.ok) {
        if (isChatPanelOpen() && !chatInitialHistoryLoaded) {
          if (msgs?.reason === 'not_ready') {
            setChatStatus('Loading chat...');
          } else {
            setChatStatus('Chat unavailable right now.');
          }
        }
        return;
      }
      const loadedMsgs = Array.isArray(msgs.messages) ? msgs.messages : [];
      advanceChatWatermarksFromMessages(loadedMsgs);
      const needsInitialRecovery = !chatInitialHistoryLoaded;
      const hadIncomingAudioBaseline = chatSoundState.baselineReady;

      // If we already have an audio baseline, this batch may contain truly new messages
      // even if the UI still considers itself in an initial recovery path.
      const freshIncoming = hadIncomingAudioBaseline
        ? collectFreshIncomingMessagesForAudio(loadedMsgs)
        : [];

      if (freshIncoming.length > 0) {
        void playChatTone('incoming');
      }

      if (needsInitialRecovery) {
        chatInitialHistoryLoaded = true;
        chatInitialHistoryRetryQueued = false;

        // Only seed the audio baseline here if we truly had no baseline yet.
        if (!hadIncomingAudioBaseline) {
          seedChatIncomingAudioBaseline(loadedMsgs);
        }

        if (!killFeedBootstrapReady) {
          seedKillFeedSeenKeys(loadedMsgs);
          killFeedBootstrapReady = true;
          killFeedBootstrapPollConsumed = true;
        }

        if (!maybeInitializeChatReadBaseline()) {
          rebuildUnreadBadgeFromMessages(loadedMsgs);
        }
      }

      // Update the in-panel chat messages only if the chat panel is open.
      if (isChatPanelOpen()) {
        renderChatMessages(loadedMsgs, { replace: needsInitialRecovery });
        markChatReadThroughLatestLoaded();

        // Hide the kill feed when chat panel is open.
        if (killFeedContainer) killFeedContainer.style.display = 'none';
      } else {
        // Show the kill feed container.
        if (killFeedContainer) killFeedContainer.style.display = 'flex';

        // Guard against startup replay: absorb first post-bootstrap poll
        // as already-seen history, then allow only later unseen arrivals.
        if (killFeedBootstrapReady && !killFeedBootstrapPollConsumed) {
          seedKillFeedSeenKeys(loadedMsgs);
          killFeedBootstrapPollConsumed = true;
        } else if (killFeedBootstrapReady && killFeedBootstrapPollConsumed) {
          showKillFeed(loadedMsgs);
        }
      }
    } catch (e) {
      console.warn('chat poll failed:', e);
    }
  }
  function startChatPolling() {
    if (chatPollTimer) return;
    if (typeof authHeaderOK === 'function' && !authHeaderOK()) return;
    chatPollTimer = setInterval(chatPollOnce, CHAT_POLL_MS);
  }
  function stopChatPolling() { if (!chatPollTimer) return; clearInterval(chatPollTimer); chatPollTimer = null; }
  function syncChatPollingState() {
    if (typeof authHeaderOK === 'function' && authHeaderOK()) {
      startChatPolling();
      if (isChatPanelOpen() && chatInitialHistoryLoadAttempted && !chatInitialHistoryLoaded && !chatInitialHistoryRetryQueued) {
        chatInitialHistoryRetryQueued = true;
        chatLoadInitial()
          .catch((e) => {
            console.warn('chat initial retry failed:', e);
            setChatStatus('Chat unavailable right now.');
          })
          .finally(() => {
            chatInitialHistoryRetryQueued = false;
          });
      }
    } else {
      stopChatPolling();
    }
  }

  // Wire up the chat panel: event handlers, initial load, polling
  function wireChatPanel() {
    ensureChatNotificationsBootstrapped('chat-panel-open');
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
      const text = String(chatInput.value || '').trim();
      if (!text) return;
      chatSendBtn.disabled = true;
      try {
        await primeChatSoundSystem('chat-send-click');
        await ensureChatNotificationsBootstrapped('chat-send-click');
        const msg = await chatSend(text);
        rememberOutgoingChatEcho(text);
        const sentMessages = Array.isArray(msg) ? msg : (msg ? [msg] : []);
        if (sentMessages.length > 0) {
          sentMessages.forEach(rememberOutgoingChatEcho);
          seedChatIncomingAudioBaseline(sentMessages);
        }
        chatInput.value = '';
        if (msg) renderChatMessages(Array.isArray(msg) ? msg : [msg]);
        await playChatTone('outgoing');
        await chatPollOnce();
      } catch (e) {
        console.warn('chat send failed:', e);
        alert(e?.message || 'Message failed to send.');
      } finally {
        chatSendBtn.disabled = false;
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
    const crownPx = clampMapIdentity(Math.round(avatarPx * 0.69), 17, 29);
    const podiumPx = clampMapIdentity(Math.round(avatarPx * 0.40), 12, 18);
    return {
      avatarPx,
      crownPx,
      podiumPx,
      crownLiftPx: Math.round(crownPx * 0.38),
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
    const crownPx = clampMapIdentity(Math.round(safeAvatarPx * 0.69), 17, 29);
    const podiumPx = clampMapIdentity(Math.round(safeAvatarPx * 0.40), 12, 18);
    return {
      crownPx,
      podiumPx,
      crownLiftPx: Math.round(crownPx * 0.38)
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
      svg = `<svg class="${classes}" viewBox="0 0 64 52" width="${size}" height="${size}" role="img" aria-label="${title}" focusable="false">
        <defs>
          <linearGradient id="crownGoldBody" x1="7" y1="8" x2="55" y2="48" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#fff8cf"/>
            <stop offset="0.34" stop-color="#f4ca58"/>
            <stop offset="0.7" stop-color="#d49b24"/>
            <stop offset="1" stop-color="#9b6510"/>
          </linearGradient>
          <linearGradient id="crownBandGold" x1="11" y1="40" x2="53" y2="49" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#f8dd7d"/>
            <stop offset="0.55" stop-color="#d49a25"/>
            <stop offset="1" stop-color="#8c560f"/>
          </linearGradient>
          <linearGradient id="crownRubyCore" x1="32" y1="24" x2="32" y2="35" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#ff6d8d"/>
            <stop offset="0.48" stop-color="#c91f4c"/>
            <stop offset="1" stop-color="#751028"/>
          </linearGradient>
          <linearGradient id="crownDiamondCore" x1="18" y1="23" x2="18" y2="31" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#ffffff"/>
            <stop offset="0.5" stop-color="#dbe8f7"/>
            <stop offset="1" stop-color="#bccfe5"/>
          </linearGradient>
          <linearGradient id="crownRubySide" x1="46" y1="23" x2="46" y2="31" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#ff88a0"/>
            <stop offset="0.5" stop-color="#be2148"/>
            <stop offset="1" stop-color="#700f24"/>
          </linearGradient>
        </defs>
        <path d="M6 41.5h52L53.8 15 40 26.2 32 8 24 26.2 10.2 15 6 41.5Z" fill="url(#crownGoldBody)" stroke="#7b4a09" stroke-width="3" stroke-linejoin="round"/>
        <path d="M11 41h42v7.5H11z" fill="url(#crownBandGold)" stroke="#73450b" stroke-width="3"/>
        <path d="M11 20.4c5.9 4 12.1 4.6 18.7 1.8 1.4-.6 2.9-.6 4.3 0 6.6 2.8 12.8 2.2 18.7-1.8" fill="none" stroke="rgba(255,246,201,.72)" stroke-width="1.8" stroke-linecap="round"/>
        <path d="M14 31.4c5.1-1.8 9.5-1.8 13.4 0M36.6 31.4c4-1.8 8.3-1.8 13.4 0" fill="none" stroke="rgba(255,224,132,.42)" stroke-width="1.6" stroke-linecap="round"/>
        <path d="M13 39c5.5-3.1 32.5-3.1 38 0" fill="none" stroke="rgba(255,255,255,.45)" stroke-width="1.9" stroke-linecap="round"/>
        <circle cx="32" cy="29.8" r="5.3" fill="url(#crownRubyCore)" stroke="#631124" stroke-width="1.8"/>
        <circle cx="30.8" cy="28.5" r="1.2" fill="rgba(255,231,238,.88)"/>
        <path d="M18 23.7l3.3 3.3-3.3 3.3-3.3-3.3z" fill="url(#crownDiamondCore)" stroke="#8b9cb4" stroke-width="1.4"/>
        <path d="M17.9 25.4 19.6 27l-1.7 1.6" fill="none" stroke="rgba(255,255,255,.78)" stroke-width="0.8" stroke-linecap="round"/>
        <circle cx="46" cy="27" r="3.5" fill="url(#crownRubySide)" stroke="#621126" stroke-width="1.5"/>
        <circle cx="45.1" cy="26" r="0.9" fill="rgba(255,228,235,.9)"/>
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

  const gamesState = {
    activeTab: 'chess',
    chess: createInitialChessState(),
    uno: createInitialUnoState(),
    unoWaitingColor: false
  };

  function gamesPanelHTML() {
    return `
      <div class="panelBlock gamesPanelWrap">
        <div class="gamesTabs">
          <button id="gamesTabChess" class="chipBtn gamesTabBtn ${gamesState.activeTab === 'chess' ? 'active' : ''}">Chess vs CPU</button>
          <button id="gamesTabUno" class="chipBtn gamesTabBtn ${gamesState.activeTab === 'uno' ? 'active' : ''}">UNO vs CPU</button>
          <button id="gamesResetBtn" class="chipBtn">New Game</button>
        </div>
        <div id="gamesContent"></div>
      </div>
    `;
  }

  function wireGamesPanel() {
    document.getElementById('gamesTabChess')?.addEventListener('click', (e) => { e.preventDefault(); gamesState.activeTab = 'chess'; rerenderGamesPanel(); });
    document.getElementById('gamesTabUno')?.addEventListener('click', (e) => { e.preventDefault(); gamesState.activeTab = 'uno'; rerenderGamesPanel(); });
    document.getElementById('gamesResetBtn')?.addEventListener('click', (e) => {
      e.preventDefault();
      if (gamesState.activeTab === 'chess') gamesState.chess = createInitialChessState();
      else {
        gamesState.uno = createInitialUnoState();
        gamesState.unoWaitingColor = false;
      }
      rerenderGamesPanel();
      if (gamesState.activeTab === 'uno') maybeRunUnoCpuTurn();
    });
    renderGamesContent();
  }

  function rerenderGamesPanel() {
    if (typeof openPanelKey === 'undefined' || openPanelKey !== 'games') return;
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
    } else {
      renderUnoContent(host);
    }
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

  function updateDockScrollHints() {
    const dock = document.getElementById('dock');
    const viewport = document.getElementById('dockViewport');
    if (!dock || !viewport) return;
    const maxScroll = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    const leftVisible = viewport.scrollLeft > 2;
    const rightVisible = viewport.scrollLeft < (maxScroll - 2);
    dock.classList.toggle('dock-can-scroll-left', leftVisible);
    dock.classList.toggle('dock-can-scroll-right', rightVisible);
  }

  function scrollDockByStep(direction) {
    const viewport = document.getElementById('dockViewport');
    if (!viewport) return;
    const step = Math.max(120, Math.round(viewport.clientWidth * 1.2));
    viewport.scrollBy({ left: direction * step, behavior: 'smooth' });
  }

  function initDockScroller() {
    const viewport = document.getElementById('dockViewport');
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

    viewport.addEventListener('scroll', scheduleHintUpdate, { passive: true });
    window.addEventListener('resize', scheduleHintUpdate);

    leftHint?.addEventListener('click', () => scrollDockByStep(-1));
    rightHint?.addEventListener('click', () => scrollDockByStep(1));

    scheduleHintUpdate();
    setTimeout(scheduleHintUpdate, 120);
  }


  const DRIVER_PROFILE_DM_POLL_MS = 1500;
  const driverProfileState = {
    open: false,
    userId: null,
    isSelf: false,
    source: '',
    loading: false,
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
      .driverProfileSheet{position:absolute;left:50%;transform:translate(-50%,110%);bottom:var(--driver-profile-bottom-offset, 16px);width:min(430px,calc(100vw - 16px));max-height:calc(100vh - var(--driver-profile-bottom-offset, 16px) - env(safe-area-inset-top) - 18px);background:rgba(255,255,255,.985);border-radius:24px 24px 16px 16px;box-shadow:0 -12px 30px rgba(0,0,0,.2);display:flex;flex-direction:column;overflow:hidden;transition:transform .18s ease-out;z-index:9801}
      #driverProfileModalRoot.open .driverProfileSheet{transform:translate(-50%,0)}
      .driverProfileBody{display:flex;flex-direction:column;min-height:0;height:100%}
      .driverProfileHeader{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:10px 11px 7px}
      .driverProfileIdentity{display:flex;gap:8px;align-items:center;min-width:0}
      .driverProfileAvatar{width:44px;height:44px;border-radius:999px;flex:0 0 44px;object-fit:cover;background:#e8edf5}
      .driverProfileName{font-size:15px;line-height:1.18;font-weight:700;color:#111827;word-break:break-word}
      .driverProfileBadgeRow{display:flex;align-items:center;gap:7px;margin-top:4px;min-height:24px}
      .driverProfileBadgeChipWrap{display:inline-flex;align-items:center;gap:7px}.driverProfileBadgeLabel{font-size:11px;font-weight:700;color:#334155;letter-spacing:.15px}
      .driverProfileProgressWrap{background:#f8fafc;border:1px solid #e2e8f0;border-radius:11px;padding:8px;margin-bottom:9px}
      .driverProfileProgressHead{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
      .driverProfileProgressLine{font-size:12px;font-weight:700;color:#0f172a;display:flex;align-items:center;gap:5px;min-width:0;flex-wrap:wrap}
      .driverProfileProgressMeta{font-size:11px;color:#475569;line-height:1.35}
      .driverProfileProgressBar{height:7px;border-radius:999px;background:#e2e8f0;overflow:hidden;margin:5px 0 6px}
      .driverProfileProgressFill{height:100%;background:linear-gradient(90deg,#3b82f6,#22c55e);border-radius:999px;transition:width .2s ease-out}
      .driverProfileRankName{color:#0f172a;font-weight:800}
      .driverProfileBreakdownGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 10px;margin-top:6px;padding-top:6px;border-top:1px dashed #dbe4ee}
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
      .driverProfileScroll{overflow:auto;-webkit-overflow-scrolling:touch;padding:0 11px 10px;min-height:0}
      .driverProfileSectionTitle{font-size:12px;font-weight:700;color:#111827;margin:2px 0 6px}
      .driverProfileStats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-bottom:9px}
      .driverProfileStatCard{background:#f8fafc;border:1px solid #e2e8f0;border-radius:11px;padding:7px}
      .driverProfileStatPeriod{font-size:11px;font-weight:700;color:#0f172a;margin-bottom:4px}
      .driverProfileStatRow{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:2px}
      .driverProfileStatLabel{font-size:11px;color:#475569}
      .driverProfileStatValue{font-size:13px;font-weight:700;color:#0f172a}
      .driverProfileDailyRanks{margin-top:5px;padding-top:4px;border-top:1px dashed #dbe4ee}
      .driverProfileDailyRanks .driverProfileStatLabel{font-size:10px}
      .driverProfileDailyRanks .driverProfileStatValue{font-size:11px}
      .driverProfileDmWrap{display:flex;flex-direction:column;border:1px solid #e2e8f0;border-radius:11px;background:#fff;min-height:130px}
      .driverProfileDmList{display:flex;flex-direction:column;gap:7px;overflow:auto;max-height:min(22vh,190px);padding:9px}
      .driverProfileDmBubble{max-width:86%;font-size:12px;line-height:1.3;white-space:pre-wrap;word-break:break-word;padding:7px 9px;border-radius:11px}
      .driverProfileDmBubble.me{align-self:flex-end;background:#2563eb;color:#fff;border-bottom-right-radius:4px}
      .driverProfileDmBubble.other{align-self:flex-start;background:#e2e8f0;color:#111827;border-bottom-left-radius:4px}
      .driverProfileComposer{display:flex;gap:7px;padding:8px;border-top:1px solid #e2e8f0;padding-bottom:calc(8px + env(safe-area-inset-bottom))}
      .driverProfileInput{flex:1;min-width:0;border:1px solid #cbd5e1;border-radius:10px;padding:9px;font-size:16px;color:#0f172a}
      .driverProfileSendBtn{border:0;border-radius:10px;background:#1d4ed8;color:#fff;font-weight:600;padding:9px 11px}
      .driverProfileSendBtn:disabled{opacity:.6}
      .driverProfileStatus{font-size:12px;color:#64748b;padding:0 11px 8px}
      .driverProfileError{font-size:12px;color:#b91c1c;background:#fee2e2;border:1px solid #fecaca;border-radius:10px;padding:8px;margin:3px 11px 8px}
      .driverProfileLoading{padding:16px 11px;color:#334155;font-size:13px}
      .driverProfileActions{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:8px}
      .driverProfileActionBtn{border:1px solid #cbd5e1;background:#f8fafc;color:#0f172a;border-radius:10px;padding:8px 10px;font-size:13px;font-weight:600}
      .driverProfileActionBtn.danger{border-color:#fecaca;background:#fff1f2;color:#b91c1c}
      .driverProfileMapIdentity{border:1px solid #e2e8f0;border-radius:11px;padding:8px;background:#fff}
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

  function resolveRankIconTone(rankIconKey) {
    const key = String(rankIconKey || '').trim().toLowerCase();
    if (!key) return 'toneRecruit';
    if (/legend|mythic|immortal/.test(key)) return 'toneLegend';
    if (/general|brigadier/.test(key)) return 'toneGeneral';
    if (/colonel|major|captain|lieutenant/.test(key)) return 'toneOfficer';
    if (/sergeant|corporal|private|recruit/.test(key)) return 'toneEnlisted';
    return 'toneRecruit';
  }

  function renderRankBadgeIcon(rankIconKey, { compact = false } = {}) {
    const key = String(rankIconKey || '').trim().toLowerCase();
    const toneClass = resolveRankIconTone(key);
    const size = compact ? 54 : 68;
    const innerSize = compact ? 34 : 42;
    let motif = `<path d="M7 29h28v6H7z" fill="currentColor"/><path d="M8 21l13-9 13 9v4H8z" fill="currentColor" opacity=".85"/>`;
    if (/private|corporal|sergeant/.test(key)) {
      motif = `<path d="M7 29h28v6H7z" fill="currentColor"/><path d="M8 20l13-8 13 8v4H8z" fill="currentColor" opacity=".9"/><path d="M8 14l13-8 13 8v3H8z" fill="currentColor" opacity=".72"/>`;
    } else if (/lieutenant|captain|major|colonel/.test(key)) {
      motif = `<rect x="6" y="9" width="30" height="6" rx="2" fill="currentColor"/><rect x="6" y="19" width="30" height="6" rx="2" fill="currentColor" opacity=".86"/><path d="M21 30l7 6-7 6-7-6z" fill="currentColor" opacity=".8"/>`;
    } else if (/brigadier|general/.test(key)) {
      motif = `<path d="M21 5l4.8 9.8 10.8 1.6-7.8 7.6 1.8 10.8L21 30l-9.6 5.8 1.8-10.8-7.8-7.6 10.8-1.6z" fill="currentColor"/><circle cx="21" cy="18" r="4" fill="rgba(15,23,42,.28)"/>`;
    } else if (/road_legend|legend/.test(key)) {
      motif = `<path d="M21 4l11 5v11c0 8-5.6 13.4-11 16-5.4-2.6-11-8-11-16V9z" fill="currentColor"/><path d="M13 21h16v3H13z" fill="rgba(15,23,42,.34)"/><path d="M21 10l3.2 6.8 7.2 1.1-5.2 5 1.2 7.1L21 26.6l-6.4 3.4 1.2-7.1-5.2-5 7.2-1.1z" fill="rgba(255,255,255,.85)"/>`;
    }
    return `<div class="rankBadgeIconWrap ${toneClass}${compact ? ' compact' : ''}" aria-hidden="true">
      <svg viewBox="0 0 48 48" width="${size}" height="${size}" role="presentation" focusable="false">
        <defs>
          <linearGradient id="rbg-${toneClass}" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="rgba(255,255,255,.92)"/><stop offset="100%" stop-color="rgba(255,255,255,.2)"/></linearGradient>
        </defs>
        <circle cx="24" cy="24" r="21" fill="url(#rbg-${toneClass})" opacity=".26"/>
        <g transform="translate(3 3) scale(${innerSize / 42})">${motif}</g>
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

  async function fetchDriverProfile(userId) {
    const token = getCommunityToken();
    return await getJSONAuth(`/drivers/${encodeURIComponent(userId)}/profile`, token);
  }

  async function fetchDriverProfileDmThread(userId, { after = null, limit = 30 } = {}) {
    const token = getCommunityToken();
    const qs = new URLSearchParams();
    qs.set('limit', String(limit));
    if (after !== null && after !== undefined) qs.set('after', String(after));
    return await getJSONAuth(`/chat/dm/${encodeURIComponent(userId)}?${qs.toString()}`, token);
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
    progressionSyncTimer = window.setInterval(() => {
      syncMyProgression({ forcePopupCheck: true });
    }, PROGRESSION_SYNC_INTERVAL_MS);
  }

  function stopProgressionSyncInterval() {
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


  async function sendDriverProfileDm(userId, text) {
    const token = getCommunityToken();
    return await postJSON(`/chat/dm/${encodeURIComponent(userId)}`, { text }, token);
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
      if (isFresh && !isOwnMessage(msg) && !isSuppressedOutgoingDmEcho(msg)) {
        fresh.push(msg);
      }

      maxId = maxId === null ? id : Math.max(maxId, id);
    }

    chatSoundRuntime.dmLastObservedIncomingId = maxId;
    chatSoundRuntime.dmBaselineReady = true;
    return fresh;
  }

  function normalizeDriverMessages(payload) {
    const list = Array.isArray(payload) ? payload : (Array.isArray(payload?.messages) ? payload.messages : []);
    return list.slice().sort((a, b) => {
      const aid = parseDriverMsgId(a);
      const bid = parseDriverMsgId(b);
      if (aid !== null && bid !== null && aid !== bid) return aid - bid;
      return String(a?.created_at || '').localeCompare(String(b?.created_at || ''));
    });
  }

  function appendDriverProfileMessages(messages) {
    const base = Array.isArray(driverProfileState.messages) ? driverProfileState.messages : [];
    const merged = base.concat(Array.isArray(messages) ? messages : []);
    const byId = new Map();
    merged.forEach((msg) => {
      const id = parseDriverMsgId(msg);
      const key = id === null ? `${msg?.created_at || ''}:${msg?.text || ''}` : String(id);
      byId.set(key, msg);
    });
    driverProfileState.messages = normalizeDriverMessages(Array.from(byId.values()));
    let latest = null;
    driverProfileState.messages.forEach((msg) => {
      const id = parseDriverMsgId(msg);
      if (id !== null) latest = latest === null ? id : Math.max(latest, id);
    });
    driverProfileState.latestMessageId = latest;
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
    stopDriverProfileDmPolling();
    driverProfileState.open = false;
    driverProfileState.userId = null;
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

    const messages = normalizeDriverMessages(driverProfileState.messages);
    const dmHtml = messages.length
      ? messages.map((msg) => {
          const other = Number(msg?.user_id) === Number(driverProfileState.userId);
          const klass = other ? 'other' : 'me';
          return `<div class="driverProfileDmBubble ${klass}">${escapeHtml(String(msg?.text || ''))}</div>`;
        }).join('')
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
        <button class="driverProfileClose" id="driverProfileCloseBtn" type="button">Close</button>
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
        ${selfMode ? accountActionsHtml : `
          <div class="driverProfileSectionTitle">Private messages</div>
          <div class="driverProfileDmWrap">
            <div class="driverProfileDmList" id="driverProfileDmList">${dmHtml}</div>
            <div class="driverProfileComposer">
              <input class="driverProfileInput" id="driverProfileInput" type="text" placeholder="Type a private message">
              <button class="driverProfileSendBtn" id="driverProfileSendBtn" type="button" ${driverProfileState.sending ? 'disabled' : ''}>Send</button>
            </div>
          </div>
        `}
      </div>
      ${driverProfileState.error ? `<div class="driverProfileError">${escapeHtml(driverProfileState.error)}</div>` : ''}
      ${driverProfileState.status ? `<div class="driverProfileStatus">${escapeHtml(driverProfileState.status)}</div>` : ''}
    `;

    document.getElementById('driverProfileCloseBtn')?.addEventListener('click', closeDriverProfileModal);

    if (selfMode) {
      bindSelfProfileActions();
      updateDriverProfileLayout();
      return;
    }

    const input = document.getElementById('driverProfileInput');
    const sendBtn = document.getElementById('driverProfileSendBtn');
    const submit = async () => {
      if (driverProfileState.sending || !driverProfileState.userId || driverProfileState.isSelf) return;
      const text = String(input?.value || '').trim();
      if (!text) return;
      driverProfileState.sending = true;
      driverProfileState.error = '';
      renderDriverProfileModal();
      try {
        await primeChatSoundSystem('dm-send-click');
        const sent = await sendDriverProfileDm(driverProfileState.userId, text);
        rememberOutgoingDmEcho(text);
        input.value = '';
        const sentMessages = Array.isArray(sent?.messages) ? sent.messages : (sent?.message ? [sent.message] : []);
        if (sentMessages.length) {
          sentMessages.forEach(rememberOutgoingDmEcho);
          seedDriverProfileDmAudioBaseline(sentMessages);
          appendDriverProfileMessages(sentMessages);
        } else {
          const refreshed = await fetchDriverProfileDmThread(driverProfileState.userId, { limit: 30 });
          driverProfileState.messages = normalizeDriverMessages(refreshed);
          seedDriverProfileDmAudioBaseline(driverProfileState.messages);
          appendDriverProfileMessages([]);
        }
        await playChatTone('outgoing');
      } catch (err) {
        driverProfileState.error = err?.message || 'Message failed to send.';
      } finally {
        driverProfileState.sending = false;
        renderDriverProfileModal();
      }
    };
    sendBtn?.addEventListener('click', (ev) => { ev.preventDefault(); submit(); });
    input?.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        submit();
      }
    });

    const dmList = document.getElementById('driverProfileDmList');
    if (dmList) dmList.scrollTop = dmList.scrollHeight;
    updateDriverProfileLayout();
  }

  async function openDriverProfileModal({ userId, isSelf = false, source = '' } = {}) {
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
    driverProfileState.profile = null;
    driverProfileState.myProgression = null;
    driverProfileState.messages = [];
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
      if (selfMode) {
        const latestProgression = await syncMyProgression({ forcePopupCheck: false });
        if (latestProgression && driverProfileState.open && driverProfileState.userId === nextUserId) {
          driverProfileState.myProgression = latestProgression;
        }
      }
      if (!selfMode) {
        const dmRes = await fetchDriverProfileDmThread(nextUserId, { limit: 30 });
        if (!driverProfileState.open || driverProfileState.userId !== nextUserId) return;
        driverProfileState.messages = normalizeDriverMessages(dmRes);
        seedDriverProfileDmAudioBaseline(driverProfileState.messages);
        driverProfileState.dmInitialLoadComplete = true;
        appendDriverProfileMessages([]);
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
      const res = await fetchDriverProfileDmThread(driverProfileState.userId, {
        after: driverProfileState.latestMessageId,
        limit: 30
      });
      const incoming = normalizeDriverMessages(res);
      if (!incoming.length) return;
      const hasIncomingFromOther = driverProfileState.dmInitialLoadComplete
        && collectFreshIncomingDriverProfileDm(incoming).length > 0;
      appendDriverProfileMessages(incoming);
      if (hasIncomingFromOther) void playChatTone('incoming');
      renderDriverProfileModal();
    } catch (_) {}
  }

  function startDriverProfileDmPolling() {
    if (driverProfileState.isSelf) return;
    stopDriverProfileDmPolling();
    driverProfileState.pollTimer = window.setInterval(() => {
      pollDriverProfileDmOnce();
    }, DRIVER_PROFILE_DM_POLL_MS);
  }

  function stopDriverProfileDmPolling() {
    if (!driverProfileState.pollTimer) return;
    window.clearInterval(driverProfileState.pollTimer);
    driverProfileState.pollTimer = null;
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
  window.updateDriverProfileLayout = updateDriverProfileLayout;
  window.showLevelUpOverlay = showLevelUpOverlay;
  window.syncMyProgression = syncMyProgression;
  window.handlePickupProgressionDelta = handlePickupProgressionDelta;
  window.renderLeaderboardBadgeSvg = renderLeaderboardBadgeSvg;
  window.syncLeaderboardBadgeRewards = syncLeaderboardBadgeRewards;

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
    }
  });

  setInterval(() => {
    observeChatAuthState();
    maybeSyncProgressionOnSignInState();
  }, 1200);

  setInterval(() => {
    if (typeof authHeaderOK === 'function' && !authHeaderOK()) clearMapIdentityTempState();
  }, 1500);

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
})();
