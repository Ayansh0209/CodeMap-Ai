import { useEffect } from "react";
import * as d3 from "d3";
import type { FileNodeDTO, ImportEdgeDTO } from "../lib/types";
import { getLanguageColor, getFolderGroup } from "../lib/graphHelpers";
import { SimNode, SimLink, trunc } from "./graphTypes";

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

    // ════════════════════════════════════════════════════════════════════════
    // LAYERED FLOW  (exploratory layout — uncommitted)
    // imported-by  ──►  [ focus ]  ──►  imports
    // Two directions walked SEPARATELY (so a circular file can legitimately be
    // on both sides) — this keeps the section counts matching the side panel
    // (Imports = outgoing edges, Imported By = incoming edges). Right-angle
    // connectors instead of curves; crowded folders collapse into one bubble.
    // ════════════════════════════════════════════════════════════════════════
    const maxHop = focusDepth === "all" ? 10 : focusDepth;

    const walk = (forward: boolean): Map<string, number> => {
      const hop = new Map<string, number>();
      const seen = new Set<string>([focusedNodeId]);
      let frontier = [focusedNodeId];
      for (let h = 1; h <= maxHop && frontier.length; h++) {
        const next: string[] = [];
        for (const id of frontier) {
          for (const e of edges) {
            const from = forward ? e.source : e.target;
            const to = forward ? e.target : e.source;
            if (from === id && !seen.has(to)) {
              seen.add(to); hop.set(to, h); next.push(to);
            }
          }
        }
        frontier = next;
      }
      return hop;
    };

    const importHop = walk(true);    // files the focus IMPORTS (outgoing)
    const importedByHop = walk(false); // files that IMPORT the focus (incoming)
    const importIds = new Set(importHop.keys());
    const importedByIds = new Set(importedByHop.keys());
    const cyclic = new Set([...importIds].filter(id => importedByIds.has(id)));

    // Header counts that exactly match the side panel (it counts edges, not
    // distinct files — so we do too).
    const importsCount = edges.filter(e => e.source === focusedNodeId).length;
    const importedByCount = edges.filter(e => e.target === focusedNodeId).length;

    const centerFile = files.find(f => f.id === focusedNodeId);
    if (!centerFile) return;

    const totalPotential = importIds.size + importedByIds.size;
    const forceCluster = focusDepth === "all" && totalPotential > 150;

    // Build one side's nodes, clustering big folders into a single bubble.
    const bubbleMembers = new Map<string, FileNodeDTO[]>(); // bubble id -> its files
    const buildSide = (ids: Set<string>, hopMap: Map<string, number>, side: "left" | "right"): SimNode[] => {
      const colFiles = files.filter(f => ids.has(f.id) && (
        !focusSearch ||
        f.label.toLowerCase().includes(focusSearch.toLowerCase()) ||
        f.path.toLowerCase().includes(focusSearch.toLowerCase())
      ));
      const byFolder = new Map<string, FileNodeDTO[]>();
      colFiles.forEach(f => {
        const folder = getFolderGroup(f.id);
        if (!byFolder.has(folder)) byFolder.set(folder, []);
        byFolder.get(folder)!.push(f);
      });
      const result: SimNode[] = [];
      byFolder.forEach((folderFiles, folder) => {
        const expanded = !forceCluster && (expandedFolders.has(folder) || folderFiles.length <= 5);
        if (expanded) {
          folderFiles.forEach(f => result.push({
            id: f.id, data: f, folder, degree: 0, isHub: false, side,
            importance: getImportance(f), hop: hopMap.get(f.id) || 1,
          }));
        } else {
          const avgHop = Math.round(folderFiles.reduce((a, f) => a + (hopMap.get(f.id) || 1), 0) / folderFiles.length);
          const bubbleId = `folder:${side}:${folder}`;
          bubbleMembers.set(bubbleId, folderFiles);
          result.push({
            id: bubbleId, folder, side, degree: 0, isHub: true,
            importance: 999, isGroup: true, childCount: folderFiles.length, hop: avgHop,
            data: { ...folderFiles[0], label: folder.split("/").pop() || folder, path: folder, kind: "folder" } as unknown as FileNodeDTO,
          });
        }
      });
      return result;
    };

    const rightNodes = buildSide(importIds, importHop, "right");      // IMPORTS
    const leftNodes = buildSide(importedByIds, importedByHop, "left"); // IMPORTED BY
    const centerNode: SimNode = {
      id: centerFile.id, data: centerFile, folder: getFolderGroup(centerFile.id),
      degree: 0, isHub: false, importance: 0, hop: 0, side: "center", x: centerX, y: centerY,
    };
    const allNodes = [centerNode, ...rightNodes, ...leftNodes];

    // ── Layout: ranks marching out from the centre on each side ───────────────
    const CENTER_R = 18;
    const ROW_H = 34;
    const HOP1 = 250;
    const COL_GAP = 200;
    const usableH = Math.max(260, height - 140);
    const rowsPerCol = Math.max(5, Math.floor(usableH / ROW_H));

    const layoutSide = (sideNodes: SimNode[], sign: 1 | -1) => {
      const byHop = d3.groups(sideNodes, n => n.hop || 1).sort((a, b) => a[0] - b[0]);
      let xBase = HOP1;
      byHop.forEach(([, hopNodes]) => {
        const sorted = hopNodes.sort((a, b) => (b.importance || 0) - (a.importance || 0));
        sorted.forEach((n, i) => {
          const col = Math.floor(i / rowsPerCol);
          const row = i % rowsPerCol;
          const rowsInCol = Math.min(rowsPerCol, sorted.length - col * rowsPerCol);
          const startY = centerY - ((rowsInCol - 1) * ROW_H) / 2;
          n.x = centerX + sign * (xBase + col * COL_GAP);
          n.y = startY + row * ROW_H;
        });
        const subCols = Math.ceil(sorted.length / rowsPerCol);
        xBase += subCols * COL_GAP + 24;
      });
    };
    layoutSide(rightNodes, 1);
    layoutSide(leftNodes, -1);

    // ── Connection lookup for hover-reveal ────────────────────────────────────
    // The default view only draws each node's elbow to the centre (that's what
    // keeps it clean). On hover we reveal a node's REAL links to the other
    // visible files — looked up here so hovering posts.ts lights up posts↔events,
    // posts↔organizations, etc., not just posts↔users.
    const displayNodesOf = new Map<string, SimNode[]>(); // file id -> node(s) drawing it
    const addDisplay = (fileId: string, node: SimNode) => {
      const arr = displayNodesOf.get(fileId);
      if (arr) arr.push(node); else displayNodesOf.set(fileId, [node]);
    };
    for (const n of allNodes) {
      if (n.isGroup) (bubbleMembers.get(n.id) || []).forEach(f => addDisplay(f.id, n));
      else addDisplay(n.id, n);
    }
    const visibleFiles = new Set<string>([focusedNodeId, ...importIds, ...importedByIds]);
    const importsOf = new Map<string, Set<string>>(); // a -> {b}: a imports b
    const adjOf = new Map<string, Set<string>>();      // undirected neighbours
    const addTo = (m: Map<string, Set<string>>, a: string, b: string) => {
      const s = m.get(a); if (s) s.add(b); else m.set(a, new Set([b]));
    };
    for (const e of edges) {
      if (!visibleFiles.has(e.source) || !visibleFiles.has(e.target)) continue;
      addTo(importsOf, e.source, e.target);
      addTo(adjOf, e.source, e.target);
      addTo(adjOf, e.target, e.source);
    }

    // ── Sizing / colour helpers ───────────────────────────────────────────────
    const IMPORT_C = "#58a6ff";      // right
    const IMPORTEDBY_C = "#3fb950";  // left
    const CYCLE_C = "#f0883e";       // bidirectional
    const nodeR = (n: SimNode) => {
      if (n.id === focusedNodeId) return CENTER_R;
      if (n.isGroup) return Math.min(20, 9 + Math.sqrt(n.childCount || 1) * 1.5);
      if (representativeFilesSet.has(n.id)) return 9;
      return 7;
    };
    const isCyclic = (n: SimNode) => cyclic.has(n.id);

    // ── SVG scaffold ──────────────────────────────────────────────────────────
    const svg = d3.select(container).append("svg")
      .attr("width", "100%").attr("height", "100%")
      .attr("viewBox", `0 0 ${width} ${height}`).style("opacity", "0");
    svgRef.current = svg;

    const defs = svg.append("defs");
    const mk = (id: string, fill: string) => defs.append("marker").attr("id", id)
      .attr("viewBox", "0 -5 10 10").attr("refX", 7).attr("refY", 0)
      .attr("markerWidth", 5).attr("markerHeight", 5).attr("orient", "auto")
      .append("path").attr("d", "M0,-4L10,0L0,4").attr("fill", fill);
    mk("lf-arrow-import", IMPORT_C);
    mk("lf-arrow-importedby", IMPORTEDBY_C);
    mk("lf-arrow-cycle", CYCLE_C);

    const g = svg.append("g");
    gRef.current = g;

    const LABEL_K = 0.5;
    const applyDeclutter = (k: number) => {
      g.selectAll<SVGGElement, SimNode>("g.focus-label").style("display", (d) =>
        !d || k >= LABEL_K || d.id === focusedNodeId || d.isGroup || representativeFilesSet.has(d.id) ? null : "none"
      );
    };
    const zoom = d3.zoom<SVGSVGElement, unknown>().scaleExtent([0.2, 4]).on("zoom", ev => {
      g.attr("transform", ev.transform);
      applyDeclutter(ev.transform.k);
    });
    svg.call(zoom);

    const tooltip = d3.select(container).append("div")
      .style("position", "absolute").style("background", "rgba(13,17,23,0.95)")
      .style("border", "1px solid #30363d").style("border-radius", "8px")
      .style("padding", "8px 12px").style("font-size", "12px").style("color", "#e6edf3")
      .style("pointer-events", "none").style("opacity", "0").style("z-index", "100");

    // ── Right-angle connectors (each side node links to the centre) ───────────
    const MID = 150;
    const sideNodes = [...rightNodes, ...leftNodes];
    const edgePath = (n: SimNode) => {
      const r = nodeR(n);
      const sign = n.side === "right" ? 1 : -1;
      const cEdge = centerX + sign * (CENTER_R + 2);
      const midX = centerX + sign * MID;
      const nEdge = n.x! - sign * (r + 6);
      // right: centre → node (arrow at node). left: node → centre (arrow at centre).
      return sign > 0
        ? `M${cEdge},${centerY} H${midX} V${n.y} H${nEdge}`
        : `M${nEdge},${n.y} H${midX} V${centerY} H${cEdge}`;
    };
    const edgeColor = (n: SimNode) => isCyclic(n) ? CYCLE_C : (n.side === "right" ? IMPORT_C : IMPORTEDBY_C);
    const edgeMarker = (n: SimNode) => isCyclic(n) ? "lf-arrow-cycle" : (n.side === "right" ? "lf-arrow-import" : "lf-arrow-importedby");

    const linkSel = g.append("g").selectAll<SVGPathElement, SimNode>("path").data(sideNodes).join("path")
      .attr("class", "focus-edge")
      .attr("d", edgePath).attr("fill", "none")
      .attr("stroke", edgeColor).attr("stroke-width", 1.2)
      .attr("stroke-opacity", 0.5)
      .attr("stroke-dasharray", n => isCyclic(n) ? "4 3" : "none")
      .attr("marker-end", n => `url(#${edgeMarker(n)})`);

    // Layer for the on-hover connection lines (under the nodes, over the elbows)
    const hoverLayer = g.append("g").attr("class", "hover-links");

    // ── Section headers (counts match the side panel exactly) ─────────────────
    const headerFor = (list: SimNode[], sign: 1 | -1, label: string, count: number, color: string) => {
      if (!list.length) return;
      const topY = Math.min(...list.map(n => n.y!)) - 28;
      g.append("text").attr("x", centerX + sign * HOP1).attr("y", topY)
        .attr("text-anchor", "middle").attr("fill", color).attr("font-size", "11px")
        .attr("font-weight", 700).attr("letter-spacing", "0.06em").attr("font-family", "monospace")
        .text(`${label}  ${count}`);
    };
    headerFor(rightNodes, 1, "IMPORTS", importsCount, IMPORT_C);
    headerFor(leftNodes, -1, "IMPORTED BY", importedByCount, IMPORTEDBY_C);

    // ── Nodes ─────────────────────────────────────────────────────────────────
    const nodeG = g.append("g").selectAll<SVGGElement, SimNode>("g").data(allNodes).join("g")
      .attr("transform", d => `translate(${d.x}, ${d.y})`).style("cursor", "pointer");

    nodeG.each(function (d) {
      const sel = d3.select(this);
      const isFocus = d.id === focusedNodeId;
      const r = nodeR(d);
      const cyc = isCyclic(d);

      if (isFocus) {
        sel.append("circle").attr("r", r + 9).attr("fill", "none").attr("stroke", "#f0883e").attr("stroke-opacity", 0.3).attr("stroke-width", 1.5);
      }
      if (cyc) {
        sel.append("circle").attr("r", r + 4).attr("fill", "none").attr("stroke", CYCLE_C).attr("stroke-opacity", 0.8).attr("stroke-width", 1).attr("stroke-dasharray", "3 2");
      }
      sel.append("circle").attr("class", "fdot").attr("r", r)
        .attr("fill", isFocus ? "#f0883e" : d.isGroup ? "#30363d" : representativeFilesSet.has(d.id) ? "#22c55e" : getLanguageColor(d.data.language))
        .attr("stroke", isFocus ? "#f0883e" : "#0d1117").attr("stroke-width", 1.5);
      if (d.isGroup) sel.append("text").attr("text-anchor", "middle").attr("dy", "0.32em").attr("font-size", "9px").text("📁");

      // label beside the dot (outward), with optional dim folder path
      const sign = d.side === "left" ? -1 : 1;
      const anchor = isFocus ? "middle" : d.side === "left" ? "end" : "start";
      const lx = isFocus ? 0 : sign * (r + 8);
      const ly = isFocus ? r + 16 : 0;
      const lab = sel.append("g").attr("class", "focus-label").attr("transform", `translate(${lx}, ${ly})`);
      const text = d.isGroup ? `${d.data.label}/ (${d.childCount})` : d.data.label;
      lab.append("text").attr("text-anchor", anchor).attr("dy", "0.32em")
        .attr("fill", isFocus ? "#f0883e" : "#e6edf3")
        .attr("font-size", isFocus ? "13px" : "12px").attr("font-weight", isFocus ? 700 : 400)
        .attr("font-family", "monospace").text(trunc(text, 30));
    });

    // ── Interactions ──────────────────────────────────────────────────────────
    // On hover, reveal the node's real connections to the OTHER visible files
    // (not just its elbow to the centre): blue arrow = it imports that file,
    // green = that file imports it, amber dashed = circular.
    type RevealLine = { node: SimNode; dir: "out" | "in" | "cyc" };
    const revealFrom = (d: SimNode): RevealLine[] => {
      const srcFiles = d.isGroup
        ? (bubbleMembers.get(d.id) || []).map(f => f.id)
        : [d.id];
      const srcSet = new Set(srcFiles);
      const dir = new Map<string, "out" | "in" | "cyc">();
      for (const fid of srcFiles) {
        adjOf.get(fid)?.forEach(nb => {
          if (srcSet.has(nb) || nb === focusedNodeId) return; // self + centre (elbow already shows it)
          const out = !!importsOf.get(fid)?.has(nb); // this file imports nb
          const inc = !!importsOf.get(nb)?.has(fid); // nb imports this file
          const next: "out" | "in" | "cyc" = out && inc ? "cyc" : out ? "out" : "in";
          const cur = dir.get(nb);
          dir.set(nb, cur && cur !== next ? "cyc" : next);
        });
      }
      const lines: RevealLine[] = [];
      dir.forEach((dr, nb) => displayNodesOf.get(nb)?.forEach(nd => {
        if (nd.id !== d.id) lines.push({ node: nd, dir: dr });
      }));
      return lines;
    };

    nodeG.on("mouseover", function (ev, d) {
      const html = d.isGroup
        ? `<strong>${d.folder}</strong><br/>${d.childCount} files`
        : `<strong>${d.data.label}</strong><br/><span style="color:#8b949e">${d.data.path}</span>${cyclic.has(d.id) ? '<br/><span style="color:#f0883e">↔ circular (imports & imported-by)</span>' : ""}`;
      tooltip.style("opacity", "1").html(html).style("left", (ev.offsetX + 14) + "px").style("top", (ev.offsetY + 8) + "px");

      const isFocus = d.id === focusedNodeId;
      const lines = isFocus ? [] : revealFrom(d);

      hoverLayer.selectAll<SVGLineElement, RevealLine>("line").data(lines).join("line")
        .attr("x1", l => (l.dir === "in" ? l.node.x! : d.x!))
        .attr("y1", l => (l.dir === "in" ? l.node.y! : d.y!))
        .attr("x2", l => (l.dir === "in" ? d.x! : l.node.x!))
        .attr("y2", l => (l.dir === "in" ? d.y! : l.node.y!))
        .attr("stroke", l => l.dir === "cyc" ? CYCLE_C : l.dir === "out" ? IMPORT_C : IMPORTEDBY_C)
        .attr("stroke-width", 1.4).attr("stroke-opacity", 0.85).attr("stroke-linecap", "round")
        .attr("stroke-dasharray", l => l.dir === "cyc" ? "4 3" : "none")
        .attr("marker-end", l => l.dir === "cyc" ? "url(#lf-arrow-cycle)" : l.dir === "out" ? "url(#lf-arrow-import)" : "url(#lf-arrow-importedby)");

      const keep = new Set<string>([d.id, focusedNodeId, ...lines.map(l => l.node.id)]);
      nodeG.transition().duration(150).style("opacity", n => isFocus || keep.has(n.id) ? 1 : 0.18);
      g.selectAll<SVGGElement, SimNode>("g.focus-label").style("display", n => isFocus || keep.has(n.id) ? null : "none");
      linkSel.transition().duration(150)
        .attr("stroke-opacity", n => isFocus || n.id === d.id ? 0.95 : 0.06)
        .attr("stroke-width", n => isFocus || n.id === d.id ? 2 : 1.2);
    }).on("mouseout", function () {
      tooltip.style("opacity", "0");
      hoverLayer.selectAll("line").remove();
      linkSel.transition().duration(150).attr("stroke-opacity", 0.5).attr("stroke-width", 1.2);
      nodeG.transition().duration(150).style("opacity", 1);
      applyDeclutter(d3.zoomTransform(svg.node() as SVGSVGElement).k);
    }).on("click", (_ev, d) => {
      if (d.isGroup) {
        setExpandedFolders(prev => { const n = new Set(prev); if (n.has(d.folder)) n.delete(d.folder); else n.add(d.folder); return n; });
        return;
      }
      onFileClickRef.current(d.data);
      if (d.id !== focusedNodeId) { setFocusedNodeId(d.id); setFocusDepth(1); }
    });

    // ── Fade in, then frame the whole diagram ─────────────────────────────────
    svg.transition("fade").duration(300).style("opacity", "1");
    const fitTimer = setTimeout(() => {
      if (!containerRef.current) return;
      const bbox = (g.node() as SVGGElement | null)?.getBBox();
      if (bbox && bbox.width > 0 && bbox.height > 0) {
        const k = Math.min(1.1, 0.92 / Math.max((bbox.width * 1.1) / width, (bbox.height * 1.1) / height));
        const tx = width / 2 - (bbox.x + bbox.width / 2) * k;
        const ty = height / 2 - (bbox.y + bbox.height / 2) * k;
        svg.transition("fit").duration(420).call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
      } else {
        applyDeclutter(1);
      }
    }, 50);

    return () => { clearTimeout(fitTimer); simulationRef.current?.stop(); };
  }, [focusedNodeId, files, edges, focusDepth, focusSearch, expandedFolders]); // eslint-disable-line react-hooks/exhaustive-deps
}
