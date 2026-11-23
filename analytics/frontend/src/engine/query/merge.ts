import { inTransaction, registerRoute, RouteError, type SqlDb } from "./shim";
import {
  buildConversationDisplayName,
  conversationDisplayNames,
  displayNameSql,
  getResolvedParticipant,
  splitHandle,
} from "./names";

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
  SELECT p.* FROM participants p WHERE p.id NOT IN (SELECT from_id FROM participant_alias);

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

export function applyMergeMigration(db: SqlDb): void {
  db.exec(MERGE_VIEWS_MIGRATION);
}

export class MergeError extends Error {}

/** SQL fragment: ids that resolve to `?` (the id itself plus everything aliased onto it). Takes 2 binds. */
export const PARTICIPANT_IDS_SQL = `SELECT ? UNION SELECT from_id FROM participant_alias WHERE to_id = ?`;
export const CONVERSATION_IDS_SQL = `SELECT ? UNION SELECT from_id FROM conversation_alias WHERE to_id = ?`;

function count(db: SqlDb, sql: string, id: string): number {
  return db.all<{ c: number }>(sql, [id, id])[0]?.c ?? 0;
}

export function listParticipants(db: SqlDb) {
  const rows = db.all<{ id: string; handle: string | null; is_me: number; name: string }>(
    `SELECT p.id, p.handle, p.is_me, ${displayNameSql("p", "c")} AS name
       FROM v_participants p LEFT JOIN contacts c ON c.handle = p.handle
      ORDER BY LOWER(name), p.id`,
  );
  return rows.map((r) => {
    const handle = r.handle ?? "";
    const { phone_num, email } = splitHandle(handle);
    return { id: r.id, phone_num, email, handle, display_name: r.name, is_me: !!r.is_me };
  });
}

export function listMergeHistory(db: SqlDb) {
  return db.all(
    `SELECT merged_at, keep_id, keep_display_name, keep_handle, keep_message_count,
            remove_id, remove_display_name, remove_handle, remove_message_count
       FROM merge_history ORDER BY merged_at DESC, id DESC`,
  );
}

export function mergeParticipants(db: SqlDb, keepId: string, removeId: string): void {
  if (keepId === removeId) throw new MergeError("Can't merge a contact into itself.");
  const keep = getResolvedParticipant(db, keepId);
  const remove = getResolvedParticipant(db, removeId);
  if (!keep || !remove) throw new MergeError("One or both contacts weren't found.");
  const q = `SELECT COUNT(*) AS c FROM messages WHERE sender_id IN (${PARTICIPANT_IDS_SQL})`;
  const keepCount = count(db, q, keepId);
  const removeCount = count(db, q, removeId);
  inTransaction(db, () => {
    // Flatten: anything previously merged into remove now points at keep.
    db.run(`UPDATE participant_alias SET to_id = ? WHERE to_id = ?`, [keepId, removeId]);
    db.run(`INSERT OR REPLACE INTO participant_alias (from_id, to_id) VALUES (?, ?)`, [removeId, keepId]);
    db.run(
      `INSERT INTO merge_history (merged_at, keep_id, keep_display_name, keep_handle, keep_message_count,
         remove_id, remove_display_name, remove_handle, remove_message_count) VALUES (?,?,?,?,?,?,?,?,?)`,
      [new Date().toISOString(), keepId, keep.display_name, keep.handle, keepCount,
       removeId, remove.display_name, remove.handle, removeCount],
    );
  });
}

