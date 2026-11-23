import { memo, useMemo } from "react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { aggregateSum } from "../lib/downsample";

import type { Granularity, VolumePoint } from "../api/client";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import styles from "./VolumeChart.module.css";

const GRANULARITIES: Granularity[] = ["day", "week", "month"];

export const VolumeChart = memo(function VolumeChart({
  points,
  granularity,
  onGranularityChange,
  animate = true,
}: {
  points: VolumePoint[];
  granularity: Granularity;
  onGranularityChange: (g: Granularity) => void;
  animate?: boolean;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const data = useMemo(() => aggregateSum(points, (p) => p.count, (p, count) => ({ ...p, count })), [points]);

  return (
    <div className={styles.card} data-share-block="true">
      <div className={styles.header}>
        <h3 className={styles.title}>Message volume</h3>
        <div className={styles.segmented}>
          {GRANULARITIES.map((g) => (
            <button
              key={g}
              type="button"
              className={g === granularity ? styles.segmentActive : styles.segment}
              onClick={() => onGranularityChange(g)}
            >
              {g}
            </button>
          ))}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={data}>
          <XAxis dataKey="bucket" stroke="var(--color-text-secondary)" fontSize={12} />
          <YAxis stroke="var(--color-text-secondary)" fontSize={12} allowDecimals={false} />
          <Tooltip
            contentStyle={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: 12,
            }}
          />
          <Bar
            dataKey="count"
            fill="var(--color-accent)"
            radius={[6, 6, 0, 0]}
            isAnimationActive={animate && !reducedMotion}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
});
