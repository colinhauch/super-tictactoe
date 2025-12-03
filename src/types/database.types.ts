/**
 * D1 database type definitions
 */

/**
 * Result of D1 query operations
 */
export interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
  meta?: {
    duration: number;
    rows_read: number;
    rows_written: number;
  };
  error?: string;
}

/**
 * Game statistics from database
 */
export interface GameStats {
  total: number;
  x_wins: number;
  o_wins: number;
  draws: number;
}
