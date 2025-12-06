# WebSocket & Durable Object Implementation Guide

## State Machine Architecture

Use a state machine for game orchestration in the Durable Object:

```javascript
const GameState = {
  WAITING_FOR_PLAYERS: 'waiting',    // 0-1 players connected
  IN_PROGRESS: 'in_progress',        // 2 players, actively playing
  PAUSED: 'paused',                  // 1 player disconnected (grace period)
  COMPLETED: 'completed',            // Game finished normally
  ABANDONED: 'abandoned'             // Cleanup needed
};
```

**Why:** Clear boundaries for valid actions, easier reconnection logic, explicit state transitions make debugging simpler.

## Persistence Strategy

**Keep game state in memory, persist strategically to D1:**

- Every 10 moves (checkpoint for ~40 move games = ~4 writes)
- On game completion (always)
- When transitioning to PAUSED or ABANDONED states
- NOT on every move or every alarm

**Why:** Games average 40 moves, so 4-5 D1 writes vs 40 saves costs. Fast move responses (no DB roundtrip). Acceptable risk: lose max 9 moves if DO crashes.

```javascript
async handleMove(ws, { board, cell }) {
  applyMove(this.gameData, board, cell);
  this.broadcast({ type: 'state', ...this.gameData });
  
  const shouldPersist = (
    this.gameData.status !== 'incomplete' ||
    this.gameData.moves.length % 10 === 0
  );
  
  if (shouldPersist) {
    await this.persistToD1();
  }
  
  // Set next move deadline
  this.currentMoveDeadline = Date.now() + this.config.moveTimeLimit;
  await this.state.storage.setAlarm(this.currentMoveDeadline);
}
```

## Alarm Behavior

**Key insight:** Only one alarm can be scheduled at a time. Alarms serve dual purposes:

1. **Game rules** - Enforce 30s move timeout
2. **System safety** - Handle disconnections, waiting room timeouts

**WebSocket connections keep DO alive** - The DO will NOT shut down while any WebSocket is connected. Alarm is just a timer for decision points.

### Alarm Decision Tree

```javascript
async alarm() {
  const context = {
    connections: this.connections.size,
    gameState: this.gameState,
    moveCount: this.gameData.moves.length,
    timeoutExpected: this.currentMoveDeadline && Date.now() >= this.currentMoveDeadline
  };
  
  if (context.connections === 0) return this.handleNoPlayers();
  if (context.connections === 1) return this.handleOnePlayer(context);
  if (context.connections === 2) return this.handleBothPlayers(context);
}
```

## Connection Scenarios

### Both WebSockets Closed

```javascript
async handleNoPlayers() {
  await this.persistToD1();
  
  if (this.gameData.moves.length === 0) {
    this.gameData.status = 'abandoned';
    this.gameData.endReason = 'no_players_joined';
  } else if (this.gameData.status === 'incomplete') {
    this.gameData.status = 'abandoned';
    this.gameData.endReason = 'both_players_left';
  }
  
  await this.persistToD1();
  this.gameState = GameState.ABANDONED;
  // Don't reschedule alarm - let DO be evicted
}
```

### One WebSocket Connected

Two distinct cases:

**Case A: Waiting for second player**
- Set 5-minute waiting room timeout
- Abandon game if no opponent joins

**Case B: Player disconnected mid-game**
- Enter PAUSED state
- Give 60-second grace period for reconnection
- Disconnected player forfeits if grace period expires

