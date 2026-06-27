"use client";

import { useEffect, useRef } from "react";
import * as d3 from "d3";
import type { FileNodeDTO, ImportEdgeDTO } from "../lib/types";
import { getLanguageColor, getFolderGroup } from "../lib/graphHelpers";
import type { SimNode, SimLink } from "./graphTypes";
import { trunc } from "./graphTypes";

interface FocusGraphProps {
  focusedNodeId: string;
  files: FileNodeDTO[];
  edges: ImportEdgeDTO[];
  focusDepth: 1 | 2 | "all";
  focusSearch: string;
  focusSortBy: "importance" | "name" | "lines";
  expandedFolders: Set<string>;
  onFileClick: (file: FileNodeDTO) => void;
  onNavigate: (fileId: string) => void;
  onExpandFolder: (folder: string) => void;
  onExpandSide: (side: "left" | "right") => void;
}

export default function FocusGraph({
  focusedNodeId, files, edges, focusDepth, focusSearch, focusSortBy,
  expandedFolders, onFileClick, onNavigate, onExpandFolder, onExpandSide,
}: FocusGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    d3.select(container).selectAll("*").remove();

    const width = container.clientWidth || 900;
    const height = container.clientHeight || 600;
    const centerX = width / 2;
    const centerY = height / 2;

    // 0. Precompute importance
    const inDegrees = new Map<string, number>();
    const outDegrees = new Map<string, number>();
    for (const e of edges) {
      inDegrees.set(e.target, (inDegrees.get(e.target) || 0) + 1);
      outDegrees.set(e.source, (outDegrees.get(e.source) || 0) + 1);
    }
    const getImportance = (f: FileNodeDTO) => (inDegrees.get(f.id) || 0) * 1.2 + (outDegrees.get(f.id) || 0) * 1.0 + (f.isEntryPoint ? 5 : 0);

    // 1. Hop-level extraction
    const hopMap = new Map<string, number>();
    hopMap.set(focusedNodeId, 0);
    const leftIds = new Set<string>();
    const rightIds = new Set<string>();
    const visited = new Set<string>([focusedNodeId]);

    const collect = (targetId: string, currentHop: number, side: "left" | "right" | "center") => {
      const maxHop = focusDepth === "all" ? 10 : focusDepth;
      if (currentHop >= maxHop) return;
      for (const e of edges) {
        if (e.source === targetId && !visited.has(e.target)) {
          if (side === "center" || side === "left") {
            hopMap.set(e.target, currentHop + 1);
            leftIds.add(e.target);
            visited.add(e.target);
            collect(e.target, currentHop + 1, "left");
          }
        }
        if (e.target === targetId && !visited.has(e.source)) {
          if (side === "center" || side === "right") {
            hopMap.set(e.source, currentHop + 1);
            rightIds.add(e.source);
            visited.add(e.source);
            collect(e.source, currentHop + 1, "right");
          }
        }
      }
    };
    collect(focusedNodeId, 0, "center");

    const centerFile = files.find(f => f.id === focusedNodeId);
    if (!centerFile) return;

    const forceCluster = focusDepth === "all" && visited.size > 150;

    // Build nodes with folder grouping
    const buildNodes = (ids: Set<string>): SimNode[] => {
      const colFiles = files.filter(f => ids.has(f.id));
      const byFolder = new Map<string, FileNodeDTO[]>();
      colFiles.forEach(f => {
        const folder = getFolderGroup(f.id);
        if (!byFolder.has(folder)) byFolder.set(folder, []);
        byFolder.get(folder)!.push(f);
      });
      const result: SimNode[] = [];
      byFolder.forEach((folderFiles, folder) => {
        const isExpanded = !forceCluster && (expandedFolders.has(folder) || folderFiles.length <= 6);
        if (isExpanded) {
          folderFiles.forEach(f => result.push({ id: f.id, data: f, folder, degree: 0, isHub: false, importance: getImportance(f), hop: hopMap.get(f.id) }));
        } else {
          const avgHop = Math.round(folderFiles.reduce((a, f) => a + (hopMap.get(f.id) || 1), 0) / folderFiles.length);
          result.push({ id: `folder:${folder}`, data: { ...folderFiles[0], label: folder, path: folder, kind: "folder" } as any, folder, degree: 0, isHub: true, importance: 0, isGroup: true, childCount: folderFiles.length, hop: avgHop });
        }
      });
      return result;
    };

    // Sort helper
    const sortNodes = (arr: SimNode[]) => {
      if (focusSortBy === "name") arr.sort((a, b) => a.data.label.localeCompare(b.data.label));
      else if (focusSortBy === "lines") arr.sort((a, b) => (b.data.lineCount || 0) - (a.data.lineCount || 0));
      else arr.sort((a, b) => (b.importance || 0) - (a.importance || 0));
      return arr;
    };

    const leftNodes = sortNodes(buildNodes(leftIds));
    const rightNodes = sortNodes(buildNodes(rightIds));
    const leftTotal = leftNodes.length;
    const rightTotal = rightNodes.length;
    const MAX_SIDE = 12;
    const leftCapped = leftTotal > MAX_SIDE;
    const rightCapped = rightTotal > MAX_SIDE;
    const displayLeft = leftCapped ? leftNodes.slice(0, MAX_SIDE) : leftNodes;
    const displayRight = rightCapped ? rightNodes.slice(0, MAX_SIDE) : rightNodes;

    // Ghost nodes
    if (leftCapped) {
      displayLeft.push({ id: "__ghost_left__", data: { id: "__ghost_left__", label: `... and ${leftTotal - MAX_SIDE} more`, path: "", language: "unknown", sizeBytes: 0, lineCount: 0, parseStatus: "skipped", kind: "unknown", isEntryPoint: false, externalImports: [], unresolvedImports: [] } as any, folder: "", degree: 0, isHub: false, importance: -1, hop: 1 });
    }
    if (rightCapped) {
      displayRight.push({ id: "__ghost_right__", data: { id: "__ghost_right__", label: `... and ${rightTotal - MAX_SIDE} more`, path: "", language: "unknown", sizeBytes: 0, lineCount: 0, parseStatus: "skipped", kind: "unknown", isEntryPoint: false, externalImports: [], unresolvedImports: [] } as any, folder: "", degree: 0, isHub: false, importance: -1, hop: 1 });
    }

    const centerNode: SimNode = {
      id: centerFile.id, data: centerFile, folder: getFolderGroup(centerFile.id),
      degree: 0, isHub: false, importance: getImportance(centerFile), hop: 0,
      x: centerX, y: centerY,
    };
    const nodes = [centerNode, ...displayLeft, ...displayRight];
    const nodeLookup = new Map(nodes.map(n => [n.id, n]));

    // Layout — horizontal tree
    const RECT_W = 160, RECT_H = 44, CENTER_W = 180, CENTER_H = 52;
    const colLeftX = centerX - 280;
    const colRightX = centerX + 280;
    const layoutColumn = (colNodes: SimNode[], colX: number) => {
      const totalH = Math.min(colNodes.length * 56, height * 0.85);
      const startY = (height - totalH) / 2;
      const spacing = colNodes.length > 1 ? totalH / (colNodes.length - 1) : 0;
      colNodes.forEach((n, i) => { n.x = colX; n.y = startY + i * spacing; });
    };
    layoutColumn(displayLeft, colLeftX);
    layoutColumn(displayRight, colRightX);
    centerNode.x = centerX;
    centerNode.y = centerY;

    // SVG
    const svg = d3.select(container).append("svg").attr("width", "100%").attr("height", "100%").attr("viewBox", `0 0 ${width} ${height}`).style("opacity", "0");

    const defs = svg.append("defs");
    defs.append("marker").attr("id", "focus-arrow-green").attr("viewBox", "0 -5 10 10").attr("refX", 10).attr("refY", 0).attr("markerWidth", 4).attr("markerHeight", 4).attr("orient", "auto").append("path").attr("d", "M0,-4L10,0L0,4").attr("fill", "#3fb950");
    defs.append("marker").attr("id", "focus-arrow-blue").attr("viewBox", "0 -5 10 10").attr("refX", 10).attr("refY", 0).attr("markerWidth", 4).attr("markerHeight", 4).attr("orient", "auto").append("path").attr("d", "M0,-4L10,0L0,4").attr("fill", "#58a6ff");

    const g = svg.append("g");
    const zoom = d3.zoom<SVGSVGElement, unknown>().scaleExtent([0.1, 8]).on("zoom", ev => g.attr("transform", ev.transform));
    svg.call(zoom);

    // Build edges
    const links: SimLink[] = [];
    edges.forEach(e => {
      let s = e.source, t = e.target;
      if (!nodeLookup.has(s)) { const f = getFolderGroup(s); if (nodeLookup.has(`folder:${f}`)) s = `folder:${f}`; }
      if (!nodeLookup.has(t)) { const f = getFolderGroup(t); if (nodeLookup.has(`folder:${f}`)) t = `folder:${f}`; }
      if (!nodeLookup.has(s) || !nodeLookup.has(t)) return;
      if (s.startsWith("__ghost_") || t.startsWith("__ghost_")) return;
      links.push({ source: s as any, target: t as any, data: e });
    });

    // Straight-line edges
    const baseEdgeOpacity = 0.6;
    const link = g.append("g").selectAll("line").data(links).join("line")
      .attr("x1", d => { const n = nodeLookup.get(typeof d.source === "string" ? d.source : (d.source as any).id)!; return n.id === focusedNodeId ? n.x! : (n.x! + RECT_W / 2); })
      .attr("y1", d => nodeLookup.get(typeof d.source === "string" ? d.source : (d.source as any).id)!.y!)
      .attr("x2", d => { const n = nodeLookup.get(typeof d.target === "string" ? d.target : (d.target as any).id)!; return n.id === focusedNodeId ? n.x! : (n.x! - RECT_W / 2); })
      .attr("y2", d => nodeLookup.get(typeof d.target === "string" ? d.target : (d.target as any).id)!.y!)
      .attr("stroke", d => { const tid = typeof d.target === "string" ? d.target : (d.target as any).id; return leftIds.has(tid) || tid === focusedNodeId ? "#3fb950" : "#58a6ff"; })
      .attr("stroke-width", 1.5)
      .attr("stroke-opacity", baseEdgeOpacity)
      .attr("marker-end", d => { const tid = typeof d.target === "string" ? d.target : (d.target as any).id; return leftIds.has(tid) || tid === focusedNodeId ? "url(#focus-arrow-green)" : "url(#focus-arrow-blue)"; });

    // Tooltip
    const tooltip = d3.select(container).append("div").style("position", "absolute").style("background", "rgba(16,16,20,0.95)").style("border", "1px solid #2c2c35").style("border-radius", "8px").style("padding", "8px 12px").style("font-size", "12px").style("color", "#e6edf3").style("pointer-events", "none").style("opacity", "0").style("z-index", "100");

    // Nodes — rounded rectangles
    const nodeG = g.append("g").selectAll("g").data(nodes).join("g").attr("transform", d => `translate(${d.x}, ${d.y})`).style("cursor", "pointer");

    nodeG.each(function (d) {
      const g2 = d3.select(this);
      const isFocused = d.id === focusedNodeId;
      const isGhost = d.id.startsWith("__ghost_");
      const isSearchMatch = !focusSearch || d.data.label.toLowerCase().includes(focusSearch.toLowerCase()) || d.folder.toLowerCase().includes(focusSearch.toLowerCase());
      const w = isFocused ? CENTER_W : RECT_W;
      const h = isFocused ? CENTER_H : RECT_H;

      if (isGhost) {
        g2.append("rect").attr("x", -w / 2).attr("y", -h / 2).attr("width", w).attr("height", h).attr("rx", 8).attr("fill", "transparent").attr("stroke", "#2c2c35").attr("stroke-width", 1.5).attr("stroke-dasharray", "6,3");
        g2.append("text").attr("text-anchor", "middle").attr("dy", "0.35em").attr("fill", "#484f58").attr("font-size", "11px").attr("font-family", "monospace").text(d.data.label);
        return;
      }

      if (isFocused) {
        g2.append("text").attr("text-anchor", "middle").attr("y", -h / 2 - 8).attr("fill", "#f0883e").attr("font-size", "8px").attr("font-weight", "bold").attr("font-family", "monospace").text("FOCUS");
        g2.append("rect").attr("x", -w / 2 - 4).attr("y", -h / 2 - 4).attr("width", w + 8).attr("height", h + 8).attr("rx", 12).attr("fill", "none").attr("stroke", "#f0883e").attr("stroke-width", 1).attr("stroke-opacity", 0.2);
      }

      const strokeColor = isFocused ? "#f0883e" : (leftIds.has(d.id) ? "#3fb950" : "#58a6ff");
      g2.append("rect").attr("x", -w / 2).attr("y", -h / 2).attr("width", w).attr("height", h).attr("rx", 8)
        .attr("fill", isFocused ? "#1e1e25" : "#101014").attr("stroke", strokeColor).attr("stroke-width", isFocused ? 2.5 : 1.5)
        .attr("opacity", isSearchMatch ? 1 : 0.15);

      g2.append("text").attr("x", -w / 2 + 10).attr("y", -h / 2 + 18).attr("fill", "#e6edf3").attr("font-size", "12px").attr("font-weight", "bold").attr("font-family", "monospace").attr("opacity", isSearchMatch ? 1 : 0.15).text(trunc(d.data.label, 18));
      const folderPath = getFolderGroup(d.data.path);
      g2.append("text").attr("x", -w / 2 + 10).attr("y", -h / 2 + 34).attr("fill", "#8b949e").attr("font-size", "10px").attr("font-family", "monospace").attr("opacity", isSearchMatch ? 1 : 0.15).text(trunc(folderPath || "/", 22));
      g2.append("text").attr("x", w / 2 - 8).attr("y", h / 2 - 6).attr("text-anchor", "end").attr("fill", "#484f58").attr("font-size", "9px").attr("font-family", "monospace").text(`${d.data.lineCount} lines`);

      if (d.data.isEntryPoint) g2.append("text").attr("x", w / 2 - 8).attr("y", -h / 2 + 14).attr("text-anchor", "end").attr("fill", "#3fb950").attr("font-size", "9px").attr("font-weight", "bold").text("entry");
      else if (d.data.kind === "test") g2.append("text").attr("x", w / 2 - 8).attr("y", -h / 2 + 14).attr("text-anchor", "end").attr("fill", "#8b949e").attr("font-size", "9px").text("test");
      if (d.data.cycleScore && d.data.cycleScore > 0) g2.append("text").attr("x", w / 2 - 8).attr("y", -h / 2 + 24).attr("text-anchor", "end").attr("fill", "#f85149").attr("font-size", "9px").text("cycle");
    });

    // Interactions
    nodeG.on("mouseover", function (ev, d) {
      if (d.id.startsWith("__ghost_")) return;
      tooltip.style("opacity", "1").html(`<strong>${d.data.label}</strong><br/><span style="color:#8b949e">${d.data.path}</span><br/>${d.data.language} · ${d.data.lineCount} lines`).style("left", (ev.offsetX + 16) + "px").style("top", (ev.offsetY - 10) + "px");
      link.transition().duration(100).attr("stroke-opacity", l => {
        const sid = typeof l.source === "string" ? l.source : (l.source as any).id;
        const tid = typeof l.target === "string" ? l.target : (l.target as any).id;
        return (sid === d.id || tid === d.id) ? 1 : 0.08;
      }).attr("stroke-width", l => {
        const sid = typeof l.source === "string" ? l.source : (l.source as any).id;
        const tid = typeof l.target === "string" ? l.target : (l.target as any).id;
        return (sid === d.id || tid === d.id) ? 3 : 0.8;
      });
      nodeG.transition().duration(100).style("opacity", n => {
        if (n.id === d.id || n.id === focusedNodeId) return 1;
        const connected = links.some(l => {
          const sid = typeof l.source === "string" ? l.source : (l.source as any).id;
          const tid = typeof l.target === "string" ? l.target : (l.target as any).id;
          return (sid === d.id && tid === n.id) || (tid === d.id && sid === n.id);
        });
        return connected ? 1 : 0.15;
      });
    }).on("mouseout", function () {
      tooltip.style("opacity", "0");
      nodeG.transition().duration(100).style("opacity", 1);
      link.transition().duration(100).attr("stroke-opacity", baseEdgeOpacity).attr("stroke-width", 1.5);
    }).on("click", (_ev, d) => {
      if (d.id === "__ghost_left__") { onExpandSide("left"); return; }
      if (d.id === "__ghost_right__") { onExpandSide("right"); return; }
      if (d.isGroup) { onExpandFolder(d.folder); return; }
      onFileClick(d.data);
      if (d.id !== focusedNodeId) onNavigate(d.id);
    });

    // Column headers
    if (displayLeft.length > 0) g.append("text").attr("x", colLeftX).attr("y", Math.max(20, (displayLeft[0]?.y || centerY) - 40)).attr("text-anchor", "middle").attr("fill", "#3fb950").attr("font-size", "10px").attr("font-weight", "bold").attr("font-family", "monospace").text(`USED BY (${leftTotal})`);
    if (displayRight.length > 0) g.append("text").attr("x", colRightX).attr("y", Math.max(20, (displayRight[0]?.y || centerY) - 40)).attr("text-anchor", "middle").attr("fill", "#58a6ff").attr("font-size", "10px").attr("font-weight", "bold").attr("font-family", "monospace").text(`IMPORTS (${rightTotal})`);

    svg.transition().duration(300).style("opacity", "1");
    setTimeout(() => {
      const b = (g.node() as SVGGElement)?.getBBox();
      if (b && b.width > 0) {
        const s = 0.85 / Math.max(b.width / width, b.height / height);
        svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity.translate(width / 2 - (b.x + b.width / 2) * s, height / 2 - (b.y + b.height / 2) * s).scale(s));
      }
    }, 50);
  }, [focusedNodeId, files, edges, focusDepth, focusSearch, focusSortBy, expandedFolders, onFileClick, onNavigate, onExpandFolder, onExpandSide]);

  return <div ref={containerRef} className="w-full h-full overflow-hidden" style={{ background: "#101014" }} />;
}
