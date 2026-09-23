import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { zodTextFormat } from "openai/helpers/zod";
import { mkdtempSync, readdirSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isFileLoadingAllowed, normalizePath, resolveConfig } from "vite";
import { createApp } from "../server/app";
import { developmentDenyList, loadConfig } from "../server/config";
import {
  Conductor,
  modelProposalSchema,
  type ConductProvider,
} from "../server/conduct";
import { SessionStore } from "../server/security";
import { CompositionStore } from "../server/database";
import { EXAMPLES } from "../shared/examples";
import type { ConductRequest, EditConstraints } from "../shared/types";

const HOST = "127.0.0.1:4310";
const headers = {
  Host: HOST,
  Origin: `http://${HOST}`,
  "X-VibeConductor-Request": "1",
};
const constraints: EditConstraints = {
  protectedTracks: [],
  lockTempo: false,
  targetBar: null,
  fewerNotes: [],
};
const score = () => structuredClone(EXAMPLES[0].score);
const input = (direction = "Bring the tempo to 100 BPM."): ConductRequest => ({
  requestId: "request-1",
  direction,
  score: score(),
  constraints: structuredClone(constraints),
});
const config = (extra: NodeJS.ProcessEnv = {}) =>
  loadConfig({ DATABASE_PATH: ":memory:", ...extra });
const applications: ReturnType<typeof createApp>[] = [];
function setup(options: Parameters<typeof createApp>[0] = {}) {
  const instance = createApp({ config: config(), provider: null, ...options });
  applications.push(instance);
  return instance;
}
const tempoProvider = (bpm = 100): ConductProvider => ({
  generate: vi.fn(async (req) => ({
    proposal: {
      baseRevisionId: req.score.revisionId,
      explanation: "A quicker pulse.",
      operations: [{ type: "setTempo", bpm }],
    },
    inputTokens: 120,
    outputTokens: 40,
    model: "gpt-4.1-mini",
  })),
});
afterEach(() => {
  for (const instance of applications.splice(0)) instance.close();
});

