import { query } from "../engine/engineClient";

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
  display_name: string;
  is_group_chat: boolean;
  relationship_type: string;
  participants: ParticipantOut[];
  message_count: number;
  first_message_at: string | null;
  last_message_at: string | null;
}

export const RELATIONSHIP_TYPES = [
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
] as const;

export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

export const RELATIONSHIP_TYPE_LABELS: Record<RelationshipType, string> = {
  sigother: "Significant Other",
  parent: "Parent",
  close_family: "Close Family",
  family: "Family",
  close_friend: "Close Friend",
  friend: "Friend",
  classmate: "Classmate",
  professor: "Professor",
  coworker: "Coworker",
  boss: "Boss",
  other: "Other",
};

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

export interface PersonalityLeaderboardEntry {
  participant_id: string;
  display_name: string;
  message_count: number;
  share: number;
}

export interface PersonalityLeaderboardTrait {
  trait: string;
  entries: PersonalityLeaderboardEntry[];
}

export interface PersonalityLeaderboardResponse {
  traits: PersonalityLeaderboardTrait[];
}

export interface LeaderboardMessageEntry {
  message_id: string;
  sender_id: string;
  sender_display_name: string;
  timestamp: string;
  text: string;
  value: number;
}

export interface LeaderboardParticipantEntry {
  participant_id: string;
  display_name: string;
  count: number;
}

export interface ConversationLeaderboard {
  longest_message: LeaderboardMessageEntry | null;
  most_argued_message: LeaderboardMessageEntry | null;
  most_loved_message: LeaderboardMessageEntry | null;
  most_laughed_message: LeaderboardMessageEntry | null;
  most_disliked_message: LeaderboardMessageEntry | null;
  most_reacted_message: LeaderboardMessageEntry | null;
  most_aggressive_message: LeaderboardMessageEntry | null;
  happiest_message: LeaderboardMessageEntry | null;
  most_emoji_message: LeaderboardMessageEntry | null;
  late_night_message: LeaderboardMessageEntry | null;
  fastest_reply_message: LeaderboardMessageEntry | null;
  top_renamer: LeaderboardParticipantEntry | null;
  top_photo_changer: LeaderboardParticipantEntry | null;
  top_unsender: LeaderboardParticipantEntry | null;
  most_revolving_door: LeaderboardParticipantEntry | null;
}

// --- People ---

export interface PersonSummary {
  id: string;
  handle: string;
  display_name: string;
  message_count: number;
  conversation_count: number;
  last_message_at: string | null;
}

export interface PeopleListResponse {
  items: PersonSummary[];
  total: number;
  page: number;
  page_size: number;
}

export interface PersonOut {
  id: string;
  handle: string;
  display_name: string;
}

export interface PersonConversationOut {
  conversation_id: string;
  display_name: string;
  relationship_type: string;
  is_group_chat: boolean;
  message_count: number;
}

export interface PersonDetail {
  id: string;
  handle: string;
  display_name: string;
  message_count: number;
  conversation_count: number;
  first_message_at: string | null;
  last_message_at: string | null;
  heatmap: HeatmapResponse;
  stats: ParticipantStats;
  leaderboard: ConversationLeaderboard;
  conversations: PersonConversationOut[];
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
  keep_message_count: number;
  remove_id: string;
  remove_display_name: string;
  remove_handle: string;
  remove_message_count: number;
}

export interface MergeHistoryResponse {
  items: MergeHistoryEntry[];
}

// --- Conversation merge ---

export interface MergeConversationOut {
  id: string;
  display_name: string;
  subtext: string;
  is_group_chat: boolean;
  message_count: number;
}

export interface MergeConversationsResponse {
  conversations: MergeConversationOut[];
}

export interface MergeConversationResponse {
  ok: boolean;
  keep_id: string;
  removed_id: string;
}

export interface MergeConversationHistoryEntry {
  merged_at: string;
  keep_id: string;
  keep_display_name: string;
  keep_message_count: number;
  remove_id: string;
  remove_display_name: string;
  remove_message_count: number;
}

export interface MergeConversationHistoryResponse {
  items: MergeConversationHistoryEntry[];
}

// All calls go to the in-browser query worker; route names mirror the old HTTP paths.

type Params = Record<string, unknown>;

function errorMessage(e: unknown, withStatus: boolean): Error {
  const err = e as { status?: number; detail?: string; message?: string };
  const detail = err?.detail ?? err?.message ?? String(e);
  // Preserve the old shapes: GET errors were "<status> <detail>", POST errors just <detail>.
  return new Error(withStatus && err?.status ? `${err.status} ${detail}` : detail);
}

async function getJSON<T>(route: string, params: Params = {}): Promise<T> {
  try {
    return await query<T>(`GET ${route}`, params);
  } catch (e) {
    throw errorMessage(e, true);
  }
}

