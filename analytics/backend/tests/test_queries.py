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
    conn.execute("INSERT INTO conversations (id, is_group_chat, relationship_type) VALUES ('conv2', 0, 'other')")
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
    conn.execute("INSERT INTO conversations (id, is_group_chat, relationship_type) VALUES ('conv2', 0, 'other')")
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


def test_get_messages_for_stats_orders_by_timestamp(conn):
    # Insert a 4th message with an EARLIER timestamp than m1, but insert it
    # LAST (after m1/m2/m3) so insertion order and timestamp order disagree.
    # This ensures the test fails if `ORDER BY ..., timestamp ASC` were ever
    # removed from get_messages_for_stats, since SQLite would otherwise
    # return rows in insertion order (m1, m2, m3, m0).
    conn.execute(
        "INSERT INTO messages VALUES ('m0', 'conv1', 'me', '2023-12-31T08:00:00', 'earliest', 0, 0, NULL)"
    )
    conn.commit()

    rows = queries.get_messages_for_stats(conn, "conversation_id = ?", ("conv1",))
    assert [r["id"] for r in rows] == ["m0", "m1", "m2", "m3"]


def test_get_messages_for_stats_sender_scope_spans_conversations(conn):
    conn.execute("INSERT INTO conversations (id, is_group_chat, relationship_type) VALUES ('conv2', 0, 'other')")
    conn.execute(
        "INSERT INTO messages VALUES ('c2m1', 'conv2', 'me', '2024-02-01T09:00:00', 'yo', 0, 0, NULL)"
    )
    conn.commit()
    rows = queries.get_messages_for_stats(conn, "sender_id = ?", ("me",))
    assert {r["id"] for r in rows} == {"m1", "m3", "c2m1"}


def test_get_tapback_events_includes_target_sender(conn):
    events = queries.get_tapback_events(conn, "conversation_id = ?", ("conv1",))
    assert len(events) == 1
    assert events[0]["reactor_id"] == "them"
    assert events[0]["action"] == "Liked"
    assert events[0]["target_sender_id"] == "me"


def test_get_conversation_day_activity_scoped_to_one_conversation(conn):
    conn.execute("INSERT INTO participants VALUES ('other', '+15553330000', NULL, 0)")
    conn.execute("INSERT INTO conversations (id, is_group_chat, relationship_type) VALUES ('conv2', 0, 'other')")
    conn.execute(
        "INSERT INTO messages VALUES ('c2m1', 'conv2', 'other', '2024-05-05T10:00:00', 'yo', 0, 0, NULL)"
    )
    conn.commit()
    days = queries.get_conversation_day_activity(conn, "conv1")
    assert [d.day for d in days] == ["2024-01-01"]


def test_get_fastest_reply_relationship_type_picks_lowest_median(conn, resolver):
    conn.execute("INSERT INTO participants VALUES ('fam', '+15554440000', NULL, 0)")
    conn.execute("INSERT INTO conversations (id, is_group_chat, relationship_type) VALUES ('conv2', 0, 'family')")
    conn.execute("INSERT INTO conversation_participants VALUES ('conv2', 'me')")
    conn.execute("INSERT INTO conversation_participants VALUES ('conv2', 'fam')")
    conn.executemany(
        "INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
            ("c2m1", "conv2", "me", "2024-02-01T09:00:00", "yo", 0, 0, None),
            ("c2m2", "conv2", "fam", "2024-02-01T09:00:10", "sup", 0, 0, None),  # 10s reply
        ],
    )
    conn.commit()
    # conv1 (relationship_type='other') has a 300s reply (m1->m2); conv2
    # (relationship_type='family') has a 10s reply -- family should win.
    result = queries.get_fastest_reply_relationship_type(conn)
    assert result["relationship_type"] == "family"
    assert result["median_reply_seconds"] == 10.0


def test_get_fastest_reply_relationship_type_no_replies_returns_none(conn):
    conn.execute("DELETE FROM messages")
    conn.commit()
    assert queries.get_fastest_reply_relationship_type(conn) is None


# --- Conversation detail additions ----------------------------------------


def test_get_dow_hour_counts(conn):
    # 2024-01-01 is a Monday -> dow=1 in SQLite's strftime('%w').
    counts = queries.get_dow_hour_counts(conn, "conversation_id = ?", ("conv1",))
    assert (1, 9, 3) in counts


def test_get_global_dow_hour_counts_matches_total_messages(conn):
    counts = queries.get_global_dow_hour_counts(conn)
    assert sum(c for _, _, c in counts) == 3


def test_get_hours_by_sender(conn):
    hours = queries.get_hours_by_sender(conn, "conversation_id = ?", ("conv1",))
    assert sorted(hours) == [("me", 9), ("me", 9), ("them", 9)]


