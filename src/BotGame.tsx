import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chess, type Square } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import type { PieceDropHandlerArgs, SquareHandlerArgs } from 'react-chessboard';
import { AnalysisPanel } from './AnalysisPanel';
import { DARK_SQUARE, LIGHT_SQUARE, squareStylesFor } from './board';
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

  const fen = game.fen();
  const myTurn = !thinking && !game.isGameOver() && game.turn() === playerColor;
  const history = game.history({ verbose: true });
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

  /** The analysis only counts while it still describes the position on screen. */
  const ready = analysis?.fen === fen ? analysis : null;
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
      .map((l) => refute(fen, l.moveUci, ready.lines[0], continuationOf(l)))
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
    if (known) return remember(refute(fen, activeUci, ready.lines[0], continuationOf(known)));

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
    if (legal) play((g) => g.move({ from, to, promotion: 'q' }));
    return legal;
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
  };

  const takeback = () =>
    play((g) => {
      g.undo();
      if (g.turn() !== playerColor) g.undo(); // also undo the engine's reply
    });

  const rows = useMemo(() => {
    const san = game.history();
    return Array.from({ length: Math.ceil(san.length / 2) }, (_, i) => ({
      n: i + 1,
      white: san[i * 2],
      black: san[i * 2 + 1],
    }));
  }, [game]);

  const colorLabel = (c: Color) => t(c === 'w' ? 'label.white' : 'label.black');

  return (
    <div className="app">
      <AnalysisPanel
        t={t}
        enabled={assist}
        onToggle={setAssist}
        loading={analyzing}
        analysis={currentAnalysis}
        counter={
          currentAnalysis && {
            chips,
            activeUci,
            onPick: (uci: string) => setPick({ fen, uci }),
            onAdd: addMove,
            shown: shownRefutation,
            loading: counterLoading,
          }
        }
        idleKey={assist ? assistIdleKey : null}
      />

      <main className="board-area">
        <div className="player-tag">
          Stockfish · {t(keyForElo(elo))} ({elo})
        </div>
        <div className="board">
          <Chessboard
            options={{
              id: 'main-board',
              position: fen,
              boardOrientation: playerColor === 'w' ? 'white' : 'black',
              onPieceDrop,
              onSquareClick,
              onMouseOverSquare,
              onMouseOutSquare: () => setHoverUci(null),
              squareStyles,
              arrows,
              allowDragging: myTurn,
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

        <ol className="moves">
          {rows.map((r) => (
            <li key={r.n}>
              <span className="num">{r.n}.</span>
              <span className="san">{r.white}</span>
              <span className="san">{r.black ?? ''}</span>
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}
