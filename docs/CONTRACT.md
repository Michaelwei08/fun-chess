# CONTRACT.md -- CHESS/64 Chess Lab

Authoritative interface contract. Every module and test in this project is
written against this file. If an implementation needs to deviate, change this
file in the same commit and say why -- do not let two modules disagree.

Written 2026-08-07. Target: the `CHESS/64 Chess Lab` card on
`https://cpwei.qzz.io/fun` ("a clean board, adjustable opponent, and an analysis
view for understanding why a move works"), plus live over-the-board entry.

## Hard constraints

1. **No dependencies, no build step.** Browser-native ES modules, run directly
   by the browser and by `node --test`. No npm install, no bundler, no
   TypeScript, no WASM.
2. **No Web Worker.** `personal_website/_headers` sends `worker-src 'none'` on
   every route, including the script-enabled game routes. The search runs on the
   main thread with a millisecond budget and yields to the event loop between
   root moves, at most every ~70 ms. A single root move's subtree cannot be
   interrupted, so that is the floor on how long the page can be unresponsive.
3. **No network.** The site's CSP is `connect-src 'none'`; nothing may `fetch`,
   open a socket, or load a remote font/image. Piece glyphs are Unicode.
4. **Every source file stays under 300 lines** (`personal_website` invariant
   2026-06-15). Split rather than exceed.
5. **ASCII-only source, English UI copy and docs.** Dates are `YYYY-MM-DD`.
6. **The engine never reads UI state and the UI never reimplements a rule.**
   One rule set, one file: `web/lib/rules.js`. This project exists partly
   because the sibling META/81 project keeps three copies of one rule set and
   pays for it on every change.
7. **Honest output only.** An analysis bullet may be shown only if a named
   computation produced it (see `explain.js`). No invented commentary, no Elo
   claims that were not measured by `scripts/bench.mjs`.

## File layout

```
web/index.html          standalone playable page (also the source of the site page)
web/base.css            verbatim copy of personal_website/base.css -- do not edit here
web/chess.css           page shell, hero, controls
web/chess-stage.css     game record, status line, eval bar, captured pieces
web/chess-panel.css     analysis panel, move/FEN inputs, notes cards
web/chess-board.css     board, squares, pieces, coordinates, promotion dialog
web/lib/rules.js        move generation, make/unmake, zobrist, game status (+ re-exports)
web/lib/fen.js          FEN in and out, square names, position cloning
web/lib/tables.js       piece codes, 0x88 offsets, zobrist keys, from-scratch rehash
web/lib/notation.js     SAN/UCI generation, tolerant parsing, piece glyphs
web/lib/eval.js         tapered evaluation + per-term breakdown
web/lib/engine.js       score constants, difficulty levels, transposition table, clocks
web/lib/order.js        move ordering: MVV-LVA, killers, history
web/lib/search.js       alpha-beta search, iterative deepening, streaming iterations
web/lib/explain.js      static exchange, move review, "why" bullets with a basis
web/lib/board-view.js   the 64 squares and the promotion dialog
web/lib/panel.js        status, eval bar, record, captured pieces, analysis rendering
web/lib/app.js          controller: modes, controls, game record, wiring
tests/*.test.mjs        node --test suites
scripts/bench.mjs       speed, blocking and ladder measurements -> docs/measurements.md
scripts/sync_site.py    emit personal_website-ready copies (dry run by default)
```

`fen.js`, `tables.js`, `engine.js` and `order.js` exist because of the 300-line
cap, not because of a boundary worth defending. `rules.js` re-exports everything
from `fen.js` and `tables.js`, and `search.js` re-exports `LEVELS`,
`createEngine`, `MATE` and `mateDistance`, so callers import from `rules.js` and
`search.js` as if the split had not happened.

## Board representation (rules.js)

0x88 board. `sq = rank * 16 + file`, `rank 0` = rank 1 (White's home),
`file 0` = file a. Off-board iff `(sq & 0x88) !== 0`.

Piece encoding: `piece = type | (color << 3)`, so White = 1..6 and Black = 9..14.

```js
export const EMPTY = 0;
export const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
export const WHITE = 0, BLACK = 1;
export const typeOf = (p) => p & 7;
export const colorOf = (p) => p >> 3;
```

`Position` is a plain object with exactly these mutable fields:

| field | type | meaning |
|---|---|---|
| `board` | `Int8Array(128)` | piece codes, `0` empty, off-board squares always `0` |
| `turn` | `0 \| 1` | side to move |
| `castling` | int | bit 1 = White O-O, 2 = White O-O-O, 4 = Black O-O, 8 = Black O-O-O |
| `ep` | int | en-passant target square, or `-1` |
| `half` | int | halfmove clock (for the fifty-move rule) |
| `full` | int | fullmove number, starts at 1 |
| `kings` | `[number, number]` | king square by color |
| `hashLo`, `hashHi` | int32 | Zobrist halves, kept incrementally by make/unmake |

The Zobrist hash covers piece placement, side to move, castling rights and the
en-passant square (whenever `ep !== -1`). It does **not** cover clocks.
Invariant asserted by tests: `hash(fromFen(toFen(pos)))` equals `hash(pos)`, and
`makeMove` then `unmakeMove` restores every field bit-for-bit.

## Move encoding (rules.js)

A move is one non-negative int:

```
bits  0-7   from square (0x88)
bits  8-15  to square (0x88)
bits 16-19  promotion piece type (0 = none, else KNIGHT..QUEEN)
bits 20-24  flags
```

```js
export const FLAG_CAPTURE = 1, FLAG_DOUBLE = 2, FLAG_EP = 4,
             FLAG_CASTLE_K = 8, FLAG_CASTLE_Q = 16;
export const moveFrom  = (m) => m & 0xff;
export const moveTo    = (m) => (m >> 8) & 0xff;
export const movePromo = (m) => (m >> 16) & 0xf;
export const moveFlags = (m) => (m >> 20) & 0x1f;
export function encodeMove(from, to, promo, flags) {}
```

The captured piece is **not** encoded; `makeMove` records it in the undo record.
`0` is never a valid move and is used as "no move".

## rules.js exports

```js
export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
export function fromFen(fen)                  // -> Position; throws Error(reason) on invalid FEN
export function toFen(pos)                    // -> string
export function clonePosition(pos)            // -> deep copy
export function generateMoves(pos, capturesOnly = false)  // -> number[] of LEGAL moves
export function makeMove(pos, move)           // mutates pos, -> undo record
export function unmakeMove(pos, move, undo)   // mutates pos back
export function isSquareAttacked(pos, sq, bySide)   // -> boolean
export function inCheck(pos, side = pos.turn)       // -> boolean
export function positionKey(pos)              // -> string, stable repetition key
export function squareName(sq)                // 0x88 square -> 'e4'
export function parseSquare(name)             // 'e4' -> 0x88 square, -1 if invalid
export function gameStatus(pos, keyCounts = null)
export function legalPosition(pos)            // -> { ok, reason }
```

`fromFen` rejects structural nonsense (rank sums, piece counts, a pawn on a back
rank, an en-passant square that no double push could have produced) but cannot
test for check without the attack tables, so `legalPosition` is separate: it
returns `ok: false` when the side **not** to move is in check, which is the one
illegal position a pasted FEN reaches most often. The UI calls it on load.

`generateMoves(pos, true)` returns captures, en-passant captures and promotions
only (the quiescence set). Both forms return **legal** moves: pseudo-legal
generation followed by make/unmake king-safety filtering. Castling generation
must reject castling out of, through, or into check, and require an unobstructed
path plus the right on that side.

`gameStatus(pos, keyCounts)` -> `{ over, result, reason }` where `result` is
`'white' | 'black' | 'draw' | null` (winner by color, `null` while in progress)
and `reason` is one of `'checkmate' | 'stalemate' | 'fifty-move' |
'threefold' | 'insufficient-material' | 'in-progress'`. `keyCounts` is an
optional `Map<string, number>` of `positionKey` counts including the current
position; threefold is reported when the current key's count is >= 3.
Insufficient material covers K vs K, K+minor vs K, and K+B vs K+B on the same
square color.

## notation.js exports

```js
export function moveToSan(pos, move)   // pos = position BEFORE the move
export function sanToMove(pos, text)   // -> move or 0
export function moveToUci(move)        // 'e2e4', 'e7e8q'
export function uciToMove(pos, text)   // -> move or 0
export function moveListToPgn(sanList, startTurn = 0, startFull = 1)  // '1. e4 e5 2. Nf3'
export function pvToSan(pos, moves, limit = 8)  // walks and unwinds; pos is unchanged
export function glyphFor(piece)        // solid Unicode glyph, '' for an empty square
export function pieceName(piece)       // 'white knight', for aria-labels
```

`moveToSan` implements standard disambiguation (file, else rank, else both),
`O-O` / `O-O-O`, `=Q`, `+` and `#`. `sanToMove` is deliberately tolerant because
it is the live over-the-board entry path: it accepts SAN with or without
`x`/`+`/`#`, `0-0` and `O-O`, `e8=Q` and `e8Q`, plain coordinates `e2e4`,
`e2-e4`, and is case-insensitive except that a leading `b` is read as the b-file
pawn when a bishop move would be ambiguous with a pawn move. It returns `0` for
anything it cannot resolve to exactly one legal move.

## eval.js exports

Centipawn scores. `evaluate` is **side-to-move relative** (negamax);
`evaluateWhite` is White-relative and is what the eval bar shows.

```js
export function evaluate(pos)        // -> cp, positive = pos.turn is better
export function evaluateWhite(pos)   // -> cp, positive = White is better
export function evalBreakdown(pos)   // -> { material, position, pawns, king, mobility, pieces, phase, total }
export const PIECE_VALUE            // [_, 100, 320, 330, 500, 900, 0]
```

`evalBreakdown` is White-relative in every field, `phase` is `0..1` (1 =
opening), and `total === evaluateWhite(pos)` exactly. Terms: material,
tapered piece-square tables, pawn structure (doubled, isolated, passed),
king safety (pawn shield and open files near the king), mobility, and piece
bonuses (bishop pair, rook on open/half-open file, knight outpost).

## search.js exports

```js
export const LEVELS = {
  casual:  { label: 'Casual',  budgetMs: 120,  maxDepth: 2,  randomCp: 60 },
  club:    { label: 'Club',    budgetMs: 260,  maxDepth: 5,  randomCp: 25 },
  focused: { label: 'Focused', budgetMs: 600,  maxDepth: 12, randomCp: 0 },
  deep:    { label: 'Deep',    budgetMs: 1200, maxDepth: 20, randomCp: 0 },
};
export function createEngine(ttBits = 16)   // -> Engine, holds TT + history, reusable
export function search(pos, options = {})           // synchronous, returns SearchResult
export function searchStream(pos, options, onIteration)  // -> Promise<SearchResult>
```

`options`: `{ level = 'focused', budgetMs, maxDepth, randomCp, multiPv = 3,
engine, history = [], rng = Math.random, now = defaultNow, yieldFn, shouldStop }`.
`shouldStop` is checked by `searchStream` between iterations: the controller uses
it to drop a search whose position is already stale rather than wait out the budget.

`multiPv` is a strength decision, not just a display one. Each of the top
`multiPv` root moves is searched with a full window so its score is a
measurement, and that costs depth: measured at one to four plies between
`multiPv: 1` and `multiPv: 3` at the same budget. The page therefore searches at
`multiPv: 1` when the engine is only choosing a move and at `3` when the panel
is going to show lines.

`budgetMs` is **thinking time, not wall time**. `searchStream` gives the search a
clock that subtracts the time it spends suspended between iterations, because
handing back the event loop can cost more than the search itself (222 ms per
`setTimeout(0)` measured inside a preview pane), and a wall-clock deadline would
spend the budget waiting. `timeMs` in the result is that same thinking time.
`history` is an array of `positionKey` strings for positions already played, used
for repetition-aware scoring. `budgetMs` / `maxDepth` / `randomCp` override the
level. `searchStream` calls `onIteration(partialResult)` after every completed
depth and awaits `yieldFn()` (default: `setTimeout(0)`), so the page can paint;
it must never exceed `budgetMs` by more than one iteration's overrun and must
always return a legal move when one exists.

`SearchResult`:

```js
{
  best: number,        // move, 0 only when there are no legal moves
  scoreCp: number,     // side-to-move relative
  whiteCp: number,     // White relative, for the eval bar
  mateIn: number|null, // signed plies-to-mate/2 for the side to move; +2 = mates in 2
  depth: number, seldepth: number, nodes: number, timeMs: number,
  pv: number[],        // principal variation, best first
  lines: [{ move, scoreCp, pv: number[], exact: boolean }],  // <= multiPv, best first
  levelLabel: string,
}
```

`exact` is the honesty flag on a line. Only the top `multiPv` root moves are
searched with a full window, so a move that climbs into the displayed set is
re-searched before it is shown; anything still carrying a null-window bound is
marked `exact: false` and the UI prints it as `<= x.xx`. Every cutoff in the
search must fail **soft** -- returning `beta` from the null-move cutoff made
every fail-low root move report exactly the best score.

Search features required: iterative deepening, transposition table with depth
and bound, killer moves, history heuristic, MVV-LVA capture ordering, PV move
first, quiescence search over captures and promotions with a stand-pat cutoff,
check extension, and a mate-distance-aware score (`MATE - ply`). `randomCp`
adds noise to root move scores only (so weaker levels are weak by choice, not
by broken search) using the injected `rng`. Draw by repetition or fifty-move
inside the tree scores `0`. Time is read only through `options.now`, so tests
can drive a fake clock.

## explain.js exports

```js
export function see(pos, move)                     // static exchange, centipawns
export function describeMove(pos, move)            // -> Fact[]  (pos = BEFORE the move)
export function explainResult(pos, result)         // -> { headline, bullets: Fact[], evalText }
export function scoreText(whiteCp, mateIn, turn)   // 'White slightly better (+0.32)'
export function reviewMove(posBefore, movePlayed, bestResult, afterResult)
// -> { label, lostCp, playedSan, bestSan, bestPv: string[] } | null
```

`Fact` is `{ text, basis }`. **`basis` is mandatory** and names the computation
that produced the claim, one of: `'search-mate'`, `'search-score'`,
`'see'` (static exchange), `'material'`, `'eval-term:<name>'`, `'attack-map'`,
`'move-flag'`, `'repetition'`. A bullet with no computation behind it must not
be emitted. `reviewMove` labels the human's move by centipawn loss against the
engine's preferred move: `0-19 'best'`, `20-49 'good'`, `50-99 'inaccuracy'`,
`100-249 'mistake'`, `>=250 'blunder'`; it returns `null` if either search
result is missing. Losses are clamped so a mate score does not produce absurd
numbers.

## DOM contract (index.html <-> app.js / board-view.js)

`index.html` follows the site's markup conventions: `.skip-link`, `.site-header`
with `.brand` + `nav`, `main#main-content`, a `<footer>`, and a single
`<script type="module" src="./lib/app.js"></script>` as the last body element.
Page structure reuses the `game-*` class vocabulary from `game.css` where it
fits, and adds `chess-*` classes for what is new.

Required element ids (`app.js` must tolerate a missing **optional** id by
skipping that feature, and must throw a clear error if a **required** id is
absent):

| id | element | role |
|---|---|---|
| `board` | `div` | 64 square buttons injected by `board-view.js` (required) |
| `status-text`, `status-dot` | `span` | live status line, `role="status"` on the wrapper (required) |
| `eval-bar`, `eval-fill`, `eval-score` | `div`/`div`/`span` | eval bar, fill width is the White share (required) |
| `move-list`, `move-count` | `ol`, `span` | game record, one `li` per full move (required) |
| `level` | `select` | `casual`/`club`/`focused`/`deep` (required) |
| `new-game` | `button` | starts a new game with the current side/level (required) |
| `undo`, `redo`, `flip` | `button` | one half-move each way; flip orientation (required) |
| `hint` | `button` | run the engine and show the analysis without playing (required) |
| `analysis-headline`, `analysis-lines`, `analysis-why`, `analysis-depth` | | analysis view (required) |
| `review-label`, `review-detail` | `span`, `p` | last human move review (required) |
| `fen-input`, `fen-load`, `fen-copy` | | position in/out (required) |
| `san-input`, `san-submit` | `input`, `button` | typed over-the-board entry (required) |
| `promotion-dialog` | `div` | `hidden` until needed, buttons carry `data-promo="q\|r\|b\|n"` (required) |
| `captured-white`, `captured-black` | `div` | captured-piece strips (optional) |
| `thinking` | `span` | shown while the engine is running (optional) |

Segmented controls use `button[data-side="white"\|"black"]` and
`button[data-mode="play"\|"record"]` with `aria-pressed`, matching the existing
`.game-segmented` pattern. Squares are `button.chess-square[data-square="e4"]`
carrying `aria-label` (e.g. `"e4, white knight"`), `data-piece`, and the classes
`is-selected`, `is-target`, `is-capture`, `is-last`, `is-check` as state.

## Modes

**Play** -- human vs engine. Choosing White or Black restarts; the engine
answers automatically after a legal human move; `hint` analyses without moving.

**Record** -- live over-the-board entry. The engine never moves on its own.
Either side can be moved by hand (board taps or `san-input`), and after every
entered move the analysis view refreshes at the current level. This is the mode
used to follow a physical game: enter what was played, read the eval bar, the
candidate lines, and the review of the move just entered.

Both modes share one game record, so switching mode mid-game keeps the position,
the move list, undo/redo, and repetition counts intact.

## Test requirements

`node --test tests` must pass with no network and no dependencies.

- `perft.test.mjs` -- the six standard positions to depth 4 (and startpos +
  position 3 to depth 5). Expected values are in the test file; they are not
  negotiable, and a mismatch is a rules bug, never a test bug.
- `rules.test.mjs` -- FEN round trips, castling rights loss, en-passant pin
  legality, promotion (including capture-promotion), stalemate, fifty-move,
  threefold via `positionKey`, insufficient material, make/unmake and hash
  invariants.
- `notation.test.mjs` -- SAN disambiguation, castling and promotion SAN,
  check/mate suffixes, and tolerant parsing of every accepted input form.
- `tactics.test.mjs` -- fixed positions where the engine must find a mate or win
  material, driven with an explicit `now` clock so the suite is deterministic.
- `explain.test.mjs` -- every emitted `Fact` carries a legal `basis`; review
  labels land in the right bucket.
- `page.test.mjs` -- parses `web/index.html` as text and asserts that every
  required id above exists exactly once, that every id `app.js` and `panel.js`
  look up actually exists in the page, that the module script is last and alone,
  that no inline `<script>`/`on*=` handler and no remote **fetch** is present
  (absolute URLs in canonical/OG metadata are fine, nothing loads them), that no
  source file exceeds 300 lines, that the engine modules never touch
  `document`/`window`/`navigator` and the UI modules never assume node, and that
  the vendored `base.css` still matches the site's copy.
- `selfplay.test.mjs` -- full bot-vs-bot games with the analysis layer running on
  every position: only legal moves, SAN round trips inside a real game, every
  emitted `Fact` carrying a legal basis, review labels in range, static exchange
  agreeing with hand-checked cases, and a PV that is playable move by move and
  leaves the position untouched.

The suite is currently 58 tests and runs in about 12 seconds.

## Site handoff

`scripts/sync_site.py` (dry run by default, `--write` to write, `--check` to
diff) copies:

- `web/lib/*.js` -> `personal_website/assets/chess/*.js`, **byte for byte**
  (a subdirectory keeps the relative imports valid, so nothing is rewritten)
- the four `chess*.css` files -> `personal_website/*.css`, byte for byte
- `web/index.html` -> `personal_website/chess.html` with an explicit, asserted
  list of head rewrites (title, description, canonical, OG/Twitter URLs,
  `nav aria-current`, stylesheet hrefs to `/base.css?v=`, script src to
  `/assets/chess/app.js?rev=`). Each rewrite must match exactly once or the
  script fails.

It also prints, without applying them, the `_headers` block (`/chess*` with
`script-src 'self'`), the `sitemap.xml` entry, and the `/fun` card change from
`Planned` to `Playable now`. It never runs `git`.