export function listConversationsForMerge(db: SqlDb) {
  const convs = db.all<{ id: string; is_group_chat: number; convo_name: string | null }>(
    `SELECT id, is_group_chat, convo_name FROM v_conversations`,
  );
  const counts = new Map(
    db
      .all<{ cid: string; c: number }>(
        `SELECT COALESCE(ca.to_id, mc.conversation_id) AS cid, SUM(mc.c) AS c
           FROM (SELECT conversation_id, COUNT(*) AS c FROM messages GROUP BY conversation_id) mc
           LEFT JOIN conversation_alias ca ON ca.from_id = mc.conversation_id
          GROUP BY cid`,
      )
      .map((r) => [r.cid, r.c]),
  );
  const names = conversationDisplayNames(db, convs.map((c) => c.id));
  const handles = new Map<string, string[]>();
  for (const r of db.all<{ cid: string; handle: string | null }>(
    `SELECT cp.conversation_id AS cid, p.handle
       FROM v_conversation_participants cp JOIN v_participants p ON p.id = cp.participant_id
      WHERE p.is_me = 0 ORDER BY cp.conversation_id, p.id`,
  )) {
    if (!r.handle) continue;
    const l = handles.get(r.cid) ?? [];
    l.push(r.handle);
    handles.set(r.cid, l);
  }
  return convs
    .map((c) => ({
      id: c.id,
      display_name: names.get(c.id) ?? buildConversationDisplayName([], c.convo_name),
      subtext: handles.get(c.id)?.join(", ") || "You",
      is_group_chat: !!c.is_group_chat,
      message_count: counts.get(c.id) ?? 0,
    }))
    .sort((a, b) => a.display_name.toLowerCase().localeCompare(b.display_name.toLowerCase()));
}

export function listConversationMergeHistory(db: SqlDb) {
  return db.all(
    `SELECT merged_at, keep_id, keep_display_name, keep_message_count,
            remove_id, remove_display_name, remove_message_count
       FROM conversation_merge_history ORDER BY merged_at DESC, id DESC`,
  );
}

export function mergeConversations(db: SqlDb, keepId: string, removeId: string): void {
  if (keepId === removeId) throw new MergeError("Can't merge a conversation into itself.");
  const exists = (id: string) => db.all(`SELECT 1 FROM v_conversations WHERE id = ?`, [id]).length > 0;
  if (!exists(keepId) || !exists(removeId)) throw new MergeError("One or both conversations weren't found.");
  const names = conversationDisplayNames(db, [keepId, removeId]);
  const q = `SELECT COUNT(*) AS c FROM messages WHERE conversation_id IN (${CONVERSATION_IDS_SQL})`;
  const keepCount = count(db, q, keepId);
  const removeCount = count(db, q, removeId);
  inTransaction(db, () => {
    db.run(`UPDATE conversation_alias SET to_id = ? WHERE to_id = ?`, [keepId, removeId]);
    db.run(`INSERT OR REPLACE INTO conversation_alias (from_id, to_id) VALUES (?, ?)`, [removeId, keepId]);
    db.run(
      `INSERT INTO conversation_merge_history (merged_at, keep_id, keep_display_name, keep_message_count,
         remove_id, remove_display_name, remove_message_count) VALUES (?,?,?,?,?,?,?)`,
      [new Date().toISOString(), keepId, names.get(keepId) ?? "Unknown", keepCount,
       removeId, names.get(removeId) ?? "Unknown", removeCount],
    );
  });
}

function badRequest<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof MergeError) throw new RouteError(400, e.message);
    throw e;
  }
}

export function registerMergeRoutes(): void {
  registerRoute("GET /api/participants", ({ db }) => ({ participants: listParticipants(db) }));
  registerRoute("GET /api/merge-history", ({ db }) => ({ items: listMergeHistory(db) }));
  registerRoute("POST /api/merge", ({ db, params }) => {
    badRequest(() => mergeParticipants(db, String(params.keep_id), String(params.remove_id)));
    return { ok: true, keep_id: params.keep_id, removed_id: params.remove_id };
  });
  registerRoute("GET /api/conversations-for-merge", ({ db }) => ({ conversations: listConversationsForMerge(db) }));
  registerRoute("GET /api/merge-conversation-history", ({ db }) => ({ items: listConversationMergeHistory(db) }));
  registerRoute("POST /api/merge-conversation", ({ db, params }) => {
    badRequest(() => mergeConversations(db, String(params.keep_id), String(params.remove_id)));
    return { ok: true, keep_id: params.keep_id, removed_id: params.remove_id };
  });
}
