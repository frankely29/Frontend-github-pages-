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

  // Track whether the initial batch of chat messages has loaded.  We only
  // show kill‑feed notifications after the initial load completes.
  let initialChatLoaded = false;

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
  let chatAudioPromptEl = null;
  const chatAudioSkipLogAt = new Map();

  function logChatAudioSkip(reason, extra = '') {
    const now = Date.now();
    const last = chatAudioSkipLogAt.get(reason) || 0;
    if (now - last < 4000) return;
    chatAudioSkipLogAt.set(reason, now);
    console.debug(`chat beep skipped: ${reason}${extra ? ` (${extra})` : ''}`);
  }

  function ensureChatAudioPrompt() {
    if (chatAudioPromptEl) return chatAudioPromptEl;
    const el = document.createElement('div');
    el.id = 'chatAudioUnlockPrompt';
    el.textContent = 'Tap once to enable chat sound';
    Object.assign(el.style, {
      position: 'fixed',
      left: '50%',
      transform: 'translateX(-50%)',
      bottom: 'calc(env(safe-area-inset-bottom, 0px) + 92px)',
      zIndex: '6400',
      padding: '6px 10px',
      borderRadius: '999px',
      font: '700 11px/1.2 system-ui,-apple-system,Segoe UI,Roboto,Arial',
      color: 'rgba(14,14,14,0.92)',
      background: 'rgba(255,255,255,0.9)',
      border: '1px solid rgba(0,0,0,0.12)',
      boxShadow: '0 2px 10px rgba(0,0,0,0.12)',
      pointerEvents: 'none',
      opacity: '0',
      transition: 'opacity 120ms ease'
    });
    document.body.appendChild(el);
    chatAudioPromptEl = el;
    return el;
  }

  function setChatAudioPromptVisible(visible) {
    const el = ensureChatAudioPrompt();
    el.style.opacity = visible ? '1' : '0';
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
        setChatAudioPromptVisible(false);
      } else {
        logChatAudioSkip('suspended', trigger);
        bindChatAudioUnlockListeners();
        setChatAudioPromptVisible(true);
      }
    } catch (err) {
      chatAudioUnlocked = false;
      logChatAudioSkip('locked', trigger || err?.message || 'unlock-failed');
      bindChatAudioUnlockListeners();
      setChatAudioPromptVisible(true);
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
    setChatAudioPromptVisible(true);
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

        // After the initial load, display unseen messages in the feed.
        if (initialChatLoaded) showKillFeed(msgs);
      }

      // Mark the initial load complete after first call.
      if (!initialChatLoaded) initialChatLoaded = true;
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

  // Expose chat functions for app.js to call if needed
  window.chatPanelHTML = chatPanelHTML;
  window.wireChatPanel = wireChatPanel;
  window.syncChatPollingState = syncChatPollingState;
  window.stopChatPolling = stopChatPolling;
  window.startChatPolling = startChatPolling;
  window.chatResetState = chatResetState;

  // Bind the chat dock button using its ID
  if (typeof bindDockToggle === 'function') {
    const chatBtn = document.getElementById('dockChat');
    if (chatBtn) { bindDockToggle(chatBtn, 'chat', 'Chat', chatPanelHTML, wireChatPanel); }
  }

  // Example night mode toggle (optional)
  function toggleNightMode() { document.body.classList.toggle('night'); }
  window.toggleNightMode = toggleNightMode;
})();
