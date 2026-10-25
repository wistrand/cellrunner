// Pure ES module: seeded 2D simplex noise (Gustavson's formulation). Output in roughly [-1, 1].
// Used by world.js for the initial cell density field; small enough to inline, kept separate so
// other features (audio, visuals) can share one implementation.

const GRAD = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
];
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

// Returns a function noise(x, y). The permutation table is shuffled from the seed with a small
// LCG so the same seed always gives the same field.
export function createSimplex2D(seed) {
  const perm = new Uint8Array(512);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let s = (seed >>> 0) || 1;
  for (let i = 255; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  return function noise(x, y) {
    const sk = (x + y) * F2;
    const i = Math.floor(x + sk);
    const j = Math.floor(y + sk);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = 1 - i1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    let n = 0;
    let c = 0.5 - x0 * x0 - y0 * y0;
    if (c > 0) {
      const g = GRAD[perm[ii + perm[jj]] & 7];
      c *= c;
      n += c * c * (g[0] * x0 + g[1] * y0);
    }
    c = 0.5 - x1 * x1 - y1 * y1;
    if (c > 0) {
      const g = GRAD[perm[ii + i1 + perm[jj + j1]] & 7];
      c *= c;
      n += c * c * (g[0] * x1 + g[1] * y1);
    }
    c = 0.5 - x2 * x2 - y2 * y2;
    if (c > 0) {
      const g = GRAD[perm[ii + 1 + perm[jj + 1]] & 7];
      c *= c;
      n += c * c * (g[0] * x2 + g[1] * y2);
    }
    return 70 * n;
  };
}
