import { config as loadEnvironment } from "dotenv";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import express from "express";
import { createApp } from "./app";
import { developmentDenyList, loadConfig } from "./config";

loadEnvironment({ quiet: true });
const production =
  process.argv.includes("--production") ||
  process.env.NODE_ENV === "production";
// Preview selects built assets only. It must never weaken production auth.
const serveBuiltAssets = production || process.argv.includes("--preview");
const config = loadConfig(process.env, production);
const { app, close } = createApp({ config });
const server = createServer(app);
let closeVite: (() => Promise<void>) | undefined;
if (serveBuiltAssets) {
  const dist = resolve("dist");
  if (!existsSync(resolve(dist, "index.html")))
    throw new Error(
      "Build the browser app with npm run build before starting preview or production.",
    );
  app.use(express.static(dist, { index: false }));
  app.get(/.*/, (_req, res) => {
    res.sendFile(resolve(dist, "index.html"));
  });
} else {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    server: {
      middlewareMode: true,
      hmr: { server },
      fs: { deny: developmentDenyList(config.databasePath) },
    },
    appType: "spa",
  });
  app.use(vite.middlewares);
  closeVite = () => vite.close();
}

server.listen(config.port, config.host, () => {
  console.log(
    `VibeConductor listening at ${config.origin} (${config.localMode ? "local owner" : "password protected"}; AI ${config.apiKey ? "configured" : "not configured"}).`,
  );
});
async function shutdown() {
  server.close();
  await closeVite?.();
  server.closeAllConnections();
  close();
}
process.once("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown().then(() => process.exit(0));
});
