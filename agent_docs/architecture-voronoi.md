# Voronoi architecture

## Contents
- Overview
- Invariants
- Algorithm
- Adjacency via edge tags
- Point queries
- Site placement and randomness
- Test coverage
- Scaling notes

## Overview

`docs/voronoi.js` is a pure ES module, no DOM. It turns a list of sites and a bounding rectangle
into cells with polygons, areas, centroids and neighbour lists. `world.js` builds the field from it;
`scripts/voronoi-test.js` checks it in node. `graph.js` consumes the `tag` on each polygon vertex.

**Key symbols**: `computeVoronoi` (the tessellation), `clipHalfPlane` (the inner loop),
`jitteredSites` (site placement), `mulberry32` (seeded PRNG), `cellAt` and `neighborToward`
(queries).

## Invariants

Global rules (determinism, symmetric adjacency, DOM-free) live in CLAUDE.md. Module-local:

- A cell's polygon is convex, with vertices in consistent winding (whichever the bounding box
  gives; the renderer and tests don't depend on direction).
- The bounding box is the only clip besides bisectors, so the union of all cells is exactly the
  box. The test asserts areas sum to the box area.
- `neighbors` is sorted ascending with no duplicates. Code that compares adjacency lists relies on
  this ordering.

## Algorithm

Per-site half-plane clipping, not Fortune's sweep or Delaunay duality. Each cell starts as the
bounding rectangle and is clipped by the perpendicular bisector against other sites. A bisector
against a site farther than twice the polygon's current circumradius cannot intersect it, so such
sites are skipped. Candidates come from a uniform bucket grid (about two sites per bucket),
visited in square rings of increasing distance around the site's own bucket, nearest first within
a ring; the ring loop stops once every unvisited site is provably out of cutting range. Each site
therefore touches only its neighbourhood and the build is close to linear in site count: a few
milliseconds for several hundred sites, measured headless.

Chosen for robustness and size: collinear or cocircular sites, which break naive Delaunay
builders, are harmless here. The trade is asymptotic cost; see Scaling notes.

## Adjacency via edge tags

Adjacency falls out of clipping. Every polygon vertex carries `tag`, the identity of the edge
starting at that vertex: a negative `BOX_*` side constant for a box edge, otherwise the tag of
the site whose bisector made it. A site's tag is `site.id` when present, else its array index;
`cell.id` and `neighbors` use the same tags. The world gives sites stable ids so that adding or
removing a site leaves every other tag unchanged. The four sides have distinct tags so `graph.js` can key a box
corner uniquely. Tags are kept on the returned polygon. In `clipHalfPlane`, a vertex introduced where the polygon leaves the half-plane starts a new
edge along the clip line and is tagged with the clipping site; a vertex where it re-enters keeps
the tag of the edge it interrupted. Tags that survive to the end are the neighbours. No separate
adjacency pass, no edge matching by coordinates.

`finishCell` merges consecutive vertices closer than `MERGE_EPS`, dropping the first so the
survivor keeps the real outgoing tag; otherwise the edge graph would contain zero-length edges.

Consequence: a bisector that only grazes a vertex may or may not leave a tag depending on
`EPS`. Both outcomes are legal; the test only requires symmetry, which holds because clipping
is symmetric in the pair.

## Point queries

- `cellAt(diagram, x, y)` is a nearest-site scan, which is the definition of the Voronoi cell.
  Linear; fine for a screen of sites. Replace with a grid bucket if site counts grow.
- `neighborToward(diagram, i, dx, dy)` picks the neighbour whose site direction has the largest
  cosine with `(dx, dy)`, requiring a positive cosine. Used for arrow-key movement.

## Site placement and randomness

`jitteredSites` places one site per grid square, offset within the square's inner region by the
`margin` parameter. Even cell sizes without Poisson-disc sampling, and the row-major order lets
callers address rows directly if they need to. The world keeps these as home positions and lets
the live sites drift around them.

`mulberry32` is the only randomness source for generation. Callers pass the stream; the module
never seeds itself.

## Test coverage

`scripts/voronoi-test.js` asserts, over several seeds: one cell per site, each site inside its own
polygon, at least two neighbours per cell, symmetric adjacency, `cellAt` of a site and of a
centroid returns that cell, areas tile the box, upward `neighborToward` picks a higher site,
determinism per seed, and a two-site degenerate split.

## Scaling notes

The world rebuilds the whole diagram every frame. If profiling shows this dominating, or the game
moves to a scrolling field, this module needs one of:

- Chunked generation: tessellate each chunk with a one-chunk border of ghost sites so edge cells
  are correct, then discard ghosts. Keeps the current algorithm.
- A Delaunay-based build (Bowyer-Watson or a port of a sweep) for large site counts.

Neither is built. Prefer chunking first; it keeps determinism per chunk trivially.
