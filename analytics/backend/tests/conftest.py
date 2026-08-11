import sqlite3

import pytest

SCHEMA = """
CREATE TABLE participants (
    id TEXT PRIMARY KEY, phone_num TEXT, email TEXT, is_me INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE conversations (
    id TEXT PRIMARY KEY, is_group_chat INTEGER NOT NULL, relationship_type TEXT NOT NULL, convo_name TEXT
);
CREATE TABLE conversation_participants (
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    participant_id TEXT NOT NULL REFERENCES participants(id),
    PRIMARY KEY (conversation_id, participant_id)
);
CREATE TABLE messages (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
    sender_id TEXT NOT NULL REFERENCES participants(id), timestamp TEXT NOT NULL, text TEXT NOT NULL,
    has_attachment INTEGER NOT NULL DEFAULT 0, has_sticker INTEGER NOT NULL DEFAULT 0, reply_to TEXT
);
CREATE TABLE tapbacks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL REFERENCES messages(id),
    reactor_id TEXT NOT NULL REFERENCES participants(id), action TEXT NOT NULL
);
CREATE TABLE announcements (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), datetime TEXT NOT NULL,
    announcer_id TEXT NOT NULL REFERENCES participants(id), action TEXT NOT NULL, affected_id TEXT
);
"""


class FakeResolver:
    def resolve(self, handle: str) -> str | None:
        return None


@pytest.fixture
def resolver():
    return FakeResolver()


@pytest.fixture
def conn():
    # check_same_thread=False: FastAPI's TestClient (Task 15's router tests)
    # runs sync endpoint functions via anyio's threadpool, on a different OS
    # thread than the one that creates this fixture. A single test's requests
    # are still handled sequentially, so sharing this connection across
    # threads is safe here even though sqlite3 disallows it by default.
    connection = sqlite3.connect(":memory:", check_same_thread=False)
    connection.row_factory = sqlite3.Row
    connection.executescript(SCHEMA)

    connection.execute("INSERT INTO participants VALUES ('me', '+15551110000', NULL, 1)")
    connection.execute("INSERT INTO participants VALUES ('them', '+15552220000', NULL, 0)")
    connection.execute("INSERT INTO conversations (id, is_group_chat, relationship_type) VALUES ('conv1', 0, 'other')")
    connection.execute("INSERT INTO conversation_participants VALUES ('conv1', 'me')")
    connection.execute("INSERT INTO conversation_participants VALUES ('conv1', 'them')")
    connection.executemany(
        "INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
            ("m1", "conv1", "me", "2024-01-01T09:00:00", "hey", 0, 0, None),
            ("m2", "conv1", "them", "2024-01-01T09:05:00", "hi there", 0, 0, None),
            ("m3", "conv1", "me", "2024-01-01T09:10:00", "what's up", 0, 0, None),
        ],
    )
    connection.execute("INSERT INTO tapbacks (message_id, reactor_id, action) VALUES ('m1', 'them', 'Liked')")
    connection.commit()
    yield connection
    connection.close()
