import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  outputDir: "./test-results/browser-artifacts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:4321",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "node --import tsx server/index.ts",
    url: "http://127.0.0.1:4321/api/session",
    timeout: 60_000,
    reuseExistingServer: false,
    env: {
      HOST: "127.0.0.1",
      PORT: "4321",
      APP_ORIGIN: "http://127.0.0.1:4321",
      DATABASE_PATH: "test-results/browser.sqlite",
      NODE_ENV: "development",
      OPENAI_API_KEY: "",
      OWNER_PASSWORD: "",
      SESSION_SECRET: "",
    },
  },
});
