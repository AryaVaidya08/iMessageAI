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

CONVERSATION_MERGE_HISTORY_SCHEMA = """
CREATE TABLE IF NOT EXISTS conversation_merge_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    merged_at TEXT NOT NULL,
    keep_id TEXT NOT NULL,
    keep_display_name TEXT NOT NULL,
    remove_id TEXT NOT NULL,
    remove_display_name TEXT NOT NULL
);
"""

# Older merged copies were created before message counts were tracked, so the
# CREATE TABLE above won't add the columns to them -- patch those in-place.
_MERGE_HISTORY_MIGRATIONS = [
    "ALTER TABLE merge_history ADD COLUMN keep_message_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE merge_history ADD COLUMN remove_message_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE conversation_merge_history ADD COLUMN keep_message_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE conversation_merge_history ADD COLUMN remove_message_count INTEGER NOT NULL DEFAULT 0",
]


def _apply_merge_history_migrations(conn: sqlite3.Connection) -> None:
    for statement in _MERGE_HISTORY_MIGRATIONS:
        try:
            conn.execute(statement)
        except sqlite3.OperationalError:
            pass  # column already present


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
    conn.executescript(CONVERSATION_MERGE_HISTORY_SCHEMA)
    _apply_merge_history_migrations(conn)
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
            "SELECT merged_at, keep_id, keep_display_name, keep_handle, keep_message_count, "
            "remove_id, remove_display_name, remove_handle, remove_message_count "
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

        # Snapshot per-contact message counts before the merge moves remove_id's
        # messages onto keep_id, since afterward they're indistinguishable.
        keep_message_count = conn.execute(
            "SELECT COUNT(*) FROM messages WHERE sender_id = ?", (keep_id,)
        ).fetchone()[0]
        remove_message_count = conn.execute(
            "SELECT COUNT(*) FROM messages WHERE sender_id = ?", (remove_id,)
        ).fetchone()[0]

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
                "(merged_at, keep_id, keep_display_name, keep_handle, keep_message_count, "
                "remove_id, remove_display_name, remove_handle, remove_message_count) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    datetime.now(timezone.utc).isoformat(),
                    keep_id,
                    keep_resolved.display_name,
                    keep_resolved.handle,
                    keep_message_count,
                    remove_id,
                    remove_resolved.display_name,
                    remove_resolved.handle,
                    remove_message_count,
                ),
            )

            conn.commit()
        except Exception:
            conn.rollback()
            raise


def list_conversations_for_merge(conn: sqlite3.Connection, resolver) -> list[dict]:
    from services.names import build_conversation_display_name, resolve_participant

    convs = conn.execute("SELECT id, is_group_chat, convo_name FROM conversations").fetchall()
    counts = {
        r["conversation_id"]: r["c"]
        for r in conn.execute("SELECT conversation_id, COUNT(*) AS c FROM messages GROUP BY conversation_id")
    }
    participant_rows = conn.execute(
        """
        SELECT cp.conversation_id, p.id, p.phone_num, p.email, p.is_me
        FROM conversation_participants cp
        JOIN participants p ON p.id = cp.participant_id
        """
    ).fetchall()
    participants_by_conv: dict[str, list] = {}
    for r in participant_rows:
        participants_by_conv.setdefault(r["conversation_id"], []).append(r)

    out = []
    for c in convs:
        rows = participants_by_conv.get(c["id"], [])
        resolved = [resolve_participant(r["id"], r["phone_num"], r["email"], r["is_me"], resolver) for r in rows]
        handles = [p.handle for p in resolved if not p.is_me]
        out.append({
            "id": c["id"],
            "display_name": build_conversation_display_name(resolved, c["convo_name"]),
            "subtext": ", ".join(handles) if handles else "You",
            "is_group_chat": bool(c["is_group_chat"]),
            "message_count": counts.get(c["id"], 0),
        })
    out.sort(key=lambda c: c["display_name"].lower())
    return out


