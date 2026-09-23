# VibeConductor: conducting an inspectable instrument

## The idea

VibeConductor explores a small interaction: what if a musical instrument could accept a sentence such as “keep the bass, but give the lead more space,” show what it changed, and still feel like a musical instrument? Its three voices are a procedural drum kit, a monophonic bass and a monophonic lead. A user can compose entirely through the step sequencer and piano rolls; AI is an optional editor of the same score.

The visual direction draws on the compact instrument bank of [Roland50 Studio](https://roland50.studio/), the tangible controls of [Moog Mariana](https://software.moogmusic.com/store/mariana), and the approachable grids of [Ableton Learning Music](https://learningmusic.ableton.com/the-playground.html). Original CSS and SVG form a satin-metal console with rubber drum pads, a speaker cone and small keyboard. These elements respond to notes whose scheduled onset has actually arrived. They stop reacting when their track is muted. The interface uses no copied product imagery, generated samples, or paid media.

## Engineering choices

**One symbolic score, three consumers.** Stable note IDs, integer sixteenth-note positions and a versioned schema describe the music without referencing an audio node or a React component. The editor, real-time player and offline WAV renderer consume this same data. SQLite and JSON export retain the complete score rather than a prompt that must be interpreted again.

**An audio clock with explicit ownership.** Native Web Audio is a good fit for the deliberately small synthesis palette. A timer fills a short future window against the audio context clock; rendering frames only follow it. Each loop freezes its revision, tempo, length and compiled events together. The engine owns every oscillator/noise source so Stop and pending Undo can retract notes already sent to the audio graph.

**Language proposes; validation decides.** The OpenAI integration emits a bounded set of structured operations. Both server and browser validate the resulting score and independently enforce explicit track, tempo, bar and density constraints. The request references a precise revision; accepting a late response after a manual edit is forbidden. Error paths preserve the current music.

**A deliberately lean service.** One Node process owns SQLite, password-protected authoring and an optional model client. Public links point at separate immutable snapshots. This keeps setup understandable and makes deployment possible on a single host with a persistent volume. It deliberately does not solve multi-user collaboration or horizontal scaling.

## A failure that changed the design

During review, a race appeared between the visible revision and the audio clock. Imagine a queued version starts playing just before Undo, but the UI still displays the previous loop. The first implementation calculated Undo from that stale display, while the engine announced the newly audible revision during cancellation. That could give newer audible notes an older revision identity.

The fix makes the audio clock authoritative at the mutation boundary. Undo synchronizes the timeline, retracts unheard loops, receives the canonical retained score, and only then calculates the session transition. A fresh revision ID still invalidates old AI responses. The test suite exercises the loop-boundary and scheduled-source cases with controlled clocks, alongside real-browser source checks. Startup was tightened similarly: after an asynchronous AudioContext resume, the engine reads the latest draft instead of starting an outdated captured score.

## What the evidence does and does not establish

Automated checks cover musical validation, timing coordination, resource cleanup, persistence, privacy boundaries and browser interactions. Offline rendering can verify that WAV data is valid and non-silent. These checks do not establish that every subjective musical instruction produces an appealing phrase.

The owner elected to leave API credentials unconfigured for this delivery. The live integration is implemented, but the repository does not claim measured live model accuracy, latency or cost. The reproducible evaluation harness records those measurements when deliberately run with credentials. Offline constraint evaluation and delayed mocked responses are labeled separately. See [verification](verification.md) for the actual final commands and outcomes.

## Remaining product opportunities

Human listening sessions are the next step for balancing presets and assessing expressive instructions. A later release could add a short transcription action, MIDI export and audio A/B audition of historical versions. Current version comparison is visual; restoring a version makes it audible at the same controlled boundary as any other edit. Continuous voice, arbitrary samples, live-performance recording and collaboration remain outside this release.
