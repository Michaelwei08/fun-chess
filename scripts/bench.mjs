// bench.mjs -- measure the three things the page makes claims about: how fast
// the search is, how long it blocks the main thread between yields, and whether
// the difficulty ladder is actually ordered.
//
//   node scripts/bench.mjs [--games 10] [--plies 70] [--date YYYY-MM-DD] [--out docs/measurements.md]
//
// Paired sampling, in the house style: every opening is played twice with the
// colours swapped, so a lucky opening cannot flatter one level.

import { writeFileSync } from 'node:fs';
import {
  START_FEN, fromFen, generateMoves, makeMove, gameStatus, positionKey, toFen,
} from '../web/lib/rules.js';
import { search, searchStream, createEngine, LEVELS } from '../web/lib/search.js';
import { evaluateWhite } from '../web/lib/eval.js';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const GAMES = Number(args.get('games') || 10);
const PLY_CAP = Number(args.get('plies') || 70);
const DATE = args.get('date') || new Date().toISOString().slice(0, 10);
const OUT = args.get('out') || 'docs/measurements.md';
const ADJUDICATE_CP = 300;

const POSITIONS = [
  ['opening', START_FEN],
  ['middlegame', 'r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P1B2/2PBPN2/PP1N1PPP/R2Q1RK1 w - - 0 9'],
  ['tactical', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'],
  ['endgame', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1'],
];

function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

// Two configurations, because the page uses two: the opponent searches one line
// (multiPv 1) and the analysis panel searches three, which costs depth.
function speed() {
  const rows = [];
  for (const [name, fen] of POSITIONS) {
    for (const level of ['focused', 'deep']) {
      for (const multiPv of [1, 3]) {
        const result = search(fromFen(fen), { level, multiPv, engine: createEngine(18) });
        rows.push({
          position: name, level, mode: multiPv === 1 ? 'playing' : 'analysing',
          depth: result.depth, seldepth: result.seldepth,
          nodes: result.nodes, ms: result.timeMs,
          knps: Math.round(result.nodes / Math.max(result.timeMs, 1)),
        });
      }
    }
  }
  return rows;
}

// There is no Web Worker (worker-src 'none'), so the number that decides whether
// the page feels broken is the longest single stretch between two yields.
async function blocking() {
  const rows = [];
  for (const level of Object.keys(LEVELS)) {
    const chunks = [];
    for (const [, fen] of POSITIONS) {
      let mark = performance.now();
      const yieldFn = () => {
        chunks.push(performance.now() - mark);
        return new Promise((resolve) => setTimeout(() => { mark = performance.now(); resolve(); }, 0));
      };
      await searchStream(fromFen(fen), { level, engine: createEngine(18), yieldFn });
    }
    chunks.sort((a, b) => a - b);
    rows.push({
      level, iterations: chunks.length,
      median: Math.round(chunks[Math.floor(chunks.length / 2)]),
      p90: Math.round(chunks[Math.floor(chunks.length * 0.9)]),
      max: Math.round(chunks[chunks.length - 1]),
    });
  }
  return rows;
}

function playGame(whiteLevel, blackLevel, seed) {
  const pos = fromFen(START_FEN);
  const counts = new Map([[positionKey(pos), 1]]);
  let repeatKeys = [positionKey(pos)];
  const engines = { [whiteLevel]: createEngine(18), [blackLevel]: createEngine(18) };
  if (whiteLevel === blackLevel) engines[whiteLevel] = createEngine(18);
  const rng = makeRng(seed);
  const opening = makeRng(seed);
  for (let ply = 0; ply < PLY_CAP; ply++) {
    const status = gameStatus(pos, counts);
    if (status.over) return status.result;
    const legal = generateMoves(pos);
    let move;
    if (ply < 4) {
      move = legal[Math.floor(opening() * legal.length)];  // same opening for both colours
    } else {
      const level = pos.turn === 0 ? whiteLevel : blackLevel;
      // multiPv 1: the same configuration Play mode uses when the engine moves.
      move = search(pos, { level, multiPv: 1, engine: engines[level], rng, history: repeatKeys }).best;
    }
    if (!move) return gameStatus(pos, counts).result;
    makeMove(pos, move);
    const key = positionKey(pos);
    counts.set(key, (counts.get(key) || 0) + 1);
    if (pos.half === 0) repeatKeys = [];
    repeatKeys.push(key);
  }
  const cp = evaluateWhite(pos);
  if (cp > ADJUDICATE_CP) return 'white';
  if (cp < -ADJUDICATE_CP) return 'black';
  return 'draw';
}

function ladder() {
  const pairings = [['casual', 'club'], ['club', 'focused'], ['focused', 'deep']];
  const rows = [];
  for (const [weak, strong] of pairings) {
    let strongPoints = 0, wins = 0, losses = 0, draws = 0;
    for (let game = 0; game < GAMES; game++) {
      const seed = 1000 + game * 7919;
      // Paired: the same opening is played once with each colour assignment.
      const asWhite = game % 2 === 0;
      const result = asWhite ? playGame(strong, weak, seed) : playGame(weak, strong, seed);
      const strongWon = (asWhite && result === 'white') || (!asWhite && result === 'black');
      const weakWon = (asWhite && result === 'black') || (!asWhite && result === 'white');
      if (strongWon) { wins++; strongPoints += 1; } else if (weakWon) losses++; else { draws++; strongPoints += 0.5; }
      process.stderr.write('.');
    }
    const score = strongPoints / GAMES;
    // Normal approximation on the game score; with samples this small it is a
    // direction, not a rating.
    const se = Math.sqrt(Math.max(score * (1 - score), 0.01) / GAMES);
    rows.push({ strong, weak, games: GAMES, wins, draws, losses, score, se });
  }
  return rows;
}

const table = (head, rows, cells) =>
  ['| ' + head.join(' | ') + ' |', '|' + head.map(() => '---').join('|') + '|',
    ...rows.map((r) => '| ' + cells(r).join(' | ') + ' |')].join('\n');

const speedRows = speed();
const blockRows = await blocking();
const ladderRows = ladder();
process.stderr.write('\n');

const report = `# measurements.md -- CHESS/64

Generated by \`node scripts/bench.mjs\` on ${DATE}. Every number here was
measured on one machine, single core, node ${process.version}. Nothing in this
file is a rating: the ladder below says only which setting beats which, over the
sample size shown.

## Search speed at the shipped budgets

${table(['position', 'level', 'mode', 'depth', 'seldepth', 'nodes', 'ms', 'knodes/s'], speedRows,
  (r) => [r.position, r.level, r.mode, r.depth, r.seldepth, r.nodes.toLocaleString('en-US'), r.ms, r.knps])}

A level whose \`ms\` reaches its whole budget without gaining depth over the level
below spent the tail of it on an iteration that could not finish. The search stops
early when it can predict that, but the depth-to-depth cost ratio is not stable
enough to predict every time; what does not finish is discarded, except for the
root moves that completed, which are adopted if they are no worse.

## Main-thread blocking between yields

The site sends \`worker-src 'none'\`, so the search runs on the main thread and
gives the event loop a turn between root moves, at most every ~70 ms. These are
the gaps between those turns: the longest one is how long the page can be
unresponsive. The sibling META/81 page treats 420 ms as its ceiling. A single
root move's subtree cannot be interrupted, which is why the Deep row can exceed
it and why Focused, not Deep, is the default in the level select.

${table(['level', 'iterations', 'median ms', 'p90 ms', 'max ms'], blockRows,
  (r) => [r.level, r.iterations, r.median, r.p90, r.max])}

## Is the difficulty ladder ordered?

${GAMES} games per pairing, ${PLY_CAP}-ply cap, openings paired so each is played
once with each colour assignment, unfinished games adjudicated at +/-${ADJUDICATE_CP} cp.
Score is from the stronger setting's point of view.

${table(['stronger', 'weaker', 'games', 'W', 'D', 'L', 'score', 'SE'], ladderRows,
  (r) => [r.strong, r.weak, r.games, r.wins, r.draws, r.losses, r.score.toFixed(3), '+/-' + r.se.toFixed(3)])}

At this sample size the standard error is about ${(ladderRows[0].se * 100).toFixed(0)} points,
so only a large gap means anything. Treat a score under about 0.65 as "not shown
to be different" rather than as evidence the levels are equal.
`;

writeFileSync(new URL('../' + OUT, import.meta.url), report);
console.log(report);
