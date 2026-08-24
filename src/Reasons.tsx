/**
 * The pieces both pages share: one coaching sentence, the "ask about a move"
 * box, and the card that scores a move. Extracted when the puzzle page grew
 * its own evaluator — `Reason` had already been copy-pasted into it.
 */
import { useState } from 'react';
import type { Explanation, Refutation } from './analysis';
import type { Evaluator } from './useEvaluator';
import type { Msg, Params } from './i18n';

export type T = (key: string, params?: Params) => string;

/** "+" → type a move in SAN or UCI; App validates it against the position. */
export function AskMove({ t, onAdd }: { t: T; onAdd: (text: string) => string | null }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" className="chip add" title={t('counter.add')} onClick={() => setOpen(true)}>
        +
      </button>
    );
  }

  return (
    <form
      className="ask"
      onSubmit={(e) => {
        e.preventDefault();
        const failure = onAdd(text);
        setError(failure);
        if (!failure) {
          setText('');
          setOpen(false);
        }
      }}
    >
      <input
        autoFocus
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        placeholder={t('counter.addPlaceholder')}
        aria-label={t('counter.add')}
        aria-invalid={error ? true : undefined}
      />
      <button type="submit" className="chip active">
        {t('counter.addSubmit')}
      </button>
      {error && <p className="error">{t(error)}</p>}
    </form>
  );
}


/**
 * A coaching sentence plus the metric it rests on. Reasons about the engine's
 * line carry it as a CSS-only tooltip (ponytail: no positioning library), and
 * tabIndex keeps that reachable without a mouse.
 */
export function Reason({ t, msg }: { t: T; msg: Msg }) {
  return (
    <li className={msg.line ? 'has-line' : undefined} data-line={msg.line} tabIndex={msg.line ? 0 : undefined}>
      {t(msg.key, msg.params)}
      {msg.detail && <span className="detail">{t(msg.detail.key, msg.detail.params)}</span>}
    </li>
  );
}

export function RefutationCard({ t, r }: { t: T; r: Refutation }) {
  return (
    <div className="refutation">
      <div className="verdict-row">
        <span className={`badge ${r.verdict}`}>{t(`verdict.${r.verdict}`)}</span>
        <strong className="san">{r.san}</strong>
        <span className="eval">{r.evalLabel}</span>
      </div>
      <p className="muted cost">
        {r.lossPct >= 1 ? t('counter.cost', { pct: r.lossPct }) : t('counter.noCost')}
      </p>

      {r.verdict === 'best' ? (
        <p className="muted">{t('counter.isBest')}</p>
      ) : r.punishment ? (
        <>
          <p className="reply has-line" data-line={r.punishment.line} tabIndex={0}>
            {t('counter.reply', { san: r.punishment.san })}
          </p>
          <ul className="reasons">
            {r.punishment.reasons.map((msg) => (
              <Reason key={msg.key} t={t} msg={msg} />
            ))}
          </ul>
        </>
      ) : (
        <p className="muted">{t('counter.noReply')}</p>
      )}
    </div>
  );
}


/**
 * The "why not…" block: the moves on offer, a box to name your own, and the
 * card scoring whichever is selected. Both pages render exactly this.
 */
export function MoveEvaluator({ t, ev, hintKey }: { t: T; ev: Evaluator; hintKey: string }) {
  return (
    <>
      <h3>{t('counter.title')}</h3>
      <div className="levels">
        {ev.chips.map((chip) => (
          <button
            key={chip.uci}
            type="button"
            className={chip.uci === ev.activeUci ? 'chip active' : 'chip'}
            onClick={() => ev.setActive(chip.uci)}
          >
            {chip.san}
            {chip.refutation && <span className="loss">−{chip.refutation.lossPct}%</span>}
          </button>
        ))}
        <AskMove t={t} onAdd={ev.add} />
      </div>
      {ev.loading ? (
        <p className="muted">{t('counter.loading')}</p>
      ) : ev.shown ? (
        <RefutationCard t={t} r={ev.shown} />
      ) : (
        <p className="muted">{t(hintKey)}</p>
      )}
    </>
  );
}

/** The engine's pick for a position, and the sentences behind it. */
export function BestMove({ t, e }: { t: T; e: Explanation }) {
  return (
    <>
      <div className="best">
        <span className="tag">{t('assist.best')}</span>
        <strong className="san">{e.best.san}</strong>
        <span className="eval">{e.best.evalLabel}</span>
      </div>
      <h3>{t('assist.because')}</h3>
      <ul className="reasons">
        {e.best.reasons.map((msg) => (
          <Reason key={msg.key} t={t} msg={msg} />
        ))}
      </ul>
    </>
  );
}

/**
 * A move already played, with the position it came from. `refutation` scores
 * it (and is the verdict "best" when it WAS the engine's move), `explanation`
 * is what the position wanted — the same card assisted mode shows, only after
 * the fact instead of before it.
 */
export type Annotation = {
  fen: string;
  from: string;
  to: string;
  san: string;
  by: 'w' | 'b';
  refutation: Refutation | null;
  explanation: Explanation | null;
};

export function AnnotationCard({ t, a, mine }: { t: T; a: Annotation; mine: boolean }) {
  return (
    <div className="analysis">
      <h3>{t(mine ? 'review.title' : 'review.theirs', { san: a.san })}</h3>
      {a.refutation ? <RefutationCard t={t} r={a.refutation} /> : <p className="muted">{t('review.none')}</p>}
      {a.explanation && a.refutation?.verdict !== 'best' && <BestMove t={t} e={a.explanation} />}
    </div>
  );
}
