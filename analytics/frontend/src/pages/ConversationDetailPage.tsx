import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import {
  api,
  type ConversationDetail,
  type Granularity,
  type ParticipantStats,
  type VolumePoint,
} from "../api/client";
import { ChatBubbleList } from "../components/ChatBubbleList";
import { ParticipantStatsCard } from "../components/ParticipantStatsCard";
import { VolumeChart } from "../components/VolumeChart";
import styles from "./ConversationDetailPage.module.css";

function buildTitle(detail: ConversationDetail): string {
  const others = detail.participants.filter((p) => !p.is_me).map((p) => p.display_name);
  return others.length ? others.join(", ") : "You";
}

export function ConversationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [stats, setStats] = useState<ParticipantStats[]>([]);
  const [volume, setVolume] = useState<VolumePoint[]>([]);
  const [granularity, setGranularity] = useState<Granularity>("week");
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
    setDetailError(null);
    setStatsError(null);
    api.conversation(id).then(setDetail).catch((e) => setDetailError(String(e)));
    api.participantStats(id).then((r) => setStats(r.participants)).catch((e) => setStatsError(String(e)));
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
      {volumeError ? (
        <div className={styles.error}>Couldn't load volume: {volumeError}</div>
      ) : (
        <VolumeChart points={volume} granularity={granularity} onGranularityChange={setGranularity} />
      )}
      <div className={styles.split}>
        <ChatBubbleList conversationId={id} participants={detail.participants} />
        <div className={styles.statsColumn}>
          {statsError ? (
            <div className={styles.error}>Couldn't load participant stats: {statsError}</div>
          ) : (
            stats.map((s) => <ParticipantStatsCard key={s.participant_id} stats={s} />)
          )}
        </div>
      </div>
    </div>
  );
}
