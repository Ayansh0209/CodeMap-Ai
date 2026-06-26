"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import InputBar from "./components/InputBar";
import ProgressBar from "./components/ProgressBar";
import IssueMapperDemo from "./components/IssueMapperDemo";
import GraphFlowDemo from "./components/GraphFlowDemo";
import FixFlowDemo from "./components/FixFlowDemo";
import NetworkBackdrop from "./components/NetworkBackdrop";
import LanguagesSection from "./components/LanguagesSection";
import { useJobPolling } from "./hooks/useJobPolling";
import { submitAnalysis, fetchFileGraph } from "./lib/client";
import { saveGraphPayload, graphKey } from "./lib/graphStore";
import MobileWarning from "./components/MobileWarning";
import { GITHUB_REPO_URL } from "./lib/constants";

export default function Home() {
  const router = useRouter();
  const {
    status,
    progress,
    step,
    position,
    error: pollError,
    result,
    startPolling,
    reset,
  } = useJobPolling();

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showWarning, setShowWarning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [stars, setStars] = useState<number | null>(null);

  useEffect(() => {
    const checkWarning = () => {
      const dismissed = sessionStorage.getItem("codemap_dismissed_warning");
      if (!dismissed && window.innerWidth < 768) {
        setShowWarning(true);
      }
    };
    checkWarning();

    // Live GitHub star count for the top bar (best-effort, unauthenticated).
    const match = GITHUB_REPO_URL.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (match) {
      fetch(`https://api.github.com/repos/${match[1]}/${match[2]}`)
        .then((res) => res.json())
        .then((data) => {
          if (typeof data.stargazers_count === "number") setStars(data.stargazers_count);
        })
        .catch(() => {});
    }
  }, []);

  const isLoading =
    submitting ||
    status === "processing" ||
    status === "queued" ||
    status === "delayed";

  // ── Navigate to /repo on completion ─────────────────────────────────────────
  // Small repos arrive inline; big repos are fetched from GET /graph (gzipped).
  // Either way the graph is stored in IndexedDB (no 5MB sessionStorage limit).
  useEffect(() => {
    if (status !== "done" || !result) return;

    const owner = result.owner || "";
    const repo = result.repo || "";

    (async () => {
      try {
        let graph = result._inlineFileGraph ?? null;

        if (!graph) {
          console.log("[page] graph not inline (big repo) — fetching from /graph endpoint");
          graph = await fetchFileGraph(owner, repo, result.commitSha);
        }

        if (!graph) {
          setSubmitError("Analysis finished but no graph was returned. Please try again.");
          return;
        }

        await saveGraphPayload(graphKey(owner, repo), {
          owner,
          repo,
          commitSha: result.commitSha,
          defaultBranch: result.defaultBranch,
          stats: result.stats,
          fileGraphUrl: result.fileGraphUrl,
          functionsBaseUrl: result.functionsBaseUrl,
          _inlineFileGraph: graph,
        });

        router.push(`/repo?repo=${owner}/${repo}`);
      } catch (err) {
        console.error("[page] Failed to load/persist graph:", err);
        setSubmitError(
          err instanceof Error ? err.message : "Failed to load the analyzed graph"
        );
      }
    })();
  }, [status, result, router]);

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleSubmit = useCallback(
    async (repoUrl: string) => {
      // Hard guard against double-submit (rapid clicks, Enter spam, two tabs).
      // The ref blocks re-entry synchronously; setSubmitting disables the button.
      if (submittingRef.current) return;
      submittingRef.current = true;
      setSubmitting(true);
      setSubmitError(null);
      try {
        const { jobId } = await submitAnalysis(repoUrl);
        startPolling(jobId);
      } catch (err) {
        setSubmitError(
          err instanceof Error ? err.message : "Failed to submit"
        );
      } finally {
        // Polling status now keeps the button disabled; release the submit lock.
        submittingRef.current = false;
        setSubmitting(false);
      }
    },
    [startPolling]
  );

  const handleReset = useCallback(() => {
    reset();
    setSubmitError(null);
    submittingRef.current = false;
    setSubmitting(false);
  }, [reset]);

  return (
    <div className="flex flex-col min-h-screen aurora-bg isolate">
      <NetworkBackdrop />
      {/* ── Top bar: brand + Star on GitHub ──────────────────────────── */}
      <div className="relative z-10 flex items-center justify-between px-5 sm:px-8 py-3">
        <a href={GITHUB_REPO_URL} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
            </svg>
          </div>
          <span className="font-bold text-sm tracking-tight">
            <span className="text-foreground">Code</span><span className="text-primary">Map</span><span className="text-accent ml-0.5 text-xs">AI</span>
          </span>
        </a>
        <a
          href={GITHUB_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:scale-105"
          style={{ background: "rgba(255,255,255,0.04)", border: "1px solid var(--border-color)", color: "var(--foreground)" }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .3a12 12 0 00-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.3-1.8-1.3-1.8-1-.7.1-.7.1-.7 1.2 0 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 0-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.2.5-2.3 1.3-3.1-.2-.3-.6-1.6 0-3.2 0 0 1-.3 3.4 1.2a11.5 11.5 0 016 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.6.2 2.9 0 3.2.9.8 1.3 1.9 1.3 3.2 0 4.6-2.8 5.6-5.5 5.9.5.4.9 1 .9 2.2v3.3c0 .3.1.7.8.6A12 12 0 0012 .3" /></svg>
          Star on GitHub
          {stars !== null && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] ml-0.5" style={{ background: "var(--background)", border: "1px solid var(--border-color)" }}>
              <span style={{ color: "#e3b341" }}>★</span>
              {stars > 999 ? (stars / 1000).toFixed(1) + "k" : stars}
            </span>
          )}
        </a>
      </div>
      {showWarning && (
        <MobileWarning
          onContinue={() => {
            sessionStorage.setItem("codemap_dismissed_warning", "true");
            setShowWarning(false);
          }}
        />
      )}
      {/* ── Hero / Landing Section ─────────────────────────────────────── */}
      <header className="relative flex flex-col items-center justify-center px-6 pt-10 pb-12 overflow-hidden">
        {/* Decorative dot-grid + node graph, idle/failed only — purely visual */}
        {(status === "idle" || status === "failed") && (
          <div className="absolute inset-0 -z-10 dot-grid-bg" />
        )}
        {(status === "idle" || status === "failed") && <HeroGraphViz />}

        {/* Logo / Brand */}
        <div className="flex items-center gap-3 mb-5 animate-float">
          <div className="relative">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-primary to-accent flex items-center justify-center">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="white"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
              </svg>
            </div>
            <div className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-green-400 border-2 border-background" />
          </div>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
            <span className="text-foreground">Code</span>
            <span className="text-primary">Map</span>
            <span className="text-accent ml-1 text-lg font-medium">AI</span>
          </h1>
        </div>

        {/* Story-driven headline */}
        <h2
          className="text-2xl md:text-3xl font-bold text-center max-w-2xl mb-3 tracking-tight animate-fade-in-up"
          style={{ "--delay": "0.2s" } as React.CSSProperties}
        >
          Stop drowning in <span className="text-primary">someone else&apos;s</span> codebase.
        </h2>

        {/* Tagline */}
        <p
          className="text-muted text-center text-lg max-w-xl mb-2 animate-fade-in-up"
          style={{ "--delay": "0.3s" } as React.CSSProperties}
        >
          Paste a GitHub URL. Get an interactive visual map of the entire
          codebase.
        </p>
        <p
          className="text-muted/60 text-center text-sm max-w-md mb-10 animate-fade-in-up"
          style={{ "--delay": "0.4s" } as React.CSSProperties}
        >
          File dependencies · Function calls · Architecture — all
          deterministic, no AI guessing.
        </p>

        {/* Input */}
        <InputBar
          onSubmit={handleSubmit}
          isLoading={isLoading}
          error={submitError || (status === "failed" ? pollError : null)}
        />

        {/* Progress */}
        {(status === "processing" ||
          status === "queued" ||
          status === "delayed") && (
            <ProgressBar
              progress={progress}
              step={step}
              status={status}
              position={position}
            />
          )}

        {/* Completed progress — shown briefly before redirect */}
        {status === "done" && (
          <ProgressBar progress={100} step="done" status="done" position={0} />
        )}
      </header>

      {(status === "idle" || status === "failed") && (
        <>
          {/* ── Why this exists ──────────────────────────────────────────── */}
          <section className="max-w-3xl mx-auto px-6 pb-16 w-full">
            <div className="rounded-3xl border border-border bg-surface/40 p-8 md:p-10 text-center">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent mb-4">
                Why this exists
              </p>
              <p className="text-xl md:text-2xl font-bold text-foreground leading-snug">
                You shouldn&apos;t have to read <span className="text-primary">10,000 lines</span> to change <span className="text-accent">10</span>.
              </p>
              <p className="text-muted leading-relaxed mt-3 max-w-xl mx-auto">
                CodeMap turns an unfamiliar repo into a map you can actually see —
                so you find the right file in seconds, not an afternoon.
              </p>
            </div>
          </section>

          {/* ── Graph spotlight: the core map ─────────────────────────────── */}
          <section className="max-w-5xl mx-auto px-6 pb-20 w-full">
            <div className="rounded-3xl border border-border bg-surface/50 p-8 md:p-12 grid grid-cols-1 md:grid-cols-2 gap-10 items-center">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-primary mb-3">
                  The map
                </p>
                <h3 className="text-2xl font-bold text-foreground mb-4 tracking-tight">
                  Your whole codebase,
                  <br />
                  as a map you can read.
                </h3>
                <p className="text-muted leading-relaxed mb-4">
                  Pick any file and CodeMap shows exactly what it imports, what
                  imports it, and how the pieces connect — laid out so even a
                  300-file hub stays readable instead of a hairball.
                </p>
                <ul className="space-y-2 text-sm text-muted/80">
                  <li className="flex items-start gap-2"><span className="text-primary mt-0.5">→</span> Right-angle connectors, no tangled spaghetti</li>
                  <li className="flex items-start gap-2"><span className="text-primary mt-0.5">→</span> Hover any node to light up its real connections</li>
                  <li className="flex items-start gap-2"><span className="text-primary mt-0.5">→</span> Honest counts — imports vs imported-by, matched to the source</li>
                </ul>
              </div>
              <GraphFlowDemo />
            </div>
          </section>

          {/* ── Feature Cards ─────────────────────────────────────────────── */}
          <section className="max-w-5xl mx-auto px-6 pb-20 w-full">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <FeatureCard
                icon={
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                    <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
                  </svg>
                }
                title="File Dependencies"
                description="See every import relationship as a visual edge. Understand how files connect at a glance."
              />
              <FeatureCard
                icon={
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M8 3H5a2 2 0 00-2 2v3M21 8V5a2 2 0 00-2-2h-3M3 16v3a2 2 0 002 2h3M16 21h3a2 2 0 002-2v-3" />
                    <circle cx="12" cy="12" r="4" />
                  </svg>
                }
                title="Function Call Graph"
                description="About to change a function? See exactly who calls it and what it calls first — so you only touch what's connected, nothing breaks downstream, and your PR doesn't get sent back."
              />
              <FeatureCard
                icon={
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
                  </svg>
                }
                title="One-Click GitHub"
                description="Every function links directly to its exact lines on GitHub. No hunting through code."
              />
            </div>
          </section>

          {/* ── Issue Mapper spotlight ────────────────────────────────────── */}
          <section className="max-w-5xl mx-auto px-6 pb-20 w-full">
            <div className="rounded-3xl border border-border bg-surface/50 p-8 md:p-12 grid grid-cols-1 md:grid-cols-2 gap-10 items-center">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-primary mb-3">
                  Issue Mapper
                </p>
                <h3 className="text-2xl font-bold text-foreground mb-4 tracking-tight">
                  Don&apos;t browse 100 files.
                  <br />
                  Start with the right one.
                </h3>
                <p className="text-muted leading-relaxed mb-4">
                  Picked up your first &quot;good first issue&quot; and have
                  no idea which file to open? Paste the issue URL. We walk the
                  dependency graph, rank the files most likely to be involved,
                  and give you a confidence score for each — so you start
                  fixing code instead of hunting for it.
                </p>
                <ul className="space-y-2 text-sm text-muted/80">
                  <li className="flex items-start gap-2">
                    <span className="text-primary mt-0.5">→</span>
                    Traces the issue text against your real import &amp; call graph
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-primary mt-0.5">→</span>
                    Falls back to AI ranking when the graph alone isn&apos;t conclusive
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-primary mt-0.5">→</span>
                    Caches results, so a repeat lookup is instant
                  </li>
                </ul>
              </div>
              <IssueMapperDemo />
            </div>
          </section>

          {/* ── Fix-flow spotlight: issue → exact lines (the whole story) ─── */}
          <section className="max-w-5xl mx-auto px-6 pb-20 w-full">
            <div className="rounded-3xl border border-border bg-surface/50 p-8 md:p-12 grid grid-cols-1 md:grid-cols-2 gap-10 items-center">
              <div className="order-2 md:order-1">
                <FixFlowDemo />
              </div>
              <div className="order-1 md:order-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-accent mb-3">
                  Issue → fix, end to end
                </p>
                <h3 className="text-2xl font-bold text-foreground mb-4 tracking-tight">
                  A starting point — and only the
                  <br />
                  pieces that actually change.
                </h3>
                <p className="text-muted leading-relaxed mb-4">
                  Map an issue and you get the handful of files it touches. Open
                  the AI chat to understand the bug in context, then jump
                  straight to the exact function and lines to edit. You change
                  the connected pieces — you never read the whole repo.
                </p>
                <ul className="space-y-2 text-sm text-muted/80">
                  <li className="flex items-start gap-2"><span className="text-accent mt-0.5">→</span> The issue, ranked to its most likely files</li>
                  <li className="flex items-start gap-2"><span className="text-accent mt-0.5">→</span> AI chat that answers against your real graph</li>
                  <li className="flex items-start gap-2"><span className="text-accent mt-0.5">→</span> Inspect the affected function, then edit with confidence</li>
                </ul>
              </div>
            </div>
          </section>

          {/* ── Languages ─────────────────────────────────────────────────── */}
          <LanguagesSection />

          {/* ── How it works ──────────────────────────────────────────────── */}
          <section className="max-w-5xl mx-auto px-6 pb-20 w-full text-center">
            <h2 className="text-xl font-semibold text-foreground mb-8">
              How it works
            </h2>
            <div className="flex flex-col md:flex-row items-center justify-center gap-6 text-sm">
              <Step num={1} text="Paste a GitHub repo URL" />
              <Arrow />
              <Step num={2} text="We download & parse every file" />
              <Arrow />
              <Step num={3} text="Explore the interactive graph" />
              <Arrow />
              <Step num={4} text="Stuck? Map an issue to its files" />
            </div>
          </section>

          {/* ── Founder's note ────────────────────────────────────────────── */}
          <section className="max-w-2xl mx-auto px-6 pb-20 w-full">
            <div className="rounded-2xl border border-border bg-surface/50 p-8 text-center">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted/60 mb-4">
                A note from the person building this
              </p>
              <p className="text-muted leading-relaxed mb-4">
                I built CodeMap AI because I remember staring at a huge
                unfamiliar repo as a beginner, wanting to contribute, and not
                knowing where to even start. If this idea is useful to you
                too, I&apos;d love to hear about it — what&apos;s confusing,
                what&apos;s missing, what would make this an easier on-ramp
                into open source.
              </p>
              <a
                href={GITHUB_REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-sm font-semibold text-primary hover:text-primary-hover transition-colors"
              >
                Open an issue or star the repo
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M7 17L17 7M17 7H7M17 7V17" />
                </svg>
              </a>
            </div>
          </section>
        </>
      )}

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      <footer className="mt-auto py-6 text-center text-xs text-muted/40 border-t border-border/30">
        <a
          href={GITHUB_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-muted transition-colors"
        >
          CodeMap AI
        </a>{" "}
        · Deterministic codebase analysis · No AI hallucinations
      </footer>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────


// Purely decorative mini file-graph behind the hero — modeled on the real
// FocusExplorer view (center file, radiating imports, mono labels).
// aria-hidden, no interaction, no real repo data.
function HeroGraphViz() {
  const center = { x: 400, y: 150 };
  const leaves: Array<{ x: number; y: number; label: string; delay: number }> = [
    { x: 130, y: 50, label: "index.ts", delay: 0 },
    { x: 330, y: 30, label: "router.ts", delay: 0.15 },
    { x: 540, y: 35, label: "auth.ts", delay: 0.3 },
    { x: 700, y: 90, label: "db.ts", delay: 0.45 },
    { x: 710, y: 210, label: "cache.ts", delay: 0.6 },
    { x: 560, y: 260, label: "api.ts", delay: 0.75 },
    { x: 280, y: 265, label: "utils.ts", delay: 0.9 },
    { x: 110, y: 220, label: "config.ts", delay: 1.05 },
  ];

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 800 300"
      className="absolute top-0 left-0 w-full h-full -z-10 opacity-30"
      preserveAspectRatio="xMidYMid slice"
    >
      {leaves.map((n, i) => (
        <line
          key={i}
          x1={center.x}
          y1={center.y}
          x2={n.x}
          y2={n.y}
          pathLength={1}
          stroke="var(--color-primary)"
          strokeWidth={1}
          strokeOpacity={0.3}
          className="animate-line-draw"
          style={{ "--delay": `${n.delay}s` } as React.CSSProperties}
        />
      ))}
      {leaves.map((n, i) => (
        <g key={i}>
          <circle
            cx={n.x}
            cy={n.y}
            r={5}
            fill="var(--color-primary)"
            className="animate-pulse-dot"
            style={{ animationDelay: `${n.delay}s` }}
          />
          <text
            x={n.x}
            y={n.y - 12}
            textAnchor="middle"
            fontSize="11"
            fontFamily="var(--font-mono), monospace"
            fill="var(--color-muted)"
          >
            {n.label}
          </text>
        </g>
      ))}
      {/* Center node, on top */}
      <circle cx={center.x} cy={center.y} r={9} fill="var(--color-accent)" />
      <circle
        cx={center.x}
        cy={center.y}
        r={9}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth={1.5}
        opacity={0.5}
        className="animate-pulse-dot"
      />
    </svg>
  );
}

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div
      className="group rounded-2xl border border-border bg-surface p-6 transition-all duration-300
                    hover:border-primary/20 hover:shadow-lg hover:shadow-primary/5"
    >
      <div
        className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary mb-4
                      group-hover:bg-primary/15 transition-colors"
      >
        {icon}
      </div>
      <h3 className="text-sm font-semibold text-foreground mb-2">{title}</h3>
      <p className="text-sm text-muted leading-relaxed">{description}</p>
    </div>
  );
}

function Step({ num, text }: { num: number; text: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-8 h-8 rounded-full bg-primary/10 text-primary font-bold text-sm flex items-center justify-center">
        {num}
      </div>
      <span className="text-muted">{text}</span>
    </div>
  );
}

function Arrow() {
  return (
    <svg
      className="hidden md:block text-border"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M5 12h14M12 5l7 7-7 7" />
    </svg>
  );
}
