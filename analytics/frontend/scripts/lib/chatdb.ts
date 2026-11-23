// Synthetic macOS chat.db generator (stream-writes through SQLite, so memory stays flat even at 1 GB).
// Uses node:sqlite (Node >= 22.5). Fully deterministic for a given (size, seed, append history).
import { DatabaseSync, type StatementSync } from "./sqlite";
import { existsSync, rmSync, statSync } from "node:fs";
import { makeCast, type Person } from "./cast";
import { fakeGuid, hashSeed, makeRng, type Rng } from "./rng";

export type Size = "small" | "100mb" | "1gb";

export interface SizeConfig {
  /** stop after this many messages (small) ... */
  messages?: number;
  /** ... or after the file reaches this many bytes */
  targetBytes?: number;
  people: number;
  groups: number;
  /** mean gap between conversation bursts (ms) */
  burstGapMs: number;
  startUnixMs: number;
}

export const SIZES: Record<Size, SizeConfig> = {
  small: { messages: 600, people: 8, groups: 2, burstGapMs: 20 * 3600e3, startUnixMs: Date.UTC(2024, 0, 1, 9) },
  "100mb": { targetBytes: 100 * 1024 * 1024, people: 60, groups: 12, burstGapMs: 30 * 60e3, startUnixMs: Date.UTC(2016, 0, 1, 9) },
  "1gb": { targetBytes: 1024 * 1024 * 1024, people: 300, groups: 60, burstGapMs: 20 * 60e3, startUnixMs: Date.UTC(2014, 0, 1, 9) },
};

export const APPLE_EPOCH_UNIX_MS = 978307200000;
/** unix ms -> Apple-epoch nanoseconds (macOS >= High Sierra stores this in message.date) */
export const toAppleNs = (unixMs: number): bigint => (BigInt(Math.round(unixMs)) - BigInt(APPLE_EPOCH_UNIX_MS)) * 1_000_000n;
export const fromAppleNs = (ns: bigint | number): number => Number(BigInt(ns) / 1_000_000n) + APPLE_EPOCH_UNIX_MS;

