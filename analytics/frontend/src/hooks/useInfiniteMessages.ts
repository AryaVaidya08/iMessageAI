import { useCallback, useEffect, useRef, useState } from "react";

import { api, type MessageOut } from "../api/client";

export function useInfiniteMessages(
  conversationId: string,
  initialJump?: { messageId: string; nonce: number } | null
) {
  const [messages, setMessages] = useState<MessageOut[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [newerCursor, setNewerCursor] = useState<string | null>(null);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every jump-to-anchor so the UI knows to scroll to `anchorId`
  // instead of the usual "stick to top/bottom" scroll behavior.
  const [jumpVersion, setJumpVersion] = useState(0);
  const [anchorId, setAnchorId] = useState<string | null>(null);

  // Refs, not state, so they're read/written synchronously (state updates only
  // land on the next render). loadingRef is a true same-tick mutex (fixes a
  // double-invocation race from e.g. an IntersectionObserver firing twice
  // before a re-render). generationRef is a monotonic counter bumped on every
  // conversation reset/jump -- NOT a conversationId value comparison, because
  // two different load attempts can share the same conversationId (an A -> B
  // -> A navigation produces two distinct "for A" attempts, and a jump
  // invalidates any load already in flight); only a per-attempt token can
  // tell them apart and discard the stale one's response.
  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);
  const generationRef = useRef(0);
  // Guards the initial-load decision (jump to `initialJump` vs. load the latest
  // tail) so it fires exactly once per mount/conversation. Without this, React
  // 18 StrictMode's dev-only double-invoke of mount effects re-runs
  // resetToLatest a second time *between* the two decision-effect passes,
  // which re-arms loadingOlderRef and lets a second, unrelated "load the tail"
  // call win the generation race against the jump's own in-flight fetch --
  // the jump's response arrives, finds itself stale, and is silently dropped.
  // Gating both branches behind one ref (reset by resetToLatest itself, so
  // both passes agree on which branch to take) keeps the two passes
  // consistent instead of racing each other.
  const initialLoadStartedRef = useRef(false);

  const loadOlder = useCallback(async () => {
    if (!conversationId) return;
    if (loadingOlderRef.current) return;
    if (hasLoadedOnce && olderCursor === null) return;
    loadingOlderRef.current = true;
    setLoading(true);
    setError(null);
    const requestGeneration = generationRef.current;
    try {
      const page = await api.messages(conversationId, hasLoadedOnce ? olderCursor ?? undefined : undefined);
      if (generationRef.current !== requestGeneration) return;
      setMessages((prev) => [...page.items, ...prev]);
      setOlderCursor(page.older_cursor);
      if (!hasLoadedOnce) setNewerCursor(page.newer_cursor);
      setHasLoadedOnce(true);
    } catch (e) {
      if (generationRef.current !== requestGeneration) return;
      setError(e instanceof Error ? e.message : "failed to load messages");
    } finally {
      if (generationRef.current === requestGeneration) {
        loadingOlderRef.current = false;
        setLoading(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, olderCursor, hasLoadedOnce]);

  const loadNewer = useCallback(async () => {
    if (!conversationId) return;
    if (loadingNewerRef.current) return;
    if (newerCursor === null) return;
    loadingNewerRef.current = true;
    setLoading(true);
    setError(null);
    const requestGeneration = generationRef.current;
    try {
      const page = await api.messagesAfter(conversationId, newerCursor);
      if (generationRef.current !== requestGeneration) return;
      setMessages((prev) => [...prev, ...page.items]);
      setNewerCursor(page.items.length > 0 ? page.newer_cursor : null);
    } catch (e) {
      if (generationRef.current !== requestGeneration) return;
      setError(e instanceof Error ? e.message : "failed to load messages");
    } finally {
      if (generationRef.current === requestGeneration) {
        loadingNewerRef.current = false;
        setLoading(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, newerCursor]);

  const resetToLatest = useCallback(() => {
    generationRef.current += 1;
    loadingOlderRef.current = false;
    loadingNewerRef.current = false;
    initialLoadStartedRef.current = false;
    setMessages([]);
    setOlderCursor(null);
    setNewerCursor(null);
    setHasLoadedOnce(false);
    setLoading(false);
    setError(null);
    setAnchorId(null);
  }, []);

  useEffect(() => {
    resetToLatest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  const jumpToAnchor = useCallback(
    async (fetcher: () => Promise<{ items: MessageOut[]; older_cursor: string | null; newer_cursor: string | null }>, targetId: string | null) => {
      if (!conversationId) return;
      // Invalidate any in-flight loadOlder/loadNewer/jump from before this
      // one and drop what's currently on screen immediately, rather than
      // leaving stale messages (and their scroll-position bookkeeping)
      // in place until the new window arrives -- otherwise a fast old ->
      // new jump can render a mix of both windows out of order.
      generationRef.current += 1;
      const requestGeneration = generationRef.current;
      loadingOlderRef.current = true;
      loadingNewerRef.current = true;
      setMessages([]);
      setOlderCursor(null);
      setNewerCursor(null);
      setAnchorId(null);
      setLoading(true);
      setError(null);
      try {
        const page = await fetcher();
        if (generationRef.current !== requestGeneration) return;
        setMessages(page.items);
        setOlderCursor(page.older_cursor);
        setNewerCursor(page.newer_cursor);
        setHasLoadedOnce(true);
        if (page.items.length === 0) {
          setError("No messages found");
          setAnchorId(null);
        } else {
          setAnchorId(targetId ?? page.items[0].id);
        }
        setJumpVersion((v) => v + 1);
      } catch (e) {
        if (generationRef.current !== requestGeneration) return;
        setError(e instanceof Error ? e.message : "failed to load messages");
      } finally {
        if (generationRef.current === requestGeneration) {
          loadingOlderRef.current = false;
          loadingNewerRef.current = false;
          setLoading(false);
        }
      }
    },
    [conversationId]
  );

  useEffect(() => {
    if (initialLoadStartedRef.current || hasLoadedOnce) return;
    initialLoadStartedRef.current = true;
    if (initialJump) {
      jumpToAnchor(() => api.messagesAround(conversationId, initialJump.messageId), initialJump.messageId);
    } else {
      loadOlder();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, hasLoadedOnce, initialJump]);

  const jumpToDate = useCallback(
    (date: string) => jumpToAnchor(() => api.messagesForDate(conversationId, date), null),
    [conversationId, jumpToAnchor]
  );

  const jumpToMessage = useCallback(
    (messageId: string) => jumpToAnchor(() => api.messagesAround(conversationId, messageId), messageId),
    [conversationId, jumpToAnchor]
  );

  return {
    messages,
    loadOlder,
    loadNewer,
    jumpToDate,
    jumpToMessage,
    resetToLatest,
    jumpVersion,
    anchorId,
    loading,
    error,
    hasOlder: olderCursor !== null || !hasLoadedOnce,
    hasNewer: newerCursor !== null,
  };
}
