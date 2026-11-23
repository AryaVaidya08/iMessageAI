// Worker protocol shared by ingest and query workers (contract #2).

export interface OverallProgress {
  messagesDone: number;
  messagesTotal: number;
  chatsDone: number;
  chatsTotal: number;
  /** ETA inputs (optional extras) */
  elapsedMs?: number;
  messagesPerSec?: number;
}

export type IngestPhase =
  | "opening"
  | "contacts"
  | "planning"
  | "chats"
  | "edits"
  | "summaries"
  | "finalizing";

export type IngestEvent =
  | { type: "phase"; phase: IngestPhase; detail?: string }
  | { type: "chat-start"; chatId: string; name: string; index: number; total: number }
  | { type: "chat-progress"; chatId: string; name: string; done: number; total: number }
  | { type: "chat-done"; chatId: string; name: string; inserted: number; updated: number }
  | ({ type: "overall" } & OverallProgress)
  | { type: "log"; level: "info" | "warn" | "error"; message: string; ts: number }
  | { type: "memory"; usedMB: number; limitMB: number }
  | { type: "data-changed"; chatId?: string }
  | { type: "error"; message: string; fatal: boolean }
  | {
      type: "done";
      cancelled: boolean;
      skipped: boolean; // nothing changed (fingerprint match)
      inserted: number;
      updated: number;
      chatsChanged: number;
    };

export interface IngestOptions {
  batchSize?: number; // 2000-5000
  importContacts?: boolean;
  /** Use in-memory fakes instead of real chat.db (harness/tests only). */
  useFakeDeps?: boolean;
}

export interface IngestInputFiles {
  chatDb: File;
  addressBooks?: File[];
}

export type IngestCommand =
  | { type: "start"; files: IngestInputFiles; options?: IngestOptions }
  | { type: "cancel" };
