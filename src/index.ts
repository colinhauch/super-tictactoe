import { GameSession } from './durable-object';
import { getStateFromHistory, isLegalMove, checkGameWin, getLegalMoves } from './game-logic';
import type { GameRecord, BoardIndex, CellIndex } from './types/game.types';
import type { CreateGameRequest, SubmitMoveRequest, CreateGameResponse, SubmitMoveResponse, StatsResponse } from './types/api.types';
import { createGameRequestSchema, submitMoveRequestSchema } from './types/api.types';

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
      const gameId = crypto.randomUUID();

      await env.DB.prepare(`
        INSERT INTO games (id, status, nextToMove, moves, X_identity, O_identity, source)
        VALUES (?, 'incomplete', 'X', '[]', ?, ?, ?)
      `).bind(
        gameId,
        body.X_identity,
        body.O_identity,
        body.source
      ).run();

      const response: CreateGameResponse = {
        id: gameId,
        status: 'incomplete',
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

  // POST /api/games/:id/move - Submit move (HTTP fallback)
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

      const moves: number[] = JSON.parse(game.moves);
      const state = getStateFromHistory(moves);

      if (!isLegalMove(state, board, cell)) {
        return Response.json({ error: 'Illegal move' }, { status: 400 });
      }

      const newMoves = [...moves, board, cell];
      const newState = getStateFromHistory(newMoves);
      const gameResult = checkGameWin(newState);

      await env.DB.prepare(`
        UPDATE games SET moves = ?, status = ?, nextToMove = ? WHERE id = ?
      `).bind(
        JSON.stringify(newMoves),
        gameResult || 'incomplete',
        newState.nextToMove,
        gameId
      ).run();

      const response: SubmitMoveResponse = {
        status: gameResult || 'incomplete',
        nextToMove: newState.nextToMove,
        moves: newMoves,
        legalMoves: getLegalMoves(newState)
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
