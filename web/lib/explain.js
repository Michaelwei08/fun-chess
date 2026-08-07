// explain.js -- turns a search result into sentences a human can check.
// House rule from docs/CONTRACT.md: every Fact carries the name of the
// computation that produced it, and a claim with no computation behind it is
// not emitted. That is the whole reason this file is separate from the UI.

import {
  PAWN, KNIGHT, KING, WHITE, typeOf, colorOf, generateMoves, makeMove, unmakeMove,
  inCheck, squareName, moveFrom, moveTo, movePromo, moveFlags,
  FLAG_CAPTURE, FLAG_EP, FLAG_CASTLE_K, FLAG_CASTLE_Q,
} from './rules.js';
import { N_OFF, K_OFF, B_OFF, R_OFF } from './tables.js';
import { PIECE_VALUE, evalBreakdown } from './eval.js';
import { moveToSan } from './notation.js';
import { MATE, mateDistance } from './search.js';

const NAMES = ['', 'pawn', 'knight', 'bishop', 'rook', 'queen', 'king'];
const fact = (text, basis) => ({ text, basis });

// Attack detection against a raw board array, so the static exchange below can
// physically remove pieces and let x-rays appear by themselves.
function attackers(board, sq, side) {
  const out = [];
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const from = r * 16 + f, p = board[from];
      if (!p || (p >> 3) !== side) continue;
      const type = p & 7, diff = sq - from;
      if (type === PAWN) {
        const up = side === WHITE ? 16 : -16;
        if (diff === up + 1 || diff === up - 1) out.push(from);
      } else if (type === KNIGHT) {
        if (N_OFF.includes(diff)) out.push(from);
      } else if (type === KING) {
        if (K_OFF.includes(diff)) out.push(from);
      } else {
        const rays = type === 3 ? B_OFF : type === 4 ? R_OFF : K_OFF;
        for (const step of rays) {
          for (let t = from + step; (t & 0x88) === 0; t += step) {
            if (t === sq) { out.push(from); break; }
            if (board[t]) break;
          }
        }
      }
    }
  }
  return out;
}

function leastValuable(board, squares) {
  let best = -1;
  for (const sq of squares) {
    if (best < 0 || PIECE_VALUE[typeOf(board[sq])] < PIECE_VALUE[typeOf(board[best])]) best = sq;
  }
  return best;
}

// Static exchange evaluation: what the capture is worth once both sides have
// finished trading on the square, in centipawns for the side to move.
export function see(pos, move) {
  const board = pos.board.slice();
  const from = moveFrom(move), to = moveTo(move), flags = moveFlags(move);
  let side = pos.turn;
  const victim = (flags & FLAG_EP) ? PAWN : typeOf(board[to]);
  const gain = [PIECE_VALUE[victim]];
  if (flags & FLAG_EP) board[side === WHITE ? to - 16 : to + 16] = 0;
  let standing = typeOf(board[from]);
  if (movePromo(move)) {
    gain[0] += PIECE_VALUE[movePromo(move)] - PIECE_VALUE[PAWN];
    standing = movePromo(move);
  }
  board[to] = board[from]; board[from] = 0;
  side ^= 1;
  let depth = 0;
  for (;;) {
    const next = leastValuable(board, attackers(board, to, side));
    if (next < 0) break;
    depth++;
    gain[depth] = PIECE_VALUE[standing] - gain[depth - 1];
    standing = typeOf(board[next]);
    board[to] = board[next]; board[next] = 0;
    side ^= 1;
  }
  while (depth > 0) { gain[depth - 1] = -Math.max(-gain[depth - 1], gain[depth]); depth--; }
  return gain[0];
}

function biggestTermShift(before, after) {
  const terms = ['king', 'pawns', 'mobility', 'pieces', 'position'];
  let name = '', delta = 0;
  for (const key of terms) {
    const change = after[key] - before[key];
    if (Math.abs(change) > Math.abs(delta)) { delta = change; name = key; }
  }
  return { name, delta };
}

