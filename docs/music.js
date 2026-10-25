// Pure ES module: seeded music composition for the procedural audio (agent_docs/plan-audio.md).
// Browser + node; no DOM, no Web Audio, no time: notes are in beats, and docs/audio.js (phase B)
// turns beats into AudioContext time. Ported from undead-composer's lib/music.ts (MIT, same
// author): scales, diatonic chords, voice leading, bass feels, arps, and the two-tier melody
// (a descending structural line elaborated by figures, developing one motif cell).
//
// A run's piece comes from its seed alone (`composeRun`), on its own random streams
// (`hashSeed(seed, label)`); never from world.rand, whose draw order is part of the seed contract
// (gotchas.md). Rendering is a pure function of (piece, part, bars): any window of bars renders
// the same notes however it is requested, so the scheduler can ask for a few bars at a time.

import { mulberry32 } from "./voronoi.js";

// Note: { pitch: MIDI 0..127, start: beats from the run's start, duration: beats,
// velocity: 1..127 }.

export const SCALES = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
};

// Progressions per scale: four scale degrees, one chord per bar. A piece picks two (A and B).
const PROGRESSIONS = {
  minor: [[1, 6, 3, 7], [1, 4, 6, 5], [6, 4, 1, 5], [1, 7, 6, 7], [1, 4, 7, 3]],
  dorian: [[1, 4, 1, 7], [1, 2, 4, 1], [1, 7, 4, 4], [1, 4, 2, 7]],
  phrygian: [[1, 2, 1, 7], [1, 2, 3, 2], [1, 7, 6, 2], [1, 4, 2, 1]],
};

export const BEATS_PER_BAR = 4;
export const SECTION_BARS = 4;
const FORM = ["A", "A", "B", "A"]; // which progression each section uses, cycling
const CONTOURS = ["arch", "wave", "arch", "fall"]; // lead contour per section, cycling
export const PARTS = ["pad", "bass", "arp", "lead"];

// Registers (octave numbers; octave 4 puts C4 at MIDI 60).
const OCT = { pad: 4, bass: 2, arp: 4, lead: 5 };

// A 32-bit seed for one labelled stream of a run (FNV-1a over the label, mixed with the seed).
export function hashSeed(seed, label) {
  let h = (0x811c9dc5 ^ (seed >>> 0)) >>> 0;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  return h >>> 0 || 1;
}

// ---------------------------------------------------------------------------------------------
// Pitch helpers
// ---------------------------------------------------------------------------------------------

// Diatonic pitch for a 1-based scale degree (degrees above 7 or below 1 wrap by octaves).
// key: pitch class 0..11 of the tonic.
export function degreeToMidi(degree, key, scale, octave) {
  const iv = SCALES[scale];
  const idx = degree - 1;
  const octShift = Math.floor(idx / 7);
  return (octave + 1) * 12 + key + iv[((idx % 7) + 7) % 7] + 12 * octShift;
}

// Scale degrees of a triad on a degree (stacked thirds).
const triadDegs = (degree) => [degree, degree + 2, degree + 4];

// The diatonic triad on a scale degree, root position, at an octave.
export function chordTones(degree, key, scale, octave) {
  return triadDegs(degree).map((d) => degreeToMidi(d, key, scale, octave));
}

// Voice leading: the inversion and octave placement of `tones` whose voices move least from
// `prev` (sorted L1 distance), staying within an octave of its centre. Deterministic argmin.
export function voiceLead(tones, prev) {
  if (!prev || !tones.length) return tones;
  const base = [...tones].sort((a, b) => a - b);
  const prevSorted = [...prev].sort((a, b) => a - b);
  const prevCentre = prevSorted.reduce((a, b) => a + b, 0) / prevSorted.length;
  const cost = (v) => {
    const s = [...v].sort((a, b) => a - b);
    let d = 0;
    for (let i = 0; i < Math.min(s.length, prevSorted.length); i++) d += Math.abs(s[i] - prevSorted[i]);
    return d;
  };
  let best = base;
  let bestCost = Infinity;
  for (let k = 0; k < base.length; k++) {
    const inv = base.map((t, i) => (i < k ? t + 12 : t));
    for (const oct of [-12, 0, 12]) {
      const cand = inv.map((t) => t + oct);
      const centre = cand.reduce((a, b) => a + b, 0) / cand.length;
      if (Math.abs(centre - prevCentre) > 12) continue;
      const c = cost(cand);
      if (c < bestCost) { bestCost = c; best = cand; }
    }
  }
  return best;
}

