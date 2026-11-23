/// <reference lib="webworker" />
import type { IngestCommand, IngestEvent } from "../protocol";
import { runIngest } from "../ingest/orchestrator";
import { createRealDeps } from "../ingest/deps";
import type { IngestDeps } from "../ingest/ports";

let abort: AbortController | null = null;
const post = (e: IngestEvent) => (self as unknown as Worker).postMessage(e);

self.onmessage = async (ev: MessageEvent<IngestCommand>) => {
  const cmd = ev.data;
  if (cmd.type === "cancel") {
    abort?.abort();
    return;
  }
  if (cmd.type !== "start" || abort) return;
  abort = new AbortController();
  let deps: IngestDeps | null = null;
  try {
    if (navigator.storage?.estimate) {
      const { quota = 0, usage = 0 } = await navigator.storage.estimate();
      const need = cmd.files?.chatDb?.size ?? 0;
      post({
        type: "log",
        level: "info",
        ts: Date.now(),
        message: `storage: ${Math.round(usage / 1048576)} MB used of ${Math.round(quota / 1048576)} MB`,
      });
      if (quota && quota - usage < need * 0.5) {
        post({ type: "error", fatal: true, message: "Not enough browser storage available for this chat.db" });
        return;
      }
    }
    if (cmd.options?.useFakeDeps && import.meta.env.DEV) {
      deps = (await import("../ingest/fakes")).createFakeDeps();
    } else {
      deps = await createRealDeps(cmd.files);
    }
    await runIngest({ deps, emit: post, signal: abort.signal, files: cmd.files, options: cmd.options });
  } catch (e) {
    post({ type: "error", fatal: true, message: (e as Error).message ?? String(e) });
  } finally {
    try { await deps?.reader.close(); } catch { /* ignore */ }
    try { await deps?.writer.close?.(); } catch { /* ignore */ }
    abort = null;
  }
};
