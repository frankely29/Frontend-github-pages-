/*
 * app.part8.js
 *
 * Chat core module extracted from app.part2.js.
 */
(function() {
  console.log('app.part8.js loaded');
  const runtime = window.FrontendRuntime || null;
  const runtimePolling = runtime?.polling || null;
  const runtimePerf = runtime?.perf || null;

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
    const absolutePath = runtime?.toAbsoluteUrl
      ? runtime.toAbsoluteUrl(path)
      : `${String(typeof RAILWAY_BASE !== 'undefined' ? RAILWAY_BASE : (window?.API_BASE || '') || '').trim()}${path}`;
    return fetchJSON(absolutePath, {
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

const VOICE_BLOB_FETCH_RETRY_DELAYS_MS = [0, 350, 900, 1800];

const CHAT_VOICE_IDLE_STATUS = 'Hold mic to record (max 2:00)';

const CHAT_VOICE_MAX_REACHED_STATUS = '2:00 max reached. Tap Send or Cancel.';

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

const chatVoiceGestureState = {
    active: false,
    locked: false,
    scope: '',
    pointerId: null,
    captureEl: null,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0,
    cancelThresholdPx: 96,
    lockThresholdPx: 78,
    canceled: false,
    sentOnRelease: false,
    sessionId: 0,
    suppressClickUntil: 0,
    autoSendScope: '',
    autoSendOptions: null,
    holdingStartedAt: 0,
  };

const chatVoiceComposerMode = {
    public: 'idle',
    private: 'idle',
    'profile-dm': 'idle',
  };

const voiceAssetCache = new Map();
const imageAssetCache = new Map();

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
let lastChatVoiceDrawerStateKey = '';

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

function setChatAudioSessionType(type) {
    const nextType = String(type || '').trim();
    if (!nextType) return false;
    try {
      const session = navigator && navigator.audioSession ? navigator.audioSession : null;
      if (!session) return false;
      if (session.type !== nextType) session.type = nextType;
      return session.type === nextType;
    } catch (_) {
      return false;
    }
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

    try {
      if (!setChatAudioSessionType('play-and-record')) {
        setChatAudioSessionType('auto');
      }
    } catch (_) {}

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
    return '';
  }

function renderVoiceActiveStrip(surface, mode, data = {}) {
    const strip = document.getElementById(`${surface}VoiceActiveStrip`);
    if (!strip) return null;
    if (mode === 'none') {
      strip.innerHTML = '';
      strip.classList.remove('recording', 'draft', 'holding', 'chatVoiceHoldingStrip', 'chatVoiceLockedStrip', 'chatVoiceDraftStrip', 'chatVoiceLockedInline', 'chatVoiceReviewInline', 'chatVoiceReviewStrip');
      strip.hidden = true;
      return strip;
    }
    if (mode === 'holding') {
      const timerText = String(data.timerText || '0:00');
      const cancelProgress = Math.max(0, Math.min(1, Number(data.cancelProgress || 0)));
      const lockProgress = Math.max(0, Math.min(1, Number(data.lockProgress || 0)));
      strip.classList.add('recording', 'holding', 'chatVoiceHoldingStrip');
      strip.classList.remove('draft', 'chatVoiceLockedInline', 'chatVoiceReviewInline', 'chatVoiceReviewStrip');
      strip.hidden = false;
      strip.style.setProperty('--voice-hold-cancel-progress', String(cancelProgress.toFixed(3)));
      strip.innerHTML = `
        <div class="chatVoiceHoldingTimer chatVoiceRecordTimer" data-voice-record-timer="1">${escapeHtml(timerText)}</div>
        <div class="chatVoiceHoldingHint"><span class="chatVoiceHoldingArrow" aria-hidden="true">←</span> slide to cancel</div>
        <div class="chatVoiceLockRail" aria-hidden="true">
          <div class="chatVoiceLockThumb" style="--voice-lock-progress:${lockProgress.toFixed(3)};">
            <span class="chatVoiceLockIcon">🔒</span>
          </div>
        </div>
      `;
      return strip;
    }
    if (mode === 'locked') {
      const timerText = String(data.timerText || '0:00');
      const isStopping = !!data.isStopping;
      strip.classList.add('recording', 'chatVoiceLockedInline');
      strip.classList.remove('draft', 'holding', 'chatVoiceHoldingStrip', 'chatVoiceReviewInline', 'chatVoiceReviewStrip');
      strip.hidden = false;
      strip.innerHTML = `
        <div class="chatVoiceRecordTimer" data-voice-record-timer="1">${escapeHtml(timerText)}</div>
        <button class="chatVoiceInlineBtn" id="${surface}VoiceCancelBtn" type="button" aria-label="Delete voice note" data-chat-voice-trigger="1"${isStopping ? ' disabled' : ''}>Delete</button>
        <button class="chatVoiceInlineBtn recording" id="${surface}VoiceStopBtn" type="button" aria-label="Stop voice note" data-chat-voice-trigger="1"${isStopping ? ' disabled' : ''}>Stop</button>
      `;
      return strip;
    }
    if (mode === 'draft') {
      const timerText = String(data.timerText || '0:00');
      const isSending = !!data.isSending;
      const previewPlaying = !!data.previewPlaying;
      strip.classList.add('draft', 'chatVoiceReviewInline', 'chatVoiceReviewStrip');
      strip.classList.remove('recording', 'chatVoiceLockedInline', 'holding', 'chatVoiceHoldingStrip');
      strip.hidden = false;
      strip.innerHTML = `
        <button class="chatVoiceInlineBtn" id="${surface}VoiceDraftPreviewBtn" type="button" data-chat-voice-trigger="1"${isSending ? ' disabled' : ''}>${previewPlaying ? 'Pause' : 'Play'}</button>
        <div class="chatVoiceInlineWave" aria-hidden="true"></div>
        <div class="chatVoiceDraftMetaCompact" id="${surface}VoiceDraftDuration">${escapeHtml(timerText)}</div>
        <button class="chatVoiceInlineBtn" id="${surface}VoiceDraftCancelBtn" type="button" data-chat-voice-trigger="1"${isSending ? ' disabled' : ''}>Delete</button>
        <button class="chatVoiceInlineBtn send" id="${surface}VoiceDraftSendBtn" type="button" data-chat-voice-trigger="1"${isSending ? ' disabled' : ''}>Send</button>
      `;
      return strip;
    }
    if (mode === 'uploading') {
      strip.classList.remove('recording', 'holding', 'chatVoiceHoldingStrip', 'chatVoiceLockedInline', 'chatVoiceReviewInline', 'chatVoiceReviewStrip');
      strip.classList.add('draft', 'chatVoiceReviewInline', 'chatVoiceReviewStrip');
      strip.hidden = false;
      strip.innerHTML = `
        <div class="chatVoiceInlineWave" aria-hidden="true"></div>
        <div class="chatVoiceDraftMetaCompact">Uploading…</div>
      `;
      return strip;
    }
    if (mode === 'error') {
      const message = String(data.message || 'Voice recording failed.');
      strip.classList.remove('recording', 'holding', 'chatVoiceHoldingStrip', 'chatVoiceLockedInline');
      strip.classList.add('draft', 'chatVoiceReviewInline', 'chatVoiceReviewStrip');
      strip.hidden = false;
      strip.innerHTML = `
        <div class="chatVoiceError">${escapeHtml(message)}</div>
        <button class="chatVoiceInlineBtn" id="${surface}VoiceErrorDismissBtn" type="button" data-chat-voice-trigger="1">Dismiss</button>
      `;
      return strip;
    }
    return strip;
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

function getImageAssetCacheKey(message) {
    const messageId = parseMessageId(message?.id);
    const imageUrl = String(message?.imageUrl || '').trim();
    return `${messageId === null ? 'unknown' : messageId}::${imageUrl}`;
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

function isChatImageRendered(messageId, imageUrl = '') {
    if (messageId === null || messageId === undefined || messageId === '') return false;
    const selector = `[data-chat-image="1"][data-message-id="${String(messageId)}"]`;
    const nodes = document.querySelectorAll?.(selector);
    if (!nodes || !nodes.length) return false;
    if (!imageUrl) return true;
    return Array.from(nodes).some((node) => String(node?.dataset?.imageUrl || '').trim() === String(imageUrl).trim());
  }

function releaseImageBlobUrl(messageId, imageUrl = '') {
    const targetId = parseMessageId(messageId);
    if (targetId === null) return;
    for (const [key, entry] of imageAssetCache.entries()) {
      if (!key.startsWith(`${targetId}::`)) continue;
      const sourceImageUrl = String(key.split('::').slice(1).join('::') || '').trim();
      if (imageUrl && sourceImageUrl !== String(imageUrl).trim()) continue;
      if (isChatImageRendered(targetId, sourceImageUrl)) continue;
      const blobUrl = String(entry?.blobUrl || '').trim();
      if (blobUrl) {
        try { URL.revokeObjectURL(blobUrl); } catch (_) {}
      }
      imageAssetCache.delete(key);
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

function shouldReuseImageRow(row, message, scope = 'public') {
    if (!row || !message) return false;
    if (!messageHasImage(message)) return false;
    return String(row.dataset.messageKey || '') === String(getVoiceMessageDomKey(message) || '')
      && String(row.dataset.messageId || '') === String(message?.id ?? '')
      && String(row.dataset.messageScope || '') === String(scope || '')
      && String(row.dataset.imageUrl || '').trim() === String(message?.imageUrl || '').trim();
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

function revokeImageBlobUrls() {
    for (const entry of imageAssetCache.values()) {
      const blobUrl = String(entry?.blobUrl || '').trim();
      if (blobUrl) {
        try { URL.revokeObjectURL(blobUrl); } catch (_) {}
      }
    }
    imageAssetCache.clear();
  }

function collectTrackedVoiceMessages() {
    const messages = [];
    const publicMessages = Array.isArray(publicChatMessages) ? publicChatMessages : [];
    const privateMessages = privateMessagesByUserId || Object.create(null);

    if (publicMessages.length) messages.push(...publicMessages);

    Object.values(privateMessages).forEach((list) => {
      if (Array.isArray(list)) messages.push(...list);
    });

    if (Array.isArray(driverProfileState?.messages)) {
      messages.push(...driverProfileState.messages);
    }

    return messages.filter((msg) => normalizeMessageType(msg?.messageType, msg?.audioUrl ? 'voice' : 'text') === 'voice');
  }

function collectTrackedImageMessages() {
    const messages = [];
    const publicMessages = Array.isArray(publicChatMessages) ? publicChatMessages : [];
    const privateMessages = privateMessagesByUserId || Object.create(null);

    if (publicMessages.length) messages.push(...publicMessages);

    Object.values(privateMessages).forEach((list) => {
      if (Array.isArray(list)) messages.push(...list);
    });

    if (Array.isArray(driverProfileState?.messages)) {
      messages.push(...driverProfileState.messages);
    }

    if (Array.isArray(publicPhotoItems)) messages.push(...publicPhotoItems);
    Object.values(privatePhotoItemsByUserId || {}).forEach((list) => {
      if (Array.isArray(list)) messages.push(...list);
    });

    return messages.filter((msg) => messageHasImage(msg));
  }

function pruneImageAssetCache(messages = collectTrackedImageMessages()) {
    const activeKeys = new Set((messages || [])
      .map((message) => getImageAssetCacheKey(message))
      .filter((key) => !key.endsWith('::')));
    for (const [key, entry] of imageAssetCache.entries()) {
      if (activeKeys.has(key)) continue;
      const messageId = parseMessageId(key.split('::')[0]);
      if (messageId !== null) releaseImageBlobUrl(messageId);
      else if (entry?.blobUrl) {
        try { URL.revokeObjectURL(entry.blobUrl); } catch (_) {}
        imageAssetCache.delete(key);
      }
    }
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

function waitVoiceBlobRetryDelay(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, Math.max(0, Number(ms) || 0));
    });
  }

function waitImageBlobRetryDelay(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, Math.max(0, Number(ms) || 0));
    });
  }

const INLINE_IMAGE_ERROR_RETRY_COOLDOWN_MS = 2500;

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
        cache: 'no-store',
      });

      if (!response.ok) {
        throw new Error(`Voice fetch failed (${response.status})`);
      }

      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);

      const next = {
        status: 'ready',
        blobUrl,
        mimeType: blob.type || String(message?.audioMimeType || '').trim(),
        error: '',
      };

      const previous = voiceAssetCache.get(key);
      if (
        previous?.blobUrl &&
        previous.blobUrl !== blobUrl &&
        previous.blobUrl !== voicePlaybackRuntime.activeBlobUrl
      ) {
        try { URL.revokeObjectURL(previous.blobUrl); } catch (_) {}
      }

      voiceAssetCache.set(key, next);
      refreshVoicePlayersForMessage(message);
      return blobUrl;
    } catch (error) {
      console.warn('voice blob fetch failed', { message, error, attempt });

      const nextAttempt = Number(attempt) + 1;
      if (nextAttempt < VOICE_BLOB_FETCH_RETRY_DELAYS_MS.length) {
        voiceAssetCache.delete(key);
        await waitVoiceBlobRetryDelay(VOICE_BLOB_FETCH_RETRY_DELAYS_MS[nextAttempt]);
        return ensureVoiceBlobUrl(message, nextAttempt);
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

async function ensureImageBlobUrl(message, attempt = 0) {
  const imageUrl = String(message?.imageUrl || '').trim();
  const key = getImageAssetCacheKey(message);

  if (!imageUrl) {
    imageAssetCache.set(key, {
      status: 'error',
      blobUrl: '',
      mimeType: String(message?.imageMimeType || '').trim(),
      error: 'Photo unavailable',
      errorAt: Date.now(),
    });
    return '';
  }

  const cached = imageAssetCache.get(key);
  if (cached?.status === 'ready' && cached.blobUrl) return cached.blobUrl;
  if (cached?.status === 'loading' && cached.promise) return cached.promise;

  const token = getCommunityToken();

  const promise = (async () => {
    try {
      const headers = new Headers();
      if (token) headers.set('Authorization', `Bearer ${token}`);

      const response = await fetch(imageUrl, {
        method: 'GET',
        headers,
        cache: 'no-store',
      });

      if (!response.ok) throw new Error(`Image fetch failed (${response.status})`);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);

      const next = {
        status: 'ready',
        blobUrl,
        mimeType: blob.type || String(message?.imageMimeType || '').trim(),
        error: '',
      };
      const previous = imageAssetCache.get(key);
      if (previous?.blobUrl && previous.blobUrl !== blobUrl) {
        try { URL.revokeObjectURL(previous.blobUrl); } catch (_) {}
      }
      imageAssetCache.set(key, next);
      return blobUrl;
    } catch (_) {
      const nextAttempt = Number(attempt) + 1;
      if (nextAttempt < 2) {
        imageAssetCache.delete(key);
        await waitImageBlobRetryDelay(250);
        return ensureImageBlobUrl(message, nextAttempt);
      }
      imageAssetCache.set(key, {
        status: 'error',
        blobUrl: '',
        mimeType: String(message?.imageMimeType || '').trim(),
        error: 'Photo unavailable',
        errorAt: Date.now(),
      });
      return '';
    }
  })();

  imageAssetCache.set(key, {
    status: 'loading',
    blobUrl: '',
    mimeType: String(message?.imageMimeType || '').trim(),
    error: '',
    promise,
  });
  return promise;
}

function captureChatScrollAnchor(listEl) {
  if (!listEl) return null;
  return {
    previousScrollTop: listEl.scrollTop,
    previousScrollHeight: listEl.scrollHeight,
    nearBottom: isChatNearBottom(listEl, 80),
  };
}

function restoreChatScrollAnchor(listEl, anchor) {
  if (!listEl || !anchor) return;
  if (anchor.nearBottom) {
    listEl.scrollTop = listEl.scrollHeight;
    return;
  }
  const delta = listEl.scrollHeight - Number(anchor.previousScrollHeight || 0);
  listEl.scrollTop = Number(anchor.previousScrollTop || 0) + delta;
}

function afterChatImageLayout(callback) {
  if (typeof callback !== 'function') return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      callback();
    });
  });
}

