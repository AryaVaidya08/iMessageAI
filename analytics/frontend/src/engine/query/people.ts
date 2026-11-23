import { registerRoute, RouteError, type SqlDb } from "./shim";
import { PARTICIPANT_IDS_SQL, CONVERSATION_IDS_SQL } from "./merge";
import { conversationDisplayNames, displayNameSql, getResolvedParticipant } from "./names";

export type PeopleSort = "recent" | "count" | "conversations";
export type SortOrder = "asc" | "desc";

export interface PersonSummary {
  id: string;
  handle: string;
  display_name: string;
  message_count: number;
  conversation_count: number;
  last_message_at: string | null;
}

/**
 * Pieces of PersonDetail that belong to the analytics units (stats: unit 9/10, leaderboard: unit 12).
 * Those units call setPersonDetailExtras() to plug in the real implementations; the defaults below
 * return empty-but-schema-correct values so this route works standalone.
 * `senderIdsSql` is a `SELECT ...` fragment (2 binds: id, id) listing every raw sender id that
 * resolves to the person, for index-friendly `sender_id IN (...)` filters.
 */
export interface PersonDetailExtras {
  stats(db: SqlDb, person: { id: string; handle: string; display_name: string; message_count: number }): unknown;
  leaderboard(db: SqlDb, person: { id: string; handle: string; display_name: string }): unknown;
}

const EMPTY_LEADERBOARD = {
  longest_message: null,
  most_argued_message: null,
  most_loved_message: null,
  most_laughed_message: null,
  most_disliked_message: null,
  most_reacted_message: null,
  most_aggressive_message: null,
  happiest_message: null,
  most_emoji_message: null,
  late_night_message: null,
  fastest_reply_message: null,
  top_renamer: null,
  top_photo_changer: null,
  top_unsender: null,
  most_revolving_door: null,
};

let extras: PersonDetailExtras = {
  stats: (_db, p) => ({
    participant_id: p.id,
    display_name: p.display_name,
    handle: p.handle,
    message_count: p.message_count,
    median_reply_seconds: null,
    reply_histogram: [],
    gap_initiator_count: 0,
    late_night_ratio: 0,
    top_words: [],
    top_emojis: [],
    tapbacks_given: [],
    tapbacks_received: [],
    sentiment_series: [],
    personality: [],
  }),
  leaderboard: () => ({ ...EMPTY_LEADERBOARD }),
};

export function setPersonDetailExtras(e: Partial<PersonDetailExtras>): void {
  extras = { ...extras, ...e };
}

const SORT_COLUMN: Record<PeopleSort, string> = {
  recent: "COALESCE(last_message_at, '')",
  count: "message_count",
  conversations: "conversation_count",
};

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

