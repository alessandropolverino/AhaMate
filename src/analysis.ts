/**
 * TypeScript port of the `chess_explainer` Python PoC: single-move tactical /
 * strategic / pawn-structure facts, plus PV-level aggregation, turned into
 * translatable explanation messages.
 *
 * Definitions and thresholds are carried over verbatim from the PoC README
 * (piece values, "winnable target" fork rule, Fruit-style king-safety attack
 * units, 4-ply tactical-swing window). What is rewritten rather than
 * translated is the board API: python-chess's `attacks()` / `is_pinned()`
 * have no chess.js equivalent, so both are derived from `attackers()` below.
 *
 * Known limitations inherited from the PoC (see its README): no
 * sacrifice/deflection detection, `undefended` is a static fact and not a
 * threat assessment, and `pin` has no validated true-positive case yet.
 */

import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js';
import type { Msg } from './i18n';

export type EngineLine = {
  moveUci: string;
  isMate: boolean;
  mateIn: number | null;
  scoreCp: number | null; // both from White's point of view
  pv: string[];
};

/** Classic didactic scale. The king is handled as a special case, not a number. */
const PIECE_VALUES: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
/** Fruit-style weighted attack units (chessprogramming.org/King_Safety). */
const ATTACK_WEIGHT: Record<PieceSymbol, number> = { p: 1, n: 2, b: 2, r: 3, q: 5, k: 0 };
const CENTRAL_SQUARES = ['d4', 'e4', 'd5', 'e5'] as Square[];

const FILES = 'abcdefgh';
export const ALL_SQUARES: Square[] = FILES.split('').flatMap((f) =>
  [1, 2, 3, 4, 5, 6, 7, 8].map((r) => `${f}${r}` as Square),
);

const fileOf = (s: Square) => FILES.indexOf(s[0]);
const rankOf = (s: Square) => Number(s[1]) - 1;
const other = (c: Color): Color => (c === 'w' ? 'b' : 'w');

const GLYPHS: Record<string, string> = {
  wp: '♙', wn: '♘', wb: '♗', wr: '♖', wq: '♕', wk: '♔',
  bp: '♟', bn: '♞', bb: '♝', br: '♜', bq: '♛', bk: '♚',
};
const glyph = (color: Color, type: PieceSymbol) => GLYPHS[color + type] ?? type;
const named = (g: Chess, sq: Square) => {
  const p = g.get(sq);
  return p ? `${glyph(p.color, p.type)}${sq}` : sq;
};

/**
 * Squares attacked BY the piece on `from`.
 * chess.js has no `attacks()`, so invert its `attackers()` over the 64 squares
 * rather than re-deriving slider/knight/pawn geometry by hand.
 */
function attacksFrom(g: Chess, from: Square): Square[] {
  const piece = g.get(from);
  if (!piece) return [];
  return ALL_SQUARES.filter((sq) => g.attackers(sq, piece.color).includes(from));
}

/**
 * Absolutely pinned squares for `color`: removing the piece would expose its
 * king to one more attacker. Counting attackers (rather than a boolean
 * is-attacked check) keeps this correct when the king is already in check.
 */
function pinnedSquares(g: Chess, color: Color): Set<Square> {
  const king = g.findPiece({ type: 'k', color })[0];
  if (!king) return new Set();
  const enemy = other(color);
  const before = g.attackers(king, enemy).length;
  const pinned = new Set<Square>();
  for (const sq of ALL_SQUARES) {
    const piece = g.get(sq);
    if (!piece || piece.color !== color || piece.type === 'k') continue;
    g.remove(sq);
    if (g.attackers(king, enemy).length > before) pinned.add(sq);
    g.put(piece, sq);
  }
  return pinned;
}

/** FEN + candidate move, with the before/after boards the extractors share. */
class Position {
  readonly before: Chess;
  readonly after: Chess;
  readonly from: Square;
  readonly to: Square;
  readonly mover: Color;
  readonly opponent: Color;
  readonly type: PieceSymbol;
  readonly san: string;

