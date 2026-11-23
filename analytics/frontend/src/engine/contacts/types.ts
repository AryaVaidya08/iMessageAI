import type { Region } from '../handles';

/** Minimal read interface; satisfied by the file-backed SQLite reader (unit 2), sql.js, better-sqlite3 wrappers. */
export interface SqlReader {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] | Promise<T[]>;
  close?(): void | Promise<void>;
}

export type OpenReader = (file: File) => Promise<SqlReader>;

export interface ContactRow {
  handle: string;
  display_name: string;
}

export interface ContactsProgress {
  type: 'progress';
  stage: 'start' | 'file-start' | 'file-done' | 'file-error' | 'done';
  fileName?: string;
  fileIndex: number;
  fileCount: number;
  contactsFound: number;
  error?: string;
}

export interface ImportContactsOptions {
  openReader?: OpenReader;
  defaultRegion?: Region;
  batchSize?: number;
}
