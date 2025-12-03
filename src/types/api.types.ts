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
  O_identity: string;
  source?: 'api' | 'websocket';
}

/**
 * Zod schema for create game requests with runtime validation
 */
export const createGameRequestSchema = z.object({
  X_identity: z.string().min(1, 'X_identity is required'),
  O_identity: z.string().min(1, 'O_identity is required'),
  source: z.enum(['api', 'websocket']).optional().default('api')
});

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
