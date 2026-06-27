// ── Shared graph types used by FileGraph, FocusGraph, and FocusExplorer ────────
import * as d3 from "d3";
import type { FileNodeDTO, ImportEdgeDTO } from "../lib/types";

export interface SimNode extends d3.SimulationNodeDatum {
  id: string;
  data: FileNodeDTO;
  folder: string;
  degree: number;
  isHub: boolean;
  importance: number;
  isGroup?: boolean;
  childCount?: number;
  hop?: number;
  side?: "left" | "right" | "center"; // focus-graph column the node belongs to
}

export interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  data: ImportEdgeDTO;
}

export function getRadius(n: SimNode, representativeFilesSet?: Set<string>): number {
  if (n.data.kind === "config") return 12;
  if (n.data.kind === "test") return 13;
  if (representativeFilesSet?.has(n.id)) return 24;
  if (n.data.isDeadCode) return 14;
  return 18;
}

export function brightenColor(hex: string): string {
  const c = d3.color(hex);
  return c ? c.brighter(1.5).formatHex() : hex;
}

export function trunc(s: string, max: number) {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
