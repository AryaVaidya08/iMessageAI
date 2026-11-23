import { defineConfig } from "@playwright/test";

// Used only for the memory test (`npm run test:memory`). Unit/parity tests run under vitest.
export default defineConfig({
  testDir: "tests",
  testMatch: /memory\.spec\.ts/,
  reporter: [["list"]],
  workers: 1,
  use: {
    baseURL: "http://localhost:5173",
    browserName: "chromium",
    launchOptions: {
      args: ["--enable-precise-memory-info", "--js-flags=--expose-gc"],
    },
  },
  webServer: {
    command: "npm run dev -- --port 5173 --strictPort",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
