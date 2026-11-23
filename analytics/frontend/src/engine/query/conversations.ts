/**
 * Port of analytics/backend/routers/conversations.py + the matching parts of services/queries.py
 * and services/stats.py. Everything is SQL-first: no handler ever loads a whole conversation into
 * JS (text-derived stats stream through the `stats` accumulators in chunks).
 *
 * Merges: `conversation_alias(from_id, to_id)` and `participant_alias(from_id, to_id)` are applied at
 * read time. A request for a merged-away conversation id is served as its canonical conversation;
 * "conversation X" means every conversation_id in {X} U {from_id WHERE to_id = X}; senders and
 * reactors are mapped to their canonical participant in SQL.
 */
import type {
  ConversationDetail,
  ConversationLeaderboard,
  ConversationListResponse,
  ConversationStreakSilence,
  Granularity,
  HeatmapResponse,
  JoinLeaveResponse,
  LeaderboardMessageEntry,
  LeaderboardParticipantEntry,
  MessageOut,
  MessagesPage,
  ParticipantStats,
  ParticipantStatsResponse,
  PersonalityLeaderboardResponse,
  ReplyGraphResponse,
  SearchMessagesResponse,
  VolumeResponse,
} from "../../api/client";
import { registerRoute, type RouteRequest } from "./registerRouteReq";
import { personalityLeaderboard, stats } from "./statsApi";
import { SUMMARY_DDL } from "./conversationsSchema";
import { HttpError, type QueryDb, type SqlValue } from "./types";

export const RELATIONSHIP_TYPES = [
  "sigother",
  "parent",
  "close_family",
  "family",
  "close_friend",
  "friend",
  "classmate",
  "professor",
  "coworker",
  "boss",
  "other",
];

/** A reply breaks a silence once this long has passed since the previous message from anyone. */
export const GAP_INITIATOR_THRESHOLD_SECONDS = 6 * 3600;

export const HISTOGRAM_BUCKETS: [string, number][] = [
  ["<1m", 60],
  ["1-5m", 300],
  ["5-30m", 1800],
  ["30m-2h", 7200],
  ["2-12h", 43200],
  ["12-24h", 86400],
  [">24h", Infinity],
];

const LATE_NIGHT_HOURS = [23, 0, 1, 2, 3, 4];
const MEMBERSHIP_ACTIONS = ["added person", "removed person", "left convo"];
const MEMBERSHIP_DELTAS: Record<string, number> = { "added person": 1, "removed person": -1, "left convo": -1 };
const PHOTO_ACTIONS = ["changed photo", "removed photo", "changed background", "removed background"];
const STREAM_CHUNK = 4000;

type R = Record<string, unknown>;

export interface GroupSizeResponse {
  points: { datetime: string; size: number }[];
}

interface Resolved {
  id: string;
  handle: string;
  display_name: string;
  is_me: boolean;
}

interface ConvGroup {
  /** Canonical conversation id (what responses report as `id`). */
  id: string;
  is_group_chat: boolean;
  relationship_type: string;
  convo_name: string | null;
  /** Canonical id plus every conversation merged into it. */
  ids: string[];
}

// --- small helpers ---------------------------------------------------------------------------

/** `col = ?` / `col IN (?,?)` for a conversation-id group. */
function convIn(ids: string[], col = "m.conversation_id"): { sql: string; params: SqlValue[] } {
  if (ids.length === 1) return { sql: `${col} = ?`, params: [ids[0]] };
  return { sql: `${col} IN (${ids.map(() => "?").join(",")})`, params: [...ids] };
}

/** SQL expression for a sender/reactor column mapped through participant_alias. */
function canon(col: string): string {
  return `COALESCE((SELECT to_id FROM participant_alias WHERE from_id = ${col}), ${col})`;
}

function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : (v as number);
}

function intParam(
  req: RouteRequest,
  name: string,
  def: number,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const raw = req.query[name];
  if (raw === undefined || raw === "") return def;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(422, `invalid ${name}`);
  return n;
}

function strParam(req: RouteRequest, name: string): string | undefined {
  const raw = req.query[name];
  return raw === undefined ? undefined : String(raw);
}

function notFound(): never {
  throw new HttpError(404, "conversation not found");
}

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// --- date helpers (ports of the stats.py date maths) ---------------------------------------------

function parseTs(ts: string): number {
  let s = ts.replace(" ", "T").replace(/(\.\d{3})\d+/, "$1");
  if (!/(Z|[+-]\d\d:?\d\d)$/i.test(s)) s += "Z";
  return Date.parse(s);
}

