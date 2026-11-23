// Small bookkeeping routes used by the app shell (not part of the legacy API).
import { registerRoute } from "./router";
import type { QueryDb } from "./db";

async function scalar(db: QueryDb, sql: string): Promise<unknown> {
  const rows = await db.all(sql);
  const r = rows[0] as Record<string, unknown> | undefined;
  return r ? Object.values(r)[0] : null;
}

export function registerSyncInfoRoutes(): void {
  registerRoute("GET /api/sync-info", async (db) => {
    const conversations = Number(await scalar(db, "SELECT COUNT(*) FROM v_conversations")) || 0;
    let messages = 0;
    try {
      messages = Number(await scalar(db, "SELECT COALESCE(SUM(message_count), 0) FROM summary_conversation")) || 0;
    } catch {
      /* summary table not populated yet */
    }
    if (!messages) messages = Number(await scalar(db, "SELECT COUNT(*) FROM messages")) || 0;
    const last = await scalar(db, "SELECT value FROM sync_state WHERE key = 'last_synced_at'");
    return { conversations, messages, lastSyncedAt: last == null ? null : String(last) };
  });

  // Close the connection before the app deletes the stored data.
  registerRoute("POST /api/admin/close", async (db) => {
    await (db as unknown as { close?: () => Promise<void> }).close?.();
    return { ok: true };
  });
}
