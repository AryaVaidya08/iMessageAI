// Incremental sync with the real pipeline (extractor -> orchestrator -> writer), Node SQLite backend:
// first import, re-import of a chat.db that gained messages + one edit + one unsend, then an unchanged re-import.
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { CACHE_DIR, ensureFixtures, fixturePath } from "../scripts/make-fixtures";
import { migrate } from "../src/engine/schema";
import { ingestInto, nodeAppDb } from "./helpers/engine-impl";
import type { IngestEvent } from "../src/engine/protocol";

const done = (ev: IngestEvent[]) => ev.find((e) => e.type === "done") as Extract<IngestEvent, { type: "done" }>;
const count = (app: ReturnType<typeof nodeAppDb>, t: string) =>
  (app.raw.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;

describe("incremental sync", () => {
  const app = nodeAppDb();
  let base: string;
  let appended: string;
  let first: IngestEvent[];
  let second: IngestEvent[];
  let third: IngestEvent[];
  let afterFirst: { messages: number; announcements: number };

  beforeAll(async () => {
    ensureFixtures(["small"]);
    base = fixturePath("small");
    appended = join(CACHE_DIR, "chat-small-appended.db");
    await migrate({
      exec: (s) => void app.raw.exec(s),
      getUserVersion: () => app.raw.pragma("user_version", { simple: true }) as number,
      setUserVersion: (v) => void app.raw.pragma(`user_version = ${v}`),
    });
    first = await ingestInto(app, { chatDbPath: base, addressBookDir: join(CACHE_DIR, "addressbook") });
    afterFirst = { messages: count(app, "messages"), announcements: count(app, "announcements") };
    second = await ingestInto(app, { chatDbPath: appended });
    third = await ingestInto(app, { chatDbPath: appended });
  }, 120_000);

  it("first import loads everything and finishes cleanly", () => {
    expect(first.some((e) => e.type === "error")).toBe(false);
    expect(done(first)).toMatchObject({ cancelled: false, skipped: false });
    expect(afterFirst.messages).toBeGreaterThan(500);
  });

  it("re-import processes only what changed", () => {
    const d = done(second);
    expect(d.skipped).toBe(false);
    // only the appended messages are inserted (the rest is ROWID-filtered out before it is even read)
    expect(d.inserted).toBeGreaterThan(30);
    expect(d.inserted).toBeLessThanOrEqual(50);
    expect(count(app, "messages")).toBeGreaterThan(afterFirst.messages);
    const scanned = second.filter((e) => e.type === "overall").pop() as { messagesTotal: number };
    expect(scanned.messagesTotal).toBeLessThan(100); // progress total = the delta, not the whole chat.db
  });

  it("applies the edit and the unsend that happened after the first import", () => {
    const edited = app.raw.prepare("SELECT COUNT(*) n FROM messages WHERE date_edited IS NOT NULL").get() as { n: number };
    expect(edited.n).toBeGreaterThanOrEqual(1);
    // an unsent message is removed from messages and recorded as an announcement
    expect(count(app, "announcements")).toBeGreaterThan(afterFirst.announcements);
  });

  it("an unchanged chat.db is skipped", () => {
    expect(done(third)).toMatchObject({ skipped: true, inserted: 0, updated: 0 });
  });

  it("is idempotent: no duplicate messages", () => {
    const dup = app.raw.prepare("SELECT COUNT(*) n FROM (SELECT guid FROM messages GROUP BY guid HAVING COUNT(*) > 1)").get() as { n: number };
    expect(dup.n).toBe(0);
  });
});
