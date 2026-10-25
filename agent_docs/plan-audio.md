# Plan: audio

> Status: phases A to E built (`docs/music.js`, `docs/audio.js`, `docs/audio-events.js`,
> `docs/audio-test.html`, `scripts/music-test.js`, `scripts/events-test.js`, the M key, the HUD
> mark and `?audio=0` in `docs/main.js`, [architecture-audio.md](architecture-audio.md)). B and C
> were listened to on a phone. Still open: a listening pass of D on a few seeds, and E's pass on
> a mid-range phone with Bluetooth output. The architecture doc is now the reference; this file
> keeps the design history. Written from a reading of astrocatch's `docs/audio.js` and
> undead-composer's `lib/music.ts` (both MIT, same author).

## Goal

Procedural audio with no files and no dependencies: adaptive music composed from the run's seed,
and sound effects that react to the world and fit the music. It also covers the plan-game item
"telegraph enemy approach (... or sound)".

## Sources and what to take

| Source                                   | Take                                                                                                                                                                                              | Leave                                                                       |
|------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------|
| astrocatch `docs/audio.js`               | look-ahead scheduler on the AudioContext clock, click-safe envelopes (start slightly ahead, ramps ending at exactly 0), SFX and music buses, compressor, lazy context on a user gesture, silent keep-alive oscillator, mute fade, visibility pause, `outputLatency` compensation | the fixed A-minor tables, its game-specific SFX designs, unbounded voices    |
| undead-composer `lib/music.ts`           | scales and `degreeToMidi`, `chordTones`, `voiceLead`, `melodySkeleton` and a few figures (step, arp, neighbour), motif invent and sequence, bass feels (root, octave, offbeat), arp patterns, seeded `mulberry32` with per-part seeds, the note model `{ pitch, start, duration, velocity }` in beats | the LLM layer, the genre catalogue, Ableton/OSC output, drum grooves, TypeScript |

Port, do not import: cellrunner has no build step and plan-game treats astrocatch as a reference, not a
dependency. Port only what cellrunner uses.

## Design

Three modules, following the project's pure / browser-only split.

### `docs/music.js` (pure, runs in node; built)

Built as planned, with these specifics: `composeRun(seed)` picks minor, dorian or phrygian, a
key, two progressions (form A A B A, one chord per bar, 4-bar sections), 96 to 108 BPM, a hook
cell, the bass feel and the arp direction. `renderBars(piece, part, fromBar, nBars, { energy,
density })` returns notes for `pad`, `bass`, `arp`, `lead`. `chordAt(piece, bar)` gives the
bar's chord for SFX. Chords are voiced towards the tonic triad (not chained from bar to bar), so
any window renders the same notes and pad steps stay within 12 semitones. The lead develops the
hook per section and ends each section on the tonic. `scripts/music-test.js` holds the checks
and a seed-1 fingerprint; update it only when changing every seed's music is intended.


### `docs/audio-events.js` (pure; built)

- `createEventTracker()` keeps the few values compared; `diffWorld(tracker, world)` returns the
  events since its last call (the world emits none, as `main.js` already found for death). A
  different world object resets the tracker and reports nothing for that call.
- Events: `score` (`world.score` rose), `dashStart` (`airStart` changed), `dashEnd` (airborne to
  grounded, not on death), `goalMoved` (`goalMovedAt`; every dash and every score), `split` and
  `join` (flashes stamped after the previous call), `death`. Each carries x, y and a pan from
  the screen position (`panOf`).
- Signals on the tracker: `threat` (0..1, 0 once dead) and `enemyCount` (lethal enemies).
- `threat(world)` and `TUNING.threatRange` live in `world.js`; the GL pulse and the audio read
  the same value.
- No per-frame allocation: the event array and its objects are reused, so read them before the
  next call.
- `heat` on the tracker: the threat with a fast attack and a slow release (`HEAT_RELEASE` per
  second of game time). `musicParams(tracker, out)` maps heat above `HEAT_CALM` (an enemy
  somewhere near is the normal state), the score and the enemy count to `{ energy, density, open,
  layers }` for `audio.setMusicParams`, filling `out` in place. `main.js` calls both every frame.

### `docs/audio.js` (browser-only; built)

- `createAudio({ context })` returns the engine. `ensure()` creates the AudioContext on first
  call, which must come from a user gesture (Safari); phase C calls it from `act()` in the
  pointer and key handlers. `latencyHint: "playback"`. `context` injects a context instead
  (an `OfflineAudioContext` for `renderOffline`).
