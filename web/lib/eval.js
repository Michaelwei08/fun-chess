// eval.js -- tapered evaluation in centipawns, plus the per-term breakdown the
// analysis view shows. One function computes both, so the bar and the
// explanation can never disagree with the score the search actually used.

import {
  PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, WHITE, BLACK,
  N_OFF, K_OFF, B_OFF, R_OFF,
} from './tables.js';

export const PIECE_VALUE = [0, 100, 320, 330, 500, 900, 0];
const PHASE_WEIGHT = [0, 0, 1, 1, 2, 4, 0];
const TOTAL_PHASE = 24;

// Piece-square tables, written from White's point of view with a8 first.
const PST_PAWN_MID = [
  0, 0, 0, 0, 0, 0, 0, 0,
  50, 50, 50, 50, 50, 50, 50, 50,
  10, 10, 20, 30, 30, 20, 10, 10,
  5, 5, 10, 25, 25, 10, 5, 5,
  0, 0, 0, 20, 20, 0, 0, 0,
  5, -5, -10, 0, 0, -10, -5, 5,
  5, 10, 10, -20, -20, 10, 10, 5,
  0, 0, 0, 0, 0, 0, 0, 0];
const PST_PAWN_END = [
  0, 0, 0, 0, 0, 0, 0, 0,
  90, 90, 90, 90, 90, 90, 90, 90,
  55, 55, 55, 55, 55, 55, 55, 55,
  30, 30, 30, 30, 30, 30, 30, 30,
  18, 18, 18, 18, 18, 18, 18, 18,
  8, 8, 8, 8, 8, 8, 8, 8,
  6, 6, 6, 6, 6, 6, 6, 6,
  0, 0, 0, 0, 0, 0, 0, 0];
const PST_KNIGHT = [
  -50, -40, -30, -30, -30, -30, -40, -50,
  -40, -20, 0, 0, 0, 0, -20, -40,
  -30, 0, 10, 15, 15, 10, 0, -30,
  -30, 5, 15, 20, 20, 15, 5, -30,
  -30, 0, 15, 20, 20, 15, 0, -30,
  -30, 5, 10, 15, 15, 10, 5, -30,
  -40, -20, 0, 5, 5, 0, -20, -40,
  -50, -40, -30, -30, -30, -30, -40, -50];
const PST_BISHOP = [
  -20, -10, -10, -10, -10, -10, -10, -20,
  -10, 0, 0, 0, 0, 0, 0, -10,
  -10, 0, 5, 10, 10, 5, 0, -10,
  -10, 5, 5, 10, 10, 5, 5, -10,
  -10, 0, 10, 10, 10, 10, 0, -10,
  -10, 10, 10, 10, 10, 10, 10, -10,
  -10, 5, 0, 0, 0, 0, 5, -10,
  -20, -10, -10, -10, -10, -10, -10, -20];
const PST_ROOK = [
  0, 0, 0, 0, 0, 0, 0, 0,
  5, 10, 10, 10, 10, 10, 10, 5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  0, 0, 0, 5, 5, 0, 0, 0];
const PST_QUEEN = [
  -20, -10, -10, -5, -5, -10, -10, -20,
  -10, 0, 0, 0, 0, 0, 0, -10,
  -10, 0, 5, 5, 5, 5, 0, -10,
  -5, 0, 5, 5, 5, 5, 0, -5,
  0, 0, 5, 5, 5, 5, 0, -5,
  -10, 5, 5, 5, 5, 5, 0, -10,
  -10, 0, 5, 0, 0, 0, 0, -10,
  -20, -10, -10, -5, -5, -10, -10, -20];
const PST_KING_MID = [
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -20, -30, -30, -40, -40, -30, -30, -20,
  -10, -20, -20, -20, -20, -20, -20, -10,
  20, 20, 0, 0, 0, 0, 20, 20,
  20, 30, 10, 0, 0, 10, 30, 20];
const PST_KING_END = [
  -50, -40, -30, -20, -20, -30, -40, -50,
  -30, -20, -10, 0, 0, -10, -20, -30,
  -30, -10, 20, 30, 30, 20, -10, -30,
  -30, -10, 30, 40, 40, 30, -10, -30,
  -30, -10, 30, 40, 40, 30, -10, -30,
  -30, -10, 20, 30, 30, 20, -10, -30,
  -30, -30, 0, 0, 0, 0, -30, -30,
  -50, -30, -30, -30, -30, -30, -30, -50];

const MID = [null, PST_PAWN_MID, PST_KNIGHT, PST_BISHOP, PST_ROOK, PST_QUEEN, PST_KING_MID];
const END = [null, PST_PAWN_END, PST_KNIGHT, PST_BISHOP, PST_ROOK, PST_QUEEN, PST_KING_END];
const PASSED_BONUS = [0, 10, 20, 35, 60, 100, 150, 0];
const MOBILITY_WEIGHT = [0, 0, 4, 4, 2, 1, 0];
export const TEMPO = 8;

const pstIndex = (sq, color) => (color === WHITE ? (7 - (sq >> 4)) * 8 + (sq & 7) : (sq >> 4) * 8 + (sq & 7));

function slidingMobility(board, from, offs, us) {
  let count = 0;
  for (let i = 0; i < offs.length; i++) {
    for (let to = from + offs[i]; (to & 0x88) === 0; to += offs[i]) {
      const target = board[to];
      if (!target) { count++; continue; }
      if ((target >> 3) !== us) count++;
      break;
    }
  }
  return count;
}

