"use client";

import { useRef, useEffect, useMemo, useState } from "react";
import type { FileNodeDTO, ImportEdgeDTO, IssueMapResult, AffectedFile, RepoModuleDTO } from "../lib/types";
import IssueMapper from "./IssueMapper";
import { fetchArchitectureMap } from "../lib/client";

interface SidebarProps {
  // Sizing
  width: number;
  collapsed: boolean;
  onWidthChange: (w: number) => void;
  onCollapsedChange: (c: boolean) => void;
  // Data
  files: FileNodeDTO[];
  edges: ImportEdgeDTO[];
  owner: string;
  repo: string;
  commitSha: string;
  // Issue mapping
  issueResult: IssueMapResult | null;
  isIssueLoading: boolean;
  issueError: string | null;
  onIssueResult: (r: IssueMapResult) => void;
  onIssueClear: () => void;
  setIssueLoading: (v: boolean) => void;
  setIssueError: (v: string | null) => void;
  // Actions
  onFileSelect: (file: FileNodeDTO) => void;
  onZoomToNode: (fileId: string) => void;
  allFunctions: Array<{ id: string; name: string; filePath: string }>;
  // Lifted Architecture Map state
  modules: RepoModuleDTO[];
  setModules: React.Dispatch<React.SetStateAction<RepoModuleDTO[]>>;
}

