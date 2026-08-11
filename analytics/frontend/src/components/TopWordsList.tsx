import type { WordCount } from "../api/client";
import styles from "./ParticipantStatsCard.module.css";

export function TopWordsList({ words }: { words: WordCount[] }) {
  if (words.length === 0) return null;
  return (
    <div className={styles.section}>
      <div className={styles.sectionLabel}>Top words</div>
      <div className={styles.chips}>
        {words.map((w) => (
          <span key={w.word} className={styles.chip}>
            {w.word} <span className="mono">{w.count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
