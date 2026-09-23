import { z } from "zod";
import {
  TRACK_IDS,
  type Drum,
  type Scale,
  type Score,
  type TrackId,
} from "./types.js";

export const STEPS_PER_BAR = 16;
export const DRUM_PITCHES: Record<Drum, number> = {
  kick: 36,
  snare: 38,
  hat: 42,
};
export const PITCH_LIMITS = { bass: [28, 60], lead: [48, 84] } as const;
export const PRESETS: Record<
  TrackId,
  {
    id: string;
    name: string;
    description: string;
    brightness: number;
    decay: number;
  }[]
> = {
  drums: [
    {
      id: "warm-kit",
      name: "Warm room",
      description: "Rounded kick, brushed snare and soft hats.",
      brightness: 0.4,
      decay: 0.38,
    },
    {
      id: "tight-kit",
      name: "Pocket kit",
      description: "Focused transients and crisp closed hats.",
      brightness: 0.7,
      decay: 0.2,
    },
    {
      id: "dry-kit",
      name: "Paper kit",
      description: "Short, dry percussion with a light touch.",
      brightness: 0.52,
      decay: 0.12,
    },
  ],
  bass: [
    {
      id: "round-bass",
      name: "Rounded",
      description: "A mellow, rounded bass foundation.",
      brightness: 0.3,
      decay: 0.58,
    },
    {
      id: "sub-bass",
      name: "Submarine",
      description: "A soft sine-centered low end.",
      brightness: 0.12,
      decay: 0.7,
    },
    {
      id: "rubber-bass",
      name: "Rubber",
      description: "A buoyant, filtered bass pluck.",
      brightness: 0.52,
      decay: 0.3,
    },
  ],
  lead: [
    {
      id: "glass-lead",
      name: "Glass keys",
      description: "Clear, bell-like notes with a gentle edge.",
      brightness: 0.65,
      decay: 0.55,
    },
    {
      id: "soft-lead",
      name: "Soft focus",
      description: "A rounded melody voice for slower phrases.",
      brightness: 0.28,
      decay: 0.7,
    },
    {
      id: "pluck-lead",
      name: "Daylight",
      description: "A bright, short pluck that leaves room to breathe.",
      brightness: 0.72,
      decay: 0.24,
    },
  ],
};

export const idSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/, "Use a stable alphanumeric ID.");
export const trackIdSchema = z.enum(["drums", "bass", "lead"]);
export const noteSchema = z
  .object({
    id: idSchema,
    start: z.number().int().min(0).max(63),
    duration: z.number().int().min(1).max(64),
    pitch: z.number().int().min(0).max(127),
    velocity: z.number().min(0.05).max(1),
    drum: z.enum(["kick", "snare", "hat"]).nullable(),
  })
  .strict();

export const trackSchema = z
  .object({
    id: trackIdSchema,
    name: z.string().trim().min(1).max(40),
    preset: z.string().min(1).max(40),
    volume: z.number().min(0).max(1),
    mute: z.boolean(),
    solo: z.boolean(),
    params: z
      .object({
        brightness: z.number().min(0).max(1),
        decay: z.number().min(0).max(1),
      })
      .strict(),
    notes: z.array(noteSchema).max(192),
  })
  .strict();

export const scoreSchema: z.ZodType<Score> = z
  .object({
    schemaVersion: z.literal(1),
    synthesisVersion: z.literal(1),
    id: idSchema,
    revisionId: idSchema,
    title: z.string().trim().min(1).max(100),
    bpm: z.number().min(60).max(160),
    bars: z.union([z.literal(1), z.literal(2), z.literal(4)]),
    key: z.number().int().min(0).max(11),
    scale: z.enum(["minor", "major", "dorian", "pentatonic"]),
    seed: z.number().int().min(0).max(0xffffffff),
    tracks: z.array(trackSchema).length(3),
  })
  .strict()
  .superRefine((score, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    if (new Set(score.tracks.map((track) => track.id)).size !== 3) {
      issue(["tracks"], "Include exactly one drums, bass and lead track.");
    }
    const noteIds = new Set<string>();
    const loopEnd = score.bars * STEPS_PER_BAR;
    for (const [trackIndex, track] of score.tracks.entries()) {
      const path = ["tracks", trackIndex] as (string | number)[];
      if (!PRESETS[track.id].some((preset) => preset.id === track.preset))
        issue([...path, "preset"], `Unknown ${track.id} preset.`);
      const maxNotes = track.id === "drums" ? 192 : 64;
      if (track.notes.length > maxNotes)
        issue(
          [...path, "notes"],
          `${track.id} supports at most ${maxNotes} notes.`,
        );
      for (const [noteIndex, note] of track.notes.entries()) {
        const notePath = [...path, "notes", noteIndex];
        if (noteIds.has(note.id))
          issue(
            [...notePath, "id"],
            "Note IDs must be unique throughout the score.",
          );
        noteIds.add(note.id);
        if (note.start + note.duration > loopEnd)
          issue(
            [...notePath, "duration"],
            "Notes must end at or before the loop boundary.",
          );
        if (track.id === "drums") {
          if (note.drum === null || DRUM_PITCHES[note.drum] !== note.pitch)
            issue(
              [...notePath, "pitch"],
              "Drum pitches are kick 36, snare 38 and hat 42.",
            );
        } else {
          const [low, high] = PITCH_LIMITS[track.id];
          if (note.drum !== null)
            issue(
              [...notePath, "drum"],
              "Melodic notes cannot have a drum voice.",
            );
          if (note.pitch < low || note.pitch > high)
            issue(
              [...notePath, "pitch"],
              `${track.id} pitches must be between MIDI ${low} and ${high}.`,
            );
        }
      }
      const groups =
        track.id === "drums"
          ? (["kick", "snare", "hat"] as const).map((drum) =>
              track.notes.filter((note) => note.drum === drum),
            )
          : [track.notes];
      for (const group of groups) {
        const sorted = [...group].sort(
          (a, b) => a.start - b.start || a.duration - b.duration,
        );
        for (let i = 1; i < sorted.length; i++) {
          if (sorted[i].start < sorted[i - 1].start + sorted[i - 1].duration) {
            issue(
              [...path, "notes"],
              track.id === "drums"
                ? "The same drum voice cannot overlap itself."
                : `${track.id} is monophonic; notes cannot overlap.`,
            );
            break;
          }
        }
      }
    }
  });

