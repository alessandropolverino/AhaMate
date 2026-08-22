/**
 * Board decoration shared by every page: last move, check, selection and legal
 * move dots. Pure — pages merge their own highlights (a puzzle hint, say) on top.
 */
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
  const styles: Record<string, React.CSSProperties> = {};
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
