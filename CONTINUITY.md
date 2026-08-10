# CONTINUITY.md

## Snapshot
- Goal: 2026-08-07 [USER] Build the CHESS/64 "Chess Lab" promised on the /fun page
  of cpwei.qzz.io: a board that can be operated live, with a bot attached. Two
  interaction modes were requested: play against the engine, and enter the moves
  of a game happening on a physical board while the engine analyses.
- Now: 2026-08-07 [TOOL] Complete and working end to end. 58 tests pass
  (`node --test "tests/*.test.mjs"`), including perft to depth 5 on seven
  positions. Verified in a real browser at 1280x800 and 375x812: play, record,
  typed SAN entry, FEN load, promotion dialog, undo/redo, flip, draw detection,
  no console errors, no horizontal overflow.
- Next: 2026-08-07 [USER] Decide whether to publish. `python scripts/sync_site.py`
  is dry-run by default; publishing also needs the `_headers`, `sitemap.xml` and
  /fun card edits the script prints, and a human to commit and deploy.
- Open questions: 2026-08-07 [TOOL] Deep blocks the main thread for ~770 ms in the
  worst case even after the fix in D017, against the 420 ms the sibling META/81
  page holds itself to. Focused, the default, measures 349 ms. Whether Deep should
  be capped lower is a judgement call that wants a phone test first; no phone has
  been tested.
- Open questions: 2026-08-07 [TOOL] **Deep still has not been shown to be
  stronger than Focused**: 3 wins, 5 draws, 2 losses over 10 games
  (0.550 +/- 0.157). It does now search deeper where a depth fits -- d8 vs d7 in
  the opening, d11 vs d10 in the endgame -- but on the middlegame position it
  returns exactly what Focused returns, and 10 games cannot resolve whatever is
  left. It costs about twice the worst-case block (547 ms vs 253 ms). Either run
  a few hundred games to find out, raise its budget, or say plainly in the UI
  that it is a longer think rather than a stronger one. Do not let the label
  imply a strength that has not been measured.
- Open questions: 2026-08-08 [TOOL] The Lichess rating stopped 2 RD points short of
  losing its provisional flag: **2209, RD 112, 75 rated games, 66W 16L 1D**. The
  estimate is settled -- 2209 to 2220 across the last ~45 games while RD fell 147
  to 112 -- so what is unfinished is the deviation, not the number. Completing it
  needs a handful more games on a later day, because the account keeps meeting
  Lichess's challenge-creation limit and an hour in accept-only mode drew no
  incoming challenges. Resume with
  `--play --auto --band auto --challenge-gap 60000`; games already played count.
- Open questions: 2026-08-07 [ASSUMPTION] Whether Record mode should also accept a
  pasted PGN. Only FEN and one move at a time are supported today.

## Invariants / Constraints
- 2026-08-07 [USER] Project directory is `own/fun/chess/`. Files are written to be
  site-ready, but nothing is written into `personal_website/` and nothing is deployed.
- 2026-08-07 [CODE] One rule set. `web/lib/rules.js` is the only place a chess rule
  is implemented; search, UI and analysis all call it.
- 2026-08-07 [CODE] No Web Worker. Every `personal_website` route sends
  `worker-src 'none'`, including the ones allowed to run scripts.
- 2026-08-07 [CODE] No network, no dependency, no build step. `connect-src 'none'`.
- 2026-08-07 [CODE] Every source file stays under 300 lines and is ASCII-only.
- 2026-08-07 [USER] No strength claim outside `docs/measurements.md`, and no Elo
  anywhere: the levels are thinking budgets, not ratings.
- 2026-08-07 [CODE] An analysis sentence is shown only if a named computation
  produced it.

## Decisions
- D001 ACTIVE 2026-08-07 [USER]: Build in `own/fun/chess/` as a self-contained fun
  project, written to `personal_website` conventions (base.css vocabulary, 300-line
  cap, route-scoped CSP) so publishing is a copy rather than a port.
