-- Migration: Add support for waiting games and human multiplayer
-- This migration enables:
-- 1. Games in "waiting" state (one player, waiting for opponent)
-- 2. Games in "active" state (both players joined)
-- 3. Nullable O_identity for games awaiting second player

-- Allow O_identity to be null for waiting games
-- Note: SQLite doesn't support ALTER COLUMN, so we need to recreate the table
PRAGMA foreign_keys=off;

BEGIN TRANSACTION;

-- Create new games table with updated schema
CREATE TABLE games_new (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  nextToMove TEXT NOT NULL,
  moves TEXT NOT NULL,
  X_identity TEXT NOT NULL,
  O_identity TEXT,  -- Now nullable
  source TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  end_reason TEXT,
  ended_at DATETIME
);

-- Copy data from old table
INSERT INTO games_new (id, status, nextToMove, moves, X_identity, O_identity, source, created_at, updated_at)
SELECT id, status, nextToMove, moves, X_identity, O_identity, source, created_at, updated_at
FROM games;

-- Drop old table
DROP TABLE games;

-- Rename new table
ALTER TABLE games_new RENAME TO games;

-- Create index for finding waiting games (useful for future matchmaking)
CREATE INDEX idx_games_waiting ON games(status, created_at) WHERE status = 'waiting';

COMMIT;

PRAGMA foreign_keys=on;

-- Valid status values (enforced by application, not database):
-- 'waiting' - one player, waiting for opponent to join
-- 'active' - both players joined, game in progress
-- 'incomplete' - legacy status for bot games in progress
-- 'X' - game ended, X won
-- 'O' - game ended, O won
-- 'draw' - game ended in draw
