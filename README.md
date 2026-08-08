# Chess Lab (CHESS/64)

A chess board you can operate live, with an engine that lives entirely in the
page: rules, evaluation and search are plain ES modules, there is no build step,
no dependency, no network call and no account.

Two ways to use it, over one game record:

- **Play** -- pick a colour and a level and the engine answers your moves.
- **Record** -- the engine never touches a piece. Enter the moves of a game
  happening on a real board in front of you, for either side, and after each one
  the panel refreshes: evaluation, candidate lines, and a verdict on the move
  that was actually played.

Switching mode keeps the position, the move list, undo/redo and the repetition
counts. That is the point of the mode switch: start a game against the engine,
hand the board to a human when one sits down, and go back.

## Run it

```powershell
python -m http.server 4187 --bind 127.0.0.1 --directory web
```

Then open <http://127.0.0.1:4187/>. A server is needed because the page uses ES
modules, which browsers refuse to load over `file://`.

```powershell
node --test "tests/*.test.mjs"
```

58 tests, standard library only. `tests/perft.test.mjs` is the one that matters:
it checks move generation against the canonical perft node counts, including
4,865,609 positions at depth 5 from the start. A mismatch there is an engine bug,
never a test bug.

```powershell
node scripts/bench.mjs --games 10
```

Regenerates `docs/measurements.md`: search speed, how long the search blocks the
main thread, and whether the difficulty ladder is actually ordered.

## What is in the box

| file | what it owns |
|---|---|
| `web/lib/rules.js` | 0x88 board, legal moves, make/unmake, zobrist, game status |
| `web/lib/fen.js`, `tables.js` | FEN in and out; piece codes, offsets, zobrist keys |
| `web/lib/notation.js` | SAN and UCI out, and a deliberately tolerant parser in |
| `web/lib/eval.js` | tapered evaluation plus the per-term breakdown the panel shows |
| `web/lib/search.js`, `engine.js`, `order.js` | alpha-beta, iterative deepening, levels, move ordering |
| `web/lib/explain.js` | static exchange, move review, and the "why" bullets |
| `web/lib/app.js`, `panel.js`, `board-view.js` | controller, panel rendering, the 64 squares |

The rule set exists **once**. The search, the interface and the analysis all
call `rules.js`, and none of them re-implements a rule. The sibling META/81
project keeps three copies of one rule set and pays for it on every change; this
project ships the same files to the website rather than porting them.

## Three constraints that shaped it

The page is built to drop onto `cpwei.qzz.io/chess`, so the site's rules are the
project's rules:

- **No Web Worker.** Every route sends `worker-src 'none'`. The search runs on
  the main thread against a millisecond budget and hands the event loop back
  between root moves, which is also what lets the analysis panel fill in depth by
  depth. The longest single block measures 253 ms at the default Focused level
  and 547 ms at Deep; the sibling META/81 page holds itself to 420 ms, so Deep is
  deliberately not the default.
- **No network.** `connect-src 'none'`. Pieces are Unicode glyphs; there is
  nothing to fetch, and no opening book or tablebase to look up.
- **Under 300 lines per file.** Why the engine is eleven small modules rather
  than three big ones.

## Honesty rules

The levels are **budgets, not ratings**. Casual, Club, Focused and Deep set a
thinking time and how much noise the engine tolerates in its own choice; the
search stays honest at every level.

`docs/measurements.md` does carry Elo, and it is worth being precise about what
kind: it is the **difference between two settings of this engine**, converted
from the game scores of levels playing each other, with a confidence interval on
every step. It is not a rating. Nothing here has faced an opponent whose rating
is known, so there is no number comparable to a human's, and the UI shows none.

The opponent and the analysis panel search differently, and the reason is
measured: scoring three root moves with a full window each, so the candidate
list can show three real evaluations instead of three bounds, costs one to four
plies at the same budget. The panel pays it; a search that is only choosing a
move does not. The engine also stops early rather than begin a depth it can
predict will not finish, so it often answers well inside its budget.

Every bullet in the analysis panel carries the computation that produced it --
`search-score`, `see`, `attack-map`, `eval-term:king` and so on. A sentence with
no named computation behind it is not shown. Candidate lines searched against a
null window are printed as `<= x.xx`, because a bound is not a measurement.

## Putting it on the site

```powershell
python scripts/sync_site.py            # dry run
python scripts/sync_site.py --write    # write into personal_website
```

Engine modules are copied byte for byte into `assets/chess/`, which keeps their
relative imports valid so nothing is rewritten. Only `index.html` is transformed,
by an explicit list of substitutions that must each match exactly once. The
script prints the `_headers`, `sitemap.xml` and `/fun` card changes for a human
to apply; it never runs git and never deploys.

