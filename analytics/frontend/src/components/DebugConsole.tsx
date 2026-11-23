// Placeholder: unit 6 replaces this file with the real debug console.
import { useEffect, useState } from "react";

import { subscribeIngest } from "../engine/appState";

export function DebugConsole() {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(
    () => subscribeIngest((e) => setLines((l) => [...l.slice(-199), JSON.stringify(e)])),
    [],
  );
  return (
    <pre
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        maxHeight: 260,
        overflow: "auto",
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: 12,
        padding: 12,
        margin: 0,
      }}
    >
      {lines.join("\n") || "Waiting for events..."}
    </pre>
  );
}
