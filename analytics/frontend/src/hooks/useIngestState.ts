import { useSyncExternalStore } from "react";

import { getIngestState, subscribeIngestState } from "../engine/appState";

export function useIngestState() {
  return useSyncExternalStore(subscribeIngestState, getIngestState);
}
