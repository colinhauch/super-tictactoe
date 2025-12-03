# Local Development Tools for Cloudflare Workers

## 🔍 Debugging Overview

When developing locally with Wrangler, you have several powerful tools at your disposal:

### 1. Console Logging (Most Important!)

**Use `console.log()` everywhere!** This is your primary debugging tool.

```javascript
// In your Worker
console.log(`[Worker] ${request.method} ${url.pathname}`);

// In your Durable Object
console.log(`[DO] Game ${this.gameId}: ${this.connections.length} connections`);
```

All console logs appear in your terminal where `wrangler dev` is running.

### 2. Local D1 Database Access

Your D1 database is stored locally at:
```
.wrangler/state/v3/d1/miniflare-D1DatabaseObject/
```

#### Query the database directly:

```bash
# Interactive SQL shell
npx wrangler d1 execute superttt-db --local --command "SELECT * FROM games"

# Or use the file parameter for complex queries
npx wrangler d1 execute superttt-db --local --file query.sql
```

#### Useful queries:

```bash
# See all games
npx wrangler d1 execute superttt-db --local --command "SELECT id, status, nextToMove, created_at FROM games"

# See game details (including moves)
npx wrangler d1 execute superttt-db --local --command "SELECT * FROM games WHERE id = 'your-game-id'"

# Count games by status
npx wrangler d1 execute superttt-db --local --command "SELECT status, COUNT(*) as count FROM games GROUP BY status"

# See all players
npx wrangler d1 execute superttt-db --local --command "SELECT * FROM players"

# Clear all games (reset for testing)
npx wrangler d1 execute superttt-db --local --command "DELETE FROM games"
```

### 3. Durable Objects Debugging

**Key insight:** Durable Objects don't have persistent storage in our architecture!

We're using DOs ONLY for WebSocket coordination, with D1 as the source of truth.

#### What you can log:

```javascript
export class GameSession extends DurableObject {
  async fetch(request) {
    console.log(`[DO] Active connections: ${this.connections.length}`);
    console.log(`[DO] Game ID: ${this.gameId}`);
    // ... rest of your code
  }

  async webSocketMessage(ws, message) {
    console.log(`[DO] Received message:`, message);
    // ... handle message
  }

  async webSocketClose(ws, code, reason) {
    console.log(`[DO] WebSocket closed. Reason: ${reason}. Remaining: ${this.connections.length}`);
  }
}
```

#### Durable Object State (if you were using it):

Since we're NOT using DO storage, you don't need to worry about `ctx.storage.sql.exec()` or `ctx.storage.get()`.

But if you were, you could inspect it with:
```javascript
const keys = await this.ctx.storage.list();
console.log('DO storage keys:', Array.from(keys.keys()));
```

### 4. Network Inspection

#### In your browser DevTools:

1. **Network tab**: See all HTTP requests and WebSocket connections
2. **Console**: See frontend JavaScript logs
3. **Application tab → WebSockets**: Monitor WebSocket frames in real-time

#### WebSocket debugging:

```javascript
// In frontend/app.js
this.ws.onmessage = (event) => {
  console.log('[WS] Received:', event.data);
  const data = JSON.parse(event.data);
  // ... handle message
};

this.ws.send(JSON.stringify({ type: 'move', board, cell }));
console.log('[WS] Sent move:', { board, cell });
```

### 5. Wrangler Dev Server Features

#### Hot Reload
Changes to your source files automatically restart the worker. Watch the terminal for:
```
[wrangler:inf] Reloading local server...
```

#### Inspect Mode
Run with Chrome DevTools integration:
```bash
npx wrangler dev --inspector
```

Then open `chrome://inspect` in Chrome to debug with breakpoints!

### 6. Testing API Endpoints

Use `curl` or create a test script:

```bash
# Create a game
curl -X POST http://localhost:8787/api/games \
  -H "Content-Type: application/json" \
  -d '{"X_identity": "player1", "O_identity": "bot-random", "source": "api"}'

# Get game state
curl http://localhost:8787/api/games/<game-id>

# Submit a move
curl -X POST http://localhost:8787/api/games/<game-id>/move \
  -H "Content-Type: application/json" \
  -d '{"board": 4, "cell": 4}'

# Get stats
curl http://localhost:8787/data/stats
```

### 7. Local State Location

All local development data is stored in:
```
.wrangler/
├── state/
│   └── v3/
│       ├── d1/                    # Your D1 database files
│       ├── do/                    # Durable Object state (if using storage)
│       └── kv/                    # KV namespace (if using)
└── tmp/
```

