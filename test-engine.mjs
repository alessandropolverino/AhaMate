/**
 * One runnable check: drive a real Stockfish process with the same strength
 * commands the browser worker sends, and assert it plays legal moves through
 * the same clone-replay helper the UI uses.
 * Run: node test-engine.mjs
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { Chess } from 'chess.js';
import { LEVELS, keyForElo, strengthCommands } from './src/strength.js';

const ENGINE = 'node_modules/stockfish/bin/stockfish-18-lite-single.js';
const FEN = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR b KQkq - 3 3';

/** Mirrors App.tsx's `play`: chess.js has no clone, so replay from PGN. */
function play(prev, mutate) {
  const next = new Chess();
  next.loadPgn(prev.pgn());
  try {
    mutate(next);
  } catch {
    return prev;
  }
  return next;
}

function engine() {
  const p = spawn('node', [ENGINE]);
  let buf = '';
  const waiters = [];
  p.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      for (const w of [...waiters]) {
        const m = w.re.exec(line);
        if (m) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(m[1] ?? line);
        }
      }
    }
  });
  return {
    send: (c) => p.stdin.write(c + '\n'),
    wait: (re) => new Promise((resolve) => waiters.push({ re, resolve })),
    kill: () => p.kill(),
  };
}

// --- pure strength mapping ---------------------------------------------------
assert.equal(keyForElo(610), 'level.beginner');
assert.equal(keyForElo(3190), 'level.master');
assert.match(strengthCommands(2200).options[1], /UCI_Elo value 2200$/);
assert.equal(strengthCommands(4000).options[1], 'setoption name UCI_Elo value 3190');
assert.equal(strengthCommands(1319).options[0], 'setoption name UCI_LimitStrength value false');
assert.match(strengthCommands(600).options[1], /Skill Level value 4$/);
assert.match(strengthCommands(600).go, /^go depth [1-7]$/);

// --- clone-replay helper -----------------------------------------------------
{
  let g = new Chess();
  g = play(g, (n) => n.move({ from: 'e2', to: 'e4', promotion: 'q' }));
  g = play(g, (n) => n.move({ from: 'e7', to: 'e5', promotion: 'q' }));
  assert.deepEqual(g.history(), ['e4', 'e5']);
  assert.equal(play(g, (n) => n.move({ from: 'a1', to: 'a8' })), g, 'illegal move must be a no-op');
  g = play(g, (n) => {
    n.undo();
    n.undo();
  });
  assert.deepEqual(g.history(), [], 'takeback must undo both plies');
}

// --- real engine, every preset ----------------------------------------------
const e = engine();
const uciok = e.wait(/^uciok/);
e.send('uci');
await uciok;

for (const { key, elo } of LEVELS) {
  const { options, go } = strengthCommands(elo);
  options.forEach(e.send);
  const answer = e.wait(/^bestmove (\S+)/);
  e.send(`position fen ${FEN}`);
  e.send(go);
  const uci = await answer;

  const before = new Chess(FEN);
  const after = play(before, (g) =>
    g.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: 'q' }),
  );
  assert.notEqual(after, before, `${key}: ${uci} is not a legal move`);
  console.log(`ok  ${key.padEnd(20)} ${String(elo).padStart(4)} Elo -> ${after.history()[0]}`);
}

e.kill();
console.log('\nall checks passed');
