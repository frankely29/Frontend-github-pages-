(function() {
  const HUB_KEY = 'games';
  const HUB_TITLE = 'Games';
  const TOP_TABS = [
    { key: 'games', label: 'Games' },
    { key: 'work-battles', label: 'Work Battles' },
  ];
  const GAME_TABS = [
    { key: 'chess', label: 'Chess' },
    { key: 'uno', label: 'UNO' },
  ];
  const CHESS_PIECE_SVGS = {
    P: '<path d="M50 22a10 10 0 1 1 0 20a10 10 0 0 1 0-20Zm0 23c-11 0-18 8-18 18h36c0-10-7-18-18-18Z"/>',
    N: '<path d="M34 69h34v-4H50l11-11-6-12-11-8-8 6 6 8-8 12v9Z"/><circle cx="54" cy="43" r="2.5" fill="currentColor"/>',
    B: '<path d="M50 22l7 7-7 7-7-7 7-7Zm0 17c-9 0-15 7-15 16h30c0-9-6-16-15-16Zm-18 27h36v5H32z"/>',
    R: '<path d="M35 27h6v8h6v-8h6v8h6v-8h6v13H35V27Zm3 15h24l-2 23H40l-2-23Zm-6 23h36v5H32z"/>',
    Q: '<path d="M35 33a4 4 0 1 1 0-8a4 4 0 0 1 0 8Zm15-3a4 4 0 1 1 0-8a4 4 0 0 1 0 8Zm15 3a4 4 0 1 1 0-8a4 4 0 0 1 0 8Z"/><path d="M33 36h34l-5 24H38l-5-24Zm-1 29h36v5H32z"/>',
    K: '<path d="M48 22h4v7h7v4h-7v7h-4v-7h-7v-4h7v-7Zm-14 20h32l-4 22H38l-4-22Zm-2 23h36v5H32z"/>',
  };
  const UNO_COLORS = ['red', 'yellow', 'green', 'blue'];
  const UNO_ACTIONS = ['skip', 'reverse', 'draw2'];

  const state = {
    activeTopTab: 'games',
    activeGame: 'chess',
    chess: createInitialChessState(),
    uno: createInitialUnoState(),
    unoWaitingColor: false,
    boundDockButton: null,
    pendingProfileTarget: null,
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function requestRerender() {
    if (!isOpen()) return;
    rerender();
  }

  function isOpen() {
    return window.getOpenPanelKey?.() === HUB_KEY;
  }

  function normalizeTopTab(value) {
    return value === 'work-battles' ? 'work-battles' : 'games';
  }

  function bodyEl() {
    return document.getElementById('dockDrawerBody');
  }

  function shellHtml() {
    const activeGame = state.activeGame === 'uno' ? 'uno' : 'chess';
    return `
      <div class="panelBlock gameHubWrap">
        <div class="gameHubTabs" role="tablist" aria-label="Games hub sections">
          ${TOP_TABS.map((tab) => `<button type="button" class="chipBtn${state.activeTopTab === tab.key ? ' active' : ''}" data-game-hub-tab="${escapeHtml(tab.key)}" role="tab" aria-selected="${state.activeTopTab === tab.key ? 'true' : 'false'}">${escapeHtml(tab.label)}</button>`).join('')}
        </div>
        <section class="gameHubSection${state.activeTopTab === 'games' ? ' active' : ''}" data-game-hub-section="games">
          <div class="gameHubGameTabs" role="tablist" aria-label="Games">
            ${GAME_TABS.map((tab) => `<button type="button" class="chipBtn${activeGame === tab.key ? ' active' : ''}" data-game-hub-game="${escapeHtml(tab.key)}" role="tab" aria-selected="${activeGame === tab.key ? 'true' : 'false'}">${escapeHtml(tab.label)}</button>`).join('')}
            <button type="button" class="chipBtn" id="gameHubResetBtn">New Game / Reset</button>
          </div>
          <div class="gameHubStatus">Play Chess vs CPU or UNO vs CPU.</div>
          <div id="gameHubGamesContent" class="gameHubContent"></div>
        </section>
        <section class="gameHubSection${state.activeTopTab === 'work-battles' ? ' active' : ''}" data-game-hub-section="work-battles">
          <div class="gameHubStatus">Challenge a driver and manage work battles here.</div>
          <div id="gameHubWorkBattlesMount" class="gameHubContent gameHubEmbeddedWorkBattles"></div>
        </section>
      </div>
    `;
  }

  function bindShellEvents(root) {
    root.querySelectorAll('[data-game-hub-tab]').forEach((btn) => btn.addEventListener('click', (event) => {
      event.preventDefault();
      state.activeTopTab = normalizeTopTab(btn.getAttribute('data-game-hub-tab'));
      rerender();
    }));
    root.querySelectorAll('[data-game-hub-game]').forEach((btn) => btn.addEventListener('click', (event) => {
      event.preventDefault();
      state.activeGame = btn.getAttribute('data-game-hub-game') === 'uno' ? 'uno' : 'chess';
      rerender();
    }));
    root.querySelector('#gameHubResetBtn')?.addEventListener('click', (event) => {
      event.preventDefault();
      if (state.activeGame === 'uno') {
        state.uno = createInitialUnoState();
        state.unoWaitingColor = false;
        maybeRunUnoCpuTurn();
      } else {
        state.chess = createInitialChessState();
      }
      rerender();
    });
  }

  function renderGamesPane() {
    const host = document.getElementById('gameHubGamesContent');
    if (!host) return;
    if (state.activeGame === 'uno') renderUnoContent(host);
    else renderChessContent(host);
  }

  function renderWorkBattlesPane() {
    const host = document.getElementById('gameHubWorkBattlesMount');
    if (!host) return;
    const profileTarget = state.pendingProfileTarget || window.WorkBattlesUI?.getPendingProfileTarget?.() || null;
    state.pendingProfileTarget = null;
    if (window.WorkBattlesUI?.mount) {
      window.WorkBattlesUI.mount(host, profileTarget ? { profileTarget } : {});
      if (profileTarget) {
        window.WorkBattlesUI?.clearPendingProfileTarget?.();
      }
    } else {
      host.innerHTML = '<div class="gameHubStatus">Work Battles is unavailable right now.</div>';
    }
  }

  function rerender() {
    if (!isOpen()) return;
    const body = bodyEl();
    if (!body) return;
    body.innerHTML = shellHtml();
    bindShellEvents(body);
    if (state.activeTopTab === 'work-battles') renderWorkBattlesPane();
    else renderGamesPane();
  }

  function open({ initialTab = 'games', profileTarget = null } = {}) {
    state.activeTopTab = normalizeTopTab(initialTab);
    if (profileTarget && typeof profileTarget === 'object') {
      state.pendingProfileTarget = profileTarget;
    }
    window.openDrawer?.(HUB_KEY, HUB_TITLE, shellHtml());
    rerender();
  }

  function bindDockButton(buttonEl) {
    if (!buttonEl) return false;
    if (state.boundDockButton && state.boundDockButton !== buttonEl && state.boundDockButton.__gameHubClickHandler) {
      state.boundDockButton.removeEventListener('click', state.boundDockButton.__gameHubClickHandler);
      delete state.boundDockButton.__gameHubClickHandler;
    }
    if (state.boundDockButton && state.boundDockButton !== buttonEl && state.boundDockButton.__gameHubPointerHandler) {
      state.boundDockButton.removeEventListener('pointerdown', state.boundDockButton.__gameHubPointerHandler);
      delete state.boundDockButton.__gameHubPointerHandler;
    }
    if (!buttonEl.__gameHubPointerHandler) {
      buttonEl.__gameHubPointerHandler = (event) => event.stopPropagation();
      buttonEl.addEventListener('pointerdown', buttonEl.__gameHubPointerHandler);
    }
    if (!buttonEl.__gameHubClickHandler) {
      buttonEl.__gameHubClickHandler = (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (isOpen()) {
          window.closeDrawer?.();
          return;
        }
        open({ initialTab: 'games' });
      };
      buttonEl.addEventListener('click', buttonEl.__gameHubClickHandler);
    }
    state.boundDockButton = buttonEl;
    buttonEl.dataset.gameHubBound = '1';
    buttonEl.dataset.gamesDockBound = '1';
    return true;
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
        ['bR', 'bN', 'bB', 'bQ', 'bK', 'bB', 'bN', 'bR'],
        ['bP', 'bP', 'bP', 'bP', 'bP', 'bP', 'bP', 'bP'],
        [null, null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null, null],
        ['wP', 'wP', 'wP', 'wP', 'wP', 'wP', 'wP', 'wP'],
        ['wR', 'wN', 'wB', 'wQ', 'wK', 'wB', 'wN', 'wR'],
      ],
      turn: 'w',
      selected: null,
      legalTargets: [],
      over: false,
      message: 'Your turn (White)',
    };
  }

  function renderChessContent(host) {
    const s = state.chess;
    const legalSet = new Set(s.legalTargets.map((move) => `${move.r},${move.c}`));
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
    const s = state.chess;
    if (s.over || s.turn !== 'w') return;
    const piece = s.board[r][c];
    if (s.selected) {
      const target = s.legalTargets.find((move) => move.r === r && move.c === c);
      if (target) {
        applyChessMove(s, target);
        s.selected = null;
        s.legalTargets = [];
        updateChessStatus();
        requestRerender();
        if (!s.over && s.turn === 'b') window.setTimeout(runChessCpuTurn, 240);
        return;
      }
    }
    if (piece && piece[0] === 'w') {
      s.selected = { r, c };
      s.legalTargets = legalChessMovesForPiece(s, r, c);
    } else {
      s.selected = null;
      s.legalTargets = [];
    }
    requestRerender();
  }

  function runChessCpuTurn() {
    const s = state.chess;
    if (s.over || s.turn !== 'b') return;
    const moves = legalChessMoves(s, 'b');
    if (!moves.length) {
      updateChessStatus();
      requestRerender();
      return;
    }
    let best = [];
    let bestScore = -1e9;
    for (const move of moves) {
      let score = 0;
      if (move.capture) score += pieceValue(move.capture) * 10 - pieceValue(move.piece);
      if (move.promotion) score += 8;
      score += Math.random() * 0.2;
      if (score > bestScore) {
        bestScore = score;
        best = [move];
      } else if (Math.abs(score - bestScore) < 0.001) {
        best.push(move);
      }
    }
    const pick = best[Math.floor(Math.random() * best.length)] || moves[0];
    applyChessMove(s, pick);
    updateChessStatus();
    requestRerender();
  }

  function pieceValue(piece) {
    if (!piece) return 0;
    const type = piece[1];
    if (type === 'P') return 1;
    if (type === 'N' || type === 'B') return 3;
    if (type === 'R') return 5;
    if (type === 'Q') return 9;
    if (type === 'K') return 100;
    return 0;
  }

  function inBounds(r, c) {
    return r >= 0 && r < 8 && c >= 0 && c < 8;
  }

  function cloneBoard(board) {
    return board.map((row) => row.slice());
  }

  function applyChessMove(currentState, move) {
    const board = currentState.board;
    const piece = board[move.from.r][move.from.c];
    board[move.from.r][move.from.c] = null;
    board[move.r][move.c] = move.promotion ? `${piece[0]}Q` : piece;
    currentState.turn = currentState.turn === 'w' ? 'b' : 'w';
  }

  function legalChessMovesForPiece(currentState, r, c) {
    const piece = currentState.board[r][c];
    if (!piece) return [];
    const all = legalChessMoves(currentState, piece[0]);
    return all.filter((move) => move.from.r === r && move.from.c === c);
  }

  function legalChessMoves(currentState, color) {
    const raw = [];
    for (let r = 0; r < 8; r += 1) {
      for (let c = 0; c < 8; c += 1) {
        const piece = currentState.board[r][c];
        if (!piece || piece[0] !== color) continue;
        raw.push(...pieceMoves(currentState.board, r, c, piece));
      }
    }
    return raw.filter((move) => {
      const board = cloneBoard(currentState.board);
      const piece = board[move.from.r][move.from.c];
      board[move.from.r][move.from.c] = null;
      board[move.r][move.c] = move.promotion ? `${piece[0]}Q` : piece;
      return !isKingInCheck(board, color);
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
        const target = board[nr][nc];
        if (target && target[0] === enemy) push(nr, nc, { promotion: nr === promoRow });
      }
      return out;
    }

    if (type === 'N') {
      [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]].forEach(([dr, dc]) => push(r + dr, c + dc));
      return out;
    }

    if (type === 'K') {
      for (let dr = -1; dr <= 1; dr += 1) for (let dc = -1; dc <= 1; dc += 1) if (dr || dc) push(r + dr, c + dc);
      return out;
    }

    const dirs = type === 'B'
      ? [[1, 1], [1, -1], [-1, 1], [-1, -1]]
      : type === 'R'
        ? [[1, 0], [-1, 0], [0, 1], [0, -1]]
        : [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dr, dc] of dirs) {
      let nr = r + dr;
      let nc = c + dc;
      while (inBounds(nr, nc)) {
        const target = board[nr][nc];
        if (!target) {
          out.push({ from: { r, c }, r: nr, c: nc, piece, capture: null, promotion: false });
        } else {
          if (target[0] !== color) out.push({ from: { r, c }, r: nr, c: nc, piece, capture: target, promotion: false });
          break;
        }
        nr += dr;
        nc += dc;
      }
    }
    return out;
  }

  function isKingInCheck(board, color) {
    let kingRow = -1;
    let kingCol = -1;
    for (let r = 0; r < 8; r += 1) {
      for (let c = 0; c < 8; c += 1) {
        if (board[r][c] === `${color}K`) {
          kingRow = r;
          kingCol = c;
        }
      }
    }
    if (kingRow < 0) return true;
    const enemy = color === 'w' ? 'b' : 'w';
    for (let r = 0; r < 8; r += 1) {
      for (let c = 0; c < 8; c += 1) {
        const piece = board[r][c];
        if (!piece || piece[0] !== enemy) continue;
        const moves = pieceMoves(board, r, c, piece);
        if (moves.some((move) => move.r === kingRow && move.c === kingCol)) return true;
      }
    }
    return false;
  }

  function updateChessStatus() {
    const s = state.chess;
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
      const temp = deck[i];
      deck[i] = deck[j];
      deck[j] = temp;
    }
    return deck;
  }

  function createInitialUnoState() {
    const deck = createUnoDeck();
    const player = [];
    const cpu = [];
    for (let i = 0; i < 7; i += 1) {
      player.push(deck.pop());
      cpu.push(deck.pop());
    }
    let first = deck.pop();
    while (first && first.color === 'wild') {
      deck.unshift(first);
      first = deck.pop();
    }
    return {
      player,
      cpu,
      draw: deck,
      discard: [first],
      turn: 'player',
      currentColor: first?.color || 'red',
      over: false,
      message: 'Your turn',
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

  function ensureUnoDraw(currentState) {
    if (currentState.draw.length) return;
    if (currentState.discard.length <= 1) return;
    const top = currentState.discard.pop();
    currentState.draw = currentState.discard;
    currentState.discard = [top];
    for (let i = currentState.draw.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const temp = currentState.draw[i];
      currentState.draw[i] = currentState.draw[j];
      currentState.draw[j] = temp;
    }
  }

  function drawUnoCard(currentState, hand) {
    ensureUnoDraw(currentState);
    if (!currentState.draw.length) return null;
    const card = currentState.draw.pop();
    hand.push(card);
    return card;
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
    const s = state.uno;
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
              <button id="unoDrawBtn" class="gamesUnoCard mini wild" ${s.over || s.turn !== 'player' || state.unoWaitingColor ? 'disabled' : ''}><span class="gamesUnoBackTag"><span class="gamesUnoBadge" aria-hidden="true"></span><span>Draw</span></span></button>
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
        const playable = !s.over && s.turn === 'player' && !state.unoWaitingColor && isUnoPlayable(card, top, s.currentColor);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `gamesUnoCard ${card.color} ${playable ? '' : 'unplayable'}`;
        btn.innerHTML = unoCardFaceMarkup(card);
        btn.disabled = !playable;
        btn.addEventListener('click', () => onUnoPlayerPlay(idx));
        handEl.appendChild(btn);
      });
    }
    document.getElementById('unoDrawBtn')?.addEventListener('click', (event) => {
      event.preventDefault();
      if (s.over || s.turn !== 'player' || state.unoWaitingColor) return;
      const drawn = drawUnoCard(s, s.player);
      if (drawn && isUnoPlayable(drawn, top, s.currentColor)) {
        s.message = 'You drew a playable card.';
      } else {
        s.turn = 'cpu';
        s.message = 'CPU turn';
        requestRerender();
        window.setTimeout(maybeRunUnoCpuTurn, 420);
      }
      requestRerender();
    });
    renderUnoColorPicker();
  }

  function renderUnoColorPicker() {
    const holder = document.getElementById('unoColorPick');
    if (!holder) return;
    if (!state.unoWaitingColor) {
      holder.innerHTML = '';
      return;
    }
    holder.innerHTML = '<div class="gamesMiniLabel" style="width:100%;">Choose color:</div>';
    UNO_COLORS.forEach((color) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `gamesUnoCard mini ${color}`;
      btn.textContent = color[0].toUpperCase();
      btn.addEventListener('click', () => {
        const s = state.uno;
        s.currentColor = color;
        state.unoWaitingColor = false;
        finalizeUnoTurnAfterCard();
      });
      holder.appendChild(btn);
    });
  }

  function onUnoPlayerPlay(index) {
    const s = state.uno;
    if (s.over || s.turn !== 'player') return;
    const top = s.discard[s.discard.length - 1];
    const card = s.player[index];
    if (!isUnoPlayable(card, top, s.currentColor)) return;
    s.player.splice(index, 1);
    s.discard.push(card);
    if (card.color !== 'wild') s.currentColor = card.color;
    if (s.player.length === 0) {
      s.over = true;
      s.message = 'You win!';
      requestRerender();
      return;
    }
    if (card.color === 'wild') {
      state.unoWaitingColor = true;
      requestRerender();
      return;
    }
    finalizeUnoTurnAfterCard();
  }

  function finalizeUnoTurnAfterCard() {
    const s = state.uno;
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
      requestRerender();
      return;
    }
    s.turn = 'cpu';
    s.message = 'CPU turn';
    requestRerender();
    window.setTimeout(maybeRunUnoCpuTurn, 420);
  }

  function maybeRunUnoCpuTurn() {
    const s = state.uno;
    if (s.over || s.turn !== 'cpu') return;
    const top = s.discard[s.discard.length - 1];
    let idx = s.cpu.findIndex((card) => isUnoPlayable(card, top, s.currentColor));
    if (idx < 0) {
      drawUnoCard(s, s.cpu);
      idx = s.cpu.findIndex((card) => isUnoPlayable(card, top, s.currentColor));
      if (idx < 0) {
        s.turn = 'player';
        s.message = 'Your turn';
        requestRerender();
        return;
      }
    }
    const card = s.cpu.splice(idx, 1)[0];
    s.discard.push(card);
    if (card.color === 'wild') {
      const counts = { red: 0, yellow: 0, green: 0, blue: 0 };
      s.cpu.forEach((cpuCard) => { if (counts[cpuCard.color] != null) counts[cpuCard.color] += 1; });
      s.currentColor = UNO_COLORS.sort((a, b) => counts[b] - counts[a])[0] || 'red';
    } else {
      s.currentColor = card.color;
    }
    if (s.cpu.length === 0) {
      s.over = true;
      s.message = 'CPU wins.';
      requestRerender();
      return;
    }
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
      requestRerender();
      window.setTimeout(maybeRunUnoCpuTurn, 420);
      return;
    }
    s.turn = 'player';
    s.message = 'Your turn';
    requestRerender();
  }

  window.GameHubUI = {
    bindDockButton,
    open,
    rerender,
  };

  try {
    window.initCommunityDockBindings?.();
  } catch (error) {
    console.warn('GameHub dock bootstrap retry failed', error);
  }
})();
