import { Link } from "react-router-dom";

import styles from "./NotFoundPage.module.css";

export function NotFoundPage() {
  return (
    <div className={styles.page}>
      <p className={styles.code}>404</p>
      <h1 className={styles.heading}>This conversation doesn't exist</h1>
      <p className={styles.body}>The page you're looking for was moved, deleted, or never sent.</p>
      <Link to="/" className={styles.link}>
        Back to overview
      </Link>
    </div>
  );
}
