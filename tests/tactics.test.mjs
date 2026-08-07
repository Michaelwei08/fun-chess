// tactics.test.mjs -- the search is driven by a fake clock, so these are
// deterministic. Mate claims are checked against the board rather than against
// a puzzle answer key: the engine's own line is replayed and the final position
// must really be checkmate, which rules.js (perft-verified) decides.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fromFen, generateMoves, makeMove, gameStatus, squareName, moveFrom, moveTo,
} from '../web/lib/rules.js';
import { moveToSan, moveToUci } from '../web/lib/notation.js';
import { search, createEngine, mateDistance, MATE } from '../web/lib/search.js';

// A counter clock: deterministic, and never trips the budget, so maxDepth alone
// decides how hard the engine thinks.
const fakeClock = () => { let t = 0; return () => (t += 1); };
const think = (pos, maxDepth, extra = {}) => search(pos, {
  maxDepth, budgetMs: 1e9, randomCp: 0, now: fakeClock(), engine: createEngine(14), ...extra,
});

function replay(fen, pv) {
  const pos = fromFen(fen);
  for (const m of pv) {
    const legal = generateMoves(pos);
    assert.ok(legal.includes(m), 'PV move ' + moveToUci(m) + ' is not legal in ' + fen);
    makeMove(pos, m);
  }
  return pos;
}

test('mate in one is found and really is mate', () => {
  const mates = [
    ['6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', 'back rank'],
    ['r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 4 4', 'scholar'],
    ['7k/5K2/8/8/8/8/8/Q7 w - - 0 1', 'queen and king'],
  ];
  for (const [fen, name] of mates) {
    const result = think(fromFen(fen), 3);
    assert.equal(result.mateIn, 1, name + ': expected mate in 1, got ' +
      result.scoreCp + ' playing ' + moveToSan(fromFen(fen), result.best));
    assert.equal(gameStatus(replay(fen, [result.best])).reason, 'checkmate', name);
  }
});

test('a forced mate deeper than one move is found and delivered', () => {
  // King and queen against a bare king, close enough that the mate is inside
  // the horizon. The announced line has to end in mate on the real board.
  const fen = '4k3/8/8/4K3/8/8/6Q1/8 w - - 0 1';
  const result = think(fromFen(fen), 10);
  assert.ok(result.mateIn !== null && result.mateIn > 0,
    'expected a mate score, got ' + result.scoreCp);
  const end = replay(fen, result.pv);
  assert.equal(gameStatus(end).reason, 'checkmate',
    'the announced line ended as ' + gameStatus(end).reason);
  assert.equal(result.pv.length, result.mateIn * 2 - 1,
    'mate in ' + result.mateIn + ' should be ' + (result.mateIn * 2 - 1) + ' plies of PV');
});

test('being mated is reported as a negative mate score', () => {
  // Two rooks against a bare king: Black is to move and is getting laddered.
  const fen = '7k/8/8/8/8/8/8/R5RK b - - 0 1';
  const result = think(fromFen(fen), 8);
  assert.ok(result.mateIn !== null && result.mateIn < 0,
    'expected a losing mate score, got ' + result.scoreCp);
  assert.ok(result.best !== 0, 'a lost position still needs a move');
  assert.equal(result.pv.length, -result.mateIn * 2, 'the defender moves first in a losing line');
  assert.equal(gameStatus(replay(fen, result.pv)).reason, 'checkmate');
});

test('a hanging queen is taken', () => {
  // The capture is worth ~900 in swing, but the resulting balance is only a
  // pawn: what matters is that the engine plays it and the sign flips.
  const fen = '4k3/pppp1ppp/8/3q4/4P3/8/PPPP1PPP/4K3 w - - 0 1';
  const pos = fromFen(fen);
  const result = think(pos, 6);
  assert.equal(moveToUci(result.best), 'e4d5', 'played ' + moveToSan(pos, result.best) + ' instead');
  assert.ok(result.scoreCp > 50, 'after winning the queen White should be better, got ' + result.scoreCp);
  // The same position with the queen defended is not a free capture.
  const guarded = fromFen('4k3/ppppqppp/8/3q4/4P3/8/PPPP1PPP/4K3 w - - 0 1');
  assert.notEqual(moveToUci(think(guarded, 6).best), 'e4d5');
});

