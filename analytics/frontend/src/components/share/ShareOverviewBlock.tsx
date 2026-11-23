import { useState } from "react";

import type { Granularity } from "../../api/client";
import type { OverviewShareData } from "../../lib/shareTypes";
import { Heatmap } from "../Heatmap";
import { StatCard } from "../StatCard";
import { TopConversationsChart } from "../TopConversationsChart";
import { VolumeChart } from "../VolumeChart";
import styles from "./ShareBlocks.module.css";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "2-digit", month: "numeric", day: "numeric" });
}

export function ShareOverviewBlock({ data }: { data: OverviewShareData }) {
  const [granularity, setGranularity] = useState<Granularity>("week");

  return (
    <div className={styles.block}>
      <div data-share-block="true">
        <div className={styles.blockHeader}>
          <div>
            <div className={styles.blockKicker}>Overview</div>
            <h2 className={styles.blockTitle}>Your texting life</h2>
          </div>
        </div>
        <div className={styles.statRow}>
          <StatCard label="Total messages" value={data.stats.total_messages.toLocaleString()} />
          <StatCard label="Conversations" value={data.stats.total_conversations.toLocaleString()} />
          <StatCard label="Participants" value={data.stats.total_participants.toLocaleString()} />
          <StatCard
            label="Date range"
            compact
            value={
              data.stats.date_range_start && data.stats.date_range_end
                ? `${formatDate(data.stats.date_range_start)} – ${formatDate(data.stats.date_range_end)}`
                : "—"
            }
          />
        </div>
      </div>
      <VolumeChart points={data.volume[granularity]} granularity={granularity} onGranularityChange={setGranularity} animate={false} />
      <Heatmap grid={data.heatmap} title="When everyone texts" />
      <TopConversationsChart items={data.topConversations} />
    </div>
  );
}
