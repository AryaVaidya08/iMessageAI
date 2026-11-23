import { expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR } from "../../scripts/make-fixtures";

export const SHOTS = join(CACHE_DIR, "screenshots");
mkdirSync(SHOTS, { recursive: true });

/** Collects page errors / console errors so a test can assert there were none. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  if (process.env.E2E_TRACE) {
    // VITE_TRACE build: keep a rolling window of DB-call traces and dump it if a test stalls (see waitImportDone)
    page.on("console", (m) => {
      const t = m.text();
      if (t.startsWith("[trace ")) {
        (globalThis as { __trace?: string[] }).__trace = [...((globalThis as { __trace?: string[] }).__trace ?? []).slice(-3000), t];
        const ms = /end (\d+)ms/.exec(t);
        if (ms && Number(ms[1]) > 1500) console.log(`SLOW DB CALL: ${t.slice(0, 220)}`);
      }
    });
  }
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });
  return errors;
}

export const consoleEl = (page: Page) => page.getByTestId("debug-console");

export async function goto(page: Page, hash: string) {
  await page.evaluate((h) => {
    location.hash = h;
  }, hash);
}

/** Waits for the import to finish, printing progress every 15 s so a stall is visible. */
export async function runCount(page: Page): Promise<number> {
  return Number((await consoleEl(page).getAttribute("data-run").catch(() => "0")) ?? 0);
}

/** Waits for the import to finish. Pass the run count taken BEFORE starting, so a previous run's "done" is ignored. */
export async function waitImportDone(page: Page, timeout = 25 * 60_000, afterRun = 0) {
  const t0 = Date.now();
  await expect(consoleEl(page)).toHaveAttribute("data-run", new RegExp(`^(${Array.from({ length: 50 }, (_, i) => i + afterRun + 1).join("|")})$`), { timeout });
  let last = "";
  const ticker = setInterval(async () => {
    const txt = await consoleEl(page).innerText().catch(() => "");
    const line = txt.split("\n").filter((l) => /msgs|chats|Done|Import/.test(l)).slice(0, 6).join(" | ");
    if (line !== last) console.log(`[import ${Math.round((Date.now() - t0) / 1000)}s] ${line}`);
    else if (process.env.E2E_TRACE) {
      const tr = (globalThis as { __trace?: string[] }).__trace ?? [];
      const open = new Map<string, string>();
      for (const l of tr) {
        const m = /^\[trace (\w+)\] #(\d+) (start|end|FAIL)(.*)$/.exec(l);
        if (!m) continue;
        if (m[3] === "start") open.set(m[1] + "#" + m[2], l);
        else open.delete(m[1] + "#" + m[2]);
      }
      console.log(`STALLED? trace lines=${tr.length}; unfinished DB calls:\n` + [...open.values()].join("\n") + "\nLAST INGEST LINES:\n" + tr.filter((l) => l.startsWith("[trace ingest]")).slice(-8).join("\n") + "\nLAST QUERY LINES:\n" + tr.filter((l) => l.startsWith("[trace query]")).slice(-4).join("\n"));
    }
    last = line;
  }, 15_000);
  try {
    await expect(consoleEl(page)).toHaveAttribute("data-state", "done", { timeout });
  } finally {
    clearInterval(ticker);
  }
}

/** A page body that is showing an error state. */
export async function expectNoErrorText(page: Page) {
  const text = await page.locator("main").innerText();
  expect(text).not.toMatch(/couldn.t load|not implemented|something went wrong|no such table|failed to/i);
}

export async function shot(page: Page, name: string) {
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
}
