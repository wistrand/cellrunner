# World architecture

## Contents
- Overview
- Invariants
- Step order
- Grid, region and density
- The player's path
- Enemies on edges
- Relocation after a rebuild
- Goal placement
- The dash action
- Board modifiers and limits
- Site forces
- Camera
- Outputs for the renderer

## Overview

`docs/world.js` is the simulation. `createWorld(seed, w, h)` builds the first region and spawns
the player, goal and enemies; `stepWorld(world, dt, input)` advances one frame; `setView` tells
it the viewport changed. All rules live here. Pure, no DOM; `scripts/world-test.js` steps it
headless. World units are pixels at camera scale 1; lengths in `TUNING` are in cells (one grid
square, `cellPx` world units).

**Key symbols**: `TUNING`, `createWorld`, `stepWorld`, `gridSites`, `density`, `ensureRegion`,
`applyRegion`, `updatePath`, `movePlayer`, `pathStartNode`, `advance`, `relocate`, `placeGoal`,
`retreatGoal`, `dash`, `applyBoardEdits`, `splitCell`, `joinCell`, `moveSites`, `updateCamera`,
`finishStep`, `isLethal`, `isAirborne`, `airProgress`.

## Invariants

Global rules are in CLAUDE.md. Module-local:

- `isAirborne(world)` is true exactly while `world.time < world.airUntil`. Collision is skipped
  in the air and the player runs faster; nothing else changes.
- `world.goal` names a node in the current graph after the relocation step, and is never a
  border node unless the board has no interior node at all.
- `world.path[0..1]` equals the player position after every step.
- `world.dead` is terminal; `stepWorld` returns immediately once set.

## Step order

1. `applyBoardEdits`: at most one splitter or joiner edit to the site list.
2. `moveSites`: integrate site velocities, then `separateSites`.
3. `rebuild`: `computeVoronoi`, `buildGraph`, and the id-to-index map `siteIndex`.
4. `anchorPlayer` (nearest vertex) and `relocate` every enemy; relocate the goal to the nearest
   interior node if its key vanished.
5. Two Dijkstras: from the goal (routing) and from the player's anchor (hunters, spawns, goal
   placement).
6. Apply input: start a dash if off cooldown. A dash retreats the goal, which may grow the board
   and rebuild.
7. `ensureRegion` for the current camera view, so the visible area is always tessellated.
8. `updatePath` then `movePlayer`; reaching the goal scores, which places the next goal (and may
   grow the board again).
9. `advance` every enemy, then `leashEnemies`.
10. Collision check on the ground, lethal kinds only.
11. `finishStep`: per-cell tints and flash pruning. `updateCamera`.

Board edits precede the rebuild so every per-cell array matches the site list. Relocation precedes
routing so node indices match the current graph. Whenever `applyRegion` runs mid-step it rebuilds
and re-attaches everything itself, so later stages always see a consistent graph.

## Grid, region and density

Sites come from an infinite jittered grid, deterministic from `(seed, column, row)` via `hash2`
and a per-cell `mulberry32`. A grid cell's density, `density`, is one octave of seeded simplex
noise from `noise.js` sampled at the cell centre: below `sparse` the cell has no site, above
`dense` it has two (on a diagonal, each jittered in its own quadrant), otherwise one. Grid ids
encode `(column, row, k)`; split-born sites get ids from `nextId`, which starts above any grid id.

Rivers bypass the density: `riverAt` samples the same simplex a third time, at `riverScale`
and its own offset, and a grid cell within `riverWidth` of the zero contour gets four sites on a
jittered 2 x 2 sub-grid (`gridSites`, ids `k` 0..3, which is why `gridId` reserves four slots
per cell and `SPLIT_ID_BASE` sits above 2^34). Twice the densest ordinary ground, so the band
reads as a distinct texture of tiny cells with a tight graph. Zero contours of simplex noise
never end, so a river is a closed loop or crosses the whole board. Rivers do not touch the tone,
so they are neither fast nor slow ground.

A second, far broader sample of the same noise is the tone, `toneAt` (0 open, 1 dense), at
`toneScale` cells per noise unit and offset so it does not line up with the density. It shifts
the density by up to `toneDensity`, so open-toned areas have larger cells, and every site stores
its home's tone in `world.homes`; `finishStep` copies it into `world.tone` per cell for the
renderers, which blend fill, rim, glow and edge styles by it. The field is continuous, so areas
blend into each other over several cells rather than switching.

