import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  AudioLines,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  FolderOpen,
  Headphones,
  LoaderCircle,
  LockKeyhole,
  Play,
  Plus,
  Save,
  Send,
  Settings2,
  Share2,
  Square,
  Undo2,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type {
  ConductResult,
  HistoryEntry,
  SavedComposition,
  Score,
  Track,
  TrackId,
} from "../shared/types";
import { parseScore, PRESETS, resizeScore } from "../shared/score";
import { EXAMPLES } from "../shared/examples";
import { applyProposal, parseConstraints } from "../shared/edits";
import { AudioEngine } from "./audio/engine";
import { exportWav } from "./audio/exportWav";
import {
  createSession,
  editSession,
  responseIsCurrent,
  revision,
  soundingSession,
  stopSession,
  undoSession,
  type Session,
} from "./state/session";
import { api, ApiError, download } from "./api";
import { Instrument } from "./components/Instrument";
import { Sequencer } from "./components/Sequencer";
import { Dialog } from "./components/Dialog";

const DRAFT_KEY = "vibeconductor:draft:v1";
const keys = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
function freshExample(index = 0): Score {
  return { ...revision(EXAMPLES[index].score), id: crypto.randomUUID() };
}
function recover(): Session {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) {
      const value = JSON.parse(raw);
      const score = parseScore(value.score);
      const history: HistoryEntry[] = Array.isArray(value.history)
        ? value.history
            .slice(-30)
            .map((e: HistoryEntry) => ({ ...e, score: parseScore(e.score) }))
        : [];
      return createSession(score, history);
    }
  } catch {
    /* Invalid recovery is ignored, never sent to audio. */
  }
  return createSession(freshExample());
}
type Modal =
  "library" | "versions" | "export" | "share" | "help" | "settings" | null;
