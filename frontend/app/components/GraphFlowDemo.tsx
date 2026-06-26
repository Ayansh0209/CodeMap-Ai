"use client";

// GraphFlowDemo.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Self-looping, illustrative recreation of the real focus-graph view for the
// landing page. No network calls — fabricated demo data. It "builds" the graph
// (nodes pop in), draws the right-angle connectors, then sweeps a focus pulse —
// the same visual language as the live layered-flow view so the story matches
// the product. aria-hidden, purely decorative.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";

const CENTER = { x: 192, y: 132, label: "auth.ts" };

// left = "imported by" (green), right = "imports" (blue)
const LEFT = [
  { x: 60, y: 70, label: "login.ts" },
  { x: 44, y: 132, label: "api.ts" },
  { x: 60, y: 194, label: "session.ts" },
];
const RIGHT = [
  { x: 324, y: 70, label: "jwt.ts" },
  { x: 340, y: 132, label: "db.ts" },
  { x: 324, y: 194, label: "crypto.ts" },
];

const CYCLE_MS = 5200;

function elbow(side: "left" | "right", n: { x: number; y: number }) {
  const sign = side === "right" ? 1 : -1;
  const cEdge = CENTER.x + sign * 12;
  const mid = CENTER.x + sign * 54;
  const nEdge = n.x - sign * 10;
  return `M${cEdge},${CENTER.y} H${mid} V${n.y} H${nEdge}`;
}

export default function GraphFlowDemo() {
  const [cycle, setCycle] = useState(0);

  // Remount the inner graph each cycle to replay the entrance animations.
  useEffect(() => {
    const t = setInterval(() => setCycle((c) => c + 1), CYCLE_MS);
    return () => clearInterval(t);
  }, []);

  return (
    <div
      className="rounded-2xl p-4 w-full max-w-md mx-auto select-none"
      style={{ background: "#0d1117", border: "1px solid #30363d" }}
      aria-hidden="true"
    >
      <div className="flex items-center gap-2 mb-2 px-1">
        <span style={{ fontSize: 13 }}>🗺️</span>
        <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "#8b949e" }}>
          Dependency map
        </span>
        <span className="ml-auto text-[10px] font-mono" style={{ color: "#3fb950" }}>
          live
        </span>
      </div>

      <svg key={cycle} viewBox="0 0 384 264" className="w-full" style={{ height: 230 }}>
        {/* column captions */}
        <text x="60" y="28" textAnchor="middle" fontSize="9" fontFamily="monospace" fontWeight="700" fill="#3fb950" opacity="0.85">
          IMPORTED BY
        </text>
        <text x="324" y="28" textAnchor="middle" fontSize="9" fontFamily="monospace" fontWeight="700" fill="#58a6ff" opacity="0.85">
          IMPORTS
        </text>

        {/* edges (draw in after nodes) */}
        {LEFT.map((n, i) => (
          <path
            key={`le${i}`}
            d={elbow("left", n)}
            fill="none"
            stroke="#3fb950"
            strokeWidth="1.4"
            strokeOpacity="0.7"
            pathLength={1}
            className="animate-line-draw"
            style={{ "--delay": `${1.1 + i * 0.18}s` } as React.CSSProperties}
          />
        ))}
        {RIGHT.map((n, i) => (
          <path
            key={`re${i}`}
            d={elbow("right", n)}
            fill="none"
            stroke="#58a6ff"
            strokeWidth="1.4"
            strokeOpacity="0.7"
            pathLength={1}
            className="animate-line-draw"
            style={{ "--delay": `${1.1 + i * 0.18}s` } as React.CSSProperties}
          />
        ))}

        {/* side nodes */}
        {[...LEFT.map((n) => ({ ...n, c: "#3fb950", side: "left" as const })),
          ...RIGHT.map((n) => ({ ...n, c: "#58a6ff", side: "right" as const }))].map((n, i) => (
          <g
            key={`n${i}`}
            className="animate-fade-in-up"
            style={{ "--delay": `${0.15 + i * 0.13}s`, transformOrigin: `${n.x}px ${n.y}px` } as React.CSSProperties}
          >
            <circle cx={n.x} cy={n.y} r="5" fill={n.c} stroke="#0d1117" strokeWidth="1.5" />
            <text
              x={n.side === "left" ? n.x - 10 : n.x + 10}
              y={n.y}
              dy="0.32em"
              textAnchor={n.side === "left" ? "end" : "start"}
              fontSize="9.5"
              fontFamily="monospace"
              fill="#e6edf3"
            >
              {n.label}
            </text>
          </g>
        ))}

        {/* center node anchors the graph; ring below pulses last as a focus beat */}
        <g
          className="animate-fade-in-up"
          style={{ "--delay": "0.05s", transformOrigin: `${CENTER.x}px ${CENTER.y}px` } as React.CSSProperties}
        >
          <circle cx={CENTER.x} cy={CENTER.y} r="9" fill="#f0883e" stroke="#0d1117" strokeWidth="2" />
          <text x={CENTER.x} y={CENTER.y + 26} textAnchor="middle" fontSize="10" fontFamily="monospace" fontWeight="700" fill="#f0883e">
            {CENTER.label}
          </text>
        </g>
        <circle
          cx={CENTER.x}
          cy={CENTER.y}
          r="13"
          fill="none"
          stroke="#f0883e"
          strokeWidth="1.5"
          className="animate-graphdemo-ring"
          style={{ transformBox: "fill-box", transformOrigin: "center" } as React.CSSProperties}
        />
      </svg>
    </div>
  );
}
