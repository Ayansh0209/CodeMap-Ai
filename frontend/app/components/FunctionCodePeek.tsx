"use client";

// FunctionCodePeek.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Inline, syntax-highlighted preview of a single function's body (startLine →
// endLine) — so you can read a function without leaving for the Code tab.
// Fetches the file once (module-level cache shared across peeks), slices the
// function's lines, highlights with the shared highlight.js setup. Lazy: nothing
// is fetched until a peek is actually opened.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from "react";
import { fetchFileContent } from "../lib/client";
import { highlightCode, langFromPath } from "../lib/highlight";
import "highlight.js/styles/github-dark.css";

// filePath -> full file content (one fetch per file, reused by every peek)
const fileCache = new Map<string, string>();

interface FunctionCodePeekProps {
  owner: string;
  repo: string;
  commitSha: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

export default function FunctionCodePeek({
  owner, repo, commitSha, filePath, startLine, endLine,
}: FunctionCodePeekProps) {
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; html?: string }>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    const slice = (content: string) => {
      const lines = content.split("\n").slice(Math.max(0, startLine - 1), Math.max(startLine, endLine));
      // Strip the common leading indentation so a deeply-nested function reads
      // from the left edge instead of being shoved to the right.
      let minIndent = Infinity;
      for (const line of lines) {
        if (!line.trim()) continue; // ignore blank lines
        minIndent = Math.min(minIndent, line.match(/^\s*/)?.[0].length ?? 0);
      }
      const dedented = minIndent && minIndent !== Infinity ? lines.map((l) => l.slice(minIndent)) : lines;
      return dedented.join("\n");
    };
    const render = (content: string) =>
      setState({ status: "ready", html: highlightCode(slice(content), langFromPath(filePath)) });

    const cached = fileCache.get(filePath);
    if (cached != null) { render(cached); return; }

    setState({ status: "loading" });
    fetchFileContent(owner, repo, commitSha, filePath)
      .then((res) => {
        if (cancelled) return;
        if (res.content == null) { setState({ status: "error" }); return; }
        fileCache.set(filePath, res.content);
        render(res.content);
      })
      .catch(() => { if (!cancelled) setState({ status: "error" }); });

    return () => { cancelled = true; };
  }, [owner, repo, commitSha, filePath, startLine, endLine]);

  return (
    <div className="rounded-lg overflow-hidden mt-2" style={{ background: "#0d1117", border: "1px solid #21262d" }}>
      <div
        className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px]"
        style={{ background: "#161b22", borderBottom: "1px solid #21262d", color: "#8b949e", fontFamily: "var(--font-geist-mono), monospace" }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M16 18l6-6-6-6M8 6l-6 6 6 6" />
        </svg>
        {filePath.split("/").pop()} · L{startLine}–{endLine}
      </div>
      <div className="overflow-auto" style={{ maxHeight: 260 }}>
        {state.status === "loading" ? (
          <div className="flex items-center gap-2 px-3 py-4 text-[11px]" style={{ color: "#8b949e" }}>
            <span className="inline-block w-3.5 h-3.5 border-2 rounded-full animate-spin" style={{ borderColor: "#30363d", borderTopColor: "#8b949e" }} />
            Loading code…
          </div>
        ) : state.status === "error" ? (
          <div className="px-3 py-3 text-[11px]" style={{ color: "#f85149" }}>
            Couldn&apos;t load this function&apos;s code.
          </div>
        ) : (
          <pre className="m-0 p-3" style={{ fontFamily: "var(--font-geist-mono), ui-monospace, monospace", fontSize: 12, lineHeight: 1.6 }}>
            <code className="whitespace-pre" style={{ color: "#e6edf3" }} dangerouslySetInnerHTML={{ __html: state.html || " " }} />
          </pre>
        )}
      </div>
    </div>
  );
}
