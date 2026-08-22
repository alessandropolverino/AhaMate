/**
 * Stockfish 18 (WASM) in a Web Worker.
 *
 * ponytail: "lite single-threaded" build on purpose — it needs no COOP/COEP
 * cross-origin-isolation headers (so it deploys as a plain static site) and is
 * still far stronger than any human. Swap to `stockfish-18-lite.js` only if you
 * ship the isolation headers and actually need multi-threaded search.
 *
 * A fresh instance is full strength; `setStrength` weakens it. The app keeps
 * two: one weakened opponent, one full-strength analyst for assisted mode.
 */

import type { EngineLine } from './analysis';
import { strengthCommands } from './strength.js';

export { ELO_MAX, ELO_MIN, LEVELS, keyForElo } from './strength.js';

const INFO_RE =
  /^info .*?\bmultipv (\d+).*?\bscore (cp|mate) (-?\d+).*?\bpv ((?:[a-h][1-8][a-h][1-8][qrbn]?\s?)+)/;

export class ChessEngine {
  private worker = new Worker(`${import.meta.env.BASE_URL}engine/stockfish-18-lite-single.js`);
  private handlers = new Set<(line: string) => void>();
  private ready: Promise<unknown>;
  private goCmd = 'go movetime 800';
  /** One search at a time: a `stop`'s late `bestmove` must not resolve the next one. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor() {
    this.worker.onmessage = (e: MessageEvent) => {
      const line: string = typeof e.data === 'string' ? e.data : (e.data?.data ?? '');
      for (const h of [...this.handlers]) h(line);
    };
    this.ready = this.waitFor(/^uciok/);
    this.send('uci');
  }

  private send(cmd: string) {
    this.worker.postMessage(cmd);
  }

  private waitFor(re: RegExp): Promise<string> {
    return new Promise((resolve) => {
      const h = (line: string) => {
        const m = re.exec(line);
        if (!m) return;
        this.handlers.delete(h);
        resolve(m[1] ?? line);
      };
      this.handlers.add(h);
    });
  }

  setStrength(elo: number) {
    const { options, go } = strengthCommands(elo);
    options.forEach((o) => this.send(o));
    this.goCmd = go;
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async bestMove(fen: string): Promise<string> {
    await this.ready;
    return this.serial(() => {
      const answer = this.waitFor(/^bestmove (\S+)/);
      this.send(`position fen ${fen}`);
      this.send(this.goCmd);
      return answer;
    });
  }

  /** MultiPV search, scores normalised to White's point of view. */
  async analyze(fen: string, depth = 15, multipv = 3): Promise<EngineLine[]> {
    await this.ready;
    return this.serial(() => this.runAnalysis(fen, depth, multipv));
  }

  private async runAnalysis(fen: string, depth: number, multipv: number): Promise<EngineLine[]> {
    const whiteToMove = fen.split(' ')[1] === 'w';
    const lines = new Map<number, EngineLine>();

    const done = new Promise<void>((resolve) => {
      const h = (line: string) => {
        if (line.startsWith('bestmove')) {
          this.handlers.delete(h);
          return resolve();
        }
        if (line.includes('bound')) return; // fail-high/low, not a settled score
        const m = INFO_RE.exec(line);
        if (!m) return;
        const value = Number(m[3]) * (whiteToMove ? 1 : -1);
        const pv = m[4].trim().split(/\s+/);
        lines.set(Number(m[1]), {
          moveUci: pv[0],
          isMate: m[2] === 'mate',
          mateIn: m[2] === 'mate' ? value : null,
          scoreCp: m[2] === 'cp' ? value : null,
          pv,
        });
      };
      this.handlers.add(h);
    });

    this.send(`setoption name MultiPV value ${multipv}`);
    this.send(`position fen ${fen}`);
    this.send(`go depth ${depth}`);
    await done;
    this.send('setoption name MultiPV value 1');
    return [...lines].sort(([a], [b]) => a - b).map(([, v]) => v);
  }

  stop() {
    this.send('stop');
  }

  dispose() {
    this.worker.terminate();
  }
}
