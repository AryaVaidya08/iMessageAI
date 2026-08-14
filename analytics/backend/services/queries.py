import itertools
import sqlite3
from statistics import median

from services import names, stats

# A reply counts as "breaking a silence" once at least this long has passed since the previous
# message (from anyone) -- chosen as a round number well above typical back-and-forth reply
# latency but well below a full day. Shared by routers/conversations.py's get_participant_stats
# and get_person_reply_stats below, so both compute "breaks silences" the same way.
GAP_INITIATOR_THRESHOLD_SECONDS = 6 * 3600


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
    return conn.execute("SELECT id, is_group_chat, relationship_type, convo_name FROM conversations").fetchall()


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
            "display_name": names.build_conversation_display_name(resolved, convs[conv_id]["convo_name"] if conv_id in convs else None),
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
            "display_name": names.build_conversation_display_name(resolved, conv["convo_name"]),
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
        "SELECT id, is_group_chat, relationship_type, convo_name FROM conversations WHERE id = ?",
        (conversation_id,),
    ).fetchone()
    if conv is None:
        return None
    participants = get_conversation_participants_resolved(conn, resolver, conversation_id)
    counts = conn.execute(
        "SELECT COUNT(*) AS count, MIN(timestamp) AS first_ts, MAX(timestamp) AS last_ts "
        "FROM messages WHERE conversation_id = ?",
        (conversation_id,),
    ).fetchone()
    return {
        "id": conv["id"],
        "display_name": names.build_conversation_display_name(list(participants.values()), conv["convo_name"]),
        "is_group_chat": bool(conv["is_group_chat"]),
        "relationship_type": conv["relationship_type"],
        "participants": [
            {"id": p.id, "handle": p.handle, "display_name": p.display_name, "is_me": p.is_me}
            for p in participants.values()
        ],
        "message_count": counts["count"],
        "first_message_at": counts["first_ts"],
        "last_message_at": counts["last_ts"],
    }


def get_messages_for_stats(conn: sqlite3.Connection, where_clause: str, params: tuple) -> list[sqlite3.Row]:
    """
    id, sender_id, conversation_id, timestamp, text for messages matching `where_clause` (a
    fixed SQL fragment built by callers in this module -- e.g. conversation_leaderboard_scope /
    person_leaderboard_scope -- never from raw user input). Ordered by (conversation_id,
    timestamp, id) rather than plain timestamp: for a single-conversation scope (Conversation
    Detail) this is equivalent to ordering by timestamp alone, but for a scope spanning several
    conversations (Person Detail's "sender_id = ?", or the "conversation_id IN (...)" scope used
    by get_person_reply_stats) it keeps each conversation's messages contiguous, which
    get_person_reply_stats relies on to avoid treating the boundary between two unrelated
    conversations as a reply transition.
    """
    return conn.execute(
        f"SELECT id, sender_id, conversation_id, timestamp, text FROM messages WHERE {where_clause} "
        "ORDER BY conversation_id, timestamp ASC, id ASC",
        params,
    ).fetchall()


