/**
 * The bundled puzzle set is generated data — nothing is trustworthy about it
 * until the app's own chess library replays it. This certifies every puzzle
 * with chess.js, and checks that the review explains the KNOWN solution
 * (no engine involved) rather than inventing one.
 *
 * Run: node test-puzzles.mjs
 */
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { Chess } from 'chess.js';

const tsc = spawnSync(
  process.execPath,
  ['node_modules/typescript/bin/tsc', 'src/puzzle.ts', '--ignoreConfig', '--outDir', '.tmp',
   '--module', 'esnext', '--target', 'es2022', '--moduleResolution', 'bundler',
   '--skipLibCheck'],
  { encoding: 'utf8' },
);
assert.equal(tsc.status, 0, `tsc failed:\n${tsc.stdout}${tsc.stderr}`);
const { PUZZLES, isSolverPly, reviewOf, uciToMove } = await import('./.tmp/puzzle.js');

assert.ok(PUZZLES.length >= 100, `expected a decent puzzle set, got ${PUZZLES.length}`);

const ids = new Set();
let mates = 0;
let solverMoves = 0;

for (const puzzle of PUZZLES) {
  const where = `puzzle ${puzzle.id}`;
  assert.ok(!ids.has(puzzle.id), `${where}: duplicate id`);
  ids.add(puzzle.id);

  const moves = puzzle.moves.split(' ');
  // The first move is the opponent's setup move, and the solution ends with
  // one of the solver's — so the list is always even.
  assert.equal(moves.length % 2, 0, `${where}: odd move list ${puzzle.moves}`);
  assert.ok(moves.length >= 2, `${where}: no solution`);
  assert.ok(Number.isInteger(puzzle.rating), `${where}: bad rating`);
  assert.ok(puzzle.themes.length > 0, `${where}: no themes`);

  // Every move must be legal, in order, from the stored FEN.
  const board = new Chess(puzzle.fen);
  const solverColor = board.turn() === 'w' ? 'b' : 'w';
  moves.forEach((uci, i) => {
    assert.equal(
      board.turn(),
      isSolverPly(i) ? solverColor : (solverColor === 'w' ? 'b' : 'w'),
      `${where}: wrong side to move at ply ${i}`,
    );
    board.move(uciToMove(uci)); // throws if the move is illegal here
    solverMoves += isSolverPly(i) ? 1 : 0;
  });

  // The review must cover every solver move and say something about each.
  const review = reviewOf(puzzle);
  assert.equal(
    review.length,
    moves.filter((_, i) => isSolverPly(i)).length,
    `${where}: review must cover every solver move`,
  );
  // Each step must carry the position its move was played from, and that
  // position must actually produce the move the step claims — otherwise
  // rewinding the board would show an arrow that doesn't match the text.
  const solution = moves.filter((_, i) => isSolverPly(i));
  review.forEach((step, i) => {
    const { san, from, to } = step.explanation.best;
    assert.ok(san, `${where}: review step without a move`);
    assert.ok(step.explanation.best.reasons.length > 0, `${where}: review step without a reason`);
    assert.equal(`${from}${to}`, solution[i].slice(0, 4), `${where}: step ${i} arrow is wrong`);
    const rewound = new Chess(step.fen);
    assert.equal(rewound.turn(), solverColor, `${where}: step ${i} is not the solver's turn`);
    assert.equal(
      rewound.move(uciToMove(solution[i])).san,
      san,
      `${where}: step ${i} fen and move disagree`,
    );
  });

  // A mate at the end of the solution is a fact here, not a prediction: the
  // review must announce it, with the right distance, on the very first move.
  if (board.isCheckmate()) {
    mates++;
    const first = review[0].explanation.best;
    assert.equal(first.evalLabel, `#${solverColor === 'w' ? review.length : -review.length}`,
      `${where}: mate distance must match the known solution`);
    assert.equal(first.reasons[0].key, 'reason.mate', `${where}: a forced mate must be stated first`);
    assert.match(first.reasons[0].line, /^\d+\.(\.\.)? /, `${where}: the mating line must be shown`);
  }
}

console.log(`ok  ${PUZZLES.length} puzzles replay legally with chess.js`);
console.log(`ok  ${solverMoves} solver moves explained from the known solution`);
console.log(`ok  ${mates} puzzles end in mate, each announced at the right distance`);
