import { useEffect, useRef, useState } from "react";
import { onDataChanged } from "./events";

/**
 * Runs fn on mount/deps change and again (throttled to 1/sec) whenever the
 * ingest worker reports data-changed. Stale responses are dropped.
 */
export function useLiveQuery<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let cancelled = false;
    let seq = 0;
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      last = Date.now();
      const mine = ++seq;
      fnRef.current().then(
        (d) => {
          if (!cancelled && mine === seq) {
            setData(d);
            setError(null);
            setLoading(false);
          }
        },
        (e) => {
          if (!cancelled && mine === seq) {
            setError(e instanceof Error ? e : new Error(String(e)));
            setLoading(false);
          }
        },
      );
    };
    setLoading(true);
    run();
    const off = onDataChanged(() => {
      if (timer) return;
      const wait = Math.max(0, 1000 - (Date.now() - last));
      timer = setTimeout(() => {
        timer = null;
        if (!cancelled) run();
      }, wait);
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading };
}