def get_tapback_events(conn: sqlite3.Connection, where_clause: str, params: tuple) -> list[sqlite3.Row]:
    """where_clause applies to bare `messages` columns (the table isn't aliased here), e.g.
    "conversation_id = ?" for Conversation Detail or "conversation_id IN (...)" for Person
    Detail (see get_person_stats -- tapbacks given/received need to see every conversation this
    person is in, since stats.tapbacks_given/received then filter to their own perspective)."""
    return conn.execute(
        f"""
        SELECT t.reactor_id, t.action, messages.sender_id AS target_sender_id
        FROM tapbacks t
        JOIN messages ON messages.id = t.message_id
        WHERE {where_clause}
        """,
        params,
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
    convo_names = {c["id"]: c["convo_name"] for c in get_all_conversations(conn)}
    return {
        conv_id: names.build_conversation_display_name(_resolve_participants(rows, resolver), convo_names.get(conv_id))
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


def get_fastest_reply_relationship_type(conn: sqlite3.Connection) -> dict | None:
    # Full-table sort by (conversation_id, timestamp) -- there is no composite
    # index on messages(conversation_id, timestamp) yet (see perf note in
    # project docs), so this is O(n log n) over all 607K messages on every call.
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


def get_dow_hour_counts(conn: sqlite3.Connection, where_clause: str, params: tuple) -> list[tuple[int, int, int]]:
    """where_clause applies to bare `messages` columns, e.g. "conversation_id = ?" for
    Conversation Detail's heatmap. Person Detail uses "sender_id = ?" -- a person's heatmap
    shows when THEY personally text, not the combined traffic of every conversation they're in."""
    rows = conn.execute(
        f"""
        SELECT CAST(strftime('%w', timestamp) AS INTEGER) AS dow,
               CAST(strftime('%H', timestamp) AS INTEGER) AS hour,
               COUNT(*) AS c
        FROM messages
        WHERE {where_clause}
        GROUP BY dow, hour
        """,
        params,
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


def get_hours_by_sender(conn: sqlite3.Connection, where_clause: str, params: tuple) -> list[tuple[str, int]]:
    """where_clause applies to bare `messages` columns. Conversation Detail uses
    "conversation_id = ?" (late_night_ratio is computed per sender anyway, so every
    participant's hours flow through this one call); Person Detail uses "sender_id = ?" (their
    own late-night ratio doesn't depend on who else is in the conversation)."""
    rows = conn.execute(
        f"SELECT sender_id, CAST(strftime('%H', timestamp) AS INTEGER) AS hour FROM messages WHERE {where_clause}",
        params,
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


# --- Conversation leaderboard -----------------------------------------


def get_tapback_counts_by_message(
    conn: sqlite3.Connection, where_clause: str, params: tuple, actions: tuple[str, ...] | None = None
) -> dict[str, int]:
    """message_id -> tapback count for messages matching `where_clause` (applies to bare
    `messages` columns, e.g. "conversation_id = ?" or "sender_id = ?"), optionally restricted to
    `actions`."""
    if actions is None:
        rows = conn.execute(
            f"""
            SELECT t.message_id, COUNT(*) AS c
            FROM tapbacks t
            JOIN messages ON messages.id = t.message_id
            WHERE {where_clause}
            GROUP BY t.message_id
            """,
            params,
        ).fetchall()
    else:
        placeholders = ",".join("?" for _ in actions)
        rows = conn.execute(
            f"""
            SELECT t.message_id, COUNT(*) AS c
            FROM tapbacks t
            JOIN messages ON messages.id = t.message_id
            WHERE ({where_clause}) AND t.action IN ({placeholders})
            GROUP BY t.message_id
            """,
            (*params, *actions),
        ).fetchall()
    return {r["message_id"]: r["c"] for r in rows}


def get_reply_counts(conn: sqlite3.Connection, where_clause: str, params: tuple) -> dict[str, int]:
    """message_id -> number of direct replies it received ("most argued-about"). `where_clause`
    scopes which REPLYING messages count: Conversation Detail uses "conversation_id = ?" (a
    reply is always in the same conversation as its original, so this also limits which
    originals can appear as keys); Person Detail instead needs to scope by the ORIGINAL
    message's sender, which isn't a column on the replying row, so it uses
    "reply_to IN (SELECT id FROM messages WHERE sender_id = ?)"."""
    rows = conn.execute(
        f"SELECT reply_to, COUNT(*) AS c FROM messages WHERE reply_to IS NOT NULL AND ({where_clause}) GROUP BY reply_to",
        params,
    ).fetchall()
    return {r["reply_to"]: r["c"] for r in rows}


def get_fastest_reply(conn: sqlite3.Connection, where_clause: str, params: tuple) -> tuple[str, float] | None:
    """(message_id, seconds_to_first_reply) for the message that got the quickest reply, or
    None. `where_clause` applies to the `t` alias (the ORIGINAL message) since this is a
    self-join: Conversation Detail uses "t.conversation_id = ?", Person Detail uses
    "t.sender_id = ?" (fastest reply to something THIS person sent)."""
    rows = conn.execute(
        f"""
        SELECT t.id AS orig_id, t.timestamp AS orig_ts, MIN(m.timestamp) AS reply_ts
        FROM messages m
        JOIN messages t ON m.reply_to = t.id AND t.conversation_id = m.conversation_id
        WHERE {where_clause}
        GROUP BY t.id
        """,
        params,
    ).fetchall()
    best: tuple[str, float] | None = None
    for r in rows:
        delta = (stats.datetime.fromisoformat(r["reply_ts"]) - stats.datetime.fromisoformat(r["orig_ts"])).total_seconds()
        if best is None or delta < best[1]:
            best = (r["orig_id"], delta)
    return best


def _pick_message_winner(
    rows: list[sqlite3.Row], score_fn, participants: dict[str, "names.ResolvedParticipant"]
) -> dict | None:
    """rows: (id, sender_id, timestamp, text) rows. Picks the row with the highest score_fn(row), ties broken
    by earliest timestamp. Returns None if no row scores above 0, since a "winner" with a zero score (e.g. no
    reactions at all) isn't a meaningful record."""
    best_row = None
    best_score = 0.0
    for r in rows:
        score = score_fn(r)
        if score > best_score or (best_row is not None and score == best_score and r["timestamp"] < best_row["timestamp"]):
            best_row, best_score = r, score
    return _hydrate_winner(best_row, best_score, participants)


def _hydrate_winner(
    row: sqlite3.Row | None, score: float, participants: dict[str, "names.ResolvedParticipant"]
) -> dict | None:
    if row is None:
        return None
    sender = participants.get(row["sender_id"])
    return {
        "message_id": row["id"],
        "sender_id": row["sender_id"],
        "sender_display_name": sender.display_name if sender else "Unknown",
        "timestamp": row["timestamp"],
        "text": row["text"],
        "value": score,
    }


ANNOUNCEMENT_PHOTO_ACTIONS = ("changed photo", "removed photo", "changed background", "removed background")


def get_announcement_leader(
    conn: sqlite3.Connection, resolver, where_clause: str, params: tuple, actions: tuple[str, ...], subject_field: str
) -> dict | None:
    """
    Top participant by count of announcement `actions` matching `where_clause`, keyed by
    `subject_field` ("announcer_id" for who performed the action, "affected_id" for who the
    action happened to -- e.g. who joined/left). subject_field is a fixed internal column name,
    never user input.

    For Conversation Detail, `where_clause` is "conversation_id = ?" regardless of
    subject_field -- this finds whoever is #1 *within that conversation*. For Person Detail,
    `where_clause` is "{subject_field} = ?" (see person_leaderboard_scope) -- restricting rows to
    this one person before grouping means GROUP BY collapses to a single group (themselves), so
    the "leader" is just this person's own total count of that action, across every conversation.
    """
    placeholders = ",".join("?" for _ in actions)
    row = conn.execute(
        f"""
        SELECT {subject_field} AS subject_id, COUNT(*) AS c
        FROM announcements
        WHERE ({where_clause}) AND action IN ({placeholders}) AND {subject_field} IS NOT NULL
        GROUP BY {subject_field}
        ORDER BY c DESC
        LIMIT 1
        """,
        (*params, *actions),
    ).fetchone()
    if row is None:
        return None
    participant = get_participants_by_ids(conn, [row["subject_id"]]).get(row["subject_id"])
    return {
        "participant_id": row["subject_id"],
        "display_name": _resolved_display_name(participant, resolver),
        "count": row["c"],
    }


def conversation_leaderboard_scope(conversation_id: str) -> dict:
    """Leaderboard widget scope for Conversation Detail: everything within this one conversation."""
    conv = ("conversation_id = ?", (conversation_id,))
    return {
        "message_where": conv,
        "reply_counts_where": conv,
        "fastest_reply_where": ("t.conversation_id = ?", (conversation_id,)),
        "announcement_where_fn": lambda _subject_field: conv,
    }


def person_leaderboard_scope(participant_id: str) -> dict:
    """Leaderboard widget scope for Person Detail: this person's own sent messages (and
    announcements they performed/were affected by), across every conversation they're in."""
    return {
        "message_where": ("sender_id = ?", (participant_id,)),
        "reply_counts_where": (
            "reply_to IN (SELECT id FROM messages WHERE sender_id = ?)",
            (participant_id,),
        ),
        "fastest_reply_where": ("t.sender_id = ?", (participant_id,)),
        "announcement_where_fn": lambda subject_field: (f"{subject_field} = ?", (participant_id,)),
    }


def get_leaderboard(
    conn: sqlite3.Connection, resolver, participants: dict[str, "names.ResolvedParticipant"], scope: dict
) -> dict:
    message_where, message_params = scope["message_where"]
    reply_counts_where, reply_counts_params = scope["reply_counts_where"]
    fastest_reply_where, fastest_reply_params = scope["fastest_reply_where"]
    announcement_where_fn = scope["announcement_where_fn"]

    message_rows = get_messages_for_stats(conn, message_where, message_params)

    loved_counts = get_tapback_counts_by_message(conn, message_where, message_params, ("Loved",))
    laughed_counts = get_tapback_counts_by_message(conn, message_where, message_params, ("Laughed",))
    disliked_counts = get_tapback_counts_by_message(conn, message_where, message_params, ("Disliked",))
    reacted_counts = get_tapback_counts_by_message(conn, message_where, message_params)
    reply_counts = get_reply_counts(conn, reply_counts_where, reply_counts_params)

    def winner(score_fn) -> dict | None:
        return _pick_message_winner(message_rows, score_fn, participants)

    # Single pass over every message for the text-derived metrics (length, aggression,
    # sentiment, emoji count, late-night depth): computing each of these with its own
    # winner() call would re-run VADER sentiment scoring -- the most expensive check
    # here -- twice, and walk the message list several extra times, which adds up in
    # the largest conversations (up to ~200K messages).
    best_longest = best_aggressive = best_happiest = best_emoji = best_late_night = None
    best_longest_score = best_aggressive_score = 0.0
    best_happiest_score = best_emoji_score = best_late_night_score = 0.0
    for r in message_rows:
        text = r["text"] or ""
        length = len(text.strip())
        if length > best_longest_score:
            best_longest, best_longest_score = r, length
        aggressive = stats.message_aggressive_score(text)
        if aggressive > best_aggressive_score:
            best_aggressive, best_aggressive_score = r, aggressive
        emoji_count = stats.message_emoji_count(text)
        if emoji_count > best_emoji_score:
            best_emoji, best_emoji_score = r, emoji_count
        if text:
            sentiment = stats.message_sentiment(text)
            if sentiment > best_happiest_score:
                best_happiest, best_happiest_score = r, sentiment
        if int(r["timestamp"][11:13]) in stats.LATE_NIGHT_HOURS:
            late_score = 721 - stats.late_night_distance_minutes(r["timestamp"])
            if late_score > best_late_night_score:
                best_late_night, best_late_night_score = r, late_score

    fastest = get_fastest_reply(conn, fastest_reply_where, fastest_reply_params)
    fastest_reply_message = None
    if fastest is not None:
        orig_id, delta_seconds = fastest
        orig_row = next((r for r in message_rows if r["id"] == orig_id), None)
        if orig_row is not None:
            sender = participants.get(orig_row["sender_id"])
            fastest_reply_message = {
                "message_id": orig_row["id"],
                "sender_id": orig_row["sender_id"],
                "sender_display_name": sender.display_name if sender else "Unknown",
                "timestamp": orig_row["timestamp"],
                "text": orig_row["text"],
                "value": delta_seconds,
            }

    return {
        "longest_message": _hydrate_winner(best_longest, best_longest_score, participants),
        "most_argued_message": winner(lambda r: reply_counts.get(r["id"], 0)),
        "most_loved_message": winner(lambda r: loved_counts.get(r["id"], 0)),
        "most_laughed_message": winner(lambda r: laughed_counts.get(r["id"], 0)),
        "most_disliked_message": winner(lambda r: disliked_counts.get(r["id"], 0)),
        "most_reacted_message": winner(lambda r: reacted_counts.get(r["id"], 0)),
        "most_aggressive_message": _hydrate_winner(best_aggressive, best_aggressive_score, participants),
        "happiest_message": _hydrate_winner(best_happiest, best_happiest_score, participants),
        "most_emoji_message": _hydrate_winner(best_emoji, best_emoji_score, participants),
        "late_night_message": _hydrate_winner(best_late_night, best_late_night_score, participants),
        "fastest_reply_message": fastest_reply_message,
        "top_renamer": get_announcement_leader(
            conn, resolver, *announcement_where_fn("announcer_id"), ("renamed convo",), "announcer_id"
        ),
        "top_photo_changer": get_announcement_leader(
            conn, resolver, *announcement_where_fn("announcer_id"), ANNOUNCEMENT_PHOTO_ACTIONS, "announcer_id"
        ),
        "top_unsender": get_announcement_leader(
            conn, resolver, *announcement_where_fn("announcer_id"), ("unsent message",), "announcer_id"
        ),
        "most_revolving_door": get_announcement_leader(
            conn, resolver, *announcement_where_fn("affected_id"), MEMBERSHIP_ACTIONS, "affected_id"
        ),
    }


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


# --- People ------------------------------------------------------------


def get_all_participants_with_stats(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    """
    One row per participant, including is_me (yourself): id, phone_num, email, is_me,
    message_count, conversation_count, first_message, last_message.

    Aggregates via two pre-grouped subqueries (one over messages, one over
    conversation_participants) rather than a single 3-way JOIN + GROUP BY: joining messages and
    conversation_participants directly on participant id would fan out to
    len(messages_for_p) * len(conversations_for_p) intermediate rows per participant before
    COUNT DISTINCT could collapse them back down -- still correct, but with 607K messages in the
    real database that fan-out is large enough to matter, so it's avoided here.
    """
    return conn.execute(
        """
        SELECT p.id, p.phone_num, p.email, p.is_me,
               COALESCE(msg.message_count, 0) AS message_count,
               COALESCE(conv.conversation_count, 0) AS conversation_count,
               msg.first_message, msg.last_message
        FROM participants p
        LEFT JOIN (
            SELECT sender_id, COUNT(*) AS message_count, MIN(timestamp) AS first_message, MAX(timestamp) AS last_message
            FROM messages
            GROUP BY sender_id
        ) msg ON msg.sender_id = p.id
        LEFT JOIN (
            SELECT participant_id, COUNT(*) AS conversation_count
            FROM conversation_participants
            GROUP BY participant_id
        ) conv ON conv.participant_id = p.id
        """
    ).fetchall()


def list_people(
    conn: sqlite3.Connection, resolver, search: str | None, sort: str, page: int, page_size: int
) -> dict:
    """Mirrors list_conversations' shape/pagination style."""
    rows = get_all_participants_with_stats(conn)
    items = []
    for r in rows:
        resolved = names.resolve_participant(r["id"], r["phone_num"], r["email"], r["is_me"], resolver)
        items.append({
            "id": r["id"],
            "handle": resolved.handle,
            "display_name": resolved.display_name,
            "message_count": r["message_count"],
            "conversation_count": r["conversation_count"],
            "last_message_at": r["last_message"],
        })

    if search:
        needle = search.lower()
        items = [i for i in items if needle in i["display_name"].lower()]

    if sort == "recent":
        items.sort(key=lambda i: i["last_message_at"] or "", reverse=True)
    else:
        items.sort(key=lambda i: i["message_count"], reverse=True)

    total = len(items)
    start = (page - 1) * page_size
    page_items = items[start:start + page_size]
    return {"items": page_items, "total": total, "page": page, "page_size": page_size}


def get_resolved_participant(conn: sqlite3.Connection, resolver, participant_id: str) -> "names.ResolvedParticipant | None":
    row = conn.execute(
        "SELECT id, phone_num, email, is_me FROM participants WHERE id = ?", (participant_id,)
    ).fetchone()
    if row is None:
        return None
    return names.resolve_participant(row["id"], row["phone_num"], row["email"], row["is_me"], resolver)


def get_person_conversation_ids(conn: sqlite3.Connection, participant_id: str) -> list[str]:
    rows = conn.execute(
        "SELECT conversation_id FROM conversation_participants WHERE participant_id = ?", (participant_id,)
    ).fetchall()
    return [r["conversation_id"] for r in rows]


def get_person_conversations(conn: sqlite3.Connection, resolver, participant_id: str) -> list[dict]:
    """Every conversation this person is in, with that conversation's own total message count
    (not just the messages this person sent in it) -- matches how ConversationSummary.message_count
    works elsewhere. Reuses the same global-load-then-index-in-Python helpers as
    get_top_conversations/list_conversations rather than a fresh per-person SQL query, for the
    same style of participant-name resolution."""
    conv_ids = set(get_person_conversation_ids(conn, participant_id))
    if not conv_ids:
        return []
    counts = get_message_counts_and_last_activity(conn)
    display_names = get_conversation_display_names(conn, resolver)
    convs = {c["id"]: c for c in get_all_conversations(conn)}

    result = []
    for conv_id in conv_ids:
        conv = convs.get(conv_id)
        if conv is None:
            continue
        count, _last = counts.get(conv_id, (0, None))
        result.append({
            "conversation_id": conv_id,
            "display_name": display_names.get(conv_id, "Unknown"),
            "relationship_type": conv["relationship_type"],
            "is_group_chat": bool(conv["is_group_chat"]),
            "message_count": count,
        })
    result.sort(key=lambda c: c["message_count"], reverse=True)
    return result


def get_person_reply_stats(conn: sqlite3.Connection, participant_id: str) -> dict:
    """
    Median reply time, reply-time histogram, and gap-initiator count for one person, computed
    across every conversation they're in (conversation_id IN subquery -- "did X reply to Y"
    needs to see every participant's messages, not just this person's).

    Pooling messages from different conversations into a single timeline by raw timestamp would
    misdetect a reply: the boundary between the last message of one conversation and the first
    message of an unrelated one would look like a sender-transition "reply" even though the two
    conversations have nothing to do with each other. get_messages_for_stats orders by
    (conversation_id, timestamp), so grouping by conversation_id here (mirroring
    get_fastest_reply_relationship_type) keeps each conversation's transition detection
    self-contained; only this person's own resulting reply deltas are then pooled across groups.
    """
    rows = get_messages_for_stats(
        conn,
        "conversation_id IN (SELECT conversation_id FROM conversation_participants WHERE participant_id = ?)",
        (participant_id,),
    )
    pooled_deltas: list[float] = []
    gap_initiator_count = 0
    for _conv_id, group in itertools.groupby(rows, key=lambda r: r["conversation_id"]):
        events = [stats.MessageEvent(sender_id=r["sender_id"], timestamp=r["timestamp"]) for r in group]
        deltas_by_sender = stats.reply_deltas_by_sender(events)
        pooled_deltas.extend(deltas_by_sender.get(participant_id, []))
        gap_initiator_count += stats.gap_initiators(events, GAP_INITIATOR_THRESHOLD_SECONDS).get(participant_id, 0)

    return {
        "median_reply_seconds": median(pooled_deltas) if pooled_deltas else None,
        "reply_histogram": stats.bucket_reply_deltas(pooled_deltas),
        "gap_initiator_count": gap_initiator_count,
    }


def get_person_stats(conn: sqlite3.Connection, resolver, participant_id: str) -> dict | None:
    """Single-person analogue of the per-participant entries routers/conversations.py builds in
    get_participant_stats, but scoped to messages this person sent across every conversation
    they're in (not just one)."""
    resolved = get_resolved_participant(conn, resolver, participant_id)
    if resolved is None:
        return None

    message_rows = get_messages_for_stats(conn, "sender_id = ?", (participant_id,))
    texts = [r["text"] for r in message_rows]
    sentiment_rows = [(r["timestamp"][:10], r["text"]) for r in message_rows if r["text"]]

    tapback_rows = get_tapback_events(
        conn,
        "conversation_id IN (SELECT conversation_id FROM conversation_participants WHERE participant_id = ?)",
        (participant_id,),
    )
    tapback_events = [
        stats.TapbackEvent(reactor_id=r["reactor_id"], target_sender_id=r["target_sender_id"], action=r["action"])
        for r in tapback_rows
    ]

    hours = get_hours_by_sender(conn, "sender_id = ?", (participant_id,))
    late_night = stats.late_night_ratio(hours)
    reply_stats = get_person_reply_stats(conn, participant_id)

    return {
        "participant_id": participant_id,
        "display_name": resolved.display_name,
        "handle": resolved.handle,
        "message_count": len(message_rows),
        "median_reply_seconds": reply_stats["median_reply_seconds"],
        "reply_histogram": [{"label": label, "count": count} for label, count in reply_stats["reply_histogram"]],
        "gap_initiator_count": reply_stats["gap_initiator_count"],
        "late_night_ratio": late_night.get(participant_id, 0.0),
        "top_words": [{"word": w, "count": c} for w, c in stats.top_words(texts)],
        "top_emojis": [{"emoji": e, "count": c} for e, c in stats.top_emojis(texts)],
        "tapbacks_given": [{"action": a, "count": c} for a, c in stats.tapbacks_given(tapback_events, participant_id)],
        "tapbacks_received": [
            {"action": a, "count": c} for a, c in stats.tapbacks_received(tapback_events, participant_id)
        ],
        "sentiment_series": [{"bucket": b, "score": s} for b, s in stats.sentiment_series(sentiment_rows, "week")],
        "personality": [{"trait": t, "percentage": p} for t, p in stats.personality_rates(texts)],
    }


def get_person_message_range(conn: sqlite3.Connection, participant_id: str) -> tuple[str | None, str | None]:
    row = conn.execute(
        "SELECT MIN(timestamp) AS first_ts, MAX(timestamp) AS last_ts FROM messages WHERE sender_id = ?",
        (participant_id,),
    ).fetchone()
    return row["first_ts"], row["last_ts"]


def get_person_detail(conn: sqlite3.Connection, resolver, participant_id: str) -> dict | None:
    """Bundles everything the Person Detail page needs in one call, mirroring
    get_conversation_detail's role for Conversation Detail: a thin router just 404s on None and
    otherwise spreads this dict into the PersonDetail response model."""
    person_stats = get_person_stats(conn, resolver, participant_id)
    if person_stats is None:
        return None
    resolved = get_resolved_participant(conn, resolver, participant_id)
    conversation_count = len(get_person_conversation_ids(conn, participant_id))
    first_message_at, last_message_at = get_person_message_range(conn, participant_id)

    cells = get_dow_hour_counts(conn, "sender_id = ?", (participant_id,))
    scope = person_leaderboard_scope(participant_id)
    leaderboard = get_leaderboard(conn, resolver, {participant_id: resolved}, scope)

    return {
        "id": participant_id,
        "handle": resolved.handle,
        "display_name": resolved.display_name,
        "message_count": person_stats["message_count"],
        "conversation_count": conversation_count,
        "first_message_at": first_message_at,
        "last_message_at": last_message_at,
        "heatmap": {"grid": stats.build_heatmap_grid(cells)},
        "stats": person_stats,
        "leaderboard": leaderboard,
        "conversations": get_person_conversations(conn, resolver, participant_id),
    }
