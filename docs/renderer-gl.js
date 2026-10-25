// Browser-only ES module: WebGL2 renderer with the same interface as renderer.js. All geometry is
// rebuilt every frame because the diagram is; buffers are reused and grown, never reallocated per
// frame once warm. Returns null if the browser cannot make a WebGL2 context, so main.js can fall
// back to Canvas2D.
//
// GLSL lives in template strings. Never put a backtick inside a shader comment; it terminates the
// template literal.

import { isAirborne, airProgress, pathReveal, threat, TUNING } from "./world.js";

const COLORS = {
  bg: [0.043, 0.051, 0.078, 1],
  cell: [0.07, 0.085, 0.16],     // fill at tone 0 (open ground): cold indigo
  cellB: [0.05, 0.12, 0.105],    // fill at tone 1 (dense ground): sea green
  hot: [0.55, 0.12, 0.20],
  // Biome ramp (world.biome, 0..1): water, grass, space (the plain `cell` ground with the
  // original rim glow and no tint), trees, snow.
  water: [0.06, 0.17, 0.32],
  grass: [0.12, 0.21, 0.12],
  trees: [0.05, 0.13, 0.09],
  snow: [0.40, 0.46, 0.56],
  rim: [0.36, 0.52, 0.95],       // cell edge glow at tone 0, scaled by u_glow
  rimB: [0.3, 0.88, 0.62],       // cell edge glow at tone 1
  hotRim: [1.0, 0.42, 0.42],
  goalCell: [0.42, 0.33, 0.13],  // cell tint around the goal
  goalRim: [1.0, 0.82, 0.4],
  playerCell: [0.2, 0.3, 0.46],  // cell tint around the player
  playerRim: [0.75, 0.9, 1.0],
  edge: [1, 1, 1, 0.02],         // edge lines at tone 0; alpha rises to edgeAlphaB at tone 1
  edgeAlphaB: 0.07,
  edgeDead: [0.55, 0.8, 1, 0.16], // edges closed to enemies: a pale lane the player may use
  route: [0.55, 0.75, 1, 0.95],
  routeHalo: [0.47, 0.67, 1, 0.22],
  goal: [0.84, 0.66, 0.29, 1],
  goalGlow: [0.84, 0.66, 0.29, 0.35],
  hunter: [1, 0.45, 0.25, 1],
  hunterGlow: [1, 0.45, 0.25, 0.5],
  wanderer: [0.95, 0.35, 0.8, 1],
  wandererGlow: [0.95, 0.35, 0.8, 0.5],
  stalker: [0.78, 1, 0.3, 1],
  stalkerGlow: [0.78, 1, 0.3, 0.5],
  splitter: [0.3, 0.95, 0.78, 1],
  splitterGlow: [0.3, 0.95, 0.78, 0.55],
  joiner: [0.62, 0.55, 1, 1],
  joinerGlow: [0.62, 0.55, 1, 0.55],
  outline: [0.03, 0.03, 0.06, 0.9],
  player: [1, 1, 1, 1],
  trail: [0.8, 0.9, 1],          // the player's fading trail (alpha from age)
  heading: [1, 1, 1, 0.9],       // the chevron ahead of the player
  boost: [0.35, 0.86, 1, 0.9],
  boostGlow: [0.35, 0.86, 1, 0.45],
  shadow: [0, 0, 0, 0.5],
  dim: [0.043, 0.051, 0.078, 0.55],
  vignette: [0, 0, 0, 0.35],     // screen-space darkening toward the corners; alpha is the max
};

// Camera: world -> screen is (p - u_cam) * u_scale + res / 2, in CSS pixels.
const VS_COMMON = `#version 300 es
uniform vec2 u_res;
uniform vec2 u_cam;
uniform float u_scale;
vec4 project(vec2 p) {
  vec2 s = (p - u_cam) * u_scale + u_res * 0.5;
  return vec4(s.x / u_res.x * 2.0 - 1.0, 1.0 - s.y / u_res.y * 2.0, 0.0, 1.0);
}
`;

