import type { IngestEvent, IngestOptions, IngestInputFiles } from "../protocol";
import type { ChatInfo, Fingerprint, IngestDeps, MessageBatch } from "./ports";

export type SummaryHook = (
  chatIds: string[],
  ctx: { emit: (e: IngestEvent) => void; signal: AbortSignal },
) => Promise<void> | void;

const summaryHooks: SummaryHook[] = [];
/** Stats units register a function refreshing summary_* tables for the changed chats. */
export function registerSummaryHook(h: SummaryHook): () => void {
  summaryHooks.push(h);
  return () => {
    const i = summaryHooks.indexOf(h);
    if (i >= 0) summaryHooks.splice(i, 1);
  };
}

export type MemorySampler = () => { usedMB: number; limitMB: number } | null;

export const defaultMemorySampler: MemorySampler = () => {
  const m = (globalThis as any).performance?.memory;
  if (!m) return null;
  return {
    usedMB: Math.round(m.usedJSHeapSize / 1048576),
    limitMB: Math.round(m.jsHeapSizeLimit / 1048576),
  };
};

export interface RunArgs {
  deps: IngestDeps;
  emit: (e: IngestEvent) => void;
  signal: AbortSignal;
  files?: IngestInputFiles;
  options?: IngestOptions;
  sampleMemory?: MemorySampler;
  now?: () => number;
}

class Cancelled extends Error {}

const KEY_FP = "chat_db_fingerprint";
const KEY_LAST = "last_rowid";

export function fingerprintsEqual(a: Fingerprint | null, b: Fingerprint): boolean {
  return (
    !!a &&
    a.size === b.size &&
    a.maxRowid === b.maxRowid &&
    a.messageCount === b.messageCount &&
    a.chatCount === b.chatCount &&
    (a.editSignal ?? 0) === (b.editSignal ?? 0)
  );
}

