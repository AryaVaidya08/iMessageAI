#!/usr/bin/env python3
"""One-off: regenerate tests/golden/*.json from the LEGACY Python backend.

    python3 scripts/make-goldens.py [--chatdb tests/.cache/chat-small.db] [--addressbook tests/.cache/addressbook]

Run it with the analytics/backend venv (needs fastapi, httpx, emoji, vaderSentiment):
    ../backend/.venv/bin/python scripts/make-goldens.py

Steps
 1. Convert the synthetic chat.db into the legacy imessages.db shape (backend/storage/schema.py). The real legacy
    pipeline needs imessage-exporter HTML, so we map chat.db -> legacy tables directly (see convert()).
 2. Point the legacy ContactResolver at the fixture AddressBook, boot the FastAPI app via TestClient.
 3. Execute every case in tests/golden/cases.json and write tests/golden/<case>.json
    ({case, status, body}) plus tests/golden/_idmap.json.

ID mapping (legacy -> new engine). Legacy ids are random uuids / path hashes; we use deterministic uuid5s so goldens
are stable, and record the mapping in _idmap.json. New engine ids are:
    conversation id = chat.guid, participant id = normalized handle (or "me"), message id = message.guid
The parity spec tokenizes BOTH sides to the same neutral tokens (conv:<chat guid>, person:<handle>, msg:<guid>).

Known conversion choices (documented divergences, see tests/parity.spec.ts KNOWN_DIVERGENCES):
 * retracted (unsent) messages are dropped; edited messages use their current text
 * tapback-removals (3000+) are dropped; adds (2000-2005) become tapbacks rows
 * item_type 1/3 -> announcements 'added person'/'removed person'/'left convo'; item_type 2 -> 'renamed convo'
 * timestamps are UTC, ms precision, no tz suffix (the spec canonicalizes both sides)
 * conversation_participants = me + current members + anyone who ever sent/was affected in the chat
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote, unquote

HERE = Path(__file__).resolve().parent
FRONTEND = HERE.parent
REPO = FRONTEND.parent.parent
GOLDEN = FRONTEND / "tests" / "golden"
NS = uuid.UUID("12345678-1234-5678-1234-567812345678")
APPLE_EPOCH = datetime(2001, 1, 1, tzinfo=timezone.utc)
TAPBACKS = {0: "Loved", 1: "Liked", 2: "Disliked", 3: "Laughed", 4: "Emphasized", 5: "Questioned"}


def uid(kind: str, key: str) -> str:
    return str(uuid.uuid5(NS, f"{kind}:{key}"))


def iso(apple_ns: int) -> str:
    dt = APPLE_EPOCH + timedelta(microseconds=apple_ns // 1000)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}"


def decode_attributed_body(blob: bytes | None) -> str | None:
    if not blob:
        return None
    i = blob.find(b"NSString")
    if i < 0:
        return None
    p = blob.find(b"+", i + 8)
    if p < 0:
        return None
    p += 1
    n = blob[p]
    p += 1
    if n == 0x81:
        n = blob[p] | (blob[p + 1] << 8)
        p += 2
    elif n == 0x82:
        n = int.from_bytes(blob[p : p + 4], "little")
        p += 4
    return blob[p : p + n].decode("utf-8", "replace")


def convert(chatdb: Path, out: Path) -> dict:
    sys.path.insert(0, str(REPO))
    from backend.storage.schema import init_db  # legacy schema, source of truth

    src = sqlite3.connect(f"file:{chatdb}?mode=ro", uri=True)
    src.row_factory = sqlite3.Row
    dst = sqlite3.connect(out)
    init_db(dst)

    handles = {r["ROWID"]: r["id"] for r in src.execute("SELECT ROWID, id FROM handle")}
    idmap = {"conv": {}, "person": {}, "msg": {}}

    def pid(handle: str) -> str:
        p = uid("person", handle)
        idmap["person"][p] = handle
        return p

    me = pid("me")
    dst.execute("INSERT INTO participants VALUES (?, NULL, NULL, 1)", (me,))
    # participants.phone_num/email hold the raw handle; the legacy resolver normalizes on read.
    for h in handles.values():
        dst.execute(
            "INSERT INTO participants VALUES (?, ?, ?, 0)",
            (pid(h), None if "@" in h else h, h if "@" in h else None),
        )

    for chat in src.execute("SELECT ROWID, guid, style, display_name FROM chat ORDER BY ROWID").fetchall():
        cid = uid("conv", chat["guid"])
        idmap["conv"][cid] = chat["guid"]
        is_group = chat["style"] == 43
        dst.execute(
            "INSERT INTO conversations (id, is_group_chat, relationship_type, convo_name) VALUES (?, ?, 'other', ?)",
            (cid, int(is_group), chat["display_name"]),
        )
        members = {me}
        members |= {pid(handles[r[0]]) for r in src.execute("SELECT handle_id FROM chat_handle_join WHERE chat_id=?", (chat["ROWID"],))}
        rows = src.execute(
            """SELECT m.* FROM chat_message_join j JOIN message m ON m.ROWID=j.message_id
               WHERE j.chat_id=? ORDER BY m.ROWID""",
            (chat["ROWID"],),
        ).fetchall()
        for m in rows:
            sender = me if m["is_from_me"] else (pid(handles[m["handle_id"]]) if m["handle_id"] in handles else me)
            members.add(sender)
            ts = iso(m["date"])
            if m["item_type"] != 0:
                if m["item_type"] == 1:
                    action = "added person" if m["group_action_type"] == 0 else "removed person"
                    affected = pid(handles[m["other_handle"]]) if m["other_handle"] in handles else None
                elif m["item_type"] == 3:
                    action, affected = "left convo", sender
                else:
                    action, affected = "renamed convo", None
                if affected:
                    members.add(affected)
                dst.execute(
                    "INSERT INTO announcements VALUES (?, ?, ?, ?, ?, ?)",
                    (uid("ann", m["guid"]), cid, ts, sender, action, affected),
                )
                continue
            if m["associated_message_type"] and m["associated_message_type"] >= 2000:
                if m["associated_message_type"] >= 3000:
                    continue
                target = m["associated_message_guid"].split("/", 1)[-1]
                dst.execute(
                    "INSERT OR IGNORE INTO tapbacks (message_id, reactor_id, action) VALUES (?, ?, ?)",
                    (uid("msg", target), sender, TAPBACKS[m["associated_message_type"] - 2000]),
                )
                continue
            if m["date_retracted"] is not None:
                continue
            text = m["text"] if m["text"] is not None else decode_attributed_body(m["attributedBody"])
            if text is None:
                continue
            has_att = int(bool(m["cache_has_attachments"]))
            text = text.replace("￼", "")
            mid = uid("msg", m["guid"])
            idmap["msg"][mid] = m["guid"]
            reply = uid("msg", m["reply_to_guid"]) if m["reply_to_guid"] else None
            dst.execute(
                "INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
                (mid, cid, sender, ts, text, has_att, reply),
            )
        for p in sorted(members):
            dst.execute("INSERT OR IGNORE INTO conversation_participants VALUES (?, ?)", (cid, p))
    # tapbacks whose target message was dropped would violate nothing (FKs off) but would be orphans: remove
    dst.execute("DELETE FROM tapbacks WHERE message_id NOT IN (SELECT id FROM messages)")
    dst.commit()
    dst.close()
    return idmap


def resolve_placeholders(s: str, chatdb: Path, legacy: bool, idmap_rev: dict) -> str:
    """Case paths hold {conv:#6}, {conv:iMessage;-;+1555...}, {person:+1555...}, {person:me}, {msg:rowid:200}."""
    src = sqlite3.connect(f"file:{chatdb}?mode=ro", uri=True)

    def sub(m: re.Match) -> str:
        kind, key = m.group(1), m.group(2)
        if kind == "conv":
            guid = src.execute("SELECT guid FROM chat WHERE ROWID=?", (int(key[1:]),)).fetchone()[0] if key.startswith("#") else key
            return quote(uid("conv", guid) if legacy else guid, safe="")
        if kind == "person":
            return quote(uid("person", key) if legacy else key, safe="")
        if kind == "msg":
            guid = src.execute("SELECT guid FROM message WHERE ROWID=?", (int(key.split(":")[1]),)).fetchone()[0]
            return quote(uid("msg", guid) if legacy else guid, safe="")
        raise ValueError(kind)

    return re.sub(r"\{(conv|person|msg):([^}]+)\}", sub, s)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--chatdb", default=str(FRONTEND / "tests/.cache/chat-small.db"))
    ap.add_argument("--addressbook", default=str(FRONTEND / "tests/.cache/addressbook"))
    args = ap.parse_args()
    chatdb, ab = Path(args.chatdb), Path(args.addressbook)
    if not chatdb.exists() or not ab.exists():
        sys.exit("fixtures missing: run `npm run make-fixtures` first")

    tmp = Path(tempfile.mkdtemp(prefix="goldens-"))
    legacy_db = tmp / "imessages.db"
    idmap = convert(chatdb, legacy_db)
    os.environ["IMESSAGE_DB_PATH"] = str(legacy_db)

    sys.path.insert(0, str(REPO / "analytics" / "backend"))
    import contacts  # noqa: E402

    # Fixture AddressBook: legacy layout = Sources/*/AddressBook-v22.abcddb + a single legacy file.
    contacts.ADDRESSBOOK_SOURCES_DIR = ab / "Sources"
    contacts.ADDRESSBOOK_LEGACY_PATH = ab / "AddressBook-v22.abcddb"

    from fastapi.testclient import TestClient  # noqa: E402
    from main import app  # noqa: E402

    cases = json.loads((GOLDEN / "cases.json").read_text())["cases"]
    GOLDEN.mkdir(parents=True, exist_ok=True)
    for old in GOLDEN.glob("*.json"):
        if old.name not in ("cases.json",):
            old.unlink()
    with TestClient(app) as client:
        for c in cases:
            path = resolve_placeholders(c["path"], chatdb, True, {})
            body = json.loads(resolve_placeholders(json.dumps(c["body"]), chatdb, True, {})) if c.get("body") else None
            # json.dumps escapes ';' etc. fine, but quote() output is URL-encoded; undo for JSON bodies
            if body:
                body = {k: unquote(v) for k, v in body.items()}
            r = client.request(c["method"], path, json=body)
            try:
                payload = r.json()
            except Exception:
                payload = r.text
            (GOLDEN / f"{c['name']}.json").write_text(
                json.dumps({"case": c, "status": r.status_code, "body": payload}, indent=1, sort_keys=True) + "\n"
            )
            print(f"{r.status_code} {c['method']} {path[:90]}")
    (GOLDEN / "_idmap.json").write_text(json.dumps(idmap, indent=1, sort_keys=True) + "\n")
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"wrote {len(cases)} goldens to {GOLDEN}")


if __name__ == "__main__":
    main()
