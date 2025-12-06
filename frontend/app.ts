// Super Tic-Tac-Toe Frontend Client

import {
  getStateFromHistory,
  isLegalMove,
  WIN_PATTERNS
} from '../src/game-logic';
import type { GameState, Game, Player, BoardIndex, CellIndex } from '../src/types/game.types';
import { wsMessageSchema, type MoveMessage } from '../src/types/websocket.types';

class SuperTicTacToe {
  private gameId: string | null = null;
  private ws: WebSocket | null = null;
  private currentState: Game | null = null;
  private playerId: string;
  private selectedGameType: 'bot' | 'human' | null = null;
  private selectedDifficulty: 'easy' | 'medium' | 'hard' | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10; // Increased for testing
  private reconnectDelay = 2000; // Start at 2 seconds for testing

  constructor() {
    this.playerId = this.getOrCreatePlayerId();
    this.initializeBoard();
    this.attachEventListeners();
    this.handleUrlParams();
  }

  private getOrCreatePlayerId(): string {
    let id = localStorage.getItem('player_id');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('player_id', id);
    }
    return id;
  }

  private initializeBoard(): void {
    const boardContainer = document.getElementById('game-board');
    if (!boardContainer) throw new Error('Board container not found');
    boardContainer.innerHTML = '';

    for (let board = 0; board < 9; board++) {
      const smallBoard = document.createElement('div');
      smallBoard.className = 'small-board';
      smallBoard.dataset.board = String(board);

      for (let cell = 0; cell < 9; cell++) {
        const cellDiv = document.createElement('div');
        cellDiv.className = 'cell';
        cellDiv.dataset.board = String(board);
        cellDiv.dataset.cell = String(cell);
        cellDiv.addEventListener('click', () =>
          this.handleCellClick(board as BoardIndex, cell as CellIndex)
        );
        smallBoard.appendChild(cellDiv);
      }

      // Add overlay for won boards
      const overlay = document.createElement('div');
      overlay.className = 'board-overlay';
      smallBoard.appendChild(overlay);

      boardContainer.appendChild(smallBoard);
    }
  }

  private attachEventListeners(): void {
    const newGameBtn = document.getElementById('new-game-btn');
    if (newGameBtn) {
      newGameBtn.addEventListener('click', () => {
        this.showNewGameModal();
      });
    }

    const joinGameBtn = document.getElementById('join-game-btn');
    const joinGameInput = document.getElementById('join-game-input') as HTMLInputElement;
    if (joinGameBtn && joinGameInput) {
      joinGameBtn.addEventListener('click', () => {
        const gameId = joinGameInput.value.trim();
        if (gameId) {
          this.joinGameFromInput(gameId);
          joinGameInput.value = '';
        }
      });

      // Allow Enter key in input
      joinGameInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          const gameId = joinGameInput.value.trim();
          if (gameId) {
            this.joinGameFromInput(gameId);
            joinGameInput.value = '';
          }
        }
      });
    }

    const copyGameIdBtn = document.getElementById('copy-game-id-btn');
    if (copyGameIdBtn) {
      copyGameIdBtn.addEventListener('click', () => {
        this.copyGameId();
      });
    }

    const copyShareLinkBtn = document.getElementById('copy-share-link-btn');
    if (copyShareLinkBtn) {
      copyShareLinkBtn.addEventListener('click', () => {
        this.copyShareLink();
      });
    }
  }

  private async joinGameFromInput(gameId: string): Promise<void> {
    try {
      // Load game info first
      const response = await fetch(`/api/games/${gameId}`);
      if (!response.ok) {
        alert('Game not found');
        return;
      }

      const game = await response.json();

      if (game.status === 'waiting') {
        // Game is waiting - join it
        await this.joinGame(gameId);
      } else if (game.status === 'active' || game.status === 'incomplete') {
        // Game is active - just spectate/view
        this.gameId = gameId;
        this.connectWebSocket(gameId);
        this.updateStatus('Viewing game in progress');
      } else {
        // Game ended
        this.gameId = gameId;
        this.connectWebSocket(gameId);
        this.updateStatus('This game has ended');
      }
    } catch (error) {
      console.error('Error joining game:', error);
      alert('Error joining game');
    }
  }

  // Modal Methods
  private showNewGameModal(): void {
    const modal = document.getElementById('new-game-modal');
    modal?.classList.remove('hidden');
    this.attachModalListeners();
  }

  private hideNewGameModal(): void {
    const modal = document.getElementById('new-game-modal');
    modal?.classList.add('hidden');

    // Reset selections
    this.selectedGameType = null;
    this.selectedDifficulty = null;

    // Reset UI
    document.querySelectorAll('.game-type-btn').forEach(btn => btn.classList.remove('selected'));
    document.querySelectorAll('.difficulty-btn').forEach(btn => btn.classList.remove('selected'));
    const difficultySelector = document.getElementById('bot-difficulty-selector');
    difficultySelector?.classList.add('hidden');
  }

  private attachModalListeners(): void {
    // Close button
    const closeBtn = document.querySelector('.modal-close');
    closeBtn?.addEventListener('click', () => this.hideNewGameModal());

    // Cancel button
    const cancelBtn = document.getElementById('cancel-new-game');
    cancelBtn?.addEventListener('click', () => this.hideNewGameModal());

    // Game type buttons
    document.querySelectorAll('.game-type-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const type = (e.currentTarget as HTMLElement).dataset.type as 'bot' | 'human';
        this.handleGameTypeSelect(type);
      });
    });

    // Difficulty buttons
    document.querySelectorAll('.difficulty-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const difficulty = (e.currentTarget as HTMLElement).dataset.difficulty as 'easy' | 'medium' | 'hard';
        this.handleDifficultySelect(difficulty);
      });
    });

    // Confirm button
    const confirmBtn = document.getElementById('confirm-new-game');
    confirmBtn?.addEventListener('click', () => this.handleConfirmNewGame());
  }

  private handleGameTypeSelect(type: 'bot' | 'human'): void {
    this.selectedGameType = type;

    // Update UI
    document.querySelectorAll('.game-type-btn').forEach(btn => {
      btn.classList.toggle('selected', (btn as HTMLElement).dataset.type === type);
    });

    // Show/hide difficulty selector
    const difficultySelector = document.getElementById('bot-difficulty-selector');
    if (type === 'bot') {
      difficultySelector?.classList.remove('hidden');
    } else {
      difficultySelector?.classList.add('hidden');
      this.selectedDifficulty = null;
      document.querySelectorAll('.difficulty-btn').forEach(btn => btn.classList.remove('selected'));
    }

    this.updateConfirmButton();
  }

  private handleDifficultySelect(difficulty: 'easy' | 'medium' | 'hard'): void {
    this.selectedDifficulty = difficulty;

    // Update UI
    document.querySelectorAll('.difficulty-btn').forEach(btn => {
      btn.classList.toggle('selected', (btn as HTMLElement).dataset.difficulty === difficulty);
    });

    this.updateConfirmButton();
  }

  private updateConfirmButton(): void {
    const confirmBtn = document.getElementById('confirm-new-game') as HTMLButtonElement;
    if (!confirmBtn) return;

    const canConfirm = this.selectedGameType === 'human' ||
                       (this.selectedGameType === 'bot' && this.selectedDifficulty !== null);

    confirmBtn.disabled = !canConfirm;
  }

  private async handleConfirmNewGame(): Promise<void> {
    if (this.selectedGameType === 'bot' && this.selectedDifficulty) {
      await this.createBotGame(this.selectedDifficulty);
    } else if (this.selectedGameType === 'human') {
      await this.createHumanGame();
    }

    this.hideNewGameModal();
  }

  // Game Creation Methods
  private async createBotGame(difficulty: 'easy' | 'medium' | 'hard'): Promise<void> {
    try {
      const response = await fetch('/api/games', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          X_identity: this.playerId,
          O_identity: `bot-${difficulty}`,
          source: 'websocket',
          gameType: 'bot',
          botDifficulty: difficulty
        })
      });

      const game: Game = await response.json();
      this.gameId = game.id;
      this.connectWebSocket(game.id);
      this.updateGameInfo(game);
      this.updateStatus('Playing against bot - Your turn!');
    } catch (error) {
      console.error('Failed to create bot game:', error);
      this.updateStatus('Error creating game');
    }
  }

  private async createHumanGame(): Promise<void> {
    try {
      const response = await fetch('/api/games', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          X_identity: this.playerId,
          O_identity: null,
          source: 'websocket',
          gameType: 'human'
        })
      });

      const game: Game = await response.json();
      this.gameId = game.id;
      this.connectWebSocket(game.id);
      this.updateGameInfo(game);
      this.updateStatus('Waiting for opponent to join...');

      // Show share link prominently
      alert(`Share this link with your opponent:\n\n${window.location.origin}?gameId=${game.id}`);
    } catch (error) {
      console.error('Failed to create human game:', error);
      this.updateStatus('Error creating game');
    }
  }

  private async joinGame(gameId: string): Promise<void> {
    try {
      const response = await fetch(`/api/games/${gameId}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ player_identity: this.playerId })
      });

      if (!response.ok) {
        const error = await response.json();
        alert(`Cannot join game: ${error.error}`);
        return;
      }

      const result = await response.json();

      this.gameId = gameId;
      this.connectWebSocket(gameId);
      this.updateStatus(`You joined as player ${result.role}! Game starting...`);

    } catch (error) {
      console.error('Failed to join game:', error);
      alert('Error joining game');
    }
  }

  private async handleUrlParams(): Promise<void> {
    const params = new URLSearchParams(window.location.search);
    const gameId = params.get('gameId');

    if (!gameId) return;

    try {
      // Load game info
      const response = await fetch(`/api/games/${gameId}`);
      if (!response.ok) {
        alert('Game not found');
        return;
      }

      const game = await response.json();

      if (game.status === 'waiting') {
        const shouldJoin = confirm(
          `Join game ${gameId}?\n\nYou will be randomly assigned as X or O.`
        );
        if (shouldJoin) {
          await this.joinGame(gameId);
        }
      } else {
        // Game already active or ended - just spectate for now
        alert('This game is already in progress or has ended.');
      }

      // Clean URL
      window.history.replaceState({}, '', window.location.pathname);
    } catch (error) {
      console.error('Error handling URL params:', error);
    }
  }

  private connectWebSocket(gameId: string): void {
    if (this.ws) {
      this.ws.close();
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/games/${gameId}/ws?identity=${this.playerId}`;

    console.log('[WS] Connecting to:', wsUrl);
    this.updateConnectionStatus('connecting');
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('[WS] Connected');
      this.reconnectAttempts = 0;
      this.reconnectDelay = 2000; // Reset to initial delay
      this.updateConnectionStatus('connected');
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const data = wsMessageSchema.parse(JSON.parse(event.data));
        if (data.type === 'state') {
          this.handleStateUpdate(data.game);
        } else if (data.type === 'error') {
          console.error('[WS] Server error:', data.message);
          // Don't reconnect on game logic errors
          this.updateStatus(`Error: ${data.message}`);
        }
      } catch (error) {
        console.error('[WS] Failed to parse message:', error);
      }
    };

    this.ws.onerror = (error: Event) => {
      console.error('[WS] Error:', error);
      this.updateConnectionStatus('error');
    };

    this.ws.onclose = (event) => {
      console.log('[WS] Closed:', event.code, event.reason);
      this.updateConnectionStatus('disconnected');

      // Attempt reconnection if not a clean close and we haven't exceeded max attempts
      if (event.code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts && this.gameId) {
        this.reconnectAttempts++;
        console.log(`[WS] Reconnecting in ${this.reconnectDelay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        setTimeout(() => {
          if (this.gameId) {
            this.connectWebSocket(this.gameId);
          }
        }, this.reconnectDelay);

        // Exponential backoff (cap at 30 seconds for testing)
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        this.updateStatus('Failed to reconnect. Refresh the page to try again.');
      }
    };
  }

  private updateConnectionStatus(status: 'connecting' | 'connected' | 'disconnected' | 'error'): void {
    const statusEl = document.getElementById('connection-status');
    if (!statusEl) return;

    const statusText: Record<typeof status, string> = {
      connecting: '🟡 Connecting...',
      connected: '🟢 Connected',
      disconnected: '🔴 Disconnected',
      error: '🔴 Connection Error'
    };

    statusEl.textContent = statusText[status];
    statusEl.className = `connection-status ${status}`;
  }

  private handleStateUpdate(game: Game): void {
    this.currentState = game;
    this.renderBoard(game.moves);
    this.updateGameInfo(game);

    const isGameOver = game.status !== 'incomplete' && game.status !== 'active' && game.status !== 'waiting';
    if (isGameOver) {
      this.updateStatus(
        `Game Over: ${game.status === 'draw' ? 'Draw!' : game.status + ' wins!'}`
      );
    } else {
      this.updateStatus(`Turn: ${game.nextToMove}`);
    }
  }

  private renderBoard(moves: number[]): void {
    // Clear all cells
    document.querySelectorAll('.cell').forEach(cell => {
      cell.textContent = '';
      cell.classList.remove('X', 'O', 'occupied', 'legal');
    });

    document.querySelectorAll('.small-board').forEach(board => {
      board.classList.remove('active', 'won-X', 'won-O', 'full', 'playable');
    });

    // Use imported function to reconstruct state
    const state = getStateFromHistory(moves);

    // Render cell states
    for (let board = 0; board < 9; board++) {
      for (let cell = 0; cell < 9; cell++) {
        const cellDiv = document.querySelector<HTMLDivElement>(
          `[data-board="${board}"][data-cell="${cell}"]`
        );
        if (!cellDiv) continue;

        const bitMask = 1 << cell;

        if (state.smallBoardsX[board]! & bitMask) {
          cellDiv.textContent = 'X';
          cellDiv.classList.add('X', 'occupied');
        } else if (state.smallBoardsO[board]! & bitMask) {
          cellDiv.textContent = 'O';
          cellDiv.classList.add('O', 'occupied');
        }
      }

      // Mark won boards
      const smallBoardEl = document.querySelector<HTMLDivElement>(
        `.small-board[data-board="${board}"]`
      );
      if (!smallBoardEl) continue;

      const overlay = smallBoardEl.querySelector<HTMLDivElement>('.board-overlay');
      if (!overlay) continue;

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
    const isPlayable = this.currentState && (this.currentState.status === 'incomplete' || this.currentState.status === 'active');
    if (isPlayable) {
      this.highlightLegalMoves(state);
    }
  }

  private highlightLegalMoves(state: GameState): void {
    // Determine which boards are playable
    let playableBoards: number[] = [];
    if (state.nextBoard === -1) {
      // Can play on any non-won board
      playableBoards = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    } else {
      // Check if nextBoard is playable
      const nextBoardWon =
        (state.metaBoardX | state.metaBoardO | state.metaBoardFull) &
        (1 << state.nextBoard);
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
      const boardAlreadyWon =
        (state.metaBoardX | state.metaBoardO | state.metaBoardFull) &
        (1 << boardIdx);
      if (boardAlreadyWon) continue;

      const boardEl = document.querySelector<HTMLDivElement>(
        `.small-board[data-board="${boardIdx}"]`
      );
      if (boardEl) {
        boardEl.classList.add('playable');
      }

      // Mark individual legal cells
      for (let cellIdx = 0; cellIdx < 9; cellIdx++) {
        if (isLegalMove(state, boardIdx as BoardIndex, cellIdx as CellIndex)) {
          const cellEl = document.querySelector<HTMLDivElement>(
            `[data-board="${boardIdx}"][data-cell="${cellIdx}"]`
          );
          if (cellEl) {
            cellEl.classList.add('legal');
          }
        }
      }
    }

    // Highlight the primary active board (when directed to specific board)
    if (playableBoards.length === 1) {
      const activeBoard = document.querySelector<HTMLDivElement>(
        `.small-board[data-board="${playableBoards[0]}"]`
      );
      if (activeBoard) {
        activeBoard.classList.add('active');
      }
    }
  }

  private handleCellClick(board: BoardIndex, cell: CellIndex): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.updateStatus('Not connected');
      return;
    }

    const isPlayable = this.currentState && (this.currentState.status === 'incomplete' || this.currentState.status === 'active');
    if (!isPlayable) {
      this.updateStatus('Game is over');
      return;
    }

    // Reconstruct current state to validate move using imported function
    const state = getStateFromHistory(this.currentState.moves);

    // Validate move client-side before sending
    if (!isLegalMove(state, board, cell)) {
      console.log('Illegal move attempted:', { board, cell, state });
      return; // Silently ignore illegal moves
    }

    // Send move to server
    const moveMsg: MoveMessage = {
      type: 'move',
      board,
      cell
    };
    this.ws.send(JSON.stringify(moveMsg));
  }

  private updateGameInfo(game: Game): void {
    const gameIdEl = document.getElementById('game-id');
    const nextPlayerEl = document.getElementById('next-player');
    const gameStatusEl = document.getElementById('game-status');

    if (gameIdEl) gameIdEl.textContent = game.id;
    if (nextPlayerEl) nextPlayerEl.textContent = game.nextToMove;
    if (gameStatusEl) gameStatusEl.textContent = game.status;
  }

  private copyGameId(): void {
    if (!this.gameId) return;
    navigator.clipboard.writeText(this.gameId).then(() => {
      this.updateStatus('Game ID copied to clipboard!');
      setTimeout(() => {
        this.updateStatus('Ready to play');
      }, 2000);
    }).catch(() => {
      this.updateStatus('Failed to copy game ID');
    });
  }

  private copyShareLink(): void {
    if (!this.gameId) return;
    const shareUrl = `${window.location.origin}?gameId=${this.gameId}`;
    navigator.clipboard.writeText(shareUrl).then(() => {
      this.updateStatus('Share link copied to clipboard!');
      setTimeout(() => {
        this.updateStatus('Ready to play');
      }, 2000);
    }).catch(() => {
      this.updateStatus('Failed to copy share link');
    });
  }

  private updateStatus(message: string): void {
    const statusEl = document.getElementById('status');
    if (statusEl) {
      statusEl.textContent = message;
    }
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
