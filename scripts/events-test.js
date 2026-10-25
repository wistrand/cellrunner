// Node test runner for docs/audio-events.js. Run via `npm test`. Scripted worlds: fixed seeds and
// a dash every 50 steps, stepped until death or 90 s. Board modifiers debut late in the spawn
// table and the scripted player dies early, so two of the start enemies are turned into a
// splitter and a joiner (plain fields on the entity) to exercise the split and join events.

import { createWorld, stepWorld, threat, TUNING } from "../docs/world.js";
import { createEventTracker, diffWorld, panOf, musicParams } from "../docs/audio-events.js";

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    failures++;
    console.error("FAIL:", msg);
  }
}

const SEEDS = [1, 7, 12345, 424242];
const DT = 1 / 60;
const STEPS = 60 * 90;

function run(seed) {
  const world = createWorld(seed, 1280, 800);
  world.enemies[0].kind = "splitter";
  world.enemies[0].nextActAt = 0;
  world.enemies[1].kind = "joiner";
  world.enemies[1].nextActAt = 0;
  const tr = createEventTracker();
  const log = [];
  const count = {};
  check(diffWorld(tr, world).length === 0, `seed ${seed}: a new world reports nothing`);
  let scores = 0;
  let prevScore = 0;
  let prevFlashTime = world.time;
  let prevHeat = 0;
  const mp = musicParams(tr);
  for (let i = 0; i < STEPS && !world.dead; i++) {
    const act = i % 50 === 0;
    const airStart = world.airStart;
    stepWorld(world, DT, { act });
    const evs = diffWorld(tr, world);
    for (const ev of evs) {
      count[ev.type] = (count[ev.type] || 0) + 1;
      log.push(`${i}:${ev.type}`);
      check(ev.pan >= -1 && ev.pan <= 1 && Number.isFinite(ev.x) && Number.isFinite(ev.y),
        `seed ${seed} step ${i}: ${ev.type} has a position and pan`);
    }
    const types = evs.map((e) => e.type);
    check(types.includes("dashStart") === (world.airStart !== airStart),
      `seed ${seed} step ${i}: dashStart exactly when a dash began`);
    check(types.includes("score") === (world.goals > prevScore), `seed ${seed} step ${i}: score`);
    if (world.goals > prevScore) scores++;
    prevScore = world.goals;
    const edits = world.flashes.filter((f) => f.start > prevFlashTime).length;
    check(types.filter((t) => t === "split" || t === "join").length === edits,
      `seed ${seed} step ${i}: one split or join per new board edit`);
    prevFlashTime = world.time;
    check(types.includes("death") === (world.dead && types.length > 0 && types.at(-1) === "death"),
      `seed ${seed} step ${i}: death is the last event of its step`);
    check(tr.threat >= 0 && tr.threat <= 1, `seed ${seed} step ${i}: threat in 0..1`);
    check(world.dead || tr.threat === threat(world), `seed ${seed} step ${i}: threat matches world`);
    // Heat follows threat up at once and falls slowly.
    check(tr.heat >= tr.threat && tr.heat <= 1, `seed ${seed} step ${i}: heat >= threat`);
    check(tr.heat >= Math.min(prevHeat, 1) - DT * 0.4 - 1e-9, `seed ${seed} step ${i}: heat falls slowly`);
    prevHeat = tr.heat;
    check(musicParams(tr, mp) === mp, `seed ${seed} step ${i}: musicParams fills the given object`);
    for (const k of ["energy", "density", "open"]) {
      check(mp[k] >= 0 && mp[k] <= 1, `seed ${seed} step ${i}: ${k} ${mp[k]} in 0..1`);
    }
    check(mp.layers.pad && mp.layers.bass, `seed ${seed} step ${i}: pad and bass always`);
    check(mp.layers.lead === world.goals > 0, `seed ${seed} step ${i}: lead after the first goal`);
    check(!mp.layers.lead || mp.layers.arp, `seed ${seed} step ${i}: arp plays whenever the lead does`);
  }
  // A dead world reports nothing more.
  check(diffWorld(tr, world).length === 0, `seed ${seed}: nothing after death`);
  check(tr.threat === 0, `seed ${seed}: no threat after death`);
  return { world, tr, log, count, scores };
}

