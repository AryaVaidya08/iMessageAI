// Wires the real implementations behind the orchestrator's ports:
//   reader    = unit 2 openChatDb (File-backed, read-only, never loads chat.db into memory)
//   extractor = unit 3 ChatDbExtractor (chat.db rows -> app rows)
//   writer    = storage AppDb (one transaction per batch, rows + sync keys together)
//   contacts  = unit 4 importContacts (.abcddb files -> contacts table)
import type { IngestInputFiles } from "../protocol";
import { openAppDb, type AppDb } from "../storage/db";
import { transaction, type SqlValue } from "../storage/helpers";
import { importContacts, pickAbcddbFiles } from "../contacts";
import { inferDefaultRegion, DEFAULT_REGION, type Region } from "../handles";
import { adaptAppDb } from "../query/openDb";
import { refreshOverviewSummary } from "../query/overview";
import { refreshConversationSummary } from "../query/conversations";
import { refreshStatsSummary } from "../query/stats";
import { openChatDb } from "./fileVfs";
import {
  ChatDbExtractor,
  type ChatInfo as XChatInfo,
  type ExtractedBatch,
  type MessageRow,
} from "./extract";
import { registerSummaryHook } from "./orchestrator";
import type {
  AppDbWriter,
  ChatDbReader,
  ChatInfo,
  ChatStoredState,
  ContactsImporter,
  EditState,
  Fingerprint,
  IngestDeps,
  MessageBatch,
  MessageExtractor,
} from "./ports";

/** Port ChatInfo plus the extractor's own chat record (needed to call extractChat). */
interface RealChat extends ChatInfo {
  x: XChatInfo;
}

const chunked = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};
const ph = (n: number) => new Array(n).fill("?").join(",");

export interface RealDeps extends IngestDeps {
  /** Unregisters summary hooks (call when the run is over). */
  dispose(): void;
}

export async function createRealDeps(files: IngestInputFiles): Promise<RealDeps> {
  const chat = await openChatDb(files.chatDb, { walFile: files.chatDbWal });

  // Region for national-format numbers: inferred from the user's own +CC handles.
  let region: Region = DEFAULT_REGION;
  try {
    const hs = await chat.query("SELECT id FROM handle WHERE id LIKE '+%' LIMIT 5000");
    region = inferDefaultRegion(hs.map((r) => String(r.id))) ?? DEFAULT_REGION;
  } catch {
    /* no handle table: not a Messages database; the extractor will say so */
  }

  const ex = new ChatDbExtractor(chat as never, { defaultRegion: region });
  const names = new Map<number, string>();
  const byGuid = new Map<string, RealChat>();

  const reader: ChatDbReader = {
    async fingerprint(): Promise<Fingerprint> {
      const [maxRowid, messageCount] = [await ex.maxRowid(), await ex.countMessages(0)];
      const chatCount = Number((await chat.query("SELECT COUNT(*) AS n FROM chat"))[0]?.n ?? 0);
      let editSignal = 0;
      try {
        editSignal = Number(
          (await chat.query("SELECT COUNT(*) AS n FROM message WHERE date_edited > 0 OR date_retracted > 0"))[0]?.n ?? 0,
        );
      } catch {
        /* old schema without edit columns */
      }
      return {
        size: files.chatDb.size + (files.chatDbWal?.size ?? 0),
        maxRowid,
        messageCount,
        chatCount,
        editSignal,
      };
    },
    async listChats(): Promise<ChatInfo[]> {
      const xs = await ex.listChats(0);
      // Friendly names for 1:1 chats: the other party's handle.
      try {
        const rows = await chat.query(
          `SELECT chj.chat_id AS cid, GROUP_CONCAT(h.id, ', ') AS ids
             FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id GROUP BY chj.chat_id`,
        );
        for (const r of rows) names.set(Number(r.cid), String(r.ids ?? ""));
      } catch {
        /* optional */
      }
      return xs.map((x) => {
        const c: RealChat = {
          guid: x.guid,
          rowid: x.rowid,
          name: x.displayName || names.get(x.rowid) || x.guid,
          isGroup: x.isGroup,
          maxRowid: x.maxRowid,
          messageCount: x.messageCount,
          x,
        };
        byGuid.set(c.guid, c);
        return c;
      });
    },
    close: () => chat.close(),
  };

  const real = (c: ChatInfo): RealChat => {
    const r = byGuid.get(c.guid);
    if (!r) throw new Error(`unknown chat ${c.guid}`);
    return r;
  };

  const toPortBatch = (b: ExtractedBatch): MessageBatch => {
    for (const m of b.messages) (m as unknown as { rowid: number }).rowid = m.rowid_src; // orchestrator reads .rowid
    return b as unknown as MessageBatch;
  };

  // Edited/unsent messages, grouped by chat (computed once per run, lazily).
  let editsByChat: Map<number, EditState[]> | null = null;
  const loadEdits = async (): Promise<Map<number, EditState[]>> => {
    if (editsByChat) return editsByChat;
    editsByChat = new Map();
    const changed = await ex.listEditedOrRetracted();
    for (const part of chunked(changed, 500)) {
      const rows = await chat.query(
        `SELECT message_id AS mid, chat_id AS cid FROM chat_message_join WHERE message_id IN (${ph(part.length)})`,
        part.map((c) => c.rowid),
      );
      const cidOf = new Map(rows.map((r) => [Number(r.mid), Number(r.cid)]));
      for (const c of part) {
        const cid = cidOf.get(c.rowid);
        if (cid == null) continue;
        const list = editsByChat.get(cid) ?? [];
        list.push({ rowid: c.rowid, guid: c.guid, dateEdited: c.dateEdited, dateRetracted: c.dateRetracted });
        editsByChat.set(cid, list);
      }
    }
    return editsByChat;
  };

  const extractor: MessageExtractor = {
    async *extractChat(c, opts) {
      for await (const b of ex.extractChat(real(c).x, { sinceRowid: opts.afterRowid, batchSize: opts.batchSize })) {
        yield toPortBatch(b);
      }
    },
    async *scanEditState(c, batchSize) {
      const list = (await loadEdits()).get(c.rowid) ?? [];
      for (const part of chunked(list, batchSize)) yield part;
    },
    async fetchMessages(_c, rowids) {
      const merged: ExtractedBatch | null = null as ExtractedBatch | null;
      let out = merged;
      for await (const b of ex.extractRowids(rowids)) {
        if (!out) out = b;
        else {
          out.messages.push(...b.messages);
          out.retractedGuids.push(...b.retractedGuids);
        }
      }
      return toPortBatch(out ?? ({ messages: [], tapbacks: [], announcements: [], participants: [], retractedGuids: [] } as never));
    },
  };

  const app = await openAppDb({ durability: "relaxed" });
  const writer = new AppWriter(app);

  const contacts: ContactsImporter = {
    async importContacts(abFiles, w) {
      const rows: { handle: string; display_name: string }[] = [];
      for await (const item of importContacts(pickAbcddbFiles(abFiles), {
        openReader: (f) => openChatDb(f) as never,
        defaultRegion: region,
      })) {
        if (Array.isArray(item)) rows.push(...item);
      }
      await (w as AppWriter).upsertContacts(rows);
      return rows.length;
    },
  };

  // Keep summary tables fresh for the chats this run touched.
  const q = adaptAppDb(app);
  const offs = [
    registerSummaryHook((ids) => refreshConversationSummary(q as never, ids)),
    registerSummaryHook((ids) => refreshOverviewSummary(q, ids)),
    registerSummaryHook((ids) => refreshStatsSummary(q as never, ids)),
  ];

  return { reader, extractor, writer, contacts, dispose: () => offs.forEach((o) => o()) };
}

