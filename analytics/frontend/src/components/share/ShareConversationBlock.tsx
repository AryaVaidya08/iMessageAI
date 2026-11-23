import { useState } from "react";

import { RELATIONSHIP_TYPE_LABELS, type Granularity, type LeaderboardMessageEntry, type RelationshipType } from "../../api/client";
import {
  ANNOUNCEMENT_CARDS,
  EXTREME_CARDS,
  REACTION_CARDS,
  TIMING_CARDS,
  formatDateTime,
  formatDuration,
  truncateText,
  type MessageCardSpec,
} from "../../lib/leaderboardSpecs";
import type { ConvSection, ConversationShareData } from "../../lib/shareTypes";
import { Heatmap } from "../Heatmap";
import { ParticipantStatsCard } from "../ParticipantStatsCard";
import { RecordCard, RecordCardEmpty } from "../RecordCard";
import { StatCard } from "../StatCard";
import { VolumeChart } from "../VolumeChart";
import styles from "./ShareBlocks.module.css";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const LEADERBOARD_MESSAGE_SECTIONS: { title: string; cards: MessageCardSpec[] }[] = [
  { title: "Reactions", cards: REACTION_CARDS },
  { title: "Extremes", cards: EXTREME_CARDS },
  { title: "Timing", cards: TIMING_CARDS },
];

export function ShareConversationBlock({ data, sections }: { data: ConversationShareData; sections: Set<ConvSection> }) {
  const [granularity, setGranularity] = useState<Granularity>("week");
  const { detail } = data;

  return (
    <div className={styles.block}>
      <div data-share-block="true">
        <div className={styles.blockHeader}>
          <div>
            <div className={styles.blockKicker}>{detail.is_group_chat ? "Group conversation" : "Conversation"}</div>
            <h2 className={styles.blockTitle}>{detail.display_name}</h2>
          </div>
          {!detail.is_group_chat && (
            <span className={styles.blockKicker}>{RELATIONSHIP_TYPE_LABELS[detail.relationship_type as RelationshipType] ?? detail.relationship_type}</span>
          )}
        </div>

        {sections.has("overview") && (
          <div className={styles.statRow}>
            <StatCard label="Participants" value={String(detail.participants.length)} />
            <StatCard label="Total messages" value={detail.message_count.toLocaleString()} />
            <StatCard label="First message" value={detail.first_message_at ? formatDate(detail.first_message_at) : "—"} compact />
            <StatCard label="Last message" value={detail.last_message_at ? formatDate(detail.last_message_at) : "—"} compact />
          </div>
        )}
      </div>

      {sections.has("overview") && (
        <>
          {data.streakSilence && (
            <div className={styles.statRow} data-share-block="true">
              <StatCard
                label="Longest streak"
                value={`${data.streakSilence.streak_days.toLocaleString()} day${data.streakSilence.streak_days === 1 ? "" : "s"}`}
              />
              <StatCard
                label="Longest silence"
                value={data.streakSilence.silence_gap_seconds !== null ? formatDuration(data.streakSilence.silence_gap_seconds) : "—"}
              />
            </div>
          )}
          <VolumeChart points={data.volume[granularity]} granularity={granularity} onGranularityChange={setGranularity} animate={false} />
          <Heatmap grid={data.heatmap} title="When you text" />
        </>
      )}

      {sections.has("stats") && (
        <>
          <div className={styles.sectionLabel}>Participant stats</div>
          <div className={styles.statsColumn}>
            {data.participants.map((p) => (
              <ParticipantStatsCard key={p.participant_id} stats={p} />
            ))}
          </div>
        </>
      )}

      {sections.has("leaderboard") && data.leaderboard && (
        <>
          <div className={styles.sectionLabel}>Leaderboard</div>
          {detail.is_group_chat && (
            <div className={styles.leaderboardSection} data-share-block="true">
              <h3 className={styles.leaderboardSectionTitle}>Announcements</h3>
              <div className={styles.leaderboardGrid}>
                {ANNOUNCEMENT_CARDS.filter((spec) => data.leaderboard![spec.key] !== null).map((spec) => {
                  const entry = data.leaderboard![spec.key] as { count: number };
                  return <RecordCard key={spec.key} title={spec.title} headline={entry.count.toLocaleString()} subtext={spec.subtext(entry.count)} />;
                })}
              </div>
            </div>
          )}
          {LEADERBOARD_MESSAGE_SECTIONS.map((section) => {
            const nonEmpty = section.cards.filter((spec) => data.leaderboard![spec.key] !== null);
            if (nonEmpty.length === 0) return null;
            return (
              <div key={section.title} className={styles.leaderboardSection} data-share-block="true">
                <h3 className={styles.leaderboardSectionTitle}>{section.title}</h3>
                <div className={styles.leaderboardGrid}>
                  {nonEmpty.map((spec) => {
                    const entry = data.leaderboard![spec.key] as LeaderboardMessageEntry;
                    return (
                      <RecordCard
                        key={spec.key}
                        title={spec.title}
                        headline={`"${truncateText(entry.text, 90)}"`}
                        subtext={`${entry.sender_display_name} · ${formatDateTime(entry.timestamp)} · ${spec.metric(entry)}`}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </>
      )}

      {sections.has("announcements") && detail.is_group_chat && (
        <>
          <div className={styles.sectionLabel}>Announcements</div>
          {data.joinLeave.length === 0 ? (
            <RecordCardEmpty title="Join / leave activity" />
          ) : (
            <ul className={styles.announcementList}>
              {[...data.joinLeave]
                .sort((a, b) => new Date(b.datetime).getTime() - new Date(a.datetime).getTime())
                .map((event, i) => (
                  <li key={i} className={styles.announcementItem}>
                    <span className={event.kind === "joined" ? styles.announcementDotJoin : styles.announcementDotLeave} />
                    <span>
                      <strong>{event.display_name}</strong> {event.kind === "joined" ? "joined the group" : "left the group"}
                    </span>
                    <span className={styles.announcementTime}>{formatDateTime(event.datetime)}</span>
                  </li>
                ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
