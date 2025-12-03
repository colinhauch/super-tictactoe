CREATE TABLE games (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,          -- 'X', 'O', 'draw', 'incomplete'
  nextToMove TEXT NOT NULL,      -- 'X' or 'O'
  moves TEXT NOT NULL,           -- JSON array: [board, cell, board, cell, ...]
  X_identity TEXT NOT NULL,      -- player UUID or bot ID
  O_identity TEXT NOT NULL,      -- player UUID or bot ID
  source TEXT NOT NULL,          -- 'api', 'websocket'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE players (
  browser_id TEXT PRIMARY KEY,
  username TEXT UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_games_status ON games(status);
CREATE INDEX idx_games_created ON games(created_at);
CREATE INDEX idx_players_username ON players(username);
