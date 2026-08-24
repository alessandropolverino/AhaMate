/**
 * Board decoration shared by every page: last move, check, selection and legal
 * move dots. Pure — pages merge their own highlights (a puzzle hint, say) on top.
 */
import type { CSSProperties } from 'react';
import type { Chess, Square } from 'chess.js';

export const HIGHLIGHT = { backgroundColor: 'rgba(255, 213, 79, 0.45)' };
export const SELECTED = { backgroundColor: 'rgba(255, 213, 79, 0.65)' };
export const HINT = { boxShadow: 'inset 0 0 0 4px rgba(129, 182, 76, 0.95)' };
const CHECK = { background: 'radial-gradient(circle, rgba(219,64,49,0.9) 12%, transparent 72%)' };
const DOT = { background: 'radial-gradient(circle, rgba(0,0,0,0.28) 20%, transparent 22%)' };
const CAPTURE = { background: 'radial-gradient(circle, transparent 55%, rgba(0,0,0,0.28) 57%)' };

export const LIGHT_SQUARE = { backgroundColor: '#eeeed2' };
export const DARK_SQUARE = { backgroundColor: '#769656' };

export function squareStylesFor(game: Chess, selected: Square | null) {
  const styles: Record<string, CSSProperties> = {};
  const moves = game.history({ verbose: true });
  const last = moves[moves.length - 1];
  if (last) {
    styles[last.from] = HIGHLIGHT;
    styles[last.to] = HIGHLIGHT;
  }
  if (game.inCheck()) {
    const king = game
      .board()
      .flat()
      .find((p) => p && p.type === 'k' && p.color === game.turn());
    if (king) styles[king.square] = { ...styles[king.square], ...CHECK };
  }
  if (selected) {
    styles[selected] = { ...styles[selected], ...SELECTED };
    for (const m of game.moves({ square: selected, verbose: true })) {
      styles[m.to] = { ...styles[m.to], ...(game.get(m.to as Square) ? CAPTURE : DOT) };
    }
  }
  return styles;
}

/**
 * A SAN history as numbered rows of [white, black], each cell carrying the ply
 * it came from so clicking it can rewind the board. The ply is the index into
 * `history()` — get this wrong and every move review is off by one.
 */
export function movePairs(san: string[]) {
  const cell = (ply: number) => (san[ply] ? { ply, san: san[ply] } : null);
  return Array.from({ length: Math.ceil(san.length / 2) }, (_, i) => ({
    n: i + 1,
    white: cell(i * 2),
    black: cell(i * 2 + 1),
  }));
}
