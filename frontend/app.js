// Super Tic-Tac-Toe Frontend Client

class SuperTicTacToe {
  constructor() {
    this.gameId = null;
    this.ws = null;
    this.currentState = null;
    this.playerId = this.getOrCreatePlayerId();

    this.initializeBoard();
    this.attachEventListeners();
  }

  getOrCreatePlayerId() {
    let id = localStorage.getItem('player_id');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('player_id', id);
    }
    return id;
  }

  initializeBoard() {
    const boardContainer = document.getElementById('game-board');
    boardContainer.innerHTML = '';

    for (let board = 0; board < 9; board++) {
      const smallBoard = document.createElement('div');
      smallBoard.className = 'small-board';
      smallBoard.dataset.board = board;

      for (let cell = 0; cell < 9; cell++) {
        const cellDiv = document.createElement('div');
        cellDiv.className = 'cell';
        cellDiv.dataset.board = board;
        cellDiv.dataset.cell = cell;
        cellDiv.addEventListener('click', () => this.handleCellClick(board, cell));
        smallBoard.appendChild(cellDiv);
      }

      // Add overlay for won boards
      const overlay = document.createElement('div');
      overlay.className = 'board-overlay';
      smallBoard.appendChild(overlay);

      boardContainer.appendChild(smallBoard);
    }
  }

  attachEventListeners() {
    document.getElementById('new-game-btn').addEventListener('click', () => {
      this.createNewGame();
    });
  }

  async createNewGame() {
    try {
      const response = await fetch('/api/games', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          X_identity: this.playerId,
          O_identity: 'bot-random',
          source: 'websocket'
        })
      });

      const game = await response.json();
      this.gameId = game.id;
      this.connectWebSocket(game.id);
      this.updateGameInfo(game);
    } catch (error) {
      console.error('Failed to create game:', error);
      this.updateStatus('Error creating game');
    }
  }

  connectWebSocket(gameId) {
    if (this.ws) {
      this.ws.close();
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/games/${gameId}/ws`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('WebSocket connected');
      this.updateStatus('Connected');
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'state') {
        this.handleStateUpdate(data.game);
      } else if (data.type === 'error') {
        console.error('Server error:', data.message);
        this.updateStatus(`Error: ${data.message}`);
      }
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      this.updateStatus('Connection error');
    };

    this.ws.onclose = () => {
      console.log('WebSocket closed');
      this.updateStatus('Disconnected');
    };
  }

  handleStateUpdate(game) {
    this.currentState = game;
    this.renderBoard(game.moves);
    this.updateGameInfo(game);

    if (game.status !== 'incomplete') {
      this.updateStatus(`Game Over: ${game.status === 'draw' ? 'Draw!' : game.status + ' wins!'}`);
    } else {
      this.updateStatus(`Turn: ${game.nextToMove}`);
    }
  }

  renderBoard(moves) {
    // Clear all cells
    document.querySelectorAll('.cell').forEach(cell => {
      cell.textContent = '';
      cell.classList.remove('X', 'O', 'occupied', 'legal');
    });

    document.querySelectorAll('.small-board').forEach(board => {
      board.classList.remove('active', 'won-X', 'won-O', 'full', 'playable');
    });

    // Replay moves
    const state = this.reconstructState(moves);

    // Render cell states
    for (let board = 0; board < 9; board++) {
      for (let cell = 0; cell < 9; cell++) {
        const cellDiv = document.querySelector(`[data-board="${board}"][data-cell="${cell}"]`);
        const bitMask = 1 << cell;

        if (state.smallBoardsX[board] & bitMask) {
          cellDiv.textContent = 'X';
          cellDiv.classList.add('X', 'occupied');
        } else if (state.smallBoardsO[board] & bitMask) {
          cellDiv.textContent = 'O';
          cellDiv.classList.add('O', 'occupied');
        }
      }

      // Mark won boards
      const smallBoardEl = document.querySelector(`.small-board[data-board="${board}"]`);
      const overlay = smallBoardEl.querySelector('.board-overlay');

      if (state.metaBoardX & (1 << board)) {
        smallBoardEl.classList.add('won-X');
        overlay.textContent = 'X';
        overlay.classList.add('show', 'X');
      } else if (state.metaBoardO & (1 << board)) {
        smallBoardEl.classList.add('won-O');
        overlay.textContent = 'O';
        overlay.classList.add('show', 'O');
      } else if (state.metaBoardFull & (1 << board)) {
        smallBoardEl.classList.add('full');
      } else {
        overlay.textContent = '';
        overlay.classList.remove('show', 'X', 'O');
      }
    }

    // Highlight legal moves and active boards
    if (this.currentState && this.currentState.status === 'incomplete') {
      // Determine which boards are playable
      let playableBoards = [];
      if (state.nextBoard === -1) {
        // Can play on any non-won board
        playableBoards = [0, 1, 2, 3, 4, 5, 6, 7, 8];
      } else {
        // Check if nextBoard is playable
        const nextBoardWon = (state.metaBoardX | state.metaBoardO | state.metaBoardFull) & (1 << state.nextBoard);
        if (nextBoardWon) {
          // Next board is won, can play anywhere
          playableBoards = [0, 1, 2, 3, 4, 5, 6, 7, 8];
        } else {
          // Must play on nextBoard
          playableBoards = [state.nextBoard];
        }
      }

      // Mark playable boards and legal cells
      for (const boardIdx of playableBoards) {
        const boardAlreadyWon = (state.metaBoardX | state.metaBoardO | state.metaBoardFull) & (1 << boardIdx);
        if (boardAlreadyWon) continue;

        const boardEl = document.querySelector(`.small-board[data-board="${boardIdx}"]`);
        boardEl.classList.add('playable');

        // Mark individual legal cells
        for (let cellIdx = 0; cellIdx < 9; cellIdx++) {
          if (this.isLegalMove(state, boardIdx, cellIdx)) {
            const cellEl = document.querySelector(`[data-board="${boardIdx}"][data-cell="${cellIdx}"]`);
            cellEl.classList.add('legal');
          }
        }
      }

      // Highlight the primary active board (when directed to specific board)
      if (playableBoards.length === 1) {
        document.querySelector(`.small-board[data-board="${playableBoards[0]}"]`).classList.add('active');
      }
    }
  }

  reconstructState(moves) {
    const state = {
      smallBoardsX: Array(9).fill(0),
      smallBoardsO: Array(9).fill(0),
      metaBoardX: 0,
      metaBoardO: 0,
      metaBoardFull: 0,
      nextBoard: -1
    };

    for (let i = 0; i < moves.length; i += 2) {
      const board = moves[i];
      const cell = moves[i + 1];
      const player = (i / 2) % 2 === 0 ? 'X' : 'O';

      const bitPosition = 1 << cell;
      if (player === 'X') {
        state.smallBoardsX[board] |= bitPosition;
      } else {
        state.smallBoardsO[board] |= bitPosition;
      }

      // Simplified win checking (client-side)
      this.checkSmallBoardWin(state, board);

      state.nextBoard = cell;
    }

    return state;
  }

  checkSmallBoardWin(state, boardIndex) {
    const WIN_PATTERNS = [
      0b111000000, 0b000111000, 0b000000111,
      0b100100100, 0b010010010, 0b001001001,
      0b100010001, 0b001010100
    ];

    const xBits = state.smallBoardsX[boardIndex];
    const oBits = state.smallBoardsO[boardIndex];

    for (const pattern of WIN_PATTERNS) {
      if ((xBits & pattern) === pattern) {
        state.metaBoardX |= (1 << boardIndex);
        return;
      }
      if ((oBits & pattern) === pattern) {
        state.metaBoardO |= (1 << boardIndex);
        return;
      }
    }

    if ((xBits | oBits) === 0b111111111) {
      state.metaBoardFull |= (1 << boardIndex);
    }
  }

  handleCellClick(board, cell) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.updateStatus('Not connected');
      return;
    }

    if (!this.currentState || this.currentState.status !== 'incomplete') {
      this.updateStatus('Game is over');
      return;
    }

    // Reconstruct current state to validate move
    const state = this.reconstructState(this.currentState.moves);

    // Validate move client-side before sending
    if (!this.isLegalMove(state, board, cell)) {
      console.log('Illegal move attempted:', { board, cell, state });
      return; // Silently ignore illegal moves
    }

    // Send move to server
    this.ws.send(JSON.stringify({
      type: 'move',
      board,
      cell
    }));
  }

  isLegalMove(state, board, cell) {
    // Cannot play on a board that's already won or full
    const boardAlreadyWon = (state.metaBoardX | state.metaBoardO | state.metaBoardFull) & (1 << board);
    if (boardAlreadyWon) return false;

    // Must play on correct board (or any if nextBoard is won/full)
    const nextBoardValid = state.nextBoard === -1 || state.nextBoard === board;
    if (!nextBoardValid) {
      const nextBoardWon = (state.metaBoardX | state.metaBoardO | state.metaBoardFull) & (1 << state.nextBoard);
      if (!nextBoardWon) return false;
    }

    // Cell must be empty
    const cellMask = 1 << cell;
    const cellOccupied = (state.smallBoardsX[board] | state.smallBoardsO[board]) & cellMask;

    return !cellOccupied;
  }

  updateGameInfo(game) {
    document.getElementById('game-id').textContent = game.id.slice(0, 8);
    document.getElementById('next-player').textContent = game.nextToMove;
    document.getElementById('game-status').textContent = game.status;
  }

  updateStatus(message) {
    document.getElementById('status').textContent = message;
  }
}

// Initialize the game when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new SuperTicTacToe();
  });
} else {
  new SuperTicTacToe();
}
