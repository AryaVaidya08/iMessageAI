// Single source of truth for the SQL fragments shared by the schema (schema.ts) and the query modules.
// Pure strings: no imports, so it can be used from Node tests and from any worker.

/**
 * Additive migration for unit 1 (schema.ts): alias tables, merge history tables and the
 * alias-resolving views. All statements are idempotent.
 *
 * View names (read paths in units 9, 10, 12 should query these instead of the base tables):
 *   v_participants               participants not merged away
 *   v_conversations              conversations not merged away
 *   v_conversation_participants  (conversation_id, participant_id), both alias-resolved, deduped
 *   v_messages                   messages with conversation_id / sender_id alias-resolved
 *   v_tapbacks                   tapbacks with reactor_id alias-resolved, deduped on (message, reactor, action)
 *   v_announcements              announcements with conversation/announcer/affected alias-resolved
 *
 * Aliases are always flattened (to_id is never itself a from_id), so a single LEFT JOIN resolves.
 * Because merges are just alias rows, re-ingesting the removed id's rows later still resolves to the
 * kept id. Index-friendly point lookups should instead expand ids with
 *   `SELECT ? UNION SELECT from_id FROM participant_alias WHERE to_id = ?`
 * and filter the base table, since COALESCE() columns in v_messages cannot use the sender index.
 */
export const MERGE_VIEWS_MIGRATION = `
CREATE TABLE IF NOT EXISTS participant_alias (from_id TEXT PRIMARY KEY, to_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conversation_alias (from_id TEXT PRIMARY KEY, to_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_participant_alias_to ON participant_alias(to_id);
CREATE INDEX IF NOT EXISTS idx_conversation_alias_to ON conversation_alias(to_id);

CREATE TABLE IF NOT EXISTS merge_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merged_at TEXT NOT NULL,
  keep_id TEXT NOT NULL,
  keep_display_name TEXT NOT NULL,
  keep_handle TEXT NOT NULL,
  keep_message_count INTEGER NOT NULL DEFAULT 0,
  remove_id TEXT NOT NULL,
  remove_display_name TEXT NOT NULL,
  remove_handle TEXT NOT NULL,
  remove_message_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS conversation_merge_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merged_at TEXT NOT NULL,
  keep_id TEXT NOT NULL,
  keep_display_name TEXT NOT NULL,
  keep_message_count INTEGER NOT NULL DEFAULT 0,
  remove_id TEXT NOT NULL,
  remove_display_name TEXT NOT NULL,
  remove_message_count INTEGER NOT NULL DEFAULT 0
);

CREATE VIEW IF NOT EXISTS v_participants AS
  SELECT p.*, p.rowid AS seq FROM participants p WHERE p.id NOT IN (SELECT from_id FROM participant_alias);

CREATE VIEW IF NOT EXISTS v_conversations AS
  SELECT c.* FROM conversations c WHERE c.id NOT IN (SELECT from_id FROM conversation_alias);

CREATE VIEW IF NOT EXISTS v_conversation_participants AS
  SELECT DISTINCT COALESCE(ca.to_id, cp.conversation_id) AS conversation_id,
                  COALESCE(pa.to_id, cp.participant_id) AS participant_id
    FROM conversation_participants cp
    LEFT JOIN conversation_alias ca ON ca.from_id = cp.conversation_id
    LEFT JOIN participant_alias pa ON pa.from_id = cp.participant_id;

CREATE VIEW IF NOT EXISTS v_messages AS
  SELECT m.id, COALESCE(ca.to_id, m.conversation_id) AS conversation_id,
         COALESCE(pa.to_id, m.sender_id) AS sender_id, m.timestamp, m.text,
         m.has_attachment, m.has_sticker, m.reply_to, m.rowid_src, m.guid,
         m.date_edited, m.date_retracted, m.service, m.is_from_me
    FROM messages m
    LEFT JOIN conversation_alias ca ON ca.from_id = m.conversation_id
    LEFT JOIN participant_alias pa ON pa.from_id = m.sender_id;

CREATE VIEW IF NOT EXISTS v_tapbacks AS
  SELECT MIN(t.id) AS id, t.message_id, COALESCE(pa.to_id, t.reactor_id) AS reactor_id, t.action
    FROM tapbacks t LEFT JOIN participant_alias pa ON pa.from_id = t.reactor_id
   GROUP BY t.message_id, COALESCE(pa.to_id, t.reactor_id), t.action;

CREATE VIEW IF NOT EXISTS v_announcements AS
  SELECT a.id, COALESCE(ca.to_id, a.conversation_id) AS conversation_id, a.datetime,
         COALESCE(pa.to_id, a.announcer_id) AS announcer_id, a.action,
         COALESCE(pb.to_id, a.affected_id) AS affected_id
    FROM announcements a
    LEFT JOIN conversation_alias ca ON ca.from_id = a.conversation_id
    LEFT JOIN participant_alias pa ON pa.from_id = a.announcer_id
    LEFT JOIN participant_alias pb ON pb.from_id = a.affected_id;
`;

/** Overview summary caches (refreshed per changed conversation by refreshOverviewSummary). */
export const OVERVIEW_SUMMARY_DDL = `
CREATE TABLE IF NOT EXISTS summary_overview_conv (
  conversation_id TEXT PRIMARY KEY,
  message_count INTEGER NOT NULL,
  min_ts TEXT,
  max_ts TEXT
);
CREATE TABLE IF NOT EXISTS summary_overview_daily (
  conversation_id TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, day)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS summary_overview_dow_hour (
  conversation_id TEXT NOT NULL,
  dow INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, dow, hour)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS summary_reply_delta (
  conversation_id TEXT NOT NULL,
  delta_ms INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, delta_ms)
) WITHOUT ROWID;
`;

/** Per-conversation counters (refreshed by refreshConversationSummary). */
export const CONVERSATION_SUMMARY_DDL = `
CREATE TABLE IF NOT EXISTS summary_conversation (
  conversation_id TEXT PRIMARY KEY,
  message_count INTEGER NOT NULL,
  first_ts TEXT,
  last_ts TEXT
);
`;
