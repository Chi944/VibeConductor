import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { ServerConfig } from "./config";
import { isLoopback } from "./config";
import { HttpError } from "./errors";

const COOKIE = "vibeconductor_session";
const SESSION_MS = 12 * 60 * 60 * 1000;

function digest(value: string) {
  return createHash("sha256").update(value).digest();
}
export function constantTimeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

export class WindowLimiter {
  private entries = new Map<string, { count: number; until: number }>();
  constructor(
    private limit: number,
    private windowMs: number,
    private now = Date.now,
  ) {}
  take(key: string): boolean {
    const now = this.now();
    const existing = this.entries.get(key);
    if (existing && existing.until > now) return ++existing.count <= this.limit;
    for (const [id, entry] of this.entries)
      if (entry.until <= now) this.entries.delete(id);
    // Fail closed if an abnormal number of addresses fills the limiter.
    if (this.entries.size >= 10_000) return false;
    this.entries.set(key, { count: 1, until: now + this.windowMs });
    return true;
  }
  clear(key: string) {
    this.entries.delete(key);
  }
}

export class SessionStore {
  private active = new Map<string, number>();
  constructor(
    private config: ServerConfig,
    private now = Date.now,
  ) {}
  local(req: Pick<Request, "socket">): boolean {
    return this.config.localMode && isLoopback(req.socket.remoteAddress);
  }
  private cookie(req: Request): string | undefined {
    return req.headers.cookie
      ?.split(";")
      .map((p) => p.trim())
      .find((p) => p.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
  }
  id(req: Request): string | null {
    if (this.local(req)) return "local-owner";
    const token = this.cookie(req);
    if (!token || token.length > 256) return null;
    const [id, expires, signature, extra] = token.split(".");
    if (extra || !id || !expires || !signature) return null;
    const expected = createHmac("sha256", this.config.sessionSecret)
      .update(`${id}.${expires}`)
      .digest("base64url");
    if (!constantTimeEqual(signature, expected)) return null;
    const expiry = Number(expires);
    if (
      !Number.isSafeInteger(expiry) ||
      expiry <= this.now() ||
      this.active.get(id) !== expiry
    )
      return null;
    return id;
  }
  create(res: Response): string {
    const now = this.now();
    for (const [id, expiry] of this.active)
      if (expiry <= now) this.active.delete(id);
    if (this.active.size >= 100)
      this.active.delete(this.active.keys().next().value!);
    const id = randomBytes(24).toString("base64url");
    const expiry = now + SESSION_MS;
    this.active.set(id, expiry);
    const payload = `${id}.${expiry}`;
    const signature = createHmac("sha256", this.config.sessionSecret)
      .update(payload)
      .digest("base64url");
    res.cookie(COOKIE, `${payload}.${signature}`, {
      httpOnly: true,
      sameSite: "strict",
      secure: this.config.production,
      path: "/",
      maxAge: SESSION_MS,
    });
    return id;
  }
  destroy(req: Request, res: Response): void {
    const id = this.id(req);
    if (id) this.active.delete(id);
    res.clearCookie(COOKIE, {
      httpOnly: true,
      sameSite: "strict",
      secure: this.config.production,
      path: "/",
    });
  }
  require = (req: Request, res: Response, next: NextFunction) => {
    const id = this.id(req);
    if (!id)
      return next(
        new HttpError(
          401,
          "UNAUTHORIZED",
          "Sign in to your private instrument.",
        ),
      );
    res.locals.sessionId = id;
    next();
  };
}

export function protectRequest(config: ServerConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self'${config.production ? "" : " 'unsafe-inline'"}; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'${config.production ? "" : " ws://localhost:* ws://127.0.0.1:*"}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
    );
    if (config.production)
      res.setHeader("Strict-Transport-Security", "max-age=31536000");
    if (!config.allowedHosts.has((req.headers.host || "").toLowerCase()))
      return next(
        new HttpError(403, "INVALID_HOST", "This host is not configured."),
      );
    if (req.path.startsWith("/api/"))
      res.setHeader("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.headers.origin;
      if (
        req.headers["sec-fetch-site"] === "cross-site" ||
        (origin && !config.allowedOrigins.has(origin))
      ) {
        return next(
          new HttpError(
            403,
            "CROSS_ORIGIN",
            "Use this instrument from its own address.",
          ),
        );
      }
      if (req.headers["x-vibeconductor-request"] !== "1")
        return next(
          new HttpError(
            403,
            "REQUEST_HEADER_REQUIRED",
            "The request needs the instrument request header.",
          ),
        );
      if (!req.is("application/json"))
        return next(
          new HttpError(
            415,
            "JSON_REQUIRED",
            "Send an application/json request.",
          ),
        );
    }
    next();
  };
}