  constructor(fen: string, moveUci: string) {
    this.before = new Chess(fen);
    this.from = moveUci.slice(0, 2) as Square;
    this.to = moveUci.slice(2, 4) as Square;
    const piece = this.before.get(this.from);
    if (!piece) throw new Error(`Illegal move: ${moveUci} in position ${fen}`);
    this.type = piece.type;
    this.mover = piece.color;
    this.opponent = other(this.mover);
    this.after = new Chess(fen);
    this.san = this.after.move({ from: this.from, to: this.to, promotion: moveUci[4] ?? 'q' }).san;
  }
}

// --- single-move facts -------------------------------------------------------

type ForkTarget = { square: Square; label: string; isCheck: boolean };

/**
 * A fork needs 2+ *winnable* targets: the enemy king, an undefended piece, or
 * a piece worth more than the attacker. Attacking an equal-or-higher-valued
 * DEFENDED piece does not count.
 */
function fork(pos: Position) {
  const attackerValue = PIECE_VALUES[pos.type];
  const targets: ForkTarget[] = [];
  for (const sq of attacksFrom(pos.after, pos.to)) {
    const target = pos.after.get(sq);
    if (!target || target.color !== pos.opponent) continue;
    if (target.type === 'k') {
      targets.push({ square: sq, label: named(pos.after, sq), isCheck: true });
      continue;
    }
    const defended = pos.after.attackers(sq, pos.opponent).length > 0;
    if (!defended || PIECE_VALUES[target.type] > attackerValue) {
      targets.push({ square: sq, label: named(pos.after, sq), isCheck: false });
    }
  }
  return { isFork: targets.length >= 2, targets };
}

/** New absolute pins created by the move. */
function pin(pos: Position) {
  const before = pinnedSquares(new Chess(pos.before.fen()), pos.opponent);
  const after = pinnedSquares(new Chess(pos.after.fen()), pos.opponent);
  return [...after].filter((sq) => !before.has(sq));
}

/**
 * Enemy pieces left attacked-and-undefended AFTER the move. This is a static
 * fact about the position, NOT a claim that the piece will be lost.
 */
function undefendedPieces(pos: Position) {
  return ALL_SQUARES.filter((sq) => {
    const piece = pos.after.get(sq);
    if (!piece || piece.color !== pos.opponent) return false;
    return (
      pos.after.attackers(sq, pos.mover).length > 0 &&
      pos.after.attackers(sq, pos.opponent).length === 0
    );
  }).map((sq) => ({ square: sq, label: named(pos.after, sq) }));
}

/** Safe destinations, excluding squares covered by an enemy pawn. */
function mobility(pos: Position) {
  const safe = attacksFrom(pos.after, pos.to).filter(
    (sq) => !pos.after.attackers(sq, pos.opponent).some((a) => pos.after.get(a)?.type === 'p'),
  );
  return safe.length;
}

const centralControl = (g: Chess, mover: Color) =>
  Object.fromEntries(CENTRAL_SQUARES.map((sq) => [sq, g.attackers(sq, mover).length]));

function centralControlDelta(pos: Position) {
  const before = centralControl(pos.before, pos.mover);
  const after = centralControl(pos.after, pos.mover);
  return { before, after, gained: CENTRAL_SQUARES.filter((sq) => after[sq] > before[sq]) };
}

const kingRing = (king: Square) =>
  ALL_SQUARES.filter(
    (s) =>
      s !== king &&
      Math.max(Math.abs(fileOf(s) - fileOf(king)), Math.abs(rankOf(s) - rankOf(king))) === 1,
  );

function attackUnits(g: Chess, ring: Square[], mover: Color) {
  let total = 0;
  let attackers = 0;
  for (const sq of ring) {
    for (const from of g.attackers(sq, mover)) {
      total += ATTACK_WEIGHT[g.get(from)!.type];
      attackers++;
    }
  }
  return { total, attackers };
}

