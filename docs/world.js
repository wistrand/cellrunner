// Pure ES module: the simulation. Sites come from an infinite seeded jittered grid; the active
// region is a rectangle of grid cells that grows toward each new goal and is pruned behind the
// player. Sites drift under enemy pressure, the diagram and edge graph are rebuilt every step,
// entities walk the edges, and a camera eases to keep player and goal in view. No DOM. main.js
// drives it with input and hands the result to a renderer; scripts/world-test.js steps it headless.

import { computeVoronoi, mulberry32 } from "./voronoi.js";
import { createSimplex2D } from "./noise.js";
import { buildGraph, shortestPaths, nextEdgeToward, nearestEdgePoint, nearestNode, otherEnd,
  isBorderNode } from "./graph.js";

// Lengths are in cells (one grid square) and converted with world.cell. World units are pixels at
// camera scale 1; the camera maps world to screen, so the game plays the same at any viewport.
export const TUNING = {
  cellPx: 80,          // world units per grid cell
  playerSpeed: 1.6,    // cells / s
  boostMult: 2.2,      // speed multiplier while airborne
  jumpDuration: 0.7,   // s in the air: untouchable, boosted, still following the route
  landCooldown: 0.4,   // s after landing before the next dash; no dash can start while airborne
  enemySpeed: 1.0,     // cells / s, times the table's `speed`
  // Difficulty by goals reached (astrocatch's spawn table): each row is a control point and the
  // columns interpolate linearly between rows and plateau past the last. `spawn` is enemies
  // added per goal (fractions accumulate), `speed` multiplies enemySpeed, the kinds are spawn
  // weights normalised when sampled. A kind stays at 0 until the first row that gives it weight,
  // so its `at` is the goal it can first appear; `spawnKind` guarantees it does appear then.
  spawnTable: [
    { at: 0, spawn: 0.5, speed: 1.0, hunter: 40, wanderer: 60, stalker: 0, splitter: 0, joiner: 0 },
    { at: 7, spawn: 0.5, speed: 1.0, hunter: 40, wanderer: 60, stalker: 0, splitter: 0, joiner: 0 },
    { at: 8, spawn: 0.5, speed: 1.0, hunter: 40, wanderer: 45, stalker: 15, splitter: 0, joiner: 0 },
    { at: 15, spawn: 0.4, speed: 1.0, hunter: 36, wanderer: 36, stalker: 18, splitter: 10, joiner: 0 },
    { at: 24, spawn: 0.4, speed: 1.0, hunter: 32, wanderer: 30, stalker: 20, splitter: 10, joiner: 8 },
    { at: 45, spawn: 0.4, speed: 1.1, hunter: 30, wanderer: 25, stalker: 22, splitter: 12, joiner: 11 },
    { at: 90, spawn: 0.4, speed: 1.3, hunter: 30, wanderer: 25, stalker: 22, splitter: 12, joiner: 11 },
  ],
  enemiesStart: 2,     // rolled from the table's first row (hunters and wanderers)
  spawnStartMinDist: 4.5, // cells; the start roster spawns at least this far, behind the player
  interceptLead: 2.5,  // cells ahead along the player's path that stalkers aim for
  enemiesMax: 22,
  catchRadius: 0.12,   // cells
  threatRange: 2.5,    // cells; a lethal enemy this close starts the threat pulse (picture, sound)
  // Goal placement and the growing board.
  goalDistance: 5,     // cells beyond the reached goal where the next one is placed
  pointsPerCell: 2,    // points a goal pays per cell of graph distance when it was placed
  dashPenalty: 0.5,    // a goal's points are multiplied by this for every dash on the way to it
  goalSpread: 0.6,     // radians; random deviation of the next goal's direction from the path
  goalRetreat: 1.2,    // cells the goal moves away from the player per dash
  regionMargin: 1,     // grid cells kept beyond the camera view, player and goal
  regionMaxFactor: 1.6, // the region may span this many viewports per axis before pruning
  spawnMinDist: 3,     // cells; graph distance from the player below which enemies don't spawn
  enemyLeash: 7,       // cells; an enemy farther than this from the player is moved ahead of it
  spawnMaxDist: 5.5,   // cells; straight-line cap on spawn distance (stays inside the leash)
  pathSamples: 32,     // points in the player's smoothed path
  pathFollow: 6,       // 1 / s; how fast the smoothed path converges on the routed one
  pathStartRadius: 0.35, // cells; endpoints of edges this close to the player can start the path
  pathStartStick: 0.35, // cells; the current start vertex is kept unless another beats it by this
  trailSamples: 20,    // recent player positions kept for the renderers' trail
  trailInterval: 0.04, // s between trail samples (20 x 0.04 = 0.8 s of trail)
  // Initial density: simplex noise over the grid, mapped to [0, 1]. Below `sparse` a grid cell
  // has no site; above `dense` it has two. Between, one jittered site as usual.
  densityScale: 6,     // grid cells per noise unit; larger means broader patches
  sparse: 0.28,
  dense: 0.74,
  // Tone: a second, much broader simplex field (0 open, 1 dense) that gives large areas a
  // character of their own. It shifts the density (bigger cells where it is low) and tints the
  // renderers' fill, rim and edge styles. Continuous, so areas blend into each other.
  toneScale: 40,       // grid cells per noise unit; an area spans tens of cells
  toneContrast: 0.75,  // noise amplitude to tone; above 0.5 the extremes saturate
  toneDensity: 0.18,   // density shift at tone 0 (minus) and tone 1 (plus)
  // Camera.
  camMargin: 2.5,      // cells of padding around player and goal in the fit
  camMinScale: 0.55,
  camMaxScale: 1.1,
  camFollow: 6,        // 1 / s; easing rate toward the fit once a move has started
  camHoldMargin: 0.8,  // cells; the camera moves only when player or goal get this close to the edge
  // Board modifiers. Limits keep the mesh from degenerating in either direction.
  splitInterval: 2.0,  // s between a splitter's attempts
  joinInterval: 3.0,   // s between a joiner's attempts
  editMinGap: 0.6,     // s between any two board edits, across all modifiers
  siteCountMin: 0.5,   // fraction of the region's grid cell count the joiners may not go below
  siteCountMax: 2.0,   // fraction of the region's grid cell count the splitters may not exceed
  splitMinArea: 0.45,  // cells^2; cells smaller than this are not split
  joinMaxArea: 4.0,    // cells^2; a join that would leave a neighbour larger than this is skipped
  minSep: 0.22,        // cells; a new site keeps at least this from every site (> sepHard)
  sepHard: 0.18,       // cells; moveSites pushes any two sites apart to at least this
  flashDuration: 0.9,  // s; how long a board edit's marker stays visible
  // Site forces.
  pushRadius: 1.6,     // cells; lethal enemies push sites inside this radius
  pushForce: 9,        // cells / s^2 at zero distance, falling linearly to zero at pushRadius
  shoveRadius: 1.4,    // cells; takeoff impulse reaches sites inside this radius
  shoveImpulse: 1.6,   // cells / s added to a site at zero distance, linear falloff
  pullRadius: 1.4,     // cells; airborne player pulls sites inside this radius
  pullForce: 7,        // cells / s^2 at zero distance, linear falloff
  spring: 5,           // 1 / s^2, pull back toward the home position
  damping: 3,          // 1 / s
  maxOffset: 0.32,     // cells; cap on a site's displacement from home
  // Per-cell tints for the renderer.
  heatRadius: 1.3,     // cells; an enemy warms every cell whose site is within this distance
  goalRadius: 1.1,     // cells; the goal tints every cell whose site is within this distance
  playerRadius: 1.0,   // cells; the player tints every cell whose site is within this distance
};

