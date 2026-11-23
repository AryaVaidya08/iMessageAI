import { useEffect, useReducer } from "react";

import type { IngestSubscribe } from "../../engine/protocol";
import { ingestReducer, initialIngestState } from "./reducer";

/** Folds a stream of IngestEvents into display state. `subscribe` must be referentially stable. */
export function useIngestEvents(subscribe: IngestSubscribe) {
  const [state, dispatch] = useReducer(ingestReducer, initialIngestState);
  useEffect(() => {
    dispatch({ type: "reset" });
    return subscribe((event) => dispatch({ type: "event", event, now: Date.now() }));
  }, [subscribe]);
  return { state, reset: () => dispatch({ type: "reset" }) };
}
