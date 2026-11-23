// Message extraction: chat.db rows -> rows shaped for the app DB contract.
// Replaces backend/parser/parse_conversation.py (which scraped imessage-exporter HTML).
//
// Memory: strictly streaming. Messages are read chat by chat in ROWID order via keyset
// pagination (LIMIT batchSize), each batch is converted and yielded, then released.

import { normalizeHandle } from "../handles";
import { decodeAttributedBody } from "./typedstream";

/** Minimal read-only handle; compatible with unit 2's openChatDb and sql.js/better-sqlite3 wrappers. */
export interface ChatDbReader {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] | Promise<T[]>;
}

export const APPLE_EPOCH_MS = 978307200000;
export const DEFAULT_BATCH_SIZE = 3000;

export interface ChatInfo {
  rowid: number;
  guid: string;
  displayName: string | null;
  isGroup: boolean;
  /** messages in chat_message_join with ROWID > sinceRowid (all if no sinceRowid) */
  messageCount: number;
  maxRowid: number;
}

export interface ParticipantRow {
  id: string; // normalized handle or 'me'
  handle: string;
  phone_num: string | null;
  email: string | null;
  is_me: 0 | 1;
  display_name: string | null;
}

export interface ConversationRow {
  id: string; // = chat.guid
  chat_guid: string;
  chat_rowid: number;
  is_group_chat: 0 | 1;
  relationship_type: "other";
  convo_name: string | null;
}

export interface MessageRow {
  id: string; // = guid
  guid: string;
  rowid_src: number;
  conversation_id: string;
  sender_id: string;
  timestamp: string; // ISO UTC
  text: string;
  has_attachment: 0 | 1;
  has_sticker: 0 | 1;
  reply_to: string | null; // guid of thread originator (else direct reply target)
  date_edited: string | null;
  date_retracted: string | null;
  service: string | null;
  is_from_me: 0 | 1;
}

export interface TapbackRow {
  message_id: string; // target message guid (may live in another batch / not be ingested)
  reactor_id: string;
  action: string; // Loved|Liked|Disliked|Laughed|Emphasized|Questioned|Sticker|<emoji>
  /** true when this row removes a previous tapback (associated_message_type 3000-3007) */
  removed: boolean;
  rowid_src: number;
  timestamp: string;
}

export interface AnnouncementRow {
  id: string; // 'ann:' + guid
  guid: string;
  rowid_src: number;
  conversation_id: string;
  datetime: string;
  announcer_id: string;
  /** legacy action names: added person|removed person|left convo|renamed convo|changed photo|removed photo|kept audio|unsent message */
  action: string;
  affected_id: string | null;
  /** new title for 'renamed convo' */
  title: string | null;
}

export interface ExtractedBatch {
  conversation: ConversationRow;
  /** all participant ids known for this conversation so far */
  conversationParticipantIds: string[];
  /** participants first seen in this batch (within this generator run) */
  participants: ParticipantRow[];
  messages: MessageRow[];
  tapbacks: TapbackRow[];
  announcements: AnnouncementRow[];
  /** guids of messages that are unsent (date_retracted set); ingest should delete any stored copy */
  retractedGuids: string[];
  /** chat.db message rows scanned in this batch (including skipped ones) - use for progress */
  scanned: number;
  /** highest message ROWID scanned in this batch */
  lastRowid: number;
}

export interface ExtractOptions {
  sinceRowid?: number;
  batchSize?: number;
  /** national-format numbers are assumed to belong to this calling code (default "1") */
  defaultCountryCode?: string;
}

export interface ChangedMessage {
  rowid: number;
  guid: string;
  dateEdited: string | null;
  dateRetracted: string | null;
}

export function appleMsToIso(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(Number(ms))) return null;
  return new Date(Number(ms) + APPLE_EPOCH_MS).toISOString();
}

/** Convert a raw chat.db date (ns since 2001; seconds on very old macOS) to ISO UTC. Prefer SQL-side conversion for big values. */
export function appleDateToIso(raw: number | null | undefined): string | null {
  if (!raw) return null;
  return appleMsToIso(Math.abs(raw) < 1e12 ? raw * 1000 : Math.trunc(raw / 1e6));
}

