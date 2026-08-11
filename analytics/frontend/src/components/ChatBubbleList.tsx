import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { api, type ParticipantOut, type SearchMessageResult } from "../api/client";
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

function formatResultDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function ChatBubbleList({
  conversationId,
  participants,
}: {
  conversationId: string;
  participants: ParticipantOut[];
}) {
  const {
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
    hasOlder,
    hasNewer,
  } = useInfiniteMessages(conversationId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  const prevScrollHeight = useRef(0);
  const stickToBottom = useRef(true);
  const prevJumpVersion = useRef(0);

  const [dateInput, setDateInput] = useState("");
  const [viewingAnchor, setViewingAnchor] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchMessageResult[] | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  const meIds = useMemo(() => new Set(participants.filter((p) => p.is_me).map((p) => p.id)), [participants]);
  const colorFor = useMemo(() => buildParticipantColorMap(participants), [participants]);

  const handleJumpToDate = () => {
    if (!dateInput) return;
    setViewingAnchor(true);
    setSearchOpen(false);
    // Drop any pending "maintain scroll position" adjustment from a
    // loadOlder/loadNewer call that was in flight when the jump fired --
    // it refers to the pre-jump DOM and would otherwise scroll the newly
    // jumped-to window to a bogus offset.
    prevScrollHeight.current = 0;
    jumpToDate(dateInput);
  };

  const handleSelectSearchResult = (messageId: string) => {
    setViewingAnchor(true);
    setSearchOpen(false);
    prevScrollHeight.current = 0;
    jumpToMessage(messageId);
  };

  const handleBackToLatest = () => {
    setViewingAnchor(false);
    setDateInput("");
    stickToBottom.current = true;
    prevScrollHeight.current = 0;
    resetToLatest();
  };

  useEffect(() => {
    // ConversationDetailPage keeps this component mounted across an
    // id-only navigation (A -> B), so local UI state from the previous
    // conversation must be cleared explicitly rather than relying on remount.
    setViewingAnchor(false);
    setDateInput("");
    setSearchQuery("");
    setSearchResults(null);
    setSearchOpen(false);
    stickToBottom.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .searchMessages(conversationId, searchQuery.trim())
        .then((r) => {
          if (!cancelled) setSearchResults(r.items);
        })
        .catch(() => {
          if (!cancelled) setSearchResults([]);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [conversationId, searchQuery]);

  // Top sentinel: load older messages when scrolled near the top.
  useEffect(() => {
    const sentinel = topSentinelRef.current;
    const scrollEl = scrollRef.current;
    if (!sentinel || !scrollEl) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasOlder && !loading) {
          prevScrollHeight.current = scrollEl.scrollHeight;
          loadOlder();
        }
      },
      { root: scrollEl, threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasOlder, loading, loadOlder]);

  // Bottom sentinel: load newer messages when scrolled near the bottom
  // (only relevant once we've jumped away from the live tail of the chat).
  useEffect(() => {
    const sentinel = bottomSentinelRef.current;
    const scrollEl = scrollRef.current;
    if (!sentinel || !scrollEl) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasNewer && !loading) {
          loadNewer();
        }
      },
      { root: scrollEl, threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasNewer, loading, loadNewer]);

  useLayoutEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    if (jumpVersion !== prevJumpVersion.current) {
      prevJumpVersion.current = jumpVersion;
      stickToBottom.current = false;
      if (anchorId) {
        const el = document.getElementById(`message-${anchorId}`);
        el?.scrollIntoView({ block: "center" });
      } else {
        scrollEl.scrollTop = 0;
      }
      return;
    }

    if (prevScrollHeight.current) {
      scrollEl.scrollTop = scrollEl.scrollHeight - prevScrollHeight.current;
      prevScrollHeight.current = 0;
    } else if (stickToBottom.current && messages.length > 0) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }
  }, [messages, jumpVersion, anchorId]);

  return (
    <div>
      <div className={styles.toolbar}>
        <div className={styles.toolbarGroup}>
          <input
            type="date"
            className={styles.dateInput}
            value={dateInput}
            onChange={(e) => setDateInput(e.target.value)}
            aria-label="Jump to date"
          />
          <button type="button" className={styles.jumpButton} onClick={handleJumpToDate} disabled={!dateInput}>
            Jump to day
          </button>
          {viewingAnchor && (
            <button type="button" className={styles.jumpButton} onClick={handleBackToLatest}>
              Back to latest
            </button>
          )}
        </div>
        <div className={styles.toolbarGroup}>
          <div className={styles.searchWrap}>
            <input
              type="search"
              className={styles.searchInput}
              placeholder="Search messages…"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setSearchOpen(true);
              }}
              onFocus={() => setSearchOpen(true)}
              onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
              aria-label="Search messages"
            />
            {searchOpen && searchQuery.trim() && (
              <div className={styles.searchResults}>
                {searchResults === null && <div className={styles.searchEmpty}>Searching…</div>}
                {searchResults?.length === 0 && <div className={styles.searchEmpty}>No matches</div>}
                {searchResults?.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className={styles.searchResultItem}
                    onMouseDown={() => handleSelectSearchResult(r.id)}
                  >
                    <div className={styles.searchResultDate}>{formatResultDate(r.timestamp)}</div>
                    <div className={styles.searchResultText}>{r.text}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className={styles.scroll} ref={scrollRef} tabIndex={0} role="log" aria-label="Message history">
        <div ref={topSentinelRef} />
        {error && <div className={styles.error}>Couldn't load messages: {error}</div>}
        {messages.length === 0 && !loading && !error && (
          <div className={styles.empty}>No messages in this conversation.</div>
        )}
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            color={colorFor[m.sender_id]}
            isMe={meIds.has(m.sender_id)}
            highlighted={jumpVersion > 0 && m.id === anchorId}
          />
        ))}
        <div ref={bottomSentinelRef} />
      </div>
    </div>
  );
}