let total = {};
for (const seed of SEEDS) {
  const { world, tr, log, count, scores } = run(seed);
  for (const [k, v] of Object.entries(count)) total[k] = (total[k] || 0) + v;
  check(JSON.stringify(run(seed).log) === JSON.stringify(log), `seed ${seed}: same events twice`);
  check((count.score || 0) === world.goals && scores === world.goals,
    `seed ${seed}: one score event per goal (${count.score} vs ${world.goals})`);
  check((count.death || 0) === (world.dead ? 1 : 0), `seed ${seed}: one death event`);
  const dashes = count.dashStart || 0;
  const landed = count.dashEnd || 0;
  check(landed === dashes || landed === dashes - 1, `seed ${seed}: every dash but the last lands`);
  // The goal moves on every dash (retreat) and every score (a new goal).
  check((count.goalMoved || 0) === dashes + (count.score || 0), `seed ${seed}: goalMoved count`);
  // Events and the array are reused: the pool stays as large as the busiest step.
  check(tr.pool.length <= 8, `seed ${seed}: event pool ${tr.pool.length} stays small`);
}
for (const type of ["score", "dashStart", "dashEnd", "goalMoved", "split", "join", "death"]) {
  check(total[type] > 0, `scripted worlds produce ${type}`);
}

// Heat: an enemy at the player then gone: heat holds and decays at the release rate.
{
  const tr = createEventTracker();
  const w = createWorld(3, 1280, 800);
  diffWorld(tr, w);
  const en = w.enemies.find((e) => e.kind === "hunter" || e.kind === "wanderer" || e.kind === "stalker");
  const others = w.enemies;
  w.enemies = [{ ...en, x: w.player.x, y: w.player.y }];
  diffWorld(tr, w);
  check(tr.heat === 1 && musicParams(tr).layers.arp, "heat 1 on contact; the arp joins");
  w.enemies = [];
  w.time += 1;
  diffWorld(tr, w);
  check(Math.abs(tr.heat - 0.6) < 1e-9, `heat after 1 s without threat: ${tr.heat}`);
  check(!musicParams(tr).layers.lead, "no lead before the first goal");
  w.enemies = others;
}

// A new world resets the tracker.
{
  const tr = createEventTracker();
  const a = createWorld(1, 1280, 800);
  diffWorld(tr, a);
  stepWorld(a, DT, { act: true });
  check(diffWorld(tr, a).some((e) => e.type === "dashStart"), "dash reported");
  check(diffWorld(tr, createWorld(2, 1280, 800)).length === 0, "a new world reports nothing");
}

// Pan: the camera centre is 0, the view edges reach the clamp.
{
  const w = createWorld(1, 1280, 800);
  const { x, scale } = w.camera;
  check(panOf(w, x) === 0, "pan 0 at the camera centre");
  check(panOf(w, x + 640 / scale) > 0.79 && panOf(w, x - 640 / scale) < -0.79, "pan at the edges");
  check(panOf(w, x + 1e6) <= 1 && panOf(w, x - 1e6) >= -1, "pan clamped");
}

// threat: 1 at the player, 0 beyond the range.
{
  const w = createWorld(1, 1280, 800);
  const en = w.enemies.find((e) => e.kind === "hunter" || e.kind === "wanderer" || e.kind === "stalker");
  const others = w.enemies;
  w.enemies = [{ ...en, x: w.player.x, y: w.player.y }];
  check(threat(w) === 1, "threat 1 on contact");
  w.enemies = [{ ...en, x: w.player.x + TUNING.threatRange * w.cell * 1.01, y: w.player.y }];
  check(threat(w) === 0, "threat 0 beyond the range");
  w.enemies = [];
  check(threat(w) === 0, "threat 0 without enemies");
  w.enemies = others;
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("events: all checks passed");