export async function runIngest(args: RunArgs): Promise<void> {
  const { deps, emit, signal } = args;
  const { reader, extractor, writer } = deps;
  const batchSize = Math.min(5000, Math.max(1, args.options?.batchSize ?? 2000));
  const now = args.now ?? (() => Date.now());
  const sample = args.sampleMemory ?? defaultMemorySampler;
  const t0 = now();
  const log = (message: string, level: "info" | "warn" | "error" = "info") =>
    emit({ type: "log", level, message, ts: now() });
  const check = () => {
    if (signal.aborted) throw new Cancelled();
  };
  const mem = () => {
    const s = sample();
    if (s) emit({ type: "memory", ...s });
  };

  let inserted = 0,
    updated = 0,
    chatsChanged = 0;
  const changed = new Set<string>();
  try {
    emit({ type: "phase", phase: "opening" });
    const fp = await reader.fingerprint();
    log(`chat.db: ${fp.messageCount} messages, ${fp.chatCount} chats, max ROWID ${fp.maxRowid}`);

    if (deps.contacts && args.files?.addressBooks?.length && args.options?.importContacts !== false) {
      check();
      emit({ type: "phase", phase: "contacts" });
      try {
        const n = await deps.contacts.importContacts(args.files.addressBooks, writer);
        log(`imported ${n} contacts`);
        emit({ type: "data-changed" });
      } catch (e) {
        log(`contacts import failed: ${(e as Error).message}`, "warn");
      }
    }

    if (deps.preflight) {
      check();
      await deps.preflight();
    }

    check();
    const prevRaw = await writer.getSyncState(KEY_FP);
    let prev: Fingerprint | null = null;
    try {
      prev = prevRaw ? (JSON.parse(prevRaw) as Fingerprint) : null;
    } catch {
      prev = null;
    }
    if (fingerprintsEqual(prev, fp)) {
      log("chat.db unchanged since last sync; nothing to do");
      emit({ type: "done", cancelled: false, skipped: true, inserted: 0, updated: 0, chatsChanged: 0 });
      return;
    }

    emit({ type: "phase", phase: "planning" });
    const chats = await reader.listChats();
    const hadStored = new Set<string>();
    const plan: { chat: ChatInfo; after: number; expected: number }[] = [];
    for (const chat of chats) {
      check();
      const st = await writer.getChatState(chat.guid);
      // Per-chat last ROWID is derived from stored rows (and written transactionally with
      // each batch), so an interrupted run resumes exactly where it stopped.
      if (st.count > 0) hadStored.add(chat.guid);
      if (chat.maxRowid > st.maxRowid) {
        plan.push({ chat, after: st.maxRowid, expected: Math.max(0, chat.messageCount - st.count) });
      }
    }
    const overall = {
      messagesDone: 0,
      messagesTotal: plan.reduce((s, p) => s + p.expected, 0),
      chatsDone: 0,
      chatsTotal: plan.length,
    };
    const emitOverall = () => {
      const elapsedMs = now() - t0;
      emit({
        type: "overall",
        ...overall,
        elapsedMs,
        messagesPerSec: elapsedMs > 0 ? Math.round((overall.messagesDone * 1000) / elapsedMs) : 0,
      });
    };
    emitOverall();

    emit({ type: "phase", phase: "chats" });
    let idx = 0;
    for (const { chat, after, expected } of plan) {
      check();
      idx++;
      log(`parsing ${chat.name} (${idx}/${plan.length})`);
      emit({ type: "chat-start", chatId: chat.guid, name: chat.name, index: idx, total: plan.length });
      await writer.upsertConversation(chat);
      let done = 0,
        ins = 0,
        nb = 0;
      for await (const batch of extractor.extractChat(chat, { afterRowid: after, batchSize })) {
        check();
        if (!batch.messages.length) continue;
        const top = Math.max(...batch.messages.map((m) => m.rowid));
        ins += await writer.writeBatch(chat, batch, { [`chat_last_rowid:${chat.guid}`]: String(top) });
        done += batch.messages.length;
        overall.messagesDone += batch.messages.length;
        emit({
          type: "chat-progress",
          chatId: chat.guid,
          name: chat.name,
          done,
          total: Math.max(expected, done),
        });
        emitOverall();
        if (++nb % 5 === 0) mem();
        // yield so a queued cancel message can be handled between batches
        await new Promise((r) => setTimeout(r, 0));
      }
      // messages the extractor skips (no text, no attachment) still count as handled for progress
      if (done < expected) overall.messagesDone += expected - done;
      inserted += ins;
      overall.chatsDone++;
      if (ins > 0) changed.add(chat.guid);
      emit({ type: "chat-done", chatId: chat.guid, name: chat.name, inserted: ins, updated: 0 });
      if (ins > 0) emit({ type: "data-changed", chatId: chat.guid });
      emitOverall();
    }

    // Edit / retract re-check of already-stored messages (chats that had stored rows before this run)
    {
      emit({ type: "phase", phase: "edits" });
      for (const chat of chats) {
        check();
        if (!hadStored.has(chat.guid)) continue; // nothing stored before this run
        const upd = await recheckEdits(chat, deps, batchSize, check);
        if (upd > 0) {
          updated += upd;
          changed.add(chat.guid);
          log(`${chat.name}: ${upd} edited/retracted messages updated`);
          emit({ type: "data-changed", chatId: chat.guid });
        }
      }
    }
    chatsChanged = changed.size;

    if (changed.size && summaryHooks.length) {
      check();
      emit({ type: "phase", phase: "summaries" });
      for (const h of summaryHooks) await h([...changed], { emit, signal });
      emit({ type: "data-changed" });
    }

    emit({ type: "phase", phase: "finalizing" });
    await writer.setSyncState(KEY_LAST, String(fp.maxRowid));
    await writer.setSyncState(KEY_FP, JSON.stringify(fp));
    mem();
    log(`sync complete: ${inserted} inserted, ${updated} updated`);
    emit({ type: "done", cancelled: false, skipped: false, inserted, updated, chatsChanged });
  } catch (e) {
    if (e instanceof Cancelled) {
      // fingerprint intentionally NOT written: next run resumes from per-chat last rowid
      log("ingest cancelled; progress saved, will resume on next run", "warn");
      emit({ type: "done", cancelled: true, skipped: false, inserted, updated, chatsChanged: changed.size });
    } else {
      emit({ type: "error", message: (e as Error).message ?? String(e), fatal: true });
    }
  }
}

async function recheckEdits(
  chat: ChatInfo,
  deps: IngestDeps,
  batchSize: number,
  check: () => void,
): Promise<number> {
  const { extractor, writer } = deps;
  let updated = 0;
  for await (const states of extractor.scanEditState(chat, batchSize)) {
    check();
    const stored = await writer.getEditStates(states.map((s) => s.guid));
    const stale = states.filter((s) => {
      const t = stored.get(s.guid);
      return t !== undefined && (t.dateEdited !== s.dateEdited || t.dateRetracted !== s.dateRetracted);
    });
    if (!stale.length) continue;
    const batch: MessageBatch = await extractor.fetchMessages(chat, stale.map((s) => s.rowid));
    updated += await writer.applyEdits(chat, batch);
  }
  return updated;
}
