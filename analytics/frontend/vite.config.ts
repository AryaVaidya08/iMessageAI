import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Cross-origin isolation headers. Required only if the chosen SQLite VFS uses
// SharedArrayBuffer (e.g. wa-sqlite's OPFS-coop/Atomics builds). The OPFS
// sync-access-handle path used inside dedicated workers does not need them,
// but we send them everywhere so either VFS works. Note: with
// COEP require-corp, cross-origin subresources must opt in via CORP/CORS.
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

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
  server: { port: 5173, headers: isolationHeaders },
  preview: { port: 4173, headers: isolationHeaders },
}));