export default function Sidebar({
  width,
  collapsed,
  onWidthChange,
  onCollapsedChange,
  files,
  edges,
  owner,
  repo,
  commitSha,
  issueResult,
  isIssueLoading,
  issueError,
  onIssueResult,
  onIssueClear,
  setIssueLoading,
  setIssueError,
  onFileSelect,
  onZoomToNode,
  allFunctions,
  modules,
  setModules,
}: SidebarProps) {
  const isDragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(280);

  // ── Architecture Map State ──────────────────────────────────────────────────
  const [isArchitectureLoading, setIsArchitectureLoading] = useState(false);
  const [architectureError, setArchitectureError] = useState<string | null>(null);
  const [expandedModules, setExpandedModules] = useState<Record<string, boolean>>({});
  const [advancedInsightsExpanded, setAdvancedInsightsExpanded] = useState(false);
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!owner || !repo || !commitSha) return;

    setIsArchitectureLoading(true);
    setArchitectureError(null);
    fetchArchitectureMap(owner, repo, commitSha)
      .then((data) => {
        const sorted = [...(data.modules || [])].sort((a, b) => b.importance - a.importance);
        setModules(sorted);
        setVisibleCounts({});
        // Auto-expand the first module (highest importance)
        if (sorted.length > 0) {
          setExpandedModules({ [sorted[0].id]: true });
        }
      })
      .catch((err) => {
        console.error("[Sidebar] Failed to load Repository Map:", err);
        setArchitectureError("Failed to load Repository Map");
      })
      .finally(() => {
        setIsArchitectureLoading(false);
      });
  }, [owner, repo, commitSha]);

  const toggleModule = (moduleId: string) => {
    setExpandedModules((prev) => ({
      ...prev,
      [moduleId]: !prev[moduleId],
    }));
  };

  // ── Drag resize ───────────────────────────────────────────────────────────
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    startX.current = e.clientX;
    startW.current = width;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handleMouseMove = (ev: MouseEvent) => {
      if (!isDragging.current) return;
      const diff = ev.clientX - startX.current;
      const newW = Math.max(200, Math.min(480, startW.current + diff));
      onWidthChange(newW);
    };

    const handleMouseUp = () => {
      isDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      try { localStorage.setItem("codemap-sidebar-width", String(width)); } catch {}
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  };

  // ── Persist width on change ───────────────────────────────────────────────
  useEffect(() => {
    try { localStorage.setItem("codemap-sidebar-width", String(width)); } catch {}
  }, [width]);

  // ── Derived data ──────────────────────────────────────────────────────────

  const mostConnected = useMemo(() => {
    const degreeMap = new Map<string, number>();
    for (const e of edges) {
      degreeMap.set(e.source, (degreeMap.get(e.source) || 0) + 1);
      degreeMap.set(e.target, (degreeMap.get(e.target) || 0) + 1);
    }
    return [...degreeMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([id, degree]) => ({ file: files.find(f => f.id === id), degree }))
      .filter(x => x.file) as Array<{ file: FileNodeDTO; degree: number }>;
  }, [files, edges]);

  const affectedFiles: AffectedFile[] = issueResult?.affectedFiles ?? [];

  if (collapsed) {
    return (
      <>
        <div
          className="shrink-0 flex flex-col items-center py-3 gap-3"
          style={{
            width: "40px",
            background: "#101014",
            borderRight: "1px solid #23232a",
          }}
        >
          {/* Expand button */}
          <button
            onClick={() => onCollapsedChange(false)}
            className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors"
            style={{ background: "#17171d", border: "1px solid #2c2c35", color: "#8b949e" }}
            title="Expand sidebar"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
          {/* Issue indicator */}
          {issueResult && (
            <div
              className="w-3 h-3 rounded-full"
              style={{ background: "#f97316" }}
              title={`Issue #${issueResult.issueNumber}`}
            />
          )}
          {/* File count */}
          <span className="text-[9px] font-mono" style={{ color: "#484f58", writingMode: "vertical-rl" }}>
            {files.length} files
          </span>
        </div>
        <div className="resize-handle" onMouseDown={handleMouseDown} />
      </>
    );
  }

  return (
    <>
      <div
        className="shrink-0 flex flex-col overflow-hidden"
        style={{
          width: `${width}px`,
          background: "#101014",
          borderRight: "1px solid #23232a",
        }}
      >
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {/* Header with collapse button */}
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "#8b949e" }}>EXPLORER</span>
            <button
              onClick={() => onCollapsedChange(true)}
              className="w-6 h-6 rounded flex items-center justify-center transition-colors hover:text-white"
              style={{ background: "transparent", color: "#8b949e" }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "#23232a"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
              title="Collapse sidebar"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
          </div>

          {/* ── Issue Mapper Input ──────────────────────────────────────── */}
          <IssueMapper
            owner={owner}
            repo={repo}
            commitSha={commitSha}
            files={files}
            functions={allFunctions as any}
            onResult={onIssueResult}
            onClear={onIssueClear}
            issueResult={issueResult}
            isLoading={isIssueLoading}
            error={issueError}
            setLoading={setIssueLoading}
            setError={setIssueError}
          />

          {/* ── Issue Mapped: Affected Files ───────────────────────────── */}
          {issueResult ? (
            <>
              {/* Issue banner */}
              <div
                className="rounded-xl p-3 space-y-2"
                style={{ background: "rgba(249,115,22,0.06)", border: "1px solid rgba(249,115,22,0.2)" }}
              >
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full" style={{ background: "#f97316" }} />
                  <span className="text-xs font-semibold truncate flex-1" style={{ color: "#e6edf3" }}>
                    #{issueResult.issueNumber}: {issueResult.issueTitle}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "rgba(249,115,22,0.15)", color: "#f97316" }}>
                    {affectedFiles.length} file{affectedFiles.length !== 1 ? "s" : ""} affected
                  </span>
                  <button
                    onClick={onIssueClear}
                    className="ml-auto text-[10px] px-2 py-0.5 rounded transition-colors"
                    style={{ color: "#8b949e", background: "rgba(255,255,255,0.05)", border: "1px solid #2c2c35" }}
                  >
                    Clear
                  </button>
                </div>
              </div>

              {/* Affected files list */}
              <div className="space-y-1">
                <div className="text-[10px] font-semibold uppercase tracking-wider px-1" style={{ color: "#8b949e" }}>
                  Affected Files
                </div>
                {affectedFiles.map(af => {
                  const file = files.find(f => f.id === af.fileId);
                  const parts = af.fileId.split("/");
                  const filename = parts.pop() || af.fileId;
                  const folder = parts.join("/");
                  return (
                    <button
                      key={af.fileId}
                      className="w-full text-left px-2 py-2 rounded-lg transition-colors"
                      style={{ background: "transparent" }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "#17171d"; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                      onClick={() => {
                        onZoomToNode(af.fileId);
                        if (file) onFileSelect(file);
                      }}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold truncate flex-1" style={{ color: "#e6edf3", fontFamily: "var(--font-geist-mono), monospace" }}>
                          {filename}
                        </span>
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded font-bold shrink-0"
                          style={{
                            background: af.confidence >= 80 ? "rgba(34,197,94,0.15)" : af.confidence >= 50 ? "rgba(249,115,22,0.15)" : "rgba(139,148,158,0.15)",
                            color: af.confidence >= 80 ? "#22c55e" : af.confidence >= 50 ? "#f97316" : "#8b949e",
                          }}
                        >
                          {af.confidence}%
                        </span>
                      </div>
                      {folder && (
                        <div className="text-[10px] mt-0.5 truncate" style={{ color: "#484f58" }}>
                          {folder}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              {/* ── Quick Start ───────────────────────────────────────────── */}
              <div className="rounded-xl p-3" style={{ background: "#17171d", border: "1px solid #23232a" }}>
                <div className="text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ color: "#8b949e" }}>
                  Quick Start
                </div>
                <ul className="space-y-1.5 text-[11px]" style={{ color: "#8b949e" }}>
                  <li className="flex items-start gap-2">
                    <span style={{ color: "#58a6ff" }}>•</span>
                    <span>Click any node to see file details</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span style={{ color: "#58a6ff" }}>•</span>
                    <span>Click a function to see its call graph</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span style={{ color: "#58a6ff" }}>•</span>
                    <span>Hover nodes to highlight connections</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span style={{ color: "#f97316" }}>•</span>
                    <span>Map an issue above to find affected files</span>
                  </li>
                </ul>
              </div>

              {/* ── Repository Map ───────────────────────────────────────── */}
              <div className="space-y-2">
                <div className="text-[10px] font-semibold uppercase tracking-wider mb-1 px-1" style={{ color: "#8b949e" }}>
                  🗺️ Repository Map
                </div>

                {isArchitectureLoading && (
                  <div className="text-xs px-2 py-3" style={{ color: "#8b949e" }}>
                    <span className="inline-block w-3 h-3 border-2 rounded-full animate-spin mr-2" style={{ borderColor: "#58a6ff", borderTopColor: "transparent" }} />
                    Discovering architecture...
                  </div>
                )}

                {architectureError && (
                  <div className="text-xs px-2 py-3" style={{ color: "#f85149" }}>
                    ⚠️ {architectureError}
                  </div>
                )}

                {!isArchitectureLoading && !architectureError && modules.length === 0 && (
                  <div className="text-xs px-2 py-3" style={{ color: "#8b949e" }}>
                    No architectural modules discovered.
                  </div>
                )}

                {!isArchitectureLoading && !architectureError && modules.map((m) => {
                  const isExpanded = !!expandedModules[m.id];
                  return (
                    <div key={m.id} className="rounded-xl overflow-hidden" style={{ border: "1px solid #23232a", background: "#17171d" }}>
                      {/* Module Header Button */}
                      <button
                        onClick={() => toggleModule(m.id)}
                        className="w-full text-left p-2.5 transition-colors flex items-start gap-2 hover:bg-[#23232a]"
                        style={{ background: "transparent" }}
                      >
                        {/* Chevron */}
                        <span
                          className="text-[#8b949e] mt-0.5 transition-transform duration-200"
                          style={{ display: "inline-block", transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
                        >
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                            <path d="M9 5l7 7-7 7" />
                          </svg>
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold truncate" style={{ color: "#e6edf3" }}>
                              {m.name}
                            </span>
                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full shrink-0" style={{ background: "#23232a", color: "#8b949e" }}>
                              {m.files.length}
                            </span>
                          </div>
                          {m.description && (
                            <p className="text-[10px] mt-0.5 font-normal line-clamp-2 leading-relaxed" style={{ color: "#8b949e" }}>
                              {m.description}
                            </p>
                          )}
                        </div>
                      </button>

                      {/* Nested Files List */}
                      {isExpanded && (
                        <div className="border-t px-2 py-1.5 space-y-0.5" style={{ borderColor: "#23232a", background: "#101014" }}>
                          {(() => {
                            const repFiles = m.representativeFiles || [];
                            const repList = m.files.filter((f) => repFiles.includes(f));
                            const otherList = m.files.filter((f) => !repFiles.includes(f));
                            const sortedFiles = [...repList, ...otherList];
                            
                            const defaultPageSize = 30;
                            const limit = visibleCounts[m.id] || defaultPageSize;
                            const visibleFiles = sortedFiles.slice(0, limit);

                            return (
                              <>
                                {visibleFiles.map((filePath) => {
                                  const file = files.find((f) => f.id === filePath);
                                  if (!file) return null;

                                  const isRepresentative = repFiles.includes(filePath);

                                  return (
                                    <button
                                      key={filePath}
                                      onClick={() => {
                                        onFileSelect(file);
                                        onZoomToNode(file.id);
                                      }}
                                      className="w-full text-left px-2 py-1 rounded text-[11px] truncate transition-colors flex items-center justify-between hover:bg-[#17171d]"
                                      style={{
                                        color: isRepresentative ? "#e3b341" : "#e6edf3",
                                        fontFamily: "var(--font-geist-mono), monospace"
                                      }}
                                      title={filePath}
                                    >
                                      <span className="truncate flex-1">{file.label}</span>
                                      {isRepresentative && (
                                        <span className="text-[8px] font-bold px-1 py-0.5 rounded uppercase shrink-0 ml-1.5" style={{ background: "rgba(227,179,65,0.15)", color: "#e3b341" }}>
                                          ⭐ Core
                                        </span>
                                      )}
                                    </button>
                                  );
                                })}

                                {sortedFiles.length > limit && (
                                  <button
                                    onClick={() => setVisibleCounts(prev => ({
                                      ...prev,
                                      [m.id]: (prev[m.id] || defaultPageSize) + 100
                                    }))}
                                    className="w-full text-center py-1 mt-1 border border-dashed rounded text-[10px] hover:bg-[#17171d] transition-colors"
                                    style={{ borderColor: "#2c2c35", color: "#8b949e" }}
                                  >
                                    Show more (+100 files, {sortedFiles.length - limit} remaining)
                                  </button>
                                )}
                              </>
                            );
                          })()}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* ── Advanced Insights Collapsible ───────────────────────── */}
              <div className="rounded-xl overflow-hidden mt-4" style={{ border: "1px solid #23232a", background: "#17171d" }}>
                <button
                  onClick={() => setAdvancedInsightsExpanded(prev => !prev)}
                  className="w-full text-left p-2.5 transition-colors flex items-center gap-2 hover:bg-[#23232a]"
                  style={{ background: "transparent" }}
                >
                  <span
                    className="text-[#8b949e] transition-transform duration-200"
                    style={{ display: "inline-block", transform: advancedInsightsExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                      <path d="M9 5l7 7-7 7" />
                    </svg>
                  </span>
                  <span className="text-xs font-semibold" style={{ color: "#e6edf3" }}>
                    ⚙️ Advanced Insights
                  </span>
                </button>

                {advancedInsightsExpanded && (
                  <div className="p-2.5 border-t space-y-4" style={{ borderColor: "#23232a", background: "#101014" }}>


                    {/* ── Most Connected ────────────────────────────────────────── */}
                    {mostConnected.length > 0 && (
                      <div>
                        <div className="text-[10px] font-semibold uppercase tracking-wider mb-1.5 px-1" style={{ color: "#8b949e" }}>
                          🔗 Most Connected
                        </div>
                        <div className="space-y-0.5">
                          {mostConnected.map(({ file, degree }) => (
                            <button
                              key={file.id}
                              onClick={() => { onFileSelect(file); onZoomToNode(file.id); }}
                              className="w-full text-left px-2 py-1.5 rounded-lg text-[11px] truncate transition-colors flex items-center gap-2"
                              style={{ color: "#e6edf3", fontFamily: "var(--font-geist-mono), monospace" }}
                              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "#17171d"; }}
                              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                            >
                              <span className="truncate flex-1">{file.label}</span>
                              <span className="text-[9px] shrink-0" style={{ color: "#484f58" }}>{degree} edges</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Resize handle */}
      <div className="resize-handle" onMouseDown={handleMouseDown} />
    </>
  );
}
