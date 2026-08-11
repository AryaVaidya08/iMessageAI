import { useCallback, useEffect, useRef, useState } from "react";

import { api, type MessageOut } from "../api/client";

export function useInfiniteMessages(conversationId: string) {
  const [messages, setMessages] = useState<MessageOut[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs, not state, so they're read/written synchronously (state updates only
  // land on the next render). loadingRef is a true same-tick mutex (fixes a
  // double-invocation race from e.g. an IntersectionObserver firing twice
  // before a re-render). generationRef is a monotonic counter bumped on every
  // conversation reset -- NOT a conversationId value comparison, because two
  // different load attempts can share the same conversationId (an A -> B -> A
  // navigation produces two distinct "for A" attempts); only a per-attempt
  // token can tell them apart and discard the older one's response.
  const loadingRef = useRef(false);
  const generationRef = useRef(0);

  const loadMore = useCallback(async () => {
    if (!conversationId) return;
    if (loadingRef.current) return;
    if (hasLoadedOnce && nextCursor === null) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    const requestGeneration = generationRef.current;
    try {
      const page = await api.messages(conversationId, hasLoadedOnce ? nextCursor ?? undefined : undefined);
      if (generationRef.current !== requestGeneration) return;
      setMessages((prev) => [...page.items, ...prev]);
      setNextCursor(page.next_cursor);
      setHasLoadedOnce(true);
    } catch (e) {
      if (generationRef.current !== requestGeneration) return;
      setError(e instanceof Error ? e.message : "failed to load messages");
    } finally {
      if (generationRef.current === requestGeneration) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, nextCursor, hasLoadedOnce]);

  useEffect(() => {
    generationRef.current += 1;
    loadingRef.current = false;
    setMessages([]);
    setNextCursor(null);
    setHasLoadedOnce(false);
    setLoading(false);
    setError(null);
  }, [conversationId]);

  useEffect(() => {
    if (!hasLoadedOnce) {
      loadMore();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, hasLoadedOnce]);

  return { messages, loadMore, loading, error, hasMore: nextCursor !== null || !hasLoadedOnce };
}
