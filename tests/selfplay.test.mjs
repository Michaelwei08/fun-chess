// selfplay.test.mjs -- the loop the page actually runs, without a browser:
// search, play, repeat. It is here to catch the failures that only appear over
// a whole game (an illegal move, a crash on a rare flag, a game that never ends).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  START_FEN, fromFen, generateMoves, makeMove, gameStatus, positionKey, toFen,
} from '../web/lib/rules.js';
import { moveToSan, sanToMove, pvToSan } from '../web/lib/notation.js';
import { search, createEngine } from '../web/lib/search.js';
import { explainResult, reviewMove, see } from '../web/lib/explain.js';

const BASES = [
  'search-mate', 'search-score', 'see', 'material', 'attack-map', 'move-flag', 'repetition',
];

function playGame(seed, maxPlies) {
  let clock = 0;
  const now = () => (clock += 1);
  const engine = createEngine(16);
  let rngState = seed >>> 0;
  const rng = () => {
    rngState ^= rngState << 13; rngState >>>= 0;
    rngState ^= rngState >>> 17; rngState ^= rngState << 5; rngState >>>= 0;
    return rngState / 4294967296;
  };
  const pos = fromFen(START_FEN);
  const counts = new Map([[positionKey(pos), 1]]);
  let repeatKeys = [positionKey(pos)];
  const sans = [];
  let previous = null;
  for (let ply = 0; ply < maxPlies; ply++) {
    const status = gameStatus(pos, counts);
    if (status.over) return { status, sans, plies: ply };
    const legal = generateMoves(pos);
    const result = search(pos, {
      maxDepth: 3, budgetMs: 1e9, randomCp: 40, multiPv: 3, engine, rng, now, history: repeatKeys,
    });
    assert.ok(result.best, 'no move returned in a position with ' + legal.length + ' legal moves');
    assert.ok(legal.includes(result.best), 'illegal move ' + result.best + ' in ' + toFen(pos));
    assert.equal(result.pv[0], result.best);
    // The analysis layer runs on every position too, so a crash there fails here.
    const explanation = explainResult(pos, result);
    assert.ok(explanation.headline.length > 0);
    for (const bullet of explanation.bullets) {
      assert.ok(BASES.some((b) => bullet.basis.startsWith(b) || bullet.basis.startsWith('eval-term:')),
        'unknown basis ' + bullet.basis);
      assert.ok(bullet.text.trim().length > 0);
    }
    if (previous) {
      const review = reviewMove(previous.pos, previous.move, previous.result, result);
      assert.ok(review && review.lostCp >= 0, 'review must never report a negative loss');
      assert.ok(['best', 'good', 'inaccuracy', 'mistake', 'blunder'].includes(review.label));
    }
    const before = fromFen(toFen(pos));
    sans.push(moveToSan(pos, result.best));
    assert.equal(sanToMove(pos, sans[sans.length - 1]), result.best, 'SAN round trip inside a real game');
    previous = { pos: before, move: result.best, result };
    makeMove(pos, result.best);
    const key = positionKey(pos);
    counts.set(key, (counts.get(key) || 0) + 1);
    if (pos.half === 0) repeatKeys = [];
    repeatKeys.push(key);
  }
  return { status: gameStatus(pos, counts), sans, plies: maxPlies };
}

test('a self-play game runs to a legal finish', () => {
  const game = playGame(20260807, 120);
  assert.ok(game.sans.length > 4, 'the game should get past the opening');
  assert.ok(['checkmate', 'stalemate', 'fifty-move', 'threefold', 'insufficient-material', 'in-progress']
    .includes(game.status.reason));
});

test('three seeded games produce different games and never crash', () => {
  const games = [1, 2, 3].map((seed) => playGame(seed * 7919, 60));
  const texts = games.map((g) => g.sans.join(' '));
  assert.equal(new Set(texts).size, 3, 'different seeds should not replay one game');
});

test('static exchange agrees with the obvious cases', () => {
  const pos = fromFen('4k3/8/8/3q4/4P3/8/8/4K3 w - - 0 1');
  const takeQueen = generateMoves(pos).find((m) => moveToSan(pos, m) === 'exd5');
  assert.equal(see(pos, takeQueen), 900, 'a free queen is worth a queen');
  const guarded = fromFen('4k3/3r4/8/3q4/4P3/8/8/4K3 w - - 0 1');
  const trade = generateMoves(guarded).find((m) => moveToSan(guarded, m) === 'exd5');
  assert.equal(see(guarded, trade), 800, 'queen for a pawn, with the rook taking the pawn back');
  const bad = fromFen('4k3/8/4p3/3n4/8/5B2/8/4K3 w - - 0 1');
  const losing = generateMoves(bad).find((m) => moveToSan(bad, m) === 'Bxd5');
  assert.ok(see(bad, losing) < 0, 'bishop takes a defended knight loses material');
});

test('a principal variation is always playable', () => {
  const pos = fromFen('r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4');
  let clock = 0;
  const result = search(pos, { maxDepth: 6, budgetMs: 1e9, randomCp: 0, now: () => (clock += 1) });
  const sans = pvToSan(pos, result.pv, 12);
  assert.equal(sans.length, result.pv.length, 'every PV move must be legal in turn');
  assert.equal(toFen(pos), 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
    'walking the PV must leave the position untouched');
});
