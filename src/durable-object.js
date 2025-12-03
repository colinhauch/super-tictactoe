import { DurableObject } from 'cloudflare:workers';
import { getStateFromHistory, isLegalMove, checkGameWin } from './game-logic.js';

export class GameSession extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.connections = [];
    this.gameId = null;
  }

  async fetch(request) {
    // Extract game ID from URL
    // Pattern: /api/games/:gameId/ws
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/').filter(Boolean);
    // pathParts = ['api', 'games', '<gameId>', 'ws']
    this.gameId = pathParts[2];

    console.log(`[DO] Full path: ${url.pathname}`);
    console.log(`[DO] Extracted game ID: ${this.gameId}`);
    console.log(`[DO] Upgrade header: ${request.headers.get('Upgrade')}`);

    // Upgrade to WebSocket
    if (request.headers.get('Upgrade') !== 'websocket') {
      console.log(`[DO] Not a WebSocket upgrade request`);
      return new Response('Expected WebSocket', { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Load current game state from D1
    const game = await this.env.DB.prepare(
      'SELECT * FROM games WHERE id = ?'
    ).bind(this.gameId).first();

    if (!game) {
      return new Response('Game not found', { status: 404 });
    }

    // Accept WebSocket and store connection
    this.ctx.acceptWebSocket(server);
    this.connections.push(server);

    // Send initial state
    server.send(JSON.stringify({
      type: 'state',
      game: {
        id: game.id,
        status: game.status,
        nextToMove: game.nextToMove,
        moves: JSON.parse(game.moves),
        X_identity: game.X_identity,
        O_identity: game.O_identity
      }
    }));

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(message);

      if (data.type === 'move') {
        await this.handleMove(ws, data.board, data.cell);
      }
    } catch (error) {
      ws.send(JSON.stringify({
        type: 'error',
        message: error.message
      }));
    }
  }

  async handleMove(ws, board, cell) {
    // 1. Load current game from D1
    const game = await this.env.DB.prepare(
      'SELECT * FROM games WHERE id = ?'
    ).bind(this.gameId).first();

    if (!game) {
      throw new Error('Game not found');
    }

    if (game.status !== 'incomplete') {
      throw new Error('Game is already complete');
    }

    // 2. Validate move
    const moves = JSON.parse(game.moves);
    const state = getStateFromHistory(moves);

    if (!isLegalMove(state, board, cell)) {
      throw new Error('Illegal move');
    }

    // 3. Apply move
    const newMoves = [...moves, board, cell];
    const newState = getStateFromHistory(newMoves);
    const gameResult = checkGameWin(newState);
    const newStatus = gameResult || 'incomplete';
    const newNextToMove = newState.nextToMove;

    // 4. Update D1
    await this.env.DB.prepare(`
      UPDATE games
      SET moves = ?, status = ?, nextToMove = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      JSON.stringify(newMoves),
      newStatus,
      newNextToMove,
      this.gameId
    ).run();

    // 5. Broadcast to all connections
    const updateMessage = JSON.stringify({
      type: 'state',
      game: {
        id: this.gameId,
        status: newStatus,
        nextToMove: newNextToMove,
        moves: newMoves,
        lastMove: { board, cell }
      }
    });

    for (const conn of this.connections) {
      try {
        conn.send(updateMessage);
      } catch (err) {
        // Connection closed, ignore
      }
    }
  }

  async webSocketClose(ws, code, reason) {
    // Remove from connections list
    this.connections = this.connections.filter(conn => conn !== ws);
  }
}
