# Gotchas and findings

## Contents
- Traps
- Findings

## Traps

- **PRNG draw order is the world.** Every `rand()` call in `createWorld`, `jitteredSites`,
  `pickGoal`, `spawnEnemy` and `chooseEnemyEdge` is part of the seed contract. Adding a draw
  earlier in the sequence changes every run for every seed. Append new draws after existing ones,
  or derive a second stream from the seed.
- **Site ids are not indices.** `edge.cells`, `cell.neighbors`, `cell.id` and all graph keys hold
  ids; `world.sites`, `world.homes`, `world.vel`, `world.heat` and `diagram.cells` are indexed by
  position. Translate with `world.siteIndex`, rebuilt every frame. Mixing the two works by
  accident until the first join.
- **Goal placement must check graph distance, not just "a different vertex".** The nearest
  vertex to a spot five cells away can be three cells away along the graph. `placeGoal` pushes
  the spot further until `minDist` holds.
- **Don't place new sites relative to an entity position.** An entity sits on an edge, roughly
  half a cell from the two sites it separates, so anything derived from its position lands too
  close to a site. Use the cell's vertices (see `splitCell`) when choosing where to insert.
- **Board edits go before the rebuild.** `applyBoardEdits` runs first in `stepWorld`. An edit
  after the rebuild leaves the renderer with a heat array shorter than the cell list and NaN in
  the shader.
- **Edge orientation is arbitrary.** `edge.a`/`edge.b` depend on which cell registered the edge
  first. Always go through `otherEnd`; never assume `a` is "left" or "lower".
- **A retreating goal must never get stuck.** `retreatGoal` relocates the goal when no neighbour
  improves its score; without that, a goal driven into a corner sits at a local maximum and every
  further dash is free. Any change to the retreat rule needs an escape for the stuck case.
- **Input is applied after Dijkstra on purpose.** `retreatGoal` reads this frame's
  `distToPlayer`; moving the input step earlier makes the goal retreat on stale indices.
- **Relocate before you route.** Dijkstra results are indexed by `node.idx`, which changes every
  rebuild. Using last frame's distances with this frame's graph reads garbage without throwing.
- **`toX, toY` must be refreshed every frame.** `relocate` uses them to orient an entity after a
  flip. `placeOnEdge` sets them; any new movement path must call it.
- **The field is generated in CSS pixels at viewport size.** A resize rebuilds the world from the
  same seed and resets the run. Don't assume geometry is comparable across devices; tune in
  cells.
- **The clipping cutoff is a skip inside a ring and a break only between rings.** A site farther
  than twice the current circumradius can never cut, so skipping it is always safe; but sites in
  the same bucket ring are not sorted across rings, so `break` on that test inside a ring drops
  real neighbours. The ring loop itself may stop once the ring's lower distance bound exceeds the
  cutting range.
- **Camera moves ease toward a snapshot, not a live fit.** `updateCamera` stores `camGoal` when
  a move starts. Easing toward `cameraTarget(world)` every frame recentres on every player step
  and never settles.
- **The path start must come from edges near the player.** `pathStartNode` only considers
  endpoints of edges within `pathStartRadius`. Letting any nearby vertex win made the goal itself
  the start when close, and the path cut straight across a cell.
- **Spawn inside the leash.** `spawnNode` caps straight-line distance below `enemyLeash`;
  otherwise `leashEnemies` respawns the new enemy next frame, forever, and it flickers.
- **Two graphs in one: hunting fields skip dead edges, player fields do not.**
  `distToPlayerHunt` and `distToIntercept` are computed with the `isDead` skip and must be
  descended with the same skip (`nextEdgeToward(..., isDead)`). `distToPlayer` and `distToGoal`
  see every edge: `placeGoal` reads `distToPlayer` for the minimum distance and for
  `goalPlacedDist`, and a goal reachable only through a dead edge would otherwise be Infinity
  away, pass the check and pay an infinite score (seen in a headless sweep). Anything new that
  places an enemy on an edge should prefer a live one (`spawnEdge`).
- **The hunting fields are bounded.** `distToPlayerHunt` and `distToIntercept` stop at
  `huntReach` cells; beyond that every node reads Infinity. They are for enemies inside the leash
  only. Never read them for goal placement, spawning or anything else that looks across the
  board; those use `distToPlayer` and `distToGoal`, which are unbounded.
- **Distance arrays go stale on every rebuild.** `applyRegion` and `placeGoal` can rebuild
  mid-step. Anything that routes afterwards must use distances computed after the rebuild;
  `distToIntercept` is computed right before enemies move for this reason.
