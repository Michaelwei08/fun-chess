// rules.test.mjs -- everything about the rule set that perft cannot see:
// FEN validation, castling rights, draws, and state/hash integrity.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  START_FEN, fromFen, toFen, clonePosition, generateMoves, makeMove, unmakeMove,
  gameStatus, positionKey, inCheck, legalPosition, rehash, squareName, parseSquare,
  moveFrom, moveTo, moveFlags, movePromo, FLAG_CAPTURE, FLAG_EP, QUEEN,
} from '../web/lib/rules.js';

// Deterministic PRNG so a failure is always reproducible from the seed.
function prng(seed) {
  let s = seed >>> 0;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

const FENS = [
  START_FEN,
  'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
  '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
  'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3',
  '4k3/8/8/8/8/8/8/R3K2R w KQ - 12 40',
];

test('FEN round trips exactly', () => {
  for (const fen of FENS) assert.equal(toFen(fromFen(fen)), fen);
});

test('FEN rejects malformed and illegal placements', () => {
  const bad = [
    ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP w KQkq - 0 1', 'too few ranks'],
    ['rnbqkbnr/ppppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'nine pawns on a rank'],
    ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNK w KQkq - 0 1', 'no white king'],
    ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq', 'missing the en-passant field'],
    ['Pnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'pawn on the back rank'],
    ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KXkq - 0 1', 'bad castling field'],
    ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1', 'bad side to move'],
    ['4k3/8/8/8/8/8/8/4K3 w - e4 0 1', 'ep square on the wrong rank'],
    ['4k3/8/8/8/8/8/8/4K3 w - e6 0 1', 'ep square with no pawn to capture'],
    ['4k3/8/8/8/8/8/8/4K3 w - - -1 1', 'negative halfmove clock'],
    ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNRK w KQkq - 0 1', 'two white kings'],
  ];
  for (const [fen, why] of bad) assert.throws(() => fromFen(fen), Error, why);
});

test('legalPosition rejects a position where the side not to move is in check', () => {
  assert.equal(legalPosition(fromFen(START_FEN)).ok, true);
  // Black king already attacked while it is White to move: unreachable by play.
  const bogus = fromFen('4k3/4R3/8/8/8/8/8/4K3 w - - 0 1');
  assert.equal(legalPosition(bogus).ok, false);
});

test('castling rights are lost by king, rook and captured rook', () => {
  const pos = fromFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  const play = (from, to) => {
    const move = generateMoves(pos).find((m) => squareName(moveFrom(m)) === from && squareName(moveTo(m)) === to);
    assert.ok(move, from + to + ' should be legal');
    return makeMove(pos, move);
  };
  play('h1', 'h2');
  assert.equal(pos.castling & 1, 0, 'white king-side right gone with the rook off h1');
  assert.equal(pos.castling & 2, 2, 'white queen-side right survives');
  play('a8', 'a1');
  assert.equal(pos.castling & 2, 0, 'white queen-side right dies when a1 is captured');
  assert.equal(pos.castling & 8, 0, 'black queen-side right dies when its own rook leaves');
  play('e1', 'e2');
  assert.equal(pos.castling & 3, 0, 'both white rights gone after the king moves');
});

test('castling is refused out of, through and into check', () => {
  const cases = [
    ['r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 2, 'both castles available'],
    ['r3k2r/8/8/8/8/8/4r3/R3K2R w KQkq - 0 1', 0, 'king in check'],
    ['r3k2r/8/8/8/8/8/5r2/R3K2R w KQkq - 0 1', 1, 'f1 attacked blocks only O-O'],
    ['r3k2r/8/8/8/8/8/6r1/R3K2R w KQkq - 0 1', 1, 'g1 attacked blocks only O-O'],
    ['r3k2r/8/8/8/8/8/1r6/R3K2R w KQkq - 0 1', 2, 'b1 attacked still allows O-O-O'],
    ['r3k2r/8/8/8/8/8/8/RN2K2R w KQkq - 0 1', 1, 'b1 occupied blocks O-O-O'],
  ];
  for (const [fen, expected, why] of cases) {
    const pos = fromFen(fen);
    const castles = generateMoves(pos).filter((m) => moveFlags(m) & 24).length;
    assert.equal(castles, expected, why + ' (' + fen + ')');
  }
});

test('an en-passant capture that exposes the king is illegal', () => {
  // Black king a4, black pawn d4, white pawn e4 (just double-pushed), white rook h4.
  const pos = fromFen('8/8/8/8/k2pP2R/8/8/4K3 b - e3 0 1');
  const eps = generateMoves(pos).filter((m) => moveFlags(m) & FLAG_EP);
  assert.equal(eps.length, 0, 'dxe3 would clear the rank and expose the king');
  // Move the rook off the rank and the same capture becomes legal.
  const free = fromFen('7R/8/8/8/k2pP3/8/8/4K3 b - e3 0 1');
  assert.equal(generateMoves(free).filter((m) => moveFlags(m) & FLAG_EP).length, 1);
});

test('promotion generates four pieces, including on a capture', () => {
  const pos = fromFen('4k2r/6P1/8/8/8/8/8/4K3 w - - 0 1');
  const moves = generateMoves(pos);
  const pushes = moves.filter((m) => squareName(moveTo(m)) === 'g8');
  const takes = moves.filter((m) => squareName(moveTo(m)) === 'h8');
  assert.equal(pushes.length, 4);
  assert.equal(takes.length, 4);
  assert.deepEqual([...new Set(takes.map(movePromo))].sort(), [2, 3, 4, 5]);
  assert.ok(takes.every((m) => moveFlags(m) & FLAG_CAPTURE));
});

test('gameStatus separates checkmate, stalemate and play', () => {
  const mate = fromFen('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3');
  assert.deepEqual(gameStatus(mate), { over: true, result: 'black', reason: 'checkmate' });
  const stale = fromFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  assert.equal(inCheck(stale), false);
  assert.deepEqual(gameStatus(stale), { over: true, result: 'draw', reason: 'stalemate' });
  assert.equal(gameStatus(fromFen(START_FEN)).reason, 'in-progress');
});

test('the fifty-move rule fires on the clock and resets on pawns and captures', () => {
  assert.equal(gameStatus(fromFen('8/8/4k3/8/8/4K3/R7/8 w - - 100 60')).reason, 'fifty-move');
  assert.equal(gameStatus(fromFen('8/8/4k3/8/8/4K3/R7/8 w - - 99 60')).reason, 'in-progress');
  const pos = fromFen('8/4p3/8/8/8/4K3/R7/7k b - - 99 60');
  makeMove(pos, generateMoves(pos).find((m) => squareName(moveFrom(m)) === 'e7'));
  assert.equal(pos.half, 0, 'a pawn move resets the clock');
  const taking = fromFen('8/8/8/8/8/4K3/R6r/7k b - - 99 60');
  makeMove(taking, generateMoves(taking).find((m) => moveFlags(m) & FLAG_CAPTURE));
  assert.equal(taking.half, 0, 'a capture resets the clock');
});

test('threefold counts the current position, not the move order', () => {
  const pos = fromFen(START_FEN);
  const counts = new Map([[positionKey(pos), 1]]);
  const play = (from, to) => {
    const m = generateMoves(pos).find((x) => squareName(moveFrom(x)) === from && squareName(moveTo(x)) === to);
    makeMove(pos, m);
    counts.set(positionKey(pos), (counts.get(positionKey(pos)) || 0) + 1);
  };
  for (let i = 0; i < 2; i++) {
    play('g1', 'f3'); play('g8', 'f6'); play('f3', 'g1'); play('f6', 'g8');
  }
  assert.equal(counts.get(positionKey(pos)), 3);
  assert.equal(gameStatus(pos, counts).reason, 'threefold');
  assert.equal(gameStatus(pos).reason, 'in-progress', 'without counts it cannot know');
});

test('positionKey separates positions that differ only in rights', () => {
  const a = fromFen('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1');
  const b = fromFen('4k3/8/8/8/8/8/8/R3K2R w K - 0 1');
  const c = fromFen('4k3/8/8/8/8/8/8/R3K2R b KQ - 0 1');
  const d = fromFen('4k3/8/8/8/8/8/8/R3K2R w KQ - 9 40');
  assert.notEqual(positionKey(a), positionKey(b), 'castling rights matter');
  assert.notEqual(positionKey(a), positionKey(c), 'side to move matters');
  assert.equal(positionKey(a), positionKey(d), 'clocks do not');
});

test('insufficient material matches the contract list exactly', () => {
  const draws = [
    '4k3/8/8/8/8/8/8/4K3 w - - 0 1',
    '4k3/8/8/8/8/8/8/4KB2 w - - 0 1',
    '4k3/8/8/8/8/8/8/4KN2 w - - 0 1',
    '2b1k3/8/8/8/8/8/8/4KB2 w - - 0 1',
  ];
  const notDraws = [
    '4k3/8/8/8/8/8/8/3NKN2 w - - 0 1',
    '3bk3/8/8/8/8/8/8/4KB2 w - - 0 1',
    '4k3/8/8/8/8/8/7P/4K3 w - - 0 1',
    '4k3/8/8/8/8/8/8/R3K3 w - - 0 1',
  ];
  for (const fen of draws) {
    assert.equal(gameStatus(fromFen(fen)).reason, 'insufficient-material', fen);
  }
  for (const fen of notDraws) {
    assert.equal(gameStatus(fromFen(fen)).reason, 'in-progress', fen);
  }
});

test('the capture-only set is exactly the captures and promotions', () => {
  const rand = prng(20260807);
  for (const fen of FENS) {
    const pos = fromFen(fen);
    for (let ply = 0; ply < 40; ply++) {
      const all = generateMoves(pos);
      if (!all.length) break;
      const loud = generateMoves(pos, true).slice().sort((x, y) => x - y);
      const expected = all
        .filter((m) => (moveFlags(m) & FLAG_CAPTURE) || movePromo(m))
        .sort((x, y) => x - y);
      assert.deepEqual(loud, expected, 'quiescence set mismatch at ' + toFen(pos));
      makeMove(pos, all[Math.floor(rand() * all.length)]);
    }
  }
});

test('make/unmake restores every field and the hash, over random playouts', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const rand = prng(seed * 7919);
    const pos = fromFen(FENS[seed % FENS.length]);
    for (let ply = 0; ply < 120; ply++) {
      const moves = generateMoves(pos);
      if (!moves.length) break;
      for (const m of moves) {
        const before = clonePosition(pos);
        const undo = makeMove(pos, m);
        // The incrementally maintained hash must equal a hash built from scratch.
        const fresh = rehash(clonePosition(pos));
        assert.equal(pos.hashLo, fresh.hashLo, 'hashLo drift after ' + squareName(moveFrom(m)) + squareName(moveTo(m)));
        assert.equal(pos.hashHi, fresh.hashHi, 'hashHi drift');
        assert.equal(inCheck(pos, pos.turn ^ 1), false, 'a legal move left the mover in check');
        unmakeMove(pos, m, undo);
        assert.deepEqual([...pos.board], [...before.board], 'board not restored');
        assert.deepEqual(
          [pos.turn, pos.castling, pos.ep, pos.half, pos.full, pos.kings[0], pos.kings[1], pos.hashLo, pos.hashHi],
          [before.turn, before.castling, before.ep, before.half, before.full, before.kings[0], before.kings[1], before.hashLo, before.hashHi],
          'state not restored',
        );
      }
      makeMove(pos, moves[Math.floor(rand() * moves.length)]);
    }
  }
});

test('generated squares are always on the board', () => {
  const rand = prng(4242);
  const pos = fromFen('N6N/8/8/8/8/8/8/N2Kk2N w - - 0 1');
  for (let ply = 0; ply < 60; ply++) {
    const moves = generateMoves(pos);
    if (!moves.length) break;
    for (const m of moves) {
      assert.equal(moveFrom(m) & 0x88, 0, 'from square off board');
      assert.equal(moveTo(m) & 0x88, 0, 'to square off board');
      assert.notEqual(parseSquare(squareName(moveTo(m))), -1);
    }
    makeMove(pos, moves[Math.floor(rand() * moves.length)]);
  }
});

test('a promotion to queen is encoded as QUEEN, not as a flag', () => {
  const pos = fromFen('8/P6k/8/8/8/8/8/7K w - - 0 1');
  const queening = generateMoves(pos).filter((m) => movePromo(m) === QUEEN);
  assert.equal(queening.length, 1);
  const undo = makeMove(pos, queening[0]);
  assert.equal(toFen(pos).split(' ')[0], 'Q7/7k/8/8/8/8/8/7K');
  unmakeMove(pos, queening[0], undo);
  assert.equal(toFen(pos), '8/P6k/8/8/8/8/8/7K w - - 0 1');
});