function dayOrdinal(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

function ordinalToDay(o: number): string {
  return new Date(o * 86400000).toISOString().slice(0, 10);
}

/** Monday of the week containing the given day ordinal (1970-01-01 was a Thursday). */
function mondayOrdinal(o: number): number {
  const weekday = (((o + 3) % 7) + 7) % 7; // Monday = 0
  return o - weekday;
}

export function bucketVolume(dayCounts: [string, number][], granularity: Granularity): [string, number][] {
  if (dayCounts.length === 0) return [];
  const counts = new Map(dayCounts);
  const start = dayOrdinal(dayCounts[0][0]);
  const end = dayOrdinal(dayCounts[dayCounts.length - 1][0]);
  const buckets = new Map<string, number>();
  for (let o = start; o <= end; o++) {
    const day = ordinalToDay(o);
    const c = counts.get(day) ?? 0;
    let key: string;
    if (granularity === "day") key = day;
    else if (granularity === "week") key = ordinalToDay(mondayOrdinal(o));
    else key = day.slice(0, 7);
    buckets.set(key, (buckets.get(key) ?? 0) + c);
  }
  return [...buckets.entries()];
}

interface DayActivity {
  day: string;
  start_ts: string;
  end_ts: string;
}

export function longestStreakDays(days: DayActivity[]): number {
  if (days.length === 0) return 0;
  let best = 1;
  let streak = 1;
  for (let i = 1; i < days.length; i++) {
    streak = dayOrdinal(days[i].day) - dayOrdinal(days[i - 1].day) === 1 ? streak + 1 : 1;
    best = Math.max(best, streak);
  }
  return best;
}

export function longestSilence(days: DayActivity[]): { gap_seconds: number; before: string; after: string } | null {
  if (days.length < 2) return null;
  let best: { gap_seconds: number; before: string; after: string } | null = null;
  for (let i = 1; i < days.length; i++) {
    const gap = (parseTs(days[i].start_ts) - parseTs(days[i - 1].end_ts)) / 1000;
    if (best === null || gap > best.gap_seconds) {
      best = { gap_seconds: gap, before: days[i - 1].end_ts, after: days[i].start_ts };
    }
  }
  return best;
}

// --- names -------------------------------------------------------------------------------------

export function buildConversationDisplayName(participants: Resolved[], convoName: string | null): string {
  if (convoName) return convoName;
  const others = participants.filter((p) => !p.is_me).map((p) => p.display_name);
  if (others.length === 0) return "You";
  if (others.length <= 3) return others.join(", ");
  return `${others.slice(0, 2).join(", ")} +${others.length - 2} more`;
}

const PARTICIPANT_SELECT = `
  SELECT p.id AS id, p.is_me AS is_me,
         COALESCE(p.handle, p.phone_num, p.email, '') AS handle,
         COALESCE(c.display_name, p.display_name) AS contact_name
  FROM participants p
  LEFT JOIN contacts c ON c.handle = COALESCE(p.handle, p.phone_num, p.email)`;

function toResolved(r: R): Resolved {
  const isMe = !!num(r.is_me);
  const handle = String(r.handle ?? "");
  const name = isMe ? "You" : ((r.contact_name as string | null) || handle || "Unknown");
  return { id: String(r.id), handle, display_name: name, is_me: isMe };
}

async function loadParticipants(db: QueryDb, ids: string[]): Promise<Map<string, Resolved>> {
  const out = new Map<string, Resolved>();
  for (const part of chunked([...new Set(ids)], 500)) {
    const rows = await db.all<R>(`${PARTICIPANT_SELECT} WHERE p.id IN (${part.map(() => "?").join(",")})`, part);
    for (const r of rows) out.set(String(r.id), toResolved(r));
  }
  return out;
}

/** Canonical participants of a conversation group, ordered by id (the Python result order). */
async function conversationParticipants(db: QueryDb, ids: string[]): Promise<Map<string, Resolved>> {
  const w = convIn(ids, "cp.conversation_id");
  const rows = await db.all<R>(
    `SELECT DISTINCT ${canon("cp.participant_id")} AS pid FROM conversation_participants cp WHERE ${w.sql} ORDER BY pid`,
    w.params,
  );
  const pids = rows.map((r) => String(r.pid));
  const loaded = await loadParticipants(db, pids);
  const out = new Map<string, Resolved>();
  for (const pid of pids) {
    const p = loaded.get(pid);
    if (p) out.set(pid, p);
  }
  return out;
}

async function resolveGroup(db: QueryDb, requestedId: string): Promise<ConvGroup | null> {
  const alias = await db.all<R>("SELECT to_id FROM conversation_alias WHERE from_id = ?", [requestedId]);
  const id = alias.length ? String(alias[0].to_id) : requestedId;
  const rows = await db.all<R>(
    "SELECT id, is_group_chat, relationship_type, convo_name FROM conversations WHERE id = ?",
    [id],
  );
  if (!rows.length) return null;
  const merged = await db.all<R>("SELECT from_id FROM conversation_alias WHERE to_id = ?", [id]);
  const c = rows[0];
  return {
    id,
    is_group_chat: !!num(c.is_group_chat),
    relationship_type: String(c.relationship_type),
    convo_name: (c.convo_name as string | null) ?? null,
    ids: [id, ...merged.map((r) => String(r.from_id))],
  };
}

/** Group + non-empty participants, or 404 (mirrors the routers' `if not participants` guard). */
async function requireGroup(db: QueryDb, requestedId: string) {
  const group = await resolveGroup(db, requestedId);
  if (!group) notFound();
  const participants = await conversationParticipants(db, group.ids);
  if (participants.size === 0) notFound();
  return { group, participants };
}

// --- summary table (per-conversation counters) --------------------------------------------------

/**
 * Hook for unit 5: call after each ingest batch with the conversations whose messages changed. Also
 * safe to call with every conversation id after a full ingest. Creates the table on first use.
 */
export async function refreshConversationSummary(db: QueryDb, changedConversationIds: string[]): Promise<void> {
  for (const stmt of SUMMARY_DDL.split(";").map((s) => s.trim()).filter(Boolean)) await db.run(stmt);
  for (const id of new Set(changedConversationIds)) {
    await db.run(
      `INSERT INTO summary_conversation (conversation_id, message_count, first_ts, last_ts)
       SELECT ?, COUNT(*), MIN(timestamp), MAX(timestamp) FROM messages WHERE conversation_id = ?
       ON CONFLICT(conversation_id) DO UPDATE SET
         message_count = excluded.message_count, first_ts = excluded.first_ts, last_ts = excluded.last_ts`,
      [id, id],
    );
  }
}

interface Counts {
  count: number;
  first: string | null;
  last: string | null;
}

/** Counters per conversation id: from summary_conversation, live aggregation for any id it lacks. */
async function loadCounts(db: QueryDb, ids: string[], live = false): Promise<Map<string, Counts>> {
  const out = new Map<string, Counts>();
  if (!live) try {
    const rows = await db.all<R>("SELECT conversation_id, message_count, first_ts, last_ts FROM summary_conversation");
    for (const r of rows) {
      out.set(String(r.conversation_id), {
        count: num(r.message_count),
        first: (r.first_ts as string | null) ?? null,
        last: (r.last_ts as string | null) ?? null,
      });
    }
  } catch {
    // summary table not created yet; fall through to live aggregation
  }
  for (const id of ids) {
    if (out.has(id)) continue;
    const r = (
      await db.all<R>(
        "SELECT COUNT(*) AS c, MIN(timestamp) AS lo, MAX(timestamp) AS hi FROM messages WHERE conversation_id = ?",
        [id],
      )
    )[0];
    out.set(id, { count: num(r.c), first: (r.lo as string | null) ?? null, last: (r.hi as string | null) ?? null });
  }
  return out;
}

function mergeCounts(ids: string[], counts: Map<string, Counts>): Counts {
  let count = 0;
  let first: string | null = null;
  let last: string | null = null;
  for (const id of ids) {
    const c = counts.get(id);
    if (!c) continue;
    count += c.count;
    if (c.first !== null && (first === null || c.first < first)) first = c.first;
    if (c.last !== null && (last === null || c.last > last)) last = c.last;
  }
  return { count, first, last };
}

// --- GET /api/conversations -----------------------------------------------------------------------

export async function listConversations(
  db: QueryDb,
  opts: { search?: string; sort: string; page: number; page_size: number },
): Promise<ConversationListResponse> {
  const aliases = await db.all<R>("SELECT from_id, to_id FROM conversation_alias");
  const merged = new Map<string, string[]>(); // canonical -> merged-away ids
  const hidden = new Set<string>();
  const toCanonical = new Map<string, string>();
  for (const a of aliases) {
    hidden.add(String(a.from_id));
    toCanonical.set(String(a.from_id), String(a.to_id));
    const list = merged.get(String(a.to_id)) ?? [];
    list.push(String(a.from_id));
    merged.set(String(a.to_id), list);
  }

  const convs = (
    await db.all<R>("SELECT id, is_group_chat, relationship_type, convo_name FROM conversations")
  ).filter((c) => !hidden.has(String(c.id)));

  const cpRows = await db.all<R>(
    `SELECT DISTINCT cp.conversation_id AS cid, ${canon("cp.participant_id")} AS pid
     FROM conversation_participants cp ORDER BY pid`,
  );
  const membersByConv = new Map<string, string[]>();
  for (const r of cpRows) {
    const cid = toCanonical.get(String(r.cid)) ?? String(r.cid);
    const list = membersByConv.get(cid) ?? [];
    if (!list.includes(String(r.pid))) list.push(String(r.pid));
    membersByConv.set(cid, list);
  }
  for (const list of membersByConv.values()) list.sort();

  const people = new Map<string, Resolved>();
  for (const r of await db.all<R>(PARTICIPANT_SELECT)) people.set(String(r.id), toResolved(r));

  const allIds = convs.flatMap((c) => [String(c.id), ...(merged.get(String(c.id)) ?? [])]);
  const counts = await loadCounts(db, allIds);

  let items = convs.map((c) => {
    const id = String(c.id);
    const resolved = (membersByConv.get(id) ?? []).map((pid) => people.get(pid)).filter((p): p is Resolved => !!p);
    const agg = mergeCounts([id, ...(merged.get(id) ?? [])], counts);
    return {
      id,
      display_name: buildConversationDisplayName(resolved, (c.convo_name as string | null) ?? null),
      is_group_chat: !!num(c.is_group_chat),
      relationship_type: String(c.relationship_type),
      message_count: agg.count,
      last_activity: agg.last,
    };
  });

  if (opts.search) {
    const needle = opts.search.toLowerCase();
    items = items.filter((i) => i.display_name.toLowerCase().includes(needle));
  }
  if (opts.sort === "recent") {
    items.sort((a, b) => {
      const x = a.last_activity ?? "";
      const y = b.last_activity ?? "";
      return x < y ? 1 : x > y ? -1 : 0;
    });
  }
  else items.sort((a, b) => b.message_count - a.message_count);

  const start = (opts.page - 1) * opts.page_size;
  return { items: items.slice(start, start + opts.page_size), total: items.length, page: opts.page, page_size: opts.page_size };
}

// --- GET /api/conversations/:id -------------------------------------------------------------------

async function buildDetail(db: QueryDb, group: ConvGroup): Promise<ConversationDetail> {
  const participants = await conversationParticipants(db, group.ids);
  // Detail is a single group, so aggregate live (index range scan) and never serve a stale cache.
  const counts = mergeCounts(group.ids, await loadCounts(db, group.ids, true));
  const list = [...participants.values()];
  return {
    id: group.id,
    display_name: buildConversationDisplayName(list, group.convo_name),
    is_group_chat: group.is_group_chat,
    relationship_type: group.relationship_type,
    participants: list.map((p) => ({ id: p.id, handle: p.handle, display_name: p.display_name, is_me: p.is_me })),
    message_count: counts.count,
    first_message_at: counts.first,
    last_message_at: counts.last,
  };
}

export async function getConversationDetail(db: QueryDb, id: string): Promise<ConversationDetail> {
  const group = await resolveGroup(db, id);
  if (!group) notFound();
  return buildDetail(db, group);
}

export async function updateRelationshipType(db: QueryDb, id: string, relationshipType: unknown): Promise<ConversationDetail> {
  if (typeof relationshipType !== "string" || !RELATIONSHIP_TYPES.includes(relationshipType)) {
    throw new HttpError(400, "invalid relationship_type");
  }
  const group = await resolveGroup(db, id);
  if (!group) notFound();
  const res = await db.run("UPDATE conversations SET relationship_type = ? WHERE id = ?", [relationshipType, group.id]);
  if (res.changes === 0) notFound();
  return buildDetail(db, { ...group, relationship_type: relationshipType });
}

// --- volume / heatmap / streak ----------------------------------------------------------------------

export async function getVolume(db: QueryDb, id: string, granularity: Granularity): Promise<VolumeResponse> {
  const { group } = await requireGroup(db, id);
  const w = convIn(group.ids);
  const rows = await db.all<R>(
    `SELECT substr(m.timestamp, 1, 10) AS day, COUNT(*) AS c FROM messages m WHERE ${w.sql} GROUP BY day ORDER BY day`,
    w.params,
  );
  const bucketed = bucketVolume(rows.map((r) => [String(r.day), num(r.c)]), granularity);
  return { points: bucketed.map(([bucket, count]) => ({ bucket, count })) };
}

export async function getHeatmap(db: QueryDb, id: string): Promise<HeatmapResponse> {
  const { group } = await requireGroup(db, id);
  const w = convIn(group.ids);
  const rows = await db.all<R>(
    `SELECT CAST(strftime('%w', m.timestamp) AS INTEGER) AS dow,
            CAST(strftime('%H', m.timestamp) AS INTEGER) AS hour, COUNT(*) AS c
     FROM messages m WHERE ${w.sql} GROUP BY dow, hour`,
    w.params,
  );
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const r of rows) grid[num(r.dow)][num(r.hour)] = num(r.c);
  return { grid };
}