const SCHEMA = `
CREATE TABLE message (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT, replace INTEGER DEFAULT 0,
  service_center TEXT, handle_id INTEGER DEFAULT 0, subject TEXT, country TEXT, attributedBody BLOB,
  version INTEGER DEFAULT 0, type INTEGER DEFAULT 0, service TEXT, account TEXT, account_guid TEXT,
  error INTEGER DEFAULT 0, date INTEGER, date_read INTEGER, date_delivered INTEGER,
  is_delivered INTEGER DEFAULT 0, is_finished INTEGER DEFAULT 0, is_emote INTEGER DEFAULT 0,
  is_from_me INTEGER DEFAULT 0, is_empty INTEGER DEFAULT 0, is_delayed INTEGER DEFAULT 0,
  is_auto_reply INTEGER DEFAULT 0, is_prepared INTEGER DEFAULT 0, is_read INTEGER DEFAULT 0,
  is_system_message INTEGER DEFAULT 0, is_sent INTEGER DEFAULT 0, has_dd_results INTEGER DEFAULT 0,
  is_service_message INTEGER DEFAULT 0, is_forward INTEGER DEFAULT 0, was_downgraded INTEGER DEFAULT 0,
  is_archive INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0, cache_roomnames TEXT,
  was_data_detected INTEGER DEFAULT 0, was_deduplicated INTEGER DEFAULT 0, is_audio_message INTEGER DEFAULT 0,
  is_played INTEGER DEFAULT 0, date_played INTEGER, item_type INTEGER DEFAULT 0, other_handle INTEGER DEFAULT 0,
  group_title TEXT, group_action_type INTEGER DEFAULT 0, share_status INTEGER DEFAULT 0,
  share_direction INTEGER DEFAULT 0, is_expirable INTEGER DEFAULT 0, expire_state INTEGER DEFAULT 0,
  message_action_type INTEGER DEFAULT 0, message_source INTEGER DEFAULT 0, associated_message_guid TEXT,
  associated_message_type INTEGER DEFAULT 0, balloon_bundle_id TEXT, payload_data BLOB,
  expressive_send_style_id TEXT, associated_message_range_location INTEGER DEFAULT 0,
  associated_message_range_length INTEGER DEFAULT 0, time_expressive_send_played INTEGER,
  message_summary_info BLOB, ck_sync_state INTEGER DEFAULT 0, ck_record_id TEXT, ck_record_change_tag TEXT,
  destination_caller_id TEXT, is_corrupt INTEGER DEFAULT 0, reply_to_guid TEXT, sort_id INTEGER,
  is_spam INTEGER DEFAULT 0, has_unseen_mention INTEGER DEFAULT 0, thread_originator_guid TEXT,
  thread_originator_part TEXT, syndication_ranges TEXT, was_delivered_quietly INTEGER DEFAULT 0,
  did_notify_recipient INTEGER DEFAULT 0, date_retracted INTEGER, date_edited INTEGER,
  was_detonated INTEGER DEFAULT 0, part_count INTEGER
);
CREATE TABLE handle (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, country TEXT, service TEXT NOT NULL,
  uncanonicalized_id TEXT, person_centric_id TEXT, UNIQUE (id, service)
);
CREATE TABLE chat (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER, state INTEGER,
  account_id TEXT, properties BLOB, chat_identifier TEXT, service_name TEXT, room_name TEXT,
  account_login TEXT, is_archived INTEGER DEFAULT 0, last_addressed_handle TEXT, display_name TEXT,
  group_id TEXT, is_filtered INTEGER DEFAULT 0, successful_query INTEGER DEFAULT 1, engram_id TEXT,
  server_change_token TEXT, ck_sync_state INTEGER DEFAULT 0, original_group_id TEXT,
  last_read_message_timestamp INTEGER DEFAULT 0, cloudkit_record_id TEXT, last_addressed_sim_id TEXT,
  is_blackholed INTEGER DEFAULT 0, syndication_date INTEGER DEFAULT 0, syndication_type INTEGER DEFAULT 0,
  is_recovered INTEGER DEFAULT 0, is_deleted INTEGER DEFAULT 0
);
CREATE TABLE chat_handle_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE,
  handle_id INTEGER REFERENCES handle (ROWID) ON DELETE CASCADE, UNIQUE (chat_id, handle_id));
CREATE TABLE chat_message_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE,
  message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, message_date INTEGER DEFAULT 0,
  PRIMARY KEY (chat_id, message_id));
CREATE TABLE attachment (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, created_date INTEGER DEFAULT 0,
  start_date INTEGER DEFAULT 0, filename TEXT, uti TEXT, mime_type TEXT, transfer_state INTEGER DEFAULT 0,
  is_outgoing INTEGER DEFAULT 0, user_info BLOB, transfer_name TEXT, total_bytes INTEGER DEFAULT 0,
  is_sticker INTEGER DEFAULT 0, sticker_user_info BLOB, attribution_info BLOB, hide_attachment INTEGER DEFAULT 0,
  ck_sync_state INTEGER DEFAULT 0
);
CREATE TABLE message_attachment_join (message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE,
  attachment_id INTEGER REFERENCES attachment (ROWID) ON DELETE CASCADE, UNIQUE (message_id, attachment_id));
CREATE INDEX message_idx_date ON message (date);
CREATE INDEX message_idx_handle ON message (handle_id, date);
CREATE INDEX message_idx_associated_message ON message (associated_message_guid);
CREATE INDEX chat_message_join_idx_message_id ON chat_message_join (message_id, chat_id);
CREATE INDEX chat_handle_join_idx_handle_id ON chat_handle_join (handle_id);
CREATE INDEX message_attachment_join_idx_attachment_id ON message_attachment_join (attachment_id);
`;

