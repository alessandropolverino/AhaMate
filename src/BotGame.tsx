import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chess, type Square } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import type { PieceDropHandlerArgs, SquareHandlerArgs } from 'react-chessboard';
import { AnalysisPanel } from './AnalysisPanel';
import type { Annotation } from './Reasons';
import { DARK_SQUARE, HIGHLIGHT, LIGHT_SQUARE, movePairs, squareStylesFor } from './board';
import {
  continuationOf,
  explain,
  parseMove,
  refute,
  type EngineLine,
  type Explanation,
  type Refutation,
} from './analysis';
import { ChessEngine, ELO_MAX, ELO_MIN, LEVELS, keyForElo } from './engine';
import type { Params } from './i18n';

type Color = 'w' | 'b';

function statusKey(game: Chess, playerColor: Color, thinking: boolean): string {
  if (game.isCheckmate()) return game.turn() === playerColor ? 'status.lost' : 'status.won';
  if (game.isStalemate()) return 'status.stalemate';
  if (game.isInsufficientMaterial()) return 'status.insufficient';
  if (game.isThreefoldRepetition()) return 'status.repetition';
  if (game.isDraw()) return 'status.draw';
  if (thinking) return 'status.thinking';
  if (game.inCheck()) return game.turn() === playerColor ? 'status.inCheck' : 'status.check';
  return game.turn() === playerColor ? 'status.yourTurn' : 'status.engineTurn';
}

type Props = { t: (key: string, params?: Params) => string };

