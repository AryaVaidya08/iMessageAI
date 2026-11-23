// Registers every route handler on the router. Importing this module (the query worker does) is enough.
import { setStatsImpl } from "../statsApi";
import { realStatsApi } from "../statsImpl";
import "../overview"; // registers on import
import "../conversations"; // registers on import
import { registerPeopleRoutes, setPersonDetailExtras } from "../people";
import { registerMergeRoutes } from "../merge";
import { getPersonStats, registerStatsRoutesOnRouter } from "../stats";
import { registerSyncInfoRoutes } from "../syncInfo";
import { personLeaderboard } from "../conversations";

setStatsImpl(realStatsApi);
registerPeopleRoutes();
registerMergeRoutes();
// Registered AFTER conversations so the full (golden-tested) stats routes win for these two paths.
registerStatsRoutesOnRouter();
registerSyncInfoRoutes();
setPersonDetailExtras({
  stats: (db, person) => getPersonStats(db as never, person.id),
  leaderboard: (db, person) => personLeaderboard(db as never, person.id),
});
