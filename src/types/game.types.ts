/**
 * Core game type definitions for Super Tic-Tac-Toe
 */

/**
 * Player identifier - 'X' or 'O'
 */
export type Player = 'X' | 'O';

/**
 * Game outcome status
 */
export type GameStatus = 'X' | 'O' | 'draw' | 'incomplete';

/**
 * Source of game creation
 */
export type GameSource = 'api' | 'websocket';

/**
 * Board index (0-8) for small boards
 */
export type BoardIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/**
 * Cell index (0-8) within a board
 */
export type CellIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/**
 * Reconstructed game state using bitwise operations
 */
export interface GameState {
  /** Bitboards for X's positions in each of 9 small boards */
  smallBoardsX: [number, number, number, number, number, number, number, number, number];

  /** Bitboards for O's positions in each of 9 small boards */
  smallBoardsO: [number, number, number, number, number, number, number, number, number];

  /** Bitboard representing which small boards X has won (9 bits) */
  metaBoardX: number;

  /** Bitboard representing which small boards O has won (9 bits) */
  metaBoardO: number;

  /** Bitboard representing which small boards are full (9 bits) */
  metaBoardFull: number;

  /** Next board that must be played (-1 means any board) */
  nextBoard: BoardIndex | -1;

  /** Which player moves next */
  nextToMove: Player;
}

/**
 * Legal move coordinates
 */
export interface Move {
  board: BoardIndex;
  cell: CellIndex;
}

/**
 * Game record from D1 database
 */
export interface GameRecord {
  id: string;
  status: GameStatus;
  nextToMove: Player;
  moves: string;  // JSON-serialized array
  X_identity: string;
  O_identity: string;
  source: GameSource;
  created_at: string;
  updated_at: string;
}

/**
 * Hydrated game with parsed moves
 */
export interface Game {
  id: string;
  status: GameStatus;
  nextToMove: Player;
  moves: number[];  // Flat array: [board, cell, board, cell, ...]
  X_identity: string;
  O_identity: string;
  source: GameSource;
  lastMove?: {
    board: BoardIndex;
    cell: CellIndex;
  };
}
