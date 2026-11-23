import { Link } from "react-router-dom";

import { RELATIONSHIP_TYPE_LABELS, type LeaderboardMessageEntry, type RelationshipType } from "../../api/client";
import {
  ANNOUNCEMENT_CARDS,
  EXTREME_CARDS,
  REACTION_CARDS,
  TIMING_CARDS,
  formatDateTime,
  truncateText,
  type MessageCardSpec,
} from "../../lib/leaderboardSpecs";
import type { PersonSection, PersonShareData } from "../../lib/shareTypes";
import { Heatmap } from "../Heatmap";
import { ParticipantStatsCard } from "../ParticipantStatsCard";
import { RecordCard } from "../RecordCard";
import { StatCard } from "../StatCard";
import styles from "./ShareBlocks.module.css";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const LEADERBOARD_MESSAGE_SECTIONS: { title: string; cards: MessageCardSpec[] }[] = [
  { title: "Reactions", cards: REACTION_CARDS },
  { title: "Extremes", cards: EXTREME_CARDS },
  { title: "Timing", cards: TIMING_CARDS },
];

export function SharePersonBlock({ data, sections }: { data: PersonShareData; sections: Set<PersonSection> }) {
  return (
    <div className={styles.block}>
      <div data-share-block="true">
        <div className={styles.blockHeader}>
          <div>
            <div className={styles.blockKicker}>Person</div>
            <h2 className={styles.blockTitle}>{data.display_name}</h2>
          </div>
        </div>

        {sections.has("overview") && (
          <div className={styles.statRow}>
            <StatCard label="Messages" value={data.message_count.toLocaleString()} />
            <StatCard label="Conversations" value={data.conversation_count.toLocaleString()} />
            <StatCard label="First message" value={data.first_message_at ? formatDate(data.first_message_at) : "—"} compact />
            <StatCard label="Last message" value={data.last_message_at ? formatDate(data.last_message_at) : "—"} compact />
          </div>
        )}
      </div>

      {sections.has("overview") && (
        <>
          <Heatmap grid={data.heatmap.grid} title="When they text" />
          <div className={styles.sectionLabel}>Conversations they're in</div>
          {data.conversations.length === 0 ? (
            <p className={styles.empty}>Not in any conversations.</p>
          ) : (
            <ul className={styles.conversationList}>
              {data.conversations.map((c) => (
                <li key={c.conversation_id}>
                  <Link to={`/conversations/${c.conversation_id}`} className={styles.conversationRow}>
                    <span className={styles.conversationName}>{c.display_name}</span>
                    <span className={styles.conversationMeta}>
                      {c.is_group_chat ? "Group" : RELATIONSHIP_TYPE_LABELS[c.relationship_type as RelationshipType] ?? c.relationship_type}
                    </span>
                    <span className="mono">{c.message_count.toLocaleString()}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {sections.has("stats") && (
        <>
          <div className={styles.sectionLabel}>Stats</div>
          <ParticipantStatsCard stats={data.stats} />
        </>
      )}

      {sections.has("leaderboard") && (
        <>
          <div className={styles.sectionLabel}>Leaderboard</div>
          {ANNOUNCEMENT_CARDS.filter((spec) => data.leaderboard[spec.key] !== null).length > 0 && (
            <div className={styles.leaderboardSection} data-share-block="true">
              <h3 className={styles.leaderboardSectionTitle}>Announcements</h3>
              <div className={styles.leaderboardGrid}>
                {ANNOUNCEMENT_CARDS.filter((spec) => data.leaderboard[spec.key] !== null).map((spec) => {
                  const entry = data.leaderboard[spec.key] as { count: number };
                  return <RecordCard key={spec.key} title={spec.title} headline={entry.count.toLocaleString()} subtext={spec.subtext(entry.count)} />;
                })}
              </div>
            </div>
          )}
          {LEADERBOARD_MESSAGE_SECTIONS.map((section) => {
            const nonEmpty = section.cards.filter((spec) => data.leaderboard[spec.key] !== null);
            if (nonEmpty.length === 0) return null;
            return (
              <div key={section.title} className={styles.leaderboardSection} data-share-block="true">
                <h3 className={styles.leaderboardSectionTitle}>{section.title}</h3>
                <div className={styles.leaderboardGrid}>
                  {nonEmpty.map((spec) => {
                    const entry = data.leaderboard[spec.key] as LeaderboardMessageEntry;
                    return (
                      <RecordCard
                        key={spec.key}
                        title={spec.title}
                        headline={`"${truncateText(entry.text, 90)}"`}
                        subtext={`${formatDateTime(entry.timestamp)} · ${spec.metric(entry)}`}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