function kingSafety(pos: Position) {
  // The ring is pinned to the PRE-move king square, as in the PoC.
  const king = pos.before.findPiece({ type: 'k', color: pos.opponent })[0];
  if (!king) return { increase: 0, givesCheck: pos.after.isCheck() };
  const ring = kingRing(king);
  const before = attackUnits(pos.before, ring, pos.mover).total;
  const after = attackUnits(pos.after, ring, pos.mover).total;
  return { increase: after - before, givesCheck: pos.after.isCheck() };
}

// --- pawn structure ----------------------------------------------------------

const pawnSquares = (g: Chess, color: Color) =>
  g.findPiece({ type: 'p', color }) as Square[];

function isolatedPawns(g: Chess, color: Color) {
  const pawns = pawnSquares(g, color);
  const files = new Set(pawns.map(fileOf));
  return pawns.filter((sq) => !files.has(fileOf(sq) - 1) && !files.has(fileOf(sq) + 1));
}

function doubledPawns(g: Chess, color: Color) {
  const pawns = pawnSquares(g, color);
  return pawns.filter((sq) => pawns.filter((o) => fileOf(o) === fileOf(sq)).length > 1);
}

function passedPawns(g: Chess, color: Color) {
  const enemy = pawnSquares(g, other(color));
  return pawnSquares(g, color).filter(
    (sq) =>
      !enemy.some(
        (e) =>
          Math.abs(fileOf(e) - fileOf(sq)) <= 1 &&
          (color === 'w' ? rankOf(e) > rankOf(sq) : rankOf(e) < rankOf(sq)),
      ),
  );
}

const newlySeen = (before: Square[], after: Square[]) =>
  after.filter((sq) => !before.includes(sq)).sort();

function pawnStructure(pos: Position) {
  const forColor = (color: Color) => ({
    isolated: newlySeen(isolatedPawns(pos.before, color), isolatedPawns(pos.after, color)),
    doubled: newlySeen(doubledPawns(pos.before, color), doubledPawns(pos.after, color)),
    passed: newlySeen(passedPawns(pos.before, color), passedPawns(pos.after, color)),
  });
  return { mover: forColor(pos.mover), opponent: forColor(pos.opponent) };
}

// --- PV-level aggregation ----------------------------------------------------

function materialBalance(g: Chess) {
  return ALL_SQUARES.reduce((sum, sq) => {
    const p = g.get(sq);
    if (!p || p.type === 'k') return sum;
    return sum + (p.color === 'w' ? PIECE_VALUES[p.type] : -PIECE_VALUES[p.type]);
  }, 0);
}

/** Replays the PV, stopping at the first move the position rejects. */
function replay(fen: string, pv: string[], onStep?: (g: Chess, san: string) => void) {
  const g = new Chess(fen);
  for (const uci of pv) {
    try {
      const san = g.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] ?? 'q' }).san;
      onStep?.(g, san);
    } catch {
      break; // truncated / inconsistent PV tail
    }
  }
  return g;
}

/**
 * First ply within `maxPly` where material shifts by >= `threshold`.
 * The 4-ply window is deliberate: over a full PV, ordinary trades several
 * moves later produced false "swings" during the PoC's validation.
 */
function tacticalSwing(fen: string, pv: string[], threshold = 2, maxPly = 4) {
  const trace: { san: string | null; balance: number }[] = [
    { san: null, balance: materialBalance(new Chess(fen)) },
  ];
  replay(fen, pv.slice(0, maxPly), (g, san) =>
    trace.push({ san, balance: materialBalance(g) }),
  );
  for (let i = 1; i < trace.length; i++) {
    const delta = trace[i].balance - trace[i - 1].balance;
    // `ply` is 1-based within the PV: 1 is the move being explained, 2 the
    // opponent's reply to it. Material only ever moves on a capture, so a
    // LOSS for the mover can only land on an even ply — 2 when this very move
    // is the one being taken, later when a move further down the line is.
    if (Math.abs(delta) >= threshold) return { move: trace[i].san!, delta, ply: i };
  }
  return null;
}

/**
 * The PV as a numbered SAN string ("17. Qb8+ Nxb8 18. Rd8#"), for the tooltip
 * on the reasons that refer to the line rather than to the move itself.
 */
