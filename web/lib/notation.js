// notation.js -- SAN and UCI generation, plus a deliberately tolerant parser.
// This is the layer a human types into at a live board, so the failure mode to
// avoid is not "refuses my input" but "silently plays a different move": every
// parse path below resolves to exactly one legal move or returns 0.

import {
  PAWN, typeOf, squareName, parseSquare, generateMoves, makeMove, unmakeMove,
  inCheck, moveFrom, moveTo, movePromo, moveFlags, FLAG_CAPTURE, FLAG_CASTLE_K, FLAG_CASTLE_Q,
} from './rules.js';

const LETTERS = 'PNBRQK';
const PROMO_LETTERS = 'NBRQ';

function suffix(pos, move) {
  const undo = makeMove(pos, move);
  const check = inCheck(pos);
  const stuck = check && generateMoves(pos).length === 0;
  unmakeMove(pos, move, undo);
  return stuck ? '#' : check ? '+' : '';
}

// Standard disambiguation: file if it suffices, else rank, else the whole square.
function disambiguate(pos, move, piece) {
  const from = moveFrom(move), to = moveTo(move);
  let sameFile = false, sameRank = false, rivals = 0;
  for (const other of generateMoves(pos)) {
    const oFrom = moveFrom(other);
    if (oFrom === from || moveTo(other) !== to || pos.board[oFrom] !== piece) continue;
    rivals++;
    if ((oFrom & 7) === (from & 7)) sameFile = true;
    if ((oFrom >> 4) === (from >> 4)) sameRank = true;
  }
  if (!rivals) return '';
  if (!sameFile) return squareName(from)[0];
  if (!sameRank) return squareName(from)[1];
  return squareName(from);
}

export function moveToSan(pos, move) {
  const flags = moveFlags(move);
  if (flags & FLAG_CASTLE_K) return 'O-O' + suffix(pos, move);
  if (flags & FLAG_CASTLE_Q) return 'O-O-O' + suffix(pos, move);
  const from = moveFrom(move), to = moveTo(move), promo = movePromo(move);
  const piece = pos.board[from], type = typeOf(piece);
  let san;
  if (type === PAWN) {
    san = (flags & FLAG_CAPTURE) ? squareName(from)[0] + 'x' + squareName(to) : squareName(to);
    if (promo) san += '=' + PROMO_LETTERS[promo - 2];
  } else {
    san = LETTERS[type - 1] + disambiguate(pos, move, piece) +
      ((flags & FLAG_CAPTURE) ? 'x' : '') + squareName(to);
  }
  return san + suffix(pos, move);
}

export function moveToUci(move) {
  return squareName(moveFrom(move)) + squareName(moveTo(move)) +
    (movePromo(move) ? PROMO_LETTERS[movePromo(move) - 2].toLowerCase() : '');
}