function syncChatImageNode(imgEl, message) {
  if (!imgEl || !message) return;
  const key = getImageAssetCacheKey(message);
  const fallbackEl = imgEl.closest('.chatImageCard')?.querySelector('.chatImageFallback') || null;
  const listEl = imgEl.closest('.chatList');
  imgEl.dataset.imageCacheKey = key;

  const applyError = () => {
    const anchor = captureChatScrollAnchor(listEl);
    imgEl.removeAttribute('src');
    imgEl.removeAttribute('data-resolved-image-src');
    imgEl.dataset.imageResolved = '0';
    imgEl.style.display = fallbackEl ? 'none' : '';
    if (fallbackEl) fallbackEl.classList.remove('hidden');
    afterChatImageLayout(() => restoreChatScrollAnchor(listEl, anchor));
  };
  const applyReady = (blobUrl) => {
    const anchor = captureChatScrollAnchor(listEl);
    if (!blobUrl) {
      applyError();
      return;
    }
    imgEl.src = blobUrl;
    imgEl.dataset.resolvedImageSrc = blobUrl;
    imgEl.dataset.imageResolved = '1';
    imgEl.style.display = '';
    if (fallbackEl) fallbackEl.classList.add('hidden');
    afterChatImageLayout(() => restoreChatScrollAnchor(listEl, anchor));
  };

  const cached = imageAssetCache.get(key);
  if (cached?.status === 'ready' && cached.blobUrl) {
    applyReady(cached.blobUrl);
    return;
  }
  const isInlineConversationImage = !!imgEl.closest('.chatMsgRow, .chatPrivateMsgRow');
  if (cached?.status === 'error') {
    applyError();
    const now = Date.now();
    const lastRetryAt = Number(imgEl.dataset.inlineImageRetryAt || 0);
    const errorAt = Number(cached?.errorAt || 0);
    const recentlyErrored = errorAt > 0 && (now - errorAt) < INLINE_IMAGE_ERROR_RETRY_COOLDOWN_MS;
    const recentlyRetried = lastRetryAt > 0 && (now - lastRetryAt) < INLINE_IMAGE_ERROR_RETRY_COOLDOWN_MS;
    if (!isInlineConversationImage || recentlyErrored || recentlyRetried) {
      return;
    }
    imgEl.dataset.inlineImageRetryAt = String(now);
  }

  ensureImageBlobUrl(message).then((blobUrl) => {
    if (!imgEl.isConnected) return;
    if (imgEl.dataset.imageCacheKey !== key) return;
    if (!blobUrl) {
      applyError();
      return;
    }
    applyReady(blobUrl);
  }).catch(() => {
    if (!imgEl.isConnected) return;
    if (imgEl.dataset.imageCacheKey !== key) return;
    applyError();
  });
}

