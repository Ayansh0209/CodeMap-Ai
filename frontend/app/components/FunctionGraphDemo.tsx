"use client";

// FunctionGraphDemo.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Self-looping landing-page demo that mirrors the REAL function-graph view:
// caller cards (left) ← the function card (centre) → callee cards (right), with
// the "← calls this / this calls →" hints. Animated card entrance. aria-hidden,
// fabricated data.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";

const CALLERS = [
  { name: "loginRoute", badge: "fn", meta: "routes.ts · L40" },
  { name: "signupRoute", badge: "fn", meta: "routes.ts · L58" },
];
const CALLEES = [
  { name: "hashPassword", badge: "fn", meta: "crypto.ts · L12" },
  { name: "db.users", badge: "query", meta: "db.ts · L8" },
];

function MiniCard({ name, badge, meta, color, delay, align = "left" }: {
  name: string; badge: string; meta: string; color: string; delay: number; align?: "left" | "right";
}) {
  return (
    <div
      className="rounded-lg px-2 py-1.5 animate-fade-in-up"
      style={{ background: "#161b22", border: `1px solid ${color}66`, "--delay": `${delay}s` } as React.CSSProperties}
    >
      <div className={`flex items-center gap-1.5 ${align === "right" ? "flex-row-reverse" : ""}`}>
        <span className="text-[10px] font-bold truncate flex-1" style={{ fontFamily: "monospace", color: "#e6edf3", textAlign: align }}>{name}</span>
        <span className="text-[7px] px-1 py-0.5 rounded shrink-0" style={{ background: `${color}22`, color }}>{badge}</span>
      </div>
      <div className="text-[7.5px] mt-0.5" style={{ color: "#484f58", fontFamily: "monospace", textAlign: align }}>{meta}</div>
    </div>
  );
}

export default function FunctionGraphDemo() {
  const [cycle, setCycle] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setCycle((c) => c + 1), 4600);
    return () => clearInterval(t);
  }, []);

  return (
    <div
      className="rounded-2xl p-4 w-full max-w-md mx-auto select-none"
      style={{ background: "#0d1117", border: "1px solid #30363d" }}
      aria-hidden="true"
    >
      <div className="flex items-center gap-2 mb-3 px-1">
        <span style={{ fontSize: 13 }}>🔧</span>
        <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "#8b949e" }}>Function graph</span>
        <span className="ml-auto text-[10px] font-mono" style={{ color: "#f0883e" }}>editing</span>
      </div>

      <div key={cycle} className="grid grid-cols-[1fr_auto_1fr] gap-2 items-center">
        {/* Callers */}
        <div className="space-y-1.5">
          <div className="text-[8px] font-bold uppercase tracking-wider mb-0.5" style={{ color: "#3fb950" }}>Callers 2</div>
          {CALLERS.map((c, i) => <MiniCard key={c.name} {...c} color="#3fb950" delay={0.3 + i * 0.13} />)}
        </div>

        {/* Centre — the function being edited */}
        <div className="flex flex-col items-center gap-1">
          <div className="text-[7.5px]" style={{ color: "#484f58" }}>← calls this</div>
          <div
            className="rounded-xl px-3 py-2 text-center animate-fade-in-up"
            style={{ background: "#1c2128", border: "2px solid #f0883e", boxShadow: "0 0 20px -5px rgba(240,136,62,0.45)", "--delay": "0.05s" } as React.CSSProperties}
          >
            <div className="text-xs font-bold" style={{ fontFamily: "monospace", color: "#e6edf3" }}>updateUser()</div>
            <div className="text-[8px] mt-0.5" style={{ color: "#8b949e", fontFamily: "monospace" }}>auth.ts · L24–38</div>
            <span className="inline-block mt-1 text-[8px] px-1 py-0.5 rounded" style={{ background: "rgba(88,166,255,0.15)", color: "#58a6ff" }}>exp</span>
          </div>
          <div className="text-[7.5px]" style={{ color: "#484f58" }}>this calls →</div>
        </div>

        {/* Callees */}
        <div className="space-y-1.5">
          <div className="text-[8px] font-bold uppercase tracking-wider mb-0.5 text-right" style={{ color: "#58a6ff" }}>Callees 2</div>
          {CALLEES.map((c, i) => <MiniCard key={c.name} {...c} color="#58a6ff" delay={0.3 + i * 0.13} align="right" />)}
        </div>
      </div>

      <p className="text-[11px] text-center mt-3" style={{ color: "#8b949e" }}>
        Edit a function → see <span style={{ color: "#3fb950" }}>who breaks</span> and <span style={{ color: "#58a6ff" }}>what it needs</span>.
      </p>
    </div>
  );
}
