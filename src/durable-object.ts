import { DurableObject } from 'cloudflare:workers';
import { getStateFromHistory, isLegalMove, checkGameWin } from './game-logic';
import { botEasy, botMedium, botHard } from './bots';
import type { GameRecord, BoardIndex, CellIndex } from './types/game.types';
import { moveMessageSchema, stateMessageSchema, type StateMessage, type ErrorMessage } from './types/websocket.types';
import { z } from 'zod';

enum GameState {
  WAITING_FOR_PLAYERS = 'waiting',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  ABANDONED = 'abandoned'
}

const CONFIG = {
  MOVE_TIMEOUT_MS: 30000,        // 30 seconds per move
  WAITING_ROOM_TIMEOUT_MS: 300000  // 5 minutes to find opponent
} as const;

export class GameSession extends DurableObject {
  private connections: Map<string, WebSocket> = new Map(); // Map player identity to WebSocket
  private gameId: string | null = null;
  private gameData: GameRecord | null = null;
  private gameState: GameState = GameState.WAITING_FOR_PLAYERS;
  private playerJoinTimes: Map<string, number> = new Map();
  private gameStartedAt: number | null = null;
  private currentMoveDeadline: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    // Extract game ID and player identity from URL
    // Pattern: /api/games/:gameId/ws?identity=<playerId>
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/').filter(Boolean);
    // pathParts = ['api', 'games', '<gameId>', 'ws']
    this.gameId = pathParts[2] || null;
    const playerIdentity = url.searchParams.get('identity');

    console.log(`[DO] Full path: ${url.pathname}`);
    console.log(`[DO] Extracted game ID: ${this.gameId}`);
    console.log(`[DO] Player identity: ${playerIdentity}`);
    console.log(`[DO] Upgrade header: ${request.headers.get('Upgrade')}`);

    // Handle broadcast-join request from API
    // Pattern: /api/games/:gameId/broadcast-join
    if (url.pathname.includes('/broadcast-join')) {
      console.log('[DO] Broadcast join request received for game:', this.gameId);
      await this.broadcastGameState();
      return new Response('OK', { status: 200 });
    }

    // Upgrade to WebSocket
    if (request.headers.get('Upgrade') !== 'websocket') {
      console.log(`[DO] Not a WebSocket upgrade request`);
      return new Response('Expected WebSocket', { status: 400 });
    }

