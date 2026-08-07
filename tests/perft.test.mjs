// perft.test.mjs -- move generation is verified by node counts, not by eyeball.
// The expected numbers are the canonical perft table. A mismatch is a bug in the
// engine, never in this file: do not "fix" a number to make the suite green.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fromFen, generateMoves, makeMove, unmakeMove, squareName, movePromo } from '../web/lib/rules.js';

export function perft(pos, depth) {
  if (depth === 0) return 1;
  const moves = generateMoves(pos);
  if (depth === 1) return moves.length;
  let nodes = 0;
  for (const m of moves) {
    const undo = makeMove(pos, m);
    nodes += perft(pos, depth - 1);
    unmakeMove(pos, m, undo);
  }
  return nodes;
}

// Per-root-move breakdown; the fastest way to localise a movegen bug.
export function divide(pos, depth) {
  const out = new Map();
  for (const m of generateMoves(pos)) {
    const undo = makeMove(pos, m);
    const label = squareName(m & 0xff) + squareName((m >> 8) & 0xff) +
      (movePromo(m) ? 'nbrq'[movePromo(m) - 2] : '');
    out.set(label, perft(pos, depth - 1));
    unmakeMove(pos, m, undo);
  }
  return out;
}

export const POSITIONS = [
  { name: 'P1 startpos', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    counts: [20, 400, 8902, 197281, 4865609] },
  { name: 'P2 kiwipete', fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    counts: [48, 2039, 97862, 4085603] },
  { name: 'P3 endgame', fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
    counts: [14, 191, 2812, 43238, 674624] },
  { name: 'P4 promotions', fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
    counts: [6, 264, 9467, 422333] },
  { name: 'P4 mirrored', fen: 'r2q1rk1/pP1p2pp/Q4n2/bbp1p3/Np6/1B3NBn/pPPP1PPP/R3K2R b KQ - 0 1',
    counts: [6, 264, 9467, 422333] },
  { name: 'P5 talkchess', fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
    counts: [44, 1486, 62379, 2103487] },
  { name: 'P6 steven', fen: 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10',
    counts: [46, 2079, 89890, 3894594] },
];

for (const entry of POSITIONS) {
  test('perft ' + entry.name, () => {
    const pos = fromFen(entry.fen);
    entry.counts.forEach((expected, i) => {
      const started = Date.now();
      const got = perft(pos, i + 1);
      const ms = Date.now() - started;
      assert.equal(got, expected,
        entry.name + ' depth ' + (i + 1) + ': expected ' + expected + ', got ' + got);
      if (ms > 200) {
        console.log('  ' + entry.name + ' d' + (i + 1) + ': ' + expected + ' nodes in ' + ms +
          'ms (' + Math.round(expected / Math.max(ms, 1)) + 'k nps)');
      }
    });
  });
}

// perft(d) must equal the sum of perft(d-1) over the root moves. When this fails
// the divide output names the exact root move whose subtree is wrong.
test('divide sums to perft', () => {
  for (const entry of POSITIONS) {
    const pos = fromFen(entry.fen);
    const depth = Math.min(3, entry.counts.length);
    let sum = 0;
    for (const n of divide(pos, depth).values()) sum += n;
    assert.equal(sum, entry.counts[depth - 1], entry.name + ' divide at depth ' + depth);
  }
});
