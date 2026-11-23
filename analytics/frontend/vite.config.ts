/// <reference types="vitest" />
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// The app is a fully static, in-browser site: SQLite (wa-sqlite, WASM) runs in Web Workers and
// persists to IndexedDB (IDBBatchAtomicVFS). That needs no SharedArrayBuffer, so no COOP/COEP headers.
// Diagnostics only: VITE_ISOLATE=1 serves COOP/COEP so performance.measureUserAgentSpecificMemory() works
// (per-worker memory breakdown in tests/e2e/memory.spec.ts). The app itself does not need them.
const isolation = process.env.VITE_ISOLATE
  ? { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" }
  : undefined;

export default defineConfig(({ mode }) => ({
  // Relative base so the build works from any subpath (GitHub Pages, etc.).
  // Override with VITE_BASE=/repo/ if you need absolute URLs.
  base: loadEnv(mode, ".", "VITE_").VITE_BASE || "./",
  plugins: [react()],
  worker: { format: "es" },
  optimizeDeps: {
    // WASM-backed packages must not be pre-bundled or their .wasm URLs break.
    exclude: ["wa-sqlite", "@sqlite.org/sqlite-wasm", "sql.js"],
  },
  assetsInclude: ["**/*.wasm"],
  build: { target: "es2022" },
  server: { port: 5173, headers: isolation },
  preview: { port: 4173, headers: isolation },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.spec.ts"],
    exclude: ["tests/memory.spec.ts", "tests/e2e/**", "node_modules/**"], // memory.spec.ts is Playwright (playwright.config.ts)
    testTimeout: 60_000,
  },
}));
