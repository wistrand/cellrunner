// Pure: game events for the audio, found by comparing world states (agent_docs/plan-audio.md,
// phases C and D). The world emits no events, so a tracker keeps the few values it compares and
// `diffWorld` reports what changed since its last call. Runs in node; never draws from
// `world.rand`.
//
// Events: score, dashStart, dashEnd, goalMoved, death, split, join. Each has x, y (world units)
// and pan (-1..1 from the position on screen). Signals: threat (0..1) and enemyCount (lethal
// enemies), and heat: the threat with a slow release, for the adaptive music (`musicParams`).
// The event objects and the array are reused: read them before the next call.

import { isAirborne, isLethal, threat } from "./world.js";

const PAN_WIDTH = 0.8; // the screen edges pan this far, not hard left or right
const HEAT_RELEASE = 0.4; // heat falls this much per second of game time once threat drops
const HEAT_CALM = 0.25; // heat below this counts as calm: an enemy somewhere near is normal
const ARP_HEAT = 0.4; // heat from which the arp joins before the first point

export function createEventTracker() {
  return {
    world: null,
    time: 0,
    goals: 0,
    score: 0,
    dead: false,
    air: false,
    airStart: -Infinity,
    goalMovedAt: -Infinity,
    threat: 0,
    heat: 0,
    enemyCount: 0,
    biome: 0.5, // world.playerBiome: the ground under the player, 0 water .. 1 snow
    space: 0,   // world.playerSpace: 1 inside the digital domain
    events: [],
    pool: [],
  };
}

// -1 at the left edge of the view, 1 at the right, scaled by PAN_WIDTH.
export function panOf(world, x) {
  const cam = world.camera;
  const half = world.view.w / 2;
  if (!(half > 0)) return 0;
  return PAN_WIDTH * Math.max(-1, Math.min(1, ((x - cam.x) * cam.scale) / half));
}

function push(tr, world, type, x, y) {
  const n = tr.events.length;
  let ev = tr.pool[n];
  if (!ev) ev = tr.pool[n] = { type: "", x: 0, y: 0, pan: 0 };
  ev.type = type;
  ev.x = x;
  ev.y = y;
  ev.pan = panOf(world, x);
  tr.events.push(ev);
}

// The events since the last call for the same world. A different world (a new game) resets
// the tracker and reports nothing for that call.
export function diffWorld(tr, world) {
  tr.events.length = 0;
  const air = isAirborne(world);
  if (tr.world === world) {
    const p = world.player;
    if (world.goals > tr.goals) push(tr, world, "score", world.goalOriginX, world.goalOriginY);
    if (world.airStart !== tr.airStart) push(tr, world, "dashStart", p.x, p.y);
    else if (tr.air && !air && !world.dead) push(tr, world, "dashEnd", p.x, p.y);
    if (world.goalMovedAt !== tr.goalMovedAt) push(tr, world, "goalMoved", world.goalX, world.goalY);
    // Board edits push a flash stamped with the step's time.
    for (const f of world.flashes) {
      if (f.start > tr.time) {
        const type = f.kind === "splitter" ? "split" : f.kind === "joiner" ? "join" : f.kind;
        push(tr, world, type, f.x, f.y); // "stomp" and "stompMiss" pass through by name
      }
    }
    if (world.dead && !tr.dead) push(tr, world, "death", p.x, p.y);
  }
  const dt = tr.world === world ? world.time - tr.time : 0;
  if (tr.world !== world) tr.heat = 0;
  tr.world = world;
  tr.time = world.time;
  tr.goals = world.goals;
  tr.score = world.score;
  tr.dead = world.dead;
  tr.air = air;
  tr.airStart = world.airStart;
  tr.goalMovedAt = world.goalMovedAt;
  tr.threat = world.dead ? 0 : threat(world);
  tr.heat = Math.max(tr.threat, tr.heat - dt * HEAT_RELEASE);
  let count = 0;
  for (const en of world.enemies) if (isLethal(en)) count++;
  tr.enemyCount = count;
  tr.biome = world.playerBiome;
  tr.space = world.playerSpace;
  return tr.events;
}

// Music parameters for audio.setMusicParams from the tracker's state, written into `out` (no
// allocation). Pad and bass always play; the arp joins with heat or after the first point; the
// lead (the hook) enters after the first goal. Heat raises energy and density and opens the
// filters; goals reached and the enemy count add a little on top.
export function musicParams(tr, out = { energy: 0, density: 0, open: 0, biome: 0.5, space: 0,
  layers: {} }) {
  const h = Math.max(0, (tr.heat - HEAT_CALM) / (1 - HEAT_CALM));
  const progress = Math.min(1, tr.goals / 10);
  const crowd = Math.min(1, tr.enemyCount / 12);
  // The ground colours the arrangement a little: the digital domain is busier, water sparser.
  const water = Math.max(0, 1 - tr.biome / 0.3);
  out.energy = Math.min(1, 0.35 + 0.45 * h + 0.2 * progress);
  out.density = Math.min(1, Math.max(0, 0.3 + 0.5 * h + 0.2 * crowd + 0.15 * tr.space -
    0.15 * water));
  out.open = h;
  // Timbre: the engine reads these per note (see audio.js `terrain`).
  out.biome = tr.biome;
  out.space = tr.space;
  const layers = out.layers;
  layers.pad = true;
  layers.bass = true;
  layers.arp = tr.goals > 0 || tr.heat >= ARP_HEAT;
  layers.lead = tr.goals > 0;
  return out;
}
