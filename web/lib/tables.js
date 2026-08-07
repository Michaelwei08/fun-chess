// tables.js -- static data shared by the rule set: piece codes, 0x88 offsets,
// zobrist keys, and the from-scratch rehash. Data only; the rules live in
// rules.js, which is the single source of truth (docs/CONTRACT.md).

export const EMPTY = 0;
export const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
export const WHITE = 0, BLACK = 1;
export const typeOf = (p) => p & 7;
export const colorOf = (p) => p >> 3;

// Knight offsets; king/queen offsets; bishop offsets; rook offsets. On a 0x88
// board a wrapped square always fails the (sq & 0x88) test, so no rank/file
// arithmetic is needed to keep moves on the board.
export const N_OFF = [33, 31, 18, 14, -33, -31, -18, -14];
export const K_OFF = [16, 17, 1, -15, -16, -17, -1, 15];
export const B_OFF = [17, 15, -17, -15];
export const R_OFF = [16, 1, -16, -1];

// Castling rights that survive a piece leaving or landing on a square.
export const CASTLE_MASK = new Int32Array(128).fill(15);
CASTLE_MASK[4] = 12; CASTLE_MASK[0] = 13; CASTLE_MASK[7] = 14;
CASTLE_MASK[116] = 3; CASTLE_MASK[112] = 7; CASTLE_MASK[119] = 11;

// Zobrist keys, split into two int32 halves. The generator is a fixed-seed
// xorshift32, so keys are identical in every run, in node and in the browser.
export const ZP_LO = new Int32Array(15 * 128), ZP_HI = new Int32Array(15 * 128);
export const ZC_LO = new Int32Array(16), ZC_HI = new Int32Array(16);
export const ZE_LO = new Int32Array(128), ZE_HI = new Int32Array(128);
export const ZT = new Int32Array(2);
(function initZobrist() {
  let s = 0x9e3779b9 >>> 0;
  const rnd = () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s | 0;
  };
  for (let i = 0; i < ZP_LO.length; i++) { ZP_LO[i] = rnd(); ZP_HI[i] = rnd(); }
  for (let i = 0; i < 16; i++) { ZC_LO[i] = rnd(); ZC_HI[i] = rnd(); }
  for (let i = 0; i < 128; i++) { ZE_LO[i] = rnd(); ZE_HI[i] = rnd(); }
  ZT[0] = rnd(); ZT[1] = rnd();
})();

// Recompute both hash halves from the board. makeMove/unmakeMove maintain the
// same value incrementally; a test asserts the two never disagree.
export function rehash(pos) {
  let lo = 0, hi = 0;
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const sq = r * 16 + f, p = pos.board[sq];
      if (p) { const i = p * 128 + sq; lo ^= ZP_LO[i]; hi ^= ZP_HI[i]; }
    }
  }
  if (pos.turn === BLACK) { lo ^= ZT[0]; hi ^= ZT[1]; }
  lo ^= ZC_LO[pos.castling]; hi ^= ZC_HI[pos.castling];
  if (pos.ep >= 0) { lo ^= ZE_LO[pos.ep]; hi ^= ZE_HI[pos.ep]; }
  pos.hashLo = lo | 0; pos.hashHi = hi | 0;
  return pos;
}
