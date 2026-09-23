# Conducting evaluation

The live model has not been evaluated in this delivery because the owner chose to leave API access unconfigured. Mock provider tests validate the application boundary; they do not demonstrate a model's musical ability. On 2026-09-23, the server suite passed 20/20 tests and the offline fixture passed 8/8 constraint checks, with all eight live cases skipped.

## Reproducible checks

Run `npm test` for score, editing, audio and server tests. The server suite uses injected providers and an in-memory SQLite database, with no network requests or credentials. It checks private login, logout revocation, secure production cookies, local-mode authority, DNS rebinding protection, cross-origin writes, rate limiting, validated saves, immutable shares, missing-key behavior, malicious/stale proposals, cancellation, timeouts, concurrency and request idempotency. It also generates the exact OpenAI wire schema offline to verify SDK compatibility.

Run `npm run eval` for the held-out direction fixture in `tests/fixtures/conduct-evaluation.json`. Eight manually authored cases cover protected percussion, halving bass note count, a bar-limited snare change, exact tempo, sparse lead, an added kick, combined scope constraints and an instruction-injection attempt. None of these examples is included in the conductor's system prompt. Expected constraints are written independently; the evaluator compares parser output against those fixed expectations.

The default run makes no paid calls, even if a key is present. It reports `liveCasesRun: 0` and labels every live case skipped. These offline results assess constraint extraction and fixture score validity only.

## Opt-in live run

After deliberately configuring an API key, run `npm run eval -- --live --output evaluation-results/live.json`. This submits eight sequential model requests and incurs provider charges; the script never retries them. Without a key it still reports live cases as skipped. Model access and quotas must be enabled for the chosen account.

Each successful request records actual token usage, measured latency, model identifier and estimated cost. Grading uses both runtime score validation and independent outcome predicates: protected tracks must match, tempo must match its requested target, note reduction must meet the requested ratio, edits must stay in the chosen bar, a quieter snare must have lower summed velocity, and a specified gentle kick must exist. The injection case passes only when the application rejects it with 422. Rejected/time-out requests are reported explicitly, with unknown usage rather than a false zero-cost claim.

Before treating a model as production-ready, review all failed cases, listen to each successful before/after pair, and rerun on additional directions not used to tune prompts. Assess groove, clarity and musical interpretation manually. The automated suite cannot establish these perceptual qualities. Keep measured provider evaluation separate from browser audio verification and offline WAV rendering.