export async function getStreakSilence(db: QueryDb, id: string): Promise<ConversationStreakSilence> {
  const { group } = await requireGroup(db, id);
  const w = convIn(group.ids);
  const rows = await db.all<R>(
    `SELECT substr(m.timestamp, 1, 10) AS day, MIN(m.timestamp) AS start_ts, MAX(m.timestamp) AS end_ts
     FROM messages m WHERE ${w.sql} GROUP BY day ORDER BY day`,
    w.params,
  );
  const days: DayActivity[] = rows.map((r) => ({
    day: String(r.day),
    start_ts: String(r.start_ts),
    end_ts: String(r.end_ts),
  }));
  const silence = longestSilence(days);
  return {
    streak_days: longestStreakDays(days),
    silence_gap_seconds: silence ? silence.gap_seconds : null,
    silence_before: silence ? silence.before : null,
    silence_after: silence ? silence.after : null,
  };
}

// --- membership: group size / join-leave --------------------------------------------------------------

async function membershipEvents(db: QueryDb, ids: string[]): Promise<R[]> {
  const w = convIn(ids, "conversation_id");
  return db.all<R>(
    `SELECT datetime, action, announcer_id, affected_id FROM announcements
     WHERE ${w.sql} AND action IN (${MEMBERSHIP_ACTIONS.map(() => "?").join(",")})
     ORDER BY datetime, id`,
    [...w.params, ...MEMBERSHIP_ACTIONS],
  );
}

