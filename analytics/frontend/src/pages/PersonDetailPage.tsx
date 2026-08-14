import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { RELATIONSHIP_TYPE_LABELS, api, type ConversationLeaderboard, type LeaderboardMessageEntry, type PersonDetail, type RelationshipType } from "../api/client";
import { Heatmap } from "../components/Heatmap";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { ParticipantStatsCard } from "../components/ParticipantStatsCard";
import { RecordCard, RecordCardEmpty } from "../components/RecordCard";
import { StatCard } from "../components/StatCard";
import styles from "./PersonDetailPage.module.css";

type Tab = "overview" | "stats" | "leaderboard";

interface MessageCardSpec {
  key: keyof ConversationLeaderboard;
  title: string;
  metric: (entry: LeaderboardMessageEntry) => string;
}

const REACTION_CARDS: MessageCardSpec[] = [
  { key: "most_loved_message", title: "Most-loved message", metric: (e) => `${Math.round(e.value).toLocaleString()} ❤️ Loved` },
  { key: "most_laughed_message", title: "Most-laughed-at message", metric: (e) => `${Math.round(e.value).toLocaleString()} 😂 Laughed` },
  { key: "most_disliked_message", title: "Most-disliked message", metric: (e) => `${Math.round(e.value).toLocaleString()} 👎 Disliked` },
  {
    key: "most_reacted_message",
    title: "Most-reacted message",
    metric: (e) => `${Math.round(e.value).toLocaleString()} reaction${Math.round(e.value) === 1 ? "" : "s"}`,
  },
];

const EXTREME_CARDS: MessageCardSpec[] = [
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

const TIMING_CARDS: MessageCardSpec[] = [
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

interface AnnouncementCardSpec {
  key: keyof ConversationLeaderboard;
  title: string;
  subtext: (count: number) => string;
}

const ANNOUNCEMENT_CARDS: AnnouncementCardSpec[] = [
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

type LeaderboardSection =
  | { title: string; kind: "announcement"; cards: AnnouncementCardSpec[] }
  | { title: string; kind: "message"; cards: MessageCardSpec[] };

const LEADERBOARD_SECTIONS: LeaderboardSection[] = [
  { title: "Announcements", kind: "announcement", cards: ANNOUNCEMENT_CARDS },
  { title: "Reactions", kind: "message", cards: REACTION_CARDS },
  { title: "Extremes", kind: "message", cards: EXTREME_CARDS },
  { title: "Timing", kind: "message", cards: TIMING_CARDS },
];

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "(no text)";
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function formatDuration(seconds: number): string {
  const days = seconds / 86400;
  if (days >= 365) return `${(days / 365).toFixed(1)} years`;
  if (days >= 1) return `${Math.round(days).toLocaleString()} day${Math.round(days) === 1 ? "" : "s"}`;
  const hours = seconds / 3600;
  if (hours >= 1) return `${Math.round(hours)}h`;
  return `${Math.round(seconds / 60)}m`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function PersonDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<PersonDetail | null>(null);
  // Loaded separately (and much faster than the full detail bundle) purely so the loading
  // spinner can say whose profile is loading instead of a generic placeholder.
  const [loadingName, setLoadingName] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setDetail(null);
    setLoadingName(null);
    setTab("overview");
    setError(null);
    api.person(id).then((p) => setLoadingName(p.display_name)).catch(() => {});
    api.personDetail(id).then(setDetail).catch((e) => setError(String(e)));
  }, [id]);

  if (error) {
    return <div className={styles.error}>Couldn't load person: {error}</div>;
  }
  if (!detail || !id) {
    return (
      <div className={styles.page}>
        <LoadingSpinner label={loadingName ? `Loading ${loadingName}'s profile…` : "Loading…"} />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.headingRow}>
        <div>
          <h1 className={styles.heading}>{detail.display_name}</h1>
          {detail.handle !== detail.display_name && <div className={styles.handle}>{detail.handle}</div>}
        </div>
      </div>

      <div className={styles.statRow}>
        <StatCard label="Messages" value={detail.message_count.toLocaleString()} />
        <StatCard label="Conversations" value={detail.conversation_count.toLocaleString()} />
        <StatCard label="First message" value={detail.first_message_at ? formatDate(detail.first_message_at) : "—"} compact />
        <StatCard label="Last message" value={detail.last_message_at ? formatDate(detail.last_message_at) : "—"} compact />
      </div>

      <div className={styles.tabs}>
        <button type="button" className={tab === "overview" ? styles.tabActive : styles.tab} onClick={() => setTab("overview")}>
          Overview
        </button>
        <button type="button" className={tab === "stats" ? styles.tabActive : styles.tab} onClick={() => setTab("stats")}>
          Stats
        </button>
        <button type="button" className={tab === "leaderboard" ? styles.tabActive : styles.tab} onClick={() => setTab("leaderboard")}>
          Leaderboard
        </button>
      </div>

      {tab === "leaderboard" ? (
        <>
          {LEADERBOARD_SECTIONS.map((section, i) => (
            <div key={section.title} className={styles.leaderboardSection}>
              {i > 0 && <hr className={styles.leaderboardDivider} />}
              <h2 className={styles.leaderboardSectionTitle}>{section.title}</h2>
              <div className={styles.leaderboardGrid}>
                {section.kind === "announcement"
                  ? section.cards.map((spec) => {
                      const entry = detail.leaderboard[spec.key] as { count: number } | null;
                      return entry === null ? (
                        <RecordCardEmpty key={spec.key} title={spec.title} />
                      ) : (
                        <RecordCard key={spec.key} title={spec.title} headline={entry.count.toLocaleString()} subtext={spec.subtext(entry.count)} />
                      );
                    })
                  : section.cards.map((spec) => {
                      const entry = detail.leaderboard[spec.key] as LeaderboardMessageEntry | null;
                      return entry === null ? (
                        <RecordCardEmpty key={spec.key} title={spec.title} />
                      ) : (
                        <RecordCard
                          key={spec.key}
                          title={spec.title}
                          headline={`"${truncate(entry.text, 90)}"`}
                          subtext={`${formatDateTime(entry.timestamp)} · ${spec.metric(entry)}`}
                        />
                      );
                    })}
              </div>
            </div>
          ))}
        </>
      ) : tab === "stats" ? (
        <ParticipantStatsCard stats={detail.stats} />
      ) : (
        <>
          <Heatmap grid={detail.heatmap.grid} title="When they text" />
          <div className={styles.conversationsSection}>
            <h2 className={styles.conversationsTitle}>Conversations they're in</h2>
            <ul className={styles.conversationList}>
              {detail.conversations.map((c) => (
                <li key={c.conversation_id}>
                  <Link to={`/conversations/${c.conversation_id}`} className={styles.conversationRow}>
                    <span className={styles.conversationName}>{c.display_name}</span>
                    <span className={styles.conversationMeta}>
                      {c.is_group_chat ? "Group" : RELATIONSHIP_TYPE_LABELS[c.relationship_type as RelationshipType] ?? c.relationship_type}
                    </span>
                    <span className={`${styles.conversationCount} mono`}>{c.message_count.toLocaleString()}</span>
                  </Link>
                </li>
              ))}
            </ul>
            {detail.conversations.length === 0 && <p className={styles.empty}>Not in any conversations.</p>}
          </div>
        </>
      )}
    </div>
  );
}
