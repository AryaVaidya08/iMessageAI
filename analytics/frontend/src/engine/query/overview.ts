// Overview + volume analytics (port of analytics/backend/routers/overview.py and the matching
// services/queries.py + services/stats.py pieces). Everything is aggregated in SQL; per-conversation
// aggregates are cached in summary_overview_* tables so reads never scan the messages table.
import { registerRoute, type QueryDb, type Row } from "./registerRoute";

/** Additive DDL for unit 1's schema migration. */
import { OVERVIEW_SUMMARY_DDL } from "../ddl";
export { OVERVIEW_SUMMARY_DDL };

export const MAX_VOLUME_POINTS = 1000;
const CHUNK = 200;

const placeholders = (n: number) => new Array(n).fill("?").join(",");
const num = (v: unknown) => Number(v ?? 0);

/**
 * Recompute the cached aggregates for the given conversations (null/undefined = all).
 * Unit 5 calls this after each ingest batch; the merge flow calls it after participant merges
 * (reply deltas depend on participant aliasing).
 */
export function refreshOverviewSummary(db: QueryDb, changedConversationIds?: string[] | null): Promise<void> {
  return serialized(() => refreshInTransaction(db, changedConversationIds));
}

/**
 * Refreshes run one at a time per worker, and each is ONE transaction (BEGIN IMMEDIATE takes the write lock, so
 * the ingest worker's refresh and the query worker's lazy fill also serialize across connections). Without this
 * two overview requests could interleave their delete/insert steps and violate the primary keys.
 */
let chain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

async function refreshInTransaction(db: QueryDb, changedConversationIds?: string[] | null): Promise<void> {
  const exec = (db as unknown as { exec?: (sql: string) => Promise<void> }).exec;
  const tx = !!exec;
  if (tx) await exec!.call(db, "BEGIN IMMEDIATE");
  try {
    await refreshOverviewSummaryRows(db, changedConversationIds);
    if (tx) await exec!.call(db, "COMMIT");
  } catch (e) {
    if (tx) await exec!.call(db, "ROLLBACK").catch(() => {});
    throw e;
  }
}

async function refreshOverviewSummaryRows(db: QueryDb, changedConversationIds?: string[] | null): Promise<void> {
  let ids = changedConversationIds;
  if (!ids) {
    ids = (await db.all("SELECT id FROM conversations")).map((r) => String(r.id));
    // also drop summaries of conversations that no longer exist
    await db.run("DELETE FROM summary_overview_conv WHERE conversation_id NOT IN (SELECT id FROM conversations)");
  }
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const ph = placeholders(part.length);
    for (const t of ["summary_overview_conv", "summary_overview_daily", "summary_overview_dow_hour", "summary_reply_delta"]) {
      await db.run(`DELETE FROM ${t} WHERE conversation_id IN (${ph})`, part);
    }
    await db.run(
      `INSERT INTO summary_overview_conv(conversation_id, message_count, min_ts, max_ts)
       SELECT conversation_id, COUNT(*), MIN(timestamp), MAX(timestamp)
       FROM messages WHERE conversation_id IN (${ph}) GROUP BY conversation_id`,
      part,
    );
    await db.run(
      `INSERT INTO summary_overview_daily(conversation_id, day, count)
       SELECT conversation_id, substr(timestamp, 1, 10), COUNT(*)
       FROM messages WHERE conversation_id IN (${ph}) GROUP BY conversation_id, substr(timestamp, 1, 10)`,
      part,
    );
    await db.run(
      `INSERT INTO summary_overview_dow_hour(conversation_id, dow, hour, count)
       SELECT conversation_id, CAST(strftime('%w', timestamp) AS INTEGER), CAST(strftime('%H', timestamp) AS INTEGER), COUNT(*)
       FROM messages WHERE conversation_id IN (${ph})
       GROUP BY conversation_id, CAST(strftime('%w', timestamp) AS INTEGER), CAST(strftime('%H', timestamp) AS INTEGER)`,
      part,
    );
    // A "reply" = a message whose sender (after participant merges) differs from the previous
    // message's sender; delay = timestamp difference. Stored as a ms-resolution histogram so the
    // pooled median stays exact without keeping one row per message.
    await db.run(
      `INSERT INTO summary_reply_delta(conversation_id, delta_ms, n)
       SELECT conversation_id, delta_ms, COUNT(*) FROM (
         SELECT conversation_id,
                CAST(ROUND((julianday(ts) - julianday(prev_ts)) * 86400000.0) AS INTEGER) AS delta_ms
         FROM (
           SELECT conversation_id, s, ts,
                  LAG(s) OVER w AS prev_s, LAG(ts) OVER w AS prev_ts
           FROM (
             SELECT m.conversation_id AS conversation_id, COALESCE(pa.to_id, m.sender_id) AS s,
                    m.timestamp AS ts, m.rowid AS rid
             FROM messages m LEFT JOIN participant_alias pa ON pa.from_id = m.sender_id
             WHERE m.conversation_id IN (${ph})
           )
           WINDOW w AS (PARTITION BY conversation_id ORDER BY ts, rid)
         )
         WHERE prev_s IS NOT NULL AND s <> prev_s
       ) GROUP BY conversation_id, delta_ms`,
      part,
    );
  }
}

