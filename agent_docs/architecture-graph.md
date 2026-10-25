# Graph architecture

## Contents
- Overview
- Invariants
- Keys that survive motion
- Building the graph
- Shortest paths
- Queries
- Test coverage

## Overview

`docs/graph.js` turns a diagram from `voronoi.js` into the graph entities walk on: vertices
(nodes) and edges. It also provides Dijkstra and nearest-edge/nearest-node queries. Pure, no DOM.

**Key symbols**: `nodeKey`, `edgeKey`, `buildGraph`, `shortestPaths`, `nextEdgeToward`,
`nearestEdgePoint`, `nearestNode`, `otherEnd`, `isBorderNode`.

## Invariants

Global rules (keys from sites not coordinates, Euler's formula) are in CLAUDE.md. Module-local:

- `node.idx` is the index into `graph.nodeList`; `shortestPaths` results are indexed by it.
- `edge.a` and `edge.b` are node keys. Orientation is whichever cell registered the edge first;
  nothing may depend on it. Use `otherEnd`.
- `edge.cells` lists the one or two cell indices the edge borders, ascending.

## Keys that survive motion

A Voronoi vertex is equidistant from three regions, so it is named by the sorted triple of the
tags meeting there; an edge is the bisector of two regions, named by the sorted pair. Tags are
site ids (`cell.id`, see [architecture-voronoi.md](architecture-voronoi.md)) or the negative
`BOX_*` side constants from `voronoi.js`. Because ids are stable, inserting or removing a site
changes only the keys of features that geometrically changed. The box sides are distinct
so a box corner (two sides and one site) gets a unique key too.

Because keys come from topology, moving a site a little keeps every key; only a topological flip
(four sites becoming cocircular and swapping a Delaunay edge) removes an edge and creates another.
`world.js` relies on this to keep entities attached to their edge across per-frame rebuilds. The
graph test checks that nearly all edge keys survive a small perturbation.

## Building the graph

`buildGraph` walks every cell polygon once. Vertex k of cell i is keyed by
`(i, polygon[k-1].tag, polygon[k].tag)`; the edge from vertex k to k+1 by `(i, polygon[k].tag)`.
Shared vertices and edges hash to the same key from both sides, so no coordinate matching is
needed. Lengths are computed at the end from node positions. Zero-length edges don't occur
because `voronoi.js` merges coincident consecutive vertices first.

## Shortest paths

`shortestPaths(graph, sourceKey)` is Dijkstra with a binary heap and lazy deletion, returning
distances for every node. The world runs it three times per frame (from the goal, from the
player's anchor, from the stalkers' intercept vertex) and again after any board change; at several
hundred vertices it is well under a millisecond.

`nextEdgeToward(graph, fromKey, dist)` picks the incident edge minimising `dist[other] + length`,
which is the next step of a shortest path toward the source of `dist`. Falls back to the first
incident edge, so callers always get an edge for a known node.

## Queries

- `nearestEdgePoint` projects onto every edge; used to re-attach an entity whose edge vanished.
- `nearestNode` is a linear scan with an optional filter; used for the player's start and for
  goal relocation (interior nodes only).
- `isBorderNode(key)` is true for vertices on the bounding box. Keys are sorted ascending and box
  tags are negative, so a border key starts with a minus sign. Cheap enough to call per node per
  frame.

## Test coverage

`scripts/graph-test.js`: Euler's formula (catches any key non-uniqueness), degree at least two,
endpoint consistency, positive lengths, connectivity, greedy descent reaches the source,
nearest-edge at a vertex returns an incident edge, and edge-key survival under perturbation.
