# Score schema, version 1

The score is portable musical data. It contains no audio nodes, model messages, playback position, browser master volume, credentials or executable code. `shared/types.ts` defines its TypeScript interface; `shared/score.ts` is the authoritative runtime validator used on both sides of the API.

## Musical representation

| Field              | Meaning and accepted values                                                               |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `schemaVersion`    | Exactly `1`; unknown versions are rejected.                                               |
| `synthesisVersion` | Exactly `1`; identifies the procedural instrument implementation.                         |
| `id`               | Stable composition identity.                                                              |
| `revisionId`       | Identity of this score snapshot; accepted edits and undo receive a fresh ID.              |
| `title`            | Trimmed, nonempty text, at most 100 characters.                                           |
| `bpm`              | 60–160 beats per minute. Fractional BPM is valid score data.                              |
| `bars`             | `1`, `2` or `4`, always in 4/4.                                                           |
| `key`              | Integer pitch class 0–11, with 0 = C.                                                     |
| `scale`            | `minor`, `major`, `dorian` or major `pentatonic`.                                         |
| `seed`             | Unsigned 32-bit integer for reproducible procedural noise.                                |
| `tracks`           | Exactly one each of `drums`, `bass` and `lead`. Array order is not musically significant. |

IDs are 1–100 characters using letters, digits, underscores and hyphens. New application identities use `crypto.randomUUID()`. All objects use strict validation: unknown fields produce an error rather than being discarded.

A track stores its stable `id`, display `name`, supported `preset`, `volume` from 0–1, `mute` and `solo` booleans, `params: { brightness, decay }` from 0–1, and `notes`.

Every note has these fields:

| Field      | Meaning                                                            |
| ---------- | ------------------------------------------------------------------ |
| `id`       | Stable and unique across all tracks in the composition.            |
| `start`    | Zero-based integer sixteenth-note position from the loop start.    |
| `duration` | Positive integer number of sixteenth-note steps.                   |
| `pitch`    | Integer MIDI pitch. Bass: 28–60; lead: 48–84.                      |
| `velocity` | Number from 0.05–1.                                                |
| `drum`     | `kick`, `snare` or `hat` for percussion; `null` for melodic notes. |

There are 16 steps per bar, so a two-bar loop covers steps 0–31. Note intervals are half-open: `[start, start + duration)`. Adjacent notes may touch. Notes may cross an internal bar line but must end by `bars * 16`; they never wrap to the next loop.

Bass and lead are monophonic. Each drum voice is also non-overlapping with itself, while different drum voices may coincide. Drum pitch and voice must agree: kick 36, snare 38, hi-hat 42. These rules allow at most five simultaneous logical notes, excluding brief synthesis release crossfades; a logical note may use multiple native oscillator/noise sources.

Drums allow at most 192 notes and each melodic track allows at most 64, for a 320-note ceiling. Drums may have longer symbolic durations, although their synthesis envelope can finish earlier. The live/offline synthesizer ends sustain by the loop boundary and permits only a short release tail, capped at 12 ms beyond that boundary.

Key and scale provide a visual composition guide. They do not transpose existing notes or prohibit chromatic manual/imported notes. Supported intervals are major `[0,2,4,5,7,9,11]`, minor `[0,2,3,5,7,8,10]`, Dorian `[0,2,3,5,7,9,10]`, and major pentatonic `[0,2,4,7,9]`.

## Instrument palette and compilation

| Track | Preset identifiers                      |
| ----- | --------------------------------------- |
| Drums | `warm-kit`, `tight-kit`, `dry-kit`      |
| Bass  | `round-bass`, `sub-bass`, `rubber-bass` |
| Lead  | `glass-lead`, `soft-lead`, `pluck-lead` |

`PRESETS` supplies display names, descriptions and initial brightness/decay settings. Those parameters are persisted explicitly; restoring a score does not depend on reapplying preset defaults.

`compileScore(score)` produces `CompiledEvent[]` with `noteId`, `trackId`, `startStep`, `durationSteps`, `pitch`, `velocity`, `drum`, `preset`, `brightness`, `decay` and `volume`. Sorting is by start step, track order (drums/bass/lead), pitch, then note ID. This conversion is pure and does not omit muted tracks: live mixer gates remain independent of future scheduling. Playback and WAV export use the same conversion and synthesis functions.

One step lasts `60 / bpm / 4` seconds. The loop lasts `bars * 4 * 60 / bpm` seconds. The persisted seed makes noise reproducible for a particular sample rate and synthesis implementation; native browser DSP is not promised to produce byte-identical WAVs across engines or platforms.

## Structured edit contract

An `EditProposal` has `baseRevisionId`, a nonempty explanation (at most 600 characters), and 1–320 operations. No operation can change composition identity, key, scale, loop length, title, mute or solo. Those are manual controls.

| Operation    | Required payload                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| `upsertNote` | `trackId` and a complete validated `note`; an existing ID updates that note, otherwise it adds a note.         |
| `removeNote` | `trackId` and an existing `noteId`.                                                                            |
| `setTrack`   | `trackId`, `preset`, `volume`, `brightness`, `decay`; every field is present and `null` means leave unchanged. |
| `setTempo`   | `bpm` within the score range.                                                                                  |

`applyProposal(score, proposal, constraints)` works on a deep copy and returns a new score with a fresh revision. It rejects stale bases, duplicate operations against the same note or settings target, reuse of another track's note ID, unknown removals, invalid presets and any final score invariant violation. Moving an existing note preserves its ID. An error leaves the original score untouched.

Constraints are validated independently of a model's explanation:

- `protectedTracks`: those tracks cannot receive any operation, including instrument changes.
- `lockTempo`: the tempo must stay unchanged.
- `targetBar`: one-based bar number, or `null`. Both old and new note spans must fit wholly inside that bar. Global tempo and track-wide parameter operations are forbidden.
- `fewerNotes`: listed tracks must finish with strictly fewer notes. With a bar target, the count covers notes wholly contained in that bar.
- `maxNoteRatio`: optional upper ratio for the same density targets. “Half as busy” maps to 0.5, so the resulting count must be no greater than `floor(originalCount / 2)`.

`parseConstraints(direction, explicitConstraints)` merges common explicit phrases with the UI controls; it never removes an explicit protection. It recognizes unchanged/untouched tracks, tempo preservation, one-bar targeting and reductions such as fewer notes or half as busy. Conflicting bar selections fail. This deterministic guardrail is intentionally a small phrase parser, not a general natural-language interpreter; ambiguous musical qualities still belong to model interpretation and human listening.

## Utility and persistence boundaries

- `parseScore(value)` returns a validated score or throws a Zod error. `validateScore(value)` returns a success result or readable error paths.
- `cloneScore(score, freshRevision = true)` preserves composition/note IDs and copies every mutable object; callers may preserve a revision for exact snapshots.
- `resizeScore(score, bars)` removes notes starting beyond the new boundary, trims crossing notes, preserves surviving IDs and assigns a new revision. Increasing length adds silence.
- `pitchName`, `scalePitches` and `loopSeconds` are shared UI/audio helpers.

JSON export contains the score itself. Import validates it before creating a new composition identity. Saved composition records additionally contain `updatedAt` and version history; the save API accepts at most 30 history entries and requires them to belong to the same composition. Immutable shared snapshots contain only the score and creation timestamp. See [API reference](api.md) for request and response shapes.

`tests/domain.test.ts` exercises validation failures, overlapping notes, loop limits, ID preservation, deterministic compilation, JSON round trips, resizing and atomic constraint rejection. These tests verify symbolic musical behavior; they are not listening evaluations.
