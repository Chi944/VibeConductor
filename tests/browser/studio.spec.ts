import { readFile } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { ConductRequest, ConductResult, Score } from "../../shared/types";

type ProbeSource = {
  node: AudioScheduledSourceNode;
  starts: number[];
  stops: number[];
};
type ProbeContext = {
  context: AudioContext;
  sources: ProbeSource[];
  analyser?: AnalyserNode;
};
declare global {
  interface Window {
    __audioProbe: ProbeContext[];
    __releaseAudio?: () => void;
  }
}

/** Observes native audio; no musical state or engine functions are replaced. */
async function observeAudio(page: Page) {
  await page.addInitScript(() => {
    window.__audioProbe = [];
    const NativeContext = window.AudioContext;
    window.AudioContext = class extends NativeContext {
      constructor(options?: AudioContextOptions) {
        super(options);
        const record: ProbeContext = { context: this, sources: [] };
        window.__audioProbe.push(record);
        const observe = <T extends AudioScheduledSourceNode>(source: T): T => {
          const item: ProbeSource = { node: source, starts: [], stops: [] };
          record.sources.push(item);
          const start = source.start.bind(source);
          const stop = source.stop.bind(source);
          source.start = (when = 0) => {
            item.starts.push(when);
            start(when);
          };
          source.stop = (when = 0) => {
            item.stops.push(when);
            stop(when);
          };
          return source;
        };
        const oscillator = this.createOscillator.bind(this);
        const bufferSource = this.createBufferSource.bind(this);
        this.createOscillator = () => observe(oscillator());
        this.createBufferSource = () => observe(bufferSource());
        const compressor = this.createDynamicsCompressor.bind(this);
        this.createDynamicsCompressor = () => {
          const node = compressor();
          const analyser = this.createAnalyser();
          analyser.fftSize = 1024;
          node.connect(analyser);
          record.analyser = analyser;
          return node;
        };
      }
    };
  });
}

const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  errors.set(page, []);
  page.on("pageerror", (error) => errors.get(page)!.push(error.message));
  await observeAudio(page);
});
test.afterEach(async ({ page }) => {
  expect(errors.get(page), "No uncaught browser errors").toEqual([]);
});

async function studio(page: Page) {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(
    page.getByRole("main", { name: "VibeConductor studio" }),
  ).toBeVisible();
}
async function shortLoop(page: Page) {
  await page.getByRole("button", { name: "1 bar loop", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Tempo BPM" }).fill("160");
}
async function jsonExport(page: Page): Promise<Score> {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: /JSON Editable composition/ }).click();
  const downloaded = await downloading;
  const path = await downloaded.path();
  expect(path).toBeTruthy();
  const result = JSON.parse(await readFile(path!, "utf8")) as Score;
  await page.getByRole("button", { name: "Close dialog" }).click();
  return result;
}
async function audioTime(page: Page) {
  return page.evaluate(
    () => window.__audioProbe.at(-1)?.context.currentTime ?? 0,
  );
}

test("user gesture starts real sound and sound-driven animation; Stop clears sources", async ({
  page,
}) => {
  await studio(page);
  expect(await page.evaluate(() => window.__audioProbe.length)).toBe(0);
  await expect(page.locator(".instrument-physical.sounding")).toHaveCount(0);
  await page.getByRole("button", { name: "Play composition" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__audioProbe.at(-1)?.context.state))
    .toBe("running");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const analyser = window.__audioProbe.at(-1)?.analyser;
        if (!analyser) return 0;
        const samples = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(samples);
        return Math.max(...samples.map((value) => Math.abs(value)));
      }),
    )
    .toBeGreaterThan(0.001);
  await expect(
    page.locator(".instrument-physical.sounding").first(),
  ).toBeVisible();
  await expect(page.locator(".step-cell.playhead").first()).toBeVisible();
  await page.getByRole("button", { name: "Stop playback" }).click();
  await expect(
    page.getByRole("button", { name: "Play composition" }),
  ).toBeVisible();
  await expect(page.locator(".instrument-physical.sounding")).toHaveCount(0);
  const ownership = await page.evaluate(() => {
    const record = window.__audioProbe.at(-1)!;
    return record.sources.map((item) => ({
      stop: item.stops.at(-1),
      start: item.starts[0],
      now: record.context.currentTime,
    }));
  });
  expect(ownership.length).toBeGreaterThan(0);
  expect(ownership.every((item) => item.stop! <= item.now + 0.025)).toBe(true);
});

