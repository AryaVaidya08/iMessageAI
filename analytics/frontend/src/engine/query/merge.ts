import { inTransaction, registerRoute, RouteError, type SqlDb } from "./shim";
import {
  buildConversationDisplayName,
  conversationDisplayNames,
  displayNameSql,
  getResolvedParticipant,
  splitHandle,
} from "./names";

import { MERGE_VIEWS_MIGRATION } from "../ddl";
import { publishDataChanged } from "../events";
import { refreshOverviewSummary } from "./overview";
export { MERGE_VIEWS_MIGRATION };

export async function applyMergeMigration(db: SqlDb): Promise<void> {
  await db.exec(MERGE_VIEWS_MIGRATION);
}

export class MergeError extends Error {}

/** SQL fragment: ids that resolve to `?` (the id itself plus everything aliased onto it). Takes 2 binds. */
export const PARTICIPANT_IDS_SQL = `SELECT ? UNION SELECT from_id FROM participant_alias WHERE to_id = ?`;
export const CONVERSATION_IDS_SQL = `SELECT ? UNION SELECT from_id FROM conversation_alias WHERE to_id = ?`;

async function count(db: SqlDb, sql: string, id: string): Promise<number> {
  return (await db.all<{ c: number }>(sql, [id, id]))[0]?.c ?? 0;
}