/**
 * Fill summaries for any conversation that has messages but no summary row yet. Conversations
 * that already have a summary are only recomputed when ingest/merge code calls
 * refreshOverviewSummary (ingest: changed conversation ids; participant merge: null = all).
 */
const MISSING_SQL = `SELECT c.id FROM conversations c
     WHERE NOT EXISTS (SELECT 1 FROM summary_overview_conv s WHERE s.conversation_id = c.id)
       AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)`;

async function ensureSummary(db: QueryDb): Promise<void> {
  // cheap unlocked check first: the common case is "nothing missing"
  if (!(await db.all(MISSING_SQL)).length) return;
  await serialized(async () => {
    // re-check inside the serialized section: another request (or the ingest worker) may have filled it already
    const exec = (db as unknown as { exec?: (sql: string) => Promise<void> }).exec;
    if (exec) await exec.call(db, "BEGIN IMMEDIATE");
    try {
      const rows = await db.all(MISSING_SQL);
      if (rows.length) await refreshOverviewSummaryRows(db, rows.map((r) => String(r.id)));
      if (exec) await exec.call(db, "COMMIT");
    } catch (e) {
      if (exec) await exec.call(db, "ROLLBACK").catch(() => {});
      throw e;
    }
  });
}

// ---- stats.py ports ---------------------------------------------------------------------

const DAY_MS = 86400000;
const dayToOrd = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY_MS;
const ordToDay = (o: number) => new Date(o * DAY_MS).toISOString().slice(0, 10);

/** Fill every missing day between first and last with 0. */
function fillDailyGaps(dayCounts: [string, number][]): [string, number][] {
  const counts = new Map(dayCounts);
  const start = dayToOrd(dayCounts[0][0]);
  const end = dayToOrd(dayCounts[dayCounts.length - 1][0]);
  const out: [string, number][] = [];
  for (let o = start; o <= end; o++) {
    const k = ordToDay(o);
    out.push([k, counts.get(k) ?? 0]);
  }
  return out;
}

export function bucketVolume(dayCounts: [string, number][], granularity: string): [string, number][] {
  if (granularity !== "day" && granularity !== "week" && granularity !== "month") {
    throw new Error(`unknown granularity: ${granularity}`);
  }
  if (!dayCounts.length) return [];
  const filled = fillDailyGaps(dayCounts);
  if (granularity === "day") return filled;
  const buckets = new Map<string, number>();
  for (const [day, count] of filled) {
    let key: string;
    if (granularity === "week") {
      const o = dayToOrd(day);
      const weekday = (new Date(o * DAY_MS).getUTCDay() + 6) % 7; // Monday = 0
      key = ordToDay(o - weekday);
    } else {
      key = day.slice(0, 7);
    }
    buckets.set(key, (buckets.get(key) ?? 0) + count);
  }
  return [...buckets.entries()];
}

