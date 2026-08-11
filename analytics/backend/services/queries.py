import sqlite3

from services import names


def _resolve_participants(rows: list[sqlite3.Row], resolver) -> list["names.ResolvedParticipant"]:
    return [names.resolve_participant(r["id"], r["phone_num"], r["email"], r["is_me"], resolver) for r in rows]


def get_overview_stats(conn: sqlite3.Connection) -> dict:
    total_messages = conn.execute("SELECT COUNT(*) c FROM messages").fetchone()["c"]
    total_conversations = conn.execute("SELECT COUNT(*) c FROM conversations").fetchone()["c"]
    total_participants = conn.execute("SELECT COUNT(*) c FROM participants").fetchone()["c"]
    row = conn.execute("SELECT MIN(timestamp) lo, MAX(timestamp) hi FROM messages").fetchone()
    return {
        "total_messages": total_messages,
        "total_conversations": total_conversations,
        "total_participants": total_participants,
        "date_range_start": row["lo"],
        "date_range_end": row["hi"],
    }


def get_daily_message_counts(conn: sqlite3.Connection) -> list[tuple[str, int]]:
    rows = conn.execute(
        "SELECT substr(timestamp, 1, 10) AS day, COUNT(*) AS c FROM messages GROUP BY day ORDER BY day"
    ).fetchall()
    return [(r["day"], r["c"]) for r in rows]


def get_daily_message_counts_for_conversation(conn: sqlite3.Connection, conversation_id: str) -> list[tuple[str, int]]:
    rows = conn.execute(
        "SELECT substr(timestamp, 1, 10) AS day, COUNT(*) AS c "
        "FROM messages WHERE conversation_id = ? GROUP BY day ORDER BY day",
        (conversation_id,),
    ).fetchall()
    return [(r["day"], r["c"]) for r in rows]


def get_message_counts_and_last_activity(conn: sqlite3.Connection) -> dict[str, tuple[int, str]]:
    rows = conn.execute(
        "SELECT conversation_id, COUNT(*) AS c, MAX(timestamp) AS last FROM messages GROUP BY conversation_id"
    ).fetchall()
    return {r["conversation_id"]: (r["c"], r["last"]) for r in rows}


def get_conversation_participants_raw(conn: sqlite3.Connection) -> dict[str, list[sqlite3.Row]]:
    rows = conn.execute(
        """
        SELECT cp.conversation_id, p.id, p.phone_num, p.email, p.is_me
        FROM conversation_participants cp
        JOIN participants p ON p.id = cp.participant_id
        """
    ).fetchall()
    by_conv: dict[str, list[sqlite3.Row]] = {}
    for row in rows:
        by_conv.setdefault(row["conversation_id"], []).append(row)
    return by_conv


