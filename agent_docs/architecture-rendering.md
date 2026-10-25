# Rendering architecture

## Contents
- Overview
- Shared interface
- Camera
- WebGL2 renderer
- Canvas2D renderer
- Colour roles
- DPR and resize
- Notes

## Overview

Two renderers, same interface, chosen once at startup in `main.js`: `renderer-gl.js` (WebGL2,
default) and `renderer.js` (Canvas2D, used when WebGL2 is unavailable or `?gl=0` is in the URL).
Both read the world object described in [architecture-world.md](architecture-world.md) and hold no
rules.

**Key files**: `docs/renderer-gl.js` (`createRendererGL`, `program`, `Writer`, the shader
strings), `docs/renderer.js` (`createRenderer`, `draw`, `cellFill`).

## Shared interface

`createRenderer*(canvas)` returns `{ resize, draw(world), width, height }` or, for GL only, null
when no context could be made. A canvas whose `getContext("webgl2")` returned null can still give
a 2d context, which is what makes the fallback work in place. Context type is sticky after the
first success, so switching renderers at runtime would need a new canvas element (not built).

## Camera

Both renderers read `world.camera` and map world to screen as `(p - cam) * scale + size / 2` in
CSS pixels: GL through `u_cam` and `u_scale` in the shared vertex prelude, 2D through the context
transform. Anything meant to stay a fixed number of screen pixels (edge widths, route widths,
glow band widths, dot anti-aliasing) is divided by the scale; anything sized in cells (dots,
rings, flashes) is left in world units and zooms with the board. The death overlay covers the
visible world rectangle in GL and is drawn in screen space in 2D.

## WebGL2 renderer

Four programs, each with one interleaved dynamic buffer and a VAO, built by `program`:

| Program  | Draws                                      | Attributes                             |
|----------|--------------------------------------------|----------------------------------------|
| cells    | triangle fan per cell polygon              | pos, edge distance, heat, goal, player, tone |
| flat     | edge quads, route quads, overlay           | pos, rgba                              |
| dots     | goal, enemies, edit flashes, player, glows | pos, uv, rgba, ring mode, softness     |
| vignette | one clip-space quad, last                  | pos                                    |

Geometry is rebuilt every frame into `Writer` instances (growable `Float32Array`s that double
when full and are reused after warm-up), then uploaded with `bufferData(DYNAMIC_DRAW)`. The
diagram changes every frame anyway, so there is nothing to cache.

- **Cells** fan from the centroid. The centre vertex carries the polygon's inradius as its edge
  distance and rim vertices carry zero; the interpolated value is an approximate distance field.
  The fragment shader adds a two-band rim glow (wide soft falloff plus a tight line), blue on
  cool cells and red on hot ones, stronger with heat, scaled by `u_glow` (the `CELL_GLOW`
  constant). The glow pulses: cells carrying enemies breathe with heat, and cells within
  `TUNING.threatRange` of the player breathe harder and faster as the nearest enemy closes in
  (`threat()` from `world.js` feeds `u_threat`; the audio pulse reads the same value). `u_time` is wrapped at `TIME_WRAP` so the sine
  argument keeps precision in long sessions; keep shader time multipliers to one decimal so the
  wrap is seamless. Fill colour blends `u_cell` toward `u_goalCell` by goal tint, then toward
  `u_playerCell` by player tint, then toward `u_hot` by heat, so an enemy on the goal or player
  cells still reads as danger; the rim colour follows the same order. Before all of that the
  base fill and rim are each a `mix` of the tone-0 and tone-1 colours (`cell`/`cellB`,
  `rim`/`rimB`) by the cell's `world.tone`, and the tone also shifts the glow's band mix: open
  ground is mostly the wide soft band, dense ground mostly the tight line.
- **Edges** are thin quads in the flat program (`gl.LINES` cannot be widened). Each edge's alpha
  and width rise with the mean tone of its cells (`edgeTone`). An edge with `dead` set (closed
  to enemies, see the world doc) is drawn instead in `edgeDead`, a pale tint at a fixed width,
  in both renderers, so the safe lanes can be read. The player's path
  (`world.path`, player first) gets a second batch: a wide faint halo under a bright core, both
  fading toward the goal so the path stays readable over glowing cells. A third flat batch
  (`playerMarks`) draws the player's trail from `world.trail`, oldest first, thin and faint to
  wide and brighter, ending at the player, and a heading chevron a fifth of a cell ahead of the
  player toward the second path sample. Both follow the lifted player while airborne. They exist
  so the player stays findable in a crowd.
- **Dots** are quads with a circle drawn in the fragment shader. The ring attribute selects
  filled disc, ring (value is the inner radius fraction), or soft glow (negative). Glows sit
  behind the goal, the player and every enemy, and are the main visual addition over Canvas2D.
  The goal is a halo, a beacon ring expanding every `GOAL_BEACON` seconds since `goalMovedAt`,
  the pulsing ring, `GOAL_SPARKS` orbiting sparks and the centre dot; halo and orbit radius
  scale with the points still on offer (`dashPenalty` to the power of `legDashes`), so dashing
  shrinks them.
  Enemies also get a dark outline disc under the body so they stay readable over hot cells; the
  2D renderer draws the same outline without the glow. Both renderers fade enemies by distance
  from the player, from full inside `ENEMY_FADE_NEAR` cells to `ENEMY_FADE_MIN` at
  `ENEMY_FADE_FAR`, so a far crowd does not compete with the near ones.
- **Death overlay** is one flat quad covering the screen.
- **Vignette** is drawn last by its own program: a static clip-space quad whose fragment alpha
  rises with distance from the screen centre (`COLORS.vignette` is the colour and max alpha). It
  ignores the camera, so it never moves with the board.

Blending is standard alpha; depth test off. Projection is a uniform resolution and a small
`project()` in the shared vertex prelude, so all geometry is in CSS pixels like the world.

## Canvas2D renderer

Fills every cell polygon (tone, goal, player and heat tints as in GL, without the glow), strokes
the edges in `EDGE_BUCKETS` passes by tone with rising alpha and width, then the player's path
segment by segment with alpha fading toward the goal, then the goal (beacon ring, pulsing ring,
orbiting sparks and dot, as in GL without the halo), enemy dots, the player's trail and heading
chevron, expanding rings for recent
board edits from `world.flashes`, and the player. Airborne the player is drawn raised along a
parabola in `airProgress(world)` with a ground shadow and a boost ring. A radial gradient built
once in unit space and drawn under a scaling transform is the vignette, last, with the same
falloff as the GL shader. Kept intentionally simple; it exists so the game runs everywhere.

## Colour roles

Each renderer has its own `COLORS` table (CSS strings in 2D, float arrays in GL) with the same
roles: background, cell at tone 0 and tone 1, hot cell, edge, dead edge, route, goal, hunter,
wanderer, player, boost, shadow, vignette, and GL-only rim and glow variants. Keep the two tables in step when
changing a role. Tone colours stay away from red (danger) and gold (goal).

## DPR and resize

`resize` reads CSS size and sets the backing store to CSS size times the device pixel ratio,
clamped to keep fill cost bounded on dense phone screens. 2D sets the context transform; GL sets
the viewport and relies on the projection uniform. Pointer coordinates and world geometry are in
CSS pixels throughout.

## Notes

Per-frame cost in GL is dominated by CPU geometry building (one fan per cell, one quad per
edge), not draw calls, of which there are five. If profiling shows the builders, the cell fan
could be replaced by an index buffer over the polygon vertices. The world's per-frame Voronoi
rebuild is the more likely bottleneck; measure before optimising either.