test("Undo retracts an unheard loop already submitted to native audio", async ({
  page,
}) => {
  await studio(page);
  await shortLoop(page);
  const step = page.getByRole("gridcell", { name: /^Kick, step 2(?:,|$)/ });
  await expect(step).toHaveAttribute("aria-selected", "false");
  await page.getByRole("button", { name: "Play composition" }).click();
  await step.click();
  await expect(step).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText(/Changes queued/)).toBeVisible();
  // Execute the normal button event within the short lookahead window. Waiting
  // for a roundtrip to the test process could itself miss this 100ms boundary.
  const cancelled = await page.evaluate(
    () =>
      new Promise<{ future: number; retracted: number }>((resolve, reject) => {
        const record = window.__audioProbe.at(-1)!;
        const initial = Math.min(
          ...record.sources.flatMap((item) => item.starts),
        );
        const boundary = initial + 1.5;
        const check = () => {
          const future = record.sources.filter(
            (item) =>
              item.starts[0]! >= boundary - 0.001 &&
              item.starts[0]! < boundary + 0.02,
          );
          if (future.length && record.context.currentTime < boundary) {
            document
              .querySelector<HTMLButtonElement>(
                '[aria-label="Undo last change"]',
              )!
              .click();
            setTimeout(
              () =>
                resolve({
                  future: future.length,
                  retracted: future.filter(
                    (item) => item.stops.at(-1)! < item.starts[0]!,
                  ).length,
                }),
              0,
            );
          } else if (record.context.currentTime > boundary + 0.1)
            reject(new Error("Missed the queued loop scheduling window."));
          else setTimeout(check, 3);
        };
        check();
      }),
  );
  expect(cancelled.future).toBeGreaterThan(0);
  expect(cancelled.retracted).toBe(cancelled.future);
  await expect(step).toHaveAttribute("aria-selected", "false");
  await expect(page.getByText(/Queued changes cancelled/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Stop playback" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop playback" }).click();
});

test("composition saves with history, recovers after reload, and roundtrips JSON", async ({
  page,
}) => {
  await studio(page);
  const title = `Browser composition ${Date.now()}`;
  await page.getByRole("textbox", { name: "Composition title" }).fill(title);
  const step = page.getByRole("gridcell", { name: /^Kick, step 2(?:,|$)/ });
  await step.click();
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/compositions") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const body = await (await saved).json();
  expect(body.score.title).toBe(title);
  expect(body.history.length).toBeGreaterThan(1);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("vibeconductor:draft:v1") || "{}")
            .score?.title,
      ),
    )
    .toBe(title);
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(
    page.getByRole("textbox", { name: "Composition title" }),
  ).toHaveValue(title);
  await expect(step).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Open compositions" }).click();
  await page.getByRole("button", { name: new RegExp(title) }).click();
  const exported = await jsonExport(page);
  expect(exported).toEqual(body.score);
  await page
    .locator("input[type=file]")
    .setInputFiles({
      name: "roundtrip.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(exported)),
    });
  await expect(page.getByText("Composition imported.")).toBeVisible();
  const imported = await jsonExport(page);
  expect(imported.tracks).toEqual(exported.tracks);
  expect(imported.id).not.toBe(exported.id);
  expect(imported.revisionId).not.toBe(exported.revisionId);
});

test("shared snapshots are immutable, read-only, and initially silent", async ({
  page,
  context,
}) => {
  await studio(page);
  const original = await jsonExport(page);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const shareLink = page.getByRole("textbox", { name: "Share link" });
  await expect(shareLink).toHaveValue(/\/s\/[a-zA-Z0-9_-]{24}$/);
  const url = await shareLink.inputValue();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page
    .getByRole("textbox", { name: "Composition title" })
    .fill("Changed after sharing");
  await page.getByRole("gridcell", { name: /^Kick, step 2(?:,|$)/ }).click();
  const shared = await context.newPage();
  await observeAudio(shared);
  await shared.goto(url);
  await shared.waitForLoadState("networkidle");
  await expect(shared.getByText(original.title, { exact: true })).toBeVisible();
  await expect(
    shared.getByText("Read-only snapshot · press Play to listen"),
  ).toBeVisible();
  await expect(shared.getByRole("gridcell").first()).toBeDisabled();
  await expect(
    shared.getByRole("button", { name: "Save", exact: true }),
  ).toHaveCount(0);
  expect(await shared.evaluate(() => window.__audioProbe.length)).toBe(0);
  expect(await jsonExport(shared)).toEqual(original);
  await shared.getByRole("button", { name: "Play composition" }).click();
  await expect(
    shared.getByRole("button", { name: "Stop playback" }),
  ).toBeVisible();
  await shared.close();
});

