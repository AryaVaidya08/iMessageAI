import { api, type Granularity, type VolumePoint } from "../api/client";
import type { ConversationShareData, OverviewShareData, PersonShareData, VolumeByGranularity } from "./shareTypes";

const GRANULARITIES: Granularity[] = ["day", "week", "month"];

async function fetchAllGranularities(fetchOne: (g: Granularity) => Promise<{ points: VolumePoint[] }>): Promise<VolumeByGranularity> {
  const results = await Promise.all(GRANULARITIES.map((g) => fetchOne(g)));
  return Object.fromEntries(GRANULARITIES.map((g, i) => [g, results[i].points])) as VolumeByGranularity;
}

export async function fetchOverviewShareData(): Promise<OverviewShareData> {
  const [stats, volume, heatmapRes, topRes] = await Promise.all([
    api.overviewStats(),
    fetchAllGranularities((g) => api.overviewVolume(g)),
    api.overviewHeatmap(),
    api.topConversations(10),
  ]);
  return { stats, volume, heatmap: heatmapRes.grid, topConversations: topRes.items };
}

export async function fetchConversationShareData(id: string): Promise<ConversationShareData> {
  const [detail, volume, heatmapRes, streakSilence, participantsRes, leaderboard, joinLeaveRes] = await Promise.all([
    api.conversation(id),
    fetchAllGranularities((g) => api.conversationVolume(id, g)),
    api.conversationHeatmap(id),
    api.conversationStreakSilence(id).catch(() => null),
    api.participantStats(id),
    api.conversationLeaderboard(id).catch(() => null),
    api.conversationJoinLeave(id).catch(() => ({ items: [] })),
  ]);
  return {
    detail,
    volume,
    heatmap: heatmapRes.grid,
    streakSilence,
    participants: [...participantsRes.participants].sort((a, b) => b.message_count - a.message_count),
    leaderboard,
    joinLeave: joinLeaveRes.items,
  };
}

export async function fetchPersonShareData(id: string): Promise<PersonShareData> {
  return api.personDetail(id);
}