class AppWriter implements AppDbWriter {
  constructor(private app: AppDb) {}

  async getSyncState(key: string): Promise<string | null> {
    const r = await this.app.all<{ value: string | null }>("SELECT value FROM sync_state WHERE key = ?", [key]);
    return r[0]?.value ?? null;
  }

  async setSyncState(key: string, value: string): Promise<void> {
    await this.app.run(
      "INSERT INTO sync_state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, value],
    );
    if (key === "chat_db_fingerprint") await this.setSyncState("last_synced_at", new Date().toISOString());
  }

  async getChatState(guid: string): Promise<ChatStoredState> {
    const last = await this.getSyncState(`chat_last_rowid:${guid}`);
    const r = await this.app.all<{ n: number; mx: number | null }>(
      "SELECT COUNT(*) AS n, MAX(rowid_src) AS mx FROM messages WHERE conversation_id = ?",
      [guid],
    );
    const n = Number(r[0]?.n ?? 0);
    const mx = Number(r[0]?.mx ?? 0);
    return { count: n, maxRowid: Math.max(last ? Number(last) : 0, mx) };
  }

  async upsertConversation(c: ChatInfo): Promise<void> {
    const x = (c as RealChat).x;
    await this.app.run(
      `INSERT INTO conversations(id, is_group_chat, relationship_type, convo_name, chat_guid, chat_rowid)
       VALUES(?, ?, 'other', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET convo_name = excluded.convo_name, chat_rowid = excluded.chat_rowid,
                                     is_group_chat = excluded.is_group_chat`,
      [c.guid, c.isGroup ? 1 : 0, c.isGroup ? (x?.displayName ?? null) : null, c.guid, c.rowid],
    );
  }

