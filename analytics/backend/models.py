from pydantic import BaseModel


class StatCards(BaseModel):
    total_messages: int
    total_conversations: int
    total_participants: int
    date_range_start: str | None
    date_range_end: str | None


class VolumePoint(BaseModel):
    bucket: str
    count: int


class VolumeResponse(BaseModel):
    points: list[VolumePoint]


class TopConversationOut(BaseModel):
    conversation_id: str
    display_name: str
    message_count: int
    is_group_chat: bool


class TopConversationsResponse(BaseModel):
    items: list[TopConversationOut]


class ConversationSummary(BaseModel):
    id: str
    display_name: str
    is_group_chat: bool
    relationship_type: str
    message_count: int
    last_activity: str | None


class ConversationListResponse(BaseModel):
    items: list[ConversationSummary]
    total: int
    page: int
    page_size: int


class ParticipantOut(BaseModel):
    id: str
    handle: str
    display_name: str
    is_me: bool


class ConversationDetail(BaseModel):
    id: str
    is_group_chat: bool
    relationship_type: str
    participants: list[ParticipantOut]


class WordCount(BaseModel):
    word: str
    count: int


class EmojiCount(BaseModel):
    emoji: str
    count: int


class TapbackCount(BaseModel):
    action: str
    count: int


class HistogramBucket(BaseModel):
    label: str
    count: int


class ParticipantStats(BaseModel):
    participant_id: str
    display_name: str
    handle: str
    message_count: int
    median_reply_seconds: float | None
    reply_histogram: list[HistogramBucket]
    gap_initiator_count: int
    late_night_ratio: float
    top_words: list[WordCount]
    top_emojis: list[EmojiCount]
    tapbacks_given: list[TapbackCount]
    tapbacks_received: list[TapbackCount]


class ParticipantStatsResponse(BaseModel):
    participants: list[ParticipantStats]


class TapbackOut(BaseModel):
    reactor_id: str
    display_name: str
    action: str


class MessageOut(BaseModel):
    id: str
    sender_id: str
    sender_display_name: str
    timestamp: str
    text: str
    has_attachment: bool
    has_sticker: bool
    reply_to: str | None
    tapbacks: list[TapbackOut]


class MessagesPage(BaseModel):
    items: list[MessageOut]
    next_cursor: str | None


# --- Leaderboards ----------------------------------------------------------


class AttachmentLeaderboardEntry(BaseModel):
    participant_id: str
    display_name: str
    count: int


class AttachmentLeaderboardResponse(BaseModel):
    items: list[AttachmentLeaderboardEntry]


class MessageLeaderboardEntryBase(BaseModel):
    message_id: str
    text: str
    sender_id: str
    sender_display_name: str
    conversation_id: str
    conversation_display_name: str
    timestamp: str


class LovedMessageEntry(MessageLeaderboardEntryBase):
    tapback_count: int


class LovedMessagesResponse(BaseModel):
    items: list[LovedMessageEntry]


class ArguedMessageEntry(MessageLeaderboardEntryBase):
    reply_count: int


class ArguedMessagesResponse(BaseModel):
    items: list[ArguedMessageEntry]


class StreakLeaderboard(BaseModel):
    conversation_id: str
    conversation_display_name: str
    streak_days: int


class SilenceLeaderboard(BaseModel):
    conversation_id: str
    conversation_display_name: str
    gap_seconds: float
    before: str
    after: str


class FastestReplyRelationship(BaseModel):
    relationship_type: str
    median_reply_seconds: float


# --- Conversation detail additions -----------------------------------------


class HeatmapResponse(BaseModel):
    grid: list[list[int]]


class ConversationStreakSilence(BaseModel):
    streak_days: int
    silence_gap_seconds: float | None
    silence_before: str | None
    silence_after: str | None


class GroupSizePoint(BaseModel):
    datetime: str
    size: int


class GroupSizeResponse(BaseModel):
    points: list[GroupSizePoint]


class JoinLeaveEvent(BaseModel):
    datetime: str
    kind: str  # "joined" | "left"
    display_name: str


class JoinLeaveResponse(BaseModel):
    items: list[JoinLeaveEvent]


class ReplyGraphEdge(BaseModel):
    replier_id: str
    replier_display_name: str
    original_id: str
    original_display_name: str
    count: int


class ReplyGraphResponse(BaseModel):
    edges: list[ReplyGraphEdge]
