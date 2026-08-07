// order.js -- move ordering. Alpha-beta only pays off if good moves are tried
// first, so this is worth as much as anything in the search itself. Split out
// of search.js to keep both files under the 300-line site cap.

import {
  PAWN, typeOf, moveFrom, moveTo, movePromo, moveFlags, FLAG_CAPTURE, FLAG_EP,
} from './rules.js';
import { PIECE_VALUE } from './eval.js';

// The ladder, highest first: the transposition-table move, then captures by
// most-valuable-victim / least-valuable-attacker, then promotions, then the two
// killer moves for this ply, and finally the history heuristic.
export function moveScore(board, engine, move, hashMove, ply) {
  if (move === hashMove) return 1 << 28;
  const flags = moveFlags(move);
  if (flags & FLAG_CAPTURE) {
    const victim = (flags & FLAG_EP) ? PAWN : typeOf(board[moveTo(move)]);
    return (1 << 24) + PIECE_VALUE[victim] * 16 - PIECE_VALUE[typeOf(board[moveFrom(move)])];
  }
  if (movePromo(move)) return (1 << 23) + PIECE_VALUE[movePromo(move)];
  if (engine.killers[ply * 2] === move) return 1 << 22;
  if (engine.killers[ply * 2 + 1] === move) return (1 << 22) - 1;
  return engine.history[moveFrom(move) * 128 + moveTo(move)];
}

export function scoreMoves(board, engine, moves, hashMove, ply) {
  const scores = new Int32Array(moves.length);
  for (let i = 0; i < moves.length; i++) scores[i] = moveScore(board, engine, moves[i], hashMove, ply);
  return scores;
}

// Selection sort, one pick at a time and in place: with a good hash move most
// nodes never look past the first pick, so a full sort would be wasted work.
export function pickBest(moves, scores, from) {
  let best = from;
  for (let i = from + 1; i < moves.length; i++) if (scores[i] > scores[best]) best = i;
  if (best !== from) {
    const m = moves[from]; moves[from] = moves[best]; moves[best] = m;
    const s = scores[from]; scores[from] = scores[best]; scores[best] = s;
  }
  return moves[from];
}

// A quiet move that caused a cutoff is remembered twice: as one of two killers
// for its ply, and in a from/to table shared by the whole search.
export function rememberCutoff(engine, move, ply, depth) {
  if (engine.killers[ply * 2] !== move) {
    engine.killers[ply * 2 + 1] = engine.killers[ply * 2];
    engine.killers[ply * 2] = move;
  }
  engine.history[moveFrom(move) * 128 + moveTo(move)] += depth * depth;
}
