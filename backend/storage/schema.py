import sqlite3

SCHEMA = """
CREATE TABLE IF NOT EXISTS participants (
    id TEXT PRIMARY KEY,
    phone_num TEXT,
    email TEXT,
    is_me INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    is_group_chat INTEGER NOT NULL,
    relationship_type TEXT NOT NULL,
    convo_name TEXT
);

CREATE TABLE IF NOT EXISTS conversation_participants (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    PRIMARY KEY (conversation_id, participant_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES participants(id),
    timestamp TEXT NOT NULL,
    text TEXT NOT NULL,
    has_attachment INTEGER NOT NULL DEFAULT 0,
    has_sticker INTEGER NOT NULL DEFAULT 0,
    reply_to TEXT
);

CREATE TABLE IF NOT EXISTS tapbacks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    reactor_id TEXT NOT NULL REFERENCES participants(id),
    action TEXT NOT NULL,
    UNIQUE(message_id, reactor_id, action)
);

CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    datetime TEXT NOT NULL,
    announcer_id TEXT NOT NULL REFERENCES participants(id),
    action TEXT NOT NULL,
    affected_id TEXT REFERENCES participants(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to);
CREATE INDEX IF NOT EXISTS idx_tapbacks_message ON tapbacks(message_id);
CREATE INDEX IF NOT EXISTS idx_announcements_conversation ON announcements(conversation_id);
"""


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    conn.commit()