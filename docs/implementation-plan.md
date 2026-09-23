# VibeConductor implementation plan

Build an independent private repository, with a React/TypeScript tactile console, an Express server, SQLite persistence and direct Web Audio. The user selected a modern tactile console and allowed roughly a month for polish. AI credentials intentionally remain unconfigured until supplied by the owner. No preset response may masquerade as live AI.

## Delivery sequence

1. Versioned score validation, three original compositions, pure event compiler and reliable audio scheduling.
2. Accessible drum sequencer, bass/lead piano rolls, physical-looking console and sound-driven ensemble animation.
3. Real server-side OpenAI structured edit integration, independent validation, explicit constraints and stale response protection.
4. Draft recovery, undo/version comparison, private saving, immutable public snapshot links and validated JSON exchange.
5. Reliability tests, browser checks, sound/visual refinement, evaluation harness, documentation and WAV export after core checks.

## Musical contract

Exactly drums/bass/lead, 4/4, 16 steps per bar, 1/2/4 bars, 60–160 BPM. Note positions and lengths are integer steps; velocity 0.05–1. Bass MIDI 28–60, lead 48–84. Drums use kick 36, snare 38, hat 42. Bass and lead intervals cannot overlap. Notes may cross internal bar lines but cannot cross the loop end. Maximum 320 notes (192 drums and 64 per melodic track); at most five simultaneously sounding voices, excluding short release crossfades. Noise and original examples are seeded/self-created.

## Revision/audio contract

Maintain draft, pending and sounding scores. All accepted mutations get fresh revision IDs, including undo. AI results refer to the precise base revision; manual edits, undo or newer requests invalidate older results. During playback, edits enter the next loop boundary not yet scheduled; later edits can replace an unscheduled pending candidate. Before sounding, Undo cancels the whole pending batch first. The engine owns scheduled sources and can retract an unheard pending revision, restoring the previously sounding sequence at that boundary; this cancellation is explicitly distinct from adding a new edit. All ordinary score changes follow the boundary rule. Stop commits the latest draft for the next Play, cancels every old source, and resets position. Volume/mute/solo use immediate ramped mixer gates, separate from note envelopes. Hidden tabs and suspended contexts stop safely and require Play to restart.

## Design

Satin aluminum enclosure #d5d5d0, graphite panel #303532, ivory text #f2f2e9; coral drums #ee866d, sage bass #bdd38e, sky lead #90bdde. Use locally bundled Manrope and IBM Plex Mono for numbers. One integrated instrument with left-aligned transport, three physical modules, an inset sequencer and a compact conductor strip. Speaker/pad/key motion follows actual sounding notes only. Keep note editors crisp and flat. CSS/SVG material rendering with a consistent upper-left light source, no third-party product imagery.

## Acceptance

Test schema invariants, deterministic compilation, loop/tempo boundaries, duplicate prevention, future-source cancellation, stop/restart, stale AI, undo-before-audible, invalid responses, save/reload, JSON roundtrip, access control and immutable sharing. Run browser checks for real audio start/stop, manual editing, responsive/reduced-motion behavior and suspension. Separate simulated tests, browser verification, offline rendering and unavailable live AI evaluation in reports. Commit all source and documentation, create a private GitHub repo, review through PR, resolve findings, pass CI and merge all created PRs.
