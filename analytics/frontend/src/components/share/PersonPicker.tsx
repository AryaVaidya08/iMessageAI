import { useEffect, useState } from "react";
import { FiX } from "react-icons/fi";

import { api, type PersonSummary } from "../../api/client";
import { PERSON_SECTIONS, type PersonSection, type SelectedPerson } from "../../lib/shareTypes";
import styles from "./Picker.module.css";

export function PersonPicker({
  selected,
  onAdd,
  onRemove,
  onToggleSection,
}: {
  selected: Map<string, SelectedPerson>;
  onAdd: (p: PersonSummary) => void;
  onRemove: (id: string) => void;
  onToggleSection: (id: string, section: PersonSection) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PersonSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(() => {
      api
        .people({ search: query || undefined, sort: "recent", page: 1, page_size: 20 })
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
      <h2 className={styles.sectionTitle}>People</h2>
      <input
        className={styles.search}
        placeholder="Search people…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ul className={styles.resultsList}>
        {results
          .filter((p) => !selected.has(p.id))
          .map((p) => (
            <li key={p.id}>
              <button type="button" className={styles.resultRow} onClick={() => onAdd(p)}>
                <span className={styles.resultName}>{p.display_name}</span>
                <span className={styles.resultMeta}>{p.message_count.toLocaleString()} messages</span>
              </button>
            </li>
          ))}
        {results.length === 0 && <li className={styles.empty}>No people match.</li>}
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
                {PERSON_SECTIONS.map((s) => (
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
