# Plan: the game

> Status: in progress. Core loop built (edge running, auto-route, enemies, drifting cells, the
> dash action). Unverified in a browser at the time of writing; `npm test` covers the pure modules.

## Goal

A short-session browser game where the player runs the edges of a Voronoi mesh toward a goal,
routing is automatic, and all skill is in timing one action (the dash: a timed airborne speed
burst) against enemies on the same edges. The mesh itself reacts to enemy crowding, so the route keeps changing.

## Current state

See [architecture-world.md](architecture-world.md). Field sized to the viewport, one goal at a
time, points per goal from its distance and halved per dash on the way, one enemy added per
goal, death on contact. Large areas differ by a broad tone field (cell size, colour, glow).

## Decisions

- **Movement is edge-constrained, routing automatic.** The player never steers. Rejected free
  steering: the tessellation would turn into decoration.
- **Cells react to enemies and to the dash.** Enemies repel sites; the grounded player exerts no
  force. Repulsion inferred to read better than attraction for crowds (they open up, routes
  lengthen). Revisit after playtesting.
- **Dashes are cheap in time, expensive in points and distance.** A short cooldown after
  landing, never while airborne; each dash retreats the goal and halves what it pays. Replaced a
  long cooldown, which made the dash feel rationed rather than tactical, and a cooldown shorter
  than the air time, which let a held key chain dashes into permanent invulnerability.
- **The board grows; the camera holds.** Sites come from an infinite seeded grid with
  simplex-noise density; the active region grows toward each new goal and is pruned behind, always
  covering the view. The camera moves only when player or goal near the view edge, then eases to a
  snapshotted fit. Live recentering was rejected as making the board slide under the player.
- **The player follows a smoothed path.** The routed path is resampled and eased toward each
  frame; the player walks the eased curve, off-edge during transitions. Enemies stay on edges.
- **Stalkers intercept.** One enemy kind routes to a point ahead on the player's path. Added
  because hunters alone are always a step behind a faster player.
- **Board modifiers are harmless to touch.** Splitters and joiners reshape the mesh along their
  path and never kill, raise heat or push sites, so red still means danger and hollow means
  terrain change. Bounded by a site-count band, area thresholds, spacing and an edit rate so the
  mesh cannot shatter or collapse.
- **The dash deforms the mesh.** Shove on takeoff, compression while airborne. Chosen over a
  landing shockwave (feedback only), a wake (cosmetic) and a route rail (hands out free distance).
  Compression gives the dash a payoff beyond invulnerability.
- **One action.** A click dashes. Superseded an earlier split (click to boost, double-click to
  jump): one timing decision per click reads better on touch and removes double-click latency
  questions.
- **The dash is a time window, not a hop.** Airborne and fast for a fixed duration along the
  route. Superseded a jump to the vertex after the next one, which landed in a fixed place while
  an oncoming enemy kept moving, so the outcome was hard to read. Also rejected "jump to any
  clicked vertex" because it reintroduces steering.

## Testing methodology

- `npm test` (quick, seconds) while working on `voronoi.js`, `graph.js`, `world.js`; `npm run
  test:full` (minutes) before calling a change done. The world
  test is a headless smoke and determinism check, not a rules test.
- Visual checks in the browser with a fixed `?seed=`.
- `node scripts/difficulty.js [cap] [seeds] [policy]` for difficulty: scripted players (passive,
  reactive, cautious) run whole games headless and the script reports survival, goals, score,
  enemy count and pace per goal band. Run seeds in parallel processes with `SEED_FROM` for long
  caps. Any tuning change to `spawnTable`, speeds, goal distance or the retreat should be
  re-measured with it; the numbers in Phase 3 come from it.
- Add targeted rule tests to `scripts/world-test.js` as rules stabilise (dash window, cooldown,
  goal scoring).

## Phases

### Phase 1: playable core

- [x] Edge graph with motion-stable keys.
- [x] Player auto-routing, enemies (hunters, wanderers, stalkers, splitters, joiners), site
      drift, dash, scoring, death, growing board, camera.
- [ ] Browser verification on desktop and phone; fix anything the headless test can't see.
- [ ] Tune `TUNING` by feel: speeds, cooldowns, push strength, enemy growth, edit limits.

**Verify:** a run with a fixed seed plays identically twice; no console errors; frame time stays
under budget on a mid-range phone.

### Phase 2: readability and feel

- [x] Telegraph enemy approach: the threat pulse (sound) and the GL pulse. Edge glow still open.
- [ ] Dash target preview while the dash is ready.
- [ ] Land animation, boost trail, death animation.
- [ ] Touch ergonomics: tap-to-dash on mobile browsers, cooldown feedback.

**Verify:** playtesters can say why they died.

### Phase 3: depth

- [ ] Cell types on the route (slow mud, speed strips) assigned from the seeded stream.
- [x] Terrain tones: the tone field sets ground speed for player and enemies alike
      (`terrainSpeed`, `toneSpeedOpen`/`toneSpeedDense`). Open ground fast, dense ground slow.
- [x] Dead edges: `deadEdgeFrac` of edges, hashed from edge key and seed, closed to enemies but
      open to the route. Drawn tinted as safe lanes. Tuning the fraction by feel is still open.
- [x] Rivers: bands of two-site grid cells along a noise contour (`riverAt`, `riverScale`,
      `riverWidth`). Width and frequency by feel still open; a tint for them is a possible
      follow-up if cell size alone does not read.
- [x] Difficulty curve beyond "one more enemy per goal": `spawnTable` by goals reached sets the
      enemy mix, the spawn rate per goal and the enemy speed; new kinds debut at fixed goals.
      Measured 2026-10-25 evening with `scripts/difficulty.js`, five seeds, 300 s cap: passive
      median 32 s and 8 goals; reactive (dash when a killer is within 0.55 cells) median 119 s
      and 26 goals, 76 to 257 s, ending at 13 to 16 enemies; stomper (reactive plus a stomp
      whenever an enemy is in reach) median 216 s and 36 goals, two of five runs reaching the
      cap at about 40 goals and 13 to 14 enemies. Before a kill added to `spawnDebt`, the
      stomper held the board at two to four enemies indefinitely. Open: the stomper still
      outlasts the cap on easy seeds; candidates are a kill costing two spawns, or a stomp
      allowed only every other dash.
- [x] Procedural audio (astrocatch's `audio.js` is a reference, not a dependency); see
      [architecture-audio.md](architecture-audio.md). A phone listening pass is still open.

### Phase 4: sharing

- [ ] Best score persistence exists; add run summary and seed share links.

## Open questions

- Per-frame cost: a headless step is about 3 ms at 250 sites on a desktop. The clipper is
  bucketed and Dijkstra uses a heap; the next targets would be `buildGraph` string keys and the
  renderer's geometry rebuild. Measure on a phone before optimising further.
- Should the player's own presence also deform the mesh (a smaller push)?
- Should the view ever zoom back in when player and goal are close, or only move when needed
  (current)?
