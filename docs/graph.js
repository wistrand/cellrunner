// Pure ES module: the edge graph of a Voronoi diagram (vertices and edges), shortest paths and
// nearest-edge queries. No DOM. Used by world.js and scripts/graph-test.js.
//
// Identity survives motion. A Voronoi vertex is where three regions meet, so it is keyed by the
// sorted triple of the tags that meet there (site indices, or BOX_* sides). An edge is the
// bisector between two regions, keyed by the sorted pair. When sites drift, the same keys name
// the same features until a topological flip removes them, which lets entities stay attached to
// "their" edge across a rebuild.

// Sorted without allocating: three compare-and-swaps, hot in buildGraph.
export function nodeKey(a, b, c) {
  let t;
  if (a > b) { t = a; a = b; b = t; }
  if (b > c) { t = b; b = c; c = t; }
  if (a > b) { t = a; a = b; b = t; }
  return a + "," + b + "," + c;
}

export function edgeKey(a, b) {
  return a < b ? a + "," + b : b + "," + a;
}

// Returns `{ nodes: Map, edges: Map, nodeList: node[] }`.
// node: `{ key, x, y, idx, edges: string[] }`, edge: `{ key, a, b, length, cells: number[] }`.
// `cells` holds the tags (site ids) of the one or two cells the edge borders, ascending.
export function buildGraph(diagram) {
  const nodes = new Map();
  const edges = new Map();
  const cells = diagram.cells;
  for (let c = 0; c < cells.length; c++) {
    const i = cells[c].id;
    const poly = cells[c].polygon;
    const n = poly.length;
    if (n === 0) continue; // a degenerate cell has no vertices to register
    // Walking the polygon, vertex k's in-edge is vertex k-1's out-edge and the far end of its
    // out-edge is vertex k+1's node, so each key is built once and carried to the next step.
    let inKey = edgeKey(i, poly[n - 1].tag);
    let nk = nodeKey(i, poly[n - 1].tag, poly[0].tag);
    for (let k = 0; k < n; k++) {
      const v = poly[k];
      const next = poly[k + 1 === n ? 0 : k + 1];
      let node = nodes.get(nk);
      if (!node) {
        node = { key: nk, x: v.x, y: v.y, idx: nodes.size, edges: [] };
        nodes.set(nk, node);
      }
      const outKey = edgeKey(i, v.tag);
      if (!node.edges.includes(inKey)) node.edges.push(inKey);
      if (!node.edges.includes(outKey)) node.edges.push(outKey);
      const nextNk = nodeKey(i, v.tag, next.tag);
      if (!edges.has(outKey)) {
        const cellsOf = v.tag >= 0 ? [Math.min(i, v.tag), Math.max(i, v.tag)] : [i];
        edges.set(outKey, { key: outKey, a: nk, b: nextNk, length: 0, cells: cellsOf });
      }
      inKey = outKey;
      nk = nextNk;
    }
  }
  for (const e of edges.values()) {
    const a = nodes.get(e.a);
    const b = nodes.get(e.b);
    e.length = Math.hypot(b.x - a.x, b.y - a.y);
  }
  return { nodes, edges, nodeList: [...nodes.values()] };
}

// True for a vertex on the bounding box: its sorted key starts with a negative BOX_* tag.
export function isBorderNode(key) {
  return key.charCodeAt(0) === 45; // "-"
}

export function otherEnd(edge, nodeKeyFrom) {
  return edge.a === nodeKeyFrom ? edge.b : edge.a;
}