    // Load game data and initialize state on first connection
    if (!this.gameData && this.gameId) {
      this.gameData = await this.loadGameFromD1();

      // Initialize state based on DB status
      if (this.gameData.status === 'waiting') {
        this.gameState = GameState.WAITING_FOR_PLAYERS;
      } else if (this.gameData.status === 'active' || this.gameData.status === 'incomplete') {
        this.gameState = GameState.IN_PROGRESS;
        // Reconstruct move deadline from last update
        const lastUpdate = new Date(this.gameData.updated_at).getTime();
        const elapsed = Date.now() - lastUpdate;
        const remaining = CONFIG.MOVE_TIMEOUT_MS - elapsed;
        this.currentMoveDeadline = remaining > 0 ? Date.now() + remaining : Date.now();
      } else {
        this.gameState = GameState.COMPLETED;
      }

      console.log('[DO] Loaded game state', {
        gameId: this.gameId,
        status: this.gameData.status,
        gameState: this.gameState
      });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    // Accept WebSocket and store connection with player identity
    this.ctx.acceptWebSocket(server);
    const playerId = playerIdentity || 'unknown';
    this.connections.set(playerId, server);
    this.playerJoinTimes.set(playerId, Date.now());

    // MVP: Assign roles by connection order (only for new games)
    // For games that are already active, respect existing role assignments
    if (this.gameData!.status === 'waiting') {
      // New game - assign roles by connection order
      if (this.connections.size === 1) {
        // First player - assign as X
        this.gameData!.X_identity = playerId;
        console.log('[DO] First player connected as X:', playerId);
      } else if (this.connections.size === 2) {
        // Second player - assign as O
        this.gameData!.O_identity = playerId;
        console.log('[DO] Second player connected as O:', playerId);

        // Update in-memory status to active
        this.gameData!.status = 'active';

        // Update D1 with both player identities and active status
        await this.env.DB.prepare(`
          UPDATE games
          SET X_identity = ?, O_identity = ?, status = 'active', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(this.gameData!.X_identity, this.gameData!.O_identity, this.gameId).run();
      }
    } else {
      // Game already active - roles already assigned, just validate player is in the game
      const isPlayerX = playerId === this.gameData!.X_identity;
      const isPlayerO = playerId === this.gameData!.O_identity;

      if (!isPlayerX && !isPlayerO) {
        console.log('[DO] Player not in this game:', playerId);
        // Still allow spectators to connect
      } else {
        console.log('[DO] Player reconnected:', {
          playerId,
          role: isPlayerX ? 'X' : 'O'
        });
      }
    }

    // Send initial state
    // Note: If this is player 2 connecting, status will be updated in the broadcast after handleGameStart
    const initialMessage: StateMessage = {
      type: 'state',
      game: {
        id: this.gameData!.id,
        status: this.gameData!.status,
        nextToMove: this.gameData!.nextToMove,
        moves: JSON.parse(this.gameData!.moves),
        X_identity: this.gameData!.X_identity,
        O_identity: this.gameData!.O_identity,
        source: this.gameData!.source
      }
    };
    server.send(JSON.stringify(initialMessage));

    console.log('[DO] Sent initial state to player:', {
      playerId,
      status: this.gameData!.status,
      connections: this.connections.size
    });

    // Detect game start
    if (this.connections.size === 2 &&
        this.gameState === GameState.WAITING_FOR_PLAYERS &&
        !this.gameStartedAt) {
      await this.handleGameStart();

      // Broadcast updated state to both players with correct identities
      this.broadcastToAll({
        type: 'state',
        game: {
          id: this.gameData!.id,
          status: 'active',
          nextToMove: this.gameData!.nextToMove,
          moves: JSON.parse(this.gameData!.moves),
          X_identity: this.gameData!.X_identity,
          O_identity: this.gameData!.O_identity,
          source: this.gameData!.source
        }
      });
    }

    // Schedule alarm based on current state
    await this.scheduleNextAlarm();

    return new Response(null, {
      status: 101,
      webSocket: client
    } as unknown as ResponseInit);
  }

  async webSocketMessage(ws: WebSocket, message: string): Promise<void> {
    try {
      const rawData = JSON.parse(message);

      // Validate and parse the move message
      const data = moveMessageSchema.parse(rawData);

      if (data.type === 'move') {
        await this.handleMove(ws, data.board as BoardIndex, data.cell as CellIndex);
      }
    } catch (error) {
      const errorMsg: ErrorMessage = {
        type: 'error',
        message: error instanceof Error ? error.message : 'Invalid message format'
      };
      ws.send(JSON.stringify(errorMsg));
    }
  }

  private async handleMove(ws: WebSocket, board: BoardIndex, cell: CellIndex): Promise<void> {
    console.log('[DO] Move received:', { board, cell });

    // Check game state
    if (this.gameState !== GameState.IN_PROGRESS) {
      console.log('[DO] Move rejected - game not in progress. State:', this.gameState);
      const errorMsg: ErrorMessage = {
        type: 'error',
        message: `Cannot move - game is ${this.gameState}`
      };
      ws.send(JSON.stringify(errorMsg));
      return;
    }

    // MVP: Use in-memory gameData - no D1 reads
    if (!this.gameData) {
      console.log('[DO] Move rejected - no game data in memory');
      const errorMsg: ErrorMessage = { type: 'error', message: 'Game not initialized' };
      ws.send(JSON.stringify(errorMsg));
      return;
    }

    // Validate player identity
    let playerIdentity: string | null = null;
    for (const [playerId, socket] of this.connections) {
      if (socket === ws) {
        playerIdentity = playerId;
        break;
      }
    }

    console.log('[DO] Player identity:', playerIdentity);
    const moves: number[] = JSON.parse(this.gameData.moves);
    let state = getStateFromHistory(moves);

    // Determine which player should move next
    const expectedIdentity = state.nextToMove === 'X' ? this.gameData.X_identity : this.gameData.O_identity;

    console.log('[DO] Turn validation:', {
      nextToMove: state.nextToMove,
      expectedIdentity,
      playerIdentity,
      isCorrectPlayer: playerIdentity === expectedIdentity
    });

    if (playerIdentity !== expectedIdentity) {
      console.log('[DO] Move rejected - not player\'s turn');
      const errorMsg: ErrorMessage = { type: 'error', message: 'Not your turn' };
      ws.send(JSON.stringify(errorMsg));
      return;
    }

    // Validate move legality
    if (!isLegalMove(state, board, cell)) {
      console.log('[DO] Move rejected - illegal move');
      const errorMsg: ErrorMessage = { type: 'error', message: 'Illegal move' };
      ws.send(JSON.stringify(errorMsg));
      return;
    }

    console.log('[DO] Move accepted, processing...');

    // Apply move
    let finalMoves = [...moves, board, cell];
    state = getStateFromHistory(finalMoves);
    let gameResult = checkGameWin(state);

    // Check if playing against bot and it's bot's turn
    if (!gameResult && this.gameData.O_identity?.startsWith('bot-') && state.nextToMove === 'O') {
      const botDifficulty = this.gameData.O_identity.split('-')[1] || 'easy';

      let botMove;
      if (botDifficulty === 'hard') {
        botMove = botHard(state);
      } else if (botDifficulty === 'medium') {
        botMove = botMedium(state);
      } else {
        botMove = botEasy(state);
      }

      if (botMove) {
        finalMoves = [...finalMoves, botMove.board, botMove.cell];
        state = getStateFromHistory(finalMoves);
        gameResult = checkGameWin(state);
      }
    }

    // Keep status as 'active' for human vs human games
    const newStatus = gameResult || (this.gameData.status === 'active' ? 'active' : 'incomplete');
    const newNextToMove = state.nextToMove;

    // Update in-memory gameData
    this.gameData.moves = JSON.stringify(finalMoves);
    this.gameData.status = newStatus;
    this.gameData.nextToMove = newNextToMove;

    // Write to D1 (DO is source of truth, D1 is for persistence only)
    await this.env.DB.prepare(`
      UPDATE games
      SET moves = ?, status = ?, nextToMove = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      JSON.stringify(finalMoves),
      newStatus,
      newNextToMove,
      this.gameId
    ).run();

    // Update move deadline and schedule alarm
    if (newStatus === 'active' || newStatus === 'incomplete') {
      // Game continues - set new deadline
      this.currentMoveDeadline = Date.now() + CONFIG.MOVE_TIMEOUT_MS;
      await this.scheduleNextAlarm();
    } else {
      // Game ended
      this.gameState = GameState.COMPLETED;
      this.currentMoveDeadline = null;
    }

    // 7. Broadcast to all connections
    const updateMessage: StateMessage = {
      type: 'state',
      game: {
        id: this.gameId!,
        status: newStatus,
        nextToMove: newNextToMove,
        moves: finalMoves,
        X_identity: this.gameData.X_identity,
        O_identity: this.gameData.O_identity,
        source: this.gameData.source,
        lastMove: { board, cell }
      }
    };

    console.log('[DO] Broadcasting move update to', this.connections.size, 'connections');

    for (const [playerId, ws] of this.connections) {
      try {
        ws.send(JSON.stringify(updateMessage));
      } catch (err) {
        // Connection closed, ignore
        console.error('[DO] Failed to send to connection:', err);
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // Find and remove the disconnected player
    let disconnectedPlayerId: string | null = null;
    for (const [playerId, socket] of this.connections) {
      if (socket === ws) {
        disconnectedPlayerId = playerId;
        this.connections.delete(playerId);
        break;
      }
    }

    console.log('[DO] Connection closed', {
      playerId: disconnectedPlayerId,
      code,
      reason,
      remaining: this.connections.size,
      gameState: this.gameState
    });

    // MVP: Simple forfeit logic (no grace period)
    if (this.gameState === GameState.IN_PROGRESS && this.connections.size === 1) {
      // One player left during active game - other player wins
      if (!this.gameData) {
        this.gameData = await this.loadGameFromD1();
      }

      const disconnectedPlayerRole = this.getPlayerRole(disconnectedPlayerId);
      const winner = disconnectedPlayerRole === 'X' ? 'O' : 'X';

      await this.endGame(winner, 'disconnect_forfeit');
      this.gameState = GameState.COMPLETED;

      this.broadcastToAll({
        type: 'game_ended',
        winner,
        reason: 'opponent_disconnected',
        message: 'Your opponent disconnected'
      });
    } else if (this.connections.size === 0) {
      // Both players gone - schedule cleanup via alarm
      await this.scheduleNextAlarm();
    }
  }

  private getPlayerRole(playerId: string | null): 'X' | 'O' | 'unknown' {
    if (!playerId || !this.gameData) return 'unknown';
    if (playerId === this.gameData.X_identity) return 'X';
    if (playerId === this.gameData.O_identity) return 'O';
    return 'unknown';
  }

  private async handleGameStart(): Promise<void> {
    this.gameStartedAt = Date.now();
    this.gameState = GameState.IN_PROGRESS;
    this.currentMoveDeadline = Date.now() + CONFIG.MOVE_TIMEOUT_MS;

    this.broadcastToAll({
      type: 'game_started',
      moveDeadline: this.currentMoveDeadline
    });

    console.log('[DO] Game started with 2 players');
  }

  private async loadGameFromD1(): Promise<GameRecord> {
    const game = await this.env.DB.prepare(
      'SELECT * FROM games WHERE id = ?'
    ).bind(this.gameId).first<GameRecord>();

    if (!game) {
      throw new Error('Game not found');
    }

    return game;
  }

  private broadcastToAll(message: any): void {
    const messageStr = JSON.stringify(message);
    for (const [playerId, ws] of this.connections) {
      try {
        ws.send(messageStr);
      } catch (err) {
        console.error(`[DO] Failed to send to ${playerId}:`, err);
      }
    }
  }

  private async scheduleNextAlarm(): Promise<void> {
    let nextAlarmTime: number | null = null;

    if (this.gameState === GameState.WAITING_FOR_PLAYERS && this.connections.size === 1) {
      // Waiting room timeout: 5 minutes from first player join
      const firstJoinTime = Array.from(this.playerJoinTimes.values())[0];
      if (firstJoinTime) {
        nextAlarmTime = firstJoinTime + CONFIG.WAITING_ROOM_TIMEOUT_MS;
      }
    } else if (this.gameState === GameState.IN_PROGRESS && this.currentMoveDeadline) {
      // Move timeout: current move deadline
      nextAlarmTime = this.currentMoveDeadline;
    }
    // COMPLETED and ABANDONED states don't need alarms

    if (nextAlarmTime && nextAlarmTime > Date.now()) {
      await this.ctx.storage.setAlarm(nextAlarmTime);
      console.log('[DO] Alarm scheduled for', new Date(nextAlarmTime).toISOString());
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    console.log('[DO] Alarm fired', {
      gameState: this.gameState,
      connections: this.connections.size,
      moveDeadline: this.currentMoveDeadline ? new Date(this.currentMoveDeadline).toISOString() : null
    });

    // No players connected
    if (this.connections.size === 0) {
      return this.handleNoPlayers();
    }

    // One player in waiting room
    if (this.connections.size === 1 && this.gameState === GameState.WAITING_FOR_PLAYERS) {
      return this.handleWaitingRoomTimeout();
    }

    // Move timeout in active game
    if (this.gameState === GameState.IN_PROGRESS &&
        this.currentMoveDeadline &&
        now >= this.currentMoveDeadline) {
      return this.handleMoveTimeout();
    }

    // Unexpected alarm - reschedule defensively
    console.log('[DO] Unexpected alarm state, rescheduling');
    await this.scheduleNextAlarm();
  }

  private async handleNoPlayers(): Promise<void> {
    console.log('[DO] No players connected - abandoning game');

    if (!this.gameData) {
      this.gameData = await this.loadGameFromD1();
    }

    const endReason = this.gameData.moves.length === 0
      ? 'no_players_joined'
      : 'both_players_left';

    await this.endGame('abandoned', endReason);
    this.gameState = GameState.ABANDONED;
    // Don't reschedule - let DO be evicted
  }

  private async handleWaitingRoomTimeout(): Promise<void> {
    console.log('[DO] Waiting room timeout - no opponent joined');

    await this.endGame('abandoned', 'opponent_never_joined');
    this.gameState = GameState.ABANDONED;

    this.broadcastToAll({
      type: 'game_ended',
      reason: 'opponent_never_joined',
      message: 'No opponent joined within 5 minutes'
    });
  }

  private async handleMoveTimeout(): Promise<void> {
    console.log('[DO] Move timeout - current player loses');

    if (!this.gameData) {
      this.gameData = await this.loadGameFromD1();
    }

    const winner = this.gameData.nextToMove === 'X' ? 'O' : 'X';
    await this.endGame(winner, 'timeout');
    this.gameState = GameState.COMPLETED;

    this.broadcastToAll({
      type: 'game_ended',
      winner,
      reason: 'timeout',
      message: `${this.gameData.nextToMove} took too long to move`
    });
  }

  private async endGame(status: string, endReason: string): Promise<void> {
    await this.env.DB.prepare(`
      UPDATE games
      SET status = ?, end_reason = ?, ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(status, endReason, this.gameId).run();
  }

  private async broadcastGameState(): Promise<void> {
    if (!this.gameId) return;

    // Load current game state from D1
    const game = await this.env.DB.prepare(
      'SELECT * FROM games WHERE id = ?'
    ).bind(this.gameId).first<GameRecord>();

    if (!game) {
      console.error('[DO] Game not found for broadcast');
      return;
    }

    // Broadcast updated state to all connections
    const updateMessage: StateMessage = {
      type: 'state',
      game: {
        id: game.id,
        status: game.status,
        nextToMove: game.nextToMove,
        moves: JSON.parse(game.moves),
        X_identity: game.X_identity,
        O_identity: game.O_identity,
        source: game.source
      }
    };

    console.log(`[DO] Broadcasting to ${this.connections.size} connections`);
    this.broadcastToAll(updateMessage);
  }
}
