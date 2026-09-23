import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";

// Vercel provides the deployment URLs at runtime. The production password and
// session secret stay in Vercel Environment Variables; no client secret is bundled.
const config = loadConfig(
  {
    ...process.env,
    NODE_ENV: "production",
    HOST: "0.0.0.0",
    DATABASE_PATH: process.env.DATABASE_PATH || "/tmp/vibeconductor.sqlite",
  },
  true,
);

const app = createApp({ config }).app;

export default app;
