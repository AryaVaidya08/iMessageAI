// `npm run make-fixtures [-- --sizes small,100mb,1gb]` -> tests/.cache (git-ignored). Idempotent: skips existing files.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { appendMessages, generateChatDb, type Size } from "./lib/chatdb";
import { generateAddressBooks } from "./lib/addressbook";

export const CACHE_DIR = join(fileURLToPath(new URL("..", import.meta.url)), "tests", ".cache");

export function fixturePath(size: Size): string {
  return join(CACHE_DIR, `chat-${size}.db`);
}

export function ensureFixtures(sizes: Size[]): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  for (const size of sizes) {
    const out = fixturePath(size);
    if (!existsSync(out)) {
      const r = generateChatDb({ out, size });
      console.log(`generated ${out}: ${r.messages} msgs, ${(r.bytes / 1048576).toFixed(0)} MB`);
    }
  }
  if (sizes.includes("small")) {
    const appended = join(CACHE_DIR, "chat-small-appended.db");
    if (!existsSync(appended)) {
      generateChatDb({ out: appended, size: "small" });
      const r = appendMessages({ db: appended, count: 50, mutateExisting: 2 });
      console.log(`generated ${appended} (+${r.added} msgs, ${r.edited} edited, ${r.retracted} retracted)`);
    }
  }
  const ab = join(CACHE_DIR, "addressbook");
  if (!existsSync(ab)) generateAddressBooks(ab);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values } = parseArgs({ options: { sizes: { type: "string", default: "small,100mb" } } });
  ensureFixtures(values.sizes!.split(",") as Size[]);
}
