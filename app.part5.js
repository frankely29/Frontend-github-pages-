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
      .driverProfileProgressLine{font-size:12px;font-weight:700;color:#0f172a;display:flex;align-items:center;gap:5px;min-width:0;flex-wrap:wrap}
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
      .pickupProgressReward{position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom, 0px) + var(--pickup-reward-bottom, 240px));width:min(320px,calc(100vw - 22px));transform:translate(-50%,26px) scale(.9);opacity:0;z-index:9802;pointer-events:none;display:block;color:#e2e8f0;transition:opacity .42s ease,transform .42s cubic-bezier(.16,.82,.24,1.18);text-shadow:0 4px 20px rgba(2,6,23,.62),0 1px 1px rgba(2,6,23,.45)}
      .pickupProgressRewardCard{position:relative;overflow:hidden;border-radius:22px;padding:14px 14px 13px;background:linear-gradient(160deg,rgba(2,6,23,.94) 0%,rgba(15,23,42,.92) 50%,rgba(30,64,175,.44) 100%);border:1px solid rgba(125,211,252,.34);box-shadow:0 20px 46px rgba(2,6,23,.56),0 0 34px rgba(56,189,248,.28),inset 0 1px 0 rgba(255,255,255,.1);display:flex;flex-direction:column;align-items:center;gap:7px}
      .pickupProgressRewardCard::before{content:'';position:absolute;inset:-24% -12% auto -12%;height:86%;background:radial-gradient(circle at top,rgba(125,211,252,.28) 0%,rgba(56,189,248,0) 65%);opacity:.7;pointer-events:none}
      .pickupProgressReward.show{opacity:1;transform:translate(-50%,0) scale(1)}
      .pickupProgressRewardKicker,.pickupProgressRewardXp,.pickupProgressRewardLevel,.pickupProgressRewardRank,.pickupProgressRewardFoot{opacity:0;transform:translateY(7px);transition:opacity .24s ease,transform .24s ease}
      .pickupProgressReward.show .pickupProgressRewardKicker{opacity:1;transform:translateY(0);transition-delay:.05s}
      .pickupProgressReward.show .pickupProgressRewardXp{opacity:1;transform:translateY(0);transition-delay:.11s}
      .pickupProgressReward.show .pickupProgressRewardLevel,.pickupProgressReward.show .pickupProgressRewardRank{opacity:1;transform:translateY(0);transition-delay:.18s}
      .pickupProgressReward.show .pickupProgressRewardFoot{opacity:1;transform:translateY(0);transition-delay:.25s}
      .pickupProgressRewardKicker{font-size:12px;font-weight:900;letter-spacing:1px;text-transform:uppercase;color:#dbeafe}
      .pickupProgressRewardXp{font-size:16px;font-weight:900;line-height:1;color:#67e8f9}
      .pickupProgressRewardIcon{position:relative;display:grid;place-items:center;opacity:0;transform:scale(.74)}
      .pickupProgressReward.show .pickupProgressRewardIcon{opacity:1;animation:pickupProgressRewardIconPop .62s cubic-bezier(.2,.8,.2,1) .1s both}
      .pickupProgressRewardIcon::before{content:'';position:absolute;inset:-13px;border-radius:999px;background:radial-gradient(circle,rgba(110,231,255,.5) 0%,rgba(56,189,248,.24) 46%,rgba(56,189,248,0) 72%);filter:blur(1px);opacity:0;transform:scale(.58)}
      .pickupProgressReward.show .pickupProgressRewardIcon::before{animation:pickupProgressRewardGlow .76s ease-out .14s both}
      .pickupProgressReward .rankBadgeIconWrap{width:70px;height:70px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.44),0 0 0 1px rgba(15,23,42,.2),0 14px 30px rgba(2,6,23,.52),0 0 26px rgba(56,189,248,.35)}
      .pickupProgressReward .rankBadgeIconWrap svg{width:40px;height:40px}
      .pickupProgressRewardLevel{font-size:22px;font-weight:900;line-height:1.08;color:#fff}
      .pickupProgressRewardRank{margin-top:-1px;font-size:16px;font-weight:800;line-height:1.18;color:#bfdbfe;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .pickupProgressRewardBar{width:min(248px,100%);height:9px;border-radius:999px;background:rgba(148,163,184,.3);box-shadow:0 0 0 1px rgba(148,163,184,.25),0 0 16px rgba(59,130,246,.3);overflow:hidden}
      .pickupProgressRewardFill{height:100%;width:0;background:linear-gradient(90deg,#22d3ee 0%,#3b82f6 56%,#22c55e 100%);border-radius:999px;transition:width .62s cubic-bezier(.2,.84,.2,1);transition-delay:.2s}
      .pickupProgressRewardFoot{font-size:12px;line-height:1.22;font-weight:800;color:#dbeafe;text-align:center}
      @keyframes pickupProgressRewardIconPop{0%{transform:scale(.68)}40%{transform:scale(1.18)}100%{transform:scale(1)}}
      @keyframes pickupProgressRewardGlow{0%{opacity:0;transform:scale(.5)}34%{opacity:1;transform:scale(1.04)}100%{opacity:0;transform:scale(1.3)}}
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
    const mapControlStack = document.querySelector('.mapControlStack');
    void mapControlStack;

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
    const rawAvatarUrl = String(profileUser?.avatar_url || '').trim();
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
    const match = key.match(/^band_(\d{1,4})$/);
    if (match) {
      const value = Number(match[1]);
      return Math.max(1, Math.min(1000, value));
    }
    return Math.max(1, Math.min(1000, Number(LEGACY_RANK_ICON_BAND_MAP[key] || 1)));
  }

  function resolveRankIconTone(rankIconKey) {
    const band = resolveRankIconBand(rankIconKey);
    if (band >= 91) return 'toneLegend';
    if (band >= 71) return 'toneGeneral';
    if (band >= 41) return 'toneOfficer';
    if (band >= 11) return 'toneEnlisted';
    return 'toneRecruit';
  }

  function buildRankBadgeShell(shellIndex) {
    const shells = [
      '<path d="M24 4L42 12v12c0 12-8.4 18.8-18 22C14.4 42.8 6 36 6 24V12z" />',
      '<path d="M24 4l16 10v12L24 44 8 26V14z" />',
      '<path d="M24 3l17 8 4 17-11 14H14L3 28l4-17z" />',
      '<circle cx="24" cy="24" r="18" />',
      '<path d="M24 4l18 16-18 24L6 20z" />',
      '<path d="M12 8h24l10 12-10 20H12L2 20z" />',
      '<path d="M24 5c11 0 18 7 18 16 0 12-9 20-18 23C15 41 6 33 6 21 6 12 13 5 24 5z" />',
      '<path d="M24 3l19 14-7 25H12L5 17z" />',
      '<path d="M10 10h28l6 14-6 14H10L4 24z" />',
      '<rect x="7" y="7" width="34" height="34" rx="11" ry="11" />',
    ];
    return shells[((shellIndex % shells.length) + shells.length) % shells.length];
  }

  function buildRankBadgeGlyph(glyphIndex) {
    const glyphs = [
      '<path d="M24 13l3.8 7.8 8.6 1.2-6.2 6 1.5 8.8L24 32.5l-7.7 4.3 1.5-8.8-6.2-6 8.6-1.2z" />',
      '<path d="M17 14h14v5H17zM14 23h20v5H14zM11 32h26v4H11z" />',
      '<path d="M24 10l10 14-10 14-10-14z" />',
      '<circle cx="24" cy="24" r="6" /><path d="M24 11v6M24 31v6M11 24h6M31 24h6" stroke="currentColor" stroke-width="3" stroke-linecap="round" fill="none"/>',
      '<path d="M16 33V17l8-5 8 5v16l-8 5z" />',
      '<path d="M14 33l10-18 10 18h-6l-4-7-4 7z" />',
      '<path d="M14 18h20v4H14zM17 24h14v4H17zM20 30h8v4h-8z" />',
      '<path d="M24 11l11 7v12l-11 7-11-7V18z" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="24" cy="24" r="4" />',
      '<path d="M18 12h12l4 9-10 15L14 21z" />',
      '<path d="M24 12c5.5 0 10 4.5 10 10s-4.5 14-10 14-10-8.5-10-14 4.5-10 10-10z" /><path d="M18 24h12" stroke="currentColor" stroke-width="3" stroke-linecap="round" fill="none"/>',
    ];
    return glyphs[((glyphIndex % glyphs.length) + glyphs.length) % glyphs.length];
  }

  function renderRankBadgeIcon(rankIconKey, { compact = false } = {}) {
    const band = resolveRankIconBand(rankIconKey);
    const toneClass = resolveRankIconTone(rankIconKey);
    const shellIndex = Math.floor((band - 1) / 10);
    const glyphIndex = (band - 1) % 10;
    const size = compact ? 54 : 68;
    const hue = ((band - 1) * 17) % 360;
    const accentHue = (hue + 42) % 360;
    const shell = buildRankBadgeShell(shellIndex);
    const glyph = buildRankBadgeGlyph(glyphIndex);
    const gradientId = `rbg-${band}-${compact ? 'c' : 'f'}`;
    return `<div class="rankBadgeIconWrap ${toneClass}${compact ? ' compact' : ''}" aria-hidden="true" data-rank-band="${band}">
      <svg viewBox="0 0 48 48" width="${size}" height="${size}" role="presentation" focusable="false">
        <defs>
          <linearGradient id="${gradientId}" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="hsl(${hue} 88% 68%)"/>
            <stop offset="55%" stop-color="hsl(${accentHue} 85% 58%)"/>
            <stop offset="100%" stop-color="hsl(${(accentHue + 35) % 360} 72% 32%)"/>
          </linearGradient>
        </defs>
        <circle cx="24" cy="24" r="22" fill="rgba(255,255,255,.22)"/>
        <g fill="url(#${gradientId})" stroke="rgba(15,23,42,.26)" stroke-width="1.3">${shell}</g>
        <g fill="rgba(255,255,255,.92)" stroke="rgba(15,23,42,.18)" stroke-width="0.8">${glyph}</g>
        <circle cx="24" cy="24" r="20.6" fill="none" stroke="rgba(255,255,255,.28)" stroke-width="1"/>
      </svg>
    </div>`;
  }

  function renderDriverProgressionSection(progression) {
    const level = Number(progression?.level);
    const safeLevel = Number.isFinite(level) && level > 0 ? Math.floor(level) : 1;
    const title = normalizeDriverTier(progression?.rank_name || progression?.title);
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
        <div class="driverProfileProgressLine">Level ${safeLevel} • <span class="driverProfileRankName">${escapeHtml(title)}</span></div>
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
      const result = battleResultLabel(row);
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
      return `<article class="driverProfileRecentBattle ${result.toLowerCase()}"><div class="driverProfileRecentBattleTop"><strong>${escapeHtml(game)}</strong><span>${escapeHtml(result)}</span></div><div class="driverProfileRecentBattleMeta">vs ${escapeHtml(opponent)} • ${escapeHtml(chatInternals.formatBattleDate?.(row?.completed_at))}</div><div class="driverProfileRecentBattleMeta">${xp > 0 ? `+${escapeHtml(formatProgressNumber(xp, { maxFractionDigits: 0 }))} XP` : 'Completed'}</div></article>`;
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
          ? 'Challenge Sent'
          : 'Challenge';
    const disabled = rel.kind === 'outgoing' ? ' disabled' : '';
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
    const pushTop = (sel) => {
      const node = document.querySelector(sel);
      if (!node || typeof node.getBoundingClientRect !== 'function') return;
      const rect = node.getBoundingClientRect();
      if (Number.isFinite(rect?.top)) tops.push(rect.top);
    };
    pushTop('#dock');
    pushTop('#sliderWrap');
    pushTop('#pickupFab');
    document.querySelectorAll('.dockDrawer.open,.dockDrawer[open],#dockDrawer.open,#dockDrawer[open]').forEach((node) => {
      if (!node || typeof node.getBoundingClientRect !== 'function') return;
      const rect = node.getBoundingClientRect();
      if (Number.isFinite(rect?.top)) tops.push(rect.top);
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
    el.innerHTML = `<div class="pickupProgressRewardCard">
      <div class="pickupProgressRewardKicker" id="pickupProgressRewardKicker">Trip Saved</div>
      <div class="pickupProgressRewardIcon" id="pickupProgressRewardIcon"></div>
      <div class="pickupProgressRewardXp" id="pickupProgressRewardXp"></div>
      <div class="pickupProgressRewardLevel" id="pickupProgressRewardLevel"></div>
      <div class="pickupProgressRewardRank" id="pickupProgressRewardRank"></div>
      <div class="pickupProgressRewardBar"><div class="pickupProgressRewardFill" id="pickupProgressRewardFill"></div></div>
      <div class="pickupProgressRewardFoot" id="pickupProgressRewardFoot"></div>
    </div>`;
    document.body.appendChild(el);
    updatePickupRewardLayout();
    return el;
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
    const safeLevel = Number.isFinite(level) && level > 0 ? Math.floor(level) : 1;
    const xpAwarded = Number(payload?.xp_awarded ?? progression?.xp_awarded);
    const earnedLabel = `+${formatProgressNumber(Number.isFinite(xpAwarded) && xpAwarded > 0 ? xpAwarded : 0, { maxFractionDigits: 0 })} XP`;
    const rankName = normalizeDriverTier(progression?.rank_name || progression?.title || 'Rookie');
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
    const levelEl = document.getElementById('pickupProgressRewardLevel');
    const rankEl = document.getElementById('pickupProgressRewardRank');
    const fillEl = document.getElementById('pickupProgressRewardFill');
    const footEl = document.getElementById('pickupProgressRewardFoot');
    if (!kickerEl || !iconEl || !xpEl || !levelEl || !rankEl || !fillEl || !footEl) return false;
    kickerEl.textContent = 'Trip Saved';
    iconEl.innerHTML = renderRankBadgeIcon(progression?.rank_icon_key, { compact: false });
    xpEl.textContent = earnedLabel;
    levelEl.textContent = `Level ${safeLevel}`;
    rankEl.textContent = String(rankName || 'Rookie');
    fillEl.style.width = '0%';
    footEl.textContent = footer;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        fillEl.style.width = `${Math.round(pct * 100)}%`;
      });
    });
    return true;
  }

  function showPickupProgressReward(payload = {}) {
    const rendered = renderPickupProgressReward(payload);
    if (!rendered) return;
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
    const rankName = normalizeDriverTier(payload?.rank_name || payload?.title || 'New Rank Reached');
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
        return nextState;
      }
      if (!nextState) {
        clearStoredLeaderboardBadgeRewardState(userId);
        return null;
      }
      if (nextState && !options?.suppressInitialPopup && shouldShowLeaderboardBadgeReward(prevState, nextState)) {
        showLeaderboardBadgeRewardOverlay(nextState, options);
      }
      if (nextState) writeStoredLeaderboardBadgeRewardState(userId, nextState);
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
      if (prev === null) {
        writeStoredProgressionLevel(userId, safeLevel);
        return progression;
      }
      if ((forcePopupCheck || prev !== null) && safeLevel > prev) {
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
      window.openGamesBattleComposer?.({
        targetUserId: driverProfileState.userId,
        displayName: name,
        gameType: rel.gameType || 'dominoes'
      });
      if (rel.kind === 'active') {
        window.loadActiveBattleMatch?.({ preferredMatchId: rel.matchId || undefined });
      } else if (rel.kind === 'incoming' || rel.kind === 'outgoing') {
        window.loadGamesBattleDashboard?.({ silent: false });
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
              updateDriverProfileDmList(driverProfileState.messages);
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
        await chatInternals.primeChatSoundSystem?.('dm-send-click');
        const sent = await sendDriverProfileDm(driverProfileState.userId, { text: textValue });
        rememberOutgoingDmEcho(textValue);
        input.value = '';
        const sentMessages = normalizeDriverMessages(sent);
        if (sentMessages.length) {
          sentMessages.forEach(rememberOutgoingDmEcho);
          seedDriverProfileDmAudioBaseline(sentMessages);
          appendDriverProfileMessages(sentMessages);
        } else {
          const refreshed = await fetchDriverProfileDmThread(driverProfileState.userId, { limit: 30, markRead: true });
          appendDriverProfileMessages(refreshed, { replace: true });
          seedDriverProfileDmAudioBaseline(driverProfileState.messages);
        }
        chatInternals.privateUnreadByUserId[String(driverProfileState.userId)] = 0;
        chatInternals.renderPrivateTabUnread?.();
        chatInternals.updateChatUnreadBadge?.();
        await chatInternals.playChatTone?.('outgoing');
        updateDriverProfileDmList(driverProfileState.messages);
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
        updateDriverProfileDmList(driverProfileState.messages);
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
      const hasIncomingFromOther = driverProfileState.dmInitialLoadComplete
        && collectFreshIncomingDriverProfileDm(incoming).length > 0;
      appendDriverProfileMessages(incoming);
      chatInternals.privateUnreadByUserId[String(driverProfileState.userId)] = 0;
      chatInternals.renderPrivateTabUnread?.();
      chatInternals.updateChatUnreadBadge?.();
      if (hasIncomingFromOther) void chatInternals.playChatTone?.('incoming');
      updateDriverProfileDmList(driverProfileState.messages);
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
    ensurePickupProgressReward,
    renderPickupProgressReward,
    ensureLevelUpOverlay,
    updatePickupRewardLayout,
    scheduleDriverProfileDmPoll,
    maybeSyncProgressionOnSignInState,
    getState: () => driverProfileState,
  };
  window.openDriverProfileModal = openDriverProfileModal;
  window.closeDriverProfileModal = closeDriverProfileModal;
  window.renderDriverProfileModal = renderDriverProfileModal;
  window.showLevelUpOverlay = showLevelUpOverlay;
  window.syncMyProgression = syncMyProgression;
  window.handlePickupProgressionDelta = handlePickupProgressionDelta;
  window.syncLeaderboardBadgeRewards = syncLeaderboardBadgeRewards;
  window.ensurePickupProgressReward = ensurePickupProgressReward;

  ensureDriverProfileUI();
  ensureLevelUpOverlay();
  window.ensurePickupProgressReward?.();
  window.addEventListener('resize', updatePickupRewardLayout);
  window.addEventListener('orientationchange', updatePickupRewardLayout);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', updatePickupRewardLayout);
  // Progression lifecycle boot is owned by the auth-state flow in app.part10.js.
  // Keep maybeSyncProgressionOnSignInState exported for auth lifecycle callers.
})();
