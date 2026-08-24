/**
 * "Why not this move?" — shared by the bot game and the puzzle page.
 *
 * Both pages need the same three things to score a move you did NOT play: the
 * position's best line, the line after your candidate, and `refute()` to
 * compare them. The bot page already has the first from assisted mode; the
 * puzzle page has no engine at all, so this hook owns one and starts it only
 * when somebody actually asks — nobody pays for the WASM download by opening
 * the page.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import { parseMove, refute, type EngineLine, type Refutation } from './analysis';
import { ChessEngine } from './engine';

/**
 * What `MoveEvaluator` renders. The bot page builds this shape by hand — its
 * chips lead with the engine's runner-ups — so it stays plain data.
 */
export type Evaluator = {
  chips: { uci: string; san: string; refutation: Refutation | null }[];
  activeUci: string | null;
  setActive: (uci: string) => void;
  /** Validates a typed move and queues it. Returns an i18n error key, or null. */
  add: (text: string) => string | null;
  shown: Refutation | null;
  loading: boolean;
};

/**
 * `bestLine` is the analysis of `fen` when the caller already has one (the bot
 * page's assisted mode); pass null and the engine searches it here.
 */
export function useEvaluator(fen: string, bestLine: EngineLine | null): Evaluator {
  const engineRef = useRef<ChessEngine | null>(null);
  const [asked, setAsked] = useState<{ fen: string; moves: { uci: string; san: string }[] } | null>(null);
  const [active, setActiveUci] = useState<{ fen: string; uci: string } | null>(null);
  const [results, setResults] = useState<Record<string, Refutation | null>>({});

  useEffect(() => () => engineRef.current?.dispose(), []);

  const moves = asked?.fen === fen ? asked.moves : [];
  const activeUci = active?.fen === fen ? active.uci : null;
  const key = activeUci ? `${fen} ${activeUci}` : null;
  const loading = Boolean(key) && !(key! in results);

  useEffect(() => {
    if (!activeUci || !key || key in results) return;
    const engine = (engineRef.current ??= new ChessEngine());
    const probe = new Chess(fen);
    try {
      probe.move({ from: activeUci.slice(0, 2), to: activeUci.slice(2, 4), promotion: 'q' });
    } catch {
      return setResults((r) => ({ ...r, [key]: null }));
    }
    let cancelled = false;
    // The best line first when the caller has none, then the candidate's own.
    // ChessEngine serialises searches, so these two never collide.
    const best = bestLine ? Promise.resolve([bestLine]) : engine.analyze(fen, 12, 1);
    Promise.all([best, engine.analyze(probe.fen(), 12, 1)]).then(([top, [after]]) => {
      if (cancelled || !top[0]) return;
      const r = refute(fen, activeUci, top[0], after ?? null);
      setResults((prev) => ({ ...prev, [key]: r }));
    });
    return () => {
      cancelled = true;
    };
    // `results` is read-through: re-running on every write would restart the
    // search the write exists to avoid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeUci, key, fen, bestLine]);

  const add = useCallback(
    (text: string): string | null => {
      const parsed = parseMove(fen, text);
      if (parsed === 'notation' || parsed === 'illegal') return `error.${parsed}`;
      setAsked((prev) => {
        const list = prev?.fen === fen ? prev.moves : [];
        return list.some((m) => m.uci === parsed.uci)
          ? { fen, moves: list }
          : { fen, moves: [...list, parsed] };
      });
      setActiveUci({ fen, uci: parsed.uci });
      return null;
    },
    [fen],
  );

  return {
    chips: moves.map((m) => ({ ...m, refutation: results[`${fen} ${m.uci}`] ?? null })),
    activeUci,
    setActive: useCallback((uci: string) => setActiveUci({ fen, uci }), [fen]),
    add,
    shown: key ? (results[key] ?? null) : null,
    loading,
  };
}
