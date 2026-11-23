import type { SqlDb } from "./shim";

export interface ResolvedParticipant {
  id: string;
  handle: string;
  display_name: string;
  is_me: boolean;
}

/**
 * SQL expressions mirroring names.resolve_participant. `p` is a participants (or v_participants)
 * alias, `c` a LEFT JOINed contacts alias (ON c.handle = p.handle).
 * handle = participants.handle, '' when absent.
 */
export const handleSql = (p: string) => `COALESCE(NULLIF(${p}.handle, ''), '')`;
export const displayNameSql = (p: string, c: string) =>
  `CASE WHEN ${p}.is_me THEN 'You' ELSE COALESCE(NULLIF(${c}.display_name, ''), NULLIF(${p}.handle, ''), 'Unknown') END`;

/** Pure version, for use on already-fetched rows. */
export function resolveParticipant(
  id: string,
  handle: string | null | undefined,
  isMe: boolean | number,
  contactName: string | null | undefined,
): ResolvedParticipant {
  const h = handle ?? "";
  const display_name = isMe ? "You" : contactName || h || "Unknown";
  return { id, handle: h, display_name, is_me: !!isMe };
}

export function buildConversationDisplayName(
  participants: ResolvedParticipant[],
  convoName?: string | null,
): string {
  if (convoName) return convoName;
  const others = participants.filter((p) => !p.is_me).map((p) => p.display_name);
  if (others.length === 0) return "You";
  if (others.length <= 3) return others.join(", ");
  return `${others.slice(0, 2).join(", ")} +${others.length - 2} more`;
}

export function splitHandle(handle: string): { phone_num: string | null; email: string | null } {
  if (!handle) return { phone_num: null, email: null };
  return handle.includes("@") ? { phone_num: null, email: handle } : { phone_num: handle, email: null };
}

/** Resolve one (post-alias) participant id; null if missing or merged away. */
export function getResolvedParticipant(db: SqlDb, id: string): ResolvedParticipant | null {
  const rows = db.all<{ id: string; handle: string | null; is_me: number; cname: string | null }>(
    `SELECT p.id, p.handle, p.is_me, c.display_name AS cname
       FROM v_participants p LEFT JOIN contacts c ON c.handle = p.handle WHERE p.id = ?`,
    [id],
  );
  return rows.length ? resolveParticipant(rows[0].id, rows[0].handle, rows[0].is_me, rows[0].cname) : null;
}

/**
 * Display names for a set of (post-alias) conversation ids, chunked. Participants come from
 * v_conversation_participants so merged conversations show the union.
 */
export function conversationDisplayNames(db: SqlDb, ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const ph = chunk.map(() => "?").join(",");
    const convs = db.all<{ id: string; convo_name: string | null }>(
      `SELECT id, convo_name FROM v_conversations WHERE id IN (${ph})`,
      chunk,
    );
    const parts = db.all<{ cid: string; id: string; handle: string | null; is_me: number; cname: string | null }>(
      `SELECT cp.conversation_id AS cid, p.id, p.handle, p.is_me, c.display_name AS cname
         FROM v_conversation_participants cp
         JOIN v_participants p ON p.id = cp.participant_id
         LEFT JOIN contacts c ON c.handle = p.handle
        WHERE cp.conversation_id IN (${ph})
        ORDER BY LOWER(${displayNameSql("p", "c")}), p.id`,
      chunk,
    );
    const byConv = new Map<string, ResolvedParticipant[]>();
    for (const r of parts) {
      const list = byConv.get(r.cid) ?? [];
      list.push(resolveParticipant(r.id, r.handle, r.is_me, r.cname));
      byConv.set(r.cid, list);
    }
    for (const c of convs) out.set(c.id, buildConversationDisplayName(byConv.get(c.id) ?? [], c.convo_name));
  }
  return out;
}
