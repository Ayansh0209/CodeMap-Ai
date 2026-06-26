"use client";

// FixFlowDemo.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Self-looping story of the core workflow for the landing page:
//   issue  →  mapped files  →  AI chat explains the fix  →  inspect the exact
//   function to change.
// The point it sells: you get a starting point and only the connected pieces to
// touch — you never read the whole repo. No network calls; fabricated data.
// aria-hidden, purely decorative.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";

type Step = 0 | 1 | 2 | 3 | 4; // issue · map · chat · inspect · hold
const DURATIONS = [1500, 1700, 2400, 1900, 1900];

const FILES = [
  { path: "middleware/rateLimiter.ts", conf: 92 },
  { path: "api/routes/login.ts", conf: 71 },
];

function confColor(c: number) {
  if (c >= 70) return "#3fb950";
  if (c >= 40) return "#d29922";
  return "#8b949e";
}

export default function FixFlowDemo() {
  const [step, setStep] = useState<Step>(0);

  useEffect(() => {
    const t = setTimeout(() => setStep((s) => ((s + 1) % 5) as Step), DURATIONS[step]);
    return () => clearTimeout(t);
  }, [step]);

  return (
    <div
      className="rounded-2xl p-4 w-full max-w-md mx-auto select-none space-y-2.5"
      style={{ background: "#0d1117", border: "1px solid #30363d" }}
      aria-hidden="true"
    >
      {/* 1 — the issue */}
      <div
        className="flex items-center gap-2 px-2.5 py-2 rounded-lg"
        style={{ background: "#161b22", border: "1px solid #30363d" }}
      >
        <span
          className="text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0"
          style={{ background: "rgba(63,185,80,0.15)", color: "#3fb950" }}
        >
          ISSUE
        </span>
        <span className="text-[11px] truncate" style={{ color: "#e6edf3", fontFamily: "monospace" }}>
          #482 Rate limiter lets requests through after burst
        </span>
      </div>

      <StepArrow active={step >= 1} />

      {/* 2 — mapped files */}
      <div className="min-h-[58px] space-y-1.5">
        {step >= 1 ? (
          <>
            <div className="flex items-center gap-2 px-1">
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded" style={{ background: "rgba(168,85,247,0.12)", color: "#a855f7" }}>
                ✨ MAPPED
              </span>
              <span className="text-[10px]" style={{ color: "#8b949e" }}>2 files · graph-ranked</span>
            </div>
            {FILES.map((f, i) => (
              <div
                key={f.path}
                className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg animate-fade-in-up"
                style={{ background: "#161b22", border: "1px solid #21262d", "--delay": `${i * 0.18}s` } as React.CSSProperties}
              >
                <span className="text-[11px] truncate" style={{ color: "#e6edf3", fontFamily: "monospace" }}>{f.path}</span>
                <span className="text-[10px] font-bold shrink-0" style={{ color: confColor(f.conf) }}>{f.conf}%</span>
              </div>
            ))}
          </>
        ) : (
          <Placeholder label="ranking files…" />
        )}
      </div>

      <StepArrow active={step >= 2} />

      {/* 3 — AI chat explains the fix */}
      <div className="min-h-[64px]">
        {step >= 2 ? (
          <div className="flex gap-2 animate-fade-in-up">
            <div
              className="w-6 h-6 rounded-full shrink-0 flex items-center justify-center text-[11px]"
              style={{ background: "linear-gradient(135deg,#fb7a3c,#ec4899)" }}
            >
              ✦
            </div>
            <div
              className="text-[11px] leading-relaxed px-3 py-2 rounded-xl rounded-tl-sm"
              style={{ background: "#161b22", border: "1px solid #30363d", color: "#e6edf3" }}
            >
              The window resets on the <span style={{ color: "#f0883e" }}>first</span> call after a burst.
              Move the reset <span style={{ color: "#f0883e" }}>inside</span> the throttle check in{" "}
              <code style={{ color: "#79c0ff" }}>checkLimit()</code>.
            </div>
          </div>
        ) : (
          <Placeholder label="asking the assistant…" />
        )}
      </div>

      <StepArrow active={step >= 3} />

      {/* 4 — inspect the exact function */}
      <div className="min-h-[44px]">
        {step >= 3 ? (
          <div
            className="flex items-center gap-2 px-2.5 py-2 rounded-lg animate-fade-in-up"
            style={{
              background: "rgba(240,136,62,0.08)",
              border: "1px solid rgba(240,136,62,0.4)",
              boxShadow: "0 0 0 1px rgba(240,136,62,0.1)",
            }}
          >
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0" style={{ background: "rgba(240,136,62,0.15)", color: "#f0883e" }}>
              fn
            </span>
            <span className="text-[11px]" style={{ color: "#e6edf3", fontFamily: "monospace" }}>checkLimit()</span>
            <span className="text-[10px] ml-auto shrink-0" style={{ color: "#8b949e", fontFamily: "monospace" }}>rateLimiter.ts · L34–58</span>
          </div>
        ) : (
          <Placeholder label="locating the function…" />
        )}
      </div>
    </div>
  );
}

function StepArrow({ active }: { active: boolean }) {
  return (
    <div className="flex justify-center">
      <svg width="16" height="14" viewBox="0 0 16 14" style={{ opacity: active ? 1 : 0.2, transition: "opacity 0.4s" }}>
        <path d="M8 1v9M4 7l4 4 4-4" fill="none" stroke={active ? "#f0883e" : "#484f58"} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function Placeholder({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-1 h-full">
      <span className="inline-block w-3 h-3 border-2 rounded-full animate-spin" style={{ borderColor: "#30363d", borderTopColor: "#8b949e" }} />
      <span className="text-[10px]" style={{ color: "#484f58", fontFamily: "monospace" }}>{label}</span>
    </div>
  );
}
