import { useEffect, useMemo, useRef, useState } from "react";

import type { MergeParticipantOut } from "../api/client";
import styles from "./ContactSelect.module.css";

interface ContactSelectProps {
  label: string;
  participants: MergeParticipantOut[];
  value: MergeParticipantOut | null;
  onChange: (participant: MergeParticipantOut) => void;
  excludeId?: string;
}

export function ContactSelect({ label, participants, value, onChange, excludeId }: ContactSelectProps) {
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
    return participants
      .filter((p) => p.id !== excludeId)
      .filter((p) => {
        if (!needle) return true;
        return (
          p.display_name.toLowerCase().includes(needle) ||
          p.handle.toLowerCase().includes(needle) ||
          (p.phone_num ?? "").toLowerCase().includes(needle) ||
          (p.email ?? "").toLowerCase().includes(needle)
        );
      })
      .slice(0, 50);
  }, [participants, query, excludeId]);

  return (
    <div className={styles.root} ref={rootRef}>
      <span className={styles.label}>{label}</span>
      <button type="button" className={styles.trigger} onClick={() => setOpen((o) => !o)}>
        {value ? (
          <span className={styles.selected}>
            <span className={styles.selectedName}>{value.display_name}</span>
            <span className={styles.selectedHandle}>{value.phone_num ?? value.email ?? value.handle}</span>
          </span>
        ) : (
          <span className={styles.placeholder}>Select a contact…</span>
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
            {filtered.length === 0 && <li className={styles.empty}>No contacts match.</li>}
            {filtered.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className={styles.option}
                  onClick={() => {
                    onChange(p);
                    setOpen(false);
                    setQuery("");
                  }}
                >
                  <span className={styles.optionName}>{p.display_name}</span>
                  <span className={styles.optionHandle}>{p.phone_num ?? p.email ?? p.handle}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
