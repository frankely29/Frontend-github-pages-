(function() {
  const runtime = window.FrontendRuntime || null;
  const runtimePolling = runtime?.polling || null;
  const LS_TOKEN = 'community_token_v1';

  function shuffleInPlace(items) {
    const list = Array.isArray(items) ? items : [];
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }

  function createDominoTileSet() {
    const tiles = [];
    for (let left = 0; left <= 6; left += 1) {
      for (let right = left; right <= 6; right += 1) {
        tiles.push([left, right]);
      }
    }
    return shuffleInPlace(tiles.slice());
  }

  function createInitialDominoesState() {
    const deck = createDominoTileSet();
    return {
      board: [],
      playerHand: deck.splice(0, 7),
      cpuHand: deck.splice(0, 7),
      boneyard: deck,
      turn: 'player',
      over: false,
      winner: '',
      message: 'Your turn. Match doubles or chain ends.',
      passStreak: 0,
    };
  }

  function createInitialBilliardsPracticeState() {
    return {
      playerScore: 0,
      cpuScore: 0,
      targetScore: 3,
      shotsTaken: 0,
      over: false,
      message: 'Practice mode ready. Sink 3 before the bot does.',
      balls: [
        { x: 0.22, y: 0.5, color: '#ffffff' },
        { x: 0.7, y: 0.32, color: '#fbbf24' },
        { x: 0.76, y: 0.5, color: '#38bdf8' },
        { x: 0.7, y: 0.68, color: '#f97316' },
      ],
    };
  }

  function gamesDefaultChallengeUserState() {
    return { rows: [], loadedAt: 0, query: '', loading: false, error: '', selected: null };
  }

  const gamesState = {
    activeTab: 'chess',
    activeModeByGame: { chess: 'cpu', uno: 'cpu', dominoes: 'cpu', billiards: 'cpu' },
    battleTab: 'overview',
    chess: createInitialChessState(),
    uno: createInitialUnoState(),
    unoWaitingColor: false,
    dominoes: createInitialDominoesState(),
    billiards: createInitialBilliardsPracticeState(),
    dashboard: { incoming: [], outgoing: [], activeMatch: null, history: [] },
    activeMatch: null,
    history: [],
    challengesLoadedAt: 0,
    matchLoadedAt: 0,
    loading: false,
    matchLoading: false,
    status: '',
    error: '',
    challengeComposer: { targetUserId: '', targetDisplayName: '', gameType: 'dominoes' },
    challengeUsers: gamesDefaultChallengeUserState(),
    battleNotificationsSeen: new Set(),
    billiardsAim: { angle: 0.1, power: 0.58 },
  };

  const GAMES_DASHBOARD_POLL_MS = 12000;
  const GAMES_ACTIVE_MATCH_POLL_MS = 2800;
  let gamesDashboardPollTimer = null;
  let gamesMatchPollTimer = null;

  function isGamesPanelOpen() {
    return window.getOpenPanelKey?.() === 'games';
  }

  function getGamesAuthToken() {
    try { return localStorage.getItem(LS_TOKEN) || ''; } catch (_) { return ''; }
  }

  async function gamesApiGet(path) {
    const token = getGamesAuthToken();
    if (runtime?.getJSONAuth) return runtime.getJSONAuth(path, token);
    if (window.FrontendRuntime?.getJSONAuth) return window.FrontendRuntime.getJSONAuth(path, token);
    return getJSONAuth(path, token);
  }

  async function gamesApiPost(path, body = {}) {
    const token = getGamesAuthToken();
    if (runtime?.postJSON) return runtime.postJSON(path, body, token);
    if (window.FrontendRuntime?.postJSON) return window.FrontendRuntime.postJSON(path, body, token);
    return postJSON(path, body, token);
  }

  function defaultBattleStats() {
    return {
      wins: 0,
      losses: 0,
      total_matches: 0,
      matches_played: 0,
      win_rate: 0,
      dominoes_wins: 0,
      dominoes_losses: 0,
      billiards_wins: 0,
      billiards_losses: 0,
      game_xp_earned: 0,
    };
  }

  function formatBattlePct(value) {
    const n = Number(value);
    return `${Number.isFinite(n) ? Math.max(0, Math.min(100, n * 100)) : 0}`.replace(/\.0+$/, '') + '%';
  }

  function setGamesStatus(message = '', isError = false) {
    gamesState.status = String(message || '');
    gamesState.error = isError ? gamesState.status : '';
  }

  function scheduleGamesDashboardPoll({ immediate = false } = {}) {
    if (gamesDashboardPollTimer) window.clearTimeout(gamesDashboardPollTimer);
    gamesDashboardPollTimer = window.setTimeout(async () => {
      gamesDashboardPollTimer = null;
      if (!isGamesPanelOpen()) return;
      await loadGamesBattleDashboard({ silent: true });
      scheduleGamesDashboardPoll();
    }, immediate ? 0 : GAMES_DASHBOARD_POLL_MS);
  }

  function scheduleGamesMatchPoll({ immediate = false } = {}) {
    if (gamesMatchPollTimer) window.clearTimeout(gamesMatchPollTimer);
    const activeId = Number(gamesState.activeMatch?.id || gamesState.dashboard?.activeMatch?.id || 0);
    if (!activeId) return;
    gamesMatchPollTimer = window.setTimeout(async () => {
      gamesMatchPollTimer = null;
      if (!isGamesPanelOpen()) return;
      await loadActiveBattleMatch({ silent: true, preferredMatchId: activeId });
      if (Number(gamesState.activeMatch?.id || 0)) scheduleGamesMatchPoll();
    }, immediate ? 0 : GAMES_ACTIVE_MATCH_POLL_MS);
  }

  async function loadGamesBattleDashboard({ silent = false } = {}) {
    if (!getGamesAuthToken()) return null;
    if (!silent) {
      gamesState.loading = true;
      setGamesStatus('Loading battle hub…');
      rerenderGamesPanel();
    }
    try {
      const [incomingRes, outgoingRes, activeRes, historyRes, aggregateRes] = await Promise.all([
        gamesApiGet('/games/challenges/incoming').catch(() => null),
        gamesApiGet('/games/challenges/outgoing').catch(() => null),
        gamesApiGet('/games/matches/active/me').catch(() => null),
        gamesApiGet('/games/history/me').catch(() => ({ ok: false, rows: [] })),
        gamesApiGet('/games/challenges').catch(() => null),
      ]);
      const challengesRes = aggregateRes || {};
      gamesState.dashboard = {
        incoming: Array.isArray(incomingRes?.rows) ? incomingRes.rows : (Array.isArray(challengesRes?.incoming) ? challengesRes.incoming : []),
        outgoing: Array.isArray(outgoingRes?.rows) ? outgoingRes.rows : (Array.isArray(challengesRes?.outgoing) ? challengesRes.outgoing : []),
        activeMatch: activeRes?.match || activeRes?.active_match || activeRes?.activeMatch || challengesRes?.active_match || challengesRes?.activeMatch || null,
        history: Array.isArray(historyRes?.rows) ? historyRes.rows : Array.isArray(historyRes?.history) ? historyRes.history : [],
      };
      gamesState.history = gamesState.dashboard.history.slice();
      gamesState.challengesLoadedAt = Date.now();
      if (!gamesState.activeMatch && gamesState.dashboard.activeMatch) gamesState.activeMatch = gamesState.dashboard.activeMatch;
      if (gamesState.dashboard.activeMatch?.id) scheduleGamesMatchPoll({ immediate: true });
      if (!silent) setGamesStatus('');
      return gamesState.dashboard;
    } catch (err) {
      setGamesStatus(err?.message || 'Unable to load battle hub.', true);
      return null;
    } finally {
      gamesState.loading = false;
      rerenderGamesPanel();
    }
  }

  async function loadActiveBattleMatch({ silent = false, preferredMatchId = null } = {}) {
    if (!getGamesAuthToken()) return null;
    if (!silent) {
      gamesState.matchLoading = true;
      setGamesStatus('Loading active battle…');
      rerenderGamesPanel();
    }
    const numericId = Number(preferredMatchId || gamesState.dashboard?.activeMatch?.id || gamesState.activeMatch?.id || 0);
    try {
      const res = numericId
        ? await gamesApiGet(`/games/matches/${encodeURIComponent(numericId)}`)
        : await gamesApiGet('/games/matches/active/me');
      const match = res?.match || res?.active_match || res?.activeMatch || null;
      if (match) {
        gamesState.activeMatch = match;
        gamesState.dashboard.activeMatch = {
          id: match.id,
          game_type: match.game_type,
          opponent_display_name: match.opponent_display_name,
          opponent_user_id: match.opponent_user_id,
          status: match.status,
        };
        gamesState.matchLoadedAt = Date.now();
      } else if (!silent) {
        gamesState.activeMatch = null;
      }
      if (res?.reward_contract) {
        gamesState.battleNotificationsSeen.add(`reward:${match?.id || 'unknown'}`);
        showBattleProgressReward(res.reward_contract, match);
      }
      rerenderGamesPanel();
      return match;
    } catch (err) {
      if (!silent) setGamesStatus(err?.message || 'Unable to load active battle.', true);
      return null;
    } finally {
      gamesState.matchLoading = false;
    }
  }

  async function createBattleChallenge(targetUserId, gameType) {
    if (!targetUserId) return;
    setGamesStatus('Sending challenge…');
    rerenderGamesPanel();
    try {
      await gamesApiPost('/games/challenges', {
        target_user_id: Number(targetUserId),
        challenged_user_id: Number(targetUserId),
        game_type: String(gameType || 'dominoes'),
        game_key: String(gameType || 'dominoes'),
      });
      setGamesStatus('Challenge sent.');
      gamesState.battleTab = 'outgoing';
      await loadGamesBattleDashboard({ silent: true });
    } catch (err) {
      setGamesStatus(err?.message || 'Challenge failed.', true);
    }
    rerenderGamesPanel();
  }

  async function respondToChallenge(challengeId, action) {
    if (!challengeId || !action) return;
    const path = `/games/challenges/${encodeURIComponent(challengeId)}/${action}`;
    setGamesStatus(`${action === 'accept' ? 'Accepting' : action === 'decline' ? 'Declining' : 'Canceling'} challenge…`);
    rerenderGamesPanel();
    try {
      const res = await gamesApiPost(path, {});
      setGamesStatus(action === 'accept' ? 'Battle accepted.' : action === 'decline' ? 'Challenge declined.' : 'Challenge canceled.');
      await loadGamesBattleDashboard({ silent: true });
      const matchId = Number(res?.match?.id || res?.active_match?.id || res?.match_id || 0);
      if (matchId) {
        gamesState.battleTab = 'active';
        await loadActiveBattleMatch({ silent: true, preferredMatchId: matchId });
      }
    } catch (err) {
      setGamesStatus(err?.message || 'Challenge action failed.', true);
    }
    rerenderGamesPanel();
  }

  async function submitBattleMove(payload) {
    const matchId = Number(gamesState.activeMatch?.id || 0);
    if (!matchId || !payload || typeof payload !== 'object') return;
    setGamesStatus('Submitting move…');
    rerenderGamesPanel();
    try {
      const res = await gamesApiPost(`/games/matches/${encodeURIComponent(matchId)}/move`, payload);
      if (res?.match) gamesState.activeMatch = res.match;
      if (res?.reward_contract) showBattleProgressReward(res.reward_contract, res.match || gamesState.activeMatch);
      setGamesStatus(res?.match?.status === 'completed' ? 'Battle completed.' : 'Move submitted.');
      await loadGamesBattleDashboard({ silent: true });
      rerenderGamesPanel();
    } catch (err) {
      setGamesStatus(err?.message || 'Move failed.', true);
      rerenderGamesPanel();
    }
  }

  async function forfeitBattleMatch() {
    const matchId = Number(gamesState.activeMatch?.id || 0);
    if (!matchId) return;
    if (typeof confirm === 'function' && !confirm('Forfeit this battle?')) return;
    setGamesStatus('Forfeiting battle…');
    rerenderGamesPanel();
    try {
      const res = await gamesApiPost(`/games/matches/${encodeURIComponent(matchId)}/forfeit`, {});
      if (res?.match) gamesState.activeMatch = res.match;
      if (res?.reward_contract) showBattleProgressReward(res.reward_contract, res.match || gamesState.activeMatch);
      await loadGamesBattleDashboard({ silent: true });
      rerenderGamesPanel();
    } catch (err) {
      setGamesStatus(err?.message || 'Unable to forfeit.', true);
      rerenderGamesPanel();
    }
  }

  function formatBattleDate(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function battleResultLabel(row) {
    const result = String(row?.result || row?.outcome || '').toLowerCase();
    if (result === 'win' || row?.winner === true) return 'Win';
    if (result === 'loss' || row?.winner === false) return 'Loss';
    if (result) return result.replace(/_/g, ' ');
    return 'Pending';
  }

  function challengeMetaLine(item) {
    const game = String(item?.game_type || 'battle').replace(/^./, (m) => m.toUpperCase());
    const expires = item?.expires_at ? ` • expires ${formatBattleDate(item.expires_at)}` : '';
    return `${game}${expires}`;
  }

  function renderChallengeRow(item, type) {
    const opponent = escapeHtml(String(item?.other_user_display_name || item?.opponent_display_name || item?.challenged_display_name || item?.challenger_display_name || item?.display_name || 'Driver'));
    const actions = type === 'incoming'
      ? `<div class="gamesActionRow"><button class="chipBtn" data-games-accept="${escapeHtml(String(item?.id || ''))}">Accept</button><button class="chipBtn" data-games-decline="${escapeHtml(String(item?.id || ''))}">Decline</button></div>`
      : `<div class="gamesActionRow"><button class="chipBtn" data-games-cancel="${escapeHtml(String(item?.id || ''))}">Cancel</button></div>`;
    return `<article class="gamesBattleCard">
      <div class="gamesBattleTitle">${opponent}</div>
      <div class="gamesBattleMeta">${escapeHtml(challengeMetaLine(item))}</div>
      ${actions}
    </article>`;
  }

  function renderBattleHistoryRow(item) {
    const label = battleResultLabel(item);
    const xp = Number(item?.xp_awarded || item?.winner_xp_awarded || item?.xp || 0);
    const game = String(item?.game_type || 'battle').replace(/^./, (m) => m.toUpperCase());
    const opponent = String(item?.opponent_display_name || item?.loser_display_name || item?.winner_display_name || 'Driver');
    return `<article class="gamesBattleCard compact ${label === 'Win' ? 'win' : (label === 'Loss' ? 'loss' : '')}">
      <div class="gamesBattleTitle">${escapeHtml(game)} • ${escapeHtml(label)}</div>
      <div class="gamesBattleMeta">vs ${escapeHtml(opponent)} • ${escapeHtml(formatBattleDate(item?.completed_at))}</div>
      <div class="gamesBattleReward">${xp > 0 ? `+${window.formatProgressNumber(xp, { maxFractionDigits: 0 })} XP` : 'Completed'}</div>
    </article>`;
  }

  function renderBattleOverview() {
    const incoming = Array.isArray(gamesState.dashboard?.incoming) ? gamesState.dashboard.incoming : [];
    const outgoing = Array.isArray(gamesState.dashboard?.outgoing) ? gamesState.dashboard.outgoing : [];
    const history = Array.isArray(gamesState.history) ? gamesState.history.slice(0, 5) : [];
    const active = gamesState.activeMatch || gamesState.dashboard?.activeMatch || null;
    const composer = gamesState.challengeComposer || {};
    return `<div class="gamesBattleColumns">
      <section class="gamesBattlePanel">
        <div class="gamesSectionHeader">Create challenge</div>
        <div class="gamesChallengeComposer">
          <input id="gamesChallengeTarget" class="driverProfileInput gamesComposerInput" type="number" min="1" inputmode="numeric" placeholder="Driver ID" value="${escapeHtml(String(composer.targetUserId || ''))}">
          <input id="gamesChallengeTargetName" class="driverProfileInput gamesComposerInput" type="text" placeholder="Driver name (optional)" value="${escapeHtml(String(composer.targetDisplayName || ''))}">
          <div class="gamesTabs gamesMiniTabs">
            <button class="chipBtn ${composer.gameType === 'dominoes' ? 'active' : ''}" data-games-select-type="dominoes">Dominoes</button>
            <button class="chipBtn ${composer.gameType === 'billiards' ? 'active' : ''}" data-games-select-type="billiards">Billiards</button>
          </div>
          <button id="gamesSendChallengeBtn" class="chipBtn">Send Challenge</button>
        </div>
      </section>
      <section class="gamesBattlePanel">
        <div class="gamesSectionHeader">Battle inbox</div>
        <div class="gamesBattleList">${incoming.length ? incoming.map((row) => renderChallengeRow(row, 'incoming')).join('') : '<div class="leaderboardEmpty">No incoming challenges.</div>'}</div>
      </section>
      <section class="gamesBattlePanel">
        <div class="gamesSectionHeader">Outgoing</div>
        <div class="gamesBattleList">${outgoing.length ? outgoing.map((row) => renderChallengeRow(row, 'outgoing')).join('') : '<div class="leaderboardEmpty">No outgoing challenges.</div>'}</div>
      </section>
      <section class="gamesBattlePanel">
        <div class="gamesSectionHeader">Active battle</div>
        ${active ? `<div class="gamesBattleCard"><div class="gamesBattleTitle">${escapeHtml(String(active.game_type || 'battle').replace(/^./, (m) => m.toUpperCase()))}</div><div class="gamesBattleMeta">${escapeHtml(String(active.opponent_display_name || 'Driver'))}</div><button class="chipBtn" data-games-tab="active">Open Match</button></div>` : '<div class="leaderboardEmpty">No active battle.</div>'}
      </section>
      <section class="gamesBattlePanel">
        <div class="gamesSectionHeader">Recent history</div>
        <div class="gamesBattleList">${history.length ? history.map(renderBattleHistoryRow).join('') : '<div class="leaderboardEmpty">No recent battles yet.</div>'}</div>
      </section>
    </div>`;
  }

  function isLocalPlayersTurn(match) {
    const meId = String(window?.me?.id || '');
    return !!meId && String(match?.current_turn_user_id || match?.currentTurnUserId || '') === meId;
  }

  function renderDominoesTile(tile, playable = false, attrs = '') {
    const left = Number(Array.isArray(tile) ? tile[0] : tile?.[0]);
    const right = Number(Array.isArray(tile) ? tile[1] : tile?.[1]);
    const safeLeft = Number.isFinite(left) ? left : 0;
    const safeRight = Number.isFinite(right) ? right : 0;
    const dots = [safeLeft, safeRight].map((value, idx) => {
      const positions = {
        1: [[12, 18]], 2: [[8, 14], [16, 22]], 3: [[8, 14], [12, 18], [16, 22]],
        4: [[8, 14], [16, 14], [8, 22], [16, 22]], 5: [[8, 14], [16, 14], [12, 18], [8, 22], [16, 22]],
        6: [[8, 13], [16, 13], [8, 18], [16, 18], [8, 23], [16, 23]],
      };
      return (positions[value] || []).map(([x, y]) => `<circle cx="${x}" cy="${y + (idx * 22)}" r="1.9"/>`).join('');
    }).join('');
    return `<button type="button" class="gamesDominoTile${playable ? ' playable' : ''}" ${attrs}>` +
      `<svg viewBox="0 0 24 48" aria-hidden="true"><rect x="1.5" y="1.5" width="21" height="45" rx="4" fill="rgba(255,255,255,.95)" stroke="rgba(15,23,42,.35)" stroke-width="1.5"/><path d="M4 24h16" stroke="rgba(15,23,42,.35)" stroke-width="1.4"/>${dots}</svg>` +
      `<span class="sr-only">${safeLeft}-${safeRight}</span></button>`;
  }

  function renderDominoesBattle(host, match) {
    const state = match?.match_state || match?.state || {};
    const myHand = Array.isArray(state?.your_hand || state?.my_hand || state?.player_hand) ? (state.your_hand || state.my_hand || state.player_hand) : [];
    const board = Array.isArray(state?.board_chain || state?.board || state?.chain) ? (state.board_chain || state.board || state.chain) : [];
    const playable = new Set((Array.isArray(state?.playable_tiles) ? state.playable_tiles : []).map((tile) => JSON.stringify(tile)));
    const myTurn = isLocalPlayersTurn(match);
    host.innerHTML = `<div class="gamesBattleArena">
      <div class="gamesBattleTopline"><div class="gamesStatus">${escapeHtml(String(match?.status === 'completed' ? (match?.result_summary || 'Match complete.') : (myTurn ? 'Your turn' : 'Opponent turn')))}</div><button id="gamesForfeitBtn" class="chipBtn dangerBtn" ${match?.status === 'completed' ? 'disabled' : ''}>Forfeit</button></div>
      <div class="gamesBattleMeta">Opponent hand: ${escapeHtml(String(state?.opponent_hand_count ?? state?.other_hand_count ?? '—'))} • Boneyard: ${escapeHtml(String(state?.boneyard_count ?? state?.stock_count ?? '—'))}</div>
      <div class="gamesDominoBoard">${board.length ? board.map((tile) => `<div class="gamesDominoBoardTile">${renderDominoesTile(tile)}</div>`).join('') : '<div class="leaderboardEmpty">Board waiting for first move.</div>'}</div>
      <div class="gamesActionRow"><button id="gamesDominoDrawBtn" class="chipBtn" ${!myTurn || !state?.can_draw ? 'disabled' : ''}>Draw Tile</button><button id="gamesDominoPassBtn" class="chipBtn" ${!myTurn || !state?.can_pass ? 'disabled' : ''}>Pass</button></div>
      <div class="gamesMiniLabel">Your hand</div>
      <div class="gamesDominoHand">${myHand.map((tile, idx) => {
        const encoded = escapeHtml(JSON.stringify(tile));
        const canPlay = myTurn && playable.has(JSON.stringify(tile));
        return `<div class="gamesDominoTileWrap">${renderDominoesTile(tile, canPlay, `${canPlay ? `data-domino-tile="${encoded}"` : 'disabled'}`)}<div class="gamesDominoActions"><button class="chipBtn miniChip" ${canPlay ? `data-domino-play='${encoded}' data-domino-side="left"` : 'disabled'}>Left</button><button class="chipBtn miniChip" ${canPlay ? `data-domino-play='${encoded}' data-domino-side="right"` : 'disabled'}>Right</button></div></div>`;
      }).join('')}</div>
      ${match?.status === 'completed' ? `<div class="gamesBattleResult">${escapeHtml(String(match?.result_summary || 'Battle completed.'))}</div>` : ''}
    </div>`;
    document.getElementById('gamesForfeitBtn')?.addEventListener('click', (e) => { e.preventDefault(); void forfeitBattleMatch(); });
    document.getElementById('gamesDominoDrawBtn')?.addEventListener('click', (e) => { e.preventDefault(); void submitBattleMove({ move_type: 'draw_tile' }); });
    document.getElementById('gamesDominoPassBtn')?.addEventListener('click', (e) => { e.preventDefault(); void submitBattleMove({ move_type: 'pass' }); });
    host.querySelectorAll('[data-domino-play]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const raw = btn.getAttribute('data-domino-play') || '[]';
        const side = btn.getAttribute('data-domino-side') || 'left';
        let tile = [];
        try { tile = JSON.parse(raw); } catch (_) {}
        void submitBattleMove({ move_type: 'play_tile', tile, side });
      });
    });
  }

  function drawBilliardsCanvas(canvas, match) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const state = match?.match_state || match?.state || {};
    const balls = Array.isArray(state?.balls) ? state.balls : [];
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0a6b47';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(255,255,255,.24)';
    ctx.lineWidth = 4;
    ctx.strokeRect(6, 6, width - 12, height - 12);
    const pockets = [[12,12],[width/2,10],[width-12,12],[12,height-12],[width/2,height-10],[width-12,height-12]];
    ctx.fillStyle = '#0f172a';
    pockets.forEach(([x,y]) => { ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.fill(); });
    balls.forEach((ball, idx) => {
      const x = Number(ball?.x);
      const y = Number(ball?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || ball?.pocketed) return;
      ctx.beginPath();
      ctx.fillStyle = String(ball?.color || (idx === 0 ? '#ffffff' : '#fbbf24'));
      ctx.arc(x * width, y * height, idx === 0 ? 8 : 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(15,23,42,.28)';
      ctx.stroke();
    });
    if (isLocalPlayersTurn(match) && balls[0] && !balls[0].pocketed) {
      const cue = balls[0];
      const aim = gamesState.billiardsAim || { angle: 0, power: 0.5 };
      const startX = cue.x * width;
      const startY = cue.y * height;
      const lineLen = 24 + (aim.power * 52);
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.lineTo(startX + Math.cos(aim.angle) * lineLen, startY + Math.sin(aim.angle) * lineLen);
      ctx.stroke();
    }
  }

  function renderBilliardsBattle(host, match) {
    const state = match?.match_state || match?.state || {};
    const myTurn = isLocalPlayersTurn(match);
    host.innerHTML = `<div class="gamesBattleArena">
      <div class="gamesBattleTopline"><div class="gamesStatus">${escapeHtml(String(match?.status === 'completed' ? (match?.result_summary || 'Match complete.') : (myTurn ? 'Line up your shot.' : 'Waiting for opponent shot.')))}</div><button id="gamesForfeitBtn" class="chipBtn dangerBtn" ${match?.status === 'completed' ? 'disabled' : ''}>Forfeit</button></div>
      <div class="gamesBattleMeta">Targets left: ${escapeHtml(String(state?.your_targets_remaining ?? state?.player_targets_remaining ?? '—'))} • Opponent: ${escapeHtml(String(state?.opponent_targets_remaining ?? '—'))}</div>
      <canvas id="gamesBilliardsCanvas" class="gamesBilliardsCanvas" width="320" height="180"></canvas>
      <div class="gamesBilliardsControls">
        <label class="gamesControlLabel">Angle <input id="gamesBilliardsAngle" type="range" min="-314" max="314" step="1" value="${Math.round((gamesState.billiardsAim.angle || 0) * 100)}" ${!myTurn || match?.status === 'completed' ? 'disabled' : ''}></label>
        <label class="gamesControlLabel">Power <input id="gamesBilliardsPower" type="range" min="10" max="100" step="1" value="${Math.round((gamesState.billiardsAim.power || 0.58) * 100)}" ${!myTurn || match?.status === 'completed' ? 'disabled' : ''}></label>
        <button id="gamesBilliardsShotBtn" class="chipBtn" ${!myTurn || match?.status === 'completed' ? 'disabled' : ''}>Take Shot</button>
      </div>
      <div class="gamesBattleMeta">Rule: first player to pocket every target ball, then the final ball, wins.</div>
      ${match?.status === 'completed' ? `<div class="gamesBattleResult">${escapeHtml(String(match?.result_summary || 'Battle completed.'))}</div>` : ''}
    </div>`;
    const canvas = document.getElementById('gamesBilliardsCanvas');
    drawBilliardsCanvas(canvas, match);
    document.getElementById('gamesForfeitBtn')?.addEventListener('click', (e) => { e.preventDefault(); void forfeitBattleMatch(); });
    document.getElementById('gamesBilliardsAngle')?.addEventListener('input', (e) => {
      gamesState.billiardsAim.angle = Number(e.target.value || 0) / 100;
      drawBilliardsCanvas(canvas, match);
    });
    document.getElementById('gamesBilliardsPower')?.addEventListener('input', (e) => {
      gamesState.billiardsAim.power = Math.max(0.1, Math.min(1, Number(e.target.value || 58) / 100));
      drawBilliardsCanvas(canvas, match);
    });
    document.getElementById('gamesBilliardsShotBtn')?.addEventListener('click', (e) => {
      e.preventDefault();
      void submitBattleMove({ move_type: 'shot', angle: Number(gamesState.billiardsAim.angle || 0), power: Number(gamesState.billiardsAim.power || 0.58) });
    });
  }

  function renderActiveBattle(host) {
    const match = gamesState.activeMatch;
    if (!match) {
      host.innerHTML = '<div class="leaderboardEmpty">No active battle right now.</div>';
      return;
    }
    if (String(match?.game_type || '') === 'billiards') {
      renderBilliardsBattle(host, match);
      return;
    }
    renderDominoesBattle(host, match);
  }

  function showBattleProgressReward(progression = {}, match = {}) {
    const payload = progression?.progression ? progression : { progression };
    if (!window.renderPickupProgressReward(payload)) return;
    updatePickupRewardLayout();
    const root = window.ensurePickupProgressReward();
    const kickerEl = document.getElementById('pickupProgressRewardKicker');
    const footEl = document.getElementById('pickupProgressRewardFoot');
    if (kickerEl) kickerEl.textContent = `${String(match?.game_type || 'Battle').replace(/^./, (m) => m.toUpperCase())} Battle Complete`;
    if (footEl && match?.winner_display_name && match?.loser_display_name) {
      footEl.textContent = `${match.winner_display_name} defeated ${match.loser_display_name}`;
    }
    root.classList.remove('show');
    void root.offsetWidth;
    root.classList.add('show');
    root.setAttribute('aria-hidden', 'false');
    if (showBattleProgressReward._timer) window.clearTimeout(showBattleProgressReward._timer);
    showBattleProgressReward._timer = window.setTimeout(() => {
      root.classList.remove('show');
      root.setAttribute('aria-hidden', 'true');
      showBattleProgressReward._timer = null;
    }, 3800);
    if (progression?.leveled_up || progression?.new_level > progression?.previous_level) {
      window.showLevelUpOverlay(progression);
    }
  }

  function activeGamesMode() {
    return gamesState.activeModeByGame[gamesState.activeTab] || 'cpu';
  }

  function setGamesTabMode(gameKey, mode) {
    gamesState.activeModeByGame[gameKey] = mode === 'vs_driver' ? 'vs_driver' : 'cpu';
    if (gamesState.activeModeByGame[gameKey] === 'vs_driver') {
      gamesState.challengeComposer.gameType = gameKey === 'billiards' ? 'billiards' : 'dominoes';
      void loadGamesBattleDashboard({ silent: true });
      void loadChallengeableUsers({ query: gamesState.challengeUsers.query || '', gameKey });
    }
  }

  function normalizeChallengeUser(row = {}) {
    const id = Number(row?.user_id ?? row?.id ?? row?.uid ?? 0);
    if (!Number.isFinite(id) || id <= 0) return null;
    return {
      user_id: id,
      display_name: String(row?.display_name || row?.name || row?.email || `Driver ${id}`),
      avatar_thumb_url: window.safeMapAvatarUrl?.(row?.avatar_thumb_url || row?.avatar_url || '') || '',
      rank_icon_key: row?.rank_icon_key || row?.rankIconKey || '',
      level: Number(row?.level || 0) || 0,
      online: !!(row?.online || row?.is_online),
      leaderboard_badge_code: row?.leaderboard_badge_code || '',
    };
  }

  async function loadChallengeableUsers({ query = '', gameKey = null, force = false } = {}) {
    if (!getGamesAuthToken()) return [];
    const nextQuery = String(query || '').trim();
    const activeGame = gameKey || gamesState.challengeComposer.gameType || 'dominoes';
    const cacheFresh = !force && gamesState.challengeUsers.loadedAt && (Date.now() - gamesState.challengeUsers.loadedAt < 15000);
    if (cacheFresh && nextQuery === gamesState.challengeUsers.query) return gamesState.challengeUsers.rows;
    gamesState.challengeUsers.loading = true;
    gamesState.challengeUsers.error = '';
    gamesState.challengeUsers.query = nextQuery;
    rerenderGamesPanel();
    try {
      const route = `/games/users?q=${encodeURIComponent(nextQuery)}&limit=80&game_key=${encodeURIComponent(activeGame)}`;
      let payload = await gamesApiGet(route).catch(() => null);
      let rows = Array.isArray(payload?.rows) ? payload.rows : Array.isArray(payload?.users) ? payload.users : [];
      if (!rows.length) {
        payload = await gamesApiGet('/presence/all?mode=full&limit=500').catch(() => null);
        const fallbackRows = Array.isArray(payload) ? payload : Array.isArray(payload?.items) ? payload.items : [];
        rows = fallbackRows.filter((row) => {
          const meId = Number(window?.me?.id || 0);
          const rowId = Number(row?.user_id ?? row?.id ?? row?.uid ?? 0);
          if (!rowId || (meId && rowId === meId)) return false;
          const label = String(row?.display_name || row?.name || row?.email || '').toLowerCase();
          return !nextQuery || label.includes(nextQuery.toLowerCase());
        });
      }
      gamesState.challengeUsers.rows = rows.map(normalizeChallengeUser).filter(Boolean);
      gamesState.challengeUsers.loadedAt = Date.now();
      return gamesState.challengeUsers.rows;
    } catch (err) {
      gamesState.challengeUsers.error = err?.message || 'Unable to load drivers.';
      return [];
    } finally {
      gamesState.challengeUsers.loading = false;
      rerenderGamesPanel();
    }
  }

  function battleRowsForGame(gameKey) {
    const normalizedKey = gameKey === 'billiards' ? 'billiards' : 'dominoes';
    const matchKey = (row) => String(row?.game_key || row?.game_type || '').toLowerCase();
    return {
      incoming: (gamesState.dashboard?.incoming || []).filter((row) => matchKey(row) === normalizedKey),
      outgoing: (gamesState.dashboard?.outgoing || []).filter((row) => matchKey(row) === normalizedKey),
      history: (gamesState.history || []).filter((row) => matchKey(row) === normalizedKey).slice(0, 5),
      active: String(gamesState.activeMatch?.game_key || gamesState.activeMatch?.game_type || '').toLowerCase() === normalizedKey ? gamesState.activeMatch : null,
    };
  }

  function renderChallengeableUsers(gameKey) {
    const state = gamesState.challengeUsers;
    const rows = Array.isArray(state.rows) ? state.rows : [];
    const selectedId = Number(state.selected?.user_id || gamesState.challengeComposer.targetUserId || 0);
    return `<section class="gamesBattlePanel">
      <div class="gamesSectionHeader">Vs Driver</div>
      <input id="gamesChallengeSearch" class="driverProfileInput gamesComposerInput" type="search" placeholder="Search drivers" value="${escapeHtml(state.query || '')}">
      <div class="gamesUserList">
        ${state.loading ? '<div class="leaderboardEmpty">Loading drivers…</div>' : ''}
        ${!state.loading && !rows.length ? '<div class="leaderboardEmpty">No drivers found.</div>' : rows.map((row) => `
          <button type="button" class="gamesUserRow ${selectedId === row.user_id ? 'selected' : ''}" data-games-user="${row.user_id}">
            <span class="gamesUserAvatar">${row.avatar_thumb_url ? `<img src="${escapeHtml(row.avatar_thumb_url)}" alt="" loading="lazy">` : escapeHtml((row.display_name || 'D').slice(0, 2).toUpperCase())}</span>
            <span class="gamesUserMeta"><strong>${escapeHtml(row.display_name)}</strong><span>${row.level ? `Level ${escapeHtml(String(row.level))}` : 'Driver'} ${row.online ? '• Online' : ''}</span></span>
            <span class="gamesUserRank">${row.rank_icon_key ? window.renderRankBadgeIcon(row.rank_icon_key, { compact: true }) : ''}</span>
          </button>`).join('')}
      </div>
      <div class="gamesChallengeComposer">
        <input id="gamesChallengeTargetName" class="driverProfileInput gamesComposerInput" type="text" placeholder="Selected driver" readonly value="${escapeHtml(String(state.selected?.display_name || gamesState.challengeComposer.targetDisplayName || ''))}">
        <button id="gamesSendChallengeBtn" class="chipBtn" ${!(state.selected?.user_id || gamesState.challengeComposer.targetUserId) ? 'disabled' : ''}>Challenge to ${escapeHtml(gameKey === 'billiards' ? 'Billiards' : 'Dominoes')}</button>
      </div>
      ${state.error ? `<div class="gamesStatus err">${escapeHtml(state.error)}</div>` : ''}
    </section>`;
  }

  function renderBattleInboxStack(gameKey) {
    const battleRows = battleRowsForGame(gameKey);
    return `<div class="gamesBattleColumns">
      ${renderChallengeableUsers(gameKey)}
      <section class="gamesBattlePanel"><div class="gamesSectionHeader">Incoming</div><div class="gamesBattleList">${battleRows.incoming.length ? battleRows.incoming.map((row) => renderChallengeRow(row, 'incoming')).join('') : '<div class="leaderboardEmpty">No incoming challenges.</div>'}</div></section>
      <section class="gamesBattlePanel"><div class="gamesSectionHeader">Outgoing</div><div class="gamesBattleList">${battleRows.outgoing.length ? battleRows.outgoing.map((row) => renderChallengeRow(row, 'outgoing')).join('') : '<div class="leaderboardEmpty">No outgoing challenges.</div>'}</div></section>
      <section class="gamesBattlePanel"><div class="gamesSectionHeader">Active battle</div>${battleRows.active ? `<div class="gamesBattleCard"><div class="gamesBattleTitle">${escapeHtml(String(battleRows.active.opponent_display_name || 'Driver'))}</div><div class="gamesBattleMeta">${escapeHtml(String(gameKey === 'billiards' ? 'Billiards' : 'Dominoes'))} • ${escapeHtml(String(battleRows.active.status || 'active'))}</div><button class="chipBtn" data-games-open-active="1">Open Match</button></div>` : '<div class="leaderboardEmpty">No active battle.</div>'}</section>
      <section class="gamesBattlePanel"><div class="gamesSectionHeader">Recent history</div><div class="gamesBattleList">${battleRows.history.length ? battleRows.history.map(renderBattleHistoryRow).join('') : '<div class="leaderboardEmpty">No recent battles yet.</div>'}</div></section>
    </div>`;
  }

  function dominoValueAtSide(tile, side) {
    const pair = Array.isArray(tile) ? tile : [];
    return Number(pair[side === 'right' ? 1 : 0] || 0);
  }

  function dominoesOpenEnds(board) {
    if (!Array.isArray(board) || !board.length) return null;
    return { left: dominoValueAtSide(board[0], 'left'), right: dominoValueAtSide(board[board.length - 1], 'right') };
  }

  function dominoesPlayableSides(tile, board) {
    const pair = Array.isArray(tile) ? tile : [];
    if (!board.length) return ['left', 'right'];
    const ends = dominoesOpenEnds(board);
    const values = [Number(pair[0] || 0), Number(pair[1] || 0)];
    const sides = [];
    if (values.includes(ends.left)) sides.push('left');
    if (values.includes(ends.right)) sides.push('right');
    return sides;
  }

  function orientDominoForSide(tile, board, side) {
    const pair = Array.isArray(tile) ? tile.slice(0, 2) : [0, 0];
    if (!board.length) return pair;
    const ends = dominoesOpenEnds(board);
    if (side === 'left') return Number(pair[1]) === ends.left ? pair : [pair[1], pair[0]];
    return Number(pair[0]) === ends.right ? pair : [pair[1], pair[0]];
  }

  function settleDominoesCpuTurn() {
    const state = gamesState.dominoes;
    if (state.over || state.turn !== 'cpu') return;
    const playable = state.cpuHand.map((tile, index) => ({ tile, index, sides: dominoesPlayableSides(tile, state.board) })).filter((entry) => entry.sides.length);
    if (!playable.length) {
      if (state.boneyard.length) {
        state.cpuHand.push(state.boneyard.shift());
        state.message = 'CPU drew a tile.';
        rerenderGamesPanel();
        window.setTimeout(settleDominoesCpuTurn, 320);
        return;
      }
      state.passStreak += 1;
      if (state.passStreak >= 2) {
        state.over = true;
        const playerPips = state.playerHand.flat().reduce((sum, value) => sum + Number(value || 0), 0);
        const cpuPips = state.cpuHand.flat().reduce((sum, value) => sum + Number(value || 0), 0);
        state.winner = playerPips <= cpuPips ? 'player' : 'cpu';
        state.message = state.winner === 'player' ? 'Blocked board. You win on lower pips.' : 'Blocked board. CPU wins on lower pips.';
      } else {
        state.turn = 'player';
        state.message = 'CPU passed. Your turn.';
      }
      rerenderGamesPanel();
      return;
    }
    const pick = playable[Math.floor(Math.random() * playable.length)];
    const side = pick.sides[Math.floor(Math.random() * pick.sides.length)];
    const oriented = orientDominoForSide(pick.tile, state.board, side);
    state.cpuHand.splice(pick.index, 1);
    if (side === 'left') state.board.unshift(oriented);
    else state.board.push(oriented);
    state.passStreak = 0;
    if (!state.cpuHand.length) {
      state.over = true;
      state.winner = 'cpu';
      state.message = 'CPU used every tile and won.';
    } else {
      state.turn = 'player';
      state.message = `CPU played ${oriented[0]}-${oriented[1]}. Your turn.`;
    }
    rerenderGamesPanel();
  }

  function renderDominoesCpu(host) {
    const state = gamesState.dominoes;
    const playable = state.playerHand.map((tile, index) => ({ tile, index, sides: dominoesPlayableSides(tile, state.board) }));
    host.innerHTML = `<div class="gamesBattleArena">
      <div class="gamesBattleTopline"><div class="gamesStatus">${escapeHtml(state.message)}</div><div class="gamesBattleMeta">CPU hand: ${escapeHtml(String(state.cpuHand.length))} • Boneyard: ${escapeHtml(String(state.boneyard.length))}</div></div>
      <div class="gamesDominoBoard">${state.board.length ? state.board.map((tile) => `<div class="gamesDominoBoardTile">${renderDominoesTile(tile)}</div>`).join('') : '<div class="leaderboardEmpty">Board waiting for first tile.</div>'}</div>
      <div class="gamesActionRow"><button id="gamesDominoCpuDrawBtn" class="chipBtn" ${state.over || state.turn !== 'player' || !state.boneyard.length ? 'disabled' : ''}>Draw</button><button id="gamesDominoCpuPassBtn" class="chipBtn" ${state.over || state.turn !== 'player' ? 'disabled' : ''}>Pass</button></div>
      <div class="gamesMiniLabel">Your hand</div>
      <div class="gamesDominoHand">${playable.map((entry) => `<div class="gamesDominoTileWrap">${renderDominoesTile(entry.tile, state.turn === 'player' && !state.over && entry.sides.length)}<div class="gamesDominoActions"><button class="chipBtn miniChip" ${entry.sides.includes('left') && state.turn === 'player' && !state.over ? `data-domino-cpu="${entry.index}" data-domino-side="left"` : 'disabled'}>Left</button><button class="chipBtn miniChip" ${entry.sides.includes('right') && state.turn === 'player' && !state.over ? `data-domino-cpu="${entry.index}" data-domino-side="right"` : 'disabled'}>Right</button></div></div>`).join('')}</div>
    </div>`;
    document.getElementById('gamesDominoCpuDrawBtn')?.addEventListener('click', () => {
      if (!state.boneyard.length || state.over || state.turn !== 'player') return;
      state.playerHand.push(state.boneyard.shift());
      state.message = 'You drew a tile.';
      rerenderGamesPanel();
    });
    document.getElementById('gamesDominoCpuPassBtn')?.addEventListener('click', () => {
      if (state.over || state.turn !== 'player') return;
      state.passStreak += 1;
      state.turn = 'cpu';
      state.message = 'You passed.';
      rerenderGamesPanel();
      window.setTimeout(settleDominoesCpuTurn, 320);
    });
    host.querySelectorAll('[data-domino-cpu]').forEach((btn) => btn.addEventListener('click', () => {
      const index = Number(btn.getAttribute('data-domino-cpu'));
      const side = btn.getAttribute('data-domino-side') || 'left';
      const tile = state.playerHand[index];
      if (!tile || state.over || state.turn !== 'player') return;
      const oriented = orientDominoForSide(tile, state.board, side);
      state.playerHand.splice(index, 1);
      if (side === 'left') state.board.unshift(oriented);
      else state.board.push(oriented);
      state.passStreak = 0;
      if (!state.playerHand.length) {
        state.over = true;
        state.winner = 'player';
        state.message = 'You win! Your hand is empty.';
      } else {
        state.turn = 'cpu';
        state.message = `You played ${oriented[0]}-${oriented[1]}. CPU thinking…`;
        rerenderGamesPanel();
        window.setTimeout(settleDominoesCpuTurn, 320);
        return;
      }
      rerenderGamesPanel();
    }));
  }

  function drawBilliardsPracticeCanvas(canvas) {
    drawBilliardsCanvas(canvas, { state: { balls: gamesState.billiards.balls }, current_turn_user_id: window?.me?.id || 1 });
  }

  function settleBilliardsCpuTurn() {
    const state = gamesState.billiards;
    if (state.over) return;
    const madeShot = Math.random() > 0.48;
    if (madeShot) state.cpuScore += 1;
    if (state.cpuScore >= state.targetScore) {
      state.over = true;
      state.message = 'Bot cleared the rack first.';
    } else {
      state.message = madeShot ? 'Bot sank one. Your turn.' : 'Bot missed. Your turn.';
    }
    rerenderGamesPanel();
  }

  function renderBilliardsCpu(host) {
    const state = gamesState.billiards;
    host.innerHTML = `<div class="gamesBattleArena">
      <div class="gamesBattleTopline"><div class="gamesStatus">${escapeHtml(state.message)}</div><div class="gamesBattleMeta">You ${escapeHtml(String(state.playerScore))} • Bot ${escapeHtml(String(state.cpuScore))}</div></div>
      <canvas id="gamesBilliardsCpuCanvas" class="gamesBilliardsCanvas" width="320" height="180"></canvas>
      <div class="gamesBilliardsControls">
        <label class="gamesControlLabel">Angle <input id="gamesBilliardsAngle" type="range" min="-314" max="314" step="1" value="${Math.round((gamesState.billiardsAim.angle || 0) * 100)}" ${state.over ? 'disabled' : ''}></label>
        <label class="gamesControlLabel">Power <input id="gamesBilliardsPower" type="range" min="10" max="100" step="1" value="${Math.round((gamesState.billiardsAim.power || 0.58) * 100)}" ${state.over ? 'disabled' : ''}></label>
        <button id="gamesBilliardsShotBtn" class="chipBtn" ${state.over ? 'disabled' : ''}>Take Shot</button>
      </div>
      <div class="gamesBattleMeta">First to ${escapeHtml(String(state.targetScore))} wins this quick practice race.</div>
    </div>`;
    const canvas = document.getElementById('gamesBilliardsCpuCanvas');
    drawBilliardsPracticeCanvas(canvas);
    document.getElementById('gamesBilliardsAngle')?.addEventListener('input', (e) => { gamesState.billiardsAim.angle = Number(e.target.value || 0) / 100; drawBilliardsPracticeCanvas(canvas); });
    document.getElementById('gamesBilliardsPower')?.addEventListener('input', (e) => { gamesState.billiardsAim.power = Math.max(0.1, Math.min(1, Number(e.target.value || 58) / 100)); drawBilliardsPracticeCanvas(canvas); });
    document.getElementById('gamesBilliardsShotBtn')?.addEventListener('click', () => {
      if (state.over) return;
      state.shotsTaken += 1;
      const madeShot = Math.random() < (0.18 + (gamesState.billiardsAim.power * 0.32));
      if (madeShot) state.playerScore += 1;
      if (state.playerScore >= state.targetScore) {
        state.over = true;
        state.message = 'You cleared the practice rack first.';
      } else {
        state.message = madeShot ? 'Nice shot. Bot turn…' : 'Missed shot. Bot turn…';
        rerenderGamesPanel();
        window.setTimeout(settleBilliardsCpuTurn, 420);
        return;
      }
      rerenderGamesPanel();
    });
  }

  function renderGamesVsDriver(host, gameKey) {
    host.innerHTML = renderBattleInboxStack(gameKey);
    document.getElementById('gamesChallengeSearch')?.addEventListener('input', (e) => {
      gamesState.challengeUsers.query = String(e.target.value || '');
      void loadChallengeableUsers({ query: gamesState.challengeUsers.query, gameKey, force: true });
    });
    host.querySelectorAll('[data-games-user]').forEach((btn) => btn.addEventListener('click', () => {
      const userId = Number(btn.getAttribute('data-games-user'));
      const row = (gamesState.challengeUsers.rows || []).find((item) => Number(item.user_id) === userId) || null;
      gamesState.challengeUsers.selected = row;
      gamesState.challengeComposer.targetUserId = String(userId || '');
      gamesState.challengeComposer.targetDisplayName = row?.display_name || '';
      gamesState.challengeComposer.gameType = gameKey;
      rerenderGamesPanel();
    }));
    document.getElementById('gamesSendChallengeBtn')?.addEventListener('click', (e) => {
      e.preventDefault();
      const selected = gamesState.challengeUsers.selected;
      if (!selected?.user_id) return;
      void createBattleChallenge(selected.user_id, gameKey);
    });
    host.querySelector('[data-games-open-active="1"]')?.addEventListener('click', (e) => {
      e.preventDefault();
      const match = battleRowsForGame(gameKey).active;
      if (match?.id) {
        loadActiveBattleMatch({ silent: true, preferredMatchId: match.id }).then(() => rerenderGamesPanel());
      }
    });
  }

  function gamesPanelHTML() {
    const activeTab = gamesState.activeTab || 'chess';
    const activeMode = activeGamesMode();
    const showModeSelector = activeTab === 'dominoes' || activeTab === 'billiards';
    return `
      <div class="panelBlock gamesPanelWrap">
        <div class="gamesTabs gamesModeTabs">
          <button id="gamesTabChess" class="chipBtn gamesTabBtn ${activeTab === 'chess' ? 'active' : ''}">Chess</button>
          <button id="gamesTabUno" class="chipBtn gamesTabBtn ${activeTab === 'uno' ? 'active' : ''}">UNO</button>
          <button id="gamesTabDominoes" class="chipBtn gamesTabBtn ${activeTab === 'dominoes' ? 'active' : ''}">Dominoes</button>
          <button id="gamesTabBilliards" class="chipBtn gamesTabBtn ${activeTab === 'billiards' ? 'active' : ''}">Billiards</button>
          <button id="gamesResetBtn" class="chipBtn">New Game</button>
        </div>
        ${showModeSelector ? `<div class="gamesTabs gamesBattleTabs">
          <button class="chipBtn gamesTabBtn ${activeMode === 'cpu' ? 'active' : ''}" data-games-mode="cpu">CPU</button>
          <button class="chipBtn gamesTabBtn ${activeMode === 'vs_driver' ? 'active' : ''}" data-games-mode="vs_driver">Vs Driver</button>
        </div>` : ''}
        <div class="gamesStatus ${gamesState.error ? 'err' : ''}">${escapeHtml(gamesState.status || '')}</div>
        <div id="gamesContent"></div>
      </div>
    `;
  }

  function wireGamesPanel() {
    document.getElementById('gamesTabChess')?.addEventListener('click', (e) => { e.preventDefault(); gamesState.activeTab = 'chess'; rerenderGamesPanel(); });
    document.getElementById('gamesTabUno')?.addEventListener('click', (e) => { e.preventDefault(); gamesState.activeTab = 'uno'; rerenderGamesPanel(); });
    document.getElementById('gamesTabDominoes')?.addEventListener('click', (e) => { e.preventDefault(); gamesState.activeTab = 'dominoes'; rerenderGamesPanel(); });
    document.getElementById('gamesTabBilliards')?.addEventListener('click', (e) => { e.preventDefault(); gamesState.activeTab = 'billiards'; rerenderGamesPanel(); });
    document.querySelectorAll('[data-games-mode]').forEach((btn) => btn.addEventListener('click', (e) => {
      e.preventDefault();
      setGamesTabMode(gamesState.activeTab, btn.getAttribute('data-games-mode') || 'cpu');
      rerenderGamesPanel();
    }));
    document.getElementById('gamesResetBtn')?.addEventListener('click', (e) => {
      e.preventDefault();
      if (gamesState.activeTab === 'chess') gamesState.chess = createInitialChessState();
      else if (gamesState.activeTab === 'uno') {
        gamesState.uno = createInitialUnoState();
        gamesState.unoWaitingColor = false;
      } else if (gamesState.activeTab === 'dominoes' && activeGamesMode() === 'cpu') {
        gamesState.dominoes = createInitialDominoesState();
      } else if (gamesState.activeTab === 'billiards' && activeGamesMode() === 'cpu') {
        gamesState.billiards = createInitialBilliardsPracticeState();
      } else {
        gamesState.challengeComposer = { targetUserId: '', targetDisplayName: '', gameType: gamesState.activeTab === 'billiards' ? 'billiards' : 'dominoes' };
        gamesState.challengeUsers.selected = null;
        setGamesStatus('Challenge composer reset.');
      }
      rerenderGamesPanel();
      if (gamesState.activeTab === 'uno') maybeRunUnoCpuTurn();
      if (activeGamesMode() === 'vs_driver') {
        void loadGamesBattleDashboard({ silent: true });
        void loadChallengeableUsers({ query: gamesState.challengeUsers.query || '', gameKey: gamesState.activeTab, force: true });
      }
    });
    renderGamesContent();
    if (activeGamesMode() === 'vs_driver') {
      scheduleGamesDashboardPoll();
      if (gamesState.dashboard?.activeMatch?.id || gamesState.activeMatch?.id) scheduleGamesMatchPoll();
    }
  }

  function rerenderGamesPanel() {
    if (!isGamesPanelOpen()) return;
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
      return;
    }
    if (gamesState.activeTab === 'uno') {
      renderUnoContent(host);
      return;
    }
    if (gamesState.activeTab === 'dominoes') {
      if (activeGamesMode() === 'cpu') renderDominoesCpu(host);
      else if (battleRowsForGame('dominoes').active) renderActiveBattle(host);
      else renderGamesVsDriver(host, 'dominoes');
    } else {
      if (activeGamesMode() === 'cpu') renderBilliardsCpu(host);
      else if (battleRowsForGame('billiards').active) renderActiveBattle(host);
      else renderGamesVsDriver(host, 'billiards');
    }
    host.querySelectorAll('[data-games-accept]').forEach((btn) => btn.addEventListener('click', (e) => { e.preventDefault(); void respondToChallenge(btn.getAttribute('data-games-accept'), 'accept'); }));
    host.querySelectorAll('[data-games-decline]').forEach((btn) => btn.addEventListener('click', (e) => { e.preventDefault(); void respondToChallenge(btn.getAttribute('data-games-decline'), 'decline'); }));
    host.querySelectorAll('[data-games-cancel]').forEach((btn) => btn.addEventListener('click', (e) => { e.preventDefault(); void respondToChallenge(btn.getAttribute('data-games-cancel'), 'cancel'); }));
  }

  function openGamesBattleComposer({ targetUserId = '', displayName = '', gameType = 'dominoes' } = {}) {
    const normalizedGame = gameType === 'billiards' ? 'billiards' : 'dominoes';
    gamesState.activeTab = normalizedGame;
    gamesState.activeModeByGame[normalizedGame] = 'vs_driver';
    gamesState.challengeComposer = {
      targetUserId: String(targetUserId || '').trim(),
      targetDisplayName: String(displayName || '').trim(),
      gameType: normalizedGame,
    };
    gamesState.challengeUsers.selected = targetUserId ? { user_id: Number(targetUserId), display_name: String(displayName || 'Driver') } : null;
    if (typeof openPanel === 'function') {
      openPanel('games', 'Games', gamesPanelHTML(), wireGamesPanel);
    } else {
      rerenderGamesPanel();
    }
    void loadGamesBattleDashboard({ silent: true });
    void loadChallengeableUsers({ query: '', gameKey: normalizedGame, force: true });
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

  /* =========================================================
   MOVED TO app.part6.js
   Dock Scroller helpers
   Search there for:
   - initDockScroller
   - updateDockScrollHints
   - scrollDockByStep
   ========================================================= */

  const driverProfileState = {
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
    dmInitialLoadComplete: false,
    pollTimer: null,
    error: "",
    status: "",
    sending: false
  };
  
  const recentOutgoingDmEchoes = new Map();
  let driverProfileLayoutBound = false;
  let driverProfileLayoutTimer50 = null;
  let driverProfileLayoutTimer180 = null;


  window.TlcGamesModule = { gamesPanelHTML, wireGamesPanel, isGamesPanelOpen, loadGamesBattleDashboard, loadActiveBattleMatch, openGamesBattleComposer };
  window.gamesPanelHTML = gamesPanelHTML;
  window.wireGamesPanel = wireGamesPanel;

  function bindDockGamesButtonOnce() {
    const gamesBtn = document.getElementById('dockGames');
    if (!gamesBtn || gamesBtn.dataset.tlcBoundGames === '1') return;
    if (typeof bindDockToggle !== 'function') return;
    gamesBtn.dataset.tlcBoundGames = '1';
    bindDockToggle(gamesBtn, 'games', 'Games', gamesPanelHTML, wireGamesPanel);
  }

  bindDockGamesButtonOnce();
  window.addEventListener('load', bindDockGamesButtonOnce);
  window.addEventListener('pageshow', bindDockGamesButtonOnce);
  window.addEventListener('focus', bindDockGamesButtonOnce);
  setTimeout(bindDockGamesButtonOnce, 0);
  setTimeout(bindDockGamesButtonOnce, 400);
  setTimeout(bindDockGamesButtonOnce, 1200);
})();
