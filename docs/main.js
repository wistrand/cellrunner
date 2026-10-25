// Browser-only ES module: input, frame loop, HUD and orchestration. Rules live in world.js,
// geometry in voronoi.js and graph.js, drawing in renderer.js, sound in audio.js (events from
// audio-events.js, music from music.js).

import { createWorld, stepWorld, continueWorld, setView, isAirborne, isActReady, legPoints }
  from "./world.js";
import { createRenderer as createRenderer2D } from "./renderer.js";
import { createRendererGL } from "./renderer-gl.js";
import { createAudio } from "./audio.js";
import { createEventTracker, diffWorld, musicParams } from "./audio-events.js";
import { composeRun } from "./music.js";

const RESTART_DELAY_MS = 500;
const MAX_DT = 0.05;

const params = new URLSearchParams(location.search);
const canvas = document.getElementById("field");
const hud = document.getElementById("hud");
const hudSlots = {
  score: document.getElementById("hud-score"),
  next: document.getElementById("hud-next"),
  best: document.getElementById("hud-best"),
  dash: document.getElementById("hud-dash"),
  sound: document.getElementById("hud-sound"),
};
const ui = {
  start: document.getElementById("start"),
  startBest: document.getElementById("start-best"),
  over: document.getElementById("gameover"),
  overScore: document.getElementById("over-score"),
  overLine: document.getElementById("over-line"),
  continueBtn: document.getElementById("continue-btn"),
};
// WebGL2 by default; ?gl=0 forces Canvas2D, which is also the fallback when WebGL2 is missing.
// A failed webgl2 getContext leaves the canvas free for a 2d context.
const renderer = (params.get("gl") !== "0" && createRendererGL(canvas)) || createRenderer2D(canvas);

const input = { act: false };
// ?audio=0 keeps the engine off: no AudioContext is ever created and M does nothing.
const audioOn = params.get("audio") !== "0";
const audio = createAudio();
const tracker = createEventTracker();
const music = musicParams(tracker); // reused every frame
let world = null;
let seed = 0;
let game = 0; // counts games; the music restarts when it changes
let musicGame = -1;
let best = loadBest();
let diedAt = 0;
let lastFrame = performance.now();
// "start": the welcome sheet over a still field; "play"; "over": the game-over sheet, shown
// RESTART_DELAY_MS after death so the catch is seen and a late click does not restart.
let state = "start";
let overShown = false;

function loadBest() {
  try {
    return Number(localStorage.getItem("cellrunner.best")) || 0;
  } catch {
    return 0;
  }
}

function saveBest() {
  try {
    localStorage.setItem("cellrunner.best", String(best));
  } catch {
    // Storage unavailable (private mode); best lives for this session only.
  }
}

function newGame(s) {
  seed = s;
  world = createWorld(seed, renderer.width, renderer.height);
  diedAt = 0;
  game++;
}

function show(el, on) {
  el.classList.toggle("hidden", !on);
}

function enterPlay() {
  state = "play";
  overShown = false;
  show(ui.start, false);
  show(ui.over, false);
  show(hud, true);
}

function startRun(s) {
  newGame(s);
  enterPlay();
}

// Same board, same enemy mix, score from zero.
function continueRun() {
  continueWorld(world);
  diedAt = 0;
  game++; // the music starts over
  enterPlay();
}

function showStart() {
  state = "start";
  ui.startBest.textContent = best > 0 ? `best ${best}` : "\u00a0";
  show(ui.start, true);
  show(ui.over, false);
  show(hud, false);
}

function showGameOver() {
  state = "over";
  overShown = true;
  ui.overScore.textContent = String(world.score);
  ui.overLine.textContent = `${world.goals} goal${world.goals === 1 ? "" : "s"} · best ${best}`;
  show(ui.over, true);
  show(hud, false);
}

