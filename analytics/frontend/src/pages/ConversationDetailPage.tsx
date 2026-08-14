import { useEffect, useRef, useState } from "react";
import { FiInfo } from "react-icons/fi";
import { useParams } from "react-router-dom";

import {
  api,
  RELATIONSHIP_TYPE_LABELS,
  RELATIONSHIP_TYPES,
  type ConversationDetail,
  type ConversationLeaderboard,
  type ConversationStreakSilence,
  type Granularity,
  type JoinLeaveEvent,
  type LeaderboardMessageEntry,
  type ParticipantStats,
  type RelationshipType,
  type ReplyGraphEdge,
  type VolumePoint,
} from "../api/client";
import { ChatBubbleList } from "../components/ChatBubbleList";
import { Heatmap } from "../components/Heatmap";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { ParticipantStatsCard } from "../components/ParticipantStatsCard";
import { RecordCard, RecordCardEmpty, RecordCardSkeleton } from "../components/RecordCard";
import { ReplyGraph } from "../components/ReplyGraph";
import { StatCard } from "../components/StatCard";
import { VolumeChart } from "../components/VolumeChart";
import styles from "./ConversationDetailPage.module.css";

type Tab = "overview" | "stats" | "announcements" | "leaderboard";

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

interface ParticipantCardSpec {
  key: keyof ConversationLeaderboard;
  title: string;
  subtext: (count: number) => string;
}

const PARTICIPANT_LEADERBOARD_CARDS: ParticipantCardSpec[] = [
  { key: "top_renamer", title: "Serial renamer", subtext: (c) => `renamed the group ${c.toLocaleString()} time${c === 1 ? "" : "s"}` },
  {
    key: "top_photo_changer",
    title: "Photo & background changer",
    subtext: (c) => `changed the group photo/background ${c.toLocaleString()} time${c === 1 ? "" : "s"}`,
  },
  { key: "top_unsender", title: "Most unsent messages", subtext: (c) => `unsent ${c.toLocaleString()} message${c === 1 ? "" : "s"}` },
  {
    key: "most_revolving_door",
    title: "Revolving door",
    subtext: (c) => `joined or left the group ${c.toLocaleString()} time${c === 1 ? "" : "s"}`,
  },
];

type LeaderboardSection =
  | { title: string; kind: "participant"; cards: ParticipantCardSpec[] }
  | { title: string; kind: "message"; cards: MessageCardSpec[] };

const LEADERBOARD_SECTIONS: LeaderboardSection[] = [
  { title: "Announcements", kind: "participant", cards: PARTICIPANT_LEADERBOARD_CARDS },
  { title: "Reactions", kind: "message", cards: REACTION_CARDS },
  { title: "Extremes", kind: "message", cards: EXTREME_CARDS },
  { title: "Timing", kind: "message", cards: TIMING_CARDS },
];

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "(no text)";
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function buildTitle(detail: ConversationDetail): string {
  return detail.display_name;
}

// Per trait, only the participant(s) with the single highest rate get a
// bubble for it -- being #1 in the conversation, not just having a
// nonzero rate, is what earns the badge.
function computeTopTraits(participants: ParticipantStats[]): Record<string, string[]> {
  const maxByTrait: Record<string, number> = {};
  for (const p of participants) {
    for (const t of p.personality) {
      if (t.percentage <= 0) continue;
      if (!(t.trait in maxByTrait) || t.percentage > maxByTrait[t.trait]) {
        maxByTrait[t.trait] = t.percentage;
      }
    }
  }
  const result: Record<string, string[]> = {};
  for (const p of participants) {
    result[p.participant_id] = p.personality
      .filter((t) => t.percentage > 0 && t.percentage === maxByTrait[t.trait])
      .map((t) => t.trait);
  }
  return result;
}

// Same floor as the personality rate computation: a handful of messages
// isn't enough signal to crown someone "fastest replier" etc.
const BADGE_MIN_MESSAGES = 20;

function totalTapbacksReceived(p: ParticipantStats): number {
  return p.tapbacks_received.reduce((sum, t) => sum + t.count, 0);
}

