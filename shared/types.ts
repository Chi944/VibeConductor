export type TrackId = "drums" | "bass" | "lead";
export type Drum = "kick" | "snare" | "hat";
export type Scale = "minor" | "major" | "dorian" | "pentatonic";
export interface Note {
  id: string;
  start: number;
  duration: number;
  pitch: number;
  velocity: number;
  drum: Drum | null;
}
export interface Track {
  id: TrackId;
  name: string;
  preset: string;
  volume: number;
  mute: boolean;
  solo: boolean;
  params: { brightness: number; decay: number };
  notes: Note[];
}
export interface Score {
  schemaVersion: 1;
  synthesisVersion: 1;
  id: string;
  revisionId: string;
  title: string;
  bpm: number;
  bars: 1 | 2 | 4;
  key: number;
  scale: Scale;
  seed: number;
  tracks: Track[];
}
export type EditOperation =
  | { type: "upsertNote"; trackId: TrackId; note: Note }
  | { type: "removeNote"; trackId: TrackId; noteId: string }
  | {
      type: "setTrack";
      trackId: TrackId;
      preset: string | null;
      volume: number | null;
      brightness: number | null;
      decay: number | null;
    }
  | { type: "setTempo"; bpm: number };
export interface EditProposal {
  baseRevisionId: string;
  explanation: string;
  operations: EditOperation[];
}
export interface EditConstraints {
  protectedTracks: TrackId[];
  lockTempo: boolean;
  targetBar: number | null;
  fewerNotes: TrackId[];
  maxNoteRatio?: number;
}
export interface ConductRequest {
  requestId: string;
  direction: string;
  score: Score;
  constraints: EditConstraints;
}
export interface ConductResult {
  requestId: string;
  proposal: EditProposal;
  usage: {
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    model: string;
    estimatedCostUsd: number | null;
  };
}
export interface HistoryEntry {
  id: string;
  score: Score;
  label: string;
  at: string;
  direction?: string;
}
export interface SavedComposition {
  id: string;
  title: string;
  updatedAt: string;
  score: Score;
  history: HistoryEntry[];
}
export const TRACK_IDS: TrackId[] = ["drums", "bass", "lead"];
