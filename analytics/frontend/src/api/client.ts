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

export interface ParticipantStats {
  participant_id: string;
  display_name: string;
  message_count: number;
  median_reply_seconds: number | null;
  top_words: WordCount[];
  top_emojis: EmojiCount[];
  tapbacks_given: TapbackCount[];
  tapbacks_received: TapbackCount[];
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
  next_cursor: string | null;
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
};
