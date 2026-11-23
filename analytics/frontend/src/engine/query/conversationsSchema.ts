/**
 * Additive schema snippets owned by the conversations analytics. Unit 1 can append these to its
 * migration list (both are idempotent). Nothing here is required for correctness: the query code
 * falls back to live aggregation when the summary table is empty/missing and to indexed LIKE when
 * the FTS table is absent.
 */

/** Per-conversation counters, refreshed by `refreshConversationSummary` after ingest batches. */
export const SUMMARY_DDL = `
CREATE TABLE IF NOT EXISTS summary_conversation (
  conversation_id TEXT PRIMARY KEY,
  message_count INTEGER NOT NULL,
  first_ts TEXT,
  last_ts TEXT
);
`;

/**
 * Message-search index decision: a trigram FTS5 table (substring-capable, so results match the
 * legacy `LIKE '%q%'` semantics for queries of 3+ characters) over messages.text, backed by the
 * messages table as external content (no second copy of the text, only the trigram index).
 *
 * It is NOT in the default schema because the trigram index is roughly 2-3x the size of the
 * indexed text, which matters in OPFS for multi-GB inputs. Recommended: unit 1 applies
 * FTS_MIGRATION_STATEMENTS lazily (first search / after ingest finishes) when the wa-sqlite build
 * has FTS5 (`SELECT sqlite_compileoption_used('ENABLE_FTS5')`). Triggers keep it in sync for later
 * ingests; FTS_BACKFILL_SQL populates it from existing rows. Until it exists, search uses
 * `text LIKE ? ESCAPE '\\'` restricted by the (conversation_id, timestamp, id) index and LIMIT.
 */
export const FTS_MIGRATION_STATEMENTS: string[] = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
     text, content='messages', content_rowid='rowid', tokenize='trigram'
   )`,
  `CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
     INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
   END`,
  `CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
     INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
   END`,
  `CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF text ON messages BEGIN
     INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
     INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
   END`,
];

/** Run once after creating the FTS table on a database that already has messages. */
export const FTS_BACKFILL_SQL = `INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')`;
