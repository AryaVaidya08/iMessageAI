import pytest
from fastapi.testclient import TestClient

from dependencies import get_db, get_resolver
from main import app


def make_client(conn, resolver):
    app.dependency_overrides[get_db] = lambda: conn
    app.dependency_overrides[get_resolver] = lambda: resolver
    return TestClient(app)


@pytest.fixture(autouse=True)
def _clear_dependency_overrides():
    """Safety net for `app.dependency_overrides`.

    `app` is a module-level singleton in main.py, so overriding its
    dependencies mutates shared global state. Each test below calls
    `app.dependency_overrides.clear()` itself once it's done, but if a test
    fails/raises before reaching that line, the override would otherwise leak
    into every subsequent test in the suite. This autouse fixture guarantees
    cleanup after every test regardless of outcome.
    """
    yield
    app.dependency_overrides.clear()


def test_overview_stats_endpoint(conn, resolver):
    client = make_client(conn, resolver)
    response = client.get("/api/overview")
    assert response.status_code == 200
    assert response.json()["total_messages"] == 3
    app.dependency_overrides.clear()


def test_conversation_not_found_returns_404(conn, resolver):
    client = make_client(conn, resolver)
    response = client.get("/api/conversations/does-not-exist")
    assert response.status_code == 404
    app.dependency_overrides.clear()


def test_conversation_messages_pagination(conn, resolver):
    client = make_client(conn, resolver)
    response = client.get("/api/conversations/conv1/messages?limit=2")
    assert response.status_code == 200
    body = response.json()
    assert [m["id"] for m in body["items"]] == ["m2", "m3"]
    assert body["next_cursor"] == "m2"
    app.dependency_overrides.clear()


def test_participant_stats_endpoint(conn, resolver):
    client = make_client(conn, resolver)
    response = client.get("/api/conversations/conv1/participant-stats")
    assert response.status_code == 200
    by_id = {p["participant_id"]: p for p in response.json()["participants"]}
    assert by_id["me"]["message_count"] == 2
    assert by_id["them"]["message_count"] == 1
    app.dependency_overrides.clear()


# --- Additional coverage ---


@pytest.mark.parametrize(
    "path",
    [
        "/api/conversations/does-not-exist/volume",
        "/api/conversations/does-not-exist/participant-stats",
        "/api/conversations/does-not-exist/messages",
    ],
)
def test_conversation_scoped_endpoints_404_consistently(conn, resolver, path):
    # The conversation-detail 404 case is covered above; the other three
    # conversation-scoped endpoints (volume, participant-stats, messages)
    # each independently check `get_conversation_participants_resolved` and
    # must raise the same 404 rather than crashing or returning an empty200.
    client = make_client(conn, resolver)
    response = client.get(path)
    assert response.status_code == 404


def test_conversation_volume_granularity_day_matches_daily_counts(conn, resolver):
    client = make_client(conn, resolver)
    response = client.get("/api/conversations/conv1/volume?granularity=day")
    assert response.status_code == 200
    assert response.json()["points"] == [{"bucket": "2024-01-01", "count": 3}]


def test_conversation_volume_granularity_month_buckets_by_month(conn, resolver):
    client = make_client(conn, resolver)
    response = client.get("/api/conversations/conv1/volume?granularity=month")
    assert response.status_code == 200
    assert response.json()["points"] == [{"bucket": "2024-01", "count": 3}]


def test_list_conversations_endpoint(conn, resolver):
    client = make_client(conn, resolver)
    response = client.get("/api/conversations")
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 1
    assert [c["id"] for c in body["items"]] == ["conv1"]


def test_list_conversations_search_filters_endpoint(conn, resolver):
    client = make_client(conn, resolver)
    response = client.get("/api/conversations?search=nomatch")
    assert response.status_code == 200
    body = response.json()
    assert body["items"] == []
    assert body["total"] == 0


def test_participant_stats_includes_new_fields(conn, resolver):
    client = make_client(conn, resolver)
    response = client.get("/api/conversations/conv1/participant-stats")
    assert response.status_code == 200
    by_id = {p["participant_id"]: p for p in response.json()["participants"]}
    assert isinstance(by_id["them"]["reply_histogram"], list)
    assert by_id["them"]["reply_histogram"][0]["label"] == "<1m"
    assert "gap_initiator_count" in by_id["them"]
    assert "late_night_ratio" in by_id["them"]


