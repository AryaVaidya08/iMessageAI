/**
 * Port of analytics/backend/services/stats.py plus the stats-related query logic from
 * routers/conversations.py (participant-stats, personality-leaderboard) and
 * services/queries.get_person_stats.
 *
 * Memory model: message text is streamed from SQLite in keyset-paginated batches
 * (BATCH_SIZE rows, ordered by (timestamp, id)) and folded into per-sender accumulators.
 * Only aggregates (word/emoji counters, reply-delay numbers, per-bucket sentiment sums) are
 * retained; message bodies are never held beyond one batch.
 */
import emojiRegex from "emoji-regex";
import { polarityScores } from "./vader";
import { registerRoute as registerOnRouter } from "./router";

// ---------------------------------------------------------------------------------------------
// DB abstraction (sync or async; the real engine DB handle is adapted by the query worker)
// ---------------------------------------------------------------------------------------------

export type Row = Record<string, any>;
export interface StatsDb {
  all(sql: string, params?: unknown[]): Row[] | Promise<Row[]>;
  run(sql: string, params?: unknown[]): void | Promise<void>;
}

export const BATCH_SIZE = 5000;
export const GAP_INITIATOR_THRESHOLD_SECONDS = 6 * 3600;

// ---------------------------------------------------------------------------------------------
// Pure helpers (ports of stats.py)
// ---------------------------------------------------------------------------------------------

const TZ_RE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;
/** ISO-8601 -> epoch ms. Timestamps without an offset are treated as UTC. */
export function parseTs(ts: string): number {
  return Date.parse(TZ_RE.test(ts) ? ts : ts + "Z");
}

export function median(values: number[]): number {
  if (!values.length) throw new Error("median of empty list"); // matches Python statistics.median
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  const mid = n >> 1;
  return n % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Python round(x, 1): round-half-even on exact ties. */
export function round1(x: number): number {
  const s = x * 10;
  const f = Math.floor(s);
  if (s - f === 0.5) return (f % 2 === 0 ? f : f + 1) / 10;
  return Math.round(s) / 10;
}

export const HISTOGRAM_BUCKETS: [string, number][] = [
  ["<1m", 60],
  ["1-5m", 300],
  ["5-30m", 1800],
  ["30m-2h", 7200],
  ["2-12h", 43200],
  ["12-24h", 86400],
  [">24h", Infinity],
];

export function bucketReplyDeltas(deltas: number[]): [string, number][] {
  const counts = new Array(HISTOGRAM_BUCKETS.length).fill(0);
  for (const d of deltas) {
    for (let i = 0; i < HISTOGRAM_BUCKETS.length; i++) {
      if (d < HISTOGRAM_BUCKETS[i][1]) {
        counts[i]++;
        break;
      }
    }
  }
  return HISTOGRAM_BUCKETS.map(([label], i) => [label, counts[i]]);
}

export interface MessageEvent {
  senderId: string;
  timestamp: string;
}

export function replyDeltasBySender(messages: MessageEvent[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].senderId === messages[i - 1].senderId) continue;
    const d = (parseTs(messages[i].timestamp) - parseTs(messages[i - 1].timestamp)) / 1000;
    let arr = out.get(messages[i].senderId);
    if (!arr) out.set(messages[i].senderId, (arr = []));
    arr.push(d);
  }
  return out;
}

export function medianReplySeconds(messages: MessageEvent[]): Map<string, number | null> {
  const deltas = replyDeltasBySender(messages);
  const out = new Map<string, number | null>();
  for (const m of messages) {
    const d = deltas.get(m.senderId);
    out.set(m.senderId, d && d.length ? median(d) : null);
  }
  return out;
}

export function replyDeltasSeconds(messages: MessageEvent[]): number[] {
  return [...replyDeltasBySender(messages).values()].flat();
}

export function fastestReplyRelationshipTypes(byRel: Record<string, number[]>): [string, number][] {
  return Object.entries(byRel)
    .filter(([, d]) => d.length)
    .map(([rel, d]): [string, number] => [rel, median(d)])
    .sort((a, b) => a[1] - b[1]);
}

export function gapInitiators(messages: MessageEvent[], thresholdSeconds: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of messages) counts.set(m.senderId, 0);
  for (let i = 1; i < messages.length; i++) {
    if ((parseTs(messages[i].timestamp) - parseTs(messages[i - 1].timestamp)) / 1000 >= thresholdSeconds) {
      counts.set(messages[i].senderId, counts.get(messages[i].senderId)! + 1);
    }
  }
  return counts;
}

export const LATE_NIGHT_HOURS = new Set([23, 0, 1, 2, 3, 4]);

export function lateNightRatio(hoursBySender: [string, number][]): Map<string, number> {
  const totals = new Map<string, number>();
  const late = new Map<string, number>();
  for (const [s, h] of hoursBySender) {
    totals.set(s, (totals.get(s) ?? 0) + 1);
    if (LATE_NIGHT_HOURS.has(h)) late.set(s, (late.get(s) ?? 0) + 1);
  }
  return new Map([...totals].map(([s, t]) => [s, (late.get(s) ?? 0) / t]));
}

