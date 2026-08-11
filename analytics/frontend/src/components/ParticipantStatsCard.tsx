import { useState } from "react";
import type { ParticipantStats } from "../api/client";
import { PersonalityChart } from "./PersonalityChart";
import { SentimentChart } from "./SentimentChart";
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

// Each entry is a selectable view in the personality/sentiment switcher below
// the headline metrics. Add new views here as they're built -- the tab row
// and rendering both derive from this list.
function buildAnalysisViews(stats: ParticipantStats) {
  return [
    { key: "sentiment", label: "Sentiment over time", node: <SentimentChart points={stats.sentiment_series} /> },
    { key: "personality", label: "Personality", node: <PersonalityChart traits={stats.personality} /> },
  ];
}

export function ParticipantStatsCard({ stats }: { stats: ParticipantStats }) {
  const views = buildAnalysisViews(stats);
  const [activeView, setActiveView] = useState(views[0].key);
  const active = views.find((v) => v.key === activeView) ?? views[0];

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
      <div className={styles.tabRow} role="tablist">
        {views.map((v) => (
          <button
            key={v.key}
            type="button"
            role="tab"
            aria-selected={v.key === activeView}
            className={`${styles.tab} ${v.key === activeView ? styles.tabActive : ""}`}
            onClick={() => setActiveView(v.key)}
          >
            {v.label}
          </button>
        ))}
      </div>
      {active.node}
      <div className={styles.columns}>
        <TopWordsList words={stats.top_words.slice(0, 5)} />
        <TopEmojisList emojis={stats.top_emojis.slice(0, 5)} />
      </div>
      <TapbackBreakdown given={stats.tapbacks_given.slice(0, 5)} received={stats.tapbacks_received.slice(0, 5)} />
    </div>
  );
}
