import styles from "./StatCard.module.css";

export function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.card}>
      <div className={styles.label}>{label}</div>
      <div className={`${styles.value} mono`}>{value}</div>
    </div>
  );
}

export function StatCardSkeleton() {
  return (
    <div className={`${styles.card} ${styles.skeleton}`}>
      <div className={styles.skeletonLine} style={{ width: "60%" }} />
      <div className={`${styles.skeletonLine} ${styles.skeletonValue}`} style={{ width: "40%" }} />
    </div>
  );
}
