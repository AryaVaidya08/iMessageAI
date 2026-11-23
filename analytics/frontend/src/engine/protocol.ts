// Worker protocol contract (shared with the ingest/query worker units).
export interface OverallProgress {
  messagesDone: number;
  messagesTotal: number;
  chatsDone: number;
  chatsTotal: number;
}

export type IngestEvent =
  | { type: "phase"; phase: string }
  | { type: "chat-start"; chatId: string; name: string }
  | { type: "chat-progress"; chatId: string; name: string; done: number; total: number }
  | { type: "chat-done"; chatId: string }
  | ({ type: "overall" } & OverallProgress)
  | { type: "log"; level?: "info" | "warn" | "error"; message: string }
  | { type: "memory"; usedMB: number; limitMB: number }
  | { type: "error"; message: string }
  | { type: "done" };

export type IngestCommand =
  | { type: "start"; chatDb: File; contacts: File[] }
  | { type: "cancel" };
