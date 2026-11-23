// Fixture AddressBook generator: Core Data style tables as in AddressBook-v22.abcddb.
import { DatabaseSync } from "./sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeCast } from "./cast";

const SCHEMA = `
CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZFIRSTNAME VARCHAR, ZLASTNAME VARCHAR,
  ZMIDDLENAME VARCHAR, ZNICKNAME VARCHAR, ZORGANIZATION VARCHAR, ZUNIQUEID VARCHAR);
CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZOWNER INTEGER, ZFULLNUMBER VARCHAR, ZLABEL VARCHAR);
CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZOWNER INTEGER, ZADDRESS VARCHAR, ZADDRESSNORMALIZED VARCHAR, ZLABEL VARCHAR);
`;

function writeOne(path: string, records: ReturnType<typeof makeCast>): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) rmSync(path);
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  const rec = db.prepare("INSERT INTO ZABCDRECORD (Z_ENT, Z_OPT, ZFIRSTNAME, ZLASTNAME, ZORGANIZATION, ZUNIQUEID) VALUES (22, 1, ?, ?, ?, ?)");
  const ph = db.prepare("INSERT INTO ZABCDPHONENUMBER (Z_ENT, Z_OPT, ZOWNER, ZFULLNUMBER, ZLABEL) VALUES (23, 1, ?, ?, '_$!<Mobile>!$_')");
  const em = db.prepare("INSERT INTO ZABCDEMAILADDRESS (Z_ENT, Z_OPT, ZOWNER, ZADDRESS, ZADDRESSNORMALIZED, ZLABEL) VALUES (12, 1, ?, ?, ?, '_$!<Home>!$_')");
  db.exec("BEGIN");
  records.forEach((p, i) => {
    const r = rec.run(p.first || null, p.last || null, p.org ?? null, `AB-${i}`);
    const pk = Number(r.lastInsertRowid);
    for (const n of p.abPhones) ph.run(pk, n);
    for (const e of p.abEmails) em.run(pk, e, e.toLowerCase());
  });
  db.exec("COMMIT");
  db.close();
}

/**
 * Writes `<dir>/AddressBook-v22.abcddb` (legacy location, first 4 contacts) and
 * `<dir>/Sources/<UUID>/AddressBook-v22.abcddb` x2 (the rest, split in two; one contact duplicated across both sources).
 */
export function generateAddressBooks(dir: string, people = 8): string[] {
  const cast = makeCast(people).filter((p) => p.inAddressBook);
  const files = [
    join(dir, "AddressBook-v22.abcddb"),
    join(dir, "Sources", "11111111-AAAA-4BBB-8CCC-000000000001", "AddressBook-v22.abcddb"),
    join(dir, "Sources", "22222222-AAAA-4BBB-8CCC-000000000002", "AddressBook-v22.abcddb"),
  ];
  writeOne(files[0], cast.slice(0, 2));
  writeOne(files[1], cast.slice(2, 4));
  writeOne(files[2], [cast[3], ...cast.slice(4)]); // Dev appears in both Sources files
  return files;
}
