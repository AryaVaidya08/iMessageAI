// Dev-only harness worker for verifying OPFS persistence in a real browser (see storage-harness.html).
import { openAppDb, hasSavedDb, clearAllData, runBatched, getSyncState, setSyncState, getQuota } from "./index";

self.onmessage = async (e: MessageEvent<{ id: number; cmd: string }>) => {
  const { id, cmd } = e.data;
  try {
    let result: unknown;
    if (cmd === "write") {
      const db = await openAppDb();
      await db.run("INSERT OR IGNORE INTO participants(id,is_me) VALUES('me',1)");
      await db.run("INSERT OR IGNORE INTO conversations(id,is_group_chat,relationship_type,chat_guid) VALUES('c',0,'friend','c')");
      const rows = Array.from({ length: 5000 }, (_, i) => [`m${i}`, "c", "me", "2024-01-01T00:00:00.000Z", "hello", `g${i}`, i]);
      const n = await runBatched(db, "INSERT OR REPLACE INTO messages(id,conversation_id,sender_id,timestamp,text,guid,rowid_src) VALUES(?,?,?,?,?,?,?)", rows, 2000);
      await setSyncState(db, "last_rowid", "4999");
      await db.close();
      result = { inserted: n };
    } else if (cmd === "read") {
      const saved = await hasSavedDb();
      const db = await openAppDb();
      const c = await db.all<{ n: number }>("SELECT count(*) n FROM messages");
      const last = await getSyncState(db, "last_rowid");
      const v = await db.all("PRAGMA user_version");
      await db.close();
      result = { saved, count: c[0].n, last, v, quota: await getQuota() };
    } else if (cmd === "clear") {
      await clearAllData();
      result = { saved: await hasSavedDb() };
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err) });
  }
};
