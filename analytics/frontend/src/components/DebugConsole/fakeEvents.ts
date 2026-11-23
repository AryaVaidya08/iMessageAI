import type { IngestSubscribe } from "../../engine/protocol";

/** Fake ingest generator for the demo page. Each subscribe() starts a fresh run. */
export function makeFakeIngest(opts: { chats?: number; speed?: number } = {}): IngestSubscribe {
  const chats = opts.chats ?? 12;
  const speed = opts.speed ?? 1;
  return (emit) => {
    const sizes = Array.from({ length: chats }, (_, i) => 800 + ((i * 7919) % 6000));
    const total = sizes.reduce((a, b) => a + b, 0);
    let chat = 0;
    let inChat = 0;
    let done = 0;
    let started = false;
    const timer = setInterval(() => {
      if (!started) {
        started = true;
        emit({ type: "phase", phase: "ingest", label: "Parsing chat.db" });
        emit({ type: "chat-start", chatId: "c0", name: "Chat 1", total: sizes[0] });
      }
      const step = Math.round((150 + Math.random() * 250) * speed);
      const n = Math.min(step, sizes[chat] - inChat);
      inChat += n;
      done += n;
      const name = `Chat ${chat + 1}`;
      emit({ type: "chat-progress", chatId: `c${chat}`, name, done: inChat, total: sizes[chat] });
      emit({ type: "overall", messagesDone: done, messagesTotal: total, chatsDone: chat, chatsTotal: chats });
      emit({ type: "log", message: `batch ${n} msgs in ${name}` });
      emit({ type: "memory", usedMB: 120 + Math.random() * 60, limitMB: 500 });
      if (Math.random() < 0.02) emit({ type: "error", message: "malformed attributedBody", chatId: `c${chat}` });
      if (Math.random() < 0.03) emit({ type: "log", level: "warn", message: "slow batch" });
      if (inChat >= sizes[chat]) {
        emit({ type: "chat-done", chatId: `c${chat}`, name });
        chat++;
        inChat = 0;
        if (chat >= chats) {
          emit({ type: "overall", messagesDone: total, messagesTotal: total, chatsDone: chats, chatsTotal: chats });
          emit({ type: "done", summary: `${total} messages` });
          clearInterval(timer);
          return;
        }
        emit({ type: "chat-start", chatId: `c${chat}`, name: `Chat ${chat + 1}`, total: sizes[chat] });
      }
    }, 120);
    return () => clearInterval(timer);
  };
}
