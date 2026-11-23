// In-memory fakes of the ports, for vitest and the Chromium harness page.
import type {
  AppDbWriter,
  ChatDbReader,
  ChatInfo,
  ChatStoredState,
  EditState,
  ExtractedMessage,
  IngestDeps,
  MessageBatch,
  MessageExtractor,
} from "./ports";

export interface FakeSource {
  chats: ChatInfo[];
  messages: Map<string, ExtractedMessage[]>; // by chat guid, ROWID-ordered
}

export function makeSource(spec: { name: string; n: number; group?: boolean }[], startRowid = 1): FakeSource {
  const chats: ChatInfo[] = [];
  const messages = new Map<string, ExtractedMessage[]>();
  let rowid = startRowid;
  spec.forEach((s, i) => {
    const guid = `chat-${s.name}`;
    const list: ExtractedMessage[] = [];
    for (let k = 0; k < s.n; k++, rowid++) {
      list.push({
        rowid,
        guid: `msg-${rowid}`,
        date: new Date(Date.UTC(2024, 0, 1) + rowid * 60000).toISOString(),
        dateEdited: null,
        dateRetracted: null,
        isFromMe: rowid % 2 === 0,
        senderHandle: rowid % 2 === 0 ? null : `+1555000${i}`,
        text: `hello ${rowid}`,
        service: "iMessage",
      });
    }
    messages.set(guid, list);
    chats.push({
      guid,
      rowid: i + 1,
      name: s.name,
      isGroup: !!s.group,
      maxRowid: list.length ? list[list.length - 1].rowid : 0,
      messageCount: list.length,
    });
  });
  return { chats, messages };
}

/** Append messages to an existing source (simulates a newer chat.db copy). */
export function appendMessages(src: FakeSource, chatName: string, n: number): void {
  const chat = src.chats.find((c) => c.name === chatName)!;
  const list = src.messages.get(chat.guid)!;
  let rowid = Math.max(...src.chats.map((c) => c.maxRowid)) + 1;
  for (let k = 0; k < n; k++, rowid++) {
    list.push({
      rowid,
      guid: `msg-${rowid}`,
      date: new Date(Date.UTC(2024, 0, 1) + rowid * 60000).toISOString(),
      dateEdited: null,
      dateRetracted: null,
      isFromMe: false,
      senderHandle: "+15550000",
      text: `new ${rowid}`,
      service: "iMessage",
    });
  }
  chat.maxRowid = list[list.length - 1].rowid;
  chat.messageCount = list.length;
}

export function makeReader(src: FakeSource): ChatDbReader & { fp: () => void } {
  return {
    fp() {},
    async fingerprint() {
      return {
        size: 1000 + src.chats.reduce((s, c) => s + c.messageCount, 0),
        maxRowid: Math.max(0, ...src.chats.map((c) => c.maxRowid)),
        messageCount: src.chats.reduce((s, c) => s + c.messageCount, 0),
        chatCount: src.chats.length,
      };
    },
    async listChats() {
      return src.chats.map((c) => ({ ...c }));
    },
    async close() {},
  };
}

export function makeExtractor(src: FakeSource): MessageExtractor {
  return {
    async *extractChat(chat, { afterRowid, batchSize }) {
      const all = src.messages.get(chat.guid) ?? [];
      let batch: ExtractedMessage[] = [];
      for (const m of all) {
        if (m.rowid <= afterRowid) continue;
        batch.push(m);
        if (batch.length >= batchSize) {
          yield { messages: batch };
          batch = [];
        }
      }
      if (batch.length) yield { messages: batch };
    },
    async *scanEditState(chat, batchSize) {
      const es: EditState[] = (src.messages.get(chat.guid) ?? [])
        .filter((m) => m.dateEdited || m.dateRetracted)
        .map((m) => ({ rowid: m.rowid, guid: m.guid, dateEdited: m.dateEdited, dateRetracted: m.dateRetracted }));
      for (let i = 0; i < es.length; i += batchSize) yield es.slice(i, i + batchSize);
    },
    async fetchMessages(chat, rowids): Promise<MessageBatch> {
      const set = new Set(rowids);
      return { messages: (src.messages.get(chat.guid) ?? []).filter((m) => set.has(m.rowid)) };
    },
  };
}

export interface FakeStore {
  sync: Map<string, string>;
  conversations: Map<string, ChatInfo>;
  messages: Map<string, ExtractedMessage & { chat: string }>; // by guid
  txCount: number;
}

export function makeStore(): FakeStore {
  return { sync: new Map(), conversations: new Map(), messages: new Map(), txCount: 0 };
}

export function makeWriter(store: FakeStore): AppDbWriter {
  return {
    async getSyncState(k) {
      return store.sync.get(k) ?? null;
    },
    async setSyncState(k, v) {
      store.sync.set(k, v);
    },
    async getChatState(guid): Promise<ChatStoredState> {
      let maxRowid = 0,
        count = 0;
      for (const m of store.messages.values())
        if (m.chat === guid) {
          count++;
          if (m.rowid > maxRowid) maxRowid = m.rowid;
        }
      return { maxRowid, count };
    },
    async upsertConversation(chat) {
      store.conversations.set(chat.guid, chat);
    },
    async writeBatch(chat, batch, sync) {
      store.txCount++;
      let n = 0;
      for (const m of batch.messages)
        if (!store.messages.has(m.guid)) {
          store.messages.set(m.guid, { ...m, chat: chat.guid });
          n++;
        }
      for (const [k, v] of Object.entries(sync)) store.sync.set(k, v);
      return n;
    },
    async getEditStates(guids) {
      const out = new Map<string, { dateEdited: string | null; dateRetracted: string | null }>();
      for (const g of guids) {
        const m = store.messages.get(g);
        if (m) out.set(g, { dateEdited: m.dateEdited, dateRetracted: m.dateRetracted });
      }
      return out;
    },
    async applyEdits(chat, batch) {
      store.txCount++;
      let n = 0;
      for (const m of batch.messages) {
        const cur = store.messages.get(m.guid);
        if (cur) {
          store.messages.set(m.guid, { ...m, chat: chat.guid });
          n++;
        }
      }
      return n;
    },
  };
}

// Harness singleton: lives for the lifetime of the worker, so a second "upload" is incremental.
let harnessSrc: FakeSource | null = null;
let harnessStore: FakeStore | null = null;
export function createFakeDeps(): IngestDeps {
  harnessStore ??= makeStore();
  if (!harnessSrc) {
    harnessSrc = makeSource([
      { name: "Alice", n: 6000 },
      { name: "Bob", n: 3000 },
      { name: "Family Group", n: 9000, group: true },
    ]);
  } else {
    appendMessages(harnessSrc, "Alice", 500);
  }
  return { reader: makeReader(harnessSrc), extractor: makeExtractor(harnessSrc), writer: makeWriter(harnessStore) };
}
