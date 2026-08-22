/**
 * Differential test: the TypeScript port in src/analysis.ts must produce the
 * same facts as the Python PoC it was ported from, on the PoC's own validation
 * positions, for every move Stockfish actually suggests there.
 *
 * Needs python3 with `pip install python-chess` (no Stockfish binary — the PV
 * comes from the WASM engine here and is handed to the PoC).
 * Run: node test-analysis.mjs
 */
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { Chess } from 'chess.js';

const ENGINE = 'node_modules/stockfish/bin/stockfish-18-lite-single.js';
const POC = '../chess_explainer';
const INFO_RE =
  /^info .*?\bmultipv (\d+).*?\bscore (cp|mate) (-?\d+).*?\bpv ((?:[a-h][1-8][a-h][1-8][qrbn]?\s?)+)/;

/** Positions replayed from SAN, never hand-typed FENs — the PoC's own rule. */
const fromSan = (san) => {
  const g = new Chess();
  san.forEach((m) => g.move(m));
  return g.fen();
};

const POSITIONS = [
  ["Legal's Mate", fromSan(['e4', 'e5', 'Nf3', 'd6', 'Bc4', 'Bg4', 'Nc3', 'g6', 'Nxe5', 'Bxd1'])],
  [
    "Boden's Mate",
    fromSan([
      'e4', 'd5', 'exd5', 'Qxd5', 'Nc3', 'Qa5', 'd4', 'c6', 'Nf3', 'Bg4',
      'Bf4', 'e6', 'h3', 'Bxf3', 'Qxf3', 'Bb4', 'Be2', 'Nd7', 'a3', 'O-O-O',
      'axb4', 'Qxa1+', 'Kd2', 'Qxh1',
    ]),
  ],
  ['Morphy Opera Game', '4kb1r/p2n1ppp/4q3/4p1B1/4P3/1Q6/PPP2PPP/2KR4 w k - 1 17'],
  ['Knight royal fork', 'r3k2r/8/8/3N4/8/8/8/4K3 w kq - 0 1'],
  ['Quiet opening', 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2'],
  ['Two kings', '8/8/4k3/8/8/4K3/8/8 w - - 0 1'],
  ['Back rank mate', '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1'],
  ['Black to move', fromSan(['e4'])],
];

function engine() {
  const p = spawn('node', [ENGINE]);
  let buf = '';
  const listeners = new Set();
  p.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    lines.forEach((line) => listeners.forEach((l) => l(line)));
  });
  return {
    send: (c) => p.stdin.write(c + '\n'),
    onLine: (l) => listeners.add(l),
    offLine: (l) => listeners.delete(l),
    kill: () => p.kill(),
  };
}

/** Same shape and White-POV normalisation as ChessEngine.analyze(). */
function multipv(e, fen, depth = 12, count = 3) {
  const whiteToMove = fen.split(' ')[1] === 'w';
  return new Promise((resolve) => {
    const lines = new Map();
    const listener = (line) => {
      if (line.startsWith('bestmove')) {
        e.offLine(listener);
        return resolve([...lines].sort(([a], [b]) => a - b).map(([, v]) => v));
      }
      if (line.includes('bound')) return;
      const m = INFO_RE.exec(line);
      if (!m) return;
      const value = Number(m[3]) * (whiteToMove ? 1 : -1);
      const pv = m[4].trim().split(/\s+/);
      lines.set(Number(m[1]), {
        moveUci: pv[0],
        isMate: m[2] === 'mate',
        mateIn: m[2] === 'mate' ? value : null,
        scoreCp: m[2] === 'cp' ? value : null,
        pv,
      });
    };
    e.onLine(listener);
    e.send(`setoption name MultiPV value ${count}`);
    e.send(`position fen ${fen}`);
    e.send(`go depth ${depth}`);
  });
}

