import { useEffect, useState } from "react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { Granularity, VolumePoint } from "../api/client";
import styles from "./VolumeChart.module.css";

const GRANULARITIES: Granularity[] = ["day", "week", "month"];

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const listener = () => setReduced(mq.matches);
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
  }, []);

  return reduced;
}

export function VolumeChart({
  points,
  granularity,
  onGranularityChange,
}: {
  points: VolumePoint[];
  granularity: Granularity;
  onGranularityChange: (g: Granularity) => void;
}) {
  const reducedMotion = usePrefersReducedMotion();

  return (
    <div className={styles.card}>
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
        <BarChart data={points}>
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
            isAnimationActive={!reducedMotion}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
