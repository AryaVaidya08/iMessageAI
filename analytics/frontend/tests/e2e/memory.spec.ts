// Memory of the whole browser while importing, then while using the app. Measured as the RESIDENT memory (RSS) of
// every process of the test browser (browser + renderer + GPU + utility; dedicated workers live in the renderer) plus
// the page JS heap. The browser is launched by Playwright with a throw-away profile, so its processes are identifiable
// by that profile path; your own Chrome is never touched.
//   MEMORY_SIZE=small|100mb|1gb   MEMORY_TIMEOUT_MIN=120   npm run test:e2e -- tests/e2e/memory.spec.ts
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR, ensureFixtures, fixturePath } from "../../scripts/make-fixtures";
import type { Size } from "../../scripts/lib/chatdb";
import { consoleEl, goto, waitImportDone } from "./helpers";

const SIZE = (process.env.MEMORY_SIZE ?? "100mb") as Size;
const TIMEOUT_MIN = Number(process.env.MEMORY_TIMEOUT_MIN ?? 120);

interface ProcMem {
  total: number;
  browser: number;
  renderer: number;
  other: number;
}

/** RSS (MB) of the test browser's processes only (identified by the Playwright temp profile path). */
/** macOS physical footprint (MB) of one process: the figure Activity Monitor / memory pressure use (RSS also counts reclaimable file-backed pages). */
function footprintMB(pid: string): number {
  try {
    const out = execFileSync("vmmap", ["-summary", pid], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    const m = /Physical footprint:\s+([\d.]+)([KMG])/.exec(out);
    if (!m) return 0;
    return Number(m[1]) * (m[2] === "G" ? 1024 : m[2] === "K" ? 1 / 1024 : 1);
  } catch {
    return 0;
  }
}

/** Memory (MB) of the test browser's processes only. `fp*` = physical footprint (the headline), `rss*` = resident set. */
function browserMemory(): ProcMem & { rssTotal: number } {
  const out = execFileSync("ps", ["-axww", "-o", "pid=,rss=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const m = { total: 0, browser: 0, renderer: 0, other: 0, rssTotal: 0 };
  for (const line of out.split("\n")) {
    if (!line.includes("playwright_chromiumdev_profile")) continue;
    const [pid, rss] = line.trim().split(/\s+/);
    const fp = footprintMB(pid);
    const kind = line.includes("--type=renderer") ? "renderer" : line.includes("--type=") ? "other" : "browser";
    m[kind] += fp;
    m.total += fp;
    m.rssTotal += Number(rss) / 1024;
  }
  return m;
}

test(`browser memory while importing a ${SIZE} chat.db and using the app`, async ({ page, context }) => {
  test.setTimeout((TIMEOUT_MIN + 20) * 60_000);
  ensureFixtures([SIZE]);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await page.goto("/");
  await page.waitForTimeout(2000);
  const heapMB = async () => ((await cdp.send("Performance.getMetrics")).metrics.find((x) => x.name === "JSHeapUsedSize")?.value ?? 0) / 1048576;

  const baseline = browserMemory();
  const baselineHeap = await heapMB();
  console.log(`baseline (empty app): browser physical footprint ${baseline.total.toFixed(0)} MB (RSS ${baseline.rssTotal.toFixed(0)} MB) (browser ${baseline.browser.toFixed(0)}, renderer ${baseline.renderer.toFixed(0)}), JS heap ${baselineHeap.toFixed(0)} MB`);

  const samples: { t: number; msgs: number; total: number; renderer: number; browser: number; heap: number; rss: number }[] = [];
  const t0 = Date.now();
  /** Per-realm breakdown (needs E2E_ISOLATE=1): bytes by attributed script URL, so each worker shows up separately. */
  const breakdown = async (): Promise<string> => {
    const r = await page
      .evaluate(async () => {
        const p = performance as unknown as { measureUserAgentSpecificMemory?: () => Promise<{ bytes: number; breakdown: { bytes: number; attribution: { url?: string; scope?: string }[]; types: string[] }[] }> };
        if (!p.measureUserAgentSpecificMemory || !self.crossOriginIsolated) return null;
        return await p.measureUserAgentSpecificMemory();
      })
      .catch(() => null);
    if (!r) return "";
    const by = new Map<string, number>();
    for (const b of r.breakdown) {
      const key = (b.attribution[0]?.url ?? b.attribution[0]?.scope ?? "(unattributed)").replace(/^.*\/assets\//, "") + ` [${b.types.join(",")}]`;
      by.set(key, (by.get(key) ?? 0) + b.bytes);
    }
    return `total ${(r.bytes / 1048576).toFixed(0)}MB | ` + [...by].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}: ${(v / 1048576).toFixed(0)}MB`).join(" ; ");
  };
  const sample = async (msgs: number) => {
    const m = browserMemory();
    samples.push({ t: Math.round((Date.now() - t0) / 1000), msgs, total: Math.round(m.total), renderer: Math.round(m.renderer), browser: Math.round(m.browser), heap: Math.round(await heapMB()), rss: Math.round(m.rssTotal) });
  };

  const run0 = Number((await consoleEl(page).getAttribute("data-run")) ?? 0);
  await page.getByTestId("chatdb-input").setInputFiles(fixturePath(SIZE));
  await page.getByTestId("contacts-input").setInputFiles(join(CACHE_DIR, "addressbook", "AddressBook-v22.abcddb"));
  await page.getByRole("button", { name: /start analysis/i }).click();

  // sample every 5 s until the import is done
  const deadline = Date.now() + TIMEOUT_MIN * 60_000;
  let done = false;
  let last = "";
  while (Date.now() < deadline && !done) {
    const txt = await consoleEl(page).innerText().catch(() => "");
    const mm = /([\d,]+) \/ ([\d,]+) msgs/.exec(txt);
    const msgs = mm ? Number(mm[1].replace(/,/g, "")) : 0;
    await sample(msgs);
    const s = samples[samples.length - 1];
    const line = `t=${s.t}s msgs=${msgs.toLocaleString()} footprint=${s.total}MB (renderer ${s.renderer}, browser ${s.browser}) rss=${s.rss}MB heap=${s.heap}MB`;
    if (samples.length % 6 === 1 && line !== last) console.log(line);
    if (process.env.E2E_ISOLATE && samples.length % 3 === 1) console.log(`   uaMemory: ${await breakdown()}`);
    last = line;
    if (s.total > Number(process.env.MEMORY_CAP_MB ?? 3000)) {
      writeFileSync(join(CACHE_DIR, `memory-${SIZE}.json`), JSON.stringify({ aborted: `footprint cap ${process.env.MEMORY_CAP_MB ?? 3000} MB exceeded`, samples }, null, 1));
      throw new Error(`footprint ${s.total} MB exceeded the safety cap at ${msgs} messages`);
    }
    done = (await consoleEl(page).getAttribute("data-state")) === "done" && Number((await consoleEl(page).getAttribute("data-run")) ?? 0) > run0;
    if (!done) await page.waitForTimeout(3000);
  }
  expect(done, "import did not finish before the timeout").toBe(true);
  const importSec = Math.round((Date.now() - t0) / 1000);
  const peakImport = Math.max(...samples.map((s) => s.total));
  console.log(`import finished in ${importSec}s; peak browser RSS during import ${peakImport} MB (baseline ${baseline.total.toFixed(0)} MB)`);

  const usage = await page.evaluate(async () => {
    const e = await navigator.storage.estimate();
    return { usageMB: Math.round((e.usage ?? 0) / 1048576), idbMB: Math.round(((e as { usageDetails?: { indexedDB?: number } }).usageDetails?.indexedDB ?? 0) / 1048576) };
  });
  console.log(`storage used after import: ${usage.usageMB} MB (IndexedDB ${usage.idbMB} MB) for a ${SIZE} chat.db`);

  // after the import: settle, then use the heavy pages
  await page.waitForTimeout(8000);
  await sample(0);
  const afterImport = samples[samples.length - 1].total;
  for (const hash of ["#/overview", "#/conversations", "#/people"]) {
    await goto(page, hash);
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(2500);
      await sample(0);
    }
  }
  const peakUse = Math.max(...samples.slice(-18).map((s) => s.total));
  const report = {
    size: SIZE,
    baselineRssMB: Math.round(baseline.total),
    importSeconds: importSec,
    peakImportRssMB: peakImport,
    peakImportOverBaselineMB: Math.round(peakImport - baseline.total),
    rssAfterImportMB: afterImport,
    peakWhileBrowsingRssMB: peakUse,
    samples,
  };
  writeFileSync(join(CACHE_DIR, `memory-${SIZE}.json`), JSON.stringify(report, null, 1));
  console.log(`MEMORY REPORT ${SIZE}: baseline ${report.baselineRssMB} MB | peak during import ${peakImport} MB (+${report.peakImportOverBaselineMB}) | after import ${afterImport} MB | peak while browsing ${peakUse} MB | import ${importSec}s`);
  void waitImportDone;
});