describe("server configuration and private access", () => {
  it("does not expose the database or server secrets through Vite static-file routes", async () => {
    const vite = await resolveConfig(
      {
        configFile: false,
        server: { fs: { deny: developmentDenyList("./custom-storage") } },
      },
      "serve",
    );
    for (const file of [
      "data/vibeconductor.sqlite",
      "data/vibeconductor.sqlite-wal",
      "private.db",
      "custom-storage",
      "custom-storage-shm",
      ".env",
      ".env.local",
      ".npmrc",
      "certificate.key",
      "server/config.ts",
    ]) {
      expect(
        isFileLoadingAllowed(vite, normalizePath(resolve(file))),
        file,
      ).toBe(false);
    }
    expect(
      isFileLoadingAllowed(vite, normalizePath(resolve("src/App.tsx"))),
    ).toBe(true);
    expect(
      isFileLoadingAllowed(vite, normalizePath(resolve("shared/score.ts"))),
    ).toBe(true);
  });
  it("allows local use without a key but rejects unsafe deployments", () => {
    expect(config().localMode).toBe(true);
    expect(() => config({ HOST: "0.0.0.0" })).toThrow(/loopback/);
    expect(() => config({ NODE_ENV: "production" })).toThrow(/OWNER_PASSWORD/);
    expect(() => config({ APP_ORIGIN: "https://public.example" })).toThrow(
      /external/,
    );
    expect(() =>
      config({ OPENAI_MODEL: "gpt-4.1-mini\nignore system" }),
    ).toThrow(/model identifier/);
    expect(() => config({ OPENAI_MODEL: "https://malicious.example" })).toThrow(
      /model identifier/,
    );
  });
  it("never derives local access from Host or forwarded headers", () => {
    const sessions = new SessionStore(config());
    expect(
      sessions.local({ socket: { remoteAddress: "203.0.113.42" } } as never),
    ).toBe(false);
    expect(
      sessions.local({
        socket: { remoteAddress: "::ffff:127.0.0.1" },
      } as never),
    ).toBe(true);
    const secured = new SessionStore(
      config({
        OWNER_PASSWORD: "correct-password-for-testing",
        SESSION_SECRET: "s".repeat(40),
      }),
    );
    expect(
      secured.local({ socket: { remoteAddress: "127.0.0.1" } } as never),
    ).toBe(false);
  });
  it("reports honest missing-key state and rejects DNS-rebinding hosts", async () => {
    const { app } = setup();
    const session = await request(app).get("/api/session").set("Host", HOST);
    expect(session.body).toEqual({
      authenticated: true,
      localMode: true,
      aiAvailable: false,
    });
    expect(
      (
        await request(app)
          .get("/api/session")
          .set("Host", "attacker.example:4310")
      ).status,
    ).toBe(403);
    const unavailable = await request(app)
      .post("/api/conduct")
      .set(headers)
      .send(input());
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.error.code).toBe("AI_UNAVAILABLE");
  });
  it("requires a signed active owner session and revokes it on logout", async () => {
    const { app } = setup({
      config: config({
        OWNER_PASSWORD: "correct-password-for-testing",
        SESSION_SECRET: "s".repeat(40),
      }),
      provider: tempoProvider(),
    });
    const anonymous = await request(app)
      .get("/api/session")
      .set("Host", HOST)
      .set("X-Forwarded-For", "127.0.0.1");
    expect(anonymous.body).toEqual({
      authenticated: false,
      localMode: false,
      aiAvailable: false,
    });
    expect(
      (await request(app).get("/api/compositions").set("Host", HOST)).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post("/api/login")
          .set(headers)
          .send({ password: "incorrect" })
      ).status,
    ).toBe(401);
    const login = await request(app)
      .post("/api/login")
      .set(headers)
      .send({ password: "correct-password-for-testing" });
    const cookie = login.headers["set-cookie"][0].split(";")[0];
    expect(login.headers["set-cookie"][0]).toContain("HttpOnly");
    expect(login.headers["set-cookie"][0]).toContain("SameSite=Strict");
    expect(
      (
        await request(app)
          .get("/api/compositions")
          .set("Host", HOST)
          .set("Cookie", cookie)
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .get("/api/compositions")
          .set("Host", HOST)
          .set("Cookie", `${cookie}x`)
      ).status,
    ).toBe(401);
    await request(app)
      .post("/api/logout")
      .set(headers)
      .set("Cookie", cookie)
      .send({});
    expect(
      (
        await request(app)
          .get("/api/compositions")
          .set("Host", HOST)
          .set("Cookie", cookie)
      ).status,
    ).toBe(401);
  });
  it("issues secure cookies for a correctly configured HTTPS deployment", async () => {
    const conf = config({
      NODE_ENV: "production",
      APP_ORIGIN: "https://instrument.example",
      OWNER_PASSWORD: "correct-password-for-testing",
      SESSION_SECRET: "s".repeat(40),
    });
    const { app } = setup({ config: conf });
    const login = await request(app)
      .post("/api/login")
      .set({
        ...headers,
        Host: "instrument.example",
        Origin: "https://instrument.example",
      })
      .send({ password: "correct-password-for-testing" });
    expect(login.status).toBe(200);
    expect(login.headers["set-cookie"][0]).toContain("Secure");
    expect(login.headers["strict-transport-security"]).toContain("max-age");
  });
  it("throttles failed logins", async () => {
    const { app } = setup({
      config: config({
        OWNER_PASSWORD: "correct-password-for-testing",
        SESSION_SECRET: "s".repeat(40),
      }),
    });
    for (let n = 0; n < 5; n++)
      expect(
        (
          await request(app)
            .post("/api/login")
            .set(headers)
            .send({ password: "wrong" })
        ).status,
      ).toBe(401);
    const blocked = await request(app)
      .post("/api/login")
      .set(headers)
      .send({ password: "correct-password-for-testing" });
    expect(blocked.status).toBe(429);
  });
  it("rejects cross-origin and simple requests before mutation", async () => {
    const { app } = setup();
    const body = { score: score(), history: [] };
    expect(
      (
        await request(app)
          .post("/api/compositions")
          .set({ ...headers, Origin: "https://attacker.example" })
          .send(body)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post("/api/compositions")
          .set("Host", HOST)
          .send(body)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post("/api/compositions")
          .set({ ...headers, "Sec-Fetch-Site": "cross-site" })
          .send(body)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post("/api/compositions")
          .set(headers)
          .type("text/plain")
          .send(JSON.stringify(body))
      ).status,
    ).toBe(415);
    expect(
      (await request(app).get("/api/compositions").set("Host", HOST)).body
        .compositions,
    ).toEqual([]);
  });
});

