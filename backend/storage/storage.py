import sqlite3

from backend.modules import Announcement, Conversation, Message, Participant, Tapback


def save_participant(conn: sqlite3.Connection, participant: Participant) -> None:
    conn.execute(
        """
        INSERT INTO participants (id, phone_num, email, is_me)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            phone_num = excluded.phone_num,
            email = excluded.email,
            is_me = excluded.is_me
        """,
        (str(participant.id), participant.phone_num, participant.email, int(participant.is_me)),
    )


def save_tapback(conn: sqlite3.Connection, message_id: str, tapback: Tapback) -> None:
    conn.execute(
        """
        INSERT OR IGNORE INTO tapbacks (message_id, reactor_id, action)
        VALUES (?, ?, ?)
        """,
        (message_id, str(tapback.reactor_id), tapback.action),
    )


def save_message(conn: sqlite3.Connection, conversation_id: str, message: Message) -> None:
    conn.execute(
        """
        INSERT INTO messages
            (id, conversation_id, sender_id, timestamp, text, has_attachment, has_sticker, reply_to)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            conversation_id = excluded.conversation_id,
            sender_id = excluded.sender_id,
            timestamp = excluded.timestamp,
            text = excluded.text,
            has_attachment = excluded.has_attachment,
            has_sticker = excluded.has_sticker,
            reply_to = excluded.reply_to
        """,
        (
            message.id,
            conversation_id,
            str(message.sender_id),
            message.timestamp.isoformat(),
            message.text,
            int(message.has_attachment),
            int(message.has_sticker),
            message.reply_to,
        ),
    )

    for tapback in message.tapbacks:
        save_tapback(conn, message.id, tapback)


def save_announcement(conn: sqlite3.Connection, conversation_id: str, announcement: Announcement) -> None:
    conn.execute(
        """
        INSERT INTO announcements (id, conversation_id, datetime, announcer_id, action, affected_id)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            conversation_id = excluded.conversation_id,
            datetime = excluded.datetime,
            announcer_id = excluded.announcer_id,
            action = excluded.action,
            affected_id = excluded.affected_id
        """,
        (
            str(announcement.annoucement_id),
            conversation_id,
            announcement.datetime.isoformat(),
            str(announcement.announcer_id),
            announcement.action,
            str(announcement.affected_id) if announcement.affected_id is not None else None,
        ),
    )


def save_conversation(conn: sqlite3.Connection, conversation: Conversation) -> None:
    with conn:  # context manager: commits on success, rolls back on exception
        for participant in conversation.participants:
            save_participant(conn, participant)

        conn.execute(
            """
            INSERT INTO conversations (id, is_group_chat, relationship_type, convo_name)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                is_group_chat = excluded.is_group_chat,
                relationship_type = excluded.relationship_type,
                convo_name = excluded.convo_name
            """,
            (
                conversation.id,
                int(conversation.is_group_chat),
                conversation.relationship_type.value,
                conversation.convo_name,
            ),
        )

        for participant in conversation.participants:
            conn.execute(
                """
                INSERT OR IGNORE INTO conversation_participants (conversation_id, participant_id)
                VALUES (?, ?)
                """,
                (conversation.id, str(participant.id)),
            )

        for message in conversation.messages:
            save_message(conn, conversation.id, message)

        for announcement in conversation.announcements:
            save_announcement(conn, conversation.id, announcement)