/*
 * app.part2.js
 *
 * Compatibility bridge for chat/shared helpers and non-chat wrappers only.
 */
(function() {
  console.log('app.part2.js loaded');

  /* =========================================================
   MOVED TO app.part8.js
   Chat Core module
   Search there for:
   - chatPanelHTML
   - wireChatPanel
   - chatPollOnce
   - chatRefreshPrivateThreads
   - renderChatMessages
   - syncChatPollingState
   ========================================================= */

  /* COMPATIBILITY BRIDGE ONLY:
     app.part2.js forwards to owner modules.
     Chat ownership lives in app.part8.js.
     Games ownership lives in app.part4.js.
     Do not export owner globals from this file.
  */
  function warnMissingOwner(ownerName, methodName) {
    console.warn(`[compat] ${ownerName} owner missing for ${methodName}`);
  }

  function chatUnavailablePanelHTML() {
    return '<div class="panelBlock chatPanelWrap"><div class="chatSignedOut">Chat module not ready yet. Close and reopen the panel.</div></div>';
  }

  function gamesUnavailablePanelHTML() {
    return '<div class="panelBlock gamesPanelWrap"><div class="gamesStatus">Games module not ready yet. Close and reopen the panel.</div></div>';
  }

  function chatPanelHTML() {
    const fn =
      window.chatPanelHTML ||
      window.TlcChatCoreModule?.chatPanelHTML;
    if (typeof fn === "function") return fn();
    warnMissingOwner("chat", "chatPanelHTML");
    return chatUnavailablePanelHTML();
  }

  function wireChatPanel() {
    const fn =
      window.wireChatPanel ||
      window.TlcChatCoreModule?.wireChatPanel;
    if (typeof fn === "function") return fn();
    warnMissingOwner("chat", "wireChatPanel");
  }

  function syncChatPollingState() {
    const fn =
      window.syncChatPollingState ||
      window.TlcChatCoreModule?.syncChatPollingState;
    if (typeof fn === "function") return fn();
    warnMissingOwner("chat", "syncChatPollingState");
  }

  function stopChatPolling() {
    const fn =
      window.stopChatPolling ||
      window.TlcChatCoreModule?.stopChatPolling;
    if (typeof fn === "function") return fn();
  }

  function startChatPolling() {
    const fn =
      window.startChatPolling ||
      window.TlcChatCoreModule?.startChatPolling;
    if (typeof fn === "function") return fn();
  }

  function chatResetState() {
    const fn =
      window.chatResetState ||
      window.TlcChatCoreModule?.chatResetState;
    if (typeof fn === "function") return fn();
  }
  function openPrivateConversation(...args) { return window.TlcChatCoreModule?.openPrivateConversation?.(...args); }
  function chatRefreshPrivateThreads(...args) { return window.TlcChatCoreModule?.chatRefreshPrivateThreads?.(...args); }
  function renderPrivateTabUnread(...args) { return window.TlcChatCoreModule?.renderPrivateTabUnread?.(...args); }
  function updateChatUnreadBadge(...args) { return window.TlcChatCoreModule?.updateChatUnreadBadge?.(...args); }
  function parseMessageId(...args) { return window.TlcChatCoreModule?.parseMessageId?.(...args); }
  function formatChatTime(...args) { return window.TlcChatCoreModule?.formatChatTime?.(...args) || ''; }
  function normalizePrivateMessagesPayload(...args) { return window.TlcChatCoreModule?.normalizePrivateMessagesPayload?.(...args) || []; }
  function renderPrivateConversationRow(...args) { return window.TlcChatCoreModule?.renderPrivateConversationRow?.(...args) || ''; }
  function chatFetchPrivateMessages(...args) { return window.TlcChatCoreModule?.chatFetchPrivateMessages?.(...args) || []; }
  function chatSendPrivateMessage(...args) { return window.TlcChatCoreModule?.chatSendPrivateMessage?.(...args); }
  function getCommunityToken(...args) { return window.TlcChatCoreModule?.getCommunityToken?.(...args) || ''; }


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
    const size = Math.max(12, Number(options?.size) || (meta.code === 'crown' ? (options?.compact ? 24 : 28) : (options?.compact ? 18 : 20)));
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
          <radialGradient id="crownPearl" cx="0.38" cy="0.32" r="0.7">
            <stop offset="0" stop-color="#ffffff"/>
            <stop offset="0.45" stop-color="#f8eecf"/>
            <stop offset="1" stop-color="#a98c4a"/>
          </radialGradient>
          <radialGradient id="crownGemHalo" cx="0.5" cy="0.45" r="0.55">
            <stop offset="0" stop-color="#ffffff" stop-opacity="0.65"/>
            <stop offset="0.45" stop-color="#a3deff" stop-opacity="0.32"/>
            <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <g id="crownGemHalo">
          <ellipse cx="36" cy="42" rx="13" ry="9" fill="url(#crownGemHalo)"/>
        </g>
        <g id="crownBody">
          <path d="M10,44 C11,33 13,26 15,26 C17,26 19,30 22,36 C25,32 31,22 36,22 C41,22 47,32 50,36 C53,30 55,26 57,26 C59,26 61,33 62,44 Z" fill="url(#crownGoldMain)" stroke="#754208" stroke-width="1.5" stroke-linejoin="round"/>
          <path d="M22,36 C26,30 32,24 36,24 C40,24 46,30 50,36" fill="none" stroke="rgba(80,40,4,.22)" stroke-width="1.6" stroke-linecap="round"/>
          <path d="M11.5,32 C13,28 14,27 15,27" fill="none" stroke="rgba(255,242,176,.6)" stroke-width="1" stroke-linecap="round"/>
          <path d="M30,28 C32,25 34,23 35.5,23" fill="none" stroke="rgba(255,242,176,.6)" stroke-width="1" stroke-linecap="round"/>
          <path d="M60.5,32 C59,28 58,27 57,27" fill="none" stroke="rgba(255,242,176,.6)" stroke-width="1" stroke-linecap="round"/>
        </g>
        <g id="crownBaseRim">
          <path d="M10,44 H62 V50 q0,3 -3,3 H13 q-3,0 -3,-3 Z" fill="url(#crownBandGold)" stroke="#6d3f08" stroke-width="1.5" stroke-linejoin="round"/>
          <path d="M13,45.4 c10,-1.4 36,-1.4 46,0" fill="none" stroke="rgba(255,248,216,.6)" stroke-width="1" stroke-linecap="round"/>
          <g stroke="rgba(80,40,4,.42)" stroke-width="0.55" fill="none" stroke-linejoin="round">
            <path d="M15,48 l1.4,1.4 l-1.4,1.4 l-1.4,-1.4 z"/>
            <path d="M21,48 l1.4,1.4 l-1.4,1.4 l-1.4,-1.4 z"/>
            <path d="M27,48 l1.4,1.4 l-1.4,1.4 l-1.4,-1.4 z"/>
            <path d="M33,48 l1.4,1.4 l-1.4,1.4 l-1.4,-1.4 z"/>
            <path d="M39,48 l1.4,1.4 l-1.4,1.4 l-1.4,-1.4 z"/>
            <path d="M45,48 l1.4,1.4 l-1.4,1.4 l-1.4,-1.4 z"/>
            <path d="M51,48 l1.4,1.4 l-1.4,1.4 l-1.4,-1.4 z"/>
            <path d="M57,48 l1.4,1.4 l-1.4,1.4 l-1.4,-1.4 z"/>
          </g>
          <path d="M13,52 c10,1 36,1 46,0" fill="none" stroke="rgba(80,40,4,.4)" stroke-width="0.7" stroke-linecap="round"/>
        </g>
        <g id="fleurDeLisGroup">
          <path d="M36,7 C33,11 32,15 34,18 L34,20 L38,20 L38,18 C40,15 39,11 36,7 Z" fill="url(#crownGoldMain)" stroke="#6f3d08" stroke-width="0.9" stroke-linejoin="round"/>
          <path d="M36,8 C35,11 35,16 36,19" fill="none" stroke="rgba(255,242,176,.6)" stroke-width="0.6" stroke-linecap="round"/>
          <path d="M34,19 C31,18 28.5,18.5 28.5,20.5 C28.5,22.2 31,22.5 34,21 Z" fill="url(#crownGoldMain)" stroke="#6f3d08" stroke-width="0.85" stroke-linejoin="round"/>
          <path d="M38,19 C41,18 43.5,18.5 43.5,20.5 C43.5,22.2 41,22.5 38,21 Z" fill="url(#crownGoldMain)" stroke="#6f3d08" stroke-width="0.85" stroke-linejoin="round"/>
          <rect x="32.5" y="20.2" width="7" height="1.6" rx="0.7" fill="url(#crownBandGold)" stroke="#6f3d08" stroke-width="0.6"/>
          <circle cx="36" cy="5.4" r="1.5" fill="url(#crownPearl)" stroke="#7a4a08" stroke-width="0.5"/>
          <ellipse cx="35.5" cy="5" rx="0.45" ry="0.3" fill="rgba(255,255,255,.85)"/>
        </g>
        <g id="leftPearl">
          <circle cx="15" cy="24.5" r="2.2" fill="url(#crownPearl)" stroke="#7a4a08" stroke-width="0.6"/>
          <ellipse cx="14.4" cy="23.9" rx="0.7" ry="0.45" fill="rgba(255,255,255,.85)"/>
        </g>
        <g id="rightPearl">
          <circle cx="57" cy="24.5" r="2.2" fill="url(#crownPearl)" stroke="#7a4a08" stroke-width="0.6"/>
          <ellipse cx="56.4" cy="23.9" rx="0.7" ry="0.45" fill="rgba(255,255,255,.85)"/>
        </g>
        <g id="centerBlueDiamond">
          <path d="M28,37 L32,36 L40,36 L44,37 L45,40 L36,52 L27,40 Z" fill="url(#crownBlueDiamond)" stroke="#1d46a6" stroke-width="1.1" stroke-linejoin="round"/>
          <path d="M27,40 L45,40" stroke="rgba(212,242,255,.65)" stroke-width="0.7"/>
          <path d="M32,36 L32,40 M40,36 L40,40 M36,36 L36,40" stroke="rgba(212,242,255,.55)" stroke-width="0.55"/>
          <path d="M27,40 L36,52 M32,40 L36,52 M36,40 L36,52 M40,40 L36,52 M45,40 L36,52" stroke="rgba(212,242,255,.55)" stroke-width="0.55"/>
          <path d="M30,38 L32.5,36.8" stroke="#ffffff" stroke-width="0.9" stroke-linecap="round" opacity="0.92"/>
          <path d="M30.5,39.4 L31.5,38.7" stroke="#ffffff" stroke-width="0.55" stroke-linecap="round" opacity="0.7"/>
          <path d="M36,38.5 L36,39.5 M35,39 L37,39" stroke="rgba(255,255,255,.55)" stroke-width="0.4" stroke-linecap="round"/>
        </g>
        <g id="leftRedDiamond">
          <path d="M22,42 L25.5,46.5 L22,51 L18.5,46.5 Z" fill="url(#crownRuby)" stroke="#781022" stroke-width="0.9"/>
          <path d="M22,42 L22,51" stroke="rgba(255,200,200,.45)" stroke-width="0.4"/>
          <path d="M18.5,46.5 L25.5,46.5" stroke="rgba(255,200,200,.45)" stroke-width="0.4"/>
          <path d="M20.6,44.6 L22.4,43.2" stroke="rgba(255,225,228,.85)" stroke-width="0.5" stroke-linecap="round"/>
        </g>
        <g id="rightRedDiamond">
          <path d="M50,42 L53.5,46.5 L50,51 L46.5,46.5 Z" fill="url(#crownRuby)" stroke="#781022" stroke-width="0.9"/>
          <path d="M50,42 L50,51" stroke="rgba(255,200,200,.45)" stroke-width="0.4"/>
          <path d="M46.5,46.5 L53.5,46.5" stroke="rgba(255,200,200,.45)" stroke-width="0.4"/>
          <path d="M48.6,44.6 L50.4,43.2" stroke="rgba(255,225,228,.85)" stroke-width="0.5" stroke-linecap="round"/>
        </g>
        <g id="leftTealGem">
          <ellipse cx="13" cy="46.5" rx="1.9" ry="2.9" fill="url(#crownTeal)" stroke="#0f635a" stroke-width="0.9"/>
          <path d="M12.2,44.9 c0.5,-0.3 1.1,-0.3 1.6,0" stroke="rgba(218,255,250,.75)" stroke-width="0.6" stroke-linecap="round"/>
        </g>
        <g id="rightTealGem">
          <ellipse cx="59" cy="46.5" rx="1.9" ry="2.9" fill="url(#crownTeal)" stroke="#0f635a" stroke-width="0.9"/>
          <path d="M58.2,44.9 c0.5,-0.3 1.1,-0.3 1.6,0" stroke="rgba(218,255,250,.75)" stroke-width="0.6" stroke-linecap="round"/>
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
  /* Compatibility bridge only: chat ownership lives in app.part8.js, games ownership lives in app.part4.js, and no dock binding should happen here. */
  function gamesPanelHTML() {
    const fn =
      window.gamesPanelHTML ||
      window.TlcGamesModule?.gamesPanelHTML;
    if (typeof fn === "function") return fn();
    warnMissingOwner("games", "gamesPanelHTML");
    return gamesUnavailablePanelHTML();
  }

  function wireGamesPanel() {
    const fn =
      window.wireGamesPanel ||
      window.TlcGamesModule?.wireGamesPanel;
    if (typeof fn === "function") return fn();
    warnMissingOwner("games", "wireGamesPanel");
  }
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
  window.TlcCompatBridge = {
    chatPanelHTML,
    wireChatPanel,
    syncChatPollingState,
    stopChatPolling,
    startChatPolling,
    chatResetState,
    gamesPanelHTML,
    wireGamesPanel,
    openGamesBattleComposer,
  };

  function toggleNightMode() { document.body.classList.toggle('night'); }
  window.toggleNightMode = toggleNightMode;
})();