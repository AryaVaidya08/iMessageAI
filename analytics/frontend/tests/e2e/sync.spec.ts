// Real-browser: incremental sync, unchanged re-upload, a contact merge that survives a reload, and the WAL flow.
import { expect, test, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR, ensureFixtures, fixturePath } from "../../scripts/make-fixtures";
import { consoleEl, expectNoErrorText, goto, runCount, shot, waitImportDone, watchErrors } from "./helpers";

/** Every .abcddb under the synthetic AddressBook folder (the main file plus Sources/*): the multi-file contacts upload. */
function addressBooks(dir = join(CACHE_DIR, "addressbook")): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? addressBooks(p) : /\.abcddb$/i.test(e) ? [p] : [];
  });
}
const APPENDED = join(CACHE_DIR, "chat-small-appended.db");
const WAL_DB = join(CACHE_DIR, "wal-chat.db");
const WAL_FILE = `${WAL_DB}-wal`;
const WAL_EXTRA = 25;

/** A chat.db whose newest WAL_EXTRA messages exist ONLY in the -wal file (never checkpointed into the db file). */
function buildWalFixture() {
  const tmp = join(CACHE_DIR, "wal-src.db");
  for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`, WAL_DB, WAL_FILE, `${WAL_DB}-shm`]) if (existsSync(f)) rmSync(f);
  copyFileSync(fixturePath("small"), tmp);
  const db = new Database(tmp);
  db.pragma("journal_mode = WAL");
  db.pragma("wal_autocheckpoint = 0");
  const info = db.prepare("PRAGMA table_info(message)").all() as { name: string; pk: number }[];
  const cols = info.filter((c) => !c.pk).map((c) => c.name);
  const src = db.prepare("SELECT * FROM message ORDER BY ROWID DESC LIMIT ?").all(WAL_EXTRA) as Record<string, unknown>[];
  const ins = db.prepare(`INSERT INTO message (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
  const chatOf = db.prepare("SELECT chat_id FROM chat_message_join WHERE message_id = ?");
  const join_ = db.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)");
  db.transaction(() => {
    src.forEach((m, i) => {
      const row = cols.map((c) => (c === "guid" ? `WAL-${i}-${m.guid}` : c === "date" ? Number(m.date) + 1e12 + i : m[c]));
      const rid = ins.run(...row).lastInsertRowid;
      const chat = chatOf.get((m as { ROWID?: number }).ROWID ?? 0) as { chat_id: number } | undefined;
      join_.run(chat?.chat_id ?? 1, rid);
    });
  })();
  copyFileSync(tmp, WAL_DB); // copy db + wal while the writer is still open = what a user's copy of a live chat.db is
  copyFileSync(`${tmp}-wal`, WAL_FILE);
  db.close();
  rmSync(tmp);
}

async function messageCount(page: Page): Promise<number> {
  await goto(page, "#/");
  const b = page.locator("xpath=//span[normalize-space()='messages']/preceding-sibling::b[1]");
  await expect(b).toBeVisible({ timeout: 30_000 });
  return Number((await b.innerText()).replace(/[^\d]/g, ""));
}

const logText = (page: Page) => consoleEl(page).innerText();

