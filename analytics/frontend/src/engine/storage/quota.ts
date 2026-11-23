export interface QuotaInfo {
  usageMB: number;
  quotaMB: number;
  availableMB: number;
}

export async function getQuota(): Promise<QuotaInfo | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  const mb = (n: number) => Math.round(n / 1048576);
  return { usageMB: mb(usage), quotaMB: mb(quota), availableMB: mb(Math.max(0, quota - usage)) };
}

/** Pure check, exported for tests. Parsed DB is a fraction of chat.db; require headroom. */
export function hasRoomFor(q: QuotaInfo | null, chatDbBytes: number, factor = 1.5): boolean {
  if (!q) return true; // unknown: don't block
  return q.availableMB * 1048576 >= chatDbBytes * factor;
}

/** Asks the browser not to evict our OPFS data. Best-effort. */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
