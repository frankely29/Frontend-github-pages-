/*
 * app.part2.js
 *
 * This file is reserved for future enhancements to the NYC TLC Hotspot Map.  By isolating
 * new functionality into a separate script, the main app.js can remain focused on core
 * map behavior (timeline, map rendering, presence, pickups, etc.) while additional
 * features are developed independently.  To enable this file, add a script tag to
 * your index.html after the main app.js tag:
 *   <script src="./app.part2.js"></script>
 *
 * Ensure that functions defined here do not conflict with existing global names in
 * app.js.  Use unique names or wrap your code in an IIFE (Immediately Invoked
 * Function Expression) to avoid polluting the global namespace.  For example:
 *
 * (function() {
 *   // Your code here
 * })();
 *
 * You can also attach functions to the `window` object to make them accessible
 * throughout the app.
 */

(function() {
  // Log to indicate that the second script has loaded successfully.
  console.log('app.part2.js loaded');

  /*
   * Chat implementation
   *
   * This module defines a new chat panel for the TLC map.  It replicates the
   * behavior of the original chat (message list, sending messages, polling
   * updates) but isolates the chat logic from app.js so that core map
   * functionality remains untouched.  The chat UI is rendered in the side
   * drawer via bindDockToggle and automatically polls for new messages when
   * the chat panel is open and the user is signed in.
   */

  // Define chat constants.  These can be overridden by defining
  // window.CHAT_ROOM or window.CHAT_POLL_MS before this script runs.
  const CHAT_ROOM = typeof window !== 'undefined' && window.CHAT_ROOM ? window.CHAT_ROOM : 'global';
  const CHAT_POLL_MS = typeof window !== 'undefined' && window.CHAT_POLL_MS ? window.CHAT_POLL_MS : 1200;

  // Internal chat state
  let chatPollTimer = null;
  let chatLastSeen = null;
  let chatSeenKeys = new Set();

  /**
   * Returns the HTML markup for the chat panel.  If the user is not signed
   * in (authHeaderOK() returns false), a sign-in prompt is displayed.  When
   * signed in, the panel contains a scrollable list of messages and a
   * composer for sending messages.
   */
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

  /**
   * Extract a cursor identifier from a chat message.  Messages returned from
   * the server may include an id or a timestamp; the cursor allows the
   * frontend to request new messages after the last seen message.
   */
  function chatMsgCursor(msg) {
    return msg?.id ?? msg?.created_at ?? null;
  }

  /**
   * Generate a unique key for a chat message to avoid rendering duplicates.
   */
  function chatMsgKey(msg) {
    const id = msg?.id;
    if (id !== undefined && id !== null) return `id:${id}`;
    const t = msg?.created_at || '';
    const n = msg?.display_name || msg?.user_name || msg?.name || '';
    const body = msg?.text || msg?.message || '';
    return `fallback:${t}|${n}|${body}`;
  }

  /**
   * Format a timestamp into a human-readable HH:MM AM/PM string.  Returns
   * an empty string if the timestamp is invalid.
   */
  function formatChatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (!Number.isFinite(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  /**
   * Determine whether the chat list is scrolled near the bottom.  This helps
   * decide whether to automatically scroll to the bottom when new messages
   * arrive.
   */
  function isChatNearBottom(listEl, px = 80) {
    if (!listEl) return true;
    return listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight <= px;
  }

  /**
   * If no messages have been loaded yet, display a placeholder status in the
   * chat list.  Once messages are loaded, this status will be hidden.
   */
  function setChatStatus(text) {
    const listEl = document.getElementById('chatList');
    if (!listEl) return;
    if (listEl.dataset.hasMessages === '1') return;
    if (typeof escapeHtml === 'function') {
      listEl.innerHTML = `<div class="chatEmpty">${escapeHtml(text)}</div>`;
    } else {
      listEl.textContent = text;
    }
  }

  /**
   * Reset the chat cursor and seen set.  Called when the chat panel loads
   * initially or when the user signs out.
   */
  function chatResetState() {
    chatLastSeen = null;
    chatSeenKeys = new Set();
  }

  /**
   * Render chat messages into the chat list.  This function accepts an array
   * of message objects and an optional replace flag.  When replace=true the
   * list is cleared and the messages are rendered anew; otherwise new
   * messages are appended to the bottom.  The function also tracks the
   * cursor and manages the scroll position.
   */
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

  /**
   * Fetch chat messages from the server.  Accepts an optional after cursor and
   * limit.  Returns an array of messages or an empty array on error.  Uses
   * getJSONAuth defined in app.js to send an authenticated GET request.
   */
  async function chatFetchMessages({ after = null, limit = 50 } = {}) {
    if (typeof authHeaderOK === 'function' && !authHeaderOK()) return [];
    const qs = new URLSearchParams();
    qs.set('limit', String(limit));
    if (after !== null && after !== undefined && String(after).trim() !== '') {
      qs.set('after', String(after));
    }
    try {
      const data = await getJSONAuth(`/chat/rooms/${CHAT_ROOM}?${qs.toString()}`, communityToken);
      return Array.isArray(data) ? data : data?.messages || [];
    } catch (err) {
      console.warn('chatFetchMessages failed', err);
      return [];
    }
  }

  /**
   * Load the initial batch of chat messages.  Resets the chat state and
   * fetches up to 60 most recent messages, replacing any existing list.
   */
  async function chatLoadInitial() {
    const msgs = await chatFetchMessages({ limit: 60 });
    renderChatMessages(msgs, { replace: true });
  }

  /**
   * Fetch messages that arrive after the last seen cursor.  Returns an array
   * of new messages or an empty array.
   */
  async function chatFetchNew() {
    return chatFetchMessages({ after: chatLastSeen, limit: 50 });
  }

  /**
   * Send a chat message via the API.  Throws if the user is not signed in
   * or if the network request fails.  Uses postJSON defined in app.js.
   */
  async function chatSend(text) {
    if (typeof authHeaderOK === 'function' && !authHeaderOK()) throw new Error('Not signed in');
    const body = { text };
    return postJSON(`/chat/rooms/${CHAT_ROOM}`, body, communityToken);
  }

  /**
   * Fetch any new messages and render them.  Only runs if the user is
   * authenticated and the chat panel is currently open.  Suppresses errors
   * to avoid spamming the console.
   */
  async function chatPollOnce() {
    if (typeof authHeaderOK === 'function' && !authHeaderOK()) return;
    if (typeof openPanelKey === 'undefined' || openPanelKey !== 'chat') return;
    try {
      const msgs = await chatFetchNew();
      renderChatMessages(msgs);
    } catch (e) {
      console.warn('chat poll failed:', e);
    }
  }

  /**
   * Start the chat polling interval if it isn't already running.  Polling
   * only starts when the user is signed in and the chat panel is open.
   */
  function startChatPolling() {
    if (chatPollTimer || (typeof authHeaderOK === 'function' && !authHeaderOK()) || openPanelKey !== 'chat') return;
    chatPollTimer = setInterval(chatPollOnce, CHAT_POLL_MS);
  }

  /**
   * Stop the chat polling interval.
   */
  function stopChatPolling() {
    if (!chatPollTimer) return;
    clearInterval(chatPollTimer);
    chatPollTimer = null;
  }

  /**
   * Synchronize the polling state based on authentication and whether the
   * chat panel is currently open.  Called when the drawer is opened or
   * closed, or when authentication state changes.
   */
  function syncChatPollingState() {
    if (typeof authHeaderOK === 'function' && authHeaderOK() && openPanelKey === 'chat') startChatPolling();
    else stopChatPolling();
  }

  /**
   * Wire the chat panel once it has been inserted into the DOM.  Attaches
   * event handlers to the input and send button, performs an initial
   * message load, and starts polling.  Gracefully handles errors by
   * displaying a fallback status message.
   */
  function wireChatPanel() {
    const chatInput = document.getElementById('chatInput');
    const chatSendBtn = document.getElementById('chatSendBtn');
    if (!chatInput || !chatSendBtn) return;

    // Apply some basic accessibility hints to the input.
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

    chatSendBtn.addEventListener('click', (e) => {
      e.preventDefault();
      sendNow();
    });
    chatInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      sendNow();
    });

    chatResetState();
    chatLoadInitial().then(() => chatPollOnce()).catch((e) => {
      console.warn('chat initial load failed:', e);
      setChatStatus('Chat unavailable right now.');
    });
    syncChatPollingState();
  }

  // Expose chat functions so app.js can call them safely via window.xxx.
  window.chatPanelHTML = chatPanelHTML;
  window.wireChatPanel = wireChatPanel;
  window.syncChatPollingState = syncChatPollingState;
  window.stopChatPolling = stopChatPolling;
  window.startChatPolling = startChatPolling;
  window.chatResetState = chatResetState;

  // Bind the chat dock button to open this chat panel.  The variables
  // bindDockToggle and dockChat are defined in app.js.  We only bind
  // the chat dock if they exist; this avoids errors if the DOM hasn't
  // loaded yet or if the dock button isn't present.
  if (typeof bindDockToggle === 'function' && typeof dockChat !== 'undefined') {
    bindDockToggle(dockChat, 'chat', 'Chat', chatPanelHTML, wireChatPanel);
  }

  // Optional: simple night mode toggle retained from the original stub.
  function toggleNightMode() {
    document.body.classList.toggle('night');
  }
  window.toggleNightMode = toggleNightMode;
})();