- D002 ACTIVE 2026-08-07 [CODE]: The website will serve **the same module files**,
  copied byte for byte into `assets/chess/`. A subdirectory keeps relative imports
  (`./rules.js`) valid, so no source is rewritten and no second copy of the rules
  can drift. The sibling META/81 project keeps three copies of one rule set and
  pays for it on every change; `/heist` avoided the same trap by not porting at all.
- D003 ACTIVE 2026-08-07 [CODE]: Search runs on the main thread with a millisecond
  budget (checked every 1024 nodes) and yields to the event loop between
  iterative-deepening iterations. Forced by `worker-src 'none'`; the side benefit
  is that the analysis panel fills in depth by depth.
- D004 ACTIVE 2026-08-07 [CODE]: 0x88 board, `piece = type | colour << 3`, move
  packed into one int (`from | to << 8 | promo << 16 | flags << 20`), captured piece
  in the undo record, zobrist kept as two int32 halves maintained incrementally.
- D005 ACTIVE 2026-08-07 [CODE]: Move generation is accepted by perft, not review.
  Seven positions to depth 4, plus depth 5 for the start position (4,865,609) and
  the endgame case. A number that moves is an engine bug; the table is not editable.
- D006 ACTIVE 2026-08-07 [CODE]: `generateMoves` returns legal moves only
  (pseudo-legal generation followed by a make/unmake king-safety filter). Simpler
  and provably right; the cost is acceptable at these budgets.
- D007 ACTIVE 2026-08-07 [TOOL]: Every cutoff must fail **soft**. The null-move
  cutoff returned `beta`, so a root move that failed low reported exactly alpha:
  the candidate list showed five different moves all tied at the best score
  (`e5 19 | Ke2 19 | Ba6 19 | Qg4 19 | Bb5+ 19` against a ground truth of
  `e5 19 | Nc3 15 | exd5 8`), and the move ordering carried the pollution into the
  next iteration. Regression test: "candidate lines are measurements, not a wall
  of ties".
- D008 ACTIVE 2026-08-07 [CODE]: Only the top `multiPv` root moves get a full
  window, so any move that climbs into the displayed set is re-searched before it
  is shown. A line that is still only bounded prints as `<= x.xx`. The panel never
  presents a bound as an evaluation.
- D009 ACTIVE 2026-08-07 [CODE]: Transposition-table **score** cutoffs are taken
  only at non-PV nodes. With them enabled everywhere, a mate-in-3 announced a
  4-ply line that did not end in mate. The hash move is still used for ordering
  everywhere.
- D010 ACTIVE 2026-08-07 [CODE]: Every `Fact` from `explain.js` carries a `basis`
  naming the computation behind it. The UI prints the tag next to the sentence.
  This is what keeps the analysis view from turning into narration.
- D011 ACTIVE 2026-08-07 [CODE]: In Play mode the panel does not show candidate
  lines for a position the human is about to move in; that would be a hint nobody
  asked for. It shows the review of the move just played instead. Record mode and
  the "Analyse, do not move" button show everything. The silent search that Play
  mode runs on the human's turn is what makes the review possible at all.
- D012 ACTIVE 2026-08-07 [CODE]: Levels are `{budgetMs, maxDepth, randomCp}`. Weak
  levels are weak because the move **choice** is noisy, not because the search is
  broken; at `randomCp > 0` every root move is given a full window so the noise
  chooses between real evaluations.
- D013 ACTIVE 2026-08-07 [CODE]: The 300-line cap drove the file layout: eleven
  engine modules and four stylesheets. A stylesheet's media queries live in the
  file that defines the rules they override, because the split files load in order
  and a media rule in an earlier file loses the cascade to a base rule in a later one.
- D014 ACTIVE 2026-08-07 [CODE]: `web/base.css` is a verbatim copy of the site's
  `base.css`, never edited here. `tests/page.test.mjs` and `sync_site.py` both
  report drift.
- D015 ACTIVE 2026-08-07 [CODE]: The "leaves material on X" bullet is suppressed
  when X is the square the move landed on: that recapture is already priced into
  the move's own static exchange, and printing both read as a contradiction
  ("trades evenly on d5" next to "loses a pawn on d5").