export function buildHeatmapGrid(cells: [number, number, number][]): number[][] {
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const [dow, hour, count] of cells) grid[dow][hour] = count;
  return grid;
}

export interface DayActivity {
  day: string;
  startTs: string;
  endTs: string;
}

const dayNum = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000;
const isoDay = (n: number) => new Date(n * 86400000).toISOString().slice(0, 10);

export function longestStreakDays(days: DayActivity[]): number {
  if (!days.length) return 0;
  let best = 1,
    streak = 1;
  for (let i = 1; i < days.length; i++) {
    streak = dayNum(days[i].day) - dayNum(days[i - 1].day) === 1 ? streak + 1 : 1;
    best = Math.max(best, streak);
  }
  return best;
}

export function longestSilence(days: DayActivity[]): { before: string; after: string; gap_seconds: number } | null {
  if (days.length < 2) return null;
  let bestGap = -1;
  let best: { before: string; after: string; gap_seconds: number } | null = null;
  for (let i = 1; i < days.length; i++) {
    const gap = (parseTs(days[i].startTs) - parseTs(days[i - 1].endTs)) / 1000;
    if (gap > bestGap) {
      bestGap = gap;
      best = { before: days[i - 1].endTs, after: days[i].startTs, gap_seconds: gap };
    }
  }
  return best;
}

/** Bucket key for a YYYY-MM-DD day: the day, its Monday, or YYYY-MM. */
export function bucketKey(day: string, granularity: "day" | "week" | "month"): string {
  if (granularity === "day") return day;
  if (granularity === "month") return day.slice(0, 7);
  const n = dayNum(day);
  const weekday = (new Date(n * 86400000).getUTCDay() + 6) % 7; // Monday = 0
  return isoDay(n - weekday);
}

export function bucketVolume(dayCounts: [string, number][], granularity: string): [string, number][] {
  if (granularity !== "day" && granularity !== "week" && granularity !== "month") {
    throw new Error(`unknown granularity: ${granularity}`);
  }
  if (!dayCounts.length) return [];
  const counts = new Map(dayCounts);
  const filled: [string, number][] = [];
  const end = dayNum(dayCounts[dayCounts.length - 1][0]);
  for (let n = dayNum(dayCounts[0][0]); n <= end; n++) {
    const key = isoDay(n);
    filled.push([key, counts.get(key) ?? 0]);
  }
  if (granularity === "day") return filled;
  const buckets = new Map<string, number>();
  for (const [day, c] of filled) {
    const k = bucketKey(day, granularity);
    buckets.set(k, (buckets.get(k) ?? 0) + c);
  }
  return [...buckets];
}

export const STOPWORDS = new Set([
  "a", "about", "above", "after", "again", "all", "am", "an", "and", "any", "are", "aren't", "as", "at",
  "be", "because", "been", "before", "being", "below", "between", "both", "but", "by",
  "can", "cant", "could", "couldn't",
  "did", "didn't", "do", "does", "doesn't", "doing", "don't", "down", "during",
  "each",
  "few", "for", "from", "further",
  "had", "hadn't", "has", "hasn't", "have", "haven't", "having", "he", "hed", "hell", "hes", "he's", "her",
  "here", "heres", "hers", "herself", "him", "himself", "his", "how", "hows", "how's",
  "i", "id", "ill", "im", "ive", "if", "in", "into", "is", "isn't", "it", "its", "it's", "itself",
  "just",
  "know", "let's", "like",
  "me", "more", "most", "mustn't", "my", "myself",
  "no", "nor", "not", "now",
  "of", "off", "on", "once", "only", "or", "other", "ought", "our", "ours", "ourselves", "out", "over", "own",
  "really",
  "same", "shan't", "she", "shed", "shell", "shes", "she's", "should", "shouldn't", "so", "some", "such",
  "than", "that", "thats", "that's", "the", "their", "theirs", "them", "themselves", "then", "there",
  "theres", "there's",
  "these", "they", "theyd", "theyll", "theyre", "theyve", "this", "those", "through", "to", "too",
  "under", "until", "up",
  "very",
  "was", "wasn't", "we", "wed", "well", "were", "weve", "weren't", "what", "whats", "what's", "when",
  "whens", "when's",
  "where", "wheres", "where's", "which", "while", "who", "whos", "who's", "whom", "why", "whys", "why's",
  "will", "with", "won't",
  "would", "wouldn't",
  "you", "youd", "youll", "youre", "youve", "your", "yours", "yourself", "yourselves",
  "dont", "didnt", "doesnt", "gonna", "wanna", "gotta", "yeah", "ok", "okay", "oh", "um", "uh", "hey",
  "lol", "lmao",
]);

const WORD_RE = /[a-zA-Z']+/g;
const VS16 = /️/g;

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/’/g, "'");
}

