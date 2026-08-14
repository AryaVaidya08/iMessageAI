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
    display_name: str
    is_group_chat: bool
    relationship_type: str
    participants: list[ParticipantOut]
    message_count: int
    first_message_at: str | None
    last_message_at: str | None


# Mirrors backend/modules/relationship.py's RelationshipType values -- kept as a
# plain list here since analytics/backend is a separately deployed app that
# doesn't import from backend/.
RELATIONSHIP_TYPES = [
    "sigother",
    "parent",
    "close_family",
    "family",
    "close_friend",
    "friend",
    "classmate",
    "professor",
    "coworker",
    "boss",
    "other",
]


class UpdateRelationshipTypeRequest(BaseModel):
    relationship_type: str


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


class SentimentPoint(BaseModel):
    bucket: str
    score: float


class PersonalityTrait(BaseModel):
    trait: str
    percentage: float


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
    sentiment_series: list[SentimentPoint]
    personality: list[PersonalityTrait]


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
    older_cursor: str | None
    newer_cursor: str | None


class SearchMessageResult(BaseModel):
    id: str
    timestamp: str
    text: str


class SearchMessagesResponse(BaseModel):
    items: list[SearchMessageResult]


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


class LeaderboardMessageEntry(BaseModel):
    message_id: str
    sender_id: str
    sender_display_name: str
    timestamp: str
    text: str
    value: float


class LeaderboardParticipantEntry(BaseModel):
    participant_id: str
    display_name: str
    count: int


class ConversationLeaderboard(BaseModel):
    longest_message: LeaderboardMessageEntry | None
    most_argued_message: LeaderboardMessageEntry | None
    most_loved_message: LeaderboardMessageEntry | None
    most_laughed_message: LeaderboardMessageEntry | None
    most_disliked_message: LeaderboardMessageEntry | None
    most_reacted_message: LeaderboardMessageEntry | None
    most_aggressive_message: LeaderboardMessageEntry | None
    happiest_message: LeaderboardMessageEntry | None
    most_emoji_message: LeaderboardMessageEntry | None
    late_night_message: LeaderboardMessageEntry | None
    fastest_reply_message: LeaderboardMessageEntry | None
    top_renamer: LeaderboardParticipantEntry | None
    top_photo_changer: LeaderboardParticipantEntry | None
    top_unsender: LeaderboardParticipantEntry | None
    most_revolving_door: LeaderboardParticipantEntry | None


class PersonalityLeaderboardEntry(BaseModel):
    participant_id: str
    display_name: str
    message_count: int
    share: float


class PersonalityLeaderboardTrait(BaseModel):
    trait: str
    entries: list[PersonalityLeaderboardEntry]


class PersonalityLeaderboardResponse(BaseModel):
    traits: list[PersonalityLeaderboardTrait]


# --- People --------------------------------------------------------------


class PersonOut(BaseModel):
    id: str
    handle: str
    display_name: str


class PersonSummary(BaseModel):
    id: str
    handle: str
    display_name: str
    message_count: int
    conversation_count: int
    last_message_at: str | None


class PeopleListResponse(BaseModel):
    items: list[PersonSummary]
    total: int
    page: int
    page_size: int


class PersonConversationOut(BaseModel):
    conversation_id: str
    display_name: str
    relationship_type: str
    is_group_chat: bool
    message_count: int


class PersonConversationsResponse(BaseModel):
    items: list[PersonConversationOut]


class PersonDetail(BaseModel):
    id: str
    handle: str
    display_name: str
    message_count: int
    conversation_count: int
    first_message_at: str | None
    last_message_at: str | None
    heatmap: HeatmapResponse
    stats: ParticipantStats
    leaderboard: ConversationLeaderboard
    conversations: list[PersonConversationOut]


# --- Contact merge -----------------------------------------------------


class MergeParticipantOut(BaseModel):
    id: str
    phone_num: str | None
    email: str | None
    handle: str
    display_name: str
    is_me: bool


class MergeParticipantsResponse(BaseModel):
    participants: list[MergeParticipantOut]


class MergeRequest(BaseModel):
    keep_id: str
    remove_id: str


class MergeResponse(BaseModel):
    ok: bool
    keep_id: str
    removed_id: str


class MergeHistoryEntry(BaseModel):
    merged_at: str
    keep_id: str
    keep_display_name: str
    keep_handle: str
    keep_message_count: int
    remove_id: str
    remove_display_name: str
    remove_handle: str
    remove_message_count: int


class MergeHistoryResponse(BaseModel):
    items: list[MergeHistoryEntry]


# --- Conversation merge -------------------------------------------------


class MergeConversationOut(BaseModel):
    id: str
    display_name: str
    subtext: str
    is_group_chat: bool
    message_count: int


class MergeConversationsResponse(BaseModel):
    conversations: list[MergeConversationOut]


class MergeConversationRequest(BaseModel):
    keep_id: str
    remove_id: str


class MergeConversationResponse(BaseModel):
    ok: bool
    keep_id: str
    removed_id: str


class MergeConversationHistoryEntry(BaseModel):
    merged_at: str
    keep_id: str
    keep_display_name: str
    keep_message_count: int
    remove_id: str
    remove_display_name: str
    remove_message_count: int


class MergeConversationHistoryResponse(BaseModel):
    items: list[MergeConversationHistoryEntry]
