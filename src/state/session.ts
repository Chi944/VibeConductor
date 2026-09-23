import type { HistoryEntry, Score } from "../../shared/types";

export interface Session {
  draft: Score;
  sounding: Score;
  pending: Score | null;
  playing: boolean;
  history: HistoryEntry[];
  committed: HistoryEntry[];
  cursor: number;
  generation: number;
}
export function revision(score: Score): Score {
  return { ...structuredClone(score), revisionId: crypto.randomUUID() };
}
export function createSession(score: Score, history?: HistoryEntry[]): Session {
  const entries = history?.length
    ? structuredClone(history)
    : [
        {
          id: score.revisionId,
          score: structuredClone(score),
          label: "Starting point",
          at: new Date().toISOString(),
        },
      ];
  if (JSON.stringify(entries.at(-1)?.score) !== JSON.stringify(score)) {
    entries.push({
      id: score.revisionId,
      score: structuredClone(score),
      label: "Recovered current version",
      at: new Date().toISOString(),
    });
  }
  return {
    draft: score,
    sounding: score,
    pending: null,
    playing: false,
    history: entries,
    committed: entries,
    cursor: entries.length - 1,
    generation: 0,
  };
}
export function editSession(
  state: Session,
  score: Score,
  label: string,
  direction?: string,
): Session {
  const next = revision(score);
  const history = [
    ...state.history.slice(0, state.cursor + 1),
    {
      id: next.revisionId,
      score: next,
      label,
      direction,
      at: new Date().toISOString(),
    },
  ].slice(-100);
  return {
    ...state,
    draft: next,
    sounding: state.playing ? state.sounding : next,
    pending: state.playing ? next : null,
    history,
    committed: state.playing ? state.committed : history,
    cursor: history.length - 1,
    generation: state.generation + 1,
  };
}
export function soundingSession(state: Session, score: Score): Session {
  const index = state.history.findIndex(
    (entry) => entry.score.revisionId === score.revisionId,
  );
  const committed =
    index >= 0
      ? state.history.slice(0, index + 1)
      : [
          ...state.committed,
          {
            id: score.revisionId,
            score,
            label: "Playing version",
            at: new Date().toISOString(),
          },
        ];
  return {
    ...state,
    sounding: score,
    committed,
    pending: state.draft.revisionId === score.revisionId ? null : state.draft,
  };
}
export function stopSession(state: Session): Session {
  return {
    ...state,
    playing: false,
    sounding: state.draft,
    pending: null,
    committed: state.history,
  };
}
export function undoSession(state: Session): Session {
  // A queued batch is cancelled as a unit before any already audible history.
  if (state.pending) {
    const next = revision(state.sounding);
    const history = [...state.committed];
    history[history.length - 1] = {
      ...history[history.length - 1],
      id: next.revisionId,
      score: next,
    };
    return {
      ...state,
      draft: next,
      sounding: next,
      pending: null,
      history,
      committed: history,
      cursor: history.length - 1,
      generation: state.generation + 1,
    };
  }
  if (state.cursor <= 0) return { ...state, generation: state.generation + 1 };
  const cursor = state.cursor - 1;
  const next = revision(state.history[cursor].score);
  const history = state.history.slice(0, cursor + 1);
  history[cursor] = { ...history[cursor], id: next.revisionId, score: next };
  return {
    ...state,
    draft: next,
    sounding: state.playing ? state.sounding : next,
    pending: state.playing ? next : null,
    history,
    committed: state.playing ? state.committed : history,
    cursor,
    generation: state.generation + 1,
  };
}
export function responseIsCurrent(
  state: Session,
  baseRevisionId: string,
  generation: number,
): boolean {
  return (
    state.draft.revisionId === baseRevisionId && state.generation === generation
  );
}
