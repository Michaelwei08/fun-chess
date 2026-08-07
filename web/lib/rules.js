// rules.js -- CHESS/64: 0x88 board, legal move generation, make/unmake, zobrist,
// game status. The single source of truth for chess rules in this project: the
// search, the UI and the analysis view all call it and none of them may
// re-implement a rule. See docs/CONTRACT.md. Verified by tests/perft.test.mjs.

import {
  PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, WHITE, BLACK,
  N_OFF, K_OFF, B_OFF, R_OFF, CASTLE_MASK, ZP_LO, ZP_HI, ZC_LO, ZC_HI, ZE_LO, ZE_HI, ZT,
} from './tables.js';

export {
  EMPTY, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, WHITE, BLACK, typeOf, colorOf, rehash,
} from './tables.js';
export { START_FEN, squareName, parseSquare, fromFen, toFen, clonePosition } from './fen.js';

export const FLAG_CAPTURE = 1, FLAG_DOUBLE = 2, FLAG_EP = 4,
  FLAG_CASTLE_K = 8, FLAG_CASTLE_Q = 16;
export const moveFrom = (m) => m & 0xff;
export const moveTo = (m) => (m >> 8) & 0xff;
export const movePromo = (m) => (m >> 16) & 0xf;
export const moveFlags = (m) => (m >> 20) & 0x1f;
export function encodeMove(from, to, promo, flags) {
  return (from & 0xff) | ((to & 0xff) << 8) | ((promo & 0xf) << 16) | ((flags & 0x1f) << 20);
}

// Off-board indices are either the always-empty 0x88 files or out of range, so a
// plain piece-code comparison is safe without a bounds test.
export function isSquareAttacked(pos, sq, bySide) {
  const b = pos.board, base = bySide << 3;
  const pawn = PAWN | base;
  if (bySide === WHITE) {
    if (b[sq - 17] === pawn || b[sq - 15] === pawn) return true;
  } else if (b[sq + 17] === pawn || b[sq + 15] === pawn) return true;
  const knight = KNIGHT | base, king = KING | base;
  for (let i = 0; i < 8; i++) if (b[sq + N_OFF[i]] === knight) return true;
  for (let i = 0; i < 8; i++) if (b[sq + K_OFF[i]] === king) return true;
  const queen = QUEEN | base, rook = ROOK | base, bishop = BISHOP | base;
  for (let i = 0; i < 4; i++) {
    const o = R_OFF[i];
    for (let t = sq + o; (t & 0x88) === 0; t += o) {
      const p = b[t];
      if (p) { if (p === queen || p === rook) return true; break; }
    }
  }
  for (let i = 0; i < 4; i++) {
    const o = B_OFF[i];
    for (let t = sq + o; (t & 0x88) === 0; t += o) {
      const p = b[t];
      if (p) { if (p === queen || p === bishop) return true; break; }
    }
  }
  return false;
}

export function inCheck(pos, side = pos.turn) {
  return isSquareAttacked(pos, pos.kings[side], side ^ 1);
}

// A position is illegal to play from if the side that just moved can be captured.
// fromFen cannot check this without the attack tables, so the UI calls it on load.
export function legalPosition(pos) {
  if (inCheck(pos, pos.turn ^ 1)) {
    return { ok: false, reason: 'the side not to move is in check' };
  }
  return { ok: true, reason: '' };
}

function pushPawnMoves(out, from, to, flags) {
  if (to >= 112 || to < 8) {
    out.push(encodeMove(from, to, QUEEN, flags), encodeMove(from, to, ROOK, flags),
      encodeMove(from, to, BISHOP, flags), encodeMove(from, to, KNIGHT, flags));
  } else {
    out.push(encodeMove(from, to, 0, flags));
  }
}

function genCastles(pos, out) {
  const b = pos.board, us = pos.turn, them = us ^ 1;
  const home = us === WHITE ? 4 : 116, rook = ROOK | (us << 3);
  if (pos.kings[us] !== home || b[home] !== (KING | (us << 3))) return;
  const kingRight = us === WHITE ? 1 : 4, queenRight = us === WHITE ? 2 : 8;
  if ((pos.castling & kingRight) && b[home + 3] === rook && !b[home + 1] && !b[home + 2] &&
    !isSquareAttacked(pos, home, them) && !isSquareAttacked(pos, home + 1, them) &&
    !isSquareAttacked(pos, home + 2, them)) {
    out.push(encodeMove(home, home + 2, 0, FLAG_CASTLE_K));
  }
  if ((pos.castling & queenRight) && b[home - 4] === rook && !b[home - 1] && !b[home - 2] &&
    !b[home - 3] && !isSquareAttacked(pos, home, them) &&
    !isSquareAttacked(pos, home - 1, them) && !isSquareAttacked(pos, home - 2, them)) {
    out.push(encodeMove(home, home - 2, 0, FLAG_CASTLE_Q));
  }
}