// ---------------------------------------------------------------------------------------------
// Grid sites: deterministic from (seed, column, row), so any region of the plane can be
// generated, forgotten and regenerated identically.

const ID_HALF = 1 << 15;          // grid coordinates live in [-ID_HALF, ID_HALF)
const ID_SPAN = 2 * ID_HALF;
const SPLIT_ID_BASE = 2 ** 33;    // ids for split-born sites start above any grid id

function hash2(seed, c, r) {
  let h = (seed ^ Math.imul(c | 0, 0x9e3779b1) ^ Math.imul(r | 0, 0x85ebca77)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

function gridId(c, r, k) {
  return ((c + ID_HALF) * ID_SPAN + (r + ID_HALF)) * 2 + k;
}

// Density in [0, 1] at grid cell (c, r): one octave of simplex noise, sampled at the cell centre.
function density(world, c, r) {
  const s = TUNING.densityScale;
  const d = 0.5 + 0.5 * world.noise((c + 0.5) / s, (r + 0.5) / s);
  const t = toneAt(world, (c + 0.5) * world.cell, (r + 0.5) * world.cell);
  return d + TUNING.toneDensity * (2 * t - 1);
}

// The tone at a world position, 0..1. The same simplex as the density, sampled far broader and
// offset so the two fields do not line up.
function toneAt(world, x, y) {
  const s = TUNING.toneScale * world.cell;
  const n = world.noise(x / s + 100.5, y / s - 37.25);
  return Math.min(1, Math.max(0, 0.5 + TUNING.toneContrast * n));
}

// Zero, one or two sites for grid cell (c, r), pushed onto `out`.
function gridSites(world, c, r, out) {
  const cell = world.cell;
  const d = density(world, c, r);
  if (d < TUNING.sparse) return;
  const rand = mulberry32(hash2(world.seed, c, r));
  if (d > TUNING.dense) {
    // Two sites on a diagonal, each jittered inside its own quadrant. Minimum spacing stays
    // above sepHard by construction.
    const flip = rand() < 0.5;
    const j = () => (rand() - 0.5) * 0.24;
    const ax = 0.3 + j();
    const ay = 0.3 + j();
    const bx = 0.7 + j();
    const by = 0.7 + j();
    out.push({ x: (c + ax) * cell, y: (r + (flip ? by : ay)) * cell, id: gridId(c, r, 0) });
    out.push({ x: (c + bx) * cell, y: (r + (flip ? ay : by)) * cell, id: gridId(c, r, 1) });
    return;
  }
  const m = 0.15;
  const jx = m + rand() * (1 - 2 * m);
  const jy = m + rand() * (1 - 2 * m);
  out.push({ x: (c + jx) * cell, y: (r + jy) * cell, id: gridId(c, r, 0) });
}

// ---------------------------------------------------------------------------------------------

export function createWorld(seed, width, height) {
  seed = seed >>> 0;
  const cell = TUNING.cellPx;
  const cols = Math.max(4, Math.ceil(width / cell));
  const rows = Math.max(4, Math.ceil(height / cell));
  const world = {
    seed,
    rand: mulberry32(seed),
    noise: createSimplex2D(seed),
    cell,
    view: { w: width, h: height },
    region: { c0: 0, c1: cols - 1, r0: 0, r1: rows - 1 },
    bounds: null,
    sites: [],
    homes: [],
    vel: [],
    nextId: SPLIT_ID_BASE,
    siteIndex: null,
    lastEditAt: -Infinity,
    editCount: 0,
    flashes: [],         // { x, y, start, kind } markers for recent board edits
    diagram: null,
    graph: null,
    player: null,        // { kind, x, y, node }; moves along `path`, not the edges
    path: null,          // Float64Array(2 * pathSamples): smoothed route, path[0..1] is the player
    pathTarget: null,    // scratch: the routed path resampled to the same count
    pathReset: true,     // next update copies the routed path instead of easing toward it
    pathStart: null,     // vertex key the routed path currently leaves through
    trail: null,         // Float64Array(2 * trailSamples): ring of past player positions
    trailHead: 0,        // index of the oldest sample (the next to be overwritten)
    trailAt: 0,          // time of the next sample
    enemies: [],
    goal: null,
    goalX: 0,
    goalY: 0,
    goalOriginX: 0,      // player position when the current goal was set; gives the path direction
    goalOriginY: 0,
    goalMovedAt: -Infinity,
    goalPlacedDist: 0,   // graph distance (world units) from the player when the goal was placed
    legBase: 0,          // cells; the current goal's distance when it was set (before retreats)
    legDashes: 0,        // dashes since the current goal was set
    goals: 0,            // goals reached; `score` is the points they paid
    spawnDebt: 0,        // enemies owed by the table's `spawn` per goal; spawns when >= 1
    lastPoints: 0,       // what the last goal paid
    distToGoal: null,
    distToPlayer: null,
    distToIntercept: null, // from the vertex nearest the player's path interceptLead ahead
    heat: null,
    goalHeat: null,
    playerHeat: null,
    tone: null,          // per cell, 0..1: the broad tone field at the site's home
    camera: { x: 0, y: 0, scale: 1 },
    camGoal: null,       // the fit a running move eases toward; null while holding
    score: 0,
    time: 0,
    dead: false,
    airStart: -Infinity,
    airUntil: -Infinity,
    actReadyAt: 0,
  };
  world.bounds = boundsOf(world, world.region);
  const fresh = [];
  for (let r = world.region.r0; r <= world.region.r1; r++) {
    for (let c = world.region.c0; c <= world.region.c1; c++) gridSites(world, c, r, fresh);
  }
  for (const s of fresh) addSite(world, s);
  rebuild(world);
  const b = world.bounds;
  const start = nearestNode(world.graph, b.x + b.w / 2, b.y + b.h - 1);
  world.player = { kind: "player", x: start.x, y: start.y, node: start.key };
  world.trail = new Float64Array(2 * TUNING.trailSamples);
  resetTrail(world);
  world.path = new Float64Array(2 * TUNING.pathSamples);
  world.pathTarget = new Float64Array(2 * TUNING.pathSamples);
  world.distToPlayer = shortestPaths(world.graph, world.player.node);
  placeGoal(world, world.player.x, world.player.y, 0, -1, TUNING.goalDistance,
    TUNING.goalDistance * 0.9 * cell);
  startLeg(world);
  // Settle the camera and the region it needs before anyone spawns, so the first step does not
  // re-attach every enemy to a changed board.
  world.camera = cameraTarget(world);
  ensureRegion(world, world.goalX, world.goalY);
  updatePath(world, 0);
  for (let i = 0; i < TUNING.enemiesStart; i++) spawnEnemy(world, rollKind(world), true);
  finishStep(world);
  return world;
}

// Every sample at the player's position: a trail that starts from nothing.
function resetTrail(world) {
  const { trail, player } = world;
  for (let i = 0; i < trail.length; i += 2) {
    trail[i] = player.x;
    trail[i + 1] = player.y;
  }
  world.trailHead = 0;
  world.trailAt = world.time;
}

// Record the player's position every trailInterval. Renderers read the ring oldest first:
// sample k is at index 2 * ((trailHead + k) % trailSamples).
function sampleTrail(world) {
  if (world.time < world.trailAt) return;
  const { trail, player } = world;
  trail[2 * world.trailHead] = player.x;
  trail[2 * world.trailHead + 1] = player.y;
  world.trailHead = (world.trailHead + 1) % TUNING.trailSamples;
  world.trailAt = world.time + TUNING.trailInterval;
}

// Continue after death on the same board: the score resets, the goals reached (and so the enemy
// mix) stay, every enemy is moved away from the player, and a fresh goal is placed ahead. The
// run is no longer a pure function of the input sequence from here, but still of the seed plus
// the continue points.
export function continueWorld(world) {
  if (!world.dead) return;
  world.dead = false;
  world.score = 0;
  world.lastPoints = 0;
  world.airStart = -Infinity;
  world.airUntil = -Infinity;
  world.actReadyAt = world.time;
  world.distToPlayer = shortestPaths(world.graph, world.player.node);
  for (const en of world.enemies) respawn(world, en);
  placeGoal(world, world.player.x, world.player.y, world.goalX - world.player.x,
    world.goalY - world.player.y, TUNING.goalDistance, TUNING.goalDistance * 0.9 * world.cell);
  startLeg(world);
  world.pathReset = true;
  world.pathStart = null;
  resetTrail(world);
  finishStep(world);
}

// Viewport changed: the camera fit adapts; the board does not reset.
export function setView(world, width, height) {
  world.view.w = width;
  world.view.h = height;
}

// Hunters, stalkers and wanderers kill on contact. Splitters and joiners only edit the board.
export function isLethal(ent) {
  return ent.kind === "hunter" || ent.kind === "wanderer" || ent.kind === "stalker";
}

// 1 when a lethal enemy touches the player, 0 at `threatRange` cells or farther. Shared by the
// GL renderer's pulse and the audio telegraph.
export function threat(world) {
  const { player, enemies, cell } = world;
  let d2 = Infinity;
  for (const en of enemies) {
    if (!isLethal(en)) continue;
    const d = (en.x - player.x) ** 2 + (en.y - player.y) ** 2;
    if (d < d2) d2 = d;
  }
  return Math.max(0, 1 - Math.sqrt(d2) / (TUNING.threatRange * cell));
}

export function isAirborne(world) {
  return world.time < world.airUntil;
}

// 0 at takeoff, 1 at landing; for the renderer's arc.
export function airProgress(world) {
  const span = world.airUntil - world.airStart;
  return span > 0 ? Math.min(1, (world.time - world.airStart) / span) : 1;
}

export function isActReady(world) {
  return world.time >= world.actReadyAt && !isAirborne(world);
}

// ---------------------------------------------------------------------------------------------
// Region and sites

function boundsOf(world, reg) {
  const cell = world.cell;
  return { x: reg.c0 * cell, y: reg.r0 * cell,
    w: (reg.c1 - reg.c0 + 1) * cell, h: (reg.r1 - reg.r0 + 1) * cell };
}

function regionCount(world) {
  const r = world.region;
  return (r.c1 - r.c0 + 1) * (r.r1 - r.r0 + 1);
}

function inRegion(reg, c, r) {
  return c >= reg.c0 && c <= reg.c1 && r >= reg.r0 && r <= reg.r1;
}

function inBounds(b, x, y) {
  return x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;
}

function addSite(world, s) {
  world.sites.push(s);
  world.homes.push({ x: s.x, y: s.y, tone: toneAt(world, s.x, s.y) });
  world.vel.push({ x: 0, y: 0 });
}

function removeSiteAt(world, idx) {
  world.sites.splice(idx, 1);
  world.homes.splice(idx, 1);
  world.vel.splice(idx, 1);
}

function rebuild(world) {
  world.diagram = computeVoronoi(world.sites, world.bounds);
  world.graph = buildGraph(world.diagram);
  const index = new Map();
  for (let i = 0; i < world.sites.length; i++) index.set(world.sites[i].id, i);
  world.siteIndex = index;
}

// Switch to a new region: drop sites whose home left it, generate grid sites for the newly
// covered grid cells, rebuild, and re-attach everything. Cells inside both regions keep their
// ids, so only the cells along the changed border are affected.
function applyRegion(world, next) {
  const old = world.region;
  const b = boundsOf(world, next);
  for (let i = world.sites.length - 1; i >= 0; i--) {
    const h = world.homes[i];
    if (!inBounds(b, h.x, h.y)) {
      removeSiteAt(world, i);
      continue;
    }
    // A kept site can be drifted past the new edge when the region shrinks; the box must hold
    // every site, so pull it in (same 1 px margin as moveSites).
    const s = world.sites[i];
    s.x = Math.min(b.x + b.w - 1, Math.max(b.x + 1, s.x));
    s.y = Math.min(b.y + b.h - 1, Math.max(b.y + 1, s.y));
  }
  const fresh = [];
  for (let r = next.r0; r <= next.r1; r++) {
    for (let c = next.c0; c <= next.c1; c++) {
      if (!inRegion(old, c, r)) gridSites(world, c, r, fresh);
    }
  }
  for (const s of fresh) addSite(world, s);
  world.region = next;
  world.bounds = b;
  rebuild(world);
  const graph = world.graph;
  anchorPlayer(world);
  const displaced = [];
  for (const en of world.enemies) {
    if (!inBounds(b, en.x, en.y)) displaced.push(en);
    relocate(en, graph);
  }
  if (world.goal && !graph.nodes.has(world.goal)) {
    const n = nearestNode(graph, world.goalX, world.goalY, isInterior) ||
      nearestNode(graph, world.goalX, world.goalY);
    world.goal = n.key;
    world.goalX = n.x;
    world.goalY = n.y;
  }
  world.distToPlayer = shortestPaths(graph, world.player.node);
  // Enemies left behind in a pruned strip come back inside the view, away from the player.
  for (const en of displaced) respawn(world, en);
}

// Grow the region to cover (x, y), the player and the camera's view with a margin, then prune
// strips none of them need once the region exceeds its size budget. The required rectangle
// always survives, so the visible area is always tessellated.
function ensureRegion(world, x, y) {
  const { cell, player, region, view, camera } = world;
  const m = TUNING.regionMargin;
  const hw = view.w / camera.scale / 2;
  const hh = view.h / camera.scale / 2;
  const req = {
    c0: Math.floor(Math.min(player.x, x, camera.x - hw) / cell) - m,
    c1: Math.floor(Math.max(player.x, x, camera.x + hw) / cell) + m,
    r0: Math.floor(Math.min(player.y, y, camera.y - hh) / cell) - m,
    r1: Math.floor(Math.max(player.y, y, camera.y + hh) / cell) + m,
  };
  const next = {
    c0: Math.min(region.c0, req.c0), c1: Math.max(region.c1, req.c1),
    r0: Math.min(region.r0, req.r0), r1: Math.max(region.r1, req.r1),
  };
  const maxC = Math.ceil((view.w / cell) * TUNING.regionMaxFactor);
  const maxR = Math.ceil((view.h / cell) * TUNING.regionMaxFactor);
  while (next.c1 - next.c0 + 1 > maxC && (next.c0 < req.c0 || next.c1 > req.c1)) {
    if (req.c0 - next.c0 >= next.c1 - req.c1) next.c0++;
    else next.c1--;
  }
  while (next.r1 - next.r0 + 1 > maxR && (next.r0 < req.r0 || next.r1 > req.r1)) {
    if (req.r0 - next.r0 >= next.r1 - req.r1) next.r0++;
    else next.r1--;
  }
  if (next.c0 !== region.c0 || next.c1 !== region.c1 ||
      next.r0 !== region.r0 || next.r1 !== region.r1) {
    applyRegion(world, next);
  }
}

// ---------------------------------------------------------------------------------------------
// Entities

function makeEntity(world, fromKey, edgeKey, kind) {
  const e = world.graph.edges.get(edgeKey);
  const ent = { kind, edge: edgeKey, from: fromKey, to: otherEnd(e, fromKey), t: 0,
    x: 0, y: 0, toX: 0, toY: 0, nextActAt: 0 };
  placeOnEdge(ent, world.graph);
  return ent;
}

function placeOnEdge(ent, graph) {
  const a = graph.nodes.get(ent.from);
  const b = graph.nodes.get(ent.to);
  ent.x = a.x + (b.x - a.x) * ent.t;
  ent.y = a.y + (b.y - a.y) * ent.t;
  ent.toX = b.x;
  ent.toY = b.y;
}

function dist2(ax, ay, bx, by) {
  return (ax - bx) * (ax - bx) + (ay - by) * (ay - by);
}

// Re-attach an entity after the graph was rebuilt. Same edge key: keep t, repair endpoint names.
// Edge gone (topology flip, border change, join): snap to the nearest edge, heading toward the
// old target.
function relocate(ent, graph) {
  const e = graph.edges.get(ent.edge);
  if (e) {
    const fromOk = e.a === ent.from || e.b === ent.from;
    const toOk = e.a === ent.to || e.b === ent.to;
    if (fromOk && toOk) return;
    if (fromOk) {
      ent.to = otherEnd(e, ent.from);
      return;
    }
    if (toOk) {
      ent.from = otherEnd(e, ent.to);
      return;
    }
    const a = graph.nodes.get(e.a);
    const b = graph.nodes.get(e.b);
    if (dist2(b.x, b.y, ent.toX, ent.toY) <= dist2(a.x, a.y, ent.toX, ent.toY)) {
      ent.from = e.a;
      ent.to = e.b;
    } else {
      ent.from = e.b;
      ent.to = e.a;
    }
    return;
  }
  const hit = nearestEdgePoint(graph, ent.x, ent.y);
  const a = graph.nodes.get(hit.edge.a);
  const b = graph.nodes.get(hit.edge.b);
  ent.edge = hit.edge.key;
  if (dist2(b.x, b.y, ent.toX, ent.toY) <= dist2(a.x, a.y, ent.toX, ent.toY)) {
    ent.from = hit.edge.a;
    ent.to = hit.edge.b;
    ent.t = hit.t;
  } else {
    ent.from = hit.edge.b;
    ent.to = hit.edge.a;
    ent.t = 1 - hit.t;
  }
}

function isInterior(node) {
  return !isBorderNode(node.key);
}

// Nodes ranked by distance from the player; `fraction` of the farthest, random pick.
// `filter` narrows the candidates first; falls back to all reachable nodes if it empties them.
function farNode(world, fraction, filter) {
  const reachable = world.graph.nodeList.filter((n) => Number.isFinite(world.distToPlayer[n.idx]));
  let pool = filter ? reachable.filter(filter) : reachable;
  if (pool.length === 0) pool = reachable;
  pool.sort((p, q) => world.distToPlayer[q.idx] - world.distToPlayer[p.idx]);
  const count = Math.max(1, Math.floor(pool.length * fraction));
  return pool[Math.floor(world.rand() * count)];
}

// Where enemies appear: interior vertices inside the camera view (plus a cell), at least
// spawnMinDist from the player along the graph and at most spawnMaxDist in a straight line
// (inside the leash, or the leash would respawn them again next frame and they would flicker),
// preferring the goal's side of the board so the pack stays ahead of a player who keeps moving.
// Falls back to anywhere in view, then anywhere.
// `opening`: the start roster spawns farther out and behind the player (away from the goal),
// so the first seconds are not a collision course. Enemies ahead at 3 cells meet a player running
// at them in about a second.
function spawnNode(world, opening = false) {
  const { camera, view, cell, distToPlayer, distToGoal, player } = world;
  const hw = view.w / camera.scale / 2 + cell;
  const hh = view.h / camera.scale / 2 + cell;
  const minD = (opening ? TUNING.spawnStartMinDist : TUNING.spawnMinDist) * cell;
  const maxD2 = (TUNING.spawnMaxDist * cell) ** 2;
  const inView = (n) => isInterior(n) && distToPlayer[n.idx] >= minD &&
    dist2(n.x, n.y, player.x, player.y) <= maxD2 &&
    Math.abs(n.x - camera.x) <= hw && Math.abs(n.y - camera.y) <= hh;
  const ahead = (n) => inView(n) && distToGoal[n.idx] < distToPlayer[n.idx];
  const behind = (n) => inView(n) && distToGoal[n.idx] > distToPlayer[n.idx];
  if (opening) {
    if (world.graph.nodeList.some(behind)) return farNode(world, 0.6, behind);
    return farNode(world, 0.5, inView);
  }
  if (world.graph.nodeList.some(ahead)) return farNode(world, 0.6, ahead);
  return farNode(world, 0.5, inView);
}

// Put an existing enemy at a fresh spawn vertex.
function respawn(world, en) {
  const graph = world.graph;
  const n = spawnNode(world);
  const edge = n.edges[Math.floor(world.rand() * n.edges.length)];
  en.edge = edge;
  en.from = n.key;
  en.to = otherEnd(graph.edges.get(edge), n.key);
  en.t = 0;
  placeOnEdge(en, graph);
}

// Enemies that fell far behind are brought back ahead of the player. Without this a player who
// keeps running into fresh board simply outruns every enemy, since they are slower and only
// spawn on goals.
function leashEnemies(world) {
  const { player, cell } = world;
  const leash2 = (TUNING.enemyLeash * cell) ** 2;
  for (const en of world.enemies) {
    if (dist2(en.x, en.y, player.x, player.y) > leash2) respawn(world, en);
  }
}

export const ENEMY_KINDS = ["hunter", "wanderer", "stalker", "splitter", "joiner"];

// The spawn weights after `goals` goals, from TUNING.spawnTable (see there), written into `out`.
export function spawnWeightsAt(goals, out = {}) {
  const rows = TUNING.spawnTable;
  let i = 0;
  while (i + 1 < rows.length && rows[i + 1].at <= goals) i++;
  const a = rows[i];
  const b = rows[Math.min(i + 1, rows.length - 1)];
  const k = b.at > a.at ? Math.min(1, (goals - a.at) / (b.at - a.at)) : 0;
  for (const kind of ENEMY_KINDS) {
    const wa = a[kind] || 0;
    const wb = b[kind] || 0;
    // A kind off in row a stays off until row b, instead of ramping in from zero early.
    out[kind] = wa === 0 ? (goals >= b.at ? wb : 0) : wa + (wb - wa) * k;
  }
  return out;
}

// The `spawn` and `speed` columns after `goals` goals (plain interpolation, no zero hold).
export function difficultyAt(goals, out = { spawn: 1, speed: 1 }) {
  const rows = TUNING.spawnTable;
  let i = 0;
  while (i + 1 < rows.length && rows[i + 1].at <= goals) i++;
  const a = rows[i];
  const b = rows[Math.min(i + 1, rows.length - 1)];
  const k = b.at > a.at ? Math.min(1, (goals - a.at) / (b.at - a.at)) : 0;
  out.spawn = (a.spawn ?? 1) + ((b.spawn ?? 1) - (a.spawn ?? 1)) * k;
  out.speed = (a.speed ?? 1) + ((b.speed ?? 1) - (a.speed ?? 1)) * k;
  return out;
}

const WEIGHTS_SCRATCH = {};
const DIFFICULTY_SCRATCH = { spawn: 1, speed: 1 };

// One draw from the current spawn weights.
function rollKind(world) {
  const w = spawnWeightsAt(world.goals, WEIGHTS_SCRATCH);
  let total = 0;
  for (const kind of ENEMY_KINDS) total += w[kind];
  let r = world.rand() * total;
  for (const kind of ENEMY_KINDS) {
    r -= w[kind];
    if (r < 0) return kind;
  }
  return "wanderer";
}

// The kind to spawn now: a kind whose weight has turned on and that is not on the board yet
// debuts (first in ENEMY_KINDS order); otherwise a roll.
function spawnKind(world) {
  const w = spawnWeightsAt(world.goals, WEIGHTS_SCRATCH);
  for (const kind of ENEMY_KINDS) {
    if (w[kind] > 0 && !world.enemies.some((e) => e.kind === kind)) return kind;
  }
  return rollKind(world);
}

function spawnEnemy(world, kind = rollKind(world), opening = false) {
  if (world.enemies.length >= TUNING.enemiesMax) return;
  const n = spawnNode(world, opening);
  const edge = n.edges[Math.floor(world.rand() * n.edges.length)];
  const ent = makeEntity(world, n.key, edge, kind);
  if (kind === "splitter") ent.nextActAt = world.time + TUNING.splitInterval;
  if (kind === "joiner") ent.nextActAt = world.time + TUNING.joinInterval;
  world.enemies.push(ent);
}

// ---------------------------------------------------------------------------------------------
// Goal

// Put the goal `distCells` from (fromX, fromY) along (dx, dy): grow the board to cover the spot,
// then take the nearest interior vertex. The vertex must be a new one and at least `minDist`
// world units from the player along the graph; otherwise the spot is pushed a cell further,
// because the nearest vertex to a spot can sit well short of it. Never a border vertex: a goal
// on the box pins the route to the wall.
function placeGoal(world, fromX, fromY, dx, dy, distCells, minDist) {
  const len = Math.hypot(dx, dy);
  if (len === 0) {
    dx = 0;
    dy = -1;
  } else {
    dx /= len;
    dy /= len;
  }
  let gx = fromX + dx * distCells * world.cell;
  let gy = fromY + dy * distCells * world.cell;
  let n = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    ensureRegion(world, gx, gy);
    n = nearestNode(world.graph, gx, gy, isInterior) || nearestNode(world.graph, gx, gy);
    if (n.key !== world.goal && world.distToPlayer[n.idx] >= minDist) break;
    gx += dx * world.cell;
    gy += dy * world.cell;
  }
  world.goal = n.key;
  world.goalX = n.x;
  world.goalY = n.y;
  world.goalOriginX = world.player.x;
  world.goalOriginY = world.player.y;
  world.goalMovedAt = world.time;
  world.goalPlacedDist = world.distToPlayer[n.idx];
  world.distToGoal = shortestPaths(world.graph, world.goal);
}

// A new leg: the points on offer come from the goal's distance now; dashes on the way halve them.
function startLeg(world) {
  world.legBase = world.goalPlacedDist / world.cell;
  world.legDashes = 0;
}

// What the current goal pays if reached now: its distance when set times pointsPerCell, times
// dashPenalty per dash since. Doing nothing but following the route is the best score.
export function legPoints(world) {
  const raw = world.legBase * TUNING.pointsPerCell * Math.pow(TUNING.dashPenalty, world.legDashes);
  return Math.max(1, Math.round(raw));
}

// Reached: the next goal continues roughly along the path just travelled, with some spread.
function scoreGoal(world) {
  world.lastPoints = legPoints(world);
  world.score += world.lastPoints;
  world.goals++;
  let dx = world.goalX - world.goalOriginX;
  let dy = world.goalY - world.goalOriginY;
  if (Math.hypot(dx, dy) < 1e-6) {
    dx = 0;
    dy = -1;
  }
  const a = (world.rand() * 2 - 1) * TUNING.goalSpread;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const rx = dx * cos - dy * sin;
  const ry = dx * sin + dy * cos;
  placeGoal(world, world.goalX, world.goalY, rx, ry, TUNING.goalDistance,
    TUNING.goalDistance * 0.9 * world.cell);
  startLeg(world);
  world.spawnDebt += difficultyAt(world.goals, DIFFICULTY_SCRATCH).spawn;
  while (world.spawnDebt >= 1) {
    world.spawnDebt -= 1;
    spawnEnemy(world, spawnKind(world));
  }
  world.pathReset = true; // the new route leaves in a new direction; don't ease from the old one
  world.pathStart = null;
}

// The price of a dash: the goal moves away from the player along the player-to-goal line, and
// must end up farther along the graph than it was.
function retreatGoal(world) {
  const dx = world.goalX - world.player.x;
  const dy = world.goalY - world.player.y;
  const gn = world.graph.nodes.get(world.goal);
  const current = gn ? world.distToPlayer[gn.idx] : 0;
  placeGoal(world, world.goalX, world.goalY, dx, dy, TUNING.goalRetreat,
    current + 0.5 * TUNING.goalRetreat * world.cell);
}


// ---------------------------------------------------------------------------------------------
// Movement

// The player is not on the graph. Its anchor is the nearest vertex; hunters route to it and
// spawns measure distance from it.
function anchorPlayer(world) {
  world.player.node = nearestNode(world.graph, world.player.x, world.player.y).key;
}

// The vertex the routed path leaves through. Candidates are the endpoints of every edge within
// pathStartRadius of the player, so the first leg runs along an edge the player is on or beside,
// never straight across a cell. (Allowing any nearby vertex let the goal itself win when close,
// and the path cut across a cell to reach it.) Among candidates, the least straight-line distance
// plus graph distance to the goal wins, but the current choice is kept unless another beats it
// by pathStartStick, so the path does not flip between near-equal starts as the player moves.
function pathStartNode(world) {
  const { graph, player, distToGoal, cell } = world;
  const R = TUNING.pathStartRadius * cell;
  const R2 = R * R;
  const cost = (n) => Math.hypot(n.x - player.x, n.y - player.y) + distToGoal[n.idx];
  let best = null;
  let bestC = Infinity;
  let nearest = null;
  let nearestD = Infinity;
  for (const e of graph.edges.values()) {
    const a = graph.nodes.get(e.a);
    const b = graph.nodes.get(e.b);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((player.x - a.x) * dx + (player.y - a.y) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = a.x + dx * t;
    const qy = a.y + dy * t;
    const d2 = dist2(qx, qy, player.x, player.y);
    if (d2 < nearestD) {
      nearestD = d2;
      nearest = e;
    }
    if (d2 > R2) continue;
    for (const n of [a, b]) {
      const c = cost(n);
      if (c < bestC) {
        bestC = c;
        best = n;
      }
    }
  }
  if (!best && nearest) {
    // Nothing within the radius: use the nearest edge's cheaper endpoint.
    for (const n of [graph.nodes.get(nearest.a), graph.nodes.get(nearest.b)]) {
      const c = cost(n);
      if (c < bestC) {
        bestC = c;
        best = n;
      }
    }
  }
  if (!best) best = nearestNode(graph, player.x, player.y);
  const prev = world.pathStart ? graph.nodes.get(world.pathStart) : null;
  if (prev && prev !== best && cost(prev) <= bestC + TUNING.pathStartStick * cell) best = prev;
  world.pathStart = best.key;
  return best;
}

// The routed path: from the player to the goal via the start vertex, then greedy descent of the
// goal distances. Written into `out` as [x, y, ...]; returns point count.
function routedPath(world, out) {
  const { graph, distToGoal, player } = world;
  let n = 0;
  out[n++] = player.x;
  out[n++] = player.y;
  const start = pathStartNode(world);
  if (start) {
    let cur = start;
    for (let i = 0; i < 400 && n + 2 <= out.length; i++) {
      out[n++] = cur.x;
      out[n++] = cur.y;
      if (cur.key === world.goal) break;
      const ek = nextEdgeToward(graph, cur.key, distToGoal);
      if (!ek) break;
      const next = graph.nodes.get(otherEnd(graph.edges.get(ek), cur.key));
      if (next === cur) break;
      cur = next;
    }
  }
  if (n + 2 <= out.length) {
    out[n++] = world.goalX;
    out[n++] = world.goalY;
  }
  return n / 2;
}

const ROUTE_SCRATCH = new Float64Array(2 * 512);

// Resample a polyline of `count` points in `src` to exactly `samples` points, evenly spaced by arc
// length, into `dst`.
function resample(src, count, dst, samples) {
  let total = 0;
  for (let i = 1; i < count; i++) {
    total += Math.hypot(src[2 * i] - src[2 * i - 2], src[2 * i + 1] - src[2 * i - 1]);
  }
  if (count < 2 || total === 0) {
    for (let i = 0; i < samples; i++) {
      dst[2 * i] = src[0];
      dst[2 * i + 1] = src[1];
    }
    return;
  }
  let seg = 1;
  let segStart = 0;
  let segLen = Math.hypot(src[2] - src[0], src[3] - src[1]);
  for (let i = 0; i < samples; i++) {
    const s = total * i / (samples - 1);
    while (seg < count - 1 && s > segStart + segLen) {
      segStart += segLen;
      seg++;
      segLen = Math.hypot(src[2 * seg] - src[2 * seg - 2], src[2 * seg + 1] - src[2 * seg - 1]);
    }
    const t = segLen > 0 ? Math.min(1, (s - segStart) / segLen) : 0;
    dst[2 * i] = src[2 * seg - 2] + (src[2 * seg] - src[2 * seg - 2]) * t;
    dst[2 * i + 1] = src[2 * seg - 1] + (src[2 * seg + 1] - src[2 * seg - 1]) * t;
  }
}

// Ease the smoothed path toward this frame's routed path. The first point is pinned to the
// player. On reset the routed path is copied outright.
function updatePath(world, dt) {
  const { path, pathTarget, player } = world;
  const samples = TUNING.pathSamples;
  const count = routedPath(world, ROUTE_SCRATCH);
  resample(ROUTE_SCRATCH, count, pathTarget, samples);
  if (world.pathReset) {
    path.set(pathTarget);
    world.pathReset = false;
  } else {
    const a = 1 - Math.exp(-dt * TUNING.pathFollow);
    for (let i = 2; i < path.length; i++) path[i] += (pathTarget[i] - path[i]) * a;
  }
  path[0] = player.x;
  path[1] = player.y;
}

// Move the player `dist` world units along the smoothed path, then re-base the path on the new
// position so its samples stay evenly spread ahead of the player. Reaching the goal scores.
function movePlayer(world, dist) {
  const { path, player } = world;
  const samples = TUNING.pathSamples;
  let i = 1;
  let x = path[0];
  let y = path[1];
  while (i < samples && dist > 0) {
    const dx = path[2 * i] - x;
    const dy = path[2 * i + 1] - y;
    const len = Math.hypot(dx, dy);
    if (dist < len) {
      x += dx * dist / len;
      y += dy * dist / len;
      dist = 0;
      break;
    }
    x = path[2 * i];
    y = path[2 * i + 1];
    dist -= len;
    i++;
  }
  player.x = x;
  player.y = y;
  // Re-base: the remainder [player, path[i..]] resampled back to the full sample count.
  let n = 0;
  ROUTE_SCRATCH[n++] = x;
  ROUTE_SCRATCH[n++] = y;
  for (let k = Math.min(i, samples - 1); k < samples; k++) {
    ROUTE_SCRATCH[n++] = path[2 * k];
    ROUTE_SCRATCH[n++] = path[2 * k + 1];
  }
  resample(ROUTE_SCRATCH, n / 2, path, samples);
  if (Math.hypot(player.x - world.goalX, player.y - world.goalY) < 0.15 * world.cell) {
    player.x = world.goalX;
    player.y = world.goalY;
    path[0] = player.x; // the path always starts at the player, snapped or not
    path[1] = player.y;
    scoreGoal(world);
  }
}

// The vertex nearest the point interceptLead cells ahead along the player's path: where a
// stalker expects the player to be. Falls back to the anchor when the path is short.
function interceptNode(world) {
  const { path, cell, graph } = world;
  let lead = TUNING.interceptLead * cell;
  let x = path[0];
  let y = path[1];
  for (let i = 1; i < path.length / 2 && lead > 0; i++) {
    const dx = path[2 * i] - x;
    const dy = path[2 * i + 1] - y;
    const len = Math.hypot(dx, dy);
    if (lead < len) {
      x += dx * lead / len;
      y += dy * lead / len;
      lead = 0;
      break;
    }
    x = path[2 * i];
    y = path[2 * i + 1];
    lead -= len;
  }
  return nearestNode(graph, x, y).key;
}

function chooseEnemyEdge(world, ent, atKey, cameBy) {
  if (ent.kind === "hunter") return nextEdgeToward(world.graph, atKey, world.distToPlayer);
  // Stalkers cut the player off: they route to where the path leads, not where the player is.
  if (ent.kind === "stalker") return nextEdgeToward(world.graph, atKey, world.distToIntercept);
  // Wanderers, splitters and joiners all random-walk.
  const node = world.graph.nodes.get(atKey);
  const options = node.edges.length > 1 ? node.edges.filter((k) => k !== cameBy) : node.edges;
  return options[Math.floor(world.rand() * options.length)];
}

// Walk an enemy `dist` world units along the graph, choosing a new edge at every node reached.
function advance(world, ent, dist, chooser) {
  const graph = world.graph;
  for (let guard = 0; dist > 0 && guard < 64; guard++) {
    const e = graph.edges.get(ent.edge);
    const remaining = (1 - ent.t) * e.length;
    if (dist < remaining) {
      ent.t += dist / e.length;
      break;
    }
    dist -= remaining;
    const arrived = ent.to;
    const nextKey = chooser(world, ent, arrived, ent.edge);
    if (!nextKey) {
      ent.t = 1;
      break;
    }
    ent.from = arrived;
    ent.to = otherEnd(graph.edges.get(nextKey), arrived);
    ent.edge = nextKey;
    ent.t = 0;
  }
  placeOnEdge(ent, graph);
}

// The one action. The dash lives in time, not space: for `jumpDuration` the player is airborne
// (no collision) and runs the route at `boostMult` speed, however many edges that covers. The
// cooldown runs from the start.
// The next dash is allowed landCooldown after landing, never while airborne (isActReady), so
// every dash is followed by a window on the ground.
function dash(world) {
  world.airStart = world.time;
  world.airUntil = world.time + TUNING.jumpDuration;
  world.actReadyAt = world.airUntil + TUNING.landCooldown;
  world.legDashes++;
  shove(world);
  retreatGoal(world);
}

// Takeoff: a one-off radial velocity kick to sites near the player. The spring in moveSites
// brings them back, so the mesh bulges where the player left and relaxes over about a second.
function shove(world) {
  const { sites, vel, player, cell } = world;
  const R = TUNING.shoveRadius * cell;
  for (let i = 0; i < sites.length; i++) {
    const dx = sites[i].x - player.x;
    const dy = sites[i].y - player.y;
    const d = Math.hypot(dx, dy);
    if (d >= R || d === 0) continue;
    const k = TUNING.shoveImpulse * cell * (1 - d / R) / d;
    vel[i].x += k * dx;
    vel[i].y += k * dy;
  }
}

// ---------------------------------------------------------------------------------------------
// Board modifiers

// Run at the start of a step, before the rebuild, so the diagram, graph and per-cell arrays the
// renderer sees are always consistent with the site list. Each modifier acts on its own interval;
// a global gap and the limits in TUNING bound the result.
function applyBoardEdits(world) {
  if (world.time < world.lastEditAt + TUNING.editMinGap) return;
  for (const en of world.enemies) {
    if (en.kind !== "splitter" && en.kind !== "joiner") continue;
    if (world.time < en.nextActAt) continue;
    const interval = en.kind === "splitter" ? TUNING.splitInterval : TUNING.joinInterval;
    en.nextActAt = world.time + interval;
    const edge = world.graph.edges.get(en.edge);
    if (!edge) continue;
    const id = edge.cells[Math.floor(world.rand() * edge.cells.length)];
    const done = en.kind === "splitter" ? splitCell(world, id, en) : joinCell(world, id);
    if (done) {
      world.lastEditAt = world.time;
      world.editCount++;
      return; // one edit per step at most
    }
  }
}

// Insert a new site inside cell `id`, halfway from the cell's site to the cell's farthest vertex
// on the side away from the splitter. A Voronoi vertex is the local maximum of empty space, so the
// midpoint is at least half that vertex's radius from every site; this is the one placement that
// reliably passes minSep in a dense mesh. Skipped when the cell is small, the board is full, or
// the spot is still too close to a site or the box.
function splitCell(world, id, en) {
  const { sites, cell, bounds } = world;
  if (sites.length >= Math.ceil(regionCount(world) * TUNING.siteCountMax)) return false;
  const idx = world.siteIndex.get(id);
  if (idx === undefined) return false;
  const c = world.diagram.cells[idx];
  if (c.area < TUNING.splitMinArea * cell * cell) return false;
  const s = sites[idx];
  const awayX = s.x - en.x;
  const awayY = s.y - en.y;
  let best = null;
  let bestD = -1;
  for (const pass of [true, false]) {
    for (const v of c.polygon) {
      if (pass && (v.x - s.x) * awayX + (v.y - s.y) * awayY <= 0) continue;
      const d = dist2(v.x, v.y, s.x, s.y);
      if (d > bestD) {
        bestD = d;
        best = v;
      }
    }
    if (best) break;
  }
  if (!best) return false;
  const nx = (s.x + best.x) * 0.5;
  const ny = (s.y + best.y) * 0.5;
  const margin = 0.3 * cell;
  if (nx < bounds.x + margin || nx > bounds.x + bounds.w - margin ||
      ny < bounds.y + margin || ny > bounds.y + bounds.h - margin) return false;
  const sep2 = (TUNING.minSep * cell) ** 2;
  for (const o of sites) if (dist2(o.x, o.y, nx, ny) < sep2) return false;
  addSite(world, { x: nx, y: ny, id: world.nextId++ });
  world.flashes.push({ x: nx, y: ny, start: world.time, kind: "splitter" });
  return true;
}

// Remove the site of cell `id`; its area is absorbed by its neighbours. Skipped when the board is
// at its minimum or when any neighbour would end up larger than joinMaxArea (approximated as the
// neighbour's area plus the whole removed area).
function joinCell(world, id) {
  const { sites, cell } = world;
  if (sites.length <= Math.floor(regionCount(world) * TUNING.siteCountMin)) return false;
  const idx = world.siteIndex.get(id);
  if (idx === undefined) return false;
  const c = world.diagram.cells[idx];
  const maxArea = TUNING.joinMaxArea * cell * cell;
  for (const nid of c.neighbors) {
    const ni = world.siteIndex.get(nid);
    if (ni !== undefined && world.diagram.cells[ni].area + c.area > maxArea) return false;
  }
  const s = sites[idx];
  world.flashes.push({ x: s.x, y: s.y, start: world.time, kind: "joiner" });
  removeSiteAt(world, idx);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Site forces

// Sites are pushed away from nearby lethal enemies, pulled toward the player while airborne, and
// spring back toward home. Displacement is capped; separateSites then enforces a hard minimum
// spacing so sites can never meet.
function moveSites(world, dt) {
  const { sites, homes, vel, enemies, player, cell, bounds } = world;
  const R = TUNING.pushRadius * cell;
  const R2 = R * R;
  const pullR = TUNING.pullRadius * cell;
  const pullR2 = pullR * pullR;
  const pulling = isAirborne(world);
  const maxOff = TUNING.maxOffset * cell;
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i];
    const h = homes[i];
    const v = vel[i];
    let ax = -TUNING.spring * (s.x - h.x) - TUNING.damping * v.x;
    let ay = -TUNING.spring * (s.y - h.y) - TUNING.damping * v.y;
    for (const en of enemies) {
      if (!isLethal(en)) continue;
      const dx = s.x - en.x;
      const dy = s.y - en.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= R2 || d2 === 0) continue;
      const d = Math.sqrt(d2);
      const f = TUNING.pushForce * cell * (1 - d / R) / d;
      ax += f * dx;
      ay += f * dy;
    }
    if (pulling) {
      // Airborne compression: edges under the player shorten, so the dash covers more vertices.
      const dx = player.x - s.x;
      const dy = player.y - s.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < pullR2 && d2 > 0) {
        const d = Math.sqrt(d2);
        const f = TUNING.pullForce * cell * (1 - d / pullR) / d;
        ax += f * dx;
        ay += f * dy;
      }
    }
    v.x += ax * dt;
    v.y += ay * dt;
    s.x += v.x * dt;
    s.y += v.y * dt;
    const ox = s.x - h.x;
    const oy = s.y - h.y;
    const m = Math.hypot(ox, oy);
    if (m > maxOff) {
      s.x = h.x + ox * (maxOff / m);
      s.y = h.y + oy * (maxOff / m);
    }
  }
  separateSites(world);
  // Clamp last: a separation push can move a border site out of the box, and nothing may sit
  // outside the tessellated region. The clamp wins over sepHard only at the box edge.
  for (const s of sites) {
    s.x = Math.min(bounds.x + bounds.w - 1, Math.max(bounds.x + 1, s.x));
    s.y = Math.min(bounds.y + bounds.h - 1, Math.max(bounds.y + 1, s.y));
  }
}