const WORDS = (
  "the a to and of I you it that is for was on with he she we they have just not but what so this can " +
  "going tonight tomorrow dinner lunch work meeting running late sorry thanks thank okay sure maybe yes no " +
  "haha lol really wow great awesome love miss see soon call text later home weekend game movie food " +
  "coffee pizza traffic train flight weather birthday party plan idea tickets photo song show watch " +
  "wanna come over free busy tired hungry morning night today yesterday week friend mom dad dog cat"
).split(" ");
const EMOJI = ["😂", "❤️", "👍", "🔥", "😭", "🙏", "🎉", "😊", "🤔", "😅"];
const TAPBACK_NAMES = ["Loved", "Liked", "Disliked", "Laughed at", "Emphasized", "Questioned"];

/** Minimal NSKeyedArchiver-less "typedstream" NSAttributedString blob, as found in message.attributedBody. */
export function makeAttributedBody(text: string): Buffer {
  const t = Buffer.from(text, "utf8");
  const len = t.length < 0x80 ? Buffer.from([t.length]) : Buffer.from([0x81, t.length & 0xff, (t.length >> 8) & 0xff]);
  const head = Buffer.from(
    "040b73747265616d747970656481e803840140848484124e5341747472696275746564537472696e6700848484084e534f626a656374008592848484084e53537472696e67019484012b",
    "hex",
  );
  const tail = Buffer.from(
    "86840269490101" + "92848484" + "0c4e5344696374696f6e617279009484" + "0169" + "0192849696" + "1d5f5f6b494d4d657373616765506172744174747269627574654e616d658686" + "86",
    "hex",
  );
  return Buffer.concat([head, len, t, tail]);
}

/** Inverse of makeAttributedBody (also handles real-world blobs in the common single-NSString case). */
export function decodeAttributedBody(blob: Uint8Array): string | null {
  const b = Buffer.from(blob);
  const marker = Buffer.from("NSString");
  const i = b.indexOf(marker);
  if (i < 0) return null;
  let p = b.indexOf(0x2b, i + marker.length); // '+' starts the string payload
  if (p < 0) return null;
  p++;
  let len = b[p++];
  if (len === 0x81) {
    len = b[p] | (b[p + 1] << 8);
    p += 2;
  } else if (len === 0x82) {
    len = b.readUInt32LE(p);
    p += 4;
  }
  return b.subarray(p, p + len).toString("utf8");
}

function sentence(rng: Rng): string {
  const n = rng.int(2, 14);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(rng.pick(WORDS));
  let s = parts.join(" ");
  s = s[0].toUpperCase() + s.slice(1);
  if (rng.chance(0.15)) s += "?";
  else if (rng.chance(0.2)) s += "!";
  if (rng.chance(0.12)) s += " " + rng.pick(EMOJI);
  if (rng.chance(0.03)) s += ` https://example.com/${rng.hex(6)}`;
  return s;
}

interface ChatState {
  rowid: number;
  guid: string;
  isGroup: boolean;
  displayName: string | null;
  members: number[]; // handle ROWIDs currently in chat
  weight: number;
  recent: { guid: string; text: string | null; fromMe: boolean }[];
}

interface State {
  chats: ChatState[];
  handles: Map<number, string>; // ROWID -> id
  handleByRowid: number[];
  nextRowid: number;
  nextAttachment: number;
  clockMs: number;
  ordinal: number;
}

function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA cache_size = -65536;");
  return db;
}