// Cells: triangle fan per polygon. a_edge is an approximate distance to the polygon boundary
// (zero on the rim, the inradius at the centre) used for a glow that brightens toward the edges.
// a_tone is the cell's broad tone (world.tone): fill and rim colours and the glow's band mix
// blend between the tone-0 and tone-1 looks.
const CELL_VS = VS_COMMON + `
in vec2 a_pos;
in float a_edge;
in float a_heat;
in float a_goal;
in float a_player;
in float a_tone;
in float a_biome;
in float a_space;
in vec2 a_center;
out vec2 v_pos;
out vec2 v_center;
out float v_space;
out float v_edge;
out float v_heat;
out float v_goal;
out float v_player;
out float v_tone;
out float v_biome;
void main() {
  v_pos = a_pos;
  v_edge = a_edge;
  v_heat = a_heat;
  v_goal = a_goal;
  v_player = a_player;
  v_tone = a_tone;
  v_biome = a_biome;
  v_center = a_center;
  v_space = a_space;
  gl_Position = project(a_pos);
}
`;
const CELL_FS = `#version 300 es
precision mediump float;
uniform vec3 u_cell;
uniform vec3 u_cellB;
uniform vec3 u_water;     // biome ramp: water, grass, u_cell as space, trees, snow
uniform vec3 u_grass;
uniform vec3 u_trees;
uniform vec3 u_snow;
uniform vec3 u_hot;
uniform vec3 u_rim;
uniform vec3 u_rimB;
uniform vec3 u_hotRim;
uniform vec3 u_goalCell;
uniform vec3 u_goalRim;
uniform vec3 u_playerCell;
uniform vec3 u_playerRim;
uniform float u_glow;
uniform float u_zoom;     // camera scale, so glow band widths stay in screen pixels
uniform float u_time;
uniform vec2 u_player;
uniform float u_threat;   // 0..1, how close the nearest enemy is to the player
uniform float u_near;     // px, radius around the player that pulses with threat
in vec2 v_pos;
in float v_edge;
in float v_heat;
in float v_goal;
in float v_player;
in float v_tone;
in float v_biome;
in vec2 v_center;
in float v_space;
out vec4 o;
void main() {
  float heat = clamp(v_heat, 0.0, 1.0);
  float goal = clamp(v_goal, 0.0, 1.0);
  float ply = clamp(v_player, 0.0, 1.0);
  float tone = clamp(v_tone, 0.0, 1.0);
  // Biome ramp: water below 0.15, grass through the middle, trees around 0.8, snow above 0.95,
  // with smooth blends between, so neighbouring areas shade into each other; dense tone darkens
  // the ground toward the tone-1 colour. Space is a separate weight (world.space, its own very
  // broad field with a sharp edge): inside it the cell is the original look, the tone-0 to
  // tone-1 ground, untinted rim, full glow, flat, whatever the biome says.
  float b = clamp(v_biome, 0.0, 1.0);
  float toGrass = smoothstep(0.15, 0.3, b);
  float toTrees = smoothstep(0.62, 0.8, b);
  float toSnow = smoothstep(0.85, 0.95, b);
  float wSpace = clamp(v_space, 0.0, 1.0);
  float wGrass = toGrass * (1.0 - toTrees);
  float wTrees = toTrees * (1.0 - toSnow);
  vec3 bio = mix(u_water, u_grass, toGrass);
  bio = mix(bio, u_trees, toTrees);
  bio = mix(bio, u_snow, toSnow);
  vec3 ground = mix(mix(bio, mix(bio, u_cellB, 0.4), tone), mix(u_cell, u_cellB, tone), wSpace);
  // Cushion: grass and tree cells are shaded as soft domes, bright at the crown, lit on the
  // slopes that face the upper left and darker on the far slope and at the rim, so those areas
  // read as padded rather than flat; neighbouring domes meet in a dark seam like quilting.
  // Water and plain ground stay flat. 't' is 1 at the crown and 0 at the rim along any ray
  // from the centre, since v_edge falls to zero as the distance from the centre grows.
  float cushion = max(max(0.7 * wGrass, wTrees), 0.5 * toSnow) * (1.0 - wSpace);
  vec2 d = v_pos - v_center;
  float dl = length(d);
  float t = v_edge / max(1e-3, v_edge + dl);
  float h = 1.0 - (1.0 - t) * (1.0 - t);
  float lit = dl > 0.0 ? dot(d / dl, vec2(-0.6, -0.8)) : 0.0;
  float shade = 0.55 + 0.45 * h + 0.25 * (1.0 - h) * lit;
  ground *= mix(1.0, shade, cushion);
  vec3 base = mix(mix(mix(ground, u_goalCell, goal), u_playerCell, ply), u_hot, heat);
  // Two-band rim: a wide soft falloff plus a tight line at the edge itself. Open ground (tone 0)
  // is mostly the soft band; dense ground (tone 1) is mostly the crisp line.
  float wide = 1.0 - smoothstep(0.0, mix(22.0, 12.0, tone) / u_zoom, v_edge);
  float tight = 1.0 - smoothstep(0.0, 1.5 / u_zoom, v_edge);
  float wideK = mix(0.30, 0.10, tone);
  float tightK = mix(0.06, 0.20, tone);
  // The rim takes a little of the biome colour, brightened, so water glows blue and grass green;
  // not in space, which keeps the original rim.
  vec3 rim0 = mix(mix(u_rim, u_rimB, tone), bio * 3.0, 0.4 * (1.0 - wSpace));
  vec3 rim = mix(mix(mix(rim0, u_goalRim, goal), u_playerRim, ply), u_hotRim, heat);
  // Pulse: cells with enemies on them breathe; cells around the player breathe harder and
  // faster as an enemy closes in.
  float near = 1.0 - smoothstep(0.0, u_near, distance(v_pos, u_player));
  float amp = 0.6 * heat + 0.8 * u_threat * near + 0.3 * goal;
  float pulse = 1.0 + amp * (0.5 + 0.5 * sin(u_time * (5.0 + 9.0 * u_threat)));
  float band = (wideK * wide * wide + tightK * tight) * (1.0 - 0.6 * cushion);
  vec3 c = base + rim * u_glow * pulse * band * (1.0 + 1.5 * heat);
  o = vec4(c, 1.0);
}
`;