function stepMobility(board, from, offs, us) {
  let count = 0;
  for (let i = 0; i < 8; i++) {
    const to = from + offs[i];
    if ((to & 0x88) !== 0) continue;
    if (!board[to] || (board[to] >> 3) !== us) count++;
  }
  return count;
}

// Shelter: for each of the three files around the king, a missing own pawn on
// the two ranks in front of it costs, and a file with no own pawn at all costs
// more. Scaled by phase, because none of it matters in a bare-king endgame.
function kingShelter(pawnRear, kingSq, us) {
  let penalty = 0;
  const file = kingSq & 7;
  for (let f = Math.max(0, file - 1); f <= Math.min(7, file + 1); f++) {
    const nearest = pawnRear[us][f];
    if (nearest < 0) { penalty -= 24; continue; }
    const distance = us === WHITE ? nearest - (kingSq >> 4) : (kingSq >> 4) - nearest;
    if (distance === 1) continue;
    penalty -= distance === 2 ? 6 : 12;
  }
  return penalty;
}

function score(pos, detail) {
  const b = pos.board;
  let material = 0, position = 0, pawns = 0, king = 0, mobility = 0, pieces = 0;
  let phaseSum = 0;
  // pawnFront = most advanced pawn on a file (passers); pawnRear = the one
  // nearest its own king (shelter). Conflating the two misreads doubled pawns.
  const bishops = [0, 0], pawnCount = [[], []], pawnFront = [[], []], pawnRear = [[], []];
  for (let c = 0; c < 2; c++) {
    for (let f = 0; f < 8; f++) { pawnCount[c][f] = 0; pawnFront[c][f] = -1; pawnRear[c][f] = -1; }
  }
  const mids = [0, 0], ends = [0, 0];

  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const sq = r * 16 + f, p = b[sq];
      if (!p) continue;
      const t = p & 7, c = p >> 3, sign = c === WHITE ? 1 : -1;
      phaseSum += PHASE_WEIGHT[t];
      material += sign * PIECE_VALUE[t];
      const idx = pstIndex(sq, c);
      mids[c] += MID[t][idx]; ends[c] += END[t][idx];
      if (t === PAWN) {
        pawnCount[c][f]++;
        if (pawnFront[c][f] < 0 || (c === WHITE ? r > pawnFront[c][f] : r < pawnFront[c][f])) {
          pawnFront[c][f] = r;
        }
        if (pawnRear[c][f] < 0 || (c === WHITE ? r < pawnRear[c][f] : r > pawnRear[c][f])) {
          pawnRear[c][f] = r;
        }
      } else if (t === BISHOP) bishops[c]++;
      else if (t === KNIGHT || t === ROOK || t === QUEEN) {
        const offs = t === KNIGHT ? N_OFF : t === ROOK ? R_OFF : K_OFF;
        const m = t === KNIGHT ? stepMobility(b, sq, offs, c) : slidingMobility(b, sq, offs, c);
        mobility += sign * m * MOBILITY_WEIGHT[t];
      }
      if (t === BISHOP) mobility += sign * slidingMobility(b, sq, B_OFF, c) * MOBILITY_WEIGHT[BISHOP];
    }
  }

  const phase = Math.min(phaseSum, TOTAL_PHASE) / TOTAL_PHASE;
  position = Math.round((mids[WHITE] - mids[BLACK]) * phase + (ends[WHITE] - ends[BLACK]) * (1 - phase));

  for (let c = 0; c < 2; c++) {
    const sign = c === WHITE ? 1 : -1, them = c ^ 1;
    for (let f = 0; f < 8; f++) {
      const n = pawnCount[c][f];
      if (!n) continue;
      if (n > 1) pawns -= sign * (n - 1) * 12;
      const left = f > 0 ? pawnCount[c][f - 1] : 0, right = f < 7 ? pawnCount[c][f + 1] : 0;
      if (!left && !right) pawns -= sign * 16;
      const rank = pawnFront[c][f];
      let blocked = false;
      for (let g = Math.max(0, f - 1); g <= Math.min(7, f + 1) && !blocked; g++) {
        const enemy = pawnFront[them][g];
        if (enemy < 0) continue;
        blocked = c === WHITE ? enemy > rank : enemy < rank;
      }
      if (!blocked) pawns += sign * PASSED_BONUS[c === WHITE ? rank : 7 - rank];
    }
    if (bishops[c] >= 2) pieces += sign * 30;
    king += sign * Math.round(kingShelter(pawnRear, pos.kings[c], c) * phase);
  }

  // Rooks like files their own pawns have left.
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = b[r * 16 + f];
      if (!p || (p & 7) !== ROOK) continue;
      const c = p >> 3, sign = c === WHITE ? 1 : -1;
      if (!pawnCount[c][f]) pieces += sign * (pawnCount[c ^ 1][f] ? 8 : 18);
    }
  }

  const tempo = pos.turn === WHITE ? TEMPO : -TEMPO;
  const total = material + position + pawns + king + mobility + pieces + tempo;
  if (!detail) return total;
  return { material, position, pawns, king, mobility, pieces, tempo, phase, total };
}

export function evaluateWhite(pos) {
  return score(pos, false);
}

export function evaluate(pos) {
  const s = score(pos, false);
  return pos.turn === WHITE ? s : -s;
}

export function evalBreakdown(pos) {
  return score(pos, true);
}

// True when the side has something other than pawns to move; null-move pruning
// is unsound in king-and-pawn endings, where zugzwang is the whole game.
export function hasPieces(pos, side) {
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = pos.board[r * 16 + f];
      if (p && (p >> 3) === side) {
        const t = p & 7;
        if (t !== PAWN && t !== KING) return true;
      }
    }
  }
  return false;
}
