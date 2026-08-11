from services import queries


def test_get_overview_stats(conn):
    stats = queries.get_overview_stats(conn)
    assert stats["total_messages"] == 3
    assert stats["total_conversations"] == 1
    assert stats["total_participants"] == 2
    assert stats["date_range_start"] == "2024-01-01T09:00:00"
    assert stats["date_range_end"] == "2024-01-01T09:10:00"


def test_get_daily_message_counts(conn):
    assert queries.get_daily_message_counts(conn) == [("2024-01-01", 3)]


def test_list_conversations_resolves_display_name(conn, resolver):
    result = queries.list_conversations(conn, resolver, search=None, sort="recent", page=1, page_size=25)
    assert result["total"] == 1
    assert result["items"][0]["display_name"] == "You, +15552220000"


def test_list_conversations_search_filters(conn, resolver):
    result = queries.list_conversations(conn, resolver, search="nomatch", sort="recent", page=1, page_size=25)
    assert result["items"] == []
    assert result["total"] == 0


def test_get_conversation_detail_unknown_id_returns_none(conn, resolver):
    assert queries.get_conversation_detail(conn, resolver, "nope") is None


def test_get_conversation_detail_returns_participants(conn, resolver):
    detail = queries.get_conversation_detail(conn, resolver, "conv1")
    assert detail["id"] == "conv1"
    assert {p["id"] for p in detail["participants"]} == {"me", "them"}


def test_get_messages_page_first_page_ascending(conn):
    rows = queries.get_messages_page(conn, "conv1", before=None, limit=50)
    assert [r["id"] for r in rows] == ["m1", "m2", "m3"]


def test_get_messages_page_before_cursor(conn):
    rows = queries.get_messages_page(conn, "conv1", before="m3", limit=50)
    assert [r["id"] for r in rows] == ["m1", "m2"]


def test_get_tapbacks_for_messages(conn, resolver):
    participants = queries.get_conversation_participants_resolved(conn, resolver, "conv1")
    tapbacks = queries.get_tapbacks_for_messages(conn, ["m1", "m2"], participants)
    assert tapbacks["m1"][0]["action"] == "Liked"
    assert tapbacks["m1"][0]["display_name"] == "+15552220000"
    assert "m2" not in tapbacks


# --- Regression tests for bugs found and fixed during Task 9 ---


def test_get_messages_page_before_cursor_scoped_to_conversation(conn):
    # Regression test: a `before` cursor id from a DIFFERENT conversation must
    # not leak that other conversation's timeline into this page. The cursor
    # lookup is scoped by `AND conversation_id = ?`, so an id that belongs to
    # another conversation should be treated as if no cursor were given at
    # all (i.e. fall back to conv2's actual first page), not silently borrow
    # conv1's ordering/messages.
    conn.execute("INSERT INTO participants VALUES ('other', '+15553330000', NULL, 0)")
    conn.execute("INSERT INTO conversations VALUES ('conv2', 0, 'other')")
    conn.execute("INSERT INTO conversation_participants VALUES ('conv2', 'me')")
    conn.execute("INSERT INTO conversation_participants VALUES ('conv2', 'other')")
    conn.executemany(
        "INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
            ("c2m1", "conv2", "me", "2024-02-01T09:00:00", "yo", 0, 0, None),
            ("c2m2", "conv2", "other", "2024-02-01T09:05:00", "sup", 0, 0, None),
        ],
    )
    conn.commit()

    # "m3" belongs to conv1, not conv2 — querying conv2 with this cursor
    # must not return conv1's data, nor crash.
    rows = queries.get_messages_page(conn, "conv2", before="m3", limit=50)
    ids = [r["id"] for r in rows]
    assert "m1" not in ids
    assert "m2" not in ids
    assert "m3" not in ids
    assert ids == ["c2m1", "c2m2"]


def test_get_messages_page_same_timestamp_no_loss_or_duplication_across_pages(conn):
    # Regression test: messages sharing an identical timestamp must not be
    # silently dropped at a page boundary. Insert two more messages at the
    # exact same timestamp as m3 ("2024-01-01T09:10:00"), then paginate with
    # a small limit that lands a page boundary in the middle of that
    # timestamp group.
    conn.executemany(
        "INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
            ("m4", "conv1", "them", "2024-01-01T09:10:00", "same time as m3 (a)", 0, 0, None),
            ("m5", "conv1", "me", "2024-01-01T09:10:00", "same time as m3 (b)", 0, 0, None),
        ],
    )
    conn.commit()

    # Full set is m1..m5, with m3/m4/m5 sharing a timestamp. The tie is
    # broken by id (DESC on the way out, then reversed), so ascending order
    # is m1, m2, m3, m4, m5.
    all_rows = queries.get_messages_page(conn, "conv1", before=None, limit=50)
    assert [r["id"] for r in all_rows] == ["m1", "m2", "m3", "m4", "m5"]

    # Paginate with limit=2, using keyset pagination (oldest visible id as
    # the next `before` cursor), landing boundaries inside the timestamp
    # group, and confirm every message is recovered exactly once.
    collected: list[str] = []
    before = None
    pages = 0
    while True:
        pages += 1
        assert pages <= 20, "pagination did not terminate -- possible cursor regression"
        page = queries.get_messages_page(conn, "conv1", before=before, limit=2)
        if not page:
            break
        ids = [r["id"] for r in page]
        collected = ids + collected
        before = ids[0]

    assert collected == ["m1", "m2", "m3", "m4", "m5"]
    assert len(collected) == len(set(collected))


# --- Additional coverage for previously untested query functions ---


def test_get_top_conversations_ranks_by_message_count(conn, resolver):
    conn.execute("INSERT INTO participants VALUES ('other', '+15553330000', NULL, 0)")
    conn.execute("INSERT INTO conversations VALUES ('conv2', 0, 'other')")
    conn.execute("INSERT INTO conversation_participants VALUES ('conv2', 'me')")
    conn.execute("INSERT INTO conversation_participants VALUES ('conv2', 'other')")
    conn.execute(
        "INSERT INTO messages VALUES ('c2m1', 'conv2', 'me', '2024-02-01T09:00:00', 'yo', 0, 0, NULL)"
    )
    conn.commit()

    result = queries.get_top_conversations(conn, resolver, limit=5)
    assert [r["conversation_id"] for r in result] == ["conv1", "conv2"]
    assert result[0]["message_count"] == 3
    assert result[1]["message_count"] == 1


def test_get_conversation_messages_for_stats_orders_by_timestamp(conn):
    # Insert a 4th message with an EARLIER timestamp than m1, but insert it
    # LAST (after m1/m2/m3) so insertion order and timestamp order disagree.
    # This ensures the test fails if `ORDER BY timestamp ASC` were ever
    # removed from get_conversation_messages_for_stats, since SQLite would
    # otherwise return rows in insertion order (m1, m2, m3, m0).
    conn.execute(
        "INSERT INTO messages VALUES ('m0', 'conv1', 'me', '2023-12-31T08:00:00', 'earliest', 0, 0, NULL)"
    )
    conn.commit()

    rows = queries.get_conversation_messages_for_stats(conn, "conv1")
    assert [r["id"] for r in rows] == ["m0", "m1", "m2", "m3"]


def test_get_conversation_tapback_events_includes_target_sender(conn):
    events = queries.get_conversation_tapback_events(conn, "conv1")
    assert len(events) == 1
    assert events[0]["reactor_id"] == "them"
    assert events[0]["action"] == "Liked"
    assert events[0]["target_sender_id"] == "me"
