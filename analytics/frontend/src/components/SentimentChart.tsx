import { Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { SentimentPoint } from "../api/client";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import styles from "./SentimentChart.module.css";

export function SentimentChart({ points }: { points: SentimentPoint[] }) {
  const reducedMotion = usePrefersReducedMotion();
  if (points.length === 0) return null;

  return (
    <div className={styles.section}>
      <ResponsiveContainer width="100%" height={120}>
        <LineChart data={points} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
          <XAxis dataKey="bucket" stroke="var(--color-text-secondary)" fontSize={10} tick={false} />
          <YAxis domain={[-1, 1]} hide />
          <ReferenceLine y={0} stroke="var(--color-border)" />
          <Tooltip
            contentStyle={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: 12,
              fontSize: 12,
            }}
            formatter={(value: number) => value.toFixed(2)}
          />
          <Line
            type="monotone"
            dataKey="score"
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
