// Headless difficulty sweep for docs/world.js: scripted players run full games and the script
// reports survival, goals, score, enemy count and pace per goal band. Not part of `npm test`.
//
//   node scripts/difficulty.js [capSeconds=180] [seeds=8] [policy]
//   SEED_FROM=i node scripts/difficulty.js 300 5 reactive   # seeds i..4 only, for parallel runs
//
// Policies: passive never dashes; reactive dashes when ready and a lethal enemy is within 0.55
// cells; cautious the same at 0.9 cells. Seeds are 1000 + 7919 * i. A run whose score is not
// finite hit a scoring bug and is listed as invalid instead of counted. The sim runs at roughly
// three times real time per process, so run seeds in parallel processes for long caps:
//   for i in 0 1 2 3 4; do SEED_FROM=$i node scripts/difficulty.js 300 $((i+1)) reactive & done

import { createWorld, stepWorld, isLethal, isActReady, difficultyAt } from "../docs/world.js";

const DT = 1 / 60;
const MAX_S = Number(process.argv[2] || 180);
const SEEDS = Number(process.argv[3] || 8);
const ONLY = process.argv[4];
const SEED_FROM = Number(process.env.SEED_FROM || 0);
const VIEW = { w: 1280, h: 800 };

const policies = {
  passive: () => false,
  reactive: (w) => isActReady(w) && nearestLethal(w) < 0.55,
  cautious: (w) => isActReady(w) && nearestLethal(w) < 0.9,
};

// Straight-line distance in cells from the player to the nearest lethal enemy.
function nearestLethal(w) {
  let best = Infinity;
  for (const en of w.enemies) {
    if (!isLethal(en)) continue;
    const d = Math.hypot(en.x - w.player.x, en.y - w.player.y) / w.cell;
    if (d < best) best = d;
  }
  return best;
}

function run(seed, policy) {
  const w = createWorld(seed, VIEW.w, VIEW.h);
  const goalAt = [];
  let dashes = 0;
  const maxSteps = Math.round(MAX_S / DT);
  for (let steps = 0; !w.dead && steps < maxSteps; steps++) {
    const act = policy(w);
    if (act) dashes++;
    const goals = w.goals;
    stepWorld(w, DT, { act });
    if (w.goals > goals) goalAt.push(w.time);
  }
  return { seed, time: w.time, goals: w.goals, score: w.score, enemies: w.enemies.length,
    dashes, dead: w.dead, goalAt };
}

const median = (rows, key) => {
  const v = rows.map((r) => r[key]).sort((a, b) => a - b);
  return v[v.length >> 1];
};
const mean = (rows, key) => rows.reduce((s, r) => s + r[key], 0) / rows.length;

const t0 = performance.now();
for (const [name, policy] of Object.entries(policies)) {
  if (ONLY && name !== ONLY) continue;
  const all = [];
  for (let i = SEED_FROM; i < SEEDS; i++) all.push(run(1000 + 7919 * i, policy));
  const invalid = all.filter((r) => !Number.isFinite(r.score));
  const rows = all.filter((r) => Number.isFinite(r.score));
  console.log(`\n== ${name}: seeds ${SEED_FROM}..${SEEDS - 1}, cap ${MAX_S}s`);
  if (invalid.length) {
    console.log(`  INVALID (non-finite score): seeds ${invalid.map((r) => r.seed).join(", ")}`);
  }
  if (rows.length === 0) continue;
  const capped = rows.filter((r) => !r.dead).length;
  console.log(`  survival s  median ${median(rows, "time").toFixed(0)}  mean ` +
    `${mean(rows, "time").toFixed(0)}  reached cap ${capped}`);
  console.log(`  goals       median ${median(rows, "goals")}  mean ${mean(rows, "goals").toFixed(1)}`);
  console.log(`  score       median ${median(rows, "score")}  mean ${mean(rows, "score").toFixed(0)}`);
  console.log(`  enemies at end median ${median(rows, "enemies")}   dashes mean ` +
    `${mean(rows, "dashes").toFixed(1)}`);
  console.log("  per seed: " +
    rows.map((r) => `${r.time.toFixed(0)}s/${r.goals}g/${r.enemies}e`).join("  "));
  // Pace: seconds per goal, pooled over the runs, in bands of five goals.
  const bands = {};
  for (const r of rows) {
    for (let i = 1; i < r.goalAt.length; i++) {
      const b = Math.floor(i / 5) * 5;
      (bands[b] ||= []).push(r.goalAt[i] - r.goalAt[i - 1]);
    }
  }
  console.log("  s per goal by goal band: " + Object.entries(bands)
    .map(([b, v]) => `${b}+:${(v.reduce((s, x) => s + x, 0) / v.length).toFixed(1)}`)
    .join("  "));
}
console.log("\nspawn table at goals 0/10/20/40/60: " + [0, 10, 20, 40, 60].map((g) => {
  const d = difficultyAt(g);
  return `${g}: spawn ${d.spawn.toFixed(2)} speed ${d.speed.toFixed(2)}`;
}).join(" | "));
console.log(`wall ${((performance.now() - t0) / 1000).toFixed(0)}s`);