const TERM_PHRASE = {
  king: ['shelters the king', 'loosens the king'],
  pawns: ['improves the pawn structure', 'damages the pawn structure'],
  mobility: ['frees the pieces', 'shuts the pieces in'],
  pieces: ['improves the pieces', 'misplaces the pieces'],
  position: ['centralises', 'decentralises'],
};

// pos is the position BEFORE the move.
export function describeMove(pos, move) {
  const facts = [];
  const mover = pos.turn, them = mover ^ 1;
  const flags = moveFlags(move), to = moveTo(move);
  const piece = pos.board[moveFrom(move)];
  const before = evalBreakdown(pos);

  if (flags & (FLAG_CASTLE_K | FLAG_CASTLE_Q)) {
    facts.push(fact('Castles, tucking the king away and bringing a rook to the centre files.', 'move-flag'));
  }
  if (movePromo(move)) {
    facts.push(fact('Promotes to a ' + NAMES[movePromo(move)] + '.', 'move-flag'));
  }
  if (flags & FLAG_EP) facts.push(fact('Takes en passant.', 'move-flag'));

  if (flags & FLAG_CAPTURE) {
    const victim = (flags & FLAG_EP) ? PAWN : typeOf(pos.board[to]);
    const exchange = see(pos, move);
    if (exchange > 40) {
      facts.push(fact('Takes the ' + NAMES[victim] + ' on ' + squareName(to) +
        ' and comes out ' + (exchange / 100).toFixed(2) + ' ahead once the trade finishes.', 'see'));
    } else if (exchange < -40) {
      facts.push(fact('Takes on ' + squareName(to) + ' but loses ' + (-exchange / 100).toFixed(2) +
        ' once the recapture sequence plays out.', 'see'));
    } else {
      facts.push(fact('Trades on ' + squareName(to) + ' at roughly even material.', 'see'));
    }
  }

  const undo = makeMove(pos, move);
  const after = evalBreakdown(pos);
  if (inCheck(pos)) {
    const replies = generateMoves(pos).length;
    facts.push(fact(replies ? 'Gives check; ' + replies + ' legal replies.' : 'Checkmate.', 'attack-map'));
  }
  // A fork is two targets the moved piece now hits that are worth taking.
  const targets = [];
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const sq = r * 16 + f, victim = pos.board[sq];
      if (!victim || colorOf(victim) !== them) continue;
      if (!attackers(pos.board, sq, mover).includes(to)) continue;
      const worth = PIECE_VALUE[typeOf(victim)];
      if (typeOf(victim) === KING || worth > PIECE_VALUE[typeOf(piece)] ||
        !attackers(pos.board, sq, them).length) targets.push(NAMES[typeOf(victim)] + ' on ' + squareName(sq));
    }
  }
  if (targets.length >= 2) {
    facts.push(fact('Hits the ' + targets.slice(0, 3).join(' and the ') + ' at the same time.', 'attack-map'));
  }
  // Anything left hanging is the opponent's best capture by static exchange.
  let worst = 0, worstSquare = -1;
  for (const reply of generateMoves(pos)) {
    if (!(moveFlags(reply) & FLAG_CAPTURE)) continue;
    const value = see(pos, reply);
    if (value > worst) { worst = value; worstSquare = moveTo(reply); }
  }
  unmakeMove(pos, move, undo);
  // A recapture on the square we just moved to is already priced into the SEE
  // of the move itself; reporting it again reads as a contradiction.
  if (worstSquare === to) worst = 0;
  if (worst > 90) {
    facts.push(fact('Leaves material on ' + squareName(worstSquare) + ': the reply wins ' +
      (worst / 100).toFixed(2) + ' by static exchange.', 'see'));
  }
  const shift = biggestTermShift(before, after);
  const signed = mover === WHITE ? shift.delta : -shift.delta;
  if (Math.abs(signed) >= 18 && TERM_PHRASE[shift.name]) {
    facts.push(fact(TERM_PHRASE[shift.name][signed > 0 ? 0 : 1] + ' (' + shift.name + ' term ' +
      (signed > 0 ? '+' : '') + (signed / 100).toFixed(2) + ').', 'eval-term:' + shift.name));
  }
  return facts;
}