def list_conversation_merge_history(conn: sqlite3.Connection) -> list[dict]:
    try:
        rows = conn.execute(
            "SELECT merged_at, keep_id, keep_display_name, keep_message_count, "
            "remove_id, remove_display_name, remove_message_count "
            "FROM conversation_merge_history ORDER BY merged_at DESC"
        ).fetchall()
    except sqlite3.OperationalError:
        return []  # no conversation merge has happened yet in this db, so the table was never created
    return [dict(r) for r in rows]


def merge_conversations(keep_id: str, remove_id: str, resolver) -> None:
    from services.names import build_conversation_display_name, resolve_participant

    if keep_id == remove_id:
        raise MergeError("Can't merge a conversation into itself.")

    with get_write_connection() as conn:
        keep_row = conn.execute(
            "SELECT id, is_group_chat, convo_name FROM conversations WHERE id = ?", (keep_id,)
        ).fetchone()
        remove_row = conn.execute(
            "SELECT id, is_group_chat, convo_name FROM conversations WHERE id = ?", (remove_id,)
        ).fetchone()
        if keep_row is None or remove_row is None:
            raise MergeError("One or both conversations weren't found.")

        # Snapshot display names before mutating anything -- remove_row is about to be
        # deleted, so this is the last chance to capture what it was called.
        def resolved_name(conv_row) -> str:
            rows = conn.execute(
                """
                SELECT p.id, p.phone_num, p.email, p.is_me
                FROM conversation_participants cp
                JOIN participants p ON p.id = cp.participant_id
                WHERE cp.conversation_id = ?
                """,
                (conv_row["id"],),
            ).fetchall()
            resolved = [resolve_participant(r["id"], r["phone_num"], r["email"], r["is_me"], resolver) for r in rows]
            return build_conversation_display_name(resolved, conv_row["convo_name"])

        keep_name = resolved_name(keep_row)
        remove_name = resolved_name(remove_row)

        # Snapshot per-conversation message counts before the merge moves remove_id's
        # messages onto keep_id, since afterward they're indistinguishable.
        keep_message_count = conn.execute(
            "SELECT COUNT(*) FROM messages WHERE conversation_id = ?", (keep_id,)
        ).fetchone()[0]
        remove_message_count = conn.execute(
            "SELECT COUNT(*) FROM messages WHERE conversation_id = ?", (remove_id,)
        ).fetchone()[0]

        conn.execute("BEGIN")
        try:
            # conversation_participants has PK (conversation_id, participant_id): a
            # participant already in both conversations would collide on repoint, so
            # drop the redundant remove_id row for that participant instead.
            conn.execute(
                """
                DELETE FROM conversation_participants
                WHERE conversation_id = ?
                  AND participant_id IN (
                      SELECT participant_id FROM conversation_participants WHERE conversation_id = ?
                  )
                """,
                (remove_id, keep_id),
            )
            conn.execute(
                "UPDATE conversation_participants SET conversation_id = ? WHERE conversation_id = ?",
                (keep_id, remove_id),
            )

            conn.execute("UPDATE messages SET conversation_id = ? WHERE conversation_id = ?", (keep_id, remove_id))
            conn.execute(
                "UPDATE announcements SET conversation_id = ? WHERE conversation_id = ?", (keep_id, remove_id)
            )

            conn.execute("DELETE FROM conversations WHERE id = ?", (remove_id,))

            conn.execute(
                "INSERT INTO conversation_merge_history "
                "(merged_at, keep_id, keep_display_name, keep_message_count, "
                "remove_id, remove_display_name, remove_message_count) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    datetime.now(timezone.utc).isoformat(),
                    keep_id,
                    keep_name,
                    keep_message_count,
                    remove_id,
                    remove_name,
                    remove_message_count,
                ),
            )

            conn.commit()
        except Exception:
            conn.rollback()
            raise
