import { describe, expect, it } from "vitest";
import {
  createSession,
  editSession,
  undoSession,
  responseIsCurrent,
  soundingSession,
  stopSession,
} from "../src/state/session";
import type { Score } from "../shared/types";
const score = {
  schemaVersion: 1,
  synthesisVersion: 1,
  id: "song",
  revisionId: "r1",
  title: "Test",
  bpm: 100,
  bars: 1,
  key: 0,
  scale: "minor",
  seed: 1,
  tracks: [],
} as Score;
describe("revision transitions", () => {
  it("normalizes saved history whose final entry predates the saved current score", () => {
    const previous = createSession(score);
    const current = { ...score, revisionId: "saved-r2", bpm: 115 };
    const restored = createSession(current, previous.history);
    expect(restored.history.at(-1)?.score).toEqual(current);
    expect(undoSession(restored).draft.bpm).toBe(100);
  });
  it("rejects delayed responses even when undo restored identical content", () => {
    const first = createSession(score);
    const next = editSession(first, { ...score, bpm: 120 }, "Tempo");
    const undone = undoSession(next);
    expect(undone.draft.bpm).toBe(100);
    expect(responseIsCurrent(undone, score.revisionId, first.generation)).toBe(
      false,
    );
  });
  it("cancels all unheard changes before reverting audible history", () => {
    const first = { ...createSession(score), playing: true };
    const second = editSession(first, { ...score, bpm: 110 }, "Tempo");
    const third = editSession(
      second,
      { ...second.draft, bpm: 130 },
      "Tempo again",
    );
    const undone = undoSession(third);
    expect(undone.pending).toBeNull();
    expect(undone.draft.bpm).toBe(100);
    expect(undone.history).toHaveLength(1);
  });
  it("preserves a later draft when an earlier queued score becomes audible", () => {
    const first = { ...createSession(score), playing: true };
    const second = editSession(first, { ...score, bpm: 110 }, "Tempo");
    const third = editSession(
      second,
      { ...second.draft, bpm: 130 },
      "Tempo again",
    );
    const sounding = soundingSession(third, second.draft);
    expect(sounding.sounding.bpm).toBe(110);
    expect(sounding.pending?.bpm).toBe(130);
    expect(stopSession(sounding).sounding.bpm).toBe(130);
  });
});