export function scoreText(whiteCp, mateIn, turn) {
  if (mateIn !== null) {
    const winner = (mateIn > 0) === (turn === WHITE) ? 'White' : 'Black';
    return 'Mate in ' + Math.abs(mateIn) + ' for ' + winner;
  }
  const pawns = whiteCp / 100;
  if (Math.abs(pawns) < 0.25) return 'Level (' + pawns.toFixed(2) + ')';
  const who = pawns > 0 ? 'White' : 'Black';
  const size = Math.abs(pawns) < 0.8 ? 'slightly better' : Math.abs(pawns) < 2 ? 'better' : 'winning';
  return who + ' ' + size + ' (' + (pawns > 0 ? '+' : '') + pawns.toFixed(2) + ')';
}

export function explainResult(pos, result) {
  if (!result || !result.best) {
    return { headline: 'No legal moves in this position.', bullets: [], evalText: '--' };
  }
  const bullets = [];
  const san = moveToSan(pos, result.best);
  if (result.mateIn !== null) {
    bullets.push(fact('Search found a forced mate in ' + Math.abs(result.mateIn) + ' at depth ' +
      result.depth + '.', 'search-mate'));
  } else {
    bullets.push(fact('Best is ' + san + ' at ' + (result.scoreCp / 100).toFixed(2) +
      ', searched to depth ' + result.depth + ' over ' + result.nodes.toLocaleString('en-US') +
      ' positions.', 'search-score'));
    // Only compare against a runner-up whose score is a real measurement; a
    // null-window score is an upper bound and cannot support "close call".
    if (result.lines.length > 1 && result.lines[1].exact !== false) {
      const gap = result.lines[0].scoreCp - result.lines[1].scoreCp;
      bullets.push(fact(gap >= 60
        ? san + ' is ' + (gap / 100).toFixed(2) + ' clear of the next move.'
        : 'Close call: the top two moves are within ' + (gap / 100).toFixed(2) + '.', 'search-score'));
    }
  }
  for (const item of describeMove(pos, result.best)) bullets.push(item);
  return {
    headline: scoreText(result.whiteCp, result.mateIn, pos.turn) + ' -- best is ' + san + '.',
    bullets,
    evalText: scoreText(result.whiteCp, result.mateIn, pos.turn),
  };
}

const LABELS = [[20, 'best'], [50, 'good'], [100, 'inaccuracy'], [250, 'mistake'], [Infinity, 'blunder']];

// bestResult: the search of posBefore. afterResult: the search of the position
// the move produced, whose score belongs to the OTHER side and is negated here.
export function reviewMove(posBefore, movePlayed, bestResult, afterResult) {
  if (!bestResult || !afterResult || !movePlayed) return null;
  const playedSan = moveToSan(posBefore, movePlayed);
  const bestSan = bestResult.best ? moveToSan(posBefore, bestResult.best) : '';
  const achieved = -afterResult.scoreCp;
  const clamp = (v) => Math.max(-2000, Math.min(2000, v));
  const lostCp = Math.max(0, Math.round(clamp(bestResult.scoreCp) - clamp(achieved)));
  const label = movePlayed === bestResult.best ? 'best'
    : LABELS.find(([limit]) => lostCp < limit)[1];
  const bestPv = [];
  if (bestResult.pv.length) {
    const walk = posBefore;
    const undos = [];
    for (const m of bestResult.pv.slice(0, 6)) {
      bestPv.push(moveToSan(walk, m));
      undos.push([m, makeMove(walk, m)]);
    }
    while (undos.length) { const [m, u] = undos.pop(); unmakeMove(walk, m, u); }
  }
  return { label, lostCp, playedSan, bestSan, bestPv };
}

export const MATE_SCORE = MATE;
export { mateDistance };