test("incremental sync, merge persistence and WAL handling", async ({ page }) => {
  test.setTimeout(10 * 60_000);
  ensureFixtures(["small"]);
  buildWalFixture();
  const errors = watchErrors(page);
  page.on("dialog", (d) => d.accept());

  // ---------- first import ---------------------------------------------------------------------------------------
  await page.goto("/");
  await page.getByTestId("chatdb-input").setInputFiles(fixturePath("small"));
  await page.getByTestId("contacts-input").setInputFiles(addressBooks());
  let run = await runCount(page);
  await page.getByRole("button", { name: /start analysis/i }).click();
  await waitImportDone(page, 120_000, run);
  const first = await messageCount(page);
  expect(first).toBeGreaterThan(500);

  // ---------- incremental sync: only the delta is processed ------------------------------------------------------
  await page.getByRole("button", { name: /sync new messages: upload chat.db again/i }).click();
  await page.getByTestId("chatdb-input").setInputFiles(APPENDED);
  run = await runCount(page);
  await page.getByRole("button", { name: /^sync new messages$/i }).click();
  await waitImportDone(page, 120_000, run);
  const log2 = await logText(page);
  const m2 = /sync complete: (\d+) inserted, (\d+) updated/.exec(log2);
  console.log(`incremental sync: ${m2?.[0]}`);
  expect(m2, log2).toBeTruthy();
  expect(Number(m2![1])).toBeGreaterThan(30);
  expect(Number(m2![1])).toBeLessThanOrEqual(50);
  const second = await messageCount(page);
  expect(second).toBeGreaterThan(first);
  // the delta: new messages minus any that were unsent since (an unsend removes the message)
  expect(second - first).toBeGreaterThanOrEqual(Number(m2![1]) - Number(m2![2]));
  expect(second - first).toBeLessThanOrEqual(Number(m2![1]));

  // ---------- unchanged re-upload is skipped ---------------------------------------------------------------------
  await page.getByRole("button", { name: /sync new messages: upload chat.db again/i }).click();
  await page.getByTestId("chatdb-input").setInputFiles(APPENDED);
  run = await runCount(page);
  await page.getByRole("button", { name: /^sync new messages$/i }).click();
  await waitImportDone(page, 120_000, run);
  expect(await logText(page)).toMatch(/unchanged since last sync/i);
  expect(await messageCount(page)).toBe(second);

  // ---------- contact merge, then it survives a reload -----------------------------------------------------------
  await goto(page, "#/people");
  await expect(page.locator('main a[href*="#/people/"]').first()).toBeVisible({ timeout: 30_000 });
  const peopleBefore = await page.locator('main a[href*="#/people/"]').count();
  expect(peopleBefore).toBeGreaterThan(3);
  await goto(page, "#/merge");
  await expect(page.getByRole("heading", { name: "Merge", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /select a contact/i }).first().click();
  await page.getByRole("button", { name: /Alice Anders/ }).first().click();
  await page.getByRole("button", { name: /select a contact/i }).first().click();
  await page.getByRole("button", { name: /Carol Chen/ }).first().click();
  await page.getByRole("button", { name: /^Merge\?$/ }).first().click();
  await expect(page.getByText(/merged/i).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("main")).toContainText("Carol Chen");
  await shot(page, "merge-done");
  await page.reload();
  await goto(page, "#/merge");
  await expect(page.locator("main")).toContainText("Carol Chen", { timeout: 30_000 }); // history persisted
  await goto(page, "#/people");
  await expect.poll(() => page.locator('main a[href*="#/people/"]').count(), { timeout: 30_000 }).toBe(peopleBefore - 1);
  await expectNoErrorText(page);

  // ---------- WAL: a db copied WITHOUT its -wal misses the newest messages, with it they are imported ----------------
  await goto(page, "#/");
  await page.getByRole("button", { name: /delete all data/i }).click();
  await expect(page.getByRole("heading", { name: "Get started", exact: true })).toBeVisible({ timeout: 60_000 });

  await page.getByTestId("chatdb-input").setInputFiles(WAL_DB);
  await expect(page.getByTestId("wal-warning")).toBeVisible({ timeout: 10_000 });
  run = await runCount(page);
  await page.getByRole("button", { name: /start analysis/i }).click();
  await waitImportDone(page, 120_000, run);
  const withoutWal = await messageCount(page);

  await page.getByRole("button", { name: /sync new messages: upload chat.db again/i }).click();
  await page.getByTestId("chatdb-input").setInputFiles([WAL_DB, WAL_FILE]);
  await expect(page.getByTestId("wal-warning")).toHaveCount(0); // the -wal is supplied: no warning
  run = await runCount(page);
  await page.getByRole("button", { name: /^sync new messages$/i }).click();
  await waitImportDone(page, 120_000, run);
  const log3 = await logText(page);
  const withWal = await messageCount(page);
  console.log(`WAL: without -wal ${withoutWal} msgs, with -wal ${withWal} msgs (${log3.match(/sync complete: [^\n]*/)?.[0]})`);
  // the newest messages exist only in the -wal: they appear when it is supplied (a few copied rows may be skipped types)
  expect(withWal - withoutWal).toBeGreaterThanOrEqual(WAL_EXTRA - 3);
  expect(withWal - withoutWal).toBeLessThanOrEqual(WAL_EXTRA);

  expect(errors, errors.join("\n")).toEqual([]);
});
