import type { Drum, Score, TrackId } from "../../shared/types";
import { TRACK_IDS } from "../../shared/types";
import { AudioTimeline } from "./timeline";
import {
  DEFAULT_MASTER,
  ENGINE_HEADROOM,
  ramp,
  synthesize,
  type Voice,
} from "./synth";

export interface SoundingNote {
  trackId: TrackId;
  noteId: string;
  pitch: number;
  drum: Drum | null;
  velocity: number;
}
export interface AudioCallbacks {
  onLoop?(score: Score): void;
  onNote?(event: SoundingNote): void;
  /** Integer display step, emitted only when it changes during playback. */
  onPosition?(step: number): void;
  onStop?(reason: string): void;
}
export interface AudioEnvironment {
  createContext?: () => AudioContext;
}
interface OwnedVoice {
  voice: Voice;
  loopId: number;
}
interface VisualEvent {
  atTime: number;
  loopId: number;
  note: SoundingNote;
}

export function trackLevel(score: Score, trackId: TrackId) {
  const track = score.tracks.find((item) => item.id === trackId)!;
  const soloing = score.tracks.some((item) => item.solo);
  return track.mute || (soloing && !track.solo) ? 0 : track.volume;
}

export class AudioEngine {
  private context: AudioContext | null = null;
  private transport: GainNode | null = null;
  private master: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private tracks = new Map<TrackId, GainNode>();
  private voices = new Set<OwnedVoice>();
  private visualEvents: VisualEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame: number | null = null;
  private displayedStep = -1;
  private mixer: Score | null = null;
  private masterVolume = DEFAULT_MASTER;
  private masterMuted = false;
  private disposed = false;
  private startToken = 0;
  private starting = false;
  private readonly timeline: AudioTimeline;

  constructor(
    private readonly callbacks: AudioCallbacks = {},
    private readonly environment: AudioEnvironment = {},
  ) {
    this.timeline = new AudioTimeline({
      schedule: (event, atTime, duration, loop) => {
        const voice = synthesize(
          this.context!,
          this.tracks.get(event.trackId)!,
          event,
          atTime,
          duration,
          loop.endTime,
          loop.score.seed,
        );
        const owned = { voice, loopId: loop.id };
        this.voices.add(owned);
        let ended = 0;
        for (const source of voice.sources)
          source.onended = () => {
            if (++ended === voice.sources.length) {
              voice.disconnect();
              this.voices.delete(owned);
            }
          };
        this.visualEvents.push({
          atTime,
          loopId: loop.id,
          note: {
            trackId: event.trackId,
            noteId: event.noteId,
            pitch: event.pitch,
            drum: event.drum,
            velocity: event.velocity,
          },
        });
        this.visualEvents.sort((left, right) => left.atTime - right.atTime);
      },
      cancel: (loop, now) => {
        for (const owned of this.voices)
          if (owned.loopId === loop.id) owned.voice.stop(now);
        this.visualEvents = this.visualEvents.filter(
          (event) => event.loopId !== loop.id,
        );
      },
      loop: (loop) => this.callbacks.onLoop?.(loop.score),
      underrun: () =>
        this.stop(
          "Playback paused after an audio timing interruption. Press Play to restart.",
        ),
    });
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", this.onVisibility);
  }

  get playing() {
    return this.timeline.playing;
  }
  get pendingTime() {
    return this.timeline.pendingTime;
  }
  get currentTime() {
    return this.context?.currentTime ?? 0;
  }

  /** Must be called by a user gesture. Constructing an engine never opens audio. */
  async start(score: Score, latestScore?: () => Score) {
    if (this.disposed) throw new Error("This audio engine has been disposed.");
    if (this.playing) this.stop("Restarted");
    const token = ++this.startToken;
    if (!this.context) this.createGraph();
    const context = this.context!;
    this.starting = true;
    try {
      await context.resume();
    } catch (error) {
      if (token === this.startToken) this.starting = false;
      throw error;
    }
    if (token !== this.startToken || this.disposed) return;
    this.starting = false;
    if (typeof document !== "undefined" && document.hidden) {
      this.callbacks.onStop?.(
        "Playback paused while the tab was hidden. Press Play to restart.",
      );
      return;
    }
    if (context.state !== "running")
      throw new Error("Audio could not start. Press Play to try again.");
    const initialScore = latestScore?.() ?? score;
    this.setMixer(initialScore);
    // Cancel all previous transport automation before a rapid stop/restart.
    this.transport!.gain.cancelScheduledValues(context.currentTime);
    this.transport!.gain.setValueAtTime(0, context.currentTime);
    this.transport!.gain.linearRampToValueAtTime(
      1,
      context.currentTime + 0.012,
    );
    this.timeline.start(initialScore, context.currentTime);
    this.displayedStep = -1;
    this.timer = setInterval(() => this.timeline.tick(context.currentTime), 25);
    this.draw();
  }

