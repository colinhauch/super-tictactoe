/**
 * API request and response type definitions with Zod validation
 */

import { z } from 'zod';
import type { Game, GameStatus, Player } from './game.types';

/**
 * POST /api/games - Create game request
 */
export interface CreateGameRequest {
  X_identity: string;
  O_identity: string | null;  // null = waiting for human
  source?: 'api' | 'websocket';
  gameType: 'bot' | 'human';
  botDifficulty?: 'easy' | 'medium' | 'hard';  // required if gameType='bot'
}

/**
 * Zod schema for create game requests with runtime validation
 */
export const createGameRequestSchema = z.object({
  X_identity: z.string().min(1, 'X_identity is required'),
  O_identity: z.string().nullable(),
  source: z.enum(['api', 'websocket']).optional().default('api'),
  gameType: z.enum(['bot', 'human']),
  botDifficulty: z.enum(['easy', 'medium', 'hard']).optional()
}).refine(
  (data) => data.gameType !== 'bot' || data.botDifficulty !== undefined,
  { message: 'botDifficulty is required when gameType is bot', path: ['botDifficulty'] }
);

/**
 * POST /api/games - Create game response
 */
export interface CreateGameResponse {
  id: string;
  status: GameStatus;
  nextToMove: Player;
  moves: number[];
}

/**
 * POST /api/games/:id/move - Submit move request
 */
export interface SubmitMoveRequest {
  board: number;
  cell: number;
}

/**
 * Zod schema for submit move requests with runtime validation
 */
export const submitMoveRequestSchema = z.object({
  board: z.number().int().min(0, 'board must be 0-8').max(8, 'board must be 0-8'),
  cell: z.number().int().min(0, 'cell must be 0-8').max(8, 'cell must be 0-8')
});

/**
 * POST /api/games/:id/move - Submit move response
 */
export interface SubmitMoveResponse {
  status: GameStatus;
  nextToMove: Player;
  moves: number[];
  legalMoves: Array<{
    board: number;
    cell: number;
  }>;
  botMove?: {
    board: number;
    cell: number;
  };
}

/**
 * POST /api/games/:id/join - Join game request
 */
export interface JoinGameRequest {
  player_identity: string;
}

/**
 * Zod schema for join game requests with runtime validation
 */
export const joinGameRequestSchema = z.object({
  player_identity: z.string().min(1, 'player_identity is required')
});

/**
 * POST /api/games/:id/join - Join game response
 */
export interface JoinGameResponse {
  success: boolean;
  role: 'X' | 'O';
  game: Game;
}

/**
 * GET /data/stats - Statistics response
 */
export interface StatsResponse {
  total: number;
  x_wins: number;
  o_wins: number;
  draws: number;
}
