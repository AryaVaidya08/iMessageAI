import type { LeaderboardMessageEntry } from "../api/client";
import {
  ANNOUNCEMENT_CARDS,
  EXTREME_CARDS,
  REACTION_CARDS,
  TIMING_CARDS,
  formatDateTime,
  formatDuration,
  truncateText,
} from "./leaderboardSpecs";
import type { ConversationShareData, OverviewShareData, PersonShareData, SelectedConversation, SelectedPerson } from "./shareTypes";

const LEADERBOARD_MESSAGE_SPECS = [...REACTION_CARDS, ...EXTREME_CARDS, ...TIMING_CARDS];

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function reply(seconds: number | null): string {
  if (seconds === null) return "—";
  return formatDuration(seconds);
}

export interface ShareTextInput {
  includeOverview: boolean;
  overviewData: OverviewShareData | null;
  conversations: { selection: SelectedConversation; data: ConversationShareData }[];
  people: { selection: SelectedPerson; data: PersonShareData }[];
}

export function buildShareText(input: ShareTextInput): string {
  const lines: string[] = ["📊 iMessage Analytics — Shared Summary", ""];

  if (input.includeOverview && input.overviewData) {
    const d = input.overviewData;
    lines.push("── Overview ──");
    lines.push(`Total messages: ${d.stats.total_messages.toLocaleString()}`);
    lines.push(`Conversations: ${d.stats.total_conversations.toLocaleString()}`);
    lines.push(`Participants: ${d.stats.total_participants.toLocaleString()}`);
    if (d.stats.date_range_start && d.stats.date_range_end) {
      lines.push(`Date range: ${formatDate(d.stats.date_range_start)} – ${formatDate(d.stats.date_range_end)}`);
    }
    if (d.topConversations.length > 0) {
      lines.push(`Top conversations: ${d.topConversations.map((c) => `${c.display_name} (${c.message_count.toLocaleString()})`).join(", ")}`);
    }
    lines.push("");
  }

  for (const { selection, data } of input.conversations) {
    const { detail } = data;
    lines.push(`── ${detail.display_name}${detail.is_group_chat ? " (Group)" : ""} ──`);

    if (selection.sections.has("overview")) {
      lines.push(
        `Messages: ${detail.message_count.toLocaleString()} · Participants: ${detail.participants.length}` +
          (detail.first_message_at && detail.last_message_at
            ? ` · ${formatDate(detail.first_message_at)} – ${formatDate(detail.last_message_at)}`
            : "")
      );
      if (data.streakSilence) {
        lines.push(
          `Longest streak: ${data.streakSilence.streak_days} day${data.streakSilence.streak_days === 1 ? "" : "s"}` +
            (data.streakSilence.silence_gap_seconds !== null ? ` · Longest silence: ${formatDuration(data.streakSilence.silence_gap_seconds)}` : "")
        );
      }
    }

    if (selection.sections.has("stats")) {
      lines.push("Stats:");
      for (const p of data.participants) {
        lines.push(
          `  ${p.display_name} — ${p.message_count.toLocaleString()} msgs, median reply ${reply(p.median_reply_seconds)}, late-night ${Math.round(p.late_night_ratio * 100)}%`
        );
      }
    }

    if (selection.sections.has("leaderboard") && data.leaderboard) {
      const lb = data.leaderboard;
      lines.push("Leaderboard:");
      if (detail.is_group_chat) {
        for (const spec of ANNOUNCEMENT_CARDS) {
          const entry = lb[spec.key] as { count: number } | null;
          if (entry) lines.push(`  ${spec.title}: ${spec.subtext(entry.count)}`);
        }
      }
      for (const spec of LEADERBOARD_MESSAGE_SPECS) {
        const entry = lb[spec.key] as LeaderboardMessageEntry | null;
        if (entry) lines.push(`  ${spec.title}: "${truncateText(entry.text, 80)}" — ${entry.sender_display_name}, ${formatDateTime(entry.timestamp)} (${spec.metric(entry)})`);
      }
    }

    if (selection.sections.has("announcements") && detail.is_group_chat) {
      lines.push("Announcements:");
      for (const event of [...data.joinLeave].sort((a, b) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime())) {
        lines.push(`  ${event.display_name} ${event.kind === "joined" ? "joined" : "left"} — ${formatDateTime(event.datetime)}`);
      }
    }

    lines.push("");
  }

  for (const { selection, data } of input.people) {
    lines.push(`── ${data.display_name} ──`);

    if (selection.sections.has("overview")) {
      lines.push(
        `Messages: ${data.message_count.toLocaleString()} · Conversations: ${data.conversation_count.toLocaleString()}` +
          (data.first_message_at && data.last_message_at ? ` · ${formatDate(data.first_message_at)} – ${formatDate(data.last_message_at)}` : "")
      );
    }

    if (selection.sections.has("stats")) {
      const s = data.stats;
      lines.push(`Stats: median reply ${reply(s.median_reply_seconds)} · breaks silences ${s.gap_initiator_count}x · late-night ${Math.round(s.late_night_ratio * 100)}%`);
    }

    if (selection.sections.has("leaderboard")) {
      const lb = data.leaderboard;
      lines.push("Leaderboard:");
      for (const spec of ANNOUNCEMENT_CARDS) {
        const entry = lb[spec.key] as { count: number } | null;
        if (entry) lines.push(`  ${spec.title}: ${spec.subtext(entry.count)}`);
      }
      for (const spec of LEADERBOARD_MESSAGE_SPECS) {
        const entry = lb[spec.key] as LeaderboardMessageEntry | null;
        if (entry) lines.push(`  ${spec.title}: "${truncateText(entry.text, 80)}" — ${formatDateTime(entry.timestamp)} (${spec.metric(entry)})`);
      }
    }

    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}