function genPseudo(pos, capturesOnly, out) {
  const b = pos.board, us = pos.turn, them = us ^ 1;
  const up = us === WHITE ? 16 : -16, startRank = us === WHITE ? 1 : 6;
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const from = r * 16 + f, p = b[from];
      if (!p || (p >> 3) !== us) continue;
      const t = p & 7;
      if (t === PAWN) {
        const one = from + up;
        if (!b[one]) {
          if (!capturesOnly || one >= 112 || one < 8) pushPawnMoves(out, from, one, 0);
          if (r === startRank && !b[one + up] && !capturesOnly) {
            out.push(encodeMove(from, one + up, 0, FLAG_DOUBLE));
          }
        }
        for (let d = -1; d <= 1; d += 2) {
          const to = one + d;
          if ((to & 0x88) !== 0) continue;
          const target = b[to];
          if (target && (target >> 3) === them) pushPawnMoves(out, from, to, FLAG_CAPTURE);
          else if (!target && to === pos.ep) {
            out.push(encodeMove(from, to, 0, FLAG_CAPTURE | FLAG_EP));
          }
        }
      } else if (t === KNIGHT || t === KING) {
        const offs = t === KNIGHT ? N_OFF : K_OFF;
        for (let i = 0; i < 8; i++) {
          const to = from + offs[i];
          if ((to & 0x88) !== 0) continue;
          const target = b[to];
          if (!target) { if (!capturesOnly) out.push(encodeMove(from, to, 0, 0)); }
          else if ((target >> 3) === them) out.push(encodeMove(from, to, 0, FLAG_CAPTURE));
        }
      } else {
        const offs = t === BISHOP ? B_OFF : t === ROOK ? R_OFF : K_OFF;
        for (let i = 0; i < offs.length; i++) {
          const o = offs[i];
          for (let to = from + o; (to & 0x88) === 0; to += o) {
            const target = b[to];
            if (!target) {
              if (!capturesOnly) out.push(encodeMove(from, to, 0, 0));
              continue;
            }
            if ((target >> 3) === them) out.push(encodeMove(from, to, 0, FLAG_CAPTURE));
            break;
          }
        }
      }
    }
  }
  if (!capturesOnly) genCastles(pos, out);
}

export function generateMoves(pos, capturesOnly = false) {
  const pseudo = [];
  genPseudo(pos, capturesOnly, pseudo);
  const legal = [];
  const us = pos.turn, them = us ^ 1;
  for (let i = 0; i < pseudo.length; i++) {
    const m = pseudo[i];
    const undo = makeMove(pos, m);
    if (!isSquareAttacked(pos, pos.kings[us], them)) legal.push(m);
    unmakeMove(pos, m, undo);
  }
  return legal;
}