function initFresh(db: DatabaseSync, cfg: SizeConfig, rng: Rng): void {
  db.exec(SCHEMA);
  const cast = makeCast(cfg.people);
  const insHandle = db.prepare(
    "INSERT INTO handle (id, country, service, uncanonicalized_id) VALUES (?, ?, 'iMessage', ?)",
  );
  const insChat = db.prepare(
    `INSERT INTO chat (guid, style, state, chat_identifier, service_name, display_name, group_id, room_name)
     VALUES (?, ?, 3, ?, 'iMessage', ?, ?, ?)`,
  );
  const insJoin = db.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)");
  db.exec("BEGIN");
  const handleRow = new Map<string, number>();
  cast.forEach((p: Person, i) => {
    const r = insHandle.run(p.handle, p.handle.startsWith("+44") ? "gb" : p.handle.includes("@") ? null : "us", p.handle);
    handleRow.set(p.handle, Number(r.lastInsertRowid));
    void i;
  });
  const oneToOne = cfg.messages ? Math.min(5, cast.length) : cast.length;
  for (let i = 0; i < oneToOne; i++) {
    const r = insChat.run(`iMessage;-;${cast[i].handle}`, 45, cast[i].handle, null, null, null);
    insJoin.run(Number(r.lastInsertRowid), handleRow.get(cast[i].handle)!);
  }
  const named = [
    ["Weekend Crew", [0, 1, 2]],
    [null, [3, 4, 6]],
  ] as const;
  for (let g = 0; g < cfg.groups; g++) {
    let name: string | null;
    let idx: number[];
    if (g < named.length && cfg.messages) {
      name = named[g][0];
      idx = [...named[g][1]];
    } else {
      const k = rng.int(3, Math.min(8, cast.length));
      const set = new Set<number>();
      while (set.size < k) set.add(rng.int(0, cast.length - 1));
      idx = [...set];
      name = rng.chance(0.7) ? `Group ${g} ${rng.pick(WORDS)}` : null;
    }
    const roomName = `chat${String(100000000000000 + g * 7919).padStart(18, "0")}`;
    const r = insChat.run(`iMessage;+;${roomName}`, 43, roomName, name, rng.hex(32).toUpperCase(), roomName);
    for (const i of idx) insJoin.run(Number(r.lastInsertRowid), handleRow.get(cast[i].handle)!);
  }
  db.exec("COMMIT");
}

function loadState(db: DatabaseSync, cfg: SizeConfig): State {
  const handles = new Map<number, string>();
  for (const r of db.prepare("SELECT ROWID AS r, id FROM handle").all() as { r: number; id: string }[]) handles.set(r.r, r.id);
  const chats: ChatState[] = [];
  const members = db.prepare("SELECT handle_id FROM chat_handle_join WHERE chat_id = ? ORDER BY handle_id");
  const recent = db.prepare(
    `SELECT m.guid, m.text, m.is_from_me FROM chat_message_join j JOIN message m ON m.ROWID = j.message_id
     WHERE j.chat_id = ? AND m.item_type = 0 AND m.associated_message_type = 0 ORDER BY j.message_id DESC LIMIT 20`,
  );
  const rows = db.prepare("SELECT ROWID AS r, guid, style, display_name FROM chat ORDER BY ROWID").all() as {
    r: number;
    guid: string;
    style: number;
    display_name: string | null;
  }[];
  rows.forEach((c, i) => {
    const rec = (recent.all(c.r) as { guid: string; text: string | null; is_from_me: number }[]).reverse();
    chats.push({
      rowid: c.r,
      guid: c.guid,
      isGroup: c.style === 43,
      displayName: c.display_name,
      members: (members.all(c.r) as { handle_id: number }[]).map((m) => m.handle_id),
      // Zipf-ish skew: a few busy chats, a long tail. Small fixture keeps the last 1:1 (a business) quiet.
      weight: 1 / (1 + (i % 17)) + (c.style === 43 ? 0.2 : 0) + (cfg.messages && i === 4 ? -0.15 : 0),
      recent: rec.map((x) => ({ guid: x.guid, text: x.text, fromMe: !!x.is_from_me })),
    });
  });
  const mx = db.prepare("SELECT MAX(ROWID) AS m, MAX(date) AS d FROM message");
  mx.setReadBigInts(true);
  const m = mx.get() as { m: bigint | null; d: bigint | null };
  const att = db.prepare("SELECT MAX(ROWID) AS m FROM attachment").get() as { m: number | null };
  return {
    chats,
    handles,
    handleByRowid: [],
    nextRowid: Number(m.m ?? 0n) + 1,
    nextAttachment: (att.m ?? 0) + 1,
    clockMs: m.d ? fromAppleNs(m.d) + 3600e3 : cfg.startUnixMs,
    ordinal: Number(m.m ?? 0n),
  };
}

