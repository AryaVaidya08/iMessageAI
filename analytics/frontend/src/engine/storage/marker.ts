// Light, main-thread-safe pieces of storage: "is there a saved DB?" and "delete everything".
// (db.ts pulls in the wasm; this file must stay import-light.)
export const IDB_NAME = "imessage-analytics-db"; // IndexedDB database used by IDBBatchAtomicVFS
export const MARKER = "imessage-analytics.marker"; // OPFS marker file written when the DB is first opened

/** True when a previously-saved DB exists (cheap; does not open it). */
export async function hasSavedDb(): Promise<boolean> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.getFileHandle(MARKER);
    return true;
  } catch {
    return false;
  }
}

export async function markSaved(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  await root.getFileHandle(MARKER, { create: true });
}

function deleteIdb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("could not delete database"));
    // onblocked: another connection is still open; the delete completes once it closes.
    req.onblocked = () => {};
  });
}

/** Deletes all stored data. Close the DB in every worker first (or terminate those workers). */
export async function clearAllData(): Promise<void> {
  await Promise.race([
    deleteIdb(IDB_NAME),
    new Promise<void>((_, rej) => setTimeout(() => rej(new Error("Timed out waiting for the database to close")), 10000)),
  ]);
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(MARKER);
  } catch (e) {
    if ((e as { name?: string })?.name !== "NotFoundError") throw e;
  }
}