describe("validated persistence and immutable snapshots", () => {
  it("retains compositions and snapshots across a real SQLite close/reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "vibeconductor-db-test-"));
    const path = join(directory, "test.sqlite");
    let store = new CompositionStore(path);
    try {
      const base = score();
      store.save(base, [], false);
      const share = store.share(base);
      store.close();
      store = new CompositionStore(path);
      expect(store.get(base.id)?.score).toEqual(base);
      expect(store.getShare(share)?.score).toEqual(base);
      expect(store.list()).toHaveLength(1);
    } finally {
      store.close();
      for (const filename of readdirSync(directory))
        unlinkSync(join(directory, filename));
      rmdirSync(directory);
    }
  });
  it("saves, reloads, updates and lists a composition without exposing its full score in the list", async () => {
    const { app } = setup();
    const base = score();
    const history = [
      {
        id: "h-1",
        score: base,
        at: new Date().toISOString(),
        label: "An accepted conductor explanation. ".repeat(17),
        direction: "Make it warm.",
      },
    ];
    const saved = await request(app)
      .post("/api/compositions")
      .set(headers)
      .send({ score: base, history });
    expect(saved.status).toBe(201);
    expect(saved.body.score).toEqual(base);
    const reloaded = await request(app)
      .get(`/api/compositions/${base.id}`)
      .set("Host", HOST);
    expect(reloaded.body.history).toEqual(history);
    const changed = { ...base, title: "A new title", bpm: 93 };
    expect(
      (
        await request(app)
          .put(`/api/compositions/${base.id}`)
          .set(headers)
          .send({ score: changed, history })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .put(`/api/compositions/${base.id}`)
          .set(headers)
          .send({
            score: changed,
            history: [...history, { ...history[0], id: "h-2", score: changed }],
          })
      ).status,
    ).toBe(200);
    const list = await request(app).get("/api/compositions").set("Host", HOST);
    expect(list.body.compositions).toEqual([
      { id: base.id, title: "A new title", updatedAt: expect.any(String) },
    ]);
    expect(
      (
        await request(app)
          .post("/api/compositions")
          .set(headers)
          .send({ score: base, history })
      ).status,
    ).toBe(409);
  });
  it("rejects invalid scores, mixed history, oversized history, invalid JSON and identity substitution atomically", async () => {
    const { app } = setup();
    const base = score();
    const history = {
      id: "h-1",
      score: base,
      at: new Date().toISOString(),
      label: "Original",
    };
    const invalid = structuredClone(base);
    invalid.tracks[1].notes[0].pitch = 120;
    for (const payload of [
      { score: invalid, history: [] },
      {
        score: base,
        history: [{ ...history, score: { ...base, id: "someone-else" } }],
      },
      { score: base, history: Array.from({ length: 31 }, () => history) },
      { score: base, history: [], owner: "someone-else" },
    ])
      expect(
        (
          await request(app)
            .post("/api/compositions")
            .set(headers)
            .send(payload)
        ).status,
      ).toBe(400);
    expect(
      (
        await request(app)
          .post("/api/compositions")
          .set(headers)
          .type("json")
          .send('{"invalid')
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .put("/api/compositions/other-id")
          .set(headers)
          .send({ score: base, history: [] })
      ).status,
    ).toBe(400);
    expect(
      (await request(app).get("/api/compositions").set("Host", HOST)).body
        .compositions,
    ).toEqual([]);
  });
  it("shares a frozen score without history or owner credentials", async () => {
    const conf = config({
      OWNER_PASSWORD: "correct-password-for-testing",
      SESSION_SECRET: "s".repeat(40),
    });
    const { app } = setup({ config: conf });
    const login = await request(app)
      .post("/api/login")
      .set(headers)
      .send({ password: "correct-password-for-testing" });
    const cookie = login.headers["set-cookie"][0].split(";")[0];
    const base = score();
    await request(app)
      .post("/api/compositions")
      .set(headers)
      .set("Cookie", cookie)
      .send({ score: base, history: [] });
    const shared = await request(app)
      .post("/api/shares")
      .set(headers)
      .set("Cookie", cookie)
      .send({ score: base });
    expect(shared.status).toBe(201);
    expect(shared.body.url).toBe(`/s/${shared.body.id}`);
    await request(app)
      .put(`/api/compositions/${base.id}`)
      .set(headers)
      .set("Cookie", cookie)
      .send({ score: { ...base, bpm: 115 }, history: [] });
    const snapshot = await request(app)
      .get(`/api/shares/${shared.body.id}`)
      .set("Host", HOST);
    expect(snapshot.status).toBe(200);
    expect(snapshot.body).toEqual({
      score: base,
      createdAt: expect.any(String),
    });
    expect(
      (await request(app).get(`/api/compositions/${base.id}`).set("Host", HOST))
        .status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post("/api/shares")
          .set(headers)
          .send({ score: base })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .put(`/api/shares/${shared.body.id}`)
          .set(headers)
          .set("Cookie", cookie)
          .send({ score: { ...base, bpm: 140 } })
      ).status,
    ).toBe(404);
  });
});

