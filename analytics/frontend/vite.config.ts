/// <reference types="vitest" />
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// The app is a fully static, in-browser site: SQLite (wa-sqlite, WASM) runs in Web Workers and
// persists to IndexedDB (IDBBatchAtomicVFS). That needs no SharedArrayBuffer, so no COOP/COEP headers.
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
  server: { port: 5173 },
  preview: { port: 4173 },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
}));
