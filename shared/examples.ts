import { DRUM_PITCHES, parseScore, PRESETS } from "./score.js";
import type { Drum, Note, Score, Track, TrackId } from "./types.js";

export interface Example {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  score: Score;
}

function melody(
  id: string,
  track: TrackId,
  phrase: [start: number, pitch: number, duration: number, velocity?: number][],
): Note[] {
  return phrase.map(([start, pitch, duration, velocity = 0.68], index) => ({
    id: `${id}-${track}-${String(index + 1).padStart(2, "0")}`,
    start,
    pitch,
    duration,
    velocity,
    drum: null,
  }));
}

function kit(
  id: string,
  bars: number,
  kicks: number[][],
  style: "soft" | "light" | "drive",
): Note[] {
  const notes: Note[] = [];
  const hit = (drum: Drum, start: number, velocity: number) =>
    notes.push({
      id: `${id}-${drum}-${start}`,
      start,
      duration: 1,
      pitch: DRUM_PITCHES[drum],
      velocity,
      drum,
    });
  for (let bar = 0; bar < bars; bar++) {
    for (const step of kicks[bar % kicks.length])
      hit("kick", bar * 16 + step, step === 0 ? 0.85 : 0.68);
    for (const step of [4, 12])
      hit("snare", bar * 16 + step, style === "soft" ? 0.52 : 0.65);
    for (const step of [0, 2, 4, 6, 8, 10, 12, 14]) {
      hit(
        "hat",
        bar * 16 + step,
        (step % 4 === 0 ? 0.32 : 0.22) + (style === "drive" ? 0.06 : 0),
      );
    }
    if (style === "soft" && bar === bars - 1) hit("snare", bar * 16 + 15, 0.18);
    if (style === "light" && bar === bars - 1) hit("hat", bar * 16 + 15, 0.18);
  }
  return notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

function track(
  id: TrackId,
  presetId: string,
  volume: number,
  notes: Note[],
): Track {
  const preset = PRESETS[id].find((item) => item.id === presetId)!;
  return {
    id,
    name: { drums: "Drums", bass: "Bass", lead: "Lead" }[id],
    preset: presetId,
    volume,
    mute: false,
    solo: false,
    params: { brightness: preset.brightness, decay: preset.decay },
    notes,
  };
}

function example(
  id: string,
  title: string,
  subtitle: string,
  description: string,
  score: Omit<
    Score,
    "id" | "revisionId" | "title" | "schemaVersion" | "synthesisVersion"
  >,
): Example {
  return {
    id,
    title,
    subtitle,
    description,
    score: parseScore({
      schemaVersion: 1,
      synthesisVersion: 1,
      id: `example-${id}`,
      revisionId: `${id}-v1`,
      title,
      ...score,
    }),
  };
}

/** Original, fixed compositions. Opening one never calls a model or generates hidden notes. */
export const EXAMPLES: Example[] = [
  example(
    "after-hours",
    "After hours",
    "A quiet room, a little swing",
    "A mellow two-bar conversation: warm percussion, round bass and a melody with room to breathe.",
    {
      bpm: 86,
      bars: 2,
      key: 9,
      scale: "dorian",
      seed: 1847,
      tracks: [
        track(
          "drums",
          "warm-kit",
          0.7,
          kit(
            "after-hours",
            2,
            [
              [0, 7, 10],
              [0, 6, 11],
            ],
            "soft",
          ),
        ),
        track(
          "bass",
          "round-bass",
          0.7,
          melody("after-hours", "bass", [
            [0, 45, 5],
            [7, 52, 2, 0.58],
            [10, 43, 4],
            [16, 38, 6],
            [23, 45, 3],
            [28, 43, 3, 0.55],
          ]),
        ),
        track(
          "lead",
          "soft-lead",
          0.54,
          melody("after-hours", "lead", [
            [2, 69, 2],
            [6, 72, 2, 0.58],
            [9, 76, 4],
            [18, 74, 3],
            [23, 72, 2, 0.57],
            [27, 69, 4, 0.6],
          ]),
        ),
      ],
    },
  ),
  example(
    "paper-planes",
    "Paper planes",
    "Light on its feet",
    "A bright four-bar melody skips over a playful bass line and dry, delicate percussion.",
    {
      bpm: 112,
      bars: 4,
      key: 2,
      scale: "major",
      seed: 2609,
      tracks: [
        track(
          "drums",
          "dry-kit",
          0.64,
          kit(
            "paper-planes",
            4,
            [
              [0, 6, 10],
              [0, 7, 8],
            ],
            "light",
          ),
        ),
        track(
          "bass",
          "rubber-bass",
          0.6,
          melody("paper-planes", "bass", [
            [0, 38, 3],
            [6, 45, 2],
            [10, 50, 3],
            [16, 35, 3],
            [22, 42, 2],
            [26, 47, 3],
            [32, 43, 3],
            [38, 50, 2],
            [42, 47, 3],
            [48, 45, 4],
            [54, 52, 2],
            [58, 49, 3],
          ]),
        ),
        track(
          "lead",
          "pluck-lead",
          0.48,
          melody("paper-planes", "lead", [
            [0, 74, 2],
            [3, 78, 2],
            [6, 81, 3],
            [12, 78, 2, 0.54],
            [16, 78, 2],
            [19, 76, 2],
            [22, 74, 4],
            [32, 79, 2],
            [35, 78, 2],
            [38, 76, 3],
            [43, 74, 2, 0.55],
            [48, 73, 2],
            [51, 76, 2],
            [56, 74, 6, 0.6],
          ]),
        ),
      ],
    },
  ),
  example(
    "night-drive",
    "Night drive",
    "City lights in slow motion",
    "A steady pulse and deep bass support a glassy, syncopated four-bar phrase in C minor.",
    {
      bpm: 122,
      bars: 4,
      key: 0,
      scale: "minor",
      seed: 7713,
      tracks: [
        track(
          "drums",
          "tight-kit",
          0.68,
          kit("night-drive", 4, [[0, 4, 8, 12]], "drive"),
        ),
        track(
          "bass",
          "sub-bass",
          0.72,
          melody("night-drive", "bass", [
            [0, 36, 5],
            [6, 36, 2, 0.55],
            [10, 43, 4],
            [16, 32, 5],
            [22, 39, 2, 0.55],
            [26, 44, 4],
            [32, 39, 5],
            [38, 39, 2, 0.55],
            [42, 46, 4],
            [48, 34, 5],
            [54, 41, 2, 0.55],
            [58, 43, 4],
          ]),
        ),
        track(
          "lead",
          "glass-lead",
          0.46,
          melody("night-drive", "lead", [
            [2, 72, 3, 0.6],
            [7, 67, 2, 0.5],
            [11, 70, 3, 0.55],
            [18, 72, 3, 0.6],
            [23, 75, 2, 0.52],
            [27, 74, 3, 0.55],
            [34, 70, 3, 0.6],
            [39, 67, 2, 0.5],
            [43, 75, 3, 0.55],
            [50, 74, 3, 0.6],
            [55, 70, 2, 0.5],
            [59, 72, 4, 0.58],
          ]),
        ),
      ],
    },
  ),
];