function bindRenderedChatImages(root = document) {
  if (!root?.querySelectorAll) return;
  root.querySelectorAll('[data-chat-image="1"]').forEach((imgEl) => {
    const message = {
      id: parseMessageId(imgEl.dataset.messageId),
      imageUrl: String(imgEl.dataset.imageUrl || '').trim(),
      imageMimeType: String(imgEl.dataset.imageMimeType || '').trim(),
      createdAt: String(imgEl.dataset.createdAt || '').trim(),
    };
    syncChatImageNode(imgEl, message);
  });
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

function emitChatVoiceDrawerStateChangedIfNeeded() {
    const voiceBusy = isChatVoiceBusy();
    const hasDraft = !!(
      hasChatVoiceDraft('public')
      || hasChatVoiceDraft('private')
      || hasChatVoiceDraft('profile-dm')
    );
    const paused = voiceBusy || hasDraft;
    const nextStateKey = [
      paused ? '1' : '0',
      String(chatVoiceState.phase || 'idle'),
      String(chatVoiceState.scope || ''),
      String(chatVoiceDraftState.status || 'idle'),
      String(chatVoiceDraftState.scope || ''),
    ].join('|');
    if (nextStateKey === lastChatVoiceDrawerStateKey) return;
    lastChatVoiceDrawerStateKey = nextStateKey;
    window.dispatchEvent(new CustomEvent('tlc-chat-voice-state-changed', {
      detail: {
        paused,
        voiceBusy,
        hasDraft,
        phase: String(chatVoiceState.phase || 'idle'),
        activeScope: String(chatVoiceState.scope || ''),
        draftStatus: String(chatVoiceDraftState.status || 'idle'),
        draftScope: String(chatVoiceDraftState.scope || ''),
      }
    }));
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

function getVoiceComposerMode(scope) {
    const key = voiceScopeStateKey(scope);
    return chatVoiceComposerMode[key] || 'idle';
  }

function setVoiceComposerMode(scope, mode) {
    const key = voiceScopeStateKey(scope);
    if (!key) return;
    const nextMode = ['idle', 'holding', 'locked', 'review', 'uploading', 'error'].includes(mode) ? mode : 'idle';
    chatVoiceComposerMode[key] = nextMode;
  }

function renderVoiceComposerSurface(scope) {
    const domKey = voiceScopeDomKey(scope);
    const mode = getVoiceComposerMode(scope);
    const composerEl = document.getElementById(`${domKey}VoiceComposer`);
    const mainRowEl = document.getElementById(`${domKey}ComposerMainRow`);
    const host = document.getElementById(`${domKey}VoiceHost`);
    if (composerEl) {
      composerEl.dataset.voiceMode = mode;
      composerEl.classList.toggle('chatComposerModeIdle', mode === 'idle');
      composerEl.classList.toggle('chatComposerModeHolding', mode === 'holding');
      composerEl.classList.toggle('chatComposerModeLocked', mode === 'locked');
      composerEl.classList.toggle('chatComposerModeReview', mode === 'review');
      composerEl.classList.toggle('chatComposerModeUploading', mode === 'uploading');
      composerEl.classList.toggle('chatComposerModeError', mode === 'error');
      composerEl.classList.toggle('chatComposerVoiceHolding', mode === 'holding');
      composerEl.classList.toggle('chatComposerVoiceLocked', mode === 'locked');
      composerEl.classList.toggle('chatComposerVoiceReview', mode === 'review' || mode === 'uploading' || mode === 'error');
    }
    if (mainRowEl) mainRowEl.hidden = mode !== 'idle';
    if (host) host.hidden = mode === 'idle';
  }

function syncVoiceRecorderUi(scope) {
    const domKey = voiceScopeDomKey(scope);
    const stateScope = voiceScopeStateKey(scope);
    const isActive = !!stateScope && chatVoiceState.scope === stateScope;
    const phase = String(chatVoiceState.phase || 'idle');
    const isRecording = isActive && phase === 'recording';
    const isBusyRow = isActive && (phase === 'recording' || phase === 'stopping' || phase === 'requesting' || phase === 'preparing');
    const isStopping = isActive && phase === 'stopping';
    const isHoldingGesture = isRecording && chatVoiceGestureState.active && chatVoiceGestureState.scope === stateScope && !chatVoiceGestureState.locked;
    const isLockedRecording = isRecording && chatVoiceGestureState.locked && chatVoiceGestureState.scope === stateScope;
    const draft = getChatVoiceDraft(scope);
    const isDraftReady = !!draft && draft.status === 'ready';
    const isDraftSending = !!draft && draft.status === 'sending';
    const startBtn = document.getElementById(`${domKey}VoiceStartBtn`);
    const timerEl = document.getElementById(`${domKey}VoiceTimer`);
    const uploadEl = document.getElementById(`${domKey}VoiceUpload`);
    const statusEl = document.getElementById(`${domKey}VoiceStatus`);
    const errorEl = document.getElementById(`${domKey}VoiceError`);
    const activeStrip = document.getElementById(`${domKey}VoiceActiveStrip`);
    const statusVisible = isDraftSending;
    const canStart = !isBusyRow && !isDraftSending;
    const hasError = !!String((draft?.error || (isActive ? chatVoiceState.errorText : '')) || '').trim();
    let mode = 'idle';
    if (isHoldingGesture) mode = 'holding';
    else if (isLockedRecording) mode = 'locked';
    else if (isDraftSending) mode = 'uploading';
    else if (isDraftReady) mode = 'review';
    else if (hasError) mode = 'error';
    setVoiceComposerMode(scope, mode);
    renderVoiceComposerSurface(scope);
    if (startBtn) {
      startBtn.hidden = mode !== 'idle';
      startBtn.disabled = !canStart;
      startBtn.classList.toggle('busy', !canStart && !isDraftReady);
      startBtn.classList.toggle('recording', isRecording || isLockedRecording);
      startBtn.textContent = '🎤';
    }
    const timerText = isRecording
      ? formatChatVoiceDuration(chatVoiceState.durationMs)
      : (isDraftReady || isDraftSending ? formatChatVoiceDuration(draft?.durationMs || 0) : '0:00');
    if (timerEl) timerEl.textContent = timerText;
    document.querySelectorAll(`[data-voice-surface="${domKey}"] [data-voice-record-timer]`).forEach((el) => {
      el.textContent = timerText;
    });
    if (uploadEl) {
      uploadEl.hidden = !isDraftSending;
      uploadEl.textContent = isDraftSending ? 'Uploading voice note…' : '';
    }
    if (statusEl) {
      if (isBusyRow) statusEl.textContent = 'Recording voice note…';
      else if (isDraftSending) statusEl.textContent = 'Uploading voice note…';
      else if (isDraftReady) statusEl.textContent = String(chatVoiceState.statusText || 'Voice note ready. Tap Send to send the voice note.').trim() || 'Voice note ready. Tap Send to send the voice note.';
      else if (!statusEl.textContent.trim()) statusEl.textContent = CHAT_VOICE_IDLE_STATUS;
      statusEl.hidden = !statusVisible;
    }
    if (errorEl) {
      const nextError = String((draft?.error || (isActive ? chatVoiceState.errorText : '')) || '').trim();
      errorEl.textContent = nextError;
      errorEl.hidden = !nextError;
    }
    if (activeStrip) {
      if (mode === 'holding') {
        const deltaX = Number(chatVoiceGestureState.currentX || 0) - Number(chatVoiceGestureState.startX || 0);
        const deltaY = Number(chatVoiceGestureState.currentY || 0) - Number(chatVoiceGestureState.startY || 0);
        const cancelProgress = Math.abs(Math.min(0, deltaX)) / Math.max(1, Number(chatVoiceGestureState.cancelThresholdPx || 96));
        const lockProgress = Math.abs(Math.min(0, deltaY)) / Math.max(1, Number(chatVoiceGestureState.lockThresholdPx || 78));
        renderVoiceActiveStrip(domKey, 'holding', {
          timerText,
          cancelProgress,
          lockProgress,
        });
      } else if (mode === 'locked') {
        renderVoiceActiveStrip(domKey, 'locked', {
          timerText,
          isStopping,
        });
      } else if (mode === 'review') {
        const draftAudio = syncVoiceRuntimeAudioRef();
        const previewPlaying = !!(draft?.objectUrl && voicePlaybackRuntime.lastUserAction === `draft:${stateScope}` && !draftAudio?.paused && String(draftAudio?.currentSrc || draftAudio?.src || '') === draft.objectUrl);
        renderVoiceActiveStrip(domKey, 'draft', {
          timerText: formatChatVoiceDuration(draft?.durationMs || 0),
          isSending: isDraftSending,
          previewPlaying,
        });
        const draftPreviewBtn = document.getElementById(`${domKey}VoiceDraftPreviewBtn`);
        if (draftPreviewBtn) {
          draftPreviewBtn.dataset.previewPlaying = previewPlaying ? '1' : '0';
          draftPreviewBtn.disabled = !draft?.objectUrl || isDraftSending;
        }
        const draftSendBtn = document.getElementById(`${domKey}VoiceDraftSendBtn`);
        if (draftSendBtn) draftSendBtn.disabled = !isDraftReady || isDraftSending;
      } else if (mode === 'uploading') {
        renderVoiceActiveStrip(domKey, 'uploading');
      } else if (mode === 'error') {
        renderVoiceActiveStrip(domKey, 'error', { message: draft?.error || (isActive ? chatVoiceState.errorText : '') });
      } else {
        renderVoiceActiveStrip(domKey, 'none');
      }
    }
    syncVoiceComposerTextLock(scope);
    syncVoiceComposerSendButton(scope);
  }

function resetVoiceGestureState() {
    chatVoiceGestureState.active = false;
    chatVoiceGestureState.locked = false;
    chatVoiceGestureState.scope = '';
    chatVoiceGestureState.pointerId = null;
    chatVoiceGestureState.captureEl = null;
    chatVoiceGestureState.startX = 0;
    chatVoiceGestureState.startY = 0;
    chatVoiceGestureState.currentX = 0;
    chatVoiceGestureState.currentY = 0;
    chatVoiceGestureState.canceled = false;
    chatVoiceGestureState.sentOnRelease = false;
    chatVoiceGestureState.autoSendScope = '';
    chatVoiceGestureState.autoSendOptions = null;
    chatVoiceGestureState.holdingStartedAt = 0;
  }

function beginVoiceGesture(scope, pointerEvent, options = {}) {
    const stateScope = voiceScopeStateKey(scope);
    if (!stateScope) return false;
    chatVoiceGestureState.active = true;
    chatVoiceGestureState.locked = false;
    chatVoiceGestureState.scope = stateScope;
    chatVoiceGestureState.pointerId = pointerEvent?.pointerId ?? null;
    chatVoiceGestureState.captureEl = pointerEvent?.captureEl || null;
    chatVoiceGestureState.startX = Number(pointerEvent?.clientX || 0);
    chatVoiceGestureState.startY = Number(pointerEvent?.clientY || 0);
    chatVoiceGestureState.currentX = chatVoiceGestureState.startX;
    chatVoiceGestureState.currentY = chatVoiceGestureState.startY;
    chatVoiceGestureState.canceled = false;
    chatVoiceGestureState.sentOnRelease = false;
    chatVoiceGestureState.sessionId = Number(chatVoiceGestureState.sessionId || 0) + 1;
    chatVoiceGestureState.autoSendScope = stateScope;
    chatVoiceGestureState.autoSendOptions = options || {};
    chatVoiceGestureState.holdingStartedAt = Date.now();
    return true;
  }

function releaseVoiceGestureCapture(pointerId = null) {
    const captureEl = chatVoiceGestureState.captureEl;
    if (!captureEl || typeof captureEl.releasePointerCapture !== 'function') return;
    const activePointerId = pointerId ?? chatVoiceGestureState.pointerId;
    if (activePointerId == null || activePointerId === 'touch') return;
    try { captureEl.releasePointerCapture(activePointerId); } catch (_) {}
  }

async function cancelVoiceGestureRecording(reason = 'Recording canceled') {
    const activeScope = chatVoiceGestureState.scope || chatVoiceState.scope;
    chatVoiceGestureState.canceled = true;
    releaseVoiceGestureCapture();
    await cancelChatVoiceRecording(reason);
    resetVoiceGestureState();
  }

function updateVoiceGesture(pointerEvent) {
    if (!chatVoiceGestureState.active || chatVoiceGestureState.locked) return;
    chatVoiceGestureState.currentX = Number(pointerEvent?.clientX || chatVoiceGestureState.currentX || 0);
    chatVoiceGestureState.currentY = Number(pointerEvent?.clientY || chatVoiceGestureState.currentY || 0);
    const deltaX = chatVoiceGestureState.currentX - chatVoiceGestureState.startX;
    const deltaY = chatVoiceGestureState.currentY - chatVoiceGestureState.startY;
    if (deltaY <= -Math.abs(Number(chatVoiceGestureState.lockThresholdPx || 78))) {
      chatVoiceGestureState.locked = true;
      releaseVoiceGestureCapture();
      syncAllVoiceRecorderUis();
      return;
    }
    if (deltaX <= -Math.abs(Number(chatVoiceGestureState.cancelThresholdPx || 96))) {
      void cancelVoiceGestureRecording('Recording canceled');
      return;
    }
    syncAllVoiceRecorderUis();
  }

async function finishVoiceGesture() {
    if (!chatVoiceGestureState.active) return;
    const scope = chatVoiceGestureState.scope;
    if (chatVoiceGestureState.canceled) {
      resetVoiceGestureState();
      return;
    }
    if (chatVoiceGestureState.locked) {
      chatVoiceGestureState.active = false;
      releaseVoiceGestureCapture();
      chatVoiceGestureState.pointerId = null;
      syncAllVoiceRecorderUis();
      return;
    }
    chatVoiceGestureState.sentOnRelease = true;
    releaseVoiceGestureCapture();
    await stopChatVoiceRecording();
    chatVoiceGestureState.active = false;
    chatVoiceGestureState.pointerId = null;
  }

function syncAllVoiceRecorderUis() {
    syncVoiceRecorderUi('public');
    syncVoiceRecorderUi('private');
    syncVoiceRecorderUi('driverProfile');
    emitChatVoiceDrawerStateChangedIfNeeded();
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
    chatVoiceGestureState.sentOnRelease = false;
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

    chatVoiceState.scope = normalizedScope;
    chatVoiceState.room = String(options.room || CHAT_ROOM || '');
    chatVoiceState.otherUserId = options.userId == null ? '' : String(options.userId);
    chatVoiceState.mimeType = chooseChatVoiceMimeType();
    chatVoiceState.cancelRequested = false;
    chatVoiceState.durationMs = 0;
    setVoiceRecorderStatus(domScope, 'Requesting microphone…', '');
    syncAllVoiceRecorderUis();

    try {
      await prepareChatAudioForCapture(`${normalizedScope}-voice-start`);

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
          const wasLockedCapture = !!(chatVoiceGestureState.locked && chatVoiceGestureState.scope === finalizeScope);
          const shouldSendOnRelease = !!chatVoiceGestureState.sentOnRelease && !wasLockedCapture;
          const shouldAutoSend = !wasLockedCapture || shouldSendOnRelease;
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
          if (shouldAutoSend) {
            setVoiceRecorderStatus(domTarget, 'Sending voice note…', '');
            syncAllVoiceRecorderUis();
            try {
              await sendChatVoiceDraft(finalizeScope, {
                ...chatVoiceGestureState.autoSendOptions,
                room: finalizeOptions.room,
                userId: finalizeOptions.userId,
              });
            } catch (_) {}
            chatVoiceGestureState.sentOnRelease = false;
            setVoiceRecorderStatus(domTarget, CHAT_VOICE_IDLE_STATUS, '');
            syncAllVoiceRecorderUis();
            return;
          }
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
    const host = document.getElementById(`${surface}VoiceHost`);
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
      if (Date.now() < Number(chatVoiceGestureState.suppressClickUntil || 0)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    });
    startBtn?.addEventListener('pointerdown', async (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (isChatVoiceBusy()) return;
      const options = typeof optionsFactory === 'function' ? optionsFactory() : {};
      event.preventDefault();
      event.stopPropagation();
      startBtn.setPointerCapture?.(event.pointerId);
      chatVoiceGestureState.suppressClickUntil = Date.now() + 700;
      const started = await startChatVoiceRecording(surface, options);
      if (!started) return;
      beginVoiceGesture(surface, { ...event, captureEl: startBtn }, options);
      syncAllVoiceRecorderUis();
    });
    startBtn?.addEventListener('touchstart', async (event) => {
      if (chatVoiceGestureState.active || isChatVoiceBusy()) return;
      const touch = event.changedTouches && event.changedTouches[0];
      if (!touch) return;
      const options = typeof optionsFactory === 'function' ? optionsFactory() : {};
      event.preventDefault();
      event.stopPropagation();
      chatVoiceGestureState.suppressClickUntil = Date.now() + 700;
      const started = await startChatVoiceRecording(surface, options);
      if (!started) return;
      beginVoiceGesture(surface, {
        pointerId: 'touch',
        clientX: touch.clientX,
        clientY: touch.clientY,
        captureEl: startBtn,
      }, options);
      syncAllVoiceRecorderUis();
    }, { passive: false });
    startBtn?.addEventListener('pointermove', (event) => {
      if (!chatVoiceGestureState.active || chatVoiceGestureState.pointerId !== event.pointerId) return;
      event.preventDefault();
      updateVoiceGesture(event);
    });
    startBtn?.addEventListener('touchmove', (event) => {
      if (!chatVoiceGestureState.active || chatVoiceGestureState.pointerId !== 'touch') return;
      const touch = event.changedTouches && event.changedTouches[0];
      if (!touch) return;
      event.preventDefault();
      updateVoiceGesture({
        clientX: touch.clientX,
        clientY: touch.clientY,
      });
    }, { passive: false });
    startBtn?.addEventListener('pointerup', async (event) => {
      if (chatVoiceGestureState.pointerId !== event.pointerId) return;
      event.preventDefault();
      chatVoiceGestureState.suppressClickUntil = Date.now() + 700;
      await finishVoiceGesture();
    });
    startBtn?.addEventListener('touchend', async (event) => {
      if (chatVoiceGestureState.pointerId !== 'touch') return;
      event.preventDefault();
      event.stopPropagation();
      chatVoiceGestureState.suppressClickUntil = Date.now() + 700;
      await finishVoiceGesture();
    }, { passive: false });
    startBtn?.addEventListener('pointercancel', async (event) => {
      if (chatVoiceGestureState.pointerId !== event.pointerId) return;
      chatVoiceGestureState.suppressClickUntil = Date.now() + 700;
      await finishVoiceGesture();
    });
    startBtn?.addEventListener('touchcancel', async (event) => {
      if (chatVoiceGestureState.pointerId !== 'touch') return;
      event.preventDefault();
      event.stopPropagation();
      chatVoiceGestureState.suppressClickUntil = Date.now() + 700;
      await finishVoiceGesture();
    }, { passive: false });
    host?.addEventListener('click', async (event) => {
      const target = event.target?.closest?.('button');
      if (!target) return;
      if (target.id === `${surface}VoiceStopBtn`) {
        stopEvent(event);
        void stopActiveVoiceRecording(surface);
        chatVoiceGestureState.active = false;
        return;
      }
      if (target.id === `${surface}VoiceCancelBtn`) {
        stopEvent(event);
        chatVoiceGestureState.canceled = true;
        void cancelVoiceRecording(surface);
        return;
      }
      if (target.id === `${surface}VoiceDraftCancelBtn`) {
        stopEvent(event);
        void discardChatVoiceDraft(surface);
        return;
      }
      if (target.id === `${surface}VoiceDraftSendBtn`) {
        stopEvent(event);
        const options = typeof optionsFactory === 'function' ? optionsFactory() : {};
        try {
          await sendChatVoiceDraft(surface, options);
        } catch (_) {}
        return;
      }
      if (target.id === `${surface}VoiceDraftPreviewBtn`) {
        stopEvent(event);
        void toggleChatVoiceDraftPreview(surface, target);
      }
      if (target.id === `${surface}VoiceErrorDismissBtn`) {
        stopEvent(event);
        setVoiceRecorderStatus(surface, CHAT_VOICE_IDLE_STATUS, '');
        chatVoiceDraftState.error = '';
        syncAllVoiceRecorderUis();
      }
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
  window.getChatVoicePlaybackDebug = function getChatVoicePlaybackDebug() {
    const audio = syncVoiceRuntimeAudioRef();
    return {
      activeMessageId: voicePlaybackRuntime.activeMessageId,
      activeScope: voicePlaybackRuntime.activeScope,
      activeBlobUrl: String(voicePlaybackRuntime.activeBlobUrl || ''),
      activeAudioUrl: String(voicePlaybackRuntime.activeAudioUrl || ''),
      isPlaying: !!voicePlaybackRuntime.isPlaying,
      lastPauseReason: String(voicePlaybackRuntime.lastPauseReason || ''),
      sharedOwner: String(getSharedAudioCoordinator()?.owner || 'idle'),
      audioCurrentSrc: String(audio?.currentSrc || audio?.src || ''),
      audioPaused: !!audio?.paused,
      audioEnded: !!audio?.ended,
      audioReadyState: Number(audio?.readyState ?? 0),
      audioNetworkState: Number(audio?.networkState ?? 0)
    };
  };
  window.getChatVoiceRecordDebug = function getChatVoiceRecordDebug() {
    return {
      phase: chatVoiceState.phase,
      scope: chatVoiceState.scope,
      hasStream: !!chatVoiceState.stream,
      hasRecorder: !!chatVoiceState.recorder,
      mimeType: chatVoiceState.mimeType || '',
      draftStatus: chatVoiceDraftState.status,
      draftScope: chatVoiceDraftState.scope,
      draftDurationMs: Number(chatVoiceDraftState.durationMs || 0),
      lastError: chatVoiceState.lastError || '',
      audioSessionType: (() => {
        try {
          return navigator && navigator.audioSession ? navigator.audioSession.type : '';
        } catch (_) {
          return '';
        }
      })(),
      hasSetChatAudioSessionType: typeof setChatAudioSessionType === 'function'
    };
  };


  const VOICE_NOTE_MAX_MS = 120000;
  const CHAT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
  const PRIVATE_CHAT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;





















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
  let chatInitialLoadPromise = null;
  let chatInitialHistoryLoadAttempted = false;
  let chatInitialHistoryRetryQueued = false;
  let chatHiddenBaselineReady = false;

  // Kill-feed bootstrap guard.
  // We seed startup history into seen-keys, then suppress feed replay until
  // one post-bootstrap poll has been absorbed as history too.
  let killFeedBootstrapReady = false;
  let killFeedBootstrapPollConsumed = false;

  let activeChatTab = 'public';
  let publicChatViewMode = 'messages';
  let privateChatViewModeByUserId = Object.create(null);
  let publicPhotoItems = [];
  let publicPhotoHasMore = false;
  let publicPhotoBeforeId = null;
  let privatePhotoItemsByUserId = Object.create(null);
  let privatePhotoHasMoreByUserId = Object.create(null);
  let privatePhotoBeforeIdByUserId = Object.create(null);
  let privateThreads = [];
  let privateActiveUserId = null;
  let privateActiveDisplayName = '';
  let privateBackendThreadIds = new Set();
  let privateMessagesByUserId = Object.create(null);
  const chatPhotoViewerState = {
    open: false,
    scope: '',
    source: '',
    userId: '',
    items: [],
    index: -1,
    restoreChatDrawer: false,
    restoreChatTab: 'public',
    restorePrivateUserId: '',
    suppressedChatDrawer: null,
    suppressedChatBackdrop: null,
    itemKey: '',
    touchStartX: 0,
    touchStartY: 0,
    zoom: 1,
    minZoom: 1,
    maxZoom: 4,
    panX: 0,
    panY: 0,
    dragging: false,
    dragStartX: 0,
    dragStartY: 0,
    dragOriginX: 0,
    dragOriginY: 0,
    pinchStartDistance: 0,
    pinchStartZoom: 1,
    lastTapAt: 0,
  };
  const chatImageViewerBoundRoots = new WeakSet();
  let chatPhotoViewerKeyboardBound = false;
  let privateUnreadByUserId = Object.create(null);
  let privateLastMessageIdByUserId = Object.create(null);
  let privateThreadPollTimer = null;
  let privateThreadPollInFlight = false;
  let chatPollAbortController = null;
  let privateThreadAbortController = null;
  const privateMessageAbortControllers = new Map();
  const chatScrollRuntime = {
    publicActiveUntil: 0,
    privateActiveUntilByUserId: Object.create(null),
    profileActiveUntil: 0,
    pendingPublicRender: null,
    pendingPrivateRenderByUserId: Object.create(null),
    pendingProfileRender: null,
  };
  const privateDirectoryState = {
    open: false,
    query: '',
    loading: false,
    error: '',
    items: [],
    offset: 0,
    limit: 50,
    hasMore: false,
  };
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
    return typeof window.getOpenPanelKey === 'function' && window.getOpenPanelKey() === 'chat';
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
    if (raw.includes('image') || raw.includes('photo') || raw.includes('picture')) return 'image';
    return raw;
  }

  function resolveChatAssetUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw) || raw.startsWith('blob:') || raw.startsWith('data:')) return raw;
    if (runtime?.toAbsoluteUrl) return runtime.toAbsoluteUrl(raw);
    const base = String(typeof RAILWAY_BASE !== 'undefined' ? RAILWAY_BASE : (window?.API_BASE || '') || '').trim();
    if (!base) return raw;
    return `${base}${raw.startsWith('/') ? raw : `/${raw}`}`;
  }

  function normalizeAudioUrl(raw) {
    const url = raw?.audio_url || raw?.voice_url || raw?.media_url || raw?.file_url || raw?.attachment_url || raw?.audioUrl || raw?.voiceUrl || raw?.mediaUrl || '';
    return resolveChatAssetUrl(url);
  }

  function normalizeImageUrl(raw) {
    const url = raw?.image_url
      || raw?.imageUrl
      || raw?.media_url
      || raw?.mediaUrl
      || raw?.file_url
      || raw?.fileUrl
      || raw?.attachment_url
      || raw?.attachmentUrl
      || raw?.photo_url
      || raw?.photoUrl
      || raw?.media_image_url
      || raw?.mediaImageUrl
      || '';
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

  function normalizeImageMimeType(raw) {
    const mime = raw?.image_mime_type
      || raw?.imageMimeType
      || raw?.mime_type
      || raw?.mimeType
      || raw?.photo_mime_type
      || raw?.photoMimeType
      || '';
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
    const imageUrl = normalizeImageUrl(raw);
    const fallbackType = imageUrl ? 'image' : (audioUrl ? 'voice' : 'text');
    const messageType = normalizeMessageType(raw?.message_type || raw?.messageType || raw?.type, fallbackType);
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
      imageUrl,
      audioDurationMs: normalizeAudioDurationMs(raw),
      audioMimeType: normalizeAudioMimeType(raw),
      imageMimeType: normalizeImageMimeType(raw),
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
    const imageUrl = normalizeImageUrl(raw);
    const threadMessageType = normalizeMessageType(raw?.last_message_type || raw?.message_type || raw?.type, imageUrl ? 'image' : (audioUrl ? 'voice' : 'text'));
    const previewText = threadMessageType === 'voice'
      ? '🎤 Voice note'
      : (threadMessageType === 'image'
        ? '🖼 Photo'
        : String(raw?.last_message_text || raw?.last_text || raw?.last_message || raw?.text || '').trim());
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

  function dmEchoScopeKey(otherUserId = null) {
    const explicitOther = String(otherUserId == null ? '' : otherUserId).trim();
    if (explicitOther) return `dm:${explicitOther}`;
    const profileUserId = String(driverProfileState?.userId || '').trim();
    if (profileUserId && driverProfileState?.open && !driverProfileState?.isSelf) return `dm:${profileUserId}`;
    const activeUserId = String(privateActiveUserId || '').trim();
    if (activeUserId) return `dm:${activeUserId}`;
    return 'dm:unknown';
  }

  function rememberOutgoingDmEcho(textOrMsg, otherUserId = null) {
    pruneOutgoingEchoMap(recentOutgoingDmEchoes);
    const text = typeof textOrMsg === 'string'
      ? textOrMsg
      : (textOrMsg?.text || textOrMsg?.message || '');
    const userId = typeof textOrMsg === 'string'
      ? currentChatSelfUserId()
      : (msgUserId(textOrMsg) || currentChatSelfUserId());
    const fp = makeOutgoingEchoFingerprint(text, userId);
    if (!fp) return;
    const scopeKey = dmEchoScopeKey(otherUserId);
    recentOutgoingDmEchoes.set(`${scopeKey}|${fp}`, Date.now() + CHAT_OUTGOING_ECHO_SUPPRESS_MS);
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
    if (activeChatTab === 'private' && !privateActiveUserId) {
      if (privateDirectoryState.open) renderPrivateComposePicker();
      else renderPrivateThreadList();
    }
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
      renderChatMessages(merged, { replace: true, forceStickToBottom: false });
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
      const gamesModule = window.TlcGamesModule || null;
      const gamesOpen = !!gamesModule?.isGamesPanelOpen?.();

      showBattleFeedEntry(payload.battle_result || payload);

      if (payload.match_id && gamesOpen) {
        void gamesModule?.loadGamesBattleDashboard?.({ silent: true });
        void gamesModule?.loadActiveBattleMatch?.({
          silent: true,
          preferredMatchId: Number(payload.match_id)
        });
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
    if (xp > 0) {
      const xpText = typeof window.formatProgressNumber === 'function'
        ? window.formatProgressNumber(xp, { maxFractionDigits: 0 })
        : String(Math.round(xp));
      textBits.push(`(+${xpText} XP)`);
    }
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







































































  function messageHasImage(msg) {
    return normalizeMessageType(msg?.messageType, msg?.imageUrl ? 'image' : (msg?.audioUrl ? 'voice' : 'text')) === 'image'
      || !!String(msg?.imageUrl || '').trim();
  }

  function buildPhotoViewerItems({ scope, source, userId = '' } = {}) {
    const normalizedScope = String(scope || '').toLowerCase() === 'private' ? 'private' : 'public';
    const normalizedSource = String(source || '').toLowerCase() === 'photos' ? 'photos' : 'messages';
    const uid = String(userId || '');
    let rawItems = [];
    if (normalizedScope === 'public' && normalizedSource === 'messages') rawItems = Array.isArray(publicChatMessages) ? publicChatMessages : [];
    if (normalizedScope === 'public' && normalizedSource === 'photos') rawItems = Array.isArray(publicPhotoItems) ? publicPhotoItems : [];
    if (normalizedScope === 'private' && normalizedSource === 'messages') rawItems = Array.isArray(privateMessagesByUserId[uid]) ? privateMessagesByUserId[uid] : [];
    if (normalizedScope === 'private' && normalizedSource === 'photos') rawItems = Array.isArray(privatePhotoItemsByUserId[uid]) ? privatePhotoItemsByUserId[uid] : [];
    return rawItems.map((item) => (normalizedScope === 'private'
      ? normalizePrivateChatMessage(item, currentChatSelfUserId())
      : normalizePublicChatMessage(item)))
      .filter((msg) => messageHasImage(msg) && String(msg?.imageUrl || '').trim())
      .map((msg) => ({
        id: msg?.id == null ? '' : String(msg.id),
        imageUrl: String(msg?.imageUrl || '').trim(),
        imageMimeType: String(msg?.imageMimeType || '').trim(),
        displayName: String(msg?.displayName || 'Driver').trim() || 'Driver',
        createdAt: msg?.createdAt || '',
        text: String(msg?.text || '').trim(),
      }));
  }

  function currentChatPhotoViewerItem() {
    const index = Number(chatPhotoViewerState.index);
    if (!Number.isFinite(index) || index < 0) return null;
    return chatPhotoViewerState.items[index] || null;
  }

  async function ensureViewerImageBlobUrl(item) {
    const message = {
      id: item?.id,
      imageUrl: String(item?.imageUrl || '').trim(),
      imageMimeType: String(item?.imageMimeType || '').trim(),
    };
    return ensureImageBlobUrl(message);
  }

  function chatPhotoDistance(touchA, touchB) {
    if (!touchA || !touchB) return 0;
    const dx = Number(touchA.clientX || 0) - Number(touchB.clientX || 0);
    const dy = Number(touchA.clientY || 0) - Number(touchB.clientY || 0);
    return Math.hypot(dx, dy);
  }

  function resetChatPhotoViewerTransform() {
    chatPhotoViewerState.zoom = 1;
    chatPhotoViewerState.panX = 0;
    chatPhotoViewerState.panY = 0;
    chatPhotoViewerState.dragging = false;
    chatPhotoViewerState.dragStartX = 0;
    chatPhotoViewerState.dragStartY = 0;
    chatPhotoViewerState.dragOriginX = 0;
    chatPhotoViewerState.dragOriginY = 0;
    chatPhotoViewerState.pinchStartDistance = 0;
    chatPhotoViewerState.pinchStartZoom = chatPhotoViewerState.zoom;
  }

  function clampChatPhotoViewerTransform() {
    const mount = document.getElementById('chatPhotoViewerMount');
    const stageEl = mount?.querySelector?.('[data-chat-photo-stage]');
    const imgEl = mount?.querySelector?.('[data-chat-photo-image]');
    if (!stageEl || !imgEl) return;
    const zoom = Math.max(chatPhotoViewerState.minZoom, Math.min(chatPhotoViewerState.maxZoom, Number(chatPhotoViewerState.zoom) || 1));
    chatPhotoViewerState.zoom = zoom;
    if (zoom <= 1) {
      chatPhotoViewerState.panX = 0;
      chatPhotoViewerState.panY = 0;
      return;
    }
    const stageRect = stageEl.getBoundingClientRect();
    const baseWidth = Number(imgEl.clientWidth || 0);
    const baseHeight = Number(imgEl.clientHeight || 0);
    if (!stageRect.width || !stageRect.height || !baseWidth || !baseHeight) return;
    const scaledWidth = baseWidth * zoom;
    const scaledHeight = baseHeight * zoom;
    const maxPanX = Math.max(0, (scaledWidth - Math.min(stageRect.width, scaledWidth)) / 2);
    const maxPanY = Math.max(0, (scaledHeight - Math.min(stageRect.height, scaledHeight)) / 2);
    chatPhotoViewerState.panX = Math.max(-maxPanX, Math.min(maxPanX, Number(chatPhotoViewerState.panX) || 0));
    chatPhotoViewerState.panY = Math.max(-maxPanY, Math.min(maxPanY, Number(chatPhotoViewerState.panY) || 0));
  }

  function applyChatPhotoViewerTransform() {
    const mount = document.getElementById('chatPhotoViewerMount');
    const stageEl = mount?.querySelector?.('[data-chat-photo-stage]');
    const imgEl = mount?.querySelector?.('[data-chat-photo-image]');
    if (!imgEl || !stageEl) return;
    clampChatPhotoViewerTransform();
    const zoom = Number(chatPhotoViewerState.zoom || 1);
    const panX = Number(chatPhotoViewerState.panX || 0);
    const panY = Number(chatPhotoViewerState.panY || 0);
    imgEl.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    imgEl.style.cursor = zoom > 1 ? (chatPhotoViewerState.dragging ? 'grabbing' : 'grab') : 'zoom-in';
    stageEl.dataset.zoomed = zoom > 1 ? '1' : '0';
  }

  function setChatPhotoViewerZoom(nextZoom, anchorX = null, anchorY = null) {
    const mount = document.getElementById('chatPhotoViewerMount');
    const imgEl = mount?.querySelector?.('[data-chat-photo-image]');
    const prevZoom = Math.max(chatPhotoViewerState.minZoom, Math.min(chatPhotoViewerState.maxZoom, Number(chatPhotoViewerState.zoom) || 1));
    const clampedZoom = Math.max(chatPhotoViewerState.minZoom, Math.min(chatPhotoViewerState.maxZoom, Number(nextZoom) || 1));
    if (!imgEl || !Number.isFinite(clampedZoom)) return;
    if (anchorX != null && anchorY != null && prevZoom > 0) {
      const rect = imgEl.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const offsetX = Number(anchorX) - centerX;
      const offsetY = Number(anchorY) - centerY;
      const ratio = clampedZoom / prevZoom;
      chatPhotoViewerState.panX = Number(chatPhotoViewerState.panX || 0) + offsetX * (1 - ratio);
      chatPhotoViewerState.panY = Number(chatPhotoViewerState.panY || 0) + offsetY * (1 - ratio);
    }
    chatPhotoViewerState.zoom = clampedZoom;
    if (clampedZoom <= 1) {
      chatPhotoViewerState.panX = 0;
      chatPhotoViewerState.panY = 0;
      chatPhotoViewerState.dragging = false;
    }
    applyChatPhotoViewerTransform();
  }

  function ensureChatPhotoViewerMount() {
    let mount = document.getElementById('chatPhotoViewerMount');
    if (mount) return mount;
    mount = document.createElement('div');
    mount.id = 'chatPhotoViewerMount';
    mount.className = 'chatPhotoViewerBackdrop hidden';
    mount.innerHTML = `<div class="chatPhotoViewerCard" role="dialog" aria-modal="true" aria-label="Chat photo viewer">
      <div class="chatPhotoViewerHeader">
        <div class="chatPhotoViewerMeta">
          <strong class="chatPhotoViewerSender" data-chat-photo-sender></strong>
          <span class="chatPhotoViewerTimestamp" data-chat-photo-time></span>
        </div>
        <button type="button" class="chatPhotoViewerCloseBtn" data-chat-photo-close aria-label="Close photo viewer">×</button>
      </div>
      <div class="chatPhotoViewerStage" data-chat-photo-stage>
        <button type="button" class="chatPhotoViewerNavBtn prev" data-chat-photo-prev aria-label="Previous photo">‹</button>
        <img class="chatPhotoViewerImage" data-chat-photo-image alt="Chat photo preview" />
        <button type="button" class="chatPhotoViewerNavBtn next" data-chat-photo-next aria-label="Next photo">›</button>
      </div>
      <div class="chatPhotoViewerFooter">
        <div class="chatPhotoViewerCaption" data-chat-photo-caption></div>
        <div class="chatPhotoViewerCounter" data-chat-photo-counter></div>
      </div>
    </div>`;
    document.body.appendChild(mount);
    mount.addEventListener('click', (event) => {
      if (event.target === mount || event.target?.closest?.('[data-chat-photo-close]')) closeChatPhotoViewer();
    });
    mount.querySelector('[data-chat-photo-prev]')?.addEventListener('click', () => moveChatPhotoViewer(-1));
    mount.querySelector('[data-chat-photo-next]')?.addEventListener('click', () => moveChatPhotoViewer(1));
    const stage = mount.querySelector('[data-chat-photo-stage]');
    const image = mount.querySelector('[data-chat-photo-image]');
    if (stage) {
      stage.addEventListener('touchstart', (event) => {
        if (!chatPhotoViewerState.open) return;
        if (event.touches?.length === 2) {
          chatPhotoViewerState.pinchStartDistance = chatPhotoDistance(event.touches[0], event.touches[1]);
          chatPhotoViewerState.pinchStartZoom = Number(chatPhotoViewerState.zoom || 1);
          chatPhotoViewerState.dragging = false;
          return;
        }
        const firstTouch = event.touches?.[0] || event.changedTouches?.[0];
        chatPhotoViewerState.touchStartX = Number(firstTouch?.clientX || 0);
        chatPhotoViewerState.touchStartY = Number(firstTouch?.clientY || 0);
        const now = Date.now();
        if (now - Number(chatPhotoViewerState.lastTapAt || 0) <= 280) {
          const nextZoom = Number(chatPhotoViewerState.zoom || 1) > 1 ? 1 : 2;
          setChatPhotoViewerZoom(nextZoom, firstTouch?.clientX, firstTouch?.clientY);
          chatPhotoViewerState.lastTapAt = 0;
          event.preventDefault();
          return;
        }
        chatPhotoViewerState.lastTapAt = now;
        if (Number(chatPhotoViewerState.zoom || 1) > 1) {
          chatPhotoViewerState.dragging = true;
          chatPhotoViewerState.dragStartX = Number(firstTouch?.clientX || 0);
          chatPhotoViewerState.dragStartY = Number(firstTouch?.clientY || 0);
          chatPhotoViewerState.dragOriginX = Number(chatPhotoViewerState.panX || 0);
          chatPhotoViewerState.dragOriginY = Number(chatPhotoViewerState.panY || 0);
        }
      }, { passive: false });
      stage.addEventListener('touchmove', (event) => {
        if (!chatPhotoViewerState.open) return;
        if (event.touches?.length === 2 && Number(chatPhotoViewerState.pinchStartDistance || 0) > 0) {
          const currentDistance = chatPhotoDistance(event.touches[0], event.touches[1]);
          if (currentDistance > 0) {
            const midpointX = (Number(event.touches[0]?.clientX || 0) + Number(event.touches[1]?.clientX || 0)) / 2;
            const midpointY = (Number(event.touches[0]?.clientY || 0) + Number(event.touches[1]?.clientY || 0)) / 2;
            const scaleRatio = currentDistance / Number(chatPhotoViewerState.pinchStartDistance || currentDistance);
            setChatPhotoViewerZoom(Number(chatPhotoViewerState.pinchStartZoom || 1) * scaleRatio, midpointX, midpointY);
          }
          event.preventDefault();
          return;
        }
        if (Number(chatPhotoViewerState.zoom || 1) > 1 && chatPhotoViewerState.dragging && event.touches?.length === 1) {
          const touch = event.touches[0];
          const deltaX = Number(touch?.clientX || 0) - Number(chatPhotoViewerState.dragStartX || 0);
          const deltaY = Number(touch?.clientY || 0) - Number(chatPhotoViewerState.dragStartY || 0);
          chatPhotoViewerState.panX = Number(chatPhotoViewerState.dragOriginX || 0) + deltaX;
          chatPhotoViewerState.panY = Number(chatPhotoViewerState.dragOriginY || 0) + deltaY;
          applyChatPhotoViewerTransform();
          event.preventDefault();
        }
      }, { passive: false });
      stage.addEventListener('touchend', (event) => {
        if (!chatPhotoViewerState.open) return;
        if (event.touches?.length < 2) chatPhotoViewerState.pinchStartDistance = 0;
        const endTouch = event.changedTouches?.[0] || null;
        const endX = Number(endTouch?.clientX || 0);
        const endY = Number(endTouch?.clientY || 0);
        const deltaX = endX - Number(chatPhotoViewerState.touchStartX || 0);
        const deltaY = endY - Number(chatPhotoViewerState.touchStartY || 0);
        chatPhotoViewerState.dragging = false;
        if (Number(chatPhotoViewerState.zoom || 1) > 1) return;
        if (Math.abs(deltaX) < 45 || Math.abs(deltaX) <= Math.abs(deltaY)) return;
        moveChatPhotoViewer(deltaX < 0 ? 1 : -1);
      }, { passive: true });
      stage.addEventListener('wheel', (event) => {
        if (!chatPhotoViewerState.open) return;
        const wheelDelta = Number(event.deltaY || 0);
        if (!Number.isFinite(wheelDelta)) return;
        const factor = Math.exp(-wheelDelta * 0.0015);
        setChatPhotoViewerZoom(Number(chatPhotoViewerState.zoom || 1) * factor, event.clientX, event.clientY);
        event.preventDefault();
      }, { passive: false });
    }
    if (image) {
      image.addEventListener('dblclick', (event) => {
        if (!chatPhotoViewerState.open) return;
        const nextZoom = Number(chatPhotoViewerState.zoom || 1) > 1 ? 1 : 2;
        setChatPhotoViewerZoom(nextZoom, event.clientX, event.clientY);
        event.preventDefault();
      });
      image.addEventListener('mousedown', (event) => {
        if (!chatPhotoViewerState.open || Number(chatPhotoViewerState.zoom || 1) <= 1) return;
        chatPhotoViewerState.dragging = true;
        chatPhotoViewerState.dragStartX = Number(event.clientX || 0);
        chatPhotoViewerState.dragStartY = Number(event.clientY || 0);
        chatPhotoViewerState.dragOriginX = Number(chatPhotoViewerState.panX || 0);
        chatPhotoViewerState.dragOriginY = Number(chatPhotoViewerState.panY || 0);
        applyChatPhotoViewerTransform();
        event.preventDefault();
      });
    }
    window.addEventListener('mousemove', (event) => {
      if (!chatPhotoViewerState.open || !chatPhotoViewerState.dragging || Number(chatPhotoViewerState.zoom || 1) <= 1) return;
      const deltaX = Number(event.clientX || 0) - Number(chatPhotoViewerState.dragStartX || 0);
      const deltaY = Number(event.clientY || 0) - Number(chatPhotoViewerState.dragStartY || 0);
      chatPhotoViewerState.panX = Number(chatPhotoViewerState.dragOriginX || 0) + deltaX;
      chatPhotoViewerState.panY = Number(chatPhotoViewerState.dragOriginY || 0) + deltaY;
      applyChatPhotoViewerTransform();
    });
    window.addEventListener('mouseup', () => {
      if (!chatPhotoViewerState.dragging) return;
      chatPhotoViewerState.dragging = false;
      applyChatPhotoViewerTransform();
    });
    if (!chatPhotoViewerKeyboardBound) {
      chatPhotoViewerKeyboardBound = true;
      document.addEventListener('keydown', (event) => {
        if (!chatPhotoViewerState.open) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          closeChatPhotoViewer();
          return;
        }
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          moveChatPhotoViewer(-1);
          return;
        }
        if (event.key === 'ArrowRight') {
          event.preventDefault();
          moveChatPhotoViewer(1);
        }
      });
    }
    return mount;
  }

  function renderChatPhotoViewer() {
    const mount = ensureChatPhotoViewerMount();
    const item = currentChatPhotoViewerItem();
    const shouldShow = !!(chatPhotoViewerState.open && item);
    mount.classList.toggle('hidden', !shouldShow);
    if (!shouldShow) {
      document.body.classList.remove('chatPhotoViewerOpen');
      return;
    }
    document.body.classList.add('chatPhotoViewerOpen');
    const imgEl = mount.querySelector('[data-chat-photo-image]');
    const senderEl = mount.querySelector('[data-chat-photo-sender]');
    const timeEl = mount.querySelector('[data-chat-photo-time]');
    const captionEl = mount.querySelector('[data-chat-photo-caption]');
    const counterEl = mount.querySelector('[data-chat-photo-counter]');
    const prevBtn = mount.querySelector('[data-chat-photo-prev]');
    const nextBtn = mount.querySelector('[data-chat-photo-next]');
    const nextItemKey = `${String(item?.id || '')}|${String(item?.imageUrl || '')}`;
    if (chatPhotoViewerState.itemKey !== nextItemKey) {
      chatPhotoViewerState.itemKey = nextItemKey;
      resetChatPhotoViewerTransform();
    }
    if (imgEl) {
      const cacheKey = getImageAssetCacheKey(item);
      imgEl.dataset.viewerImageCacheKey = cacheKey;
      const cached = imageAssetCache.get(cacheKey);
      if (cached?.status === 'ready' && cached?.blobUrl) {
        imgEl.src = String(cached.blobUrl || '');
        applyChatPhotoViewerTransform();
      } else {
        imgEl.removeAttribute('src');
        applyChatPhotoViewerTransform();
        ensureViewerImageBlobUrl(item).then((blobUrl) => {
          if (!imgEl.isConnected) return;
          if (!chatPhotoViewerState.open) return;
          if (currentChatPhotoViewerItem() !== item) return;
          if (imgEl.dataset.viewerImageCacheKey !== cacheKey) return;
          if (!blobUrl) {
            imgEl.removeAttribute('src');
            imgEl.alt = 'Photo unavailable';
            imgEl.title = 'Photo unavailable';
            applyChatPhotoViewerTransform();
            return;
          }
          imgEl.src = blobUrl;
          imgEl.removeAttribute('title');
          imgEl.alt = String(item.displayName || 'Chat photo');
          applyChatPhotoViewerTransform();
        }).catch(() => {
          if (!imgEl.isConnected) return;
          if (!chatPhotoViewerState.open) return;
          if (currentChatPhotoViewerItem() !== item) return;
          if (imgEl.dataset.viewerImageCacheKey !== cacheKey) return;
          imgEl.removeAttribute('src');
          imgEl.alt = 'Photo unavailable';
          imgEl.title = 'Photo unavailable';
          applyChatPhotoViewerTransform();
        });
      }
      imgEl.alt = String(item.displayName || 'Chat photo');
      if (!imgEl.complete) {
        imgEl.onload = () => applyChatPhotoViewerTransform();
      }
    }
    if (senderEl) senderEl.textContent = String(item.displayName || 'Driver');
    if (timeEl) timeEl.textContent = formatChatTime(item.createdAt);
    if (captionEl) {
      captionEl.textContent = String(item.text || '');
      captionEl.classList.toggle('hidden', !String(item.text || '').trim());
    }
    if (counterEl) counterEl.textContent = `${chatPhotoViewerState.index + 1} / ${chatPhotoViewerState.items.length}`;
    if (prevBtn) prevBtn.disabled = chatPhotoViewerState.index <= 0;
    if (nextBtn) nextBtn.disabled = chatPhotoViewerState.index >= chatPhotoViewerState.items.length - 1;
  }

  function getLiveChatDrawerElements() {
    const drawer = document.querySelector('.dockDrawer.panelChat.open');
    const backdrop = document.querySelector('.dockBackdrop.open');
    return { drawer, backdrop };
  }

  function suppressChatDrawerForPhotoViewer() {
    const { drawer, backdrop } = getLiveChatDrawerElements();
    if (!drawer) return false;
    chatPhotoViewerState.suppressedChatDrawer = drawer;
    chatPhotoViewerState.suppressedChatBackdrop = backdrop || null;
    drawer.classList.add('chatPhotoViewerSuppressed');
    if (backdrop) backdrop.classList.add('chatPhotoViewerSuppressed');
    return true;
  }

  function restoreSuppressedChatDrawerFromPhotoViewer() {
    const drawer = chatPhotoViewerState.suppressedChatDrawer;
    const backdrop = chatPhotoViewerState.suppressedChatBackdrop;
    if (!drawer) return false;
    drawer.classList.remove('chatPhotoViewerSuppressed');
    if (backdrop) backdrop.classList.remove('chatPhotoViewerSuppressed');
    chatPhotoViewerState.suppressedChatDrawer = null;
    chatPhotoViewerState.suppressedChatBackdrop = null;
    return true;
  }

  function closeChatPhotoViewer({ restoreChat = true } = {}) {
    if (!chatPhotoViewerState.open) return;
    chatPhotoViewerState.open = false;
    chatPhotoViewerState.index = -1;
    chatPhotoViewerState.items = [];
    chatPhotoViewerState.itemKey = '';
    chatPhotoViewerState.touchStartX = 0;
    chatPhotoViewerState.touchStartY = 0;
    resetChatPhotoViewerTransform();
    renderChatPhotoViewer();
    if (!restoreChat || !chatPhotoViewerState.restoreChatDrawer) {
      chatPhotoViewerState.restoreChatDrawer = false;
      chatPhotoViewerState.restoreChatTab = 'public';
      chatPhotoViewerState.restorePrivateUserId = '';
      return;
    }
    if (restoreSuppressedChatDrawerFromPhotoViewer()) {
      chatPhotoViewerState.restoreChatDrawer = false;
      chatPhotoViewerState.restoreChatTab = 'public';
      chatPhotoViewerState.restorePrivateUserId = '';
      return;
    }
    const restoreTab = chatPhotoViewerState.restoreChatTab === 'private' ? 'private' : 'public';
    const restorePrivateUserId = String(chatPhotoViewerState.restorePrivateUserId || '');
    chatPhotoViewerState.restoreChatDrawer = false;
    chatPhotoViewerState.restoreChatTab = 'public';
    chatPhotoViewerState.restorePrivateUserId = '';
    if (typeof window.openDrawer === 'function' && typeof window.chatPanelHTML === 'function') {
      window.openDrawer('chat', 'Chat', window.chatPanelHTML());
      if (typeof window.wireChatPanel === 'function') window.wireChatPanel();
      if (restoreTab === 'private') {
        switchChatTab('private');
        if (restorePrivateUserId) {
          const restoreName = privateThreads.find((thread) => String(privateThreadUserId(thread) || '') === restorePrivateUserId)?.displayName
            || privateActiveDisplayName
            || 'Driver';
          void openPrivateConversation(restorePrivateUserId, restoreName, { markRead: false });
        }
      } else {
        switchChatTab('public');
      }
    }
  }

  function moveChatPhotoViewer(delta) {
    if (!chatPhotoViewerState.open || !Array.isArray(chatPhotoViewerState.items) || !chatPhotoViewerState.items.length) return;
    const nextIndex = Math.max(0, Math.min(chatPhotoViewerState.items.length - 1, Number(chatPhotoViewerState.index || 0) + Number(delta || 0)));
    if (nextIndex === chatPhotoViewerState.index) return;
    chatPhotoViewerState.index = nextIndex;
    resetChatPhotoViewerTransform();
    renderChatPhotoViewer();
  }

  function openChatPhotoViewer({ scope, source, userId = '', messageId = null, imageUrl = '' } = {}) {
    const items = buildPhotoViewerItems({ scope, source, userId });
    if (!items.length) return;
    const messageIdText = messageId == null ? '' : String(messageId);
    const imageUrlText = String(imageUrl || '').trim();
    let index = -1;
    if (messageIdText) index = items.findIndex((item) => String(item.id || '') === messageIdText);
    if (index < 0 && imageUrlText) index = items.findIndex((item) => String(item.imageUrl || '') === imageUrlText);
    if (index < 0) return;
    const wasChatOpen = typeof window.getOpenPanelKey === 'function' && window.getOpenPanelKey() === 'chat';
    chatPhotoViewerState.restoreChatDrawer = wasChatOpen;
    chatPhotoViewerState.restoreChatTab = activeChatTab === 'private' ? 'private' : 'public';
    chatPhotoViewerState.restorePrivateUserId = String(privateActiveUserId || '');
    chatPhotoViewerState.suppressedChatDrawer = null;
    chatPhotoViewerState.suppressedChatBackdrop = null;
    if (wasChatOpen) suppressChatDrawerForPhotoViewer();
    chatPhotoViewerState.open = true;
    chatPhotoViewerState.scope = String(scope || '').toLowerCase() === 'private' ? 'private' : 'public';
    chatPhotoViewerState.source = String(source || '').toLowerCase() === 'photos' ? 'photos' : 'messages';
    chatPhotoViewerState.userId = String(userId || '');
    chatPhotoViewerState.items = items;
    chatPhotoViewerState.index = index;
    chatPhotoViewerState.itemKey = '';
    chatPhotoViewerState.touchStartX = 0;
    chatPhotoViewerState.touchStartY = 0;
    resetChatPhotoViewerTransform();
    ensureChatPhotoViewerMount();
    renderChatPhotoViewer();
  }

  function renderChatImageCard(message, bubbleClass = 'chatBubbleOther') {
    const rawImageUrl = String(message?.imageUrl || '').trim();
    const cacheEntry = imageAssetCache.get(getImageAssetCacheKey(message));
    const initialSrc = cacheEntry?.status === 'ready' && cacheEntry?.blobUrl ? String(cacheEntry.blobUrl) : '';
    const caption = String(message?.text || '').trim();
    const scope = String(message?.scope || '').toLowerCase() === 'private' ? 'private' : 'public';
    const privateUserId = scope === 'private'
      ? String(message?.chatTargetUserId || message?.chatUserId || privateActiveUserId || '')
      : '';
    return `<div class="${bubbleClass} chatImageCard"><div class="chatImageViewport"><img src="${escapeHtml(initialSrc)}" alt="Chat photo" loading="lazy" class="chatImageThumb" data-chat-image="1" data-chat-image-viewer="1" data-message-id="${escapeHtml(String(message?.id ?? ''))}" data-image-url="${escapeHtml(rawImageUrl)}" data-image-mime-type="${escapeHtml(String(message?.imageMimeType || ''))}" data-created-at="${escapeHtml(String(message?.createdAt || ''))}" data-photo-scope="${escapeHtml(scope)}" data-photo-source="messages" data-photo-user-id="${escapeHtml(privateUserId)}" /><div class="chatImageFallback ${initialSrc ? 'hidden' : ''}">Photo unavailable</div></div>${caption ? `<div class="chatImageCaption">${escapeHtml(caption)}</div>` : ''}</div>`;
  }

  function renderPublicMessageRow(message) {
    const msg = normalizePublicChatMessage(message);
    const own = !!msg?.isOwn;
    const safeName = escapeHtml(msg.displayName || 'Driver');
    const time = escapeHtml(formatChatTime(msg.createdAt));
    const bubbleClass = own ? 'chatBubbleSelf' : 'chatBubbleOther';
    const hasImage = messageHasImage(msg);
    const body = msg.messageType === 'voice'
      ? renderVoiceNotePlayer(msg, 'public')
      : hasImage
        ? renderChatImageCard({ ...msg, scope: 'public' }, `${bubbleClass} chatPublicTextBubble`)
      : `<div class="${bubbleClass} chatPublicTextBubble">${escapeHtml(String(msg.text || ''))}</div>`;
    return `<div class="chatMsgRow ${own ? 'self' : 'other'}${msg.messageType === 'voice' ? ' chatMsgRowVoice' : ''}" data-chat-row="public" data-message-key="${escapeHtml(getVoiceMessageDomKey(msg))}" data-message-id="${escapeHtml(String(msg?.id ?? ''))}" data-message-scope="public" data-audio-url="${escapeHtml(String(msg?.audioUrl || ''))}" data-image-url="${escapeHtml(String(msg?.imageUrl || ''))}"><div class="chatMsgNameLine"><strong class="chatMsgName">${safeName}</strong></div><div class="chatMsgBubbleWrap">${body}</div><div class="chatMsgTime">${time}</div></div>`;
  }

  function renderPrivateConversationRow(message, scope = 'private') {
    const msg = normalizePrivateChatMessage(message, currentChatSelfUserId());
    const own = !!msg?.isOwn;
    const cls = own ? 'chatBubbleSelf' : 'chatBubbleOther';
    const hasImage = messageHasImage(msg);
    const body = msg?.messageType === 'voice'
      ? renderVoiceNotePlayer(msg, scope === 'profile-dm' ? 'driverProfile' : 'private')
      : hasImage
        ? renderChatImageCard({ ...msg, scope: 'private', chatTargetUserId: String(msg?.chatTargetUserId || privateActiveUserId || '') }, cls)
      : `<div class="${cls}">${escapeHtml(String(msg?.text || ''))}</div>`;
    const t = escapeHtml(formatChatTime(msg?.createdAt));
    return `<div class="chatPrivateMsgRow ${own ? 'self' : 'other'}" data-chat-row="${escapeHtml(scope)}" data-message-key="${escapeHtml(getVoiceMessageDomKey(msg))}" data-message-id="${escapeHtml(String(msg?.id ?? ''))}" data-message-scope="${escapeHtml(scope)}" data-audio-url="${escapeHtml(String(msg?.audioUrl || ''))}" data-image-url="${escapeHtml(String(msg?.imageUrl || ''))}">${body}<div class="chatMsgTime">${t}</div></div>`;
  }

  function bindChatImageViewer(root = document) {
    if (!root || chatImageViewerBoundRoots.has(root)) return;
    chatImageViewerBoundRoots.add(root);
    root.addEventListener('click', (event) => {
      const target = event.target?.closest?.('[data-chat-image-viewer]');
      if (!target) return;
      event.preventDefault();
      openChatPhotoViewer({
        scope: String(target.getAttribute('data-photo-scope') || 'public'),
        source: String(target.getAttribute('data-photo-source') || 'messages'),
        userId: String(target.getAttribute('data-photo-user-id') || ''),
        messageId: String(target.getAttribute('data-message-id') || ''),
        imageUrl: String(target.getAttribute('data-image-url') || ''),
      });
    });
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
        const nextImageUrl = String(message?.imageUrl || '').trim();
        const isImageMessage = messageHasImage(message);
        const sameVoiceRow = shouldReuseVoiceRow(buildVoicePlayerMessageFromDataset(existing.querySelector?.('[data-voice-player]') || existing), message);
        const sameImageRow = shouldReuseImageRow(existing, message, scope);
        const sameTextRow = !isImageMessage
          && row.dataset.audioUrl === nextAudioUrl
          && String(row.dataset.imageUrl || '').trim() === nextImageUrl
          && row.outerHTML === nextHtml;
        if (!sameVoiceRow && !sameImageRow && !sameTextRow) {
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
            <div class="chatSubTabs" style="display:flex;gap:8px;margin-bottom:8px;">
              <button id="chatPublicModeMessages" class="chipBtn ${publicChatViewMode === 'messages' ? 'active' : ''}" type="button">Messages</button>
              <button id="chatPublicModePhotos" class="chipBtn ${publicChatViewMode === 'photos' ? 'active' : ''}" type="button">Photos</button>
            </div>
            <div id="chatList" class="chatList ${publicChatViewMode === 'messages' ? '' : 'hidden'}" aria-live="polite"></div>
            <div id="chatPublicPhotosView" class="${publicChatViewMode === 'photos' ? '' : 'hidden'}"></div>
          </div>
          <div id="chatPublicComposer" class="chatComposerWrap ${activeChatTab === 'public' ? '' : 'hidden'}">
            <div class="chatComposer chatComposerVoiceMode" id="publicVoiceComposer" data-voice-surface="public" data-voice-mode="idle">
              <div class="chatComposerMainRow" id="publicComposerMainRow">
                <input id="chatInput" type="text" class="chatInput" placeholder="Message drivers…" maxlength="600" />
                <button id="chatSendBtn" class="chipBtn" type="button">Send</button>
                <button id="chatPublicPhotoBtn" class="chipBtn chatMediaInlineBtn" type="button" title="Upload photo">📷</button>
                <button id="publicVoiceStartBtn" class="chatVoiceInlineBtn" type="button" aria-label="Record voice note" data-chat-voice-trigger="1">🎤</button>
                <input id="chatPublicPhotoInput" type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden />
              </div>
              <div class="chatVoicePopoverHost chatVoicePopoverHostInline" id="publicVoiceHost" hidden data-voice-surface="public">
                <div class="chatVoiceActiveStrip" id="publicVoiceActiveStrip" hidden></div>
                <div class="chatVoiceLoading" id="publicVoiceUpload" hidden></div>
                <div class="chatVoiceError" id="publicVoiceError" hidden></div>
                <span id="publicVoiceStatus" class="chatVoiceSrOnly" aria-live="polite">${CHAT_VOICE_IDLE_STATUS}</span>
                <span id="publicVoiceTimer" class="chatVoiceSrOnly">0:00</span>
              </div>
            </div>
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
    const body = msg?.text || msg?.message || msg?.audioUrl || msg?.imageUrl || '';
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

  function chatRetentionMsForScope(scope = 'public') {
    if (scope === 'private' || scope === 'profile-dm') return PRIVATE_CHAT_RETENTION_MS;
    return CHAT_RETENTION_MS;
  }

  function isMessageExpired(message, now = Date.now(), scope = 'public') {
    const createdAtMs = parseChatCreatedAtMs(message?.createdAt || message?.created_at || null);
    if (!Number.isFinite(createdAtMs)) return false;
    return createdAtMs <= (now - chatRetentionMsForScope(scope));
  }

  function pruneExpiredMessageList(list, now = Date.now(), scope = 'public') {
    const source = Array.isArray(list) ? list : [];
    const kept = [];
    const removed = [];
    source.forEach((message) => {
      if (isMessageExpired(message, now, scope)) removed.push(message);
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

  function pruneExpiredImageAssets(removedMessages = []) {
    const removed = Array.isArray(removedMessages) ? removedMessages : [];
    if (!removed.length) return;
    removed.forEach((message) => {
      const messageId = parseMessageId(message?.id);
      if (messageId === null) return;
      releaseImageBlobUrl(messageId, String(message?.imageUrl || '').trim());
    });
  }

  function pruneExpiredChatState() {
    const now = Date.now();
    const removedMessages = [];

    const publicResult = pruneExpiredMessageList(publicChatMessages, now, 'public');
    publicChatMessages = publicResult.kept;
    removedMessages.push(...publicResult.removed);

    const retainedThreadIds = new Set(privateBackendThreadIds || []);
    const nextPrivateMessages = Object.create(null);
    Object.entries(privateMessagesByUserId || {}).forEach(([uid, list]) => {
      const result = pruneExpiredMessageList(list, now, 'private');
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
        previewText: latest?.messageType === 'voice'
          ? '🎤 Voice note'
          : (messageHasImage(latest) ? '🖼 Photo' : String(latest?.text || thread?.previewText || '').trim()),
        lastAt: latest?.createdAt || thread?.lastAt || null,
        lastSenderUserId: latest?.senderUserId || thread?.lastSenderUserId || null,
        unreadCount: Number(privateUnreadByUserId[uid] || 0),
      });
    });
    privateThreads = nextThreads.sort((a, b) => String(privateThreadTime(b)).localeCompare(String(privateThreadTime(a))));

    if (driverProfileState && Array.isArray(driverProfileState.messages)) {
      const driverResult = pruneExpiredMessageList(driverProfileState.messages, now, 'profile-dm');
      driverProfileState.messages = driverResult.kept;
      removedMessages.push(...driverResult.removed);
      driverProfileState.latestMessageId = driverProfileState.messages.reduce((max, msg) => Math.max(max, Number(msg?.id || 0)), 0) || null;
    }

    pruneExpiredVoiceAssets(removedMessages);
    pruneExpiredImageAssets(removedMessages);
    pruneVoiceAssetCache();
    pruneImageAssetCache();

    const latestPublicId = publicChatMessages.reduce((max, msg) => Math.max(max, Number(msg?.id || 0)), 0) || null;
    chatLatestMessageId = latestPublicId;
    chatLastSeen = publicChatMessages.length ? chatMsgCursor(publicChatMessages[publicChatMessages.length - 1]) : null;
    chatSeenKeys = new Set(publicChatMessages.map((msg) => chatMsgKey(msg)));
    rebuildUnreadBadgeFromMessages(publicChatMessages);
    renderPrivateTabUnread();
  }

  function getMessageMergeKey(msg) {
    if (msg?.id != null) return `id:${msg.id}`;
    return `fallback:${msg?.createdAt || ''}|${msg?.senderUserId || msg?.userId || ''}|${msg?.recipientUserId || ''}|${msg?.text || ''}|${msg?.audioUrl || ''}|${msg?.imageUrl || ''}`;
  }

  function buildMessageRenderSignature(messages = []) {
    const list = Array.isArray(messages) ? messages : [];
    return list.map((msg) => {
      const id = msg?.id == null ? '' : String(msg.id);
      const key = getMessageMergeKey(msg);
      const type = String(msg?.messageType || '');
      const audioUrl = String(msg?.audioUrl || '');
      const imageUrl = String(msg?.imageUrl || '');
      const text = String(msg?.text || '');
      return `${id}|${key}|${type}|${audioUrl}|${imageUrl}|${text}`;
    }).join('||');
  }

  function markChatScrollActive(scope, userId = '') {
    const until = Date.now() + 260;
    if (scope === 'public') {
      chatScrollRuntime.publicActiveUntil = until;
      return;
    }
    if (scope === 'profile-dm') {
      chatScrollRuntime.profileActiveUntil = until;
      return;
    }
    const uid = String(userId || '');
    if (uid) chatScrollRuntime.privateActiveUntilByUserId[uid] = until;
  }

  function isChatScrollActive(scope, userId = '') {
    const now = Date.now();
    if (scope === 'public') return now < Number(chatScrollRuntime.publicActiveUntil || 0);
    if (scope === 'profile-dm') return now < Number(chatScrollRuntime.profileActiveUntil || 0);
    const uid = String(userId || '');
    return uid ? now < Number(chatScrollRuntime.privateActiveUntilByUserId[uid] || 0) : false;
  }

  function queueDeferredChatRenderFlush(scope, userId = '') {
    const delay = 280;
    if (scope === 'public') {
      if (chatScrollRuntime.pendingPublicRender?.timer) clearTimeout(chatScrollRuntime.pendingPublicRender.timer);
      if (!chatScrollRuntime.pendingPublicRender) chatScrollRuntime.pendingPublicRender = {};
      chatScrollRuntime.pendingPublicRender.timer = setTimeout(() => {
        if (isChatScrollActive('public')) return;
        const pending = chatScrollRuntime.pendingPublicRender?.messages;
        chatScrollRuntime.pendingPublicRender = null;
        if (pending) renderChatMessages(pending, { replace: true, forceStickToBottom: false, source: 'deferred' });
      }, delay);
      return;
    }
    if (scope === 'profile-dm') {
      if (chatScrollRuntime.pendingProfileRender?.timer) clearTimeout(chatScrollRuntime.pendingProfileRender.timer);
      if (!chatScrollRuntime.pendingProfileRender) chatScrollRuntime.pendingProfileRender = {};
      chatScrollRuntime.pendingProfileRender.timer = setTimeout(() => {
        if (isChatScrollActive('profile-dm')) return;
        const pending = chatScrollRuntime.pendingProfileRender?.messages;
        chatScrollRuntime.pendingProfileRender = null;
        if (pending) updateDriverProfileDmList(pending);
      }, delay);
      return;
    }
    const uid = String(userId || '');
    if (!uid) return;
    const existing = chatScrollRuntime.pendingPrivateRenderByUserId[uid];
    chatScrollRuntime.pendingPrivateRenderByUserId[uid] = {
      ...(existing || {}),
      messages: existing?.messages,
      timer: setTimeout(() => {
        if (isChatScrollActive('private', uid)) return;
        const pending = chatScrollRuntime.pendingPrivateRenderByUserId[uid]?.messages;
        delete chatScrollRuntime.pendingPrivateRenderByUserId[uid];
        if (pending && privateActiveUserId === uid) renderPrivateConversation();
      }, delay),
    };
    if (existing?.timer) clearTimeout(existing.timer);
  }

  function bindChatScrollActivity(listEl, scope, userId = '') {
    if (!listEl || listEl.dataset.chatScrollBound === '1') return;
    listEl.dataset.chatScrollBound = '1';
    const mark = () => {
      markChatScrollActive(scope, userId);
      queueDeferredChatRenderFlush(scope, userId);
    };
    listEl.addEventListener('scroll', mark, { passive: true });
    listEl.addEventListener('touchstart', mark, { passive: true });
    listEl.addEventListener('touchmove', mark, { passive: true });
    listEl.addEventListener('wheel', mark, { passive: true });
  }

  function messageCompletenessScore(msg) {
    let score = 0;
    if (parseMessageId(msg?.id) !== null) score += 10;
    if (String(msg?.text || '').trim()) score += 1;
    if (String(msg?.createdAt || '').trim()) score += 1;
    if (String(msg?.displayName || '').trim()) score += 1;
    if (normalizeMessageType(msg?.messageType, msg?.audioUrl ? 'voice' : 'text') === 'voice') score += 2;
    if (String(msg?.audioUrl || '').trim()) score += 6;
    if (String(msg?.imageUrl || '').trim()) score += 6;
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
      messageType: normalizeMessageType(preferred?.messageType || fallback?.messageType, preferred?.imageUrl || fallback?.imageUrl ? 'image' : (preferred?.audioUrl || fallback?.audioUrl ? 'voice' : 'text')),
      text: String(preferred?.text || fallback?.text || '').trim(),
      createdAt: preferred?.createdAt || fallback?.createdAt || null,
      isOwn: preferred?.isOwn === true || fallback?.isOwn === true,
      displayName: String(preferred?.displayName || fallback?.displayName || 'Driver').trim() || 'Driver',
      audioUrl: String(preferred?.audioUrl || fallback?.audioUrl || '').trim(),
      imageUrl: String(preferred?.imageUrl || fallback?.imageUrl || '').trim(),
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
    const photoMessages = (Array.isArray(messages) ? messages : []).filter((msg) => messageHasImage(msg));
    if (photoMessages.length) {
      publicPhotoItems = upsertChatMessages(publicPhotoItems, photoMessages).sort(compareChatMessages).reverse();
      const oldest = publicPhotoItems[publicPhotoItems.length - 1];
      publicPhotoBeforeId = oldest?.id ?? publicPhotoBeforeId;
      renderPublicPhotosView();
    }
    pruneExpiredChatState();
    pruneVoiceAssetCache();
    return publicChatMessages;
  }

  function mergePrivateMessages(otherUserId, messages = []) {
    const uid = String(otherUserId || '');
    if (!uid) return [];
    privateMessagesByUserId[uid] = upsertChatMessages(privateMessagesByUserId[uid] || [], messages);
    const photoMessages = (Array.isArray(messages) ? messages : []).filter((msg) => messageHasImage(msg));
    if (photoMessages.length) {
      privatePhotoItemsByUserId[uid] = upsertChatMessages(privatePhotoItemsByUserId[uid] || [], photoMessages).sort(compareChatMessages).reverse();
      const oldest = (privatePhotoItemsByUserId[uid] || [])[privatePhotoItemsByUserId[uid].length - 1];
      privatePhotoBeforeIdByUserId[uid] = oldest?.id ?? privatePhotoBeforeIdByUserId[uid] ?? null;
      if (privateActiveUserId === uid) renderPrivatePhotosView(uid);
    }
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
      previewText: latest?.messageType === 'voice'
        ? '🎤 Voice note'
        : (messageHasImage(latest) ? '🖼 Photo' : String(latest?.text || existing?.previewText || '').trim()),
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

  async function chatFetchPrivateDirectory({ q = '', limit = 50, offset = 0 } = {}) {
    const token = getCommunityToken();
    if (!token) return { items: [], limit: Number(limit) || 50, offset: Number(offset) || 0, has_more: false, query: String(q || '') };
    const qs = new URLSearchParams();
    qs.set('q', String(q || '').trim());
    qs.set('limit', String(Math.max(1, Number(limit) || 50)));
    qs.set('offset', String(Math.max(0, Number(offset) || 0)));
    const data = await getJSONAuth(`/chat/private/users?${qs.toString()}`, token);
    const rawItems = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);
    const items = rawItems
      .map((item) => {
        const id = item?.id != null ? String(item.id) : '';
        if (!id) return null;
        return {
          id,
          display_name: String(item?.display_name || item?.displayName || item?.name || `Driver ${id}`).trim() || `Driver ${id}`,
        };
      })
      .filter(Boolean);
    return {
      items,
      limit: Math.max(1, Number(data?.limit ?? limit) || 50),
      offset: Math.max(0, Number(data?.offset ?? offset) || 0),
      has_more: !!data?.has_more,
      query: String(data?.query ?? q ?? ''),
    };
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

  function buildChatImageUploadFile(file) {
    const fallbackType = String(file?.type || 'image/jpeg').trim() || 'image/jpeg';
    const ext = fallbackType.includes('png')
      ? 'png'
      : (fallbackType.includes('webp')
        ? 'webp'
        : (fallbackType.includes('gif')
          ? 'gif'
          : 'jpg'));
    return file instanceof File ? file : new File([file], `photo-${Date.now()}.${ext}`, { type: fallbackType });
  }

  async function chatSendPublicImage(file, options = {}) {
    const token = getCommunityToken();
    if (!token) throw new Error('Not signed in');
    const room = String(options.room || CHAT_ROOM || 'global').trim() || 'global';
    const upload = buildChatImageUploadFile(file);
    const form = new FormData();
    form.append('file', upload, upload.name);
    const caption = String(options.caption || '').trim();
    if (caption) form.append('text', caption);
    return postMultipartAuth(`/chat/rooms/${encodeURIComponent(room)}/image`, form, token);
  }

  async function chatSendPrivateImage(otherUserId, file, options = {}) {
    const token = getCommunityToken();
    const uid = String(otherUserId || '').trim();
    if (!token || !uid) throw new Error('Private chat unavailable');
    const upload = buildChatImageUploadFile(file);
    const form = new FormData();
    form.append('file', upload, upload.name);
    const caption = String(options.caption || '').trim();
    if (caption) form.append('text', caption);
    return postMultipartAuth(`/chat/private/${encodeURIComponent(uid)}/image`, form, token);
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
      renderChatMessages(merged, { replace: true, forceStickToBottom: true });
      const latestVoice = appliedMessages.filter((msg) => msg.messageType === 'voice');
      if (latestVoice.length) {
        window.setTimeout(() => {
          void prefetchVoiceBlobUrls(latestVoice);
        }, 450);
      }
      if (isChatPanelOpen()) markChatReadThroughLatestLoaded();
      return merged;
    }
    const uid = String(options.otherUserId || '');
    const merged = mergePrivateMessages(uid, appliedMessages);
    privateUnreadByUserId[uid] = 0;
    privateUpsertThreadFromMessages(uid, merged, { displayName: options.displayName || privateActiveDisplayName || driverProfileState.displayName || '' });
    const latestVoice = appliedMessages.filter((msg) => msg.messageType === 'voice');
    if (latestVoice.length) {
      window.setTimeout(() => {
        void prefetchVoiceBlobUrls(latestVoice);
      }, 450);
    }
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
    if (newBtn) newBtn.addEventListener('click', () => { void openPrivateComposePicker(); });
  }

  function renderPrivateComposePicker() {
    const wrap = document.getElementById('chatPrivateWrap');
    if (!wrap) return;
    const query = String(privateDirectoryState.query || '');
    const hasQuery = query.trim().length > 0;
    const items = Array.isArray(privateDirectoryState.items) ? privateDirectoryState.items : [];
    const rows = items.map((item) => {
      const name = String(item?.display_name || 'Driver').trim() || 'Driver';
      const id = String(item?.id || '');
      const initials = name.slice(0, 2).toUpperCase();
      return `<button type="button" class="chatPrivateThreadRow" data-private-directory-user="${escapeHtml(id)}" data-private-directory-name="${escapeHtml(name)}"><span class="chatPrivateThreadAvatar">${escapeHtml(initials)}</span><span class="chatPrivateThreadBody"><span class="chatPrivateThreadName">${escapeHtml(name)}</span><span class="chatPrivateThreadPreview">ID: ${escapeHtml(id)}</span></span></button>`;
    }).join('');
    const emptyState = hasQuery ? 'No matching drivers' : 'No drivers available yet';
    const loadMoreDisabled = privateDirectoryState.loading ? 'disabled' : '';
    wrap.innerHTML = `<div class="chatPrivateThreadList"><div class="chatPrivateThreadToolbar"><button id="chatPrivateComposeBackBtn" class="chipBtn" type="button">Back</button></div><div class="chatComposer chatComposerPrivate"><input id="chatPrivateDirectoryInput" type="text" class="chatInput" placeholder="Search drivers by name…" value="${escapeHtml(query)}" maxlength="80"><button id="chatPrivateDirectorySearchBtn" class="chipBtn" type="button"${privateDirectoryState.loading ? ' disabled' : ''}>Search</button></div><div class="chatPrivateThreadToolbar"><button id="chatPrivateShowAllBtn" class="chipBtn" type="button"${privateDirectoryState.loading ? ' disabled' : ''}>Show all drivers</button></div>${privateDirectoryState.error ? `<div class="chatEmpty">${escapeHtml(privateDirectoryState.error)}</div>` : (rows || `<div class="chatEmpty">${escapeHtml(emptyState)}</div>`)}${privateDirectoryState.hasMore ? `<div class="chatPrivateThreadToolbar"><button id="chatPrivateDirectoryLoadMoreBtn" class="chipBtn" type="button" ${loadMoreDisabled}>${privateDirectoryState.loading ? 'Loading…' : 'Load more'}</button></div>` : ''}</div>`;

    const backBtn = document.getElementById('chatPrivateComposeBackBtn');
    if (backBtn) {
      backBtn.addEventListener('click', () => {
        privateDirectoryState.open = false;
        privateDirectoryState.error = '';
        renderPrivateThreadList();
      });
    }
    const searchBtn = document.getElementById('chatPrivateDirectorySearchBtn');
    const input = document.getElementById('chatPrivateDirectoryInput');
    const runSearch = async () => {
      const nextQuery = String(input?.value || '').trim();
      await openPrivateComposePicker({ query: nextQuery, loadAll: !nextQuery });
    };
    if (searchBtn) searchBtn.addEventListener('click', () => { void runSearch(); });
    if (input) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          void runSearch();
        }
      });
    }
    const showAllBtn = document.getElementById('chatPrivateShowAllBtn');
    if (showAllBtn) showAllBtn.addEventListener('click', () => { void openPrivateComposePicker({ loadAll: true }); });
    const loadMoreBtn = document.getElementById('chatPrivateDirectoryLoadMoreBtn');
    if (loadMoreBtn) loadMoreBtn.addEventListener('click', () => { void loadMorePrivateDirectoryResults(); });
    wrap.querySelectorAll('[data-private-directory-user]').forEach((button) => {
      button.addEventListener('click', () => {
        const userId = button.getAttribute('data-private-directory-user');
        const displayName = button.getAttribute('data-private-directory-name') || '';
        privateDirectoryState.open = false;
        privateDirectoryState.error = '';
        openPrivateConversation(userId, displayName);
      });
    });
  }

  async function openPrivateComposePicker({ query = '', loadAll = false } = {}) {
    const nextQuery = loadAll ? '' : String(query || '').trim();
    privateDirectoryState.open = true;
    privateDirectoryState.query = nextQuery;
    privateDirectoryState.loading = true;
    privateDirectoryState.error = '';
    privateDirectoryState.offset = 0;
    privateDirectoryState.items = [];
    privateDirectoryState.hasMore = false;
    renderPrivateComposePicker();
    try {
      const result = await chatFetchPrivateDirectory({
        q: nextQuery,
        limit: privateDirectoryState.limit,
        offset: 0,
      });
      privateDirectoryState.items = Array.isArray(result?.items) ? result.items : [];
      privateDirectoryState.offset = Number(result?.offset || 0);
      privateDirectoryState.limit = Math.max(1, Number(result?.limit || privateDirectoryState.limit) || 50);
      privateDirectoryState.hasMore = !!result?.has_more;
      privateDirectoryState.query = String(result?.query ?? nextQuery ?? '');
    } catch (err) {
      console.warn('private directory fetch failed', err);
      privateDirectoryState.error = err?.message || 'Unable to load drivers.';
    } finally {
      privateDirectoryState.loading = false;
      if (privateDirectoryState.open) renderPrivateComposePicker();
    }
  }

  async function loadMorePrivateDirectoryResults() {
    if (!privateDirectoryState.open || privateDirectoryState.loading || !privateDirectoryState.hasMore) return;
    privateDirectoryState.loading = true;
    privateDirectoryState.error = '';
    renderPrivateComposePicker();
    const nextOffset = Number(privateDirectoryState.offset || 0) + Number(privateDirectoryState.limit || 50);
    try {
      const result = await chatFetchPrivateDirectory({
        q: String(privateDirectoryState.query || ''),
        limit: privateDirectoryState.limit,
        offset: nextOffset,
      });
      const appended = Array.isArray(result?.items) ? result.items : [];
      privateDirectoryState.items = privateDirectoryState.items.concat(appended);
      privateDirectoryState.offset = Number(result?.offset || nextOffset);
      privateDirectoryState.limit = Math.max(1, Number(result?.limit || privateDirectoryState.limit) || 50);
      privateDirectoryState.hasMore = !!result?.has_more;
    } catch (err) {
      console.warn('private directory load-more failed', err);
      privateDirectoryState.error = err?.message || 'Unable to load more drivers.';
    } finally {
      privateDirectoryState.loading = false;
      if (privateDirectoryState.open) renderPrivateComposePicker();
    }
  }

  function renderPrivateConversationMessages(messages) {
    return (messages || []).map((msg) => renderPrivateConversationRow(msg, 'private')).join('');
  }

  function renderPhotoGallery(items = [], emptyText = 'No photos yet.', { scope = 'public', source = 'photos', userId = '' } = {}) {
    if (!Array.isArray(items) || !items.length) return `<div class="chatEmpty">${escapeHtml(emptyText)}</div>`;
    return `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;">${items.map((msg) => {
      const rawImageUrl = String(msg?.imageUrl || '').trim();
      const cacheEntry = imageAssetCache.get(getImageAssetCacheKey(msg));
      const initialSrc = cacheEntry?.status === 'ready' && cacheEntry?.blobUrl ? String(cacheEntry.blobUrl) : '';
      const label = escapeHtml(formatChatTime(msg?.createdAt) || '');
      const sender = escapeHtml(String(msg?.displayName || 'Driver').trim() || 'Driver');
      return `<button type="button" class="chatPhotoTile" data-chat-image-viewer="1" data-message-id="${escapeHtml(String(msg?.id ?? ''))}" data-image-url="${escapeHtml(rawImageUrl)}" data-photo-scope="${escapeHtml(String(scope || 'public'))}" data-photo-source="${escapeHtml(String(source || 'photos'))}" data-photo-user-id="${escapeHtml(String(userId || ''))}" style="padding:0;border:0;background:none;cursor:pointer;"><img src="${escapeHtml(initialSrc)}" alt="Chat photo" loading="lazy" data-chat-image="1" data-message-id="${escapeHtml(String(msg?.id ?? ''))}" data-image-url="${escapeHtml(rawImageUrl)}" data-image-mime-type="${escapeHtml(String(msg?.imageMimeType || ''))}" data-created-at="${escapeHtml(String(msg?.createdAt || ''))}" style="width:100%;height:110px;object-fit:cover;border-radius:10px;display:block;" /><span style="display:block;font-size:11px;font-weight:800;opacity:.85;margin-top:3px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${sender}</span><span style="display:block;font-size:11px;opacity:.75;margin-top:1px;text-align:left;">${label}</span></button>`;
    }).join('')}</div>`;
  }

  function updatePublicModeButtons() {
    const messagesBtn = document.getElementById('chatPublicModeMessages');
    const photosBtn = document.getElementById('chatPublicModePhotos');
    messagesBtn?.classList.toggle('active', publicChatViewMode === 'messages');
    photosBtn?.classList.toggle('active', publicChatViewMode === 'photos');
  }

  function updatePrivateModeButtons(uid) {
    const mode = privateChatViewModeByUserId[uid] || 'messages';
    const messagesBtn = document.getElementById('chatPrivateModeMessages');
    const photosBtn = document.getElementById('chatPrivateModePhotos');
    messagesBtn?.classList.toggle('active', mode === 'messages');
    photosBtn?.classList.toggle('active', mode === 'photos');
  }

  function renderPublicPhotosView() {
    const wrap = document.getElementById('chatPublicPhotosView');
    if (!wrap) return;
    wrap.innerHTML = `${renderPhotoGallery(publicPhotoItems, 'No public photos yet.', { scope: 'public', source: 'photos' })}${publicPhotoHasMore ? '<div style="margin-top:8px;"><button id="chatPublicPhotosLoadMore" class="chipBtn" type="button">Load more</button></div>' : ''}`;
    bindChatImageViewer(wrap);
    bindRenderedChatImages(wrap);
    const loadMoreBtn = document.getElementById('chatPublicPhotosLoadMore');
    if (loadMoreBtn && loadMoreBtn.dataset.bound !== '1') {
      loadMoreBtn.dataset.bound = '1';
      loadMoreBtn.addEventListener('click', async () => {
        if (!publicPhotoHasMore) return;
        const result = await chatFetchPublicImages({ limit: 50, beforeId: publicPhotoBeforeId || null });
        publicPhotoItems = upsertChatMessages(publicPhotoItems, result.items || []).sort(compareChatMessages).reverse();
        publicPhotoHasMore = !!result.hasMore;
        const oldest = publicPhotoItems[publicPhotoItems.length - 1];
        publicPhotoBeforeId = oldest?.id ?? publicPhotoBeforeId;
        renderPublicPhotosView();
      });
    }
  }

  function renderPrivatePhotosView(userId) {
    const uid = String(userId || '');
    const wrap = document.getElementById('chatPrivatePhotosView');
    if (!wrap || !uid) return;
    const items = privatePhotoItemsByUserId[uid] || [];
    const hasMore = !!privatePhotoHasMoreByUserId[uid];
    wrap.innerHTML = `${renderPhotoGallery(items, 'No private photos yet.', { scope: 'private', source: 'photos', userId: uid })}${hasMore ? '<div style="margin-top:8px;"><button id="chatPrivatePhotosLoadMore" class="chipBtn" type="button">Load more</button></div>' : ''}`;
    bindChatImageViewer(wrap);
    bindRenderedChatImages(wrap);
  }

  function bindPrivateConversationComposer(userId) {
    const sendBtn = document.getElementById('chatPrivateSendBtn');
    const input = document.getElementById('chatPrivateInput');
    const photoBtn = document.getElementById('chatPrivatePhotoBtn');
    const photoInput = document.getElementById('chatPrivatePhotoInput');
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
        rememberOutgoingDmEcho(text, userId);
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
    if (photoBtn && photoBtn.dataset.boundUserId !== String(userId || '')) {
      photoBtn.dataset.boundUserId = String(userId || '');
      photoBtn.addEventListener('click', () => photoInput?.click());
    }
    if (photoInput && photoInput.dataset.boundUserId !== String(userId || '')) {
      photoInput.dataset.boundUserId = String(userId || '');
      photoInput.addEventListener('change', async () => {
        const file = photoInput.files && photoInput.files[0];
        if (!file || !userId) return;
        photoBtn.disabled = true;
        try {
          const response = await chatSendPrivateImage(userId, file);
          const sent = normalizePrivateMessagesPayload(response);
          if (sent.length) mergePrivateMessages(userId, sent);
          else await chatPollPrivateActiveThread({ visible: true, forceFull: false });
          renderPrivateConversation();
        } catch (err) {
          console.warn('private image send failed', err);
          alert(err?.message || 'Photo failed to send.');
        } finally {
          photoInput.value = '';
          photoBtn.disabled = false;
        }
      });
    }
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
      wrap.innerHTML = `<div class="chatPrivateConversation"><div class="chatPrivateHeader"><button id="chatPrivateBackBtn" class="chatPrivateBackBtn" type="button">Back</button><div class="chatPrivateTitle">${escapeHtml(privateActiveDisplayName || 'Private chat')}</div></div><div class="chatSubTabs" style="display:flex;gap:8px;margin-bottom:8px;"><button id="chatPrivateModeMessages" class="chipBtn" type="button">Messages</button><button id="chatPrivateModePhotos" class="chipBtn" type="button">Photos</button></div><div id="chatPrivateConversationList" class="chatList"></div><div id="chatPrivatePhotosView" class="hidden"></div><div class="chatComposer chatComposerPrivate chatComposerVoiceMode" id="privateVoiceComposer" data-voice-surface="private" data-voice-mode="idle"><div class="chatComposerMainRow" id="privateComposerMainRow"><input id="chatPrivateInput" type="text" class="chatInput" placeholder="Message privately…" maxlength="600"><button id="chatPrivateSendBtn" class="chipBtn" type="button">Send</button><button id="chatPrivatePhotoBtn" class="chipBtn chatMediaInlineBtn" type="button" title="Upload photo">📷</button><button id="privateVoiceStartBtn" class="chatVoiceInlineBtn" type="button" aria-label="Record voice note" data-chat-voice-trigger="1">🎤</button><input id="chatPrivatePhotoInput" type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden></div><div class="chatVoicePopoverHost chatVoicePopoverHostInline" id="privateVoiceHost" hidden data-voice-surface="private"><div class="chatVoiceActiveStrip" id="privateVoiceActiveStrip" hidden></div><div class="chatVoiceLoading" id="privateVoiceUpload" hidden></div><div class="chatVoiceError" id="privateVoiceError" hidden></div><span id="privateVoiceStatus" class="chatVoiceSrOnly" aria-live="polite">${CHAT_VOICE_IDLE_STATUS}</span><span id="privateVoiceTimer" class="chatVoiceSrOnly">0:00</span></div></div></div>`;
    } else {
      const titleEl = wrap.querySelector('.chatPrivateTitle');
      if (titleEl) titleEl.textContent = privateActiveDisplayName || 'Private chat';
    }
    const list = document.getElementById('chatPrivateConversationList');
    bindChatScrollActivity(list, 'private', privateActiveUserId);
    const mode = privateChatViewModeByUserId[privateActiveUserId] || 'messages';
    privateChatViewModeByUserId[privateActiveUserId] = mode;
    const uid = String(privateActiveUserId || '');
    if (isChatScrollActive('private', uid)) {
      if (!chatScrollRuntime.pendingPrivateRenderByUserId[uid]) chatScrollRuntime.pendingPrivateRenderByUserId[uid] = {};
      chatScrollRuntime.pendingPrivateRenderByUserId[uid].messages = messages;
      queueDeferredChatRenderFlush('private', uid);
      return;
    }
    const nextSignature = buildMessageRenderSignature(messages);
    const lastSignatureUserId = String(list?.dataset.renderSignatureUserId || '');
    if (list && lastSignatureUserId !== uid) list.dataset.renderSignature = '';
    const lastSignature = String(list?.dataset.renderSignature || '');
    if (lastSignature === nextSignature) return;
    void preserveVoicePlaybackAcrossRender(() => {
      reconcileMessageList(list, messages, {
        scope: 'private',
        rowRenderer: renderPrivateConversationRow,
        replace: true,
        emptyHtml: '<div class="chatEmpty">No messages yet.</div>',
      });
    });
    if (list) {
      list.dataset.renderSignature = nextSignature;
      list.dataset.renderSignatureUserId = uid;
    }
    if (list) {
      if (shouldStickToBottom || !prevList) list.scrollTop = list.scrollHeight;
      else list.scrollTop = preserveScrollTop;
    }
    renderPrivatePhotosView(privateActiveUserId);
    syncPrivateChatModeUi(privateActiveUserId);
    const messagesBtn = document.getElementById('chatPrivateModeMessages');
    const photosBtn = document.getElementById('chatPrivateModePhotos');
    if (messagesBtn && messagesBtn.dataset.boundUserId !== String(privateActiveUserId)) {
      messagesBtn.dataset.boundUserId = String(privateActiveUserId);
      messagesBtn.addEventListener('click', () => {
        privateChatViewModeByUserId[privateActiveUserId] = 'messages';
        syncPrivateChatModeUi(privateActiveUserId);
      });
    }
    if (photosBtn && photosBtn.dataset.boundUserId !== String(privateActiveUserId)) {
      photosBtn.dataset.boundUserId = String(privateActiveUserId);
      photosBtn.addEventListener('click', async () => {
        privateChatViewModeByUserId[privateActiveUserId] = 'photos';
        await ensurePrivatePhotoCache(privateActiveUserId);
        renderPrivatePhotosView(privateActiveUserId);
        syncPrivateChatModeUi(privateActiveUserId);
      });
    }
    const loadMoreBtn = document.getElementById('chatPrivatePhotosLoadMore');
    if (loadMoreBtn && loadMoreBtn.dataset.boundUserId !== String(privateActiveUserId)) {
      loadMoreBtn.dataset.boundUserId = String(privateActiveUserId);
      loadMoreBtn.addEventListener('click', async () => {
        const uid = String(privateActiveUserId || '');
        if (!uid || !privatePhotoHasMoreByUserId[uid]) return;
        const result = await chatFetchPrivateImages(uid, { limit: 50, beforeId: privatePhotoBeforeIdByUserId[uid] || null });
        privatePhotoItemsByUserId[uid] = upsertChatMessages(privatePhotoItemsByUserId[uid] || [], result.items || []).sort(compareChatMessages).reverse();
        privatePhotoHasMoreByUserId[uid] = !!result.hasMore;
        const oldest = (privatePhotoItemsByUserId[uid] || [])[privatePhotoItemsByUserId[uid].length - 1];
        privatePhotoBeforeIdByUserId[uid] = oldest?.id ?? privatePhotoBeforeIdByUserId[uid] ?? null;
        renderPrivatePhotosView(uid);
      });
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
    bindChatImageViewer(wrap);
    bindRenderedChatImages(wrap);
    void prefetchVoiceBlobUrls(messages.filter((msg) => msg?.messageType === 'voice'));
  }

  function updateDriverProfileDmList(messages = driverProfileState.messages || []) {
    pruneExpiredChatState();
    const dmList = document.getElementById('driverProfileDmList');
    if (!dmList) return false;
    bindChatScrollActivity(dmList, 'profile-dm');
    if (isChatScrollActive('profile-dm')) {
      if (!chatScrollRuntime.pendingProfileRender) chatScrollRuntime.pendingProfileRender = {};
      chatScrollRuntime.pendingProfileRender.messages = messages;
      queueDeferredChatRenderFlush('profile-dm');
      return false;
    }
    const nextSignature = buildMessageRenderSignature(messages);
    const lastSignature = String(dmList.dataset.renderSignature || '');
    if (lastSignature === nextSignature) return false;
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
    dmList.dataset.renderSignature = nextSignature;
    bindVoicePlayers(dmList);
    bindChatImageViewer(dmList);
    bindRenderedChatImages(dmList);
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
    privateDirectoryState.open = false;
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
    if (activeChatTab === 'private' && !privateActiveUserId) {
      if (privateDirectoryState.open) renderPrivateComposePicker();
      else renderPrivateThreadList();
    }
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
      } else if (privateDirectoryState.open) {
        renderPrivateComposePicker();
      } else {
        renderPrivateThreadList();
      }
      chatRefreshPrivateThreads();
    }
    renderPrivateTabUnread();
  }

  function promptNewPrivateMessageThread() {
    void openPrivateComposePicker();
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
    revokeImageBlobUrls();
    chatLastReadId = loadChatLastReadId();
    chatSeenKeys = new Set();
    unreadChatCount = 0;
    privateThreads = [];
    privateBackendThreadIds = new Set();
    privateActiveUserId = null;
    privateActiveDisplayName = '';
    publicChatViewMode = 'messages';
    privateChatViewModeByUserId = Object.create(null);
    publicPhotoItems = [];
    publicPhotoHasMore = false;
    publicPhotoBeforeId = null;
    privatePhotoItemsByUserId = Object.create(null);
    privatePhotoHasMoreByUserId = Object.create(null);
    privatePhotoBeforeIdByUserId = Object.create(null);
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
  function renderChatMessages(messages, { replace = false, forceStickToBottom = false } = {}) {
    pruneExpiredChatState();
    const listEl = document.getElementById('chatList');
    if (!listEl) return;
    bindChatScrollActivity(listEl, 'public');
    const nextMessages = Array.isArray(messages) ? messages.map((msg) => normalizePublicChatMessage(msg)) : [];
    if (!nextMessages.length) {
      if (replace) {
        chatSeenKeys = new Set();
        listEl.innerHTML = '';
        listEl.dataset.hasMessages = '0';
        listEl.dataset.renderSignature = '';
        setChatStatus('No messages yet.');
      }
      return;
    }
    if (isChatScrollActive('public') && !forceStickToBottom) {
      if (!chatScrollRuntime.pendingPublicRender) chatScrollRuntime.pendingPublicRender = {};
      chatScrollRuntime.pendingPublicRender.messages = nextMessages;
      queueDeferredChatRenderFlush('public');
      return;
    }
    const nextSignature = buildMessageRenderSignature(nextMessages);
    const lastSignature = String(listEl.dataset.renderSignature || '');
    if (lastSignature === nextSignature) return;
    const previousScrollTop = listEl.scrollTop;
    const nearBottom = isChatNearBottom(listEl, 80);
    void preserveVoicePlaybackAcrossRender(() => {
      if (replace) chatSeenKeys = new Set();
      reconcileMessageList(listEl, nextMessages, {
        scope: 'public',
        rowRenderer: renderPublicMessageRow,
        replace,
      });
    });
    listEl.dataset.renderSignature = nextSignature;
    nextMessages.forEach((msg) => {
      const key = chatMsgKey(msg);
      chatSeenKeys.add(key);
      const cursor = chatMsgCursor(msg);
      if (cursor !== null && cursor !== undefined) chatLastSeen = cursor;
      const id = messageNumericId(msg);
      if (id !== null) chatLatestMessageId = chatLatestMessageId === null ? id : Math.max(chatLatestMessageId, id);
    });
    bindVoicePlayers(listEl);
    bindChatImageViewer(listEl);
    bindRenderedChatImages(listEl);
    void prefetchVoiceBlobUrls(nextMessages.filter((msg) => msg.messageType === 'voice'));
    if (forceStickToBottom || nearBottom) listEl.scrollTop = listEl.scrollHeight;
    else listEl.scrollTop = previousScrollTop;
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

  function normalizeImageMessagesPayload(payload, scope = 'public') {
    const items = Array.isArray(payload?.items) ? payload.items : (Array.isArray(payload) ? payload : []);
    const normalized = items.map((raw) => (scope === 'private'
      ? normalizePrivateChatMessage(raw, currentChatSelfUserId())
      : normalizePublicChatMessage(raw)))
      .filter((msg) => messageHasImage(msg));
    return {
      items: normalized.sort(compareChatMessages).reverse(),
      hasMore: payload?.has_more === true || payload?.hasMore === true,
    };
  }

  async function chatFetchPublicImages({ limit = 50, beforeId = null } = {}) {
    const token = getCommunityToken();
    if (!token) return { items: [], hasMore: false };
    const qs = new URLSearchParams();
    qs.set('limit', String(Math.max(1, Number(limit) || 50)));
    if (beforeId !== null && beforeId !== undefined && String(beforeId).trim() !== '') qs.set('before_id', String(beforeId));
    const data = await getJSONAuth(`/chat/rooms/${encodeURIComponent(String(CHAT_ROOM || 'global'))}/images?${qs.toString()}`, token);
    return normalizeImageMessagesPayload(data, 'public');
  }

  async function chatFetchPrivateImages(otherUserId, { limit = 50, beforeId = null } = {}) {
    const token = getCommunityToken();
    const uid = String(otherUserId || '').trim();
    if (!token || !uid) return { items: [], hasMore: false };
    const qs = new URLSearchParams();
    qs.set('limit', String(Math.max(1, Number(limit) || 50)));
    if (beforeId !== null && beforeId !== undefined && String(beforeId).trim() !== '') qs.set('before_id', String(beforeId));
    const data = await getJSONAuth(`/chat/private/${encodeURIComponent(uid)}/images?${qs.toString()}`, token);
    return normalizeImageMessagesPayload(data, 'private');
  }

  async function ensureChatPanelInitialLoad() {
    if (chatInitialHistoryLoaded) {
      return { ok: true, reason: 'already_loaded', messages: publicChatMessages };
    }
    if (chatInitialLoadPromise) return chatInitialLoadPromise;

    chatInitialLoadPromise = (async () => {
      const result = await chatLoadInitial();
      return result;
    })().finally(() => {
      chatInitialLoadPromise = null;
    });

    return chatInitialLoadPromise;
  }

  async function chatLoadInitial() {
    chatInitialHistoryLoadAttempted = true;
    const result = await chatFetchMessages({ limit: 60 });
    if (!result?.ok) {
      if (result?.reason === 'not_ready') {
        setChatStatus('Loading chat...');
        return { ok: false, reason: 'not_ready', messages: [] };
      } else if (result?.reason === 'aborted') {
        return { ok: false, reason: 'aborted', messages: [] };
      } else {
        setChatStatus('Chat unavailable right now.');
        return { ok: false, reason: result?.reason || 'failed', messages: [] };
      }
    }
    const msgs = setPublicChatMessages(Array.isArray(result.messages) ? result.messages : []);
    seedChatIncomingAudioBaseline(msgs);
    renderChatMessages(msgs, { replace: true, forceStickToBottom: true });
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

  function syncPublicChatModeUi() {
    const list = document.getElementById('chatList');
    const photos = document.getElementById('chatPublicPhotosView');
    list?.classList.toggle('hidden', publicChatViewMode !== 'messages');
    photos?.classList.toggle('hidden', publicChatViewMode !== 'photos');
    updatePublicModeButtons();
  }

  function syncPrivateChatModeUi(userId) {
    const uid = String(userId || '');
    const mode = privateChatViewModeByUserId[uid] || 'messages';
    const list = document.getElementById('chatPrivateConversationList');
    const photos = document.getElementById('chatPrivatePhotosView');
    list?.classList.toggle('hidden', mode !== 'messages');
    photos?.classList.toggle('hidden', mode !== 'photos');
    updatePrivateModeButtons(uid);
  }

  async function ensurePublicPhotoCache({ force = false } = {}) {
    if (!force && publicPhotoItems.length) return;
    const result = await chatFetchPublicImages({ limit: 50, beforeId: null });
    publicPhotoItems = upsertChatMessages([], result.items || []).sort(compareChatMessages).reverse();
    publicPhotoHasMore = !!result.hasMore;
    const oldest = publicPhotoItems[publicPhotoItems.length - 1];
    publicPhotoBeforeId = oldest?.id ?? null;
  }

  async function ensurePrivatePhotoCache(userId, { force = false } = {}) {
    const uid = String(userId || '');
    if (!uid) return;
    if (!force && Array.isArray(privatePhotoItemsByUserId[uid]) && privatePhotoItemsByUserId[uid].length) return;
    const result = await chatFetchPrivateImages(uid, { limit: 50, beforeId: null });
    privatePhotoItemsByUserId[uid] = upsertChatMessages([], result.items || []).sort(compareChatMessages).reverse();
    privatePhotoHasMoreByUserId[uid] = !!result.hasMore;
    const oldest = (privatePhotoItemsByUserId[uid] || [])[privatePhotoItemsByUserId[uid].length - 1];
    privatePhotoBeforeIdByUserId[uid] = oldest?.id ?? null;
  }

  async function chatPollOnce() {
    if (chatPollInFlight) return;
    if (typeof authHeaderOK === 'function' && !authHeaderOK()) return;
    chatPollInFlight = true;
    try {
      const panelOpen = isChatPanelOpen();
      if (panelOpen && !chatInitialHistoryLoaded) {
        const initial = await ensureChatPanelInitialLoad();
        if (!initial?.ok) {
          if (initial?.reason === 'aborted') return;
          return;
        }
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
        if (loadedMsgs.length > 0) renderChatMessages(mergedMsgs, { replace: true, forceStickToBottom: false });
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
        ensureChatPanelInitialLoad().then((result) => {
          if (!result?.ok && result?.reason && result.reason !== 'not_ready' && result.reason !== 'aborted') {
            setChatStatus('Chat unavailable right now.');
          }
        }).catch((e) => {
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
    const publicPhotoBtn = document.getElementById('chatPublicPhotoBtn');
    const publicPhotoInput = document.getElementById('chatPublicPhotoInput');
    const publicModeMessages = document.getElementById('chatPublicModeMessages');
    const publicModePhotos = document.getElementById('chatPublicModePhotos');
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
          renderChatMessages(upsertPublicChatMessages(sentMessages), { replace: true, forceStickToBottom: true });
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
    if (publicModeMessages && publicModeMessages.dataset.bound !== '1') {
      publicModeMessages.dataset.bound = '1';
      publicModeMessages.addEventListener('click', () => {
        publicChatViewMode = 'messages';
        syncPublicChatModeUi();
      });
    }
    if (publicModePhotos && publicModePhotos.dataset.bound !== '1') {
      publicModePhotos.dataset.bound = '1';
      publicModePhotos.addEventListener('click', async () => {
        publicChatViewMode = 'photos';
        await ensurePublicPhotoCache();
        renderPublicPhotosView();
        syncPublicChatModeUi();
      });
    }
    if (publicPhotoBtn && publicPhotoBtn.dataset.bound !== '1') {
      publicPhotoBtn.dataset.bound = '1';
      publicPhotoBtn.addEventListener('click', () => publicPhotoInput?.click());
    }
    if (publicPhotoInput && publicPhotoInput.dataset.bound !== '1') {
      publicPhotoInput.dataset.bound = '1';
      publicPhotoInput.addEventListener('change', async () => {
        const file = publicPhotoInput.files && publicPhotoInput.files[0];
        if (!file) return;
        publicPhotoBtn.disabled = true;
        try {
          const response = await chatSendPublicImage(file, { room: CHAT_ROOM });
          const sentMessages = normalizePublicMessagesPayload(response);
          if (sentMessages.length > 0) {
            renderChatMessages(upsertPublicChatMessages(sentMessages), { replace: true, forceStickToBottom: true });
          } else {
            await chatPollOnce();
          }
        } catch (e) {
          console.warn('public image send failed:', e);
          alert(e?.message || 'Photo failed to send.');
        } finally {
          publicPhotoInput.value = '';
          publicPhotoBtn.disabled = false;
        }
      });
    }
    syncPublicChatModeUi();
    renderPublicPhotosView();
    bindVoicePlayers(document.getElementById('chatList') || document);
    bindChatImageViewer(document);
    bindRenderedChatImages(document);

    if (
      chatInitialHistoryLoaded
      && Array.isArray(publicChatMessages)
      && publicChatMessages.length > 0
    ) {
      renderChatMessages(publicChatMessages, { replace: true, forceStickToBottom: false });
      bindVoicePlayers(document.getElementById('chatList') || document);
      bindChatImageViewer(document);
      bindRenderedChatImages(document);
      scheduleChatPoll({ immediate: true });
      schedulePrivatePoll({ immediate: true });
      switchChatTab(activeChatTab);
      markChatReadThroughLatestLoaded();
      return;
    }

    ensureChatPanelInitialLoad()
      .then((result) => {
        if (result?.ok) return chatPollOnce();
        if (result?.reason === 'aborted') return null;
        setChatStatus('Chat unavailable right now.');
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


  function currentDriverProfileDmScope() {
    return dmEchoScopeKey();
  }

  function isSuppressedOutgoingDmEcho(msg) {
    pruneOutgoingEchoMap(recentOutgoingDmEchoes);
    const fp = makeOutgoingEchoFingerprint(
      msg?.text || msg?.message || '',
      msgUserId(msg) || currentChatSelfUserId()
    );
    if (!fp) return false;
    const selfUserId = String(currentChatSelfUserId() || '').trim();
    const senderUserId = String(msg?.senderUserId ?? msg?.sender_user_id ?? '').trim();
    const recipientUserId = String(msg?.recipientUserId ?? msg?.recipient_user_id ?? '').trim();
    let counterpartyUserId = '';
    if (selfUserId && senderUserId && senderUserId === selfUserId) counterpartyUserId = recipientUserId;
    else if (selfUserId && recipientUserId && recipientUserId === selfUserId) counterpartyUserId = senderUserId;
    else if (senderUserId && senderUserId !== selfUserId) counterpartyUserId = senderUserId;
    else if (recipientUserId && recipientUserId !== selfUserId) counterpartyUserId = recipientUserId;
    const scopeKey = dmEchoScopeKey(counterpartyUserId || null);
    return recentOutgoingDmEchoes.has(`${scopeKey}|${fp}`);
  }

  function scheduleDriverProfileDmPoll(opts = {}) { return window.TlcDriverProfileModule?.scheduleDriverProfileDmPoll?.(opts); }
  async function syncMyProgression(opts = {}) { return await window.TlcDriverProfileModule?.syncMyProgression?.(opts); }
  async function maybeSyncProgressionOnSignInState() { return await window.TlcDriverProfileModule?.maybeSyncProgressionOnSignInState?.(); }

  function getChatTransportDebugState() {
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
  }

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
    renderPrivateConversationRow,
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
    rememberOutgoingDmEcho,
    pruneOutgoingEchoMap,
    isOwnMessage,
    prefetchVoiceBlobUrls,
    isChatVoiceBusy,
    getVoiceRecorderState,
    leaderboardBadgeMeta: (...args) => window.leaderboardBadgeMeta?.(...args),
    leaderboardBadgePriority: (...args) => window.leaderboardBadgePriority?.(...args),
    normalizeLeaderboardBadge: (...args) => window.normalizeLeaderboardBadge?.(...args),
    formatBattleDate: (...args) => window.TlcGamesModule?.formatBattleDate?.(...args),
    formatBattlePct: (...args) => window.TlcGamesModule?.formatBattlePct?.(...args),
    defaultBattleStats: (...args) => window.TlcGamesModule?.defaultBattleStats?.(...args),
    battleResultLabel: (...args) => window.TlcGamesModule?.battleResultLabel?.(...args),
    updateDriverProfileDmList,
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
    chatSoundRuntime: { get: () => chatSoundRuntime },
    recentOutgoingDmEchoes: { get: () => recentOutgoingDmEchoes },
  });

  window.TlcChatCoreModule = {
    getCommunityToken,
    parseMessageId,
    formatChatTime,
    normalizePrivateMessagesPayload,
    renderPrivateConversationRow,
    chatFetchPrivateMessages,
    chatSendPrivateMessage,
    chatPanelHTML,
    wireChatPanel,
    syncChatPollingState,
    stopChatPolling,
    startChatPolling,
    chatResetState,
    openPrivateConversation,
    chatRefreshPrivateThreads,
    renderPrivateTabUnread,
    updateChatUnreadBadge,
    getChatTransportDebugState,
  };

  /* OWNER EXPORTS:
     app.part8.js is the single owner of chat + voice public globals.
     app.part2.js may provide compatibility wrappers, but ownership lives here.
  */
  window.chatPanelHTML = chatPanelHTML;
  window.wireChatPanel = wireChatPanel;
  window.syncChatPollingState = syncChatPollingState;
  window.stopChatPolling = stopChatPolling;
  window.startChatPolling = startChatPolling;
  window.chatResetState = chatResetState;
  window.getChatTransportDebugState = getChatTransportDebugState;

  /* OWNER READY HANDSHAKE:
     app.part8.js announces when chat + voice exports are fully ready.
  */
  function announceChatOwnerReady() {
    window.__TLC_CHAT_OWNER_READY__ = true;
    window.__TLC_CHAT_OWNER_READY_AT__ = Date.now();
    window.dispatchEvent(new CustomEvent("tlc-chat-owner-ready", {
      detail: {
        source: "app.part8.js",
        ready: true
      }
    }));
  }

  window.isTlcChatOwnerReady = function isTlcChatOwnerReady() {
    return !!(
      window.__TLC_CHAT_OWNER_READY__ &&
      typeof window.chatPanelHTML === "function" &&
      typeof window.wireChatPanel === "function" &&
      window.TlcChatCoreModule &&
      window.TlcChatVoiceModule
    );
  };

  let chatOwnerBootstrapped = false;

  /* OWNER BOOT:
     app.part8.js must bootstrap chat + voice exactly once.
     Do not scatter raw startup calls across the file.
  */
  function bootstrapChatOwnerOnce() {
    if (chatOwnerBootstrapped) return;
    chatOwnerBootstrapped = true;

    attachChatSoundStateHandlers();
    resetChatSoundLifecycle('module-init');
    reconcileChatSoundRuntime('module-init');
    bindChatSoundPrimeListeners();
    bindSharedVoicePlaybackEvents();
    bindChatFirstInteractionListeners();
  }

  window.isTlcChatOwnerBootstrapped = function isTlcChatOwnerBootstrapped() {
    return !!chatOwnerBootstrapped;
  };

  window.getTlcChatOwnerStatus = function getTlcChatOwnerStatus() {
    return {
      readyFlag: !!window.__TLC_CHAT_OWNER_READY__,
      readyAt: Number(window.__TLC_CHAT_OWNER_READY_AT__ || 0),
      bootstrapped: !!chatOwnerBootstrapped,
      hasChatPanelHTML: typeof window.chatPanelHTML === "function",
      hasWireChatPanel: typeof window.wireChatPanel === "function",
      hasChatCoreModule: !!window.TlcChatCoreModule,
      hasChatVoiceModule: !!window.TlcChatVoiceModule
    };
  };

  function bindDockChatButtonOnce() {
    const chatBtn = document.getElementById('dockChat');
    if (!chatBtn || chatBtn.dataset.tlcBoundChat === '1') return;
    if (typeof bindDockToggle !== 'function') return;
    chatBtn.dataset.tlcBoundChat = '1';
    bindDockToggle(chatBtn, 'chat', 'Chat', chatPanelHTML, wireChatPanel);
  }

  /* ISSUE NOTE:
     Chat must self-bind here as well as through app.part2 compatibility wrappers.
     Dataset guards prevent duplicate listeners.
  */
  bootstrapChatOwnerOnce();
  announceChatOwnerReady();
  bindDockChatButtonOnce();
  window.addEventListener('load', bindDockChatButtonOnce);
  window.addEventListener('pageshow', bindDockChatButtonOnce);
  window.addEventListener('focus', bindDockChatButtonOnce);
  setTimeout(bindDockChatButtonOnce, 0);
  setTimeout(bindDockChatButtonOnce, 400);
  setTimeout(bindDockChatButtonOnce, 1200);

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
    if (typeof authHeaderOK === 'function' && !authHeaderOK()) window.TlcMapIdentityModule?.clearMapIdentityTempState?.();
  };

  if (runtimePolling) {
    runtimePolling.setInterval('chat:auth-observer', observeChatAuthLoop, 2000);
    runtimePolling.setInterval('chat:identity-clear', clearIdentityLoop, 2500);
  } else {
    window.setInterval(observeChatAuthLoop, 2000);
    window.setInterval(clearIdentityLoop, 2500);
  }
})();
