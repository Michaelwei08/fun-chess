// lichess_bot.mjs -- play the Chess Lab engine on Lichess to get an ABSOLUTE
// rating, which the level ladder in docs/measurements.md cannot provide on its
// own: levels beating other levels only measure differences.
//
// Lichess sanctions engine accounts -- that is what BOT accounts are for -- so
// unlike some other sites this is a supported use, not a rules problem. It does
// need a dedicated account: the upgrade below is IRREVERSIBLE and only works on
// an account that has never played a game.
//
//   node scripts/lichess_bot.mjs --check                     # who am I, nothing else
//   node scripts/lichess_bot.mjs --upgrade                   # one-way: account becomes a BOT
//   node scripts/lichess_bot.mjs --play --level focused --max-games 30
//   node scripts/lichess_bot.mjs --play --challenge maia1 --rated true
//
// The token is read from LICHESS_TOKEN or --token-file PATH, never from a
// command-line argument: arguments show up in process listings. It needs the
// bot:play scope and must never be committed.

import { readFileSync } from 'node:fs';
import {
  START_FEN, fromFen, generateMoves, makeMove, toFen,
} from '../web/lib/rules.js';
import { uciToMove, moveToUci } from '../web/lib/notation.js';
import { search, createEngine, LEVELS } from '../web/lib/search.js';

const API = 'https://lichess.org';
const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  if (!process.argv[i].startsWith('--')) continue;
  const key = process.argv[i].replace(/^--/, '');
  const next = process.argv[i + 1];
  args.set(key, next && !next.startsWith('--') ? next : 'true');
}

const TOKEN = (args.get('token-file')
  ? readFileSync(args.get('token-file'), 'utf8')
  : (process.env.LICHESS_TOKEN || '')).trim();
if (!TOKEN) {
  console.error('No token. Set LICHESS_TOKEN or pass --token-file PATH (bot:play scope).');
  process.exit(2);
}

const LEVEL = args.get('level') || 'focused';
const MAX_GAMES = Number(args.get('max-games') || 30);
// A bot that never refuses anything ends up in 15-minute correspondence games it
// cannot finish, so the acceptable band is explicit.
const MIN_INITIAL = Number(args.get('min-initial') || 60);
const MAX_INITIAL = Number(args.get('max-initial') || 900);

const auth = { Authorization: 'Bearer ' + TOKEN };
const engines = new Map();
let account = null;
let finished = 0;
let pending = 0;          // challenges sent but not yet a game or a refusal
const active = new Set();
const blocked = new Set();   // opponents at their daily bot-vs-bot cap
const CONCURRENCY = Number(args.get('concurrency') || 1);

// The search is synchronous: it blocks this process for the whole budget. Two
// games at once would therefore take turns stalling each other, and the one
// waiting can lose on time. Everything below refuses to start a game that would
// exceed CONCURRENCY, including incoming challenges.
const busy = () => active.size + pending >= CONCURRENCY;

async function api(path, options = {}) {
  const response = await fetch(API + path, {
    ...options,
    headers: { ...auth, ...(options.headers || {}) },
  });
  if (!response.ok) {
    // The parentheses matter: without them the concatenation binds first and
    // every failure reports the bare word "POST" with no status and no body.
    throw new Error((options.method || 'GET') + ' ' + path + ' -> ' + response.status +
      ' ' + (await response.text()).slice(0, 300));
  }
  return response;
}

// Lichess streams newline-delimited JSON and sends blank lines as keep-alives.
async function* ndjson(path) {
  const response = await api(path);
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += Buffer.from(chunk).toString('utf8');
    let cut;
    while ((cut = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (line) yield JSON.parse(line);
    }
  }
}

// Rebuild the position from the move list Lichess sends, then think.
//
// By default the engine thinks for exactly the level's own budget, so whatever
// rating comes back describes the level a visitor actually plays against rather
// than some other time manager wearing its name. --adaptive spends a thirtieth
// of the clock plus most of the increment instead, which is stronger at long
// time controls but no longer the shipped configuration. Either way the budget
// is clamped so the engine cannot flag.
function chooseMove(initialFen, movesText, ourTurnIsWhite, state, gameId) {
  const pos = fromFen(initialFen === 'startpos' ? START_FEN : initialFen);
  for (const uci of movesText.split(' ').filter(Boolean)) {
    const move = uciToMove(pos, uci);
    if (!move) throw new Error('Lichess sent a move this engine cannot parse: ' + uci);
    makeMove(pos, move);
  }
  if ((pos.turn === 0) !== ourTurnIsWhite) return null;
  const remaining = ourTurnIsWhite ? state.wtime : state.btime;
  const increment = ourTurnIsWhite ? state.winc : state.binc;
  const wanted = args.get('adaptive')
    ? remaining / 30 + increment * 0.7
    : (LEVELS[LEVEL] || LEVELS.focused).budgetMs;
  const budgetMs = Math.max(40, Math.min(wanted, remaining - 700, 4000));
  if (!engines.has(gameId)) engines.set(gameId, createEngine(18));
  const result = search(pos, { level: LEVEL, multiPv: 1, budgetMs, engine: engines.get(gameId) });
  if (!result.best) return null;
  return { uci: moveToUci(result.best), scoreCp: result.scoreCp, depth: result.depth, budgetMs };
}

