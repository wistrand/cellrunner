// Browser-only ES module: Canvas2D renderer. Owns the canvas, DPR scaling and all drawing. It
// reads the world object produced by world.js and knows nothing about rules.

import { isAirborne, airProgress, cooldownLeft, pathReveal, spawnProgress, TUNING }
  from "./world.js";

const COLORS = {
  bg: "#0b0d14",
  cell: [18, 22, 41],      // RGB at tone 0 (open ground), blended toward `hot` by enemy density
  cellB: [13, 31, 27],     // RGB at tone 1 (dense ground)
  hot: [140, 30, 50],
  goalCell: [107, 84, 33],  // RGB; blended in around the goal
  playerCell: [51, 77, 117], // RGB; blended in around the player
  edgeAlpha: [0.02, 0.07], // edge line alpha at tone 0 and tone 1
  edgeDead: "rgba(140,204,255,0.16)", // edges closed to enemies: a pale lane the player may use
  vignetteAlpha: 0.35,     // screen-space darkening toward the corners; the max alpha
  route: [140, 190, 255, 0.95], // RGBA; alpha fades along the route
  goal: "#d6a94a",
  hunter: "#ff7340",
  wanderer: "#f259cc",
  stalker: "#c7ff4d",
  splitter: "#4debbf",
  joiner: "#998cff",
  outline: "rgba(8,8,15,0.9)",
  stomp: "#ffffff",        // flash where a stomp killed an enemy
  stompMiss: "#8099bf",    // flash under the player when a stomp found nothing
  player: "#ffffff",
  trail: [204, 230, 255],  // RGB; alpha from age
  heading: "rgba(255,255,255,0.9)",
  boost: "rgba(90,220,255,0.9)",
  shadow: "rgba(0,0,0,0.5)",
};

const EDGE_BUCKETS = 4;
// Enemies fade with distance from the player: full inside ENEMY_FADE_NEAR cells, down to
// ENEMY_FADE_MIN at ENEMY_FADE_FAR, so a far crowd does not compete with the ones that matter.
const ENEMY_FADE_NEAR = 2.5;
const ENEMY_FADE_FAR = 6.5;
const ENEMY_FADE_MIN = 0.3;
const GOAL_BEACON = 1.6; // s; period of the ring that expands from the goal
const GOAL_SPARKS = 3;   // dots orbiting the goal
const GOAL_SPIN = 1.8;   // rad / s

