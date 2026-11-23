// data-changed pub/sub: ingest worker -> main thread, via BroadcastChannel.
const CHANNEL = "imsg-data-changed";

export function publishDataChanged(): void {
  try {
    const ch = new BroadcastChannel(CHANNEL);
    ch.postMessage({ type: "data-changed", at: Date.now() });
    ch.close();
  } catch {
    // BroadcastChannel unavailable; ignore.
  }
}

/** Subscribe; returns unsubscribe. */
export function onDataChanged(fn: () => void): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const ch = new BroadcastChannel(CHANNEL);
  ch.onmessage = () => fn();
  return () => ch.close();
}
