import type { IngestEvent } from "../../engine/protocol";

export const MAX_LOG_LINES = 500;
const THROUGHPUT_WINDOW_MS = 10_000;

export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogLine {
  id: number;
  ts: number;
  level: LogLevel;
  text: string;
}

export interface IngestState {
  /** how many imports this console has seen (a new run starts on the first phase/chat-start event) */
  runs: number;
  running: boolean;
  finished: boolean;
  phase: string | null;
  phaseLabel: string | null;
  startedAt: number | null;
  currentChat: { chatId: string; name: string; done: number; total: number } | null;
  overall: { messagesDone: number; messagesTotal: number; chatsDone: number; chatsTotal: number };
  memory: { usedMB: number; limitMB: number } | null;
  errorCount: number;
  lastError: string | null;
  samples: { t: number; done: number }[];
  throughput: number; // msgs/s
  etaSeconds: number | null;
  log: LogLine[];
  nextLogId: number;
}

export const initialIngestState: IngestState = {
  runs: 0,
  running: false,
  finished: false,
  phase: null,
  phaseLabel: null,
  startedAt: null,
  currentChat: null,
  overall: { messagesDone: 0, messagesTotal: 0, chatsDone: 0, chatsTotal: 0 },
  memory: null,
  errorCount: 0,
  lastError: null,
  samples: [],
  throughput: 0,
  etaSeconds: null,
  log: [],
  nextLogId: 1,
};

export type IngestAction = { type: "event"; event: IngestEvent; now: number } | { type: "reset" };

function pushLog(s: IngestState, level: LogLevel, text: string, ts: number): IngestState {
  const line: LogLine = { id: s.nextLogId, ts, level, text };
  const log =
    s.log.length >= MAX_LOG_LINES
      ? [...s.log.slice(s.log.length - MAX_LOG_LINES + 1), line]
      : [...s.log, line];
  return { ...s, log, nextLogId: s.nextLogId + 1 };
}

export function ingestReducer(state: IngestState, action: IngestAction): IngestState {
  if (action.type === "reset") return initialIngestState;
  const { event: e, now } = action;
  // A new run (phase/chat-start after done) starts from a clean slate.
  const starts = (e.type === "phase" || e.type === "chat-start") && (state.finished || state.runs === 0);
  const base = state.finished && (e.type === "phase" || e.type === "chat-start") ? { ...initialIngestState, runs: state.runs } : state;
  const lifecycle = e.type === "phase" || e.type === "chat-start" || e.type === "chat-progress" || e.type === "overall";
  let s: IngestState = {
    ...base,
    runs: starts ? state.runs + 1 : base.runs,
    startedAt: base.startedAt ?? now,
    running: e.type === "done" ? false : base.finished ? false : lifecycle ? true : base.running || e.type === "error",
    finished: base.finished && !lifecycle && e.type !== "error" ? true : false,
  };
  switch (e.type) {
    case "phase":
      s = { ...s, phase: e.phase, phaseLabel: e.label ?? null };
      return pushLog(s, "info", `phase: ${e.label ?? e.phase}`, now);
    case "chat-start":
      s = { ...s, currentChat: { chatId: e.chatId, name: e.name, done: 0, total: e.total } };
      return pushLog(s, "debug", `chat start: ${e.name} (${e.total} msgs)`, now);
    case "chat-progress":
      return { ...s, currentChat: { chatId: e.chatId, name: e.name, done: e.done, total: e.total } };
    case "chat-done": {
      const cur = s.currentChat;
      const name = e.name ?? (cur && cur.chatId === e.chatId ? cur.name : e.chatId);
      if (cur && cur.chatId === e.chatId) s = { ...s, currentChat: { ...cur, done: cur.total } };
      return pushLog(s, "debug", `chat done: ${name}`, now);
    }
    case "overall": {
      const overall = {
        messagesDone: e.messagesDone,
        messagesTotal: e.messagesTotal,
        chatsDone: e.chatsDone,
        chatsTotal: e.chatsTotal,
      };
      const samples = [...s.samples, { t: now, done: overall.messagesDone }].filter(
        (x) => now - x.t <= THROUGHPUT_WINDOW_MS,
      );
      let throughput = s.throughput;
      const first = samples[0];
      if (samples.length >= 2 && now > first.t) {
        throughput = Math.max(0, ((overall.messagesDone - first.done) / (now - first.t)) * 1000);
      }
      const remaining = Math.max(0, overall.messagesTotal - overall.messagesDone);
      const etaSeconds = throughput > 0 && remaining >= 0 ? remaining / throughput : null;
      return { ...s, overall, samples, throughput, etaSeconds };
    }
    case "log":
      return pushLog(s, e.level ?? "info", e.message, now);
    case "memory":
      return { ...s, memory: { usedMB: e.usedMB, limitMB: e.limitMB } };
    case "error":
      s = { ...s, errorCount: s.errorCount + 1, lastError: e.message };
      return pushLog(s, "error", e.chatId ? `[${e.chatId}] ${e.message}` : e.message, now);
    case "done":
      s = { ...s, running: false, finished: true, etaSeconds: 0, currentChat: null };
      return pushLog(s, "info", e.summary ? `done: ${e.summary}` : "done", now);
    default:
      return state;
  }
}

export function formatLogLine(l: LogLine): string {
  return `${new Date(l.ts).toISOString().slice(11, 23)} ${l.level.toUpperCase().padEnd(5)} ${l.text}`;
}

export function formatDuration(sec: number | null): string {
  if (sec == null || !isFinite(sec)) return "--";
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