test("WAV export renders actual stereo audio with four complete loops", async ({
  page,
}) => {
  await studio(page);
  await shortLoop(page);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: /WAV Stereo audio/ }).click();
  const download = await downloading;
  const wav = await readFile((await download.path())!);
  expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
  expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
  expect(wav.readUInt16LE(22)).toBe(2);
  expect(wav.readUInt32LE(24)).toBe(44100);
  expect(wav.readUInt16LE(34)).toBe(16);
  const seconds = wav.readUInt32LE(40) / 44100 / 4;
  expect(seconds).toBeCloseTo(6.05, 2);
  let max = 0;
  let squared = 0;
  for (let offset = 44; offset < wav.length; offset += 2) {
    const sample = wav.readInt16LE(offset) / 32768;
    max = Math.max(max, Math.abs(sample));
    squared += sample * sample;
  }
  expect(max).toBeGreaterThan(0.02);
  expect(max).toBeLessThan(0.99);
  expect(Math.sqrt(squared / ((wav.length - 44) / 2))).toBeGreaterThan(0.005);
  expect(
    await page.evaluate(() => window.__audioProbe.length),
    "Offline export never creates a live audio context",
  ).toBe(0);
});

test("mock delayed AI response never blocks sound and is discarded after a newer edit", async ({
  page,
}) => {
  test
    .info()
    .annotations.push({
      type: "mock",
      description:
        "Only /api/session and /api/conduct are mocked; this does not evaluate a live AI model.",
    });
  await page.route("**/api/session", (route) =>
    route.fulfill({
      json: { authenticated: true, localMode: true, aiAvailable: true },
    }),
  );
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let received!: () => void;
  const requested = new Promise<void>((resolve) => {
    received = resolve;
  });
  await page.route("**/api/conduct", async (route) => {
    const input = route.request().postDataJSON() as ConductRequest;
    received();
    await waiting;
    const body: ConductResult = {
      requestId: input.requestId,
      proposal: {
        baseRevisionId: input.score.revisionId,
        explanation: "Mock response that must not be applied.",
        operations: [
          {
            type: "setTrack",
            trackId: "lead",
            preset: null,
            volume: null,
            brightness: 0.01,
            decay: null,
          },
        ],
      },
      usage: {
        inputTokens: 10,
        outputTokens: 10,
        latencyMs: 1000,
        model: "test-mock",
        estimatedCostUsd: null,
      },
    };
    await route.fulfill({ json: body });
  });
  await studio(page);
  await shortLoop(page);
  await page.getByRole("button", { name: "Play composition" }).click();
  await page
    .getByRole("textbox", { name: "Conducting direction" })
    .fill("Make the lead softer");
  await page
    .getByRole("button", { name: "Apply conducting direction" })
    .click();
  await requested;
  const before = await audioTime(page);
  await expect(
    page.getByText("Listening to your direction. The music keeps playing."),
  ).toBeVisible();
  await expect.poll(() => audioTime(page)).toBeGreaterThan(before + 0.7);
  await expect(
    page.getByRole("button", { name: "Stop playback" }),
  ).toBeVisible();
  await page.getByRole("gridcell", { name: /^Kick, step 2(?:,|$)/ }).click();
  release();
  await expect(
    page.getByText(/That response was based on an older version/),
  ).toBeVisible();
  await expect(
    page.getByRole("gridcell", { name: /^Kick, step 2(?:,|$)/ }),
  ).toHaveAttribute("aria-selected", "true");
  const after = await jsonExport(page);
  expect(
    after.tracks.find((track) => track.id === "lead")!.params.brightness,
  ).not.toBe(0.01);
  await expect(
    page.getByRole("button", { name: "Stop playback" }),
  ).toBeVisible();
});

test("suspension and simulated tab hiding safely stop playback until Play", async ({
  page,
}) => {
  await studio(page);
  await page.getByRole("button", { name: "Play composition" }).click();
  await page.evaluate(() => window.__audioProbe.at(-1)!.context.suspend());
  await expect(
    page.getByRole("button", { name: "Play composition" }),
  ).toBeVisible();
  await expect(page.getByText(/audio was interrupted/)).toBeVisible();
  await page.getByRole("button", { name: "Play composition" }).click();
  test
    .info()
    .annotations.push({
      type: "simulation",
      description:
        "visibilitychange is dispatched with document.hidden overridden; actual OS tab-background behavior remains a manual check.",
    });
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    Reflect.deleteProperty(document, "hidden");
  });
  await expect(
    page.getByRole("button", { name: "Play composition" }),
  ).toBeVisible();
  await expect(page.getByText(/tab was hidden/)).toBeVisible();
  await page.getByRole("button", { name: "Play composition" }).click();
  await expect(
    page.getByRole("button", { name: "Stop playback" }),
  ).toBeVisible();
});