function pvToSan(fen: string, pv: string[]): string {
  const parts = fen.split(' ');
  let num = Number(parts[5]) || 1;
  let whiteToMove = parts[1] === 'w';
  const out: string[] = [];
  replay(fen, pv, (_, san) => {
    if (whiteToMove) {
      out.push(`${num}. ${san}`);
    } else {
      out.push(out.length === 0 ? `${num}... ${san}` : san);
      num++; // a full move ends after Black plays
    }
    whiteToMove = !whiteToMove;
  });
  return out.join(' ');
}

/** Strategic facts at the START vs the END of the PV — a trend, not a delta. */
function strategicTrend(fen: string, pv: string[], mover: Color, threshold = 3) {
  const start = new Chess(fen);
  const end = replay(fen, pv);
  const king = end.findPiece({ type: 'k', color: other(mover) })[0];
  const startKing = start.findPiece({ type: 'k', color: other(mover) })[0];
  const unitsStart = startKing ? attackUnits(start, kingRing(startKing), mover).total : 0;
  const unitsEnd = king ? attackUnits(end, kingRing(king), mover).total : 0;
  return {
    newPassedPawns: newlySeen(passedPawns(start, mover), passedPawns(end, mover)),
    kingSafety: {
      start: unitsStart,
      end: unitsEnd,
      isSignificant: unitsEnd - unitsStart >= threshold,
    },
  };
}

// --- orchestration -----------------------------------------------------------

export type MoveFacts = ReturnType<typeof buildMoveFacts>;

export function buildMoveFacts(fen: string, line: EngineLine) {
  const pos = new Position(fen, line.moveUci);
  // `swing` keeps the PoC's exact shape — test-analysis.mjs diffs it field by
  // field against the Python implementation — so the ply rides alongside it.
  const swing = tacticalSwing(fen, line.pv);
  return {
    san: pos.san,
    moveUci: line.moveUci,
    from: pos.from,
    to: pos.to,
    evalLabel: line.isMate ? `#${line.mateIn}` : formatCp(line.scoreCp),
    isMate: line.isMate,
    mateIn: line.mateIn,
    mover: pos.mover,
    fork: fork(pos),
    newPins: pin(pos),
    undefended: undefendedPieces(pos),
    safeSquares: mobility(pos),
    central: centralControlDelta(pos),
    kingSafety: kingSafety(pos),
    pawnStructure: pawnStructure(pos),
    swing: swing && { move: swing.move, delta: swing.delta },
    swingPly: swing?.ply ?? null,
    trend: strategicTrend(fen, line.pv, pos.mover),
    pvSan: pvToSan(fen, line.pv),
  };
}

const formatCp = (cp: number | null) =>
  cp === null ? '?' : `${cp >= 0 ? '+' : ''}${(cp / 100).toFixed(2)}`;
const signed = (n: number) => `${n >= 0 ? '+' : ''}${n}`;

export type Explanation = {
  best: { san: string; evalLabel: string; from: Square; to: Square; reasons: Msg[] };
};

const plain = (text: string) => ({ key: 'detail.plain', params: { text } });

/**
 * Text-design rules carried over from the PoC:
 * 1. A forced mate IS the explanation — local facts are suppressed as noise.
 * 2. Deduplicate: a fork that already reports a check doesn't also produce
 *    "gives check", and its targets don't reappear under "undefended".
 *
 * Every sentence keeps its raw metric in `detail`: the phrasing is didactic,
 * but the number it rests on stays on screen, so no claim is unauditable.
 */
