import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { CACHE_DIR, ensureFixtures, fixturePath } from "../../scripts/make-fixtures";
import { consoleEl, SHOTS, watchErrors } from "./helpers";

// The import console lives on the home page (in the page flow, under the "Importing" card) and its small
// status dot turns green once the import has finished without errors.
test("home page shows the import console inline and turns its dot green when complete", async ({ page }) => {
  ensureFixtures(["small"]);
  const errors = watchErrors(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "iMessage Analytics" })).toBeVisible();

  // Nothing to show before an import starts.
  await expect(consoleEl(page)).toHaveCount(0);

  await page.getByTestId("chatdb-input").setInputFiles(fixturePath("small"));
  await page.getByTestId("contacts-input").setInputFiles(join(CACHE_DIR, "addressbook", "AddressBook-v22.abcddb"));
  await page.getByRole("button", { name: /start analysis/i }).click();

  // It appears on the home page itself, in the flow (not the floating bottom-right dock).
  await expect(consoleEl(page)).toBeVisible();
  await expect(consoleEl(page)).toHaveCount(1); // the floating dock is hidden on "/"
  expect(await consoleEl(page).evaluate((el) => getComputedStyle(el).position)).toBe("static");

  // Under the "Importing..." card while that card is still on screen.
  const card = page.getByRole("heading", { name: /importing/i });
  if (await card.isVisible().catch(() => false)) {
    const cardBox = await card.boundingBox();
    const consoleBox = await consoleEl(page).boundingBox();
    if (cardBox && consoleBox) expect(consoleBox.y).toBeGreaterThan(cardBox.y);
  }

  // Not green while running; green once 100% complete.
  const dot = page.getByTestId("debug-console-dot");
  await expect(consoleEl(page)).toContainText(/ingest complete/i, { timeout: 120_000 });
  await expect(consoleEl(page)).toHaveAttribute("data-state", "done");
  await expect(consoleEl(page)).toContainText("100%");
  await expect.poll(() => dot.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(48, 209, 88)");

  // Still on screen after completion (not auto-collapsed), so the green dot can be seen.
  await page.waitForTimeout(6000);
  await expect(consoleEl(page)).toBeVisible();
  await expect(consoleEl(page)).toContainText(/current chat/i);
  await consoleEl(page).screenshot({ path: join(SHOTS, "console-inline-done.png") });
  await page.screenshot({ path: join(SHOTS, "home-console-inline-done.png"), fullPage: true });

  // On another page the floating dock is available again.
  await page.evaluate(() => {
    location.hash = "#/people";
  });
  await expect(page.getByTestId("debug-console")).toHaveCount(1);
  expect(await consoleEl(page).evaluate((el) => getComputedStyle(el).position)).toBe("fixed");

  expect(errors).toEqual([]);
});
