import { GameSession } from './durable-object';
import { getStateFromHistory, isLegalMove, checkGameWin, getLegalMoves } from './game-logic';
import { generateGameId } from './utils/game-id';
import { botEasy, botMedium, botHard } from './bots';
import type { GameRecord, BoardIndex, CellIndex } from './types/game.types';
import type { CreateGameRequest, SubmitMoveRequest, CreateGameResponse, SubmitMoveResponse, StatsResponse, JoinGameResponse } from './types/api.types';
import { createGameRequestSchema, submitMoveRequestSchema, joinGameRequestSchema } from './types/api.types';

export { GameSession };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    console.log(`[Worker] ${request.method} ${url.pathname}`);

    // WebSocket upgrade for real-time games
    // Pattern: /api/games/:gameId/ws
    if (url.pathname.endsWith('/ws') && url.pathname.startsWith('/api/games/')) {
      const pathParts = url.pathname.split('/').filter(Boolean);
      // pathParts = ['api', 'games', '<gameId>', 'ws']
      const gameId = pathParts[2];

      if (!gameId) {
        return new Response('Missing game ID', { status: 400 });
      }

      console.log(`[Worker] WebSocket request for game: ${gameId}`);

      const id = env.GAME_SESSIONS.idFromName(gameId);
      const stub = env.GAME_SESSIONS.get(id);
      return stub.fetch(request);
    }

    // API routes
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env);
    }

    // Data/analytics routes
    if (url.pathname.startsWith('/data')) {
      return handleData(request, env);
    }

    // Static assets (frontend)
    return env.ASSETS.fetch(request);
  }
};

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // POST /api/games - Create new game
  if (path === '/api/games' && request.method === 'POST') {
    try {
      const body = createGameRequestSchema.parse(await request.json());

      // Determine O_identity and status based on game type
      let oIdentity: string | null;
      let status: 'incomplete' | 'waiting';

      if (body.gameType === 'bot') {
        // Bot game
        const difficulty = body.botDifficulty || 'easy';
        oIdentity = `bot-${difficulty}`;
        status = 'incomplete';
      } else {
        // Human game - waiting for player 2
        oIdentity = null;
        status = 'waiting';
      }

      // Generate game ID with collision retry (max 5 attempts)
      let gameId: string | null = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidateId = generateGameId();
        const existing = await env.DB.prepare('SELECT id FROM games WHERE id = ?')
          .bind(candidateId)
          .first();

        if (!existing) {
          gameId = candidateId;
          break;
        }
      }

      if (!gameId) {
        return Response.json(
          { error: 'Failed to generate unique game ID' },
          { status: 500 }
        );
      }

      await env.DB.prepare(`
        INSERT INTO games (id, status, nextToMove, moves, X_identity, O_identity, source)
        VALUES (?, ?, 'X', '[]', ?, ?, ?)
      `).bind(
        gameId,
        status,
        body.X_identity,
        oIdentity,
        body.source
      ).run();

      const response: CreateGameResponse = {
        id: gameId,
        status: status,
        nextToMove: 'X',
        moves: []
      };
      return Response.json(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid request';
      return Response.json({ error: message }, { status: 400 });
    }
  }

  // GET /api/games/:id - Get game state
  if (path.match(/^\/api\/games\/[\w-]+$/) && request.method === 'GET') {
    const gameId = path.split('/').pop();
    if (!gameId) {
      return new Response('Invalid game ID', { status: 400 });
    }

    const game = await env.DB.prepare('SELECT * FROM games WHERE id = ?').bind(gameId).first<GameRecord>();

    if (!game) {
      return new Response('Not found', { status: 404 });
    }

    return Response.json({
      ...game,
      moves: JSON.parse(game.moves)
    });
  }

  // POST /api/games/:id/join - Join a waiting game
  if (path.match(/^\/api\/games\/[\w-]+\/join$/) && request.method === 'POST') {
    try {
      const gameId = path.split('/')[3];
      if (!gameId) {
        return Response.json({ error: 'Invalid game ID' }, { status: 400 });
      }

      const body = joinGameRequestSchema.parse(await request.json());

      // Load game
      const game = await env.DB.prepare('SELECT * FROM games WHERE id = ?')
        .bind(gameId)
        .first<GameRecord>();

      if (!game) {
        return Response.json({ error: 'Game not found' }, { status: 404 });
      }

      if (game.status !== 'waiting') {
        return Response.json({ error: 'Game is not accepting players' }, { status: 400 });
      }

      if (game.X_identity === body.player_identity) {
        return Response.json({ error: 'You cannot join your own game' }, { status: 400 });
      }

      // Random X/O assignment
      const joinedPlayerBecomesX = Math.random() < 0.5;

      let finalXIdentity: string;
      let finalOIdentity: string;
      let assignedRole: 'X' | 'O';

      if (joinedPlayerBecomesX) {
        // Joiner becomes X, creator becomes O
        finalXIdentity = body.player_identity;
        finalOIdentity = game.X_identity;
        assignedRole = 'X';
      } else {
        // Keep creator as X, joiner becomes O
        finalXIdentity = game.X_identity;
        finalOIdentity = body.player_identity;
        assignedRole = 'O';
      }

      // Update game to active status
      await env.DB.prepare(`
        UPDATE games
        SET X_identity = ?, O_identity = ?, status = 'active', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'waiting'
      `).bind(finalXIdentity, finalOIdentity, gameId).run();

      // Broadcast to all WebSocket connections that a player joined
      // This notifies player 1 that player 2 has joined
      try {
        const doId = env.GAME_SESSIONS.idFromName(gameId);
        const doStub = env.GAME_SESSIONS.get(doId);
        // Trigger a broadcast by fetching the Durable Object with game ID in path
        await doStub.fetch(new Request(`https://internal/api/games/${gameId}/broadcast-join`));
      } catch (error) {
        console.error('[API] Failed to trigger WebSocket broadcast:', error);
        // Don't fail the join request if broadcast fails
      }

      const response: JoinGameResponse = {
        success: true,
        role: assignedRole,
        game: {
          id: game.id,
          status: 'active',
          nextToMove: game.nextToMove,
          moves: JSON.parse(game.moves),
          X_identity: finalXIdentity,
          O_identity: finalOIdentity,
          source: game.source
        }
      };

      return Response.json(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid request';
      return Response.json({ error: message }, { status: 400 });
    }
  }

  // POST /api/games/:id/move - Submit move with optional bot response
  if (path.match(/^\/api\/games\/[\w-]+\/move$/) && request.method === 'POST') {
    try {
      const gameId = path.split('/')[3];
      if (!gameId) {
        return new Response('Invalid game ID', { status: 400 });
      }

      const moveData = submitMoveRequestSchema.parse(await request.json());
      const board = moveData.board as BoardIndex;
      const cell = moveData.cell as CellIndex;

      const game = await env.DB.prepare('SELECT * FROM games WHERE id = ?').bind(gameId).first<GameRecord>();

      if (!game) {
        return new Response('Not found', { status: 404 });
      }

      let moves: number[] = JSON.parse(game.moves);
      let state = getStateFromHistory(moves);

      if (!isLegalMove(state, board, cell)) {
        return Response.json({ error: 'Illegal move' }, { status: 400 });
      }

      // Apply player move
      moves = [...moves, board, cell];
      state = getStateFromHistory(moves);
      let gameResult = checkGameWin(state);

      // If game is over, save and return
      if (gameResult) {
        await env.DB.prepare(`
          UPDATE games SET moves = ?, status = ?, nextToMove = ?, end_reason = ?, ended_at = CURRENT_TIMESTAMP WHERE id = ?
        `).bind(
          JSON.stringify(moves),
          gameResult,
          state.nextToMove,
          'complete',
          gameId
        ).run();

        const response: SubmitMoveResponse = {
          status: gameResult,
          nextToMove: state.nextToMove,
          moves,
          legalMoves: []
        };
        return Response.json(response);
      }

      // Check if playing against a bot
      const isBotGame = game.O_identity && game.O_identity.startsWith('bot-');
      let botMove = null;

      if (isBotGame && state.nextToMove === 'O') {
        // Get bot difficulty
        const botDifficulty = game.O_identity.split('-')[1] || 'random';

        // Calculate bot move based on difficulty
        if (botDifficulty === 'hard') {
          botMove = botHard(state);
        } else if (botDifficulty === 'medium') {
          botMove = botMedium(state);
        } else {
          botMove = botEasy(state);
        }

        if (botMove) {
          // Apply bot move
          moves = [...moves, botMove.board, botMove.cell];
          state = getStateFromHistory(moves);
          gameResult = checkGameWin(state);
        }
      }

      // Save game state
      await env.DB.prepare(`
        UPDATE games SET moves = ?, status = ?, nextToMove = ?${gameResult ? ', end_reason = ?, ended_at = CURRENT_TIMESTAMP' : ''} WHERE id = ?
      `).bind(
        JSON.stringify(moves),
        gameResult || 'incomplete',
        state.nextToMove,
        ...(gameResult ? ['complete'] : []),
        gameId
      ).run();

      const response: SubmitMoveResponse = {
        status: gameResult || 'incomplete',
        nextToMove: state.nextToMove,
        moves,
        legalMoves: gameResult ? [] : getLegalMoves(state),
        botMove: botMove || undefined
      };
      return Response.json(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid request';
      return Response.json({ error: message }, { status: 400 });
    }
  }

  return new Response('Not found', { status: 404 });
}

async function handleData(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === '/data/stats') {
    const result = await env.DB.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'X' THEN 1 ELSE 0 END) as x_wins,
        SUM(CASE WHEN status = 'O' THEN 1 ELSE 0 END) as o_wins,
        SUM(CASE WHEN status = 'draw' THEN 1 ELSE 0 END) as draws
      FROM games
    `).first<StatsResponse>();

    if (!result) {
      return Response.json({ total: 0, x_wins: 0, o_wins: 0, draws: 0 });
    }

    return Response.json(result);
  }

  return new Response('Not found', { status: 404 });
}