const TAPBACK_NAMES: Record<number, string> = {
  0: "Loved",
  1: "Liked",
  2: "Disliked",
  3: "Laughed",
  4: "Emphasized",
  5: "Questioned",
};

export interface TapbackInfo {
  action: string;
  removed: boolean;
}

export function classifyTapback(type: number | null, emoji?: string | null): TapbackInfo | null {
  if (type == null) return null;
  if (type === 1000) return { action: "Sticker", removed: false };
  const removed = type >= 3000 && type <= 3007;
  const added = type >= 2000 && type <= 2007;
  if (!added && !removed) return null;
  const k = type % 1000;
  if (k === 7) return { action: "Sticker", removed };
  if (k === 6) return { action: emoji || "Emoji", removed };
  return { action: TAPBACK_NAMES[k], removed };
}

/** associated_message_guid looks like "p:0/GUID" or "bp:GUID"; strip the prefix. */
export function targetGuid(assoc: string | null): string | null {
  if (!assoc) return null;
  return assoc.replace(/^(?:p:\d+\/|bp:)/, "");
}

export function announcementAction(
  itemType: number,
  groupActionType: number,
  hasTitle: boolean
): string | null {
  switch (itemType) {
    case 1:
      return groupActionType === 0 ? "added person" : groupActionType === 1 ? "removed person" : null;
    case 2:
      return hasTitle || groupActionType === 0 ? "renamed convo" : null;
    case 3:
      return groupActionType === 0 ? "left convo" : groupActionType === 1 ? "changed photo" : groupActionType === 2 ? "removed photo" : null;
    case 5:
      return "kept audio";
    default:
      return null;
  }
}

type Row = Record<string, any>;

function msExpr(col: string): string {
  return `CASE WHEN ${col} IS NULL OR ${col} = 0 THEN NULL WHEN abs(${col}) < 1000000000000 THEN ${col} * 1000 ELSE ${col} / 1000000 END`;
}

const CHUNK = 400;

interface HandleInfo {
  id: string;
  raw: string;
}

interface ChatState {
  info: ChatInfo;
  conv: ConversationRow;
  participantIds: Set<string>;
  emitted: Set<string>;
  fallbackSender: string | null;
}

export class ChatDbExtractor {
  private cols = new Set<string>();
  private handles = new Map<number, HandleInfo>();
  private ready: Promise<void> | null = null;
  private chatCache = new Map<number, ChatInfo>();

  constructor(private db: ChatDbReader, private defaults: ExtractOptions = {}) {}

