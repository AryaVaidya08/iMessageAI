// Facade between the UI and the in-browser engine (ingest worker + stored data).
// Unit 7 may provide a stub of this file; this is the real wiring.
import type { IngestCommand, IngestEvent } from "./protocol";

export type { IngestEvent } from "./protocol";

export interface SyncInfo {
  lastRowid: number;
  fingerprint: string | null;
  lastSyncedAt: string | null;
}

export interface IngestState {
  running: boolean;
  percent: number; // 0..100
  overall: { messagesDone: number; messagesTotal: number; chatsDone: number; chatsTotal: number } | null;
  error: string | null;
}

type Listener = (e: IngestEvent) => void;
const listeners = new Set<Listener>();
const dataListeners = new Set<() => void>();
const stateListeners = new Set<() => void>();

let state: IngestState = { running: false, percent: 0, overall: null, error: null };

// Set VITE_FAKE_INGEST=1 to simulate ingest without the engine.
const USE_FAKE = import.meta.env.VITE_FAKE_INGEST === "1";

function setState(patch: Partial<IngestState>) {
  state = { ...state, ...patch };
  stateListeners.forEach((l) => l());
}

function emit(e: IngestEvent) {
  if (e.type === "overall") {
    setState({
      overall: e,
      percent: e.messagesTotal ? Math.min(100, Math.round((e.messagesDone / e.messagesTotal) * 100)) : 0,
    });
  } else if (e.type === "error") {
    setState({ running: false, error: e.message });
  } else if (e.type === "done") {
    setState({ running: false, percent: 100 });
  }
  listeners.forEach((l) => l(e));
  if (e.type === "chat-done" || e.type === "done") dataListeners.forEach((l) => l());
}

export function subscribeIngest(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
/** Fires whenever stored data changed (ingest batch finished, merge, delete). */
export function subscribeDataChanged(fn: () => void): () => void {
  dataListeners.add(fn);
  return () => dataListeners.delete(fn);
}
export function subscribeIngestState(fn: () => void): () => void {
  stateListeners.add(fn);
  return () => stateListeners.delete(fn);
}
export function getIngestState(): IngestState {
  return state;
}
export function notifyDataChanged() {
  dataListeners.forEach((l) => l());
}

let worker: Worker | null = null;

async function startRealWorker(cmd: IngestCommand) {
  // TODO(unit 5): worker module must exist at engine/workers/ingest.worker.ts
  // and accept IngestCommand / post IngestEvent. Resolved via glob so the app
  // builds before that unit lands.
  const mods = import.meta.glob("./workers/ingest.worker.ts", { query: "?worker", import: "default" });
  const loader = Object.values(mods)[0] as (() => Promise<new () => Worker>) | undefined;
  if (!loader) throw new Error("ingest worker not available (engine/workers/ingest.worker.ts missing)");
  const Ctor = await loader();
  worker = new Ctor();
  worker.onmessage = (m: MessageEvent<IngestEvent>) => emit(m.data);
  worker.onerror = (ev) => emit({ type: "error", message: ev.message });
  worker.postMessage(cmd);
}

// In-memory stand-in: simulates progress so the UI can be developed without the engine.
async function startFake() {
  const chats = ["Alice", "Family group", "Bob"];
  const per = 1000;
  emit({ type: "phase", phase: "fake-ingest (no engine)" });
  let done = 0;
  for (let c = 0; c < chats.length; c++) {
    emit({ type: "chat-start", chatId: `fake-${c}`, name: chats[c] });
    for (let i = 1; i <= 5; i++) {
      await new Promise((r) => setTimeout(r, 150));
      emit({ type: "chat-progress", chatId: `fake-${c}`, name: chats[c], done: (i * per) / 5, total: per });
      done += per / 5;
      emit({ type: "overall", messagesDone: done, messagesTotal: per * chats.length, chatsDone: c, chatsTotal: chats.length });
    }
    emit({ type: "chat-done", chatId: `fake-${c}` });
  }
  emit({ type: "done" });
}

export async function startIngest(args: { chatDb: File; contacts: File[] }): Promise<void> {
  setState({ running: true, percent: 0, overall: null, error: null });
  const cmd: IngestCommand = { type: "start", chatDb: args.chatDb, contacts: args.contacts };
  try {
    if (USE_FAKE) await startFake();
    else await startRealWorker(cmd);
  } catch (err) {
    emit({ type: "error", message: String(err instanceof Error ? err.message : err) });
  }
}

export function cancelIngest() {
  worker?.postMessage({ type: "cancel" } satisfies IngestCommand);
}

// TODO(unit 3/8): replace with a query against sync_state in the app DB.
export async function getSyncInfo(): Promise<SyncInfo | null> {
  try {
    const raw = localStorage.getItem("imsg.syncInfo");
    return raw ? (JSON.parse(raw) as SyncInfo) : null;
  } catch {
    return null;
  }
}
export async function hasSavedData(): Promise<boolean> {
  return (await getSyncInfo()) !== null;
}

// TODO(unit 3): also remove the OPFS database file explicitly.
export async function deleteAllData(): Promise<void> {
  try {
    localStorage.removeItem("imsg.syncInfo");
    const root = (await navigator.storage?.getDirectory?.()) as any;
    if (root) for await (const name of root.keys()) await root.removeEntry(name, { recursive: true });
  } catch {
    // OPFS unavailable; nothing to delete
  }
  notifyDataChanged();
}
