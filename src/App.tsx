import { useCallback, useEffect, useState } from 'react';
import BotGame from './BotGame';
import { Navbar } from './Navbar';
import { Puzzles } from './Puzzles';
import { detectLang, translate, type Lang, type Params } from './i18n';
import './App.css';

/** ponytail: hash routing is two lines of platform, and the back button works. */
function useHashRoute(): string {
  const read = () => window.location.hash.replace(/^#\/?/, '') || 'bot';
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const sync = () => setRoute(read());
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  return route;
}

export default function App() {
  const [lang, setLang] = useState<Lang>(detectLang);
  const route = useHashRoute();
  const t = useCallback((key: string, params?: Params) => translate(lang, key, params), [lang]);

  return (
    <>
      <Navbar t={t} route={route} lang={lang} onLang={setLang} />
      {route === 'puzzles' ? <Puzzles t={t} /> : <BotGame t={t} />}
    </>
  );
}
