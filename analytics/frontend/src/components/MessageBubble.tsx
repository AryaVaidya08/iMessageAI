import type { MessageOut } from "../api/client";
import styles from "./MessageBubble.module.css";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function MessageBubble({ message, color, isMe }: { message: MessageOut; color: string; isMe: boolean }) {
  return (
    <div className={`${styles.row} ${isMe ? styles.rowMe : styles.rowOther}`}>
      <div
        className={styles.bubble}
        style={{ background: color, color: isMe ? "#fff" : "var(--color-text-primary)" }}
      >
        {!isMe && <div className={styles.sender}>{message.sender_display_name}</div>}
        <div className={styles.text}>{message.text}</div>
        <time className={`${styles.time} mono`} dateTime={message.timestamp}>{formatTime(message.timestamp)}</time>
        {message.tapbacks.length > 0 && (
          <div className={styles.tapbacks}>
            {message.tapbacks.map((t) => (
              <span key={t.reactor_id} className={styles.tapback} title={`${t.display_name}: ${t.action}`}>
                {t.action}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
