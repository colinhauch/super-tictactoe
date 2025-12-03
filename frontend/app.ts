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

  constructor() {
    this.playerId = this.getOrCreatePlayerId();
    this.initializeBoard();
    this.attachEventListeners();
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
        this.createNewGame();
      });
    }
  }

  private async createNewGame(): Promise<void> {
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

      const game: Game = await response.json();
      this.gameId = game.id;
      this.connectWebSocket(game.id);
      this.updateGameInfo(game);
    } catch (error) {
      console.error('Failed to create game:', error);
      this.updateStatus('Error creating game');
    }
  }

  private connectWebSocket(gameId: string): void {
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

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const data = wsMessageSchema.parse(JSON.parse(event.data));
        if (data.type === 'state') {
          this.handleStateUpdate(data.game);
        } else if (data.type === 'error') {
          console.error('Server error:', data.message);
          this.updateStatus(`Error: ${data.message}`);
        }
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error);
      }
    };

    this.ws.onerror = (error: Event) => {
      console.error('WebSocket error:', error);
      this.updateStatus('Connection error');
    };

    this.ws.onclose = () => {
      console.log('WebSocket closed');
      this.updateStatus('Disconnected');
    };
  }

  private handleStateUpdate(game: Game): void {
    this.currentState = game;
    this.renderBoard(game.moves);
    this.updateGameInfo(game);

    if (game.status !== 'incomplete') {
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
    if (this.currentState && this.currentState.status === 'incomplete') {
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

    if (!this.currentState || this.currentState.status !== 'incomplete') {
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

    if (gameIdEl) gameIdEl.textContent = game.id.slice(0, 8);
    if (nextPlayerEl) nextPlayerEl.textContent = game.nextToMove;
    if (gameStatusEl) gameStatusEl.textContent = game.status;
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
