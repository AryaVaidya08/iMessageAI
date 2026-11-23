import { describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { importContacts, pickAbcddbFiles } from './importContacts';
import type { ContactRow, SqlReader } from './types';

const SCHEMA = `
CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZORGANIZATION TEXT);
CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZFULLNUMBER TEXT);
CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZADDRESS TEXT);`;

async function build(sql: string): Promise<File[]> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(SCHEMA + sql);
  return [new File([db.export() as BlobPart], 'AddressBook-v22.abcddb')];
}

const openReader = async (file: File): Promise<SqlReader> => {
  const SQL = await initSqlJs();
  const db = new SQL.Database(new Uint8Array(await file.arrayBuffer()));
  return {
    query<T>(q: string, params: unknown[] = []) {
      const st = db.prepare(q);
      st.bind(params as never[]);
      const out: T[] = [];
      while (st.step()) out.push(st.getAsObject() as T);
      st.free();
      return out;
    },
    close: () => db.close(),
  };
};

async function collect(files: File[], opts = {}) {
  const rows: ContactRow[] = [];
  const progress: string[] = [];
  for await (const x of importContacts(files, { openReader, ...opts })) {
    if (Array.isArray(x)) rows.push(...x); else progress.push(x.stage);
  }
  return { rows, progress };
}

describe('importContacts', () => {
  it('reads, names, normalizes and dedupes across files', async () => {
    const a = await build(`
      INSERT INTO ZABCDRECORD VALUES (1,'Ada','Lovelace',NULL),(2,NULL,NULL,'Acme Corp'),(3,'Bob',NULL,NULL),(4,NULL,NULL,NULL);
      INSERT INTO ZABCDPHONENUMBER VALUES (1,1,'(415) 555-2671'),(2,2,'+44 20 7946 0958'),(3,4,'+1 212 555 0000'),(4,3,NULL);
      INSERT INTO ZABCDEMAILADDRESS VALUES (1,1,'Ada@Example.com'),(2,3,'bob@x.org');`);
    const b = await build(`
      INSERT INTO ZABCDRECORD VALUES (1,'Other','Person',NULL),(2,'New','One',NULL);
      INSERT INTO ZABCDPHONENUMBER VALUES (1,1,'4155552671'),(2,2,'+33 1 23 45 67 89');`);
    const { rows, progress } = await collect([...a, ...b, new File([], 'x.abcddb-wal')]);
    const m = new Map(rows.map((r) => [r.handle, r.display_name]));
    expect(m.get('+14155552671')).toBe('Ada Lovelace'); // first wins
    expect(m.get('+442079460958')).toBe('Acme Corp');
    expect(m.get('ada@example.com')).toBe('Ada Lovelace');
    expect(m.get('bob@x.org')).toBe('Bob');
    expect(m.get('+33123456789')).toBe('New One');
    expect(m.has('+12125550000')).toBe(false); // nameless record skipped
    expect(rows.length).toBe(m.size);
    expect(progress.filter((s) => s === 'file-done').length).toBe(2);
    expect(progress[progress.length - 1]).toBe('done');
  });

  it('reports unreadable files and continues', async () => {
    const good = await build(`INSERT INTO ZABCDRECORD VALUES (1,'A','B',NULL); INSERT INTO ZABCDPHONENUMBER VALUES (1,1,'+14155552671');`);
    const bad = new File([new Uint8Array([1, 2, 3])], 'bad.abcddb');
    const { rows, progress } = await collect([bad, ...good]);
    expect(progress).toContain('file-error');
    expect(rows).toHaveLength(1);
  });

  it('filters directory selections', () => {
    const fs = ['a.abcddb', 'a.abcddb-wal', 'readme.txt', 'B.ABCDDB'].map((n) => new File([], n));
    expect(pickAbcddbFiles(fs).map((f) => f.name)).toEqual(['a.abcddb', 'B.ABCDDB']);
  });
});
