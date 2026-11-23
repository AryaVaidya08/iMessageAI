import type {
  ConversationDetail,
  ConversationLeaderboard,
  ConversationStreakSilence,
  Granularity,
  JoinLeaveEvent,
  ParticipantStats,
  PersonDetail,
  StatCards,
  TopConversationOut,
  VolumePoint,
} from "../api/client";

export type VolumeByGranularity = Record<Granularity, VolumePoint[]>;

export type ConvSection = "overview" | "stats" | "leaderboard" | "announcements";
export type PersonSection = "overview" | "stats" | "leaderboard";

export const CONV_SECTIONS: { key: ConvSection; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "stats", label: "Stats" },
  { key: "leaderboard", label: "Leaderboard" },
  { key: "announcements", label: "Announcements" },
];

export const PERSON_SECTIONS: { key: PersonSection; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "stats", label: "Stats" },
  { key: "leaderboard", label: "Leaderboard" },
];

export interface SelectedConversation {
  id: string;
  display_name: string;
  is_group_chat: boolean;
  sections: Set<ConvSection>;
}

export interface SelectedPerson {
  id: string;
  display_name: string;
  sections: Set<PersonSection>;
}

export interface OverviewShareData {
  stats: StatCards;
  volume: VolumeByGranularity;
  heatmap: number[][];
  topConversations: TopConversationOut[];
}

export interface ConversationShareData {
  detail: ConversationDetail;
  volume: VolumeByGranularity;
  heatmap: number[][];
  streakSilence: ConversationStreakSilence | null;
  participants: ParticipantStats[];
  leaderboard: ConversationLeaderboard | null;
  joinLeave: JoinLeaveEvent[];
}

export type PersonShareData = PersonDetail;

export type FetchState<T> = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; data: T };

export function isReady<T>(s: FetchState<T> | undefined): s is { status: "ready"; data: T } {
  return s !== undefined && s.status === "ready";
}
