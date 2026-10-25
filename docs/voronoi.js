// Pure ES module: Voronoi tessellation of a point set clipped to a rectangle, plus cell
// adjacency. No DOM. Used by the browser (main.js) and the node test runner
// (scripts/voronoi-test.js).
//
// Algorithm: per-site half-plane clipping. Each cell starts as the bounding rectangle and is
// clipped by the perpendicular bisector against other sites, nearest first. A bisector against a
// site farther than twice the cell's current circumradius cannot cut the cell. Candidates come
// from a uniform bucket grid, visited in rings of increasing distance, so each site touches only
// its neighbourhood and the whole build is close to linear in site count. Simple and robust
// against degenerate inputs.

const EPS = 1e-9;
const MERGE_EPS = 1e-7;

// Tags for the four bounding-box sides. Negative and distinct so a vertex can be identified by
// the three tags that meet there even at a box corner (see graph.js).
export const BOX_LEFT = -1;
export const BOX_TOP = -2;
export const BOX_RIGHT = -3;
export const BOX_BOTTOM = -4;

// Deterministic 32-bit PRNG so a seed reproduces the same field everywhere.
export function mulberry32(seed) {
  let a = seed >>> 0;
  function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  // The state, so a world saved mid-run resumes its draw sequence exactly (world.js save/restore).
  rand.getState = () => a;
  rand.setState = (s) => { a = s >>> 0; };
  return rand;
}

// Jittered-grid site placement: one site per grid square, offset randomly within the square's
// inner `1 - 2 * margin` fraction. Gives even cell sizes without Poisson-disc sampling.
export function jitteredSites(bounds, cols, rows, rand, margin = 0.15) {
  const { x, y, w, h } = bounds;
  const cw = w / cols;
  const ch = h / rows;
  const sites = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const jx = margin + rand() * (1 - 2 * margin);
      const jy = margin + rand() * (1 - 2 * margin);
      sites.push({ x: x + (c + jx) * cw, y: y + (r + jy) * ch });
    }
  }
  return sites;
}

// Clipper scratch, reused across cells and across calls so a rebuild allocates only what it
// returns. Two vertex arrays ping-pong between clips (a clip reads one and writes the other) and
// hold their live length separately, since stale entries past it are left in place. Vertex
// objects come from a pool that is reset per cell: a cell's working vertices live only until
// `finishCell` copies the survivors into fresh objects, so nothing returned aliases the pool,
// and the pool never grows past the most vertices one cell ever created. `computeVoronoi` is
// therefore not re-entrant; nothing calls it recursively.
const POLY_A = [];
const POLY_B = [];
const VPOOL = [];
let vTop = 0;
function vertex(x, y, tag) {
  let v = VPOOL[vTop];
  if (v === undefined) {
    v = { x: 0, y: 0, tag: 0 };
    VPOOL.push(v);
  }
  vTop++;
  v.x = x;
  v.y = y;
  v.tag = tag;
  return v;
}

// Clip the convex polygon in `src[0..n)` to the half-plane nx*x + ny*y <= c, writing the result
// into `dst` and returning its length. `src` and `dst` must be different arrays.
// `tag` on a vertex identifies the edge that starts at that vertex: a BOX_* side for a
// bounding-box edge, otherwise the index of the site whose bisector produced it. Vertices
// introduced on the clip line carry `tag` for the new edge; vertices where the polygon re-enters
// keep the original edge's tag. This is how adjacency falls out of the clipping for free.
function clipHalfPlane(src, n, dst, nx, ny, c, tag) {
  let m = 0;
  for (let i = 0; i < n; i++) {
    const a = src[i];
    const b = src[i + 1 === n ? 0 : i + 1];
    const da = nx * a.x + ny * a.y - c;
    const db = nx * b.x + ny * b.y - c;
    const aIn = da <= EPS;
    const bIn = db <= EPS;
    if (aIn) dst[m++] = a;
    if (aIn !== bIn) {
      const t = da / (da - db);
      dst[m++] = vertex(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, aIn ? tag : a.tag);
    }
  }
  return m;
}

function circumradius2(site, poly, n) {
  let m = 0;
  for (let i = 0; i < n; i++) {
    const v = poly[i];
    const dx = v.x - site.x;
    const dy = v.y - site.y;
    const d = dx * dx + dy * dy;
    if (d > m) m = d;
  }
  return m;
}

