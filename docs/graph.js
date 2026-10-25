// Pure ES module: the edge graph of a Voronoi diagram (vertices and edges), shortest paths and
// nearest-edge queries. No DOM. Used by world.js and scripts/graph-test.js.
//
// Identity survives motion. A Voronoi vertex is where three regions meet, so it is keyed by the
// sorted triple of the tags that meet there (site indices, or BOX_* sides). An edge is the
// bisector between two regions, keyed by the sorted pair. When sites drift, the same keys name
// the same features until a topological flip removes them, which lets entities stay attached to
// "their" edge across a rebuild.

export function nodeKey(a, b, c) {
  const arr = [a, b, c].sort((p, q) => p - q);
  return arr[0] + "," + arr[1] + "," + arr[2];
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
    for (let k = 0; k < n; k++) {
      const prev = poly[(k - 1 + n) % n];
      const v = poly[k];
      const next = poly[(k + 1) % n];
      const nk = nodeKey(i, prev.tag, v.tag);
      let node = nodes.get(nk);
      if (!node) {
        node = { key: nk, x: v.x, y: v.y, idx: nodes.size, edges: [] };
        nodes.set(nk, node);
      }
      const inKey = edgeKey(i, prev.tag);
      const outKey = edgeKey(i, v.tag);
      if (!node.edges.includes(inKey)) node.edges.push(inKey);
      if (!node.edges.includes(outKey)) node.edges.push(outKey);
      if (!edges.has(outKey)) {
        const cellsOf = v.tag >= 0 ? [Math.min(i, v.tag), Math.max(i, v.tag)] : [i];
        edges.set(outKey, { key: outKey, a: nk, b: nodeKey(i, v.tag, next.tag), length: 0, cells: cellsOf });
      }
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
export function shortestPaths(graph, sourceKey) {
  const N = graph.nodeList.length;
  const dist = new Float64Array(N).fill(Infinity);
  const src = graph.nodes.get(sourceKey);
  if (!src) return dist;
  const hd = [];
  const hi = [];
  const push = (d, i) => {
    let k = hd.length;
    hd.push(d);
    hi.push(i);
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (hd[p] <= hd[k]) break;
      [hd[p], hd[k]] = [hd[k], hd[p]];
      [hi[p], hi[k]] = [hi[k], hi[p]];
      k = p;
    }
  };
  const pop = () => {
    const d = hd[0];
    const i = hi[0];
    const ld = hd.pop();
    const li = hi.pop();
    if (hd.length) {
      hd[0] = ld;
      hi[0] = li;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < hd.length && hd[l] < hd[m]) m = l;
        if (r < hd.length && hd[r] < hd[m]) m = r;
        if (m === k) break;
        [hd[m], hd[k]] = [hd[k], hd[m]];
        [hi[m], hi[k]] = [hi[k], hi[m]];
        k = m;
      }
    }
    return [d, i];
  };
  dist[src.idx] = 0;
  push(0, src.idx);
  while (hd.length) {
    const [d, u] = pop();
    if (d > dist[u]) continue;
    const node = graph.nodeList[u];
    for (const ek of node.edges) {
      const e = graph.edges.get(ek);
      const o = graph.nodes.get(otherEnd(e, node.key));
      const nd = d + e.length;
      if (nd < dist[o.idx]) {
        dist[o.idx] = nd;
        push(nd, o.idx);
      }
    }
  }
  return dist;
}

// The edge leaving `fromKey` that descends `dist` fastest (the next step of a shortest path to
// the source `dist` was computed from). Null only for an unknown node.
export function nextEdgeToward(graph, fromKey, dist) {
  const node = graph.nodes.get(fromKey);
  if (!node) return null;
  let best = null;
  let bestD = Infinity;
  for (const ek of node.edges) {
    const e = graph.edges.get(ek);
    const o = graph.nodes.get(otherEnd(e, fromKey));
    const d = dist[o.idx] + e.length;
    if (d < bestD) {
      bestD = d;
      best = ek;
    }
  }
  return best || node.edges[0] || null;
}

// Closest point on any edge to (x, y). Returns `{ edge, t, x, y, d2 }` with t measured from
// edge.a to edge.b. Null for an empty graph.
export function nearestEdgePoint(graph, x, y) {
  let best = null;
  for (const e of graph.edges.values()) {
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
