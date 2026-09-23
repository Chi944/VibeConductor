import { rm } from "node:fs/promises";

// Licenses remain in the source repository, but the hosted client does not
// need to ship them as static payload. Keeping this cleanup cross-platform
// makes the same Vercel build command work on local Windows and Linux CI.
await rm("vercel-static/licenses", { recursive: true, force: true });