const clampVel = (v) => Math.max(1, Math.min(127, Math.round(v)));
const clampPitch = (p) => Math.max(0, Math.min(127, Math.round(p)));
const r4 = (n) => Math.round(n * 1e4) / 1e4;

// ---------------------------------------------------------------------------------------------
// The piece
// ---------------------------------------------------------------------------------------------

// Motif cells: a short rhythm ([beatOffset, duration] within about 2 beats) and an interval shape
// (scale-degree moves between successive notes). The lead develops one cell all run.
const MOTIF_RHYTHMS = [
  [[0, 0.5], [0.5, 0.5], [1, 1]],
  [[0, 1], [1, 0.5], [1.5, 0.5]],
  [[0, 0.5], [0.5, 1], [1.5, 0.5]],
  [[0, 1], [1, 1]],
  [[0, 0.5], [0.5, 0.5], [1, 0.5], [1.5, 0.5]],
  [[0, 0.5], [0.5, 1.5]],
  [[0, 0.75], [0.75, 0.75], [1.5, 0.5]],
  [[0, 0.75], [1.5, 0.5]],
  [[0.5, 0.5], [1, 0.5], [1.5, 0.5]],
];
const MOTIF_SHAPES = [[2, -1], [1, 1], [-1, -1], [2, 1], [-2, 1], [1, -2], [3, -1], [1, 1, -1]];

function inventMotif(variation, density) {
  const pool = density < 0.4 ? MOTIF_RHYTHMS.slice(0, 4) : MOTIF_RHYTHMS;
  return {
    rhythm: pool[variation % pool.length],
    shape: MOTIF_SHAPES[(variation * 7 + 3) % MOTIF_SHAPES.length],
  };
}

// The run's piece: key, scale, two progressions, tempo, a hook cell and per-run choices for the
// bass feel and arp direction. A pure function of the seed.
export function composeRun(seed) {
  const r = mulberry32(hashSeed(seed, "piece"));
  const pick = (list) => list[Math.floor(r() * list.length)];
  const scale = pick(Object.keys(SCALES));
  const key = Math.floor(r() * 12);
  const progs = PROGRESSIONS[scale];
  const a = Math.floor(r() * progs.length);
  const b = (a + 1 + Math.floor(r() * (progs.length - 1))) % progs.length; // never the same as A
  return Object.freeze({
    seed: seed >>> 0,
    key,
    scale,
    bpm: 96 + Math.floor(r() * 13),
    progressions: [progs[a], progs[b]],
    hook: inventMotif(Math.floor(r() * 72), 0.6),
    bassFeel: pick(["root", "octave", "offbeat"]),
    arpDir: Math.floor(r() * 3), // 0 up, 1 up-down, 2 down
  });
}

