import { DurableObject } from 'cloudflare:workers';
import { getStateFromHistory, isLegalMove, checkGameWin } from './game-logic';
import { botEasy, botMedium, botHard } from './bots';
import type { GameRecord, BoardIndex, CellIndex } from './types/game.types';
import { moveMessageSchema, stateMessageSchema, type StateMessage, type ErrorMessage } from './types/websocket.types';
import { z } from 'zod';

export class GameSession extends DurableObject {
  private connections: Map<WebSocket, string> = new Map(); // Map WebSocket to player identity
  private gameId: string | null = null;

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

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    // Load current game state from D1
    const game = await this.env.DB.prepare(
      'SELECT * FROM games WHERE id = ?'
    ).bind(this.gameId).first<GameRecord>();

    if (!game) {
      return new Response('Game not found', { status: 404 });
    }

    // Accept WebSocket and store connection with player identity
    this.ctx.acceptWebSocket(server);
    this.connections.set(server, playerIdentity || 'unknown');

    // Send initial state
    const initialMessage: StateMessage = {
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
    server.send(JSON.stringify(initialMessage));

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
    // 1. Load current game from D1
    const game = await this.env.DB.prepare(
      'SELECT * FROM games WHERE id = ?'
    ).bind(this.gameId).first<GameRecord>();

    if (!game) {
      const errorMsg: ErrorMessage = { type: 'error', message: 'Game not found' };
      ws.send(JSON.stringify(errorMsg));
      return;
    }

    if (game.status !== 'incomplete' && game.status !== 'active') {
      const errorMsg: ErrorMessage = { type: 'error', message: 'Game is not active' };
      ws.send(JSON.stringify(errorMsg));
      return;
    }

    // 2. Validate player identity
    const playerIdentity = this.connections.get(ws);
    const moves: number[] = JSON.parse(game.moves);
    let state = getStateFromHistory(moves);

    // Determine which player should move next
    const expectedIdentity = state.nextToMove === 'X' ? game.X_identity : game.O_identity;

    if (playerIdentity !== expectedIdentity) {
      const errorMsg: ErrorMessage = { type: 'error', message: 'Not your turn' };
      ws.send(JSON.stringify(errorMsg));
      return;
    }

    // 3. Validate move legality
    if (!isLegalMove(state, board, cell)) {
      const errorMsg: ErrorMessage = { type: 'error', message: 'Illegal move' };
      ws.send(JSON.stringify(errorMsg));
      return;
    }

    // 4. Apply move
    let finalMoves = [...moves, board, cell];
    state = getStateFromHistory(finalMoves);
    let gameResult = checkGameWin(state);

    // 5. Check if playing against bot and it's bot's turn
    if (!gameResult && game.O_identity?.startsWith('bot-') && state.nextToMove === 'O') {
      const botDifficulty = game.O_identity.split('-')[1] || 'easy';

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
    const newStatus = gameResult || (game.status === 'active' ? 'active' : 'incomplete');
    const newNextToMove = state.nextToMove;

    // 6. Update D1
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

    // 7. Broadcast to all connections
    const updateMessage: StateMessage = {
      type: 'state',
      game: {
        id: this.gameId!,
        status: newStatus,
        nextToMove: newNextToMove,
        moves: finalMoves,
        X_identity: game.X_identity,
        O_identity: game.O_identity,
        source: game.source,
        lastMove: { board, cell }
      }
    };

    for (const [conn] of this.connections) {
      try {
        conn.send(JSON.stringify(updateMessage));
      } catch (err) {
        // Connection closed, ignore
        console.error('[DO] Failed to send to connection:', err);
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // Remove from connections map
    this.connections.delete(ws);
    console.log(`[DO] Connection closed. Remaining: ${this.connections.size}`);
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
    for (const [conn] of this.connections) {
      try {
        conn.send(JSON.stringify(updateMessage));
      } catch (err) {
        console.error('[DO] Failed to send broadcast:', err);
      }
    }
  }
}
