import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import styles from "./RecordCard.module.css";

export interface RecordCardListItem {
  label: string;
  value: string;
}

export function RecordCard({
  title,
  headline,
  subtext,
  items,
  linkTo,
  linkLabel = "View conversation →",
}: {
  title: string;
  headline?: string;
  subtext?: ReactNode;
  items?: RecordCardListItem[];
  linkTo?: string;
  linkLabel?: string;
}) {
  return (
    <div className={styles.card}>
      <h3 className={styles.title}>{title}</h3>
      {headline && <div className={styles.headline}>{headline}</div>}
      {subtext && <div className={styles.subtext}>{subtext}</div>}
      {items && items.length > 0 && (
        <ul className={styles.list}>
          {items.map((item, i) => (
            <li key={i} className={styles.listRow}>
              <span className={styles.listLabel}>{item.label}</span>
              <span className={`${styles.listValue} mono`}>{item.value}</span>
            </li>
          ))}
        </ul>
      )}
      {linkTo && (
        <Link to={linkTo} className={styles.link}>
          {linkLabel}
        </Link>
      )}
    </div>
  );
}

export function RecordCardSkeleton() {
  return (
    <div className={`${styles.card} ${styles.skeleton}`}>
      <div className={styles.skeletonLine} style={{ width: "50%" }} />
      <div className={`${styles.skeletonLine} ${styles.skeletonHeadline}`} style={{ width: "70%" }} />
      <div className={styles.skeletonLine} style={{ width: "40%" }} />
    </div>
  );
}

export function RecordCardEmpty({ title }: { title: string }) {
  return (
    <div className={styles.card}>
      <h3 className={styles.title}>{title}</h3>
      <div className={styles.subtext}>Not enough data yet.</div>
    </div>
  );
}
