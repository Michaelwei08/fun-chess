// notation.test.mjs -- SAN must be unambiguous coming out, and the parser must
// never silently resolve to a move the human did not mean going in.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  START_FEN, fromFen, toFen, generateMoves, makeMove, squareName,
  moveFrom, moveTo, movePromo,
} from '../web/lib/rules.js';
import {
  moveToSan, sanToMove, moveToUci, uciToMove, moveListToPgn, glyphFor, pieceName,
} from '../web/lib/notation.js';

function prng(seed) {
  let s = seed >>> 0;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

const find = (pos, from, to, promo = 0) => generateMoves(pos).find((m) =>
  squareName(moveFrom(m)) === from && squareName(moveTo(m)) === to && (!promo || movePromo(m) === promo));

test('every legal move round trips through its own SAN', () => {
  const roots = [
    START_FEN,
    'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
    '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
  ];
  let checked = 0;
  for (let seed = 1; seed <= 4; seed++) {
    const rand = prng(seed * 104729);
    for (const fen of roots) {
      const pos = fromFen(fen);
      for (let ply = 0; ply < 30; ply++) {
        const moves = generateMoves(pos);
        if (!moves.length) break;
        for (const m of moves) {
          const san = moveToSan(pos, m);
          const back = sanToMove(pos, san);
          assert.equal(back, m,
            'SAN "' + san + '" from ' + toFen(pos) + ' parsed back to ' +
            (back ? moveToUci(back) : 'nothing') + ' instead of ' + moveToUci(m));
          checked++;
        }
        makeMove(pos, moves[Math.floor(rand() * moves.length)]);
      }
    }
  }
  assert.ok(checked > 5000, 'expected thousands of round trips, got ' + checked);
});

test('disambiguation adds file, rank or both, and nothing when it is not needed', () => {
  // Three white queens bearing on d4: a1, a4 and h4. Qd4 also checks h8, hence
  // the + on all three: file alone, rank alone, and the full square in turn.
  const three = fromFen('7k/8/8/8/Q6Q/8/8/Q3K3 w - - 0 1');
  assert.equal(moveToSan(three, find(three, 'a1', 'd4')), 'Q1d4+', 'file a is shared, rank 1 is not');
  assert.equal(moveToSan(three, find(three, 'a4', 'd4')), 'Qa4d4+', 'shares a file with a1 and a rank with h4');
  assert.equal(moveToSan(three, find(three, 'h4', 'd4')), 'Qhd4+', 'file h is enough');
  // Two knights on the same file need the rank.
  const file = fromFen('7k/8/8/N7/8/8/8/N3K3 w - - 0 1');
  assert.equal(moveToSan(file, find(file, 'a1', 'b3')), 'N1b3');
  assert.equal(moveToSan(file, find(file, 'a5', 'b3')), 'N5b3');
  // Two rooks on the same rank need the file. The king sits off the back rank so
  // that both rooks really can reach c1.
  const rank = fromFen('4k3/8/8/8/8/8/6K1/R6R w - - 0 1');
  assert.equal(moveToSan(rank, find(rank, 'a1', 'c1')), 'Rac1');
  assert.equal(moveToSan(rank, find(rank, 'h1', 'c1')), 'Rhc1');
  // A single knight needs nothing.
  const one = fromFen('7k/8/8/8/8/8/8/N3K3 w - - 0 1');
  assert.equal(moveToSan(one, find(one, 'a1', 'c2')), 'Nc2');
});

test('a pinned twin means no disambiguation is needed', () => {
  // Only the d2 knight can reach f3: the f2 knight is pinned by the rook on f8.
  const pos = fromFen('5r1k/8/8/8/8/8/3N1N2/5K2 w - - 0 1');
  assert.equal(generateMoves(pos).filter((m) => squareName(moveTo(m)) === 'f3').length, 1);
  assert.equal(moveToSan(pos, find(pos, 'd2', 'f3')), 'Nf3');
});

test('pawn, castling and promotion SAN', () => {
  const pos = fromFen('rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3');
  assert.equal(moveToSan(pos, find(pos, 'e5', 'f6')), 'exf6', 'en passant reads as a normal capture');
  assert.equal(moveToSan(pos, find(pos, 'd2', 'd4')), 'd4');
  const castle = fromFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  assert.equal(moveToSan(castle, find(castle, 'e1', 'g1')), 'O-O');
  assert.equal(moveToSan(castle, find(castle, 'e1', 'c1')), 'O-O-O');
  const promo = fromFen('4k2r/6P1/8/8/8/8/8/4K3 w - - 0 1');
  assert.equal(moveToSan(promo, find(promo, 'g7', 'h8', 5)), 'gxh8=Q+');
  assert.equal(moveToSan(promo, find(promo, 'g7', 'g8', 2)), 'g8=N');
  const mate = fromFen('6k1/5ppp/8/8/8/8/8/R3K2R w KQ - 0 1');
  assert.equal(moveToSan(mate, find(mate, 'a1', 'a8')), 'Ra8#');
});

test('the parser accepts every promised form', () => {
  const pos = fromFen('r3k2r/pppq1ppp/2n5/3pp3/1b2P3/2NP1N2/PPP1QPPP/R3K2R w KQkq - 0 9');
  const same = (text, from, to) => assert.equal(sanToMove(pos, text), find(pos, from, to), text);
  same('O-O', 'e1', 'g1');
  same('0-0', 'e1', 'g1');
  same('o-o-o', 'e1', 'c1');
  same('O-O-O', 'e1', 'c1');
  same('Nf3g5', 'f3', 'g5');
  same('e1g1', 'e1', 'g1');
  same('  Nd4  ', 'f3', 'd4');
  same('Nf3d4', 'f3', 'd4');
  same('a2a4', 'a2', 'a4');
  same('a2-a4', 'a2', 'a4');
  same('a4', 'a2', 'a4');
  same('exd5', 'e4', 'd5');
  same('ed5', 'e4', 'd5');
  same('e4xd5', 'e4', 'd5');
  const promo = fromFen('4k2r/6P1/8/8/8/8/8/4K3 w - - 0 1');
  for (const text of ['gxh8=Q', 'gxh8Q', 'gh8q', 'g7h8q', 'g7h8=Q']) {
    assert.equal(sanToMove(promo, text), find(promo, 'g7', 'h8', 5), text);
  }
});

test('the parser refuses rather than guessing', () => {
  const pos = fromFen('r3k2r/pppq1ppp/2n5/3pp3/1b2P3/2NP1N2/PPP1QPPP/R3K2R w KQkq - 0 9');
  const refuses = [
    'Nd7',        // no white knight can reach d7
    'e5',         // occupied by a black pawn, and no white pawn can push there
    'Ke2',        // occupied by the white queen
    'Qxb4',       // the queen cannot reach b4
    'banana', '', '   ', 'e9', 'z2z4', 'Nge2x',
  ];
  for (const text of refuses) assert.equal(sanToMove(pos, text), 0, text + ' should not resolve');
  const twins = fromFen('7k/8/8/8/8/2N3N1/8/4K3 w - - 0 1');
  assert.equal(sanToMove(twins, 'Ne4'), 0, 'ambiguous knight move must be refused');
  assert.equal(sanToMove(twins, 'Nce4'), find(twins, 'c3', 'e4'));
  assert.equal(sanToMove(twins, 'NCE4'), find(twins, 'c3', 'e4'),
    'all caps is fine while only one move matches case-insensitively');
  // A long-algebraic piece letter that contradicts the board is refused rather
  // than quietly ignored.
  assert.equal(sanToMove(twins, 'Bc3e4'), 0, 'there is no bishop on c3');
  // A promotion typed without the piece is ambiguous by definition.
  const promo = fromFen('4k2r/6P1/8/8/8/8/8/4K3 w - - 0 1');
  assert.equal(sanToMove(promo, 'g7g8'), 0);
});

test('the b-file pawn is not confused with a bishop', () => {
  // A bishop on e4 and a pawn on b5 can both take on c6.
  const pos = fromFen('4k3/8/2n5/1P6/4B3/8/8/4K3 w - - 0 1');
  assert.equal(sanToMove(pos, 'bxc6'), find(pos, 'b5', 'c6'), 'lowercase b is the pawn');
  assert.equal(sanToMove(pos, 'Bxc6'), find(pos, 'e4', 'c6'), 'uppercase B is the bishop');
  assert.notEqual(sanToMove(pos, 'bxc6'), sanToMove(pos, 'Bxc6'));
  assert.equal(sanToMove(pos, 'BXC6'), 0, 'all caps is refused when it fits two different moves');
  // And a bishop that can also reach b4 does not swallow the pawn push.
  const push = fromFen('4k3/8/8/8/8/8/1P1B4/4K3 w - - 0 1');
  assert.equal(sanToMove(push, 'b4'), find(push, 'b2', 'b4'), 'b4 is the pawn');
  assert.equal(sanToMove(push, 'Bb4'), find(push, 'd2', 'b4'), 'Bb4 is the bishop');
});

test('UCI in and out', () => {
  const pos = fromFen(START_FEN);
  assert.equal(moveToUci(find(pos, 'e2', 'e4')), 'e2e4');
  assert.equal(uciToMove(pos, 'e2e4'), find(pos, 'e2', 'e4'));
  assert.equal(uciToMove(pos, 'e2e5'), 0);
  const promo = fromFen('4k2r/6P1/8/8/8/8/8/4K3 w - - 0 1');
  assert.equal(moveToUci(find(promo, 'g7', 'h8', 2)), 'g7h8n');
  assert.equal(uciToMove(promo, 'g7h8n'), find(promo, 'g7', 'h8', 2));
  assert.equal(uciToMove(promo, 'g7h8'), 0, 'a promotion needs its piece in UCI');
});

test('PGN move text numbers correctly from either side', () => {
  assert.equal(moveListToPgn(['e4', 'e5', 'Nf3']), '1. e4 e5 2. Nf3');
  assert.equal(moveListToPgn(['e5', 'Nf3', 'Nc6'], 1, 1), '1... e5 2. Nf3 Nc6');
  assert.equal(moveListToPgn(['Kf2'], 0, 41), '41. Kf2');
  assert.equal(moveListToPgn([]), '');
});

test('glyphs and names cover both colours', () => {
  const pos = fromFen(START_FEN);
  assert.equal(glyphFor(pos.board[4]).codePointAt(0), 0x265a, 'white king uses the solid glyph');
  assert.equal(glyphFor(pos.board[116]).codePointAt(0), 0x265a, 'black king uses the same glyph');
  assert.equal(pieceName(pos.board[1]), 'white knight');
  assert.equal(pieceName(pos.board[113]), 'black knight');
  assert.equal(glyphFor(0), '');
});