interface Stmts {
  msg: StatementSync;
  join: StatementSync;
  att: StatementSync;
  attJoin: StatementSync;
  addMember: StatementSync;
  delMember: StatementSync;
  rename: StatementSync;
}

function prepare(db: DatabaseSync): Stmts {
  return {
    msg: db.prepare(
      `INSERT INTO message (guid, text, handle_id, attributedBody, service, date, date_read, date_delivered, is_delivered,
         is_finished, is_from_me, is_read, is_sent, item_type, other_handle, group_title, group_action_type,
         cache_has_attachments, cache_roomnames, associated_message_guid, associated_message_type, associated_message_range_length,
         message_summary_info, reply_to_guid, thread_originator_guid, date_retracted, date_edited, part_count, account)
       VALUES (?, ?, ?, ?, 'iMessage', ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'p:0/synthetic')`,
    ),
    join: db.prepare("INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)"),
    att: db.prepare(
      `INSERT INTO attachment (guid, created_date, filename, uti, mime_type, transfer_state, is_outgoing, transfer_name, total_bytes, is_sticker)
       VALUES (?, ?, ?, 'public.jpeg', 'image/jpeg', 5, ?, ?, ?, ?)`,
    ),
    attJoin: db.prepare("INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?, ?)"),
    addMember: db.prepare("INSERT OR IGNORE INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)"),
    delMember: db.prepare("DELETE FROM chat_handle_join WHERE chat_id = ? AND handle_id = ?"),
    rename: db.prepare("UPDATE chat SET display_name = ? WHERE ROWID = ?"),
  };
}

interface Row {
  guid: string;
  text: string | null;
  handleId: number;
  body: Buffer | null;
  date: number;
  fromMe: boolean;
  itemType?: number;
  otherHandle?: number;
  groupTitle?: string | null;
  groupAction?: number;
  hasAtt?: boolean;
  roomName?: string | null;
  assocGuid?: string | null;
  assocType?: number;
  replyTo?: string | null;
  summary?: Buffer | null;
  retracted?: number | null;
  edited?: number | null;
}

function insertRow(db: DatabaseSync, st: Stmts, s: State, chat: ChatState, r: Row): number {
  const rowid = s.nextRowid++;
  const ns = toAppleNs(r.date);
  st.msg.run(
    r.guid, r.text, r.handleId, r.body, ns, r.fromMe ? 0n : ns + 2_000_000_000n, ns + 500_000_000n,
    r.fromMe ? 1 : 0, r.fromMe ? 1 : 0, r.fromMe ? 1 : 0,
    r.itemType ?? 0, r.otherHandle ?? 0, r.groupTitle ?? null, r.groupAction ?? 0,
    r.hasAtt ? 1 : 0, chat.isGroup ? chat.guid.split(";").pop()! : null,
    r.assocGuid ?? null, r.assocType ?? 0, r.assocGuid ? (r.text?.length ?? 0) : 0,
    r.summary ?? null, r.replyTo ?? null, r.replyTo ?? null,
    r.retracted != null ? toAppleNs(r.retracted) : null, r.edited != null ? toAppleNs(r.edited) : null,
    r.text || r.body ? 1 : 0,
  );
  st.join.run(chat.rowid, rowid, ns);
  return rowid;
}

export interface EmitOptions {
  /** number of message rows to add (append mode, or explicit counts) */
  count?: number;
  targetBytes?: number;
  /** batch transaction size */
  batch?: number;
  scripted?: boolean;
  onProgress?: (done: number, bytes: number) => void;
}

