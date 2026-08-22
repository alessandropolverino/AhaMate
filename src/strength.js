/**
 * Pure UCI strength mapping — no DOM, no Vite. Shared by the app (engine.ts)
 * and by test-engine.mjs, which drives a real Stockfish process with it.
 */

/** Stockfish's own UCI_Elo floor. Below this only `Skill Level` can weaken it. */
export const UCI_ELO_MIN = 1320;
export const UCI_ELO_MAX = 3190;

export const ELO_MIN = 500;
export const ELO_MAX = UCI_ELO_MAX;

export const LEVELS = [
  { key: 'level.beginner', elo: 600 },
  { key: 'level.casual', elo: 900 },
  { key: 'level.club', elo: 1400 },
  { key: 'level.intermediate', elo: 1800 },
  { key: 'level.advanced', elo: 2200 },
  { key: 'level.expert', elo: 2600 },
  { key: 'level.master', elo: 3190 },
];

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** Closest preset i18n key to an arbitrary Elo, for the slider readout. */
export function keyForElo(elo) {
  return LEVELS.reduce((best, l) => (Math.abs(l.elo - elo) < Math.abs(best.elo - elo) ? l : best))
    .key;
}

/**
 * UCI setoption lines + the `go` command for a target Elo.
 * @returns {{ options: string[], go: string }}
 */
export function strengthCommands(elo) {
  if (elo >= UCI_ELO_MIN) {
    return {
      options: [
        'setoption name UCI_LimitStrength value true',
        `setoption name UCI_Elo value ${clamp(Math.round(elo), UCI_ELO_MIN, UCI_ELO_MAX)}`,
      ],
      go: 'go movetime 800',
    };
  }
  // ponytail: under 1320 Stockfish has no Elo dial, so weaken it with Skill Level
  // *and* a shallow search — Skill Level 0 alone still plays around 1300.
  return {
    options: [
      'setoption name UCI_LimitStrength value false',
      `setoption name Skill Level value ${clamp(Math.round((elo - 400) / 46), 0, 20)}`,
    ],
    go: `go depth ${clamp(Math.round(elo / 180), 1, 7)}`,
  };
}