export async function getGroupSize(db: QueryDb, id: string): Promise<GroupSizeResponse> {
  const { group, participants } = await requireGroup(db, id);
  const events = await membershipEvents(db, group.ids);
  const net = events.reduce((acc, e) => acc + (MEMBERSHIP_DELTAS[String(e.action)] ?? 0), 0);
  let size = participants.size - net;
  const points = events.map((e) => {
    size += MEMBERSHIP_DELTAS[String(e.action)] ?? 0;
    return { datetime: String(e.datetime), size };
  });
  return { points };
}

export async function getJoinLeave(db: QueryDb, id: string): Promise<JoinLeaveResponse> {
  const { group } = await requireGroup(db, id);
  const events = await membershipEvents(db, group.ids);
  const aliasRows = await db.all<R>("SELECT from_id, to_id FROM participant_alias");
  const alias = new Map(aliasRows.map((a) => [String(a.from_id), String(a.to_id)]));
  const subjects = events.map((e) => (e.affected_id || e.announcer_id) as string | null);
  const people = await loadParticipants(db, subjects.filter((s): s is string => !!s).map((s) => alias.get(s) ?? s));
  return {
    items: events.map((e, i) => {
      const s = subjects[i];
      const p = s ? people.get(alias.get(s) ?? s) : undefined;
      return {
        datetime: String(e.datetime),
        kind: e.action === "added person" ? "joined" : "left",
        display_name: p ? p.display_name : "Unknown",
      };
    }),
  };
}

// --- reply graph -----------------------------------------------------------------------------------

export async function getReplyGraph(db: QueryDb, id: string): Promise<ReplyGraphResponse> {
  const { group, participants } = await requireGroup(db, id);
  const w = convIn(group.ids);
  const rows = await db.all<R>(
    `SELECT ${canon("m.sender_id")} AS replier, ${canon("t.sender_id")} AS original, COUNT(*) AS c
     FROM messages m JOIN messages t ON m.reply_to = t.id AND t.conversation_id = m.conversation_id
     WHERE ${w.sql}
     GROUP BY replier, original HAVING replier <> original
     ORDER BY c DESC, replier, original`,
    w.params,
  );
  const name = (pid: string) => participants.get(pid)?.display_name ?? "Unknown";
  return {
    edges: rows.map((r) => ({
      replier_id: String(r.replier),
      replier_display_name: name(String(r.replier)),
      original_id: String(r.original),
      original_display_name: name(String(r.original)),
      count: num(r.c),
    })),
  };
}

// --- messages ------------------------------------------------------------------------------------------

const MESSAGE_COLS = "m.id, m.sender_id, m.timestamp, m.text, m.has_attachment, m.has_sticker, m.reply_to";

async function messageCursor(db: QueryDb, ids: string[], messageId: string): Promise<{ id: string; timestamp: string } | null> {
  const w = convIn(ids);
  const rows = await db.all<R>(`SELECT m.id, m.timestamp FROM messages m WHERE m.id = ? AND ${w.sql}`, [messageId, ...w.params]);
  return rows.length ? { id: String(rows[0].id), timestamp: String(rows[0].timestamp) } : null;
}

async function messagesBefore(db: QueryDb, ids: string[], cur: { id: string; timestamp: string } | null, limit: number): Promise<R[]> {
  const w = convIn(ids);
  const rows = cur
    ? await db.all<R>(
        `SELECT ${MESSAGE_COLS} FROM messages m WHERE ${w.sql} AND (m.timestamp, m.id) < (?, ?)
         ORDER BY m.timestamp DESC, m.id DESC LIMIT ?`,
        [...w.params, cur.timestamp, cur.id, limit],
      )
    : await db.all<R>(
        `SELECT ${MESSAGE_COLS} FROM messages m WHERE ${w.sql} ORDER BY m.timestamp DESC, m.id DESC LIMIT ?`,
        [...w.params, limit],
      );
  return rows.reverse();
}

async function messagesAfter(db: QueryDb, ids: string[], cur: { id: string; timestamp: string }, limit: number): Promise<R[]> {
  const w = convIn(ids);
  return db.all<R>(
    `SELECT ${MESSAGE_COLS} FROM messages m WHERE ${w.sql} AND (m.timestamp, m.id) > (?, ?)
     ORDER BY m.timestamp ASC, m.id ASC LIMIT ?`,
    [...w.params, cur.timestamp, cur.id, limit],
  );
}

export function splitWindowLimits(limit: number): [number, number] {
  const afterLimit = Math.max(Math.floor(limit / 2), 1);
  const beforeLimit = Math.max(limit - afterLimit - 1, 0);
  return [beforeLimit, afterLimit];
}

async function resolveMessageIdForDate(db: QueryDb, ids: string[], date: string): Promise<string | null> {
  const w = convIn(ids);
  // `timestamp >= 'YYYY-MM-DD'` is equivalent to substr(timestamp,1,10) >= date and can use the index.
  let rows = await db.all<R>(
    `SELECT m.id FROM messages m WHERE ${w.sql} AND m.timestamp >= ? ORDER BY m.timestamp ASC, m.id ASC LIMIT 1`,
    [...w.params, date],
  );
  if (!rows.length) {
    rows = await db.all<R>(
      `SELECT m.id FROM messages m WHERE ${w.sql} AND m.timestamp < ? ORDER BY m.timestamp DESC, m.id DESC LIMIT 1`,
      [...w.params, date],
    );
  }
  return rows.length ? String(rows[0].id) : null;
}