test("edits made during a delayed native audio resume become the first sounding draft", async ({
  page,
}) => {
  test
    .info()
    .annotations.push({
      type: "simulation",
      description:
        "Delays resolution of native AudioContext.resume() to reproduce a browser-permission race; actual synthesis remains native.",
    });
  await studio(page);
  await shortLoop(page);
  await page.evaluate(() => {
    const nativeResume = AudioContext.prototype.resume;
    AudioContext.prototype.resume = async function () {
      await nativeResume.call(this);
      await new Promise<void>((resolve) => {
        window.__releaseAudio = resolve;
      });
    };
  });
  await page.getByRole("button", { name: "Play composition" }).click();
  await page.getByRole("gridcell", { name: /^Kick, step 2(?:,|$)/ }).click();
  expect(
    await page.evaluate(() => window.__audioProbe.at(-1)!.sources.length),
  ).toBe(0);
  await page.evaluate(() => window.__releaseAudio!());
  await expect
    .poll(() => page.evaluate(() => window.__audioProbe.at(-1)!.sources.length))
    .toBeGreaterThan(0);
  await expect(page.getByText(/Changes queued/)).toHaveCount(0);
  const onset = await page.evaluate(() =>
    Math.min(
      ...window.__audioProbe.at(-1)!.sources.flatMap((item) => item.starts),
    ),
  );
  await expect
    .poll(() =>
      page.evaluate(
        (first) =>
          window.__audioProbe
            .at(-1)!
            .sources.some(
              (item) =>
                Math.abs(item.starts[0]! - first - 60 / 160 / 4) < 0.001,
            ),
        onset,
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Stop playback" }).click();
  await page.getByRole("button", { name: "Play composition" }).click();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    window.__releaseAudio!();
    Reflect.deleteProperty(document, "hidden");
  });
  await expect(
    page.getByRole("button", { name: "Play composition" }),
  ).toBeVisible();
  await expect(page.getByText(/tab was hidden/)).toBeVisible();
});

