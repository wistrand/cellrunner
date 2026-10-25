// Node test runner for docs/voronoi.js. Run with `npm test`. Exits non-zero on first failure.

import { computeVoronoi, jitteredSites, mulberry32, cellAt, neighborToward } from "../docs/voronoi.js";

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    failures++;
    console.error("FAIL:", msg);
  }
}

function pointInConvexPolygon(p, poly) {
  // Polygon is clockwise or counter-clockwise; require all cross products to share a sign.
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(cross) < 1e-9) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

const bounds = { x: 0, y: 0, w: 800, h: 600 };

for (const seed of [1, 7, 12345, 0xdeadbeef]) {
  const rand = mulberry32(seed);
  const sites = jitteredSites(bounds, 12, 9, rand);
  const diagram = computeVoronoi(sites, bounds);
  const { cells } = diagram;

  check(cells.length === sites.length, `seed ${seed}: one cell per site`);

  let totalArea = 0;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    totalArea += c.area;
    check(c.polygon.length >= 3, `seed ${seed}: cell ${i} has >= 3 vertices`);
    check(pointInConvexPolygon(c.site, c.polygon), `seed ${seed}: site ${i} inside its own cell`);
    check(c.neighbors.length >= 2, `seed ${seed}: cell ${i} has at least two neighbors`);
    for (const j of c.neighbors) {
      check(j !== i, `seed ${seed}: cell ${i} is not its own neighbor`);
      check(cells[j].neighbors.includes(i), `seed ${seed}: adjacency ${i}<->${j} symmetric`);
    }
    check(cellAt(diagram, c.site.x, c.site.y) === i, `seed ${seed}: cellAt(site ${i}) === ${i}`);
    check(cellAt(diagram, c.centroid.x, c.centroid.y) === i,
      `seed ${seed}: cellAt(centroid ${i}) === ${i}`);
  }
  const boxArea = bounds.w * bounds.h;
  check(Math.abs(totalArea - boxArea) < 1e-6 * boxArea,
    `seed ${seed}: cell areas tile the box (${totalArea} vs ${boxArea})`);

  // Direction query: moving straight up from a cell should pick a neighbor that is higher.
  for (let i = 0; i < cells.length; i++) {
    const up = neighborToward(diagram, i, 0, -1);
    if (up >= 0) check(sites[up].y < sites[i].y, `seed ${seed}: neighborToward up from ${i} is higher`);
  }

  // Determinism: same seed, same diagram.
  const again = computeVoronoi(jitteredSites(bounds, 12, 9, mulberry32(seed)), bounds);
  check(JSON.stringify(again.cells.map((c) => c.neighbors)) ===
        JSON.stringify(cells.map((c) => c.neighbors)), `seed ${seed}: deterministic`);
}

// Stable ids: tags come from site.id, so removing a site keeps the other cells' identities.
{
  const base = jitteredSites(bounds, 6, 5, mulberry32(42)).map((p, i) => ({ x: p.x, y: p.y, id: i * 10 }));
  const d1 = computeVoronoi(base, bounds);
  check(d1.cells.every((c, i) => c.id === i * 10), "ids: cell.id mirrors site.id");
  check(d1.cells.every((c) => c.neighbors.every((t) => t % 10 === 0)), "ids: neighbors are ids");
  const removed = base.slice();
  removed.splice(7, 1);
  const d2 = computeVoronoi(removed, bounds);
  const far = d2.cells.find((c) => c.id === 290);
  const farBefore = d1.cells.find((c) => c.id === 290);
  check(far && JSON.stringify(far.neighbors) === JSON.stringify(farBefore.neighbors),
    "ids: a far cell keeps its neighbour ids after a removal elsewhere");
}

// Degenerate: two sites split the box in half.
{
  const d = computeVoronoi([{ x: 200, y: 300 }, { x: 600, y: 300 }], bounds);
  check(Math.abs(d.cells[0].area - 240000) < 1e-6, "two sites: equal halves");
  check(d.cells[0].neighbors.length === 1 && d.cells[0].neighbors[0] === 1, "two sites: adjacent");
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("voronoi: all checks passed");
