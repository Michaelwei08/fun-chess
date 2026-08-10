// search.js -- alpha-beta with iterative deepening, on the main thread: the site
// sends worker-src 'none' on every route, so there is no thread to escape to.
// The budget is milliseconds, checked inside the tree.

import {
  PAWN, typeOf, generateMoves, makeMove, unmakeMove, inCheck,
  moveTo, movePromo, moveFlags, FLAG_CAPTURE, FLAG_EP, WHITE,
} from './rules.js';
import { scoreMoves, pickBest, rememberCutoff } from './order.js';
import { ZE_LO, ZE_HI, ZT } from './tables.js';
import { evaluate, PIECE_VALUE, hasPieces } from './eval.js';
import {
  MATE, INF, MATE_THRESHOLD, MAX_PLY, LEVELS, defaultNow, defaultYield,
  createEngine, toTT, fromTT, mateDistance, adoptPartial,
} from './engine.js';

export { MATE, LEVELS, createEngine, mateDistance } from './engine.js';

function* iterate(pos, options) {
  const level = LEVELS[options.level] || LEVELS.focused;
  const {
    budgetMs = level.budgetMs, maxDepth = level.maxDepth, randomCp = level.randomCp,
    multiPv = 3, rng = Math.random, now = defaultNow, engine = createEngine(),
  } = options;
  const started = now(), deadline = started + budgetMs;

  // positionKey strings unpacked to int32 halves, so the tree compares without
  // allocating.
  const histLo = [], histHi = [];
  for (const key of (options.history || [])) {
    const cut = key.indexOf('-');
    if (cut > 0) {
      histLo.push(parseInt(key.slice(0, cut), 36) | 0);
      histHi.push(parseInt(key.slice(cut + 1), 36) | 0);
    }
  }
  const pathLo = new Int32Array(MAX_PLY + 8), pathHi = new Int32Array(MAX_PLY + 8);
  pathLo[0] = pos.hashLo; pathHi[0] = pos.hashHi;
  const pvTable = [], pvLen = new Int32Array(MAX_PLY + 2);
  for (let i = 0; i < MAX_PLY + 2; i++) pvTable.push(new Int32Array(MAX_PLY + 2));
  let pathLen = 1, nodes = 0, seldepth = 0, aborted = false;

  const doMove = (m) => {
    const undo = makeMove(pos, m);
    pathLo[pathLen] = pos.hashLo; pathHi[pathLen] = pos.hashHi; pathLen++;
    return undo;
  };
  const undoMove = (m, undo) => { pathLen--; unmakeMove(pos, m, undo); };

  function repeated() {
    if (pos.half >= 100) return true;
    if (pos.half < 4) return false;
    const lo = pos.hashLo, hi = pos.hashHi;
    for (let i = pathLen - 2; i >= 0; i--) if (pathLo[i] === lo && pathHi[i] === hi) return true;
    for (let i = 0; i < histLo.length; i++) if (histLo[i] === lo && histHi[i] === hi) return true;
    return false;
  }

  function outOfTime() {
    if (aborted) return true;
    if ((++nodes & 1023) === 0 && now() >= deadline) aborted = true;
    return aborted;
  }

  function quiesce(alpha, beta, ply) {
    if (outOfTime()) return 0;
    if (ply > seldepth) seldepth = ply;
    pvLen[ply] = 0;
    let best = evaluate(pos);
    if (best >= beta || ply >= MAX_PLY - 1) return best;
    if (best > alpha) alpha = best;
    const moves = generateMoves(pos, true);
    const scores = scoreMoves(pos.board, engine, moves, 0, ply);
    for (let i = 0; i < moves.length; i++) {
      const m = pickBest(moves, scores, i);
      const flags = moveFlags(m);
      const victim = (flags & FLAG_EP) ? PAWN : typeOf(pos.board[moveTo(m)]);
      // Delta pruning: even winning this piece for free would not reach alpha.
      if (best + PIECE_VALUE[victim] + (movePromo(m) ? 800 : 0) + 200 < alpha) continue;
      const undo = doMove(m);
      const s = -quiesce(-beta, -alpha, ply + 1);
      undoMove(m, undo);
      if (aborted) return 0;
      if (s > best) best = s;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  function negamax(depth, alpha, beta, ply, allowNull) {
    if (outOfTime()) return 0;
    pvLen[ply] = 0;
    if (ply > 0 && repeated()) return 0;
    const checked = inCheck(pos);
    if (checked) depth++;
    if (depth <= 0) return quiesce(alpha, beta, ply);
    if (ply > 0) {
      // Mate-distance pruning: a faster mate elsewhere makes this subtree moot.
      if (alpha < -MATE + ply) alpha = -MATE + ply;
      if (beta > MATE - ply - 1) beta = MATE - ply - 1;
      if (alpha >= beta) return alpha;
    }
    const idx = pos.hashLo & engine.mask;
    // A stored score is reused only outside the principal variation. Cutting on
    // it inside the PV is sound for the score but truncates the line, and the
    // analysis view exists to show that line.
    const isPv = beta - alpha > 1;
    let hashMove = 0;
    if (engine.ttUsed[idx] && engine.ttLo[idx] === pos.hashLo && engine.ttHi[idx] === pos.hashHi) {
      hashMove = engine.ttMove[idx];
      if (ply > 0 && !isPv && engine.ttDepth[idx] >= depth) {
        const s = fromTT(engine.ttScore[idx], ply), flag = engine.ttFlag[idx];
        if (flag === 0) return s;
        if (flag === 1 && s >= beta) return s;
        if (flag === 2 && s <= alpha) return s;
      }
    }
    if (allowNull && !checked && depth >= 3 && ply > 0 && hasPieces(pos, pos.turn)) {
      const ep = pos.ep, lo = pos.hashLo, hi = pos.hashHi;
      if (ep >= 0) { pos.hashLo ^= ZE_LO[ep]; pos.hashHi ^= ZE_HI[ep]; pos.ep = -1; }
      pos.hashLo ^= ZT[0]; pos.hashHi ^= ZT[1]; pos.turn ^= 1;
      pathLo[pathLen] = pos.hashLo; pathHi[pathLen] = pos.hashHi; pathLen++;
      const s = -negamax(depth - 3, -beta, -beta + 1, ply + 1, false);
      pathLen--;
      pos.turn ^= 1; pos.ep = ep; pos.hashLo = lo; pos.hashHi = hi;
      if (aborted) return 0;
      // Fail SOFT. Returning beta here instead cost a day: a root move that
      // failed low then reported exactly alpha, so every also-ran tied with the
      // best move and the candidate list filled up with junk that looked equal.
      if (s >= beta) return s;
    }
    const moves = generateMoves(pos);
    if (!moves.length) return checked ? -MATE + ply : 0;
    const scores = scoreMoves(pos.board, engine, moves, hashMove, ply);
    let best = -INF, bestMove = 0, flag = 2;
    for (let i = 0; i < moves.length; i++) {
      const m = pickBest(moves, scores, i);
      const undo = doMove(m);
      let s;
      if (i === 0) s = -negamax(depth - 1, -beta, -alpha, ply + 1, true);
      else {
        s = -negamax(depth - 1, -alpha - 1, -alpha, ply + 1, true);
        if (!aborted && s > alpha && s < beta) s = -negamax(depth - 1, -beta, -alpha, ply + 1, true);
      }
      undoMove(m, undo);
      if (aborted) return 0;
      if (s > best) { best = s; bestMove = m; }
      if (s > alpha) {
        alpha = s; flag = 0;
        pvTable[ply][0] = m;
        for (let j = 0; j < pvLen[ply + 1]; j++) pvTable[ply][j + 1] = pvTable[ply + 1][j];
        pvLen[ply] = pvLen[ply + 1] + 1;
      }
      if (alpha >= beta) {
        flag = 1;
        if (!(moveFlags(m) & FLAG_CAPTURE) && !movePromo(m)) rememberCutoff(engine, m, ply, depth);
        break;
      }
    }
    if (!aborted) {
      engine.ttUsed[idx] = 1; engine.ttLo[idx] = pos.hashLo; engine.ttHi[idx] = pos.hashHi;
      engine.ttMove[idx] = bestMove; engine.ttScore[idx] = toTT(best, ply);
      engine.ttDepth[idx] = Math.min(depth, 127); engine.ttFlag[idx] = flag;
    }
    return best;
  }

  const rootMoves = generateMoves(pos);
  const base = { best: 0, scoreCp: 0, whiteCp: 0, mateIn: null, depth: 0, seldepth: 0,
    nodes: 0, timeMs: 0, pv: [], lines: [], levelLabel: level.label };
  if (!rootMoves.length) { yield { ...base, timeMs: now() - started }; return; }
  let order = rootMoves.slice(), last = null, iterationMs = 0, lastBreath = started;
  for (let depth = 1; depth <= maxDepth; depth++) {
    const iterationStart = now();
    const results = [];
    let alpha = -INF;
    // Weak levels score every root move with a full window, so their noise picks
    // between real evaluations instead of between fail-low bounds.
    const wide = randomCp > 0 ? order.length : multiPv;
    for (let i = 0; i < order.length; i++) {
      const m = order[i];
      const undo = doMove(m);
      let s, exact = true;
      if (i === 0 && last && depth >= 4) {
        // Aspiration on the first root move. Measured worthless at multiPv 3 and
        // worth a depth at multiPv 1, which is what the opponent plays at.
        for (let delta = 40; ; delta *= 4) {
          const lo = last.scoreCp - delta, hi = last.scoreCp + delta;
          s = -negamax(depth - 1, -hi, -lo, 1, true);
          if (aborted || (s > lo && s < hi)) break;
          if (delta > 640) { s = -negamax(depth - 1, -INF, INF, 1, true); break; }
        }
      } else if (i < wide) s = -negamax(depth - 1, -INF, INF, 1, true);
      else {
        s = -negamax(depth - 1, -alpha - 1, -alpha, 1, true);
        if (!aborted && s > alpha) s = -negamax(depth - 1, -INF, INF, 1, true);
        else exact = false;  // searched against a null window: an upper bound
      }
      const pv = [m];
      for (let j = 0; j < pvLen[1]; j++) pv.push(pvTable[1][j]);
      undoMove(m, undo);
      if (aborted) break;
      results.push({ move: m, scoreCp: s, pv, exact });
      if (s > alpha) alpha = s;
      // Come up for air inside a long iteration: without this the page freezes
      // for as long as a whole depth takes (760 ms at the Deep budget).
      if (last && now() - lastBreath > 70) { yield last; lastBreath = now(); }
    }
    if (aborted) {
      if (adoptPartial(last, results, depth, nodes, pos.turn, multiPv)) yield last;
      break;
    }
    if (!results.length) break;
    const rank = () => results.sort((a, b) => (b.scoreCp - a.scoreCp) || (Number(b.exact) - Number(a.exact)));
    rank();
    // Shown lines must be measurements, not bounds: a newcomer that climbs into
    // the displayed set gets re-searched with a full window. A repaired move is
    // exact forever, so this runs at most once per root move.
    for (let pass = 0; pass < results.length; pass++) {
      let repaired = false;
      for (let k = 0; k < Math.min(multiPv, results.length); k++) {
        if (results[k].exact) continue;
        const m = results[k].move;
        const undo = doMove(m);
        const s = -negamax(depth - 1, -INF, INF, 1, true);
        const pv = [m];
        for (let j = 0; j < pvLen[1]; j++) pv.push(pvTable[1][j]);
        undoMove(m, undo);
        if (aborted) break;
        results[k] = { move: m, scoreCp: s, pv, exact: true };
        repaired = true;
      }
      if (aborted || !repaired) break;
      rank();
    }
    if (aborted) break;
    order = results.map((r) => r.move);
    let chosen = results[0];
    if (randomCp > 0) {
      let bestNoisy = -Infinity;
      for (const r of results) {
        const noisy = r.scoreCp + (rng() * 2 - 1) * randomCp;
        if (noisy > bestNoisy) { bestNoisy = noisy; chosen = r; }
      }
    }
    last = {
      best: chosen.move, scoreCp: chosen.scoreCp, depth, seldepth, nodes,
      whiteCp: pos.turn === WHITE ? chosen.scoreCp : -chosen.scoreCp,
      mateIn: mateDistance(chosen.scoreCp), pv: chosen.pv,
      timeMs: Math.round(now() - started), levelLabel: level.label,
      lines: results.slice(0, multiPv),
    };
    iterationMs = now() - iterationStart;
    yield last;
    lastBreath = now();
    if (Math.abs(results[0].scoreCp) > MATE_THRESHOLD) break;
    // Do not start a depth that cannot finish. Measured depth-to-depth cost
    // ratios run 1.2x to 7.5x, so 3 is the middle of a spread, not a constant:
    // too low wastes the tail of the budget, too high gives up a depth that
    // would have finished, and adoptPartial limits the damage of guessing low.
    if (now() - started + iterationMs * 3 > budgetMs) break;
  }
  // Totals for the whole search, abandoned iteration included. `depth` stays the
  // last COMPLETED depth, but nodes and time must cover the same interval, or
  // the pair implies a nodes-per-second the engine never reached.
  if (last) { last.timeMs = Math.round(now() - started); last.nodes = nodes; last.seldepth = seldepth; }
  if (!last) {  // Not even depth 1 finished: return a legal move, not nothing.
    const m = order[0];
    yield { ...base, best: m, pv: [m], lines: [{ move: m, scoreCp: 0, pv: [m] }], nodes };
  }
}

export function search(pos, options = {}) {
  let result = null;
  for (const partial of iterate(pos, options)) result = partial;
  return result;
}

// Streaming form. shouldStop drops a search whose position is already stale.
// The clock handed to the search subtracts time spent suspended: otherwise the
// budget is wall clock, and where handing back the event loop is slow the engine
// spends the budget waiting -- measured at 302 ms of search in a 2079 ms wait.
export async function searchStream(pos, options = {}, onIteration) {
  const pause = options.yieldFn || defaultYield;
  const base = options.now || defaultNow;
  let paused = 0;
  let result = null;
  for (const partial of iterate(pos, { ...options, now: () => base() - paused })) {
    result = partial;
    if (onIteration) onIteration(partial);
    if (options.shouldStop && options.shouldStop()) break;
    const before = base();
    await pause();
    paused += base() - before;
  }
  return result;
}
