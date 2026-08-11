import { useState } from "react";
import styles from "./Heatmap.module.css";

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOUR_MARKERS = new Set([0, 6, 12, 18]);

// Compact axis-style formatting (1, 10, 100, 1.2k, 12.1k, 1.2M) for the
// in-cell labels, where there's only room for a handful of characters.
function formatCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) {
    const v = count / 1000;
    return `${v < 10 ? v.toFixed(1) : Math.round(v)}k`;
  }
  const v = count / 1_000_000;
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}M`;
}

// Quantile-bucketed levels (GitHub-contribution-graph style) rather than
// fixed absolute thresholds, since the same component renders grids ranging
// from a single participant's activity to the whole database's.
function computeLevels(grid: number[][]): number[][] {
  const values = grid
    .flat()
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  if (values.length === 0) {
    return grid.map((row) => row.map(() => 0));
  }
  const quantile = (p: number) => values[Math.min(values.length - 1, Math.floor(p * (values.length - 1)))];
  const q1 = quantile(0.25);
  const q2 = quantile(0.5);
  const q3 = quantile(0.75);
  return grid.map((row) =>
    row.map((v) => {
      if (v === 0) return 0;
      if (v <= q1) return 1;
      if (v <= q2) return 2;
      if (v <= q3) return 3;
      return 4;
    })
  );
}

export function Heatmap({ grid, title }: { grid: number[][]; title?: string }) {
  const levels = computeLevels(grid);
  const [showNumbers, setShowNumbers] = useState(true);

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        {title ? <h3 className={styles.title}>{title}</h3> : <span />}
        <button
          type="button"
          className={styles.toggleButton}
          onClick={() => setShowNumbers((v) => !v)}
        >
          {showNumbers ? "Hide numbers" : "Show numbers"}
        </button>
      </div>
      <div className={styles.gridWrap}>
        <div className={styles.hourRow}>
          {Array.from({ length: 24 }, (_, hour) => (
            <span key={hour} className={styles.hourLabel}>
              {HOUR_MARKERS.has(hour) ? `${hour}:00` : ""}
            </span>
          ))}
        </div>
        {DOW_LABELS.map((label, dow) => (
          <div key={dow} className={styles.row}>
            <span className={styles.rowLabel}>{label}</span>
            {grid[dow].map((count, hour) => (
              <div
                key={hour}
                className={styles.cell}
                data-level={levels[dow][hour]}
                title={`${label} ${hour}:00 — ${count.toLocaleString()} message${count === 1 ? "" : "s"}`}
              >
                {showNumbers && count > 0 && (
                  <span className={styles.cellLabel}>{formatCount(count)}</span>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className={styles.legend}>
        <span className={styles.legendLabel}>Less</span>
        {[0, 1, 2, 3, 4].map((lvl) => (
          <div key={lvl} className={styles.legendSwatch} data-level={lvl} />
        ))}
        <span className={styles.legendLabel}>More</span>
      </div>
    </div>
  );
}