export function makeMove(pos, move) {
  const b = pos.board;
  const from = move & 0xff, to = (move >> 8) & 0xff;
  const promo = (move >> 16) & 0xf, flags = (move >> 20) & 0x1f;
  const us = pos.turn, base = us << 3, piece = b[from];
  const undo = {
    cap: 0, capSq: -1, castling: pos.castling, ep: pos.ep, half: pos.half,
    full: pos.full, hashLo: pos.hashLo, hashHi: pos.hashHi,
  };
  let lo = pos.hashLo, hi = pos.hashHi;
  if (pos.ep >= 0) { lo ^= ZE_LO[pos.ep]; hi ^= ZE_HI[pos.ep]; }
  lo ^= ZC_LO[pos.castling]; hi ^= ZC_HI[pos.castling];
  const capSq = (flags & FLAG_EP) ? (us === WHITE ? to - 16 : to + 16) : to;
  const cap = b[capSq];
  if (cap) {
    undo.cap = cap; undo.capSq = capSq; b[capSq] = 0;
    const i = cap * 128 + capSq; lo ^= ZP_LO[i]; hi ^= ZP_HI[i];
  }
  const landed = promo ? (promo | base) : piece;
  b[from] = 0; b[to] = landed;
  let i = piece * 128 + from; lo ^= ZP_LO[i]; hi ^= ZP_HI[i];
  i = landed * 128 + to; lo ^= ZP_LO[i]; hi ^= ZP_HI[i];
  if (flags & (FLAG_CASTLE_K | FLAG_CASTLE_Q)) {
    const rf = (flags & FLAG_CASTLE_K) ? to + 1 : to - 2;
    const rt = (flags & FLAG_CASTLE_K) ? to - 1 : to + 1;
    const rook = ROOK | base;
    b[rf] = 0; b[rt] = rook;
    i = rook * 128 + rf; lo ^= ZP_LO[i]; hi ^= ZP_HI[i];
    i = rook * 128 + rt; lo ^= ZP_LO[i]; hi ^= ZP_HI[i];
  }
  if ((piece & 7) === KING) pos.kings[us] = to;
  pos.castling = pos.castling & CASTLE_MASK[from] & CASTLE_MASK[to];
  lo ^= ZC_LO[pos.castling]; hi ^= ZC_HI[pos.castling];
  pos.ep = (flags & FLAG_DOUBLE) ? from + (us === WHITE ? 16 : -16) : -1;
  if (pos.ep >= 0) { lo ^= ZE_LO[pos.ep]; hi ^= ZE_HI[pos.ep]; }
  pos.half = (cap || (piece & 7) === PAWN) ? 0 : pos.half + 1;
  if (us === BLACK) pos.full++;
  pos.turn = us ^ 1;
  lo ^= ZT[0]; hi ^= ZT[1];
  pos.hashLo = lo | 0; pos.hashHi = hi | 0;
  return undo;
}

export function unmakeMove(pos, move, undo) {
  const b = pos.board;
  const from = move & 0xff, to = (move >> 8) & 0xff;
  const promo = (move >> 16) & 0xf, flags = (move >> 20) & 0x1f;
  const us = pos.turn ^ 1, base = us << 3;
  const moved = promo ? (PAWN | base) : b[to];
  b[to] = 0; b[from] = moved;
  if (undo.cap) b[undo.capSq] = undo.cap;
  if (flags & (FLAG_CASTLE_K | FLAG_CASTLE_Q)) {
    const rf = (flags & FLAG_CASTLE_K) ? to + 1 : to - 2;
    const rt = (flags & FLAG_CASTLE_K) ? to - 1 : to + 1;
    b[rt] = 0; b[rf] = ROOK | base;
  }
  if ((moved & 7) === KING) pos.kings[us] = from;
  pos.castling = undo.castling; pos.ep = undo.ep;
  pos.half = undo.half; pos.full = undo.full; pos.turn = us;
  pos.hashLo = undo.hashLo; pos.hashHi = undo.hashHi;
}

export function positionKey(pos) {
  return (pos.hashLo >>> 0).toString(36) + '-' + (pos.hashHi >>> 0).toString(36);
}

function insufficientMaterial(pos) {
  const bishops = [[], []], knights = [0, 0];
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = pos.board[r * 16 + f];
      if (!p) continue;
      const t = p & 7, c = p >> 3;
      if (t === PAWN || t === ROOK || t === QUEEN) return false;
      if (t === BISHOP) bishops[c].push((r + f) & 1);
      else if (t === KNIGHT) knights[c]++;
    }
  }
  const nb = bishops[WHITE].length + bishops[BLACK].length;
  const nn = knights[WHITE] + knights[BLACK];
  if (nb + nn <= 1) return true;
  if (nn === 0 && bishops[WHITE].length === 1 && bishops[BLACK].length === 1) {
    return bishops[WHITE][0] === bishops[BLACK][0];
  }
  return false;
}

export function gameStatus(pos, keyCounts = null) {
  if (generateMoves(pos).length === 0) {
    if (inCheck(pos)) {
      return { over: true, result: pos.turn === WHITE ? 'black' : 'white', reason: 'checkmate' };
    }
    return { over: true, result: 'draw', reason: 'stalemate' };
  }
  if (pos.half >= 100) return { over: true, result: 'draw', reason: 'fifty-move' };
  if (keyCounts && (keyCounts.get(positionKey(pos)) || 0) >= 3) {
    return { over: true, result: 'draw', reason: 'threefold' };
  }
  if (insufficientMaterial(pos)) {
    return { over: true, result: 'draw', reason: 'insufficient-material' };
  }
  return { over: false, result: null, reason: 'in-progress' };
}
