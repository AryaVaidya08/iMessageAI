// Facade between the UI and the in-browser engine: ingest worker lifecycle, ingest progress state,
// data-changed notifications, saved-data checks and "delete all data". Everything runs in the browser.
import type { IngestCommand, IngestEvent, IngestInputFiles } from "./protocol";
import { onDataChanged, publishDataChanged } from "./events";
import { query, resetQueryWorker } from "./queryClient";
import { clearAllData, hasSavedDb } from "./storage/marker";

export type { IngestEvent } from "./protocol";

export interface SyncInfo {
  conversations: number;
  messages: number;
  lastSyncedAt: string | null; // ISO 8601
}

export interface IngestState {
  running: boolean;
  percent: number; // 0..100
  overall: { messagesDone: number; messagesTotal: number; chatsDone: number; chatsTotal: number } | null;
  error: string | null;
}

export interface IngestInput {
  chatDb: File;
  /** chat.db-wal / chat.db-shm, if the user copied them next to chat.db. */
  sidecars?: File[];
  contacts: File[];
}

type Listener = (e: IngestEvent) => void;
const listeners = new Set<Listener>();
const stateListeners = new Set<() => void>();
let state: IngestState = { running: false, percent: 0, overall: null, error: null };
let worker: Worker | null = null;

function setState(patch: Partial<IngestState>) {
  state = { ...state, ...patch };
  stateListeners.forEach((l) => l());
}

function stopWorker() {
  worker?.terminate();
  worker = null;
}

function handle(e: IngestEvent) {
  if (e.type === "overall") {
    setState({
      overall: e,
      percent: e.messagesTotal ? Math.min(100, Math.round((e.messagesDone / e.messagesTotal) * 100)) : 0,
    });
  } else if (e.type === "error" && e.fatal !== false) {
    setState({ running: false, error: e.message });
    stopWorker();
  } else if (e.type === "done") {
    setState({ running: false, percent: e.cancelled ? state.percent : 100 });
    stopWorker();
  }
  listeners.forEach((l) => l(e));
  if (e.type === "data-changed" || e.type === "done") publishDataChanged();
}

export function subscribeIngest(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function subscribeIngestState(fn: () => void): () => void {
  stateListeners.add(fn);
  return () => stateListeners.delete(fn);
}
/** Fires (from any context) whenever stored data changed: ingest chat finished, merge, delete. */
export const subscribeDataChanged = onDataChanged;
export const notifyDataChanged = publishDataChanged;

export function getIngestState(): IngestState {
  return state;
}
export function isIngestRunning(): boolean {
  return state.running;
}

export async function startIngest(input: IngestInput): Promise<void> {
  if (state.running) return;
  const files: IngestInputFiles = {
    chatDb: input.chatDb,
    chatDbWal: input.sidecars?.find((f) => /-wal$/i.test(f.name)),
    chatDbShm: input.sidecars?.find((f) => /-shm$/i.test(f.name)),
    addressBooks: input.contacts,
  };
  setState({ running: true, percent: 0, overall: null, error: null });
  try {
    worker = new Worker(new URL("./workers/ingest.worker.ts", import.meta.url), { type: "module", name: "ingest" });
    worker.onmessage = (m: MessageEvent<IngestEvent>) => handle(m.data);
    worker.onerror = (ev) => handle({ type: "error", fatal: true, message: ev.message || "ingest worker failed to load" });
    worker.postMessage({ type: "start", files } satisfies IngestCommand);
  } catch (err) {
    handle({ type: "error", fatal: true, message: String(err instanceof Error ? err.message : err) });
  }
}

export function cancelIngest(): void {
  worker?.postMessage({ type: "cancel" } satisfies IngestCommand);
}

export async function hasSavedData(): Promise<boolean> {
  return hasSavedDb();
}

export async function getSyncInfo(): Promise<SyncInfo | null> {
  if (!(await hasSavedDb())) return null;
  try {
    return await query<SyncInfo>("GET /api/sync-info");
  } catch {
    return null;
  }
}

/** Closes every DB connection, then removes all stored data. */
export async function deleteAllData(): Promise<void> {
  cancelIngest();
  stopWorker();
  setState({ running: false, percent: 0, overall: null, error: null });
  try {
    await query("POST /api/admin/close");
  } catch {
    /* the DB may never have been opened in this tab */
  }
  resetQueryWorker();
  await clearAllData();
  publishDataChanged();
}
