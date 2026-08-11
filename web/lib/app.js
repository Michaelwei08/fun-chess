// app.js -- the Chess Lab controller: one game record, two modes over it.
// Play answers your moves; Record never moves a piece and is there to follow a
// game happening on a real board. Both share the position, the move list, undo
// and the repetition counts, so switching mid-game rebuilds nothing.

import {
  START_FEN, fromFen, toFen, clonePosition, generateMoves, makeMove, gameStatus,
  positionKey, inCheck, legalPosition, squareName, parseSquare, moveFrom, moveTo,
  movePromo, colorOf, WHITE, BLACK,
} from './rules.js';
import { moveToSan, sanToMove } from './notation.js';
import { createEngine, searchStream, LEVELS } from './search.js';
import { explainResult, reviewMove } from './explain.js';
import { createBoardView, askPromotion } from './board-view.js';
import { createPanel } from './panel.js';

const el = (id) => document.getElementById(id);
const PROMO_TYPE = { q: 5, r: 4, b: 3, n: 2 };
const SIDE_NAME = ['White', 'Black'];

const state = {
  startFen: START_FEN, moves: [], sans: [], future: [],
  pos: fromFen(START_FEN), keyCounts: new Map(), repeatKeys: [],
  mode: 'play', humanSide: WHITE, level: 'focused',
  selected: '', targets: new Map(),
  generation: 0, baseline: null, current: null, showLines: false, busy: false,
};

const engine = createEngine(17);
const panel = createPanel();
const board = createBoardView(el('board'), onSquare);

function rebuild() {
  state.pos = fromFen(state.startFen);
  state.keyCounts = new Map([[positionKey(state.pos), 1]]);
  state.repeatKeys = [positionKey(state.pos)];
  for (const move of state.moves) {
    makeMove(state.pos, move);
    const key = positionKey(state.pos);
    state.keyCounts.set(key, (state.keyCounts.get(key) || 0) + 1);
    if (state.pos.half === 0) state.repeatKeys.length = 0;
    state.repeatKeys.push(key);
  }
}

const startPos = () => fromFen(state.startFen);

function endText(status) {
  if (status.reason === 'checkmate') return 'Checkmate. ' + (status.result === 'white' ? 'White' : 'Black') + ' wins.';
  const label = {
    stalemate: 'Draw by stalemate.', 'fifty-move': 'Draw by the fifty-move rule.',
    threefold: 'Draw by threefold repetition.', 'insufficient-material': 'Draw: not enough material to mate.',
  };
  return label[status.reason] || 'Game over.';
}

function refresh() {
  const checkSquare = inCheck(state.pos) ? squareName(state.pos.kings[state.pos.turn]) : '';
  const last = state.moves.length
    ? [squareName(moveFrom(state.moves[state.moves.length - 1])), squareName(moveTo(state.moves[state.moves.length - 1]))]
    : [];
  board.render(state.pos, { selected: state.selected, targets: state.targets, lastMove: last, checkSquare });
  panel.setMoveList(state.sans, startPos().turn, startPos().full);
  panel.setCaptured(state.pos, startPos());
  panel.setFen(toFen(state.pos));
}

function describeTurn() {
  const mover = SIDE_NAME[state.pos.turn];
  if (state.mode === 'record') return mover + ' to move -- enter the move that was played.';
  if (state.pos.turn === state.humanSide) return 'Your move as ' + mover.toLowerCase() + '.';
  return mover + ' (the engine) is thinking.';
}

function legalTargets(from) {
  const map = new Map();
  for (const move of generateMoves(state.pos)) {
    if (moveFrom(move) !== from) continue;
    const name = squareName(moveTo(move));
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(move);
  }
  return map;
}

function canTouch() {
  if (state.busy) return false;
  if (gameStatus(state.pos, state.keyCounts).over) return false;
  return state.mode === 'record' || state.pos.turn === state.humanSide;
}

async function onSquare(name) {
  if (!canTouch()) return;
  const sq = parseSquare(name);
  const candidates = state.targets.get(name);
  if (state.selected && candidates && candidates.length) {
    let move = candidates[0];
    if (candidates.length > 1 && movePromo(move)) {
      const letter = await askPromotion(el('promotion-dialog'), state.pos.turn);
      if (!letter) return;
      move = candidates.find((m) => movePromo(m) === PROMO_TYPE[letter]) || move;
    }
    state.selected = ''; state.targets = new Map();
    playMove(move, false);
    return;
  }
  const piece = state.pos.board[sq];
  if (piece && colorOf(piece) === state.pos.turn) {
    state.selected = name;
    state.targets = legalTargets(sq);
  } else {
    state.selected = ''; state.targets = new Map();
  }
  refresh();
}

function playMove(move, byEngine) {
  const before = clonePosition(state.pos);
  state.sans.push(moveToSan(state.pos, move));
  state.moves.push(move);
  state.future.length = 0;
  makeMove(state.pos, move);
  const key = positionKey(state.pos);
  state.keyCounts.set(key, (state.keyCounts.get(key) || 0) + 1);
  if (state.pos.half === 0) state.repeatKeys.length = 0;
  state.repeatKeys.push(key);
  state.showLines = false;
  state.selected = ''; state.targets = new Map();
  advance({ before, move, byEngine });
}

// Three full-window root searches, so the panel can show three honest scores,
// cost one to four plies at the same budget. The lab pays it, the opponent does
// not: a search that is only choosing a move asks for one line.
const wantsLines = () => state.mode === 'record' || state.showLines;