// Flat-coloured triangles: edge quads and the death overlay.
const FLAT_VS = VS_COMMON + `
in vec2 a_pos;
in vec4 a_color;
out vec4 v_color;
void main() {
  v_color = a_color;
  gl_Position = project(a_pos);
}
`;
const FLAT_FS = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 o;
void main() { o = v_color; }
`;

// Vignette: one clip-space quad over the whole screen, transparent at the centre and darkening
// toward the corners. Ignores the camera, so it never moves with the board.
const VIGNETTE_VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;
const VIGNETTE_FS = `#version 300 es
precision mediump float;
uniform vec4 u_color;
in vec2 v_uv;
out vec4 o;
void main() {
  // Elliptical falloff that follows the viewport: r2 is 0 at the centre, 1 at the edge
  // midpoints and 2 at the corners.
  float r2 = dot(v_uv, v_uv);
  o = vec4(u_color.rgb, u_color.a * smoothstep(0.35, 1.6, r2));
}
`;

// Dots: one quad each, circle in the fragment shader. a_ring < 0 draws a soft glow, 0 a filled
// disc, and 0 < a_ring < 1 a ring whose inner radius is that fraction.
const DOT_VS = VS_COMMON + `
in vec2 a_pos;
in vec2 a_uv;
in vec4 a_color;
in float a_ring;
in float a_soft;
out vec2 v_uv;
out vec4 v_color;
out float v_ring;
out float v_soft;
void main() {
  v_uv = a_uv;
  v_color = a_color;
  v_ring = a_ring;
  v_soft = a_soft;
  gl_Position = project(a_pos);
}
`;
const DOT_FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
in vec4 v_color;
in float v_ring;
in float v_soft;
out vec4 o;
void main() {
  float r = length(v_uv);
  float a;
  if (v_ring < 0.0) {
    float k = clamp(1.0 - r, 0.0, 1.0);
    a = k * k;
  } else {
    a = 1.0 - smoothstep(1.0 - v_soft, 1.0, r);
    if (v_ring > 0.0) a *= smoothstep(v_ring - v_soft, v_ring, r);
  }
  o = vec4(v_color.rgb, v_color.a * a);
}
`;

// Growable float buffer writer. Grows by doubling; stable after the first few frames.
class Writer {
  constructor(initial) {
    this.data = new Float32Array(initial);
    this.n = 0;
  }
  reset() {
    this.n = 0;
  }
  ensure(count) {
    if (this.n + count <= this.data.length) return;
    let size = this.data.length * 2;
    while (size < this.n + count) size *= 2;
    const next = new Float32Array(size);
    next.set(this.data.subarray(0, this.n));
    this.data = next;
  }
  push(...vals) {
    this.ensure(vals.length);
    for (let i = 0; i < vals.length; i++) this.data[this.n++] = vals[i];
  }
}

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error("shader: " + log);
  }
  return sh;
}

