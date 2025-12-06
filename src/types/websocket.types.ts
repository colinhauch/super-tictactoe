/**
 * WebSocket message type definitions and Zod validation schemas
 */

import { z } from 'zod';
import type { Game, BoardIndex, CellIndex } from './game.types';

/**
 * Client -> Server: Player makes a move
 */
export interface MoveMessage {
  type: 'move';
  board: BoardIndex;
  cell: CellIndex;
}

/**
 * Server -> Client: Full game state update
 */
export interface StateMessage {
  type: 'state';
  game: Game & {
    lastMove?: {
      board: BoardIndex;
      cell: CellIndex;
    };
  };
}

/**
 * Server -> Client: Error occurred
 */
export interface ErrorMessage {
  type: 'error';
  message: string;
}

/**
 * Server -> Client: Game started with both players
 */
export interface GameStartedMessage {
  type: 'game_started';
  moveDeadline: number;
}

/**
 * Server -> Client: Game ended
 */
export interface GameEndedMessage {
  type: 'game_ended';
  winner?: 'X' | 'O';
  reason: string;
  message: string;
}

/**
 * All possible WebSocket message types
 */
export type WSMessage = MoveMessage | StateMessage | ErrorMessage | GameStartedMessage | GameEndedMessage;

/**
 * Zod schema for move messages with runtime validation
 */
export const moveMessageSchema = z.object({
  type: z.literal('move'),
  board: z.number().int().min(0).max(8),
  cell: z.number().int().min(0).max(8)
});

/**
 * Zod schema for state messages with runtime validation
 */
export const stateMessageSchema = z.object({
  type: z.literal('state'),
  game: z.object({
    id: z.string(),
    status: z.enum(['X', 'O', 'draw', 'incomplete', 'waiting', 'active']),
    nextToMove: z.enum(['X', 'O']),
    moves: z.array(z.number()),
    X_identity: z.string(),
    O_identity: z.string().nullable(),
    source: z.enum(['api', 'websocket']).optional().default('api'),
    lastMove: z
      .object({
        board: z.number().int().min(0).max(8),
        cell: z.number().int().min(0).max(8)
      })
      .optional()
  })
}) as z.ZodType<{
  type: 'state';
  game: Game;
}>;

/**
 * Zod schema for error messages with runtime validation
 */
export const errorMessageSchema = z.object({
  type: z.literal('error'),
  message: z.string()
});

/**
 * Zod schema for game started messages with runtime validation
 */
export const gameStartedMessageSchema = z.object({
  type: z.literal('game_started'),
  moveDeadline: z.number()
});

/**
 * Zod schema for game ended messages with runtime validation
 */
export const gameEndedMessageSchema = z.object({
  type: z.literal('game_ended'),
  winner: z.enum(['X', 'O']).optional(),
  reason: z.string(),
  message: z.string()
});

/**
 * Union schema for all WebSocket message types with runtime validation
 */
export const wsMessageSchema = z.union([
  moveMessageSchema,
  stateMessageSchema,
  errorMessageSchema,
  gameStartedMessageSchema,
  gameEndedMessageSchema
]);

/**
 * Type guard for move messages
 */
export function isMoveMessage(msg: unknown): msg is MoveMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    msg.type === 'move' &&
    'board' in msg &&
    'cell' in msg
  );
}
