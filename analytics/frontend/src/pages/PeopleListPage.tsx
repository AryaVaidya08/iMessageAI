import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api, type PeopleListResponse } from "../api/client";
import { LoadingSpinner } from "../components/LoadingSpinner";
import styles from "./PeopleListPage.module.css";

type Sort = "count" | "recent" | "conversations";
type Order = "asc" | "desc";

export function PeopleListPage() {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>("recent");
  const [order, setOrder] = useState<Order>("desc");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<PeopleListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggleSort = (nextSort: Sort) => {
    if (sort === nextSort) {
      setOrder((o) => (o === "desc" ? "asc" : "desc"));
    } else {
      setSort(nextSort);
      setOrder("desc");
    }
  };

  useEffect(() => {
    setPage(1);
  }, [search, sort, order]);

  useEffect(() => {
    // Ignore-stale-response guard: mirrors ConversationsListPage -- changing
    // search/sort while on page > 1 can fire an extra fetch for the old page
    // number, and fast typing can make responses arrive out of order.
    let cancelled = false;
    api
      .people({ search, sort, order, page, page_size: 25 })
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [search, sort, order, page]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>People</h1>
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
            onClick={() => {
              setSort("recent");
              setOrder("desc");
            }}
          >
            Recent
          </button>
          <button
            type="button"
            className={sort === "count" ? styles.segmentActive : styles.segment}
            onClick={() => toggleSort("count")}
          >
            Messages
            {sort === "count" && (
              <span className={`${styles.sortArrow} ${order === "asc" ? styles.sortArrowAsc : ""}`}>▼</span>
            )}
          </button>
          <button
            type="button"
            className={sort === "conversations" ? styles.segmentActive : styles.segment}
            onClick={() => toggleSort("conversations")}
          >
            Conversations
            {sort === "conversations" && (
              <span className={`${styles.sortArrow} ${order === "asc" ? styles.sortArrowAsc : ""}`}>▼</span>
            )}
          </button>
        </div>
      </div>
      {error ? (
        <div className={styles.error}>Couldn't load people: {error}</div>
      ) : data === null ? (
        <LoadingSpinner label="Loading people…" />
      ) : (
        <ul className={styles.list}>
          {data.items.map((p) => (
            <li key={p.id}>
              <Link to={`/people/${p.id}`} className={styles.row}>
                <span className={styles.nameCol}>
                  <span className={styles.name}>{p.display_name}</span>
                  {p.handle !== p.display_name && <span className={styles.handle}>{p.handle}</span>}
                </span>
                <span className={styles.statCol}>
                  <span className={`${styles.count} mono`}>{p.message_count.toLocaleString()}</span>
                  <span className={styles.statLabel}>messages</span>
                </span>
                <span className={styles.statCol}>
                  <span className={`${styles.count} mono`}>{p.conversation_count.toLocaleString()}</span>
                  <span className={styles.statLabel}>conversations</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {data && data.items.length === 0 && <p className={styles.empty}>No people match "{search}".</p>}
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
