import { z } from "zod";
import {
  cloneScore,
  idSchema,
  noteSchema,
  parseScore,
  PRESETS,
  trackIdSchema,
} from "./score";
import {
  TRACK_IDS,
  type EditConstraints,
  type EditProposal,
  type Note,
  type Score,
  type TrackId,
} from "./types";

export const constraintsSchema: z.ZodType<EditConstraints> = z
  .object({
    protectedTracks: z
      .array(trackIdSchema)
      .max(3)
      .refine(
        (items) => new Set(items).size === items.length,
        "Protected tracks must be unique.",
      ),
    lockTempo: z.boolean(),
    targetBar: z.number().int().min(1).max(4).nullable(),
    fewerNotes: z
      .array(trackIdSchema)
      .max(3)
      .refine(
        (items) => new Set(items).size === items.length,
        "Fewer-note tracks must be unique.",
      ),
    maxNoteRatio: z.number().gt(0).max(1).optional(),
  })
  .strict();

const operationSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("upsertNote"),
      trackId: trackIdSchema,
      note: noteSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("removeNote"),
      trackId: trackIdSchema,
      noteId: idSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("setTrack"),
      trackId: trackIdSchema,
      preset: z.string().min(1).max(40).nullable(),
      volume: z.number().min(0).max(1).nullable(),
      brightness: z.number().min(0).max(1).nullable(),
      decay: z.number().min(0).max(1).nullable(),
    })
    .strict(),
  z
    .object({ type: z.literal("setTempo"), bpm: z.number().min(60).max(160) })
    .strict(),
]);

export const proposalSchema: z.ZodType<EditProposal> = z
  .object({
    baseRevisionId: idSchema,
    explanation: z.string().trim().min(1).max(600),
    operations: z.array(operationSchema).min(1).max(320),
  })
  .strict();

function insideBar(note: Note, bar: number): boolean {
  const begin = (bar - 1) * 16;
  return note.start >= begin && note.start + note.duration <= begin + 16;
}

/** Applies only to a copy: malformed, stale or constraint-breaking proposals are atomic failures. */
export function applyProposal(
  score: Score,
  proposal: EditProposal,
  constraints: EditConstraints,
): Score {
  const base = parseScore(score);
  const edit = proposalSchema.parse(proposal);
  const limits = constraintsSchema.parse(constraints);
  if (edit.baseRevisionId !== base.revisionId)
    throw new Error(
      "This direction belongs to an older revision. Try it again against the current score.",
    );
  if (limits.targetBar !== null && limits.targetBar > base.bars)
    throw new Error(
      `Bar ${limits.targetBar} does not exist in this ${base.bars}-bar loop.`,
    );
  const next = cloneScore(base);
  const touched = new Set<string>();
  for (const operation of edit.operations) {
    if (operation.type === "setTempo") {
      if (limits.lockTempo && operation.bpm !== base.bpm)
        throw new Error("The direction requires the tempo to stay unchanged.");
      if (limits.targetBar !== null)
        throw new Error(
          "A change limited to one bar cannot change the loop tempo.",
        );
      if (touched.has("tempo"))
        throw new Error("The proposal changes tempo more than once.");
      touched.add("tempo");
      next.bpm = operation.bpm;
      continue;
    }
    const track = next.tracks.find((item) => item.id === operation.trackId)!;
    if (limits.protectedTracks.includes(track.id))
      throw new Error(
        `The ${track.id} track is protected and must stay exactly as it is.`,
      );
    if (operation.type === "setTrack") {
      if (limits.targetBar !== null)
        throw new Error(
          "A change limited to one bar cannot change track-wide instrument settings.",
        );
      const token = `track:${track.id}`;
      if (touched.has(token))
        throw new Error(
          `The proposal changes ${track.id} settings more than once.`,
        );
      touched.add(token);
      if (operation.preset !== null) {
        if (!PRESETS[track.id].some((preset) => preset.id === operation.preset))
          throw new Error(`Unknown preset for ${track.id}.`);
        track.preset = operation.preset;
      }
      if (operation.volume !== null) track.volume = operation.volume;
      if (operation.brightness !== null)
        track.params.brightness = operation.brightness;
      if (operation.decay !== null) track.params.decay = operation.decay;
      continue;
    }
    const noteId =
      operation.type === "upsertNote" ? operation.note.id : operation.noteId;
    const token = `note:${noteId}`;
    if (touched.has(token))
      throw new Error(`The proposal changes note ${noteId} more than once.`);
    touched.add(token);
    const existing = track.notes.find((note) => note.id === noteId);
    if (limits.targetBar !== null) {
      if (existing && !insideBar(existing, limits.targetBar))
        throw new Error(
          `Only notes wholly inside bar ${limits.targetBar} may change.`,
        );
      if (
        operation.type === "upsertNote" &&
        !insideBar(operation.note, limits.targetBar)
      )
        throw new Error(
          `New notes must stay wholly inside bar ${limits.targetBar}.`,
        );
    }
    if (operation.type === "removeNote") {
      if (!existing)
        throw new Error(`Cannot remove an unknown note from ${track.id}.`);
      track.notes = track.notes.filter((note) => note.id !== noteId);
    } else {
      if (
        next.tracks.some(
          (other) =>
            other.id !== track.id &&
            other.notes.some((note) => note.id === noteId),
        )
      )
        throw new Error(
          "A note ID cannot be moved to or reused on another track.",
        );
      if (existing)
        track.notes = track.notes.map((note) =>
          note.id === noteId ? structuredClone(operation.note) : note,
        );
      else track.notes.push(structuredClone(operation.note));
    }
  }
  for (const trackId of limits.fewerNotes) {
    const count = (source: Score) =>
      source.tracks
        .find((track) => track.id === trackId)!
        .notes.filter(
          (note) =>
            limits.targetBar === null || insideBar(note, limits.targetBar),
        ).length;
    const before = count(base);
    const after = count(next);
    if (before === 0)
      throw new Error(
        `The ${trackId} track has no notes to reduce${limits.targetBar === null ? "" : ` in bar ${limits.targetBar}`}.`,
      );
    if (after >= before)
      throw new Error(
        `The direction requires fewer ${trackId} notes${limits.targetBar === null ? "" : ` in bar ${limits.targetBar}`}.`,
      );
    if (
      limits.maxNoteRatio !== undefined &&
      after > Math.floor(before * limits.maxNoteRatio)
    ) {
      throw new Error(
        `The direction requires at most ${Math.floor(before * limits.maxNoteRatio)} ${trackId} notes${limits.targetBar === null ? "" : ` in bar ${limits.targetBar}`}.`,
      );
    }
  }
  return parseScore(next);
}

