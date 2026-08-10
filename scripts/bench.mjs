// bench.mjs -- measure the three things the page makes claims about: how fast
// the search is, how long it blocks the main thread between yields, and whether
// the difficulty ladder is actually ordered.
//
//   node scripts/bench.mjs [--games 10] [--plies 70] [--date YYYY-MM-DD] [--out docs/measurements.md]
//
// Ladder games are slow and embarrassingly parallel, so they can be split across
// processes and merged afterwards:
//
//   node scripts/bench.mjs --pairing deep:focused --games 8 --seed-offset 24 --json runs/a.json
//   node scripts/bench.mjs --merge runs        # speed + blocking here, games from the files
//
// Paired sampling, in the house style: every opening is played twice with the
// colours swapped, so a lucky opening cannot flatter one level. Seed offsets
// must not overlap between workers or the same games get counted twice.

import { writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
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
//
// Best of N, not a single shot. This runs on a shared desktop, and a contended
// measurement is not a slower measurement of the same thing: the budget is wall
// clock, so losing the CPU costs nodes and can cost a whole depth. One sweep
// recorded 52 knodes/s on a position that measures over 1000 when the machine is
// quiet. The least-contended run is the one that describes the engine.
const SPEED_REPEATS = Number(args.get('speed-repeats') || 3);

function speed() {
  const rows = [];
  for (const [name, fen] of POSITIONS) {
    for (const level of ['focused', 'deep']) {
      for (const multiPv of [1, 3]) {
        let best = null;
        for (let attempt = 0; attempt < SPEED_REPEATS; attempt++) {
          const result = search(fromFen(fen), { level, multiPv, engine: createEngine(18) });
          const knps = Math.round(result.nodes / Math.max(result.timeMs, 1));
          if (!best || knps > best.knps) {
            best = {
              position: name, level, mode: multiPv === 1 ? 'playing' : 'analysing',
              depth: result.depth, seldepth: result.seldepth,
              nodes: result.nodes, ms: result.timeMs, knps,
            };
          }
        }
        rows.push(best);
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

const PAIRINGS = [['club', 'casual'], ['focused', 'club'], ['deep', 'focused']];

function playPairing(strong, weak, games, seedOffset) {
  let wins = 0, losses = 0, draws = 0;
  for (let game = 0; game < games; game++) {
    const index = seedOffset + game;
    const seed = 1000 + index * 7919;
    // Paired: the same opening is played once with each colour assignment.
    const asWhite = index % 2 === 0;
    const result = asWhite ? playGame(strong, weak, seed) : playGame(weak, strong, seed);
    const strongWon = (asWhite && result === 'white') || (!asWhite && result === 'black');
    const weakWon = (asWhite && result === 'black') || (!asWhite && result === 'white');
    if (strongWon) wins++; else if (weakWon) losses++; else draws++;
    process.stderr.write('.');
  }
  return { strong, weak, games, wins, draws, losses };
}

// Elo from a game score. This is a DIFFERENCE between two settings of this one
// engine, not a rating: nothing here has played anything whose rating is known.
// A clean sweep has no finite Elo, so the score is clamped to the tightest value
// the sample size can distinguish and the result is reported as a lower bound.
function eloFrom(wins, draws, losses) {
  const n = wins + draws + losses;
  const score = (wins + draws / 2) / n;
  const clamp = (v) => Math.min(1 - 0.5 / n, Math.max(0.5 / n, v));
  const toElo = (s) => -400 * Math.log10(1 / clamp(s) - 1);
  const se = Math.sqrt(Math.max(score * (1 - score), 0.25 / n) / n);
  return {
    n, score, se, saturated: score >= 1 || score <= 0,
    elo: toElo(score), eloLo: toElo(score - 1.96 * se), eloHi: toElo(score + 1.96 * se),
  };
}

function ladder(results) {
  return results.map((r) => ({ ...r, ...eloFrom(r.wins, r.draws, r.losses) }));
}

// Written by scripts/lichess_bot.mjs. Absent until that run has happened, and
// the report says so rather than leaving a hole where a number should be.
function absoluteSection() {
  let r;
  try {
    r = JSON.parse(readFileSync(new URL('../docs/lichess_rating.json', import.meta.url), 'utf8'));
  } catch {
    return `No absolute rating has been measured yet. The ladder above is
relative. Run \`node scripts/lichess_bot.mjs --play --auto\` to anchor it.`;
  }
  const flag = r.provisional
    ? `carried by Lichess as **provisional**, a flag it clears below RD 110, so read
this as "about ${r.rating}" rather than as an exact figure`
    : 'no longer provisional';
  const caveat = r.converged === false
    ? `\n> **${r.closed ? 'Recorded with a wider deviation than a settled rating.'
      : 'This run did not converge.'}** ${r.note}\n`
    : '';
  return `Measured by playing rated games on ${r.site} as \`${r.username}\`, a declared
BOT account, at the **${r.level}** level (${r.budgetMs} ms per move -- the setting a
visitor to the page actually plays against).
${caveat}

| pool | rating | RD | games | record |
|---|---|---|---|---|
| ${r.pool} | **${r.rating}** | ${r.rd} | ${r.games} | ${r.wins}W ${r.losses}L ${r.draws}D |

The rating is ${flag}. Roughly, 95% of the estimate's mass lies within
+/-${Math.round(r.rd * 1.96)} points of it.

Three things this number is not. It is not a **human** rating: the opponents were
other bots, an engine-heavy pool. It is not a **chess.com** rating; the same
strength reads a few hundred points lower there, so it cannot be compared with
the labels on their bots. And it rates **one level** -- the other three would
each need their own account, since one account carries one rating.`;
}

const table = (head, rows, cells) =>
  ['| ' + head.join(' | ') + ' |', '|' + head.map(() => '---').join('|') + '|',
    ...rows.map((r) => '| ' + cells(r).join(' | ') + ' |')].join('\n');

// Worker mode: one pairing, straight to a JSON file, nothing else measured.
if (args.get('pairing')) {
  const [strong, weak] = args.get('pairing').split(':');
  const out = playPairing(strong, weak, GAMES, Number(args.get('seed-offset') || 0));
  const target = args.get('json');
  mkdirSync(new URL('.', new URL('../' + target, import.meta.url)), { recursive: true });
  writeFileSync(new URL('../' + target, import.meta.url), JSON.stringify(out));
  process.stderr.write('\n' + JSON.stringify(out) + '\n');
  process.exit(0);
}

function collect() {
  const dir = args.get('merge');
  if (!dir) return PAIRINGS.map(([strong, weak]) => playPairing(strong, weak, GAMES, 0));
  const base = new URL('../' + dir + '/', import.meta.url);
  const parts = readdirSync(base).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(new URL(f, base), 'utf8')));
  return PAIRINGS.map(([strong, weak]) => parts
    .filter((p) => p.strong === strong && p.weak === weak)
    .reduce((acc, p) => ({
      strong, weak, games: acc.games + p.games, wins: acc.wins + p.wins,
      draws: acc.draws + p.draws, losses: acc.losses + p.losses,
    }), { strong, weak, games: 0, wins: 0, draws: 0, losses: 0 }));
}

const speedRows = speed();
const blockRows = await blocking();
const ladderRows = ladder(collect());
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

Each row is the **best of ${SPEED_REPEATS}** runs, by nodes per second. The budget
is wall-clock, so losing the CPU to something else does not just slow a
measurement down, it buys fewer nodes and can cost a whole depth -- one sweep on
this shared desktop recorded 52 knodes/s on a position that measures over 1000
when the machine is quiet. Taking the least-contended run is what makes the
table describe the engine rather than the machine's mood. Even so, compare rows
within one run rather than across runs.

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

${ladderRows[0].n} games per pairing, ${PLY_CAP}-ply cap, openings paired so each
is played once with each colour assignment, unfinished games adjudicated at
+/-${ADJUDICATE_CP} cp. Both sides search at multiPv 1, the configuration the page
plays at. Score is from the stronger setting's point of view.

${table(['stronger', 'weaker', 'games', 'W', 'D', 'L', 'score', 'Elo diff (95% CI)'], ladderRows,
  (r) => [r.strong, r.weak, r.n, r.wins, r.draws, r.losses, r.score.toFixed(3),
    (r.saturated ? '>= +' + Math.round(r.eloLo) : '+' + Math.round(r.elo) +
      ' (' + Math.round(r.eloLo) + ' to ' + Math.round(r.eloHi) + ')')])}

## What the Elo numbers are, and are not

They are **differences between two settings of this engine**, computed from the
game scores above with the standard logistic conversion. Stacked from the
weakest level, and remembering that each step carries its own interval:

${(() => {
  let running = 0;
  const rows = [{ level: 'casual', rel: '0 (anchor)' }];
  for (const r of ladderRows) {
    running += r.elo;
    rows.push({ level: r.strong, rel: '+' + Math.round(running) + (r.saturated ? ' or more' : '') });
  }
  return table(['level', 'Elo relative to Casual'], rows, (r) => [r.level, r.rel]);
})()}

These differences say nothing about absolute strength on their own: read the
table as "Focused gives Club about this many points of handicap", not as "this
bot is rated N". Anchoring it needs games against opponents whose ratings are
known, which is the separate measurement in **Absolute rating** below. (The
site's \`connect-src 'none'\` constrains the shipped page, not a benchmark
harness that never ships.)

Two further caveats worth keeping in view: the levels play each other, and an
engine's score against a near-copy of itself with a different budget is a poor
predictor of its score against a differently-built opponent; and a clean sweep
has no finite Elo, so it is shown as a lower bound at the resolution the sample
size supports.

## Absolute rating

${absoluteSection()}
`;

writeFileSync(new URL('../' + OUT, import.meta.url), report);
console.log(report);
