import { GameSession } from './durable-object.js';
import { getStateFromHistory, isLegalMove, checkGameWin, getLegalMoves } from './game-logic.js';

export { GameSession };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    console.log(`[Worker] ${request.method} ${url.pathname}`);

    // WebSocket upgrade for real-time games
    // Pattern: /api/games/:gameId/ws
    if (url.pathname.endsWith('/ws') && url.pathname.startsWith('/api/games/')) {
      const pathParts = url.pathname.split('/').filter(Boolean);
      // pathParts = ['api', 'games', '<gameId>', 'ws']
      const gameId = pathParts[2];

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

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  // POST /api/games - Create new game
  if (path === '/api/games' && request.method === 'POST') {
    const body = await request.json();
    const gameId = crypto.randomUUID();

    await env.DB.prepare(`
      INSERT INTO games (id, status, nextToMove, moves, X_identity, O_identity, source)
      VALUES (?, 'incomplete', 'X', '[]', ?, ?, ?)
    `).bind(
      gameId,
      body.X_identity,
      body.O_identity,
      body.source || 'api'
    ).run();

    return Response.json({ id: gameId, status: 'incomplete', nextToMove: 'X', moves: [] });
  }

  // GET /api/games/:id - Get game state
  if (path.match(/^\/api\/games\/[\w-]+$/) && request.method === 'GET') {
    const gameId = path.split('/').pop();
    const game = await env.DB.prepare('SELECT * FROM games WHERE id = ?').bind(gameId).first();

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
    const gameId = path.split('/')[3];
    const { board, cell } = await request.json();

    const game = await env.DB.prepare('SELECT * FROM games WHERE id = ?').bind(gameId).first();

    if (!game) {
      return new Response('Not found', { status: 404 });
    }

    const moves = JSON.parse(game.moves);
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

    return Response.json({
      status: gameResult || 'incomplete',
      nextToMove: newState.nextToMove,
      moves: newMoves,
      legalMoves: getLegalMoves(newState)
    });
  }

  return new Response('Not found', { status: 404 });
}

async function handleData(request, env) {
  const url = new URL(request.url);

  if (url.pathname === '/data/stats') {
    const { results } = await env.DB.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'X' THEN 1 ELSE 0 END) as x_wins,
        SUM(CASE WHEN status = 'O' THEN 1 ELSE 0 END) as o_wins,
        SUM(CASE WHEN status = 'draw' THEN 1 ELSE 0 END) as draws
      FROM games
    `).all();

    return Response.json(results[0]);
  }

  return new Response('Not found', { status: 404 });
}