export async function getMessages(
  db: QueryDb,
  id: string,
  opts: { before?: string; after?: string; around?: string; date?: string; limit: number },
): Promise<MessagesPage> {
  const { group, participants } = await requireGroup(db, id);
  const ids = group.ids;
  const limit = opts.limit;

  let anchorId: string | null = opts.around ?? null;
  if (anchorId === null && opts.date !== undefined) anchorId = await resolveMessageIdForDate(db, ids, opts.date);
  const windowed = anchorId !== null;

  let rows: R[];
  let beforeRows: R[] = [];
  let afterRows: R[] = [];
  const [beforeLimit, afterLimit] = splitWindowLimits(limit);
  if (windowed) {
    const anchor = await messageCursor(db, ids, anchorId as string);
    if (anchor) {
      const w = convIn(ids);
      beforeRows = beforeLimit > 0 ? await messagesBefore(db, ids, anchor, beforeLimit) : [];
      const anchorRows = await db.all<R>(`SELECT ${MESSAGE_COLS} FROM messages m WHERE m.id = ? AND ${w.sql}`, [anchor.id, ...w.params]);
      afterRows = await messagesAfter(db, ids, anchor, afterLimit);
      rows = [...beforeRows, ...anchorRows, ...afterRows];
    } else rows = [];
  } else if (opts.after !== undefined) {
    const cur = await messageCursor(db, ids, opts.after);
    rows = cur ? await messagesAfter(db, ids, cur, limit) : [];
  } else {
    const cur = opts.before ? await messageCursor(db, ids, opts.before) : null;
    rows = await messagesBefore(db, ids, cur, limit);
  }

  const aliasRows = await db.all<R>("SELECT from_id, to_id FROM participant_alias");
  const alias = new Map(aliasRows.map((a) => [String(a.from_id), String(a.to_id)]));
  const tapbacks = await tapbacksForMessages(db, rows.map((r) => String(r.id)), participants, alias);

  const items: MessageOut[] = rows.map((r) => {
    const sid = alias.get(String(r.sender_id)) ?? String(r.sender_id);
    return {
      id: String(r.id),
      sender_id: sid,
      sender_display_name: participants.get(sid)?.display_name ?? "Unknown",
      timestamp: String(r.timestamp),
      text: String(r.text ?? ""),
      has_attachment: !!num(r.has_attachment),
      has_sticker: !!num(r.has_sticker),
      reply_to: (r.reply_to as string | null) ?? null,
      tapbacks: tapbacks.get(String(r.id)) ?? [],
    };
  });

  let older: string | null;
  let newer: string | null;
  if (windowed) {
    older = items.length && beforeRows.length === beforeLimit && beforeLimit > 0 ? items[0].id : null;
    newer = items.length && afterRows.length === afterLimit ? items[items.length - 1].id : null;
  } else if (opts.after !== undefined) {
    older = null;
    newer = rows.length === limit ? items[items.length - 1].id : null;
  } else {
    older = rows.length === limit ? items[0].id : null;
    newer = null;
  }
  return { items, older_cursor: older, newer_cursor: newer };
}

async function tapbacksForMessages(
  db: QueryDb,
  messageIds: string[],
  participants: Map<string, Resolved>,
  alias: Map<string, string>,
): Promise<Map<string, MessageOut["tapbacks"]>> {
  const out = new Map<string, MessageOut["tapbacks"]>();
  for (const part of chunked(messageIds, 500)) {
    const rows = await db.all<R>(
      `SELECT message_id, reactor_id, action FROM tapbacks WHERE message_id IN (${part.map(() => "?").join(",")}) ORDER BY id`,
      part,
    );
    for (const r of rows) {
      const rid = alias.get(String(r.reactor_id)) ?? String(r.reactor_id);
      const list = out.get(String(r.message_id)) ?? [];
      list.push({ reactor_id: rid, display_name: participants.get(rid)?.display_name ?? "Unknown", action: String(r.action) });
      out.set(String(r.message_id), list);
    }
  }
  return out;
}

// --- search -----------------------------------------------------------------------------------------------

let ftsAvailable: boolean | null = null;
export function resetSearchCapabilityCache(): void {
  ftsAvailable = null;
}

async function hasFts(db: QueryDb): Promise<boolean> {
  if (ftsAvailable === true) return true;
  const rows = await db.all<R>("SELECT 1 AS x FROM sqlite_master WHERE name = 'messages_fts'");
  const found = rows.length > 0;
  if (found) ftsAvailable = true; // never cache a negative: the index can be built lazily later
  return found;
}

export async function searchMessages(db: QueryDb, id: string, q: string, limit: number): Promise<SearchMessagesResponse> {
  const { group } = await requireGroup(db, id);
  const w = convIn(group.ids);
  let rows: R[] = [];
  if ([...q].length >= 3 && (await hasFts(db))) {
    // Trigram FTS: a quoted phrase is a case-insensitive substring match (same semantics as LIKE '%q%').
    const phrase = `"${q.replace(/"/g, '""')}"`;
    rows = await db.all<R>(
      `SELECT m.id, m.timestamp, m.text FROM messages m
       WHERE m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?) AND ${w.sql}
       ORDER BY m.timestamp ASC, m.id ASC LIMIT ?`,
      [phrase, ...w.params, limit],
    );
  }
  if (rows.length === 0) {
    // LIKE path; also the safety net when the FTS table exists but has not been backfilled yet.
    const escaped = q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    rows = await db.all<R>(
      `SELECT m.id, m.timestamp, m.text FROM messages m
       WHERE ${w.sql} AND m.text LIKE ? ESCAPE '\\' ORDER BY m.timestamp ASC, m.id ASC LIMIT ?`,
      [...w.params, `%${escaped}%`, limit],
    );
  }
  return { items: rows.map((r) => ({ id: String(r.id), timestamp: String(r.timestamp), text: String(r.text ?? "") })) };
}

// --- streaming text ------------------------------------------------------------------------------------------

