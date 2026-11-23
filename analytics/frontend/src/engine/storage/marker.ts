// Light, main-thread-safe pieces of storage: "is there a saved DB?" and "delete everything".
// (db.ts pulls in the wasm; this file must stay import-light.)
export const OPFS_DIR_NAME = "imessage-analytics"; // directory used by AccessHandlePoolVFS
export const MARKER = "imessage-analytics.marker"; // marker file written when the DB is first opened

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

async function removeIfPresent(root: FileSystemDirectoryHandle, name: string, recursive: boolean) {
  try {
    await root.removeEntry(name, { recursive });
  } catch (e) {
    if ((e as { name?: string })?.name !== "NotFoundError") throw e;
  }
}

/** Deletes all stored data. The engine worker must be closed/terminated first (it holds exclusive file handles). */
export async function clearAllData(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  await removeIfPresent(root, OPFS_DIR_NAME, true);
  await removeIfPresent(root, MARKER, false);
}