// Dijkstra from `sourceKey`. Returns Float64Array indexed by node.idx; Infinity when unreachable
// or when the source is missing. Binary heap with lazy deletion.
// Optional `skip(edge)` leaves out edges it returns true for, as if they were not in the graph.
// Optional `maxDist` stops the search there: nodes farther than that stay at Infinity, exactly
// as if unreachable, so a caller that only needs the neighbourhood pays for the neighbourhood.
//
// The heap lives in two module-level typed arrays reused across calls (grown when a graph
// outsizes them), so a search allocates only its result. Pushes are bounded by the number of
// relaxations, at most one per directed edge plus the source.
let HEAP_D = new Float64Array(1 << 12);
let HEAP_I = new Int32Array(1 << 12);
export function shortestPaths(graph, sourceKey, skip, maxDist = Infinity) {
  const N = graph.nodeList.length;
  const dist = new Float64Array(N).fill(Infinity);
  const src = graph.nodes.get(sourceKey);
  if (!src) return dist;
  const need = 2 * graph.edges.size + 1;
  if (HEAP_D.length < need) {
    let size = HEAP_D.length;
    while (size < need) size *= 2;
    HEAP_D = new Float64Array(size);
    HEAP_I = new Int32Array(size);
  }
  const hd = HEAP_D;
  const hi = HEAP_I;
  let size = 0;
  const nodeList = graph.nodeList;
  const nodesByKey = graph.nodes;
  const edgesByKey = graph.edges;
  dist[src.idx] = 0;
  hd[0] = 0;
  hi[0] = src.idx;
  size = 1;
  while (size > 0) {
    // Pop the minimum.
    const d = hd[0];
    const u = hi[0];
    size--;
    if (size > 0) {
      const ld = hd[size];
      const li = hi[size];
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        if (l >= size) break;
        const r = l + 1;
        const m = r < size && hd[r] < hd[l] ? r : l;
        if (hd[m] >= ld) break;
        hd[k] = hd[m];
        hi[k] = hi[m];
        k = m;
      }
      hd[k] = ld;
      hi[k] = li;
    }
    if (d > dist[u]) continue;
    if (d > maxDist) break;
    const node = nodeList[u];
    for (const ek of node.edges) {
      const e = edgesByKey.get(ek);
      if (skip && skip(e)) continue;
      const o = nodesByKey.get(otherEnd(e, node.key));
      const nd = d + e.length;
      if (nd < dist[o.idx] && nd <= maxDist) {
        dist[o.idx] = nd;
        // Push: sift up from the end.
        let k = size++;
        while (k > 0) {
          const p = (k - 1) >> 1;
          if (hd[p] <= nd) break;
          hd[k] = hd[p];
          hi[k] = hi[p];
          k = p;
        }
        hd[k] = nd;
        hi[k] = o.idx;
      }
    }
  }
  return dist;
}

// The edge leaving `fromKey` that descends `dist` fastest (the next step of a shortest path to
// the source `dist` was computed from). `skip(edge)` excludes edges as in `shortestPaths`; pass
// the same predicate `dist` was computed with. Falls back to any edge not skipped, then to any
// edge at all, so a walker is never stranded. Null only for an unknown or isolated node.
export function nextEdgeToward(graph, fromKey, dist, skip) {
  const node = graph.nodes.get(fromKey);
  if (!node) return null;
  let best = null;
  let bestD = Infinity;
  let open = null;
  for (const ek of node.edges) {
    const e = graph.edges.get(ek);
    if (skip && skip(e)) continue;
    if (!open) open = ek;
    const o = graph.nodes.get(otherEnd(e, fromKey));
    const d = dist[o.idx] + e.length;
    if (d < bestD) {
      bestD = d;
      best = ek;
    }
  }
  return best || open || node.edges[0] || null;
}

// Closest point on any edge to (x, y). Returns `{ edge, t, x, y, d2 }` with t measured from
// edge.a to edge.b. Null for an empty graph.
// Optional `skip(edge)` leaves edges out of the search; null if every edge is skipped.
export function nearestEdgePoint(graph, x, y, skip) {
  let best = null;
  for (const e of graph.edges.values()) {
    if (skip && skip(e)) continue;
    const a = graph.nodes.get(e.a);
    const b = graph.nodes.get(e.b);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((x - a.x) * dx + (y - a.y) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = a.x + dx * t;
    const py = a.y + dy * t;
    const d2 = (px - x) * (px - x) + (py - y) * (py - y);
    if (!best || d2 < best.d2) best = { edge: e, t, x: px, y: py, d2 };
  }
  return best;
}

// Optional `filter(node)` restricts candidates; returns null if nothing passes.
export function nearestNode(graph, x, y, filter) {
  let best = null;
  let bestD = Infinity;
  for (const n of graph.nodeList) {
    if (filter && !filter(n)) continue;
    const d = (n.x - x) * (n.x - x) + (n.y - y) * (n.y - y);
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}