function emit(db: DatabaseSync, cfg: SizeConfig, rng: Rng, s: State, path: string, opts: EmitOptions): number {
  const st = prepare(db);
  const batchSize = opts.batch ?? 5000;
  let produced = 0;
  const bytes = () => {
    const pc = db.prepare("PRAGMA page_count").get() as { page_count: number };
    const ps = db.prepare("PRAGMA page_size").get() as { page_size: number };
    return pc.page_count * ps.page_size;
  };
  const weights = s.chats.map((c) => Math.max(0.02, c.weight));
  const scriptedEvents = opts.scripted ? [120, 220, 320, 420] : [];
  let scriptedIdx = 0;
  const done = () =>
    opts.count != null ? produced >= opts.count : opts.targetBytes != null ? false : true;
  let inTx = false;
  let lastCheck = 0;
  void path;

  const myHandleFor = (chat: ChatState): number => (chat.isGroup ? 0 : chat.members[0] ?? 0);
  const senderFor = (chat: ChatState, lastFromMe: boolean | null): { fromMe: boolean; handle: number } => {
    const stay = lastFromMe !== null && rng.chance(0.3);
    const fromMe = stay ? lastFromMe! : lastFromMe === null ? rng.chance(0.5) : !lastFromMe || (chat.isGroup && rng.chance(0.3));
    if (fromMe) return { fromMe: true, handle: myHandleFor(chat) };
    return { fromMe: false, handle: chat.members.length ? rng.pick(chat.members) : 0 };
  };

  while (!done()) {
    if (!inTx) {
      db.exec("BEGIN");
      inTx = true;
    }
    // --- one burst in one chat ---
    let chatIdx = rng.weighted(weights);
    const forced = scriptedEvents[scriptedIdx] !== undefined && s.ordinal >= scriptedEvents[scriptedIdx];
    if (forced) chatIdx = s.chats.findIndex((c) => c.isGroup && c.displayName?.startsWith("Weekend Crew"));
    const chat = s.chats[Math.max(0, chatIdx)];

    let gap = -Math.log(1 - rng.next()) * cfg.burstGapMs;
    s.clockMs += Math.max(5000, gap);
    const hour = Math.floor(s.clockMs / 3600e3) % 24;
    if (hour < 7 && rng.chance(0.85)) s.clockMs += (7 - hour) * 3600e3;

    const len = rng.int(1, 11);
    let last: boolean | null = null;
    for (let k = 0; k < len && !done(); k++) {
      s.clockMs += Math.floor(-Math.log(1 - rng.next()) * 40000) + 800;
      const guid = fakeGuid(rng);
      const roll = rng.next();
      const snd = senderFor(chat, last);
      last = snd.fromMe;

      if (forced && k === 0) {
        // scripted membership events on the named group
        const ev = scriptedIdx++;
        const cast = [...s.handles.entries()];
        const alice = cast.find(([, id]) => id === "+15551110001")![0];
        const bob = cast.find(([, id]) => id === "+15551110002")![0];
        const carol = cast.find(([, id]) => id === "carol@example.com")![0];
        const erin = cast.find(([, id]) => id === "+15551110005")![0];
        if (ev === 0) {
          st.addMember.run(chat.rowid, erin);
          chat.members.push(erin);
          insertRow(db, st, s, chat, { guid, text: null, body: null, handleId: 0, date: s.clockMs, fromMe: true, itemType: 1, otherHandle: erin, groupAction: 0 });
        } else if (ev === 1) {
          st.delMember.run(chat.rowid, bob);
          chat.members = chat.members.filter((m) => m !== bob);
          insertRow(db, st, s, chat, { guid, text: null, body: null, handleId: 0, date: s.clockMs, fromMe: true, itemType: 1, otherHandle: bob, groupAction: 1 });
        } else if (ev === 2) {
          st.delMember.run(chat.rowid, carol);
          chat.members = chat.members.filter((m) => m !== carol);
          insertRow(db, st, s, chat, { guid, text: null, body: null, handleId: carol, date: s.clockMs, fromMe: false, itemType: 3, groupAction: 0 });
        } else {
          st.rename.run("Weekend Crew 2", chat.rowid);
          chat.displayName = "Weekend Crew 2";
          insertRow(db, st, s, chat, { guid, text: null, body: null, handleId: alice, date: s.clockMs, fromMe: false, itemType: 2, groupTitle: "Weekend Crew 2" });
        }
        produced++;
        s.ordinal++;
        continue;
      }

      let row: Row;
      if (chat.isGroup && roll < 0.012 && !opts.scripted) {
        // random membership churn in generated groups
        const all = [...s.handles.keys()];
        const target = rng.pick(all);
        const removing = chat.members.includes(target) && chat.members.length > 3;
        if (removing) {
          st.delMember.run(chat.rowid, target);
          chat.members = chat.members.filter((m) => m !== target);
        } else if (!chat.members.includes(target)) {
          st.addMember.run(chat.rowid, target);
          chat.members.push(target);
        }
        row = { guid, text: null, body: null, handleId: 0, date: s.clockMs, fromMe: true, itemType: 1, otherHandle: target, groupAction: removing ? 1 : 0 };
      } else if (roll < 0.07 && chat.recent.length) {
        // tapback
        const target = rng.pick(chat.recent);
        const kind = rng.int(0, 5);
        const removal = rng.chance(0.12);
        const t = target.text ?? "an attachment";
        row = {
          guid, handleId: snd.handle, fromMe: snd.fromMe, date: s.clockMs, body: null,
          text: `${removal ? "Removed a " + TAPBACK_NAMES[kind].toLowerCase() + " from" : TAPBACK_NAMES[kind]} “${t.slice(0, 40)}”`,
          assocGuid: `p:0/${target.guid}`, assocType: (removal ? 3000 : 2000) + kind,
        };
      } else if (roll < 0.11) {
        // attachment
        const attGuid = fakeGuid(rng);
        const aid = s.nextAttachment++;
        const ns = toAppleNs(s.clockMs);
        st.att.run(attGuid, ns, `~/Library/Messages/Attachments/${attGuid.slice(0, 2)}/IMG_${rng.int(1000, 9999)}.jpeg`, snd.fromMe ? 1 : 0, `IMG_${aid}.jpeg`, rng.int(20000, 4000000), 0);
        row = { guid, text: "￼", body: null, handleId: snd.handle, fromMe: snd.fromMe, date: s.clockMs, hasAtt: true };
        const rowid = insertRow(db, st, s, chat, row);
        st.attJoin.run(rowid, aid);
        produced++; s.ordinal++;
        chat.recent.push({ guid, text: null, fromMe: snd.fromMe });
        if (chat.recent.length > 20) chat.recent.shift();
        continue;
      } else {
        const text = sentence(rng);
        const form = rng.next();
        const base: Row = { guid, text, body: null, handleId: snd.handle, fromMe: snd.fromMe, date: s.clockMs };
        if (form < 0.35) { base.text = null; base.body = makeAttributedBody(text); }
        else if (form < 0.6) base.body = makeAttributedBody(text);
        const extra = rng.next();
        if (extra < 0.06 && chat.recent.length) base.replyTo = rng.pick(chat.recent).guid;
        else if (extra < 0.075) {
          // edited message: current text replaced, date_edited after date
          const edited = sentence(rng);
          base.text = edited; base.body = makeAttributedBody(edited);
          base.edited = s.clockMs + 45_000;
          base.summary = Buffer.from("bplist00-synthetic-edit-history");
        } else if (extra < 0.082 && snd.fromMe) {
          // unsent message: text/body wiped, date_retracted set
          base.text = null; base.body = null; base.retracted = s.clockMs + 20_000;
          base.summary = Buffer.from("bplist00-synthetic-unsent");
        }
        row = base;
      }
      insertRow(db, st, s, chat, row);
      produced++;
      s.ordinal++;
      if (row.itemType === undefined && !row.assocGuid) {
        chat.recent.push({ guid, text: row.text ?? (row.body ? decodeAttributedBody(row.body) : null), fromMe: row.fromMe });
        if (chat.recent.length > 20) chat.recent.shift();
      }
    }

    if (produced - lastCheck >= batchSize) {
      lastCheck = produced;
      db.exec("COMMIT");
      inTx = false;
      const b = bytes();
      opts.onProgress?.(produced, b);
      if (opts.targetBytes != null && b >= opts.targetBytes) break;
    }
  }
  if (inTx) db.exec("COMMIT");
  return produced;
}