/** Yields non-empty message rows in (timestamp, id) order, STREAM_CHUNK at a time (keyset paging). */
async function* textChunks(db: QueryDb, idsOrPred: string[] | { sql: string; params: SqlValue[] }): AsyncGenerator<R[]> {
  const w = Array.isArray(idsOrPred) ? convIn(idsOrPred) : idsOrPred;
  let last: { timestamp: string; id: string } | null = null;
  for (;;) {
    const rows: R[] = await db.all<R>(
      `SELECT m.id, ${canon("m.sender_id")} AS sender, m.timestamp, m.text FROM messages m
       WHERE ${w.sql} AND m.text <> ''${last ? " AND (m.timestamp, m.id) > (?, ?)" : ""}
       ORDER BY m.timestamp, m.id LIMIT ?`,
      last ? [...w.params, last.timestamp, last.id, STREAM_CHUNK] : [...w.params, STREAM_CHUNK],
    );
    if (!rows.length) return;
    yield rows;
    if (rows.length < STREAM_CHUNK) return;
    const tail = rows[rows.length - 1];
    last = { timestamp: String(tail.timestamp), id: String(tail.id) };
  }
}

// --- participant stats -----------------------------------------------------------------------------------------

function histogramCase(): string {
  const arms = HISTOGRAM_BUCKETS.slice(0, -1).map(([, upper], i) => `WHEN delta < ${upper} THEN ${i}`);
  return `CASE ${arms.join(" ")} ELSE ${HISTOGRAM_BUCKETS.length - 1} END`;
}

/** CTE chain producing `d(s, ps, delta)`: every message with its sender, previous sender and gap in seconds. */
function deltaCte(where: string): string {
  return `WITH base AS (
      SELECT ${canon("m.sender_id")} AS s, m.timestamp AS ts, m.id AS id FROM messages m WHERE ${where}
    ), seq AS (
      SELECT s, ts, LAG(s) OVER w AS ps, LAG(ts) OVER w AS pts FROM base WINDOW w AS (ORDER BY ts, id)
    ), d AS (
      SELECT s, ps, ROUND((julianday(ts) - julianday(pts)) * 86400.0, 3) AS delta FROM seq WHERE ps IS NOT NULL
    )`;
}

interface ReplyStats {
  median: Map<string, number>;
  histogram: Map<string, number[]>;
  gaps: Map<string, number>;
}

async function replyStats(db: QueryDb, ids: string[]): Promise<ReplyStats> {
  const w = convIn(ids);
  const cte = deltaCte(w.sql);
  const histRows = await db.all<R>(
    `${cte}
     SELECT s, (ps <> s) AS reply, ${histogramCase()} AS bucket, (delta >= ${GAP_INITIATOR_THRESHOLD_SECONDS}) AS gap, COUNT(*) AS c
     FROM d GROUP BY s, reply, bucket, gap`,
    w.params,
  );
  const histogram = new Map<string, number[]>();
  const gaps = new Map<string, number>();
  for (const r of histRows) {
    const s = String(r.s);
    if (num(r.reply)) {
      const h = histogram.get(s) ?? new Array<number>(HISTOGRAM_BUCKETS.length).fill(0);
      h[num(r.bucket)] += num(r.c);
      histogram.set(s, h);
    }
    if (num(r.gap)) gaps.set(s, (gaps.get(s) ?? 0) + num(r.c));
  }
  const medRows = await db.all<R>(
    `${cte}
     SELECT s, AVG(delta) AS med FROM (
       SELECT s, delta, ROW_NUMBER() OVER (PARTITION BY s ORDER BY delta) AS rn, COUNT(*) OVER (PARTITION BY s) AS n
       FROM d WHERE ps <> s
     ) WHERE rn IN ((n + 1) / 2, (n + 2) / 2) GROUP BY s`,
    w.params,
  );
  return { median: new Map(medRows.map((r) => [String(r.s), num(r.med)])), histogram, gaps };
}

export async function getParticipantStats(db: QueryDb, id: string): Promise<ParticipantStatsResponse> {
  const { group, participants } = await requireGroup(db, id);
  const ids = group.ids;
  const w = convIn(ids);

  const senderRows = await db.all<R>(
    `SELECT ${canon("m.sender_id")} AS s, COUNT(*) AS c,
            SUM(CASE WHEN CAST(strftime('%H', m.timestamp) AS INTEGER) IN (${LATE_NIGHT_HOURS.join(",")}) THEN 1 ELSE 0 END) AS late
     FROM messages m WHERE ${w.sql} GROUP BY s`,
    w.params,
  );
  const counts = new Map(senderRows.map((r) => [String(r.s), { count: num(r.c), late: num(r.late) }]));

  const reply = await replyStats(db, ids);

  const tbW = convIn(ids, "t.conversation_id");
  const tbRows = await db.all<R>(
    `SELECT ${canon("tb.reactor_id")} AS reactor, ${canon("t.sender_id")} AS target, tb.action AS action, COUNT(*) AS c
     FROM tapbacks tb JOIN messages t ON t.id = tb.message_id WHERE ${tbW.sql}
     GROUP BY reactor, target, action`,
    tbW.params,
  );

  const accs = new Map<string, ReturnType<typeof stats.createTextAccumulator>>();
  for await (const chunk of textChunks(db, ids)) {
    for (const r of chunk) {
      const s = String(r.sender);
      let acc = accs.get(s);
      if (!acc) accs.set(s, (acc = stats.createTextAccumulator()));
      acc.add(String(r.text), String(r.timestamp).slice(0, 10));
    }
  }

  const topActions = (rows: Map<string, number>) =>
    [...rows.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10).map(([action, count]) => ({ action, count }));

  const out: ParticipantStats[] = [];
  for (const [pid, p] of participants) {
    const c = counts.get(pid);
    const given = new Map<string, number>();
    const received = new Map<string, number>();
    for (const t of tbRows) {
      const n = num(t.c);
      if (String(t.reactor) === pid) given.set(String(t.action), (given.get(String(t.action)) ?? 0) + n);
      if (String(t.target) === pid) received.set(String(t.action), (received.get(String(t.action)) ?? 0) + n);
    }
    const text = (accs.get(pid) ?? stats.createTextAccumulator()).finish();
    const hist = reply.histogram.get(pid);
    out.push({
      participant_id: pid,
      display_name: p.display_name,
      handle: p.handle,
      message_count: c?.count ?? 0,
      median_reply_seconds: reply.median.get(pid) ?? null,
      reply_histogram: c
        ? HISTOGRAM_BUCKETS.map(([label], i) => ({ label, count: hist?.[i] ?? 0 }))
        : [],
      gap_initiator_count: reply.gaps.get(pid) ?? 0,
      late_night_ratio: c ? c.late / c.count : 0,
      top_words: text.top_words,
      top_emojis: text.top_emojis,
      tapbacks_given: topActions(given),
      tapbacks_received: topActions(received),
      sentiment_series: text.sentiment_series,
      personality: text.personality,
    });
  }
  return { participants: out };
}

