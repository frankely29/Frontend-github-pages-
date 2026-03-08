/*
 * app.part2.js
 *
 * This file contains the chat implementation for the NYC TLC Hotspot Map.
 * It reads the authentication token directly from localStorage so the chat
 * remains in sync with the user’s login state.
 */
(function() {
  console.log('app.part2.js loaded');

  // Chat constants
  const CHAT_ROOM = typeof window !== 'undefined' && window.CHAT_ROOM ? window.CHAT_ROOM : 'global';
  const CHAT_POLL_MS = typeof window !== 'undefined' && window.CHAT_POLL_MS ? window.CHAT_POLL_MS : 1200;

  // Token helper
  const LS_TOKEN = 'community_token_v1';
  function getCommunityToken() {
    try { return localStorage.getItem(LS_TOKEN) || ''; } catch (_) { return ''; }
  }

  // Internal chat state
  let chatPollTimer = null;
  let chatLastSeen = null;
  let chatSeenKeys = new Set();

  // ... definitions of chatPanelHTML(), chatMsgCursor(), chatMsgKey(), formatChatTime(),
  //     isChatNearBottom(), setChatStatus(), chatResetState(), renderChatMessages(),
  //     chatLoadInitial(), chatFetchNew(), chatPollOnce(), startChatPolling(),
  //     stopChatPolling(), syncChatPollingState(), wireChatPanel() remain unchanged ...

  // Fetch chat messages.  Only fetch if we have a token.  Do not rely on authHeaderOK().
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

  // Send a chat message.  Require only that a token is present.
  async function chatSend(text) {
    const token = getCommunityToken();
    if (!token) {
      throw new Error('Not signed in');
    }
    const body = { text };
    return postJSON(`/chat/rooms/${CHAT_ROOM}`, body, token);
  }

  // ... export functions on window and bind the chat button via document.getElementById('dockChat') as before ...

})();