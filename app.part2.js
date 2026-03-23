/*
 * app.part2.js
 *
 * Compatibility bridge for chat plus shared badge helpers and non-chat wrappers.
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

  function chatPanelHTML() { return window.TlcChatCoreModule?.chatPanelHTML?.() || ''; }
  function wireChatPanel() { return window.TlcChatCoreModule?.wireChatPanel?.(); }
  function syncChatPollingState() { return window.TlcChatCoreModule?.syncChatPollingState?.(); }
  function stopChatPolling() { return window.TlcChatCoreModule?.stopChatPolling?.(); }
  function startChatPolling() { return window.TlcChatCoreModule?.startChatPolling?.(); }
  function chatResetState() { return window.TlcChatCoreModule?.chatResetState?.(); }
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

  function bindCompatDockPanelsOnce() {
    if (typeof bindDockToggle !== 'function') return;

    const chatBtn = document.getElementById('dockChat');
    if (chatBtn && chatBtn.dataset.tlcBoundChat !== '1') {
      chatBtn.dataset.tlcBoundChat = '1';
      bindDockToggle(chatBtn, 'chat', 'Chat', chatPanelHTML, wireChatPanel);
    }

    const gamesBtn = document.getElementById('dockGames');
    if (gamesBtn && gamesBtn.dataset.tlcBoundGames !== '1') {
      gamesBtn.dataset.tlcBoundGames = '1';
      bindDockToggle(gamesBtn, 'games', 'Games', gamesPanelHTML, wireGamesPanel);
    }
  }

  /* ISSUE NOTE:
     app.part2.js is the stable compatibility owner for chat + games dock binding.
     Split modules may provide the implementations, but this file owns the dock wiring.
  */
  bindCompatDockPanelsOnce();
  window.addEventListener('load', bindCompatDockPanelsOnce);
  setTimeout(bindCompatDockPanelsOnce, 0);
  setTimeout(bindCompatDockPanelsOnce, 400);

  function toggleNightMode() { document.body.classList.toggle('night'); }
  window.toggleNightMode = toggleNightMode;
})();
