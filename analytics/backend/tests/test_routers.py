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