function winnersByMax(participants: ParticipantStats[], getValue: (p: ParticipantStats) => number): string[] {
  const withPositive = participants.filter((p) => getValue(p) > 0);
  if (withPositive.length === 0) return [];
  const max = Math.max(...withPositive.map(getValue));
  return withPositive.filter((p) => getValue(p) === max).map((p) => p.participant_id);
}

// Personality traits plus a few conversation-wide "#1 in this stat" awards,
// all using the same only-the-winner-gets-a-bubble rule. Capped at 2 per
// person so a single participant who sweeps everything doesn't turn into a
// wall of bubbles.
const MAX_BADGES_PER_PERSON = 2;

function computeBadges(participants: ParticipantStats[]): Record<string, string[]> {
  const badges = computeTopTraits(participants);
  const addBadge = (ids: string[], label: string) => {
    for (const id of ids) {
      badges[id] = [...(badges[id] ?? []), label];
    }
  };

  const eligible = participants.filter((p) => p.message_count >= BADGE_MIN_MESSAGES);
  addBadge(winnersByMax(eligible, (p) => p.gap_initiator_count), "Silence Breaker");
  addBadge(winnersByMax(eligible, totalTapbacksReceived), "Reaction Magnet");

  for (const id of Object.keys(badges)) {
    badges[id] = badges[id].slice(0, MAX_BADGES_PER_PERSON);
  }

  return badges;
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

export function ConversationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [stats, setStats] = useState<ParticipantStats[]>([]);
  const [statsLoading, setStatsLoading] = useState(true);
  const [volume, setVolume] = useState<VolumePoint[]>([]);
  const [granularity, setGranularity] = useState<Granularity>("week");
  const [heatmap, setHeatmap] = useState<number[][] | null>(null);
  const [streakSilence, setStreakSilence] = useState<ConversationStreakSilence | null>(null);
  const [replyGraph, setReplyGraph] = useState<ReplyGraphEdge[]>([]);
  const [joinLeaveEvents, setJoinLeaveEvents] = useState<JoinLeaveEvent[] | null>(null);
  const [leaderboard, setLeaderboard] = useState<ConversationLeaderboard | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [detailError, setDetailError] = useState<string | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [volumeError, setVolumeError] = useState<string | null>(null);
  const [joinLeaveError, setJoinLeaveError] = useState<string | null>(null);
  const [leaderboardError, setLeaderboardError] = useState<string | null>(null);
  const [relationshipSaving, setRelationshipSaving] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [jumpTarget, setJumpTarget] = useState<{ messageId: string; nonce: number } | null>(null);
  const jumpNonceRef = useRef(0);

  function handleJumpToMessage(messageId: string) {
    jumpNonceRef.current += 1;
    setJumpTarget({ messageId, nonce: jumpNonceRef.current });
    setTab("overview");
  }

  useEffect(() => {
    if (!infoOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setInfoOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [infoOpen]);

  function handleRelationshipChange(next: RelationshipType) {
    if (!id || !detail) return;
    const previous = detail.relationship_type;
    setDetail({ ...detail, relationship_type: next });
    setRelationshipSaving(true);
    api
      .updateConversationRelationshipType(id, next)
      .catch(() => setDetail((d) => (d ? { ...d, relationship_type: previous } : d)))
      .finally(() => setRelationshipSaving(false));
  }

  useEffect(() => {
    // React Router keeps this component mounted across an id-only navigation
    // (e.g. clicking from one conversation to another in the list) -- it
    // never unmounts/remounts. Without resetting state here, a stale error
    // from the PREVIOUS id would keep failing the `if (detailError)` check
    // forever even after the new id's fetch succeeds, and stale content would
    // flash before the new fetch resolves.
    if (!id) return;
    setDetail(null);
    setStats([]);
    setStatsLoading(true);
    setHeatmap(null);
    setStreakSilence(null);
    setReplyGraph([]);
    setJoinLeaveEvents(null);
    setLeaderboard(null);
    setTab("overview");
    setInfoOpen(false);
    setDetailError(null);
    setStatsError(null);
    setJoinLeaveError(null);
    setLeaderboardError(null);
    api.conversation(id).then(setDetail).catch((e) => setDetailError(String(e)));
    api
      .participantStats(id)
      .then((r) => setStats(r.participants))
      .catch((e) => setStatsError(String(e)))
      .finally(() => setStatsLoading(false));
    api.conversationHeatmap(id).then((r) => setHeatmap(r.grid)).catch(() => {});
    api.conversationStreakSilence(id).then(setStreakSilence).catch(() => {});
    api.conversationReplyGraph(id).then((r) => setReplyGraph(r.edges)).catch(() => {});
    api
      .conversationJoinLeave(id)
      .then((r) => setJoinLeaveEvents(r.items))
      .catch((e) => setJoinLeaveError(String(e)));
    api
      .conversationLeaderboard(id)
      .then(setLeaderboard)
      .catch((e) => setLeaderboardError(String(e)));
  }, [id]);

  useEffect(() => {
    // Ignore-stale-response guard: rapidly toggling granularity fires a new
    // fetch before the previous one resolves; without this, an older
    // response arriving after a newer one could overwrite fresher data.
    if (!id) return;
    setVolume([]);
    setVolumeError(null);
    let cancelled = false;
    api
      .conversationVolume(id, granularity)
      .then((r) => {
        if (!cancelled) setVolume(r.points);
      })
      .catch((e) => {
        if (!cancelled) setVolumeError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [id, granularity]);

  if (detailError) {
    return <div className={styles.error}>Couldn't load conversation: {detailError}</div>;
  }
  if (!detail || !id) {
    return <div className={styles.page}>Loading…</div>;
  }

  return (
    <div className={styles.page}>
      <div className={styles.headingRow}>
        <h1 className={styles.heading}>{buildTitle(detail)}</h1>
        <select
          className={styles.relationshipSelect}
          value={detail.relationship_type}
          disabled={relationshipSaving}
          onChange={(e) => handleRelationshipChange(e.target.value as RelationshipType)}
          aria-label="Relationship type"
        >
          {RELATIONSHIP_TYPES.map((rt) => (
            <option key={rt} value={rt}>
              {RELATIONSHIP_TYPE_LABELS[rt]}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.tabsRow}>
        <div className={styles.tabs}>
          <button
            type="button"
            className={tab === "overview" ? styles.tabActive : styles.tab}
            onClick={() => setTab("overview")}
          >
            Overview
          </button>
          <button
            type="button"
            className={tab === "stats" ? styles.tabActive : styles.tab}
            onClick={() => setTab("stats")}
          >
            Stats
          </button>
          <button
            type="button"
            className={tab === "leaderboard" ? styles.tabActive : styles.tab}
            onClick={() => setTab("leaderboard")}
          >
            Leaderboard
          </button>
          {detail.is_group_chat && (
            <button
              type="button"
              className={tab === "announcements" ? styles.tabActive : styles.tab}
              onClick={() => setTab("announcements")}
            >
              Announcements
            </button>
          )}
        </div>
        <button
          type="button"
          className={styles.infoButton}
          onClick={() => setInfoOpen(true)}
          aria-label="Conversation info"
        >
          <FiInfo size={16} />
        </button>
      </div>

      {infoOpen && (
        <div className={styles.modalOverlay} onClick={() => setInfoOpen(false)}>
          <div className={styles.modalCard} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h2 className={styles.modalTitle}>Conversation info</h2>
              <button
                type="button"
                className={styles.modalClose}
                onClick={() => setInfoOpen(false)}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className={styles.infoSection}>
              <div className={styles.infoParticipants}>
                {detail.participants.map((p) => (
                  <span key={p.id} className={styles.participantPill}>
                    {p.display_name}
                    {p.is_me ? " (you)" : ""}
                  </span>
                ))}
              </div>
              <div className={styles.infoStatRow}>
                <StatCard label="Participants" value={String(detail.participants.length)} />
                <StatCard label="Total messages" value={detail.message_count.toLocaleString()} />
                <StatCard label="First message" value={detail.first_message_at ? formatDate(detail.first_message_at) : "—"} compact />
                <StatCard label="Last message" value={detail.last_message_at ? formatDate(detail.last_message_at) : "—"} compact />
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === "leaderboard" ? (
        leaderboardError ? (
          <div className={styles.error}>Couldn't load leaderboard: {leaderboardError}</div>
        ) : leaderboard === null ? (
          <div className={styles.leaderboardGrid}>
            {Array.from({ length: 8 }).map((_, i) => (
              <RecordCardSkeleton key={i} />
            ))}
          </div>
        ) : (
          <>
            {LEADERBOARD_SECTIONS.map((section, i) => (
              <div key={section.title} className={styles.leaderboardSection}>
                {i > 0 && <hr className={styles.leaderboardDivider} />}
                <h2 className={styles.leaderboardSectionTitle}>{section.title}</h2>
                <div className={styles.leaderboardGrid}>
                  {section.kind === "participant"
                    ? section.cards.map((spec) => {
                        const entry = leaderboard[spec.key] as { display_name: string; count: number } | null;
                        return entry === null ? (
                          <RecordCardEmpty key={spec.key} title={spec.title} />
                        ) : (
                          <RecordCard
                            key={spec.key}
                            title={spec.title}
                            headline={entry.display_name}
                            subtext={spec.subtext(entry.count)}
                          />
                        );
                      })
                    : section.cards.map((spec) => {
                        const entry = leaderboard[spec.key] as LeaderboardMessageEntry | null;
                        return entry === null ? (
                          <RecordCardEmpty key={spec.key} title={spec.title} />
                        ) : (
                          <RecordCard
                            key={spec.key}
                            title={spec.title}
                            headline={`"${truncate(entry.text, 90)}"`}
                            subtext={`${entry.sender_display_name} · ${formatDateTime(entry.timestamp)} · ${spec.metric(entry)}`}
                            onClick={() => handleJumpToMessage(entry.message_id)}
                          />
                        );
                      })}
                </div>
              </div>
            ))}
          </>
        )
      ) : tab === "announcements" ? (
        joinLeaveError ? (
          <div className={styles.error}>Couldn't load announcements: {joinLeaveError}</div>
        ) : joinLeaveEvents === null ? (
          <LoadingSpinner label="Loading announcements…" />
        ) : joinLeaveEvents.length === 0 ? (
          <div className={styles.error}>No join/leave activity recorded for this conversation.</div>
        ) : (
          <ul className={styles.announcementList}>
            {[...joinLeaveEvents]
              .sort((a, b) => new Date(b.datetime).getTime() - new Date(a.datetime).getTime())
              .map((event, i) => (
                <li key={i} className={styles.announcementItem}>
                  <span
                    className={event.kind === "joined" ? styles.announcementDotJoin : styles.announcementDotLeave}
                  />
                  <span className={styles.announcementText}>
                    <strong>{event.display_name}</strong> {event.kind === "joined" ? "joined the group" : "left the group"}
                  </span>
                  <span className={styles.announcementTime}>{formatDateTime(event.datetime)}</span>
                </li>
              ))}
          </ul>
        )
      ) : tab === "stats" ? (
        statsError ? (
          <div className={styles.error}>Couldn't load participant stats: {statsError}</div>
        ) : statsLoading ? (
          <LoadingSpinner label="Computing stats…" />
        ) : (
          <div className={styles.statsColumn}>
            {(() => {
              const badgesByParticipant = computeBadges(stats);
              return [...stats]
                .sort((a, b) => b.message_count - a.message_count)
                .map((s) => (
                  <ParticipantStatsCard
                    key={s.participant_id}
                    stats={s}
                    badges={badgesByParticipant[s.participant_id] ?? []}
                  />
                ));
            })()}
          </div>
        )
      ) : (
        <>
          {streakSilence && (
            <div className={styles.statRow}>
              <StatCard
                label="Longest streak"
                value={`${streakSilence.streak_days.toLocaleString()} day${streakSilence.streak_days === 1 ? "" : "s"}`}
              />
              <StatCard
                label="Longest silence"
                value={streakSilence.silence_gap_seconds !== null ? formatDuration(streakSilence.silence_gap_seconds) : "—"}
              />
            </div>
          )}

          {volumeError ? (
            <div className={styles.error}>Couldn't load volume: {volumeError}</div>
          ) : (
            <VolumeChart points={volume} granularity={granularity} onGranularityChange={setGranularity} />
          )}

          {heatmap && <Heatmap grid={heatmap} title="When you text" />}

          <ChatBubbleList conversationId={id} participants={detail.participants} jumpTarget={jumpTarget} />

          <div className={styles.replyGraphWrap}>
            <ReplyGraph edges={replyGraph} />
          </div>
        </>
      )}
    </div>
  );
}