/** Merge consecutive points (summing counts, labelled by the first) down to <= maxPoints. */
export function downsample(points: { bucket: string; count: number }[], maxPoints = MAX_VOLUME_POINTS) {
  if (points.length <= maxPoints) return points;
  const size = Math.ceil(points.length / maxPoints);
  const out: { bucket: string; count: number }[] = [];
  for (let i = 0; i < points.length; i += size) {
    let count = 0;
    for (let j = i; j < Math.min(i + size, points.length); j++) count += points[j].count;
    out.push({ bucket: points[i].bucket, count });
  }
  return out;
}

export function buildHeatmapGrid(cells: [number, number, number][]): number[][] {
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const [dow, hour, count] of cells) grid[dow][hour] = count;
  return grid;
}

// ---- route handlers ---------------------------------------------------------------------

export async function getOverview(db: QueryDb) {
  await ensureSummary(db);
  const agg = (await db.get(
    "SELECT COALESCE(SUM(message_count), 0) AS total, MIN(min_ts) AS lo, MAX(max_ts) AS hi FROM summary_overview_conv",
  )) as Row;
  const convs = (await db.get(
    "SELECT COUNT(*) AS c FROM conversations WHERE id NOT IN (SELECT from_id FROM conversation_alias)",
  )) as Row;
  const parts = (await db.get(
    "SELECT COUNT(*) AS c FROM participants WHERE id NOT IN (SELECT from_id FROM participant_alias)",
  )) as Row;
  return {
    total_messages: num(agg.total),
    total_conversations: num(convs.c),
    total_participants: num(parts.c),
    date_range_start: (agg.lo as string | null) ?? null,
    date_range_end: (agg.hi as string | null) ?? null,
  };
}

export async function getVolume(db: QueryDb, params: Record<string, unknown>) {
  const granularity = String(params.granularity ?? "week");
  if (!/^(day|week|month)$/.test(granularity)) throw new Error("granularity must be day, week or month");
  await ensureSummary(db);
  const rows = await db.all(
    "SELECT day, SUM(count) AS c FROM summary_overview_daily GROUP BY day ORDER BY day",
  );
  const bucketed = bucketVolume(rows.map((r) => [String(r.day), num(r.c)] as [string, number]), granularity);
  return { points: downsample(bucketed.map(([bucket, count]) => ({ bucket, count }))) };
}

export async function getHeatmap(db: QueryDb) {
  await ensureSummary(db);
  const rows = await db.all(
    "SELECT dow, hour, SUM(count) AS c FROM summary_overview_dow_hour GROUP BY dow, hour",
  );
  return { grid: buildHeatmapGrid(rows.map((r) => [num(r.dow), num(r.hour), num(r.c)] as [number, number, number])) };
}

const NAME_EXPR = `CASE WHEN p.is_me THEN 'You' ELSE COALESCE(
    NULLIF(ct.display_name, ''), NULLIF(p.display_name, ''),
    NULLIF(COALESCE(p.handle, p.phone_num, p.email, ''), ''), 'Unknown') END`;

export function buildConversationDisplayName(
  others: string[],
  hasOthers: boolean,
  convoName: string | null,
): string {
  if (convoName) return convoName;
  if (!hasOthers) return "You";
  if (others.length <= 3) return others.join(", ");
  return `${others.slice(0, 2).join(", ")} +${others.length - 2} more`;
}

