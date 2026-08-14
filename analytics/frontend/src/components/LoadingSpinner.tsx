import styles from "./LoadingSpinner.module.css";

export function LoadingSpinner({ label }: { label?: string }) {
  return (
    <div className={styles.wrap} aria-busy="true">
      <span className={styles.spinner} />
      {label}
    </div>
  );
}
