/**
 * The move list is the way back into the game: clicking a cell rewinds the
 * board to the position its move was played from. That hangs entirely on the
 * ply index being the index into `history()` — off by one and every review
 * ends up describing the wrong move.
 *
 * Run: node test-board.mjs
 */
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { Chess } from 'chess.js';

const tsc = spawnSync(
  process.execPath,
  ['node_modules/typescript/bin/tsc', 'src/board.ts', '--ignoreConfig', '--outDir', '.tmp',
   '--module', 'esnext', '--target', 'es2022', '--moduleResolution', 'bundler', '--skipLibCheck'],
  { encoding: 'utf8' },
);
assert.equal(tsc.status, 0, `tsc failed:\n${tsc.stdout}${tsc.stderr}`);
const { movePairs } = await import('./.tmp/board.js');

const game = new Chess();
['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4'].forEach((m) => game.move(m));
const verbose = game.history({ verbose: true });
const rows = movePairs(game.history());

// An odd-length game leaves Black's last cell empty, not a phantom move.
assert.equal(rows.length, 4);
assert.equal(rows[3].black, null, 'a half-finished move pair must leave an empty cell');
assert.equal(rows[0].n, 1, 'move numbers are 1-based');

for (const row of rows) {
  for (const [side, cell] of [['w', row.white], ['b', row.black]]) {
    if (!cell) continue;
    const move = verbose[cell.ply];
    assert.equal(cell.san, move.san, `row ${row.n} ${side}: cell and history disagree`);
    assert.equal(move.color, side, `row ${row.n}: ${move.san} is on the wrong side of the row`);
    // What the board rewinds to, and the arrow it draws there.
    const board = new Chess(move.before);
    assert.equal(board.move(move.san).san, move.san,
      `${move.san} must be legal in the position the click rewinds to`);
  }
}
console.log(`ok  ${verbose.length} plies map to their own row, cell and position`);
