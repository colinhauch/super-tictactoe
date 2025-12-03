// NO STATE - just pure functions that both Worker and DO import

export const WIN_PATTERNS = [
  0b111000000, 0b000111000, 0b000000111,  // rows
  0b100100100, 0b010010010, 0b001001001,  // cols
  0b100010001, 0b001010100                // diagonals
];

export function getStateFromHistory(moves) {
  // Reconstruct full game state from move array
  const state = {
    smallBoardsX: Array(9).fill(0),
    smallBoardsO: Array(9).fill(0),
    metaBoardX: 0,
    metaBoardO: 0,
    metaBoardFull: 0,
    nextBoard: -1,
    nextToMove: 'X'
  };

  // Replay moves
  for (let i = 0; i < moves.length; i += 2) {
    const board = moves[i];
    const cell = moves[i + 1];
    const player = (i / 2) % 2 === 0 ? 'X' : 'O';

    // Apply move to state
    const bitPosition = 1 << cell;
    if (player === 'X') {
      state.smallBoardsX[board] |= bitPosition;
    } else {
      state.smallBoardsO[board] |= bitPosition;
    }

    // Check for small board win
    checkSmallBoardWin(state, board);

    // Set next board
    state.nextBoard = cell;
    state.nextToMove = player === 'X' ? 'O' : 'X';
  }

  return state;
}

export function isLegalMove(state, board, cell) {
  // Cannot play on a board that's already won or full
  const boardAlreadyWon = (state.metaBoardX | state.metaBoardO | state.metaBoardFull) & (1 << board);
  if (boardAlreadyWon) return false;

  // Must play on correct board (or any if nextBoard is won/full)
  const nextBoardValid = state.nextBoard === -1 || state.nextBoard === board;
  if (!nextBoardValid) {
    const nextBoardWon = (state.metaBoardX | state.metaBoardO | state.metaBoardFull) & (1 << state.nextBoard);
    if (!nextBoardWon) return false;
  }

  // Cell must be empty
  const cellMask = 1 << cell;
  const cellOccupied = (state.smallBoardsX[board] | state.smallBoardsO[board]) & cellMask;

  return !cellOccupied;
}

export function checkSmallBoardWin(state, boardIndex) {
  const xBits = state.smallBoardsX[boardIndex];
  const oBits = state.smallBoardsO[boardIndex];

  for (const pattern of WIN_PATTERNS) {
    if ((xBits & pattern) === pattern) {
      state.metaBoardX |= (1 << boardIndex);
      return 'X';
    }
    if ((oBits & pattern) === pattern) {
      state.metaBoardO |= (1 << boardIndex);
      return 'O';
    }
  }

  // Check if board is full
  if ((xBits | oBits) === 0b111111111) {
    state.metaBoardFull |= (1 << boardIndex);
  }

  return null;
}

export function checkGameWin(state) {
  for (const pattern of WIN_PATTERNS) {
    if ((state.metaBoardX & pattern) === pattern) return 'X';
    if ((state.metaBoardO & pattern) === pattern) return 'O';
  }

  // Check for draw
  if ((state.metaBoardX | state.metaBoardO | state.metaBoardFull) === 0b111111111) {
    return 'draw';
  }

  return null;
}

export function getLegalMoves(state) {
  const moves = [];
  const boards = state.nextBoard === -1
    ? [0, 1, 2, 3, 4, 5, 6, 7, 8]
    : [state.nextBoard];

  for (const board of boards) {
    for (let cell = 0; cell < 9; cell++) {
      if (isLegalMove(state, board, cell)) {
        moves.push({ board, cell });
      }
    }
  }

  return moves;
}
