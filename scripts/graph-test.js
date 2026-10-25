// Node test runner for docs/graph.js. Run via `npm test`.

import { computeVoronoi, jitteredSites, mulberry32 } from "../docs/voronoi.js";
import { buildGraph, shortestPaths, nextEdgeToward, nearestEdgePoint, nearestNode, otherEnd,
  isBorderNode } from "../docs/graph.js";

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    failures++;
    console.error("FAIL:", msg);
  }
}

const bounds = { x: 0, y: 0, w: 800, h: 600 };

for (const seed of [1, 7, 12345, 0xdeadbeef]) {
  const sites = jitteredSites(bounds, 12, 9, mulberry32(seed));
  const diagram = computeVoronoi(sites, bounds);
  const g = buildGraph(diagram);
  const V = g.nodes.size;
  const E = g.edges.size;
  const F = diagram.cells.length + 1;
  // Euler's formula for a connected planar graph. Fails if vertex or edge keys are not unique
  // across the cells that share them.
  check(V - E + F === 2, `seed ${seed}: Euler V-E+F=2 (V=${V} E=${E} F=${F})`);

  for (const n of g.nodeList) {
    check(n.edges.length >= 2, `seed ${seed}: node ${n.key} degree >= 2`);
    for (const ek of n.edges) {
      const e = g.edges.get(ek);
      check(!!e, `seed ${seed}: node ${n.key} references existing edge ${ek}`);
      if (e) check(e.a === n.key || e.b === n.key, `seed ${seed}: edge ${ek} lists node ${n.key}`);
    }
  }
  for (const e of g.edges.values()) {
    check(g.nodes.has(e.a) && g.nodes.has(e.b), `seed ${seed}: edge ${e.key} endpoints exist`);
    check(e.length > 1e-6, `seed ${seed}: edge ${e.key} has positive length`);
    check(e.a !== e.b, `seed ${seed}: edge ${e.key} is not a loop`);
  }

  // Connected: every node reachable from the first.
  const dist = shortestPaths(g, g.nodeList[0].key);
  check(dist.every((d) => Number.isFinite(d)), `seed ${seed}: graph connected`);

  // Greedy descent along nextEdgeToward reaches the source.
  let cur = g.nodeList[g.nodeList.length - 1].key;
  let steps = 0;
  while (cur !== g.nodeList[0].key && steps < 1000) {
    const ek = nextEdgeToward(g, cur, dist);
    cur = otherEnd(g.edges.get(ek), cur);
    steps++;
  }
  check(cur === g.nodeList[0].key, `seed ${seed}: greedy descent reaches source in ${steps}`);

  // Nearest-edge query at a node returns an incident edge at an endpoint.
  const n = g.nodeList[Math.floor(V / 2)];
  const hit = nearestEdgePoint(g, n.x, n.y);
  check(hit.d2 < 1e-9 && (hit.edge.a === n.key || hit.edge.b === n.key),
    `seed ${seed}: nearestEdgePoint at a node hits an incident edge`);
  check(nearestNode(g, n.x + 0.01, n.y - 0.01).key === n.key, `seed ${seed}: nearestNode`);

  // Border classification matches geometry: a border node sits on the box, an interior one doesn't.
  const onBox = (p) => Math.min(p.x, p.y, bounds.w - p.x, bounds.h - p.y) < 1e-6;
  for (const node of g.nodeList) {
    check(isBorderNode(node.key) === onBox(node), `seed ${seed}: border flag for ${node.key}`);
  }
  check(g.nodeList.some((node) => !isBorderNode(node.key)), `seed ${seed}: interior nodes exist`);

  // Stability under small motion: most edge keys survive a tiny site perturbation.
  const moved = sites.map((s, i) => ({ x: s.x + Math.sin(i) * 0.5, y: s.y + Math.cos(i) * 0.5 }));
  const g2 = buildGraph(computeVoronoi(moved, bounds));
  let kept = 0;
  for (const k of g.edges.keys()) if (g2.edges.has(k)) kept++;
  check(kept / E > 0.95, `seed ${seed}: ${kept}/${E} edge keys survive a small perturbation`);
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("graph: all checks passed");
