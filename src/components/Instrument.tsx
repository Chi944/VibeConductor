import { LockKeyhole, LockKeyholeOpen, Volume2 } from "lucide-react";
import type { Track, TrackId } from "../../shared/types";
import { PRESETS } from "../../shared/score";

interface Props {
  track: Track;
  active: boolean;
  hit: { pitch: number; drum: string | null; at: number } | undefined;
  protectedTrack: boolean;
  disabled?: boolean;
  onSelect(): void;
  onChange(track: Track, label: string): void;
  onProtect(): void;
}
export function Instrument({
  track,
  active,
  hit,
  protectedTrack,
  disabled,
  onSelect,
  onChange,
  onProtect,
}: Props) {
  const lit = !!hit;
  const meta: Record<TrackId, { title: string; name: string; symbol: string }> =
    {
      drums: { title: "Rhythm section", name: "PULSE", symbol: "01" },
      bass: { title: "Low frequencies", name: "BODY", symbol: "02" },
      lead: { title: "Melody & movement", name: "SPARK", symbol: "03" },
    };
  return (
    <section
      className={`instrument ${track.id} ${active ? "selected" : ""} ${track.mute ? "muted" : ""}`}
      aria-label={`${track.name} instrument`}
    >
      <div className="module-top">
        <button
          className="module-name"
          onClick={onSelect}
          aria-pressed={active}
        >
          <span className={`status-dot ${lit ? "lit" : ""}`} />
          {track.name}
          <span className="module-description">{meta[track.id].title}</span>
        </button>
        <span className="module-id">{meta[track.id].symbol}</span>
      </div>
      <div
        className={`instrument-physical ${lit ? "sounding" : ""}`}
        aria-hidden="true"
      >
        <span className="screw top-left" />
        <span className="screw top-right" />
        {track.id === "drums" ? (
          <div className="drum-assembly">
            <div className="pad-bank">
              {["kick", "snare", "hat"].map((drum, i) => (
                <div
                  key={drum}
                  className={`drum-pad pad-${drum} ${hit?.drum === drum ? "hit" : ""}`}
                >
                  <div className="pad-ring">
                    <div className="pad-skin">
                      <span>{["K", "S", "H"][i]}</span>
                    </div>
                  </div>
                  <small>{["Kick", "Snare", "Hi-hat"][i]}</small>
                </div>
              ))}
            </div>
            <div className="hardware-label">
              <span>Analog rhythm unit</span>
              <b>{meta[track.id].name}</b>
            </div>
          </div>
        ) : track.id === "bass" ? (
          <div className="bass-assembly">
            <div className={`speaker ${lit ? "hit" : ""}`}>
              <div className="speaker-ring">
                <div className="speaker-cone">
                  <div className="speaker-cap" />
                </div>
              </div>
            </div>
            <div className="bass-meter">
              <div className="meter-bars">
                {Array.from({ length: 9 }, (_, i) => (
                  <i
                    key={i}
                    style={{ height: `${20 + Math.sin(i * 0.85) ** 2 * 55}%` }}
                  />
                ))}
              </div>
              <span>Sub oscillator</span>
              <b>{meta[track.id].name}</b>
            </div>
          </div>
        ) : (
          <div className="lead-assembly">
            <div className="lead-display">
              <svg viewBox="0 0 260 34">
                <path d="M0 17H22L28 5 38 29 48 7 56 23 64 17H94L100 10 110 27 120 3 130 23 139 17H170L176 6 186 28 196 8 206 24 214 17H260" />
              </svg>
              <span>{meta[track.id].name}</span>
            </div>
            <div className="mini-keys">
              {Array.from({ length: 10 }, (_, i) => (
                <div
                  className={`white-key ${lit && hit.pitch % 10 === i ? "hit" : ""}`}
                  key={i}
                >
                  {![2, 6, 9].includes(i) && <div className="black-key" />}
                </div>
              ))}
            </div>
          </div>
        )}
        <span className="screw bottom-left" />
        <span className="screw bottom-right" />
      </div>
      <div className="module-controls">
        <label className="preset-label">
          <span className="sr-only">{track.name} preset</span>
          <select
            value={track.preset}
            disabled={disabled}
            onChange={(e) => {
              const preset = PRESETS[track.id].find(
                (p) => p.id === e.target.value,
              )!;
              onChange(
                {
                  ...track,
                  preset: preset.id,
                  params: {
                    brightness: preset.brightness,
                    decay: preset.decay,
                  },
                },
                `${track.name}: ${preset.name}`,
              );
            }}
          >
            {PRESETS[track.id].map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="track-buttons">
          <button
            disabled={disabled}
            className={track.mute ? "engaged" : ""}
            onClick={() =>
              onChange(
                { ...track, mute: !track.mute },
                `${track.mute ? "Unmute" : "Mute"} ${track.name}`,
              )
            }
            aria-label={`${track.mute ? "Unmute" : "Mute"} ${track.name}`}
            aria-pressed={track.mute}
          >
            M
          </button>
          <button
            disabled={disabled}
            className={track.solo ? "engaged" : ""}
            onClick={() =>
              onChange(
                { ...track, solo: !track.solo },
                `${track.solo ? "Unsolo" : "Solo"} ${track.name}`,
              )
            }
            aria-label={`Solo ${track.name}`}
            aria-pressed={track.solo}
          >
            S
          </button>
          <button
            disabled={disabled}
            className={protectedTrack ? "protected" : ""}
            onClick={onProtect}
            aria-label={`${protectedTrack ? "Unlock" : "Protect"} ${track.name} from AI edits`}
            aria-pressed={protectedTrack}
          >
            {protectedTrack ? (
              <LockKeyhole size={13} />
            ) : (
              <LockKeyholeOpen size={13} />
            )}
          </button>
        </div>
      </div>
      <div className="volume-strip">
        <Volume2 size={12} />
        <input
          aria-label={`${track.name} volume`}
          disabled={disabled}
          type="range"
          min="0"
          max="1"
          step=".01"
          value={track.volume}
          onChange={(e) =>
            onChange(
              { ...track, volume: Number(e.target.value) },
              `${track.name} volume`,
            )
          }
        />
        <span>{Math.round(track.volume * 100)}</span>
      </div>
    </section>
  );
}