async function playGame(gameId) {
  active.add(gameId);
  let initialFen = 'startpos';
  let weAreWhite = true;
  try {
    for await (const event of ndjson('/api/bot/game/stream/' + gameId)) {
      let state = null;
      if (event.type === 'gameFull') {
        initialFen = event.initialFen || 'startpos';
        weAreWhite = event.white.id === account.id;
        console.log('[' + gameId + '] ' + event.white.id + ' vs ' + event.black.id +
          ' | we are ' + (weAreWhite ? 'white' : 'black') +
          ' | ' + (event.clock ? (event.clock.initial / 1000) + '+' + (event.clock.increment / 1000) : 'no clock') +
          ' | rated=' + event.rated);
        state = event.state;
      } else if (event.type === 'gameState') {
        state = event;
      } else {
        continue;
      }
      if (state.status !== 'started') {
        console.log('[' + gameId + '] finished: ' + state.status + ' winner=' + (state.winner || 'none'));
        break;
      }
      const choice = chooseMove(initialFen, state.moves || '', weAreWhite, state, gameId);
      if (!choice) continue;
      await api('/api/bot/game/' + gameId + '/move/' + choice.uci, { method: 'POST' });
      console.log('[' + gameId + '] ' + choice.uci + ' d' + choice.depth +
        ' ' + (choice.scoreCp / 100).toFixed(2) + ' in ' + Math.round(choice.budgetMs) + 'ms');
    }
  } catch (error) {
    console.error('[' + gameId + '] ' + error.message);
  } finally {
    active.delete(gameId);
    engines.delete(gameId);
    finished++;
  }
}

async function acceptable(challenge) {
  if (busy()) return 'already playing';
  if (challenge.variant.key !== 'standard') return 'not standard chess';
  if (challenge.timeControl.type !== 'clock') return 'no clock';
  const initial = challenge.timeControl.limit;
  if (initial < MIN_INITIAL || initial > MAX_INITIAL) return 'clock outside ' + MIN_INITIAL + '-' + MAX_INITIAL + 's';
  return null;
}

async function main() {
  account = await (await api('/api/account')).json();
  console.log('account: ' + account.username + ' | title=' + (account.title || 'none') +
    ' | games played=' + (account.count ? account.count.all : '?'));

  if (args.get('check')) {
    console.log(account.title === 'BOT'
      ? 'This is a BOT account; --play will work.'
      : 'Not a BOT account yet. --upgrade is IRREVERSIBLE and needs 0 games played.');
    return;
  }

  if (args.get('upgrade')) {
    if (account.title === 'BOT') { console.log('Already a BOT account, nothing to do.'); return; }
    await api('/api/bot/account/upgrade', { method: 'POST' });
    console.log('Upgraded to a BOT account. This cannot be undone.');
    return;
  }

  if (!args.get('play')) {
    console.log('Nothing to do. Pass --check, --upgrade, or --play.');
    return;
  }
  if (account.title !== 'BOT') {
    console.error('This account is not a BOT; the bot endpoints will refuse. Run --upgrade first.');
    process.exit(3);
  }

  if (args.get('challenge')) {
    for (const opponent of args.get('challenge').split(',')) await challenge(opponent.trim());
  }
  if (args.get('auto')) runMatchmaker();

  console.log('listening for games (stops after ' + MAX_GAMES + ')');
  for await (const event of ndjson('/api/stream/event')) {
    if (event.type === 'challenge' && event.challenge.challenger.id !== account.id) {
      const reason = await acceptable(event.challenge);
      if (reason) {
        await api('/api/challenge/' + event.challenge.id + '/decline', {
          method: 'POST', body: new URLSearchParams({ reason: 'generic' }),
        }).catch(() => {});
        console.log('declined ' + event.challenge.id + ': ' + reason);
      } else {
        await api('/api/challenge/' + event.challenge.id + '/accept', { method: 'POST' }).catch(() => {});
        console.log('accepted ' + event.challenge.id);
      }
    } else if (event.type === 'gameStart') {
      pending = Math.max(0, pending - 1);
      playGame(event.game.gameId || event.game.id);
    } else if (event.type === 'challengeDeclined') {
      pending = Math.max(0, pending - 1);
      console.log('opponent declined ' + event.challenge.id);
    }
    if (finished >= MAX_GAMES && active.size === 0) {
      console.log('played ' + finished + ' games, stopping');
      break;
    }
  }
}

