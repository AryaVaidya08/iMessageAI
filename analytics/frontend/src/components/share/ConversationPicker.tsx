import { useEffect, useState } from "react";
import { FiX } from "react-icons/fi";

import { api, type ConversationSummary } from "../../api/client";
import { CONV_SECTIONS, type ConvSection, type SelectedConversation } from "../../lib/shareTypes";
import styles from "./Picker.module.css";

export function ConversationPicker({
  selected,
  onAdd,
  onRemove,
  onToggleSection,
}: {
  selected: Map<string, SelectedConversation>;
  onAdd: (c: ConversationSummary) => void;
  onRemove: (id: string) => void;
  onToggleSection: (id: string, section: ConvSection) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ConversationSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(() => {
      api
        .conversations({ search: query || undefined, sort: "recent", page: 1, page_size: 20 })
        .then((r) => {
          if (!cancelled) setResults(r.items);
        })
        .catch(() => {});
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query]);

  return (
    <div className={styles.section}>
      <h2 className={styles.sectionTitle}>Conversations</h2>
      <input
        className={styles.search}
        placeholder="Search conversations…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ul className={styles.resultsList}>
        {results
          .filter((c) => !selected.has(c.id))
          .map((c) => (
            <li key={c.id}>
              <button type="button" className={styles.resultRow} onClick={() => onAdd(c)}>
                <span className={styles.resultName}>{c.display_name}</span>
                <span className={styles.resultMeta}>{c.message_count.toLocaleString()} messages</span>
              </button>
            </li>
          ))}
        {results.length === 0 && <li className={styles.empty}>No conversations match.</li>}
      </ul>

      {selected.size > 0 && (
        <ul className={styles.selectedList}>
          {[...selected.values()].map((sel) => (
            <li key={sel.id} className={styles.selectedItem}>
              <div className={styles.selectedHeader}>
                <span className={styles.selectedName}>{sel.display_name}</span>
                <button type="button" className={styles.removeButton} onClick={() => onRemove(sel.id)} aria-label={`Remove ${sel.display_name}`}>
                  <FiX size={14} />
                </button>
              </div>
              <div className={styles.sectionChips}>
                {CONV_SECTIONS.filter((s) => s.key !== "announcements" || sel.is_group_chat).map((s) => (
                  <label key={s.key} className={styles.chip}>
                    <input type="checkbox" checked={sel.sections.has(s.key)} onChange={() => onToggleSection(sel.id, s.key)} />
                    {s.label}
                  </label>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
