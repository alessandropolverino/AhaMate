import { useEffect, useMemo, useState } from 'react';
import { Chess, type Square } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import type { PieceDropHandlerArgs, SquareHandlerArgs } from 'react-chessboard';
import { DARK_SQUARE, HIGHLIGHT, HINT, LIGHT_SQUARE, squareStylesFor } from './board';
import { PUZZLES, isSolverPly, puzzleUrl, reviewOf, uciToMove, type Puzzle } from './puzzle';
import { MoveEvaluator, Reason, type T } from './Reasons';
import { useEvaluator } from './useEvaluator';

const randomPuzzle = () => PUZZLES[Math.floor(Math.random() * PUZZLES.length)];

/**
 * One puzzle, start to finish. Remounted per puzzle (keyed by id), so every
 * bit of play state simply starts fresh instead of being reset by an effect.
 */
function PuzzleRunner({ t, puzzle, onNext }: { t: T; puzzle: Puzzle; onNext: () => void }) {
  const moves = useMemo(() => puzzle.moves.split(' '), [puzzle]);
  const [game, setGame] = useState(() => new Chess(puzzle.fen));
  const [ply, setPly] = useState(0);
  const [hint, setHint] = useState(0);
  const [wrong, setWrong] = useState(false);
  const [selected, setSelected] = useState<Square | null>(null);
  /** Which reviewed move the board is rewound to, once the puzzle is solved. */
  const [step, setStep] = useState<number | null>(null);

  const solved = ply >= moves.length;
  const solverTurn = !solved && isSolverPly(ply);
  const expected = solved ? null : moves[ply];
  const solverColor = new Chess(puzzle.fen).turn() === 'w' ? 'b' : 'w';

  const applyUci = (uci: string) =>
    setGame((prev) => {
      const next = new Chess();
      next.loadPgn(prev.pgn());
      next.move(uciToMove(uci));
      return next;
    });

  // Plays every move that isn't the solver's: the opening move that sets the
  // puzzle up (ply 0) and each of the opponent's replies.
  useEffect(() => {
    if (solved || isSolverPly(ply)) return;
    const timer = setTimeout(() => {
      applyUci(moves[ply]);
      setPly((n) => n + 1);
    }, ply === 0 ? 600 : 400);
    return () => clearTimeout(timer);
  }, [ply, moves, solved]);

  const tryMove = (from: string, to: string) => {
    if (!solverTurn || !expected) return false;
    // ponytail: only the database's own solution is accepted. On a mate-in-one
    // a different mating move would also win — accept alternatives here if
    // players complain, but it needs the review to follow the move played.
    if (`${from}${to}` !== expected.slice(0, 4)) {
      setWrong(true);
      setSelected(null);
      return false;
    }
    applyUci(expected);
    setPly((n) => n + 1);
    setHint(0);
    setWrong(false);
    setSelected(null);
    return true;
  };

  const onSquareClick = ({ square }: SquareHandlerArgs) => {
    if (!solverTurn) return;
    const sq = square as Square;
    if (selected && tryMove(selected, sq)) return;
    const piece = game.get(sq);
    setSelected(piece && piece.color === solverColor ? sq : null);
  };

  const squareStyles = useMemo(() => {
    const styles = squareStylesFor(game, selected);
    if (hint >= 1 && expected) {
      const from = expected.slice(0, 2);
      styles[from] = { ...styles[from], ...HINT };
    }
    return styles;
  }, [game, selected, hint, expected]);

  const arrows =
    hint >= 2 && expected
      ? [{ startSquare: expected.slice(0, 2), endSquare: expected.slice(2, 4), color: '#81b64c' }]
      : [];

  const review = useMemo(() => (solved ? reviewOf(puzzle) : []), [solved, puzzle]);

  // Rewinding shows the position the move was played FROM, with the move drawn
  // on top — an arrow on the position after it would point at nothing.
  const rewound = step !== null ? review[step] : undefined;
  const shownFen = rewound ? rewound.fen : game.fen();
  const shownArrows = rewound
    ? [
        {
          startSquare: rewound.explanation.best.from,
          endSquare: rewound.explanation.best.to,
          color: '#81b64c',
        },
      ]
    : arrows;
  const shownStyles = rewound
    ? {
        [rewound.explanation.best.from]: HIGHLIGHT,
        [rewound.explanation.best.to]: HIGHLIGHT,
      }
    : squareStyles;

  // Scored from whatever position is on the board: the live one while you are
  // solving, the one a review step is rewound to once you are done.
  const evaluator = useEvaluator(shownFen, null);

  const statusKey = solved
    ? 'puzzle.solved'
    : wrong
      ? 'puzzle.wrong'
      : solverTurn
        ? 'puzzle.findMove'
        : 'puzzle.opponentMoving';

  const themeLabel = (id: string) => {
    const translated = t(`theme.${id}`);
    return translated === `theme.${id}` ? id : translated;
  };

  return (
    <div className="app">
      <main className="board-area">
        <div className="player-tag">
          {t('puzzle.rating')} {puzzle.rating}
        </div>
        <div className="board">
          <Chessboard
            options={{
              id: 'puzzle-board',
              position: shownFen,
              boardOrientation: solverColor === 'w' ? 'white' : 'black',
              onPieceDrop: ({ sourceSquare, targetSquare }: PieceDropHandlerArgs) =>
                targetSquare ? tryMove(sourceSquare, targetSquare) : false,
              onSquareClick,
              squareStyles: shownStyles,
              arrows: shownArrows,
              allowDragging: solverTurn,
              darkSquareStyle: DARK_SQUARE,
              lightSquareStyle: LIGHT_SQUARE,
              animationDurationInMs: 180,
            }}
          />
        </div>
        <div className="player-tag">
          {t('puzzle.youPlay', { color: t(solverColor === 'w' ? 'label.white' : 'label.black') })}
        </div>
      </main>

      <aside className="panel">
        <div className={wrong ? 'status is-wrong' : solved ? 'status is-solved' : 'status'}>
          {t(statusKey)}
        </div>

        {!solved && (
          <section className="actions">
            <button type="button" className="btn" onClick={() => setHint((h) => Math.min(2, h + 1))} disabled={!solverTurn || hint >= 2}>
              {t('puzzle.hint')}
            </button>
            {hint >= 1 && <p className="muted">{t(hint >= 2 ? 'puzzle.hintMove' : 'puzzle.hintPiece')}</p>}
          </section>
        )}

        {solved && (
          <section className="review">
            <h3>{t('puzzle.review')}</h3>
            <p className="muted">{t('puzzle.stepHint')}</p>
            {review.map((item, i) => (
              <div key={item.explanation.best.san + i} className="review-step">
                <button
                  type="button"
                  className={i === step ? 'review-head active' : 'review-head'}
                  aria-pressed={i === step}
                  onClick={() => setStep((current) => (current === i ? null : i))}
                >
                  <span className="tag">{t('puzzle.moveN', { n: i + 1 })}</span>
                  <strong className="san">{item.explanation.best.san}</strong>
                </button>
                <ul className="reasons">
                  {item.explanation.best.reasons.map((msg) => (
                    <Reason key={msg.key} t={t} msg={msg} />
                  ))}
                </ul>
              </div>
            ))}
            <div className="themes">
              <span className="tag">{t('puzzle.themes')}</span>
              {puzzle.themes.map((th) => (
                <span key={th} className="chip">
                  {themeLabel(th)}
                </span>
              ))}
            </div>
          </section>
        )}

        <section className="analysis">
          <MoveEvaluator t={t} ev={evaluator} hintKey="puzzle.askHint" />
        </section>

        <section className="actions">
          <button type="button" className="btn primary" onClick={onNext}>
            {t('puzzle.next')}
          </button>
        </section>

        <p className="muted">
          {t('puzzle.source')}{' '}
          <a href={puzzleUrl(puzzle)} target="_blank" rel="noreferrer">
            {puzzle.id}
          </a>
        </p>
      </aside>
    </div>
  );
}

export function Puzzles({ t }: { t: T }) {
  const [puzzle, setPuzzle] = useState(randomPuzzle);
  return (
    <PuzzleRunner key={puzzle.id} t={t} puzzle={puzzle} onNext={() => setPuzzle(randomPuzzle())} />
  );
}
