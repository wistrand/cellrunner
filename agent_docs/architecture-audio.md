# Architecture: audio

Procedural sound with no files and no dependencies. Three modules: `docs/music.js` composes a
run's piece from its seed (pure), `docs/audio-events.js` turns world states into events and
signals (pure), `docs/audio.js` plays both through Web Audio (browser-only). `docs/main.js`
wires them; [plan-audio.md](plan-audio.md) has the history and the sound design.

## Data flow, per frame

1. `stepWorld` runs.
2. `syncMusic` starts the run's piece once a context exists (`composeRun(seed)`), once per game.
3. `diffWorld(tracker, world)` returns the frame's events; each goes to `audio.play`.
4. `audio.setThreat(tracker.threat)` and `audio.setMusicParams(musicParams(tracker, music))`.
5. On the death frame, `audio.stopMusic({ fade, cadence: true })`.

The world emits nothing. Everything the audio knows comes from comparing two world states, so
the audio can be removed or swapped without touching `world.js`. `threat(world)` lives in
`world.js` because the GL renderer's pulse reads the same value.

## `music.js`: the composer

- `composeRun(seed)` returns a frozen piece: scale (minor, dorian, phrygian), key, two
  progressions in the form A A B A, tempo 96 to 108 BPM, a hook motif, a bass feel and an arp
  direction. Draws come from `hashSeed(seed, label)` streams, never `world.rand`.
- `renderBars(piece, part, fromBar, nBars, { energy, density })` returns notes
  `{ pitch, start, duration, velocity }` in beats for `pad`, `bass`, `arp` or `lead`. Rendering is
  a pure function of its arguments, so any window of bars gives the same notes, which is what
  lets the scheduler ask for one bar at a time.
- Chords are voiced toward the tonic triad of the part's register, not led from the previous
  bar; see `voicedBar` for why.
- The lead renders a whole section (`SECTION_BARS`) from the hook and a contour, and ends each
  section on the tonic.
- `chordAt(piece, bar, octave)` is the harmony hook for SFX.
- `scripts/music-test.js` checks scale membership, voice-leading step bounds, window
  consistency and a seed-1 fingerprint. Changing the fingerprint changes every seed's music; do it
  only on purpose.

## `audio-events.js`: events and signals

- `createEventTracker()` holds the compared values. `diffWorld` fills a reused event array
  (read it before the next call) and updates `threat`, `heat` and `enemyCount`. A new world
  object resets the tracker and reports no events for that frame, so a restart never fires the
  old game's tail.
- Events: `score`, `dashStart`, `dashEnd`, `goalMoved`, `split`, `join`, `death`, each with
  world `x, y` and a screen `pan` (`panOf`).
- `heat` is the threat with a fast attack and a slow release (`HEAT_RELEASE`). `musicParams`
  maps heat above `HEAT_CALM`, score and enemy count to `{ energy, density, open, layers }`, and
  passes the ground under the player through as `biome` (0 water .. 1 snow) and `space` (1 in
  the digital domain), from `world.playerBiome` and `world.playerSpace`. Space raises density a
  little and water lowers it. The engine's `terrain()` turns the pair into water, trees, snow
  and space weights per note (same breakpoints as the GL biome ramp; space wins) and the voices
  read them: water widens the pad's detune and slows its attack and softens the lead, space adds
  a square under the pad and the arp and a saw to the lead and opens the bass and arp filters,
  trees close those filters, snow keeps a little octave shimmer on the pad. Nothing changes the
  piece itself, so the tune continues across a border and the sound shifts within a bar.
  Layer rules: pad and bass always; arp after the first point or at `ARP_HEAT`; lead after the
  first point.
- `scripts/events-test.js` drives scripted worlds through the tracker.

## `audio.js`: the engine

- `createAudio({ context })`. `ensure()` creates the AudioContext on first call and must run
  inside a user gesture (`main.js` calls it from the pointer and key handlers). `play` is silent
  until the context exists, so frames before the first gesture never create one. `context`
  injects an `OfflineAudioContext` for `renderOffline` (used by `docs/audio-test.html`).
- Buses: SFX through a compressor to the destination; music on its own gain straight to the
  destination. Mute fades both buses with `setTargetAtTime`; there is no master gain. A silent
  40 Hz keep-alive oscillator runs from context creation.
- Each piece plays into its own song gain under the music bus. `startMusic` fades the previous
  song gain out, so notes already scheduled for the old piece end with it. `stopMusic` fades the
  current one and can play the closing cadence (tonic chord from the next beat, two beats) on a
  fresh song gain.
- Scheduler: a `setTimeout` loop every `TICK_MS` on the context clock. A bar is rendered and
  scheduled when its start comes within `LOOKAHEAD`, so parameter and layer changes take effect
  at the next bar line. Bars that would start in the past are skipped. A hidden tab halts the
  loop; it resumes at the next bar if music is still wanted. `pauseMusic` halts the loop and
  fades the song gain but keeps the bar position and the piece; `resumeMusic` continues from
  that bar. A tab un-hide never resumes a paused piece. `main.js` calls these from the game's
  pause, so pausing silences the music and resuming picks it up where it stopped.
- The lead's energy and density are latched at each section start (`leadParams`), since the
  lead renders a phrase per section.
- Tempo is fixed per run. The threat pulse and the score chime align to the beat grid
  (`nextGrid`), and a tempo change would move that grid under them.
- Voices: pad, bass, arp, lead for music; `tone` and `noise` (one shared noise buffer) for SFX,
  each with a stereo panner. SFX voices are capped at `MAX_SFX_VOICES`; the composer bounds the
  music. All envelopes are linear ramps that end at exactly 0.
- Threat pulse: `setThreat` stores the level; the scheduler places one low sine per beat,
  eighth or sixteenth as threat passes 0.4 and 0.75, pitched on the root of the chord it lands
  in. Below `THREAT_MIN` there is no pulse.
- Mute state persists as `cellrunner.muted` in localStorage (guarded; private mode falls back to
  unmuted for the session).

## Controls and switches

- M toggles mute (`main.js`). The HUD shows "M mutes", "muted · M for sound" or "sound off".
- `?audio=0` keeps the engine off: `ensure` is never called, no context is created, music never
  starts, and M does nothing.
- `docs/audio-test.html` is the dev page: start, stop, mute, layer toggles, parameter sliders,
  one button per game sound, a threat slider; `?seed=N`, `?autostart=1`, `?offline=N`.

## Verification

- `npm test` runs `music-test.js` and `events-test.js` in node. Nothing in the engine runs in
  node.
- Offline renders (16 bars, five seeds) measured peak about 0.11, RMS about -33 dBFS and a
  largest sample step about 0.01 at default parameters; the plan has the loud-end figures.
- Phones: B and C were listened to on one phone. Phase E's pass on a mid-range phone and
  Bluetooth output is still open (see the plan's status line).