/** Same shape the PoC dumper emits, so the two can be deep-compared. */
const normalize = (f) => ({
  san: f.san,
  is_fork: f.fork.isFork,
  fork_targets: f.fork.targets.map((t) => t.square).sort(),
  new_pins: [...f.newPins].sort(),
  undefended: f.undefended.map((u) => u.square).sort(),
  safe_squares: f.safeSquares,
  central_gained: [...f.central.gained].sort(),
  ks_increase: f.kingSafety.increase,
  gives_check: f.kingSafety.givesCheck,
  pawns: f.pawnStructure,
  swing: f.swing,
  trend: {
    new_passed: f.trend.newPassedPawns,
    ks_start: f.trend.kingSafety.start,
    ks_end: f.trend.kingSafety.end,
    significant: f.trend.kingSafety.isSignificant,
  },
});

// --- compile the TS port so node can import it -------------------------------
const tsc = spawnSync(
  process.execPath,
  ['node_modules/typescript/bin/tsc', 'src/analysis.ts', '--ignoreConfig', '--outDir', '.tmp',
   '--module', 'esnext', '--target', 'es2022', '--moduleResolution', 'bundler', '--skipLibCheck'],
  { encoding: 'utf8' },
);
assert.equal(tsc.status, 0, `tsc failed:\n${tsc.stdout}${tsc.stderr}`);
const { buildMoveFacts, classify, continuationOf, explain, parseMove, refute, winPercent } =
  await import('./.tmp/analysis.js');

// --- collect the engine's suggestions ----------------------------------------
const e = engine();
await new Promise((resolve) => {
  const l = (line) => line.startsWith('uciok') && (e.offLine(l), resolve());
  e.onLine(l);
  e.send('uci');
});

const tasks = [];
const searches = new Map();
for (const [name, fen] of POSITIONS) {
  const lines = await multipv(e, fen);
  searches.set(name, lines);
  for (const line of lines) {
    tasks.push({ name, fen, move_uci: line.moveUci, pv: line.pv });
  }
}

// A move that throws away a won game: Qd7+?? hangs the queen next to the enemy
// king and the win evaporates. The engine never returns it among its top moves,
// so this is the path that needs a real search of the resulting position.
const BLUNDER_FEN = '4k3/8/8/8/8/8/3Q4/4K3 w - - 0 1';
const blunderBest = (await multipv(e, BLUNDER_FEN, 14, 1))[0];
assert.ok(blunderBest, 'the K+Q vs K position must produce a search result');
const afterBlunder = new Chess(BLUNDER_FEN);
afterBlunder.move({ from: 'd2', to: 'd7', promotion: 'q' });
const blunderReply = (await multipv(e, afterBlunder.fen(), 14, 1))[0];
e.kill();
assert.ok(tasks.length >= 15, `expected a decent sample, got ${tasks.length} moves`);

// --- run both implementations and diff ---------------------------------------
const mine = tasks.map((t) => normalize(buildMoveFacts(t.fen, {
  moveUci: t.move_uci, isMate: false, mateIn: null, scoreCp: 0, pv: t.pv,
})));

const poc = spawnSync('python3', ['poc_facts.py'], {
  cwd: POC,
  input: JSON.stringify(tasks),
  encoding: 'utf8',
});
assert.equal(poc.status, 0, `PoC dumper failed:\n${poc.stderr}`);
const theirs = JSON.parse(poc.stdout);

let failed = 0;
tasks.forEach((task, i) => {
  try {
    assert.deepStrictEqual(mine[i], theirs[i]);
    console.log(`ok  ${task.name.padEnd(20)} ${theirs[i].san}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${task.name} ${task.move_uci}\n${err.message}`);
  }
});

assert.equal(failed, 0, `${failed}/${tasks.length} positions differ from the PoC`);
console.log(`\n${tasks.length} moves match the Python PoC exactly`);

// --- explanation assembly ----------------------------------------------------
const morphy = tasks.find((t) => t.name === 'Morphy Opera Game');
const mateLine = { moveUci: morphy.move_uci, isMate: true, mateIn: 2, scoreCp: null, pv: morphy.pv };
const mate = explain(morphy.fen, [mateLine]);
assert.equal(mate.best.evalLabel, '#2');
assert.equal(mate.best.reasons[0].key, 'reason.mate');
// Rule 1: a forced mate suppresses the local fork/check/pressure facts.
assert.ok(
  !mate.best.reasons.some((r) => ['reason.fork', 'reason.forkCheck', 'reason.check'].includes(r.key)),
  'forced mate must suppress local tactical reasons',
);