export function listPeople(
  db: SqlDb,
  opts: { search?: string | null; sort?: string; order?: string; page?: number; page_size?: number },
) {
  const sort: PeopleSort = opts.sort === "recent" || opts.sort === "conversations" ? opts.sort : "count";
  const order: SortOrder = opts.order === "asc" ? "asc" : "desc";
  const page = Math.max(1, Math.floor(Number(opts.page) || 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(opts.page_size) || 25)));

  // Aggregate per raw sender / participant first (index scans), then roll up through the alias
  // table so merged people combine. Only the requested page is materialized.
  const base = `
    WITH msg AS (
      SELECT COALESCE(pa.to_id, g.sender_id) AS pid, SUM(g.c) AS message_count,
             MIN(g.f) AS first_message_at, MAX(g.l) AS last_message_at
        FROM (SELECT sender_id, COUNT(*) AS c, MIN(timestamp) AS f, MAX(timestamp) AS l
                FROM messages GROUP BY sender_id) g
        LEFT JOIN participant_alias pa ON pa.from_id = g.sender_id
       GROUP BY pid
    ), conv AS (
      SELECT participant_id AS pid, COUNT(*) AS conversation_count
        FROM v_conversation_participants GROUP BY participant_id
    ), people AS (
      SELECT p.id, COALESCE(p.handle, '') AS handle, ${displayNameSql("p", "c")} AS display_name,
             COALESCE(msg.message_count, 0) AS message_count,
             COALESCE(conv.conversation_count, 0) AS conversation_count,
             msg.last_message_at AS last_message_at
        FROM v_participants p
        LEFT JOIN contacts c ON c.handle = p.handle
        LEFT JOIN msg ON msg.pid = p.id
        LEFT JOIN conv ON conv.pid = p.id
    )`;
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.search) {
    where.push(`LOWER(display_name) LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(opts.search.toLowerCase())}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total =
    db.all<{ n: number }>(`${base} SELECT COUNT(*) AS n FROM people ${whereSql}`, params)[0]?.n ?? 0;
  const items = db.all<PersonSummary>(
    `${base} SELECT id, handle, display_name, message_count, conversation_count, last_message_at
       FROM people ${whereSql}
      ORDER BY ${SORT_COLUMN[sort]} ${order}, LOWER(display_name), id
      LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  return { items, total, page, page_size: pageSize };
}

export function getPersonDetail(db: SqlDb, id: string) {
  const person = getResolvedParticipant(db, id);
  if (!person) return null;
  const range = db.all<{ n: number; f: string | null; l: string | null }>(
    `SELECT COUNT(*) AS n, MIN(timestamp) AS f, MAX(timestamp) AS l
       FROM messages WHERE sender_id IN (${PARTICIPANT_IDS_SQL})`,
    [id, id],
  )[0];
  const cells = db.all<{ dow: number; hour: number; c: number }>(
    `SELECT CAST(strftime('%w', timestamp) AS INTEGER) AS dow,
            CAST(strftime('%H', timestamp) AS INTEGER) AS hour, COUNT(*) AS c
       FROM messages WHERE sender_id IN (${PARTICIPANT_IDS_SQL}) GROUP BY dow, hour`,
    [id, id],
  );
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const c of cells) grid[c.dow][c.hour] = c.c;

  const convIds = db
    .all<{ cid: string }>(
      `SELECT cp.conversation_id AS cid FROM v_conversation_participants cp
         JOIN v_conversations c ON c.id = cp.conversation_id WHERE cp.participant_id = ?`,
      [id],
    )
    .map((r) => r.cid);
  const names = conversationDisplayNames(db, convIds);
  const conversations: unknown[] = [];
  for (const cid of convIds) {
    const meta = db.all<{ relationship_type: string; is_group_chat: number }>(
      `SELECT relationship_type, is_group_chat FROM conversations WHERE id = ?`,
      [cid],
    )[0];
    const n = db.all<{ c: number }>(
      `SELECT COUNT(*) AS c FROM messages WHERE conversation_id IN (${CONVERSATION_IDS_SQL})`,
      [cid, cid],
    )[0].c;
    conversations.push({
      conversation_id: cid,
      display_name: names.get(cid) ?? "Unknown",
      relationship_type: meta?.relationship_type ?? "",
      is_group_chat: !!meta?.is_group_chat,
      message_count: n,
    });
  }
  (conversations as { message_count: number }[]).sort((a, b) => b.message_count - a.message_count);

  const base = { id, handle: person.handle, display_name: person.display_name };
  return {
    ...base,
    message_count: range.n,
    conversation_count: convIds.length,
    first_message_at: range.f,
    last_message_at: range.l,
    heatmap: { grid },
    stats: extras.stats(db, { ...base, message_count: range.n }),
    leaderboard: extras.leaderboard(db, base),
    conversations,
  };
}

export function registerPeopleRoutes(): void {
  registerRoute("GET /api/people", ({ db, params }) =>
    listPeople(db, {
      search: params.search,
      sort: params.sort,
      order: params.order,
      page: params.page,
      page_size: params.page_size,
    }),
  );
  registerRoute("GET /api/people/:id", ({ db, params }) => {
    const p = getResolvedParticipant(db, String(params.id));
    if (!p) throw new RouteError(404, "person not found");
    return { id: p.id, handle: p.handle, display_name: p.display_name };
  });
  registerRoute("GET /api/people/:id/detail", ({ db, params }) => {
    const d = getPersonDetail(db, String(params.id));
    if (!d) throw new RouteError(404, "person not found");
    return d;
  });
}