// Build the Voronoi diagram. Returns `{ sites, bounds, cells }` where cells[i] is
// `{ id, site, polygon: [{x,y,tag}], neighbors: number[], area, centroid: {x,y} }`.
// A site's tag is `site.id` when present, else its index. Tags must be unique non-negative
// integers. `polygon[k].tag` identifies the edge from vertex k to k+1 (site tag or BOX_* side);
// `neighbors` holds the tags of cells sharing a bisector edge, ascending, no duplicates; `id` is
// the cell's own tag. Stable ids let graph keys survive site insertion and removal.
export function computeVoronoi(sites, bounds) {
  const n = sites.length;
  const { x, y, w, h } = bounds;
  const tags = new Array(n);
  for (let i = 0; i < n; i++) tags[i] = sites[i].id ?? i;

  // Bucket grid sized for a couple of sites per bucket.
  const bs = Math.max(1e-6, Math.sqrt((w * h) / Math.max(1, n)) * 1.5);
  const bc = Math.max(1, Math.ceil(w / bs));
  const br = Math.max(1, Math.ceil(h / bs));
  const buckets = new Array(bc * br);
  const col = new Int32Array(n);
  const row = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const cx = Math.min(bc - 1, Math.max(0, Math.floor((sites[i].x - x) / bs)));
    const cy = Math.min(br - 1, Math.max(0, Math.floor((sites[i].y - y) / bs)));
    col[i] = cx;
    row[i] = cy;
    const b = cy * bc + cx;
    (buckets[b] || (buckets[b] = [])).push(i);
  }
  const maxRing = Math.max(bc, br);
  const cand = [];

  const cells = new Array(n);
  for (let i = 0; i < n; i++) {
    const s = sites[i];
    vTop = 0;
    let poly = POLY_A;
    let other = POLY_B;
    let len = 4;
    poly[0] = vertex(x, y, BOX_TOP);
    poly[1] = vertex(x + w, y, BOX_RIGHT);
    poly[2] = vertex(x + w, y + h, BOX_BOTTOM);
    poly[3] = vertex(x, y + h, BOX_LEFT);
    let r2 = circumradius2(s, poly, len);
    const cx0 = col[i];
    const cy0 = row[i];
    for (let k = 0; k <= maxRing; k++) {
      // Every site in ring k or beyond is at least (k - 1) buckets away; once that exceeds the
      // cutting range no remaining site can touch the polygon.
      const lower = (k - 1) * bs;
      if (k > 0 && lower * lower >= 4 * r2) break;
      cand.length = 0;
      const yA = cy0 - k;
      const yB = cy0 + k;
      const xA = cx0 - k;
      const xB = cx0 + k;
      const visit = (cx, cy) => {
        const b = buckets[cy * bc + cx];
        if (b) for (const j of b) if (j !== i) cand.push(j);
      };
      for (let cy = Math.max(0, yA); cy <= Math.min(br - 1, yB); cy++) {
        if (cy === yA || cy === yB) {
          for (let cx = Math.max(0, xA); cx <= Math.min(bc - 1, xB); cx++) visit(cx, cy);
        } else {
          if (xA >= 0) visit(xA, cy);
          if (xB < bc && xB !== xA) visit(xB, cy);
        }
      }
      if (cand.length === 0) continue;
      // Nearest-first within the ring so the radius shrinks early.
      cand.sort((a, b) => dist2(sites[a], s) - dist2(sites[b], s));
      for (const j of cand) {
        const o = sites[j];
        const d2 = dist2(o, s);
        // Bisector at distance sqrt(d2)/2 from s; polygon fits inside radius sqrt(r2).
        if (d2 > 4 * r2) continue;
        const nx = o.x - s.x;
        const ny = o.y - s.y;
        const c = nx * (s.x + o.x) * 0.5 + ny * (s.y + o.y) * 0.5;
        len = clipHalfPlane(poly, len, other, nx, ny, c, tags[j]);
        const t = poly;
        poly = other;
        other = t;
        r2 = circumradius2(s, poly, len);
      }
    }
    cells[i] = finishCell(s, poly, len, tags[i]);
  }
  return { sites, bounds, cells };
}

function dist2(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

// `raw[0..n)` is clipper scratch; everything returned is freshly allocated.
function finishCell(site, raw, n, id) {
  // Drop zero-length edges: when a clip line passes through an existing vertex the polygon gets
  // two coincident vertices. Dropping the first keeps the second's tag, which is the real
  // outgoing edge. Without this the edge graph would contain zero-length edges.
  const polygon = [];
  for (let k = 0; k < n; k++) {
    const v = raw[k];
    const w = raw[k + 1 === n ? 0 : k + 1];
    if (Math.abs(v.x - w.x) < MERGE_EPS && Math.abs(v.y - w.y) < MERGE_EPS) continue;
    polygon.push({ x: v.x, y: v.y, tag: v.tag });
  }
  // Neighbours: the site tags on the surviving vertices, ascending, no duplicates.
  const neighbors = [];
  for (const v of polygon) if (v.tag >= 0) neighbors.push(v.tag);
  neighbors.sort((a, b) => a - b);
  let kept = 0;
  for (let i = 0; i < neighbors.length; i++) {
    if (i === 0 || neighbors[i] !== neighbors[i - 1]) neighbors[kept++] = neighbors[i];
  }
  neighbors.length = kept;
  // Shoelace area + centroid.
  let area = 0;
  let cx = 0;
  let cy = 0;
  const m = polygon.length;
  for (let i = 0; i < m; i++) {
    const a = polygon[i];
    const b = polygon[i + 1 === m ? 0 : i + 1];
    const cross = a.x * b.y - b.x * a.y;
    area += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  area *= 0.5;
  const inv = area !== 0 ? 1 / (6 * area) : 0;
  return { id, site, polygon, neighbors, area: Math.abs(area),
    centroid: { x: cx * inv, y: cy * inv } };
}

// Index of the cell containing (px, py): by definition the nearest site. Linear scan; fine for a
// screen's worth of sites. Returns -1 for an empty diagram.
export function cellAt(diagram, px, py) {
  const { sites } = diagram;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < sites.length; i++) {
    const d = dist2(sites[i], { x: px, y: py });
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

// Among `from`'s neighbors, the one whose direction from `from` best matches (dx, dy).
// Returns -1 when no neighbor lies within 90 degrees of the direction.
export function neighborToward(diagram, from, dx, dy) {
  const len = Math.hypot(dx, dy);
  if (len === 0) return -1;
  const ux = dx / len;
  const uy = dy / len;
  const s = diagram.sites[from];
  let best = -1;
  let bestDot = 0;
  for (const j of diagram.cells[from].neighbors) {
    const o = diagram.sites[j];
    const ox = o.x - s.x;
    const oy = o.y - s.y;
    const ol = Math.hypot(ox, oy);
    const dot = (ox * ux + oy * uy) / ol;
    if (dot > bestDot) {
      bestDot = dot;
      best = j;
    }
  }
  return best;
}
