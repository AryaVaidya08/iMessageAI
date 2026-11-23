// Real-browser end-to-end on the production build: upload -> import (browse WHILE it parses) -> every page
// -> reload persistence -> delete all data. Fixture: synthetic 100 MB chat.db + synthetic AddressBook.
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { CACHE_DIR, ensureFixtures, fixturePath } from "../../scripts/make-fixtures";
import { consoleEl, expectNoErrorText, goto, shot, waitImportDone, watchErrors } from "./helpers";

test("full flow on a 100 MB chat.db", async ({ page }) => {
  test.setTimeout(30 * 60_000);
  ensureFixtures(["100mb"]);
  const errors = watchErrors(page);
  page.on("dialog", (d) => d.accept()); // the delete-all-data confirm()

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Get started", exact: true })).toBeVisible();
  await page.getByTestId("chatdb-input").setInputFiles(fixturePath("100mb"));
  await page.getByTestId("contacts-input").setInputFiles(join(CACHE_DIR, "addressbook", "AddressBook-v22.abcddb"));
  await page.getByRole("button", { name: /start analysis/i }).click();
  await expect(consoleEl(page)).toHaveAttribute("data-state", "running", { timeout: 60_000 });

  // ---- data is viewable WHILE the import is still running ------------------------------------------------------
  await goto(page, "#/conversations");
  const rows = page.locator('main a[href*="#/conversations/"]');
  await expect(rows.first()).toBeVisible({ timeout: 120_000 });
  expect(await consoleEl(page).getAttribute("data-state"), "conversations listed while still importing").toBe("running");
  const midCount = await rows.count();
  await shot(page, "mid-import-conversations");
  await goto(page, "#/people");
  await expect(page.locator('main a[href*="#/people/"]').first()).toBeVisible({ timeout: 60_000 });
  await goto(page, "#/overview");
  await expect(page.getByRole("heading", { name: "Your texting life" })).toBeVisible();
  await shot(page, "mid-import-overview");
  console.log(`browsed while importing: ${midCount} conversations visible, state=${await consoleEl(page).getAttribute("data-state")}`);

  await waitImportDone(page);
  await shot(page, "import-done");

  // ---- every page after the import ----------------------------------------------------------------------------
  await goto(page, "#/overview");
  await expect(page.getByRole("heading", { name: "Your texting life" })).toBeVisible();
  await expect(page.locator("main")).toContainText(/\d[\d,]{3,}/); // big numbers rendered
  await expectNoErrorText(page);
  await shot(page, "overview");

  await goto(page, "#/conversations");
  await expect(rows.first()).toBeVisible({ timeout: 90_000 });
  await expectNoErrorText(page);
  await rows.first().click();
  await expect(page.locator("main")).not.toContainText(/loading/i, { timeout: 60_000 });
  await expectNoErrorText(page);
  // the per-conversation volume chart must actually draw bars (not just axes)
  await expect(page.locator(".recharts-bar-rectangle").first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500); // let chart animations settle before the screenshot
  await shot(page, "conversation-detail");

  await goto(page, "#/people");
  const people = page.locator('main a[href*="#/people/"]');
  await expect(people.first()).toBeVisible({ timeout: 90_000 });
  await people.first().click();
  await expect(page.locator("main")).not.toContainText(/loading/i, { timeout: 60_000 });
  await expectNoErrorText(page);
  await shot(page, "person-detail");

  await goto(page, "#/merge");
  await expect(page.getByRole("heading", { name: "Merge", exact: true })).toBeVisible();
  await expectNoErrorText(page);
  await shot(page, "merge");

  await goto(page, "#/share");
  await expect(page.getByRole("heading", { name: "Share", exact: true })).toBeVisible();
  await expectNoErrorText(page);

  await goto(page, "#/definitely-not-a-page");
  await expect(page.locator("main")).toContainText(/not found|404/i);

  // ---- persistence across reload -----------------------------------------------------------------------------
  await page.reload();
  await page.evaluate(() => (location.hash = "#/"));
  await expect(page.getByRole("heading", { name: "Your data", exact: true })).toBeVisible({ timeout: 60_000 });
  await goto(page, "#/overview");
  await expect(page.locator("main")).toContainText(/\d[\d,]{3,}/);

  // ---- delete all data ---------------------------------------------------------------------------------------
  await goto(page, "#/");
  await page.getByRole("button", { name: /delete all data/i }).click();
  await expect(page.getByRole("heading", { name: "Get started", exact: true })).toBeVisible({ timeout: 60_000 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Get started", exact: true })).toBeVisible();
  const dbs = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
  expect(dbs).not.toContain("imessage-analytics-db");

  expect(errors, errors.join("\n")).toEqual([]);
});
