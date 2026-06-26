"use client";

// IssueMapperDemo.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Self-looping, illustrative recreation of the real IssueMapper widget for the
// landing page. No network calls — every value here is fabricated demo data.
// Visual language (badge colors, source tags, card chrome) mirrors the real
// component at app/components/IssueMapper.tsx so the story matches the product.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";

const DEMO_ISSUE = {
  url: "github.com/owner/repo/issues/482",
  title: "Rate limiter lets requests through after burst",
};

const DEMO_FILES = [
  { path: "src/middleware/rateLimiter.ts", confidence: 91 },
  { path: "src/api/routes/login.ts", confidence: 74 },
  { path: "src/lib/redisClient.ts", confidence: 38 },
];

type Phase = "typing" | "analyzing" | "results" | "hold";

const PHASE_DURATIONS: Record<Phase, number> = {
  typing: 1400,
  analyzing: 1600,
  results: 1800 + DEMO_FILES.length * 450,
  hold: 1800,
};

const NEXT_PHASE: Record<Phase, Phase> = {
  typing: "analyzing",
  analyzing: "results",
  results: "hold",
  hold: "typing",
};

function confidenceColor(score: number) {
  if (score >= 70) return "#22c55e";
  if (score >= 40) return "#f0883e";
  return "#8b949e";
}

export default function IssueMapperDemo() {
  const [phase, setPhase] = useState<Phase>("typing");

  useEffect(() => {
    const timer = setTimeout(() => setPhase(NEXT_PHASE[phase]), PHASE_DURATIONS[phase]);
    return () => clearTimeout(timer);
  }, [phase]);

  const showResults = phase === "results" || phase === "hold";

  return (
    <div
      className="rounded-2xl p-5 w-full max-w-md mx-auto"
      style={{ background: "#0d1117", border: "1px solid #30363d" }}
      aria-hidden="true"
    >
      <div className="flex items-center gap-2 mb-3">
        <span style={{ fontSize: 14 }}>🔍</span>
        <span
          className="text-xs font-semibold uppercase tracking-wider"
          style={{ color: "#8b949e" }}
        >
          Map an Issue
        </span>
      </div>

      {/* Fake input bar */}
      <div className="flex gap-2 mb-3">
        <div
          className="flex-1 px-2.5 py-1.5 rounded-lg text-xs overflow-hidden whitespace-nowrap"
          style={{
            background: "#161b22",
            border: "1px solid #30363d",
            color: "#e6edf3",
            fontFamily: "monospace",
          }}
        >
          {phase === "typing" ? (
            <TypingText text={DEMO_ISSUE.url} />
          ) : (
            DEMO_ISSUE.url
          )}
        </div>
        <div
          className="px-3 py-1.5 rounded-lg text-xs font-semibold shrink-0"
          style={{
            background: phase === "analyzing" ? "rgba(88,166,255,0.08)" : "rgba(88,166,255,0.15)",
            color: "#58a6ff",
            border: "1px solid rgba(88,166,255,0.25)",
          }}
        >
          {phase === "analyzing" ? (
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block w-3 h-3 border-2 rounded-full animate-spin"
                style={{ borderColor: "#58a6ff", borderTopColor: "transparent" }}
              />
              Analyzing...
            </span>
          ) : (
            "Find files"
          )}
        </div>
      </div>

      {/* Results */}
      <div className="space-y-1.5 min-h-[110px]">
        {showResults && (
          <>
            <div className="flex items-center gap-2 mb-1.5">
              <span
                className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                style={{ background: "rgba(168,85,247,0.1)", color: "#a855f7" }}
              >
                ✨ AI
              </span>
              <span className="text-[10px]" style={{ color: "#8b949e" }}>
                {DEMO_FILES.length} files found
              </span>
              <span className="ml-auto text-[10px] font-bold" style={{ color: "#22c55e" }}>
                91%
              </span>
            </div>
            <p className="text-[10px] truncate mb-2" style={{ color: "#484f58" }}>
              #482: {DEMO_ISSUE.title}
            </p>

            {DEMO_FILES.map((file, i) => (
              <div
                key={file.path}
                className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg animate-fade-in-up"
                style={{
                  background: "#161b22",
                  border: "1px solid #21262d",
                  "--delay": `${i * 0.45}s`,
                } as React.CSSProperties}
              >
                <span
                  className="text-[11px] truncate"
                  style={{ color: "#e6edf3", fontFamily: "monospace" }}
                >
                  {file.path}
                </span>
                <span
                  className="text-[10px] font-bold shrink-0"
                  style={{ color: confidenceColor(file.confidence) }}
                >
                  {file.confidence}%
                </span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// ── Typing effect for the fake URL ──────────────────────────────────────────

function TypingText({ text }: { text: string }) {
  const [chars, setChars] = useState(0);

  useEffect(() => {
    setChars(0);
    const interval = setInterval(() => {
      setChars((c) => (c < text.length ? c + 1 : c));
    }, 1400 / text.length);
    return () => clearInterval(interval);
  }, [text]);

  return (
    <>
      {text.slice(0, chars)}
      <span className="animate-pulse-dot">|</span>
    </>
  );
}