The tone is also terrain: `terrainSpeed` samples it at a mover's own position and blends
`toneSpeedOpen` (tone 0) to `toneSpeedDense` (tone 1), and `stepWorld` multiplies the player's
and every enemy's distance for the step by it. Open ground is fast, dense ground slow, for
everyone alike.

A fourth sample, `biomeAt` at `biomeScale` with its own offset, is the biome, 0..1, stored per
site like the tone (`homes[i].biome`, copied to `world.biome` by `finishStep`). It is purely
visual: the GL renderer maps it through a water, grass, trees, snow colour ramp with grass in
the middle. A site whose home lies in a river band is biome 0, so rivers read as water. A fifth
sample, `spaceAt` at `spaceScale` (far broader still) passed through a smoothstep between the
`spaceEdge` values, is the space weight (`homes[i].space`, `world.space`): 1 inside the digital
domain, where the GL renderer draws the plain pre-biome look whatever the biome says, with a
border a few cells wide. Rivers inside space keep the space look. The 2D renderer ignores both.
`finishStep` also samples both fields at the player's position into `world.playerBiome` and
`world.playerSpace`, which the audio reads for its timbre.

A fraction `deadEdgeFrac` of edges is closed to enemies. `rebuild` marks each edge's `dead`
from `edgeHash(seed, key)`, a hash outside the `rand()` stream, so the set is fixed per seed
and an edge keeps its state while it moves. `isDead` is passed as the skip predicate to
`shortestPaths` for the two hunting fields, `distToPlayerHunt` and `distToIntercept`, both
computed right before enemies move and bounded at `huntReach` cells since every live enemy is
inside the leash, to `nextEdgeToward` in `chooseEnemyEdge`, and to
`nearestEdgePoint` in `relocate`; random walkers filter it out of their options, and
`spawnEdge` picks a live edge at the spawn vertex. Every one of these falls back to any edge
when no live edge exists, so an enemy is never stranded, but it can then stand on a dead edge
until the next vertex. `distToPlayer` and `distToGoal` see every edge: goal placement, retreat,
scoring and spawn geometry read them, and the player's route may run along dead edges. Those
are the safe lanes, drawn tinted by both renderers.

`world.region` is the active rectangle of grid cells; `world.bounds` is its box in world units
and the clip rectangle for the tessellation. `ensureRegion(x, y)` grows the region to cover the
player, the point `(x, y)` and the camera view with `regionMargin`, then prunes strips none of
them need once an axis exceeds `regionMaxFactor` viewports. `applyRegion` drops sites whose home
left the box, generates grid sites for newly covered grid cells, rebuilds, re-attaches enemies and
the goal, and respawns enemies that were standing in a pruned strip. Cells inside both regions
keep their ids, so only the border changes. A pruned area that is later re-covered is regenerated
fresh: splits and joins there are forgotten.

## The player's path

The player is not on the graph. Each step `routedPath` builds the route: the player position,
then `pathStartNode`, then greedy descent of the goal distances to the goal. The start vertex is
chosen among endpoints of edges within `pathStartRadius` of the player (so the first leg runs
along an edge, never across a cell) by straight-line distance plus graph distance, with
`pathStartStick` hysteresis so it does not flip as the player moves. The route is resampled to
`pathSamples` points by arc length into `pathTarget`; `world.path` eases toward it point by point
at `pathFollow`, except on `pathReset` (after a score) when it is copied. A score and a continue
also set `legRevealAt`, and `pathReveal` (0..1 over `pathReveal` seconds) tells the renderers
how much of the route to draw from the player outward, so a new leg's route grows into place
instead of appearing whole; the simulation itself follows the full path. `movePlayer` walks the
player along `world.path` and re-bases the path on the new position. The eased path cuts corners
during transitions by design; the player follows it off-edge. Reaching within a fraction of a cell
of the goal scores. `sampleTrail` records the player's position every `trailInterval` into
`world.trail`, a ring of `trailSamples` points read oldest first from `trailHead`; it is
render-only data kept in the world so both renderers draw the same trail and a replay matches.

`player.node`, the nearest vertex, is the anchor hunters route to and spawns measure from.

## Enemies on edges