def get_all_conversations(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute("SELECT id, is_group_chat, relationship_type FROM conversations").fetchall()


def get_top_conversations(conn: sqlite3.Connection, resolver, limit: int) -> list[dict]:
    counts = get_message_counts_and_last_activity(conn)
    participants_by_conv = get_conversation_participants_raw(conn)
    convs = {c["id"]: c for c in get_all_conversations(conn)}

    ranked = sorted(counts.items(), key=lambda kv: kv[1][0], reverse=True)[:limit]
    result = []
    for conv_id, (count, _last) in ranked:
        rows = participants_by_conv.get(conv_id, [])
        resolved = _resolve_participants(rows, resolver)
        result.append({
            "conversation_id": conv_id,
            "display_name": names.build_conversation_display_name(resolved),
            "message_count": count,
            "is_group_chat": bool(convs[conv_id]["is_group_chat"]) if conv_id in convs else False,
        })
    return result


def list_conversations(
    conn: sqlite3.Connection, resolver, search: str | None, sort: str, page: int, page_size: int
) -> dict:
    counts = get_message_counts_and_last_activity(conn)
    participants_by_conv = get_conversation_participants_raw(conn)
    all_convs = get_all_conversations(conn)

    items = []
    for conv in all_convs:
        conv_id = conv["id"]
        count, last = counts.get(conv_id, (0, None))
        rows = participants_by_conv.get(conv_id, [])
        resolved = _resolve_participants(rows, resolver)
        items.append({
            "id": conv_id,
            "display_name": names.build_conversation_display_name(resolved),
            "is_group_chat": bool(conv["is_group_chat"]),
            "relationship_type": conv["relationship_type"],
            "message_count": count,
            "last_activity": last,
        })

    if search:
        needle = search.lower()
        items = [i for i in items if needle in i["display_name"].lower()]

    if sort == "recent":
        items.sort(key=lambda i: i["last_activity"] or "", reverse=True)
    else:
        items.sort(key=lambda i: i["message_count"], reverse=True)

    total = len(items)
    start = (page - 1) * page_size
    page_items = items[start:start + page_size]
    return {"items": page_items, "total": total, "page": page, "page_size": page_size}


def get_conversation_participants_resolved(
    conn: sqlite3.Connection, resolver, conversation_id: str
) -> dict[str, "names.ResolvedParticipant"]:
    rows = conn.execute(
        """
        SELECT p.id, p.phone_num, p.email, p.is_me
        FROM conversation_participants cp
        JOIN participants p ON p.id = cp.participant_id
        WHERE cp.conversation_id = ?
        """,
        (conversation_id,),
    ).fetchall()
    return {
        r["id"]: names.resolve_participant(r["id"], r["phone_num"], r["email"], r["is_me"], resolver) for r in rows
    }


def get_conversation_detail(conn: sqlite3.Connection, resolver, conversation_id: str) -> dict | None:
    conv = conn.execute(
        "SELECT id, is_group_chat, relationship_type FROM conversations WHERE id = ?",
        (conversation_id,),
    ).fetchone()
    if conv is None:
        return None
    participants = get_conversation_participants_resolved(conn, resolver, conversation_id)
    return {
        "id": conv["id"],
        "is_group_chat": bool(conv["is_group_chat"]),
        "relationship_type": conv["relationship_type"],
        "participants": [
            {"id": p.id, "handle": p.handle, "display_name": p.display_name, "is_me": p.is_me}
            for p in participants.values()
        ],
    }


def get_conversation_messages_for_stats(conn: sqlite3.Connection, conversation_id: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT id, sender_id, timestamp, text FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC",
        (conversation_id,),
    ).fetchall()


def get_conversation_tapback_events(conn: sqlite3.Connection, conversation_id: str) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT t.reactor_id, t.action, m.sender_id AS target_sender_id
        FROM tapbacks t
        JOIN messages m ON m.id = t.message_id
        WHERE m.conversation_id = ?
        """,
        (conversation_id,),
    ).fetchall()


def get_messages_page(conn: sqlite3.Connection, conversation_id: str, before: str | None, limit: int) -> list[sqlite3.Row]:
    cursor_timestamp = None
    cursor_id = None
    if before:
        cursor_row = conn.execute(
            "SELECT id, timestamp FROM messages WHERE id = ? AND conversation_id = ?",
            (before, conversation_id),
        ).fetchone()
        if cursor_row:
            cursor_timestamp = cursor_row["timestamp"]
            cursor_id = cursor_row["id"]

    if cursor_timestamp is not None:
        rows = conn.execute(
            """
            SELECT id, sender_id, timestamp, text, has_attachment, has_sticker, reply_to
            FROM messages
            WHERE conversation_id = ? AND (timestamp, id) < (?, ?)
            ORDER BY timestamp DESC, id DESC
            LIMIT ?
            """,
            (conversation_id, cursor_timestamp, cursor_id, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT id, sender_id, timestamp, text, has_attachment, has_sticker, reply_to
            FROM messages WHERE conversation_id = ?
            ORDER BY timestamp DESC, id DESC LIMIT ?
            """,
            (conversation_id, limit),
        ).fetchall()
    return list(reversed(rows))


def get_tapbacks_for_messages(
    conn: sqlite3.Connection, message_ids: list[str], participants: dict[str, "names.ResolvedParticipant"]
) -> dict[str, list[dict]]:
    if not message_ids:
        return {}
    placeholders = ",".join("?" for _ in message_ids)
    rows = conn.execute(
        f"SELECT message_id, reactor_id, action FROM tapbacks WHERE message_id IN ({placeholders})",
        message_ids,
    ).fetchall()
    result: dict[str, list[dict]] = {}
    for r in rows:
        resolved = participants.get(r["reactor_id"])
        display_name = resolved.display_name if resolved else "Unknown"
        result.setdefault(r["message_id"], []).append(
            {"reactor_id": r["reactor_id"], "display_name": display_name, "action": r["action"]}
        )
    return result
