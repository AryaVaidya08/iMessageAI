import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api, type ConversationListResponse } from "../api/client";
import styles from "./ConversationsListPage.module.css";

export function ConversationsListPage() {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"count" | "recent">("recent");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ConversationListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPage(1);
  }, [search, sort]);

  useEffect(() => {
    // Ignore-stale-response guard: changing search/sort while on page > 1 takes
    // React two render cycles to settle (the page-reset effect above can't
    // retroactively change what this effect already captured), firing an extra
    // fetch for the old page number alongside the correct one -- and fast typing
    // can make responses arrive out of order. Either way, only the most recent
    // effect instance's response should ever reach setData.
    let cancelled = false;
    api
      .conversations({ search, sort, page, page_size: 25 })
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [search, sort, page]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>Conversations</h1>
      <div className={styles.controls}>
        <input
          className={styles.search}
          placeholder="Search by name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className={styles.segmented}>
          <button
            type="button"
            className={sort === "recent" ? styles.segmentActive : styles.segment}
            onClick={() => setSort("recent")}
          >
            Recent
          </button>
          <button
            type="button"
            className={sort === "count" ? styles.segmentActive : styles.segment}
            onClick={() => setSort("count")}
          >
            Most messages
          </button>
        </div>
      </div>
      {error && <div className={styles.error}>Couldn't load conversations: {error}</div>}
      <ul className={styles.list}>
        {data?.items.map((c) => (
          <li key={c.id}>
            <Link to={`/conversations/${c.id}`} className={styles.row}>
              <span className={styles.name}>{c.display_name}</span>
              <span className={`${styles.count} mono`}>{c.message_count.toLocaleString()}</span>
            </Link>
          </li>
        ))}
      </ul>
      {data && data.items.length === 0 && (
        <p className={styles.empty}>No conversations match "{search}".</p>
      )}
      <div className={styles.pagination}>
        <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
          Previous
        </button>
        <span className="mono">
          {page} / {totalPages}
        </span>
        <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}