An enemy is `{ edge, from, to, t }` plus cached `x, y` and `toX, toY`. `advance` walks a distance
along the graph, choosing a new edge at every node reached: `chooseEnemyEdge` descends the player
distances for hunters, the intercept distances for stalkers, or picks a random non-backtracking
edge for everyone else. Five kinds. Difficulty follows `spawnTable`, keyed by goals reached as
astrocatch's spawn table is keyed by captures; columns interpolate between rows and plateau past
the last. `spawn` is enemies per goal (`spawnDebt` accumulates fractions, so 0.5 is one every
other goal; the table starts there and eases to 0.4), `speed` multiplies `enemySpeed` (`difficultyAt`), and the kind columns are spawn
weights (`spawnWeightsAt`): a kind stays at zero until the first row that gives it weight, and
`spawnKind` makes a kind's first spawn after its weight turns on that kind, so stalkers,
splitters and joiners debut at known goals. The start roster (`enemiesStart`) comes from
`spawnKind` at goal 0, so each kind the first row turns on appears once before any roll
(two enemies means one hunter and one wanderer), and spawns behind the player at
`spawnStartMinDist` (`spawnNode` with `opening`), since enemies ahead at 3 cells met a player
running at them within a second. Hunters, stalkers and wanderers are lethal
(`isLethal`); only they raise heat, drive the renderer's threat pulse, push sites or trigger
collision. Hunters run slightly faster than the rest.

Stalkers are the smart kind: `interceptNode` finds the vertex nearest the point `interceptLead`
cells ahead along `world.path`, and `distToIntercept` (computed right before enemies move, so it
matches the current graph) routes them there. They arrive where the player is going rather than
chasing where the player is.

`spawnNode` picks interior vertices inside the camera view, at least `spawnMinDist` from the
player, preferring the goal's side; `leashEnemies` respawns any enemy farther than `enemyLeash`
from the player there. A leashed enemy is never silent: `respawn` and every non-opening
`spawnEnemy` stamp `spawnedAt`, the renderers grow the enemy in from a third of its size inside
an expanding ring over `spawnGrace` (`spawnProgress`), and only an enemy past that window can
catch the player (`isArmed`, the collision check). A hunter that was behind the player and
reappears ahead is therefore seen appearing and cannot kill for the first half second. Without
the leash a player who keeps running into fresh board outruns
every enemy, since they are slower and only spawn on goals.

## Relocation after a rebuild

`relocate` handles three cases for an enemy. Same edge key with both endpoints known: nothing to
do. One endpoint renamed (a vertex flipped at one end): repair that name from the edge. Both
renamed, or edge gone (flip, join, border change): orient or snap using `toX, toY`, the position
the entity was heading to last frame, via `nearestEdgePoint`. This is why entities cache `toX,
toY` every frame.

## Goal placement

`placeGoal(from, direction, distance, minDist)` aims at a spot `distance` cells from `from`,
grows the board to cover it, and takes the nearest interior vertex. If that vertex is the current
goal or closer than `minDist` along the graph from the player, the spot is pushed a cell further
and retried, because the nearest vertex to a spot can sit well short of it. On a score the
direction is the path just travelled (goal minus `goalOrigin`, the player position when that goal
was set) rotated by a random angle within `goalSpread`, at `goalDistanceAt`: `goalDistance`
plus `goalDistanceGrow` per goal reached, capped at `goalDistanceMax`, so legs lengthen and pay
more as a run goes on. On a dash,
`retreatGoal` pushes the goal along the player-to-goal line and requires a real gain in graph
distance. The push grows with the dashes on the leg: the n-th dash retreats n steps of
`goalRetreat`, capped at `goalRetreatMaxSteps` steps, so a second and third dash on one leg cost
more ground than the first. Border vertices are never goals: a goal on the box pins the route to
the wall.

## Continue

`continueWorld` revives a dead world on the same board: score to zero, goals reached (and so
the enemy mix) kept, every enemy respawned away from the player, a fresh goal ahead along the
old direction, a new leg. From then on the run is a function of the seed, the inputs and the
continue points, not of the inputs alone.

`serializeWorld` and `restoreWorld` let a run outlive a page reload: `main.js` saves the world
to local storage on death and on pause, and the start sheet offers CONTINUE LAST RUN (and the C
key) while a save exists; a save made at death goes through `continueWorld`, one made while
paused resumes as it was. The save is JSON of the plain state listed in `SAVE_FIELDS` plus the three
typed arrays and the PRNG state (`mulberry32` exposes `getState`/`setState`); everything derived
is rebuilt on restore (`rebuild`, the goal and player distance fields, `finishStep`). The
`-Infinity` timestamps travel as sentinel strings because JSON has no Infinity. `SAVE_VERSION`
guards the format: a save from another version throws, and `main.js` drops it. The world test
checks that a restored world tracks the original step for step under the same inputs.

## Scoring

