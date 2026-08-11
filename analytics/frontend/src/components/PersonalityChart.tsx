import type { PersonalityTrait } from "../api/client";
import styles from "./PersonalityChart.module.css";

export function PersonalityChart({ traits }: { traits: PersonalityTrait[] }) {
  if (traits.length === 0) return null;

  return (
    <div className={styles.section}>
      <div className={styles.bars}>
        {traits.map((t) => (
          <div key={t.trait} className={styles.row}>
            <span className={styles.traitLabel}>{t.trait}</span>
            <div className={styles.track}>
              <div className={styles.fill} style={{ width: `${Math.min(t.percentage, 100)}%` }} />
            </div>
            <span className={`${styles.value} mono`}>{Math.round(t.percentage)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
