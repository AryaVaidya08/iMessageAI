import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.spec.ts"],
    exclude: ["tests/memory.spec.ts", "node_modules/**"], // memory.spec.ts is Playwright, see playwright.config.ts
    testTimeout: 60_000,
  },
});