async function challenge(opponent) {
  const body = new URLSearchParams({
    rated: String(args.get('rated') !== 'false'),
    'clock.limit': String(args.get('clock-limit') || 180),
    'clock.increment': String(args.get('clock-increment') || 2),
    variant: 'standard',
  });
  try {
    const created = await (await api('/api/challenge/' + opponent, { method: 'POST', body })).json();
    const id = (created.challenge && created.challenge.id) || created.id;
    pending++;
    console.log('challenged ' + opponent);
    // A challenge nobody answers would pin `pending` high forever and stall the
    // matchmaker, so it expires. It must be CANCELLED at the same time, not just
    // forgotten: an abandoned challenge stays live on Lichess and can be
    // accepted minutes later, which is how four games once started before any
    // of them had finished, with one synchronous engine trying to serve them
    // all.
    setTimeout(async () => {
      pending = Math.max(0, pending - 1);
      if (id) await api('/api/challenge/' + id + '/cancel', { method: 'POST' }).catch(() => {});
    }, 45000);
    return true;
  } catch (error) {
    // Lichess caps bot-versus-bot games at 100 per bot per day, and the popular
    // strong bots are usually already at the cap. Retrying them just burns the
    // matchmaker's cycles, so they are dropped for the rest of the run.
    if (/bot\.vsBot\.day|played 100 games/.test(error.message)) {
      blocked.add(opponent);
      console.log('skipping ' + opponent + ' for today: at its bot-vs-bot limit');
    } else {
      console.error('challenge to ' + opponent + ' failed: ' + error.message);
    }
    return false;
  }
}

async function ourRating() {
  try {
    const user = await (await fetch(API + '/api/user/' + account.id)).json();
    return user.perfs && user.perfs.blitz ? user.perfs.blitz.rating : 1500;
  } catch { return 1500; }
}

// Opponents with a settled rating make better yardsticks than opponents whose
// own rating is still moving, so anything with few games is skipped.
//
// --band auto sorts by how close the opponent is to our CURRENT rating, which
// is the whole game with Glicko: a result only carries information when it was
// not a foregone conclusion. Lichess seeds BOT accounts at 3000 provisional, so
// a fixed low band means winning every game, learning nothing, and sitting at
// 3000 forever. Beating a 987 when you are rated 3000 moves the number by +0.
async function pickOpponents() {
  const band = args.get('band') || 'auto';
  const text = await (await fetch(API + '/api/bot/online?nb=100')).text();
  let bots = text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .map((bot) => ({ id: bot.id, rating: bot.perfs && bot.perfs.blitz ? bot.perfs.blitz.rating : 0,
      games: bot.perfs && bot.perfs.blitz ? bot.perfs.blitz.games : 0 }))
    .filter((bot) => bot.rating > 0 && bot.games >= 300 && bot.id !== account.id
      && !blocked.has(bot.id));
  if (band === 'auto') {
    const mine = await ourRating();
    bots.sort((a, b) => Math.abs(a.rating - mine) - Math.abs(b.rating - mine));
    return bots;
  }
  const [low, high] = band.split(':').map(Number);
  return bots.filter((bot) => bot.rating >= low && bot.rating <= high)
    .sort((a, b) => a.rating - b.rating);
}

async function runMatchmaker() {
  const tried = new Map();
  while (finished < MAX_GAMES) {
    if (busy() || finished + active.size + pending >= MAX_GAMES) {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    const pool = await pickOpponents().catch(() => []);
    if (!pool.length) { await new Promise((r) => setTimeout(r, 30000)); continue; }
    // Stable-sort by attempt count so the pool order (closeness to our rating)
    // still decides among equally-tried opponents: one obliging bot must not
    // become the whole sample, and one that ignores us must not block the run.
    pool.sort((a, b) => (tried.get(a.id) || 0) - (tried.get(b.id) || 0));
    const target = pool[0];
    tried.set(target.id, (tried.get(target.id) || 0) + 1);
    console.log('matchmaker: ' + target.id + ' (blitz ' + target.rating + ', ' + target.games + ' games)');
    await challenge(target.id);
    await new Promise((r) => setTimeout(r, 20000));
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
