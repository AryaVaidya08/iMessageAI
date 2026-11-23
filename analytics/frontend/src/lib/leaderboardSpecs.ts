import type { ConversationLeaderboard, LeaderboardMessageEntry } from "../api/client";

// Shared with the Share page's leaderboard renderer. Mirrors the card specs
// defined inline in ConversationDetailPage/PersonDetailPage so the share
// export matches what's shown on those pages.

export interface MessageCardSpec {
  key: keyof ConversationLeaderboard;
  title: string;
  metric: (entry: LeaderboardMessageEntry) => string;
}

export function formatDuration(seconds: number): string {
  const days = seconds / 86400;
  if (days >= 365) return `${(days / 365).toFixed(1)} years`;
  if (days >= 1) return `${Math.round(days).toLocaleString()} day${Math.round(days) === 1 ? "" : "s"}`;
  const hours = seconds / 3600;
  if (hours >= 1) return `${Math.round(hours)}h`;
  return `${Math.round(seconds / 60)}m`;
}

export const REACTION_CARDS: MessageCardSpec[] = [
  { key: "most_loved_message", title: "Most-loved message", metric: (e) => `${Math.round(e.value).toLocaleString()} ❤️ Loved` },
  { key: "most_laughed_message", title: "Most-laughed-at message", metric: (e) => `${Math.round(e.value).toLocaleString()} 😂 Laughed` },
  { key: "most_disliked_message", title: "Most-disliked message", metric: (e) => `${Math.round(e.value).toLocaleString()} 👎 Disliked` },
  {
    key: "most_reacted_message",
    title: "Most-reacted message",
    metric: (e) => `${Math.round(e.value).toLocaleString()} reaction${Math.round(e.value) === 1 ? "" : "s"}`,
  },
];

export const EXTREME_CARDS: MessageCardSpec[] = [
  { key: "longest_message", title: "Longest message", metric: (e) => `${Math.round(e.value).toLocaleString()} characters` },
  {
    key: "most_argued_message",
    title: "Most argued-about message",
    metric: (e) => `${Math.round(e.value).toLocaleString()} repl${Math.round(e.value) === 1 ? "y" : "ies"}`,
  },
  { key: "most_aggressive_message", title: "Most aggressive message", metric: (e) => `aggression score ${Math.round(e.value)}` },
  { key: "happiest_message", title: "Happiest message", metric: (e) => `sentiment +${e.value.toFixed(2)}` },
  { key: "most_emoji_message", title: "Most emoji-packed message", metric: (e) => `${Math.round(e.value).toLocaleString()} emoji` },
];

export const TIMING_CARDS: MessageCardSpec[] = [
  {
    key: "late_night_message",
    title: "Deepest late-night message",
    metric: (e) =>
      `sent at ${new Date(e.timestamp).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`,
  },
  {
    key: "fastest_reply_message",
    title: "Fastest-replied-to message",
    metric: (e) => `replied to in ${formatDuration(e.value)}`,
  },
];

export interface AnnouncementCardSpec {
  key: keyof ConversationLeaderboard;
  title: string;
  subtext: (count: number) => string;
}

export const ANNOUNCEMENT_CARDS: AnnouncementCardSpec[] = [
  { key: "top_renamer", title: "Group renames", subtext: (c) => `renamed a group chat ${c.toLocaleString()} time${c === 1 ? "" : "s"}` },
  {
    key: "top_photo_changer",
    title: "Photo & background changes",
    subtext: (c) => `changed a group photo/background ${c.toLocaleString()} time${c === 1 ? "" : "s"}`,
  },
  { key: "top_unsender", title: "Unsent messages", subtext: (c) => `unsent ${c.toLocaleString()} message${c === 1 ? "" : "s"}` },
  {
    key: "most_revolving_door",
    title: "Joined or left groups",
    subtext: (c) => `joined or left a group ${c.toLocaleString()} time${c === 1 ? "" : "s"}`,
  },
];

export function truncateText(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "(no text)";
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