To reset everything:
```bash
rm -rf .wrangler/state
npm run db:migrate:local  # Re-apply migrations
```

## 🛠️ Recommended Development Workflow

1. **Start dev server in one terminal:**
   ```bash
   npx wrangler dev
   ```

2. **Keep another terminal open for D1 queries:**
   ```bash
   # Watch games being created
   watch -n 2 'npx wrangler d1 execute superttt-db --local --command "SELECT id, status, nextToMove FROM games ORDER BY created_at DESC LIMIT 5"'
   ```

3. **Use browser DevTools:**
   - Console for frontend logs
   - Network → WS to inspect WebSocket messages
   - Application → Local Storage to see player ID

4. **Check server terminal for all backend logs:**
   - Worker routing decisions
   - Durable Object lifecycle
   - Database queries (if you add logging)

## 📊 Quick Database Inspection Script

Create `scripts/inspect-db.sh`:

```bash
#!/bin/bash

echo "=== Games ==="
npx wrangler d1 execute superttt-db --local --command "
  SELECT
    substr(id, 1, 8) as id,
    status,
    nextToMove,
    length(moves) as move_count,
    datetime(created_at) as created
  FROM games
  ORDER BY created_at DESC
  LIMIT 10
"

echo ""
echo "=== Stats ==="
npx wrangler d1 execute superttt-db --local --command "
  SELECT
    COUNT(*) as total_games,
    SUM(CASE WHEN status = 'incomplete' THEN 1 ELSE 0 END) as in_progress,
    SUM(CASE WHEN status = 'X' THEN 1 ELSE 0 END) as x_wins,
    SUM(CASE WHEN status = 'O' THEN 1 ELSE 0 END) as o_wins,
    SUM(CASE WHEN status = 'draw' THEN 1 ELSE 0 END) as draws
  FROM games
"
```

Make it executable:
```bash
chmod +x scripts/inspect-db.sh
./scripts/inspect-db.sh
```

## 🐛 Common Issues & Solutions

### Issue: WebSocket 404
**Problem:** WebSocket route not matching
**Solution:** Check routing order in `src/index.js`. WebSocket route must come BEFORE generic `/api/` handler.

### Issue: "Database not found"
**Problem:** Migrations not applied locally
**Solution:**
```bash
npx wrangler d1 migrations apply superttt-db --local
```

### Issue: Durable Object "not connected"
**Problem:** DO bindings show `[not connected]` in dev server
**Solution:** This is normal for local dev. DOs work despite this message.

### Issue: Changes not reflecting
**Problem:** Browser cache or build not updated
**Solution:**
```bash
npm run build  # Rebuild frontend
# Hard refresh browser (Cmd+Shift+R / Ctrl+Shift+R)
```

### Issue: CORS errors
**Problem:** Frontend can't call API
**Solution:** Add CORS headers if calling from different origin (shouldn't happen with same origin on localhost:8787)

## 🚀 Production Debugging

When deployed to Cloudflare:

### Tail logs in real-time:
```bash
npx wrangler tail
```

### Filter logs:
```bash
npx wrangler tail --format=pretty --search="[DO]"
```

### Query production D1:
```bash
npx wrangler d1 execute superttt-db --command "SELECT * FROM games LIMIT 10"
```

### View Durable Object analytics:
Visit Cloudflare Dashboard → Workers & Pages → Your Worker → Durable Objects

## 📝 Adding More Debugging

### Enhanced Worker logging:

```javascript
export default {
  async fetch(request, env, ctx) {
    const start = Date.now();
    const url = new URL(request.url);

    try {
      const response = await handleRequest(request, env);
      console.log(`[Worker] ${request.method} ${url.pathname} - ${response.status} (${Date.now() - start}ms)`);
      return response;
    } catch (error) {
      console.error(`[Worker] ERROR:`, error);
      return new Response('Internal Server Error', { status: 500 });
    }
  }
};
```

### Database query logging:

```javascript
async function queryDB(env, sql, params = []) {
  console.log(`[DB] Query:`, sql);
  console.log(`[DB] Params:`, params);
  const result = await env.DB.prepare(sql).bind(...params).all();
  console.log(`[DB] Result:`, result);
  return result;
}
```

## 🎯 Summary

**Primary debugging tools:**
1. ✅ `console.log()` in Worker & DO (shows in terminal)
2. ✅ `npx wrangler d1 execute` for database inspection
3. ✅ Browser DevTools for frontend & WebSocket
4. ✅ `npx wrangler tail` for production logs

**Remember:** Your architecture uses D1 as the single source of truth, so database inspection is KEY!
