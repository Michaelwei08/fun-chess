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
const active = new Set();

async function api(path, options = {}) {
  const response = await fetch(API + path, {
    ...options,
    headers: { ...auth, ...(options.headers || {}) },
  });
  if (!response.ok) {
    throw new Error(options.method || 'GET' + ' ' + path + ' -> ' + response.status + ' ' +
      (await response.text()).slice(0, 200));
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
    for (const opponent of args.get('challenge').split(',')) {
      const body = new URLSearchParams({
        rated: String(args.get('rated') === 'true'),
        'clock.limit': String(args.get('clock-limit') || 180),
        'clock.increment': String(args.get('clock-increment') || 2),
        variant: 'standard',
      });
      try {
        await api('/api/challenge/' + opponent.trim(), { method: 'POST', body });
        console.log('challenged ' + opponent.trim());
      } catch (error) {
        console.error('challenge to ' + opponent.trim() + ' failed: ' + error.message);
      }
    }
  }

  console.log('listening for games (stops after ' + MAX_GAMES + ')');
  for await (const event of ndjson('/api/stream/event')) {
    if (event.type === 'challenge') {
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
      playGame(event.game.gameId || event.game.id);
    }
    if (finished >= MAX_GAMES && active.size === 0) {
      console.log('played ' + finished + ' games, stopping');
      break;
    }
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