test("manual mode is honest, keyboard grid works, and critical accessibility checks pass", async ({
  page,
}) => {
  await studio(page);
  await expect(page.getByText("Manual studio", { exact: true })).toBeVisible();
  let calledAI = false;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/conduct")) calledAI = true;
  });
  await page
    .getByRole("textbox", { name: "Conducting direction" })
    .fill("Make it warmer");
  await page
    .getByRole("button", { name: "Apply conducting direction" })
    .click();
  await expect(
    page.getByText(
      "AI conducting is not configured. The sequencer, instruments and saving are ready to use.",
    ),
  ).toBeVisible();
  expect(calledAI).toBe(false);
  const first = page.getByRole("gridcell", { name: /^Kick, step 1(?:,|$)/ });
  await first.focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("gridcell", { name: /^Kick, step 2(?:,|$)/ }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("gridcell", { name: /^Kick, step 2(?:,|$)/ }),
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Delete");
  await expect(
    page.getByRole("gridcell", { name: /^Kick, step 2(?:,|$)/ }),
  ).toHaveAttribute("aria-selected", "false");
  const results = await new AxeBuilder({ page }).analyze();
  await test
    .info()
    .attach("studio-accessibility.json", {
      body: JSON.stringify(results.violations, null, 2),
      contentType: "application/json",
    });
  const serious = results.violations.filter((item) =>
    ["critical", "serious"].includes(item.impact || ""),
  );
  expect(
    serious.map((item) => ({
      id: item.id,
      impact: item.impact,
      nodes: item.nodes.map((node) => node.target),
    })),
  ).toEqual([]);
  await page.getByRole("button", { name: "Studio help" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const dialogResults = await new AxeBuilder({ page }).analyze();
  await test
    .info()
    .attach("dialog-accessibility.json", {
      body: JSON.stringify(dialogResults.violations, null, 2),
      contentType: "application/json",
    });
  expect(
    dialogResults.violations
      .filter((item) => ["critical", "serious"].includes(item.impact || ""))
      .map((item) => item.id),
  ).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("phone viewport keeps the document within the screen and supports reduced motion", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await studio(page);
  await expect(
    page.getByRole("button", { name: "Play composition" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: innerWidth,
    })),
  ).toEqual({ document: 390, viewport: 390 });
  await page.getByRole("tab", { name: "Lead", exact: true }).click();
  await expect(
    page.getByRole("grid", { name: /Lead piano roll/ }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  expect(
    await page.evaluate(
      () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Play composition" }).click();
  const animation = await page
    .locator(".power-led")
    .evaluate((node) => getComputedStyle(node).animationDuration);
  expect(animation.split(",").every((value) => parseFloat(value) <= 0.01)).toBe(
    true,
  );
});

test("multiword titles, multi-digit note edits, pitch, drum velocity, and version comparison remain editable", async ({
  page,
}) => {
  await studio(page);
  await page.getByRole("button", { name: "Open compositions" }).click();
  await page.getByRole("button", { name: "Blank canvas" }).click();
  const title = page.getByRole("textbox", { name: "Composition title" });
  await title.fill("");
  await title.pressSequentially("A late night tune");
  await title.press("Tab");
  await expect(title).toHaveValue("A late night tune");
  const tempo = page.getByRole("spinbutton", { name: "Tempo BPM" });
  await tempo.fill("");
  await tempo.pressSequentially("120");
  await tempo.press("Enter");
  await expect(tempo).toHaveValue("120");
  await page.getByRole("tab", { name: "Lead", exact: true }).click();
  await page.getByRole("gridcell", { name: "C4, step 1", exact: true }).click();
  const duration = page.getByRole("spinbutton", { name: "Note duration" });
  await duration.fill("");
  await duration.pressSequentially("12");
  await duration.press("Enter");
  await expect(duration).toHaveValue("12");
  const start = page.getByRole("spinbutton", { name: "Note start step" });
  await start.fill("");
  await start.pressSequentially("12");
  await start.press("Enter");
  await expect(start).toHaveValue("12");
  await page.getByRole("combobox", { name: "Note pitch" }).selectOption("64");
  await page.getByRole("tab", { name: "Drums", exact: true }).click();
  const kick = page.getByRole("gridcell", { name: /^Kick, step 1(?:,|$)/ });
  await kick.click();
  await kick.click({ modifiers: ["Shift"] });
  await expect(kick).toHaveAttribute("aria-selected", "true");
  const velocity = page.getByRole("slider", { name: "Note velocity" });
  await velocity.focus();
  await velocity.press("End");
  await velocity.press("ArrowLeft");
  const edited = await jsonExport(page);
  expect(edited.title).toBe("A late night tune");
  expect(edited.bpm).toBe(120);
  expect(
    edited.tracks.find((track) => track.id === "lead")!.notes[0],
  ).toMatchObject({ start: 11, duration: 12, pitch: 64 });
  expect(
    edited.tracks.find((track) => track.id === "drums")!.notes[0]!.velocity,
  ).toBeCloseTo(0.95);
  await page.getByRole("button", { name: "Versions", exact: true }).click();
  await page
    .getByRole("button", { name: "Compare", exact: true })
    .last()
    .click();
  await expect(
    page.getByRole("button", { name: "Shape sound", exact: true }),
  ).toBeDisabled();
  await expect(tempo).toBeDisabled();
  await expect(page.getByRole("gridcell").first()).toBeDisabled();
  await page.getByRole("button", { name: "Back to current" }).click();
  await expect(tempo).toBeEnabled();
  await expect(title).toHaveValue("A late night tune");
});

test("library, sound, help, history, and export dialogs pass serious accessibility checks", async ({
  page,
}) => {
  await studio(page);
  const findings: {
    dialog: string;
    id: string;
    target: unknown;
    summary: string | undefined;
  }[] = [];
  for (const name of [
    "Open compositions",
    "Shape sound",
    "Studio help",
    "Versions",
    "Export",
  ]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    const result = await new AxeBuilder({ page }).analyze();
    for (const violation of result.violations.filter((item) =>
      ["critical", "serious"].includes(item.impact || ""),
    )) {
      for (const node of violation.nodes)
        findings.push({
          dialog: name,
          id: violation.id,
          target: node.target,
          summary: node.failureSummary,
        });
    }
    await page.getByRole("button", { name: "Close dialog" }).click();
  }
  await test
    .info()
    .attach("dialog-findings.json", {
      body: JSON.stringify(findings, null, 2),
      contentType: "application/json",
    });
  expect(findings).toEqual([]);
});