export function explain(fen: string, lines: EngineLine[]): Explanation | null {
  if (lines.length === 0) return null;
  const best = buildMoveFacts(fen, lines[0]);
  const reasons: Msg[] = [];
  /** Reasons about the engine's line get it as a tooltip; single-move facts don't. */
  const line = best.pvSan || undefined;

  if (best.isMate) {
    // `mateIn` counts from BEFORE the move, this one included; the sentence
    // describes what the move does, so it counts what is left AFTER it.
    const moverMates = (best.mateIn ?? 0) > 0 === (best.mover === 'w');
    const left = Math.abs(best.mateIn ?? 0) - 1;
    reasons.push(
      moverMates && left === 0
        ? { key: 'reason.matesNow', line }
        : { key: moverMates ? 'reason.mate' : 'reason.getsMated', params: { n: moverMates ? left : Math.abs(best.mateIn ?? 0) }, line },
    );
    // Material given up is only a SACRIFICE when it buys the mate: if the
    // swing hands material TO the mover, or the mate is against them, then
    // nothing is being sacrificed and the mate alone is the explanation.
    const cost = best.swing ? (best.mover === 'w' ? -best.swing.delta : best.swing.delta) : 0;
    if (best.swing && moverMates && cost > 0) {
      reasons.push({
        // The swing rarely lands on the move being explained: this move is the
        // sacrifice only when the opponent takes on the very next ply.
        key: best.swingPly === 2 ? 'reason.sacrifice' : 'reason.sacrificePrepared',
        // Shown from the MOVER's side — the sentence is about what this move
        // gives up, so White's point of view would read as the opposite.
        detail: { key: 'detail.swing', params: { move: best.swing.move, delta: signed(-cost) } },
        line,
      });
    }
  } else {
    const forkChecks = best.fork.isFork && best.fork.targets.some((t) => t.isCheck);
    if (best.fork.isFork) {
      reasons.push({
        key: forkChecks ? 'reason.forkCheck' : 'reason.fork',
        detail: plain(best.fork.targets.map((t) => t.label).join(', ')),
      });
    }
    if (best.newPins.length > 0) reasons.push({ key: 'reason.pin' });

    const forkSquares = new Set(best.fork.targets.map((t) => t.square));
    const remaining = best.undefended.filter((u) => !forkSquares.has(u.square));
    if (remaining.length > 0) {
      reasons.push({
        key: 'reason.undefended',
        detail: plain(remaining.map((u) => u.label).join(', ')),
      });
    }

    if (best.kingSafety.givesCheck && !forkChecks) reasons.push({ key: 'reason.check' });
    if (best.kingSafety.increase > 0) {
      reasons.push({
        key: 'reason.kingPressure',
        detail: { key: 'detail.units', params: { units: signed(best.kingSafety.increase) } },
      });
    }
    if (best.central.gained.length > 0) {
      reasons.push({ key: 'reason.centerPressure', detail: plain(best.central.gained.join(', ')) });
    }
    if (best.swing) {
      reasons.push({
        key: 'reason.combination',
        detail: { key: 'detail.swing', params: { move: best.swing.move, delta: signed(best.swing.delta) } },
        line,
      });
    }
    if (best.trend.newPassedPawns.length > 0) {
      reasons.push({
        key: 'reason.passedPawn',
        detail: plain(best.trend.newPassedPawns.join(', ')),
        line,
      });
    }
    if (best.trend.kingSafety.isSignificant) {
      reasons.push({
        key: 'reason.sustainedPressure',
        detail: {
          key: 'detail.trend',
          params: { from: best.trend.kingSafety.start, to: best.trend.kingSafety.end },
        },
        line,
      });
    }
  }

  if (reasons.length === 0) reasons.push({ key: 'reason.default' });

  return {
    best: { san: best.san, evalLabel: best.evalLabel, from: best.from, to: best.to, reasons },
  };
}

// --- counterfactual: why not the move you had in mind ------------------------

/**
 * Lichess's documented centipawn → win-percentage curve
 * (lichess-org/lila, `WinPercent`). Judging a move by the win-percentage it
 * costs, rather than by raw centipawns, is what keeps "+9.0 → +7.0" from being
 * called a blunder while "+0.2 → −1.0" correctly is one.
 */
export const winPercent = (cp: number) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);

export type Verdict = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';

/** Lichess's published thresholds on the win-percentage drop. */
export function classify(lossPct: number): Verdict {
  if (lossPct >= 30) return 'blunder';
  if (lossPct >= 20) return 'mistake';
  if (lossPct >= 10) return 'inaccuracy';
  return 'good';
}

