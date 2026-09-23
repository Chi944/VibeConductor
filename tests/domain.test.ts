import { describe, expect, it } from "vitest";
import { EXAMPLES } from "../shared/examples";
import {
  applyProposal,
  constraintsSchema,
  parseConstraints,
  proposalSchema,
} from "../shared/edits";
import {
  cloneScore,
  compileScore,
  loopSeconds,
  newId,
  parseScore,
  pitchName,
  resizeScore,
  scalePitches,
  scoreSchema,
  validateScore,
} from "../shared/score";
import type {
  EditConstraints,
  EditOperation,
  EditProposal,
  Score,
} from "../shared/types";

const blankConstraints = (): EditConstraints => ({
  protectedTracks: [],
  lockTempo: false,
  targetBar: null,
  fewerNotes: [],
});
const score = (): Score => cloneScore(EXAMPLES[0].score, false);
const proposal = (base: Score, operations: EditOperation[]): EditProposal => ({
  baseRevisionId: base.revisionId,
  explanation: "Shortened the phrase and left room to breathe.",
  operations,
});

describe("versioned score schema", () => {
  it("validates three distinct original examples with stable identities", () => {
    expect(EXAMPLES).toHaveLength(3);
    expect(new Set(EXAMPLES.map((example) => example.score.id)).size).toBe(3);
    for (const example of EXAMPLES) {
      expect(parseScore(example.score)).toEqual(example.score);
      expect(
        example.score.tracks.every((track) => track.notes.length > 0),
      ).toBe(true);
    }
  });

  it.each([
    [
      "wrong version",
      (base: Score) => {
        base.schemaVersion = 2 as 1;
      },
    ],
    [
      "out-of-range tempo",
      (base: Score) => {
        base.bpm = 161;
      },
    ],
    [
      "unsupported loop length",
      (base: Score) => {
        base.bars = 3 as 2;
      },
    ],
    [
      "duplicate tracks",
      (base: Score) => {
        base.tracks[2] = structuredClone(base.tracks[1]);
      },
    ],
    [
      "duplicate note IDs",
      (base: Score) => {
        base.tracks[1].notes[0].id = base.tracks[2].notes[0].id;
      },
    ],
    [
      "invalid bass register",
      (base: Score) => {
        base.tracks[1].notes[0].pitch = 61;
      },
    ],
    [
      "wrong drum pitch",
      (base: Score) => {
        base.tracks[0].notes[0].pitch = 37;
      },
    ],
    [
      "missing drum voice",
      (base: Score) => {
        base.tracks[0].notes[0].drum = null;
      },
    ],
    [
      "fractional step",
      (base: Score) => {
        base.tracks[1].notes[0].start = 0.5;
      },
    ],
    [
      "zero velocity",
      (base: Score) => {
        base.tracks[1].notes[0].velocity = 0;
      },
    ],
    [
      "unknown instrument",
      (base: Score) => {
        base.tracks[1].preset = "unknown-synth";
      },
    ],
    [
      "negative noise seed",
      (base: Score) => {
        base.seed = -1;
      },
    ],
    [
      "loop-end overflow",
      (base: Score) => {
        base.tracks[2].notes.at(-1)!.duration = 12;
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const base = score();
    mutate(base);
    expect(scoreSchema.safeParse(base).success).toBe(false);
  });

  it("rejects unrecognized fields rather than silently discarding musical data", () => {
    expect(scoreSchema.safeParse({ ...score(), swing: 0.2 }).success).toBe(
      false,
    );
  });

  it("rejects overlapping melodic notes but permits touching notes and internal bar crossings", () => {
    const base = score();
    const first = base.tracks[1].notes[0];
    base.tracks[1].notes = [
      { ...first, start: 14, duration: 4 },
      { ...first, id: "second-bass", start: 18, duration: 2 },
    ];
    expect(scoreSchema.safeParse(base).success).toBe(true);
    base.tracks[1].notes[1].start = 17;
    expect(() => parseScore(base)).toThrow(/monophonic/);
  });

  it("allows different drum voices together while rejecting overlapping hits of one voice", () => {
    const base = score();
    const first = base.tracks[0].notes[0];
    base.tracks[0].notes.push({ ...first, id: "duplicate-kick" });
    expect(() => parseScore(base)).toThrow(/drum voice/);
  });

  it("reports useful error locations", () => {
    const result = validateScore({ ...score(), bpm: 10 });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errors.join(" ")).toContain("bpm");
  });
});

describe("pure score utilities", () => {
  it("compiles deterministic events independent of input order and mixer gates", () => {
    const base = score();
    const expected = compileScore(base);
    const shuffled = cloneScore(base, false);
    shuffled.tracks.reverse();
    for (const track of shuffled.tracks) {
      track.notes.reverse();
      track.mute = true;
      track.solo = true;
    }
    expect(compileScore(shuffled)).toEqual(expected);
    expect(expected[0]).toMatchObject({
      startStep: 0,
      trackId: "drums",
      drum: "kick",
      pitch: 36,
    });
  });

  it("preserves musical sequence, IDs, seed and instrument parameters across JSON round trips", () => {
    for (const example of EXAMPLES) {
      const roundTrip = parseScore(JSON.parse(JSON.stringify(example.score)));
      expect(roundTrip).toEqual(example.score);
      expect(compileScore(roundTrip)).toEqual(compileScore(example.score));
    }
  });

  it("gives clones fresh revisions without changing composition/note IDs or sharing mutable notes", () => {
    const base = score();
    const copied = cloneScore(base);
    expect(copied.revisionId).not.toBe(base.revisionId);
    expect(copied.id).toBe(base.id);
    expect(copied.tracks[0].notes[0].id).toBe(base.tracks[0].notes[0].id);
    copied.tracks[0].notes[0].velocity = 0.05;
    expect(base.tracks[0].notes[0].velocity).not.toBe(0.05);
    expect(newId()).not.toBe(newId());
  });

  it("trims boundary notes and removes later notes when shortening; expansion adds silence", () => {
    const base = score();
    base.tracks[1].notes = [
      { ...base.tracks[1].notes[0], start: 14, duration: 5 },
      { ...base.tracks[1].notes[1], start: 22, duration: 4 },
    ];
    const shorter = resizeScore(base, 1);
    expect(shorter.tracks[1].notes).toEqual([
      { ...base.tracks[1].notes[0], duration: 2 },
    ]);
    expect(shorter.revisionId).not.toBe(base.revisionId);
    const longer = resizeScore(shorter, 4);
    expect(compileScore(longer)).toEqual(compileScore(shorter));
    expect(base.bars).toBe(2);
  });

  it("calculates real loop time and guided pitch names", () => {
    expect(loopSeconds({ bpm: 120, bars: 2 })).toBe(4);
    expect(pitchName(60)).toBe("C4");
    expect(pitchName(61)).toBe("C♯4");
    expect(scalePitches(0, "major", 60, 72)).toEqual([
      60, 62, 64, 65, 67, 69, 71, 72,
    ]);
    expect(scalePitches(9, "minor", 57, 64)).toEqual([57, 59, 60, 62, 64]);
  });
});

describe("atomic structured edits", () => {
  it("preserves IDs for changed notes and advances only the revision", () => {
    const base = score();
    const note = base.tracks[2].notes[0];
    const result = applyProposal(
      base,
      proposal(base, [
        {
          type: "upsertNote",
          trackId: "lead",
          note: { ...note, velocity: 0.4 },
        },
      ]),
      blankConstraints(),
    );
    expect(result.revisionId).not.toBe(base.revisionId);
    expect(result.id).toBe(base.id);
    expect(result.tracks[2].notes[0]).toEqual({ ...note, velocity: 0.4 });
    expect(base.tracks[2].notes[0].velocity).toBe(note.velocity);
  });

  it("rejects stale revisions before accepting an otherwise valid edit", () => {
    const base = score();
    const edit = proposal(base, [{ type: "setTempo", bpm: 100 }]);
    expect(() =>
      applyProposal(cloneScore(base), edit, blankConstraints()),
    ).toThrow(/older revision/);
  });

  it("leaves the input unchanged when an invalid operation follows a valid one", () => {
    const base = score();
    const original = JSON.stringify(base);
    const edit = proposal(base, [
      { type: "setTempo", bpm: 100 },
      { type: "removeNote", trackId: "bass", noteId: "missing" },
    ]);
    expect(() => applyProposal(base, edit, blankConstraints())).toThrow(
      /unknown note/,
    );
    expect(JSON.stringify(base)).toBe(original);
  });

  it("enforces all score invariants on model additions", () => {
    const base = score();
    const note = { ...base.tracks[1].notes[0], id: "new-bass" };
    expect(() =>
      applyProposal(
        base,
        proposal(base, [{ type: "upsertNote", trackId: "bass", note }]),
        blankConstraints(),
      ),
    ).toThrow(/monophonic/);
  });

  it("rejects cross-track ID reuse and duplicate changes to one note", () => {
    const base = score();
    const note = base.tracks[2].notes[0];
    expect(() =>
      applyProposal(
        base,
        proposal(base, [{ type: "upsertNote", trackId: "bass", note }]),
        blankConstraints(),
      ),
    ).toThrow(/reused/);
    const operation = {
      type: "upsertNote" as const,
      trackId: "lead" as const,
      note,
    };
    expect(() =>
      applyProposal(
        base,
        proposal(base, [operation, operation]),
        blankConstraints(),
      ),
    ).toThrow(/more than once/);
  });

  it("rejects edits to protected musical content and tempo", () => {
    const base = score();
    const limits = {
      ...blankConstraints(),
      protectedTracks: ["bass" as const],
      lockTempo: true,
    };
    expect(() =>
      applyProposal(
        base,
        proposal(base, [
          {
            type: "removeNote",
            trackId: "bass",
            noteId: base.tracks[1].notes[0].id,
          },
        ]),
        limits,
      ),
    ).toThrow(/protected/);
    expect(() =>
      applyProposal(
        base,
        proposal(base, [{ type: "setTempo", bpm: 110 }]),
        limits,
      ),
    ).toThrow(/tempo/);
    const result = applyProposal(
      base,
      proposal(base, [
        {
          type: "removeNote",
          trackId: "lead",
          noteId: base.tracks[2].notes[0].id,
        },
      ]),
      limits,
    );
    expect(result.tracks[1]).toEqual(base.tracks[1]);
    expect(result.bpm).toBe(base.bpm);
  });

  it("restricts bar edits to complete note spans and rejects global instrument changes", () => {
    const base = score();
    const limits = { ...blankConstraints(), targetBar: 2 };
    const inside = base.tracks[2].notes.find((note) => note.start >= 16)!;
    expect(
      applyProposal(
        base,
        proposal(base, [
          {
            type: "upsertNote",
            trackId: "lead",
            note: { ...inside, velocity: 0.5 },
          },
        ]),
        limits,
      ).tracks[2].notes.find((note) => note.id === inside.id)?.velocity,
    ).toBe(0.5);
    expect(() =>
      applyProposal(
        base,
        proposal(base, [
          {
            type: "removeNote",
            trackId: "lead",
            noteId: base.tracks[2].notes[0].id,
          },
        ]),
        limits,
      ),
    ).toThrow(/Only notes/);
    expect(() =>
      applyProposal(
        base,
        proposal(base, [
          {
            type: "upsertNote",
            trackId: "lead",
            note: { ...inside, start: 15 },
          },
        ]),
        limits,
      ),
    ).toThrow(/wholly inside/);
    expect(() =>
      applyProposal(
        base,
        proposal(base, [
          {
            type: "setTrack",
            trackId: "lead",
            preset: null,
            volume: 0.5,
            brightness: null,
            decay: null,
          },
        ]),
        limits,
      ),
    ).toThrow(/track-wide/);
    expect(() =>
      applyProposal(
        base,
        proposal(base, [{ type: "setTempo", bpm: 90 }]),
        limits,
      ),
    ).toThrow(/tempo/);
  });

  it("rejects nonexistent target bars", () => {
    const base = score();
    expect(() =>
      applyProposal(base, proposal(base, [{ type: "setTempo", bpm: 90 }]), {
        ...blankConstraints(),
        targetBar: 4,
      }),
    ).toThrow(/does not exist/);
  });

  it("enforces fewer notes and a half-density upper limit independent of model explanation", () => {
    const base = score();
    const notes = base.tracks[2].notes;
    const limits = {
      ...blankConstraints(),
      fewerNotes: ["lead" as const],
      maxNoteRatio: 0.5,
    };
    expect(() =>
      applyProposal(
        base,
        proposal(base, [
          { type: "removeNote", trackId: "lead", noteId: notes[0].id },
        ]),
        limits,
      ),
    ).toThrow(/at most 3/);
    const removeHalf = notes
      .slice(0, 3)
      .map((note) => ({
        type: "removeNote" as const,
        trackId: "lead" as const,
        noteId: note.id,
      }));
    expect(
      applyProposal(base, proposal(base, removeHalf), limits).tracks[2].notes,
    ).toHaveLength(3);
    expect(() =>
      applyProposal(
        base,
        proposal(base, [
          {
            type: "upsertNote",
            trackId: "lead",
            note: { ...notes[0], velocity: 0.5 },
          },
        ]),
        { ...blankConstraints(), fewerNotes: ["lead"] },
      ),
    ).toThrow(/fewer/);
  });

  it("validates bounded strict proposal and constraint shapes", () => {
    expect(
      proposalSchema.safeParse({
        baseRevisionId: "v1",
        explanation: "Good",
        operations: [],
      }).success,
    ).toBe(false);
    expect(
      proposalSchema.safeParse({
        baseRevisionId: "v1",
        explanation: "Good",
        operations: [{ type: "runCode", code: "anything" }],
      }).success,
    ).toBe(false);
    expect(
      constraintsSchema.safeParse({ ...blankConstraints(), maxNoteRatio: 0 })
        .success,
    ).toBe(false);
    expect(
      constraintsSchema.safeParse({
        ...blankConstraints(),
        protectedTracks: ["bass", "bass"],
      }).success,
    ).toBe(false);
  });
});

describe("independent direction constraints", () => {
  it.each([
    "Keep the bass exactly as it is, but make the melody more restless.",
    "Do not change the bass; make the lead warmer.",
    "Don't touch bass, change lead rhythm.",
    "The bass must stay unchanged.",
    "Make the melody restless while keeping the bass unchanged.",
  ])("protects bass without protecting the requested lead: %s", (direction) => {
    expect(
      parseConstraints(direction, blankConstraints()).protectedTracks,
    ).toEqual(["bass"]);
  });

  it("parses combined track protection", () => {
    expect(
      parseConstraints("Keep the bass and lead unchanged.", blankConstraints())
        .protectedTracks,
    ).toEqual(["bass", "lead"]);
  });

  it.each([
    "Keep the bass, but give the melody a little more room",
    "Keep the bass but make the melody more restless.",
    "Make the melody more restless; keep bass.",
    "Keep the bass",
  ])("protects a standalone keep clause: %s", (direction) => {
    const constraints = parseConstraints(direction, blankConstraints());
    expect(constraints.protectedTracks).toEqual(["bass"]);
    const base = score();
    expect(() =>
      applyProposal(
        base,
        proposal(base, [
          {
            type: "removeNote",
            trackId: "bass",
            noteId: base.tracks[1].notes[0].id,
          },
        ]),
        constraints,
      ),
    ).toThrow(/protected/);
    expect(() =>
      applyProposal(
        base,
        proposal(base, [
          {
            type: "removeNote",
            trackId: "lead",
            noteId: base.tracks[2].notes[0].id,
          },
        ]),
        constraints,
      ),
    ).not.toThrow();
  });

  it.each([
    "Keep bass and drums, but make the lead quieter.",
    "Keep the bass, the drums; make the lead quieter.",
    "Keep the bass track and the drum track",
  ])("recognizes track lists in standalone preservation: %s", (direction) => {
    expect(
      parseConstraints(direction, blankConstraints()).protectedTracks,
    ).toEqual(["drums", "bass"]);
  });

  it.each([
    "Keep the bass moving.",
    "Keep the bass and lead restless, but shorten the notes.",
    "Keep the bass warm, but make the melody quieter.",
  ])("does not interpret a musical quality as a lock: %s", (direction) => {
    expect(
      parseConstraints(direction, blankConstraints()).protectedTracks,
    ).toEqual([]);
  });

  it("does not leak preservation across a separate musical-quality clause", () => {
    expect(
      parseConstraints(
        "Keep the bass moving, but leave the drums unchanged.",
        blankConstraints(),
      ).protectedTracks,
    ).toEqual(["drums"]);
  });

  it.each([
    "Build tension while keeping the tempo unchanged.",
    "Do not change the tempo.",
    "Without changing BPM, make this brighter.",
    "The tempo should remain the same.",
  ])("locks tempo: %s", (direction) => {
    expect(parseConstraints(direction, blankConstraints()).lockTempo).toBe(
      true,
    );
  });

  it.each([
    "Edit only the second bar.",
    "Only edit bar two.",
    "Change bar 2 only.",
    "Second bar only, please.",
    "Change the melody only in the second bar.",
  ])("extracts a second-bar constraint: %s", (direction) => {
    expect(parseConstraints(direction, blankConstraints()).targetBar).toBe(2);
  });

  it("retains explicit protection and rejects conflicting bar selections", () => {
    const explicit: EditConstraints = {
      protectedTracks: ["lead"],
      lockTempo: true,
      targetBar: 2,
      fewerNotes: [],
    };
    expect(parseConstraints("Make bass warmer.", explicit)).toEqual(explicit);
    expect(() => parseConstraints("Only the first bar.", explicit)).toThrow(
      /different bars/,
    );
  });

  it("turns half as busy into independently enforceable note counts", () => {
    const parsed = parseConstraints(
      "Make the drums half as busy.",
      blankConstraints(),
    );
    expect(parsed.fewerNotes).toEqual(["drums"]);
    expect(parsed.maxNoteRatio).toBe(0.5);
    expect(
      parseConstraints("Use fewer lead notes.", blankConstraints()).fewerNotes,
    ).toEqual(["lead"]);
    expect(
      parseConstraints(
        "Keep the bass unchanged, use fewer notes.",
        blankConstraints(),
      ).fewerNotes,
    ).toEqual(["drums", "lead"]);
    expect(
      parseConstraints(
        "Keep the bass unchanged and make the melody less busy.",
        blankConstraints(),
      ).fewerNotes,
    ).toEqual(["lead"]);
  });
});
