import { useEffect, useRef } from 'react';
import { LANGS, type Lang, type Params } from './i18n';

type Props = {
  t: (key: string, params?: Params) => string;
  route: string;
  lang: Lang;
  onLang: (lang: Lang) => void;
};

/**
 * ponytail: the dropdown is a native <details> — keyboard accessible and open
 * on click without a line of state. The only script is closing it again when
 * you click elsewhere, which <details> alone doesn't do.
 */
export function Navbar({ t, route, lang, onLang }: Props) {
  const play = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (play.current && !play.current.contains(e.target as Node)) play.current.open = false;
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  return (
    <nav className="nav">
      <a className="brand" href="#/bot">
        AhaMate
      </a>

      <details className="menu" ref={play}>
        <summary>{t('nav.play')}</summary>
        <div className="menu-items">
          <a
            href="#/bot"
            className={route === 'bot' ? 'active' : undefined}
            onClick={() => play.current && (play.current.open = false)}
          >
            {t('nav.bot')}
          </a>
        </div>
      </details>

      <a href="#/puzzles" className={route === 'puzzles' ? 'nav-link active' : 'nav-link'}>
        {t('nav.puzzles')}
      </a>

      <select
        className="lang"
        aria-label={t('label.language')}
        value={lang}
        onChange={(e) => onLang(e.target.value as Lang)}
      >
        {LANGS.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
    </nav>
  );
}
