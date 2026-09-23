import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { Score, HistoryEntry, SavedComposition } from "../shared/types";
import { HttpError } from "./errors";

type CompositionRow = {
  id: string;
  title: string;
  updated_at: string;
  score: string;
  history: string;
};

export class CompositionStore {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS compositions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at TEXT NOT NULL,
        score TEXT NOT NULL, history TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shares (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, score TEXT NOT NULL
      );
    `);
  }
  list() {
    return this.db
      .prepare(
        "SELECT id, title, updated_at AS updatedAt FROM compositions ORDER BY updated_at DESC",
      )
      .all();
  }
  get(id: string): SavedComposition | null {
    const row = this.db
      .prepare("SELECT * FROM compositions WHERE id = ?")
      .get(id) as CompositionRow | undefined;
    return row
      ? {
          id: row.id,
          title: row.title,
          updatedAt: row.updated_at,
          score: JSON.parse(row.score),
          history: JSON.parse(row.history),
        }
      : null;
  }
  save(
    score: Score,
    history: HistoryEntry[],
    update: boolean,
  ): SavedComposition {
    const exists = !!this.db
      .prepare("SELECT id FROM compositions WHERE id = ?")
      .get(score.id);
    if (update && !exists)
      throw new HttpError(404, "NOT_FOUND", "Composition not found.");
    if (!update && exists)
      throw new HttpError(
        409,
        "ALREADY_EXISTS",
        "This composition is already saved. Update it instead.",
      );
    const updatedAt = new Date().toISOString();
    if (update)
      this.db
        .prepare(
          "UPDATE compositions SET title = ?, updated_at = ?, score = ?, history = ? WHERE id = ?",
        )
        .run(
          score.title,
          updatedAt,
          JSON.stringify(score),
          JSON.stringify(history),
          score.id,
        );
    else
      this.db
        .prepare(
          "INSERT INTO compositions (id, title, updated_at, score, history) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          score.id,
          score.title,
          updatedAt,
          JSON.stringify(score),
          JSON.stringify(history),
        );
    return { id: score.id, title: score.title, updatedAt, score, history };
  }
  share(score: Score): string {
    const id = randomBytes(18).toString("base64url");
    this.db
      .prepare("INSERT INTO shares (id, created_at, score) VALUES (?, ?, ?)")
      .run(id, new Date().toISOString(), JSON.stringify(score));
    return id;
  }
  getShare(id: string): { score: Score; createdAt: string } | null {
    const row = this.db
      .prepare("SELECT score, created_at FROM shares WHERE id = ?")
      .get(id) as { score: string; created_at: string } | undefined;
    return row
      ? { score: JSON.parse(row.score), createdAt: row.created_at }
      : null;
  }
  close() {
    this.db.close();
  }
}
