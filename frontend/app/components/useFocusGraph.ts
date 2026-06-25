import { useEffect } from "react";
import * as d3 from "d3";
import type { FileNodeDTO, ImportEdgeDTO } from "../lib/types";
import { getLanguageColor, getFolderGroup } from "../lib/graphHelpers";
import { SimNode, SimLink, getRadius, trunc } from "./graphTypes";

export function useFocusGraph({
  focusedNodeId,
  containerRef,
  simulationRef,
  svgRef,
  gRef,
  files,
  edges,
  focusDepth,
  focusSearch,
  expandedFolders,
  onFileClickRef,
  setFocusedNodeId,
  setFocusDepth,
  setExpandedFolders,
  representativeFilesSet
}: {
  focusedNodeId: string | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
  simulationRef: React.MutableRefObject<d3.Simulation<SimNode, SimLink> | null>;
  svgRef: React.MutableRefObject<d3.Selection<SVGSVGElement, unknown, null, undefined> | null>;
  gRef: React.MutableRefObject<d3.Selection<SVGGElement, unknown, null, undefined> | null>;
  files: FileNodeDTO[];
  edges: ImportEdgeDTO[];
  focusDepth: 1 | 2 | "all";
  focusSearch: string;
  expandedFolders: Set<string>;
  onFileClickRef: React.MutableRefObject<(file: FileNodeDTO | null) => void>;
  setFocusedNodeId: (id: string | null) => void;
  setFocusDepth: (depth: 1 | 2 | "all") => void;
  setExpandedFolders: React.Dispatch<React.SetStateAction<Set<string>>>;
  representativeFilesSet: Set<string>;
}) {
  useEffect(() => {
    if (!focusedNodeId || !containerRef.current) return;

    simulationRef.current?.stop();
    const container = containerRef.current;

    d3.select(container).selectAll("*").remove();

    const width = container.clientWidth || 900;
    const height = container.clientHeight || 600;
    const centerX = width / 2;
    const centerY = height / 2;

    const inDegrees = new Map<string, number>();
    const outDegrees = new Map<string, number>();
    for (const e of edges) {
      inDegrees.set(e.target, (inDegrees.get(e.target) || 0) + 1);
      outDegrees.set(e.source, (outDegrees.get(e.source) || 0) + 1);
    }
    const getImportance = (f: FileNodeDTO) => (inDegrees.get(f.id) || 0) * 1.2 + (outDegrees.get(f.id) || 0) * 1.0 + (representativeFilesSet.has(f.id) ? 5 : 0);

    const hopMap = new Map<string, number>();
    hopMap.set(focusedNodeId, 0);
    const leftIds = new Set<string>();
    const rightIds = new Set<string>();
    const visited = new Set<string>([focusedNodeId]);

    const collect = (targetId: string, currentHop: number, side: 'left' | 'right' | 'center') => {
      const maxHop = focusDepth === "all" ? 10 : focusDepth;
      if (currentHop >= maxHop) return;

      for (const e of edges) {
        if (e.source === targetId && !visited.has(e.target)) {
          if (side === 'center' || side === 'left') {
            hopMap.set(e.target, currentHop + 1);
            leftIds.add(e.target);
            visited.add(e.target);
            collect(e.target, currentHop + 1, 'left');
          }
        }
        if (e.target === targetId && !visited.has(e.source)) {
          if (side === 'center' || side === 'right') {
            hopMap.set(e.source, currentHop + 1);
            rightIds.add(e.source);
            visited.add(e.source);
            collect(e.source, currentHop + 1, 'right');
          }
        }
      }
    };
    collect(focusedNodeId, 0, 'center');

    const centerFile = files.find(f => f.id === focusedNodeId);
    if (!centerFile) return;

    const totalPotentialNodes = visited.size;
    const forceCluster = focusDepth === "all" && totalPotentialNodes > 150;

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

    const leftNodes = buildNodes(leftIds);
    const rightNodes = buildNodes(rightIds);
    const centerNode: SimNode = {
      id: centerFile.id, data: centerFile, folder: getFolderGroup(centerFile.id),
      degree: 0, isHub: false, importance: getImportance(centerFile), hop: 0,
      x: centerX, y: centerY, fx: centerX, fy: centerY
    };

    // Tag each node with the column it belongs to so the renderer can place
    // its label on the correct side (left of the "used by" column, right of
    // the "imports" column) when we lay things out as columns.
    leftNodes.forEach(n => (n.side = "left"));
    rightNodes.forEach(n => (n.side = "right"));
    centerNode.side = "center";

    const nodes = [centerNode, ...leftNodes, ...rightNodes];
    const nodeLookup = new Map(nodes.map(n => [n.id, n]));

    // ── Layout selection ────────────────────────────────────────────────────
    // The radial fan looks great for a handful of nodes, but craters into an
    // unreadable wall once a side has many (e.g. a file that imports 30 things:
    // 30 dots crammed onto a fixed 240px arc => ~18px each => overlapping
    // labels). So: keep the fan only while a side is small; otherwise use a
    // clean wrapped column with labels set BESIDE the dots (not stacked under
    // them), which stays legible at any count. 2-hop / all always use columns.
    // Auto-fit zoom (added after render) then frames whatever we produce.
    const isTree = focusDepth === 2 || focusDepth === "all";
    const ARC_MAX = 12;
    const useColumns = isTree || leftNodes.length > ARC_MAX || rightNodes.length > ARC_MAX;

    const layoutSemi = (colNodes: SimNode[], isLeft: boolean) => {
      const byHop = d3.groups(colNodes, n => n.hop || 1);
      byHop.forEach(([hop, hopNodes]) => {
        const count = hopNodes.length;
        const angleSpan = Math.PI * 0.7;
        // Grow the radius so each node always keeps >=48px of arc length —
        // the fan can never cram, it just gets wider.
        const minArc = 48;
        const radius = Math.max(240 * hop, count > 1 ? (count * minArc) / angleSpan : 0);
        const startAngle = isLeft ? Math.PI - angleSpan / 2 : -angleSpan / 2;
        const step = count > 1 ? angleSpan / (count - 1) : 0;
        hopNodes.sort((a, b) => (b.importance || 0) - (a.importance || 0)).forEach((node, i) => {
          const angle = startAngle + i * step;
          node.x = centerX + radius * Math.cos(angle);
          node.y = centerY + radius * Math.sin(angle);
        });
      });
    };

    const layoutColumns = (colNodes: SimNode[], isLeft: boolean) => {
      const dir = isLeft ? -1 : 1;
      const ROW_H = 30;            // labels sit beside the dot, so rows pack tight
      const COL_GAP = 210;        // gap between wrapped sub-columns / hops
      const usableH = Math.max(240, height - 120);
      const rowsPerCol = Math.max(6, Math.floor(usableH / ROW_H));
      const byHop = d3.groups(colNodes, n => n.hop || 1).sort((a, b) => a[0] - b[0]);
      let xOffset = 200;          // first column sits 200px out from center
      byHop.forEach(([_hop, hopNodes]) => {
        const sorted = hopNodes.sort((a, b) => (b.importance || 0) - (a.importance || 0));
        const subCols = Math.ceil(sorted.length / rowsPerCol);
        sorted.forEach((node, i) => {
          const col = Math.floor(i / rowsPerCol);
          const row = i % rowsPerCol;
          const rowsInCol = Math.min(rowsPerCol, sorted.length - col * rowsPerCol);
          const startY = centerY - ((rowsInCol - 1) * ROW_H) / 2;
          node.x = centerX + dir * (xOffset + col * COL_GAP);
          node.y = startY + row * ROW_H;
        });
        xOffset += subCols * COL_GAP + 40;
      });
    };

    if (useColumns) {
      layoutColumns(leftNodes, true);
      layoutColumns(rightNodes, false);
    } else {
      layoutSemi(leftNodes, true);
      layoutSemi(rightNodes, false);
    }

    const svg = d3.select(container).append("svg").attr("width", "100%").attr("height", "100%").attr("viewBox", `0 0 ${width} ${height}`).style("opacity", "0");
    svgRef.current = svg;

    const defs = svg.append("defs");
    defs.append("marker").attr("id", "arrow-dependency").attr("viewBox", "0 -5 10 10").attr("refX", 8).attr("refY", 0).attr("markerWidth", 5).attr("markerHeight", 5).attr("orient", "auto").append("path").attr("d", "M0,-4L10,0L0,4").attr("fill", "#58a6ff");
    defs.append("marker").attr("id", "arrow-dependent").attr("viewBox", "0 -5 10 10").attr("refX", 8).attr("refY", 0).attr("markerWidth", 5).attr("markerHeight", 5).attr("orient", "auto").append("path").attr("d", "M0,-4L10,0L0,4").attr("fill", "#f87171");

    const g = svg.append("g");
    gRef.current = g;

    // When zoomed far out, hundreds of labels become noise — keep only the
    // high-signal ones (focus node, core files, folder groups) visible; the
    // rest reveal on hover. Above the threshold, show everything.
    const LABEL_K = 0.5;
    const applyLabelDeclutter = (k: number) => {
      g.selectAll<SVGGElement, SimNode>("g.focus-label").style("display", (d) =>
        !d || k >= LABEL_K || d.id === focusedNodeId || d.isGroup || representativeFilesSet.has(d.id)
          ? null
          : "none"
      );
    };

    const zoom = d3.zoom<SVGSVGElement, unknown>().scaleExtent([0.1, 8]).on("zoom", ev => {
      g.attr("transform", ev.transform);
      applyLabelDeclutter(ev.transform.k);
    });
    svg.call(zoom);

    const links: SimLink[] = [];
    edges.forEach(e => {
      let s = e.source, t = e.target;
      if (!nodeLookup.has(s)) { const f = getFolderGroup(s); if (nodeLookup.has(`folder:${f}`)) s = `folder:${f}`; }
      if (!nodeLookup.has(t)) { const f = getFolderGroup(t); if (nodeLookup.has(`folder:${f}`)) t = `folder:${f}`; }
      if (nodeLookup.has(s) && nodeLookup.has(t)) {
        links.push({ source: s as any, target: t as any, data: e });
      }
    });

    const diagonal = d3.linkHorizontal<any, any>().x(d => d.x).y(d => d.y);
    const baseEdgeOpacity = Math.max(0.15, 0.45 - (nodes.length / 200) * 0.2);

    // Single source of truth for node radius — also used to shorten edges so
    // arrowheads land exactly on the node boundary
    const nodeR = (d: SimNode): number => {
      let r = 7;
      if (d.id === focusedNodeId) r = 18;
      else if (representativeFilesSet.has(d.id)) r = 14;
      else if (d.isGroup) r = 10;
      else if (d.importance > 12) r = 9;
      if (d.hop && d.hop > 1) r *= 0.85;
      return r;
    };

    const shortenedEndpoints = (sNode: SimNode, tNode: SimNode) => {
      const sx = sNode.x ?? 0, sy = sNode.y ?? 0, tx = tNode.x ?? 0, ty = tNode.y ?? 0;
      const dx = tx - sx, dy = ty - sy;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const sr = nodeR(sNode) + 2;
      const tr = nodeR(tNode) + 7;
      return {
        source: { x: sx + (dx / dist) * sr, y: sy + (dy / dist) * sr },
        target: { x: tx - (dx / dist) * tr, y: ty - (dy / dist) * tr },
      };
    };

    const link = g.append("g").selectAll("path").data(links).join("path")
      .attr("d", d => {
        const s = nodeLookup.get(typeof d.source === "string" ? d.source : (d.source as any).id)!;
        const t = nodeLookup.get(typeof d.target === "string" ? d.target : (d.target as any).id)!;
        return diagonal(shortenedEndpoints(s, t));
      })
      .attr("fill", "none")
      .attr("stroke", d => {
        const tid = typeof d.target === 'string' ? d.target : (d.target as any).id;
        const sid = typeof d.source === 'string' ? d.source : (d.source as any).id;
        if (tid === focusedNodeId || leftIds.has(tid)) return "#58a6ff"; 
        return "#f87171"; 
      })
      .attr("stroke-width", 1)
      .attr("stroke-opacity", d => {
        const s = nodeLookup.get(typeof d.source === "string" ? d.source : (d.source as any).id)!;
        const t = nodeLookup.get(typeof d.target === "string" ? d.target : (d.target as any).id)!;
        return (s.hop && s.hop > 1) || (t.hop && t.hop > 1) ? baseEdgeOpacity * 0.5 : baseEdgeOpacity;
      })
      .attr("marker-end", d => {
        const tid = typeof d.target === 'string' ? d.target : (d.target as any).id;
        const sid = typeof d.source === 'string' ? d.source : (d.source as any).id;
        if (tid === focusedNodeId || leftIds.has(tid)) return "url(#arrow-dependency)";
        return "url(#arrow-dependent)";
      });

    const tooltip = d3.select(container).append("div").style("position", "absolute").style("background", "rgba(13,17,23,0.95)").style("border", "1px solid #30363d").style("border-radius", "8px").style("padding", "8px 12px").style("font-size", "12px").style("color", "#e6edf3").style("pointer-events", "none").style("opacity", "0").style("z-index", "100");

    const nodeG = g.append("g").selectAll("g").data(nodes).join("g").attr("transform", d => `translate(${d.x}, ${d.y})`).style("cursor", "pointer");

    nodeG.each(function (d) {
      const g2 = d3.select(this);
      const isFocused = d.id === focusedNodeId;
      const isSearchMatch = !focusSearch || d.data.label.toLowerCase().includes(focusSearch.toLowerCase()) || d.folder.toLowerCase().includes(focusSearch.toLowerCase());
      const hopOpacity = d.hop && d.hop > 1 ? 0.5 : 1;

      const r = nodeR(d);

      if (isFocused) {
        g2.append("circle").attr("r", r + 18).attr("fill", "none").attr("stroke", "#f0883e").attr("stroke-width", 3).attr("stroke-opacity", 0.25).attr("class", "glow");
        g2.append("circle").attr("r", r + 10).attr("fill", "none").attr("stroke", "#f0883e").attr("stroke-width", 1.5).attr("stroke-opacity", 0.4);
      }

      const circle = g2.append("circle").attr("r", r)
        .attr("fill", isFocused ? "#f0883e" : (d.isGroup ? "#30363d" : (representativeFilesSet.has(d.id) ? "#22c55e" : getLanguageColor(d.data.language))))
        .attr("stroke", isFocused ? "#f0883e" : "#0d1117").attr("stroke-width", 1.5)
        .attr("opacity", isSearchMatch ? hopOpacity : 0.12);

      if (d.isGroup) g2.append("text").attr("text-anchor", "middle").attr("dy", "0.35em").attr("fill", "#8b949e").attr("font-size", "9px").attr("font-weight", "bold").text("📁");

      const labelText = d.isGroup ? `/${d.data.label} (${d.childCount})` : d.data.label;
      // In column mode the label sits BESIDE the dot (left of the used-by
      // column, right of the imports column) so rows can pack tightly without
      // the label-under-dot stacking that made dense fans unreadable. In fan
      // mode it stays centered under the dot.
      const sideLabel = useColumns && d.side != null && d.side !== "center";
      let anchor: "start" | "middle" | "end" = "middle";
      let lx = 0;
      let ly = r + 20;
      if (sideLabel) {
        ly = 0;
        if (d.side === "left") { anchor = "end"; lx = -(r + 8); }
        else { anchor = "start"; lx = r + 8; }
      }
      const label = g2.append("g").attr("class", "focus-label").attr("transform", `translate(${lx}, ${ly})`);
      label.append("text").attr("text-anchor", anchor).attr("dy", "0.35em")
        .attr("fill", isFocused ? "#f0883e" : "#e6edf3").attr("font-size", r > 10 ? "12px" : "10px").attr("font-family", "monospace")
        .attr("opacity", isSearchMatch ? hopOpacity : 0.1)
        .text(trunc(labelText, useColumns ? 26 : 20));
    });

    nodeG.on("mouseover", function (ev, d) {
      tooltip.style("opacity", "1").html(d.isGroup ? `<strong>Folder: ${d.folder}</strong><br/>${d.childCount} files` : `<strong>${d.data.label}</strong><br/>${d.data.path}`).style("left", (ev.offsetX + 10) + "px").style("top", (ev.offsetY - 10) + "px");
      const neighborhood = new Set([d.id]);
      links.forEach(l => {
        const sid = typeof l.source === "string" ? l.source : (l.source as any).id;
        const tid = typeof l.target === "string" ? l.target : (l.target as any).id;
        if (sid === d.id) neighborhood.add(tid); if (tid === d.id) neighborhood.add(sid);
      });
      // Reveal labels for the hovered node's neighborhood (so a decluttered
      // dense view becomes readable on hover) and mute the rest.
      g.selectAll<SVGGElement, SimNode>("g.focus-label").style("display", n => neighborhood.has(n.id) ? null : "none");
      nodeG.transition().duration(120).style("opacity", n => neighborhood.has(n.id) ? 1 : 0.08);
      link.transition().duration(120).attr("stroke-opacity", l => {
        const sid = typeof l.source === "string" ? l.source : (l.source as any).id;
        const tid = typeof l.target === "string" ? l.target : (l.target as any).id;
        return (sid === d.id || tid === d.id) ? 1 : 0.03;
      }).attr("stroke-width", l => {
        const sid = typeof l.source === "string" ? l.source : (l.source as any).id;
        const tid = typeof l.target === "string" ? l.target : (l.target as any).id;
        return (sid === d.id || tid === d.id) ? 2.5 : 0.8;
      });
    }).on("mouseout", function () {
      tooltip.style("opacity", "0");
      // Restore the zoom-appropriate label set (hover may have hidden some).
      applyLabelDeclutter(d3.zoomTransform(svg.node() as SVGSVGElement).k);
      nodeG.transition().duration(120).style("opacity", 1);
      link.transition().duration(120).attr("stroke-opacity", l => {
        const s = nodeLookup.get(typeof l.source === "string" ? l.source : (l.source as any).id)!;
        const t = nodeLookup.get(typeof l.target === "string" ? l.target : (l.target as any).id)!;
        const isSecondHop = (s?.hop && s.hop > 1) || (t?.hop && t.hop > 1);
        return isSecondHop ? baseEdgeOpacity * 0.5 : baseEdgeOpacity;
      }).attr("stroke-width", 1);
    }).on("click", (_ev, d) => {
      if (d.isGroup) { setExpandedFolders((prev: Set<string>) => { const n = new Set(prev); if (n.has(d.folder)) n.delete(d.folder); else n.add(d.folder); return n; }); }
      else { onFileClickRef.current(d.data); if (d.id !== focusedNodeId) { setFocusedNodeId(d.id); setFocusDepth(1); } }
    });

    // Named transition ("fade") so the auto-fit zoom below — a separate
    // transition on the same <svg> — can't interrupt it. Unnamed d3
    // transitions share one slot per element and cancel each other, which
    // froze this fade at ~0.2 opacity (the whole graph rendered dim).
    svg.transition("fade").duration(300).style("opacity", "1");

    // Auto-fit: frame the whole layout in the viewport. Without this the view
    // stayed at scale 1, so big fans/columns either spilled off-screen or piled
    // up in the middle. Runs after a tick so getBBox sees the rendered nodes.
    const fitTimer = setTimeout(() => {
      if (!containerRef.current) return;
      const bbox = (g.node() as SVGGElement | null)?.getBBox();
      if (bbox && bbox.width > 0 && bbox.height > 0) {
        const margin = 1.12;
        const k = Math.min(1.2, 0.92 / Math.max((bbox.width * margin) / width, (bbox.height * margin) / height));
        const tx = width / 2 - (bbox.x + bbox.width / 2) * k;
        const ty = height / 2 - (bbox.y + bbox.height / 2) * k;
        svg.transition("fit").duration(450).call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
      } else {
        applyLabelDeclutter(1);
      }
    }, 60);

    return () => { clearTimeout(fitTimer); simulationRef.current?.stop(); };
  }, [focusedNodeId, files, edges, focusDepth, focusSearch, expandedFolders]);
}
