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

  // Kill-feed bootstrap guard.
  // We seed startup history into seen-keys, then suppress feed replay until
  // one post-bootstrap poll has been absorbed as history too.
  let killFeedBootstrapReady = false;
  let killFeedBootstrapPollConsumed = false;

  function chatLastReadStorageKey() {
    return `tlc_chat_last_read_${CHAT_ROOM}`;
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

  // Remember which chat messages have been displayed in the kill feed.
  // Once a message has been shown, it will never appear again, even after it expires.
  const killFeedSeenKeys = new Set();
  const incomingNotifySeenKeys = new Set();

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

  let chatAudioCtx = null;
  let chatAudioUnlocked = false;
  let chatAudioUnlockBound = false;
  let chatAudioUnlockInFlight = false;
  const chatAudioSkipLogAt = new Map();

  function logChatAudioSkip(reason, extra = '') {
    const now = Date.now();
    const last = chatAudioSkipLogAt.get(reason) || 0;
    if (now - last < 4000) return;
    chatAudioSkipLogAt.set(reason, now);
    console.debug(`chat beep skipped: ${reason}${extra ? ` (${extra})` : ''}`);
  }

  function ensureChatAudioContext() {
    if (chatAudioCtx) return chatAudioCtx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    chatAudioCtx = new Ctx();
    return chatAudioCtx;
  }

  function removeChatAudioUnlockListeners() {
    if (!chatAudioUnlockBound) return;
    ['pointerdown', 'touchstart', 'click', 'keydown'].forEach((evtName) => {
      document.removeEventListener(evtName, onChatAudioUnlockInteraction, true);
    });
    chatAudioUnlockBound = false;
  }

  function bindChatAudioUnlockListeners() {
    if (chatAudioUnlockBound) return;
    ['pointerdown', 'touchstart', 'click', 'keydown'].forEach((evtName) => {
      document.addEventListener(evtName, onChatAudioUnlockInteraction, { passive: true, capture: true });
    });
    chatAudioUnlockBound = true;
  }

  async function unlockChatAudio(trigger = 'interaction') {
    if (chatAudioUnlockInFlight) return;
    chatAudioUnlockInFlight = true;
    const ctx = ensureChatAudioContext();
    if (!ctx) {
      chatAudioUnlockInFlight = false;
      return;
    }
    try {
      if (ctx.state === 'suspended') await ctx.resume();
      const now = ctx.currentTime;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.00001, now);
      gain.connect(ctx.destination);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, now);
      osc.connect(gain);
      osc.start(now);
      osc.stop(now + 0.018);

      chatAudioUnlocked = ctx.state === 'running';
      if (chatAudioUnlocked) {
        removeChatAudioUnlockListeners();
      } else {
        logChatAudioSkip('suspended', trigger);
        bindChatAudioUnlockListeners();
      }
    } catch (err) {
      chatAudioUnlocked = false;
      logChatAudioSkip('locked', trigger || err?.message || 'unlock-failed');
      bindChatAudioUnlockListeners();
    } finally {
      chatAudioUnlockInFlight = false;
    }
  }

  function onChatAudioUnlockInteraction(evt) {
    unlockChatAudio(evt?.type || 'interaction');
  }

  function bindChatAudioUnlockTarget(el) {
    if (!el || el.dataset.chatAudioUnlockBound === '1') return;
    el.dataset.chatAudioUnlockBound = '1';
    ['pointerdown', 'touchstart', 'click', 'keydown'].forEach((evtName) => {
      el.addEventListener(evtName, () => unlockChatAudio(`ui:${el.id || el.className || evtName}`), { passive: true });
    });
  }

  function bindChatAudioUnlockTargets() {
    [
      'map',
      'dock',
      'dockChat',
      'dockGames',
      'dockModes',
      'dockColors',
      'dockMusic',
      'dockProfile',
      'dockDrawerClose',
      'btnLogin',
      'btnSignup',
      'btnAuth'
    ].forEach((id) => bindChatAudioUnlockTarget(document.getElementById(id)));
  }

  function rearmChatAudioUnlock() {
    chatAudioUnlocked = false;
    bindChatAudioUnlockListeners();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!chatAudioCtx || chatAudioCtx.state !== 'running') rearmChatAudioUnlock();
  });
  window.addEventListener('pageshow', () => {
    if (!chatAudioCtx || chatAudioCtx.state !== 'running') rearmChatAudioUnlock();
  });

  bindChatAudioUnlockTargets();
  rearmChatAudioUnlock();

  function playBeep() {
    const ctx = ensureChatAudioContext();
    if (!ctx) return;
    if (!chatAudioUnlocked) {
      logChatAudioSkip('locked');
      return;
    }
    if (ctx.state !== 'running') {
      chatAudioUnlocked = false;
      rearmChatAudioUnlock();
      logChatAudioSkip('suspended');
      return;
    }
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    gain.connect(ctx.destination);

    const osc1 = ctx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(740, now);
    osc1.frequency.exponentialRampToValueAtTime(880, now + 0.1);
    osc1.connect(gain);

    const osc2 = ctx.createOscillator();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(660, now + 0.105);
    osc2.frequency.exponentialRampToValueAtTime(990, now + 0.2);
    osc2.connect(gain);

    osc1.start(now);
    osc1.stop(now + 0.11);
    osc2.start(now + 0.105);
    osc2.stop(now + 0.22);
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

      // Determine if the chat panel is currently open
      if (incomingNotifySeenKeys.has(key)) {
        logChatAudioSkip('duplicate');
        return;
      }
      if (isOwnMessage(msg)) {
        logChatAudioSkip('own-message');
        return;
      }
      if (isChatPanelOpen()) {
        logChatAudioSkip('chat-open');
        return;
      }
      const msgId = messageNumericId(msg);
      if (msgId === null || chatLastReadId === null || msgId <= chatLastReadId) return;

      incomingNotifySeenKeys.add(key);
      unreadChatCount += 1;
      updateChatUnreadBadge();
      playBeep();
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
    incomingNotifySeenKeys.clear();
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
    listEl.dataset.hasMessages = '1';
    if (replace) listEl.innerHTML = '';
    listEl.appendChild(frag);
    if (nearBottom || replace) listEl.scrollTop = listEl.scrollHeight;
  }

  // Fetch messages. Only proceed if a token is present.
  async function chatFetchMessages({ after = null, limit = 50 } = {}) {
    const token = getCommunityToken();
    if (!token) return [];
    const qs = new URLSearchParams();
    qs.set('limit', String(limit));
    if (after !== null && after !== undefined && String(after).trim() !== '') {
      qs.set('after', String(after));
    }
    try {
      const data = await getJSONAuth(`/chat/rooms/${CHAT_ROOM}?${qs.toString()}`, token);
      return Array.isArray(data) ? data : data?.messages || [];
    } catch (err) {
      console.warn('chatFetchMessages failed', err);
      return [];
    }
  }

  // Load initial and new messages
  async function chatLoadInitial() {
    const msgs = await chatFetchMessages({ limit: 60 });
    renderChatMessages(msgs, { replace: true });
    // Initial history should never replay into kill feed notifications.
    seedKillFeedSeenKeys(msgs);
    killFeedBootstrapReady = true;
    if (chatLastReadId === null && chatLatestMessageId !== null) {
      saveChatLastReadId(chatLatestMessageId);
      clearChatUnreadBadge();
      return;
    }

    if (!Array.isArray(msgs) || !msgs.length) return;
    unreadChatCount = msgs.reduce((acc, msg) => (shouldCountUnread(msg, { ignoreOpenPanel: true }) ? acc + 1 : acc), 0);
    updateChatUnreadBadge();
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

      // Update the in-panel chat messages only if the chat panel is open.
      if (isChatPanelOpen()) {
        renderChatMessages(msgs);
        markChatReadThroughLatestLoaded();

        // Hide the kill feed when chat panel is open.
        if (killFeedContainer) killFeedContainer.style.display = 'none';
      } else {
        // Show the kill feed container.
        if (killFeedContainer) killFeedContainer.style.display = 'flex';

        // Guard against startup replay: absorb first post-bootstrap poll
        // as already-seen history, then allow only later unseen arrivals.
        if (killFeedBootstrapReady && !killFeedBootstrapPollConsumed) {
          seedKillFeedSeenKeys(msgs);
          killFeedBootstrapPollConsumed = true;
        } else if (killFeedBootstrapReady && killFeedBootstrapPollConsumed) {
          showKillFeed(msgs);
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
    } else {
      stopChatPolling();
    }
  }

  // Wire up the chat panel: event handlers, initial load, polling
  function wireChatPanel() {
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
        const msg = await chatSend(text);
        chatInput.value = '';
        if (msg) renderChatMessages(Array.isArray(msg) ? msg : [msg]);
        await chatPollOnce();
      } catch (e) {
        console.warn('chat send failed:', e);
        alert(e?.message || 'Message failed to send.');
      } finally {
        chatSendBtn.disabled = false;
      }
    };
    chatSendBtn.addEventListener('click', (e) => { e.preventDefault(); sendNow(); });
    chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendNow(); } });
    chatResetState();
    chatLoadInitial()
      .then(() => chatPollOnce())
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
    return {
      fontPx: +(8.8 + (16.8 - 8.8) * emphasize).toFixed(2),
      padY: +(0.95 + (4.8 - 0.95) * emphasize).toFixed(2),
      padX: +(2.6 + (9.8 - 2.6) * emphasize).toFixed(2),
      avatarPx: +(15 + (48 - 15) * emphasize).toFixed(2),
      maxWidthPx: +(88 + (190 - 88) * emphasize).toFixed(2),
      badgeMinWidthPx: +(12 + (22 - 12) * emphasize).toFixed(2),
      badgePadYPx: +(0.8 + (1.8 - 0.8) * emphasize).toFixed(2),
      badgePadXPx: +(2.4 + (5.2 - 2.4) * emphasize).toFixed(2),
      badgeFontPx: +(7.2 + (10.8 - 7.2) * emphasize).toFixed(2),
      crownFontPx: +(9 + (16 - 9) * emphasize).toFixed(2),
      arrowBodyPx: +(18 + (27 - 18) * t).toFixed(2),
      arrowLeftRightPx: +(4.5 + (7 - 4.5) * t).toFixed(2),
      arrowAccentPx: +(10 + (14 - 10) * t).toFixed(2)
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

  function mapMedalIconSVG(kind) {
    if (kind === 'silver') {
      return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 2h4l1 6H9z" fill="#9aa5ae"></path><path d="M13 2h4l-2 6h-3z" fill="#6f7d88"></path><circle cx="12" cy="15" r="6" fill="#dfe5ea" stroke="#8a98a3" stroke-width="1.2"></circle><circle cx="12" cy="15" r="3.2" fill="#f7fafc" opacity="0.8"></circle></svg>';
    }
    if (kind === 'bronze') {
      return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 2h4l1 6H9z" fill="#b46c3e"></path><path d="M13 2h4l-2 6h-3z" fill="#8f4f2b"></path><circle cx="12" cy="15" r="6" fill="#d08a55" stroke="#8f4f2b" stroke-width="1.2"></circle><circle cx="12" cy="15" r="3.2" fill="#efb27e" opacity="0.8"></circle></svg>';
    }
    return '';
  }

  function mapIdentityBadgeOverlayHTML({ badgeCode }) {
    const badge = normalizeLeaderboardBadge(badgeCode);
    if (!badge) return '';
    if (badge === 'crown') {
      return '<span class="mapIdentityCrownOverlay" aria-label="crown">👑</span>';
    }
    return `<span class="mapIdentityMedalOverlay mapIdentityMedal-${badge}" aria-label="${escapeHtml(badge)} medal">${mapMedalIconSVG(badge)}</span>`;
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

  function mapIdentityRenderSelfLabel({ name, avatarUrl, mode, zoom, leaderboardBadgeCode }) {
    const safeName = (String(name || 'Driver').trim() || 'Driver');
    const safeAvatar = safeMapAvatarUrl(avatarUrl);
    const cfg = mapIdentityVisualConfig(zoom);
    if (shouldUseAvatarLabel(mode, safeAvatar)) {
      return `<div class="selfIdentitySlot" data-map-identity-label="1">${mapIdentityAvatarLabelHTML(
        safeAvatar,
        'meAvatarBadge',
        `display:block;width:${cfg.avatarPx}px;height:${cfg.avatarPx}px;`,
        { badgeCode: leaderboardBadgeCode }
      )}</div>`;
    }
    return `<div class="selfIdentitySlot" data-map-identity-label="1">${mapIdentityOverlayWrapHTML(`<div id="navMeName" class="meName" style="display:${safeName ? 'block' : 'none'};font-size:${cfg.fontPx}px;padding:${cfg.padY}px ${cfg.padX}px;max-width:${cfg.maxWidthPx}px;">${escapeHtml(safeName)}</div>`, { badgeCode: leaderboardBadgeCode })}</div>`;
  }

  function mapIdentityOrbitStyleText(orbitMeta) {
    if (!orbitMeta || !Number.isFinite(Number(orbitMeta.count)) || Number(orbitMeta.count) <= 1) return '';
    const angleRad = (Number(orbitMeta.angleDeg) || 0) * (Math.PI / 180);
    const r = Math.max(0, Math.min(14, Number(orbitMeta.radiusPx) || 11));
    const dx = +(10 + Math.cos(angleRad) * r).toFixed(2);
    const dy = +(Math.sin(angleRad) * r).toFixed(2);
    return `--identity-slot-x:${dx}px;--identity-slot-y:calc(-50% + ${dy}px);`;
  }

  function mapIdentityRenderDriverLabel({ name, avatarUrl, mode, zoom, orbitMeta = null, leaderboardBadgeCode }) {
    const safeName = (String(name || 'Driver').trim() || 'Driver');
    const safeAvatar = safeMapAvatarUrl(avatarUrl);
    const cfg = mapIdentityVisualConfig(zoom);
    const orbitStyle = mapIdentityOrbitStyleText(orbitMeta);
    if (shouldUseAvatarLabel(mode, safeAvatar)) {
      return `<div class="otherDrvIdentitySlot" data-map-identity-label="1" style="${orbitStyle}">${mapIdentityAvatarLabelHTML(safeAvatar, 'otherDrvAvatarBadge', `width:${cfg.avatarPx}px;height:${cfg.avatarPx}px;`, { badgeCode: leaderboardBadgeCode })}</div>`;
    }
    return `<div class="otherDrvIdentitySlot" data-map-identity-label="1" style="${orbitStyle}">${mapIdentityOverlayWrapHTML(`<div class="otherDrvName" style="font-size:${cfg.fontPx}px;padding:${cfg.padY}px ${cfg.padX}px;max-width:${cfg.maxWidthPx}px;">${escapeHtml(safeName)}</div>`, { badgeCode: leaderboardBadgeCode })}</div>`;
  }

  function mapIdentityApplySelfOrbit(orbitMeta) {
    const slot = document.querySelector('#navWrap .selfIdentitySlot[data-map-identity-label="1"]');
    if (!slot) return;
    const styleText = mapIdentityOrbitStyleText(orbitMeta);
    if (!styleText) {
      slot.style.removeProperty('--identity-slot-x');
      slot.style.removeProperty('--identity-slot-y');
      return;
    }
    styleText.split(';').forEach((pair) => {
      const [k, v] = pair.split(':');
      if (k && v) slot.style.setProperty(k.trim(), v.trim());
    });
  }

  function mapIdentityApplyZoomStyles(zoomValue) {
    const cfg = mapIdentityVisualConfig(zoomValue);
    const rootStyle = document.documentElement?.style;
    if (rootStyle) {
      rootStyle.setProperty('--map-ident-arrow-body', `${cfg.arrowBodyPx}px`);
      rootStyle.setProperty('--map-ident-arrow-left-right', `${cfg.arrowLeftRightPx}px`);
      rootStyle.setProperty('--map-ident-arrow-accent', `${cfg.arrowAccentPx}px`);
      rootStyle.setProperty('--map-ident-badge-min-width', `${cfg.badgeMinWidthPx}px`);
      rootStyle.setProperty('--map-ident-badge-pad-y', `${cfg.badgePadYPx}px`);
      rootStyle.setProperty('--map-ident-badge-pad-x', `${cfg.badgePadXPx}px`);
      rootStyle.setProperty('--map-ident-badge-font', `${cfg.badgeFontPx}px`);
      rootStyle.setProperty('--map-ident-crown-font', `${cfg.crownFontPx}px`);
    }
    document.querySelectorAll('.otherDrvName, .meName').forEach((el) => {
      el.style.fontSize = `${cfg.fontPx}px`;
      el.style.padding = `${cfg.padY}px ${cfg.padX}px`;
      el.style.maxWidth = `${cfg.maxWidthPx}px`;
    });
    document.querySelectorAll('.otherDrvAvatarBadge, .meAvatarBadge').forEach((el) => {
      el.style.width = `${cfg.avatarPx}px`;
      el.style.height = `${cfg.avatarPx}px`;
    });
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
        await saveMapIdentityUpdate({ avatar_url: processed, map_identity_mode: MAP_IDENTITY_MODE_AVATAR });
        closeMapIdentityCropper();
      } catch (err) {
        alert(err?.message || 'Image processing failed.');
      }
    });
  }

  function mapIdentityCurrentState() {
    const meObj = (typeof window !== 'undefined' && window.me) ? window.me : {};
    return {
      mode: normalizeMapIdentityMode(meObj?.map_identity_mode),
      avatarUrl: safeMapAvatarUrl(meObj?.avatar_url) || mapIdentityTempAvatarDataUrl,
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
    mapIdentityTempAvatarDataUrl = '';
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
    const step = Math.max(120, Math.round(viewport.clientWidth * 0.62));
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

  setInterval(() => {
    if (typeof authHeaderOK === 'function' && !authHeaderOK()) clearMapIdentityTempState();
  }, 1500);
})();
