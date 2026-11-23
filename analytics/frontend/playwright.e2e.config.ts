import { defineConfig } from "@playwright/test";

// Real-browser tests against the production build (system Chrome, headless). `npm run test:e2e`.
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /.*\.spec\.ts/,
  reporter: [["list"]],
  workers: 1,
  timeout: 15 * 60_000,
  use: {
    baseURL: "http://localhost:4173",
    browserName: "chromium",
    channel: process.env.E2E_CHANNEL ?? "chrome",
    headless: true,
    actionTimeout: 30_000,
    viewport: { width: 1280, height: 900 },
    launchOptions: { args: ["--js-flags=--expose-gc"] },
  },
  webServer: {
    command: `${process.env.E2E_TRACE ? "VITE_TRACE=1 " : ""}npm run build && npm run preview -- --port 4173 --strictPort`,
    url: "http://localhost:4173",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