  stop(reason = "Stopped") {
    ++this.startToken;
    this.starting = false;
    const wasPlaying = this.playing;
    const now = this.currentTime;
    this.timeline.stop(now);
    if (this.timer !== null) clearInterval(this.timer);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.timer = null;
    this.frame = null;
    this.displayedStep = -1;
    this.visualEvents = [];
    if (this.transport) ramp(this.transport.gain, 0, now, 0.008);
    // Include voices from a preceding loop whose tiny release has not yet ended.
    for (const owned of this.voices) owned.voice.stop(now);
    this.callbacks.onPosition?.(0);
    if (wasPlaying || reason !== "Stopped") this.callbacks.onStop?.(reason);
  }

  queue(score: Score) {
    return this.timeline.queue(score, this.currentTime);
  }
  synchronize() {
    this.timeline.tick(this.currentTime);
  }
  cancelPending(replacement?: Score) {
    return this.timeline.cancelPending(this.currentTime, replacement);
  }

  setMixer(score: Score) {
    this.mixer = structuredClone(score);
    for (const id of TRACK_IDS) {
      const track = this.tracks.get(id);
      if (track) ramp(track.gain, trackLevel(score, id), this.currentTime);
    }
  }

  setMaster(volume: number, muted: boolean) {
    this.masterVolume = Math.max(0, Math.min(1, volume));
    this.masterMuted = muted;
    if (this.master)
      ramp(
        this.master.gain,
        muted ? 0 : this.masterVolume * ENGINE_HEADROOM,
        this.currentTime,
      );
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", this.onVisibility);
    for (const owned of this.voices) owned.voice.disconnect();
    this.voices.clear();
    for (const node of this.tracks.values()) node.disconnect();
    this.tracks.clear();
    this.transport?.disconnect();
    this.master?.disconnect();
    this.limiter?.disconnect();
    if (this.context) {
      this.context.removeEventListener("statechange", this.onContextState);
      void this.context.close().catch(() => {});
    }
    this.context = null;
    this.transport = null;
    this.master = null;
    this.limiter = null;
  }

  private createGraph() {
    const AudioContextClass =
      globalThis.AudioContext ??
      (
        globalThis as typeof globalThis & {
          webkitAudioContext?: typeof AudioContext;
        }
      ).webkitAudioContext;
    if (!this.environment.createContext && !AudioContextClass)
      throw new Error("This browser does not support Web Audio.");
    const context =
      this.environment.createContext?.() ??
      new AudioContextClass!({ latencyHint: "interactive" });
    this.context = context;
    this.transport = context.createGain();
    this.transport.gain.value = 0;
    this.master = context.createGain();
    this.master.gain.value = this.masterMuted
      ? 0
      : this.masterVolume * ENGINE_HEADROOM;
    this.limiter = context.createDynamicsCompressor();
    this.limiter.threshold.value = -2;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.12;
    this.transport.connect(this.master);
    this.master.connect(this.limiter);
    this.limiter.connect(context.destination);
    for (const id of TRACK_IDS) {
      const gain = context.createGain();
      gain.gain.value = 0;
      gain.connect(this.transport);
      this.tracks.set(id, gain);
    }
    context.addEventListener("statechange", this.onContextState);
  }

  private draw = () => {
    if (!this.playing) return;
    const now = this.currentTime;
    while (this.visualEvents.length && this.visualEvents[0]!.atTime <= now) {
      const event = this.visualEvents.shift()!;
      if (
        !this.masterMuted &&
        this.masterVolume > 0 &&
        this.mixer &&
        trackLevel(this.mixer, event.note.trackId) > 0
      ) {
        this.callbacks.onNote?.(event.note);
      }
    }
    const step = Math.floor(this.timeline.position(now));
    if (step !== this.displayedStep) {
      this.displayedStep = step;
      this.callbacks.onPosition?.(step);
    }
    this.frame = requestAnimationFrame(this.draw);
  };

  private onVisibility = () => {
    if (document.hidden) {
      // Also invalidates an unresolved resume() so it cannot start in the background.
      if (this.playing || this.starting)
        this.stop(
          "Playback paused while the tab was hidden. Press Play to restart.",
        );
      else ++this.startToken;
    }
  };
  private onContextState = () => {
    if (this.playing && this.context?.state !== "running") {
      this.stop(
        "Playback paused because audio was interrupted. Press Play to restart.",
      );
    }
  };
}
