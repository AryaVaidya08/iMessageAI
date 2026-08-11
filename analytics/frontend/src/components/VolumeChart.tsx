import { Bar, BarChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { Granularity, JoinLeaveEvent, VolumePoint } from "../api/client";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import styles from "./VolumeChart.module.css";

const GRANULARITIES: Granularity[] = ["day", "week", "month"];

// Mirrors the backend's bucket_volume() bucketing rule so a join/leave
// event's exact timestamp maps onto the same x-axis category the volume
// bars use, regardless of granularity.
function bucketFor(dateIso: string, granularity: Granularity): string {
  const day = dateIso.slice(0, 10);
  if (granularity === "day") return day;
  if (granularity === "month") return day.slice(0, 7);
  const d = new Date(`${day}T00:00:00`);
  const dow = d.getDay(); // 0=Sunday
  const daysSinceMonday = dow === 0 ? 6 : dow - 1;
  const monday = new Date(d);
  monday.setDate(d.getDate() - daysSinceMonday);
  return monday.toISOString().slice(0, 10);
}

interface AnnotationSummary {
  bucket: string;
  joined: number;
  left: number;
}

function summarizeAnnotations(events: JoinLeaveEvent[], granularity: Granularity): AnnotationSummary[] {
  const byBucket = new Map<string, AnnotationSummary>();
  for (const e of events) {
    const bucket = bucketFor(e.datetime, granularity);
    const entry = byBucket.get(bucket) ?? { bucket, joined: 0, left: 0 };
    if (e.kind === "joined") entry.joined += 1;
    else entry.left += 1;
    byBucket.set(bucket, entry);
  }
  return [...byBucket.values()];
}

export function VolumeChart({
  points,
  granularity,
  onGranularityChange,
  joinLeaveEvents,
}: {
  points: VolumePoint[];
  granularity: Granularity;
  onGranularityChange: (g: Granularity) => void;
  joinLeaveEvents?: JoinLeaveEvent[];
}) {
  const reducedMotion = usePrefersReducedMotion();
  const annotations = joinLeaveEvents ? summarizeAnnotations(joinLeaveEvents, granularity) : [];

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
          {annotations.map((a) => (
            <ReferenceLine
              key={a.bucket}
              x={a.bucket}
              stroke="var(--color-text-secondary)"
              strokeDasharray="3 3"
              label={{
                value: [a.joined ? `+${a.joined}` : "", a.left ? `−${a.left}` : ""].filter(Boolean).join(" "),
                position: "top",
                fontSize: 10,
                fill: "var(--color-text-secondary)",
              }}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
