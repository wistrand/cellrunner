// Browser-only ES module: input, frame loop, HUD and orchestration. Rules live in world.js,
// geometry in voronoi.js and graph.js, drawing in renderer.js, sound in audio.js (events from
// audio-events.js, music from music.js).

import { createWorld, stepWorld, continueWorld, setView, legPoints }
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
};
const ui = {
  start: document.getElementById("start"),
  startBest: document.getElementById("start-best"),
  over: document.getElementById("gameover"),
  overScore: document.getElementById("over-score"),
  overLine: document.getElementById("over-line"),
  continueBtn: document.getElementById("continue-btn"),
  icons: document.getElementById("icons"),
  iconsLeft: document.getElementById("icons-left"),
  fsBtn: document.getElementById("fs-btn"),
  muteBtn: document.getElementById("mute-btn"),
  pauseBtn: document.getElementById("pause-btn"),
  paused: document.getElementById("paused"),
};
// Fullscreen is an optional extra: no API (iPhone Safari), no button.
const FULLSCREEN_OK = typeof document.documentElement.requestFullscreen === "function";
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
let paused = false; // only meaningful in "play": the world is drawn, not stepped

// A stored best that is not a finite number (an old scoring bug once saved "Infinity") is
// discarded, and such a value is never saved.
function loadBest() {
  try {
    const v = Number(localStorage.getItem("cellrunner.best"));
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}

function saveBest() {
  if (!Number.isFinite(best)) return;
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
  paused = false;
  show(ui.start, false);
  show(ui.over, false);
  show(ui.paused, false);
  show(hud, true);
  show(ui.icons, true);
  show(ui.muteBtn, audioOn);
  show(ui.iconsLeft, FULLSCREEN_OK);
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
  show(ui.paused, false);
  show(hud, false);
  show(ui.icons, false);
  show(ui.iconsLeft, false);
}

function showGameOver() {
  state = "over";
  overShown = true;
  ui.overScore.textContent = String(world.score);
  ui.overLine.textContent = `${world.goals} goal${world.goals === 1 ? "" : "s"} · best ${best}`;
  show(ui.over, true);
  show(ui.paused, false);
  show(hud, false);
  show(ui.icons, false);
  show(ui.iconsLeft, false);
}

// Pause: the world is drawn but not stepped, the music is held at its bar and the threat pulse
// released, and the sheet over the field takes the resume click so it never registers as a
// dash. Only during play; a hidden tab pauses too, since a long gap would otherwise land as one
// clamped step.
function setPaused(on) {
  if (state !== "play" || world.dead || paused === on) return;
  paused = on;
  show(ui.paused, on);
  if (on) {
    audio.setThreat(0);
    audio.pauseMusic();
  } else {
    audio.resumeMusic();
  }
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


// One slot per reading (see #hud in index.html); only the text that changed moves.
function setSlot(slot, text) {
  if (slot.textContent !== text) slot.textContent = text;
}

function updateHud(now) {
  setSlot(hudSlots.score, `score ${world.score}`);
  setSlot(hudSlots.best, `best ${best}`);
  setSlot(hudSlots.next, world.dead ? "" : `next +${legPoints(world)}`);
  // The speaker icon follows the mute state, whichever way it was toggled.
  if (audioOn) ui.muteBtn.classList.toggle("muted", audio.isMuted());
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
  if (paused) {
    input.act = false;
    renderer.draw(world);
    updateHud(now);
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
    if (world.score > best && Number.isFinite(world.score)) {
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
  if (paused) {
    setPaused(false); // the action resumes; it is not a dash
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

// Icons sit over the field; their pointerdown must not reach the canvas as a dash. A clicked
// button keeps keyboard focus in some browsers, where Space or Enter would then click it again
// on top of their game meaning, so every icon drops focus after acting.
ui.muteBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
ui.muteBtn.addEventListener("click", (e) => {
  e.currentTarget.blur();
  if (!audioOn) return;
  audio.ensure();
  audio.toggleMute();
});
ui.pauseBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
ui.pauseBtn.addEventListener("click", (e) => {
  e.currentTarget.blur();
  setPaused(!paused);
});
// The paused sheet covers the canvas, so a click on it resumes without dashing.
ui.paused.addEventListener("pointerdown", (e) => {
  if (e.button === 0) setPaused(false);
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) setPaused(true);
});

// Fullscreen: the whole document, so the sheets and icons come along. The button's glyph follows
// the real state, since Escape leaves fullscreen without going through us.
function toggleFullscreen() {
  if (!FULLSCREEN_OK) return;
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}
ui.fsBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
ui.fsBtn.addEventListener("click", (e) => {
  e.currentTarget.blur();
  toggleFullscreen();
});
document.addEventListener("fullscreenchange", () => {
  ui.fsBtn.classList.toggle("fs", !!document.fullscreenElement);
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
  } else if (e.key === "p" || e.key === "P") {
    // Not Escape: the browser uses it to leave fullscreen, and whether the page still sees that
    // keydown differs by browser, so it would pause only sometimes.
    setPaused(!paused);
  } else if (e.key === "f" || e.key === "F") {
    toggleFullscreen();
  } else if (e.key === " " || e.key === "Enter") {
    e.preventDefault();
    // On the game-over sheet the keys continue the run (same board, score from zero) once the
    // delay has passed; a click there restarts. Elsewhere they start or dash.
    if (state === "over") continueRun();
    else act(performance.now());
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