- D017 ACTIVE 2026-08-07 [TOOL]: The search yields between root moves, not only
  between depths, once 70 ms have passed since the last yield. Yielding only per
  depth left one block of 761 ms at the Deep budget. Measured after the change
  (`scripts/bench.mjs`): **Focused 253 ms worst block**, inside the 420 ms the
  sibling META/81 page holds itself to, and **Deep 547 ms**, outside it. Deep
  cannot be bounded further without yielding inside the tree, because a single
  root move's subtree can own most of an iteration; `worker-src 'none'` rules out
  the usual fix. Focused therefore stays the default in the level select, and
  Deep is an explicit choice by a visitor who wants the extra strength.
- D018 ACTIVE 2026-08-07 [TOOL]: Stop starting a depth that cannot finish, judged
  by the last iteration's cost (`elapsed + lastIteration * 3 > budget`) rather
  than by total elapsed time. The multiplier is the middle of a measured spread:
  depth-to-depth cost ratios on four positions ran 1.2x to 7.5x, so no value is
  right everywhere and this one is a judgement, not a result. What does finish
  before the clock stops is adopted by `adoptPartial` if it is no worse than the
  completed depth, with the candidate lines moved across too, so the headline
  cannot name a move the list does not show. The reported `timeMs` is now the
  true wall clock including any abandoned iteration; it used to be the clock as
  of the last *completed* depth, which understated what the page paid by up to
  900 ms.
- D019 ACTIVE 2026-08-07 [TOOL]: **The opponent searches one line, the panel
  searches three.** Giving the top three root moves a full window each, so the
  candidate list can show three honest scores (D008), costs one to four plies at
  the same budget: measured focused d4 -> d6 on the middlegame position, d7 -> d9
  on the endgame, and deep d4 -> d6 on the tactical one. That price is worth
  paying for the analysis view and pointless for a search that is only choosing a
  move, so `app.js` asks for `multiPv: 1` unless Record mode or the Analyse
  button wants lines. `bench.mjs` plays its ladder games at `multiPv: 1` to match
  what the page actually plays at.
- D020 ACTIVE 2026-08-07 [TOOL]: **Yielding is not free, and the budget must not
  pay for it.** `setTimeout(0)` measured 222 ms per round trip inside the preview
  pane; eight of them turned a 302 ms search into a 2079 ms wait, and because the
  deadline was wall clock the engine spent 85% of its budget suspended and played
  like it had never thought. Two changes: `searchStream` hands the search a clock
  that subtracts time spent suspended, so the budget buys thinking rather than
  waiting; and `defaultYield` posts a MessageChannel message (not clamped) with a
  50 ms timer as a safety net, skipping the yield entirely when `document.hidden`
  is true, since a hidden tab has nothing to paint and throttles its timers to
  about one a second. In node it stays a timer: an open MessagePort keeps the
  process alive and `node --test` hung on the first attempt.
- D021 ACTIVE 2026-08-07 [TOOL]: Aspiration on the first root move was measured
  twice. At `multiPv: 3` it is worthless -- two more full-window searches follow
  it, and one position got 6% *more* nodes. At `multiPv: 1`, where that move is
  the whole iteration, it is worth a depth on the middlegame position and 3x the
  speed on the tactical one. It ships because the opponent plays at multiPv 1.
  This is the shape of every tuning claim in this project: measured in the
  configuration it actually runs in, or not made.
- D022 ACTIVE 2026-08-07 [USER]: An Elo figure was requested for reference. What
  the data can support is a **relative** Elo: the difference between two levels,
  converted from the score of games they played against each other, with a 95%
  interval on each step and a lower bound where a pairing was a clean sweep. An
  absolute rating is not derivable here and is not written anywhere -- no
  opponent of known strength has ever been played, and the site's CSP forbids the
  network that would be needed to play one. Two caveats travel with the table:
  levels playing near-copies of themselves predict little about a differently
  built opponent, and the interval belongs to every step of the ladder.
  `bench.mjs` gained a worker mode (`--pairing`, `--seed-offset`, `--json`,
  `--merge`) so the sample could go from 10 games per pairing to 32; at 10 games
  the interval was about +/-110 Elo, which is not a number worth printing.
