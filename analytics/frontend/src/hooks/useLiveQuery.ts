import { useEffect, useState } from "react";

import { subscribeDataChanged } from "../engine/appState";

/** Counter that bumps (throttled) on data-changed; add it to effect deps to re-query live. */
export function useDataVersion(throttleMs = 1000): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    let timer: number | undefined;
    const off = subscribeDataChanged(() => {
      if (timer !== undefined) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        setV((x) => x + 1);
      }, throttleMs);
    });
    return () => {
      off();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [throttleMs]);
  return v;
}

/** Runs fn on mount, deps change, and data-changed. Stale results are dropped. */
export function useLiveQuery<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null } {
  const version = useDataVersion();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fn()
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, ...deps]);
  return { data, error };
}
