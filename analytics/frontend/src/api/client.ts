export type Granularity = "day" | "week" | "month";

export interface StatCards {
  total_messages: number;
  total_conversations: number;
  total_participants: number;
  date_range_start: string | null;
  date_range_end: string | null;
}

export interface VolumePoint {
  bucket: string;
  count: number;
}

export interface VolumeResponse {
  points: VolumePoint[];
}

export interface TopConversationOut {
  conversation_id: string;
  display_name: string;
  message_count: number;
  is_group_chat: boolean;
}

export interface TopConversationsResponse {
  items: TopConversationOut[];
}

export interface ConversationSummary {
  id: string;
  display_name: string;
  is_group_chat: boolean;
  relationship_type: string;
  message_count: number;
  last_activity: string | null;
}

export interface ConversationListResponse {
  items: ConversationSummary[];
  total: number;
  page: number;
  page_size: number;
}

export interface ParticipantOut {
  id: string;
  handle: string;
  display_name: string;
  is_me: boolean;
}

export interface ConversationDetail {
  id: string;
  is_group_chat: boolean;
  relationship_type: string;
  participants: ParticipantOut[];
}

export interface WordCount { word: string; count: number; }
export interface EmojiCount { emoji: string; count: number; }
export interface TapbackCount { action: string; count: number; }
export interface HistogramBucket { label: string; count: number; }

export interface SentimentPoint {
  bucket: string;
  score: number;
}

export interface PersonalityTrait {
  trait: string;
  percentage: number;
}

export interface ParticipantStats {
  participant_id: string;
  display_name: string;
  handle: string;
  message_count: number;
  median_reply_seconds: number | null;
  reply_histogram: HistogramBucket[];
  gap_initiator_count: number;
  late_night_ratio: number;
  top_words: WordCount[];
  top_emojis: EmojiCount[];
  tapbacks_given: TapbackCount[];
  tapbacks_received: TapbackCount[];
  sentiment_series: SentimentPoint[];
  personality: PersonalityTrait[];
}

export interface ParticipantStatsResponse {
  participants: ParticipantStats[];
}

export interface TapbackOut {
  reactor_id: string;
  display_name: string;
  action: string;
}

export interface MessageOut {
  id: string;
  sender_id: string;
  sender_display_name: string;
  timestamp: string;
  text: string;
  has_attachment: boolean;
  has_sticker: boolean;
  reply_to: string | null;
  tapbacks: TapbackOut[];
}

export interface MessagesPage {
  items: MessageOut[];
  older_cursor: string | null;
  newer_cursor: string | null;
}

export interface SearchMessageResult {
  id: string;
  timestamp: string;
  text: string;
}

export interface SearchMessagesResponse {
  items: SearchMessageResult[];
}

// --- Leaderboards ---

export interface AttachmentLeaderboardEntry {
  participant_id: string;
  display_name: string;
  count: number;
}

export interface AttachmentLeaderboardResponse {
  items: AttachmentLeaderboardEntry[];
}

export interface MessageLeaderboardEntryBase {
  message_id: string;
  text: string;
  sender_id: string;
  sender_display_name: string;
  conversation_id: string;
  conversation_display_name: string;
  timestamp: string;
}

export interface LovedMessageEntry extends MessageLeaderboardEntryBase {
  tapback_count: number;
}

export interface LovedMessagesResponse {
  items: LovedMessageEntry[];
}

export interface ArguedMessageEntry extends MessageLeaderboardEntryBase {
  reply_count: number;
}

export interface ArguedMessagesResponse {
  items: ArguedMessageEntry[];
}

export interface StreakLeaderboard {
  conversation_id: string;
  conversation_display_name: string;
  streak_days: number;
}

export interface SilenceLeaderboard {
  conversation_id: string;
  conversation_display_name: string;
  gap_seconds: number;
  before: string;
  after: string;
}

export interface FastestReplyRelationship {
  relationship_type: string;
  median_reply_seconds: number;
}

// --- Conversation detail additions ---

export interface HeatmapResponse {
  grid: number[][]; // 7 rows (day of week, 0=Sunday) x 24 cols (hour)
}

export interface ConversationStreakSilence {
  streak_days: number;
  silence_gap_seconds: number | null;
  silence_before: string | null;
  silence_after: string | null;
}

export interface JoinLeaveEvent {
  datetime: string;
  kind: "joined" | "left";
  display_name: string;
}

export interface JoinLeaveResponse {
  items: JoinLeaveEvent[];
}

export interface ReplyGraphEdge {
  replier_id: string;
  replier_display_name: string;
  original_id: string;
  original_display_name: string;
  count: number;
}

export interface ReplyGraphResponse {
  edges: ReplyGraphEdge[];
}

// --- Contact merge ---

export interface MergeParticipantOut {
  id: string;
  phone_num: string | null;
  email: string | null;
  handle: string;
  display_name: string;
  is_me: boolean;
}

export interface MergeParticipantsResponse {
  participants: MergeParticipantOut[];
}

export interface MergeResponse {
  ok: boolean;
  keep_id: string;
  removed_id: string;
}

