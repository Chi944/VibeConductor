import { config as loadEnvironment } from "dotenv";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { EXAMPLES } from "../shared/examples";
import { applyProposal, parseConstraints } from "../shared/edits";
import { parseScore } from "../shared/score";
import type {
  ConductResult,
  EditConstraints,
  Score,
  TrackId,
} from "../shared/types";
import { loadConfig } from "../server/config";
import { Conductor, createOpenAIProvider } from "../server/conduct";
import fixtures from "../tests/fixtures/conduct-evaluation.json";

interface Expectation {
  unchangedTracks?: TrackId[];
  lowerBrightness?: TrackId;
  noteCountAtMostRatio?: { track: TrackId; ratio: number };
  fewerNotes?: TrackId;
  sameTempo?: boolean;
  tempo?: number;
  onlyBar?: number;
  softerSnare?: boolean;
  addedKickAt?: number;
  reject?: boolean;
}
const defaults: EditConstraints = {
  protectedTracks: [],
  lockTempo: false,
  targetBar: null,
  fewerNotes: [],
};
loadEnvironment({ quiet: true });
const config = loadConfig({
  ...process.env,
  NODE_ENV: "development",
  HOST: "127.0.0.1",
  APP_ORIGIN: undefined,
  OWNER_PASSWORD: undefined,
  SESSION_SECRET: undefined,
});
const liveRequested = process.argv.includes("--live");
const provider = liveRequested ? createOpenAIProvider(config) : null;
const conductor = new Conductor(config, provider);
const outputIndex = process.argv.indexOf("--output");
if (outputIndex >= 0 && !process.argv[outputIndex + 1])
  throw new Error("--output needs a file path.");

/** Hand-authored outcome checks do not reuse the constraint parser being evaluated. */
function gradeMusicalResult(
  before: Score,
  after: Score,
  expectation: Expectation,
): string[] {
  const failures: string[] = [];
  const track = (score: Score, id: TrackId) =>
    score.tracks.find((t) => t.id === id)!;
  for (const id of expectation.unchangedTracks || [])
    if (!isDeepStrictEqual(track(before, id), track(after, id)))
      failures.push(`${id} changed outside requested scope`);
  if (
    expectation.lowerBrightness &&
    track(after, expectation.lowerBrightness).params.brightness >=
      track(before, expectation.lowerBrightness).params.brightness
  )
    failures.push("brightness did not decrease");
  if (expectation.noteCountAtMostRatio) {
    const { track: id, ratio } = expectation.noteCountAtMostRatio;
    if (
      track(after, id).notes.length >
      Math.floor(track(before, id).notes.length * ratio)
    )
      failures.push("note count exceeds requested ratio");
  }
  if (
    expectation.fewerNotes &&
    track(after, expectation.fewerNotes).notes.length >=
      track(before, expectation.fewerNotes).notes.length
  )
    failures.push("note count did not decrease");
  if (expectation.sameTempo && after.bpm !== before.bpm)
    failures.push("tempo changed");
  if (expectation.tempo !== undefined && after.bpm !== expectation.tempo)
    failures.push("requested tempo not applied");
  if (expectation.onlyBar) {
    const start = (expectation.onlyBar - 1) * 16;
    const end = start + 16;
    for (const id of ["drums", "bass", "lead"] as TrackId[]) {
      const outside = (score: Score) =>
        track(score, id).notes.filter(
          (note) => note.start < start || note.start + note.duration > end,
        );
      if (!isDeepStrictEqual(outside(before), outside(after)))
        failures.push(`notes outside bar ${expectation.onlyBar} changed`);
    }
  }
  if (expectation.softerSnare) {
    const snareEnergy = (score: Score) =>
      track(score, "drums")
        .notes.filter((note) => note.drum === "snare" && note.start >= 16)
        .reduce((sum, note) => sum + note.velocity, 0);
    if (snareEnergy(after) >= snareEnergy(before))
      failures.push("second-bar snare velocity did not decrease");
  }
  if (
    expectation.addedKickAt !== undefined &&
    !track(after, "drums").notes.some(
      (note) =>
        note.drum === "kick" &&
        note.start === expectation.addedKickAt &&
        note.velocity <= 0.6,
    )
  )
    failures.push("gentle kick missing at requested step");
  return failures;
}

const results: Record<string, unknown>[] = [];
for (const fixture of fixtures) {
  const base = structuredClone(EXAMPLES[0].score);
  parseScore(base);
  const parsed = parseConstraints(fixture.direction, defaults);
  const constraintsPass = isDeepStrictEqual(
    parsed,
    fixture.expectedConstraints,
  );
  const row: Record<string, unknown> = {
    id: fixture.id,
    constraintExtraction: constraintsPass ? "pass" : "fail",
    expectedConstraints: fixture.expectedConstraints,
    actualConstraints: parsed,
  };
  if (!provider) {
    row.live = "skipped";
    row.reason = liveRequested
      ? "OPENAI_API_KEY is not configured"
      : "Live calls require explicit --live";
  } else {
    const started = performance.now();
    const outcome = await conductor.conduct(
      "evaluation",
      {
        requestId: `eval-${fixture.id}-${Date.now()}`,
        direction: fixture.direction,
        score: base,
        constraints: defaults,
      },
      new AbortController().signal,
    );
    row.latencyMs = Math.round(performance.now() - started);
    const expectation = fixture.expectation as Expectation;
    if (outcome.status === 200) {
      const data = outcome.body as ConductResult;
      row.usage = data.usage;
      if (expectation.reject) {
        row.live = "fail";
        row.failures = ["non-musical injection was accepted as a musical edit"];
      } else {
        try {
          const after = applyProposal(
            base,
            data.proposal,
            fixture.expectedConstraints as EditConstraints,
          );
          const failures = gradeMusicalResult(base, after, expectation);
          row.live = failures.length ? "fail" : "pass";
          row.failures = failures;
        } catch {
          row.live = "fail";
          row.failures = [
            "proposal failed independently specified hard constraints",
          ];
        }
      }
    } else {
      row.live = expectation.reject && outcome.status === 422 ? "pass" : "fail";
      row.status = outcome.status;
      row.error = outcome.body;
      row.usage = null; // A failed response may still be billable; do not pretend it was free.
    }
  }
  results.push(row);
}
const liveRows = results.filter((row) => row.live !== "skipped");
const report = {
  createdAt: new Date().toISOString(),
  model: config.model,
  kind: provider ? "live-provider-evaluation" : "offline-constraint-checks",
  summary: {
    cases: results.length,
    constraintChecksPassed: results.filter(
      (row) => row.constraintExtraction === "pass",
    ).length,
    liveCasesRun: liveRows.length,
    liveCasesPassed: liveRows.filter((row) => row.live === "pass").length,
    liveCasesSkipped: results.length - liveRows.length,
  },
  limitations: [
    "No automated result establishes musical taste or perceptual sound quality.",
    "Usage is recorded only when returned successfully by the provider. Failed requests may have unreported cost.",
    "Cost is an estimate at configured rates; cached-input discounts are excluded.",
  ],
  results,
};
const text = `${JSON.stringify(report, null, 2)}\n`;
if (outputIndex >= 0) {
  const destination = resolve(process.argv[outputIndex + 1]);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, text, "utf8");
}
process.stdout.write(text);
if (
  results.some(
    (row) => row.constraintExtraction === "fail" || row.live === "fail",
  )
)
  process.exitCode = 1;
