// Source of truth for the in-browser app DB schema. Pure SQL strings; no runtime deps,
// so it can be unit-tested in Node (better-sqlite3) and applied in-browser (wa-sqlite).
//
// IDs are deterministic: conversations.id = chat_guid, participants.id = normalized
// handle (E.164 phone or lowercase email) or 'me'. Timestamps are ISO 8601 UTC text.

import { CONVERSATION_SUMMARY_DDL, MERGE_VIEWS_MIGRATION, OVERVIEW_SUMMARY_DDL } from "./ddl";

export interface Migration {
  version: number;
  sql: string;
}

const V1 = `
CREATE TABLE IF NOT EXISTS participants (
    id TEXT PRIMARY KEY,
    phone_num TEXT,
    email TEXT,
    is_me INTEGER NOT NULL DEFAULT 0,
    handle TEXT,
    display_name TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    is_group_chat INTEGER NOT NULL,
    relationship_type TEXT NOT NULL,
    convo_name TEXT,
    chat_guid TEXT UNIQUE,
    chat_rowid INTEGER
);

CREATE TABLE IF NOT EXISTS conversation_participants (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    PRIMARY KEY (conversation_id, participant_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES participants(id),
    timestamp TEXT NOT NULL,
    text TEXT NOT NULL,
    has_attachment INTEGER NOT NULL DEFAULT 0,
    has_sticker INTEGER NOT NULL DEFAULT 0,
    reply_to TEXT,
    rowid_src INTEGER,
    guid TEXT, -- equals id; no separate UNIQUE index (id is the primary key) to keep the IndexedDB footprint small
    date_edited TEXT,
    date_retracted TEXT,
    service TEXT,
    is_from_me INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tapbacks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- no FK on message_id: a reaction can arrive before (or without) its target message
    message_id TEXT NOT NULL,
    reactor_id TEXT NOT NULL REFERENCES participants(id),
    action TEXT NOT NULL,
    UNIQUE(message_id, reactor_id, action)
);

CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    datetime TEXT NOT NULL,
    announcer_id TEXT NOT NULL REFERENCES participants(id),
    action TEXT NOT NULL,
    affected_id TEXT REFERENCES participants(id)
);

CREATE TABLE IF NOT EXISTS contacts (
    handle TEXT PRIMARY KEY,
    display_name TEXT
);

CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT
);

${MERGE_VIEWS_MIGRATION}
${OVERVIEW_SUMMARY_DDL}
${CONVERSATION_SUMMARY_DDL}

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to);
CREATE INDEX IF NOT EXISTS idx_messages_convo_ts_id ON messages(conversation_id, timestamp, id);
CREATE INDEX IF NOT EXISTS idx_tapbacks_message ON tapbacks(message_id);
CREATE INDEX IF NOT EXISTS idx_announcements_conversation ON announcements(conversation_id);
`;

/** Append new migrations here; never edit a released one. */
export const MIGRATIONS: Migration[] = [{ version: 1, sql: V1 }];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/** Minimal executor so the same migrate() runs on wa-sqlite and better-sqlite3. */
export interface SqlRunner {
  exec(sql: string): void | Promise<void>;
  getUserVersion(): number | Promise<number>;
  setUserVersion(v: number): void | Promise<void>;
}

/** Applies pending migrations, each in its own transaction. Returns the final version. */
export async function migrate(db: SqlRunner): Promise<number> {
  let current = await db.getUserVersion();
  if (current > SCHEMA_VERSION) {
    throw new Error(`DB schema v${current} is newer than app schema v${SCHEMA_VERSION}`);
  }
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    // IMMEDIATE takes the write lock up front; re-read the version inside it so two workers opening
    // the same DB at once don't both run the migration.
    await db.exec("BEGIN IMMEDIATE");
    try {
      const inside = await db.getUserVersion();
      if (inside < m.version) {
        await db.exec(m.sql);
        await db.setUserVersion(m.version);
      }
      await db.exec("COMMIT");
      current = Math.max(inside, m.version);
    } catch (e) {
      await db.exec("ROLLBACK");
      throw e;
    }
  }
  return current;
}
