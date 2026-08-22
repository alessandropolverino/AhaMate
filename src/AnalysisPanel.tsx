import { useState } from 'react';
import type { Explanation, Refutation } from './analysis';
import type { Msg, Params } from './i18n';

type T = (key: string, params?: Params) => string;

type Chip = { uci: string; san: string; refutation: Refutation | null };

type Counter = {
  /** MultiPV runner-ups (refuted for free) followed by the moves you asked about. */
  chips: Chip[];
  activeUci: string | null;
  onPick: (uci: string) => void;
  /** Validates a typed move; returns an i18n error key, or null on success. */
  onAdd: (text: string) => string | null;
  shown: Refutation | null;
  loading: boolean;
};

/** "+" → type a move in SAN or UCI; App validates it against the position. */
function AskMove({ t, onAdd }: { t: T; onAdd: (text: string) => string | null }) {
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

type Props = {
  t: T;
  enabled: boolean;
  onToggle: (on: boolean) => void;
  loading: boolean;
  analysis: Explanation | null;
  counter: Counter | null;
  /** Why there is nothing to analyse right now, if that's the case. */
  idleKey: 'assist.waitYourTurn' | 'assist.gameOver' | null;
};

/**
 * A coaching sentence plus the metric it rests on. Reasons about the engine's
 * line carry it as a CSS-only tooltip (ponytail: no positioning library), and
 * tabIndex keeps that reachable without a mouse.
 */
function Reason({ t, msg }: { t: T; msg: Msg }) {
  return (
    <li className={msg.line ? 'has-line' : undefined} data-line={msg.line} tabIndex={msg.line ? 0 : undefined}>
      {t(msg.key, msg.params)}
      {msg.detail && <span className="detail">{t(msg.detail.key, msg.detail.params)}</span>}
    </li>
  );
}

function RefutationCard({ t, r }: { t: T; r: Refutation }) {
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

export function AnalysisPanel({ t, enabled, onToggle, loading, analysis, counter, idleKey }: Props) {
  return (
    <aside className="assist">
      <label className="switch">
        <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
        <span className="track" aria-hidden="true" />
        <span className="switch-label">{t('assist.title')}</span>
      </label>

      {!enabled && <p className="muted">{t('assist.hint')}</p>}
      {enabled && idleKey && <p className="muted">{t(idleKey)}</p>}
      {enabled && !idleKey && loading && <p className="muted">{t('assist.analyzing')}</p>}

      {enabled && !idleKey && !loading && analysis && (
        <div className="analysis">
          <div className="best">
            <span className="tag">{t('assist.best')}</span>
            <strong className="san">{analysis.best.san}</strong>
            <span className="eval">{analysis.best.evalLabel}</span>
          </div>

          <h3>{t('assist.because')}</h3>
          <ul className="reasons">
            {analysis.best.reasons.map((msg) => (
              <Reason key={msg.key} t={t} msg={msg} />
            ))}
          </ul>

          {counter && (
            <>
              <h3>{t('counter.title')}</h3>
              <div className="levels">
                {counter.chips.map((chip) => (
                  <button
                    key={chip.uci}
                    type="button"
                    className={chip.uci === counter.activeUci ? 'chip active' : 'chip'}
                    onClick={() => counter.onPick(chip.uci)}
                  >
                    {chip.san}
                    {chip.refutation && <span className="loss">−{chip.refutation.lossPct}%</span>}
                  </button>
                ))}
                <AskMove t={t} onAdd={counter.onAdd} />
              </div>
              {counter.loading ? (
                <p className="muted">{t('counter.loading')}</p>
              ) : counter.shown ? (
                <RefutationCard t={t} r={counter.shown} />
              ) : (
                <p className="muted">{t('counter.hint')}</p>
              )}
            </>
          )}
        </div>
      )}
    </aside>
  );
}