export async function getPersonalityLeaderboard(db: QueryDb, id: string): Promise<PersonalityLeaderboardResponse> {
  const { group, participants } = await requireGroup(db, id);
  const w = convIn(group.ids);
  const countRows = await db.all<R>(
    `SELECT ${canon("m.sender_id")} AS s, COUNT(*) AS c FROM messages m WHERE ${w.sql} GROUP BY s`,
    w.params,
  );
  const messageCounts: Record<string, number> = {};
  for (const pid of participants.keys()) messageCounts[pid] = 0;
  for (const r of countRows) if (String(r.s) in messageCounts) messageCounts[String(r.s)] = num(r.c);

  const accs = new Map<string, ReturnType<typeof stats.createTextAccumulator>>();
  for await (const chunk of textChunks(db, group.ids)) {
    for (const r of chunk) {
      const s = String(r.sender);
      let acc = accs.get(s);
      if (!acc) accs.set(s, (acc = stats.createTextAccumulator()));
      acc.add(String(r.text), String(r.timestamp).slice(0, 10));
    }
  }
  const hits: Record<string, Record<string, number>> = {};
  for (const pid of participants.keys()) hits[pid] = accs.get(pid)?.finish().personality_hits ?? {};

  const board = personalityLeaderboard(hits, messageCounts);
  return {
    traits: Object.entries(board).map(([trait, entries]) => ({
      trait,
      entries: entries.map(([pid, count, share]) => ({
        participant_id: pid,
        display_name: participants.get(pid)?.display_name ?? "Unknown",
        message_count: count,
        share,
      })),
    })),
  };
}

// --- leaderboard -------------------------------------------------------------------------------------------------

function hydrate(row: R | undefined, value: number, participants: Map<string, Resolved>): LeaderboardMessageEntry | null {
  if (!row) return null;
  const sid = String(row.sender);
  return {
    message_id: String(row.id),
    sender_id: sid,
    sender_display_name: participants.get(sid)?.display_name ?? "Unknown",
    timestamp: String(row.timestamp),
    text: String(row.text ?? ""),
    value,
  };
}

async function announcementLeader(
  db: QueryDb,
  scope: LeaderboardScope,
  actions: string[],
  field: "announcer_id" | "affected_id",
): Promise<LeaderboardParticipantEntry | null> {
  const w = scope.announcements(field);
  const rows = await db.all<R>(
    `SELECT ${canon(field)} AS subject, COUNT(*) AS c FROM announcements
     WHERE ${w.sql} AND action IN (${actions.map(() => "?").join(",")}) AND ${field} IS NOT NULL
     GROUP BY subject ORDER BY c DESC, MIN(rowid) LIMIT 1`,
    [...w.params, ...actions],
  );
  if (!rows.length) return null;
  const pid = String(rows[0].subject);
  const p = (await loadParticipants(db, [pid])).get(pid);
  return { participant_id: pid, display_name: p ? p.display_name : "Unknown", count: num(rows[0].c) };
}

/** Which messages/replies/announcements a leaderboard ranks (a conversation, or one person across all chats). */
interface LeaderboardScope {
  participants: Map<string, Resolved>;
  /** predicate over messages aliased `m` */
  messages: { sql: string; params: SqlValue[] };
  /** predicate over reply messages aliased `rep` */
  replies: { sql: string; params: SqlValue[] };
  /** predicate over target messages aliased `t` (fastest reply) */
  fastest: { sql: string; params: SqlValue[] };
  announcements(field: "announcer_id" | "affected_id"): { sql: string; params: SqlValue[] };
}

export async function getLeaderboard(db: QueryDb, id: string): Promise<ConversationLeaderboard> {
  const { group, participants } = await requireGroup(db, id);
  const ids = group.ids;
  return computeLeaderboard(db, {
    participants,
    messages: convIn(ids),
    replies: convIn(ids, "rep.conversation_id"),
    fastest: convIn(ids, "t.conversation_id"),
    announcements: () => convIn(ids, "conversation_id"),
  });
}

/** Leaderboard for one person: their own messages (and announcements they did / were affected by) in every chat. */
export async function personLeaderboard(db: QueryDb, personId: string): Promise<ConversationLeaderboard> {
  const mine = `SELECT ? UNION SELECT from_id FROM participant_alias WHERE to_id = ?`;
  const p = [personId, personId] as SqlValue[];
  const participants = await loadParticipants(db, [personId]);
  return computeLeaderboard(db, {
    participants,
    messages: { sql: `m.sender_id IN (${mine})`, params: p },
    replies: { sql: "1 = 1", params: [] },
    fastest: { sql: `t.sender_id IN (${mine})`, params: p },
    announcements: (field) => ({ sql: `${field} IN (${mine})`, params: p }),
  });
}