def test_get_conversation_membership_events_filters_and_orders(conn):
    conn.executemany(
        "INSERT INTO announcements VALUES (?, ?, ?, ?, ?, ?)",
        [
            ("ann1", "conv1", "2024-03-01T00:00:00", "me", "renamed convo", None),
            ("ann2", "conv1", "2024-03-02T00:00:00", "me", "added person", "them"),
            ("ann3", "conv1", "2024-03-03T00:00:00", "them", "left convo", None),
        ],
    )
    conn.commit()
    events = queries.get_conversation_membership_events(conn, "conv1")
    assert [r["action"] for r in events] == ["added person", "left convo"]


def test_get_conversation_group_size_series_ends_at_current_size(conn):
    conn.execute(
        "INSERT INTO announcements VALUES ('ann1', 'conv1', '2024-03-01T00:00:00', 'me', 'added person', 'them')"
    )
    conn.commit()
    series = queries.get_conversation_group_size_series(conn, "conv1")
    assert series[-1][1] == 2  # current_size == 2 (me + them in conversation_participants)


def test_get_conversation_join_leave_events_resolves_names(conn, resolver):
    conn.execute(
        "INSERT INTO announcements VALUES ('ann1', 'conv1', '2024-03-01T00:00:00', 'me', 'added person', 'them')"
    )
    conn.commit()
    events = queries.get_conversation_join_leave_events(conn, resolver, "conv1")
    assert events == [{"datetime": "2024-03-01T00:00:00", "kind": "joined", "display_name": "+15552220000"}]


def test_get_conversation_reply_edges_and_graph(conn, resolver):
    conn.execute(
        "INSERT INTO messages VALUES ('m4', 'conv1', 'them', '2024-01-01T09:15:00', 'reply', 0, 0, 'm1')"
    )
    conn.commit()
    edges = queries.get_conversation_reply_edges(conn, "conv1")
    assert edges == [("them", "me")]

    graph = queries.get_conversation_reply_graph(conn, resolver, "conv1")
    assert graph == [
        {
            "replier_id": "them",
            "replier_display_name": "+15552220000",
            "original_id": "me",
            "original_display_name": "You",
            "count": 1,
        }
    ]


def test_get_conversation_leaderboard(conn, resolver):
    conn.execute(
        "INSERT INTO messages VALUES ('m4', 'conv1', 'them', '2024-01-01T09:15:00', "
        "'I fucking hate this so much!!!', 0, 0, 'm1')"
    )
    conn.execute("INSERT INTO tapbacks (message_id, reactor_id, action) VALUES ('m2', 'me', 'Loved')")
    conn.execute(
        "INSERT INTO announcements VALUES ('ann1', 'conv1', '2024-02-01T00:00:00', 'me', 'renamed convo', NULL)"
    )
    conn.execute(
        "INSERT INTO announcements VALUES ('ann2', 'conv1', '2024-02-02T00:00:00', 'me', 'renamed convo', NULL)"
    )
    conn.execute(
        "INSERT INTO announcements VALUES ('ann3', 'conv1', '2024-02-03T00:00:00', 'them', 'unsent message', NULL)"
    )
    conn.commit()

    participants = queries.get_conversation_participants_resolved(conn, resolver, "conv1")
    scope = queries.conversation_leaderboard_scope("conv1")
    result = queries.get_leaderboard(conn, resolver, participants, scope)

    assert result["most_argued_message"]["message_id"] == "m1"
    assert result["most_argued_message"]["value"] == 1
    assert result["most_loved_message"]["message_id"] == "m2"
    assert result["longest_message"]["message_id"] == "m4"
    assert result["most_aggressive_message"]["message_id"] == "m4"
    assert result["top_renamer"] == {"participant_id": "me", "display_name": "You", "count": 2}
    assert result["top_unsender"] == {"participant_id": "them", "display_name": "+15552220000", "count": 1}
    assert result["top_photo_changer"] is None
    assert result["most_revolving_door"] is None


def test_get_leaderboard_person_scope_counts_own_totals_only(conn, resolver):
    # Person scope: "them" sent m2 which got a Loved tapback from "me"; "them"'s
    # message m1-reply below gets 1 reply; "them" renamed the group once and "me"
    # renamed it twice -- person scope for "them" should only see their own
    # messages/announcements, not "me"'s.
    conn.execute(
        "INSERT INTO messages VALUES ('m4', 'conv1', 'them', '2024-01-01T09:15:00', 'reply to hey', 0, 0, 'm1')"
    )
    conn.execute("INSERT INTO tapbacks (message_id, reactor_id, action) VALUES ('m2', 'me', 'Loved')")
    conn.execute(
        "INSERT INTO announcements VALUES ('ann1', 'conv1', '2024-02-01T00:00:00', 'me', 'renamed convo', NULL)"
    )
    conn.execute(
        "INSERT INTO announcements VALUES ('ann2', 'conv1', '2024-02-02T00:00:00', 'them', 'renamed convo', NULL)"
    )
    conn.commit()

    participants = {"them": queries.get_conversation_participants_resolved(conn, resolver, "conv1")["them"]}
    scope = queries.person_leaderboard_scope("them")
    result = queries.get_leaderboard(conn, resolver, participants, scope)

    assert result["most_loved_message"]["message_id"] == "m2"
    assert result["most_loved_message"]["sender_id"] == "them"
    assert result["top_renamer"] == {"participant_id": "them", "display_name": "+15552220000", "count": 1}


