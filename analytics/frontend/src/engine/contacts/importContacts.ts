import { DEFAULT_REGION, normalizeHandle } from '../handles';
import type { ContactRow, ContactsProgress, ImportContactsOptions, OpenReader, SqlReader } from './types';

let defaultOpenReader: OpenReader | undefined;
/** Wire in the file-backed SQLite reader (unit 2) once at app start. */
export function setDefaultOpenReader(fn: OpenReader) { defaultOpenReader = fn; }

/** Keep only AddressBook databases (handles webkitdirectory selections; ignores -wal/-shm etc.). */
export function pickAbcddbFiles(files: Iterable<File>): File[] {
  return [...files].filter((f) => /\.abcddb$/i.test(f.name));
}

/** Python contacts.py rule: "first last" else organization, else empty (skipped). */
export function contactName(first?: string | null, last?: string | null, org?: string | null): string {
  const parts = [first, last].map((p) => (p ?? '').trim()).filter(Boolean);
  return parts.length ? parts.join(' ') : (org ?? '').trim();
}

type Rec = { Z_PK: number; ZFIRSTNAME: string | null; ZLASTNAME: string | null; ZORGANIZATION: string | null };

/** A missing optional table (some AddressBook variants) counts as empty. */
async function safeQuery<T>(reader: SqlReader, sql: string): Promise<T[]> {
  try { return await reader.query<T>(sql); } catch { return []; }
}

async function* readOne(reader: SqlReader, region: ImportContactsOptions['defaultRegion']): AsyncGenerator<ContactRow> {
  const recs = await reader.query<Rec>('SELECT Z_PK, ZFIRSTNAME, ZLASTNAME, ZORGANIZATION FROM ZABCDRECORD');
  const names = new Map<number, string>();
  for (const r of recs) {
    const n = contactName(r.ZFIRSTNAME, r.ZLASTNAME, r.ZORGANIZATION);
    if (n) names.set(r.Z_PK, n);
  }
  const phones = await safeQuery<{ ZOWNER: number; ZFULLNUMBER: string | null }>(
    reader, 'SELECT ZOWNER, ZFULLNUMBER FROM ZABCDPHONENUMBER');
  for (const p of phones) {
    const name = names.get(p.ZOWNER);
    const handle = p.ZFULLNUMBER ? normalizeHandle(p.ZFULLNUMBER, region ?? DEFAULT_REGION) : '';
    if (name && handle) yield { handle, display_name: name };
  }
  const emails = await safeQuery<{ ZOWNER: number; ZADDRESS: string | null }>(
    reader, 'SELECT ZOWNER, ZADDRESS FROM ZABCDEMAILADDRESS');
  for (const e of emails) {
    const name = names.get(e.ZOWNER);
    const handle = e.ZADDRESS ? normalizeHandle(e.ZADDRESS) : '';
    if (name && handle) yield { handle, display_name: name };
  }
}

/**
 * Import contacts from several .abcddb files. Yields progress objects and batches of
 * deduped {handle, display_name} rows. First file/record to claim a handle wins (as in contacts.py).
 * Unreadable files are reported via a 'file-error' progress event and skipped.
 */
export async function* importContacts(
  input: File[],
  opts: ImportContactsOptions = {},
): AsyncGenerator<ContactsProgress | ContactRow[]> {
  const open = opts.openReader ?? defaultOpenReader;
  if (!open) throw new Error('No SQLite reader configured for contacts import');
  const batchSize = opts.batchSize ?? 500;
  const files = pickAbcddbFiles(input).sort((a, b) => a.name.localeCompare(b.name)); // stable winner
  const seen = new Set<string>();
  const fileCount = files.length;
  let found = 0;
  yield { type: 'progress', stage: 'start', fileIndex: 0, contactsFound: 0, fileCount };

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    yield { type: 'progress', stage: 'file-start', fileName: file.name, fileIndex: i, contactsFound: found, fileCount };
    let reader: SqlReader | undefined;
    let batch: ContactRow[] = [];
    try {
      reader = await open(file);
      for await (const row of readOne(reader, opts.defaultRegion)) {
        if (seen.has(row.handle)) continue;
        seen.add(row.handle);
        found++;
        batch.push(row);
        if (batch.length >= batchSize) { yield batch; batch = []; }
      }
      if (batch.length) yield batch;
      yield { type: 'progress', stage: 'file-done', fileName: file.name, fileIndex: i, contactsFound: found, fileCount };
    } catch (err) {
      if (batch.length) yield batch; // don't lose rows read before the failure
      yield { type: 'progress', stage: 'file-error', fileName: file.name, fileIndex: i, contactsFound: found, fileCount,
        error: err instanceof Error ? err.message : String(err) };
    } finally {
      try { await reader?.close?.(); } catch { /* ignore */ }
    }
  }
  yield { type: 'progress', stage: 'done', fileIndex: files.length, contactsFound: found, fileCount };
}