const quiet = tasks.find((t) => t.name === 'Quiet opening');
const calm = explain(quiet.fen, [
  { moveUci: quiet.move_uci, isMate: false, mateIn: null, scoreCp: 31, pv: quiet.pv },
]);
assert.equal(calm.best.evalLabel, '+0.31');
assert.ok(calm.best.reasons.length > 0);
assert.ok(calm.best.reasons.every((r) => r.key.startsWith('reason.')));
console.log('ok  explanation assembly');

// --- "…the line…" tooltips ---------------------------------------------------
const LINE_KEYS = [
  'reason.mate', 'reason.sacrifice', 'reason.combination',
  'reason.passedPawn', 'reason.sustainedPressure',
];

/** A tooltip is only useful if its moves actually replay from the position. */
function assertReplayable(fen, line) {
  const g = new Chess(fen);
  for (const token of line.split(/\s+/)) {
    if (/^\d+\.(\.\.)?$/.test(token)) continue; // move number
    g.move(token); // throws if the SAN is wrong for this position
  }
}

for (const [label, explained, fen] of [
  ['mate', mate, morphy.fen],
  ['quiet', calm, quiet.fen],
]) {
  for (const r of explained.best.reasons) {
    if (LINE_KEYS.includes(r.key)) {
      assert.ok(r.line, `${label}: ${r.key} must carry the line`);
      assertReplayable(fen, r.line);
    } else {
      assert.equal(r.line, undefined, `${label}: ${r.key} is a single-move fact, no line`);
    }
  }
}
assert.match(mate.best.reasons[0].line, /^17\. Qb8\+ /);

// Numbering must survive a black-to-move position.
const black = tasks.find((t) => t.name === 'Black to move');
const blackLine = explain(black.fen, [
  { moveUci: black.move_uci, isMate: false, mateIn: null, scoreCp: -20, pv: black.pv },
]);
const facts = buildMoveFacts(black.fen, {
  moveUci: black.move_uci, isMate: false, mateIn: null, scoreCp: -20, pv: black.pv,
});
assert.match(facts.pvSan, /^1\.\.\. /, `black-to-move PV must start with "1... ", got ${facts.pvSan}`);
assertReplayable(black.fen, facts.pvSan);
assert.equal(blackLine.best.evalLabel, '-0.20');
console.log(`ok  line tooltips            ${mate.best.reasons[0].line}`);
console.log(`ok  black numbering          ${facts.pvSan}`);

// --- move classification -----------------------------------------------------
assert.equal(Math.round(winPercent(0)), 50);
assert.ok(winPercent(300) > winPercent(100) && winPercent(100) > 50);
assert.ok(winPercent(-300) < 50);
assert.equal(classify(0), 'good');
assert.equal(classify(9.9), 'good');
assert.equal(classify(10), 'inaccuracy');
assert.equal(classify(20), 'mistake');
assert.equal(classify(30), 'blunder');

// --- counterfactual ----------------------------------------------------------
// The best move is never a mistake against itself.
for (const [name, lines] of searches) {
  const fen = POSITIONS.find(([n]) => n === name)[1];
  const self = refute(fen, lines[0].moveUci, lines[0], continuationOf(lines[0]));
  if (self) {
    assert.equal(self.verdict, 'best', `${name}: the top move must classify as best`);
    assert.equal(self.lossPct, 0, `${name}: the top move cannot cost anything`);
  }
  // Every runner-up is refuted from its own PV — no extra search.
  for (const line of lines.slice(1)) {
    const r = refute(fen, line.moveUci, lines[0], continuationOf(line));
    if (!r) continue;
    assert.ok(r.lossPct >= 0, `${name} ${r.san}: loss cannot be negative`);
    assert.ok(
      ['best', 'good', 'inaccuracy', 'mistake', 'blunder'].includes(r.verdict),
      `${name} ${r.san}: unknown verdict ${r.verdict}`,
    );
    if (r.punishment) {
      // Both must be legal, in order: the candidate, then the punishing reply.
      const board = new Chess(fen);
      board.move(r.san);
      board.move(r.punishment.san); // throws if the refutation isn't playable
    }
  }
}
console.log('ok  alternatives refuted from their own PV');