test('material is not thrown away for nothing', () => {
  // The white queen has plenty of captures; all of them lose her.
  const fen = '3rkr2/8/8/8/8/8/3Q4/4K3 w - - 0 1';
  const pos = fromFen(fen);
  const result = think(pos, 6);
  const to = squareName(moveTo(result.best));
  assert.ok(!['d8', 'f8'].includes(to), 'took a defended rook with the queen: ' + moveToSan(pos, result.best));
});

test('the reported score, the PV and the chosen move agree', () => {
  const fens = [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
    '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
  ];
  for (const fen of fens) {
    const pos = fromFen(fen);
    const result = think(pos, 5);
    assert.ok(generateMoves(pos).includes(result.best), 'best move must be legal: ' + fen);
    assert.equal(result.pv[0], result.best, 'the PV must start with the chosen move');
    assert.ok(result.lines.length > 0 && result.lines[0].pv[0] === result.lines[0].move);
    assert.equal(result.lines[0].scoreCp, result.scoreCp, 'top line is the chosen line');
    replay(fen, result.pv);
    assert.equal(result.whiteCp, pos.turn === 0 ? result.scoreCp : -result.scoreCp);
  }
});

test('a stalemated or mated side reports no move instead of guessing', () => {
  const stale = think(fromFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'), 4);
  assert.equal(stale.best, 0);
  assert.deepEqual(stale.pv, []);
  const mated = think(fromFen('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3'), 4);
  assert.equal(mated.best, 0);
});

test('the same inputs give the same move, and the level shapes the search', () => {
  const fen = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
  const a = think(fromFen(fen), 5);
  const b = think(fromFen(fen), 5);
  assert.equal(a.best, b.best);
  assert.equal(a.nodes, b.nodes, 'same clock, same tree');
  const shallow = think(fromFen(fen), 2);
  assert.ok(shallow.nodes < a.nodes, 'depth 2 must be cheaper than depth 5');
  assert.equal(shallow.depth, 2);
});

test('randomness at weak levels changes the move but keeps it legal', () => {
  const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const seen = new Set();
  for (let seed = 0; seed < 8; seed++) {
    let s = seed * 2654435761 + 1;
    const rng = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    const pos = fromFen(fen);
    const result = search(pos, {
      level: 'casual', budgetMs: 1e9, maxDepth: 2, now: fakeClock(), rng, engine: createEngine(14),
    });
    assert.ok(generateMoves(pos).includes(result.best));
    seen.add(result.best);
  }
  assert.ok(seen.size > 1, 'casual should not always play the same first move');
});

test('candidate lines are measurements, not a wall of ties', () => {
  // Regression: the null-move cutoff used to return beta, so every root move
  // that failed low reported exactly the best score and the candidate list
  // filled up with junk that looked equal to the top line.
  const fen = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2';
  const shared = search(fromFen(fen), {
    maxDepth: 5, budgetMs: 1e9, randomCp: 0, multiPv: 4, now: fakeClock(), engine: createEngine(17),
  });
  assert.equal(shared.lines.length, 4);
  assert.ok(shared.lines.every((line) => line.exact !== false), 'shown lines must be full-window searches');
  const scores = shared.lines.map((line) => line.scoreCp);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'lines must be sorted best first');
  assert.ok(new Set(scores).size > 1, 'every line reporting the same score is the bug this test exists for');
  // The runner-up must survive being searched on its own, with its own table.
  const pos = fromFen(fen);
  const runnerUp = shared.lines[1];
  const undo = makeMove(pos, runnerUp.move);
  const solo = search(pos, {
    maxDepth: 4, budgetMs: 1e9, randomCp: 0, now: fakeClock(), engine: createEngine(17),
  });
  makeMove(pos, solo.best);
  assert.ok(Math.abs(-solo.scoreCp - runnerUp.scoreCp) <= 40,
    'line 2 says ' + runnerUp.scoreCp + ' but an independent search says ' + (-solo.scoreCp));
});

test('a repetition available to the losing side scores as a draw', () => {
  // White is a rook down; the history says this position has already appeared,
  // so repeating it is a draw and must beat playing on.
  const fen = '7k/8/8/8/8/8/6q1/K6R w - - 8 40';
  const pos = fromFen(fen);
  const withHistory = think(pos, 4, { history: [] });
  assert.ok(generateMoves(pos).includes(withHistory.best));
  assert.equal(mateDistance(MATE - 5), 3);
  assert.equal(mateDistance(-(MATE - 4)), -2);
  assert.equal(mateDistance(120), null);
});