const TRACK_WORDS: Record<TrackId, RegExp> = {
  drums: /\b(?:drums?|percussion|hi[ -]?hats?|hats?|kicks?|snares?)\b/i,
  bass: /\b(?:bass|bassline|bass line)\b/i,
  lead: /\b(?:lead|melody|melodic line)\b/i,
};
const mentionedTracks = (text: string): TrackId[] =>
  TRACK_IDS.filter((trackId) => TRACK_WORDS[trackId].test(text));

/** Small deterministic guardrail parser. Musical interpretation belongs to the model. */
export function parseConstraints(
  direction: string,
  explicitConstraints: EditConstraints,
): EditConstraints {
  const limits = constraintsSchema.parse(explicitConstraints);
  const text = direction.toLowerCase().replaceAll("’", "'");
  const protectedTracks = new Set(limits.protectedTracks);
  const fewerNotes = new Set(limits.fewerNotes);
  // Match only track noun lists. A wildcard can leak "unchanged" from a later
  // clause into "keep the bass moving", which is an expressive direction.
  const trackNoun = String.raw`(?:the\s+)?(?:drums?|percussion|hi[ -]?hats?|hats?|kicks?|snares?|bass(?:line|\s+line)?|lead|melody|melodic\s+line)(?:\s+tracks?)?`;
  const trackList = String.raw`${trackNoun}(?:(?:\s+(?:and|&)\s+|\s*,\s*(?:and\s+)?)${trackNoun})*`;
  const preservationVerb = String.raw`\b(?:keep|keeping|leave|leaving|preserve|preserving|retain|retaining)\s+`;
  const preservationPatterns = [
    new RegExp(
      String.raw`${preservationVerb}(${trackList})\s+(?:exactly\s+)?(?:unchanged|unmodified|untouched|the same|alone|intact|as\s+(?:(?:it|they)\s+)?(?:is|are))\b`,
      "g",
    ),
    // "Keep the bass, but ..." is protection; "keep the bass moving" is not.
    new RegExp(
      String.raw`${preservationVerb}(${trackList})(?=\s*(?:[,.;!?]|\bbut\b|$))`,
      "g",
    ),
  ];
  for (const pattern of preservationPatterns)
    for (const match of text.matchAll(pattern))
      for (const track of mentionedTracks(match[1])) protectedTracks.add(track);
  const negative =
    /\b(?:don't|do not|never)\s+(?:change|alter|edit|touch|modify)\s+([^.;!?,]{1,100}?)(?=\s+(?:but|and\s+(?:make|change|edit|give|move|add|remove))\b|[.;!?,]|$)/g;
  for (const match of text.matchAll(negative))
    for (const track of mentionedTracks(match[1])) protectedTracks.add(track);
  const unchanged =
    /\b(drums?|percussion|bass(?:line| line)?|lead|melody)\s+(?:must\s+|should\s+)?(?:stay|remain)\s+(?:exactly\s+)?(?:unchanged|the same|as\s+(?:it|they)\s+(?:is|are))/g;
  for (const match of text.matchAll(unchanged))
    for (const track of mentionedTracks(match[1])) protectedTracks.add(track);
  const lockTempo =
    limits.lockTempo ||
    /\b(?:keep|leave|preserve|retain)\s+(?:the\s+)?(?:tempo|bpm|speed)\s+(?:exactly\s+)?(?:unchanged|unmodified|untouched|the same|as\s+(?:it\s+)?is)\b/.test(
      text,
    ) ||
    /\b(?:don't|do not|never)\s+(?:change|alter|edit|touch|modify)\s+(?:the\s+)?(?:tempo|bpm|speed)\b/.test(
      text,
    ) ||
    /\b(?:tempo|bpm|speed)\s+(?:(?:must|should)\s+)?(?:stay|remain)\s+(?:unchanged|the same)\b/.test(
      text,
    ) ||
    /\bwithout\s+(?:changing|altering)\s+(?:the\s+)?(?:tempo|bpm|speed)\b/.test(
      text,
    ) ||
    /\b(?:tempo|bpm)\s+unchanged\b/.test(text);
  const barNumbers: Record<string, number> = {
    first: 1,
    second: 2,
    third: 3,
    fourth: 4,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    "1": 1,
    "2": 2,
    "3": 3,
    "4": 4,
    "1st": 1,
    "2nd": 2,
    "3rd": 3,
    "4th": 4,
  };
  const ordinal = "(first|second|third|fourth|1st|2nd|3rd|4th|[1-4])";
  const cardinal = "(one|two|three|four|[1-4])";
  const barPatterns = [
    new RegExp(
      `\\bonly\\s+(?:(?:edit|change|alter|modify)\\s+)?(?:in\\s+)?(?:the\\s+)?${ordinal}\\s+bar\\b`,
      "g",
    ),
    new RegExp(
      `\\bonly\\s+(?:(?:edit|change|alter|modify)\\s+)?(?:in\\s+)?(?:the\\s+)?bar\\s+${cardinal}\\b`,
      "g",
    ),
    new RegExp(`\\b(?:the\\s+)?${ordinal}\\s+bar\\s+only\\b`, "g"),
    new RegExp(`\\bbar\\s+${cardinal}\\s+only\\b`, "g"),
  ];
  const bars = new Set<number>();
  if (limits.targetBar !== null) bars.add(limits.targetBar);
  for (const pattern of barPatterns)
    for (const match of text.matchAll(pattern)) bars.add(barNumbers[match[1]]);
  if (bars.size > 1)
    throw new Error(
      "The direction and explicit controls select different bars. Choose one target bar.",
    );
  const targetBar = [...bars][0] ?? null;
  let maxNoteRatio = limits.maxNoteRatio;
  for (const clause of text.split(
    /[.;!?,]|\bbut\b|\band(?=\s+(?:make|give|move|add|remove|use|reduce|halve)\b)/,
  )) {
    if (
      !/\b(?:(?:fewer|less)\s+(?:(?:drum|bass|lead|melody)\s+)?(?:notes?|hits?|busy)|half\s+as\s+(?:busy|many)|halve|less busy|sparser|reduce\s+(?:the\s+)?(?:note\s+)?(?:count|density))\b/.test(
        clause,
      )
    )
      continue;
    const tracks = mentionedTracks(clause);
    for (const track of tracks.length
      ? tracks
      : TRACK_IDS.filter((id) => !protectedTracks.has(id)))
      fewerNotes.add(track);
    if (/\b(?:half\s+as\s+(?:busy|many)|halve)\b/.test(clause))
      maxNoteRatio = Math.min(maxNoteRatio ?? 1, 0.5);
  }
  return constraintsSchema.parse({
    protectedTracks: TRACK_IDS.filter((id) => protectedTracks.has(id)),
    lockTempo,
    targetBar,
    fewerNotes: TRACK_IDS.filter((id) => fewerNotes.has(id)),
    ...(maxNoteRatio === undefined ? {} : { maxNoteRatio }),
  });
}