  /** One transaction: rows + sync keys. Returns the number of NEW messages inserted. */
  async writeBatch(_chat: ChatInfo, batch: MessageBatch, sync: Record<string, string>): Promise<number> {
    const b = batch as unknown as ExtractedBatch;
    const db = this.app;
    return transaction(db, async () => {
      // Participants first (FKs): everything this batch references.
      const known = new Map<string, SqlValue[]>();
      for (const p of b.participants ?? [])
        known.set(p.id, [p.id, p.phone_num, p.email, p.is_me, p.handle ?? p.id, p.display_name]);
      const refs = new Set<string>(["me"]);
      for (const m of b.messages) refs.add(m.sender_id);
      for (const t of b.tapbacks ?? []) refs.add(t.reactor_id);
      for (const a of b.announcements ?? []) {
        refs.add(a.announcer_id);
        if (a.affected_id) refs.add(a.affected_id);
      }
      for (const id of b.conversationParticipantIds ?? []) refs.add(id);
      for (const id of refs) {
        if (!known.has(id)) {
          const me = id === "me";
          known.set(id, [id, null, null, me ? 1 : 0, me || id === "unknown" ? "" : id, null]);
        }
      }
      await db.runMany!(
        "INSERT OR IGNORE INTO participants(id, phone_num, email, is_me, handle, display_name) VALUES(?,?,?,?,?,?)",
        [...known.values()],
      );
      await db.runMany!(
        "INSERT OR IGNORE INTO conversation_participants(conversation_id, participant_id) VALUES(?,?)",
        (b.conversationParticipantIds ?? []).map((pid) => [b.conversation.id, pid]),
      );

      const before = Number((await db.all<{ n: number }>("SELECT total_changes() AS n"))[0].n);
      await db.runMany!(
        `INSERT OR IGNORE INTO messages(id, conversation_id, sender_id, timestamp, text, has_attachment, has_sticker,
           reply_to, rowid_src, guid, date_edited, date_retracted, service, is_from_me) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        b.messages.map((m: MessageRow) => [
          m.id, m.conversation_id, m.sender_id, m.timestamp, m.text ?? "", m.has_attachment, m.has_sticker,
          m.reply_to, m.rowid_src, m.guid, m.date_edited, m.date_retracted, m.service, m.is_from_me,
        ]),
      );
      const inserted = Number((await db.all<{ n: number }>("SELECT total_changes() AS n"))[0].n) - before;

      // Tapbacks apply in order: an add then a remove of the same reaction cancels out.
      for (const t of b.tapbacks ?? []) {
        if (t.removed)
          await db.run("DELETE FROM tapbacks WHERE message_id = ? AND reactor_id = ? AND action = ?", [
            t.message_id, t.reactor_id, t.action,
          ]);
        else
          await db.run("INSERT OR IGNORE INTO tapbacks(message_id, reactor_id, action) VALUES(?,?,?)", [
            t.message_id, t.reactor_id, t.action,
          ]);
      }
      if (b.announcements?.length)
        await db.runMany!(
          `INSERT OR REPLACE INTO announcements(id, conversation_id, datetime, announcer_id, action, affected_id)
           VALUES(?,?,?,?,?,?)`,
          b.announcements.map((a) => [a.id, a.conversation_id, a.datetime, a.announcer_id, a.action, a.affected_id]),
        );
      if (b.retractedGuids?.length) await this.deleteMessages(b.retractedGuids);
      for (const [k, v] of Object.entries(sync))
        await db.run(
          "INSERT INTO sync_state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          [k, v],
        );
      return inserted;
    });
  }

  private async deleteMessages(guids: string[]): Promise<void> {
    for (const part of chunked(guids, 500)) {
      await this.app.run(`DELETE FROM tapbacks WHERE message_id IN (${ph(part.length)})`, part);
      await this.app.run(`DELETE FROM messages WHERE guid IN (${ph(part.length)})`, part);
    }
  }

  async getEditStates(guids: string[]) {
    const out = new Map<string, { dateEdited: string | null; dateRetracted: string | null }>();
    for (const part of chunked(guids, 500)) {
      const rows = await this.app.all<{ guid: string; date_edited: string | null; date_retracted: string | null }>(
        `SELECT guid, date_edited, date_retracted FROM messages WHERE guid IN (${ph(part.length)})`,
        part,
      );
      for (const r of rows) out.set(r.guid, { dateEdited: r.date_edited, dateRetracted: r.date_retracted });
    }
    return out;
  }

  async applyEdits(_chat: ChatInfo, batch: MessageBatch): Promise<number> {
    const b = batch as unknown as ExtractedBatch;
    return transaction(this.app, async () => {
      let n = 0;
      for (const m of b.messages) {
        await this.app.run("UPDATE messages SET text = ?, date_edited = ?, date_retracted = ? WHERE guid = ?", [
          m.text ?? "", m.date_edited, m.date_retracted, m.guid,
        ]);
        n++;
      }
      if (b.retractedGuids?.length) {
        await this.deleteMessages(b.retractedGuids);
        n += b.retractedGuids.length;
      }
      return n;
    });
  }

  async upsertContacts(rows: { handle: string; display_name: string }[]): Promise<void> {
    for (const part of chunked(rows, 2000)) {
      await transaction(this.app, async () => {
        await this.app.runMany!(
          "INSERT INTO contacts(handle, display_name) VALUES(?, ?) ON CONFLICT(handle) DO UPDATE SET display_name = excluded.display_name",
          part.map((r) => [r.handle, r.display_name]),
        );
      });
    }
  }

  close(): Promise<void> {
    return this.app.close();
  }
}
