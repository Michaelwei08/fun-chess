// panel.js -- everything outside the board: status line, eval bar, game record,
// captured pieces, candidate lines, reasons and the review of the last move.
// Pure DOM writing. It never decides anything; app.js hands it finished values.

import { WHITE, typeOf, colorOf, PAWN, KING } from './rules.js';
import { glyphFor, pvToSan, moveListToPgn } from './notation.js';
import { scoreText } from './explain.js';

const el = (id) => document.getElementById(id);

// Missing pieces are counted against the position the game STARTED from, not
// against a standard array: a game entered from a pasted FEN has not "captured"
// the pieces that FEN never had.
function census(pos) {
  const counts = [{}, {}];
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const piece = pos.board[r * 16 + f];
      if (!piece || typeOf(piece) === KING) continue;
      const side = colorOf(piece), type = typeOf(piece);
      counts[side][type] = (counts[side][type] || 0) + 1;
    }
  }
  return counts;
}

function text(node, value) { if (node) node.textContent = value; }

function list(node, items, emptyMessage) {
  if (!node) return;
  node.textContent = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'chess-empty';
    li.textContent = emptyMessage;
    node.appendChild(li);
    return;
  }
  for (const item of items) node.appendChild(item);
}

export function createPanel() {
  const nodes = {
    status: el('status-text'), dot: el('status-dot'), thinking: el('thinking'),
    fill: el('eval-fill'), bar: el('eval-bar'), score: el('eval-score'),
    moveList: el('move-list'), moveCount: el('move-count'),
    headline: el('analysis-headline'), lines: el('analysis-lines'),
    why: el('analysis-why'), depth: el('analysis-depth'),
    reviewLabel: el('review-label'), reviewDetail: el('review-detail'),
    capturedWhite: el('captured-white'), capturedBlack: el('captured-black'),
    fen: el('fen-input'),
  };
  const required = ['status', 'fill', 'score', 'moveList', 'headline', 'lines', 'why', 'depth'];
  for (const key of required) {
    if (!nodes[key]) throw new Error('Chess Lab: index.html is missing #' + key);
  }

  return {
    setStatus(message, tone = 'live') {
      text(nodes.status, message);
      if (nodes.dot) nodes.dot.style.background =
        tone === 'over' ? 'var(--cardinal)' : tone === 'wait' ? 'var(--amber)' : 'var(--teal)';
    },

    setThinking(on, label) {
      if (!nodes.thinking) return;
      nodes.thinking.hidden = !on;
      nodes.thinking.textContent = label || 'thinking';
    },

    // A logistic squash, so a two-pawn edge is visible without a queen pinning
    // the bar to the end of its travel.
    setEval(whiteCp, mateIn, turn) {
      let share = 50 + 50 * Math.tanh(whiteCp / 400);
      if (mateIn !== null) {
        const whiteMates = (mateIn > 0) === (turn === WHITE);
        share = whiteMates ? 100 : 0;
      }
      nodes.fill.style.width = Math.max(1, Math.min(99, share)).toFixed(1) + '%';
      const label = scoreText(whiteCp, mateIn, turn);
      text(nodes.score, mateIn !== null ? 'M' + Math.abs(mateIn) : (whiteCp / 100).toFixed(2));
      if (nodes.bar) nodes.bar.setAttribute('aria-label', 'Evaluation bar: ' + label);
    },

    setMoveList(sans, startTurn, startFull) {
      const rows = [];
      let number = startFull, index = 0;
      if (startTurn === 1 && sans.length) {
        const li = document.createElement('li');
        li.append(cell(number + '.'), cell('...'), cell(sans[0]));
        rows.push(li); index = 1; number++;
      }
      for (; index < sans.length; index += 2) {
        const li = document.createElement('li');
        li.append(cell(number + '.'), cell(sans[index]), cell(sans[index + 1] || ''));
        rows.push(li); number++;
      }
      list(nodes.moveList, rows, 'One line per full move, as it would be written on a scoresheet.');
      text(nodes.moveCount, String(sans.length).padStart(2, '0'));
      if (nodes.moveList.lastElementChild) nodes.moveList.lastElementChild.scrollIntoView({ block: 'nearest' });
    },

    setCaptured(pos, startPos) {
      const now = census(pos), start = census(startPos || pos);
      for (const side of [WHITE, 1]) {
        const target = side === WHITE ? nodes.capturedWhite : nodes.capturedBlack;
        if (!target) continue;
        let out = '';
        for (const type of [5, 4, 3, 2, PAWN]) {
          const missing = (start[side][type] || 0) - (now[side][type] || 0);
          if (missing > 0) out += glyphFor(type | (side << 3)).repeat(missing);
        }
        target.textContent = out;
      }
    },

    showAnalysis(pos, result, explanation) {
      text(nodes.depth, result.depth
        ? 'depth ' + result.depth + (result.seldepth > result.depth ? '/' + result.seldepth : '') +
          ' - ' + result.nodes.toLocaleString('en-US') + ' nodes - ' + result.timeMs + ' ms'
        : 'no search');
      text(nodes.headline, explanation.headline);
      const lines = result.lines.map((line, i) => {
        const li = document.createElement('li');
        const score = line.scoreCp;
        const shown = Math.abs(score) > 29000
          ? '#' + Math.ceil((30000 - Math.abs(score)) / 2) * Math.sign(score)
          : (score > 0 ? '+' : '') + (score / 100).toFixed(2);
        // A move searched against a null window only has an upper bound, and
        // saying so is cheaper than pretending it is a measurement.
        li.append(cell((i + 1) + '. ' + (line.exact === false ? '<= ' : '') + shown, 'chess-line-score'),
          cell(pvToSan(pos, line.pv, 7).join(' ')));
        return li;
      });
      list(nodes.lines, lines, 'No candidate lines yet.');
      const why = explanation.bullets.map((bullet) => {
        const li = document.createElement('li');
        li.append(cell(bullet.text), cell(' [' + bullet.basis + ']', 'chess-basis'));
        return li;
      });
      list(nodes.why, why, 'Nothing the engine can support with a computation.');
    },

    clearAnalysis(message) {
      text(nodes.headline, message);
      list(nodes.lines, [], 'Lines appear once the engine has searched this position.');
      list(nodes.why, [], 'Reasons appear with the computation that produced them.');
    },

    setReview(review) {
      if (!review) {
        text(nodes.reviewLabel, 'not reviewed');
        text(nodes.reviewDetail, 'Play or enter a move and it will be compared with the engine pick.');
        return;
      }
      text(nodes.reviewLabel, review.label);
      if (nodes.reviewLabel) nodes.reviewLabel.dataset.label = review.label;
      const better = review.label === 'best' || !review.bestSan
        ? 'the engine agrees.'
        : 'the engine preferred ' + review.bestSan +
          (review.bestPv.length > 1 ? ' (' + review.bestPv.slice(0, 4).join(' ') + ')' : '') +
          ', worth ' + (review.lostCp / 100).toFixed(2) + '.';
      text(nodes.reviewDetail, review.playedSan + ': ' + better);
    },

    setFen(fen) { if (nodes.fen && document.activeElement !== nodes.fen) nodes.fen.value = fen; },

    pgn(sans, startTurn, startFull) { return moveListToPgn(sans, startTurn, startFull); },
  };
}

function cell(value, className) {
  const span = document.createElement('span');
  if (className) span.className = className;
  span.textContent = value;
  return span;
}
