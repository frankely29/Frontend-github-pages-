/*
 * app.part3.js
 * Leaderboard panel (Miles/Hours + periods + badges + my rank + overview).
 */
(function () {
  const runtime = window.FrontendRuntime || null;
  const DEFAULT_API_BASE = 'https://web-production-78f67.up.railway.app';
  const LS_TOKEN = 'community_token_v1';
  const PANEL_KEY = 'leaderboard';
  const bindDockToggleFn = window.bindDockToggle || (typeof bindDockToggle === 'function' ? bindDockToggle : null);
  const getOpenPanelKeyFn = window.getOpenPanelKey || (() => (typeof openPanelKey !== 'undefined' ? openPanelKey : null));

  function getOpenDrawerFn() {
    if (typeof window.openDrawer === 'function') return window.openDrawer;
    if (typeof openDrawer === 'function') return openDrawer;
    return null;
  }

  /* Ten prestiges of THREE ranks: thirty bands, and a driver who finishes
   * prestige 1 rank 3 rolls into prestige 2 rank 1. Both numbers come from the
   * badge module when it has loaded, so there is one definition of the ladder's
   * shape rather than two that drift -- these are only the floor for a build
   * where app.part5 has not arrived yet.
   *
   * The old fallback built a HUNDRED rows out of a thousand levels by cycling
   * ten prefixes against ten titles, which produced "Bronze Recruit" at band 1
   * and again, differently coloured, at band 11 -- a list nobody could read and
   * a ladder that repeated itself ten times.
   *
   * The names come from the badge module so there is one roster, not two that
   * drift. A build where app.part5 has not loaded still gets a usable list. */
  const RANK_BAND_SIZE_FALLBACK = 3;
  const RANK_PRESTIGE_COUNT_FALLBACK = 10;

  function ranksPerPrestige() {
    const api = rankApi();
    return (api && api.ranksPerPrestige) ? api.ranksPerPrestige() : RANK_BAND_SIZE_FALLBACK;
  }

  function prestigeCount() {
    const api = rankApi();
    return (api && api.prestiges) ? api.prestiges().length : RANK_PRESTIGE_COUNT_FALLBACK;
  }

  const RANK_PRESTIGE_FALLBACK = [
    'Wyvern', 'Chimera', 'Hydra', 'Kraken', 'Warlord',
    'Colossus', 'Titan', 'Celestial', 'Phoenix', 'Dragon',
  ];

  function rankApi() {
    return window.TeamJoseoRank || null;
  }

  function createRankLadderFallback() {
    const api = rankApi();
    const prestiges = api ? api.prestiges() : RANK_PRESTIGE_FALLBACK.map((name, i) => ({
      prestige: i + 1,
      name,
      beast: '',
      startBand: i * RANK_BAND_SIZE_FALLBACK + 1,
      endBand: (i + 1) * RANK_BAND_SIZE_FALLBACK,
    }));
    return prestiges.map((p) => ({
      start_level: p.startBand,
      end_level: p.endBand,
      rank_name: p.name,
      beast: p.beast,
      prestige: p.prestige,
      rank_icon_key: `band_${String(p.startBand).padStart(3, '0')}`,
    }));
  }

  const state = {
    metric: 'miles',
    period: 'weekly',
    view: 'top',
    rows: [],
    myRow: null,
    badges: [],
    overview: null,
    /* The XP the Ranks screen needs to say how close you are.
     *
     * /leaderboard/me carries the level and the rank but no XP, so the ladder
     * could only ever say which rank you are ON -- never how far through it
     * you are, which is the part that makes a climb feel like a climb.
     * /leaderboard/progression/me has the thresholds, so it is fetched too. */
    myProgression: null,
    rankLadder: [],
    rankLadderLoaded: false,
    status: '',
    statusType: '',
  };

  function leaderboardPerfDebugState() {
    window.__mapPerfDebug = window.__mapPerfDebug || {};
    window.__mapPerfDebug.leaderboard = window.__mapPerfDebug.leaderboard || {
      loaded: false,
      opened: false,
      lastError: '',
      lastOpenAt: 0,
      loadAttempts: 0,
    };
    return window.__mapPerfDebug.leaderboard;
  }

  function markLeaderboardLoaded() {
    const debugState = leaderboardPerfDebugState();
    debugState.loaded = true;
    debugState.lastError = '';
  }

  function markLeaderboardOpenError(error) {
    const debugState = leaderboardPerfDebugState();
    debugState.opened = false;
    debugState.lastError = String(error?.message || error || 'Leaderboard error');
  }

  function markLeaderboardOpened() {
    const debugState = leaderboardPerfDebugState();
    debugState.loaded = true;
    debugState.opened = true;
    debugState.lastError = '';
    debugState.lastOpenAt = Date.now();
  }

  function getToken() {
    try { return localStorage.getItem(LS_TOKEN) || ''; } catch (_) { return ''; }
  }

  function esc(v) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(v);
    return String(v ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  async function fetchJSON(url, opts = {}) {
    if (runtime?.fetchJSON) return runtime.fetchJSON(url, opts);
    const shouldBypassCache = opts.cache === 'no-store' || /\/(auth|me|chat|presence)\b/.test(String(url || ''));
    const res = await fetch(url, { mode: 'cors', ...(shouldBypassCache ? { cache: 'no-store' } : {}), ...opts });
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 402 && typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        try {
          window.dispatchEvent(new CustomEvent('tlc:payment-required', { detail: { status: 402, url } }));
        } catch (_) {}
      }
      throw new Error(text || `${res.status} ${res.statusText}`);
    }
    return text ? JSON.parse(text) : {};
  }

  function apiBase() {
    if (runtime?.resolveApiBase) return runtime.resolveApiBase();
    if (typeof window !== 'undefined' && window.API_BASE !== undefined) {
      const apiBase = String(window.API_BASE || '').trim();
      if (apiBase) return apiBase.replace(/\/+$/, '');
    }
    const runtimeConfigApiBase = String(window.__TLC_RUNTIME_CONFIG__?.apiBase || '').trim();
    if (runtimeConfigApiBase) return runtimeConfigApiBase.replace(/\/+$/, '');
    return DEFAULT_API_BASE;
  }

  async function getAuth(path) {
    if (runtime?.getJSONAuth) return runtime.getJSONAuth(path, getToken());
    if (typeof window.getJSONAuth === 'function') return window.getJSONAuth(path, getToken());
    const headers = {};
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetchJSON(`${apiBase()}${path}`, { headers });
  }

  function strictBadgeCode(badgeCode) {
    const badge = String(badgeCode || '').trim().toLowerCase();
    if (badge === 'crown') return 'crown';
    if (badge === 'silver') return 'silver';
    if (badge === 'bronze') return 'bronze';
    return null;
  }

  function badgeChip(badgeCode, options = {}) {
    const badge = strictBadgeCode(badgeCode);
    if (!badge) return '';
    const label = badge === 'crown' ? 'Crown' : (badge === 'silver' ? 'Silver' : 'Bronze');
    const svg = typeof window.renderLeaderboardBadgeSvg === 'function'
      ? window.renderLeaderboardBadgeSvg(badge, { size: options.withLabel ? 19 : 18, compact: true })
      : `<svg class="leaderboardBadgeSvg is-fallback" viewBox="0 0 24 24" width="18" height="18" role="img" aria-label="${esc(label)}"><circle cx="12" cy="12" r="9" fill="#cbd5e1" stroke="#475569" stroke-width="1.4"/></svg>`;
    return `<span class="badgeChipSvgWrap">${svg}</span>${options.withLabel ? `<span class="badgeText">${label}</span>` : ''}`;
  }

  function formatMetric(value, metric = state.metric) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return metric === 'hours' ? `${n.toFixed(1)} h` : `${n.toFixed(1)} mi`;
  }

  /* A name the backend sent, unless it sent the key back. "band_34" and
   * "Band 034" are the ladder's internal address, not something to put in
   * front of a driver, so both fall through to the derived "Kraken IV". */
  function safeRankName(title, rankIconKey) {
    const raw = String(title || '').trim();
    if (raw && !/^band[\s_-]*\d+$/i.test(raw)) return raw;
    const api = rankApi();
    if (api && rankIconKey) return api.fromKey(rankIconKey).label;
    return raw || 'Wyvern I';
  }

  /* Shown only if app.part5 has not loaded, so there is no painted badge and
     no rank table to read. It used to pattern-match the retired military keys
     -- sergeant, colonel, road_legend -- for a matching emoji; none of those
     keys exist any more, so every one of those branches was dead and the
     function always returned the medal. It says so now. */
  function fallbackRankIcon() {
    return '🏅';
  }

  function renderRankIcon(rankIconKey) {
    if (typeof window.renderRankBadgeIcon === 'function') {
      return window.renderRankBadgeIcon(rankIconKey, { compact: true });
    }
    return `<span class="leaderboardRankIconFallback" aria-hidden="true">${fallbackRankIcon()}</span>`;
  }

  /* In a leaderboard row the badge is 26px, where the numeral struck on its
   * plate is a smudge. So the division is spelled out in the text instead --
   * "Gold IV" beside the badge says the same thing the badge would say at
   * medal size, and says it legibly at this one. */
  function levelTitleLine(level, title, rankIconKey) {
    const n = Number(level);
    const safeLevel = Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
    const safeTitle = safeRankName(title, rankIconKey);
    return `<span class="leaderboardTierLine">${renderRankIcon(rankIconKey)}<span>Level ${safeLevel} <span class="leaderboardRankName">${esc(safeTitle)}</span></span></span>`;
  }

  function selectedMyBadge() {
    const badgeList = Array.isArray(state.badges) ? state.badges : [];
    const exact = badgeList.find((b) => b?.metric === state.metric && b?.period === state.period);
    if (exact) return strictBadgeCode(exact.badge_code);
    return strictBadgeCode(state.myRow?.badge_code);
  }

  function renderOverview() {
    if (!state.overview || typeof state.overview !== 'object') return '';
    const block = (periodLabel, periodKey) => {
      const row = state.overview[periodKey] || {};
      return `<div class="myRankRow"><span>${periodLabel}</span><span>${formatMetric(row[state.metric], state.metric)}</span></div>`;
    };

    return `
      <div class="myRankCard">
        <div style="font:900 11px/1.2 system-ui;">My Summary</div>
        ${block('Today', 'daily')}
        ${block('Week', 'weekly')}
        ${block('Month', 'monthly')}
        ${block('Year', 'yearly')}
      </div>`;
  }

  function renderLevelRange(startLevel, endLevel) {
    const start = Number(startLevel);
    const end = Number(endLevel);
    if (!Number.isFinite(start) && !Number.isFinite(end)) return 'Levels —';
    if (Number.isFinite(start) && Number.isFinite(end) && Math.floor(start) === Math.floor(end)) return `Level ${Math.floor(start)}`;
    if (!Number.isFinite(start)) return `Up to Level ${Math.floor(end)}`;
    if (!Number.isFinite(end)) return `Level ${Math.floor(start)}+`;
    return `Levels ${Math.floor(start)}–${Math.floor(end)}`;
  }

  function pickMyProgressionForLadder() {
    /* The progression endpoint's level wins over the leaderboard row's. They
       should agree, but the row is scoped to a metric and a period and the
       progression is the driver's actual standing in the game. */
    const myLevel = Number(state.myProgression?.level ?? state.myRow?.level);
    const safeLevel = Number.isFinite(myLevel) && myLevel > 0 ? Math.floor(myLevel) : 1;
    const ladder = Array.isArray(state.rankLadder) ? state.rankLadder : [];
    const matched = ladder.find((row) => {
      const start = Number(row?.start_level);
      const end = Number(row?.end_level);
      return Number.isFinite(start) && Number.isFinite(end) && safeLevel >= start && safeLevel <= end;
    }) || null;
    const key = state.myProgression?.rank_icon_key || state.myRow?.rank_icon_key || matched?.rank_icon_key || 'band_001';
    const api = rankApi();
    const rank = api ? api.fromKey(key) : null;
    return {
      level: safeLevel,
      rank,
      rankName: safeRankName(
        state.myProgression?.rank_name || state.myRow?.rank_name || state.myRow?.title || matched?.rank_name,
        key,
      ),
      rankIconKey: key,
    };
  }

  /* A number a driver reads at a glance. 12,480 rather than 12480. */
  function formatXp(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return Math.max(0, Math.floor(n)).toLocaleString('en-US');
  }

  /* How far through the current LEVEL the driver is, from the XP thresholds.
   *
   * Returns null rather than a zero bar when the numbers are not there: an
   * empty meter reads as "you have made no progress", which is a lie when the
   * truth is "we could not load it". At max level it returns a full bar,
   * because that is not missing data, that is the end of the climb. */
  function myLevelXpProgress() {
    const p = state.myProgression;
    if (!p || typeof p !== 'object') return null;
    const total = Number(p.total_xp);
    const floor = Number(p.current_level_xp);
    const ceil = Number(p.next_level_xp);
    if (!Number.isFinite(total)) return null;
    if (p.max_level_reached || !Number.isFinite(ceil)) {
      return { pct: 100, maxed: true, into: 0, span: 0, remaining: 0, total };
    }
    if (!Number.isFinite(floor) || ceil <= floor) return null;
    const into = Math.max(0, total - floor);
    const span = ceil - floor;
    return {
      pct: Math.max(2, Math.min(100, (into / span) * 100)),
      maxed: false,
      into,
      span,
      remaining: Math.max(0, ceil - total),
      total,
    };
  }

  /* The band a ladder row sits on, 1..30.
   *
   * Derived from the prestige/rank pair rather than from the row's position,
   * for the same reason the prestige label is: a position is an address in a
   * list and says nothing true about the ladder. This is what sorts a row into
   * earned, current or locked. */
  function bandOfLadderRow(row, api) {
    const fromKey = (api && row?.rank_icon_key) ? api.fromKey(row.rank_icon_key) : null;
    if (fromKey) return fromKey.band;
    const prestige = Number(row?.prestige);
    const rank = Number(row?.rank);
    if (!Number.isFinite(prestige) || !Number.isFinite(rank)) return 0;
    return ((prestige - 1) * ranksPerPrestige()) + rank;
  }

  function renderRankLadderView() {
    const ladder = Array.isArray(state.rankLadder) ? state.rankLadder : [];
    const mine = pickMyProgressionForLadder();
    const myPrestige = mine.rank ? mine.rank.prestige : 0;

    /* One row per rank -- thirty of them -- because every rank now has its own
     * painted crest and a driver wants to see the whole climb. What they must
     * not see is thirty PRESTIGES: it is ten prestiges of three.
     *
     * The prestige number is never the row's position. It came from
     * `index + 1` as a fallback, the endpoint was returning prestige: null
     * because the response model did not declare the field, and every driver
     * was shown "Warlord II - Prestige 14" when Warlord II is prestige 5.
     *
     * So: the payload first, then the rank key decoded locally, and only a
     * blank if neither can answer. The row's position is not a source of
     * truth about anything and is not used. */
    const api = rankApi();
    const myRank = mine.rank ? mine.rank.level : 0;
    const myBand = mine.rank ? mine.rank.band : 0;

    /* WHAT A ROW HAS TO SAY
     *
     * A flat list of thirty rows that all look alike tells a driver nothing
     * about their own climb. It cannot answer the two questions they actually
     * have -- what have I taken, and what is next -- so every row reads as
     * reference material rather than as a record of anything.
     *
     * So a row is now in one of three states, and they are visibly different:
     * EARNED (behind you, kept in full colour, marked), CURRENT (the one you
     * are standing on), LOCKED (ahead of you, dimmed but never hidden). The
     * locked ones are the point: a driver who can see the Dragon at the top of
     * the list, greyed and waiting, has a reason to climb. Hiding them would
     * make the list tidier and the game emptier.
     */
    const decorated = ladder.map((row) => {
      const fromKey = (api && row?.rank_icon_key) ? api.fromKey(row.rank_icon_key) : null;
      const prestige = Number(row?.prestige) || (fromKey ? fromKey.prestige : 0);
      const rank = Number(row?.rank) || (fromKey ? fromKey.level : 0);
      const band = bandOfLadderRow(row, api);
      /* Both halves of the pair, so exactly one row lights up. Matching on
       * the prestige alone marked all three of its ranks as the driver's own
       * and struck the same numeral chip on each -- three "current" rows in a
       * list whose whole job is to show which single one you are standing on. */
      const isCurrent = prestige === myPrestige && rank === myRank;
      const earned = !isCurrent && !!band && !!myBand && band < myBand;
      const locked = !isCurrent && !earned;
      return { row, prestige, rank, band, isCurrent, earned, locked };
    });

    /* Nothing in a row repeats anything else in it: the title carries the
       rank ("Warlord II" IS rank 2), the heading above carries the prestige,
       the line under the title carries the levels, and the cell on the right
       carries the one thing none of them can -- how it stands relative to the
       driver. An earlier draft said the rank in the title AND in the subtitle
       AND in the pips, which is a row shouting one fact three times. */
    const renderLadderRow = (item) => {
      const { row, isCurrent, earned, locked } = item;
      const beast = String(row?.beast || '').trim();
      const pips = isCurrent && mine.rank
        ? `<div class="leaderboardRankPips" aria-hidden="true">${
            Array.from({ length: ranksPerPrestige() }, (_, i) =>
              `<i class="${i < mine.rank.level ? 'on' : ''}"></i>`).join('')
          }</div>`
        : '';
      /* The right-hand cell carries the state, and it has to carry something
         the rest of the row does not already say. A tick for what is taken;
         the numeral for where you stand; and for what is ahead, the DISTANCE
         -- "+18" levels from where the driver is now.
         The first draft printed the level the rank opens at, which the range
         on the same line already begins with. Distance is the one number
         nothing else on the screen can give, and it is the one that makes a
         far-off rank feel reachable or not. */
      let aside = '';
      if (isCurrent) {
        aside = `<span class="leaderboardRankLadderChip">${esc(mine.rank ? mine.rank.roman : '')}</span>`;
      } else if (earned) {
        aside = '<span class="leaderboardRankEarned" title="Earned">✓</span>';
      } else {
        const opensAt = Number(row?.start_level);
        const away = Number.isFinite(opensAt) ? Math.max(0, Math.floor(opensAt) - mine.level) : null;
        aside = away === null
          ? ''
          : `<span class="leaderboardRankLocked" title="${away} ${away === 1 ? 'level' : 'levels'} away">+${away}</span>`;
      }
      const cls = ['leaderboardRankLadderRow'];
      if (isCurrent) cls.push('current');
      if (earned) cls.push('earned');
      if (locked) cls.push('locked');
      return `<div class="${cls.join(' ')}">
        <div class="leaderboardRankLadderIcon">${renderRankIcon(row?.rank_icon_key)}</div>
        <div class="leaderboardRankLadderText">
          <div class="leaderboardRankLadderTitle">${esc(safeRankName(row?.rank_name || row?.title, row?.rank_icon_key))}${beast ? ` <span class="leaderboardRankBeast">${esc(beast)}</span>` : ''}</div>
          <div class="leaderboardRankLadderRange">${esc(renderLevelRange(row?.start_level, row?.end_level))}</div>
          ${pips}
        </div>
        ${aside}
      </div>`;
    };

    /* TEN GROUPS, NOT THIRTY ROWS
     *
     * Thirty rows in a column is a table. Ten named prestiges of three is the
     * shape of the game, and a driver scrolling it should feel they are moving
     * through creatures rather than through line items. Grouping is also the
     * honest way to show "Prestige 5 of 10" -- once, as a heading over the
     * three ranks it contains, instead of on all three of them. That is why
     * the row above says "Rank 2 of 3" and not the prestige: under a heading
     * that already reads PRESTIGE 5 OF 10, repeating it three times is the
     * noise grouping exists to remove. */
    const groups = [];
    decorated.forEach((item) => {
      const last = groups[groups.length - 1];
      if (last && last.prestige === item.prestige) last.items.push(item);
      else groups.push({ prestige: item.prestige, items: [item] });
    });

    const renderGroup = (group) => {
      const first = group.items[0];
      const name = first ? safeRankName(first.row?.rank_name || first.row?.title, first.row?.rank_icon_key) : '';
      /* The prestige's name without its numeral: the heading is the creature,
         the rows underneath are its three ranks. */
      const creature = String(name).replace(/\s+[IVX]+$/, '');
      const isHere = group.items.some((i) => i.isCurrent);
      const allEarned = group.items.every((i) => i.earned);
      const stateLabel = isHere ? 'You are here' : (allEarned ? 'Complete' : '');
      const cls = ['rankPrestigeGroup'];
      if (isHere) cls.push('here');
      if (allEarned) cls.push('done');
      return `<div class="${cls.join(' ')}">
        <div class="rankPrestigeHead">
          <span class="rankPrestigeName">${esc(creature)}</span>
          ${group.prestige ? `<span class="rankPrestigeNo">Prestige ${group.prestige} of ${prestigeCount()}</span>` : ''}
          ${stateLabel ? `<span class="rankPrestigeState">${esc(stateLabel)}</span>` : ''}
        </div>
        ${group.items.map(renderLadderRow).join('')}
      </div>`;
    };

    return `<div class="leaderboardRanksWrap">
      ${renderRankHeroCard(mine, decorated)}
      <div class="leaderboardRankLadderList">${
        groups.length ? groups.map(renderGroup).join('') : '<div class="leaderboardEmpty">Rank ladder unavailable.</div>'
      }</div>
    </div>`;
  }

  /* THE CARD AT THE TOP OF THE RANKS SCREEN
   *
   * It used to be two lines of text: the rank name and the level. Accurate and
   * completely flat -- it told a driver where they stood and gave them no
   * reason to care. A rank is meant to be worn.
   *
   * So the crest is the subject, at a size where the artwork reads, and under
   * it the two things that make standing somewhere feel like moving: how far
   * through this level the XP has carried them, and the crest they are
   * climbing toward with the number of levels left to reach it. "4 levels to
   * Warlord III", with Warlord III's own artwork beside it, is a goal. "Level
   * 431" is a fact.
   */
  function renderRankHeroCard(mine, decorated) {
    const xp = myLevelXpProgress();
    const total = prestigeCount();

    /* The next rank is the next band up, read off the ladder rather than
       computed -- the top band absorbs the remainder of the level range, so
       arithmetic here would be wrong at exactly the place it matters most. */
    const currentIndex = decorated.findIndex((i) => i.isCurrent);
    const next = currentIndex > -1 ? decorated[currentIndex + 1] : null;
    const atTop = currentIndex > -1 && !next;

    const meter = xp
      ? `<div class="rankHeroMeter" role="img" aria-label="${xp.maxed
          ? 'Maximum level reached'
          : `${Math.round(xp.pct)} percent through level ${mine.level}`}">
          <div class="rankHeroMeterFill" style="width:${xp.pct.toFixed(1)}%"></div>
        </div>
        <div class="rankHeroXp">${xp.maxed
          ? `${esc(formatXp(xp.total))} XP · every level earned`
          : `${esc(formatXp(xp.into))} / ${esc(formatXp(xp.span))} XP · ${esc(formatXp(xp.remaining))} to Level ${mine.level + 1}`
        }</div>`
      : '';

    let nextBlock = '';
    if (next) {
      const nextName = safeRankName(next.row?.rank_name || next.row?.title, next.row?.rank_icon_key);
      const opensAt = Number(next.row?.start_level);
      const toGo = Number.isFinite(opensAt) ? Math.max(0, Math.floor(opensAt) - mine.level) : null;
      const stepLabel = toGo === null
        ? 'Next rank'
        : (toGo <= 0 ? 'Unlocked — next rank' : `${toGo} ${toGo === 1 ? 'level' : 'levels'} to go`);
      nextBlock = `<div class="rankHeroNext">
        <div class="rankHeroNextIcon">${renderRankIcon(next.row?.rank_icon_key)}</div>
        <div class="rankHeroNextText">
          <div class="rankHeroNextTag">${esc(stepLabel)}</div>
          <div class="rankHeroNextName">${esc(nextName)}</div>
        </div>
      </div>`;
    } else if (atTop) {
      /* The end of the ladder is an achievement, not a missing card. */
      nextBlock = `<div class="rankHeroNext topped">
        <div class="rankHeroNextText">
          <div class="rankHeroNextTag">Top of the ladder</div>
          <div class="rankHeroNextName">Nothing above you</div>
        </div>
      </div>`;
    }

    const sub = mine.rank
      ? `Prestige ${mine.rank.prestige} of ${total} · Rank ${mine.rank.level} of ${ranksPerPrestige()}`
      : `Level ${mine.level}`;

    return `<div class="rankHeroCard">
      <div class="rankHeroCrest">${renderRankIcon(mine.rankIconKey)}</div>
      <div class="rankHeroName">${esc(mine.rankName)}</div>
      <div class="rankHeroSub">${esc(sub)}</div>
      <div class="rankHeroLevel">Level ${mine.level}</div>
      ${meter}
      ${nextBlock}
    </div>`;
  }

  async function loadRankLadder() {
    try {
      const res = await getAuth('/leaderboard/ranks');
      const rows = Array.isArray(res?.rows) ? res.rows : null;
      state.rankLadder = rows && rows.length ? rows : createRankLadderFallback();
    } catch (_) {
      state.rankLadder = createRankLadderFallback();
    }
    state.rankLadderLoaded = true;
    return state.rankLadder;
  }

  function leaderboardPanelHTML() {
    const metricBtn = (m, label) => `<button class="chipBtn ${(state.view !== 'ranks' && state.metric === m) ? 'active' : ''}" data-lb-metric="${m}">${label}</button>`;
    const periodBtn = (p, label) => `<button class="chipBtn ${state.period === p ? 'active' : ''}" data-lb-period="${p}">${label}</button>`;
    const viewBtn = (v, label) => `<button class="chipBtn ${state.view === v ? 'active' : ''}" data-lb-view="${v}">${label}</button>`;

    const renderRows = (rows, options = {}) => rows.map((row, idx) => {
      const rank = Number(row?.rank_position || idx + 1);
      const name = row?.display_name || row?.name || row?.user_name || `Driver ${rank}`;
      const value = row?.metric_value;
      const badge = strictBadgeCode(row?.badge_code);
      const onPodium = rank <= 3 && !options.compact;
      const rowClass = onPodium ? ` leaderboardTop${rank}` : '';
      /* On the podium the position is struck into a medal, and a medal that
         says "#1" wastes a third of its face on a character nobody needs:
         inside a gold disc at the top of a leaderboard, the 1 is unambiguous.
         Everywhere else the hash is what makes a bare number read as a
         position rather than a count. */
      return `<div class="leaderboardRow${rowClass}">
        <span class="leaderboardRank">${onPodium ? rank : `#${rank}`}</span>
        <span class="leaderboardNameWrap">
          <span class="leaderboardName" title="${esc(name)}">${esc(name)}</span>
          ${levelTitleLine(row?.level, row?.rank_name || row?.title, row?.rank_icon_key)}
        </span>
        <span class="leaderboardValue">${formatMetric(value)}</span>
        <span class="leaderboardBadgeCell">${badgeChip(badge)}</span>
      </div>`;
    }).join('');

    const topRows = renderRows(state.rows.slice(0, 10));
    const allRows = renderRows(state.rows, { compact: true });

    const myRank = Number(state.myRow?.rank_position || 0);
    const myName = state.myRow?.display_name || state.myRow?.name || (window.me && window.me.display_name) || 'You';
    const myValue = state.myRow?.metric_value;
    const topView = `
      <div>
        <div class="leaderboardSectionTitle">Top 10</div>
        <div class="leaderboardList">${topRows || '<div class="leaderboardEmpty">No entries yet.</div>'}</div>
      </div>

      <div class="myRankCard">
        <div class="leaderboardSectionTitle">My Rank</div>
        <div class="myRankRow"><span>${esc(myName)}</span><span>${myRank ? `#${myRank}` : 'Unranked'}</span></div>
        <div class="myRankRow"><span>Progression</span><span>${levelTitleLine(state.myRow?.level, state.myRow?.rank_name || state.myRow?.title, state.myRow?.rank_icon_key)}</span></div>
        <div class="myRankRow"><span>${state.metric === 'hours' ? 'Hours' : 'Miles'}</span><span>${formatMetric(myValue)}</span></div>
        <div class="myRankRow"><span>Badge</span><span>${badgeChip(selectedMyBadge()) || '—'}</span></div>
      </div>

      ${renderOverview()}

      <div>
        <div class="leaderboardSectionTitle">Badge legend</div>
        <div class="leaderboardLegend">${badgeChip('crown', { withLabel: true })} ${badgeChip('silver', { withLabel: true })} ${badgeChip('bronze', { withLabel: true })}</div>
      </div>`;

    const allView = `
      <div class="myRankCard leaderboardMyRankCompact">
        <div class="leaderboardSectionTitle">My Rank</div>
        <div class="myRankRow"><span>${esc(myName)}</span><span>${myRank ? `#${myRank}` : 'Unranked'}</span></div>
        <div class="myRankRow"><span>${state.metric === 'hours' ? 'Hours' : 'Miles'}</span><span>${formatMetric(myValue)}</span></div>
      </div>
      <div>
        <div class="leaderboardSectionTitle">See All Users</div>
        <div class="leaderboardList leaderboardAllList">${allRows || '<div class="leaderboardEmpty">No entries yet.</div>'}</div>
      </div>`;

    return `
      <div class="panelBlock leaderboardPanelWrap">
        <div class="leaderboardPanelControls">
          <div class="leaderboardTabs leaderboardViewTabs">${viewBtn('top', 'Overview')}${viewBtn('all', 'See All Users')}${viewBtn('ranks', 'Ranks')}</div>
          ${state.view === 'ranks' ? '' : `<div class="leaderboardTabs">${metricBtn('miles', 'Miles')}${metricBtn('hours', 'Hours')}</div>`}
          ${state.view === 'ranks' ? '' : `<div class="leaderboardTabs">${periodBtn('daily', 'Daily')}${periodBtn('weekly', 'Weekly')}${periodBtn('monthly', 'Monthly')}${periodBtn('yearly', 'Yearly')}</div>`}
        </div>
        <div class="leaderboardPanelBody">
          ${state.view === 'all' ? allView : (state.view === 'ranks' ? renderRankLadderView() : topView)}
        </div>

        <div id="lbStatus" class="leaderboardStatus ${state.statusType}">${esc(state.status || '')}</div>
      </div>`;
  }

  function rerenderIfOpen() {
    if (getOpenPanelKeyFn() !== PANEL_KEY) return;
    const body = document.getElementById('dockDrawerBody');
    if (!body) return;
    body.innerHTML = leaderboardPanelHTML();
    wireLeaderboardPanel();
  }

  async function loadAll() {
    if (!getToken()) {
      state.rows = [];
      state.myRow = null;
      state.badges = [];
      state.overview = null;
      state.myProgression = null;
      state.rankLadder = createRankLadderFallback();
      state.rankLadderLoaded = true;
      state.status = 'Sign in to view leaderboard.';
      state.statusType = 'err';
      rerenderIfOpen();
      return;
    }

    state.status = 'Loading…';
    state.statusType = '';
    rerenderIfOpen();

    const metric = encodeURIComponent(state.metric);
    const period = encodeURIComponent(state.period);
    try {
      const boardPromise = getAuth(`/leaderboard?metric=${metric}&period=${period}`)
        .catch(() => getAuth(`/leaderboard?metric=${metric}&period=${period}&limit=10`));
      if (!state.rankLadderLoaded) {
        await loadRankLadder().catch(() => createRankLadderFallback());
      }
      const [boardRes, meRes, badgesRes, overviewRes, progressionRes] = await Promise.all([
        boardPromise,
        getAuth(`/leaderboard/me?metric=${metric}&period=${period}`),
        getAuth('/leaderboard/badges/me').catch(() => ({ badges: [] })),
        getAuth('/leaderboard/overview/me').catch(() => null),
        /* Swallowed rather than fatal: without it the ladder loses its
           progress meter and keeps everything else. */
        getAuth('/leaderboard/progression/me').catch(() => null),
      ]);

      state.rows = Array.isArray(boardRes?.rows) ? boardRes.rows : [];
      state.myRow = meRes?.row || null;
      state.badges = Array.isArray(badgesRes?.badges) ? badgesRes.badges : [];
      state.overview = overviewRes && typeof overviewRes === 'object' ? overviewRes : null;
      state.myProgression = progressionRes?.progression || null;
      state.status = '';
      state.statusType = '';
    } catch (err) {
      state.rows = [];
      state.myRow = null;
      state.badges = [];
      state.overview = null;
      state.myProgression = null;
      if (!state.rankLadderLoaded) {
        state.rankLadder = createRankLadderFallback();
        state.rankLadderLoaded = true;
      }
      state.status = `Unable to load leaderboard: ${String(err?.message || err)}`;
      state.statusType = 'err';
      markLeaderboardOpenError(err);
    }

    rerenderIfOpen();
  }

  function wireLeaderboardPanel() {
    document.querySelectorAll('[data-lb-metric]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const nextMetric = btn.getAttribute('data-lb-metric') || 'miles';
        if (state.metric === nextMetric) return;
        state.metric = nextMetric;
        state.view = 'top';
        loadAll();
      });
    });

    document.querySelectorAll('[data-lb-period]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const nextPeriod = btn.getAttribute('data-lb-period') || 'weekly';
        if (state.period === nextPeriod) return;
        state.period = nextPeriod;
        loadAll();
      });
    });

    document.querySelectorAll('[data-lb-view]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const nextView = btn.getAttribute('data-lb-view') || 'top';
        if (state.view === nextView) return;
        state.view = (nextView === 'all' || nextView === 'ranks') ? nextView : 'top';
        rerenderIfOpen();
        if (state.view === 'ranks' && !state.rankLadderLoaded) {
          await loadRankLadder();
          rerenderIfOpen();
        }
      });
    });
  }

  function injectLeaderboardProgressionStyles() {
    if (document.getElementById('leaderboardProgressionStyles')) return;
    const style = document.createElement('style');
    style.id = 'leaderboardProgressionStyles';
    style.textContent = `
      .leaderboardNameWrap{display:flex;flex-direction:column;min-width:0}
      .leaderboardTierLine{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:700;color:#475569;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .leaderboardRankName{color:#334155}
      .leaderboardRankIconFallback{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;font-size:13px;line-height:1}
      .leaderboardTierLine .rankBadgeIconWrap.compact{width:18px;height:18px;flex:0 0 auto;box-shadow:inset 0 0 0 1px rgba(255,255,255,.35),0 1px 4px rgba(2,6,23,.2)}
      .leaderboardTierLine .rankBadgeIconWrap.compact svg{width:16px;height:16px}
      body:has(#dockDrawer .leaderboardPanelWrap) #dockBackdrop{z-index:9050;background:rgba(0,0,0,.12)}
      .leaderboardPanelWrap{gap:7px;overflow:hidden;padding:8px;height:100%;min-height:0}
      .leaderboardPanelControls{display:flex;flex-direction:column;gap:5px;flex:0 0 auto}
      .leaderboardTabs .chipBtn{justify-content:center}
      .leaderboardPanelBody{display:flex;flex-direction:column;gap:7px;flex:1;min-height:0;overflow-y:auto;padding-right:2px}
      .leaderboardPanelBody>div{flex:0 0 auto}
      .leaderboardSectionTitle{font:900 11px/1.2 system-ui;margin-bottom:4px}
      .leaderboardList{gap:4px;margin-top:2px}
      .leaderboardRow{gap:7px}
      .myRankCard{padding:7px;gap:4px}
      .myRankRow{line-height:1.2}
      .leaderboardLegend{gap:5px}
      .leaderboardAllList{max-height:100%;overflow-y:auto;padding-right:2px}
      .leaderboardMyRankCompact{margin-bottom:1px}
      .leaderboardViewTabs .chipBtn{flex:1 1 0}
      .leaderboardRanksWrap{display:flex;flex-direction:column;gap:7px;min-height:0}
      .leaderboardRankLadderList{display:flex;flex-direction:column;gap:6px;overflow-y:auto;padding-right:2px}
      .leaderboardRankLadderRow{display:flex;align-items:center;gap:10px;border:1px solid #dbe4ee;background:#f8fbff;border-radius:12px;padding:8px 9px}
      .leaderboardRankLadderRow.current{border-color:#7dd3fc;background:linear-gradient(120deg,#ecfeff,#eff6ff);box-shadow:0 0 0 1px rgba(56,189,248,.3),0 0 16px rgba(14,165,233,.2)}
      .leaderboardRankLadderIcon{flex:0 0 auto;display:grid;place-items:center}
      .leaderboardRankLadderIcon .rankBadgeIconWrap.compact{width:34px;height:34px}
      .leaderboardRankLadderIcon .rankBadgeIconWrap.compact svg{width:24px;height:24px}
      .leaderboardRankLadderText{min-width:0;display:flex;flex-direction:column;gap:1px}
      .leaderboardRankLadderTitle{font:800 13px/1.2 system-ui;color:#0f172a}
      .leaderboardRankLadderRange{font:700 11px/1.2 system-ui;color:#475569}
      .leaderboardRankLadderChip{margin-left:auto;font:800 10px/1 system-ui;padding:5px 7px;border-radius:999px;background:#0ea5e9;color:#ecfeff;white-space:nowrap}
    `;
    document.head.appendChild(style);
  }

  function openLeaderboardPanel() {
    const openDrawerFn = getOpenDrawerFn();
    if (typeof openDrawerFn !== 'function') {
      markLeaderboardOpenError('openDrawer unavailable');
      return false;
    }
    try {
      openDrawerFn(PANEL_KEY, 'Leaderboard', leaderboardPanelHTML());
      wireLeaderboardPanel();
      markLeaderboardOpened();
      void loadAll();
      return true;
    } catch (error) {
      markLeaderboardOpenError(error);
      console.warn('Failed to open leaderboard drawer', error);
      return false;
    }
  }

  function init() {
    injectLeaderboardProgressionStyles();
    markLeaderboardLoaded();
    const btn = document.getElementById('dockLeaderboard');
    if (!btn || typeof bindDockToggleFn !== 'function') return;
    if (btn.dataset.leaderboardBound === '1') return;
    btn.dataset.leaderboardBound = '1';
  }

  window.LeaderboardPanel = {
    init,
    open: openLeaderboardPanel,
    refresh: loadAll,
  };

  init();
})();