// The AudioContext needs a user gesture, so the music of the first game starts on the first
// click or key; later games start theirs when they begin. Same seed, same music.
function syncMusic() {
  if (!audioOn || musicGame === game || world.dead || !audio.context()) return;
  musicGame = game;
  audio.startMusic(composeRun(seed));
}

function randomSeed() {
  return (Math.random() * 0xffffffff) >>> 0;
}

// The sound mark: off by URL, muted (M restores), or the key hint while sound is on.
function soundMark() {
  if (!audioOn) return "sound off";
  return audio.isMuted() ? "muted (M)" : "M mutes";
}

// One slot per reading (see #hud in index.html); only the text that changed moves.
function setSlot(slot, text) {
  if (slot.textContent !== text) slot.textContent = text;
}

function updateHud(now) {
  setSlot(hudSlots.score, `score ${world.score}`);
  setSlot(hudSlots.best, `best ${best}`);
  setSlot(hudSlots.sound, soundMark());
  if (world.dead) {
    setSlot(hudSlots.next, "");
    setSlot(hudSlots.dash, "caught");
    return;
  }
  setSlot(hudSlots.next, `next +${legPoints(world)}`);
  const dash = isAirborne(world) ? "dashing" : isActReady(world) ? "dash ready" : "dash …";
  setSlot(hudSlots.dash, dash);
}

function frame(now) {
  const dt = Math.min(MAX_DT, (now - lastFrame) / 1000);
  lastFrame = now;
  if (state === "start") {
    // The welcome sheet sits over a still field: drawn, not stepped.
    renderer.draw(world);
    requestAnimationFrame(frame);
    return;
  }
  const wasDead = world.dead;
  stepWorld(world, dt, input);
  input.act = false;
  syncMusic();
  for (const ev of diffWorld(tracker, world)) audio.play(ev);
  audio.setThreat(tracker.threat);
  audio.setMusicParams(musicParams(tracker, music));
  if (world.dead && !wasDead) {
    diedAt = now;
    audio.stopMusic({ fade: 0.4, cadence: true });
    if (world.score > best) {
      best = world.score;
      saveBest();
    }
  }
  if (world.dead && !overShown && now - diedAt > RESTART_DELAY_MS) showGameOver();
  renderer.draw(world);
  updateHud(now);
  requestAnimationFrame(frame);
}

function act(now) {
  if (state === "start") {
    startRun(seed);
    return;
  }
  if (world.dead) {
    if (now - diedAt > RESTART_DELAY_MS) startRun(randomSeed());
    return;
  }
  input.act = true;
}

canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  if (audioOn) audio.ensure();
  act(performance.now());
});
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

// Sheets: a click anywhere on one acts (start, or restart once the delay has passed), so the
// START and RESTART buttons have no handlers of their own: the pointerdown bubbling from them
// is the click, and a second handler would also register a dash. CONTINUE stops its pointerdown
// from reaching the sheet.
for (const sheet of [ui.start, ui.over]) {
  sheet.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (audioOn) audio.ensure();
    act(performance.now());
  });
}
ui.continueBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
ui.continueBtn.addEventListener("click", () => {
  if (audioOn) audio.ensure();
  if (state === "over") continueRun();
});

window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  if (audioOn) audio.ensure();
  if (e.key === "r" || e.key === "R") {
    if (state !== "start") startRun(randomSeed());
  } else if ((e.key === "c" || e.key === "C") && state === "over") {
    continueRun();
  } else if (e.key === "m" || e.key === "M") {
    if (audioOn) audio.toggleMute();
  } else if (e.key === " " || e.key === "Enter") {
    e.preventDefault();
    act(performance.now());
  }
});

window.addEventListener("resize", () => {
  renderer.resize();
  // The board lives in world units; the camera refits to the new viewport. No reset.
  setView(world, renderer.width, renderer.height);
});

newGame(params.has("seed") ? Number(params.get("seed")) >>> 0 : randomSeed());
showStart();
requestAnimationFrame(frame);
