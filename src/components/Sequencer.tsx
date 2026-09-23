import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import type { Drum, Note, Score, TrackId } from "../../shared/types";
import { pitchName, scalePitches } from "../../shared/score";

interface Props {
  score: Score;
  trackId: TrackId;
  playing: boolean;
  position: number;
  changedNotes: Set<string>;
  disabled?: boolean;
  onTrack(id: TrackId): void;
  onEdit(score: Score, label: string): void;
}
export function Sequencer({
  score,
  trackId,
  playing,
  position,
  changedNotes,
  disabled,
  onTrack,
  onEdit,
}: Props) {
  const [bar, setBar] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [octave, setOctave] = useState(0);
  const [focus, setFocus] = useState({ row: 0, col: 0 });
  const activeBar = Math.min(bar, score.bars - 1);
  const track = score.tracks.find((t) => t.id === trackId)!;
  const selected = track.notes.find((n) => n.id === selectedId);
  const [startInput, setStartInput] = useState("");
  const [lengthInput, setLengthInput] = useState("");
  useEffect(() => {
    setStartInput(String((selected?.start ?? 0) + 1));
    setLengthInput(String(selected?.duration ?? 1));
  }, [selected?.id, selected?.start, selected?.duration]);
  const lower = trackId === "bass" ? 28 : 48,
    upper = trackId === "bass" ? 60 : 84;
  const center = trackId === "bass" ? 36 : 60;
  const bottom = Math.max(lower, Math.min(upper - 12, center + octave * 12));
  const pitches = Array.from({ length: 13 }, (_, i) => bottom + 12 - i);
  const inScale = new Set(scalePitches(score.key, score.scale, lower, upper));
  const drumRows: { drum: Drum; name: string; pitch: number }[] = [
    { drum: "kick", name: "Kick", pitch: 36 },
    { drum: "snare", name: "Snare", pitch: 38 },
    { drum: "hat", name: "Hi-hat", pitch: 42 },
  ];
  const rows =
    trackId === "drums"
      ? drumRows.map((d) => ({ ...d, label: d.name }))
      : pitches.map((pitch) => ({
          pitch,
          drum: null,
          label: pitchName(pitch),
        }));
  function write(notes: Note[], label: string) {
    onEdit(
      {
        ...score,
        tracks: score.tracks.map((t) =>
          t.id === trackId ? { ...t, notes } : t,
        ),
      },
      label,
    );
  }
  function cell(row: number, col: number, selectOnly = false) {
    if (disabled) return;
    const start = activeBar * 16 + col;
    const r = rows[row];
    const existing = track.notes.find(
      (n) =>
        n.pitch === r.pitch && n.start <= start && n.start + n.duration > start,
    );
    if (existing) {
      if (trackId === "drums" && !selectOnly) {
        write(
          track.notes.filter((n) => n.id !== existing.id),
          `Remove ${r.label}`,
        );
      } else setSelectedId(existing.id);
      return;
    }
    const note: Note = {
      id: crypto.randomUUID(),
      start,
      duration: 1,
      pitch: r.pitch,
      velocity: trackId === "drums" ? (r.drum === "hat" ? 0.48 : 0.82) : 0.7,
      drum: r.drum,
    };
    const notes =
      trackId === "drums"
        ? track.notes
        : track.notes.filter(
            (n) => n.start + n.duration <= start || n.start >= start + 1,
          );
    write(
      [...notes, note],
      `Add ${trackId === "drums" ? r.label : pitchName(r.pitch)}`,
    );
    setSelectedId(note.id);
  }
  function updateNote(patch: Partial<Note>) {
    if (!selected) return;
    const note = { ...selected, ...patch };
    note.start = Math.max(0, Math.min(score.bars * 16 - 1, note.start));
    note.duration = Math.max(
      1,
      Math.min(score.bars * 16 - note.start, note.duration),
    );
    const notes = track.notes.filter(
      (n) =>
        n.id !== note.id &&
        ((trackId === "drums" && n.pitch !== note.pitch) ||
          n.start + n.duration <= note.start ||
          n.start >= note.start + note.duration),
    );
    write([...notes, note], `Edit ${track.name} note`);
  }
  return (
    <section className={`sequencer ${trackId}`} aria-label="Note editor">
      <div className="editor-toolbar">
        <div className="track-tabs" role="tablist" aria-label="Edit track">
          {score.tracks.map((t) => (
            <button
              role="tab"
              aria-selected={trackId === t.id}
              key={t.id}
              className={trackId === t.id ? "active" : ""}
              onClick={() => {
                onTrack(t.id);
                setSelectedId(null);
                setOctave(0);
                setFocus({ row: 0, col: 0 });
              }}
            >
              <span className={`track-dot ${t.id}`} />
              {t.name}
            </button>
          ))}
        </div>
        <div className="bar-controls">
          <span>Bar</span>
          {Array.from({ length: score.bars }, (_, i) => (
            <button
              key={i}
              className={i === activeBar ? "active" : ""}
              aria-label={`Edit bar ${i + 1}`}
              aria-pressed={i === activeBar}
              onClick={() => setBar(i)}
            >
              {i + 1}
            </button>
          ))}
          <span className="grid-resolution">1/16</span>
        </div>
      </div>
      <div
        className={`grid-wrap ${trackId === "drums" ? "drum-grid-wrap" : "piano-grid-wrap"}`}
      >
        <div className="step-numbers">
          <span />
          {Array.from({ length: 16 }, (_, i) => (
            <span key={i} className={i % 4 === 0 ? "beat" : ""}>
              {i % 4 === 0 ? i / 4 + 1 : "·"}
            </span>
          ))}
        </div>
        <div
          className="note-grid"
          role="grid"
          aria-label={`${track.name} ${trackId === "drums" ? "step sequencer" : "piano roll"}, bar ${activeBar + 1}`}
        >
          {rows.map((row, r) => (
            <div
              role="row"
              className={`grid-row ${!inScale.has(row.pitch) && trackId !== "drums" ? "out-of-scale" : ""}`}
              key={row.pitch}
            >
              <span
                className={`row-label ${row.label.includes("♯") || row.label.includes("#") ? "sharp" : ""}`}
                role="rowheader"
              >
                {row.label}
              </span>
              {Array.from({ length: 16 }, (_, c) => {
                const start = activeBar * 16 + c;
                const note = track.notes.find(
                  (n) =>
                    n.pitch === row.pitch &&
                    n.start <= start &&
                    n.start + n.duration > start,
                );
                const sounding = playing && Math.floor(position) === start;
                return (
                  <button
                    role="gridcell"
                    key={c}
                    data-row={r}
                    data-col={c}
                    tabIndex={focus.row === r && focus.col === c ? 0 : -1}
                    disabled={disabled}
                    aria-selected={!!note}
                    aria-label={`${row.label}, step ${c + 1}${note ? ", note on" : ""}`}
                    className={`step-cell ${c % 4 === 0 ? "beat-start" : ""} ${note ? "on" : ""} ${note && note.start < start ? "sustain" : ""} ${note?.id === selectedId ? "note-selected" : ""} ${note && changedNotes.has(note.id) ? "changed" : ""} ${sounding ? "playhead" : ""}`}
                    onFocus={() => setFocus({ row: r, col: c })}
                    onClick={(e) => cell(r, c, e.shiftKey)}
                    onDoubleClick={() => {
                      if (note && trackId !== "drums")
                        write(
                          track.notes.filter((n) => n.id !== note.id),
                          "Remove note",
                        );
                    }}
                    onKeyDown={(e) => {
                      const delta: { [key: string]: [number, number] } = {
                        ArrowLeft: [0, -1],
                        ArrowRight: [0, 1],
                        ArrowUp: [-1, 0],
                        ArrowDown: [1, 0],
                      };
                      if (delta[e.key]) {
                        e.preventDefault();
                        const [dr, dc] = delta[e.key];
                        const nr = Math.max(
                            0,
                            Math.min(rows.length - 1, r + dr),
                          ),
                          nc = Math.max(0, Math.min(15, c + dc));
                        setFocus({ row: nr, col: nc });
                        e.currentTarget
                          .closest(".note-grid")
                          ?.querySelector<HTMLButtonElement>(
                            `[data-row="${nr}"][data-col="${nc}"]`,
                          )
                          ?.focus();
                      }
                      if (
                        (e.key === "Delete" || e.key === "Backspace") &&
                        note
                      ) {
                        e.preventDefault();
                        write(
                          track.notes.filter((n) => n.id !== note.id),
                          "Remove note",
                        );
                      }
                    }}
                  >
                    {note && trackId === "drums" ? (
                      <span className="pad-led" />
                    ) : note && note.start === start ? (
                      <span className="note-mark" />
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="editor-footer">
        <div className="editor-hint">
          {trackId === "drums" ? (
            <>
              <span className="tiny-square" />
              Tap a step to make a beat.
            </>
          ) : (
            <>
              <span className="tiny-square" />
              Click to add. Select a note to shape it.
            </>
          )}
        </div>
        {trackId !== "drums" && (
          <div className="octave-controls">
            <button
              aria-label="Piano roll lower octave"
              disabled={bottom === lower}
              onClick={() => setOctave((o) => o - 1)}
            >
              <ChevronDown size={14} />
            </button>
            <span>
              {pitchName(bottom)}–{pitchName(bottom + 12)}
            </span>
            <button
              aria-label="Piano roll higher octave"
              disabled={bottom === upper - 12}
              onClick={() => setOctave((o) => o + 1)}
            >
              <ChevronUp size={14} />
            </button>
          </div>
        )}
        <span>{track.notes.length} notes</span>
      </div>
      {selected && !disabled && (
        <div className="note-inspector">
          <b>{selected.drum ?? pitchName(selected.pitch)}</b>
          {trackId !== "drums" && (
            <label>
              Pitch{" "}
              <select
                aria-label="Note pitch"
                value={selected.pitch}
                onChange={(e) => updateNote({ pitch: Number(e.target.value) })}
              >
                {Array.from({ length: upper - lower + 1 }, (_, i) => (
                  <option key={i} value={lower + i}>
                    {pitchName(lower + i)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Step{" "}
            <input
              aria-label="Note start step"
              type="number"
              min="1"
              max={score.bars * 16}
              value={startInput}
              onChange={(e) => setStartInput(e.target.value)}
              onBlur={() => {
                const start = Number(startInput);
                if (
                  Number.isInteger(start) &&
                  start >= 1 &&
                  start <= score.bars * 16
                )
                  updateNote({ start: start - 1 });
                else setStartInput(String(selected.start + 1));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
          </label>
          <label>
            Length{" "}
            <input
              aria-label="Note duration"
              type="number"
              min="1"
              max={score.bars * 16 - selected.start}
              value={lengthInput}
              onChange={(e) => setLengthInput(e.target.value)}
              onBlur={() => {
                const duration = Number(lengthInput);
                if (
                  Number.isInteger(duration) &&
                  duration >= 1 &&
                  duration <= score.bars * 16 - selected.start
                )
                  updateNote({ duration });
                else setLengthInput(String(selected.duration));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
          </label>
          <label>
            Velocity{" "}
            <input
              aria-label="Note velocity"
              type="range"
              min=".05"
              max="1"
              step=".05"
              value={selected.velocity}
              onChange={(e) => updateNote({ velocity: Number(e.target.value) })}
            />
          </label>
          <button
            onClick={() => {
              write(
                track.notes.filter((n) => n.id !== selected.id),
                "Remove note",
              );
              setSelectedId(null);
            }}
            aria-label="Remove selected note"
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}
    </section>
  );
}
