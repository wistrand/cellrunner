# CELLRUNNER

Play it at [cellrunner.live](https://cellrunner.live).

A browser game on a living Voronoi mesh. You follow a route toward a gold marker; the game picks
the route and smooths it as the mesh shifts. Enemies run the cell edges. Where they crowd, the
cells bulge and the paths stretch. Each marker you reach places the next one further on, the board
grows to meet it, and the view follows only when it has to.

No install, no build, no dependencies. Plain ES modules and a Canvas2D renderer.

## Play

- **Click** (or Space, or Enter) to dash: for a moment you are airborne and fast, still following
  the route. Nothing can touch you until you land, however many edges you cover. The next dash
  comes a moment after landing, never in the air.
- Every dash pushes the gold marker away from you and halves what it will pay, and each dash on
  the way to the same marker pushes it further than the last, up to a limit. A marker
  is worth its distance when it was set; reach it without dashing and you get all of it. The HUD
  shows what the next one pays. Every other marker brings another enemy, and new kinds join as
  you score. Touching an enemy ends the run.
- The ground has a grain: open areas are fast, dense areas slow, for you and the enemies alike.
  Pale blue edges are closed to enemies; the route may use them, so they are the safe lanes.
- **R** starts a new run. On the game-over sheet, **C**, Space, Enter or CONTINUE keep the board
  and the enemy mix and start the score from zero; a click restarts. `?seed=N` in the URL reproduces a field.
- **M** mutes and unmutes. The music is composed from the seed, so a seed also reproduces the
  tune. `?audio=0` keeps sound off entirely.

Red enemies hunt you along the shortest path. Pink ones wander. Lime ones cut you off by heading
for where your route is going. Two hollow kinds are harmless to touch but reshape the board: teal
splitters divide the cells they pass, violet joiners merge them. Routes change under you either
way. A run starts with hunters and wanderers; the other kinds join as you score. Cell size varies
across the board; some patches are dense, some open.

## Run locally

ES modules can't be loaded from `file://`, so a tiny static server is bundled:

```sh
npm start          # http://localhost:8002/
npm test           # headless checks for the geometry and simulation modules
```

Requires Node 18 or newer. Nothing to `npm install`.

### Browser support

The default renderer is WebGL2. If the browser can't create a WebGL2 context the game falls back to
a Canvas2D renderer with the same look minus the glow. Add `?gl=0` to the URL to force Canvas2D.

## Layout

Everything the browser needs is in `docs/`, so the repo serves straight from GitHub Pages.
Node-side tooling is in `scripts/`. Design and architecture notes for contributors and coding
agents are in `CLAUDE.md` and `agent_docs/`.

## License

MIT.
