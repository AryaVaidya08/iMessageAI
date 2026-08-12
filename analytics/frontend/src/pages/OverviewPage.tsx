import { useEffect, useState } from "react";

import {
  api,
  type Granularity,
  type StatCards,
  type TopConversationOut,
  type VolumePoint,
} from "../api/client";
import { Heatmap } from "../components/Heatmap";
import { StatCard, StatCardSkeleton } from "../components/StatCard";
import { TopConversationsChart } from "../components/TopConversationsChart";
import { VolumeChart } from "../components/VolumeChart";
import styles from "./OverviewPage.module.css";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "2-digit", month: "numeric", day: "numeric" });
}

export function OverviewPage() {
  const [stats, setStats] = useState<StatCards | null>(null);
  const [volume, setVolume] = useState<VolumePoint[]>([]);
  const [granularity, setGranularity] = useState<Granularity>("week");
  const [top, setTop] = useState<TopConversationOut[]>([]);
  const [heatmap, setHeatmap] = useState<number[][] | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [topError, setTopError] = useState<string | null>(null);
  const [volumeError, setVolumeError] = useState<string | null>(null);

  useEffect(() => {
    api.overviewStats().then(setStats).catch((e) => setStatsError(String(e)));
    api.topConversations(10).then((r) => setTop(r.items)).catch((e) => setTopError(String(e)));
    api.overviewHeatmap().then((r) => setHeatmap(r.grid)).catch(() => {});
  }, []);

  useEffect(() => {
    // Ignore-stale-response guard: rapidly toggling granularity fires a new
    // fetch before the previous one resolves; without this, an older
    // response arriving after a newer one could overwrite fresher data.
    let cancelled = false;
    api
      .overviewVolume(granularity)
      .then((r) => {
        if (!cancelled) setVolume(r.points);
      })
      .catch((e) => {
        if (!cancelled) setVolumeError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [granularity]);

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>Your texting life</h1>
      {statsError ? (
        <div className={styles.error}>Couldn't load stats: {statsError}</div>
      ) : (
        <div className={styles.statGrid} aria-busy={stats === null}>
          {stats ? (
            <>
              <StatCard label="Total messages" value={stats.total_messages.toLocaleString()} />
              <StatCard label="Conversations" value={stats.total_conversations.toLocaleString()} />
              <StatCard label="Participants" value={stats.total_participants.toLocaleString()} />
              <StatCard
                label="Date range"
                compact
                value={
                  stats.date_range_start && stats.date_range_end
                    ? `${formatDate(stats.date_range_start)} – ${formatDate(stats.date_range_end)}`
                    : "—"
                }
              />
            </>
          ) : (
            <>
              <StatCardSkeleton />
              <StatCardSkeleton />
              <StatCardSkeleton />
              <StatCardSkeleton />
            </>
          )}
        </div>
      )}
      {volumeError ? (
        <div className={styles.error}>Couldn't load volume: {volumeError}</div>
      ) : (
        <VolumeChart points={volume} granularity={granularity} onGranularityChange={setGranularity} />
      )}
      {heatmap && <Heatmap grid={heatmap} title="When everyone texts" />}
      {topError ? (
        <div className={styles.error}>Couldn't load top conversations: {topError}</div>
      ) : (
        <TopConversationsChart items={top} />
      )}
    </div>
  );
}