export interface GenerateOptions {
  out: string;
  size?: Size;
  seed?: number;
  onProgress?: (done: number, bytes: number) => void;
}

/** Create a brand-new synthetic chat.db at `out` (overwriting). Returns rows generated. */
export function generateChatDb(o: GenerateOptions): { messages: number; bytes: number } {
  const size = o.size ?? "small";
  const cfg = SIZES[size];
  const seed = o.seed ?? 42;
  for (const suf of ["", "-wal", "-shm", "-journal"]) if (existsSync(o.out + suf)) rmSync(o.out + suf);
  const rng = makeRng(hashSeed("gen", size, seed));
  const db = openDb(o.out);
  try {
    initFresh(db, cfg, rng);
    const s = loadState(db, cfg);
    const messages = emit(db, cfg, rng, s, o.out, {
      count: cfg.messages,
      targetBytes: cfg.targetBytes,
      scripted: size === "small",
      onProgress: o.onProgress,
    });
    return { messages, bytes: statSync(o.out).size };
  } finally {
    db.close();
  }
}

export interface AppendOptions {
  db: string;
  count: number;
  seed?: number;
  /** also edit/unsend this many existing (older) messages to exercise date_edited / date_retracted diffing */
  mutateExisting?: number;
  size?: Size;
}

/** Append `count` new messages (higher ROWIDs, later dates) and mutate a few old ones. Deterministic. */
export function appendMessages(o: AppendOptions): { added: number; edited: number; retracted: number } {
  const cfg = SIZES[o.size ?? "small"];
  const db = openDb(o.db);
  try {
    const s = loadState(db, cfg);
    const rng = makeRng(hashSeed("append", o.seed ?? 42, s.nextRowid));
    let edited = 0;
    let retracted = 0;
    const mutate = o.mutateExisting ?? 2;
    if (mutate > 0 && s.nextRowid > 50) {
      db.exec("BEGIN");
      const pick = db.prepare(
        "SELECT ROWID AS r, date FROM message WHERE item_type = 0 AND associated_message_type = 0 AND text IS NOT NULL AND date_edited IS NULL AND date_retracted IS NULL AND ROWID >= ? ORDER BY ROWID LIMIT 1",
      );
      pick.setReadBigInts(true);
      for (let i = 0; i < mutate; i++) {
        const row = pick.get(rng.int(1, s.nextRowid - 20)) as { r: bigint; date: bigint } | undefined;
        if (!row) continue;
        const when = toAppleNs(s.clockMs + 1000);
        if (i % 2 === 0) {
          const t = sentence(rng) + " (edited)";
          db.prepare("UPDATE message SET text = ?, attributedBody = ?, date_edited = ? WHERE ROWID = ?").run(t, makeAttributedBody(t), when, row.r);
          edited++;
        } else {
          db.prepare("UPDATE message SET text = NULL, attributedBody = NULL, date_retracted = ? WHERE ROWID = ?").run(when, row.r);
          retracted++;
        }
      }
      db.exec("COMMIT");
    }
    const added = emit(db, cfg, rng, s, o.db, { count: o.count });
    return { added, edited, retracted };
  } finally {
    db.close();
  }
}
