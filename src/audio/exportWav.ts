import { compileScore, loopSeconds } from "../../shared/score";
import type { Score } from "../../shared/types";
import { TRACK_IDS } from "../../shared/types";
import { trackLevel } from "./AudioEngine";
import {
  DEFAULT_MASTER,
  ENGINE_HEADROOM,
  synthesize,
  type Voice,
} from "./synth";

/** PCM16 RIFF encoding is separate so its interleaving/clamping can be tested. */
export function encodeWav(
  buffer: Pick<
    AudioBuffer,
    "numberOfChannels" | "length" | "sampleRate" | "getChannelData"
  >,
) {
  const channels = buffer.numberOfChannels;
  const dataBytes = buffer.length * channels * 2;
  const bytes = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(bytes);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++)
      view.setUint8(offset + index, value.charCodeAt(index));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, dataBytes, true);
  const samples = Array.from({ length: channels }, (_, index) =>
    buffer.getChannelData(index),
  );
  let offset = 44;
  for (let sample = 0; sample < buffer.length; sample++) {
    for (let channel = 0; channel < channels; channel++) {
      const raw = samples[channel]![sample]!;
      const value = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
      view.setInt16(
        offset,
        Math.round(value * (value < 0 ? 32768 : 32767)),
        true,
      );
      offset += 2;
    }
  }
  return new Blob([bytes], { type: "audio/wav" });
}

/** Render the actual score with the same voices, mixer, and headroom as Play. */
export async function exportWav(score: Score, loops = 4): Promise<Blob> {
  if (!Number.isInteger(loops) || loops < 1 || loops > 16)
    throw new Error("Export between 1 and 16 loops.");
  if (!globalThis.OfflineAudioContext)
    throw new Error("This browser does not support offline audio export.");
  const seconds = loopSeconds(score);
  const sampleRate = 44100;
  const context = new OfflineAudioContext(
    2,
    Math.ceil((seconds * loops + 0.05) * sampleRate),
    sampleRate,
  );
  const master = context.createGain();
  master.gain.value = DEFAULT_MASTER * ENGINE_HEADROOM;
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -2;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.12;
  master.connect(limiter);
  limiter.connect(context.destination);
  const tracks = new Map(
    TRACK_IDS.map((id) => {
      const gain = context.createGain();
      gain.gain.value = trackLevel(score, id);
      gain.connect(master);
      return [id, gain] as const;
    }),
  );
  const events = compileScore(score);
  const voices: Voice[] = [];
  for (let loop = 0; loop < loops; loop++) {
    for (const event of events) {
      voices.push(
        synthesize(
          context,
          tracks.get(event.trackId)!,
          event,
          loop * seconds + (event.startStep * 60) / score.bpm / 4,
          (event.durationSteps * 60) / score.bpm / 4,
          (loop + 1) * seconds,
          score.seed,
        ),
      );
    }
  }
  try {
    return encodeWav(await context.startRendering());
  } finally {
    for (const voice of voices) voice.disconnect();
    for (const node of tracks.values()) node.disconnect();
    master.disconnect();
    limiter.disconnect();
  }
}
