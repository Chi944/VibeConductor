import express from "express";
import type { ErrorRequestHandler } from "express";
import { z } from "zod";
import { scoreSchema } from "../shared/score.js";
import { constraintsSchema } from "../shared/edits.js";
import type { HistoryEntry, Score } from "../shared/types.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { CompositionStore } from "./database.js";
import {
  Conductor,
  createOpenAIProvider,
  type ConductProvider,
} from "./conduct.js";
import {
  constantTimeEqual,
  protectRequest,
  SessionStore,
  WindowLimiter,
} from "./security.js";
import { errorBody, HttpError } from "./errors.js";

const requestIdSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
const conductSchema = z
  .object({
    requestId: requestIdSchema,
    direction: z.string().trim().min(1).max(1200),
    score: scoreSchema,
    constraints: constraintsSchema,
  })
  .strict();
const historySchema = z
  .array(
    z
      .object({
        id: z.string().min(1).max(100),
        score: scoreSchema,
        label: z.string().max(600),
        at: z.iso.datetime(),
        direction: z.string().max(1200).optional(),
      })
      .strict(),
  )
  .max(30);
const saveSchema = z
  .object({ score: scoreSchema, history: historySchema })
  .strict();

function validateHistory(score: Score, history: HistoryEntry[]): void {
  if (history.some((entry) => entry.score.id !== score.id))
    throw new HttpError(
      400,
      "HISTORY_MISMATCH",
      "History entries must belong to this composition.",
    );
  if (
    history.length &&
    JSON.stringify(history.at(-1)!.score) !== JSON.stringify(score)
  )
    throw new HttpError(
      400,
      "HISTORY_MISMATCH",
      "The current score must match the latest history version.",
    );
}

export interface AppOptions {
  config?: ServerConfig;
  store?: CompositionStore;
  provider?: ConductProvider | null;
}