const blunder = refute(BLUNDER_FEN, 'd2d7', blunderBest, blunderReply);
assert.equal(blunder.san, 'Qd7+');
assert.equal(blunder.verdict, 'blunder', `expected a blunder, got ${blunder.verdict} (-${blunder.lossPct}%)`);
assert.ok(blunder.lossPct >= 30, `blunder must cost >=30% win probability, got ${blunder.lossPct}`);
assert.equal(blunder.punishment.san, 'Kxd7', 'the refutation is simply taking the queen');
console.log(`ok  hung queen               Qd7+ -> ${blunder.punishment.san}, -${blunder.lossPct}% (${blunder.verdict})`);

// --- every numeric claim keeps its metric on screen --------------------------
const NEEDS_DETAIL = [
  'reason.fork', 'reason.forkCheck', 'reason.undefended', 'reason.kingPressure',
  'reason.centerPressure', 'reason.combination', 'reason.passedPawn',
  'reason.sustainedPressure', 'reason.sacrifice',
];
const seen = new Set();
for (const [name, lines] of searches) {
  const fen = POSITIONS.find(([n]) => n === name)[1];
  for (const line of lines) {
    for (const r of explain(fen, [line]).best.reasons) {
      seen.add(r.key);
      if (NEEDS_DETAIL.includes(r.key)) {
        assert.ok(r.detail?.key, `${r.key} states a number, so it must carry its detail`);
      }
    }
  }
}
assert.ok(seen.size >= 5, `expected the sample to exercise several reasons, saw ${seen.size}`);
console.log(`ok  reasons keep their metric  (${seen.size} distinct reasons exercised)`);

// --- typing a move into "why not…" -------------------------------------------
const START = new Chess().fen();
const CASTLE = fromSan(['e4', 'e5', 'Nf3', 'Nf6', 'Bc4', 'Bc5']); // White may castle
const PROMOTE = '4k3/P7/8/8/8/8/8/4K3 w - - 0 1';

for (const [fen, input, uci, san] of [
  [START, 'e4', 'e2e4', 'e4'],
  [START, 'Nf3', 'g1f3', 'Nf3'],
  [START, 'g1f3', 'g1f3', 'Nf3'],       // UCI accepted too
  [START, '  Nf3  ', 'g1f3', 'Nf3'],    // whitespace tolerated
  [CASTLE, 'O-O', 'e1g1', 'O-O'],
  [CASTLE, '0-0', 'e1g1', 'O-O'],       // zeros normalised to letters
  [PROMOTE, 'a8=Q', 'a7a8q', 'a8=Q+'],   // promoting also checks here
  [PROMOTE, 'a7a8q', 'a7a8q', 'a8=Q+'],
]) {
  const parsed = parseMove(fen, input);
  assert.deepStrictEqual(parsed, { uci, san }, `parseMove(${JSON.stringify(input)})`);
}

// A well-formed move the position rejects is an illegal move, not a typo.
for (const input of ['e5', 'Qh5', 'Nf6', 'O-O', 'a1a8']) {
  assert.equal(parseMove(START, input), 'illegal', `${input} must read as illegal`);
}
// Anything that isn't move-shaped is a notation problem.
for (const input of ['', '   ', 'banana', 'Nf9', 'e4e4e4', '??', 'x']) {
  assert.equal(parseMove(START, input), 'notation', `${input} must read as bad notation`);
}
console.log('ok  typed-move parsing');

// A typed move feeds the same refutation path as a hovered or engine one.
const typed = parseMove(BLUNDER_FEN, 'Qd7+');
assert.deepStrictEqual(typed, { uci: 'd2d7', san: 'Qd7+' });
const typedRefutation = refute(BLUNDER_FEN, typed.uci, blunderBest, blunderReply);
assert.deepStrictEqual(typedRefutation, blunder, 'typing a move must give the same verdict as hovering it');
console.log('ok  typed move -> same refutation as hovered');
