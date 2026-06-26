"use client";

// FunctionGraphDemo.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Self-looping landing-page demo of the function call graph: a function being
// edited in the middle, the callers that depend on it (left) and the callees it
// needs (right) lighting up — i.e. "what breaks if I change this." Same visual
// language as the live function-graph view. aria-hidden, fabricated data.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";

const CENTER = { x: 175, y: 110, label: "updateUser()" };
const CALLERS = [
  { y: 62, label: "loginRoute" },
  { y: 110, label: "signupRoute" },
  { y: 158, label: "session.ts" },
];
const CALLEES = [
  { y: 80, label: "hashPassword" },
  { y: 140, label: "db.users" },
];

export default function FunctionGraphDemo() {
  const [cycle, setCycle] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setCycle((c) => c + 1), 4200);
    return () => clearInterval(t);
  }, []);

  return (
    <div
      className="rounded-2xl p-4 w-full max-w-md mx-auto select-none"
      style={{ background: "#0d1117", border: "1px solid #30363d" }}
      aria-hidden="true"
    >
      <div className="flex items-center gap-2 mb-2 px-1">
        <span style={{ fontSize: 13 }}>🔧</span>
        <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "#8b949e" }}>
          Change impact
        </span>
        <span className="ml-auto text-[10px] font-mono" style={{ color: "#f0883e" }}>editing</span>
      </div>

      <svg key={cycle} viewBox="0 0 350 222" className="w-full" style={{ height: 200 }}>
        <text x="55" y="22" textAnchor="middle" fontSize="9" fontFamily="monospace" fontWeight="700" fill="#3fb950">CALLERS</text>
        <text x="295" y="22" textAnchor="middle" fontSize="9" fontFamily="monospace" fontWeight="700" fill="#58a6ff">CALLEES</text>

        {/* edges draw in after nodes */}
        {CALLERS.map((c, i) => (
          <path
            key={`ce${i}`}
            d={`M55,${c.y} H112 V${CENTER.y} H${CENTER.x - 12}`}
            fill="none" stroke="#3fb950" strokeWidth="1.4" strokeOpacity="0.7"
            pathLength={1} className="animate-line-draw"
            style={{ "--delay": `${0.9 + i * 0.15}s` } as React.CSSProperties}
          />
        ))}
        {CALLEES.map((c, i) => (
          <path
            key={`ee${i}`}
            d={`M${CENTER.x + 12},${CENTER.y} H238 V${c.y} H295`}
            fill="none" stroke="#58a6ff" strokeWidth="1.4" strokeOpacity="0.7"
            pathLength={1} className="animate-line-draw"
            style={{ "--delay": `${0.9 + i * 0.15}s` } as React.CSSProperties}
          />
        ))}

        {CALLERS.map((c, i) => (
          <g key={`cn${i}`} className="animate-fade-in-up" style={{ "--delay": `${0.2 + i * 0.12}s` } as React.CSSProperties}>
            <circle cx="55" cy={c.y} r="5" fill="#3fb950" stroke="#0d1117" strokeWidth="1.5" />
            <text x="44" y={c.y} dy="0.32em" textAnchor="end" fontSize="9.5" fontFamily="monospace" fill="#e6edf3">{c.label}</text>
          </g>
        ))}
        {CALLEES.map((c, i) => (
          <g key={`en${i}`} className="animate-fade-in-up" style={{ "--delay": `${0.2 + i * 0.12}s` } as React.CSSProperties}>
            <circle cx="295" cy={c.y} r="5" fill="#58a6ff" stroke="#0d1117" strokeWidth="1.5" />
            <text x="306" y={c.y} dy="0.32em" textAnchor="start" fontSize="9.5" fontFamily="monospace" fill="#e6edf3">{c.label}</text>
          </g>
        ))}

        {/* the function being changed */}
        <g className="animate-fade-in-up" style={{ "--delay": "0.05s", transformOrigin: `${CENTER.x}px ${CENTER.y}px` } as React.CSSProperties}>
          <circle cx={CENTER.x} cy={CENTER.y} r="9" fill="#f0883e" stroke="#0d1117" strokeWidth="2" />
          <text x={CENTER.x} y={CENTER.y + 24} textAnchor="middle" fontSize="10" fontFamily="monospace" fontWeight="700" fill="#f0883e">{CENTER.label}</text>
        </g>
        <circle
          cx={CENTER.x} cy={CENTER.y} r="13" fill="none" stroke="#f0883e" strokeWidth="1.5"
          className="animate-graphdemo-ring"
          style={{ transformBox: "fill-box", transformOrigin: "center" } as React.CSSProperties}
        />
      </svg>

      <p className="text-[11px] text-center mt-1" style={{ color: "#8b949e" }}>
        Edit a function → see <span style={{ color: "#3fb950" }}>who breaks</span> and <span style={{ color: "#58a6ff" }}>what it needs</span>.
      </p>
    </div>
  );
}