  private async q<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return await this.db.query<T>(sql, params);
  }

  private init(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        const info = await this.q<{ name: string }>("PRAGMA table_info(message)");
        for (const r of info) this.cols.add(r.name);
        const hs = await this.q<{ ROWID: number; id: string }>("SELECT ROWID, id FROM handle");
        for (const h of hs) {
          this.handles.set(h.ROWID, {
            id: normalizeHandle(h.id, { defaultCountryCode: this.defaults.defaultCountryCode }),
            raw: h.id,
          });
        }
      })();
    }
    return this.ready;
  }

  private col(name: string, alias = name): string {
    return this.cols.has(name) ? `m.${name} AS ${alias}` : `NULL AS ${alias}`;
  }

  private messageSelect(): string {
    const c = (n: string) => (this.cols.has(n) ? `m.${n}` : "NULL");
    return `SELECT m.ROWID AS rowid, m.guid AS guid, ${this.col("text")}, ${this.col("attributedBody")},
      ${this.col("handle_id")}, ${this.col("service")}, ${this.col("is_from_me")},
      ${this.col("cache_has_attachments")}, ${this.col("associated_message_guid")},
      ${this.col("associated_message_type")}, ${this.col("associated_message_emoji")},
      ${this.col("thread_originator_guid")}, ${this.col("reply_to_guid")}, ${this.col("item_type")},
      ${this.col("group_action_type")}, ${this.col("group_title")}, ${this.col("other_handle")},
      ${msExpr(c("date"))} AS date_ms, ${msExpr(c("date_edited"))} AS edited_ms,
      ${msExpr(c("date_retracted"))} AS retracted_ms`;
  }

  /** Chats with message counts (only messages after sinceRowid). Chats with zero such messages are omitted when sinceRowid is set. */
  async listChats(sinceRowid = 0): Promise<ChatInfo[]> {
    await this.init();
    const counts = await this.q<{ chat_id: number; n: number; mx: number }>(
      "SELECT chat_id, count(*) AS n, max(message_id) AS mx FROM chat_message_join WHERE message_id > ? GROUP BY chat_id",
      [sinceRowid]
    );
    const cm = new Map(counts.map((r) => [r.chat_id, r]));
    const chats = await this.q<Row>("SELECT ROWID AS rowid, guid, display_name, style FROM chat ORDER BY ROWID");
    const out: ChatInfo[] = [];
    for (const c of chats) {
      const k = cm.get(c.rowid);
      const info: ChatInfo = {
        rowid: c.rowid,
        guid: c.guid,
        displayName: c.display_name ? String(c.display_name) : null,
        isGroup: c.style === 43,
        messageCount: k?.n ?? 0,
        maxRowid: k?.mx ?? 0,
      };
      this.chatCache.set(info.rowid, info);
      if (sinceRowid && !info.messageCount) continue;
      out.push(info);
    }
    return out;
  }

  /** Total messages in chat_message_join after sinceRowid (for overall progress). */
  async countMessages(sinceRowid = 0): Promise<number> {
    const r = await this.q<{ n: number }>("SELECT count(*) AS n FROM chat_message_join WHERE message_id > ?", [sinceRowid]);
    return r[0]?.n ?? 0;
  }

  async maxRowid(): Promise<number> {
    const r = await this.q<{ m: number | null }>("SELECT max(ROWID) AS m FROM message");
    return r[0]?.m ?? 0;
  }

  /** Messages (ROWID <= upToRowid, if given) that have been edited or unsent. Unit 5 diffs this against stored values. */
  async listEditedOrRetracted(upToRowid?: number): Promise<ChangedMessage[]> {
    await this.init();
    if (!this.cols.has("date_edited") && !this.cols.has("date_retracted")) return [];
    const conds: string[] = [];
    if (this.cols.has("date_edited")) conds.push("m.date_edited > 0");
    if (this.cols.has("date_retracted")) conds.push("m.date_retracted > 0");
    const rows = await this.q<Row>(
      `SELECT m.ROWID AS rowid, m.guid AS guid, ${msExpr(this.cols.has("date_edited") ? "m.date_edited" : "NULL")} AS edited_ms,
        ${msExpr(this.cols.has("date_retracted") ? "m.date_retracted" : "NULL")} AS retracted_ms
       FROM message m WHERE (${conds.join(" OR ")}) ${upToRowid != null ? "AND m.ROWID <= ?" : ""} ORDER BY m.ROWID`,
      upToRowid != null ? [upToRowid] : []
    );
    return rows.map((r) => ({
      rowid: r.rowid,
      guid: r.guid,
      dateEdited: appleMsToIso(r.edited_ms),
      dateRetracted: appleMsToIso(r.retracted_ms),
    }));
  }

  /** Yield batches for every chat that has messages after sinceRowid. */
  async *extractAll(opts: ExtractOptions = {}): AsyncGenerator<ExtractedBatch> {
    const chats = await this.listChats(opts.sinceRowid ?? 0);
    for (const chat of chats) yield* this.extractChat(chat, opts);
  }

  /** Yield batches (batchSize messages each, ROWID order) for one chat. */
  async *extractChat(chat: ChatInfo, opts: ExtractOptions = {}): AsyncGenerator<ExtractedBatch> {
    await this.init();
    const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);
    const state = await this.chatState(chat);
    let cursor = opts.sinceRowid ?? 0;
    const sql = `${this.messageSelect()}
      FROM chat_message_join cmj JOIN message m ON m.ROWID = cmj.message_id
      WHERE cmj.chat_id = ? AND cmj.message_id > ? ORDER BY cmj.message_id LIMIT ?`;
    for (;;) {
      const rows = await this.q<Row>(sql, [chat.rowid, cursor, batchSize]);
      if (!rows.length) return;
      cursor = rows[rows.length - 1].rowid;
      yield await this.buildBatch(state, rows);
      if (rows.length < batchSize) return;
    }
  }

  /** Yield batches for specific message ROWIDs (e.g. edited/unsent ones), grouped by chat. */
  async *extractRowids(rowids: number[], opts: ExtractOptions = {}): AsyncGenerator<ExtractedBatch> {
    await this.init();
    if (!this.chatCache.size) await this.listChats(0);
    const batchSize = Math.max(1, Math.min(opts.batchSize ?? DEFAULT_BATCH_SIZE, CHUNK));
    const sorted = [...rowids].sort((a, b) => a - b);
    const states = new Map<number, ChatState>();
    for (let i = 0; i < sorted.length; i += batchSize) {
      const part = sorted.slice(i, i + batchSize);
      const rows = await this.q<Row>(
        `${this.messageSelect()}, cmj.chat_id AS chat_id FROM message m
         JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         WHERE m.ROWID IN (${part.map(() => "?").join(",")}) ORDER BY cmj.chat_id, m.ROWID`,
        part
      );
      const byChat = new Map<number, Row[]>();
      for (const r of rows) {
        const l = byChat.get(r.chat_id) ?? [];
        l.push(r);
        byChat.set(r.chat_id, l);
      }
      for (const [chatId, list] of byChat) {
        const info = this.chatCache.get(chatId);
        if (!info) continue;
        let st = states.get(chatId);
        if (!st) states.set(chatId, (st = await this.chatState(info)));
        yield await this.buildBatch(st, list);
      }
    }
  }

  private async chatState(chat: ChatInfo): Promise<ChatState> {
    const members = await this.q<{ handle_id: number }>(
      "SELECT handle_id FROM chat_handle_join WHERE chat_id = ?",
      [chat.rowid]
    );
    const ids = new Set<string>();
    for (const m of members) {
      const h = this.handles.get(m.handle_id);
      if (h && h.id) ids.add(h.id);
    }
    const isGroup = chat.isGroup || ids.size > 1;
    return {
      info: chat,
      conv: {
        id: chat.guid,
        chat_guid: chat.guid,
        chat_rowid: chat.rowid,
        is_group_chat: isGroup ? 1 : 0,
        relationship_type: "other",
        convo_name: isGroup ? chat.displayName : null,
      },
      participantIds: new Set([...ids, "me"]),
      emitted: new Set(),
      fallbackSender: !isGroup && ids.size === 1 ? [...ids][0] : null,
    };
  }

  private participantRow(id: string): ParticipantRow {
    if (id === "me") return { id, handle: "me", phone_num: null, email: null, is_me: 1, display_name: null };
    const email = id.includes("@");
    return {
      id,
      handle: id,
      phone_num: email || id === "unknown" ? null : id,
      email: email ? id : null,
      is_me: 0,
      display_name: null,
    };
  }

  private senderOf(st: ChatState, r: Row): string {
    if (r.is_from_me) return "me";
    const h = r.handle_id ? this.handles.get(r.handle_id) : undefined;
    if (h && h.id) return h.id;
    return st.fallbackSender ?? "unknown";
  }

  private async attachmentFlags(rowids: number[]): Promise<Map<number, { att: boolean; sticker: boolean }>> {
    const out = new Map<number, { att: boolean; sticker: boolean }>();
    for (let i = 0; i < rowids.length; i += CHUNK) {
      const part = rowids.slice(i, i + CHUNK);
      const rows = await this.q<Row>(
        `SELECT maj.message_id AS mid, a.is_sticker AS is_sticker
         FROM message_attachment_join maj LEFT JOIN attachment a ON a.ROWID = maj.attachment_id
         WHERE maj.message_id IN (${part.map(() => "?").join(",")})`,
        part
      );
      for (const r of rows) {
        const f = out.get(r.mid) ?? { att: false, sticker: false };
        if (r.is_sticker) f.sticker = true;
        else f.att = true;
        out.set(r.mid, f);
      }
    }
    return out;
  }

  private async buildBatch(st: ChatState, rows: Row[]): Promise<ExtractedBatch> {
    const plain = rows
      .filter((r) => !(r.item_type > 0) && !classifyTapback(r.associated_message_type, r.associated_message_emoji))
      .map((r) => r.rowid as number);
    const flags = await this.attachmentFlags(plain);

    const used = new Set<string>();
    const touch = (id: string | null) => {
      if (id) used.add(id);
      return id;
    };
    const messages: MessageRow[] = [];
    const tapbacks: TapbackRow[] = [];
    const announcements: AnnouncementRow[] = [];
    const retractedGuids: string[] = [];
    const conv = st.conv.id;

    for (const r of rows) {
      const ts = appleMsToIso(r.date_ms) ?? new Date(APPLE_EPOCH_MS).toISOString();
      const sender = touch(this.senderOf(st, r))!;
      const itemType = Number(r.item_type) || 0;

      if (itemType > 0) {
        const action = announcementAction(itemType, Number(r.group_action_type) || 0, !!r.group_title);
        if (!action) continue;
        let affected: string | null = null;
        if (action === "added person" || action === "removed person") {
          const h = r.other_handle ? this.handles.get(r.other_handle) : undefined;
          affected = h?.id || (r.other_handle === 0 && !r.is_from_me ? "me" : null);
          if (affected) touch(affected);
        }
        announcements.push({
          id: `ann:${r.guid}`,
          guid: r.guid,
          rowid_src: r.rowid,
          conversation_id: conv,
          datetime: ts,
          announcer_id: sender,
          action,
          affected_id: affected,
          title: action === "renamed convo" ? r.group_title ?? null : null,
        });
        continue;
      }

      const tb = classifyTapback(r.associated_message_type, r.associated_message_emoji);
      if (tb) {
        const target = targetGuid(r.associated_message_guid);
        if (!target) continue;
        tapbacks.push({ message_id: target, reactor_id: sender, action: tb.action, removed: tb.removed, rowid_src: r.rowid, timestamp: ts });
        continue;
      }

      if (r.retracted_ms) {
        retractedGuids.push(r.guid);
        announcements.push({
          id: `ann:${r.guid}`,
          guid: r.guid,
          rowid_src: r.rowid,
          conversation_id: conv,
          datetime: appleMsToIso(r.retracted_ms)!,
          announcer_id: sender,
          action: "unsent message",
          affected_id: null,
          title: null,
        });
        continue;
      }

      let text: string | null = r.text != null && r.text !== "" ? String(r.text) : null;
      if (text == null) text = decodeAttributedBody(r.attributedBody);
      text = (text ?? "").replace(/\uFFFC/g, "").trim();
      const f = flags.get(r.rowid);
      const hasSticker = !!f?.sticker;
      const hasAtt = !!f?.att || (!f && !!r.cache_has_attachments && !hasSticker);
      if (!text && !hasSticker && !hasAtt) continue;

      messages.push({
        id: r.guid,
        guid: r.guid,
        rowid_src: r.rowid,
        conversation_id: conv,
        sender_id: sender,
        timestamp: ts,
        text,
        has_attachment: hasAtt ? 1 : 0,
        has_sticker: hasSticker ? 1 : 0,
        reply_to: r.thread_originator_guid || r.reply_to_guid || null,
        date_edited: appleMsToIso(r.edited_ms),
        date_retracted: null,
        service: r.service ?? null,
        is_from_me: r.is_from_me ? 1 : 0,
      });
    }

    // tapback reactors
    for (const t of tapbacks) used.add(t.reactor_id);
    const fresh: ParticipantRow[] = [];
    const all = new Set([...st.participantIds, ...used]);
    for (const id of all) {
      st.participantIds.add(id);
      if (!st.emitted.has(id)) {
        st.emitted.add(id);
        fresh.push(this.participantRow(id));
      }
    }
    return {
      conversation: st.conv,
      conversationParticipantIds: [...st.participantIds],
      participants: fresh,
      messages,
      tapbacks,
      announcements,
      retractedGuids,
      scanned: rows.length,
      lastRowid: rows.length ? rows[rows.length - 1].rowid : 0,
    };
  }
}

/** Convenience: stream every batch from a chat.db. */
export function extractMessages(db: ChatDbReader, opts: ExtractOptions = {}): AsyncGenerator<ExtractedBatch> {
  return new ChatDbExtractor(db, opts).extractAll(opts);
}
