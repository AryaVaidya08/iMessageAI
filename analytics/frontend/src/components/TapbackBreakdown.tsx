import type { TapbackCount } from "../api/client";
import styles from "./ParticipantStatsCard.module.css";

function TapbackColumn({ label, items }: { label: string; items: TapbackCount[] }) {
  return (
    <div>
      <div className={styles.subLabel}>{label}</div>
      {items.length === 0 ? (
        <div className={styles.subEmpty}>—</div>
      ) : (
        items.map((t) => (
          <div key={t.action} className={styles.tapbackRow}>
            <span>{t.action}</span>
            <span className="mono">{t.count}</span>
          </div>
        ))
      )}
    </div>
  );
}

export function TapbackBreakdown({ given, received }: { given: TapbackCount[]; received: TapbackCount[] }) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionLabel}>Tapbacks</div>
      <div className={styles.columns}>
        <TapbackColumn label="Given" items={given} />
        <TapbackColumn label="Received" items={received} />
      </div>
    </div>
  );
}
