import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "../scripts/lib/sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { appendMessages, decodeAttributedBody, fromAppleNs, generateChatDb, makeAttributedBody } from "../scripts/lib/chatdb";
import { generateAddressBooks } from "../scripts/lib/addressbook";
import { diff, normalize, canonTimestamp } from "./helpers/diff";

const dir = mkdtempSync(join(tmpdir(), "chatdb-gen-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const q = (path: string, sql: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(sql).all() as Record<string, number | string | null>[];
  } finally {
    db.close();
  }
};

describe("synthetic chat.db generator", () => {
  const a = join(dir, "a.db");
  const b = join(dir, "b.db");
  generateChatDb({ out: a, size: "small", seed: 1 });
  generateChatDb({ out: b, size: "small", seed: 1 });

  it("is deterministic for the same seed and differs for another", () => {
    expect(readFileSync(a).equals(readFileSync(b))).toBe(true);
    const c = join(dir, "c.db");
    generateChatDb({ out: c, size: "small", seed: 2 });
    expect(readFileSync(a).equals(readFileSync(c))).toBe(false);
  });

  it("uses the macOS schema tables/columns", () => {
    const tables = q(a, "SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
    for (const t of ["message", "handle", "chat", "chat_message_join", "chat_handle_join", "attachment", "message_attachment_join"]) {
      expect(tables).toContain(t);
    }
    const cols = q(a, "PRAGMA table_info(message)").map((r) => r.name);
    for (const c of ["ROWID", "guid", "text", "attributedBody", "date", "is_from_me", "associated_message_type", "date_edited", "date_retracted", "item_type"]) {
      expect(cols).toContain(c);
    }
  });

  it("contains every message kind the engine must handle", () => {
    const [n] = q(a, `SELECT COUNT(*) AS total,
      SUM(date_edited IS NOT NULL) AS edited, SUM(date_retracted IS NOT NULL) AS retracted,
      SUM(associated_message_type BETWEEN 2000 AND 2005) AS tapbacks, SUM(associated_message_type >= 3000) AS removals,
      SUM(item_type = 1) AS addremove, SUM(item_type = 3) AS leaves, SUM(item_type = 2) AS renames,
      SUM(text IS NULL AND attributedBody IS NOT NULL) AS bodyOnly, SUM(reply_to_guid IS NOT NULL) AS replies,
      SUM(cache_has_attachments) AS attachments FROM message`);
    expect(n.total).toBe(600);
    for (const k of ["edited", "retracted", "tapbacks", "addremove", "leaves", "renames", "bodyOnly", "replies", "attachments"]) {
      expect(Number(n[k]), k).toBeGreaterThan(0);
    }
    expect(q(a, "SELECT COUNT(*) AS n FROM chat WHERE style = 43 AND display_name IS NOT NULL")[0].n).toBeGreaterThan(0);
    expect(q(a, "SELECT COUNT(*) AS n FROM chat WHERE style = 43 AND display_name IS NULL")[0].n).toBeGreaterThan(0);
  });

  it("stores Apple-epoch nanosecond dates in 2024 and ROWID order is chronological", () => {
    const db = new DatabaseSync(a, { readOnly: true });
    const st = db.prepare("SELECT MIN(date) AS lo, MAX(date) AS hi FROM message");
    st.setReadBigInts(true);
    const r = st.get() as { lo: bigint; hi: bigint };
    db.close();
    expect(new Date(fromAppleNs(r.lo)).getUTCFullYear()).toBe(2024);
    expect(r.hi > r.lo).toBe(true);
    expect(q(a, "SELECT COUNT(*) AS n FROM message m1 JOIN message m2 ON m2.ROWID = m1.ROWID + 1 WHERE m2.date < m1.date")[0].n).toBe(0);
  });

  it("attributedBody round-trips and edited rows have text after date", () => {
    expect(decodeAttributedBody(makeAttributedBody("hi 😂"))).toBe("hi 😂");
    const long = "x".repeat(300);
    expect(decodeAttributedBody(makeAttributedBody(long))).toBe(long);
    const rows = q(a, "SELECT attributedBody FROM message WHERE text IS NULL AND attributedBody IS NOT NULL LIMIT 5");
    for (const r of rows) expect(decodeAttributedBody(r.attributedBody as unknown as Uint8Array)).toBeTruthy();
    expect(q(a, "SELECT COUNT(*) AS n FROM message WHERE date_edited IS NOT NULL AND date_edited <= date")[0].n).toBe(0);
  });

  it("append mode adds higher ROWIDs/later dates, mutates old rows, and is deterministic", () => {
    const x = join(dir, "x.db");
    const y = join(dir, "y.db");
    for (const p of [x, y]) {
      generateChatDb({ out: p, size: "small", seed: 1 });
    }
    const before = q(x, "SELECT MAX(ROWID) AS m, CAST(MAX(date) AS TEXT) AS d FROM message")[0];
    const r1 = appendMessages({ db: x, count: 40, seed: 5, mutateExisting: 2 });
    appendMessages({ db: y, count: 40, seed: 5, mutateExisting: 2 });
    expect(r1.added).toBe(40);
    expect(r1.edited + r1.retracted).toBe(2);
    const after = q(x, "SELECT MAX(ROWID) AS m, CAST(MAX(date) AS TEXT) AS d FROM message")[0];
    expect(Number(after.m)).toBe(Number(before.m) + 40);
    expect(BigInt(after.d as string) > BigInt(before.d as string)).toBe(true);
    expect(q(x, "SELECT COUNT(*) AS n FROM message WHERE ROWID > " + before.m + " AND date <= " + before.d)[0].n).toBe(0);
    expect(readFileSync(x).equals(readFileSync(y))).toBe(true);
  });

});

describe("synthetic AddressBook generator", () => {
  it("writes Core Data tables across legacy file + Sources/*", () => {
    const files = generateAddressBooks(join(dir, "ab"));
    expect(files).toHaveLength(3);
    let people = 0;
    for (const f of files) {
      people += Number(q(f, "SELECT COUNT(*) AS n FROM ZABCDRECORD")[0].n);
      expect(q(f, "SELECT name FROM sqlite_master WHERE name LIKE 'ZABCD%'").length).toBe(3);
    }
    expect(people).toBeGreaterThanOrEqual(6);
    expect(q(files[0], "SELECT ZFULLNUMBER FROM ZABCDPHONENUMBER").length).toBeGreaterThan(0);
  });
});

describe("parity diff helper", () => {
  it("tolerates floats and canonicalizes timestamps/ids", () => {
    const t = new Map([["11111111-1111-1111-1111-111111111111", "conv:X"], ["X", "conv:X"]]);
    const legacy = normalize({ id: "11111111-1111-1111-1111-111111111111", ts: "2024-01-01T09:00:00.5", v: 0.1 + 0.2, merged_at: "now" }, t);
    const fresh = normalize({ id: "X", ts: "2024-01-01T09:00:00.500Z", v: 0.3, merged_at: "later" }, t);
    expect(diff(legacy, fresh)).toEqual([]);
    expect(canonTimestamp("2024-01-01T09:00:00")).toBe("2024-01-01T09:00:00.000");
    expect(diff({ a: [1, 2] }, { a: [1, 3] })).toHaveLength(1);
    expect(diff({ a: 1 }, { b: 1 })).toHaveLength(2);
  });
});
