import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { QueryDb, SqlValue } from "../types";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
type DatabaseSync = DatabaseSyncType;
const HERE = dirname(fileURLToPath(import.meta.url));

/** App-DB subset (engine/schema.ts contract) used by the conversation queries. */
export const TEST_SCHEMA = `
CREATE TABLE participants (id TEXT PRIMARY KEY, phone_num TEXT, email TEXT, is_me INTEGER NOT NULL DEFAULT 0, handle TEXT, display_name TEXT);
CREATE TABLE conversations (id TEXT PRIMARY KEY, is_group_chat INTEGER NOT NULL, relationship_type TEXT NOT NULL, convo_name TEXT, chat_guid TEXT, chat_rowid INTEGER);
CREATE TABLE conversation_participants (conversation_id TEXT NOT NULL, participant_id TEXT NOT NULL, PRIMARY KEY (conversation_id, participant_id));
CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sender_id TEXT NOT NULL, timestamp TEXT NOT NULL, text TEXT NOT NULL,
  has_attachment INTEGER NOT NULL DEFAULT 0, has_sticker INTEGER NOT NULL DEFAULT 0, reply_to TEXT, rowid_src INTEGER, guid TEXT, date_edited TEXT, date_retracted TEXT, service TEXT, is_from_me INTEGER);
CREATE TABLE tapbacks (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, reactor_id TEXT NOT NULL, action TEXT NOT NULL, UNIQUE(message_id, reactor_id, action));
CREATE TABLE announcements (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, datetime TEXT NOT NULL, announcer_id TEXT NOT NULL, action TEXT NOT NULL, affected_id TEXT);
CREATE TABLE contacts (handle TEXT PRIMARY KEY, display_name TEXT);
CREATE TABLE participant_alias (from_id TEXT PRIMARY KEY, to_id TEXT NOT NULL);
CREATE TABLE conversation_alias (from_id TEXT PRIMARY KEY, to_id TEXT NOT NULL);
CREATE INDEX idx_messages_convo_ts_id ON messages(conversation_id, timestamp, id);
CREATE INDEX idx_messages_reply_to ON messages(reply_to);
CREATE INDEX idx_tapbacks_message ON tapbacks(message_id);
CREATE INDEX idx_announcements_conversation ON announcements(conversation_id);
`;

export function nodeDb(db: DatabaseSync): QueryDb {
  return {
    async all(sql, params = []) {
      return db.prepare(sql).all(...(params as SqlValue[] as never[])) as never;
    },
    async run(sql, params = []) {
      const r = db.prepare(sql).run(...(params as SqlValue[] as never[]));
      return { changes: Number(r.changes) };
    },
  };
}

export interface Fixture {
  participants: Record<string, unknown>[];
  conversations: Record<string, unknown>[];
  conversation_participants: Record<string, unknown>[];
  messages: Record<string, unknown>[];
  tapbacks: Record<string, unknown>[];
  announcements: Record<string, unknown>[];
  contacts: Record<string, unknown>[];
}

export function loadFixture(): Fixture {
  return JSON.parse(readFileSync(join(HERE, "fixtures", "fixture.json"), "utf8"));
}

export function loadGolden(): Record<string, { status: number; body: any }> {
  return JSON.parse(readFileSync(join(HERE, "fixtures", "golden.json"), "utf8"));
}

export function buildDb(fx: Fixture = loadFixture()): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(TEST_SCHEMA);
  for (const [table, rows] of Object.entries(fx)) {
    for (const r of rows) {
      const cols = Object.keys(r);
      db.prepare(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...(Object.values(r) as never[]));
    }
  }
  // New-schema columns derived from the legacy fixture.
  db.exec("UPDATE participants SET handle = COALESCE(phone_num, email)");
  return db;
}
