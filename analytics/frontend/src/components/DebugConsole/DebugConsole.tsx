import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FaRegCopy } from "react-icons/fa";

import type { IngestSubscribe } from "../../engine/protocol";
import styles from "./DebugConsole.module.css";
import { formatDuration, formatLogLine, type IngestState } from "./reducer";
import { useIngestEvents } from "./useIngestEvents";

const ROW_H = 18;
const OVERSCAN = 10;
const STORAGE_KEY = "debugConsole.collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function Bar({ value, total, error }: { value: number; total: number; error?: boolean }) {
  const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return (
    <div className={styles.bar} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={error ? styles.barFillError : styles.barFill} style={{ width: `${pct}%` }} />
    </div>
  );
}

function LogView({ log }: { log: IngestState["log"] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(200);
  const [pinned, setPinned] = useState(true);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setHeight(el.clientHeight);
    if (pinned) {
      el.scrollTop = el.scrollHeight;
      setScrollTop(el.scrollTop);
    }
  }, [log, pinned]);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < ROW_H * 2);
  }, []);

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(log.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);
  return (
    <div className={styles.logWrap}>
      <div ref={ref} className={styles.log} onScroll={onScroll} data-testid="log">
        <div style={{ height: log.length * ROW_H, position: "relative" }}>
          {log.slice(start, end).map((l, i) => (
            <div
              key={l.id}
              className={`${styles.line} ${styles[l.level]}`}
              style={{ top: (start + i) * ROW_H, height: ROW_H }}
            >
              {formatLogLine(l)}
            </div>
          ))}
        </div>
      </div>
      {!pinned && (
        <button
          type="button"
          className={styles.resume}
          onClick={() => {
            setPinned(true);
            const el = ref.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          Paused - jump to latest
        </button>
      )}
    </div>
  );
}

export function DebugConsole({
  subscribe,
  forceOpen = false,
  inline = false,
  hidden = false,
}: {
  subscribe: IngestSubscribe;
  forceOpen?: boolean;
  /** Render in the page flow (home page) instead of as the floating dock; stays open after the import ends. */
  inline?: boolean;
  /** Keep tracking events but render nothing (used for the dock while the inline console is on screen). */
  hidden?: boolean;
}) {
  const { state: s } = useIngestEvents(subscribe);
  const [collapsed, setCollapsed] = useState(() => (inline ? false : readCollapsed()));
  const wasRunning = useRef(false);
  // Expand automatically when an import starts so progress is visible without hunting for it.
  useEffect(() => {
    if (s.running && !wasRunning.current) setCollapsed(false);
    wasRunning.current = s.running;
  }, [s.running]);
  // Tuck the dock away a few seconds after a successful import so it stops covering the page.
  useEffect(() => {
    if (inline || !s.finished || s.errorCount > 0) return;
    const t = setTimeout(() => setCollapsed(true), 4000);
    return () => clearTimeout(t);
  }, [inline, s.finished, s.errorCount]);
  const open = forceOpen || !collapsed;
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (inline) return; // the inline console's open state is not the dock's remembered preference
    try {
      localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [inline, collapsed]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(s.log.map(formatLogLine).join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };

  const o = s.overall;
  const pct = o.messagesTotal > 0 ? Math.round((o.messagesDone / o.messagesTotal) * 100) : 0;
  const status = s.finished ? "Done - ingest complete" : s.running ? (s.phaseLabel ?? s.phase ?? "Working") : "Idle";
  const mem = s.memory;
  const complete = s.finished && s.errorCount === 0;

  if (hidden) return null;
  // On the home page there is nothing to show until an import has started.
  if (inline && !s.running && !s.finished && s.runs === 0) return null;
  // The floating dock on the other pages only appears while an import is running (or has failed, so an error is
  // never hidden). Once the import is finished or the app is idle it stays out of the way; the /debug page forces it open.
  if (!inline && !forceOpen && !s.running && !(s.errorCount > 0 && !s.finished)) return null;

  return (
    <aside
      className={`${styles.dock} ${inline ? styles.inline : ""}`}
      aria-label="Ingest debug console"
      data-testid="debug-console"
      data-state={s.finished ? "done" : s.running ? "running" : "idle"}
      data-run={s.runs}
    >
      <button type="button" className={styles.header} onClick={() => setCollapsed((c) => !c)} aria-expanded={open}>
        <span
          className={`${styles.dot} ${s.errorCount ? styles.dotError : complete ? styles.dotDone : s.running ? styles.dotRun : ""}`}
          data-testid="debug-console-dot"
        />
        <span className={styles.title}>Import</span>
        <span className={styles.status}>
          {status}
          {s.running || s.finished ? ` - ${pct}%` : ""}
        </span>
        {s.errorCount > 0 && <span className={styles.errBadge}>{s.errorCount} errors</span>}
        <span className={styles.chev}>{open ? "▼" : "▲"}</span>
      </button>
      {open && (
        <div className={styles.body}>
          <div className={`${styles.grid} ${s.currentChat ? "" : styles.gridNoCurrent}`}>
            <section className={styles.memory}>
              <div className={styles.label}>Memory</div>
              {mem ? (
                <>
                  <div className={styles.row}>
                    <span className={styles.num}>
                      {Math.round(mem.usedMB)} / {Math.round(mem.limitMB)} MB
                    </span>
                  </div>
                  <Bar value={mem.usedMB} total={mem.limitMB} error={mem.limitMB > 0 && mem.usedMB / mem.limitMB > 0.85} />
                </>
              ) : (
                <div className={styles.muted}>n/a</div>
              )}
            </section>
            {s.currentChat && (
              <section className={styles.current}>
                <div className={styles.label}>Current chat</div>
                <div className={styles.row}>
                  <span className={styles.name} title={s.currentChat.name}>
                    {s.currentChat.name}
                  </span>
                  <span className={styles.num}>
                    {s.currentChat.done.toLocaleString()} / {s.currentChat.total.toLocaleString()}
                  </span>
                </div>
                <Bar value={s.currentChat.done} total={s.currentChat.total} />
              </section>
            )}
            <section className={styles.overall}>
              <div className={styles.label}>Overall</div>
              <div className={styles.row}>
                <span className={styles.num}>
                  {o.messagesDone.toLocaleString()} / {o.messagesTotal.toLocaleString()} msgs
                </span>
                <span className={styles.num}>
                  chats {o.chatsDone}/{o.chatsTotal}
                </span>
              </div>
              <Bar value={o.messagesDone} total={o.messagesTotal} />
              <div className={styles.row}>
                <span className={styles.muted}>{Math.round(s.throughput).toLocaleString()} msgs/s</span>
                <span className={styles.muted}>ETA {s.running ? formatDuration(s.etaSeconds) : "--"}</span>
              </div>
            </section>
          </div>
          {s.lastError && <div className={styles.errorBox}>Last error: {s.lastError}</div>}
          <div className={styles.logHead}>
            <span className={styles.label}>Log ({s.log.length})</span>
            <button
              type="button"
              className={styles.copy}
              onClick={copy}
              aria-label={copied ? "Copied" : "Copy log"}
              title={copied ? "Copied" : "Copy log"}
            >
              <FaRegCopy aria-hidden />
            </button>
          </div>
          <LogView log={s.log} />
        </div>
      )}
    </aside>
  );
}