export async function getTopConversations(db: QueryDb, params: Record<string, unknown>) {
  const limit = params.limit === undefined ? 10 : Number(params.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("limit must be an integer 1..50");
  await ensureSummary(db);
  const ranked = await db.all(
    `SELECT COALESCE(ca.to_id, s.conversation_id) AS eid, SUM(s.message_count) AS c
     FROM summary_overview_conv s LEFT JOIN conversation_alias ca ON ca.from_id = s.conversation_id
     GROUP BY eid ORDER BY c DESC, eid ASC LIMIT ?`,
    [limit],
  );
  const result = [];
  for (const r of ranked) {
    const eid = String(r.eid);
    const conv = await db.get("SELECT is_group_chat, convo_name FROM conversations WHERE id = ?", [eid]);
    const members = await db.all(
      `SELECT COALESCE(pa.to_id, cp.participant_id) AS pid, MIN(p.is_me) AS is_me, ${NAME_EXPR} AS name, MIN(cp.rowid) AS ord
       FROM conversation_participants cp
       LEFT JOIN conversation_alias ca ON ca.from_id = cp.conversation_id
       LEFT JOIN participant_alias pa ON pa.from_id = cp.participant_id
       JOIN participants p ON p.id = COALESCE(pa.to_id, cp.participant_id)
       LEFT JOIN contacts ct ON ct.handle = COALESCE(p.handle, p.phone_num, p.email)
       WHERE COALESCE(ca.to_id, cp.conversation_id) = ?
       GROUP BY pid ORDER BY ord`,
      [eid],
    );
    const others = members.filter((m) => !num(m.is_me)).map((m) => String(m.name));
    result.push({
      conversation_id: eid,
      display_name: buildConversationDisplayName(others, others.length > 0, (conv?.convo_name as string | null) ?? null),
      message_count: num(r.c),
      is_group_chat: conv ? !!num(conv.is_group_chat) : false,
    });
  }
  return { items: result };
}

/** Median of the pooled reply delays (seconds) per relationship type; fastest type wins. */
export async function getFastestReplyRelationship(db: QueryDb) {
  await ensureSummary(db);
  // Weighted median over (relationship, delta_ms, n): find the rows covering the middle positions.
  const rows = await db.all(
    `WITH agg AS (
       SELECT c.relationship_type AS rel, d.delta_ms AS ms, SUM(d.n) AS n
       FROM summary_reply_delta d
       JOIN conversations c ON c.id = COALESCE((SELECT to_id FROM conversation_alias WHERE from_id = d.conversation_id), d.conversation_id)
       WHERE c.relationship_type IS NOT NULL
       GROUP BY rel, ms
     ), cum AS (
       SELECT rel, ms, n,
              SUM(n) OVER (PARTITION BY rel ORDER BY ms) AS cum,
              SUM(n) OVER (PARTITION BY rel) AS total
       FROM agg
     )
     SELECT rel, ms, total,
            (cum - n < (total + 1) / 2 AND cum >= (total + 1) / 2) AS is_lo,
            (cum - n < total / 2 + 1 AND cum >= total / 2 + 1) AS is_hi
     FROM cum
     WHERE (cum - n < (total + 1) / 2 AND cum >= (total + 1) / 2)
        OR (cum - n < total / 2 + 1 AND cum >= total / 2 + 1)`,
  );
  const picks = new Map<string, { lo?: number; hi?: number }>();
  for (const r of rows) {
    const e = picks.get(String(r.rel)) ?? {};
    if (num(r.is_lo)) e.lo = num(r.ms);
    if (num(r.is_hi)) e.hi = num(r.ms);
    picks.set(String(r.rel), e);
  }
  let best: { relationship_type: string; median_reply_seconds: number } | null = null;
  for (const [rel, { lo, hi }] of picks) {
    if (lo === undefined || hi === undefined) continue;
    const median = lo === hi ? lo / 1000 : (lo / 1000 + hi / 1000) / 2;
    if (!best || median < best.median_reply_seconds) best = { relationship_type: rel, median_reply_seconds: median };
  }
  return best;
}

registerRoute("GET /api/overview", (db) => getOverview(db));
registerRoute("GET /api/overview/volume", (db, p) => getVolume(db, p));
registerRoute("GET /api/overview/top-conversations", (db, p) => getTopConversations(db, p));
registerRoute("GET /api/overview/heatmap", (db) => getHeatmap(db));
registerRoute("GET /api/overview/fastest-reply-relationship", (db) => getFastestReplyRelationship(db));
