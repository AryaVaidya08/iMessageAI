import type { HistogramBucket } from "../api/client";
import cardStyles from "./ParticipantStatsCard.module.css";
import styles from "./ReplyTimeHistogram.module.css";

export function ReplyTimeHistogram({ buckets }: { buckets: HistogramBucket[] }) {
  const total = buckets.reduce((sum, b) => sum + b.count, 0);
  if (total === 0) return null;
  const max = Math.max(...buckets.map((b) => b.count));

  return (
    <div className={cardStyles.section}>
      <div className={cardStyles.sectionLabel}>Reply time distribution</div>
      <div className={styles.bars}>
        {buckets.map((b) => (
          <div key={b.label} className={styles.row} title={`${b.label}: ${b.count.toLocaleString()} replies`}>
            <span className={styles.label}>{b.label}</span>
            <div className={styles.track}>
              <div className={styles.fill} style={{ width: `${max ? (b.count / max) * 100 : 0}%` }} />
            </div>
            <span className={`${styles.count} mono`}>{b.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