export function wordsOf(normalized: string): string[] {
  return normalized.match(WORD_RE) ?? [];
}

function addWords(counts: Map<string, number>, text: string): void {
  for (const raw of wordsOf(normalizeText(text))) {
    const word = raw.replace(/^'+|'+$/g, "");
    if (word.length <= 2 || STOPWORDS.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
}

/** Stable top-N by count descending (ties keep first-seen order, like Python's sorted on a dict). */
function topN(counts: Map<string, number>, limit: number): [string, number][] {
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

export function topWords(texts: Iterable<string>, limit = 15): [string, number][] {
  const counts = new Map<string, number>();
  for (const t of texts) addWords(counts, t);
  return topN(counts, limit);
}

const EMOJI_RE = emojiRegex();
/** Emoji glyphs in order, with the VS-16 selector stripped (matches stats.py). */
export function emojiList(text: string): string[] {
  return (text.match(EMOJI_RE) ?? []).map((e) => e.replace(VS16, ""));
}
function addEmojis(counts: Map<string, number>, text: string): void {
  for (const e of emojiList(text)) counts.set(e, (counts.get(e) ?? 0) + 1);
}
export function topEmojis(texts: Iterable<string>, limit = 10): [string, number][] {
  const counts = new Map<string, number>();
  for (const t of texts) addEmojis(counts, t);
  return topN(counts, limit);
}

export function messageSentiment(text: string): number {
  return text ? polarityScores(text).compound : 0;
}

export function sentimentSeries(
  rows: [string, string][],
  granularity: "day" | "week" | "month" = "week",
): [string, number][] {
  const sums = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const [day, text] of rows) {
    const k = bucketKey(day, granularity);
    sums.set(k, (sums.get(k) ?? 0) + messageSentiment(text));
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...sums.keys()].sort().map((k) => [k, sums.get(k)! / counts.get(k)!]);
}

export const PERSONALITY_TRAITS = ["Aggressive", "Chaotic", "Dramatic", "Sarcastic", "Chill", "Wholesome"] as const;
export type Trait = (typeof PERSONALITY_TRAITS)[number];
export type Hits = Record<Trait, number>;

const CAPS_STOPLIST = new Set([
  "LOL", "LMAO", "LMFAO", "ROFL", "OMG", "IDK", "TBH", "BTW", "ASAP", "ETA", "ILY", "WTF",
  "RN", "HBU", "WYD", "IKR", "NGL", "SMH", "FYI", "IMO", "IMHO", "OK", "TTYL", "JK", "OMW",
]);
const CAPS_WORD_RE = /\b[A-Z]{3,}\b/g;
const ELONGATED_RE = /([a-zA-Z])\1{2,}/;

const AGGRESSIVE_WORDS = new Set([
  "fuck", "fucking", "fuckin", "fck", "shit", "bullshit", "damn", "hell", "wtf", "stfu", "shut",
  "hate", "pissed", "idiot", "stupid", "dumb", "trash", "ugly", "furious", "angry", "rage",
  "screw", "asshole", "jerk", "loser", "dumbass", "annoying", "ridiculous",
]);
const AGGRESSIVE_EMOJI = new Set(["😡", "🤬", "👿", "💢"]);
const CHAOTIC_WORDS = new Set([
  "unhinged", "feral", "deceased", "deranged", "chaos", "chaotic", "bestie", "icant", "sending",
  "sendingme", "screaming", "wild", "insane", "crazy", "help",
]);
const CHAOTIC_EMOJI = new Set(["💀", "😭", "🤡", "🫠"]);
const DRAMATIC_WORDS = new Set([
  "literally", "actually", "obsessed", "iconic", "legendary", "epic", "worst", "best", "dying",
  "crying", "done", "cannot", "unbelievable", "shaking", "speechless", "embarrassing", "mortifying",
  "traumatized", "devastated",
]);
const SARCASTIC_WORDS = new Set(["sure", "totally", "obviously", "right", "shocking", "wow", "great", "greeeat", "riiight"]);
const CHILL_WORDS = new Set([
  "chill", "chilling", "relax", "relaxing", "whatever", "vibes", "vibing", "lowkey", "mellow",
  "calm", "easy", "fine", "cool", "noworries", "peace", "zen", "nbd",
]);
// NOTE: like the Python source, these literals keep a trailing VS-16 on some entries (U+262E,
// U+2764, U+263A) while message emoji have VS-16 stripped before lookup, so those particular
// entries never match. Kept as-is for parity.
const CHILL_EMOJI = new Set(["😌", "🧘", "😎", "☮️"]);
const WHOLESOME_WORDS = new Set([
  "love", "loved", "loves", "loving", "miss", "missed", "missing", "thank", "thanks", "thankful",
  "appreciate", "appreciated", "glad", "proud", "sweet", "care", "caring", "hug", "hugs", "best",
  "ily", "iloveyou", "grateful", "sorry", "congrats", "congratulations", "welcome", "sweetheart",
  "dear", "xoxo", "beautiful", "amazing", "wonderful", "support", "proudofyou",
]);
const WHOLESOME_EMOJI = new Set(["❤️", "💕", "😘", "🥰", "💖", "😍", "🤗", "☺️"]);

function shoutWords(text: string): string[] {
  return (text.match(CAPS_WORD_RE) ?? []).filter((w) => !CAPS_STOPLIST.has(w));
}
const anyIn = (words: string[], set: Set<string>) => words.some((w) => set.has(w));
const anyEmoji = (emojis: Set<string>, set: Set<string>) => {
  for (const e of emojis) if (set.has(e)) return true;
  return false;
};
const countOf = (text: string, ch: string) => text.split(ch).length - 1;

export function emptyHits(): Hits {
  return { Aggressive: 0, Chaotic: 0, Dramatic: 0, Sarcastic: 0, Chill: 0, Wholesome: 0 };
}

/** Adds one message's trait hits into `hits`. */
export function addPersonalityHit(hits: Hits, text: string): void {
  if (!text) return;
  const normalized = normalizeText(text);
  const words = wordsOf(normalized);
  const emojis = new Set(emojiList(text));

  if (anyIn(words, AGGRESSIVE_WORDS) || anyEmoji(emojis, AGGRESSIVE_EMOJI) || shoutWords(text).length) hits.Aggressive++;
  if (
    countOf(text, "!") >= 2 ||
    emojis.size >= 2 ||
    ELONGATED_RE.test(normalized) ||
    anyIn(words, CHAOTIC_WORDS) ||
    anyEmoji(emojis, CHAOTIC_EMOJI)
  )
    hits.Chaotic++;
  if (anyIn(words, DRAMATIC_WORDS) || countOf(text, "?") >= 2 || text.includes("?!") || text.includes("!?")) hits.Dramatic++;
  if (anyIn(words, SARCASTIC_WORDS) || text.includes("...") || normalized.includes("/s")) hits.Sarcastic++;
  if (anyIn(words, CHILL_WORDS) || anyEmoji(emojis, CHILL_EMOJI)) hits.Chill++;
  if (anyIn(words, WHOLESOME_WORDS) || anyEmoji(emojis, WHOLESOME_EMOJI)) hits.Wholesome++;
}

export function personalityHits(texts: string[]): Hits {
  const hits = emptyHits();
  for (const t of texts) addPersonalityHit(hits, t);
  return hits;
}

export function personalityScores(texts: string[]): [string, number][] {
  texts = texts.filter(Boolean);
  if (!texts.length) return [];
  const hits = personalityHits(texts);
  const total = PERSONALITY_TRAITS.reduce((s, t) => s + hits[t], 0);
  if (total === 0) return PERSONALITY_TRAITS.map((t) => [t, 0]);
  return PERSONALITY_TRAITS.map((t) => [t, round1((hits[t] / total) * 100)]);
}

/** Rate (% of the participant's own non-empty messages) per trait; [] under minMessages. */
export function personalityRatesFromHits(hits: Hits, textCount: number, minMessages = 20): [string, number][] {
  if (textCount < minMessages) return [];
  return PERSONALITY_TRAITS.map((t) => [t, round1((hits[t] / textCount) * 100)]);
}
export function personalityRates(texts: string[], minMessages = 20): [string, number][] {
  texts = texts.filter(Boolean);
  return personalityRatesFromHits(personalityHits(texts), texts.length, minMessages);
}

export function personalityLeaderboard(
  hitsByParticipant: Record<string, Hits>,
  messageCounts: Record<string, number>,
  minMessages = 20,
): Record<string, [string, number, number][]> {
  const eligible = Object.entries(messageCounts).filter(([, c]) => c >= minMessages);
  const result: Record<string, [string, number, number][]> = {};
  for (const trait of PERSONALITY_TRAITS) {
    const entries: [string, number, number][] = [];
    for (const [pid, count] of eligible) {
      const h = hitsByParticipant[pid]?.[trait] ?? 0;
      if (h > 0) entries.push([pid, h, round1((h / count) * 100)]);
    }
    result[trait] = entries.sort((a, b) => b[2] - a[2]);
  }
  return result;
}

export interface TapbackEvent {
  reactorId: string;
  targetSenderId: string;
  action: string;
}
export function tapbacksGiven(events: TapbackEvent[], pid: string, limit = 10): [string, number][] {
  const c = new Map<string, number>();
  for (const e of events) if (e.reactorId === pid) c.set(e.action, (c.get(e.action) ?? 0) + 1);
  return topN(c, limit);
}
export function tapbacksReceived(events: TapbackEvent[], pid: string, limit = 10): [string, number][] {
  const c = new Map<string, number>();
  for (const e of events) if (e.targetSenderId === pid) c.set(e.action, (c.get(e.action) ?? 0) + 1);
  return topN(c, limit);
}

export const MEMBERSHIP_DELTAS: Record<string, number> = { "added person": 1, "removed person": -1, "left convo": -1 };
export function groupSizeOverTime(currentSize: number, events: [string, string][]): [string, number][] {
  const net = events.reduce((s, [, a]) => s + (MEMBERSHIP_DELTAS[a] ?? 0), 0);
  let size = currentSize - net;
  return events.map(([dt, a]) => [dt, (size += MEMBERSHIP_DELTAS[a] ?? 0)]);
}

export function messageEmojiCount(text: string): number {
  return text ? (text.match(EMOJI_RE) ?? []).length : 0;
}

export function messageAggressiveScore(text: string): number {
  if (!text) return 0;
  const words = wordsOf(normalizeText(text));
  const emojis = new Set(emojiList(text));
  let n = words.filter((w) => AGGRESSIVE_WORDS.has(w)).length + shoutWords(text).length;
  for (const e of emojis) if (AGGRESSIVE_EMOJI.has(e)) n++;
  return n;
}

export function lateNightDistanceMinutes(timestamp: string): number {
  const minutes = +timestamp.slice(11, 13) * 60 + +timestamp.slice(14, 16);
  const diff = Math.abs(minutes - 180);
  return Math.min(diff, 1440 - diff);
}

export function buildReplyGraph(edges: [string, string][]): [string, string, number][] {
  const counts = new Map<string, number>();
  for (const [r, o] of edges) if (r !== o) counts.set(r + "\u0000" + o, (counts.get(r + "\u0000" + o) ?? 0) + 1);
  return [...counts]
    .map(([k, c]): [string, string, number] => {
      const [r, o] = k.split("\u0000");
      return [r, o, c];
    })
    .sort((a, b) => b[2] - a[2]);
}

// ---------------------------------------------------------------------------------------------
// Streaming accumulator
// ---------------------------------------------------------------------------------------------

export class SenderAcc {
  count = 0;
  textCount = 0;
  deltas: number[] = [];
  gapInit = 0;
  late = 0;
  words = new Map<string, number>();
  emojis = new Map<string, number>();
  sentSum = new Map<string, number>();
  sentCnt = new Map<string, number>();
  hits = emptyHits();

  add(ts: string, text: string): void {
    this.count++;
    if (LATE_NIGHT_HOURS.has(+ts.slice(11, 13))) this.late++;
    if (!text) return;
    this.textCount++;
    addWords(this.words, text);
    addEmojis(this.emojis, text);
    const k = bucketKey(ts.slice(0, 10), "week");
    this.sentSum.set(k, (this.sentSum.get(k) ?? 0) + messageSentiment(text));
    this.sentCnt.set(k, (this.sentCnt.get(k) ?? 0) + 1);
    addPersonalityHit(this.hits, text);
  }
}

/** Per-participant aggregates minus names and tapbacks; this is what gets cached. */
export interface RawParticipantStats {
  message_count: number;
  median_reply_seconds: number | null;
  reply_histogram: { label: string; count: number }[];
  gap_initiator_count: number;
  late_night_ratio: number;
  top_words: { word: string; count: number }[];
  top_emojis: { emoji: string; count: number }[];
  sentiment_series: { bucket: string; score: number }[];
  personality: { trait: string; percentage: number }[];
  hits: Hits;
}

/** `emptyHistogram`: for a participant with no messages, return zero buckets (person stats)
 * rather than [] (conversation participant-stats, matching the Python routers). */
export function finalize(acc: SenderAcc | undefined, emptyHistogram: boolean): RawParticipantStats {
  if (!acc) {
    return {
      message_count: 0,
      median_reply_seconds: null,
      reply_histogram: emptyHistogram ? bucketReplyDeltas([]).map(([label, count]) => ({ label, count })) : [],
      gap_initiator_count: 0,
      late_night_ratio: 0,
      top_words: [],
      top_emojis: [],
      sentiment_series: [],
      personality: [],
      hits: emptyHits(),
    };
  }
  return {
    message_count: acc.count,
    median_reply_seconds: acc.deltas.length ? median(acc.deltas) : null,
    reply_histogram: bucketReplyDeltas(acc.deltas).map(([label, count]) => ({ label, count })),
    gap_initiator_count: acc.gapInit,
    late_night_ratio: acc.count ? acc.late / acc.count : 0,
    top_words: topN(acc.words, 15).map(([word, count]) => ({ word, count })),
    top_emojis: topN(acc.emojis, 10).map(([emoji, count]) => ({ emoji, count })),
    sentiment_series: [...acc.sentSum.keys()]
      .sort()
      .map((b) => ({ bucket: b, score: acc.sentSum.get(b)! / acc.sentCnt.get(b)! })),
    personality: personalityRatesFromHits(acc.hits, acc.textCount).map(([trait, percentage]) => ({ trait, percentage })),
    hits: acc.hits,
  };
}

// ---------------------------------------------------------------------------------------------
// Scope resolution (merge aliases applied at read time)
// ---------------------------------------------------------------------------------------------

async function safeAll(db: StatsDb, sql: string, params: unknown[] = []): Promise<Row[]> {
  try {
    return await db.all(sql, params);
  } catch {
    return [];
  }
}
const ph = (n: number) => new Array(n).fill("?").join(",");

export class NotFoundError extends Error {
  status = 404;
}

async function participantAliasMap(db: StatsDb): Promise<Map<string, string>> {
  const rows = await safeAll(db, "SELECT from_id, to_id FROM participant_alias");
  return new Map(rows.map((r) => [r.from_id as string, r.to_id as string]));
}
const canon = (m: Map<string, string>, id: string) => m.get(id) ?? id;

interface ConvScope {
  canonicalId: string;
  convIds: string[]; // raw conversation ids merged into the canonical one
  participantIds: string[]; // canonical participant ids, in membership order
  aliasMap: Map<string, string>;
  cacheable: boolean; // no merges affect results, so the per-conversation cache row is valid
}

async function resolveConversationScope(db: StatsDb, id: string): Promise<ConvScope | null> {
  const aliasMap = await participantAliasMap(db);
  const ca = await safeAll(db, "SELECT from_id, to_id FROM conversation_alias");
  const canonicalId: string = ca.find((r) => r.from_id === id)?.to_id ?? id;
  const convIds = [canonicalId, ...ca.filter((r) => r.to_id === canonicalId).map((r) => r.from_id as string)];
  const members = await db.all(
    `SELECT participant_id FROM conversation_participants WHERE conversation_id IN (${ph(convIds.length)}) ORDER BY rowid`,
    convIds,
  );
  const participantIds = [...new Set(members.map((r) => canon(aliasMap, r.participant_id as string)))];
  if (!participantIds.length) return null;
  return { canonicalId, convIds, participantIds, aliasMap, cacheable: convIds.length === 1 && aliasMap.size === 0 };
}

async function participantInfo(db: StatsDb, ids: string[]): Promise<Map<string, { display_name: string; handle: string }>> {
  const out = new Map<string, { display_name: string; handle: string }>();
  if (!ids.length) return out;
  const rows = await db.all(`SELECT id, handle, display_name, is_me FROM participants WHERE id IN (${ph(ids.length)})`, ids);
  for (const id of ids) {
    const r = rows.find((x) => x.id === id);
    const handle: string = r?.handle || "";
    out.set(id, { display_name: r?.is_me ? "You" : r?.display_name || handle || "Unknown", handle: r?.is_me ? "" : handle });
  }
  return out;
}

/** Streams (sender_id, timestamp, text) for the given conversations in keyset batches. */
async function streamMessages(
  db: StatsDb,
  convIds: string[],
  onRow: (senderId: string, timestamp: string, text: string) => void,
): Promise<void> {
  let ts: string | null = null;
  let id: string | null = null;
  const inList = ph(convIds.length);
  for (;;) {
    const rows: Row[] = await db.all(
      `SELECT id, sender_id, timestamp, text FROM messages WHERE conversation_id IN (${inList})` +
        (ts === null ? "" : " AND (timestamp, id) > (?, ?)") +
        ` ORDER BY timestamp, id LIMIT ${BATCH_SIZE}`,
      ts === null ? convIds : [...convIds, ts, id],
    );
    for (const r of rows) onRow(r.sender_id, r.timestamp, r.text ?? "");
    if (rows.length < BATCH_SIZE) return;
    ts = rows[rows.length - 1].timestamp;
    id = rows[rows.length - 1].id;
  }
}

/** Folds a conversation's messages into per-(canonical)-sender accumulators. */
async function foldConversation(db: StatsDb, convIds: string[], aliasMap: Map<string, string>): Promise<Map<string, SenderAcc>> {
  const accs = new Map<string, SenderAcc>();
  let prevSender: string | null = null;
  let prevMs = 0;
  await streamMessages(db, convIds, (rawSender, timestamp, text) => {
    const sender = canon(aliasMap, rawSender);
    let acc = accs.get(sender);
    if (!acc) accs.set(sender, (acc = new SenderAcc()));
    const ms = parseTs(timestamp);
    if (prevSender !== null) {
      const delta = (ms - prevMs) / 1000;
      if (sender !== prevSender) acc.deltas.push(delta);
      if (delta >= GAP_INITIATOR_THRESHOLD_SECONDS) acc.gapInit++;
    }
    prevSender = sender;
    prevMs = ms;
    acc.add(timestamp, text);
  });
  return accs;
}

// ---------------------------------------------------------------------------------------------
// Summary cache
// ---------------------------------------------------------------------------------------------

export async function ensureStatsSummarySchema(db: StatsDb): Promise<void> {
  await db.run("CREATE TABLE IF NOT EXISTS summary_conversation_stats (conversation_id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  await db.run("CREATE TABLE IF NOT EXISTS summary_person_stats (participant_id TEXT PRIMARY KEY, data TEXT NOT NULL)");
}

interface ConversationSummary {
  participants: Record<string, RawParticipantStats>;
}

async function computeSummary(
  db: StatsDb,
  convIds: string[],
  participantIds: string[],
  aliasMap: Map<string, string>,
): Promise<ConversationSummary> {
  const accs = await foldConversation(db, convIds, aliasMap);
  const participants: Record<string, RawParticipantStats> = {};
  for (const pid of participantIds) participants[pid] = finalize(accs.get(pid), false);
  return { participants };
}

async function getConversationSummary(
  db: StatsDb,
  conversationId: string,
): Promise<{ scope: ConvScope; summary: ConversationSummary } | null> {
  const scope = await resolveConversationScope(db, conversationId);
  if (!scope) return null;
  if (scope.cacheable) {
    const cached = await safeAll(db, "SELECT data FROM summary_conversation_stats WHERE conversation_id = ?", [scope.canonicalId]);
    if (cached.length) return { scope, summary: JSON.parse(cached[0].data) };
  }
  const summary = await computeSummary(db, scope.convIds, scope.participantIds, scope.aliasMap);
  if (scope.cacheable) {
    try {
      await ensureStatsSummarySchema(db);
      await db.run("INSERT OR REPLACE INTO summary_conversation_stats (conversation_id, data) VALUES (?, ?)", [
        scope.canonicalId,
        JSON.stringify(summary),
      ]);
    } catch {
      /* cache is best effort */
    }
  }
  return { scope, summary };
}

/**
 * Recompute cached stats for the given (raw) conversations; unit 5 calls this after an ingest
 * or delta. Person-level caches for those conversations' members are invalidated and rebuilt
 * lazily on next read. Merge aliases are not baked into cache rows (they bypass the cache).
 */
export async function refreshStatsSummary(db: StatsDb, changedConversationIds: string[]): Promise<void> {
  await ensureStatsSummarySchema(db);
  for (const id of changedConversationIds) {
    const members = await db.all("SELECT participant_id FROM conversation_participants WHERE conversation_id = ? ORDER BY rowid", [id]);
    const pids = members.map((m) => m.participant_id as string);
    if (!pids.length) {
      await db.run("DELETE FROM summary_conversation_stats WHERE conversation_id = ?", [id]);
      continue;
    }
    const summary = await computeSummary(db, [id], pids, new Map());
    await db.run("INSERT OR REPLACE INTO summary_conversation_stats (conversation_id, data) VALUES (?, ?)", [id, JSON.stringify(summary)]);
    for (const pid of pids) await db.run("DELETE FROM summary_person_stats WHERE participant_id = ?", [pid]);
  }
}

// ---------------------------------------------------------------------------------------------
// Tapbacks (SQL aggregation, no row loads)
// ---------------------------------------------------------------------------------------------

async function tapbackCounts(
  db: StatsDb,
  convIds: string[],
  side: "reactor" | "target",
  senderIds: string[],
): Promise<{ action: string; count: number }[]> {
  const col = side === "reactor" ? "t.reactor_id" : "m.sender_id";
  const rows = await db.all(
    `SELECT t.action AS action, COUNT(*) AS n FROM tapbacks t JOIN messages m ON m.id = t.message_id
     WHERE m.conversation_id IN (${ph(convIds.length)}) AND ${col} IN (${ph(senderIds.length)})
     GROUP BY t.action ORDER BY n DESC, MIN(t.id) LIMIT 10`,
    [...convIds, ...senderIds],
  );
  return rows.map((r) => ({ action: r.action, count: r.n }));
}

function rawIdsFor(aliasMap: Map<string, string>, pid: string): string[] {
  return [pid, ...[...aliasMap].filter(([, to]) => to === pid).map(([from]) => from)];
}

// ---------------------------------------------------------------------------------------------
// Public query functions
// ---------------------------------------------------------------------------------------------

/** GET /api/conversations/:id/participant-stats */
export async function getParticipantStats(db: StatsDb, conversationId: string) {
  const got = await getConversationSummary(db, conversationId);
  if (!got) throw new NotFoundError("conversation not found");
  const { scope, summary } = got;
  const info = await participantInfo(db, scope.participantIds);
  const participants = [];
  for (const pid of scope.participantIds) {
    const { hits: _hits, ...rest } = summary.participants[pid] ?? finalize(undefined, false);
    const raw = rawIdsFor(scope.aliasMap, pid);
    participants.push({
      participant_id: pid,
      display_name: info.get(pid)!.display_name,
      handle: info.get(pid)!.handle,
      ...rest,
      tapbacks_given: await tapbackCounts(db, scope.convIds, "reactor", raw),
      tapbacks_received: await tapbackCounts(db, scope.convIds, "target", raw),
    });
  }
  return { participants };
}

/** GET /api/conversations/:id/personality-leaderboard */
export async function getPersonalityLeaderboard(db: StatsDb, conversationId: string) {
  const got = await getConversationSummary(db, conversationId);
  if (!got) throw new NotFoundError("conversation not found");
  const { scope, summary } = got;
  const info = await participantInfo(db, scope.participantIds);
  const hits: Record<string, Hits> = {};
  const counts: Record<string, number> = {};
  for (const pid of scope.participantIds) {
    const s = summary.participants[pid] ?? finalize(undefined, false);
    hits[pid] = s.hits;
    counts[pid] = s.message_count;
  }
  const lb = personalityLeaderboard(hits, counts);
  return {
    traits: Object.entries(lb).map(([trait, entries]) => ({
      trait,
      entries: entries.map(([pid, count, share]) => ({
        participant_id: pid,
        display_name: info.get(pid)!.display_name,
        message_count: count,
        share,
      })),
    })),
  };
}

/**
 * People-detail stats (port of queries.get_person_stats; unit 11 embeds this as `stats` in the
 * person detail response). The person's messages across every conversation they are in; reply
 * and gap stats are computed per conversation so boundaries never count as reply transitions.
 * Returns null if the participant is unknown.
 */
export async function getPersonStats(db: StatsDb, participantId: string) {
  const aliasMap = await participantAliasMap(db);
  const pid = canon(aliasMap, participantId);
  const exists = await db.all("SELECT 1 AS x FROM participants WHERE id = ?", [pid]);
  if (!exists.length) return null;
  if (aliasMap.size === 0) {
    const cached = await safeAll(db, "SELECT data FROM summary_person_stats WHERE participant_id = ?", [pid]);
    if (cached.length) return JSON.parse(cached[0].data);
  }

  const info = await participantInfo(db, [pid]);
  const rawPids = rawIdsFor(aliasMap, pid);
  const rawConvs = await db.all(
    `SELECT DISTINCT conversation_id FROM conversation_participants WHERE participant_id IN (${ph(rawPids.length)})`,
    rawPids,
  );
  const ca = await safeAll(db, "SELECT from_id, to_id FROM conversation_alias");
  const toCanon = new Map(ca.map((r) => [r.from_id as string, r.to_id as string]));
  const canonConvs = [...new Set(rawConvs.map((r) => toCanon.get(r.conversation_id) ?? (r.conversation_id as string)))].sort();

  const acc = new SenderAcc();
  const allConvIds: string[] = [];
  for (const cid of canonConvs) {
    const convIds = [cid, ...ca.filter((r) => r.to_id === cid).map((r) => r.from_id as string)];
    allConvIds.push(...convIds);
    let prevSender: string | null = null;
    let prevMs = 0;
    await streamMessages(db, convIds, (rawSender, timestamp, text) => {
      const sender = canon(aliasMap, rawSender);
      const ms = parseTs(timestamp);
      if (sender === pid) {
        if (prevSender !== null) {
          const delta = (ms - prevMs) / 1000;
          if (sender !== prevSender) acc.deltas.push(delta);
          if (delta >= GAP_INITIATOR_THRESHOLD_SECONDS) acc.gapInit++;
        }
        acc.add(timestamp, text);
      }
      prevSender = sender;
      prevMs = ms;
    });
  }
  const { hits: _h, ...rest } = finalize(acc, true);
  const result = {
    participant_id: pid,
    display_name: info.get(pid)!.display_name,
    handle: info.get(pid)!.handle,
    ...rest,
    tapbacks_given: allConvIds.length ? await tapbackCounts(db, allConvIds, "reactor", rawPids) : [],
    tapbacks_received: allConvIds.length ? await tapbackCounts(db, allConvIds, "target", rawPids) : [],
  };
  if (aliasMap.size === 0) {
    try {
      await ensureStatsSummarySchema(db);
      await db.run("INSERT OR REPLACE INTO summary_person_stats (participant_id, data) VALUES (?, ?)", [pid, JSON.stringify(result)]);
    } catch {
      /* best effort */
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Route registration (tiny local shim; unit 8 owns the real router)
// ---------------------------------------------------------------------------------------------

export type RouteHandler = (params: Record<string, string>, db: StatsDb) => Promise<unknown>;
export type RegisterRoute = (pattern: string, handler: RouteHandler) => void;

export const localRoutes = new Map<string, RouteHandler>();
export const registerRoute: RegisterRoute = (pattern, handler) => {
  localRoutes.set(pattern, handler);
};

export function registerStatsRoutes(register: RegisterRoute = registerRoute): void {
  register("/api/conversations/:id/participant-stats", (p, db) => getParticipantStats(db, p.id));
  register("/api/conversations/:id/personality-leaderboard", (p, db) => getPersonalityLeaderboard(db, p.id));
}
registerStatsRoutes();

/** Registers the stats routes on the real router (flat params from the client; db is the app DB adapter). */
export function registerStatsRoutesOnRouter(): void {
  registerStatsRoutes((pattern, handler) =>
    registerOnRouter(`GET ${pattern}`, (db, params) => handler({ id: String(params.id) }, db as unknown as StatsDb)),
  );
}
