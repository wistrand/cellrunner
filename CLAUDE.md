# CELLRUNNER

A browser game on a living Voronoi mesh that grows as you play. The player follows an
auto-routed, smoothed path toward a goal vertex; enemies run the cell edges; cells drift away from
enemy crowds; splitters and joiners reshape the board. One action: click to dash, a timed
airborne burst during which nothing can touch the player and the goal retreats; a second click in
the air stomps the nearest enemy, once per dash, at the price of another dash. Read this file
first, then the relevant file in `agent_docs/`.

```
docs/
  index.html       # tiny shell: DOM + CSS + one <script type="module">
  CNAME            # GitHub Pages custom domain: cellrunner.live
  main.js          # browser-only: input, RAF loop, HUD, best score, renderer selection
  renderer-gl.js   # browser-only: WebGL2 renderer (default)
  renderer.js      # browser-only: Canvas2D renderer (fallback, or ?gl=0)
  world.js         # pure: the simulation (region, sites, entities, rules, camera). Browser + node.
  graph.js         # pure: edge graph of a diagram, heap Dijkstra, nearest-edge queries
  voronoi.js       # pure: bucketed half-plane tessellation, seeded PRNG, site placement
  noise.js         # pure: seeded 2D simplex noise
  music.js         # pure: seeded music composition (key, chords, bass, arp, lead) in beats
  audio.js         # browser-only: Web Audio engine (buses, bar scheduler, music, game sounds)
  audio-events.js  # pure: game events and the threat signal for audio, by diffing world states
  audio-test.html  # dev page for audio.js (not linked from the game; ?seed, ?autostart, ?offline)
scripts/
  voronoi-test.js  # node checks for voronoi.js
  graph-test.js    # node checks for graph.js
  world-test.js    # headless smoke + determinism test for world.js
  music-test.js    # node checks for music.js (scale, voice leading, windows, fingerprint)
  events-test.js   # node checks for audio-events.js on scripted worlds
  difficulty.js    # headless difficulty sweep with scripted players (not part of npm test)
  serve.js         # dependency-free static server, serves docs/
agent_docs/        # per-subsystem deep dives, linked below
package.json       # "type": "module" + start and test scripts
README.md          # human-facing
CLAUDE.md          # this file (AGENTS.md is a symlink to it)
```

Everything the browser needs is under `docs/`, served by GitHub Pages from the `/docs` folder at
https://cellrunner.live. All non-browser tooling lives under `scripts/`.

## Commands

```sh
npm start   # dev server at http://localhost:8002/  (?seed=N reproduces a field)
npm test    # quick node checks (seconds): voronoi, graph, world, music, events with short budgets
npm run test:full  # the same with full step budgets and the continue scenario (minutes)
```

`main.js`, `renderer.js`, `renderer-gl.js` and `audio.js` are the only browser-only files.
Everything else must stay DOM-free so `npm test` keeps working in node.

## Docs

- [agent_docs/architecture-voronoi.md](agent_docs/architecture-voronoi.md): tessellation algorithm,
  edge tags, site placement, what the test asserts.
- [agent_docs/architecture-graph.md](agent_docs/architecture-graph.md): vertex and edge keys that
  survive motion, shortest paths, nearest-edge queries.
- [agent_docs/architecture-world.md](agent_docs/architecture-world.md): step order, the growing
  region and density, the player's smoothed path, enemies on edges, goal placement, the dash,
  board modifiers and limits, site forces, camera.
- [agent_docs/architecture-rendering.md](agent_docs/architecture-rendering.md): the two renderers
  and their shared interface, the WebGL2 pipeline, colour roles, DPR handling.
- [agent_docs/architecture-audio.md](agent_docs/architecture-audio.md): the composer, the event
  tracker and the Web Audio engine, the scheduler, mute and `?audio=0`.
- [agent_docs/plan-game.md](agent_docs/plan-game.md): the design and what is still to build. Read
  before adding mechanics.
- [agent_docs/plan-audio.md](agent_docs/plan-audio.md): the audio design history and sound
  design. Read before changing a sound.
- [agent_docs/gotchas.md](agent_docs/gotchas.md): non-obvious traps. Skim before touching
  `world.js`, `graph.js` or the seed pipeline.