export function parseScore(value: unknown): Score {
  return scoreSchema.parse(value);
}

export function validateScore(
  value: unknown,
): { success: true; score: Score } | { success: false; errors: string[] } {
  const result = scoreSchema.safeParse(value);
  return result.success
    ? { success: true, score: result.data }
    : {
        success: false,
        errors: result.error.issues.map(
          (issue) => `${issue.path.join(".") || "score"}: ${issue.message}`,
        ),
      };
}

export function newId(): string {
  return globalThis.crypto.randomUUID();
}

export function cloneScore(score: Score, freshRevision = true): Score {
  const copy = structuredClone(score);
  if (freshRevision) copy.revisionId = newId();
  return copy;
}

export interface CompiledEvent {
  noteId: string;
  trackId: TrackId;
  startStep: number;
  durationSteps: number;
  pitch: number;
  velocity: number;
  drum: Drum | null;
  preset: string;
  brightness: number;
  decay: number;
  volume: number;
}

/** Pure musical conversion. Mixer gates intentionally remain independent of scheduling. */
export function compileScore(score: Score): CompiledEvent[] {
  return score.tracks
    .flatMap((track) =>
      track.notes.map((note) => ({
        noteId: note.id,
        trackId: track.id,
        startStep: note.start,
        durationSteps: note.duration,
        pitch: note.pitch,
        velocity: note.velocity,
        drum: note.drum,
        preset: track.preset,
        brightness: track.params.brightness,
        decay: track.params.decay,
        volume: track.volume,
      })),
    )
    .sort(
      (a, b) =>
        a.startStep - b.startStep ||
        TRACK_IDS.indexOf(a.trackId) - TRACK_IDS.indexOf(b.trackId) ||
        a.pitch - b.pitch ||
        (a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : 0),
    );
}

export function loopSeconds(score: Pick<Score, "bpm" | "bars">): number {
  return (score.bars * 4 * 60) / score.bpm;
}

const NOTE_NAMES = [
  "C",
  "C♯",
  "D",
  "D♯",
  "E",
  "F",
  "F♯",
  "G",
  "G♯",
  "A",
  "A♯",
  "B",
];
export function pitchName(pitch: number): string {
  return `${NOTE_NAMES[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`;
}

const SCALE_INTERVALS: Record<Scale, number[]> = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  pentatonic: [0, 2, 4, 7, 9],
};

export function scalePitches(
  key: number,
  scale: Scale,
  min: number,
  max: number,
): number[] {
  const allowed = new Set(
    SCALE_INTERVALS[scale].map((interval) => (key + interval) % 12),
  );
  const pitches: number[] = [];
  for (let pitch = Math.ceil(min); pitch <= Math.floor(max); pitch++)
    if (allowed.has(((pitch % 12) + 12) % 12)) pitches.push(pitch);
  return pitches;
}

/** Preserve surviving IDs; expansion adds silence and shortening trims boundary notes. */
export function resizeScore(score: Score, bars: Score["bars"]): Score {
  const copy = cloneScore(score);
  const boundary = bars * STEPS_PER_BAR;
  copy.bars = bars;
  for (const track of copy.tracks) {
    track.notes = track.notes
      .filter((note) => note.start < boundary)
      .map((note) => ({
        ...note,
        duration: Math.min(note.duration, boundary - note.start),
      }));
  }
  return parseScore(copy);
}