async function postJSON<T>(route: string, params: Params = {}): Promise<T> {
  try {
    return await query<T>(`POST ${route}`, params);
  } catch (e) {
    throw errorMessage(e, false);
  }
}

/** Drop undefined/empty-string keys so handlers can test for presence. */
function clean(p: Params): Params {
  const out: Params = {};
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== "") out[k] = v;
  return out;
}

export const api = {
  overviewStats: () => getJSON<StatCards>("/api/overview"),

  overviewVolume: (granularity: Granularity) =>
    getJSON<VolumeResponse>("/api/overview/volume", { granularity }),

  topConversations: (limit = 10) =>
    getJSON<TopConversationsResponse>("/api/overview/top-conversations", { limit }),

  conversations: (params: { search?: string; sort?: "count" | "recent"; page?: number; page_size?: number }) =>
    getJSON<ConversationListResponse>(
      "/api/conversations",
      clean({
        search: params.search,
        sort: params.sort,
        page: params.page ?? 1,
        page_size: params.page_size ?? 25,
      }),
    ),

  conversation: (id: string) => getJSON<ConversationDetail>("/api/conversations/:id", { id }),

  updateConversationRelationshipType: (id: string, relationshipType: RelationshipType) =>
    postJSON<ConversationDetail>("/api/conversations/:id/relationship-type", {
      id,
      relationship_type: relationshipType,
    }),

  conversationVolume: (id: string, granularity: Granularity) =>
    getJSON<VolumeResponse>("/api/conversations/:id/volume", { id, granularity }),

  participantStats: (id: string) =>
    getJSON<ParticipantStatsResponse>("/api/conversations/:id/participant-stats", { id }),

  messages: (id: string, before?: string, limit = 50) =>
    getJSON<MessagesPage>("/api/conversations/:id/messages", clean({ id, limit, before })),

  messagesAfter: (id: string, after: string, limit = 50) =>
    getJSON<MessagesPage>("/api/conversations/:id/messages", { id, after, limit }),

  messagesForDate: (id: string, date: string, limit = 60) =>
    getJSON<MessagesPage>("/api/conversations/:id/messages", { id, date, limit }),

  messagesAround: (id: string, around: string, limit = 60) =>
    getJSON<MessagesPage>("/api/conversations/:id/messages", { id, around, limit }),

  searchMessages: (id: string, q: string, limit = 20) =>
    getJSON<SearchMessagesResponse>("/api/conversations/:id/messages/search", { id, q, limit }),

  overviewHeatmap: () => getJSON<HeatmapResponse>("/api/overview/heatmap"),

  conversationHeatmap: (id: string) => getJSON<HeatmapResponse>("/api/conversations/:id/heatmap", { id }),

  conversationStreakSilence: (id: string) =>
    getJSON<ConversationStreakSilence>("/api/conversations/:id/streak-silence", { id }),

  conversationJoinLeave: (id: string) =>
    getJSON<JoinLeaveResponse>("/api/conversations/:id/join-leave", { id }),

  conversationReplyGraph: (id: string) =>
    getJSON<ReplyGraphResponse>("/api/conversations/:id/reply-graph", { id }),

  conversationPersonalityLeaderboard: (id: string) =>
    getJSON<PersonalityLeaderboardResponse>("/api/conversations/:id/personality-leaderboard", { id }),

  conversationLeaderboard: (id: string) =>
    getJSON<ConversationLeaderboard>("/api/conversations/:id/leaderboard", { id }),

  people: (params: {
    search?: string;
    sort?: "count" | "recent" | "conversations";
    order?: "asc" | "desc";
    page?: number;
    page_size?: number;
  }) =>
    getJSON<PeopleListResponse>(
      "/api/people",
      clean({
        search: params.search,
        sort: params.sort,
        order: params.order,
        page: params.page ?? 1,
        page_size: params.page_size ?? 25,
      }),
    ),

  person: (id: string) => getJSON<PersonOut>("/api/people/:id", { id }),

  personDetail: (id: string) => getJSON<PersonDetail>("/api/people/:id/detail", { id }),

  participants: () => getJSON<MergeParticipantsResponse>("/api/participants"),

  mergeContacts: (keepId: string, removeId: string) =>
    postJSON<MergeResponse>("/api/merge", { keep_id: keepId, remove_id: removeId }),

  mergeHistory: () => getJSON<MergeHistoryResponse>("/api/merge-history"),

  conversationsForMerge: () => getJSON<MergeConversationsResponse>("/api/conversations-for-merge"),

  mergeConversations: (keepId: string, removeId: string) =>
    postJSON<MergeConversationResponse>("/api/merge-conversation", { keep_id: keepId, remove_id: removeId }),

  conversationMergeHistory: () =>
    getJSON<MergeConversationHistoryResponse>("/api/merge-conversation-history"),
};