export function createApp(options: AppOptions = {}) {
  const config = options.config || loadConfig();
  const store = options.store || new CompositionStore(config.databasePath);
  const provider =
    options.provider === undefined
      ? createOpenAIProvider(config)
      : options.provider;
  const conductor = new Conductor(config, provider);
  const sessions = new SessionStore(config);
  const apiLimits = new WindowLimiter(240, 60_000);
  const loginLimits = new WindowLimiter(5, 15 * 60_000);
  const writeLimits = new WindowLimiter(90, 60_000);
  const conductLimits = new WindowLimiter(10, 60_000);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(protectRequest(config));
  app.use("/api", (req, _res, next) => {
    if (!apiLimits.take(req.socket.remoteAddress || "unknown"))
      return next(
        new HttpError(
          429,
          "RATE_LIMITED",
          "Too many requests. Try again in a minute.",
        ),
      );
    next();
  });
  app.use(express.json({ limit: "2mb", strict: true }));
  app.get("/api/session", (req, res) => {
    const authenticated = !!sessions.id(req);
    res.json({
      authenticated,
      localMode: sessions.local(req),
      aiAvailable: authenticated && conductor.available,
    });
  });
  app.post("/api/login", (req, res) => {
    const password = z
      .object({ password: z.string().min(1).max(1024) })
      .strict()
      .parse(req.body).password;
    const ip = req.socket.remoteAddress || "unknown";
    if (!loginLimits.take(ip))
      throw new HttpError(
        429,
        "LOGIN_THROTTLED",
        "Too many sign-in attempts. Try again in 15 minutes.",
      );
    if (
      !config.ownerPassword ||
      !constantTimeEqual(password, config.ownerPassword)
    )
      throw new HttpError(401, "INVALID_LOGIN", "The password is incorrect.");
    loginLimits.clear(ip);
    sessions.create(res);
    res.json({
      authenticated: true,
      localMode: false,
      aiAvailable: conductor.available,
    });
  });
  app.post("/api/logout", (req, res) => {
    sessions.destroy(req, res);
    res.json({
      authenticated: sessions.local(req),
      localMode: sessions.local(req),
      aiAvailable: sessions.local(req) && conductor.available,
    });
  });
  app.get("/api/shares/:id", (req, res) => {
    if (!/^[a-zA-Z0-9_-]{24}$/.test(req.params.id))
      throw new HttpError(404, "NOT_FOUND", "Snapshot not found.");
    const snapshot = store.getShare(req.params.id);
    if (!snapshot) throw new HttpError(404, "NOT_FOUND", "Snapshot not found.");
    res.json(snapshot);
  });
  app.use("/api", sessions.require);
  app.use("/api", (req, res, next) => {
    if (
      !["GET", "HEAD"].includes(req.method) &&
      !writeLimits.take(res.locals.sessionId)
    )
      return next(
        new HttpError(
          429,
          "WRITE_THROTTLED",
          "Too many changes. Try again in a minute.",
        ),
      );
    next();
  });
  app.get("/api/compositions", (_req, res) => {
    res.json({ compositions: store.list() });
  });
  app.get("/api/compositions/:id", (req, res) => {
    const saved = store.get(requestIdSchema.parse(req.params.id));
    if (!saved) throw new HttpError(404, "NOT_FOUND", "Composition not found.");
    res.json(saved);
  });
  app.post("/api/compositions", (req, res) => {
    const { score, history } = saveSchema.parse(req.body);
    validateHistory(score, history);
    res.status(201).json(store.save(score, history, false));
  });
  app.put("/api/compositions/:id", (req, res) => {
    const { score, history } = saveSchema.parse(req.body);
    if (score.id !== req.params.id)
      throw new HttpError(
        400,
        "IDENTITY_MISMATCH",
        "The composition identity cannot change during an update.",
      );
    validateHistory(score, history);
    res.json(store.save(score, history, true));
  });
  app.post("/api/shares", (req, res) => {
    const { score } = z.object({ score: scoreSchema }).strict().parse(req.body);
    const id = store.share(score);
    res.status(201).json({ id, url: `/s/${id}` });
  });
  app.post("/api/conduct", async (req, res) => {
    const input = conductSchema.parse(req.body);
    if (!conductLimits.take(res.locals.sessionId))
      throw new HttpError(
        429,
        "CONDUCT_THROTTLED",
        "Try again in a minute; the conductor allows 10 requests per minute.",
      );
    const controller = new AbortController();
    const cancel = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once("aborted", cancel);
    res.once("close", cancel);
    try {
      const result = await conductor.conduct(
        res.locals.sessionId,
        input,
        controller.signal,
      );
      if (!controller.signal.aborted)
        res.status(result.status).json(result.body);
    } finally {
      req.off("aborted", cancel);
      res.off("close", cancel);
    }
  });
  app.use("/api", (_req, _res, next) =>
    next(new HttpError(404, "NOT_FOUND", "API endpoint not found.")),
  );
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof HttpError) {
      res.status(error.status).json(errorBody(error.code, error.message));
      return;
    }
    if (error instanceof z.ZodError) {
      res
        .status(400)
        .json(
          errorBody(
            "INVALID_INPUT",
            "The request contains invalid or unsupported data.",
          ),
        );
      return;
    }
    if (
      error &&
      typeof error === "object" &&
      "type" in error &&
      error.type === "entity.too.large"
    ) {
      res
        .status(413)
        .json(
          errorBody(
            "PAYLOAD_TOO_LARGE",
            "This request is too large. Keep at most 30 history versions.",
          ),
        );
      return;
    }
    if (
      error instanceof SyntaxError &&
      "status" in error &&
      error.status === 400
    ) {
      res
        .status(400)
        .json(errorBody("INVALID_JSON", "The request is not valid JSON."));
      return;
    }
    // Do not echo provider errors, secrets, SQL details, prompts, or stack traces.
    console.error(
      "Request failed:",
      error instanceof Error ? error.name : "UnknownError",
    );
    res
      .status(500)
      .json(
        errorBody(
          "SERVER_ERROR",
          "The instrument could not complete this request.",
        ),
      );
  };
  app.use(errors);
  return { app, store, config, conductor, close: () => store.close() };
}
