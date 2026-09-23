import { afterEach, describe, expect, it, vi } from "vitest";
import type { Score, TrackId } from "../shared/types";
import { AudioTimeline } from "../src/audio/timeline";
import { AudioEngine, trackLevel } from "../src/audio/AudioEngine";
import { encodeWav } from "../src/audio/exportWav";

function score(revisionId = "original", bpm = 120): Score {
  return {
    schemaVersion: 1,
    synthesisVersion: 1,
    id: "test",
    revisionId,
    title: "Test",
    bpm,
    bars: 1,
    key: 0,
    scale: "minor",
    seed: 42,
    tracks: (["drums", "bass", "lead"] as TrackId[]).map((id) => ({
      id,
      name: id,
      preset: { drums: "warm-kit", bass: "round-bass", lead: "glass-lead" }[id],
      volume: 0.7,
      mute: false,
      solo: false,
      params: { brightness: 0.5, decay: 0.5 },
      notes: [
        {
          id: `${id}-0`,
          start: 0,
          duration: 1,
          pitch: { drums: 36, bass: 36, lead: 60 }[id],
          velocity: 0.7,
          drum: id === "drums" ? "kick" : null,
        },
        {
          id: `${id}-8`,
          start: 8,
          duration: 1,
          pitch: { drums: 36, bass: 36, lead: 60 }[id],
          velocity: 0.7,
          drum: id === "drums" ? "kick" : null,
        },
      ],
    })),
  };
}

function simulation(initial = score()) {
  let now = 0;
  const events: {
    noteId: string;
    when: number;
    loopId: number;
    revision: string;
    cancelled: boolean;
  }[] = [];
  const heardLoops: { revision: string; start: number }[] = [];
  const underrun = vi.fn();
  const timeline = new AudioTimeline({
    schedule: (event, when, _duration, loop) =>
      events.push({
        noteId: event.noteId,
        when,
        loopId: loop.id,
        revision: loop.score.revisionId,
        cancelled: false,
      }),
    cancel: (loop, atTime) => {
      for (const event of events)
        if (event.loopId === loop.id && event.when > atTime)
          event.cancelled = true;
    },
    loop: (loop) =>
      heardLoops.push({
        revision: loop.score.revisionId,
        start: loop.startTime,
      }),
    underrun,
  });
  timeline.start(initial, now);
  return {
    timeline,
    events,
    heardLoops,
    underrun,
    get now() {
      return now;
    },
    advance(to: number) {
      while (now + 0.025 < to) {
        now += 0.025;
        timeline.tick(now);
      }
      now = to;
      timeline.tick(now);
    },
  };
}

