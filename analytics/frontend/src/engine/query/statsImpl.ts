// Real StatsApi (sentiment / emoji / words / personality) for conversations.ts, built on unit 12's accumulator.
import type { StatsApi, TextAccumulatorResult } from "./statsApi";
import { SenderAcc, finalize, messageAggressiveScore, messageEmojiCount, messageSentiment } from "./stats";

export const realStatsApi: StatsApi = {
  createTextAccumulator() {
    const acc = new SenderAcc();
    return {
      add(text: string, day: string) {
        acc.add(`${day}T12:00:00.000Z`, text);
      },
      finish(): TextAccumulatorResult {
        const f = finalize(acc, true);
        return {
          top_words: f.top_words,
          top_emojis: f.top_emojis,
          sentiment_series: f.sentiment_series,
          personality: f.personality,
          personality_hits: f.hits,
        };
      },
    };
  },
  messageScores: (text: string) => ({
    emojiCount: messageEmojiCount(text),
    aggressive: messageAggressiveScore(text),
    sentiment: messageSentiment(text),
  }),
};
