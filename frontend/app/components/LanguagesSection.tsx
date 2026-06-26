"use client";

// LanguagesSection.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Landing-page section: the languages CodeMap fully analyzes today (dependency
// + function-level call graphs), plus a "coming soon" row. Animated, staggered
// chips in the spirit of the rest of the page.
// ─────────────────────────────────────────────────────────────────────────────

const SUPPORTED = [
  { name: "TypeScript", color: "#3178c6" },
  { name: "JavaScript", color: "#e8a400" },
  { name: "React · TSX/JSX", color: "#61dafb" },
  { name: "Python", color: "#3776ab" },
  { name: "Go", color: "#00add8" },
  { name: "C", color: "#a8b9cc" },
  { name: "C++", color: "#f34b7d" },
];

const SOON = ["Rust", "Java", "C#", "Ruby", "PHP", "Kotlin"];

export default function LanguagesSection() {
  return (
    <section className="max-w-5xl mx-auto px-6 pb-20 w-full text-center">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary mb-3">Languages</p>
      <h3 className="text-2xl font-bold text-foreground mb-2 tracking-tight">
        Maps the languages you actually contribute to.
      </h3>
      <p className="text-muted mb-8 max-w-xl mx-auto">
        Full dependency <span className="text-foreground">and</span> function-level call graphs today — more on the way.
      </p>

      {/* Supported — animated, glowing chips */}
      <div className="flex flex-wrap items-center justify-center gap-2.5 mb-7">
        {SUPPORTED.map((l, i) => (
          <span
            key={l.name}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-medium animate-fade-in-up transition-transform hover:scale-105"
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border-color)",
              color: "var(--foreground)",
              "--delay": `${i * 0.07}s`,
            } as React.CSSProperties}
          >
            <span
              className="w-2.5 h-2.5 rounded-full animate-pulse-dot"
              style={{ background: l.color, boxShadow: `0 0 10px ${l.color}77` }}
            />
            {l.name}
          </span>
        ))}
      </div>

      {/* Coming soon — dashed, muted */}
      <div className="flex flex-wrap items-center justify-center gap-2">
        <span className="text-xs text-muted/60 mr-1 uppercase tracking-wider">Coming soon</span>
        {SOON.map((l, i) => (
          <span
            key={l}
            className="inline-flex items-center px-2.5 py-1 rounded-lg text-xs animate-fade-in-up"
            style={{
              border: "1px dashed var(--border-color)",
              color: "var(--muted)",
              "--delay": `${0.5 + i * 0.05}s`,
            } as React.CSSProperties}
          >
            {l}
          </span>
        ))}
      </div>
    </section>
  );
}
