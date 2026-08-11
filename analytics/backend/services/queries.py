import itertools
import sqlite3

from services import names, stats


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


def get_messages_after(conn: sqlite3.Connection, conversation_id: str, after: str, limit: int) -> list[sqlite3.Row]:
    cursor_row = conn.execute(
        "SELECT id, timestamp FROM messages WHERE id = ? AND conversation_id = ?",
        (after, conversation_id),
    ).fetchone()
    if not cursor_row:
        return []
    return conn.execute(
        """
        SELECT id, sender_id, timestamp, text, has_attachment, has_sticker, reply_to
        FROM messages
        WHERE conversation_id = ? AND (timestamp, id) > (?, ?)
        ORDER BY timestamp ASC, id ASC
        LIMIT ?
        """,
        (conversation_id, cursor_row["timestamp"], cursor_row["id"], limit),
    ).fetchall()


def split_window_limits(limit: int) -> tuple[int, int]:
    """Splits a page `limit` into (before_limit, after_limit) around an anchor
    message, reserving one slot for the anchor itself."""
    after_limit = max(limit // 2, 1)
    before_limit = max(limit - after_limit - 1, 0)
    return before_limit, after_limit


def get_messages_around(
    conn: sqlite3.Connection, conversation_id: str, anchor_id: str, limit: int
) -> tuple[list[sqlite3.Row], list[sqlite3.Row], list[sqlite3.Row]]:
    """Returns (before_rows_oldest_first, anchor_rows, after_rows), windowed
    around anchor_id so a jump lands roughly centered with room to scroll
    freely in either direction from there."""
    anchor_row = conn.execute(
        "SELECT id, timestamp FROM messages WHERE id = ? AND conversation_id = ?",
        (anchor_id, conversation_id),
    ).fetchone()
    if not anchor_row:
        return [], [], []

    before_limit, after_limit = split_window_limits(limit)

    before_rows = conn.execute(
        """
        SELECT id, sender_id, timestamp, text, has_attachment, has_sticker, reply_to
        FROM messages
        WHERE conversation_id = ? AND (timestamp, id) < (?, ?)
        ORDER BY timestamp DESC, id DESC
        LIMIT ?
        """,
        (conversation_id, anchor_row["timestamp"], anchor_row["id"], before_limit),
    ).fetchall()
    anchor_rows = conn.execute(
        """
        SELECT id, sender_id, timestamp, text, has_attachment, has_sticker, reply_to
        FROM messages WHERE id = ? AND conversation_id = ?
        """,
        (anchor_id, conversation_id),
    ).fetchall()
    after_rows = conn.execute(
        """
        SELECT id, sender_id, timestamp, text, has_attachment, has_sticker, reply_to
        FROM messages
        WHERE conversation_id = ? AND (timestamp, id) > (?, ?)
        ORDER BY timestamp ASC, id ASC
        LIMIT ?
        """,
        (conversation_id, anchor_row["timestamp"], anchor_row["id"], after_limit),
    ).fetchall()

    return list(reversed(before_rows)), list(anchor_rows), list(after_rows)


def resolve_message_id_for_date(conn: sqlite3.Connection, conversation_id: str, date: str) -> str | None:
    row = conn.execute(
        """
        SELECT id FROM messages
        WHERE conversation_id = ? AND substr(timestamp, 1, 10) >= ?
        ORDER BY timestamp ASC, id ASC LIMIT 1
        """,
        (conversation_id, date),
    ).fetchone()
    if row:
        return row["id"]
    # The date is after the conversation's last message -- land on the last
    # message instead of returning nothing.
    row = conn.execute(
        """
        SELECT id FROM messages
        WHERE conversation_id = ? AND substr(timestamp, 1, 10) < ?
        ORDER BY timestamp DESC, id DESC LIMIT 1
        """,
        (conversation_id, date),
    ).fetchone()
    return row["id"] if row else None


def search_messages(conn: sqlite3.Connection, conversation_id: str, query: str, limit: int) -> list[sqlite3.Row]:
    escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return conn.execute(
        """
        SELECT id, timestamp, text FROM messages
        WHERE conversation_id = ? AND text LIKE ? ESCAPE '\\'
        ORDER BY timestamp ASC, id ASC
        LIMIT ?
        """,
        (conversation_id, f"%{escaped}%", limit),
    ).fetchall()


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


def get_conversation_display_names(conn: sqlite3.Connection, resolver) -> dict[str, str]:
    participants_by_conv = get_conversation_participants_raw(conn)
    return {
        conv_id: names.build_conversation_display_name(_resolve_participants(rows, resolver))
        for conv_id, rows in participants_by_conv.items()
    }


def get_participants_by_ids(conn: sqlite3.Connection, ids: list[str]) -> dict[str, sqlite3.Row]:
    if not ids:
        return {}
    placeholders = ",".join("?" for _ in ids)
    rows = conn.execute(
        f"SELECT id, phone_num, email, is_me FROM participants WHERE id IN ({placeholders})", ids
    ).fetchall()
    return {r["id"]: r for r in rows}


def _resolved_display_name(row: sqlite3.Row | None, resolver) -> str:
    if row is None:
        return "Unknown"
    resolved = names.resolve_participant(row["id"], row["phone_num"], row["email"], row["is_me"], resolver)
    return resolved.display_name


# --- Leaderboards ---------------------------------------------------------


def get_attachment_leaderboard(conn: sqlite3.Connection, resolver, limit: int) -> list[dict]:
    rows = conn.execute(
        """
        SELECT sender_id, COUNT(*) AS c
        FROM messages
        WHERE has_attachment = 1 OR has_sticker = 1
        GROUP BY sender_id
        ORDER BY c DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    participants = get_participants_by_ids(conn, [r["sender_id"] for r in rows])
    return [
        {
            "participant_id": r["sender_id"],
            "display_name": _resolved_display_name(participants.get(r["sender_id"]), resolver),
            "count": r["c"],
        }
        for r in rows
    ]


def _hydrate_message_leaderboard(
    conn: sqlite3.Connection, resolver, ranked: list[tuple[str, int]], count_key: str
) -> list[dict]:
    if not ranked:
        return []
    message_ids = [mid for mid, _ in ranked]
    placeholders = ",".join("?" for _ in message_ids)
    rows = conn.execute(
        f"SELECT id, conversation_id, sender_id, timestamp, text FROM messages WHERE id IN ({placeholders})",
        message_ids,
    ).fetchall()
    messages_by_id = {r["id"]: r for r in rows}
    participants = get_participants_by_ids(conn, [r["sender_id"] for r in rows])
    display_names = get_conversation_display_names(conn, resolver)

    result = []
    for message_id, count in ranked:
        m = messages_by_id.get(message_id)
        if m is None:
            continue
        result.append({
            "message_id": message_id,
            "text": m["text"],
            "sender_id": m["sender_id"],
            "sender_display_name": _resolved_display_name(participants.get(m["sender_id"]), resolver),
            "conversation_id": m["conversation_id"],
            "conversation_display_name": display_names.get(m["conversation_id"], "Unknown"),
            "timestamp": m["timestamp"],
            count_key: count,
        })
    return result


def get_most_tapbacked_messages(conn: sqlite3.Connection, resolver, limit: int) -> list[dict]:
    rows = conn.execute(
        "SELECT message_id, COUNT(*) AS c FROM tapbacks GROUP BY message_id ORDER BY c DESC LIMIT ?",
        (limit,),
    ).fetchall()
    ranked = [(r["message_id"], r["c"]) for r in rows]
    return _hydrate_message_leaderboard(conn, resolver, ranked, "tapback_count")


def get_most_replied_messages(conn: sqlite3.Connection, resolver, limit: int) -> list[dict]:
    rows = conn.execute(
        """
        SELECT reply_to, COUNT(*) AS c
        FROM messages
        WHERE reply_to IS NOT NULL
        GROUP BY reply_to
        ORDER BY c DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    ranked = [(r["reply_to"], r["c"]) for r in rows]
    return _hydrate_message_leaderboard(conn, resolver, ranked, "reply_count")


def get_day_activity_by_conversation(conn: sqlite3.Connection) -> dict[str, list[stats.DayActivity]]:
    # GROUP BY (conversation_id, day) has no covering index, so this does one
    # full-table sort -- but the output is one row per active conversation-
    # day (a small fraction of the 607K total messages), not one row per
    # message, which is why this is used instead of pulling every message.
    rows = conn.execute(
        """
        SELECT conversation_id, substr(timestamp, 1, 10) AS day,
               MIN(timestamp) AS start_ts, MAX(timestamp) AS end_ts
        FROM messages
        GROUP BY conversation_id, day
        ORDER BY conversation_id, day
        """
    ).fetchall()
    by_conv: dict[str, list[stats.DayActivity]] = {}
    for r in rows:
        by_conv.setdefault(r["conversation_id"], []).append(
            stats.DayActivity(day=r["day"], start_ts=r["start_ts"], end_ts=r["end_ts"])
        )
    return by_conv


def get_conversation_day_activity(conn: sqlite3.Connection, conversation_id: str) -> list[stats.DayActivity]:
    rows = conn.execute(
        """
        SELECT substr(timestamp, 1, 10) AS day, MIN(timestamp) AS start_ts, MAX(timestamp) AS end_ts
        FROM messages
        WHERE conversation_id = ?
        GROUP BY day
        ORDER BY day
        """,
        (conversation_id,),
    ).fetchall()
    return [stats.DayActivity(day=r["day"], start_ts=r["start_ts"], end_ts=r["end_ts"]) for r in rows]


def get_streak_leaderboard(conn: sqlite3.Connection, resolver) -> dict | None:
    best = stats.best_streak_conversation(get_day_activity_by_conversation(conn))
    if best is None:
        return None
    conv_id, streak_days = best
    display_names = get_conversation_display_names(conn, resolver)
    return {
        "conversation_id": conv_id,
        "conversation_display_name": display_names.get(conv_id, "Unknown"),
        "streak_days": streak_days,
    }


def get_silence_leaderboard(conn: sqlite3.Connection, resolver) -> dict | None:
    best = stats.best_silence_conversation(get_day_activity_by_conversation(conn))
    if best is None:
        return None
    conv_id, silence = best
    display_names = get_conversation_display_names(conn, resolver)
    return {
        "conversation_id": conv_id,
        "conversation_display_name": display_names.get(conv_id, "Unknown"),
        "gap_seconds": silence["gap_seconds"],
        "before": silence["before"],
        "after": silence["after"],
    }


def get_fastest_reply_relationship_type(conn: sqlite3.Connection) -> dict | None:
    # Full-table sort by (conversation_id, timestamp), same class of cost as
    # get_day_activity_by_conversation above -- there is no composite index
    # on messages(conversation_id, timestamp) yet (see perf note in project
    # docs), so this is O(n log n) over all 607K messages on every call.
    convs = {c["id"]: c["relationship_type"] for c in get_all_conversations(conn)}
    rows = conn.execute(
        "SELECT conversation_id, sender_id, timestamp FROM messages ORDER BY conversation_id, timestamp"
    ).fetchall()
    deltas_by_relationship: dict[str, list[float]] = {}
    for conv_id, group in itertools.groupby(rows, key=lambda r: r["conversation_id"]):
        rel = convs.get(conv_id)
        if rel is None:
            continue
        events = [stats.MessageEvent(sender_id=r["sender_id"], timestamp=r["timestamp"]) for r in group]
        deltas_by_relationship.setdefault(rel, []).extend(stats.reply_deltas_seconds(events))

    ranked = stats.fastest_reply_relationship_types(deltas_by_relationship)
    if not ranked:
        return None
    relationship_type, median_seconds = ranked[0]
    return {"relationship_type": relationship_type, "median_reply_seconds": median_seconds}


# --- Conversation detail additions ----------------------------------------


def get_conversation_dow_hour_counts(conn: sqlite3.Connection, conversation_id: str) -> list[tuple[int, int, int]]:
    rows = conn.execute(
        """
        SELECT CAST(strftime('%w', timestamp) AS INTEGER) AS dow,
               CAST(strftime('%H', timestamp) AS INTEGER) AS hour,
               COUNT(*) AS c
        FROM messages
        WHERE conversation_id = ?
        GROUP BY dow, hour
        """,
        (conversation_id,),
    ).fetchall()
    return [(r["dow"], r["hour"], r["c"]) for r in rows]


def get_global_dow_hour_counts(conn: sqlite3.Connection) -> list[tuple[int, int, int]]:
    rows = conn.execute(
        """
        SELECT CAST(strftime('%w', timestamp) AS INTEGER) AS dow,
               CAST(strftime('%H', timestamp) AS INTEGER) AS hour,
               COUNT(*) AS c
        FROM messages
        GROUP BY dow, hour
        """
    ).fetchall()
    return [(r["dow"], r["hour"], r["c"]) for r in rows]


def get_conversation_hours_by_sender(conn: sqlite3.Connection, conversation_id: str) -> list[tuple[str, int]]:
    rows = conn.execute(
        """
        SELECT sender_id, CAST(strftime('%H', timestamp) AS INTEGER) AS hour
        FROM messages WHERE conversation_id = ?
        """,
        (conversation_id,),
    ).fetchall()
    return [(r["sender_id"], r["hour"]) for r in rows]


MEMBERSHIP_ACTIONS = ("added person", "removed person", "left convo")


def get_conversation_membership_events(conn: sqlite3.Connection, conversation_id: str) -> list[sqlite3.Row]:
    placeholders = ",".join("?" for _ in MEMBERSHIP_ACTIONS)
    return conn.execute(
        f"""
        SELECT datetime, action, announcer_id, affected_id
        FROM announcements
        WHERE conversation_id = ? AND action IN ({placeholders})
        ORDER BY datetime
        """,
        (conversation_id, *MEMBERSHIP_ACTIONS),
    ).fetchall()


def get_conversation_group_size_series(conn: sqlite3.Connection, conversation_id: str) -> list[tuple[str, int]]:
    current_size = conn.execute(
        "SELECT COUNT(*) AS c FROM conversation_participants WHERE conversation_id = ?",
        (conversation_id,),
    ).fetchone()["c"]
    pairs = [(r["datetime"], r["action"]) for r in get_conversation_membership_events(conn, conversation_id)]
    return stats.group_size_over_time(current_size, pairs)


def get_conversation_join_leave_events(conn: sqlite3.Connection, resolver, conversation_id: str) -> list[dict]:
    events = get_conversation_membership_events(conn, conversation_id)
    subject_ids = [r["affected_id"] or r["announcer_id"] for r in events]
    participants = get_participants_by_ids(conn, [pid for pid in subject_ids if pid])
    return [
        {
            "datetime": r["datetime"],
            "kind": "joined" if r["action"] == "added person" else "left",
            "display_name": _resolved_display_name(participants.get(r["affected_id"] or r["announcer_id"]), resolver),
        }
        for r in events
    ]


def get_conversation_reply_edges(conn: sqlite3.Connection, conversation_id: str) -> list[tuple[str, str]]:
    rows = conn.execute(
        """
        SELECT m.sender_id AS replier, t.sender_id AS original
        FROM messages m
        JOIN messages t ON m.reply_to = t.id AND t.conversation_id = m.conversation_id
        WHERE m.conversation_id = ?
        """,
        (conversation_id,),
    ).fetchall()
    return [(r["replier"], r["original"]) for r in rows]


def get_conversation_reply_graph(conn: sqlite3.Connection, resolver, conversation_id: str) -> list[dict]:
    graph = stats.build_reply_graph(get_conversation_reply_edges(conn, conversation_id))
    participants = get_conversation_participants_resolved(conn, resolver, conversation_id)

    def _name(pid: str) -> str:
        p = participants.get(pid)
        return p.display_name if p else "Unknown"

    return [
        {
            "replier_id": replier,
            "replier_display_name": _name(replier),
            "original_id": original,
            "original_display_name": _name(original),
            "count": count,
        }
        for replier, original, count in graph
    ]
