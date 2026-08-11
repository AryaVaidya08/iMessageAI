import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { GroupSizePoint } from "../api/client";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import styles from "./GroupSizeChart.module.css";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function GroupSizeChart({ points }: { points: GroupSizePoint[] }) {
  const reducedMotion = usePrefersReducedMotion();
  if (points.length === 0) return null;

  return (
    <div className={styles.card}>
      <h3 className={styles.title}>Group size over time</h3>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={points}>
          <XAxis
            dataKey="datetime"
            stroke="var(--color-text-secondary)"
            fontSize={12}
            tickFormatter={formatDate}
            minTickGap={40}
          />
          <YAxis stroke="var(--color-text-secondary)" fontSize={12} allowDecimals={false} width={30} />
          <Tooltip
            contentStyle={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: 12,
            }}
            labelFormatter={(v) => formatDate(String(v))}
          />
          <Line
            type="stepAfter"
            dataKey="size"
            stroke="var(--color-accent)"
            strokeWidth={2}
            dot={false}
            isAnimationActive={!reducedMotion}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