A goal pays `legPoints`: its graph distance from the player when it was set (`legBase`, cells,
recorded by `startLeg` after a new goal is placed, not after a retreat) times `pointsPerCell`,
multiplied by `dashPenalty` for every dash since (`legDashes`). Reaching a goal without dashing
is therefore the best play; dashes buy safety and cost points, and the retreat they cause does
not add to the base. `world.score` is the points paid, `world.goals` the goals reached
(the audio keys off `goals`), `world.lastPoints` what the last goal paid.

## The dash action

One input, `input.act`, read for one step only (`main.js` clears it after each step). `dash`
sets `airStart`, `airUntil` and `actReadyAt`, shoves the mesh and retreats the goal. While
airborne, collision is skipped and the player moves at `boostMult` speed along the path.
`isActReady` is false while airborne and until `landCooldown` after landing, so dashes cannot be
chained: every dash is followed by a window on the ground (holding the key used to make the
player untouchable for good; see gotchas). The dash lives in time, not space: an earlier version
jumped to the vertex after the next one, which landed in a fixed place while an oncoming enemy
kept moving and read badly.

## Board modifiers and limits

- **Splitter** (`splitCell`): inserts a new site at the splitter's own position. A point on an
  edge is equidistant from the two sites it separates, so it clears `minSep` whenever they are
  more than twice `minSep` apart, which is every cell but the tightest, and the new cell opens
  under the splitter where the player sees it. Where that fails (rivers, dense ground) the
  fallback is halfway from the chosen cell's site to its farthest vertex on the side away from
  the splitter: a vertex is the local maximum of empty space, so the midpoint clears every site
  by half the vertex radius. `sitePlaceable` is the one check for both spots. The new site's home
  is its birth position.
- **Joiner** (`joinCell`): removes the site of one of the two cells beside its edge; the area is
  absorbed by the neighbours.

Each modifier acts on its own interval after a successful edit (`splitInterval`,
`joinInterval`) and retries a skipped attempt after `editRetry`, so a modifier in the wrong spot
is not idle for a whole interval; `applyBoardEdits` allows one edit per step and none within
`editMinGap` of the last. Limits: the site count stays within `siteCountMin`..`siteCountMax` of
the region's grid cell count; a cell smaller than `splitMinArea` is not split; a join is skipped
if any neighbour plus half the removed area would exceed `joinMaxArea` (the whole area blocked
nearly every join on open ground); a new site keeps `minSep` from every site at insertion. Every
successful edit
pushes a marker onto `world.flashes`, pruned after `flashDuration`, because a join is otherwise a
single-frame change nobody notices. `editCount` counts edits for tests.

## Site forces

Each site feels a spring toward its home, viscous damping, a repulsion from every lethal enemy
within `pushRadius`, and, while the player is airborne, an attraction toward the player within
`pullRadius`. All falloffs are linear in distance. After integration the offset from home is
clamped to `maxOffset`, then `separateSites` pushes any pair closer than `sepHard` apart
symmetrically, so sites never meet regardless of how they got close (splits and dense grid cells
place sites nearer than twice the drift cap). The position is clamped to the box last, so a
separation push never leaves a site outside; at the box edge the clamp wins over `sepHard`.

The dash adds a one-off outward velocity kick (`shove`) to sites within `shoveRadius`, so the
mesh bulges where the player left and relaxes under the spring; the airborne pull compresses the
edges under the player so the dash covers more ground. Interpretation of "cells move with enemy
density": enemies push sites away, so crowded regions open up. Flip the sign of the push term to
get the opposite feel.

## Camera

`world.camera` is `{ x, y, scale }`, world to screen being `(p - cam) * scale + view / 2`. The
camera holds still until the player or the goal comes within `camHoldMargin` of the view edge
(`cameraNeedsMove`). Then `cameraTarget` computes a fit of both with `camMargin` padding, clamped
to `camMinScale`..`camMaxScale` and shifted to keep the player in view when the clamp wins, and
the camera eases toward that snapshot at `camFollow` until settled, then holds again. If the goal
moves again mid-move so that the snapshot would fail the hold test, the snapshot is retaken.
Easing toward a live fit instead recentred on every player step and never settled; that was
rejected as making the board slide under the player.

## Outputs for the renderer

`world.path` is the smoothed route as `[x, y, ...]`, player first. `world.heat`, `goalHeat` and
`playerHeat` are per-cell tints indexed like `diagram.cells`: each is a quadratic falloff of
distance from the cell's site to lethal enemies, the goal, or the player, scaled so one source on
a cell's edge puts that cell near 1; renderers clamp at 1. `world.flashes` marks recent board
edits. `world.camera` is the view. `isAirborne`, `airProgress`, `isActReady` and `isLethal` are
the exported predicates.