describe("audio-clock revision scheduling", () => {
  it("schedules repeated polls exactly once per note occurrence", () => {
    const sim = simulation();
    sim.advance(6.1);
    for (let repeat = 0; repeat < 4; repeat++) sim.timeline.tick(sim.now);
    const keys = sim.events.map((event) => `${event.loopId}/${event.noteId}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(
      sim.events
        .filter((event) => event.noteId === "lead-0")
        .map((event) => event.when),
    ).toEqual([0.05, 2.05, 4.05, 6.05]);
    expect(sim.underrun).not.toHaveBeenCalled();
  });

  it("replaces an unfrozen candidate and switches tempo only at its boundary", () => {
    const sim = simulation();
    sim.advance(0.4);
    expect(sim.timeline.queue(score("discarded", 90), sim.now).atTime).toBe(
      2.05,
    );
    sim.advance(1.5);
    expect(sim.timeline.queue(score("slow", 60), sim.now).atTime).toBe(2.05);
    sim.advance(6.1);
    expect(sim.events.some((event) => event.revision === "discarded")).toBe(
      false,
    );
    expect(sim.heardLoops).toEqual([
      { revision: "original", start: 0.05 },
      { revision: "slow", start: 2.05 },
      { revision: "slow", start: 6.05 },
    ]);
    expect(
      sim.events.find(
        (event) => event.revision === "slow" && event.noteId === "lead-8",
      )!.when,
    ).toBe(4.05);
  });

  it("defers an edit after the next loop is locked, even before that loop sounds", () => {
    const sim = simulation();
    sim.timeline.queue(score("first", 60), sim.now);
    sim.advance(1.99);
    const next = sim.timeline.queue(score("second"), sim.now);
    expect(next.atTime).toBe(6.05);
    sim.advance(6.1);
    expect(sim.heardLoops.map((loop) => loop.revision)).toEqual([
      "original",
      "first",
      "second",
    ]);
  });

  it("locks an empty incoming loop by boundary, not by its first note", () => {
    const sim = simulation();
    const silent = score("silent");
    silent.tracks.forEach((track) => {
      track.notes = [];
    });
    sim.timeline.queue(silent, sim.now);
    sim.advance(1.99);
    expect(sim.timeline.queue(score("later"), sim.now).atTime).toBe(4.05);
  });

  it("Undo retracts a scheduled but unheard revision and restores the sounding music", () => {
    const sim = simulation();
    sim.timeline.queue(score("unheard", 60), sim.now);
    sim.advance(1.99);
    expect(sim.events.some((event) => event.revision === "unheard")).toBe(true);
    sim.timeline.cancelPending(sim.now, score("undo-identity"));
    sim.advance(4.1);
    expect(
      sim.events
        .filter((event) => event.revision === "unheard")
        .every((event) => event.cancelled),
    ).toBe(true);
    expect(sim.heardLoops.map((loop) => loop.revision)).toEqual([
      "original",
      "undo-identity",
      "undo-identity",
    ]);
    expect(
      sim.events.filter(
        (event) =>
          !event.cancelled && event.noteId === "lead-0" && event.when === 2.05,
      ),
    ).toHaveLength(1);
  });

  it("Undo just after a boundary preserves the now-sounding revision", () => {
    const sim = simulation();
    sim.timeline.queue(score("audible"), sim.now);
    sim.advance(2.06);
    sim.timeline.queue(score("unheard"), sim.now);
    sim.timeline.cancelPending(sim.now);
    sim.advance(4.1);
    expect(sim.heardLoops.map((loop) => loop.revision)).toEqual([
      "original",
      "audible",
      "audible",
    ]);
  });

  it("returns the canonical sounding score when Undo races the loop announcement", () => {
    const sim = simulation();
    sim.timeline.queue(score("already-audible"), sim.now);
    sim.advance(2.04);
    const canonical = sim.timeline.cancelPending(2.051);
    expect(canonical!.revisionId).toBe("already-audible");
    expect(sim.heardLoops.at(-1)!.revision).toBe("already-audible");
    expect(
      sim.timeline.cancelPending(2.052, score("fresh-undo-id"))!.revisionId,
    ).toBe("fresh-undo-id");
  });

  it("returns the original score when cancellation happens before the initial onset", () => {
    const sim = simulation();
    sim.timeline.queue(score("not-yet"), 0.01);
    expect(sim.timeline.cancelPending(0.02)!.revisionId).toBe("original");
    sim.advance(2.1);
    expect(sim.heardLoops.map((loop) => loop.revision)).toEqual([
      "original",
      "original",
    ]);
  });

  it("takes immutable candidate snapshots while the editor keeps changing its objects", () => {
    const sim = simulation();
    const candidate = score("queued");
    sim.timeline.queue(candidate, sim.now);
    candidate.bpm = 60;
    candidate.tracks[0]!.notes = [];
    sim.advance(4.1);
    expect(sim.heardLoops.at(-1)!.start).toBe(4.05);
    expect(
      sim.events.some(
        (event) => event.revision === "queued" && event.noteId === "drums-0",
      ),
    ).toBe(true);
  });

  it("stop cancels future notes and restart starts from zero without old occurrences", () => {
    const sim = simulation();
    sim.advance(0.99);
    sim.timeline.stop(sim.now);
    expect(sim.timeline.position(sim.now)).toBe(0);
    expect(
      sim.events
        .filter((event) => event.when > sim.now)
        .every((event) => event.cancelled),
    ).toBe(true);
    sim.timeline.start(score("restarted"), 1);
    sim.advance(1.1);
    expect(
      sim.events
        .filter(
          (event) =>
            !event.cancelled && event.when >= 1 && event.noteId === "lead-0",
        )
        .map((event) => event.revision),
    ).toEqual(["restarted"]);
  });

  it("stops safely after timer starvation instead of bursting missed notes", () => {
    const sim = simulation();
    sim.advance(0.2);
    sim.timeline.tick(1.5);
    expect(sim.timeline.playing).toBe(false);
    expect(sim.underrun).toHaveBeenCalledOnce();
    expect(sim.events.some((event) => event.when > 0.3)).toBe(false);
  });
});

class FakeParam {
  value = 0;
  setValueAtTime(value: number) {
    this.value = value;
  }
  linearRampToValueAtTime(value: number) {
    this.value = value;
  }
  exponentialRampToValueAtTime(value: number) {
    this.value = value;
  }
  cancelAndHoldAtTime() {}
  cancelScheduledValues() {}
}
class FakeNode {
  gain = new FakeParam();
  frequency = new FakeParam();
  Q = new FakeParam();
  threshold = new FakeParam();
  knee = new FakeParam();
  ratio = new FakeParam();
  attack = new FakeParam();
  release = new FakeParam();
  type = "";
  loop = false;
  buffer: unknown = null;
  onended: (() => void) | null = null;
  starts: number[] = [];
  stops: number[] = [];
  disconnected = false;
  connect() {
    return this;
  }
  disconnect() {
    this.disconnected = true;
  }
  start(time: number) {
    this.starts.push(time);
  }
  stop(time: number) {
    this.stops.push(time);
  }
}
class FakeContext {
  currentTime = 0;
  sampleRate = 44100;
  state = "running";
  destination = new FakeNode();
  sources: FakeNode[] = [];
  listeners = new Set<() => void>();
  resume = vi.fn(async () => {
    this.state = "running";
  });
  close = vi.fn(async () => {
    this.state = "closed";
  });
  createGain() {
    return new FakeNode();
  }
  createDynamicsCompressor() {
    return new FakeNode();
  }
  createBiquadFilter() {
    return new FakeNode();
  }
  createOscillator() {
    const source = new FakeNode();
    this.sources.push(source);
    return source;
  }
  createBufferSource() {
    return this.createOscillator();
  }
  createBuffer(_channels: number, size: number) {
    const channel = new Float32Array(size);
    return { getChannelData: () => channel };
  }
  addEventListener(_name: string, listener: () => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_name: string, listener: () => void) {
    this.listeners.delete(listener);
  }
}

function engineHarness() {
  vi.useFakeTimers();
  const frames = new Map<number, FrameRequestCallback>();
  let serial = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++serial, callback);
    return serial;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const context = new FakeContext();
  const onNote = vi.fn();
  const onStop = vi.fn();
  const createContext = vi.fn(() => context as unknown as AudioContext);
  const engine = new AudioEngine({ onNote, onStop }, { createContext });
  return {
    engine,
    context,
    onNote,
    onStop,
    createContext,
    draw(now: number) {
      context.currentTime = now;
      const entries = Array.from(frames.entries());
      frames.clear();
      for (const [, callback] of entries) callback(0);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("source ownership and display clock", () => {
  it("creates audio only on Play and draws note activity only at audio onset", async () => {
    const h = engineHarness();
    expect(h.createContext).not.toHaveBeenCalled();
    await h.engine.start(score());
    h.draw(0.049);
    expect(h.onNote).not.toHaveBeenCalled();
    h.draw(0.05);
    expect(h.onNote).toHaveBeenCalledTimes(3);
    h.draw(0.06);
    expect(h.onNote).toHaveBeenCalledTimes(3);
    h.engine.dispose();
    expect(h.context.close).toHaveBeenCalledOnce();
    expect(h.context.sources.every((source) => source.disconnected)).toBe(true);
  });

  it("never lights muted tracks and applies solo independently of scheduled envelopes", async () => {
    const h = engineHarness();
    await h.engine.start(score());
    const mixed = score();
    mixed.tracks[1]!.solo = true;
    h.engine.setMixer(mixed);
    h.draw(0.05);
    expect(h.onNote.mock.calls.map((call) => call[0].trackId)).toEqual([
      "bass",
    ]);
    mixed.tracks[1]!.mute = true;
    expect(trackLevel(mixed, "bass")).toBe(0);
    h.engine.dispose();
  });

  it("stops every future native source before its start and rapid replay creates fresh sources", async () => {
    const h = engineHarness();
    await h.engine.start(score());
    const old = [...h.context.sources];
    h.context.currentTime = 0.01;
    h.engine.stop();
    expect(
      old.every((source) => source.stops.at(-1)! < source.starts[0]!),
    ).toBe(true);
    await h.engine.start(score("new"));
    expect(h.context.sources.length).toBeGreaterThan(old.length);
    expect(
      old.every((source) => source.stops.at(-1)! < source.starts[0]!),
    ).toBe(true);
    h.engine.dispose();
  });

  it("a Stop while browser audio permission is pending cannot start playback later", async () => {
    const h = engineHarness();
    let finish!: () => void;
    h.context.resume.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const starting = h.engine.start(score());
    h.engine.stop();
    finish();
    await starting;
    expect(h.engine.playing).toBe(false);
    expect(h.context.sources).toHaveLength(0);
    h.engine.dispose();
  });

  it("starts the latest draft after a delayed browser resume rather than the click-time score", async () => {
    const h = engineHarness();
    let finish!: () => void;
    h.context.resume.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    let draft = score();
    const starting = h.engine.start(draft, () => draft);
    draft = score("edited-during-resume");
    draft.tracks[0]!.notes = [];
    finish();
    await starting;
    h.draw(0.05);
    expect(h.onNote.mock.calls.map((call) => call[0].trackId)).toEqual([
      "bass",
      "lead",
    ]);
    h.engine.dispose();
  });

  it("an interrupted context stops and an explicit Play can restart from step zero", async () => {
    const h = engineHarness();
    await h.engine.start(score());
    h.context.state = "suspended";
    h.context.listeners.forEach((listener) => listener());
    expect(h.engine.playing).toBe(false);
    expect(h.onStop.mock.calls.at(-1)![0]).toContain("interrupted");
    h.context.currentTime = 3;
    await h.engine.start(score());
    expect(h.context.sources.at(-1)!.starts[0]).toBe(3.05);
    h.engine.dispose();
  });

  it("hiding the tab stops playback and also invalidates a pending audio resume", async () => {
    const listeners = new Set<() => void>();
    const document = {
      hidden: false,
      addEventListener: (_name: string, callback: () => void) =>
        listeners.add(callback),
      removeEventListener: (_name: string, callback: () => void) =>
        listeners.delete(callback),
    };
    vi.stubGlobal("document", document);
    const h = engineHarness();
    await h.engine.start(score());
    document.hidden = true;
    listeners.forEach((listener) => listener());
    expect(h.engine.playing).toBe(false);
    expect(h.onStop.mock.calls.at(-1)![0]).toContain("tab was hidden");
    document.hidden = false;
    let finish!: () => void;
    h.context.resume.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const restarting = h.engine.start(score());
    document.hidden = true;
    listeners.forEach((listener) => listener());
    finish();
    await restarting;
    expect(h.engine.playing).toBe(false);
    expect(h.onStop).toHaveBeenCalledTimes(2);
    expect(h.onStop.mock.calls.at(-1)![0]).toContain("tab was hidden");
    h.engine.dispose();
    expect(listeners.size).toBe(0);
  });
});

it("exports standard stereo PCM16 with correct interleaving, clipping, and header sizes", async () => {
  const channels = [
    new Float32Array([-2, 0.5, Number.NaN]),
    new Float32Array([2, -0.5, 0]),
  ];
  const wav = encodeWav({
    numberOfChannels: 2,
    length: 3,
    sampleRate: 44100,
    getChannelData: (index) => channels[index]!,
  });
  const bytes = await wav.arrayBuffer();
  const view = new DataView(bytes);
  expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
  expect(view.getUint16(22, true)).toBe(2);
  expect(view.getUint32(40, true)).toBe(12);
  expect(view.getUint32(4, true)).toBe(bytes.byteLength - 8);
  expect(
    Array.from({ length: 6 }, (_, index) =>
      view.getInt16(44 + index * 2, true),
    ),
  ).toEqual([-32768, 32767, 16384, -16384, 0, 0]);
});