function program(gl, vs, fs, attribs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error("link: " + gl.getProgramInfoLog(p));
  }
  // attribs: [[name, size], ...] laid out interleaved in that order.
  const stride = attribs.reduce((s, a) => s + a[1], 0) * 4;
  const vao = gl.createVertexArray();
  const buf = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  let offset = 0;
  for (const [name, size] of attribs) {
    const loc = gl.getAttribLocation(p, name);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
    offset += size * 4;
  }
  gl.bindVertexArray(null);
  const floatsPerVertex = stride / 4;
  return { p, vao, buf, floatsPerVertex, u_res: gl.getUniformLocation(p, "u_res"),
    u_cam: gl.getUniformLocation(p, "u_cam"), u_scale: gl.getUniformLocation(p, "u_scale") };
}

export function createRendererGL(canvas) {
  const gl = canvas.getContext("webgl2", { antialias: true, alpha: false,
    premultipliedAlpha: false });
  if (!gl) return null;

  let width = 0;
  let height = 0;

  let cells;
  let flat;
  let dots;
  let vignette;
  try {
    cells = program(gl, CELL_VS, CELL_FS,
      [["a_pos", 2], ["a_edge", 1], ["a_heat", 1], ["a_goal", 1], ["a_player", 1], ["a_tone", 1],
        ["a_biome", 1], ["a_space", 1], ["a_center", 2]]);
    flat = program(gl, FLAT_VS, FLAT_FS, [["a_pos", 2], ["a_color", 4]]);
    dots = program(gl, DOT_VS, DOT_FS,
      [["a_pos", 2], ["a_uv", 2], ["a_color", 4], ["a_ring", 1], ["a_soft", 1]]);
    vignette = program(gl, VIGNETTE_VS, VIGNETTE_FS, [["a_pos", 2]]);
  } catch (err) {
    console.warn("renderer-gl:", err.message);
    return null;
  }
  const u_cell = gl.getUniformLocation(cells.p, "u_cell");
  const u_cellB = gl.getUniformLocation(cells.p, "u_cellB");
  const u_water = gl.getUniformLocation(cells.p, "u_water");
  const u_grass = gl.getUniformLocation(cells.p, "u_grass");
  const u_trees = gl.getUniformLocation(cells.p, "u_trees");
  const u_snow = gl.getUniformLocation(cells.p, "u_snow");
  const u_hot = gl.getUniformLocation(cells.p, "u_hot");
  const u_rim = gl.getUniformLocation(cells.p, "u_rim");
  const u_rimB = gl.getUniformLocation(cells.p, "u_rimB");
  const u_hotRim = gl.getUniformLocation(cells.p, "u_hotRim");
  const u_goalCell = gl.getUniformLocation(cells.p, "u_goalCell");
  const u_goalRim = gl.getUniformLocation(cells.p, "u_goalRim");
  const u_playerCell = gl.getUniformLocation(cells.p, "u_playerCell");
  const u_playerRim = gl.getUniformLocation(cells.p, "u_playerRim");
  const u_glow = gl.getUniformLocation(cells.p, "u_glow");
  const u_zoom = gl.getUniformLocation(cells.p, "u_zoom");
  const u_time = gl.getUniformLocation(cells.p, "u_time");
  const u_player = gl.getUniformLocation(cells.p, "u_player");
  const u_threat = gl.getUniformLocation(cells.p, "u_threat");
  const u_near = gl.getUniformLocation(cells.p, "u_near");
  const CELL_GLOW = 0.5;   // overall strength of the cell rim glow
  // Enemies fade with distance from the player: full inside ENEMY_FADE_NEAR cells, down to
  // ENEMY_FADE_MIN of their alpha at ENEMY_FADE_FAR, so a crowd far away does not compete with
  // the ones that matter.
  const ENEMY_FADE_NEAR = 2.5;
  const ENEMY_FADE_FAR = 6.5;
  const ENEMY_FADE_MIN = 0.3;
  const GOAL_BEACON = 1.6; // s; period of the ring that expands from the goal
  const GOAL_SPARKS = 3;   // dots orbiting the goal
  const GOAL_SPIN = 1.8;   // rad / s
  const TIME_WRAP = Math.PI * 2 * 1000; // keeps sin(u_time * k) precise; k has <= 1 decimal

  const cellW = new Writer(1 << 15);
  const edgeW = new Writer(1 << 14);
  const routeW = new Writer(1 << 12);
  const dotW = new Writer(1 << 12);
  // The vignette quad never changes: two clip-space triangles, colour set once.
  const vignetteW = new Writer(12);
  vignetteW.data.set([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
  vignetteW.n = 12;
  gl.useProgram(vignette.p);
  gl.uniform4f(gl.getUniformLocation(vignette.p, "u_color"), ...COLORS.vignette);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.disable(gl.DEPTH_TEST);

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  function upload(prog, writer) {
    gl.bindBuffer(gl.ARRAY_BUFFER, prog.buf);
    gl.bufferData(gl.ARRAY_BUFFER, writer.data.subarray(0, writer.n), gl.DYNAMIC_DRAW);
  }

  let cam = { x: 0, y: 0, scale: 1 };

  function drawProgram(prog, writer) {
    if (writer.n === 0) return;
    gl.useProgram(prog.p);
    gl.uniform2f(prog.u_res, width, height);
    gl.uniform2f(prog.u_cam, cam.x, cam.y);
    gl.uniform1f(prog.u_scale, cam.scale);
    upload(prog, writer);
    gl.bindVertexArray(prog.vao);
    gl.drawArrays(gl.TRIANGLES, 0, writer.n / prog.floatsPerVertex);
    gl.bindVertexArray(null);
  }

  // Distance from (cx, cy) to the nearest polygon edge: the fan centre's a_edge value.
  function inradius(poly, cx, cy) {
    let m = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const d = Math.abs((cx - a.x) * dy - (cy - a.y) * dx) / len;
      if (d < m) m = d;
    }
    return m;
  }

  function fan(poly, cx, cy, heat, goal, ply, tone, biome, space) {
    const r = inradius(poly, cx, cy);
    cellW.ensure(poly.length * 33);
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      cellW.push(cx, cy, r, heat, goal, ply, tone, biome, space, cx, cy,
        a.x, a.y, 0, heat, goal, ply, tone, biome, space, cx, cy,
        b.x, b.y, 0, heat, goal, ply, tone, biome, space, cx, cy);
    }
  }

  // The tone of an edge: the mean of its one or two cells' tones.
  function edgeTone(world, e) {
    const ids = e.cells;
    let t = 0;
    for (let i = 0; i < ids.length; i++) t += world.tone[world.siteIndex.get(ids[i])];
    return ids.length ? t / ids.length : 0;
  }

  function quad(w, ax, ay, bx, by, halfWidth, c) {
    let nx = by - ay;
    let ny = ax - bx;
    const len = Math.hypot(nx, ny);
    if (len === 0) return;
    nx = nx / len * halfWidth;
    ny = ny / len * halfWidth;
    w.ensure(36);
    w.push(ax + nx, ay + ny, c[0], c[1], c[2], c[3], bx + nx, by + ny, c[0], c[1], c[2], c[3],
      bx - nx, by - ny, c[0], c[1], c[2], c[3]);
    w.push(ax + nx, ay + ny, c[0], c[1], c[2], c[3], bx - nx, by - ny, c[0], c[1], c[2], c[3],
      ax - nx, ay - ny, c[0], c[1], c[2], c[3]);
  }

  function tri(w, ax, ay, bx, by, cx, cy, c) {
    w.ensure(18);
    w.push(ax, ay, c[0], c[1], c[2], c[3], bx, by, c[0], c[1], c[2], c[3],
      cx, cy, c[0], c[1], c[2], c[3]);
  }

  // The player's trail (oldest first, thin and faint to wide and brighter, ending at the player)
  // and a chevron a fifth of a cell ahead along the path. Both into `w` (flat program).
  function playerMarks(w, world, px, py, pxl) {
    const { trail, path, cell } = world;
    const n = TUNING.trailSamples;
    const tc = [COLORS.trail[0], COLORS.trail[1], COLORS.trail[2], 0];
    let ax = trail[2 * (world.trailHead % n)];
    let ay = trail[2 * (world.trailHead % n) + 1];
    for (let k = 1; k <= n; k++) {
      const bx = k < n ? trail[2 * ((world.trailHead + k) % n)] : px;
      const by = k < n ? trail[2 * ((world.trailHead + k) % n) + 1] : py;
      const f = k / n;
      tc[3] = 0.55 * f * f;
      quad(w, ax, ay, bx, by, (0.6 + 2.2 * f) * pxl, tc);
      ax = bx;
      ay = by;
    }
    // Heading: toward the second path sample, which is a little way along the route.
    let dx = path[4] - path[0];
    let dy = path[5] - path[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return;
    dx /= len;
    dy /= len;
    const tipD = 0.2 * cell;
    const baseD = 0.11 * cell;
    const half = 0.055 * cell;
    tri(w, px + dx * tipD, py + dy * tipD,
      px + dx * baseD - dy * half, py + dy * baseD + dx * half,
      px + dx * baseD + dy * half, py + dy * baseD - dx * half, COLORS.heading);
  }

  // `c` with its alpha scaled by `a`, written into the scratch `out` (no per-enemy allocation).
  const FADE_BODY = [0, 0, 0, 0];
  const FADE_GLOW = [0, 0, 0, 0];
  const FADE_OUTLINE = [0, 0, 0, 0];
  const FADE_DIM = [0, 0, 0, 0];
  function faded(c, a, out) {
    out[0] = c[0];
    out[1] = c[1];
    out[2] = c[2];
    out[3] = c[3] * a;
    return out;
  }

  function dot(x, y, r, c, ring = 0) {
    const soft = Math.min(0.5, 1.5 / (r * cam.scale));
    dotW.ensure(60);
    const v = (ux, uy) => dotW.push(x + ux * r, y + uy * r, ux, uy, c[0], c[1], c[2], c[3], ring, soft);
    v(-1, -1); v(1, -1); v(1, 1);
    v(-1, -1); v(1, 1); v(-1, 1);
  }

  function draw(world) {
    gl.clearColor(...COLORS.bg);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!world) return;
    const { diagram, graph, heat, goalHeat, playerHeat, tone, biome, space, player, cell } = world;
    cam = world.camera;
    const px = 1 / cam.scale; // one screen pixel in world units

    cellW.reset();
    for (let i = 0; i < diagram.cells.length; i++) {
      const c = diagram.cells[i];
      fan(c.polygon, c.centroid.x, c.centroid.y, heat[i], goalHeat[i], playerHeat[i], tone[i],
        biome[i], space[i]);
    }
    gl.useProgram(cells.p);
    gl.uniform3f(u_cell, ...COLORS.cell);
    gl.uniform3f(u_cellB, ...COLORS.cellB);
    gl.uniform3f(u_water, ...COLORS.water);
    gl.uniform3f(u_grass, ...COLORS.grass);
    gl.uniform3f(u_trees, ...COLORS.trees);
    gl.uniform3f(u_snow, ...COLORS.snow);
    gl.uniform3f(u_hot, ...COLORS.hot);
    gl.uniform3f(u_rim, ...COLORS.rim);
    gl.uniform3f(u_rimB, ...COLORS.rimB);
    gl.uniform3f(u_hotRim, ...COLORS.hotRim);
    gl.uniform3f(u_goalCell, ...COLORS.goalCell);
    gl.uniform3f(u_goalRim, ...COLORS.goalRim);
    gl.uniform3f(u_playerCell, ...COLORS.playerCell);
    gl.uniform3f(u_playerRim, ...COLORS.playerRim);
    gl.uniform1f(u_glow, CELL_GLOW);
    gl.uniform1f(u_zoom, cam.scale);
    gl.uniform1f(u_time, world.time % TIME_WRAP);
    gl.uniform2f(u_player, player.x, player.y);
    gl.uniform1f(u_threat, threat(world));
    gl.uniform1f(u_near, TUNING.threatRange * cell);
    drawProgram(cells, cellW);

    edgeW.reset();
    routeW.reset();
    // Edge lines: faint and thin on open ground, brighter and a little wider on dense ground.
    // Dead edges (closed to enemies) are a pale tinted line at a fixed width.
    const ec = [COLORS.edge[0], COLORS.edge[1], COLORS.edge[2], 0];
    for (const e of graph.edges.values()) {
      const a = graph.nodes.get(e.a);
      const b = graph.nodes.get(e.b);
      if (e.dead) {
        quad(edgeW, a.x, a.y, b.x, b.y, 0.45 * px, COLORS.edgeDead);
        continue;
      }
      const t = edgeTone(world, e);
      ec[3] = COLORS.edge[3] + (COLORS.edgeAlphaB - COLORS.edge[3]) * t;
      quad(edgeW, a.x, a.y, b.x, b.y, (0.2 + 0.2 * t) * px, ec);
    }
    // The smoothed path, player first, fading toward the goal. A wide faint halo under a bright
    // core keeps it readable over glowing cells.
    // A new leg's route grows from the player: `pathReveal` says how many segments to draw, the
    // last of them cut short.
    const path = world.path;
    const segs = path.length / 2 - 1;
    const rc = [COLORS.route[0], COLORS.route[1], COLORS.route[2], 0];
    const hc = [COLORS.routeHalo[0], COLORS.routeHalo[1], COLORS.routeHalo[2], 0];
    const shown = pathReveal(world) * segs;
    for (let i = 0; i < segs && i < shown; i++) {
      const fade = 1 - 0.7 * i / Math.max(1, segs - 1);
      hc[3] = COLORS.routeHalo[3] * fade;
      rc[3] = COLORS.route[3] * fade;
      const k = Math.min(1, shown - i);
      const ex = path[2 * i] + (path[2 * i + 2] - path[2 * i]) * k;
      const ey = path[2 * i + 1] + (path[2 * i + 3] - path[2 * i + 1]) * k;
      quad(routeW, path[2 * i], path[2 * i + 1], ex, ey, 5 * px, hc);
      quad(routeW, path[2 * i], path[2 * i + 1], ex, ey, 1.8 * px, rc);
    }
    drawProgram(flat, edgeW);
    drawProgram(flat, routeW);

    // Trail and heading chevron, under the dots. Airborne they follow the lifted player.
    const air = isAirborne(world);
    const liftK = air ? airProgress(world) : 0;
    const lift = 4 * liftK * (1 - liftK);
    routeW.reset();
    playerMarks(routeW, world, player.x, player.y - lift * cell * 0.35, px);
    drawProgram(flat, routeW);

    dotW.reset();
    // Goal: a halo and orbit that shrink with the points lost to dashes, a pulsing ring that
    // flares when the goal moves, a beacon ring expanding and fading every GOAL_BEACON seconds
    // since the goal was set, sparks orbiting, and the centre dot.
    const pulse = 0.5 + 0.5 * Math.sin(world.time * 4);
    const since = world.time - world.goalMovedAt;
    const flare = Math.max(0, 1 - since / 0.4);
    const value = Math.pow(TUNING.dashPenalty, world.legDashes);
    const gx = world.goalX;
    const gy = world.goalY;
    const gr = cell * (0.12 + 0.04 * pulse + 0.1 * flare);
    const gc = COLORS.goal;
    dot(gx, gy, gr * (2.0 + 1.6 * value), COLORS.goalGlow, -1);
    const beacon = (since / GOAL_BEACON) % 1;
    const bfade = (1 - beacon) * (1 - beacon) * 0.6;
    dot(gx, gy, cell * (0.14 + 0.75 * beacon), [gc[0], gc[1], gc[2], bfade], 0.92);
    dot(gx, gy, gr, gc, 0.72);
    const orbit = cell * (0.17 + 0.13 * value);
    for (let k = 0; k < GOAL_SPARKS; k++) {
      const a = world.time * GOAL_SPIN + k * Math.PI * 2 / GOAL_SPARKS;
      const sx = gx + Math.cos(a) * orbit;
      const sy = gy + Math.sin(a) * orbit;
      dot(sx, sy, cell * 0.08, COLORS.goalGlow, -1);
      dot(sx, sy, cell * 0.022, gc);
    }
    dot(gx, gy, cell * 0.04, gc);

    // Enemies: glow, dark outline, body, all faded by distance from the player, and a shape per
    // kind built from dots around the heading (toX, toY) and the clock. Hunters are arrowheads
    // trailing two embers, wanderers sway and carry a satellite, stalkers are an eye whose pupil
    // looks where they go, splitters are two lobes breathing apart, joiners a ring tightening on
    // an inner one. The outline keeps them readable over hot cells. The phase per enemy comes
    // from its index, so neighbours do not pulse in step.
    const er = cell * 0.085;
    const fadeNear = ENEMY_FADE_NEAR * cell;
    const fadeSpan = (ENEMY_FADE_FAR - ENEMY_FADE_NEAR) * cell;
    const t = world.time;
    let idx = 0;
    for (const en of world.enemies) {
      const d = Math.hypot(en.x - player.x, en.y - player.y);
      const k = Math.min(1, Math.max(0, (d - fadeNear) / fadeSpan));
      const a = 1 - (1 - ENEMY_FADE_MIN) * k;
      const c = faded(COLORS[en.kind], a, FADE_BODY);
      const g = faded(COLORS[en.kind + "Glow"], a, FADE_GLOW);
      const o = faded(COLORS.outline, a, FADE_OUTLINE);
      const dim = faded(COLORS[en.kind], a * 0.55, FADE_DIM);
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
      if (en.kind === "hunter") {
        const pulse = 0.85 + 0.15 * Math.sin(t * 9 + ph);
        const sx = x + hx * er * 0.9;
        const sy = y + hy * er * 0.9;
        dot(x, y, er * 3.2 * pulse, g, -1);
        dot(x, y, er * 1.35, o);
        dot(sx, sy, er * 0.8, o);
        dot(x, y, er, c);
        dot(sx, sy, er * 0.45, c);
        for (let j = 1; j <= 2; j++) {
          const back = er * (0.9 + 0.75 * j);
          const side = er * 0.35 * Math.sin(t * 10 + ph + j * 2.1);
          dot(x - hx * back + nx * side, y - hy * back + ny * side, er * (0.4 - 0.1 * j), dim);
        }
      } else if (en.kind === "wanderer") {
        const sway = er * 0.45 * Math.sin(t * 3 + ph);
        const bx = x + nx * sway;
        const by = y + ny * sway;
        const oa = t * 2.5 + ph;
        const ox = bx + Math.cos(oa) * er * 1.9;
        const oy = by + Math.sin(oa) * er * 1.9;
        dot(bx, by, er * 3.2, g, -1);
        dot(bx, by, er * 1.35, o);
        dot(bx, by, er, c);
        dot(ox, oy, er * 0.55, o);
        dot(ox, oy, er * 0.3, c);
      } else if (en.kind === "stalker") {
        const pulse = 0.9 + 0.1 * Math.sin(t * 7 + ph);
        dot(x, y, er * 3.2 * pulse, g, -1);
        dot(x, y, er * 1.5, o);
        dot(x, y, er * 1.15, c, 0.6);
        dot(x + hx * er * 0.3, y + hy * er * 0.3, er * 0.38, c);
      } else if (en.kind === "splitter") {
        const sep = er * (0.35 + 0.4 * (0.5 + 0.5 * Math.sin(t * 2.2 + ph)));
        dot(x, y, er * 4, g, -1);
        for (let s = -1; s <= 1; s += 2) {
          const lx = x + nx * sep * s;
          const ly = y + ny * sep * s;
          dot(lx, ly, er * 1.3, o);
          dot(lx, ly, er * 0.95, c, 0.45);
        }
      } else {
        const squeeze = 0.8 + 0.2 * Math.sin(t * 3 + ph);
        dot(x, y, er * 4, g, -1);
        dot(x, y, er * 1.6, o);
        dot(x, y, er * 1.25 * squeeze, c, 0.5);
        dot(x, y, er * 0.45 * (2 - squeeze), c, 0.5);
      }
    }

    // Board edits: an expanding, fading ring in the modifier's colour. A join is otherwise
    // instantaneous and would go unnoticed.
    for (const f of world.flashes) {
      const k = Math.min(1, (world.time - f.start) / TUNING.flashDuration);
      const c = COLORS[f.kind];
      const fade = (1 - k) * (1 - k);
      dot(f.x, f.y, cell * (0.15 + 1.1 * k), [c[0], c[1], c[2], 0.9 * fade], 0.86);
      dot(f.x, f.y, cell * (0.3 + 0.6 * k), [c[0], c[1], c[2], 0.5 * fade], -1);
    }

    const pr = cell * 0.07;
    if (air) {
      const py = player.y - lift * cell * 0.35;
      dot(player.x, player.y + lift * cell * 0.1, pr * 0.8, COLORS.shadow);
      dot(player.x, py, pr * 4, COLORS.boostGlow, -1);
      dot(player.x, py, pr * 2.2, COLORS.boost, 0.8);
      dot(player.x, py, pr * (1 + 0.6 * lift), COLORS.player);
    } else {
      dot(player.x, player.y, pr * 3.2, [1, 1, 1, 0.22], -1);
      dot(player.x, player.y, pr, COLORS.player);
    }
    drawProgram(dots, dotW);

    if (world.dead) {
      // Cover the visible world rectangle.
      const hw = width * px / 2;
      const hh = height * px / 2;
      edgeW.reset();
      quad(edgeW, cam.x - hw, cam.y, cam.x + hw, cam.y, hh, COLORS.dim);
      drawProgram(flat, edgeW);
    }

    drawProgram(vignette, vignetteW);
  }

  resize();
  return { resize, draw, get width() { return width; }, get height() { return height; } };
}