## Invariants

- The world is a pure function of `(seed, viewport size, input sequence)`. Every random draw goes
  through the world's `mulberry32` stream in a fixed order, and every grid site is a pure function
  of `(seed, column, row)`. Never call `Math.random()` in the pure modules; `main.js` uses it
  only to pick a fresh seed.
- Vertex and edge keys are derived from the ids of the sites that meet there, never from
  coordinates, array indices or insertion order. Site ids are unique and never reused, so keys
  survive sites being added or removed. Entities reference edges by key and are relocated after
  every rebuild.
- Every enemy is always on an edge that exists in the current graph, with `t` in `[0, 1]`. The
  world test asserts this every step. The player is not on the graph: it follows `world.path`,
  which starts at the player and ends at the goal.
- Two sites are never closer than `sepHard`: `separateSites` enforces it after every
  integration step, since splits can place sites nearer than twice the drift cap `maxOffset`.
  Any code that adds a site must still respect `minSep` at insertion.
- The site count stays within the `siteCountMin`..`siteCountMax` band of the region's grid cell
  count, and every change to the site list (board edits, region changes) is followed by a rebuild
  before anything reads the diagram, so the graph and per-cell arrays always describe the same
  site list.
- The active region always covers the camera view plus a margin. Nothing visible is ever outside
  the tessellated box.
- Lengths in `world.js` are in cells and world units are pixels at camera scale 1. Renderers
  divide screen-pixel widths by the camera scale; they never scale the world.
- Only lethal enemy kinds (`isLethal`) kill, raise heat, drive the threat pulse (`threat`, shared
  by the GL renderer and the audio) or push sites.
  Board modifiers only edit the site list.
- The player moves only along `world.path`, airborne or not, and the routed path's first leg runs
  along an edge the player is beside, never across a cell. The dash is a state in time
  (untouchable, faster), never a displacement in space.
- Adjacency is symmetric and the edge graph satisfies Euler's formula for a connected planar
  graph. The tests assert both; keep them true for any replacement algorithm.

## Conventions

- **No build step.** No bundlers, transpilers, or runtime deps. The browser loads `main.js` via
  `<script type="module">`.
- **ES modules only.** `package.json` sets `"type": "module"`.
- **No shader loader.** GLSL lives as template strings in `renderer-gl.js`. Never put a backtick
  inside a shader, including in a GLSL comment; it terminates the template literal and breaks JS
  parsing. Quote identifiers in shader comments with single quotes or not at all.
- **Both renderers expose the same interface** (`createRenderer(canvas)` returning
  `{ resize, draw, width, height }`). A visual change lands in both or is noted as GL-only.
- **Lengths in cells, not pixels,** in `world.js`. Convert with `world.cell` at the point of use.
- **2-space indentation** in `.js`, `.html`, `<style>`.
- **100-char line width** in `.js`, `.html`, `.md`. Soft limit, break at clause boundaries.
- **No AI-isms in user-facing text.** Keep prose direct and concrete.
- **Mind allocation on hot paths.** `stepWorld` rebuilds the diagram and graph every frame and
  `draw` runs every frame. Keep per-frame allocations out of inner loops; the rebuild itself
  allocates and is the known cost. Measure with a headless step loop before optimising.
- Never run `deno fmt` or lint tools over this repo.
- Any change to `voronoi.js`, `graph.js`, `world.js`, `music.js` or `audio-events.js` must be
  re-verified with `npm test` (quick) and, before it is called done, `npm run test:full`.

## Documentation Style

- Markdown links for doc references an agent should follow, not backticks. Backticks are for
  source paths and inline code. Align table columns.
- No AI-isms (no "powerful", "seamlessly", "leverage", rule-of-three, "not just X but Y"). No em
  dashes or emojis in project copy.
- Concise; assume the agent is competent. Add only what it can't infer: names, rules,
  constraints, and the why.
- State each rule on its own line as always/never.
- Point at the source (`relocate` in `world.js`) instead of pasting constants or code.
- Mark inferred claims and open questions; don't present a guess as fact.
- Docs change with the code they point at. After a large change, sweep `agent_docs/`.