async function analyse(generation, overrides) {
  panel.setThinking(true, state.mode === 'play' && state.pos.turn !== state.humanSide ? 'thinking' : 'analysing');
  const result = await searchStream(state.pos, {
    level: LEVELS[state.level] ? state.level : 'focused',
    engine, multiPv: wantsLines() ? 3 : 1, history: state.repeatKeys,
    shouldStop: () => generation !== state.generation,
    ...overrides,
  }, (partial) => {
    if (generation === state.generation) panel.setEval(partial.whiteCp, partial.mateIn, state.pos.turn);
  });
  panel.setThinking(false);
  return generation === state.generation ? result : null;
}

// Everything that has to happen after the position changed, whoever changed it.
async function advance(justPlayed) {
  const generation = ++state.generation;
  refresh();
  const status = gameStatus(state.pos, state.keyCounts);
  if (status.over) {
    state.busy = false;
    panel.setStatus(endText(status), 'over');
    panel.setThinking(false);
    if (justPlayed && !justPlayed.byEngine) panel.clearAnalysis(endText(status));
    return;
  }
  const engineToMove = state.mode === 'play' && state.pos.turn !== state.humanSide;
  state.busy = engineToMove;
  panel.setStatus(describeTurn(), engineToMove ? 'wait' : 'live');
  const result = await analyse(generation);
  if (!result || generation !== state.generation) return;
  state.current = result;
  panel.setEval(result.whiteCp, result.mateIn, state.pos.turn);
  if (justPlayed && !justPlayed.byEngine && state.baseline) {
    panel.setReview(reviewMove(justPlayed.before, justPlayed.move, state.baseline, result));
  }
  // In Play mode the panel does not show the engine's pick for a position you
  // are about to move in: that would be a hint nobody asked for. Record mode
  // and the Analyse button show everything.
  if (wantsLines() || engineToMove) {
    panel.showAnalysis(state.pos, result, explainResult(state.pos, result));
  } else {
    panel.clearAnalysis('Your move. Press "Analyse, do not move" to see the engine lines for this position.');
  }
  state.baseline = result;
  if (engineToMove && result.best) {
    state.busy = false;
    playMove(result.best, true);
  }
}

function resetGame(fen) {
  state.startFen = fen || state.startFen;
  state.moves = []; state.sans = []; state.future = [];
  state.selected = ''; state.targets = new Map();
  state.baseline = null; state.current = null; state.showLines = false; state.busy = false;
  rebuild();
  panel.setReview(null);
  panel.clearAnalysis('New game. The engine has not searched this position yet.');
  advance(null);
}

function stepBack() {
  if (!state.moves.length || state.busy) return;
  state.future.push(state.moves.pop());
  state.sans.pop();
  if (state.mode === 'play' && state.moves.length &&
    fromFenTurnAfter() !== state.humanSide) {
    state.future.push(state.moves.pop());
    state.sans.pop();
  }
  state.baseline = null;
  rebuild();
  advance(null);
}

// Turn to move once the current move list is replayed.
function fromFenTurnAfter() {
  return (startPos().turn + state.moves.length) % 2;
}

function stepForward() {
  if (!state.future.length || state.busy) return;
  const move = state.future.pop();
  if (!generateMoves(state.pos).includes(move)) { state.future.length = 0; return; }
  state.sans.push(moveToSan(state.pos, move));
  state.moves.push(move);
  state.baseline = null;
  rebuild();
  advance(null);
}

function submitTypedMove() {
  const input = el('san-input');
  if (!input || !canTouch()) return;
  const move = sanToMove(state.pos, input.value);
  if (!move) {
    panel.setStatus('"' + input.value.trim() + '" is not a legal move here. Try Nf3, exd5, O-O or e2e4.', 'over');
    return;
  }
  input.value = '';
  playMove(move, false);
}

function loadFen() {
  const input = el('fen-input');
  if (!input) return;
  try {
    const candidate = fromFen(input.value.trim());
    const verdict = legalPosition(candidate);
    if (!verdict.ok) throw new Error('That position is not playable: ' + verdict.reason + '.');
    resetGame(toFen(candidate));
  } catch (error) {
    panel.setStatus(error.message, 'over');
  }
}

function copyFen() {
  const input = el('fen-input');
  if (!input) return;
  input.value = toFen(state.pos);
  input.select();
  if (navigator.clipboard) navigator.clipboard.writeText(input.value).catch(() => {});
  panel.setStatus('Position copied as FEN.', 'live');
}

function segmented(attribute, apply) {
  for (const button of document.querySelectorAll('button[' + attribute + ']')) {
    button.addEventListener('click', () => {
      for (const other of document.querySelectorAll('button[' + attribute + ']')) {
        other.setAttribute('aria-pressed', String(other === button));
      }
      apply(button.getAttribute(attribute));
    });
  }
}

segmented('data-mode', (mode) => {
  state.mode = mode;
  state.busy = false;
  advance(null);
});
segmented('data-side', (side) => {
  state.humanSide = side === 'black' ? BLACK : WHITE;
  board.setOrientation(state.humanSide);
  resetGame(START_FEN);
});

el('level').addEventListener('change', (event) => { state.level = event.target.value; });
el('new-game').addEventListener('click', () => resetGame(state.startFen));
el('undo').addEventListener('click', stepBack);
el('redo').addEventListener('click', stepForward);
el('flip').addEventListener('click', () => { board.flip(); refresh(); });
el('hint').addEventListener('click', () => { state.showLines = true; advance(null); });
el('san-submit').addEventListener('click', submitTypedMove);
el('san-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') submitTypedMove(); });
el('fen-load').addEventListener('click', loadFen);
el('fen-copy').addEventListener('click', copyFen);

state.level = el('level').value || 'focused';
resetGame(START_FEN);
