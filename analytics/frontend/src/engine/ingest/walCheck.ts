// Peeks at the 100-byte SQLite header (no full read) to see whether a database is in WAL mode.
// In WAL mode the newest messages can live in the separate chat.db-wal file.
export async function isWalMode(file: Blob): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 100).arrayBuffer());
  // bytes 18 and 19 are the file-format write/read versions: 2 = WAL.
  return head.length >= 20 && head[18] === 2 && head[19] === 2;
}

const isSidecar = (f: File) => /-(wal|shm)$/i.test(f.name);

/** Splits a mixed selection into the main database file and its -wal / -shm sidecars. */
export function splitChatDbFiles(files: File[]): { main: File | null; sidecars: File[] } {
  const sidecars = files.filter(isSidecar);
  const mains = files.filter((f) => !isSidecar(f));
  const main = mains.find((f) => /^chat\.db$/i.test(f.name)) ?? mains[0] ?? null;
  return { main, sidecars };
}
