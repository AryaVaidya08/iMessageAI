// Worker protocol (contract). Keep minimal; sibling units extend by adding commands, not changing events.
export type IngestEvent =
  | { type: "phase"; phase: string; label?: string }
  | { type: "chat-start"; chatId: string; name: string; total: number }
  | { type: "chat-progress"; chatId: string; name: string; done: number; total: number }
  | { type: "chat-done"; chatId: string; name?: string }
  | {
      type: "overall";
      messagesDone: number;
      messagesTotal: number;
      chatsDone: number;
      chatsTotal: number;
    }
  | { type: "log"; level?: "debug" | "info" | "warn" | "error"; message: string }
  | { type: "memory"; usedMB: number; limitMB: number }
  | { type: "error"; message: string; chatId?: string }
  | { type: "done"; summary?: string };

export type IngestSubscribe = (fn: (e: IngestEvent) => void) => () => void;
