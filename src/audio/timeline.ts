import {
  compileScore,
  loopSeconds,
  type CompiledEvent,
} from "../../shared/score";
import type { Score } from "../../shared/types";

export interface LoopPlan {
  id: number;
  score: Score;
  startTime: number;
  endTime: number;
  events: CompiledEvent[];
  cursor: number;
  announced: boolean;
}

export interface TimelineCallbacks {
  schedule(
    event: CompiledEvent,
    atTime: number,
    duration: number,
    loop: LoopPlan,
  ): void;
  cancel(loop: LoopPlan, atTime: number): void;
  loop(loop: LoopPlan): void;
  underrun(): void;
}

/** The audio clock is the only clock here. UI frames never advance this timeline. */
export class AudioTimeline {
  private loops: LoopPlan[] = [];
  private candidate: { score: Score; atTime: number } | null = null;
  private serial = 0;
  private running = false;
  private scheduledThrough = 0;

  constructor(
    private readonly callbacks: TimelineCallbacks,
    readonly horizon = 0.1,
  ) {}

  get playing() {
    return this.running;
  }
  get pendingTime() {
    if (this.candidate) return this.candidate.atTime;
    const sounding =
      this.loops.filter((loop) => loop.announced).at(-1) ?? this.loops[0];
    return (
      this.loops.find(
        (loop) =>
          !loop.announced &&
          loop.score.revisionId !== sounding?.score.revisionId,
      )?.startTime ?? null
    );
  }

  start(score: Score, now: number) {
    this.running = true;
    this.candidate = null;
    this.loops = [this.makeLoop(score, now + 0.05)];
    this.scheduledThrough = now;
    this.tick(now);
  }

  stop(now: number) {
    this.running = false;
    for (const loop of this.loops) this.callbacks.cancel(loop, now);
    this.loops = [];
    this.candidate = null;
  }

  queue(score: Score, now: number) {
    if (!this.running) return { atTime: now, seconds: 0 };
    this.tick(now);
    if (!this.running) return { atTime: now, seconds: 0 };
    const atTime = this.loops[this.loops.length - 1]!.endTime;
    this.candidate = { score: structuredClone(score), atTime };
    return { atTime, seconds: Math.max(0, atTime - now) };
  }

  /** Undo is special: retract unheard loops, including sources in the lookahead. */
  cancelPending(now: number, replacement?: Score): Score | null {
    if (!this.running) return null;
    this.announce(now);
    this.candidate = null;
    const sounding = this.loops.filter((loop) => loop.startTime <= now).at(-1);
    const initial = this.loops[0]!;
    const future = this.loops.filter((loop) => loop.startTime > now);
    for (const loop of future) this.callbacks.cancel(loop, now);
    this.loops = this.loops.filter((loop) => loop.startTime <= now);
    // Before the initial onset, replay that original score at the original onset.
    if (!sounding)
      this.loops = [
        this.makeLoop(replacement ?? initial.score, initial.startTime),
      ];
    else if (replacement) {
      // Session Undo may restore the sounding music under a fresh revision ID.
      // Keep this loop's already compiled events/timing and only update identity.
      sounding.score = {
        ...sounding.score,
        id: replacement.id,
        revisionId: replacement.revisionId,
        title: replacement.title,
      };
    }
    this.tick(now);
    return structuredClone(
      sounding?.score ?? this.loops[0]?.score ?? initial.score,
    );
  }

  position(now: number) {
    const loop = this.loops.filter((item) => item.startTime <= now).at(-1);
    if (!this.running || !loop) return 0;
    return Math.min(
      loop.score.bars * 16 - 0.00001,
      Math.max(0, (now - loop.startTime) / (60 / loop.score.bpm / 4)),
    );
  }

  tick(now: number) {
    if (!this.running) return;
    // A starved main thread cannot safely play an already-missed musical event.
    if (
      now > this.scheduledThrough + 0.035 &&
      this.scheduledThrough > this.loops[0]!.startTime
    ) {
      this.stop(now);
      this.callbacks.underrun();
      return;
    }
    this.announce(now);
    const horizon = now + this.horizon;
    let tail = this.loops[this.loops.length - 1]!;
    while (tail.endTime <= horizon) {
      const score = this.candidate?.score ?? tail.score;
      this.candidate = null;
      tail = this.makeLoop(score, tail.endTime);
      this.loops.push(tail);
    }
    for (const loop of this.loops) {
      const stepSeconds = 60 / loop.score.bpm / 4;
      while (loop.cursor < loop.events.length) {
        const event = loop.events[loop.cursor]!;
        const when = loop.startTime + event.startStep * stepSeconds;
        if (when > horizon) break;
        if (when < now - 0.035) {
          this.stop(now);
          this.callbacks.underrun();
          return;
        }
        this.callbacks.schedule(
          event,
          when,
          event.durationSteps * stepSeconds,
          loop,
        );
        loop.cursor++;
      }
    }
    this.scheduledThrough = horizon;
    // Keep the sounding loop until its successor actually begins.
    while (this.loops.length > 1 && this.loops[1]!.startTime <= now)
      this.loops.shift();
  }

  private announce(now: number) {
    for (const loop of this.loops) {
      if (!loop.announced && loop.startTime <= now) {
        loop.announced = true;
        this.callbacks.loop(loop);
      }
    }
  }

  private makeLoop(score: Score, startTime: number): LoopPlan {
    // Callers may continue editing their drafts; frozen loops own their snapshot.
    const snapshot = structuredClone(score);
    return {
      id: ++this.serial,
      score: snapshot,
      startTime,
      endTime: startTime + loopSeconds(snapshot),
      events: compileScore(snapshot),
      cursor: 0,
      announced: false,
    };
  }
}
