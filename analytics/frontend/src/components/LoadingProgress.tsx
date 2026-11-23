import { useEffect, useState } from "react";

import styles from "./LoadingProgress.module.css";

/**
 * Progress bar for loads that report no real progress. Fills along an
 * ease-out curve toward ~92% and holds there until the component unmounts
 * (i.e. the data arrived and the caller swaps it for content).
 */
export function LoadingProgress({ label, expectedMs = 4000 }: { label?: string; expectedMs?: number }) {
  const [pct, setPct] = useState(0);

  useEffect(() => {
    const start = performance.now();
    const id = window.setInterval(() => {
      const t = (performance.now() - start) / expectedMs;
      setPct(98 * (1 - Math.exp(-3 * t)));
    }, 100);
    return () => window.clearInterval(id);
  }, [expectedMs]);

  return (
    <div className={styles.wrap} aria-busy="true">
      {label && <div className={styles.label}>{label}</div>}
      <div
        className={styles.track}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-label={label}
      >
        <div className={styles.fill} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
