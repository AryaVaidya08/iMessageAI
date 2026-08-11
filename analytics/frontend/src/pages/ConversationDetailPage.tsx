import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import {
  api,
  type ConversationDetail,
  type ConversationStreakSilence,
  type Granularity,
  type ParticipantStats,
  type ReplyGraphEdge,
  type VolumePoint,
} from "../api/client";
import { ChatBubbleList } from "../components/ChatBubbleList";
import { Heatmap } from "../components/Heatmap";
import { ParticipantStatsCard } from "../components/ParticipantStatsCard";
import { ReplyGraph } from "../components/ReplyGraph";
import { StatCard } from "../components/StatCard";
import { VolumeChart } from "../components/VolumeChart";
import styles from "./ConversationDetailPage.module.css";

type Tab = "overview" | "stats";

function buildTitle(detail: ConversationDetail): string {
  const others = detail.participants.filter((p) => !p.is_me).map((p) => p.display_name);
  return others.length ? others.join(", ") : "You";
}

function formatDuration(seconds: number): string {
  const days = seconds / 86400;
  if (days >= 365) return `${(days / 365).toFixed(1)} years`;
  if (days >= 1) return `${Math.round(days).toLocaleString()} day${Math.round(days) === 1 ? "" : "s"}`;
  const hours = seconds / 3600;
  if (hours >= 1) return `${Math.round(hours)}h`;
  return `${Math.round(seconds / 60)}m`;
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
  const [tab, setTab] = useState<Tab>("overview");
  const [detailError, setDetailError] = useState<string | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [volumeError, setVolumeError] = useState<string | null>(null);

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
    setTab("overview");
    setDetailError(null);
    setStatsError(null);
    api.conversation(id).then(setDetail).catch((e) => setDetailError(String(e)));
    api
      .participantStats(id)
      .then((r) => setStats(r.participants))
      .catch((e) => setStatsError(String(e)))
      .finally(() => setStatsLoading(false));
    api.conversationHeatmap(id).then((r) => setHeatmap(r.grid)).catch(() => {});
    api.conversationStreakSilence(id).then(setStreakSilence).catch(() => {});
    api.conversationReplyGraph(id).then((r) => setReplyGraph(r.edges)).catch(() => {});
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
      <h1 className={styles.heading}>{buildTitle(detail)}</h1>

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
      </div>

      {tab === "stats" ? (
        statsError ? (
          <div className={styles.error}>Couldn't load participant stats: {statsError}</div>
        ) : statsLoading ? (
          <div className={styles.statsLoading} aria-busy="true">
            <span className={styles.spinner} />
            Computing stats…
          </div>
        ) : (
          <div className={styles.statsColumn}>
            {[...stats]
              .sort((a, b) => b.message_count - a.message_count)
              .map((s) => <ParticipantStatsCard key={s.participant_id} stats={s} />)}
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

          <ChatBubbleList conversationId={id} participants={detail.participants} />

          <div className={styles.replyGraphWrap}>
            <ReplyGraph edges={replyGraph} />
          </div>
        </>
      )}
    </div>
  );
}