// Hard separation: no two sites closer than sepHard. Splits and dense grid cells can place sites
// nearer than twice the drift cap, so the cap alone does not guarantee this. One symmetric push
// per pair per frame; the n^2 scan is cheap at this site count.
function separateSites(world) {
  const { sites, cell } = world;
  const min = TUNING.sepHard * cell;
  const min2 = min * min;
  for (let i = 0; i < sites.length; i++) {
    const a = sites[i];
    for (let j = i + 1; j < sites.length; j++) {
      const b = sites[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= min2) continue;
      let ux = 1;
      let uy = 0; // coincident: separate along a fixed axis so the result is deterministic
      if (d2 > 0) {
        const d = Math.sqrt(d2);
        ux = dx / d;
        uy = dy / d;
      }
      const push = (min - Math.sqrt(d2)) * 0.5;
      a.x -= ux * push;
      a.y -= uy * push;
      b.x += ux * push;
      b.y += uy * push;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Camera

// Fit player and goal with padding, clamped to a zoom range; when the clamp wins, keep the player
// in view and let the goal fall off-screen in its direction.
function cameraTarget(world) {
  const { player, view, cell } = world;
  const m = TUNING.camMargin * cell;
  const minX = Math.min(player.x, world.goalX) - m;
  const maxX = Math.max(player.x, world.goalX) + m;
  const minY = Math.min(player.y, world.goalY) - m;
  const maxY = Math.max(player.y, world.goalY) + m;
  let scale = Math.min(view.w / (maxX - minX), view.h / (maxY - minY));
  scale = Math.min(TUNING.camMaxScale, Math.max(TUNING.camMinScale, scale));
  let x = (minX + maxX) / 2;
  let y = (minY + maxY) / 2;
  const hx = view.w / scale / 2 - m;
  const hy = view.h / scale / 2 - m;
  if (hx > 0) x = Math.min(player.x + hx, Math.max(player.x - hx, x));
  if (hy > 0) y = Math.min(player.y + hy, Math.max(player.y - hy, y));
  return { x, y, scale };
}

// True when, seen from camera `cam`, the player or the goal is within camHoldMargin of the view
// edge or outside it.
function cameraNeedsMove(world, cam) {
  const { view, cell, player } = world;
  const m = TUNING.camHoldMargin * cell;
  const hw = view.w / cam.scale / 2 - m;
  const hh = view.h / cam.scale / 2 - m;
  const inside = (x, y) => Math.abs(x - cam.x) <= hw && Math.abs(y - cam.y) <= hh;
  return !(inside(player.x, player.y) && inside(world.goalX, world.goalY));
}

// The camera holds still until something is about to leave the view, then eases to a centred fit
// snapshotted at that moment and holds again. The snapshot matters: easing toward a live fit
// recentres on every player step and never settles. If the snapshot itself would already fail
// the hold test (the goal moved again mid-move), it is retaken.
function updateCamera(world, dt) {
  const cam = world.camera;
  if (!world.camGoal) {
    if (!cameraNeedsMove(world, cam)) return;
    world.camGoal = cameraTarget(world);
  } else if (cameraNeedsMove(world, world.camGoal)) {
    world.camGoal = cameraTarget(world);
  }
  const t = world.camGoal;
  const a = 1 - Math.exp(-dt * TUNING.camFollow);
  cam.x += (t.x - cam.x) * a;
  cam.y += (t.y - cam.y) * a;
  cam.scale += (t.scale - cam.scale) * a;
  const settled = Math.hypot(t.x - cam.x, t.y - cam.y) < 0.02 * world.cell &&
    Math.abs(t.scale - cam.scale) < 0.002;
  if (settled) {
    cam.x = t.x;
    cam.y = t.y;
    cam.scale = t.scale;
    world.camGoal = null;
  }
}

// ---------------------------------------------------------------------------------------------
// Step

function finishStep(world) {
  // Per-cell tints, each a smooth function of distance to the cell's site so colour drifts rather
  // than snapping at vertex crossings. Heat is a danger signal: lethal enemies only.
  const n = world.sites.length;
  const field = (prev) => (prev && prev.length === n ? prev.fill(0) : new Float32Array(n));
  const heat = field(world.heat);
  const goalHeat = field(world.goalHeat);
  const playerHeat = field(world.playerHeat);
  const tone = field(world.tone);
  const R = TUNING.heatRadius * world.cell;
  const G = TUNING.goalRadius * world.cell;
  const P = TUNING.playerRadius * world.cell;
  const fall = (d2, radius) => {
    if (d2 >= radius * radius) return 0;
    const k = 1 - Math.sqrt(d2) / radius;
    return 2.5 * k * k; // one source on a cell's edge puts that cell near 1
  };
  for (let i = 0; i < n; i++) {
    const s = world.sites[i];
    for (const en of world.enemies) {
      if (isLethal(en)) heat[i] += fall(dist2(s.x, s.y, en.x, en.y), R);
    }
    goalHeat[i] = Math.min(1, fall(dist2(s.x, s.y, world.goalX, world.goalY), G));
    playerHeat[i] = Math.min(1, fall(dist2(s.x, s.y, world.player.x, world.player.y), P));
    tone[i] = world.homes[i].tone;
  }
  world.heat = heat;
  world.goalHeat = goalHeat;
  world.playerHeat = playerHeat;
  world.tone = tone;
  // Drop expired edit markers.
  const flashes = world.flashes;
  let keep = 0;
  for (const f of flashes) if (world.time - f.start < TUNING.flashDuration) flashes[keep++] = f;
  flashes.length = keep;
}

// input: { act: boolean } for this step.
export function stepWorld(world, dt, input) {
  if (world.dead) return;
  world.time += dt;

  applyBoardEdits(world);
  moveSites(world, dt);
  rebuild(world);
  const graph = world.graph;
  const p = world.player;
  anchorPlayer(world);
  for (const en of world.enemies) relocate(en, graph);
  if (!graph.nodes.has(world.goal)) {
    const n = nearestNode(graph, world.goalX, world.goalY, isInterior) ||
      nearestNode(graph, world.goalX, world.goalY);
    world.goal = n.key;
  }
  const gn = graph.nodes.get(world.goal);
  world.goalX = gn.x;
  world.goalY = gn.y;
  world.distToGoal = shortestPaths(graph, world.goal);
  world.distToPlayer = shortestPaths(graph, p.node);

  if (input.act && isActReady(world)) dash(world);

  // The camera may have drifted toward an untessellated strip; keep the view covered.
  ensureRegion(world, world.goalX, world.goalY);

  const mult = isAirborne(world) ? TUNING.boostMult : 1;
  updatePath(world, dt);
  movePlayer(world, TUNING.playerSpeed * world.cell * mult * dt);
  sampleTrail(world);
  // Computed here, after the player moved and after any board growth, so stalkers read indices
  // of the current graph.
  world.distToIntercept = shortestPaths(world.graph, interceptNode(world));
  const speed = TUNING.enemySpeed * difficultyAt(world.goals, DIFFICULTY_SCRATCH).speed;
  for (const en of world.enemies) {
    const emult = en.kind === "hunter" ? 1.05 : en.kind === "stalker" ? 1.0 : 0.9;
    advance(world, en, speed * world.cell * emult * dt, chooseEnemyEdge);
  }
  leashEnemies(world);

  if (!isAirborne(world)) {
    const r2 = (TUNING.catchRadius * world.cell) ** 2;
    for (const en of world.enemies) {
      if (!isLethal(en)) continue;
      if (dist2(p.x, p.y, en.x, en.y) < r2) {
        world.dead = true;
        break;
      }
    }
  }
  finishStep(world);
  updateCamera(world, dt);
}