describe("AI request safety (mock provider; no network or credentials)", () => {
  it("generates a supported strict object wire schema, with nested unions and required nullable fields", () => {
    const format = zodTextFormat(modelProposalSchema, "score_edit");
    expect(format.strict).toBe(true);
    expect(format.schema.type).toBe("object");
    expect(format.schema.additionalProperties).toBe(false);
    expect(JSON.stringify(format.schema)).not.toContain('"oneOf"');
    expect(format.schema.required).toEqual([
      "baseRevisionId",
      "explanation",
      "operations",
    ]);
  });
  it("returns a real provider proposal with usage and caches a repeated request without calling again", async () => {
    const provider = tempoProvider();
    const { app } = setup({ provider });
    const first = await request(app)
      .post("/api/conduct")
      .set(headers)
      .send(input());
    expect(first.status).toBe(200);
    expect(first.body.usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 40,
      model: "gpt-4.1-mini",
      estimatedCostUsd: 0.000112,
    });
    const second = await request(app)
      .post("/api/conduct")
      .set(headers)
      .send(input());
    expect(second.body).toEqual(first.body);
    expect(provider.generate).toHaveBeenCalledTimes(1);
    const reused = await request(app)
      .post("/api/conduct")
      .set(headers)
      .send({ ...input(), direction: "Actually 90 BPM." });
    expect(reused.status).toBe(409);
  });
  it("independently enforces tempo and track protections from ordinary language", async () => {
    const { app } = setup({ provider: tempoProvider() });
    const response = await request(app)
      .post("/api/conduct")
      .set(headers)
      .send(input("Make it brighter. Do not change the tempo."));
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("UNSAFE_AI_EDIT");
  });
  it("rejects stale, unknown-operation and dangerous note output without partially applying a tempo change", async () => {
    for (const bad of [
      {
        baseRevisionId: "old-revision",
        explanation: "Old.",
        operations: [{ type: "setTempo", bpm: 100 }],
      },
      {
        baseRevisionId: score().revisionId,
        explanation: "Ignore controls.",
        operations: [{ type: "execute", code: "process.env" }],
      },
      {
        baseRevisionId: score().revisionId,
        explanation: "Invalid.",
        operations: [
          { type: "setTempo", bpm: 100 },
          {
            type: "upsertNote",
            trackId: "bass",
            note: {
              id: "evil-note",
              start: 31,
              duration: 8,
              pitch: 127,
              velocity: 5,
              drum: null,
            },
          },
        ],
      },
    ]) {
      const provider: ConductProvider = {
        generate: async () => ({
          proposal: bad,
          inputTokens: 1,
          outputTokens: 1,
          model: "test",
        }),
      };
      const { app } = setup({ provider });
      const original = input();
      const response = await request(app)
        .post("/api/conduct")
        .set(headers)
        .send(original);
      expect(response.status).toBe(422);
      expect(original.score.bpm).toBe(86);
      expect(
        (await request(app).get("/api/compositions").set("Host", HOST)).body
          .compositions,
      ).toEqual([]);
    }
  });
  it("does not spend a request on impossible bar constraints or malformed requests", async () => {
    const provider = tempoProvider();
    const { app } = setup({ provider });
    expect(
      (
        await request(app)
          .post("/api/conduct")
          .set(headers)
          .send({ ...input(), constraints: { ...constraints, targetBar: 4 } })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post("/api/conduct")
          .set(headers)
          .send({ ...input(), direction: "x".repeat(1201) })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post("/api/conduct")
          .set(headers)
          .send({ ...input(), model: "external-model" })
      ).status,
    ).toBe(400);
    const empty = input("Give the bass fewer notes.");
    empty.score.tracks.find((track) => track.id === "bass")!.notes = [];
    expect(
      (await request(app).post("/api/conduct").set(headers).send(empty)).status,
    ).toBe(400);
    expect(provider.generate).not.toHaveBeenCalled();
  });
  it("sanitizes provider errors and caches a failed attempt to prevent a silent second charge", async () => {
    const provider: ConductProvider = {
      generate: vi.fn(async () => {
        throw new Error("sk-private-secret with raw prompt and SQL stack");
      }),
    };
    const { app } = setup({ provider });
    const first = await request(app)
      .post("/api/conduct")
      .set(headers)
      .send(input());
    expect(first.status).toBe(502);
    expect(JSON.stringify(first.body)).not.toContain("sk-private");
    expect(
      (await request(app).post("/api/conduct").set(headers).send(input())).body,
    ).toEqual(first.body);
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });
  it("bounds latency even when a provider ignores cancellation and rejects concurrent calls", async () => {
    const provider: ConductProvider = {
      generate: vi.fn(() => new Promise<never>(() => {})),
    };
    const conf = { ...config(), conductTimeoutMs: 25 };
    const conductor = new Conductor(conf, provider);
    const signal = new AbortController().signal;
    const pending = conductor.conduct("session", input(), signal);
    await expect(
      conductor.conduct(
        "session",
        { ...input(), requestId: "request-2" },
        signal,
      ),
    ).rejects.toMatchObject({ code: "CONDUCT_BUSY" });
    const response = await pending;
    expect(response.status).toBe(504);
    expect(await conductor.conduct("session", input(), signal)).toEqual(
      response,
    );
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });
  it("cancels a disconnected request and permits a new request ID afterwards", async () => {
    const provider: ConductProvider = {
      generate: vi.fn(() => new Promise<never>(() => {})),
    };
    const conductor = new Conductor(
      { ...config(), conductTimeoutMs: 25 },
      provider,
    );
    const disconnected = new AbortController();
    const pending = conductor.conduct("session", input(), disconnected.signal);
    disconnected.abort();
    const result = await pending;
    expect(result.status).toBe(408);
    const second = await conductor.conduct(
      "session",
      { ...input(), requestId: "request-2" },
      new AbortController().signal,
    );
    expect(second.status).toBe(504);
    expect(provider.generate).toHaveBeenCalledTimes(2);
  });
});
