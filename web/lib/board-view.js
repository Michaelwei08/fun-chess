// board-view.js -- the 64 squares: build, paint, and report taps.
// It knows nothing about whose turn it is or what a legal move is; it is handed
// a position and a set of highlighted squares and draws exactly that.

import { colorOf, typeOf, squareName, parseSquare, WHITE } from './rules.js';
import { glyphFor, pieceName } from './notation.js';

const FILES = 'abcdefgh';

export function createBoardView(root, onSquare) {
  let orientation = WHITE;
  let squares = new Map();

  function build() {
    root.textContent = '';
    squares = new Map();
    const ranks = orientation === WHITE ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
    const files = orientation === WHITE ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
    for (const r of ranks) {
      for (const f of files) {
        const sq = r * 16 + f, name = squareName(sq);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'chess-square ' + ((r + f) % 2 ? 'light' : 'dark');
        button.dataset.square = name;
        // Coordinates ride on the edge squares so flipping needs no markup.
        if (f === files[0]) {
          const tag = document.createElement('span');
          tag.className = 'chess-coord chess-coord-rank';
          tag.textContent = String(r + 1);
          button.appendChild(tag);
        }
        if (r === ranks[7]) {
          const tag = document.createElement('span');
          tag.className = 'chess-coord chess-coord-file';
          tag.textContent = FILES[f];
          button.appendChild(tag);
        }
        const glyph = document.createElement('span');
        glyph.className = 'chess-glyph';
        button.appendChild(glyph);
        root.appendChild(button);
        squares.set(name, { button, glyph, sq });
      }
    }
  }

  root.addEventListener('click', (event) => {
    const button = event.target.closest('button.chess-square');
    if (button && root.contains(button)) onSquare(button.dataset.square);
  });

  build();

  return {
    get orientation() { return orientation; },
    flip() { orientation ^= 1; build(); },
    setOrientation(side) { if (side !== orientation) { orientation = side; build(); } },
    render(pos, view = {}) {
      const selected = view.selected || '';
      const targets = view.targets || new Map();
      const last = view.lastMove || [];
      const check = view.checkSquare || '';
      for (const [name, cell] of squares) {
        const piece = pos.board[parseSquare(name)];
        const isTarget = targets.has(name);
        cell.glyph.textContent = glyphFor(piece);
        cell.button.dataset.piece = piece ? typeOf(piece) : '';
        cell.button.dataset.color = piece ? (colorOf(piece) === WHITE ? 'w' : 'b') : '';
        cell.button.classList.toggle('is-white', Boolean(piece) && colorOf(piece) === WHITE);
        cell.button.classList.toggle('is-selected', name === selected);
        cell.button.classList.toggle('is-target', isTarget && !piece);
        cell.button.classList.toggle('is-capture', isTarget && Boolean(piece));
        cell.button.classList.toggle('is-last', last.includes(name));
        cell.button.classList.toggle('is-check', name === check);
        cell.button.disabled = Boolean(view.frozen);
        const what = piece ? pieceName(piece) : 'empty';
        cell.button.setAttribute('aria-label',
          name + ', ' + what + (isTarget ? ', can move here' : '') + (name === check ? ', in check' : ''));
      }
    },
  };
}

// The promotion dialog is part of the board interaction, so it lives here too:
// it resolves to a piece letter, or to null if the player backs out.
export function askPromotion(dialog, color) {
  return new Promise((resolve) => {
    if (!dialog) { resolve('q'); return; }
    dialog.hidden = false;
    dialog.classList.toggle('is-white', color === WHITE);
    const buttons = [...dialog.querySelectorAll('button[data-promo]')];
    const finish = (value) => {
      dialog.hidden = true;
      for (const button of buttons) button.removeEventListener('click', handlers.get(button));
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const handlers = new Map();
    for (const button of buttons) {
      const handler = () => finish(button.dataset.promo);
      handlers.set(button, handler);
      button.addEventListener('click', handler);
    }
    const onKey = (event) => { if (event.key === 'Escape') finish(null); };
    document.addEventListener('keydown', onKey);
    if (buttons[0]) buttons[0].focus();
  });
}
