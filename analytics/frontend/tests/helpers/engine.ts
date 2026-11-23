// Adapter between the parity spec and the TS engine. The engine units (query worker etc.) are built in parallel,
// so the spec only depends on this tiny interface. TODO(engine merge): create tests/helpers/engine-impl.ts (or point
// PARITY_ENGINE_MODULE at a module) exporting `createParityEngine`, which should:
//   1. open an in-memory/Node SQLite-WASM (OPFS is unavailable in Node) with the app schema (src/engine/schema.ts),
//   2. run the ingest pipeline over `chatDbPath` (+ AddressBook files under `addressBookDir`),
//   3. expose request(method, path, body) that maps the legacy FastAPI paths to query(route, params).
import { DatabaseSync } from "../../scripts/lib/sqlite";
import type { Tokens } from "./diff";

export interface ParityEngine {
  request(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  close(): Promise<void> | void;
}

export interface EngineInit {
  chatDbPath: string;
  addressBookDir: string;
}

export async function loadEngine(init: EngineInit): Promise<ParityEngine> {
  const spec = process.env.PARITY_ENGINE_MODULE ?? "./engine-impl";
  const mod = await import(/* @vite-ignore */ spec);
  return (mod.createParityEngine as (i: EngineInit) => Promise<ParityEngine>)(init);
}

/** New-engine ids: conversation = chat.guid, participant = handle (or "me"), message = message.guid. */
export function newEngineTokens(chatDbPath: string): Tokens {
  const db = new DatabaseSync(chatDbPath, { readOnly: true });
  const t: Tokens = new Map();
  for (const r of db.prepare("SELECT guid FROM chat").all() as { guid: string }[]) t.set(r.guid, `conv:${r.guid}`);
  for (const r of db.prepare("SELECT id FROM handle").all() as { id: string }[]) t.set(r.id, `person:${r.id}`);
  t.set("me", "person:me");
  // message guids are only needed for cursors/ids in message pages; 600 rows is cheap, but cap for big fixtures
  for (const r of db.prepare("SELECT guid FROM message LIMIT 200000").all() as { guid: string }[]) t.set(r.guid, `msg:${r.guid}`);
  db.close();
  return t;
}

/** Legacy ids (uuid5s) -> same neutral tokens, from tests/golden/_idmap.json. */
export function legacyTokens(idmap: { conv: Record<string, string>; person: Record<string, string>; msg: Record<string, string> }): Tokens {
  const t: Tokens = new Map();
  for (const [k, v] of Object.entries(idmap.conv)) t.set(k, `conv:${v}`);
  for (const [k, v] of Object.entries(idmap.person)) t.set(k, `person:${v}`);
  for (const [k, v] of Object.entries(idmap.msg)) t.set(k, `msg:${v}`);
  return t;
}

/** Resolve {conv:#6}/{person:+1555..}/{msg:rowid:200} placeholders to NEW-engine ids (url-encoded). */
export function resolvePlaceholders(s: string, chatDbPath: string): string {
  const db = new DatabaseSync(chatDbPath, { readOnly: true });
  try {
    return s.replace(/\{(conv|person|msg):([^}]+)\}/g, (_m, kind: string, key: string) => {
      if (kind === "conv") {
        const guid = key.startsWith("#")
          ? (db.prepare("SELECT guid FROM chat WHERE ROWID = ?").get(Number(key.slice(1))) as { guid: string }).guid
          : key;
        return encodeURIComponent(guid);
      }
      if (kind === "person") return encodeURIComponent(key);
      const rowid = Number(key.split(":")[1]);
      return encodeURIComponent((db.prepare("SELECT guid FROM message WHERE ROWID = ?").get(rowid) as { guid: string }).guid);
    });
  } finally {
    db.close();
  }
}
