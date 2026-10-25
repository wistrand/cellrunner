// Browser-only: the audio engine (agent_docs/plan-audio.md). Web Audio, no files, no
// dependencies. Plays the seeded music from music.js, the game sounds for audio-events.js
// events (`play`) and the threat pulse (`setThreat`). Patterns from astrocatch's docs/audio.js (MIT, same
// author): a lazy context created in a user gesture, an SFX bus through a compressor and a
// music bus around it, a silent keep-alive oscillator, all-linear click-safe envelopes, a
// look-ahead scheduler on the AudioContext clock, mute fading both buses.
//
// The scheduler works in bars: a bar is rendered (music.renderBars) and scheduled when its start
// comes within LOOKAHEAD, so layer and parameter changes take effect at the next bar line. If the
// tab stalls, bars that are already late are skipped rather than played into the past.

import { renderBars, chordAt, chordTones, degreeToMidi, BEATS_PER_BAR, SECTION_BARS } from "./music.js";

const STORAGE_KEY = "cellrunner.muted";
const SFX_VOLUME = 0.32;
const MUSIC_VOLUME = 0.10;
const LOOKAHEAD = 0.25; // seconds: a bar is scheduled this long before it starts
const TICK_MS = 50;
const SFX_LEAD = 0.01; // seconds: SFX start slightly ahead so their envelope starts at 0
const MAX_SFX_VOICES = 24; // concurrent SFX voices; more are dropped (music is bounded by design)
const THREAT_MIN = 0.05; // threat below this: no pulse

const midiToFreq = (p) => 440 * Math.pow(2, (p - 69) / 12);

