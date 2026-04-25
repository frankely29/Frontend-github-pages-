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
    const size = Math.max(12, Number(options?.size) || (meta.code === 'crown' ? (options?.compact ? 24 : 28) : (options?.compact ? 36 : 40)));
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
          <path d="M10,44 L15,27 L22,38 L36,21 L50,38 L57,27 L62,44 Z" fill="url(#crownGoldMain)" stroke="#754208" stroke-width="1.6" stroke-linejoin="round"/>
          <path d="M22,38 L36,23 L50,38 Z" fill="url(#crownGoldShadow)"/>
          <path d="M14,30 L18,38 M58,30 L54,38 M36,23 L33,40" fill="none" stroke="rgba(255,242,176,.55)" stroke-width="1" stroke-linecap="round"/>
        </g>
        <g id="crownBaseRim">
          <path d="M10,44 H62 V50 q0,3 -3,3 H13 q-3,0 -3,-3 Z" fill="url(#crownBandGold)" stroke="#6d3f08" stroke-width="1.6" stroke-linejoin="round"/>
          <path d="M13,45.4 c10,-1.4 36,-1.4 46,0" fill="none" stroke="rgba(255,248,216,.55)" stroke-width="1" stroke-linecap="round"/>
          <path d="M13,52 c10,1 36,1 46,0" fill="none" stroke="rgba(80,40,4,.35)" stroke-width="0.8" stroke-linecap="round"/>
        </g>
        <g id="leftTridentGroup">
          <path d="M14.6,19 H15.4 V25.5 H14.6 Z" fill="url(#crownGoldMain)" stroke="#6f3e08" stroke-width="0.7" stroke-linejoin="round"/>
          <ellipse cx="15" cy="26.2" rx="1.5" ry="0.8" fill="url(#crownBandGold)" stroke="#6f3e08" stroke-width="0.9"/>
          <path d="M11,19 H19" stroke="#6f3e08" stroke-width="1" stroke-linecap="round"/>
          <path d="M15,13.4 L13.4,18.6 L16.6,18.6 Z" fill="url(#crownGoldMain)" stroke="#6f3e08" stroke-width="0.9" stroke-linejoin="round"/>
          <path d="M12,18.7 C9,18.5 8,16.5 8.4,14.5" fill="none" stroke="#6f3e08" stroke-width="1.4" stroke-linecap="round"/>
          <path d="M8.4,14.5 L7.6,15.8 L9.2,15.8 Z" fill="url(#crownGoldMain)" stroke="#6f3e08" stroke-width="0.8" stroke-linejoin="round"/>
          <path d="M18,18.7 C21,18.5 22,16.5 21.6,14.5" fill="none" stroke="#6f3e08" stroke-width="1.4" stroke-linecap="round"/>
          <path d="M21.6,14.5 L20.8,15.8 L22.4,15.8 Z" fill="url(#crownGoldMain)" stroke="#6f3e08" stroke-width="0.8" stroke-linejoin="round"/>
          <path d="M15,14 L15,18.6" stroke="rgba(255,242,176,.6)" stroke-width="0.6" stroke-linecap="round"/>
        </g>
        <g id="rightTridentGroup">
          <path d="M56.6,19 H57.4 V25.5 H56.6 Z" fill="url(#crownGoldMain)" stroke="#6f3e08" stroke-width="0.7" stroke-linejoin="round"/>
          <ellipse cx="57" cy="26.2" rx="1.5" ry="0.8" fill="url(#crownBandGold)" stroke="#6f3e08" stroke-width="0.9"/>
          <path d="M53,19 H61" stroke="#6f3e08" stroke-width="1" stroke-linecap="round"/>
          <path d="M57,13.4 L55.4,18.6 L58.6,18.6 Z" fill="url(#crownGoldMain)" stroke="#6f3e08" stroke-width="0.9" stroke-linejoin="round"/>
          <path d="M54,18.7 C51,18.5 50,16.5 50.4,14.5" fill="none" stroke="#6f3e08" stroke-width="1.4" stroke-linecap="round"/>
          <path d="M50.4,14.5 L49.6,15.8 L51.2,15.8 Z" fill="url(#crownGoldMain)" stroke="#6f3e08" stroke-width="0.8" stroke-linejoin="round"/>
          <path d="M60,18.7 C63,18.5 64,16.5 63.6,14.5" fill="none" stroke="#6f3e08" stroke-width="1.4" stroke-linecap="round"/>
          <path d="M63.6,14.5 L62.8,15.8 L64.4,15.8 Z" fill="url(#crownGoldMain)" stroke="#6f3e08" stroke-width="0.8" stroke-linejoin="round"/>
          <path d="M57,14 L57,18.6" stroke="rgba(255,242,176,.6)" stroke-width="0.6" stroke-linecap="round"/>
        </g>
        <g id="fleurDeLisGroup">
          <path d="M27,18.5 C23,15.5 18,17 18.5,21.5 C19,25.5 25,26.5 30.5,23.5 C32,22.2 33,20.5 33,18.5 Z" fill="url(#crownGoldMain)" stroke="#6f3d08" stroke-width="1.1" stroke-linejoin="round"/>
          <path d="M22,20.5 C24,19.5 26,19.5 28,21" fill="none" stroke="rgba(80,40,4,.55)" stroke-width="0.7" stroke-linecap="round"/>
          <path d="M45,18.5 C49,15.5 54,17 53.5,21.5 C53,25.5 47,26.5 41.5,23.5 C40,22.2 39,20.5 39,18.5 Z" fill="url(#crownGoldMain)" stroke="#6f3d08" stroke-width="1.1" stroke-linejoin="round"/>
          <path d="M50,20.5 C48,19.5 46,19.5 44,21" fill="none" stroke="rgba(80,40,4,.55)" stroke-width="0.7" stroke-linecap="round"/>
          <path d="M36,3 C32,7 30,13 33.5,17.5 L33.5,21 C32,22.5 31.5,25 32,27.5 C33,30 34.5,32 36,33.5 C37.5,32 39,30 40,27.5 C40.5,25 40,22.5 38.5,21 L38.5,17.5 C42,13 40,7 36,3 Z" fill="url(#crownGoldMain)" stroke="#6f3d08" stroke-width="1.2" stroke-linejoin="round"/>
          <path d="M36,5 C34.5,9 34.5,15 36,18 C36,22 36,26 36,32" fill="none" stroke="rgba(255,242,176,.55)" stroke-width="0.8" stroke-linecap="round"/>
          <rect x="30.5" y="20.5" width="11" height="2.4" rx="1" fill="url(#crownBandGold)" stroke="#6f3d08" stroke-width="0.9"/>
          <path d="M31.5,21.5 H40.5" stroke="rgba(255,248,216,.55)" stroke-width="0.6" stroke-linecap="round"/>
        </g>
        <g id="centerBlueDiamond">
          <path d="M28,37 L32,36 L40,36 L44,37 L45,40 L36,53 L27,40 Z" fill="url(#crownBlueDiamond)" stroke="#1d46a6" stroke-width="1.2" stroke-linejoin="round"/>
          <path d="M27,40 L45,40" stroke="rgba(212,242,255,.6)" stroke-width="0.7"/>
          <path d="M32,36 L32,40 M40,36 L40,40 M36,36 L36,40" stroke="rgba(212,242,255,.5)" stroke-width="0.55"/>
          <path d="M27,40 L36,53 M32,40 L36,53 M36,40 L36,53 M40,40 L36,53 M45,40 L36,53" stroke="rgba(212,242,255,.5)" stroke-width="0.55"/>
          <path d="M30,38 L32,37" stroke="rgba(245,253,255,.85)" stroke-width="0.7" stroke-linecap="round"/>
        </g>
        <g id="leftRedDiamond">
          <path d="M22,42.5 L25.5,46.8 L22,51 L18.5,46.8 Z" fill="url(#crownRuby)" stroke="#781022" stroke-width="1"/>
          <path d="M21,45 L22.5,43.5" stroke="rgba(255,220,225,.7)" stroke-width="0.5" stroke-linecap="round"/>
        </g>
        <g id="rightRedDiamond">
          <path d="M50,42.5 L53.5,46.8 L50,51 L46.5,46.8 Z" fill="url(#crownRuby)" stroke="#781022" stroke-width="1"/>
          <path d="M49,45 L50.5,43.5" stroke="rgba(255,220,225,.7)" stroke-width="0.5" stroke-linecap="round"/>
        </g>
        <g id="leftTealGem">
          <ellipse cx="13" cy="46.5" rx="2" ry="3" fill="url(#crownTeal)" stroke="#0f635a" stroke-width="1"/>
          <path d="M12.2,44.8 c0.5,-0.3 1.1,-0.3 1.6,0" stroke="rgba(218,255,250,.7)" stroke-width="0.6" stroke-linecap="round"/>
        </g>
        <g id="rightTealGem">
          <ellipse cx="59" cy="46.5" rx="2" ry="3" fill="url(#crownTeal)" stroke="#0f635a" stroke-width="1"/>
          <path d="M58.2,44.8 c0.5,-0.3 1.1,-0.3 1.6,0" stroke="rgba(218,255,250,.7)" stroke-width="0.6" stroke-linecap="round"/>
        </g>
      </svg>`;
    } else if (meta.code === 'silver') {
      svg = `<svg class="${classes}" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="${title}" focusable="false">
        <defs>
          <linearGradient id="silverDiscMain" x1="14" y1="22" x2="50" y2="58" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#fafbfc"/>
            <stop offset="0.4" stop-color="#cbd5e1"/>
            <stop offset="0.75" stop-color="#94a3b8"/>
            <stop offset="1" stop-color="#475569"/>
          </linearGradient>
          <linearGradient id="silverDiscInner" x1="32" y1="26" x2="32" y2="58" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#f1f5f9"/>
            <stop offset="0.6" stop-color="#cbd5e1"/>
            <stop offset="1" stop-color="#64748b"/>
          </linearGradient>
          <linearGradient id="silverRibbon" x1="32" y1="2" x2="32" y2="26" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#60a5fa"/>
            <stop offset="0.55" stop-color="#3b82f6"/>
            <stop offset="1" stop-color="#1e3a8a"/>
          </linearGradient>
        </defs>
        <g id="silverRibbons">
          <path d="M16,4 L26,4 L33,24 L25,28 Z" fill="url(#silverRibbon)" stroke="#1e3a8a" stroke-width="1" stroke-linejoin="round"/>
          <path d="M48,4 L38,4 L31,24 L39,28 Z" fill="url(#silverRibbon)" stroke="#1e3a8a" stroke-width="1" stroke-linejoin="round"/>
          <path d="M22,4 L24,12" fill="none" stroke="rgba(255,255,255,.45)" stroke-width="0.9" stroke-linecap="round"/>
          <path d="M42,4 L40,12" fill="none" stroke="rgba(255,255,255,.45)" stroke-width="0.9" stroke-linecap="round"/>
        </g>
        <g id="silverDisc">
          <circle cx="32" cy="42" r="18" fill="url(#silverDiscMain)" stroke="#334155" stroke-width="1.6"/>
          <circle cx="32" cy="42" r="14" fill="url(#silverDiscInner)" stroke="#64748b" stroke-width="0.9"/>
          <path d="M22,34 q3,-5 9,-7.5" fill="none" stroke="rgba(255,255,255,.7)" stroke-width="1.8" stroke-linecap="round"/>
          <path d="M32,30 L33.1,32.4 L35.7,32.4 L33.6,33.9 L34.4,36.2 L32,34.7 L29.6,36.2 L30.4,33.9 L28.3,32.4 L30.9,32.4 Z" fill="#1e293b" opacity="0.55"/>
          <text x="32" y="51" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI',Roboto,sans-serif" font-size="16" font-weight="900" fill="#1e293b" stroke="rgba(255,255,255,.45)" stroke-width="0.5" paint-order="stroke">2</text>
        </g>
      </svg>`;
    } else {
      svg = `<svg class="${classes}" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="${title}" focusable="false">
        <defs>
          <linearGradient id="bronzeDiscMain" x1="14" y1="22" x2="50" y2="58" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#fde2c0"/>
            <stop offset="0.4" stop-color="#e8a76b"/>
            <stop offset="0.75" stop-color="#a45c1a"/>
            <stop offset="1" stop-color="#5a2a08"/>
          </linearGradient>
          <linearGradient id="bronzeDiscInner" x1="32" y1="26" x2="32" y2="58" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#fbd2a3"/>
            <stop offset="0.6" stop-color="#d89051"/>
            <stop offset="1" stop-color="#7b4b27"/>
          </linearGradient>
          <linearGradient id="bronzeRibbon" x1="32" y1="2" x2="32" y2="26" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#fb923c"/>
            <stop offset="0.55" stop-color="#dc2626"/>
            <stop offset="1" stop-color="#7c1d1d"/>
          </linearGradient>
        </defs>
        <g id="bronzeRibbons">
          <path d="M16,4 L26,4 L33,24 L25,28 Z" fill="url(#bronzeRibbon)" stroke="#7c1d1d" stroke-width="1" stroke-linejoin="round"/>
          <path d="M48,4 L38,4 L31,24 L39,28 Z" fill="url(#bronzeRibbon)" stroke="#7c1d1d" stroke-width="1" stroke-linejoin="round"/>
          <path d="M22,4 L24,12" fill="none" stroke="rgba(255,255,255,.45)" stroke-width="0.9" stroke-linecap="round"/>
          <path d="M42,4 L40,12" fill="none" stroke="rgba(255,255,255,.45)" stroke-width="0.9" stroke-linecap="round"/>
        </g>
        <g id="bronzeDisc">
          <circle cx="32" cy="42" r="18" fill="url(#bronzeDiscMain)" stroke="#5a2a08" stroke-width="1.6"/>
          <circle cx="32" cy="42" r="14" fill="url(#bronzeDiscInner)" stroke="#7b4b27" stroke-width="0.9"/>
          <path d="M22,34 q3,-5 9,-7.5" fill="none" stroke="rgba(255,236,210,.7)" stroke-width="1.8" stroke-linecap="round"/>
          <path d="M32,30 L33.1,32.4 L35.7,32.4 L33.6,33.9 L34.4,36.2 L32,34.7 L29.6,36.2 L30.4,33.9 L28.3,32.4 L30.9,32.4 Z" fill="#5a2a08" opacity="0.6"/>
          <text x="32" y="51" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI',Roboto,sans-serif" font-size="16" font-weight="900" fill="#5a2a08" stroke="rgba(255,236,210,.45)" stroke-width="0.5" paint-order="stroke">3</text>
        </g>
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