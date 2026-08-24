import { AnnotationCard, AskMove, BestMove, RefutationCard, type Annotation, type T } from './Reasons';
import type { Explanation, Refutation } from './analysis';

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

type Props = {
  t: T;
  enabled: boolean;
  onToggle: (on: boolean) => void;
  loading: boolean;
  analysis: Explanation | null;
  counter: Counter | null;
  /** Why there is nothing to analyse right now, if that's the case. */
  idleKey: 'assist.waitYourTurn' | 'assist.gameOver' | null;
  /** The moves under the spotlight: the exchange just played, or one you clicked. */
  annotations: { key: number; a: Annotation; mine: boolean }[];
  /** Judge my own moves once they are played — independent of assisted mode. */
  reviewMine: boolean;
  onToggleReview: (on: boolean) => void;
};

export function AnalysisPanel({
  t, enabled, onToggle, loading, analysis, counter, idleKey, annotations, reviewMine, onToggleReview,
}: Props) {
  return (
    <aside className="assist">
      <label className="switch">
        <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
        <span className="track" aria-hidden="true" />
        <span className="switch-label">{t('assist.title')}</span>
      </label>

      <label className="switch">
        <input type="checkbox" checked={reviewMine} onChange={(e) => onToggleReview(e.target.checked)} />
        <span className="track" aria-hidden="true" />
        <span className="switch-label">{t('review.toggle')}</span>
      </label>

      {!enabled && !reviewMine && <p className="muted">{t('assist.hint')}</p>}

      {annotations.map((n) => (
        <AnnotationCard key={n.key} t={t} a={n.a} mine={n.mine} />
      ))}
      {enabled && idleKey && <p className="muted">{t(idleKey)}</p>}
      {enabled && !idleKey && loading && <p className="muted">{t('assist.analyzing')}</p>}

      {enabled && !idleKey && !loading && analysis && (
        <div className="analysis">
          <BestMove t={t} e={analysis} />

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
