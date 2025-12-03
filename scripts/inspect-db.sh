#!/bin/bash

echo "=== Recent Games ==="
npx wrangler d1 execute superttt-db --local --command "
  SELECT
    substr(id, 1, 8) as game_id,
    status,
    nextToMove,
    json_array_length(moves) / 2 as num_moves,
    datetime(created_at, 'localtime') as created
  FROM games
  ORDER BY created_at DESC
  LIMIT 10
"

echo ""
echo "=== Game Statistics ==="
npx wrangler d1 execute superttt-db --local --command "
  SELECT
    COUNT(*) as total_games,
    SUM(CASE WHEN status = 'incomplete' THEN 1 ELSE 0 END) as in_progress,
    SUM(CASE WHEN status = 'X' THEN 1 ELSE 0 END) as x_wins,
    SUM(CASE WHEN status = 'O' THEN 1 ELSE 0 END) as o_wins,
    SUM(CASE WHEN status = 'draw' THEN 1 ELSE 0 END) as draws
  FROM games
"

echo ""
echo "=== Players ==="
npx wrangler d1 execute superttt-db --local --command "
  SELECT
    substr(browser_id, 1, 8) as player_id,
    username,
    datetime(created_at, 'localtime') as joined
  FROM players
  ORDER BY created_at DESC
  LIMIT 5
"
