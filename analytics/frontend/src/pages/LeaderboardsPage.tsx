import { useEffect, useState } from "react";

import {
  api,
  type ArguedMessageEntry,
  type AttachmentLeaderboardEntry,
  type LovedMessageEntry,
  type SilenceLeaderboard,
  type StreakLeaderboard,
} from "../api/client";
import { RecordCard, RecordCardEmpty, RecordCardSkeleton } from "../components/RecordCard";
import styles from "./LeaderboardsPage.module.css";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatDuration(seconds: number): string {
  const days = seconds / 86400;
  if (days >= 365) return `${(days / 365).toFixed(1)} years`;
  if (days >= 1) return `${Math.round(days).toLocaleString()} day${Math.round(days) === 1 ? "" : "s"}`;
  const hours = seconds / 3600;
  if (hours >= 1) return `${Math.round(hours)}h`;
  return `${Math.round(seconds / 60)}m`;
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function MessageSubtext({ item }: { item: LovedMessageEntry | ArguedMessageEntry }) {
  return (
    <>
      {item.sender_display_name} in {item.conversation_display_name} · {formatDate(item.timestamp)}
    </>
  );
}

export function LeaderboardsPage() {
  const [attachments, setAttachments] = useState<AttachmentLeaderboardEntry[] | null>(null);
  const [loved, setLoved] = useState<LovedMessageEntry[] | null>(null);
  const [argued, setArgued] = useState<ArguedMessageEntry[] | null>(null);
  const [streak, setStreak] = useState<StreakLeaderboard | null | undefined>(undefined);
  const [silence, setSilence] = useState<SilenceLeaderboard | null | undefined>(undefined);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const setError = (key: string) => (e: unknown) => setErrors((prev) => ({ ...prev, [key]: String(e) }));

  useEffect(() => {
    api.leaderboardAttachments(5).then((r) => setAttachments(r.items)).catch(setError("attachments"));
    api.leaderboardMostLoved(1).then((r) => setLoved(r.items)).catch(setError("loved"));
    api.leaderboardMostArgued(1).then((r) => setArgued(r.items)).catch(setError("argued"));
    api.leaderboardStreak().then(setStreak).catch(setError("streak"));
    api.leaderboardSilence().then(setSilence).catch(setError("silence"));
  }, []);

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>Leaderboards</h1>
      <div className={styles.grid}>
        {errors.attachments ? (
          <RecordCardEmpty title="Attachment leaderboard" />
        ) : attachments === null ? (
          <RecordCardSkeleton />
        ) : attachments.length === 0 ? (
          <RecordCardEmpty title="Attachment leaderboard" />
        ) : (
          <RecordCard
            title="Attachment leaderboard"
            headline={attachments[0].display_name}
            subtext={`${attachments[0].count.toLocaleString()} attachments & stickers sent`}
            items={attachments.slice(1).map((a) => ({ label: a.display_name, value: a.count.toLocaleString() }))}
          />
        )}

        {errors.loved ? (
          <RecordCardEmpty title="Most-loved message" />
        ) : loved === null ? (
          <RecordCardSkeleton />
        ) : loved.length === 0 ? (
          <RecordCardEmpty title="Most-loved message" />
        ) : (
          <RecordCard
            title="Most-loved message"
            headline={`"${truncate(loved[0].text, 80)}"`}
            subtext={<MessageSubtext item={loved[0]} />}
            linkTo={`/conversations/${loved[0].conversation_id}`}
          />
        )}

        {errors.argued ? (
          <RecordCardEmpty title="Most-argued-about message" />
        ) : argued === null ? (
          <RecordCardSkeleton />
        ) : argued.length === 0 ? (
          <RecordCardEmpty title="Most-argued-about message" />
        ) : (
          <RecordCard
            title="Most-argued-about message"
            headline={`"${truncate(argued[0].text, 80)}"`}
            subtext={<MessageSubtext item={argued[0]} />}
            linkTo={`/conversations/${argued[0].conversation_id}`}
          />
        )}

        {errors.streak ? (
          <RecordCardEmpty title="Longest streak" />
        ) : streak === undefined ? (
          <RecordCardSkeleton />
        ) : streak === null ? (
          <RecordCardEmpty title="Longest streak" />
        ) : (
          <RecordCard
            title="Longest streak"
            headline={`${streak.streak_days.toLocaleString()} day${streak.streak_days === 1 ? "" : "s"}`}
            subtext={`Consecutive days texting with ${streak.conversation_display_name}`}
            linkTo={`/conversations/${streak.conversation_id}`}
          />
        )}

        {errors.silence ? (
          <RecordCardEmpty title="Longest silence" />
        ) : silence === undefined ? (
          <RecordCardSkeleton />
        ) : silence === null ? (
          <RecordCardEmpty title="Longest silence" />
        ) : (
          <RecordCard
            title="Longest silence"
            headline={formatDuration(silence.gap_seconds)}
            subtext={`No messages with ${silence.conversation_display_name} from ${formatDate(silence.before)} to ${formatDate(silence.after)}`}
            linkTo={`/conversations/${silence.conversation_id}`}
          />
        )}
      </div>
    </div>
  );
}