// Coordinate and long-algebraic entry: e2e4, e2-e4, e2 e4, Nf3g5, e7e8q. The
// piece letter is optional but is verified when given, so "Nf3g5" cannot resolve
// to a bishop move that happens to share the squares.
function matchCoordinates(pos, text) {
  const m = /^([KQRBN])?([a-h][1-8])[\s\-x]?([a-h][1-8])\s*=?\s*([nbrqNBRQ])?[+#]?$/.exec(text);
  if (!m) return null;
  const from = parseSquare(m[2]), to = parseSquare(m[3]);
  const promo = m[4] ? PROMO_LETTERS.indexOf(m[4].toUpperCase()) + 2 : 0;
  if (m[1] && LETTERS.indexOf(m[1]) + 1 !== typeOf(pos.board[from])) return 0;
  const hits = generateMoves(pos).filter((mv) =>
    moveFrom(mv) === from && moveTo(mv) === to && (promo ? movePromo(mv) === promo : true));
  // A promotion typed without a piece letter is ambiguous by definition; the UI
  // asks instead of guessing queen.
  return hits.length === 1 ? hits[0] : 0;
}

function matchCastling(pos, text) {
  const flat = text.replace(/[\s\-]/g, '').toLowerCase().replace(/0/g, 'o');
  if (flat !== 'oo' && flat !== 'ooo') return null;
  const want = flat === 'oo' ? FLAG_CASTLE_K : FLAG_CASTLE_Q;
  const hits = generateMoves(pos).filter((mv) => moveFlags(mv) & want);
  return hits.length === 1 ? hits[0] : 0;
}

// Strip everything decorative so "exd8=Q+" and "exd8Q" and "ed8q" all compare
// equal in shape; case is kept, because it is the only thing separating the
// bishop move Bc6 from the b-file pawn capture bxc6.
function shape(text) {
  return text.replace(/[+#!?\s]/g, '').replace(/[x:]/g, '').replace(/=/g, '').replace(/e\.p\.$/i, '');
}

export function sanToMove(pos, text) {
  if (typeof text !== 'string') return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const castle = matchCastling(pos, trimmed);
  if (castle !== null) return castle;
  const coords = matchCoordinates(pos, trimmed);
  if (coords !== null) return coords;
  const wanted = shape(trimmed);
  const strong = [], weak = [];
  for (const move of generateMoves(pos)) {
    const san = shape(moveToSan(pos, move));
    if (san === wanted) strong.push(move);
    else if (san.toLowerCase() === wanted.toLowerCase()) weak.push(move);
  }
  if (strong.length === 1) return strong[0];
  if (!strong.length && weak.length === 1) return weak[0];
  return 0;
}

export function uciToMove(pos, text) {
  if (typeof text !== 'string') return 0;
  const m = /^([a-h][1-8])([a-h][1-8])([nbrq])?$/.exec(text.trim().toLowerCase());
  if (!m) return 0;
  const from = parseSquare(m[1]), to = parseSquare(m[2]);
  const promo = m[3] ? PROMO_LETTERS.indexOf(m[3].toUpperCase()) + 2 : 0;
  const hits = generateMoves(pos).filter((mv) =>
    moveFrom(mv) === from && moveTo(mv) === to && movePromo(mv) === promo);
  return hits.length === 1 ? hits[0] : 0;
}

// Render a principal variation as SAN. The position is walked forward and then
// unwound, so the caller's position object is untouched.
export function pvToSan(pos, moves, limit = 8) {
  const out = [], undos = [];
  for (const move of moves.slice(0, limit)) {
    if (!generateMoves(pos).includes(move)) break;
    out.push(moveToSan(pos, move));
    undos.push([move, makeMove(pos, move)]);
  }
  while (undos.length) { const [move, undo] = undos.pop(); unmakeMove(pos, move, undo); }
  return out;
}

// Move text only -- no tag pair section, because a Chess Lab record can start
// from a pasted FEN and is not a legal standalone PGN game anyway.
export function moveListToPgn(sanList, startTurn = 0, startFull = 1) {
  let out = '', number = startFull, turn = startTurn;
  for (let i = 0; i < sanList.length; i++) {
    if (turn === 0) out += (out ? ' ' : '') + number + '. ' + sanList[i];
    else {
      out += out ? ' ' : '';
      if (i === 0) out += number + '... ';
      out += sanList[i];
      number++;
    }
    turn ^= 1;
  }
  return out;
}

// Piece glyphs live here so the board, the move list and the captured-piece
// strips cannot drift apart. The SOLID glyph set is used for both colours and
// CSS distinguishes them by fill and stroke: the outline set (U+2654..U+2659)
// renders at a different weight in many fonts, which makes one side look faint.
// Written as escapes to keep every source file ASCII (a Windows encoding lesson
// carried over from the sibling projects).
export const GLYPHS = [0, 0x265f, 0x265e, 0x265d, 0x265c, 0x265b, 0x265a]
  .map((code) => (code ? String.fromCharCode(code) : ''));
const NAMES = ['', 'pawn', 'knight', 'bishop', 'rook', 'queen', 'king'];

export function glyphFor(piece) {
  return piece ? GLYPHS[typeOf(piece)] : '';
}

export function pieceName(piece) {
  if (!piece) return 'empty';
  return (piece >> 3 ? 'black ' : 'white ') + NAMES[typeOf(piece)];
}
