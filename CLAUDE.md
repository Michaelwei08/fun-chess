# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## What this project is

CHESS/64 "Chess Lab": a browser chess board with an engine in the page, built to
the promise on `https://cpwei.qzz.io/fun` -- "a clean board, adjustable opponent,
and an analysis view for understanding why a move works" -- plus a Record mode
for following a game on a physical board.

Everything is plain ES modules under `web/lib/`. No dependencies, no build step,
no framework, no network, no worker. The same files run in the browser and under
`node --test`, which is why the engine modules must never touch `document`.

This directory has **no git repo** of its own, and neither does the workspace
root. `CONTINUITY.md` is the history. Read it before changing anything load-bearing.

## Commands

```powershell
node --test "tests/*.test.mjs"
```

The glob is required: `node --test tests` tries to load the directory as a module
and fails with MODULE_NOT_FOUND on Windows.

```powershell
python -m http.server 4187 --bind 127.0.0.1 --directory web
```

ES modules will not load over `file://`, so the page needs a server even locally.
There is a `chess-lab` entry in `../.claude/launch.json` for the same thing.

```powershell
node scripts/bench.mjs --games 10        # regenerates docs/measurements.md
python scripts/sync_site.py              # dry run of the site handoff
```

## The contract comes first

`docs/CONTRACT.md` is the authoritative interface: board representation, move
encoding, every module's exports, the DOM ids, and the test requirements. Two
modules disagreeing is the failure mode this project is shaped to avoid. Change
the contract in the same commit as the code, and say why.

## Load-bearing decisions

**The rule set exists once.** `rules.js` is the single source of truth; the
search, the UI and the analysis all call it. `fen.js` and `tables.js` are split
out of it purely for the line cap and are re-exported from `rules.js`, so import
from `rules.js`. Never re-implement a rule anywhere else -- the sibling
`../ultimate-tic-tac-toe-bot/` keeps three copies of one rule set and its own
CLAUDE.md records what that costs.

**Move generation is verified by perft, not by reading.** `tests/perft.test.mjs`
holds the canonical node counts for seven positions to depth 4-5. If a change
makes a number move, the change is wrong. Do not edit the expected values.

**0x88 board, packed int moves.** `sq = rank * 16 + file`, off-board iff
`sq & 0x88`. A move is `from | to << 8 | promo << 16 | flags << 20`; the captured
piece is not encoded, `makeMove` returns an undo record that holds it. Both hash
halves are maintained incrementally and a test asserts they never drift from a
from-scratch rehash.

**No Web Worker, ever.** `personal_website/_headers` sends `worker-src 'none'` on
every route including the script-enabled ones. The search is main-thread with a
millisecond budget checked every 1024 nodes, and `searchStream` yields between
iterations. `docs/measurements.md` records how long the worst single block is.

**Fail soft, not fail hard.** The null-move cutoff returns `s`, not `beta`. When
it returned `beta`, every root move that failed low reported exactly the best
score, so the candidate list filled with moves that looked tied for best and the
move ordering was poisoned. `tests/tactics.test.mjs` has a regression test named
for it. Any new cutoff must return a real score.

**Displayed lines are measurements.** Only the top `multiPv` root moves get a
full window; anything that climbs into the displayed set is re-searched before it
is shown, and a line that is still only bounded is printed with `<=`. The panel
must never present a bound as an evaluation.

**Analysis must cite itself.** Every `Fact` from `explain.js` carries a `basis`
naming the computation (`search-mate`, `search-score`, `see`, `material`,
`attack-map`, `move-flag`, `eval-term:<name>`). If you cannot name the
computation, do not emit the sentence. `tests/selfplay.test.mjs` checks every
bullet of every position in a whole game.

**Levels are budgets, not ratings.** `LEVELS` in `engine.js` sets a time budget
and `randomCp`, the noise the engine tolerates when picking among root moves. The
search itself is never weakened. Do not put an Elo number in the UI or the docs;
`docs/measurements.md` is the only place strength claims may live, with their
sample size.

**Play mode hides the engine's pick.** In Play mode the panel deliberately does
not show candidate lines for a position the human is about to move in -- that
would be an unrequested hint. It shows the review of the move just played. Record
mode and the "Analyse, do not move" button show everything.

## Site constraints that are really project constraints

The page ships to `cpwei.qzz.io/chess`, so `personal_website`'s invariants apply
here: **every source file under 300 lines** (this is why there are eleven small
modules and four stylesheets), **ASCII-only source**, no inline script, no `on*=`
handler, no remote resource. `tests/page.test.mjs` enforces all of it, plus the
wiring between `index.html` and the ids `app.js` looks up.

`web/base.css` is a verbatim copy of the site's `base.css`. Never edit it here;
re-copy it and let `sync_site.py` warn if it drifts.

## Where to be careful

- `sanToMove` is tolerant on purpose (it is the live over-the-board entry path)
  but must never resolve to a move the human did not mean. Case is significant:
  it is the only thing separating the bishop move `Bc6` from the pawn capture
  `bxc6`. Ambiguity returns `0`.
- `evaluate` is side-to-move relative, `evaluateWhite` is White relative, and
  `evalBreakdown().total` must equal `evaluateWhite()` exactly -- one function
  computes all three so the eval bar and the explanation cannot disagree.
- Repetition inside the search treats any match with the game history as a draw.
  The history passed in is only the keys since the last irreversible move,
  because it is scanned per node.
