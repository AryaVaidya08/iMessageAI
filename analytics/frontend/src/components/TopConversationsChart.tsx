import { Link } from "react-router-dom";

import type { TopConversationOut } from "../api/client";
import styles from "./TopConversationsChart.module.css";

export function TopConversationsChart({ items }: { items: TopConversationOut[] }) {
  const max = Math.max(...items.map((i) => i.message_count), 1);
  return (
    <div className={styles.card}>
      <h3 className={styles.title}>Top conversations</h3>
      <ul className={styles.list}>
        {items.map((item) => (
          <li key={item.conversation_id} className={styles.row}>
            <Link to={`/conversations/${item.conversation_id}`} className={styles.name} title={item.display_name}>
              {item.display_name}
            </Link>
            <div className={styles.barTrack}>
              <div className={styles.barFill} style={{ width: `${(item.message_count / max) * 100}%` }} />
            </div>
            <span className={`${styles.count} mono`}>{item.message_count.toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
