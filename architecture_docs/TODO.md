# Super TTT Implementation Guide

## Phase 1: Game Mode Foundation

### 1.1 Richer Game IDs
**Do first — affects all URLs**

```bash
npm install @faker-js/faker
```

```javascript
// src/utils/game-id.js
import { faker } from '@faker-js/faker';

export function generateGameId() {
  // e.g., "brave-tiger-42" or "swift-ocean-blue-17"
  const words = [faker.word.adjective(), faker.word.noun()];
  const num = faker.number.int({ min: 10, max: 99 });
  return `${words.join('-')}-${num}`;
}
```

Collision strategy: retry on INSERT conflict (rare at your scale).

### 1.2 Bot Play (HTTP-only)
**No WebSocket needed for bots**

New endpoint:
```
POST /api/games/:id/move
Body: { board, cell }
Response: { gameState, botMove? }
```

Flow:
1. Validate player move
2. Apply move, check win
3. If vs bot and game not over: calculate bot move, apply, check win
4. Return updated state

Bot implementations in `src/bots.js`:
- `botEasy`: random legal move
- `botMedium`: 1-ply eval (win/block/center/corner)
- `botHard`: minimax depth 4-6, ~40ms budget

### 1.3 Private Game Flow
**Already mostly exists**

States: `waiting` → `active` → `finished`

```
POST /api/games { mode: 'private', X_identity: playerId }
→ { id: 'brave-tiger-42', status: 'waiting', joinUrl: '...' }

POST /api/games/:id/join { O_identity: playerId }
→ { status: 'active' } + WebSocket upgrade available
```

### 1.4 Resign
**WebSocket message + HTTP fallback**

```javascript
// In DO message handler
case 'resign':
  await this.endGame(resigningPlayer === 'X' ? 'O' : 'X');
  this.broadcast({ type: 'game_over', reason: 'resign', winner });
  break;
```

D1 update: `status = winner, ended_at = NOW(), end_reason = 'resign'`

---

## Phase 2: Player System

### 2.1 Player Identity
**Browser UUID in localStorage**

```javascript
// Frontend
const getPlayerId = () => {
  let id = localStorage.getItem('player_id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('player_id', id);
  }
  return id;
};
```

Include in all requests: `X-Player-Id` header or body field.

### 2.2 Schema Addition

```sql
-- migrations/0002_players.sql
CREATE TABLE players (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE,
  elo INTEGER DEFAULT 1200,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE games ADD COLUMN end_reason TEXT; -- 'complete', 'resign', 'timeout'
ALTER TABLE games ADD COLUMN ended_at DATETIME;

CREATE INDEX idx_games_x_identity ON games(X_identity);
CREATE INDEX idx_games_o_identity ON games(O_identity);
```

### 2.3 Player Records Endpoint

```
GET /api/players/:id/stats
→ {
    games_played: 42,
    wins: 20,
    losses: 18,
    draws: 4,
    elo: 1247,
    recent_games: [{ id, opponent, result, date }, ...]
  }
```

SQL:
```sql
SELECT 
  COUNT(*) as games,
  SUM(CASE WHEN (X_identity = ? AND status = 'X') OR (O_identity = ? AND status = 'O') THEN 1 ELSE 0 END) as wins,
  SUM(CASE WHEN status = 'draw' THEN 1 ELSE 0 END) as draws
FROM games 
WHERE X_identity = ? OR O_identity = ?
```

---

## Phase 3: Matchmaking

### 3.1 Lobby Durable Object
**Single DO manages queue**

```javascript
// src/lobby-do.js
export class Lobby {
  constructor(state, env) {
    this.waiting = new Map(); // oderId -> { ws, playerId, joinedAt }
  }

  async fetch(request) {
    const [client, server] = Object.values(new WebSocketPair());
    const playerId = new URL(request.url).searchParams.get('player');
    
    // Check for existing waiter
    if (this.waiting.size > 0) {
      const [oderId, opponent] = this.waiting.entries().next().value;
      this.waiting.delete(oderId);
      
      // Create game, notify both
      const gameId = await this.createGame(playerId, opponent.playerId);
      opponent.ws.send(JSON.stringify({ type: 'matched', gameId, color: 'X' }));
      server.send(JSON.stringify({ type: 'matched', gameId, color: 'O' }));
      // Close lobby connections, they'll connect to game DO
    } else {
      this.waiting.set(oderId, { ws: server, playerId, joinedAt: Date.now() });
      server.send(JSON.stringify({ type: 'waiting' }));
    }
    
    server.accept();
    return new Response(null, { status: 101, webSocket: client });
  }
}
```

wrangler.jsonc addition:
```json
{ "name": "LOBBY", "class_name": "Lobby" }
```

Route: `WS /api/matchmaking`

### 3.2 Timeout / Auto-resign
**DO Alarms**

```javascript
// In GameSession DO
async startInactivityTimer() {
  await this.state.storage.setAlarm(Date.now() + 3 * 60 * 1000); // 3 min
}

async alarm() {
  // Check last move timestamp
  const game = await this.loadGame();
  const inactivePlayer = game.nextToMove;
  await this.endGame(inactivePlayer === 'X' ? 'O' : 'X', 'timeout');
  this.broadcast({ type: 'game_over', reason: 'timeout' });
}

// Reset alarm on each move
async handleMove() {
  // ... existing logic
  await this.startInactivityTimer();
}
```

