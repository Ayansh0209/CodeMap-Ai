"use client";

import React from "react";
import type { FileNodeDTO, ImportEdgeDTO } from "../lib/types";

interface FocusExplorerProps {
  focusedNodeId: string;
  files: FileNodeDTO[];
  focusDepth: 1 | 2 | "all";
  setFocusDepth: (d: 1 | 2 | "all") => void;
  focusSearch: string;
  setFocusSearch: (s: string) => void;
  isFocusUIOpen: boolean;
  setIsFocusUIOpen: (v: boolean) => void;
  onExitFocus: () => void;
}

export default function FocusExplorer({
  focusedNodeId,
  files,
  focusDepth,
  setFocusDepth,
  focusSearch,
  setFocusSearch,
  isFocusUIOpen,
  setIsFocusUIOpen,
  onExitFocus
}: FocusExplorerProps) {
  return (
    <>
      <div className="absolute top-4 left-4 z-20 flex items-center gap-3">
        <button
          onClick={onExitFocus}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-all hover:scale-105"
          style={{
            background: "rgba(240,136,62,0.15)",
            border: "1px solid rgba(240,136,62,0.4)",
            color: "#f0883e",
            backdropFilter: "blur(8px)",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          Exit Focus
        </button>
        <div
          className="px-3 py-2 rounded-lg text-xs font-medium"
          style={{
            background: "rgba(48,54,61,0.5)",
            border: "1px solid #2c2c35",
            color: "#e6edf3",
            backdropFilter: "blur(8px)",
          }}
        >
          Focusing: <span className="text-[#f0883e] font-bold">{files.find(f => f.id === focusedNodeId)?.label || "File"}</span>
        </div>
      </div>

      <div
        className="absolute z-20 flex flex-col gap-2 p-3 rounded-xl border border-[#2c2c35] backdrop-blur-md bg-[#101014]/80 w-64 shadow-2xl transition-all"
        style={{
          top: '20px',
          right: '20px',
          borderLeft: "4px solid #f0883e"
        }}
      >
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] uppercase tracking-wider text-[#8b949e] font-bold flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-[#f0883e] animate-pulse" />
            Focus Explorer
          </span>
          <button onClick={() => setIsFocusUIOpen(!isFocusUIOpen)} className="text-[#8b949e] hover:text-white text-sm font-bold px-1">
            {isFocusUIOpen ? '−' : '+'}
          </button>
        </div>

        {isFocusUIOpen && (
          <div className="space-y-3">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[10px] text-[#8b949e] font-semibold">Graph Depth</label>
                <span className="text-[9px] text-[#f0883e] font-bold px-1.5 py-0.5 rounded bg-[#f0883e]/10 border border-[#f0883e]/20">{focusDepth}-Hop</span>
              </div>
              <div className="flex gap-1 p-0.5 bg-[#17171d] rounded-lg border border-[#2c2c35]">
                <button
                  onClick={() => setFocusDepth(1)}
                  className={`flex-1 py-1 text-[10px] rounded-md transition-all ${focusDepth === 1 ? 'bg-[#2c2c35] text-white shadow-sm font-bold' : 'text-[#8b949e] hover:text-white'}`}
                >1-Hop</button>
                <button
                  onClick={() => setFocusDepth(2)}
                  className={`flex-1 py-1 text-[10px] rounded-md transition-all ${focusDepth === 2 ? 'bg-[#2c2c35] text-white shadow-sm font-bold' : 'text-[#8b949e] hover:text-white'}`}
                >2-Hop</button>
                <button
                  onClick={() => setFocusDepth('all')}
                  className={`flex-1 py-1 text-[10px] rounded-md transition-all ${focusDepth === 'all' ? 'bg-[#2c2c35] text-white shadow-sm font-bold' : 'text-[#8b949e] hover:text-white'}`}
                >All</button>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] text-[#8b949e] font-semibold">Filter View</label>
              <div className="relative">
                <input
                  type="text"
                  placeholder="Filter files/folders..."
                  value={focusSearch}
                  onChange={(e) => setFocusSearch(e.target.value)}
                  className="w-full bg-[#17171d] border border-[#2c2c35] rounded-lg pl-2 pr-7 py-1.5 text-[11px] text-[#e6edf3] focus:outline-none focus:border-[#f0883e]/50 transition-all placeholder:text-[#484f58]"
                />
                {focusSearch && (
                  <button
                    onClick={() => setFocusSearch("")}
                    className="absolute right-2 top-1.5 text-[#8b949e] hover:text-white text-xs"
                  >×</button>
                )}
              </div>
            </div>

            <div className="pt-2 border-t border-[#2c2c35] flex flex-col gap-1.5">
              <div className="flex items-center gap-2 text-[10px] text-[#8b949e]">
                <span className="w-2 h-2 rounded-full bg-[#2c2c35] border border-[#484f58] flex items-center justify-center text-[6px]">📁</span>
                <span>Click group to expand</span>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-[#8b949e]">
                <span className="w-2 h-2 rounded-full border border-[#f0883e] bg-[#f0883e]/20" />
                <span>Sizes by importance</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