export interface MergeHistoryEntry {
  merged_at: string;
  keep_id: string;
  keep_display_name: string;
  keep_handle: string;
  remove_id: string;
  remove_display_name: string;
  remove_handle: string;
}

export interface MergeHistoryResponse {
  items: MergeHistoryEntry[];
}

const BASE_URL = "http://localhost:8000";

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (typeof body?.detail === "string") {
        detail = body.detail;
      }
    } catch {
      // response body wasn't JSON (or was empty) -- fall back to statusText
    }
    throw new Error(`${res.status} ${detail}`);
  }
  return res.json() as Promise<T>;
}

async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const responseBody = await res.json();
      if (typeof responseBody?.detail === "string") {
        detail = responseBody.detail;
      }
    } catch {
      // response body wasn't JSON (or was empty) -- fall back to statusText
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export const api = {
  overviewStats: () => getJSON<StatCards>("/api/overview"),

  overviewVolume: (granularity: Granularity) =>
    getJSON<VolumeResponse>(`/api/overview/volume?granularity=${granularity}`),

  topConversations: (limit = 10) =>
    getJSON<TopConversationsResponse>(`/api/overview/top-conversations?limit=${limit}`),

  conversations: (params: { search?: string; sort?: "count" | "recent"; page?: number; page_size?: number }) => {
    const qs = new URLSearchParams();
    if (params.search) qs.set("search", params.search);
    if (params.sort) qs.set("sort", params.sort);
    qs.set("page", String(params.page ?? 1));
    qs.set("page_size", String(params.page_size ?? 25));
    return getJSON<ConversationListResponse>(`/api/conversations?${qs.toString()}`);
  },

  conversation: (id: string) => getJSON<ConversationDetail>(`/api/conversations/${id}`),

  conversationVolume: (id: string, granularity: Granularity) =>
    getJSON<VolumeResponse>(`/api/conversations/${id}/volume?granularity=${granularity}`),

  participantStats: (id: string) =>
    getJSON<ParticipantStatsResponse>(`/api/conversations/${id}/participant-stats`),

  messages: (id: string, before?: string, limit = 50) => {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (before) qs.set("before", before);
    return getJSON<MessagesPage>(`/api/conversations/${id}/messages?${qs.toString()}`);
  },

  messagesAfter: (id: string, after: string, limit = 50) => {
    const qs = new URLSearchParams({ after, limit: String(limit) });
    return getJSON<MessagesPage>(`/api/conversations/${id}/messages?${qs.toString()}`);
  },

  messagesForDate: (id: string, date: string, limit = 60) => {
    const qs = new URLSearchParams({ date, limit: String(limit) });
    return getJSON<MessagesPage>(`/api/conversations/${id}/messages?${qs.toString()}`);
  },

  messagesAround: (id: string, around: string, limit = 60) => {
    const qs = new URLSearchParams({ around, limit: String(limit) });
    return getJSON<MessagesPage>(`/api/conversations/${id}/messages?${qs.toString()}`);
  },

  searchMessages: (id: string, q: string, limit = 20) => {
    const qs = new URLSearchParams({ q, limit: String(limit) });
    return getJSON<SearchMessagesResponse>(`/api/conversations/${id}/messages/search?${qs.toString()}`);
  },

  overviewHeatmap: () => getJSON<HeatmapResponse>("/api/overview/heatmap"),

  overviewFastestReplyRelationship: () =>
    getJSON<FastestReplyRelationship | null>("/api/overview/fastest-reply-relationship"),

  conversationHeatmap: (id: string) => getJSON<HeatmapResponse>(`/api/conversations/${id}/heatmap`),

  conversationStreakSilence: (id: string) =>
    getJSON<ConversationStreakSilence>(`/api/conversations/${id}/streak-silence`),

  conversationJoinLeave: (id: string) => getJSON<JoinLeaveResponse>(`/api/conversations/${id}/join-leave`),

  conversationReplyGraph: (id: string) => getJSON<ReplyGraphResponse>(`/api/conversations/${id}/reply-graph`),

  leaderboardAttachments: (limit = 10) =>
    getJSON<AttachmentLeaderboardResponse>(`/api/leaderboards/attachments?limit=${limit}`),

  leaderboardMostLoved: (limit = 10) =>
    getJSON<LovedMessagesResponse>(`/api/leaderboards/most-loved?limit=${limit}`),

  leaderboardMostArgued: (limit = 10) =>
    getJSON<ArguedMessagesResponse>(`/api/leaderboards/most-argued?limit=${limit}`),

  leaderboardStreak: () => getJSON<StreakLeaderboard | null>("/api/leaderboards/streak"),

  leaderboardSilence: () => getJSON<SilenceLeaderboard | null>("/api/leaderboards/silence"),

  participants: () => getJSON<MergeParticipantsResponse>("/api/participants"),

  mergeContacts: (keepId: string, removeId: string) =>
    postJSON<MergeResponse>("/api/merge", { keep_id: keepId, remove_id: removeId }),

  mergeHistory: () => getJSON<MergeHistoryResponse>("/api/merge-history"),
};
