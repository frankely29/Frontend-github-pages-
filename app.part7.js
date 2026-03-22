(function() {
  console.log('app.part7.js loaded');
  const runtime = window.FrontendRuntime || null;
  const runtimePolling = runtime?.polling || null;
  const chatCore = window.TlcChatCoreInternals || {};
  const chatInternals = window.TlcChatInternals || {};
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
  void runtimePolling;

  const CHAT_ROOM = typeof window !== 'undefined' && window.CHAT_ROOM ? window.CHAT_ROOM : 'global';
  const VOICE_NOTE_MAX_MS = 60000;

  const getCommunityToken = (...args) => chatCore.getCommunityToken?.(...args) || '';
  const currentChatSelfUserId = (...args) => chatCore.currentChatSelfUserId?.(...args) || '';
  const currentChatSelfDisplayName = (...args) => chatCore.currentChatSelfDisplayName?.(...args) || '';
  const normalizeChatDisplayName = (...args) => chatCore.normalizeChatDisplayName?.(...args) || '';
  const parseMessageId = (...args) => chatCore.parseMessageId?.(...args) ?? null;
  const msgUserId = (...args) => chatCore.msgUserId?.(...args) ?? null;
  const normalizeMessageType = (...args) => chatCore.normalizeMessageType?.(...args) || 'text';
  const normalizeAudioUrl = (...args) => chatCore.normalizeAudioUrl?.(...args) || '';
  const normalizeAudioDurationMs = (...args) => chatCore.normalizeAudioDurationMs?.(...args) ?? null;
  const normalizeAudioMimeType = (...args) => chatCore.normalizeAudioMimeType?.(...args) || '';
  const normalizePublicChatMessage = (...args) => chatCore.normalizePublicChatMessage?.(...args) || null;
  const normalizePrivateChatMessage = (...args) => chatCore.normalizePrivateChatMessage?.(...args) || null;
  const normalizePublicMessagesPayload = (...args) => chatCore.normalizePublicMessagesPayload?.(...args) || [];
  const normalizePrivateMessagesPayload = (...args) => chatCore.normalizePrivateMessagesPayload?.(...args) || [];
  const compareChatMessages = (...args) => chatCore.compareChatMessages?.(...args) || 0;
  const formatChatTime = (...args) => chatCore.formatChatTime?.(...args) || '';
  const isOwnMessage = (...args) => !!chatCore.isOwnMessage?.(...args);
  const isSuppressedOutgoingChatEcho = (...args) => !!chatCore.isSuppressedOutgoingChatEcho?.(...args);
  const isSuppressedOutgoingDmEcho = (...args) => !!chatCore.isSuppressedOutgoingDmEcho?.(...args);
  const renderPrivateConversationRow = (...args) => chatCore.renderPrivateConversationRow?.(...args) || '';

  function messageNumericId(msg) {
    return parseMessageId(msg?.id);
  }

  function getMessageMergeKey(msg) {
    if (msg?.id != null) return `id:${msg.id}`;
    return `fallback:${msg?.createdAt || ''}|${msg?.senderUserId || msg?.userId || ''}|${msg?.recipientUserId || ''}|${msg?.text || ''}|${msg?.audioUrl || ''}`;
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

function getSharedAudioCoordinator() {
    return window.TlcSharedAudio || null;
  }

function getSharedPlaybackAudio() {
    return getSharedAudioCoordinator()?.getAudio?.() || getSharedAudioCoordinator()?.audioEl || null;
  }

const voicePlaybackRuntime = {
    activeMessageId: null,
    activeScope: '',
    activeAudio: null,
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
    resumeRadioOnStop: true,
  };

let scheduledRadioResumeAfterVoice = 0;

function clearScheduledRadioResumeAfterVoice() {
    if (scheduledRadioResumeAfterVoice) {
      window.clearTimeout(scheduledRadioResumeAfterVoice);
      scheduledRadioResumeAfterVoice = 0;
    }
  }

function scheduleRadioResumeAfterVoice(reason = 'voice-stop') {
    clearScheduledRadioResumeAfterVoice();
    scheduledRadioResumeAfterVoice = window.setTimeout(async () => {
      scheduledRadioResumeAfterVoice = 0;
      await maybeResumeRadioAfterVoicePlayback(reason);
    }, 0);
    return scheduledRadioResumeAfterVoice;
  }

function getChatAudioSession() {
    try {
      return navigator && navigator.audioSession ? navigator.audioSession : null;
    } catch (_) {
      return null;
    }
  }

function syncVoiceRuntimeAudioRef() {
    voicePlaybackRuntime.activeAudio = getSharedPlaybackAudio();
    return voicePlaybackRuntime.activeAudio;
  }

function isChatVoiceBusy() {
    return CHAT_VOICE_BUSY_PHASES.has(String(chatVoiceState.phase || 'idle'));
  }

function isSharedRadioActive() {
    const shared = getSharedAudioCoordinator();
    return !!shared?.isRadioActive?.();
  }

function ensureChatPlaybackSession(reason = 'chat-playback') {
    return getSharedAudioCoordinator()?.setPlaybackSession?.(reason) || 'unsupported';
  }

async function maybeResumeRadioAfterVoicePlayback(reason = 'voice-playback') {
    try {
      return await getSharedAudioCoordinator()?.resumeRadioAfterVoice?.(reason);
    } catch (_) {
      return false;
    }
  }

async function maybeResumeRadioAfterVoiceCapture(reason = 'voice-capture') {
    try {
      return await getSharedAudioCoordinator()?.endRecordingCapture?.(reason);
    } catch (_) {
      return false;
    }
  }

function pauseActiveChatVoicePlayback() {
    const shared = getSharedAudioCoordinator();
    const audio = syncVoiceRuntimeAudioRef();
    const activeBlobUrl = String(voicePlaybackRuntime.activeBlobUrl || '').trim();
    const currentSrc = String(audio?.currentSrc || audio?.src || '').trim();
    const sharedOwnsVoice = shared?.owner === 'voice';
    const runtimeOwnsVoice = !!activeBlobUrl && !!currentSrc && currentSrc === activeBlobUrl;

    if (!sharedOwnsVoice && !runtimeOwnsVoice) return false;

    stopSharedVoicePlayback('capture', {
      resetPosition: false,
      clearActive: false,
      resumeRadio: false
    });
    return true;
  }

function applyChatAudioSessionAmbient(reason = 'chat') {
    if (isSharedRadioActive()) return false;
    if (isChatVoiceBusy() || isVoicePlaybackActive()) return false;
    return (getSharedAudioCoordinator()?.setAutoSession?.(reason) || 'unsupported') !== 'unsupported';
  }

async function prepareChatAudioForCapture(reason = 'voice-capture') {
    pauseActiveChatVoicePlayback();

    chatVoiceState.phase = 'preparing';
    chatVoiceState.lastError = '';

    const shared = getSharedAudioCoordinator();

    if (shared?.beginRecordingCapture) {
      try {
        await shared.beginRecordingCapture(reason || 'voice-record-start');
      } catch (_) {}
    } else if (typeof window.forcePauseRadioForVoiceCapture === 'function') {
      try {
        await window.forcePauseRadioForVoiceCapture('voice-record-start');
      } catch (_) {}
    } else {
      try {
        window.pauseRadioForVoiceCapture?.('voice-record-start');
      } catch (_) {}
    }

    await new Promise((resolve) => window.setTimeout(resolve, 220));

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

    const shared = getSharedAudioCoordinator();
    let radioResumed = false;

    if (shared?.endRecordingCapture) {
      try {
        radioResumed = !!(await shared.endRecordingCapture(reason || 'voice-record-end'));
      } catch (_) {
        radioResumed = false;
      }
    } else {
      radioResumed = await maybeResumeRadioAfterVoiceCapture('voice-record-end');
    }

    if (!radioResumed && !isSharedRadioActive()) {
      shared?.setAutoSession?.(reason || 'voice-record-end');
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

function ensureChatSoundContext() {
    if (!isChatVoiceBusy() && !isSharedRadioActive()) applyChatAudioSessionAmbient('ensure-context');
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
    if (!isSharedRadioActive()) applyChatAudioSessionAmbient(trigger);
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
    const shared = getSharedAudioCoordinator();
    const playbackBusy = !!shared?.isPlaybackBusy?.();
    if (playbackBusy || shared?.recorderLock || isChatVoiceBusy() || isVoicePlaybackActive() || Date.now() < Number(voicePlaybackRuntime.suppressTonesUntil || 0)) {
      return false;
    }
    reconcileChatSoundRuntime(`play-${kind}-start`);
    if (!isSharedRadioActive()) {
      if (kind === 'incoming') applyChatAudioSessionAmbient('incoming-tone');
      if (kind === 'outgoing') applyChatAudioSessionAmbient('outgoing-tone');
    }
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
    if (isChatVoiceBusy() || isVoicePlaybackActive() || getSharedAudioCoordinator()?.isPlaybackBusy?.()) return;
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
      document.removeEventListener(evtName, onChatSoundPrimeInteraction);
    });
    chatSoundState.primeListenersBound = false;
  }

function bindChatSoundPrimeListeners() {
    if (chatAudioReady || chatSoundState.primeListenersBound) return;
    ['pointerdown', 'touchstart', 'click', 'keydown'].forEach((evtName) => {
      document.addEventListener(evtName, onChatSoundPrimeInteraction, { passive: true });
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
        if (getSharedAudioCoordinator()?.owner === 'voice') hardStopSharedVoicePlaybackForBackground('pagehide');
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
          if (getSharedAudioCoordinator()?.owner === 'voice') hardStopSharedVoicePlaybackForBackground('hidden');
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
    const shared = getSharedAudioCoordinator();
    const activeAudio = syncVoiceRuntimeAudioRef();
    return !!((shared?.owner === 'voice' || voicePlaybackRuntime.isPlaying) && activeAudio && !activeAudio.paused && !activeAudio.ended);
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

function stopSharedVoicePlayback(reason = 'stop', { resetPosition = false, clearActive = false, resumeRadio = true } = {}) {
    const shared = getSharedAudioCoordinator();
    const audio = syncVoiceRuntimeAudioRef();
    const activeBlobUrl = String(voicePlaybackRuntime.activeBlobUrl || '').trim();
    const currentSrc = String(audio?.currentSrc || audio?.src || '').trim();
    const sharedOwnsVoice = shared?.owner === 'voice';
    const runtimeOwnsVoice = !!activeBlobUrl && !!currentSrc && currentSrc === activeBlobUrl;

    if (!sharedOwnsVoice && !runtimeOwnsVoice) return false;

    clearScheduledRadioResumeAfterVoice();
    voicePlaybackRuntime.lastPauseReason = reason;
    voicePlaybackRuntime.resumeRadioOnStop = !!resumeRadio;
    if (shared?.voiceContext) {
      voicePlaybackRuntime.activeMessageId = parseMessageId(shared.voiceContext.messageId);
      voicePlaybackRuntime.activeScope = String(shared.voiceContext.scope || voicePlaybackRuntime.activeScope || '');
      voicePlaybackRuntime.activeBlobUrl = String(shared.voiceContext.blobUrl || voicePlaybackRuntime.activeBlobUrl || '');
      voicePlaybackRuntime.activeAudioUrl = String(shared.voiceContext.audioUrl || voicePlaybackRuntime.activeAudioUrl || '');
    }
    if (sharedOwnsVoice && shared?.stopVoicePlayback) {
      void shared.stopVoicePlayback(reason, { resetPosition, clearSource: !!clearActive, resumeRadio: !!resumeRadio });
    } else if (audio) {
      try { if (!audio.paused) audio.pause(); } catch (_) {}
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
      voicePlaybackRuntime.lastUserAction = '';
    }
    syncAllVoicePlayers();
    return true;
  }

async function hardStopSharedVoicePlaybackForBackground(reason = 'background') {
    clearScheduledRadioResumeAfterVoice();
    await getSharedAudioCoordinator()?.hardStopVoiceForBackground?.(reason);
    voicePlaybackRuntime.activeMessageId = null;
    voicePlaybackRuntime.activeScope = '';
    voicePlaybackRuntime.activeBlobUrl = '';
    voicePlaybackRuntime.activeAudioUrl = '';
    voicePlaybackRuntime.currentTime = 0;
    voicePlaybackRuntime.isPlaying = false;
    voicePlaybackRuntime.isSeeking = false;
    voicePlaybackRuntime.lastUserAction = '';
    syncAllVoicePlayers();
    syncAllVoiceRecorderUis();
    return true;
  }

function hardStopSharedVoicePlaybackForRadio(reason = 'radio-start') {
    clearScheduledRadioResumeAfterVoice();
    stopSharedVoicePlayback(reason, { resetPosition: true, clearActive: true, resumeRadio: false });
    syncAllVoicePlayers();
    syncAllVoiceRecorderUis();
    return true;
  }

function revokeVoiceBlobUrls() {
    stopSharedVoicePlayback('reset', { resetPosition: true, clearActive: true, resumeRadio: false });
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
    const publicMessages = Array.isArray(chatInternals.publicChatMessages) ? chatInternals.publicChatMessages : [];
    const privateMessages = chatInternals.privateMessagesByUserId || Object.create(null);
    if (publicMessages.length) messages.push(...publicMessages);
    Object.values(privateMessages).forEach((list) => {
      if (Array.isArray(list)) messages.push(...list);
    });
    if (Array.isArray(driverProfileState?.messages)) messages.push(...driverProfileState.messages);
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
    syncVoiceRuntimeAudioRef();
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
    const activeAudio = syncVoiceRuntimeAudioRef();
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

async function startSharedVoicePlaybackForMessage(player, message) {
    const messageId = parseMessageId(message?.id);
    const scope = String(player?.dataset?.messageScope || 'public').trim();
    const audioUrl = String(message?.audioUrl || '').trim();
    const audio = syncVoiceRuntimeAudioRef();
    const alreadyActive = isVoicePlaybackMessage(messageId, scope);
    clearScheduledRadioResumeAfterVoice();
    try {
      if (alreadyActive && voicePlaybackRuntime.isPlaying) {
        voicePlaybackRuntime.lastUserAction = 'pause';
        stopSharedVoicePlayback('user', { resetPosition: false, clearActive: false, resumeRadio: false });
        return true;
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
        return false;
      }
      voicePlaybackRuntime.activeMessageId = messageId;
      voicePlaybackRuntime.activeScope = scope;
      voicePlaybackRuntime.activeBlobUrl = blobUrl;
      voicePlaybackRuntime.activeAudioUrl = audioUrl;
      voicePlaybackRuntime.lastPauseReason = 'play';
      voicePlaybackRuntime.lastUserAction = `message:${messageId}`;
      const started = await getSharedAudioCoordinator()?.startVoicePlayback?.({
        src: blobUrl,
        messageId,
        scope,
        audioUrl,
        blobUrl,
      });
      syncAllVoicePlayers();
      syncAllVoiceRecorderUis();
      return !!started;
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
      return false;
    }
  }

function bindSharedVoicePlaybackEvents() {
    if (voicePlaybackRuntime.eventsBound) return;
    const audio = syncVoiceRuntimeAudioRef();
    if (!audio) return;
    voicePlaybackRuntime.eventsBound = true;
    audio.addEventListener('play', () => {
      const shared = getSharedAudioCoordinator();
      if (shared?.owner !== 'voice') return;
      clearScheduledRadioResumeAfterVoice();
      voicePlaybackRuntime.isPlaying = true;
      voicePlaybackRuntime.currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
      voicePlaybackRuntime.activeBlobUrl = String(shared?.voiceContext?.blobUrl || audio.currentSrc || audio.src || voicePlaybackRuntime.activeBlobUrl || '').trim();
      voicePlaybackRuntime.activeAudioUrl = String(shared?.voiceContext?.audioUrl || voicePlaybackRuntime.activeAudioUrl || '').trim();
      voicePlaybackRuntime.activeMessageId = parseMessageId(shared?.voiceContext?.messageId ?? voicePlaybackRuntime.activeMessageId);
      voicePlaybackRuntime.activeScope = String(shared?.voiceContext?.scope || voicePlaybackRuntime.activeScope || '');
      voicePlaybackRuntime.suppressTonesUntil = Date.now() + 250;
      syncAllVoicePlayers();
      syncAllVoiceRecorderUis();
    });
    audio.addEventListener('pause', () => {
      const shared = getSharedAudioCoordinator();
      voicePlaybackRuntime.currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : voicePlaybackRuntime.currentTime;
      voicePlaybackRuntime.isPlaying = false;
      if (shared?.owner === 'voice') {
        syncAllVoicePlayers();
        syncAllVoiceRecorderUis();
      }
      void flushPendingChatTones();
    });
    audio.addEventListener('ended', () => {
      voicePlaybackRuntime.isPlaying = false;
      voicePlaybackRuntime.currentTime = 0;
      voicePlaybackRuntime.lastPauseReason = 'ended';
      syncAllVoicePlayers();
      syncAllVoiceRecorderUis();
      void flushPendingChatTones();
    });
    audio.addEventListener('timeupdate', () => {
      const shared = getSharedAudioCoordinator();
      if (shared?.owner !== 'voice') return;
      voicePlaybackRuntime.currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : voicePlaybackRuntime.currentTime;
      const players = getRenderedVoicePlayers(voicePlaybackRuntime.activeMessageId, voicePlaybackRuntime.activeScope);
      players.forEach((player) => syncVoicePlayerUi(player));
    });
    audio.addEventListener('loadedmetadata', () => syncAllVoicePlayers());
    audio.addEventListener('waiting', () => syncAllVoicePlayers());
    audio.addEventListener('stalled', () => syncAllVoicePlayers());
    audio.addEventListener('seeking', () => {
      voicePlaybackRuntime.isSeeking = true;
    });
    audio.addEventListener('seeked', () => {
      voicePlaybackRuntime.isSeeking = false;
      syncAllVoicePlayers();
    });
    audio.addEventListener('error', () => {
      const shared = getSharedAudioCoordinator();
      if (shared?.owner !== 'voice' && !voicePlaybackRuntime.activeAudioUrl) return;
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
    const audio = syncVoiceRuntimeAudioRef();
    if (chatVoiceDraftState.objectUrl && String(audio?.currentSrc || audio?.src || '') === chatVoiceDraftState.objectUrl) {
      stopSharedVoicePlayback('draft-clear', { resetPosition: true, clearActive: true, resumeRadio: false });
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
      const draftAudio = syncVoiceRuntimeAudioRef();
      const previewPlaying = !!(draft?.objectUrl && voicePlaybackRuntime.lastUserAction === `draft:${stateScope}` && !draftAudio?.paused && String(draftAudio?.currentSrc || draftAudio?.src || '') === draft.objectUrl);
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
    const audio = syncVoiceRuntimeAudioRef();
    if (!draft?.objectUrl || !audio) return false;
    clearScheduledRadioResumeAfterVoice();
    try {
      if (voicePlaybackRuntime.lastUserAction === `draft:${normalizedScope}` && !audio.paused && String(audio.currentSrc || audio.src || '') === draft.objectUrl) {
        voicePlaybackRuntime.lastPauseReason = 'user';
        stopSharedVoicePlayback('user', { resetPosition: false, clearActive: false, resumeRadio: false });
        if (button) button.dataset.previewPlaying = '0';
        syncVoiceRecorderUi(scope);
        return true;
      }
      stopSharedVoicePlayback('preview-switch', { resetPosition: true, clearActive: true, resumeRadio: false });
      voicePlaybackRuntime.activeMessageId = `draft:${normalizedScope}`;
      voicePlaybackRuntime.activeScope = normalizedScope;
      voicePlaybackRuntime.activeBlobUrl = draft.objectUrl;
      voicePlaybackRuntime.activeAudioUrl = draft.objectUrl;
      voicePlaybackRuntime.lastUserAction = `draft:${normalizedScope}`;
      const started = await getSharedAudioCoordinator()?.startVoicePlayback?.({
        src: draft.objectUrl,
        messageId: `draft:${normalizedScope}`,
        scope: normalizedScope,
        audioUrl: draft.objectUrl,
        blobUrl: draft.objectUrl,
      });
      if (button) button.dataset.previewPlaying = started ? '1' : '0';
      syncVoiceRecorderUi(scope);
      return !!started;
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

  async function testChatIncomingSound() {
    await primeChatSoundSystem('manual-test-incoming');
    return playChatTone('incoming');
  }

  async function testChatOutgoingSound() {
    await primeChatSoundSystem('manual-test-outgoing');
    return playChatTone('outgoing');
  }

  function getChatSoundDebugState() {
    return {
      userPrimed: chatSoundRuntime.userPrimed,
      htmlAudioReady: chatSoundRuntime.htmlAudioReady,
      webAudioReady: chatSoundRuntime.webAudioReady,
      ctxState: chatAudioCtx ? chatAudioCtx.state : null,
      pendingIncoming: chatSoundRuntime.pendingIncoming,
      pendingOutgoing: chatSoundRuntime.pendingOutgoing,
      lastObservedIncomingId: chatSoundRuntime.lastObservedIncomingId
    };
  }

  function getChatAudioLifecycleDebug() {
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
  }

  function getChatAudioDebugState() {
    let audioSessionType = null;
    const shared = getSharedAudioCoordinator();
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
      sharedOwner: shared?.owner || 'idle',
      sharedPlaybackBusy: !!shared?.isPlaybackBusy?.(),
      recorderLock: !!shared?.recorderLock,
      voiceContextMessageId: shared?.voiceContext?.messageId ?? null,
      tonesSuppressed: !!(shared?.isPlaybackBusy?.() || shared?.recorderLock || Date.now() < Number(voicePlaybackRuntime.suppressTonesUntil || 0)),
      recentOutgoingChatEchoes: window.TlcChatRecentOutgoingEchoes?.size || 0,
      recentOutgoingDmEchoes: recentOutgoingDmEchoes.size,
    };
  }

  window.TlcChatVoiceModule = {
    primeChatSoundSystem,
    primeChatAudio,
    playChatTone,
    bindVoiceComposerControls,
    bindVoicePlayers,
    renderVoiceNotePlayer,
    prefetchVoiceBlobUrls,
    preserveVoicePlaybackAcrossRender,
    sendChatVoiceDraft,
    hasChatVoiceDraft,
    cancelChatVoiceRecording,
    syncVoiceComposerSendButton,
    clearVoiceAssetsForMessages,
    pruneVoiceAssetCache,
    stopSharedVoicePlayback,
    hardStopSharedVoicePlaybackForBackground,
    hardStopSharedVoicePlaybackForRadio,
    syncAllVoicePlayers,
    syncAllVoiceRecorderUis,
    buildVoiceComposer,
    seedChatIncomingAudioBaseline,
    collectFreshIncomingMessagesForAudio,
    testChatIncomingSound,
    testChatOutgoingSound,
    getChatSoundDebugState,
    getChatAudioLifecycleDebug,
    getChatAudioDebugState,
    getVoiceMessageDomKey,
    escapeCssValue,
    isChatVoiceBusy,
    getVoiceRecorderState,
    chatVoiceState,
    chatVoiceDraftState,
    voiceAssetCache,
    voicePlaybackRuntime,
    chatSoundRuntime,
    chatSoundState,
  };

  window.pauseSharedVoicePlaybackForRadio = function pauseSharedVoicePlaybackForRadio(reason = 'radio-start') {
    return hardStopSharedVoicePlaybackForRadio(reason);
  };
  window.testChatIncomingSound = testChatIncomingSound;
  window.testChatOutgoingSound = testChatOutgoingSound;
  window.getChatSoundDebugState = getChatSoundDebugState;
  window.getChatAudioLifecycleDebug = getChatAudioLifecycleDebug;
  window.getChatAudioDebugState = getChatAudioDebugState;

  attachChatSoundStateHandlers();
  resetChatSoundLifecycle('module-init');
  reconcileChatSoundRuntime('module-init');
  bindChatSoundPrimeListeners();
  bindSharedVoicePlaybackEvents();
})();
