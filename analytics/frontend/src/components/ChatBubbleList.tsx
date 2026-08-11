import { useEffect, useLayoutEffect, useMemo, useRef } from "react";

import type { ParticipantOut } from "../api/client";
import { useInfiniteMessages } from "../hooks/useInfiniteMessages";
import { MessageBubble } from "./MessageBubble";
import styles from "./ChatBubbleList.module.css";

const PASTELS = ["var(--bubble-other-1)", "var(--bubble-other-2)", "var(--bubble-other-3)", "var(--bubble-other-4)"];

function buildParticipantColorMap(participants: ParticipantOut[]): Record<string, string> {
  const map: Record<string, string> = {};
  let i = 0;
  for (const p of participants) {
    if (p.is_me) {
      map[p.id] = "var(--bubble-me)";
    } else {
      map[p.id] = PASTELS[i % PASTELS.length];
      i += 1;
    }
  }
  return map;
}

export function ChatBubbleList({
  conversationId,
  participants,
}: {
  conversationId: string;
  participants: ParticipantOut[];
}) {
  const { messages, loadMore, loading, error, hasMore } = useInfiniteMessages(conversationId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const prevScrollHeight = useRef(0);

  const meIds = useMemo(() => new Set(participants.filter((p) => p.is_me).map((p) => p.id)), [participants]);
  const colorFor = useMemo(() => buildParticipantColorMap(participants), [participants]);

  useEffect(() => {
    const sentinel = topSentinelRef.current;
    const scrollEl = scrollRef.current;
    if (!sentinel || !scrollEl) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading) {
          prevScrollHeight.current = scrollEl.scrollHeight;
          loadMore();
        }
      },
      { root: scrollEl, threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loading, loadMore]);

  useLayoutEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    if (prevScrollHeight.current) {
      scrollEl.scrollTop = scrollEl.scrollHeight - prevScrollHeight.current;
      prevScrollHeight.current = 0;
    } else if (messages.length > 0) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }
  }, [messages]);

  return (
    <div className={styles.scroll} ref={scrollRef} tabIndex={0} role="log" aria-label="Message history">
      <div ref={topSentinelRef} />
      {error && <div className={styles.error}>Couldn't load messages: {error}</div>}
      {messages.length === 0 && !loading && !error && (
        <div className={styles.empty}>No messages in this conversation.</div>
      )}
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} color={colorFor[m.sender_id]} isMe={meIds.has(m.sender_id)} />
      ))}
    </div>
  );
}
