// Node test runner for docs/music.js. Run via `npm test`.

import {
  composeRun, renderBars, chordAt, chordDegreeAt, degreeToMidi, voiceLead, hashSeed,
  SCALES, PARTS, BEATS_PER_BAR, SECTION_BARS,
} from "../docs/music.js";

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    failures++;
    console.error("FAIL:", msg);
  }
}

const SEEDS = [1, 7, 12345, 0xdeadbeef, 424242];
const BARS = 32; // eight sections

// FNV-1a over a string, for the regression fingerprint below.
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16);
}

for (const seed of SEEDS) {
  const piece = composeRun(seed);
  const pcs = new Set(SCALES[piece.scale].map((i) => (i + piece.key) % 12));

  // Same seed, same music: the piece and every part.
  check(JSON.stringify(composeRun(seed)) === JSON.stringify(piece), `seed ${seed}: piece repeats`);
  check(piece.progressions[0].join() !== piece.progressions[1].join(), `seed ${seed}: A and B differ`);
  check(piece.bpm >= 96 && piece.bpm <= 108, `seed ${seed}: tempo ${piece.bpm} in 96..108`);

  for (const part of PARTS) {
    const notes = renderBars(piece, part, 0, BARS);
    check(notes.length > 0, `seed ${seed} ${part}: has notes`);
    check(JSON.stringify(renderBars(piece, part, 0, BARS)) === JSON.stringify(notes),
      `seed ${seed} ${part}: renders the same twice`);

    // Any window renders the same notes: the scheduler asks a few bars at a time.
    const pieces = [];
    for (let b = 0; b < BARS; b += 3) pieces.push(...renderBars(piece, part, b, Math.min(3, BARS - b)));
    check(JSON.stringify(pieces) === JSON.stringify(notes), `seed ${seed} ${part}: window independent`);

    let prevStart = -1;
    for (const n of notes) {
      check(pcs.has(n.pitch % 12), `seed ${seed} ${part}: pitch ${n.pitch} in ${piece.scale} on ${piece.key}`);
      check(Number.isInteger(n.pitch) && n.pitch >= 0 && n.pitch <= 127, `seed ${seed} ${part}: pitch range`);
      check(n.velocity >= 1 && n.velocity <= 127, `seed ${seed} ${part}: velocity range`);
      check(n.duration > 0, `seed ${seed} ${part}: positive duration`);
      check(n.start >= 0 && n.start < BARS * BEATS_PER_BAR, `seed ${seed} ${part}: start in window`);
      check(n.start >= prevStart, `seed ${seed} ${part}: sorted by start`);
      prevStart = n.start;
    }
  }

  // Pad voice leading: consecutive bars move a little, not by an octave block.
  const pad = renderBars(piece, "pad", 0, BARS);
  for (let bar = 1; bar < BARS; bar++) {
    const at = (b) => pad.filter((n) => n.start === b * BEATS_PER_BAR).map((n) => n.pitch).sort((x, y) => x - y);
    const a = at(bar - 1), b = at(bar);
    const move = a.reduce((sum, p, i) => sum + Math.abs(p - b[i]), 0);
    check(move <= 12, `seed ${seed}: pad bar ${bar} moves ${move} semitones (<= 12)`);
    // The pad plays the bar's chord.
    const chordPcs = new Set(chordAt(piece, bar).map((p) => p % 12));
    check(b.every((p) => chordPcs.has(p % 12)), `seed ${seed}: pad bar ${bar} is the bar's chord`);
  }

  // The lead resolves each section onto the tonic and stays under its ceiling.
  const tonicPc = piece.key % 12;
  const ceiling = degreeToMidi(1, piece.key, piece.scale, 5) + 14;
  for (let s = 0; s < BARS / SECTION_BARS; s++) {
    const lead = renderBars(piece, "lead", s * SECTION_BARS, SECTION_BARS);
    const last = lead[lead.length - 1];
    check(last && last.pitch % 12 === tonicPc, `seed ${seed}: lead section ${s} ends on the tonic`);
    check(lead.every((n) => n.pitch <= ceiling), `seed ${seed}: lead section ${s} under the ceiling`);
  }

  // Bass stays in its band: from a step below the tonic in its octave (approach notes) to two
  // octaves above it (a high root plus the octave feel's lift).
  const bassLo = degreeToMidi(1, piece.key, piece.scale, 2) - 2;
  const bass = renderBars(piece, "bass", 0, BARS);
  check(bass.every((n) => n.pitch >= bassLo && n.pitch <= bassLo + 26),
    `seed ${seed}: bass within ${bassLo}..${bassLo + 26}`);
}

// Different seeds give different music (keys, scales or progressions).
const signatures = new Set(SEEDS.map((s) => { const p = composeRun(s); return `${p.key}/${p.scale}/${p.progressions}`; }));
check(signatures.size === SEEDS.length, `different seeds give different pieces (${signatures.size}/${SEEDS.length})`);

// Streams: labels and seeds give distinct, stable values.
check(hashSeed(1, "bass:0") !== hashSeed(1, "bass:1"), "hashSeed: labels differ");
check(hashSeed(1, "lead:0") !== hashSeed(2, "lead:0"), "hashSeed: seeds differ");
check(hashSeed(1, "piece") === hashSeed(1, "piece"), "hashSeed: stable");

// voiceLead keeps common tones: C major to A minor holds C and E.
const am = voiceLead([57, 60, 64], [60, 64, 67]);
check(am.includes(60) && am.includes(64), `voiceLead holds common tones (${am})`);

// chordDegreeAt follows the form A A B A.
const p1 = composeRun(1);
check(chordDegreeAt(p1, 0) === p1.progressions[0][0] && chordDegreeAt(p1, 8) === p1.progressions[1][0],
  "chordDegreeAt follows the form");

// Regression fingerprint: seed 1, every part, 16 bars. A change here means the music for every
// existing seed changes; update the value only when that is intended.
const fp = fnv(JSON.stringify([p1, ...PARTS.map((part) => renderBars(p1, part, 0, 16, { energy: 0.6, density: 0.7 }))]));
check(fp === "b032af44", `seed 1 fingerprint ${fp} (expected b032af44)`);

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("music: all checks passed");