# --- People --------------------------------------------------------------


def test_get_all_participants_with_stats_includes_me(conn):
    rows = queries.get_all_participants_with_stats(conn)
    assert {r["id"] for r in rows} == {"me", "them"}
    by_id = {r["id"]: r for r in rows}
    assert bool(by_id["me"]["is_me"]) is True
    assert bool(by_id["them"]["is_me"]) is False


def test_get_all_participants_with_stats_counts_and_range(conn):
    by_id = {r["id"]: r for r in queries.get_all_participants_with_stats(conn)}
    assert by_id["them"]["message_count"] == 1  # "them" only sent m2
    assert by_id["them"]["conversation_count"] == 1
    assert by_id["them"]["first_message"] == "2024-01-01T09:05:00"
    assert by_id["them"]["last_message"] == "2024-01-01T09:05:00"
    assert by_id["me"]["message_count"] == 2  # "me" sent m1 and m3


def test_get_all_participants_with_stats_zero_messages_still_appears(conn, resolver):
    conn.execute("INSERT INTO participants VALUES ('lurker', '+15559990000', NULL, 0)")
    conn.commit()
    by_id = {r["id"]: r for r in queries.get_all_participants_with_stats(conn)}
    assert by_id["lurker"]["message_count"] == 0
    assert by_id["lurker"]["conversation_count"] == 0
    assert by_id["lurker"]["first_message"] is None


def test_get_resolved_participant_unknown_returns_none(conn, resolver):
    assert queries.get_resolved_participant(conn, resolver, "nope") is None


def test_get_resolved_participant_returns_handle(conn, resolver):
    resolved = queries.get_resolved_participant(conn, resolver, "them")
    assert resolved.display_name == "+15552220000"


def test_get_person_conversation_ids(conn):
    assert queries.get_person_conversation_ids(conn, "them") == ["conv1"]
    assert queries.get_person_conversation_ids(conn, "nope") == []


def test_get_person_conversations_shape(conn, resolver):
    items = queries.get_person_conversations(conn, resolver, "them")
    assert len(items) == 1
    assert items[0]["conversation_id"] == "conv1"
    assert items[0]["message_count"] == 3  # conv1's total, not just "them"'s messages
    assert items[0]["relationship_type"] == "other"
    assert items[0]["is_group_chat"] is False


def test_get_person_conversations_empty_for_unknown_person(conn, resolver):
    assert queries.get_person_conversations(conn, resolver, "nope") == []


def test_get_person_reply_stats_basic(conn):
    # m2 (them, 09:05) replies to m1 (me, 09:00) after 300s; m3 (me, 09:10) replies
    # to m2 after 300s -- "them" has exactly one qualifying reply, of 300s.
    result = queries.get_person_reply_stats(conn, "them")
    assert result["median_reply_seconds"] == 300.0
    # 300s falls in "5-30m" (bucket upper bounds are exclusive; 1-5m's upper bound is exactly 300).
    assert dict(result["reply_histogram"])["5-30m"] == 1


def test_get_person_reply_stats_not_contaminated_across_conversations(conn):
    # conv2's first message ("fam", far later) must not be treated as a "reply" to
    # conv1's last message just because it comes right after it in a naive
    # timestamp-only ordering.
    conn.execute("INSERT INTO participants VALUES ('fam', '+15554440000', NULL, 0)")
    conn.execute("INSERT INTO conversations (id, is_group_chat, relationship_type) VALUES ('conv2', 0, 'family')")
    conn.execute("INSERT INTO conversation_participants VALUES ('conv2', 'me')")
    conn.execute("INSERT INTO conversation_participants VALUES ('conv2', 'fam')")
    conn.execute(
        "INSERT INTO messages VALUES ('c2m1', 'conv2', 'fam', '2024-01-01T09:10:05', 'hi', 0, 0, NULL)"
    )
    conn.commit()
    result = queries.get_person_reply_stats(conn, "fam")
    assert result["median_reply_seconds"] is None  # "fam" sent the very first message in conv2


def test_get_person_stats_unknown_returns_none(conn, resolver):
    assert queries.get_person_stats(conn, resolver, "nope") is None


def test_get_person_stats_basic(conn, resolver):
    result = queries.get_person_stats(conn, resolver, "them")
    assert result["participant_id"] == "them"
    assert result["display_name"] == "+15552220000"
    assert result["message_count"] == 1
    assert result["median_reply_seconds"] == 300.0
    # tapback fixture is ('m1', 'them', 'Liked') -- "them" reacted to "me"'s message m1,
    # so it's "them"'s given tapback, not one they received.
    assert result["tapbacks_given"] == [{"action": "Liked", "count": 1}]
    assert result["tapbacks_received"] == []