export async function listParticipants(db: SqlDb) {
  const rows = await db.all<{ id: string; handle: string | null; is_me: number; name: string }>(
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

export async function listMergeHistory(db: SqlDb) {
  return await db.all(
    `SELECT merged_at, keep_id, keep_display_name, keep_handle, keep_message_count,
            remove_id, remove_display_name, remove_handle, remove_message_count
       FROM merge_history ORDER BY merged_at DESC, id DESC`,
  );
}

export async function mergeParticipants(db: SqlDb, keepId: string, removeId: string): Promise<void> {
  if (keepId === removeId) throw new MergeError("Can't merge a contact into itself.");
  const keep = await getResolvedParticipant(db, keepId);
  const remove = await getResolvedParticipant(db, removeId);
  if (!keep || !remove) throw new MergeError("One or both contacts weren't found.");
  if (keep.is_me || remove.is_me) throw new MergeError("Can't merge yourself with another contact.");
  const q = `SELECT COUNT(*) AS c FROM messages WHERE sender_id IN (${PARTICIPANT_IDS_SQL})`;
  const keepCount = await count(db, q, keepId);
  const removeCount = await count(db, q, removeId);
  await inTransaction(db, async () => {
    // Flatten: anything previously merged into remove now points at keep.
    await db.run(`UPDATE participant_alias SET to_id = ? WHERE to_id = ?`, [keepId, removeId]);
    await db.run(`INSERT OR REPLACE INTO participant_alias (from_id, to_id) VALUES (?, ?)`, [removeId, keepId]);
    await db.run(
      `INSERT INTO merge_history (merged_at, keep_id, keep_display_name, keep_handle, keep_message_count,
         remove_id, remove_display_name, remove_handle, remove_message_count) VALUES (?,?,?,?,?,?,?,?,?)`,
      [new Date().toISOString(), keepId, keep.display_name, keep.handle, keepCount,
       removeId, remove.display_name, remove.handle, removeCount],
    );
  });
}

export async function listConversationsForMerge(db: SqlDb) {
  const convs = await db.all<{ id: string; is_group_chat: number; convo_name: string | null }>(
    `SELECT id, is_group_chat, convo_name FROM v_conversations`,
  );
  const counts = new Map(
    (await db
      .all<{ cid: string; c: number }>(
        `SELECT COALESCE(ca.to_id, mc.conversation_id) AS cid, SUM(mc.c) AS c
           FROM (SELECT conversation_id, COUNT(*) AS c FROM messages GROUP BY conversation_id) mc
           LEFT JOIN conversation_alias ca ON ca.from_id = mc.conversation_id
          GROUP BY cid`,
      ))
      .map((r) => [r.cid, r.c] as [string, number]),
  );
  const names = await conversationDisplayNames(db, convs.map((c) => c.id));
  const handles = new Map<string, string[]>();
  for (const r of await db.all<{ cid: string; handle: string | null }>(
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

export async function listConversationMergeHistory(db: SqlDb) {
  return await db.all(
    `SELECT merged_at, keep_id, keep_display_name, keep_message_count,
            remove_id, remove_display_name, remove_message_count
       FROM conversation_merge_history ORDER BY merged_at DESC, id DESC`,
  );
}

export async function mergeConversations(db: SqlDb, keepId: string, removeId: string): Promise<void> {
  if (keepId === removeId) throw new MergeError("Can't merge a conversation into itself.");
  const exists = async (id: string) => (await db.all(`SELECT 1 FROM v_conversations WHERE id = ?`, [id])).length > 0;
  if (!(await exists(keepId)) || !(await exists(removeId))) throw new MergeError("One or both conversations weren't found.");
  const names = await conversationDisplayNames(db, [keepId, removeId]);
  const q = `SELECT COUNT(*) AS c FROM messages WHERE conversation_id IN (${CONVERSATION_IDS_SQL})`;
  const keepCount = await count(db, q, keepId);
  const removeCount = await count(db, q, removeId);
  await inTransaction(db, async () => {
    await db.run(`UPDATE conversation_alias SET to_id = ? WHERE to_id = ?`, [keepId, removeId]);
    await db.run(`INSERT OR REPLACE INTO conversation_alias (from_id, to_id) VALUES (?, ?)`, [removeId, keepId]);
    await db.run(
      `INSERT INTO conversation_merge_history (merged_at, keep_id, keep_display_name, keep_message_count,
         remove_id, remove_display_name, remove_message_count) VALUES (?,?,?,?,?,?,?)`,
      [new Date().toISOString(), keepId, names.get(keepId) ?? "Unknown", keepCount,
       removeId, names.get(removeId) ?? "Unknown", removeCount],
    );
  });
}

/** Cached aggregates depend on who is merged with whom: refresh the affected chats, then tell the UI. */
async function afterMerge(db: SqlDb, convIds: string[]): Promise<void> {
  try {
    if (convIds.length) await refreshOverviewSummary(db as never, convIds);
  } finally {
    publishDataChanged();
  }
}

async function conversationsOf(db: SqlDb, participantIds: string[]): Promise<string[]> {
  const rows = await db.all<{ c: string }>(
    `SELECT DISTINCT conversation_id AS c FROM conversation_participants WHERE participant_id IN (${participantIds.map(() => "?").join(",")})`,
    participantIds,
  );
  return rows.map((r) => r.c);
}

async function badRequest<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof MergeError) throw new RouteError(400, e.message);
    throw e;
  }
}

export function registerMergeRoutes(): void {
  registerRoute("GET /api/participants", async ({ db }) => ({ participants: await listParticipants(db) }));
  registerRoute("GET /api/merge-history", async ({ db }) => ({ items: await listMergeHistory(db) }));
  registerRoute("POST /api/merge", async ({ db, params }) => {
    await badRequest(() => mergeParticipants(db, String(params.keep_id), String(params.remove_id)));
    await afterMerge(db, await conversationsOf(db, [String(params.keep_id), String(params.remove_id)]));
    return { ok: true, keep_id: params.keep_id, removed_id: params.remove_id };
  });
  registerRoute("GET /api/conversations-for-merge", async ({ db }) => ({ conversations: await listConversationsForMerge(db) }));
  registerRoute("GET /api/merge-conversation-history", async ({ db }) => ({ items: await listConversationMergeHistory(db) }));
  registerRoute("POST /api/merge-conversation", async ({ db, params }) => {
    await badRequest(() => mergeConversations(db, String(params.keep_id), String(params.remove_id)));
    await afterMerge(db, [String(params.keep_id), String(params.remove_id)]);
    return { ok: true, keep_id: params.keep_id, removed_id: params.remove_id };
  });
}
