import type { GameState, Move, BoardIndex, CellIndex } from './types/game.types';
import { getLegalMoves, getStateFromHistory, checkSmallBoardWin, checkGameWin } from './game-logic';

/**
 * Easy bot: plays random legal moves
 */
export function botEasy(state: GameState): Move | null {
  const legalMoves = getLegalMoves(state);
  if (legalMoves.length === 0) return null;
  return legalMoves[Math.floor(Math.random() * legalMoves.length)];
}

/**
 * Medium bot: 1-ply evaluation
 * Scoring: Win immediately > Block opponent win > Center > Corner > Other
 */
export function botMedium(state: GameState): Move | null {
  const legalMoves = getLegalMoves(state);
  if (legalMoves.length === 0) return null;

  interface ScoredMove extends Move {
    score: number;
  }

  const scoredMoves: ScoredMove[] = legalMoves.map(move => {
    let score = 0;

    // Test if this move wins
    const testState = copyState(state);
    testState.smallBoardsO[move.board] |= 1 << move.cell;
    checkSmallBoardWin(testState, move.board);
    if (checkGameWin(testState)) {
      score += 1000; // Winning move
    } else if (testState.metaBoardO & (1 << move.board)) {
      score += 500; // Win small board
    }

    // Test if blocking opponent win
    const blockState = copyState(state);
    blockState.smallBoardsX[move.board] |= 1 << move.cell;
    checkSmallBoardWin(blockState, move.board);
    if (checkGameWin(blockState)) {
      score += 900; // Must block
    } else if (blockState.metaBoardX & (1 << move.board)) {
      score += 400; // Block small board win
    }

    // Prefer center (4), then corners (0,2,6,8), then edges (1,3,5,7)
    if (move.cell === 4) score += 20;
    else if ([0, 2, 6, 8].includes(move.cell)) score += 10;

    return { ...move, score };
  });

  scoredMoves.sort((a, b) => b.score - a.score);
  return scoredMoves[0] || null;
}

/**
 * Hard bot: minimax with alpha-beta pruning, depth 4-6
 * ~40ms budget per move
 */
export function botHard(state: GameState, timeoutMs: number = 40): Move | null {
  const legalMoves = getLegalMoves(state);
  if (legalMoves.length === 0) return null;

  const startTime = Date.now();
  let bestMove: Move | null = null;
  let bestScore = -Infinity;

  for (const move of legalMoves) {
    if (Date.now() - startTime > timeoutMs) break; // Stop if time budget exceeded

    const testState = copyState(state);
    testState.smallBoardsO[move.board] |= 1 << move.cell;
    checkSmallBoardWin(testState, move.board);
    testState.nextBoard = move.cell as BoardIndex;
    testState.nextToMove = 'X';

    const score = minimax(testState, 4, -Infinity, Infinity, false, startTime, timeoutMs);

    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
    }
  }

  return bestMove;
}

/**
 * Minimax with alpha-beta pruning
 */
function minimax(
  state: GameState,
  depth: number,
  alpha: number,
  beta: number,
  isMaximizing: boolean,
  startTime: number,
  timeoutMs: number
): number {
  // Timeout check
  if (Date.now() - startTime > timeoutMs) return evaluateState(state, isMaximizing);

  // Terminal state check
  const gameWin = checkGameWin(state);
  if (gameWin) {
    if (gameWin === 'O') return 100 + depth; // Bot win (prefer faster wins)
    if (gameWin === 'X') return -100 - depth; // Human win (prefer slower losses)
    return 0; // Draw
  }

  if (depth === 0) return evaluateState(state, isMaximizing);

  const legalMoves = getLegalMoves(state);
  if (legalMoves.length === 0) return 0;

  if (isMaximizing) {
    let maxScore = -Infinity;
    for (const move of legalMoves) {
      const nextState = copyState(state);
      nextState.smallBoardsO[move.board] |= 1 << move.cell;
      checkSmallBoardWin(nextState, move.board);
      nextState.nextBoard = move.cell as BoardIndex;
      nextState.nextToMove = 'X';

      const score = minimax(nextState, depth - 1, alpha, beta, false, startTime, timeoutMs);
      maxScore = Math.max(maxScore, score);
      alpha = Math.max(alpha, score);
      if (beta <= alpha) break; // Prune
    }
    return maxScore;
  } else {
    let minScore = Infinity;
    for (const move of legalMoves) {
      const nextState = copyState(state);
      nextState.smallBoardsX[move.board] |= 1 << move.cell;
      checkSmallBoardWin(nextState, move.board);
      nextState.nextBoard = move.cell as BoardIndex;
      nextState.nextToMove = 'O';

      const score = minimax(nextState, depth - 1, alpha, beta, true, startTime, timeoutMs);
      minScore = Math.min(minScore, score);
      beta = Math.min(beta, score);
      if (beta <= alpha) break; // Prune
    }
    return minScore;
  }
}

/**
 * Heuristic evaluation of game state
 * Positive = good for bot, negative = good for opponent
 */
function evaluateState(state: GameState, isMaximizing: boolean): number {
  let score = 0;

  // Evaluate meta board
  score += countBits(state.metaBoardO) * 10;
  score -= countBits(state.metaBoardX) * 10;

  // Evaluate small boards
  for (let board = 0; board < 9; board++) {
    if (state.metaBoardO & (1 << board)) continue; // Already won
    if (state.metaBoardX & (1 << board)) continue;

    score += evaluateSmallBoard(state.smallBoardsO[board]!, 'O');
    score -= evaluateSmallBoard(state.smallBoardsX[board]!, 'X');
  }

  return score;
}

/**
 * Evaluate a small board
 */
function evaluateSmallBoard(board: number, player: 'X' | 'O'): number {
  let score = 0;
  const patterns = [
    0b111000000, 0b000111000, 0b000000111, // rows
    0b100100100, 0b010010010, 0b001001001, // cols
    0b100010001, 0b001010100 // diagonals
  ];

  for (const pattern of patterns) {
    const matched = countBits(board & pattern);
    if (matched === 3) score += 100; // Three in a row
    else if (matched === 2) score += 10; // Two in a row
    else if (matched === 1) score += 1; // One move
  }

  return score;
}

/**
 * Count set bits
 */
function countBits(n: number): number {
  let count = 0;
  while (n) {
    count += n & 1;
    n >>= 1;
  }
  return count;
}

/**
 * Deep copy a game state
 */
function copyState(state: GameState): GameState {
  return {
    smallBoardsX: [...state.smallBoardsX],
    smallBoardsO: [...state.smallBoardsO],
    metaBoardX: state.metaBoardX,
    metaBoardO: state.metaBoardO,
    metaBoardFull: state.metaBoardFull,
    nextBoard: state.nextBoard,
    nextToMove: state.nextToMove
  };
}
