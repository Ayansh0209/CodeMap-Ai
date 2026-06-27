"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import type { ViewMode, FileNodeDTO } from "../lib/types";
import { getLanguageColor } from "../lib/graphHelpers";
import FiltersDropdown from "./FiltersDropdown";

interface GraphControlsProps {
  view: ViewMode;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onViewChange: (view: ViewMode) => void;
  onResetView: () => void;
  fileCount: number;
  edgeCount: number;
  hasFunctionSelected: boolean;
  focusMode?: boolean;
  onFocusModeToggle?: () => void;
  hasIssueResult?: boolean;
  activeKinds: Set<string>;
  activeLanguages: Set<string>;
  onKindsChange: (kinds: Set<string>) => void;
  onLanguagesChange: (langs: Set<string>) => void;
  availableLanguages?: string[];
  // Files to power the live search suggestions, and the action taken when one
  // is picked (navigate + zoom to that file).
  files?: FileNodeDTO[];
  onSelectSuggestion?: (fileId: string) => void;
}

export default function GraphControls({
  view,
  searchQuery,
  onSearchChange,
  onViewChange,
  onResetView,
  fileCount,
  edgeCount,
  hasFunctionSelected,
  focusMode = false,
  onFocusModeToggle,
  hasIssueResult = false,
  activeKinds,
  activeLanguages,
  onKindsChange,
  onLanguagesChange,
  availableLanguages,
  files = [],
  onSelectSuggestion,
}: GraphControlsProps) {
  // ── Live file suggestions (client-side, instant — files are already in memory) ──
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeItemRef = useRef<HTMLButtonElement>(null);

  const suggestions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q || files.length === 0) return [];
    const scored: { f: FileNodeDTO; score: number }[] = [];
    for (const f of files) {
      const label = f.label.toLowerCase();
      const path = f.path.toLowerCase();
      let score = -1;
      if (label === q) score = 0;
      else if (label.startsWith(q)) score = 1;
      else if (label.includes(q)) score = 2;
      else if (path.includes(q)) score = 3;
      if (score >= 0) scored.push({ f, score });
    }
    scored.sort((a, b) => a.score - b.score || a.f.label.length - b.f.label.length);
    return scored.slice(0, 25).map((s) => s.f);
  }, [files, searchQuery]);

  // Keep the keyboard-highlighted row visible as you arrow through the list.
  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  const showSuggestions = open && suggestions.length > 0 && !!onSelectSuggestion;

  const pick = (f: FileNodeDTO) => {
    onSelectSuggestion?.(f.id);
    setOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showSuggestions) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const f = suggestions[activeIdx];
      if (f) pick(f);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div
      className="flex items-center gap-3 flex-wrap"
      style={{
        padding: "10px 16px",
        background: "rgba(16,16,20,0.95)",
        border: "1px solid #2c2c35",
        borderRadius: "12px",
        marginBottom: "12px",
        minHeight: "54px",
      }}
    >
      {/* View Toggle */}
      <div className="flex rounded-lg overflow-hidden shrink-0" style={{ border: "1px solid #2c2c35", height: "32px" }}>
        <button
          id="view-file-graph-btn"
          onClick={() => onViewChange("file-graph")}
          className="px-3 flex items-center justify-center text-xs font-medium transition-colors"
          style={{
            background: view === "file-graph" ? "#1f6feb" : "#17171d",
            color: view === "file-graph" ? "#fff" : "#8b949e",
          }}
        >
          File Graph
        </button>
        <button
          onClick={() => hasFunctionSelected && onViewChange("function-graph")}
          disabled={!hasFunctionSelected}
          className="px-3 flex items-center justify-center text-xs font-medium transition-colors"
          style={{
            background: view === "function-graph" ? "#1f6feb" : "#17171d",
            color: view === "function-graph" ? "#fff" : hasFunctionSelected ? "#8b949e" : "#484f58",
            cursor: hasFunctionSelected ? "pointer" : "not-allowed",
            borderLeft: "1px solid #2c2c35",
          }}
          title={hasFunctionSelected ? "Switch to Function Graph" : "Select a function first"}
        >
          Function Graph
        </button>
      </div>

      {/* Reset View Button */}
      <button
        onClick={onResetView}
        className="px-3 rounded-lg flex items-center justify-center text-xs font-medium transition-colors border shrink-0 hover:bg-[#23232a]"
        style={{
          background: "#17171d",
          color: "#8b949e",
          border: "1px solid #2c2c35",
          height: "32px",
        }}
        title="Reset zoom & clear search"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mr-1.5">
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
        </svg>
        Reset View
      </button>

      {/* Focus Mode Toggle */}
      {hasIssueResult && onFocusModeToggle && (
        <button
          onClick={onFocusModeToggle}
          className="px-3 rounded-lg flex items-center justify-center text-xs font-medium transition-colors border shrink-0 hover:opacity-80"
          style={{
            background: focusMode ? "rgba(249,115,22,0.15)" : "#17171d",
            color: focusMode ? "#f97316" : "#8b949e",
            border: focusMode ? "1px solid rgba(249,115,22,0.4)" : "1px solid #2c2c35",
            height: "32px",
          }}
        >
          {focusMode ? "Show all files" : "Focus on affected"}
        </button>
      )}

      {/* Vertical separator */}
      <div className="hidden sm:block w-px h-5 mx-1" style={{ background: "#2c2c35" }} />

      {/* Search Input + live suggestions */}
      <div className="relative flex-1 min-w-[150px]">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#484f58"
          strokeWidth="2"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        <input
          id="graph-search-input"
          ref={inputRef}
          type="text"
          placeholder="Search files…"
          value={searchQuery}
          onChange={(e) => {
            onSearchChange(e.target.value);
            setOpen(true);
            setActiveIdx(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={handleKeyDown}
          className="w-full pl-9 pr-8 rounded-lg text-sm outline-none transition-colors focus:border-[#58a6ff]"
          style={{
            background: "#17171d",
            border: "1px solid #2c2c35",
            color: "#e6edf3",
            fontFamily: "var(--font-geist-mono), monospace",
            fontSize: "12px",
            height: "32px",
          }}
          autoComplete="off"
          spellCheck={false}
        />
        {searchQuery && (
          <button
            onClick={() => { onSearchChange(""); setOpen(false); inputRef.current?.focus(); }}
            className="absolute right-2 top-1/2 -translate-y-1/2 hover:text-[#e6edf3] transition-colors"
            style={{ color: "#484f58", fontSize: "14px", height: "20px", width: "20px", display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            ✕
          </button>
        )}

        {/* Suggestions dropdown */}
        {showSuggestions && (
          <div
            className="absolute left-0 right-0 top-full mt-1 z-50 rounded-lg shadow-2xl codemap-scroll"
            style={{ background: "#101014", border: "1px solid #2c2c35", maxHeight: "320px", overflowY: "auto" }}
          >
            {suggestions.map((f, i) => (
              <button
                key={f.id}
                ref={i === activeIdx ? activeItemRef : undefined}
                // onMouseDown (not onClick) so we select before the input blurs
                onMouseDown={(e) => { e.preventDefault(); pick(f); }}
                onMouseEnter={() => setActiveIdx(i)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors"
                style={{ background: i === activeIdx ? "#17171d" : "transparent" }}
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: getLanguageColor(f.language) }} />
                <span className="text-[12px] font-mono truncate shrink-0" style={{ color: "#e6edf3", maxWidth: "45%" }}>
                  {f.label}
                </span>
                <span className="text-[11px] font-mono truncate ml-auto" style={{ color: "#6e7681" }}>
                  {f.path}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Filters Dropdown */}
      <div className="shrink-0">
        <FiltersDropdown
          activeKinds={activeKinds}
          activeLanguages={activeLanguages}
          onKindsChange={onKindsChange}
          onLanguagesChange={onLanguagesChange}
          availableLanguages={availableLanguages}
        />
      </div>

      {/* Stats */}
      <span className="text-xs ml-auto shrink-0" style={{ color: "#484f58" }}>
        {fileCount} files · {edgeCount} edges
      </span>
    </div>
  );
}
