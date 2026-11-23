import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent, ReactNode } from "react";
import { Link } from "react-router-dom";

import { DebugConsole } from "../components/DebugConsole";
import {
  deleteAllData,
  getSyncInfo,
  isIngestRunning,
  startIngest,
  subscribeIngest,
  type SyncInfo,
} from "../engine/appState";
import styles from "./HomePage.module.css";

const hasOpfs = typeof navigator !== "undefined" && !!navigator.storage && "getDirectory" in navigator.storage;

function DropZone(props: {
  title: string;
  hint: string;
  files: File[];
  multiple?: boolean;
  accept?: string;
  testId: string;
  onFiles: (f: File[]) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const fs = Array.from(e.dataTransfer.files);
    if (fs.length) props.onFiles(props.multiple ? fs : fs.slice(0, 1));
  };
  return (
    <div
      className={`${styles.zone} ${over ? styles.zoneOver : ""} ${props.files.length ? styles.zoneFilled : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      onClick={() => ref.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && ref.current?.click()}
    >
      <strong>{props.title}</strong>
      <span className={styles.muted}>{props.hint}</span>
      {props.files.length > 0 && (
        <span className={styles.picked}>
          {props.files.length === 1 ? props.files[0].name : `${props.files.length} files selected`}
        </span>
      )}
      <input
        ref={ref}
        data-testid={props.testId}
        type="file"
        hidden
        multiple={props.multiple}
        accept={props.accept}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          const fs = Array.from(e.target.files ?? []);
          if (fs.length) props.onFiles(fs);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className={styles.details}>
      <summary>{title}</summary>
      {children}
    </details>
  );
}

function Explore() {
  return (
    <div className={styles.links}>
      <Link to="/overview">Overview</Link>
      <Link to="/conversations">Conversations</Link>
      <Link to="/people">People</Link>
      <Link to="/merge">Merge</Link>
      <Link to="/share">Share</Link>
    </div>
  );
}

export function HomePage() {
  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState<SyncInfo | null>(null);
  const [ingesting, setIngesting] = useState(isIngestRunning());
  const [chatDb, setChatDb] = useState<File[]>([]);
  const [contacts, setContacts] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lowStorage, setLowStorage] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);

  const refresh = useCallback(async () => {
    setInfo(await getSyncInfo());
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    return subscribeIngest((e) => {
      if (e.type === "error") {
        setError(String(e.message ?? "Unknown error"));
        setIngesting(false);
      }
      if (e.type === "done") {
        setIngesting(false);
        setShowUpload(false);
        setChatDb([]);
        void refresh();
      }
    });
  }, [refresh]);

  useEffect(() => {
    navigator.storage?.estimate?.().then((est) => {
      if (est.quota != null && est.usage != null && est.quota - est.usage < 2 * 1024 ** 3) {
        setLowStorage(
          `Only ${Math.round((est.quota - est.usage) / 1024 ** 2)} MB of browser storage is available. Large chat.db files may not fit.`,
        );
      }
    });
  }, []);

  const start = async () => {
    if (!chatDb[0]) return;
    setError(null);
    setIngesting(true);
    try {
      await startIngest({ chatDb: chatDb[0], contacts });
    } catch (e) {
      setIngesting(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const wipe = async () => {
    if (!window.confirm("Delete all imported messages and merges from this browser? This cannot be undone.")) return;
    await deleteAllData();
    setShowUpload(false);
    await refresh();
  };

  if (loading) return <div className={styles.page}>Loading...</div>;

  const uploader = (
    <>
      <div className={styles.zones}>
        <DropZone
          title="1. chat.db"
          hint="Drop your Messages database here or click to browse"
          files={chatDb}
          testId="chatdb-input"
          onFiles={setChatDb}
        />
        <DropZone
          title="2. Contacts (optional)"
          hint="Drop one or more AddressBook-v22.abcddb files"
          files={contacts}
          multiple
          accept=".abcddb"
          testId="contacts-input"
          onFiles={setContacts}
        />
      </div>
      <p className={styles.muted}>
        Have a whole AddressBook folder?{" "}
        <label className={styles.linkBtn}>
          Choose a folder
          <input
            type="file"
            hidden
            multiple
            data-testid="contacts-folder-input"
            {...({ webkitdirectory: "" } as Record<string, string>)}
            onChange={(e) => {
              const fs = Array.from(e.target.files ?? []).filter((f) => f.name.endsWith(".abcddb"));
              if (fs.length) setContacts(fs);
              e.target.value = "";
            }}
          />
        </label>
      </p>
      <button className={styles.primary} disabled={!chatDb[0] || ingesting} onClick={start}>
        {info ? "Sync new messages" : "Start analysis"}
      </button>
    </>
  );

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>iMessage Analytics</h1>
      <p className={styles.lead}>Explore your message history: volume, relationships, reply times and more.</p>

      <p className={styles.privacy}>
        Privacy: everything runs inside this browser tab. Your files are never uploaded or sent to any server.
      </p>
      {!hasOpfs && (
        <p className={styles.warn}>
          This browser does not support the Origin Private File System, which is required to store your data. Use a
          recent version of Chrome, Edge or Safari.
        </p>
      )}
      {lowStorage && <p className={styles.warn}>{lowStorage}</p>}
      {error && <p className={styles.error}>{error}</p>}

      {ingesting && (
        <section className={styles.card}>
          <h2>Importing...</h2>
          <DebugConsole />
          <h3>Explore while it loads</h3>
          <Explore />
        </section>
      )}

      {!ingesting && info && (
        <section className={styles.card}>
          <h2>Your data</h2>
          <div className={styles.stats}>
            <div>
              <b>{info.conversations.toLocaleString()}</b>
              <span>conversations</span>
            </div>
            <div>
              <b>{info.messages.toLocaleString()}</b>
              <span>messages</span>
            </div>
            <div>
              <b>{info.lastSyncedAt ? new Date(info.lastSyncedAt).toLocaleString() : "never"}</b>
              <span>last synced</span>
            </div>
          </div>
          <Explore />
          <div className={styles.actions}>
            <button className={styles.secondary} onClick={() => setShowUpload((v) => !v)}>
              Sync new messages: upload chat.db again
            </button>
            <button className={styles.danger} onClick={wipe}>
              Delete all data
            </button>
          </div>
          <p className={styles.muted}>
            Uploading chat.db again only processes new or changed messages, so it is much faster than the first import.
          </p>
          {showUpload && uploader}
        </section>
      )}

      {!ingesting && !info && (
        <>
          <section className={styles.card}>
            <h2>Get started</h2>
            {uploader}
          </section>
          <section className={styles.card}>
            <h2>Where do I find my files?</h2>
            <Section title="chat.db (your messages)">
              <ol>
                <li>
                  Open Finder, press <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> (Go to Folder).
                </li>
                <li>
                  Enter <code>~/Library/Messages</code> and press Return.
                </li>
                <li>
                  Select <code>chat.db</code> and drop it above.
                </li>
              </ol>
              <p>
                If macOS or the browser cannot read it, grant Full Disk Access to your browser (System Settings,
                Privacy and Security, Full Disk Access), then restart the browser. Or copy <code>chat.db</code> to your
                Desktop first and upload the copy.
              </p>
            </Section>
            <Section title="Contacts (optional, shows names instead of numbers)">
              <ol>
                <li>
                  Press <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> in Finder.
                </li>
                <li>
                  Enter <code>~/Library/Application Support/AddressBook</code>. Upload{" "}
                  <code>AddressBook-v22.abcddb</code>.
                </li>
                <li>
                  Also upload each <code>Sources/*/AddressBook-v22.abcddb</code> (iCloud, Google and other accounts),
                  or choose the whole AddressBook folder.
                </li>
              </ol>
            </Section>
          </section>
        </>
      )}
    </div>
  );
}