// The progression of a section, and the chord degree of a bar (one chord per bar).
export function sectionProgression(piece, section) {
  return piece.progressions[FORM[section % FORM.length] === "A" ? 0 : 1];
}
export function chordDegreeAt(piece, bar) {
  return sectionProgression(piece, Math.floor(bar / SECTION_BARS))[bar % SECTION_BARS];
}
// The chord of a bar as MIDI tones at an octave (for SFX that should fit the harmony).
export function chordAt(piece, bar, octave = 5) {
  return chordTones(chordDegreeAt(piece, bar), piece.key, piece.scale, octave);
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

// Notes of a part for bars [fromBar, fromBar + nBars), sorted by start. params: energy (0..1,
// loudness) and density (0..1, notes per beat for bass, arp and lead). Notes starting before
// fromBar are left out even if they ring into the window.
export function renderBars(piece, part, fromBar, nBars, { energy = 0.5, density = 0.5 } = {}) {
  const lo = fromBar * BEATS_PER_BAR;
  const hi = (fromBar + nBars) * BEATS_PER_BAR;
  const first = Math.floor(fromBar / SECTION_BARS);
  const last = Math.floor((fromBar + nBars - 1) / SECTION_BARS);
  const out = [];
  for (let s = first; s <= last; s++) {
    for (const n of renderSection(piece, part, s, energy, density)) {
      if (n.start >= lo && n.start < hi) out.push(n);
    }
  }
  return out.sort((x, y) => x.start - y.start || x.pitch - y.pitch);
}

function renderSection(piece, part, s, energy, density) {
  if (part === "pad") return renderPad(piece, s, energy);
  if (part === "bass") return renderBass(piece, s, energy, density);
  if (part === "arp") return renderArp(piece, s, energy, density);
  if (part === "lead") return renderLead(piece, s, energy, density);
  throw new Error(`unknown part ${part}`);
}

// A bar's chord, voiced as close as possible to one fixed reference (the tonic triad at the
// part's octave): consecutive chords then hold common tones and move by small steps, and a bar
// renders the same whichever window it is asked in. Leading from the previous bar's root position
// instead let voicings drift by octaves (a 42-semitone block jump on seed 7).
function voicedBar(piece, bar, octave) {
  const tones = chordTones(chordDegreeAt(piece, bar), piece.key, piece.scale, octave);
  return voiceLead(tones, chordTones(1, piece.key, piece.scale, octave));
}

function renderPad(piece, s, energy) {
  const notes = [];
  const vel = clampVel(44 + energy * 30);
  for (let i = 0; i < SECTION_BARS; i++) {
    const bar = s * SECTION_BARS + i;
    for (const pitch of voicedBar(piece, bar, OCT.pad)) {
      notes.push({ pitch, start: bar * BEATS_PER_BAR, duration: BEATS_PER_BAR, velocity: vel });
    }
  }
  return notes;
}

// Bass feels (from undead-composer's renderBass): root (steady pulse, walks into a change),
// octave (low/high alternation), offbeat (accented "and", approach note into a change). 8ths, or
// 16ths for root/offbeat when dense. Per-section draws pick among chord-tone turns.
function renderBass(piece, s, energy, density) {
  const notes = [];
  const { key, scale } = piece;
  const vel = clampVel(70 + energy * 40);
  const oct = OCT.bass;
  const rnd = mulberry32(hashSeed(piece.seed, `bass:${s}`));
  const feel = piece.bassFeel;
  const octavePhase = rnd() > 0.5;
  const approachInto = (next) => degreeToMidi(next - 1, key, scale, oct);
  const per = density > 0.66 && feel !== "octave" ? 4 : 2;
  for (let i = 0; i < SECTION_BARS; i++) {
    const bar = s * SECTION_BARS + i;
    const degree = chordDegreeAt(piece, bar);
    const next = chordDegreeAt(piece, bar + 1);
    const root = degreeToMidi(degree, key, scale, oct);
    const fifth = degreeToMidi(degree + 4, key, scale, oct);
    const changes = next !== degree;
    const hits = BEATS_PER_BAR * per;
    const step = 1 / per;
    for (let h = 0; h < hits; h++) {
      const off = h % 2 === 1;
      const lastHit = h === hits - 1;
      let pitch = root;
      let v = vel;
      if (feel === "octave") {
        const high = octavePhase ? !off : off;
        pitch = high ? root + 12 : root;
        v = vel - (high ? 6 : 0);
      } else if (feel === "offbeat") {
        if (lastHit && changes) {
          const r = rnd();
          pitch = r < 0.6 ? approachInto(next) : r < 0.85 ? degreeToMidi(next + 1, key, scale, oct) : fifth;
        } else if (lastHit && energy > 0.5) pitch = rnd() < 0.6 ? root + 12 : fifth;
        else if (hits >= 4 && h === hits - 2 && rnd() > 0.7) pitch = fifth;
        v = off ? vel : vel - 12;
      } else if (lastHit && changes && rnd() > 0.6) {
        pitch = approachInto(next);
      }
      notes.push({
        pitch: clampPitch(pitch),
        start: r4(bar * BEATS_PER_BAR + h * step),
        duration: r4(step * 0.9),
        velocity: clampVel(v),
      });
    }
  }
  return notes;
}

// Arp: the bar's voiced chord over two octaves, up, up-down or down (per run), 8ths or 16ths.
function renderArp(piece, s, energy, density) {
  const notes = [];
  const vel = clampVel(60 + energy * 40);
  const per = density < 0.5 ? 2 : 4;
  for (let i = 0; i < SECTION_BARS; i++) {
    const bar = s * SECTION_BARS + i;
    const tones = voicedBar(piece, bar, OCT.arp);
    const pool = [...tones, ...tones.map((t) => t + 12)];
    const seq = piece.arpDir === 2 ? [...pool].reverse()
      : piece.arpDir === 1 ? [...pool, ...pool.slice(1, -1).reverse()]
      : pool;
    const steps = BEATS_PER_BAR * per;
    for (let k = 0; k < steps; k++) {
      const t = bar * BEATS_PER_BAR + k / per;
      notes.push({
        pitch: clampPitch(seq[k % seq.length]),
        start: r4(t),
        duration: r4((1 / per) * 0.9),
        velocity: clampVel(Number.isInteger(t) ? vel : vel - 12),
      });
    }
  }
  return notes;
}

// ---------------------------------------------------------------------------------------------
// The lead: two-tier melody per section (undead-composer's melodySkeleton + composeMelody).
// Tier 1: a structural line descending from a head tone to the tonic, snapped to chord tones.
// Tier 2: each bar a figure (step, leap + gap-fill, neighbour, arpeggio, appoggiatura, repeat,
// or the hook) resolving onto that target, steered by a leap budget. The section's last note is
// the tonic, held.
// ---------------------------------------------------------------------------------------------

function nearestChordTone(target, chord) {
  let best = chord;
  let bestDist = Infinity;
  for (const o of triadDegs(chord)) {
    for (const k of [-14, -7, 0, 7, 14]) {
      const dist = Math.abs(o + k - target);
      if (dist < bestDist) { bestDist = dist; best = o + k; }
    }
  }
  return best;
}

function contourHeight(contour, bar, bars, climax) {
  const t = bars <= 1 ? 0.5 : bar / (bars - 1);
  const h = contour === "rise" ? t
    : contour === "fall" ? 1 - t
    : contour === "wave" ? 0.5 + 0.5 * Math.sin(t * Math.PI * 2)
    : Math.sin(t * Math.PI);
  return Math.max(0, Math.min(1, climax ? h + 0.3 : h));
}

// The section's structural line: one scale degree per bar, ending on the tonic.
export function melodySkeleton(prog, bars, variation, contour) {
  const phraseLen = Math.max(2, Math.min(4, bars));
  const head = [5, 3, 8][variation % 3];
  const nPhrases = Math.max(1, Math.ceil(bars / phraseLen));
  const ascend = contour === "rise";
  const bg = (p) => { const f = p / nPhrases; return ascend ? 1 + (head - 1) * f : head - (head - 1) * f; };
  const out = [];
  for (let bar = 0; bar < bars; bar++) {
    if (bar === bars - 1) { out.push(1); continue; }
    const p = Math.floor(bar / phraseLen);
    const u = (bar % phraseLen) / Math.max(1, phraseLen - 1);
    const arch = (p % 2 === 0 && phraseLen >= 3) ? 2 * Math.sin(u * Math.PI) : 0;
    const skel = bg(p) + (bg(Math.min(nPhrases, p + 1)) - bg(p)) * u + arch;
    out.push(nearestChordTone(Math.round(skel), prog[bar % prog.length]));
  }
  return out;
}

function pickFigure(variation, bar, inPhrase, isCadence, isClimax, wantLeap) {
  if (inPhrase === 0 || isClimax) return "hook";
  if (isCadence) return wantLeap ? "appogg" : "step";
  const set = wantLeap ? ["leapfill", "arp", "appogg"] : ["neighbor", "repeat", "step"];
  return set[(variation * 3 + bar * 5 + (isClimax ? 1 : 0)) % set.length];
}

function realizeFigure(fig, from, to, n, chord, shape, nb) {
  const out = [];
  if (fig === "repeat") {
    for (let k = 0; k < n; k++) out.push(to);
  } else if (fig === "neighbor") {
    for (let k = 0; k < n; k++) out.push(k % 2 === 0 ? to : to + nb);
  } else if (fig === "appogg") {
    out.push(to + 1);
    for (let k = 1; k < n; k++) out.push(to);
  } else if (fig === "leapfill") {
    const peak = nearestChordTone(to + 3, chord);
    for (let k = 0; k < n; k++) out.push(Math.round(peak + (to - peak) * (k / Math.max(1, n - 1))));
  } else if (fig === "arp") {
    const cts = triadDegs(chord).map((c) => {
      let x = c;
      while (x - to > 3) x -= 7;
      while (to - x > 3) x += 7;
      return x;
    }).sort((a, b) => a - b);
    for (let k = 0; k < n; k++) out.push(cts[k % cts.length]);
  } else if (fig === "hook") {
    out.push(to);
    for (let k = 1; k < n; k++) out.push(out[k - 1] + (shape[(k - 1) % Math.max(1, shape.length)] ?? 0));
    return out; // a free gesture, not forced onto `to`
  } else { // step: a directed run onto `to`
    const dir = to >= from ? 1 : -1;
    for (let k = 0; k < n; k++) out.push(to - (n - 1 - k) * dir);
  }
  out[n - 1] = to;
  return out;
}

function renderLead(piece, s, energy, density) {
  const notes = [];
  const { key, scale } = piece;
  const prog = sectionProgression(piece, s);
  const bars = SECTION_BARS;
  const reg = OCT.lead;
  const variation = hashSeed(piece.seed, `lead:${s}`) % 72; // each section develops differently
  const contour = CONTOURS[s % CONTOURS.length];
  const vel0 = 74 + energy * 38;
  const phraseLen = Math.max(2, Math.min(4, bars));
  const cell = piece.hook;
  const CELL_BEATS = 2;
  const seqStep = variation % 2 ? 1 : 2;
  // Fold anything above tonic + 14 semitones down by octaves (keeps the pitch class).
  const ceiling = degreeToMidi(1, key, scale, reg) + 14;
  const capped = (p) => { while (p > ceiling) p -= 12; return p; };
  const skel = melodySkeleton(prog, bars, variation, contour);
  const tonicNear = (ref) => { let d = 1; while (d - ref > 3) d -= 7; while (ref - d > 3) d += 7; return d; };
  const LEAP_TARGET = 0.38;
  let leaps = 0;
  let moves = 0;
  let prevDeg = skel[0];
  for (let bar = 0; bar < bars; bar++) {
    const chord = prog[bar % prog.length];
    const inPhrase = bar % phraseLen;
    const isCadence = inPhrase === phraseLen - 1;
    const isClimax = phraseLen >= 4 && inPhrase === 2;
    const isFinal = bar === bars - 1;
    const height = contourHeight(contour, bar, bars, isClimax);
    const target = isFinal ? tonicNear(prevDeg) : skel[bar];
    const rhythm = isCadence ? cell.rhythm.slice(0, Math.max(1, Math.ceil(cell.rhythm.length / 2))) : cell.rhythm;
    const statements = !isCadence && density > 0.5 && cell.rhythm.length <= 3 ? 2 : 1;
    const wantLeap = moves > 0 && leaps / moves < LEAP_TARGET;
    const fig = pickFigure(variation, bar, inPhrase, isCadence, isClimax, wantLeap);
    const nb = (variation + bar) % 2 ? 1 : -1;
    const barBeat = (s * SECTION_BARS + bar) * BEATS_PER_BAR;
    let lastIdx = -1;
    for (let st = 0; st < statements; st++) {
      const base = st * CELL_BEATS;
      if (base >= BEATS_PER_BAR) break;
      const to = target + (st === 0 ? 0 : seqStep);
      const degs = realizeFigure(fig, prevDeg, to, rhythm.length, chord, cell.shape, nb);
      rhythm.forEach(([b, d], k) => {
        const at = base + b;
        if (at >= BEATS_PER_BAR) return;
        const deg = degs[k] ?? to;
        if (moves > 0 || k > 0) { moves++; if (Math.abs(deg - prevDeg) >= 3) leaps++; }
        const strong = Number.isInteger(at);
        const arc = vel0 - 16 + height * 24 + (strong ? 8 : 0) + (isClimax ? 6 : 0);
        notes.push({
          pitch: clampPitch(capped(degreeToMidi(deg, key, scale, reg))),
          start: r4(barBeat + at),
          duration: r4(d * 0.9),
          velocity: clampVel(arc),
        });
        prevDeg = deg;
        lastIdx = notes.length - 1;
      });
    }
    // Hold the cadence and final notes so the phrase completes.
    if ((isCadence || isFinal) && lastIdx >= 0) {
      notes[lastIdx] = { ...notes[lastIdx], duration: r4(Math.max(notes[lastIdx].duration, 1.5)) };
    }
  }
  return notes;
}