export function createRenderer(canvas) {
  const ctx = canvas.getContext("2d");
  let width = 0;
  let height = 0;
  let dpr = 1;
  // Vignette in a unit space (the viewport is [-1, 1] on both axes, so the falloff is
  // elliptical and follows the screen), drawn under a scaling transform. Radii match the GL
  // shader's smoothstep on r squared: 0.35 and 1.6.
  const vignette = ctx.createRadialGradient(0, 0, Math.sqrt(0.35), 0, 0, Math.sqrt(1.6));
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, `rgba(0,0,0,${COLORS.vignetteAlpha})`);

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function tracePolygon(poly) {
    ctx.beginPath();
    ctx.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
    ctx.closePath();
  }

  function mix(a, b, k) {
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  }

  function cellFill(tone, heat, goal, ply) {
    const ground = mix(COLORS.cell, COLORS.cellB, tone);
    const tinted = mix(mix(ground, COLORS.goalCell, Math.min(1, goal)), COLORS.playerCell,
      Math.min(1, ply));
    const c = mix(tinted, COLORS.hot, Math.min(1, heat));
    return `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
  }

  function dot(x, y, r, fill) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
  }

  function ring(x, y, r, width, stroke) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.lineWidth = width;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }

  function draw(world) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, width, height);
    if (!world) return;
    const { diagram, graph, heat, goalHeat, playerHeat, tone, player, cell } = world;
    // Camera: world -> screen is (p - cam) * scale + size / 2. Line widths are divided by the
    // scale so they stay in screen pixels.
    const cam = world.camera;
    const sc = cam.scale;
    const px = 1 / sc;
    ctx.setTransform(dpr * sc, 0, 0, dpr * sc,
      dpr * (width / 2 - cam.x * sc), dpr * (height / 2 - cam.y * sc));

    for (let i = 0; i < diagram.cells.length; i++) {
      tracePolygon(diagram.cells[i].polygon);
      ctx.fillStyle = cellFill(tone[i], heat[i], goalHeat[i], playerHeat[i]);
      ctx.fill();
    }

    // Edge lines, faint on open ground and brighter on dense ground. Edges are bucketed by the
    // mean tone of their cells into a few strokes rather than one stroke per edge.
    const [ea0, ea1] = COLORS.edgeAlpha;
    for (let k = 0; k < EDGE_BUCKETS; k++) {
      const t = (k + 0.5) / EDGE_BUCKETS;
      ctx.lineWidth = (0.4 + 0.4 * t) * px;
      ctx.strokeStyle = `rgba(255,255,255,${(ea0 + (ea1 - ea0) * t).toFixed(3)})`;
      ctx.beginPath();
      for (const e of graph.edges.values()) {
        if (e.dead) continue;
        let et = 0;
        for (const id of e.cells) et += tone[world.siteIndex.get(id)];
        et = e.cells.length ? et / e.cells.length : 0;
        if (Math.min(EDGE_BUCKETS - 1, Math.floor(et * EDGE_BUCKETS)) !== k) continue;
        const a = graph.nodes.get(e.a);
        const b = graph.nodes.get(e.b);
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
    }
    // Dead edges (closed to enemies): one pass, a pale tinted line at a fixed width.
    ctx.lineWidth = 0.9 * px;
    ctx.strokeStyle = COLORS.edgeDead;
    ctx.beginPath();
    for (const e of graph.edges.values()) {
      if (!e.dead) continue;
      const a = graph.nodes.get(e.a);
      const b = graph.nodes.get(e.b);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();

    // The smoothed path, player first, fading toward the goal.
    ctx.lineWidth = 3 * px;
    ctx.lineCap = "round";
    // A new leg's route grows from the player: `pathReveal` says how many segments to draw, the
    // last of them cut short.
    const path = world.path;
    const segs = path.length / 2 - 1;
    const [rr, rg, rb, ra] = COLORS.route;
    const shown = pathReveal(world) * segs;
    for (let i = 0; i < segs && i < shown; i++) {
      const alpha = ra * (1 - 0.7 * i / Math.max(1, segs - 1));
      const k = Math.min(1, shown - i);
      ctx.strokeStyle = `rgba(${rr},${rg},${rb},${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(path[2 * i], path[2 * i + 1]);
      ctx.lineTo(path[2 * i] + (path[2 * i + 2] - path[2 * i]) * k,
        path[2 * i + 1] + (path[2 * i + 3] - path[2 * i + 1]) * k);
      ctx.stroke();
    }

    // Goal: a beacon ring expanding and fading every GOAL_BEACON seconds since the goal was set,
    // a pulsing ring that flares when the goal moves, sparks orbiting at a radius that shrinks
    // with the points lost to dashes, and the centre dot. (GL adds the halo.)
    const pulse = 0.5 + 0.5 * Math.sin(world.time * 4);
    const since = world.time - world.goalMovedAt;
    const flare = Math.max(0, 1 - since / 0.4);
    const value = Math.pow(TUNING.dashPenalty, world.legDashes);
    const gx = world.goalX;
    const gy = world.goalY;
    const beacon = (since / GOAL_BEACON) % 1;
    ctx.beginPath();
    ctx.arc(gx, gy, cell * (0.14 + 0.75 * beacon), 0, Math.PI * 2);
    ctx.lineWidth = 1.5 * px;
    ctx.globalAlpha = (1 - beacon) * (1 - beacon) * 0.6;
    ctx.strokeStyle = COLORS.goal;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(gx, gy, cell * (0.12 + 0.04 * pulse + 0.1 * flare), 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = COLORS.goal;
    ctx.stroke();
    const orbit = cell * (0.17 + 0.13 * value);
    for (let k = 0; k < GOAL_SPARKS; k++) {
      const a = world.time * GOAL_SPIN + k * Math.PI * 2 / GOAL_SPARKS;
      dot(gx + Math.cos(a) * orbit, gy + Math.sin(a) * orbit, cell * 0.022, COLORS.goal);
    }
    dot(gx, gy, cell * 0.04, COLORS.goal);

    // Enemies: dark outline under the body so they read over hot cells, faded by distance from
    // the player. Lethal kinds are filled discs; board modifiers are hollow rings.
    const erBase = cell * 0.085;
    const fadeNear = ENEMY_FADE_NEAR * cell;
    const fadeSpan = (ENEMY_FADE_FAR - ENEMY_FADE_NEAR) * cell;
    // A shape per kind around the heading (toX, toY) and the clock, as in GL without the glow:
    // hunters are arrowheads trailing an ember, wanderers sway with a satellite, stalkers an eye
    // whose pupil looks ahead, splitters two lobes breathing apart, joiners a ring tightening on
    // an inner one.
    const t = world.time;
    let idx = 0;
    for (const en of world.enemies) {
      const d = Math.hypot(en.x - player.x, en.y - player.y);
      const k = Math.min(1, Math.max(0, (d - fadeNear) / fadeSpan));
      const alpha = 1 - (1 - ENEMY_FADE_MIN) * k;
      ctx.globalAlpha = alpha;
      const fill = COLORS[en.kind];
      let hx = en.toX - en.x;
      let hy = en.toY - en.y;
      const hl = Math.hypot(hx, hy);
      if (hl > 1e-6) {
        hx /= hl;
        hy /= hl;
      } else {
        hx = 1;
        hy = 0;
      }
      const nx = -hy;
      const ny = hx;
      const ph = idx++ * 1.7;
      const x = en.x;
      const y = en.y;
      // Spawn-in: a fresh or leashed-in enemy grows from a third of its size over spawnGrace,
      // inside an expanding, fading ring in its colour, and cannot kill until it is full size.
      const s = spawnProgress(world, en);
      const er = erBase * (0.3 + 0.7 * s);
      if (s < 1) {
        ctx.globalAlpha = alpha * (1 - s);
        ring(x, y, erBase * (1 + 3 * s), 1.5 * px, fill);
        ctx.globalAlpha = alpha;
      }
      if (en.kind === "hunter") {
        const sx = x + hx * er * 0.9;
        const sy = y + hy * er * 0.9;
        dot(x, y, er * 1.35, COLORS.outline);
        dot(sx, sy, er * 0.8, COLORS.outline);
        dot(x, y, er, fill);
        dot(sx, sy, er * 0.45, fill);
        const side = er * 0.35 * Math.sin(t * 10 + ph);
        ctx.globalAlpha = alpha * 0.55;
        dot(x - hx * er * 1.65 + nx * side, y - hy * er * 1.65 + ny * side, er * 0.3, fill);
      } else if (en.kind === "wanderer") {
        const sway = er * 0.45 * Math.sin(t * 3 + ph);
        const bx = x + nx * sway;
        const by = y + ny * sway;
        const oa = t * 2.5 + ph;
        const ox = bx + Math.cos(oa) * er * 1.9;
        const oy = by + Math.sin(oa) * er * 1.9;
        dot(bx, by, er * 1.35, COLORS.outline);
        dot(bx, by, er, fill);
        dot(ox, oy, er * 0.55, COLORS.outline);
        dot(ox, oy, er * 0.3, fill);
      } else if (en.kind === "stalker") {
        dot(x, y, er * 1.5, COLORS.outline);
        ring(x, y, er * 0.9, er * 0.45, fill);
        dot(x + hx * er * 0.3, y + hy * er * 0.3, er * 0.38, fill);
      } else if (en.kind === "splitter") {
        const sep = er * (0.35 + 0.4 * (0.5 + 0.5 * Math.sin(t * 2.2 + ph)));
        for (let s = -1; s <= 1; s += 2) {
          const lx = x + nx * sep * s;
          const ly = y + ny * sep * s;
          dot(lx, ly, er * 1.3, COLORS.outline);
          ring(lx, ly, er * 0.7, er * 0.5, fill);
        }
      } else {
        const squeeze = 0.8 + 0.2 * Math.sin(t * 3 + ph);
        dot(x, y, er * 1.6, COLORS.outline);
        ring(x, y, er * 0.95 * squeeze, er * 0.5, fill);
        ring(x, y, er * 0.35 * (2 - squeeze), er * 0.2, fill);
      }
    }
    ctx.globalAlpha = 1;

    // Board edits: an expanding, fading ring in the modifier's colour.
    for (const f of world.flashes) {
      const k = Math.min(1, (world.time - f.start) / TUNING.flashDuration);
      ctx.beginPath();
      ctx.arc(f.x, f.y, cell * (0.15 + 1.1 * k), 0, Math.PI * 2);
      ctx.lineWidth = (2.5 * (1 - k) + 0.5) * px;
      ctx.globalAlpha = (1 - k) * (1 - k);
      ctx.strokeStyle = COLORS[f.kind];
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Trail (oldest first, thin and faint to wide and brighter) and the heading chevron a fifth
    // of a cell ahead along the path. Airborne they follow the lifted player.
    const pr = cell * 0.07;
    const air = isAirborne(world);
    const liftK = air ? airProgress(world) : 0;
    const lift = 4 * liftK * (1 - liftK);
    const ply = player.y - lift * cell * 0.35;
    const trail = world.trail;
    const tn = TUNING.trailSamples;
    const [tr, tg, tb] = COLORS.trail;
    ctx.lineCap = "round";
    let ax = trail[2 * (world.trailHead % tn)];
    let ay = trail[2 * (world.trailHead % tn) + 1];
    for (let k = 1; k <= tn; k++) {
      const bx = k < tn ? trail[2 * ((world.trailHead + k) % tn)] : player.x;
      const by = k < tn ? trail[2 * ((world.trailHead + k) % tn) + 1] : ply;
      const f = k / tn;
      ctx.strokeStyle = `rgba(${tr},${tg},${tb},${(0.55 * f * f).toFixed(3)})`;
      ctx.lineWidth = (1.2 + 4.4 * f) * px;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ax = bx;
      ay = by;
    }
    let hx = path[4] - path[0];
    let hy = path[5] - path[1];
    const hlen = Math.hypot(hx, hy);
    if (hlen > 1e-6) {
      hx /= hlen;
      hy /= hlen;
      const tipD = 0.2 * cell;
      const baseD = 0.11 * cell;
      const half = 0.055 * cell;
      ctx.beginPath();
      ctx.moveTo(player.x + hx * tipD, ply + hy * tipD);
      ctx.lineTo(player.x + hx * baseD - hy * half, ply + hy * baseD + hx * half);
      ctx.lineTo(player.x + hx * baseD + hy * half, ply + hy * baseD - hx * half);
      ctx.closePath();
      ctx.fillStyle = COLORS.heading;
      ctx.fill();
    }
    if (air) {
      dot(player.x, player.y + lift * cell * 0.1, pr * 0.8, COLORS.shadow);
      ctx.beginPath();
      ctx.arc(player.x, player.y - lift * cell * 0.35, pr * 2.2, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = COLORS.boost;
      ctx.stroke();
      dot(player.x, player.y - lift * cell * 0.35, pr * (1 + 0.6 * lift), COLORS.player);
    } else {
      // Landing cooldown: the dash ring stays after touchdown and shrinks into the player as
      // the cooldown runs out, so the moment the next dash is allowed is visible.
      const cd = cooldownLeft(world);
      if (cd > 0) {
        ctx.globalAlpha = 0.35 + 0.65 * cd;
        ring(player.x, player.y, pr * (1 + 1.2 * cd), 2, COLORS.boost);
        ctx.globalAlpha = 1;
      }
      dot(player.x, player.y, pr, COLORS.player);
    }

    if (world.dead) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "rgba(11,13,20,0.55)";
      ctx.fillRect(0, 0, width, height);
    }

    ctx.setTransform(dpr * width / 2, 0, 0, dpr * height / 2, dpr * width / 2, dpr * height / 2);
    ctx.fillStyle = vignette;
    ctx.fillRect(-1, -1, 2, 2);
  }

  resize();
  return { resize, draw, get width() { return width; }, get height() { return height; } };
}
