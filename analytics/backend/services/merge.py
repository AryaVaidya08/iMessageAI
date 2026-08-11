import shutil
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Iterator

from config import DB_PATH, MERGED_DB_PATH

# Lives inside the merged copy itself, so it's created once (on first merge)
# and persists across server restarts along with the rest of that file --
# this is also the only place the removed contact's raw handle survives,
# since its participants row is deleted once the merge completes.
MERGE_HISTORY_SCHEMA = """
CREATE TABLE IF NOT EXISTS merge_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    merged_at TEXT NOT NULL,
    keep_id TEXT NOT NULL,
    keep_display_name TEXT NOT NULL,
    keep_handle TEXT NOT NULL,
    remove_id TEXT NOT NULL,
    remove_display_name TEXT NOT NULL,
    remove_handle TEXT NOT NULL
);
"""


class MergeError(Exception):
    """Raised for merge requests that can't be satisfied (bad ids, merging 'You', etc.)."""


def ensure_merged_db() -> None:
    """Create the merged copy from the original DB on first use. Never touches DB_PATH."""
    if not MERGED_DB_PATH.exists():
        shutil.copy2(DB_PATH, MERGED_DB_PATH)


@contextmanager
def get_write_connection() -> Iterator[sqlite3.Connection]:
    ensure_merged_db()
    conn = sqlite3.connect(MERGED_DB_PATH)
    conn.execute("PRAGMA foreign_keys = OFF")  # we repoint ids manually, in a controlled order
    conn.row_factory = sqlite3.Row
    conn.executescript(MERGE_HISTORY_SCHEMA)
    try:
        yield conn
    finally:
        conn.close()


def list_participants(conn: sqlite3.Connection, resolver) -> list[dict]:
    from services.names import resolve_participant

    rows = conn.execute("SELECT id, phone_num, email, is_me FROM participants").fetchall()
    out = []
    for r in rows:
        resolved = resolve_participant(r["id"], r["phone_num"], r["email"], r["is_me"], resolver)
        out.append({
            "id": r["id"],
            "phone_num": r["phone_num"],
            "email": r["email"],
            "handle": resolved.handle,
            "display_name": resolved.display_name,
            "is_me": bool(r["is_me"]),
        })
    out.sort(key=lambda p: p["display_name"].lower())
    return out


def list_merge_history(conn: sqlite3.Connection) -> list[dict]:
    try:
        rows = conn.execute(
            "SELECT merged_at, keep_id, keep_display_name, keep_handle, "
            "remove_id, remove_display_name, remove_handle "
            "FROM merge_history ORDER BY merged_at DESC"
        ).fetchall()
    except sqlite3.OperationalError:
        return []  # no merge has happened yet in this db, so the table was never created
    return [dict(r) for r in rows]


def merge_participants(keep_id: str, remove_id: str, resolver) -> None:
    from services.names import resolve_participant

    if keep_id == remove_id:
        raise MergeError("Can't merge a contact into itself.")

    with get_write_connection() as conn:
        keep_row = conn.execute(
            "SELECT id, phone_num, email, is_me FROM participants WHERE id = ?", (keep_id,)
        ).fetchone()
        remove_row = conn.execute(
            "SELECT id, phone_num, email, is_me FROM participants WHERE id = ?", (remove_id,)
        ).fetchone()
        if keep_row is None or remove_row is None:
            raise MergeError("One or both contacts weren't found.")

        # Snapshot names/handles before mutating anything -- remove_row's participants
        # entry is about to be deleted, so this is the last chance to capture it.
        keep_resolved = resolve_participant(
            keep_row["id"], keep_row["phone_num"], keep_row["email"], keep_row["is_me"], resolver
        )
        remove_resolved = resolve_participant(
            remove_row["id"], remove_row["phone_num"], remove_row["email"], remove_row["is_me"], resolver
        )

        conn.execute("BEGIN")
        try:
            # conversation_participants has PK (conversation_id, participant_id):
            # if remove_id and keep_id are already both in the same conversation,
            # repointing would collide, so drop the redundant remove_id row instead.
            conn.execute(
                """
                DELETE FROM conversation_participants
                WHERE participant_id = ?
                  AND conversation_id IN (
                      SELECT conversation_id FROM conversation_participants WHERE participant_id = ?
                  )
                """,
                (remove_id, keep_id),
            )
            conn.execute(
                "UPDATE conversation_participants SET participant_id = ? WHERE participant_id = ?",
                (keep_id, remove_id),
            )

            conn.execute("UPDATE messages SET sender_id = ? WHERE sender_id = ?", (keep_id, remove_id))

            # tapbacks has UNIQUE(message_id, reactor_id, action): same dedupe as above.
            conn.execute(
                """
                DELETE FROM tapbacks
                WHERE reactor_id = ?
                  AND (message_id, action) IN (
                      SELECT message_id, action FROM tapbacks WHERE reactor_id = ?
                  )
                """,
                (remove_id, keep_id),
            )
            conn.execute("UPDATE tapbacks SET reactor_id = ? WHERE reactor_id = ?", (keep_id, remove_id))

            conn.execute("UPDATE announcements SET announcer_id = ? WHERE announcer_id = ?", (keep_id, remove_id))
            conn.execute("UPDATE announcements SET affected_id = ? WHERE affected_id = ?", (keep_id, remove_id))

            conn.execute("DELETE FROM participants WHERE id = ?", (remove_id,))

            conn.execute(
                "INSERT INTO merge_history "
                "(merged_at, keep_id, keep_display_name, keep_handle, remove_id, remove_display_name, remove_handle) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    datetime.now(timezone.utc).isoformat(),
                    keep_id,
                    keep_resolved.display_name,
                    keep_resolved.handle,
                    remove_id,
                    remove_resolved.display_name,
                    remove_resolved.handle,
                ),
            )

            conn.commit()
        except Exception:
            conn.rollback()
            raise