- D023 ACTIVE 2026-08-08 [USER]: An absolute rating is measured on **Lichess**,
  not chess.com. Lichess sanctions engine accounts -- BOT accounts exist for
  exactly this -- while chess.com's terms forbid both automated access and engine
  assistance, so running this against their bots would risk the owner's account
  rather than produce a number. The account is `Bot135`, created for this and
  upgraded with `POST /api/bot/account/upgrade`, which is irreversible and needs
  an account with zero games played. The token lives in `lichess.token`
  (gitignored via `*.token`) with only `bot:play` and `challenge:write`.
- D024 ACTIVE 2026-08-08 [TOOL]: **Lichess seeds BOT accounts at 3000
  provisional**, not the usual 1500, and this quietly wrecks naive matchmaking.
  The first four games were wins by mate over bots rated 987 to 1098 and the
  rating moved by exactly **+0** each time, with RD going 500 -> 499: a 3000
  beating a 987 is a foregone conclusion, so Glicko learns nothing from it. A
  hundred such games would still read 3000. `pickOpponents` therefore sorts by
  distance from our CURRENT rating, refreshed every cycle (`--band auto`), so
  the games are informative and the losses that follow can pull the number down
  to the truth. Any future calibration run must check that the rating is
  actually moving, not just that games are being won.
- D025 ACTIVE 2026-08-08 [CODE]: The bot plays one game at a time. `search()` is
  synchronous and blocks the process for its whole budget, so two concurrent
  games would take turns stalling each other and the waiting one could lose on
  time. Incoming challenges are declined while busy, sent challenges are counted
  as pending against the same limit, and a pending challenge nobody answers
  expires after 45 s so it cannot wedge the matchmaker.
- D016 ACTIVE 2026-08-07 [USER]: `scripts/sync_site.py` is dry-run by default,
  refuses to run if any of its HTML substitutions does not match exactly once,
  never runs git, and prints the `_headers` / `sitemap.xml` / fun-card changes for
  a human instead of applying them.

## State
### Done
- 2026-08-07 [CODE]: Rules engine, notation layer, evaluation, search, analysis,
  board view, panel and controller. Eleven modules, all under the line cap.
- 2026-08-07 [CODE]: 58 tests across six suites: perft, rules, notation, tactics,
  self-play, and a page test that checks the HTML/JS wiring, the CSP rules and the
  line cap without a browser.
