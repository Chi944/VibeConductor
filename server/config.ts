import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

export interface ServerConfig {
  production: boolean;
  host: string;
  port: number;
  origin: string;
  allowedHosts: Set<string>;
  allowedOrigins: Set<string>;
  localMode: boolean;
  ownerPassword: string;
  sessionSecret: string;
  databasePath: string;
  apiKey: string;
  model: string;
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  conductTimeoutMs: number;
}

export function isLoopback(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

/** Preserve Vite's secret-file exclusions and also keep server-owned data private. */
export function developmentDenyList(databasePath: string): string[] {
  return [
    ".env",
    ".env.*",
    "*.{crt,pem,key,p12,pfx,cer,der}",
    ".npmrc",
    ".yarnrc.yml",
    "**/.git/**",
    "**/data/**",
    "**/server/**",
    "**/*.sqlite",
    "**/*.sqlite-*",
    "**/*.db",
    "**/*.db-*",
    `${resolve(databasePath).replaceAll("\\", "/")}*`,
  ];
}

function optionalPrice(
  value: string | undefined,
  fallback: number | null,
): number | null {
  if (!value) return fallback;
  const price = Number(value);
  if (!Number.isFinite(price) || price < 0)
    throw new Error("Token prices must be nonnegative numbers.");
  return price;
}

/** Configuration never obtains local-mode authority from request headers. */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  production = env.NODE_ENV === "production",
): ServerConfig {
  const host = env.HOST || "127.0.0.1";
  const port = Number(env.PORT || 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be 1–65535.");
  const ownerPassword = env.OWNER_PASSWORD || "";
  const sessionSecret = env.SESSION_SECRET || "";
  if (
    (production || ownerPassword) &&
    (!ownerPassword || ownerPassword.length > 1024 || sessionSecret.length < 32)
  ) {
    throw new Error(
      "Owner mode requires OWNER_PASSWORD (1–1024 characters) and SESSION_SECRET (32+ characters).",
    );
  }
  if (!ownerPassword && !isLoopback(host))
    throw new Error("Password-free mode must bind to a loopback IP address.");
  const platformHosts = [
    env.VERCEL_URL,
    env.VERCEL_BRANCH_URL,
    env.VERCEL_PROJECT_PRODUCTION_URL,
  ].filter((value): value is string => !!value);
  const platformOrigins = platformHosts.map((host) => `https://${host}`);
  const configuredOrigin =
    env.APP_ORIGIN ||
    (production && env.VERCEL === "1" ? platformOrigins[0] : undefined);
  if (production && !configuredOrigin)
    throw new Error("Production requires an https APP_ORIGIN.");
  const originUrl = new URL(configuredOrigin || `http://127.0.0.1:${port}`);
  if (
    !["http:", "https:"].includes(originUrl.protocol) ||
    originUrl.username ||
    originUrl.password ||
    originUrl.pathname !== "/" ||
    originUrl.search ||
    originUrl.hash
  ) {
    throw new Error(
      "APP_ORIGIN must be an http(s) origin without credentials, path, query, or fragment.",
    );
  }
  if (production && originUrl.protocol !== "https:")
    throw new Error("Production APP_ORIGIN must use https.");
  if (
    !ownerPassword &&
    !["127.0.0.1", "[::1]", "localhost"].includes(originUrl.hostname)
  ) {
    throw new Error("Password-free mode cannot use an external APP_ORIGIN.");
  }
  const allowedOrigins = new Set([originUrl.origin, ...platformOrigins]);
  if (!production && isLoopback(host)) {
    allowedOrigins.add(`http://127.0.0.1:${port}`);
    allowedOrigins.add(`http://localhost:${port}`);
    allowedOrigins.add(`http://[::1]:${port}`);
  }
  const model = env.OPENAI_MODEL || "gpt-4.1-mini";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(model))
    throw new Error("OPENAI_MODEL must be a model identifier.");
  const defaultPricing =
    model === "gpt-4.1-mini" || model === "gpt-4.1-mini-2025-04-14";
  return {
    production,
    host,
    port,
    origin: originUrl.origin,
    allowedOrigins,
    allowedHosts: new Set(
      [...allowedOrigins].map((origin) => new URL(origin).host.toLowerCase()),
    ),
    localMode: !production && !ownerPassword && isLoopback(host),
    ownerPassword,
    sessionSecret: sessionSecret || randomBytes(32).toString("hex"),
    databasePath:
      env.DATABASE_PATH ||
      (env.VERCEL === "1"
        ? "/tmp/vibeconductor.sqlite"
        : resolve("data/vibeconductor.sqlite")),
    apiKey: env.OPENAI_API_KEY || "",
    model,
    inputPricePerMillion: optionalPrice(
      env.OPENAI_INPUT_PRICE_PER_MILLION,
      defaultPricing ? 0.4 : null,
    ),
    outputPricePerMillion: optionalPrice(
      env.OPENAI_OUTPUT_PRICE_PER_MILLION,
      defaultPricing ? 1.6 : null,
    ),
    conductTimeoutMs: 20_000,
  };
}