---

## Phase 4: Polish

### 4.1 Spectating
**Read-only WebSocket connections**

```javascript
// In GameSession DO
async fetch(request) {
  const url = new URL(request.url);
  const isSpectator = url.searchParams.get('spectate') === 'true';
  
  // ... WebSocket setup
  this.connections.push({ ws: server, isSpectator, playerId });
  
  // Send current state to spectator
  server.send(JSON.stringify({ type: 'state', ...this.gameState }));
}

handleMessage(ws, msg) {
  const conn = this.connections.find(c => c.ws === ws);
  if (conn.isSpectator) {
    ws.send(JSON.stringify({ type: 'error', message: 'Spectators cannot make moves' }));
    return;
  }
  // ... normal move handling
}
```

Route: `WS /api/games/:id/watch`

### 4.2 ELO Calculation
**On game end**

```javascript
function calculateElo(winnerElo, loserElo, isDraw = false) {
  const K = 32;
  const expected = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
  const score = isDraw ? 0.5 : 1;
  const delta = Math.round(K * (score - expected));
  return { winnerDelta: delta, loserDelta: -delta };
}

// Call on game end, update players table
```

---

## Phase 5: Tournament (Stretch)

### Architecture Sketch
- `TournamentLobby` DO: manages participants, pairings, standings
- States: `registration` → `active` → `complete`
- On game end: callback to tournament DO, update standings, create next pairing
- Arena format simpler than bracket (no elimination tracking)

**Defer until Phases 1-4 complete.**

---

## File Structure After Implementation

```
src/
├── index.js              # Router
├── game-logic.js         # Pure functions (shared)
├── bots.js               # Easy/medium/hard
├── db/
│   └── games.js          # D1 query helpers (shared)
├── durable-objects/
│   ├── game-session.js   # Per-game WebSocket
│   └── lobby.js          # Matchmaking queue
├── api/
│   ├── games.js          # CRUD, moves
│   ├── players.js        # Stats, records
│   └── matchmaking.js    # Lobby endpoint
└── utils/
    ├── game-id.js        # Faker-based IDs
    └── elo.js            # Rating calc
```

---

## Shared D1 Query Helpers

**Both Worker (bot games) and DO (human games) use these:**

```javascript
// src/db/games.js
export async function getGame(db, gameId) {
  return db.prepare("SELECT * FROM games WHERE id = ?").bind(gameId).first();
}

export async function createGame(db, { id, xIdentity, oIdentity, source }) {
  return db.prepare(
    `INSERT INTO games (id, status, nextToMove, moves, X_identity, O_identity, source)
     VALUES (?, 'waiting', 'X', '[]', ?, ?, ?)`
  ).bind(id, xIdentity, oIdentity, source).run();
}

export async function recordMove(db, gameId, moves, nextToMove) {
  return db.prepare(
    `UPDATE games SET moves = ?, nextToMove = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(JSON.stringify(moves), nextToMove, gameId).run();
}

export async function endGame(db, gameId, status, reason) {
  return db.prepare(
    `UPDATE games SET status = ?, end_reason = ?, ended_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(status, reason, gameId).run();
}

export async function joinGame(db, gameId, oIdentity) {
  return db.prepare(
    `UPDATE games SET O_identity = ?, status = 'active' WHERE id = ? AND status = 'waiting'`
  ).bind(oIdentity, gameId).run();
}
```

**Usage in Worker (bot games):**
```javascript
import { getGame, recordMove, endGame } from '../db/games.js';
import { applyMove, checkGameWin } from '../game-logic.js';

// After player move + bot response
await recordMove(env.DB, gameId, newMoves, nextToMove);
if (winner) await endGame(env.DB, gameId, winner, 'complete');
```

**Usage in DO (human games):**
```javascript
import { getGame, recordMove, endGame } from '../db/games.js';
import { applyMove, checkGameWin } from '../game-logic.js';

// After validated WebSocket move
await recordMove(this.env.DB, this.gameId, newMoves, nextToMove);
if (winner) await endGame(this.env.DB, this.gameId, winner, 'complete');
```

Same queries, same game logic — only the transport differs.

---

## Quick Reference: D1 Queries

**Create game:**
```sql
INSERT INTO games (id, status, nextToMove, moves, X_identity, O_identity, source)
VALUES (?, 'waiting', 'X', '[]', ?, NULL, ?)
```

**Join game:**
```sql
UPDATE games SET O_identity = ?, status = 'active' WHERE id = ? AND status = 'waiting'
```

**Record move:**
```sql
UPDATE games SET moves = ?, nextToMove = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
```

**End game:**
```sql
UPDATE games SET status = ?, end_reason = ?, ended_at = CURRENT_TIMESTAMP WHERE id = ?
```

**Player stats:**
```sql
SELECT 
  COUNT(*) as total,
  SUM(CASE WHEN status IN ('X','O','draw') THEN 1 ELSE 0 END) as completed
FROM games WHERE X_identity = ?1 OR O_identity = ?1
```