// Headless smoke test for docs/world.js: step a world for a while with scripted input and check it
// stays sane and deterministic. Run via `npm test`.

import { createWorld, stepWorld, continueWorld, TUNING, spawnWeightsAt, ENEMY_KINDS }
  from "../docs/world.js";
import { isBorderNode } from "../docs/graph.js";

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    failures++;
    console.error("FAIL:", msg);
  }
}

function run(seed, w, h, steps) {
  const world = createWorld(seed, w, h);
  const dt = 1 / 60;
  for (let i = 0; i < steps && !world.dead; i++) {
    const input = { act: i % 75 === 0 };
    stepWorld(world, dt, input);
    const p = world.player;
    const b = world.bounds;
    check(Number.isFinite(p.x) && Number.isFinite(p.y), `seed ${seed} step ${i}: player finite`);
    check(p.x >= b.x - 1 && p.x <= b.x + b.w + 1 && p.y >= b.y - 1 && p.y <= b.y + b.h + 1,
      `seed ${seed} step ${i}: player inside bounds (${p.x}, ${p.y})`);
    check(world.goalX >= b.x && world.goalX <= b.x + b.w && world.goalY >= b.y &&
      world.goalY <= b.y + b.h, `seed ${seed} step ${i}: goal inside bounds`);
    const cam = world.camera;
    check(Number.isFinite(cam.x) && Number.isFinite(cam.y) && cam.scale > 0,
      `seed ${seed} step ${i}: camera finite`);
    check(world.graph.nodes.has(p.node), `seed ${seed} step ${i}: player anchor node exists`);
    check(world.path.every(Number.isFinite), `seed ${seed} step ${i}: path finite`);
    // A goal reachable only over dead edges once scored Infinity; the leg must always be finite.
    check(Number.isFinite(world.score) && Number.isFinite(world.legBase) && world.legBase > 0,
      `seed ${seed} step ${i}: score and leg finite`);
    check(world.path[0] === p.x && world.path[1] === p.y,
      `seed ${seed} step ${i}: path starts at the player`);
    for (const en of world.enemies) {
      check(world.graph.edges.has(en.edge), `seed ${seed} step ${i}: enemy edge exists`);
      check(en.t >= 0 && en.t <= 1, `seed ${seed} step ${i}: enemy t in range`);
    }
    for (const s of world.sites) {
      check(s.x >= b.x && s.x <= b.x + b.w && s.y >= b.y && s.y <= b.y + b.h,
        `seed ${seed} step ${i}: site in bounds`);
    }
    check(world.graph.nodes.has(world.goal), `seed ${seed} step ${i}: goal node exists`);
    const n = world.sites.length;
    const r = world.region;
    const cells = (r.c1 - r.c0 + 1) * (r.r1 - r.r0 + 1);
    check(n <= Math.ceil(cells * TUNING.siteCountMax) + 2 * (r.c1 - r.c0 + r.r1 - r.r0 + 2),
      `seed ${seed} step ${i}: site count ${n} within limits for ${cells} grid cells`);
    check(new Set(world.sites.map((s) => s.id)).size === n, `seed ${seed} step ${i}: site ids unique`);
    check(world.homes.length === n && world.vel.length === n,
      `seed ${seed} step ${i}: homes and vel track sites`);
    check(!isBorderNode(world.goal), `seed ${seed} step ${i}: goal is not on the border`);
    if (failures > 20) break;
  }
  return world;
}

for (const seed of [3, 99, 2024]) {
  const a = run(seed, 900, 700, 1200);
  const b = run(seed, 900, 700, 1200);
  check(a.player.x === b.player.x && a.player.y === b.player.y && a.score === b.score &&
    a.time === b.time, `seed ${seed}: deterministic replay`);
  check(a.enemies.length >= TUNING.enemiesStart, `seed ${seed}: enemies present`);
  // The roster follows the spawn table: no kind before its weight turns on, and every kind
  // within two goals of it (spawns come at least every other goal).
  const w = spawnWeightsAt(a.goals);
  const w2 = spawnWeightsAt(Math.max(0, a.goals - 2));
  for (const kind of ENEMY_KINDS) {
    const present = a.enemies.some((e) => e.kind === kind);
    check(present || !(w2[kind] > 0), `seed ${seed}: ${kind} missing after ${a.goals} goals`);
    check(!present || w[kind] > 0, `seed ${seed}: ${kind} early after ${a.goals} goals`);
  }
  const modifiers = a.enemies.some((e) => e.kind === "splitter" || e.kind === "joiner");
  check(a.editCount > 0 || !modifiers || a.dead, `seed ${seed}: the board was edited`);
  check(a.score === 0 || a.region.r0 < 0 || a.region.c0 < 0 || a.region.c1 > 20,
    `seed ${seed}: reaching goals grew the board (score ${a.score})`);
}

// Portrait phone-sized viewport.
run(11, 390, 800, 600);

// Continue after death: same board and goals, score reset, enemies moved off, and the world keeps
// its invariants when stepped on.
{
  const w = createWorld(99, 900, 700);
  for (let i = 0; i < 6000 && !w.dead; i++) stepWorld(w, 1 / 60, { act: i % 75 === 0 });
  if (w.dead) {
    const goals = w.goals;
    const n = w.enemies.length;
    continueWorld(w);
    check(!w.dead && w.score === 0 && w.goals === goals && w.enemies.length === n,
      "continue: alive, score reset, goals and roster kept");
    const minD = TUNING.spawnMinDist * w.cell;
    check(w.enemies.every((en) => Math.hypot(en.x - w.player.x, en.y - w.player.y) >= minD * 0.5),
      "continue: enemies moved away from the player");
    for (let i = 0; i < 120; i++) {
      stepWorld(w, 1 / 60, { act: false });
      check(w.path[0] === w.player.x && w.path[1] === w.player.y, `continue step ${i}: path start`);
      for (const en of w.enemies) {
        check(w.graph.edges.has(en.edge) && en.t >= 0 && en.t <= 1,
          `continue step ${i}: enemy on edge`);
      }
      if (failures > 20) break;
    }
  } else {
    console.log("continue: seed 99 did not die in 100 s; continue untested");
  }
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("world: all checks passed");
