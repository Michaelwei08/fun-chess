// engine.js -- the search's fixed furniture: score constants, the difficulty
// levels, the transposition table and the two clocks. Split out of search.js
// only to keep every file under the 300-line site cap; search.js re-exports
// everything the rest of the project is meant to import.

import { WHITE } from './tables.js';

export const MATE = 30000;
export const INF = 40000;
export const MATE_THRESHOLD = MATE - 1000;
export const MAX_PLY = 96;

// A level is a thinking budget plus how much noise the engine will accept in
// its own choice. randomCp is what makes the weak levels weak: the search stays
// honest and the move selection is deliberately sloppy, rather than crippling
// the search and calling the result a beginner.
export const LEVELS = {
  casual: { label: 'Casual', budgetMs: 120, maxDepth: 2, randomCp: 60 },
  club: { label: 'Club', budgetMs: 260, maxDepth: 5, randomCp: 25 },
  focused: { label: 'Focused', budgetMs: 600, maxDepth: 12, randomCp: 0 },
  deep: { label: 'Deep', budgetMs: 1200, maxDepth: 20, randomCp: 0 },
};

export const defaultNow = (typeof performance !== 'undefined' && performance.now)
  ? () => performance.now()
  : () => Date.now();

// setTimeout(0) is not free: browsers clamp it, and inside the preview pane one
// round trip measured 222 ms. Eight of those turned a 300 ms search into a 2 s
// wait. A MessageChannel message is a real macrotask -- the browser can still
// paint between two of them -- but it is not clamped.
// Browser only: node has MessageChannel too, but an open port keeps the process
// alive, so `node --test` would sit there forever after the last assertion. In
// node a timer is cheap anyway.
//
// Whichever arrives first wins. The message is the fast path -- setTimeout(0)
// measured 222 ms per round trip inside the preview pane, and eight of those
// turned a 300 ms search into a 2 s wait. The timer is the safety net, because
// a hidden page can defer the message indefinitely, and a search that never
// resumes is worse than a slow one.
const inBrowser = typeof MessageChannel !== 'undefined' && typeof document !== 'undefined';
export const defaultYield = inBrowser
  ? () => (document.hidden ? Promise.resolve() : new Promise((resolve) => {
    // Nothing to paint in a hidden tab, and its timers are throttled to about
    // one a second, so handing the loop back there costs seconds and buys
    // nothing. Search straight through instead.
    const channel = new MessageChannel();
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.port1.close(); channel.port2.close();
      resolve();
    };
    channel.port1.onmessage = done;
    const timer = setTimeout(done, 50);
    channel.port2.postMessage(0);
  }))
  : () => new Promise((resolve) => setTimeout(resolve, 0));

// One flat table per field: typed arrays keep the whole thing in one allocation
// per engine and out of the garbage collector's way during a search.
export function createEngine(ttBits = 16) {
  const size = 1 << ttBits;
  return {
    mask: size - 1,
    ttLo: new Int32Array(size), ttHi: new Int32Array(size), ttMove: new Int32Array(size),
    ttScore: new Int32Array(size), ttDepth: new Int8Array(size), ttFlag: new Int8Array(size),
    ttUsed: new Uint8Array(size),
    killers: new Int32Array(MAX_PLY * 2),
    history: new Int32Array(128 * 128),
  };
}

// Mate scores are stored relative to the node that found them, so a mate found
// at ply 6 stays a mate in the same number of moves when it is read back at a
// different depth.
export const toTT = (s, ply) => (s > MATE_THRESHOLD ? s + ply : s < -MATE_THRESHOLD ? s - ply : s);
export const fromTT = (s, ply) => (s > MATE_THRESHOLD ? s - ply : s < -MATE_THRESHOLD ? s + ply : s);

// When the clock stops mid-iteration, the root moves that did finish are still
// worth having: the root is ordered best-first, so the ones searched are the
// ones most likely to be played, and they were searched a whole depth deeper
// than the result we would otherwise return. Adopted only if the best of them
// is no worse than what the completed depth said, and the candidate lines move
// with the choice -- otherwise the headline would name a move the list below it
// does not show. Returns true if `last` was updated in place.
export function adoptPartial(last, results, depth, nodes, turn, multiPv) {
  const done = results.filter((r) => r.exact).sort((a, b) => b.scoreCp - a.scoreCp);
  if (!last || !done.length || done[0].scoreCp < last.scoreCp) return false;
  Object.assign(last, {
    best: done[0].move, scoreCp: done[0].scoreCp, pv: done[0].pv, depth, nodes,
    whiteCp: turn === WHITE ? done[0].scoreCp : -done[0].scoreCp,
    mateIn: mateDistance(done[0].scoreCp), lines: done.slice(0, multiPv),
  });
  return true;
}

// Signed moves-to-mate for display: positive means the side to move is mating.
export function mateDistance(scoreCp) {
  if (Math.abs(scoreCp) <= MATE_THRESHOLD) return null;
  const plies = MATE - Math.abs(scoreCp);
  const moves = Math.ceil(plies / 2);
  return scoreCp > 0 ? moves : -moves;
}
