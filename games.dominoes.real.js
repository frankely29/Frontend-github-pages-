(function () {
  function cloneTile(tile) {
    return Array.isArray(tile) ? [Number(tile[0] || 0), Number(tile[1] || 0)] : [0, 0];
  }

  function createDeck() {
    const tiles = [];
    for (let left = 0; left <= 6; left += 1) {
      for (let right = left; right <= 6; right += 1) tiles.push([left, right]);
    }
    for (let i = tiles.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = tiles[i];
      tiles[i] = tiles[j];
      tiles[j] = tmp;
    }
    return tiles;
  }

  function tilePipTotal(tile) {
    const pair = cloneTile(tile);
    return pair[0] + pair[1];
  }

  function tileMatchesEnd(tile, value) {
    const pair = cloneTile(tile);
    return pair[0] === value || pair[1] === value;
  }

  function orientedTileForSide(tile, board, side) {
    const pair = cloneTile(tile);
    if (!Array.isArray(board) || !board.length) return pair;
    const leftEnd = Number(board[0]?.[0] || 0);
    const rightEnd = Number(board[board.length - 1]?.[1] || 0);
    if (side === 'left') {
      if (pair[1] === leftEnd) return pair;
      if (pair[0] === leftEnd) return [pair[1], pair[0]];
      return null;
    }
    if (pair[0] === rightEnd) return pair;
    if (pair[1] === rightEnd) return [pair[1], pair[0]];
    return null;
  }

  function getOpenEnds(board) {
    if (!Array.isArray(board) || !board.length) return null;
    return { left: Number(board[0]?.[0] || 0), right: Number(board[board.length - 1]?.[1] || 0) };
  }

  function playableSides(tile, board) {
    if (!Array.isArray(board) || !board.length) return ['left', 'right'];
    const ends = getOpenEnds(board);
    const sides = [];
    if (tileMatchesEnd(tile, ends.left)) sides.push('left');
    if (tileMatchesEnd(tile, ends.right)) sides.push('right');
    return sides;
  }

  function createCpuMatch() {
    const deck = createDeck();
    const playerHand = deck.splice(0, 7);
    const cpuHand = deck.splice(0, 7);
    return {
      board: [],
      playerHand,
      cpuHand,
      boneyard: deck,
      turn: 'player',
      passStreak: 0,
      over: false,
      winner: '',
      resultSummary: '',
      message: 'Your turn. Place a legal tile or draw from the boneyard.',
      history: [{ actor: 'system', text: 'Match ready.' }],
    };
  }

  function summarizeBlockedGame(state) {
    const playerScore = (state.playerHand || []).reduce((sum, tile) => sum + tilePipTotal(tile), 0);
    const cpuScore = (state.cpuHand || []).reduce((sum, tile) => sum + tilePipTotal(tile), 0);
    if (playerScore < cpuScore) return { winner: 'player', text: `Blocked game. You win ${cpuScore - playerScore} points.` };
    if (cpuScore < playerScore) return { winner: 'cpu', text: `Blocked game. CPU wins ${playerScore - cpuScore} points.` };
    return { winner: 'draw', text: 'Blocked game ends in a draw.' };
  }

  function finishMatch(state, winner, text) {
    state.over = true;
    state.winner = winner;
    state.resultSummary = String(text || 'Match complete.');
    state.message = state.resultSummary;
    state.history.push({ actor: 'system', text: state.resultSummary });
    return state;
  }

  function selectCpuMove(state) {
    const options = [];
    (state.cpuHand || []).forEach((tile, index) => {
      playableSides(tile, state.board).forEach((side) => {
        options.push({ index, tile, side, score: tilePipTotal(tile) + (tile[0] === tile[1] ? 2.5 : 0) + (side === 'left' ? 0.1 : 0) });
      });
    });
    options.sort((a, b) => b.score - a.score);
    return options[0] || null;
  }

  function applyPlacement(state, actor, handKey, index, side) {
    if (state.over) return { ok: false, reason: 'match-complete' };
    const hand = Array.isArray(state[handKey]) ? state[handKey] : [];
    const tile = hand[index];
    if (!tile) return { ok: false, reason: 'tile-missing' };
    const oriented = orientedTileForSide(tile, state.board, side);
    if (!oriented) return { ok: false, reason: 'illegal-side' };
    hand.splice(index, 1);
    if (!state.board.length) state.board.push(oriented);
    else if (side === 'left') state.board.unshift(oriented);
    else state.board.push(oriented);
    state.passStreak = 0;
    state.history.push({ actor, text: `${actor === 'player' ? 'You' : 'CPU'} played ${oriented[0]}-${oriented[1]} on the ${side}.` });
    if (!hand.length) {
      return { ok: true, state: finishMatch(state, actor, `${actor === 'player' ? 'You' : 'CPU'} dominoed and won the match.`) };
    }
    state.turn = actor === 'player' ? 'cpu' : 'player';
    state.message = actor === 'player' ? 'CPU is thinking…' : 'Your turn.';
    return { ok: true, state };
  }

  function drawForActor(state, actor) {
    const handKey = actor === 'player' ? 'playerHand' : 'cpuHand';
    const hand = Array.isArray(state[handKey]) ? state[handKey] : [];
    if (!Array.isArray(state.boneyard) || !state.boneyard.length) return null;
    const tile = state.boneyard.shift();
    hand.push(tile);
    state.history.push({ actor, text: `${actor === 'player' ? 'You' : 'CPU'} drew a tile.` });
    return tile;
  }

  function playerDraw(state) {
    if (state.over || state.turn !== 'player') return { ok: false, reason: 'not-your-turn' };
    const tile = drawForActor(state, 'player');
    if (!tile) {
      state.message = 'No tiles left to draw. Pass if you have no legal move.';
      return { ok: false, reason: 'empty-boneyard' };
    }
    state.message = playableSides(tile, state.board).length
      ? 'You drew a playable tile.'
      : 'Tile drawn. Play if legal or pass when blocked.';
    return { ok: true, tile };
  }

  function playerPass(state) {
    if (state.over || state.turn !== 'player') return { ok: false, reason: 'not-your-turn' };
    const hasMove = (state.playerHand || []).some((tile) => playableSides(tile, state.board).length);
    if (hasMove || (state.boneyard || []).length) return { ok: false, reason: 'pass-not-allowed' };
    state.passStreak += 1;
    state.history.push({ actor: 'player', text: 'You passed.' });
    if (state.passStreak >= 2) {
      const blocked = summarizeBlockedGame(state);
      finishMatch(state, blocked.winner, blocked.text);
      return { ok: true, state };
    }
    state.turn = 'cpu';
    state.message = 'CPU is thinking…';
    return { ok: true, state };
  }

  function runCpuTurn(state) {
    if (state.over || state.turn !== 'cpu') return state;
    let guard = 0;
    while (guard < 64) {
      guard += 1;
      const move = selectCpuMove(state);
      if (move) {
        applyPlacement(state, 'cpu', 'cpuHand', move.index, move.side);
        return state;
      }
      const drawn = drawForActor(state, 'cpu');
      if (!drawn) break;
      if (playableSides(drawn, state.board).length) continue;
    }
    state.passStreak += 1;
    state.history.push({ actor: 'cpu', text: 'CPU passed.' });
    if (state.passStreak >= 2) {
      const blocked = summarizeBlockedGame(state);
      finishMatch(state, blocked.winner, blocked.text);
      return state;
    }
    state.turn = 'player';
    state.message = 'CPU passed. Your turn.';
    return state;
  }

  window.RealDominoesUI = {
    createCpuMatch,
    playableSides,
    applyPlacement,
    playerDraw,
    playerPass,
    runCpuTurn,
  };
})();