- **Coincident consecutive vertices are merged in `finishCell`.** Without that the graph would
  carry zero-length edges and `advance` would spin at them. Keep the merge if the clipper changes.
- **No backticks inside GLSL.** Shaders in `renderer-gl.js` are template literals; a backtick in a
  shader comment ends the string and the module fails to parse with an unhelpful error far from
  the cause. The convention is in CLAUDE.md; this is the reminder for when it bites.
- **Two renderers, one look.** A visual change made only in `renderer-gl.js` silently leaves
  Canvas2D users behind. Check `?gl=0` after rendering changes.
- **Airborne is a time check, not a flag.** `isAirborne(world)` compares `world.time` with
  `world.airUntil`. There is no per-entity air state to reset; a new dash just moves the times.
- **`npm test` is not run by the agent.** The user runs it. State clearly when a change to the
  pure modules is unverified.
- **The sheets act on pointerdown; their buttons have no handlers.** START and RESTART are
  inside sheets whose `pointerdown` calls `act`. A click handler on the button as well would
  start the run and then register a dash from the same click. CONTINUE stops propagation.
- **Create the AudioContext in a gesture, and only then.** `audio.ensure()` is called from the
  pointer and key handlers; `play` and `syncMusic` do nothing until a context exists. Calling
  `ensure` from the frame loop creates a suspended context on Safari that never plays.
- **Music bypasses the compressor.** Routing it through the SFX compressor clicked on downbeats
  in astrocatch. Keep the two buses separate.
- **Audio envelopes are linear ramps ending at exactly 0.** Exponential ramps cannot reach 0 and
  iOS Safari clicked at the handoff. `envelope` in `audio.js` is the one place to change this.
- **The music tempo is fixed per run.** The threat pulse and the score chime are placed on the
  beat grid from `nextBarTime`; changing `piece.bpm` mid-run moves that grid under them.
- **The lead latches its parameters per section.** It renders a whole phrase at once; feeding
  it per-bar energy and density switches phrase realizations halfway through.
- **The music fingerprint in `music-test.js` is the contract.** Any change to draw order or
  voicing in `music.js` changes every seed's tune. Update the fingerprint only when that is the
  intent, and say so.
- **Event objects are reused.** `diffWorld` returns the same array and objects every call. Copy
  what must outlive the frame.
- **Headless Chrome never finishes an offline render from a module script.** `--dump-dom` style
  runs of `audio-test.html?offline=N` hang. Drive the page over the DevTools protocol with
  `Runtime.evaluate` and `awaitPromise` instead.

## Findings

Record diagnosed bugs here as Symptom / Diagnosis / Fix / Takeaway so the rule that follows
isn't undone later.

- **Path start off the player on scoring frames.** Symptom: `world-test` failed "path starts at
  the player" on the steps where the score rose. Diagnosis: `movePlayer` re-bases the path and
  then snaps the player onto the goal, leaving `path[0..1]` at the pre-snap position for that
  frame. Fix: write the snapped position into the path before `scoreGoal`. Takeaway: anything
  that sets `player.x/y` after `updatePath` must also set the path's first point.
- **A held dash key made the player immortal.** Symptom: headless, a policy that acts every step
  never died. Diagnosis: the cooldown (0.5 s from takeoff) was shorter than the air time (0.7 s),
  so a new dash started before landing and the player was never touchable. Fix: `isActReady`
  is false while airborne and `actReadyAt` is `landCooldown` after `airUntil`. Takeaway: any
  invulnerability needs a guaranteed vulnerable window; test the hold-the-key policy.
- **Three of ten seeds died within 2.5 s under every policy.** Diagnosis: the start roster
  spawned "ahead" at 3 cells graph distance, and a player running at 1.6 cells/s into an enemy
  coming at 1.05 met it in about a second. Fix: opening spawns go behind the player at
  `spawnStartMinDist`. Takeaway: simulate the first five seconds across seeds after touching
  spawning.
- **Sites a few pixels outside the box.** Symptom: "site in bounds" failed on scattered steps.
  Diagnosis: two paths let a site end up outside: `moveSites` clamped before `separateSites`,
  so a separation push could shove a border site out, and `applyRegion` kept sites by their home
  but a kept site drifted up to `maxOffset` past the edge of a shrunken region. Fix: clamp after
  separation in `moveSites`, and clamp kept sites in `applyRegion`. Takeaway: the clamp must be
  the last thing that moves a site, and every place that changes `bounds` must re-check sites.
