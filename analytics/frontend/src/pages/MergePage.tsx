import { useEffect, useState } from "react";

import {
  api,
  type MergeConversationHistoryEntry,
  type MergeConversationOut,
  type MergeHistoryEntry,
  type MergeParticipantOut,
} from "../api/client";
import { ContactSelect } from "../components/ContactSelect";
import { ConversationSelect } from "../components/ConversationSelect";
import styles from "./MergePage.module.css";

type Mode = "contacts" | "conversations";

function formatMergedAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function MergePage() {
  const [mode, setMode] = useState<Mode>("contacts");

  const [participants, setParticipants] = useState<MergeParticipantOut[] | null>(null);
  const [contactsLoadError, setContactsLoadError] = useState<string | null>(null);
  const [contactHistory, setContactHistory] = useState<MergeHistoryEntry[] | null>(null);
  const [keepContact, setKeepContact] = useState<MergeParticipantOut | null>(null);
  const [removeContact, setRemoveContact] = useState<MergeParticipantOut | null>(null);
  const [mergingContacts, setMergingContacts] = useState(false);
  const [contactStatus, setContactStatus] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  const [conversations, setConversations] = useState<MergeConversationOut[] | null>(null);
  const [conversationsLoadError, setConversationsLoadError] = useState<string | null>(null);
  const [conversationHistory, setConversationHistory] = useState<MergeConversationHistoryEntry[] | null>(null);
  const [keepConversation, setKeepConversation] = useState<MergeConversationOut | null>(null);
  const [removeConversation, setRemoveConversation] = useState<MergeConversationOut | null>(null);
  const [mergingConversations, setMergingConversations] = useState(false);
  const [conversationStatus, setConversationStatus] = useState<{ kind: "success" | "error"; message: string } | null>(
    null
  );

  function loadParticipants() {
    api
      .participants()
      .then((r) => setParticipants(r.participants))
      .catch((e) => setContactsLoadError(String(e)));
  }

  function loadContactHistory() {
    api
      .mergeHistory()
      .then((r) => setContactHistory(r.items))
      // A missing merge history (no merge has happened yet, or the merged db
      // doesn't exist) isn't a real error -- treat it the same as "no merges".
      .catch(() => setContactHistory([]));
  }

  function loadConversations() {
    api
      .conversationsForMerge()
      .then((r) => setConversations(r.conversations))
      .catch((e) => setConversationsLoadError(String(e)));
  }

  function loadConversationHistory() {
    api
      .conversationMergeHistory()
      .then((r) => setConversationHistory(r.items))
      .catch(() => setConversationHistory([]));
  }

  useEffect(loadParticipants, []);
  useEffect(loadContactHistory, []);
  useEffect(loadConversations, []);
  useEffect(loadConversationHistory, []);

  async function handleMergeContacts() {
    if (!keepContact || !removeContact) return;
    const confirmed = window.confirm(
      `Merge "${removeContact.display_name}" (${removeContact.phone_num ?? removeContact.email}) into "${keepContact.display_name}" (${keepContact.phone_num ?? keepContact.email})?\n\n` +
        `All of ${removeContact.display_name}'s messages will be reassigned to ${keepContact.display_name} in the merged copy of the database. The original database is never modified.`
    );
    if (!confirmed) return;

    setMergingContacts(true);
    setContactStatus(null);
    try {
      await api.mergeContacts(keepContact.id, removeContact.id);
      setContactStatus({
        kind: "success",
        message: `Merged "${removeContact.display_name}" into "${keepContact.display_name}".`,
      });
      setKeepContact(null);
      setRemoveContact(null);
      loadParticipants();
      loadContactHistory();
    } catch (e) {
      setContactStatus({ kind: "error", message: String(e) });
    } finally {
      setMergingContacts(false);
    }
  }

  async function handleMergeConversations() {
    if (!keepConversation || !removeConversation) return;
    const confirmed = window.confirm(
      `Merge "${removeConversation.display_name}" (${removeConversation.subtext}) into "${keepConversation.display_name}" (${keepConversation.subtext})?\n\n` +
        `All of ${removeConversation.display_name}'s messages will be reassigned to ${keepConversation.display_name} in the merged copy of the database. The original database is never modified.`
    );
    if (!confirmed) return;

    setMergingConversations(true);
    setConversationStatus(null);
    try {
      await api.mergeConversations(keepConversation.id, removeConversation.id);
      setConversationStatus({
        kind: "success",
        message: `Merged "${removeConversation.display_name}" into "${keepConversation.display_name}".`,
      });
      setKeepConversation(null);
      setRemoveConversation(null);
      loadConversations();
      loadConversationHistory();
    } catch (e) {
      setConversationStatus({ kind: "error", message: String(e) });
    } finally {
      setMergingConversations(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.headingRow}>
        <h1 className={styles.heading}>Merge</h1>

        <div className={styles.modePicker}>
          <button
            type="button"
            className={mode === "contacts" ? styles.modeButtonActive : styles.modeButton}
            onClick={() => setMode("contacts")}
          >
            Contacts
          </button>
          <button
            type="button"
            className={mode === "conversations" ? styles.modeButtonActive : styles.modeButton}
            onClick={() => setMode("conversations")}
          >
            Conversations
          </button>
        </div>
      </div>

      {mode === "contacts" ? (
        <>
          <p className={styles.description}>
            If the same person shows up as two separate contacts (e.g. a phone number and an email), merge them
            here. This never edits the original database — it writes to a separate merged copy, which the rest of
            the app will use automatically once it exists.
          </p>

          {contactsLoadError && <div className={styles.error}>Couldn't load contacts: {contactsLoadError}</div>}

          {contactStatus && (
            <div className={contactStatus.kind === "success" ? styles.success : styles.error}>
              {contactStatus.message}
            </div>
          )}

          <div className={styles.mergeRow}>
            <ContactSelect
              label="Contact #1 (kept)"
              participants={participants ?? []}
              value={keepContact}
              onChange={setKeepContact}
              excludeId={removeContact?.id}
            />
            <span className={styles.arrow}>&larr;</span>
            <ContactSelect
              label="Contact #2 (merged away)"
              participants={participants ?? []}
              value={removeContact}
              onChange={setRemoveContact}
              excludeId={keepContact?.id}
            />
            <button
              type="button"
              className={styles.mergeButton}
              disabled={!keepContact || !removeContact || mergingContacts}
              onClick={handleMergeContacts}
            >
              {mergingContacts ? "Merging…" : "Merge?"}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className={styles.description}>
            If the same conversation shows up twice (e.g. after merging two contacts that used to be separate
            threads), merge them here. This never edits the original database — it writes to a separate merged
            copy, which the rest of the app will use automatically once it exists.
          </p>

          {conversationsLoadError && (
            <div className={styles.error}>Couldn't load conversations: {conversationsLoadError}</div>
          )}

          {conversationStatus && (
            <div className={conversationStatus.kind === "success" ? styles.success : styles.error}>
              {conversationStatus.message}
            </div>
          )}

          <div className={styles.mergeRow}>
            <ConversationSelect
              label="Conversation #1 (kept)"
              conversations={conversations ?? []}
              value={keepConversation}
              onChange={setKeepConversation}
              excludeId={removeConversation?.id}
            />
            <span className={styles.arrow}>&larr;</span>
            <ConversationSelect
              label="Conversation #2 (merged away)"
              conversations={conversations ?? []}
              value={removeConversation}
              onChange={setRemoveConversation}
              excludeId={keepConversation?.id}
            />
            <button
              type="button"
              className={styles.mergeButton}
              disabled={!keepConversation || !removeConversation || mergingConversations}
              onClick={handleMergeConversations}
            >
              {mergingConversations ? "Merging…" : "Merge?"}
            </button>
          </div>
        </>
      )}

      <div className={styles.historyColumns}>
        <div className={styles.historyColumn}>
          <h2 className={styles.subheading}>Contact merge history</h2>
          {contactHistory !== null && contactHistory.length === 0 && (
            <p className={styles.empty}>No contacts merged so far.</p>
          )}
          {contactHistory !== null && contactHistory.length > 0 && (
            <ul className={styles.historyList}>
              {contactHistory.map((h, i) => (
                <li key={i} className={styles.historyRow}>
                  <div className={styles.historyContacts}>
                    <span className={`${styles.historyName} ${styles.historyKept}`}>
                      {h.keep_display_name}
                      <span className={styles.historyHandle}>
                        {" "}
                        ({h.keep_handle}, {h.keep_message_count} messages)
                      </span>
                    </span>
                    <span className={styles.arrow}>&larr;</span>
                    <span className={`${styles.historyName} ${styles.historyRemoved}`}>
                      {h.remove_display_name}
                      <span className={styles.historyHandle}>
                        {" "}
                        ({h.remove_handle}, {h.remove_message_count} messages)
                      </span>
                    </span>
                  </div>
                  <span className={styles.historyDate}>{formatMergedAt(h.merged_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className={styles.historyColumn}>
          <h2 className={styles.subheading}>Conversation merge history</h2>
          {conversationHistory !== null && conversationHistory.length === 0 && (
            <p className={styles.empty}>No conversations merged so far.</p>
          )}
          {conversationHistory !== null && conversationHistory.length > 0 && (
            <ul className={styles.historyList}>
              {conversationHistory.map((h, i) => (
                <li key={i} className={styles.historyRow}>
                  <div className={styles.historyContacts}>
                    <span className={`${styles.historyName} ${styles.historyKept}`}>
                      {h.keep_display_name}
                      <span className={styles.historyHandle}> ({h.keep_message_count} messages)</span>
                    </span>
                    <span className={styles.arrow}>&larr;</span>
                    <span className={`${styles.historyName} ${styles.historyRemoved}`}>
                      {h.remove_display_name}
                      <span className={styles.historyHandle}> ({h.remove_message_count} messages)</span>
                    </span>
                  </div>
                  <span className={styles.historyDate}>{formatMergedAt(h.merged_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