- 2026-08-07 [TOOL]: Browser QA at 1280x800 and 375x812. Play mode (e4, engine
  replied d5, review "best"), Record mode (typed e4 e5 Nf3, review "good: the
  engine preferred Nc3, worth 0.27"), FEN load, promotion to a knight via the
  dialog, the resulting K+N vs K correctly declared a draw by insufficient
  material, undo/redo, flip, no console output, no horizontal overflow.
- 2026-08-07 [CODE]: `scripts/bench.mjs` and `scripts/sync_site.py`.

### Now
- 2026-08-07 [TOOL]: Local only. Nothing has been written into `personal_website`
  and nothing has been committed or deployed anywhere.

### Next
- 2026-08-07 [USER]: Decide on publishing (see Snapshot/Next).
- 2026-08-07 [CODE]: Optional: a phone check of the Deep level's blocking time,
  and a larger `bench.mjs` run than the 10-games-per-pairing sample.

## Incidents
- Incident: The Lichess API blocked us, and it was self-inflicted
  - Symptoms: 2026-08-08 [TOOL]: 44 consecutive `429 Too many requests` on
    challenge creation, then a block covering **reads** as well:
    `GET /api/user/Bot135` returned 429 for over two hours, probed at
    10-minute intervals. The calibration run stopped at 30 games with the rating
    still provisional.
  - Evidence: 2026-08-08 [CODE]: Three compounding causes, all ours. The
    challenge interval was cut from 20 s to 7 s to speed up convergence. The 429
    handler used a flat 60 s cooldown and then retried at the same rate, so each
    cooldown ended in another 429. And `pickOpponents` re-fetched
    `/api/bot/online` while `ourRating` re-read the account on every matchmaker
    cycle -- a request every ~18 s for data that only changes when a game ends --
    on top of an external tracker polling the same endpoint every 60 s.
  - Mitigation: 2026-08-08 [CODE]: All traffic stopped rather than retried.
    Backoff is now exponential per consecutive 429 up to 15 minutes and is
    cleared only by a success; the bot list and our rating are cached; the
    default challenge gap is back above 15 s.
  - Status: 2026-08-08 [TOOL]: UNRESOLVED at the two-hour mark. The last verified
    read (2220, RD 124, 30 games, provisional) is recorded in
    `docs/lichess_rating.json` with `converged: false`, and the generated report
    prints that caveat above the number.
  - Lesson: 2026-08-08 [USER]: Throughput knobs on someone else's API are not
    ours to tune by trial. The 7 s gap bought perhaps two extra games per hour
    and cost the whole measurement.
- Incident: The subagent fleet died mid-build
  - Symptoms: 2026-08-07 [TOOL]: A four-phase workflow (rules + shell, two
    adversarial verifiers, a fixer) failed after ~8 minutes with "You've hit your
    session limit" on both running agents.
  - Evidence: 2026-08-07 [TOOL]: `rules.js`, `tables.js`, `index.html` and the
    stylesheets had already been written; `notation.js` and every test had not.
  - Mitigation: 2026-08-07 [CODE]: Continued in the main session. The surviving
    `rules.js` was verified by perft before anything was built on it, then split
    for the line cap; everything else was written directly.
  - Status: 2026-08-07 [TOOL]: RESOLVED. No work was lost.
- Incident: Candidate lines all reported the same score
  - Symptoms: 2026-08-07 [TOOL]: The analysis panel showed three or five different
    moves with identical scores and one-move variations.
  - Evidence: 2026-08-07 [TOOL]: Searching each root move independently gave
    `e5 19 | Nc3 15 | exd5 8`; the multi-PV output gave `19` for every line. Root
    logging showed the equal scores were exactly the running alpha.
  - Mitigation: 2026-08-07 [CODE]: The null-move cutoff now fails soft (D007), the
    displayed lines are re-searched with a full window (D008), and bounded scores
    print with `<=`.
  - Status: 2026-08-07 [TOOL]: RESOLVED. Multi-PV now matches independent searches
    on the top moves; regression test added.

## Receipts
- 2026-08-07 [TOOL]: perft passes on all seven positions, including start depth 5
  = 4,865,609 and kiwipete depth 4 = 4,085,603; whole suite ~2.2 s.
- 2026-08-07 [TOOL]: `node --test "tests/*.test.mjs"` -> 58 pass, 0 fail.
- 2026-08-07 [TOOL]: Line counts after the split, all under the 300 cap:
  app.js 293, rules.js 264, explain.js 249, eval.js 240, search.js ~285,
  chess.css 276, chess-board.css 269, chess-panel.css 213, chess-stage.css 177.
- 2026-08-07 [TOOL]: `python scripts/sync_site.py` dry run reports 17 files would
  change and writes nothing.
- 2026-08-07 [TOOL]: Measured search speed, main-thread blocking and the level
  ladder are in `docs/measurements.md`, regenerated by `node scripts/bench.mjs`.
- 2026-08-07 [TOOL]: Final ladder, 10 games per pairing at the shipped playing
  configuration: club over casual 10-0-0 (1.000 +/- 0.032), focused over club
  6W 4D 0L (0.800 +/- 0.126), deep over focused 3W 5D 2L (0.550 +/- 0.157). The
  bottom three levels are ordered; the top pair is not shown to differ.
- 2026-08-07 [TOOL]: The multiPv split is worth 2 to 3 plies at the same budget
  on three of four test positions (focused: endgame d10 playing vs d7 analysing,
  middlegame d6 vs d4, tactical d6 vs d4).
- 2026-08-07 [TOOL]: In-page check after the change: Play mode reaches depth 6 in
  242 ms where the same position previously took 1001 ms to reach depth 5, and
  the Analyse button still returns three exact candidate lines.