**Why 60s grace period:** Network hiccups, accidental refreshes. Balances UX (forgiveness) with game flow (don't wait forever).

```javascript
async handleOnePlayer(context) {
  if (this.gameState === GameState.WAITING_FOR_PLAYERS) {
    const waitTime = Date.now() - this.firstPlayerJoinTime;
    if (waitTime >= 5 * 60 * 1000) {
      this.gameData.status = 'abandoned';
      this.gameData.endReason = 'opponent_never_joined';
      await this.persistToD1();
      this.broadcast({ type: 'game_over', reason: 'opponent_never_joined' });
      this.gameState = GameState.ABANDONED;
      return;
    }
    await this.state.storage.setAlarm(Date.now() + 30000);
  }
  
  if (this.gameState === GameState.IN_PROGRESS) {
    this.gameState = GameState.PAUSED;
    const disconnectTime = this.playerDisconnectTimes.get(disconnectedPlayerId);
    const gracePeriod = 60000;
    
    if (Date.now() - disconnectTime >= gracePeriod) {
      // Disconnected player forfeits
      this.gameData.status = this.isPlayerX(disconnectedPlayerId) ? 'O' : 'X';
      this.gameData.endReason = 'disconnect_forfeit';
      await this.persistToD1();
      this.broadcast({ type: 'game_over', winner: this.gameData.status });
      this.gameState = GameState.COMPLETED;
      return;
    }
    
    await this.state.storage.setAlarm(disconnectTime + gracePeriod);
  }
}
```

### Both WebSockets Connected

```javascript
async handleBothPlayers(context) {
  if (context.timeoutExpected) {
    // Move timeout - current player loses
    this.gameData.status = this.gameData.nextToMove === 'X' ? 'O' : 'X';
    this.gameData.endReason = 'timeout';
    await this.persistToD1();
    this.broadcast({ type: 'game_over', winner: this.gameData.status });
    this.gameState = GameState.COMPLETED;
    return;
  }
  
  // Just a checkpoint - reschedule move timeout
  if (this.gameData.status === 'incomplete' && this.currentMoveDeadline) {
    await this.state.storage.setAlarm(this.currentMoveDeadline);
  }
}
```

## State Tracking Requirements

Track these in the Durable Object:

```javascript
export class GameSession {
  constructor(state, env) {
    this.config = {
      moveTimeLimit: 30000,      // 30s per move
      movesPerCheckpoint: 10     // Persist every 10 moves
    };
    
    this.gameData = null;              // In-memory game state
    this.connections = new Map();       // playerId -> WebSocket
    this.playerJoinTimes = new Map();   // playerId -> timestamp
    this.playerDisconnectTimes = new Map();
    this.gameStartedAt = null;
    this.currentMoveDeadline = null;
    this.gameState = GameState.WAITING_FOR_PLAYERS;
  }
}
```

**Why:** Need timestamps to calculate grace periods, distinguish waiting room from active game, and reconstruct alarm deadlines after DO restart.

## Disconnect Detection

**You cannot reliably distinguish intentional close vs network failure.**

```javascript
async webSocketClose(ws, code, reason, wasClean) {
  const playerId = this.getPlayerIdByConnection(ws);
  this.connections.delete(playerId);
  this.playerDisconnectTimes.set(playerId, Date.now());
  
  // WebSocket close codes:
  // 1000 = Normal (user clicked "leave")
  // 1001 = Going away (tab closed)
  // 1006 = Abnormal (network error)
  
  const intentional = code === 1000;
  this.broadcast({ 
    type: intentional ? 'player_left' : 'player_disconnected',
    playerId,
    gracePeriodSeconds: intentional ? 0 : 60
  });
  
  await this.scheduleNextAlarm();
}
```

**Client-side goodbye (nice-to-have, unreliable):**
```javascript
// Client
function leaveGame() {
  ws.send(JSON.stringify({ type: 'leaving' }));
  ws.close(1000, 'user_left');
}
```

## Alarm Scheduling Strategy

Single function to determine next alarm based on current state:

```javascript
async scheduleNextAlarm() {
  let nextAlarm = null;
  
  if (this.gameState === GameState.WAITING_FOR_PLAYERS) {
    // Waiting room timeout (5 minutes)
    nextAlarm = this.firstPlayerJoinTime + (5 * 60 * 1000);
  } else if (this.gameState === GameState.IN_PROGRESS) {
    // Move timeout has priority
    nextAlarm = this.currentMoveDeadline;
  } else if (this.gameState === GameState.PAUSED) {
    // Grace period for reconnection
    const disconnectTime = Array.from(this.playerDisconnectTimes.values())[0];
    nextAlarm = disconnectTime + 60000;
  }
  
  if (nextAlarm) {
    await this.state.storage.setAlarm(nextAlarm);
  }
}
```

**Why single scheduling function:** Centralizes alarm logic, prevents bugs from scattered setAlarm() calls, makes it clear what alarm represents at any moment.

## Game Start Detection

```javascript
async fetch(request) {
  // Accept WebSocket...
  this.connections.set(playerId, ws);
  this.playerJoinTimes.set(playerId, Date.now());
  
  if (this.connections.size === 2 && !this.gameStartedAt) {
    // Game just started!
    this.gameStartedAt = Date.now();
    this.gameState = GameState.IN_PROGRESS;
    this.currentMoveDeadline = Date.now() + this.config.moveTimeLimit;
    await this.state.storage.setAlarm(this.currentMoveDeadline);
    
    this.broadcast({ 
      type: 'game_started',
      moveDeadline: this.currentMoveDeadline
    });
  }
}
```

## DO Crash Recovery

If DO crashes and restarts, reconstruct alarm from D1 data:

```javascript
async fetch(request) {
  if (!this.gameData) {
    this.gameData = await this.loadFromD1(this.gameId);
    
    // Reconstruct move deadline if game in progress
    if (this.gameData.status === 'incomplete' && this.gameData.moves.length > 0) {
      const lastMoveTime = new Date(this.gameData.updated_at).getTime();
      const elapsed = Date.now() - lastMoveTime;
      const remaining = this.config.moveTimeLimit - elapsed;
      
      if (remaining > 0) {
        this.currentMoveDeadline = Date.now() + remaining;
        await this.state.storage.setAlarm(this.currentMoveDeadline);
      } else {
        // Time already expired
        await this.handleMoveTimeout();
      }
    }
  }
}
```

**Why:** Alarms don't persist across DO restarts. Must reconstruct from D1 timestamps.

## Key Takeaways

1. **WebSocket connections = DO stays alive** - Don't worry about premature shutdown
2. **Alarm is a decision point** - Check state, then act based on context
3. **State machine makes logic explicit** - Clear transitions, easier debugging
4. **Strategic persistence** - 4-5 writes per game vs 40, minimal durability risk
5. **Grace periods are UX** - 60s for disconnects, 5min for waiting room
6. **Track timestamps** - Essential for reconstructing state after crashes