export default function BotGame({ t }: Props) {
  const engineRef = useRef<ChessEngine | null>(null);
  const analystRef = useRef<ChessEngine | null>(null);
  const searchRef = useRef(0);

  const [game, setGame] = useState(() => new Chess());
  const [selected, setSelected] = useState<Square | null>(null);
  const [thinking, setThinking] = useState(false);
  const [playerColor, setPlayerColor] = useState<Color>('w');
  const [elo, setElo] = useState(1400);
  const [assist, setAssist] = useState(false);
  /** Tagged with the FEN it describes, so a stale analysis is never shown. */
  const [analysis, setAnalysis] = useState<{
    fen: string;
    lines: EngineLine[];
    data: Explanation | null;
  } | null>(null);
  /** Both are tied to a FEN: a new position starts with a clean slate. */
  const [asked, setAsked] = useState<{ fen: string; moves: { uci: string; san: string }[] } | null>(null);
  const [pick, setPick] = useState<{ fen: string; uci: string } | null>(null);
  const [hoverUci, setHoverUci] = useState<string | null>(null);
  /** `${fen} ${uci}` → refutation, so re-hovering a square costs no search. */
  const [refCache, setRefCache] = useState<Record<string, Refutation | null>>({});
  /**
   * Judging your move after you commit to it gets its own toggle: being told
   * what you just did is a different bargain from being helped beforehand.
   */
  const [reviewMine, setReviewMine] = useState(false);
  /** ply index → what that move was worth. Grows as the game is played. */
  const [annotations, setAnnotations] = useState<Record<number, Annotation>>({});
  /** Which past move the board is rewound to, if any. */
  const [viewPly, setViewPly] = useState<number | null>(null);

  const fen = game.fen();
  const myTurn = !thinking && !game.isGameOver() && game.turn() === playerColor;
  const history = useMemo(() => game.history({ verbose: true }), [game]);
  const lastMove = history[history.length - 1];

  useEffect(() => {
    const engine = new ChessEngine();
    engineRef.current = engine;
    return () => {
      engine.dispose();
      engineRef.current = null;
      analystRef.current?.dispose();
      analystRef.current = null;
    };
  }, []);

  useEffect(() => {
    engineRef.current?.setStrength(elo);
  }, [elo]);

  /**
   * chess.js has no clone, so a move is applied to a fresh instance replayed
   * from the previous PGN: render stays pure and undo/threefold still work.
   */
  const play = useCallback((mutate: (g: Chess) => unknown) => {
    setSelected(null);
    setGame((prev) => {
      const next = new Chess();
      next.loadPgn(prev.pgn());
      try {
        mutate(next);
      } catch {
        return prev; // illegal move — leave the position untouched
      }
      return next;
    });
  }, []);

  // Engine turn.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || game.isGameOver() || game.turn() === playerColor) {
      setThinking(false);
      return;
    }
    const token = ++searchRef.current;
    setThinking(true);
    engine.bestMove(game.fen()).then((uci) => {
      if (token !== searchRef.current) return; // superseded by a new game or a takeback
      if (!uci || uci === '(none)') return setThinking(false);
      // ponytail: auto-queen. Add a promotion picker when someone asks for underpromotion.
      play((g) => g.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: 'q' }));
    });
    return () => {
      searchRef.current++;
      engine.stop();
    };
  }, [game, playerColor, play]);

  const assistIdleKey = game.isGameOver()
    ? ('assist.gameOver' as const)
    : game.turn() !== playerColor
      ? ('assist.waitYourTurn' as const)
      : null;

  /**
   * The analysis only counts while it still describes the position on screen
   * AND you still asked for it. Gating here rather than at each consumer is
   * what makes switching off actually switch off: the arrow, the counter and
   * the reasons all hang off this. The result stays in state, so switching
   * back on again costs no second search.
   */
  const ready = assist && analysis?.fen === fen ? analysis : null;
  const currentAnalysis = ready?.data ?? null;
  const analyzing = assist && !assistIdleKey && !ready;

  // Assisted mode: full-strength MultiPV analysis of the position you have to play.
  useEffect(() => {
    if (!assist || assistIdleKey) return;
    // ponytail: a second worker instead of juggling strength options on one —
    // the opponent stays weakened, the analyst always plays at full strength.
    const analyst = (analystRef.current ??= new ChessEngine());
    let cancelled = false;
    analyst.analyze(fen).then((lines) => {
      if (cancelled) return;
      try {
        setAnalysis({ fen, lines, data: explain(fen, lines) });
      } catch {
        setAnalysis({ fen, lines: [], data: null }); // engine returned a line this position rejects
      }
    });
    return () => {
      cancelled = true;
      analyst.stop();
    };
  }, [assist, assistIdleKey, fen]);

  /**
   * Point 1: every runner-up the search already returned, refuted for free —
   * its own PV holds both the eval of playing it and the reply that punishes it.
   */
  const alternatives = useMemo(() => {
    if (!ready || ready.lines.length < 2) return [];
    return ready.lines
      .slice(1)
      .map((l) => refute(fen, l.moveUci, ready.lines[0], continuationOf(fen, l)))
      .filter((r): r is Refutation => r !== null);
  }, [ready, fen]);

  const askedMoves = asked?.fen === fen ? asked.moves : [];
  const cacheKey = (uci: string) => `${fen} ${uci}`;

  /** Engine runner-ups first, then the moves you asked about yourself. */
  const chips = [
    ...alternatives.map((a) => ({ uci: a.uci, san: a.san, refutation: a })),
    ...askedMoves.map((m) => ({
      uci: m.uci,
      san: m.san,
      refutation: refCache[cacheKey(m.uci)] ?? null,
    })),
  ];

  const activeUci = hoverUci ?? (pick?.fen === fen ? pick.uci : null) ?? alternatives[0]?.uci ?? null;
  const fromLines = activeUci ? alternatives.find((a) => a.uci === activeUci) : undefined;
  const cached = activeUci && cacheKey(activeUci) in refCache ? refCache[cacheKey(activeUci)] : undefined;
  const shownRefutation = fromLines ?? cached ?? null;
  const counterLoading = Boolean(activeUci) && !fromLines && cached === undefined;

  /**
   * Point 2: explain a move BEFORE you commit to it — whether you hovered it,
   * picked it, or typed it. A move the search already returned needs no work;
   * anything else costs one shallow search, debounced only when the pointer is
   * sweeping the board so a sweep doesn't queue a dozen of them.
   */
  useEffect(() => {
    const analyst = analystRef.current;
    if (!activeUci || !ready || !analyst) return;
    const key = `${fen} ${activeUci}`;
    if (key in refCache) return;

    const remember = (r: Refutation | null) => setRefCache((c) => ({ ...c, [key]: r }));
    const known = ready.lines.find((l) => l.moveUci === activeUci);
    if (known) return remember(refute(fen, activeUci, ready.lines[0], continuationOf(fen, known)));

    let cancelled = false;
    const timer = setTimeout(() => {
      const probe = new Chess(fen);
      try {
        probe.move({ from: activeUci.slice(0, 2), to: activeUci.slice(2, 4), promotion: 'q' });
      } catch {
        return remember(null);
      }
      analyst.analyze(probe.fen(), 12, 1).then(([after]) => {
        if (!cancelled) remember(refute(fen, activeUci, ready.lines[0], after ?? null));
      });
    }, hoverUci ? 250 : 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [activeUci, hoverUci, ready, fen, refCache]);

  /** Which switch governs a move: yours are reviewed, the engine's is assisted. */
  const wanted = useCallback(
    (by: Color) => (by === playerColor ? reviewMine : assist),
    [playerColor, reviewMine, assist],
  );

  /**
   * A note only counts while it still describes the move sitting at that ply:
   * a takeback leaves the old one behind, pointing at a move never played.
   */
  const annotationAt = useCallback(
    (ply: number) => {
      const a = annotations[ply];
      return a && history[ply]?.before === a.fen ? a : undefined;
    },
    [annotations, history],
  );

  /**
   * Annotates the move just played — yours or the engine's — with what it was
   * worth and what the position wanted instead. One effect covers both: it
   * always works on the newest un-annotated ply, so a takeback simply drops
   * back to a move that already carries its note.
   *
   * chess.js hands over the before/after FENs, so nothing has to be replayed.
   */
  useEffect(() => {
    const ply = history.length - 1;
    const move = history[ply];
    if (!move || annotationAt(ply)) return;
    // Your moves are governed by the review toggle, the engine's by assisted
    // mode: being told what you just did is not the same as being helped.
    if (!wanted(move.color as Color)) return;
    // Assisted mode may never have built it: the review toggle stands alone.
    const analyst = (analystRef.current ??= new ChessEngine());

    let cancelled = false;
    Promise.all([analyst.analyze(move.before, 12, 3), analyst.analyze(move.after, 12, 1)]).then(
      ([best, [next]]) => {
        if (cancelled || !best[0]) return;
        const uci = `${move.from}${move.to}${move.promotion ?? ''}`;
        // Same guard assisted mode uses: the engine occasionally returns a
        // line this position rejects, and a note is not worth a blank page.
        let scored: Pick<Annotation, 'refutation' | 'explanation'>;
        try {
          scored = {
            refutation: refute(move.before, uci, best[0], next ?? null),
            explanation: explain(move.before, best),
          };
        } catch {
          return;
        }
        setAnnotations((prev) => ({
          ...prev,
          [ply]: {
            fen: move.before,
            from: move.from,
            to: move.to,
            san: move.san,
            by: move.color as Color,
            ...scored,
          },
        }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [history, annotationAt, wanted]);

  /** Validates a typed move and queues it for analysis. Returns an error key. */
  const addMove = (text: string): string | null => {
    const parsed = parseMove(fen, text);
    if (parsed === 'notation' || parsed === 'illegal') return `error.${parsed}`;
    setAsked((prev) => {
      const moves = prev?.fen === fen ? prev.moves : [];
      return moves.some((m) => m.uci === parsed.uci) ? { fen, moves } : { fen, moves: [...moves, parsed] };
    });
    setPick({ fen, uci: parsed.uci });
    return null;
  };

  const tryMove = (from: string, to: string) => {
    if (!myTurn) return false;
    const legal = game.moves({ verbose: true }).some((m) => m.from === from && m.to === to);
    if (!legal) return false;
    setViewPly(null); // a new move ends whatever you were looking back at
    play((g) => g.move({ from, to, promotion: 'q' }));
    return true;
  };

  const onPieceDrop = ({ sourceSquare, targetSquare }: PieceDropHandlerArgs) =>
    targetSquare ? tryMove(sourceSquare, targetSquare) : false;

  const onMouseOverSquare = ({ square }: SquareHandlerArgs) => {
    if (!assist || !selected || !myTurn) return;
    const legal = game.moves({ square: selected, verbose: true }).some((m) => m.to === square);
    setHoverUci(legal ? `${selected}${square}` : null);
  };

  const onSquareClick = ({ square }: SquareHandlerArgs) => {
    if (!myTurn) return;
    const sq = square as Square;
    if (selected && tryMove(selected, sq)) return;
    const piece = game.get(sq);
    setSelected(piece && piece.color === playerColor ? sq : null);
  };

  const squareStyles = useMemo(() => squareStylesFor(game, selected), [game, selected]);

  const arrows = useMemo(
    () =>
      currentAnalysis
        ? [
            {
              startSquare: currentAnalysis.best.from,
              endSquare: currentAnalysis.best.to,
              color: '#81b64c',
            },
          ]
        : [],
    [currentAnalysis],
  );


  const newGame = (color: Color) => {
    setPlayerColor(color);
    setSelected(null);
    setGame(new Chess());
    setAnnotations({});
    setViewPly(null);
  };

  // The notes for the moves that survive stay valid; the ones for the moves
  // being unplayed are discarded by `annotationAt`, which checks the position.
  const takeback = () => {
    setViewPly(null);
    play((g) => {
      g.undo();
      if (g.turn() !== playerColor) g.undo(); // also undo the engine's reply
    });
  };

  const rows = useMemo(() => movePairs(game.history()), [game]);

  const colorLabel = (c: Color) => t(c === 'w' ? 'label.white' : 'label.black');

  /**
   * Looking back at a move shows the position it was played FROM, with the
   * move drawn on top — an arrow on the position after it points at nothing.
   */
  const viewed = viewPly !== null ? history[viewPly] : undefined;
  const shownFen = viewed ? viewed.before : fen;
  const shownArrows = viewed
    ? [{ startSquare: viewed.from, endSquare: viewed.to, color: '#81b64c' }]
    : arrows;
  const shownStyles = viewed
    ? { [viewed.from]: HIGHLIGHT, [viewed.to]: HIGHLIGHT }
    : squareStyles;

  /**
   * What the panel talks about: the move you clicked, or else BOTH halves of
   * the exchange just played — yours and the answer to it. Showing only the
   * newest would let the engine's reply quietly replace the review of your own
   * move a second after it appears, leaving a card about a move you did not
   * just make.
   */
  const spotlight = useMemo(() => {
    const plies = viewPly !== null ? [viewPly] : [history.length - 2, history.length - 1];
    return plies
      .filter((ply) => ply >= 0)
      .map((ply) => ({ ply, a: annotationAt(ply) }))
      .flatMap(({ ply, a }) =>
        // Switched off means nothing shows up on its own — but a move you
        // clicked is something you asked for, so a stored note still opens.
        a && (viewPly !== null || wanted(a.by)) ? [{ key: ply, a, mine: a.by === playerColor }] : [],
      );
  }, [viewPly, history, annotationAt, playerColor, wanted]);

  return (
    <div className="app">
      <AnalysisPanel
        t={t}
        enabled={assist}
        onToggle={setAssist}
        loading={analyzing && !viewed}
        analysis={viewed ? null : currentAnalysis}
        counter={
          viewed || !currentAnalysis ? null : {
            chips,
            activeUci,
            onPick: (uci: string) => setPick({ fen, uci }),
            onAdd: addMove,
            shown: shownRefutation,
            loading: counterLoading,
          }
        }
        idleKey={assist && !viewed ? assistIdleKey : null}
        annotations={spotlight}
        reviewMine={reviewMine}
        onToggleReview={setReviewMine}
      />

      <main className="board-area">
        <div className="player-tag">
          Stockfish · {t(keyForElo(elo))} ({elo})
        </div>
        <div className="board">
          <Chessboard
            options={{
              id: 'main-board',
              position: shownFen,
              boardOrientation: playerColor === 'w' ? 'white' : 'black',
              onPieceDrop,
              onSquareClick,
              onMouseOverSquare,
              onMouseOutSquare: () => setHoverUci(null),
              squareStyles: shownStyles,
              arrows: shownArrows,
              allowDragging: myTurn && !viewed,
              darkSquareStyle: DARK_SQUARE,
              lightSquareStyle: LIGHT_SQUARE,
              animationDurationInMs: 180,
            }}
          />
        </div>
        <div className="player-tag">
          {t('label.you')} · {colorLabel(playerColor)}
        </div>
      </main>

      <aside className="panel">
        <div className={thinking ? 'status is-thinking' : 'status'}>
          {t(statusKey(game, playerColor, thinking))}
        </div>

        <section>
          <label className="field-label" htmlFor="elo">
            {t('label.level')} · <strong>{t(keyForElo(elo))}</strong>{' '}
            <span className="elo">{elo} Elo</span>
          </label>
          <input
            id="elo"
            type="range"
            min={ELO_MIN}
            max={ELO_MAX}
            step={10}
            value={elo}
            onChange={(e) => setElo(Number(e.target.value))}
          />
          <div className="levels">
            {LEVELS.map((l) => (
              <button
                key={l.key}
                type="button"
                className={elo === l.elo ? 'chip active' : 'chip'}
                onClick={() => setElo(l.elo)}
              >
                {t(l.key)}
              </button>
            ))}
          </div>
        </section>

        <section className="actions">
          <button type="button" className="btn primary" onClick={() => newGame(playerColor)}>
            {t('btn.newGame')}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => newGame(playerColor === 'w' ? 'b' : 'w')}
          >
            {t('btn.playAs', { color: colorLabel(playerColor === 'w' ? 'b' : 'w') })}
          </button>
          <button type="button" className="btn" onClick={takeback} disabled={!lastMove || thinking}>
            {t('btn.takeback')}
          </button>
        </section>

        {rows.length > 0 && <p className="muted">{t('review.historyHint')}</p>}
        <ol className="moves">
          {rows.map((r) => (
            <li key={r.n}>
              <span className="num">{r.n}.</span>
              {[r.white, r.black].map((cell, i) =>
                cell ? (
                  <button
                    key={i}
                    type="button"
                    className={cell.ply === viewPly ? 'san active' : 'san'}
                    aria-pressed={cell.ply === viewPly}
                    onClick={() =>
                      setViewPly((current) => (current === cell.ply ? null : cell.ply))
                    }
                  >
                    {cell.san}
                    {annotationAt(cell.ply)?.refutation && (
                      <span className={`dot ${annotationAt(cell.ply)!.refutation!.verdict}`} />
                    )}
                  </button>
                ) : (
                  <span key={i} className="san" />
                ),
              )}
            </li>
          ))}
        </ol>
        {viewed && (
          <button type="button" className="btn" onClick={() => setViewPly(null)}>
            {t('review.back')}
          </button>
        )}
      </aside>
    </div>
  );
}
