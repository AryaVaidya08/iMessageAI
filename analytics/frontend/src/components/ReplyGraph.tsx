import { useMemo } from "react";

import type { ReplyGraphEdge } from "../api/client";
import styles from "./ReplyGraph.module.css";

const MAX_NODES = 12;
const SIZE = 420;
const CENTER = SIZE / 2;
const RADIUS = 160;

interface Node {
  id: string;
  label: string;
  weight: number;
  x: number;
  y: number;
}

function buildLayout(edges: ReplyGraphEdge[]): { nodes: Node[]; edges: ReplyGraphEdge[] } {
  const weight = new Map<string, number>();
  const label = new Map<string, string>();
  for (const e of edges) {
    weight.set(e.replier_id, (weight.get(e.replier_id) ?? 0) + e.count);
    weight.set(e.original_id, (weight.get(e.original_id) ?? 0) + e.count);
    label.set(e.replier_id, e.replier_display_name);
    label.set(e.original_id, e.original_display_name);
  }

  const ranked = [...weight.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_NODES);
  const keptIds = new Set(ranked.map(([id]) => id));

  const nodes: Node[] = ranked.map(([id, w], i) => {
    const angle = (2 * Math.PI * i) / ranked.length - Math.PI / 2;
    return {
      id,
      label: label.get(id) ?? "Unknown",
      weight: w,
      x: CENTER + RADIUS * Math.cos(angle),
      y: CENTER + RADIUS * Math.sin(angle),
    };
  });

  const keptEdges = edges.filter((e) => keptIds.has(e.replier_id) && keptIds.has(e.original_id));
  return { nodes, edges: keptEdges };
}

export function ReplyGraph({ edges }: { edges: ReplyGraphEdge[] }) {
  const { nodes, edges: keptEdges } = useMemo(() => buildLayout(edges), [edges]);

  if (nodes.length === 0) {
    return <div className={styles.empty}>Not enough reply data to build a graph yet.</div>;
  }

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const maxCount = Math.max(...keptEdges.map((e) => e.count), 1);
  const maxWeight = Math.max(...nodes.map((n) => n.weight), 1);

  return (
    <div className={styles.card}>
      <p className={styles.caption}>
        Who replies to whom{nodes.length === MAX_NODES ? ` (top ${MAX_NODES} by reply volume)` : ""}. Line
        thickness is reply count; hover an edge or person for detail.
      </p>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className={styles.svg} role="img" aria-label="Who-replies-to-whom graph">
        <defs>
          <marker id="reply-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--color-accent)" />
          </marker>
        </defs>
        {keptEdges.map((e, i) => {
          const from = nodeById.get(e.replier_id);
          const to = nodeById.get(e.original_id);
          if (!from || !to) return null;
          const strokeWidth = 1 + (e.count / maxCount) * 5;
          const opacity = 0.25 + (e.count / maxCount) * 0.6;
          return (
            <line
              key={`${e.replier_id}-${e.original_id}-${i}`}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke="var(--color-accent)"
              strokeWidth={strokeWidth}
              strokeOpacity={opacity}
              markerEnd="url(#reply-arrow)"
            >
              <title>
                {from.label} replied to {to.label}: {e.count.toLocaleString()} times
              </title>
            </line>
          );
        })}
        {nodes.map((n) => {
          const r = 8 + (n.weight / maxWeight) * 14;
          return (
            <g key={n.id}>
              <circle cx={n.x} cy={n.y} r={r} fill="var(--color-surface)" stroke="var(--color-accent)" strokeWidth={2}>
                <title>
                  {n.label}: {n.weight.toLocaleString()} replies total
                </title>
              </circle>
              <text
                x={n.x}
                y={n.y + r + 14}
                textAnchor="middle"
                className={styles.nodeLabel}
              >
                {n.label.length > 14 ? `${n.label.slice(0, 13)}…` : n.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