@pytest.mark.parametrize(
    "path",
    [
        "/api/conversations/does-not-exist/heatmap",
        "/api/conversations/does-not-exist/streak-silence",
        "/api/conversations/does-not-exist/group-size",
        "/api/conversations/does-not-exist/join-leave",
        "/api/conversations/does-not-exist/reply-graph",
    ],
)
def test_conversation_detail_addition_endpoints_404_consistently(conn, resolver, path):
    client = make_client(conn, resolver)
    response = client.get(path)
    assert response.status_code == 404


def test_conversation_heatmap_endpoint(conn, resolver):
    client = make_client(conn, resolver)
    response = client.get("/api/conversations/conv1/heatmap")
    assert response.status_code == 200
    grid = response.json()["grid"]
    assert len(grid) == 7
    assert all(len(row) == 24 for row in grid)
    assert sum(sum(row) for row in grid) == 3


def test_conversation_streak_silence_endpoint(conn, resolver):
    client = make_client(conn, resolver)
    response = client.get("/api/conversations/conv1/streak-silence")
    assert response.status_code == 200
    body = response.json()
    assert body["streak_days"] == 1
    assert body["silence_gap_seconds"] is None  # only 1 active day


def test_conversation_group_size_endpoint(conn, resolver):
    client = make_client(conn, resolver)
    response = client.get("/api/conversations/conv1/group-size")
    assert response.status_code == 200
    assert response.json()["points"] == []


def test_conversation_join_leave_endpoint(conn, resolver):
    conn.execute(
        "INSERT INTO announcements VALUES ('ann1', 'conv1', '2024-03-01T00:00:00', 'me', 'added person', 'them')"
    )
    conn.commit()
    client = make_client(conn, resolver)
    response = client.get("/api/conversations/conv1/join-leave")
    assert response.status_code == 200
    assert response.json()["items"] == [
        {"datetime": "2024-03-01T00:00:00", "kind": "joined", "display_name": "+15552220000"}
    ]


def test_conversation_reply_graph_endpoint(conn, resolver):
    conn.execute(
        "INSERT INTO messages VALUES ('m4', 'conv1', 'them', '2024-01-01T09:15:00', 'reply', 0, 0, 'm1')"
    )
    conn.commit()
    client = make_client(conn, resolver)
    response = client.get("/api/conversations/conv1/reply-graph")
    assert response.status_code == 200
    assert response.json()["edges"] == [
        {
            "replier_id": "them",
            "replier_display_name": "+15552220000",
            "original_id": "me",
            "original_display_name": "You",
            "count": 1,
        }
    ]


def test_overview_heatmap_endpoint(conn, resolver):
    client = make_client(conn, resolver)
    response = client.get("/api/overview/heatmap")
    assert response.status_code == 200
    grid = response.json()["grid"]
    assert sum(sum(row) for row in grid) == 3


def test_overview_fastest_reply_relationship_endpoint(conn, resolver):
    client = make_client(conn, resolver)
    response = client.get("/api/overview/fastest-reply-relationship")
    assert response.status_code == 200
    assert response.json()["relationship_type"] == "other"


def test_overview_fastest_reply_relationship_none_when_no_replies(conn, resolver):
    conn.execute("DELETE FROM messages")
    conn.commit()
    client = make_client(conn, resolver)
    response = client.get("/api/overview/fastest-reply-relationship")
    assert response.status_code == 200
    assert response.json() is None


def test_leaderboard_attachments_endpoint_empty(conn, resolver):
    client = make_client(conn, resolver)
    response = client.get("/api/leaderboards/attachments")
    assert response.status_code == 200
    assert response.json()["items"] == []


def test_leaderboard_most_loved_endpoint(conn, resolver):
    client = make_client(conn, resolver)
    response = client.get("/api/leaderboards/most-loved")
    assert response.status_code == 200
    items = response.json()["items"]
    assert items[0]["message_id"] == "m1"
    assert items[0]["tapback_count"] == 1


def test_leaderboard_most_argued_endpoint_empty(conn, resolver):
    client = make_client(conn, resolver)
    response = client.get("/api/leaderboards/most-argued")
    assert response.status_code == 200
    assert response.json()["items"] == []


def test_leaderboard_streak_endpoint(conn, resolver):
    client = make_client(conn, resolver)
    response = client.get("/api/leaderboards/streak")
    assert response.status_code == 200
    body = response.json()
    assert body["conversation_id"] == "conv1"
    assert body["streak_days"] == 1


def test_leaderboard_silence_endpoint_none_when_no_gaps(conn, resolver):
    client = make_client(conn, resolver)
    response = client.get("/api/leaderboards/silence")
    assert response.status_code == 200
    assert response.json() is None
