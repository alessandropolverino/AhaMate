# AhaMate — web MVP

React + Vite. Gioca contro Stockfish 18 (WASM, in un Web Worker). Nessun backend.

```bash
npm install     # copia anche i binari engine in public/engine/
npm run dev
npm test        # engine reale + confronto differenziale col PoC Python
```

## Pagine

Routing via hash, nessuna dipendenza: `#/bot` (default) e `#/puzzles`. La navbar ha
il dropdown **Gioca → Bot** (un `<details>` nativo, accessibile da tastiera) e il link
**Problemi**; il selettore di lingua vive lì.

## Problemi

150 problemi reali dal **database Lichess** (CC0, `database.lichess.org`), scelti su
5 fasce di difficoltà fra 627 e 2391 Elo, solo con `Popularity ≥ 90` e `NbPlays ≥ 1000`.
Rigenerabili con `python3 scripts/fetch-puzzles.py` (serve `pip install zstandard`).

- **Suggerimento** a due livelli: una pressione evidenzia il pezzo da muovere, due
  mostrano anche la freccia della mossa.
- **A fine problema**, ogni mossa della soluzione viene spiegata con gli stessi
  estrattori della modalità assistita — ma alimentati con la **soluzione nota**, non
  con una PV di Stockfish. Il motore non gira: un matto in fondo alla sequenza è un
  fatto, non una previsione, e lo swing di materiale è quello che la soluzione produce
  davvero. Dove non c'è un motore non c'è nemmeno una valutazione: `scoreCp` resta
  `null` e nessun numero viene inventato.
- **Cliccando una mossa** della recensione la scacchiera torna alla posizione da cui
  quella mossa è stata giocata, con la freccia che la indica — non alla posizione
  *dopo*, dove una freccia punterebbe il vuoto. Riclicca per tornare alla fine.

I dati generati non valgono niente finché non li rigioca la libreria dell'app:
`test-puzzles.mjs` replica tutti e 150 i problemi con chess.js.

## Livelli

Slider 500–3190 Elo + preset (Principiante → Maestro). La mappatura sta tutta in
[`src/strength.js`](src/strength.js), condivisa tra app e test:

- **≥ 1320 Elo** → `UCI_LimitStrength` + `UCI_Elo` (il dial nativo di Stockfish).
- **< 1320 Elo** → `Skill Level` + ricerca a profondità ridotta: sotto 1320 Stockfish
  non espone un dial Elo, e `Skill Level 0` da solo gioca ancora ~1300.

## Multilingua

[`src/i18n.ts`](src/i18n.ts): due dizionari (`it`, `en`) e una `translate()` di sei righe.
Aggiungere una lingua = un oggetto in più e una riga in `LANGS`. Nessuna dipendenza.

Il modulo di analisi non produce frasi: emette messaggi `{key, params}` che la UI
traduce. È l'unico modo perché le spiegazioni siano traducibili senza duplicare la
logica. I pezzi nelle spiegazioni sono figurine Unicode (♞e6), quindi neutre rispetto
alla lingua.

## Modalità assistita

Lo switch in alto a sinistra attiva l'analisi della posizione quando tocca a te:
mossa migliore + valutazione + perché + alternative, con la freccia sulla scacchiera.

Le motivazioni che parlano della *linea* (matto forzato, sacrificio, combinazione,
pedone passato, pressione duratura) sono sottolineate: in hover — o con Tab, sono
focusabili — mostrano la linea del motore in SAN numerato (`17. Qb8+ Nxb8 18. Rd8#`).
Tooltip in CSS puro, nessuna libreria di posizionamento.

Gira su un **secondo** worker Stockfish a piena forza — l'avversario resta indebolito
al livello scelto. [`src/analysis.ts`](src/analysis.ts) è il port TypeScript del PoC
`chess_explainer`: fork/pin/pezzi indifesi, mobilità, controllo del centro, king safety
(unità d'attacco pesate), struttura pedonale, swing materiale sulla PV, trend strategico.

Le **definizioni e le soglie** sono quelle del PoC (valori dei pezzi, regola del
"bersaglio vincibile" per la forchetta, finestra di 4 ply per lo swing). Ciò che è
stato **riscritto e non tradotto** è l'accesso alla scacchiera: chess.js non ha
`attacks()` né `is_pinned()`, quindi entrambi sono derivati da `attackers()`.

Valgono ancora i limiti noti del PoC: niente rilevamento di sacrifici/deviazioni,
`undefended` è un fatto statico e non una minaccia, `pin` non ha ancora un caso di
validazione positivo.

### Perché non… (controfattuale)

Le altre app ti dicono la mossa migliore. Questa ti dice **perché la tua idea non
funziona**: quanto costa, e cosa gioca l'avversario per punirla.

- Le **alternative** che il motore ha già restituito (MultiPV 3) sono confutate a
  costo zero: la loro PV contiene sia la valutazione della mossa sia la risposta che
  la punisce (`continuationOf`). Nessuna ricerca aggiuntiva.
- **Passando il mouse** su una casa legale dopo aver selezionato un pezzo, la mossa
  viene analizzata *prima* che tu la giochi: una ricerca corta, con debounce a 250 ms
  e cache per `fen+mossa`.
- Col **+** puoi chiedere di una mossa qualsiasi scrivendola, in SAN (`Nf6`, `exd5`,
  `O-O`) o UCI (`g8f6`). `parseMove()` la valida contro la posizione e distingue i due
  errori: notazione incomprensibile vs mossa non legale qui. Chi valida davvero è
  chess.js — la regex serve solo a scegliere quale dei due messaggi mostrare.

Il costo è misurato in **probabilità di vittoria**, non in centipawn, con la curva
documentata di Lichess (`50 + 50 * (2 / (1 + exp(-0.00368208 * cp)) - 1)`) e le sue
soglie pubblicate (10 / 20 / 30 punti → imprecisione / errore / errore grave). È ciò
che evita di chiamare "errore grave" un +9.0 che diventa +7.0.

### La voce

Le motivazioni sono scritte come le direbbe un allenatore, non come le stampa un
motore. Il numero su cui poggiano resta però a schermo, in piccolo, sotto la frase:
`stringe la morsa attorno al re avversario` / *+5 unità d'attacco*. Nessuna
affermazione diventa non verificabile.

## Test

- `test-engine.mjs` — pilota un vero processo Stockfish coi comandi che manda il worker,
  e verifica che a tutti e 7 i livelli risponda con una mossa legale.
- `test-puzzles.mjs` — rigioca con chess.js tutti i problemi inclusi (legalità di ogni
  mossa, lato al tratto corretto a ogni semimossa, temi e rating presenti) e verifica
  che la recensione copra ogni mossa del solutore e annunci il matto alla distanza
  giusta. Non serve né il motore né python.
- `test-analysis.mjs` — **test differenziale**: compila `src/analysis.ts`, chiede a
  Stockfish le prime 3 mosse su ognuna delle 7 posizioni di validazione del PoC, e
  verifica che i fatti estratti dal port TS siano *identici* a quelli del PoC Python.
  Richiede `pip install python-chess` (non serve il binario Stockfish).

## Scelte deliberate (cercare `ponytail:` nel codice)

- Build **lite single-threaded**: niente header COOP/COEP, deploy come sito statico.
- Promozione **auto-donna**: nessun picker di sottopromozione.
- **Due worker** invece di riconfigurare la forza di uno solo a ogni analisi.
