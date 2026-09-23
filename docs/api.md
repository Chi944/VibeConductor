# Private server and API

The Express process serves both the browser and API at `http://127.0.0.1:4310`. Development uses Vite middleware with database, credential and server source paths excluded from file serving; the standalone production process serves `dist`. The Vercel adapter serves the Vite output from its static deployment directory and exposes the same Express app through `api/[...path].ts`. Node 24 or later is required for built-in SQLite. API keys are used only by the server. Live AI is deliberately unconfigured in this delivery.

## Access and deployment

Without an owner password, the process must bind to a loopback IP and local access is granted only to actual loopback TCP clients. `Host`, `Forwarded` and `X-Forwarded-For` never grant authentication. An exact Host allowlist also blocks browser DNS rebinding. Do not put the password-free development process behind a public tunnel or reverse proxy: a proxy connection is itself local. Configure owner mode before any proxy or non-local access.

Set a nonempty `OWNER_PASSWORD` (up to 1024 characters) and `SESSION_SECRET` of at least 32 characters together to enable private owner login. The owner chooses the password length. Production additionally requires an exact HTTPS `APP_ORIGIN` (or Vercel deployment origin); startup fails when required settings are missing. Terminate HTTPS at a proxy that preserves the configured Host and forwards to the app. Proxy headers are not trusted for authentication or client identity. Rate limits behind a proxy are consequently shared by proxy clients.

Sessions expire after 12 hours, use signed random cookies with `HttpOnly` and `SameSite=Strict`, and add `Secure` in production. Logout revokes the active session server-side. Sessions, request caches and throttles are in memory, so a restart signs the owner out. Run one process; shared session storage would be required for multiple replicas. Failed sign-in attempts are limited to five per address per 15 minutes.

Every write, including login/logout, requires `Content-Type: application/json` and `X-VibeConductor-Request: 1`. If an Origin header is present, it must exactly match a configured origin. Cross-site Fetch Metadata is rejected. The app does not enable cross-origin access. CLI clients may omit Origin but must supply the custom header. Request bodies are limited to 2 MB. Owner writes are limited to 90/minute, conducting to 10/minute, and all API requests to 240/minute per TCP address.

## Routes

| Method and route            | Request                            | Response                                                                                           |
| --------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET /api/session`          | —                                  | `{authenticated, localMode, aiAvailable}`; AI configuration is hidden from unauthenticated clients |
| `POST /api/login`           | `{password}`                       | Session state and owner cookie                                                                     |
| `POST /api/logout`          | `{}`                               | Session state and cleared cookie                                                                   |
| `GET /api/compositions`     | Owner session                      | `{compositions: [{id, title, updatedAt}]}`                                                         |
| `POST /api/compositions`    | `{score, history}`                 | Saved composition, status 201; duplicate identity returns 409                                      |
| `PUT /api/compositions/:id` | `{score, history}`                 | Saved composition; score identity must match path                                                  |
| `GET /api/compositions/:id` | Owner session                      | `{id, title, updatedAt, score, history}`                                                           |
| `POST /api/shares`          | Owner session and `{score}`        | `{id, url: "/s/:id"}`, status 201                                                                  |
| `GET /api/shares/:id`       | Public, unguessable snapshot ID    | `{score, createdAt}`                                                                               |
| `POST /api/conduct`         | Owner session and `ConductRequest` | `ConductResult` or a safe error                                                                    |

`Score`, `HistoryEntry`, `ConductRequest`, `ConductResult` and edit types are defined in `shared/types.ts`. Runtime validation lives in `shared/score.ts` and `shared/edits.ts`. All objects reject unknown fields. History is limited to 30 validated versions belonging to the saved composition; send the last 30 from the browser. When history is present, its last score must equal the current score so reloading has a consistent undo position. Data is stored in `data/vibeconductor.sqlite` by default. Back up that database before moving the service; close the server first or use a proper SQLite backup procedure that includes committed WAL contents.

Sharing is an explicit separate write. It creates a new 144-bit random ID and immutable copy of the validated score, without history or user credentials. Anyone holding a reachable link can read that snapshot. Changing the private composition cannot alter it. There is no update endpoint for snapshots. A localhost link works only on the same machine until deployed at a reachable configured origin.

All errors use `{error: {code, message}}`. Invalid input is 400; owner access is 401; origin/host violations are 403; missing records are 404; duplicate identities and busy/reused request IDs are 409; invalid model proposals are 422; throttles are 429. Raw model/provider errors, SQL details and secrets are never sent to clients.

## AI conducting

`ConductRequest` contains a unique `requestId`, direction (1–1200 characters), the exact current score, and explicit constraints. The server independently derives additional language constraints, merges them without weakening explicit protection, then sends a structured edit request to the OpenAI Responses API. The default model is `gpt-4.1-mini`; use `OPENAI_MODEL` to select another supported model after evaluation. Neither the model nor API endpoint is client-selectable.

The request uses `store: false`, a strict Zod-derived object schema, a 7000-token output cap, a 20-second timeout, and no automatic retries. The response must complete, pass domain validation and apply atomically against the submitted revision and constraints. It never executes arbitrary actions or writes compositions. The browser must repeat validation against its current revision before accepting the proposal. OpenAI's [structured-output guide](https://developers.openai.com/api/docs/guides/structured-outputs) informed the wire schema and `responses.parse` integration.

Only one model call may run per session. Disconnecting cancels the upstream request. Completed outcomes, including errors/timeouts, are cached for 15 minutes in the process: resending the same request ID and content returns the same result; different content under that ID returns 409. An in-flight duplicate returns `CONDUCT_BUSY`. Cache retention is bounded at 1000 attempts. Never automatically retry a failed request with a new ID; a timeout or lost connection may already have incurred provider usage. A restart clears this cache.

No key means `aiAvailable: false` and 503 `AI_UNAVAILABLE`; there is no simulated AI fallback. With a configured key, successful results include measured input/output token counts and end-to-end conducting latency. The default model's conservative cost estimate uses $0.40/million input and $1.60/million output tokens, verified against the [official model page](https://developers.openai.com/api/docs/models/gpt-4.1-mini) on 2026-09-23. It excludes cached-input discounts. Unknown models return `estimatedCostUsd: null` unless both token-price environment overrides are set. Prices can change; these values are estimates, not billing records.
