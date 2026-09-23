import type { CompiledEvent } from "../../shared/score";

export const ENGINE_HEADROOM = 0.3;
export const DEFAULT_MASTER = 0.7;
export interface Voice {
  sources: AudioScheduledSourceNode[];
  nodes: AudioNode[];
  startTime: number;
  endTime: number;
  stop(atTime: number): void;
  disconnect(): void;
}

const noiseCache = new WeakMap<BaseAudioContext, Map<number, AudioBuffer>>();
function noise(context: BaseAudioContext, seed: number) {
  let cache = noiseCache.get(context);
  if (!cache) {
    cache = new Map();
    noiseCache.set(context, cache);
  }
  const cached = cache.get(seed);
  if (cached) return cached;
  const buffer = context.createBuffer(
    1,
    context.sampleRate,
    context.sampleRate,
  );
  const channel = buffer.getChannelData(0);
  let state = seed >>> 0 || 1;
  for (let index = 0; index < channel.length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    channel[index] = (state >>> 0) / 2147483648 - 1;
  }
  // Bound context-local memory while preserving deterministic noise for each seed.
  if (cache.size >= 8) cache.delete(cache.keys().next().value!);
  cache.set(seed, buffer);
  return buffer;
}

export function ramp(
  param: AudioParam,
  value: number,
  atTime: number,
  seconds = 0.012,
) {
  if (typeof param.cancelAndHoldAtTime === "function")
    param.cancelAndHoldAtTime(atTime);
  else {
    const current = param.value;
    param.cancelScheduledValues(atTime);
    param.setValueAtTime(current, atTime);
  }
  param.linearRampToValueAtTime(value, atTime + seconds);
}

/** Shared live/offline synthesis: all randomness derives from the persisted seed. */
export function synthesize(
  context: BaseAudioContext,
  destination: AudioNode,
  event: CompiledEvent,
  atTime: number,
  duration: number,
  loopEnd: number,
  seed: number,
): Voice {
  const sources: AudioScheduledSourceNode[] = [];
  const nodes: AudioNode[] = [];
  const envelope = context.createGain();
  envelope.connect(destination);
  nodes.push(envelope);
  const velocity = Math.pow(event.velocity, 1.25);
  const brightness = event.brightness;
  const decay = event.decay;
  let amplitude = 0.4 * velocity;
  let attack = 0.007;
  let life = duration;
  let release = 0.016;

  const oscillator = (
    type: OscillatorType,
    frequency: number,
    gain = 1,
    output: AudioNode = envelope,
  ) => {
    const source = context.createOscillator();
    source.type = type;
    source.frequency.setValueAtTime(frequency, atTime);
    if (gain === 1) source.connect(output);
    else {
      const level = context.createGain();
      level.gain.value = gain;
      source.connect(level);
      level.connect(output);
      nodes.push(level);
    }
    sources.push(source);
    nodes.push(source);
    return source;
  };
  const filteredNoise = (
    type: BiquadFilterType,
    frequency: number,
    level = 1,
  ) => {
    const source = context.createBufferSource();
    source.buffer = noise(context, seed);
    source.loop = true;
    const filter = context.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = 0.7;
    const gain = context.createGain();
    gain.gain.value = level;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(envelope);
    sources.push(source);
    nodes.push(source, filter, gain);
  };

  if (event.drum === "kick") {
    attack = 0.002;
    amplitude = 0.82 * velocity;
    life = 0.13 + decay * 0.28;
    const kick = oscillator("sine", 125 + brightness * 60);
    kick.frequency.exponentialRampToValueAtTime(
      event.preset === "tight-kit" ? 56 : 43,
      atTime + 0.07,
    );
  } else if (event.drum === "snare") {
    attack = 0.002;
    amplitude = 0.49 * velocity;
    life = 0.09 + decay * 0.18;
    filteredNoise("highpass", 850 + brightness * 1800, 0.78);
    oscillator("triangle", 180, 0.26);
  } else if (event.drum === "hat") {
    attack = 0.001;
    amplitude = 0.2 * velocity;
    life = 0.025 + decay * 0.075;
    filteredNoise("highpass", 5800 + brightness * 5000);
  } else {
    const frequency = 440 * Math.pow(2, (event.pitch - 69) / 12);
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = event.preset === "rubber-bass" ? 2.5 : 0.65;
    const bass = event.trackId === "bass";
    const cutoff = bass ? 140 + brightness * 2200 : 650 + brightness * 6500;
    filter.frequency.setValueAtTime(cutoff, atTime);
    filter.frequency.exponentialRampToValueAtTime(
      Math.max(90, cutoff * (0.2 + decay * 0.5)),
      atTime + Math.max(0.03, duration),
    );
    filter.connect(envelope);
    nodes.push(filter);
    amplitude = (bass ? 0.5 : 0.27) * velocity;
    attack = event.preset === "soft-lead" ? 0.025 : 0.006;
    release = 0.022;
    const wave: OscillatorType =
      event.preset === "sub-bass"
        ? "sine"
        : event.preset === "glass-lead" || event.preset === "soft-lead"
          ? "triangle"
          : "sawtooth";
    oscillator(wave, frequency, 1, filter);
    if (event.preset === "glass-lead")
      oscillator("sine", frequency * 2, 0.12, filter);
    if (event.preset === "pluck-lead")
      life = Math.min(duration, 0.09 + decay * 0.8);
  }

  // Release crossfades are short; no sustain ever crosses a score boundary.
  const sustainEnd = Math.min(atTime + life, atTime + duration, loopEnd);
  const endTime = Math.min(sustainEnd + release, loopEnd + 0.012);
  const peakAt = Math.min(atTime + attack, sustainEnd - 0.0005);
  envelope.gain.setValueAtTime(0, atTime);
  envelope.gain.linearRampToValueAtTime(amplitude, peakAt);
  envelope.gain.exponentialRampToValueAtTime(
    Math.max(0.0001, amplitude * (event.drum ? 0.007 : 0.25 + decay * 0.4)),
    sustainEnd,
  );
  envelope.gain.linearRampToValueAtTime(0, endTime);
  for (const source of sources) {
    source.start(atTime);
    source.stop(endTime + 0.001);
  }
  let disconnected = false;
  return {
    sources,
    nodes,
    startTime: atTime,
    endTime,
    stop(when) {
      if (atTime <= when) ramp(envelope.gain, 0, when, 0.008);
      for (const source of sources) {
        try {
          source.stop(atTime > when ? when : when + 0.009);
        } catch {
          /* Already ended. */
        }
      }
    },
    disconnect() {
      if (disconnected) return;
      disconnected = true;
      for (const node of nodes) node.disconnect();
    },
  };
}
