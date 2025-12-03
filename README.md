# Super Tic-Tac-Toe on Cloudflare

A real-time Super Tic-Tac-Toe game built on Cloudflare Workers with Durable Objects and D1 database.

## Architecture

- **Single Worker**: Handles HTTP + WebSockets + static assets
- **D1 Database**: Single source of truth for ALL game state
- **Durable Objects**: WebSocket managers ONLY (no persistent storage)
- **Shared Logic**: Pure functions imported by both Worker and DO

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Create D1 Database

```bash
npx wrangler d1 create superttt-db
```

This will output a database ID. Copy it and update `wrangler.jsonc`:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "superttt-db",
    "database_id": "YOUR_DATABASE_ID_HERE"  // <- Replace this
  }
]
```

### 3. Apply Database Migrations

For local development:
```bash
npm run db:migrate:local
```

For production (after deploying):
```bash
npm run db:migrate:prod
```

### 4. Build Frontend

```bash
npm run build
```

### 5. Run Locally

```bash
npm run dev
```

Visit `http://localhost:8787` to play the game.

### 6. Deploy to Production

```bash
npm run deploy
```

Don't forget to apply migrations to production:
```bash
npm run db:migrate:prod
```

## Project Structure

```
superttt/
├── src/
│   ├── index.js              # Main Worker entry point
│   ├── game-logic.js         # Shared pure functions (NO state)
│   ├── durable-object.js     # GameSession DO (WebSocket only)
│   └── api/                  # (Future: API modules)
├── frontend/                 # Frontend application
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── dist/                     # Build output (gitignored)
├── migrations/
│   └── 0001_initial_schema.sql
├── wrangler.jsonc
└── package.json
```

## API Endpoints

### Create a new game
```
POST /api/games
Body: {
  "X_identity": "player-uuid",
  "O_identity": "bot-random",
  "source": "api"
}
```

### Get game state
```
GET /api/games/:id
```

### Submit move (HTTP fallback)
```
POST /api/games/:id/move
Body: {
  "board": 0,
  "cell": 4
}
```

### WebSocket connection
```
WS /api/games/:id/ws
```

### Get game statistics
```
GET /data/stats
```

## WebSocket Protocol

### Client → Server

```json
{
  "type": "move",
  "board": 0,
  "cell": 4
}
```

### Server → Client

```json
{
  "type": "state",
  "game": {
    "id": "game-uuid",
    "status": "incomplete",
    "nextToMove": "X",
    "moves": [0, 4, 4, 2, ...],
    "lastMove": { "board": 4, "cell": 2 }
  }
}
```

Error message:
```json
{
  "type": "error",
  "message": "Illegal move"
}
```

## Game State Format

- **moves**: Flat array `[board, cell, board, cell, ...]`
- **status**: `'X' | 'O' | 'draw' | 'incomplete'`
- **nextToMove**: `'X' | 'O'`
- Board and cell indices: 0-8

## Development Notes

- The DO loads game state from D1 on every WebSocket message
- This adds ~10-50ms latency but ensures consistency
- For optimization, consider caching game state in DO memory
- DOs do NOT use SQLite storage - D1 is the only data store

## Next Steps

- [ ] Add bot algorithms (src/bots.js)
- [ ] Implement player registration
- [ ] Add game history/replay
- [ ] Add multiplayer matchmaking
- [ ] Optimize DO caching strategy
