// Memory regression: ingest the 1 GB synthetic chat.db in Chromium and fail if peak JS memory exceeds 500 MB.
//
// SKIPPED until the engine merges; enable with `npm run test:memory` (sets MEMORY_TEST=1). Slow: generates the 1 GB
// fixture once (tests/.cache/chat-1gb.db, git-ignored) and ingests it. Report -> tests/.cache/memory-report.json.
//
// Env knobs (so the test survives UI tweaks):
//   MEMORY_LIMIT_MB=500        peak budget
//   MEMORY_SIZE=1gb|100mb|small fixture size to ingest
//   MEMORY_CHATDB_SELECTOR     file input for chat.db   (default: input[type=file] that accepts .db, else first)
//   MEMORY_DONE_SELECTOR       element that appears when ingest is done (default: text /ingest(ion)? (complete|done)|done/i
//                              inside [data-testid=debug-console], else body)
//   MEMORY_TIMEOUT_MIN=45
//
// Measurement: JS heap of the page (CDP Performance.getMetrics JSSHeapUsedSize) + all dedicated-worker heaps. Workers
// can't be CDP-attached through Playwright's public API, so the whole agent cluster is measured with
// performance.measureUserAgentSpecificMemory() (needs cross-origin isolation, which SQLite WASM/OPFS needs anyway).
// If it is unavailable, falls back to page heap + the engine's own `memory` events ({usedMB}) scraped from the
// debug console text. Peak = max over samples taken every 1 s.
import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR, ensureFixtures, fixturePath } from "../scripts/make-fixtures";
import type { Size } from "../scripts/lib/chatdb";

const LIMIT_MB = Number(process.env.MEMORY_LIMIT_MB ?? 500);
const SIZE = (process.env.MEMORY_SIZE ?? "1gb") as Size;
const TIMEOUT_MIN = Number(process.env.MEMORY_TIMEOUT_MIN ?? 45);

test.describe("ingest memory", () => {
  test.skip(!process.env.MEMORY_TEST, "TODO: enabled via `npm run test:memory` once the ingest engine units are merged");
  test.setTimeout((TIMEOUT_MIN + 30) * 60_000);

  test(`peak memory stays under ${LIMIT_MB} MB while ingesting ${SIZE} chat.db`, async ({ page, context }) => {
    ensureFixtures([SIZE]);
    const chatDb = fixturePath(SIZE);

    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    await page.goto("/");

    const input = process.env.MEMORY_CHATDB_SELECTOR
      ? page.locator(process.env.MEMORY_CHATDB_SELECTOR)
      : page.locator('input[type="file"][accept*=".db"], input[type="file"]').first();
    await input.setInputFiles(chatDb); // path-based: Chromium streams from disk, nothing is buffered by the test

    const samples: { tSec: number; pageHeapMB: number; agentMB: number | null; engineMB: number | null }[] = [];
    const t0 = Date.now();
    let peak = 0;
    const consoleText = () =>
      page.locator('[data-testid="debug-console"]').first().innerText({ timeout: 1000 }).catch(() => "");
    const donePattern = /ingest(ion)?\s+(complete|done)|\bdone\b/i;

    const deadline = t0 + TIMEOUT_MIN * 60_000;
    let finished = false;
    while (Date.now() < deadline && !finished) {
      const m = await cdp.send("Performance.getMetrics");
      const heap = m.metrics.find((x) => x.name === "JSHeapUsedSize")?.value ?? 0;
      const agent = await page
        .evaluate(async () => {
          const p = performance as unknown as { measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }> };
          if (!p.measureUserAgentSpecificMemory || !self.crossOriginIsolated) return null;
          return (await p.measureUserAgentSpecificMemory()).bytes;
        })
        .catch(() => null);
      const text = await consoleText();
      const mem = [...text.matchAll(/usedMB["':\s]+(\d+(?:\.\d+)?)/g)].pop();
      const engineMB = mem ? Number(mem[1]) : null;
      const pageMB = heap / 1048576;
      const mb = agent != null ? agent / 1048576 : Math.max(pageMB, pageMB + (engineMB ?? 0));
      peak = Math.max(peak, mb);
      samples.push({ tSec: (Date.now() - t0) / 1000, pageHeapMB: pageMB, agentMB: agent != null ? agent / 1048576 : null, engineMB });
      finished = process.env.MEMORY_DONE_SELECTOR
        ? await page.locator(process.env.MEMORY_DONE_SELECTOR).first().isVisible().catch(() => false)
        : donePattern.test(text || (await page.locator("body").innerText().catch(() => "")));
      if (!finished) await page.waitForTimeout(1000);
    }

    mkdirSync(CACHE_DIR, { recursive: true });
    const report = { size: SIZE, limitMB: LIMIT_MB, peakMB: Math.round(peak), finished, durationSec: (Date.now() - t0) / 1000, samples };
    writeFileSync(join(CACHE_DIR, "memory-report.json"), JSON.stringify(report, null, 1));
    console.log(`memory report: peak ${report.peakMB} MB / ${LIMIT_MB} MB, finished=${finished}, ${samples.length} samples`);

    expect(finished, "ingest did not finish before timeout").toBe(true);
    expect(peak, `peak memory ${peak.toFixed(0)} MB`).toBeLessThanOrEqual(LIMIT_MB);
  });
});
