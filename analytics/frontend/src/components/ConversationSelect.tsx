import { useEffect, useMemo, useRef, useState } from "react";

import type { MergeConversationOut } from "../api/client";
import styles from "./ContactSelect.module.css";

interface ConversationSelectProps {
  label: string;
  conversations: MergeConversationOut[];
  value: MergeConversationOut | null;
  onChange: (conversation: MergeConversationOut) => void;
  excludeId?: string;
}

export function ConversationSelect({ label, conversations, value, onChange, excludeId }: ConversationSelectProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return conversations
      .filter((c) => c.id !== excludeId)
      .filter((c) => {
        if (!needle) return true;
        return c.display_name.toLowerCase().includes(needle) || c.subtext.toLowerCase().includes(needle);
      })
      .slice(0, 50);
  }, [conversations, query, excludeId]);

  return (
    <div className={styles.root} ref={rootRef}>
      <span className={styles.label}>{label}</span>
      <button type="button" className={styles.trigger} onClick={() => setOpen((o) => !o)}>
        {value ? (
          <span className={styles.selected}>
            <span className={styles.selectedName}>{value.display_name}</span>
            <span className={styles.selectedHandle}>
              {value.subtext} · {value.message_count.toLocaleString()} messages
            </span>
          </span>
        ) : (
          <span className={styles.placeholder}>Select a conversation…</span>
        )}
      </button>
      {open && (
        <div className={styles.panel}>
          <input
            autoFocus
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className={styles.search}
            placeholder="Search by name, phone, or email…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <ul className={styles.list}>
            {filtered.length === 0 && <li className={styles.empty}>No conversations match.</li>}
            {filtered.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className={styles.option}
                  onClick={() => {
                    onChange(c);
                    setOpen(false);
                    setQuery("");
                  }}
                >
                  <span className={styles.optionName}>{c.display_name}</span>
                  <span className={styles.optionHandle}>
                    {c.subtext} · {c.message_count.toLocaleString()} messages
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