type Access = {
  authenticated: boolean;
  localMode: boolean;
  aiAvailable: boolean;
};
export default function App() {
  const sharedId = location.pathname.match(/^\/s\/([^/]+)$/)?.[1];
  const [session, setSession] = useState<Session>(recover);
  const state = useRef(session);
  const [titleInput, setTitleInput] = useState(session.draft.title);
  const [tempoInput, setTempoInput] = useState(String(session.draft.bpm));
  const [access, setAccess] = useState<Access | null>(null);
  const [authError, setAuthError] = useState("");
  const [password, setPassword] = useState("");
  const [trackId, setTrackId] = useState<TrackId>("drums");
  const [position, setPosition] = useState(-1);
  const [hits, setHits] = useState<
    Partial<Record<TrackId, { pitch: number; drum: string | null; at: number }>>
  >({});
  const [master, setMaster] = useState(0.7);
  const [masterMuted, setMasterMuted] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [notice, setNotice] = useState("");
  const [pendingAt, setPendingAt] = useState(0);
  const [direction, setDirection] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const requestId = useRef("");
  const [protectedTracks, setProtectedTracks] = useState<TrackId[]>([]);
  const [lockTempo, setLockTempo] = useState(true);
  const [targetBar, setTargetBar] = useState<number | null>(null);
  const [saved, setSaved] = useState<
    { id: string; title: string; updatedAt: string }[]
  >([]);
  const [savedId, setSavedId] = useState<string | null>(null);
  const loadGeneration = useRef(0);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [shareUrl, setShareUrl] = useState("");
  const [shareLoaded, setShareLoaded] = useState(!sharedId);
  const [shareError, setShareError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [compared, setCompared] = useState<HistoryEntry | null>(null);
  const [changedNotes, setChangedNotes] = useState(new Set<string>());
  const [lastDirection, setLastDirection] = useState("");
  const engine = useRef<AudioEngine | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const hitTimers = useRef<
    Partial<Record<TrackId, ReturnType<typeof setTimeout>>>
  >({});
  const set = useCallback((next: Session) => {
    state.current = next;
    setSession(next);
  }, []);
  const flash = useCallback((message: string) => setNotice(message), []);
  const cancelRequest = useCallback(() => {
    request.current?.abort();
    request.current = null;
    requestId.current = "";
    setBusy(false);
  }, []);
  useEffect(() => setTitleInput(session.draft.title), [session.draft.title]);
  useEffect(
    () => setTempoInput(String(session.draft.bpm)),
    [session.draft.bpm],
  );

  useEffect(() => {
    const audio = new AudioEngine({
      onLoop: (score) => set(soundingSession(state.current, score)),
      onPosition: setPosition,
      onNote: (event) => {
        const at = performance.now();
        setHits((h) => ({
          ...h,
          [event.trackId]: { pitch: event.pitch, drum: event.drum, at },
        }));
        clearTimeout(hitTimers.current[event.trackId]);
        hitTimers.current[event.trackId] = setTimeout(
          () => setHits((h) => ({ ...h, [event.trackId]: undefined })),
          130,
        );
      },
      onStop: (reason) => {
        set(stopSession(state.current));
        setPosition(-1);
        setHits({});
        if (reason && !["Stopped", "Disposed", "Restart"].includes(reason))
          flash(reason);
      },
    });
    engine.current = audio;
    audio.setMaster(0.7, false);
    return () => {
      audio.dispose();
      Object.values(hitTimers.current).forEach(clearTimeout);
      request.current?.abort();
      engine.current = null;
    };
  }, [set, flash]);
  useEffect(() => {
    api<Access>("/session")
      .then(setAccess)
      .catch(() => {
        setAccess({
          authenticated: false,
          localMode: false,
          aiAvailable: false,
        });
        setAuthError(
          "The studio server is unavailable. Restart it and reload.",
        );
      });
  }, []);
  useEffect(() => {
    if (!sharedId) return;
    api<{ score: Score }>(`/shares/${encodeURIComponent(sharedId)}`)
      .then((result) => {
        set(createSession(parseScore(result.score)));
        setShareLoaded(true);
      })
      .catch((error) => setShareError(error.message));
  }, [sharedId, set]);
  useEffect(() => {
    if (sharedId) return;
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(
          DRAFT_KEY,
          JSON.stringify({
            score: session.draft,
            history: session.history.slice(-30),
          }),
        );
      } catch {
        flash("Browser storage is full. Export JSON to keep this composition.");
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [session.draft, session.history, sharedId, flash]);
  useEffect(() => {
    engine.current?.setMaster(master, masterMuted);
  }, [master, masterMuted]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 6500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!session.pending) return;
    const timer = setInterval(
      () => setPendingAt(engine.current?.pendingTime ?? 0),
      100,
    );
    return () => clearInterval(timer);
  }, [session.pending]);

  const edit = useCallback(
    (score: Score, label: string, acceptedDirection?: string) => {
      if (sharedId) return;
      try {
        const parsed = parseScore(score);
        const next = editSession(
          state.current,
          parsed,
          label,
          acceptedDirection,
        );
        set(next);
        engine.current?.setMixer(next.draft);
        if (next.playing) {
          const queued = engine.current?.queue(next.draft);
          setPendingAt(queued?.atTime ?? 0);
        }
        setCompared(null);
      } catch (error) {
        flash(
          error instanceof Error ? error.message : "That edit is not valid.",
        );
      }
    },
    [sharedId, set, flash],
  );
  const changeTrack = (track: Track, label: string) =>
    edit(
      {
        ...state.current.draft,
        tracks: state.current.draft.tracks.map((t) =>
          t.id === track.id ? track : t,
        ),
      },
      label,
    );
  const play = useCallback(async () => {
    if (!shareLoaded) return;
    if (state.current.playing) {
      engine.current?.stop();
      set(stopSession(state.current));
      return;
    }
    try {
      set({ ...state.current, playing: true });
      await engine.current?.start(
        state.current.draft,
        () => state.current.draft,
      );
    } catch (error) {
      set(stopSession(state.current));
      flash(
        error instanceof Error
          ? error.message
          : "Audio could not start. Press Play to try again.",
      );
    }
  }, [shareLoaded, set, flash]);
  const undo = useCallback(() => {
    if (sharedId || compared) return;
    cancelRequest();
    engine.current?.synchronize();
    if (state.current.pending) {
      const canonical = engine.current?.cancelPending();
      if (canonical) set(soundingSession(state.current, canonical));
    }
    const before = state.current;
    const next = undoSession(before);
    if (before.pending) engine.current?.cancelPending(next.draft);
    else if (next.playing && next.pending) engine.current?.queue(next.draft);
    engine.current?.setMixer(next.draft);
    set(next);
    setChangedNotes(new Set());
    flash(
      before.pending
        ? "Queued changes cancelled."
        : "Returned to the previous version.",
    );
  }, [cancelRequest, set, sharedId, compared, flash]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName) ||
        target.isContentEditable ||
        document.querySelector("dialog[open]")
      )
        return;
      if (e.code === "Space") {
        e.preventDefault();
        void play();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [play, undo]);

  async function conduct() {
    if (!direction.trim() || busy || sharedId || compared) return;
    if (
      /^(undo|return to (the )?previous version|go back)([.!])?$/i.test(
        direction.trim(),
      )
    ) {
      undo();
      setDirection((current) => (current === direction ? "" : current));
      return;
    }
    if (!access?.aiAvailable) {
      flash(
        "AI conducting is not configured. The sequencer, instruments and saving are ready to use.",
      );
      return;
    }
    const base = state.current;
    const controller = new AbortController();
    request.current = controller;
    const id = crypto.randomUUID();
    requestId.current = id;
    setBusy(true);

    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const constraints = parseConstraints(direction, {
        protectedTracks,
        lockTempo,
        targetBar,
        fewerNotes: [],
      });
      const result = await api<ConductResult>("/conduct", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          requestId: id,
          direction,
          score: base.draft,
          constraints,
        }),
      });
      if (
        requestId.current !== id ||
        !responseIsCurrent(
          state.current,
          base.draft.revisionId,
          base.generation,
        )
      ) {
        flash(
          "That response was based on an older version. Your newer edits were kept.",
        );
        return;
      }
      const score = applyProposal(
        state.current.draft,
        result.proposal,
        constraints,
      );
      const previous = new Map(
        base.draft.tracks.flatMap((t) =>
          t.notes.map((n) => [n.id, JSON.stringify(n)] as const),
        ),
      );
      setChangedNotes(
        new Set(
          score.tracks.flatMap((t) =>
            t.notes
              .filter((n) => previous.get(n.id) !== JSON.stringify(n))
              .map((n) => n.id),
          ),
        ),
      );
      edit(score, result.proposal.explanation, direction);
      setLastDirection(result.proposal.explanation);
      setDirection((current) => (current === direction ? "" : current));
    } catch (error) {
      if (controller.signal.aborted)
        flash("Conducting cancelled. Your music kept playing.");
      else
        flash(
          error instanceof Error
            ? error.message
            : "The direction could not be applied.",
        );
    } finally {
      clearTimeout(timeout);
      if (requestId.current === id) {
        setBusy(false);
        request.current = null;
        requestId.current = "";
      }
    }
  }
  async function save() {
    setSaving(true);
    const snapshot = state.current;
    const id = snapshot.draft.id;
    const body = JSON.stringify({
      score: snapshot.draft,
      history: snapshot.history.slice(-30),
    });
    try {
      let result: SavedComposition;
      try {
        result = await api<SavedComposition>(
          savedId === id ? `/compositions/${id}` : "/compositions",
          { method: savedId === id ? "PUT" : "POST", body },
        );
      } catch (error) {
        if (
          !(error instanceof ApiError) ||
          error.status !== 409 ||
          savedId === id
        )
          throw error;
        result = await api<SavedComposition>(`/compositions/${id}`, {
          method: "PUT",
          body,
        });
      }
      if (state.current.draft.id === id) setSavedId(result.id);
      flash("Composition saved, including its version history.");
    } catch (error) {
      flash((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function openLibrary() {
    setModal("library");
    try {
      const result = await api<{ compositions: typeof saved }>("/compositions");
      setSaved(result.compositions);
    } catch (error) {
      flash((error as Error).message);
    }
  }
  function load(
    score: Score,
    history?: HistoryEntry[],
    id: string | null = null,
  ) {
    loadGeneration.current += 1;
    setLoadingId(null);
    engine.current?.stop();
    cancelRequest();
    set(createSession(parseScore(score), history));
    setSavedId(id);
    setModal(null);
    setChangedNotes(new Set());
    setLastDirection("");
    setProtectedTracks([]);
    setTargetBar(null);
    setCompared(null);
  }
  async function loadSaved(id: string) {
    const generation = ++loadGeneration.current;
    const base = state.current.draft.revisionId;
    setLoadingId(id);
    try {
      const composition = await api<SavedComposition>(`/compositions/${id}`);
      if (generation !== loadGeneration.current) return;
      if (state.current.draft.revisionId !== base) {
        flash("Loading cancelled because your composition changed.");
        return;
      }
      load(composition.score, composition.history, composition.id);
    } catch (error) {
      if (generation === loadGeneration.current)
        flash((error as Error).message);
    } finally {
      if (generation === loadGeneration.current) setLoadingId(null);
    }
  }
  async function share() {
    setSaving(true);
    try {
      const result = await api<{ id: string; url: string }>("/shares", {
        method: "POST",
        body: JSON.stringify({ score: state.current.draft }),
      });
      setShareUrl(new URL(result.url, location.origin).href);
      setModal("share");
    } catch (error) {
      flash((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function importFile(file?: File) {
    if (!file) return;
    const generation = ++loadGeneration.current;
    const base = state.current.draft.revisionId;
    try {
      if (file.size > 2_000_000)
        throw new Error("Use a JSON composition smaller than 2 MB.");
      const parsed = parseScore(JSON.parse(await file.text()));
      if (generation !== loadGeneration.current) return;
      if (state.current.draft.revisionId !== base) {
        flash("Import cancelled because your composition changed.");
        return;
      }
      load({ ...revision(parsed), id: crypto.randomUUID() });
      flash("Composition imported.");
    } catch (error) {
      flash(`Import failed: ${(error as Error).message}`);
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  const score = compared?.score ?? session.draft;
  const track = score.tracks.find((t) => t.id === trackId)!;
  const pendingSeconds = Math.max(
    0,
    pendingAt - (engine.current?.currentTime ?? 0),
  );
  const directionHistory = session.history.filter((e) => e.direction);

  if (sharedId && (!shareLoaded || shareError))
    return (
      <main className="recovery">
        <AudioLines size={40} />
        <h1>
          {shareError
            ? "This composition could not be opened."
            : "Opening the studio…"}
        </h1>
        <p>{shareError || "No sound will play until you press Play."}</p>
        <a href="/">Open VibeConductor</a>
      </main>
    );
  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="/" aria-label="VibeConductor home">
          <span className="brand-mark">
            <i />
            <i />
            <i />
            <i />
          </span>
          vibe<span>conductor</span>
          <span className="brand-badge">studio</span>
        </a>
        <nav aria-label="Studio navigation">
          <span className="local-status">
            <span />{" "}
            {sharedId ? "Shared composition" : "Your browser. Your sound."}
          </span>
          <button
            className="icon-button"
            aria-label="Studio help"
            onClick={() => setModal("help")}
          >
            <CircleHelp size={19} />
          </button>
        </nav>
      </header>
      <div className="intro">
        <div>
          <span className="intro-note">
            <span className="tiny-star">✳</span> A little studio, conducted by
            you.
          </span>
          <h1>Find your next feeling.</h1>
          <p>Start with a rhythm. Shape it with words. Make it yours.</p>
        </div>
        <div className="intro-aside">
          <Headphones size={17} />
          <span>
            A good pair of headphones
            <br />
            makes a lovely difference.
          </span>
        </div>
      </div>
      <main className="console" aria-label="VibeConductor studio">
        <div className="console-top-edge">
          <span className="screw" />
          <span className="engraving">
            VibeConductor / expressive music system
          </span>
          <span className="screw" />
        </div>
        <div className="session-bar">
          <div className="composition-title">
            <span className="composition-icon">
              <AudioLines size={18} />
            </span>
            <div>
              {sharedId ? (
                <strong>{score.title}</strong>
              ) : (
                <input
                  aria-label="Composition title"
                  value={compared ? score.title : titleInput}
                  disabled={!!compared}
                  maxLength={80}
                  onChange={(e) => setTitleInput(e.target.value)}
                  onBlur={() => {
                    const title = titleInput.trim();
                    if (!title) setTitleInput(session.draft.title);
                    else if (title !== session.draft.title)
                      edit({ ...session.draft, title }, "Rename composition");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") setTitleInput(session.draft.title);
                  }}
                />
              )}
              <span>
                {sharedId
                  ? "Read-only snapshot · press Play to listen"
                  : "Original composition · everything is editable"}
              </span>
            </div>
            <button
              className="icon-button"
              aria-label="Open compositions"
              disabled={!!sharedId || !!compared}
              onClick={() => void openLibrary()}
            >
              <ChevronDown size={17} />
            </button>
          </div>
          <div className="session-actions">
            {!sharedId && (
              <>
                <button onClick={() => setModal("versions")}>
                  <Clock3 size={15} />
                  <span>Versions</span>
                </button>
                <button
                  disabled={saving || !!compared}
                  onClick={() => void save()}
                >
                  {saving ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : (
                    <Save size={15} />
                  )}
                  <span>Save</span>
                </button>
                <button
                  onClick={() => void share()}
                  disabled={saving || !!compared}
                >
                  <Share2 size={15} />
                  <span>Share</span>
                </button>
              </>
            )}
            <button onClick={() => setModal("export")}>
              <ArrowDownToLine size={16} />
              <span>Export</span>
            </button>
          </div>
        </div>
        <div className="transport">
          <div className="playback-controls">
            <button
              className={`play-button ${session.playing ? "playing" : ""}`}
              onClick={() => void play()}
              aria-label={
                session.playing ? "Stop playback" : "Play composition"
              }
            >
              {session.playing ? (
                <Square size={16} fill="currentColor" />
              ) : (
                <Play size={17} fill="currentColor" />
              )}
              {session.playing ? "Stop" : "Play"}
            </button>
            <button
              className="undo-button"
              disabled={
                !!sharedId ||
                !!compared ||
                (session.history.length <= 1 && !session.pending && !busy)
              }
              onClick={undo}
              aria-label="Undo last change"
            >
              <Undo2 size={18} />
            </button>
          </div>
          <div className="tempo-control">
            <label htmlFor="tempo">Tempo</label>
            <div>
              <input
                id="tempo"
                aria-label="Tempo BPM"
                type="number"
                min="60"
                max="160"
                value={compared ? score.bpm : tempoInput}
                disabled={!!sharedId || !!compared}
                onChange={(e) => setTempoInput(e.target.value)}
                onBlur={() => {
                  const bpm = Number(tempoInput);
                  if (bpm >= 60 && bpm <= 160) {
                    if (bpm !== session.draft.bpm)
                      edit({ ...session.draft, bpm }, "Change tempo");
                  } else {
                    setTempoInput(String(session.draft.bpm));
                    flash("Choose a tempo between 60 and 160 BPM.");
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape")
                    setTempoInput(String(session.draft.bpm));
                }}
              />
              <span>bpm</span>
            </div>
          </div>
          <div className="loop-control">
            <span>Loop length</span>
            <div className="segment-control">
              {([1, 2, 4] as const).map((bars) => (
                <button
                  disabled={!!sharedId || !!compared}
                  aria-label={`${bars} bar loop`}
                  aria-pressed={score.bars === bars}
                  className={score.bars === bars ? "active" : ""}
                  key={bars}
                  onClick={() => {
                    edit(
                      resizeScore(session.draft, bars),
                      "Change loop length",
                    );
                    setTargetBar(null);
                  }}
                >
                  {bars}
                  <span>{bars === 1 ? "bar" : "bars"}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="key-control">
            <label>
              Key{" "}
              <select
                aria-label="Musical key"
                disabled={!!sharedId || !!compared}
                value={score.key}
                onChange={(e) =>
                  edit(
                    { ...session.draft, key: Number(e.target.value) },
                    "Change key guide",
                  )
                }
              >
                {keys.map((key, i) => (
                  <option key={key} value={i}>
                    {key}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Scale{" "}
              <select
                aria-label="Musical scale"
                disabled={!!sharedId || !!compared}
                value={score.scale}
                onChange={(e) =>
                  edit(
                    {
                      ...session.draft,
                      scale: e.target.value as Score["scale"],
                    },
                    "Change scale guide",
                  )
                }
              >
                <option value="minor">Minor</option>
                <option value="major">Major</option>
                <option value="dorian">Dorian</option>
                <option value="pentatonic">Pentatonic</option>
              </select>
            </label>
          </div>
          <div className="master-control">
            <button
              onClick={() => setMasterMuted((m) => !m)}
              aria-label={masterMuted ? "Unmute master" : "Mute master"}
              aria-pressed={masterMuted}
            >
              {masterMuted ? <VolumeX size={17} /> : <Volume2 size={17} />}
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step=".01"
              value={master}
              onChange={(e) => setMaster(Number(e.target.value))}
              aria-label="Master volume"
            />
            <span>Master</span>
          </div>
        </div>
        <div className="ensemble">
          {score.tracks.map((t) => (
            <Instrument
              key={t.id}
              track={t}
              active={trackId === t.id}
              hit={hits[t.id]}
              protectedTrack={protectedTracks.includes(t.id)}
              disabled={!!sharedId || !!compared}
              onSelect={() => setTrackId(t.id)}
              onChange={changeTrack}
              onProtect={() => {
                cancelRequest();
                setProtectedTracks((p) =>
                  p.includes(t.id)
                    ? p.filter((id) => id !== t.id)
                    : [...p, t.id],
                );
              }}
            />
          ))}
        </div>
        <div className="sequence-area">
          <div className="sequence-heading">
            <div>
              <span className="panel-label">The sequence</span>
              <span className="subtle">
                A little structure. Endless possibilities.
              </span>
            </div>
            <button
              className="text-button"
              disabled={!!compared}
              onClick={() => setModal("settings")}
            >
              <Settings2 size={14} />
              Shape sound
            </button>
          </div>
          {compared && (
            <div className="compare-banner">
              Viewing “{compared.label}”{" "}
              <span>Playback follows the current composition.</span>
              <button onClick={() => setCompared(null)}>Back to current</button>
              <button
                onClick={() => {
                  edit(compared.score, "Restore version");
                  setModal(null);
                }}
              >
                Restore this version
              </button>
            </div>
          )}
          <Sequencer
            score={score}
            trackId={trackId}
            playing={session.playing && !compared}
            position={position}
            changedNotes={changedNotes}
            disabled={!!sharedId || !!compared}
            onTrack={setTrackId}
            onEdit={edit}
          />
        </div>
        <div className="conductor">
          <div className="conductor-heading">
            <span className="conductor-icon">
              <AudioLines size={19} />
            </span>
            <div>
              <h2>Your move, conductor.</h2>
              <span>
                {sharedId
                  ? "An immutable snapshot of one musical moment."
                  : "Tell the band where you want to go."}
              </span>
            </div>
            <div
              className={`ai-status ${access?.aiAvailable ? "available" : ""}`}
            >
              <span />
              {access?.aiAvailable ? "AI ready" : "Manual studio"}
            </div>
          </div>
          {!sharedId && (
            <>
              <form
                className={`direction-form ${busy ? "working" : ""}`}
                onSubmit={(e) => {
                  e.preventDefault();
                  void conduct();
                }}
              >
                <input
                  aria-label="Conducting direction"
                  disabled={!!compared}
                  value={direction}
                  maxLength={1200}
                  onChange={(e) => setDirection(e.target.value)}
                  placeholder="Keep the bass, but give the melody a little more room…"
                />
                <button
                  type={busy ? "button" : "submit"}
                  disabled={!busy && (!!compared || !direction.trim())}
                  onClick={
                    busy
                      ? () => {
                          cancelRequest();
                          flash(
                            "Conducting cancelled. Your music kept playing.",
                          );
                        }
                      : undefined
                  }
                  aria-label={
                    busy ? "Cancel conducting" : "Apply conducting direction"
                  }
                >
                  {busy ? <X size={18} /> : <Send size={17} />}
                  <span>{busy ? "Cancel" : "Conduct"}</span>
                </button>
              </form>
              <div className="conductor-bottom">
                <div className="prompt-suggestions">
                  {[
                    "Make the drums half as busy",
                    "Lift the melody an octave",
                    "Give the lead more space",
                  ].map((text) => (
                    <button
                      key={text}
                      disabled={!!compared}
                      onClick={() => setDirection(text)}
                    >
                      {text}
                    </button>
                  ))}
                </div>
                <button
                  className={`tempo-lock ${lockTempo ? "locked" : ""}`}
                  onClick={() => {
                    cancelRequest();
                    setLockTempo((v) => !v);
                  }}
                  aria-pressed={lockTempo}
                >
                  <LockKeyhole size={12} />
                  {lockTempo ? "Tempo protected" : "Tempo unlocked"}
                </button>
              </div>
              <div className="conductor-state" role="status">
                {busy ? (
                  <>
                    <LoaderCircle size={13} className="spin" />
                    Listening to your direction. The music keeps playing.
                  </>
                ) : session.pending ? (
                  <>
                    <Clock3 size={13} />
                    Changes queued · audible in {pendingSeconds.toFixed(1)}s
                  </>
                ) : lastDirection ? (
                  <>
                    <Check size={13} />
                    {lastDirection}
                  </>
                ) : (
                  <>
                    <span className="info-dot" />
                    {access?.aiAvailable
                      ? "Try a direction, or edit the notes above."
                      : "AI is not configured. All manual controls work; no simulated AI responses."}
                  </>
                )}
              </div>
            </>
          )}
          {sharedId && (
            <div className="shared-message">
              <LockKeyhole size={14} />
              This shared version stays exactly as its creator saved it.
            </div>
          )}
        </div>
        <div className="console-bottom">
          <span className="screw" />
          <div className="device-label">
            <span className={`power-led ${session.playing ? "on" : ""}`} />
            {session.playing ? "In the groove" : "Ready when you are"}
          </div>
          <div className="clock-readout">
            {session.playing
              ? `${String(Math.floor(Math.max(0, position) / 16) + 1).padStart(2, "0")} : ${String(Math.floor(Math.max(0, position) % 16) + 1).padStart(2, "0")}`
              : "— — : — —"}
          </div>
          <span className="device-meta">Three voices. One conversation.</span>
          <span className="screw" />
        </div>
      </main>
      <footer className="site-footer">
        <span>Made for the moments between ideas.</span>
        <div>
          <span className="keyboard-shortcut">space</span> Play / stop{" "}
          <span className="footer-separator" /> Procedurally synthesized · no
          samples
        </div>
      </footer>
      {notice && (
        <div className="toast" role="status">
          <span>{notice}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setNotice("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => void importFile(e.target.files?.[0])}
      />
      {access && !access.authenticated && !sharedId && (
        <Dialog
          title="Your private studio"
          onClose={() => {}}
          dismissible={false}
        >
          <p>Enter the studio password to compose, save and conduct.</p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api("/login", {
                  method: "POST",
                  body: JSON.stringify({ password }),
                });
                setAccess(await api<Access>("/session"));
                setPassword("");
                setAuthError("");
              } catch (error) {
                setAuthError((error as Error).message);
              }
            }}
          >
            <label className="form-field">
              Studio password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            {authError && (
              <p role="alert" className="error-message">
                {authError}
              </p>
            )}
            <button className="primary-action" type="submit">
              Open studio
            </button>
          </form>
        </Dialog>
      )}
      {modal === "library" && (
        <Dialog
          title="Find a starting point"
          onClose={() => {
            loadGeneration.current += 1;
            setLoadingId(null);
            setModal(null);
          }}
        >
          <p>Three original sketches. Take any of them somewhere new.</p>
          <div className="example-list">
            {EXAMPLES.map((example, i) => (
              <button
                className={`example-choice example-${i}`}
                key={example.id}
                onClick={() => load(freshExample(i))}
              >
                <span className="example-art">
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
                <span>
                  <strong>{example.title}</strong>
                  <small>{example.subtitle}</small>
                </span>
                <span>
                  {example.score.bpm}
                  <small>bpm</small>
                </span>
                <Play size={15} />
              </button>
            ))}
          </div>
          {saved.length > 0 && (
            <>
              <h3>Your compositions</h3>
              <div className="saved-list">
                {saved.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => void loadSaved(item.id)}
                    aria-busy={loadingId === item.id}
                  >
                    {loadingId === item.id ? (
                      <LoaderCircle size={17} className="spin" />
                    ) : (
                      <FolderOpen size={17} />
                    )}
                    <span>{item.title}</span>
                    <small>
                      {new Date(item.updatedAt).toLocaleDateString()}
                    </small>
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="dialog-actions">
            <button onClick={() => fileInput.current?.click()}>
              <ArrowUpFromLine size={15} />
              Import JSON
            </button>
            <button
              onClick={() => {
                const empty = freshExample();
                empty.title = "Untitled idea";
                empty.tracks = empty.tracks.map((t) => ({ ...t, notes: [] }));
                load(empty);
              }}
            >
              <Plus size={15} />
              Blank canvas
            </button>
          </div>
        </Dialog>
      )}
      {modal === "versions" && (
        <Dialog title="Every idea has a history" onClose={() => setModal(null)}>
          <p>
            Compare a previous version visually, then restore it when you’re
            ready.
          </p>
          <div className="version-list">
            {[...session.history].reverse().map((entry, i) => (
              <div key={entry.id}>
                <span className={`version-dot ${i === 0 ? "current" : ""}`} />
                <div>
                  <strong>{entry.label}</strong>
                  {entry.direction && <p>“{entry.direction}”</p>}
                  <small>
                    {new Date(entry.at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    {i === 0 ? " · Current version" : ""}
                  </small>
                </div>
                <button
                  onClick={() => {
                    setCompared(entry);
                    setModal(null);
                  }}
                >
                  Compare
                </button>
              </div>
            ))}
          </div>
          {directionHistory.length > 0 && (
            <p className="subtle">
              {directionHistory.length} accepted conducting directions
            </p>
          )}
        </Dialog>
      )}
      {modal === "export" && (
        <Dialog title="Take your music with you" onClose={() => setModal(null)}>
          <p>
            JSON preserves every note and instrument setting. WAV renders four
            complete loops.
          </p>
          <div className="export-options">
            <button
              onClick={() => {
                download(
                  new Blob([JSON.stringify(session.draft, null, 2)], {
                    type: "application/json",
                  }),
                  `${session.draft.title}.json`,
                );
                flash("Composition exported as JSON.");
              }}
            >
              <span className="file-type">JSON</span>
              <strong>Editable composition</strong>
              <small>Bring it back to the studio anytime.</small>
              <ArrowDownToLine size={18} />
            </button>
            <button
              disabled={exporting}
              onClick={async () => {
                setExporting(true);
                try {
                  const wav = await exportWav(session.draft, 4);
                  download(wav, `${session.draft.title}.wav`);
                  flash("Four loops rendered to WAV.");
                } catch (error) {
                  flash((error as Error).message);
                } finally {
                  setExporting(false);
                }
              }}
            >
              <span className="file-type">WAV</span>
              <strong>
                {exporting ? "Rendering your music…" : "Stereo audio"}
              </strong>
              <small>44.1 kHz · 16-bit · four loops</small>
              {exporting ? (
                <LoaderCircle className="spin" size={18} />
              ) : (
                <ArrowDownToLine size={18} />
              )}
            </button>
          </div>
        </Dialog>
      )}
      {modal === "share" && (
        <Dialog title="A musical postcard" onClose={() => setModal(null)}>
          <p>
            This link opens a read-only snapshot. Future edits won’t change it,
            and visitors choose when to press Play.
          </p>
          <label className="form-field">
            Share link
            <input
              readOnly
              value={shareUrl}
              onFocus={(e) => e.target.select()}
            />
          </label>
          <button
            className="primary-action"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(shareUrl);
                flash("Share link copied.");
              } catch {
                flash("Select and copy the link above.");
              }
            }}
          >
            Copy link
          </button>
          <p className="subtle">
            For other people to open it, the studio server must be hosted at a
            reachable address.
          </p>
        </Dialog>
      )}
      {modal === "settings" && (
        <Dialog
          title={`Shape ${track.name.toLowerCase()}`}
          onClose={() => setModal(null)}
        >
          <p>
            {PRESETS[trackId].find((p) => p.id === track.preset)?.description}
          </p>
          <label className="form-field">
            Brightness
            <input
              disabled={!!sharedId || !!compared}
              aria-label="Instrument brightness"
              type="range"
              min="0"
              max="1"
              step=".01"
              value={track.params.brightness}
              onChange={(e) =>
                changeTrack(
                  {
                    ...track,
                    params: {
                      ...track.params,
                      brightness: Number(e.target.value),
                    },
                  },
                  `${track.name} brightness`,
                )
              }
            />
          </label>
          <label className="form-field">
            Decay
            <input
              disabled={!!sharedId || !!compared}
              aria-label="Instrument decay"
              type="range"
              min="0"
              max="1"
              step=".01"
              value={track.params.decay}
              onChange={(e) =>
                changeTrack(
                  {
                    ...track,
                    params: { ...track.params, decay: Number(e.target.value) },
                  },
                  `${track.name} decay`,
                )
              }
            />
          </label>
          {!sharedId && (
            <label className="form-field">
              Conducting scope
              <select
                value={targetBar ?? "all"}
                onChange={(e) => {
                  cancelRequest();
                  setTargetBar(
                    e.target.value === "all" ? null : Number(e.target.value),
                  );
                }}
              >
                <option value="all">All bars</option>
                {Array.from({ length: score.bars }, (_, i) => (
                  <option key={i} value={i + 1}>
                    Only bar {i + 1}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="subtle">
            Sound changes join at the next available loop. Track locks protect
            the whole track from AI edits.
          </p>
        </Dialog>
      )}
      {modal === "help" && (
        <Dialog
          title="Welcome to your little studio"
          onClose={() => setModal(null)}
        >
          <ol className="help-steps">
            <li>
              <strong>Start somewhere.</strong> Open the composition menu for
              three original sketches, or a blank canvas.
            </li>
            <li>
              <strong>Press Play.</strong> The drum pads, speaker and keys
              respond to the notes you hear.
            </li>
            <li>
              <strong>Make it yours.</strong> Tap drum steps. In the bass or
              lead editor, click to add notes, then change their pitch, length
              and velocity. Shift-click a drum to edit its velocity. A new or
              resized note replaces overlapping notes in that lane. Arrow keys
              navigate; Delete removes a note.
            </li>
            <li>
              <strong>Conduct with words.</strong> When an API key is
              configured, describe a change. Lock tracks to keep them untouched.
              Accepted changes are explained and highlighted.
            </li>
            <li>
              <strong>Keep the good ideas.</strong> Undo cancels unheard changes
              first. Save keeps your history. Share creates a permanent
              snapshot.
            </li>
          </ol>
          <p className="subtle">
            Edits join at a loop boundary. Switching tabs pauses playback
            safely; press Play to restart from the beginning. Key and scale
            guide the grid without transposing existing notes.
          </p>
        </Dialog>
      )}
    </div>
  );
}
