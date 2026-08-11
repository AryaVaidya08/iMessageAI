import { useEffect, useState } from "react";

import { api, type MergeHistoryEntry, type MergeParticipantOut } from "../api/client";
import { ContactSelect } from "../components/ContactSelect";
import styles from "./MergeContactsPage.module.css";

function formatMergedAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function MergeContactsPage() {
  const [participants, setParticipants] = useState<MergeParticipantOut[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [history, setHistory] = useState<MergeHistoryEntry[] | null>(null);
  const [keep, setKeep] = useState<MergeParticipantOut | null>(null);
  const [remove, setRemove] = useState<MergeParticipantOut | null>(null);
  const [merging, setMerging] = useState(false);
  const [status, setStatus] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  function loadParticipants() {
    api
      .participants()
      .then((r) => setParticipants(r.participants))
      .catch((e) => setLoadError(String(e)));
  }

  function loadHistory() {
    api
      .mergeHistory()
      .then((r) => setHistory(r.items))
      // A missing merge history (no merge has happened yet, or the merged db
      // doesn't exist) isn't a real error -- treat it the same as "no merges".
      .catch(() => setHistory([]));
  }

  useEffect(loadParticipants, []);
  useEffect(loadHistory, []);

  async function handleMerge() {
    if (!keep || !remove) return;
    const confirmed = window.confirm(
      `Merge "${remove.display_name}" (${remove.phone_num ?? remove.email}) into "${keep.display_name}" (${keep.phone_num ?? keep.email})?\n\n` +
        `All of ${remove.display_name}'s messages will be reassigned to ${keep.display_name} in the merged copy of the database. The original database is never modified.`
    );
    if (!confirmed) return;

    setMerging(true);
    setStatus(null);
    try {
      await api.mergeContacts(keep.id, remove.id);
      setStatus({ kind: "success", message: `Merged "${remove.display_name}" into "${keep.display_name}".` });
      setKeep(null);
      setRemove(null);
      loadParticipants();
      loadHistory();
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
    } finally {
      setMerging(false);
    }
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>Merge Contacts</h1>
      <p className={styles.description}>
        If the same person shows up as two separate contacts (e.g. a phone number and an email), merge them here.
        This never edits the original database — it writes to a separate merged copy, which the rest of the app
        will use automatically once it exists.
      </p>

      {loadError && <div className={styles.error}>Couldn't load contacts: {loadError}</div>}

      {status && <div className={status.kind === "success" ? styles.success : styles.error}>{status.message}</div>}

      <div className={styles.mergeRow}>
        <ContactSelect
          label="Contact #1 (kept)"
          participants={participants ?? []}
          value={keep}
          onChange={setKeep}
          excludeId={remove?.id}
        />
        <span className={styles.arrow}>&larr;</span>
        <ContactSelect
          label="Contact #2 (merged away)"
          participants={participants ?? []}
          value={remove}
          onChange={setRemove}
          excludeId={keep?.id}
        />
        <button type="button" className={styles.mergeButton} disabled={!keep || !remove || merging} onClick={handleMerge}>
          {merging ? "Merging…" : "Merge?"}
        </button>
      </div>

      <h2 className={styles.subheading}>Merge history</h2>
      {history !== null && history.length === 0 && (
        <p className={styles.empty}>No contacts merged so far.</p>
      )}
      {history !== null && history.length > 0 && (
        <ul className={styles.historyList}>
          {history.map((h, i) => (
            <li key={i} className={styles.historyRow}>
              <div className={styles.historyContacts}>
                <span className={styles.historyName}>
                  {h.remove_display_name}
                  <span className={styles.historyHandle}> ({h.remove_handle})</span>
                </span>
                <span className={styles.arrow}>&rarr;</span>
                <span className={styles.historyName}>
                  {h.keep_display_name}
                  <span className={styles.historyHandle}> ({h.keep_handle})</span>
                </span>
              </div>
              <span className={styles.historyDate}>{formatMergedAt(h.merged_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
