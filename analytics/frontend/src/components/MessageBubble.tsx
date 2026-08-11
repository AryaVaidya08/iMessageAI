import type { MessageOut } from "../api/client";
import styles from "./MessageBubble.module.css";

function formatTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
    hour: "numeric",
    minute: "2-digit",
  });
}

export function MessageBubble({
  message,
  color,
  isMe,
  highlighted,
}: {
  message: MessageOut;
  color: string;
  isMe: boolean;
  highlighted?: boolean;
}) {
  return (
    <div
      id={`message-${message.id}`}
      className={`${styles.row} ${isMe ? styles.rowMe : styles.rowOther}`}
    >
      <div
        className={`${styles.bubble} ${highlighted ? styles.bubbleHighlighted : ""}`}
        style={{ background: color, color: isMe ? "#fff" : "#1D1D1F" }}
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
