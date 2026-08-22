/**
 * Puzzles from the Lichess puzzle database (CC0, database.lichess.org).
 * Regenerate the bundled subset with `python3 scripts/fetch-puzzles.py`;
 * `test-puzzles.mjs` replays every one of them with chess.js.
 *
 * Database format: `moves` is a UCI list whose FIRST move is the opponent's —
 * it is played automatically to set the puzzle up. The solver plays the odd
 * indices, the opponent answers on the even ones.
 */

import { Chess } from 'chess.js';
import { explain, type EngineLine, type Explanation } from './analysis.js';
import data from './puzzles.js';

export type Puzzle = {
  id: string;
  fen: string;
  moves: string;
  rating: number;
  themes: string[];
};

export const PUZZLES = data as Puzzle[];

export const puzzleUrl = (p: Puzzle) => `https://lichess.org/training/${p.id}`;

export const uciToMove = (uci: string) => ({
  from: uci.slice(0, 2),
  to: uci.slice(2, 4),
  promotion: uci[4] ?? 'q',
});

/** Indices in `moves` that the solver has to find. */
export const isSolverPly = (index: number) => index % 2 === 1;

/**
 * Explains every move of the solution with the same extractors the bot page
 * uses — but fed the KNOWN solution instead of a Stockfish PV. The line is not
 * a prediction here, so nothing needs to be searched: a mate at the end of the
 * sequence is a fact, and the material swing is the one the solution actually
 * produces.
 */
export function reviewOf(puzzle: Puzzle): { fen: string; explanation: Explanation }[] {
  const moves = puzzle.moves.split(' ');

  const final = new Chess(puzzle.fen);
  for (const uci of moves) final.move(uciToMove(uci));
  const endsInMate = final.isCheckmate();

  const board = new Chess(puzzle.fen);
  /** `fen` is the position BEFORE the move, so the review can show it with an arrow. */
  const review: { fen: string; explanation: Explanation }[] = [];
  moves.forEach((uci, index) => {
    if (isSolverPly(index)) {
      const remaining = moves.slice(index);
      // Solver moves left in the sequence, this one included.
      const movesToMate = remaining.filter((_, k) => isSolverPly(k + index)).length;
      const line: EngineLine = {
        moveUci: uci,
        isMate: endsInMate,
        // White's point of view, as everywhere else.
        mateIn: endsInMate ? (board.turn() === 'w' ? movesToMate : -movesToMate) : null,
        // No engine ran, so there is no evaluation to report — and inventing
        // one would be exactly the kind of unfounded claim this project avoids.
        scoreCp: null,
        pv: remaining,
      };
      const fen = board.fen();
      const explanation = explain(fen, [line]);
      if (explanation) review.push({ fen, explanation });
    }
    board.move(uciToMove(uci));
  });
  return review;
}