async function computeLeaderboard(db: QueryDb, scope: LeaderboardScope): Promise<ConversationLeaderboard> {
  const { participants } = scope;
  const w = scope.messages;
  const sel = `m.id AS id, ${canon("m.sender_id")} AS sender, m.timestamp AS timestamp, m.text AS text`;

  const one = async (sql: string, params: SqlValue[]): Promise<R | undefined> => (await db.all<R>(sql, params))[0];

  const longest = await one(
    `SELECT ${sel}, length(trim(m.text, char(32, 9, 10, 13))) AS score FROM messages m WHERE ${w.sql}
     ORDER BY score DESC, m.timestamp, m.id LIMIT 1`,
    w.params,
  );

  // Count-based winners (ties -> earliest message), only when the count is > 0.
  const byTapback = async (actions?: string[]) => {
    const filter = actions ? ` AND tb.action IN (${actions.map(() => "?").join(",")})` : "";
    const r = await one(
      `SELECT ${sel}, COUNT(*) AS score FROM tapbacks tb JOIN messages m ON m.id = tb.message_id
       WHERE ${w.sql}${filter} GROUP BY m.id ORDER BY score DESC, m.timestamp, m.id LIMIT 1`,
      [...w.params, ...(actions ?? [])],
    );
    return hydrate(r, r ? num(r.score) : 0, participants);
  };
  const argued = await one(
    `SELECT ${sel}, COUNT(*) AS score FROM messages rep JOIN messages m ON m.id = rep.reply_to
     WHERE ${scope.replies.sql} AND ${w.sql} GROUP BY m.id
     ORDER BY score DESC, m.timestamp, m.id LIMIT 1`,
    [...scope.replies.params, ...w.params],
  );

  // Late-night: closest to 3:00am among messages whose hour is in the late-night window.
  const lateExpr = `(CAST(substr(m.timestamp, 12, 2) AS INTEGER) * 60 + CAST(substr(m.timestamp, 15, 2) AS INTEGER))`;
  const late = await one(
    `SELECT ${sel}, MIN(abs(${lateExpr} - 180), 1440 - abs(${lateExpr} - 180)) AS dist FROM messages m
     WHERE ${w.sql} AND CAST(substr(m.timestamp, 12, 2) AS INTEGER) IN (${LATE_NIGHT_HOURS.join(",")})
     ORDER BY dist ASC, m.timestamp, m.id LIMIT 1`,
    w.params,
  );

  // Text-scored metrics stream through the stats implementation (strictly-greater wins => earliest).
  let aggressive: R | undefined, happiest: R | undefined, emoji: R | undefined;
  let aggressiveScore = 0, happiestScore = 0, emojiScore = 0;
  for await (const chunk of textChunks(db, w)) {
    for (const r of chunk) {
      const s = stats.messageScores(String(r.text));
      if (s.aggressive > aggressiveScore) [aggressive, aggressiveScore] = [r, s.aggressive];
      if (s.emojiCount > emojiScore) [emoji, emojiScore] = [r, s.emojiCount];
      if (s.sentiment > happiestScore) [happiest, happiestScore] = [r, s.sentiment];
    }
  }

  const fw = scope.fastest;
  const fastestRow = await one(
    `SELECT t.id AS id, ${canon("t.sender_id")} AS sender, t.timestamp AS timestamp, t.text AS text,
            ROUND((julianday(MIN(rep.timestamp)) - julianday(t.timestamp)) * 86400.0, 3) AS delta
     FROM messages rep JOIN messages t ON rep.reply_to = t.id AND t.conversation_id = rep.conversation_id
     WHERE ${fw.sql} GROUP BY t.id ORDER BY delta ASC, t.timestamp LIMIT 1`,
    fw.params,
  );

  return {
    longest_message: longest && num(longest.score) > 0 ? hydrate(longest, num(longest.score), participants) : null,
    most_argued_message: argued ? hydrate(argued, num(argued.score), participants) : null,
    most_loved_message: await byTapback(["Loved"]),
    most_laughed_message: await byTapback(["Laughed"]),
    most_disliked_message: await byTapback(["Disliked"]),
    most_reacted_message: await byTapback(),
    most_aggressive_message: hydrate(aggressive, aggressiveScore, participants),
    happiest_message: hydrate(happiest, happiestScore, participants),
    most_emoji_message: hydrate(emoji, emojiScore, participants),
    late_night_message: late ? hydrate(late, 721 - num(late.dist), participants) : null,
    fastest_reply_message: fastestRow ? hydrate(fastestRow, num(fastestRow.delta), participants) : null,
    top_renamer: await announcementLeader(db, scope, ["renamed convo"], "announcer_id"),
    top_photo_changer: await announcementLeader(db, scope, PHOTO_ACTIONS, "announcer_id"),
    top_unsender: await announcementLeader(db, scope, ["unsent message"], "announcer_id"),
    most_revolving_door: await announcementLeader(db, scope, MEMBERSHIP_ACTIONS, "affected_id"),
  };
}

// --- route registration --------------------------------------------------------------------------------------------

export function registerConversationRoutes(): void {
  registerRoute("GET /api/conversations", async (db, req) => {
    const sort = strParam(req, "sort") ?? "recent";
    if (sort !== "recent" && sort !== "count") throw new HttpError(422, "invalid sort");
    return listConversations(db, {
      search: strParam(req, "search"),
      sort,
      page: intParam(req, "page", 1, 1),
      page_size: intParam(req, "page_size", 25, 1, 100),
    });
  });
  registerRoute("GET /api/conversations/:id", (db, req) => getConversationDetail(db, req.path.id));
  registerRoute("POST /api/conversations/:id/relationship-type", (db, req) =>
    updateRelationshipType(db, req.path.id, (req.body as { relationship_type?: unknown } | undefined)?.relationship_type),
  );
  registerRoute("GET /api/conversations/:id/volume", (db, req) => {
    const g = strParam(req, "granularity") ?? "week";
    if (g !== "day" && g !== "week" && g !== "month") throw new HttpError(422, "invalid granularity");
    return getVolume(db, req.path.id, g);
  });
  registerRoute("GET /api/conversations/:id/participant-stats", (db, req) => getParticipantStats(db, req.path.id));
  registerRoute("GET /api/conversations/:id/personality-leaderboard", (db, req) => getPersonalityLeaderboard(db, req.path.id));
  registerRoute("GET /api/conversations/:id/messages", (db, req) => {
    const date = strParam(req, "date");
    if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(422, "invalid date");
    return getMessages(db, req.path.id, {
      before: strParam(req, "before"),
      after: strParam(req, "after"),
      around: strParam(req, "around"),
      date,
      limit: intParam(req, "limit", 50, 1, 500),
    });
  });
  registerRoute("GET /api/conversations/:id/messages/search", (db, req) => {
    const q = strParam(req, "q");
    if (!q) throw new HttpError(422, "q is required");
    return searchMessages(db, req.path.id, q, intParam(req, "limit", 20, 1, 100));
  });
  registerRoute("GET /api/conversations/:id/heatmap", (db, req) => getHeatmap(db, req.path.id));
  registerRoute("GET /api/conversations/:id/streak-silence", (db, req) => getStreakSilence(db, req.path.id));
  registerRoute("GET /api/conversations/:id/group-size", (db, req) => getGroupSize(db, req.path.id));
  registerRoute("GET /api/conversations/:id/join-leave", (db, req) => getJoinLeave(db, req.path.id));
  registerRoute("GET /api/conversations/:id/leaderboard", (db, req) => getLeaderboard(db, req.path.id));
  registerRoute("GET /api/conversations/:id/reply-graph", (db, req) => getReplyGraph(db, req.path.id));
}

registerConversationRoutes();
