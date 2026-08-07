// fen.js -- FEN parsing and serialisation, square names, position cloning.
// Split out of rules.js only to keep every file under the 300-line site cap;
// rules.js re-exports all of it, so callers import from rules.js.

import { PAWN, KING, WHITE, BLACK, typeOf, colorOf, rehash } from './tables.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const CHARS = 'pnbrqk';
const CHAR_PIECE = {};
for (let t = PAWN; t <= KING; t++) {
  CHAR_PIECE[CHARS[t - 1].toUpperCase()] = t;
  CHAR_PIECE[CHARS[t - 1]] = t | 8;
}

export function squareName(sq) {
  return String.fromCharCode(97 + (sq & 7), 49 + (sq >> 4));
}

export function parseSquare(name) {
  if (typeof name !== 'string' || name.length !== 2) return -1;
  const f = name.charCodeAt(0) - 97, r = name.charCodeAt(1) - 49;
  if (f < 0 || f > 7 || r < 0 || r > 7) return -1;
  return r * 16 + f;
}

function parsePlacement(field, board, kings) {
  const rows = field.split('/');
  if (rows.length !== 8) throw new Error('FEN needs 8 ranks');
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of rows[7 - r]) {
      if (ch >= '1' && ch <= '8') { f += ch.charCodeAt(0) - 48; continue; }
      const p = CHAR_PIECE[ch];
      if (!p) throw new Error('FEN has an unknown piece: ' + ch);
      if (f > 7) throw new Error('FEN rank is too long');
      const sq = r * 16 + f;
      if (typeOf(p) === PAWN && (r === 0 || r === 7)) throw new Error('FEN has a pawn on a back rank');
      if (typeOf(p) === KING) {
        if (kings[colorOf(p)] >= 0) throw new Error('FEN has too many kings');
        kings[colorOf(p)] = sq;
      }
      board[sq] = p; f++;
    }
    if (f !== 8) throw new Error('FEN rank does not sum to 8');
  }
  if (kings[WHITE] < 0 || kings[BLACK] < 0) throw new Error('FEN is missing a king');
}

// An en-passant field is only meaningful if the double push that created it is
// actually reconstructable: right rank for the side to move, the pushed pawn
// still standing behind it, and both the target and its origin empty.
function parseEp(field, turn, board) {
  if (field === '-') return -1;
  const ep = parseSquare(field);
  if (ep < 0) throw new Error('FEN has a bad en-passant square');
  const rank = ep >> 4;
  if (rank !== (turn === WHITE ? 5 : 2)) throw new Error('FEN has an en-passant square on the wrong rank');
  const pawnSq = turn === WHITE ? ep - 16 : ep + 16;
  const originSq = turn === WHITE ? ep + 16 : ep - 16;
  if (board[pawnSq] !== (PAWN | ((turn ^ 1) << 3))) {
    throw new Error('FEN has an en-passant square with no pawn to capture');
  }
  if (board[ep] || board[originSq]) throw new Error('FEN has an obstructed en-passant square');
  return ep;
}

export function fromFen(fen) {
  if (typeof fen !== 'string') throw new Error('FEN must be a string');
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 4) throw new Error('FEN needs at least 4 fields');
  const board = new Int8Array(128);
  const kings = [-1, -1];
  parsePlacement(parts[0], board, kings);
  if (parts[1] !== 'w' && parts[1] !== 'b') throw new Error('FEN has a bad side to move');
  const turn = parts[1] === 'b' ? BLACK : WHITE;
  let castling = 0;
  if (parts[2] !== '-') {
    for (const ch of parts[2]) {
      const bit = 'KQkq'.indexOf(ch);
      if (bit < 0) throw new Error('FEN has a bad castling field');
      castling |= 1 << bit;
    }
  }
  const ep = parseEp(parts[3], turn, board);
  const half = parts.length > 4 ? Number(parts[4]) : 0;
  const full = parts.length > 5 ? Number(parts[5]) : 1;
  if (!Number.isInteger(half) || half < 0) throw new Error('FEN has a bad halfmove clock');
  if (!Number.isInteger(full) || full < 1) throw new Error('FEN has a bad fullmove number');
  return rehash({ board, turn, castling, ep, half, full, kings, hashLo: 0, hashHi: 0 });
}

export function toFen(pos) {
  let out = '';
  for (let r = 7; r >= 0; r--) {
    let run = 0;
    for (let f = 0; f < 8; f++) {
      const p = pos.board[r * 16 + f];
      if (!p) { run++; continue; }
      if (run) { out += run; run = 0; }
      const c = CHARS[typeOf(p) - 1];
      out += colorOf(p) === WHITE ? c.toUpperCase() : c;
    }
    if (run) out += run;
    if (r) out += '/';
  }
  let cast = '';
  if (pos.castling & 1) cast += 'K';
  if (pos.castling & 2) cast += 'Q';
  if (pos.castling & 4) cast += 'k';
  if (pos.castling & 8) cast += 'q';
  const ep = pos.ep >= 0 ? squareName(pos.ep) : '-';
  return out + ' ' + (pos.turn === BLACK ? 'b' : 'w') + ' ' + (cast || '-') +
    ' ' + ep + ' ' + pos.half + ' ' + pos.full;
}

export function clonePosition(pos) {
  return {
    board: pos.board.slice(), turn: pos.turn, castling: pos.castling, ep: pos.ep,
    half: pos.half, full: pos.full, kings: [pos.kings[0], pos.kings[1]],
    hashLo: pos.hashLo, hashHi: pos.hashHi,
  };
}
