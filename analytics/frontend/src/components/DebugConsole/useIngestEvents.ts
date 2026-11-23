import { useCallback, useSyncExternalStore } from "react";

import type { IngestSubscribe } from "../../engine/protocol";
import { ingestReducer, initialIngestState, type IngestState } from "./reducer";

interface Store {
  state: IngestState;
  listeners: Set<() => void>;
  unsubscribe: (() => void) | null;
}

// One store per event source, living for the whole app session, so the console's state (including a finished
// import) survives navigating away from the page that renders it and coming back.
const stores = new WeakMap<IngestSubscribe, Store>();

function getStore(subscribe: IngestSubscribe): Store {
  let store = stores.get(subscribe);
  if (!store) {
    const created: Store = { state: initialIngestState, listeners: new Set(), unsubscribe: null };
    const emit = () => created.listeners.forEach((l) => l());
    created.unsubscribe = subscribe((event) => {
      created.state = ingestReducer(created.state, { type: "event", event, now: Date.now() });
      emit();
    });
    stores.set(subscribe, created);
    store = created;
  }
  return store;
}

/** Folds a stream of IngestEvents into display state. `subscribe` must be referentially stable. */
export function useIngestEvents(subscribe: IngestSubscribe) {
  const store = getStore(subscribe);
  const sub = useCallback(
    (fn: () => void) => {
      store.listeners.add(fn);
      return () => {
        store.listeners.delete(fn);
      };
    },
    [store],
  );
  const state = useSyncExternalStore(sub, () => store.state);
  const reset = useCallback(() => {
    store.state = ingestReducer(store.state, { type: "reset" });
    store.listeners.forEach((l) => l());
  }, [store]);
  return { state, reset };
}
