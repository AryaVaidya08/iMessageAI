/**
 * Interface to the text-derived analytics (sentiment / emoji / words / personality) that unit 12
 * owns. This unit only depends on the shapes below; the default implementation is a deliberately
 * dumb STUB (empty word/emoji lists, zero sentiment, zero personality hits) so the rest of the
 * conversation analytics can be built and tested independently.
 *
 * Unit 12 swaps the real implementation in with `setStatsImpl(...)` (or by replacing this file's
 * default export). Everything is streaming-friendly: callers feed texts in chunks so the whole
 * conversation never has to be in memory.
 */

export const PERSONALITY_TRAITS = ["Aggressive", "Chaotic", "Dramatic", "Sarcastic", "Chill", "Wholesome"] as const;

export interface TextAccumulatorResult {
  top_words: { word: string; count: number }[];
  top_emojis: { emoji: string; count: number }[];
  /** Weekly-bucketed mean sentiment, ascending by bucket (stats.sentiment_series(rows, "week")). */
  sentiment_series: { bucket: string; score: number }[];
  /** stats.personality_rates: [] when fewer than 20 text messages. */
  personality: { trait: string; percentage: number }[];
  /** stats.personality_hits: raw per-trait hit counts. */
  personality_hits: Record<string, number>;
}

export interface TextAccumulator {
  /** day is YYYY-MM-DD (UTC) of the message; text is non-empty. */
  add(text: string, day: string): void;
  finish(): TextAccumulatorResult;
}

export interface MessageScores {
  /** Total emoji glyphs in the text (stats.message_emoji_count). */
  emojiCount: number;
  /** stats.message_aggressive_score. */
  aggressive: number;
  /** VADER compound score, -1..1 (stats.message_sentiment). */
  sentiment: number;
}

export interface StatsApi {
  createTextAccumulator(): TextAccumulator;
  messageScores(text: string): MessageScores;
}

function zeroHits(): Record<string, number> {
  return Object.fromEntries(PERSONALITY_TRAITS.map((t) => [t, 0]));
}

const stub: StatsApi = {
  createTextAccumulator() {
    return {
      add() {},
      finish: () => ({
        top_words: [],
        top_emojis: [],
        sentiment_series: [],
        personality: [],
        personality_hits: zeroHits(),
      }),
    };
  },
  messageScores: () => ({ emojiCount: 0, aggressive: 0, sentiment: 0 }),
};

let impl: StatsApi = stub;

export function setStatsImpl(next: StatsApi): void {
  impl = next;
}

/** Indirection so swapping the implementation is visible to already-imported callers. */
export const stats: StatsApi = {
  createTextAccumulator: () => impl.createTextAccumulator(),
  messageScores: (text) => impl.messageScores(text),
};

/**
 * Port of stats.personality_leaderboard: per trait, participants ranked by hit RATE (hits /
 * message_count), excluding participants under `minMessages` and those with zero hits. Pure
 * arithmetic (no lexicons), so it lives here rather than behind the swappable implementation.
 */
export function personalityLeaderboard(
  hitsByParticipant: Record<string, Record<string, number>>,
  messageCounts: Record<string, number>,
  minMessages = 20,
): Record<string, [string, number, number][]> {
  const eligible = Object.entries(messageCounts).filter(([, c]) => c >= minMessages);
  const result: Record<string, [string, number, number][]> = {};
  for (const trait of PERSONALITY_TRAITS) {
    const entries: [string, number, number][] = [];
    for (const [pid, count] of eligible) {
      const hits = hitsByParticipant[pid]?.[trait] ?? 0;
      if (hits > 0) entries.push([pid, hits, Math.round((hits / count) * 1000) / 10]);
    }
    // Array.prototype.sort is stable, matching Python's sorted(..., reverse=True) tie behaviour closely enough.
    entries.sort((a, b) => b[2] - a[2]);
    result[trait] = entries;
  }
  return result;
}