- Buses: SFX through a compressor; music on its own bus around it (in astrocatch the
  compressor's attack clicked on downbeats). Mute fades both buses; there is no master gain.
- Scheduler: a `setTimeout` look-ahead loop on the context clock that schedules whole bars
  (`renderBars` one bar at a time) once a bar's start is within `LOOKAHEAD` (0.25 s). Layer and
  parameter changes apply at the next bar line. Late bars are skipped, never played into the
  past. A hidden tab stops the loop; it restarts at the next bar.
- `nextGridTime(division)` and `currentChord(octave, at)` give SFX the grid and the harmony.
- Voices: pad, bass, arp and lead from astrocatch; SFX build on `tone()` and `noise()` (one
  shared noise buffer), each with a `StereoPannerNode`. A cap of `MAX_SFX_VOICES` (24) drops
  new SFX voices beyond it; music is bounded by the composer.
- Mute state is stored as `cellrunner.muted` in localStorage (wrapped in try/catch). The M key, the
  HUD mark and `?audio=0` live in `main.js` (phase E).
- Each started piece plays into its own song gain; `stopMusic({ fade, cadence })` stops
  scheduling and fades that gain, so the notes already scheduled for the current bar end too,
  then optionally plays the closing cadence. The next game starts a new piece.
- `setMusicParams` updates in place; `open` (0..1) brightens the bass and pad.
- `play(ev)` makes the game sounds (see Sound design); it does nothing before the context exists,
  so frames before the first gesture never create it. `setThreat(x)` drives the pulse, which the
  scheduler places on the beat grid while music runs.

`docs/audio-test.html` is a dev page, not linked from the game: Start/Stop/Mute, layer
toggles, energy, density and open sliders, stop on a cadence, one button per game sound, a
threat slider. `?seed=N` picks the piece, `?autostart=1` starts
without a click and logs the engine state, `?offline=N` renders N bars offline and reports
peak, RMS and the largest sample-to-sample jump.

Measured (offline, 16 bars, five seeds): peak about 0.11, RMS about -33 dBFS, largest sample
step about 0.01, so no clicks from the envelopes. At energy and density 1 and open 0.9: peak
about 0.14, largest step about 0.019 (the brighter bass). Headless Chrome's `--dump-dom` modes never
finish an `OfflineAudioContext` render started from a module script; drive the page over the
DevTools protocol instead (real time, `Runtime.evaluate` with `awaitPromise`).

## Sound design

Terrain (2026-10-25): the ground under the player colours the timbre, not the piece. Water is a
chorused, slow swell with a soft lead; the digital domain (space) is squarer and brighter with a
saw edge on the lead and a busier arp; trees are duller in the bass and arp; snow carries a
constant light shimmer. Weights come from `terrain()` in `audio.js`; the per-voice numbers are
first guesses and a listening pass across a border is still open. A second, stronger step if the
border stays too quiet: two arrangements of the one piece crossfaded by the space weight.

- Music, layered and adaptive (built in phase D; changes apply at the next bar line):
  - pad and bass always;
  - arp joins after the first point or once heat reaches `ARP_HEAT`;
  - the lead (the hook, developed per section by music.js) enters after the first goal;
  - heat raises energy (velocity) and density (bass, arp and lead note rates, so the arp goes
    to 16ths), opens the bass filter envelope and adds a triangle an octave up to the pad;
  - the lead's energy and density are latched at each section start, since it renders a whole
    phrase per section;
  - tempo stays fixed per run (96 to 108 BPM): a tempo change would move the beat grid that the
    pulse and the score chime align to.
- SFX tied to the harmony (built in phase C, `playEvent` in `audio.js`):
  - `score`: the current chord rising from the next 16th, then its root an octave up;
  - `dashStart`: noise through a rising bandpass; `dashEnd`: a short falling triangle tick;
  - `split`: a blip rising a fifth from the chord's top tone; `join`: one falling a fifth onto
    the chord's root; both panned to their position;
  - enemy approach: a low pulse on the chord root, one per beat, eighth or sixteenth as `threat`
    rises past 0.4 and 0.75, louder with threat;
  - `death`: falling sawtooth plus a falling noise thud; the piece fades over 0.4 s and ends on
    its tonic chord (pad, bass, lead) from the next beat, held two beats
    (`stopMusic({ cadence: true })`);
  - `goalMoved`: no sound of its own (the dash or the score covers it).

## Phases

| Phase | Work                                                                                          | Verified by                                                                  |
|-------|-----------------------------------------------------------------------------------------------|------------------------------------------------------------------------------|
| A     | `music.js` port                                                                               | `scripts/music-test.js`: fixed-seed fixtures note for note, notes in scale, voice-leading steps bounded |
| B     | `audio.js` engine: context, buses, scheduler, voices, mute                                     | a test page plays a composed piece without clicks on desktop and a phone    |
| C     | `audio-events.js`, exported `threat()`, hooks in `main.js`, SFX                                | `scripts/events-test.js` with scripted worlds; every event audible in the browser with a fixed `?seed=` |
| D     | adaptive layers (tempo fixed, see Sound design), closing cadence                               | listening on a few seeds: the music answers within a bar                     |
| E     | mute key and HUD mark, mobile pass, `architecture-audio.md`, gotchas entries                   | a mid-range phone and Bluetooth output (open); docs updated (done)           |

## Decisions

- **Same seed, same music.** The music is a pure function of the run's seed (its own stream),
  so a bug report with `?seed=` reproduces what was heard.
- **Music on by default.** Mute (M) turns everything off; there is no separate music switch.
- **Port, not shared.** The needed parts of undead-composer's composer and astrocatch's engine
  are copied into cellrunner and kept here; no shared module across projects.
- **One threat pulse for the enemy telegraph.** A single pulse whose rate follows `threat`, not
  a sound per enemy kind.

## Notes from the sources

- astrocatch skips the compressor for music (it clicked on downbeats) and uses linear ramps for
  music envelopes (iOS Safari). Keep both until tested otherwise.
- astrocatch's file header states 100 BPM and a 500 ms look-ahead; its code uses 120 BPM and
  1.0 s. Trust the code when porting.
- undead-composer works in beats only; the scheduler here converts beats to context time.
