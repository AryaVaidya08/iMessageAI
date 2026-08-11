import type { ParticipantStats } from "../api/client";
import { ReplyTimeHistogram } from "./ReplyTimeHistogram";
import { TapbackBreakdown } from "./TapbackBreakdown";
import { TopEmojisList } from "./TopEmojisList";
import { TopWordsList } from "./TopWordsList";
import styles from "./ParticipantStatsCard.module.css";

function formatReplySeconds(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

export function ParticipantStatsCard({ stats }: { stats: ParticipantStats }) {
  return (
    <div className={styles.card}>
      <h3 className={styles.name}>
        {stats.display_name}
        {stats.handle && stats.handle !== stats.display_name && (
          <span className={styles.handle}>{stats.handle}</span>
        )}
      </h3>
      <div className={styles.metrics}>
        <div>
          <div className={styles.metricLabel}>Messages</div>
          <div className="mono">{stats.message_count.toLocaleString()}</div>
        </div>
        <div>
          <div className={styles.metricLabel}>Median reply time</div>
          <div className="mono">{formatReplySeconds(stats.median_reply_seconds)}</div>
        </div>
        <div>
          <div className={styles.metricLabel}>Breaks silences</div>
          <div className="mono">{stats.gap_initiator_count.toLocaleString()}</div>
        </div>
        <div>
          <div className={styles.metricLabel}>Late-night texts</div>
          <div className="mono">{Math.round(stats.late_night_ratio * 100)}%</div>
        </div>
      </div>
      <ReplyTimeHistogram buckets={stats.reply_histogram} />
      <TopWordsList words={stats.top_words} />
      <TopEmojisList emojis={stats.top_emojis} />
      <TapbackBreakdown given={stats.tapbacks_given} received={stats.tapbacks_received} />
    </div>
  );
}