/** A line's win percentage for `mover`; a mate pins it to the extremes. */
function moverWinPercent(line: EngineLine, mover: Color): number {
  const white = line.isMate ? ((line.mateIn ?? 0) > 0 ? 100 : 0) : winPercent(line.scoreCp ?? 0);
  return mover === 'w' ? white : 100 - white;
}

export type Refutation = {
  uci: string;
  san: string;
  evalLabel: string;
  /** Win percentage given up versus the engine's move, already rounded. */
  lossPct: number;
  verdict: Verdict;
  /** The opponent's answer and what makes it strong — the actual "aha". */
  punishment: { san: string; reasons: Msg[]; line: string } | null;
};

/**
 * The continuation already sitting inside a MultiPV line: its score is the
 * eval of playing that move, and its PV tail starts with the opponent's reply.
 * Lets an alternative be refuted without spending a second search on it.
 */
export function continuationOf(line: EngineLine): EngineLine | null {
  return line.pv.length < 2 ? null : { ...line, moveUci: line.pv[1], pv: line.pv.slice(1) };
}

/**
 * Why `candidateUci` is worse than the engine's move: what it costs, and what
 * the opponent plays to punish it.
 *
 * `after` is the analysis of the position AFTER the candidate — its score is
 * the candidate's own eval, its PV starts with the refuting reply. Build it
 * with `continuationOf` for a MultiPV alternative, or from a fresh
 * `engine.analyze(fenAfterCandidate)` for a move the search never returned.
 */
export function refute(
  fen: string,
  candidateUci: string,
  bestLine: EngineLine,
  after: EngineLine | null,
): Refutation | null {
  if (!after) return null;
  const g = new Chess(fen);
  const mover = g.turn();
  let san: string;
  try {
    san = g.move({
      from: candidateUci.slice(0, 2),
      to: candidateUci.slice(2, 4),
      promotion: candidateUci[4] ?? 'q',
    }).san;
  } catch {
    return null; // not a legal move here
  }
  const fenAfter = g.fen();
  const lossPct = Math.max(0, moverWinPercent(bestLine, mover) - moverWinPercent(after, mover));
  const punishment = explain(fenAfter, [after]);
  return {
    uci: candidateUci,
    san,
    evalLabel: after.isMate ? `#${after.mateIn}` : formatCp(after.scoreCp),
    lossPct: Math.round(lossPct),
    verdict: candidateUci === bestLine.moveUci ? 'best' : classify(lossPct),
    punishment: punishment
      ? {
          san: punishment.best.san,
          reasons: punishment.best.reasons,
          line: pvToSan(fenAfter, after.pv),
        }
      : null,
  };
}

/**
 * Shape of a move in SAN or UCI. This is NOT the validator — chess.js is —
 * it only decides which error to show: gibberish gets "I don't understand this
 * notation", a well-formed move that the position rejects gets "not legal here".
 */
const LOOKS_LIKE_A_MOVE = /^(?:O-O(?:-O)?|[NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](?:=[NBRQ])?|[a-h][1-8][a-h][1-8][qrbn]?)$/i;

export type ParsedMove = { uci: string; san: string };

/**
 * Parses a move the user typed, in SAN ("Nf6", "exd5", "O-O") or UCI ("g8f6"),
 * and checks it against the position. Returns the reason on failure so the UI
 * can tell a typo apart from an illegal move.
 */
export function parseMove(fen: string, text: string): ParsedMove | 'notation' | 'illegal' {
  const input = text.trim().replace(/0/g, 'O').replace(/[+#]$/, '');
  if (!input) return 'notation';
  const uci = /^([a-h][1-8])([a-h][1-8])([qrbn]?)$/i.exec(input);
  const probe = new Chess(fen);
  try {
    const move = uci
      ? probe.move({
          from: uci[1].toLowerCase() as Square,
          to: uci[2].toLowerCase() as Square,
          promotion: (uci[3] || 'q').toLowerCase(),
        })
      : probe.move(input);
    return { uci: `${move.from}${move.to}${move.promotion ?? ''}`, san: move.san };
  } catch {
    return LOOKS_LIKE_A_MOVE.test(input) ? 'illegal' : 'notation';
  }
}
