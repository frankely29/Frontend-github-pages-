/*
 * app.part5.js
 *
 * Driver profile + progression module extracted from app.part2.js.
 */
(function() {
  console.log('app.part5.js loaded');
  const runtime = window.FrontendRuntime || null;
  const runtimePolling = runtime?.polling || null;
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
  let driverProfileLayoutTimer50 = null;
  let driverProfileLayoutTimer180 = null;
  let driverProfileLayoutBound = false;
  let driverProfilePollInFlight = false;

  function injectDriverProfileStyles() {
    if (document.getElementById('driverProfileModalStyles')) return;
    const style = document.createElement('style');
    style.id = 'driverProfileModalStyles';
    style.textContent = `
      #driverProfileModalRoot{position:fixed;inset:0;z-index:9800;display:none}
      #driverProfileModalRoot.open{display:block}
      .driverProfileBackdrop{position:absolute;inset:0;background:rgba(7,10,19,.42);z-index:9800}
      .driverProfileSheet{position:absolute;left:50%;transform:translate(-50%,110%);bottom:var(--driver-profile-bottom-offset, 14px);width:min(430px,calc(100vw - 16px));max-height:calc(100dvh - var(--driver-profile-bottom-offset, 14px) - env(safe-area-inset-top) - 6px);background:rgba(255,255,255,.985);border-radius:24px 24px 16px 16px;box-shadow:0 -12px 30px rgba(0,0,0,.2);display:flex;flex-direction:column;overflow:hidden;transition:transform .18s ease-out;z-index:9801}
      #driverProfileModalRoot.open .driverProfileSheet{transform:translate(-50%,0)}
      .driverProfileBody{display:flex;flex-direction:column;min-height:0;height:100%}
      .driverProfileHeader{display:flex;align-items:flex-start;justify-content:space-between;gap:5px;padding:7px 10px 4px}
      .driverProfileIdentity{display:flex;gap:6px;align-items:center;min-width:0}
      .driverProfileAvatar{width:44px;height:44px;border-radius:999px;flex:0 0 44px;object-fit:cover;background:#e8edf5}
      .driverProfileName{font-size:15px;line-height:1.18;font-weight:700;color:#111827;word-break:break-word}
      .driverProfileBadgeRow{display:flex;align-items:center;gap:5px;margin-top:1px;min-height:20px}
      .driverProfileBadgeChipWrap{display:inline-flex;align-items:center;gap:7px}.driverProfileBadgeLabel{font-size:11px;font-weight:700;color:#334155;letter-spacing:.15px}
      .driverProfileProgressWrap{background:#f8fafc;border:1px solid #e2e8f0;border-radius:11px;padding:5px;margin-bottom:6px}
      .driverProfileProgressHead{display:flex;align-items:center;justify-content:space-between;gap:5px;margin-bottom:3px}
      /* Two lines of text on the left, the badge on the right. The head is a
         space-between row, so the lines are wrapped rather than added as
         siblings -- a third child would push the badge to the middle. */
      .driverProfileProgressHeadText{min-width:0;display:flex;flex-direction:column;gap:2px}
      .driverProfileProgressLine{font-size:12px;font-weight:700;color:#0f172a;display:flex;align-items:center;gap:5px;min-width:0;flex-wrap:wrap}
      .driverProfilePrestigeLine{font-size:10px;font-weight:600;color:#64748b;letter-spacing:.04em;line-height:1.2}
      .driverProfileProgressMeta{font-size:11px;color:#475569;line-height:1.3}
      .driverProfileProgressBar{height:7px;border-radius:999px;background:#e2e8f0;overflow:hidden;margin:2px 0 3px}
      .driverProfileProgressFill{height:100%;background:linear-gradient(90deg,#3b82f6,#22c55e);border-radius:999px;transition:width .2s ease-out}
      .driverProfileRankName{color:#0f172a;font-weight:800}
      .driverProfileBreakdownGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px 7px;margin-top:3px;padding-top:3px;border-top:1px dashed #dbe4ee}
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
      /* The Trip Saved card: design A, "Gold standard".
       *
       * Chosen from five treatments over a photograph of the real screen. The
       * argument it makes is that a reward does not have to shout. The four
       * before it all tried to be louder than the map -- a 68px number, a
       * glow, an embossed token -- and loud is what a lottery ticket is. This
       * one is quiet and expensive: a medal hung over the top edge, a gold
       * hairline, a light-weight numeral, and a 3px rule instead of a fat bar.
       *
       * Everything here is a deliberate value, so changing one in isolation
       * will break the look: the medallion overlaps the card by exactly half
       * its height, the card's top padding exists to clear it, and the gold
       * is one hue (#d6b164) at four strengths rather than several golds. */
      .pickupProgressReward{position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom, 0px) + var(--pickup-reward-bottom, 240px));width:min(318px,calc(100vw - 22px));transform:translate(-50%,26px) scale(.94);opacity:0;z-index:9802;pointer-events:none;display:block;color:#e7ebf3;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased;transition:opacity .42s ease,transform .42s cubic-bezier(.16,.82,.24,1.18)}
      .pickupProgressReward.show{opacity:1;transform:translate(-50%,0) scale(1)}
      /* overflow is visible on purpose: the medallion hangs out of the top.
         That is the whole silhouette, so nothing may clip it -- which is also
         why there is no sheen sweeping across this one. */
      .pickupProgressRewardCard{position:relative;overflow:visible;margin-top:34px;border-radius:20px;padding:44px 24px 20px;background:linear-gradient(180deg,#13182a,#0b0f1c);border:1px solid rgba(214,177,100,.42);box-shadow:0 28px 64px rgba(2,6,23,.60),0 0 0 1px rgba(2,6,23,.5);display:block}
      .pickupProgressRewardKicker,.pickupProgressRewardRule,.pickupProgressRewardMeta,.pickupProgressRewardFoot{opacity:0;transform:translateY(6px);transition:opacity .24s ease,transform .24s ease}
      .pickupProgressReward.show .pickupProgressRewardKicker{opacity:1;transform:translateY(0);transition-delay:.05s}
      .pickupProgressReward.show .pickupProgressRewardRule{opacity:1;transform:translateY(0);transition-delay:.10s}
      .pickupProgressReward.show .pickupProgressRewardMeta{opacity:1;transform:translateY(0);transition-delay:.20s}
      .pickupProgressReward.show .pickupProgressRewardFoot{opacity:1;transform:translateY(0);transition-delay:.26s}
      .pickupProgressRewardKicker{font-size:10.5px;font-weight:700;letter-spacing:.26em;text-transform:uppercase;color:#d6b164;text-align:center;line-height:1}
      /* A hairline that fades out at both ends rather than a border: it
         separates without drawing a box inside a box. */
      .pickupProgressRewardRule{width:64px;height:1px;margin:16px auto 0;background:linear-gradient(90deg,rgba(214,177,100,0),rgba(214,177,100,.75),rgba(214,177,100,0))}
      /* The numeral is LIGHT, which is the single most important weight on
         this card. At 900 it was a scoreboard; at 300 it is engraving. The
         unit stays small and gold so the figure is read first. */
      .pickupProgressRewardXp{margin-top:16px;text-align:center;font-size:46px;font-weight:300;line-height:1;letter-spacing:-.02em;color:#ffffff;font-variant-numeric:tabular-nums;opacity:0}
      .pickupProgressReward.show .pickupProgressRewardXp{animation:pickupProgressRewardXpIn .5s cubic-bezier(.2,.85,.3,1) .12s both}
      .pickupProgressRewardXpUnit{font-size:18px;font-weight:600;margin-left:6px;color:#d6b164;letter-spacing:0}
      .pickupProgressRewardIcon{position:absolute;left:50%;top:-34px;margin-left:-34px;display:grid;place-items:center;opacity:0;transform:scale(.74)}
      .pickupProgressReward.show .pickupProgressRewardIcon{opacity:1;animation:pickupProgressRewardIconPop .62s cubic-bezier(.2,.8,.2,1) .06s both}
      .pickupProgressRewardIcon::before{content:'';position:absolute;inset:-14px;border-radius:999px;background:radial-gradient(circle,rgba(214,177,100,.55) 0%,rgba(214,177,100,.22) 46%,rgba(214,177,100,0) 72%);filter:blur(1px);opacity:0;transform:scale(.58)}
      .pickupProgressReward.show .pickupProgressRewardIcon::before{animation:pickupProgressRewardGlow .8s ease-out .12s both}
      /* A struck coin, not a tinted disc: light off the top, shadow at the
         bottom, and a hard rim. renderRankBadgeIcon paints a tone class in
         here, so every colour it sets is overridden -- the medal is the
         medal whatever rank a driver holds. */
      /* The coin is struck in the driver's OWN metal. --rank-lo/mid/dk/ring come
         off the badge markup, one set per tier, with gold as the fallback for
         anything that renders this wrapper without them. */
      /* The painted frame IS the medal, so the three layers stack in one box:
         the frame, the mark in its well, and the generated badge behind both
         for when the file is not there. */
      .rankBadgeIconWrap.rankBadgePainted{position:relative;display:grid;place-items:center;background:none!important;box-shadow:none!important;border-radius:0}
      .rankBadgeIconWrap.rankBadgePainted > .rankBadgeFrame,
      .rankBadgeIconWrap.rankBadgePainted > .rankBadgeVector{grid-area:1/1}
      .rankBadgeFrame{width:100%;height:100%;object-fit:contain;display:block}
      /* The numeral is absolutely placed on the plate the pipeline measured,
         so it is positioned against the wrapper rather than stacked in the
         grid cell. Struck rather than printed: a dark sink one pixel under a
         light face, which is how the rest of the badge is lit. */
      .rankBadgeDivision{
        position:absolute;display:grid;place-items:center;pointer-events:none;
        font-family:Georgia,"Times New Roman",serif;font-weight:700;line-height:1;
        color:#f0eada;text-shadow:0 1px 0 rgba(0,0,0,.55);
        letter-spacing:.02em;white-space:nowrap;
      }
      .rankBadgeVector{display:none}
      /* Without a painted frame the wrapper goes back to what it always was,
         and the generated badge is what shows. The numeral goes with the
         painted badge, because the vector one has no plate to strike it on --
         there the emblem carries the division instead. */
      .rankBadgeIconWrap:not(.rankBadgePainted) .rankBadgeFrame,
      .rankBadgeIconWrap:not(.rankBadgePainted) .rankBadgeDivision{display:none}
      .rankBadgeIconWrap:not(.rankBadgePainted) .rankBadgeVector{display:block}
      .pickupProgressReward .rankBadgeIconWrap{width:72px!important;height:72px!important;border-radius:999px;background:linear-gradient(180deg,var(--rank-lo,#f0d49a) 0%,var(--rank-mid,#c39a4e) 52%,var(--rank-dk,#8f6c2c) 100%);color:#3a2a08;box-shadow:inset 0 1px 0 rgba(255,255,255,.55),inset 0 -2px 3px rgba(0,0,0,.35),0 0 0 1px var(--rank-ring,#7a5c26),0 10px 24px rgba(2,6,23,.55)}
      /* The struck coin was a stand-in for a badge that could not carry the
         moment on its own. The painted frame is the medal, so the coin behind
         it stands down to a drop shadow rather than becoming a second medal
         around the first. */
      .pickupProgressReward .rankBadgeIconWrap.rankBadgePainted{background:none!important;box-shadow:none!important;filter:drop-shadow(0 8px 18px rgba(2,6,23,.6))}
      .pickupProgressReward .rankBadgeIconWrap svg{width:34px;height:34px}
      .pickupProgressRewardMeta{margin-top:18px;display:flex;align-items:baseline;justify-content:space-between;gap:12px}
      .pickupProgressRewardLevel{font-size:14px;font-weight:700;line-height:1;color:#e7ebf3;letter-spacing:0}
      .pickupProgressRewardRank{font-size:12px;font-weight:600;line-height:1;color:#9aa3b8;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      /* 3px, square, full width. A rounded capsule is a game's health bar;
         a rule under a line of text is a ledger. */
      .pickupProgressRewardBar{position:relative;width:100%;height:3px;margin-top:9px;background:rgba(214,177,100,.20);overflow:hidden}
      /* Two fills, one behind the other. The back one is where the driver
         already was; the front one is what THIS trip added, and it is the
         only part that grows. The bar used to run 0 -> total, which animates
         the whole level and shows the trip's contribution nowhere. */
      .pickupProgressRewardBase{position:absolute;top:0;bottom:0;left:0;width:0;background:rgba(214,177,100,.55)}
      .pickupProgressRewardFill{position:absolute;top:0;bottom:0;left:0;width:0;background:#f0d49a;box-shadow:0 0 8px rgba(240,212,154,.8);transition:width .72s cubic-bezier(.2,.84,.2,1);transition-delay:.3s}
      .pickupProgressRewardFoot{margin-top:10px;font-size:11.5px;line-height:1.2;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#8f98b0;text-align:center}
      @keyframes pickupProgressRewardIconPop{0%{transform:scale(.68)}40%{transform:scale(1.14)}100%{transform:scale(1)}}
      @keyframes pickupProgressRewardGlow{0%{opacity:0;transform:scale(.5)}34%{opacity:1;transform:scale(1.04)}100%{opacity:0;transform:scale(1.3)}}
      @keyframes pickupProgressRewardXpIn{0%{opacity:0;transform:translateY(6px)}100%{opacity:1;transform:translateY(0)}}
      @keyframes levelUpOverlayBurst{0%{opacity:0;transform:scale(.82)}38%{opacity:1;transform:scale(1.02)}100%{opacity:0;transform:scale(1.24)}}
      .driverProfileClose{border:0;background:#e5e7eb;color:#111827;border-radius:10px;padding:7px 9px;font-size:13px}
      .driverProfileScroll{overflow:auto;-webkit-overflow-scrolling:touch;padding:0 10px 6px;min-height:0}
      .driverProfileSectionTitle{font-size:12px;font-weight:700;color:#111827;margin:1px 0 3px}
      .driverProfileStats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:3px;margin-bottom:6px}
      .driverProfileStatCard{background:#f8fafc;border:1px solid #e2e8f0;border-radius:11px;padding:4px 5px}
      .driverProfileStatPeriod{font-size:11px;font-weight:700;color:#0f172a;margin-bottom:2px}
      .driverProfileStatRow{display:flex;align-items:center;justify-content:space-between;gap:4px;margin-top:0}
      .driverProfileStatLabel{font-size:11px;color:#475569}
      .driverProfileStatValue{font-size:13px;font-weight:700;color:#0f172a}
      .driverProfileDailyRanks{margin-top:3px;padding-top:2px;border-top:1px dashed #dbe4ee}
      .driverProfileDailyRanks .driverProfileStatLabel{font-size:10px}
      .driverProfileDailyRanks .driverProfileStatValue{font-size:11px}
      .driverProfileDmWrap{display:flex;flex-direction:column;border:1px solid #e2e8f0;border-radius:11px;background:#fff;min-height:130px}
      .driverProfileDmList{display:flex;flex-direction:column;gap:7px;overflow:auto;max-height:min(22vh,190px);padding:9px}
      .driverProfileDmList .chatPrivateMsgRow{margin:0}
      .driverProfileDmList .chatBubbleSelf,.driverProfileDmList .chatBubbleOther{max-width:86%}
      .driverProfileComposer{display:flex;gap:7px;padding:8px;border-top:1px solid #e2e8f0;padding-bottom:8px}
      .driverProfileInput{flex:1;min-width:0;border:1px solid #cbd5e1;border-radius:10px;padding:9px;font-size:16px;color:#0f172a}
      .driverProfileSendBtn{border:0;border-radius:10px;background:#1d4ed8;color:#fff;font-weight:600;padding:9px 11px}
      .driverProfileSendBtn:disabled{opacity:.6}
      .driverProfileVoiceComposer{padding:0 8px calc(8px + env(safe-area-inset-bottom));border-top:0}
      .driverProfileDmList .chatVoiceBubble{max-width:100%}
      .driverProfileStatus{font-size:12px;color:#64748b;padding:0 10px 7px}
      .driverProfileError{font-size:12px;color:#b91c1c;background:#fee2e2;border:1px solid #fecaca;border-radius:10px;padding:8px;margin:2px 10px 7px}
      .driverProfileLoading{padding:14px 10px;color:#334155;font-size:13px}
      .driverProfileActions{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:5px}
      .driverProfileActionBtn{border:1px solid #cbd5e1;background:#f8fafc;color:#0f172a;border-radius:10px;padding:8px 10px;font-size:13px;font-weight:600}
      .driverProfileActionBtn.danger{border-color:#fecaca;background:#fff1f2;color:#b91c1c}
      .driverProfileMapIdentity{border:1px solid #e2e8f0;border-radius:11px;padding:5px;background:#fff}
      .driverProfileMapIdentity #profileMapIdentitySection{margin:0}
    `;
    document.head.appendChild(style);
  }

  function updateDriverProfileLayout() {
    const root = document.getElementById('driverProfileModalRoot') || document.querySelector('[data-driver-profile-modal-root]');
    if (!root) return;
    const dock = document.getElementById('dock');
    const sliderWrap = document.getElementById('sliderWrap');

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
    const meta = chatInternals.leaderboardBadgeMeta?.(code);
    if (!meta.code) return '<span class="driverProfileBadgeLabel">No badge yet</span>';
    return `<span class="driverProfileBadgeChipWrap"><span class="badgeSvgWrap">${window.renderLeaderboardBadgeSvg?.(meta.code, { size: 30 })}</span><span class="driverProfileBadgeLabel">${escapeHtml(meta.profileLabel)}</span></span>`;
  }

  function driverProfileAvatarHTML(profileUser) {
    const name = String(profileUser?.display_name || 'Driver').trim() || 'Driver';
    const rawAvatarUrl = String(
      profileUser?.avatar_thumb_url ||
      profileUser?.avatar_url ||
      ''
    ).trim();
    const avatarUrl = typeof window.safeMapAvatarUrl === 'function'
      ? String(window.safeMapAvatarUrl(rawAvatarUrl) || '').trim()
      : rawAvatarUrl;
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

  const LEGACY_RANK_ICON_BAND_MAP = {
    recruit: 1,
    private: 2,
    corporal: 3,
    sergeant: 4,
    staff_sergeant: 5,
    sergeant_first_class: 6,
    master_sergeant: 7,
    lieutenant: 8,
    captain: 9,
    major: 10,
    colonel: 11,
    brigadier: 12,
    major_general: 13,
    lieutenant_general: 14,
    general: 15,
    commander: 16,
    road_legend: 17,
  };

  function resolveRankIconBand(rankIconKey) {
    const key = String(rankIconKey || '').trim().toLowerCase();
    /* Clamped to RANK_BAND_COUNT, not 1000. There are fifty ranks -- ten
     * prestiges of five -- and band_250 from a bad payload has to land on the
     * top badge rather than index past the end of the ladder. */
    const match = key.match(/^band_(\d{1,4})$/);
    if (match) {
      const value = Number(match[1]);
      return Math.max(1, Math.min(RANK_BAND_COUNT, value));
    }
    return Math.max(1, Math.min(RANK_BAND_COUNT, Number(LEGACY_RANK_ICON_BAND_MAP[key] || 1)));
  }

  function resolveRankIconTone(rankIconKey) {
    /* By prestige rather than by band, so the five bands inside a prestige
       always share a tone. Reading these off band numbers is what made them
       drift when the ladder was reshaped. */
    const prestige = rankFromBand(resolveRankIconBand(rankIconKey)).prestige;
    if (prestige >= 10) return 'toneLegend';
    if (prestige >= 8) return 'toneGeneral';
    if (prestige >= 5) return 'toneOfficer';
    if (prestige >= 2) return 'toneEnlisted';
    return 'toneRecruit';
  }

  /* The 100-rank badge ladder. Ten tiers of ten, each one struck.
   *
   * band 1..100 -> tier = floor((band-1)/10)   its own frame, metal and furniture
   *             -> mark = (band-1)%10          the emblem inside it
   *
   * WHAT CHANGED, AND WHY IT WAS THIN BEFORE
   *
   * Two shared bodies for ten tiers: five wore the shield, five wore the crest.
   * So the top half of the ladder was one silhouette in five colours, which is
   * most of why it still felt repetitive however much furniture got bolted on.
   * Every tier has its own frame now.
   *
   * Two faces per body -- a lit half and a shaded half. Real struck metal shows
   * five or six planes. Rather than author four quadrants for each of ten
   * frames, each body is used ONCE as a clip path and everything after it is
   * painted inside that clip: the two halves, a top sheen, a bottom vignette, a
   * diagonal specular streak, and a brushed-metal texture. One authored path per
   * frame, as many planes as the material needs.
   *
   * No texture at all -- the metal was a smooth ramp. feTurbulence with an
   * anisotropic baseFrequency (high across, low down) is brushed metal, and it
   * costs one filter on one rect rather than an asset per badge.
   *
   * All of it is still generated, so a hundred badges cost a hundred SVG strings
   * and no files. This is the ceiling of what geometry can do; the reference art
   * everyone pictures is painted, which is a different medium, not a harder
   * version of this one.
   */

  /* The ten prestiges.
   *
   * `hi` is the metal, sampled off each painted badge's own brightest decile.
   * Everything else is built from `accent`, which is the tier's IDENTITY
   * colour -- the enamel field behind the animal, or for the bottom four,
   * which have no field, the metal itself.
   *
   * Accent could not be sampled and is chosen. Every badge is mostly gold and
   * silver, because that is the house style all ten share; the thing that
   * makes one Sapphire and another Emerald is the minority colour, and no
   * "most common colour" rule finds a minority. Sampling returned gold for
   * seven of the ten before this was worked out.
   *
   * `parts`, `glow` and `glowStop` drive the VECTOR fallback only. They climb
   * so that a driver on a stale build still sees a ladder rather than ten
   * recoloured discs.
   *
   * Re-sample if the art is ever regenerated; do not hand-edit. */
  /* `beast` is empty on purpose.
   *
   * It held a second creature per prestige, from when the names were
   * materials and the badge needed something to say it was a wolf. The names
   * are the creatures now, so that column either repeats itself -- Phoenix,
   * Phoenix -- or contradicts: prestige 3 is Hydra and its old pairing was
   * Bear, and the leaderboard would have printed "Hydra - Bear" at a driver.
   *
   * The field stays rather than being deleted because the ladder, the games
   * list and TeamJoseoRank.prestiges() all read it, and every one of them
   * already renders it only when it is non-empty. Give it a value again and
   * the second label comes back everywhere at once. */
  var RANK_TIERS = [
  { name: 'Wyvern', beast: '', hi: '#d8d4cf', lo: '#b9c0c8', mid: '#7e8388', dk: '#4e5154', deep: '#292a2c',
    enamel: '#111a27', accent: '#b9c0c8', parts: [], glow: null, glowStop: 0 },
  { name: 'Chimera', beast: '', hi: '#dac9b4', lo: '#b0834e', mid: '#785935', dk: '#4a3721', deep: '#271d11',
    enamel: '#111a27', accent: '#b0834e', parts: ['rivets'], glow: null, glowStop: 0 },
  { name: 'Hydra', beast: '', hi: '#bdad9e', lo: '#9aa2ab', mid: '#696e74', dk: '#414448', deep: '#222426',
    enamel: '#111a27', accent: '#9aa2ab', parts: ['rivets', 'bolts'], glow: null, glowStop: 0 },
  { name: 'Kraken', beast: '', hi: '#e5ceae', lo: '#c9a24a', mid: '#896e32', dk: '#54441f', deep: '#2c2410',
    enamel: '#111a27', accent: '#c9a24a', parts: ['rivets', 'bolts', 'laurel'], glow: null, glowStop: 0 },
  { name: 'Warlord', beast: '', hi: '#f2d4aa', lo: '#a8202f', mid: '#721620', dk: '#470d14', deep: '#25070a',
    enamel: '#111a27', accent: '#a8202f', parts: ['rivets', 'bolts', 'laurel', 'banner'], glow: '#a8202f', glowStop: 0.26 },
  { name: 'Colossus', beast: '', hi: '#e6cfa6', lo: '#1f8a53', mid: '#155e38', dk: '#0d3a23', deep: '#071e12',
    enamel: '#111a27', accent: '#1f8a53', parts: ['rivets', 'bolts', 'laurel', 'banner', 'gem'], glow: '#1f8a53', glowStop: 0.32 },
  { name: 'Titan', beast: '', hi: '#cac6be', lo: '#2f63c0', mid: '#204383', dk: '#142a51', deep: '#0a162a',
    enamel: '#111a27', accent: '#2f63c0', parts: ['rivets', 'bolts', 'laurel', 'banner', 'gem', 'wings'], glow: '#2f63c0', glowStop: 0.38 },
  { name: 'Celestial', beast: '', hi: '#e7e3df', lo: '#7ba6dd', mid: '#547196', dk: '#34465d', deep: '#1b2531',
    enamel: '#111a27', accent: '#7ba6dd', parts: ['rivets', 'bolts', 'laurel', 'banner', 'gem', 'wings', 'spikes'], glow: '#7ba6dd', glowStop: 0.45 },
  { name: 'Phoenix', beast: '', hi: '#fdd582', lo: '#ff7a1a', mid: '#ad5312', dk: '#6b330b', deep: '#381b06',
    enamel: '#111a27', accent: '#ff7a1a', parts: ['rivets', 'bolts', 'laurel', 'banner', 'gem', 'wings', 'spikes', 'crown'], glow: '#ff7a1a', glowStop: 0.52 },
  { name: 'Dragon', beast: '', hi: '#e2d6c2', lo: '#a78bfa', mid: '#725faa', dk: '#463a69', deep: '#251f37',
    enamel: '#111a27', accent: '#a78bfa', parts: ['rivets', 'bolts', 'laurel', 'banner', 'gem', 'wings', 'spikes', 'crown', 'rays', 'halo'], glow: '#a78bfa', glowStop: 0.6 },
  ];

  /* Where the division numeral is struck on each painted badge.
   *
   * [x, y, w, h] as fractions of the exported image. MEASURED, not chosen:
   * the pipeline finds each plate as the widest low-detail slab inside the
   * badge's lower third and writes these out. The ten came back between 0.236
   * and 0.332 wide and 0.70 to 0.79 down, which is close enough to look
   * deliberate and far enough apart that one hard-coded rectangle would sit
   * off the plate on half the set.
   *
   * Regenerate alongside the art. A tier with no entry simply shows no
   * numeral, which is what should happen while its art is being reworked. */
  var RANK_PLATES = [
    [0.3603, 0.7912, 0.2601, 0.0631],
    [0.3571, 0.7915, 0.2849, 0.0640],
    [0.3331, 0.7912, 0.3281, 0.0514],
    [0.3421, 0.7029, 0.2356, 0.0615],
    [0.3347, 0.7436, 0.3315, 0.0855],
    [0.3347, 0.7442, 0.3307, 0.0853],
    [0.3376, 0.7448, 0.3273, 0.0848],
    [0.3529, 0.7059, 0.2879, 0.0740],
    [0.3496, 0.7424, 0.3007, 0.0633],
    [0.3438, 0.7656, 0.3001, 0.0540],
  ];

  var RANK_ROMAN = ['I', 'II', 'III'];

  /* The ladder: ten prestiges of FIVE ranks each, fifty in all.
   *
   * A driver finishing prestige 1 rank 5 rolls into prestige 2 rank 1, not a
   * sixth rank. band 1..50 is the rank and the backend sends nothing else, so
   * the pair is derived here exactly as leaderboard_service derives it:
   *
   *   band  7  ->  prestige 2 (Chimera), rank 2, "Chimera II"
   *   band 50  ->  prestige 10 (Dragon), rank 5, the top of the ladder
   *
   * The frontend used to drop this structure on the floor and print the key
   * back out, which is where "Band 004" came from.
   *
   * RANKS_PER_PRESTIGE is the only number to change if the shape moves again:
   * every derived value below, the pips on the ladder and the clamp on the key
   * all read from it rather than repeating 5. */
  var PRESTIGE_COUNT = 10;
  var RANKS_PER_PRESTIGE = 3;
  var RANK_BAND_COUNT = PRESTIGE_COUNT * RANKS_PER_PRESTIGE;

  function rankFromBand(band) {
    var b = Math.max(1, Math.min(RANK_BAND_COUNT, Math.floor(Number(band) || 1)));
    var index = Math.floor((b - 1) / RANKS_PER_PRESTIGE);
    var level = ((b - 1) % RANKS_PER_PRESTIGE) + 1;
    var tier = RANK_TIERS[index];
    return {
      band: b,
      prestige: index + 1,
      prestigeIndex: index,
      level: level,
      roman: RANK_ROMAN[level - 1],
      name: tier.name,
      beast: tier.beast,
      label: tier.name + ' ' + RANK_ROMAN[level - 1],
      isMax: b >= RANK_BAND_COUNT,
    };
  }

  function rankFromKey(rankIconKey) {
    return rankFromBand(resolveRankIconBand(rankIconKey));
  }

  /* Where a band's artwork comes from.
   *
   * The badges live in the database, one image per band, and are served from
   * /ranks/badge/<key>?v=<sha256 of the bytes>. That version is what makes
   * them cacheable forever: artwork that has not changed is never fetched
   * twice, and artwork that has gets a URL the cache has never seen.
   *
   * The manifest is one request for the whole set and it is fetched once. It
   * cannot be awaited here, because a badge renders synchronously inside a
   * feed row -- so rendering always emits a src that works immediately, and
   * the manifest upgrades what is already on screen when it lands.
   *
   * THE FALLBACK IS THE PAINTED PRESTIGE
   *
   * Until a band's own artwork is uploaded, it wears its prestige's painted
   * badge: all five ranks of prestige 4 show the Tiger. That is deliberate
   * rather than a placeholder -- a driver never sees a gap, the ladder still
   * reads as ten distinct tiers, and the numeral struck on the nameplate
   * already says which of the five they are on. The vector badge beneath
   * remains the last resort for a build with no art at all. */
  var RANK_BADGE_MANIFEST = Object.create(null);
  var rankBadgeManifestState = 'idle';

  function rankBadgeApiBase() {
    if (typeof window === 'undefined') return '';
    var explicit = String(window.API_BASE || '').trim();
    if (explicit) return explicit.replace(/\/+$/, '');
    var configured = String(
      (window.__TLC_RUNTIME_CONFIG__ && window.__TLC_RUNTIME_CONFIG__.apiBase) || '').trim();
    if (configured) return configured.replace(/\/+$/, '');
    return '';
  }

  /* The prestige's painted file, which ships in this repo. */
  function paintedBadgeSrc(band) {
    return './rank-frames/tier-' + rankFromBand(band).prestige + '.webp';
  }

  function rankBadgeSrc(band) {
    var rank = rankFromBand(band);
    return RANK_BADGE_MANIFEST['band_' + String(rank.band).padStart(3, '0')]
      || paintedBadgeSrc(rank.band);
  }

  /* Point every badge already on screen at its uploaded artwork. Called once,
     when the manifest lands. A badge whose band has no upload keeps the src it
     was rendered with, so nothing flickers back to a placeholder. */
  function applyRankBadgeManifestToDom() {
    if (typeof document === 'undefined') return;
    var wraps = document.querySelectorAll('.rankBadgeIconWrap[data-rank-band]');
    Array.prototype.forEach.call(wraps, function (wrap) {
      var img = wrap.querySelector('img.rankBadgeFrame');
      if (!img) return;
      var next = rankBadgeSrc(Number(wrap.getAttribute('data-rank-band')));
      if (next && img.getAttribute('src') !== next) {
        img.setAttribute('src', next);
        /* It failed on the painted file and the class was stripped; uploaded
           art deserves its own attempt at painting. */
        wrap.classList.add('rankBadgePainted');
      }
    });
  }

  function loadRankBadgeManifest() {
    if (rankBadgeManifestState !== 'idle') return;
    if (typeof fetch !== 'function') return;
    rankBadgeManifestState = 'loading';
    var base = rankBadgeApiBase();
    fetch(base + '/ranks/badges', { credentials: 'omit' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (body) {
        var items = (body && body.items) || [];
        items.forEach(function (item) {
          var key = String((item && item.rank_icon_key) || '');
          var url = String((item && item.url) || '');
          if (!key || !url) return;
          RANK_BADGE_MANIFEST[key] = /^https?:\/\//i.test(url) ? url : base + url;
        });
        rankBadgeManifestState = 'ready';
        applyRankBadgeManifestToDom();
      })
      .catch(function () {
        /* Swallowed on purpose. Every badge already has a painted file to
           show, so a manifest that does not arrive costs nothing a driver can
           see -- and a rank badge is not worth a console error on every open
           for someone running offline. */
        rankBadgeManifestState = 'failed';
      });
  }

  /* A backend rank_name is used when it is a name, and ignored when it is the
   * key spelled out. "Band 004" is not something to show a driver, and neither
   * is an empty string, so both fall through to the derived label. */
  function rankDisplayName(source) {
    var raw = String((source && (source.rank_name || source.title)) || '').trim();
    if (raw && !/^band[\s_-]*\d+$/i.test(raw)) return raw;
    return rankFromKey(source && source.rank_icon_key).label;
  }

  /* One frame per tier, in climbing order of complexity. `out` is the
     silhouette, `lit` the half the light falls on, and `inner` the recessed
     field the emblem sits in. Everything else about the surface is painted
     inside `out` used as a clip, so these three are all a frame has to carry. */
  var FRAMES = [
    { // 1 bronze -- a plain heater shield, the simplest thing that is a badge
      out: 'M48 16l26 9.5v23c0 16.5-10.8 28.5-26 34.5-15.2-6-26-18-26-34.5v-23z',
      lit: 'M48 16L22 25.5v23c0 16.5 10.8 28.5 26 34.5z',
      inner: 'M48 25l18 6.6v16c0 11.4-7.5 19.7-18 23.9-10.5-4.2-18-12.5-18-23.9v-16z' },
    { // 2 iron -- a slab with the corners taken off, riveted
      out: 'M30 16h36l8 10v30l-8 10H30l-8-10V26z',
      lit: 'M30 16L22 26v30l8 10h18V16z',
      inner: 'M34 25h28l5 7v22l-5 7H34l-5-7V32z' },
    { // 3 steel -- a hexagon shoulder over a point
      out: 'M48 12l25 11v22L48 82 23 45V23z',
      lit: 'M48 12L23 23v22l25 37z',
      inner: 'M48 24l16 7v15L48 68 32 46V31z' },
    { // 4 silver -- a kite, the first shape with a point at the top
      out: 'M48 12l28 18v20L48 84 20 50V30z',
      lit: 'M48 12L20 30v20l28 34z',
      inner: 'M48 24l19 12v13L48 70 29 49V36z' },
    { // 5 gold -- a struck disc, the only round frame on the ladder
      out: 'M48 13a31 31 0 1 1 0 62 31 31 0 0 1 0-62z',
      lit: 'M48 13a31 31 0 0 0 0 62z',
      inner: 'M48 25a19 19 0 1 1 0 38 19 19 0 0 1 0-38z' },
    { // 6 platinum -- a cartouche, sides drawn in
      out: 'M48 13c10 0 19 4 27 11-7 8-7 20 0 28-8 7-17 11-27 11s-19-4-27-11c7-8 7-20 0-28 8-7 17-11 27-11z',
      lit: 'M48 13c-10 0-19 4-27 11 7 8 7 20 0 28 8 7 17 11 27 11z',
      inner: 'M48 25c6.6 0 12.6 2.6 17.8 7-4.6 5.2-4.6 13 0 18.2C60.6 54.6 54.6 57 48 57s-12.6-2.4-17.8-6.8c4.6-5.2 4.6-13 0-18.2C35.4 27.6 41.4 25 48 25z' },
    { // 7 sapphire -- a cut gem, table and pavilion
      out: 'M30 16h36l16 20-34 44-34-44z',
      lit: 'M30 16L14 36l34 44V16z',
      inner: 'M35 27h26l10 11-23 29-23-29z' },
    { // 8 emerald -- a trapezoid crest over a point
      out: 'M30 14h36l10 14-6 10 4 12L48 82 22 50l4-12-6-10z',
      lit: 'M30 14L20 28l6 10-4 12 26 32V14z',
      inner: 'M35 25h26l6 9-4 7 3 8L48 68 30 49l3-8-4-7z' },
    { // 9 crimson -- a star plate, cut back between the points
      out: 'M48 10l12 10 16-2-2 16 10 12-10 12 2 16-16-2-12 10-12-10-16 2 2-16L12 46l10-12-2-16 16 2z',
      lit: 'M48 10L36 20l-16-2 2 16-10 12 10 12-2 16 16-2 12 10z',
      inner: 'M48 23l9 7 11-1-1 11 7 8-7 8 1 11-11-1-9 7-9-7-11 1 1-11-7-8 7-8-1-11 11 1z' },
    { // 10 mythic -- a twelve point star medallion
      out: 'M48 6l7 8 10-4 3 10 11 1-3 10 9 6-7 8 5 10-10 3-1 11-10-2-6 9-8-7-9 5-4-10-11-1 2-10-9-7 8-8-4-10 11-2 1-11 10 3z',
      lit: 'M48 6L38 9l-1 11-11 2 4 10-8 8 9 7-2 10 11 1 4 10 9-5z',
      inner: 'M48 22l6 6 8-3 2 8 9 1-2 8 7 5-6 6 4 8-8 2-1 9-8-2-5 7-6-6-7 4-3-8-9-1 2-8-7-5 6-6-3-8 9-2 1-9z' },
  ];

  /* Furniture, behind and in front. [path, depth] -- depth below 1 sits the
     piece back in the picture without giving it a colour of its own. */
  var PARTS = {
    halo: [['M48 3.5A44.5 44.5 0 1 1 3.5 48 44.5 44.5 0 0 1 48 3.5zm0 4.5A40 40 0 1 0 88 48 40 40 0 0 0 48 8z', 0.7]],
    rays: [['M48 0l3.4 11h-6.8zM48 96l-3.4-11h6.8zM0 48l11-3.4v6.8zM96 48l-11 3.4v-6.8z'
      + 'M14 14l9.6 6-3.6 3.6zM82 82l-9.6-6 3.6-3.6zM82 14l-6 9.6-3.6-3.6zM14 82l6-9.6 3.6 3.6z'
      + 'M71.4 2.6l-2.2 11.4-5.7-2.6zM24.6 93.4l2.2-11.4 5.7 2.6zM93.4 71.4l-11.4-2.2 2.6-5.7zM2.6 24.6l11.4 2.2-2.6 5.7z', 0.55]],
    wings: [['M25 40C18 33 11 29.5 2 30.5c5.4 3 7.8 6.8 8.2 11-4 .6-7.2 2.2-9.6 4.6 6.4.4 11.2 2 15 4.6-2 1.8-3.4 3.8-4 6.2 5.8-1.6 10.2-3.6 13.4-6.4zM71 40c7-7 14-10.5 23-9.5-5.4 3-7.8 6.8-8.2 11 4 .6 7.2 2.2 9.6 4.6-6.4.4-11.2 2-15 4.6 2 1.8 3.4 3.8 4 6.2-5.8-1.6-10.2-3.6-13.4-6.4z', 0.82]],
    laurel: [['M11 32c-8 12-6 28 4 38l4-5.6c-7.6-8-9-19.4-4-28zM85 32c8 12 6 28-4 38l-4-5.6c7.6-8 9-19.4 4-28z', 0.88]],
    spikes: [['M48 0l4 12h-8zM76.8 7.7l-2.2 12.5-6.9-4zM19.2 7.7l2.2 12.5 6.9-4zM93.6 33.4l-8.4 9.5-4.6-6.6zM2.4 33.4l8.4 9.5 4.6-6.6zM93.6 62.6l-11.6-5.2 3.2-7.4zM2.4 62.6l11.6-5.2-3.2-7.4zM76.8 88.3l-9.1-8.8 5.6-5.8zM19.2 88.3l9.1-8.8-5.6-5.8z', 0.72]],
    crown: [['M27 5l8.4 7.8L48 -2l12.6 14.8L69 5l-3.4 15H30.4z', 1]],
    banner: [['M20 79h56l-5.5 10H25.5z', 0.92]],
    rivets: [['M32 30.5a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2zM64 30.5a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2z', 1]],
    bolts: [['M31 62.5a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4zM65 62.5a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4z', 1]],
    gem: [['M48 18l5.5 5.8-5.5 5.8-5.5-5.8z', 1]],
  };

  /* Ten emblems. `d` is the silhouette; `cut` is the interior -- the lines a
     die would leave, drawn back in dark so the emblem is modelled rather than
     stamped flat. */
  var EMBLEMS = [
    { name: 'Chevrons',
      d: 'M48 26l20 14h-10L48 33l-10 7H28zM48 42l20 14h-10L48 49l-10 7H28zM48 58l20 14h-10L48 65l-10 7H28z',
      cut: 'M48 29.5l14 9.5h-2.6L48 31.4 36.6 39H34zM48 45.5l14 9.5h-2.6L48 47.4 36.6 55H34zM48 61.5l14 9.5h-2.6L48 63.4 36.6 71H34z' },
    { name: 'Wolf',
      d: 'M26 20l12 12h20l12-12-2 20-6 5 4 10-18 17-18-17 4-10-6-5zM40 44l5 4-7 2zM56 44l-5 4 7 2zM48 56l6 8H42z',
      cut: 'M48 32v24h-1.6V32zM30 26l6 6-.8 1.2-6-6zM66 26l-6 6 .8 1.2 6-6zM38 62l10 9.5 10-9.5-1.4-1.4-8.6 8-8.6-8z' },
    { name: 'Wings',
      d: 'M48 28l5 9v32l-5 8-5-8V37zM38 40c-9-8-19-10-31-8 8 4 12 10 12 16 6-2 13 0 19 4zM58 40c9-8 19-10 31-8-8 4-12 10-12 16-6-2-13 0-19 4zM38 58c-8-6-16-8-25-6 6 4 10 8 10 12 5-2 11-2 15 0zM58 58c8-6 16-8 25-6-6 4-10 8-10 12-5-2-11-2-15 0z',
      cut: 'M47 37h2v32h-2zM20 34c6 2 11 6 15 10l-1.4 1c-4-4-8.6-7.6-14-9.4zM76 34c-6 2-11 6-15 10l1.4 1c4-4 8.6-7.6 14-9.4z' },
    { name: 'Star',
      d: 'M48 20l9 20 22 3-16 15 4 22-19-11-19 11 4-22-16-15 22-3z',
      cut: 'M48 20v59.9l-1.6-.9V21.6zM48 43.4l31-.4-1 1-30 .4zM48 43.4l-31-.4 1 1 30 .4z' },
    { name: 'Skull',
      d: 'M48 20c15 0 23 10 23 22 0 7.6-3.2 13.2-8 16v9l-5 5H38l-5-5v-9c-4.8-2.8-8-8.4-8-16 0-12 8-22 23-22zM38 44a6.4 6.4 0 1 0 0 12.8A6.4 6.4 0 0 0 38 44zM58 44a6.4 6.4 0 1 0 0 12.8A6.4 6.4 0 0 0 58 44zM48 60l5 8h-10z',
      cut: 'M33 58h30v2H33zM42 62h2v10h-2zM52 62h2v10h-2zM47 62h2v10h-2z' },
    { name: 'Blades',
      d: 'M18 20l12-3 36 43 3 12-12-3-39-42zM78 20l-12-3-36 43-3 12 12-3 39-42z',
      cut: 'M24 18.5l38 44.5-1.4 1.2-38-44.4zM72 18.5l-38 44.5 1.4 1.2 38-44.4z' },
    { name: 'Flame',
      d: 'M48 12c4 14 22 20 22 38 0 14-10 24-22 24s-22-10-22-24c0-10 6-16 10-24 2 6 6 8 8 6 2-6-2-12 4-20zM48 48c2 6 8 8 8 14 0 5-3.6 9-8 9s-8-4-8-9c0-6 6-8 8-14z',
      cut: 'M48 12c-6 8-2 14-4 20-2 2-6 0-8-6l-1.4 2.8c2.6 6 7 8 10 5.6 3-2.4 1.4-9 3.4-16z' },
    { name: 'Bull',
      d: 'M16 26c10-4 16 2 18 8h28c2-6 8-12 18-8-8 3-11 9-11 16L60 52l3 14-15 12-15-12 3-14-9-10c0-7-3-13-11-16zM40 48l5 4-7 2zM56 48l-5 4 7 2z',
      cut: 'M34 34h28v1.8H34zM48 60v18h-1.6V60zM36 52l-2 12 1.6.4 2-12zM60 52l2 12-1.6.4-2-12z' },
    { name: 'Bolt',
      d: 'M54 12L26 52h16l-8 32 36-44H52l10-28z',
      cut: 'M42 52l12-15.6-1-.6-12.4 16z' },
    { name: 'Crown',
      d: 'M18 32l13 13L48 20l17 25 13-13-6 34H24zM24 70h48v8H24z',
      cut: 'M24 60h48v2H24zM33 48.5l1.6-1L48 26l13.4 21.5 1.6 1L48 30z' },
  ];

  var BEHIND = ['halo', 'rays', 'wings', 'laurel', 'spikes'];
  var INFRONT = ['banner', 'crown', 'rivets', 'bolts', 'gem'];

  function rankBadgeSvg(band, size) {
    var rank = rankFromBand(band);
    var b = rank.band;
    var t = rank.prestigeIndex;
    var tier = RANK_TIERS[t];
    var frame = FRAMES[t];
    /* EMBLEMS still holds ten, authored in climbing order of complexity, and
       a prestige now has five ranks. Taking the first five would give the top
       rank of every prestige a mid-table emblem, so the five are spread across
       the ten instead -- rank 1 gets the plainest and rank 5 the richest, the
       way it read when there were ten of them. */
    var emblemStep = Math.floor(EMBLEMS.length / RANKS_PER_PRESTIGE);
    var em = EMBLEMS[Math.min(EMBLEMS.length - 1, (rank.level - 1) * emblemStep)];
    var id = 'rb' + b;
    var px = size || 68;

    function furniture(names) {
      var out = '';
      for (var i = 0; i < names.length; i++) {
        var spec = PARTS[names[i]];
        if (!spec || tier.parts.indexOf(names[i]) < 0) continue;
        for (var j = 0; j < spec.length; j++) {
          out += '<path d="' + spec[j][0] + '" fill="' + tier.deep + '" opacity=".6" transform="translate(0,1.6)"/>'
            + '<path d="' + spec[j][0] + '" fill="url(#' + id + 'm)" opacity="' + spec[j][1] + '"/>'
            + '<path d="' + spec[j][0] + '" fill="none" stroke="' + tier.hi + '" stroke-opacity=".38" stroke-width=".8" transform="translate(0,-.7)"/>';
        }
      }
      return out;
    }

    var glowDef = tier.glow
      ? '<radialGradient id="' + id + 'g">'
        + '<stop offset="54%" stop-color="' + tier.glow + '" stop-opacity="0"/>'
        + '<stop offset="76%" stop-color="' + tier.glow + '" stop-opacity="' + tier.glowStop + '"/>'
        + '<stop offset="100%" stop-color="' + tier.glow + '" stop-opacity="0"/>'
        + '</radialGradient>'
      : '';

    var metalStops = t === 9
      ? '<stop offset="0%" stop-color="#ffffff"/><stop offset="22%" stop-color="#9fe8ff"/>'
        + '<stop offset="48%" stop-color="#c98cff"/><stop offset="74%" stop-color="#6d2fb5"/>'
        + '<stop offset="100%" stop-color="#26094a"/>'
      : '<stop offset="0%" stop-color="' + tier.hi + '"/>'
        + '<stop offset="20%" stop-color="' + tier.lo + '"/>'
        + '<stop offset="52%" stop-color="' + tier.mid + '"/>'
        + '<stop offset="82%" stop-color="' + tier.dk + '"/>'
        + '<stop offset="100%" stop-color="' + tier.deep + '"/>';

    return '<svg viewBox="0 0 96 96" width="' + px + '" height="' + px
      + '" role="presentation" focusable="false" aria-hidden="true">'
      + '<defs>'
      + '<linearGradient id="' + id + 'm" x1=".12" y1="0" x2=".82" y2="1">' + metalStops + '</linearGradient>'
      + '<linearGradient id="' + id + 'e" x1=".2" y1="0" x2=".8" y2="1">'
      + '<stop offset="0%" stop-color="' + tier.enamel + '"/><stop offset="100%" stop-color="#05070e"/>'
      + '</linearGradient>'
      + '<linearGradient id="' + id + 'x" x1="0" y1="0" x2=".3" y2="1">'
      + '<stop offset="0%" stop-color="' + tier.hi + '"/><stop offset="46%" stop-color="' + tier.lo + '"/>'
      + '<stop offset="100%" stop-color="' + tier.mid + '"/></linearGradient>'
      // Top sheen and bottom vignette, painted inside the clip rather than
      // authored as extra faces per frame.
      + '<linearGradient id="' + id + 't" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0%" stop-color="#ffffff" stop-opacity=".34"/>'
      + '<stop offset="34%" stop-color="#ffffff" stop-opacity="0"/>'
      + '<stop offset="72%" stop-color="#000000" stop-opacity="0"/>'
      + '<stop offset="100%" stop-color="#000000" stop-opacity=".42"/>'
      + '</linearGradient>'
      // A hard diagonal streak: the one highlight that says "polished".
      + '<linearGradient id="' + id + 'p" x1="0" y1="0" x2="1" y2="1">'
      + '<stop offset="30%" stop-color="#ffffff" stop-opacity="0"/>'
      + '<stop offset="44%" stop-color="#ffffff" stop-opacity=".38"/>'
      + '<stop offset="50%" stop-color="#ffffff" stop-opacity="0"/>'
      + '</linearGradient>'
      /* Brushed metal. An anisotropic baseFrequency -- high across, almost
         nothing down -- turns fractal noise into horizontal grain, which is what
         a brushed surface is. Desaturated and dropped to a low alpha so it reads
         as tooling rather than dirt. */
      + '<filter id="' + id + 'n" x="0" y="0" width="100%" height="100%">'
      + '<feTurbulence type="fractalNoise" baseFrequency="0.85 0.035" numOctaves="3" seed="' + b + '"/>'
      + '<feColorMatrix type="saturate" values="0"/>'
      + '<feComponentTransfer><feFuncA type="linear" slope=".22" intercept="0"/></feComponentTransfer>'
      + '</filter>'
      + '<filter id="' + id + 'd" x="-30%" y="-30%" width="160%" height="160%">'
      + '<feDropShadow dx="0" dy="2.4" stdDeviation="2.2" flood-color="#04060d" flood-opacity=".7"/>'
      + '</filter>'
      + '<clipPath id="' + id + 'c"><path d="' + frame.out + '"/></clipPath>'
      + '<clipPath id="' + id + 'i"><path d="' + frame.inner + '"/></clipPath>'
      + glowDef
      + '</defs>'
      + (tier.glow ? '<circle cx="48" cy="48" r="47" fill="url(#' + id + 'g)"/>' : '')
      + furniture(BEHIND)
      + '<g filter="url(#' + id + 'd)">'
      + '<g clip-path="url(#' + id + 'c)">'
      + '<rect width="96" height="96" fill="url(#' + id + 'm)"/>'
      + '<path d="' + frame.lit + '" fill="' + tier.hi + '" opacity=".20"/>'
      + '<rect width="96" height="96" fill="url(#' + id + 't)"/>'
      + '<rect width="96" height="96" filter="url(#' + id + 'n)" opacity=".55"/>'
      + '<rect width="96" height="96" fill="url(#' + id + 'p)"/>'
      + '</g>'
      // Bevel: a rim light lifted off the top edge, a dark line on the true edge.
      + '<path d="' + frame.out + '" fill="none" stroke="' + tier.hi + '" stroke-opacity=".6" stroke-width="1.6" stroke-linejoin="round" transform="translate(0,-.9)"/>'
      + '<path d="' + frame.out + '" fill="none" stroke="' + tier.deep + '" stroke-opacity=".9" stroke-width="1.3" stroke-linejoin="round"/>'
      + '</g>'
      // The recessed field, with its own grain and its own inner shadow.
      + '<g clip-path="url(#' + id + 'i)">'
      + '<rect width="96" height="96" fill="url(#' + id + 'e)"/>'
      + '<rect width="96" height="96" filter="url(#' + id + 'n)" opacity=".3"/>'
      + '</g>'
      + '<path d="' + frame.inner + '" fill="none" stroke="' + tier.deep + '" stroke-width="2.8" stroke-opacity=".85" stroke-linejoin="round" transform="translate(0,-1)"/>'
      + '<path d="' + frame.inner + '" fill="none" stroke="' + tier.accent + '" stroke-opacity=".5" stroke-width="1.1" stroke-linejoin="round"/>'
      + '<g transform="translate(48,50) scale(.54) translate(-48,-48)">'
      + '<path d="' + em.d + '" fill="' + tier.deep + '" opacity=".9" transform="translate(0,2.6)"/>'
      + '<path d="' + em.d + '" fill="url(#' + id + 'x)"/>'
      + '<path d="' + em.cut + '" fill="' + tier.deep + '" opacity=".55"/>'
      + '<path d="' + em.d + '" fill="none" stroke="' + tier.hi + '" stroke-opacity=".7" stroke-width="1.6" stroke-linejoin="round" transform="translate(0,-1.4)"/>'
      + '<path d="' + em.d + '" fill="none" stroke="' + tier.deep + '" stroke-opacity=".5" stroke-width="1" stroke-linejoin="round"/>'
      + '</g>'
      + furniture(INFRONT)
      + '</svg>';
  }


  function renderRankBadgeIcon(rankIconKey, { compact = false } = {}) {
    const band = resolveRankIconBand(rankIconKey);
    const toneClass = resolveRankIconTone(rankIconKey);
    /* The tier's metal is handed out as custom properties so a surface that
       frames this badge can wear it too. The Trip Saved card pins its medallion
       to gold, which was right when the badge inside was a rainbow disc and
       wrong the moment the badge got a metal of its own: a bronze rank on a
       gold coin reads as a mistake, and a mythic one reads as a worse one. */
    const tier = RANK_TIERS[rankFromBand(band).prestigeIndex];
    const metal = `--rank-lo:${tier.lo};--rank-mid:${tier.mid};--rank-dk:${tier.dk};--rank-ring:${tier.ring}`;
    const size = compact ? 54 : 68;
    /* Uploaded artwork, painted prestige, vector badge -- in that order.
     *
     * None of these is decoration. The uploaded badge is the real one and
     * comes from the database; until a band has one it wears its prestige's
     * painted file, which ships in this repo; and if THAT fails -- a cached
     * older build, a prestige whose art is being reworked -- onerror strips
     * the class, CSS hides the image and shows the vector badge already in
     * the markup. Nothing about the card moves in any of the three cases. */
    const rank = rankFromBand(band);
    /* The division is struck on the badge's own nameplate.
     *
     * It is positioned and sized from the measured plate rather than dropped
     * at the foot: the plates differ by a third in width across the ten, and
     * the numeral has to fit VIII as well as I. Below 60px it is left off --
     * measured on the real art, a numeral on a 52px badge is a smudge, and a
     * smudge on every badge reads as dirt rather than as information. The
     * feed shows the division as text beside the driver's name instead. */
    const plate = RANK_PLATES[rank.prestigeIndex];
    const numeral = (plate && size >= 60)
      ? `<span class="rankBadgeDivision" style="`
        + `left:${(plate[0] * 100).toFixed(2)}%;top:${(plate[1] * 100).toFixed(2)}%;`
        + `width:${(plate[2] * 100).toFixed(2)}%;height:${(plate[3] * 100).toFixed(2)}%;`
        + `font-size:${Math.max(6, Math.round(plate[3] * size * 0.86))}px`
        + `">${rank.roman}</span>`
      : '';

    return `<div class="rankBadgeIconWrap ${toneClass}${compact ? ' compact' : ''} rankBadgePainted" aria-hidden="true" data-rank-band="${band}" data-rank-label="${rank.label}" style="${metal};--rank-size:${size}px">`
      + `<img class="rankBadgeFrame" src="${rankBadgeSrc(rank.band)}" alt="" width="${size}" height="${size}" decoding="async"`
      + ` onerror="this.closest('.rankBadgeIconWrap')?.classList.remove('rankBadgePainted')">`
      + numeral
      + `<span class="rankBadgeVector">${rankBadgeSvg(band, size)}</span>`
      + `</div>`;
  }

  function renderDriverProgressionSection(progression) {
    const level = Number(progression?.level);
    const safeLevel = Number.isFinite(level) && level > 0 ? Math.floor(level) : 1;
    const rank = rankFromKey(progression?.rank_icon_key);
    const title = rankDisplayName(progression);
    const totalXp = Number(progression?.total_xp);
    const currentLevelXp = Number(progression?.current_level_xp);
    const nextLevelXp = Number(progression?.next_level_xp);
    const xpToNextLevel = Number(progression?.xp_to_next_level);
    const maxLevelReached = progression?.max_level_reached === true
      || progression?.is_max_level === true
      || (Number.isFinite(xpToNextLevel) && xpToNextLevel <= 0);
    const lifetimeMiles = Number(progression?.lifetime_miles);
    const lifetimeHours = Number(progression?.lifetime_hours);
    const lifetimePickups = Number(progression?.lifetime_pickups_recorded);
    const milesXp = Number(progression?.xp_breakdown?.miles_xp);
    const hoursXp = Number(progression?.xp_breakdown?.hours_xp);
    const reportXp = Number(progression?.xp_breakdown?.report_xp);
    const gameXp = Number(progression?.xp_breakdown?.game_xp);

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
        <div class="driverProfileProgressHeadText">
          <div class="driverProfileProgressLine">Level ${safeLevel} • <span class="driverProfileRankName">${escapeHtml(title)}</span></div>
          <div class="driverProfilePrestigeLine">Prestige ${rank.prestige} of 10 • ${escapeHtml(rank.beast)}</div>
        </div>
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
        <div class="driverProfileProgressMeta">Game XP: ${escapeHtml(formatProgressNumber(gameXp, { maxFractionDigits: 0 }))}</div>
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

  function renderBattleStatsSection(stats) {
    const safe = { ...chatInternals.defaultBattleStats?.(), ...(stats && typeof stats === 'object' ? stats : {}) };
    const totalMatches = Number(safe.total_matches ?? safe.matches_played ?? 0) || 0;
    const wins = Number(safe.wins ?? safe.total_wins ?? 0) || 0;
    const losses = Number(safe.losses ?? safe.total_losses ?? 0) || 0;
    const winRate = safe.win_rate ?? (totalMatches > 0 ? (wins / totalMatches) : 0);
    const cards = [
      ['Wins', wins],
      ['Losses', losses],
      ['Matches', totalMatches],
      ['Win rate', chatInternals.formatBattlePct?.(winRate)],
      ['Dominoes W', safe.dominoes_wins],
      ['Dominoes L', safe.dominoes_losses],
      ['Billiards W', safe.billiards_wins],
      ['Billiards L', safe.billiards_losses],
      ['Game XP', formatProgressNumber(safe.game_xp_earned, { maxFractionDigits: 0 })],
    ];
    return `<div class="driverProfileBattleGrid">${cards.map(([label, value]) => `<div class="driverProfileBattleCard"><div class="driverProfileBattleLabel">${escapeHtml(String(label))}</div><div class="driverProfileBattleValue">${escapeHtml(String(value))}</div></div>`).join('')}</div>`;
  }

  function renderRecentBattlesList(items) {
    const rows = Array.isArray(items) ? items.slice(0, 5) : [];
    if (!rows.length) return '<div class="driverProfileStatus">No recent battles yet.</div>';
    return `<div class="driverProfileRecentBattles">${rows.map((row) => {
      const result = chatInternals.battleResultLabel?.(row) || 'Pending';
      const game = String(row?.game_key || row?.game_type || 'battle').replace(/^./, (m) => m.toUpperCase());
      const opponent = String(
        row?.opponent_display_name
        || row?.other_user_display_name
        || row?.challenger_display_name
        || row?.challenged_display_name
        || row?.opponent_name
        || 'Driver'
      );
      const xp = Number(row?.xp_awarded ?? row?.xp_delta ?? row?.xp ?? 0);
      const battleTime = row?.completed_at || row?.updated_at || row?.created_at || '';
      return `<article class="driverProfileRecentBattle ${result.toLowerCase()}"><div class="driverProfileRecentBattleTop"><strong>${escapeHtml(game)}</strong><span>${escapeHtml(result)}</span></div><div class="driverProfileRecentBattleMeta">vs ${escapeHtml(opponent)} • ${escapeHtml(chatInternals.formatBattleDate?.(battleTime) || '—')}</div><div class="driverProfileRecentBattleMeta">${xp > 0 ? `+${escapeHtml(formatProgressNumber(xp, { maxFractionDigits: 0 }))} XP` : 'Completed'}</div></article>`;
    }).join('')}</div>`;
  }

  function resolveViewerRelationship(profilePayload = {}) {
    const rel = profilePayload?.viewer_game_relationship && typeof profilePayload.viewer_game_relationship === 'object'
      ? profilePayload.viewer_game_relationship
      : {};
    const summary = profilePayload?.active_match_summary && typeof profilePayload.active_match_summary === 'object'
      ? profilePayload.active_match_summary
      : {};
    const incoming = rel?.incoming_challenge || rel?.incoming || null;
    const outgoing = rel?.outgoing_challenge || rel?.outgoing || null;
    const active = rel?.active_match || summary || null;
    const activeId = Number(active?.id || active?.match_id || 0);
    if (activeId > 0) {
      return {
        kind: 'active',
        label: String(active?.status || 'Active match in progress'),
        gameType: String(active?.game_type || active?.game_key || rel?.game_type || rel?.game_key || 'dominoes'),
        matchId: activeId,
      };
    }
    const incomingId = Number(incoming?.id || incoming?.challenge_id || rel?.incoming_challenge_id || 0);
    if (incomingId > 0 || String(rel?.state || rel?.relationship || '').toLowerCase() === 'incoming') {
      return {
        kind: 'incoming',
        label: 'Incoming challenge waiting',
        gameType: String(incoming?.game_type || incoming?.game_key || rel?.game_type || rel?.game_key || 'dominoes'),
        matchId: 0,
      };
    }
    const outgoingId = Number(outgoing?.id || outgoing?.challenge_id || rel?.outgoing_challenge_id || 0);
    if (outgoingId > 0 || String(rel?.state || rel?.relationship || '').toLowerCase() === 'outgoing') {
      return {
        kind: 'outgoing',
        label: 'Challenge already sent',
        gameType: String(outgoing?.game_type || outgoing?.game_key || rel?.game_type || rel?.game_key || 'dominoes'),
        matchId: 0,
      };
    }
    return { kind: 'none', label: '', gameType: 'dominoes', matchId: 0 };
  }

  function renderProfileGameActionButtons(profilePayload, selfMode) {
    if (selfMode) return '';
    const rel = resolveViewerRelationship(profilePayload);
    const challengeLabel = rel.kind === 'active'
      ? 'Open Match'
      : rel.kind === 'incoming'
        ? 'View Challenge'
        : rel.kind === 'outgoing'
          ? 'View Challenge'
          : 'Challenge';
    const disabled = '';
    return `<button class="driverProfileActionBtn" id="driverProfileChallengeBtn" type="button" data-rel-kind="${escapeHtml(rel.kind)}" data-game-type="${escapeHtml(rel.gameType)}" data-match-id="${escapeHtml(String(rel.matchId || ''))}"${disabled}>${escapeHtml(challengeLabel)}</button><button class="driverProfileActionBtn" id="driverProfileOpenInboxBtn" type="button">Message</button>`;
  }

  function renderProfileRelationshipStatus(profilePayload, selfMode) {
    if (selfMode) return '';
    const rel = resolveViewerRelationship(profilePayload);
    if (!rel.label) return '';
    return `<div class="driverProfileStatus">${escapeHtml(rel.label)}</div>`;
  }

  async function fetchDriverProfile(userId) {
    const token = chatInternals.getCommunityToken?.();
    return await getJSONAuth(`/drivers/${encodeURIComponent(userId)}/profile`, token);
  }

  async function fetchDriverProfileDmThread(userId, { after = null, limit = 30, markRead = true } = {}) {
    return await chatInternals.chatFetchPrivateMessages?.(userId, { sinceId: after, limit, markRead });
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
    /* A display:none element reports a rect of all zeros, and zero is a
     * perfectly finite top. That is what broke this: #sliderWrap is the time
     * machine, hidden from every driver by shell-no-scrubber and hidden again
     * by feed-first, so it measured top 0, became the cluster's top, and the
     * card was placed (viewport + 28) off the bottom -- which puts it entirely
     * above the top of the screen. The Trip Saved card has been firing into
     * empty space above the status bar ever since the shell landed.
     *
     * An unrendered node has no position to contribute, so it contributes
     * none. Checked by size rather than by a display lookup because that is
     * what actually distinguishes "not laid out" from "laid out at the top". */
    const measure = (node) => {
      if (!node || typeof node.getBoundingClientRect !== 'function') return null;
      const rect = node.getBoundingClientRect();
      if (!rect || !Number.isFinite(rect.top)) return null;
      if (!rect.width && !rect.height) return null;
      return rect.top;
    };
    const pushTop = (sel) => {
      const top = measure(document.querySelector(sel));
      if (top != null) tops.push(top);
    };
    pushTop('#dock');
    pushTop('#sliderWrap');
    pushTop('#pickupFab');
    document.querySelectorAll('.dockDrawer.open,.dockDrawer[open],#dockDrawer.open,#dockDrawer[open]').forEach((node) => {
      const top = measure(node);
      if (top != null) tops.push(top);
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
    /* The medallion is a child of the card and positioned out of its top, so
       the card's own padding is what keeps the text clear of it. Level and
       rank share one baseline row -- the level left, the rank right -- which
       is what turns the lower half into a ledger line rather than a stack of
       centred labels. */
    el.innerHTML = `<div class="pickupProgressRewardCard">
      <div class="pickupProgressRewardIcon" id="pickupProgressRewardIcon"></div>
      <div class="pickupProgressRewardKicker" id="pickupProgressRewardKicker">Trip Saved</div>
      <div class="pickupProgressRewardRule" id="pickupProgressRewardRule"></div>
      <div class="pickupProgressRewardXp" id="pickupProgressRewardXp"><span id="pickupProgressRewardXpNum">+0</span><span class="pickupProgressRewardXpUnit">XP</span></div>
      <div class="pickupProgressRewardMeta" id="pickupProgressRewardMeta">
        <div class="pickupProgressRewardLevel" id="pickupProgressRewardLevel"></div>
        <div class="pickupProgressRewardRank" id="pickupProgressRewardRank"></div>
      </div>
      <div class="pickupProgressRewardBar"><div class="pickupProgressRewardBase" id="pickupProgressRewardBase"></div><div class="pickupProgressRewardFill" id="pickupProgressRewardFill"></div></div>
      <div class="pickupProgressRewardFoot" id="pickupProgressRewardFoot"></div>
    </div>`;
    document.body.appendChild(el);
    updatePickupRewardLayout();
    return el;
  }

  /* How far along the level the driver was BEFORE this trip.
   *
   * The bar used to run 0 -> total every time, which animates the whole level
   * and shows the trip's own contribution precisely nowhere: a driver who
   * earned 20 XP watched the same sweep as one who earned 200. The gain is
   * the reward, so the gain is what should move. */
  function computePreviousRatio(progression = {}, xpAwarded = 0) {
    const now = computeProgressRatio(progression);
    const gained = Number(xpAwarded);
    const currentLevelXp = Number(progression?.current_level_xp);
    const nextLevelXp = Number(progression?.next_level_xp);
    if (!Number.isFinite(gained) || gained <= 0) return now;
    if (!Number.isFinite(currentLevelXp) || !Number.isFinite(nextLevelXp)) return now;
    const span = nextLevelXp - currentLevelXp;
    if (!(span > 0)) return now;
    // Clamped at zero: a trip that crossed a level leaves a negative
    // difference, and the honest answer there is "you started this level
    // empty", not a bar that runs backwards off the left edge.
    return Math.max(0, Math.min(now, now - (gained / span)));
  }

  /* The number climbs instead of appearing. A printed number has already
   * happened; a climbing one is happening, and that is most of the felt
   * difference between a receipt and a reward. Short enough -- about half a
   * second -- that nobody waiting to drive off is kept waiting. */
  function countUpReward(el, to) {
    if (!el) return;
    const target = Number(to);
    /* Only the figure is written. "XP" is its own span in the markup,
       smaller and gold, so the number is what the eye lands on -- writing
       the whole string here would blow that span away on the first frame. */
    const write = (n) => {
      el.textContent = `+${formatProgressNumber(n, { maxFractionDigits: 0 })}`;
    };
    const finish = () => {
      write(Number.isFinite(target) && target > 0 ? target : 0);
    };
    if (countUpReward._raf && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(countUpReward._raf);
      countUpReward._raf = 0;
    }
    if (!Number.isFinite(target) || target <= 0
      || typeof window.requestAnimationFrame !== 'function'
      || typeof window.performance?.now !== 'function') {
      finish();
      return;
    }
    // Anyone who has asked the system not to animate gets the final number.
    try {
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
        finish();
        return;
      }
    } catch (_) {}
    const DURATION = 520;
    const started = window.performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - started) / DURATION);
      const eased = 1 - Math.pow(1 - t, 3);
      write(Math.round(target * eased));
      if (t < 1) {
        countUpReward._raf = window.requestAnimationFrame(step);
        return;
      }
      countUpReward._raf = 0;
      finish();
    };
    write(0);
    countUpReward._raf = window.requestAnimationFrame(step);
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
    const hasLevel = Number.isFinite(level) && level > 0;
    const safeLevel = hasLevel ? Math.floor(level) : 1;
    const xpAwarded = Number(payload?.xp_awarded ?? progression?.xp_awarded);
    const hasXp = Number.isFinite(xpAwarded) && xpAwarded > 0;
    /* A response that carries no progression at all used to be drawn anyway,
     * which meant a level 37 driver watching "Level 1 / Rookie / +0 XP" scroll
     * up the screen after a save. The card is the only report a driver gets;
     * inventing its numbers is worse than leaving the lines out. Below, every
     * row that has no real value is hidden rather than filled with a default,
     * so the card still says Trip Saved and says nothing it cannot back up. */
    const rankName = rankDisplayName(progression);
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
    const xpNumEl = document.getElementById('pickupProgressRewardXpNum');
    const metaEl = document.getElementById('pickupProgressRewardMeta');
    const levelEl = document.getElementById('pickupProgressRewardLevel');
    const rankEl = document.getElementById('pickupProgressRewardRank');
    const fillEl = document.getElementById('pickupProgressRewardFill');
    const baseEl = document.getElementById('pickupProgressRewardBase');
    const footEl = document.getElementById('pickupProgressRewardFoot');
    if (!kickerEl || !iconEl || !xpEl || !levelEl || !rankEl || !fillEl || !footEl) return false;
    const show = (node, on) => { node.style.display = on ? '' : 'none'; };
    kickerEl.textContent = 'Trip Saved';
    iconEl.innerHTML = renderRankBadgeIcon(progression?.rank_icon_key, { compact: false });
    levelEl.textContent = `Level ${safeLevel}`;
    rankEl.textContent = String(rankName || 'Rookie');
    footEl.textContent = footer;
    show(xpEl, hasXp);
    show(levelEl, hasLevel);
    show(rankEl, hasLevel);
    if (metaEl) show(metaEl, hasLevel);
    show(iconEl, hasLevel);
    show(fillEl.parentNode, hasLevel);
    show(footEl, hasLevel);

    /* The bar in two pieces: where the driver already was, drawn at once and
     * still, and what this trip added, growing out of its right edge. */
    const prevPct = computePreviousRatio(progression, hasXp ? xpAwarded : 0);
    const startLeft = `${Math.round(prevPct * 100)}%`;
    if (baseEl) baseEl.style.width = startLeft;
    fillEl.style.left = startLeft;
    fillEl.style.width = '0%';
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        fillEl.style.width = `${Math.max(0, Math.round((pct - prevPct) * 100))}%`;
      });
    });
    // The figure only -- the gold "XP" beside it is a sibling span.
    countUpReward(xpNumEl || xpEl, hasXp ? xpAwarded : 0);
    return true;
  }

  /* The Save button has two possible answers -- "+25 XP" and "not this time" --
   * and they are drawn by two different files. Whichever one speaks last has to
   * silence the other, or a driver reads a refusal stacked on a reward. */
  function hidePickupProgressReward() {
    const el = document.getElementById('pickupProgressReward');
    if (!el) return;
    if (showPickupProgressReward._timer) {
      window.clearTimeout(showPickupProgressReward._timer);
      showPickupProgressReward._timer = null;
    }
    el.classList.remove('show');
    el.setAttribute('aria-hidden', 'true');
  }

  function showPickupProgressReward(payload = {}) {
    const rendered = renderPickupProgressReward(payload);
    if (!rendered) return;
    try { window.PickupRecordingFeature?.hidePickupGuardNotice?.(); } catch (_) {}
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
    const rankName = rankDisplayName(payload);
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
      const code = chatInternals.normalizeLeaderboardBadge?.(row?.badge_code);
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
        badge_code: chatInternals.normalizeLeaderboardBadge?.(parsed.badge_code),
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
      badge_code: chatInternals.normalizeLeaderboardBadge?.(state.badge_code),
      rank_position: Number(state.rank_position),
      metric: String(state.metric || ''),
      period: String(state.period || ''),
      period_key: String(state.period_key || '')
    };
    try {
      localStorage.setItem(leaderboardBadgeRewardStorageKey(Math.floor(Number(userId))), JSON.stringify(payload));
    } catch (_) {}
  }

  function clearStoredLeaderboardBadgeRewardState(userId) {
    if (!Number.isFinite(Number(userId))) return;
    try {
      localStorage.removeItem(leaderboardBadgeRewardStorageKey(Math.floor(Number(userId))));
    } catch (_) {}
  }

  function showLeaderboardBadgeRewardOverlay(badgeRowOrMeta, options = {}) {
    const meta = chatInternals.leaderboardBadgeMeta?.(badgeRowOrMeta?.badge_code || badgeRowOrMeta?.code);
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
    icon.innerHTML = window.renderLeaderboardBadgeSvg?.(meta.code, { size: 88, compact: false });
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
    const prevCode = chatInternals.normalizeLeaderboardBadge?.(prevState?.badge_code);
    const nextCode = chatInternals.normalizeLeaderboardBadge?.(nextState?.badge_code);
    if (!nextCode) return false;
    if (!prevCode) return true;
    const prevPriority = chatInternals.leaderboardBadgePriority?.(prevCode);
    const nextPriority = chatInternals.leaderboardBadgePriority?.(nextCode);
    if (nextPriority > prevPriority) return true;
    if (nextPriority < prevPriority) return false;
    const prevPeriod = String(prevState?.period_key || '');
    const nextPeriod = String(nextState?.period_key || '');
    if (!prevPeriod || !nextPeriod || prevPeriod === nextPeriod) return false;
    return false;
  }

  function applySelfLeaderboardBadgeState(nextState) {
    const internals = window.TlcCommunityInternals || null;
    const currentMe = internals?.getMeState?.() || window.me;
    if (!currentMe || typeof currentMe !== 'object') return;

    const prevBadgeCode = chatInternals.normalizeLeaderboardBadge?.(currentMe?.leaderboard_badge_code) || null;
    const prevHasCrown = currentMe?.leaderboard_has_crown === true;
    const nextBadgeCode = chatInternals.normalizeLeaderboardBadge?.(nextState?.badge_code) || null;
    const nextHasCrown = nextBadgeCode === 'crown';

    const nextMe = {
      ...currentMe,
      leaderboard_badge_code: nextBadgeCode,
      leaderboard_has_crown: nextHasCrown
    };

    internals?.setMeState?.(nextMe);
    window.me = nextMe;

    const changed = prevBadgeCode !== nextBadgeCode || prevHasCrown !== nextHasCrown;
    if (!changed) return;

    internals?.refreshNavNameLabel?.();

    if (driverProfileState.open && driverProfileState.isSelf && driverProfileState.profile?.user) {
      driverProfileState.profile.user = {
        ...driverProfileState.profile.user,
        leaderboard_badge_code: nextBadgeCode,
        leaderboard_has_crown: nextHasCrown
      };
      renderDriverProfileModal();
    }
  }

  async function syncLeaderboardBadgeRewards(options = {}) {
    const token = chatInternals.getCommunityToken?.();
    const userId = Number(window?.me?.id);
    if (!token || !Number.isFinite(userId)) return null;
    try {
      const payload = await getJSONAuth('/leaderboard/badges/me', token);
      const rows = Array.isArray(payload?.badges) ? payload.badges : [];
      const best = getBestCurrentLeaderboardBadgeRow(rows);
      const nextState = best ? {
        badge_code: chatInternals.normalizeLeaderboardBadge?.(best.badge_code),
        rank_position: Number(best.rank_position),
        metric: String(best.metric || ''),
        period: String(best.period || ''),
        period_key: String(best.period_key || '')
      } : null;
      const prevState = readStoredLeaderboardBadgeRewardState(userId);
      if (!prevState) {
        if (nextState) writeStoredLeaderboardBadgeRewardState(userId, nextState);
        applySelfLeaderboardBadgeState(nextState);
        return nextState;
      }
      if (!nextState) {
        clearStoredLeaderboardBadgeRewardState(userId);
        applySelfLeaderboardBadgeState(null);
        return null;
      }
      if (nextState && !options?.suppressInitialPopup && shouldShowLeaderboardBadgeReward(prevState, nextState)) {
        showLeaderboardBadgeRewardOverlay(nextState, options);
      }
      if (nextState) writeStoredLeaderboardBadgeRewardState(userId, nextState);
      applySelfLeaderboardBadgeState(nextState);
      return nextState;
    } catch (err) {
      console.warn('syncLeaderboardBadgeRewards failed', err);
      return null;
    }
  }


  async function fetchMyProgression() {
    const token = chatInternals.getCommunityToken?.();
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
      const firstSeen = prev === null;
      if (firstSeen) {
        writeStoredProgressionLevel(userId, safeLevel);
      }
      if (!firstSeen && (forcePopupCheck || prev !== null) && safeLevel > prev) {
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
    const runner = () => {
      if (document.visibilityState === 'hidden') return;
      syncMyProgression({ forcePopupCheck: true });
    };
    if (runtimePolling) {
      progressionSyncTimer = runtimePolling.setInterval('chat:progression-sync', runner, PROGRESSION_SYNC_INTERVAL_MS);
      return;
    }
    progressionSyncTimer = window.setInterval(runner, PROGRESSION_SYNC_INTERVAL_MS);
  }

  function stopProgressionSyncInterval() {
    if (runtimePolling) runtimePolling.clear('chat:progression-sync');
    if (!progressionSyncTimer) return;
    window.clearInterval(progressionSyncTimer);
    progressionSyncTimer = null;
  }

  function handlePickupProgressionDelta(payload = {}) {
    const progressionPayload = payload?.progression && typeof payload.progression === 'object' ? payload.progression : payload;
    const hasProgressionObject = progressionPayload !== null && typeof progressionPayload === 'object';
    const leveledUp = payload?.leveled_up === true || progressionPayload?.leveled_up === true;
    showPickupProgressReward(payload);
    if (driverProfileState.isSelf && hasProgressionObject) {
      driverProfileState.myProgression = progressionPayload;
      if (driverProfileState.open) renderDriverProfileModal();
    }
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
      // Keep badge syncing inside syncMyProgression() to avoid duplicate
      // /leaderboard/badges/me calls during same-session startup/sign-in.
      await syncMyProgression({ forcePopupCheck: false });
    } else {
      stopProgressionSyncInterval();
    }
  }


  async function sendDriverProfileDm(userId, payload) {
    return await chatInternals.chatSendPrivateMessage?.(userId, payload);
  }

  function parseDriverMsgId(msg) {
    const id = Number(msg?.id);
    return Number.isFinite(id) ? id : null;
  }

  function seedDriverProfileDmAudioBaseline(messages) {
    if (!Array.isArray(messages) || !messages.length) {
      chatInternals.chatSoundRuntime.dmBaselineReady = true;
      return;
    }
    let maxId = chatInternals.chatSoundRuntime.dmLastObservedIncomingId;
    for (const msg of messages) {
      const id = parseDriverMsgId(msg);
      if (id === null) continue;
      maxId = maxId === null ? id : Math.max(maxId, id);
    }
    chatInternals.chatSoundRuntime.dmLastObservedIncomingId = maxId;
    chatInternals.chatSoundRuntime.dmBaselineReady = true;
  }

  function collectFreshIncomingDriverProfileDm(messages) {
    if (!Array.isArray(messages) || !messages.length) return [];
    const fresh = [];
    let maxId = chatInternals.chatSoundRuntime.dmLastObservedIncomingId;
    const baselineReady = chatInternals.chatSoundRuntime.dmBaselineReady === true;
    for (const msg of messages) {
      const id = parseDriverMsgId(msg);
      if (id === null) continue;
      const isFresh = baselineReady && (maxId === null || id > maxId);
      if (isFresh && !chatInternals.isOwnMessage?.(msg) && !isSuppressedOutgoingDmEcho(msg)) fresh.push(msg);
      maxId = maxId === null ? id : Math.max(maxId, id);
    }
    chatInternals.chatSoundRuntime.dmLastObservedIncomingId = maxId;
    chatInternals.chatSoundRuntime.dmBaselineReady = true;
    return fresh;
  }

  function normalizeDriverMessages(payload) {
    return chatInternals.normalizePrivateMessagesPayload?.(payload);
  }

  function appendDriverProfileMessages(messages, { replace = false } = {}) {
    const uid = String(driverProfileState.userId || '');
    if (!uid) return;
    const normalized = normalizeDriverMessages(messages);
    const next = replace ? chatInternals.upsertChatMessages?.([], normalized) : chatInternals.mergePrivateMessages?.(uid, normalized);
    chatInternals.pruneExpiredChatState?.();
    if (replace) {
      chatInternals.privateMessagesByUserId[uid] = next;
      chatInternals.pruneExpiredChatState?.();
      chatInternals.pruneVoiceAssetCache?.();
    }
    driverProfileState.messages = chatInternals.privateMessagesByUserId[uid] || next || [];
    driverProfileState.latestMessageId = (driverProfileState.messages || []).reduce((max, msg) => {
      const id = parseDriverMsgId(msg);
      return id === null ? max : Math.max(max, id);
    }, 0) || null;
    chatInternals.privateUpsertThreadFromMessages?.(uid, driverProfileState.messages, { displayName: driverProfileState.displayName || '' });
  }

  function currentDriverProfileDmScope() {
    return driverProfileState && driverProfileState.userId
      ? `dm:${driverProfileState.userId}`
      : 'dm:unknown';
  }

  function rememberOutgoingDmEcho(textOrMsg) {
    chatInternals.pruneOutgoingEchoMap?.(recentOutgoingDmEchoes);
    const text = typeof textOrMsg === 'string'
      ? textOrMsg
      : (textOrMsg?.text || textOrMsg?.message || '');
    const userId = typeof textOrMsg === 'string'
      ? chatInternals.currentChatSelfUserId?.()
      : (chatInternals.msgUserId?.(textOrMsg) || chatInternals.currentChatSelfUserId?.());
    const fp = chatInternals.makeOutgoingEchoFingerprint?.(text, userId);
    if (!fp) return;
    recentOutgoingDmEchoes.set(`${currentDriverProfileDmScope()}|${fp}`, Date.now() + chatInternals.CHAT_OUTGOING_ECHO_SUPPRESS_MS);
  }

  function isSuppressedOutgoingDmEcho(msg) {
    chatInternals.pruneOutgoingEchoMap?.(recentOutgoingDmEchoes);
    const fp = chatInternals.makeOutgoingEchoFingerprint?.(
      msg?.text || msg?.message || '',
      chatInternals.msgUserId?.(msg) || chatInternals.currentChatSelfUserId?.()
    );
    if (!fp) return false;
    return recentOutgoingDmEchoes.has(`${currentDriverProfileDmScope()}|${fp}`);
  }

  function closeDriverProfileModal() {
    if (chatInternals.getVoiceRecorderState?.('profile-dm')?.isActive) chatInternals.cancelChatVoiceRecording?.('Recording canceled');
    stopDriverProfileDmPolling();
    chatInternals.clearVoiceAssetsForMessages?.(driverProfileState.messages);
    driverProfileState.open = false;
    driverProfileState.userId = null;
    chatInternals.pruneVoiceAssetCache?.();
    driverProfileState.isSelf = false;
    driverProfileState.status = '';
    chatInternals.chatSoundRuntime.dmLastObservedIncomingId = null;
    chatInternals.chatSoundRuntime.dmBaselineReady = false;
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
      const signedIn = typeof window.authHeaderOK === 'function' ? window.authHeaderOK() : !!chatInternals.getCommunityToken?.();
      if (!signedIn) return;
      const oldPwd = prompt('Enter your current password:');
      if (oldPwd === null) return;
      const newPwd = prompt('Enter your new password:');
      if (newPwd === null) return;
      try {
        await postJSON('/me/change_password', { old_password: oldPwd, new_password: newPwd }, chatInternals.getCommunityToken?.());
        alert('Password changed successfully.');
      } catch (err) {
        alert(err?.detail || 'Error changing password.');
      }
    });

    document.getElementById('driverProfileDeleteAccountBtn')?.addEventListener('click', async (e) => {
      e.preventDefault();
      const signedIn = typeof window.authHeaderOK === 'function' ? window.authHeaderOK() : !!chatInternals.getCommunityToken?.();
      if (!signedIn) return;
      if (!confirm('Are you sure you want to delete your account? This cannot be undone.')) return;
      try {
        await postJSON('/me/delete_account', {}, chatInternals.getCommunityToken?.());
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
    try { if (typeof window.renderSubscriptionSettings === 'function') window.renderSubscriptionSettings(); } catch (_) {}
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

    const previousDmList = document.getElementById('driverProfileDmList');
    const previousDmScrollTop = previousDmList ? previousDmList.scrollTop : 0;
    const previousDmNearBottom = chatInternals.isChatNearBottom?.(previousDmList, 80);
    const messages = normalizeDriverMessages(driverProfileState.messages);
    const dmHtml = messages.length
      ? messages.map((msg) => chatInternals.renderPrivateConversationRow?.(msg, 'profile-dm')).join('')
      : '<div class="driverProfileStatus">No private messages yet.</div>';

    const profileGameActionsHtml = renderProfileGameActionButtons(profilePayload, selfMode);
    const accountActionsHtml = `
      <div class="driverProfileSectionTitle">Account actions</div>
      <div class="driverProfileActions">
        <button class="driverProfileActionBtn" id="driverProfileChangePwdBtn" type="button">Change Password</button>
        <button class="driverProfileActionBtn danger" id="driverProfileDeleteAccountBtn" type="button">Delete Account</button>
        <button class="driverProfileActionBtn" id="driverProfileSignOutBtn" type="button">Sign Out</button>
      </div>
      <div class="panelBlock subscriptionSettingsBlock" hidden aria-hidden="true">
        <div class="subscriptionSettingsHeader">Subscription</div>
        <div class="subscriptionSettingsBody">
          <div class="subscriptionStatusRow">
            <span class="subscriptionStatusLabel">Status</span>
            <span class="subscriptionStatusValue subscriptionStatusTopValue">—</span>
          </div>
          <div class="subscriptionStatusRow subscriptionPeriodRow" hidden>
            <span class="subscriptionStatusLabel subscriptionPeriodLabel">Next renewal</span>
            <span class="subscriptionStatusValue subscriptionPeriodValue">—</span>
          </div>
          <div class="subscriptionStatusRow subscriptionTrialRow" hidden>
            <span class="subscriptionStatusLabel">Trial ends</span>
            <span class="subscriptionStatusValue subscriptionTrialValue">—</span>
          </div>
          <div class="subscriptionActions">
            <button type="button" class="modeBtn subscriptionActionBtn" hidden>
              Subscribe
            </button>
          </div>
          <div class="subscriptionFooterNote" hidden></div>
        </div>
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
        <div class="driverProfileHeaderActions">
          ${profileGameActionsHtml}
          <button class="driverProfileClose" id="driverProfileCloseBtn" type="button">Close</button>
        </div>
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
        <div class="driverProfileSectionTitle">Battle record</div>
        ${renderBattleStatsSection(profilePayload?.battle_record || profilePayload?.battle_stats)}
        <div class="driverProfileSectionTitle">Recent battles</div>
        ${renderRecentBattlesList(profilePayload?.recent_battles || profilePayload?.battle_history)}
        ${renderProfileRelationshipStatus(profilePayload, selfMode)}
        ${selfMode ? accountActionsHtml : `
          <div class="driverProfileSectionTitle">Private messages</div>
          <div class="driverProfileDmWrap">
            <div class="driverProfileDmList" id="driverProfileDmList">${dmHtml}</div>
            <div class="driverProfileComposer">
              <input class="driverProfileInput" id="driverProfileInput" type="text" placeholder="Type a private message">
              <button class="driverProfileSendBtn" id="driverProfileSendBtn" type="button" ${driverProfileState.sending ? 'disabled' : ''}>Send</button>
            </div>
            ${chatInternals.buildVoiceComposer?.('driverProfile', 'driverProfileVoiceComposer')}
          </div>
        `}
      </div>
      ${driverProfileState.error ? `<div class="driverProfileError">${escapeHtml(driverProfileState.error)}</div>` : ''}
      ${driverProfileState.status ? `<div class="driverProfileStatus">${escapeHtml(driverProfileState.status)}</div>` : ''}
    `;

    document.getElementById('driverProfileCloseBtn')?.addEventListener('click', closeDriverProfileModal);
    document.getElementById('driverProfileOpenInboxBtn')?.addEventListener('click', () => {
      openPrivateChatWithUser(driverProfileState.userId, name);
      closeDriverProfileModal();
    });
    document.getElementById('driverProfileChallengeBtn')?.addEventListener('click', () => {
      const rel = resolveViewerRelationship(profilePayload);
      const gamesModule = window.TlcGamesModule || null;
      if (rel.kind === 'active') {
        gamesModule?.loadActiveBattleMatch?.({ preferredMatchId: rel.matchId || undefined });
      } else if (rel.kind === 'incoming' || rel.kind === 'outgoing') {
        gamesModule?.loadGamesBattleDashboard?.({ silent: false });
      } else {
        gamesModule?.openGamesBattleComposer?.({
          targetUserId: driverProfileState.userId,
          displayName: name,
          gameType: rel.gameType || 'dominoes'
        });
      }
      closeDriverProfileModal();
    });

    if (selfMode) {
      bindSelfProfileActions();
      updateDriverProfileLayout();
      return;
    }

    const input = document.getElementById('driverProfileInput');
    const sendBtn = document.getElementById('driverProfileSendBtn');
    const submit = async () => {
      if (driverProfileState.sending || !driverProfileState.userId || driverProfileState.isSelf) return;
      if (chatInternals.getVoiceRecorderState?.('profile-dm')?.isActive && chatInternals.isChatVoiceBusy?.()) return;
      if (chatInternals.hasChatVoiceDraft?.('profile-dm')) {
        driverProfileState.sending = true;
        driverProfileState.error = '';
        if (sendBtn) sendBtn.disabled = true;
        try {
          await chatInternals.sendChatVoiceDraft?.('profile-dm', {
            userId: driverProfileState.userId,
            onUploaded: async (sent) => {
              const previousLatestId = driverProfileState.latestMessageId || null;
              const merged = await chatInternals.integrateUploadedVoiceMessage?.('private', sent, { previousLatestId, otherUserId: driverProfileState.userId, markRead: true, displayName: driverProfileState.displayName });
              if (merged.length) {
                seedDriverProfileDmAudioBaseline(merged);
                driverProfileState.messages = merged;
                driverProfileState.latestMessageId = merged.reduce((max, msg) => Math.max(max, Number(msg?.id || 0)), 0) || null;
              } else {
                const refreshed = await fetchDriverProfileDmThread(driverProfileState.userId, { limit: 30, markRead: true });
                appendDriverProfileMessages(refreshed, { replace: true });
                seedDriverProfileDmAudioBaseline(driverProfileState.messages);
              }
              chatInternals.privateUnreadByUserId[String(driverProfileState.userId)] = 0;
              chatInternals.renderPrivateTabUnread?.();
              chatInternals.updateChatUnreadBadge?.();
              await chatInternals.playChatTone?.('outgoing');
              chatInternals.updateDriverProfileDmList?.(driverProfileState.messages);
            },
          });
        } catch (err) {
          driverProfileState.error = err?.message || 'Voice note failed to send.';
          const errorEl = body.querySelector('.driverProfileError');
          if (errorEl) errorEl.textContent = driverProfileState.error;
        } finally {
          driverProfileState.sending = false;
          chatInternals.syncVoiceComposerSendButton?.('profile-dm');
        }
        return;
      }
      const textValue = String(input?.value || '').trim();
      if (!textValue) return;
      driverProfileState.sending = true;
      driverProfileState.error = '';
      if (sendBtn) sendBtn.disabled = true;
      try {
        const sent = await sendDriverProfileDm(driverProfileState.userId, { text: textValue });
        rememberOutgoingDmEcho(textValue);
        input.value = '';
        const sentMessages = normalizeDriverMessages(sent);
        chatInternals.markChatForceToLatest?.('profile-dm');
        if (sentMessages.length) {
          sentMessages.forEach(rememberOutgoingDmEcho);
          seedDriverProfileDmAudioBaseline(sentMessages);
          appendDriverProfileMessages(sentMessages);
        } else {
          chatInternals.markChatForceToLatest?.('profile-dm');
          const refreshed = await fetchDriverProfileDmThread(driverProfileState.userId, { limit: 30, markRead: true });
          appendDriverProfileMessages(refreshed, { replace: true });
          seedDriverProfileDmAudioBaseline(driverProfileState.messages);
        }
        chatInternals.privateUnreadByUserId[String(driverProfileState.userId)] = 0;
        chatInternals.renderPrivateTabUnread?.();
        chatInternals.updateChatUnreadBadge?.();
        chatInternals.updateDriverProfileDmList?.(driverProfileState.messages, { forceStickToBottom: true });
      } catch (err) {
        driverProfileState.error = err?.message || 'Message failed to send.';
        const errorEl = body.querySelector('.driverProfileError');
        if (errorEl) errorEl.textContent = driverProfileState.error;
      } finally {
        driverProfileState.sending = false;
        chatInternals.syncVoiceComposerSendButton?.('profile-dm');
      }
    };
    sendBtn?.addEventListener('click', (ev) => { ev.preventDefault(); submit(); });
    input?.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        submit();
      }
    });
    chatInternals.bindVoiceComposerControls?.('driverProfile', () => ({
      userId: driverProfileState.userId,
      onUploaded: async (sent) => {
        const previousLatestId = driverProfileState.latestMessageId || null;
        const merged = await chatInternals.integrateUploadedVoiceMessage?.('private', sent, { previousLatestId, otherUserId: driverProfileState.userId, markRead: true, displayName: driverProfileState.displayName });
        if (merged.length) {
          seedDriverProfileDmAudioBaseline(merged);
          driverProfileState.messages = merged;
          driverProfileState.latestMessageId = merged.reduce((max, msg) => Math.max(max, Number(msg?.id || 0)), 0) || null;
        } else {
          const refreshed = await fetchDriverProfileDmThread(driverProfileState.userId, { limit: 30, markRead: true });
          appendDriverProfileMessages(refreshed, { replace: true });
          seedDriverProfileDmAudioBaseline(driverProfileState.messages);
        }
        chatInternals.privateUnreadByUserId[String(driverProfileState.userId)] = 0;
        chatInternals.renderPrivateTabUnread?.();
        chatInternals.updateChatUnreadBadge?.();
        await chatInternals.playChatTone?.('outgoing');
        chatInternals.updateDriverProfileDmList?.(driverProfileState.messages);
      },
    }));
    chatInternals.bindVoicePlayers?.(document.getElementById('driverProfileDmList') || document);
    void chatInternals.prefetchVoiceBlobUrls?.(messages.filter((msg) => msg?.messageType === 'voice'));

    const dmList = document.getElementById('driverProfileDmList');
    if (dmList) {
      if (previousDmNearBottom || !previousDmList) dmList.scrollTop = dmList.scrollHeight;
      else dmList.scrollTop = previousDmScrollTop;
    }
    updateDriverProfileLayout();
  }

  async function openDriverProfileModal({ userId, isSelf = false, source = '' } = {}) {
    if (chatInternals.getVoiceRecorderState?.('profile-dm')?.isActive) chatInternals.cancelChatVoiceRecording?.('Recording canceled');
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
    driverProfileState.displayName = '';
    driverProfileState.profile = null;
    driverProfileState.myProgression = null;
    chatInternals.clearVoiceAssetsForMessages?.(driverProfileState.messages);
    driverProfileState.messages = [];
    chatInternals.pruneVoiceAssetCache?.();
    driverProfileState.latestMessageId = null;
    chatInternals.chatSoundRuntime.dmLastObservedIncomingId = null;
    chatInternals.chatSoundRuntime.dmBaselineReady = false;
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
      driverProfileState.displayName = String(driverProfileState.profile?.user?.display_name || chatInternals.privateThreads.find((thread) => thread.otherUserId === String(nextUserId))?.displayName || 'Driver').trim() || 'Driver';
      chatInternals.syncPrivateThreadMeta?.(nextUserId, driverProfileState.displayName);
      if (selfMode) {
        const latestProgression = await syncMyProgression({ forcePopupCheck: false });
        if (latestProgression && driverProfileState.open && driverProfileState.userId === nextUserId) {
          driverProfileState.myProgression = latestProgression;
        }
      }
      if (!selfMode) {
        const dmRes = await fetchDriverProfileDmThread(nextUserId, { limit: 30, markRead: true });
        if (!driverProfileState.open || driverProfileState.userId !== nextUserId) return;
        appendDriverProfileMessages(dmRes, { replace: true });
        seedDriverProfileDmAudioBaseline(driverProfileState.messages);
        driverProfileState.dmInitialLoadComplete = true;
        chatInternals.privateUnreadByUserId[String(nextUserId)] = 0;
        chatInternals.renderPrivateTabUnread?.();
        chatInternals.updateChatUnreadBadge?.();
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
      const incoming = await fetchDriverProfileDmThread(driverProfileState.userId, {
        after: driverProfileState.latestMessageId,
        limit: 30,
        markRead: true
      });
      if (!incoming.length) return;
      const freshIncoming = collectFreshIncomingDriverProfileDm(incoming);
      const hasIncomingFromOther = driverProfileState.dmInitialLoadComplete
        && freshIncoming.length > 0
        && (chatInternals.shouldPlayIncomingToneForMessages?.(freshIncoming) ?? true);
      appendDriverProfileMessages(incoming);
      chatInternals.privateUnreadByUserId[String(driverProfileState.userId)] = 0;
      chatInternals.renderPrivateTabUnread?.();
      chatInternals.updateChatUnreadBadge?.();
      if (hasIncomingFromOther) void chatInternals.playChatTone?.('incoming');
      chatInternals.updateDriverProfileDmList?.(driverProfileState.messages);
    } catch (_) {}
  }

  function scheduleDriverProfileDmPoll({ immediate = false } = {}) {
    if (driverProfileState.isSelf || !driverProfileState.open || !driverProfileState.userId) return;
    if (driverProfileState.pollTimer) window.clearTimeout(driverProfileState.pollTimer);
    const delay = immediate ? 0 : chatInternals.getDriverProfilePollIntervalMs?.();
    driverProfileState.pollTimer = window.setTimeout(async () => {
      driverProfileState.pollTimer = null;
      if (driverProfilePollInFlight) return;
      driverProfilePollInFlight = true;
      try {
        await pollDriverProfileDmOnce();
      } finally {
        driverProfilePollInFlight = false;
        if (driverProfileState.open && driverProfileState.userId && !driverProfileState.isSelf) scheduleDriverProfileDmPoll();
      }
    }, delay);
  }

  function startDriverProfileDmPolling() {
    if (driverProfileState.isSelf) return;
    stopDriverProfileDmPolling();
    scheduleDriverProfileDmPoll({ immediate: true });
  }

  function stopDriverProfileDmPolling() {
    if (!driverProfileState.pollTimer) return;
    window.clearTimeout(driverProfileState.pollTimer);
    driverProfileState.pollTimer = null;
  }

  function openPrivateChatWithUser(userId, displayName = '') {
    if (!userId) return;
    if (typeof chatInternals.openPanel === 'function') {
      chatInternals.openPanel?.('chat', 'Chat', chatInternals.chatPanelHTML?.(), chatInternals.wireChatPanel);
    }
    chatInternals.activeChatTab = 'private';
    if (displayName) chatInternals.privateActiveDisplayName = String(displayName);
    setTimeout(() => {
      chatInternals.switchChatTab?.('private');
      chatInternals.openPrivateConversation?.(String(userId), displayName);
    }, 0);
  }


  window.TlcDriverProfileModule = {
    ensureDriverProfileUI,
    fetchDriverProfile,
    fetchDriverProfileDmThread,
    sendDriverProfileDm,
    openDriverProfileModal,
    closeDriverProfileModal,
    renderDriverProfileModal,
    startDriverProfileDmPolling,
    stopDriverProfileDmPolling,
    openPrivateChatWithUser,
    updateDriverProfileLayout,
    showLevelUpOverlay,
    syncMyProgression,
    handlePickupProgressionDelta,
    syncLeaderboardBadgeRewards,
    formatProgressNumber,
    renderRankBadgeIcon,
    rankFromBand,
    rankFromKey,
    rankDisplayName,
    ensurePickupProgressReward,
    renderPickupProgressReward,
    hidePickupProgressReward,
    ensureLevelUpOverlay,
    updatePickupRewardLayout,
    scheduleDriverProfileDmPoll,
    maybeSyncProgressionOnSignInState,
    getState: () => driverProfileState,
  };
  /* The ladder as a standalone namespace.
   *
   * The leaderboard, the games panel and work-battles all need to turn a band
   * into a name, and none of them has any business reaching into the driver
   * profile module to do it. One arithmetic, one place, four callers. */
  /* One request for the whole set, started as soon as this module is up.
     Nothing waits on it: every badge renders with its prestige's painted file
     and is upgraded in place when the manifest lands. */
  loadRankBadgeManifest();

  window.TeamJoseoRank = {
    fromBand: rankFromBand,
    fromKey: rankFromKey,
    displayName: rankDisplayName,
    badgeSrc: rankBadgeSrc,
    reloadBadges: () => { rankBadgeManifestState = 'idle'; loadRankBadgeManifest(); },
    roman: (level) => RANK_ROMAN[
      Math.max(1, Math.min(RANKS_PER_PRESTIGE, Math.floor(Number(level) || 1))) - 1],
    ranksPerPrestige: () => RANKS_PER_PRESTIGE,
    bandCount: () => RANK_BAND_COUNT,
    prestiges: () => RANK_TIERS.map((t, i) => ({
      prestige: i + 1,
      name: t.name,
      beast: t.beast,
      accent: t.accent,
      startBand: i * RANKS_PER_PRESTIGE + 1,
      endBand: (i + 1) * RANKS_PER_PRESTIGE,
    })),
  };
  window.openDriverProfileModal = openDriverProfileModal;
  window.closeDriverProfileModal = closeDriverProfileModal;
  window.renderDriverProfileModal = renderDriverProfileModal;
  window.showLevelUpOverlay = showLevelUpOverlay;
  window.syncMyProgression = syncMyProgression;
  window.handlePickupProgressionDelta = handlePickupProgressionDelta;
  window.syncLeaderboardBadgeRewards = syncLeaderboardBadgeRewards;
  window.ensurePickupProgressReward = ensurePickupProgressReward;
  window.hidePickupProgressReward = hidePickupProgressReward;

  ensureDriverProfileUI();
  ensureLevelUpOverlay();
  window.ensurePickupProgressReward?.();
  window.addEventListener('resize', updatePickupRewardLayout);
  window.addEventListener('orientationchange', updatePickupRewardLayout);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', updatePickupRewardLayout);
  // Progression lifecycle boot is owned by the auth-state flow in app.part10.js.
  // Keep maybeSyncProgressionOnSignInState exported for auth lifecycle callers.
})();
