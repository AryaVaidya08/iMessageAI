// Facade between UI and the ingest engine. This is a localStorage-backed STUB
// with fake events; unit 14 swaps in the real worker-backed implementation
// while keeping this exported API.

export interface SyncInfo {
  conversations: number;
  messages: number;
  lastSyncedAt: string | null; // ISO 8601
}

export interface IngestEventLite {
  type: "phase" | "chat-start" | "chat-progress" | "chat-done" | "overall" | "log" | "memory" | "error" | "done";
  [key: string]: unknown;
}

export type IngestListener = (e: IngestEventLite) => void;

const KEY = "imessage-analytics-stub-sync";
const listeners = new Set<IngestListener>();
let running = false;

function emit(e: IngestEventLite) {
  listeners.forEach((l) => l(e));
}

export async function hasSavedData(): Promise<boolean> {
  return (await getSyncInfo()) !== null;
}

export async function getSyncInfo(): Promise<SyncInfo | null> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as SyncInfo) : null;
  } catch {
    return null;
  }
}

export function isIngestRunning(): boolean {
  return running;
}

export function subscribeIngest(fn: IngestListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export async function deleteAllData(): Promise<void> {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export async function startIngest(_input: { chatDb: File; contacts: File[] }): Promise<void> {
  if (running) return;
  running = true;
  const chats = ["Family", "Alex", "Roommates", "Jordan"];
  const perChat = 500;
  const total = chats.length * perChat;
  emit({ type: "phase", phase: "parsing" });
  let done = 0;
  for (let c = 0; c < chats.length; c++) {
    emit({ type: "chat-start", chatId: `chat${c}`, name: chats[c] });
    for (let i = 0; i < perChat; i += 100) {
      await new Promise((r) => setTimeout(r, 250));
      done += 100;
      emit({ type: "chat-progress", chatId: `chat${c}`, name: chats[c], done: i + 100, total: perChat });
      emit({ type: "overall", messagesDone: done, messagesTotal: total, chatsDone: c, chatsTotal: chats.length });
    }
    emit({ type: "chat-done", chatId: `chat${c}` });
  }
  const info: SyncInfo = { conversations: chats.length, messages: total, lastSyncedAt: new Date().toISOString() };
  try {
    localStorage.setItem(KEY, JSON.stringify(info));
  } catch {
    /* ignore */
  }
  running = false;
  emit({ type: "done" });
}
