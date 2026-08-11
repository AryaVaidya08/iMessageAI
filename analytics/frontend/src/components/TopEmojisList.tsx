import type { EmojiCount } from "../api/client";
import styles from "./ParticipantStatsCard.module.css";

export function TopEmojisList({ emojis }: { emojis: EmojiCount[] }) {
  if (emojis.length === 0) return null;
  return (
    <div className={styles.section}>
      <div className={styles.sectionLabel}>Top emojis</div>
      <div className={styles.chips}>
        {emojis.map((e) => (
          <span key={e.emoji} className={styles.chip}>
            {e.emoji} <span className="mono">{e.count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
