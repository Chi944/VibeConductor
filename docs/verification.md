# Verification record

Verification date: **2026-09-23**. Local checks used Windows, Node **24.19.0**, npm **11.19.0**, and Docker Engine **29.7.2** with Linux containers. Browser checks used Playwright **1.63.0** and headless Chromium **153.0.8010.12**. This report separates observed application behavior from simulated edge cases and unmeasured product quality.

## Results

| Check                         | Observed result                                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| TypeScript validation         | Passed with `tsc --noEmit`                                                                                           |
| Unit/server tests             | **108 passed** across four files: 61 score/edit domain, 4 revision state, 23 audio coordination, and 20 server tests |
| Production browser build      | Passed through `npm run build`, including the Linux Docker build stage                                               |
| Offline conducting evaluation | **8/8 constraint checks passed; 0 live calls; 8 live cases skipped**                                                 |
| Chromium browser suite        | **14/14 scenarios passed against the optimized frontend** (26.2s locally); the earlier development suite also passed |
| Production container          | Build and local HTTP/persistence smoke checks passed                                                                 |
| Live OpenAI evaluation        | Not run; the owner chose to leave credentials unconfigured                                                           |

## What the tests exercised

The final `npm run check` completed with type checking, all 108 tests and a production browser build passing. The tracked [offline evaluation report](../artifacts/offline-evaluation.json) records all eight extraction checks and explicitly skipped live cases.

The first Linux CI run exposed an audio timing interruption when opening Export after the delayed-response check. Its trace placed the interruption before the download, with the stale response already discarded. Two avoidable rendering costs were removed: fractional playhead updates that rerendered the studio every animation frame, and a full-surface backdrop blur. The display now updates only on changed integer steps. A unit regression covers this behavior, and three focused local browser repeats passed without changing the scheduler's 100 ms horizon or weakening the playback assertion. GitHub Actions retains the Linux run history and evidence for the pull request.

Further review found an overly conservative timer-gap check: a late timer could stop playback during a rest even when no note deadline had been missed. The scheduler now checks actual unscheduled onsets and retains its 35 ms lateness limit; a whole missed incoming loop still stops bounded recovery. New regressions exercise rests, silent boundaries, actual missed notes and an hour-long simulated pause.

The browser harness now builds and serves the optimized frontend through `--preview`, avoiding development React/Vite overhead while retaining all native-audio assertions. Failure traces retain DOM, source and network evidence; screenshots are taken on failure instead of continuously recording the moving instrument. Preview changes asset serving only: local loopback/authentication rules remain in force, and either `NODE_ENV=production` or `--production` continues to enforce all production credentials and HTTPS configuration.

An isolated HTTP startup check on port 4334 verified that preview serves compiled `/assets/` files without a Vite client, retains Host and Origin guards, rejects a password-free non-loopback bind, and rejects missing production credentials for both production-selection paths. A correctly configured production preview remained signed out until login and issued a Secure session cookie.

The unit suite validates score bounds, deterministic event compilation, JSON round trips, strict atomic edits, protected tracks, tempo/bar scope, note-count constraints, and rejection of stale revisions. Revision tests cover delayed responses, pending Undo, and normalization of recovered history whose final version differs from the current score. The 20 server tests cover owner sessions, logout revocation, CSRF/Host protection, login throttling, safe Vite file access, validated history saves, real SQLite close/reopen, immutable snapshots, absent credentials, malicious proposals, timeouts, cancellation and idempotency.

Audio unit tests use controlled clocks and fake audio nodes to make boundary races repeatable. They check duplicate scheduling, loop/tempo transitions, cancellation of future sources, Stop/restart, timer starvation, asynchronous resume and mute/solo/display behavior. These tests establish scheduling logic; they do not measure a browser's physical output latency.

The browser suite observes native `AudioContext` objects and native oscillators/buffer sources while calling their original methods. A real analyser must report a nonzero waveform after Play. Source start/stop times are checked when Stop and Undo retract future notes, and instrument/playhead animation must react during playback. The suite also exercises saving and reloading from the real server, JSON import/export, immutable silent-on-open snapshots, input editing, version comparison, keyboard grid editing, a 390×844 viewport, reduced-motion styles and axe accessibility checks.

Some browser scenarios deliberately introduce artificial conditions: the delayed conducting response is mocked, `document.hidden` is overridden before dispatching a visibility event, and native audio resume is delayed to reproduce an asynchronous startup race. The additional saved-load regressions mock delayed library responses to test that closing the dialog, editing, or choosing another example invalidates old requests. Actual `AudioContext.suspend()` is also tested. These cases do not measure a live provider or a real network delay; actual OS tab-background behavior remains a separate manual check.

WAV verification uses a real browser `OfflineAudioContext`. The exported file must be stereo, 44.1 kHz PCM16, contain four complete loops plus its release tail, and have nonzero audio samples below the clipping threshold for the tested composition. This confirms offline rendering and file encoding; it is separate from live playback and listening judgment.

The [studio browser tests](../tests/browser/studio.spec.ts) and [saved-load regressions](../tests/browser/loading.spec.ts) contain the exact assertions. Automated accessibility checks reject critical/serious axe findings on the studio and tested dialogs; they do not claim a complete accessibility audit.

## Production container verification

`docker build -t vibeconductor:verification .` completed with production-only runtime dependencies. A temporary container ran as the image's unprivileged `node` user, with randomly generated test-only owner credentials, no API key, and a named SQLite volume. Local HTTP checks established:

- An unauthenticated session reports no owner access or AI availability; the private composition API returns 401.
- An unconfigured Host returns 403, and successful owner login issues a Secure cookie.
- The production page is served, the container health check becomes healthy, and conducting without a key returns 503.
- A composition and explicit snapshot can be created. After replacing the container while retaining its volume, the composition and public snapshot remain identical.
- The previous session stops working after replacement; a fresh owner login succeeds.

The temporary containers and volumes were removed after verification. No public DNS, live HTTPS certificate, hosted server or multi-replica deployment was configured. The [deployment guide](deployment.md) documents the reproducible image/startup procedure and storage requirements.

## Reproduce and interpret

```sh
npm ci
npm run check
npm run eval -- --output artifacts/local/offline-evaluation.json
npx playwright install chromium
npm run test:e2e
docker build -t vibeconductor:verification .
```

On Linux CI, Playwright installation uses `--with-deps`. `npm run test:e2e` rebuilds the optimized frontend, and the browser suite starts its own credential-free preview server on port 4321. This verifies production browser assets with local server access rules; production authentication is separately covered by the server and container checks. Local HTML results are written to `playwright-report/`; failed-test traces/screenshots and accessibility attachments are under `test-results/browser-artifacts/`. The GitHub workflow uploads those outputs with the offline evaluation report. All live model evaluation requires an explicit `--live` invocation and deliberately configured credentials; see [evaluation.md](evaluation.md).

No live model accuracy, model latency, provider token usage or paid cost was measured. No human listening session, subjective musical-quality study, physical-device latency measurement, Safari/Firefox run or real mobile-device test is claimed. The delivered evidence supports the implemented playback, editing, persistence and validation behavior within the environments and scenarios above.
