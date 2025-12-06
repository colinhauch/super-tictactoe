import type { GameRecord } from '../types/game.types';

/**
 * Get a game by ID
 */
export async function getGame(db: D1Database, gameId: string): Promise<GameRecord | undefined> {
  return db.prepare('SELECT * FROM games WHERE id = ?').bind(gameId).first<GameRecord>();
}

/**
 * Create a new game
 */
export async function createGame(
  db: D1Database,
  gameId: string,
  xIdentity: string,
  oIdentity: string | null,
  source: string
): Promise<void> {
  await db.prepare(`
    INSERT INTO games (id, status, nextToMove, moves, X_identity, O_identity, source)
    VALUES (?, 'incomplete', 'X', '[]', ?, ?, ?)
  `).bind(gameId, xIdentity, oIdentity, source).run();
}

/**
 * Record a move in the game
 */
export async function recordMove(
  db: D1Database,
  gameId: string,
  moves: number[],
  nextToMove: string
): Promise<void> {
  await db.prepare(`
    UPDATE games SET moves = ?, nextToMove = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).bind(JSON.stringify(moves), nextToMove, gameId).run();
}

/**
 * End a game with a result and reason
 */
export async function endGame(
  db: D1Database,
  gameId: string,
  status: string,
  reason: string
): Promise<void> {
  await db.prepare(`
    UPDATE games SET status = ?, end_reason = ?, ended_at = CURRENT_TIMESTAMP WHERE id = ?
  `).bind(status, reason, gameId).run();
}

/**
 * Join a game as the O player
 */
export async function joinGame(
  db: D1Database,
  gameId: string,
  oIdentity: string
): Promise<void> {
  await db.prepare(`
    UPDATE games SET O_identity = ?, status = 'active' WHERE id = ? AND status = 'waiting'
  `).bind(oIdentity, gameId).run();
}
