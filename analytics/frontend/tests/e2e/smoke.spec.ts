import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { CACHE_DIR, ensureFixtures, fixturePath } from "../../scripts/make-fixtures";

test("smoke: upload the small fixture and finish an import", async ({ page }) => {
  ensureFixtures(["small"]);
  const logs: string[] = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "iMessage Analytics" })).toBeVisible();
  await page.getByTestId("chatdb-input").setInputFiles(fixturePath("small"));
  await page.getByTestId("contacts-input").setInputFiles(join(CACHE_DIR, "addressbook", "AddressBook-v22.abcddb"));
  await page.getByRole("button", { name: /start analysis/i }).click();
  try {
    await expect(page.getByTestId("debug-console")).toContainText(/ingest complete/i, { timeout: 120_000 });
  } finally {
    console.log(logs.slice(-40).join("\n"));
    console.log("CONSOLE TEXT:\n" + (await page.getByTestId("debug-console").innerText().catch(() => "(none)")));
  }
});
