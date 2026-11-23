import type { CSSProperties } from "react";
import { Link } from "react-router-dom";

import { useIngestState } from "../hooks/useIngestState";

const bar: CSSProperties = {
  padding: "8px 16px",
  background: "var(--surface-2, #eef)",
  borderBottom: "1px solid var(--border, #ccd)",
  fontSize: 14,
};

// TODO(unit 13): /debug route is the debug console.
export function ImportBanner() {
  const s = useIngestState();
  if (s.error) {
    return (
      <div role="alert" style={bar}>
        Import failed: {s.error} <Link to="/debug">Open debug console</Link>
      </div>
    );
  }
  if (!s.running) return null;
  return (
    <div role="status" style={bar}>
      Still importing: {s.percent}% — data is updating live. <Link to="/debug">Open debug console</Link>
    </div>
  );
}