// options.context: an AudioContext to use instead of creating one, e.g. an OfflineAudioContext
// for renderOffline (checks without speakers or real time).
export function createAudio({ context = null } = {}) {
  let ctx = null;
  let sfxBus = null;
  let musicBus = null;
  let songBus = null; // one per started piece, into musicBus; fading it ends the piece's notes
  let noiseBuffer = null;
  let muted = false;
  try { muted = localStorage.getItem(STORAGE_KEY) === "1"; } catch { /* private browsing */ }

  // Music state.
  let piece = null;
  let wanted = false; // the caller wants music (survives tab hide)
  let running = false; // the scheduler loop is active
  let timer = null;
  let nextBar = 0;
  let threatLevel = 0;
  let pulseAt = 0; // context time of the next threat pulse; 0 when none is pending
  let pulseDiv = 0;
  let nextBarTime = 0;
  // open: 0..1, how far threat opens the bass filter and brightens the pad.
  const params = { energy: 0.5, density: 0.5, open: 0, layers: { pad: true, bass: true, arp: true, lead: true } };
  // The lead renders a whole phrase per section; its energy and density are latched at each
  // section start so a mid-section change cannot switch phrase realizations halfway.
  const leadParams = { energy: 0.5, density: 0.5 };
  let sfxVoices = 0;

  // Creates the context on the first call, which must come from a user gesture (Safari); later
  // calls resume a suspended context. Returns the context, or null without Web Audio.
  function ensure() {
    if (!ctx) {
      const Ctor = context ? null : window.AudioContext || window.webkitAudioContext;
      if (!context && !Ctor) return null;
      try {
        if (context) ctx = context;
        else try { ctx = new Ctor({ latencyHint: "playback" }); } catch { ctx = new Ctor(); }
        sfxBus = ctx.createGain();
        sfxBus.gain.value = muted ? 0 : SFX_VOLUME;
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -10;
        comp.knee.value = 8;
        comp.ratio.value = 2.5;
        comp.attack.value = 0.02;
        comp.release.value = 0.25;
        sfxBus.connect(comp).connect(ctx.destination);
        // Music bypasses the compressor (in astrocatch its attack clicked on downbeats).
        musicBus = ctx.createGain();
        musicBus.gain.value = muted ? 0 : MUSIC_VOLUME;
        musicBus.connect(ctx.destination);
        // Silent keep-alive: some mobile backends click when the output wakes from idle.
        const warm = ctx.createOscillator();
        const warmGain = ctx.createGain();
        warmGain.gain.value = 0;
        warm.frequency.value = 40;
        warm.connect(warmGain).connect(ctx.destination);
        warm.start();
        // One second of white noise, shared by every noise voice.
        noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        const data = noiseBuffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      } catch {
        ctx = null;
        return null;
      }
    }
    if (ctx.state === "suspended" && !context) ctx.resume();
    return ctx;
  }

  function setMuted(m) {
    muted = !!m;
    try { localStorage.setItem(STORAGE_KEY, muted ? "1" : "0"); } catch { /* private browsing */ }
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const [bus, vol] of [[sfxBus, SFX_VOLUME], [musicBus, MUSIC_VOLUME]]) {
      bus.gain.cancelScheduledValues(now);
      bus.gain.setTargetAtTime(muted ? 0 : vol, now, 0.05);
    }
  }

  // An all-linear envelope on a fresh gain node: 0 -> peak over `attack`, held, -> 0 by `end`,
  // then pinned at 0 (float-safety). Linear only: iOS Safari clicked at exponential handoffs.
  function envelope(g, t, peak, attack, end) {
    g.gain.value = 0;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.linearRampToValueAtTime(0, end);
    g.gain.setValueAtTime(0, end + 0.002);
  }

  // ---------------------------------------------------------------------------------------------
  // Music voices (from astrocatch). `vel` is the note velocity 1..127.
  // ---------------------------------------------------------------------------------------------

  function padVoice(freq, t, dur, vel) {
    const g = ctx.createGain();
    const attack = Math.min(0.35, dur * 0.3);
    const release = Math.min(0.45, dur * 0.4);
    const peak = 0.16 * (vel / 100);
    g.gain.value = 0;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.linearRampToValueAtTime(peak, t + dur - release);
    g.gain.linearRampToValueAtTime(0, t + dur);
    g.gain.setValueAtTime(0, t + dur + 0.002);
    g.connect(songBus);
    let left = 2;
    for (const detune of [-7, 7]) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.detune.value = detune;
      osc.frequency.setValueAtTime(freq, t);
      osc.connect(g);
      osc.start(t);
      osc.stop(t + dur + 0.03);
      osc.onended = () => { osc.disconnect(); if (--left === 0) g.disconnect(); };
    }
    // Threat brightens the pad: a quiet triangle an octave up, as loud as `open` asks.
    if (params.open > 0.05) {
      const hi = ctx.createOscillator();
      hi.type = "triangle";
      hi.frequency.setValueAtTime(freq * 2, t);
      const hg = ctx.createGain();
      hg.gain.value = 0.35 * params.open;
      hi.connect(hg).connect(g);
      left++;
      hi.start(t);
      hi.stop(t + dur + 0.03);
      hi.onended = () => { hi.disconnect(); hg.disconnect(); if (--left === 0) g.disconnect(); };
    }
  }

  // Saw plus a sub sine through a filter envelope (the sub stays at 55 Hz or above: small
  // speakers distort lower).
  function bassVoice(freq, t, dur, vel) {
    const len = Math.max(0.12, Math.min(dur, 0.6));
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(freq, t);
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(freq * 0.5 >= 55 ? freq * 0.5 : freq, t);
    const subGain = ctx.createGain();
    subGain.gain.value = 0.55;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 0.8;
    // Threat opens the filter envelope: a brighter attack and a higher tail.
    filter.frequency.setValueAtTime(180, t);
    filter.frequency.exponentialRampToValueAtTime(1100 + 1500 * params.open, t + 0.015);
    filter.frequency.exponentialRampToValueAtTime(260 + 400 * params.open, t + len);
    const g = ctx.createGain();
    envelope(g, t, 0.45 * (vel / 110), 0.018, t + len);
    osc.connect(filter);
    sub.connect(subGain).connect(filter);
    filter.connect(g).connect(songBus);
    osc.start(t);
    sub.start(t);
    osc.stop(t + len + 0.03);
    sub.stop(t + len + 0.03);
    osc.onended = () => { osc.disconnect(); sub.disconnect(); subGain.disconnect(); filter.disconnect(); g.disconnect(); };
  }

  function arpVoice(freq, t, dur, vel) {
    const len = Math.max(0.08, Math.min(dur, 0.3));
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq, t);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1700;
    filter.Q.value = 1;
    const g = ctx.createGain();
    envelope(g, t, 0.15 * (vel / 100), 0.018, t + len);
    osc.connect(filter).connect(g).connect(songBus);
    osc.start(t);
    osc.stop(t + len + 0.03);
    osc.onended = () => { osc.disconnect(); filter.disconnect(); g.disconnect(); };
  }

  function leadVoice(freq, t, dur, vel) {
    const len = Math.max(0.3, Math.min(dur + 0.25, 1.6));
    const g = ctx.createGain();
    envelope(g, t, 0.2 * (vel / 110), 0.04, t + len);
    g.connect(songBus);
    let left = 2;
    for (const detune of [-6, 6]) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.detune.value = detune;
      osc.frequency.setValueAtTime(freq, t);
      osc.connect(g);
      osc.start(t);
      osc.stop(t + len + 0.03);
      osc.onended = () => { osc.disconnect(); if (--left === 0) g.disconnect(); };
    }
  }

  const VOICES = { pad: padVoice, bass: bassVoice, arp: arpVoice, lead: leadVoice };

  // ---------------------------------------------------------------------------------------------
  // Scheduler
  // ---------------------------------------------------------------------------------------------

  const secPerBeat = () => 60 / piece.bpm;
  const barSec = () => secPerBeat() * BEATS_PER_BAR;

  function scheduleBar(bar, t0) {
    if (!songBus) return;
    const spb = secPerBeat();
    if (bar % SECTION_BARS === 0) {
      leadParams.energy = params.energy;
      leadParams.density = params.density;
    }
    for (const part of Object.keys(VOICES)) {
      if (!params.layers[part]) continue;
      for (const n of renderBars(piece, part, bar, 1, part === "lead" ? leadParams : params)) {
        const t = t0 + (n.start - bar * BEATS_PER_BAR) * spb;
        VOICES[part](midiToFreq(n.pitch), t, n.duration * spb, n.velocity);
      }
    }
  }

  function tick() {
    timer = null;
    if (!running || !ctx) return;
    const now = ctx.currentTime;
    // A stalled tab: skip bars that would start in the past.
    while (nextBarTime < now + 0.02) { nextBar++; nextBarTime += barSec(); }
    while (nextBarTime < now + LOOKAHEAD) {
      scheduleBar(nextBar, nextBarTime);
      nextBar++;
      nextBarTime += barSec();
    }
    schedulePulses(now);
    timer = setTimeout(tick, TICK_MS);
  }

  // The enemy telegraph: one low pulse on the beat grid whose rate follows the threat (a beat,
  // an eighth, a sixteenth), pitched on the root of the chord it lands in.
  function schedulePulses(now) {
    if (threatLevel < THREAT_MIN) { pulseAt = 0; return; }
    const div = threatLevel < 0.4 ? 1 : threatLevel < 0.75 ? 2 : 4;
    const step = secPerBeat() / div;
    if (div !== pulseDiv || pulseAt < now + SFX_LEAD) {
      const barStart = nextBarTime - barSec();
      const from = Math.max(pulseAt, now + SFX_LEAD);
      pulseAt = barStart + Math.ceil((from - barStart) / step) * step;
      pulseDiv = div;
    }
    while (pulseAt < now + LOOKAHEAD) {
      const root = chordAtTime(3, pulseAt)[0];
      tone({ freq: midiToFreq(root), type: "sine", gain: 0.1 + 0.2 * threatLevel, dur: 0.14,
        attack: 0.004, at: pulseAt });
      pulseAt += step;
    }
  }

  // The chord sounding at context time `t`. The last scheduled bar may not have started yet (bars
  // are scheduled LOOKAHEAD early), so the bar comes from the time.
  function chordAtTime(octave, t) {
    const bar = nextBar - 1 + Math.floor((t - (nextBarTime - barSec())) / barSec());
    return chordAt(piece, Math.max(0, bar), octave);
  }

  // The ending: the tonic chord on the next beat, held for two beats, on a bus of its own that
  // the next piece's newSong fades out if it starts first.
  function playCadence() {
    songBus = ctx.createGain();
    songBus.connect(musicBus);
    const t = nextGrid(1);
    const dur = 2 * secPerBeat();
    const { key, scale } = piece;
    for (const p of chordTones(1, key, scale, 4)) padVoice(midiToFreq(p), t, dur + 0.6, 70);
    bassVoice(midiToFreq(degreeToMidi(1, key, scale, 2)), t, dur, 90);
    leadVoice(midiToFreq(degreeToMidi(1, key, scale, 5)), t, dur, 80);
  }

  // A new song bus for a piece; the previous one fades out over `fade` seconds, cutting the notes
  // already scheduled on it.
  function newSong() {
    endSong(0.05);
    songBus = ctx.createGain();
    songBus.connect(musicBus);
  }
  function endSong(fade) {
    const g = songBus;
    songBus = null;
    if (!g) return;
    const now = ctx.currentTime;
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(g.gain.value, now);
    g.gain.linearRampToValueAtTime(0, now + fade);
    setTimeout(() => g.disconnect(), (fade + 0.2) * 1000);
  }

  function run() {
    if (running || !piece || !ensure()) return;
    if (!songBus) newSong();
    running = true;
    nextBarTime = ctx.currentTime + 0.1;
    tick();
  }
  function halt() {
    running = false;
    if (timer !== null) { clearTimeout(timer); timer = null; }
  }

  // The tab hidden: stop scheduling (nothing to hear, and timers are throttled); back: resume at
  // the next bar, if music is still wanted.
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) halt();
      else if (wanted) run();
    });
  }

  // ---------------------------------------------------------------------------------------------
  // SFX voices (phase C builds the sounds from these).
  // ---------------------------------------------------------------------------------------------

  // Start time for an SFX: `at` (context time) or now + SFX_LEAD, never in the past.
  const startAt = (at) => Math.max(ctx.currentTime + SFX_LEAD, at ?? 0);

  // Whether a new SFX voice may start (the voice cap); counts it when it may.
  function claimVoice() {
    if (sfxVoices >= MAX_SFX_VOICES) return false;
    sfxVoices++;
    return true;
  }

  // A pitched SFX voice. freq: start frequency (Hz); to: optional end frequency (a slide);
  // type: oscillator type; gain: peak; pan: -1..1; dur: seconds; filter: optional lowpass cutoff.
  function tone({ freq, to = null, type = "sine", gain = 0.25, pan = 0, dur = 0.2, attack = 0.008, at = null, filter = null }) {
    if (!ensure() || muted || !claimVoice()) return;
    const t = startAt(at);
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
    const g = ctx.createGain();
    envelope(g, t, gain, Math.min(attack, dur / 2), t + dur);
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    let node = osc;
    let lp = null;
    if (filter) {
      lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = filter;
      node = node.connect(lp);
    }
    node.connect(g).connect(p).connect(sfxBus);
    osc.start(t);
    osc.stop(t + dur + 0.03);
    osc.onended = () => { osc.disconnect(); lp?.disconnect(); g.disconnect(); p.disconnect(); sfxVoices--; };
  }

  // A noise SFX voice through a bandpass sweeping from `from` to `to` Hz (a whoosh).
  function noise({ from = 600, to = 3000, q = 1.2, gain = 0.2, pan = 0, dur = 0.25, attack = 0.02, at = null }) {
    if (!ensure() || muted || !claimVoice()) return;
    const t = startAt(at);
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = q;
    bp.frequency.setValueAtTime(from, t);
    bp.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    const g = ctx.createGain();
    envelope(g, t, gain, Math.min(attack, dur / 2), t + dur);
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    src.connect(bp).connect(g).connect(p).connect(sfxBus);
    src.start(t);
    src.stop(t + dur + 0.03);
    src.onended = () => { src.disconnect(); bp.disconnect(); g.disconnect(); p.disconnect(); sfxVoices--; };
  }

  // Game sounds. Pitched sounds use the current chord when music runs, so they fit the harmony.
  function chordNow(octave, fallback) {
    return (running && piece && chordAtTime(octave, ctx.currentTime + SFX_LEAD)) || fallback;
  }
  function playEvent(ev) {
    const pan = ev.pan;
    switch (ev.type) {
      case "score": {
        // The chord's tones rising, from the next 16th.
        const at = running && piece ? nextGrid(4) : null;
        const chord = chordNow(6, [84, 88, 91]);
        chord.forEach((p, i) => tone({ freq: midiToFreq(p), gain: 0.16, dur: 0.45, pan,
          at: (at ?? ctx.currentTime + SFX_LEAD) + i * 0.06 }));
        tone({ freq: midiToFreq(chord[0] + 12), gain: 0.1, dur: 0.6, pan,
          at: (at ?? ctx.currentTime + SFX_LEAD) + chord.length * 0.06 });
        break;
      }
      case "dashStart":
        noise({ from: 500, to: 3500, q: 1.4, gain: 0.32, dur: 0.3, pan });
        break;
      case "dashEnd":
        tone({ freq: 900, to: 450, type: "triangle", gain: 0.08, dur: 0.07, pan });
        break;
      case "split": {
        const top = chordNow(6, [84, 88, 91]);
        tone({ freq: midiToFreq(top[top.length - 1]), to: midiToFreq(top[top.length - 1] + 7),
          type: "triangle", gain: 0.1, dur: 0.12, pan });
        break;
      }
      case "join": {
        const top = chordNow(5, [72, 76, 79]);
        tone({ freq: midiToFreq(top[0] + 7), to: midiToFreq(top[0]), type: "triangle", gain: 0.1,
          dur: 0.14, pan });
        break;
      }
      case "death":
        tone({ freq: 220, to: 55, type: "sawtooth", gain: 0.28, dur: 0.9, filter: 1600, pan });
        noise({ from: 900, to: 120, q: 0.8, gain: 0.25, dur: 0.5, pan });
        break;
      default:
        break; // goalMoved: the dash or the score chime already covers it
    }
  }
  function nextGrid(division) {
    const step = secPerBeat() / division;
    const barStart = nextBarTime - barSec();
    return barStart + Math.ceil((ctx.currentTime + SFX_LEAD - barStart) / step) * step;
  }

  return {
    ensure,
    // Music: start a piece from music.composeRun(seed); stop; change layers and parameters (they
    // apply from the next bar).
    startMusic(p) {
      piece = p;
      nextBar = 0;
      wanted = true;
      halt();
      if (ensure()) newSong();
      run();
    },
    // Stops scheduling and fades out what is already scheduled over `fade` seconds. With
    // `cadence`, the piece ends on its tonic chord from the next beat (pad, bass, lead).
    stopMusic({ fade = 0.3, cadence = false } = {}) {
      const was = running && piece;
      wanted = false;
      halt();
      if (!ctx) return;
      endSong(fade);
      if (cadence && was) playCadence();
    },
    // Updates in place (main.js calls this every frame). Missing fields keep their value.
    setMusicParams({ energy, density, open, layers } = {}) {
      if (energy !== undefined) params.energy = energy;
      if (density !== undefined) params.density = density;
      if (open !== undefined) params.open = Math.max(0, Math.min(1, open));
      if (layers) for (const k in layers) params.layers[k] = !!layers[k];
    },
    musicParams: () => params,
    // The music clock, for SFX that should land on the grid or fit the harmony: the context time
    // of the next subdivision (4 = 16ths) after now, and the chord sounding then (MIDI tones).
    nextGridTime(division = 4) {
      if (!ctx || !running || !piece) return null;
      return nextGrid(division);
    },
    // The chord sounding at context time `at` (default now).
    currentChord(octave = 5, at = null) {
      if (!piece || !running || !ctx) return null;
      return chordAtTime(octave, at ?? ctx.currentTime);
    },
    // The threat signal (0..1), from audio-events; drives the pulse while music runs.
    setThreat(x) { threatLevel = Math.max(0, Math.min(1, x || 0)); },
    // A game event from audio-events.diffWorld. Silent before the context exists, so events from
    // frames before the first gesture never create it.
    play(ev) {
      if (ctx && !muted) playEvent(ev);
    },
    tone,
    noise,
    // With options.context an OfflineAudioContext: schedule `nBars` of `p` from time 0 through the
    // same voices and render them; resolves with the AudioBuffer.
    renderOffline(p, nBars) {
      if (!context || !ensure()) return Promise.reject(new Error("renderOffline needs an OfflineAudioContext"));
      piece = p;
      newSong();
      for (let bar = 0; bar < nBars; bar++) scheduleBar(bar, 0.05 + bar * barSec());
      return ctx.startRendering();
    },
    setMuted,
    isMuted: () => muted,
    toggleMute() { setMuted(!muted); return muted; },
    // Physical output delay (Bluetooth reports 0.1 to 0.3 s); 0 where not reported.
    outputLatency: () => (ctx && typeof ctx.outputLatency === "number" ? ctx.outputLatency : 0),
    activeSfxVoices: () => sfxVoices,
    context: () => ctx,
  };
}
